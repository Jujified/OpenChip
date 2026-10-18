import { Suspense, lazy, useEffect, useRef } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { Toaster, toast } from 'sonner';
import { ConfirmDialog } from './components/ConfirmDialog';
import { DesignWithAiDialog } from './components/DesignWithAiDialog';
import { PresentationExportDialog } from './components/PresentationExportDialog';
import { ShortcutsDialog } from './components/ShortcutsDialog';
import { TourOverlay } from './components/tour/TourOverlay';
import { SettingsDialog } from './components/SettingsDialog';
import { TopBar } from './components/TopBar';
import { OnboardingWizard, type OnboardingResult } from './components/onboarding/OnboardingWizard';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { CHIP_PRESETS, presetBuild, projectOptionsFromPreset } from './lib/presets';
import { useTourStore } from './store/tourStore';
import { draftExistedAtBoot, storageIsPersistent } from './lib/persistence';
import { useProjectStore } from './store/projectStore';
import { useSettingsStore } from './store/settingsStore';
import { useUiStore } from './store/uiStore';
// Paper.js and Three.js together are the bulk of the bundle, and neither is
// needed to reach the app. Splitting them out means a user who opens the
// project and reads the parameters never downloads a 3D engine.
//
// Every view is split, not just the two heavy ones: the fluid view reaches
// Paper through its canvas, and one eager import of it was enough to pull all
// of Paper back into the entry chunk.
const DrawView = lazy(() =>
  import('./views/DrawView').then((m) => ({ default: m.DrawView })),
);
const CadPreviewView = lazy(() =>
  import('./views/CadPreviewView').then((m) => ({ default: m.CadPreviewView })),
);
const FluidDynamicsView = lazy(() =>
  import('./views/FluidDynamicsView').then((m) => ({ default: m.FluidDynamicsView })),
);
const LibraryView = lazy(() =>
  import('./views/LibraryView').then((m) => ({ default: m.LibraryView })),
);

