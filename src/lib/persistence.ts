/**
 * Local persistence plumbing shared by the Zustand stores.
 *
 * Two concerns live here:
 *
 * 1. **A safe `localStorage`.** Private-browsing modes and storage-disabled
 *    profiles throw on access. Falling back to an in-memory map keeps the app
 *    fully usable — the user just loses draft recovery, which is exactly the
 *    feature they opted out of by disabling storage.
 *
 * 2. **Debounced writes.** The draft mirrors the whole project, saved images
 *    included, and a drag mutates it on every pointer-move. So both the
 *    serialisation and the write are deferred: an update only records the
 *    latest value, and the flush stringifies it once — on a timer, and on
 *    `pagehide`/`visibilitychange` so a close or reload never drops the last
 *    edits.
 *
 * 3. **Writes that do not fit.** localStorage holds about 5 MB. A draft that
 *    outgrows it is shrunk if the caller knows how, and otherwise removed —
 *    never left behind stale, where it would later be "restored" as if it were
 *    current. Either way listeners hear about it, so the user can be told.
 */

import type { PersistStorage, StateStorage, StorageValue } from 'zustand/middleware';

export const SETTINGS_STORAGE_KEY = 'openchip.settings.v1';
export const DRAFT_STORAGE_KEY = 'openchip.draft.v1';
export const CHECK_SETTINGS_STORAGE_KEY = 'openchip.check-settings.v1';

// ---------------------------------------------------------------------------
// safe localStorage
// ---------------------------------------------------------------------------

function probeLocalStorage(): Storage | null {
  try {
    const probe = '__openchip_probe__';
    window.localStorage.setItem(probe, probe);
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return null;
  }
}

const memoryStore = new Map<string, string>();
const backing: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> =
  probeLocalStorage() ?? {
    getItem: (key) => memoryStore.get(key) ?? null,
    setItem: (key, value) => void memoryStore.set(key, value),
    removeItem: (key) => void memoryStore.delete(key),
  };

export const storageIsPersistent = probeLocalStorage() !== null;

/**
 * Whether a draft was already on disk when the page loaded.
 *
 * Read at module init, before any store has had a chance to write, so boot can
 * tell "restored the user's work" apart from "nothing was there" — the two need
 * different first screens.
 */
export const draftExistedAtBoot = (() => {
  try {
    return backing.getItem(DRAFT_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
})();

/** False when the write threw, which in practice means the quota is full. */
function tryWrite(name: string, value: string): boolean {
  try {
    backing.setItem(name, value);
    return true;
  } catch {
    return false;
  }
}

/**
 * How a debounced write landed: in full, shrunk to fit, or not at all (and any
 * older copy under the key removed).
 */
export type WriteOutcome = 'saved' | 'shrunk' | 'failed';
type WriteListener = (name: string, outcome: WriteOutcome) => void;
const writeListeners = new Set<WriteListener>();

/** Hears the outcome of every flushed debounced write. Returns an unsubscribe. */
export function onStorageWrite(listener: WriteListener): () => void {
  writeListeners.add(listener);
  return () => void writeListeners.delete(listener);
}

export const safeStorage: StateStorage = {
  getItem: (name) => {
    try {
      return backing.getItem(name);
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    // Settings are a few hundred bytes; if even they do not fit, keeping the
    // previous copy beats losing it. The draft goes through `flushPending`,
    // which does not get to fail quietly.
    tryWrite(name, value);
  },
  removeItem: (name) => {
    try {
      backing.removeItem(name);
    } catch {
      /* nothing useful to do */
    }
  },
};

// ---------------------------------------------------------------------------
// debounced storage
// ---------------------------------------------------------------------------

/**
 * Values waiting to be written, as thunks so a structured value is only
 * stringified when it is actually flushed — however many updates land first.
 */
const pending = new Map<string, () => string>();
const shrinkers = new Map<string, (value: string) => string | null>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function writeOrShrink(key: string, value: string): WriteOutcome {
  if (tryWrite(key, value)) return 'saved';

  // Out of room. The old copy is stale from here on and must not survive to be
  // restored as current; removing it also frees its space for this write.
  try {
    backing.removeItem(key);
  } catch {
    /* nothing useful to do */
  }
  if (tryWrite(key, value)) return 'saved';

  const smaller = shrinkers.get(key)?.(value) ?? null;
  if (smaller !== null && tryWrite(key, smaller)) return 'shrunk';
  return 'failed';
}

function flushPending(): void {
  if (flushTimer !== undefined) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  if (pending.size === 0) return;
  const batch = [...pending];
  pending.clear();
  for (const [key, serialise] of batch) {
    const outcome = writeOrShrink(key, serialise());
    for (const listener of writeListeners) listener(key, outcome);
  }
}

export interface DebouncedStorageOptions {
  /**
   * Called only when a value does not fit: returns a smaller stand-in to store
   * instead, or null when there is nothing to drop.
   */
  shrink?: (value: string) => string | null;
}

/** Queues a write, replacing any not yet flushed for the same key. */
function enqueue(
  name: string,
  serialise: () => string,
  delayMs: number,
  options: DebouncedStorageOptions,
): void {
  if (options.shrink) shrinkers.set(name, options.shrink);
  pending.set(name, serialise);
  if (flushTimer !== undefined) clearTimeout(flushTimer);
  flushTimer = setTimeout(flushPending, delayMs);
}

/** Writes at most once per `delayMs`, and always before the page goes away. */
export function debouncedStorage(
  delayMs: number,
  options: DebouncedStorageOptions = {},
): StateStorage {
  return {
    getItem: (name) => {
      // Read through the pending buffer so a read-after-write is consistent.
      const buffered = pending.get(name);
      return buffered ? buffered() : safeStorage.getItem(name);
    },
    setItem: (name, value) => enqueue(name, () => value, delayMs, options),
    removeItem: (name) => {
      pending.delete(name);
      safeStorage.removeItem(name);
    },
  };
}

/**
 * `debouncedStorage` as zustand's `PersistStorage`, taking the state object
 * rather than a string.
 *
 * zustand's own `createJSONStorage` stringifies inside `setItem`, synchronously
 * on every store update. With a few saved snapshots in the project that is
 * several milliseconds per drag frame, all of it thrown away by the next frame.
 * Here `setItem` only keeps the object; the flush stringifies it once.
 */
export function debouncedPersistStorage<S>(
  delayMs: number,
  options: DebouncedStorageOptions = {},
): PersistStorage<S> {
  return {
    getItem: (name) => {
      const buffered = pending.get(name);
      const text = buffered ? buffered() : safeStorage.getItem(name);
      if (typeof text !== 'string') return null;
      try {
        return JSON.parse(text) as StorageValue<S>;
      } catch {
        return null;
      }
    },
    setItem: (name, value) => enqueue(name, () => JSON.stringify(value), delayMs, options),
    removeItem: (name) => {
      pending.delete(name);
      safeStorage.removeItem(name);
    },
  };
}

if (typeof window !== 'undefined') {
  // `pagehide` fires on close, reload and bfcache eviction; `visibilitychange`
  // catches the mobile/tab-switch case that `beforeunload` misses.
  window.addEventListener('pagehide', flushPending);
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPending();
  });
}

export { flushPending };
