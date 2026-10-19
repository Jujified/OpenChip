/**
 * Port fitting presets.
 *
 * The 6% Luer taper is the well-established part of ISO 80369-7 / ISO 594 and
 * is reproduced here as the default geometry. The luer-lock collar thread is
 * given as nominal figures — thread form varies between manufacturers, and this
 * is a design tool, not a compliance document. Every value is editable, and the
 * UI says plainly that these are starting points to check against the fitting
 * actually in hand.
 *
 * Values are millimetres. `cad/portGeometry.ts` turns these into real solid geometry.
 */

import type { PortType } from '../types/project';

export interface PortFieldSpec {
  key: string;
  label: string;
  unit: string;
  hint?: string;
  min?: number;
  step?: number;
}

export interface PortPreset {
  portType: PortType;
  label: string;
  blurb: string;
  /** Through-bore diameter — the field the data model stores as `diameterMm`. */
  defaultBoreMm: number;
  /** Everything else, written into the node's `customSpec`. */
  fields: PortFieldSpec[];
  defaults: Record<string, number>;
  /** Shown under the fields when the preset carries approximate figures. */
  caveat?: string;
}

// ---------------------------------------------------------------------------
// the 6% taper, defined once
// ---------------------------------------------------------------------------

/**
 * The Luer taper, derived rather than transcribed.
 *
 * These three numbers used to be written out twice — once as the port-type
 * default and once for the catalogue fitting — and the two copies disagreed.
 * The default said 4.27 / 3.925 / 7.5, which is a **4.6%** taper wearing a "6%"
 * label, so a default luer port never matched the catalogue part and sealed on
 * a line contact instead of a cone.
 *
 * Deriving the small end from the ratio makes that class of error impossible:
 * there is one definition, and it is arithmetic rather than a remembered
 * figure.
 */

/** Reference-plane diameter of the male cone, ISO 80369-7 / ISO 594. mm. */
export const LUER_REFERENCE_DIAMETER_MM = 4.27;
/** 6%: the diameter changes 0.06 mm for every mm along the cone. */
export const LUER_TAPER_RATIO = 0.06;
/** Nominal engagement length of the cone. mm. */
export const LUER_ENGAGEMENT_MM = 7.5;

/** The narrow end of a Luer cone of the given large end and length. */
export function luerSmallDiameterMm(
  largeMm: number = LUER_REFERENCE_DIAMETER_MM,
  lengthMm: number = LUER_ENGAGEMENT_MM,
): number {
  // Rounded to µm so the value compares exactly against a stored spec.
  return Math.round((largeMm - LUER_TAPER_RATIO * lengthMm) * 1000) / 1000;
}

/** The taper a spec actually describes, as a ratio. Inverse of the above. */
export function taperRatioOf(spec: {
  taperLargeDiameterMm: number;
  taperSmallDiameterMm: number;
  taperLengthMm: number;
}): number {
  return (spec.taperLargeDiameterMm - spec.taperSmallDiameterMm) / spec.taperLengthMm;
}

/** The one true 6% taper. Every luer preset and fitting below shares it. */
export const LUER_TAPER = {
  taperLargeDiameterMm: LUER_REFERENCE_DIAMETER_MM,
  taperSmallDiameterMm: luerSmallDiameterMm(),
  taperLengthMm: LUER_ENGAGEMENT_MM,
} as const;

/**
 * The full luer geometries, shared between the port-type default and the
 * catalogue fitting.
 *
 * These are one object each rather than two similar ones for the same reason
 * the taper is derived: when the default and the catalogue part were written
 * out separately they disagreed, and `matchFitting` compares on *every*
 * dimension — so a default luer port showed "no recognised fitting" even
 * though it was, to the user, obviously a standard luer port.
 */
const LUER_SLIP_GEOMETRY = { ...LUER_TAPER, bossHeightMm: 3.5 } as const;

/**
 * A real Luer-lock is a two-start form; the generator lays a single-start rib,
 * so the *lead* is what has to match for a collar to wind on at the right rate.
 * 4.7 mm of lead is roughly the half-turn engagement the real fitting has,
 * where a fine 1.27 mm pitch would need four full turns to seat.
 */
export const LUER_LOCK_GEOMETRY = {
  ...LUER_TAPER,
  bossHeightMm: 5,
  threadMajorDiameterMm: 7.7,
  threadPitchMm: 4.7,
  collarDepthMm: 5.5,
  /**
   * Room left around the hub for the male fitting's collar to turn in. Collars
   * are not standardised on the outside; this clears the common ~10 mm ones.
   */
  collarClearanceDiameterMm: 11,
} as const;

