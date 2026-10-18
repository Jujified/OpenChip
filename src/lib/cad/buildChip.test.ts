/**
 * CSG pipeline tests, run against the real manifold-3d WASM.
 *
 * Geometry is the one area where "it looked right in the viewport" is worth
 * very little — an inverted solid, a non-watertight sweep or a split that does
 * not recombine all render plausibly and all produce an unprintable STL. These
 * assert the invariants a printable part actually depends on.
 */

import assert from 'node:assert/strict';
import { beforeAll, describe, it } from 'vitest';
import Module from 'manifold-3d';
import { DEFAULT_CHIP_PARAMS } from '../defaults';
import { PORT_PRESETS, portSpecFor } from '../ports';
import { buildChip, type ManifoldApi } from './buildChip';
import { placeChannel, profilePoints } from './placement';
import { channelPlaneZ, slidePocket } from './slide';
import { sweepStations, planarFrame, helixStations } from './sweep';
import type { ChannelGraph, ChannelNode, ChipParams } from '../../types/project';

let api: ManifoldApi;
let raw: Awaited<ReturnType<typeof Module>>;

beforeAll(async () => {
  raw = await Module();
  raw.setup();
  api = { Manifold: raw.Manifold, Mesh: raw.Mesh } as unknown as ManifoldApi;
}, 60_000);

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function straightChannel(overrides: Partial<ChipParams> = {}) {
  const graph: ChannelGraph = {
    nodes: [
      { id: 'a', x: 10, y: 10, type: 'waypoint' },
      { id: 'b', x: 30, y: 10, type: 'waypoint' },
    ],
    edges: [
      {
        id: 'e1',
        fromNodeId: 'a',
        toNodeId: 'b',
        curveType: 'straight',
        crossSection: 'rect',
        dimensionPoints: [],
      },
    ],
  };
  return { graph, chipParams: { ...DEFAULT_CHIP_PARAMS, ...overrides } };
}

/** A serpentine with ports and chambers. */
function serpentine(): { graph: ChannelGraph; chipParams: ChipParams } {
  const nodes: ChannelNode[] = [];
  const edges: ChannelGraph['edges'] = [];
  let n = 0;

  const add = (node: ChannelNode) => {
    nodes.push(node);
    return node.id;
  };
  const link = (from: string, to: string) =>
    edges.push({
      id: `e${edges.length}`,
      fromNodeId: from,
      toNodeId: to,
      curveType: 'straight',
      crossSection: 'rect',
      dimensionPoints: [],
    });

  let prev = add({
    id: `n${n++}`,
    x: 6,
    y: 25,
    type: 'port',
    portType: 'luer',
    diameterMm: PORT_PRESETS.luer.defaultBoreMm,
    customSpec: portSpecFor('luer'),
  });

  const cols = [6, 12, 18, 24, 30, 36];
  for (let i = 0; i < cols.length; i += 1) {
    const y = i % 2 === 0 ? 35 : 15;
    const turn = add({
      id: `n${n++}`,
      x: cols[i],
      y,
      type: 'chamber',
      shape: 'sphere',
      sizeMm: 2.4,
      autoPlaced: true,
    });
    link(prev, turn);
    if (i < cols.length - 1) {
      const next = add({
        id: `n${n++}`,
        x: cols[i + 1],
        y,
        type: 'chamber',
        shape: 'sphere',
        sizeMm: 2.4,
        autoPlaced: true,
      });
      link(turn, next);
      prev = next;
    } else {
      prev = turn;
    }
  }

  const outlet = add({
    id: `n${n++}`,
    x: 36,
    y: 25,
    type: 'port',
    portType: 'luer-lock',
    diameterMm: PORT_PRESETS['luer-lock'].defaultBoreMm,
    customSpec: portSpecFor('luer-lock'),
  });
  link(prev, outlet);

  // A taper across the whole chain.
  edges[0].dimensionPoints = [{ t: 0, widthMm: 0.4, heightMm: 0.5 }];
  edges[edges.length - 1].dimensionPoints = [{ t: 1, widthMm: 1.6, heightMm: 0.5 }];

  return { graph: { nodes, edges }, chipParams: DEFAULT_CHIP_PARAMS };
}

// ---------------------------------------------------------------------------
// sweep primitive
// ---------------------------------------------------------------------------

