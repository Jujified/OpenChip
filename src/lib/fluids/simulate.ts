/**
 * The simulation run: geometry + fluids → per-segment results.
 *
 * Order of operations, and why:
 *
 *   1. **Geometry** — mean cross-section and length per segment, from the loft.
 *   2. **Resistances** — needs a viscosity, and the viscosity depends on which
 *      fluid is in the segment, which depends on the flow split. That is
 *      circular, so it is solved by iteration: start every segment on the
 *      dominant inlet fluid, solve, re-assign fluids by the resulting flow,
 *      solve again. Two passes converge for anything short of a pathological
 *      viscosity contrast, and it is stated in the results when it does not.
 *   3. **Flows and pressures** — nodal solve.
 *   4. **Reynolds** — direct, per segment.
 *   5. **Temperature** — propagate downstream with flow-weighted mixing, then
 *      apply wall exchange between neighbouring segments, then repeat. Both
 *      sides of an exchanger depend on each other, so it iterates.
 *
 * None of this is CFD. It is a one-dimensional network model: fully developed
 * flow, no entrance effects, no secondary flow around bends, perfect mixing at
 * junctions. Good for sizing a chip and catching an unusable design; not a
 * substitute for solving Navier–Stokes.
 */

import { distance, nodeIndex } from '../geometry';
import { getLoft } from '../loft';
import { prandtl } from './properties';
import {
  ductGeometry,
  flowRegime,
  meanVelocity,
  reynolds,
  UL_PER_MIN_TO_M3_S,
  UL_TO_M3,
  MM_TO_M,
  type FlowRegime,
} from './hydraulics';
import { downstreamOrder, solveNetwork, type NetworkEdge } from './network';
import { exchange, filmCoefficient } from './thermal';
import type {
  ChannelGraph,
  ChipParams,
  FluidProfile,
  FluidSetup,
} from '../../types/project';

export const CFD_DISCLAIMER =
  'Estimates, not a full CFD simulation. A one-dimensional network model assuming fully developed laminar flow, ' +
  'perfect mixing at junctions, and no entrance or bend effects.';

// ---------------------------------------------------------------------------
// results
// ---------------------------------------------------------------------------

export interface SegmentResult {
  edgeId: string;
  /** Flow-length of the segment, mm. */
  lengthMm: number;
  meanWidthMm: number;
  meanHeightMm: number;
  hydraulicDiameterMm: number;
  /** Volumetric flow, µL/min. Sign follows the edge's from → to direction. */
  flowUlPerMin: number;
  velocityMmPerS: number;
  /** Internal volume of this segment, µL. Integrated along the loft, not from the mean section. */
  volumeUl: number;
  /** Time a fluid element spends in this segment, s. Infinite where flow is zero. */
  residenceTimeS: number;
  /** Pressure drop across this segment, Pa. */
  pressureDropPa: number;
  /** Gauge pressure at the upstream and downstream ends, Pa. */
  inletPressurePa: number;
  outletPressurePa: number;
  reynolds: number;
  regime: FlowRegime;
  /** Mean wall shear stress, Pa. Zero where the segment carries no flow. */
  wallShearPa: number;
  /** Fluid occupying this segment after mixing. */
  fluidName: string;
  fluidId: string | null;
  temperatureInC: number;
  temperatureOutC: number;
  /** Net heat gained (+) or lost (−) to neighbouring channels, W. */
  heatFlowW: number;
}

export interface ExchangePairResult {
  edgeAId: string;
  edgeBId: string;
  wallThicknessMm: number;
  contactLengthMm: number;
  overallUWm2K: number;
  heatFlowW: number;
  wallFluxWm2: number;
  ntu: number;
  effectiveness: number;
  approachC: number;
}

export interface SimulationResult {
  segments: SegmentResult[];
  pairs: ExchangePairResult[];
  /** Gauge pressure at each node, Pa. */
  nodePressures: Map<string, number>;
  /** Highest pressure anywhere — what the pump has to supply. */
  maxPressurePa: number;
  totalFlowUlPerMin: number;
  /** Sum of segment volumes, µL. Channels only — ports and chambers are not included. */
  totalInternalVolumeUl: number;
  /** Fastest and slowest inlet → outlet transit, s. */
  transitTimeS: { min: number; max: number };
  /** Total volume / total inlet flow — time to fill the channel network, s. */
  primingTimeS: number;
  ranges: {
    pressurePa: [number, number];
    reynolds: [number, number];
    temperatureC: [number, number];
    residenceTimeS: [number, number];
    wallShearPa: [number, number];
  };
  /** Non-fatal notes about the run's assumptions or limits. */
  notes: string[];
  /** Set when nothing could be computed, with the reason. */
  blockedReason?: string;
}

