/**
 * manifold-3d WASM bootstrap.
 *
 * The emscripten loader resolves `manifold.wasm` relative to itself, which
 * breaks once Vite hashes and relocates assets. Importing the binary with
 * `?url` makes Vite emit it and hand back the real path, and `locateFile`
 * points the loader at it — so this works identically in dev and in a built
 * bundle.
 *
 * Instantiation is memoised: the WASM heap is expensive to set up and there is
 * no reason for a second one in the same thread.
 */

import Module from 'manifold-3d';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import type { ManifoldApi } from './buildChip';

let pending: Promise<ManifoldApi> | null = null;

export function loadManifold(): Promise<ManifoldApi> {
  if (!pending) {
    pending = Module({ locateFile: () => wasmUrl }).then((wasm) => {
      wasm.setup();
      return { Manifold: wasm.Manifold, Mesh: wasm.Mesh } as unknown as ManifoldApi;
    });
  }
  return pending;
}