describe('sweep primitive', () => {
  const frame = planarFrame(1, 0);

  it('produces the exact volume for a constant rectangular section', () => {
    const stations = Array.from({ length: 11 }, (_, i) => ({
      center: { x: i, y: 0, z: 0 },
      across: frame.across,
      up: frame.up,
      profile: profilePoints('rect', 0.8, 0.5, 4),
    }));

    const mesh = sweepStations(stations);
    assert.ok(mesh);
    const solid = api.Manifold.ofMesh(new api.Mesh({ numProp: 3, ...mesh }));

    assert.ok(Math.abs(solid.volume() - 10 * 0.8 * 0.5) < 1e-4, `got ${solid.volume()}`);
  });

  it('produces the exact volume for a linear taper', () => {
    const stations = Array.from({ length: 21 }, (_, i) => {
      const t = i / 20;
      return {
        center: { x: i * 0.5, y: 0, z: 0 },
        across: frame.across,
        up: frame.up,
        profile: profilePoints('rect', 0.4 + 1.2 * t, 0.5, 4),
      };
    });

    const mesh = sweepStations(stations);
    assert.ok(mesh);
    const solid = api.Manifold.ofMesh(new api.Mesh({ numProp: 3, ...mesh }));

    // Average width × height × length.
    assert.ok(Math.abs(solid.volume() - 10 * 1.0 * 0.5) < 1e-4, `got ${solid.volume()}`);
  });

  it('self-corrects handedness so a helix is not inside-out', () => {
    // Regression: the helix frame is the mirror of a straight run, and without
    // the winding flip it produced a negative-volume (inverted) solid that
    // silently complemented every later boolean.
    const mesh = sweepStations(
      helixStations({
        radiusMm: 3.8,
        pitchMm: 1.27,
        turns: 3,
        startZ: 0,
        profile: [
          { u: -0.2, v: -0.3 },
          { u: 0.25, v: 0 },
          { u: -0.2, v: 0.3 },
        ],
        segmentsPerTurn: 48,
      }),
    );
    assert.ok(mesh);

    const solid = api.Manifold.ofMesh(new api.Mesh({ numProp: 3, ...mesh }));
    assert.ok(solid.volume() > 0, `helix must have positive volume, got ${solid.volume()}`);
    assert.ok(!solid.isEmpty());
  });

  it('refuses degenerate input rather than emitting an invalid mesh', () => {
    assert.equal(sweepStations([]), null);
    assert.equal(
      sweepStations([
        { center: { x: 0, y: 0, z: 0 }, across: frame.across, up: frame.up, profile: [] },
      ]),
      null,
    );
  });
});

// ---------------------------------------------------------------------------
// placement
// ---------------------------------------------------------------------------

describe('channel placement', () => {
  it('hangs a rectangular channel below the split plane, leaving a flat lid', () => {
    const place = placeChannel('rect', 0.8, 0.5, 2);
    assert.equal(place.centerZ, 1.75);
    assert.equal(place.halfHeight, 0.25);
    assert.equal(place.straddlesSplit, false);
    // Ceiling lands exactly on the cut.
    assert.equal(place.centerZ + place.halfHeight, 2);
  });

  it('centers a round channel on the split plane', () => {
    // A circle tangent to the cut would leave a re-entrant, unprintable lip.
    const place = placeChannel('round', 0.8, 0.5, 2);
    assert.equal(place.centerZ, 2);
    assert.equal(place.halfHeight, 0.4);
    assert.equal(place.straddlesSplit, true);
  });

  it('drafts a trapezoid wide-side-up towards the open face', () => {
    const points = profilePoints('trapezoid', 1, 0.5, 4);
    const top = points.filter((p) => p.v > 0);
    const bottom = points.filter((p) => p.v < 0);
    const topWidth = Math.max(...top.map((p) => p.u)) - Math.min(...top.map((p) => p.u));
    const bottomWidth = Math.max(...bottom.map((p) => p.u)) - Math.min(...bottom.map((p) => p.u));
    assert.ok(topWidth > bottomWidth, 'the opening must be the wide end');
  });
});

// ---------------------------------------------------------------------------
// pipeline
// ---------------------------------------------------------------------------

