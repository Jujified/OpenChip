/**
 * Print correction: nominal design + profile → the design to send to the printer.
 *
 * `compensateDesign` is the **only** place compensation is computed. The STL
 * export, the OpenSCAD export and the read-only preview all call it and hand
 * its result to the ordinary pipeline, so they cannot disagree about what a
 * compensated chip looks like.
 *
 * It is pure: nothing here touches a store, and the nominal design passed in is
 * never modified. The result is a second design, expressed almost entirely in
 * the terms the pipeline already understands —
 *
 * - **lateral bleed** becomes wider dimension markers on a copy of the graph,
 *   and larger chamber and drainage-vent diameters;
 * - **vertical cure-through** becomes one number, `ceilingRaiseMm`, which the
 *   pipeline applies to every roof while leaving floors where they were drawn.
 *
 * ## Assumptions, stated once
 *
 * 1. The chip is printed flat with its base (z = 0) on the build plate, so the
 *    layers that form a channel's roof are printed after the channel. Tilted or
 *    inverted prints put the cure-through on a different face.
 * 2. The ceiling raise applies only to **roofed** channels, which means
 *    monolithic chips. A two-piece or glass-slide chip prints its channels as
 *    open grooves; there is no printed ceiling to cure downwards.
 * 3. Lateral bleed is the same on both walls and in every direction in XY.
 * 4. **Port and fitting geometry is left nominal.** A Luer taper is a fit to a
 *    standard part, and widening it from channel measurements would loosen the
 *    seal. Channels, corner joints, chambers and drainage vents are corrected.
 * 5. The same coupon-derived lateral offset is used for open grooves as for
 *    enclosed channels, although the coupon measures enclosed ones.
 * 6. Cross-sections keep their kind. A round channel is corrected as a larger
 *    circle, which also lowers its lowest point by the lateral offset; a
 *    trapezoid is widened at the top and keeps its draft ratio, so its floor
 *    widens by 0.7 of what the top does. Both err towards a slightly larger
 *    channel.
 */

import {
  buildChains,
  chainMarkers,
  getLoft,
  sizeAtDistance,
  type Chain,
  type ChainMarker,
} from '../loft';
import { ceilingZ, placeChannel } from '../cad/placement';
import { withChannelPlane } from '../cad/slide';
import { checkChannelSpacing } from '../validation/manufacturability';
import {
  DEFAULT_VALIDATION_SETTINGS,
  type ValidationSettings,
  type Warning,
} from '../validation/types';
import type {
  ChannelEdge,
  ChannelGraph,
  ChipParams,
  DimensionPoint,
  DrainageVent,
  Point2,
  PrinterProfile,
} from '../../types/project';
import { bleedPerSideMm, drawnWidthForMm, type LateralModel } from './model';
import type { DfmProfile } from './profile';

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

/** Everything about a design that compensation reads. */
export interface NominalDesign {
  graph: ChannelGraph;
  chipParams: ChipParams;
  drainageVents: DrainageVent[];
  printerProfile: PrinterProfile;
}

export type DfmConflictKind =
  /** Two channels left with less wall between them than the printable minimum. */
  | 'wall-too-thin'
  /** Two channels that now touch or overlap. */
  | 'channels-merge'
  /** A channel pushed closer to the chip edge than the edge spacing allows. */
  | 'edge-clearance'
  /** A raised ceiling left with less material above it than the wall thickness. */
  | 'ceiling-too-thin'
  /** A raised ceiling that reaches the top face. */
  | 'ceiling-breakthrough';

export interface DfmConflict {
  /** Stable for the same offending features, so a list keeps its order between runs. */
  id: string;
  kind: DfmConflictKind;
  edgeIds: string[];
  nodeIds: string[];
  /** Where it is, in chip mm. */
  focus?: Point2;
  /** The measurement before compensation, when the nominal design already reported it. */
  nominalMm: number | null;
  /** The measurement after compensation, mm. Negative means overlap. */
  compensatedMm: number;
  /** What it has to be to pass, mm. */
  limitMm: number;
  /** `limitMm − compensatedMm`: how much is missing. */
  shortfallMm: number;
  /** One sentence naming the features and the numbers. */
  message: string;
}

