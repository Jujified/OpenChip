/**
 * Which warning the user is looking at, and the thresholds the checks use.
 *
 * The warnings themselves are derived from project state and live in
 * `useValidation` — only the *focus* is stateful, because it has to survive a
 * jump between the 2D and 3D views so both can highlight the same element.
 */

import { create } from 'zustand';
import { DEFAULT_VALIDATION_SETTINGS, type ValidationSettings, type Warning } from '../lib/validation';

interface ValidationState {
  /** Id of the warning the user clicked, or null. */
  focusedId: string | null;
  /** The elements that warning points at, mirrored so views can read them cheaply. */
  focusedTarget: Warning['target'] | null;
  focus: (warning: Warning | null) => void;

  /** Panel open state, shared so it persists across a tab switch. */
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
  togglePanel: () => void;

  settings: ValidationSettings;
  setSettings: (patch: Partial<ValidationSettings>) => void;
  resetSettings: () => void;
}

export const useValidationStore = create<ValidationState>()((set) => ({
  focusedId: null,
  focusedTarget: null,
  focus: (warning) =>
    set({
      focusedId: warning?.id ?? null,
      focusedTarget: warning?.target ?? null,
    }),

  panelOpen: false,
  setPanelOpen: (panelOpen) => set({ panelOpen }),
  togglePanel: () => set((state) => ({ panelOpen: !state.panelOpen })),

  settings: DEFAULT_VALIDATION_SETTINGS,
  setSettings: (patch) => set((state) => ({ settings: { ...state.settings, ...patch } })),
  resetSettings: () => set({ settings: DEFAULT_VALIDATION_SETTINGS }),
}));
