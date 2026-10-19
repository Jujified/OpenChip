/**
 * Physics tests.
 *
 * Anchored to closed-form answers wherever one exists — a circular pipe's
 * Hagen–Poiseuille drop, the textbook Poiseuille numbers for a square duct and
 * parallel plates, ε-NTU limits. A plausible-looking number in a results table
 * is worth nothing if it is off by the wrong shape factor.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { DEFAULT_CHIP_PARAMS } from '../defaults';
import {
  FLUID_PRESETS,
  glycerolVolumeToMassFraction,
  glycerolWaterProfile,
  glycerolWaterViscosity,
  prandtl,
} from './properties';
import {
  ductGeometry,
  flowRegime,
  hydraulicResistance,
  meanVelocity,
  rectangularPoiseuille,
  reynolds,
  UL_PER_MIN_TO_M3_S,
} from './hydraulics';
import { solveNetwork } from './network';
import { effectiveProfiles, reconcileFluidSetup } from './reconcile';
import { exchange } from './thermal';
import {
  computeConsumption,
  formatDurationS,
  formatVolumeUl,
  mlPerHour,
  timeToMoveS,
} from './consumption';
import { simulate, type SimulationResult } from './simulate';
import type { ChannelGraph, FluidProfile, FluidSetup } from '../../types/project';

const water = FLUID_PRESETS[0];
const close = (actual: number, expected: number, tolerance: number, what: string) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${what}: got ${actual}, expected ${expected} ±${tolerance}`,
  );
const relative = (actual: number, expected: number, fraction: number, what: string) =>
  close(actual, expected, Math.abs(expected) * fraction, what);

// ---------------------------------------------------------------------------

describe('duct geometry and shape factors', () => {
  it('reproduces the textbook Poiseuille numbers', () => {
    // Square duct and infinite parallel plates are the two anchors every
    // reference agrees on.
    close(rectangularPoiseuille(1), 56.91, 0.1, 'square duct');
    close(rectangularPoiseuille(0), 96, 0.01, 'parallel plates');
    // Monotonic in between.
    assert.ok(rectangularPoiseuille(0.5) > rectangularPoiseuille(1));
    assert.ok(rectangularPoiseuille(0.5) < rectangularPoiseuille(0));
  });

  it('gives a circular channel Dh = D and Po = 64', () => {
    const duct = ductGeometry('round', 0.8, 0.5);
    close(duct.hydraulicDiameterM, 0.0008, 1e-12, 'hydraulic diameter');
    close(duct.areaM2, Math.PI * 0.0004 ** 2, 1e-12, 'area');
    assert.equal(duct.poiseuilleNumber, 64);
  });

  it('gives a rectangular channel Dh = 2wh/(w+h)', () => {
    const duct = ductGeometry('rect', 0.8, 0.4);
    const w = 0.0008;
    const h = 0.0004;
    close(duct.hydraulicDiameterM, (2 * w * h) / (w + h), 1e-12, 'hydraulic diameter');
    close(duct.areaM2, w * h, 1e-14, 'area');
    close(duct.poiseuilleNumber, rectangularPoiseuille(0.5), 1e-9, 'Po');
  });

  it('gives a trapezoid less area than the rectangle it drafts from', () => {
    const rect = ductGeometry('rect', 1, 0.5);
    const trap = ductGeometry('trapezoid', 1, 0.5);
    assert.ok(trap.areaM2 < rect.areaM2, 'the drafted wall removes area');
    assert.ok(trap.areaM2 > rect.areaM2 * 0.5);
  });
});

// ---------------------------------------------------------------------------

describe('Hagen–Poiseuille', () => {
  it('matches the closed-form circular-pipe result', () => {
    // ΔP = 128 μ L Q / (π D⁴)
    const D = 0.001; // 1 mm
    const L = 0.05; // 50 mm
    const mu = water.dynamicViscosityPaS;
    const Q = 10 * UL_PER_MIN_TO_M3_S;

    const duct = ductGeometry('round', 1, 1);
    const R = hydraulicResistance(duct, L, mu);
    const deltaP = R * Q;

    const analytic = (128 * mu * L * Q) / (Math.PI * D ** 4);
    relative(deltaP, analytic, 1e-9, 'circular pressure drop');
  });

  it('makes a circle the cheapest shape at equal cross-sectional area', () => {
    // The meaningful comparison is equal area — a circle has the least
    // perimeter, so the least wall to drag against. (At equal *hydraulic
    // diameter* a square actually wins, because it carries more area; that is
    // why hydraulic diameter alone is a poor way to compare shapes.)
    const mu = water.dynamicViscosityPaS;
    const area = 0.25; // mm²
    const side = Math.sqrt(area);
    const diameter = Math.sqrt((4 * area) / Math.PI);

    const round = hydraulicResistance(ductGeometry('round', diameter, diameter), 0.02, mu);
    const square = hydraulicResistance(ductGeometry('rect', side, side), 0.02, mu);
    const slot = hydraulicResistance(ductGeometry('rect', area / 0.1, 0.1), 0.02, mu);

    assert.ok(round < square, `circle ${round} should beat square ${square}`);
    assert.ok(square < slot, `square ${square} should beat a thin slot ${slot}`);
  });

  it('reproduces the circle-vs-square resistance ratio', () => {
    // At equal area: circle ∝ 64π/8 = 25.13, square ∝ 56.91/2 = 28.46.
    const mu = water.dynamicViscosityPaS;
    const area = 0.25;
    const round = hydraulicResistance(
      ductGeometry('round', Math.sqrt((4 * area) / Math.PI), 0),
      0.02,
      mu,
    );
    const square = hydraulicResistance(ductGeometry('rect', Math.sqrt(area), Math.sqrt(area)), 0.02, mu);
    relative(square / round, 28.46 / 25.13, 0.01, 'square/circle resistance ratio');
  });

  it('scales resistance as 1/w⁴ for a fixed aspect ratio', () => {
    const mu = water.dynamicViscosityPaS;
    const narrow = hydraulicResistance(ductGeometry('rect', 0.4, 0.2), 0.01, mu);
    const wide = hydraulicResistance(ductGeometry('rect', 0.8, 0.4), 0.01, mu);
    // Doubling both dimensions cuts resistance ~16×.
    relative(narrow / wide, 16, 0.02, 'resistance ratio');
  });
});

// ---------------------------------------------------------------------------

describe('Reynolds number and regime', () => {
  it('computes Re = ρvD/μ', () => {
    const re = reynolds(1000, 1, 0.001, 0.001);
    close(re, 1000, 1e-9, 'Reynolds');
  });

  it('labels the conventional bands', () => {
    assert.equal(flowRegime(500), 'laminar');
    assert.equal(flowRegime(2299), 'laminar');
    assert.equal(flowRegime(2301), 'transitional');
    assert.equal(flowRegime(3999), 'transitional');
    assert.equal(flowRegime(4001), 'turbulent');
  });

  it('stays laminar for a normal microfluidic channel', () => {
    // 0.8 × 0.5 mm at 10 µL/min in water — the app's own defaults.
    const duct = ductGeometry('rect', 0.8, 0.5);
    const v = meanVelocity(10 * UL_PER_MIN_TO_M3_S, duct.areaM2);
    const re = reynolds(water.densityKgM3, v, duct.hydraulicDiameterM, water.dynamicViscosityPaS);
    assert.ok(re < 10, `expected deeply laminar, got Re=${re}`);
  });
});

// ---------------------------------------------------------------------------

describe('glycerol/water', () => {
  it('reproduces pure water and pure glycerol at the ends', () => {
    relative(glycerolWaterViscosity(0, 20), 0.001002, 0.05, 'pure water viscosity');
    // Glycerol at 20 °C is ~1.41 Pa·s.
    relative(glycerolWaterViscosity(1, 20), 1.41, 0.1, 'pure glycerol viscosity');
  });

  it('is strongly non-linear in between', () => {
    const w = glycerolWaterViscosity(0, 20);
    const half = glycerolWaterViscosity(0.5, 20);
    const most = glycerolWaterViscosity(0.9, 20);

    // A linear blend would put 50% near 0.7 Pa·s; the real answer is ~6 mPa·s.
    assert.ok(half < 0.02, `50% mass glycerol should be ~6 mPa·s, got ${half}`);
    assert.ok(half > w * 4, 'but still several times water');
    assert.ok(most > half * 10, '90% should be dramatically thicker');
  });

  it('thins as it warms', () => {
    assert.ok(glycerolWaterViscosity(0.5, 40) < glycerolWaterViscosity(0.5, 20));
  });

  it('converts volume percent to mass fraction, glycerol being denser', () => {
    const mass = glycerolVolumeToMassFraction(50, 20);
    assert.ok(mass > 0.5 && mass < 0.6, `got ${mass}`);
  });

  it('builds a complete, finite profile at any percentage', () => {
    for (const percent of [0, 10, 40, 50, 60, 90, 100]) {
      const profile = glycerolWaterProfile(percent);
      for (const [key, value] of Object.entries(profile)) {
        if (typeof value === 'number') {
          assert.ok(Number.isFinite(value), `${key} at ${percent}% is ${value}`);
          assert.ok(value > 0 || key === 'glycerolVolumePercent', `${key} should be positive`);
        }
      }
    }
  });

  it('gives the blood analog a blood-like viscosity and flags the shear-thinning caveat', () => {
    const analog = FLUID_PRESETS.find((f) => f.id === 'preset-blood-analog');
    assert.ok(analog);
    // Whole blood at high shear is ~3.5 mPa·s, and the preset's note says it is
    // matched to that value — so hold it to that, not to "somewhere blood-ish".
    assert.ok(
      analog.dynamicViscosityPaS > 0.0033 && analog.dynamicViscosityPaS < 0.0037,
      `got ${analog.dynamicViscosityPaS} Pa·s`,
    );
    assert.ok(analog.nonNewtonianNote, 'the shear-thinning caveat must be carried in the data');
    assert.match(analog.nonNewtonianNote, /shear/i);
  });

  it('gives every preset the exact property set and nothing missing', () => {
    for (const fluid of FLUID_PRESETS) {
      for (const key of [
        'densityKgM3',
        'dynamicViscosityPaS',
        'thermalConductivityWmK',
        'specificHeatCapacityJkgK',
        'inletTemperatureC',
      ] as const) {
        assert.ok(Number.isFinite(fluid[key]), `${fluid.name} is missing ${key}`);
      }
      assert.ok(prandtl(fluid) > 0, `${fluid.name} has a non-physical Prandtl number`);
    }
  });

  it('gives water a Prandtl number near 7', () => {
    relative(prandtl(water), 7, 0.15, 'water Pr');
  });
});

// ---------------------------------------------------------------------------

describe('network solve', () => {
  it('sends all the flow through a single path', () => {
    const solution = solveNetwork({
      nodeIds: ['in', 'mid', 'out'],
      edges: [
        { id: 'e1', fromNodeId: 'in', toNodeId: 'mid', resistance: 1e12 },
        { id: 'e2', fromNodeId: 'mid', toNodeId: 'out', resistance: 1e12 },
      ],
      injections: new Map([['in', 1e-9]]),
      fixedPressures: new Map([['out', 0]]),
    });

    assert.ok(solution.solved);
    relative(solution.flows.get('e1') ?? 0, 1e-9, 1e-6, 'flow through e1');
    relative(solution.flows.get('e2') ?? 0, 1e-9, 1e-6, 'flow through e2');
    // Two equal resistances in series.
    relative(solution.pressures.get('in') ?? 0, 2e3, 1e-6, 'inlet pressure');
  });

  it('splits flow between parallel branches by conductance', () => {
    const solution = solveNetwork({
      nodeIds: ['in', 'out'],
      edges: [
        { id: 'wide', fromNodeId: 'in', toNodeId: 'out', resistance: 1e12 },
        { id: 'narrow', fromNodeId: 'in', toNodeId: 'out', resistance: 3e12 },
      ],
      injections: new Map([['in', 4e-9]]),
      fixedPressures: new Map([['out', 0]]),
    });

    assert.ok(solution.solved);
    // 3:1 conductance ratio → 3:1 flow split.
    relative(solution.flows.get('wide') ?? 0, 3e-9, 1e-6, 'wide branch');
    relative(solution.flows.get('narrow') ?? 0, 1e-9, 1e-6, 'narrow branch');
  });

  it('conserves volume at a junction', () => {
    const solution = solveNetwork({
      nodeIds: ['a', 'b', 'j', 'out'],
      edges: [
        { id: 'ja', fromNodeId: 'a', toNodeId: 'j', resistance: 2e12 },
        { id: 'jb', fromNodeId: 'b', toNodeId: 'j', resistance: 2e12 },
        { id: 'jo', fromNodeId: 'j', toNodeId: 'out', resistance: 1e12 },
      ],
      injections: new Map([
        ['a', 1e-9],
        ['b', 2e-9],
      ]),
      fixedPressures: new Map([['out', 0]]),
    });

    assert.ok(solution.solved);
    const into = (solution.flows.get('ja') ?? 0) + (solution.flows.get('jb') ?? 0);
    relative(solution.flows.get('jo') ?? 0, into, 1e-9, 'junction conservation');
    relative(solution.flows.get('jo') ?? 0, 3e-9, 1e-6, 'total through-flow');
  });

  it('gives the same flows whatever the resistance scale', () => {
    // Fine channels and viscous fluids put conductances around 1e-18 in SI.
    // Only the ratios decide the split, so scaling every resistance must scale
    // the pressures and leave the flows alone.
    const solve = (scale: number) =>
      solveNetwork({
        nodeIds: ['in', 'j', 'out'],
        edges: [
          { id: 'feed', fromNodeId: 'in', toNodeId: 'j', resistance: 1e12 * scale },
          { id: 'wide', fromNodeId: 'j', toNodeId: 'out', resistance: 1e12 * scale },
          { id: 'narrow', fromNodeId: 'j', toNodeId: 'out', resistance: 3e12 * scale },
        ],
        injections: new Map([['in', 4e-9]]),
        fixedPressures: new Map([['out', 0]]),
      });

    for (const scale of [1, 1e6, 1e9]) {
      const solution = solve(scale);
      assert.ok(solution.solved, `solves at ×${scale}: ${solution.reason ?? ''}`);
      relative(solution.flows.get('wide') ?? 0, 3e-9, 1e-9, `wide branch at ×${scale}`);
      relative(solution.flows.get('narrow') ?? 0, 1e-9, 1e-9, `narrow branch at ×${scale}`);
    }
  });

  // 20 µm is below what a resin printer resolves, and the manufacturability
  // checks say so; the flow estimate should still answer rather than call a
  // connected chain isolated. Its conductance is ~2.5e-19 m³/(Pa·s) per link.
  for (const [width, height] of [
    [0.12, 0.1],
    [0.02, 0.02],
  ]) {
    it(`solves a 50-link chain of ${width} × ${height} mm channels carrying 99 % glycerol`, () => {
      const geometry = ductGeometry('rect', width, height);
      const viscosity = glycerolWaterViscosity(0.99, 20);
      const count = 50;
      const nodeIds = Array.from({ length: count + 1 }, (_, i) => `n${i}`);
      const edges = Array.from({ length: count }, (_, i) => ({
        id: `e${i}`,
        fromNodeId: `n${i}`,
        toNodeId: `n${i + 1}`,
        resistance: hydraulicResistance(geometry, 0.02, viscosity),
      }));
      const flow = 0.1 * UL_PER_MIN_TO_M3_S;

      const solution = solveNetwork({
        nodeIds,
        edges,
        injections: new Map([['n0', flow]]),
        fixedPressures: new Map([[`n${count}`, 0]]),
      });

      assert.ok(solution.solved, solution.reason);
      relative(solution.flows.get(`e${count - 1}`) ?? 0, flow, 1e-9, 'flow at the outlet');
      relative(
        solution.pressures.get('n0') ?? 0,
        count * edges[0].resistance * flow,
        1e-9,
        'inlet pressure',
      );
    });
  }

  it('still reports a branch that no outlet can reach', () => {
    const solution = solveNetwork({
      nodeIds: ['in', 'out', 'island-a', 'island-b'],
      edges: [
        { id: 'main', fromNodeId: 'in', toNodeId: 'out', resistance: 1e12 },
        { id: 'island', fromNodeId: 'island-a', toNodeId: 'island-b', resistance: 1e12 },
      ],
      injections: new Map([['in', 1e-9]]),
      fixedPressures: new Map([['out', 0]]),
    });
    assert.equal(solution.solved, false);
    assert.match(solution.reason ?? '', /isolated/i);
  });

  it('refuses a network with no pressure reference rather than inventing one', () => {
    const solution = solveNetwork({
      nodeIds: ['a', 'b'],
      edges: [{ id: 'e', fromNodeId: 'a', toNodeId: 'b', resistance: 1e12 }],
      injections: new Map([['a', 1e-9]]),
      fixedPressures: new Map(),
    });
    assert.equal(solution.solved, false);
    assert.match(solution.reason ?? '', /outlet|reference/i);
  });
});

// ---------------------------------------------------------------------------

describe('heat exchange', () => {
  const stream = (massFlow: number, temp: number, h = 2000) => ({
    massFlowKgS: massFlow,
    specificHeatJkgK: 4182,
    temperatureC: temp,
    hWm2K: h,
  });

  it('moves heat from hot to cold and conserves it', () => {
    const result = exchange(stream(1e-5, 60), stream(1e-5, 20), 0.0005, 1e-5, 0.2);

    assert.ok(result.heatFlowW > 0, 'heat must flow downhill');
    assert.ok(result.hotOutletC < 60 && result.hotOutletC > 20);
    assert.ok(result.coldOutletC > 20 && result.coldOutletC < 60);

    // Equal capacity rates, so the temperature changes must match.
    close(60 - result.hotOutletC, result.coldOutletC - 20, 1e-6, 'energy balance');
  });

  it('never overshoots — effectiveness stays within 0..1', () => {
    for (const area of [1e-7, 1e-5, 1e-2, 1]) {
      const result = exchange(stream(1e-6, 80), stream(1e-6, 10), 0.0002, area, 0.2);
      assert.ok(result.effectiveness >= 0 && result.effectiveness <= 1, `ε=${result.effectiveness}`);
      assert.ok(result.hotOutletC >= 10 - 1e-9, 'the hot side cannot go below the cold inlet');
      assert.ok(result.coldOutletC <= 80 + 1e-9, 'the cold side cannot exceed the hot inlet');
    }
  });

  it('transfers more heat through a thinner wall', () => {
    const thin = exchange(stream(1e-5, 60), stream(1e-5, 20), 0.0002, 1e-5, 0.2);
    const thick = exchange(stream(1e-5, 60), stream(1e-5, 20), 0.002, 1e-5, 0.2);
    assert.ok(thin.heatFlowW > thick.heatFlowW, 'wall thickness is the design lever');
    assert.ok(thin.approachC < thick.approachC);
  });

  it('transfers more heat through a more conductive chip', () => {
    const resin = exchange(stream(1e-5, 60), stream(1e-5, 20), 0.0005, 1e-5, 0.2);
    const metal = exchange(stream(1e-5, 60), stream(1e-5, 20), 0.0005, 1e-5, 200);
    assert.ok(metal.heatFlowW > resin.heatFlowW);
  });

  it('reports no exchange when a stream is stalled', () => {
    const result = exchange(stream(0, 60), stream(1e-5, 20), 0.0005, 1e-5, 0.2);
    assert.equal(result.heatFlowW, 0);
  });
});

// ---------------------------------------------------------------------------
// end-to-end
// ---------------------------------------------------------------------------

function heatExchangerChip(): { graph: ChannelGraph; fluidSetup: FluidSetup } {
  // Two straight channels running side by side 0.6 mm apart — a counter-flow
  // exchanger, which is the acceptance-criteria layout.
  const graph: ChannelGraph = {
    nodes: [
      { id: 'hotIn', x: 10, y: 20, type: 'port', portType: 'luer', diameterMm: 1.6 },
      { id: 'hotOut', x: 30, y: 20, type: 'port', portType: 'luer', diameterMm: 1.6 },
      { id: 'coldIn', x: 30, y: 21.4, type: 'port', portType: 'luer', diameterMm: 1.6 },
      { id: 'coldOut', x: 10, y: 21.4, type: 'port', portType: 'luer', diameterMm: 1.6 },
    ],
    edges: [
      {
        id: 'hot',
        fromNodeId: 'hotIn',
        toNodeId: 'hotOut',
        curveType: 'straight',
        crossSection: 'rect',
        dimensionPoints: [],
      },
      {
        id: 'cold',
        fromNodeId: 'coldIn',
        toNodeId: 'coldOut',
        curveType: 'straight',
        crossSection: 'rect',
        dimensionPoints: [],
      },
    ],
  };

  const fluidSetup: FluidSetup = {
    assignments: [
      { portId: 'hotIn', role: 'inlet', fluidProfileId: 'preset-water', flowRateUlPerMin: 10, inletTemperatureC: 60 },
      { portId: 'hotOut', role: 'outlet', fluidProfileId: null, flowRateUlPerMin: 0, inletTemperatureC: null },
      { portId: 'coldIn', role: 'inlet', fluidProfileId: 'preset-glycerol-water', flowRateUlPerMin: 10, inletTemperatureC: 20 },
      { portId: 'coldOut', role: 'outlet', fluidProfileId: null, flowRateUlPerMin: 0, inletTemperatureC: null },
    ],
    chipMaterialThermalConductivityWmK: 0.2,
  };

  return { graph, fluidSetup };
}

describe('end-to-end simulation', () => {
  const profiles: FluidProfile[] = FLUID_PRESETS;

  it('produces a segment result per channel with both fluids', () => {
    const { graph, fluidSetup } = heatExchangerChip();
    const result = simulate({ graph, chipParams: DEFAULT_CHIP_PARAMS, fluidProfiles: profiles, fluidSetup });

    assert.equal(result.blockedReason, undefined);
    assert.equal(result.segments.length, 2);

    const hot = result.segments.find((s) => s.edgeId === 'hot');
    const cold = result.segments.find((s) => s.edgeId === 'cold');
    assert.ok(hot && cold);
    assert.equal(hot.fluidName, 'Water');
    assert.match(cold.fluidName, /Glycerol/);

    // The thicker fluid needs more pressure for the same flow.
    assert.ok(cold.pressureDropPa > hot.pressureDropPa, 'glycerol costs more pressure');
  });

  it('reports Reynolds and a regime for every segment, laminar included', () => {
    const { graph, fluidSetup } = heatExchangerChip();
    const result = simulate({ graph, chipParams: DEFAULT_CHIP_PARAMS, fluidProfiles: profiles, fluidSetup });

    for (const segment of result.segments) {
      assert.ok(Number.isFinite(segment.reynolds), `${segment.edgeId} has no Reynolds number`);
      assert.ok(['laminar', 'transitional', 'turbulent'].includes(segment.regime));
    }
    assert.ok(result.segments.every((s) => s.regime === 'laminar'));
  });

  it('exchanges heat between the two streams', () => {
    const { graph, fluidSetup } = heatExchangerChip();
    const result = simulate({ graph, chipParams: DEFAULT_CHIP_PARAMS, fluidProfiles: profiles, fluidSetup });

    assert.ok(result.pairs.length >= 1, 'the two channels must be paired as neighbours');
    const pair = result.pairs[0];
    assert.ok(pair.contactLengthMm > 15, `they run together for ~20 mm, got ${pair.contactLengthMm}`);
    assert.ok(pair.overallUWm2K > 0);

    const hot = result.segments.find((s) => s.edgeId === 'hot')!;
    const cold = result.segments.find((s) => s.edgeId === 'cold')!;

    assert.ok(hot.temperatureOutC < hot.temperatureInC, 'the hot stream must cool');
    assert.ok(cold.temperatureOutC > cold.temperatureInC, 'the cold stream must warm');
    // And neither may cross the other's inlet.
    assert.ok(hot.temperatureOutC > 20 - 1e-6);
    assert.ok(cold.temperatureOutC < 60 + 1e-6);
  });

  it('conserves energy across the exchanger', () => {
    // Regression: the exchange used to be evaluated once per *segment* rather
    // than once per *pair*, so the two sides disagreed about how much heat had
    // moved and the whole thing leaked ~19% of it.
    const { graph, fluidSetup } = heatExchangerChip();
    const result = simulate({ graph, chipParams: DEFAULT_CHIP_PARAMS, fluidProfiles: profiles, fluidSetup });

    const totalHeat = result.segments.reduce((sum, s) => sum + s.heatFlowW, 0);
    const magnitude = result.segments.reduce((sum, s) => sum + Math.abs(s.heatFlowW), 0);

    assert.ok(magnitude > 0, 'there must be heat moving at all for this to mean anything');
    assert.ok(
      Math.abs(totalHeat) < magnitude * 1e-9,
      `heat gained must equal heat lost: net ${totalHeat} W against ${magnitude} W moved`,
    );
  });

  it('balances each stream against its own temperature change', () => {
    // The other half of conservation: the heat booked against a segment has to
    // match the enthalpy change its temperature rise implies.
    const { graph, fluidSetup } = heatExchangerChip();
    const result = simulate({ graph, chipParams: DEFAULT_CHIP_PARAMS, fluidProfiles: profiles, fluidSetup });

    const byId = new Map(profiles.map((f) => [f.name, f]));
    for (const segment of result.segments) {
      if (Math.abs(segment.heatFlowW) < 1e-12) continue;
      const fluid = byId.get(segment.fluidName);
      if (!fluid) continue;

      const massFlowKgS =
        (Math.abs(segment.flowUlPerMin) * UL_PER_MIN_TO_M3_S) * fluid.densityKgM3;
      const capacityRate = massFlowKgS * fluid.specificHeatCapacityJkgK;
      const impliedDeltaT = segment.heatFlowW / capacityRate;
      const actualDeltaT = segment.temperatureOutC - segment.temperatureInC;

      relative(actualDeltaT, impliedDeltaT, 1e-6, `enthalpy balance on ${segment.edgeId}`);
    }
  });

  it('never lets either stream cross the other', () => {
    // A hot outlet below the cold inlet would be a second-law violation, and
    // the kind of thing an over-eager relaxation can produce.
    const { graph, fluidSetup } = heatExchangerChip();
    for (const conductivity of [0.2, 5, 200]) {
      const result = simulate({
        graph,
        chipParams: DEFAULT_CHIP_PARAMS,
        fluidProfiles: profiles,
        fluidSetup: { ...fluidSetup, chipMaterialThermalConductivityWmK: conductivity },
      });
      for (const segment of result.segments) {
        assert.ok(
          segment.temperatureOutC >= 20 - 0.01 && segment.temperatureOutC <= 60 + 0.01,
          `k=${conductivity}: ${segment.edgeId} left the 20–60 °C envelope at ${segment.temperatureOutC}`,
        );
      }
    }
  });

  it('reaches transitional or turbulent when a channel is widened and flow raised', () => {
    // The "intentionally turbulent design" case from the acceptance criteria.
    const { graph, fluidSetup } = heatExchangerChip();
    graph.edges[0].dimensionPoints = [{ t: 0, widthMm: 6, heightMm: 6 }];
    fluidSetup.assignments[0].flowRateUlPerMin = 4_000_000; // 4 L/min

    const result = simulate({ graph, chipParams: DEFAULT_CHIP_PARAMS, fluidProfiles: profiles, fluidSetup });
    const hot = result.segments.find((s) => s.edgeId === 'hot')!;

    assert.ok(hot.reynolds > 2300, `expected non-laminar, got Re=${hot.reynolds}`);
    assert.notEqual(hot.regime, 'laminar');
    // And the run says so rather than quietly reporting a laminar-only formula.
    assert.ok(result.notes.some((n) => /laminar/i.test(n)));
  });

  it('needs both an inlet and an outlet, and says so plainly', () => {
    const { graph, fluidSetup } = heatExchangerChip();
    const onlyInlets: FluidSetup = {
      ...fluidSetup,
      assignments: fluidSetup.assignments.map((a) => ({ ...a, role: 'inlet' as const })),
    };
    const result = simulate({ graph, chipParams: DEFAULT_CHIP_PARAMS, fluidProfiles: profiles, fluidSetup: onlyInlets });
    assert.ok(result.blockedReason);
    assert.match(result.blockedReason, /outlet/i);
  });

  it('splits flow by resistance through a branching network', () => {
    const graph: ChannelGraph = {
      nodes: [
        { id: 'in', x: 5, y: 30, type: 'port', portType: 'luer', diameterMm: 1.6 },
        { id: 'split', x: 15, y: 30, type: 'waypoint' },
        { id: 'join', x: 30, y: 30, type: 'waypoint' },
        { id: 'out', x: 38, y: 30, type: 'port', portType: 'luer', diameterMm: 1.6 },
      ],
      edges: [
        { id: 'feed', fromNodeId: 'in', toNodeId: 'split', curveType: 'straight', crossSection: 'rect', dimensionPoints: [] },
        { id: 'wide', fromNodeId: 'split', toNodeId: 'join', curveType: 'straight', crossSection: 'rect', dimensionPoints: [{ t: 0, widthMm: 1.6, heightMm: 0.5 }] },
        { id: 'narrow', fromNodeId: 'split', toNodeId: 'join', curveType: 'straight', crossSection: 'rect', dimensionPoints: [{ t: 0, widthMm: 0.4, heightMm: 0.5 }] },
        { id: 'exit', fromNodeId: 'join', toNodeId: 'out', curveType: 'straight', crossSection: 'rect', dimensionPoints: [] },
      ],
    };

    const fluidSetup: FluidSetup = {
      assignments: [
        { portId: 'in', role: 'inlet', fluidProfileId: 'preset-water', flowRateUlPerMin: 20, inletTemperatureC: 20 },
        { portId: 'out', role: 'outlet', fluidProfileId: null, flowRateUlPerMin: 0, inletTemperatureC: null },
      ],
      chipMaterialThermalConductivityWmK: 0.2,
    };

    const result = simulate({ graph, chipParams: DEFAULT_CHIP_PARAMS, fluidProfiles: profiles, fluidSetup });
    const wide = result.segments.find((s) => s.edgeId === 'wide')!;
    const narrow = result.segments.find((s) => s.edgeId === 'narrow')!;
    const feed = result.segments.find((s) => s.edgeId === 'feed')!;

    assert.ok(
      Math.abs(wide.flowUlPerMin) > Math.abs(narrow.flowUlPerMin) * 3,
      `the wide branch should dominate: wide ${wide.flowUlPerMin} vs narrow ${narrow.flowUlPerMin}`,
    );
    // And the two branches must add back up to what was fed in.
    relative(
      Math.abs(wide.flowUlPerMin) + Math.abs(narrow.flowUlPerMin),
      Math.abs(feed.flowUlPerMin),
      1e-6,
      'branch conservation',
    );
    relative(Math.abs(feed.flowUlPerMin), 20, 1e-6, 'total flow');
  });

  it('says nothing rather than guessing when there is no network', () => {
    const result = simulate({
      graph: { nodes: [], edges: [] },
      chipParams: DEFAULT_CHIP_PARAMS,
      fluidProfiles: profiles,
      fluidSetup: { assignments: [], chipMaterialThermalConductivityWmK: 0.2 },
    });
    assert.ok(result.blockedReason);
    assert.equal(result.segments.length, 0);
  });
});

// ---------------------------------------------------------------------------
// residence time and internal volume
// ---------------------------------------------------------------------------

/** A single straight run between one inlet and one outlet. */
function straightRun(options: {
  lengthMm: number;
  crossSection: 'round' | 'rect';
  dimensionPoints: { t: number; widthMm: number; heightMm?: number }[];
  flowUlPerMin: number;
}): { graph: ChannelGraph; fluidSetup: FluidSetup } {
  const graph: ChannelGraph = {
    nodes: [
      { id: 'in', x: 5, y: 5, type: 'port', portType: 'luer', diameterMm: 1.6 },
      { id: 'out', x: 5, y: 5 + options.lengthMm, type: 'port', portType: 'luer', diameterMm: 1.6 },
    ],
    edges: [
      {
        id: 'run',
        fromNodeId: 'in',
        toNodeId: 'out',
        curveType: 'straight',
        crossSection: options.crossSection,
        dimensionPoints: options.dimensionPoints,
      },
    ],
  };

  const fluidSetup: FluidSetup = {
    assignments: [
      {
        portId: 'in',
        role: 'inlet',
        fluidProfileId: 'preset-water',
        flowRateUlPerMin: options.flowUlPerMin,
        inletTemperatureC: 20,
      },
      { portId: 'out', role: 'outlet', fluidProfileId: null, flowRateUlPerMin: 0, inletTemperatureC: null },
    ],
    chipMaterialThermalConductivityWmK: 0.2,
  };

  return { graph, fluidSetup };
}

