import {
  METRIC_BAND_NOTE,
  METRIC_LABEL,
  METRIC_UNIT,
  gradientCss,
  type HeatmapScale,
} from '../../lib/fluids/heatmap';

/**
 * The legend.
 *
 * Always present — the colour is the only encoding on the map, so without a key
 * the heatmap is decoration. It carries the numeric domain, and for Reynolds it
 * also marks where the laminar / transitional / turbulent boundaries fall, which
 * is the one thing a colour ramp cannot say on its own.
 */
export function HeatmapLegend({ scale }: { scale: HeatmapScale }) {
  const unit = METRIC_UNIT[scale.metric];

  /** For a single named value — a band threshold, or the diverging center. */
  const format = (value: number): string => {
    const abs = Math.abs(value);
    if (abs >= 100_000) return value.toExponential(1);
    if (abs >= 1000) return Math.round(value).toLocaleString();
    if (abs >= 10) return value.toFixed(0);
    if (abs >= 1) return value.toFixed(1);
    return value.toFixed(2);
  };

  /**
   * For the axis, where precision has to come from the *span* rather than each
   * value on its own.
   *
   * Wall shear on an ordinary chip runs a few milli-pascals, and five ticks
   * rounded individually to two decimals print "0.01" five times over — which
   * is not a legend. Choosing the decimals once from the range fixes that, and
   * incidentally stops a 19–21 °C scale reading "19 | 20 | 20 | 21 | 21".
   */
  const formatTick = (() => {
    const span = Math.abs(scale.max - scale.min);
    const largest = Math.max(Math.abs(scale.min), Math.abs(scale.max));

    if (largest >= 100_000 || (span > 0 && span < 1e-3)) {
      return (value: number) => value.toExponential(1);
    }
    if (largest >= 1000) return (value: number) => Math.round(value).toLocaleString();

    const decimals = span >= 10 ? 0 : span >= 1 ? 1 : span >= 0.1 ? 2 : 3;
    return (value: number) => value.toFixed(decimals);
  })();

  return (
    <figure className="pointer-events-none absolute bottom-3 left-3 w-[17rem] rounded-lg border border-line bg-panel/95 p-2.5 shadow-[var(--shadow-menu)] backdrop-blur">
      <figcaption className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-medium text-ink">{METRIC_LABEL[scale.metric]}</span>
        {unit ? <span className="font-mono text-[10px] text-ink-quiet">{unit}</span> : null}
      </figcaption>

      <div className="relative">
        <div
          className="h-2.5 w-full rounded-sm border border-line"
          style={{ background: gradientCss(scale.stops) }}
        />

        {/* Regime boundaries, drawn on the bar itself so the threshold is
            located rather than merely stated. */}
        {scale.bands.map((band) => (
          <span
            key={band.label}
            className="absolute top-0 h-2.5 w-px bg-ink"
            style={{ left: `${band.position * 100}%` }}
            aria-hidden
          />
        ))}
      </div>

      <div className="mt-1 flex justify-between font-mono text-[10px] text-ink-muted">
        {scale.ticks.map((tick, i) => (
          <span key={i} className={i === 0 ? '' : i === scale.ticks.length - 1 ? 'text-right' : ''}>
            {formatTick(tick.value)}
          </span>
        ))}
      </div>

      {scale.bands.length > 0 ? (
        <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-ink-muted">
          {scale.bands.map((band) => (
            <span key={band.label}>
              <span className="mr-1 inline-block h-2 w-px translate-y-0.5 bg-ink" aria-hidden />
              {band.label} above {format(band.value)}
            </span>
          ))}
        </p>
      ) : null}

      {/* The bands are reference points, not a verdict. Anything that names a
          biological outcome has to carry what it does not know with it. */}
      {scale.bands.length > 0 && METRIC_BAND_NOTE[scale.metric] ? (
        <p className="mt-1.5 text-[10px] leading-snug text-ink-muted">
          {METRIC_BAND_NOTE[scale.metric]}
        </p>
      ) : null}

      {/* Stated, not implied. The tick values give it away to anyone who reads
          them closely, but a reader comparing two colours is entitled to know
          that a step along the bar is a factor rather than an increment. */}
      {scale.logarithmic ? (
        <p className="mt-1.5 text-[10px] leading-snug text-ink-muted">
          Logarithmic scale — each step along the bar is a multiple, not an increment. Segments
          carrying no flow are painted at the far end and read as “—” in the table.
        </p>
      ) : null}

      {scale.diverging && scale.center !== undefined ? (
        <p className="mt-1.5 text-[10px] leading-snug text-ink-muted">
          Diverging about {format(scale.center)} {unit} — the mean inlet temperature. Grey means
          unchanged.
        </p>
      ) : null}
    </figure>
  );
}
