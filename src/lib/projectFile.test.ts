/**
 * Round-trip and validation tests for the `.openchip` format.
 *
 * Run with `npm test`. Vitest is used rather than `node --test` so the modules
 * resolve through Vite exactly as they do in the app.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { createProject, DEFAULT_CHIP_PARAMS, PRINTER_PRESETS } from './defaults';
import { parseProject, serializeProject, stampForSave, suggestedFileName } from './projectFile';
import type { OpenChipProject } from '../types/project';

const sampleProject = (): OpenChipProject => {
  const project = createProject({
    name: 'Serpentine mixer v1',
    printerProfile: PRINTER_PRESETS[1].profile,
  });

  // A project with real content exercises more of the schema than an empty one.
  project.channelGraph = {
    nodes: [
      { id: 'n1', x: 5, y: 5, type: 'port', portType: 'luer', diameterMm: 1.6 },
      { id: 'n2', x: 20, y: 30, type: 'waypoint' },
      { id: 'n3', x: 35, y: 55, type: 'chamber', shape: 'sphere', sizeMm: 3, autoPlaced: true },
    ],
    edges: [
      {
        id: 'e1',
        fromNodeId: 'n1',
        toNodeId: 'n2',
        curveType: 'straight',
        crossSection: 'rect',
        dimensionPoints: [
          { t: 0, widthMm: 0.8, heightMm: 0.5 },
          { t: 1, widthMm: 1.4, heightMm: 0.5 },
        ],
      },
      {
        id: 'e2',
        fromNodeId: 'n2',
        toNodeId: 'n3',
        curveType: 'bezier',
        controlPoints: [
          { x: 25, y: 38 },
          { x: 30, y: 47 },
        ],
        crossSection: 'round',
        dimensionPoints: [{ t: 0.5, widthMm: 1.2 }],
      },
    ],
  };

  return project;
};

// ---------------------------------------------------------------------------

describe('new project defaults', () => {
  it('applies the default chip parameters', () => {
    const { chipParams } = createProject();
    assert.equal(chipParams.width, 40);
    assert.equal(chipParams.length, 60);
    assert.equal(chipParams.baseThickness, 4);
    assert.equal(chipParams.wallThickness, 2);
    assert.equal(chipParams.minEdgeSpacing, 3);
    assert.equal(chipParams.splitType, 'two-piece');
    assert.deepEqual(chipParams, DEFAULT_CHIP_PARAMS);
  });

  it('starts with an empty channel graph', () => {
    const { channelGraph } = createProject();
    assert.deepEqual(channelGraph, { nodes: [], edges: [] });
  });

  it('carries the printer profile it was given', () => {
    const project = createProject({ printerProfile: PRINTER_PRESETS[2].profile });
    assert.equal(project.printerProfile.name, 'Large-format resin printer');
    assert.equal(project.printerProfile.xyResolutionMicrons, 46);
  });
});

// ---------------------------------------------------------------------------

describe('save / open round-trip', () => {
  it('restores an identical project', () => {
    const original = sampleProject();
    const result = parseProject(serializeProject(original));

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.project, original);
  });

  it('keeps the saved bytes and the in-memory project in step', () => {
    // What the store writes is exactly what the store then holds — no drift in
    // `modifiedAt` between disk and memory.
    const stamped = stampForSave(sampleProject());
    const result = parseProject(serializeProject(stamped));

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.project, stamped);
    assert.equal(result.project.meta.modifiedAt, stamped.meta.modifiedAt);
  });

  it('survives repeated save/open cycles without drift', () => {
    const original = sampleProject();
    let text = serializeProject(original);

    for (let i = 0; i < 3; i += 1) {
      const result = parseProject(text);
      assert.equal(result.ok, true);
      if (!result.ok) return;
      text = serializeProject(result.project);
    }

    const final = parseProject(text);
    assert.equal(final.ok, true);
    if (!final.ok) return;
    assert.deepEqual(final.project.channelGraph, original.channelGraph);
    assert.deepEqual(final.project.chipParams, original.chipParams);
    assert.deepEqual(final.project.printerProfile, original.printerProfile);
  });

  it('opens a file that predates the channel defaults', () => {
    // defaultChannelWidthMm / HeightMm / CrossSection were added to
    // chipParams. A project saved before they existed must still open, with
    // those fields filled in rather than rejected.
    const project = sampleProject();
    const legacy = {
      ...project,
      chipParams: {
        width: 40,
        length: 60,
        baseThickness: 4,
        wallThickness: 2,
        minEdgeSpacing: 3,
        splitType: 'two-piece',
        splitHeight: 2,
      },
    };

    const result = parseProject(JSON.stringify(legacy));
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(result.project.chipParams.defaultChannelWidthMm, 0.8);
    assert.equal(result.project.chipParams.defaultChannelHeightMm, 0.5);
    assert.equal(result.project.chipParams.defaultCrossSection, 'rect');
  });

  it('round-trips a drawn channel network', () => {
    // The shapes that carry real geometry: bezier handles, dimension
    // markers, chamber sizes and port specs.
    const project = sampleProject();
    const reopened = parseProject(serializeProject(project));

    assert.equal(reopened.ok, true);
    if (!reopened.ok) return;

    const edge = reopened.project.channelGraph.edges.find((e) => e.curveType === 'bezier');
    assert.ok(edge?.controlPoints?.length === 2, 'bezier handles survive');
    assert.deepEqual(reopened.project.channelGraph, project.channelGraph);
  });

  it('preserves fields written by a later version', () => {
    const withFutureData = {
      ...sampleProject(),
      fluidProfiles: [
        { id: 'f1', name: 'Water', builtIn: true, densityKgM3: 998, dynamicViscosityPaS: 0.001 },
      ],
    };

    const result = parseProject(JSON.stringify(withFutureData));
    assert.equal(result.ok, true);
    if (!result.ok) return;

    const fluid = result.project.fluidProfiles[0] as unknown as Record<string, unknown>;
    assert.equal(fluid.densityKgM3, 998);
    assert.equal(fluid.dynamicViscosityPaS, 0.001);
  });

  it('derives a filesystem-safe filename', () => {
    assert.equal(suggestedFileName('Serpentine mixer v1'), 'Serpentine-mixer-v1.openchip');
    assert.equal(suggestedFileName('  weird/\\:name?? '), 'weirdname.openchip');
    assert.equal(suggestedFileName(''), 'untitled-chip.openchip');
  });
});

// ---------------------------------------------------------------------------

describe('malformed files produce clear errors', () => {
  it('rejects an empty file', () => {
    const result = parseProject('   ');
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /empty/i);
  });

  it('rejects invalid JSON and says so', () => {
    const result = parseProject('{ "meta": { "name": "x", } }');
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /valid JSON/i);
    assert.ok(result.details.length > 0);
  });

  it('rejects JSON that is not a project object', () => {
    const result = parseProject('[1, 2, 3]');
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /isn't an OpenChip project/i);
  });

  it('names the section that is missing, in plain language', () => {
    const { printerProfile: _dropped, ...withoutPrinter } = sampleProject();
    const result = parseProject(JSON.stringify(withoutPrinter));

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(
      result.details.some((line) => /^Printer profile is missing\.$/.test(line)),
      `expected "Printer profile is missing.", got: ${result.details.join(' | ')}`,
    );
    // Raw zod phrasing must never reach the user.
    assert.ok(
      !result.details.some((line) => /received undefined|invalid input/i.test(line)),
      `zod wording leaked: ${result.details.join(' | ')}`,
    );
  });

  it('names a missing field inside a section', () => {
    const broken = sampleProject();
    delete (broken.printerProfile as unknown as Record<string, unknown>).minFeatureSizeMm;

    const result = parseProject(JSON.stringify(broken));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(
      result.details.some((line) => /Printer profile: "minFeatureSizeMm" is missing\./.test(line)),
      `got: ${result.details.join(' | ')}`,
    );
  });

  it('names the specific bad field', () => {
    const broken = sampleProject();
    (broken.chipParams as unknown as Record<string, unknown>).width = -5;

    const result = parseProject(JSON.stringify(broken));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(
      result.details.some((line) => /chip width/i.test(line) && /greater than zero/i.test(line)),
      `expected a width complaint, got: ${result.details.join(' | ')}`,
    );
  });

  it('rejects an edge pointing at a node that does not exist', () => {
    const broken = sampleProject();
    broken.channelGraph.edges[0].toNodeId = 'ghost';

    const result = parseProject(JSON.stringify(broken));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /inconsistent/i);
    assert.ok(result.details.some((line) => line.includes('ghost')));
  });

  it('rejects duplicate node ids', () => {
    const broken = sampleProject();
    broken.channelGraph.nodes[1].id = 'n1';
    broken.channelGraph.edges[0].toNodeId = 'n1';
    broken.channelGraph.edges[1].fromNodeId = 'n1';

    const result = parseProject(JSON.stringify(broken));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.details.some((line) => /share the id/i.test(line)));
  });
});

// ---------------------------------------------------------------------------

describe('version handling', () => {
  it('opens a file from a newer build, with a warning', () => {
    const future = { ...sampleProject(), formatVersion: 99 };
    const result = parseProject(JSON.stringify(future));

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.warnings.some((w) => /newer version/i.test(w)));
  });

  it('opens an unversioned file, with a warning', () => {
    const { formatVersion: _dropped, ...unversioned } = sampleProject();
    const result = parseProject(JSON.stringify(unversioned));

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.warnings.some((w) => /no version stamp/i.test(w)));
  });
});

// ---------------------------------------------------------------------------

/**
 * The shipped example projects, parsed with the real loader.
 *
 * These are files a user could have saved, so they are the closest thing the
 * suite has to a compatibility guarantee: a schema change that would refuse to
 * open somebody's existing project fails here before it reaches them.
 */