describe('residence time and internal volume', () => {
  const profiles: FluidProfile[] = FLUID_PRESETS;
  // The straight runs below are longer than the default 40 × 60 mm block; the
  // chip outline plays no part in the estimate, so it is widened rather than
  // bending the geometry into something without a closed-form answer.
  const chipParams = { ...DEFAULT_CHIP_PARAMS, width: 40, length: 140 };

  it('gives a straight rectangular run its exact prism volume and transit time', () => {
    // 100 mm × 0.8 × 0.5 mm = 40 mm³ = 40 µL. At 300 µL/min that is 8.00 s.
    const { graph, fluidSetup } = straightRun({
      lengthMm: 100,
      crossSection: 'rect',
      dimensionPoints: [{ t: 0, widthMm: 0.8, heightMm: 0.5 }],
      flowUlPerMin: 300,
    });

    const result = simulate({ graph, chipParams, fluidProfiles: profiles, fluidSetup });
    const run = result.segments.find((s) => s.edgeId === 'run')!;

    relative(run.volumeUl, 40, 1e-6, 'internal volume');
    relative(run.residenceTimeS, 8, 1e-6, 'residence time');
    relative(result.totalInternalVolumeUl, 40, 1e-6, 'total internal volume');
    relative(result.primingTimeS, 8, 1e-6, 'priming time');
  });

  it('gives a round channel πr²L', () => {
    // 1 mm diameter × 50 mm = π/4 · 1² · 50 = 39.27 µL.
    const { graph, fluidSetup } = straightRun({
      lengthMm: 50,
      crossSection: 'round',
      dimensionPoints: [{ t: 0, widthMm: 1 }],
      flowUlPerMin: 10,
    });

    const result = simulate({ graph, chipParams, fluidProfiles: profiles, fluidSetup });
    relative(result.segments[0].volumeUl, (Math.PI / 4) * 50, 1e-6, 'round channel volume');
  });

  it('integrates a taper along the loft rather than taking the mean section', () => {
    // 0.4 → 1.6 mm over 30 mm. ∫π/4·d(s)²ds = 26.39 mm³. The area of the *mean*
    // diameter gives 23.56 — 12% light, because area is quadratic in a width
    // that is only linear in s. This is the regression guard for that shortcut.
    const { graph, fluidSetup } = straightRun({
      lengthMm: 30,
      crossSection: 'round',
      dimensionPoints: [
        { t: 0, widthMm: 0.4 },
        { t: 1, widthMm: 1.6 },
      ],
      flowUlPerMin: 10,
    });

    const result = simulate({ graph, chipParams, fluidProfiles: profiles, fluidSetup });
    const volume = result.segments[0].volumeUl;

    relative(volume, 26.39, 0.01, 'integrated taper volume');
    const meanSectionShortcut = (Math.PI / 4) * 1 ** 2 * 30;
    close(meanSectionShortcut, 23.56, 0.01, 'the shortcut this must not be');
    assert.ok(
      Math.abs(volume - meanSectionShortcut) > meanSectionShortcut * 0.05,
      `volume ${volume} is within 5% of the mean-section shortcut ${meanSectionShortcut}`,
    );
  });

  it('integrates the resistance and wall shear of a taper too', () => {
    // Round 0.2 → 1.0 mm over 30 mm. Resistance goes as 1/d⁴, so the exact
    // R = 128μ/π · ∫ds/d⁴ = 128μ/π · L/(3Δd) · (1/d0³ − 1/d1³) — about 4.3× what
    // the 0.6 mm mean section gives. Mean wall shear is the length-average of
    // the local (d/4)·(dP/ds) = 32μQ/(π d³).
    const L = 30e-3;
    const d0 = 0.2e-3;
    const d1 = 1.0e-3;
    const flowUlPerMin = 10;
    const { graph, fluidSetup } = straightRun({
      lengthMm: 30,
      crossSection: 'round',
      dimensionPoints: [
        { t: 0, widthMm: 0.2 },
        { t: 1, widthMm: 1.0 },
      ],
      flowUlPerMin,
    });

    const result = simulate({ graph, chipParams, fluidProfiles: profiles, fluidSetup });
    const segment = result.segments[0];
    const water = profiles.find((f) => f.id === 'preset-water')!;
    const mu = water.dynamicViscosityPaS;
    const q = (flowUlPerMin * 1e-9) / 60;

    const exactR = ((128 * mu) / Math.PI) * (L / (3 * (d1 - d0))) * (1 / d0 ** 3 - 1 / d1 ** 3);
    relative(segment.pressureDropPa, exactR * q, 0.02, 'taper pressure drop');

    const exactShear =
      ((32 * mu * q) / (Math.PI * L)) * (L / (2 * (d1 - d0))) * (1 / d0 ** 2 - 1 / d1 ** 2);
    relative(segment.wallShearPa, exactShear, 0.02, 'taper mean wall shear');
  });

  it('sums segment volumes exactly into the total', () => {
    const { graph, fluidSetup } = heatExchangerChip();
    const result = simulate({ graph, chipParams: DEFAULT_CHIP_PARAMS, fluidProfiles: profiles, fluidSetup });

    const summed = result.segments.reduce((sum, s) => sum + s.volumeUl, 0);
    assert.equal(summed, result.totalInternalVolumeUl);
  });

  it('reports a transit range, not a single number, through a branched network', () => {
    const graph: ChannelGraph = {
      nodes: [
        { id: 'in', x: 5, y: 30, type: 'port', portType: 'luer', diameterMm: 1.6 },
        { id: 'split', x: 15, y: 30, type: 'waypoint' },
        { id: 'join', x: 30, y: 30, type: 'waypoint' },
        { id: 'out', x: 38, y: 30, type: 'port', portType: 'luer', diameterMm: 1.6 },
      ],
      edges: [
        { id: 'feed', fromNodeId: 'in', toNodeId: 'split', curveType: 'straight', crossSection: 'rect', dimensionPoints: [] },
        { id: 'wide', fromNodeId: 'split', toNodeId: 'join', curveType: 'straight', crossSection: 'rect', dimensionPoints: [{ t: 0, widthMm: 1.6, heightMm: 0.5 }] },
        { id: 'narrow', fromNodeId: 'split', toNodeId: 'join', curveType: 'straight', crossSection: 'rect', dimensionPoints: [{ t: 0, widthMm: 0.4, heightMm: 0.5 }] },
        { id: 'exit', fromNodeId: 'join', toNodeId: 'out', curveType: 'straight', crossSection: 'rect', dimensionPoints: [] },
      ],
    };

    const fluidSetup: FluidSetup = {
      assignments: [
        { portId: 'in', role: 'inlet', fluidProfileId: 'preset-water', flowRateUlPerMin: 20, inletTemperatureC: 20 },
        { portId: 'out', role: 'outlet', fluidProfileId: null, flowRateUlPerMin: 0, inletTemperatureC: null },
      ],
      chipMaterialThermalConductivityWmK: 0.2,
    };

    const result = simulate({ graph, chipParams: DEFAULT_CHIP_PARAMS, fluidProfiles: profiles, fluidSetup });

    assert.ok(
      result.transitTimeS.min < result.transitTimeS.max,
      `a split network has no single transit time: got ${result.transitTimeS.min}–${result.transitTimeS.max}`,
    );
    assert.ok(result.transitTimeS.min > 0, 'the fastest route still takes time');
    assert.ok(Number.isFinite(result.transitTimeS.max));

    // The narrow branch is the slow one, and its residence time is the gap.
    const wide = result.segments.find((s) => s.edgeId === 'wide')!;
    const narrow = result.segments.find((s) => s.edgeId === 'narrow')!;
    assert.ok(narrow.residenceTimeS > wide.residenceTimeS, 'the starved branch holds its fluid longer');
    relative(
      result.transitTimeS.max - result.transitTimeS.min,
      narrow.residenceTimeS - wide.residenceTimeS,
      1e-9,
      'the spread is the difference between the two branches',
    );
  });

  it('gives a stalled segment an infinite residence time rather than NaN', () => {
    // A dead-end stub off the main run carries no flow at all.
    const graph: ChannelGraph = {
      nodes: [
        { id: 'in', x: 5, y: 30, type: 'port', portType: 'luer', diameterMm: 1.6 },
        { id: 'mid', x: 20, y: 30, type: 'waypoint' },
        { id: 'out', x: 35, y: 30, type: 'port', portType: 'luer', diameterMm: 1.6 },
        { id: 'stub', x: 20, y: 40, type: 'waypoint' },
      ],
      edges: [
        { id: 'a', fromNodeId: 'in', toNodeId: 'mid', curveType: 'straight', crossSection: 'rect', dimensionPoints: [] },
        { id: 'b', fromNodeId: 'mid', toNodeId: 'out', curveType: 'straight', crossSection: 'rect', dimensionPoints: [] },
        { id: 'dead', fromNodeId: 'mid', toNodeId: 'stub', curveType: 'straight', crossSection: 'rect', dimensionPoints: [] },
      ],
    };

    const fluidSetup: FluidSetup = {
      assignments: [
        { portId: 'in', role: 'inlet', fluidProfileId: 'preset-water', flowRateUlPerMin: 20, inletTemperatureC: 20 },
        { portId: 'out', role: 'outlet', fluidProfileId: null, flowRateUlPerMin: 0, inletTemperatureC: null },
      ],
      chipMaterialThermalConductivityWmK: 0.2,
    };

    const result = simulate({ graph, chipParams: DEFAULT_CHIP_PARAMS, fluidProfiles: profiles, fluidSetup });
    const dead = result.segments.find((s) => s.edgeId === 'dead')!;

    assert.equal(dead.residenceTimeS, Infinity, 'a stalled segment never releases its fluid');
    assert.ok(!Number.isNaN(dead.residenceTimeS));
    assert.ok(dead.volumeUl > 0, 'but it still holds a real volume');

    // And the stalled branch must not poison the through-path's transit time.
    assert.ok(Number.isFinite(result.transitTimeS.max), 'a dead end is not a slow route');
    assert.ok(result.transitTimeS.max > 0);
  });

  it('leaves an island with no path from an inlet out of the transit range', () => {
    const graph: ChannelGraph = {
      nodes: [
        { id: 'in', x: 5, y: 10, type: 'port', portType: 'luer', diameterMm: 1.6 },
        { id: 'out', x: 35, y: 10, type: 'port', portType: 'luer', diameterMm: 1.6 },
        { id: 'lonelyA', x: 5, y: 40, type: 'port', portType: 'luer', diameterMm: 1.6 },
        { id: 'lonelyB', x: 35, y: 40, type: 'port', portType: 'luer', diameterMm: 1.6 },
      ],
      edges: [
        { id: 'main', fromNodeId: 'in', toNodeId: 'out', curveType: 'straight', crossSection: 'rect', dimensionPoints: [] },
        { id: 'island', fromNodeId: 'lonelyA', toNodeId: 'lonelyB', curveType: 'straight', crossSection: 'rect', dimensionPoints: [] },
      ],
    };

    const fluidSetup: FluidSetup = {
      assignments: [
        { portId: 'in', role: 'inlet', fluidProfileId: 'preset-water', flowRateUlPerMin: 20, inletTemperatureC: 20 },
        { portId: 'out', role: 'outlet', fluidProfileId: null, flowRateUlPerMin: 0, inletTemperatureC: null },
        { portId: 'lonelyA', role: 'outlet', fluidProfileId: null, flowRateUlPerMin: 0, inletTemperatureC: null },
        { portId: 'lonelyB', role: 'outlet', fluidProfileId: null, flowRateUlPerMin: 0, inletTemperatureC: null },
      ],
      chipMaterialThermalConductivityWmK: 0.2,
    };

    const result = simulate({ graph, chipParams: DEFAULT_CHIP_PARAMS, fluidProfiles: profiles, fluidSetup });
    if (result.blockedReason) return; // an unsolvable island is reported elsewhere

    const main = result.segments.find((s) => s.edgeId === 'main')!;
    relative(result.transitTimeS.min, main.residenceTimeS, 1e-9, 'only the connected route counts');
    relative(result.transitTimeS.max, main.residenceTimeS, 1e-9, 'and it is the only one');
  });
});

