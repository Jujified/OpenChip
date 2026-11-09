/**
 * The print-correction profile: a `.ocdfm` file.
 *
 * A profile describes how one printer, with one resin at one set of exposure
 * settings, departs from the geometry it is asked to print — and carries the
 * coupon measurements that description was fitted from. It is deliberately a
 * file of its own rather than a section of `.openchip`:
 *
 * - it belongs to a machine and a bottle of resin, not to a chip, so one
 *   profile serves every design printed on that setup;
 * - it can be shared with a colleague running the same printer without
 *   sharing a design;
 * - a design file that never mentions it stays a description of the *nominal*
 *   chip, which is what a paper cites and what a different printer needs.
 *
 * Units are in the field names, as in the project file: `Mm` is millimetres,
 * `Microns` is micrometres, `S` is seconds.
 *
 * Like `projectFile.ts`, this module is free of React and of storage: it turns
 * text into a validated profile and back.
 */

import * as z from 'zod';

export const DFM_PROFILE_EXTENSION = '.ocdfm';
export const DFM_PROFILE_MIME = 'application/json';
/** Marks the file as a profile, so a renamed project file is not mistaken for one. */
export const DFM_PROFILE_KIND = 'openchip-dfm-profile';
/** Bumped when the on-disk shape changes in a way an older build cannot read. */
export const DFM_SCHEMA_VERSION = 1;
/** The compensation model this build fits and applies. See `model.ts`. */
export const DFM_MODEL_ID = 'edge-bleed-v1';

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export type ChannelResult = 'open' | 'partial' | 'closed';

/** One coupon channel as the user found it. */
export interface CouponMeasurement {
  /** `group.index`, as printed on the measurement sheet, e.g. `2.3`. */
  id: string;
  /** Width the channel was drawn at, mm. */
  nominalWidthMm: number;
  /** Height the channel was drawn at, mm. */
  nominalHeightMm: number;
  /** Null when the channel was not checked. */
  result: ChannelResult | null;
  /** Width actually measured, mm. Optional — a microscope is not assumed. */
  measuredWidthMm?: number;
  /** Height actually measured, mm. */
  measuredHeightMm?: number;
}

export type FitMethod = 'measured' | 'open-closed' | 'manual' | 'none';

/** How one axis of the fit was arrived at, and what it rests on. */
export interface AxisFit {
  method: FitMethod;
  /** Channels that informed this axis. */
  dataPoints: number;
  /** RMS residual of a `measured` fit, mm. */
  rmsMm?: number;
  /**
   * The interval an `open-closed` fit can place the offset in, mm. The upper
   * end is null when nothing in the coupon stayed open to bound it.
   */
  bracketMm?: [number, number | null];
  /** Channels an `open-closed` fit could not reconcile with any threshold. */
  inconsistent?: number;
}

export interface DfmCompensation {
  model: typeof DFM_MODEL_ID;
  /** Lateral bleed per side on an isolated edge, mm. */
  deltaXyMm: number;
  /**
   * Decay length of the stray dose across a channel, mm. Zero makes the lateral
   * offset the same at every width; above zero, narrow channels lose more.
   */
  lateralDecayMm: number;
  /** Vertical cure-through into a channel ceiling, mm. */
  deltaZMm: number;
  /** Round compensated widths to whole pixels, when the pixel size is known. */
  snapToPixelGrid: boolean;
}

export interface DfmProfileMeta {
  name: string;
  printerModel: string;
  resin: string;
  layerHeightMicrons: number;
  /** As entered. Nothing here is used by the model; it identifies the setup. */
  exposure: {
    normalExposureS: number | null;
    bottomExposureS: number | null;
    bottomLayers: number | null;
    /** Anything else worth recording: lift speed, rest time, light-off delay. */
    other: string;
  };
  /** XY pixel pitch, microns. Null when unknown. */
  xyPixelMicrons: number | null;
  /** ISO-8601 timestamp. */
  createdAt: string;
  notes: string;
}

export interface DfmCouponInfo {
  /** Version of the coupon layout the measurements came from. */
  version: number;
  widthsMm: number[];
  heightsMm: number[];
}

export interface DfmProfile {
  kind: typeof DFM_PROFILE_KIND;
  schemaVersion: number;
  meta: DfmProfileMeta;
  compensation: DfmCompensation;
  fit: { lateral: AxisFit; vertical: AxisFit };
  coupon: DfmCouponInfo;
  /** Kept in full so the profile can be re-fitted when the model improves. */
  measurements: CouponMeasurement[];
}