describe('chip pipeline', () => {
  it('removes channel volume from the block', () => {
    const { graph, chipParams } = straightChannel({ splitType: 'monolithic' });
    const result = buildChip(api, graph, chipParams);

    assert.equal(result.pieces.length, 1);
    const block = chipParams.width * chipParams.length * chipParams.baseThickness;
    const chip = result.pieces[0].volumeMm3;

    assert.ok(chip < block, 'the channel must remove material');
    assert.ok(chip > block * 0.99, 'a single hair-thin channel should barely dent it');
    assert.ok(result.stats.channelVolumeMm3 > 0);
  });

  it('splits two-piece into a channel plate and a lid that recombine exactly', () => {
    const { graph, chipParams } = straightChannel({ splitType: 'two-piece' });

    const split = buildChip(api, graph, chipParams);
    const whole = buildChip(api, graph, { ...chipParams, splitType: 'monolithic' });

    assert.equal(split.pieces.length, 2);
    assert.deepEqual(
      split.pieces.map((p) => p.id).sort(),
      ['body', 'lid'],
    );

    const sum = split.pieces.reduce((total, p) => total + p.volumeMm3, 0);
    // The two halves must account for exactly the same material as the
    // un-split chip, or they would not bond back into the same part.
    assert.ok(
      Math.abs(sum - whole.pieces[0].volumeMm3) < 1e-3,
      `halves ${sum} vs whole ${whole.pieces[0].volumeMm3}`,
    );
  });

  it('leaves the lid solid for a rectangular channel', () => {
    // The channel hangs below the cut, so all of it belongs to the body and
    // the lid is a plain slab.
    const { graph, chipParams } = straightChannel({ splitType: 'two-piece' });
    const result = buildChip(api, graph, chipParams);

    const lid = result.pieces.find((p) => p.id === 'lid');
    assert.ok(lid);
    const expected =
      chipParams.width * chipParams.length * (chipParams.baseThickness - chipParams.splitHeight);
    assert.ok(Math.abs(lid.volumeMm3 - expected) < 1e-3, `lid ${lid.volumeMm3} vs slab ${expected}`);
  });

  it('grooves both halves for a round channel, because it splits through center', () => {
    const { graph, chipParams } = straightChannel({ splitType: 'two-piece' });
    graph.edges[0].crossSection = 'round';

    const result = buildChip(api, graph, chipParams);
    const lid = result.pieces.find((p) => p.id === 'lid');
    assert.ok(lid);

    const slab =
      chipParams.width * chipParams.length * (chipParams.baseThickness - chipParams.splitHeight);
    assert.ok(lid.volumeMm3 < slab - 1e-4, 'the lid must carry the upper half of the bore');
  });

  it('warns without failing when the split plane is outside the block', () => {
    const { graph, chipParams } = straightChannel({ splitType: 'two-piece', splitHeight: 9 });
    const result = buildChip(api, graph, chipParams);

    assert.equal(result.pieces.length, 1);
    assert.ok(result.warnings.some((w) => /split height/i.test(w)));
  });

  it('builds a full serpentine with ports, chambers and a taper', () => {
    const { graph, chipParams } = serpentine();
    const result = buildChip(api, graph, chipParams, { quality: 1 });

    assert.ok(result.pieces.length >= 1);
    assert.equal(result.stats.portCount, 2);
    assert.ok(result.stats.chamberCount >= 6);
    assert.ok(result.stats.triangleCount > 1000);
    assert.equal(result.stats.usedThreadApproximation, true, 'the luer-lock thread is generated');

    for (const piece of result.pieces) {
      assert.ok(piece.volumeMm3 > 0, `${piece.id} must have positive volume`);
      assert.equal(piece.positions.length % 3, 0);
      assert.equal(piece.indices.length % 3, 0);
      assert.ok(piece.indices.length > 0);
      const maxIndex = piece.indices.reduce((m, v) => (v > m ? v : m), 0);
      assert.ok(maxIndex < piece.positions.length / 3, 'indices must stay in range');
    }
  });

  // The isolate-channels view renders the cavity as if it were a part. The
  // danger is not that it looks wrong — it is that the negative space leaks
  // into somewhere that treats it as material: the chip volume, the triangle
  // count, the toolbar's piece list, or worst, an exported STL.
  describe('the channel solid', () => {
    it('is not built unless it is asked for', () => {
      const { graph, chipParams } = serpentine();
      assert.equal(buildChip(api, graph, chipParams).channelSolid, null);
    });

    it('is the cavity, and stays out of pieces and stats', () => {
      const { graph, chipParams } = serpentine();
      const plain = buildChip(api, graph, chipParams, { quality: 1 });
      const withChannels = buildChip(api, graph, chipParams, {
        quality: 1,
        includeChannelSolid: true,
      });

      const solid = withChannels.channelSolid;
      assert.ok(solid, 'the cavity must come back when requested');
      assert.equal(solid.id, 'channels');
      assert.ok(solid.volumeMm3 > 0);
      assert.ok(solid.indices.length > 0);
      const maxIndex = solid.indices.reduce((m, v) => (v > m ? v : m), 0);
      assert.ok(maxIndex < solid.positions.length / 3, 'indices must stay in range');

      // Asking for it must not change the chip in any way a consumer can see.
      assert.deepEqual(
        withChannels.pieces.map((p) => p.id),
        plain.pieces.map((p) => p.id),
      );
      assert.deepEqual(withChannels.stats, plain.stats);
      assert.ok(
        !withChannels.pieces.some((p) => p.id === 'channels'),
        'the cavity is not a piece of the chip',
      );
    });

    it('accounts for the material the chip is missing', () => {
      // The cavity is what was subtracted, so the block minus the chip is the
      // cavity — exactly, for this fixture. It is two waypoints and one
      // channel, with no port or boss to put any of the cavity above the top
      // face, which is what would make the two differ.
      const { graph, chipParams } = straightChannel({ splitType: 'monolithic' });
      const result = buildChip(api, graph, chipParams, { includeChannelSolid: true });

      const block = chipParams.width * chipParams.length * chipParams.baseThickness;
      const removed = block - result.pieces[0].volumeMm3;
      const solid = result.channelSolid;

      assert.ok(solid);
      assert.ok(removed > 0, 'the channel must remove material');
      assert.ok(
        Math.abs(solid.volumeMm3 - removed) < 1e-3,
        `cavity ${solid.volumeMm3} vs removed ${removed}`,
      );
    });
  });

  it('respects live parameter changes', () => {
    const { graph } = straightChannel();

    const thin = buildChip(api, graph, {
      ...DEFAULT_CHIP_PARAMS,
      splitType: 'monolithic',
      baseThickness: 4,
    });
    const thick = buildChip(api, graph, {
      ...DEFAULT_CHIP_PARAMS,
      splitType: 'monolithic',
      baseThickness: 8,
    });

    assert.ok(thick.pieces[0].volumeMm3 > thin.pieces[0].volumeMm3 * 1.9);
  });

  // Male fittings are the first geometry in this pipeline that adds a *shaped*
  // solid above the face rather than cutting one out of the block. The failure
  // to catch is silent: if the additive mesh is dropped, the chip still builds
  // and still looks like a chip — it just has no fitting on it.
  describe.each(['luer-male', 'barb'] as const)('a %s port', (portType) => {
    const withPort = () => {
      const { graph, chipParams } = straightChannel({ splitType: 'monolithic' });
      const ported: ChannelGraph = {
        ...graph,
        nodes: graph.nodes.map((node) =>
          node.id === 'a'
            ? ({
                id: 'a',
                x: 10,
                y: 10,
                type: 'port',
                portType,
                diameterMm: PORT_PRESETS[portType].defaultBoreMm,
                customSpec: portSpecFor(portType),
              } as ChannelNode)
            : node,
        ),
      };
      return { graph: ported, chipParams };
    };

    it('adds material above the block instead of only cutting into it', () => {
      const { graph, chipParams } = withPort();
      const result = buildChip(api, graph, chipParams);
      const block = chipParams.width * chipParams.length * chipParams.baseThickness;

      // The channel and bore remove a few mm³; the pedestal and spigot add
      // more than that back. A port that only subtracted could never exceed
      // the plain block.
      assert.ok(
        result.pieces[0].volumeMm3 > block,
        `a male fitting must add net volume: got ${result.pieces[0].volumeMm3} against a ${block} block`,
      );
    });

    const spigotLength = () => {
      const spec = portSpecFor(portType) as Record<string, number>;
      return portType === 'luer-male' ? spec.taperLengthMm : spec.barbLengthMm;
    };

    it('stands taller than the chip it sits on', () => {
      const { graph, chipParams } = withPort();
      const spec = portSpecFor(portType) as Record<string, number>;
      const expected = chipParams.baseThickness + spec.bossHeightMm + spigotLength();

      const result = buildChip(api, graph, chipParams);
      const { positions } = result.pieces[0];
      let top = -Infinity;
      for (let i = 2; i < positions.length; i += 3) top = Math.max(top, positions[i]);

      assert.ok(
        Math.abs(top - expected) < 0.05,
        `fitting should reach ${expected} mm, reached ${top}`,
      );
    });

    it('keeps the bore open through the tip', () => {
      // A bored spigot and a solid one look identical from outside, so the
      // bore is proved by its sensitivity: widening it has to remove material
      // from the spigot as well as from the block. If the bore stopped at the
      // chip face, widening it could not account for this much.
      const { graph, chipParams } = withPort();
      const widen = (g: ChannelGraph, diameterMm: number): ChannelGraph => ({
        ...g,
        nodes: g.nodes.map((node) =>
          node.type === 'port' ? ({ ...node, diameterMm } as ChannelNode) : node,
        ),
      });

      const narrow = buildChip(api, widen(graph, 1.6), chipParams).pieces[0].volumeMm3;
      const wide = buildChip(api, widen(graph, 2.4), chipParams).pieces[0].volumeMm3;

      const throughSpigot = ((Math.PI / 4) * (2.4 ** 2 - 1.6 ** 2) * spigotLength());
      assert.ok(
        narrow - wide > throughSpigot,
        `widening the bore removed ${(narrow - wide).toFixed(2)} mm³, less than the ` +
          `${throughSpigot.toFixed(2)} mm³ the spigot alone accounts for — the bore stops short of the tip`,
      );
    });
  });

  it('handles an empty graph without producing an empty chip', () => {
    const result = buildChip(api, { nodes: [], edges: [] }, DEFAULT_CHIP_PARAMS);
    const total = result.pieces.reduce((s, p) => s + p.volumeMm3, 0);
    assert.ok(Math.abs(total - 40 * 60 * 4) < 1e-6, 'a plain block, uncut');
  });
});

