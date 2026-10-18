import { useEffect, useId, useRef, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

// ---------------------------------------------------------------------------
// layout
// ---------------------------------------------------------------------------

export function Field({
  label,
  hint,
  htmlFor,
  children,
  className,
  'data-tour': dataTour,
}: {
  label: string;
  hint?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
  /** Anchors the guided tour's spotlight. */
  'data-tour'?: string;
}) {
  return (
    <div data-tour={dataTour} className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-[13px] font-medium text-ink">
        {label}
      </label>
      {children}
      {hint ? <p className="text-xs leading-snug text-ink-muted">{hint}</p> : null}
    </div>
  );
}

const INPUT_BASE =
  'h-9 w-full rounded-lg border border-line bg-panel px-3 text-sm text-ink ' +
  'placeholder:text-ink-faint transition-colors duration-150 ' +
  'hover:border-line-strong focus:border-accent focus:outline-none ' +
  'focus:ring-2 focus:ring-accent/25 disabled:opacity-50';

// ---------------------------------------------------------------------------
// text
// ---------------------------------------------------------------------------

export function TextInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input type="text" className={cn(INPUT_BASE, className)} {...props} />;
}

// ---------------------------------------------------------------------------
// number
// ---------------------------------------------------------------------------

export interface NumberInputProps {
  value: number;
  onChange: (value: number) => void;
  /** Rendered inside the field's trailing edge, e.g. `mm` or `µm`. */
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  /** Decimal places shown when not being edited. */
  precision?: number;
  id?: string;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
  /**
   * The field stands for several values that differ. It shows blank with a
   * "Mixed" placeholder rather than one of them, which would read as though
   * they all were that. `value` is still what Escape and bad input fall back
   * to internally, but it is never displayed while this is set.
   */
  mixed?: boolean;
}

/**
 * A numeric field that tolerates being mid-typed.
 *
 * Binding an `<input type="number">` straight to a number is a classic trap:
 * clearing the field or typing `0.` produces `NaN`, which either snaps the
 * value back under the user's cursor or writes garbage into the model. So the
 * keystrokes live in local string state, valid values propagate as you type,
 * and anything still unparseable at blur reverts to the last good value.
 */
export function NumberInput({
  value,
  onChange,
  unit,
  min,
  max,
  step = 0.1,
  precision = 2,
  id,
  disabled,
  className,
  mixed = false,
  ...aria
}: NumberInputProps) {
  const format = (n: number) => String(Number.parseFloat(n.toFixed(precision)));
  const shown = () => (mixed ? '' : format(value));
  const [draft, setDraft] = useState(shown);
  const focused = useRef(false);
  /**
   * Set by Escape so the blur it causes does not commit the abandoned text.
   * Whatever the field pushed while typing may already have been undone by
   * then (the inspector does that), and committing on top would redo it.
   */
  const cancelled = useRef(false);

  // Track external changes (a preset applied, a project opened) unless the
  // user is actively typing into this field.
  useEffect(() => {
    if (!focused.current) setDraft(shown());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, precision, mixed]);

  const clamp = (n: number) => {
    if (min !== undefined && n < min) return min;
    if (max !== undefined && n > max) return max;
    return n;
  };

  const commit = () => {
    const parsed = Number.parseFloat(draft);
    if (Number.isFinite(parsed)) {
      const next = clamp(parsed);
      setDraft(format(next));
      // A mixed field commits even a value equal to `value`: it is a stand-in,
      // and typing it means "make them all this".
      if (next !== value || mixed) onChange(next);
    } else {
      setDraft(shown());
    }
  };

  return (
    <div className="relative">
      <input
        id={id}
        type="number"
        inputMode="decimal"
        value={draft}
        min={min}
        max={max}
        step={step}
        placeholder={mixed ? 'Mixed' : undefined}
        disabled={disabled}
        className={cn(INPUT_BASE, 'font-mono text-[13px]', unit && 'pr-10', className)}
        onFocus={(event) => {
          focused.current = true;
          event.currentTarget.select();
        }}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          const parsed = Number.parseFloat(next);
          // Push through live so dependent UI updates as the user types, but
          // only once the text is actually a number.
          if (Number.isFinite(parsed) && parsed === clamp(parsed)) onChange(parsed);
        }}
        onBlur={() => {
          focused.current = false;
          if (cancelled.current) {
            cancelled.current = false;
            setDraft(shown());
            return;
          }
          commit();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            commit();
            event.currentTarget.blur();
          }
          if (event.key === 'Escape') {
            cancelled.current = true;
            event.currentTarget.blur();
          }
        }}
        {...aria}
      />
      {unit ? (
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 font-mono text-xs text-ink-quiet">
          {unit}
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// segmented control
// ---------------------------------------------------------------------------

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
  className?: string;
}) {
  const name = useId();
  return (
    <div
      role="radiogroup"
      className={cn('inline-flex rounded-lg border border-line bg-sunken p-0.5', className)}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            name={name}
            onClick={() => onChange(option.value)}
            className={cn(
              'oc-pressable rounded-[6px] px-3 py-1.5 text-[13px] font-medium',
              selected ? 'bg-panel text-ink shadow-sm' : 'text-ink-muted hover:text-ink',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
