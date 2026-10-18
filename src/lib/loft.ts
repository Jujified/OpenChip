/**
 * Resolving channel width along a path from its dimension markers.
 *
 * The requirement that makes this non-trivial: a marker's influence does not
 * stop at the edge it sits on. If a user drops a 0.4 mm marker mid-way along
 * one segment and a 1.2 mm marker two segments later, the taper has to run
 * smoothly across the intervening segment — which carries no markers at all.
 *
 * So width is not solved per edge. It is solved per **chain**: the maximal run
 * of edges connected end-to-end through degree-2 nodes. Markers are projected
 * onto a single arc-length axis spanning the whole chain, and width at any point
 * is a linear interpolation between the neighbouring markers on that axis.
 *
 * The CSG sweep consumes exactly this, which is why it lives apart from
 * the canvas rather than inside the renderer.
 */

import {
  buildAdjacency,
  cubicLength,
  edgeCurve,
  nodeIndex,
  nodePoint,
  type Cubic,
} from './geometry';
import type {
  ChannelEdge,
  ChannelGraph,
  ChannelNode,
  ChipParams,
  DimensionPoint,
} from '../types/project';

// ---------------------------------------------------------------------------
// chains
// ---------------------------------------------------------------------------

/** One edge's placement within a chain's arc-length axis. */
export interface ChainMember {
  edge: ChannelEdge;
  curve: Cubic;
  /** True when the edge runs against the chain's direction of travel. */
  reversed: boolean;
  /** Arc length from the chain start to this edge's start, mm. */
  startDistance: number;
  lengthMm: number;
}

export interface Chain {
  members: ChainMember[];
  totalLengthMm: number;
}

/**
 * A node continues a chain only if exactly two edges meet there. Junctions of
 * three or more end a chain — width has no single meaning through a branch.
 */
function isPassThrough(nodeId: string, adjacency: Map<string, ChannelEdge[]>): boolean {
  return (adjacency.get(nodeId)?.length ?? 0) === 2;
}

/**
 * Partitions the graph into chains. Every edge lands in exactly one.
 *
 * Walking outward from a seed in both directions, rather than sweeping in edge
 * declaration order, is what lets a chain span edges that were drawn at
 * different times or in opposite directions.
 */
export function buildChains(graph: ChannelGraph): Chain[] {
  const nodes = nodeIndex(graph.nodes);
  const adjacency = buildAdjacency(graph.edges);
  const byId = new Map(graph.edges.map((edge) => [edge.id, edge]));
  const visited = new Set<string>();
  const chains: Chain[] = [];

  const otherEnd = (edge: ChannelEdge, nodeId: string) =>
    edge.fromNodeId === nodeId ? edge.toNodeId : edge.fromNodeId;

  /** Follows the chain from `startEdge` outward through `startNode`. */
  const walk = (startEdge: ChannelEdge, startNode: string): ChannelEdge[] => {
    const run: ChannelEdge[] = [];
    let currentEdge = startEdge;
    let currentNode = startNode;

    for (;;) {
      if (!isPassThrough(currentNode, adjacency)) break;
      const next = (adjacency.get(currentNode) ?? []).find((e) => e.id !== currentEdge.id);
      if (!next || visited.has(next.id)) break;
      visited.add(next.id);
      run.push(next);
      currentNode = otherEnd(next, currentNode);
      currentEdge = next;
    }

    return run;
  };

  for (const seed of graph.edges) {
    if (visited.has(seed.id)) continue;
    visited.add(seed.id);

    const backward = walk(seed, seed.fromNodeId).reverse();
    const forward = walk(seed, seed.toNodeId);
    const ordered = [...backward, seed, ...forward];

    // Orient each edge to the chain's direction of travel, so arc length
    // accumulates monotonically regardless of how each was drawn.
    const members: ChainMember[] = [];
    let cursor = 0;
    let joint: string | null = null;

    for (let i = 0; i < ordered.length; i += 1) {
      const edge = byId.get(ordered[i].id);
      if (!edge) continue;

      const from = nodes.get(edge.fromNodeId);
      const to = nodes.get(edge.toNodeId);
      if (!from || !to) continue;

      let reversed = false;
      if (joint === null) {
        // Seed the direction from the second edge, when there is one.
        const next = ordered[i + 1];
        if (next) reversed = edge.fromNodeId === next.fromNodeId || edge.fromNodeId === next.toNodeId;
      } else {
        reversed = edge.toNodeId === joint;
      }

      const curve = edgeCurve(edge, nodePoint(from), nodePoint(to));
      const lengthMm = cubicLength(curve);
      members.push({ edge, curve, reversed, startDistance: cursor, lengthMm });

      cursor += lengthMm;
      joint = reversed ? edge.fromNodeId : edge.toNodeId;
    }

    if (members.length > 0) chains.push({ members, totalLengthMm: cursor });
  }

  return chains;
}

