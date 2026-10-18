/**
 * Tests for the drawing editor's geometry and graph algorithms.
 *
 * These cover the parts where "it looked right on screen" is not good enough:
 * width interpolation across edge chains, curve-preserving splits, and the
 * array repeat that has to chain copies end-to-end.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { DEFAULT_CHIP_PARAMS } from './defaults';
import {
  buildAdjacency,
  cornerAngleDeg,
  distance,
  edgeCurve,
  edgesAtNode,
  edgesFrom,
  nodeIndex,
  splitCubic,
} from './geometry';
import {
  addChambersAtCorners,
  buildArrayRepeat,
  applyArrayRepeat,
  centerInChip,
  connect,
  deleteElements,
  designBoundsMm,
  detectCorners,
  distributeEvenly,
  extractFragment,
  findEdgeSpacingWarnings,
  fragmentEndpoints,
  makeEdge,
  makePort,
  makeWaypoint,
  nodeFootprintMm,
  segmentSizeRange,
  setSegmentsSize,
  spaceByIncrement,
  splitEdgeAt,
} from './graphOps';
import { hitTest, nodesInRect } from './hitTest';
import {
  END_T,
  buildChains,
  getLoft,
  chainMarkers,
  markerAtEdgeEnd,
  moveDimensionPoint,
  sizeAtDistance,
  sizeAtEdgeEnd,
  solveLoft,
  upsertDimensionPoint,
} from './loft';
import { resolveSnap, DEFAULT_SNAP_SETTINGS } from './snapping';
import { exportSchematicSvg } from './svgExport';
import type { ChannelGraph, ChannelNode } from '../types/project';

const defaults = DEFAULT_CHIP_PARAMS;

/** A straight run of `count` segments, 10 mm apart along +X. */
function straightRun(count: number): ChannelGraph {
  const nodes: ChannelNode[] = [];
  for (let i = 0; i <= count; i += 1) nodes.push(makeWaypoint({ x: i * 10, y: 0 }, `n${i}`));
  const edges = [];
  for (let i = 0; i < count; i += 1) {
    edges.push({ ...makeEdge(`n${i}`, `n${i + 1}`, defaults), id: `e${i}` });
  }
  return { nodes, edges };
}

/** An L: right along +X, then up along +Y — a single 90° corner. */
function elbow(): ChannelGraph {
  return {
    nodes: [
      makeWaypoint({ x: 0, y: 0 }, 'a'),
      makeWaypoint({ x: 10, y: 0 }, 'b'),
      makeWaypoint({ x: 10, y: 10 }, 'c'),
    ],
    edges: [
      { ...makeEdge('a', 'b', defaults), id: 'e1' },
      { ...makeEdge('b', 'c', defaults), id: 'e2' },
    ],
  };
}

// ---------------------------------------------------------------------------

describe('chains', () => {
  it('joins edges through degree-2 nodes into one chain', () => {
    const chains = buildChains(straightRun(3));
    assert.equal(chains.length, 1);
    assert.equal(chains[0].members.length, 3);
    assert.ok(Math.abs(chains[0].totalLengthMm - 30) < 0.01);
  });

  it('breaks a chain at a junction of three', () => {
    const graph = straightRun(2);
    graph.nodes.push(makeWaypoint({ x: 10, y: 10 }, 'branch'));
    graph.edges.push({ ...makeEdge('n1', 'branch', defaults), id: 'eb' });

    const chains = buildChains(graph);
    // n1 now has degree 3, so no chain may run through it.
    assert.equal(chains.length, 3);
    for (const chain of chains) assert.equal(chain.members.length, 1);
  });

  it('spans edges drawn in opposing directions', () => {
    // Both edges point *into* the shared middle node.
    const graph: ChannelGraph = {
      nodes: [
        makeWaypoint({ x: 0, y: 0 }, 'a'),
        makeWaypoint({ x: 10, y: 0 }, 'mid'),
        makeWaypoint({ x: 20, y: 0 }, 'c'),
      ],
      edges: [
        { ...makeEdge('a', 'mid', defaults), id: 'e1' },
        { ...makeEdge('c', 'mid', defaults), id: 'e2' },
      ],
    };

    const chains = buildChains(graph);
    assert.equal(chains.length, 1);
    assert.equal(chains[0].members.length, 2);
    assert.ok(Math.abs(chains[0].totalLengthMm - 20) < 0.01);
  });
});

// ---------------------------------------------------------------------------

describe('width interpolation', () => {
  it('holds constant outside the outermost markers rather than extrapolating', () => {
    const markers = [
      { distanceMm: 10, widthMm: 1, edgeId: 'e', t: 0.5 },
      { distanceMm: 20, widthMm: 2, edgeId: 'e', t: 0.5 },
    ];
    const fallback = { widthMm: 0.8, heightMm: 0.5 };

    // Extrapolating a 0.1 mm/mm slope backwards would drive width to zero and
    // then negative — the channel would vanish.
    assert.equal(sizeAtDistance(markers, 0, fallback).widthMm, 1);
    assert.equal(sizeAtDistance(markers, 100, fallback).widthMm, 2);
  });

  it('interpolates linearly between markers', () => {
    const markers = [
      { distanceMm: 0, widthMm: 1, edgeId: 'e', t: 0 },
      { distanceMm: 10, widthMm: 2, edgeId: 'e', t: 1 },
    ];
    const fallback = { widthMm: 0.8, heightMm: 0.5 };
    assert.ok(Math.abs(sizeAtDistance(markers, 5, fallback).widthMm - 1.5) < 1e-9);
    assert.ok(Math.abs(sizeAtDistance(markers, 2.5, fallback).widthMm - 1.25) < 1e-9);
  });

  it('tapers across an edge that carries no markers of its own', () => {
    // Three segments; markers only on the first and last. The middle segment
    // must still show the taper passing through it.
    const graph = straightRun(3);
    graph.edges[0].dimensionPoints = [{ t: 0, widthMm: 0.4 }];
    graph.edges[2].dimensionPoints = [{ t: 1, widthMm: 1.6 }];

    const solution = solveLoft(graph, defaults);
    const middle = solution.edges.get('e1');
    assert.ok(middle);

    const widths = middle.samples.map((s) => s.widthMm);
    const first = widths[0];
    const last = widths[widths.length - 1];

    // Strictly increasing across the unmarked middle segment.
    assert.ok(first > 0.4 && first < 1.6, `middle starts at ${first}`);
    assert.ok(last > first, `expected a rising taper, got ${first} → ${last}`);
    for (let i = 1; i < widths.length; i += 1) {
      assert.ok(widths[i] >= widths[i - 1] - 1e-9, 'width must not reverse mid-segment');
    }

    // At the halfway point of a 30 mm run it should be halfway between.
    const mid = widths[Math.floor(widths.length / 2)];
    assert.ok(Math.abs(mid - 1.0) < 0.05, `expected ~1.0 mm at mid-run, got ${mid}`);
  });

  it('flips marker position for edges running against the chain', () => {
    const graph: ChannelGraph = {
      nodes: [
        makeWaypoint({ x: 0, y: 0 }, 'a'),
        makeWaypoint({ x: 10, y: 0 }, 'mid'),
        makeWaypoint({ x: 20, y: 0 }, 'c'),
      ],
      edges: [
        { ...makeEdge('a', 'mid', defaults), id: 'e1' },
        // Reversed: drawn from c back to mid.
        { ...makeEdge('c', 'mid', defaults), id: 'e2', dimensionPoints: [{ t: 0, widthMm: 3 }] },
      ],
    };

    const chain = buildChains(graph)[0];
    const markers = chainMarkers(chain);
    assert.equal(markers.length, 1);
    // t=0 on the reversed edge is the far end of the chain, at 20 mm.
    assert.ok(Math.abs(markers[0].distanceMm - 20) < 0.01, `got ${markers[0].distanceMm}`);
  });

  it('uses the project default when an edge has no markers at all', () => {
    const solution = solveLoft(straightRun(1), defaults);
    const solved = solution.edges.get('e0');
    assert.ok(solved);
    for (const sample of solved.samples) {
      assert.equal(sample.widthMm, defaults.defaultChannelWidthMm);
    }
  });
});

