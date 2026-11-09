/**
 * The calibration coupon, and the sheet its results are written on.
 *
 * The coupon is an ordinary OpenChip project. It is built from the same nodes,
 * segments and drainage vents as any other design and goes through the same
 * pipeline to an STL, so what it measures is the app's real output rather than
 * a special case of it.
 *
 * ## Layout
 *
 * A narrow monolithic strip crossed by straight rectangular channels, one per
 * width × height combination. Monolithic, because the vertical correction is
 * about printed ceilings and only an enclosed channel has one.
 *
 * - Every channel runs past both long edges of the strip, so it is open at
 *   both ends: it can be flushed through, and held up to a light it either
 *   shows through or does not. The Design checks panel reports these channels
 *   as running outside the chip. On the coupon that is the point.
 * - Channels are grouped by height. Each group starts with a row of **tally
 *   dots** — blind holes in the top face, one for group 1, two for group 2 —
 *   which is the printed label. OpenChip has no text primitive, and a counted
 *   dot survives a resolution at which an engraved digit would not.
 * - Within a group, channel 1 is nearest the dots and is the widest; they
 *   narrow going away from the dots. A channel's id is `group.index`.
 *
 * The widths and heights default to a spread around the printer profile's
 * minimum feature size — from well below it, where channels are expected to
 * close, to several times it, where they should not — because the fit needs
 * both outcomes to bracket the threshold.
 */

import { createProject } from '../defaults';
import type {
  ChannelEdge,
  ChannelNode,
  DrainageVent,
  OpenChipProject,
  PrinterProfile,
} from '../../types/project';
import type { ChannelResult, CouponMeasurement } from './profile';

/** Bumped when the layout changes in a way that changes what is measured. */
export const COUPON_VERSION = 1;

export interface CouponSpec {
  version: number;
  /** Channel widths, mm. Any order; laid out widest first. */
  widthsMm: number[];
  /** Channel heights, mm. One group per height, lowest first. */
  heightsMm: number[];
  /** Length of each channel, which is the width of the strip, mm. */
  channelLengthMm: number;
  /** Solid material between neighbouring channels, mm. */
  gapMm: number;
  /** Solid material under the deepest channel, mm. */
  floorMm: number;
  /** Solid material over every channel, mm. */
  roofMm: number;
  /** Diameter of a tally dot, mm. */
  dotDiameterMm: number;
}

/** How far each channel runs past the strip's edge, so the end is cut clean open. */
const OVERSHOOT_MM = 0.5;
const MAX_GROUPS = 6;

const roundTo = (value: number, step: number): number =>
  Number((Math.round(value / step) * step).toFixed(4));

const distinctSorted = (values: number[]): number[] =>
  [...new Set(values.filter((v) => Number.isFinite(v) && v > 0).map((v) => Number(v.toFixed(4))))].sort(
    (a, b) => a - b,
  );

/** A coupon spread around what this printer claims it can resolve. */
export function defaultCouponSpec(printer: PrinterProfile): CouponSpec {
  const feature = printer.minFeatureSizeMm;
  const layerMm = printer.layerHeightMicrons / 1000;

  // Widths on a 0.05 mm grid: fine enough to bracket a threshold, coarse
  // enough that neighbouring channels are meaningfully different on a desktop
  // printer.
  const widthsMm = distinctSorted(
    [0.5, 0.75, 1, 1.25, 1.5, 2, 3].map((k) => Math.max(0.1, roundTo(k * feature, 0.05))),
  );
  // Heights in whole layers, since no other height can be printed.
  const heightsMm = distinctSorted(
    [0.5, 1, 1.5, 2.5].map((k) => Math.max(layerMm * 2, roundTo(k * feature, layerMm))),
  );

  return {
    version: COUPON_VERSION,
    widthsMm,
    heightsMm,
    channelLengthMm: 14,
    gapMm: 1,
    floorMm: 1,
    roofMm: 1.5,
    dotDiameterMm: Math.max(0.8, roundTo(feature * 2.5, 0.1)),
  };
}

/** A spec with its lists cleaned up, so hand-edited values cannot break the layout. */
export function normaliseCouponSpec(spec: CouponSpec): CouponSpec {
  return {
    ...spec,
    version: COUPON_VERSION,
    widthsMm: distinctSorted(spec.widthsMm),
    heightsMm: distinctSorted(spec.heightsMm).slice(0, MAX_GROUPS),
    channelLengthMm: Math.max(4, spec.channelLengthMm),
    gapMm: Math.max(0.2, spec.gapMm),
    floorMm: Math.max(0.2, spec.floorMm),
    roofMm: Math.max(0.2, spec.roofMm),
    dotDiameterMm: Math.max(0.2, spec.dotDiameterMm),
  };
}

// ---------------------------------------------------------------------------
// layout
// ---------------------------------------------------------------------------