// ---------------------------------------------------------------------------
// width along a chain
// ---------------------------------------------------------------------------

/** A dimension marker projected onto a chain's arc-length axis. */
export interface ChainMarker {
  /** Distance from the chain start, mm. */
  distanceMm: number;
  widthMm: number;
  heightMm?: number;
  edgeId: string;
  /** Parameter on the owning edge, kept so the canvas can draw the handle. */
  t: number;
}

/** Collects and orders every marker on a chain along its shared axis. */
export function chainMarkers(chain: Chain): ChainMarker[] {
  const markers: ChainMarker[] = [];

  for (const member of chain.members) {
    for (const dp of member.edge.dimensionPoints) {
      // A reversed edge's own t runs opposite the chain, so flip it.
      const local = member.reversed ? 1 - dp.t : dp.t;
      markers.push({
        distanceMm: member.startDistance + local * member.lengthMm,
        widthMm: dp.widthMm,
        heightMm: dp.heightMm,
        edgeId: member.edge.id,
        t: dp.t,
      });
    }
  }

  return markers.sort((a, b) => a.distanceMm - b.distanceMm);
}

export interface ChannelSize {
  widthMm: number;
  heightMm: number;
}

/**
 * Width and height at a distance along a chain.
 *
 * Outside the outermost markers the size holds constant rather than
 * extrapolating — running a taper off the end of the markers would silently
 * invent geometry the user never asked for, and could drive a channel to zero.
 */
export function sizeAtDistance(
  markers: ChainMarker[],
  distanceMm: number,
  fallback: ChannelSize,
): ChannelSize {
  if (markers.length === 0) return fallback;

  const first = markers[0];
  if (distanceMm <= first.distanceMm) {
    return { widthMm: first.widthMm, heightMm: first.heightMm ?? fallback.heightMm };
  }

  const last = markers[markers.length - 1];
  if (distanceMm >= last.distanceMm) {
    return { widthMm: last.widthMm, heightMm: last.heightMm ?? fallback.heightMm };
  }

  for (let i = 1; i < markers.length; i += 1) {
    const a = markers[i - 1];
    const b = markers[i];
    if (distanceMm > b.distanceMm) continue;

    const span = b.distanceMm - a.distanceMm;
    const t = span < 1e-9 ? 0 : (distanceMm - a.distanceMm) / span;
    return {
      widthMm: a.widthMm + (b.widthMm - a.widthMm) * t,
      heightMm:
        (a.heightMm ?? fallback.heightMm) +
        ((b.heightMm ?? fallback.heightMm) - (a.heightMm ?? fallback.heightMm)) * t,
    };
  }

  return fallback;
}

// ---------------------------------------------------------------------------
// solved view, for the canvas and the CSG sweep
// ---------------------------------------------------------------------------

/** One sample of the resolved channel: a centerline point and its local size. */
export interface LoftSample {
  point: { x: number; y: number };
  /** Unit tangent at this point. */
  tangent: { x: number; y: number };
  widthMm: number;
  heightMm: number;
  /** Distance along the owning chain, mm. */
  distanceMm: number;
}

