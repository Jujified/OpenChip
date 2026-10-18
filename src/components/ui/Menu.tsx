import * as RadixMenu from '@radix-ui/react-dropdown-menu';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export const MenuRoot = RadixMenu.Root;
export const MenuTrigger = RadixMenu.Trigger;

export function MenuContent({
  children,
  align = 'start',
  className,
}: {
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
  className?: string;
}) {
  return (
    <RadixMenu.Portal>
      <RadixMenu.Content
        align={align}
        sideOffset={6}
        collisionPadding={8}
        className={cn(
          'oc-menu-motion z-50 min-w-56 rounded-xl border border-line bg-elevated p-1',
          'shadow-[var(--shadow-menu)]',
          className,
        )}
      >
        {children}
      </RadixMenu.Content>
    </RadixMenu.Portal>
  );
}

export function MenuItem({
  children,
  onSelect,
  href,
  icon,
  shortcut,
  disabled,
  destructive,
}: {
  children: ReactNode;
  onSelect?: () => void;
  /**
   * Turns the item into a real link that opens in a new tab.
   *
   * An item that navigates should be an anchor, not a click handler calling
   * `window.open`. Three reasons, in the order they bite:
   *
   * 1. `window.open(url, '_blank', 'noopener')` puts `noopener` in the *feature
   *    string*, where support has never been universal. Where it is ignored the
   *    opened page gets a live `window.opener` back into the app — the
   *    reverse-tabnabbing hole. `rel="noopener"` on an anchor has no such gap.
   * 2. Middle-click, ⌘-click and "Open link in new tab" all work, and the
   *    browser shows the destination on hover. A handler offers none of that.
   * 3. It survives popup blockers, which is not a rare configuration on the
   *    locked-down institutional machines this app is used on.
   */
  href?: string;
  icon?: ReactNode;
  /** Rendered right-aligned, e.g. `⌘S`. */
  shortcut?: string;
  disabled?: boolean;
  destructive?: boolean;
}) {
  const className = cn(
    'flex cursor-default select-none items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px]',
    'no-underline outline-none transition-colors duration-100',
    'data-[highlighted]:bg-sunken',
    'data-[disabled]:pointer-events-none data-[disabled]:opacity-40',
    destructive
      ? 'text-danger data-[highlighted]:bg-danger-wash'
      : 'text-ink data-[highlighted]:text-ink',
  );

  const body = (
    <>
      {icon ? <span className="text-ink-faint">{icon}</span> : null}
      <span className="flex-1 truncate">{children}</span>
      {shortcut ? (
        <span className="font-mono text-[11px] tracking-wide text-ink-quiet">{shortcut}</span>
      ) : null}
    </>
  );

  if (href) {
    return (
      <RadixMenu.Item asChild disabled={disabled} onSelect={onSelect}>
        <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
          {body}
        </a>
      </RadixMenu.Item>
    );
  }

  return (
    <RadixMenu.Item disabled={disabled} onSelect={onSelect} className={className}>
      {body}
    </RadixMenu.Item>
  );
}

export function MenuSeparator() {
  return <RadixMenu.Separator className="my-1 h-px bg-line" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <RadixMenu.Label className="px-2.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-ink-quiet">
      {children}
    </RadixMenu.Label>
  );
}
