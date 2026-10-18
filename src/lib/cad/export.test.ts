/**
 * Export format tests.
 *
 * An STL that a slicer rejects, or a `.scad` that OpenSCAD will not parse, are
 * both failures a screenshot cannot catch — so these check the bytes and the
 * syntax directly.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { DEFAULT_CHIP_PARAMS } from '../defaults';
import { portSpecFor } from '../ports';
import { fittingProfile } from './fittingProfile';
import { placeChannel } from './placement';
import { exportScad } from './scadExport';
import { exportStl, stlTriangleCount } from './stlExport';
import type { ChannelGraph } from '../../types/project';

const HEADER_BYTES = 80;
const TRIANGLE_BYTES = 50;

/** A unit tetrahedron plus a deliberately degenerate (zero-area) triangle. */
function meshWithDegenerate() {
  const positions = new Float32Array([
    0, 0, 0, // 0
    1, 0, 0, // 1
    0, 1, 0, // 2
    0, 0, 1, // 3
  ]);
  const indices = new Uint32Array([
    0, 2, 1,
    0, 1, 3,
    1, 2, 3,
    0, 3, 2,
    0, 1, 1, // zero area — two corners are the same vertex
  ]);
  return { positions, indices };
}

const sampleGraph = (): ChannelGraph => ({
  nodes: [
    {
      id: 'in',
      x: 8,
      y: 10,
      type: 'port',
      portType: 'luer-lock',
      diameterMm: 1.6,
      customSpec: {
        taperLargeDiameterMm: 4.27,
        taperSmallDiameterMm: 3.82,
        taperLengthMm: 7.5,
        bossHeightMm: 4,
        threadMajorDiameterMm: 7.6,
        threadPitchMm: 1.27,
        collarDepthMm: 5,
      },
    },
    { id: 'mid', x: 20, y: 30, type: 'chamber', shape: 'sphere', sizeMm: 3, autoPlaced: false },
    { id: 'out', x: 32, y: 50, type: 'port', portType: 'luer', diameterMm: 1.6 },
  ],
  edges: [
    {
      id: 'e1',
      fromNodeId: 'in',
      toNodeId: 'mid',
      curveType: 'straight',
      crossSection: 'rect',
      dimensionPoints: [{ t: 0, widthMm: 0.4, heightMm: 0.4 }],
    },
    {
      id: 'e2',
      fromNodeId: 'mid',
      toNodeId: 'out',
      curveType: 'straight',
      crossSection: 'round',
      dimensionPoints: [{ t: 1, widthMm: 1.2 }],
    },
  ],
});

// ---------------------------------------------------------------------------

describe('binary STL', () => {
  it('declares a facet count that matches the file length', () => {
    const mesh = meshWithDegenerate();
    const buffer = exportStl([mesh]);
    const count = stlTriangleCount(buffer);

    assert.equal(
      buffer.byteLength,
      HEADER_BYTES + 4 + count * TRIANGLE_BYTES,
      'a reader trusting the count must not run off the end',
    );
  });

  it('drops zero-area facets rather than writing a meaningless normal', () => {
    const mesh = meshWithDegenerate();
    const buffer = exportStl([mesh]);

    // Five triangles in, four real ones out.
    assert.equal(stlTriangleCount(buffer), 4);
  });

  it('writes unit-length normals', () => {
    const buffer = exportStl([meshWithDegenerate()]);
    const view = new DataView(buffer);
    const count = stlTriangleCount(buffer);

    for (let i = 0; i < count; i += 1) {
      const o = HEADER_BYTES + 4 + i * TRIANGLE_BYTES;
      const length = Math.hypot(
        view.getFloat32(o, true),
        view.getFloat32(o + 4, true),
        view.getFloat32(o + 8, true),
      );
      assert.ok(Math.abs(length - 1) < 1e-4, `facet ${i} normal length ${length}`);
    }
  });

  it('concatenates multiple pieces into one file', () => {
    const mesh = meshWithDegenerate();
    const single = stlTriangleCount(exportStl([mesh]));
    const double = stlTriangleCount(exportStl([mesh, mesh]));
    assert.equal(double, single * 2);
  });

  it('keeps the header inside its 80-byte field', () => {
    const buffer = exportStl([meshWithDegenerate()], 'x'.repeat(500));
    const count = stlTriangleCount(buffer);
    assert.equal(count, 4, 'an overlong header must not corrupt the count that follows it');
  });
});

