/**
 * CAD state: the current solid, and the worker that produces it.
 *
 * The worker is created lazily on first use — a user who never opens the CAD
 * tab should not pay to instantiate a WASM heap.
 */

import { create } from 'zustand';
import type { BuildResult } from '../lib/cad/buildChip';
import type { CadPiecePayload, CadRequest, CadResponse } from '../workers/cadWorker';
import type { ChannelGraph, ChipParams, DrainageVent } from '../types/project';

export type DisplayMode = 'solid' | 'wireframe' | 'xray';

export interface CadModel {
  pieces: CadPiecePayload[];
  /** The fluid path as a solid. Present on preview builds, never on exports. */
  channelSolid: CadPiecePayload | null;
  slideSolid: CadPiecePayload | null;
  stats: BuildResult['stats'];
  warnings: string[];
  elapsedMs: number;
}

interface CadState {
  model: CadModel | null;
  /** True from the moment a rebuild is requested until its result lands. */
  building: boolean;
  /** True until the WASM has finished loading in the worker. */
  booting: boolean;
  error: string | null;

  displayMode: DisplayMode;
  setDisplayMode: (mode: DisplayMode) => void;
  exploded: boolean;
  toggleExploded: () => void;

  /**
   * X-ray only: hide the block and show the fluid path on its own.
   *
   * Lives here rather than in the viewport because the toolbar owns the
   * controls and the viewport owns the scene, and neither is the other's
   * parent.
   */
  isolateChannels: boolean;
  toggleIsolateChannels: () => void;
  /**
   * How the isolated channels are drawn. Opaque reads the shape best and is the
   * default; transparent lets crossing runs and buried chambers show through
   * the runs in front of them.
   */
  channelsOpaque: boolean;
  setChannelsOpaque: (opaque: boolean) => void;

  /**
   * Which projection the viewport camera is currently rendering with.
   *
   * The camera itself lives in the viewport (it owns the Three.js scene); this
   * is a read model so the toolbar's toggle can show which one is active
   * without reaching into imperative viewport internals. The viewport is the
   * only writer — it mirrors this whenever it actually swaps cameras, whether
   * from the toggle, an axis snap, or the user orbiting out of an axis view.
   */
  projection: 'perspective' | 'orthographic';
  setProjection: (projection: 'perspective' | 'orthographic') => void;

  /**
   * How the presentation export reaches the 3D viewport.
   *
   * Registered by the CAD view while it is mounted and cleared when it leaves,
   * because a WebGL context that is not on screen has nothing to read back. The
   * exporter falls back to the newest saved snapshot when this is null, and
   * says so rather than quietly dropping the panel.
   */
  snapshotProvider: ((scale: number) => string | null) | null;
  setSnapshotProvider: (provider: ((scale: number) => string | null) | null) => void;

  /** Requests a rebuild. Safe to call on every keystroke — the worker coalesces. */
  requestBuild: (
    graph: ChannelGraph,
    chipParams: ChipParams,
    quality?: number,
    drainageVents?: DrainageVent[],
  ) => void;
  /** One-off high-quality build, for export. Does not disturb the preview. */
  buildForExport: (
    graph: ChannelGraph,
    chipParams: ChipParams,
    drainageVents?: DrainageVent[],
  ) => Promise<CadModel>;
  dispose: () => void;
}

let worker: Worker | null = null;
let seq = 0;
/**
 * Highest sequence number already shown.
 *
 * The preview issues two builds per edit — a coarse one to keep up with a drag
 * and a refined one once it stops — so more than one can be in flight. Without
 * this, a coarse build that finished late would overwrite the finer result that
 * had already landed, and the view would quietly degrade after settling.
 */
let appliedSeq = 0;
/** Resolvers for `buildForExport`, keyed by sequence number. */
const exportWaiters = new Map<number, { resolve: (m: CadModel) => void; reject: (e: Error) => void }>();

function ensureWorker(set: (partial: Partial<CadState>) => void): Worker {
  if (worker) return worker;

  worker = new Worker(new URL('../workers/cadWorker.ts', import.meta.url), { type: 'module' });

  worker.addEventListener('message', (event: MessageEvent<CadResponse>) => {
    const data = event.data;

    if (data.type === 'ready') {
      set({ booting: false });
      return;
    }

    if (data.type === 'error') {
      const waiter = exportWaiters.get(data.seq);
      if (waiter) {
        exportWaiters.delete(data.seq);
        waiter.reject(new Error(data.message));
        return;
      }
      set({ building: false, error: data.message });
      return;
    }

    const model: CadModel = {
      pieces: data.pieces,
      channelSolid: data.channelSolid,
      slideSolid: data.slideSolid,
      stats: data.stats,
      warnings: data.warnings,
      elapsedMs: data.elapsedMs,
    };

    const waiter = exportWaiters.get(data.seq);
    if (waiter) {
      exportWaiters.delete(data.seq);
      waiter.resolve(model);
      return;
    }

    if (data.seq < appliedSeq) return;
    appliedSeq = data.seq;

    // Still building while a newer request is outstanding, so the indicator
    // does not blink off between the coarse pass and the refined one.
    set({ model, building: data.seq < seq, error: null, booting: false });
  });

  worker.addEventListener('error', (event) => {
    set({ building: false, booting: false, error: event.message || 'The CAD worker failed.' });
  });

  return worker;
}

export const useCadStore = create<CadState>()((set) => ({
  model: null,
  building: false,
  booting: true,
  error: null,

  displayMode: 'solid',
  setDisplayMode: (displayMode) => set({ displayMode }),
  exploded: false,
  toggleExploded: () => set((state) => ({ exploded: !state.exploded })),
  isolateChannels: false,
  toggleIsolateChannels: () => set((state) => ({ isolateChannels: !state.isolateChannels })),
  channelsOpaque: true,
  setChannelsOpaque: (channelsOpaque) => set({ channelsOpaque }),

  projection: 'perspective',
  setProjection: (projection) => set({ projection }),

  snapshotProvider: null,
  setSnapshotProvider: (snapshotProvider) => set({ snapshotProvider }),

  requestBuild: (graph, chipParams, quality = 1, drainageVents = []) => {
    const w = ensureWorker(set);
    seq += 1;
    set({ building: true, error: null });
    // Always built for the preview, so toggling isolate mode is instant rather
    // than a round trip through the WASM. It is the same cavity the subtraction
    // already produced, so the extra cost is one mesh extraction.
    const request: CadRequest = {
      seq,
      kind: 'preview',
      graph,
      chipParams,
      quality,
      drainageVents,
      includeChannelSolid: true,
    };
    w.postMessage(request);
  },

  buildForExport: (graph, chipParams, drainageVents = []) =>
    new Promise<CadModel>((resolve, reject) => {
      const w = ensureWorker(set);
      seq += 1;
      // Captured: by the time the timeout fires `seq` has moved on, and it
      // must give up on this export, not whichever request came last.
      const id = seq;
      exportWaiters.set(id, { resolve, reject });
      // No channel solid: an export is a printable part, and the cavity is the
      // absence of one.
      const request: CadRequest = {
        seq: id,
        kind: 'export',
        graph,
        chipParams,
        quality: 2,
        drainageVents,
        includeChannelSolid: false,
      };
      w.postMessage(request);

      // A build that never returns would leave the export button spinning.
      setTimeout(() => {
        if (exportWaiters.delete(id)) reject(new Error('The export build timed out.'));
      }, 60_000);
    }),

  dispose: () => {
    worker?.terminate();
    worker = null;
    exportWaiters.clear();
    appliedSeq = 0;
    seq = 0;
    set({ model: null, booting: true });
  },
}));
