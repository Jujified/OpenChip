/**
 * Where a channel sits in Z, and how its cross-section is shaped.
 *
 * This is the single most consequential decision in the CAD pipeline, because
 * it determines whether a two-piece chip can actually be printed and bonded.
 *
 * **Rect and trapezoid** sit entirely *below* the split plane with their
 * ceiling exactly on it. Cutting there leaves an open-topped groove in the
 * lower piece and a genuinely flat lid — which is what the two-piece design is
 * for.
 *
 * **Round is the exception, and it has to be.** A circle tangent to the cut
 * plane would leave a nearly-closed tunnel with a re-entrant lip: unprintable
 * as an open groove and impossible to clear of resin. So round channels are
 * centered *on* the split plane, giving a clean semicircular groove in each
 * half. The lid is no longer flat, and the UI says so.
 *
 * **Trapezoids are drafted wide-side-up.** A groove that narrows towards its
 * opening traps resin and fights release; widening it towards the open face is
 * the printable orientation.
 */

import type { CrossSection } from '../../types/project';

/** Bottom width as a fraction of top width for a trapezoidal channel. */
export const TRAPEZOID_DRAFT = 0.7;

export interface ChannelPlacement {
  /** Z of the cross-section's center, mm. */
  centerZ: number;
  /** Half the vertical extent, mm. */
  halfHeight: number;
  /** True when the section straddles the split plane rather than hanging below it. */
  straddlesSplit: boolean;
}

/**
 * `widthMm` and `heightMm` are the local values from the loft solution.
 * `heightMm` is ignored for `round`, where the diameter is the width.
 */
export function placeChannel(
  crossSection: CrossSection,
  widthMm: number,
  heightMm: number,
  splitHeight: number,
): ChannelPlacement {
  if (crossSection === 'round') {
    return { centerZ: splitHeight, halfHeight: widthMm / 2, straddlesSplit: true };
  }
  return {
    centerZ: splitHeight - heightMm / 2,
    halfHeight: heightMm / 2,
    straddlesSplit: false,
  };
}

/**
 * The 2D profile of a channel, in (across, up) coordinates relative to the
 * centerline. Swept along the path to make the solid.
 *
 * Points run counter-clockwise in the (across, up) plane, which the sweep
 * relies on to get triangle winding right.
 */
export function profilePoints(
  crossSection: CrossSection,
  widthMm: number,
  heightMm: number,
  radialSegments: number,
): { u: number; v: number }[] {
  if (crossSection === 'round') {
    const r = widthMm / 2;
    const points: { u: number; v: number }[] = [];
    for (let i = 0; i < radialSegments; i += 1) {
      const theta = (i / radialSegments) * Math.PI * 2;
      points.push({ u: Math.cos(theta) * r, v: Math.sin(theta) * r });
    }
    return points;
  }

  const halfH = heightMm / 2;
  const halfTop = widthMm / 2;
  const halfBottom = crossSection === 'trapezoid' ? (widthMm * TRAPEZOID_DRAFT) / 2 : halfTop;

  // CCW: bottom-right → top-right → top-left → bottom-left.
  return [
    { u: halfBottom, v: -halfH },
    { u: halfTop, v: halfH },
    { u: -halfTop, v: halfH },
    { u: -halfBottom, v: -halfH },
  ];
}

/**
 * Ring resolution for a channel.
 *
 * An inscribed n-gon under-reports a circle's area by ~2% at 12 segments and
 * ~0.6% at 32. Preview quality stays coarse for responsiveness; export quality
 * doubles it, because that error lands in the printed part.
 */
export const radialSegmentsFor = (crossSection: CrossSection, quality: number): number =>
  crossSection === 'round' ? Math.max(12, Math.round(16 * quality)) : 4;
