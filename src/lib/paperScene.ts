/**
 * Paper.js scene construction.
 *
 * Paper's role here is renderer and view transform, not model. The
 * `channelGraph` in the store stays the single source of truth; this module
 * projects it onto a canvas and, via the same code path, onto an exported SVG.
 * That is deliberate — a schematic that disagrees with what was on screen would
 * be worse than no export at all.
 *
 * Coordinates: chip space is millimetres with +Y up, origin at the chip's
 * bottom-left. Paper's Y axis points down, so the projection is a Y flip and
 * nothing else — `view.zoom` then reads directly as pixels per millimetre.
 */

import paper from 'paper/dist/paper-core';
import { adaptiveGridMm, type SnapResult } from './snapping';
import { edgeCurve, nodeIndex, nodePoint, perpendicular, type Rect } from './geometry';
import type { LoftSolution, SolvedEdge } from './loft';
import type { EdgeSpacingWarning } from './graphOps';
import type {
  ChannelGraph,
  ChannelNode,
  ChipParams,
  Point2,
} from '../types/project';
import { portFootprintMm } from './ports';

// ---------------------------------------------------------------------------
// projection
// ---------------------------------------------------------------------------

export const toPaper = (p: Point2): paper.Point => new paper.Point(p.x, -p.y);
export const toChip = (p: paper.Point): Point2 => ({ x: p.x, y: -p.y });

// ---------------------------------------------------------------------------
// palette
//
// Read from CSS custom properties so the canvas follows the app's light/dark
// tokens instead of maintaining a second, drifting set of colours.
// ---------------------------------------------------------------------------

export interface Palette {
  gridMinor: string;
  gridMajor: string;
  chipEdge: string;
  clearance: string;
  channel: string;
  channelFill: string;
  centerline: string;
  node: string;
  port: string;
  chamber: string;
  accent: string;
  danger: string;
  caution: string;
  ink: string;
  inkFaint: string;
  panel: string;
}

const cssVar = (name: string, fallback: string): string => {
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
};

export function readPalette(): Palette {
  const accent = cssVar('--accent', '#5850ec');
  return {
    gridMinor: cssVar('--line', '#e4e4e7'),
    gridMajor: cssVar('--line-strong', '#d0d0d5'),
    chipEdge: cssVar('--ink-muted', '#6b7280'),
    clearance: cssVar('--caution', '#b45309'),
    channel: accent,
    channelFill: accent,
    centerline: cssVar('--ink', '#18181b'),
    node: cssVar('--ink', '#18181b'),
    port: accent,
    chamber: accent,
    accent,
    danger: cssVar('--danger', '#dc2626'),
    caution: cssVar('--caution', '#b45309'),
    ink: cssVar('--ink', '#18181b'),
    inkFaint: cssVar('--ink-faint', '#9ca3af'),
    panel: cssVar('--panel', '#ffffff'),
  };
}

// ---------------------------------------------------------------------------
// scene input
// ---------------------------------------------------------------------------

export interface SceneLayers {
  grid: paper.Layer;
  channels: paper.Layer;
  overlay: paper.Layer;
}

