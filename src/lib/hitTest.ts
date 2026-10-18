/**
 * What is under the cursor.
 *
 * Done in chip space against the model rather than against Paper.js items, for
 * three reasons: it stays correct no matter how the renderer draws things, it
 * is testable without a DOM, and it lets priority be stated explicitly rather
 * than falling out of z-order.
 */

import {
  distance,
  edgeCurve,
  nearestOnCubic,
  nodeIndex,
  nodePoint,
  type Cubic,
} from './geometry';
import type { LoftSolution } from './loft';
import type { ChannelGraph, ChannelNode, Point2 } from '../types/project';

export type HitTarget =
  | { kind: 'node'; nodeId: string; point: Point2 }
  | { kind: 'handle'; edgeId: string; handleIndex: 0 | 1; point: Point2 }
  | { kind: 'dimension'; edgeId: string; t: number; point: Point2 }
  | { kind: 'edge'; edgeId: string; t: number; point: Point2 }
  | null;

export interface HitOptions {
  /** Grab radius in mm, normally a fixed pixel distance converted at zoom. */
  toleranceMm: number;
  /** Edges whose bezier handles are grabbable — only the selected ones. */
  handlesForEdgeIds?: Set<string>;
  /** Dimension markers are only grabbable while the dimension tool is active. */
  includeDimensionMarkers?: boolean;
  /**
   * Whether a dimension marker outranks a node sitting under the same point.
   *
   * A marker pinned to the end of a segment sits *exactly* on that segment's
   * node, so whichever of the two wins there is the only one reachable at all.
   * Only the dimension tool can drag a marker, so only it should win: under the
   * select tool a node would otherwise become impossible to grab or move the
   * moment its segment was tapered from the inspector, which pins markers at
   * `t = 0` and `t = 1`.
   *
   * Defaults to true, which is the dimension tool's behaviour.
   */
  markersOutrankNodes?: boolean;
}

/**
 * Priority order, tightest target first:
 *
 *   handle → dimension marker → node → edge
 *
 * Handles win over nodes because a handle often sits close to its own endpoint,
 * and a user reaching for a handle there has no other way to grab it. Edges are
 * last because they are the largest target and would otherwise swallow clicks
 * meant for anything sitting on them.
 *
 * `markersOutrankNodes` moves the marker step below the node step, for callers
 * that cannot drag a marker anyway — see the option.
 */
