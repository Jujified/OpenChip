/**
 * Fluid properties and the built-in presets.
 *
 * The schema carries exactly the five properties the flow calculations
 * consume and nothing else:
 *
 *   density              → Reynolds number, mass flow
 *   dynamicViscosity     → Hagen–Poiseuille pressure drop, Reynolds number
 *   thermalConductivity  → convective coefficient h = Nu·k/Dh
 *   specificHeatCapacity → heat capacity rate C = ṁ·cp for the ε-NTU exchange
 *   inletTemperature     → the thermal boundary condition
 *
 * Prandtl number is derived (μ·cp/k) rather than stored, so it cannot drift out
 * of step with the values it comes from.
 *
 * Every preset is an **approximate reference value** near room temperature, and
 * every field is editable. Real fluids vary with temperature, batch and
 * supplier; these get a user to a sensible first estimate, not to a citation.
 */

import { newId } from '../defaults';
import type { FluidProfile } from '../../types/project';

// ---------------------------------------------------------------------------
// glycerol / water
// ---------------------------------------------------------------------------

/**
 * Viscosity of a glycerol–water mixture, after Cheng (2008):
 *
 *   Cheng, N.-S. (2008). Formula for the viscosity of a glycerol–water mixture.
 *   Industrial & Engineering Chemistry Research 47, 3285–3288.
 *
 * Worth implementing properly rather than interpolating a table: glycerol
 * fraction is the standard knob for viscosity-matching in microfluidics, the
 * relationship is strongly non-linear (60% is ~10× water, 90% is ~200×), and a
 * linear guess would be wrong by an order of magnitude exactly where people
 * work.
 *
 * `massFraction` is glycerol mass / total mass, 0–1. Returns Pa·s.
 */
export function glycerolWaterViscosity(massFraction: number, temperatureC: number): number {
  const Cm = clamp01(massFraction);
  const T = temperatureC;

  // Pure-component viscosities, centipoise.
  const muWater = 1.79 * Math.exp(((-1230 - T) * T) / (36100 + 360 * T));
  const muGlycerol = 12100 * Math.exp(((-1233 + T) * T) / (9900 + 70 * T));

  const a = 0.705 - 0.0017 * T;
  const b = (4.9 + 0.036 * T) * Math.pow(a, 2.5);

  // Weighting exponent: the mixture is a geometric blend, not an arithmetic one.
  const denominator = a * Cm + b * (1 - Cm);
  const alpha =
    denominator === 0 ? 1 - Cm : 1 - Cm + (a * b * Cm * (1 - Cm)) / denominator;

  const muCentipoise = Math.pow(muWater, alpha) * Math.pow(muGlycerol, 1 - alpha);
  return muCentipoise / 1000; // cP → Pa·s
}

/** Density of a glycerol–water mixture, kg/m³, by volume-additive mixing. */
export function glycerolWaterDensity(massFraction: number, temperatureC: number): number {
  const Cm = clamp01(massFraction);
  const rhoWater = waterDensity(temperatureC);
  const rhoGlycerol = 1277 - 0.654 * temperatureC;

  // Convert mass fraction to volume fraction before mixing volumes.
  const volGlycerol = Cm / rhoGlycerol;
  const volWater = (1 - Cm) / rhoWater;
  return 1 / (volGlycerol + volWater);
}

/** Mass-fraction blend of the thermal properties. */
export function glycerolWaterThermal(massFraction: number): {
  thermalConductivityWmK: number;
  specificHeatCapacityJkgK: number;
} {
  const Cm = clamp01(massFraction);
  return {
    // Glycerol 0.285 W/m·K, water 0.598 W/m·K.
    thermalConductivityWmK: 0.598 * (1 - Cm) + 0.285 * Cm,
    // Glycerol 2430 J/kg·K, water 4182 J/kg·K.
    specificHeatCapacityJkgK: 4182 * (1 - Cm) + 2430 * Cm,
  };
}

/** Volume percent → mass fraction, for the UI's percentage control. */
export function glycerolVolumeToMassFraction(volumePercent: number, temperatureC = 20): number {
  const v = clamp01(volumePercent / 100);
  const rhoGlycerol = 1277 - 0.654 * temperatureC;
  const rhoWater = waterDensity(temperatureC);
  const massGlycerol = v * rhoGlycerol;
  const massWater = (1 - v) * rhoWater;
  return massGlycerol / (massGlycerol + massWater);
}

