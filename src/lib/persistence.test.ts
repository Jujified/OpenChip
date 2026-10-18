/**
 * Draft writes against a localStorage that fills up.
 *
 * The module probes `window.localStorage` when it loads, so each test installs
 * a fake with a byte budget first and then imports a fresh copy.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

type Persistence = typeof import('./persistence');

/**
 * A localStorage that throws once the stored text would pass `quota` chars.
 * It counts the value being replaced until the write lands, the stricter of
 * the ways a browser can do its accounting.
 */
function quotaStorage(quota: number) {
  const items = new Map<string, string>();
  const used = () => [...items.values()].reduce((sum, v) => sum + v.length, 0);
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (used() + value.length > quota) {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      }
      items.set(key, value);
    },
    removeItem: (key: string) => void items.delete(key),
  };
}

let storage: ReturnType<typeof quotaStorage>;
let persistence: Persistence;

beforeEach(async () => {
  storage = quotaStorage(1000);
  vi.stubGlobal('window', { localStorage: storage, addEventListener: () => {} });
  vi.resetModules();
  persistence = await import('./persistence');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a draft that outgrows storage', () => {
  const big = 'x'.repeat(2000);

  it('removes the stale copy instead of leaving it to be restored', () => {
    const outcomes: string[] = [];
    persistence.onStorageWrite((_key, outcome) => outcomes.push(outcome));
    const draft = persistence.debouncedStorage(400);

    draft.setItem('draft', 'edit 1');
    persistence.flushPending();
    assert.equal(storage.items.get('draft'), 'edit 1');

    draft.setItem('draft', big);
    persistence.flushPending();
    assert.equal(storage.items.has('draft'), false, 'the stale draft is still there');
    assert.deepEqual(outcomes, ['saved', 'failed']);
  });

  it('stores the shrunk stand-in when there is one', () => {
    const outcomes: string[] = [];
    persistence.onStorageWrite((_key, outcome) => outcomes.push(outcome));
    const draft = persistence.debouncedStorage(400, { shrink: () => 'small' });

    draft.setItem('draft', big);
    persistence.flushPending();
    assert.equal(storage.items.get('draft'), 'small');
    assert.deepEqual(outcomes, ['shrunk']);
  });

  it('frees the old copy first when that is what makes the new one fit', () => {
    const draft = persistence.debouncedStorage(400);
    draft.setItem('draft', 'y'.repeat(600));
    persistence.flushPending();

    // 600 + 600 is over budget, but 600 alone is not.
    draft.setItem('draft', 'z'.repeat(600));
    persistence.flushPending();
    assert.equal(storage.items.get('draft'), 'z'.repeat(600));
  });
});
