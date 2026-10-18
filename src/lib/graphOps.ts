/**
 * Pure operations on a `channelGraph`.
 *
 * Every function takes a graph and returns a new one — nothing mutates, nothing
 * touches the store. That is what makes undo/redo a matter of keeping old
 * references, and what makes all of this testable without a canvas.
 */

import { newId } from './defaults';
import {
  add,
  angleBetweenDeg,
  cubicLength,
  cornerAngleDeg,
  edgeCurve,
  edgesAtNode,
  lerp,
  nodeIndex,
  nodePoint,
  normalize,
  scale,
  splitCubic,
  sub,
  type Rect,
} from './geometry';
import {
  buildChains,
  chainMarkers,
  sizeAtDistance,
  sizeAtEdgeEnd,
  getLoft,
  type ChannelSize,
} from './loft';
import { portFootprintMm, portSpecFor, type FittingPreset } from './ports';
import type {
  ChamberNode,
  ChannelEdge,
  ChannelGraph,
  ChannelNode,
  ChipParams,
  CrossSection,
  DimensionPoint,
  Point2,
  PortNode,
  PortType,
  WaypointNode,
} from '../types/project';

type ChannelDefaults = Pick<
  ChipParams,
  'defaultChannelWidthMm' | 'defaultChannelHeightMm' | 'defaultCrossSection'
>;

export const emptyGraph = (): ChannelGraph => ({ nodes: [], edges: [] });

// ---------------------------------------------------------------------------
// creation
// ---------------------------------------------------------------------------

export const makeWaypoint = (point: Point2, id = newId()): WaypointNode => ({
  id,
  x: point.x,
  y: point.y,
  type: 'waypoint',
});

export function makeEdge(
  fromNodeId: string,
  toNodeId: string,
  defaults: ChannelDefaults,
  overrides: Partial<ChannelEdge> = {},
): ChannelEdge {
  return {
    id: newId(),
    fromNodeId,
    toNodeId,
    curveType: 'straight',
    crossSection: defaults.defaultCrossSection,
    // No markers means "use the project default width everywhere" — the user
    // opts into a taper by dropping markers, rather than starting with two.
    dimensionPoints: [],
    ...overrides,
  };
}

export function addNode(graph: ChannelGraph, node: ChannelNode): ChannelGraph {
  return { ...graph, nodes: [...graph.nodes, node] };
}

export function connect(
  graph: ChannelGraph,
  fromNodeId: string,
  toNodeId: string,
  defaults: ChannelDefaults,
): ChannelGraph {
  if (fromNodeId === toNodeId) return graph;
  // An edge to a node that is not in the graph makes the whole project fail
  // to load again, so it is never worth creating — whatever stale id asked.
  const present = (id: string) => graph.nodes.some((n) => n.id === id);
  if (!present(fromNodeId) || !present(toNodeId)) return graph;
  const exists = graph.edges.some(
    (e) =>
      (e.fromNodeId === fromNodeId && e.toNodeId === toNodeId) ||
      (e.fromNodeId === toNodeId && e.toNodeId === fromNodeId),
  );
  if (exists) return graph;

  return { ...graph, edges: [...graph.edges, makeEdge(fromNodeId, toNodeId, defaults)] };
}

// ---------------------------------------------------------------------------
// mutation
// ---------------------------------------------------------------------------

export function updateNode(
  graph: ChannelGraph,
  nodeId: string,
  patch: Partial<ChannelNode>,
): ChannelGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.id === nodeId ? ({ ...node, ...patch } as ChannelNode) : node,
    ),
  };
}

export function moveNodes(
  graph: ChannelGraph,
  nodeIds: Iterable<string>,
  delta: Point2,
): ChannelGraph {
  const ids = new Set(nodeIds);
  if (ids.size === 0) return graph;

  return {
    ...graph,
    nodes: graph.nodes.map((node) =>
      ids.has(node.id) ? { ...node, x: node.x + delta.x, y: node.y + delta.y } : node,
    ),
    // Bezier handles are absolute coordinates, so an edge whose *both* ends
    // move has to carry its handles along or the curve would snap flat.
    edges: graph.edges.map((edge) => {
      if (!edge.controlPoints) return edge;
      const bothMoving = ids.has(edge.fromNodeId) && ids.has(edge.toNodeId);
      if (!bothMoving) return edge;
      return { ...edge, controlPoints: edge.controlPoints.map((cp) => add(cp, delta)) };
    }),
  };
}

