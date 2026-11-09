/**
 * Default-export regression baseline.
 *
 * Every starter template and every shipped example project is exported the way
 * the app exports it — STL at export quality, OpenSCAD source and the schematic
 * SVG — and the bytes are compared with a recorded baseline in
 * `golden/default-exports.json`. A change that is meant to leave the default
 * export alone has to leave every one of these files byte-identical.
 *
 * The baseline stores a SHA-256 of each file rather than the file: nine chips'
 * worth of binary STL is tens of megabytes, which does not belong in the
 * repository. Beside each hash it keeps the byte length and, for STL, the
 * triangle count, volume and bounding box, so a mismatch reports *what* moved
 * rather than only that something did.
 *
 * Byte equality is achievable because the exporter is deterministic: the graph
 * builders are pure, manifold-3d runs single-threaded as WASM, and the STL
 * writer emits triangles in the order the kernel returns them. This file builds
 * each chip twice and asserts that directly, so a kernel upgrade that broke the
 * assumption would say so here instead of producing a flaky baseline.
 *
 * To record a new baseline after an intended change to default output:
 *
 *   UPDATE_GOLDEN=1 npm test -- goldenExport
 *
 * and say in the pull request why the default export changed.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeAll, describe, it } from 'vitest';
import Module from 'manifold-3d';
import { DEFAULT_CHIP_PARAMS } from '../defaults';
import { CHIP_PRESETS, presetBuild } from '../presets';
import { parseProject } from '../projectFile';
import { exportSchematicSvg } from '../svgExport';
import { buildChip, type ChipPiece, type ManifoldApi } from './buildChip';
import { exportScad } from './scadExport';
import { exportStl, stlTriangleCount } from './stlExport';
import type { ChannelGraph, ChipParams, DrainageVent } from '../../types/project';

const GOLDEN_PATH = join(process.cwd(), 'src/lib/cad/golden/default-exports.json');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

/** The quality `buildForExport` requests. */
const EXPORT_QUALITY = 2;

interface Design {
  id: string;
  name: string;
  graph: ChannelGraph;
  chipParams: ChipParams;
  drainageVents: DrainageVent[];
}

interface GoldenFile {
  sha256: string;
  bytes: number;
  triangles?: number;
  volumeMm3?: number;
  boundsMm?: number[];
}

type GoldenDesign = Record<string, GoldenFile>;

let api: ManifoldApi;

beforeAll(async () => {
  const raw = await Module();
  raw.setup();
  api = { Manifold: raw.Manifold, Mesh: raw.Mesh } as unknown as ManifoldApi;
}, 60_000);

// ---------------------------------------------------------------------------
// the designs
// ---------------------------------------------------------------------------

function designs(): Design[] {
  const out: Design[] = CHIP_PRESETS.map((preset) => ({
    id: `template:${preset.id}`,
    name: preset.name,
    graph: presetBuild(preset).graph,
    chipParams: { ...DEFAULT_CHIP_PARAMS, ...preset.chipParams },
    drainageVents: [],
  }));

  // Saved files go through the real loader, so the baseline also covers what a
  // user's existing project exports as after a schema change.
  for (const dir of ['examples', 'skills/openchip-design/examples']) {
    const abs = join(process.cwd(), dir);
    for (const file of readdirSync(abs).filter((f) => f.endsWith('.openchip')).sort()) {
      const parsed = parseProject(readFileSync(join(abs, file), 'utf8'));
      assert.equal(parsed.ok, true, `${dir}/${file} should open`);
      if (!parsed.ok) continue;
      out.push({
        id: `file:${dir}/${file}`,
        name: parsed.project.meta.name,
        graph: parsed.project.channelGraph,
        chipParams: parsed.project.chipParams,
        drainageVents: parsed.project.drainageVents,
      });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// exporting, exactly as the CAD panel and the Draw tab do
// ---------------------------------------------------------------------------

const sha256 = (data: ArrayBuffer | string): string =>
  createHash('sha256')
    .update(typeof data === 'string' ? data : new Uint8Array(data))
    .digest('hex');

const round = (n: number, places: number): number => Number(n.toFixed(places));

function bounds(pieces: ChipPiece[]): number[] {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const piece of pieces) {
    for (let i = 0; i < piece.positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis += 1) {
        min[axis] = Math.min(min[axis], piece.positions[i + axis]);
        max[axis] = Math.max(max[axis], piece.positions[i + axis]);
      }
    }
  }
  return [...min, ...max].map((v) => round(v, 4));
}

function stlEntry(pieces: ChipPiece[], header: string): GoldenFile {
  const buffer = exportStl(pieces, header);
  return {
    sha256: sha256(buffer),
    bytes: buffer.byteLength,
    triangles: stlTriangleCount(buffer),
    volumeMm3: round(pieces.reduce((sum, p) => sum + p.volumeMm3, 0), 3),
    boundsMm: bounds(pieces),
  };
}

function exportAll(design: Design): GoldenDesign {
  const built = buildChip(api, design.graph, design.chipParams, {
    quality: EXPORT_QUALITY,
    drainageVents: design.drainageVents,
    includeChannelSolid: false,
  });
  const header = `OpenChip ${design.name}`;

  const files: GoldenDesign = { 'all.stl': stlEntry(built.pieces, header) };
  // The per-piece buttons a two-piece chip offers.
  for (const id of ['body', 'lid'] as const) {
    const piece = built.pieces.filter((p) => p.id === id);
    if (piece.length > 0) files[`${id}.stl`] = stlEntry(piece, header);
  }

  const scad = exportScad(design.graph, design.chipParams, {
    projectName: design.name,
    drainageVents: design.drainageVents,
  });
  files['source.scad'] = { sha256: sha256(scad), bytes: Buffer.byteLength(scad) };

  const svg = exportSchematicSvg(design.graph, design.chipParams);
  files['schematic.svg'] = { sha256: sha256(svg), bytes: Buffer.byteLength(svg) };

  return files;
}

// ---------------------------------------------------------------------------

describe('default export output', () => {
  const all = designs();
  const golden: Record<string, GoldenDesign> =
    !UPDATE && existsSync(GOLDEN_PATH) ? JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) : {};
  const recorded: Record<string, GoldenDesign> = {};

  it('covers every template and every shipped project file', () => {
    assert.ok(all.length >= CHIP_PRESETS.length + 2, `only ${all.length} designs`);
    if (!UPDATE) {
      assert.deepEqual(
        Object.keys(golden).sort(),
        all.map((d) => d.id).sort(),
        'the baseline and the shipped designs list different chips — record a new baseline',
      );
    }
  });

  for (const design of all) {
    it(`${design.id} exports byte-identically to the baseline`, () => {
      const first = exportAll(design);
      // The premise of comparing bytes at all: the same input twice gives the
      // same file twice.
      assert.deepEqual(exportAll(design), first, 'the exporter is not deterministic');

      recorded[design.id] = first;
      if (UPDATE) return;

      const expected = golden[design.id];
      assert.ok(expected, `no baseline for ${design.id} — run with UPDATE_GOLDEN=1`);
      // Whole-entry comparison, so a failure prints the triangle count, volume
      // and bounds next to the hash and shows which of them moved.
      assert.deepEqual(first, expected, `default export of ${design.id} changed`);
    }, 120_000);
  }

  it('records the baseline when asked to', () => {
    if (!UPDATE) return;
    mkdirSync(dirname(GOLDEN_PATH), { recursive: true });
    writeFileSync(GOLDEN_PATH, `${JSON.stringify(recorded, null, 2)}\n`);
  });
});
