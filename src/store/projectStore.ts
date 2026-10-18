/**
 * The open project, plus everything about its relationship to a file on disk.
 *
 * Actions return plain result objects instead of raising toasts themselves —
 * the store stays free of UI concerns, and the components decide how to report.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createProject, type CreateProjectOptions } from '../lib/defaults';
import { browserStorage, type FileTarget, type ProjectStorage } from '../lib/fileAccess';
import { effectiveProfiles } from '../lib/fluids/reconcile';
import {
  DRAFT_STORAGE_KEY,
  debouncedPersistStorage,
  onStorageWrite,
  type WriteOutcome,
} from '../lib/persistence';
import {
  normaliseProject,
  parseProject,
  serializeProject,
  stampForSave,
  suggestedFileName,
} from '../lib/projectFile';
import type {
  ChannelGraph,
  ChipParams,
  DrainageVent,
  FluidProfile,
  FluidSetup,
  OpenChipProject,
  PrinterProfile,
  SavedImage,
} from '../types/project';
import { useSettingsStore } from './settingsStore';

// ---------------------------------------------------------------------------
// action results
// ---------------------------------------------------------------------------

/**
 * What a save is meant to do.
 *
 * One value rather than two booleans, because `{ saveAs: true, copy: true }`
 * asked for two contradictory things — re-point the project *and* leave it
 * alone — and something had to silently win. A union cannot express the
 * contradiction, so no call site can make it and nothing has to police it.
 */
export type SaveMode = 'save' | 'save-as' | 'copy';

export type SaveResult =
  | { status: 'saved'; fileName: string; inPlace: boolean }
  | { status: 'downloaded'; fileName: string }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

export type OpenResult =
  | { status: 'opened'; fileName: string; projectName: string; warnings: string[] }
  | { status: 'cancelled' }
  | { status: 'invalid'; message: string; details: string[] }
  | { status: 'error'; message: string };

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

interface ProjectStateData {
  project: OpenChipProject;
  /** Name of the file backing this project, for display. Persisted. */
  fileName: string | null;
  /** True when `project` differs from what was last written to disk. */
  isDirty: boolean;
  /** ISO-8601 of the last successful write to a file. */
  lastSavedAt: string | null;
}

interface ProjectState extends ProjectStateData {
  /**
   * The live file handle. Never persisted — handles survive a reload only via
   * IndexedDB plus a fresh permission gesture, so the first Save after a reload
   * prompts for a location instead.
   */
  fileTarget: FileTarget | null;
  /** True once the draft has been read back from localStorage. */
  hydrated: boolean;
  /** True when boot restored work that had never been written to a file. */
  restoredUnsavedDraft: boolean;
  /** ISO-8601 of the draft that was restored, for the recovery notice. */
  restoredAt: string | null;
  /** Guards against a save racing a second save. */
  isSaving: boolean;
  /**
   * How the last draft write landed. `'shrunk'`: it only fit without its saved
   * images. `'failed'`: it did not fit at all, so autosave is off until the
   * project gets smaller. Not persisted.
   */
  draftStatus: WriteOutcome;
  /**
   * Saved images the restored draft had to leave out to fit in browser storage.
   * Written into the draft by the shrink step itself, so it is only non-zero on
   * a project that came back from one.
   */
  draftOmittedImages: number;

  newProject: (options?: CreateProjectOptions) => void;
  loadProject: (project: OpenChipProject, target: FileTarget | null) => void;
  /**
   * Writes the project to a file.
   *
   * `'save-as'` re-points the project at the new file — the next Save
   * overwrites it. `'copy'` does not: it writes a detached snapshot and leaves
   * the open project, its handle, and its dirty flag exactly as they were, so a
   * user can park an iteration without losing their place in the file they are
   * editing.
   */
  saveProject: (mode?: SaveMode) => Promise<SaveResult>;
  openProject: () => Promise<OpenResult>;
  /**
   * Opens a project from file contents already in hand — a file dropped on the
   * page rather than picked. There is no handle to write back to, so the next
   * Save asks where to put it.
   */
  openProjectText: (text: string, fileName: string) => OpenResult;

  setProjectName: (name: string) => void;
  updateChipParams: (patch: Partial<ChipParams>) => void;
  updatePrinterProfile: (patch: Partial<PrinterProfile>) => void;

  // --- channel graph -------------------------------------------------------