export interface AppliedCompensation {
  /** Isolated-edge lateral offset per side, mm. */
  deltaXyMm: number;
  lateralDecayMm: number;
  /** Ceiling raise actually applied, mm. Zero when the chip has no roofed channels. */
  deltaZMm: number;
  /** The profile's vertical offset, whether or not it was applied. */
  profileDeltaZMm: number;
  /** Why the ceiling raise was skipped, or null when it was applied. */
  ceilingSkipped: string | null;
  /** Smallest and largest total width increase across the channel markers, mm. */
  widthIncreaseMm: { min: number; max: number };
  /** Pixel size widths were snapped to, mm, or null when not snapped. */
  snappedToPixelMm: number | null;
}

export interface CompensatedDesign {
  graph: ChannelGraph;
  chipParams: ChipParams;
  drainageVents: DrainageVent[];
  /** Hand to `buildChip` / `exportScad` as `ceilingRaiseMm`. */
  ceilingRaiseMm: number;
  applied: AppliedCompensation;
  conflicts: DfmConflict[];
}

export interface CompensateOptions {
  /** Thresholds for the conflict check. Defaults to the app's own. */
  settings?: ValidationSettings;
}

// ---------------------------------------------------------------------------
// lateral
// ---------------------------------------------------------------------------

/**
 * Widest nominal step between two inserted markers on a taper, mm.
 *
 * The loft interpolates width linearly between markers. With λ > 0 the
 * correction is not linear in width, so correcting only the user's own markers
 * would leave the middle of a long taper slightly under-corrected. Extra
 * markers every 0.05 mm of nominal width keep that under a micron.
 */
const TAPER_STEP_MM = 0.05;
const MAX_TAPER_INSERTS = 24;

/** Where a distance along a chain falls: which edge, and at what `t` on it. */
function locateOnChain(chain: Chain, distanceMm: number): { edge: ChannelEdge; t: number } | null {
  for (const member of chain.members) {
    const end = member.startDistance + member.lengthMm;
    if (distanceMm > end + 1e-9) continue;
    const local =
      member.lengthMm < 1e-9 ? 0 : (distanceMm - member.startDistance) / member.lengthMm;
    const clamped = Math.min(1, Math.max(0, local));
    return { edge: member.edge, t: member.reversed ? 1 - clamped : clamped };
  }
  return null;
}

function compensateGraph(
  graph: ChannelGraph,
  chipParams: ChipParams,
  widen: (widthMm: number) => number,
  nonLinear: boolean,
): { graph: ChannelGraph; increase: { min: number; max: number } } {
  const fallback = {
    widthMm: chipParams.defaultChannelWidthMm,
    heightMm: chipParams.defaultChannelHeightMm,
  };
  const points = new Map<string, DimensionPoint[]>();
  const increase = { min: Infinity, max: 0 };

  const put = (edge: ChannelEdge, t: number, widthMm: number, heightMm: number | undefined) => {
    const out = widen(widthMm);
    increase.min = Math.min(increase.min, out - widthMm);
    increase.max = Math.max(increase.max, out - widthMm);
    const list = points.get(edge.id) ?? [];
    list.push(heightMm === undefined ? { t, widthMm: out } : { t, widthMm: out, heightMm });
    points.set(edge.id, list);
  };

  for (const chain of buildChains(graph)) {
    const markers: ChainMarker[] = chainMarkers(chain);

    if (markers.length === 0) {
      // No markers means "the project default everywhere". The default itself
      // is not touched — it belongs to the design — so the chain gets one
      // explicit marker carrying the corrected default instead.
      const first = chain.members[0];
      if (first) {
        put(
          first.edge,
          0,
          fallback.widthMm,
          first.edge.crossSection === 'round' ? undefined : fallback.heightMm,
        );
      }
      continue;
    }

    const byId = new Map(chain.members.map((m) => [m.edge.id, m.edge]));
    for (let i = 0; i < markers.length; i += 1) {
      const marker = markers[i];
      const edge = byId.get(marker.edgeId);
      if (edge) put(edge, marker.t, marker.widthMm, marker.heightMm);

      const next = markers[i + 1];
      if (!nonLinear || !next) continue;

      const steps = Math.min(
        MAX_TAPER_INSERTS,
        Math.ceil(Math.abs(next.widthMm - marker.widthMm) / TAPER_STEP_MM),
      );
      for (let k = 1; k < steps; k += 1) {
        const distanceMm = marker.distanceMm + ((next.distanceMm - marker.distanceMm) * k) / steps;
        const at = locateOnChain(chain, distanceMm);
        if (!at) continue;
        const size = sizeAtDistance(markers, distanceMm, fallback);
        put(at.edge, at.t, size.widthMm, size.heightMm);
      }
    }
  }

  const edges = graph.edges.map((edge) => {
    const next = points.get(edge.id);
    if (!next) return edge;
    return { ...edge, dimensionPoints: next.sort((a, b) => a.t - b.t) };
  });

  // A chamber's wall bleeds like any other; ports are deliberately left alone.
  const nodes = graph.nodes.map((node) =>
    node.type === 'chamber' ? { ...node, sizeMm: widen(node.sizeMm) } : node,
  );

  if (increase.min === Infinity) increase.min = 0;
  return { graph: { ...graph, nodes, edges }, increase };
}

