import { useMemo } from 'react';
import { adaptiveGridMm } from '../../lib/snapping';
import { useCursorStore } from '../../store/cursorStore';
import type { ViewState } from '../../store/editorStore';
import type { ChipParams } from '../../types/project';

const RULER_PX = 20;

/**
 * Millimetre rulers along the top and left of the canvas.
 *
 * Rendered as SVG in the DOM rather than inside the Paper scene: ruler text
 * must stay upright and pixel-crisp regardless of zoom, and it should not end
 * up in the exported schematic.
 */
export function Rulers({
  view,
  viewSize,
  chipParams,
}: {
  view: ViewState;
  viewSize: { width: number; height: number };
  chipParams: ChipParams;
}) {
  const cursorMm = useCursorStore((s) => s.cursorMm);
  const ticks = useMemo(() => {
    if (viewSize.width === 0 || viewSize.height === 0) return { x: [], y: [], step: 1 };

    // One label per ~64 px keeps the ruler readable at every zoom level.
    const step = adaptiveGridMm(1, view.zoom, 64);
    const halfW = viewSize.width / view.zoom / 2;
    const halfH = viewSize.height / view.zoom / 2;

    const minX = view.center.x - halfW;
    const maxX = view.center.x + halfW;
    const minY = view.center.y - halfH;
    const maxY = view.center.y + halfH;

    const x: { mm: number; px: number }[] = [];
    for (let mm = Math.ceil(minX / step) * step; mm <= maxX; mm += step) {
      x.push({ mm, px: (mm - minX) * view.zoom });
    }

    const y: { mm: number; px: number }[] = [];
    for (let mm = Math.ceil(minY / step) * step; mm <= maxY; mm += step) {
      // Chip Y runs up, screen Y runs down.
      y.push({ mm, px: (maxY - mm) * view.zoom });
    }

    return { x, y, step };
  }, [view, viewSize]);

  const format = (mm: number) =>
    ticks.step < 1 ? mm.toFixed(1) : String(Math.round(mm * 100) / 100);

  const cursorX = cursorMm
    ? (cursorMm.x - (view.center.x - viewSize.width / view.zoom / 2)) * view.zoom
    : null;
  const cursorY = cursorMm
    ? (view.center.y + viewSize.height / view.zoom / 2 - cursorMm.y) * view.zoom
    : null;

  return (
    <>
      {/* corner + scale readout */}
      <div
        className="pointer-events-none absolute left-0 top-0 z-20 flex items-center justify-center border-b border-r border-line bg-panel font-mono text-[9px] text-ink-quiet"
        style={{ width: RULER_PX, height: RULER_PX }}
      >
        mm
      </div>

      {/* top ruler */}
      <div
        className="pointer-events-none absolute top-0 z-10 overflow-hidden border-b border-line bg-panel"
        style={{ left: RULER_PX, right: 0, height: RULER_PX }}
      >
        <svg width="100%" height={RULER_PX} aria-hidden>
          {ticks.x.map((tick) => (
            <g key={tick.mm}>
              <line
                x1={tick.px}
                y1={RULER_PX - 5}
                x2={tick.px}
                y2={RULER_PX}
                stroke="var(--line-strong)"
                strokeWidth={1}
              />
              <text
                x={tick.px + 3}
                y={11}
                fill="var(--ink-quiet)"
                fontSize={9}
                fontFamily="ui-monospace, monospace"
              >
                {format(tick.mm)}
              </text>
            </g>
          ))}
          {/* chip boundary markers, so the workpiece is locatable at any zoom */}
          {[0, chipParams.width].map((mm) => {
            const px = (mm - (view.center.x - viewSize.width / view.zoom / 2)) * view.zoom;
            return (
              <line
                key={`chip-${mm}`}
                x1={px}
                y1={0}
                x2={px}
                y2={RULER_PX}
                stroke="var(--accent)"
                strokeWidth={1}
                opacity={0.6}
              />
            );
          })}
          {cursorX !== null ? (
            <line
              x1={cursorX}
              y1={0}
              x2={cursorX}
              y2={RULER_PX}
              stroke="var(--accent)"
              strokeWidth={1}
            />
          ) : null}
        </svg>
      </div>

      {/* left ruler */}
      <div
        className="pointer-events-none absolute left-0 z-10 overflow-hidden border-r border-line bg-panel"
        style={{ top: RULER_PX, bottom: 0, width: RULER_PX }}
      >
        <svg width={RULER_PX} height="100%" aria-hidden>
          {/* This SVG's origin already sits at the canvas's top edge, so tick
              offsets are used as-is — no ruler-width correction. */}
          {ticks.y.map((tick) => (
            <g key={tick.mm}>
              <line
                x1={RULER_PX - 5}
                y1={tick.px}
                x2={RULER_PX}
                y2={tick.px}
                stroke="var(--line-strong)"
                strokeWidth={1}
              />
              <text
                x={2}
                y={tick.px - 3}
                fill="var(--ink-quiet)"
                fontSize={9}
                fontFamily="ui-monospace, monospace"
              >
                {format(tick.mm)}
              </text>
            </g>
          ))}
          {[0, chipParams.length].map((mm) => {
            const px = (view.center.y + viewSize.height / view.zoom / 2 - mm) * view.zoom;
            return (
              <line
                key={`chip-${mm}`}
                x1={0}
                y1={px}
                x2={RULER_PX}
                y2={px}
                stroke="var(--accent)"
                strokeWidth={1}
                opacity={0.6}
              />
            );
          })}
          {cursorY !== null ? (
            <line x1={0} y1={cursorY} x2={RULER_PX} y2={cursorY} stroke="var(--accent)" strokeWidth={1} />
          ) : null}
        </svg>
      </div>
    </>
  );
}

export { RULER_PX };