  /**
   * Applies a graph transform.
   *
   * `commit: false` is for the middle of a drag — the graph updates so the
   * canvas reflows, but no history entry is pushed. Commit once on pointer-up
   * and a whole drag collapses into a single undo step, which is what a user
   * expects when they press ⌘Z.
   */
  updateGraph: (
    mutate: (graph: ChannelGraph) => ChannelGraph,
    options?: { commit?: boolean; label?: string },
  ) => void;
  /**
   * Marks the start of a gesture that may edit the graph: a drag, or typing
   * into a number field.
   *
   * The whole gesture is one undo step. The current graph is held aside, not
   * pushed: it becomes the undo entry on the gesture's first real change, and
   * nothing else the gesture does pushes another. A press that never moves —
   * a plain click to select — or a field focused and left alone leaves history
   * and redo untouched.
   *
   * `label` names the step; without one, the first update's label is used.
   */
  beginGraphEdit: (label?: string) => void;
  /** Ends the gesture begun by `beginGraphEdit`. */
  endGraphEdit: () => void;
  /**
   * Abandons the gesture: the graph goes back to how it was at
   * `beginGraphEdit`, and the step it pushed is removed rather than left to
   * redo. For Escape in a field that has been live-updating the design.
   */
  cancelGraphEdit: () => void;
  undo: () => void;
  redo: () => void;
  /** Mirrored into state so toolbar buttons can subscribe and re-render. */
  undoDepth: number;
  redoDepth: number;

  addSavedImage: (image: SavedImage) => void;
  removeSavedImage: (id: string) => void;
  /** Drainage holes. Replaces the whole list — it is small and edited wholesale. */
  setDrainageVents: (vents: DrainageVent[]) => void;

  // --- fluids --------------------------------------------------------------
  setFluidProfiles: (profiles: FluidProfile[]) => void;
  updateFluidProfile: (id: string, patch: Partial<FluidProfile>) => void;
  setFluidSetup: (setup: FluidSetup) => void;

  dismissDraftNotice: () => void;
  markHydrated: () => void;
}

/** One reversible step: the graph as it was, plus what the change was called. */
interface HistoryEntry {
  graph: ChannelGraph;
  label: string;
}

/** Deep enough for a real drawing session, shallow enough not to bloat the draft. */
const HISTORY_LIMIT = 80;

// History lives outside the store's persisted state on purpose: it is session
// scratch, and serialising 80 graph snapshots into localStorage on every edit
// would be both slow and useless after a reload.
const undoStack: HistoryEntry[] = [];
const redoStack: HistoryEntry[] = [];
/** The gesture in progress, if any; see `beginGraphEdit`. */
let gesture: { baseline: ChannelGraph; label?: string; pushed: boolean } | null = null;

function pushUndo(graph: ChannelGraph, label: string): void {
  undoStack.push({ graph, label });
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  // Any new edit invalidates the redo branch.
  redoStack.length = 0;
}

const historyDepths = () => ({ undoDepth: undoStack.length, redoDepth: redoStack.length });

/** Cleared whenever the open project is replaced — history must not cross files. */
function resetHistory(): { undoDepth: number; redoDepth: number } {
  gesture = null;
  undoStack.length = 0;
  redoStack.length = 0;
  return historyDepths();
}

/** Swappable so a future backend adapter needs no changes here. */
let storage: ProjectStorage = browserStorage;
export const setProjectStorage = (next: ProjectStorage): void => void (storage = next);

const nowIso = () => new Date().toISOString();

/**
 * The draft with its saved images taken out, for when the whole thing does not
 * fit in localStorage.
 *
 * The images are what outgrow it — a single high-res CAD snapshot is most of a
 * megabyte — and they are the part a user can best do without in a crash
 * recovery: every edit to the design itself still comes back.
 */
export function draftWithoutImages(value: string): string | null {
  try {
    const draft = JSON.parse(value) as {
      state?: { project?: OpenChipProject; draftOmittedImages?: number };
    };
    const images = draft.state?.project?.savedImages ?? [];
    if (!draft.state?.project || images.length === 0) return null;
    draft.state.project = { ...draft.state.project, savedImages: [] };
    draft.state.draftOmittedImages = images.length;
    return JSON.stringify(draft);
  } catch {
    return null;
  }
}