export interface SolvedEdge {
  edgeId: string;
  samples: LoftSample[];
}

/** Everything the renderer needs, computed once per graph change. */
export interface LoftSolution {
  chains: Chain[];
  edges: Map<string, SolvedEdge>;
  /** Chain each edge belongs to, for marker lookups. */
  chainOfEdge: Map<string, Chain>;
}

const tangentOf = (curve: Cubic, t: number) => {
  // Import-free local copy to avoid a cycle; matches geometry.cubicTangentAt.
  const u = 1 - t;
  const a = 3 * u * u;
  const b = 6 * u * t;
  const c = 3 * t * t;
  const x =
    a * (curve.c0.x - curve.p0.x) + b * (curve.c1.x - curve.c0.x) + c * (curve.p1.x - curve.c1.x);
  const y =
    a * (curve.c0.y - curve.p0.y) + b * (curve.c1.y - curve.c0.y) + c * (curve.p1.y - curve.c1.y);
  const len = Math.hypot(x, y);
  return len < 1e-9 ? { x: 1, y: 0 } : { x: x / len, y: y / len };
};

const pointOf = (curve: Cubic, t: number) => {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * curve.p0.x + b * curve.c0.x + c * curve.c1.x + d * curve.p1.x,
    y: a * curve.p0.y + b * curve.c0.y + c * curve.c1.y + d * curve.p1.y,
  };
};

/** Probes used to measure how sharply a curve turns. */
const TURN_PROBES = 32;

/**
 * The sharpest turn between two adjacent probes on a uniform-`t` walk, in
 * radians.
 *
 * Deliberately the worst local rate rather than the total. Stations are placed
 * uniformly in `t`, and a cubic does not turn uniformly in `t` — on a hairpin
 * almost all of the bend happens around the apex while the ends barely move.
 * Sizing from the total assumes the turning is spread evenly and under-counts
 * badly exactly where it matters: a 180° hairpin sized that way still had 15°
 * between stations at its tip against a 4° budget.
 */
function worstTurnRate(curve: Cubic): number {
  let worst = 0;
  let previous = Math.atan2(tangentOf(curve, 0).y, tangentOf(curve, 0).x);

  for (let i = 1; i <= TURN_PROBES; i += 1) {
    const tangent = tangentOf(curve, i / TURN_PROBES);
    const angle = Math.atan2(tangent.y, tangent.x);
    let delta = angle - previous;
    // Shortest way round, so a curve crossing the ±π seam does not read as a
    // full turn.
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    worst = Math.max(worst, Math.abs(delta));
    previous = angle;
  }

  return worst;
}

/**
 * How far a station may turn from the one before it, at quality 1.
 *
 * The chord between two stations departs from the arc it stands in for by about
 * rθ²/8. At 6° over a 6 mm bend radius — a tight serpentine hairpin — that is
 * 8 µm, comfortably under the finest `xyResolutionMicrons` any printer profile
 * carries, so the facet disappears below what the machine can resolve rather
 * than merely below what looks acceptable on screen. Export quality halves it.
 */
const MAX_TURN_PER_STEP_RAD = (6 * Math.PI) / 180;

/**
 * Stations for one edge.
 *
 * Length alone used to decide this, hard-capped at a flat 64 — and because the
 * cap did not scale with quality, raising the tier refined the rings around the
 * channel without refining the path they were strung along. A long curve stayed
 * faceted in the *exported* STL, not just in the preview.
 */
function stationsFor(lengthMm: number, curve: Cubic, quality: number): number {
  const byLength = Math.ceil(lengthMm * 2 * quality);

  // Turning per step falls off as 1/steps, so scaling the probe count by how
  // far the worst probe overshoots the budget lands near it — near, not on:
  // the relationship is asymptotic and the probe walk only samples the peak
  // rather than finding it. A fifth again of headroom turns "about the budget"
  // into "inside it"; measured on a 180° hairpin it is the difference between
  // 6.2° and 5.2° against a 6° allowance.
  const TURN_HEADROOM = 1.2;
  const overshoot = worstTurnRate(curve) / (MAX_TURN_PER_STEP_RAD / quality);
  const byCurvature = Math.ceil(TURN_PROBES * overshoot * TURN_HEADROOM);

  const ceiling = Math.round(192 * quality);
  return Math.max(8, Math.min(ceiling, Math.max(byLength, byCurvature)));
}

