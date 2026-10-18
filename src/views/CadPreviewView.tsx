import { Box } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { CadPanel, MonolithicBanner } from '../components/cad/CadPanel';
import { CadToolbar } from '../components/cad/CadToolbar';
import { CadViewport, type CadViewportHandle } from '../components/cad/CadViewport';
import { ValidationPanel } from '../components/validation/ValidationPanel';
import { useCadStore } from '../store/cadStore';
import { useProjectStore } from '../store/projectStore';
import { Placeholder } from './Placeholder';

/** Long enough to coalesce a slider drag, short enough to feel attached to it. */
const REBUILD_DEBOUNCE_MS = 90;

/**
 * How long the graph must hold still before the preview is rebuilt at export
 * quality.
 *
 * The fast path above is unchanged — a drag still gets a coarse build 90 ms in,
 * so the chip keeps up with the slider. This second pass only fires once the
 * user has actually stopped, and replaces that coarse build with the same
 * tessellation the STL will carry. The gap has to clear a pause between two
 * deliberate edits without feeling like a separate event; a third of a second
 * reads as the view settling rather than as something new happening.
 */
const REFINE_IDLE_MS = 350;

export function CadPreviewView() {
  const graph = useProjectStore((s) => s.project.channelGraph);
  const chipParams = useProjectStore((s) => s.project.chipParams);
  const drainageVents = useProjectStore((s) => s.project.drainageVents);
  const requestBuild = useCadStore((s) => s.requestBuild);
  const setSnapshotProvider = useCadStore((s) => s.setSnapshotProvider);
  const viewport = useRef<CadViewportHandle | null>(null);

  // Lends the live viewport to the presentation export, which can be triggered
  // from any tab. Cleared on the way out: a WebGL context that is no longer on
  // screen has nothing to read back, and a stale handle would hand the export a
  // blank image instead of an honest "no CAD view captured yet".
  useEffect(() => {
    setSnapshotProvider((scale) => viewport.current?.snapshot(scale) ?? null);
    return () => setSnapshotProvider(null);
  }, [setSnapshotProvider]);

  // Rebuild whenever the geometry or any parameter changes. The worker
  // coalesces, so a fast drag collapses into one build rather than a backlog.
  //
  // Two passes, deliberately. The coarse one keeps the chip attached to the
  // control being dragged; the refined one lands after the user stops, so what
  // sits on screen at rest is the geometry that would be exported rather than a
  // preview approximation of it.
  useEffect(() => {
    const coarse = setTimeout(
      () => requestBuild(graph, chipParams, 1, drainageVents),
      REBUILD_DEBOUNCE_MS,
    );
    const refined = setTimeout(
      () => requestBuild(graph, chipParams, 2, drainageVents),
      REFINE_IDLE_MS,
    );
    return () => {
      clearTimeout(coarse);
      clearTimeout(refined);
    };
  }, [graph, chipParams, drainageVents, requestBuild]);

  if (graph.edges.length === 0) {
    return (
      <Placeholder
        icon={<Box size={22} strokeWidth={1.75} />}
        eyebrow="Nothing to model yet"
        title="Draw a channel network first"
        description="The CAD preview sweeps your 2D channels into a solid chip. Start from a template, or lay down a path yourself."
        bullets={[
          'Channels are swept at the width your dimension markers set',
          'Chambers and ports are unioned in, then subtracted from the block',
          'Two-piece chips are cut into a channel plate and a lid',
          'Export STL, OpenSCAD source and viewport snapshots',
        ]}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <CadToolbar viewport={viewport} />
      <MonolithicBanner />
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          <CadViewport ref={viewport} chipParams={chipParams} />
        </div>
        <CadPanel viewport={viewport} />
      </div>
      <ValidationPanel />
    </div>
  );
}
