/**
 * Type declarations for `mark-geometry.mjs`, so `brand/mark-sync.test.ts`
 * (built under `tsconfig.test.json`, which does not enable `allowJs`) can
 * import the real geometry functions instead of duplicating their formulas.
 */

export interface Point {
  x: number;
  y: number;
}

export const CORNER_RADIUS_RATIO: number;
export const DOT_RADIUS_RATIO: number;
export const PORT_A_RATIO: Readonly<Point>;
export const MID_RATIO: Readonly<Point>;
export const PORT_B_RATIO: Readonly<Point>;

export function portA(size: number): Point;
export function portB(size: number): Point;
export function midpoint(size: number): Point;
export function dotRadius(size: number): number;
export function cornerRadius(size: number): number;
export function channelPath(size: number): string;
export function faviconSvg(
  size: number,
  colors: { background: string; foreground: string },
): string;
