import { Copy, FileImage, Grid2x2Plus, MoveHorizontal, Repeat, SquareDot } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  addChambersAtCorners,
  buildArrayRepeat,
  applyArrayRepeat,
  centerInChip,
  centerOffsetMm,
  detectCorners,
  distributeEvenly,
  extractFragment,
  fragmentEndpoints,
  pasteFragment,
  spaceByIncrement,
  type SpacingAxis,
} from '../../lib/graphOps';
import { schematicSavedImage } from '../../lib/svgExport';
import { edgesWithinNodes } from '../../lib/hitTest';
import { useEditorStore } from '../../store/editorStore';
import { useProjectStore } from '../../store/projectStore';
import { Button } from '../ui/Button';
import { Field, NumberInput, Segmented } from '../ui/Field';
import { Section } from './InspectorPanel';

export function DrawTools() {
  return (
    <>
      <CenterInChip />
      <AutoChambers />
      <CopyAndArray />
      <EvenSpacing />
      <ExportSchematic />
    </>
  );
}

// ---------------------------------------------------------------------------
// centering
// ---------------------------------------------------------------------------

/**
 * Puts the design back in the middle of the chip.
 *
 * Changing the chip's width or length leaves the channels where they were,
 * which is right — geometry should not move because a number in another panel
 * moved — but it does mean a resized chip needs a way back to the centered look
 * every library template ships with. This is it.
 */
