/**
 * The keyboard shortcut catalogue.
 *
 * One list, read by the help sheet and quoted by the toolbar tooltips. Keeping
 * it as data means a shortcut cannot be added to the handler and forgotten in
 * the documentation — which is the usual way a "press ? for shortcuts" sheet
 * ends up lying to people.
 *
 * The handlers themselves live where their context does: file actions in
 * `useKeyboardShortcuts`, editing in `useDrawShortcuts`, and the canvas keys in
 * `DrawCanvas`. Only the descriptions are centralised.
 */

// `navigator.platform` is deprecated; the userAgent is the portable read.
export const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);

/** ⌘ on a Mac, Ctrl everywhere else. Written into the printed key hints. */
export const MOD = isMac ? '⌘' : 'Ctrl';

const mod = (key: string): string => (isMac ? `⌘${key}` : `Ctrl+${key}`);
const shiftMod = (key: string): string => (isMac ? `⇧⌘${key}` : `Ctrl+Shift+${key}`);

export interface Shortcut {
  keys: string;
  label: string;
  detail?: string;
}

export interface ShortcutGroup {
  title: string;
  shortcuts: Shortcut[];
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'Tools',
    shortcuts: [
      { keys: 'V', label: 'Select', detail: 'Click, marquee, drag nodes and bezier handles.' },
      { keys: 'P', label: 'Draw', detail: 'Click to lay down channel segments.' },
      {
        keys: 'D',
        label: 'Dimension',
        detail: 'Click a channel to pin its width there. Widths interpolate between markers.',
      },
    ],
  },
  {
    title: 'Editing',
    shortcuts: [
      { keys: mod('Z'), label: 'Undo' },
      { keys: shiftMod('Z'), label: 'Redo' },
      { keys: mod('C'), label: 'Copy the selected sub-path' },
      { keys: mod('V'), label: 'Paste', detail: 'Successive pastes cascade instead of stacking.' },
      { keys: mod('D'), label: 'Duplicate in place' },
      { keys: mod('A'), label: 'Select everything' },
      { keys: 'Delete · Backspace', label: 'Remove the selection' },
      {
        keys: 'B',
        label: 'Straight ↔ curved',
        detail: 'Toggles the selected segments. Handles are kept, so toggling back restores the curve.',
      },
      {
        keys: `${MOD}-click a segment`,
        label: 'Insert a node',
        detail: 'Splits the segment cleanly and keeps its dimension markers.',
      },
      { keys: 'Esc', label: 'End the draw run, or clear the selection' },
      { keys: 'Enter', label: 'End the draw run without leaving the tool' },
    ],
  },
  {
    title: 'View',
    shortcuts: [
      { keys: 'G', label: 'Show or hide the grid' },
      { keys: 'T', label: 'Show or hide the width preview' },
      { keys: 'Alt-drag · middle-drag', label: 'Pan' },
      { keys: 'Scroll', label: 'Zoom at the cursor' },
    ],
  },
  {
    title: 'Project',
    shortcuts: [
      { keys: mod('S'), label: 'Save' },
      { keys: shiftMod('S'), label: 'Save as…' },
      { keys: mod('O'), label: 'Open a project' },
      { keys: shiftMod('E'), label: 'Export for presentation' },
      { keys: '?', label: 'This list' },
    ],
  },
];
