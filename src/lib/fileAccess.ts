/**
 * Where `.openchip` text comes from and goes.
 *
 * Two backends, chosen at runtime:
 *
 * - **File System Access API** (Chrome/Edge, and Safari 15.2+ for *open* only).
 *   Gives a real file handle, so a second Save overwrites the same file in
 *   place with no dialog and no `chip (3).openchip` pile-up in Downloads.
 * - **Download / upload fallback** (Firefox, Safari). Save produces a
 *   download; Open uses a hidden `<input type="file">`. Every save lands a new
 *   copy in the browser's download folder — unavoidable without the API.
 *
 * Everything is behind `ProjectStorage` so a future backend adapter can drop in
 * without touching the store or the UI.
 */

import { downloadBlob } from './download';
import { OPENCHIP_EXTENSION, OPENCHIP_MIME } from './projectFile';

// ---------------------------------------------------------------------------
// minimal File System Access typings
//
// Declared locally and reached via a cast rather than by augmenting `Window`,
// so this never collides with whatever lib.dom ships in a future TS release.
// ---------------------------------------------------------------------------

type PermissionState = 'granted' | 'denied' | 'prompt';

interface FsaFileHandle {
  readonly name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: string | Blob): Promise<void>; close(): Promise<void> }>;
  queryPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}

interface FsaPickerOptions {
  suggestedName?: string;
  excludeAcceptAllOption?: boolean;
  types?: { description: string; accept: Record<string, string[]> }[];
}

interface FsaWindow {
  showSaveFilePicker?(options?: FsaPickerOptions): Promise<FsaFileHandle>;
  showOpenFilePicker?(
    options?: FsaPickerOptions & { multiple?: boolean },
  ): Promise<FsaFileHandle[]>;
}

const fsa = (): FsaWindow => window as unknown as FsaWindow;

const PICKER_TYPES = [
  {
    description: 'OpenChip project',
    accept: { [OPENCHIP_MIME]: [OPENCHIP_EXTENSION] as string[] },
  },
];

// ---------------------------------------------------------------------------
// capabilities
// ---------------------------------------------------------------------------

export const canSaveInPlace = (): boolean => typeof fsa().showSaveFilePicker === 'function';
export const canPickToOpen = (): boolean => typeof fsa().showOpenFilePicker === 'function';

// ---------------------------------------------------------------------------
// results
// ---------------------------------------------------------------------------

/**
 * A handle to the file backing the current project, when the browser gives us
 * one. Held in memory for the session only — handles can be persisted in
 * IndexedDB, but re-granting permission after a reload needs a user gesture, so
 * the first Save after a reload prompts once instead.
 */
export interface FileTarget {
  handle: FsaFileHandle | null;
  name: string;
}

export type SaveOutcome =
  | { status: 'saved'; target: FileTarget; inPlace: boolean }
  | { status: 'downloaded'; name: string }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

export type OpenOutcome =
  | { status: 'opened'; text: string; target: FileTarget }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

export interface SaveOptions {
  suggestedName: string;
  /** Reuse this handle to overwrite silently. Ignored when `promptForLocation`. */
  target?: FileTarget | null;
  /** Force the "Save As" dialog even when a handle is available. */
  promptForLocation?: boolean;
}

export interface ProjectStorage {
  save(text: string, options: SaveOptions): Promise<SaveOutcome>;
  open(): Promise<OpenOutcome>;
}

const isAbort = (error: unknown): boolean =>
  error instanceof DOMException && (error.name === 'AbortError' || error.name === 'NotAllowedError');

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// ---------------------------------------------------------------------------
// save
// ---------------------------------------------------------------------------

async function ensureWritable(handle: FsaFileHandle): Promise<boolean> {
  if (typeof handle.queryPermission !== 'function') return true;
  const existing = await handle.queryPermission({ mode: 'readwrite' });
  if (existing === 'granted') return true;
  if (typeof handle.requestPermission !== 'function') return false;
  return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
}

async function writeToHandle(handle: FsaFileHandle, text: string): Promise<void> {
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
}

async function save(text: string, options: SaveOptions): Promise<SaveOutcome> {
  const { suggestedName, target, promptForLocation = false } = options;

  // Fast path: we already own a writable handle and the caller didn't ask for
  // a new location.
  if (!promptForLocation && target?.handle) {
    try {
      if (await ensureWritable(target.handle)) {
        await writeToHandle(target.handle, text);
        return { status: 'saved', target, inPlace: true };
      }
      // Permission was revoked (e.g. the file moved). Fall through to a picker.
    } catch (error) {
      if (isAbort(error)) return { status: 'cancelled' };
      // A stale handle should not dead-end the user — fall through to a picker.
    }
  }

  const showSaveFilePicker = fsa().showSaveFilePicker;
  if (typeof showSaveFilePicker === 'function') {
    try {
      const handle = await showSaveFilePicker({
        suggestedName,
        types: PICKER_TYPES,
        excludeAcceptAllOption: false,
      });
      await writeToHandle(handle, text);
      return { status: 'saved', target: { handle, name: handle.name }, inPlace: false };
    } catch (error) {
      if (isAbort(error)) return { status: 'cancelled' };
      return { status: 'error', message: messageOf(error) };
    }
  }

  try {
    downloadBlob(text, suggestedName, `${OPENCHIP_MIME};charset=utf-8`);
    return { status: 'downloaded', name: suggestedName };
  } catch (error) {
    return { status: 'error', message: messageOf(error) };
  }
}

// ---------------------------------------------------------------------------
// open
// ---------------------------------------------------------------------------

function pickViaInput(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    // Some browsers filter by MIME rather than extension, and `.openchip` has
    // no registered type — accept JSON too so the file isn't greyed out.
    input.accept = `${OPENCHIP_EXTENSION},application/json,.json`;
    input.style.display = 'none';

    let settled = false;
    const finish = (file: File | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(file);
    };

    input.addEventListener('change', () => finish(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => finish(null));

    document.body.append(input);
    input.click();
  });
}

async function open(): Promise<OpenOutcome> {
  const showOpenFilePicker = fsa().showOpenFilePicker;

  if (typeof showOpenFilePicker === 'function') {
    try {
      const [handle] = await showOpenFilePicker({ types: PICKER_TYPES, multiple: false });
      if (!handle) return { status: 'cancelled' };
      const file = await handle.getFile();
      return {
        status: 'opened',
        text: await file.text(),
        target: { handle, name: handle.name },
      };
    } catch (error) {
      if (isAbort(error)) return { status: 'cancelled' };
      return { status: 'error', message: messageOf(error) };
    }
  }

  try {
    const file = await pickViaInput();
    if (!file) return { status: 'cancelled' };
    return {
      status: 'opened',
      text: await file.text(),
      // No handle in the fallback path — a later Save must prompt.
      target: { handle: null, name: file.name },
    };
  } catch (error) {
    return { status: 'error', message: messageOf(error) };
  }
}

export const browserStorage: ProjectStorage = { save, open };