/** What a `.openchip` file may remember about the profile it was last exported with. */
export interface DfmProfileRef {
  name: string;
  sha256: string;
}

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

const finite = (label: string) =>
  z.number({ error: `${label} must be a number` }).finite(`${label} must be a real number`);
const positive = (label: string) => finite(label).positive(`${label} must be greater than zero`);
const nonNegative = (label: string) => finite(label).nonnegative(`${label} cannot be negative`);

const resultSchema = z
  .enum(['open', 'partial', 'closed'], { error: "result must be 'open', 'partial' or 'closed'" })
  .nullable()
  .default(null);

const measurementSchema = z.looseObject({
  id: z.string({ error: 'channel id must be text' }).min(1, 'channel id cannot be empty'),
  nominalWidthMm: positive('nominal width'),
  nominalHeightMm: positive('nominal height'),
  result: resultSchema,
  measuredWidthMm: nonNegative('measured width').optional(),
  measuredHeightMm: nonNegative('measured height').optional(),
});

const axisFitSchema = z.looseObject({
  method: z
    .enum(['measured', 'open-closed', 'manual', 'none'], {
      error: "fit method must be 'measured', 'open-closed', 'manual' or 'none'",
    })
    .default('manual'),
  dataPoints: nonNegative('fit data points').default(0),
  rmsMm: nonNegative('fit residual').optional(),
  bracketMm: z.tuple([finite('bracket'), finite('bracket').nullable()]).optional(),
  inconsistent: nonNegative('inconsistent channels').optional(),
});

const freshAxisFit = (): AxisFit & Record<string, unknown> => ({ method: 'manual', dataPoints: 0 });

const profileSchema = z.looseObject({
  kind: z.literal(DFM_PROFILE_KIND, {
    error: 'this is not an OpenChip print-correction profile',
  }),
  schemaVersion: z.number().int('schema version must be a whole number').positive(),
  meta: z.looseObject({
    name: z.string({ error: 'profile name must be text' }).min(1, 'profile name cannot be empty'),
    printerModel: z.string({ error: 'printer model must be text' }).default(''),
    resin: z.string({ error: 'resin must be text' }).default(''),
    layerHeightMicrons: positive('layer height'),
    exposure: z
      .looseObject({
        normalExposureS: nonNegative('normal exposure').nullable().default(null),
        bottomExposureS: nonNegative('bottom exposure').nullable().default(null),
        bottomLayers: nonNegative('bottom layer count').nullable().default(null),
        other: z.string().default(''),
      })
      .default({ normalExposureS: null, bottomExposureS: null, bottomLayers: null, other: '' }),
    xyPixelMicrons: positive('XY pixel size').nullable().default(null),
    createdAt: z
      .string({ error: 'creation date must be a date string' })
      .refine((v) => !Number.isNaN(Date.parse(v)), {
        error: 'creation date must be an ISO-8601 date string',
      }),
    notes: z.string().default(''),
  }),
  compensation: z.looseObject({
    model: z.literal(DFM_MODEL_ID, {
      error: `compensation model must be '${DFM_MODEL_ID}'`,
    }),
    deltaXyMm: nonNegative('lateral offset (deltaXyMm)'),
    lateralDecayMm: nonNegative('lateral decay length (lateralDecayMm)').default(0),
    deltaZMm: nonNegative('vertical offset (deltaZMm)'),
    snapToPixelGrid: z.boolean({ error: 'snapToPixelGrid must be true or false' }).default(false),
  }),
  fit: z
    .looseObject({
      lateral: axisFitSchema.default(freshAxisFit),
      vertical: axisFitSchema.default(freshAxisFit),
    })
    .default(() => ({ lateral: freshAxisFit(), vertical: freshAxisFit() })),
  coupon: z.looseObject({
    version: z.number().int('coupon version must be a whole number').positive(),
    widthsMm: z.array(positive('coupon width')).default([]),
    heightsMm: z.array(positive('coupon height')).default([]),
  }),
  measurements: z.array(measurementSchema, { error: 'measurements must be a list' }).default([]),
});

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------

export interface DfmParseSuccess {
  ok: true;
  profile: DfmProfile;
}

export interface DfmParseFailure {
  ok: false;
  /** One-line summary for a toast. */
  message: string;
  /** Specific, actionable problems. May be empty. */
  details: string[];
}

export type DfmParseResult = DfmParseSuccess | DfmParseFailure;

