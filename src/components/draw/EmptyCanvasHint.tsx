import { Sparkles } from 'lucide-react';
import { useNavigate } from 'react-router';
import { useProjectStore } from '../../store/projectStore';
import { useUiStore } from '../../store/uiStore';

/**
 * What a brand-new, empty chip says: the three ways to start.
 *
 * Gone the moment the design has a node in it. The wrapper ignores the pointer,
 * so a click anywhere but on the two links still lands on the canvas — this
 * must never get in the way of drawing the first channel.
 */
export function EmptyCanvasHint() {
  const empty = useProjectStore((s) => s.project.channelGraph.nodes.length === 0);
  const openDesignWithAi = useUiStore((s) => s.openDesignWithAi);
  const navigate = useNavigate();

  if (!empty) return null;

  return (
    <div className="pointer-events-none absolute inset-0 grid place-items-center p-6">
      <div className="max-w-xs rounded-xl border border-line bg-panel/90 px-5 py-4 text-center shadow-[var(--shadow-menu)] backdrop-blur-sm">
        <p className="text-[13px] font-medium text-ink">An empty chip</p>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">
          Press <kbd className="rounded border border-line bg-panel px-1 font-mono text-[11px]">P</kbd>{' '}
          and click to draw a channel, start from a{' '}
          <button
            type="button"
            onClick={() => void navigate('/library')}
            className="pointer-events-auto text-accent underline underline-offset-2"
          >
            template
          </button>
          , or describe it to an AI.
        </p>
        <button
          type="button"
          onClick={openDesignWithAi}
          className="oc-pressable pointer-events-auto mt-3 inline-flex items-center gap-1.5 rounded-md bg-accent-wash px-2.5 py-1 text-[12px] font-medium text-accent hover:text-accent-hover"
        >
          <Sparkles size={13} /> Design with AI
        </button>
      </div>
    </div>
  );
}
