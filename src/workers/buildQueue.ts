/**
 * The CAD worker's request queue.
 *
 * Two kinds of request share one worker and want opposite handling:
 *
 * - **Previews** are disposable. Only the newest matters, so they share a
 *   single slot and a newer one replaces a waiting one. Dragging a slider posts
 *   a build per frame; without this the viewport falls further behind the
 *   longer the drag goes on.
 * - **Exports** are promises someone is waiting on. They queue in order, are
 *   never replaced and go first. A preview landing in the same slot as a
 *   pending export would otherwise make the export silently never happen and
 *   time out a minute later.
 *
 * The yield before each take is what makes replacement actually happen. A
 * build is synchronous, so messages posted during it sit in the macrotask
 * queue; awaiting only a microtask (such as an already-resolved WASM load)
 * would take the next request before any of them landed, and every stale
 * preview would still be built in turn. A zero-delay timeout lets them land
 * first.
 *
 * Kept free of worker globals so it can be tested directly.
 */

export interface QueuedRequest {
  kind?: 'preview' | 'export';
}

export function createBuildQueue<R extends QueuedRequest>(run: (request: R) => Promise<void> | void) {
  let preview: R | null = null;
  const exports: R[] = [];
  let running = false;

  const yieldToMessages = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  async function drain(): Promise<void> {
    if (running) return;
    running = true;
    try {
      for (;;) {
        await yieldToMessages();
        const request = exports.shift() ?? preview;
        if (!request) break;
        if (request === preview) preview = null;
        await run(request);
      }
    } finally {
      running = false;
    }
  }

  return {
    push(request: R): void {
      if (request.kind === 'export') exports.push(request);
      else preview = request;
      void drain();
    },
  };
}
