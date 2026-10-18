/**
 * Will the printer actually make this?
 *
 * Every check here measures the design against the active `printerProfile`
 * rather than against a hard-coded rule, because "too small" is a property of
 * the machine, not of microfluidics.
 */

import { distance } from '../geometry';
import { nodeFootprintMm } from '../graphOps';
import { getLoft } from '../loft';
import { LUER_TAPER, specNumber } from '../ports';
import type { Warning } from './types';
import type { ChannelNode, Point2 } from '../../types/project';
import type { ValidationInput } from './types';

const mm = (n: number) => Math.round(n * 1000) / 1000;

const midpoint = (a: Point2, b: Point2): Point2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** Names a node the way the user thinks of it, for warning titles. */
const label = (node: ChannelNode): string =>
  node.type === 'port'
    ? `${node.portType} port`
    : node.type === 'chamber'
      ? `${node.shape} chamber`
      : 'Channel node';

/**
 * Channel narrower than the printer can resolve.
 *
 * Checked against the *minimum* width along each edge rather than an average:
 * a channel that tapers to 0.05 mm at one end fails there, however generous the
 * rest of it is.
 */
export function checkMinimumFeature(input: ValidationInput): Warning[] {
  const { graph, chipParams, printerProfile } = input;
  const loft = getLoft(graph, chipParams);

  interface Offender {
    edgeId: string;
    narrowest: number;
    where: Point2 | null;
  }
  const offenders: Offender[] = [];

  for (const edge of graph.edges) {
    const solved = loft.edges.get(edge.id);
    if (!solved || solved.samples.length === 0) continue;

    let narrowest = Infinity;
    let where: Point2 | null = null;
    for (const sample of solved.samples) {
      // For a rectangular channel the height is just as likely to be the
      // limiting dimension as the width.
      const smallest = edge.crossSection === 'round' ? sample.widthMm : Math.min(sample.widthMm, sample.heightMm);
      if (smallest < narrowest) {
        narrowest = smallest;
        where = sample.point;
      }
    }

    if (narrowest < printerProfile.minFeatureSizeMm) {
      offenders.push({ edgeId: edge.id, narrowest, where });
    }
  }

  // Merge segments that are undersized for the same reason.
  //
  // One dimension marker governs a whole chain, so a single 0.05 mm marker
  // makes every segment in that run 0.05 mm — which produced a list of
  // identical-looking warnings that read as a bug. Grouping by the measured
  // width says "3 segments are 0.05 mm" once, and highlights all of them
  // together, which is also what the user needs to fix.
  const groups = new Map<string, Offender[]>();
  for (const offender of offenders) {
    const key = String(mm(offender.narrowest));
    const list = groups.get(key);
    if (list) list.push(offender);
    else groups.set(key, [offender]);
  }

  const warnings: Warning[] = [];
  for (const [key, group] of groups) {
    const narrowest = Math.min(...group.map((o) => o.narrowest));
    const count = group.length;

    warnings.push({
      // Keyed by the width and the sorted edge list, so it stays stable across
      // re-runs but changes when the offending set does.
      id: `min-feature:${key}:${group.map((o) => o.edgeId).sort().join(',')}`,
      kind: 'channel-below-min-feature',
      severity: 'risk',
      title:
        count === 1
          ? `Channel narrows to ${mm(narrowest)} mm`
          : `${count} segments are only ${mm(narrowest)} mm across`,
      detail:
        `${printerProfile.name} resolves about ${printerProfile.minFeatureSizeMm} mm. ` +
        'Below that the channel is likely to cure closed or print inconsistently. ' +
        (count > 1
          ? 'These segments share a dimension marker, so widening it fixes all of them at once. '
          : '') +
        'Widen it, or move to a finer printer profile.',
      measurement: { value: narrowest, limit: printerProfile.minFeatureSizeMm, unit: 'mm' },
      target: {
        nodeIds: [],
        edgeIds: group.map((o) => o.edgeId),
        focus: group.find((o) => o.where)?.where ?? undefined,
      },
    });
  }

  return warnings;
}

/**
 * Clearance from a channel to the chip boundary.
 *
 * Ports are measured on their boss footprint, not their bore — a luer boss is
 * 4.3 mm across where the bore is 1.6 mm, and it is the boss that runs out of
 * material at the edge.
 */
