import {
  ChevronDown,
  Copy,
  FilePlus2,
  FolderOpen,
  Images,
  Keyboard,
  Compass,
  RotateCcw,
  BookOpen,
  Save,
  Settings2,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react';
import { cn } from '../lib/cn';
import { useProjectActions } from '../hooks/useProjectActions';
import { useProjectStore } from '../store/projectStore';
import { useTourStore } from '../store/tourStore';
import { useUiStore } from '../store/uiStore';
import { ProjectTitle } from './ProjectTitle';
import { TabBar } from './TabBar';
import { Button } from './ui/Button';
import { MenuContent, MenuItem, MenuLabel, MenuRoot, MenuSeparator, MenuTrigger } from './ui/Menu';
import { SITE_URL, WIKI_URL } from '../lib/siteUrls';

// `navigator.platform` is deprecated; userAgent is the portable read.
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
const mod = isMac ? '⌘' : 'Ctrl+';

export function TopBar() {
  const { create, open, save, saveCopy, confirmDiscard } = useProjectActions();
  const isDirty = useProjectStore((state) => state.isDirty);
  const isSaving = useProjectStore((state) => state.isSaving);
  const openSettings = useUiStore((state) => state.openSettings);
  const openWizard = useUiStore((state) => state.openWizard);
  const openPresentation = useUiStore((state) => state.openPresentation);
  const openDesignWithAi = useUiStore((state) => state.openDesignWithAi);
  const openShortcuts = useUiStore((state) => state.openShortcuts);
  const startTour = useTourStore((state) => state.start);

  // Both halves of the split button track the dirty state together, or the
  // control reads as two unrelated buttons that happen to touch.
  const saveVariant = isDirty ? 'primary' : 'secondary';

  const rerunSetup = async () => {
    // Setup ends by creating a new project, so it discards the current one.
    if (!(await confirmDiscard('Running setup again'))) return;
    openWizard();
  };

  return (
    <header className="shrink-0 border-b border-line bg-panel">
      <div className="flex h-12 items-center gap-2 px-3">
        <Wordmark />

        <MenuRoot>
          <MenuTrigger asChild>
            <Button variant="ghost" size="sm" className="text-ink">
              Project
              <ChevronDown size={13} className="opacity-60" />
            </Button>
          </MenuTrigger>
          <MenuContent>
            <MenuItem icon={<FilePlus2 size={15} />} onSelect={() => void create()}>
              New Project
            </MenuItem>
            <MenuItem
              icon={<FolderOpen size={15} />}
              shortcut={`${mod}O`}
              onSelect={() => void open()}
            >
              Open Project…
            </MenuItem>
            <MenuItem icon={<Sparkles size={15} />} onSelect={openDesignWithAi}>
              Design with AI…
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<Save size={15} />} shortcut={`${mod}S`} onSelect={() => void save()}>
              Save Project
            </MenuItem>
            <MenuItem shortcut={`⇧${mod}S`} onSelect={() => void save({ saveAs: true })}>
              Save As…
            </MenuItem>
            <MenuItem icon={<Copy size={15} />} onSelect={() => void saveCopy()}>
              Save a Copy…
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              icon={<Images size={15} />}
              shortcut={`⇧${mod}E`}
              onSelect={openPresentation}
            >
              Export for presentation…
            </MenuItem>
          </MenuContent>
        </MenuRoot>

        <MenuRoot>
          <MenuTrigger asChild>
            <Button variant="ghost" size="sm" className="text-ink">
              Settings
              <ChevronDown size={13} className="opacity-60" />
            </Button>
          </MenuTrigger>
          <MenuContent>
            <MenuItem icon={<SlidersHorizontal size={15} />} onSelect={openSettings}>
              Project settings…
            </MenuItem>
            <MenuSeparator />
            <MenuLabel>Help</MenuLabel>
            <MenuItem icon={<Compass size={15} />} onSelect={startTour}>
              Take the tour
            </MenuItem>
            <MenuItem icon={<Keyboard size={15} />} shortcut="?" onSelect={openShortcuts}>
              Keyboard shortcuts
            </MenuItem>
            <MenuItem icon={<BookOpen size={15} />} href={WIKI_URL}>
              Open the wiki
            </MenuItem>
            <MenuSeparator />
            <MenuLabel>First-run setup</MenuLabel>
            <MenuItem icon={<RotateCcw size={15} />} onSelect={() => void rerunSetup()}>
              Run setup again…
            </MenuItem>
          </MenuContent>
        </MenuRoot>

        <div className="mx-1 h-5 w-px bg-line" />

        <ProjectTitle />

        <div className="ml-auto flex items-center gap-2">
          {/* The cross-surface nav, folded into the bar that already exists
              rather than added as a second one — the app is a working tool and
              vertical space is expensive. Same labels and same order as the
              landing page and the wiki. Colour transition only: this is
              high-frequency chrome and motion here is a tax. */}
          <nav aria-label="OpenChip sites" className="hidden items-center gap-0.5 md:flex">
            <a
              href={SITE_URL}
              rel="noopener"
              className="rounded-md px-2 py-1 text-[13px] text-ink-muted transition-colors hover:bg-sunken hover:text-ink"
            >
              Home
            </a>
            <a
              href={WIKI_URL}
              target="_blank"
              rel="noopener"
              className="rounded-md px-2 py-1 text-[13px] text-ink-muted transition-colors hover:bg-sunken hover:text-ink"
            >
              Wiki
            </a>
          </nav>

          <div className="mx-0.5 hidden h-5 w-px bg-line md:block" />

          {/* The way in for someone who would rather describe a chip than draw
              one. Tinted rather than outlined so it reads as an invitation,
              not one more tool. */}
          <Button
            variant="ghost"
            size="sm"
            icon={<Sparkles size={14} />}
            onClick={openDesignWithAi}
            className="hidden bg-accent-wash text-accent hover:bg-accent-wash hover:text-accent-hover sm:inline-flex"
          >
            Design with AI
          </Button>
          {/* Promoted out of the menu: it is the last thing a user does with a
              finished chip, and burying the finish line is a strange choice. */}
          <Button
            variant="secondary"
            size="sm"
            icon={<Images size={14} />}
            onClick={openPresentation}
            className="hidden sm:inline-flex"
          >
            Present
          </Button>
          {/* A split button. The face saves outright — the common case stays
              one click — and only the chevron opens the variants. Putting the
              menu in front of every save would tax the action this bar exists
              to make easy. */}
          <div className="flex">
            <Button
              variant={saveVariant}
              size="sm"
              icon={<Save size={14} />}
              disabled={isSaving}
              onClick={() => void save()}
              className="rounded-r-none"
            >
              Save
            </Button>
            <MenuRoot>
              <MenuTrigger asChild>
                <Button
                  variant={saveVariant}
                  size="sm"
                  disabled={isSaving}
                  aria-label="More save options"
                  className={cn(
                    // `-ml-px` collapses the two borders into one seam rather
                    // than a 2px ridge down the middle of a single control.
                    'rounded-l-none px-1.5 -ml-px',
                    // The primary variant has no border to collapse, so the
                    // seam has to be drawn.
                    isDirty && 'border-l-accent-ink/25',
                  )}
                >
                  <ChevronDown size={13} className="opacity-70" />
                </Button>
              </MenuTrigger>
              <MenuContent align="end">
                <MenuItem
                  icon={<Save size={15} />}
                  shortcut={`${mod}S`}
                  onSelect={() => void save()}
                >
                  Save
                </MenuItem>
                <MenuItem icon={<Copy size={15} />} onSelect={() => void saveCopy()}>
                  Save a Copy…
                </MenuItem>
              </MenuContent>
            </MenuRoot>
          </div>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Project settings"
            onClick={openSettings}
            className="px-2"
          >
            <Settings2 size={16} />
          </Button>
        </div>
      </div>

      <div className="flex h-10 items-center px-3">
        <TabBar />
      </div>
    </header>
  );
}

/**
 * The OpenChip mark. The outline, channel path, port dots, and corner radius
 * are the favicon's own geometry (`brand/mark-geometry.mjs`, `channelPath(16)`
 * /`portA(16)`/`portB(16)`/`dotRadius(16)`/`cornerRadius(16)`), stroked rather
 * than filled so it reads as a mark next to text. `brand/mark-sync.test.ts`
 * fails if this drifts from that geometry.
 */
function Wordmark() {
  return (
    <div className="flex select-none items-center gap-2 pl-1 pr-2">
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="text-accent">
        <rect
          x="0.75"
          y="0.75"
          width="14.5"
          height="14.5"
          rx="3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path
          d="M4.5 10.75C4.5 7.75 6.5 7.75 8 7.75C9.5 7.75 11.5 7.75 11.5 4.75"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        <circle cx="4.5" cy="10.75" r="1.3" fill="currentColor" />
        <circle cx="11.5" cy="4.75" r="1.3" fill="currentColor" />
      </svg>
      <span className="text-[13px] font-semibold tracking-tight text-ink">OpenChip</span>
    </div>
  );
}