// ---------------------------------------------------------------------------
// wall shear stress
// ---------------------------------------------------------------------------

describe('wall shear stress', () => {
  const profiles: FluidProfile[] = FLUID_PRESETS;
  const chipParams = { ...DEFAULT_CHIP_PARAMS, width: 40, length: 140 };

  it('matches the closed-form Poiseuille result end to end', () => {
    // τ_w = 32 μ Q / (π D³) for a circular pipe. The value under test is
    // derived from the *network's* ΔP, so agreeing with the closed form checks
    // the pressure solve and the force balance together rather than either
    // alone. 1 mm, 50 mm, water at 10 µL/min lands near 1.698 × 10⁻³ Pa.
    const D = 0.001;
    const Q = 10 * UL_PER_MIN_TO_M3_S;
    const mu = water.dynamicViscosityPaS;

    const { graph, fluidSetup } = straightRun({
      lengthMm: 50,
      crossSection: 'round',
      dimensionPoints: [{ t: 0, widthMm: 1 }],
      flowUlPerMin: 10,
    });

    const result = simulate({ graph, chipParams, fluidProfiles: profiles, fluidSetup });
    const analytic = (32 * mu * Q) / (Math.PI * D ** 3);

    relative(result.segments[0].wallShearPa, analytic, 1e-6, 'wall shear stress');
    close(analytic, 1.698e-3, 5e-5, 'and it lands where the textbook says');
  });

  it('rises when a channel is narrowed at fixed flow', () => {
    const shearAtWidth = (widthMm: number): number => {
      const { graph, fluidSetup } = straightRun({
        lengthMm: 50,
        crossSection: 'rect',
        dimensionPoints: [{ t: 0, widthMm, heightMm: 0.5 }],
        flowUlPerMin: 100,
      });
      return simulate({ graph, chipParams, fluidProfiles: profiles, fluidSetup }).segments[0]
        .wallShearPa;
    };

    const wide = shearAtWidth(0.8);
    const narrow = shearAtWidth(0.4);
    assert.ok(narrow > wide, `halving the width must raise shear: ${narrow} vs ${wide}`);
  });

  it('gives a stalled segment zero shear, not NaN', () => {
    const graph: ChannelGraph = {
      nodes: [
        { id: 'in', x: 5, y: 30, type: 'port', portType: 'luer', diameterMm: 1.6 },
        { id: 'mid', x: 20, y: 30, type: 'waypoint' },
        { id: 'out', x: 35, y: 30, type: 'port', portType: 'luer', diameterMm: 1.6 },
        { id: 'stub', x: 20, y: 40, type: 'waypoint' },
      ],
      edges: [
        { id: 'a', fromNodeId: 'in', toNodeId: 'mid', curveType: 'straight', crossSection: 'rect', dimensionPoints: [] },
        { id: 'b', fromNodeId: 'mid', toNodeId: 'out', curveType: 'straight', crossSection: 'rect', dimensionPoints: [] },
        { id: 'dead', fromNodeId: 'mid', toNodeId: 'stub', curveType: 'straight', crossSection: 'rect', dimensionPoints: [] },
      ],
    };

    const fluidSetup: FluidSetup = {
      assignments: [
        { portId: 'in', role: 'inlet', fluidProfileId: 'preset-water', flowRateUlPerMin: 20, inletTemperatureC: 20 },
        { portId: 'out', role: 'outlet', fluidProfileId: null, flowRateUlPerMin: 0, inletTemperatureC: null },
      ],
      chipMaterialThermalConductivityWmK: 0.2,
    };

    const result = simulate({ graph, chipParams: DEFAULT_CHIP_PARAMS, fluidProfiles: profiles, fluidSetup });
    const dead = result.segments.find((s) => s.edgeId === 'dead')!;

    assert.ok(Number.isFinite(dead.wallShearPa), `got ${dead.wallShearPa}`);
    close(dead.wallShearPa, 0, 1e-12, 'no flow, no drag');
  });

  it('gives a zero-length segment zero shear rather than dividing by it', () => {
    // A degenerate edge — both ends on the same point — lofts to zero length.
    const graph: ChannelGraph = {
      nodes: [
        { id: 'in', x: 5, y: 30, type: 'port', portType: 'luer', diameterMm: 1.6 },
        { id: 'mid', x: 20, y: 30, type: 'waypoint' },
        { id: 'twin', x: 20, y: 30, type: 'waypoint' },
        { id: 'out', x: 35, y: 30, type: 'port', portType: 'luer', diameterMm: 1.6 },
      ],
      edges: [
        { id: 'a', fromNodeId: 'in', toNodeId: 'mid', curveType: 'straight', crossSection: 'rect', dimensionPoints: [] },
        { id: 'degenerate', fromNodeId: 'mid', toNodeId: 'twin', curveType: 'straight', crossSection: 'rect', dimensionPoints: [] },
        { id: 'b', fromNodeId: 'twin', toNodeId: 'out', curveType: 'straight', crossSection: 'rect', dimensionPoints: [] },
      ],
    };

    const fluidSetup: FluidSetup = {
      assignments: [
        { portId: 'in', role: 'inlet', fluidProfileId: 'preset-water', flowRateUlPerMin: 20, inletTemperatureC: 20 },
        { portId: 'out', role: 'outlet', fluidProfileId: null, flowRateUlPerMin: 0, inletTemperatureC: null },
      ],
      chipMaterialThermalConductivityWmK: 0.2,
    };

    const result = simulate({ graph, chipParams: DEFAULT_CHIP_PARAMS, fluidProfiles: profiles, fluidSetup });
    for (const segment of result.segments) {
      assert.ok(
        Number.isFinite(segment.wallShearPa),
        `${segment.edgeId} has a non-finite shear: ${segment.wallShearPa}`,
      );
    }

    const degenerate = result.segments.find((s) => s.edgeId === 'degenerate');
    if (degenerate) assert.equal(degenerate.wallShearPa, 0);
  });
});

