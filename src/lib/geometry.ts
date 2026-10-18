/**
 * Plane geometry in chip space (millimetres, +Y up, origin at the chip's
 * bottom-left corner).
 *
 * Pure functions only — no Paper.js, no React. The canvas uses these, but so do
 * the tests, the SVG exporter, and the CSG code. Keeping Paper out of
 * here means the geometry stays verifiable without a DOM.
 */

import type { ChannelEdge, ChannelNode, Point2 } from '../types/project';

export const EPSILON = 1e-9;

// ---------------------------------------------------------------------------
// vectors
// ---------------------------------------------------------------------------

export const pt = (x: number, y: number): Point2 => ({ x, y });
export const add = (a: Point2, b: Point2): Point2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Point2, b: Point2): Point2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Point2, k: number): Point2 => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Point2, b: Point2): number => a.x * b.x + a.y * b.y;
export const lengthOf = (a: Point2): number => Math.hypot(a.x, a.y);
export const distance = (a: Point2, b: Point2): number => Math.hypot(b.x - a.x, b.y - a.y);
export const lerp = (a: Point2, b: Point2, t: number): Point2 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});

export function normalize(a: Point2): Point2 {
  const len = lengthOf(a);
  return len < EPSILON ? { x: 0, y: 0 } : { x: a.x / len, y: a.y / len };
}

/** Rotates 90° counter-clockwise — the left-hand normal of a direction vector. */
export const perpendicular = (a: Point2): Point2 => ({ x: -a.y, y: a.x });

/** Signed angle in degrees, measured counter-clockwise from +X. */
export const angleDeg = (a: Point2): number => (Math.atan2(a.y, a.x) * 180) / Math.PI;

export const fromAngleDeg = (deg: number, len = 1): Point2 => {
  const rad = (deg * Math.PI) / 180;
  return { x: Math.cos(rad) * len, y: Math.sin(rad) * len };
};

/** Smallest absolute difference between two headings, in degrees (0–180). */
export function angleBetweenDeg(a: Point2, b: Point2): number {
  const na = normalize(a);
  const nb = normalize(b);
  const cosine = Math.min(1, Math.max(-1, dot(na, nb)));
  return (Math.acos(cosine) * 180) / Math.PI;
}

export const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

/** Rounds to a multiple of `step`; a step of 0 or less passes the value through. */
export const snapToStep = (value: number, step: number): number =>
  step > 0 ? Math.round(value / step) * step : value;

// ---------------------------------------------------------------------------
// cubic bezier
// ---------------------------------------------------------------------------

/**
 * An edge in curve form. Straight edges degenerate to control points sitting on
 * the endpoints, so every downstream consumer can treat all edges as cubics and
 * stop special-casing.
 */
export interface Cubic {
  p0: Point2;
  c0: Point2;
  c1: Point2;
  p1: Point2;
}

export function cubicAt(curve: Cubic, t: number): Point2 {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * curve.p0.x + b * curve.c0.x + c * curve.c1.x + d * curve.p1.x,
    y: a * curve.p0.y + b * curve.c0.y + c * curve.c1.y + d * curve.p1.y,
  };
}

/** First derivative — the (unnormalised) tangent at `t`. */
export function cubicTangentAt(curve: Cubic, t: number): Point2 {
  const u = 1 - t;
  const a = 3 * u * u;
  const b = 6 * u * t;
  const c = 3 * t * t;
  return {
    x: a * (curve.c0.x - curve.p0.x) + b * (curve.c1.x - curve.c0.x) + c * (curve.p1.x - curve.c1.x),
    y: a * (curve.c0.y - curve.p0.y) + b * (curve.c1.y - curve.c0.y) + c * (curve.p1.y - curve.c1.y),
  };
}

/**
 * Builds the cubic for an edge.
 *
 * A `straight` edge, or a `bezier` edge whose handles were never set, collapses
 * to a line expressed as a cubic (control points at the one-third marks), which
 * keeps `t` roughly proportional to arc length for the common case.
 */
