import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { FALLBACK_PRINTER_PROFILE } from './defaults';
import {
  DESCRIPTION_PLACEHOLDER,
  SKILL_NAME,
  buildDesignPrompt,
  buildSkillZip,
  claudeUrl,
} from './designWithAi';

/** File names in a stored zip, read from its central directory records. */
function zipNames(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const names: string[] = [];
  for (let i = 0; i + 46 <= bytes.length; i += 1) {
    if (view.getUint32(i, true) !== 0x02014b50) continue;
    const nameLength = view.getUint16(i + 28, true);
    names.push(new TextDecoder().decode(bytes.subarray(i + 46, i + 46 + nameLength)));
  }
  return names;
}

/** One file's contents, from its local header. Stored entries are uncompressed. */
function zipFile(bytes: Uint8Array, name: string): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i + 30 <= bytes.length; i += 1) {
    if (view.getUint32(i, true) !== 0x04034b50) continue;
    const size = view.getUint32(i + 18, true);
    const nameLength = view.getUint16(i + 26, true);
    const extraLength = view.getUint16(i + 28, true);
    const entry = new TextDecoder().decode(bytes.subarray(i + 30, i + 30 + nameLength));
    if (entry !== name) continue;
    const start = i + 30 + nameLength + extraLength;
    return new TextDecoder().decode(bytes.subarray(start, start + size));
  }
  throw new Error(`${name} is not in the archive`);
}

describe('the design prompt', () => {
  it('carries the description, the printer and the skill to use', () => {
    const prompt = buildDesignPrompt('  A droplet generator for 100 µm drops  ', FALLBACK_PRINTER_PROFILE);
    assert.ok(prompt.startsWith('A droplet generator for 100 µm drops\n'));
    assert.ok(prompt.includes(FALLBACK_PRINTER_PROFILE.name));
    assert.ok(prompt.includes(`${FALLBACK_PRINTER_PROFILE.minFeatureSizeMm} mm minimum feature`));
    assert.ok(prompt.includes(SKILL_NAME));
    assert.ok(prompt.includes('.openchip'));
  });

  it('falls back to the example shown in the empty box', () => {
    // What the user sees greyed out is what gets sent if they send nothing.
    assert.ok(buildDesignPrompt('   ', FALLBACK_PRINTER_PROFILE).startsWith(DESCRIPTION_PLACEHOLDER));
  });

  it('survives the trip through a Claude link intact', () => {
    const prompt = buildDesignPrompt('Mix A & B; 50% each? #1', FALLBACK_PRINTER_PROFILE);
    const url = new URL(claudeUrl(prompt));
    assert.equal(url.origin, 'https://claude.ai');
    assert.equal(url.searchParams.get('q'), prompt);
  });
});

describe('the skill download', () => {
  it('packs the whole skill in one folder named after it', async () => {
    const zip = await buildSkillZip();
    const names = zipNames(zip);

    assert.ok(names.every((name) => name.startsWith(`${SKILL_NAME}/`)), names.join(', '));
    for (const required of [
      'SKILL.md',
      'scripts/openchip.mjs',
      'references/DESIGN-RULES.md',
      'references/DSL.md',
      'references/SCHEMA.md',
    ]) {
      assert.ok(names.includes(`${SKILL_NAME}/${required}`), `missing ${required}`);
    }
    assert.ok(names.some((name) => name.endsWith('.chip')), 'no examples');
  });

  it('declares the name the prompt asks for', async () => {
    const skill = zipFile(await buildSkillZip(), `${SKILL_NAME}/SKILL.md`);
    assert.match(skill, new RegExp(`^---\\nname: ${SKILL_NAME}\\n`));
  });

  it('works outside this repository', async () => {
    // The skill is installed wherever an agent keeps skills, so a path that
    // only exists in the OpenChip repo, or a tool only one agent has, would
    // break it for everyone else.
    const zip = await buildSkillZip();
    for (const name of zipNames(zip).filter((n) => n.endsWith('.md'))) {
      const text = zipFile(zip, name);
      assert.ok(!text.includes('.agents/skills'), `${name} names a repo-only path`);
      assert.ok(!text.includes('AskUserQuestion'), `${name} names one agent's tool`);
    }
  });
});
