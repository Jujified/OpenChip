import { useEffect, useMemo, useState } from 'react';
import { compensateDesign, type CompensatedDesign, type NominalDesign } from '../lib/dfm/compensate';
import type { DfmEntry } from '../lib/dfm/exportPlan';
import { selectedDfmEntry, useDfmStore } from '../store/dfmStore';
import { useProjectStore } from '../store/projectStore';
import { useValidationStore } from '../store/validationStore';

/**
 * Long enough that a node drag or a held arrow key collapses into one
 * recompute, short enough that the panel reads as following the edit.
 */
const RECOMPUTE_DEBOUNCE_MS = 150;

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

export interface DfmCompensation {
  entry: DfmEntry;
  nominal: NominalDesign;
  compensated: CompensatedDesign;
}

/**
 * The compensated design for the open project and the selected profile, or
 * null when no profile is selected — in which case nothing is computed at all.
 *
 * This is what the CAD panel *shows*: the offsets, the conflict list and the
 * preview. It only reads the project. An export does not use it; it calls
 * `planExport` against the store's current state at the moment of the click, so
 * a file can never be written from a value that is 150 ms stale.
 *
 * Recomputation is debounced and stays on the main thread. One pass —
 * compensation, both spacing checks and the preview geometry — measures about
 * 15 ms on the largest template (`preview.test.ts` holds it under a budget),
 * which is under a frame at the rate the debounce lets it run. It is the same
 * order of work the Design checks panel already does on every edit.
 */
export function useDfmCompensation(): DfmCompensation | null {
  const entry = useDfmStore(selectedDfmEntry);
  const graph = useProjectStore((s) => s.project.channelGraph);
  const chipParams = useProjectStore((s) => s.project.chipParams);
  const drainageVents = useProjectStore((s) => s.project.drainageVents);
  const printerProfile = useProjectStore((s) => s.project.printerProfile);
  const settings = useValidationStore((s) => s.settings);

  const live = useMemo<NominalDesign>(
    () => ({ graph, chipParams, drainageVents, printerProfile }),
    [graph, chipParams, drainageVents, printerProfile],
  );
  const nominal = useDebouncedValue(live, RECOMPUTE_DEBOUNCE_MS);

  return useMemo(() => {
    if (!entry) return null;
    return { entry, nominal, compensated: compensateDesign(nominal, entry.profile, { settings }) };
  }, [entry, nominal, settings]);
}