export function edgeCurve(edge: ChannelEdge, from: Point2, to: Point2): Cubic {
  if (edge.curveType === 'bezier' && edge.controlPoints && edge.controlPoints.length >= 2) {
    return { p0: from, c0: edge.controlPoints[0], c1: edge.controlPoints[1], p1: to };
  }
  return { p0: from, c0: lerp(from, to, 1 / 3), c1: lerp(from, to, 2 / 3), p1: to };
}

/** Default handles placed along the chord, used when a segment is switched to bezier. */
export const defaultHandles = (from: Point2, to: Point2): [Point2, Point2] => [
  lerp(from, to, 1 / 3),
  lerp(from, to, 2 / 3),
];

// ---------------------------------------------------------------------------
// sampling and arc length
// ---------------------------------------------------------------------------

/** Uniform samples in `t`, inclusive of both ends. `steps` segments, `steps+1` points. */
export function sampleCubic(curve: Cubic, steps = 24): Point2[] {
  const points: Point2[] = [];
  for (let i = 0; i <= steps; i += 1) points.push(cubicAt(curve, i / steps));
  return points;
}

export function cubicLength(curve: Cubic, steps = 32): number {
  const samples = sampleCubic(curve, steps);
  let total = 0;
  for (let i = 1; i < samples.length; i += 1) total += distance(samples[i - 1], samples[i]);
  return total;
}

export interface NearestResult {
  /** Parameter of the closest point on the curve. */
  t: number;
  point: Point2;
  distance: number;
}

/**
 * Closest point on a cubic, by coarse sampling then a local refinement.
 *
 * Used for "click a segment to split it" and for placing dimension markers, so
 * it needs to be accurate enough that the inserted node lands under the cursor —
 * the refinement pass is what gets it there.
 */
export function nearestOnCubic(curve: Cubic, target: Point2, steps = 48): NearestResult {
  let bestT = 0;
  let bestDist = Infinity;

  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const d = distance(cubicAt(curve, t), target);
    if (d < bestDist) {
      bestDist = d;
      bestT = t;
    }
  }

  // Binary refinement around the best sample.
  let span = 1 / steps;
  for (let pass = 0; pass < 20; pass += 1) {
    span /= 2;
    const left = clamp(bestT - span, 0, 1);
    const right = clamp(bestT + span, 0, 1);
    const dl = distance(cubicAt(curve, left), target);
    const dr = distance(cubicAt(curve, right), target);
    if (dl < bestDist) {
      bestDist = dl;
      bestT = left;
    }
    if (dr < bestDist) {
      bestDist = dr;
      bestT = right;
    }
  }

  return { t: bestT, point: cubicAt(curve, bestT), distance: bestDist };
}

// ---------------------------------------------------------------------------
// splitting
// ---------------------------------------------------------------------------

/** de Casteljau split of a cubic at `t`, preserving both halves' shape exactly. */
export function splitCubic(curve: Cubic, t: number): [Cubic, Cubic] {
  const p01 = lerp(curve.p0, curve.c0, t);
  const p12 = lerp(curve.c0, curve.c1, t);
  const p23 = lerp(curve.c1, curve.p1, t);
  const p012 = lerp(p01, p12, t);
  const p123 = lerp(p12, p23, t);
  const mid = lerp(p012, p123, t);

  return [
    { p0: curve.p0, c0: p01, c1: p012, p1: mid },
    { p0: mid, c0: p123, c1: p23, p1: curve.p1 },
  ];
}

// ---------------------------------------------------------------------------
// rectangles
// ---------------------------------------------------------------------------

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const rectFromPoints = (a: Point2, b: Point2): Rect => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  width: Math.abs(b.x - a.x),
  height: Math.abs(b.y - a.y),
});

