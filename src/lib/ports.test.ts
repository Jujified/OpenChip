import { describe, expect, it } from 'vitest';
import {
  FITTING_PRESETS,
  LUER_TAPER_RATIO,
  PORT_PRESETS,
  PORT_TYPES,
  bossFilletMm,
  matchFitting,
  portSpecFor,
  taperRatioOf,
  type FittingPreset,
} from './ports';

/**
 * These tests exist because of a specific bug, and they are shaped to catch it
 * again rather than to exercise the module broadly.
 *
 * `PORT_PRESETS.luer` carried 4.27 / 3.925 / 7.5 under a blurb reading
 * "Friction-fit 6% taper". That arithmetic is 4.6%. Every individual number
 * looked plausible, the label looked right, and nothing compared the two — so
 * it survived review, shipped, and produced ports that sealed on a line
 * contact instead of a cone.
 *
 * The defence is to assert the *relationship* rather than the numbers: a thing
 * that calls itself a 6% taper has to be one, and a preset that names a
 * catalogue part has to actually be that part.
 */

const hasTaper = (
  spec: Record<string, number>,
): spec is Record<string, number> & {
  taperLargeDiameterMm: number;
  taperSmallDiameterMm: number;
  taperLengthMm: number;
} =>
  typeof spec.taperLargeDiameterMm === 'number' &&
  typeof spec.taperSmallDiameterMm === 'number' &&
  typeof spec.taperLengthMm === 'number';

describe('the luer taper', () => {
  const tapered = PORT_TYPES.filter((type) => hasTaper(PORT_PRESETS[type].defaults));

  it('is claimed by the presets that ought to have one', () => {
    expect(tapered).toEqual(['luer', 'luer-lock', 'luer-male']);
  });

  it.each(tapered)('is exactly 6%% in PORT_PRESETS.%s', (type) => {
    const defaults = PORT_PRESETS[type].defaults;
    if (!hasTaper(defaults)) throw new Error('unreachable');
    expect(taperRatioOf(defaults)).toBeCloseTo(LUER_TAPER_RATIO, 10);
  });

  const taperedFittings = FITTING_PRESETS.filter((f) => hasTaper(f.spec));

  it.each(taperedFittings.map((f): [string, FittingPreset] => [f.id, f]))(
    'is exactly 6%% in the %s fitting',
    (_id, fitting) => {
      if (!hasTaper(fitting.spec)) throw new Error('unreachable');
      expect(taperRatioOf(fitting.spec)).toBeCloseTo(LUER_TAPER_RATIO, 10);
    },
  );

  it('never claims 6% in prose while carrying some other number', () => {
    const claims = [
      ...PORT_TYPES.map((type) => ({
        where: `PORT_PRESETS.${type}`,
        text: `${PORT_PRESETS[type].blurb} ${PORT_PRESETS[type].caveat ?? ''}`,
        spec: PORT_PRESETS[type].defaults,
      })),
      ...FITTING_PRESETS.map((f) => ({
        where: f.id,
        text: `${f.blurb} ${f.accepts} ${f.fits} ${f.caveat ?? ''}`,
        spec: f.spec,
      })),
    ].filter((entry) => /\b6\s?%/.test(entry.text));

    expect(claims.length).toBeGreaterThan(0);
    for (const claim of claims) {
      if (!hasTaper(claim.spec)) {
        throw new Error(`${claim.where} says "6%" but carries no taper`);
      }
      expect(taperRatioOf(claim.spec), `${claim.where} says "6%"`).toBeCloseTo(
        LUER_TAPER_RATIO,
        10,
      );
    }
  });
});

describe('catalogue fittings', () => {
  it('are each recognised by matchFitting', () => {
    for (const fitting of FITTING_PRESETS) {
      expect(
        matchFitting(fitting.portType, fitting.boreMm, fitting.spec)?.id,
        `${fitting.id} should match itself`,
      ).toBe(fitting.id);
    }
  });

  it('are dimensionally distinct, so none is unreachable', () => {
    // matchFitting returns the first entry that agrees on every dimension. Two
    // identical entries would make the later one impossible to recognise, and
    // the inspector would silently name the wrong part.
    const seen = new Map<string, string>();
    for (const fitting of FITTING_PRESETS) {
      const key = JSON.stringify([
        fitting.portType,
        fitting.boreMm,
        Object.entries(fitting.spec).sort(([a], [b]) => a.localeCompare(b)),
      ]);
      const clash = seen.get(key);
      expect(clash, `${fitting.id} is dimensionally identical to ${clash}`).toBeUndefined();
      seen.set(key, fitting.id);
    }
  });

  it('have unique ids', () => {
    const ids = FITTING_PRESETS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('a port dropped in with a plain port type', () => {
  // The second half of the same bug: because the default and the catalogue
  // part disagreed on a dimension, a fresh luer port showed "no recognised
  // fitting" for what any user would call a standard luer port.
  it.each(['luer', 'luer-lock', 'luer-male', 'barb'] as const)(
    'matches a catalogue fitting for %s',
    (type) => {
      const preset = PORT_PRESETS[type];
      const spec = portSpecFor(type);
      expect(matchFitting(type, preset.defaultBoreMm, spec)).toBeDefined();
    },
  );
});

describe('port presets', () => {
  it('give every field a default', () => {
    for (const type of PORT_TYPES) {
      const preset = PORT_PRESETS[type];
      for (const field of preset.fields) {
        expect(
          typeof preset.defaults[field.key],
          `${type}.${field.key} has no default`,
        ).toBe('number');
      }
    }
  });

  it('expose every dimension a fitting sets, so nothing is applied but uneditable', () => {
    // A project rule: every parameter has to be reachable in the
    // UI. A fitting that writes a spec key its port type has no field for
    // would hide that dimension from the user for good.
    for (const fitting of FITTING_PRESETS) {
      const fields = new Set(PORT_PRESETS[fitting.portType].fields.map((f) => f.key));
      for (const key of Object.keys(fitting.spec)) {
        expect(
          fields.has(key),
          `${fitting.id} sets ${key}, which ${fitting.portType} cannot edit`,
        ).toBe(true);
      }
    }
  });
});

describe('bossFilletMm', () => {
  it('takes 0 at its word, where specNumber would treat it as unset', () => {
    expect(bossFilletMm('syringe', { bossHeightMm: 2, bossFilletMm: 0 })).toBe(0);
  });

  it('falls back to the type default the inspector shows', () => {
    for (const type of PORT_TYPES) {
      const shown = PORT_PRESETS[type].defaults.bossFilletMm ?? 0;
      expect(bossFilletMm(type, { bossHeightMm: 3 })).toBe(shown);
    }
  });

  it('is never taller than the boss, and nothing without one', () => {
    expect(bossFilletMm('custom', { bossHeightMm: 1, bossFilletMm: 4 })).toBe(1);
    expect(bossFilletMm('custom', { bossHeightMm: 0, bossFilletMm: 1 })).toBe(0);
  });

  it('is offered on every port type that has a boss', () => {
    for (const type of PORT_TYPES) {
      const keys = PORT_PRESETS[type].fields.map((f) => f.key);
      expect(keys.includes('bossFilletMm'), type).toBe(keys.includes('bossHeightMm'));
    }
  });
});