export interface SimulationInput {
  graph: ChannelGraph;
  chipParams: ChipParams;
  fluidProfiles: FluidProfile[];
  fluidSetup: FluidSetup;
}

const EMPTY: SimulationResult = {
  segments: [],
  pairs: [],
  nodePressures: new Map(),
  maxPressurePa: 0,
  totalFlowUlPerMin: 0,
  totalInternalVolumeUl: 0,
  transitTimeS: { min: 0, max: 0 },
  primingTimeS: 0,
  ranges: {
    pressurePa: [0, 0],
    reynolds: [0, 0],
    temperatureC: [0, 0],
    residenceTimeS: [0, 0],
    wallShearPa: [0, 0],
  },
  notes: [],
};

// ---------------------------------------------------------------------------

export function simulate(input: SimulationInput): SimulationResult {
  const { graph, chipParams, fluidProfiles, fluidSetup } = input;
  const notes: string[] = [];

  if (graph.edges.length === 0) {
    return { ...EMPTY, blockedReason: 'Draw a channel network first.' };
  }

  const inlets = fluidSetup.assignments.filter((a) => a.role === 'inlet');
  const outlets = fluidSetup.assignments.filter((a) => a.role === 'outlet');

  if (inlets.length === 0 || outlets.length === 0) {
    return {
      ...EMPTY,
      blockedReason:
        'Assign at least one inlet and one outlet. Without both there is no through-path to solve.',
    };
  }

  const fluidById = new Map(fluidProfiles.map((f) => [f.id, f]));
  const fallbackFluid = fluidProfiles[0];
  if (!fallbackFluid) {
    return { ...EMPTY, blockedReason: 'Add at least one fluid profile.' };
  }

  // --- 1. geometry ----------------------------------------------------------
  const loft = getLoft(graph, chipParams);
  const nodes = nodeIndex(graph.nodes);

  interface Geom {
    edgeId: string;
    lengthM: number;
    lengthMm: number;
    meanWidthMm: number;
    meanHeightMm: number;
    areaM2: number;
    dhM: number;
    po: number;
    /** Internal volume, m³ — integrated along the loft, not from the mean. */
    volumeM3: number;
    /**
     * Hydraulic resistance per unit viscosity, m⁻³: ∫ Po / (2·A·Dh²) ds along
     * the loft. Multiplied by the segment's viscosity it is the resistance.
     */
    resistancePerViscosity: number;
    /**
     * Length-averaged wall shear per pascal of drop across the segment, m⁻¹.
     * Local shear is (Dh/4)·(dP/ds), and dP/ds follows the local resistance,
     * so a taper puts most of the shear in its narrow end.
     */
    shearPerPascal: number;
  }

  const geometry = new Map<string, Geom>();
  for (const edge of graph.edges) {
    const solved = loft.edges.get(edge.id);
    if (!solved || solved.samples.length < 2) continue;

    let lengthMm = 0;
    let widthSum = 0;
    let heightSum = 0;

    // Volume is ∫A(s)ds, integrated by the trapezoid rule against the *local*
    // area at each sample. Taking A of the mean section instead would be wrong
    // wherever a channel tapers, and taper is a first-class feature of the
    // drawing editor: a round channel running 0.4 → 1.6 mm over 30 mm holds
    // 26.39 mm³, where the mean-diameter shortcut says 23.56 — 12% light,
    // because area goes as the square of a width that is only linear in s.
    let volumeMm3 = 0;
    let previousAreaM2 = ductGeometry(
      edge.crossSection,
      solved.samples[0].widthMm,
      solved.samples[0].heightMm,
    ).areaM2;

    for (let i = 1; i < solved.samples.length; i += 1) {
      const stepMm = distance(solved.samples[i - 1].point, solved.samples[i].point);
      lengthMm += stepMm;

      const areaM2 = ductGeometry(
        edge.crossSection,
        solved.samples[i].widthMm,
        solved.samples[i].heightMm,
      ).areaM2;
      volumeMm3 += ((previousAreaM2 + areaM2) / 2) * stepMm;
      previousAreaM2 = areaM2;
    }
    for (const sample of solved.samples) {
      widthSum += sample.widthMm;
      heightSum += sample.heightMm;
    }
    const meanWidthMm = widthSum / solved.samples.length;
    const meanHeightMm = heightSum / solved.samples.length;

    // Resistance, like volume, is integrated against the local section. It
    // goes as 1/w⁴, so the mean-section shortcut badly understates a taper:
    // a round 0.2 → 1.0 mm channel has 4.3× the resistance its 0.6 mm mean
    // section suggests. Loft samples can be sparse on a straight run,
    // so each interval is subdivided with the width lerped across it.
    // Uniform channels come out exactly as before.
    let resistanceInt = 0;
    let shearInt = 0;
    const SUB = 8;
    const local = (w: number, h: number) => {
      const d = ductGeometry(edge.crossSection, w, h);
      const perLength =
        d.areaM2 > 0 && d.hydraulicDiameterM > 0
          ? d.poiseuilleNumber / (2 * d.areaM2 * d.hydraulicDiameterM ** 2)
          : Infinity;
      return { perLength, shear: (d.hydraulicDiameterM / 4) * perLength };
    };
    for (let i = 1; i < solved.samples.length; i += 1) {
      const a = solved.samples[i - 1];
      const b = solved.samples[i];
      const stepM = (distance(a.point, b.point) / SUB) * MM_TO_M;
      for (let k = 0; k < SUB; k += 1) {
        const t0 = k / SUB;
        const t1 = (k + 1) / SUB;
        const p = local(
          a.widthMm + (b.widthMm - a.widthMm) * t0,
          a.heightMm + (b.heightMm - a.heightMm) * t0,
        );
        const q = local(
          a.widthMm + (b.widthMm - a.widthMm) * t1,
          a.heightMm + (b.heightMm - a.heightMm) * t1,
        );
        resistanceInt += ((p.perLength + q.perLength) / 2) * stepM;
        shearInt += ((p.shear + q.shear) / 2) * stepM;
      }
    }
    const lengthM = lengthMm * MM_TO_M;

    // The mean section still feeds velocity and Reynolds, which are reported
    // as segment means and anchored to closed-form answers in the tests.
    const duct = ductGeometry(edge.crossSection, meanWidthMm, meanHeightMm);
    geometry.set(edge.id, {
      edgeId: edge.id,
      lengthM: lengthMm * MM_TO_M,
      lengthMm,
      meanWidthMm,
      meanHeightMm,
      areaM2: duct.areaM2,
      dhM: duct.hydraulicDiameterM,
      po: duct.poiseuilleNumber,
      // The accumulator mixes m² with mm, so the product is m²·mm; one factor
      // of MM_TO_M lands it in m³.
      volumeM3: volumeMm3 * MM_TO_M,
      resistancePerViscosity: resistanceInt,
      shearPerPascal:
        lengthM > 0 && resistanceInt > 0 && Number.isFinite(resistanceInt)
          ? shearInt / (lengthM * resistanceInt)
          : 0,
    });
  }

  // --- 2-3. iterate fluid assignment against the flow solve -----------------
  const inletFluid = (portId: string): FluidProfile => {
    const assignment = inlets.find((a) => a.portId === portId);
    return (assignment?.fluidProfileId ? fluidById.get(assignment.fluidProfileId) : null) ?? fallbackFluid;
  };

  const inletTemp = (portId: string): number => {
    const assignment = inlets.find((a) => a.portId === portId);
    if (!assignment) return fallbackFluid.inletTemperatureC;
    return assignment.inletTemperatureC ?? inletFluid(portId).inletTemperatureC;
  };

  // Seed every segment with the fluid from the highest-flow inlet.
  const dominantInlet = [...inlets].sort((a, b) => b.flowRateUlPerMin - a.flowRateUlPerMin)[0];
  let segmentFluid = new Map<string, FluidProfile>(
    graph.edges.map((e) => [e.id, inletFluid(dominantInlet.portId)]),
  );

  const injections = new Map<string, number>();
  for (const inlet of inlets) {
    injections.set(inlet.portId, inlet.flowRateUlPerMin * UL_PER_MIN_TO_M3_S);
  }
  const fixedPressures = new Map<string, number>();
  for (const outlet of outlets) fixedPressures.set(outlet.portId, 0);

  let solution = solveNetwork({
    nodeIds: graph.nodes.map((n) => n.id),
    edges: [],
    injections,
    fixedPressures,
  });

  for (let pass = 0; pass < 3; pass += 1) {
    const networkEdges: NetworkEdge[] = [];
    for (const edge of graph.edges) {
      const geom = geometry.get(edge.id);
      if (!geom) continue;
      const fluid = segmentFluid.get(edge.id) ?? fallbackFluid;
      networkEdges.push({
        id: edge.id,
        fromNodeId: edge.fromNodeId,
        toNodeId: edge.toNodeId,
        resistance: fluid.dynamicViscosityPaS * geom.resistancePerViscosity,
      });
    }

    solution = solveNetwork({
      nodeIds: graph.nodes.map((n) => n.id),
      edges: networkEdges,
      injections,
      fixedPressures,
    });

    if (!solution.solved) {
      return { ...EMPTY, blockedReason: solution.reason ?? 'The flow network could not be solved.' };
    }

    // Re-assign fluids by following the solved flow downstream.
    const next = propagateFluids(graph, solution.flows, inlets.map((a) => a.portId), inletFluid, fallbackFluid);
    const changed = [...next].some(([id, fluid]) => segmentFluid.get(id)?.id !== fluid.id);
    segmentFluid = next;
    if (!changed) break;

    if (pass === 2) {
      notes.push(
        'Fluid assignment was still shifting after three passes — the viscosity contrast between your inlets is large, so treat the split as approximate.',
      );
    }
  }

  // --- 4. per-segment hydraulics -------------------------------------------
  const segments: SegmentResult[] = [];
  const bySegment = new Map<string, SegmentResult>();

  // A dead-end stub carries no flow, but the direct solve leaves round-off
  // behind rather than an exact zero — on a 20 µL/min chip the residual is
  // around 1e-25 m³/s. Dividing a real volume by that yields 7e16 s, which is
  // an infinite residence time wearing a number's clothes. Anything below a
  // billionth of what the pumps deliver is noise from the elimination, not
  // flow; it is far above the solver's round-off and far below any branch a
  // user would call slow.
  const flowNoiseFloorM3S =
    [...injections.values()].reduce((sum, q) => sum + Math.abs(q), 0) * 1e-9;

  for (const edge of graph.edges) {
    const geom = geometry.get(edge.id);
    if (!geom) continue;

    const fluid = segmentFluid.get(edge.id) ?? fallbackFluid;
    const flowM3S = solution.flows.get(edge.id) ?? 0;
    const velocity = meanVelocity(flowM3S, geom.areaM2);
    const re = reynolds(fluid.densityKgM3, velocity, geom.dhM, fluid.dynamicViscosityPaS);

    const pFrom = solution.pressures.get(edge.fromNodeId) ?? 0;
    const pTo = solution.pressures.get(edge.toNodeId) ?? 0;

    const result: SegmentResult = {
      edgeId: edge.id,
      lengthMm: geom.lengthMm,
      meanWidthMm: geom.meanWidthMm,
      meanHeightMm: geom.meanHeightMm,
      hydraulicDiameterMm: geom.dhM / MM_TO_M,
      flowUlPerMin: flowM3S / UL_PER_MIN_TO_M3_S,
      velocityMmPerS: velocity * 1000,
      volumeUl: geom.volumeM3 / UL_TO_M3,
      // A stalled segment holds its fluid for ever. Storing Infinity says that;
      // clamping it to some large number would invent a figure the user could
      // read as an answer.
      residenceTimeS:
        Math.abs(flowM3S) > flowNoiseFloorM3S ? geom.volumeM3 / Math.abs(flowM3S) : Infinity,
      pressureDropPa: Math.abs(pFrom - pTo),
      inletPressurePa: Math.max(pFrom, pTo),
      outletPressurePa: Math.min(pFrom, pTo),
      reynolds: re,
      regime: flowRegime(re),
      // Force balance on a duct element: the pressure acting on the section
      // has to be carried by the wall it drags against, so τ_w = (Dh/4)·(dP/ds),
      // averaged along the segment. For a uniform channel that is the familiar
      // (Dh/4)·(ΔP/L). A degenerate edge can loft to zero length, and gets 0
      // rather than an infinite stress where there is no wall to speak of.
      wallShearPa: geom.shearPerPascal * Math.abs(pFrom - pTo),
      fluidName: fluid.name,
      fluidId: fluid.id,
      temperatureInC: fallbackFluid.inletTemperatureC,
      temperatureOutC: fallbackFluid.inletTemperatureC,
      heatFlowW: 0,
    };

    segments.push(result);
    bySegment.set(edge.id, result);
  }

  // --- 5. temperature -------------------------------------------------------
  const pairs = findExchangePairs(graph, chipParams);

  solveTemperatures({
    graph,
    segments: bySegment,
    segmentFluid,
    geometry,
    flows: solution.flows,
    inletPortIds: inlets.map((a) => a.portId),
    inletTemp,
    pairs,
    chipConductivity: fluidSetup.chipMaterialThermalConductivityWmK,
    fallbackFluid,
  });

  const pairResults: ExchangePairResult[] = pairs.map((pair) => ({
    edgeAId: pair.a,
    edgeBId: pair.b,
    wallThicknessMm: pair.wallMm,
    contactLengthMm: pair.contactMm,
    overallUWm2K: pair.lastResult?.overallUWm2K ?? 0,
    heatFlowW: pair.lastResult?.heatFlowW ?? 0,
    wallFluxWm2: pair.lastResult?.wallFluxWm2 ?? 0,
    ntu: pair.lastResult?.ntu ?? 0,
    effectiveness: pair.lastResult?.effectiveness ?? 0,
    approachC: pair.lastResult?.approachC ?? 0,
  }));

  // --- ranges ---------------------------------------------------------------
  const pressures = segments.flatMap((s) => [s.inletPressurePa, s.outletPressurePa]);
  const res = segments.map((s) => s.reynolds);
  const temps = segments.flatMap((s) => [s.temperatureInC, s.temperatureOutC]);
  const residences = segments.map((s) => s.residenceTimeS);
  const shears = segments.map((s) => s.wallShearPa);

  const range = (values: number[]): [number, number] =>
    values.length === 0 ? [0, 0] : [Math.min(...values), Math.max(...values)];

  const maxPressurePa = Math.max(0, ...[...solution.pressures.values()]);

  // --- volume and transit ---------------------------------------------------
  const totalInternalVolumeUl = segments.reduce((sum, s) => sum + s.volumeUl, 0);
  const totalFlowUlPerMin = inlets.reduce((sum, a) => sum + a.flowRateUlPerMin, 0);

  const transitTimeS = propagateTransit(
    graph,
    solution.flows,
    inlets.map((a) => a.portId),
    outlets.map((a) => a.portId),
    new Map(segments.map((s) => [s.edgeId, s.residenceTimeS])),
  );

  const primingTimeS =
    totalInternalVolumeUl <= 0
      ? 0
      : totalFlowUlPerMin > 0
        ? (totalInternalVolumeUl / totalFlowUlPerMin) * 60
        : Infinity;

  if (segments.some((s) => s.regime !== 'laminar')) {
    notes.push(
      'Some segments are outside the laminar range. The Hagen–Poiseuille pressure drop assumes laminar flow, so those figures under-predict — treat them as a lower bound.',
    );
  }

  void nodes;

  return {
    segments,
    pairs: pairResults,
    nodePressures: solution.pressures,
    maxPressurePa,
    totalFlowUlPerMin,
    totalInternalVolumeUl,
    transitTimeS,
    primingTimeS,
    ranges: {
      pressurePa: range(pressures),
      reynolds: range(res),
      temperatureC: range(temps),
      residenceTimeS: range(residences),
      wallShearPa: range(shears),
    },
    notes,
  };
}

