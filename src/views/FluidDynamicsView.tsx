import { FileImage, Info, Table2, Waves } from 'lucide-react';
import { useMemo } from 'react';
import { toast } from 'sonner';
import { WikiLink } from '../components/ui/WikiLink';
import { FluidCanvas } from '../components/fluid/FluidCanvas';
import { FluidPanel } from '../components/fluid/FluidPanel';
import { HeatmapLegend } from '../components/fluid/HeatmapLegend';
import { ResultsTable } from '../components/fluid/ResultsTable';
import { Button } from '../components/ui/Button';
import { cn } from '../lib/cn';
import {
  buildScale,
  METRIC_LABEL,
  METRIC_SHORT_LABEL,
  metricDomain,
  type HeatmapMetric,
} from '../lib/fluids/heatmap';
import { heatmapSavedImage } from '../lib/fluids/heatmapExport';
import { CFD_DISCLAIMER } from '../lib/fluids/simulate';
import { useFluidInputs, useSimulation } from '../hooks/useSimulation';
import { useFluidStore } from '../store/fluidStore';
import { useProjectStore } from '../store/projectStore';
import { Placeholder } from './Placeholder';

const METRICS: HeatmapMetric[] = ['pressure', 'reynolds', 'temperature', 'residence', 'shear'];

export function FluidDynamicsView() {
  const graph = useProjectStore((s) => s.project.channelGraph);
  const result = useSimulation();
  const metric = useFluidStore((s) => s.metric);
  const showTable = useFluidStore((s) => s.showTable);

  const scale = useMemo(() => {
    const inletTemps = result.segments.map((s) => s.temperatureInC);
    const dark =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches;
    return buildScale(
      metric,
      metricDomain(metric, result.segments),
      {
        dark,
        centerC:
          metric === 'temperature' && inletTemps.length > 0
            ? inletTemps.reduce((a, b) => a + b, 0) / inletTemps.length
            : undefined,
      },
    );
  }, [result.segments, metric]);

  if (graph.edges.length === 0) {
    return (
      <Placeholder
        icon={<Waves size={22} strokeWidth={1.75} />}
        eyebrow="Nothing to estimate yet"
        title="Draw a channel network first"
        description="Flow estimates run over the channels you draw, once there is a port at each end. Templates arrive with their inlets and outlets already assigned."
        bullets={[
          'Assign a fluid and a flow rate to each inlet',
          'Pressure drop per segment via Hagen–Poiseuille',
          'Reynolds number with laminar / transitional / turbulent labels',
          'Residence time and internal volume per segment',
          'Heat exchange between channels running near each other',
        ]}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <FluidToolbar result={result} />

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1">
            {result.blockedReason ? (
              <BlockedNotice reason={result.blockedReason} />
            ) : (
              <>
                <FluidCanvas result={result} metric={metric} />
                <HeatmapLegend scale={scale} />
              </>
            )}
          </div>

          {showTable && !result.blockedReason ? (
            <div className="flex h-[15rem] shrink-0 flex-col border-t border-line bg-panel">
              <ResultsTable result={result} />
            </div>
          ) : null}
        </div>

        <FluidPanel result={result} />
      </div>

      <Disclaimer notes={result.notes} />
    </div>
  );
}

// ---------------------------------------------------------------------------

function FluidToolbar({ result }: { result: ReturnType<typeof useSimulation> }) {
  const metric = useFluidStore((s) => s.metric);
  const setMetric = useFluidStore((s) => s.setMetric);
  const showTable = useFluidStore((s) => s.showTable);
  const toggleTable = useFluidStore((s) => s.toggleTable);

  const graph = useProjectStore((s) => s.project.channelGraph);
  const chipParams = useProjectStore((s) => s.project.chipParams);
  const { setup: fluidSetup } = useFluidInputs();
  const projectName = useProjectStore((s) => s.project.meta.name);
  const savedImages = useProjectStore((s) => s.project.savedImages);
  const addSavedImage = useProjectStore((s) => s.addSavedImage);

  const heatmapCount = savedImages.filter((i) => i.kind === 'heatmap').length;

  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-line bg-panel px-2 py-1.5">
      {/* Metric switcher — the heatmap shows one at a time, so this is the
          primary control on the tab. */}
      <div className="flex shrink-0 items-center gap-0.5 rounded-lg bg-sunken p-0.5">
        {METRICS.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setMetric(id)}
            aria-pressed={metric === id}
            className={cn(
              'oc-pressable rounded-md px-2.5 py-1 text-[12px] font-medium',
              metric === id ? 'bg-panel text-ink shadow-sm' : 'text-ink-muted hover:text-ink',
            )}
          >
            {METRIC_SHORT_LABEL[id]}
          </button>
        ))}
      </div>

      <div className="mx-1 h-5 w-px bg-line" />

      <button
        type="button"
        onClick={toggleTable}
        aria-pressed={showTable}
        title="Show the per-segment numbers"
        className={cn(
          'oc-pressable flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium',
          showTable ? 'bg-accent-wash text-accent' : 'text-ink-muted hover:bg-sunken hover:text-ink',
        )}
      >
        <Table2 size={14} />
        <span className="hidden lg:inline">Table</span>
      </button>

      <Button
        size="sm"
        variant="ghost"
        icon={<FileImage size={13} />}
        disabled={result.segments.length === 0}
        onClick={() => {
          const label = `${projectName} — ${METRIC_LABEL[metric].toLowerCase()} ${heatmapCount + 1}`;
          addSavedImage(
            heatmapSavedImage(graph, chipParams, fluidSetup, result, metric, label),
          );
          toast.success('Heatmap saved to the project', {
            description: 'A presentation-ready SVG, stored alongside your schematics.',
          });
        }}
      >
        Save heatmap
      </Button>

      <div className="ml-auto flex min-w-0 items-center gap-3 overflow-hidden pr-1 font-mono text-[11px] text-ink-quiet">
        {result.segments.length > 0 ? (
          <>
            {/* Ordered least- to most-useful, and dropped from the left as the
                window narrows: the segment count is a sanity check, the
                pressure and the volume are what a user sizes a run against. */}
            <span className="hidden whitespace-nowrap xl:inline">
              {result.segments.length} segments
            </span>
            <span className="hidden whitespace-nowrap lg:inline">
              peak Re{' '}
              {Math.max(...result.segments.map((s) => s.reynolds)).toFixed(
                Math.max(...result.segments.map((s) => s.reynolds)) < 10 ? 2 : 0,
              )}
            </span>
            <span className="whitespace-nowrap">
              max {Math.round(result.maxPressurePa).toLocaleString()} Pa
            </span>
            <VolumeReadout result={result} />
          </>
        ) : null}
      </div>
    </div>
  );
}

