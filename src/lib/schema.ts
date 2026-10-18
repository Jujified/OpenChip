/**
 * Runtime validation for `.openchip` files.
 *
 * Two rules shape this schema:
 *
 * 1. **Forward compatibility.** Containers are `looseObject`, so a file written
 *    by a later version (extra `fluidProfiles` fields, new node properties) still
 *    opens here and survives a save round-trip with its unknown keys intact.
 *    New versions add fields; silently deleting a user's fluid data
 *    because they opened the file in an older build would be data loss.
 *
 * 2. **Errors a scientist can act on.** Zod's raw issue paths read like
 *    `chipParams.width: Invalid input`. `describeIssues` below rewrites them
 *    into sentences that name the field and say what was expected.
 */

import * as z from 'zod';
import { DEFAULT_SLIDE } from './defaults';
import type { SlideParams } from '../types/project';

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------

const finite = (label: string) =>
  z.number({ error: `${label} must be a number` }).finite(`${label} must be a real number`);

const positive = (label: string) => finite(label).positive(`${label} must be greater than zero`);

const nonNegative = (label: string) =>
  finite(label).nonnegative(`${label} cannot be negative`);

const isoDate = z
  .string({ error: 'must be a date string' })
  .refine((v) => !Number.isNaN(Date.parse(v)), { error: 'must be an ISO-8601 date string' });

const vec3Mm = z.looseObject({
  x: positive('build volume X'),
  y: positive('build volume Y'),
  z: positive('build volume Z'),
});

// ---------------------------------------------------------------------------
// sections
// ---------------------------------------------------------------------------

const metaSchema = z.looseObject({
  name: z.string({ error: 'project name must be text' }).min(1, 'project name cannot be empty'),
  createdAt: isoDate,
  modifiedAt: isoDate,
  units: z.literal('mm', { error: "units must be 'mm' — OpenChip works in millimetres" }),
});

const printerProfileSchema = z.looseObject({
  name: z.string().min(1, 'printer name cannot be empty'),
  xyResolutionMicrons: positive('XY resolution'),
  layerHeightMicrons: positive('layer height'),
  minFeatureSizeMm: positive('minimum feature size'),
  buildVolumeMm: vec3Mm,
});

/**
 * A fresh copy per parse, and typed loosely enough for `looseObject`'s default
 * slot. Sharing one object across parses would hand every project the same
 * mutable slide.
 */
const freshSlide = (): SlideParams & Record<string, unknown> => ({ ...DEFAULT_SLIDE });

const chipParamsSchema = z.looseObject({
  width: positive('chip width'),
  length: positive('chip length'),
  baseThickness: positive('base thickness'),
  wallThickness: positive('wall thickness'),
  minEdgeSpacing: nonNegative('minimum edge spacing'),
  splitType: z.enum(['two-piece', 'monolithic', 'glass-slide'], {
    error: "split type must be 'two-piece', 'monolithic' or 'glass-slide'",
  }),
  splitHeight: nonNegative('split height'),

  // Defaulted, not required: older files predate these and must still open.
  defaultChannelWidthMm: positive('default channel width').default(0.8),
  defaultChannelHeightMm: positive('default channel height').default(0.5),
  defaultCrossSection: z
    .enum(['round', 'rect', 'trapezoid'], {
      error: "default cross-section must be 'round', 'rect' or 'trapezoid'",
    })
    .default('rect'),

  // Slide geometry postdates the format, so a file without it opens on the
  // standard slide rather than being rejected for a field it could not have
  // known about. The same goes field by field: a slide written before one of
  // these existed keeps what it has and defaults the rest.
  slide: z
    .looseObject({
      widthMm: positive('slide width').default(DEFAULT_SLIDE.widthMm),
      lengthMm: positive('slide length').default(DEFAULT_SLIDE.lengthMm),
      thicknessMm: positive('slide thickness').default(DEFAULT_SLIDE.thicknessMm),
      clearanceMm: nonNegative('slide clearance').default(DEFAULT_SLIDE.clearanceMm),
      bondGapMm: nonNegative('slide bond gap').default(DEFAULT_SLIDE.bondGapMm),
      offsetXMm: finite('slide X offset').default(DEFAULT_SLIDE.offsetXMm),
      offsetYMm: finite('slide Y offset').default(DEFAULT_SLIDE.offsetYMm),
    })
    .default(freshSlide),
});

