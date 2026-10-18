/**
 * Validation tests.
 *
 * The central invariant, asserted first and repeatedly: validation reports and
 * never gates. There is no code path here that can return "you may not export".
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { DEFAULT_CHIP_PARAMS, PRINTER_PRESETS } from '../defaults';
import {
  DEFAULT_VALIDATION_SETTINGS,
  distanceToOpening,
  enclosureState,
  findDrainagePoints,
  runValidation,
  planDrainage,
  ventsForPoints,
  type Warning,
  type WarningKind,
} from './index';
import type { ChannelGraph, ChannelNode, ChipParams } from '../../types/project';

const printer = PRINTER_PRESETS[0].profile; // minFeatureSizeMm 0.2

const base = (overrides: Partial<ChipParams> = {}): ChipParams => ({
  ...DEFAULT_CHIP_PARAMS,
  ...overrides,
});

const wp = (id: string, x: number, y: number): ChannelNode => ({ id, x, y, type: 'waypoint' });
const port = (id: string, x: number, y: number): ChannelNode => ({
  id,
  x,
  y,
  type: 'port',
  portType: 'luer',
  diameterMm: 1.6,
});
const edge = (
  id: string,
  from: string,
  to: string,
  dimensionPoints: { t: number; widthMm: number; heightMm?: number }[] = [],
): ChannelGraph['edges'][number] => ({
  id,
  fromNodeId: from,
  toNodeId: to,
  curveType: 'straight',
  crossSection: 'rect',
  dimensionPoints,
});

const kinds = (warnings: Warning[]): WarningKind[] => warnings.map((w) => w.kind);
const has = (warnings: Warning[], kind: WarningKind) => warnings.some((w) => w.kind === kind);
const find = (warnings: Warning[], kind: WarningKind) => warnings.find((w) => w.kind === kind);

/**
 * The acceptance-criteria fixture: one channel below minFeatureSizeMm, one dead
 * end, and a monolithic split with an enclosed pocket.
 */
function deliberatelyBadChip(): { graph: ChannelGraph; chipParams: ChipParams } {
  const graph: ChannelGraph = {
    nodes: [
      port('inlet', 8, 10),
      wp('a', 8, 30),
      wp('b', 25, 30),
      port('outlet', 32, 50),
      // A branch that stops in the middle of the chip.
      wp('blind', 25, 45),
    ],
    edges: [
      // Far too narrow for a 0.2 mm printer.
      edge('too-narrow', 'inlet', 'a', [{ t: 0, widthMm: 0.05, heightMm: 0.05 }]),
      edge('mid', 'a', 'b'),
      edge('out', 'b', 'outlet'),
      edge('dead', 'b', 'blind'),
    ],
  };
  return { graph, chipParams: base({ splitType: 'monolithic' }) };
}

// ---------------------------------------------------------------------------

describe('the non-blocking guarantee', () => {
  it('never returns anything a caller could gate on', () => {
    const { graph, chipParams } = deliberatelyBadChip();
    const result = runValidation({ graph, chipParams, printerProfile: printer });

    // If these ever appear, something has started making validation
    // authoritative over user action, which OpenChip never allows.
    const shape = result as unknown as Record<string, unknown>;
    assert.equal(shape.isValid, undefined);
    assert.equal(shape.blocked, undefined);
    assert.equal(shape.canExport, undefined);
    assert.equal(shape.errors, undefined);

    assert.deepEqual(Object.keys(result).sort(), ['counts', 'warnings']);
  });

  it('reports problems without throwing on a hostile design', () => {
    const wild: ChannelGraph = {
      nodes: [wp('a', -500, -500), wp('b', 9000, 9000)],
      edges: [edge('e', 'a', 'b', [{ t: 0, widthMm: 0.0001 }])],
    };
    const result = runValidation({ graph: wild, chipParams: base(), printerProfile: printer });
    assert.ok(result.warnings.length > 0);
  });
});

// ---------------------------------------------------------------------------