export function setNodePosition(graph: ChannelGraph, nodeId: string, point: Point2): ChannelGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.id === nodeId ? { ...node, x: point.x, y: point.y } : node,
    ),
  };
}

export function updateEdge(
  graph: ChannelGraph,
  edgeId: string,
  patch: Partial<ChannelEdge>,
): ChannelGraph {
  return {
    ...graph,
    edges: graph.edges.map((edge) => (edge.id === edgeId ? { ...edge, ...patch } : edge)),
  };
}

/** Switching to bezier seeds handles along the chord so the shape does not jump. */
export function setCurveType(
  graph: ChannelGraph,
  edgeId: string,
  curveType: 'straight' | 'bezier',
): ChannelGraph {
  const edge = graph.edges.find((e) => e.id === edgeId);
  if (!edge) return graph;

  if (curveType === 'straight') {
    // Handles are kept, not dropped: toggling back to bezier restores the curve
    // the user had shaped rather than starting over.
    return updateEdge(graph, edgeId, { curveType: 'straight' });
  }

  if (edge.controlPoints && edge.controlPoints.length >= 2) {
    return updateEdge(graph, edgeId, { curveType: 'bezier' });
  }

  const nodes = nodeIndex(graph.nodes);
  const from = nodes.get(edge.fromNodeId);
  const to = nodes.get(edge.toNodeId);
  if (!from || !to) return graph;

  return updateEdge(graph, edgeId, {
    curveType: 'bezier',
    controlPoints: [
      lerp(nodePoint(from), nodePoint(to), 1 / 3),
      lerp(nodePoint(from), nodePoint(to), 2 / 3),
    ],
  });
}

// ---------------------------------------------------------------------------
// splitting
// ---------------------------------------------------------------------------

export interface SplitResult {
  graph: ChannelGraph;
  nodeId: string;
}

/**
 * Inserts a node partway along an edge, replacing it with two edges.
 *
 * The curve is split with de Casteljau so the visible shape is unchanged, and
 * existing dimension markers are redistributed onto whichever half now owns
 * them, with their `t` rescaled. Losing a taper because the user inserted a
 * corner would be a nasty surprise.
 */
export function splitEdgeAt(graph: ChannelGraph, edgeId: string, t: number): SplitResult | null {
  const edge = graph.edges.find((e) => e.id === edgeId);
  if (!edge) return null;

  const nodes = nodeIndex(graph.nodes);
  const from = nodes.get(edge.fromNodeId);
  const to = nodes.get(edge.toNodeId);
  if (!from || !to) return null;

  const clamped = Math.min(0.999, Math.max(0.001, t));
  const curve = edgeCurve(edge, nodePoint(from), nodePoint(to));
  const [left, right] = splitCubic(curve, clamped);

  const midNode = makeWaypoint(left.p1);

  const rescale = (points: DimensionPoint[], lo: number, hi: number): DimensionPoint[] =>
    points
      .filter((p) => p.t >= lo && p.t <= hi)
      .map((p) => ({ ...p, t: (p.t - lo) / Math.max(1e-9, hi - lo) }))
      .sort((a, b) => a.t - b.t);

  const isCurved = edge.curveType === 'bezier';

  const first: ChannelEdge = {
    ...edge,
    id: newId(),
    fromNodeId: edge.fromNodeId,
    toNodeId: midNode.id,
    controlPoints: isCurved ? [left.c0, left.c1] : undefined,
    dimensionPoints: rescale(edge.dimensionPoints, 0, clamped),
  };

  const second: ChannelEdge = {
    ...edge,
    id: newId(),
    fromNodeId: midNode.id,
    toNodeId: edge.toNodeId,
    controlPoints: isCurved ? [right.c0, right.c1] : undefined,
    dimensionPoints: rescale(edge.dimensionPoints, clamped, 1),
  };

  return {
    graph: {
      nodes: [...graph.nodes, midNode],
      edges: [...graph.edges.filter((e) => e.id !== edgeId), first, second],
    },
    nodeId: midNode.id,
  };
}

// ---------------------------------------------------------------------------
// deletion
// ---------------------------------------------------------------------------

/** Removes nodes and edges, dropping any edge left dangling by a removed node. */
export function deleteElements(
  graph: ChannelGraph,
  nodeIds: Iterable<string>,
  edgeIds: Iterable<string> = [],
): ChannelGraph {
  const deadNodes = new Set(nodeIds);
  const deadEdges = new Set(edgeIds);

  const nodes = graph.nodes.filter((node) => !deadNodes.has(node.id));
  const edges = graph.edges.filter(
    (edge) =>
      !deadEdges.has(edge.id) && !deadNodes.has(edge.fromNodeId) && !deadNodes.has(edge.toNodeId),
  );

  // A waypoint left with no edges at all is invisible clutter in the file.
  const referenced = new Set<string>();
  for (const edge of edges) {
    referenced.add(edge.fromNodeId);
    referenced.add(edge.toNodeId);
  }

  return {
    nodes: nodes.filter((node) => referenced.has(node.id) || node.type !== 'waypoint'),
    edges,
  };
}

