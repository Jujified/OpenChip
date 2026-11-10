/**
 * Geometry for the compensated-design preview.
 *
 * The preview draws what `compensateDesign` returned and nothing else: this
 * module takes the nominal design and that result, and turns both into
 * outlines and cross-sections with the same loft solver, placement and profile
 * functions the STL is built from. There is no second idea here of what a
 * compensated channel looks like, so the picture and the exported file cannot
 * drift apart — and `preview.test.ts` slices the built mesh to hold it to that.
 *
 * Pure, and read-only by construction: it has no access to a store.
 */

import { ceilingZ, placeChannel, profilePoints } from '../cad/placement';
import { withChannelPlane } from '../cad/slide';
import { buildAdjacency, edgesFrom } from '../geometry';
import { getLoft, sampleAtNode, type LoftSample, type LoftSolution } from '../loft';
import type { ChannelGraph, ChipParams, CrossSection, Point2 } from '../../types/project';
import type { CompensatedDesign, DfmConflictKind, NominalDesign } from './compensate';

// ---------------------------------------------------------------------------
// top view
// ---------------------------------------------------------------------------

export interface PreviewEdge {
  id: string;
  /** Channel outline as drawn, a closed polygon in chip mm. */
  nominal: Point2[];
  /** Channel outline after compensation. */
  compensated: Point2[];
  /** True when compensation moved this channel's walls. */
  changed: boolean;
  /** True when a conflict names this segment. */
  conflict: boolean;
}

export interface PreviewCircle {
  id: string;
  kind: 'joint' | 'chamber' | 'vent' | 'port';
  x: number;
  y: number;
  nominalRadiusMm: number;
  compensatedRadiusMm: number;
  changed: boolean;
  conflict: boolean;
}

export interface DfmPreviewModel {
  chip: { width: number; length: number; baseThickness: number };
  edges: PreviewEdge[];
  circles: PreviewCircle[];
  /** Where each conflict is, for a marker. */
  conflictMarks: { id: string; kind: DfmConflictKind; x: number; y: number }[];
}

const EPS = 1e-9;

function outline(samples: LoftSample[]): Point2[] {
  const left: Point2[] = [];
  const right: Point2[] = [];
  for (const sample of samples) {
    const half = sample.widthMm / 2;
    // The channel's width is laid off along the normal to its path.
    const nx = -sample.tangent.y;
    const ny = sample.tangent.x;
    left.push({ x: sample.point.x + nx * half, y: sample.point.y + ny * half });
    right.push({ x: sample.point.x - nx * half, y: sample.point.y - ny * half });
  }
  return [...left, ...right.reverse()];
}

function jointRadii(graph: ChannelGraph, loft: LoftSolution): Map<string, number> {
  const adjacency = buildAdjacency(graph.edges);
  const radii = new Map<string, number>();
  for (const node of graph.nodes) {
    const touching = edgesFrom(adjacency, node.id);
    if (touching.length < 2 || node.type === 'chamber') continue;
    const sample = sampleAtNode(loft, touching[0], node.id);
    if (sample) radii.set(node.id, sample.widthMm / 2);
  }
  return radii;
}