// ---------------------------------------------------------------------------

describe('the glass slide pocket', () => {
  /** A chip big enough for the standard slide, with one channel across it. */
  const slideChip = (overrides: Partial<ChipParams> = {}) =>
    straightChannel({
      splitType: 'glass-slide',
      width: 90,
      length: 40,
      baseThickness: 4,
      ...overrides,
    });

  it('cuts a pocket the size of the slide plus its clearance', () => {
    const { graph, chipParams } = slideChip();
    const plain = buildChip(api, graph, { ...chipParams, splitType: 'monolithic' });
    const slide = buildChip(api, graph, chipParams);

    const pocket = slidePocket(chipParams);
    assert.ok(pocket);
    assert.equal(pocket.pocket.width, 75.4);
    assert.equal(pocket.pocket.length, 25.4);
    assert.equal(pocket.floorZ, 3);

    // The pocket removes its own volume, less the channel already missing from
    // the region it takes away.
    const removed = plain.stats.chipVolumeMm3 - slide.stats.chipVolumeMm3;
    const nominal = pocket.pocket.width * pocket.pocket.length * pocket.depthMm;
    assert.ok(
      removed > nominal * 0.99 && removed < nominal * 1.01,
      `expected roughly ${nominal} mm³ removed, got ${removed}`,
    );
  });

  it('opens the channels onto the pocket floor', () => {
    const { graph, chipParams } = slideChip();
    const slide = buildChip(api, graph, chipParams);

    // The channel's ceiling is the pocket floor, so the groove is open: the
    // solid's volume equals the block, less the pocket, less the groove — with
    // no roof left over the channel to account for.
    const plane = channelPlaneZ(chipParams);
    assert.equal(plane, chipParams.baseThickness - chipParams.slide.thicknessMm);

    // And the part is one piece, not a body and a lid.
    assert.equal(slide.pieces.length, 1);
    assert.equal(slide.pieces[0].id, 'solid');
    assert.equal(slide.pieces[0].label, 'Channel plate');
  });

  it('hands back the glass without letting it into the printed part', () => {
    const { graph, chipParams } = slideChip();
    const slide = buildChip(api, graph, chipParams);

    assert.ok(slide.slideSolid);
    assert.equal(slide.slideSolid.id, 'slide');
    assert.equal(slide.slideSolid.label, 'Glass slide');

    const glass = chipParams.slide;
    const volume = glass.widthMm * glass.lengthMm * glass.thicknessMm;
    assert.ok(Math.abs(slide.slideSolid.volumeMm3 - volume) < 1e-6);

    // Not a piece, so it is not summed into the chip volume, not counted in the
    // triangle total, and cannot reach an STL.
    assert.ok(!slide.pieces.some((piece) => piece.id === 'slide'));
    assert.equal(
      slide.stats.chipVolumeMm3,
      slide.pieces.reduce((sum, piece) => sum + piece.volumeMm3, 0),
    );
  });

  it('ignores split height entirely, so no roof can be left over a channel', () => {
    const { graph, chipParams } = slideChip({ splitHeight: 2 });
    const wrongPlane = buildChip(api, graph, chipParams);
    const otherPlane = buildChip(api, graph, { ...chipParams, splitHeight: 0.5 });

    // Same part either way: the channels are placed against the pocket floor,
    // not against a field the geometry has no use for. If split height ever
    // leaked back into a slide chip, the two would differ by a roof.
    assert.equal(wrongPlane.stats.chipVolumeMm3, otherPlane.stats.chipVolumeMm3);
    assert.equal(wrongPlane.stats.channelVolumeMm3, otherPlane.stats.channelVolumeMm3);
  });

  it('leaves every other split type without a slide', () => {
    for (const splitType of ['two-piece', 'monolithic'] as const) {
      const { graph, chipParams } = slideChip({ splitType });
      assert.equal(buildChip(api, graph, chipParams).slideSolid, null);
      assert.equal(slidePocket(chipParams), null);
    }
  });

  it('warns rather than collapsing when the slide is thicker than the chip', () => {
    const { graph, chipParams } = slideChip({ baseThickness: 1 });
    const result = buildChip(api, graph, chipParams);
    assert.ok(result.warnings.some((w) => w.includes('whole')));
  });
});

