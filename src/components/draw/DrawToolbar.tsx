import {
  Grid3x3,
  Magnet,
  MousePointer2,
  PenLine,
  Redo2,
  Ruler,
  Spline,
  Undo2,
  Waves,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { useEditorStore, type Tool } from '../../store/editorStore';
import { useProjectStore } from '../../store/projectStore';

const TOOLS: { id: Tool; label: string; hint: string; icon: typeof PenLine; key: string }[] = [
  { id: 'select', label: 'Select', hint: 'Select, move, marquee', icon: MousePointer2, key: 'V' },
  { id: 'draw', label: 'Draw', hint: 'Click to lay down channel segments', icon: PenLine, key: 'P' },
  {
    id: 'dimension',
    label: 'Dimension',
    hint: 'Click a channel to set its local width',
    icon: Ruler,
    key: 'D',
  },
];

export function DrawToolbar() {
  const tool = useEditorStore((s) => s.tool);
  const setTool = useEditorStore((s) => s.setTool);
  const snap = useEditorStore((s) => s.snap);
  const setSnap = useEditorStore((s) => s.setSnap);
  const showGrid = useEditorStore((s) => s.showGrid);
  const toggleGrid = useEditorStore((s) => s.toggleGrid);
  const showTaper = useEditorStore((s) => s.showTaper);
  const toggleTaper = useEditorStore((s) => s.toggleTaper);

  const undo = useProjectStore((s) => s.undo);
  const redo = useProjectStore((s) => s.redo);
  const undoDepth = useProjectStore((s) => s.undoDepth);
  const redoDepth = useProjectStore((s) => s.redoDepth);

  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-line bg-panel px-2 py-1.5">
      {/* tools */}
      <div data-tour="draw-tools" className="flex items-center gap-0.5">
        {TOOLS.map((item) => (
          <ToolButton
            key={item.id}
            tourId={item.id === 'dimension' ? 'dimension-tool' : undefined}
            active={tool === item.id}
            onClick={() => setTool(item.id)}
            title={`${item.label} · ${item.key} — ${item.hint}`}
          >
            <item.icon size={15} />
            <span className="hidden lg:inline">{item.label}</span>
          </ToolButton>
        ))}
      </div>

      <Divider />

      {/* history */}
      <ToolButton onClick={undo} disabled={undoDepth === 0} title="Undo · ⌘Z">
        <Undo2 size={15} />
      </ToolButton>
      <ToolButton onClick={redo} disabled={redoDepth === 0} title="Redo · ⇧⌘Z">
        <Redo2 size={15} />
      </ToolButton>

      <Divider />

      {/* snapping */}
      <ToolButton
        active={snap.endpointEnabled}
        onClick={() => setSnap({ endpointEnabled: !snap.endpointEnabled })}
        title="Snap to existing endpoints — this is what joins two paths together"
      >
        <Magnet size={15} />
        <span className="hidden xl:inline">Endpoint</span>
      </ToolButton>

      <ToolButton
        active={snap.gridEnabled}
        onClick={() => setSnap({ gridEnabled: !snap.gridEnabled })}
        title="Snap to the millimetre grid"
      >
        <Grid3x3 size={15} />
        <span className="hidden xl:inline">Grid</span>
      </ToolButton>

      <div className="flex items-center overflow-hidden rounded-md border border-line">
        <button
          type="button"
          onClick={() => setSnap({ angleEnabled: !snap.angleEnabled })}
          title="Constrain new segments to fixed angles"
          className={cn(
            'oc-pressable flex h-7 items-center gap-1.5 px-2 text-[12px] font-medium',
            snap.angleEnabled ? 'bg-accent-wash text-accent' : 'text-ink-muted hover:text-ink',
          )}
        >
          <Spline size={14} />
          <span className="hidden xl:inline">Angle</span>
        </button>
        <select
          value={snap.angleStepDeg}
          onChange={(event) => setSnap({ angleStepDeg: Number(event.target.value) })}
          disabled={!snap.angleEnabled}
          aria-label="Angle snap increment"
          className="h-7 border-l border-line bg-panel px-1 font-mono text-[11px] text-ink outline-none disabled:opacity-40"
        >
          <option value={15}>15°</option>
          <option value={45}>45°</option>
        </select>
      </div>

      <Divider />

      {/* display */}
      <ToolButton active={showGrid} onClick={toggleGrid} title="Show the grid">
        <Grid3x3 size={15} />
      </ToolButton>
      {/* Labelled "Taper" until it was reported as not tapering anything. It
          only ever drew each channel at its solved width; the taper itself is
          set per segment in the inspector. "Width" says what it does. */}
      <ToolButton
        active={showTaper}
        onClick={toggleTaper}
        title="Draw each channel at its real width, rather than as a centerline"
      >
        <Waves size={15} />
        <span className="hidden xl:inline">Width</span>
      </ToolButton>
    </div>
  );
}

function ToolButton({
  children,
  active,
  onClick,
  disabled,
  title,
  tourId,
}: {
  children: ReactNode;
  active?: boolean;
  onClick: () => void;
  disabled?: boolean;
  title: string;
  /** Anchors the guided tour's spotlight. */
  tourId?: string;
}) {
  return (
    <button
      type="button"
      data-tour={tourId}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={active}
      className={cn(
        'oc-pressable flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium',
        'disabled:pointer-events-none disabled:opacity-35',
        active ? 'bg-accent-wash text-accent' : 'text-ink-muted hover:bg-sunken hover:text-ink',
      )}
    >
      {children}
    </button>
  );
}

const Divider = () => <div className="mx-1 h-5 w-px shrink-0 bg-line" />;
