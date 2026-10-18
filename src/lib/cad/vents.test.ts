import assert from 'node:assert/strict';
import { beforeAll, describe, it } from 'vitest';
import Module from 'manifold-3d';
import { DEFAULT_CHIP_PARAMS } from '../defaults';
import { buildChip, type ManifoldApi } from './buildChip';
import { planDrainage, ventsForPoints } from '../validation';
import type { ChannelGraph } from '../../types/project';

let api: ManifoldApi;
beforeAll(async () => { const w = await Module(); w.setup(); api = { Manifold: w.Manifold, Mesh: w.Mesh } as never; }, 60000);

const graph: ChannelGraph = {
  nodes: [
    { id: 'inlet', x: 8, y: 10, type: 'port', portType: 'luer', diameterMm: 1.6 },
    { id: 'a', x: 8, y: 30, type: 'waypoint' },
    { id: 'b', x: 25, y: 30, type: 'waypoint' },
    { id: 'outlet', x: 32, y: 50, type: 'port', portType: 'luer', diameterMm: 1.6 },
    { id: 'blind', x: 25, y: 45, type: 'waypoint' },
  ],
  edges: [
    { id: 'e1', fromNodeId: 'inlet', toNodeId: 'a', curveType: 'straight', crossSection: 'rect', dimensionPoints: [] },
    { id: 'e2', fromNodeId: 'a', toNodeId: 'b', curveType: 'straight', crossSection: 'rect', dimensionPoints: [] },
    { id: 'e3', fromNodeId: 'b', toNodeId: 'outlet', curveType: 'straight', crossSection: 'rect', dimensionPoints: [] },
    { id: 'e4', fromNodeId: 'b', toNodeId: 'blind', curveType: 'straight', crossSection: 'rect', dimensionPoints: [] },
  ],
};
const mono = { ...DEFAULT_CHIP_PARAMS, splitType: 'monolithic' as const };

describe('drainage vents in the solid', () => {
  it('removes extra material and reports the count', () => {
    const without = buildChip(api, graph, mono);
    const vents = ventsForPoints(planDrainage(graph));
    const withVents = buildChip(api, graph, mono, { drainageVents: vents });

    assert.equal(without.stats.ventCount, 0);
    assert.equal(withVents.stats.ventCount, vents.length);
    assert.ok(vents.length >= 3);

    // Each bore is real material taken out of the block.
    assert.ok(
      withVents.pieces[0].volumeMm3 < without.pieces[0].volumeMm3,
      'vents must actually cut the solid',
    );
  });

  it('breaks through the top surface', () => {
    const vents = ventsForPoints(planDrainage(graph));
    const withVents = buildChip(api, graph, mono, { drainageVents: vents });

    // A bore that stopped short would leave the resin just as trapped. Check
    // there is now open geometry at the top face above a vent node.
    const piece = withVents.pieces[0];
    const target = graph.nodes.find((n) => n.id === vents[0].nodeId)!;
    let foundNearTop = false;
    for (let i = 0; i < piece.positions.length; i += 3) {
      const x = piece.positions[i], y = piece.positions[i + 1], z = piece.positions[i + 2];
      if (Math.abs(z - mono.baseThickness) < 1e-3 && Math.hypot(x - target.x, y - target.y) < 1.0) {
        foundNearTop = true;
        break;
      }
    }
    assert.ok(foundNearTop, 'the vent bore must reach the top face');
  });

  it('ignores a vent whose node was deleted', () => {
    const orphan = [{ id: 'v1', nodeId: 'gone', diameterMm: 0.8, autoPlaced: true }];
    const result = buildChip(api, graph, mono, { drainageVents: orphan });
    assert.equal(result.stats.ventCount, 0);
    assert.ok(result.pieces.length > 0, 'and must not break the build');
  });
});