// ---------------------------------------------------------------------------
// ports and chambers
// ---------------------------------------------------------------------------

/** Converts a node into a port. Only meaningful at a path end. */
export function makePort(
  graph: ChannelGraph,
  nodeId: string,
  portType: PortType,
  boreMm: number,
  specOverrides: Record<string, number> = {},
): ChannelGraph {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return graph;

  const existingSpec = node.type === 'port' ? (node.customSpec ?? {}) : {};
  const port: PortNode = {
    id: node.id,
    x: node.x,
    y: node.y,
    type: 'port',
    portType,
    diameterMm: boreMm,
    // Overrides land on top of the carried-forward values, so applying a named
    // fitting replaces the dimensions that fitting defines and leaves the rest.
    customSpec: { ...portSpecFor(portType, existingSpec), ...specOverrides },
  };

  return { ...graph, nodes: graph.nodes.map((n) => (n.id === nodeId ? port : n)) };
}

/**
 * Turns a node into a port cut for one named, off-the-shelf fitting.
 *
 * Separate from `makePort` because a fitting carries a bore *and* a full set of
 * dimensions that have to move together — applying "Norm-Ject Luer lock" and
 * getting last fitting's thread pitch would be worse than not offering it.
 */
export function applyFitting(
  graph: ChannelGraph,
  nodeId: string,
  fitting: FittingPreset,
): ChannelGraph {
  return makePort(graph, nodeId, fitting.portType, fitting.boreMm, fitting.spec);
}

/** Reverts a port or chamber back to a plain waypoint. */
export function makeWaypointAgain(graph: ChannelGraph, nodeId: string): ChannelGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.id === nodeId ? makeWaypoint(nodePoint(node), node.id) : node,
    ),
  };
}

/** Chamber size defaults to a multiple of the channel width at that node. */
export function localChannelWidth(
  graph: ChannelGraph,
  nodeId: string,
  defaults: ChannelDefaults,
): number {
  const chains = buildChains(graph);
  const touching = edgesAtNode(graph.edges, nodeId);
  if (touching.length === 0) return defaults.defaultChannelWidthMm;

  const fallback = {
    widthMm: defaults.defaultChannelWidthMm,
    heightMm: defaults.defaultChannelHeightMm,
  };

  for (const chain of chains) {
    const member = chain.members.find((m) => m.edge.id === touching[0].id);
    if (!member) continue;

    const atStart = member.reversed ? member.edge.toNodeId === nodeId : member.edge.fromNodeId === nodeId;
    const distanceMm = member.startDistance + (atStart ? 0 : member.lengthMm);
    return sizeAtDistance(chainMarkers(chain), distanceMm, fallback).widthMm;
  }

  return defaults.defaultChannelWidthMm;
}

export const DEFAULT_CHAMBER_WIDTH_MULTIPLE = 3;

export function makeChamber(
  graph: ChannelGraph,
  nodeId: string,
  shape: 'sphere' | 'cylinder',
  defaults: ChannelDefaults,
  options: { sizeMm?: number; autoPlaced?: boolean; multiple?: number } = {},
): ChannelGraph {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return graph;

  const multiple = options.multiple ?? DEFAULT_CHAMBER_WIDTH_MULTIPLE;
  const sizeMm = options.sizeMm ?? localChannelWidth(graph, nodeId, defaults) * multiple;

  const chamber: ChamberNode = {
    id: node.id,
    x: node.x,
    y: node.y,
    type: 'chamber',
    shape,
    sizeMm,
    autoPlaced: options.autoPlaced ?? false,
  };

  return { ...graph, nodes: graph.nodes.map((n) => (n.id === nodeId ? chamber : n)) };
}

export interface AutoChamberOptions {
  /** A node counts as a turn when its interior angle is below this, in degrees. */
  cornerThresholdDeg: number;
  shape: 'sphere' | 'cylinder';
  multiple: number;
}