// ---------------------------------------------------------------------------

/**
 * Pinning a segment's two ends is how the inspector makes a channel taper.
 *
 * The width fields there write markers at t=0 and t=1 through
 * `upsertDimensionPoint`, so these assert the behaviour those fields depend on
 * rather than the React that calls them.
 */
describe('segment end sizes', () => {
  const fallback = {
    widthMm: defaults.defaultChannelWidthMm,
    heightMm: defaults.defaultChannelHeightMm,
  };

  function pinned(startMm: number, endMm: number): ChannelGraph {
    const graph = straightRun(1);
    graph.edges[0].dimensionPoints = [
      { t: END_T.start, widthMm: startMm },
      { t: END_T.end, widthMm: endMm },
    ];
    return graph;
  }

  it('tapers between the two ends', () => {
    const solution = solveLoft(pinned(0.4, 1.2), defaults);
    assert.equal(sizeAtEdgeEnd(solution, 'e0', 'start', fallback).widthMm, 0.4);
    assert.equal(sizeAtEdgeEnd(solution, 'e0', 'end', fallback).widthMm, 1.2);

    // Strictly widening in between, which is what "tapers" has to mean.
    const widths = solution.edges.get('e0')?.samples.map((s) => s.widthMm) ?? [];
    assert.ok(widths.length > 2);
    for (let i = 1; i < widths.length; i += 1) {
      assert.ok(widths[i] >= widths[i - 1] - 1e-9, 'width must not reverse along the segment');
    }
    const mid = widths[Math.floor(widths.length / 2)];
    assert.ok(Math.abs(mid - 0.8) < 0.05, `expected ~0.8 mm mid-segment, got ${mid}`);
  });

  it('reads an unpinned end from the rest of the path rather than the default', () => {
    // Two segments, one marker on the far end of the second. The first
    // segment's ends carry no markers, so both must report that inherited
    // width — this is what stops the inspector showing a misleading default.
    const graph = straightRun(2);
    graph.edges[1].dimensionPoints = [{ t: END_T.end, widthMm: 1.5 }];

    const solution = solveLoft(graph, defaults);
    assert.equal(sizeAtEdgeEnd(solution, 'e0', 'start', fallback).widthMm, 1.5);
    assert.notEqual(fallback.widthMm, 1.5);
  });

  it('finds a marker at an end only when one is actually pinned there', () => {
    const points = pinned(0.4, 1.2).edges[0].dimensionPoints;
    assert.ok(markerAtEdgeEnd(points, 'start'));
    assert.ok(markerAtEdgeEnd(points, 'end'));
    assert.equal(markerAtEdgeEnd([{ t: 0.5, widthMm: 1 }], 'start'), undefined);
    assert.equal(markerAtEdgeEnd([{ t: 0.5, widthMm: 1 }], 'end'), undefined);
  });

  it('replaces the marker at an end instead of stacking a second one', () => {
    const points = upsertDimensionPoint(pinned(0.4, 1.2).edges[0].dimensionPoints, {
      t: END_T.start,
      widthMm: 0.9,
    });
    assert.equal(points.length, 2);
    assert.equal(markerAtEdgeEnd(points, 'start')?.widthMm, 0.9);
  });
});

// ---------------------------------------------------------------------------

/**
 * Sample density is what decides how faceted a curved channel comes out, and it
 * used to be capped at a flat 64 stations regardless of quality — so raising
 * the tier refined the rings around the channel without refining the path they
 * were strung along, and a long curve stayed faceted in the *exported* STL.
 *
 * These assert the properties that had to hold for that to be true, rather than
 * the station counts themselves, which are free to be retuned.
 */
