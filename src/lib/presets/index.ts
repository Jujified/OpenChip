/**
 * Turning a template into an open project.
 *
 * The library's promise is that a template is a starting point, not a mode: no
 * locked geometry, no "derived from" relationship the app enforces later. So
 * this produces plain `CreateProjectOptions` and hands them to the same
 * `newProject` the File menu uses. The only trace left behind is
 * `presetLibraryRef`, which is a note about provenance and nothing more.
 */

import { DEFAULT_CHIP_CONDUCTIVITY_WMK, type CreateProjectOptions } from '../defaults';
import { FLUID_PRESETS } from '../fluids/properties';
import type { FluidAssignment, FluidProfile } from '../../types/project';
import type { ChipPreset, PresetBuild } from './library';

export * from './library';
export * from './builders';
export * from './thumbnail';

/**
 * The fluid the templates open with.
 *
 * Water, because every template here is a two-stream contactor and water
 * against water is the honest baseline: any pressure drop the user sees is the
 * geometry's, not a viscosity they did not choose.
 */
const DEFAULT_FLUID_ID = FLUID_PRESETS[0]?.id ?? null;

export function projectOptionsFromPreset(
  preset: ChipPreset,
  build: PresetBuild,
): CreateProjectOptions {
  const profiles: FluidProfile[] = FLUID_PRESETS.map((f) => ({ ...f }));

  // Seeded rather than left to the Fluid tab's auto-assignment, which can only
  // guess "first port is the inlet". A gradient generator with three of its six
  // ports mislabelled would show a plausible-looking estimate of the wrong
  // device, and a wrong number presented confidently is worse than no number.
  const assignments: FluidAssignment[] = [
    ...build.inletPortIds.map((portId): FluidAssignment => ({
      portId,
      role: 'inlet',
      fluidProfileId: DEFAULT_FLUID_ID,
      flowRateUlPerMin: preset.inletFlowUlPerMin,
      inletTemperatureC: null,
    })),
    ...build.outletPortIds.map((portId): FluidAssignment => ({
      portId,
      role: 'outlet',
      fluidProfileId: DEFAULT_FLUID_ID,
      flowRateUlPerMin: 0,
      inletTemperatureC: null,
    })),
  ];

  return {
    name: preset.name,
    chipParams: preset.chipParams,
    channelGraph: build.graph,
    fluidProfiles: profiles,
    fluidSetup: {
      assignments,
      chipMaterialThermalConductivityWmK: DEFAULT_CHIP_CONDUCTIVITY_WMK,
    },
    presetLibraryRef: preset.id,
  };
}

/**
 * Memoised template geometry.
 *
 * The builders are pure and deterministic, so caching them is free correctness —
 * and the library re-renders on every keystroke in the search field, where
 * rebuilding a 90-node gradient generator and re-solving its loft would be
 * felt.
 */
const buildCache = new Map<string, PresetBuild>();

export function presetBuild(preset: ChipPreset): PresetBuild {
  const cached = buildCache.get(preset.id);
  if (cached) return cached;
  const built = preset.build();
  buildCache.set(preset.id, built);
  return built;
}
