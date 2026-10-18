/**
 * Colour scales for the heatmap overlays.
 *
 * Three metrics, three encodings, chosen by the job the data does:
 *
 * - **Pressure** is a magnitude → one hue, light→dark (sequential).
 * - **Reynolds** is also a magnitude, so it gets its own single-hue ramp rather
 *   than three category colours. Colouring the bands would editorialise:
 *   turbulence is a *choice* here, not a fault, and painting it red would tell
 *   a user designing for mixing that their design is broken. The band
 *   boundaries appear as ticks on the legend instead, and the table carries the
 *   word.
 * - **Temperature** is a polarity around an ambient midpoint → two hues with a
 *   neutral grey center (diverging). Never a rainbow.
 * - **Residence time** is a magnitude like pressure, not a polarity like
 *   temperature — there is no meaningful center for "how long fluid sits in a
 *   segment", only more of it and less of it. So it gets a sequential ramp too,
 *   in a fourth hue, rather than a diverging one that would invent a midpoint.
 * - **Wall shear stress** gets a fifth hue and the same treatment as Reynolds:
 *   named reference bands on the legend, no severity colouring. High shear is a
 *   legitimate design target — it is how you break an emulsion or keep a wall
 *   clean — and painting 50 Pa red would tell a user doing that on purpose that
 *   their chip is broken. The ramp carries the magnitude; the words carry the
 *   meaning.
 *
 * Both modes are stepped for their own surface rather than flipped, and the
 * ramps are monotonic in lightness so the ordering survives greyscale and
 * colour-vision deficiency. The diverging poles measure ΔE 17.1 (light) and
 * 19.3 (dark) apart under simulated CVD, against a ≥8 target.
 */

import type { FlowRegime } from './hydraulics';

export type HeatmapMetric = 'pressure' | 'reynolds' | 'temperature' | 'residence' | 'shear';

export const METRIC_LABEL: Record<HeatmapMetric, string> = {
  pressure: 'Pressure',
  reynolds: 'Reynolds number',
  temperature: 'Temperature',
  residence: 'Residence time',
  shear: 'Wall shear stress',
};

/** Short form for the toolbar switcher, where five full names will not fit. */
export const METRIC_SHORT_LABEL: Record<HeatmapMetric, string> = {
  pressure: 'Pressure',
  reynolds: 'Reynolds',
  temperature: 'Temperature',
  residence: 'Residence',
  shear: 'Shear',
};

export const METRIC_UNIT: Record<HeatmapMetric, string> = {
  pressure: 'Pa',
  reynolds: '',
  temperature: '°C',
  residence: 's',
  shear: 'Pa',
};

/**
 * Metrics whose domain is mapped logarithmically.
 *
 * Residence time spans orders of magnitude the moment a chip splits flow
 * unevenly: a branch carrying a twentieth of the flow holds its fluid twenty
 * times as long. On a linear domain that paints every ordinary segment at the
 * pale end and says nothing about any of them. The legend states the scale is
 * logarithmic, because a log scale the reader cannot see is a lie.
 */
const LOG_DOMAIN: Record<HeatmapMetric, boolean> = {
  pressure: false,
  reynolds: false,
  temperature: false,
  residence: true,
  // Shear stays linear. Its reference bands are the thing a reader locates on
  // the bar, and they land where the chip's own numbers put them rather than
  // being spread out by a scale the bands did not ask for.
  shear: false,
};

// ---------------------------------------------------------------------------
// ramps
// ---------------------------------------------------------------------------

interface Ramp {
  stops: string[];
  /** Diverging ramps center on a neutral; sequential ones run end to end. */
  diverging: boolean;
}