// ---------------------------------------------------------------------------

describe('OpenSCAD source', () => {
  const source = exportScad(sampleGraph(), DEFAULT_CHIP_PARAMS, { projectName: 'Test chip' });

  const balanced = (open: string, close: string) => {
    let depth = 0;
    for (const ch of source) {
      if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth < 0) return false;
      }
    }
    return depth === 0;
  };

  it('is syntactically balanced', () => {
    assert.ok(balanced('{', '}'), 'braces');
    assert.ok(balanced('(', ')'), 'parens');
    assert.ok(balanced('[', ']'), 'brackets');
  });

  it('hoists the chip parameters so the file is editable', () => {
    for (const name of [
      'chip_width',
      'chip_length',
      'base_thickness',
      'split_height',
      'wall_thickness',
      'min_edge_spacing',
    ]) {
      assert.ok(new RegExp(`^${name} = `, 'm').test(source), `missing parameter ${name}`);
    }
  });

  it('uses primitives and operations rather than a polyhedron dump', () => {
    assert.ok(source.includes('difference()'));
    assert.ok(source.includes('hull()'));
    assert.ok(source.includes('cylinder('));
    assert.ok(source.includes('sphere('));
    assert.ok(source.includes('cube('));
    assert.ok(!source.includes('polyhedron('), 'a mesh dump would defeat the point of this export');
  });

  it('defines the modules the assembly refers to', () => {
    const defined = new Set(
      [...source.matchAll(/^module (\w+)\(/gm)].map((match) => match[1]),
    );
    for (const name of [
      'channels',
      'chambers',
      'port_cavities',
      'port_bosses',
      'chip_solid',
      'body_piece',
      'lid_piece',
    ]) {
      assert.ok(defined.has(name), `module ${name} is referenced but never defined`);
    }
  });

  it('states the thread simplification in the file itself', () => {
    // A user opening the .scad has no other way to learn the thread is an
    // approximation of the ISO form.
    assert.ok(/thread/i.test(source));
    assert.ok(/approximation/i.test(source));
  });

  it('grows a luer-lock thread instead of a counterbore that eats it', () => {
    const threads = source.slice(source.indexOf('module port_threads()'));
    const body = threads.slice(0, threads.indexOf('\n}'));
    assert.match(body, /linear_extrude\(height = [\d.]+, twist = -[\d.]+/, 'a right-handed rib');
    assert.match(source, /^\s+port_threads\(\);$/m, 'added to the chip, after the cut');
    // No full-width counterbore at the thread major diameter.
    assert.doesNotMatch(source, /cylinder\(h = [\d.]+, d = 7\.6, \$fn = feature_fn\)/);
  });

  it('emits no NaN or Infinity into the source', () => {
    assert.ok(!/NaN|Infinity/.test(source), 'a non-finite literal makes the file unparseable');
  });

  it('handles an empty graph without emitting a broken module', () => {
    const empty = exportScad({ nodes: [], edges: [] }, DEFAULT_CHIP_PARAMS);
    assert.ok(empty.includes('module channels()'));
    assert.ok(!/NaN/.test(empty));
  });

  it('drills the drainage vents the STL gets', () => {
    const graph = sampleGraph();
    const node = graph.nodes[1];
    const vent = { id: 'v1', nodeId: node.id, diameterMm: 1.2, autoPlaced: true };
    const orphan = { id: 'v2', nodeId: 'deleted', diameterMm: 1.2, autoPlaced: true };
    const withVents = exportScad(graph, DEFAULT_CHIP_PARAMS, { drainageVents: [vent, orphan] });

    const body = withVents.slice(withVents.indexOf('module drainage_vents()'));
    const bores = body.slice(0, body.indexOf('\n}')).split('\n').filter((l) => l.includes('cylinder('));
    assert.equal(bores.length, 1, 'one live vent, one orphan');
    assert.match(bores[0], new RegExp(`translate\\(\\[${node.x}(\\.0)?, ${node.y}(\\.0)?,`));
    assert.match(bores[0], /d = 1\.2/);
    assert.match(withVents, /^\s+drainage_vents\(\);$/m, 'the vents are part of the subtraction');
  });
});