/** Node ids the auto-placer considers turns, at the current threshold. */
export function detectCorners(graph: ChannelGraph, cornerThresholdDeg: number): string[] {
  const nodes = nodeIndex(graph.nodes);
  const corners: string[] = [];

  for (const node of graph.nodes) {
    if (node.type === 'port') continue;
    const angle = cornerAngleDeg(graph.edges, node.id, nodes);
    // 180° is dead straight; the further below the threshold, the sharper.
    if (angle !== null && angle < cornerThresholdDeg) corners.push(node.id);
  }

  return corners;
}

/** One-click "add chambers at all corners". */
export function addChambersAtCorners(
  graph: ChannelGraph,
  defaults: ChannelDefaults,
  options: AutoChamberOptions,
): { graph: ChannelGraph; added: string[] } {
  const corners = detectCorners(graph, options.cornerThresholdDeg);
  let next = graph;
  const added: string[] = [];

  for (const nodeId of corners) {
    const node = next.nodes.find((n) => n.id === nodeId);
    // Never resize a chamber the user placed and tuned by hand.
    if (node?.type === 'chamber') continue;
    next = makeChamber(next, nodeId, options.shape, defaults, {
      autoPlaced: true,
      multiple: options.multiple,
    });
    added.push(nodeId);
  }

  return { graph: next, added };
}

// ---------------------------------------------------------------------------
// copy / paste
// ---------------------------------------------------------------------------

export interface GraphFragment {
  nodes: ChannelNode[];
  edges: ChannelEdge[];
}

/** Extracts the selected nodes plus every edge with both ends inside. */
export function extractFragment(graph: ChannelGraph, nodeIds: Iterable<string>): GraphFragment {
  const ids = new Set(nodeIds);
  return {
    nodes: graph.nodes.filter((node) => ids.has(node.id)),
    edges: graph.edges.filter((edge) => ids.has(edge.fromNodeId) && ids.has(edge.toNodeId)),
  };
}

/** Re-ids a fragment and offsets it, so pasting never collides with the original. */
export function instantiateFragment(
  fragment: GraphFragment,
  offset: Point2,
): { nodes: ChannelNode[]; edges: ChannelEdge[]; idMap: Map<string, string> } {
  const idMap = new Map<string, string>();
  for (const node of fragment.nodes) idMap.set(node.id, newId());

  const nodes = fragment.nodes.map((node) => ({
    ...node,
    id: idMap.get(node.id) ?? newId(),
    x: node.x + offset.x,
    y: node.y + offset.y,
  })) as ChannelNode[];

  const edges = fragment.edges.map((edge) => ({
    ...edge,
    id: newId(),
    fromNodeId: idMap.get(edge.fromNodeId) ?? edge.fromNodeId,
    toNodeId: idMap.get(edge.toNodeId) ?? edge.toNodeId,
    controlPoints: edge.controlPoints?.map((cp) => add(cp, offset)),
    dimensionPoints: edge.dimensionPoints.map((dp) => ({ ...dp })),
  }));

  return { nodes, edges, idMap };
}

export function pasteFragment(
  graph: ChannelGraph,
  fragment: GraphFragment,
  offset: Point2,
): { graph: ChannelGraph; nodeIds: string[] } {
  const { nodes, edges } = instantiateFragment(fragment, offset);
  return {
    graph: { nodes: [...graph.nodes, ...nodes], edges: [...graph.edges, ...edges] },
    nodeIds: nodes.map((n) => n.id),
  };
}

// ---------------------------------------------------------------------------
// array repeat
// ---------------------------------------------------------------------------

/**
 * Endpoints of a fragment that is a single open run — the shape the array tool
 * can chain. Returns null for a branched or closed selection, which has no
 * unambiguous "end to continue from".
 */
export function fragmentEndpoints(fragment: GraphFragment): { startId: string; endId: string } | null {
  if (fragment.edges.length === 0) return null;

  const degree = new Map<string, number>();
  for (const edge of fragment.edges) {
    degree.set(edge.fromNodeId, (degree.get(edge.fromNodeId) ?? 0) + 1);
    degree.set(edge.toNodeId, (degree.get(edge.toNodeId) ?? 0) + 1);
  }

  const ends = [...degree.entries()].filter(([, d]) => d === 1).map(([id]) => id);
  if (ends.length !== 2) return null;
  if ([...degree.values()].some((d) => d > 2)) return null;

  return { startId: ends[0], endId: ends[1] };
}

export interface ArrayRepeatOptions {
  count: number;
  /**
   * Extra gap inserted between consecutive copies, mm. Zero chains them exactly
   * end-to-end.
   */
  spacingMm: number;
  /** Mirrors alternate copies — how a serpentine actually folds back. */
  alternate: boolean;
}