describe('a chamber on a height-tapered channel', () => {
  // Regression test. The chamber was once placed from `samples[0]` — the size at
  // the edge's `from` end — regardless of which end it actually sat on. The
  // observable that isolates it: describe the same physical chip with the edge
  // running each way. The markers flip with the edge, so the taper stays put
  // and the solid must not change. It did, by the chamber's Z offset.
  const chip = (reversed: boolean): ChannelGraph => ({
    nodes: [
      { id: 'a', x: 10, y: 10, type: 'waypoint' },
      { id: 'b', x: 30, y: 10, type: 'chamber', shape: 'sphere', sizeMm: 3, autoPlaced: false },
    ],
    edges: [
      {
        id: 'e1',
        fromNodeId: reversed ? 'b' : 'a',
        toNodeId: reversed ? 'a' : 'b',
        curveType: 'straight',
        crossSection: 'rect',
        // a is always the thin end, b always the thick one.
        dimensionPoints: reversed
          ? [
              { t: 0, widthMm: 0.8, heightMm: 1.2 },
              { t: 1, widthMm: 0.8, heightMm: 0.2 },
            ]
          : [
              { t: 0, widthMm: 0.8, heightMm: 0.2 },
              { t: 1, widthMm: 0.8, heightMm: 1.2 },
            ],
      },
    ],
  });

  it('is placed the same however the edge is oriented', () => {
    const forward = buildChip(api, chip(false), DEFAULT_CHIP_PARAMS).stats.channelVolumeMm3;
    const backward = buildChip(api, chip(true), DEFAULT_CHIP_PARAMS).stats.channelVolumeMm3;

    assert.ok(
      Math.abs(forward - backward) < 1e-6,
      `cavity volume depends on edge direction: ${forward} vs ${backward}`,
    );
  });
});

