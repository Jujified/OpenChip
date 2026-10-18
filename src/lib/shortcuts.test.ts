/**
 * The catalogue exists so a key cannot be wired up and left undocumented. It
 * once missed Backspace, because the drift was *inside* an entry rather
 * than a missing one: the handler took Delete and Backspace, the catalogue said
 * only Delete, and the help sheet renders from the catalogue. Most laptops have
 * no Delete key, so the one documented way to delete was one many users could
 * not press.
 *
 * So this reads the handlers themselves and asserts every key they act on is
 * spelled out somewhere in the catalogue's key hints.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { SHORTCUT_GROUPS } from './shortcuts';

/** Every file that binds a key. Listed rather than globbed, so adding a
 *  handler elsewhere is a deliberate act that includes updating this. */
const HANDLERS = [
  'src/hooks/useKeyboardShortcuts.ts',
  'src/hooks/useDrawShortcuts.ts',
  'src/components/draw/DrawCanvas.tsx',
];

/** Where the catalogue's spelling is not the `KeyboardEvent.key` value. */
const AS_WRITTEN: Record<string, string> = { Escape: 'Esc' };

function keysHandledIn(source: string): string[] {
  const found = new Set<string>();
  // `event.key === 'Escape'`, and the lowercased `key === 'z'` form.
  for (const [, key] of source.matchAll(/\bkey === '([^']+)'/g)) found.add(key);
  // The `switch (key)` arms. Single characters only: every multi-character
  // case in these files switches on something else, like a tool name.
  for (const [, key] of source.matchAll(/\bcase '(.)':/g)) found.add(key);
  return [...found];
}

/** A key hint mentions a key when the token stands alone — `⌘E` and
 *  `Ctrl+Shift+E` mention E, `Delete` does not. */
function mentions(hints: string, key: string): boolean {
  const token = AS_WRITTEN[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  return /^[A-Za-z]/.test(token)
    ? new RegExp(`(?<![A-Za-z])${token}(?![A-Za-z])`).test(hints)
    : hints.includes(token);
}

describe('the shortcut catalogue', () => {
  const hints = SHORTCUT_GROUPS.flatMap((group) => group.shortcuts.map((s) => s.keys)).join('\n');

  for (const path of HANDLERS) {
    it(`documents every key ${path} binds`, () => {
      const handled = keysHandledIn(readFileSync(path, 'utf8'));
      assert.ok(handled.length > 0, `no key bindings found — has ${path} moved?`);

      const undocumented = handled.filter((key) => !mentions(hints, key));
      assert.deepEqual(undocumented, [], `bound but absent from the help sheet: ${undocumented}`);
    });
  }

  it('spells Backspace out, since most laptops have no Delete key', () => {
    assert.ok(mentions(hints, 'Backspace'));
    assert.ok(mentions(hints, 'Delete'));
  });
});