describe('loft sample density', () => {
  /** A long enough run to have been clamped by the old fixed ceiling. */
  function longRun(): ChannelGraph {
    return {
      nodes: [makeWaypoint({ x: 0, y: 0 }, 'a'), makeWaypoint({ x: 120, y: 0 }, 'b')],
      edges: [{ ...makeEdge('a', 'b', defaults), id: 'e0' }],
    };
  }

  const stationsOf = (graph: ChannelGraph, quality: number) =>
    solveLoft(graph, defaults, quality).edges.get('e0')?.samples.length ?? 0;

  it('gives an export build more stations than a preview build', () => {
    const preview = stationsOf(longRun(), 1);
    const exported = stationsOf(longRun(), 2);
    assert.ok(
      exported > preview,
      `export quality must refine the path, got ${preview} → ${exported}`,
    );
  });

  it('holds a hairpin to a few degrees of turn per station', () => {
    // The guarantee worth asserting is angular, not a station count: the chord
    // between two stations departs from the arc it stands in for by about
    // rθ²/8, so bounding θ is what actually bounds the facet. A 180° hairpin
    // is the tightest thing a serpentine mixer draws.
    const hairpin: ChannelGraph = {
      nodes: [makeWaypoint({ x: 0, y: 0 }, 'a'), makeWaypoint({ x: 0, y: 4 }, 'b')],
      edges: [
        {
          ...makeEdge('a', 'b', defaults),
          id: 'e0',
          curveType: 'bezier',
          controlPoints: [
            { x: 12, y: 0 },
            { x: 12, y: 4 },
          ],
        },
      ],
    };

    const samples = solveLoft(hairpin, defaults, 1).edges.get('e0')?.samples ?? [];
    assert.ok(samples.length > 2);

    let worstDeg = 0;
    for (let i = 1; i < samples.length; i += 1) {
      const before = samples[i - 1].tangent;
      const after = samples[i].tangent;
      const delta = Math.abs(
        Math.atan2(after.y, after.x) - Math.atan2(before.y, before.x),
      );
      worstDeg = Math.max(worstDeg, (Math.min(delta, Math.PI * 2 - delta) * 180) / Math.PI);
    }

    assert.ok(worstDeg < 6, `worst turn between stations was ${worstDeg.toFixed(1)}°`);
  });

  it('still samples a very short edge enough to sweep it', () => {
    const stub: ChannelGraph = {
      nodes: [makeWaypoint({ x: 0, y: 0 }, 'a'), makeWaypoint({ x: 0.4, y: 0 }, 'b')],
      edges: [{ ...makeEdge('a', 'b', defaults), id: 'e0' }],
    };
    // Two stations is the minimum `sweepStations` accepts; the floor keeps a
    // stub well clear of that rather than at the edge of failing.
    assert.ok(stationsOf(stub, 1) >= 8, `got ${stationsOf(stub, 1)}`);
  });
});

// ---------------------------------------------------------------------------

describe('splitting a segment', () => {
  it('preserves the curve shape', () => {
    const graph = straightRun(1);
    graph.edges[0].curveType = 'bezier';
    graph.edges[0].controlPoints = [
      { x: 2, y: 6 },
      { x: 8, y: -6 },
    ];

    const nodes = nodeIndex(graph.nodes);
    const original = edgeCurve(graph.edges[0], { x: 0, y: 0 }, { x: 10, y: 0 });
    const [left, right] = splitCubic(original, 0.4);

    // The two halves must meet where the split happened.
    assert.ok(distance(left.p1, right.p0) < 1e-9);
    void nodes;

    const result = splitEdgeAt(graph, 'e0', 0.4);
    assert.ok(result);
    assert.equal(result.graph.edges.length, 2);
    assert.equal(result.graph.nodes.length, 3);

    const inserted = result.graph.nodes.find((n) => n.id === result.nodeId);
    assert.ok(inserted);
    assert.ok(distance({ x: inserted.x, y: inserted.y }, left.p1) < 1e-6);
  });

  it('keeps connectivity intact', () => {
    const result = splitEdgeAt(straightRun(1), 'e0', 0.5);
    assert.ok(result);
    const [first, second] = result.graph.edges;
    assert.equal(first.fromNodeId, 'n0');
    assert.equal(first.toNodeId, result.nodeId);
    assert.equal(second.fromNodeId, result.nodeId);
    assert.equal(second.toNodeId, 'n1');
  });

  it('redistributes dimension markers onto the correct half, rescaled', () => {
    const graph = straightRun(1);
    graph.edges[0].dimensionPoints = [
      { t: 0.2, widthMm: 1 },
      { t: 0.8, widthMm: 2 },
    ];

    const result = splitEdgeAt(graph, 'e0', 0.5);
    assert.ok(result);
    const [first, second] = result.graph.edges;

    assert.equal(first.dimensionPoints.length, 1);
    assert.equal(first.dimensionPoints[0].widthMm, 1);
    // t=0.2 of the whole is t=0.4 of the first half.
    assert.ok(Math.abs(first.dimensionPoints[0].t - 0.4) < 1e-6);

    assert.equal(second.dimensionPoints.length, 1);
    assert.equal(second.dimensionPoints[0].widthMm, 2);
    assert.ok(Math.abs(second.dimensionPoints[0].t - 0.6) < 1e-6);
  });
});

// ---------------------------------------------------------------------------

describe('corners and auto chambers', () => {
  it('measures a right-angle turn as 90°', () => {
    const graph = elbow();
    const angle = cornerAngleDeg(graph.edges, 'b', nodeIndex(graph.nodes));
    assert.ok(angle !== null);
    assert.ok(Math.abs(angle - 90) < 0.01, `got ${angle}`);
  });

  it('measures a straight-through node as 180°', () => {
    const graph = straightRun(2);
    const angle = cornerAngleDeg(graph.edges, 'n1', nodeIndex(graph.nodes));
    assert.ok(angle !== null);
    assert.ok(Math.abs(angle - 180) < 0.01, `got ${angle}`);
  });

  it('detects turns by threshold, ignoring straight-throughs', () => {
    const graph = elbow();
    assert.deepEqual(detectCorners(graph, 150), ['b']);
    // A threshold below the actual bend finds nothing.
    assert.deepEqual(detectCorners(graph, 45), []);
    // A straight run has no corners at any sane threshold.
    assert.deepEqual(detectCorners(straightRun(3), 150), []);
  });

  it('sizes auto chambers from the local channel width', () => {
    const { graph, added } = addChambersAtCorners(elbow(), defaults, {
      cornerThresholdDeg: 150,
      shape: 'sphere',
      multiple: 3,
    });

    assert.deepEqual(added, ['b']);
    const chamber = graph.nodes.find((n) => n.id === 'b');
    assert.ok(chamber && chamber.type === 'chamber');
    assert.equal(chamber.shape, 'sphere');
    assert.ok(Math.abs(chamber.sizeMm - defaults.defaultChannelWidthMm * 3) < 1e-9);
    assert.equal(chamber.autoPlaced, true);
  });

  it('leaves a hand-tuned chamber alone on re-run', () => {
    const first = addChambersAtCorners(elbow(), defaults, {
      cornerThresholdDeg: 150,
      shape: 'sphere',
      multiple: 3,
    });

    // User resizes it.
    const tuned: ChannelGraph = {
      ...first.graph,
      nodes: first.graph.nodes.map((n) =>
        n.id === 'b' && n.type === 'chamber' ? { ...n, sizeMm: 9.5 } : n,
      ),
    };

    const second = addChambersAtCorners(tuned, defaults, {
      cornerThresholdDeg: 150,
      shape: 'cylinder',
      multiple: 8,
    });

    assert.deepEqual(second.added, []);
    const chamber = second.graph.nodes.find((n) => n.id === 'b');
    assert.ok(chamber && chamber.type === 'chamber');
    assert.equal(chamber.sizeMm, 9.5, 'a tuned size must survive re-running auto placement');
  });
});

