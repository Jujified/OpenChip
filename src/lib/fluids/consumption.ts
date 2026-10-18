/**
 * What running a chip costs, in fluid and in time.
 *
 * Pure arithmetic on the simulation's own outputs — no solver work happens
 * here. The flow rates are the ones the user set at each inlet, and the volumes
 * are the ones `simulate` integrated along the loft; this module only divides
 * them by each other and multiplies them by a duration.
 *
 * It is a separate module rather than a lump of JSX so the numbers can be
 * asserted without rendering anything. The volume formatting lives here for the
 * same reason: "is 18000 µL shown as 18.0 mL" is a question about a function,
 * not about a component.
 *
 * Fluid *identity* is deliberately absent. Resolving which profile an inlet
 * carries is the React layer's job (`resolveFluid` in `hooks/useSimulation`),
 * and `lib/` does not import from `hooks/` or `store/` anywhere else. So an
 * inlet is reported by `portId` and `fluidProfileId`, and the panel puts a name
 * to it.
 */

import type { ChannelGraph, FluidAssignment } from '../../types/project';
import type { SimulationResult } from './simulate';

const MIN_PER_H = 60;
const S_PER_MIN = 60;
const UL_PER_ML = 1000;
const ML_PER_L = 1000;

export interface InletConsumption {
  portId: string;
  /** Which profile feeds this inlet. The panel resolves it to a name. */
  fluidProfileId: string | null;
  flowUlPerMin: number;
  flowMlPerH: number;
  /** Fluid this inlet gets through over the run, µL. */
  runVolumeUl: number;
}

export interface OutletCollection {
  portId: string;
  flowUlPerMin: number;
  flowMlPerH: number;
  /** Fluid collected here over the run, µL. */
  runVolumeUl: number;
}

export interface ConsumptionSummary {
  inlets: InletConsumption[];
  outlets: OutletCollection[];

  totalFlowUlPerMin: number;
  totalFlowMlPerH: number;
  /** Everything the inlets get through over the run, µL. */
  totalRunVolumeUl: number;

  /** Fluid needed to fill the channel network before anything comes out, µL. */
  primingVolumeUl: number;
  primingTimeS: number;
  /** Fastest inlet → outlet transit: when the first drop appears, s. */
  timeToFirstDropS: number;
  /** Slowest route, s. Equal to the fastest on an unbranched chip. */
  slowestTransitS: number;

  washVolumeUl: number;
  washMultiplier: number;
  /** How long the wash takes at the current total flow, s. */
  washTimeS: number;

  runDurationMin: number;
}

export interface ConsumptionInput {
  graph: ChannelGraph;
  result: SimulationResult;
  assignments: FluidAssignment[];
  /** Minutes the user intends to run for. */
  runDurationMin: number;
  /** Displacement volumes of the channel network to flush through afterwards. */
  washMultiplier: number;
}

/** Seconds to move `volumeUl` at `rateUlPerMin`. Infinite where nothing flows. */
export function timeToMoveS(volumeUl: number, rateUlPerMin: number): number {
  if (!(rateUlPerMin > 0)) return volumeUl > 0 ? Infinity : 0;
  return (volumeUl / rateUlPerMin) * S_PER_MIN;
}

export const mlPerHour = (ulPerMin: number): number => (ulPerMin * MIN_PER_H) / UL_PER_ML;

