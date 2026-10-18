/**
 * File-action semantics.
 *
 * These assert the differences between the three ways to write a project out,
 * because the differences are invisible in the UI and expensive when wrong: a
 * "copy" that quietly re-points the open project would send the user's next
 * Save — and every one after it — into the snapshot instead of the file they
 * think they are editing, and they would not find out until they reopened the
 * original and found their work missing.
 *
 * Storage is swapped through `setProjectStorage`, the seam that exists so the
 * store never has to touch a real file picker.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it, vi } from 'vitest';
import type { ProjectStorage, SaveOptions } from '../lib/fileAccess';
import { draftWithoutImages, setProjectStorage, useProjectStore } from './projectStore';

/** Stands in for a File System Access handle. Identity is all that matters. */
const originalHandle = { name: 'original.openchip' } as never;

let calls: SaveOptions[] = [];

/** What the stand-in picker "chooses", distinct from what was suggested. */
const CHOSEN = 'wherever-the-user-chose.openchip';

const recordingStorage: ProjectStorage = {
  async save(_text, options) {
    calls.push(options);
    // A picker returns the file the user picked, which is generally not the
    // suggested name. Echoing the suggestion back would make re-pointing
    // invisible and these assertions vacuous.
    const name = options.promptForLocation ? CHOSEN : (options.target?.name ?? options.suggestedName);
    return {
      status: 'saved',
      target: { handle: null, name },
      inPlace: !options.promptForLocation && Boolean(options.target),
    };
  },
  async open() {
    return { status: 'cancelled' };
  },
};

beforeEach(() => {
  calls = [];
  setProjectStorage(recordingStorage);

  // A project open in a file, edited since, and renamed in the UI since — the
  // case Save a Copy exists for.
  useProjectStore.getState().newProject();
  useProjectStore.setState({
    fileTarget: { handle: originalHandle, name: 'original.openchip' },
    fileName: 'original.openchip',
    isDirty: true,
    lastSavedAt: null,
  });
  useProjectStore.getState().setProjectName('Mixer study v3 (final!)');
});

describe('saving a copy', () => {
  it('names the file from the project title, not the file it is open in', async () => {
    await useProjectStore.getState().saveProject('copy');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].suggestedName, 'Mixer-study-v3-final.openchip');
  });

  it('asks for a location and never reuses the open file handle', async () => {
    await useProjectStore.getState().saveProject('copy');

    assert.equal(calls[0].promptForLocation, true);
    // Passing the handle through would overwrite the file being edited, which
    // is the one outcome a copy must never produce.
    assert.equal(calls[0].target, null);
  });

  it('leaves the open project, its handle and its unsaved state untouched', async () => {
    const before = useProjectStore.getState();
    await useProjectStore.getState().saveProject('copy');
    const after = useProjectStore.getState();

    assert.equal(after.fileName, 'original.openchip', 'the copy must not become the open file');
    assert.equal(after.fileTarget?.handle, originalHandle);
    // The copy is not a save of this file: the work still is not in it.
    assert.equal(after.isDirty, true);
    assert.equal(after.lastSavedAt, before.lastSavedAt);
  });

  it('leaves the next plain Save writing to the original file', async () => {
    await useProjectStore.getState().saveProject('copy');
    await useProjectStore.getState().saveProject();

    assert.equal(calls.length, 2);
    assert.equal(calls[1].suggestedName, 'original.openchip');
    assert.equal(calls[1].promptForLocation, false);
    assert.equal(calls[1].target?.handle, originalHandle);
    assert.equal(useProjectStore.getState().isDirty, false);
  });
});

describe('saving as', () => {
  it('re-points the project at the chosen file, which is what a copy must not do', async () => {
    await useProjectStore.getState().saveProject('save-as');

    assert.equal(calls[0].promptForLocation, true);
    // Save As opens on the name the project already has, not on its title.
    assert.equal(calls[0].suggestedName, 'original.openchip');
    assert.equal(useProjectStore.getState().fileName, CHOSEN);
    assert.equal(useProjectStore.getState().isDirty, false);
  });
});

describe('gesture history', () => {
  const addNode = (id: string) =>
    useProjectStore.getState().updateGraph(
      (g) => ({ ...g, nodes: [...g.nodes, { id, x: 1, y: 1, type: 'waypoint' as const }] }),
      { label: 'add' },
    );
  const moveAll = (dx: number) =>
    useProjectStore.getState().updateGraph(
      (g) => ({ ...g, nodes: g.nodes.map((n) => ({ ...n, x: n.x + dx })) }),
      { commit: false },
    );
  const depths = () => {
    const { undoDepth, redoDepth } = useProjectStore.getState();
    return [undoDepth, redoDepth];
  };

  it('leaves history and redo alone for a press that never moves', () => {
    const store = useProjectStore.getState();
    addNode('a');
    addNode('b');
    store.undo();
    assert.deepEqual(depths(), [1, 1]);

    // A plain click on a node: begin, no update, end.
    store.beginGraphEdit('move nodes');
    store.endGraphEdit();
    assert.deepEqual(depths(), [1, 1], 'the click cost the user their redo');

    store.redo();
    assert.equal(useProjectStore.getState().project.channelGraph.nodes.length, 2);
  });

  it('collapses a drag into one undo step back to where it started', () => {
    const store = useProjectStore.getState();
    addNode('a');
    const before = useProjectStore.getState().project.channelGraph;

    store.beginGraphEdit('move nodes');
    moveAll(1);
    moveAll(1);
    moveAll(1);
    store.endGraphEdit();
    assert.deepEqual(depths(), [2, 0]);
    assert.equal(useProjectStore.getState().project.channelGraph.nodes[0].x, 4);

    store.undo();
    assert.equal(useProjectStore.getState().project.channelGraph, before);
  });
});

