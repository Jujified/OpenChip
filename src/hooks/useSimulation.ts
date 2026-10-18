import { useDeferredValue, useMemo } from 'react';
import { effectiveProfiles, reconcileFluidSetup } from '../lib/fluids/reconcile';
import { simulate, type SimulationResult } from '../lib/fluids/simulate';
import { useProjectStore } from '../store/projectStore';
import type { FluidAssignment, FluidProfile, FluidSetup } from '../types/project';

/**
 * Runs the estimate whenever the geometry, the fluids or the assignments change.
 *
 * Memoised rather than triggered by a "Run" button: the whole point of an
 * analytical model over CFD is that it is cheap enough to be live, so widening a
 * channel should move the numbers immediately.
 *
 * "Immediately" means the next idle moment, not inside the input event: the
 * inputs are deferred, as in `useValidation`, so typing a flow rate or dragging
 * never waits on a network solve.
 */
export function useSimulation(): SimulationResult {
  const graph = useDeferredValue(useProjectStore((s) => s.project.channelGraph));
  const chipParams = useDeferredValue(useProjectStore((s) => s.project.chipParams));
  const storedProfiles = useDeferredValue(useProjectStore((s) => s.project.fluidProfiles));
  const storedSetup = useDeferredValue(useProjectStore((s) => s.project.fluidSetup));

  return useMemo(() => {
    const fluidProfiles = effectiveProfiles(storedProfiles);
    const fluidSetup = reconcileFluidSetup(graph, storedSetup, fluidProfiles);
    return simulate({ graph, chipParams, fluidProfiles, fluidSetup });
  }, [graph, chipParams, storedProfiles, storedSetup]);
}

/**
 * The fluid list and port assignments as the Fluid tab shows them.
 *
 * A user arriving at the tab sees the built-in fluids and a default assignment
 * for every port the drawing already has, rather than an empty list and a
 * blank table to hand-build before seeing a single number. None of that is
 * written to the project until the user edits something, so merely opening
 * the tab never marks a saved project as changed. See `lib/fluids/reconcile`.
 */
export function useFluidInputs(): { profiles: FluidProfile[]; setup: FluidSetup } {
  const graph = useProjectStore((s) => s.project.channelGraph);
  const storedProfiles = useProjectStore((s) => s.project.fluidProfiles);
  const storedSetup = useProjectStore((s) => s.project.fluidSetup);

  const profiles = effectiveProfiles(storedProfiles);
  const setup = useMemo(
    () => reconcileFluidSetup(graph, storedSetup, profiles),
    [graph, storedSetup, profiles],
  );
  return { profiles, setup };
}

/** The fluid a given assignment resolves to, falling back to the first available. */
export function resolveFluid(
  assignment: FluidAssignment | undefined,
  profiles: FluidProfile[],
): FluidProfile | null {
  if (profiles.length === 0) return null;
  if (!assignment?.fluidProfileId) return profiles[0];
  return profiles.find((f) => f.id === assignment.fluidProfileId) ?? profiles[0];
}
