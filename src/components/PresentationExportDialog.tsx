import { Box, FileImage, Images, Info, Waves } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { cn } from '../lib/cn';
import { effectiveProfiles, reconcileFluidSetup } from '../lib/fluids/reconcile';
import { simulate } from '../lib/fluids/simulate';
import { downloadBlob } from '../lib/download';
import {
  DPI_CHOICES,
  DPI_LABEL,
  buildPresentationBundle,
  type Dpi,
} from '../lib/presentationExport';
import { useCadStore } from '../store/cadStore';
import { useFluidStore } from '../store/fluidStore';
import { useProjectStore } from '../store/projectStore';
import { useUiStore } from '../store/uiStore';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { Field, Segmented } from './ui/Field';

/** "Export for presentation" — reachable from every tab via the top bar. */
export function PresentationExportDialog() {
  const open = useUiStore((s) => s.presentationOpen);
  const setOpen = useUiStore((s) => s.setPresentationOpen);
  const onClose = () => setOpen(false);

  const project = useProjectStore((s) => s.project);
  // As the Fluid tab shows them, so a project exported before that tab was
  // ever opened still gets its default fluids and assignments.
  const fluidProfiles = effectiveProfiles(project.fluidProfiles);
  const fluidSetup = useMemo(
    () => reconcileFluidSetup(project.channelGraph, project.fluidSetup, fluidProfiles),
    [project.channelGraph, project.fluidSetup, fluidProfiles],
  );
  const metric = useFluidStore((s) => s.metric);
  const snapshotProvider = useCadStore((s) => s.snapshotProvider);

  // Run through `simulate` directly rather than `useSimulation`, and only while
  // the dialog is open. The estimate is cheap but not free, and every project
  // edit paying for a figure nobody is looking at would be a waste the user
  // eventually feels on a large gradient generator.
  const result = useMemo(
    () =>
      open
        ? simulate({
            graph: project.channelGraph,
            chipParams: project.chipParams,
            fluidProfiles,
            fluidSetup,
          })
        : null,
    [open, project.channelGraph, project.chipParams, fluidProfiles, fluidSetup],
  );

  const [dpi, setDpi] = useState<Dpi>(300);
  const [includeSchematic, setIncludeSchematic] = useState(true);
  const [includeCad, setIncludeCad] = useState(true);
  const [includeHeatmap, setIncludeHeatmap] = useState(true);
  const [includeSheet, setIncludeSheet] = useState(true);
  const [busy, setBusy] = useState(false);

  const hasGeometry = project.channelGraph.edges.length > 0;

  /**
   * The newest snapshot already sitting in the project, used when the CAD tab
   * is not the one on screen. Saved images are the only durable record of a
   * viewport that is no longer mounted.
   */
  const savedSnapshot = useMemo(
    () =>
      [...project.savedImages].reverse().find((image) => image.kind === 'cad-snapshot')?.data ??
      null,
    [project.savedImages],
  );

  const cadAvailable = snapshotProvider !== null || savedSnapshot !== null;
  const heatmapAvailable = result !== null && result.segments.length > 0 && !result.blockedReason;

  const selected =
    Number(includeSchematic && hasGeometry) +
    Number(includeCad && cadAvailable) +
    Number(includeHeatmap && heatmapAvailable);

  const run = async () => {
    setBusy(true);
    try {
      // Captured live where possible so the export matches how the user has the
      // model framed right now, and only falls back to a stored image when the
      // viewport is not mounted.
      const cadSnapshotDataUri = includeCad
        ? (snapshotProvider?.(dpi >= 150 ? 3 : 1) ?? savedSnapshot)
        : null;

      const bundle = await buildPresentationBundle(
        {
          projectName: project.meta.name,
          graph: project.channelGraph,
          chipParams: project.chipParams,
          printerProfile: project.printerProfile,
          fluidSetup,
          cadSnapshotDataUri,
          heatmap: heatmapAvailable && result ? { result, metric } : null,
        },
        { dpi, includeSchematic, includeCad, includeHeatmap, includeSheet },
      );

      downloadBlob(bundle.bytes, bundle.fileName, 'application/zip');
      onClose();
      toast.success(`Exported ${bundle.fileName}`, {
        description: `${bundle.contents.join(', ')} — at ${dpi} DPI.`,
        duration: 7000,
      });
    } catch (error) {
      toast.error("Couldn't build the presentation bundle", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const body = (
    <div className="flex flex-col gap-4 pb-4">
      <div className="flex flex-col gap-2">
        <Toggle
          icon={<FileImage size={15} />}
          label="Schematic drawing"
          hint="Dimensioned 2D vector drawing of the channel network."
          checked={includeSchematic && hasGeometry}
          disabled={!hasGeometry}
          disabledReason="Draw a channel network first."
          onChange={setIncludeSchematic}
        />
        <Toggle
          icon={<Box size={15} />}
          label="CAD view"
          hint={
            snapshotProvider
              ? 'Captured live, exactly as you have the model framed.'
              : 'From the newest snapshot saved in this project.'
          }
          checked={includeCad && cadAvailable}
          disabled={!cadAvailable}
          disabledReason="Open the CAD Preview tab once, and the 3D view can be included."
          onChange={setIncludeCad}
        />
        <Toggle
          icon={<Waves size={15} />}
          label="Flow heatmap"
          hint="The estimate currently on the Fluid Dynamics tab, as a vector figure."
          checked={includeHeatmap && heatmapAvailable}
          disabled={!heatmapAvailable}
          disabledReason={
            result?.blockedReason ?? 'Assign a fluid and a flow rate on the Fluid Dynamics tab.'
          }
          onChange={setIncludeHeatmap}
        />
      </div>

      <Field
        label="Resolution"
        hint="Applies to the raster output. The SVGs are vector and stay sharp at any size."
      >
        <Segmented
          value={String(dpi)}
          onChange={(value) => setDpi(Number(value) as Dpi)}
          options={DPI_CHOICES.map((value) => ({
            value: String(value),
            label: `${value}`,
          }))}
        />
        <p className="mt-1.5 text-[11px] text-ink-muted">{DPI_LABEL[dpi]}</p>
      </Field>

      <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line bg-sunken px-3.5 py-3">
        <input
          type="checkbox"
          checked={includeSheet}
          onChange={(event) => setIncludeSheet(event.target.checked)}
          className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--accent)]"
        />
        <span>
          <span className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
            <Images size={14} className="text-ink-muted" />
            Also lay them out as one figure
          </span>
          <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-muted">
            A titled 16:9 sheet carrying everything selected above, sized for a slide. The
            individual files are in the bundle either way.
          </span>
        </span>
      </label>

      <div className="flex items-start gap-2 rounded-lg border border-line px-3.5 py-2.5">
        <Info size={13} className="mt-0.5 shrink-0 text-ink-faint" />
        <p className="text-[11px] leading-relaxed text-ink-muted">
          Downloads as a single <span className="font-mono">.zip</span> with a README recording the
          chip parameters and printer profile it was exported against.
        </p>
      </div>
    </div>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Export for presentation"
      description="Your drawing, the 3D view and the flow estimate, bundled as one download."
      className="w-[min(calc(100vw-2rem),36rem)]"
      // Pinned rather than scrolled with the options: on a short window the
      // primary action would otherwise sit below the fold of its own dialog.
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={<Images size={15} />}
            disabled={busy || selected === 0}
            onClick={() => void run()}
          >
            {busy ? 'Rendering…' : `Export ${selected} item${selected === 1 ? '' : 's'}`}
          </Button>
        </>
      }
    >
      {body}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------

function Toggle({
  icon,
  label,
  hint,
  checked,
  disabled,
  disabledReason,
  onChange,
}: {
  icon: ReactNode;
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  disabledReason: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <label
      className={cn(
        'flex items-start gap-2.5 rounded-lg border px-3.5 py-3 transition-colors duration-150',
        disabled
          ? 'cursor-not-allowed border-line opacity-60'
          : 'cursor-pointer border-line hover:border-line-strong',
        checked && !disabled ? 'border-accent/50 bg-accent-wash/40' : null,
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--accent)]"
      />
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
          <span className="text-ink-muted">{icon}</span>
          {label}
        </span>
        {/* When something cannot be included, say what to do about it rather
            than greying the row out and leaving the user to guess. */}
        <span
          className={cn(
            'mt-0.5 block text-[11px] leading-relaxed',
            disabled ? 'text-caution' : 'text-ink-muted',
          )}
        >
          {disabled ? disabledReason : hint}
        </span>
      </span>
    </label>
  );
}
