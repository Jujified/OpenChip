import { useEffect } from 'react';
import { useUiStore } from '../store/uiStore';
import { useProjectActions } from './useProjectActions';

/**
 * Global file shortcuts.
 *
 * Only the ones a browser actually lets a page claim are bound and advertised.
 * ⌘N is reserved by the browser for a new window and cannot be intercepted, so
 * New Project lives in the menu without a shortcut rather than showing a hint
 * that does nothing.
 */
export function useKeyboardShortcuts({ enabled }: { enabled: boolean }) {
  const { open, save } = useProjectActions();

  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;

      if (!mod) {
        const target = event.target as HTMLElement | null;
        const typing =
          (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) || target?.isContentEditable;
        // The shortcut sheet is the app's built-in documentation, so it answers
        // from every tab — not only from the one that happens to own the
        // editing shortcuts.
        if (!typing && event.key === '?') useUiStore.getState().openShortcuts();
        return;
      }

      const key = event.key.toLowerCase();

      if (key === 's') {
        event.preventDefault();
        void save({ saveAs: event.shiftKey });
        return;
      }

      if (key === 'o') {
        event.preventDefault();
        void open();
        return;
      }

      // Export lives here rather than with the drawing shortcuts because it is
      // reachable from every tab, the same as Save and Open.
      if (key === 'e' && event.shiftKey) {
        event.preventDefault();
        useUiStore.getState().openPresentation();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled, open, save]);
}