describe('acceptance fixture — all three categories appear', () => {
  const { graph, chipParams } = deliberatelyBadChip();
  const result = runValidation({ graph, chipParams, printerProfile: printer });

  it('flags the sub-minimum-feature channel', () => {
    const warning = find(result.warnings, 'channel-below-min-feature');
    assert.ok(warning, `expected a min-feature warning, got ${kinds(result.warnings).join(', ')}`);
    assert.equal(warning.severity, 'risk');
    assert.equal(warning.measurement?.limit, printer.minFeatureSizeMm);
    assert.ok(warning.measurement!.value < printer.minFeatureSizeMm);
    assert.ok(warning.target.edgeIds.includes('too-narrow'));
  });

  it('merges segments that are undersized for the same reason', () => {
    // One marker governs a whole chain, so `too-narrow` and `mid` are both
    // 0.05 mm. Two identically-worded warnings read as a bug.
    const minFeature = result.warnings.filter((w) => w.kind === 'channel-below-min-feature');
    assert.equal(minFeature.length, 1, `expected one merged warning, got ${minFeature.length}`);
    assert.ok(minFeature[0].target.edgeIds.length > 1, 'and it should point at both segments');
    assert.match(minFeature[0].title, /segments/);
  });

  it('flags the dead-end branch and points at it', () => {
    const warning = find(result.warnings, 'dead-end-channel');
    assert.ok(warning, 'expected a dead-end warning');
    assert.ok(warning.target.nodeIds.includes('blind'));
    assert.ok(warning.target.focus, 'a clickable warning needs somewhere to jump to');
  });

  it('flags the enclosed monolithic cavity', () => {
    const warning = find(result.warnings, 'enclosed-cavity');
    assert.ok(warning, 'expected an enclosed-cavity warning');
    assert.match(warning.detail, /resin/i);
  });

  it('ranks risks above cautions above info', () => {
    const order = result.warnings.map((w) => w.severity);
    const rank = { risk: 0, caution: 1, info: 2 } as const;
    for (let i = 1; i < order.length; i += 1) {
      assert.ok(rank[order[i]] >= rank[order[i - 1]], 'warnings must come back worst-first');
    }
    assert.ok(result.counts.risk > 0);
  });

  it('gives every warning a target so the panel can be clickable', () => {
    for (const warning of result.warnings) {
      assert.ok(warning.target, `${warning.kind} has no target`);
      assert.ok(Array.isArray(warning.target.nodeIds));
      assert.ok(Array.isArray(warning.target.edgeIds));
    }
  });

  it('gives every warning a stable id across runs', () => {
    const again = runValidation({ graph, chipParams, printerProfile: printer });
    assert.deepEqual(
      result.warnings.map((w) => w.id).sort(),
      again.warnings.map((w) => w.id).sort(),
      'unstable ids would drop the user’s selection on every rebuild',
    );
  });
});

// ---------------------------------------------------------------------------

