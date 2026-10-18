/**
 * Trapped-resin detection and vent placement.
 *
 * ## What "local low point" means for a planar chip
 *
 * The natural place for a drainage hole is a "local low point in the enclosed
 * geometry". Taken literally that is a Z-height question — but every channel in
 * an OpenChip design sits at a single Z, so *every* point is equally low and
 * the literal reading selects everything or nothing.
 *
 * What actually traps resin is not depth, it is **distance from an opening**.
 * Resin drains by flowing out through a port; a region is trapped when it has
 * no path to one, or a long tortuous path with nowhere for air to enter behind
 * it. So "low point" is interpreted as a local maximum of the along-channel
 * distance to the nearest opening — the places resin has furthest to travel to
 * escape, which is exactly where a vent does the most good.
 *
 * Dead ends and unreachable islands are always vented, since those cannot drain
 * at all regardless of distance.
 */

import { newId } from '../defaults';
import { ductGeometry } from '../fluids/hydraulics';
import { buildAdjacency, distance, edgesFrom, nodeIndex, nodePoint } from '../geometry';
import { getLoft } from '../loft';
import { connectedComponents } from './flow';
import type {
  ChannelGraph,
  ChipParams,
  CrossSection,
  DrainageVent,
  Point2,
} from '../../types/project';
import type { ValidationInput, Warning } from './types';

const mm = (n: number) => Math.round(n * 1000) / 1000;

/** Default vent bore. Small enough to be inconspicuous, big enough to drain. */
export const DEFAULT_VENT_DIAMETER_MM = 0.8;

/**
 * Beyond this along-channel distance from an opening, a region is considered
 * worth venting on its own account.
 */
const VENT_DISTANCE_THRESHOLD_MM = 15;

// ---------------------------------------------------------------------------
// is the cavity actually closed?
// ---------------------------------------------------------------------------

export interface EnclosureState {
  enclosed: boolean;
  reason: string;
}

/**
 * A two-piece chip is open by construction: the channel ceiling sits on the cut
 * plane, so the groove is exposed until the lid goes on. The exception is a
 * split plane outside the block, where no cut happens and the chip prints as a
 * sealed solid — which is easy to do by accident and worth catching.
 */
export function enclosureState(chipParams: ChipParams): EnclosureState {
  if (chipParams.splitType === 'monolithic') {
    return {
      enclosed: true,
      reason: 'The chip is monolithic, so every channel is sealed inside the block.',
    };
  }

  if (chipParams.splitType === 'glass-slide') {
    // The pocket opens the channels under it, and `splitHeight` is not what
    // decides that — reading it here would judge a slide chip on a number its
    // geometry ignores. Whatever runs outside the pocket keeps its roof, and
    // `channel-outside-slide` is the check that says so.
    return {
      enclosed: false,
      reason: 'The slide pocket opens every channel beneath it, until the glass goes on.',
    };
  }

  const splitInside = chipParams.splitHeight > 0 && chipParams.splitHeight < chipParams.baseThickness;
  if (!splitInside) {
    return {
      enclosed: true,
      reason:
        `The split height of ${chipParams.splitHeight} mm falls outside the ${chipParams.baseThickness} mm block, ` +
        'so no cut is made and the chip prints as one sealed piece.',
    };
  }

  return { enclosed: false, reason: 'The two-piece split opens every channel along the cut plane.' };
}

// ---------------------------------------------------------------------------
// distance to the nearest opening
// ---------------------------------------------------------------------------

/** A binary min-heap of `[priority, id]`, just enough for Dijkstra. */
class MinHeap {
  private items: [number, string][] = [];

