import { Maximize2, Minus, Plus, Scan } from 'lucide-react';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { cn } from '../../lib/cn';
import type { DfmCompensation } from '../../hooks/useDfmCompensation';
import {
  buildDfmPreview,
  sliceSections,
  type DfmPreviewModel,
  type DfmSection,
  type SliceAxis,
} from '../../lib/dfm/preview';
import { shortHash } from '../../lib/dfm/profile';
import { useDfmStore } from '../../store/dfmStore';
import { Section } from '../draw/InspectorPanel';
import { Dialog } from '../ui/Dialog';
import { Segmented } from '../ui/Field';
import { WikiLink } from '../ui/WikiLink';

/**
 * The compensated-geometry preview.
 *
 * Read-only. It is handed the result of `compensateDesign` — the same call an
 * export makes — and draws it over the nominal design. It holds no reference to
 * a store action that edits the project, so there is nothing in here that
 * could change the design, its undo history or the saved file.
 *
 * ## How a change is shown
 *
 * Never by colour alone:
 *
 * - **as drawn** — a translucent fill with a *dashed* outline;
 * - **material removed** — *diagonal hatching* between the drawn and the
 *   compensated outline;
 * - **moved edge** — a *solid* outline in the accent colour;
 * - **conflict** — *cross-hatching*, a heavier outline in the danger colour,
 *   and a diamond marker where it is;
 * - **unchanged** — a thin solid neutral outline and no hatching.
 *
 * All of it is drawn from the theme tokens, so it follows light and dark.
 */

type Hover = { edgeId: string } | null;

interface ViewState {
  /** 1 fits the chip in the frame. */
  zoom: number;
  /** Chip-space point at the middle of the frame, mm. */
  cx: number;
  cy: number;
}

const mm = (value: number, places = 3): string => value.toFixed(places);

// ---------------------------------------------------------------------------
// the sidebar panel and its fullscreen twin
// ---------------------------------------------------------------------------

export function DfmPreviewPanel({ dfm }: { dfm: DfmCompensation }) {
  const [fullscreen, setFullscreen] = useState(false);
  const [axis, setAxis] = useState<SliceAxis>('x');
  /** Slice position as a fraction of the chip, so it survives a chip resize. */
  const [fraction, setFraction] = useState(0.5);
  const setPreviewOpen = useDfmStore((s) => s.setPreviewOpen);

  const { nominal, compensated, entry } = dfm;
  const model = useMemo(() => buildDfmPreview(nominal, compensated), [nominal, compensated]);

  const span = axis === 'x' ? model.chip.width : model.chip.length;
  const position = fraction * span;
  const sections = useMemo(
    () => sliceSections(nominal, compensated, axis, position),
    [nominal, compensated, axis, position],
  );

  const body = (large: boolean) => (
    <PreviewBody
      large={large}
      dfm={dfm}
      model={model}
      sections={sections}
      axis={axis}
      onAxis={setAxis}
      position={position}
      onPosition={(value) => setFraction(Math.min(1, Math.max(0, value / span)))}
    />
  );

  return (
    <>
      <Section
        title="DFM preview"
        action={
          <div className="flex items-center gap-1">
            <button
              type="button"
              title="Show the preview full size"
              aria-label="Show the preview full size"
              onClick={() => setFullscreen(true)}
              className="oc-pressable rounded p-1 text-ink-muted hover:bg-sunken hover:text-ink"
            >
              <Maximize2 size={13} />
            </button>
            <button
              type="button"
              onClick={() => setPreviewOpen(false)}
              className="oc-pressable rounded px-1.5 py-0.5 text-[11px] text-accent hover:bg-accent-wash"
            >
              Hide
            </button>
          </div>
        }
      >
        {/* Unmounted while the fullscreen view is up, so there is one live
            view and the sidebar shows exactly what was left on return. */}
        {fullscreen ? (
          <p className="text-[11px] text-ink-muted">Shown full size.</p>
        ) : (
          body(false)
        )}
      </Section>

      <Dialog
        open={fullscreen}
        onOpenChange={setFullscreen}
        title="DFM preview"
        description={`${entry.profile.meta.name} — the compensated design over the design as drawn. Read-only.`}
        className="h-[calc(100vh-2rem)] max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)]"
      >
        {fullscreen ? body(true) : null}
      </Dialog>
    </>
  );
}