// ---------------------------------------------------------------------------
// reagent consumption and throughput
// ---------------------------------------------------------------------------

describe('reagent consumption', () => {
  const profiles: FluidProfile[] = FLUID_PRESETS;
  const chipParams = { ...DEFAULT_CHIP_PARAMS, width: 40, length: 140 };

  /** Two inlets meeting a 100 mm × 0.8 × 0.5 mm run: a 40 µL network. */
  function twoInletChip(flowEach: number): { graph: ChannelGraph; fluidSetup: FluidSetup } {
    const graph: ChannelGraph = {
      nodes: [
        { id: 'inA', x: 5, y: 5, type: 'port', portType: 'luer', diameterMm: 1.6 },
        { id: 'inB', x: 15, y: 5, type: 'port', portType: 'luer', diameterMm: 1.6 },
        { id: 'tee', x: 10, y: 10, type: 'waypoint' },
        { id: 'out', x: 10, y: 110, type: 'port', portType: 'luer', diameterMm: 1.6 },
      ],
      edges: [
        { id: 'armA', fromNodeId: 'inA', toNodeId: 'tee', curveType: 'straight', crossSection: 'rect', dimensionPoints: [{ t: 0, widthMm: 0.8, heightMm: 0.5 }] },
        { id: 'armB', fromNodeId: 'inB', toNodeId: 'tee', curveType: 'straight', crossSection: 'rect', dimensionPoints: [{ t: 0, widthMm: 0.8, heightMm: 0.5 }] },
        { id: 'run', fromNodeId: 'tee', toNodeId: 'out', curveType: 'straight', crossSection: 'rect', dimensionPoints: [{ t: 0, widthMm: 0.8, heightMm: 0.5 }] },
      ],
    };

    const fluidSetup: FluidSetup = {
      assignments: [
        { portId: 'inA', role: 'inlet', fluidProfileId: 'preset-water', flowRateUlPerMin: flowEach, inletTemperatureC: 20 },
        { portId: 'inB', role: 'inlet', fluidProfileId: 'preset-water', flowRateUlPerMin: flowEach, inletTemperatureC: 20 },
        { portId: 'out', role: 'outlet', fluidProfileId: null, flowRateUlPerMin: 0, inletTemperatureC: null },
      ],
      chipMaterialThermalConductivityWmK: 0.2,
    };

    return { graph, fluidSetup };
  }

  it('turns two inlets at 150 µL/min on a 40 µL network into a run plan', () => {
    // The 100 mm mixing leg alone is 40 µL; the two 5√2 mm arms add a little.
    const { graph, fluidSetup } = twoInletChip(150);
    const result = simulate({ graph, chipParams, fluidProfiles: profiles, fluidSetup });

    const run = result.segments.find((s) => s.edgeId === 'run')!;
    relative(run.volumeUl, 40, 1e-6, 'the mixing leg is the 40 µL network');

    const summary = computeConsumption({
      graph,
      result,
      assignments: fluidSetup.assignments,
      runDurationMin: 60,
      washMultiplier: 5,
    });

    relative(summary.totalFlowUlPerMin, 300, 1e-9, 'total draw');
    relative(summary.totalFlowMlPerH, 18, 1e-9, 'the same rate per hour');
    relative(summary.totalRunVolumeUl, 18_000, 1e-9, 'an hour of it');
    assert.equal(summary.inlets.length, 2);
    for (const inlet of summary.inlets) {
      relative(inlet.flowUlPerMin, 150, 1e-9, 'each inlet');
      relative(inlet.runVolumeUl, 9_000, 1e-9, 'each inlet over the hour');
    }

    // Priming and wash are the network's own volume, not the mixing leg's.
    relative(summary.primingVolumeUl, result.totalInternalVolumeUl, 1e-12, 'priming volume');
    relative(summary.washVolumeUl, result.totalInternalVolumeUl * 5, 1e-12, '5× wash');

    // The outlet collects everything the inlets deliver.
    relative(summary.outlets[0].flowUlPerMin, 300, 1e-6, 'collected rate');
  });

  it('primes a 40 µL network at 300 µL/min in 8 s and washes it with 200 µL', () => {
    // Stated against the network volume directly, so the figures are the
    // spec's 40 µL / 8.0 s / 200 µL rather than this fixture's arms as well.
    const { graph, fluidSetup } = twoInletChip(150);
    const result = simulate({ graph, chipParams, fluidProfiles: profiles, fluidSetup });

    const scaled: SimulationResult = {
      ...result,
      totalInternalVolumeUl: 40,
      primingTimeS: (40 / result.totalFlowUlPerMin) * 60,
    };

    const summary = computeConsumption({
      graph,
      result: scaled,
      assignments: fluidSetup.assignments,
      runDurationMin: 60,
      washMultiplier: 5,
    });

    relative(summary.primingVolumeUl, 40, 1e-9, 'priming volume');
    relative(summary.primingTimeS, 8, 1e-9, 'priming time');
    relative(summary.washVolumeUl, 200, 1e-9, '5 × 40 µL');
    relative(summary.washTimeS, 40, 1e-9, '200 µL at 300 µL/min');
  });

  it('flows the wash multiplier and run duration through to the numbers', () => {
    const { graph, fluidSetup } = twoInletChip(150);
    const result = simulate({ graph, chipParams, fluidProfiles: profiles, fluidSetup });

    const at = (runDurationMin: number, washMultiplier: number) =>
      computeConsumption({ graph, result, assignments: fluidSetup.assignments, runDurationMin, washMultiplier });

    const hour = at(60, 5);
    const tenMinutes = at(10, 5);
    const doubleWash = at(60, 10);

    relative(tenMinutes.totalRunVolumeUl, hour.totalRunVolumeUl / 6, 1e-9, 'a sixth of the run');
    relative(tenMinutes.inlets[0].runVolumeUl, hour.inlets[0].runVolumeUl / 6, 1e-9, 'per inlet too');
    relative(doubleWash.washVolumeUl, hour.washVolumeUl * 2, 1e-9, 'twice the wash');
    relative(doubleWash.washTimeS, hour.washTimeS * 2, 1e-9, 'which takes twice as long');

    // The run duration must not touch the wash, and vice versa.
    relative(tenMinutes.washVolumeUl, hour.washVolumeUl, 1e-12, 'wash is independent of duration');
    relative(doubleWash.totalRunVolumeUl, hour.totalRunVolumeUl, 1e-12, 'and duration of wash');
  });

  it('agrees with the total flow the simulation already reports', () => {
    const { graph, fluidSetup } = twoInletChip(37.5);
    const result = simulate({ graph, chipParams, fluidProfiles: profiles, fluidSetup });
    const summary = computeConsumption({
      graph,
      result,
      assignments: fluidSetup.assignments,
      runDurationMin: 60,
      washMultiplier: 5,
    });

    // Consistency, not a re-derivation: the simulation owns this number.
    assert.equal(summary.totalFlowUlPerMin, result.totalFlowUlPerMin);
    relative(
      summary.inlets.reduce((sum, i) => sum + i.flowUlPerMin, 0),
      result.totalFlowUlPerMin,
      1e-9,
      'the inlets add up to the total',
    );
  });

  it('reports a stalled chip rather than dividing by nothing', () => {
    const { graph, fluidSetup } = twoInletChip(0);
    const result = simulate({ graph, chipParams, fluidProfiles: profiles, fluidSetup });
    const summary = computeConsumption({
      graph,
      result,
      assignments: fluidSetup.assignments,
      runDurationMin: 60,
      washMultiplier: 5,
    });

    assert.equal(summary.totalRunVolumeUl, 0);
    assert.equal(summary.washTimeS, Infinity, 'no flow means the wash never finishes');
    assert.ok(!Number.isNaN(summary.washTimeS));
  });
});

