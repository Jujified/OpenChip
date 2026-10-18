import paper from 'paper/dist/paper-core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clamp, distance, nodeIndex, nodePoint, sub, type Rect } from '../../lib/geometry';
import {
  buildArrayRepeat,
  connect,
  deleteElements,
  extractFragment,
  findEdgeSpacingWarnings,
  fragmentEndpoints,
  makeWaypoint,
  moveNodes,
  nodeFootprintMm,
  setNodePosition,
  splitEdgeAt,
  updateEdge,
} from '../../lib/graphOps';
import { edgesWithinNodes, hitTest, nodesInRect, type HitTarget } from '../../lib/hitTest';
import { getLoft, moveDimensionPoint, upsertDimensionPoint, widthOnEdgeAt } from '../../lib/loft';
import {
  drawChannels,
  drawGrid,
  drawOverlay,
  readPalette,
  toChip,
  toPaper,
  type Palette,
  type SceneInput,
  type SceneLayers,
} from '../../lib/paperScene';
import { resolveSnap, toleranceFromZoom, type SnapResult } from '../../lib/snapping';
import { useCursorStore } from '../../store/cursorStore';
import { useEditorStore } from '../../store/editorStore';
import { useValidationStore } from '../../store/validationStore';
import { useProjectStore } from '../../store/projectStore';
import type { Point2 } from '../../types/project';
import { CursorReadout } from './CursorReadout';
import { EmptyCanvasHint } from './EmptyCanvasHint';
import { RULER_PX, Rulers } from './Rulers';

const MIN_ZOOM = 1;
const MAX_ZOOM = 200;
/** Anything that acts on its own keys, or that holds keys while it is open. */
const KEY_OWNER_SELECTOR = [
  'button',
  'a[href]',
  '[role="button"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="tab"]',
  '[role="menu"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
].join(', ');

const OPEN_MODAL_SELECTOR = '[role="dialog"][data-state="open"], [aria-modal="true"]';

/**
 * Whether a key press is meant for something other than the canvas.
 *
 * The canvas listens on `window`, so it hears every key. Delete, Backspace and
 * Escape pressed in a field, on a focused button, in a menu or behind an open
 * dialog belong to that control: Backspace in the Settings dialog must not
 * delete the selection behind it, and Escape that closes a dialog must not
 * also clear the selection.
 */
function keyBelongsElsewhere(event: KeyboardEvent): boolean {
  if (event.defaultPrevented) return true;
  const target = event.target instanceof Element ? event.target : null;
  if (target) {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return true;
    if (target instanceof HTMLElement && target.isContentEditable) return true;
    if (target.closest(KEY_OWNER_SELECTOR)) return true;
  }
  return document.querySelector(OPEN_MODAL_SELECTOR) !== null;
}

/** Pointer travel, in pixels, before a press counts as a drag rather than a click. */
const DRAG_THRESHOLD_PX = 3;

type Gesture =
  | { kind: 'none' }
  | { kind: 'pan'; lastClient: Point2 }
  | { kind: 'marquee'; originMm: Point2; additive: boolean }
  | { kind: 'move-nodes'; nodeIds: string[]; lastMm: Point2; moved: boolean }
  | { kind: 'move-handle'; edgeId: string; handleIndex: 0 | 1; moved: boolean }
  | { kind: 'move-dimension'; edgeId: string; index: number; moved: boolean };