export function buildDfmPreview(
  nominal: NominalDesign,
  compensated: CompensatedDesign,
): DfmPreviewModel {
  const before = getLoft(nominal.graph, withChannelPlane(nominal.chipParams));
  const after = getLoft(compensated.graph, withChannelPlane(compensated.chipParams));

  const conflictEdges = new Set(compensated.conflicts.flatMap((c) => c.edgeIds));
  const conflictNodes = new Set(compensated.conflicts.flatMap((c) => c.nodeIds));
  // A ceiling raise changes every channel even where no wall moved.
  const raised = compensated.ceilingRaiseMm > 0;

  const edges: PreviewEdge[] = [];
  for (const edge of nominal.graph.edges) {
    const a = before.edges.get(edge.id)?.samples;
    const b = after.edges.get(edge.id)?.samples;
    if (!a || !b || a.length < 2) continue;
    const widened = a.some((sample, i) => Math.abs((b[i]?.widthMm ?? sample.widthMm) - sample.widthMm) > EPS);
    edges.push({
      id: edge.id,
      nominal: outline(a),
      compensated: outline(b),
      changed: widened || raised,
      conflict: conflictEdges.has(edge.id),
    });
  }

  const circles: PreviewCircle[] = [];
  const jointsBefore = jointRadii(nominal.graph, before);
  const jointsAfter = jointRadii(compensated.graph, after);
  const nodesAfter = new Map(compensated.graph.nodes.map((n) => [n.id, n]));

  for (const node of nominal.graph.nodes) {
    const joint = jointsBefore.get(node.id);
    if (joint !== undefined) {
      const next = jointsAfter.get(node.id) ?? joint;
      circles.push({
        id: `joint:${node.id}`,
        kind: 'joint',
        x: node.x,
        y: node.y,
        nominalRadiusMm: joint,
        compensatedRadiusMm: next,
        changed: Math.abs(next - joint) > EPS || raised,
        conflict: false,
      });
    }

    if (node.type === 'chamber') {
      const next = nodesAfter.get(node.id);
      const size = next?.type === 'chamber' ? next.sizeMm : node.sizeMm;
      circles.push({
        id: `chamber:${node.id}`,
        kind: 'chamber',
        x: node.x,
        y: node.y,
        nominalRadiusMm: node.sizeMm / 2,
        compensatedRadiusMm: size / 2,
        changed: Math.abs(size - node.sizeMm) > EPS || raised,
        conflict: conflictNodes.has(node.id),
      });
    } else if (node.type === 'port') {
      // Ports are not compensated; they are drawn so the picture is the chip.
      circles.push({
        id: `port:${node.id}`,
        kind: 'port',
        x: node.x,
        y: node.y,
        nominalRadiusMm: node.diameterMm / 2,
        compensatedRadiusMm: node.diameterMm / 2,
        changed: false,
        conflict: false,
      });
    }
  }

  const ventsAfter = new Map(compensated.drainageVents.map((v) => [v.id, v]));
  const nodesBefore = new Map(nominal.graph.nodes.map((n) => [n.id, n]));
  for (const vent of nominal.drainageVents) {
    const node = nodesBefore.get(vent.nodeId);
    if (!node) continue;
    const next = ventsAfter.get(vent.id)?.diameterMm ?? vent.diameterMm;
    circles.push({
      id: `vent:${vent.id}`,
      kind: 'vent',
      x: node.x,
      y: node.y,
      nominalRadiusMm: vent.diameterMm / 2,
      compensatedRadiusMm: next / 2,
      changed: Math.abs(next - vent.diameterMm) > EPS,
      conflict: false,
    });
  }

  return {
    chip: {
      width: nominal.chipParams.width,
      length: nominal.chipParams.length,
      baseThickness: nominal.chipParams.baseThickness,
    },
    edges,
    circles,
    conflictMarks: compensated.conflicts
      .filter((c) => c.focus)
      .map((c) => ({ id: c.id, kind: c.kind, x: c.focus!.x, y: c.focus!.y })),
  };
}

// ---------------------------------------------------------------------------
// cross-sections
// ---------------------------------------------------------------------------

/** One channel profile in the slice plane: `s` along the slice line, `z` up. */
export interface SectionShape {
  widthMm: number;
  heightMm: number;
  floorZ: number;
  ceilingZ: number;
  /** Closed polygon. */
  points: { s: number; z: number }[];
}

export interface DfmSection {
  edgeId: string;
  crossSection: CrossSection;
  /** Where the slice line meets this channel's centreline, mm along the line. */
  alongMm: number;
  /**
   * How much the channel's width is stretched in this view because the slice
   * crosses it at an angle. 1 for a square cut. The `widthMm` of each shape is
   * the true width; only `points` carry the stretch.
   */
  obliqueStretch: number;
  nominal: SectionShape;
  compensated: SectionShape;
  conflict: boolean;
}

/** `x` slices along the plane x = position; `y` along y = position. */
export type SliceAxis = 'x' | 'y';