export function computeConsumption(input: ConsumptionInput): ConsumptionSummary {
  const { graph, result, assignments, runDurationMin, washMultiplier } = input;

  const duration = Math.max(0, runDurationMin);
  const multiplier = Math.max(0, washMultiplier);

  const inlets: InletConsumption[] = assignments
    .filter((a) => a.role === 'inlet')
    .map((a) => ({
      portId: a.portId,
      fluidProfileId: a.fluidProfileId,
      flowUlPerMin: a.flowRateUlPerMin,
      flowMlPerH: mlPerHour(a.flowRateUlPerMin),
      runVolumeUl: a.flowRateUlPerMin * duration,
    }));

  // What leaves an outlet is whatever the solve pushed down the channels
  // attached to it — not an even share of the inlet total, which would be wrong
  // on any chip whose outlets differ in resistance.
  const flowByEdge = new Map(result.segments.map((s) => [s.edgeId, Math.abs(s.flowUlPerMin)]));
  const collectedAt = (portId: string): number =>
    graph.edges
      .filter((e) => e.fromNodeId === portId || e.toNodeId === portId)
      .reduce((sum, e) => sum + (flowByEdge.get(e.id) ?? 0), 0);

  const outlets: OutletCollection[] = assignments
    .filter((a) => a.role === 'outlet')
    .map((a) => {
      const flowUlPerMin = collectedAt(a.portId);
      return {
        portId: a.portId,
        flowUlPerMin,
        flowMlPerH: mlPerHour(flowUlPerMin),
        runVolumeUl: flowUlPerMin * duration,
      };
    });

  // Taken from the result rather than re-summed off the assignments: the two
  // would agree today and could silently diverge tomorrow, and the simulation
  // is the one that decides what the chip is being fed.
  const totalFlowUlPerMin = result.totalFlowUlPerMin;
  const primingVolumeUl = result.totalInternalVolumeUl;
  const washVolumeUl = primingVolumeUl * multiplier;

  return {
    inlets,
    outlets,

    totalFlowUlPerMin,
    totalFlowMlPerH: mlPerHour(totalFlowUlPerMin),
    totalRunVolumeUl: totalFlowUlPerMin * duration,

    primingVolumeUl,
    primingTimeS: result.primingTimeS,
    timeToFirstDropS: result.transitTimeS.min,
    slowestTransitS: result.transitTimeS.max,

    washVolumeUl,
    washMultiplier: multiplier,
    washTimeS: timeToMoveS(washVolumeUl, totalFlowUlPerMin),

    runDurationMin: duration,
  };
}

// ---------------------------------------------------------------------------
// display
// ---------------------------------------------------------------------------

/**
 * Three significant figures, near enough.
 *
 * A syringe pump's dial has three digits and the estimate behind these numbers
 * does not have more than that; printing 17.9999 mL would imply a precision the
 * model never claimed.
 */
function significant(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 100) return value.toFixed(0);
  if (abs >= 10) return value.toFixed(1);
  if (abs >= 1) return value.toFixed(2);
  return value.toFixed(3);
}

/**
 * Volume in whichever unit keeps the number readable.
 *
 * A chip holds tens of microlitres and an overnight run gets through litres of
 * buffer, and the same panel has to say both. Fixed units would print either
 * `0.00004 L` or `1080000 µL`, and neither is a number anyone can act on.
 */
export function formatVolumeUl(volumeUl: number): string {
  if (!Number.isFinite(volumeUl)) return '—';

  const abs = Math.abs(volumeUl);
  if (abs < UL_PER_ML) return `${significant(volumeUl)} µL`;

  const ml = volumeUl / UL_PER_ML;
  if (Math.abs(ml) < ML_PER_L) return `${significant(ml)} mL`;

  return `${significant(ml / ML_PER_L)} L`;
}

/** Flow rate in µL/min, the unit the inlets are set in. */
export const formatFlowUlPerMin = (ulPerMin: number): string =>
  Number.isFinite(ulPerMin) ? `${significant(ulPerMin)} µL/min` : '—';

/** The same rate per hour, which is how a day's buffer gets ordered. */
export const formatFlowMlPerH = (mlPerH: number): string =>
  Number.isFinite(mlPerH) ? `${significant(mlPerH)} mL/h` : '—';

/**
 * A duration in the unit that suits it.
 *
 * Under a minute stays in seconds, because a priming time of 8 s is a number
 * you wait out; past an hour it goes to hours, because 7200 s is not.
 */
export function formatDurationS(durationS: number): string {
  if (!Number.isFinite(durationS)) return '—';

  const abs = Math.abs(durationS);
  if (abs < S_PER_MIN) return `${significant(durationS)} s`;

  const minutes = durationS / S_PER_MIN;
  if (Math.abs(minutes) < MIN_PER_H) return `${significant(minutes)} min`;

  return `${significant(minutes / MIN_PER_H)} h`;
}
