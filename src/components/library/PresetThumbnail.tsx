import { useMemo } from 'react';
import { cn } from '../../lib/cn';
import { DEFAULT_CHIP_PARAMS } from '../../lib/defaults';
import { buildThumbnail, presetBuild, type ChipPreset } from '../../lib/presets';

/**
 * The preview drawn on every template card.
 *
 * Painted from the preset's real geometry through `solveLoft`, so a channel
 * that tapers in the model tapers in the picture — the droplet generator's
 * 0.35 mm throat is visible at card size, which is the one thing a static
 * thumbnail would have flattened away.
 *
 * Colours come from theme tokens rather than being baked in, so the same
 * component is correct in both schemes.
 */
export function PresetThumbnail({
  preset,
  className,
  detailed = false,
}: {
  preset: ChipPreset;
  className?: string;
  /** Larger strokes and visible ports, for the detail view. */
  detailed?: boolean;
}) {
  const thumb = useMemo(() => {
    const build = presetBuild(preset);
    return buildThumbnail(build.graph, { ...DEFAULT_CHIP_PARAMS, ...preset.chipParams });
  }, [preset]);

  // A little air around the chip so the outline is not clipped by the viewBox.
  const pad = Math.max(thumb.widthMm, thumb.lengthMm) * 0.04;
  const viewBox = `${-pad} ${-pad} ${thumb.widthMm + pad * 2} ${thumb.lengthMm + pad * 2}`;

  return (
    <svg
      viewBox={viewBox}
      className={cn('h-full w-full', className)}
      role="img"
      aria-label={`${preset.name} channel layout`}
      preserveAspectRatio="xMidYMid meet"
    >
      {/* Chip space runs +Y up; SVG runs +Y down. One flip here keeps every
          coordinate below in plain chip millimetres. */}
      <g transform={`translate(0 ${thumb.lengthMm}) scale(1 -1)`}>
        <rect
          x={0}
          y={0}
          width={thumb.widthMm}
          height={thumb.lengthMm}
          rx={thumb.widthMm * 0.02}
          className="fill-canvas stroke-line"
          strokeWidth={1.25}
          vectorEffect="non-scaling-stroke"
        />

        {thumb.ribbons.map((d, i) => (
          <path key={`r${i}`} d={d} className="fill-accent" fillOpacity={0.28} />
        ))}

        {/* A hairline over the ribbon: at card size a 0.35 mm channel is a
            fraction of a pixel wide, and without this the throat of the
            droplet generator simply disappears. */}
        {thumb.centerlines.map((d, i) => (
          <path
            key={`c${i}`}
            d={d}
            fill="none"
            className="stroke-accent"
            strokeOpacity={detailed ? 0.9 : 0.75}
            strokeWidth={detailed ? 1.5 : 1}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {thumb.chambers.map((chamber, i) => (
          <circle
            key={`ch${i}`}
            cx={chamber.x}
            cy={chamber.y}
            r={chamber.r}
            className="fill-accent stroke-accent"
            fillOpacity={0.25}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {thumb.ports.map((port, i) => (
          <g key={`p${i}`}>
            <circle
              cx={port.x}
              cy={port.y}
              r={port.r}
              className="fill-panel stroke-accent"
              strokeWidth={detailed ? 1.5 : 1.25}
              vectorEffect="non-scaling-stroke"
            />
            <circle cx={port.x} cy={port.y} r={port.bore} className="fill-accent" />
          </g>
        ))}
      </g>
    </svg>
  );
}
