/**
 * The fluid inputs as the estimate should see them, derived without writing.
 *
 * A project's stored fluid list and port assignments can lag the drawing: a
 * fresh project has no fluids yet, a port drawn since the Fluid tab was last
 * open has no assignment, and a deleted port leaves one behind. These functions
 * fill those gaps on read. Doing it on read rather than by writing the fixes
 * back keeps a freshly saved project clean when someone merely looks at the
 * Fluid tab; the reconciled setup is only stored once the user edits it.
 *
 * Both return their input unchanged (the same object) when nothing needs
 * filling, so memoised consumers do not see a change that is not one.
 */

import { FLUID_PRESETS } from './properties';
import type { ChannelGraph, FluidAssignment, FluidProfile, FluidSetup } from '../../types/project';

/** The stored fluid list, or the built-in presets while it is still empty. */
export function effectiveProfiles(profiles: FluidProfile[]): FluidProfile[] {
  return profiles.length > 0 ? profiles : FLUID_PRESETS;
}

/**
 * Port assignments in step with the drawing: stale ones dropped, and a default
 * added for every port without one.
 */
export function reconcileFluidSetup(
  graph: ChannelGraph,
  setup: FluidSetup,
  profiles: FluidProfile[],
): FluidSetup {
  const ports = graph.nodes.filter((n) => n.type === 'port');
  const known = new Set(setup.assignments.map((a) => a.portId));
  const live = new Set(ports.map((p) => p.id));

  const missing = ports.filter((p) => !known.has(p.id));
  const stale = setup.assignments.some((a) => !live.has(a.portId));
  if (missing.length === 0 && !stale) return setup;

  const kept = stale ? setup.assignments.filter((a) => live.has(a.portId)) : setup.assignments;
  const alreadyHasInlet = kept.some((a) => a.role === 'inlet');

  const added: FluidAssignment[] = missing.map((port, index) => ({
    portId: port.id,
    // First port becomes the inlet so a freshly drawn chip has a runnable
    // default; everything after is an outlet.
    role: !alreadyHasInlet && index === 0 ? 'inlet' : 'outlet',
    fluidProfileId: effectiveProfiles(profiles)[0].id,
    flowRateUlPerMin: 10,
    inletTemperatureC: null,
  }));

  return { ...setup, assignments: [...kept, ...added] };
}
