/**
 * App-level settings — the things that outlive any single project.
 *
 * Distinct from `projectStore`: nothing here is written into a `.openchip`
 * file. This is "how this browser is set up", not "what this chip is".
 */

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { FALLBACK_PRINTER_PROFILE } from '../lib/defaults';
import { SETTINGS_STORAGE_KEY, safeStorage } from '../lib/persistence';
import type { PrinterProfile } from '../types/project';

interface SettingsState {
  /** False until the onboarding wizard has been completed at least once. */
  onboardingCompleted: boolean;
  /**
   * Applied to every new project. Captured in onboarding, editable afterwards
   * from Settings → Printer.
   */
  defaultPrinterProfile: PrinterProfile;
  /** True once the guided tour has been offered, so it is not re-offered on every load. */
  tourCompleted: boolean;
  /** True once the store has read from localStorage — gates the onboarding check. */
  hydrated: boolean;

  completeOnboarding: (profile: PrinterProfile) => void;
  completeTour: () => void;
  setDefaultPrinterProfile: (profile: PrinterProfile) => void;
  setHydrated: () => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      onboardingCompleted: false,
      defaultPrinterProfile: FALLBACK_PRINTER_PROFILE,
      tourCompleted: false,
      hydrated: false,

      completeOnboarding: (profile) =>
        set({ onboardingCompleted: true, defaultPrinterProfile: { ...profile } }),

      completeTour: () => set({ tourCompleted: true }),

      setDefaultPrinterProfile: (profile) => set({ defaultPrinterProfile: { ...profile } }),

      setHydrated: () => set({ hydrated: true }),
    }),
    {
      name: SETTINGS_STORAGE_KEY,
      storage: createJSONStorage(() => safeStorage),
      // Only the durable facts persist; `hydrated` and the actions are rebuilt
      // on every load.
      partialize: (state) =>
        ({
          onboardingCompleted: state.onboardingCompleted,
          defaultPrinterProfile: state.defaultPrinterProfile,
          tourCompleted: state.tourCompleted,
        }) as SettingsState,
      onRehydrateStorage: () => (state) => {
        // Runs with `state` undefined when nothing was stored — a first run
        // still has to leave the boot gate.
        (state ?? useSettingsStore.getState()).setHydrated();
      },
    },
  ),
);
