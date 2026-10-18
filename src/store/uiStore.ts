/**
 * Transient UI state: which overlays are open, and pending confirmations.
 * Nothing here is persisted or written to a project file.
 */

import { create } from 'zustand';

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  destructive?: boolean;
  resolve: (confirmed: boolean) => void;
}

interface UiState {
  settingsOpen: boolean;
  openSettings: () => void;
  setSettingsOpen: (open: boolean) => void;

  /** The onboarding wizard, re-opened from Settings → Run setup again. */
  wizardOpen: boolean;
  openWizard: () => void;
  closeWizard: () => void;

  /** "Export for presentation", reachable from every tab via the top bar. */
  presentationOpen: boolean;
  openPresentation: () => void;
  setPresentationOpen: (open: boolean) => void;

  /** "Design with AI", from the top bar, the Library and an empty canvas. */
  designWithAiOpen: boolean;
  openDesignWithAi: () => void;
  setDesignWithAiOpen: (open: boolean) => void;

  /** The keyboard shortcut sheet, on `?`. */
  shortcutsOpen: boolean;
  openShortcuts: () => void;
  setShortcutsOpen: (open: boolean) => void;

  confirmRequest: ConfirmRequest | null;
  /** Resolves true when the user confirms, false on cancel or dismiss. */
  requestConfirm: (options: Omit<ConfirmRequest, 'resolve'>) => Promise<boolean>;
  resolveConfirm: (confirmed: boolean) => void;
}

export const useUiStore = create<UiState>()((set, get) => ({
  settingsOpen: false,
  openSettings: () => set({ settingsOpen: true }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),

  wizardOpen: false,
  openWizard: () => set({ wizardOpen: true }),
  closeWizard: () => set({ wizardOpen: false }),

  presentationOpen: false,
  openPresentation: () => set({ presentationOpen: true }),
  setPresentationOpen: (presentationOpen) => set({ presentationOpen }),

  designWithAiOpen: false,
  openDesignWithAi: () => set({ designWithAiOpen: true }),
  setDesignWithAiOpen: (designWithAiOpen) => set({ designWithAiOpen }),

  shortcutsOpen: false,
  openShortcuts: () => set({ shortcutsOpen: true }),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),

  confirmRequest: null,

  requestConfirm: (options) =>
    new Promise<boolean>((resolve) => {
      // A second request while one is pending would strand the first promise.
      const pending = get().confirmRequest;
      if (pending) pending.resolve(false);
      set({ confirmRequest: { ...options, resolve } });
    }),

  resolveConfirm: (confirmed) => {
    const pending = get().confirmRequest;
    set({ confirmRequest: null });
    pending?.resolve(confirmed);
  },
}));
