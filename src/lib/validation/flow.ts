/**
 * Can fluid actually get through this?
 *
 * Purely topological and geometric — no simulation. These are the problems that
 * make a chip unusable regardless of what the fluid is: a branch with nowhere
 * to go, an island the pump can never reach, a step change that will not fill
 * cleanly.
 */

import { buildAdjacency, edgesFrom, nodeIndex, nodePoint } from '../geometry';
import { buildChains, chainMarkers } from '../loft';
import type { ChannelEdge, ChannelGraph, Point2 } from '../../types/project';
import type { ValidationInput, Warning } from './types';

const mm = (n: number) => Math.round(n * 1000) / 1000;

// ---------------------------------------------------------------------------
// connectivity
// ---------------------------------------------------------------------------

interface Component {
  nodeIds: string[];
  edgeIds: string[];
  portIds: string[];
}

/** Splits the graph into connected components, noting which have ports. */
export function connectedComponents(graph: ChannelGraph): Component[] {
  const adjacency = new Map<string, { nodeId: string; edgeId: string }[]>();
  for (const edge of graph.edges) {
    const push = (from: string, to: string) => {
      const list = adjacency.get(from);
      const entry = { nodeId: to, edgeId: edge.id };
      if (list) list.push(entry);
      else adjacency.set(from, [entry]);
    };
    push(edge.fromNodeId, edge.toNodeId);
    push(edge.toNodeId, edge.fromNodeId);
  }

  const nodes = nodeIndex(graph.nodes);
  const seen = new Set<string>();
  const components: Component[] = [];

  for (const node of graph.nodes) {
    if (seen.has(node.id)) continue;

    const nodeIds: string[] = [];
    const edgeIds = new Set<string>();
    const portIds: string[] = [];
    const queue = [node.id];
    seen.add(node.id);

    while (queue.length > 0) {
      const current = queue.pop() as string;
      nodeIds.push(current);

      const currentNode = nodes.get(current);
      if (currentNode?.type === 'port') portIds.push(current);

      for (const link of adjacency.get(current) ?? []) {
        edgeIds.add(link.edgeId);
        if (!seen.has(link.nodeId)) {
          seen.add(link.nodeId);
          queue.push(link.nodeId);
        }
      }
    }

    components.push({ nodeIds, edgeIds: [...edgeIds], portIds });
  }

  return components;
}

/**
 * Branches that terminate without reaching a port.
 *
 * A degree-1 node that is not a port is a blind end: fluid entering it has
 * nowhere to go, so the branch fills with trapped air on the bench and trapped
 * resin on the printer.
 */
export function checkDeadEnds(input: ValidationInput): Warning[] {
  const { graph } = input;
  const warnings: Warning[] = [];
  const adjacency = buildAdjacency(graph.edges);

  for (const node of graph.nodes) {
    if (node.type === 'port') continue;

    const touching = edgesFrom(adjacency, node.id);
    if (touching.length !== 1) continue;

    warnings.push({
      id: `dead-end:${node.id}`,
      kind: 'dead-end-channel',
      severity: 'caution',
      title: 'Channel ends without a port',
      detail:
        'This branch stops in the middle of the chip. Fluid cannot flow through it, so it will trap air when you prime the chip ' +
        'and uncured resin when you print it. Add a port here, or delete the branch.',
      target: {
        nodeIds: [node.id],
        edgeIds: [touching[0].id],
        focus: nodePoint(node),
      },
    });
  }

  return warnings;
}

