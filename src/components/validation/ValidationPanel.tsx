import {
  AlertTriangle,
  Box,
  CheckCircle2,
  ChevronDown,
  Droplets,
  Info,
  PenLine,
  ShieldAlert,
  SlidersHorizontal,
} from 'lucide-react';
import { useDeferredValue, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { cn } from '../../lib/cn';
import { edgesWithinNodes } from '../../lib/hitTest';
import {
  enclosureState,
  liveVents,
  planDrainage,
  ventsForPoints,
  SEVERITY_LABEL,
  type Severity,
  type Warning,
} from '../../lib/validation';
import { useValidation } from '../../hooks/useValidation';
import { contextHelpUrl, warningHelpUrl } from '../../lib/wikiLinks';
import { useEditorStore } from '../../store/editorStore';
import { useProjectStore } from '../../store/projectStore';
import { useValidationStore } from '../../store/validationStore';
import { Button } from '../ui/Button';
import { Field, NumberInput } from '../ui/Field';

const SEVERITY_STYLE: Record<Severity, { icon: typeof Info; chip: string; dot: string }> = {
  risk: { icon: ShieldAlert, chip: 'bg-danger-wash text-danger border-danger/40', dot: 'bg-danger' },
  caution: {
    icon: AlertTriangle,
    chip: 'bg-caution-wash text-caution border-caution/40',
    dot: 'bg-caution',
  },
  info: { icon: Info, chip: 'bg-sunken text-ink-muted border-line', dot: 'bg-ink-faint' },
};

/**
 * The warnings panel.
 *
 * Docked to the bottom of both the Draw and CAD views so the same list is
 * available wherever the user is working, and so clicking a warning can jump
 * between them.
 *
 * Nothing in here disables anything. It has no relationship to the export
 * buttons at all — warnings never block an export, and the cheapest way to keep
 * it true is for this component to have no way to express "blocked".
 */
export function ValidationPanel() {
  const { warnings, counts } = useValidation();
  const open = useValidationStore((s) => s.panelOpen);
  const togglePanel = useValidationStore((s) => s.togglePanel);

  const total = warnings.length;

  return (
    <section
      className={cn(
        'flex shrink-0 flex-col border-t border-line bg-panel',
        open ? 'h-[19rem]' : 'h-auto',
      )}
      aria-label="Design checks"
      data-tour="warnings"
    >
      <button
        type="button"
        onClick={togglePanel}
        aria-expanded={open}
        className="oc-pressable flex h-9 shrink-0 items-center gap-2 px-3 text-left"
      >
        <ChevronDown
          size={14}
          className={cn('text-ink-faint transition-transform duration-200', open && 'rotate-180')}
        />
        <span className="text-[12px] font-medium text-ink">Design checks</span>

        {total === 0 ? (
          <span className="flex items-center gap-1.5 text-[11px] text-success">
            <CheckCircle2 size={12} />
            nothing flagged
          </span>
        ) : (
          <span className="flex items-center gap-1.5">
            {(['risk', 'caution', 'info'] as Severity[])
              .filter((s) => counts[s] > 0)
              .map((severity) => (
                <span
                  key={severity}
                  className={cn(
                    'rounded-full border px-1.5 py-0.5 font-mono text-[10px]',
                    SEVERITY_STYLE[severity].chip,
                  )}
                >
                  {counts[severity]} {SEVERITY_LABEL[severity].toLowerCase()}
                </span>
              ))}
          </span>
        )}

        <span className="ml-auto text-[11px] text-ink-quiet">
          {/* Said out loud, because a scientist who sees red needs to know it is
              advisory before they start second-guessing their design. */}
          advisory only — nothing here blocks an export
        </span>
      </button>


      {open ? (
        <div className="flex min-h-0 flex-1 overflow-hidden border-t border-line">
          <div className="min-w-0 flex-1 overflow-y-auto">
            {total === 0 ? <AllClear /> : <WarningList warnings={warnings} />}
          </div>
          <ChecksSidebar />
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------

function AllClear() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <CheckCircle2 size={22} className="text-success" />
      <p className="text-[13px] font-medium text-ink">Nothing flagged</p>
      <p className="max-w-sm text-[12px] leading-relaxed text-ink-muted">
        No printability or flow problems found against the current printer profile. These checks are
        geometric rules of thumb, not a guarantee — a test print is still the real test.
      </p>
    </div>
  );
}

function WarningList({ warnings }: { warnings: Warning[] }) {
  const focusedId = useValidationStore((s) => s.focusedId);

  return (
    <ul className="flex flex-col">
      {warnings.map((warning) => (
        <WarningRow key={warning.id} warning={warning} active={focusedId === warning.id} />
      ))}
    </ul>
  );
}

function WarningRow({ warning, active }: { warning: Warning; active: boolean }) {
  const focus = useValidationStore((s) => s.focus);
  const setSelection = useEditorStore((s) => s.setSelection);
  const graph = useProjectStore((s) => s.project.channelGraph);
  const setView = useEditorStore((s) => s.setView);
  const navigate = useNavigate();
  const location = useLocation();

  const style = SEVERITY_STYLE[warning.severity];
  const Icon = style.icon;

  /**
   * Clicking selects the offending elements and centers them.
   *
   * Both views read from the same two places — the editor selection and the
   * focused warning — so one click lights the element up in whichever view is
   * on screen, and in the other one when the user switches.
   */
  const reveal = () => {
    focus(warning);

    const nodeIds = warning.target.nodeIds;
    const edgeIds =
      warning.target.edgeIds.length > 0
        ? warning.target.edgeIds
        : edgesWithinNodes(graph, nodeIds);
    if (nodeIds.length > 0 || edgeIds.length > 0) setSelection({ nodeIds, edgeIds });

    if (warning.target.focus) setView({ center: warning.target.focus });
  };

  const jumpTo = (path: string) => {
    reveal();
    navigate(path);
  };

  const onDraw = location.pathname.startsWith('/draw');

  return (
    <li>
      <div
        className={cn(
          'flex gap-3 border-b border-line px-3 py-2.5 transition-colors',
          active ? 'bg-accent-wash' : 'hover:bg-sunken',
        )}
      >
        <button
          type="button"
          onClick={reveal}
          className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
        >
          <Icon
            size={14}
            className={cn(
              'mt-0.5 shrink-0',
              warning.severity === 'risk'
                ? 'text-danger'
                : warning.severity === 'caution'
                  ? 'text-caution'
                  : 'text-ink-faint',
            )}
          />
          <span className="min-w-0">
            <span className="block text-[12px] font-medium text-ink">{warning.title}</span>
            <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-muted">
              {warning.detail}
            </span>
            {warning.measurement ? (
              <span className="mt-1 inline-block font-mono text-[10px] text-ink-quiet">
                {round(warning.measurement.value)} {warning.measurement.unit} · limit{' '}
                {round(warning.measurement.limit)} {warning.measurement.unit}
              </span>
            ) : null}
          </span>
        </button>

        {/* The explanation, one click away.
            A researcher who reads "Only 0.3 mm of wall between two channels"
            should not have to go and search a documentation site for why that
            matters. Deliberately a quiet inline link rather than a button: this
            row is scanned dozens of times a session, and anything that draws the
            eye here is a tax rather than an affordance. */}
        <a
          href={warningHelpUrl(warning.kind)}
          target="_blank"
          rel="noopener"
          onClick={(event) => event.stopPropagation()}
          className="mt-0.5 shrink-0 self-start text-[11px] whitespace-nowrap text-accent underline decoration-accent/35 underline-offset-2 transition-colors hover:decoration-accent"
        >
          Learn more
        </a>

        {warning.target.nodeIds.length > 0 || warning.target.edgeIds.length > 0 ? (
          <div className="flex shrink-0 items-start gap-1 pt-0.5">
            <JumpButton
              label="Show in 2D"
              icon={<PenLine size={12} />}
              muted={onDraw}
              onClick={() => jumpTo('/draw')}
            />
            <JumpButton
              label="Show in 3D"
              icon={<Box size={12} />}
              muted={!onDraw}
              onClick={() => jumpTo('/cad')}
            />
          </div>
        ) : null}
      </div>
    </li>
  );
}

function JumpButton({
  label,
  icon,
  muted,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  muted: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className={cn(
        'oc-pressable rounded-md border border-line px-1.5 py-1',
        muted ? 'text-ink-faint hover:text-ink' : 'text-accent',
      )}
    >
      {icon}
    </button>
  );
}

const round = (n: number) => (Number.isFinite(n) ? Math.round(n * 1000) / 1000 : '∞');

// ---------------------------------------------------------------------------

/** Thresholds, plus the drainage helper. */
function ChecksSidebar() {
  const settings = useValidationStore((s) => s.settings);
  const setSettings = useValidationStore((s) => s.setSettings);

  return (
    <div className="w-[16rem] shrink-0 space-y-3.5 overflow-y-auto border-l border-line px-3.5 py-3">
      <DrainageHelper />

      <div className="flex items-center gap-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wider text-ink-quiet">
        <SlidersHorizontal size={11} />
        Thresholds
      </div>

      {/* Change these when you have *measured* something better, not to quiet a
          warning. The wiki says so at more length. */}
      <p className="text-[11px] leading-relaxed text-ink-muted">
        Yours to change, and worth changing once you have measured your own resin.{' '}
        <a
          href={contextHelpUrl('designChecks')}
          target="_blank"
          rel="noopener"
          className="text-accent underline decoration-accent/35 underline-offset-2 transition-colors hover:decoration-accent"
        >
          How to read these checks
        </a>
      </p>

      <Field
        label="Taper ratio"
        htmlFor="check-taper"
        hint="Width change between adjacent dimension markers that counts as abrupt."
      >
        <NumberInput
          id="check-taper"
          value={settings.taperRatioThreshold}
          onChange={(taperRatioThreshold) => setSettings({ taperRatioThreshold })}
          unit="×"
          min={1.1}
          step={0.25}
          precision={2}
        />
      </Field>

      <Field
        label="Minimum printable wall"
        htmlFor="check-wall"
        hint="Thinnest wall between two channels your resin will hold without merging them."
      >
        <NumberInput
          id="check-wall"
          value={settings.minPrintableWallMm}
          onChange={(minPrintableWallMm) => setSettings({ minPrintableWallMm })}
          unit="mm"
          min={0.05}
          step={0.05}
          precision={3}
        />
      </Field>

      <Field
        label="Overhang limit"
        htmlFor="check-overhang"
        hint="Angle from vertical past which a port socket roof needs support."
      >
        <NumberInput
          id="check-overhang"
          value={settings.overhangLimitDeg}
          onChange={(overhangLimitDeg) => setSettings({ overhangLimitDeg })}
          unit="°"
          min={5}
          max={89}
          step={5}
          precision={0}
        />
      </Field>
    </div>
  );
}

/**
 * One-click drainage holes.
 *
 * Only offered when the chip is actually sealed — on a two-piece chip the
 * channels are open at the split plane and vents would be holes for no reason.
 */
function DrainageHelper() {
  const graph = useProjectStore((s) => s.project.channelGraph);
  const chipParams = useProjectStore((s) => s.project.chipParams);
  const allVents = useProjectStore((s) => s.project.drainageVents);
  const updateProject = useProjectStore((s) => s.setDrainageVents);
  // Planning is up to a dozen Dijkstra passes. Deferring the graph lets a drag
  // frame paint before the plan catches up, as the warnings list already does.
  const deferredGraph = useDeferredValue(graph);
  // Vents on deleted nodes drill nothing, so they neither count as openings
  // nor keep this panel open.
  const vents = useMemo(() => liveVents(deferredGraph, allVents), [deferredGraph, allVents]);

  const { enclosed } = enclosureState(chipParams);
  const plan = useMemo(
    () => (enclosed ? planDrainage(deferredGraph, vents) : []),
    [enclosed, deferredGraph, vents],
  );

  if (!enclosed && vents.length === 0) return null;

  return (
    <div className="rounded-lg border border-line bg-sunken p-3">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-quiet">
        <Droplets size={11} />
        Drainage
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-ink-muted">
        {enclosed
          ? 'Sealed channels hold uncured resin. Vents give it a way out — placed where resin has furthest to travel to reach an opening.'
          : 'The channels are open at the split plane, so vents are not needed. The ones you have will still be drilled.'}
      </p>

      <div className="mt-2.5 flex flex-col gap-1.5">
        <Button
          size="sm"
          variant={plan.length > 0 ? 'primary' : 'secondary'}
          icon={<Droplets size={13} />}
          disabled={plan.length === 0}
          onClick={() => {
            const added = ventsForPoints(plan);
            updateProject([...allVents, ...added]);
            toast.success(
              `Added ${added.length} drainage hole${added.length === 1 ? '' : 's'}`,
              { description: 'The 3D model has been re-cut to include them.' },
            );
          }}
        >
          {plan.length > 0 ? `Add ${plan.length} drainage hole${plan.length === 1 ? '' : 's'}` : 'Nothing to drain'}
        </Button>

        {vents.length > 0 ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              updateProject([]);
              toast('Drainage holes removed');
            }}
          >
            Remove {vents.length} vent{vents.length === 1 ? '' : 's'}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