// ---------------------------------------------------------------------------
// conflicts
// ---------------------------------------------------------------------------

const mm = (value: number): string => String(Number(value.toFixed(3)));

/**
 * Thin-wall and merge conflicts, found with the design check itself.
 *
 * The same spacing check the Design checks panel runs is run on the nominal
 * and on the compensated design. A conflict is a failing measurement that
 * compensation created or made worse — a wall that was already too thin as
 * drawn is the design's own warning, not something this transform did, unless
 * it got thinner.
 */
function wallConflicts(
  nominal: NominalDesign,
  compensated: ChannelGraph,
  settings: ValidationSettings,
): DfmConflict[] {
  const run = (graph: ChannelGraph): Warning[] =>
    checkChannelSpacing({
      graph,
      chipParams: nominal.chipParams,
      printerProfile: nominal.printerProfile,
      settings,
    });

  const before = new Map(run(nominal.graph).map((w) => [w.id, w]));
  const conflicts: DfmConflict[] = [];

  for (const warning of run(compensated)) {
    if (!warning.measurement) continue;
    const { value, limit } = warning.measurement;
    const nominalMm = before.get(warning.id)?.measurement?.value ?? null;
    if (nominalMm !== null && value >= nominalMm - 1e-6) continue;

    const [a, b] = warning.target.edgeIds;
    const features = `segments ${a} and ${b}`;
    const was = nominalMm === null ? '' : ` (was ${mm(nominalMm)} mm)`;
    const merged = value < 0;

    conflicts.push({
      id: `dfm:${warning.id}`,
      kind: merged ? 'channels-merge' : 'wall-too-thin',
      edgeIds: warning.target.edgeIds,
      nodeIds: [],
      focus: warning.target.focus,
      nominalMm,
      compensatedMm: value,
      limitMm: limit,
      shortfallMm: limit - value,
      message: merged
        ? `Compensation makes ${features} overlap by ${mm(-value)} mm${was}, so they would print as one cavity.`
        : `Compensation leaves ${mm(value)} mm of wall between ${features}${was}; ` +
          `the minimum is ${mm(limit)} mm, so it is ${mm(limit - value)} mm short.`,
    });
  }

  return conflicts;
}

/**
 * Channels and chambers pushed closer to the chip edge than the edge spacing.
 *
 * Measured here rather than with the boundary design check, which sizes a
 * plain waypoint from the project default width and so cannot see a channel
 * that compensation widened. A feature that already ran off the chip as drawn
 * is skipped: it is cut open by the edge either way, which on a calibration
 * coupon is deliberate.
 */
