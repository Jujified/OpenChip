/**
 * Print-correction profile file tests: parse, validation messages, version
 * handling, round-trip and the content hash.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  DFM_SCHEMA_VERSION,
  canonicalJson,
  dfmProfileFileName,
  hashDfmProfile,
  parseDfmProfile,
  serializeDfmProfile,
} from './profile';
import { makeProfile } from './testFixtures';

const text = (mutate: (raw: Record<string, never>) => void = () => {}): string => {
  const raw = JSON.parse(serializeDfmProfile(makeProfile()));
  mutate(raw);
  return JSON.stringify(raw);
};

describe('profile round-trip', () => {
  it('restores an identical profile', () => {
    const profile = makeProfile();
    const parsed = parseDfmProfile(serializeDfmProfile(profile));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.deepEqual(parsed.profile, profile);
  });

  it('survives repeated save/load cycles without drift', () => {
    let current = serializeDfmProfile(makeProfile());
    for (let i = 0; i < 3; i += 1) {
      const parsed = parseDfmProfile(current);
      assert.equal(parsed.ok, true);
      if (!parsed.ok) return;
      const next = serializeDfmProfile(parsed.profile);
      assert.equal(next, current);
      current = next;
    }
  });

  it('keeps the raw coupon measurements, so the profile can be re-fitted', () => {
    const parsed = parseDfmProfile(serializeDfmProfile(makeProfile()));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.profile.measurements.length, 2);
    assert.equal(parsed.profile.measurements[1].measuredWidthMm, 0);
    assert.equal(parsed.profile.coupon.version, 1);
  });

  it('preserves fields it does not know about', () => {
    const parsed = parseDfmProfile(text((raw) => Object.assign(raw.meta, { operator: 'JC' })));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.match(serializeDfmProfile(parsed.profile), /"operator": "JC"/);
  });

  it('defaults what an older or hand-written file leaves out', () => {
    const parsed = parseDfmProfile(
      text((raw) => {
        delete (raw.compensation as Record<string, unknown>).lateralDecayMm;
        delete (raw.compensation as Record<string, unknown>).snapToPixelGrid;
        delete (raw as Record<string, unknown>).fit;
        delete (raw.meta as Record<string, unknown>).exposure;
      }),
    );
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.profile.compensation.lateralDecayMm, 0);
    assert.equal(parsed.profile.compensation.snapToPixelGrid, false);
    assert.equal(parsed.profile.fit.lateral.method, 'manual');
    assert.equal(parsed.profile.meta.exposure.normalExposureS, null);
  });

  it('derives a filesystem-safe filename', () => {
    assert.equal(dfmProfileFileName('Mars 4 / clear @ 2.5 s'), 'Mars-4-clear-25-s.ocdfm');
    assert.equal(dfmProfileFileName('   '), 'print-correction.ocdfm');
  });
});

describe('malformed profiles produce clear errors', () => {
  it('rejects an empty file', () => {
    const result = parseDfmProfile('   ');
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /empty/);
  });

  it('rejects invalid JSON and says so', () => {
    const result = parseDfmProfile('{ "kind": ');
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /valid JSON/);
  });

  it('recognises a project file dropped in by mistake', () => {
    const result = parseDfmProfile(JSON.stringify({ formatVersion: 1, channelGraph: {} }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /project, not a print-correction profile/);
  });

  it('names a missing section in plain language', () => {
    const result = parseDfmProfile(text((raw) => delete (raw as Record<string, unknown>).compensation));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(result.details, ['Compensation parameters is missing.']);
  });

  it('names the specific bad field', () => {
    const result = parseDfmProfile(
      text((raw) => Object.assign(raw.compensation, { deltaXyMm: -0.1, deltaZMm: 'lots' })),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(
      result.details.some((d) => /deltaXyMm.*cannot be negative/.test(d)),
      result.details.join(' | '),
    );
    assert.ok(result.details.some((d) => /deltaZMm.*must be a number/.test(d)));
  });

  it('rejects a measurement with an unknown result', () => {
    const result = parseDfmProfile(
      text((raw) => Object.assign((raw.measurements as Record<string, unknown>[])[0], { result: 'maybe' })),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.details.some((d) => /open.*partial.*closed/.test(d)), result.details.join(' | '));
  });

  it('rejects a model it does not implement', () => {
    const result = parseDfmProfile(text((raw) => Object.assign(raw.compensation, { model: 'voxel-v9' })));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.details.some((d) => /edge-bleed-v1/.test(d)));
  });
});

describe('profile version handling', () => {
  it('refuses a newer schema with a readable message, not a crash', () => {
    const result = parseDfmProfile(
      text((raw) => Object.assign(raw, { schemaVersion: DFM_SCHEMA_VERSION + 1, compensation: 'reshaped' })),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /newer version of OpenChip/);
    assert.ok(result.details.some((d) => d.includes(`format ${DFM_SCHEMA_VERSION + 1}`)));
  });

  it('reads the current schema version', () => {
    assert.equal(parseDfmProfile(text()).ok, true);
  });

  it('rejects a file with no version at all', () => {
    const result = parseDfmProfile(text((raw) => delete (raw as Record<string, unknown>).schemaVersion));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.details.some((d) => /File header/.test(d)));
  });
});

describe('content hash', () => {
  it('is a 64-character hex SHA-256', async () => {
    assert.match(await hashDfmProfile(makeProfile()), /^[0-9a-f]{64}$/);
  });

  it('ignores formatting and key order', async () => {
    const profile = makeProfile();
    const reordered = JSON.parse(
      JSON.stringify({ measurements: profile.measurements, ...profile }, null, 8),
    );
    assert.equal(await hashDfmProfile(reordered), await hashDfmProfile(profile));
  });

  it('changes when any parameter changes', async () => {
    assert.notEqual(
      await hashDfmProfile(makeProfile({ deltaXyMm: 0.051 })),
      await hashDfmProfile(makeProfile()),
    );
  });

  it('writes canonical JSON with sorted keys', () => {
    assert.equal(canonicalJson({ b: 1, a: [{ d: null, c: 'x' }] }), '{"a":[{"c":"x","d":null}],"b":1}');
  });
});
