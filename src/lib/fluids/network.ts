/**
 * Flow distribution through the channel network.
 *
 * A laminar channel network is a linear resistor network: ΔP = R·Q is Ohm's
 * law, junctions conserve volume the way nodes conserve current, and the whole
 * thing solves by nodal analysis. Guessing that flow splits evenly at a
 * junction would be wrong whenever the branches differ in width or length,
 * which is most of the time — a branch twice as wide carries roughly sixteen
 * times the flow.
 *
 * Inlets are flow sources (a syringe pump delivers a set rate regardless of
 * back-pressure); outlets are pressure references at ambient. That matches how
 * these chips are actually driven.
 */

export interface NetworkEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  /** Pa·s/m³. */
  resistance: number;
}

export interface NetworkInput {
  nodeIds: string[];
  edges: NetworkEdge[];
  /** Volumetric flow injected at a node, m³/s. Positive is into the chip. */
  injections: Map<string, number>;
  /** Nodes held at a fixed gauge pressure, Pa. Normally the outlets, at 0. */
  fixedPressures: Map<string, number>;
}

export interface NetworkSolution {
  /** Gauge pressure at each node, Pa. */
  pressures: Map<string, number>;
  /** Volumetric flow through each edge, m³/s. Positive means from → to. */
  flows: Map<string, number>;
  /** True when the system was solvable; false leaves the maps empty. */
  solved: boolean;
  reason?: string;
}

/**
 * How small a pivot may get, relative to the largest conductance, before the
 * node it belongs to counts as cut off from every outlet. Real links in one
 * design span a few orders of magnitude at most; round-off sits near 1e-16.
 */
const SINGULAR_PIVOT_RATIO = 1e-12;

/**
 * Solves G·P = Q by Gaussian elimination with partial pivoting.
 *
 * Networks here are tens of nodes, so a dense direct solve is both simplest and
 * fastest — an iterative method would need tuning and could fail to converge on
 * the stiff resistance ratios a tapered channel produces.
 */
export function solveNetwork(input: NetworkInput): NetworkSolution {
  const { nodeIds, edges, injections, fixedPressures } = input;

  const free = nodeIds.filter((id) => !fixedPressures.has(id));
  if (free.length === 0) {
    // Everything is pinned; flows still follow directly from the pressures.
    return finish(nodeIds, edges, new Map(fixedPressures));
  }
  if (fixedPressures.size === 0) {
    return {
      pressures: new Map(),
      flows: new Map(),
      solved: false,
      reason: 'The network has no outlet, so there is no pressure reference to solve against.',
    };
  }

  const index = new Map(free.map((id, i) => [id, i]));
  const n = free.length;

  // Conductance matrix, augmented with the right-hand side.
  const A: number[][] = Array.from({ length: n }, () => new Array(n + 1).fill(0));

  for (const id of free) {
    A[index.get(id) as number][n] = injections.get(id) ?? 0;
  }

  // The singular-pivot test has to be relative. Conductances are SI, and a
  // fine channel carrying a viscous fluid is ~1e-19 m³/(Pa·s): an absolute
  // floor anywhere near that reads a connected network as disconnected.
  let gMax = 0;

  for (const edge of edges) {
    if (!Number.isFinite(edge.resistance) || edge.resistance <= 0) continue;
    const g = 1 / edge.resistance;
    if (g > gMax) gMax = g;

    const a = index.get(edge.fromNodeId);
    const b = index.get(edge.toNodeId);
    const pa = fixedPressures.get(edge.fromNodeId);
    const pb = fixedPressures.get(edge.toNodeId);

    if (a !== undefined) A[a][a] += g;
    if (b !== undefined) A[b][b] += g;

    if (a !== undefined && b !== undefined) {
      A[a][b] -= g;
      A[b][a] -= g;
    } else if (a !== undefined && pb !== undefined) {
      // The fixed node's contribution moves to the right-hand side.
      A[a][n] += g * pb;
    } else if (b !== undefined && pa !== undefined) {
      A[b][n] += g * pa;
    }
  }

  // --- Gaussian elimination -------------------------------------------------
  // A pivot this far below the stiffest link is round-off from cancelling
  // terms, not a real conductance: nothing ties that node to an outlet.
  const singular = SINGULAR_PIVOT_RATIO * gMax;
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(A[row][col]) > Math.abs(A[pivot][col])) pivot = row;
    }
    if (Math.abs(A[pivot][col]) <= singular) {
      return {
        pressures: new Map(),
        flows: new Map(),
        solved: false,
        reason:
          'Part of the network is isolated from any outlet, so its flow is undetermined. Connect it, or add a port.',
      };
    }
    [A[col], A[pivot]] = [A[pivot], A[col]];

    for (let row = col + 1; row < n; row += 1) {
      const factor = A[row][col] / A[col][col];
      if (factor === 0) continue;
      for (let k = col; k <= n; k += 1) A[row][k] -= factor * A[col][k];
    }
  }

  const solution = new Array(n).fill(0);
  for (let row = n - 1; row >= 0; row -= 1) {
    let sum = A[row][n];
    for (let k = row + 1; k < n; k += 1) sum -= A[row][k] * solution[k];
    solution[row] = sum / A[row][row];
  }

  const pressures = new Map(fixedPressures);
  for (const [id, i] of index) pressures.set(id, solution[i]);

  return finish(nodeIds, edges, pressures);
}

