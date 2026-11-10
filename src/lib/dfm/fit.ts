/**
 * Fitting compensation parameters to coupon results.
 *
 * Two kinds of evidence, and they are worth very different amounts.
 *
 * **Measured dimensions** give the printed size of a channel directly, so the
 * offsets are a least-squares fit with a residual that says how well the model
 * describes the printer.
 *
 * **Open / partial / closed** only says on which side of a threshold each
 * channel fell. The most that can be recovered is the interval between the
 * largest size that closed and the smallest that stayed open. The fit reports
 * that interval and takes a point inside it, and the UI calls the result
 * coarse — because it is: with a coupon stepping in 0.05 mm, the lateral
 * offset per side is known to about ±0.0125 mm at best, and a closure width
 * alone cannot tell a large constant offset from a small one that grows in
 * narrow channels. So an open/closed fit always uses the constant model
 * (`lateralDecayMm` = 0).
 *
 * The two axes are fitted separately and may use different evidence: measured
 * widths with open/closed heights is a normal thing to have, since widths can
 * be read from above and heights need a section.
 *
 * Everything here is pure and deterministic.
 */

import { closureWidthMm, printedWidthMm, type LateralModel } from './model';
import type { AxisFit, CouponMeasurement } from './profile';

export interface FitResult {
  deltaXyMm: number;
  lateralDecayMm: number;
  deltaZMm: number;
  lateral: AxisFit;
  vertical: AxisFit;
  /** Plain-language caveats for the UI, most important first. */
  notes: string[];
}

/** Distinct measured widths needed before the decay length is fitted too. */
const MIN_WIDTHS_FOR_DECAY = 3;
const MAX_DECAY_MM = 0.5;

const round = (value: number, places = 4): number => Number(value.toFixed(places));
const distinct = (values: number[]): number[] =>
  [...new Set(values.map((v) => round(v)))].sort((a, b) => a - b);

// ---------------------------------------------------------------------------
// open / closed
// ---------------------------------------------------------------------------

interface Bracket {
  lo: number;
  hi: number | null;
  inconsistent: number;
  dataPoints: number;
}

/**
 * Closure thresholds in width and in height that best explain the results.
 *
 * A channel is taken to close when its width is at or below a width threshold
 * *or* its height is at or below a height threshold. Both are searched
 * together, because a channel that closed says only that one of the two was
 * crossed — the matrix of widths against heights is what separates them. Every
 * pair of candidate thresholds is scored by how many open and closed channels
 * it gets wrong; partial channels fit either side and score nothing.
 *
 * Several pairs usually tie. The answer for each axis is the full range of its
 * threshold over the tied pairs, which is the honest statement of what the
 * data pins down.
 */
function closureBrackets(measurements: CouponMeasurement[]): { width: Bracket; height: Bracket } {
  const marked = measurements.filter((m) => m.result !== null);
  const widths = distinct(marked.map((m) => m.nominalWidthMm));
  const heights = distinct(marked.map((m) => m.nominalHeightMm));

  // Candidate k means "the k smallest sizes close": the threshold sits between
  // size k and size k+1, with 0 below everything.
  const edges = (sizes: number[]) => [0, ...sizes];
  const widthEdges = edges(widths);
  const heightEdges = edges(heights);

  let best = Infinity;
  let tied: { wi: number; hi: number }[] = [];

  for (let wi = 0; wi < widthEdges.length; wi += 1) {
    for (let hi = 0; hi < heightEdges.length; hi += 1) {
      let wrong = 0;
      for (const m of marked) {
        const closes =
          round(m.nominalWidthMm) <= widthEdges[wi] || round(m.nominalHeightMm) <= heightEdges[hi];
        if (m.result === 'open' && closes) wrong += 1;
        if (m.result === 'closed' && !closes) wrong += 1;
      }
      if (wrong < best) {
        best = wrong;
        tied = [];
      }
      if (wrong === best) tied.push({ wi, hi });
    }
  }

  const bracket = (indices: number[], sizeEdges: number[], axis: 'w' | 'h'): Bracket => {
    const lowest = Math.min(...indices);
    const highest = Math.max(...indices);
    const upper = sizeEdges[highest + 1];
    let hi: number | null = upper ?? null;
    let lo = sizeEdges[lowest];

    // A partially open channel is sitting on the threshold, so it narrows the
    // interval to the top quarter below its own size.
    const partial = marked
      .filter((m) => m.result === 'partial')
      .map((m) => round(axis === 'w' ? m.nominalWidthMm : m.nominalHeightMm))
      .filter((size) => size > lo && (hi === null || size <= hi));
    if (partial.length > 0) {
      hi = Math.min(...partial);
      lo = hi - (hi - lo) / 4;
    }

    return { lo, hi, inconsistent: best === Infinity ? 0 : best, dataPoints: marked.length };
  };

  return {
    width: bracket(tied.map((t) => t.wi), widthEdges, 'w'),
    height: bracket(tied.map((t) => t.hi), heightEdges, 'h'),
  };
}

