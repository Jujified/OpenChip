import { ArrowLeft, Beaker, Droplet, LogIn, LogOut, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  computeConsumption,
  formatDurationS,
  formatFlowMlPerH,
  formatFlowUlPerMin,
  formatVolumeUl,
} from '../../lib/fluids/consumption';
import {
  APPROXIMATE_VALUES_NOTE,
  createCustomFluid,
  glycerolWaterProfile,
  isPreset,
  prandtl,
} from '../../lib/fluids/properties';
import type { SimulationResult } from '../../lib/fluids/simulate';
import { resolveFluid, useFluidInputs } from '../../hooks/useSimulation';
import { useProjectStore } from '../../store/projectStore';
import { useFluidStore } from '../../store/fluidStore';
import type { FluidAssignment, FluidProfile, PortNode } from '../../types/project';
import { Button } from '../ui/Button';
import { Field, NumberInput, Segmented, TextInput } from '../ui/Field';
import { Section } from '../draw/InspectorPanel';

export function FluidPanel({ result }: { result: SimulationResult }) {
  const editingFluidId = useFluidStore((s) => s.editingFluidId);

  return (
    <aside className="flex w-[20rem] shrink-0 flex-col overflow-y-auto border-l border-line bg-panel">
      {editingFluidId ? (
        <FluidEditor fluidId={editingFluidId} />
      ) : (
        <SetupSections result={result} />
      )}
    </aside>
  );
}

function SetupSections({ result }: { result: SimulationResult }) {
  return (
    <>
      <InletAssignments />
      {/* Directly under the flow rates it reads: the answer to "what does this
          cost me" belongs next to the control that decides it. */}
      <Consumption result={result} />
      <FluidLibrary />
      <ChipMaterial />
    </>
  );
}

// ---------------------------------------------------------------------------
// port roles and fluid assignment
// ---------------------------------------------------------------------------

