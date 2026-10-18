/**
 * Drawing-editor state: what tool is active, what is selected, how snapping
 * behaves, where the viewport sits.
 *
 * None of this belongs in the `.openchip` file — it is how the user is looking
 * at the chip, not what the chip is. Keeping it out of `projectStore` also
 * keeps selection changes from marking the project dirty.
 */

import { create } from 'zustand';
import { DEFAULT_SNAP_SETTINGS, type SnapSettings } from '../lib/snapping';
import type { GraphFragment } from '../lib/graphOps';
import type { Point2 } from '../types/project';

export type Tool = 'select' | 'draw' | 'dimension';

/** What the inspector is currently talking about. */
export interface Selection {
  nodeIds: string[];
  edgeIds: string[];
}

export const emptySelection = (): Selection => ({ nodeIds: [], edgeIds: [] });

export interface ViewState {
  /** Pixels per millimetre. */
  zoom: number;
  /** Chip-space point at the center of the viewport, mm. */
  center: Point2;
}

/** In-progress draw stroke: the chain of nodes laid down since the tool engaged. */
export interface DrawSession {
  /** Node the next segment will start from. */
  lastNodeId: string | null;
  /** Live cursor position after snapping, for the rubber-band preview. */
  preview: Point2 | null;
  /** Node ids created during this stroke, so Escape can tidy up cleanly. */
  createdNodeIds: string[];
}

interface EditorState {
  tool: Tool;
  setTool: (tool: Tool) => void;

  selection: Selection;
  setSelection: (selection: Selection) => void;
  selectNodes: (nodeIds: string[], additive?: boolean) => void;
  selectEdges: (edgeIds: string[], additive?: boolean) => void;
  toggleNode: (nodeId: string) => void;
  clearSelection: () => void;

  snap: SnapSettings;
  setSnap: (patch: Partial<SnapSettings>) => void;

  view: ViewState;
  setView: (patch: Partial<ViewState>) => void;

  draw: DrawSession;
  setDraw: (patch: Partial<DrawSession>) => void;
  resetDraw: () => void;

  /** Copy buffer for simple paste and for the array-repeat tool. */
  clipboard: GraphFragment | null;
  setClipboard: (fragment: GraphFragment | null) => void;
  /** Bumped on each paste so successive pastes cascade instead of stacking. */
  pasteCount: number;
  bumpPaste: () => void;

  /**
   * Array-repeat parameters.
   *
   * These live in the store rather than in the panel's local state because the
   * canvas has to draw the ghost preview from them, and the two are siblings.
   */
  array: { count: number; spacingMm: number; alternate: boolean };
  setArray: (patch: Partial<EditorState['array']>) => void;

  /** Interior angle below which auto-placement treats a node as a turn. */
  cornerThresholdDeg: number;
  setCornerThresholdDeg: (deg: number) => void;
  chamberShape: 'sphere' | 'cylinder';
  setChamberShape: (shape: 'sphere' | 'cylinder') => void;
  /** Auto-placed chamber size as a multiple of local channel width. */
  chamberWidthMultiple: number;
  setChamberWidthMultiple: (multiple: number) => void;

  /** Live taper ribbon on the canvas — off gives a plain centerline view. */
  showTaper: boolean;
  toggleTaper: () => void;
  showGrid: boolean;
  toggleGrid: () => void;

  /** Node the inspector should scroll into view, set by clicking a warning. */
  focusNodeId: string | null;
  setFocusNodeId: (nodeId: string | null) => void;
}

const dedupe = (values: string[]): string[] => [...new Set(values)];

export const useEditorStore = create<EditorState>()((set) => ({
  tool: 'select',
  setTool: (tool) =>
    set((state) => ({
      tool,
      // Switching tools abandons an in-progress stroke rather than leaving a
      // dangling rubber band attached to the cursor.
      draw: tool === 'draw' ? state.draw : { lastNodeId: null, preview: null, createdNodeIds: [] },
    })),

  selection: emptySelection(),
  setSelection: (selection) => set({ selection }),

  selectNodes: (nodeIds, additive = false) =>
    set((state) => ({
      selection: {
        nodeIds: additive ? dedupe([...state.selection.nodeIds, ...nodeIds]) : dedupe(nodeIds),
        edgeIds: additive ? state.selection.edgeIds : [],
      },
    })),

  selectEdges: (edgeIds, additive = false) =>
    set((state) => ({
      selection: {
        nodeIds: additive ? state.selection.nodeIds : [],
        edgeIds: additive ? dedupe([...state.selection.edgeIds, ...edgeIds]) : dedupe(edgeIds),
      },
    })),

  toggleNode: (nodeId) =>
    set((state) => {
      const has = state.selection.nodeIds.includes(nodeId);
      return {
        selection: {
          ...state.selection,
          nodeIds: has
            ? state.selection.nodeIds.filter((id) => id !== nodeId)
            : [...state.selection.nodeIds, nodeId],
        },
      };
    }),

  clearSelection: () => set({ selection: emptySelection() }),

  snap: DEFAULT_SNAP_SETTINGS,
  setSnap: (patch) => set((state) => ({ snap: { ...state.snap, ...patch } })),

  view: { zoom: 8, center: { x: 20, y: 30 } },
  setView: (patch) => set((state) => ({ view: { ...state.view, ...patch } })),

  draw: { lastNodeId: null, preview: null, createdNodeIds: [] },
  setDraw: (patch) => set((state) => ({ draw: { ...state.draw, ...patch } })),
  resetDraw: () => set({ draw: { lastNodeId: null, preview: null, createdNodeIds: [] } }),

  clipboard: null,
  setClipboard: (clipboard) => set({ clipboard, pasteCount: 0 }),
  pasteCount: 0,
  bumpPaste: () => set((state) => ({ pasteCount: state.pasteCount + 1 })),

  array: { count: 4, spacingMm: 0, alternate: true },
  setArray: (patch) => set((state) => ({ array: { ...state.array, ...patch } })),

  // 150° rather than 90°: a serpentine's turns are right angles, but gentler
  // direction changes are still turns worth putting a chamber on.
  cornerThresholdDeg: 150,
  setCornerThresholdDeg: (cornerThresholdDeg) => set({ cornerThresholdDeg }),
  chamberShape: 'sphere',
  setChamberShape: (chamberShape) => set({ chamberShape }),
  chamberWidthMultiple: 3,
  setChamberWidthMultiple: (chamberWidthMultiple) => set({ chamberWidthMultiple }),

  showTaper: true,
  toggleTaper: () => set((state) => ({ showTaper: !state.showTaper })),
  showGrid: true,
  toggleGrid: () => set((state) => ({ showGrid: !state.showGrid })),

  focusNodeId: null,
  setFocusNodeId: (focusNodeId) => set({ focusNodeId }),
}));