// ---------------------------------------------------------------------------
// fluid propagation
// ---------------------------------------------------------------------------

/**
 * Works out which fluid occupies each segment.
 *
 * Where streams meet, properties blend by mass flow — a junction taking 90%
 * water and 10% glycerol behaves very nearly like water, and treating it as a
 * 50/50 blend would badly overstate the downstream pressure drop.
 */
function propagateFluids(
  graph: ChannelGraph,
  flows: Map<string, number>,
  inletPortIds: string[],
  inletFluid: (portId: string) => FluidProfile,
  fallback: FluidProfile,
): Map<string, FluidProfile> {
  const ordered = downstreamOrder(
    graph.edges.map((e) => ({
      id: e.id,
      fromNodeId: e.fromNodeId,
      toNodeId: e.toNodeId,
      resistance: 1,
    })),
    flows,
    inletPortIds,
  );

  const atNode = new Map<string, { fluid: FluidProfile; massFlow: number }[]>();
  for (const portId of inletPortIds) {
    atNode.set(portId, [{ fluid: inletFluid(portId), massFlow: 1 }]);
  }

  const result = new Map<string, FluidProfile>();

  for (const edge of ordered) {
    const incoming = atNode.get(edge.fromNodeId);
    const fluid = incoming && incoming.length > 0 ? blend(incoming) : fallback;
    result.set(edge.edgeId, fluid);

    const q = Math.abs(flows.get(edge.edgeId) ?? 0);
    const list = atNode.get(edge.toNodeId);
    const entry = { fluid, massFlow: q * fluid.densityKgM3 };
    if (list) list.push(entry);
    else atNode.set(edge.toNodeId, [entry]);
  }

  for (const edge of graph.edges) {
    if (!result.has(edge.id)) result.set(edge.id, fallback);
  }

  return result;
}

