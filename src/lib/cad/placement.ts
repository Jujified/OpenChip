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
  /**
   * How far the ceiling is lifted above `centerZ + halfHeight`, mm. Zero for a
   * nominal build. `centerZ` and `halfHeight` always describe the channel as
   * drawn, so nothing sized from them moves; the roof alone is at
   * `centerZ + halfHeight + ceilingRaiseMm`.
   */
  ceilingRaiseMm: number;
}

/**
 * `widthMm` and `heightMm` are the local values from the loft solution.
 * `heightMm` is ignored for `round`, where the diameter is the width.
 *
 * `ceilingRaiseMm` is print correction for cure-through into a roofed channel:
 * the floor stays where it was drawn and only the ceiling goes up. It is zero
 * everywhere except a compensated export or its preview.
 */
export function placeChannel(
  crossSection: CrossSection,
  widthMm: number,
  heightMm: number,
  splitHeight: number,
  ceilingRaiseMm = 0,
): ChannelPlacement {
  if (crossSection === 'round') {
    return { centerZ: splitHeight, halfHeight: widthMm / 2, straddlesSplit: true, ceilingRaiseMm };
  }
  return {
    centerZ: splitHeight - heightMm / 2,
    halfHeight: heightMm / 2,
    straddlesSplit: false,
    ceilingRaiseMm,
  };
}

/** Z of a placed channel's roof, including any ceiling raise. */
export const ceilingZ = (place: ChannelPlacement): number =>
  place.centerZ + place.halfHeight + place.ceilingRaiseMm;

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
  ceilingRaiseMm = 0,
): { u: number; v: number }[] {
  if (crossSection === 'round') {
    const r = widthMm / 2;
    // A raised round channel keeps its lower semicircle and stretches the
    // upper one into a half-ellipse, so the floor and the widest point stay
    // exactly where they were drawn.
    const stretch = ceilingRaiseMm > 0 && r > 0 ? (r + ceilingRaiseMm) / r : 1;
    const points: { u: number; v: number }[] = [];
    for (let i = 0; i < radialSegments; i += 1) {
      const theta = (i / radialSegments) * Math.PI * 2;
      const v = Math.sin(theta) * r;
      points.push({ u: Math.cos(theta) * r, v: v > 0 ? v * stretch : v });
    }
    return points;
  }

  const halfH = heightMm / 2;
  const halfTop = widthMm / 2;
  const halfBottom = crossSection === 'trapezoid' ? (widthMm * TRAPEZOID_DRAFT) / 2 : halfTop;

  // CCW: bottom-right → top-right → top-left → bottom-left.
  const top = halfH + Math.max(0, ceilingRaiseMm);
  return [
    { u: halfBottom, v: -halfH },
    { u: halfTop, v: top },
    { u: -halfTop, v: top },
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