describe('manufacturability', () => {
  it('measures the narrowest point, not the average', () => {
    const graph: ChannelGraph = {
      nodes: [port('a', 10, 10), port('b', 30, 10)],
      edges: [
        edge('e', 'a', 'b', [
          { t: 0, widthMm: 0.1, heightMm: 0.5 },
          { t: 1, widthMm: 2, heightMm: 0.5 },
        ]),
      ],
    };
    const result = runValidation({ graph, chipParams: base(), printerProfile: printer });
    const warning = find(result.warnings, 'channel-below-min-feature');
    assert.ok(warning, 'a channel that is fine at one end and too thin at the other still fails');
    assert.ok(warning.measurement!.value < 0.2);
  });

  it('catches a rectangular channel that is too shallow even when it is wide', () => {
    const graph: ChannelGraph = {
      nodes: [port('a', 10, 10), port('b', 30, 10)],
      edges: [edge('e', 'a', 'b', [{ t: 0, widthMm: 3, heightMm: 0.02 }])],
    };
    const result = runValidation({ graph, chipParams: base(), printerProfile: printer });
    assert.ok(has(result.warnings, 'channel-below-min-feature'));
  });

  it('does not flag a healthy channel', () => {
    const graph: ChannelGraph = {
      nodes: [port('a', 10, 10), port('b', 30, 50)],
      edges: [edge('e', 'a', 'b')],
    };
    const result = runValidation({ graph, chipParams: base(), printerProfile: printer });
    assert.ok(!has(result.warnings, 'channel-below-min-feature'));
  });

  it('flags two channels that pass too close', () => {
    const graph: ChannelGraph = {
      nodes: [
        port('a1', 10, 10),
        port('a2', 30, 10),
        port('b1', 10, 10.3),
        port('b2', 30, 10.3),
      ],
      edges: [edge('a', 'a1', 'a2'), edge('b', 'b1', 'b2')],
    };
    const result = runValidation({ graph, chipParams: base(), printerProfile: printer });
    assert.ok(
      has(result.warnings, 'channels-too-close') || has(result.warnings, 'channels-overlap'),
    );
  });

  it('calls crossing channels an overlap, not a thin wall', () => {
    const graph: ChannelGraph = {
      nodes: [port('a1', 10, 10), port('a2', 30, 30), port('b1', 10, 30), port('b2', 30, 10)],
      edges: [edge('a', 'a1', 'a2'), edge('b', 'b1', 'b2')],
    };
    const result = runValidation({ graph, chipParams: base(), printerProfile: printer });
    const warning = find(result.warnings, 'channels-overlap');
    assert.ok(warning, 'an X crossing is two channels merged into one cavity');
    assert.equal(warning.severity, 'risk');
    assert.equal(warning.target.edgeIds.length, 2);
  });

  it('does not flag channels that legitimately meet at a node', () => {
    const graph: ChannelGraph = {
      nodes: [port('a', 10, 10), wp('mid', 20, 20), port('b', 30, 10)],
      edges: [edge('e1', 'a', 'mid'), edge('e2', 'mid', 'b')],
    };
    const result = runValidation({ graph, chipParams: base(), printerProfile: printer });
    assert.ok(!has(result.warnings, 'channels-overlap'));
    assert.ok(!has(result.warnings, 'channels-too-close'));
  });

  it('flags a chip larger than the build plate in either orientation', () => {
    const result = runValidation({
      graph: { nodes: [], edges: [] },
      chipParams: base({ width: 400, length: 400 }),
      printerProfile: printer,
    });
    assert.ok(has(result.warnings, 'footprint-exceeds-build-volume'));
  });

  it('does not flag a chip that merely needs rotating on the plate', () => {
    // 130 × 85 does not fit as-is on an 89 × 143 plate, but turned 90° it does.
    const result = runValidation({
      graph: { nodes: [], edges: [] },
      chipParams: base({ width: 130, length: 85 }),
      printerProfile: { ...printer, buildVolumeMm: { x: 89, y: 143, z: 175 } },
    });
    assert.ok(!has(result.warnings, 'footprint-exceeds-build-volume'));
  });

  it('notes that a luer-lock thread needs orientation care', () => {
    const graph: ChannelGraph = {
      nodes: [
        { id: 'p', x: 20, y: 20, type: 'port', portType: 'luer-lock', diameterMm: 1.6 },
        port('q', 20, 40),
      ],
      edges: [edge('e', 'p', 'q')],
    };
    const result = runValidation({ graph, chipParams: base(), printerProfile: printer });
    const warning = find(result.warnings, 'thread-support');
    assert.ok(warning);
    assert.equal(warning.severity, 'info', 'a note, not an obstacle');
  });

  it('flags a custom port that flares too fast to self-support', () => {
    const graph: ChannelGraph = {
      nodes: [
        {
          id: 'p',
          x: 20,
          y: 20,
          type: 'port',
          portType: 'custom',
          diameterMm: 0.5,
          customSpec: { outerDiameterMm: 12, depthMm: 1 },
        },
        port('q', 20, 40),
      ],
      edges: [edge('e', 'p', 'q')],
    };
    const result = runValidation({ graph, chipParams: base(), printerProfile: printer });
    assert.ok(has(result.warnings, 'port-overhang'));
  });
});

// ---------------------------------------------------------------------------