// ---------------------------------------------------------------------------

describe('array repeat', () => {
  it('recognises an unbranched run and rejects a branched one', () => {
    const run = extractFragment(straightRun(2), ['n0', 'n1', 'n2']);
    assert.ok(fragmentEndpoints(run));

    const branched = straightRun(2);
    branched.nodes.push(makeWaypoint({ x: 10, y: 10 }, 'branch'));
    branched.edges.push({ ...makeEdge('n1', 'branch', defaults), id: 'eb' });
    const fragment = extractFragment(branched, ['n0', 'n1', 'n2', 'branch']);
    assert.equal(fragmentEndpoints(fragment), null);
  });

  it('chains copies end to end with no gap', () => {
    const graph = straightRun(1); // 0,0 → 10,0
    const fragment = extractFragment(graph, ['n0', 'n1']);

    // `count` is the number of *additional* copies appended after the original.
    const preview = buildArrayRepeat(fragment, { count: 3, spacingMm: 0, alternate: false }, defaults);
    assert.ok(preview);

    const result = applyArrayRepeat(graph, preview);
    // Welded: each copy contributes one new node, not two, because its start
    // coincides with the previous copy's end.
    assert.equal(result.graph.nodes.length, 5);
    assert.equal(result.graph.edges.length, 4);

    const xs = result.graph.nodes.map((n) => n.x).sort((a, b) => a - b);
    assert.deepEqual(xs, [0, 10, 20, 30, 40]);
  });

  it('leaves a gap when spacing is set, bridging it with a segment', () => {
    const graph = straightRun(1);
    const fragment = extractFragment(graph, ['n0', 'n1']);

    const preview = buildArrayRepeat(fragment, { count: 2, spacingMm: 5, alternate: false }, defaults);
    assert.ok(preview);

    const result = applyArrayRepeat(graph, preview);
    const xs = result.graph.nodes.map((n) => n.x).sort((a, b) => a - b);
    // Original 0→10, gap to 15, copy to 25, gap to 30, copy to 40.
    assert.deepEqual(xs, [0, 10, 15, 25, 30, 40]);
    // Every copy is joined to the previous one.
    assert.equal(result.graph.edges.length, 5);
  });

  it('mirrors alternate copies, which is what makes a serpentine', () => {
    // A serpentine unit is a U: up, across, back down. Its chord runs along +X,
    // and the bulge is what alternation has to flip.
    const graph: ChannelGraph = {
      nodes: [
        makeWaypoint({ x: 0, y: 0 }, 'a'),
        makeWaypoint({ x: 0, y: 5 }, 'up'),
        makeWaypoint({ x: 10, y: 5 }, 'across'),
        makeWaypoint({ x: 10, y: 0 }, 'c'),
      ],
      edges: [
        { ...makeEdge('a', 'up', defaults), id: 'e1' },
        { ...makeEdge('up', 'across', defaults), id: 'e2' },
        { ...makeEdge('across', 'c', defaults), id: 'e3' },
      ],
    };

    const fragment = extractFragment(graph, ['a', 'up', 'across', 'c']);
    const preview = buildArrayRepeat(fragment, { count: 2, spacingMm: 0, alternate: true }, defaults);
    assert.ok(preview);

    const result = applyArrayRepeat(graph, preview);
    const ys = result.graph.nodes.map((n) => n.y);

    // The original bulges to +5. The first copy must fold to −5, and the
    // second must come back to +5 — that alternation is the serpentine.
    assert.ok(ys.some((y) => y > 4.9), `expected an upward bulge, got ${JSON.stringify(ys)}`);
    assert.ok(ys.some((y) => y < -4.9), `expected a downward fold, got ${JSON.stringify(ys)}`);

    // Second copy returns to the original side.
    const folds = result.graph.nodes.filter((n) => Math.abs(n.y) > 4.9);
    assert.ok(folds.length >= 6, 'each of the three units contributes two bulge nodes');

    // And it must remain a single connected chain.
    assert.equal(buildChains(result.graph).length, 1);
  });

  it('marches straight ahead when alternation is off', () => {
    const graph: ChannelGraph = {
      nodes: [
        makeWaypoint({ x: 0, y: 0 }, 'a'),
        makeWaypoint({ x: 0, y: 5 }, 'up'),
        makeWaypoint({ x: 10, y: 5 }, 'across'),
        makeWaypoint({ x: 10, y: 0 }, 'c'),
      ],
      edges: [
        { ...makeEdge('a', 'up', defaults), id: 'e1' },
        { ...makeEdge('up', 'across', defaults), id: 'e2' },
        { ...makeEdge('across', 'c', defaults), id: 'e3' },
      ],
    };

    const fragment = extractFragment(graph, ['a', 'up', 'across', 'c']);
    const preview = buildArrayRepeat(fragment, { count: 2, spacingMm: 0, alternate: false }, defaults);
    assert.ok(preview);

    const result = applyArrayRepeat(graph, preview);
    // Every bulge stays on the same side.
    assert.ok(result.graph.nodes.every((n) => n.y >= -1e-9));
  });

  it('produces a connected result — every copy reachable from the original', () => {
    const graph = straightRun(1);
    const fragment = extractFragment(graph, ['n0', 'n1']);
    const preview = buildArrayRepeat(fragment, { count: 4, spacingMm: 0, alternate: false }, defaults);
    assert.ok(preview);

    const result = applyArrayRepeat(graph, preview);

    const adjacency = new Map<string, string[]>();
    for (const edge of result.graph.edges) {
      adjacency.set(edge.fromNodeId, [...(adjacency.get(edge.fromNodeId) ?? []), edge.toNodeId]);
      adjacency.set(edge.toNodeId, [...(adjacency.get(edge.toNodeId) ?? []), edge.fromNodeId]);
    }

    const seen = new Set<string>(['n0']);
    const queue = ['n0'];
    while (queue.length > 0) {
      const current = queue.pop() as string;
      for (const next of adjacency.get(current) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }

    assert.equal(seen.size, result.graph.nodes.length, 'the repeated run must be one chain');
    // And the loft solver must see it as a single chain too.
    assert.equal(buildChains(result.graph).length, 1);
  });
});

// ---------------------------------------------------------------------------

describe('spacing tools', () => {
  it('distributes interior nodes evenly between the outermost two', () => {
    const graph: ChannelGraph = {
      nodes: [
        makeWaypoint({ x: 0, y: 0 }, 'a'),
        makeWaypoint({ x: 3, y: 0 }, 'b'),
        makeWaypoint({ x: 4, y: 0 }, 'c'),
        makeWaypoint({ x: 12, y: 0 }, 'd'),
      ],
      edges: [],
    };

    const next = distributeEvenly(graph, ['a', 'b', 'c', 'd']);
    const xs = next.nodes.map((n) => n.x);
    assert.deepEqual(xs, [0, 4, 8, 12]);
  });

  it('places nodes at an exact increment from the anchor', () => {
    const graph: ChannelGraph = {
      nodes: [
        makeWaypoint({ x: 0, y: 0 }, 'a'),
        makeWaypoint({ x: 3, y: 0 }, 'b'),
        makeWaypoint({ x: 7, y: 0 }, 'c'),
      ],
      edges: [],
    };

    const next = spaceByIncrement(graph, ['a', 'b', 'c'], 2.5, 'x', 'first');
    assert.deepEqual(next.nodes.map((n) => n.x), [0, 2.5, 5]);
  });

  it('needs three nodes to distribute', () => {
    const graph: ChannelGraph = {
      nodes: [makeWaypoint({ x: 0, y: 0 }, 'a'), makeWaypoint({ x: 5, y: 0 }, 'b')],
      edges: [],
    };
    assert.deepEqual(distributeEvenly(graph, ['a', 'b']).nodes, graph.nodes);
  });
});

// ---------------------------------------------------------------------------

describe('snapping', () => {
  const nodes = [makeWaypoint({ x: 10, y: 10 }, 'target')];

  it('welds onto a nearby endpoint, in preference to the grid', () => {
    const result = resolveSnap(
      { x: 10.3, y: 10.2 },
      DEFAULT_SNAP_SETTINGS,
      { candidates: nodes, toleranceMm: 1, origin: null },
    );
    assert.equal(result.kind, 'endpoint');
    assert.equal(result.nodeId, 'target');
    assert.deepEqual(result.point, { x: 10, y: 10 });
  });

  it('never welds onto the node being dragged', () => {
    const result = resolveSnap(
      { x: 10.1, y: 10.1 },
      DEFAULT_SNAP_SETTINGS,
      { candidates: nodes, exclude: new Set(['target']), toleranceMm: 1, origin: null },
    );
    assert.notEqual(result.kind, 'endpoint');
  });

  it('locks direction to the angle increment while keeping cursor distance', () => {
    const origin = { x: 0, y: 0 };
    // ~20° out, close to the 15° increment.
    const raw = { x: 10 * Math.cos(0.35), y: 10 * Math.sin(0.35) };

    const result = resolveSnap(
      raw,
      { ...DEFAULT_SNAP_SETTINGS, gridEnabled: false, angleStepDeg: 15 },
      { candidates: [], origin, toleranceMm: 2 },
    );

    assert.equal(result.kind, 'angle');
    assert.equal(result.angleDeg, 15);
    // Length is preserved — angle snapping constrains direction, not distance.
    assert.ok(Math.abs(Math.hypot(result.point.x, result.point.y) - 10) < 1e-6);
  });

  it('quantises length along the locked ray, so a vertical run is a round number', () => {
    // Regression: drawing straight up used to yield 9.875 mm — correct angle,
    // unusable number.
    const result = resolveSnap(
      { x: 0.06, y: 9.875 },
      { ...DEFAULT_SNAP_SETTINGS, gridMm: 1, angleStepDeg: 15 },
      { candidates: [], origin: { x: 0, y: 0 }, toleranceMm: 1 },
    );

    assert.equal(result.kind, 'angle');
    assert.equal(result.angleDeg, 90);
    assert.ok(Math.abs(result.point.x) < 1e-9, `x should be exactly 0, got ${result.point.x}`);
    assert.ok(Math.abs(result.point.y - 10) < 1e-9, `y should be exactly 10, got ${result.point.y}`);
  });

  it('keeps free length when the grid is off', () => {
    const result = resolveSnap(
      { x: 0.06, y: 9.875 },
      { ...DEFAULT_SNAP_SETTINGS, gridEnabled: false, angleStepDeg: 15 },
      { candidates: [], origin: { x: 0, y: 0 }, toleranceMm: 1 },
    );
    assert.equal(result.kind, 'angle');
    assert.ok(Math.abs(result.point.y - 9.875) < 0.01);
  });

  it('falls back to the grid when nothing else applies', () => {
    const result = resolveSnap(
      { x: 4.4, y: 7.7 },
      { ...DEFAULT_SNAP_SETTINGS, angleEnabled: false, gridMm: 1 },
      { candidates: [], origin: null, toleranceMm: 0.5 },
    );
    assert.equal(result.kind, 'grid');
    assert.deepEqual(result.point, { x: 4, y: 8 });
  });
});

// ---------------------------------------------------------------------------

describe('hit testing', () => {
  it('prefers a node over the edge running through it', () => {
    const graph = straightRun(1);
    const hit = hitTest(graph, { x: 0.1, y: 0.05 }, { toleranceMm: 1 });
    assert.equal(hit?.kind, 'node');
  });

  it('finds an edge when the cursor is between nodes', () => {
    const graph = straightRun(1);
    const hit = hitTest(graph, { x: 5, y: 0.2 }, { toleranceMm: 1 });
    assert.equal(hit?.kind, 'edge');
    if (hit?.kind === 'edge') assert.ok(Math.abs(hit.t - 0.5) < 0.05);
  });

  it('prefers a bezier handle over its own endpoint', () => {
    const graph = straightRun(1);
    graph.edges[0].curveType = 'bezier';
    graph.edges[0].controlPoints = [
      { x: 0.3, y: 0.3 },
      { x: 8, y: 0 },
    ];

    const hit = hitTest(
      graph,
      { x: 0.3, y: 0.3 },
      { toleranceMm: 1, handlesForEdgeIds: new Set(['e0']) },
    );
    assert.equal(hit?.kind, 'handle');
  });

  it('returns nothing in empty space', () => {
    assert.equal(hitTest(straightRun(1), { x: 5, y: 50 }, { toleranceMm: 1 }), null);
  });

  describe('a marker pinned to the end of a segment', () => {
    // Tapering a segment from the inspector pins a marker at t = 0 and t = 1,
    // which puts it exactly on top of that segment's node. Whichever wins there
    // is the only thing reachable — and the select tool cannot drag a marker,
    // so letting the marker win made the node impossible to grab or move. That
    // is the "I tapered it and then could not move anything" report.
    const tapered = () => {
      const graph = straightRun(1);
      graph.edges[0].dimensionPoints = [
        { t: 0, widthMm: 0.4, heightMm: 0.4 },
        { t: 1, widthMm: 1.2, heightMm: 0.8 },
      ];
      return graph;
    };
    const onTheNode = { x: 0, y: 0 };

    it('still lets the select tool grab the node underneath', () => {
      const hit = hitTest(tapered(), onTheNode, {
        toleranceMm: 1,
        includeDimensionMarkers: true,
        markersOutrankNodes: false,
      });
      assert.equal(hit?.kind, 'node');
    });

    it('still wins for the dimension tool, which is the only one that drags it', () => {
      const hit = hitTest(tapered(), onTheNode, {
        toleranceMm: 1,
        includeDimensionMarkers: true,
        markersOutrankNodes: true,
      });
      assert.equal(hit?.kind, 'dimension');
    });

    it('is still found mid-segment, where no node competes', () => {
      const graph = straightRun(1);
      graph.edges[0].dimensionPoints = [{ t: 0.5, widthMm: 0.8 }];
      const hit = hitTest(graph, { x: 5, y: 0 }, {
        toleranceMm: 1,
        includeDimensionMarkers: true,
        markersOutrankNodes: false,
      });
      assert.equal(hit?.kind, 'dimension');
    });
  });

  it('marquee selects only nodes inside the rectangle', () => {
    const graph = straightRun(3); // nodes at x = 0,10,20,30
    const inside = nodesInRect(graph, { x: -1, y: -1, width: 22, height: 2 });
    assert.deepEqual(inside.sort(), ['n0', 'n1', 'n2']);
  });
});

// ---------------------------------------------------------------------------

describe('deletion', () => {
  it('removes edges left dangling by a deleted node', () => {
    const next = deleteElements(straightRun(2), ['n1']);
    assert.equal(next.nodes.length, 0, 'orphaned waypoints are swept up too');
    assert.equal(next.edges.length, 0);
  });

  it('keeps the far side of the graph intact', () => {
    const graph = straightRun(3);
    const next = deleteElements(graph, ['n3']);
    assert.equal(next.edges.length, 2);
    assert.ok(next.nodes.some((n) => n.id === 'n0'));
    assert.ok(!next.nodes.some((n) => n.id === 'n3'));
  });
});

// ---------------------------------------------------------------------------

describe('edge spacing warnings', () => {
  it('flags a node closer to the boundary than minEdgeSpacing, without blocking', () => {
    const graph: ChannelGraph = {
      nodes: [makeWaypoint({ x: 1, y: 30 }, 'close'), makeWaypoint({ x: 20, y: 30 }, 'fine')],
      edges: [],
    };

    const warnings = findEdgeSpacingWarnings(
      graph,
      { width: 40, length: 60, minEdgeSpacing: 3 },
      () => 0.8,
    );

    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].nodeId, 'close');
    assert.equal(warnings[0].outside, false);
  });

  it('marks a node beyond the chip edge as outside', () => {
    const graph: ChannelGraph = { nodes: [makeWaypoint({ x: -2, y: 30 }, 'off')], edges: [] };
    const warnings = findEdgeSpacingWarnings(
      graph,
      { width: 40, length: 60, minEdgeSpacing: 3 },
      () => 0.8,
    );
    assert.equal(warnings[0].outside, true);
  });

  it('measures a port against its boss footprint, not its bore', () => {
    // A luer boss is ~4.27 mm across but only 1.6 mm of bore; clearance has to
    // be judged on the part that actually collides.
    const graph: ChannelGraph = {
      nodes: [{ id: 'p', x: 4, y: 30, type: 'port', portType: 'luer', diameterMm: 1.6 }],
      edges: [],
    };

    const byBore = findEdgeSpacingWarnings(graph, { width: 40, length: 60, minEdgeSpacing: 3 }, () => 1.6);
    const byBoss = findEdgeSpacingWarnings(graph, { width: 40, length: 60, minEdgeSpacing: 3 }, () => 4.27);

    assert.equal(byBore.length, 0);
    assert.equal(byBoss.length, 1);
  });
});