/** Islands the pump can never reach, and the no-ports-at-all case. */
export function checkConnectivity(input: ValidationInput): Warning[] {
  const { graph } = input;
  if (graph.edges.length === 0) return [];

  const components = connectedComponents(graph).filter((c) => c.edgeIds.length > 0);
  const warnings: Warning[] = [];

  const totalPorts = graph.nodes.filter((n) => n.type === 'port').length;
  if (totalPorts === 0) {
    warnings.push({
      id: 'no-ports',
      kind: 'no-ports',
      severity: 'risk',
      title: 'The chip has no ports',
      detail:
        'There is no way to get fluid in or out, and no opening for resin to drain through when printing. ' +
        'Place a port at each end of the network.',
      target: { nodeIds: [], edgeIds: [] },
    });
  }

  if (components.length > 1) {
    warnings.push({
      id: 'disconnected',
      kind: 'disconnected-network',
      severity: 'caution',
      title: `The network is in ${components.length} separate pieces`,
      detail:
        'These sub-networks do not connect to each other. That is fine if you meant to build independent channels, ' +
        'but a break you did not intend will stop fluid reaching part of the chip.',
      target: { nodeIds: [], edgeIds: [] },
    });
  }

  // A component with fewer than two ports cannot be flushed through, whatever
  // the rest of the chip looks like.
  for (const component of components) {
    if (totalPorts === 0) break;
    if (component.portIds.length >= 2) continue;

    const focusNode = graph.nodes.find((n) => component.nodeIds.includes(n.id));

    warnings.push({
      id: `unreachable:${component.edgeIds[0]}`,
      kind: component.portIds.length === 0 ? 'disconnected-network' : 'dead-end-channel',
      severity: component.portIds.length === 0 ? 'risk' : 'caution',
      title:
        component.portIds.length === 0
          ? 'A section of the network has no port at all'
          : 'A section has only one port',
      detail:
        component.portIds.length === 0
          ? 'Nothing connects this section to the outside, so it can never be filled or drained.'
          : 'With a single opening there is no through-path: fluid has nowhere to exit, and resin cannot be flushed out. Add a second port.',
      target: {
        nodeIds: component.nodeIds,
        edgeIds: component.edgeIds,
        focus: focusNode ? nodePoint(focusNode) : undefined,
      },
    });
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// taper
// ---------------------------------------------------------------------------

/**
 * Step changes in cross-section.
 *
 * Measured between consecutive dimension markers along a chain — which is the
 * same axis the loft interpolates on, so the ratio here is the ratio the solid
 * actually has. The distance is reported alongside, because a 3× change over
 * 20 mm is a gentle taper and the same change over 0.5 mm is a step.
 */
export function checkTaperRatio(input: ValidationInput): Warning[] {
  const { graph, settings } = input;
  const warnings: Warning[] = [];
  const nodes = nodeIndex(graph.nodes);

  const chains = buildChains(graph);

  for (const chain of chains) {
    const markers = chainMarkers(chain);
    if (markers.length < 2) continue;

    for (let i = 1; i < markers.length; i += 1) {
      const a = markers[i - 1];
      const b = markers[i];

      const larger = Math.max(a.widthMm, b.widthMm);
      const smaller = Math.min(a.widthMm, b.widthMm);
      if (smaller <= 0) continue;

      const ratio = larger / smaller;
      if (ratio < settings.taperRatioThreshold) continue;

      const spanMm = Math.abs(b.distanceMm - a.distanceMm);
      const halfAngle =
        spanMm > 1e-6
          ? (Math.atan(Math.abs(larger - smaller) / 2 / spanMm) * 180) / Math.PI
          : 90;

      const edge = chain.members.find((m) => m.edge.id === b.edgeId)?.edge;
      warnings.push({
        id: `taper:${a.edgeId}:${mm(a.distanceMm)}:${b.edgeId}:${mm(b.distanceMm)}`,
        kind: 'abrupt-taper',
        severity: ratio >= settings.taperRatioThreshold * 2 ? 'caution' : 'info',
        title: `Channel width changes ${ratio.toFixed(1)}× over ${mm(spanMm)} mm`,
        detail:
          `From ${mm(a.widthMm)} mm to ${mm(b.widthMm)} mm — a ${Math.round(halfAngle)}° taper. ` +
          'Sharp expansions shed vortices and can trap bubbles; sharp contractions raise pressure and shear. ' +
          `Your threshold is ${settings.taperRatioThreshold}×; spread the change over a longer run to soften it.`,
        measurement: { value: ratio, limit: settings.taperRatioThreshold, unit: '×' },
        target: {
          nodeIds: [],
          edgeIds: edge ? [edge.id] : [a.edgeId],
          focus: taperFocus(graph, b.edgeId, b.t, nodes),
        },
      });
    }
  }

  return warnings;
}

function taperFocus(
  graph: ChannelGraph,
  edgeId: string,
  t: number,
  nodes: Map<string, { x: number; y: number }>,
): Point2 | undefined {
  const edge: ChannelEdge | undefined = graph.edges.find((e) => e.id === edgeId);
  if (!edge) return undefined;
  const from = nodes.get(edge.fromNodeId);
  const to = nodes.get(edge.toNodeId);
  if (!from || !to) return undefined;
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
}