describe('flow feasibility', () => {
  it('flags a network with no ports at all', () => {
    const graph: ChannelGraph = {
      nodes: [wp('a', 10, 10), wp('b', 30, 30)],
      edges: [edge('e', 'a', 'b')],
    };
    const result = runValidation({ graph, chipParams: base(), printerProfile: printer });
    const warning = find(result.warnings, 'no-ports');
    assert.ok(warning);
    assert.equal(warning.severity, 'risk');
  });

  it('flags disconnected sub-networks', () => {
    const graph: ChannelGraph = {
      nodes: [port('a', 5, 5), port('b', 15, 5), port('c', 25, 40), port('d', 35, 40)],
      edges: [edge('e1', 'a', 'b'), edge('e2', 'c', 'd')],
    };
    const result = runValidation({ graph, chipParams: base(), printerProfile: printer });
    const warning = find(result.warnings, 'disconnected-network');
    assert.ok(warning);
    assert.match(warning.title, /2 separate pieces/);
  });

  it('flags a section that has only one port', () => {
    const graph: ChannelGraph = {
      nodes: [port('a', 5, 5), wp('b', 15, 5), wp('c', 25, 5)],
      edges: [edge('e1', 'a', 'b'), edge('e2', 'b', 'c')],
    };
    const result = runValidation({ graph, chipParams: base(), printerProfile: printer });
    assert.ok(result.warnings.some((w) => /only one port/i.test(w.title)));
  });

  it('accepts a clean two-port through-path', () => {
    const graph: ChannelGraph = {
      nodes: [port('a', 10, 10), wp('m', 20, 30), port('b', 30, 50)],
      edges: [edge('e1', 'a', 'm'), edge('e2', 'm', 'b')],
    };
    const result = runValidation({ graph, chipParams: base(), printerProfile: printer });
    assert.ok(!has(result.warnings, 'dead-end-channel'));
    assert.ok(!has(result.warnings, 'disconnected-network'));
    assert.ok(!has(result.warnings, 'no-ports'));
  });

  it('flags an abrupt taper above the configured ratio', () => {
    const graph: ChannelGraph = {
      nodes: [port('a', 10, 10), port('b', 30, 10)],
      edges: [
        edge('e', 'a', 'b', [
          { t: 0.45, widthMm: 0.4, heightMm: 0.4 },
          { t: 0.55, widthMm: 2.4, heightMm: 0.4 },
        ]),
      ],
    };
    const result = runValidation({ graph, chipParams: base(), printerProfile: printer });
    const warning = find(result.warnings, 'abrupt-taper');
    assert.ok(warning);
    // 2.4 / 0.4 is 5.999999999999999 in binary floating point.
    assert.ok(warning.measurement!.value > 5.9, `got ${warning.measurement!.value}`);
  });

  it('respects a raised taper threshold', () => {
    const graph: ChannelGraph = {
      nodes: [port('a', 10, 10), port('b', 30, 10)],
      edges: [
        edge('e', 'a', 'b', [
          { t: 0.4, widthMm: 0.5, heightMm: 0.4 },
          { t: 0.6, widthMm: 1.2, heightMm: 0.4 },
        ]),
      ],
    };
    const strict = runValidation({ graph, chipParams: base(), printerProfile: printer });
    const relaxed = runValidation({
      graph,
      chipParams: base(),
      printerProfile: printer,
      settings: { ...DEFAULT_VALIDATION_SETTINGS, taperRatioThreshold: 5 },
    });

    assert.ok(has(strict.warnings, 'abrupt-taper'));
    assert.ok(!has(relaxed.warnings, 'abrupt-taper'), 'the threshold must actually be configurable');
  });
});

// ---------------------------------------------------------------------------