/** Builds a complete profile for a glycerol–water mixture at a given volume %. */
export function glycerolWaterProfile(
  volumePercent: number,
  temperatureC = 20,
  options: { id?: string; name?: string; note?: string } = {},
): FluidProfile {
  const massFraction = glycerolVolumeToMassFraction(volumePercent, temperatureC);
  const thermal = glycerolWaterThermal(massFraction);

  return {
    id: options.id ?? newId(),
    name: options.name ?? `Glycerol/water ${Math.round(volumePercent)}%`,
    builtIn: false,
    densityKgM3: round(glycerolWaterDensity(massFraction, temperatureC), 1),
    dynamicViscosityPaS: round(glycerolWaterViscosity(massFraction, temperatureC), 8),
    thermalConductivityWmK: round(thermal.thermalConductivityWmK, 4),
    specificHeatCapacityJkgK: round(thermal.specificHeatCapacityJkgK, 0),
    inletTemperatureC: temperatureC,
    glycerolVolumePercent: volumePercent,
    note: options.note,
  };
}

function waterDensity(temperatureC: number): number {
  // Adequate over 0–100 °C for this purpose.
  const t = temperatureC;
  return 1000 * (1 - ((t + 288.9414) / (508929.2 * (t + 68.12963))) * (t - 3.9863) ** 2);
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const round = (v: number, places: number) => {
  const f = 10 ** places;
  return Math.round(v * f) / f;
};

// ---------------------------------------------------------------------------
// presets
// ---------------------------------------------------------------------------

export const APPROXIMATE_VALUES_NOTE =
  'Reference values near 20 °C. Real fluids vary with temperature, batch and supplier — edit any field to match what you are actually using.';

/**
 * Built-in fluids.
 *
 * Ids are stable strings rather than generated, so a saved project keeps its
 * fluid assignments when reopened in a later build.
 */
export const FLUID_PRESETS: FluidProfile[] = [
  {
    id: 'preset-water',
    name: 'Water',
    builtIn: true,
    densityKgM3: 998.2,
    dynamicViscosityPaS: 0.001002,
    thermalConductivityWmK: 0.598,
    specificHeatCapacityJkgK: 4182,
    inletTemperatureC: 20,
  },
  {
    id: 'preset-pbs',
    name: 'PBS buffer (1×)',
    builtIn: true,
    // Salts raise density slightly and barely move viscosity.
    densityKgM3: 1005,
    dynamicViscosityPaS: 0.00102,
    thermalConductivityWmK: 0.6,
    specificHeatCapacityJkgK: 4100,
    inletTemperatureC: 20,
    note: 'Close to water; the dissolved salts change density more than viscosity.',
  },
  {
    id: 'preset-ethanol',
    name: 'Ethanol',
    builtIn: true,
    densityKgM3: 789,
    dynamicViscosityPaS: 0.0012,
    thermalConductivityWmK: 0.171,
    specificHeatCapacityJkgK: 2440,
    inletTemperatureC: 20,
  },
  {
    id: 'preset-mineral-oil',
    name: 'Mineral oil (light)',
    builtIn: true,
    densityKgM3: 850,
    dynamicViscosityPaS: 0.03,
    thermalConductivityWmK: 0.14,
    specificHeatCapacityJkgK: 1900,
    inletTemperatureC: 20,
    note: 'Grade-dependent: light oils run ~15–40 mPa·s, heavy ones far more. Check your bottle.',
  },
  {
    ...glycerolWaterProfile(50, 20, {
      id: 'preset-glycerol-water',
      name: 'Glycerol/water 50%',
    }),
    builtIn: true,
    note: 'Adjust the glycerol percentage to tune viscosity — the relationship is strongly non-linear.',
  },
  {
    // 33.5 % by volume is what lands on ~3.5 mPa·s at 20 °C with the Cheng
    // model above; 40 % (a common rule of thumb) gives ~4.8.
    ...glycerolWaterProfile(33.5, 20, {
      id: 'preset-blood-analog',
      name: 'Blood-mimicking analog',
    }),
    builtIn: true,
    nonNewtonianNote:
      'Whole blood is shear-thinning: its apparent viscosity falls from ~10 mPa·s at low shear to ~3.5 mPa·s above roughly 100 s⁻¹. ' +
      'This analog is a Newtonian glycerol/water blend matched to that high-shear value, which is the right regime for most microchannels. ' +
      'At very low shear rates it will under-predict the real thing.',
  },
];

export const isPreset = (id: string): boolean => FLUID_PRESETS.some((f) => f.id === id);

/** A blank custom fluid, seeded from water so every field starts plausible. */
export function createCustomFluid(name = 'Custom fluid'): FluidProfile {
  return {
    ...FLUID_PRESETS[0],
    id: newId(),
    name,
    builtIn: false,
    note: undefined,
  };
}

/** Prandtl number — derived, never stored. */
export const prandtl = (fluid: FluidProfile): number =>
  (fluid.dynamicViscosityPaS * fluid.specificHeatCapacityJkgK) / fluid.thermalConductivityWmK;