export default function App() {
  const settingsHydrated = useSettingsStore((state) => state.hydrated);
  const onboardingCompleted = useSettingsStore((state) => state.onboardingCompleted);
  const completeOnboarding = useSettingsStore((state) => state.completeOnboarding);

  const projectHydrated = useProjectStore((state) => state.hydrated);
  const newProject = useProjectStore((state) => state.newProject);

  const tourCompleted = useSettingsStore((state) => state.tourCompleted);
  const completeTour = useSettingsStore((state) => state.completeTour);
  const startTour = useTourStore((state) => state.start);
  const tourActive = useTourStore((state) => state.active);

  const wizardOpen = useUiStore((state) => state.wizardOpen);
  const closeWizard = useUiStore((state) => state.closeWizard);

  const ready = settingsHydrated && projectHydrated;
  const showWizard = ready && (!onboardingCompleted || wizardOpen);

  useBootProject(ready, onboardingCompleted);
  useTourTemplate(tourActive);
  // Marked done the moment it starts, not when it finishes: a user who leaves
  // halfway has seen enough to have made that choice, and re-offering it on the
  // next load would override them. It stays available from the Settings menu.
  useEffect(() => {
    if (tourActive && !tourCompleted) completeTour();
  }, [tourActive, tourCompleted, completeTour]);
  useDraftRestoredNotice(ready);
  useDraftStorageNotice();
  useUnsavedChangesGuard();
  useKeyboardShortcuts({ enabled: !showWizard });

  const handleOnboardingComplete = ({ profile, projectName }: OnboardingResult) => {
    // Order matters: the profile becomes the default first, so the project
    // created next inherits it even if the explicit argument is ever dropped.
    completeOnboarding(profile);
    newProject({ name: projectName, printerProfile: profile });
    closeWizard();
    toast.success(`“${projectName}” is ready`, {
      description: storageIsPersistent
        ? 'Your work is kept in this browser as you go. Save to a .openchip file to keep it for good.'
        : 'This browser has storage disabled, so save to a .openchip file as you work.',
      duration: 7000,
    });

    if (!tourCompleted) startTour();
  };

  if (!ready) return <BootScreen />;

  return (
    <div className="flex h-full flex-col bg-app">
      <TopBar />

      <main className="min-h-0 flex-1 overflow-auto bg-canvas">
        <Suspense fallback={<ViewLoading />}>
          <Routes>
            <Route path="/" element={<Navigate to="/draw" replace />} />
            <Route path="/draw" element={<DrawView />} />
            <Route path="/cad" element={<CadPreviewView />} />
            <Route path="/fluid" element={<FluidDynamicsView />} />
            <Route path="/library" element={<LibraryView />} />
            <Route path="*" element={<Navigate to="/draw" replace />} />
          </Routes>
        </Suspense>
      </main>

      <SettingsDialog />
      <PresentationExportDialog />
      <ShortcutsDialog />
      <DesignWithAiDialog />
      <ConfirmDialog />
      <TourOverlay />

      <OnboardingWizard
        open={showWizard}
        onComplete={handleOnboardingComplete}
        // Cancelling is only offered on a re-run — on first run there is no
        // configured state to fall back to.
        onCancel={onboardingCompleted ? closeWizard : undefined}
      />

      <Toaster
        position="bottom-right"
        theme="system"
        offset={16}
        toastOptions={{ classNames: { toast: 'font-sans' } }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

/**
 * Gives a returning user with no saved draft a project built from their default
 * printer, rather than the throwaway one the store constructs at module load.
 */
function useBootProject(ready: boolean, onboardingCompleted: boolean) {
  const done = useRef(false);

  useEffect(() => {
    if (!ready || done.current) return;
    done.current = true;
    if (onboardingCompleted && !draftExistedAtBoot) useProjectStore.getState().newProject();
  }, [ready, onboardingCompleted]);
}

/**
 * Gives the tour something to point at.
 *
 * On a genuine first run the project is empty, so the CAD tab shows its empty
 * state and neither the split control nor the warnings panel exists to
 * spotlight. Opening the serpentine template fixes that — and only when the
 * project is empty, so a returning user taking the tour again never loses work.
 */
function useTourTemplate(tourActive: boolean) {
  const loaded = useRef(false);

  useEffect(() => {
    if (!tourActive) {
      loaded.current = false;
      return;
    }
    if (loaded.current) return;
    loaded.current = true;

    const { project } = useProjectStore.getState();
    if (project.channelGraph.edges.length > 0) return;

    const preset = CHIP_PRESETS[0];
    useProjectStore.getState().newProject(projectOptionsFromPreset(preset, presetBuild(preset)));
    toast(`Opened the ${preset.name.toLowerCase()} to try things on`, {
      description: 'It is a normal project — change anything, or start over from Project → New.',
      duration: 6000,
    });
  }, [tourActive]);
}

/** Tells the user their unsaved work came back, rather than letting it be a surprise. */
function useDraftRestoredNotice(ready: boolean) {
  const shown = useRef(false);

  useEffect(() => {
    if (!ready || shown.current) return;

    const { restoredUnsavedDraft, restoredAt, project, dismissDraftNotice, draftOmittedImages } =
      useProjectStore.getState();
    if (!restoredUnsavedDraft) return;

    shown.current = true;
    const omitted =
      draftOmittedImages > 0
        ? ` ${draftOmittedImages} saved image${draftOmittedImages === 1 ? ' was' : 's were'} too large for browser storage and could not be kept.`
        : '';
    toast('Restored your unsaved work', {
      description: `“${project.meta.name}”${restoredAt ? `, from ${relativeTime(restoredAt)}` : ''}.${omitted} Save it to a file to keep it permanently.`,
      duration: 8000,
    });
    dismissDraftNotice();
  }, [ready]);
}

/**
 * Says so when autosave stops keeping up. The draft lives in browser
 * storage with a ~5 MB cap; a project with a few high-res snapshots outgrows
 * it, and before this the draft just froze where it was, without a word.
 */
function useDraftStorageNotice() {
  const status = useProjectStore((s) => s.draftStatus);
  const last = useRef(status);

  useEffect(() => {
    if (status === last.current) return;
    last.current = status;

    if (status === 'shrunk') {
      toast.warning('Autosave is leaving out your saved images', {
        description:
          'This project is too large for browser storage, so the recovery draft keeps your design but not your snapshots. Save to a file to keep them.',
        duration: 10000,
      });
    } else if (status === 'failed') {
      toast.error('Autosave is off', {
        description:
          'This project is too large for browser storage. Save it to a file — that copy has no size limit.',
        duration: 12000,
      });
    }
  }, [status]);
}

function relativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds) || seconds < 60) return 'a moment ago';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * The draft survives a reload, but not a closed tab with cleared storage — and
 * the `.openchip` file is the real artifact either way.
 */
function useUnsavedChangesGuard() {
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!useProjectStore.getState().isDirty) return;
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);
}

// ---------------------------------------------------------------------------

function BootScreen() {
  return (
    <div className="flex h-full items-center justify-center bg-app">
      <span className="sr-only">Loading OpenChip</span>
    </div>
  );
}

/** Shown while a lazily-loaded tab's chunk arrives. Deliberately quiet. */
function ViewLoading() {
  return (
    <div className="flex h-full items-center justify-center bg-canvas">
      <span className="font-mono text-[11px] text-ink-quiet">loading…</span>
    </div>
  );
}
