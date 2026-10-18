import { AlertTriangle, Pin, Trash2 } from 'lucide-react';
import { useMemo } from 'react';
import { cn } from '../../lib/cn';
import { edgesAtNode, isEndpoint } from '../../lib/geometry';
import {
  applyFitting,
  deleteElements,
  findEdgeSpacingWarnings,
  localChannelWidth,
  makeChamber,
  makePort,
  makeWaypointAgain,
  nodeFootprintMm,
  segmentSizeRange,
  setCrossSection,
  setCurveType,
  setSegmentsSize,
  updateEdge,
  updateNode,
} from '../../lib/graphOps';
import {
  END_T,
  markerAtEdgeEnd,
  sizeAtEdgeEnd,
  getLoft,
  upsertDimensionPoint,
  type EdgeEnd,
} from '../../lib/loft';
import { PORT_PRESETS, PORT_TYPES, matchFitting, portFootprintMm } from '../../lib/ports';
import { MOD } from '../../lib/shortcuts';
import { useEditorStore } from '../../store/editorStore';
import { useProjectStore } from '../../store/projectStore';
import type { ChannelNode, CrossSection, PortType } from '../../types/project';
import { Button } from '../ui/Button';
import { Field, NumberInput, Segmented } from '../ui/Field';
import { DrawTools } from './DrawTools';
import { FittingPicker } from './FittingPicker';

