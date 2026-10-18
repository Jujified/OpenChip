/**
 * Guided-tour position.
 *
 * Separate from `uiStore` because it is a small state machine rather than an
 * open/closed flag, and separate from `settingsStore` because only the "has
 * this user seen it" bit deserves to outlive the session — where the user got
 * to in a tour they abandoned is not worth restoring.
 */

import { create } from 'zustand';
import { TOUR_STEPS } from '../lib/tour';

interface TourState {
  active: boolean;
  stepIndex: number;

  start: () => void;
  next: () => void;
  previous: () => void;
  /** Ends the tour, whether by finishing it or by leaving early. */
  stop: () => void;
}

export const useTourStore = create<TourState>()((set, get) => ({
  active: false,
  stepIndex: 0,

  start: () => set({ active: true, stepIndex: 0 }),

  next: () => {
    const next = get().stepIndex + 1;
    // Running off the end is how the tour normally ends, so it is the same
    // transition as closing it rather than a separate "finished" state.
    if (next >= TOUR_STEPS.length) set({ active: false, stepIndex: 0 });
    else set({ stepIndex: next });
  },

  previous: () => set((state) => ({ stepIndex: Math.max(0, state.stepIndex - 1) })),

  stop: () => set({ active: false, stepIndex: 0 }),
}));