// ---------------------------------------------------------------------------

describe('centering in the chip', () => {
  /** Middle of what the design occupies, footprint and all. */
  const middleOf = (graph: ChannelGraph, nodeIds?: string[]) => {
    const bounds = designBoundsMm(graph, defaults, nodeIds);
    assert.ok(bounds, 'expected bounds');
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  };

  const near = (actual: number, expected: number, tolerance = 1e-6) =>
    assert.ok(
      Math.abs(actual - expected) <= tolerance,
      `expected ${actual} to be within ${tolerance} of ${expected}`,
    );

  it('moves a design to the middle of the chip', () => {
    const { graph, deltaMm } = centerInChip(straightRun(3), defaults);

    // 0..30 along X, on y = 0: half the chip's width less its own midpoint.
    near(deltaMm.x, defaults.width / 2 - 15);
    near(deltaMm.y, defaults.length / 2);

    const middle = middleOf(graph);
    near(middle.x, defaults.width / 2);
    near(middle.y, defaults.length / 2);
  });

  it('leaves a centered design exactly alone', () => {
    const once = centerInChip(straightRun(3), defaults);
    const twice = centerInChip(once.graph, defaults);

    assert.deepEqual(twice.deltaMm, { x: 0, y: 0 });
    // The same reference, so `updateGraph` pushes no undo entry for a no-op.
    assert.equal(twice.graph, once.graph);
  });

  it('counts a port at its full width, not as a point', () => {
    // A luer-lock collar is 7.7 mm across against a 0.8 mm channel, so which
    // end carries the port decides where the middle of the design is.
    const withPort = makePort(straightRun(3), 'n0', 'luer-lock', 1.6);
    const centered = centerInChip(withPort, defaults).graph;

    assert.ok(nodeFootprintMm(centered.nodes[0], defaults) > 7);

    // Centered on the footprint: the margins either side match.
    const bounds = designBoundsMm(centered, defaults);
    assert.ok(bounds);
    near(bounds.x, defaults.width - (bounds.x + bounds.width), 1e-6);

    // And that is not where centering the bare coordinates would have put it.
    const first = centered.nodes.find((n) => n.id === 'n0');
    const last = centered.nodes.find((n) => n.id === 'n3');
    assert.ok(first && last);
    assert.ok(Math.abs((first.x + last.x) / 2 - defaults.width / 2) > 1);
  });

  it('follows a curve outside the box its endpoints make', () => {
    // Handles at y = 50 bow the segment up to y = 45 at its midpoint, well
    // clear of the y = 30 its two nodes sit on.
    const graph: ChannelGraph = {
      nodes: [makeWaypoint({ x: 10, y: 30 }, 'a'), makeWaypoint({ x: 30, y: 30 }, 'b')],
      edges: [
        {
          ...makeEdge('a', 'b', defaults),
          id: 'e1',
          curveType: 'bezier' as const,
          controlPoints: [
            { x: 10, y: 50 },
            { x: 30, y: 50 },
          ],
        },
      ],
    };

    const { graph: centered, deltaMm } = centerInChip(graph, defaults);

    // Nodes alone would already read as centered on Y; the bulge is what moves it.
    near(deltaMm.y, defaults.length / 2 - 37.5, 0.05);
    near(middleOf(centered).y, defaults.length / 2, 0.05);

    // Handles are absolute coordinates and have to travel with the segment.
    const edge = centered.edges[0];
    assert.ok(edge.controlPoints);
    near(edge.controlPoints[0].y, 50 + deltaMm.y, 1e-6);
  });

  it('centers only the selection, leaving everything else put', () => {
    const graph: ChannelGraph = {
      nodes: [
        makeWaypoint({ x: 0, y: 0 }, 'a'),
        makeWaypoint({ x: 4, y: 0 }, 'b'),
        makeWaypoint({ x: 35, y: 55 }, 'far'),
      ],
      edges: [{ ...makeEdge('a', 'b', defaults), id: 'e1' }],
    };

    const centered = centerInChip(graph, defaults, ['a', 'b']).graph;

    const far = centered.nodes.find((n) => n.id === 'far');
    assert.deepEqual({ x: far?.x, y: far?.y }, { x: 35, y: 55 });

    const middle = middleOf(centered, ['a', 'b']);
    near(middle.x, defaults.width / 2);
    near(middle.y, defaults.length / 2);
  });

  it('does nothing with an empty graph or an empty selection', () => {
    const empty: ChannelGraph = { nodes: [], edges: [] };
    assert.equal(designBoundsMm(empty, defaults), null);
    assert.equal(centerInChip(empty, defaults).graph, empty);

    const run = straightRun(2);
    assert.equal(centerInChip(run, defaults, []).graph, run);
  });
});