const seconds = (value: number): string =>
  value >= 100 ? value.toFixed(0) : value >= 1 ? value.toFixed(1) : value.toFixed(2);

/**
 * How much fluid the chip holds, and how long it takes to cross.
 *
 * The transit figure is a range because a branched network has no single
 * answer — but when the branches agree it collapses to one value, since
 * printing `8.0–8.0 s` implies a split the chip does not have.
 */
function VolumeReadout({ result }: { result: ReturnType<typeof useSimulation> }) {
  const { min, max } = result.transitTimeS;
  const single = max - min <= min * 0.01;

  return (
    <span className="whitespace-nowrap">
      {result.totalInternalVolumeUl.toFixed(1)} µL
      {max > 0 ? ` · transit ${single ? seconds(min) : `${seconds(min)}–${seconds(max)}`} s` : null}
    </span>
  );
}

function BlockedNotice({ reason }: { reason: string }) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-sm text-center">
        <Waves size={22} className="mx-auto text-ink-faint" strokeWidth={1.75} />
        <p className="mt-3 text-[13px] font-medium text-ink">Nothing to estimate yet</p>
        <p className="mt-1.5 text-[12px] leading-relaxed text-ink-muted">{reason}</p>
      </div>
    </div>
  );
}

/**
 * The persistent disclaimer.
 *
 * Always shown, and worth its space: the numbers above look like
 * simulation output, and a scientist deciding how much to trust them needs the
 * model's limits visible next to them rather than buried in documentation.
 */
function Disclaimer({ notes }: { notes: string[] }) {
  return (
    <div className="shrink-0 border-t border-line bg-panel px-3 py-1.5">
      <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-ink-muted">
        <Info size={12} className="mt-0.5 shrink-0 text-ink-faint" />
        <span>
          {CFD_DISCLAIMER}{' '}
          <WikiLink to="fluidDynamics">What the model does and does not include</WikiLink>
        </span>
      </p>
      {notes.map((note) => (
        <p key={note} className="mt-1 pl-[18px] text-[11px] leading-relaxed text-caution">
          {note}
        </p>
      ))}
    </div>
  );
}