/** The chip-side male cone a female luer pushes onto. */
const LUER_MALE_GEOMETRY = { ...LUER_TAPER, bossHeightMm: 2 } as const;

/** A printed hose barb sized for 0.125" ID tubing. */
const BARB_1_8_GEOMETRY = {
  barbCrestDiameterMm: 3.5,
  stemDiameterMm: 2.9,
  barbCount: 3,
  barbLengthMm: 10.5,
  bossHeightMm: 2,
} as const;

/**
 * Rounds the concave corner where a boss or pedestal meets the chip face.
 *
 * A sharp internal corner there is where a printed boss cracks off when a
 * fitting is levered or torqued, and a resin print rounds it slightly anyway
 * from light bleed. Never larger than the boss is tall.
 */
const BOSS_FILLET_FIELD: PortFieldSpec = {
  key: 'bossFilletMm',
  label: 'Base fillet',
  unit: 'mm',
  hint: 'Rounds the corner where the boss meets the chip face. 0 leaves it sharp.',
  min: 0,
  step: 0.1,
};

/** Default base fillet for every port type that has no reason to differ. */
const BOSS_FILLET_DEFAULT_MM = 0.5;

const LUER_TAPER_FIELDS: PortFieldSpec[] = [
  {
    key: 'taperLargeDiameterMm',
    label: 'Taper diameter (large end)',
    unit: 'mm',
    hint: 'Outer diameter where the taper meets the chip face.',
    min: 0.1,
    step: 0.01,
  },
  {
    key: 'taperSmallDiameterMm',
    label: 'Taper diameter (small end)',
    unit: 'mm',
    min: 0.1,
    step: 0.01,
  },
  {
    key: 'taperLengthMm',
    label: 'Engagement length',
    unit: 'mm',
    hint: 'Depth of the tapered section.',
    min: 0.1,
    step: 0.1,
  },
  {
    key: 'bossHeightMm',
    label: 'Boss height',
    unit: 'mm',
    hint: 'How far the fitting stands proud of the chip surface.',
    min: 0,
    step: 0.5,
  },
  BOSS_FILLET_FIELD,
];