// ---------------------------------------------------------------------------

describe('SVG export', () => {
  it('produces a well-formed document sized to the chip', () => {
    const graph = elbow();
    const svg = exportSchematicSvg(graph, DEFAULT_CHIP_PARAMS, { pixelsPerMm: 8, marginMm: 4 });

    // The XML declaration comes first so a standalone .svg file is read as
    // UTF-8 rather than Latin-1 (⌀ and × were coming back as mojibake).
    assert.ok(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
    assert.ok(svg.includes('<svg'));
    assert.ok(svg.trimEnd().endsWith('</svg>'));
    // 40 wide + 2×4 margin; height adds the footer band under the chip.
    assert.ok(svg.includes('viewBox="0 0 48 71.4"'), `got ${(svg.match(/viewBox="[^"]+"/) ?? [])[0]}`);
    assert.equal((svg.match(/<svg/g) ?? []).length, 1);
  });

  it('collapses repeated chambers into a legend instead of overprinting labels', () => {
    // Ten identical chambers labelled in place produce an unreadable smear.
    const graph = straightRun(9);
    const graphWithChambers: ChannelGraph = {
      ...graph,
      nodes: graph.nodes.map((n, i) =>
        i > 0 && i < 9
          ? { id: n.id, x: n.x, y: n.y, type: 'chamber' as const, shape: 'sphere' as const, sizeMm: 2.4, autoPlaced: true }
          : n,
      ),
    };

    const svg = exportSchematicSvg(graphWithChambers, DEFAULT_CHIP_PARAMS);
    // An inline label is the whole text node; the legend row has a "N × ⌀"
    // prefix, so anchoring on the tag boundary tells them apart.
    const inline = (svg.match(/>2\.4 mm sphere</g) ?? []).length;
    assert.equal(inline, 0, 'identical chambers must not each carry an inline label');
    assert.ok(svg.includes('8 × ⌀2.4 mm sphere chambers'), 'expected a legend row');
  });

  it('still labels a lone chamber in place', () => {
    const graph = elbow();
    graph.nodes[1] = { id: 'b', x: 10, y: 0, type: 'chamber', shape: 'cylinder', sizeMm: 3, autoPlaced: false };
    const svg = exportSchematicSvg(graph, DEFAULT_CHIP_PARAMS);
    assert.ok(svg.includes('3 mm cylinder'), 'a single chamber is worth labelling inline');
  });

  it('includes the channels, ports and chambers that are on screen', () => {
    const graph = elbow();
    graph.nodes[0] = { id: 'a', x: 0, y: 0, type: 'port', portType: 'luer', diameterMm: 1.6 };
    graph.nodes[2] = { id: 'c', x: 10, y: 10, type: 'chamber', shape: 'sphere', sizeMm: 2.4, autoPlaced: true };

    const svg = exportSchematicSvg(graph, DEFAULT_CHIP_PARAMS);
    assert.ok(svg.includes('luer'), 'port label');
    assert.ok(svg.includes('sphere'), 'chamber label');
    assert.ok(svg.includes('<path'), 'channel geometry');
  });

  it('annotates dimension markers', () => {
    const graph = straightRun(1);
    graph.edges[0].dimensionPoints = [{ t: 0.5, widthMm: 1.25 }];
    const svg = exportSchematicSvg(graph, DEFAULT_CHIP_PARAMS, { showDimensions: true });
    assert.ok(svg.includes('1.25 mm'), 'the marker width should be annotated');
  });

  it('escapes the title rather than injecting markup', () => {
    const svg = exportSchematicSvg(straightRun(1), DEFAULT_CHIP_PARAMS, {
      title: 'chip <script>alert(1)</script> & co',
    });
    assert.ok(!svg.includes('<script>'));
    assert.ok(svg.includes('&lt;script&gt;'));
    assert.ok(svg.includes('&amp; co'));
  });
});

describe('connecting nodes', () => {
  const graph: ChannelGraph = {
    nodes: [makeWaypoint({ x: 0, y: 0 }), makeWaypoint({ x: 10, y: 0 })],
    edges: [],
  };

  it('links two nodes that exist', () => {
    const next = connect(graph, graph.nodes[0].id, graph.nodes[1].id, defaults);
    assert.equal(next.edges.length, 1);
  });

  it('refuses an edge to a node that is gone', () => {
    // The draw tool's last node, undone out from under it.
    assert.equal(connect(graph, 'undone-node', graph.nodes[1].id, defaults), graph);
    assert.equal(connect(graph, graph.nodes[0].id, 'undone-node', defaults), graph);
  });
});

describe('the shared loft cache', () => {
  const graph: ChannelGraph = {
    nodes: [makeWaypoint({ x: 0, y: 0 }), makeWaypoint({ x: 10, y: 0 })],
    edges: [],
  };
  graph.edges.push(makeEdge(graph.nodes[0].id, graph.nodes[1].id, defaults));

  it('solves a graph once for the same inputs', () => {
    assert.equal(getLoft(graph, defaults), getLoft(graph, defaults));
  });

  it('solves again for a new graph object, a new default size or a new quality', () => {
    const first = getLoft(graph, defaults);
    assert.notEqual(getLoft({ ...graph }, defaults), first);
    assert.notEqual(getLoft(graph, { ...defaults, defaultChannelWidthMm: 1.3 }), first);
    assert.notEqual(getLoft(graph, defaults, 2), first);
  });
});

describe('the shared adjacency map', () => {
  it('lists the same edges, in the same order, as scanning per node', () => {
    const graph = straightRun(4);
    // A branch off n2 and an isolated node, so degrees 0 to 3 are all present.
    graph.nodes.push(makeWaypoint({ x: 20, y: 10 }, 'branch'), makeWaypoint({ x: 99, y: 99 }, 'lone'));
    graph.edges.push({ ...makeEdge('branch', 'n2', defaults), id: 'eb' });

    const adjacency = buildAdjacency(graph.edges);
    for (const node of graph.nodes) {
      assert.deepEqual(
        edgesFrom(adjacency, node.id).map((e) => e.id),
        edgesAtNode(graph.edges, node.id).map((e) => e.id),
        node.id,
      );
    }
    assert.equal(edgesFrom(adjacency, 'n2').length, 3);
    assert.equal(edgesFrom(adjacency, 'lone').length, 0);
  });
});

describe('dragging a dimension marker', () => {
  const markers = [
    { t: 0.2, widthMm: 1 },
    { t: 0.5, widthMm: 2 },
    { t: 0.8, widthMm: 3 },
  ];

  it('moves the marker it was given, not whichever one is nearest', () => {
    // Drag the middle marker right up to its neighbour at 0.8. Found by t, the
    // next frame could pick up the 0.8 marker instead.
    const next = moveDimensionPoint(markers, 1, 0.79);
    assert.deepEqual(
      next.map((m) => [m.t, m.widthMm]),
      [
        [0.2, 1],
        [0.78, 2],
        [0.8, 3],
      ],
    );
    const again = moveDimensionPoint(next, 1, 0.9);
    assert.equal(again[1].widthMm, 2, 'still the same marker, at the same index');
    assert.equal(again[1].t, 0.78);
  });

  it('never passes a neighbour, and runs to the ends when there is none', () => {
    assert.equal(moveDimensionPoint(markers, 1, 0.05)[1].t, 0.22);
    assert.equal(moveDimensionPoint(markers, 0, -1)[0].t, 0);
    assert.equal(moveDimensionPoint(markers, 2, 2)[2].t, 1);
  });

  it('stays put when its neighbours leave no room', () => {
    const tight = [
      { t: 0.5, widthMm: 1 },
      { t: 0.51, widthMm: 2 },
      { t: 0.52, widthMm: 3 },
    ];
    assert.equal(moveDimensionPoint(tight, 1, 0.9)[1].t, 0.51);
  });
});

describe('sizing several segments at once', () => {
  /** Three segments: a taper, one at the default, and one pinned wide. */
  function mixed(): ChannelGraph {
    const graph = straightRun(3);
    graph.edges[0].dimensionPoints = [
      { t: END_T.start, widthMm: 0.4, heightMm: 0.3 },
      { t: END_T.end, widthMm: 1.2, heightMm: 0.3 },
    ];
    graph.edges[2].dimensionPoints = [
      { t: END_T.start, widthMm: 2, heightMm: 0.3 },
      { t: END_T.end, widthMm: 2, heightMm: 0.3 },
    ];
    return graph;
  }
  const ids = ['e0', 'e1', 'e2'];

  it('reports the spread a note can warn about', () => {
    const range = segmentSizeRange(mixed(), ids, defaults);
    assert.ok(range);
    assert.ok(Math.abs(range.widthMm.min - 0.4) < 1e-9);
    assert.ok(Math.abs(range.widthMm.max - 2) < 1e-9);
    assert.equal(segmentSizeRange(mixed(), ['nope'], defaults), null);
  });

  it('makes every segment the new width along its whole length, tapers included', () => {
    const next = setSegmentsSize(mixed(), ids, { widthMm: 0.75 }, defaults);
    const range = segmentSizeRange(next, ids, defaults);
    assert.ok(range);
    assert.ok(Math.abs(range.widthMm.min - 0.75) < 1e-9);
    assert.ok(Math.abs(range.widthMm.max - 0.75) < 1e-9);
    // Width alone was asked for, so the pinned height is kept.
    assert.equal(next.edges[0].dimensionPoints[0].heightMm, 0.3);
  });

  it('leaves unlisted segments exactly as they were', () => {
    const before = mixed();
    const next = setSegmentsSize(before, ['e0', 'e1'], { widthMm: 0.75 }, defaults);
    assert.equal(next.edges[2], before.edges[2]);
  });

  it('gives round segments no height', () => {
    const graph = straightRun(2);
    graph.edges[0].crossSection = 'round';
    const next = setSegmentsSize(graph, ['e0', 'e1'], { widthMm: 0.6, heightMm: 0.4 }, defaults);
    assert.ok(next.edges[0].dimensionPoints.every((p) => p.heightMm === undefined));
    assert.ok(next.edges[1].dimensionPoints.every((p) => p.heightMm === 0.4));
  });
});
