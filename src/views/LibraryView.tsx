import { ArrowRight, Info, LibraryBig, Search, Sparkles, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { PresetThumbnail } from '../components/library/PresetThumbnail';
import { Button } from '../components/ui/Button';
import { presetHelpUrl } from '../lib/wikiLinks';
import { Dialog } from '../components/ui/Dialog';
import { useProjectActions } from '../hooks/useProjectActions';
import { cn } from '../lib/cn';
import {
  CATEGORY_LABEL,
  CHIP_PRESETS,
  matchesQuery,
  presetBuild,
  presetStats,
  projectOptionsFromPreset,
  type ChipPreset,
  type PresetCategory,
} from '../lib/presets';
import { useProjectStore } from '../store/projectStore';
import { useUiStore } from '../store/uiStore';

const CATEGORIES: (PresetCategory | 'all')[] = ['all', 'mixing', 'gradient', 'droplet'];

export function LibraryView() {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<PresetCategory | 'all'>('all');
  const [inspecting, setInspecting] = useState<ChipPreset | null>(null);

  const results = useMemo(
    () =>
      CHIP_PRESETS.filter(
        (preset) =>
          (category === 'all' || preset.category === category) && matchesQuery(preset, query),
      ),
    [query, category],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <LibraryToolbar
        query={query}
        onQuery={setQuery}
        category={category}
        onCategory={setCategory}
        count={results.length}
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {results.length === 0 ? (
          <NoResults
            query={query}
            onClear={() => {
              setQuery('');
              setCategory('all');
            }}
          />
        ) : (
          <div className="mx-auto grid max-w-[76rem] grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] gap-4 p-5">
            {/* Not a template, so it steps aside while the user is searching or
                filtering the templates themselves. */}
            {category === 'all' && query.trim() === '' ? <DesignWithAiCard /> : null}
            {results.map((preset) => (
              <PresetCard key={preset.id} preset={preset} onInspect={() => setInspecting(preset)} />
            ))}
          </div>
        )}
      </div>

      <PresetDetail preset={inspecting} onClose={() => setInspecting(null)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// toolbar
// ---------------------------------------------------------------------------

function LibraryToolbar({
  query,
  onQuery,
  category,
  onCategory,
  count,
}: {
  query: string;
  onQuery: (value: string) => void;
  category: PresetCategory | 'all';
  onCategory: (value: PresetCategory | 'all') => void;
  count: number;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-2">
      <div className="relative">
        <Search
          size={14}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint"
        />
        <input
          type="search"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="Search templates…"
          aria-label="Search templates"
          className={cn(
            'h-8 w-56 rounded-lg border border-line bg-canvas pl-8 pr-3 text-[13px] text-ink',
            'placeholder:text-ink-faint focus:border-accent focus:outline-none',
            'transition-[border-color] duration-150',
          )}
        />
      </div>

      <div className="flex items-center gap-0.5 rounded-lg bg-sunken p-0.5">
        {CATEGORIES.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => onCategory(id)}
            aria-pressed={category === id}
            className={cn(
              'oc-pressable rounded-md px-2.5 py-1 text-[12px] font-medium',
              category === id ? 'bg-panel text-ink shadow-sm' : 'text-ink-muted hover:text-ink',
            )}
          >
            {id === 'all' ? 'All' : CATEGORY_LABEL[id]}
          </button>
        ))}
      </div>

      <p className="ml-auto pr-1 font-mono text-[11px] text-ink-quiet">
        {count} template{count === 1 ? '' : 's'}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// card
// ---------------------------------------------------------------------------

/** The starting point for someone who would rather describe a chip than pick one. */
function DesignWithAiCard() {
  const openDesignWithAi = useUiStore((s) => s.openDesignWithAi);
  return (
    <button
      type="button"
      onClick={openDesignWithAi}
      className={cn(
        'group flex flex-col overflow-hidden rounded-xl border border-line bg-panel text-left',
        'transition-[border-color,box-shadow,transform] duration-200 ease-[var(--ease-out)]',
        'hover:-translate-y-0.5 hover:border-line-strong hover:shadow-[var(--shadow-menu)]',
        'active:translate-y-0 active:duration-100',
      )}
    >
      <div className="flex h-40 items-center justify-center bg-accent-wash text-accent">
        <Sparkles size={34} strokeWidth={1.5} />
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-1.5 border-t border-line px-3.5 py-3">
        <h3 className="text-[13px] font-semibold tracking-tight text-ink">Describe a chip</h3>
        <p className="text-[12px] leading-relaxed text-ink-muted">
          Tell an AI assistant what the chip should do — “mix two dyes gently”, “four
          concentrations from two syringes” — and open what it designs.
        </p>
        <span className="mt-auto inline-flex items-center gap-1 pt-1.5 text-[12px] font-semibold text-accent">
          Design with AI <ArrowRight size={13} />
        </span>
      </div>
    </button>
  );
}

function PresetCard({ preset, onInspect }: { preset: ChipPreset; onInspect: () => void }) {
  const stats = useMemo(() => presetStats(preset, presetBuild(preset)), [preset]);

  return (
    <button
      type="button"
      onClick={onInspect}
      className={cn(
        'group flex flex-col overflow-hidden rounded-xl border border-line bg-panel text-left',
        'transition-[border-color,box-shadow,transform] duration-200 ease-[var(--ease-out)]',
        'hover:-translate-y-0.5 hover:border-line-strong hover:shadow-[var(--shadow-menu)]',
        'active:translate-y-0 active:duration-100',
      )}
    >
      <div className="flex h-40 items-center justify-center bg-canvas p-3">
        <PresetThumbnail preset={preset} />
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-1.5 border-t border-line px-3.5 py-3">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-[13px] font-semibold tracking-tight text-ink">{preset.name}</h3>
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-ink-quiet">
            {CATEGORY_LABEL[preset.category]}
          </span>
        </div>

        <p className="text-[12px] leading-relaxed text-ink-muted">{preset.tagline}</p>

        <dl className="mt-auto flex flex-wrap gap-x-3 gap-y-0.5 pt-1.5 font-mono text-[10.5px] text-ink-quiet">
          <div>{stats.footprint}</div>
          <div>{stats.channelLengthMm.toFixed(0)} mm path</div>
          <div>
            {stats.portCount} port{stats.portCount === 1 ? '' : 's'}
          </div>
        </dl>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// detail
// ---------------------------------------------------------------------------

function PresetDetail({ preset, onClose }: { preset: ChipPreset | null; onClose: () => void }) {
  const navigate = useNavigate();
  const newProject = useProjectStore((s) => s.newProject);
  const { confirmDiscard } = useProjectActions();
  const [starting, setStarting] = useState(false);

  // Kept mounted through the close animation so the dialog does not blank out
  // as it shrinks; Radix unmounts it once the exit keyframe finishes.
  const [last, setLast] = useState<ChipPreset | null>(null);
  const shown = preset ?? last;
  if (preset && preset !== last) setLast(preset);

  const stats = useMemo(
    () => (shown ? presetStats(shown, presetBuild(shown)) : null),
    [shown],
  );

  const start = async () => {
    if (!shown) return;
    setStarting(true);
    try {
      if (!(await confirmDiscard('Starting from a template'))) return;

      newProject(projectOptionsFromPreset(shown, presetBuild(shown)));
      onClose();
      void navigate('/draw');

      toast.success(`Started from “${shown.name}”`, {
        description: 'Edit it exactly as if you had drawn it — nothing here is locked.',
      });
    } finally {
      setStarting(false);
    }
  };

  if (!shown) return null;

  return (
    <Dialog
      open={preset !== null}
      onOpenChange={(next) => !next && onClose()}
      title={shown.name}
      description={shown.tagline}
      className="w-[min(calc(100vw-2rem),42rem)]"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={<ArrowRight size={15} />}
            disabled={starting}
            onClick={() => void start()}
          >
            Start from this template
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 pb-2">
        <div className="flex h-56 items-center justify-center rounded-xl border border-line bg-canvas p-4">
          <PresetThumbnail preset={shown} detailed />
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl border border-line bg-sunken px-4 py-3 sm:grid-cols-4">
          <Stat label="Footprint" value={stats?.footprint ?? '—'} />
          <Stat label="Channel path" value={`${stats?.channelLengthMm.toFixed(0) ?? '—'} mm`} />
          <Stat label="Segments" value={String(stats?.segmentCount ?? '—')} />
          <Stat label="Ports" value={String(stats?.portCount ?? '—')} />
        </dl>

        <section>
          <h4 className="text-[12px] font-semibold tracking-tight text-ink">What it is</h4>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">{shown.description}</p>
        </section>

        <section>
          <h4 className="text-[12px] font-semibold tracking-tight text-ink">How it mixes</h4>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">{shown.principle}</p>
        </section>

        {shown.caveat ? (
          <div className="flex gap-2.5 rounded-xl border border-caution/40 bg-caution-wash px-3.5 py-3">
            <Info size={14} className="mt-0.5 shrink-0 text-caution" />
            <div>
              <p className="text-[12px] font-medium text-ink">Worth knowing before you print</p>
              <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">{shown.caveat}</p>
            </div>
          </div>
        ) : null}

        {shown.references?.length ? (
          <section>
            <h4 className="text-[12px] font-semibold tracking-tight text-ink">Based on</h4>
            <ul className="mt-1 flex flex-col gap-1.5">
              {shown.references.map((reference) => (
                <li key={reference.citation} className="text-[12px] leading-relaxed text-ink-muted">
                  {reference.citation}
                  {reference.doi ? (
                    <>
                      {' '}
                      <a
                        href={`https://doi.org/${reference.doi}`}
                        target="_blank"
                        rel="noopener"
                        className="font-mono text-[11px] text-accent underline decoration-accent/35 underline-offset-2 hover:decoration-accent"
                      >
                        doi:{reference.doi}
                      </a>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* The wiki carries the physics and the printing notes this dialog has
            no room for. Anchored on the preset's own id — see wikiLinks.ts. */}
        <p className="text-[12px] text-ink-muted">
          <a
            href={presetHelpUrl(shown.id)}
            target="_blank"
            rel="noopener"
            className="text-accent underline decoration-accent/35 underline-offset-2 transition-colors hover:decoration-accent"
          >
            {shown.name} in the wiki
          </a>
        </p>
      </div>
    </Dialog>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-mono text-[10px] uppercase tracking-wider text-ink-quiet">{label}</dt>
      <dd className="mt-0.5 text-[13px] font-medium text-ink">{value}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// empty state
// ---------------------------------------------------------------------------

function NoResults({ query, onClear }: { query: string; onClear: () => void }) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-sm text-center">
        <span className="mx-auto inline-flex h-11 w-11 items-center justify-center rounded-2xl border border-line bg-panel text-ink-faint">
          <LibraryBig size={20} strokeWidth={1.75} />
        </span>
        <p className="mt-4 text-[13px] font-medium text-ink">
          {query ? `Nothing matches “${query}”` : 'Nothing in this category'}
        </p>
        <p className="mt-1.5 text-[12px] leading-relaxed text-ink-muted">
          The library ships {CHIP_PRESETS.length} starter geometries. Try a broader term — “mixer”,
          “gradient”, “droplet” — or clear the filters and browse them all.
        </p>
        <Button size="sm" icon={<X size={13} />} className="mt-4" onClick={onClear}>
          Clear filters
        </Button>
      </div>
    </div>
  );
}
