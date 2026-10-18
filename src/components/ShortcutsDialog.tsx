import { SHORTCUT_GROUPS } from '../lib/shortcuts';
import { useUiStore } from '../store/uiStore';
import { Dialog } from './ui/Dialog';

/**
 * The keyboard shortcut sheet, on `?`.
 *
 * Reads from the same catalogue the rest of the app quotes, so a shortcut
 * cannot be wired up and left undocumented — the usual way a sheet like this
 * quietly starts lying.
 */
export function ShortcutsDialog() {
  const open = useUiStore((s) => s.shortcutsOpen);
  const setOpen = useUiStore((s) => s.setShortcutsOpen);

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Keyboard shortcuts"
      description="Everything the drawing editor answers to."
      className="w-[min(calc(100vw-2rem),38rem)]"
    >
      <div className="grid gap-6 pb-4 sm:grid-cols-2">
        {SHORTCUT_GROUPS.map((group) => (
          <section key={group.title}>
            <h3 className="font-mono text-[10px] uppercase tracking-widest text-ink-quiet">
              {group.title}
            </h3>
            <dl className="mt-2 flex flex-col gap-2">
              {group.shortcuts.map((shortcut) => (
                <div key={shortcut.keys} className="flex items-baseline justify-between gap-3">
                  <div className="min-w-0">
                    <dt className="text-[12.5px] leading-snug text-ink">{shortcut.label}</dt>
                    {shortcut.detail ? (
                      <dd className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">
                        {shortcut.detail}
                      </dd>
                    ) : null}
                  </div>
                  <kbd className="shrink-0 rounded border border-line bg-sunken px-1.5 py-0.5 font-mono text-[10.5px] text-ink-muted">
                    {shortcut.keys}
                  </kbd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