export function checkBoundaryClearance(input: ValidationInput): Warning[] {
  const { graph, chipParams } = input;
  const loft = getLoft(graph, chipParams);
  const warnings: Warning[] = [];

  const footprintOf = (node: ChannelNode): number => nodeFootprintMm(node, chipParams);

  for (const node of graph.nodes) {
    const radius = footprintOf(node) / 2;
    const clearance = Math.min(
      node.x - radius,
      chipParams.width - (node.x + radius),
      node.y - radius,
      chipParams.length - (node.y + radius),
    );

    if (clearance >= chipParams.minEdgeSpacing) continue;

    const outside = clearance < 0;
    warnings.push({
      id: `boundary:${node.id}`,
      kind: 'channel-near-boundary',
      severity: outside ? 'risk' : 'caution',
      title: outside
        ? `${label(node)} sits ${mm(Math.abs(clearance))} mm outside the chip`
        : `${label(node)} is ${mm(clearance)} mm from the chip edge`,
      detail: outside
        ? 'It falls beyond the chip outline, so it will be cut off entirely. Move it inward or enlarge the chip.'
        : `Your minimum edge spacing is ${chipParams.minEdgeSpacing} mm. A thin rim here is fragile and can crack when the part is released.`,
      measurement: { value: clearance, limit: chipParams.minEdgeSpacing, unit: 'mm' },
      target: { nodeIds: [node.id], edgeIds: [], focus: { x: node.x, y: node.y } },
    });
  }

  // Also walk the swept channel itself, not just its nodes — a bowed bezier can
  // stray outside the boundary between two perfectly placed endpoints.
  for (const edge of graph.edges) {
    const solved = loft.edges.get(edge.id);
    if (!solved) continue;

    let worst = Infinity;
    let where: Point2 | null = null;
    for (const sample of solved.samples) {
      const half = sample.widthMm / 2;
      const clearance = Math.min(
        sample.point.x - half,
        chipParams.width - (sample.point.x + half),
        sample.point.y - half,
        chipParams.length - (sample.point.y + half),
      );
      if (clearance < worst) {
        worst = clearance;
        where = sample.point;
      }
    }

    if (worst < chipParams.minEdgeSpacing && where) {
      // Skip when an endpoint already reported it, to avoid two warnings for
      // one physical problem.
      const from = graph.nodes.find((n) => n.id === edge.fromNodeId);
      const to = graph.nodes.find((n) => n.id === edge.toNodeId);
      const nearEndpoint =
        (from && distance(where, { x: from.x, y: from.y }) < 1) ||
        (to && distance(where, { x: to.x, y: to.y }) < 1);
      if (nearEndpoint) continue;

      warnings.push({
        id: `boundary-edge:${edge.id}`,
        kind: 'channel-near-boundary',
        severity: worst < 0 ? 'risk' : 'caution',
        title:
          worst < 0
            ? 'A channel runs outside the chip outline'
            : `A channel passes ${mm(worst)} mm from the chip edge`,
        detail:
          worst < 0
            ? 'Part of this segment falls beyond the chip, so it will be open to the side wall.'
            : `Your minimum edge spacing is ${chipParams.minEdgeSpacing} mm.`,
        measurement: { value: worst, limit: chipParams.minEdgeSpacing, unit: 'mm' },
        target: { nodeIds: [], edgeIds: [edge.id], focus: where },
      });
    }
  }

  return warnings;
}

/**
 * Wall thickness between two channels that do not touch.
 *
 * Sampled centerline-to-centerline, minus both half-widths, so the reported
 * number is the actual material between them. Edges sharing a node are skipped:
 * they are supposed to meet, and measuring them would flag every corner.
 */