const loftCache = new WeakMap<ChannelGraph, Map<string, LoftSolution>>();

/**
 * `solveLoft`, memoised on the graph object.
 *
 * One graph change used to be solved around eight times over — by the canvas,
 * the inspector, the bounds helper, each validation check and the fluid model —
 * every one of them with the same inputs. Graphs are never mutated (every
 * `graphOps` edit returns a new object), so identity is a sound key, and a
 * WeakMap lets old graphs and their solutions go together. The default channel
 * size and the quality are the only other inputs `solveLoft` reads.
 *
 * The result is shared: treat it as read-only.
 */
export function getLoft(
  graph: ChannelGraph,
  chipParams: Pick<ChipParams, 'defaultChannelWidthMm' | 'defaultChannelHeightMm'>,
  quality = 1,
): LoftSolution {
  const key = `${chipParams.defaultChannelWidthMm}|${chipParams.defaultChannelHeightMm}|${quality}`;
  let byParams = loftCache.get(graph);
  if (!byParams) {
    byParams = new Map();
    loftCache.set(graph, byParams);
  }
  let solved = byParams.get(key);
  if (!solved) {
    solved = solveLoft(graph, chipParams, quality);
    byParams.set(key, solved);
  }
  return solved;
}

/**
 * Solves the whole graph: chains, markers, and per-edge samples with local size.
 *
 * `quality` multiplies sample density: 1 for the live preview, 2 for an export
 * build. See `stationsFor` for what it actually drives.
 */
export function solveLoft(
  graph: ChannelGraph,
  chipParams: Pick<ChipParams, 'defaultChannelWidthMm' | 'defaultChannelHeightMm'>,
  quality = 1,
): LoftSolution {
  const fallback: ChannelSize = {
    widthMm: chipParams.defaultChannelWidthMm,
    heightMm: chipParams.defaultChannelHeightMm,
  };

  const chains = buildChains(graph);
  const edges = new Map<string, SolvedEdge>();
  const chainOfEdge = new Map<string, Chain>();

  for (const chain of chains) {
    const markers = chainMarkers(chain);

    for (const member of chain.members) {
      chainOfEdge.set(member.edge.id, chain);

      const steps = stationsFor(member.lengthMm, member.curve, quality);
      const samples: LoftSample[] = [];

      for (let i = 0; i <= steps; i += 1) {
        const t = i / steps;
        const along = member.reversed ? 1 - t : t;
        const distanceMm = member.startDistance + along * member.lengthMm;
        const size = sizeAtDistance(markers, distanceMm, fallback);

        samples.push({
          point: pointOf(member.curve, t),
          tangent: tangentOf(member.curve, t),
          widthMm: size.widthMm,
          heightMm: size.heightMm,
          distanceMm,
        });
      }

      edges.set(member.edge.id, { edgeId: member.edge.id, samples });
    }
  }

  return { chains, edges, chainOfEdge };
}

// ---------------------------------------------------------------------------
// marker placement
// ---------------------------------------------------------------------------

/** Local width at a point on an edge, used to seed a new marker's value. */
export function widthOnEdgeAt(
  solution: LoftSolution,
  edgeId: string,
  t: number,
  fallback: ChannelSize,
): ChannelSize {
  const solved = solution.edges.get(edgeId);
  if (!solved || solved.samples.length === 0) return fallback;

  const index = Math.round(t * (solved.samples.length - 1));
  const sample = solved.samples[Math.max(0, Math.min(solved.samples.length - 1, index))];
  return { widthMm: sample.widthMm, heightMm: sample.heightMm };
}

/** Which end of a segment, in the segment's own from → to direction. */
export type EdgeEnd = 'start' | 'end';