function InletAssignments() {
  const graph = useProjectStore((s) => s.project.channelGraph);
  const { profiles, setup } = useFluidInputs();
  const setFluidSetup = useProjectStore((s) => s.setFluidSetup);

  const ports = graph.nodes.filter((n): n is PortNode => n.type === 'port');

  const patch = (portId: string, changes: Partial<FluidAssignment>) => {
    setFluidSetup({
      ...setup,
      assignments: setup.assignments.map((a) => (a.portId === portId ? { ...a, ...changes } : a)),
    });
  };

  if (ports.length === 0) {
    return (
      <Section title="Ports">
        <p className="text-[11px] leading-relaxed text-ink-muted">
          This chip has no ports yet. Add one at each end of the network on the Draw tab — the
          estimate needs somewhere for fluid to enter and leave.
        </p>
      </Section>
    );
  }

  return (
    <Section title="Ports & fluids">
      {ports.map((port, index) => {
        const assignment = setup.assignments.find((a) => a.portId === port.id);
        if (!assignment) return null;
        const isInlet = assignment.role === 'inlet';
        const fluid = profiles.find((f) => f.id === assignment.fluidProfileId) ?? profiles[0];

        return (
          <div key={port.id} className="rounded-lg border border-line bg-sunken p-2.5">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-[12px] font-medium text-ink">
                {isInlet ? (
                  <LogIn size={12} className="text-accent" />
                ) : (
                  <LogOut size={12} className="text-ink-faint" />
                )}
                Port {index + 1}
              </span>
              <span className="font-mono text-[10px] text-ink-quiet">{port.portType}</span>
            </div>

            <Segmented
              value={assignment.role}
              onChange={(role) => patch(port.id, { role })}
              options={[
                { value: 'inlet' as const, label: 'Inlet' },
                { value: 'outlet' as const, label: 'Outlet' },
              ]}
              className="w-full"
            />

            {isInlet ? (
              <div className="mt-2.5 flex flex-col gap-2.5">
                <Field label="Fluid" htmlFor={`fluid-${port.id}`}>
                  <select
                    id={`fluid-${port.id}`}
                    value={assignment.fluidProfileId ?? ''}
                    onChange={(event) => patch(port.id, { fluidProfileId: event.target.value })}
                    className="h-8 w-full rounded-lg border border-line bg-panel px-2 text-[12px] text-ink outline-none focus:border-accent"
                  >
                    {profiles.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                </Field>

                <div className="grid grid-cols-2 gap-2">
                  <Field label="Flow" htmlFor={`flow-${port.id}`}>
                    <NumberInput
                      id={`flow-${port.id}`}
                      value={assignment.flowRateUlPerMin}
                      onChange={(flowRateUlPerMin) => patch(port.id, { flowRateUlPerMin })}
                      unit="µL/min"
                      min={0}
                      step={1}
                      precision={3}
                    />
                  </Field>
                  <Field label="Inlet temp" htmlFor={`temp-${port.id}`}>
                    <NumberInput
                      id={`temp-${port.id}`}
                      value={assignment.inletTemperatureC ?? fluid?.inletTemperatureC ?? 20}
                      onChange={(inletTemperatureC) => patch(port.id, { inletTemperatureC })}
                      unit="°C"
                      step={1}
                      precision={2}
                    />
                  </Field>
                </div>

                {fluid?.nonNewtonianNote ? (
                  <p className="rounded border border-caution/40 bg-caution-wash px-2 py-1.5 text-[10px] leading-relaxed text-ink">
                    {fluid.nonNewtonianNote}
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="mt-2 text-[10px] leading-relaxed text-ink-muted">
                Held at ambient pressure. Whatever reaches it, leaves.
              </p>
            )}
          </div>
        );
      })}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// reagent consumption and throughput
// ---------------------------------------------------------------------------

/**
 * What a run costs.
 *
 * Deliberately a wall of numbers rather than prose: "300 µL/min · 18.0 mL/h ·
 * 18.0 mL per 60 min" tells a scientist how much buffer to draw up, and a
 * paragraph saying the same thing would take longer to read and mean less.
 *
 * The arithmetic is all in `lib/fluids/consumption`, which is why this file
 * only decides what to show and in what order.
 */
function Consumption({ result }: { result: SimulationResult }) {
  const graph = useProjectStore((s) => s.project.channelGraph);
  const { profiles, setup } = useFluidInputs();

  const runDurationMin = useFluidStore((s) => s.runDurationMin);
  const setRunDurationMin = useFluidStore((s) => s.setRunDurationMin);
  const washMultiplier = useFluidStore((s) => s.washMultiplier);
  const setWashMultiplier = useFluidStore((s) => s.setWashMultiplier);

  // Shown with its reason rather than hidden. A panel that vanishes when the
  // estimate cannot run reads as a bug, and leaves the user with nothing to
  // act on.
  if (result.blockedReason) {
    return (
      <Section title="Consumption">
        <p className="text-[11px] leading-relaxed text-ink-muted">{result.blockedReason}</p>
      </Section>
    );
  }

  const summary = computeConsumption({
    graph,
    result,
    assignments: setup.assignments,
    runDurationMin,
    washMultiplier,
  });

  const portLabel = (portId: string): string => {
    const index = graph.nodes.filter((n) => n.type === 'port').findIndex((n) => n.id === portId);
    return index >= 0 ? `Port ${index + 1}` : 'Port';
  };

  return (
    <Section title="Consumption">
      <div className="grid grid-cols-2 gap-2">
        <Field label="Run duration" htmlFor="run-duration">
          <NumberInput
            id="run-duration"
            value={runDurationMin}
            onChange={setRunDurationMin}
            unit="min"
            min={0}
            step={5}
            precision={2}
          />
        </Field>
        <Field label="Wash volumes" htmlFor="wash-multiplier">
          <NumberInput
            id="wash-multiplier"
            value={washMultiplier}
            onChange={setWashMultiplier}
            unit="×"
            min={0}
            step={1}
            precision={1}
          />
        </Field>
      </div>

      <p className="-mt-1.5 text-[10px] leading-snug text-ink-muted">
        Wash volumes are displacement volumes of the channel network — how many times over you
        flush the chip's own contents through it.
      </p>

      {/* --- totals ------------------------------------------------------- */}
      <div className="rounded-lg border border-line bg-sunken p-2.5">
        <p className="text-[11px] font-medium text-ink">Total draw</p>
        <p className="mt-1 font-mono text-[11px] leading-relaxed text-ink-muted">
          {formatFlowUlPerMin(summary.totalFlowUlPerMin)} ·{' '}
          {formatFlowMlPerH(summary.totalFlowMlPerH)} ·{' '}
          {formatVolumeUl(summary.totalRunVolumeUl)} per {summary.runDurationMin} min
        </p>
      </div>

      {/* --- per inlet ---------------------------------------------------- */}
      {summary.inlets.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-[11px] font-medium text-ink">Per inlet</p>
          {summary.inlets.map((inlet) => (
            <Row
              key={inlet.portId}
              label={portLabel(inlet.portId)}
              sub={
                resolveFluid(
                  setup.assignments.find((a) => a.portId === inlet.portId),
                  profiles,
                )?.name ?? 'No fluid'
              }
              value={formatVolumeUl(inlet.runVolumeUl)}
              valueSub={`${formatFlowUlPerMin(inlet.flowUlPerMin)} · ${formatFlowMlPerH(inlet.flowMlPerH)}`}
            />
          ))}
        </div>
      ) : null}

      {/* --- per outlet --------------------------------------------------- */}
      {summary.outlets.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-[11px] font-medium text-ink">Per outlet</p>
          {summary.outlets.map((outlet) => (
            <Row
              key={outlet.portId}
              label={portLabel(outlet.portId)}
              sub="Collected"
              value={formatVolumeUl(outlet.runVolumeUl)}
              valueSub={`${formatFlowUlPerMin(outlet.flowUlPerMin)} · ${formatFlowMlPerH(outlet.flowMlPerH)}`}
            />
          ))}
        </div>
      ) : null}

      {/* --- the whole chip ----------------------------------------------- */}
      <div className="flex flex-col gap-1.5">
        <p className="text-[11px] font-medium text-ink">Priming and wash</p>
        <Row
          label="Priming volume"
          sub="Channels only"
          value={formatVolumeUl(summary.primingVolumeUl)}
          valueSub={formatDurationS(summary.primingTimeS)}
        />
        <Row
          label="First drop out"
          sub={
            summary.slowestTransitS - summary.timeToFirstDropS > summary.timeToFirstDropS * 0.01
              ? `Slowest route ${formatDurationS(summary.slowestTransitS)}`
              : 'Fastest inlet → outlet'
          }
          value={formatDurationS(summary.timeToFirstDropS)}
        />
        <Row
          label="Wash volume"
          sub={`${summary.washMultiplier}× the network`}
          value={formatVolumeUl(summary.washVolumeUl)}
          valueSub={formatDurationS(summary.washTimeS)}
        />
      </div>
    </Section>
  );
}

function Row({
  label,
  sub,
  value,
  valueSub,
}: {
  label: string;
  sub?: string;
  value: string;
  valueSub?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-line/60 pb-1.5 last:border-b-0 last:pb-0">
      <span className="min-w-0">
        <span className="block truncate text-[11px] text-ink">{label}</span>
        {sub ? <span className="block truncate text-[10px] text-ink-quiet">{sub}</span> : null}
      </span>
      <span className="shrink-0 text-right">
        <span className="block font-mono text-[11px] text-ink">{value}</span>
        {valueSub ? (
          <span className="block font-mono text-[10px] text-ink-quiet">{valueSub}</span>
        ) : null}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// fluid library
// ---------------------------------------------------------------------------

function FluidLibrary() {
  const { profiles } = useFluidInputs();
  const setFluidProfiles = useProjectStore((s) => s.setFluidProfiles);
  const setEditingFluidId = useFluidStore((s) => s.setEditingFluidId);

  return (
    <Section
      title="Fluids"
      action={
        <button
          type="button"
          title="Add a custom fluid"
          onClick={() => {
            const fluid = createCustomFluid();
            setFluidProfiles([...profiles, fluid]);
            setEditingFluidId(fluid.id);
          }}
          className="oc-pressable rounded p-1 text-ink-faint hover:bg-sunken hover:text-ink"
        >
          <Plus size={14} />
        </button>
      }
    >
      <div className="flex flex-col gap-1">
        {profiles.map((fluid) => (
          <button
            key={fluid.id}
            type="button"
            onClick={() => setEditingFluidId(fluid.id)}
            className="oc-pressable flex items-center gap-2 rounded-lg border border-line px-2.5 py-2 text-left hover:border-line-strong"
          >
            <Droplet size={13} className="shrink-0 text-accent" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] text-ink">{fluid.name}</span>
              <span className="block font-mono text-[10px] text-ink-quiet">
                {(fluid.dynamicViscosityPaS * 1000).toFixed(2)} mPa·s ·{' '}
                {fluid.densityKgM3.toFixed(0)} kg/m³
              </span>
            </span>
            {fluid.builtIn ? (
              <span className="shrink-0 rounded bg-sunken px-1 py-0.5 text-[9px] text-ink-quiet">
                preset
              </span>
            ) : null}
          </button>
        ))}
      </div>

      <p className="text-[10px] leading-relaxed text-ink-muted">{APPROXIMATE_VALUES_NOTE}</p>
    </Section>
  );
}

function FluidEditor({ fluidId }: { fluidId: string }) {
  const { profiles } = useFluidInputs();
  const updateFluidProfile = useProjectStore((s) => s.updateFluidProfile);
  const setFluidProfiles = useProjectStore((s) => s.setFluidProfiles);
  const setEditingFluidId = useFluidStore((s) => s.setEditingFluidId);

  const fluid = profiles.find((f) => f.id === fluidId);
  if (!fluid) return null;

  const patch = (changes: Partial<FluidProfile>) => updateFluidProfile(fluidId, changes);

  return (
    <>
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <button
          type="button"
          onClick={() => setEditingFluidId(null)}
          className="oc-pressable rounded p-1 text-ink-muted hover:bg-sunken hover:text-ink"
        >
          <ArrowLeft size={14} />
        </button>
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink">
          {fluid.name}
        </span>
        {!fluid.builtIn ? (
          <button
            type="button"
            title="Delete this fluid"
            onClick={() => {
              setFluidProfiles(profiles.filter((f) => f.id !== fluidId));
              setEditingFluidId(null);
            }}
            className="oc-pressable rounded p-1 text-ink-faint hover:bg-danger-wash hover:text-danger"
          >
            <Trash2 size={13} />
          </button>
        ) : null}
      </div>

      <Section title="Fluid properties">
        <Field label="Name" htmlFor="fluid-name">
          <TextInput
            id="fluid-name"
            value={fluid.name}
            onChange={(event) => patch({ name: event.target.value })}
          />
        </Field>

        {/* Glycerol blends get the percentage control instead of a raw
            viscosity box: the percentage is the thing a bench user actually
            mixes, and the viscosity follows from it non-linearly. */}
        {fluid.glycerolVolumePercent !== undefined ? (
          <Field
            label="Glycerol"
            htmlFor="fluid-glycerol"
            hint="Recomputes density, viscosity and thermal properties from the blend."
          >
            <NumberInput
              id="fluid-glycerol"
              value={fluid.glycerolVolumePercent}
              onChange={(percent) => {
                const next = glycerolWaterProfile(percent, fluid.inletTemperatureC, {
                  id: fluid.id,
                  name: fluid.name,
                });
                patch({
                  glycerolVolumePercent: percent,
                  densityKgM3: next.densityKgM3,
                  dynamicViscosityPaS: next.dynamicViscosityPaS,
                  thermalConductivityWmK: next.thermalConductivityWmK,
                  specificHeatCapacityJkgK: next.specificHeatCapacityJkgK,
                });
              }}
              unit="% vol"
              min={0}
              max={100}
              step={5}
              precision={1}
            />
          </Field>
        ) : null}

        <Field label="Density" htmlFor="fluid-density">
          <NumberInput
            id="fluid-density"
            value={fluid.densityKgM3}
            onChange={(densityKgM3) => patch({ densityKgM3 })}
            unit="kg/m³"
            min={1}
            step={10}
            precision={2}
          />
        </Field>

        <Field
          label="Dynamic viscosity"
          htmlFor="fluid-viscosity"
          hint="Shown in mPa·s (= cP), the unit most datasheets use."
        >
          <NumberInput
            id="fluid-viscosity"
            value={fluid.dynamicViscosityPaS * 1000}
            onChange={(mPaS) => patch({ dynamicViscosityPaS: mPaS / 1000 })}
            unit="mPa·s"
            min={0.001}
            step={0.1}
            precision={4}
          />
        </Field>

        <Field label="Thermal conductivity" htmlFor="fluid-k">
          <NumberInput
            id="fluid-k"
            value={fluid.thermalConductivityWmK}
            onChange={(thermalConductivityWmK) => patch({ thermalConductivityWmK })}
            unit="W/m·K"
            min={0.001}
            step={0.01}
            precision={4}
          />
        </Field>

        <Field label="Specific heat capacity" htmlFor="fluid-cp">
          <NumberInput
            id="fluid-cp"
            value={fluid.specificHeatCapacityJkgK}
            onChange={(specificHeatCapacityJkgK) => patch({ specificHeatCapacityJkgK })}
            unit="J/kg·K"
            min={1}
            step={50}
            precision={1}
          />
        </Field>

        <Field
          label="Default inlet temperature"
          htmlFor="fluid-temp"
          hint="An inlet can override this for a particular run."
        >
          <NumberInput
            id="fluid-temp"
            value={fluid.inletTemperatureC}
            onChange={(inletTemperatureC) => patch({ inletTemperatureC })}
            unit="°C"
            step={1}
            precision={2}
          />
        </Field>

        <p className="font-mono text-[10px] text-ink-quiet">Pr = {prandtl(fluid).toFixed(2)}</p>

        {fluid.nonNewtonianNote ? (
          <p className="rounded border border-caution/40 bg-caution-wash px-2 py-1.5 text-[10px] leading-relaxed text-ink">
            {fluid.nonNewtonianNote}
          </p>
        ) : null}

        {fluid.note ? (
          <p className="text-[10px] leading-relaxed text-ink-muted">{fluid.note}</p>
        ) : null}

        {isPreset(fluid.id) ? (
          <p className="text-[10px] leading-relaxed text-ink-muted">
            Editing a preset changes it for this project only. {APPROXIMATE_VALUES_NOTE}
          </p>
        ) : null}
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------

function ChipMaterial() {
  const setup = useProjectStore((s) => s.project.fluidSetup);
  const setFluidSetup = useProjectStore((s) => s.setFluidSetup);

  return (
    <Section title="Chip material">
      <Field
        label="Thermal conductivity"
        htmlFor="chip-k"
        hint="How readily heat crosses the wall between two channels. Standard photopolymer resin is about 0.2; PDMS is around 0.15, glass about 1.0."
      >
        <NumberInput
          id="chip-k"
          value={setup.chipMaterialThermalConductivityWmK}
          onChange={(chipMaterialThermalConductivityWmK) =>
            setFluidSetup({ ...setup, chipMaterialThermalConductivityWmK })
          }
          unit="W/m·K"
          min={0.001}
          step={0.05}
          precision={4}
        />
      </Field>

      <div className="flex flex-wrap gap-1.5">
        {[
          ['Resin', 0.2],
          ['PDMS', 0.15],
          ['PMMA', 0.19],
          ['Glass', 1.0],
        ].map(([label, value]) => (
          <button
            key={label as string}
            type="button"
            onClick={() =>
              setFluidSetup({ ...setup, chipMaterialThermalConductivityWmK: value as number })
            }
            className="oc-pressable rounded-md border border-line px-2 py-1 text-[11px] text-ink-muted hover:border-line-strong hover:text-ink"
          >
            {label}
          </button>
        ))}
      </div>

      <Button
        size="sm"
        variant="ghost"
        icon={<Beaker size={13} />}
        onClick={() =>
          toast('Material conductivity affects heat exchange only', {
            description:
              'Pressure drop and Reynolds number depend on the fluid and the channel shape, not on what the chip is made of.',
          })
        }
      >
        What does this change?
      </Button>
    </Section>
  );
}