export function checkChannelSpacing(input: ValidationInput): Warning[] {
  const { graph, chipParams, settings } = input;
  const loft = getLoft(graph, chipParams);
  const warnings: Warning[] = [];

  const edges = graph.edges;
  const limit = Math.max(chipParams.wallThickness, settings.minPrintableWallMm);

  // Comparing every sample of every pair is O(E²·S²), and this runs while a
  // node is dragged. Each edge's samples get a bounding box plus its widest
  // half-width, which bounds from below how close anything on it can come: a
  // pair whose boxes are already a wall apart is skipped outright, and inside
  // a pair a sample that cannot beat the best gap so far skips the inner loop.
  // Only gaps under `limit` ever produce a warning, so starting the search
  // there changes no result.
  const boxes = new Map<string, { minX: number; minY: number; maxX: number; maxY: number; half: number }>();
  for (const [id, solved] of loft.edges) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, half = 0;
    for (const s of solved.samples) {
      minX = Math.min(minX, s.point.x);
      minY = Math.min(minY, s.point.y);
      maxX = Math.max(maxX, s.point.x);
      maxY = Math.max(maxY, s.point.y);
      half = Math.max(half, s.widthMm / 2);
    }
    boxes.set(id, { minX, minY, maxX, maxY, half });
  }
  const toBox = (p: Point2, box: { minX: number; minY: number; maxX: number; maxY: number }) =>
    Math.hypot(
      Math.max(0, box.minX - p.x, p.x - box.maxX),
      Math.max(0, box.minY - p.y, p.y - box.maxY),
    );

  for (let i = 0; i < edges.length; i += 1) {
    for (let j = i + 1; j < edges.length; j += 1) {
      const a = edges[i];
      const b = edges[j];

      const shareNode =
        a.fromNodeId === b.fromNodeId ||
        a.fromNodeId === b.toNodeId ||
        a.toNodeId === b.fromNodeId ||
        a.toNodeId === b.toNodeId;
      if (shareNode) continue;

      const sa = loft.edges.get(a.id);
      const sb = loft.edges.get(b.id);
      const boxA = boxes.get(a.id);
      const boxB = boxes.get(b.id);
      if (!sa || !sb || !boxA || !boxB) continue;

      const boxGap =
        Math.hypot(
          Math.max(0, boxA.minX - boxB.maxX, boxB.minX - boxA.maxX),
          Math.max(0, boxA.minY - boxB.maxY, boxB.minY - boxA.maxY),
        ) -
        boxA.half -
        boxB.half;
      if (boxGap >= limit) continue;

      let worstGap = limit;
      let where: Point2 | null = null;

      for (const pa of sa.samples) {
        if (toBox(pa.point, boxB) - pa.widthMm / 2 - boxB.half >= worstGap) continue;
        for (const pb of sb.samples) {
          const gap = distance(pa.point, pb.point) - pa.widthMm / 2 - pb.widthMm / 2;
          if (gap < worstGap) {
            worstGap = gap;
            where = midpoint(pa.point, pb.point);
          }
        }
      }

      if (worstGap >= limit || !where) continue;

      // A negative gap means the two channels have merged into one cavity —
      // a different problem from a thin wall, and worth saying so plainly.
      const overlapping = worstGap < 0;

      warnings.push({
        id: `spacing:${a.id}:${b.id}`,
        kind: overlapping ? 'channels-overlap' : 'channels-too-close',
        severity: overlapping ? 'risk' : 'caution',
        title: overlapping
          ? 'Two channels overlap'
          : `Only ${mm(worstGap)} mm of wall between two channels`,
        detail: overlapping
          ? 'These segments intersect, so they will print as one merged cavity rather than two separate channels. If they are meant to join, connect them at a node instead.'
          : `Thin walls between channels cure through and merge the two. Your wall thickness is ${chipParams.wallThickness} mm and ${settings.minPrintableWallMm} mm is about the practical floor for resin.`,
        measurement: { value: worstGap, limit, unit: 'mm' },
        target: { nodeIds: [], edgeIds: [a.id, b.id], focus: where },
      });
    }
  }

  return warnings;
}

/** Chip, or either split piece, larger than the printer's build volume. */
export function checkBuildVolume(input: ValidationInput): Warning[] {
  const { chipParams, printerProfile } = input;
  const build = printerProfile.buildVolumeMm;
  const warnings: Warning[] = [];

  // A rectangular part can be rotated 90° on the plate, so it fits if either
  // orientation does. Reporting an overflow the user could solve by turning the
  // part would be a false alarm.
  const footprintFits =
    (chipParams.width <= build.x && chipParams.length <= build.y) ||
    (chipParams.length <= build.x && chipParams.width <= build.y);

  if (!footprintFits) {
    warnings.push({
      id: 'build-volume:footprint',
      kind: 'footprint-exceeds-build-volume',
      severity: 'risk',
      title: `Chip footprint is larger than the build plate`,
      detail:
        `The chip is ${chipParams.width} × ${chipParams.length} mm and ${printerProfile.name} ` +
        `has a ${build.x} × ${build.y} mm plate, in either orientation. Shrink the chip, split it, or pick a larger printer.`,
      measurement: { value: Math.max(chipParams.width, chipParams.length), limit: Math.max(build.x, build.y), unit: 'mm' },
      target: { nodeIds: [], edgeIds: [] },
    });
  }

  // Height: a two-piece chip prints as two shorter pieces, so the tallest
  // single piece is what has to fit.
  const tallestPiece =
    chipParams.splitType === 'two-piece'
      ? Math.max(chipParams.splitHeight, chipParams.baseThickness - chipParams.splitHeight)
      : chipParams.baseThickness;

  if (tallestPiece > build.z) {
    warnings.push({
      id: 'build-volume:height',
      kind: 'footprint-exceeds-build-volume',
      severity: 'risk',
      title: 'Chip is taller than the printer can build',
      detail: `The tallest piece is ${mm(tallestPiece)} mm and the machine tops out at ${build.z} mm.`,
      measurement: { value: tallestPiece, limit: build.z, unit: 'mm' },
      target: { nodeIds: [], edgeIds: [] },
    });
  }

  return warnings;
}

/**
 * Overhangs on port features.
 *
 * The 6% Luer taper is barely off vertical and never trips this; the check
 * earns its place on custom ports, where a wide socket over a shallow depth
 * produces a genuinely unsupported roof.
 *
 * Luer-lock threads are called out separately: a helical rib is unsupported on
 * its underside no matter how the cone angle works out.
 */
