/**
 * Duct hydraulics.
 *
 * Everything here is in **SI**. The rest of the app works in millimetres and
 * µL/min because that is what a bench scientist writes down; conversion happens
 * at this boundary and nowhere else, because mixing unit systems inside a
 * pressure calculation is how you end up off by 10¹².
 *
 * The pressure drop is Hagen–Poiseuille generalised to non-circular ducts:
 *
 *   ΔP = Po · μ · L · Q / (2 · A · Dh²)
 *
 * where `Po = f·Re` is the Poiseuille number, a pure function of cross-section
 * shape. Using the circular Po of 64 for a rectangular channel under-predicts
 * the pressure drop by up to 50%, which is the difference between a syringe
 * pump coping and stalling — so each shape gets its own.
 */

import type { CrossSection } from '../../types/project';

export const MM_TO_M = 1e-3;
/** µL → m³. Also mm³ → m³, which is the same number and the same idea. */
export const UL_TO_M3 = 1e-9;
/** µL/min → m³/s. Derived from `UL_TO_M3` so the two cannot drift apart. */
export const UL_PER_MIN_TO_M3_S = UL_TO_M3 / 60;

export interface DuctGeometry {
  /** Cross-sectional area, m². */
  areaM2: number;
  /** Hydraulic diameter 4A/P, m. */
  hydraulicDiameterM: number;
  /** Poiseuille number f·Re for this shape. */
  poiseuilleNumber: number;
}

/** Bottom width as a fraction of top width, matching the CAD trapezoid draft. */
const TRAPEZOID_DRAFT = 0.7;

/**
 * Poiseuille number for a rectangular duct, after Shah & London.
 *
 * `aspect` is the ratio of the short side to the long side, 0–1. The polynomial
 * runs from 96 for infinite parallel plates to 56.91 for a square, which are
 * both textbook values and make good regression anchors.
 */
export function rectangularPoiseuille(aspect: number): number {
  const a = Math.min(1, Math.max(0, aspect));
  return (
    96 *
    (1 - 1.3553 * a + 1.9467 * a ** 2 - 1.7012 * a ** 3 + 0.9564 * a ** 4 - 0.2537 * a ** 5)
  );
}

/**
 * Geometry of one channel cross-section.
 *
 * `widthMm` and `heightMm` are the local lofted values. For `round`, width is
 * the diameter and height is ignored — matching how the CAD pipeline builds it.
 */
export function ductGeometry(
  crossSection: CrossSection,
  widthMm: number,
  heightMm: number,
): DuctGeometry {
  const w = Math.max(1e-9, widthMm) * MM_TO_M;
  const h = Math.max(1e-9, heightMm) * MM_TO_M;

  if (crossSection === 'round') {
    const d = w;
    return {
      areaM2: (Math.PI * d * d) / 4,
      hydraulicDiameterM: d,
      // Circular Hagen–Poiseuille.
      poiseuilleNumber: 64,
    };
  }

  if (crossSection === 'trapezoid') {
    const wTop = w;
    const wBottom = w * TRAPEZOID_DRAFT;
    const area = ((wTop + wBottom) / 2) * h;
    const slant = Math.hypot(h, (wTop - wBottom) / 2);
    const perimeter = wTop + wBottom + 2 * slant;
    const meanWidth = (wTop + wBottom) / 2;

    return {
      areaM2: area,
      hydraulicDiameterM: (4 * area) / perimeter,
      // Approximated as a rectangle of the same mean width. A trapezoid's true
      // Po sits within a few percent of that for the shallow drafts used here,
      // and a dedicated correlation would imply a precision this whole estimate
      // does not have.
      poiseuilleNumber: rectangularPoiseuille(
        Math.min(meanWidth, h) / Math.max(meanWidth, h),
      ),
    };
  }

  const area = w * h;
  return {
    areaM2: area,
    hydraulicDiameterM: (2 * w * h) / (w + h),
    poiseuilleNumber: rectangularPoiseuille(Math.min(w, h) / Math.max(w, h)),
  };
}