function PreviewBody({
  large,
  dfm,
  model,
  sections,
  axis,
  onAxis,
  position,
  onPosition,
}: {
  large: boolean;
  dfm: DfmCompensation;
  model: DfmPreviewModel;
  sections: DfmSection[];
  axis: SliceAxis;
  onAxis: (axis: SliceAxis) => void;
  position: number;
  onPosition: (value: number) => void;
}) {
  const [hover, setHover] = useState<Hover>(null);
  const { compensated, entry } = dfm;
  const { applied } = compensated;

  const perSide = {
    min: applied.widthIncreaseMm.min / 2,
    max: applied.widthIncreaseMm.max / 2,
  };
  const varies = perSide.max - perSide.min > 0.0005;

  const numbers = (
    <div className="flex flex-col gap-1">
      <p className="truncate text-[12px] font-medium text-ink" title={entry.profile.meta.name}>
        {entry.profile.meta.name}
        <span className="ml-1.5 font-mono text-[10px] font-normal text-ink-quiet">
          {shortHash(entry.sha256)}
        </span>
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-[11px]">
        <dt className="text-ink-muted">Δxy</dt>
        <dd className="text-ink">
          {varies ? `${mm(perSide.min)}–${mm(perSide.max)}` : mm(applied.deltaXyMm)} mm per side
          {varies ? <span className="text-ink-quiet"> · more in narrow channels</span> : null}
          {applied.snappedToPixelMm ? (
            <span className="text-ink-quiet"> · snapped to {mm(applied.snappedToPixelMm)} mm pixels</span>
          ) : null}
        </dd>
        <dt className="text-ink-muted">Δz</dt>
        <dd className="text-ink">
          {applied.deltaZMm > 0 ? (
            <>{mm(applied.deltaZMm)} mm ceiling raise</>
          ) : applied.ceilingSkipped ? (
            <span className="text-ink-muted">
              not applied <span className="text-ink-quiet">(profile: {mm(applied.profileDeltaZMm)} mm)</span>
            </span>
          ) : (
            '0 mm'
          )}
        </dd>
      </dl>
      {applied.ceilingSkipped ? (
        <p className="text-[11px] leading-relaxed text-ink-muted">{applied.ceilingSkipped}</p>
      ) : null}
    </div>
  );

  const slice = (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-medium text-ink-muted">
          Cross-section at {axis} = <span className="font-mono text-ink">{mm(position, 2)} mm</span>
        </p>
        <Segmented
          value={axis}
          onChange={onAxis}
          className="[&>button]:px-2 [&>button]:py-0.5 [&>button]:text-[11px]"
          options={[
            { value: 'x' as const, label: 'Across X' },
            { value: 'y' as const, label: 'Across Y' },
          ]}
        />
      </div>
      <Sections
        sections={sections}
        axis={axis}
        large={large}
        hover={hover}
        onHover={setHover}
        chipTopZ={model.chip.baseThickness}
      />
      <p className="text-[11px] leading-relaxed text-ink-muted">
        Drag the slice line in the top view. The ceiling correction only shows here: it is
        invisible from above. <WikiLink to="printCorrection">How to read this</WikiLink>
      </p>
    </div>
  );

  if (large) {
    return (
      <div className="flex h-full min-h-0 gap-5 pb-4">
        <div className="min-h-0 min-w-0 flex-1">
          <TopView
            model={model}
            axis={axis}
            position={position}
            onPosition={onPosition}
            hover={hover}
            className="h-full min-h-[20rem]"
          />
        </div>
        <div className="flex w-[22rem] shrink-0 flex-col gap-4 overflow-y-auto pr-1">
          {numbers}
          <Legend />
          {slice}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {numbers}
      <TopView
        model={model}
        axis={axis}
        position={position}
        onPosition={onPosition}
        hover={hover}
        className="h-56"
      />
      <Legend />
      {slice}
    </div>
  );
}

// ---------------------------------------------------------------------------
// patterns and legend
// ---------------------------------------------------------------------------

/** The two hatches, in screen pixels so they read the same at every zoom. */
function Patterns({ id }: { id: string }) {
  return (
    <defs>
      <pattern
        id={`${id}-removed`}
        width="5"
        height="5"
        patternUnits="userSpaceOnUse"
        patternTransform="rotate(45)"
      >
        <line x1="0" y1="0" x2="0" y2="5" stroke="var(--accent)" strokeWidth="1.6" />
      </pattern>
      <pattern id={`${id}-conflict`} width="5" height="5" patternUnits="userSpaceOnUse">
        <path d="M0 0L5 5M5 0L0 5" stroke="var(--danger)" strokeWidth="1.3" />
      </pattern>
    </defs>
  );
}

function Legend() {
  const id = useId();
  const swatch = (children: ReactNode) => (
    <svg width="26" height="14" viewBox="0 0 26 14" aria-hidden className="shrink-0">
      <Patterns id={id} />
      {children}
    </svg>
  );
  const items: { label: string; swatch: ReactNode }[] = [
    {
      label: 'As drawn (dashed)',
      swatch: swatch(
        <rect
          x="1"
          y="2"
          width="24"
          height="10"
          fill="var(--ink)"
          fillOpacity="0.14"
          stroke="var(--ink-muted)"
          strokeDasharray="3 2"
        />,
      ),
    },
    {
      label: 'Material removed (hatched)',
      swatch: swatch(<rect x="1" y="2" width="24" height="10" fill={`url(#${id}-removed)`} />),
    },
    {
      label: 'Moved edge (solid)',
      swatch: swatch(<path d="M1 7H25" stroke="var(--accent)" strokeWidth="1.75" />),
    },
    {
      label: 'Conflict (cross-hatched)',
      swatch: swatch(
        <rect
          x="1.5"
          y="2.5"
          width="23"
          height="9"
          fill={`url(#${id}-conflict)`}
          stroke="var(--danger)"
          strokeWidth="2"
        />,
      ),
    },
    {
      label: 'Unchanged (thin)',
      swatch: swatch(
        <rect x="1" y="2" width="24" height="10" fill="none" stroke="var(--ink-quiet)" strokeWidth="1" />,
      ),
    },
  ];

  return (
    <ul className="grid grid-cols-2 gap-x-3 gap-y-1" aria-label="Legend">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5 text-[10.5px] leading-tight text-ink-muted">
          {item.swatch}
          {item.label}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// top view
// ---------------------------------------------------------------------------

function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, size };
}

const PADDING_PX = 14;
const MAX_ZOOM = 400;

function TopView({
  model,
  axis,
  position,
  onPosition,
  hover,
  className,
}: {
  model: DfmPreviewModel;
  axis: SliceAxis;
  position: number;
  onPosition: (value: number) => void;
  hover: Hover;
  className?: string;
}) {
  const id = useId();
  const { ref, size } = useElementSize<HTMLDivElement>();
  const { chip } = model;
  const [view, setView] = useState<ViewState>({ zoom: 1, cx: chip.width / 2, cy: chip.length / 2 });
  const drag = useRef<
    | { kind: 'pan'; x: number; y: number; cx: number; cy: number }
    | { kind: 'slice' }
    | null
  >(null);

  const fit =
    size.width > 0
      ? Math.min(
          (size.width - PADDING_PX * 2) / chip.width,
          (size.height - PADDING_PX * 2) / chip.length,
        )
      : 1;
  const scale = Math.max(1e-6, fit * view.zoom);

  // Chip space is y-up; the screen is y-down.
  const px = (x: number) => size.width / 2 + (x - view.cx) * scale;
  const py = (y: number) => size.height / 2 - (y - view.cy) * scale;
  const toChip = (sx: number, sy: number) => ({
    x: view.cx + (sx - size.width / 2) / scale,
    y: view.cy - (sy - size.height / 2) / scale,
  });

  const zoomBy = (factor: number, at?: { x: number; y: number }) =>
    setView((current) => {
      const zoom = Math.min(MAX_ZOOM, Math.max(1, current.zoom * factor));
      if (zoom === 1) return { zoom, cx: chip.width / 2, cy: chip.length / 2 };
      if (!at) return { ...current, zoom };
      // Keep the chip point under the cursor where it is.
      const k = current.zoom / zoom;
      return { zoom, cx: at.x + (current.cx - at.x) * k, cy: at.y + (current.cy - at.y) * k };
    });

  // React registers wheel listeners as passive, which cannot stop the sidebar
  // scrolling underneath the zoom. A native listener can.
  const wheel = useRef<(event: WheelEvent) => void>(() => {});
  wheel.current = (event) => {
    event.preventDefault();
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    zoomBy(Math.exp(-event.deltaY * 0.0025), toChip(event.clientX - rect.left, event.clientY - rect.top));
  };
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const listener = (event: WheelEvent) => wheel.current(event);
    element.addEventListener('wheel', listener, { passive: false });
    return () => element.removeEventListener('wheel', listener);
  }, [ref]);

  const local = (event: ReactPointerEvent) => {
    const rect = ref.current?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  };

  const moveSlice = (event: ReactPointerEvent) => {
    const point = local(event);
    const chipPoint = toChip(point.x, point.y);
    onPosition(axis === 'x' ? chipPoint.x : chipPoint.y);
  };

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const onSlice = (event.target as Element).closest('[data-slice]') !== null;
    if (onSlice) {
      drag.current = { kind: 'slice' };
      moveSlice(event);
    } else {
      drag.current = { kind: 'pan', x: event.clientX, y: event.clientY, cx: view.cx, cy: view.cy };
    }
  };

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const active = drag.current;
    if (!active) return;
    if (active.kind === 'slice') {
      moveSlice(event);
      return;
    }
    setView((current) => ({
      ...current,
      cx: active.cx - (event.clientX - active.x) / scale,
      cy: active.cy + (event.clientY - active.y) / scale,
    }));
  };

  const endDrag = () => {
    drag.current = null;
  };

  const polygon = (points: { x: number; y: number }[]) =>
    points.map((p) => `${px(p.x).toFixed(2)},${py(p.y).toFixed(2)}`).join(' ');

  const changedEdges = model.edges.filter((e) => e.changed);
  const changedCircles = model.circles.filter((c) => c.changed);
  const ports = model.circles.filter((c) => c.kind === 'port');
  const drawn = model.circles.filter((c) => c.kind !== 'port');

  const sliceX = axis === 'x' ? px(position) : null;
  const sliceY = axis === 'y' ? py(position) : null;

  return (
    <div
      ref={ref}
      className={cn(
        'relative touch-none select-none overflow-hidden rounded-lg border border-line bg-sunken',
        className,
      )}
    >
      {size.width > 0 ? (
        <svg
          width={size.width}
          height={size.height}
          role="img"
          aria-label="Top view of the chip: the compensated design over the design as drawn"
          className="block cursor-grab active:cursor-grabbing"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <Patterns id={id} />

          {/* The block: solid material. Channels are cut out of it below. */}
          <rect
            x={px(0)}
            y={py(chip.length)}
            width={chip.width * scale}
            height={chip.length * scale}
            fill="var(--panel)"
            stroke="var(--line-strong)"
          />

          {/* Compensated outlines. Stroke first, then an opaque fill over the
              inner half of it, so where two segments meet their butt ends are
              hidden and only the outer boundary of the network shows. */}
          {changedEdges.map((edge) => (
            <polygon
              key={`cs-${edge.id}`}
              points={polygon(edge.compensated)}
              fill="none"
              stroke={edge.conflict ? 'var(--danger)' : 'var(--accent)'}
              strokeWidth={edge.conflict ? 5 : 3.5}
              strokeLinejoin="round"
            />
          ))}
          {changedCircles.map((circle) => (
            <circle
              key={`cs-${circle.id}`}
              cx={px(circle.x)}
              cy={py(circle.y)}
              r={circle.compensatedRadiusMm * scale}
              fill="none"
              stroke={circle.conflict ? 'var(--danger)' : 'var(--accent)'}
              strokeWidth={circle.conflict ? 5 : 3.5}
            />
          ))}
          {changedEdges.map((edge) => (
            <polygon key={`cm-${edge.id}`} points={polygon(edge.compensated)} fill="var(--canvas)" />
          ))}
          {changedCircles.map((circle) => (
            <circle
              key={`cm-${circle.id}`}
              cx={px(circle.x)}
              cy={py(circle.y)}
              r={circle.compensatedRadiusMm * scale}
              fill="var(--canvas)"
            />
          ))}
          {changedEdges.map((edge) => (
            <polygon
              key={`ch-${edge.id}`}
              points={polygon(edge.compensated)}
              fill={`url(#${id}-${edge.conflict ? 'conflict' : 'removed'})`}
            />
          ))}
          {changedCircles.map((circle) => (
            <circle
              key={`ch-${circle.id}`}
              cx={px(circle.x)}
              cy={py(circle.y)}
              r={circle.compensatedRadiusMm * scale}
              fill={`url(#${id}-${circle.conflict ? 'conflict' : 'removed'})`}
            />
          ))}

          {/* The design as drawn, on top: same stroke-then-mask order, so the
              hatching survives only between the two outlines. */}
          {model.edges.map((edge) => (
            <polygon
              key={`ns-${edge.id}`}
              points={polygon(edge.nominal)}
              fill="none"
              stroke={edge.changed ? 'var(--ink-muted)' : 'var(--ink-quiet)'}
              strokeWidth={2}
              strokeDasharray={edge.changed ? '4 3' : undefined}
              strokeLinejoin="round"
            />
          ))}
          {drawn.map((circle) => (
            <circle
              key={`ns-${circle.id}`}
              cx={px(circle.x)}
              cy={py(circle.y)}
              r={circle.nominalRadiusMm * scale}
              fill="none"
              stroke={circle.changed ? 'var(--ink-muted)' : 'var(--ink-quiet)'}
              strokeWidth={2}
              strokeDasharray={circle.changed ? '4 3' : undefined}
            />
          ))}
          {model.edges.map((edge) => (
            <polygon key={`nm-${edge.id}`} points={polygon(edge.nominal)} fill="var(--canvas)" />
          ))}
          {drawn.map((circle) => (
            <circle
              key={`nm-${circle.id}`}
              cx={px(circle.x)}
              cy={py(circle.y)}
              r={circle.nominalRadiusMm * scale}
              fill="var(--canvas)"
            />
          ))}
          {/* One group opacity, so overlapping segments do not darken twice. */}
          <g opacity={0.14}>
            {model.edges.map((edge) => (
              <polygon key={`ng-${edge.id}`} points={polygon(edge.nominal)} fill="var(--ink)" />
            ))}
            {drawn.map((circle) => (
              <circle
                key={`ng-${circle.id}`}
                cx={px(circle.x)}
                cy={py(circle.y)}
                r={circle.nominalRadiusMm * scale}
                fill="var(--ink)"
              />
            ))}
          </g>

          {/* Ports are not compensated: a thin neutral ring, nothing more. */}
          {ports.map((circle) => (
            <circle
              key={circle.id}
              cx={px(circle.x)}
              cy={py(circle.y)}
              r={Math.max(1.5, circle.nominalRadiusMm * scale)}
              fill="none"
              stroke="var(--ink-quiet)"
              strokeWidth={1}
            />
          ))}

          {/* The channel under the pointer in the cross-section strip. */}
          {model.edges
            .filter((edge) => edge.id === hover?.edgeId)
            .map((edge) => (
              <polygon
                key={`hover-${edge.id}`}
                points={polygon(edge.compensated)}
                fill="none"
                stroke="var(--ink)"
                strokeWidth={1.5}
              />
            ))}

          {model.conflictMarks.map((mark) => (
            <g key={mark.id} transform={`translate(${px(mark.x)} ${py(mark.y)})`}>
              <path
                d="M0 -8L8 0L0 8L-8 0Z"
                fill="var(--panel)"
                stroke="var(--danger)"
                strokeWidth={2}
              />
              <path d="M0 -3.5V1" stroke="var(--danger)" strokeWidth={2} strokeLinecap="round" />
              <circle cx={0} cy={3.6} r={1.1} fill="var(--danger)" />
            </g>
          ))}

          {/* The slice line: a visible rule, a grip, and a wide invisible
              stroke so it can be grabbed without pixel-hunting. */}
          <g data-slice style={{ cursor: axis === 'x' ? 'ew-resize' : 'ns-resize' }}>
            <line
              x1={sliceX ?? 0}
              y1={sliceY ?? 0}
              x2={sliceX ?? size.width}
              y2={sliceY ?? size.height}
              stroke="transparent"
              strokeWidth={16}
            />
            <line
              x1={sliceX ?? 0}
              y1={sliceY ?? 0}
              x2={sliceX ?? size.width}
              y2={sliceY ?? size.height}
              stroke="var(--ink)"
              strokeWidth={1}
              strokeDasharray="8 3 2 3"
            />
            <rect
              x={(sliceX ?? 12) - (axis === 'x' ? 7 : 0)}
              y={(sliceY ?? 12) - (axis === 'y' ? 7 : 0)}
              width={axis === 'x' ? 14 : 22}
              height={axis === 'x' ? 22 : 14}
              rx={4}
              fill="var(--ink)"
            />
            <path
              d={axis === 'x' ? 'M-2 -4V4M2 -4V4' : 'M-4 -2H4M-4 2H4'}
              transform={`translate(${sliceX ?? 23} ${sliceY ?? 23})`}
              stroke="var(--panel)"
              strokeWidth={1.25}
              strokeLinecap="round"
            />
          </g>
        </svg>
      ) : null}

      <div className="absolute bottom-1.5 right-1.5 flex items-center gap-0.5 rounded-md border border-line bg-panel/90 p-0.5 backdrop-blur-sm">
        <ViewButton label="Zoom out" onClick={() => zoomBy(1 / 1.6)}>
          <Minus size={13} />
        </ViewButton>
        <span className="w-9 text-center font-mono text-[10px] text-ink-muted">
          {view.zoom < 10 ? view.zoom.toFixed(1) : Math.round(view.zoom)}×
        </span>
        <ViewButton label="Zoom in" onClick={() => zoomBy(1.6)}>
          <Plus size={13} />
        </ViewButton>
        <ViewButton
          label="Fit the chip in view"
          onClick={() => setView({ zoom: 1, cx: chip.width / 2, cy: chip.length / 2 })}
        >
          <Scan size={13} />
        </ViewButton>
      </div>

      {view.zoom === 1 ? (
        <p className="pointer-events-none absolute left-2 top-1.5 text-[10px] text-ink-quiet">
          Scroll to zoom · drag to pan
        </p>
      ) : null}
    </div>
  );
}

function ViewButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="oc-pressable rounded p-1 text-ink-muted hover:bg-sunken hover:text-ink"
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// cross-sections
// ---------------------------------------------------------------------------

const MAX_SECTIONS_SMALL = 6;
const MAX_SECTIONS_LARGE = 24;

function Sections({
  sections,
  axis,
  large,
  hover,
  onHover,
  chipTopZ,
}: {
  sections: DfmSection[];
  axis: SliceAxis;
  large: boolean;
  hover: Hover;
  onHover: (hover: Hover) => void;
  chipTopZ: number;
}) {
  if (sections.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-[11px] text-ink-muted">
        The slice line does not cross a channel here. Drag it onto one.
      </p>
    );
  }

  const limit = large ? MAX_SECTIONS_LARGE : MAX_SECTIONS_SMALL;
  const shown = sections.slice(0, limit);
  const along = axis === 'x' ? 'y' : 'x';

  return (
    <div className="flex flex-col gap-1.5">
      <ul className="grid grid-cols-2 gap-1.5">
        {shown.map((section, index) => (
          <li
            key={`${section.edgeId}-${index}`}
            onPointerEnter={() => onHover({ edgeId: section.edgeId })}
            onPointerLeave={() => onHover(null)}
            className={cn(
              'rounded-lg border bg-elevated p-1.5',
              hover?.edgeId === section.edgeId ? 'border-line-strong' : 'border-line',
            )}
          >
            <SectionCell section={section} chipTopZ={chipTopZ} />
            <p className="mt-1 font-mono text-[10px] leading-snug text-ink-muted">
              {along} = {mm(section.alongMm, 2)}
              {section.conflict ? <span className="ml-1 font-sans font-medium text-danger">conflict</span> : null}
            </p>
            <p className="font-mono text-[10px] leading-snug text-ink">
              w {mm(section.nominal.widthMm)} → {mm(section.compensated.widthMm)}
            </p>
            <p className="font-mono text-[10px] leading-snug text-ink">
              h {mm(section.nominal.heightMm)} → {mm(section.compensated.heightMm)}
            </p>
            {section.obliqueStretch > 1.02 ? (
              <p className="text-[10px] leading-snug text-ink-quiet">
                cut at an angle, drawn {section.obliqueStretch.toFixed(2)}× wide
              </p>
            ) : null}
          </li>
        ))}
      </ul>
      {sections.length > shown.length ? (
        <p className="text-[11px] text-ink-muted">
          +{sections.length - shown.length} more on this line
          {large ? '' : ' — open the preview full size to see them'}.
        </p>
      ) : null}
    </div>
  );
}