const point2Schema = z.looseObject({ x: finite('x'), y: finite('y') });

const nodeBase = { id: z.string().min(1, 'node id cannot be empty'), x: finite('node x'), y: finite('node y') };

const waypointNodeSchema = z.looseObject({ ...nodeBase, type: z.literal('waypoint') });

const portNodeSchema = z.looseObject({
  ...nodeBase,
  type: z.literal('port'),
  portType: z.enum(['syringe', 'luer', 'luer-lock', 'luer-male', 'barb', 'custom'], {
    error: "port type must be 'syringe', 'luer', 'luer-lock', 'luer-male', 'barb' or 'custom'",
  }),
  diameterMm: positive('port diameter'),
  customSpec: z.record(z.string(), z.union([z.number(), z.string()])).optional(),
});

const chamberNodeSchema = z.looseObject({
  ...nodeBase,
  type: z.literal('chamber'),
  shape: z.enum(['sphere', 'cylinder'], { error: "chamber shape must be 'sphere' or 'cylinder'" }),
  sizeMm: positive('chamber size'),
  autoPlaced: z.boolean({ error: 'chamber autoPlaced must be true or false' }),
});

const channelNodeSchema = z.discriminatedUnion('type', [
  waypointNodeSchema,
  portNodeSchema,
  chamberNodeSchema,
]);

const dimensionPointSchema = z.looseObject({
  t: finite('dimension point position').min(0, 'must be between 0 and 1').max(1, 'must be between 0 and 1'),
  widthMm: positive('channel width'),
  heightMm: positive('channel height').optional(),
});

const channelEdgeSchema = z.looseObject({
  id: z.string().min(1, 'edge id cannot be empty'),
  fromNodeId: z.string().min(1, 'edge fromNodeId cannot be empty'),
  toNodeId: z.string().min(1, 'edge toNodeId cannot be empty'),
  curveType: z.enum(['straight', 'bezier'], { error: "curve type must be 'straight' or 'bezier'" }),
  controlPoints: z.array(point2Schema).optional(),
  crossSection: z.enum(['round', 'rect', 'trapezoid'], {
    error: "cross-section must be 'round', 'rect' or 'trapezoid'",
  }),
  dimensionPoints: z.array(dimensionPointSchema),
});

const channelGraphSchema = z.looseObject({
  nodes: z.array(channelNodeSchema, { error: 'channelGraph.nodes must be a list' }),
  edges: z.array(channelEdgeSchema, { error: 'channelGraph.edges must be a list' }),
});

const fluidProfileSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().min(1),
  builtIn: z.boolean(),
  // Defaulted from water, so an older file with a bare fluid entry still
  // opens rather than being rejected for fields that did not exist yet.
  densityKgM3: positive('fluid density').default(998.2),
  dynamicViscosityPaS: positive('fluid viscosity').default(0.001002),
  thermalConductivityWmK: positive('fluid thermal conductivity').default(0.598),
  specificHeatCapacityJkgK: positive('fluid specific heat').default(4182),
  inletTemperatureC: finite('inlet temperature').default(20),
});

const fluidAssignmentSchema = z.looseObject({
  portId: z.string().min(1),
  role: z.enum(['inlet', 'outlet'], { error: "port role must be 'inlet' or 'outlet'" }),
  fluidProfileId: z.string().nullable().default(null),
  flowRateUlPerMin: nonNegative('flow rate').default(10),
  inletTemperatureC: finite('inlet temperature').nullable().default(null),
});

const fluidSetupSchema = z.looseObject({
  assignments: z.array(fluidAssignmentSchema).default([]),
  chipMaterialThermalConductivityWmK: positive('chip thermal conductivity').default(0.2),
});

