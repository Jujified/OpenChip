/**
 * Which warning the user is looking at, and the thresholds the checks use.
 *
 * The warnings themselves are derived from project state and live in
 * `useValidation` — only the *focus* is stateful, because it has to survive a
 * jump between the 2D and 3D views so both can highlight the same element.
 *
 * The thresholds persist in this browser, like the app settings: a wall value
 * measured off a test print should not have to be typed in again every
 * session. They are not part of the project file — they describe the
 * printer-and-resin you calibrated, not the chip.
 */

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { CHECK_SETTINGS_STORAGE_KEY, safeStorage } from '../lib/persistence';
import { DEFAULT_VALIDATION_SETTINGS, type ValidationSettings, type Warning } from '../lib/validation';

/**
 * Stored thresholds over the defaults, keeping only positive finite numbers —
 * a hand-edited or older entry can never feed a check `NaN` or a missing key.
 */
export function restoreSettings(stored: unknown): ValidationSettings {
  const restored: ValidationSettings = { ...DEFAULT_VALIDATION_SETTINGS };
  if (!stored || typeof stored !== 'object') return restored;
  for (const key of Object.keys(restored) as (keyof ValidationSettings)[]) {
    const value = (stored as Record<string, unknown>)[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) restored[key] = value;
  }
  return restored;
}

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

export const useValidationStore = create<ValidationState>()(
  persist(
    (set) => ({
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
    }),
    {
      name: CHECK_SETTINGS_STORAGE_KEY,
      storage: createJSONStorage(() => safeStorage),
      // Only the thresholds persist; focus and the panel are per session.
      partialize: (state) => ({ settings: state.settings }) as ValidationState,
      merge: (persisted, current) => ({
        ...current,
        settings: restoreSettings((persisted as Partial<ValidationState> | undefined)?.settings),
      }),
    },
  ),
);