export function InspectorPanel() {
  const graph = useProjectStore((s) => s.project.channelGraph);
  const chipParams = useProjectStore((s) => s.project.chipParams);
  const selection = useEditorStore((s) => s.selection);

  const selectedNodes = useMemo(
    () => graph.nodes.filter((n) => selection.nodeIds.includes(n.id)),
    [graph.nodes, selection.nodeIds],
  );
  const selectedEdges = useMemo(
    () => graph.edges.filter((e) => selection.edgeIds.includes(e.id)),
    [graph.edges, selection.edgeIds],
  );

  // Number fields push every valid keystroke into the design, so the canvas and
  // the 3D view follow as you type. Bracketing each field's focus in one graph
  // gesture makes the whole edit a single undo step — typing 12.5 used to leave
  // four — and lets Escape put the design back as it was before the field was
  // touched. Handled here once rather than in each field's handler.
  const isNumberField = (target: EventTarget) =>
    target instanceof HTMLInputElement && target.type === 'number';
  const onFocus = (event: React.FocusEvent) => {
    if (isNumberField(event.target)) useProjectStore.getState().beginGraphEdit();
  };
  const onBlur = (event: React.FocusEvent) => {
    if (isNumberField(event.target)) useProjectStore.getState().endGraphEdit();
  };
  const onKeyDownCapture = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape' && isNumberField(event.target)) {
      useProjectStore.getState().cancelGraphEdit();
    }
  };

  return (
    <aside
      data-tour="inspector"
      className="flex w-[19rem] shrink-0 flex-col overflow-y-auto border-l border-line bg-panel"
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDownCapture={onKeyDownCapture}
    >
      <SelectionSummary nodeCount={selectedNodes.length} edgeCount={selectedEdges.length} />

      {selectedNodes.length === 1 ? <NodeEditor node={selectedNodes[0]} /> : null}
      {selectedNodes.length > 1 ? <MultiNodeEditor count={selectedNodes.length} /> : null}
      {selectedEdges.length >= 1 ? <EdgeEditor edgeIds={selection.edgeIds} /> : null}

      <DrawTools />
      <WarningsSection />

      <div className="mt-auto border-t border-line px-4 py-3 font-mono text-[11px] text-ink-muted">
        chip {chipParams.width} × {chipParams.length} mm · {graph.nodes.length} nodes ·{' '}
        {graph.edges.length} segments
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------

function Section({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="border-b border-line px-4 py-3.5">
      <header className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-quiet">
          {title}
        </h3>
        {action}
      </header>
      <div className="flex flex-col gap-3.5">{children}</div>
    </section>
  );
}

/**
 * Selects every segment and nothing else, so the inspector's segment editor
 * can change them all at once. Null when there is nothing to select, or when
 * every segment already is.
 */
function useSelectAllChannels(): (() => void) | null {
  const edges = useProjectStore((s) => s.project.channelGraph.edges);
  const selection = useEditorStore((s) => s.selection);
  const selectEdges = useEditorStore((s) => s.selectEdges);

  const all =
    selection.nodeIds.length === 0 &&
    edges.length === selection.edgeIds.length &&
    edges.every((e) => selection.edgeIds.includes(e.id));
  if (edges.length === 0 || all) return null;
  return () => selectEdges(edges.map((e) => e.id));
}

function SelectionSummary({ nodeCount, edgeCount }: { nodeCount: number; edgeCount: number }) {
  const selectAllChannels = useSelectAllChannels();

  if (nodeCount === 0 && edgeCount === 0) {
    return (
      <div className="border-b border-line px-4 py-4">
        <p className="text-[13px] font-medium text-ink">Nothing selected</p>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">
          Press <Kbd>P</Kbd> and click to draw channels. Press <Kbd>V</Kbd> to select and move
          things. <Kbd>{MOD}</Kbd>-click a segment to insert a node.
        </p>
        {selectAllChannels ? (
          <Button size="sm" className="mt-3" onClick={selectAllChannels}>
            Select all channels
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="border-b border-line px-4 py-3">
      <p className="font-mono text-[12px] text-ink">
        {nodeCount > 0 ? `${nodeCount} node${nodeCount === 1 ? '' : 's'}` : null}
        {nodeCount > 0 && edgeCount > 0 ? ' · ' : null}
        {edgeCount > 0 ? `${edgeCount} segment${edgeCount === 1 ? '' : 's'}` : null}
      </p>
    </div>
  );
}

const Kbd = ({ children }: { children: React.ReactNode }) => (
  <kbd className="rounded border border-line bg-sunken px-1 font-mono text-[10px] text-ink-muted">
    {children}
  </kbd>
);

// ---------------------------------------------------------------------------
// node
// ---------------------------------------------------------------------------

function NodeEditor({ node }: { node: ChannelNode }) {
  const graph = useProjectStore((s) => s.project.channelGraph);
  const chipParams = useProjectStore((s) => s.project.chipParams);
  const updateGraph = useProjectStore((s) => s.updateGraph);
  const clearSelection = useEditorStore((s) => s.clearSelection);
  const chamberShape = useEditorStore((s) => s.chamberShape);
  const multiple = useEditorStore((s) => s.chamberWidthMultiple);

  const endpoint = isEndpoint(graph.edges, node.id);
  const degree = edgesAtNode(graph.edges, node.id).length;

  return (
    <Section
      title={node.type}
      action={
        <button
          type="button"
          title="Delete this node"
          onClick={() => {
            updateGraph((g) => deleteElements(g, [node.id]), { label: 'delete node' });
            clearSelection();
          }}
          className="oc-pressable rounded p-1 text-ink-faint hover:bg-danger-wash hover:text-danger"
        >
          <Trash2 size={14} />
        </button>
      }
    >
      <div className="grid grid-cols-2 gap-2.5">
        <Field label="X" htmlFor="node-x">
          <NumberInput
            id="node-x"
            value={node.x}
            onChange={(x) => updateGraph((g) => updateNode(g, node.id, { x }), { label: 'move' })}
            unit="mm"
            step={0.1}
            precision={3}
          />
        </Field>
        <Field label="Y" htmlFor="node-y">
          <NumberInput
            id="node-y"
            value={node.y}
            onChange={(y) => updateGraph((g) => updateNode(g, node.id, { y }), { label: 'move' })}
            unit="mm"
            step={0.1}
            precision={3}
          />
        </Field>
      </div>

      {/* Type conversion. Ports are only offered at a path end, because a port
          mid-run has no physical meaning. */}
      <Field
        label="Node type"
        hint={
          !endpoint && node.type !== 'port'
            ? `This node joins ${degree} segments, so it cannot be a port.`
            : undefined
        }
      >
        <div className="flex flex-wrap gap-1.5">
          <TypeChip
            active={node.type === 'waypoint'}
            onClick={() =>
              updateGraph((g) => makeWaypointAgain(g, node.id), { label: 'make waypoint' })
            }
          >
            Waypoint
          </TypeChip>
          <TypeChip
            active={node.type === 'port'}
            disabled={!endpoint}
            onClick={() =>
              updateGraph((g) => makePort(g, node.id, 'luer', PORT_PRESETS.luer.defaultBoreMm), {
                label: 'make port',
              })
            }
          >
            Port
          </TypeChip>
          <TypeChip
            active={node.type === 'chamber'}
            onClick={() =>
              updateGraph(
                (g) => makeChamber(g, node.id, chamberShape, chipParams, { multiple }),
                { label: 'make chamber' },
              )
            }
          >
            Chamber
          </TypeChip>
        </div>
      </Field>

      {node.type === 'port' ? <PortFields node={node} /> : null}
      {node.type === 'chamber' ? <ChamberFields node={node} /> : null}
    </Section>
  );
}

function TypeChip({
  children,
  active,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        'oc-pressable rounded-md border px-2.5 py-1 text-[12px] font-medium',
        'disabled:pointer-events-none disabled:opacity-35',
        active
          ? 'border-accent bg-accent-wash text-accent'
          : 'border-line text-ink-muted hover:border-line-strong hover:text-ink',
      )}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// port
// ---------------------------------------------------------------------------

function PortFields({ node }: { node: Extract<ChannelNode, { type: 'port' }> }) {
  const updateGraph = useProjectStore((s) => s.updateGraph);
  const preset = PORT_PRESETS[node.portType];
  const spec = (node.customSpec ?? {}) as Record<string, number | string>;

  const setSpecValue = (key: string, value: number) =>
    updateGraph(
      (g) => updateNode(g, node.id, { customSpec: { ...spec, [key]: value } } as Partial<ChannelNode>),
      { label: 'port dimension' },
    );

  const fitting = matchFitting(node.portType, node.diameterMm, spec);

  return (
    <>
      {/* Catalogue parts come first: a scientist ordering consumables thinks in
          part names and tubing sizes, not taper diameters. The geometry family
          and the individual dimensions stay right below, so nothing is hidden —
          the simple path is just the one you reach first. */}
      <Field
        label="Catalogue fitting"
        hint="Cut for a part you can order. Every dimension stays editable afterwards."
      >
        <FittingPicker
          selected={fitting}
          onSelect={(entry) =>
            updateGraph((g) => applyFitting(g, node.id, entry), { label: 'port fitting' })
          }
        />
      </Field>

      {fitting ? (
        <div className="rounded-lg border border-line bg-sunken px-3 py-2">
          <p className="text-[11px] leading-relaxed text-ink">
            <span className="font-medium">Accepts: </span>
            {fitting.accepts}
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">{fitting.fits}</p>
        </div>
      ) : null}

      <Field label="Port type" hint={preset.blurb}>
        <div className="flex flex-wrap gap-1.5">
          {PORT_TYPES.map((type) => (
            <TypeChip
              key={type}
              active={node.portType === type}
              onClick={() =>
                updateGraph(
                  (g) => makePort(g, node.id, type as PortType, PORT_PRESETS[type].defaultBoreMm),
                  { label: 'port type' },
                )
              }
            >
              {PORT_PRESETS[type].label}
            </TypeChip>
          ))}
        </div>
      </Field>

      <Field label="Bore diameter" htmlFor="port-bore" hint="The through-hole into the channel.">
        <NumberInput
          id="port-bore"
          value={node.diameterMm}
          onChange={(diameterMm) =>
            updateGraph((g) => updateNode(g, node.id, { diameterMm } as Partial<ChannelNode>), {
              label: 'port bore',
            })
          }
          unit="mm"
          min={0.05}
          step={0.1}
          precision={3}
        />
      </Field>

      {preset.fields.map((field) => (
        <Field key={field.key} label={field.label} htmlFor={`port-${field.key}`} hint={field.hint}>
          <NumberInput
            id={`port-${field.key}`}
            value={typeof spec[field.key] === 'number' ? (spec[field.key] as number) : preset.defaults[field.key]}
            onChange={(value) => setSpecValue(field.key, value)}
            unit={field.unit}
            min={field.min}
            step={field.step}
            precision={3}
          />
        </Field>
      ))}

      {fitting?.caveat ?? preset.caveat ? (
        <p className="rounded-lg border border-line bg-sunken px-3 py-2 text-[11px] leading-relaxed text-ink-muted">
          {fitting?.caveat ?? preset.caveat}
        </p>
      ) : null}

      <p className="font-mono text-[11px] text-ink-quiet">
        footprint ⌀{portFootprintMm(node.portType, spec).toFixed(2)} mm
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------
// chamber
// ---------------------------------------------------------------------------

function ChamberFields({ node }: { node: Extract<ChannelNode, { type: 'chamber' }> }) {
  const updateGraph = useProjectStore((s) => s.updateGraph);
  const graph = useProjectStore((s) => s.project.channelGraph);
  const chipParams = useProjectStore((s) => s.project.chipParams);

  const localWidth = localChannelWidth(graph, node.id, chipParams);

  return (
    <>
      <Field label="Shape">
        <Segmented
          value={node.shape}
          onChange={(shape) =>
            updateGraph((g) => updateNode(g, node.id, { shape } as Partial<ChannelNode>), {
              label: 'chamber shape',
            })
          }
          options={[
            { value: 'sphere' as const, label: 'Sphere' },
            { value: 'cylinder' as const, label: 'Cylinder' },
          ]}
        />
      </Field>

      <Field
        label="Size"
        htmlFor="chamber-size"
        hint={`Local channel width here is ${localWidth.toFixed(3)} mm — this is ${(node.sizeMm / Math.max(1e-6, localWidth)).toFixed(1)}×.`}
      >
        <NumberInput
          id="chamber-size"
          value={node.sizeMm}
          onChange={(sizeMm) =>
            updateGraph((g) => updateNode(g, node.id, { sizeMm } as Partial<ChannelNode>), {
              label: 'chamber size',
            })
          }
          unit="mm"
          min={0.05}
          step={0.1}
          precision={3}
        />
      </Field>

      <div className="flex flex-wrap gap-1.5">
        {[2, 3, 4, 5].map((factor) => (
          <TypeChip
            key={factor}
            onClick={() =>
              updateGraph(
                (g) =>
                  updateNode(g, node.id, { sizeMm: localWidth * factor } as Partial<ChannelNode>),
                { label: 'chamber size' },
              )
            }
          >
            {factor}× width
          </TypeChip>
        ))}
      </div>

      {node.autoPlaced ? (
        <p className="text-[11px] leading-relaxed text-ink-muted">
          Placed automatically. Editing the size here makes it yours — re-running auto-placement
          will leave it alone.
        </p>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// multi-select
// ---------------------------------------------------------------------------

function MultiNodeEditor({ count }: { count: number }) {
  const updateGraph = useProjectStore((s) => s.updateGraph);
  const selection = useEditorStore((s) => s.selection);
  const clearSelection = useEditorStore((s) => s.clearSelection);

  return (
    <Section title={`${count} nodes`}>
      <Button
        size="sm"
        variant="danger"
        icon={<Trash2 size={14} />}
        onClick={() => {
          updateGraph((g) => deleteElements(g, selection.nodeIds, selection.edgeIds), {
            label: 'delete selection',
          });
          clearSelection();
        }}
      >
        Delete selection
      </Button>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// edge
// ---------------------------------------------------------------------------

function EdgeEditor({ edgeIds }: { edgeIds: string[] }) {
  const graph = useProjectStore((s) => s.project.channelGraph);
  const chipParams = useProjectStore((s) => s.project.chipParams);
  const updateGraph = useProjectStore((s) => s.updateGraph);

  const edges = graph.edges.filter((e) => edgeIds.includes(e.id));
  if (edges.length === 0) return null;

  const first = edges[0];
  const uniformCurve = edges.every((e) => e.curveType === first.curveType);
  const uniformSection = edges.every((e) => e.crossSection === first.crossSection);

  return (
    <Section
      title={edges.length === 1 ? 'Segment' : `${edges.length} segments`}
      action={<SelectAllChannelsButton />}
    >
      {/* Per-segment, not global: each segment keeps its own curve type. */}
      <Field label="Curve" hint="Applies to the selected segments only.">
        <Segmented
          value={uniformCurve ? first.curveType : 'straight'}
          onChange={(curveType) =>
            updateGraph(
              (g) => edges.reduce((acc, edge) => setCurveType(acc, edge.id, curveType), g),
              { label: 'curve type' },
            )
          }
          options={[
            { value: 'straight' as const, label: 'Straight' },
            { value: 'bezier' as const, label: 'Bezier' },
          ]}
        />
      </Field>

      {uniformCurve && first.curveType === 'bezier' ? (
        <p className="text-[11px] leading-relaxed text-ink-muted">
          Drag the round handles on the canvas to shape the curve.
        </p>
      ) : null}

      <Field label="Cross-section">
        <div className="flex flex-wrap gap-1.5">
          {(['round', 'rect', 'trapezoid'] as CrossSection[]).map((section) => (
            <TypeChip
              key={section}
              active={uniformSection && first.crossSection === section}
              onClick={() =>
                updateGraph((g) => setCrossSection(g, edgeIds, section), {
                  label: 'cross-section',
                })
              }
            >
              {section}
            </TypeChip>
          ))}
        </div>
      </Field>

      {edges.length === 1 ? (
        <>
          <EndSizes edgeId={first.id} crossSection={first.crossSection} />
          <DimensionMarkers edgeId={first.id} crossSection={first.crossSection} />
        </>
      ) : (
        <SharedSize edgeIds={edges.map((e) => e.id)} />
      )}

      <p className="font-mono text-[11px] text-ink-quiet">
        default {chipParams.defaultChannelWidthMm} × {chipParams.defaultChannelHeightMm} mm
      </p>
    </Section>
  );
}

function SelectAllChannelsButton() {
  const selectAllChannels = useSelectAllChannels();
  if (!selectAllChannels) return null;
  return (
    <button
      type="button"
      onClick={selectAllChannels}
      className="oc-pressable rounded px-1.5 py-0.5 text-[11px] font-medium text-accent hover:bg-sunken"
    >
      Select all channels
    </button>
  );
}

/** Two sizes this close are the same channel, not a difference worth a note. */
const SAME_SIZE_MM = 1e-4;

/**
 * One size for several segments at once.
 *
 * Typing a width gives every selected segment that width along its whole
 * length, so when they differ now, the field shows "Mixed" rather than one of
 * their widths, and a note says plainly that the differences will go.
 */
function SharedSize({ edgeIds }: { edgeIds: string[] }) {
  const graph = useProjectStore((s) => s.project.channelGraph);
  const chipParams = useProjectStore((s) => s.project.chipParams);
  const updateGraph = useProjectStore((s) => s.updateGraph);

  const edges = graph.edges.filter((e) => edgeIds.includes(e.id));
  const boxed = useMemo(
    () =>
      graph.edges
        .filter((e) => edgeIds.includes(e.id) && e.crossSection !== 'round')
        .map((e) => e.id),
    [graph.edges, edgeIds],
  );
  const allRound = boxed.length === 0;

  const range = useMemo(
    () => segmentSizeRange(graph, edgeIds, chipParams),
    [graph, edgeIds, chipParams],
  );
  // Round segments carry no height of their own, so only the others count.
  const heightRange = useMemo(
    () => (boxed.length > 0 ? segmentSizeRange(graph, boxed, chipParams) : null),
    [graph, boxed, chipParams],
  );
  if (!range) return null;

  const mixedWidth = range.widthMm.max - range.widthMm.min > SAME_SIZE_MM;
  const mixedHeight =
    heightRange !== null && heightRange.heightMm.max - heightRange.heightMm.min > SAME_SIZE_MM;

  const set = (size: { widthMm?: number; heightMm?: number }) =>
    updateGraph((g) => setSegmentsSize(g, edgeIds, size, chipParams), {
      label: 'channel size',
    });

  const widthLabel = allRound ? 'diameter' : 'width';

  return (
    <>
      <Field
        label={allRound ? 'Channel diameter' : 'Channel size'}
        hint={`Gives all ${edges.length} selected segments this ${widthLabel} along their whole length.`}
      >
        <div className="grid grid-cols-2 gap-2">
          <NumberInput
            value={range.widthMm.min}
            mixed={mixedWidth}
            onChange={(widthMm) => set({ widthMm })}
            unit="mm"
            min={0.01}
            step={0.05}
            precision={3}
            aria-label={allRound ? 'Diameter of every selected segment' : 'Width of every selected segment'}
          />
          {heightRange ? (
            <NumberInput
              value={heightRange.heightMm.min}
              mixed={mixedHeight}
              onChange={(heightMm) => set({ heightMm })}
              unit="mm"
              min={0.01}
              step={0.05}
              precision={3}
              aria-label="Height of every selected segment"
            />
          ) : null}
        </div>
      </Field>

      {mixedWidth || mixedHeight ? (
        <p className="rounded-lg border border-line bg-sunken px-3 py-2 text-[11px] leading-relaxed text-ink-muted">
          These segments are not all the same {mixedWidth ? widthLabel : 'height'} right now
          {mixedWidth
            ? ` — they run from ${range.widthMm.min.toFixed(2)} to ${range.widthMm.max.toFixed(2)} mm`
            : ''}
          . If you set a size here, every one of them becomes that size along its whole length,
          and any tapers between them are removed. <Kbd>{MOD}</Kbd> <Kbd>Z</Kbd> puts them back.
        </p>
      ) : null}

      {heightRange && !allRound && boxed.length < edges.length ? (
        <p className="text-[11px] leading-relaxed text-ink-muted">
          The height applies to the rectangular and trapezoidal segments; round ones are as tall
          as they are wide.
        </p>
      ) : null}
    </>
  );
}

/**
 * Channel size at each end of the segment.
 *
 * A taper is two markers with different widths, and until now the only way to
 * get one was to switch to the Dimension tool and click the channel twice —
 * the inspector could edit markers but never create them, so "make this
 * segment taper" had no direct control anywhere.
 *
 * Each field pins its own end and nothing else. Setting one end alone holds
 * the whole run at that width, because `sizeAtDistance` deliberately does not
 * extrapolate past the outermost marker; set both and the segment tapers
 * between them. Leaving an end unpinned is what lets a taper run across a
 * whole chain from a marker on some other segment, so these do not quietly
 * pin both ends on the user's behalf.
 */
function EndSizes({ edgeId, crossSection }: { edgeId: string; crossSection: CrossSection }) {
  const graph = useProjectStore((s) => s.project.channelGraph);
  const chipParams = useProjectStore((s) => s.project.chipParams);
  const updateGraph = useProjectStore((s) => s.updateGraph);

  const loft = useMemo(() => getLoft(graph, chipParams), [graph, chipParams]);
  const edge = graph.edges.find((e) => e.id === edgeId);
  if (!edge) return null;

  const fallback = {
    widthMm: chipParams.defaultChannelWidthMm,
    heightMm: chipParams.defaultChannelHeightMm,
  };

  const pin = (end: EdgeEnd, next: { widthMm?: number; heightMm?: number }) =>
    updateGraph(
      (g) => {
        const target = g.edges.find((e) => e.id === edgeId);
        if (!target) return g;

        // Seed from what is resolved there now, so pinning the width does not
        // silently drop a height the chain was already carrying.
        const current = sizeAtEdgeEnd(loft, edgeId, end, fallback);
        return updateEdge(g, edgeId, {
          dimensionPoints: upsertDimensionPoint(target.dimensionPoints, {
            t: END_T[end],
            widthMm: next.widthMm ?? current.widthMm,
            ...(target.crossSection === 'round'
              ? {}
              : { heightMm: next.heightMm ?? current.heightMm }),
          }),
        });
      },
      { label: 'channel size' },
    );

  const unpin = (end: EdgeEnd) =>
    updateGraph(
      (g) => {
        const target = g.edges.find((e) => e.id === edgeId);
        if (!target) return g;
        const marker = markerAtEdgeEnd(target.dimensionPoints, end);
        if (!marker) return g;
        return updateEdge(g, edgeId, {
          dimensionPoints: target.dimensionPoints.filter((p) => p !== marker),
        });
      },
      { label: 'clear channel size' },
    );

  return (
    <Field
      label="Channel size"
      hint="Set both ends to different widths to taper the segment along its length."
    >
      <div className="flex flex-col gap-2">
        {(['start', 'end'] as EdgeEnd[]).map((end) => {
          const size = sizeAtEdgeEnd(loft, edgeId, end, fallback);
          const pinned = markerAtEdgeEnd(edge.dimensionPoints, end) !== undefined;

          return (
            <div key={end} className="flex items-center gap-2">
              <span className="w-10 shrink-0 text-[11px] text-ink-muted capitalize">{end}</span>

              <div className="grid min-w-0 flex-1 grid-cols-2 gap-2">
                <NumberInput
                  value={size.widthMm}
                  onChange={(widthMm) => pin(end, { widthMm })}
                  unit="mm"
                  min={0.01}
                  step={0.05}
                  precision={3}
                  aria-label={`Width at ${end}`}
                />
                {crossSection !== 'round' ? (
                  <NumberInput
                    value={size.heightMm}
                    onChange={(heightMm) => pin(end, { heightMm })}
                    unit="mm"
                    min={0.01}
                    step={0.05}
                    precision={3}
                    aria-label={`Height at ${end}`}
                  />
                ) : null}
              </div>

              <button
                type="button"
                disabled={!pinned}
                onClick={() => unpin(end)}
                title={
                  pinned
                    ? `Unpin the ${end} — the size here goes back to following the rest of the path`
                    : `Not pinned — this size is inherited from the rest of the path`
                }
                aria-label={pinned ? `Unpin the ${end}` : `The ${end} is not pinned`}
                className={cn(
                  'oc-pressable shrink-0 rounded p-1 transition-colors',
                  pinned
                    ? 'text-accent hover:text-danger'
                    : 'cursor-default text-ink-faint opacity-40',
                )}
              >
                <Pin size={12} />
              </button>
            </div>
          );
        })}
      </div>
    </Field>
  );
}

function DimensionMarkers({
  edgeId,
  crossSection,
}: {
  edgeId: string;
  crossSection: CrossSection;
}) {
  const graph = useProjectStore((s) => s.project.channelGraph);
  const updateGraph = useProjectStore((s) => s.updateGraph);
  const edge = graph.edges.find((e) => e.id === edgeId);
  if (!edge) return null;

  if (edge.dimensionPoints.length === 0) {
    return (
      <p className="text-[11px] leading-relaxed text-ink-muted">
        No dimension markers. This segment uses the project default width. Switch to the Dimension
        tool and click the channel to add one.
      </p>
    );
  }

  const patch = (index: number, next: Partial<(typeof edge.dimensionPoints)[number]>) =>
    updateGraph(
      (g) => {
        const target = g.edges.find((e) => e.id === edgeId);
        if (!target) return g;
        const points = target.dimensionPoints.map((dp, i) => (i === index ? { ...dp, ...next } : dp));
        return updateEdge(g, edgeId, { dimensionPoints: points });
      },
      { label: 'dimension' },
    );

  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-[11px] font-medium text-ink">Dimension markers</p>

      {edge.dimensionPoints.map((dp, index) => (
        <div key={`${dp.t}-${index}`} className="rounded-lg border border-line bg-sunken p-2.5">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-mono text-[11px] text-ink-muted">
              at {(dp.t * 100).toFixed(0)}%
            </span>
            <button
              type="button"
              title="Remove this marker"
              onClick={() =>
                updateGraph(
                  (g) =>
                    updateEdge(g, edgeId, {
                      dimensionPoints: edge.dimensionPoints.filter((_, i) => i !== index),
                    }),
                  { label: 'remove dimension' },
                )
              }
              className="oc-pressable rounded p-0.5 text-ink-faint hover:text-danger"
            >
              <Trash2 size={12} />
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <NumberInput
              value={dp.widthMm}
              onChange={(widthMm) => patch(index, { widthMm })}
              unit="mm"
              min={0.01}
              step={0.05}
              precision={3}
              aria-label="Width"
            />
            {crossSection !== 'round' ? (
              <NumberInput
                value={dp.heightMm ?? 0.5}
                onChange={(heightMm) => patch(index, { heightMm })}
                unit="mm"
                min={0.01}
                step={0.05}
                precision={3}
                aria-label="Height"
              />
            ) : null}
          </div>

          <NumberInput
            className="mt-2"
            value={dp.t}
            onChange={(t) => patch(index, { t: Math.min(1, Math.max(0, t)) })}
            min={0}
            max={1}
            step={0.01}
            precision={3}
            aria-label="Position along segment"
          />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// warnings
// ---------------------------------------------------------------------------

function WarningsSection() {
  const graph = useProjectStore((s) => s.project.channelGraph);
  const chipParams = useProjectStore((s) => s.project.chipParams);
  const selectNodes = useEditorStore((s) => s.selectNodes);
  const setFocusNodeId = useEditorStore((s) => s.setFocusNodeId);

  const warnings = useMemo(
    () =>
      findEdgeSpacingWarnings(graph, chipParams, (node) => nodeFootprintMm(node, chipParams)),
    [graph, chipParams],
  );

  if (warnings.length === 0) return null;

  return (
    <Section title={`Edge spacing · ${warnings.length}`}>
      {/* Never blocking: OpenChip warns, it does not gate. Clicking one just
          selects the offending node so the user can decide. */}
      <p className="text-[11px] leading-relaxed text-ink-muted">
        These sit closer than {chipParams.minEdgeSpacing} mm to the chip boundary. Nothing is
        blocked — adjust the layout or the chip size if it matters.
      </p>

      {warnings.slice(0, 12).map((warning) => (
        <button
          key={warning.nodeId}
          type="button"
          onClick={() => {
            selectNodes([warning.nodeId]);
            setFocusNodeId(warning.nodeId);
          }}
          className={cn(
            'oc-pressable flex items-start gap-2 rounded-lg border px-2.5 py-2 text-left',
            warning.outside
              ? 'border-danger/40 bg-danger-wash'
              : 'border-caution/40 bg-caution-wash',
          )}
        >
          <AlertTriangle
            size={13}
            className={cn('mt-0.5 shrink-0', warning.outside ? 'text-danger' : 'text-caution')}
          />
          <span className="font-mono text-[11px] leading-relaxed text-ink">
            {warning.outside
              ? `${Math.abs(warning.clearanceMm).toFixed(2)} mm outside the chip`
              : `${warning.clearanceMm.toFixed(2)} mm clearance`}
          </span>
        </button>
      ))}
    </Section>
  );
}

export { Section, TypeChip, Kbd };