/**
 * Hydraulic resistance, Pa·s/m³ — the ΔP a unit flow costs.
 *
 * Expressed as a resistance so the network can be solved like a resistor
 * network, which is exactly what a laminar channel network is.
 */
export function hydraulicResistance(
  geometry: DuctGeometry,
  lengthM: number,
  viscosityPaS: number,
): number {
  const { poiseuilleNumber, areaM2, hydraulicDiameterM } = geometry;
  if (areaM2 <= 0 || hydraulicDiameterM <= 0) return Infinity;
  return (
    (poiseuilleNumber * viscosityPaS * lengthM) / (2 * areaM2 * hydraulicDiameterM ** 2)
  );
}

/** ΔP for a given volumetric flow, Pa. */
export const pressureDrop = (resistance: number, flowM3S: number): number =>
  resistance * flowM3S;

/** Mean velocity, m/s. */
export const meanVelocity = (flowM3S: number, areaM2: number): number =>
  areaM2 > 0 ? flowM3S / areaM2 : 0;

/** Reynolds number, ρ·v·Dh/μ. */
export function reynolds(
  densityKgM3: number,
  velocityMS: number,
  hydraulicDiameterM: number,
  viscosityPaS: number,
): number {
  if (viscosityPaS <= 0) return 0;
  return (densityKgM3 * Math.abs(velocityMS) * hydraulicDiameterM) / viscosityPaS;
}

// ---------------------------------------------------------------------------
// flow regime
// ---------------------------------------------------------------------------

export type FlowRegime = 'laminar' | 'transitional' | 'turbulent';

/**
 * Regime by Reynolds number.
 *
 * The thresholds are the conventional pipe-flow ones. Microfluidics is almost
 * always deep in the laminar range, but the label is reported for every segment
 * regardless — a user may be *designing* for turbulence, and hiding the number
 * when it looks boring would hide exactly the transition they are hunting for.
 */
export function flowRegime(re: number): FlowRegime {
  if (re < 2300) return 'laminar';
  if (re < 4000) return 'transitional';
  return 'turbulent';
}

export const REGIME_LABEL: Record<FlowRegime, string> = {
  laminar: 'Laminar',
  transitional: 'Transitional',
  turbulent: 'Turbulent',
};

// ---------------------------------------------------------------------------
// convection
// ---------------------------------------------------------------------------

/**
 * Nusselt number for internal flow.
 *
 * Laminar ducts have a constant Nu that depends only on shape and wall
 * condition; 3.66 (circular, constant wall temperature) and ~3.4–4.4 across
 * rectangular aspect ratios. A single laminar value is used because the
 * difference is well inside the uncertainty of everything else here.
 *
 * Above the laminar threshold it switches to Dittus–Boelter, which is where the
 * Prandtl dependence starts to matter.
 */
export function nusselt(re: number, pr: number, heating: boolean): number {
  if (re < 2300) return 3.66;
  const exponent = heating ? 0.4 : 0.3;
  const turbulent = 0.023 * re ** 0.8 * Math.max(pr, 1e-6) ** exponent;

  if (re < 4000) {
    // Blend across the transitional band rather than stepping, so a segment
    // sweeping through 2300 does not show a discontinuity in its temperature.
    const t = (re - 2300) / (4000 - 2300);
    const atThreshold = 0.023 * 2300 ** 0.8 * Math.max(pr, 1e-6) ** exponent;
    return 3.66 + t * (Math.max(turbulent, atThreshold) - 3.66);
  }

  return turbulent;
}

/** Convective heat transfer coefficient, W/m²·K. */
export const convectionCoefficient = (
  nu: number,
  fluidConductivityWmK: number,
  hydraulicDiameterM: number,
): number => (hydraulicDiameterM > 0 ? (nu * fluidConductivityWmK) / hydraulicDiameterM : 0);
