/**
 * Fit tests. Each synthesises coupon results from known offsets and checks the
 * fit recovers them — or, for open/closed data, brackets them and says how
 * loosely.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { FALLBACK_PRINTER_PROFILE } from '../defaults';
import { blankMeasurements, couponLayout, defaultCouponSpec } from './coupon';
import { fitCompensation } from './fit';
import { printedWidthMm } from './model';
import type { CouponMeasurement } from './profile';

const blank = (): CouponMeasurement[] =>
  blankMeasurements(couponLayout(defaultCouponSpec(FALLBACK_PRINTER_PROFILE)));

/** Marks each channel the way a printer with these true offsets would leave it. */
const simulate = (closureWidthMm: number, deltaZMm: number): CouponMeasurement[] =>
  blank().map((m) => ({
    ...m,
    result:
      m.nominalWidthMm <= closureWidthMm || m.nominalHeightMm <= deltaZMm ? 'closed' : 'open',
  }));

const near = (actual: number, expected: number, tolerance: number, label = '') =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} expected ${expected}, got ${actual}`);

describe('fitting from open / closed results', () => {
  it('brackets both thresholds from the matrix', () => {
    // Coupon widths: 0.1 0.15 0.2 0.25 0.3 0.4 0.6; heights: 0.1 0.2 0.3 0.5.
    // Truth: closes at or below 0.22 mm wide (Δxy 0.11) or 0.15 mm tall.
    const fit = fitCompensation(simulate(0.22, 0.15));

    // 0.2 closed and 0.25 open → closure width in [0.2, 0.25), per side [0.1, 0.125).
    assert.deepEqual(fit.lateral.bracketMm, [0.1, 0.125]);
    near(fit.deltaXyMm, 0.1125, 1e-9);
    // 0.1 closed and 0.2 open → Δz in [0.1, 0.2).
    assert.deepEqual(fit.vertical.bracketMm, [0.1, 0.2]);
    near(fit.deltaZMm, 0.15, 1e-9);

    assert.equal(fit.lateral.method, 'open-closed');
    assert.equal(fit.vertical.method, 'open-closed');
    assert.equal(fit.lateral.inconsistent, 0);
    assert.equal(fit.lateral.dataPoints, 28);
  });

  it('contains the true offset in its bracket', () => {
    for (const [closure, dz] of [[0.12, 0.25], [0.31, 0.1], [0.45, 0.31]] as const) {
      const fit = fitCompensation(simulate(closure, dz));
      const [lo, hi] = fit.lateral.bracketMm ?? [0, 0];
      assert.ok(lo <= closure / 2 && closure / 2 < (hi ?? Infinity), `lateral ${closure}`);
      const [zlo, zhi] = fit.vertical.bracketMm ?? [0, 0];
      assert.ok(zlo <= dz && dz < (zhi ?? Infinity), `vertical ${dz}`);
    }
  });

  it('never fits a decay length, and says the result is coarse', () => {
    const fit = fitCompensation(simulate(0.22, 0.15));
    assert.equal(fit.lateralDecayMm, 0);
    assert.ok(fit.notes.some((n) => /lateral offset comes from open\/closed results only.*coarse/.test(n)));
    assert.ok(fit.notes.some((n) => /vertical offset comes from open\/closed results only.*coarse/.test(n)));
  });

  it('applies no correction when nothing closed', () => {
    const fit = fitCompensation(blank().map((m) => ({ ...m, result: 'open' as const })));
    assert.equal(fit.deltaXyMm, 0);
    assert.equal(fit.deltaZMm, 0);
    // The upper end is still reported: overcure is below the smallest size.
    assert.deepEqual(fit.lateral.bracketMm, [0, 0.05]);
    assert.ok(fit.notes.some((n) => /No channel closed across its width/.test(n)));
  });

  it('reports a lower bound when everything closed', () => {
    const fit = fitCompensation(blank().map((m) => ({ ...m, result: 'closed' as const })));
    assert.ok(
      fit.lateral.bracketMm?.[1] === null || fit.vertical.bracketMm?.[1] === null,
      'at least one axis has no upper bound',
    );
    assert.ok(fit.notes.some((n) => /lower bound/.test(n)));
  });

  it('uses a partially open channel to tighten the bracket', () => {
    const results = simulate(0.22, 0.05).map((m) =>
      m.nominalWidthMm === 0.25 ? { ...m, result: 'partial' as const } : m,
    );
    const fit = fitCompensation(results);
    // The threshold is taken to sit just under the partial channel's 0.25 mm:
    // the top quarter of [0.2, 0.25], halved per side.
    near(fit.lateral.bracketMm?.[0] ?? 0, 0.11875, 1e-4);
    assert.equal(fit.lateral.bracketMm?.[1], 0.125);
  });

  it('counts results no threshold can explain', () => {
    const results = simulate(0.22, 0.05).map((m) =>
      m.id === '4.1' ? { ...m, result: 'closed' as const } : m,
    );
    const fit = fitCompensation(results);
    assert.equal(fit.lateral.inconsistent, 1);
    assert.match(fit.notes[0], /1 channel does not fit any single threshold/);
    // One stray entry does not move the answer.
    assert.deepEqual(fit.lateral.bracketMm, [0.1, 0.125]);
  });

  it('ignores channels that were not checked', () => {
    const results = simulate(0.22, 0.15).map((m, i) => (i % 2 ? { ...m, result: null } : m));
    assert.equal(fitCompensation(results).lateral.dataPoints, 14);
  });

  it('says so when there is nothing to fit', () => {
    const fit = fitCompensation(blank());
    assert.equal(fit.lateral.method, 'none');
    assert.equal(fit.vertical.method, 'none');
    assert.deepEqual(fit.notes, ['No results have been entered yet.']);
  });
});

describe('fitting from measured dimensions', () => {
  it('recovers a constant lateral offset exactly', () => {
    const results = blank().map((m) => ({
      ...m,
      measuredWidthMm: Math.max(0, m.nominalWidthMm - 0.08),
    }));
    const fit = fitCompensation(results);
    assert.equal(fit.lateral.method, 'measured');
    near(fit.deltaXyMm, 0.04, 1e-4);
    assert.equal(fit.lateralDecayMm, 0);
    near(fit.lateral.rmsMm ?? 1, 0, 1e-4);
  });

  it('recovers the offset and the decay length when narrow channels lose more', () => {
    const truth = { deltaXyMm: 0.03, lateralDecayMm: 0.06 };
    const results = blank().map((m) => ({
      ...m,
      measuredWidthMm: Number(printedWidthMm(m.nominalWidthMm, truth).toFixed(4)),
    }));
    const fit = fitCompensation(results);
    near(fit.deltaXyMm, 0.03, 2e-3);
    near(fit.lateralDecayMm, 0.06, 5e-3);
    assert.ok((fit.lateral.rmsMm ?? 1) < 1e-3);
  });

  it('keeps the constant model when too few widths were measured', () => {
    const results = blank().map((m) =>
      m.nominalWidthMm >= 0.4 ? { ...m, measuredWidthMm: m.nominalWidthMm - 0.06 } : m,
    );
    const fit = fitCompensation(results);
    assert.equal(fit.lateralDecayMm, 0);
    near(fit.deltaXyMm, 0.03, 1e-4);
    assert.ok(fit.notes.some((n) => /Measure at least 3 different widths/.test(n)));
  });

  it('averages the measured ceiling loss, with its scatter', () => {
    const results = blank().map((m, i) => ({
      ...m,
      measuredHeightMm: m.nominalHeightMm > 0.1 ? m.nominalHeightMm - (i % 2 ? 0.07 : 0.09) : undefined,
    }));
    const fit = fitCompensation(results);
    assert.equal(fit.vertical.method, 'measured');
    near(fit.deltaZMm, 0.08, 2e-3);
    near(fit.vertical.rmsMm ?? 0, 0.01, 2e-3);
  });

  it('fits each axis from the best evidence it has', () => {
    const results = simulate(0.22, 0.15).map((m) => ({
      ...m,
      measuredWidthMm: Math.max(0, m.nominalWidthMm - 0.2),
    }));
    const fit = fitCompensation(results);
    assert.equal(fit.lateral.method, 'measured');
    assert.equal(fit.vertical.method, 'open-closed');
  });

  it('reports a clear misfit as a residual rather than hiding it', () => {
    const results = blank().map((m, i) => ({
      ...m,
      measuredWidthMm: m.nominalWidthMm - (i % 2 ? 0.02 : 0.1),
    }));
    assert.ok((fitCompensation(results).lateral.rmsMm ?? 0) > 0.02);
  });
});