// ---------------------------------------------------------------------------

describe('WASM memory', () => {
  /**
   * Records every Manifold handed out while `run` executes, by wrapping the
   * factories and the methods that return new solids. embind never frees a
   * Manifold on its own, so anything still alive afterwards is a leak.
   */
  function trackCreated(run: () => void) {
    type Handle = { isDeleted(): boolean };
    const created: Handle[] = [];
    const restore: Array<() => void> = [];
    const wrap = (target: Record<string, unknown>, name: string) => {
      const original = target[name] as (...args: unknown[]) => unknown;
      target[name] = function (this: unknown, ...args: unknown[]) {
        const out = original.apply(this, args);
        for (const solid of Array.isArray(out) ? out : [out]) created.push(solid as Handle);
        return out;
      };
      restore.push(() => {
        target[name] = original;
      });
    };
    const statics = raw.Manifold as unknown as Record<string, unknown>;
    const proto = raw.Manifold.prototype as unknown as Record<string, unknown>;
    for (const name of ['cube', 'cylinder', 'sphere', 'ofMesh', 'union']) wrap(statics, name);
    for (const name of ['add', 'subtract', 'translate', 'splitByPlane']) wrap(proto, name);
    try {
      run();
    } finally {
      for (const undo of restore) undo();
    }
    return created;
  }

  const busyGraph: ChannelGraph = {
    nodes: [
      { id: 'in', x: 8, y: 10, type: 'port', portType: 'luer-lock', diameterMm: 1.6 },
      { id: 'j', x: 20, y: 20, type: 'waypoint' },
      { id: 'c', x: 30, y: 30, type: 'chamber', shape: 'cylinder', sizeMm: 4, autoPlaced: false },
      { id: 'out', x: 30, y: 50, type: 'port', portType: 'luer-male', diameterMm: 1.6 },
      { id: 'side', x: 8, y: 40, type: 'waypoint' },
    ],
    edges: [
      { id: 'e1', fromNodeId: 'in', toNodeId: 'j', curveType: 'straight', crossSection: 'round', dimensionPoints: [] },
      { id: 'e2', fromNodeId: 'j', toNodeId: 'c', curveType: 'straight', crossSection: 'rect', dimensionPoints: [] },
      { id: 'e3', fromNodeId: 'c', toNodeId: 'out', curveType: 'straight', crossSection: 'rect', dimensionPoints: [] },
      { id: 'e4', fromNodeId: 'j', toNodeId: 'side', curveType: 'straight', crossSection: 'rect', dimensionPoints: [] },
    ],
  };

  const cases: Array<[string, ChipParams]> = [
    ['two-piece', DEFAULT_CHIP_PARAMS],
    ['monolithic', { ...DEFAULT_CHIP_PARAMS, splitType: 'monolithic' }],
    ['glass-slide', { ...DEFAULT_CHIP_PARAMS, splitType: 'glass-slide', width: 90, length: 60 }],
  ];

  it.each(cases)('frees every solid it creates on a %s chip', (_label, chipParams) => {
    const created = trackCreated(() => {
      const result = buildChip(api, busyGraph, chipParams, {
        includeChannelSolid: true,
        drainageVents: [{ id: 'v1', nodeId: 'side', diameterMm: 1, autoPlaced: false }],
      });
      assert.ok(result.pieces.length > 0);
    });

    assert.ok(created.length > 10, `only saw ${created.length} solids — is the tracker wired up?`);
    const alive = created.filter((solid) => !solid.isDeleted());
    assert.equal(alive.length, 0, `${alive.length} of ${created.length} solids were never deleted`);
  });
});

