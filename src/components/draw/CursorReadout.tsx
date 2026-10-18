import type { SnapResult } from '../../lib/snapping';
import { useCursorStore } from '../../store/cursorStore';

/**
 * Where the cursor is, in chip millimetres.
 *
 * The rulers already draw a crosshair, which answers "roughly where" — this
 * answers "exactly where", which is the question you have when you are placing
 * an inlet 5 mm in from the edge.
 *
 * It reports the **snapped** point rather than the raw pointer, because that is
 * the coordinate a click actually produces. A readout that disagreed with where
 * the node landed would be worse than no readout.
 */
export function CursorReadout({ snap }: { snap: SnapResult | null }) {
  const point = useCursorStore((s) => s.cursorMm);
  // Two decimals is 10 µm — an order below what any of these printers resolve,
  // and past the point where more digits are information rather than noise.
  const format = (mm: number | undefined) => (mm === undefined ? '—' : mm.toFixed(2));

  const snapLabel =
    !snap || snap.kind === 'none'
      ? null
      : snap.kind === 'angle'
        ? `${snap.angleDeg ?? 0}°`
        : snap.kind;

  return (
    <div className="pointer-events-none absolute bottom-3 right-3 z-20 flex items-center gap-2 rounded-lg border border-line bg-panel/95 px-2.5 py-1.5 font-mono text-[11px] shadow-[var(--shadow-menu)] backdrop-blur">
      <Axis label="X" value={format(point?.x)} />
      <Axis label="Y" value={format(point?.y)} />
      <span className="text-ink-quiet">mm</span>
      {snapLabel ? (
        <span className="border-l border-line pl-2 text-accent">{snapLabel}</span>
      ) : null}
    </div>
  );
}

function Axis({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-baseline gap-1">
      <span className="text-ink-quiet">{label}</span>
      {/* Fixed width so the box does not twitch as the number crosses 10 mm. */}
      <span className="min-w-[2.75rem] text-right tabular-nums text-ink">{value}</span>
    </span>
  );
}