export function checkPortOverhangs(input: ValidationInput): Warning[] {
  const { graph, settings } = input;
  const warnings: Warning[] = [];


  for (const node of graph.nodes) {
    if (node.type !== 'port') continue;

    let wideDiameter: number | null = null;
    let narrowDiameter: number | null = null;
    let depth: number | null = null;

    if (node.portType === 'luer' || node.portType === 'luer-lock') {
      wideDiameter = specNumber(node.customSpec, 'taperLargeDiameterMm', LUER_TAPER.taperLargeDiameterMm);
      narrowDiameter = specNumber(node.customSpec, 'taperSmallDiameterMm', LUER_TAPER.taperSmallDiameterMm);
      depth = specNumber(node.customSpec, 'taperLengthMm', LUER_TAPER.taperLengthMm);
    } else if (node.portType === 'custom') {
      wideDiameter = specNumber(node.customSpec, 'outerDiameterMm', 4);
      narrowDiameter = node.diameterMm;
      depth = specNumber(node.customSpec, 'depthMm', 5);
    }

    if (wideDiameter !== null && narrowDiameter !== null && depth !== null && depth > 0) {
      // Angle of the socket wall away from vertical.
      const angle = (Math.atan(Math.abs(wideDiameter - narrowDiameter) / 2 / depth) * 180) / Math.PI;
      if (angle > settings.overhangLimitDeg) {
        warnings.push({
          id: `overhang:${node.id}`,
          kind: 'port-overhang',
          severity: 'caution',
          title: `Port socket flares at ${Math.round(angle)}° from vertical`,
          detail:
            `Past about ${settings.overhangLimitDeg}° the roof of the socket is unsupported and will sag or need supports. ` +
            'Deepen the socket or reduce the diameter change.',
          measurement: { value: angle, limit: settings.overhangLimitDeg, unit: '°' },
          target: { nodeIds: [node.id], edgeIds: [], focus: { x: node.x, y: node.y } },
        });
      }
    }

    // Male fittings are the one thing on the chip that is not braced by the
    // block around it. What breaks is the annulus between the bore and the
    // outside, measured where it is thinnest — the tip of a cone, the stem of
    // a barb.
    if (node.portType === 'luer-male' || node.portType === 'barb') {
      const narrowest =
        node.portType === 'luer-male'
          ? specNumber(node.customSpec, 'taperSmallDiameterMm', LUER_TAPER.taperSmallDiameterMm)
          : specNumber(node.customSpec, 'stemDiameterMm', 2.9);
      const wall = (narrowest - node.diameterMm) / 2;
      const height =
        specNumber(node.customSpec, 'bossHeightMm', 0) +
        (node.portType === 'luer-male'
          ? specNumber(node.customSpec, 'taperLengthMm', LUER_TAPER.taperLengthMm)
          : specNumber(node.customSpec, 'barbLengthMm', 10.5));

      if (wall < settings.minPrintableWallMm * 2) {
        const tooThin = wall < settings.minPrintableWallMm;
        warnings.push({
          id: `protrusion:${node.id}`,
          kind: 'port-protrusion',
          severity: tooThin ? 'risk' : 'caution',
          title: tooThin
            ? `Fitting wall is ${wall.toFixed(2)} mm at its thinnest`
            : `Fitting wall is thin at ${wall.toFixed(2)} mm`,
          detail:
            `This fitting stands ${height.toFixed(1)} mm off the chip with a ${node.diameterMm.toFixed(2)} mm bore up ` +
            `the middle, leaving ${wall.toFixed(2)} mm of wall where it is narrowest against a ` +
            `${settings.minPrintableWallMm} mm minimum feature. ` +
            (tooThin
              ? 'At that thickness it will likely tear off the plate or split along a layer line. '
              : 'It will probably print, but it is the first thing on the chip to snap. ') +
            'Narrow the bore or widen the fitting to gain wall.',
          measurement: { value: wall, limit: settings.minPrintableWallMm, unit: 'mm' },
          target: { nodeIds: [node.id], edgeIds: [], focus: { x: node.x, y: node.y } },
        });
      }
    }

    if (node.portType === 'luer-lock') {
      warnings.push({
        id: `thread:${node.id}`,
        kind: 'thread-support',
        severity: 'info',
        title: 'Luer-lock thread may need orientation care',
        detail:
          'The thread is a helical rib, so its underside is unsupported at every turn. Print the chip flat rather than tilted, ' +
          'and expect to test-fit — the thread is a single-start approximation of the ISO form, not the certified profile.',
        target: { nodeIds: [node.id], edgeIds: [], focus: { x: node.x, y: node.y } },
      });
    }
  }

  return warnings;
}