describe('consumption formatting', () => {
  it('picks the unit that keeps a volume readable', () => {
    assert.equal(formatVolumeUl(40), '40.0 µL');
    assert.equal(formatVolumeUl(200), '200 µL');
    assert.equal(formatVolumeUl(999), '999 µL');
    assert.equal(formatVolumeUl(1000), '1.00 mL');
    assert.equal(formatVolumeUl(18_000), '18.0 mL');
    assert.equal(formatVolumeUl(999_999), '1000 mL');
    assert.equal(formatVolumeUl(1_080_000), '1.08 L');
    assert.equal(formatVolumeUl(Infinity), '—');
  });

  it('picks the unit that keeps a duration readable', () => {
    assert.equal(formatDurationS(8), '8.00 s');
    assert.equal(formatDurationS(59), '59.0 s');
    assert.equal(formatDurationS(60), '1.00 min');
    assert.equal(formatDurationS(3600), '1.00 h');
    assert.equal(formatDurationS(Infinity), '—');
  });

  it('converts µL/min to mL/h', () => {
    relative(mlPerHour(300), 18, 1e-12, '300 µL/min');
    relative(mlPerHour(0), 0, 1e-12, 'nothing');
  });

  it('never divides by a stalled pump', () => {
    assert.equal(timeToMoveS(100, 0), Infinity);
    assert.equal(timeToMoveS(0, 0), 0);
    relative(timeToMoveS(200, 300), 40, 1e-12, '200 µL at 300 µL/min');
  });
});

