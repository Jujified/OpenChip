/**
 * Fluid-tab view state.
 *
 * The assignments and fluid library live in the project (they are part of the
 * design); only which metric is on screen and which fluid is being edited live
 * here.
 */

import { create } from 'zustand';
import type { HeatmapMetric } from '../lib/fluids/heatmap';

interface FluidState {
  metric: HeatmapMetric;
  setMetric: (metric: HeatmapMetric) => void;

  /** Fluid open in the editor, or null for the list view. */
  editingFluidId: string | null;
  setEditingFluidId: (id: string | null) => void;

  /** Segment the user hovered or clicked in the table, highlighted on the map. */
  focusedEdgeId: string | null;
  setFocusedEdgeId: (id: string | null) => void;

  showTable: boolean;
  toggleTable: () => void;

  /**
   * Consumption panel inputs.
   *
   * These describe a *run*, not a chip — two people can open the same design
   * and plan a ten-minute test and an overnight perfusion from it. So they live
   * here with the other view state rather than in the project file, and they
   * stay off the undo stack: nudging a run duration is not an edit to the
   * design, and having it eat a ⌘Z that was meant for a channel would be.
   */
  runDurationMin: number;
  setRunDurationMin: (minutes: number) => void;

  /** Displacement volumes of the channel network to flush through after a run. */
  washMultiplier: number;
  setWashMultiplier: (multiplier: number) => void;
}

export const useFluidStore = create<FluidState>()((set) => ({
  metric: 'pressure',
  setMetric: (metric) => set({ metric }),

  editingFluidId: null,
  setEditingFluidId: (editingFluidId) => set({ editingFluidId }),

  focusedEdgeId: null,
  setFocusedEdgeId: (focusedEdgeId) => set({ focusedEdgeId }),

  showTable: true,
  toggleTable: () => set((state) => ({ showTable: !state.showTable })),

  runDurationMin: 60,
  setRunDurationMin: (runDurationMin) => set({ runDurationMin }),

  washMultiplier: 5,
  setWashMultiplier: (washMultiplier) => set({ washMultiplier }),
}));