export const rectContains = (rect: Rect, point: Point2): boolean =>
  point.x >= rect.x &&
  point.x <= rect.x + rect.width &&
  point.y >= rect.y &&
  point.y <= rect.y + rect.height;

/** Shortest distance from a point to the inside edge of a rectangle. */
export const distanceToRectEdge = (rect: Rect, point: Point2): number =>
  Math.min(
    point.x - rect.x,
    rect.x + rect.width - point.x,
    point.y - rect.y,
    rect.y + rect.height - point.y,
  );

// ---------------------------------------------------------------------------
// graph helpers
// ---------------------------------------------------------------------------

export const nodeIndex = (nodes: ChannelNode[]): Map<string, ChannelNode> =>
  new Map(nodes.map((node) => [node.id, node]));

export const nodePoint = (node: ChannelNode): Point2 => ({ x: node.x, y: node.y });

/** Edges touching a node, in graph order. */
export const edgesAtNode = (edges: ChannelEdge[], nodeId: string): ChannelEdge[] =>
  edges.filter((edge) => edge.fromNodeId === nodeId || edge.toNodeId === nodeId);

/**
 * Every node's touching edges, in graph order, built in one pass.
 *
 * `edgesAtNode` scans every edge, so calling it once per node is quadratic.
 * Anything that asks about many nodes should build this once instead.
 */
export function buildAdjacency(edges: ChannelEdge[]): Map<string, ChannelEdge[]> {
  const adjacency = new Map<string, ChannelEdge[]>();
  const push = (id: string, edge: ChannelEdge) => {
    const list = adjacency.get(id);
    if (list) list.push(edge);
    else adjacency.set(id, [edge]);
  };
  for (const edge of edges) {
    push(edge.fromNodeId, edge);
    if (edge.toNodeId !== edge.fromNodeId) push(edge.toNodeId, edge);
  }
  return adjacency;
}

const NO_EDGES: readonly ChannelEdge[] = [];

/** A node's edges from a prebuilt adjacency map; empty for an isolated node. */
export const edgesFrom = (
  adjacency: Map<string, ChannelEdge[]>,
  nodeId: string,
): readonly ChannelEdge[] => adjacency.get(nodeId) ?? NO_EDGES;

/** Degree-1 nodes: where a port can legitimately go. */
export function isEndpoint(edges: ChannelEdge[], nodeId: string): boolean {
  return edgesAtNode(edges, nodeId).length <= 1;
}

/**
 * Outgoing direction of an edge as seen from `nodeId`.
 *
 * Needed by the corner-angle test for auto chamber placement, and by the array
 * repeat tool to work out which way a path is heading.
 */
export function edgeDirectionFrom(
  edge: ChannelEdge,
  nodeId: string,
  nodes: Map<string, ChannelNode>,
): Point2 | null {
  const from = nodes.get(edge.fromNodeId);
  const to = nodes.get(edge.toNodeId);
  if (!from || !to) return null;

  const curve = edgeCurve(edge, nodePoint(from), nodePoint(to));
  if (edge.fromNodeId === nodeId) return normalize(cubicTangentAt(curve, 0));
  if (edge.toNodeId === nodeId) return normalize(scale(cubicTangentAt(curve, 1), -1));
  return null;
}

/**
 * Interior angle at a node where exactly two edges meet, in degrees.
 *
 * 180° means the path runs straight through; smaller values are sharper turns.
 * Returns null where the concept does not apply (endpoints, junctions of 3+).
 */
export function cornerAngleDeg(
  edges: ChannelEdge[],
  nodeId: string,
  nodes: Map<string, ChannelNode>,
): number | null {
  const touching = edgesAtNode(edges, nodeId);
  if (touching.length !== 2) return null;

  const a = edgeDirectionFrom(touching[0], nodeId, nodes);
  const b = edgeDirectionFrom(touching[1], nodeId, nodes);
  if (!a || !b) return null;

  return angleBetweenDeg(a, b);
}