export const END_T: Record<EdgeEnd, number> = { start: 0, end: 1 };

/**
 * The resolved size at one end of a segment.
 *
 * Read off the solved samples rather than recomputed, so it reflects whatever
 * the chain actually produces there — an inherited width from a marker on a
 * neighbouring segment reads the same way a marker on this one does. That is
 * what lets the inspector show a real number for an end that carries no marker
 * of its own, instead of a blank the user has to guess at.
 */
export function sizeAtEdgeEnd(
  solution: LoftSolution,
  edgeId: string,
  end: EdgeEnd,
  fallback: ChannelSize,
): ChannelSize {
  const solved = solution.edges.get(edgeId);
  if (!solved || solved.samples.length === 0) return fallback;

  const sample = end === 'start' ? solved.samples[0] : solved.samples[solved.samples.length - 1];
  return { widthMm: sample.widthMm, heightMm: sample.heightMm };
}

/**
 * The solved sample at whichever end of `edge` touches `nodeId`.
 *
 * Anything placed *at* a node — a joint, a chamber, a port bore — has to be
 * sized from the channel as it is there, not as it is at the edge's arbitrary
 * start. Both exporters need this in three places each, and half of those had
 * drifted into reading `samples[0]` unconditionally, which put a chamber at the
 * far end's height whenever the channel tapered.
 */
export function sampleAtNode(
  solution: LoftSolution,
  edge: ChannelEdge,
  nodeId: string,
): LoftSample | undefined {
  const solved = solution.edges.get(edge.id);
  if (!solved || solved.samples.length === 0) return undefined;
  return edge.fromNodeId === nodeId ? solved.samples[0] : solved.samples[solved.samples.length - 1];
}

/** The marker pinning one end of a segment, if that end carries one. */
export function markerAtEdgeEnd(
  points: DimensionPoint[],
  end: EdgeEnd,
  tolerance = 0.02,
): DimensionPoint | undefined {
  return points.find((p) => Math.abs(p.t - END_T[end]) <= tolerance);
}

/** Inserts a marker in `t` order, replacing any already within `tolerance`. */
export function upsertDimensionPoint(
  points: DimensionPoint[],
  next: DimensionPoint,
  tolerance = 0.02,
): DimensionPoint[] {
  const kept = points.filter((p) => Math.abs(p.t - next.t) > tolerance);
  return [...kept, next].sort((a, b) => a.t - b.t);
}

/**
 * Moves the marker at `index` (in `t` order) towards `t`, never past or onto
 * its neighbours.
 *
 * A dragged marker is identified by its place in the order, which the clamp
 * keeps fixed, rather than by its last `t`: finding it by `t` could grab a
 * neighbour it had been dragged close to. It stops `gap` short of each
 * neighbour, the same distance `upsertDimensionPoint` treats as "the same
 * marker", and stays put if its neighbours leave no room at all.
 */
export function moveDimensionPoint(
  points: DimensionPoint[],
  index: number,
  t: number,
  gap = 0.02,
): DimensionPoint[] {
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const moving = sorted[index];
  if (!moving) return points;

  const lo = index > 0 ? sorted[index - 1].t + gap : 0;
  const hi = index < sorted.length - 1 ? sorted[index + 1].t - gap : 1;
  if (lo > hi) return sorted;

  sorted[index] = { ...moving, t: Math.min(hi, Math.max(lo, t)) };
  return sorted;
}

/** Node ids that terminate a chain — where a port makes sense. */
export function chainEndpoints(chain: Chain, nodes: ChannelNode[]): [string, string] | null {
  if (chain.members.length === 0) return null;
  const index = nodeIndex(nodes);

  const first = chain.members[0];
  const last = chain.members[chain.members.length - 1];
  const startId = first.reversed ? first.edge.toNodeId : first.edge.fromNodeId;
  const endId = last.reversed ? last.edge.fromNodeId : last.edge.toNodeId;

  return index.has(startId) && index.has(endId) ? [startId, endId] : null;
}