// ---------------------------------------------------------------------------

describe('the luer-lock port', () => {
  const spec = portSpecFor('luer-lock');
  const graph: ChannelGraph = {
    nodes: [
      { id: 'p', x: 20, y: 30, type: 'port', portType: 'luer-lock', diameterMm: 1.6, customSpec: spec },
      { id: 'w', x: 36, y: 30, type: 'waypoint' },
    ],
    edges: [
      { id: 'e', fromNodeId: 'p', toNodeId: 'w', curveType: 'straight', crossSection: 'rect', dimensionPoints: [] },
    ],
  };
  const chipParams: ChipParams = { ...DEFAULT_CHIP_PARAMS, splitType: 'monolithic' };
  const hubTop = chipParams.baseThickness + Number(spec.bossHeightMm);

  const solid = () => {
    const piece = buildChip(api, graph, chipParams, { quality: 2 }).pieces[0];
    return raw.Manifold.ofMesh(
      new raw.Mesh({ numProp: 3, vertProperties: piece.positions, triVerts: piece.indices }),
    );
  };
  /** Material in a thin disc around the port axis, as a fraction of the disc. */
  const fillAt = (chip: ReturnType<typeof solid>, z: number, r0: number, r1: number) => {
    const ring = raw.Manifold.cylinder(0.02, r1, r1, 96, true)
      .subtract(raw.Manifold.cylinder(0.04, r0, r0, 96, true))
      .translate([20, 30, z]);
    const inside = chip.intersect(ring);
    const fill = inside.volume() / ring.volume();
    ring.delete();
    inside.delete();
    return fill;
  };

  it('keeps the whole taper socket wall', () => {
    const chip = solid();
    const large = Number(spec.taperLargeDiameterMm) / 2;
    const length = Number(spec.taperLengthMm);
    // Just outside the socket, down the 6% taper to where the channel comes
    // in from the side. The old counterbore left nothing here for 5.5 mm.
    for (const depth of [0.3, 2, 4, 5.4, length - 1.5]) {
      const fill = fillAt(chip, hubTop - depth, large + 0.1, large + 0.5);
      assert.ok(fill > 0.95, `only ${(fill * 100).toFixed(0)}% wall at ${depth} mm below the mouth`);
    }
    // And the socket itself is open at the mouth, at its specified diameter.
    const mouth = fillAt(chip, hubTop - 0.3, 0.05, large - 0.1);
    assert.ok(mouth < 0.01, `the socket mouth is ${(mouth * 100).toFixed(0)}% blocked`);
    chip.delete();
  });

  it('has a real thread standing on the hub', () => {
    const chip = solid();
    const major = Number(spec.threadMajorDiameterMm) / 2;
    const crest = Math.min(0.8, Number(spec.threadPitchMm) * 0.6);
    // Between the hub and the thread's crest there is only thread, so any
    // material in that band is the rib. The old one was cut into the air.
    let found = 0;
    for (let z = chipParams.baseThickness + 0.5; z < hubTop - 0.5; z += 0.25) {
      found = Math.max(found, fillAt(chip, z, major - crest + 0.1, major - 0.1));
    }
    assert.ok(found > 0.05, 'no thread material found beside the hub');
    chip.delete();
  });
});