describe('example projects', () => {
  const dir = join(process.cwd(), 'examples');
  const files = readdirSync(dir).filter((name) => name.endsWith('.openchip'));

  it('ships at least one example', () => {
    assert.ok(files.length > 0, 'examples/ should contain a .openchip file');
  });

  for (const name of files) {
    it(`opens ${name}`, () => {
      const result = parseProject(readFileSync(join(dir, name), 'utf8'));
      assert.equal(
        result.ok,
        true,
        result.ok ? '' : `${result.message} — ${result.details.join(' ')}`,
      );
    });

    it(`round-trips ${name} without drift`, () => {
      const first = parseProject(readFileSync(join(dir, name), 'utf8'));
      assert.equal(first.ok, true);
      if (!first.ok) return;

      const again = parseProject(serializeProject(first.project));
      assert.equal(again.ok, true);
      if (!again.ok) return;

      assert.deepEqual(again.project, first.project);
    });
  }

  it('the counter-flow exchanger still describes a runnable two-fluid chip', () => {
    // Guards the thing that makes this example worth shipping: two inlets
    // carrying different fluids at different temperatures.
    const result = parseProject(
      readFileSync(join(dir, 'counter-flow-exchanger.openchip'), 'utf8'),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;

    const inlets = result.project.fluidSetup.assignments.filter((a) => a.role === 'inlet');
    assert.equal(inlets.length, 2);
    assert.notEqual(inlets[0].fluidProfileId, inlets[1].fluidProfileId);
    assert.notEqual(inlets[0].inletTemperatureC, inlets[1].inletTemperatureC);
    assert.equal(result.project.channelGraph.nodes.filter((n) => n.type === 'port').length, 4);
  });
});