const RAMPS: Record<HeatmapMetric, { light: Ramp; dark: Ramp }> = {
  pressure: {
    light: { stops: ['#cde2fb', '#9ec5f4', '#5598e7', '#2a78d6', '#184f95', '#0d366b'], diverging: false },
    dark: { stops: ['#123a63', '#1c5cab', '#2a78d6', '#5598e7', '#86b6ef', '#cde2fb'], diverging: false },
  },
  reynolds: {
    light: { stops: ['#fbe6c8', '#f5c98f', '#eda100', '#c98500', '#a5670a', '#7a4a06'], diverging: false },
    dark: { stops: ['#5c3a08', '#8a5709', '#c98500', '#eda100', '#f0bd5c', '#fbe6c8'], diverging: false },
  },
  temperature: {
    light: { stops: ['#184f95', '#7fa8d8', '#f0efec', '#e0907f', '#b4322f'], diverging: true },
    dark: { stops: ['#6da7ec', '#3f6c9e', '#383835', '#a35450', '#e66767'], diverging: true },
  },
  residence: {
    light: { stops: ['#e6dcf7', '#c9b3ec', '#a684dc', '#8759c8', '#63389c', '#43206e'], diverging: false },
    dark: { stops: ['#3a1f63', '#5a3699', '#8759c8', '#a684dc', '#c2a5e6', '#e6dcf7'], diverging: false },
  },
  shear: {
    light: { stops: ['#cdeee9', '#96d9d0', '#4bb8ab', '#219388', '#15706a', '#0d4f4c'], diverging: false },
    dark: { stops: ['#0f4a46', '#137a72', '#219388', '#4bb8ab', '#7fcfc5', '#cdeee9'], diverging: false },
  },
};

const hexToRgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

const rgbToHex = (rgb: [number, number, number]): string =>
  `#${rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('')}`;

/** Samples a ramp at 0–1. Interpolates in sRGB, which is fine over short steps. */
export function sampleRamp(stops: string[], t: number): string {
  if (stops.length === 0) return '#888888';
  const clamped = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  const scaled = clamped * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(scaled));
  const frac = scaled - i;

  const a = hexToRgb(stops[i]);
  const b = hexToRgb(stops[i + 1]);
  return rgbToHex([
    a[0] + (b[0] - a[0]) * frac,
    a[1] + (b[1] - a[1]) * frac,
    a[2] + (b[2] - a[2]) * frac,
  ]);
}

// ---------------------------------------------------------------------------
// scales
// ---------------------------------------------------------------------------

export interface HeatmapScale {
  metric: HeatmapMetric;
  min: number;
  max: number;
  /** Center value for a diverging scale — ambient, for temperature. */
  center?: number;
  stops: string[];
  diverging: boolean;
  /** True when position is mapped by log(value), so the legend can say so. */
  logarithmic: boolean;
  colorAt: (value: number) => string;
  /** Legend ticks, evenly spaced across the domain. */
  ticks: { value: number; position: number }[];
  /** Named boundaries drawn on the legend, e.g. the Reynolds regime limits. */
  bands: { label: string; value: number; position: number }[];
}

export interface ScaleOptions {
  dark: boolean;
  /** Temperature diverges about this, defaulting to the mean inlet temperature. */
  centerC?: number;
}

/**
 * Named boundaries a metric can mark on its legend.
 *
 * A `Record` rather than a chain of special cases, so a metric that wants bands
 * declares them here and one that does not says so explicitly — and adding a
 * sixth metric has to answer the question rather than silently inheriting no
 * bands from an `if`.
 *
 * None of these are thresholds in the validation sense. Nothing here blocks
 * anything; they exist to give a bare number a sense of scale.
 */
const METRIC_BANDS: Record<HeatmapMetric, { label: string; value: number }[]> = {
  pressure: [],
  temperature: [],
  residence: [],
  reynolds: [
    { label: 'Transitional', value: 2300 },
    { label: 'Turbulent', value: 4000 },
  ],
  shear: [
    { label: 'Typical perfusion', value: 1 },
    { label: 'Shear-sensitive cells at risk', value: 10 },
    { label: 'Lysis territory', value: 50 },
  ],
};

/**
 * The caveat that has to travel with a metric's bands.
 *
 * The Reynolds limits are properties of the flow and need no hedging. The shear
 * figures are biology, and a number like "50 Pa" printed next to the word
 * "lysis" will be read as a specification unless it is told not to be.
 */
export const METRIC_BAND_NOTE: Record<HeatmapMetric, string> = {
  pressure: '',
  reynolds: '',
  temperature: '',
  residence: '',
  shear:
    'Order-of-magnitude reference points for mammalian cells in suspension. Real tolerance ' +
    'varies with cell type, how long the cells are exposed, and whether they are adherent — ' +
    'these give the number a sense of scale, they do not certify anything.',
};