function finish(
  nodeIds: string[],
  edges: NetworkEdge[],
  pressures: Map<string, number>,
): NetworkSolution {
  const flows = new Map<string, number>();
  for (const edge of edges) {
    const from = pressures.get(edge.fromNodeId) ?? 0;
    const to = pressures.get(edge.toNodeId) ?? 0;
    flows.set(
      edge.id,
      Number.isFinite(edge.resistance) && edge.resistance > 0 ? (from - to) / edge.resistance : 0,
    );
  }
  void nodeIds;
  return { pressures, flows, solved: true };
}

// ---------------------------------------------------------------------------
// downstream traversal
// ---------------------------------------------------------------------------

/**
 * Orders edges so every edge comes after the ones feeding it.
 *
 * Needed to propagate fluid identity and temperature downstream: you cannot
 * work out what is in a segment until you know what arrives at its upstream
 * node. Uses the solved flow directions, so it follows where the fluid actually
 * goes rather than how the user happened to draw the arrows.
 *
 * Falls back to declaration order for any edges caught in a cycle — a
 * recirculating loop has no well-defined start, and refusing to report anything
 * would be worse than reporting an arbitrary but stable order.
 */
export function downstreamOrder(
  edges: NetworkEdge[],
  flows: Map<string, number>,
  inletNodeIds: string[],
): { edgeId: string; fromNodeId: string; toNodeId: string }[] {
  // Orient each edge along its actual flow.
  const directed = edges.map((edge) => {
    const q = flows.get(edge.id) ?? 0;
    return q >= 0
      ? { edgeId: edge.id, fromNodeId: edge.fromNodeId, toNodeId: edge.toNodeId }
      : { edgeId: edge.id, fromNodeId: edge.toNodeId, toNodeId: edge.fromNodeId };
  });

  const incoming = new Map<string, number>();
  const outgoing = new Map<string, typeof directed>();
  for (const edge of directed) {
    incoming.set(edge.toNodeId, (incoming.get(edge.toNodeId) ?? 0) + 1);
    const list = outgoing.get(edge.fromNodeId);
    if (list) list.push(edge);
    else outgoing.set(edge.fromNodeId, [edge]);
  }

  const ordered: typeof directed = [];
  const emitted = new Set<string>();
  const pending = new Map(incoming);
  const queue = [...inletNodeIds];

  // Seed with any node nothing flows into, not just the declared inlets.
  for (const edge of directed) {
    if ((pending.get(edge.fromNodeId) ?? 0) === 0 && !queue.includes(edge.fromNodeId)) {
      queue.push(edge.fromNodeId);
    }
  }

  while (queue.length > 0) {
    const node = queue.shift() as string;
    for (const edge of outgoing.get(node) ?? []) {
      if (emitted.has(edge.edgeId)) continue;
      emitted.add(edge.edgeId);
      ordered.push(edge);

      const left = (pending.get(edge.toNodeId) ?? 1) - 1;
      pending.set(edge.toNodeId, left);
      if (left <= 0) queue.push(edge.toNodeId);
    }
  }

  for (const edge of directed) {
    if (!emitted.has(edge.edgeId)) ordered.push(edge);
  }

  return ordered;
}