export const PORT_PRESETS: Record<PortType, PortPreset> = {
  syringe: {
    portType: 'syringe',
    label: 'Syringe',
    blurb: 'A plain cylindrical barrel socket for a blunt needle or tubing.',
    defaultBoreMm: 1.2,
    fields: [
      {
        key: 'barrelDiameterMm',
        label: 'Barrel diameter',
        unit: 'mm',
        hint: 'Outer diameter of the needle or tube this accepts.',
        min: 0.1,
        step: 0.1,
      },
      { key: 'barrelDepthMm', label: 'Barrel depth', unit: 'mm', min: 0.1, step: 0.5 },
      { key: 'bossHeightMm', label: 'Boss height', unit: 'mm', min: 0, step: 0.5 },
      BOSS_FILLET_FIELD,
    ],
    defaults: {
      barrelDiameterMm: 1.6,
      barrelDepthMm: 6,
      bossHeightMm: 2,
      bossFilletMm: BOSS_FILLET_DEFAULT_MM,
    },
  },

  luer: {
    portType: 'luer',
    label: 'Luer slip',
    blurb: 'Friction-fit 6% taper. The most common microfluidic interface.',
    defaultBoreMm: 1.6,
    fields: LUER_TAPER_FIELDS,
    defaults: { ...LUER_SLIP_GEOMETRY, bossFilletMm: BOSS_FILLET_DEFAULT_MM },
    caveat:
      'Nominal ISO 80369-7 / ISO 594 6% taper figures. Check them against the fitting you will actually use.',
  },

  'luer-lock': {
    portType: 'luer-lock',
    label: 'Luer lock',
    blurb: 'The same 6% taper plus a threaded collar that screws down.',
    defaultBoreMm: 1.6,
    fields: [
      ...LUER_TAPER_FIELDS,
      {
        key: 'threadMajorDiameterMm',
        label: 'Thread major diameter',
        unit: 'mm',
        min: 0.1,
        step: 0.1,
      },
      { key: 'threadPitchMm', label: 'Thread pitch', unit: 'mm', min: 0.05, step: 0.05 },
      {
        key: 'collarDepthMm',
        label: 'Collar depth',
        unit: 'mm',
        hint: 'How far the male collar reaches down the hub. Where the hub is shorter, a groove is cut into the chip face for the rest.',
        min: 0.1,
        step: 0.5,
      },
      {
        key: 'collarClearanceDiameterMm',
        label: 'Collar clearance',
        unit: 'mm',
        hint: 'Outer diameter of the groove the male collar turns in. Measure your fitting and add a little.',
        min: 0.1,
        step: 0.1,
      },
    ],
    // Sharp by default: the male collar screws down the outside of the hub, and
    // a fillet at its base is exactly where the collar needs to go.
    defaults: { ...LUER_LOCK_GEOMETRY, bossFilletMm: 0 },
    caveat:
      'The 6% taper follows ISO 80369-7; the collar thread figures are nominal and vary by manufacturer. The generator lays a single-start rib rather than the two-start ISO form, so verify with a test print before relying on it.',
  },

  'luer-male': {
    portType: 'luer-male',
    label: 'Luer male',
    blurb: 'A 6% cone standing proud of the chip. A female luer pushes onto it.',
    defaultBoreMm: 1.6,
    fields: [
      {
        key: 'taperLargeDiameterMm',
        label: 'Cone diameter (base)',
        unit: 'mm',
        hint: 'Widest point, where the cone meets its pedestal.',
        min: 0.1,
        step: 0.01,
      },
      {
        key: 'taperSmallDiameterMm',
        label: 'Cone diameter (tip)',
        unit: 'mm',
        min: 0.1,
        step: 0.01,
      },
      {
        key: 'taperLengthMm',
        label: 'Cone length',
        unit: 'mm',
        hint: 'How far the cone stands above the pedestal.',
        min: 0.1,
        step: 0.1,
      },
      {
        key: 'bossHeightMm',
        label: 'Pedestal height',
        unit: 'mm',
        hint: 'Straight collar under the cone, so the mating hub clears the chip face.',
        min: 0,
        step: 0.5,
      },
      BOSS_FILLET_FIELD,
    ],
    defaults: { ...LUER_MALE_GEOMETRY, bossFilletMm: BOSS_FILLET_DEFAULT_MM },
    caveat:
      'A male cone is the fragile direction to print: it stands off the face with nothing bracing it, ' +
      'and the bore runs right up the middle. Print the chip flat and handle the cone gently when ' +
      'releasing from the plate.',
  },

  barb: {
    portType: 'barb',
    label: 'Hose barb',
    blurb: 'A ridged spigot printed into the chip. Tubing pushes straight on.',
    defaultBoreMm: 1.6,
    fields: [
      {
        key: 'barbCrestDiameterMm',
        label: 'Barb crest diameter',
        unit: 'mm',
        hint: 'Widest point of each ridge. Should exceed the tubing ID so the tube grips.',
        min: 0.1,
        step: 0.05,
      },
      {
        key: 'stemDiameterMm',
        label: 'Stem diameter',
        unit: 'mm',
        hint: 'The relief between ridges, where the stretched tubing relaxes back.',
        min: 0.1,
        step: 0.05,
      },
      {
        key: 'barbCount',
        label: 'Number of ridges',
        unit: '',
        hint: 'More ridges hold harder and are harder to push on.',
        min: 1,
        step: 1,
      },
      {
        key: 'barbLengthMm',
        label: 'Spigot length',
        unit: 'mm',
        hint: 'Total height of the ridged section above the pedestal.',
        min: 0.5,
        step: 0.5,
      },
      {
        key: 'bossHeightMm',
        label: 'Pedestal height',
        unit: 'mm',
        hint: 'Straight collar under the ridges.',
        min: 0,
        step: 0.5,
      },
      BOSS_FILLET_FIELD,
    ],
    defaults: { ...BARB_1_8_GEOMETRY, bossFilletMm: BOSS_FILLET_DEFAULT_MM },
    caveat:
      'Sized for 0.125" ID tubing: a 3.5 mm crest against a 3.18 mm bore is 0.32 mm of interference, ' +
      'which soft PVC takes but stiffer tubing may not. Ridges are the first thing to snap off a resin ' +
      'print — test one before committing to a full chip.',
  },

  custom: {
    portType: 'custom',
    label: 'Custom',
    blurb: 'Free entry — define whatever your fitting needs.',
    defaultBoreMm: 1.0,
    fields: [
      { key: 'outerDiameterMm', label: 'Outer diameter', unit: 'mm', min: 0.1, step: 0.1 },
      { key: 'depthMm', label: 'Depth', unit: 'mm', min: 0.1, step: 0.5 },
      { key: 'bossHeightMm', label: 'Boss height', unit: 'mm', min: 0, step: 0.5 },
      BOSS_FILLET_FIELD,
    ],
    defaults: { outerDiameterMm: 4, depthMm: 5, bossHeightMm: 2, bossFilletMm: BOSS_FILLET_DEFAULT_MM },
  },
};

