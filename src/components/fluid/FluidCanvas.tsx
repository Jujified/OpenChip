import paper from 'paper/dist/paper-core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { edgeCurve, nodeIndex, nodePoint, perpendicular, type Rect } from '../../lib/geometry';
import { getLoft } from '../../lib/loft';
import { drawGrid, readPalette, toPaper, type Palette } from '../../lib/paperScene';
import {
  buildScale,
  metricDomain,
  metricValue,
  type HeatmapMetric,
} from '../../lib/fluids/heatmap';
import { portFootprintMm } from '../../lib/ports';
import { reconcileFluidSetup } from '../../lib/fluids/reconcile';
import { useFluidStore } from '../../store/fluidStore';
import { useProjectStore } from '../../store/projectStore';
import type { SimulationResult } from '../../lib/fluids/simulate';

/**
 * The 2D heatmap.
 *
 * A read-only sibling of the drawing canvas rather than a mode of it — the
 * editor's hit-testing, snapping and tool state would all be dead weight here,
 * and the one thing this view must never do is let a stray click move a channel
 * while the user is reading numbers off it.
 *
 * The channel ribbon is drawn from the same loft solution the CAD pipeline
 * sweeps, so the coloured band is exactly the geometry the estimate ran on.
 */
export function FluidCanvas({
  result,
  metric,
}: {
  result: SimulationResult;
  metric: HeatmapMetric;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scopeRef = useRef<paper.PaperScope | null>(null);
  const layersRef = useRef<{ grid: paper.Layer; channels: paper.Layer } | null>(null);

  const graph = useProjectStore((s) => s.project.channelGraph);
  const chipParams = useProjectStore((s) => s.project.chipParams);
  const focusedEdgeId = useFluidStore((s) => s.focusedEdgeId);

  const [palette, setPalette] = useState<Palette | null>(null);
  const [dark, setDark] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  const [viewSize, setViewSize] = useState({ width: 0, height: 0 });

  const loft = useMemo(() => getLoft(graph, chipParams), [graph, chipParams]);

  // --- scale ---------------------------------------------------------------
  const scale = useMemo(() => {
    const domain = metricDomain(metric, result.segments);

    // Temperature diverges about the mean inlet temperature, so "unchanged"
    // reads as neutral and any departure reads as a departure.
    const inletTemps = result.segments.map((s) => s.temperatureInC);
    const centerC =
      metric === 'temperature' && inletTemps.length > 0
        ? inletTemps.reduce((a, b) => a + b, 0) / inletTemps.length
        : undefined;

    return buildScale(metric, domain, { dark, centerC });
  }, [result.segments, metric, dark]);

  // --- setup ---------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const scope = new paper.PaperScope();
    scope.setup(canvas);
    scope.settings.insertItems = false;
    scope.activate();

    const grid = new scope.Layer();
    const channels = new scope.Layer();
    scope.project.addLayer(grid);
    scope.project.addLayer(channels);

    scopeRef.current = scope;
    layersRef.current = { grid, channels };
    setPalette(readPalette());

    return () => {
      scope.project?.clear();
      scope.view?.remove();
      scopeRef.current = null;
      layersRef.current = null;
    };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setViewSize({ width, height });
      const scope = scopeRef.current;
      if (scope?.view) scope.view.viewSize = new paper.Size(width, height);
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const refresh = () => {
      setPalette(readPalette());
      setDark(media.matches);
    };
    media.addEventListener('change', refresh);
    return () => media.removeEventListener('change', refresh);
  }, []);

  // --- render --------------------------------------------------------------
  useEffect(() => {
    const scope = scopeRef.current;
    const layers = layersRef.current;
    if (!scope || !layers || !palette || viewSize.width === 0) return;

    scope.activate();

    // Fit the chip with a margin. The fluid view is read-only, so it frames
    // itself rather than carrying its own pan/zoom state to get out of step
    // with the drawing tab.
    const margin = 6;
    const zoom = Math.min(
      viewSize.width / (chipParams.width + margin * 2),
      viewSize.height / (chipParams.length + margin * 2),
    );
    scope.view.zoom = zoom;
    scope.view.center = toPaper({ x: chipParams.width / 2, y: chipParams.length / 2 });

    const visible: Rect = {
      x: -margin,
      y: -margin,
      width: chipParams.width + margin * 2,
      height: chipParams.length + margin * 2,
    };

    drawGrid(
      layers.grid,
      {
        graph,
        chipParams,
        loft,
        palette,
        selectedNodeIds: new Set(),
        selectedEdgeIds: new Set(),
        warnings: [],
        showGrid: false,
        showTaper: false,
        gridMm: 1,
        zoom,
      },
      visible,
    );

    // --- coloured channels ---------------------------------------------------
    const layer = layers.channels;
    layer.removeChildren();

    const nodes = nodeIndex(graph.nodes);
    const bySegment = new Map(result.segments.map((s) => [s.edgeId, s]));
    const px = (p: number) => p / zoom;

    for (const edge of graph.edges) {
      const solved = loft.edges.get(edge.id);
      const segment = bySegment.get(edge.id);
      if (!solved || solved.samples.length < 2) continue;

      const colour = segment
        ? scale.colorAt(metricValue(metric, segment))
        : palette.inkFaint;

      // Ribbon at the true local width, so a taper reads as a taper.
      const left: paper.Point[] = [];
      const right: paper.Point[] = [];
      for (const sample of solved.samples) {
        const normal = perpendicular(sample.tangent);
        const half = Math.max(sample.widthMm / 2, px(1.5));
        left.push(toPaper({
          x: sample.point.x + normal.x * half,
          y: sample.point.y + normal.y * half,
        }));
        right.push(toPaper({
          x: sample.point.x - normal.x * half,
          y: sample.point.y - normal.y * half,
        }));
      }

      const ribbon = new paper.Path({ segments: [...left, ...right.reverse()], closed: true });
      ribbon.fillColor = new paper.Color(colour);
      layer.addChild(ribbon);

      // The selected row in the table gets a ring rather than a colour change,
      // so the value it encodes stays readable while it is highlighted.
      if (focusedEdgeId === edge.id) {
        const from = nodes.get(edge.fromNodeId);
        const to = nodes.get(edge.toNodeId);
        if (from && to) {
          const curve = edgeCurve(edge, nodePoint(from), nodePoint(to));
          const halo = new paper.Path();
          halo.moveTo(toPaper(curve.p0));
          halo.cubicCurveTo(toPaper(curve.c0), toPaper(curve.c1), toPaper(curve.p1));
          halo.strokeColor = new paper.Color(palette.ink);
          halo.strokeWidth = px(2.5);
          halo.dashArray = [px(5), px(4)];
          layer.addChild(halo);
        }
      }
    }

    // --- ports ---------------------------------------------------------------
    const { fluidProfiles, fluidSetup } = useProjectStore.getState().project;
    const assignments = new Map(
      reconcileFluidSetup(graph, fluidSetup, fluidProfiles).assignments.map((a) => [a.portId, a]),
    );

    for (const node of graph.nodes) {
      if (node.type !== 'port') continue;
      const assignment = assignments.get(node.id);
      const radius = Math.max(portFootprintMm(node.portType, node.customSpec) / 2, px(5));

      const ring = new paper.Path.Circle(toPaper(nodePoint(node)), radius);
      ring.fillColor = new paper.Color(palette.panel);
      ring.strokeColor = new paper.Color(
        assignment?.role === 'inlet' ? palette.accent : palette.chipEdge,
      );
      ring.strokeWidth = px(2);
      layer.addChild(ring);

      // Inlets get a filled center; outlets stay hollow. Shape, not colour
      // alone, so the roles survive greyscale and colour-vision deficiency.
      if (assignment?.role === 'inlet') {
        const dot = new paper.Path.Circle(toPaper(nodePoint(node)), radius * 0.45);
        dot.fillColor = new paper.Color(palette.accent);
        layer.addChild(dot);
      }
    }

    scope.view.update();
  }, [graph, chipParams, loft, palette, result, metric, scale, viewSize, focusedEdgeId]);

  return (
    <div ref={hostRef} className="relative h-full w-full overflow-hidden bg-canvas">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
    </div>
  );
}
