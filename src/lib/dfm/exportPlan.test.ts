/**
 * Export plan and project-reference tests: an uncompensated export is the
 * nominal design by identity, a compensated one is named so it cannot be
 * mistaken for it, and the optional reference in a `.openchip` file changes
 * nothing for files that do not carry it.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { exportStl } from '../cad/stlExport';
import { createProject } from '../defaults';
import { parseProject, serializeProject } from '../projectFile';
import { compensateDesign } from './compensate';
import { planExport } from './exportPlan';
import { hashDfmProfile } from './profile';
import { design, makeProfile, parallelChannels } from './testFixtures';

const nominal = design(parallelChannels(3), { splitType: 'monolithic' });

describe('an export with no profile', () => {
  it('is the nominal design, by identity', () => {
    const plan = planExport(nominal, 'My chip', null);
    assert.equal(plan.graph, nominal.graph);
    assert.equal(plan.chipParams, nominal.chipParams);
    assert.equal(plan.drainageVents, nominal.drainageVents);
    assert.equal(plan.ceilingRaiseMm, 0);
    assert.equal(plan.compensated, null);
  });

  it('keeps the file name and header the app has always written', () => {
    const plan = planExport(nominal, 'My chip', null);
    assert.equal(plan.fileSuffix, '');
    assert.equal(plan.stlHeader, 'OpenChip My chip');
    assert.deepEqual(plan.scadNotes, []);
  });
});

describe('an export with a profile', () => {
  const profile = makeProfile();

  it('carries exactly what compensateDesign returns', async () => {
    const entry = { profile, sha256: await hashDfmProfile(profile) };
    const plan = planExport(nominal, 'My chip', entry);
    const direct = compensateDesign(nominal, profile);
    assert.deepEqual(plan.graph, direct.graph);
    assert.equal(plan.ceilingRaiseMm, direct.ceilingRaiseMm);
    assert.deepEqual(plan.compensated, direct);
  });

  it('gets a file suffix naming the profile', async () => {
    const entry = { profile, sha256: await hashDfmProfile(profile) };
    assert.equal(planExport(nominal, 'My chip', entry).fileSuffix, '-dfm-bench-printer-clear-resin');
  });

  it('records the profile name and hash in the STL header, inside 80 bytes', async () => {
    const sha256 = await hashDfmProfile(profile);
    const plan = planExport(nominal, 'A project with a very long name that would overflow the header', {
      profile,
      sha256,
    });
    assert.ok(plan.stlHeader.startsWith(`OpenChip DFM ${sha256.slice(0, 12)} Bench printer, clear resin`));

    const mesh = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) };
    const written = new TextDecoder().decode(new Uint8Array(exportStl([mesh], plan.stlHeader), 0, 80));
    assert.ok(written.includes(sha256.slice(0, 12)), 'the hash survives truncation');
  });

  it('records the full hash and the offsets in the OpenSCAD notes', async () => {
    const sha256 = await hashDfmProfile(profile);
    const notes = planExport(nominal, 'My chip', { profile, sha256 }).scadNotes.join('\n');
    assert.ok(notes.includes(`Profile SHA-256: ${sha256}`));
    assert.match(notes, /Print-correction profile: Bench printer, clear resin/);
    assert.match(notes, /Lateral offset per side: 0\.05 mm/);
    assert.match(notes, /Ceiling raise: 0\.1 mm/);
    assert.match(notes, /not the nominal design/);
  });
});

describe('the profile reference in a project file', () => {
  it('is absent from a new project and from its saved file', () => {
    const project = createProject();
    assert.equal('dfmProfileRef' in project, false);
    assert.doesNotMatch(serializeProject(project), /dfmProfileRef/);
  });

  it('round-trips when present', () => {
    const project = { ...createProject(), dfmProfileRef: { name: 'Bench', sha256: 'ab'.repeat(32) } };
    const parsed = parseProject(serializeProject(project));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.deepEqual(parsed.project.dfmProfileRef, project.dfmProfileRef);
  });

  it('leaves every shipped project file byte-identical through a load and save', () => {
    for (const dir of ['examples', 'skills/openchip-design/examples']) {
      const abs = join(process.cwd(), dir);
      for (const file of readdirSync(abs).filter((f) => f.endsWith('.openchip'))) {
        const parsed = parseProject(readFileSync(join(abs, file), 'utf8'));
        assert.equal(parsed.ok, true);
        if (!parsed.ok) continue;
        assert.equal('dfmProfileRef' in parsed.project, false, file);
        const again = parseProject(serializeProject(parsed.project));
        assert.ok(again.ok && serializeProject(again.project) === serializeProject(parsed.project), file);
      }
    }
  });

  it('opens a project whose profile is nowhere to be found', () => {
    const project = { ...createProject(), dfmProfileRef: { name: 'Gone', sha256: 'cd'.repeat(32) } };
    const parsed = parseProject(serializeProject(project));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    // Exporting it without that profile is simply the nominal export.
    const plan = planExport(
      {
        graph: parsed.project.channelGraph,
        chipParams: parsed.project.chipParams,
        drainageVents: parsed.project.drainageVents,
        printerProfile: parsed.project.printerProfile,
      },
      parsed.project.meta.name,
      null,
    );
    assert.equal(plan.compensated, null);
  });

  it('rejects a malformed reference with a named section', () => {
    const raw = JSON.parse(serializeProject(createProject()));
    raw.dfmProfileRef = { name: 5 };
    const parsed = parseProject(JSON.stringify(raw));
    assert.equal(parsed.ok, false);
    if (parsed.ok) return;
    assert.ok(parsed.details.some((d) => /Print-correction reference/.test(d)), parsed.details.join(' | '));
  });

  it('never stores compensated geometry: saving after planning leaves the graph nominal', async () => {
    const project = createProject({ channelGraph: parallelChannels(3) });
    const before = serializeProject(project);
    const profile = makeProfile();
    planExport(
      {
        graph: project.channelGraph,
        chipParams: project.chipParams,
        drainageVents: project.drainageVents,
        printerProfile: project.printerProfile,
      },
      project.meta.name,
      { profile, sha256: await hashDfmProfile(profile) },
    );
    assert.equal(serializeProject(project), before);
  });
});