// ---------------------------------------------------------------------------
// transit time
// ---------------------------------------------------------------------------

/**
 * Earliest and latest arrival at each outlet, seconds from the inlets.
 *
 * Mirrors `propagateFluids`: same downstream walk, accumulating time instead of
 * identity. A branched network genuinely has no single transit time — a wide
 * branch delivers long before a narrow one — so both bounds are carried and the
 * UI reports the range. Picking one and calling it *the* transit time would be a
 * quiet fiction.
 */
function propagateTransit(
  graph: ChannelGraph,
  flows: Map<string, number>,
  inletPortIds: string[],
  outletPortIds: string[],
  residenceS: Map<string, number>,
): { min: number; max: number } {
  const ordered = downstreamOrder(
    graph.edges.map((e) => ({
      id: e.id,
      fromNodeId: e.fromNodeId,
      toNodeId: e.toNodeId,
      resistance: 1,
    })),
    flows,
    inletPortIds,
  );

  const arrivalMin = new Map<string, number>();
  const arrivalMax = new Map<string, number>();
  for (const portId of inletPortIds) {
    arrivalMin.set(portId, 0);
    arrivalMax.set(portId, 0);
  }

  for (const edge of ordered) {
    const fromMin = arrivalMin.get(edge.fromNodeId);
    const fromMax = arrivalMax.get(edge.fromNodeId);
    // No arrival upstream means this edge sits on an island with no path from
    // any inlet. It has no transit time — not a transit time of zero.
    if (fromMin === undefined || fromMax === undefined) continue;

    const tau = residenceS.get(edge.edgeId) ?? 0;
    // A stalled segment is not a route: no fluid element ever traverses it, so
    // it contributes no arrival downstream rather than an infinite one.
    if (!Number.isFinite(tau)) continue;

    arrivalMin.set(edge.toNodeId, Math.min(arrivalMin.get(edge.toNodeId) ?? Infinity, fromMin + tau));
    arrivalMax.set(edge.toNodeId, Math.max(arrivalMax.get(edge.toNodeId) ?? -Infinity, fromMax + tau));
  }

  const reached = outletPortIds.filter((id) => arrivalMin.has(id));
  if (reached.length === 0) return { min: 0, max: 0 };

  return {
    min: Math.min(...reached.map((id) => arrivalMin.get(id) as number)),
    max: Math.max(...reached.map((id) => arrivalMax.get(id) as number)),
  };
}

