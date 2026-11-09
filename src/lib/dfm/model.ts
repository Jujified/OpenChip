/**
 * The compensation model: how far a printed edge lands from where it was drawn.
 *
 * ## Where the shape comes from
 *
 * Resin cures where the absorbed dose exceeds a critical exposure. Jacobs'
 * working curve gives the depth that reaches it,
 *
 *     C_d = D_p · ln(E / E_c)
 *
 * which is Beer–Lambert attenuation solved for the depth at which the dose has
 * fallen to E_c. Two consequences shape everything here.
 *
 * **Vertically**, light meant for the layers above a channel carries on into
 * the uncured resin inside it and cures the ceiling downwards. The depth
 * depends on dose and penetration depth, not on how wide the channel is, so it
 * is modelled as one number: `deltaZMm`.
 *
 * **Laterally**, stray light past a mask edge is taken to fall off the same
 * way, exponentially with distance, with a decay length λ. One isolated edge
 * then cures a fixed distance Δ past where it was drawn. A channel is two
 * edges facing each other, and the stray doses from both add in the gap:
 *
 *     dose(x) ∝ e^(−x/λ) + e^(−(W−x)/λ)      0 ≤ x ≤ W
 *
 * The wall advances to wherever that sum equals the threshold e^(−Δ/λ). For a
 * wide channel the far wall contributes nothing and each side moves in by Δ.
 * As the channel narrows the tails overlap, each wall moves further, and at
 * W = 2Δ + 2λ·ln 2 the two meet and the channel is closed — which is the
 * observed behaviour that narrow channels close disproportionately.
 *
 * ## What is and is not claimed
 *
 * - This is an **empirical** two-parameter curve with a physically motivated
 *   shape. Δ and λ are fitted to coupon measurements directly. D_p and E_c are
 *   not recovered: a coupon printed at one exposure cannot separate them, since
 *   only the product in the logarithm is observable.
 * - Real stray light is not purely exponential (pixel blur, scattering in the
 *   vat film, resin bleed all contribute). λ absorbs whatever makes narrow
 *   channels worse, whatever its cause.
 * - λ = 0 reduces the model to a constant offset per side. That is what a fit
 *   from open/closed observations alone uses, because one closure width cannot
 *   separate Δ from λ.
 * - Offsets are assumed isotropic in XY and uniform across the build plate.
 */

export interface LateralModel {
  /** Bleed per side on an isolated edge, mm. */
  deltaXyMm: number;
  /** Decay length of the stray dose, mm. Zero for a constant offset. */
  lateralDecayMm: number;
}

/** Drawn width at or below which the model predicts a channel cures shut, mm. */
export function closureWidthMm(model: LateralModel): number {
  return 2 * model.deltaXyMm + 2 * Math.max(0, model.lateralDecayMm) * Math.LN2;
}

/**
 * How far each wall of a channel drawn `drawnWidthMm` wide moves inward, mm.
 *
 * Returns half the drawn width when the channel closes, so that
 * `drawn − 2·bleed` is zero rather than negative.
 */
export function bleedPerSideMm(drawnWidthMm: number, model: LateralModel): number {
  const delta = model.deltaXyMm;
  const lambda = model.lateralDecayMm;
  if (drawnWidthMm <= 0) return 0;
  if (!(lambda > 0)) return Math.min(delta, drawnWidthMm / 2);

  // With y = e^(x/λ), c = e^(−Δ/λ) and q = e^(−W/λ), the threshold condition
  // 1/y + q·y = c is the quadratic q·y² − c·y + 1 = 0. The smaller root is the
  // wall nearer x = 0. Written as 2/(c + √disc) rather than (c − √disc)/2q:
  // for a wide channel q underflows towards zero and the second form divides
  // one vanishing number by another.
  const c = Math.exp(-delta / lambda);
  const q = Math.exp(-drawnWidthMm / lambda);
  const disc = c * c - 4 * q;
  if (disc <= 0) return drawnWidthMm / 2;

  const y = 2 / (c + Math.sqrt(disc));
  return Math.min(lambda * Math.log(y), drawnWidthMm / 2);
}

/** Width a channel drawn `drawnWidthMm` wide is predicted to print at, mm. */
export function printedWidthMm(drawnWidthMm: number, model: LateralModel): number {
  return Math.max(0, drawnWidthMm - 2 * bleedPerSideMm(drawnWidthMm, model));
}

/**
 * Width to draw so the channel prints `targetWidthMm` wide — the inverse of
 * `printedWidthMm`.
 *
 * Printed width rises monotonically with drawn width, and the answer lies
 * between `target + 2Δ` (no overlap of the tails) and `target + closure width`
 * (the most either wall can ever move), so bisection always converges.
 */
export function drawnWidthForMm(targetWidthMm: number, model: LateralModel): number {
  if (targetWidthMm <= 0) return targetWidthMm;
  if (!(model.lateralDecayMm > 0)) return targetWidthMm + 2 * model.deltaXyMm;

  let lo = targetWidthMm + 2 * model.deltaXyMm;
  let hi = targetWidthMm + closureWidthMm(model);
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (printedWidthMm(mid, model) < targetWidthMm) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