export interface CouponChannel {
  /** `group.index`. */
  id: string;
  group: number;
  index: number;
  widthMm: number;
  heightMm: number;
  /** Centreline position along the strip, mm from the y = 0 end. */
  yMm: number;
  edgeId: string;
}

export interface CouponLayout {
  spec: CouponSpec;
  channels: CouponChannel[];
  /** Tally dots: centre position and which group they label. */
  dots: { group: number; x: number; y: number; nodeId: string }[];
  /** Strip footprint and thickness, mm. */
  chip: { width: number; length: number; baseThickness: number; splitHeight: number };
}

export function couponLayout(input: CouponSpec): CouponLayout {
  const spec = normaliseCouponSpec(input);
  const widest = [...spec.widthsMm].sort((a, b) => b - a);
  const dotPitch = spec.dotDiameterMm + 0.8;

  const channels: CouponChannel[] = [];
  const dots: CouponLayout['dots'] = [];
  let y = spec.gapMm;

  spec.heightsMm.forEach((heightMm, g) => {
    const group = g + 1;

    // The label row. Dots start from the x = 0 end, which also tells the two
    // ends of the strip apart.
    y += spec.dotDiameterMm / 2;
    for (let d = 0; d < group; d += 1) {
      dots.push({
        group,
        x: 2 + d * dotPitch,
        y,
        nodeId: `coupon-g${group}-dot${d + 1}`,
      });
    }
    y += spec.dotDiameterMm / 2 + spec.gapMm;

    widest.forEach((widthMm, i) => {
      const index = i + 1;
      y += widthMm / 2;
      channels.push({
        id: `${group}.${index}`,
        group,
        index,
        widthMm,
        heightMm,
        yMm: Number(y.toFixed(4)),
        edgeId: `coupon-g${group}-c${index}`,
      });
      y += widthMm / 2 + spec.gapMm;
    });
  });

  const tallest = spec.heightsMm.length > 0 ? Math.max(...spec.heightsMm) : 0;
  const splitHeight = Number((spec.floorMm + tallest).toFixed(4));

  return {
    spec,
    channels,
    dots,
    chip: {
      width: spec.channelLengthMm,
      length: Number(Math.max(y, 4).toFixed(2)),
      baseThickness: Number((splitHeight + spec.roofMm).toFixed(4)),
      splitHeight,
    },
  };
}

// ---------------------------------------------------------------------------
// the project
// ---------------------------------------------------------------------------

/** The coupon as a project, ready to save as `.openchip` or open in the editor. */
export function buildCouponProject(
  input: CouponSpec,
  printerProfile: PrinterProfile,
): { project: OpenChipProject; layout: CouponLayout } {
  const layout = couponLayout(input);
  const { spec, chip } = layout;

  const nodes: ChannelNode[] = [];
  const edges: ChannelEdge[] = [];

  for (const channel of layout.channels) {
    const from = `${channel.edgeId}-a`;
    const to = `${channel.edgeId}-b`;
    nodes.push({ id: from, x: -OVERSHOOT_MM, y: channel.yMm, type: 'waypoint' });
    nodes.push({ id: to, x: chip.width + OVERSHOOT_MM, y: channel.yMm, type: 'waypoint' });
    edges.push({
      id: channel.edgeId,
      fromNodeId: from,
      toNodeId: to,
      curveType: 'straight',
      crossSection: 'rect',
      dimensionPoints: [{ t: 0, widthMm: channel.widthMm, heightMm: channel.heightMm }],
    });
  }

  // A tally dot is a drainage vent on a node with no channel under it: the
  // pipeline bores it from the top face down to the channel plane, which on a
  // bare node is simply a blind hole.
  const drainageVents: DrainageVent[] = [];
  for (const dot of layout.dots) {
    nodes.push({ id: dot.nodeId, x: dot.x, y: dot.y, type: 'waypoint' });
    drainageVents.push({
      id: `${dot.nodeId}-vent`,
      nodeId: dot.nodeId,
      diameterMm: spec.dotDiameterMm,
      autoPlaced: false,
    });
  }

  const project = createProject({
    name: `DFM calibration coupon v${COUPON_VERSION}`,
    printerProfile,
    chipParams: {
      width: chip.width,
      length: chip.length,
      baseThickness: chip.baseThickness,
      splitType: 'monolithic',
      splitHeight: chip.splitHeight,
      wallThickness: Math.min(spec.gapMm, spec.roofMm),
      minEdgeSpacing: 0,
      defaultCrossSection: 'rect',
      defaultChannelWidthMm: spec.widthsMm[spec.widthsMm.length - 1] ?? 0.8,
      defaultChannelHeightMm: spec.heightsMm[spec.heightsMm.length - 1] ?? 0.5,
    },
    channelGraph: { nodes, edges },
  });

  return { project: { ...project, drainageVents }, layout };
}