// ---------------------------------------------------------------------------

describe('fluid setup reconciliation', () => {
  const port = (id: string, x: number) =>
    ({ id, x, y: 0, type: 'port', portType: 'luer', diameterMm: 4 }) as ChannelGraph['nodes'][number];
  const graph: ChannelGraph = {
    nodes: [port('a', 0), port('b', 10), { id: 'w', x: 5, y: 0, type: 'waypoint' }],
    edges: [],
  };
  const emptySetup: FluidSetup = { assignments: [], chipMaterialThermalConductivityWmK: 0.2 };

  it('shows the presets while no fluid is stored, and the stored list after', () => {
    assert.equal(effectiveProfiles([]), FLUID_PRESETS);
    const own = [FLUID_PRESETS[1]];
    assert.equal(effectiveProfiles(own), own);
  });

  it('gives every port a default, first one in and the rest out', () => {
    const setup = reconcileFluidSetup(graph, emptySetup, []);
    assert.deepEqual(
      setup.assignments.map((a) => [a.portId, a.role, a.fluidProfileId]),
      [
        ['a', 'inlet', FLUID_PRESETS[0].id],
        ['b', 'outlet', FLUID_PRESETS[0].id],
      ],
    );
  });

  it('drops assignments for deleted ports and keeps the user\'s choices', () => {
    const stored: FluidSetup = {
      ...emptySetup,
      assignments: [
        { portId: 'b', role: 'inlet', fluidProfileId: 'x', flowRateUlPerMin: 3, inletTemperatureC: 37 },
        { portId: 'gone', role: 'outlet', fluidProfileId: 'x', flowRateUlPerMin: 10, inletTemperatureC: null },
      ],
    };
    const setup = reconcileFluidSetup(graph, stored, []);
    assert.deepEqual(setup.assignments[0], stored.assignments[0]);
    // 'b' is already the inlet, so the new port joins as an outlet.
    assert.deepEqual(
      setup.assignments.map((a) => [a.portId, a.role]),
      [
        ['b', 'inlet'],
        ['a', 'outlet'],
      ],
    );
  });

  it('returns the stored setup itself when it is already in step', () => {
    const inStep = reconcileFluidSetup(graph, emptySetup, []);
    assert.equal(reconcileFluidSetup(graph, inStep, []), inStep);
  });
});