export interface ArrayRepeatPreview {
  nodes: ChannelNode[];
  edges: ChannelEdge[];
  /** Node in the source graph the first copy attaches to. */
  anchorNodeId: string;
}

/**
 * Chains N copies of a sub-path end-to-end, continuing its direction of travel.
 *
 * Each copy is translated so its start lands on the previous copy's end, then
 * joined with a fresh edge when a gap was requested. With `alternate` on, every
 * second copy is mirrored across the travel axis, which is what turns a single
 * serpentine turn into an actual serpentine.
 */
export function buildArrayRepeat(
  fragment: GraphFragment,
  options: ArrayRepeatOptions,
  defaults: ChannelDefaults,
): ArrayRepeatPreview | null {
  const ends = fragmentEndpoints(fragment);
  if (!ends || options.count < 1) return null;

  const index = new Map(fragment.nodes.map((n) => [n.id, n]));
  const startNode = index.get(ends.startId);
  const endNode = index.get(ends.endId);
  if (!startNode || !endNode) return null;

  const span = sub(nodePoint(endNode), nodePoint(startNode));
  const travel = normalize(span);
  if (travel.x === 0 && travel.y === 0) return null;

  const startPoint = nodePoint(startNode);

  /** Reflects a point across the line through `origin` along unit `axis`. */
  const mirrorAcross = (point: Point2, origin: Point2, axis: Point2): Point2 => {
    const rel = sub(point, origin);
    const along = scale(axis, rel.x * axis.x + rel.y * axis.y);
    return add(origin, sub(along, sub(rel, along)));
  };

  const nodes: ChannelNode[] = [];
  const edges: ChannelEdge[] = [];

  let attachTo = ends.endId;
  let attachPoint = nodePoint(endNode);

  for (let copy = 0; copy < options.count; copy += 1) {
    // Copy 0 is the first repeat after the original, so it is the one that
    // flips when alternating — that is what folds a turn into a serpentine.
    const mirrored = options.alternate && copy % 2 === 0;

    const gap = options.spacingMm > 0 ? scale(travel, options.spacingMm) : { x: 0, y: 0 };
    const copyStart = add(attachPoint, gap);

    // Mirroring is about `startPoint`, which is a fixed point of the
    // reflection, so the translation is the same either way.
    const shift = sub(copyStart, startPoint);
    const place = (p: Point2): Point2 =>
      add(mirrored ? mirrorAcross(p, startPoint, travel) : p, shift);

    const placed = instantiateFragment(fragment, { x: 0, y: 0 });
    const localStartId = placed.idMap.get(ends.startId);
    const localEndId = placed.idMap.get(ends.endId);
    if (!localStartId || !localEndId) return null;

    const copyNodes = placed.nodes.map((node) => {
      const moved = place(nodePoint(node));
      return { ...node, x: moved.x, y: moved.y } as ChannelNode;
    });
    const copyEdges: ChannelEdge[] = placed.edges.map((edge) => ({
      ...edge,
      controlPoints: edge.controlPoints?.map(place),
    }));

    if (options.spacingMm > 0) {
      // Bridge the gap with a connecting segment.
      copyEdges.push(makeEdge(attachTo, localStartId, defaults));
    } else {
      // Weld: the copy's start coincides with the previous end, so fold the
      // duplicate away and repoint this copy's edges at the existing node.
      // Scoped to `copyEdges` — rewriting earlier copies would unpick the chain.
      const duplicate = copyNodes.findIndex((n) => n.id === localStartId);
      if (duplicate >= 0) copyNodes.splice(duplicate, 1);
      for (const edge of copyEdges) {
        if (edge.fromNodeId === localStartId) edge.fromNodeId = attachTo;
        if (edge.toNodeId === localStartId) edge.toNodeId = attachTo;
      }
    }

    const localEnd = copyNodes.find((n) => n.id === localEndId);
    if (!localEnd) return null;

    nodes.push(...copyNodes);
    edges.push(...copyEdges);
    attachTo = localEndId;
    attachPoint = nodePoint(localEnd);
  }

  return { nodes, edges, anchorNodeId: ends.endId };
}

export function applyArrayRepeat(
  graph: ChannelGraph,
  preview: ArrayRepeatPreview,
): { graph: ChannelGraph; nodeIds: string[] } {
  return {
    graph: {
      nodes: [...graph.nodes, ...preview.nodes],
      edges: [...graph.edges, ...preview.edges],
    },
    nodeIds: preview.nodes.map((n) => n.id),
  };
}