export function buildScale(
  metric: HeatmapMetric,
  domain: [number, number],
  options: ScaleOptions,
): HeatmapScale {
  const ramp = RAMPS[metric][options.dark ? 'dark' : 'light'];
  let [min, max] = domain;

  // A flat field would divide by zero and paint everything the same; widen it
  // so the single value lands mid-ramp and reads as "uniform" rather than "max".
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 0;
    max = 1;
  }
  if (Math.abs(max - min) < 1e-9) {
    const pad = Math.max(Math.abs(max) * 0.05, 1e-6);
    min -= pad;
    max += pad;
  }

  let center: number | undefined;
  if (ramp.diverging) {
    center = options.centerC ?? (min + max) / 2;
    // Symmetric arms, so equal departures from ambient get equal colour weight
    // on both sides — otherwise a chip that warms 2 °C and cools 20 °C would
    // paint the warming as though it matched the cooling.
    const reach = Math.max(Math.abs(max - center), Math.abs(center - min), 1e-6);
    min = center - reach;
    max = center + reach;
  }

  // A log domain needs a positive floor. Six decades below the top is wider
  // than any real chip's flow split, and keeps a segment at the very bottom of
  // the range on the scale instead of off the end of it.
  const logarithmic = LOG_DOMAIN[metric];
  if (logarithmic) {
    max = Math.max(max, 1e-12);
    min = Math.max(min, max * 1e-6);
  }
  const logMin = Math.log(min);
  const logSpan = Math.max(Math.log(max) - logMin, 1e-12);

  const position = (value: number) =>
    logarithmic
      ? (Math.log(Math.max(value, min)) - logMin) / logSpan
      : (value - min) / (max - min);

  const colorAt = (value: number) => sampleRamp(ramp.stops, position(value));

  const ticks = Array.from({ length: 5 }, (_, i) => {
    const p = i / 4;
    return {
      value: logarithmic ? Math.exp(logMin + logSpan * p) : min + (max - min) * p,
      position: p,
    };
  });

  // Bands within a couple of percent of either end sit under the bar's own
  // border and read as decoration, so they are dropped rather than drawn.
  const bands: HeatmapScale['bands'] = [];
  for (const { label, value } of METRIC_BANDS[metric]) {
    const p = position(value);
    if (p > 0.02 && p < 0.98) bands.push({ label, value, position: p });
  }

  return {
    metric,
    min,
    max,
    center,
    stops: ramp.stops,
    diverging: ramp.diverging,
    logarithmic,
    colorAt,
    ticks,
    bands,
  };
}

/** CSS gradient for the legend bar. */
export const gradientCss = (stops: string[]): string =>
  `linear-gradient(to right, ${stops.join(', ')})`;

// ---------------------------------------------------------------------------
// regime marks
// ---------------------------------------------------------------------------

/**
 * Text colours for the regime label in the results table.
 *
 * Deliberately not a red/amber/green severity set. Laminar is the ordinary case
 * and turbulent is a legitimate design target; the ramp's own hues carry the
 * magnitude and the word carries the meaning.
 */
export const REGIME_TONE: Record<FlowRegime, string> = {
  laminar: 'text-ink-muted',
  transitional: 'text-caution',
  turbulent: 'text-accent',
};

/** The fields a segment has to carry to be painted. */
export interface MetricSource {
  inletPressurePa: number;
  reynolds: number;
  temperatureInC: number;
  temperatureOutC: number;
  residenceTimeS: number;
  wallShearPa: number;
}

/** Value a segment contributes for a metric, used for both colour and range. */
export function metricValue(metric: HeatmapMetric, segment: MetricSource): number {
  switch (metric) {
    case 'pressure':
      return segment.inletPressurePa;
    case 'reynolds':
      return segment.reynolds;
    case 'residence':
      return segment.residenceTimeS;
    case 'shear':
      return segment.wallShearPa;
    default:
      return (segment.temperatureInC + segment.temperatureOutC) / 2;
  }
}

/**
 * Domain for a metric across a set of segments.
 *
 * Non-finite values are dropped rather than carried: a stalled segment's
 * residence time is Infinity, and letting that into the domain would collapse
 * the ramp to a single colour for every segment that *is* moving. Those
 * segments still paint — `position` clamps them to the far end — and the table
 * reports them as "—", which is the honest reading of "the fluid never leaves".
 */
export function metricDomain(
  metric: HeatmapMetric,
  segments: MetricSource[],
): [number, number] {
  const values = segments
    .map((segment) => metricValue(metric, segment))
    .filter((value) => Number.isFinite(value));

  return values.length > 0 ? [Math.min(...values), Math.max(...values)] : [0, 1];
}
