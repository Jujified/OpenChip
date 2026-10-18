/**
 * The channel-spacing check has to stay cheap on big designs: it runs on every
 * drag frame. These pin that far-apart channels are dismissed from their
 * bounding boxes, without ever comparing samples.
 */

import assert from 'node:assert/strict';
import { describe, it, vi } from 'vitest';
import { DEFAULT_CHIP_PARAMS, PRINTER_PRESETS } from '../defaults';
import { DEFAULT_VALIDATION_SETTINGS } from './types';
import type { ChannelGraph } from '../../types/project';

const calls = vi.hoisted(() => ({ distance: 0 }));
vi.mock('../geometry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../geometry')>();
  return {
    ...actual,
    distance: (...args: Parameters<typeof actual.distance>) => {
      calls.distance += 1;
      return actual.distance(...args);
    },
  };
});

const { checkChannelSpacing } = await import('./manufacturability');

/** `count` parallel horizontal channels, `pitch` mm apart centre to centre. */
function parallel(count: number, pitch: number): ChannelGraph {
  const graph: ChannelGraph = { nodes: [], edges: [] };
  for (let i = 0; i < count; i += 1) {
    graph.nodes.push(
      { id: `a${i}`, x: 0, y: i * pitch, type: 'waypoint' },
      { id: `b${i}`, x: 30, y: i * pitch, type: 'waypoint' },
    );
    graph.edges.push({
      id: `e${i}`,
      fromNodeId: `a${i}`,
      toNodeId: `b${i}`,
      curveType: 'straight',
      crossSection: 'rect',
      dimensionPoints: [{ t: 0, widthMm: 0.5 }],
    });
  }
  return graph;
}

const run = (graph: ChannelGraph) =>
  checkChannelSpacing({
    graph,
    chipParams: DEFAULT_CHIP_PARAMS,
    printerProfile: PRINTER_PRESETS[0].profile,
    settings: DEFAULT_VALIDATION_SETTINGS,
  });

describe('channel spacing on large designs', () => {
  it('flags channels that are too close, as before', () => {
    // 0.5 mm wide on a 0.9 mm pitch leaves 0.4 mm of wall.
    const warnings = run(parallel(2, 0.9));
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].kind, 'channels-too-close');
    assert.equal(warnings[0].id, 'spacing:e0:e1');
    assert.ok(Math.abs(warnings[0].measurement!.value - 0.4) < 1e-9);
  });

  it('dismisses far-apart channels without comparing their samples', () => {
    calls.distance = 0;
    // 200 channels 10 mm apart: 19,900 pairs, none anywhere near a wall's width.
    const warnings = run(parallel(200, 10));
    assert.equal(warnings.length, 0);
    assert.equal(calls.distance, 0, `${calls.distance} sample comparisons for pairs 10 mm apart`);
  });
});