// ---------------------------------------------------------------------------
// even spacing
// ---------------------------------------------------------------------------

export type SpacingAxis = 'auto' | 'x' | 'y';

/**
 * Redistributes selected nodes evenly between the two outermost of them.
 *
 * The anchors stay put and everything between is spread at equal intervals
 * along the dominant axis, so a row of ports lines up without the user doing
 * arithmetic.
 */
export function distributeEvenly(
  graph: ChannelGraph,
  nodeIds: string[],
  axis: SpacingAxis = 'auto',
): ChannelGraph {
  const selected = graph.nodes.filter((n) => nodeIds.includes(n.id));
  if (selected.length < 3) return graph;

  const spanX = Math.max(...selected.map((n) => n.x)) - Math.min(...selected.map((n) => n.x));
  const spanY = Math.max(...selected.map((n) => n.y)) - Math.min(...selected.map((n) => n.y));
  const useX = axis === 'x' || (axis === 'auto' && spanX >= spanY);

  const ordered = [...selected].sort((a, b) => (useX ? a.x - b.x : a.y - b.y));
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const steps = ordered.length - 1;

  const moved = new Map<string, Point2>();
  for (let i = 1; i < steps; i += 1) {
    moved.set(ordered[i].id, lerp(nodePoint(first), nodePoint(last), i / steps));
  }

  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const target = moved.get(node.id);
      return target ? { ...node, x: target.x, y: target.y } : node;
    }),
  };
}

/**
 * Places selected nodes at an exact interval from the anchor, keeping their
 * existing order along the chosen axis.
 */
export function spaceByIncrement(
  graph: ChannelGraph,
  nodeIds: string[],
  incrementMm: number,
  axis: SpacingAxis = 'auto',
  anchor: 'first' | 'last' = 'first',
): ChannelGraph {
  const selected = graph.nodes.filter((n) => nodeIds.includes(n.id));
  if (selected.length < 2 || incrementMm <= 0) return graph;

  const spanX = Math.max(...selected.map((n) => n.x)) - Math.min(...selected.map((n) => n.x));
  const spanY = Math.max(...selected.map((n) => n.y)) - Math.min(...selected.map((n) => n.y));
  const useX = axis === 'x' || (axis === 'auto' && spanX >= spanY);

  const ordered = [...selected].sort((a, b) => (useX ? a.x - b.x : a.y - b.y));
  if (anchor === 'last') ordered.reverse();

  const origin = nodePoint(ordered[0]);
  const direction = anchor === 'last' ? -1 : 1;

  const moved = new Map<string, Point2>();
  for (let i = 1; i < ordered.length; i += 1) {
    const offset = incrementMm * i * direction;
    moved.set(ordered[i].id, useX ? { x: origin.x + offset, y: origin.y } : { x: origin.x, y: origin.y + offset });
  }

  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const target = moved.get(node.id);
      return target ? { ...node, x: target.x, y: target.y } : node;
    }),
  };
}

// ---------------------------------------------------------------------------
// cross-section
// ---------------------------------------------------------------------------

export function setCrossSection(
  graph: ChannelGraph,
  edgeIds: Iterable<string>,
  crossSection: CrossSection,
): ChannelGraph {
  const ids = new Set(edgeIds);
  return {
    ...graph,
    edges: graph.edges.map((edge) => (ids.has(edge.id) ? { ...edge, crossSection } : edge)),
  };
}

/** Narrowest and widest a set of segments gets anywhere along their length, mm. */
export interface SizeRange {
  widthMm: { min: number; max: number };
  heightMm: { min: number; max: number };
}

/**
 * The spread of channel size across some segments, read off the solved loft.
 *
 * From the samples rather than the markers, so a segment that inherits its
 * width from a neighbour's marker, or tapers, counts at the size it actually
 * is. Null when none of the ids resolves to a segment.
 */
export function segmentSizeRange(
  graph: ChannelGraph,
  edgeIds: Iterable<string>,
  chipParams: Pick<ChipParams, 'defaultChannelWidthMm' | 'defaultChannelHeightMm'>,
): SizeRange | null {
  const loft = getLoft(graph, chipParams);
  const range: SizeRange = {
    widthMm: { min: Infinity, max: -Infinity },
    heightMm: { min: Infinity, max: -Infinity },
  };
  let found = false;
  for (const id of edgeIds) {
    for (const sample of loft.edges.get(id)?.samples ?? []) {
      found = true;
      range.widthMm.min = Math.min(range.widthMm.min, sample.widthMm);
      range.widthMm.max = Math.max(range.widthMm.max, sample.widthMm);
      range.heightMm.min = Math.min(range.heightMm.min, sample.heightMm);
      range.heightMm.max = Math.max(range.heightMm.max, sample.heightMm);
    }
  }
  return found ? range : null;
}