const CELL = { width: 116, height: 78, pad: 9 };

/** One channel profile, scaled to fill its cell. */
function SectionCell({ section, chipTopZ }: { section: DfmSection; chipTopZ: number }) {
  const id = useId();
  const all = [...section.nominal.points, ...section.compensated.points];
  const sMin = Math.min(...all.map((p) => p.s));
  const sMax = Math.max(...all.map((p) => p.s));
  const zMin = Math.min(...all.map((p) => p.z));
  const zMax = Math.max(...all.map((p) => p.z));

  const scale = Math.min(
    (CELL.width - CELL.pad * 2) / Math.max(sMax - sMin, 1e-6),
    (CELL.height - CELL.pad * 2) / Math.max(zMax - zMin, 1e-6),
  );
  const x = (s: number) => CELL.width / 2 + (s - (sMin + sMax) / 2) * scale;
  const y = (z: number) => CELL.height / 2 - (z - (zMin + zMax) / 2) * scale;
  const polygon = (points: { s: number; z: number }[]) =>
    points.map((p) => `${x(p.s).toFixed(2)},${y(p.z).toFixed(2)}`).join(' ');

  const changed =
    section.compensated.widthMm !== section.nominal.widthMm ||
    section.compensated.ceilingZ !== section.nominal.ceilingZ;
  const tone = section.conflict ? 'var(--danger)' : 'var(--accent)';
  const topY = y(chipTopZ);
  // A 0.1 mm scale bar, when it fits, so the cell is not a shape without a size.
  const barPx = 0.1 * scale;

  return (
    <svg
      width="100%"
      viewBox={`0 0 ${CELL.width} ${CELL.height}`}
      role="img"
      aria-label={
        `Channel cross-section: ${mm(section.nominal.widthMm)} by ${mm(section.nominal.heightMm)} mm as drawn, ` +
        `${mm(section.compensated.widthMm)} by ${mm(section.compensated.heightMm)} mm compensated`
      }
      className="block rounded bg-sunken"
    >
      <Patterns id={id} />
      {/* The top face of the chip, when the roof is thin enough to be in frame. */}
      {topY > 1 && topY < CELL.height - 1 ? (
        <>
          <rect x={0} y={0} width={CELL.width} height={topY} fill="var(--canvas)" />
          <line x1={0} y1={topY} x2={CELL.width} y2={topY} stroke="var(--line-strong)" />
        </>
      ) : null}

      {changed ? (
        <>
          <polygon points={polygon(section.compensated.points)} fill="var(--canvas)" />
          <polygon
            points={polygon(section.compensated.points)}
            fill={`url(#${id}-${section.conflict ? 'conflict' : 'removed'})`}
            stroke={tone}
            strokeWidth={section.conflict ? 2.5 : 1.75}
            strokeLinejoin="round"
          />
        </>
      ) : null}

      <polygon points={polygon(section.nominal.points)} fill="var(--canvas)" />
      <polygon
        points={polygon(section.nominal.points)}
        fill="var(--ink)"
        fillOpacity={0.14}
        stroke={changed ? 'var(--ink-muted)' : 'var(--ink-quiet)'}
        strokeWidth={1}
        strokeDasharray={changed ? '4 3' : undefined}
        strokeLinejoin="round"
      />

      {barPx > 6 && barPx < CELL.width / 2 ? (
        <g transform={`translate(${CELL.width - 5 - barPx} ${CELL.height - 4})`}>
          <path d={`M0 0H${barPx}M0 -2V2M${barPx} -2V2`} stroke="var(--ink-quiet)" strokeWidth={1} />
          <text
            x={barPx / 2}
            y={-3}
            textAnchor="middle"
            fontSize="7"
            fill="var(--ink-quiet)"
            fontFamily="var(--font-numeric)"
          >
            0.1
          </text>
        </g>
      ) : null}
    </svg>
  );
}
