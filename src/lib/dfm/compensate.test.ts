/**
 * Compensation tests: the model's arithmetic, the transform on hand-checked
 * designs, conflict detection, and the solid the pipeline builds from it.
 */

import assert from 'node:assert/strict';
import { beforeAll, describe, it } from 'vitest';
import Module from 'manifold-3d';
import { buildChip, type ManifoldApi } from '../cad/buildChip';
import { placeChannel, profilePoints } from '../cad/placement';
import { exportScad } from '../cad/scadExport';
import { getLoft } from '../loft';
import type { ChannelGraph } from '../../types/project';
import { compensateDesign, lateralOffsetAtMm } from './compensate';
import { bleedPerSideMm, closureWidthMm, drawnWidthForMm, printedWidthMm } from './model';
import { design, makeProfile, parallelChannels } from './testFixtures';

let api: ManifoldApi;

beforeAll(async () => {
  const raw = await Module();
  raw.setup();
  api = { Manifold: raw.Manifold, Mesh: raw.Mesh } as unknown as ManifoldApi;
}, 60_000);

const near = (actual: number, expected: number, tolerance = 1e-6, label = '') =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} expected ${expected}, got ${actual}`);

/** One straight rect channel, 20 mm long, with whatever markers are given. */
const single = (dimensionPoints: ChannelGraph['edges'][number]['dimensionPoints'] = []): ChannelGraph => ({
  nodes: [
    { id: 'a', x: 10, y: 30, type: 'waypoint' },
    { id: 'b', x: 30, y: 30, type: 'waypoint' },
  ],
  edges: [
    { id: 'e', fromNodeId: 'a', toNodeId: 'b', curveType: 'straight', crossSection: 'rect', dimensionPoints },
  ],
});

// ---------------------------------------------------------------------------

describe('lateral bleed model', () => {
  it('is a constant offset per side when the decay length is zero', () => {
    const model = { deltaXyMm: 0.05, lateralDecayMm: 0 };
    near(bleedPerSideMm(0.4, model), 0.05);
    near(printedWidthMm(0.4, model), 0.3);
    near(drawnWidthForMm(0.4, model), 0.5);
    near(closureWidthMm(model), 0.1);
  });

  it('closes a channel no wider than twice the offset', () => {
    const model = { deltaXyMm: 0.05, lateralDecayMm: 0 };
    assert.equal(printedWidthMm(0.1, model), 0);
    assert.equal(printedWidthMm(0.06, model), 0);
  });

  it('tends to the isolated-edge offset in a wide channel', () => {
    const model = { deltaXyMm: 0.05, lateralDecayMm: 0.04 };
    near(bleedPerSideMm(5, model), 0.05, 1e-9);
    // Far enough that e^(-W/λ) underflows: the stable form must not return NaN.
    near(bleedPerSideMm(500, model), 0.05, 1e-9);
  });

  it('takes more from a narrow channel than a wide one', () => {
    const model = { deltaXyMm: 0.05, lateralDecayMm: 0.04 };
    assert.ok(bleedPerSideMm(0.2, model) > bleedPerSideMm(0.4, model));
    assert.ok(bleedPerSideMm(0.4, model) > bleedPerSideMm(1, model));
  });

  it('closes exactly at 2Δ + 2λ·ln 2', () => {
    // Hand check: Δ = 0.05, λ = 0.04 → 0.1 + 0.08 × 0.693147 = 0.155452.
    const model = { deltaXyMm: 0.05, lateralDecayMm: 0.04 };
    near(closureWidthMm(model), 0.155452, 1e-6);
    assert.equal(printedWidthMm(0.155, model), 0);
    assert.ok(printedWidthMm(0.16, model) > 0);
  });

  it('satisfies the dose balance it is derived from', () => {
    // At the solved wall position x, e^(-x/λ) + e^(-(W-x)/λ) must equal e^(-Δ/λ).
    const model = { deltaXyMm: 0.05, lateralDecayMm: 0.04 };
    for (const width of [0.2, 0.3, 0.6]) {
      const x = bleedPerSideMm(width, model);
      const dose = Math.exp(-x / 0.04) + Math.exp(-(width - x) / 0.04);
      near(dose, Math.exp(-0.05 / 0.04), 1e-9, `W=${width}`);
    }
  });

  it('inverts: drawing the compensated width prints the target', () => {
    for (const model of [
      { deltaXyMm: 0.05, lateralDecayMm: 0 },
      { deltaXyMm: 0.05, lateralDecayMm: 0.04 },
      { deltaXyMm: 0.02, lateralDecayMm: 0.15 },
    ]) {
      for (const target of [0.05, 0.2, 0.4, 0.8, 2]) {
        near(printedWidthMm(drawnWidthForMm(target, model), model), target, 1e-9);
      }
    }
  });
});

// ---------------------------------------------------------------------------

describe('compensateDesign', () => {
  it('returns the design itself when the profile changes nothing', () => {
    const nominal = design(single(), { splitType: 'monolithic' });
    const out = compensateDesign(nominal, makeProfile({ deltaXyMm: 0, deltaZMm: 0 }));
    assert.equal(out.graph, nominal.graph);
    assert.equal(out.chipParams, nominal.chipParams);
    assert.equal(out.drainageVents, nominal.drainageVents);
    assert.equal(out.ceilingRaiseMm, 0);
    assert.deepEqual(out.conflicts, []);
  });

  it('never modifies the nominal design', () => {
    const nominal = design(single([{ t: 0, widthMm: 0.4, heightMm: 0.3 }]), { splitType: 'monolithic' });
    const before = JSON.stringify(nominal);
    compensateDesign(nominal, makeProfile({ lateralDecayMm: 0.04 }));
    assert.equal(JSON.stringify(nominal), before);
  });

  it('widens a marker by twice the per-side offset and leaves its height', () => {
    // Hand check: 0.4 mm drawn, Δxy 0.05 per side → 0.5 mm.
    const out = compensateDesign(
      design(single([{ t: 0.5, widthMm: 0.4, heightMm: 0.3 }])),
      makeProfile(),
    );
    assert.deepEqual(out.graph.edges[0].dimensionPoints, [{ t: 0.5, widthMm: 0.5, heightMm: 0.3 }]);
    near(out.applied.widthIncreaseMm.min, 0.1);
    near(out.applied.widthIncreaseMm.max, 0.1);
  });

  it('gives an unmarked channel one marker carrying the corrected default', () => {
    // The default is 0.8 × 0.5 mm; the project default itself must not move.
    const nominal = design(single());
    const out = compensateDesign(nominal, makeProfile());
    assert.deepEqual(out.graph.edges[0].dimensionPoints, [{ t: 0, widthMm: 0.9, heightMm: 0.5 }]);
    assert.equal(out.chipParams.defaultChannelWidthMm, 0.8);

    const sample = getLoft(out.graph, out.chipParams).edges.get('e')?.samples[5];
    near(sample?.widthMm ?? 0, 0.9);
    near(sample?.heightMm ?? 0, 0.5);
  });

  it('corrects a taper along its whole length', () => {
    const nominal = design(
      single([
        { t: 0, widthMm: 0.3, heightMm: 0.4 },
        { t: 1, widthMm: 1.1, heightMm: 0.4 },
      ]),
    );
    const profile = makeProfile({ lateralDecayMm: 0.06 });
    const out = compensateDesign(nominal, profile);

    const before = getLoft(nominal.graph, nominal.chipParams).edges.get('e')?.samples ?? [];
    const after = getLoft(out.graph, out.chipParams).edges.get('e')?.samples ?? [];
    assert.equal(after.length, before.length);
    assert.ok(out.graph.edges[0].dimensionPoints.length > 2, 'a non-linear correction adds markers');

    // Every station, not only the two the user marked, prints at its nominal
    // width to within a micron.
    const model = { deltaXyMm: 0.05, lateralDecayMm: 0.06 };
    for (let i = 0; i < before.length; i += 1) {
      near(printedWidthMm(after[i].widthMm, model), before[i].widthMm, 1e-3, `station ${i}`);
    }
    // And the narrow end got the larger correction.
    assert.ok(after[0].widthMm - before[0].widthMm > after.at(-1)!.widthMm - before.at(-1)!.widthMm);
  });

  it('corrects chambers and drainage vents, and leaves ports alone', () => {
    const graph: ChannelGraph = {
      nodes: [
        { id: 'in', x: 10, y: 30, type: 'port', portType: 'luer', diameterMm: 1.6, customSpec: { taperLargeDiameterMm: 4.27 } },
        { id: 'mid', x: 20, y: 30, type: 'chamber', shape: 'cylinder', sizeMm: 3, autoPlaced: false },
        { id: 'out', x: 30, y: 30, type: 'waypoint' },
      ],
      edges: [
        { id: 'e1', fromNodeId: 'in', toNodeId: 'mid', curveType: 'straight', crossSection: 'rect', dimensionPoints: [] },
        { id: 'e2', fromNodeId: 'mid', toNodeId: 'out', curveType: 'straight', crossSection: 'rect', dimensionPoints: [] },
      ],
    };
    const nominal = {
      ...design(graph),
      drainageVents: [{ id: 'v', nodeId: 'out', diameterMm: 0.8, autoPlaced: false }],
    };
    const out = compensateDesign(nominal, makeProfile());

    assert.deepEqual(out.graph.nodes[0], graph.nodes[0], 'port geometry stays nominal');
    assert.equal(out.graph.nodes[1].type === 'chamber' && out.graph.nodes[1].sizeMm, 3.1);
    near(out.drainageVents[0].diameterMm, 0.9);
  });

  it('snaps compensated widths to whole pixels when asked', () => {
    // 0.4 + 0.1 = 0.5 mm; at 35 µm per pixel the nearest whole count is 14 → 0.49 mm.
    const out = compensateDesign(
      design(single([{ t: 0, widthMm: 0.4, heightMm: 0.3 }])),
      makeProfile({ snapToPixelGrid: true }),
    );
    near(out.graph.edges[0].dimensionPoints[0].widthMm, 0.49);
    near(out.applied.snappedToPixelMm ?? 0, 0.035);
  });

  it('does not snap when the pixel size is unknown', () => {
    const out = compensateDesign(
      design(single([{ t: 0, widthMm: 0.4, heightMm: 0.3 }])),
      makeProfile({ snapToPixelGrid: true }, { xyPixelMicrons: null }),
    );
    near(out.graph.edges[0].dimensionPoints[0].widthMm, 0.5);
    assert.equal(out.applied.snappedToPixelMm, null);
  });

  it('raises ceilings only on a monolithic chip', () => {
    const profile = makeProfile({ deltaZMm: 0.12 });

    const mono = compensateDesign(design(single(), { splitType: 'monolithic' }), profile);
    assert.equal(mono.ceilingRaiseMm, 0.12);
    assert.equal(mono.applied.ceilingSkipped, null);

    const twoPiece = compensateDesign(design(single(), { splitType: 'two-piece' }), profile);
    assert.equal(twoPiece.ceilingRaiseMm, 0);
    assert.equal(twoPiece.applied.profileDeltaZMm, 0.12);
    assert.match(twoPiece.applied.ceilingSkipped ?? '', /open grooves/);

    const slide = compensateDesign(design(single(), { splitType: 'glass-slide' }), profile);
    assert.equal(slide.ceilingRaiseMm, 0);
    assert.match(slide.applied.ceilingSkipped ?? '', /glass slide/);
  });

  it('reports the per-side offset the profile applies at a width', () => {
    near(lateralOffsetAtMm(0.4, makeProfile()), 0.05);
    assert.ok(lateralOffsetAtMm(0.2, makeProfile({ lateralDecayMm: 0.05 })) > 0.05);
  });
});

// ---------------------------------------------------------------------------

describe('conflicts', () => {
  // Default channels are 0.8 mm wide; the wall limit is 0.4 mm (the smaller
  // wall thickness set here hands the decision to the printable minimum).
  const chip = { wallThickness: 0.3 };

  it('is silent when compensation leaves enough wall', () => {
    // 2.0 pitch − 0.9 = 1.1 mm of wall.
    const out = compensateDesign(design(parallelChannels(2), chip), makeProfile());
    assert.deepEqual(out.conflicts, []);
  });

  it('reports a wall pushed below the printable minimum, and by how much', () => {
    // Nominal wall 1.3 − 0.8 = 0.5 mm. Δxy 0.1 → 1.0 mm channels → 0.3 mm wall,
    // 0.1 mm short of the 0.4 mm minimum.
    const out = compensateDesign(design(parallelChannels(1.3), chip), makeProfile({ deltaXyMm: 0.1 }));
    assert.equal(out.conflicts.length, 1);
    const [conflict] = out.conflicts;
    assert.equal(conflict.kind, 'wall-too-thin');
    assert.deepEqual(conflict.edgeIds, ['ea', 'eb']);
    near(conflict.compensatedMm, 0.3);
    near(conflict.limitMm, 0.4);
    near(conflict.shortfallMm, 0.1);
    assert.match(conflict.message, /0\.3 mm of wall between segments ea and eb/);
    assert.match(conflict.message, /0\.1 mm short/);
  });

  it('reports two channels merging', () => {
    // Δxy 0.3 → 1.4 mm channels on a 1.3 mm pitch overlap by 0.1 mm.
    const out = compensateDesign(design(parallelChannels(1.3), chip), makeProfile({ deltaXyMm: 0.3 }));
    const merge = out.conflicts.find((c) => c.kind === 'channels-merge');
    assert.ok(merge, JSON.stringify(out.conflicts));
    near(merge.compensatedMm, -0.1);
    assert.match(merge.message, /overlap by 0\.1 mm/);
  });

  it('does not blame compensation for a wall that was already too thin and did not change', () => {
    // 0.3 mm of wall as drawn. A ceiling-only correction leaves it at 0.3.
    const out = compensateDesign(
      design(parallelChannels(1.1), { ...chip, splitType: 'monolithic' }),
      makeProfile({ deltaXyMm: 0, deltaZMm: 0.05 }),
    );
    assert.equal(out.conflicts.filter((c) => c.kind === 'wall-too-thin').length, 0);
  });

  it('reports an already-thin wall that compensation makes thinner, with both numbers', () => {
    const out = compensateDesign(design(parallelChannels(1.1), chip), makeProfile({ deltaXyMm: 0.05 }));
    const [conflict] = out.conflicts;
    assert.equal(conflict.kind, 'wall-too-thin');
    near(conflict.nominalMm ?? 0, 0.3);
    near(conflict.compensatedMm, 0.2);
    assert.match(conflict.message, /was 0\.3 mm/);
  });

  it('reports a channel pushed into the edge spacing', () => {
    const graph = parallelChannels(5);
    // 3.45 mm from the y = 0 edge to the channel wall as drawn; limit 3 mm.
    graph.nodes[0].y = 3.85;
    graph.nodes[1].y = 3.85;
    const out = compensateDesign(design(graph, chip), makeProfile({ deltaXyMm: 0.5 }));
    const edge = out.conflicts.find((c) => c.kind === 'edge-clearance');
    assert.ok(edge, JSON.stringify(out.conflicts));
    near(edge.nominalMm ?? 0, 3.45);
    near(edge.compensatedMm, 2.95);
    assert.match(edge.message, /2\.95 mm from the chip edge/);
    near(edge.shortfallMm, 0.05);
  });

  it('reports a raised ceiling that leaves too thin a roof', () => {
    // Block 4 mm, split 3.5 → a 0.5 mm roof over a rect channel. Raising 0.3
    // leaves 0.2 mm against a 0.3 mm wall thickness.
    const out = compensateDesign(
      design(single(), { splitType: 'monolithic', splitHeight: 3.5, wallThickness: 0.3 }),
      makeProfile({ deltaXyMm: 0, deltaZMm: 0.3 }),
    );
    assert.equal(out.conflicts.length, 1);
    const [conflict] = out.conflicts;
    assert.equal(conflict.kind, 'ceiling-too-thin');
    near(conflict.nominalMm ?? 0, 0.5);
    near(conflict.compensatedMm, 0.2);
    near(conflict.shortfallMm, 0.1);
    assert.deepEqual(conflict.edgeIds, ['e']);
  });

  it('reports a raised ceiling that breaks through the top face', () => {
    const out = compensateDesign(
      design(single(), { splitType: 'monolithic', splitHeight: 3.9, wallThickness: 0.3 }),
      makeProfile({ deltaXyMm: 0, deltaZMm: 0.2 }),
    );
    assert.equal(out.conflicts[0].kind, 'ceiling-breakthrough');
    assert.match(out.conflicts[0].message, /breaks through the top face/);
  });

  it('does not report a roof that was already broken through as drawn', () => {
    // A 1.2 mm round channel centred 0.4 mm under the top face pokes through
    // it before any correction. That is the design's own warning.
    const graph = single([{ t: 0, widthMm: 1.2 }]);
    graph.edges[0].crossSection = 'round';
    const out = compensateDesign(
      design(graph, { splitType: 'monolithic', splitHeight: 3.6, wallThickness: 0.3 }),
      makeProfile({ deltaXyMm: 0, deltaZMm: 0.1 }),
    );
    assert.deepEqual(out.conflicts, []);
  });

  it('still returns the compensated design when there are conflicts', () => {
    const out = compensateDesign(design(parallelChannels(1.3), chip), makeProfile({ deltaXyMm: 0.3 }));
    assert.ok(out.conflicts.length > 0);
    near(out.graph.edges[0].dimensionPoints[0].widthMm, 1.4);
  });
});

// ---------------------------------------------------------------------------

describe('the ceiling raise in the pipeline', () => {
  it('lifts a rectangular roof and leaves the floor', () => {
    const points = profilePoints('rect', 0.8, 0.5, 4, 0.1);
    assert.deepEqual(points.map((p) => p.v), [-0.25, 0.35, 0.35, -0.25]);
    assert.deepEqual(points.map((p) => p.u), [0.4, 0.4, -0.4, -0.4]);
  });

  it('stretches only the upper half of a round channel', () => {
    const points = profilePoints('round', 1, 0, 16, 0.2);
    near(Math.max(...points.map((p) => p.v)), 0.7);
    near(Math.min(...points.map((p) => p.v)), -0.5);
    near(Math.max(...points.map((p) => p.u)), 0.5);
  });

  it('is the nominal profile when the raise is zero', () => {
    for (const section of ['rect', 'trapezoid', 'round'] as const) {
      assert.deepEqual(profilePoints(section, 0.8, 0.5, 16, 0), profilePoints(section, 0.8, 0.5, 16));
    }
    assert.deepEqual(placeChannel('rect', 0.8, 0.5, 2, 0), placeChannel('rect', 0.8, 0.5, 2));
  });

  it('removes exactly the extra volume a compensated channel should', () => {
    // 20 mm of straight rect channel in a monolithic block, with a joint-free
    // graph so the swept prism is the whole cavity.
    const nominal = design(single(), { splitType: 'monolithic' });
    const out = compensateDesign(nominal, makeProfile({ deltaXyMm: 0.05, deltaZMm: 0.1 }));

    const before = buildChip(api, nominal.graph, nominal.chipParams, { quality: 2 });
    const after = buildChip(api, out.graph, out.chipParams, {
      quality: 2,
      ceilingRaiseMm: out.ceilingRaiseMm,
    });

    // Hand check: 0.8 × 0.5 → 0.9 × 0.6 over 20 mm.
    near(before.stats.channelVolumeMm3, 20 * 0.8 * 0.5, 1e-3);
    near(after.stats.channelVolumeMm3, 20 * 0.9 * 0.6, 1e-3);
    near(before.stats.chipVolumeMm3 - after.stats.chipVolumeMm3, 20 * (0.54 - 0.4), 1e-3);
  });

  it('raises the roof in the mesh, not the floor', () => {
    const nominal = design(single(), { splitType: 'monolithic' });
    const out = compensateDesign(nominal, makeProfile({ deltaXyMm: 0, deltaZMm: 0.1 }));
    const zRange = (raise: number) => {
      const built = buildChip(api, nominal.graph, nominal.chipParams, {
        includeChannelSolid: true,
        ceilingRaiseMm: raise,
      });
      const z = Array.from(built.channelSolid?.positions ?? []).filter((_, i) => i % 3 === 2);
      return [Math.min(...z), Math.max(...z)];
    };
    const [floor, roof] = zRange(0);
    const [floorAfter, roofAfter] = zRange(out.ceilingRaiseMm);
    near(floorAfter, floor, 1e-5);
    near(roofAfter, roof + 0.1, 1e-5);
  });

  it('extends joints and chambers upward with the channels', () => {
    const graph: ChannelGraph = {
      nodes: [
        { id: 'a', x: 10, y: 30, type: 'waypoint' },
        { id: 'b', x: 20, y: 30, type: 'chamber', shape: 'cylinder', sizeMm: 3, autoPlaced: false },
        { id: 'c', x: 20, y: 40, type: 'waypoint' },
        { id: 'd', x: 30, y: 40, type: 'waypoint' },
      ],
      edges: ['ab', 'bc', 'cd'].map((id) => ({
        id,
        fromNodeId: id[0],
        toNodeId: id[1],
        curveType: 'straight' as const,
        crossSection: 'rect' as const,
        dimensionPoints: [],
      })),
    };
    const chipParams = design(graph, { splitType: 'monolithic' }).chipParams;
    const top = (raise: number) => {
      const built = buildChip(api, graph, chipParams, { includeChannelSolid: true, ceilingRaiseMm: raise });
      const z = Array.from(built.channelSolid?.positions ?? []).filter((_, i) => i % 3 === 2);
      return { max: Math.max(...z), min: Math.min(...z), volume: built.stats.channelVolumeMm3 };
    };
    const before = top(0);
    const after = top(0.2);
    near(after.max, before.max + 0.2, 1e-5);
    near(after.min, before.min, 1e-5);
    assert.ok(after.volume > before.volume);
  });

  it('writes the same raise into the OpenSCAD source', () => {
    const nominal = design(single(), { splitType: 'monolithic' });
    const plain = exportScad(nominal.graph, nominal.chipParams);
    assert.equal(exportScad(nominal.graph, nominal.chipParams, { ceilingRaiseMm: 0 }), plain);

    const raised = exportScad(nominal.graph, nominal.chipParams, {
      ceilingRaiseMm: 0.1,
      headerNotes: ['Print correction: Bench printer'],
    });
    // 0.5 mm tall → 0.6 mm, centred 0.05 mm higher (1.75 → 1.8).
    assert.match(raised, /cube\(\[0\.01, 0\.8, 0\.6\], center = true\)/);
    assert.match(raised, /translate\(\[10\.0, 30\.0, 1\.8\]\)/);
    assert.match(raised, /\/\/ Print correction: Bench printer/);
    assert.doesNotMatch(plain, /Print correction/);
  });
});
