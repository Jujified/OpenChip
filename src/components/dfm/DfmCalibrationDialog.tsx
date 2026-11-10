import { AlertTriangle, Download, FileSpreadsheet, FolderOpen, Upload } from 'lucide-react';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { cn } from '../../lib/cn';
import { downloadBlob } from '../../lib/download';
import {
  COUPON_VERSION,
  blankMeasurements,
  buildCouponProject,
  couponLayout,
  defaultCouponSpec,
  measurementSheetCsv,
  normaliseCouponSpec,
  parseMeasurementSheet,
  type CouponSpec,
} from '../../lib/dfm/coupon';
import { fitCompensation, predictedClosureWidthMm } from '../../lib/dfm/fit';
import {
  DFM_MODEL_ID,
  DFM_PROFILE_EXTENSION,
  DFM_PROFILE_KIND,
  DFM_PROFILE_MIME,
  DFM_SCHEMA_VERSION,
  dfmProfileFileName,
  parseDfmProfile,
  serializeDfmProfile,
  type AxisFit,
  type ChannelResult,
  type CouponMeasurement,
  type DfmProfile,
} from '../../lib/dfm/profile';
import { OPENCHIP_MIME, serializeProject, stampForSave } from '../../lib/projectFile';
import { useDfmStore } from '../../store/dfmStore';
import { useProjectStore } from '../../store/projectStore';
import { useUiStore } from '../../store/uiStore';
import type { PrinterProfile } from '../../types/project';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Field, NumberInput, TextInput } from '../ui/Field';
import { WikiLink } from '../ui/WikiLink';

type Step = 'coupon' | 'results' | 'profile';

const STEPS: { id: Step; label: string }[] = [
  { id: 'coupon', label: '1 · Print the coupon' },
  { id: 'results', label: '2 · Enter results' },
  { id: 'profile', label: '3 · Save the profile' },
];

const mm = (value: number, places = 3): string => String(Number(value.toFixed(places)));
const listText = (values: number[]): string => values.join(', ');
const parseList = (text: string): number[] =>
  text
    .split(/[,;\s]+/)
    .map((part) => Number(part))
    .filter((value) => Number.isFinite(value) && value > 0);

/**
 * Calibrating a printer: generate a coupon, record what came off the plate, and
 * save the fit as a profile.
 *
 * Opened on purpose from the print-correction menu and never offered
 * unprompted. Nothing here touches the open project except the explicit "Open
 * the coupon in the editor" button, which asks first if there is unsaved work.
 */
export function DfmCalibrationDialog() {
  const open = useDfmStore((s) => s.calibrationOpen);
  const setOpen = useDfmStore((s) => s.setCalibrationOpen);

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Calibrate print correction"
      description={
        <>
          Print a test coupon, record which channels came out open, and save the result as a
          profile for this printer and resin.{' '}
          <WikiLink to="printCorrection">The full walkthrough</WikiLink>
        </>
      }
      className="w-[min(calc(100vw-2rem),46rem)]"
    >
      {/* Mounted only while open, so each calibration starts from the current
          printer profile rather than from whatever the last one left behind. */}
      {open ? <Calibration onDone={() => setOpen(false)} /> : null}
    </Dialog>
  );
}