export const useProjectStore = create<ProjectState>()(
  persist(
    (set, get) => {
      /** Applies a project mutation, stamps `modifiedAt`, and marks it dirty. */
      const edit = (mutate: (project: OpenChipProject) => OpenChipProject) =>
        set((state) => {
          const next = mutate(state.project);
          return {
            project: { ...next, meta: { ...next.meta, modifiedAt: nowIso() } },
            isDirty: true,
          };
        });

      /**
       * Parses file contents and, only if they are a valid project, replaces the
       * open one. A bad file must never cost the user the work they already
       * have open, so on failure nothing changes.
       */
      const openParsed = (text: string, target: FileTarget): OpenResult => {
        const parsed = parseProject(text);
        if (!parsed.ok) {
          return { status: 'invalid', message: parsed.message, details: parsed.details };
        }

        get().loadProject(parsed.project, target);
        return {
          status: 'opened',
          fileName: target.name,
          projectName: parsed.project.meta.name,
          warnings: parsed.warnings,
        };
      };

      return {
        project: createProject(),
        fileName: null,
        isDirty: false,
        lastSavedAt: null,
        fileTarget: null,
        hydrated: false,
        restoredUnsavedDraft: false,
        restoredAt: null,
        isSaving: false,
        draftStatus: 'saved',
        draftOmittedImages: 0,

        // -------------------------------------------------------------------
        // lifecycle
        // -------------------------------------------------------------------

        newProject: (options = {}) =>
          set({
            project: createProject({
              printerProfile: useSettingsStore.getState().defaultPrinterProfile,
              ...options,
            }),
            fileName: null,
            fileTarget: null,
            isDirty: false,
            lastSavedAt: null,
            restoredUnsavedDraft: false,
            restoredAt: null,
            draftOmittedImages: 0,
            ...resetHistory(),
          }),

        loadProject: (project, target) =>
          set({
            project,
            fileTarget: target,
            fileName: target?.name ?? null,
            isDirty: false,
            lastSavedAt: nowIso(),
            restoredUnsavedDraft: false,
            restoredAt: null,
            draftOmittedImages: 0,
            // Undoing into the previous project's geometry would be incoherent.
            ...resetHistory(),
          }),

        // -------------------------------------------------------------------
        // file I/O
        // -------------------------------------------------------------------

        saveProject: async (mode: SaveMode = 'save') => {
          const copy = mode === 'copy';
          if (get().isSaving) return { status: 'cancelled' as const };
          set({ isSaving: true });

          try {
            const { project, fileTarget } = get();
            // Stamp once, then write that exact object to both disk and state,
            // so what is in memory is byte-identical to what is in the file.
            const stamped = stampForSave(project);
            const text = serializeProject(stamped);
            const outcome = await storage.save(text, {
              // A copy is named from the project title, not from the file the
              // project is currently in: the title is what the user renames
              // when they iterate, and the whole point is a differently-named
              // sibling rather than another copy of the same filename.
              suggestedName: copy
                ? suggestedFileName(project.meta.name)
                : (fileTarget?.name ?? suggestedFileName(project.meta.name)),
              // Never reuse the handle for a copy — that would silently
              // overwrite the open file instead of writing a new one.
              target: copy ? null : fileTarget,
              // Both of the non-plain modes ask where the file should go.
              promptForLocation: mode !== 'save',
            });

            // A copy is a snapshot taken *of* the session, not a save *of* it.
            // The open project keeps its handle, its filename, and its unsaved
            // state — the user still has work in this file that has not been
            // written to this file.
            if (copy) {
              switch (outcome.status) {
                case 'saved':
                  return { status: 'saved', fileName: outcome.target.name, inPlace: false };
                case 'downloaded':
                  return { status: 'downloaded', fileName: outcome.name };
                case 'cancelled':
                  return { status: 'cancelled' };
                default:
                  return { status: 'error', message: outcome.message };
              }
            }

            switch (outcome.status) {
              case 'saved':
                set({
                  project: stamped,
                  fileTarget: outcome.target,
                  fileName: outcome.target.name,
                  isDirty: false,
                  lastSavedAt: nowIso(),
                  restoredUnsavedDraft: false,
                });
                return { status: 'saved', fileName: outcome.target.name, inPlace: outcome.inPlace };

              case 'downloaded':
                set({
                  project: stamped,
                  fileName: outcome.name,
                  isDirty: false,
                  lastSavedAt: nowIso(),
                  restoredUnsavedDraft: false,
                });
                return { status: 'downloaded', fileName: outcome.name };

              case 'cancelled':
                return { status: 'cancelled' };

              default:
                return { status: 'error', message: outcome.message };
            }
          } finally {
            set({ isSaving: false });
          }
        },

        openProject: async () => {
          const outcome = await storage.open();

          if (outcome.status === 'cancelled') return { status: 'cancelled' };
          if (outcome.status === 'error') return { status: 'error', message: outcome.message };

          return openParsed(outcome.text, outcome.target);
        },

        openProjectText: (text, fileName) => openParsed(text, { handle: null, name: fileName }),

        // -------------------------------------------------------------------
        // edits
        // -------------------------------------------------------------------

        setProjectName: (name) =>
          edit((project) => ({ ...project, meta: { ...project.meta, name } })),

        updateChipParams: (patch) =>
          edit((project) => ({ ...project, chipParams: { ...project.chipParams, ...patch } })),

        updatePrinterProfile: (patch) =>
          edit((project) => ({
            ...project,
            printerProfile: { ...project.printerProfile, ...patch },
          })),

        // -------------------------------------------------------------------
        // channel graph
        // -------------------------------------------------------------------

        undoDepth: 0,
        redoDepth: 0,

        beginGraphEdit: (label) => {
          gesture = { baseline: get().project.channelGraph, label, pushed: false };
        },

        endGraphEdit: () => {
          gesture = null;
        },

        cancelGraphEdit: () => {
          const active = gesture;
          gesture = null;
          if (!active?.pushed) return;
          undoStack.pop();
          edit((project) => ({ ...project, channelGraph: active.baseline }));
          set(historyDepths());
        },

        updateGraph: (mutate, { commit = true, label = 'edit' } = {}) => {
          const current = get().project.channelGraph;
          const next = mutate(current);
          if (next === current) return;

          if (gesture) {
            // The first real change of a gesture pushes its starting graph —
            // what undo should return to, whatever this update is. The rest
            // of the gesture rides on that one step.
            if (!gesture.pushed) {
              pushUndo(gesture.baseline, gesture.label ?? label);
              gesture.pushed = true;
              set(historyDepths());
            }
          } else if (commit) {
            pushUndo(current, label);
            set(historyDepths());
          }

          edit((project) => ({ ...project, channelGraph: next }));
        },

        undo: () => {
          gesture = null;
          const entry = undoStack.pop();
          if (!entry) return;
          redoStack.push({ graph: get().project.channelGraph, label: entry.label });
          edit((project) => ({ ...project, channelGraph: entry.graph }));
          set(historyDepths());
        },

        redo: () => {
          gesture = null;
          const entry = redoStack.pop();
          if (!entry) return;
          undoStack.push({ graph: get().project.channelGraph, label: entry.label });
          edit((project) => ({ ...project, channelGraph: entry.graph }));
          set(historyDepths());
        },

        addSavedImage: (image) =>
          edit((project) => ({ ...project, savedImages: [...project.savedImages, image] })),

        removeSavedImage: (id) =>
          edit((project) => ({
            ...project,
            savedImages: project.savedImages.filter((img) => img.id !== id),
          })),

        setDrainageVents: (vents) =>
          edit((project) => ({ ...project, drainageVents: vents })),

        setFluidProfiles: (profiles) =>
          edit((project) => ({ ...project, fluidProfiles: profiles })),

        updateFluidProfile: (id, patch) =>
          edit((project) => ({
            ...project,
            // Editing a built-in before any fluid is stored edits the list the
            // user is looking at, which is the presets.
            fluidProfiles: effectiveProfiles(project.fluidProfiles).map((f) =>
              f.id === id ? { ...f, ...patch } : f,
            ),
          })),

        setFluidSetup: (setup) => edit((project) => ({ ...project, fluidSetup: setup })),

        // -------------------------------------------------------------------
        // draft notice
        // -------------------------------------------------------------------

        dismissDraftNotice: () => set({ restoredUnsavedDraft: false }),

        markHydrated: () =>
          set((state) => ({
            hydrated: true,
            // Only worth announcing when the restored draft holds edits that
            // were never written to a file.
            restoredUnsavedDraft: state.isDirty,
            restoredAt: state.isDirty ? state.project.meta.modifiedAt : null,
          })),
      };
    },
    {
      name: DRAFT_STORAGE_KEY,
      /**
       * Bring a saved draft up to date before it becomes the open project.
       *
       * `persist` replaces state wholesale, so a draft written before a field
       * existed rehydrates with that field `undefined`, and the first thing to
       * read it throws. It goes through the same migrate, schema and integrity
       * pass as an opened file (`normaliseProject`), so every default a file
       * gets, the draft gets — nested ones included, not only chip parameters.
       * A draft that fails even that is set aside rather than allowed to brick
       * the app on every reload.
       */
      merge: (persisted, current) => {
        const saved = persisted as Partial<ProjectStateData> | undefined;
        if (!saved?.project) return { ...current, ...(saved as object) };

        const parsed = normaliseProject(saved.project);
        if (!parsed.ok) {
          console.warn(
            `OpenChip: the saved draft could not be restored and was set aside. ${parsed.message}`,
            parsed.details,
          );
          return current;
        }
        return { ...current, ...saved, project: parsed.project };
      },
      // 400 ms: fast enough that a reload right after an edit keeps it, slow
      // enough that a drag is not serialising the project on every frame.
      storage: debouncedPersistStorage<ProjectStateData>(400, { shrink: draftWithoutImages }),
      partialize: (state): ProjectStateData => ({
        project: state.project,
        fileName: state.fileName,
        isDirty: state.isDirty,
        lastSavedAt: state.lastSavedAt,
      }),
      onRehydrateStorage: () => (state, error) => {
        if (error || !state) {
          // A corrupt draft must not brick the app — boot with a fresh project.
          useProjectStore.setState({ hydrated: true });
          return;
        }
        state.markHydrated();
      },
    },
  ),
);

onStorageWrite((key, outcome) => {
  if (key !== DRAFT_STORAGE_KEY) return;
  if (useProjectStore.getState().draftStatus !== outcome) {
    useProjectStore.setState({ draftStatus: outcome });
  }
});