/** Mass-weighted property blend. Keeps the dominant fluid's name and id. */
function blend(streams: { fluid: FluidProfile; massFlow: number }[]): FluidProfile {
  if (streams.length === 1) return streams[0].fluid;

  const total = streams.reduce((sum, s) => sum + s.massFlow, 0);
  if (total <= 0) return streams[0].fluid;

  const distinct = new Set(streams.map((s) => s.fluid.id));
  if (distinct.size === 1) return streams[0].fluid;

  const weighted = (pick: (f: FluidProfile) => number) =>
    streams.reduce((sum, s) => sum + pick(s.fluid) * s.massFlow, 0) / total;

  const dominant = [...streams].sort((a, b) => b.massFlow - a.massFlow)[0].fluid;

  return {
    ...dominant,
    id: `${dominant.id}+mix`,
    name: `${dominant.name} (mixed)`,
    densityKgM3: weighted((f) => f.densityKgM3),
    dynamicViscosityPaS: weighted((f) => f.dynamicViscosityPaS),
    thermalConductivityWmK: weighted((f) => f.thermalConductivityWmK),
    specificHeatCapacityJkgK: weighted((f) => f.specificHeatCapacityJkgK),
  };
}

// ---------------------------------------------------------------------------
// exchange pairing
// ---------------------------------------------------------------------------