/**
 * A point estimate from a bracket.
 *
 * The midpoint when both ends are known. When nothing closed, the lower end —
 * zero — because enlarging channels on no evidence of overcure is the one
 * choice that can only make a good print worse. When nothing stayed open, the
 * lower end again: it is a floor, and the UI says so.
 */
const pointIn = (bracket: Bracket): number =>
  bracket.hi === null || bracket.lo === 0 ? bracket.lo : (bracket.lo + bracket.hi) / 2;

// ---------------------------------------------------------------------------
// measured
// ---------------------------------------------------------------------------

function sumSquares(points: { drawn: number; printed: number }[], model: LateralModel): number {
  let total = 0;
  for (const p of points) {
    const residual = printedWidthMm(p.drawn, model) - p.printed;
    total += residual * residual;
  }
  return total;
}

/** Best `deltaXyMm` for a fixed decay length, by golden-section search. */
function bestDelta(
  points: { drawn: number; printed: number }[],
  lateralDecayMm: number,
): { deltaXyMm: number; sse: number } {
  const widest = Math.max(...points.map((p) => p.drawn));
  let lo = 0;
  let hi = widest / 2;
  const ratio = (Math.sqrt(5) - 1) / 2;
  const cost = (deltaXyMm: number) => sumSquares(points, { deltaXyMm, lateralDecayMm });

  for (let i = 0; i < 60; i += 1) {
    const a = hi - (hi - lo) * ratio;
    const b = lo + (hi - lo) * ratio;
    if (cost(a) < cost(b)) hi = b;
    else lo = a;
  }
  const deltaXyMm = (lo + hi) / 2;
  return { deltaXyMm, sse: cost(deltaXyMm) };
}

function fitLateralMeasured(
  points: { drawn: number; printed: number }[],
): { model: LateralModel; rmsMm: number } {
  const widths = distinct(points.map((p) => p.drawn));
  let best = { lateralDecayMm: 0, ...bestDelta(points, 0) };

  if (widths.length >= MIN_WIDTHS_FOR_DECAY) {
    // A scan rather than a second golden-section: the cost is not guaranteed
    // to have one minimum in the decay length, and 100 evaluations of a
    // closed-form model are free.
    for (let step = 1; step <= 100; step += 1) {
      const lateralDecayMm = (MAX_DECAY_MM * step) / 100;
      const candidate = bestDelta(points, lateralDecayMm);
      // The extra parameter has to earn its place: a decay length is kept only
      // if it cuts the squared error by more than a tenth.
      if (candidate.sse < best.sse * 0.9) best = { lateralDecayMm, ...candidate };
    }
  }

  return {
    model: { deltaXyMm: best.deltaXyMm, lateralDecayMm: best.lateralDecayMm },
    rmsMm: Math.sqrt(best.sse / points.length),
  };
}

// ---------------------------------------------------------------------------
// the fit
// ---------------------------------------------------------------------------