/**
 * Gives every listed segment one uniform size along its whole length.
 *
 * Each segment's markers are replaced by a pinned marker at either end, so a
 * taper, an interior marker, or a width inherited from along the chain all
 * give way to the new size. Whichever of width and height is not being set
 * keeps what each end resolves to now; round segments carry no height.
 */
export function setSegmentsSize(
  graph: ChannelGraph,
  edgeIds: Iterable<string>,
  size: Partial<ChannelSize>,
  chipParams: Pick<ChipParams, 'defaultChannelWidthMm' | 'defaultChannelHeightMm'>,
): ChannelGraph {
  const ids = new Set(edgeIds);
  const loft = getLoft(graph, chipParams);
  const fallback = {
    widthMm: chipParams.defaultChannelWidthMm,
    heightMm: chipParams.defaultChannelHeightMm,
  };

  return {
    ...graph,
    edges: graph.edges.map((edge) => {
      if (!ids.has(edge.id)) return edge;
      const marker = (end: 'start' | 'end', t: number): DimensionPoint => {
        const current = sizeAtEdgeEnd(loft, edge.id, end, fallback);
        return {
          t,
          widthMm: size.widthMm ?? current.widthMm,
          ...(edge.crossSection === 'round' ? {} : { heightMm: size.heightMm ?? current.heightMm }),
        };
      };
      return { ...edge, dimensionPoints: [marker('start', 0), marker('end', 1)] };
    }),
  };
}

// ---------------------------------------------------------------------------
// diagnostics
// ---------------------------------------------------------------------------

/** Nodes whose footprint sits closer to the chip boundary than allowed. */
export interface EdgeSpacingWarning {
  nodeId: string;
  clearanceMm: number;
  requiredMm: number;
  outside: boolean;
}

export function findEdgeSpacingWarnings(
  graph: ChannelGraph,
  chipParams: Pick<ChipParams, 'width' | 'length' | 'minEdgeSpacing'>,
  footprintOf: (node: ChannelNode) => number,
): EdgeSpacingWarning[] {
  const warnings: EdgeSpacingWarning[] = [];

  for (const node of graph.nodes) {
    const radius = footprintOf(node) / 2;
    const clearance = Math.min(
      node.x - radius,
      chipParams.width - (node.x + radius),
      node.y - radius,
      chipParams.length - (node.y + radius),
    );

    if (clearance < chipParams.minEdgeSpacing) {
      warnings.push({
        nodeId: node.id,
        clearanceMm: clearance,
        requiredMm: chipParams.minEdgeSpacing,
        outside: clearance < 0,
      });
    }
  }

  return warnings;
}

/** Length of every edge measured along its curve, for the template stats. */
export function totalChannelLengthMm(graph: ChannelGraph): number {
  const nodes = nodeIndex(graph.nodes);
  let total = 0;
  for (const edge of graph.edges) {
    const from = nodes.get(edge.fromNodeId);
    const to = nodes.get(edge.toNodeId);
    // Along the curve, not the chord: a serpentine's bends are most of its length.
    if (from && to) total += cubicLength(edgeCurve(edge, nodePoint(from), nodePoint(to)));
  }
  return total;
}

// ---------------------------------------------------------------------------
// centering
// ---------------------------------------------------------------------------

/**
 * How much room a node takes on the chip, measured across, in mm.
 *
 * A port is as wide as the fitting cut for it, a chamber as wide as its size,
 * and a plain waypoint is just the channel passing through. Anything measuring
 * where the design sits has to use this rather than the bare coordinate: a
 * 7.7 mm luer boss with its center 1 mm from the edge is over the edge.
 */
export function nodeFootprintMm(
  node: ChannelNode,
  chipParams: Pick<ChipParams, 'defaultChannelWidthMm'>,
): number {
  if (node.type === 'port') return portFootprintMm(node.portType, node.customSpec);
  if (node.type === 'chamber') return node.sizeMm;
  return chipParams.defaultChannelWidthMm;
}

/**
 * The area the design physically occupies — not the box around its centerlines.
 *
 * Ports and chambers contribute their full footprint and every channel
 * contributes its own walls, so centering on these bounds leaves even margins on
 * the chip. Bounding the centerlines instead would hang a fat inlet port over
 * one edge and call it centered.
 *
 * `nodeIds` restricts the measurement to those nodes and to the segments joining
 * them — the ones that would travel together. Passing an empty set measures
 * nothing and returns `null`; omit the argument for the whole graph.
 */