// ---------------------------------------------------------------------------
// the two exporters describing one chip
// ---------------------------------------------------------------------------

describe('a height-tapered channel places features at their own end', () => {
  // Regression test. Anything sitting *at* a node — a chamber, a
  // port bore — has to be placed from the channel size there. Three of the six
  // sites read sample zero unconditionally instead, so on a taper the chamber
  // and the .scad's port bore landed at the far end's Z. That made the .scad
  // and the .stl two different solids for one design, silently.
  //
  // The taper runs one way across the whole chain, so each of the three nodes
  // sits at a different height and no site can pass by reading the wrong one.
  const WIDE = 0.8;
  const THIN = 0.2;
  const MID = 0.7;
  const THICK = 1.2;

  const graph = (): ChannelGraph => ({
    nodes: [
      { id: 'p1', x: 10, y: 10, type: 'port', portType: 'luer', diameterMm: 1.6 },
      { id: 'mid', x: 30, y: 10, type: 'chamber', shape: 'sphere', sizeMm: 3, autoPlaced: false },
      { id: 'p2', x: 50, y: 10, type: 'port', portType: 'luer', diameterMm: 1.6 },
    ],
    edges: [
      {
        id: 'e1',
        fromNodeId: 'p1',
        toNodeId: 'mid',
        curveType: 'straight',
        crossSection: 'rect',
        dimensionPoints: [
          { t: 0, widthMm: WIDE, heightMm: THIN },
          { t: 1, widthMm: WIDE, heightMm: MID },
        ],
      },
      {
        id: 'e2',
        fromNodeId: 'mid',
        toNodeId: 'p2',
        curveType: 'straight',
        crossSection: 'rect',
        dimensionPoints: [
          { t: 0, widthMm: WIDE, heightMm: MID },
          { t: 1, widthMm: WIDE, heightMm: THICK },
        ],
      },
    ],
  });

  const centreZ = (heightMm: number) =>
    placeChannel('rect', WIDE, heightMm, DEFAULT_CHIP_PARAMS.splitHeight).centerZ;

  const lines = exportScad(graph(), DEFAULT_CHIP_PARAMS).split('\n');
  const zOf = (line: string): number =>
    Number(/translate\(\[\s*[-\d.]+,\s*[-\d.]+,\s*([-\d.]+)\s*\]\)/.exec(line)?.[1]);
  const atX = (x: number) => (line: string) => line.includes(`translate([${x.toFixed(1)}, `);

  it('puts the chamber at the height of the end it touches', () => {
    const line = lines.find((l) => l.includes('sphere(d = 3'));
    assert.ok(line, 'no chamber emitted');

    const z = zOf(line);
    assert.ok(
      Math.abs(z - centreZ(MID)) < 1e-3,
      `chamber at ${z}, expected ${centreZ(MID)} for the ${MID} mm end it sits on`,
    );
    // What reading sample zero — the far end of the edge — would have given.
    assert.ok(Math.abs(z - centreZ(THIN)) > 0.1, 'chamber took the far end of its edge');
  });

  it('bores each port from its own end of the taper', () => {
    // The straight bore below the taper cone, emitted at channelZ - 0.01.
    const boreZ = (x: number) => {
      const line = lines.find((l) => atX(x)(l) && l.includes('d = 1.6'));
      assert.ok(line, `no bore emitted for the port at x=${x}`);
      return zOf(line) + 0.01;
    };

    assert.ok(Math.abs(boreZ(10) - centreZ(THIN)) < 1e-3, 'near port bore');
    assert.ok(
      Math.abs(boreZ(50) - centreZ(THICK)) < 1e-3,
      `far port bored at ${boreZ(50)}, expected ${centreZ(THICK)}`,
    );
  });
});

