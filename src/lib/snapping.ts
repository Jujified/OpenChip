/**
 * Snap resolution for the drawing canvas.
 *
 * Three kinds, in priority order: endpoints beat angle, angle beats grid. An
 * endpoint snap is the only one that changes graph *topology* (it welds two
 * paths together), so it must never be overridden by a cosmetic grid pull.
 *
 * Tolerances are supplied in millimetres by the caller, converted from a fixed
 * pixel radius at the current zoom — so the grab feels the same whether the
 * user is zoomed way out or inspecting a 200 µm feature.
 */

import {
  angleDeg,
  distance,
  fromAngleDeg,
  lengthOf,
  nodePoint,
  snapToStep,
  sub,
} from './geometry';
import type { ChannelNode, Point2 } from '../types/project';

export type SnapKind = 'endpoint' | 'angle' | 'grid' | 'none';

/**
 * Rounds to the nearest nanometre.
 *
 * `cos(90°)` is 6.1e-17 rather than 0, so an angle-snapped vertical lands at
 * x = 6.000000000000001. Invisible on screen and irrelevant to geometry, but it
 * ends up in the saved `.openchip` file and makes hand-inspection unpleasant.
 * A nanometre is ~5 orders of magnitude below anything an mSLA printer can
 * resolve, so this cannot lose real precision.
 */
const tidy = (value: number): number => Math.round(value * 1e6) / 1e6;
const tidyPoint = (p: Point2): Point2 => ({ x: tidy(p.x), y: tidy(p.y) });

export interface SnapResult {
  point: Point2;
  kind: SnapKind;
  /** Set when `kind` is `endpoint` — the node the cursor welded onto. */
  nodeId?: string;
  /** Set when `kind` is `angle` — the locked heading, for the readout. */
  angleDeg?: number;
}

export interface SnapSettings {
  gridEnabled: boolean;
  /** Grid pitch, mm. */
  gridMm: number;
  endpointEnabled: boolean;
  angleEnabled: boolean;
  /** Angle increment, degrees. 15 and 45 are the offered choices. */
  angleStepDeg: number;
}

export const DEFAULT_SNAP_SETTINGS: SnapSettings = {
  gridEnabled: true,
  gridMm: 1,
  endpointEnabled: true,
  angleEnabled: true,
  angleStepDeg: 15,
};

export interface SnapContext {
  /** Candidate nodes to weld onto. Exclude whatever is being dragged. */
  candidates: ChannelNode[];
  /** Ids to ignore even if present in `candidates`. */
  exclude?: Set<string>;
  /** Where the current stroke started — required for angle snapping. */
  origin?: Point2 | null;
  /** Grab radius in mm, derived from zoom. */
  toleranceMm: number;
}

/**
 * Resolves a raw cursor position to a snapped one.
 *
 * Angle snapping constrains the *direction* from `origin` while preserving the
 * cursor's distance, so the user still controls length freely — locking length
 * too would make 15° increments feel like a ratchet.
 */
export function resolveSnap(
  raw: Point2,
  settings: SnapSettings,
  context: SnapContext,
): SnapResult {
  const { candidates, exclude, origin, toleranceMm } = context;

  if (settings.endpointEnabled) {
    let best: { node: ChannelNode; d: number } | null = null;
    for (const node of candidates) {
      if (exclude?.has(node.id)) continue;
      const d = distance(raw, nodePoint(node));
      if (d <= toleranceMm && (!best || d < best.d)) best = { node, d };
    }
    if (best) {
      return { point: nodePoint(best.node), kind: 'endpoint', nodeId: best.node.id };
    }
  }

  if (settings.angleEnabled && origin) {
    const delta = sub(raw, origin);
    const rawLen = lengthOf(delta);
    if (rawLen > 1e-6) {
      const locked = snapToStep(angleDeg(delta), settings.angleStepDeg);

      // Quantise length along the locked ray as well as direction. Without
      // this, drawing a vertical segment yields 9.87 mm rather than 10 mm —
      // the angle is right but the number is unusable, which defeats the point
      // of a millimetre-accurate tool. Snapping length keeps the point exactly
      // on the ray, which grid-snapping the coordinates would not.
      const len =
        settings.gridEnabled && rawLen > settings.gridMm / 2
          ? snapToStep(rawLen, settings.gridMm)
          : rawLen;

      const constrained = fromAngleDeg(locked, len);
      const point = { x: origin.x + constrained.x, y: origin.y + constrained.y };

      // Only claim an angle snap when the cursor is genuinely near the ray;
      // otherwise the pointer visibly detaches from the line it is drawing.
      if (distance(point, raw) <= toleranceMm) {
        return { point: tidyPoint(point), kind: 'angle', angleDeg: locked };
      }
    }
  }

  if (settings.gridEnabled) {
    const point = tidyPoint({
      x: snapToStep(raw.x, settings.gridMm),
      y: snapToStep(raw.y, settings.gridMm),
    });
    return { point, kind: 'grid' };
  }

  return { point: raw, kind: 'none' };
}

/** Screen-constant grab radius: `pixels` at the current zoom, expressed in mm. */
export const toleranceFromZoom = (pixelsPerMm: number, pixels = 10): number =>
  pixels / Math.max(1e-6, pixelsPerMm);

/** Grid pitch that keeps lines readable — coarsens automatically when zoomed out. */
export function adaptiveGridMm(baseMm: number, pixelsPerMm: number, minPixels = 6): number {
  let step = baseMm;
  let guard = 0;
  while (step * pixelsPerMm < minPixels && guard < 12) {
    step *= step < 1 ? 2 : 5;
    guard += 1;
  }
  return step;
}