export const PORT_TYPES: PortType[] = [
  'syringe',
  'luer',
  'luer-lock',
  'luer-male',
  'barb',
  'custom',
];

/** Male fittings stand proud of the chip rather than being cut into it. */
export const isMalePort = (portType: PortType): boolean =>
  portType === 'luer-male' || portType === 'barb';

/**
 * A dimension from a port's `customSpec`, or `fallback` when it is missing,
 * not a number, or not positive. Every reader of a spec goes through this so
 * a half-typed or corrupted value falls back the same way everywhere.
 */
export function specNumber(
  spec: Record<string, unknown> | undefined,
  key: string,
  fallback: number,
): number {
  const value = spec?.[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * The base fillet a port's boss gets, mm, clamped to the boss height.
 *
 * Read separately from `specNumber` because 0 is a real answer here — a sharp
 * corner — where `specNumber` treats it as unset. A port saved before the
 * field existed gets its type's default, the same number the inspector shows.
 */
export function bossFilletMm(portType: PortType, spec: Record<string, unknown> | undefined): number {
  const boss = specNumber(spec, 'bossHeightMm', 0);
  if (boss <= 0) return 0;
  const value = spec?.bossFilletMm;
  const fillet =
    typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value
      : (PORT_PRESETS[portType]?.defaults.bossFilletMm ?? 0);
  return Math.min(fillet, boss);
}

/**
 * The footprint a port occupies on the chip face, mm.
 *
 * Drives both the canvas glyph size and the edge-spacing check — a luer boss is
 * far wider than its bore, and clearance has to be measured against the part
 * that actually collides.
 */
export function portFootprintMm(portType: PortType, spec: Record<string, unknown> = {}): number {
  switch (portType) {
    case 'luer-lock':
      // The printed hub, thread included. The collar groove around it is a
      // shallow cut into the face, not something that collides.
      return specNumber(spec, 'threadMajorDiameterMm', LUER_LOCK_GEOMETRY.threadMajorDiameterMm);
    case 'luer':
    case 'luer-male':
      return specNumber(spec, 'taperLargeDiameterMm', LUER_REFERENCE_DIAMETER_MM);
    case 'barb':
      return specNumber(spec, 'barbCrestDiameterMm', 3.5);
    case 'syringe':
      return specNumber(spec, 'barrelDiameterMm', 1.6);
    default:
      return specNumber(spec, 'outerDiameterMm', 4);
  }
}

/** The wall printed around a port's opening to make its boss or pedestal, mm. */
export const PORT_BOSS_WALL_MM = 0.8;

/**
 * The outer diameter of what a port actually prints on the chip face, mm.
 *
 * `portFootprintMm` is the opening; a port with a boss or pedestal adds
 * `PORT_BOSS_WALL_MM` of wall all round it, and that wall is what reaches the
 * chip edge first. A luer lock's footprint is already its outermost part, the
 * thread, so it is unchanged.
 */
export function portOuterFootprintMm(portType: PortType, spec: Record<string, unknown> = {}): number {
  const footprint = portFootprintMm(portType, spec);
  if (portType === 'luer-lock') return footprint;
  return specNumber(spec, 'bossHeightMm', 0) > 0 ? footprint + 2 * PORT_BOSS_WALL_MM : footprint;
}

/** Fresh `customSpec` for a port type, keeping any values the user already set. */
export function portSpecFor(
  portType: PortType,
  existing: Record<string, number | string> = {},
): Record<string, number | string> {
  const preset = PORT_PRESETS[portType];
  const next: Record<string, number | string> = {};
  for (const field of preset.fields) {
    const carried = existing[field.key];
    next[field.key] = typeof carried === 'number' ? carried : preset.defaults[field.key];
  }
  return next;
}

// ---------------------------------------------------------------------------
// real-world fitting presets
// ---------------------------------------------------------------------------

/**
 * Named, off-the-shelf fittings the user can apply in one click.
 *
 * `PORT_PRESETS` above answers "what kind of port is this"; this answers "which
 * part am I actually plugging in". The distinction matters because a scientist
 * ordering consumables thinks in catalogue numbers and tubing sizes, not in
 * taper diameters — and getting the taper wrong by a tenth of a millimetre is
 * the difference between a seal and a leak they will chase for an afternoon.
 *
 * Every entry stays fully editable after it is applied: this is a starting
 * point, not a lock.
 */
export interface FittingPreset {
  id: string;
  label: string;
  /** The `PortType` the geometry pipeline builds for this fitting. */
  portType: PortType;
  /** One line for the picker. */
  blurb: string;
  /** The physical part that mates with this port. */
  accepts: string;
  /** How this reaches the user's tubing, spelled out end to end. */
  fits: string;
  boreMm: number;
  spec: Record<string, number>;
  /** Shown when the figures are nominal rather than exact. */
  caveat?: string;
}

/**
 * Norm-Ject (Henke Sass Wolf) tips are plain ISO 80369-7 / ISO 594 cones, so
 * the entries below reach for `LUER_SLIP_GEOMETRY` and `LUER_LOCK_GEOMETRY`
 * directly rather than restating the figures. That is what keeps a default
 * luer port and its catalogue part the same part.
 */

/** Nominal PVC laboratory tubing, 1/8" ID × 3/16" OD. */
export const PVC_TUBING_1_8 = {
  label: '0.125" ID × 0.188" OD PVC',
  innerDiameterMm: 3.175,
  outerDiameterMm: 4.7625,
} as const;

export const FITTING_PRESETS: FittingPreset[] = [
  {
    id: 'norm-ject-luer-slip',
    label: 'Norm-Ject Luer slip',
    portType: 'luer',
    blurb: 'Female 6% taper sized for a Norm-Ject luer-slip tip. Push-on, no thread.',
    accepts: 'The male cone of a Norm-Ject Luer-slip syringe, or any male-luer adapter.',
    fits:
      'Reaches 0.125" ID × 0.188" OD PVC tubing through a male-luer → 1/8" hose-barb adapter. ' +
      'Friction alone holds it, so relieve any strain on the tubing before it reaches the chip.',
    boreMm: 1.6,
    spec: { ...LUER_SLIP_GEOMETRY },
    caveat:
      'Taper figures follow ISO 80369-7 nominal geometry. A resin print shrinks a little as it cures — ' +
      'print one port and test-fit before committing to a full chip.',
  },
  {
    id: 'norm-ject-luer-lock',
    label: 'Norm-Ject Luer lock',
    portType: 'luer-lock',
    blurb: 'The same taper plus external lugs, so a Luer-lock collar screws down and stays.',
    accepts: 'The male cone and threaded collar of a Norm-Ject Luer-Lock syringe.',
    fits:
      'Reaches 0.125" ID × 0.188" OD PVC tubing through a male-luer-lock → 1/8" hose-barb adapter. ' +
      'Preferred over slip whenever the line is pressurised or will be left running unattended.',
    boreMm: 1.6,
    spec: { ...LUER_LOCK_GEOMETRY },
    caveat:
      'The taper is exact; the collar is a single-start rib approximating the two-start ISO thread, ' +
      'with the pitch set to the real fitting’s lead. It screws on, but test-fit before relying on it.',
  },
  {
    id: 'male-luer-barb-1-8',
    label: 'Male luer barb · 1/8"',
    portType: 'luer-lock',
    blurb: 'Female lock socket for the male-luer × 1/8" barb adapter sold for lab tubing.',
    accepts: 'A male luer-lock × 1/8" hose-barb adapter, screwed down by its collar.',
    fits:
      'Reaches 0.125" ID × 0.188" OD PVC tubing in one part — the adapter is the whole run from ' +
      'chip to tube, with no syringe in the path. The socket is the same ISO cone as the Norm-Ject ' +
      'entry but sits on a lower boss: an adapter body is short and squat where a syringe barrel is ' +
      'long and wants the port to stand up for strain relief.',
    boreMm: 1.6,
    spec: { ...LUER_LOCK_GEOMETRY, bossHeightMm: 3 },
    caveat:
      'The taper is exact; the collar is a single-start rib approximating the two-start ISO thread, ' +
      'with the pitch set to the real fitting’s lead. Test-fit before relying on it.',
  },
  {
    id: 'female-luer-barb-1-8',
    label: 'Female luer barb · 1/8"',
    portType: 'luer-male',
    blurb: 'The chip grows the male cone, so a female-luer × 1/8" barb adapter pushes onto it.',
    accepts: 'A female luer × 1/8" hose-barb adapter, pushed onto the printed cone.',
    fits:
      'Reaches 0.125" ID × 0.188" OD PVC tubing through the adapter. Choose this over the male-barb ' +
      'entry when the female half has to be the removable one — the adapter and its tubing lift off ' +
      'and leave nothing protruding but the cone.',
    boreMm: 1.6,
    spec: { ...LUER_MALE_GEOMETRY },
    caveat:
      'This is the fragile direction to print: the cone stands 9.5 mm off the face with a 1.6 mm bore ' +
      'up the middle and nothing bracing it. Print the chip flat, and if it snaps at the pedestal, ' +
      'raise the bore-to-wall margin rather than the cone length.',
  },
  {
    id: 'integral-barb-1-8',
    label: 'Integral hose barb · 1/8"',
    portType: 'barb',
    blurb: 'Printed ridges, no adapter at all. Tubing pushes straight onto the chip.',
    accepts: 'A cut end of 0.125" ID × 0.188" OD (3.18 / 4.76 mm) PVC tubing, pushed over the ridges.',
    fits:
      'The tubing itself, with nothing in between — the shortest possible path and one less leak ' +
      'path than any adapter. Three ridges at 3.5 mm against a 3.18 mm bore give 0.32 mm of ' +
      'interference each, which soft PVC takes. Warm the tube if it will not start.',
    boreMm: 1.6,
    spec: { ...BARB_1_8_GEOMETRY },
    caveat:
      'Printed ridges are the most fragile feature on the chip and the first thing to shear when a ' +
      'tube is twisted off. Print one port and pull-test it before committing to a full chip; if the ' +
      'ridges strip, drop to two and lengthen the stem rather than deepening the crest.',
  },
  {
    id: 'pvc-tubing-1-8-socket',
    label: 'PVC tubing socket · 1/8"',
    portType: 'custom',
    blurb: 'Takes 0.188" OD tubing directly — no adapter, no syringe.',
    accepts: 'A cut end of 0.125" ID × 0.188" OD (3.18 / 4.76 mm) PVC tubing, pushed straight in.',
    fits:
      'The tubing itself. The socket is 4.70 mm against a 4.76 mm tube, so the PVC compresses ' +
      '0.06 mm and grips. Warm the tube if it will not start.',
    // Deliberately not the tubing's 3.18 mm ID: a 3 mm hole meeting a 0.8 mm
    // channel is a pocket that traps bubbles and blurs a concentration step.
    // The socket floor becomes a shoulder the tube butts against instead.
    boreMm: 1.6,
    spec: { outerDiameterMm: 4.7, depthMm: 8, bossHeightMm: 5 },
    caveat:
      'Interference fits depend on your resin and exposure. Print a test port first and open the ' +
      'socket by 0.05 mm at a time if the tubing will not seat.',
  },
];

export const findFitting = (id: string): FittingPreset | undefined =>
  FITTING_PRESETS.find((f) => f.id === id);

/**
 * Which catalogue fitting a port currently matches, if any.
 *
 * Compared on the dimensions the fitting actually defines rather than on a
 * stored id, so a port stays recognised after a round-trip through a file
 * written by an older build — and correctly stops being recognised the moment
 * the user edits a dimension away from the catalogue part. A chip that claims
 * "Norm-Ject Luer lock" while carrying a hand-tuned thread would be a lie in
 * the one place the user is trusting the app to be literal.
 */
export function matchFitting(
  portType: PortType,
  boreMm: number,
  spec: Record<string, number | string> = {},
): FittingPreset | undefined {
  // 5 µm: far below anything a resin printer resolves, so this is "the same
  // number" rather than a fuzzy match.
  const EPSILON = 0.005;

  return FITTING_PRESETS.find((fitting) => {
    if (fitting.portType !== portType) return false;
    if (Math.abs(fitting.boreMm - boreMm) > EPSILON) return false;
    return Object.entries(fitting.spec).every(([key, value]) => {
      const actual = spec[key];
      return typeof actual === 'number' && Math.abs(actual - value) <= EPSILON;
    });
  });
}