describe('drainage', () => {
  it('treats monolithic as enclosed', () => {
    assert.equal(enclosureState(base({ splitType: 'monolithic' })).enclosed, true);
  });

  it('treats a normal two-piece split as open', () => {
    assert.equal(enclosureState(base({ splitType: 'two-piece', splitHeight: 2 })).enclosed, false);
  });

  it('catches the two-piece chip whose split plane misses the block', () => {
    // Easy to do by accident, and it silently prints as a sealed solid.
    const state = enclosureState(base({ splitType: 'two-piece', splitHeight: 9 }));
    assert.equal(state.enclosed, true);
    assert.match(state.reason, /outside/i);
  });

  it('measures distance to the nearest opening along the channels', () => {
    const graph: ChannelGraph = {
      nodes: [port('a', 0, 0), wp('b', 10, 0), wp('c', 20, 0)],
      edges: [edge('e1', 'a', 'b'), edge('e2', 'b', 'c')],
    };
    const dist = distanceToOpening(graph);
    assert.equal(dist.get('a'), 0);
    assert.ok(Math.abs((dist.get('b') ?? 0) - 10) < 1e-6);
    assert.ok(Math.abs((dist.get('c') ?? 0) - 20) < 1e-6);
  });

  it('reports unreachable nodes as infinitely far from an opening', () => {
    const graph: ChannelGraph = {
      nodes: [wp('a', 0, 0), wp('b', 10, 0)],
      edges: [edge('e', 'a', 'b')],
    };
    const dist = distanceToOpening(graph);
    assert.equal(dist.get('a'), Infinity);
  });

  it('picks dead ends and far corners as vent locations', () => {
    const { graph } = deliberatelyBadChip();
    const points = findDrainagePoints(graph);

    assert.ok(points.length > 0);
    assert.ok(points.some((p) => p.nodeId === 'blind' && p.reason === 'dead-end'));
    assert.ok(!points.some((p) => p.nodeId === 'inlet'), 'a port is already an opening');
  });

  it('never places a second vent on an already-vented node', () => {
    const { graph } = deliberatelyBadChip();
    const first = findDrainagePoints(graph);
    const vents = ventsForPoints(first);
    const second = findDrainagePoints(graph, vents);

    for (const point of second) {
      assert.ok(
        !vents.some((v) => v.nodeId === point.nodeId),
        'stacking vents on one node would drill the same hole twice',
      );
    }
  });

  it('plans the whole job in one pass, and that pass converges', () => {
    // Venting the worst spot shortens the escape path and exposes the
    // next-worst, so a single pass under-delivers — a "one-click" helper that
    // needs three clicks is not one-click.
    const { graph } = deliberatelyBadChip();

    const plan = planDrainage(graph);
    assert.ok(plan.length > findDrainagePoints(graph).length, 'the plan must go beyond one pass');

    // Nothing left to do afterwards.
    const remaining = findDrainagePoints(graph, ventsForPoints(plan));
    assert.equal(remaining.length, 0, 'the plan must leave the network fully drainable');

    // And no node appears twice.
    const ids = plan.map((p) => p.nodeId);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('plans nothing more once the network is already drained', () => {
    const { graph } = deliberatelyBadChip();
    const vents = ventsForPoints(planDrainage(graph));
    assert.deepEqual(planDrainage(graph, vents), []);
  });

  it('vents each island that has no opening whatsoever', () => {
    const graph: ChannelGraph = {
      nodes: [wp('a', 5, 5), wp('b', 15, 5), port('c', 25, 40), port('d', 35, 40)],
      edges: [edge('e1', 'a', 'b'), edge('e2', 'c', 'd')],
    };
    const points = findDrainagePoints(graph);
    assert.ok(points.some((p) => p.nodeId === 'a' || p.nodeId === 'b'));
    assert.ok(!points.some((p) => p.nodeId === 'c' || p.nodeId === 'd'));
  });

  it('says nothing about drainage when the chip is open', () => {
    const { graph } = deliberatelyBadChip();
    const result = runValidation({
      graph,
      chipParams: base({ splitType: 'two-piece', splitHeight: 2 }),
      printerProfile: printer,
    });
    assert.ok(!has(result.warnings, 'enclosed-cavity'));
  });

  it('softens the enclosed-cavity warning once vents are placed', () => {
    const { graph, chipParams } = deliberatelyBadChip();
    const before = find(
      runValidation({ graph, chipParams, printerProfile: printer }).warnings,
      'enclosed-cavity',
    );
    const after = find(
      runValidation({
        graph,
        chipParams,
        printerProfile: printer,
        drainageVents: ventsForPoints(findDrainagePoints(graph)),
      }).warnings,
      'enclosed-cavity',
    );

    assert.equal(before?.severity, 'caution');
    assert.equal(after?.severity, 'info');
    assert.match(after!.title, /vent/i);
  });

  it('ignores a vent whose node has been deleted', () => {
    const { graph, chipParams } = deliberatelyBadChip();
    const orphan = ventsForPoints([
      { nodeId: 'deleted-node', point: { x: 5, y: 5 }, reason: 'dead-end', distanceMm: 0 },
    ]);
    const warning = find(
      runValidation({ graph, chipParams, printerProfile: printer, drainageVents: orphan }).warnings,
      'enclosed-cavity',
    );

    assert.equal(warning?.severity, 'caution', 'an orphan vent was counted as drainage');
    assert.doesNotMatch(warning!.title, /vent/i);
  });
});

// ---------------------------------------------------------------------------

describe('glass-slide chips', () => {
  /** A chip that fits the standard slide, with one channel under it. */
  const slideChip = (overrides: Partial<ChipParams> = {}): ChipParams =>
    base({ splitType: 'glass-slide', width: 90, length: 40, ...overrides });

  const acrossTheSlide = (): ChannelGraph => ({
    nodes: [wp('a', 30, 20), wp('b', 60, 20)],
    edges: [edge('e1', 'a', 'b')],
  });

  it('says so when the slide does not fit the chip', () => {
    // The default 40 × 60 mm chip against a 75 × 25 mm slide: the case anyone
    // switching modes on a fresh project hits first.
    const warnings = runValidation({
      graph: acrossTheSlide(),
      chipParams: base({ splitType: 'glass-slide' }),
      printerProfile: printer,
    }).warnings;

    const fit = find(warnings, 'slide-does-not-fit');
    assert.ok(fit);
    assert.equal(fit.severity, 'risk');
    assert.match(fit.detail, /at least/);
  });

  it('says nothing about fit once the chip is big enough', () => {
    const warnings = runValidation({
      graph: acrossTheSlide(),
      chipParams: slideChip(),
      printerProfile: printer,
    }).warnings;

    assert.ok(!has(warnings, 'slide-does-not-fit'));
  });

  it('flags a port the glass would seal over', () => {
    const graph: ChannelGraph = {
      nodes: [port('under', 45, 20), wp('b', 60, 20)],
      edges: [edge('e1', 'under', 'b')],
    };

    const warnings = runValidation({
      graph,
      chipParams: slideChip(),
      printerProfile: printer,
    }).warnings;

    const covered = find(warnings, 'port-under-slide');
    assert.ok(covered);
    assert.equal(covered.severity, 'risk');
    assert.deepEqual(covered.target.nodeIds, ['under']);
  });

  it('leaves a port on the rim alone', () => {
    const graph: ChannelGraph = {
      nodes: [port('rim', 5, 20), wp('b', 60, 20)],
      edges: [edge('e1', 'rim', 'b')],
    };

    const warnings = runValidation({
      graph,
      chipParams: slideChip(),
      printerProfile: printer,
    }).warnings;

    assert.ok(!has(warnings, 'port-under-slide'));
    // The run out to it is still roofed, and that is the other check's job.
    assert.ok(has(warnings, 'channel-outside-slide'));
  });

  it('flags a segment that never passes under the slide', () => {
    const graph: ChannelGraph = {
      nodes: [wp('a', 3, 3), wp('b', 8, 3)],
      edges: [edge('e1', 'a', 'b')],
    };

    const warnings = runValidation({
      graph,
      chipParams: slideChip(),
      printerProfile: printer,
    }).warnings;

    const outside = find(warnings, 'channel-outside-slide');
    assert.ok(outside);
    assert.equal(outside.severity, 'risk');
    assert.equal(outside.measurement?.value, 100);
  });

  it('warns that a round channel prints as a half-round groove', () => {
    const graph = acrossTheSlide();
    graph.edges[0].crossSection = 'round';

    const warnings = runValidation({
      graph,
      chipParams: slideChip(),
      printerProfile: printer,
    }).warnings;

    const round = find(warnings, 'round-channel-under-slide');
    assert.ok(round);
    assert.match(round.detail, /half the area/);
  });

  it('counts the pocket as an opening rather than a sealed block', () => {
    const state = enclosureState(slideChip());
    assert.equal(state.enclosed, false);
    assert.match(state.reason, /pocket/);
  });

  it('reports on the slide even with nothing drawn yet', () => {
    const empty = runValidation({
      graph: { nodes: [], edges: [] },
      chipParams: base({ splitType: 'glass-slide' }),
      printerProfile: printer,
    });

    assert.ok(has(empty.warnings, 'slide-does-not-fit'));
  });

  it('says nothing at all about slides on any other split type', () => {
    for (const splitType of ['two-piece', 'monolithic'] as const) {
      const warnings = runValidation({
        graph: acrossTheSlide(),
        chipParams: base({ splitType, width: 90, length: 40 }),
        printerProfile: printer,
      }).warnings;

      assert.ok(!kinds(warnings).some((kind) => kind.includes('slide')));
    }
  });
});

describe('trapped resin volume', () => {
  const volumeFor = (crossSection: 'rect' | 'round') => {
    const graph: ChannelGraph = {
      nodes: [port('a', 0, 0), port('b', 10, 0)],
      edges: [{ ...edge('e', 'a', 'b', [{ t: 0, widthMm: 1, heightMm: 1 }]), crossSection }],
    };
    const result = runValidation({
      graph,
      chipParams: base({ splitType: 'monolithic' }),
      printerProfile: printer,
    });
    const detail = find(result.warnings, 'enclosed-cavity')?.detail ?? '';
    return Number(/Roughly ([\d.]+) mm³/.exec(detail)?.[1]);
  };

  it('counts a round channel by its circle, not its bounding square', () => {
    // 10 mm of 1 mm channel: 10 mm³ square, 10·π/4 ≈ 7.854 mm³ round.
    assert.equal(volumeFor('rect'), 10);
    assert.ok(Math.abs(volumeFor('round') - (10 * Math.PI) / 4) < 0.01, `got ${volumeFor('round')}`);
  });
});
