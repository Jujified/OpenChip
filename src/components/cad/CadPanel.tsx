import { AlertTriangle, Box, Camera, Download, FileCode2, Maximize2, RotateCw, Trash2 } from 'lucide-react';
import { useState, type ReactNode, type RefObject } from 'react';
import { toast } from 'sonner';
import { newId } from '../../lib/defaults';
import { downloadBlob, downloadDataUri } from '../../lib/download';
import { exportScad } from '../../lib/cad/scadExport';
import { exportStl } from '../../lib/cad/stlExport';
import { THREAD_APPROXIMATION_NOTE } from '../../lib/cad/portGeometry';
import { channelPlaneZ, slidePocket } from '../../lib/cad/slide';
import { slugify } from '../../lib/slug';
import { useChipResize } from '../../hooks/useChipResize';
import { useCadStore } from '../../store/cadStore';
import { useProjectStore } from '../../store/projectStore';
import type { ChipParams } from '../../types/project';
import { WikiLink } from '../ui/WikiLink';
import { Button } from '../ui/Button';
import { Field, NumberInput, Segmented } from '../ui/Field';
import { Section } from '../draw/InspectorPanel';
import type { CadViewportHandle } from './CadViewport';

export function CadPanel({ viewport }: { viewport: RefObject<CadViewportHandle | null> }) {
  return (
    <aside className="flex w-[19rem] shrink-0 flex-col overflow-y-auto border-l border-line bg-panel">
      <BuildStatus />
      <ChipParameters />
      <SlideParameters />
      <ExportSection viewport={viewport} />
    </aside>
  );
}

// ---------------------------------------------------------------------------