/** One blank measurement per coupon channel, in sheet order. */
export function blankMeasurements(layout: CouponLayout): CouponMeasurement[] {
  return layout.channels.map((channel) => ({
    id: channel.id,
    nominalWidthMm: channel.widthMm,
    nominalHeightMm: channel.heightMm,
    result: null,
  }));
}

// ---------------------------------------------------------------------------
// the measurement sheet
// ---------------------------------------------------------------------------

const SHEET_COLUMNS = [
  'channel',
  'group_dots',
  'position_in_group',
  'nominal_width_mm',
  'nominal_height_mm',
  'result_open_partial_closed',
  'measured_width_mm',
  'measured_height_mm',
] as const;

/**
 * The sheet as CSV: one row per channel, blank where the user writes.
 *
 * CSV because it prints from any spreadsheet, can be filled in on a laptop at
 * the bench, and reads straight back in with `parseMeasurementSheet`.
 */
export function measurementSheetCsv(measurements: CouponMeasurement[]): string {
  const rows = measurements.map((m) => {
    const [group = '', index = ''] = m.id.split('.');
    return [
      m.id,
      group,
      index,
      m.nominalWidthMm,
      m.nominalHeightMm,
      m.result ?? '',
      m.measuredWidthMm ?? '',
      m.measuredHeightMm ?? '',
    ].join(',');
  });
  return `${[SHEET_COLUMNS.join(','), ...rows].join('\n')}\n`;
}

export type SheetParseResult =
  | { ok: true; measurements: CouponMeasurement[] }
  | { ok: false; message: string; details: string[] };

const RESULT_WORDS: Record<string, ChannelResult> = {
  open: 'open',
  o: 'open',
  partial: 'partial',
  'partially open': 'partial',
  p: 'partial',
  closed: 'closed',
  c: 'closed',
  blocked: 'closed',
};

/** Reads a filled-in sheet back. Tolerant of quoting, semicolons and blank cells. */
export function parseMeasurementSheet(text: string): SheetParseResult {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) {
    return { ok: false, message: 'That sheet has no channel rows.', details: [] };
  }

  const separator = lines[0].includes(';') && !lines[0].includes(',') ? ';' : ',';
  const cells = (line: string) =>
    line.split(separator).map((cell) => cell.trim().replace(/^"|"$/g, '').trim());

  const header = cells(lines[0]).map((h) => h.toLowerCase());
  const column = (name: string) => header.indexOf(name);
  const at = {
    id: column('channel'),
    width: column('nominal_width_mm'),
    height: column('nominal_height_mm'),
    result: column('result_open_partial_closed'),
    measuredWidth: column('measured_width_mm'),
    measuredHeight: column('measured_height_mm'),
  };

  if (at.id < 0 || at.width < 0 || at.height < 0) {
    return {
      ok: false,
      message: "That file isn't an OpenChip measurement sheet.",
      details: ['It needs the columns channel, nominal_width_mm and nominal_height_mm.'],
    };
  }

  const measurements: CouponMeasurement[] = [];
  const problems: string[] = [];
  const optional = (row: string[], index: number, label: string, line: number) => {
    const raw = index >= 0 ? (row[index] ?? '') : '';
    if (raw === '') return undefined;
    const value = Number(raw.replace(',', '.'));
    if (!Number.isFinite(value) || value < 0) {
      problems.push(`Row ${line}: ${label} "${raw}" is not a number.`);
      return undefined;
    }
    return value;
  };

  lines.slice(1).forEach((line, i) => {
    const row = cells(line);
    const lineNo = i + 2;
    const id = row[at.id] ?? '';
    const width = Number(row[at.width]);
    const height = Number(row[at.height]);
    if (!id || !(width > 0) || !(height > 0)) {
      problems.push(`Row ${lineNo}: the channel id or its nominal size is missing.`);
      return;
    }

    const word = (at.result >= 0 ? (row[at.result] ?? '') : '').toLowerCase();
    const result = word === '' ? null : (RESULT_WORDS[word] ?? undefined);
    if (result === undefined) {
      problems.push(`Row ${lineNo}: result "${word}" should be open, partial or closed.`);
      return;
    }

    const measuredWidthMm = optional(row, at.measuredWidth, 'measured width', lineNo);
    const measuredHeightMm = optional(row, at.measuredHeight, 'measured height', lineNo);
    measurements.push({
      id,
      nominalWidthMm: width,
      nominalHeightMm: height,
      result,
      ...(measuredWidthMm === undefined ? {} : { measuredWidthMm }),
      ...(measuredHeightMm === undefined ? {} : { measuredHeightMm }),
    });
  });

  if (problems.length > 0) {
    return {
      ok: false,
      message: "That sheet has rows that couldn't be read, so nothing was imported.",
      details: problems.slice(0, 6),
    };
  }
  return { ok: true, measurements };
}