export function fitCompensation(measurements: CouponMeasurement[]): FitResult {
  const notes: string[] = [];
  const brackets = closureBrackets(measurements);
  const anyMarked = brackets.width.dataPoints > 0;

  // --- lateral --------------------------------------------------------------
  const widthPoints = measurements
    .filter((m) => m.measuredWidthMm !== undefined && m.measuredWidthMm > 0)
    .map((m) => ({ drawn: m.nominalWidthMm, printed: m.measuredWidthMm as number }));

  let deltaXyMm = 0;
  let lateralDecayMm = 0;
  let lateral: AxisFit = { method: 'none', dataPoints: 0 };

  if (widthPoints.length > 0) {
    const fitted = fitLateralMeasured(widthPoints);
    deltaXyMm = fitted.model.deltaXyMm;
    lateralDecayMm = fitted.model.lateralDecayMm;
    lateral = { method: 'measured', dataPoints: widthPoints.length, rmsMm: round(fitted.rmsMm, 5) };

    const widths = distinct(widthPoints.map((p) => p.drawn)).length;
    if (widths < MIN_WIDTHS_FOR_DECAY) {
      notes.push(
        `Widths were measured at ${widths} size${widths === 1 ? '' : 's'}, so the lateral offset is fitted as a constant. ` +
          `Measure at least ${MIN_WIDTHS_FOR_DECAY} different widths to fit how it grows in narrow channels.`,
      );
    }
  } else if (anyMarked) {
    const b = brackets.width;
    // A channel closes when its width is at or below 2·Δxy in the constant
    // model, so the closure width is halved to get the per-side offset.
    deltaXyMm = pointIn(b) / 2;
    lateral = {
      method: 'open-closed',
      dataPoints: b.dataPoints,
      bracketMm: [round(b.lo / 2), b.hi === null ? null : round(b.hi / 2)],
      inconsistent: b.inconsistent,
    };
    notes.push(
      'The lateral offset comes from open/closed results only, so it is coarse: it is known no better than the ' +
        'range shown, and it is applied equally at every width. Measured widths give a real fit.',
    );
    if (b.hi === null) {
      notes.push(
        'No channel stayed open across its width, so the lateral offset is a lower bound. Reprint the coupon with wider channels.',
      );
    } else if (b.lo === 0) {
      notes.push(
        'No channel closed across its width, so lateral overcure is below what this coupon resolves and no lateral correction is applied.',
      );
    }
  }

  // --- vertical -------------------------------------------------------------
  const heightPoints = measurements.filter(
    (m) => m.measuredHeightMm !== undefined && m.measuredHeightMm > 0,
  );

  let deltaZMm = 0;
  let vertical: AxisFit = { method: 'none', dataPoints: 0 };

  if (heightPoints.length > 0) {
    const losses = heightPoints.map((m) => m.nominalHeightMm - (m.measuredHeightMm as number));
    const mean = losses.reduce((sum, v) => sum + v, 0) / losses.length;
    deltaZMm = Math.max(0, mean);
    const rms = Math.sqrt(losses.reduce((sum, v) => sum + (v - mean) ** 2, 0) / losses.length);
    vertical = { method: 'measured', dataPoints: heightPoints.length, rmsMm: round(rms, 5) };
  } else if (anyMarked) {
    const b = brackets.height;
    deltaZMm = pointIn(b);
    vertical = {
      method: 'open-closed',
      dataPoints: b.dataPoints,
      bracketMm: [round(b.lo), b.hi === null ? null : round(b.hi)],
      inconsistent: b.inconsistent,
    };
    notes.push(
      'The vertical offset comes from open/closed results only, so it is coarse: it is known no better than the range shown.',
    );
    if (b.hi === null) {
      notes.push(
        'No channel stayed open at any height, so the vertical offset is a lower bound. Reprint the coupon with taller channels.',
      );
    } else if (b.lo === 0) {
      notes.push(
        'No channel closed because of its height, so vertical overcure is below what this coupon resolves and no ceiling correction is applied.',
      );
    }
  }

  if (!anyMarked && widthPoints.length === 0 && heightPoints.length === 0) {
    notes.push('No results have been entered yet.');
  }

  const inconsistent = Math.max(lateral.inconsistent ?? 0, vertical.inconsistent ?? 0);
  if (inconsistent > 0) {
    notes.unshift(
      `${inconsistent} channel${inconsistent === 1 ? ' does' : 's do'} not fit any single threshold — for example a narrow ` +
        'channel open while a wider one at the same height is closed. Check those entries, or flush the coupon again: ' +
        'trapped resin reads as a closed channel.',
    );
  }

  return {
    deltaXyMm: round(deltaXyMm),
    lateralDecayMm: round(lateralDecayMm),
    deltaZMm: round(deltaZMm),
    lateral,
    vertical,
    notes,
  };
}

/** Drawn width at or below which a fitted profile predicts closure, mm. */
export const predictedClosureWidthMm = (fit: Pick<FitResult, 'deltaXyMm' | 'lateralDecayMm'>): number =>
  closureWidthMm(fit);