function CenterInChip() {
  const graph = useProjectStore((s) => s.project.channelGraph);
  const chipParams = useProjectStore((s) => s.project.chipParams);
  const updateGraph = useProjectStore((s) => s.updateGraph);
  const selection = useEditorStore((s) => s.selection);

  // A marquee centers what it caught. With nothing selected the button still
  // works and centers everything, which is what someone who has just resized
  // the chip is after.
  const scoped = selection.nodeIds.length > 0;
  const nodeIds = useMemo(
    () => (scoped ? selection.nodeIds : undefined),
    [scoped, selection.nodeIds],
  );

  const deltaMm = useMemo(
    () => centerOffsetMm(graph, chipParams, nodeIds),
    [graph, chipParams, nodeIds],
  );

  const offset = { x: Math.abs(deltaMm.x), y: Math.abs(deltaMm.y) };
  const centered = offset.x === 0 && offset.y === 0;
  const empty = graph.nodes.length === 0;
  const subject = scoped ? 'selection' : 'design';
  const round = (mm: number) => Number(mm.toFixed(2));

  return (
    <Section title="Position">
      <Button
        size="sm"
        icon={<SquareDot size={14} />}
        disabled={empty || centered}
        onClick={() => {
          updateGraph((g) => centerInChip(g, chipParams, nodeIds).graph, {
            label: `center ${subject}`,
          });
          toast.success(scoped ? 'Selection centered' : 'Design centered', {
            description: `Moved ${round(offset.x)} mm in X and ${round(offset.y)} mm in Y.`,
          });
        }}
      >
        {scoped ? 'Center selection' : 'Center design'}
      </Button>

      <p className="text-[11px] leading-relaxed text-ink-muted">
        {empty
          ? 'Nothing drawn yet.'
          : centered
            ? `The ${subject} is already centered on the ${chipParams.width} × ${chipParams.length} mm chip.`
            : `Off by ${round(offset.x)} mm in X and ${round(offset.y)} mm in Y. Ports and chambers are measured at their full width, so the margins come out even.`}
      </p>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// auto chambers
// ---------------------------------------------------------------------------

function AutoChambers() {
  const graph = useProjectStore((s) => s.project.channelGraph);
  const chipParams = useProjectStore((s) => s.project.chipParams);
  const updateGraph = useProjectStore((s) => s.updateGraph);

  const threshold = useEditorStore((s) => s.cornerThresholdDeg);
  const setThreshold = useEditorStore((s) => s.setCornerThresholdDeg);
  const shape = useEditorStore((s) => s.chamberShape);
  const setShape = useEditorStore((s) => s.setChamberShape);
  const multiple = useEditorStore((s) => s.chamberWidthMultiple);
  const setMultiple = useEditorStore((s) => s.setChamberWidthMultiple);

  // Live count, so the threshold slider shows its effect before committing.
  const corners = useMemo(() => detectCorners(graph, threshold), [graph, threshold]);

  return (
    <Section title="Mixing chambers">
      <Field label="Shape for new chambers">
        <Segmented
          value={shape}
          onChange={setShape}
          options={[
            { value: 'sphere' as const, label: 'Sphere' },
            { value: 'cylinder' as const, label: 'Cylinder' },
          ]}
        />
      </Field>

      <Field
        label="Corner threshold"
        htmlFor="corner-threshold"
        hint="A node counts as a turn when the path bends more than this. 180° is dead straight."
      >
        <NumberInput
          id="corner-threshold"
          value={threshold}
          onChange={setThreshold}
          unit="°"
          min={1}
          max={179}
          step={5}
          precision={0}
        />
      </Field>

      <Field
        label="Size"
        htmlFor="chamber-multiple"
        hint="Multiple of the local channel width. Each chamber stays editable afterwards."
      >
        <NumberInput
          id="chamber-multiple"
          value={multiple}
          onChange={setMultiple}
          unit="×"
          min={1}
          max={20}
          step={0.5}
          precision={1}
        />
      </Field>

      <Button
        size="sm"
        icon={<Grid2x2Plus size={14} />}
        disabled={corners.length === 0}
        onClick={() => {
          const result = addChambersAtCorners(graph, chipParams, {
            cornerThresholdDeg: threshold,
            shape,
            multiple,
          });
          if (result.added.length === 0) {
            toast('No new corners found', {
              description: 'Every detected turn already has a chamber.',
            });
            return;
          }
          updateGraph(() => result.graph, { label: 'add chambers at corners' });
          toast.success(
            `Added ${result.added.length} chamber${result.added.length === 1 ? '' : 's'}`,
          );
        }}
      >
        Add chambers at all corners
        {corners.length > 0 ? ` (${corners.length})` : ''}
      </Button>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// copy / paste / array
// ---------------------------------------------------------------------------

function CopyAndArray() {
  const graph = useProjectStore((s) => s.project.channelGraph);
  const chipParams = useProjectStore((s) => s.project.chipParams);
  const updateGraph = useProjectStore((s) => s.updateGraph);

  const selection = useEditorStore((s) => s.selection);
  const setSelection = useEditorStore((s) => s.setSelection);
  const clipboard = useEditorStore((s) => s.clipboard);
  const setClipboard = useEditorStore((s) => s.setClipboard);
  const pasteCount = useEditorStore((s) => s.pasteCount);
  const bumpPaste = useEditorStore((s) => s.bumpPaste);

  // Shared with the canvas, which draws the ghost preview from these.
  const { count, spacingMm: spacing, alternate } = useEditorStore((s) => s.array);
  const setArray = useEditorStore((s) => s.setArray);

  const fragment = useMemo(
    () => (selection.nodeIds.length > 0 ? extractFragment(graph, selection.nodeIds) : null),
    [graph, selection.nodeIds],
  );

  const chainable = fragment ? fragmentEndpoints(fragment) !== null : false;

  const preview = useMemo(() => {
    if (!fragment || !chainable) return null;
    return buildArrayRepeat(fragment, { count, spacingMm: spacing, alternate }, chipParams);
  }, [fragment, chainable, count, spacing, alternate, chipParams]);

  return (
    <Section title="Copy & repeat">
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          icon={<Copy size={14} />}
          disabled={!fragment || fragment.nodes.length === 0}
          onClick={() => {
            if (!fragment) return;
            setClipboard(fragment);
            toast.success(`Copied ${fragment.nodes.length} nodes`);
          }}
        >
          Copy
        </Button>

        <Button
          size="sm"
          disabled={!clipboard}
          onClick={() => {
            if (!clipboard) return;
            // Cascade successive pastes so they do not stack invisibly.
            const step = 2 * (pasteCount + 1);
            const result = pasteFragment(graph, clipboard, { x: step, y: -step });
            updateGraph(() => result.graph, { label: 'paste' });
            bumpPaste();
            setSelection({
              nodeIds: result.nodeIds,
              edgeIds: edgesWithinNodes(result.graph, result.nodeIds),
            });
          }}
        >
          Paste
        </Button>
      </div>

      {!fragment || fragment.nodes.length === 0 ? (
        <p className="text-[11px] leading-relaxed text-ink-muted">
          Select nodes on the canvas to copy them, or to repeat a sub-path end to end.
        </p>
      ) : null}

      {fragment && fragment.nodes.length > 0 && !chainable ? (
        <p className="text-[11px] leading-relaxed text-ink-muted">
          Repeat needs a single unbranched run with two ends. This selection branches or closes on
          itself, so only plain copy/paste applies.
        </p>
      ) : null}

      {chainable ? (
        <>
          <div className="grid grid-cols-2 gap-2.5">
            <Field label="Extra copies" htmlFor="array-count">
              <NumberInput
                id="array-count"
                value={count}
                onChange={(value) => setArray({ count: Math.round(value) })}
                min={1}
                max={64}
                step={1}
                precision={0}
              />
            </Field>
            <Field label="Gap" htmlFor="array-spacing" hint="0 chains them directly.">
              <NumberInput
                id="array-spacing"
                value={spacing}
                onChange={(spacingMm) => setArray({ spacingMm })}
                unit="mm"
                min={0}
                step={0.5}
                precision={2}
              />
            </Field>
          </div>

          <label className="flex items-center gap-2 text-[12px] text-ink">
            <input
              type="checkbox"
              checked={alternate}
              onChange={(event) => setArray({ alternate: event.target.checked })}
              className="h-3.5 w-3.5 accent-[var(--accent)]"
            />
            Mirror alternate copies
            <span className="text-ink-quiet">(makes a serpentine)</span>
          </label>

          <Button
            size="sm"
            variant="primary"
            icon={<Repeat size={14} />}
            disabled={!preview}
            onClick={() => {
              if (!preview) return;
              const result = applyArrayRepeat(graph, preview);
              updateGraph(() => result.graph, { label: 'array repeat' });

              // Include the anchor the first copy welded onto. Without it the
              // selection is a run missing its own start, so the repeat ghost
              // re-derives a nonsensical diagonal chord from what is left.
              const selected = [...new Set([preview.anchorNodeId, ...result.nodeIds])];
              setSelection({
                nodeIds: selected,
                edgeIds: edgesWithinNodes(result.graph, selected),
              });
              toast.success(`Appended ${count} more`);
            }}
          >
            Append {count} more
          </Button>

          {preview ? (
            <p className="font-mono text-[11px] text-ink-quiet">
              preview: +{preview.nodes.length} nodes, +{preview.edges.length} segments
            </p>
          ) : null}
        </>
      ) : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// even spacing
// ---------------------------------------------------------------------------

function EvenSpacing() {
  const updateGraph = useProjectStore((s) => s.updateGraph);
  const selection = useEditorStore((s) => s.selection);

  const [mode, setMode] = useState<'distribute' | 'increment'>('distribute');
  const [increment, setIncrement] = useState(5);
  const [axis, setAxis] = useState<SpacingAxis>('auto');
  const [anchor, setAnchor] = useState<'first' | 'last'>('first');

  const selected = selection.nodeIds.length;
  const canDistribute = selected >= 3;
  const canIncrement = selected >= 2;

  return (
    <Section title="Spacing">
      <Segmented
        value={mode}
        onChange={setMode}
        options={[
          { value: 'distribute' as const, label: 'Distribute' },
          { value: 'increment' as const, label: 'Fixed' },
        ]}
      />

      <Field label="Axis" hint="Auto picks whichever direction the selection spans furthest.">
        <Segmented
          value={axis}
          onChange={setAxis}
          options={[
            { value: 'auto' as SpacingAxis, label: 'Auto' },
            { value: 'x' as SpacingAxis, label: 'X' },
            { value: 'y' as SpacingAxis, label: 'Y' },
          ]}
        />
      </Field>

      {mode === 'increment' ? (
        <>
          <Field label="Spacing" htmlFor="spacing-increment">
            <NumberInput
              id="spacing-increment"
              value={increment}
              onChange={setIncrement}
              unit="mm"
              min={0.01}
              step={0.5}
              precision={3}
            />
          </Field>
          <Field label="Anchor" hint="The item that stays put.">
            <Segmented
              value={anchor}
              onChange={setAnchor}
              options={[
                { value: 'first' as const, label: 'First' },
                { value: 'last' as const, label: 'Last' },
              ]}
            />
          </Field>
        </>
      ) : null}

      <Button
        size="sm"
        icon={<MoveHorizontal size={14} />}
        disabled={mode === 'distribute' ? !canDistribute : !canIncrement}
        onClick={() => {
          updateGraph(
            (g) =>
              mode === 'distribute'
                ? distributeEvenly(g, selection.nodeIds, axis)
                : spaceByIncrement(g, selection.nodeIds, increment, axis, anchor),
            { label: 'space evenly' },
          );
          toast.success(mode === 'distribute' ? 'Distributed evenly' : `Spaced at ${increment} mm`);
        }}
      >
        {mode === 'distribute' ? 'Distribute evenly' : `Space at ${increment} mm`}
      </Button>

      <p className="text-[11px] leading-relaxed text-ink-muted">
        {mode === 'distribute'
          ? `Select 3 or more nodes — the outermost two stay put. ${selected} selected.`
          : `Select 2 or more nodes. ${selected} selected.`}
      </p>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// SVG export
// ---------------------------------------------------------------------------

function ExportSchematic() {
  const graph = useProjectStore((s) => s.project.channelGraph);
  const chipParams = useProjectStore((s) => s.project.chipParams);
  const projectName = useProjectStore((s) => s.project.meta.name);
  const savedImages = useProjectStore((s) => s.project.savedImages);
  const addSavedImage = useProjectStore((s) => s.addSavedImage);

  const schematics = savedImages.filter((image) => image.kind === 'schematic-svg');

  return (
    <Section title="Schematic">
      <Button
        size="sm"
        icon={<FileImage size={14} />}
        disabled={graph.edges.length === 0}
        onClick={() => {
          const label = `${projectName} — schematic ${schematics.length + 1}`;
          addSavedImage(schematicSavedImage(graph, chipParams, label));
          toast.success('Schematic saved to the project', {
            description: 'Saved images travel inside the .openchip file.',
          });
        }}
      >
        Export current view as SVG
      </Button>

      {schematics.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {schematics.slice(-4).map((image) => (
            <SavedImageRow key={image.id} id={image.id} label={image.label} data={image.data} />
          ))}
          {schematics.length > 4 ? (
            <p className="text-[11px] text-ink-quiet">
              …and {schematics.length - 4} more in the project.
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-[11px] leading-relaxed text-ink-muted">
          Exports the chip outline, channels with their taper, ports, chambers and dimension
          annotations — saved into the project rather than downloaded.
        </p>
      )}
    </Section>
  );
}

function SavedImageRow({ id, label, data }: { id: string; label: string; data: string }) {
  const removeSavedImage = useProjectStore((s) => s.removeSavedImage);

  return (
    <div className="flex items-center gap-2 rounded-lg border border-line bg-sunken px-2.5 py-2">
      <img src={data} alt="" className="h-8 w-8 shrink-0 rounded bg-white object-contain" />
      <span className="min-w-0 flex-1 truncate text-[11px] text-ink" title={label}>
        {label}
      </span>
      <a
        href={data}
        download={`${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.svg`}
        className="oc-pressable rounded px-1.5 py-0.5 text-[11px] text-accent hover:bg-accent-wash"
      >
        Save
      </a>
      <button
        type="button"
        onClick={() => removeSavedImage(id)}
        className="oc-pressable rounded px-1.5 py-0.5 text-[11px] text-ink-quiet hover:text-danger"
      >
        Remove
      </button>
    </div>
  );
}