  push(priority: number, id: string): void {
    const items = this.items;
    items.push([priority, id]);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent][0] <= items[i][0]) break;
      [items[parent], items[i]] = [items[i], items[parent]];
      i = parent;
    }
  }

  pop(): [number, string] | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0 && last) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < items.length && items[left][0] < items[smallest][0]) smallest = left;
        if (right < items.length && items[right][0] < items[smallest][0]) smallest = right;
        if (smallest === i) break;
        [items[smallest], items[i]] = [items[i], items[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}

/**
 * Along-channel distance from every node to the nearest opening, in mm.
 *
 * Openings are ports and any existing vents. Unreachable nodes come back as
 * `Infinity`, which is the strongest possible signal that they need a vent.
 */
export function distanceToOpening(
  graph: ChannelGraph,
  vents: DrainageVent[] = [],
): Map<string, number> {
  const nodes = nodeIndex(graph.nodes);
  const adjacency = buildAdjacency(graph.edges);
  const openings = new Set<string>();

  for (const node of graph.nodes) if (node.type === 'port') openings.add(node.id);
  for (const vent of vents) if (vent.nodeId) openings.add(vent.nodeId);

  const dist = new Map<string, number>();
  for (const node of graph.nodes) dist.set(node.id, Infinity);

  // Dijkstra from all openings at once, off a binary heap. A stale entry (a
  // node already settled at a shorter distance) is skipped when popped rather
  // than removed when superseded, which keeps the heap trivial.
  const visited = new Set<string>();
  const heap = new MinHeap();
  for (const id of openings) {
    dist.set(id, 0);
    heap.push(0, id);
  }

  for (let entry = heap.pop(); entry; entry = heap.pop()) {
    const [best, current] = entry;
    if (visited.has(current)) continue;
    visited.add(current);

    const from = nodes.get(current);
    if (!from) continue;

    for (const edge of edgesFrom(adjacency, current)) {
      const otherId = edge.fromNodeId === current ? edge.toNodeId : edge.fromNodeId;
      const to = nodes.get(otherId);
      if (!to) continue;

      const step = distance(nodePoint(from), nodePoint(to));
      const candidate = best + step;
      if (candidate < (dist.get(otherId) ?? Infinity)) {
        dist.set(otherId, candidate);
        heap.push(candidate, otherId);
      }
    }
  }

  return dist;
}

// ---------------------------------------------------------------------------
// where to put vents
// ---------------------------------------------------------------------------

export type DrainReason = 'unreachable' | 'dead-end' | 'far-from-opening' | 'chamber';

export interface DrainagePoint {
  nodeId: string;
  point: Point2;
  reason: DrainReason;
  /** Along-channel distance to the nearest opening; Infinity when unreachable. */
  distanceMm: number;
}

/**
 * Nodes that would benefit from a vent, worst first.
 *
 * Existing vents count as openings, so running this after placing some finds
 * only what is still trapped — the helper is idempotent rather than piling vents
 * on top of each other.
 */
export function findDrainagePoints(
  graph: ChannelGraph,
  vents: DrainageVent[] = [],
): DrainagePoint[] {
  if (graph.edges.length === 0) return [];

  const dist = distanceToOpening(graph, vents);
  const nodes = nodeIndex(graph.nodes);
  const adjacency = buildAdjacency(graph.edges);
  const degree = (id: string) => edgesFrom(adjacency, id).length;
  const vented = new Set(vents.map((v) => v.nodeId).filter(Boolean) as string[]);
  const points: DrainagePoint[] = [];
  const claimed = new Set<string>();

  const consider = (nodeId: string, reason: DrainReason) => {
    if (claimed.has(nodeId) || vented.has(nodeId)) return;
    const node = nodes.get(nodeId);
    if (!node || node.type === 'port') return;
    claimed.add(nodeId);
    points.push({
      nodeId,
      point: nodePoint(node),
      reason,
      distanceMm: dist.get(nodeId) ?? Infinity,
    });
  };

  // 1. Islands with no opening at all — one vent per component is the minimum
  //    that makes them drainable.
  for (const component of connectedComponents(graph)) {
    if (component.edgeIds.length === 0) continue;
    const hasOpening =
      component.portIds.length > 0 || component.nodeIds.some((id) => vented.has(id));
    if (hasOpening) continue;

    // Vent the two extremities, so there is a through-path for resin and air.
    const ordered = [...component.nodeIds].sort((a, b) => degree(a) - degree(b));
    for (const id of ordered.slice(0, 2)) consider(id, 'unreachable');
  }

  // 2. Blind branches — nothing can flush through them.
  for (const node of graph.nodes) {
    if (node.type === 'port') continue;
    if (degree(node.id) === 1) consider(node.id, 'dead-end');
  }

  // 3. Local maxima of distance-to-opening: the far corners of the network.
  for (const node of graph.nodes) {
    const own = dist.get(node.id) ?? Infinity;
    if (!Number.isFinite(own) || own < VENT_DISTANCE_THRESHOLD_MM) continue;

    const neighbours = edgesFrom(adjacency, node.id).map((edge) =>
      edge.fromNodeId === node.id ? edge.toNodeId : edge.fromNodeId,
    );
    const isPeak = neighbours.every((id) => (dist.get(id) ?? Infinity) <= own);
    if (isPeak) consider(node.id, 'far-from-opening');
  }

  return points.sort((a, b) => b.distanceMm - a.distanceMm);
}

/**
 * Every vent needed to make the whole network drainable, in one pass.
 *
 * `findDrainagePoints` is single-pass by design: it answers "what is undrained
 * *right now*", which is what the warnings list needs. But venting the worst
 * spot shortens the escape path and reveals the next-worst, so a single pass is
 * not the whole job — and a "one-click" helper that has to be clicked three
 * times is not one-click.
 *
 * This iterates to convergence, feeding each round's vents back in as openings.
 * It terminates because every round adds at least one opening and openings only
 * ever shorten distances; the iteration cap is belt-and-braces.
 */
export function planDrainage(
  graph: ChannelGraph,
  existingVents: DrainageVent[] = [],
  maxRounds = 12,
): DrainagePoint[] {
  const planned: DrainagePoint[] = [];
  let vents = [...existingVents];

  for (let round = 0; round < maxRounds; round += 1) {
    const points = findDrainagePoints(graph, vents);
    if (points.length === 0) break;
    planned.push(...points);
    vents = [...vents, ...ventsForPoints(points)];
  }

  return planned;
}

/** Turns drainage points into vents ready to add to the project. */
export function ventsForPoints(
  points: DrainagePoint[],
  diameterMm = DEFAULT_VENT_DIAMETER_MM,
): DrainageVent[] {
  return points.map((point) => ({
    id: newId(),
    nodeId: point.nodeId,
    diameterMm,
    autoPlaced: true,
  }));
}

// ---------------------------------------------------------------------------
// warnings
// ---------------------------------------------------------------------------

/**
 * The vents whose node is still in the graph.
 *
 * Deleting a node does not touch `drainageVents` — they live on the project,
 * not the graph, and pruning them there would lose them to an undo of the
 * delete. So every consumer filters instead: an orphan vent drills nothing,
 * and must not be counted as an opening either.
 */
export function liveVents(graph: ChannelGraph, vents: DrainageVent[]): DrainageVent[] {
  const ids = new Set(graph.nodes.map((n) => n.id));
  return vents.filter((v) => ids.has(v.nodeId));
}

export function checkDrainage(input: ValidationInput & { vents?: DrainageVent[] }): Warning[] {
  const { graph, chipParams } = input;
  const vents = liveVents(graph, input.vents ?? []);
  const warnings: Warning[] = [];

  const enclosure = enclosureState(chipParams);
  if (!enclosure.enclosed || graph.edges.length === 0) return warnings;

  const loft = getLoft(graph, chipParams);
  // Section areas by the real profile: a round channel holds π/4 of its
  // bounding square, a trapezoid less than its top width suggests.
  const areaMm2 = (section: CrossSection, widthMm: number, heightMm: number) =>
    ductGeometry(section, widthMm, heightMm).areaM2 * 1e6;
  let trappedVolume = 0;
  for (const edge of graph.edges) {
    const solved = loft.edges.get(edge.id);
    if (!solved) continue;
    for (let i = 1; i < solved.samples.length; i += 1) {
      const a = solved.samples[i - 1];
      const b = solved.samples[i];
      const step = distance(a.point, b.point);
      const area =
        (areaMm2(edge.crossSection, a.widthMm, a.heightMm) +
          areaMm2(edge.crossSection, b.widthMm, b.heightMm)) /
        2;
      trappedVolume += area * step;
    }
  }

  const points = findDrainagePoints(graph, vents);

  warnings.push({
    id: 'enclosed-cavity',
    kind: 'enclosed-cavity',
    severity: vents.length > 0 || points.length === 0 ? 'info' : 'caution',
    title: vents.length > 0 ? `Channels are sealed — ${vents.length} vent${vents.length === 1 ? '' : 's'} added` : 'Channels are fully enclosed',
    detail:
      `${enclosure.reason} Roughly ${mm(trappedVolume)} mm³ of uncured resin sits inside after printing, and it will ` +
      'set solid unless it can be flushed out. ' +
      (vents.length > 0
        ? 'The vents you added give it a path out.'
        : 'Add drainage holes, or switch to a two-piece split so the channels are open until you bond the lid on.'),
    target: { nodeIds: [], edgeIds: [] },
  });

  for (const point of points) {
    warnings.push({
      id: `undrained:${point.nodeId}`,
      kind: 'undrained-region',
      severity: point.reason === 'unreachable' ? 'caution' : 'info',
      title:
        point.reason === 'unreachable'
          ? 'This section has no path to any opening'
          : point.reason === 'dead-end'
            ? 'Blind branch will hold resin'
            : `Furthest point from an opening — ${mm(point.distanceMm)} mm of channel away`,
      detail:
        point.reason === 'unreachable'
          ? 'Resin here cannot reach a port at all. A vent is the only way to clear it.'
          : point.reason === 'dead-end'
            ? 'A branch with one end closed cannot be flushed: pushing solvent in has nowhere to push the resin out to.'
            : 'Resin has a long way to travel to escape. A vent here shortens the path and lets air in behind it.',
      measurement: Number.isFinite(point.distanceMm)
        ? { value: point.distanceMm, limit: VENT_DISTANCE_THRESHOLD_MM, unit: 'mm' }
        : undefined,
      target: { nodeIds: [point.nodeId], edgeIds: [], focus: point.point },
    });
  }

  return warnings;
}