function edgeConflicts(nominal: NominalDesign, compensated: ChannelGraph): DfmConflict[] {
  const { chipParams } = nominal;
  const limit = chipParams.minEdgeSpacing;
  const clearance = (x: number, y: number, half: number): number =>
    Math.min(x - half, chipParams.width - (x + half), y - half, chipParams.length - (y + half));

  const conflicts: DfmConflict[] = [];
  const report = (
    id: string,
    features: string,
    target: Pick<DfmConflict, 'edgeIds' | 'nodeIds'>,
    before: number,
    after: number,
    focus: Point2,
  ) => {
    if (before < 0 || after >= limit || after >= before - 1e-6) return;
    conflicts.push({
      id,
      kind: 'edge-clearance',
      ...target,
      focus,
      nominalMm: before,
      compensatedMm: after,
      limitMm: limit,
      shortfallMm: limit - after,
      message:
        after < 0
          ? `Compensation pushes ${features} ${mm(-after)} mm past the chip edge (was ${mm(before)} mm inside it).`
          : `Compensation leaves ${features} ${mm(after)} mm from the chip edge (was ${mm(before)} mm); ` +
            `the edge spacing is ${mm(limit)} mm, so it is ${mm(limit - after)} mm short.`,
    });
  };

  const loftBefore = getLoft(nominal.graph, chipParams);
  const loftAfter = getLoft(compensated, chipParams);
  for (const edge of nominal.graph.edges) {
    const worst = (samples: { point: Point2; widthMm: number }[] | undefined) => {
      let value = Infinity;
      let where: Point2 = { x: 0, y: 0 };
      for (const sample of samples ?? []) {
        const c = clearance(sample.point.x, sample.point.y, sample.widthMm / 2);
        if (c < value) {
          value = c;
          where = sample.point;
        }
      }
      return { value, where };
    };
    const before = worst(loftBefore.edges.get(edge.id)?.samples);
    const after = worst(loftAfter.edges.get(edge.id)?.samples);
    report(
      `dfm:boundary-edge:${edge.id}`,
      `segment ${edge.id}`,
      { edgeIds: [edge.id], nodeIds: [] },
      before.value,
      after.value,
      after.where,
    );
  }

  const chambersAfter = new Map(compensated.nodes.map((n) => [n.id, n]));
  for (const node of nominal.graph.nodes) {
    const after = chambersAfter.get(node.id);
    if (node.type !== 'chamber' || after?.type !== 'chamber') continue;
    report(
      `dfm:boundary:${node.id}`,
      `chamber ${node.id}`,
      { edgeIds: [], nodeIds: [node.id] },
      clearance(node.x, node.y, node.sizeMm / 2),
      clearance(node.x, node.y, after.sizeMm / 2),
      { x: node.x, y: node.y },
    );
  }

  return conflicts;
}

/** Material left above the highest ceiling, before and after the raise. */
function ceilingConflicts(nominal: NominalDesign, ceilingRaiseMm: number): DfmConflict[] {
  if (ceilingRaiseMm <= 0) return [];

  const chipParams = withChannelPlane(nominal.chipParams);
  const loft = getLoft(nominal.graph, chipParams);
  const limit = chipParams.wallThickness;

  let worstNominal = Infinity;
  let where: Point2 | undefined;
  const edgeIds: string[] = [];

  for (const edge of nominal.graph.edges) {
    const solved = loft.edges.get(edge.id);
    if (!solved) continue;

    let edgeWorst = Infinity;
    for (const sample of solved.samples) {
      // The roof height does not depend on the lateral correction, so the
      // nominal loft gives the right answer for both designs.
      const roof = ceilingZ(
        placeChannel(edge.crossSection, sample.widthMm, sample.heightMm, chipParams.splitHeight),
      );
      const skin = chipParams.baseThickness - roof;
      if (skin < edgeWorst) edgeWorst = skin;
      if (skin < worstNominal) {
        worstNominal = skin;
        where = sample.point;
      }
    }
    if (edgeWorst - ceilingRaiseMm < limit) edgeIds.push(edge.id);
  }

  if (edgeIds.length === 0) return [];

  const after = worstNominal - ceilingRaiseMm;
  const through = after <= 0;
  const count = `${edgeIds.length} segment${edgeIds.length === 1 ? '' : 's'}`;

  return [
    {
      id: 'dfm:ceiling',
      kind: through ? 'ceiling-breakthrough' : 'ceiling-too-thin',
      edgeIds,
      nodeIds: [],
      focus: where,
      nominalMm: worstNominal,
      compensatedMm: after,
      limitMm: limit,
      shortfallMm: limit - after,
      message: through
        ? `Raising the ceilings by ${mm(ceilingRaiseMm)} mm breaks through the top face on ${count} ` +
          `(the roof was ${mm(worstNominal)} mm thick). Make the chip thicker or lower the split height.`
        : `Raising the ceilings by ${mm(ceilingRaiseMm)} mm leaves a ${mm(after)} mm roof over ${count} ` +
          `(was ${mm(worstNominal)} mm); the wall thickness is ${mm(limit)} mm, so it is ${mm(limit - after)} mm short.`,
    },
  ];
}