describe('OpenSCAD female port mouths', () => {
  // Each female type, one port per type, on a plain straight run.
  const types = ['luer', 'luer-lock', 'syringe', 'custom'] as const;
  const graph: ChannelGraph = {
    nodes: types.flatMap((portType, i) => [
      { id: `p${i}`, x: 10, y: 10 + i * 10, type: 'port' as const, portType, diameterMm: 1.6 },
      { id: `w${i}`, x: 30, y: 10 + i * 10, type: 'waypoint' as const },
    ]),
    edges: types.map((_, i) => ({
      id: `e${i}`,
      fromNodeId: `p${i}`,
      toNodeId: `w${i}`,
      curveType: 'straight' as const,
      crossSection: 'rect' as const,
      dimensionPoints: [],
    })),
  };
  const source = exportScad(graph, DEFAULT_CHIP_PARAMS);
  const cavities = source.slice(
    source.indexOf('module port_cavities()'),
    source.indexOf('\n}\n', source.indexOf('module port_cavities()')),
  );

  it('cuts every socket a hair past the top face, as the STL does', () => {
    const top = DEFAULT_CHIP_PARAMS.baseThickness;
    // The socket is the first cut under each port's comment; the bore to the
    // channel follows it.
    const lines = cavities.split('\n');
    const sockets = lines.filter((_, i) => i > 0 && / port at /.test(lines[i - 1]));
    assert.equal(sockets.length, types.length, cavities);
    for (const line of sockets) {
      const z = Number(/translate\(\[[^,]+,[^,]+,\s*([-\d.]+)\]\)/.exec(line)?.[1]);
      const h = Number(/cylinder\(h = ([-\d.]+)/.exec(line)?.[1]);
      assert.ok(z + h > top + 0.005, `socket ends at ${z + h}, flush with the ${top} mm face: ${line}`);
    }
  });
});

describe('the boss base fillet in the .scad and the drawing', () => {
  const portGraph = (portType: 'syringe' | 'luer-lock', spec: Record<string, number | string>): ChannelGraph => ({
    nodes: [
      { id: 'p', x: 20, y: 30, type: 'port', portType, diameterMm: 1.2, customSpec: spec },
      { id: 'w', x: 36, y: 30, type: 'waypoint' },
    ],
    edges: [
      { id: 'e', fromNodeId: 'p', toNodeId: 'w', curveType: 'straight', crossSection: 'rect', dimensionPoints: [] },
    ],
  });
  const bossCall = (source: string) => source.match(/boss\(r = [\d.]+, h = [\d.]+, fillet = ([\d.]+)\)/);

  it('emits the fillet the STL gets, as an editable argument', () => {
    const source = exportScad(portGraph('syringe', { ...portSpecFor('syringe'), bossFilletMm: 0.7 }), DEFAULT_CHIP_PARAMS);
    assert.ok(/^module boss\(r, h, fillet\)/m.test(source), 'boss() is called but never defined');
    assert.equal(bossCall(source)?.[1], '0.7');
  });

  it('defaults a port saved before the field existed to its type default', () => {
    const { bossFilletMm: _, ...legacy } = portSpecFor('syringe');
    assert.equal(bossCall(exportScad(portGraph('syringe', legacy), DEFAULT_CHIP_PARAMS))?.[1], '0.5');
  });

  it('leaves a luer-lock hub sharp by default, so the collar can seat', () => {
    const source = exportScad(portGraph('luer-lock', portSpecFor('luer-lock')), DEFAULT_CHIP_PARAMS);
    assert.equal(bossCall(source)?.[1], '0.0');
  });

  it('draws the fillet in the half-section', () => {
    const spec: Record<string, number | string> = { ...portSpecFor('syringe'), bossFilletMm: 1 };
    const radius = Number(spec.barrelDiameterMm) / 2 + 0.8;
    const sharp = fittingProfile('syringe', 1.2, { ...spec, bossFilletMm: 0 });
    const filleted = fittingProfile('syringe', 1.2, spec);
    // Sharp: the outer boundary steps straight from the slab to the boss wall.
    assert.ok(!sharp.outer.some((p) => p.z > 0.01 && p.z < 0.99 && p.r > radius + 1e-6));
    // Filleted: points between the face and 1 mm up sit outside the boss wall,
    // and none outside the fillet's full radius.
    const blend = filleted.outer.filter((p) => p.z > 0.01 && p.z < 0.99);
    assert.ok(blend.length > 0 && blend.every((p) => p.r > radius && p.r < radius + 1));
  });
});