interface ExchangePair {
  a: string;
  b: string;
  wallMm: number;
  contactMm: number;
  lastResult?: ReturnType<typeof exchange>;
}

/**
 * Segments running close enough to trade heat.
 *
 * Reuses the same sampled-centerline distance the wall check uses, so
 * "adjacent" means the same thing in both places. Segments sharing a node are
 * skipped — they are the same stream, and heat flowing along a stream is
 * advection, not exchange.
 */
function findExchangePairs(
  graph: ChannelGraph,
  chipParams: ChipParams,
): ExchangePair[] {
  const loft = getLoft(graph, chipParams);

  // Conduction through resin falls off fast; past a few channel widths the
  // pairing is noise.
  const searchLimitMm = Math.max(1.5, chipParams.wallThickness * 1.5);

  const adjacent = (a: ChannelGraph['edges'][number], b: ChannelGraph['edges'][number]) =>
    a.fromNodeId === b.fromNodeId ||
    a.fromNodeId === b.toNodeId ||
    a.toNodeId === b.fromNodeId ||
    a.toNodeId === b.toNodeId;

  /** Directed contact: how much of `from` runs alongside `to` as its nearest. */
  const directed = new Map<string, { contactMm: number; wallSum: number; count: number }>();

  for (const edge of graph.edges) {
    const samples = loft.edges.get(edge.id);
    if (!samples || samples.samples.length < 2) continue;

    for (let k = 1; k < samples.samples.length; k += 1) {
      const mid = {
        x: (samples.samples[k - 1].point.x + samples.samples[k].point.x) / 2,
        y: (samples.samples[k - 1].point.y + samples.samples[k].point.y) / 2,
      };
      const stepMm = distance(samples.samples[k - 1].point, samples.samples[k].point);

      // Each stretch of channel belongs to exactly ONE partner — whichever is
      // nearest. Letting a stretch pair with every channel within range made
      // the same millimetre exchange heat several times over, and a
      // counter-flow chip produced seven pairings where three exist.
      let bestId: string | null = null;
      let bestGap = Infinity;

      for (const other of graph.edges) {
        if (other.id === edge.id || adjacent(edge, other)) continue;
        const otherSamples = loft.edges.get(other.id);
        if (!otherSamples) continue;

        for (const sample of otherSamples.samples) {
          const gap =
            distance(mid, sample.point) - samples.samples[k].widthMm / 2 - sample.widthMm / 2;
          if (gap < bestGap) {
            bestGap = gap;
            bestId = other.id;
          }
        }
      }

      if (bestId === null || bestGap > searchLimitMm) continue;

      const key = `${edge.id}\u0000${bestId}`;
      const entry = directed.get(key) ?? { contactMm: 0, wallSum: 0, count: 0 };
      entry.contactMm += stepMm;
      entry.wallSum += Math.max(bestGap, 0.01);
      entry.count += 1;
      directed.set(key, entry);
    }
  }

  // Fold the two directions together. The shared length cannot exceed the
  // shorter side's view of it, so the smaller of the two is the honest figure.
  const pairs: ExchangePair[] = [];
  const seen = new Set<string>();

  for (const [key, entry] of directed) {
    const [a, b] = key.split('\u0000');
    const canonical = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
    if (seen.has(canonical)) continue;
    seen.add(canonical);

    const reverse = directed.get(`${b}\u0000${a}`);
    const contactMm = reverse ? Math.min(entry.contactMm, reverse.contactMm) : entry.contactMm;
    const wallMm = reverse
      ? (entry.wallSum / entry.count + reverse.wallSum / reverse.count) / 2
      : entry.wallSum / entry.count;

    if (contactMm <= 0) continue;
    pairs.push({ a, b, wallMm, contactMm });
  }

  return pairs;
}

