/**
 * The OpenChip mark's geometry, as ratios of a size×size square, so every
 * consumer — the fixed-size, fixed-colour favicon and the `currentColor`
 * wordmarks in the app, the landing page, and the wiki — draws the same
 * shape at its own size instead of a hand-eyeballed copy.
 *
 * Not imported by any app, landing, or wiki runtime code: the app's `tsc -b`
 * project only includes `src/`, and Vercel's Root Directory builds for
 * `landing/` and `wiki/` cannot see above their own folder (see
 * `scripts/sync-brand.mjs`'s header for why `brand/tokens.css` is copied
 * rather than imported there). So this module is consumed by tooling only —
 * the scripts and tests that generate and verify the literal markup baked
 * into each consumer — the same way `brand/tokens.css` is copied into
 * `landing/` and `wiki/` rather than imported across the Vercel root
 * boundary.
 *
 * Derived from the original favicon path (viewBox 0 0 32 32):
 *   M9 21.5c0-6 4-6 7-6s7 0 7-6
 * which is two cubic Béziers, both leaving their port with a vertical
 * tangent and levelling out to a horizontal tangent at the midpoint:
 *   M(9,21.5) C(9,15.5)(13,15.5)(16,15.5) C(19,15.5)(23,15.5)(23,9.5)
 */

const SIZE = 32;

/** Corner radius of the outer rounded square, as a ratio of its side. */
export const CORNER_RADIUS_RATIO = 7 / SIZE;

/** Radius of each port dot, as a ratio of the square's side. */
export const DOT_RADIUS_RATIO = 2.6 / SIZE;

/** The channel's two ports and its midpoint, as ratios of the square's side. */
export const PORT_A_RATIO = Object.freeze({ x: 9 / SIZE, y: 21.5 / SIZE });
export const MID_RATIO = Object.freeze({ x: 16 / SIZE, y: 15.5 / SIZE });
export const PORT_B_RATIO = Object.freeze({ x: 23 / SIZE, y: 9.5 / SIZE });

/**
 * Where the first curve's second control point sits along the A→mid run.
 * From the original path's `c0-6 4-6 7-6`: control2 is 4 of the way along a
 * 7-wide run, i.e. 4/7.
 */
const CONTROL_SPLIT = 4 / 7;

/** Rounds to a handful of decimal places so generated markup has no float noise. */
function r(n) {
  return Math.round(n * 1e6) / 1e6;
}

function scale(point, size) {
  return { x: r(point.x * size), y: r(point.y * size) };
}

export function portA(size) {
  return scale(PORT_A_RATIO, size);
}

export function portB(size) {
  return scale(PORT_B_RATIO, size);
}

export function midpoint(size) {
  return scale(MID_RATIO, size);
}

export function dotRadius(size) {
  return r(DOT_RADIUS_RATIO * size);
}

export function cornerRadius(size) {
  return r(CORNER_RADIUS_RATIO * size);
}

/**
 * The channel path at a given size, as an absolute SVG path string —
 * port A, curving up to the midpoint, curving on to port B.
 */
export function channelPath(size) {
  const a = portA(size);
  const m = midpoint(size);
  const b = portB(size);

  const c1 = { x: a.x, y: m.y };
  const c2 = { x: r(a.x + CONTROL_SPLIT * (m.x - a.x)), y: m.y };
  const c3 = { x: r(m.x + (1 - CONTROL_SPLIT) * (m.x - a.x)), y: m.y };
  const c4 = { x: b.x, y: m.y };

  return `M${a.x} ${a.y}C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${m.x} ${m.y}C${c3.x} ${c3.y} ${c4.x} ${c4.y} ${b.x} ${b.y}`;
}

/**
 * The favicon's markup at a given size and colour pair — the mark's
 * canonical, fixed-colour rendering. `landing/public/favicon.svg` and
 * `wiki/public/favicon.svg` are byte-identical copies of `brand/mark.svg`,
 * which is this function's output at `size: 32`.
 */
export function faviconSvg(size, { background, foreground }) {
  const radius = cornerRadius(size);
  const dot = dotRadius(size);
  const a = portA(size);
  const b = portB(size);
  const strokeWidth = dot;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${radius}" fill="${background}" />
  <path
    d="${channelPath(size)}"
    fill="none"
    stroke="${foreground}"
    stroke-width="${strokeWidth}"
    stroke-linecap="round"
  />
  <circle cx="${a.x}" cy="${a.y}" r="${dot}" fill="${foreground}" />
  <circle cx="${b.x}" cy="${b.y}" r="${dot}" fill="${foreground}" />
</svg>\n`;
}