describe('the draft without images', () => {
  it('keeps the design and counts what it dropped', () => {
    const image = {
      id: 'img',
      kind: 'cad-snapshot' as const,
      label: 'shot',
      createdAt: '2026-09-23T00:00:00Z',
      mimeType: 'image/png',
      data: `data:image/png;base64,${'A'.repeat(10_000)}`,
    };
    useProjectStore.getState().addSavedImage(image);
    useProjectStore.getState().addSavedImage({ ...image, id: 'img2' });
    const project = useProjectStore.getState().project;
    const full = JSON.stringify({ state: { project }, version: 0 });

    const shrunk = draftWithoutImages(full);
    assert.ok(shrunk && shrunk.length < 2_000);
    const parsed = JSON.parse(shrunk);
    assert.deepEqual(parsed.state.project.savedImages, []);
    assert.equal(parsed.state.project.meta.name, project.meta.name);
    assert.equal(parsed.state.draftOmittedImages, 2);
  });

  it('has nothing to offer when there are no images to drop', () => {
    const project = useProjectStore.getState().project;
    assert.equal(draftWithoutImages(JSON.stringify({ state: { project }, version: 0 })), null);
  });
});

describe('number-field edits', () => {
  const setX = (x: number) =>
    useProjectStore
      .getState()
      .updateGraph((g) => ({ ...g, nodes: g.nodes.map((n) => ({ ...n, x })) }), { label: 'move' });

  it('makes a typed value one undo step, however many keystrokes it took', () => {
    const store = useProjectStore.getState();
    store.updateGraph((g) => ({ ...g, nodes: [{ id: 'n', x: 0, y: 0, type: 'waypoint' as const }] }));
    const before = useProjectStore.getState().undoDepth;

    // Focus, type "12.5" (1, 12, 12.5 are valid along the way), blur.
    store.beginGraphEdit();
    setX(1);
    setX(12);
    setX(12.5);
    store.endGraphEdit();

    assert.equal(useProjectStore.getState().undoDepth, before + 1);
    store.undo();
    assert.equal(useProjectStore.getState().project.channelGraph.nodes[0].x, 0);
  });

  it('puts the design back on Escape, with nothing left to redo', () => {
    const store = useProjectStore.getState();
    store.updateGraph((g) => ({ ...g, nodes: [{ id: 'n', x: 3, y: 0, type: 'waypoint' as const }] }));
    const baseline = useProjectStore.getState().project.channelGraph;
    const depth = useProjectStore.getState().undoDepth;

    store.beginGraphEdit();
    setX(4);
    setX(45);
    store.cancelGraphEdit();

    assert.equal(useProjectStore.getState().project.channelGraph, baseline);
    assert.equal(useProjectStore.getState().undoDepth, depth);
    assert.equal(useProjectStore.getState().redoDepth, 0);
  });
});

describe('draft persistence', () => {
  it('serialises the draft once per flush, not once per update', () => {
    vi.useFakeTimers();
    try {
      const store = useProjectStore.getState();
      store.updateGraph((g) => ({
        ...g,
        nodes: [...g.nodes, { id: 'drag', x: 0, y: 0, type: 'waypoint' as const }],
      }));
      vi.advanceTimersByTime(1000);

      const stringify = vi.spyOn(JSON, 'stringify');
      for (let i = 0; i < 50; i += 1) {
        store.updateGraph(
          (g) => ({ ...g, nodes: g.nodes.map((n) => ({ ...n, x: n.x + 0.1 })) }),
          { commit: false },
        );
      }
      assert.equal(stringify.mock.calls.length, 0, 'a drag frame paid for a stringify');

      vi.advanceTimersByTime(500);
      assert.equal(stringify.mock.calls.length, 1);
      stringify.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('restoring a draft written by an older build', () => {
  const merge = useProjectStore.persist.getOptions().merge!;

  it('defaults fields the draft predates, nested ones included', () => {
    const current = useProjectStore.getState();
    const old = structuredClone(current.project) as unknown as Record<string, unknown>;
    delete old.drainageVents;
    const chipParams = old.chipParams as { slide: Record<string, unknown> };
    delete chipParams.slide.bondGapMm;

    const merged = merge({ project: old, isDirty: true }, current) as typeof current;
    assert.deepEqual(merged.project.drainageVents, []);
    assert.equal(typeof merged.project.chipParams.slide.bondGapMm, 'number');
    assert.equal(merged.isDirty, true);
  });

  it('sets aside a draft that cannot be repaired instead of loading it', () => {
    const current = useProjectStore.getState();
    const broken = structuredClone(current.project);
    broken.channelGraph = {
      nodes: [],
      edges: [
        { id: 'e', fromNodeId: 'gone', toNodeId: 'also-gone', curveType: 'straight', crossSection: 'rect', dimensionPoints: [] },
      ],
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const merged = merge({ project: broken, isDirty: true }, current) as typeof current;
    assert.equal(merged.project, current.project);
    assert.equal(warn.mock.calls.length, 1);
    warn.mockRestore();
  });
});

describe('fluids before any are stored', () => {
  it('edits the built-in list the Fluid tab is showing', () => {
    const store = useProjectStore.getState();
    useProjectStore.setState({ project: { ...store.project, fluidProfiles: [] } });
    assert.equal(useProjectStore.getState().project.fluidProfiles.length, 0);

    useProjectStore.getState().updateFluidProfile('preset-water', { name: 'Tap water' });

    const profiles = useProjectStore.getState().project.fluidProfiles;
    assert.ok(profiles.length > 1, 'the whole preset list is stored, not just the edit');
    assert.equal(profiles.find((f) => f.id === 'preset-water')?.name, 'Tap water');
  });
});
