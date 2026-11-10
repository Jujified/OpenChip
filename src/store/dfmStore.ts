/**
 * Print correction: the profiles loaded into this browser, and which one — if
 * any — the next export uses.
 *
 * Like `settingsStore`, nothing here is written into a `.openchip` file. A
 * profile belongs to a printer and a resin, so it is kept with the browser's
 * own setup and reused across every project opened in it.
 *
 * Only the library persists. The selection deliberately does not: every
 * session starts on "None (uncompensated)", so a compensated export is always
 * something the user chose this time rather than something left switched on
 * last week.
 */

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { DfmEntry } from '../lib/dfm/exportPlan';
import { hashDfmProfile, parseDfmProfile, type DfmProfile } from '../lib/dfm/profile';
import { DFM_STORAGE_KEY, safeStorage } from '../lib/persistence';

interface DfmState {
  profiles: DfmEntry[];
  /** Hash of the profile exports use. Null is "None (uncompensated)". */
  selectedSha: string | null;
  /** The compensated-geometry preview panel in the CAD sidebar. */
  previewOpen: boolean;
  /** The calibration dialog: coupon, results, fit. */
  calibrationOpen: boolean;

  /** Adds a profile to the library, or returns the entry already holding it. */
  addProfile: (profile: DfmProfile) => Promise<DfmEntry>;
  removeProfile: (sha256: string) => void;
  select: (sha256: string | null) => void;
  setPreviewOpen: (open: boolean) => void;
  setCalibrationOpen: (open: boolean) => void;
}

export const useDfmStore = create<DfmState>()(
  persist(
    (set, get) => ({
      profiles: [],
      selectedSha: null,
      previewOpen: false,
      calibrationOpen: false,

      addProfile: async (profile) => {
        const sha256 = await hashDfmProfile(profile);
        const existing = get().profiles.find((entry) => entry.sha256 === sha256);
        if (existing) return existing;
        const entry: DfmEntry = { profile, sha256 };
        set((state) => ({ profiles: [...state.profiles, entry] }));
        return entry;
      },

      removeProfile: (sha256) =>
        set((state) => ({
          profiles: state.profiles.filter((entry) => entry.sha256 !== sha256),
          ...(state.selectedSha === sha256 ? { selectedSha: null, previewOpen: false } : {}),
        })),

      // Deselecting closes the preview with it: with no profile there is
      // nothing compensated to look at.
      select: (selectedSha) =>
        set((state) => ({ selectedSha, previewOpen: selectedSha ? state.previewOpen : false })),

      setPreviewOpen: (previewOpen) => set({ previewOpen }),
      setCalibrationOpen: (calibrationOpen) => set({ calibrationOpen }),
    }),
    {
      name: DFM_STORAGE_KEY,
      storage: createJSONStorage(() => safeStorage),
      partialize: (state) => ({ profiles: state.profiles }) as DfmState,
      // Stored profiles go back through the file parser. One written by a
      // newer build, or damaged, is dropped here rather than handed to an
      // export that would apply half of it.
      merge: (persisted, current) => {
        const stored = (persisted as { profiles?: unknown } | undefined)?.profiles;
        const profiles: DfmEntry[] = [];
        for (const item of Array.isArray(stored) ? stored : []) {
          const entry = item as { profile?: unknown; sha256?: unknown };
          if (typeof entry?.sha256 !== 'string') continue;
          const parsed = parseDfmProfile(JSON.stringify(entry.profile ?? null));
          if (parsed.ok) profiles.push({ profile: parsed.profile, sha256: entry.sha256 });
        }
        return { ...current, profiles };
      },
    },
  ),
);

/** The entry exports will use, or null for "None (uncompensated)". */
export const selectedDfmEntry = (state: Pick<DfmState, 'profiles' | 'selectedSha'>): DfmEntry | null =>
  state.profiles.find((entry) => entry.sha256 === state.selectedSha) ?? null;
