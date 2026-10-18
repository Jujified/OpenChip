import { useUiStore } from '../store/uiStore';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';

/** Renders whatever `uiStore.requestConfirm` is currently awaiting. */
export function ConfirmDialog() {
  const request = useUiStore((state) => state.confirmRequest);
  const resolve = useUiStore((state) => state.resolveConfirm);

  return (
    <Dialog
      open={request !== null}
      // Dismissing by Escape or backdrop is a "no" — never a silent yes.
      onOpenChange={(open) => !open && resolve(false)}
      title={request?.title ?? ''}
      description={request?.message}
      className="w-[min(calc(100vw-2rem),26rem)]"
      footer={
        <>
          <Button variant="ghost" onClick={() => resolve(false)}>
            Cancel
          </Button>
          <Button
            variant={request?.destructive ? 'danger' : 'primary'}
            autoFocus
            onClick={() => resolve(true)}
          >
            {request?.confirmLabel ?? 'Confirm'}
          </Button>
        </>
      }
    >
      <div />
    </Dialog>
  );
}