// ---------------------------------------------------------------------------

describe('the boss base fillet', () => {
  const chipParams: ChipParams = { ...DEFAULT_CHIP_PARAMS, splitType: 'monolithic' };
  const graphWith = (bossFilletMm: number): ChannelGraph => ({
    nodes: [
      {
        id: 'p',
        x: 20,
        y: 30,
        type: 'port',
        portType: 'syringe',
        diameterMm: 1.2,
        customSpec: { ...portSpecFor('syringe'), bossHeightMm: 2, bossFilletMm },
      },
      { id: 'w', x: 36, y: 30, type: 'waypoint' },
    ],
    edges: [
      { id: 'e', fromNodeId: 'p', toNodeId: 'w', curveType: 'straight', crossSection: 'rect', dimensionPoints: [] },
    ],
  });
  const volume = (fillet: number) =>
    buildChip(api, graphWith(fillet), chipParams, { quality: 2 }).stats.chipVolumeMm3;

  it('adds the volume of a revolved fillet, and nothing when it is 0', () => {
    const sharp = volume(0);
    const fillet = 1;
    // Boss radius for a syringe port: barrel radius + 0.8 mm of wall.
    const radius = Number(portSpecFor('syringe').barrelDiameterMm) / 2 + 0.8;
    // Pappus: the spandrel's area times the circle its centroid sweeps. The
    // centroid sits (10 − 3π) / (3(4 − π)) · f out from the boss wall.
    const area = fillet * fillet * (1 - Math.PI / 4);
    const centroid = radius + (fillet * (10 - 3 * Math.PI)) / (3 * (4 - Math.PI));
    const expected = 2 * Math.PI * centroid * area;

    const added = volume(fillet) - sharp;
    assert.ok(
      Math.abs(added - expected) / expected < 0.05,
      `fillet added ${added.toFixed(4)} mm³, expected about ${expected.toFixed(4)}`,
    );
  });

  it('keeps the chip a single watertight solid of the same topology', () => {
    const solidFor = (fillet: number) => {
      const result = buildChip(api, graphWith(fillet), chipParams, { quality: 1 });
      assert.equal(result.pieces.length, 1);
      const piece = result.pieces[0];
      return raw.Manifold.ofMesh(
        new raw.Mesh({ numProp: 3, vertProperties: piece.positions, triVerts: piece.indices }),
      );
    };
    const sharp = solidFor(0);
    const filleted = solidFor(0.8);
    assert.equal(filleted.status(), 'NoError');
    // A blend adds material around the boss; it must not open or close a hole.
    assert.equal(filleted.genus(), sharp.genus());
    sharp.delete();
    filleted.delete();
  });

  it('never grows taller than the boss', () => {
    // Asking for 5 mm on a 2 mm boss clamps to 2 mm: the same part either way.
    assert.ok(Math.abs(volume(5) - volume(2)) < 1e-6);
  });
});
