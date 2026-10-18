/**
 * CSG worker.
 *
 * A serpentine rebuild measures 50–130 ms at preview quality and up to ~290 ms
 * at export quality. Run on the main thread that would visibly stick every time
 * a parameter slider moved, so the whole pipeline lives here and the geometry
 * arrives as transferable typed arrays.
 *
 * Requests go through `createBuildQueue`: previews coalesce to the newest,
 * exports queue in order and are never dropped. See that module for why the
 * queue has to yield to the message loop to coalesce at all.
 */

import { buildChip, type BuildResult, type ChipPiece } from '../lib/cad/buildChip';
import { creasedRenderMesh, type RenderMesh } from '../lib/cad/creasedMesh';
import { loadManifold } from '../lib/cad/manifoldRuntime';
import { createBuildQueue } from './buildQueue';
import type { ChannelGraph, ChipParams, DrainageVent } from '../types/project';

export interface CadRequest {
  seq: number;
  /** An export is waited on and never coalesced away; a preview may be. */
  kind: 'preview' | 'export';
  graph: ChannelGraph;
  chipParams: ChipParams;
  quality: number;
  /** Drainage holes to drill into the cavity. */
  drainageVents?: DrainageVent[];
  /** Also return the cavity as a solid, for the viewport's isolate mode. */
  includeChannelSolid?: boolean;
}

export interface CadPiecePayload {
  id: BuildResult['pieces'][number]['id'];
  label: string;
  positions: Float32Array;
  indices: Uint32Array;
  volumeMm3: number;
  /**
   * The same surface ready to draw, with creased normals. Preview builds only:
   * an export is written from `positions` and `indices` and never drawn.
   */
  render?: RenderMesh;
}

export type CadResponse =
  | { type: 'ready' }
  | {
      type: 'result';
      seq: number;
      pieces: CadPiecePayload[];
      /** The cavity as a solid, when the request asked for it. */
      channelSolid: CadPiecePayload | null;
      /** The glass slide, on a slide chip. Preview only — never exported. */
      slideSolid: CadPiecePayload | null;
      stats: BuildResult['stats'];
      warnings: string[];
      elapsedMs: number;
    }
  | { type: 'error'; seq: number; message: string };

/**
 * `self` types as `Window` under the DOM lib, whose `postMessage` has a
 * different signature and rejects a transfer list. Narrowing it here beats
 * adding the WebWorker lib globally, which would then wrongly offer worker
 * globals to every DOM module in the app.
 */
const ctx = self as unknown as {
  postMessage(message: CadResponse, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<CadRequest>) => void): void;
};

async function build(request: CadRequest): Promise<void> {
  const started = performance.now();
  try {
    const api = await loadManifold();
    const result = buildChip(api, request.graph, request.chipParams, {
      quality: request.quality,
      drainageVents: request.drainageVents,
      includeChannelSolid: request.includeChannelSolid,
    });

    // Sent even if a newer preview has arrived meanwhile: that one is next in
    // line, and until it lands this result is still nearer the truth than
    // what is on screen. The store drops anything older than it has shown.
    const transfers: ArrayBufferLike[] = [];
    const preview = request.kind === 'preview';
    const payload = (piece: ChipPiece, crease: boolean): CadPiecePayload => {
      const out: CadPiecePayload = { ...piece };
      transfers.push(piece.positions.buffer, piece.indices.buffer);
      if (crease) {
        out.render = creasedRenderMesh(piece.positions, piece.indices);
        transfers.push(out.render.positions.buffer, out.render.normals.buffer);
      }
      return out;
    };

    const message: CadResponse = {
      type: 'result',
      seq: request.seq,
      pieces: result.pieces.map((piece) => payload(piece, preview)),
      channelSolid: result.channelSolid ? payload(result.channelSolid, preview) : null,
      // The glass is a box; the viewport's plain vertex normals suit it.
      slideSolid: result.slideSolid ? payload(result.slideSolid, false) : null,
      stats: result.stats,
      warnings: result.warnings,
      elapsedMs: performance.now() - started,
    };
    ctx.postMessage(message, transfers as Transferable[]);
  } catch (error) {
    const message: CadResponse = {
      type: 'error',
      seq: request.seq,
      message: error instanceof Error ? error.message : String(error),
    };
    ctx.postMessage(message);
  }
}

const queue = createBuildQueue(build);

ctx.addEventListener('message', (event) => queue.push(event.data));

// Warm the WASM up front so the first real request is not paying for it.
void loadManifold().then(() => {
  const ready: CadResponse = { type: 'ready' };
  ctx.postMessage(ready);
});