export function hitTest(
  graph: ChannelGraph,
  point: Point2,
  options: HitOptions,
): HitTarget {
  const {
    toleranceMm,
    handlesForEdgeIds,
    includeDimensionMarkers,
    markersOutrankNodes = true,
  } = options;
  const nodes = nodeIndex(graph.nodes);

  // Takes the edge itself: looking it up by id from inside the loops over
  // `graph.edges` made every pointer-move O(E²).
  const curveFor = (edge: ChannelGraph['edges'][number]): Cubic | null => {
    const from = nodes.get(edge.fromNodeId);
    const to = nodes.get(edge.toNodeId);
    if (!from || !to) return null;
    return edgeCurve(edge, nodePoint(from), nodePoint(to));
  };

  // --- bezier handles ------------------------------------------------------
  if (handlesForEdgeIds && handlesForEdgeIds.size > 0) {
    for (const edge of graph.edges) {
      if (!handlesForEdgeIds.has(edge.id)) continue;
      if (edge.curveType !== 'bezier' || !edge.controlPoints) continue;

      for (let i = 0; i < Math.min(2, edge.controlPoints.length); i += 1) {
        const handle = edge.controlPoints[i];
        if (distance(point, handle) <= toleranceMm) {
          return { kind: 'handle', edgeId: edge.id, handleIndex: i as 0 | 1, point: handle };
        }
      }
    }
  }

  // --- dimension markers ---------------------------------------------------
  let markerHit: HitTarget = null;
  if (includeDimensionMarkers) {
    let best: { edgeId: string; t: number; point: Point2; d: number } | null = null;

    for (const edge of graph.edges) {
      if (edge.dimensionPoints.length === 0) continue;
      const curve = curveFor(edge);
      if (!curve) continue;

      for (const dp of edge.dimensionPoints) {
        const at = pointOnCubic(curve, dp.t);
        const d = distance(point, at);
        if (d <= toleranceMm && (!best || d < best.d)) {
          best = { edgeId: edge.id, t: dp.t, point: at, d };
        }
      }
    }

    if (best) markerHit = { kind: 'dimension', edgeId: best.edgeId, t: best.t, point: best.point };
  }

  if (markerHit && markersOutrankNodes) return markerHit;

  // --- nodes ---------------------------------------------------------------
  let bestNode: { node: ChannelNode; d: number } | null = null;
  for (const node of graph.nodes) {
    const d = distance(point, nodePoint(node));
    if (d <= toleranceMm && (!bestNode || d < bestNode.d)) bestNode = { node, d };
  }
  if (bestNode) {
    return { kind: 'node', nodeId: bestNode.node.id, point: nodePoint(bestNode.node) };
  }

  if (markerHit) return markerHit;

  // --- edges ---------------------------------------------------------------
  let bestEdge: { edgeId: string; t: number; point: Point2; d: number } | null = null;
  for (const edge of graph.edges) {
    const curve = curveFor(edge);
    if (!curve || !nearHull(curve, point, toleranceMm)) continue;
    const near = nearestOnCubic(curve, point);
    if (near.distance <= toleranceMm && (!bestEdge || near.distance < bestEdge.d)) {
      bestEdge = { edgeId: edge.id, t: near.t, point: near.point, d: near.distance };
    }
  }
  if (bestEdge) {
    return { kind: 'edge', edgeId: bestEdge.edgeId, t: bestEdge.t, point: bestEdge.point };
  }

  return null;
}

/**
 * Whether `point` is within `tolerance` of the box around a cubic's control
 * points. A Bézier never leaves the hull of its control points, so a point
 * outside that box grown by the tolerance cannot be near the curve, and the
 * iterative `nearestOnCubic` search can be skipped.
 */
function nearHull(curve: Cubic, point: Point2, tolerance: number): boolean {
  const xs = [curve.p0.x, curve.c0.x, curve.c1.x, curve.p1.x];
  const ys = [curve.p0.y, curve.c0.y, curve.c1.y, curve.p1.y];
  return (
    point.x >= Math.min(...xs) - tolerance &&
    point.x <= Math.max(...xs) + tolerance &&
    point.y >= Math.min(...ys) - tolerance &&
    point.y <= Math.max(...ys) + tolerance
  );
}

function pointOnCubic(curve: Cubic, t: number): Point2 {
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

/**
 * Node ids inside a marquee rectangle.
 *
 * Nodes only — an edge is considered selected when both its ends are, which the
 * caller derives. Rubber-banding half an edge has no useful meaning.
 */
export function nodesInRect(
  graph: ChannelGraph,
  rect: { x: number; y: number; width: number; height: number },
): string[] {
  return graph.nodes
    .filter(
      (node) =>
        node.x >= rect.x &&
        node.x <= rect.x + rect.width &&
        node.y >= rect.y &&
        node.y <= rect.y + rect.height,
    )
    .map((node) => node.id);
}

/** Edges with both endpoints in the given set. */
export function edgesWithinNodes(graph: ChannelGraph, nodeIds: Iterable<string>): string[] {
  const ids = new Set(nodeIds);
  return graph.edges
    .filter((edge) => ids.has(edge.fromNodeId) && ids.has(edge.toNodeId))
    .map((edge) => edge.id);
}

/** How wide the channel renders at a point, for cursor feedback and warnings. */
export function widthAtEdgeT(solution: LoftSolution, edgeId: string, t: number): number | null {
  const solved = solution.edges.get(edgeId);
  if (!solved || solved.samples.length === 0) return null;
  const index = Math.round(t * (solved.samples.length - 1));
  return solved.samples[Math.max(0, Math.min(solved.samples.length - 1, index))].widthMm;
}
