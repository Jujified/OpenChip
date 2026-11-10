/**
 * The preview must show the geometry the export writes. These tests build the
 * compensated chip through the export path and compare the actual mesh with
 * what the preview draws for the same design and profile.
 */

import assert from 'node:assert/strict';
import { beforeAll, describe, it } from 'vitest';
import Module from 'manifold-3d';
import { buildChip, type ManifoldApi } from '../cad/buildChip';
import { CHIP_PRESETS, presetBuild } from '../presets';
import { DEFAULT_CHIP_PARAMS, FALLBACK_PRINTER_PROFILE } from '../defaults';
import type { ChannelGraph } from '../../types/project';
import { compensateDesign, type NominalDesign } from './compensate';
import { planExport } from './exportPlan';
import { buildDfmPreview, sliceSections } from './preview';
import { hashDfmProfile } from './profile';
import { design, makeProfile, parallelChannels } from './testFixtures';

let api: ManifoldApi;

beforeAll(async () => {
  const raw = await Module();
  raw.setup();
  api = { Manifold: raw.Manifold, Mesh: raw.Mesh } as unknown as ManifoldApi;
}, 60_000);

const near = (actual: number, expected: number, tolerance: number, label = '') =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} expected ${expected}, got ${actual}`);

/** Extent of a mesh's vertices near the plane x = `at`, in y and z. */
function meshSlice(positions: Float32Array, at: number, yLo: number, yHi: number) {
  let yMin = Infinity, yMax = -Infinity, zMin = Infinity, zMax = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    if (Math.abs(positions[i] - at) > 0.6) continue;
    const y = positions[i + 1];
    if (y < yLo || y > yHi) continue;
    yMin = Math.min(yMin, y);
    yMax = Math.max(yMax, y);
    zMin = Math.min(zMin, positions[i + 2]);
    zMax = Math.max(zMax, positions[i + 2]);
  }
  return { yMin, yMax, zMin, zMax };
}

describe('preview geometry equals compensated export geometry', () => {
  const profile = makeProfile({ deltaXyMm: 0.06, lateralDecayMm: 0.05, deltaZMm: 0.12 });

  for (const crossSection of ['rect', 'trapezoid', 'round'] as const) {
    it(`matches the built mesh for a ${crossSection} channel`, async () => {
      const graph: ChannelGraph = parallelChannels(4);
      graph.edges = graph.edges.map((e) => ({ ...e, crossSection }));
      graph.edges[1].dimensionPoints = [{ t: 0, widthMm: 0.4, heightMm: 0.3 }];
      const nominal = design(graph, { splitType: 'monolithic', wallThickness: 0.4 });

      // The export path…
      const plan = planExport(nominal, 'chip', { profile, sha256: await hashDfmProfile(profile) });
      const built = buildChip(api, plan.graph, plan.chipParams, {
        quality: 2,
        drainageVents: plan.drainageVents,
        ceilingRaiseMm: plan.ceilingRaiseMm,
        includeChannelSolid: true,
      });
      const cavity = built.channelSolid?.positions;
      assert.ok(cavity);

      // …and the preview path, from the same function's result.
      const compensated = compensateDesign(nominal, profile);
      assert.deepEqual(compensated, plan.compensated);
      const sections = sliceSections(nominal, compensated, 'x', 20);
      assert.equal(sections.length, 2);

      for (const section of sections) {
        const s = section.compensated.points.map((p) => p.s);
        const z = section.compensated.points.map((p) => p.z);
        const mesh = meshSlice(cavity, 20, section.alongMm - 2, section.alongMm + 2);

        // The round profile is a 32-gon in both; rect and trapezoid are exact.
        near(Math.min(...s), mesh.yMin, 1e-4, `${section.edgeId} left wall`);
        near(Math.max(...s), mesh.yMax, 1e-4, `${section.edgeId} right wall`);
        near(Math.min(...z), mesh.zMin, 1e-4, `${section.edgeId} floor`);
        near(Math.max(...z), mesh.zMax, 1e-4, `${section.edgeId} ceiling`);

        if (crossSection === 'round') {
          // A round channel is corrected as a larger circle, so its lowest
          // point drops by the lateral offset. A documented limit of the model.
          const grown = (section.compensated.widthMm - section.nominal.widthMm) / 2;
          near(section.nominal.floorZ - section.compensated.floorZ, grown, 1e-9, 'round floor');
          near(section.compensated.ceilingZ - section.nominal.ceilingZ, 0.12 + grown, 1e-9, 'round roof');
        } else {
          near(section.compensated.floorZ, section.nominal.floorZ, 1e-9, 'the floor does not move');
          near(section.compensated.ceilingZ - section.nominal.ceilingZ, 0.12, 1e-9, 'ceiling raise');
        }
        assert.ok(section.compensated.widthMm > section.nominal.widthMm);
      }
    });
  }

  it('draws the nominal outline at the nominal mesh, too', () => {
    const nominal = design(parallelChannels(4), { splitType: 'monolithic' });
    const compensated = compensateDesign(nominal, profile);
    const built = buildChip(api, nominal.graph, nominal.chipParams, { quality: 2, includeChannelSolid: true });
    const [section] = sliceSections(nominal, compensated, 'x', 20);
    const mesh = meshSlice(built.channelSolid!.positions, 20, section.alongMm - 2, section.alongMm + 2);
    near(Math.min(...section.nominal.points.map((p) => p.s)), mesh.yMin, 1e-4);
    near(Math.max(...section.nominal.points.map((p) => p.z)), mesh.zMax, 1e-4);
  });

  it('outlines each channel in the top view at its compensated width', () => {
    const nominal = design(parallelChannels(4), { splitType: 'two-piece' });
    const compensated = compensateDesign(nominal, makeProfile({ deltaXyMm: 0.05 }));
    const model = buildDfmPreview(nominal, compensated);

    const ys = (points: { y: number }[]) => [Math.min(...points.map((p) => p.y)), Math.max(...points.map((p) => p.y))];
    // Channel at y = 20, 0.8 mm wide as drawn, 0.9 mm compensated.
    assert.deepEqual(ys(model.edges[0].nominal).map((v) => Number(v.toFixed(6))), [19.6, 20.4]);
    assert.deepEqual(ys(model.edges[0].compensated).map((v) => Number(v.toFixed(6))), [19.55, 20.45]);
    assert.equal(model.edges[0].changed, true);
  });
});

describe('the preview model', () => {
  it('marks nothing changed when the profile changes nothing', () => {
    const nominal = design(parallelChannels(4));
    const model = buildDfmPreview(nominal, compensateDesign(nominal, makeProfile({ deltaXyMm: 0, deltaZMm: 0 })));
    assert.ok(model.edges.every((e) => !e.changed && !e.conflict));
    assert.deepEqual(model.conflictMarks, []);
  });

  it('flags the segments a conflict names, and marks where it is', () => {
    const nominal = design(parallelChannels(1.3), { wallThickness: 0.3 });
    const compensated = compensateDesign(nominal, makeProfile({ deltaXyMm: 0.1 }));
    const model = buildDfmPreview(nominal, compensated);
    assert.deepEqual(model.edges.map((e) => e.conflict), [true, true]);
    assert.equal(model.conflictMarks.length, 1);
    assert.equal(model.conflictMarks[0].kind, 'wall-too-thin');
    assert.ok(sliceSections(nominal, compensated, 'x', 20).every((s) => s.conflict));
  });

  it('shows ports unchanged and chambers and vents changed', () => {
    const preset = CHIP_PRESETS.find((p) => p.id === 'serpentine-mixer')!;
    const graph = presetBuild(preset).graph;
    const nominal: NominalDesign = {
      graph,
      chipParams: { ...DEFAULT_CHIP_PARAMS, ...preset.chipParams },
      drainageVents: [{ id: 'v', nodeId: graph.nodes[3].id, diameterMm: 0.8, autoPlaced: false }],
      printerProfile: FALLBACK_PRINTER_PROFILE,
    };
    const model = buildDfmPreview(nominal, compensateDesign(nominal, makeProfile()));
    assert.ok(model.circles.filter((c) => c.kind === 'port').every((c) => !c.changed));
    assert.ok(model.circles.filter((c) => c.kind === 'vent').every((c) => c.changed));
    assert.ok(model.circles.some((c) => c.kind === 'joint' && c.changed));
  });

  it('finds every channel a slice crosses, in order, and none it misses', () => {
    const nominal = design(parallelChannels(4));
    const compensated = compensateDesign(nominal, makeProfile());
    assert.deepEqual(sliceSections(nominal, compensated, 'x', 20).map((s) => s.edgeId), ['ea', 'eb']);
    assert.deepEqual(sliceSections(nominal, compensated, 'x', 35), []);
    // A slice along the channels' own direction crosses neither.
    assert.deepEqual(sliceSections(nominal, compensated, 'y', 22), []);
  });

  it('stretches an oblique crossing and keeps the true width', () => {
    const graph: ChannelGraph = {
      nodes: [
        { id: 'a', x: 10, y: 10, type: 'waypoint' },
        { id: 'b', x: 30, y: 30, type: 'waypoint' },
      ],
      edges: [{ id: 'e', fromNodeId: 'a', toNodeId: 'b', curveType: 'straight', crossSection: 'rect', dimensionPoints: [] }],
    };
    const nominal = design(graph);
    const [section] = sliceSections(nominal, compensateDesign(nominal, makeProfile()), 'x', 20);
    near(section.obliqueStretch, Math.SQRT2, 1e-6);
    near(section.nominal.widthMm, 0.8, 1e-9);
    const s = section.nominal.points.map((p) => p.s);
    near(Math.max(...s) - Math.min(...s), 0.8 * Math.SQRT2, 1e-6);
  });

  it('is fast enough to recompute while editing', () => {
    // The largest template. Compensation, conflict detection, the preview model
    // and a slice together are what one debounced recompute costs.
    const preset = CHIP_PRESETS.find((p) => p.id === 'gradient-generator')!;
    const nominal: NominalDesign = {
      graph: presetBuild(preset).graph,
      chipParams: { ...DEFAULT_CHIP_PARAMS, ...preset.chipParams },
      drainageVents: [],
      printerProfile: FALLBACK_PRINTER_PROFILE,
    };
    const profile = makeProfile({ lateralDecayMm: 0.05 });
    const run = () => {
      // A fresh graph object each time, so the loft cache cannot flatter it.
      const fresh = { ...nominal, graph: { ...nominal.graph } };
      const compensated = compensateDesign(fresh, profile);
      buildDfmPreview(fresh, compensated);
      sliceSections(fresh, compensated, 'x', fresh.chipParams.width / 2);
    };
    run();
    const started = performance.now();
    for (let i = 0; i < 5; i += 1) run();
    const each = (performance.now() - started) / 5;
    assert.ok(each < 250, `one recompute took ${each.toFixed(1)} ms`);
    console.log(`dfm preview recompute, gradient generator: ${each.toFixed(1)} ms`);
  });
});