export function designBoundsMm(
  graph: ChannelGraph,
  chipParams: Pick<ChipParams, 'defaultChannelWidthMm' | 'defaultChannelHeightMm'>,
  nodeIds?: Iterable<string>,
): Rect | null {
  const scope = nodeIds ? new Set(nodeIds) : null;
  const nodes = scope ? graph.nodes.filter((node) => scope.has(node.id)) : graph.nodes;
  if (nodes.length === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const cover = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };

  for (const node of nodes) {
    const radius = nodeFootprintMm(node, chipParams) / 2;
    cover(node.x - radius, node.y - radius);
    cover(node.x + radius, node.y + radius);
  }

  // A bezier bulges well outside the box its endpoints make, and a lofted
  // channel is wider in some places than others — so walk the solved samples
  // rather than assuming the nodes tell the whole story.
  const moving = new Set(nodes.map((node) => node.id));
  const loft = getLoft(graph, chipParams);
  for (const edge of graph.edges) {
    if (!moving.has(edge.fromNodeId) || !moving.has(edge.toNodeId)) continue;
    const solved = loft.edges.get(edge.id);
    if (!solved) continue;

    for (const sample of solved.samples) {
      // Channel walls run perpendicular to the path, so offset across it rather
      // than growing a circle the channel never fills.
      const half = sample.widthMm / 2;
      const acrossX = -sample.tangent.y * half;
      const acrossY = sample.tangent.x * half;
      cover(sample.point.x + acrossX, sample.point.y + acrossY);
      cover(sample.point.x - acrossX, sample.point.y - acrossY);
    }
  }

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Below this, a move is float noise rather than a correction worth making. */
const CENTER_EPSILON_MM = 1e-4;

export interface CenterResult {
  graph: ChannelGraph;
  /** How far the nodes moved. Zero on both axes means nothing was off-center. */
  deltaMm: Point2;
}

/**
 * How far the design would have to travel to sit in the middle of the chip.
 *
 * Separate from `centerInChip` so the interface can show the offset live —
 * every graph edit re-measures it, and building a moved copy of the graph just
 * to read two numbers off it would be wasted work on every drag frame.
 *
 * Returns a flat zero when there is nothing in scope or it is already centered.
 */
export function centerOffsetMm(
  graph: ChannelGraph,
  chipParams: Pick<
    ChipParams,
    'width' | 'length' | 'defaultChannelWidthMm' | 'defaultChannelHeightMm'
  >,
  nodeIds?: Iterable<string>,
): Point2 {
  const still = { x: 0, y: 0 };

  const bounds = designBoundsMm(graph, chipParams, nodeIds);
  if (!bounds) return still;

  // Round off the arithmetic's last digits so a centered design reports as
  // centered, and the file does not fill up with 19.999999999999996.
  const tidy = (mm: number) => Math.round(mm * 1e6) / 1e6;
  const deltaMm = {
    x: tidy(chipParams.width / 2 - (bounds.x + bounds.width / 2)),
    y: tidy(chipParams.length / 2 - (bounds.y + bounds.height / 2)),
  };

  return Math.abs(deltaMm.x) < CENTER_EPSILON_MM && Math.abs(deltaMm.y) < CENTER_EPSILON_MM
    ? still
    : deltaMm;
}

/**
 * Slides nodes so their footprint sits in the middle of the chip.
 *
 * Nothing is scaled or rotated and no relative spacing changes — this is one
 * translation applied to every node in scope, so a design keeps its shape and a
 * user who nudges the chip's width can put the channels back where the starter
 * templates have them.
 *
 * Returns the graph unchanged when there is nothing in scope or it is already
 * centered, which keeps `updateGraph` from pushing an undo entry for a no-op.
 */
export function centerInChip(
  graph: ChannelGraph,
  chipParams: Pick<
    ChipParams,
    'width' | 'length' | 'defaultChannelWidthMm' | 'defaultChannelHeightMm'
  >,
  nodeIds?: Iterable<string>,
): CenterResult {
  const deltaMm = centerOffsetMm(graph, chipParams, nodeIds);
  if (deltaMm.x === 0 && deltaMm.y === 0) return { graph, deltaMm };

  return {
    graph: moveNodes(graph, nodeIds ?? graph.nodes.map((node) => node.id), deltaMm),
    deltaMm,
  };
}

export { angleBetweenDeg };
