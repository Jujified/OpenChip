/**
 * The glass-slide pocket: where it sits, how deep it goes, and what that does
 * to the channels.
 *
 * A slide chip prints open-faced. The pocket's floor *is* the plane the
 * channels open onto, so a rect channel's ceiling lands exactly on it and the
 * groove is open to the sky — which is what makes the glass a lid rather than
 * a decoration. That coupling is the whole reason this module exists: the CSG
 * builder, the OpenSCAD writer, the design checks and the panel all need the
 * same arithmetic, and three of them getting it right is not enough.
 */

import { DEFAULT_SLIDE } from '../defaults';
import type { ChipParams } from '../../types/project';

/** An axis-aligned rectangle in chip mm, origin at the chip's bottom-left. */
export interface SlideRect {
  x: number;
  y: number;
  width: number;
  length: number;
}

export interface SlidePocket {
  /** The cut in the top of the chip — the slide plus its fit clearance. */
  pocket: SlideRect;
  /** Z of the pocket floor, which is also the plane the channels open onto. */
  floorZ: number;
  /** How far down from the top face the pocket is cut, mm. */
  depthMm: number;
  /** The glass itself, sitting on the bond line. */
  glass: SlideRect & { z: number; thicknessMm: number };
  /** Height of the glass's top face above the chip's, mm. Negative sits sunk. */
  proudMm: number;
}

/**
 * The pocket for a chip, or `null` when this chip is not a slide chip.
 *
 * Returning null rather than a zero-sized pocket keeps every caller honest:
 * there is no such thing as an empty pocket to accidentally subtract.
 */
export function slidePocket(chipParams: ChipParams): SlidePocket | null {
  if (chipParams.splitType !== 'glass-slide') return null;

  // A project built by hand, or one whose draft predates these fields, can
  // reach here without them. The standard slide is a better answer than a
  // thrown error on a chip the user has just switched into this mode.
  const slide = chipParams.slide ?? DEFAULT_SLIDE;
  const width = slide.widthMm + slide.clearanceMm * 2;
  const length = slide.lengthMm + slide.clearanceMm * 2;
  const depthMm = slide.thicknessMm + slide.bondGapMm;
  const floorZ = chipParams.baseThickness - depthMm;

  // Centred on the chip, then offset. Centring on the chip rather than on the
  // channels means the pocket does not wander every time the design is edited.
  const centerX = chipParams.width / 2 + slide.offsetXMm;
  const centerY = chipParams.length / 2 + slide.offsetYMm;

  return {
    pocket: {
      x: centerX - width / 2,
      y: centerY - length / 2,
      width,
      length,
    },
    floorZ,
    depthMm,
    glass: {
      x: centerX - slide.widthMm / 2,
      y: centerY - slide.lengthMm / 2,
      width: slide.widthMm,
      length: slide.lengthMm,
      // The bond gap is under the glass, not over it.
      z: floorZ + slide.bondGapMm,
      thicknessMm: slide.thicknessMm,
    },
    proudMm: floorZ + slide.bondGapMm + slide.thicknessMm - chipParams.baseThickness,
  };
}

/**
 * Z of the plane channels are placed against.
 *
 * `splitHeight` everywhere else; the pocket floor on a slide chip, because a
 * channel that stopped short of the floor would print with a roof over it and
 * the glass would seal a tunnel rather than close a groove.
 */
export function channelPlaneZ(chipParams: ChipParams): number {
  return slidePocket(chipParams)?.floorZ ?? chipParams.splitHeight;
}

/**
 * `chipParams` with `splitHeight` replaced by the plane the channels actually
 * sit on.
 *
 * The sweep, the joints, the chambers and the port bores all read
 * `splitHeight`. Rather than thread a second plane through every one of them —
 * and rely on nobody ever forgetting it — slide mode hands them a chipParams
 * that already says what it means.
 */
export function withChannelPlane(chipParams: ChipParams): ChipParams {
  const plane = channelPlaneZ(chipParams);
  return plane === chipParams.splitHeight ? chipParams : { ...chipParams, splitHeight: plane };
}

/** Does a circle of this radius at (x, y) reach into the pocket footprint? */
export function overlapsPocket(rect: SlideRect, x: number, y: number, radiusMm: number): boolean {
  const nearestX = Math.min(Math.max(x, rect.x), rect.x + rect.width);
  const nearestY = Math.min(Math.max(y, rect.y), rect.y + rect.length);
  return Math.hypot(x - nearestX, y - nearestY) < radiusMm;
}

/** Is a circle of this radius at (x, y) entirely inside the pocket footprint? */
export function insidePocket(rect: SlideRect, x: number, y: number, radiusMm: number): boolean {
  return (
    x - radiusMm >= rect.x &&
    x + radiusMm <= rect.x + rect.width &&
    y - radiusMm >= rect.y &&
    y + radiusMm <= rect.y + rect.length
  );
}