const SECTION_LABELS: Record<string, string> = {
  kind: 'File header',
  schemaVersion: 'File header',
  meta: 'Profile info',
  compensation: 'Compensation parameters',
  fit: 'Fit summary',
  coupon: 'Coupon',
  measurements: 'Coupon measurements',
};

/** The value a zod issue path points at in the raw file, or undefined. */
function valueAt(raw: unknown, path: PropertyKey[]): unknown {
  let current = raw;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<PropertyKey, unknown>)[key];
  }
  return current;
}

function describe(error: z.ZodError, raw: unknown, limit = 6): string[] {
  const lines: string[] = [];
  for (const issue of error.issues) {
    const [head, ...rest] = issue.path;
    const section = typeof head === 'string' ? (SECTION_LABELS[head] ?? head) : 'File';
    const field = rest.join('.');
    // Zod reports a missing key as a type error against `undefined`, and does
    // not include the offending value in the issue. Looking the path up in the
    // file is what tells "absent" from "present but the wrong type".
    const absent = issue.code === 'invalid_type' && valueAt(raw, issue.path) === undefined;
    const line = absent
      ? field
        ? `${section}: "${field}" is missing.`
        : `${section} is missing.`
      : field
        ? `${section} → ${field}: ${issue.message}`
        : `${section}: ${issue.message}`;
    if (!lines.includes(line)) lines.push(line);
    if (lines.length >= limit) break;
  }
  const remaining = error.issues.length - lines.length;
  if (remaining > 0) lines.push(`…and ${remaining} more problem${remaining === 1 ? '' : 's'}.`);
  return lines;
}

export function parseDfmProfile(text: string): DfmParseResult {
  if (text.trim().length === 0) {
    return { ok: false, message: 'That file is empty.', details: [] };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      message: "That file isn't valid JSON, so it can't be read as a print-correction profile.",
      details: [error instanceof Error ? error.message : String(error)],
    };
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      message: "That file isn't a print-correction profile.",
      details: ['The file parsed as JSON, but it is not a profile object.'],
    };
  }

  const record = raw as Record<string, unknown>;

  // A project file dropped here is the likeliest mistake, and "kind is missing"
  // would not tell anyone what they did.
  if (record.kind !== DFM_PROFILE_KIND && 'channelGraph' in record) {
    return {
      ok: false,
      message: 'That is an OpenChip project, not a print-correction profile.',
      details: [`Profiles end in ${DFM_PROFILE_EXTENSION}. Open a project from Project → Open Project.`],
    };
  }

  // Unlike a project file, a newer profile is refused rather than opened with
  // its unknown parts ignored. A project's unknown fields are things this build
  // does not draw; a profile's would be terms of a model this build does not
  // apply, and exporting with half a correction is worse than exporting none.
  const version = record.schemaVersion;
  if (typeof version === 'number' && version > DFM_SCHEMA_VERSION) {
    return {
      ok: false,
      message: 'That profile was saved by a newer version of OpenChip.',
      details: [
        `It uses profile format ${version}; this build reads up to format ${DFM_SCHEMA_VERSION}.`,
        'Update OpenChip to use it. Nothing was changed.',
      ],
    };
  }

  const result = profileSchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      message: "That profile is missing or has invalid data, so it wasn't loaded.",
      details: describe(result.error as z.ZodError, raw),
    };
  }

  return { ok: true, profile: result.data as unknown as DfmProfile };
}

// ---------------------------------------------------------------------------
// serialise
// ---------------------------------------------------------------------------

/** Pretty-printed JSON, like a project file. */
export function serializeDfmProfile(profile: DfmProfile): string {
  return `${JSON.stringify(profile, null, 2)}\n`;
}

/** Filesystem-safe filename derived from the profile name. */
export function dfmProfileFileName(name: string): string {
  const base = name
    .trim()
    .replace(/[^a-zA-Z0-9-_ ]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return `${base || 'print-correction'}${DFM_PROFILE_EXTENSION}`;
}

// ---------------------------------------------------------------------------
// content hash
// ---------------------------------------------------------------------------

/**
 * The profile as text with object keys in a fixed order and no whitespace.
 *
 * Hashing this rather than the file's bytes means re-indenting a profile, or
 * passing it through a tool that reorders keys, does not make it a "different"
 * profile — only a change to its contents does.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 of the profile's canonical form, as lowercase hex. */
export async function hashDfmProfile(profile: DfmProfile): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(profile));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The first characters of a hash, for filenames and the 80-byte STL header. */
export const shortHash = (sha256: string): string => sha256.slice(0, 12);