function BuildStatus() {
  const model = useCadStore((s) => s.model);
  const building = useCadStore((s) => s.building);
  const booting = useCadStore((s) => s.booting);
  const error = useCadStore((s) => s.error);

  if (error) {
    return (
      <div className="border-b border-line bg-danger-wash px-4 py-3">
        <p className="text-[13px] font-medium text-danger">The model failed to build</p>
        <p className="mt-1 font-mono text-[11px] leading-relaxed text-ink-muted">{error}</p>
      </div>
    );
  }

  return (
    <div className="border-b border-line px-4 py-3">
      <p className="font-mono text-[11px] text-ink-muted">
        {booting
          ? 'starting geometry engine…'
          : building
            ? 'rebuilding…'
            : model
              ? `${model.stats.triangleCount.toLocaleString()} triangles · ${model.elapsedMs.toFixed(0)} ms`
              : 'no model yet'}
      </p>
      {model ? (
        <p className="mt-1 font-mono text-[11px] text-ink-quiet">
          channel void {model.stats.channelVolumeMm3.toFixed(1)} mm³ ·{' '}
          {model.stats.portCount} ports · {model.stats.chamberCount} chambers
          {model.stats.ventCount > 0 ? ` · ${model.stats.ventCount} vents` : ''}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

function ChipParameters() {
  const chipParams = useProjectStore((s) => s.project.chipParams);
  const update = useProjectStore((s) => s.updateChipParams);
  const resize = useChipResize();

  return (
    <Section title="Chip">
      <div className="grid grid-cols-2 gap-2.5">
        <Field label="Width" htmlFor="cad-width">
          <NumberInput
            id="cad-width"
            value={chipParams.width}
            onChange={(width) => resize({ width })}
            unit="mm"
            min={1}
            step={1}
          />
        </Field>
        <Field label="Length" htmlFor="cad-length">
          <NumberInput
            id="cad-length"
            value={chipParams.length}
            onChange={(length) => resize({ length })}
            unit="mm"
            min={1}
            step={1}
          />
        </Field>
      </div>

      <Field label="Base thickness" htmlFor="cad-base">
        <NumberInput
          id="cad-base"
          value={chipParams.baseThickness}
          onChange={(baseThickness) => update({ baseThickness })}
          unit="mm"
          min={0.2}
          step={0.5}
        />
      </Field>

      <Field
        label="Wall thickness"
        htmlFor="cad-wall"
        hint="Minimum material between a channel and anything else."
      >
        <NumberInput
          id="cad-wall"
          value={chipParams.wallThickness}
          onChange={(wallThickness) => update({ wallThickness })}
          unit="mm"
          min={0.05}
          step={0.1}
        />
      </Field>

      <Field label="Minimum edge spacing" htmlFor="cad-edge">
        <NumberInput
          id="cad-edge"
          value={chipParams.minEdgeSpacing}
          onChange={(minEdgeSpacing) => update({ minEdgeSpacing })}
          unit="mm"
          min={0}
          step={0.5}
        />
      </Field>

      <Field
        label="Split type"
        hint={
          <>
            Two-piece prints as a channel plate and a lid, so uncured resin rinses straight out.{' '}
            <WikiLink to="splitType">Which to choose</WikiLink>
          </>
        }
      >
        <Segmented
          value={chipParams.splitType}
          onChange={(splitType) => update({ splitType })}
          options={[
            { value: 'two-piece' as const, label: 'Two-piece' },
            { value: 'monolithic' as const, label: 'Monolithic' },
            { value: 'glass-slide' as const, label: 'Glass slide' },
          ]}
        />
      </Field>

      {chipParams.splitType === 'glass-slide' ? (
        <Field
          label="Channel plane"
          hint="Set by the pocket floor, so the channels always open onto the face the glass lands on."
        >
          <p className="font-mono text-[13px] text-ink">
            {round2(channelPlaneZ(chipParams))} mm
            <span className="ml-2 text-[11px] text-ink-quiet">
              = {round2(chipParams.baseThickness)} − {round2(pocketDepthOf(chipParams))}
            </span>
          </p>
        </Field>
      ) : (
        <>
          <Field
            label="Split height"
            htmlFor="cad-split"
            data-tour="split-height"
            hint={
              chipParams.splitType === 'monolithic'
                ? 'Still sets how deep the channels sit, even though nothing is cut.'
                : 'Height of the cut plane. Rectangular channels sit just below it, leaving a flat lid.'
            }
          >
            <NumberInput
              id="cad-split"
              value={chipParams.splitHeight}
              onChange={(splitHeight) => update({ splitHeight })}
              unit="mm"
              min={0}
              max={chipParams.baseThickness}
              step={0.1}
            />
          </Field>

          <SplitHeightSlider chipParams={chipParams} onChange={(v) => update({ splitHeight: v })} />
        </>
      )}
    </Section>
  );
}

const round2 = (mm: number) => Number(mm.toFixed(2));
const pocketDepthOf = (chipParams: ChipParams) =>
  chipParams.slide.thicknessMm + chipParams.slide.bondGapMm;

/**
 * A real slider for split height.
 *
 * Typing a number is precise but gives no feel for where the cut lands relative
 * to the channels; dragging does, and the worker keeps up.
 */
function SplitHeightSlider({
  chipParams,
  onChange,
}: {
  chipParams: ChipParams;
  onChange: (value: number) => void;
}) {
  return (
    <input
      type="range"
      min={0}
      max={chipParams.baseThickness}
      step={0.05}
      value={chipParams.splitHeight}
      onChange={(event) => onChange(Number(event.target.value))}
      aria-label="Split height"
      className="h-1 w-full cursor-pointer appearance-none rounded-full bg-line accent-[var(--accent)]"
    />
  );
}

// ---------------------------------------------------------------------------
// glass slide
// ---------------------------------------------------------------------------

/**
 * The slide the chip is designed around.
 *
 * Only shown on a slide chip, and only the three numbers that describe the
 * glass in your hand are up front. The fit clearance, the bond gap and the
 * offset are all real parameters someone will need one day, so they are here
 * too — behind a toggle rather than gone.
 */
function SlideParameters() {
  const chipParams = useProjectStore((s) => s.project.chipParams);
  const update = useProjectStore((s) => s.updateChipParams);
  const [advanced, setAdvanced] = useState(false);

  if (chipParams.splitType !== 'glass-slide') return null;

  const { slide } = chipParams;
  const set = (patch: Partial<ChipParams['slide']>) => update({ slide: { ...slide, ...patch } });

  const pocket = slidePocket(chipParams);
  const needed = {
    width: slide.widthMm + slide.clearanceMm * 2 + chipParams.minEdgeSpacing * 2,
    length: slide.lengthMm + slide.clearanceMm * 2 + chipParams.minEdgeSpacing * 2,
  };
  const fits = chipParams.width >= needed.width && chipParams.length >= needed.length;

  return (
    <Section
      title="Glass slide"
      action={
        <button
          type="button"
          className="oc-pressable rounded px-1.5 py-0.5 text-[11px] text-accent hover:bg-accent-wash"
          onClick={() => setAdvanced((v) => !v)}
        >
          {advanced ? 'Less' : 'Advanced'}
        </button>
      }
    >
      <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2.5">
        <Field label="Slide width" htmlFor="slide-width">
          <NumberInput
            id="slide-width"
            value={slide.widthMm}
            onChange={(widthMm) => set({ widthMm })}
            unit="mm"
            min={1}
            step={1}
          />
        </Field>
        <Field label="Slide length" htmlFor="slide-length">
          <NumberInput
            id="slide-length"
            value={slide.lengthMm}
            onChange={(lengthMm) => set({ lengthMm })}
            unit="mm"
            min={1}
            step={1}
          />
        </Field>
        <Button
          size="sm"
          variant="secondary"
          icon={<RotateCw size={14} />}
          aria-label="Rotate the slide 90°"
          title="Rotate the slide 90° — swaps width and length"
          onClick={() => set({ widthMm: slide.lengthMm, lengthMm: slide.widthMm })}
        >
          90°
        </Button>
      </div>

      <Field
        label="Slide thickness"
        htmlFor="slide-thickness"
        hint="Plain slides run 1.0–1.2 mm. Measure yours: it sets how deep the pocket is cut."
      >
        <NumberInput
          id="slide-thickness"
          value={slide.thicknessMm}
          onChange={(thicknessMm) => set({ thicknessMm })}
          unit="mm"
          min={0.1}
          step={0.1}
        />
      </Field>

      {advanced ? (
        <>
          <div className="grid grid-cols-2 gap-2.5">
            <Field label="Fit clearance" htmlFor="slide-clearance" hint="Per side.">
              <NumberInput
                id="slide-clearance"
                value={slide.clearanceMm}
                onChange={(clearanceMm) => set({ clearanceMm })}
                unit="mm"
                min={0}
                step={0.05}
                precision={3}
              />
            </Field>
            <Field label="Bond gap" htmlFor="slide-bond" hint="Adhesive under the glass.">
              <NumberInput
                id="slide-bond"
                value={slide.bondGapMm}
                onChange={(bondGapMm) => set({ bondGapMm })}
                unit="mm"
                min={0}
                step={0.05}
                precision={3}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <Field label="Offset X" htmlFor="slide-offset-x">
              <NumberInput
                id="slide-offset-x"
                value={slide.offsetXMm}
                onChange={(offsetXMm) => set({ offsetXMm })}
                unit="mm"
                step={0.5}
              />
            </Field>
            <Field label="Offset Y" htmlFor="slide-offset-y">
              <NumberInput
                id="slide-offset-y"
                value={slide.offsetYMm}
                onChange={(offsetYMm) => set({ offsetYMm })}
                unit="mm"
                step={0.5}
              />
            </Field>
          </div>
          <p className="text-[11px] leading-relaxed text-ink-muted">
            The pocket is centred on the chip; the offset moves it from there.
          </p>
        </>
      ) : null}

      {pocket ? (
        <p className="font-mono text-[11px] leading-relaxed text-ink-quiet">
          pocket {round2(pocket.pocket.width)} × {round2(pocket.pocket.length)} ×{' '}
          {round2(pocket.depthMm)} mm deep
          {Math.abs(pocket.proudMm) > 0.001
            ? ` · glass sits ${round2(Math.abs(pocket.proudMm))} mm ${pocket.proudMm > 0 ? 'proud' : 'sunk'}`
            : ' · glass flush with the top'}
        </p>
      ) : null}

      {!fits ? (
        <Button
          size="sm"
          variant="secondary"
          icon={<Maximize2 size={14} />}
          onClick={() => {
            update({
              width: Math.max(chipParams.width, round2(needed.width)),
              length: Math.max(chipParams.length, round2(needed.length)),
            });
            toast.success('Chip resized to fit the slide', {
              description: `${round2(Math.max(chipParams.width, needed.width))} × ${round2(
                Math.max(chipParams.length, needed.length),
              )} mm, leaving your ${chipParams.minEdgeSpacing} mm edge spacing as a rim.`,
            });
          }}
        >
          Fit the chip to the slide
        </Button>
      ) : null}

      <p className="text-[11px] leading-relaxed text-ink-muted">
        The chip prints open-faced: the channels are grooves, and the glass closes them once it is
        bonded in. Nothing here is exported — glass is bought, not printed.
      </p>
    </Section>
  );
}

// ---------------------------------------------------------------------------

function ExportSection({ viewport }: { viewport: RefObject<CadViewportHandle | null> }) {
  const graph = useProjectStore((s) => s.project.channelGraph);
  const chipParams = useProjectStore((s) => s.project.chipParams);
  const projectName = useProjectStore((s) => s.project.meta.name);
  const drainageVents = useProjectStore((s) => s.project.drainageVents);
  const addSavedImage = useProjectStore((s) => s.addSavedImage);
  const buildForExport = useCadStore((s) => s.buildForExport);
  const model = useCadStore((s) => s.model);

  const [busy, setBusy] = useState<string | null>(null);
  const [highRes, setHighRes] = useState(true);

  const slug = slugify(projectName);

  const exportStlFor = async (which: 'all' | 'body' | 'lid') => {
    setBusy(`stl-${which}`);
    try {
      // Re-run at export quality rather than shipping the coarse preview mesh —
      // the tessellation error in a preview circle is ~2%, which is real
      // material on a 0.4 mm channel.
      const built = await buildForExport(graph, chipParams, drainageVents);
      const pieces =
        which === 'all' ? built.pieces : built.pieces.filter((p) => p.id === which);

      if (pieces.length === 0) {
        toast.error('Nothing to export for that piece.');
        return;
      }

      const suffix = which === 'all' ? '' : `-${which}`;
      const buffer = exportStl(pieces, `OpenChip ${projectName}`);
      downloadBlob(buffer, `${slug}${suffix}.stl`, 'model/stl');

      const tris = pieces.reduce((sum, p) => sum + p.indices.length / 3, 0);
      toast.success(`Exported ${slug}${suffix}.stl`, {
        description: `${tris.toLocaleString()} triangles, millimetre units.`,
      });
    } catch (error) {
      toast.error("Couldn't build the STL", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(null);
    }
  };

  const exportScadFile = () => {
    setBusy('scad');
    try {
      const source = exportScad(graph, chipParams, { projectName, drainageVents });
      downloadBlob(source, `${slug}.scad`, 'text/plain');
      toast.success(`Exported ${slug}.scad`, {
        description: 'Parameters are at the top of the file, ready to edit.',
      });
    } finally {
      setBusy(null);
    }
  };

  const snapshot = () => {
    const data = viewport.current?.snapshot(highRes ? 3 : 1);
    if (!data) {
      toast.error('The viewport is not ready yet.');
      return;
    }

    // Snapshots live inside the project file, so their weight is the user's to
    // know about — a few high-res captures are the difference between a small
    // .openchip and a fat one.
    const approxKb = Math.round((data.length * 0.75) / 1024);
    const filename = `${slug}-cad${highRes ? '-3x' : ''}.png`;

    addSavedImage({
      id: newId(),
      kind: 'cad-snapshot',
      label: `${projectName} — CAD view${highRes ? ' (high-res)' : ''}`,
      createdAt: new Date().toISOString(),
      mimeType: 'image/png',
      data,
    });

    toast.success('Snapshot saved to the project', {
      description:
        approxKb > 1024
          ? `${(approxKb / 1024).toFixed(1)} MB — kept in the .openchip file, and listed below.`
          : `${approxKb} KB — kept in the .openchip file, and listed below.`,
      // Saving it into the project and wanting the actual file are both normal
      // next steps, and until now only the first was reachable from here.
      action: {
        label: 'Download',
        onClick: () => downloadDataUri(data, filename),
      },
    });
  };

  const twoPiece = chipParams.splitType === 'two-piece';
  const hasBody = model?.pieces.some((p) => p.id === 'body') ?? false;
  const hasLid = model?.pieces.some((p) => p.id === 'lid') ?? false;

  return (
    <>
      <Section title="Export">
        <div className="flex flex-col gap-2">
          <p className="text-[11px] leading-relaxed text-ink-muted">
            STL to print, OpenSCAD to keep editing.{' '}
            <WikiLink to="exporting">Which format when</WikiLink>
          </p>
          <Button
            size="sm"
            icon={<Download size={14} />}
            disabled={busy !== null || !model}
            onClick={() => void exportStlFor('all')}
          >
            {busy === 'stl-all' ? 'Building…' : twoPiece ? 'STL — both pieces' : 'STL'}
          </Button>

          {twoPiece ? (
            <div className="grid grid-cols-2 gap-2">
              <Button
                size="sm"
                disabled={busy !== null || !hasBody}
                onClick={() => void exportStlFor('body')}
              >
                {busy === 'stl-body' ? '…' : 'Channel plate'}
              </Button>
              <Button
                size="sm"
                disabled={busy !== null || !hasLid}
                onClick={() => void exportStlFor('lid')}
              >
                {busy === 'stl-lid' ? '…' : 'Lid'}
              </Button>
            </div>
          ) : null}

          <Button
            size="sm"
            icon={<FileCode2 size={14} />}
            disabled={busy !== null}
            onClick={exportScadFile}
          >
            OpenSCAD source
          </Button>
        </div>

        <p className="text-[11px] leading-relaxed text-ink-muted">
          The preview refines to export quality once you stop editing, so what is on screen at
          rest is the mesh that gets written.
        </p>
      </Section>

      <Section title="Snapshot">
        <label className="flex items-center gap-2 text-[12px] text-ink">
          <input
            type="checkbox"
            checked={highRes}
            onChange={(event) => setHighRes(event.target.checked)}
            className="h-3.5 w-3.5 accent-[var(--accent)]"
          />
          High resolution
          <span className="text-ink-quiet">(3×, for slides)</span>
        </label>

        <Button size="sm" icon={<Camera size={14} />} onClick={snapshot}>
          Save viewport as PNG
        </Button>

        <p className="text-[11px] leading-relaxed text-ink-muted">
          Captures exactly what is framed now, into the project&rsquo;s saved images.
        </p>

        <SavedSnapshots slug={slug} />
      </Section>

      {model?.stats.usedThreadApproximation ? (
        <Section title="Thread note">
          <div className="flex gap-2 rounded-lg border border-caution/40 bg-caution-wash px-3 py-2.5">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-caution" />
            <p className="text-[11px] leading-relaxed text-ink">{THREAD_APPROXIMATION_NOTE}</p>
          </div>
        </Section>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------

/**
 * Trapped-resin warning for monolithic chips.
 *
 * Persistent and non-blocking — it explains the risk and points at the
 * drainage-hole helper, and it never disables an export.
 */
export function MonolithicBanner() {
  const chipParams = useProjectStore((s) => s.project.chipParams);
  const update = useProjectStore((s) => s.updateChipParams);

  if (chipParams.splitType !== 'monolithic') return null;

  return (
    <div
      id="drainage-holes"
      className="flex shrink-0 items-start gap-3 border-b border-caution/30 bg-caution-wash px-4 py-2.5"
    >
      <AlertTriangle size={15} className="mt-0.5 shrink-0 text-caution" />
      <div className="min-w-0 flex-1">
        <p className="text-[12px] font-medium text-ink">
          Monolithic chips trap uncured resin inside the channels
        </p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">
          There is no opening to wash through, so resin sets inside and blocks the channel. Open
          the Design checks panel below and use <span className="font-medium">Add drainage
          holes</span> to vent the trapped sections, or switch to a two-piece split, which avoids
          the problem entirely.
        </p>
      </div>
      <Button
        size="sm"
        variant="secondary"
        icon={<Box size={13} />}
        className="shrink-0"
        onClick={() => update({ splitType: 'two-piece' })}
      >
        Use two-piece
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * The snapshots already in this project.
 *
 * Schematic SVGs have been listed and removable from the Draw tab since they
 * were added; CAD snapshots never were. `addSavedImage` wrote them into the
 * project, the presentation export silently read back whichever was newest, and
 * nothing else mentioned them — so a capture was effectively write-only. You
 * could take five and reach none of them.
 */
function SavedSnapshots({ slug }: { slug: string }) {
  const savedImages = useProjectStore((s) => s.project.savedImages);
  const removeSavedImage = useProjectStore((s) => s.removeSavedImage);

  // Newest first: the one just taken is the one most likely wanted.
  const snapshots = savedImages.filter((image) => image.kind === 'cad-snapshot').toReversed();
  if (snapshots.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[11px] font-medium text-ink-muted">
        Saved snapshots
        <span className="ml-1 font-normal text-ink-quiet">({snapshots.length})</span>
      </p>

      <ul className="flex flex-col gap-1.5">
        {snapshots.map((image, index) => (
          <li
            key={image.id}
            className="flex items-center gap-2 rounded-lg border border-line bg-elevated p-1.5"
          >
            <img
              src={image.data}
              alt={image.label}
              className="h-9 w-12 shrink-0 rounded-md border border-line object-cover"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[11px] text-ink">
                {new Date(image.createdAt).toLocaleString(undefined, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              </p>
              <p className="truncate text-[10px] text-ink-quiet">
                {Math.round((image.data.length * 0.75) / 1024)} KB
              </p>
            </div>
            <IconAction
              label="Download this snapshot"
              onClick={() =>
                downloadDataUri(
                  image.data,
                  // Numbered from the end so the filename matches the position
                  // in the list the user is looking at.
                  `${slug}-cad-${snapshots.length - index}.png`,
                )
              }
            >
              <Download size={13} />
            </IconAction>
            <IconAction
              label="Remove this snapshot from the project"
              onClick={() => removeSavedImage(image.id)}
            >
              <Trash2 size={13} />
            </IconAction>
          </li>
        ))}
      </ul>
    </div>
  );
}

function IconAction({
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
      className="shrink-0 rounded-md p-1.5 text-ink-muted transition-colors hover:bg-sunken hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
    >
      {children}
    </button>
  );
}