const SECTION_SEGMENTS = 32;
/** A slice nearly parallel to a channel would stretch it without limit. */
const MAX_OBLIQUE_STRETCH = 5;

function shape(
  crossSection: CrossSection,
  widthMm: number,
  heightMm: number,
  chipParams: ChipParams,
  ceilingRaiseMm: number,
  alongMm: number,
  stretch: number,
): SectionShape {
  const place = placeChannel(crossSection, widthMm, heightMm, chipParams.splitHeight, ceilingRaiseMm);
  const profile = profilePoints(crossSection, widthMm, heightMm, SECTION_SEGMENTS, ceilingRaiseMm);
  return {
    widthMm,
    heightMm: place.halfHeight * 2 + place.ceilingRaiseMm,
    floorZ: place.centerZ - place.halfHeight,
    ceilingZ: ceilingZ(place),
    points: profile.map((p) => ({ s: alongMm + p.u * stretch, z: place.centerZ + p.v })),
  };
}

/**
 * Every channel the slice line crosses, as drawn and as compensated.
 *
 * Crossings are found on the nominal centreline — compensation never moves a
 * centreline — and the compensated size is read from the same station of the
 * compensated loft.
 */
export function sliceSections(
  nominal: NominalDesign,
  compensated: CompensatedDesign,
  axis: SliceAxis,
  positionMm: number,
): DfmSection[] {
  const chipBefore = withChannelPlane(nominal.chipParams);
  const chipAfter = withChannelPlane(compensated.chipParams);
  const before = getLoft(nominal.graph, chipBefore);
  const after = getLoft(compensated.graph, chipAfter);
  const conflictEdges = new Set(compensated.conflicts.flatMap((c) => c.edgeIds));

  const across = (p: Point2) => (axis === 'x' ? p.x : p.y);
  const along = (p: Point2) => (axis === 'x' ? p.y : p.x);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

  const sections: DfmSection[] = [];

  for (const edge of nominal.graph.edges) {
    const a = before.edges.get(edge.id)?.samples;
    const b = after.edges.get(edge.id)?.samples;
    if (!a || !b || a.length !== b.length) continue;

    for (let i = 0; i < a.length - 1; i += 1) {
      const d0 = across(a[i].point) - positionMm;
      const d1 = across(a[i + 1].point) - positionMm;
      // Half-open, so a crossing exactly on a station is counted once.
      if (!((d0 <= 0 && d1 > 0) || (d0 >= 0 && d1 < 0))) continue;

      const t = d0 / (d0 - d1);
      const alongMm = lerp(along(a[i].point), along(a[i + 1].point), t);
      const tangent = {
        x: lerp(a[i].tangent.x, a[i + 1].tangent.x, t),
        y: lerp(a[i].tangent.y, a[i + 1].tangent.y, t),
      };
      const length = Math.hypot(tangent.x, tangent.y) || 1;
      // Component of the path direction through the slice plane.
      const through = Math.abs(axis === 'x' ? tangent.x : tangent.y) / length;
      const obliqueStretch = Math.min(MAX_OBLIQUE_STRETCH, 1 / Math.max(through, 1e-6));

      sections.push({
        edgeId: edge.id,
        crossSection: edge.crossSection,
        alongMm,
        obliqueStretch,
        nominal: shape(
          edge.crossSection,
          lerp(a[i].widthMm, a[i + 1].widthMm, t),
          lerp(a[i].heightMm, a[i + 1].heightMm, t),
          chipBefore,
          0,
          alongMm,
          obliqueStretch,
        ),
        compensated: shape(
          edge.crossSection,
          lerp(b[i].widthMm, b[i + 1].widthMm, t),
          lerp(b[i].heightMm, b[i + 1].heightMm, t),
          chipAfter,
          compensated.ceilingRaiseMm,
          alongMm,
          obliqueStretch,
        ),
        conflict: conflictEdges.has(edge.id),
      });
    }
  }

  return sections.sort((p, q) => p.alongMm - q.alongMm);
}