export interface SceneInput {
  graph: ChannelGraph;
  chipParams: ChipParams;
  loft: LoftSolution;
  palette: Palette;
  selectedNodeIds: Set<string>;
  selectedEdgeIds: Set<string>;
  warnings: EdgeSpacingWarning[];
  showGrid: boolean;
  showTaper: boolean;
  gridMm: number;
  /** Pixels per mm — every stroke width is derived from this to stay crisp. */
  zoom: number;
  hoverNodeId?: string | null;
  hoverEdgeId?: string | null;
  snapIndicator?: SnapResult | null;
  drawPreview?: { from: Point2; to: Point2 } | null;
  marquee?: Rect | null;
  /** Ghosted geometry from the array-repeat dialog, before it is committed. */
  ghost?: { nodes: ChannelNode[]; edges: ChannelGraph['edges'] } | null;
  /** Elements called out by the warning the user clicked in the checks panel. */
  flagged?: { nodeIds: Set<string>; edgeIds: Set<string> } | null;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** A stroke that renders `px` pixels wide at the current zoom. */
const px = (pixels: number, zoom: number): number => pixels / Math.max(1e-6, zoom);

function chipRect(chipParams: ChipParams): paper.Rectangle {
  return new paper.Rectangle(
    toPaper({ x: 0, y: chipParams.length }),
    toPaper({ x: chipParams.width, y: 0 }),
  );
}

// ---------------------------------------------------------------------------
// grid + chip
// ---------------------------------------------------------------------------

export function drawGrid(layer: paper.Layer, input: SceneInput, visibleMm: Rect): void {
  layer.removeChildren();
  const { palette, chipParams, zoom } = input;

  if (input.showGrid) {
    const minor = adaptiveGridMm(input.gridMm, zoom);
    const major = minor * 10;
    const hair = px(1, zoom);

    const startX = Math.floor(visibleMm.x / minor) * minor;
    const endX = visibleMm.x + visibleMm.width;
    const startY = Math.floor(visibleMm.y / minor) * minor;
    const endY = visibleMm.y + visibleMm.height;

    // One compound path per weight rather than thousands of Path objects —
    // Paper handles a few big paths far better than many small ones when
    // panning.
    const minorPath = new paper.CompoundPath({ children: [] });
    const majorPath = new paper.CompoundPath({ children: [] });

    for (let x = startX; x <= endX; x += minor) {
      const isMajor = Math.abs(x / major - Math.round(x / major)) < 1e-6;
      const line = new paper.Path.Line(
        toPaper({ x, y: visibleMm.y }),
        toPaper({ x, y: endY }),
      );
      (isMajor ? majorPath : minorPath).addChild(line);
    }
    for (let y = startY; y <= endY; y += minor) {
      const isMajor = Math.abs(y / major - Math.round(y / major)) < 1e-6;
      const line = new paper.Path.Line(
        toPaper({ x: visibleMm.x, y }),
        toPaper({ x: endX, y }),
      );
      (isMajor ? majorPath : minorPath).addChild(line);
    }

    minorPath.strokeColor = new paper.Color(palette.gridMinor);
    minorPath.strokeWidth = hair;
    minorPath.opacity = 0.6;
    majorPath.strokeColor = new paper.Color(palette.gridMajor);
    majorPath.strokeWidth = hair;

    layer.addChild(minorPath);
    layer.addChild(majorPath);
  }

  // Chip outline.
  const outline = new paper.Path.Rectangle(chipRect(chipParams));
  outline.strokeColor = new paper.Color(palette.chipEdge);
  outline.strokeWidth = px(1.5, zoom);
  outline.fillColor = new paper.Color(palette.panel);
  outline.fillColor.alpha = 0.35;
  outline.sendToBack();
  layer.addChild(outline);

  // Minimum-edge-spacing inset: the band a channel should stay out of.
  const inset = chipParams.minEdgeSpacing;
  if (inset > 0 && chipParams.width > inset * 2 && chipParams.length > inset * 2) {
    const clearance = new paper.Path.Rectangle(
      new paper.Rectangle(
        toPaper({ x: inset, y: chipParams.length - inset }),
        toPaper({ x: chipParams.width - inset, y: inset }),
      ),
    );
    clearance.strokeColor = new paper.Color(palette.clearance);
    clearance.strokeWidth = px(1, zoom);
    clearance.dashArray = [px(4, zoom), px(4, zoom)];
    clearance.opacity = 0.45;
    layer.addChild(clearance);
  }
}

// ---------------------------------------------------------------------------
// channels
// ---------------------------------------------------------------------------

/**
 * The variable-width ribbon: the taper preview the user needs *before* any 3D
 * exists. Built by offsetting the solved centerline samples by
 * half the local width on each side and closing the loop.
 */
function taperRibbon(solved: SolvedEdge): paper.Path | null {
  const points = solved.samples;
  if (points.length < 2) return null;

  const left: paper.Point[] = [];
  const right: paper.Point[] = [];

  for (const sample of points) {
    const normal = perpendicular(sample.tangent);
    const half = sample.widthMm / 2;
    left.push(toPaper({
      x: sample.point.x + normal.x * half,
      y: sample.point.y + normal.y * half,
    }));
    right.push(toPaper({
      x: sample.point.x - normal.x * half,
      y: sample.point.y - normal.y * half,
    }));
  }

  const path = new paper.Path({ segments: [...left, ...right.reverse()], closed: true });
  return path;
}

export function drawChannels(layer: paper.Layer, input: SceneInput): void {
  layer.removeChildren();
  const { graph, loft, palette, zoom, showTaper } = input;
  const nodes = nodeIndex(graph.nodes);

  for (const edge of graph.edges) {
    const from = nodes.get(edge.fromNodeId);
    const to = nodes.get(edge.toNodeId);
    if (!from || !to) continue;

    const selected = input.selectedEdgeIds.has(edge.id);
    const hovered = input.hoverEdgeId === edge.id;

    if (showTaper) {
      const solved = loft.edges.get(edge.id);
      if (solved) {
        const ribbon = taperRibbon(solved);
        if (ribbon) {
          ribbon.fillColor = new paper.Color(palette.channelFill);
          ribbon.fillColor.alpha = selected ? 0.42 : hovered ? 0.32 : 0.22;
          ribbon.strokeColor = new paper.Color(palette.channel);
          ribbon.strokeWidth = px(selected ? 1.25 : 0.75, zoom);
          ribbon.strokeColor.alpha = 0.55;
          layer.addChild(ribbon);
        }
      }
    }

    // Centerline. Always drawn: at low zoom the ribbon collapses to nothing,
    // and the user still needs to see the topology they are editing.
    const curve = edgeCurve(edge, nodePoint(from), nodePoint(to));
    const line = new paper.Path();
    line.moveTo(toPaper(curve.p0));
    line.cubicCurveTo(toPaper(curve.c0), toPaper(curve.c1), toPaper(curve.p1));
    line.strokeColor = new paper.Color(selected ? palette.accent : palette.centerline);
    line.strokeWidth = px(selected ? 2 : hovered ? 1.75 : 1.25, zoom);
    line.strokeCap = 'round';
    if (!selected && !hovered) line.opacity = 0.55;
    if (!showTaper && edge.curveType === 'bezier') line.dashArray = [];
    layer.addChild(line);
  }
}

// ---------------------------------------------------------------------------
// nodes and markers
// ---------------------------------------------------------------------------

function nodeGlyphRadiusMm(node: ChannelNode, zoom: number): number {
  // A minimum pixel size keeps nodes grabbable when zoomed out, while ports and
  // chambers show their true physical footprint once big enough to matter.
  const floor = px(3.5, zoom);
  if (node.type === 'chamber') return Math.max(floor, node.sizeMm / 2);
  if (node.type === 'port') return Math.max(floor, portFootprintMm(node.portType, node.customSpec) / 2);
  return floor;
}

export function drawOverlay(layer: paper.Layer, input: SceneInput): void {
  layer.removeChildren();
  const {
    graph,
    palette,
    zoom,
    selectedNodeIds,
    warnings,
    hoverNodeId,
    snapIndicator,
    drawPreview,
    marquee,
    ghost,
  } = input;

  const warned = new Map(warnings.map((w) => [w.nodeId, w]));
  const nodes = nodeIndex(graph.nodes);

  // --- ghost preview (array repeat) ---------------------------------------
  if (ghost) {
    const ghostNodes = nodeIndex(ghost.nodes);
    for (const edge of ghost.edges) {
      const from = ghostNodes.get(edge.fromNodeId) ?? nodes.get(edge.fromNodeId);
      const to = ghostNodes.get(edge.toNodeId) ?? nodes.get(edge.toNodeId);
      if (!from || !to) continue;
      const curve = edgeCurve(edge, nodePoint(from), nodePoint(to));
      const line = new paper.Path();
      line.moveTo(toPaper(curve.p0));
      line.cubicCurveTo(toPaper(curve.c0), toPaper(curve.c1), toPaper(curve.p1));
      line.strokeColor = new paper.Color(palette.accent);
      line.strokeWidth = px(1.5, zoom);
      line.dashArray = [px(5, zoom), px(4, zoom)];
      line.opacity = 0.75;
      layer.addChild(line);
    }
    for (const node of ghost.nodes) {
      const dot = new paper.Path.Circle(toPaper(nodePoint(node)), px(2.5, zoom));
      dot.fillColor = new paper.Color(palette.accent);
      dot.opacity = 0.6;
      layer.addChild(dot);
    }
  }

  // --- dimension markers ---------------------------------------------------
  for (const edge of graph.edges) {
    if (edge.dimensionPoints.length === 0) continue;
    const from = nodes.get(edge.fromNodeId);
    const to = nodes.get(edge.toNodeId);
    if (!from || !to) continue;
    const curve = edgeCurve(edge, nodePoint(from), nodePoint(to));

    for (const dp of edge.dimensionPoints) {
      const u = 1 - dp.t;
      const at = {
        x:
          u * u * u * curve.p0.x +
          3 * u * u * dp.t * curve.c0.x +
          3 * u * dp.t * dp.t * curve.c1.x +
          dp.t * dp.t * dp.t * curve.p1.x,
        y:
          u * u * u * curve.p0.y +
          3 * u * u * dp.t * curve.c0.y +
          3 * u * dp.t * dp.t * curve.c1.y +
          dp.t * dp.t * dp.t * curve.p1.y,
      };

      const size = px(4, zoom);
      const diamond = new paper.Path({
        segments: [
          toPaper({ x: at.x, y: at.y + size }),
          toPaper({ x: at.x + size, y: at.y }),
          toPaper({ x: at.x, y: at.y - size }),
          toPaper({ x: at.x - size, y: at.y }),
        ],
        closed: true,
      });
      diamond.fillColor = new paper.Color(palette.panel);
      diamond.strokeColor = new paper.Color(palette.caution);
      diamond.strokeWidth = px(1.5, zoom);
      layer.addChild(diamond);
    }
  }

  // --- bezier handles, for selected edges only -----------------------------
  for (const edge of graph.edges) {
    if (!input.selectedEdgeIds.has(edge.id)) continue;
    if (edge.curveType !== 'bezier' || !edge.controlPoints) continue;

    const from = nodes.get(edge.fromNodeId);
    const to = nodes.get(edge.toNodeId);
    if (!from || !to) continue;

    const anchors = [nodePoint(from), nodePoint(to)];
    edge.controlPoints.slice(0, 2).forEach((handle, i) => {
      const stem = new paper.Path.Line(toPaper(anchors[i]), toPaper(handle));
      stem.strokeColor = new paper.Color(palette.accent);
      stem.strokeWidth = px(1, zoom);
      stem.opacity = 0.6;
      layer.addChild(stem);

      const dot = new paper.Path.Circle(toPaper(handle), px(4, zoom));
      dot.fillColor = new paper.Color(palette.panel);
      dot.strokeColor = new paper.Color(palette.accent);
      dot.strokeWidth = px(1.5, zoom);
      layer.addChild(dot);
    });
  }

  // --- nodes ---------------------------------------------------------------
  for (const node of graph.nodes) {
    const center = toPaper(nodePoint(node));
    const radius = nodeGlyphRadiusMm(node, zoom);
    const selected = selectedNodeIds.has(node.id);
    const hovered = hoverNodeId === node.id;
    const warning = warned.get(node.id);

    if (node.type === 'chamber') {
      const body = new paper.Path.Circle(center, radius);
      body.fillColor = new paper.Color(palette.chamber);
      body.fillColor.alpha = 0.28;
      body.strokeColor = new paper.Color(palette.chamber);
      body.strokeWidth = px(selected ? 2 : 1.25, zoom);
      layer.addChild(body);

      // A cylinder reads as a circle from directly above, so it gets an inner
      // ring to tell it apart from a sphere at a glance.
      if (node.shape === 'cylinder') {
        const inner = new paper.Path.Circle(center, radius * 0.6);
        inner.strokeColor = new paper.Color(palette.chamber);
        inner.strokeWidth = px(1, zoom);
        inner.opacity = 0.7;
        layer.addChild(inner);
      }
    } else if (node.type === 'port') {
      const body = new paper.Path.Circle(center, radius);
      body.fillColor = new paper.Color(palette.panel);
      body.strokeColor = new paper.Color(palette.port);
      body.strokeWidth = px(selected ? 2.5 : 1.75, zoom);
      layer.addChild(body);

      const bore = new paper.Path.Circle(center, Math.max(px(1.5, zoom), node.diameterMm / 2));
      bore.fillColor = new paper.Color(palette.port);
      bore.fillColor.alpha = 0.85;
      layer.addChild(bore);
    } else {
      const dot = new paper.Path.Circle(center, radius);
      dot.fillColor = new paper.Color(selected ? palette.accent : palette.panel);
      dot.strokeColor = new paper.Color(selected ? palette.accent : palette.node);
      dot.strokeWidth = px(selected ? 2 : 1.25, zoom);
      if (!selected && !hovered) dot.opacity = 0.85;
      layer.addChild(dot);
    }

    if (selected) {
      const ring = new paper.Path.Circle(center, radius + px(4, zoom));
      ring.strokeColor = new paper.Color(palette.accent);
      ring.strokeWidth = px(1, zoom);
      ring.dashArray = [px(3, zoom), px(3, zoom)];
      layer.addChild(ring);
    }

    // Non-blocking clearance flag — a coloured ring, never a
    // dialog, and it never prevents anything.
    if (warning) {
      const ring = new paper.Path.Circle(center, radius + px(7, zoom));
      ring.strokeColor = new paper.Color(warning.outside ? palette.danger : palette.caution);
      ring.strokeWidth = px(2, zoom);
      ring.opacity = 0.9;
      layer.addChild(ring);
    }
  }

  // --- rubber band while drawing ------------------------------------------
  if (drawPreview) {
    const line = new paper.Path.Line(toPaper(drawPreview.from), toPaper(drawPreview.to));
    line.strokeColor = new paper.Color(palette.accent);
    line.strokeWidth = px(1.5, zoom);
    line.dashArray = [px(5, zoom), px(4, zoom)];
    layer.addChild(line);
  }

  // --- snap indicator ------------------------------------------------------
  if (snapIndicator && snapIndicator.kind !== 'none') {
    const at = toPaper(snapIndicator.point);
    const size = px(7, zoom);

    if (snapIndicator.kind === 'endpoint') {
      // A filled ring: this snap will weld the paths together, which is a
      // topological change and deserves the loudest indicator.
      const ring = new paper.Path.Circle(at, size);
      ring.strokeColor = new paper.Color(palette.accent);
      ring.strokeWidth = px(2.5, zoom);
      layer.addChild(ring);
    } else {
      const cross = new paper.CompoundPath({
        children: [
          new paper.Path.Line(at.add(new paper.Point(-size, 0)), at.add(new paper.Point(size, 0))),
          new paper.Path.Line(at.add(new paper.Point(0, -size)), at.add(new paper.Point(0, size))),
        ],
      });
      cross.strokeColor = new paper.Color(
        snapIndicator.kind === 'angle' ? palette.accent : palette.inkFaint,
      );
      cross.strokeWidth = px(1.5, zoom);
      layer.addChild(cross);
    }
  }

  // --- flagged elements ----------------------------------------------------
  // Drawn last so the call-out sits above everything: clicking a warning has to
  // make the offending element obvious immediately, not subtly.
  if (input.flagged) {
    const pulse = new paper.Color(palette.caution);

    for (const edge of graph.edges) {
      if (!input.flagged.edgeIds.has(edge.id)) continue;
      const from = nodes.get(edge.fromNodeId);
      const to = nodes.get(edge.toNodeId);
      if (!from || !to) continue;

      const curve = edgeCurve(edge, nodePoint(from), nodePoint(to));
      const halo = new paper.Path();
      halo.moveTo(toPaper(curve.p0));
      halo.cubicCurveTo(toPaper(curve.c0), toPaper(curve.c1), toPaper(curve.p1));
      halo.strokeColor = pulse;
      halo.strokeWidth = px(7, zoom);
      halo.strokeCap = 'round';
      halo.opacity = 0.35;
      layer.addChild(halo);
    }

    for (const node of graph.nodes) {
      if (!input.flagged.nodeIds.has(node.id)) continue;
      const ring = new paper.Path.Circle(
        toPaper(nodePoint(node)),
        nodeGlyphRadiusMm(node, zoom) + px(9, zoom),
      );
      ring.strokeColor = pulse;
      ring.strokeWidth = px(2.5, zoom);
      ring.fillColor = pulse;
      ring.fillColor.alpha = 0.12;
      layer.addChild(ring);
    }
  }

  // --- marquee -------------------------------------------------------------
  if (marquee) {
    const rect = new paper.Path.Rectangle(
      new paper.Rectangle(
        toPaper({ x: marquee.x, y: marquee.y + marquee.height }),
        toPaper({ x: marquee.x + marquee.width, y: marquee.y }),
      ),
    );
    rect.strokeColor = new paper.Color(palette.accent);
    rect.strokeWidth = px(1, zoom);
    rect.dashArray = [px(4, zoom), px(3, zoom)];
    rect.fillColor = new paper.Color(palette.accent);
    rect.fillColor.alpha = 0.08;
    layer.addChild(rect);
  }
}

/** Rebuilds every layer. Called from a rAF-throttled effect. */
export function renderScene(layers: SceneLayers, input: SceneInput, visibleMm: Rect): void {
  drawGrid(layers.grid, input, visibleMm);
  drawChannels(layers.channels, input);
  drawOverlay(layers.overlay, input);
}
