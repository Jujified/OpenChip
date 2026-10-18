/**
 * Heat exchange between two streams running near each other in the chip.
 *
 * The physical path is: fluid A → its channel wall → solid chip material →
 * the other channel wall → fluid B. That is three resistances in series, and
 * the middle one is usually dominant — printed resin conducts about 0.2 W/m·K,
 * roughly three times worse than water and three hundred times worse than
 * aluminium. A chip designed as a heat exchanger lives or dies on how thin the
 * wall between the two channels is, which is exactly what this reports.
 *
 * ε-NTU rather than log-mean temperature difference, because ε-NTU needs only
 * the inlet temperatures — LMTD needs the outlets, which are what we are trying
 * to find.
 */

import { convectionCoefficient, nusselt } from './hydraulics';

export interface StreamState {
  /** Mass flow, kg/s. */
  massFlowKgS: number;
  specificHeatJkgK: number;
  temperatureC: number;
  /** Convective coefficient in this channel, W/m²·K. */
  hWm2K: number;
}

export interface ExchangeResult {
  /** Overall coefficient through both films and the wall, W/m²·K. */
  overallUWm2K: number;
  /** Heat actually transferred, W. Positive means from hot to cold. */
  heatFlowW: number;
  /** Heat flux across the shared wall, W/m². */
  wallFluxWm2: number;
  /** Number of transfer units. */
  ntu: number;
  /** Effectiveness, 0–1. */
  effectiveness: number;
  /** Temperature the hot stream leaves at, °C. */
  hotOutletC: number;
  coldOutletC: number;
  /**
   * How close the two streams get — the outlet temperature difference. A small
   * approach means the exchanger is doing its job.
   */
  approachC: number;
}

/**
 * One pairing of two streams across a shared wall.
 *
 * `wallThicknessM` is the solid between the two channels and `areaM2` is the
 * facing area over the length they run together.
 */
export function exchange(
  hot: StreamState,
  cold: StreamState,
  wallThicknessM: number,
  areaM2: number,
  chipConductivityWmK: number,
): ExchangeResult {
  const empty: ExchangeResult = {
    overallUWm2K: 0,
    heatFlowW: 0,
    wallFluxWm2: 0,
    ntu: 0,
    effectiveness: 0,
    hotOutletC: hot.temperatureC,
    coldOutletC: cold.temperatureC,
    approachC: Math.abs(hot.temperatureC - cold.temperatureC),
  };

  if (areaM2 <= 0 || hot.hWm2K <= 0 || cold.hWm2K <= 0) return empty;

  // Series resistance: film + wall conduction + film.
  const resistance =
    1 / hot.hWm2K + Math.max(wallThicknessM, 0) / Math.max(chipConductivityWmK, 1e-9) + 1 / cold.hWm2K;
  const U = 1 / resistance;

  const cHot = hot.massFlowKgS * hot.specificHeatJkgK;
  const cCold = cold.massFlowKgS * cold.specificHeatJkgK;

  // A stalled stream carries no heat away, so there is no exchange to report.
  if (cHot <= 0 || cCold <= 0) return { ...empty, overallUWm2K: U };

  const cMin = Math.min(cHot, cCold);
  const cMax = Math.max(cHot, cCold);
  const cr = cMin / cMax;
  const ntu = (U * areaM2) / cMin;

  // Counter-flow effectiveness. Counter-flow is assumed because it is both the
  // better arrangement and the one these layouts are drawn as; co-flow would
  // give a lower ceiling.
  const effectiveness =
    Math.abs(cr - 1) < 1e-9
      ? ntu / (1 + ntu)
      : (1 - Math.exp(-ntu * (1 - cr))) / (1 - cr * Math.exp(-ntu * (1 - cr)));

  const driving = hot.temperatureC - cold.temperatureC;
  const heatFlowW = effectiveness * cMin * driving;

  const hotOutletC = hot.temperatureC - heatFlowW / cHot;
  const coldOutletC = cold.temperatureC + heatFlowW / cCold;

  return {
    overallUWm2K: U,
    heatFlowW,
    wallFluxWm2: heatFlowW / areaM2,
    ntu,
    effectiveness,
    hotOutletC,
    coldOutletC,
    approachC: Math.abs(hotOutletC - coldOutletC),
  };
}

/** Convective coefficient for a segment, from its flow state. */
export function filmCoefficient(
  re: number,
  pr: number,
  fluidConductivityWmK: number,
  hydraulicDiameterM: number,
  heating: boolean,
): number {
  return convectionCoefficient(
    nusselt(re, pr, heating),
    fluidConductivityWmK,
    hydraulicDiameterM,
  );
}