// ---------------------------------------------------------------------------
// temperature field
// ---------------------------------------------------------------------------

function solveTemperatures(args: {
  graph: ChannelGraph;
  segments: Map<string, SegmentResult>;
  segmentFluid: Map<string, FluidProfile>;
  geometry: Map<string, { areaM2: number; dhM: number; lengthM: number }>;
  flows: Map<string, number>;
  inletPortIds: string[];
  inletTemp: (portId: string) => number;
  pairs: ExchangePair[];
  chipConductivity: number;
  fallbackFluid: FluidProfile;
}): void {
  const {
    graph,
    segments,
    segmentFluid,
    geometry,
    flows,
    inletPortIds,
    inletTemp,
    pairs,
    chipConductivity,
    fallbackFluid,
  } = args;

  const ordered = downstreamOrder(
    graph.edges.map((e) => ({ id: e.id, fromNodeId: e.fromNodeId, toNodeId: e.toNodeId, resistance: 1 })),
    flows,
    inletPortIds,
  );

  /** Capacity rate ṁ·cp, W/K. */
  const capacityRateOf = (edgeId: string): number => {
    const fluid = segmentFluid.get(edgeId) ?? fallbackFluid;
    return Math.abs(flows.get(edgeId) ?? 0) * fluid.densityKgM3 * fluid.specificHeatCapacityJkgK;
  };

  const meanOf = (edgeId: string): number => {
    const segment = segments.get(edgeId);
    return segment ? (segment.temperatureInC + segment.temperatureOutC) / 2 : 0;
  };

  // Start with no exchange so the first UA evaluation has real temperatures.
  march(new Map());

  /**
   * Relax to steady state.
   *
   * The tempting scheme — compute a heat flow and add it to the temperature,
   * repeatedly — is a *time march*, not a steady-state solve: every pass injects
   * another dose of heat and the field runs away (it reached ±8000 °C on a
   * counter-flow chip). What follows instead solves each segment's steady-state
   * energy balance directly:
   *
   *     C·(T_out − T_in) = UA·(T_neighbour − T_mean),  T_mean = (T_in + T_out)/2
   *
   * rearranged for T_out. That is bounded for any UA — as conductance grows the
   * segment's *mean* approaches its neighbour rather than overshooting without
   * limit — so iterating it converges instead of diverging.
   */
  for (let pass = 0; pass < 40; pass += 1) {
    const conductance = new Map<string, { ua: number; weighted: number }>();

    for (const pair of pairs) {
      const a = segments.get(pair.a);
      const b = segments.get(pair.b);
      const geomA = geometry.get(pair.a);
      const geomB = geometry.get(pair.b);
      if (!a || !b || !geomA || !geomB) continue;

      const fluidA = segmentFluid.get(pair.a) ?? fallbackFluid;
      const fluidB = segmentFluid.get(pair.b) ?? fallbackFluid;
      const meanA = meanOf(pair.a);
      const meanB = meanOf(pair.b);

      const hA = filmCoefficient(
        a.reynolds, prandtl(fluidA), fluidA.thermalConductivityWmK, geomA.dhM, meanA < meanB,
      );
      const hB = filmCoefficient(
        b.reynolds, prandtl(fluidB), fluidB.thermalConductivityWmK, geomB.dhM, meanB < meanA,
      );
      if (hA <= 0 || hB <= 0) continue;

      // Facing area: contact length × the shallower channel's height.
      const heightM = Math.min(a.meanHeightMm, b.meanHeightMm) * MM_TO_M;
      const areaM2 = pair.contactMm * MM_TO_M * heightM;
      if (areaM2 <= 0) continue;

      const u =
        1 / (1 / hA + Math.max(pair.wallMm, 0) * MM_TO_M / Math.max(chipConductivity, 1e-9) + 1 / hB);
      const ua = u * areaM2;

      for (const [self, other, otherMean] of [
        [pair.a, pair.b, meanB],
        [pair.b, pair.a, meanA],
      ] as const) {
        void other;
        const entry = conductance.get(self) ?? { ua: 0, weighted: 0 };
        entry.ua += ua;
        entry.weighted += ua * otherMean;
        conductance.set(self, entry);
      }

      pair.lastResult = describePair(pair, ua, u, areaM2, meanA, meanB, pair.a, pair.b);
    }

    march(conductance);
  }

  /** Walks downstream solving each segment's steady-state balance. */
  function march(conductance: Map<string, { ua: number; weighted: number }>): void {
    const arriving = new Map<string, { tempC: number; capacityRate: number }[]>();
    for (const portId of inletPortIds) {
      arriving.set(portId, [{ tempC: inletTemp(portId), capacityRate: 1 }]);
    }

    for (const edge of ordered) {
      const segment = segments.get(edge.edgeId);
      if (!segment) continue;

      const fluid = segmentFluid.get(edge.edgeId) ?? fallbackFluid;
      const incoming = arriving.get(edge.fromNodeId);

      // Energy-weighted mix of everything arriving at the upstream node.
      const tempIn =
        incoming && incoming.length > 0
          ? incoming.reduce((sum, s) => sum + s.tempC * s.capacityRate, 0) /
            Math.max(1e-12, incoming.reduce((sum, s) => sum + s.capacityRate, 0))
          : fluid.inletTemperatureC;

      const capacityRate = capacityRateOf(edge.edgeId);
      const link = conductance.get(edge.edgeId);

      let tempOut = tempIn;
      if (link && link.ua > 0 && capacityRate > 0) {
        const neighbourMean = link.weighted / link.ua;
        tempOut =
          (capacityRate * tempIn + link.ua * (neighbourMean - tempIn / 2)) /
          (capacityRate + link.ua / 2);
      }

      segment.temperatureInC = tempIn;
      segment.temperatureOutC = tempOut;
      segment.heatFlowW = capacityRate * (tempOut - tempIn);

      const list = arriving.get(edge.toNodeId);
      const entry = { tempC: tempOut, capacityRate: Math.max(capacityRate, 1e-12) };
      if (list) list.push(entry);
      else arriving.set(edge.toNodeId, [entry]);
    }
  }

  /** Descriptive figures for the results table, read off the converged state. */
  function describePair(
    pair: ExchangePair,
    ua: number,
    u: number,
    areaM2: number,
    meanA: number,
    meanB: number,
    aId: string,
    bId: string,
  ): ReturnType<typeof exchange> {
    const cA = capacityRateOf(aId);
    const cB = capacityRateOf(bId);
    const cMin = Math.min(cA, cB);
    const heatFlowW = ua * Math.abs(meanA - meanB);

    const a = segments.get(aId);
    const b = segments.get(bId);
    const approachC =
      a && b ? Math.abs(a.temperatureOutC - b.temperatureOutC) : Math.abs(meanA - meanB);

    void pair;
    return {
      overallUWm2K: u,
      heatFlowW,
      wallFluxWm2: areaM2 > 0 ? heatFlowW / areaM2 : 0,
      ntu: cMin > 0 ? ua / cMin : 0,
      effectiveness:
        cMin > 0 && Math.abs(meanA - meanB) > 1e-9
          ? Math.min(1, heatFlowW / (cMin * Math.abs(meanA - meanB)))
          : 0,
      hotOutletC: Math.max(meanA, meanB),
      coldOutletC: Math.min(meanA, meanB),
      approachC,
    };
  }
}