export function DrawCanvas() {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scopeRef = useRef<paper.PaperScope | null>(null);
  const layersRef = useRef<SceneLayers | null>(null);
  const frameRef = useRef<number | null>(null);

  const graph = useProjectStore((s) => s.project.channelGraph);
  const chipParams = useProjectStore((s) => s.project.chipParams);
  const updateGraph = useProjectStore((s) => s.updateGraph);
  const beginGraphEdit = useProjectStore((s) => s.beginGraphEdit);
  const endGraphEdit = useProjectStore((s) => s.endGraphEdit);

  const tool = useEditorStore((s) => s.tool);
  const selection = useEditorStore((s) => s.selection);
  const snapSettings = useEditorStore((s) => s.snap);
  const view = useEditorStore((s) => s.view);
  const setView = useEditorStore((s) => s.setView);
  const draw = useEditorStore((s) => s.draw);
  const setDraw = useEditorStore((s) => s.setDraw);
  const resetDraw = useEditorStore((s) => s.resetDraw);
  const showGrid = useEditorStore((s) => s.showGrid);
  const showTaper = useEditorStore((s) => s.showTaper);
  const setSelection = useEditorStore((s) => s.setSelection);
  const selectNodes = useEditorStore((s) => s.selectNodes);
  const selectEdges = useEditorStore((s) => s.selectEdges);

  // Elements called out by the warning the user clicked in the checks panel.
  const focusedTarget = useValidationStore((s) => s.focusedTarget);
  const flagged = useMemo(
    () =>
      focusedTarget
        ? {
            nodeIds: new Set(focusedTarget.nodeIds),
            edgeIds: new Set(focusedTarget.edgeIds),
          }
        : null,
    [focusedTarget],
  );

  const [palette, setPalette] = useState<Palette | null>(null);
  // Both are recomputed on every pointer-move, and each recomputation is a new
  // object. Stored as-is, merely moving across a segment "changed" them every
  // move and repainted the scene; these setters keep the previous object while
  // it still names the same thing, so a move that changes nothing renders
  // nothing.
  const [hover, setHoverRaw] = useState<HitTarget>(null);
  const setHover = useCallback(
    (next: HitTarget) => setHoverRaw((prev) => (sameHitTarget(prev, next) ? prev : next)),
    [],
  );
  const [snapIndicator, setSnapRaw] = useState<SnapResult | null>(null);
  const setSnapIndicator = useCallback(
    (next: SnapResult | null) => setSnapRaw((prev) => (sameSnap(prev, next) ? prev : next)),
    [],
  );
  const setCursorMm = useCursorStore.getState().setCursorMm;
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const [viewSize, setViewSize] = useState({ width: 0, height: 0 });

  const gestureRef = useRef<Gesture>({ kind: 'none' });
  const pressRef = useRef<{ client: Point2; mm: Point2; hit: HitTarget } | null>(null);

  // Mirrors for event handlers, which are registered once and would otherwise
  // close over stale state.
  const stateRef = useRef({ graph, chipParams, tool, selection, snapSettings, view, draw });
  stateRef.current = { graph, chipParams, tool, selection, snapSettings, view, draw };

  const loft = useMemo(() => getLoft(graph, chipParams), [graph, chipParams]);

  // Live array-repeat preview, drawn ghosted on the canvas before the user
  // commits — the panel's node count alone is not a preview.
  const arrayParams = useEditorStore((s) => s.array);
  const ghost = useMemo(() => {
    if (selection.nodeIds.length === 0) return null;
    const fragment = extractFragment(graph, selection.nodeIds);
    if (!fragmentEndpoints(fragment)) return null;
    const preview = buildArrayRepeat(
      fragment,
      { count: arrayParams.count, spacingMm: arrayParams.spacingMm, alternate: arrayParams.alternate },
      chipParams,
    );
    return preview ? { nodes: preview.nodes, edges: preview.edges } : null;
  }, [graph, chipParams, selection.nodeIds, arrayParams]);

  const warnings = useMemo(
    () =>
      findEdgeSpacingWarnings(graph, chipParams, (node) => nodeFootprintMm(node, chipParams)),
    [graph, chipParams],
  );

  // -------------------------------------------------------------------------
  // paper setup
  // -------------------------------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const scope = new paper.PaperScope();
    scope.setup(canvas);
    scope.settings.insertItems = false;
    scope.activate();

    const grid = new scope.Layer();
    const channels = new scope.Layer();
    const overlay = new scope.Layer();
    scope.project.addLayer(grid);
    scope.project.addLayer(channels);
    scope.project.addLayer(overlay);

    scopeRef.current = scope;
    layersRef.current = { grid, channels, overlay };
    setPalette(readPalette());

    return () => {
      // PaperScope has no public teardown; clearing the project and removing
      // the view releases the canvas so StrictMode's double-mount does not
      // leave two scopes fighting over it.
      scope.project?.clear();
      scope.view?.remove();
      scopeRef.current = null;
      layersRef.current = null;
    };
  }, []);

  // Track container size so the canvas backing store matches its CSS box.
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

  // Follow the app's colour scheme.
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const refresh = () => setPalette(readPalette());
    media.addEventListener('change', refresh);
    return () => media.removeEventListener('change', refresh);
  }, []);

  // -------------------------------------------------------------------------
  // render
  // -------------------------------------------------------------------------

  const visibleRectMm = useMemo((): Rect => {
    const wMm = viewSize.width / view.zoom;
    const hMm = viewSize.height / view.zoom;
    return {
      x: view.center.x - wMm / 2,
      y: view.center.y - hMm / 2,
      width: wMm,
      height: hMm,
    };
  }, [viewSize, view]);

  // Each layer is redrawn only when its own inputs change. One repaint used to
  // rebuild all three for anything at all — the grid and every channel ribbon
  // again because the hover target or the snap cross moved — and all of it on
  // the pointer-move that caused it. Now the effects below only mark layers
  // dirty; one frame then rebuilds just those and paints once.
  const dirtyRef = useRef({ grid: true, channels: true, overlay: true });
  const sceneInputRef = useRef<{ input: SceneInput; visible: Rect } | null>(null);
  sceneInputRef.current = palette
    ? {
        input: {
          graph,
          chipParams,
          loft,
          palette,
          selectedNodeIds: new Set(selection.nodeIds),
          selectedEdgeIds: new Set(selection.edgeIds),
          warnings,
          showGrid,
          showTaper,
          gridMm: snapSettings.gridMm,
          zoom: view.zoom,
          hoverNodeId: hover?.kind === 'node' ? hover.nodeId : null,
          hoverEdgeId: hover?.kind === 'edge' ? hover.edgeId : null,
          snapIndicator,
          drawPreview: drawPreviewFor(),
          marquee,
          ghost,
          flagged,
        },
        visible: visibleRectMm,
      }
    : null;

  const schedulePaint = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const scope = scopeRef.current;
      const layers = layersRef.current;
      const scene = sceneInputRef.current;
      if (!scope || !layers || !scene) return;

      scope.activate();
      scope.view.zoom = scene.input.zoom;
      scope.view.center = toPaper(stateRef.current.view.center);

      const dirty = dirtyRef.current;
      if (dirty.grid) drawGrid(layers.grid, scene.input, scene.visible);
      if (dirty.channels) drawChannels(layers.channels, scene.input);
      if (dirty.overlay) drawOverlay(layers.overlay, scene.input);
      dirtyRef.current = { grid: false, channels: false, overlay: false };
      scope.view.update();
    });
  }, []);

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    },
    [],
  );

  const hoverEdgeId = hover?.kind === 'edge' ? hover.edgeId : null;
  const hoverNodeId = hover?.kind === 'node' ? hover.nodeId : null;

  // A pan only moves the view transform: the channels and overlay are in chip
  // space and stay as they are; only the grid, drawn to the visible rect, is
  // rebuilt.
  useEffect(() => {
    dirtyRef.current.grid = true;
    schedulePaint();
  }, [visibleRectMm, showGrid, snapSettings.gridMm, palette, chipParams, schedulePaint]);

  useEffect(() => {
    dirtyRef.current.channels = true;
    schedulePaint();
  }, [graph, loft, selection, showTaper, view.zoom, palette, hoverEdgeId, schedulePaint]);

  useEffect(() => {
    dirtyRef.current.overlay = true;
    schedulePaint();
  }, [
    graph,
    selection,
    warnings,
    view.zoom,
    palette,
    hoverNodeId,
    snapIndicator,
    marquee,
    ghost,
    flagged,
    draw,
    schedulePaint,
  ]);

  function drawPreviewFor(): { from: Point2; to: Point2 } | null {
    const { draw: session, graph: g } = stateRef.current;
    if (stateRef.current.tool !== 'draw' || !session.lastNodeId || !session.preview) return null;
    const from = g.nodes.find((n) => n.id === session.lastNodeId);
    return from ? { from: nodePoint(from), to: session.preview } : null;
  }

  // -------------------------------------------------------------------------
  // coordinate helpers
  // -------------------------------------------------------------------------

  const clientToMm = useCallback((clientX: number, clientY: number): Point2 => {
    const scope = scopeRef.current;
    const canvas = canvasRef.current;
    if (!scope || !canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const projected = scope.view.viewToProject(
      new paper.Point(clientX - rect.left, clientY - rect.top),
    );
    return toChip(projected);
  }, []);

  const toleranceMm = useCallback(() => toleranceFromZoom(stateRef.current.view.zoom, 9), []);

  const computeSnap = useCallback(
    (raw: Point2, origin: Point2 | null, exclude?: Set<string>): SnapResult => {
      const { graph: g, snapSettings: snap } = stateRef.current;
      return resolveSnap(raw, snap, {
        candidates: g.nodes,
        exclude,
        origin,
        toleranceMm: toleranceMm(),
      });
    },
    [toleranceMm],
  );

  // -------------------------------------------------------------------------
  // pointer handling
  // -------------------------------------------------------------------------

  /** Draw tool: each press lays a node and links it to the previous one. */
  const handleDrawPress = useCallback(
    (rawMm: Point2) => {
      const { draw: session, graph: g, chipParams: cp } = stateRef.current;
      const origin = session.lastNodeId
        ? (g.nodes.find((n) => n.id === session.lastNodeId) ?? null)
        : null;
      // The run's last node can vanish under it — undone, or replaced by an
      // opened template. Then this press starts a fresh run rather than
      // linking to an id that no longer exists.
      const fromId = origin?.id ?? null;
      const created = origin ? session.createdNodeIds : [];

      const snap = computeSnap(rawMm, origin ? nodePoint(origin) : null);
      const existingId = snap.kind === 'endpoint' ? snap.nodeId : undefined;

      let newNodeId = existingId ?? '';
      updateGraph(
        (current) => {
          let next = current;

          if (!existingId) {
            const node = makeWaypoint(snap.point);
            newNodeId = node.id;
            next = { ...next, nodes: [...next.nodes, node] };
          }

          if (fromId && newNodeId && fromId !== newNodeId) {
            next = connect(next, fromId, newNodeId, cp);
          }
          return next;
        },
        { label: 'draw segment' },
      );

      setDraw({
        lastNodeId: newNodeId,
        preview: snap.point,
        createdNodeIds: existingId ? created : [...created, newNodeId],
      });
    },
    [computeSnap, setDraw, updateGraph],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.setPointerCapture(event.pointerId);
      canvas.focus();

      const mm = clientToMm(event.clientX, event.clientY);
      const { tool: activeTool, selection: sel, graph: g } = stateRef.current;

      // Middle button or space-drag pans regardless of tool.
      if (event.button === 1 || event.altKey) {
        gestureRef.current = { kind: 'pan', lastClient: { x: event.clientX, y: event.clientY } };
        return;
      }
      if (event.button !== 0) return;

      const hit = hitTest(g, mm, {
        toleranceMm: toleranceMm(),
        handlesForEdgeIds: new Set(sel.edgeIds),
        includeDimensionMarkers: activeTool === 'dimension' || activeTool === 'select',
        markersOutrankNodes: activeTool === 'dimension',
      });

      pressRef.current = { client: { x: event.clientX, y: event.clientY }, mm, hit };

      if (activeTool === 'draw') {
        handleDrawPress(mm);
        return;
      }

      if (activeTool === 'dimension') {
        // Grabbing an existing marker drags it; otherwise a press on an edge
        // drops a new one on release.
        if (hit?.kind === 'dimension') {
          const edge = g.edges.find((e) => e.id === hit.edgeId);
          const order = [...(edge?.dimensionPoints ?? [])].sort((a, b) => a.t - b.t);
          const index = order.findIndex((dp) => dp.t === hit.t);
          if (index >= 0) {
            beginGraphEdit('move dimension marker');
            gestureRef.current = { kind: 'move-dimension', edgeId: hit.edgeId, index, moved: false };
          }
        }
        return;
      }

      // --- select tool -------------------------------------------------------
      if (hit?.kind === 'handle') {
        beginGraphEdit('shape curve');
        gestureRef.current = {
          kind: 'move-handle',
          edgeId: hit.edgeId,
          handleIndex: hit.handleIndex,
          moved: false,
        };
        return;
      }

      if (hit?.kind === 'node') {
        const already = sel.nodeIds.includes(hit.nodeId);
        const nodeIds = event.shiftKey
          ? already
            ? sel.nodeIds.filter((id) => id !== hit.nodeId)
            : [...sel.nodeIds, hit.nodeId]
          : already
            ? sel.nodeIds
            : [hit.nodeId];

        setSelection({ nodeIds, edgeIds: edgesWithinNodes(g, nodeIds) });
        beginGraphEdit('move nodes');
        gestureRef.current = { kind: 'move-nodes', nodeIds, lastMm: mm, moved: false };
        return;
      }

      if (hit?.kind === 'edge') {
        selectEdges([hit.edgeId], event.shiftKey);
        return;
      }

      // A marker sits directly on its channel, so with the select tool it reads
      // as "show me this segment" — selecting the owning edge puts the marker's
      // width fields in the inspector. Without this the click falls through to
      // the marquee below and clears the selection instead.
      if (hit?.kind === 'dimension') {
        selectEdges([hit.edgeId], event.shiftKey);
        return;
      }

      // Empty space: start a marquee.
      if (!event.shiftKey) setSelection({ nodeIds: [], edgeIds: [] });
      gestureRef.current = { kind: 'marquee', originMm: mm, additive: event.shiftKey };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [beginGraphEdit, clientToMm, selectEdges, setSelection, toleranceMm, handleDrawPress],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const mm = clientToMm(event.clientX, event.clientY);
      setCursorMm(mm);

      const gesture = gestureRef.current;
      const { tool: activeTool, graph: g, draw: session, view: v } = stateRef.current;

      // --- pan ---------------------------------------------------------------
      if (gesture.kind === 'pan') {
        const dxPx = event.clientX - gesture.lastClient.x;
        const dyPx = event.clientY - gesture.lastClient.y;
        setView({
          center: {
            x: v.center.x - dxPx / v.zoom,
            // Chip Y is up, screen Y is down.
            y: v.center.y + dyPx / v.zoom,
          },
        });
        gestureRef.current = { ...gesture, lastClient: { x: event.clientX, y: event.clientY } };
        return;
      }

      const press = pressRef.current;
      const travelled = press
        ? Math.hypot(event.clientX - press.client.x, event.clientY - press.client.y)
        : 0;

      // --- marquee -----------------------------------------------------------
      if (gesture.kind === 'marquee') {
        if (travelled < DRAG_THRESHOLD_PX) return;
        setMarquee({
          x: Math.min(gesture.originMm.x, mm.x),
          y: Math.min(gesture.originMm.y, mm.y),
          width: Math.abs(mm.x - gesture.originMm.x),
          height: Math.abs(mm.y - gesture.originMm.y),
        });
        return;
      }

      // --- dragging nodes ----------------------------------------------------
      if (gesture.kind === 'move-nodes') {
        if (!gesture.moved && travelled < DRAG_THRESHOLD_PX) return;

        const dragging = new Set(gesture.nodeIds);
        // Single-node drags can weld onto another node; multi-node drags snap
        // to grid/angle only, since "which node welds" would be ambiguous.
        const snap =
          gesture.nodeIds.length === 1
            ? computeSnap(mm, null, dragging)
            : { point: mm, kind: 'none' as const };

        setSnapIndicator(gesture.nodeIds.length === 1 ? snap : null);
        setCursorMm(snap.point);

        const delta = sub(snap.point, gesture.lastMm);
        if (delta.x !== 0 || delta.y !== 0) {
          updateGraph(
            (current) =>
              gesture.nodeIds.length === 1
                ? setNodePosition(current, gesture.nodeIds[0], snap.point)
                : moveNodes(current, dragging, delta),
            { commit: false },
          );
        }

        gestureRef.current = { ...gesture, lastMm: snap.point, moved: true };
        return;
      }

      // --- dragging a bezier handle -----------------------------------------
      if (gesture.kind === 'move-handle') {
        if (!gesture.moved && travelled < DRAG_THRESHOLD_PX) return;
        updateGraph(
          (current) => {
            const edge = current.edges.find((e) => e.id === gesture.edgeId);
            if (!edge?.controlPoints) return current;
            const controlPoints = [...edge.controlPoints];
            controlPoints[gesture.handleIndex] = mm;
            return updateEdge(current, gesture.edgeId, { controlPoints });
          },
          { commit: false },
        );
        gestureRef.current = { ...gesture, moved: true };
        return;
      }

      // --- dragging a dimension marker --------------------------------------
      if (gesture.kind === 'move-dimension') {
        if (!gesture.moved && travelled < DRAG_THRESHOLD_PX) return;
        const nearest = nearestTOnEdge(g, gesture.edgeId, mm);
        if (nearest !== null) {
          updateGraph(
            (current) => {
              const edge = current.edges.find((e) => e.id === gesture.edgeId);
              if (!edge) return current;
              return updateEdge(current, gesture.edgeId, {
                dimensionPoints: moveDimensionPoint(edge.dimensionPoints, gesture.index, nearest),
              });
            },
            { commit: false },
          );
          gestureRef.current = { ...gesture, moved: true };
        }
        return;
      }

      // --- idle: hover + snap preview ---------------------------------------
      const hit = hitTest(g, mm, {
        toleranceMm: toleranceMm(),
        handlesForEdgeIds: new Set(stateRef.current.selection.edgeIds),
        includeDimensionMarkers: activeTool === 'dimension' || activeTool === 'select',
        markersOutrankNodes: activeTool === 'dimension',
      });
      setHover(hit);

      if (activeTool === 'draw') {
        const origin = session.lastNodeId
          ? (g.nodes.find((n) => n.id === session.lastNodeId) ?? null)
          : null;
        const snap = computeSnap(mm, origin ? nodePoint(origin) : null);
        setSnapIndicator(snap);
        setDraw({ preview: snap.point });
        // The readout follows the snap, so the number always names the point a
        // click would put a node on.
        setCursorMm(snap.point);
      } else {
        setSnapIndicator(null);
      }
    },
    [
      clientToMm,
      computeSnap,
      setCursorMm,
      setDraw,
      setHover,
      setSnapIndicator,
      setView,
      toleranceMm,
      updateGraph,
    ],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      canvas?.releasePointerCapture(event.pointerId);

      const gesture = gestureRef.current;
      const press = pressRef.current;
      const mm = clientToMm(event.clientX, event.clientY);
      const { graph: g, tool: activeTool, chipParams: cp } = stateRef.current;

      gestureRef.current = { kind: 'none' };
      pressRef.current = null;
      setSnapIndicator(null);
      // A drag that moved already turned its begin into an undo entry; one
      // that did not (a plain click) is dropped here, leaving redo intact.
      endGraphEdit();

      // --- marquee commit ----------------------------------------------------
      if (gesture.kind === 'marquee' && marquee) {
        const nodeIds = nodesInRect(g, marquee);
        const existing = gesture.additive ? stateRef.current.selection.nodeIds : [];
        const merged = [...new Set([...existing, ...nodeIds])];
        setSelection({ nodeIds: merged, edgeIds: edgesWithinNodes(g, merged) });
        setMarquee(null);
        return;
      }
      setMarquee(null);

      // A drag that actually moved is already in the graph, and its history
      // entry was pushed by its first update, so there is nothing to commit.
      if (gesture.kind === 'move-nodes' || gesture.kind === 'move-handle') return;
      if (gesture.kind === 'move-dimension') return;
      if (gesture.kind === 'pan') return;

      const travelled = press
        ? Math.hypot(event.clientX - press.client.x, event.clientY - press.client.y)
        : 0;
      if (travelled > DRAG_THRESHOLD_PX) return;

      // --- clicks ------------------------------------------------------------
      if (activeTool === 'dimension' && press?.hit?.kind === 'edge') {
        const seed = widthOnEdgeAt(loft, press.hit.edgeId, press.hit.t, {
          widthMm: cp.defaultChannelWidthMm,
          heightMm: cp.defaultChannelHeightMm,
        });
        const edgeId = press.hit.edgeId;
        const t = press.hit.t;

        updateGraph(
          (current) => {
            const edge = current.edges.find((e) => e.id === edgeId);
            if (!edge) return current;
            return updateEdge(current, edgeId, {
              dimensionPoints: upsertDimensionPoint(edge.dimensionPoints, {
                t,
                widthMm: Number(seed.widthMm.toFixed(3)),
                heightMm:
                  edge.crossSection === 'round' ? undefined : Number(seed.heightMm.toFixed(3)),
              }),
            });
          },
          { label: 'add dimension marker' },
        );
        selectEdges([edgeId]);
        return;
      }

      // ⌘-click (Ctrl-click off the Mac) on a segment inserts a node there.
      // Alt is taken by panning.
      if (
        activeTool === 'select' &&
        press?.hit?.kind === 'edge' &&
        !event.shiftKey &&
        (event.metaKey || event.ctrlKey)
      ) {
        const result = splitEdgeAt(g, press.hit.edgeId, press.hit.t);
        if (result) {
          updateGraph(() => result.graph, { label: 'split segment' });
          selectNodes([result.nodeId]);
        }
        return;
      }

      void mm;
    },
    [
      clientToMm,
      endGraphEdit,
      loft,
      marquee,
      selectEdges,
      selectNodes,
      setSelection,
      setSnapIndicator,
      updateGraph,
    ],
  );

  // -------------------------------------------------------------------------
  // wheel: zoom at cursor, or pan with shift
  // -------------------------------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const { view: v } = stateRef.current;

      if (event.ctrlKey || event.metaKey || !event.shiftKey) {
        const factor = Math.exp(-event.deltaY * 0.002);
        const nextZoom = clamp(v.zoom * factor, MIN_ZOOM, MAX_ZOOM);
        if (nextZoom === v.zoom) return;

        // Keep the point under the cursor fixed while zooming.
        const before = clientToMm(event.clientX, event.clientY);
        const scope = scopeRef.current;
        if (scope) {
          scope.view.zoom = nextZoom;
          const after = clientToMm(event.clientX, event.clientY);
          setView({
            zoom: nextZoom,
            center: {
              x: v.center.x + (before.x - after.x),
              y: v.center.y + (before.y - after.y),
            },
          });
        }
        return;
      }

      setView({
        center: {
          x: v.center.x + event.deltaX / v.zoom,
          y: v.center.y - event.deltaY / v.zoom,
        },
      });
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [clientToMm, setView]);

  // -------------------------------------------------------------------------
  // keyboard
  // -------------------------------------------------------------------------

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (keyBelongsElsewhere(event)) return;

      const { selection: sel, tool: activeTool } = stateRef.current;

      if (event.key === 'Escape') {
        if (activeTool === 'draw') resetDraw();
        else setSelection({ nodeIds: [], edgeIds: [] });
        return;
      }

      if (event.key === 'Enter' && activeTool === 'draw') {
        // Ends the current run without leaving the tool, so the next click
        // starts a new, unconnected path.
        resetDraw();
        return;
      }

      if ((event.key === 'Delete' || event.key === 'Backspace') && !event.metaKey && !event.ctrlKey) {
        if (sel.nodeIds.length === 0 && sel.edgeIds.length === 0) return;
        event.preventDefault();
        updateGraph((current) => deleteElements(current, sel.nodeIds, sel.edgeIds), {
          label: 'delete',
        });
        setSelection({ nodeIds: [], edgeIds: [] });
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [resetDraw, setSelection, updateGraph]);

  // -------------------------------------------------------------------------

  const cursorClass =
    tool === 'draw'
      ? 'cursor-crosshair'
      : tool === 'dimension'
        ? 'cursor-copy'
        : hover?.kind === 'node' || hover?.kind === 'handle'
          ? 'cursor-grab'
          : 'cursor-default';

  return (
    <div className="relative h-full min-h-0 flex-1 bg-canvas">
      <Rulers view={view} viewSize={viewSize} chipParams={chipParams} />

      {/* Inset by the ruler gutters so canvas pixel (0,0) is exactly where the
          rulers say it is. */}
      <div
        ref={hostRef}
        className="absolute bottom-0 right-0 overflow-hidden"
        style={{ left: RULER_PX, top: RULER_PX }}
      >
        <canvas
          ref={canvasRef}
          tabIndex={0}
          className={`absolute inset-0 h-full w-full outline-none ${cursorClass}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={() => {
            // Mid-drag the pointer is still ours even off-canvas, so only a
            // genuinely idle pointer clears the crosshair, the readout and the
            // snap it was reporting.
            if (gestureRef.current.kind !== 'none') return;
            setCursorMm(null);
            setSnapIndicator(null);
            // The rubber band tracks the pointer as well, so it leaves with it
            // rather than hanging across the canvas aimed at where the cursor
            // used to be. The run is untouched: moving back in picks it up.
            if (stateRef.current.draw.preview) setDraw({ preview: null });
          }}
          onContextMenu={(event) => event.preventDefault()}
        />
        <EmptyCanvasHint />
      </div>

      <CursorReadout snap={snapIndicator} />
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Closest parameter on an edge to a point, or null if the edge is gone. */
function nearestTOnEdge(
  graph: Parameters<typeof extractFragment>[0],
  edgeId: string,
  point: Point2,
): number | null {
  const edge = graph.edges.find((e) => e.id === edgeId);
  if (!edge) return null;
  const nodes = nodeIndex(graph.nodes);
  const from = nodes.get(edge.fromNodeId);
  const to = nodes.get(edge.toNodeId);
  if (!from || !to) return null;

  const samples = 64;
  let bestT = 0;
  let bestD = Infinity;
  const p0 = nodePoint(from);
  const p1 = nodePoint(to);
  const c0 = edge.controlPoints?.[0] ?? p0;
  const c1 = edge.controlPoints?.[1] ?? p1;
  const straight = edge.curveType !== 'bezier' || !edge.controlPoints;

  for (let i = 0; i <= samples; i += 1) {
    const t = i / samples;
    const u = 1 - t;
    const at = straight
      ? { x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t }
      : {
          x: u * u * u * p0.x + 3 * u * u * t * c0.x + 3 * u * t * t * c1.x + t * t * t * p1.x,
          y: u * u * u * p0.y + 3 * u * u * t * c0.y + 3 * u * t * t * c1.y + t * t * t * p1.y,
        };
    const d = distance(at, point);
    if (d < bestD) {
      bestD = d;
      bestT = t;
    }
  }
  return bestT;
}

/** Same thing under the pointer, whatever the exact point on it. */
function sameHitTarget(a: HitTarget, b: HitTarget): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'node':
      return a.nodeId === (b as typeof a).nodeId;
    case 'handle':
      return a.edgeId === (b as typeof a).edgeId && a.handleIndex === (b as typeof a).handleIndex;
    default:
      return a.edgeId === (b as typeof a).edgeId;
  }
}

/** Same snap, landing on the same point. A non-snap is never drawn, so any two are equal. */
function sameSnap(a: SnapResult | null, b: SnapResult | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'none') return true;
  return (
    a.nodeId === b.nodeId &&
    a.angleDeg === b.angleDeg &&
    Math.abs(a.point.x - b.point.x) < 1e-6 &&
    Math.abs(a.point.y - b.point.y) < 1e-6
  );
}
