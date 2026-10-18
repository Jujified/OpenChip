import {
  Box,
  Circle,
  CircleDashed,
  Frame,
  Layers,
  Loader2,
  Scan,
  Spline,
  SquareDashed,
} from 'lucide-react';
import type { ReactNode, RefObject } from 'react';
import { cn } from '../../lib/cn';
import { useCadStore, type DisplayMode } from '../../store/cadStore';
import { useProjectStore } from '../../store/projectStore';
import type { CadViewportHandle } from './CadViewport';

const MODES: { id: DisplayMode; label: string; icon: typeof Box }[] = [
  { id: 'solid', label: 'Solid', icon: Box },
  { id: 'wireframe', label: 'Wireframe', icon: SquareDashed },
  { id: 'xray', label: 'X-ray', icon: Layers },
];

export function CadToolbar({ viewport }: { viewport: RefObject<CadViewportHandle | null> }) {
  const displayMode = useCadStore((s) => s.displayMode);
  const setDisplayMode = useCadStore((s) => s.setDisplayMode);
  const exploded = useCadStore((s) => s.exploded);
  const toggleExploded = useCadStore((s) => s.toggleExploded);
  const isolateChannels = useCadStore((s) => s.isolateChannels);
  const toggleIsolateChannels = useCadStore((s) => s.toggleIsolateChannels);
  const channelsOpaque = useCadStore((s) => s.channelsOpaque);
  const setChannelsOpaque = useCadStore((s) => s.setChannelsOpaque);
  const building = useCadStore((s) => s.building);
  const model = useCadStore((s) => s.model);
  const projection = useCadStore((s) => s.projection);
  const splitType = useProjectStore((s) => s.project.chipParams.splitType);

  const twoPiece = splitType === 'two-piece';
  // Isolate belongs to X-ray — it is the same question (what is inside the
  // block?) taken to its end — so the controls appear with it and not before.
  const xray = displayMode === 'xray';

  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-line bg-panel px-2 py-1.5">
      <div className="flex items-center gap-0.5">
        {MODES.map((mode) => (
          <ToolButton
            key={mode.id}
            active={displayMode === mode.id}
            onClick={() => setDisplayMode(mode.id)}
            title={
              mode.id === 'xray'
                ? 'X-ray — see the channels through the block'
                : `${mode.label} view`
            }
          >
            <mode.icon size={15} />
            <span className="hidden lg:inline">{mode.label}</span>
          </ToolButton>
        ))}
      </div>

      {xray && (
        <>
          <div className="mx-1 h-5 w-px bg-line" />

          <ToolButton
            active={isolateChannels}
            onClick={toggleIsolateChannels}
            title="Isolate the channels — hide the block and show the fluid path on its own"
          >
            <Spline size={15} />
            <span className="hidden lg:inline">Isolate</span>
          </ToolButton>

          {isolateChannels && (
            <div className="flex items-center gap-0.5">
              <ToolButton
                active={channelsOpaque}
                onClick={() => setChannelsOpaque(true)}
                title="Draw the channels solid"
              >
                <Circle size={15} />
                <span className="hidden xl:inline">Opaque</span>
              </ToolButton>
              <ToolButton
                active={!channelsOpaque}
                onClick={() => setChannelsOpaque(false)}
                title="Draw the channels see-through, so crossing runs show through each other"
              >
                <CircleDashed size={15} />
                <span className="hidden xl:inline">Transparent</span>
              </ToolButton>
            </div>
          )}
        </>
      )}

      <div className="mx-1 h-5 w-px bg-line" />

      <ToolButton
        active={exploded}
        disabled={!twoPiece}
        onClick={toggleExploded}
        title={
          twoPiece
            ? 'Separate the two halves to inspect the bonding faces'
            : 'A monolithic chip has nothing to separate'
        }
      >
        <Scan size={15} />
        <span className="hidden lg:inline">Explode</span>
      </ToolButton>

      <ToolButton onClick={() => viewport.current?.frameAll()} title="Fit the chip in view">
        <Frame size={15} />
        <span className="hidden xl:inline">Fit</span>
      </ToolButton>

      <div className="mx-1 h-5 w-px bg-line" />

      <div className="flex items-center gap-0.5">
        <ToolButton
          onClick={() => viewport.current?.snapToAxis('top')}
          title="Top view — orthographic, looking straight down"
        >
          Top
        </ToolButton>
        <ToolButton
          onClick={() => viewport.current?.snapToAxis('front')}
          title="Front view — orthographic, looking along the chip's length"
        >
          Front
        </ToolButton>
        <ToolButton
          onClick={() => viewport.current?.snapToAxis('right')}
          title="Right view — orthographic, looking along the chip's width"
        >
          Right
        </ToolButton>
      </div>

      <ToolButton
        active={projection === 'orthographic'}
        onClick={() => viewport.current?.toggleProjection()}
        title={
          projection === 'orthographic'
            ? 'Orthographic — click for perspective'
            : 'Perspective — click for orthographic, no depth distortion'
        }
      >
        {projection === 'orthographic' ? 'Ortho' : 'Persp'}
      </ToolButton>

      <div className="ml-auto flex items-center gap-2 pr-1">
        {building ? (
          <span className="flex items-center gap-1.5 font-mono text-[11px] text-ink-muted">
            <Loader2 size={12} className="animate-spin" />
            rebuilding
          </span>
        ) : model ? (
          <span className="font-mono text-[11px] text-ink-quiet">
            {model.pieces.map((p) => p.label).join(' + ')}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function ToolButton({
  children,
  active,
  disabled,
  onClick,
  title,
}: {
  children: ReactNode;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
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
