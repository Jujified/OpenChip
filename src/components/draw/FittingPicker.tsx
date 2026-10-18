/**
 * The catalogue fitting picker.
 *
 * A scientist ordering consumables thinks in part names and tubing sizes, not
 * taper diameters — so this is the first control on a port, and it leads with a
 * drawing. Seeing that one entry grows a spigot and another cuts a hole is the
 * whole decision, and no amount of prose gets there as fast.
 *
 * Collapsed it shows the current part; open it lists them and closes again on
 * choosing one. Each row carries both views of its drawing, switched by the
 * dots underneath — which deliberately do *not* select the row, so you can look
 * before committing.
 */

import { useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/cn';
import { FITTING_PRESETS, type FittingPreset } from '../../lib/ports';
import { FittingDrawing, type FittingView } from './FittingDrawing';

const VIEWS: { id: FittingView; label: string }[] = [
  { id: 'section', label: 'Cross-section with dimensions' },
  { id: 'solid', label: 'Solid view' },
];

export function FittingPicker({
  selected,
  onSelect,
}: {
  selected: FittingPreset | undefined;
  onSelect: (fitting: FittingPreset) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  // Clicking away or pressing Escape closes it, the way any menu does.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
      }
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className={cn(
          'flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left',
          'transition-colors duration-150 hover:border-line-strong',
          'focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25',
          open ? 'border-accent bg-panel' : 'border-line bg-panel',
        )}
      >
        {selected ? (
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-line bg-sunken">
            <FittingDrawing
              portType={selected.portType}
              boreMm={selected.boreMm}
              spec={selected.spec}
              view="solid"
              className="h-7 w-7"
            />
          </span>
        ) : null}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-ink">
            {selected ? selected.label : 'No catalogue fitting'}
          </span>
          <span className="block truncate text-[11px] text-ink-muted">
            {selected ? selected.blurb : 'Hand-tuned dimensions — pick a part to start from.'}
          </span>
        </span>
        <Chevron open={open} />
      </button>

      {open ? (
        <div
          role="listbox"
          className={cn(
            'oc-fitting-list absolute left-0 right-0 top-[calc(100%+6px)] z-40 max-h-[26rem]',
            'overflow-y-auto rounded-xl border border-line bg-elevated p-1',
            'shadow-[var(--shadow-menu)]',
          )}
        >
          {FITTING_PRESETS.map((entry) => (
            <Row
              key={entry.id}
              fitting={entry}
              active={selected?.id === entry.id}
              onSelect={() => {
                onSelect(entry);
                setOpen(false);
              }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Row({
  fitting,
  active,
  onSelect,
}: {
  fitting: FittingPreset;
  active: boolean;
  onSelect: () => void;
}) {
  const [view, setView] = useState<FittingView>('section');

  return (
    <div
      className={cn(
        'flex gap-3 rounded-lg p-2 transition-colors duration-150',
        active ? 'bg-accent-wash' : 'hover:bg-sunken',
      )}
    >
      <div className="flex w-24 shrink-0 flex-col items-center gap-1.5">
        <button
          type="button"
          onClick={onSelect}
          tabIndex={-1}
          aria-hidden
          className="flex h-24 w-24 items-center justify-center rounded-md border border-line bg-sunken"
        >
          <FittingDrawing
            portType={fitting.portType}
            boreMm={fitting.boreMm}
            spec={fitting.spec}
            view={view}
            className="h-[5.5rem] w-[5.5rem]"
          />
        </button>

        {/* Switching the view is a look, not a choice — so it must not select. */}
        <div className="flex items-center gap-1.5">
          {VIEWS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setView(entry.id)}
              aria-label={`${entry.label} of the ${fitting.label}`}
              aria-pressed={view === entry.id}
              className={cn(
                'h-1.5 w-1.5 rounded-full transition-all duration-150',
                'focus:outline-none focus:ring-2 focus:ring-accent/40 focus:ring-offset-1',
                view === entry.id
                  ? 'scale-110 bg-accent'
                  : 'bg-line-strong hover:bg-ink-faint',
              )}
            />
          ))}
        </div>
      </div>

      <button
        type="button"
        role="option"
        aria-selected={active}
        onClick={onSelect}
        className="min-w-0 flex-1 text-left focus:outline-none focus:ring-2 focus:ring-accent/25 rounded-md"
      >
        <span
          className={cn(
            'block text-[13px] font-medium',
            active ? 'text-accent' : 'text-ink',
          )}
        >
          {fitting.label}
        </span>
        <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-muted">
          {fitting.blurb}
        </span>
      </button>
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      className={cn(
        'h-4 w-4 shrink-0 text-ink-faint transition-transform duration-200',
        open && 'rotate-180',
      )}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 6.5 8 10.5 12 6.5" />
    </svg>
  );
}
