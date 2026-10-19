import { describe, expect, it } from 'vitest';
import { DEFAULT_VALIDATION_SETTINGS } from '../lib/validation';
import { restoreSettings } from './validationStore';

describe('restoreSettings', () => {
  it('keeps thresholds a user calibrated in an earlier session', () => {
    expect(restoreSettings({ ...DEFAULT_VALIDATION_SETTINGS, minPrintableWallMm: 0.3 })).toEqual({
      ...DEFAULT_VALIDATION_SETTINGS,
      minPrintableWallMm: 0.3,
    });
  });

  it('fills anything missing or unusable from the defaults', () => {
    expect(
      restoreSettings({ minPrintableWallMm: Number.NaN, overhangLimitDeg: -5, taperRatioThreshold: '3' }),
    ).toEqual(DEFAULT_VALIDATION_SETTINGS);
    expect(restoreSettings(undefined)).toEqual(DEFAULT_VALIDATION_SETTINGS);
    expect(restoreSettings('garbage')).toEqual(DEFAULT_VALIDATION_SETTINGS);
  });
});
