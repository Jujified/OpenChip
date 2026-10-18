import { useDeferredValue, useMemo } from 'react';
import { runValidation, type ValidationResult } from '../lib/validation';
import { useProjectStore } from '../store/projectStore';
import { useValidationStore } from '../store/validationStore';

/**
 * Runs every check against the current project.
 *
 * Memoised on the inputs, so it re-runs exactly when the geometry, the chip
 * parameters, the printer or the thresholds change — which satisfies "runs
 * automatically whenever the geometry changes" without any explicit
 * invalidation to forget.
 *
 * The geometry inputs are deferred. A node drag changes the graph on every
 * pointer-move, and nobody reads the warnings list mid-drag, so React is free
 * to render the drag frame first and catch the checks up at low priority —
 * rather than every frame waiting on a full validation pass. Anything that
 * needs the exact current graph, such as an export, reads the store instead.
 */
export function useValidation(): ValidationResult {
  const graph = useDeferredValue(useProjectStore((s) => s.project.channelGraph));
  const chipParams = useDeferredValue(useProjectStore((s) => s.project.chipParams));
  const printerProfile = useProjectStore((s) => s.project.printerProfile);
  const drainageVents = useDeferredValue(useProjectStore((s) => s.project.drainageVents));
  const settings = useValidationStore((s) => s.settings);

  return useMemo(
    () => runValidation({ graph, chipParams, printerProfile, drainageVents, settings }),
    [graph, chipParams, printerProfile, drainageVents, settings],
  );
}