// ---------------------------------------------------------------------------
// the transform
// ---------------------------------------------------------------------------

export function compensateDesign(
  nominal: NominalDesign,
  profile: DfmProfile,
  options: CompensateOptions = {},
): CompensatedDesign {
  const settings = options.settings ?? DEFAULT_VALIDATION_SETTINGS;
  const { compensation, meta } = profile;

  const model: LateralModel = {
    deltaXyMm: Math.max(0, compensation.deltaXyMm),
    lateralDecayMm: Math.max(0, compensation.lateralDecayMm),
  };
  const lateral = model.deltaXyMm > 0 || model.lateralDecayMm > 0;

  // Only the size is snapped. Where a channel lands on the pixel grid is
  // decided by where the slicer puts the part on the plate, which is not known
  // here; a width that is a whole number of pixels at least can be aligned.
  const pixelMm =
    compensation.snapToPixelGrid && meta.xyPixelMicrons ? meta.xyPixelMicrons / 1000 : null;

  const widen = (widthMm: number): number => {
    if (!lateral) return widthMm;
    const drawn = drawnWidthForMm(widthMm, model);
    if (!pixelMm) return drawn;
    // Never snap below the nominal width: rounding a correction away entirely
    // would leave the channel narrower than an uncompensated export.
    return Math.max(widthMm, Math.round(drawn / pixelMm) * pixelMm);
  };

  const roofed = nominal.chipParams.splitType === 'monolithic';
  const profileDeltaZMm = Math.max(0, compensation.deltaZMm);
  const ceilingRaiseMm = roofed ? profileDeltaZMm : 0;
  const ceilingSkipped =
    roofed || profileDeltaZMm === 0
      ? null
      : nominal.chipParams.splitType === 'glass-slide'
        ? 'The channels are open grooves closed by the glass slide, so there is no printed ceiling to correct.'
        : 'A two-piece chip prints its channels as open grooves, so there is no printed ceiling to correct.';

  const appliedBase = {
    deltaXyMm: model.deltaXyMm,
    lateralDecayMm: model.lateralDecayMm,
    deltaZMm: ceilingRaiseMm,
    profileDeltaZMm,
    ceilingSkipped,
    snappedToPixelMm: lateral ? pixelMm : null,
  };

  // A profile that changes nothing returns the design it was given, by
  // identity — the cheapest possible proof that a null correction is a no-op.
  if (!lateral && ceilingRaiseMm === 0) {
    return {
      graph: nominal.graph,
      chipParams: nominal.chipParams,
      drainageVents: nominal.drainageVents,
      ceilingRaiseMm: 0,
      applied: { ...appliedBase, widthIncreaseMm: { min: 0, max: 0 } },
      conflicts: [],
    };
  }

  const widened = lateral
    ? compensateGraph(nominal.graph, nominal.chipParams, widen, model.lateralDecayMm > 0)
    : { graph: nominal.graph, increase: { min: 0, max: 0 } };

  const drainageVents = lateral
    ? nominal.drainageVents.map((vent) => ({ ...vent, diameterMm: widen(vent.diameterMm) }))
    : nominal.drainageVents;

  const conflicts = [
    ...(lateral ? wallConflicts(nominal, widened.graph, settings) : []),
    ...(lateral ? edgeConflicts(nominal, widened.graph) : []),
    ...ceilingConflicts(nominal, ceilingRaiseMm),
  ].sort((a, b) => b.shortfallMm - a.shortfallMm);

  return {
    graph: widened.graph,
    chipParams: nominal.chipParams,
    drainageVents,
    ceilingRaiseMm,
    applied: { ...appliedBase, widthIncreaseMm: widened.increase },
    conflicts,
  };
}

/** Per-side lateral offset the profile applies at a given nominal width, mm. */
export function lateralOffsetAtMm(nominalWidthMm: number, profile: DfmProfile): number {
  const model: LateralModel = {
    deltaXyMm: Math.max(0, profile.compensation.deltaXyMm),
    lateralDecayMm: Math.max(0, profile.compensation.lateralDecayMm),
  };
  const drawn = drawnWidthForMm(nominalWidthMm, model);
  return bleedPerSideMm(drawn, model);
}
