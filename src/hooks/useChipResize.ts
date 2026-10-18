import { useCallback } from 'react';
import { toast } from 'sonner';
import { centerInChip, centerOffsetMm } from '../lib/graphOps';
import { useProjectStore } from '../store/projectStore';
import type { ChipParams, Point2 } from '../types/project';

/** Closer than this to the middle and there is nothing worth offering to fix. */
const THRESHOLD_MM = 0.05;

/** One id, so holding an arrow key on a dimension field replaces the offer
 *  rather than stacking a column of identical toasts. */
const TOAST_ID = 'chip-resize-recenter';

const round = (mm: number) => Number(mm.toFixed(2));

function offsetText(delta: Point2): string {
  const parts: string[] = [];
  if (Math.abs(delta.x) >= THRESHOLD_MM) parts.push(`${round(Math.abs(delta.x))} mm in X`);
  if (Math.abs(delta.y) >= THRESHOLD_MM) parts.push(`${round(Math.abs(delta.y))} mm in Y`);
  return parts.join(' and ');
}

/**
 * Edits the chip's width or length, and offers to re-center what is drawn on it.
 *
 * Resizing deliberately does **not** move the channels. A feature placed hard
 * against one edge is usually placed there on purpose, and a resize that
 * silently dragged every node would land in the undo history as a move the user
 * never made. But growing a 40 mm chip to 60 mm does leave the design hugging
 * one side, so the offer is made and the decision stays with the user.
 */
export function useChipResize() {
  const updateChipParams = useProjectStore((s) => s.updateChipParams);
  const updateGraph = useProjectStore((s) => s.updateGraph);

  return useCallback(
    (patch: Partial<Pick<ChipParams, 'width' | 'length'>>) => {
      updateChipParams(patch);

      const { project } = useProjectStore.getState();
      if (project.channelGraph.nodes.length === 0) return;

      const deltaMm = centerOffsetMm(project.channelGraph, project.chipParams);
      if (Math.abs(deltaMm.x) < THRESHOLD_MM && Math.abs(deltaMm.y) < THRESHOLD_MM) {
        // Typing 60 and then back to 40 leaves a stale offer on screen
        // otherwise, pointing at a problem that is no longer there.
        toast.dismiss(TOAST_ID);
        return;
      }

      toast('Channels are off-center', {
        id: TOAST_ID,
        description: `Off by ${offsetText(deltaMm)} on the ${project.chipParams.width} × ${project.chipParams.length} mm chip.`,
        action: {
          label: 'Center',
          onClick: () => {
            // Measure again rather than trusting the offer: the design may have
            // been centered from the inspector, or the chip resized again,
            // while this toast sat on screen.
            const current = useProjectStore.getState().project;
            const { graph, deltaMm } = centerInChip(current.channelGraph, current.chipParams);

            if (deltaMm.x === 0 && deltaMm.y === 0) {
              toast.success('Already centered');
              return;
            }

            updateGraph(() => graph, { label: 'center design' });
            toast.success('Design centered in the chip');
          },
        },
      });
    },
    [updateChipParams, updateGraph],
  );
}
