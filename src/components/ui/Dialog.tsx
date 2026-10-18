import * as RadixDialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** Hides the close affordances for flows the user must finish (onboarding). */
  dismissible?: boolean;
  className?: string;
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  dismissible = true,
  className,
}: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="oc-overlay-motion fixed inset-0 z-50 bg-black/45 backdrop-blur-[2px]" />
        <RadixDialog.Content
          className={cn(
            'oc-dialog-motion fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[min(calc(100vw-2rem),34rem)]',
            '-translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl',
            'border border-line bg-elevated shadow-[var(--shadow-dialog)]',
            className,
          )}
          onEscapeKeyDown={(event) => !dismissible && event.preventDefault()}
          onPointerDownOutside={(event) => !dismissible && event.preventDefault()}
          onInteractOutside={(event) => !dismissible && event.preventDefault()}
        >
          <header className="flex items-start justify-between gap-4 px-6 pb-4 pt-5">
            <div className="min-w-0">
              <RadixDialog.Title className="text-[15px] font-semibold tracking-tight text-ink">
                {title}
              </RadixDialog.Title>
              {description ? (
                <RadixDialog.Description className="mt-1 text-[13px] leading-relaxed text-ink-muted">
                  {description}
                </RadixDialog.Description>
              ) : (
                // Radix warns when Content has no description; this keeps the
                // a11y tree honest without rendering visible chrome.
                <RadixDialog.Description className="sr-only">{title}</RadixDialog.Description>
              )}
            </div>
            {dismissible ? (
              <RadixDialog.Close
                aria-label="Close"
                className="oc-pressable -mr-1.5 -mt-1 rounded-md p-1.5 text-ink-faint hover:bg-sunken hover:text-ink"
              >
                <X size={16} strokeWidth={2} />
              </RadixDialog.Close>
            ) : null}
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-1">{children}</div>

          {footer ? (
            <footer className="mt-2 flex items-center justify-end gap-2 border-t border-line bg-panel/60 px-6 py-4">
              {footer}
            </footer>
          ) : (
            <div className="pb-5" />
          )}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
