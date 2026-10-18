import { create } from 'zustand';
import type { Point2 } from '../types/project';

/**
 * Where the pointer is over the Draw canvas, in chip mm.
 *
 * Its own store because it changes on every pointer-move. As `DrawCanvas`
 * state it re-rendered the whole canvas component, rulers and all, per move;
 * here only the rulers' crosshair and the coordinate readout subscribe.
 */
interface CursorState {
  cursorMm: Point2 | null;
  setCursorMm: (point: Point2 | null) => void;
}

export const useCursorStore = create<CursorState>()((set) => ({
  cursorMm: null,
  setCursorMm: (cursorMm) => set({ cursorMm }),
}));