const drainageVentSchema = z.looseObject({
  id: z.string().min(1),
  nodeId: z.string().min(1),
  diameterMm: positive('vent diameter'),
  autoPlaced: z.boolean(),
});

const savedImageSchema = z.looseObject({
  id: z.string().min(1),
  kind: z.enum(['schematic-svg', 'cad-snapshot', 'heatmap']),
  label: z.string(),
  createdAt: isoDate,
  mimeType: z.string().min(1),
  data: z.string(),
});

// ---------------------------------------------------------------------------
// the project
// ---------------------------------------------------------------------------

export const projectSchema = z.looseObject({
  formatVersion: z.number().int('format version must be a whole number').positive(),
  meta: metaSchema,
  printerProfile: printerProfileSchema,
  chipParams: chipParamsSchema,
  channelGraph: channelGraphSchema,
  // Defaulted rather than required: files from before these fields existed, and
  // hand-edited files, should still open.
  fluidProfiles: z.array(fluidProfileSchema).default([]),
  fluidSetup: fluidSetupSchema.default({
    assignments: [],
    chipMaterialThermalConductivityWmK: 0.2,
  }),
  savedImages: z.array(savedImageSchema).default([]),
  // Added later; files written before it must still open.
  drainageVents: z.array(drainageVentSchema).default([]),
  presetLibraryRef: z.string().nullable().default(null),
});

// ---------------------------------------------------------------------------
// referential integrity
// ---------------------------------------------------------------------------

/**
 * Structural validity is not enough: an edge can point at a node that isn't
 * there. The editor assumes every edge resolves, so we reject dangling
 * references at load time rather than crashing the canvas later.
 */
export function checkGraphIntegrity(graph: {
  nodes: { id: string }[];
  edges: { id: string; fromNodeId: string; toNodeId: string }[];
}): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();

  for (const node of graph.nodes) {
    if (ids.has(node.id)) problems.push(`Two nodes share the id "${node.id}".`);
    ids.add(node.id);
  }

  const edgeIds = new Set<string>();
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) problems.push(`Two channel segments share the id "${edge.id}".`);
    edgeIds.add(edge.id);

    if (!ids.has(edge.fromNodeId)) {
      problems.push(`Channel segment "${edge.id}" starts at node "${edge.fromNodeId}", which is missing.`);
    }
    if (!ids.has(edge.toNodeId)) {
      problems.push(`Channel segment "${edge.id}" ends at node "${edge.toNodeId}", which is missing.`);
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// error formatting
// ---------------------------------------------------------------------------

const SECTION_LABELS: Record<string, string> = {
  meta: 'Project info',
  printerProfile: 'Printer profile',
  chipParams: 'Chip parameters',
  channelGraph: 'Channel network',
  fluidProfiles: 'Fluid profiles',
  savedImages: 'Saved images',
  formatVersion: 'File header',
};

/** Turns zod issues into short sentences a non-developer can act on. */
export function describeIssues(error: z.ZodError, limit = 6): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];

  for (const issue of error.issues) {
    const path = issue.path;
    const section = typeof path[0] === 'string' ? SECTION_LABELS[path[0]] ?? path[0] : 'File';
    const field = path.length > 1 ? path.slice(1).join('.') : '';

    // Zod reports a missing key as `invalid_type` against `undefined`. Left
    // alone it surfaces as "expected object, received undefined", which tells a
    // scientist nothing; what they need to know is which part is absent.
    const absent =
      issue.code === 'invalid_type' &&
      ((issue as { received?: string }).received === 'undefined' ||
        (issue as { input?: unknown }).input === undefined ||
        /received undefined/i.test(issue.message));

    let line: string;
    if (absent) {
      line = field ? `${section}: "${field}" is missing.` : `${section} is missing.`;
    } else {
      line = field ? `${section} → ${field}: ${issue.message}` : `${section}: ${issue.message}`;
    }

    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
    if (lines.length >= limit) break;
  }

  const remaining = error.issues.length - lines.length;
  if (remaining > 0) lines.push(`…and ${remaining} more problem${remaining === 1 ? '' : 's'}.`);

  return lines;
}