function Calibration({ onDone }: { onDone: () => void }) {
  const printer = useProjectStore((s) => s.project.printerProfile);
  const [step, setStep] = useState<Step>('coupon');
  const [spec, setSpec] = useState<CouponSpec>(() => defaultCouponSpec(printer));
  const [measurements, setMeasurements] = useState<CouponMeasurement[]>(() =>
    blankMeasurements(couponLayout(defaultCouponSpec(printer))),
  );

  /** A new coupon is a new set of channels; results for the old one mean nothing. */
  const changeSpec = (next: CouponSpec) => {
    const clean = normaliseCouponSpec(next);
    setSpec(clean);
    setMeasurements(blankMeasurements(couponLayout(clean)));
  };

  return (
    <div className="flex flex-col gap-5 pb-5">
      <div className="flex gap-0.5 rounded-lg bg-sunken p-0.5">
        {STEPS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setStep(item.id)}
            aria-current={step === item.id ? 'step' : undefined}
            className={cn(
              'oc-pressable flex-1 rounded-[6px] px-3 py-1.5 text-[13px] font-medium',
              step === item.id ? 'bg-panel text-ink shadow-sm' : 'text-ink-muted hover:text-ink',
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      {step === 'coupon' ? (
        <CouponStep
          spec={spec}
          onSpec={changeSpec}
          printer={printer}
          measurements={measurements}
          onNext={() => setStep('results')}
          onDone={onDone}
        />
      ) : null}
      {step === 'results' ? (
        <ResultsStep
          measurements={measurements}
          onMeasurements={setMeasurements}
          onNext={() => setStep('profile')}
        />
      ) : null}
      {step === 'profile' ? (
        <ProfileStep
          spec={spec}
          measurements={measurements}
          printer={printer}
          onDone={onDone}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1 · coupon
// ---------------------------------------------------------------------------

function CouponStep({
  spec,
  onSpec,
  printer,
  measurements,
  onNext,
  onDone,
}: {
  spec: CouponSpec;
  onSpec: (spec: CouponSpec) => void;
  printer: PrinterProfile;
  measurements: CouponMeasurement[];
  onNext: () => void;
  onDone: () => void;
}) {
  const [advanced, setAdvanced] = useState(false);
  const loadProject = useProjectStore((s) => s.loadProject);
  const requestConfirm = useUiStore((s) => s.requestConfirm);
  const layout = useMemo(() => couponLayout(spec), [spec]);

  const fits =
    layout.chip.width <= printer.buildVolumeMm.x && layout.chip.length <= printer.buildVolumeMm.y;

  const downloadCoupon = () => {
    const { project } = buildCouponProject(spec, printer);
    const name = `dfm-coupon-v${COUPON_VERSION}.openchip`;
    downloadBlob(serializeProject(stampForSave(project)), name, `${OPENCHIP_MIME};charset=utf-8`);
    toast.success(`Downloaded ${name}`, {
      description: 'Open it like any project, then export its STL from the CAD tab with print correction set to None.',
    });
  };

  const downloadSheet = () => {
    const name = `dfm-coupon-v${COUPON_VERSION}-sheet.csv`;
    downloadBlob(measurementSheetCsv(measurements), name, 'text/csv;charset=utf-8');
    toast.success(`Downloaded ${name}`);
  };

  const openInEditor = async () => {
    const { isDirty, project: current } = useProjectStore.getState();
    if (isDirty) {
      const confirmed = await requestConfirm({
        title: 'Discard unsaved changes?',
        message: `“${current.meta.name}” has changes that haven't been saved to a file. Opening the coupon will discard them.`,
        confirmLabel: 'Discard and continue',
        destructive: true,
      });
      if (!confirmed) return;
    }
    // Exporting the coupon itself with a profile applied would calibrate
    // against a correction, so the selection is cleared along with it.
    useDfmStore.getState().select(null);
    loadProject(buildCouponProject(spec, printer).project, null);
    onDone();
    toast.success('The coupon is open', {
      description: 'Export its STL from the CAD tab. Come back to Calibrate a printer… with the results.',
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] leading-relaxed text-ink">
        The coupon is a strip of straight channels, one for each width and height below. Every
        channel runs out through both long edges, so you can flush it and hold it up to a light.
      </p>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg border border-line bg-panel px-3 py-2.5 font-mono text-[12px]">
        <dt className="text-ink-muted">widths</dt>
        <dd className="text-ink">{listText(spec.widthsMm)} mm</dd>
        <dt className="text-ink-muted">heights</dt>
        <dd className="text-ink">{listText(spec.heightsMm)} mm</dd>
        <dt className="text-ink-muted">channels</dt>
        <dd className="text-ink">
          {layout.channels.length} ({spec.widthsMm.length} × {spec.heightsMm.length})
        </dd>
        <dt className="text-ink-muted">strip</dt>
        <dd className="text-ink">
          {mm(layout.chip.width, 2)} × {mm(layout.chip.length, 2)} × {mm(layout.chip.baseThickness, 2)} mm,
          monolithic
        </dd>
      </dl>

      {!fits ? (
        <Caution>
          This strip is larger than the {printer.buildVolumeMm.x} × {printer.buildVolumeMm.y} mm build
          plate in the printer profile. Remove some widths or heights under Advanced.
        </Caution>
      ) : null}

      <div>
        <button
          type="button"
          className="oc-pressable rounded px-1.5 py-0.5 text-[12px] text-accent hover:bg-accent-wash"
          onClick={() => setAdvanced((v) => !v)}
        >
          {advanced ? 'Hide advanced' : 'Advanced: choose the sizes'}
        </button>
      </div>

      {advanced ? (
        <div className="flex flex-col gap-3.5 rounded-lg border border-line p-3">
          <Field
            label="Channel widths"
            htmlFor="coupon-widths"
            hint="Millimetres, separated by commas. Include some you expect to close and some you expect to stay open."
          >
            <ListInput id="coupon-widths" values={spec.widthsMm} onChange={(widthsMm) => onSpec({ ...spec, widthsMm })} />
          </Field>
          <Field
            label="Channel heights"
            htmlFor="coupon-heights"
            hint="One group per height, up to six. Use whole multiples of your layer height."
          >
            <ListInput id="coupon-heights" values={spec.heightsMm} onChange={(heightsMm) => onSpec({ ...spec, heightsMm })} />
          </Field>
          <div className="grid grid-cols-3 gap-2.5">
            <Field label="Channel length" htmlFor="coupon-length">
              <NumberInput id="coupon-length" value={spec.channelLengthMm} unit="mm" min={4} step={1} onChange={(channelLengthMm) => onSpec({ ...spec, channelLengthMm })} />
            </Field>
            <Field label="Gap between" htmlFor="coupon-gap">
              <NumberInput id="coupon-gap" value={spec.gapMm} unit="mm" min={0.2} step={0.1} onChange={(gapMm) => onSpec({ ...spec, gapMm })} />
            </Field>
            <Field label="Label dot" htmlFor="coupon-dot">
              <NumberInput id="coupon-dot" value={spec.dotDiameterMm} unit="mm" min={0.2} step={0.1} onChange={(dotDiameterMm) => onSpec({ ...spec, dotDiameterMm })} />
            </Field>
            <Field label="Floor" htmlFor="coupon-floor">
              <NumberInput id="coupon-floor" value={spec.floorMm} unit="mm" min={0.2} step={0.1} onChange={(floorMm) => onSpec({ ...spec, floorMm })} />
            </Field>
            <Field label="Roof" htmlFor="coupon-roof">
              <NumberInput id="coupon-roof" value={spec.roofMm} unit="mm" min={0.2} step={0.1} onChange={(roofMm) => onSpec({ ...spec, roofMm })} />
            </Field>
          </div>
          <p className="text-[11px] leading-relaxed text-ink-muted">
            Changing the sizes clears any results already entered, because they describe a
            different coupon.
          </p>
        </div>
      ) : null}

      <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-[12px] leading-relaxed text-ink-muted">
        <li>
          Print it <span className="text-ink">flat, base down, with no tilt</span>, in the resin and at
          the exposure settings you will use for real chips.
        </li>
        <li>Wash and flush every channel before curing. Resin left inside reads as a closed channel.</li>
        <li>
          Groups are labelled by <span className="text-ink">dots in the top face</span>: one dot for group
          1, two for group 2. In each group, channel 1 is the one nearest the dots and is the widest.
        </li>
        <li>
          Design checks will list every channel as running outside the chip. On the coupon that is
          deliberate: it is what opens the ends.
        </li>
      </ol>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" icon={<Download size={14} />} onClick={downloadCoupon}>
          Download coupon (.openchip)
        </Button>
        <Button size="sm" icon={<FileSpreadsheet size={14} />} onClick={downloadSheet}>
          Measurement sheet (.csv)
        </Button>
        <Button size="sm" icon={<FolderOpen size={14} />} onClick={() => void openInEditor()}>
          Open the coupon in the editor
        </Button>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onNext}>
          I have results →
        </Button>
      </div>
    </div>
  );
}

/** A comma-separated list of millimetre values, committed on blur. */
function ListInput({
  id,
  values,
  onChange,
}: {
  id: string;
  values: number[];
  onChange: (values: number[]) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <TextInput
      id={id}
      inputMode="decimal"
      value={draft ?? listText(values)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft === null) return;
        const parsed = parseList(draft);
        if (parsed.length > 0) onChange(parsed);
        setDraft(null);
      }}
      className="font-mono"
    />
  );
}

// ---------------------------------------------------------------------------
// 2 · results
// ---------------------------------------------------------------------------

const NEXT_RESULT: Record<string, ChannelResult | null> = {
  none: 'open',
  open: 'partial',
  partial: 'closed',
  closed: null,
};

/**
 * Each state has its own glyph, word and border style as well as its colour,
 * so the grid reads without colour vision and in either theme.
 */
const RESULT_STYLE: Record<ChannelResult | 'none', { glyph: string; word: string; className: string }> = {
  none: { glyph: '·', word: 'not set', className: 'border-dashed border-line text-ink-quiet' },
  open: { glyph: '○', word: 'open', className: 'border-success bg-panel text-ink' },
  partial: { glyph: '◐', word: 'partial', className: 'border-dashed border-caution bg-caution-wash text-ink' },
  closed: { glyph: '●', word: 'closed', className: 'border-danger bg-danger-wash text-ink' },
};

function ResultsStep({
  measurements,
  onMeasurements,
  onNext,
}: {
  measurements: CouponMeasurement[];
  onMeasurements: (measurements: CouponMeasurement[]) => void;
  onNext: () => void;
}) {
  const [measured, setMeasured] = useState(() =>
    measurements.some((m) => m.measuredWidthMm !== undefined || m.measuredHeightMm !== undefined),
  );
  const input = useRef<HTMLInputElement | null>(null);

  const update = (id: string, patch: Partial<CouponMeasurement>) =>
    onMeasurements(measurements.map((m) => (m.id === id ? { ...m, ...patch } : m)));

  const groups = useMemo(() => {
    const byHeight = new Map<number, CouponMeasurement[]>();
    for (const m of measurements) {
      const list = byHeight.get(m.nominalHeightMm) ?? [];
      list.push(m);
      byHeight.set(m.nominalHeightMm, list);
    }
    return [...byHeight.entries()].sort(([a], [b]) => a - b);
  }, [measurements]);

  const marked = measurements.filter((m) => m.result !== null).length;

  const importSheet = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    // A profile carries its measurements, so it can be re-fitted from here too.
    if (file.name.endsWith(DFM_PROFILE_EXTENSION)) {
      const profile = parseDfmProfile(text);
      if (!profile.ok) {
        toast.error(profile.message, { description: profile.details.join(' ') || undefined });
        return;
      }
      onMeasurements(profile.profile.measurements);
      toast.success(`Loaded ${profile.profile.measurements.length} measurements from ${profile.profile.meta.name}`);
      return;
    }
    const parsed = parseMeasurementSheet(text);
    if (!parsed.ok) {
      toast.error(parsed.message, { description: parsed.details.join(' ') || undefined });
      return;
    }
    onMeasurements(parsed.measurements);
    toast.success(`Imported ${parsed.measurements.length} channels`);
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] leading-relaxed text-ink">
        Click a channel to mark it <Glyph result="open" />, <Glyph result="partial" /> or{' '}
        <Glyph result="closed" />. Leave any you did not check unset.
      </p>

      <div className="flex flex-col gap-2 overflow-x-auto">
        {groups.map(([heightMm, row], index) => (
          <div key={heightMm} className="flex items-center gap-2">
            <div className="w-28 shrink-0">
              <p className="text-[12px] font-medium text-ink">
                Group {index + 1}{' '}
                <span aria-hidden className="tracking-widest text-ink-quiet">
                  {'•'.repeat(index + 1)}
                </span>
              </p>
              <p className="font-mono text-[11px] text-ink-muted">{mm(heightMm)} mm tall</p>
            </div>
            <div className="flex gap-1">
              {row.map((m) => {
                const style = RESULT_STYLE[m.result ?? 'none'];
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => update(m.id, { result: NEXT_RESULT[m.result ?? 'none'] })}
                    aria-label={`Channel ${m.id}, ${mm(m.nominalWidthMm)} mm wide: ${style.word}. Click to change.`}
                    title={`Channel ${m.id} — ${mm(m.nominalWidthMm)} × ${mm(m.nominalHeightMm)} mm`}
                    className={cn(
                      'oc-pressable flex h-14 w-[3.6rem] flex-col items-center justify-center rounded-lg border-2',
                      style.className,
                    )}
                  >
                    <span className="text-[15px] leading-none">{style.glyph}</span>
                    <span className="mt-0.5 font-mono text-[10px] leading-none">{mm(m.nominalWidthMm)}</span>
                    <span className="mt-0.5 text-[9px] leading-none text-ink-muted">{style.word}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          onClick={() => onMeasurements(measurements.map((m) => (m.result === null ? { ...m, result: 'open' } : m)))}
        >
          Mark the rest open
        </Button>
        <Button size="sm" onClick={() => onMeasurements(measurements.map((m) => ({ ...m, result: null })))}>
          Clear
        </Button>
        <Button size="sm" icon={<Upload size={14} />} onClick={() => input.current?.click()}>
          Import a filled-in sheet or profile…
        </Button>
        <input
          ref={input}
          type="file"
          accept={`.csv,text/csv,${DFM_PROFILE_EXTENSION},application/json`}
          className="hidden"
          onChange={(event) => {
            void importSheet(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
      </div>

      <div>
        <button
          type="button"
          className="oc-pressable rounded px-1.5 py-0.5 text-[12px] text-accent hover:bg-accent-wash"
          onClick={() => setMeasured((v) => !v)}
        >
          {measured ? 'Hide measured dimensions' : 'Advanced: enter measured dimensions'}
        </button>
      </div>

      {measured ? (
        <div className="flex flex-col gap-2 rounded-lg border border-line p-3">
          <p className="text-[11px] leading-relaxed text-ink-muted">
            Optional, and worth it: a measured width or height turns a coarse bracket into a real
            fit. Fill in only the channels you measured. Widths can be read from above with a
            microscope; heights need a section or a profilometer.
          </p>
          <div className="grid max-h-64 grid-cols-[auto_auto_1fr_1fr] items-center gap-x-3 gap-y-1.5 overflow-y-auto pr-1">
            <p className="text-[11px] font-medium text-ink-muted">Channel</p>
            <p className="text-[11px] font-medium text-ink-muted">Drawn</p>
            <p className="text-[11px] font-medium text-ink-muted">Measured width</p>
            <p className="text-[11px] font-medium text-ink-muted">Measured height</p>
            {measurements.map((m) => (
              <MeasuredRow key={m.id} measurement={m} onChange={(patch) => update(m.id, patch)} />
            ))}
          </div>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2">
        <p className="text-[12px] text-ink-muted">
          {marked} of {measurements.length} channels marked
        </p>
        <Button size="sm" variant="primary" onClick={onNext}>
          Fit the results →
        </Button>
      </div>
    </div>
  );
}

function Glyph({ result }: { result: ChannelResult }) {
  const style = RESULT_STYLE[result];
  return (
    <span className="whitespace-nowrap font-medium">
      <span aria-hidden>{style.glyph}</span> {style.word}
    </span>
  );
}

function MeasuredRow({
  measurement,
  onChange,
}: {
  measurement: CouponMeasurement;
  onChange: (patch: Partial<CouponMeasurement>) => void;
}) {
  return (
    <>
      <p className="font-mono text-[12px] text-ink">{measurement.id}</p>
      <p className="font-mono text-[11px] text-ink-muted">
        {mm(measurement.nominalWidthMm)} × {mm(measurement.nominalHeightMm)}
      </p>
      <OptionalNumber
        label={`Measured width of channel ${measurement.id}`}
        value={measurement.measuredWidthMm}
        unit="mm"
        onChange={(measuredWidthMm) => onChange({ measuredWidthMm })}
      />
      <OptionalNumber
        label={`Measured height of channel ${measurement.id}`}
        value={measurement.measuredHeightMm}
        unit="mm"
        onChange={(measuredHeightMm) => onChange({ measuredHeightMm })}
      />
    </>
  );
}

/** A numeric field that may be left empty — `NumberInput` always holds a number. */
function OptionalNumber({
  value,
  onChange,
  unit,
  label,
  id,
}: {
  value: number | undefined | null;
  onChange: (value: number | undefined) => void;
  unit?: string;
  label?: string;
  id?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value === undefined || value === null ? '' : String(value));
  return (
    <div className="relative">
      <TextInput
        id={id}
        aria-label={label}
        inputMode="decimal"
        value={shown}
        placeholder="—"
        onChange={(event) => {
          const text = event.target.value;
          setDraft(text);
          if (text.trim() === '') {
            onChange(undefined);
            return;
          }
          const parsed = Number(text.replace(',', '.'));
          if (Number.isFinite(parsed) && parsed >= 0) onChange(parsed);
        }}
        onBlur={() => setDraft(null)}
        className={cn('h-8 font-mono text-[12px]', unit ? 'pr-9' : undefined)}
      />
      {unit ? (
        <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-ink-quiet">
          {unit}
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3 · profile
// ---------------------------------------------------------------------------

function ProfileStep({
  spec,
  measurements,
  printer,
  onDone,
}: {
  spec: CouponSpec;
  measurements: CouponMeasurement[];
  printer: PrinterProfile;
  onDone: () => void;
}) {
  const addProfile = useDfmStore((s) => s.addProfile);
  const select = useDfmStore((s) => s.select);
  const fit = useMemo(() => fitCompensation(measurements), [measurements]);

  const [name, setName] = useState(`${printer.name} — `);
  const [printerModel, setPrinterModel] = useState(printer.name);
  const [resin, setResin] = useState('');
  const [layerHeightMicrons, setLayerHeightMicrons] = useState(printer.layerHeightMicrons);
  const [xyPixelMicrons, setXyPixelMicrons] = useState<number | undefined>(printer.xyResolutionMicrons);
  const [normalExposureS, setNormalExposureS] = useState<number | undefined>();
  const [bottomExposureS, setBottomExposureS] = useState<number | undefined>();
  const [bottomLayers, setBottomLayers] = useState<number | undefined>();
  const [exposureOther, setExposureOther] = useState('');
  const [notes, setNotes] = useState('');
  const [snapToPixelGrid, setSnap] = useState(false);

  // Null until the user edits a value by hand; then the fit is theirs.
  const [manual, setManual] = useState<{ deltaXyMm: number; lateralDecayMm: number; deltaZMm: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const values = manual ?? fit;

  const coarse = !manual && (fit.lateral.method === 'open-closed' || fit.vertical.method === 'open-closed');
  const nothing = !manual && fit.lateral.method === 'none' && fit.vertical.method === 'none';
  const nameOk = name.trim().length > 0 && !name.trim().endsWith('—');

  const save = async () => {
    const manualFit: AxisFit = { method: 'manual', dataPoints: 0 };
    const measured = [...new Set(measurements.map((m) => m.nominalWidthMm))].sort((a, b) => a - b);
    const heights = [...new Set(measurements.map((m) => m.nominalHeightMm))].sort((a, b) => a - b);

    const profile: DfmProfile = {
      kind: DFM_PROFILE_KIND,
      schemaVersion: DFM_SCHEMA_VERSION,
      meta: {
        name: name.trim(),
        printerModel: printerModel.trim(),
        resin: resin.trim(),
        layerHeightMicrons,
        exposure: {
          normalExposureS: normalExposureS ?? null,
          bottomExposureS: bottomExposureS ?? null,
          bottomLayers: bottomLayers ?? null,
          other: exposureOther.trim(),
        },
        xyPixelMicrons: xyPixelMicrons ?? null,
        createdAt: new Date().toISOString(),
        notes: notes.trim(),
      },
      compensation: {
        model: DFM_MODEL_ID,
        deltaXyMm: values.deltaXyMm,
        lateralDecayMm: values.lateralDecayMm,
        deltaZMm: values.deltaZMm,
        snapToPixelGrid: snapToPixelGrid && xyPixelMicrons !== undefined,
      },
      fit: manual ? { lateral: manualFit, vertical: manualFit } : { lateral: fit.lateral, vertical: fit.vertical },
      // The lists actually measured, which is what a re-fit needs, rather than
      // the spec on screen — the two differ when a sheet was imported.
      coupon: {
        version: spec.version,
        widthsMm: measured.length > 0 ? measured : spec.widthsMm,
        heightsMm: heights.length > 0 ? heights : spec.heightsMm,
      },
      measurements,
    };

    // Through the parser before it is written: a profile this build would
    // refuse to load must never leave it.
    const checked = parseDfmProfile(serializeDfmProfile(profile));
    if (!checked.ok) {
      toast.error(checked.message, { description: checked.details.join(' ') || undefined });
      return;
    }

    const fileName = dfmProfileFileName(profile.meta.name);
    downloadBlob(serializeDfmProfile(checked.profile), fileName, DFM_PROFILE_MIME);
    const entry = await addProfile(checked.profile);
    select(entry.sha256);
    toast.success(`Saved ${fileName}`, {
      description: 'It is selected for export now. Keep the file: it is how the profile moves between browsers and people.',
    });
    onDone();
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-line bg-panel p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-quiet">
            {manual ? 'Values entered by hand' : 'Fit'}
          </p>
          <button
            type="button"
            className="oc-pressable rounded px-1.5 py-0.5 text-[11px] text-accent hover:bg-accent-wash"
            onClick={() => {
              if (editing) setManual(null);
              setEditing((v) => !v);
            }}
          >
            {editing ? 'Use the fit' : 'Advanced: edit values'}
          </button>
        </div>

        {editing ? (
          <div className="mt-3 grid grid-cols-3 gap-2.5">
            <Field label="Δxy per side" htmlFor="dfm-dxy">
              <NumberInput id="dfm-dxy" value={values.deltaXyMm} unit="mm" min={0} step={0.005} precision={4} onChange={(deltaXyMm) => setManual({ ...values, deltaXyMm })} />
            </Field>
            <Field label="Decay length λ" htmlFor="dfm-lambda">
              <NumberInput id="dfm-lambda" value={values.lateralDecayMm} unit="mm" min={0} step={0.005} precision={4} onChange={(lateralDecayMm) => setManual({ ...values, lateralDecayMm })} />
            </Field>
            <Field label="Δz ceiling" htmlFor="dfm-dz">
              <NumberInput id="dfm-dz" value={values.deltaZMm} unit="mm" min={0} step={0.005} precision={4} onChange={(deltaZMm) => setManual({ ...values, deltaZMm })} />
            </Field>
          </div>
        ) : (
          <div className="mt-2 flex flex-col gap-2">
            <FitLine
              label="Lateral, Δxy"
              value={`${mm(values.deltaXyMm)} mm per side`}
              extra={values.lateralDecayMm > 0 ? `decay length ${mm(values.lateralDecayMm)} mm` : 'same at every width'}
              axis={fit.lateral}
              unit="mm per side"
            />
            <FitLine
              label="Vertical, Δz"
              value={`${mm(values.deltaZMm)} mm`}
              extra="ceiling raise, monolithic chips only"
              axis={fit.vertical}
              unit="mm"
            />
            <p className="font-mono text-[11px] text-ink-quiet">
              predicts channels drawn {mm(predictedClosureWidthMm(values))} mm wide or less close
            </p>
          </div>
        )}
      </div>

      {nothing ? (
        <Caution>
          No results have been entered, so there is nothing to fit. Go back to step 2, or enter
          values by hand under Advanced.
        </Caution>
      ) : null}

      {coarse ? (
        <Caution title="This is a coarse fit">
          <ul className="flex list-disc flex-col gap-1 pl-4">
            {fit.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </Caution>
      ) : !manual && fit.notes.length > 0 && !nothing ? (
        <ul className="flex list-disc flex-col gap-1 pl-5 text-[11px] leading-relaxed text-ink-muted">
          {fit.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        <Field label="Profile name" htmlFor="dfm-name" className="col-span-2" hint="Name the printer, the resin and the exposure: it is how you will pick this profile later.">
          <TextInput id="dfm-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Mars 4 — clear resin — 2.5 s" />
        </Field>
        <Field label="Printer model" htmlFor="dfm-printer">
          <TextInput id="dfm-printer" value={printerModel} onChange={(e) => setPrinterModel(e.target.value)} />
        </Field>
        <Field label="Resin" htmlFor="dfm-resin">
          <TextInput id="dfm-resin" value={resin} onChange={(e) => setResin(e.target.value)} placeholder="Maker and name" />
        </Field>
        <Field label="Layer height" htmlFor="dfm-layer">
          <NumberInput id="dfm-layer" value={layerHeightMicrons} unit="µm" min={1} step={5} precision={0} onChange={setLayerHeightMicrons} />
        </Field>
        <Field label="XY pixel size" htmlFor="dfm-pixel" hint="Leave empty if unknown.">
          <OptionalNumber id="dfm-pixel" value={xyPixelMicrons} unit="µm" onChange={setXyPixelMicrons} />
        </Field>
        <Field label="Normal exposure" htmlFor="dfm-exposure">
          <OptionalNumber id="dfm-exposure" value={normalExposureS} unit="s" onChange={setNormalExposureS} />
        </Field>
        <Field label="Bottom exposure" htmlFor="dfm-bottom">
          <OptionalNumber id="dfm-bottom" value={bottomExposureS} unit="s" onChange={setBottomExposureS} />
        </Field>
        <Field label="Bottom layers" htmlFor="dfm-bottom-layers">
          <OptionalNumber id="dfm-bottom-layers" value={bottomLayers} onChange={setBottomLayers} />
        </Field>
        <Field label="Other exposure settings" htmlFor="dfm-other">
          <TextInput id="dfm-other" value={exposureOther} onChange={(e) => setExposureOther(e.target.value)} placeholder="Lift speed, rest time…" />
        </Field>
        <Field label="Notes" htmlFor="dfm-notes" className="col-span-2">
          <TextInput id="dfm-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Room temperature, resin batch, how it was measured…" />
        </Field>
      </div>

      <label className="flex items-start gap-2 text-[12px] text-ink">
        <input
          type="checkbox"
          checked={snapToPixelGrid && xyPixelMicrons !== undefined}
          disabled={xyPixelMicrons === undefined}
          onChange={(event) => setSnap(event.target.checked)}
          className="mt-0.5 h-3.5 w-3.5 accent-[var(--accent)]"
        />
        <span>
          Round compensated widths to whole pixels
          <span className="block text-[11px] text-ink-muted">
            {xyPixelMicrons === undefined
              ? 'Needs the XY pixel size.'
              : 'Sizes only: where a channel lands on the pixel grid is decided in the slicer.'}
          </span>
        </span>
      </label>

      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] leading-relaxed text-ink-muted">
          The file keeps every measurement, so it can be re-fitted later.
        </p>
        <Button
          size="sm"
          variant="primary"
          icon={<Download size={14} />}
          disabled={!nameOk}
          title={nameOk ? undefined : 'Give the profile a name first'}
          onClick={() => void save()}
        >
          Save profile ({DFM_PROFILE_EXTENSION}) and use it
        </Button>
      </div>
    </div>
  );
}

/** One axis of the fit: the number, what it rests on, and how well it is known. */
function FitLine({
  label,
  value,
  extra,
  axis,
  unit,
}: {
  label: string;
  value: string;
  extra: string;
  axis: AxisFit;
  unit: string;
}) {
  let basis: string;
  if (axis.method === 'measured') {
    basis = `least-squares fit to ${axis.dataPoints} measured channel${axis.dataPoints === 1 ? '' : 's'}, RMS residual ${mm(axis.rmsMm ?? 0, 4)} mm`;
  } else if (axis.method === 'open-closed') {
    const [lo, hi] = axis.bracketMm ?? [0, null];
    basis =
      `from open/closed results on ${axis.dataPoints} channels — somewhere in ` +
      (hi === null ? `${mm(lo)} ${unit} or more` : `${mm(lo)}–${mm(hi)} ${unit}`) +
      (axis.inconsistent ? `, ${axis.inconsistent} inconsistent` : '');
  } else {
    basis = 'no data';
  }

  return (
    <div>
      <p className="text-[13px] text-ink">
        <span className="text-ink-muted">{label}:</span>{' '}
        <span className="font-mono font-medium">{value}</span>
        <span className="ml-1.5 text-[11px] text-ink-quiet">{extra}</span>
      </p>
      <p className="text-[11px] leading-relaxed text-ink-muted">{basis}</p>
    </div>
  );
}

function Caution({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="flex gap-2 rounded-lg border border-caution/40 bg-caution-wash px-3 py-2.5">
      <AlertTriangle size={14} className="mt-0.5 shrink-0 text-caution" />
      <div className="min-w-0 text-[11px] leading-relaxed text-ink">
        {title ? <p className="mb-1 text-[12px] font-medium">{title}</p> : null}
        {children}
      </div>
    </div>
  );
}
