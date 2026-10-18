import { useEffect } from 'react';
import { toast } from 'sonner';
import { edgesWithinNodes } from '../lib/hitTest';
import {
  extractFragment,
  pasteFragment,
  setCurveType,
  type GraphFragment,
} from '../lib/graphOps';
import { useEditorStore } from '../store/editorStore';
import { useProjectStore } from '../store/projectStore';

/**
 * Editing shortcuts for the Draw tab.
 *
 * Registered on the window rather than the canvas so they still work while the
 * user's focus is in an inspector field — with the exception that typing into a
 * field must never be hijacked, which is what the `typing` guard protects.
 *
 * Delete, Escape and Enter deliberately stay in `DrawCanvas`: they act on the
 * in-progress draw session, which is the canvas's own state, and splitting them
 * across two listeners would mean two places to reason about a keystroke.
 */
export function useDrawShortcuts() {
  const setTool = useEditorStore((s) => s.setTool);
  const setClipboard = useEditorStore((s) => s.setClipboard);
  const setSelection = useEditorStore((s) => s.setSelection);
  const bumpPaste = useEditorStore((s) => s.bumpPaste);
  const toggleGrid = useEditorStore((s) => s.toggleGrid);
  const toggleTaper = useEditorStore((s) => s.toggleTaper);
  const undo = useProjectStore((s) => s.undo);
  const redo = useProjectStore((s) => s.redo);
  const updateGraph = useProjectStore((s) => s.updateGraph);

  useEffect(() => {
    /** Drops a fragment into the graph offset from the original and selects it. */
    const paste = (fragment: GraphFragment) => {
      const { pasteCount } = useEditorStore.getState();
      // Cascade successive pastes so a second one is not hidden under the first.
      const step = 2 * (pasteCount + 1);
      const result = pasteFragment(
        useProjectStore.getState().project.channelGraph,
        fragment,
        { x: step, y: -step },
      );
      updateGraph(() => result.graph, { label: 'paste' });
      bumpPaste();
      setSelection({
        nodeIds: result.nodeIds,
        edgeIds: edgesWithinNodes(result.graph, result.nodeIds),
      });
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) || target?.isContentEditable;

      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();

      if (mod && key === 'z') {
        // Undo works even from a field: it is the one shortcut users expect
        // everywhere, and the field's own undo is not what they mean here.
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }

      if (typing) return;

      const { selection } = useEditorStore.getState();
      const graph = useProjectStore.getState().project.channelGraph;

      if (mod) {
        switch (key) {
          case 'c': {
            if (selection.nodeIds.length === 0) return;
            event.preventDefault();
            setClipboard(extractFragment(graph, selection.nodeIds));
            return;
          }

          case 'v': {
            const { clipboard } = useEditorStore.getState();
            if (!clipboard) return;
            event.preventDefault();
            paste(clipboard);
            return;
          }

          case 'd': {
            if (selection.nodeIds.length === 0) return;
            event.preventDefault();
            // Duplicate is copy-and-paste that does not disturb the clipboard —
            // a user who duplicates a chamber has not agreed to lose whatever
            // they copied five minutes ago.
            paste(extractFragment(graph, selection.nodeIds));
            return;
          }

          case 'a': {
            event.preventDefault();
            setSelection({
              nodeIds: graph.nodes.map((node) => node.id),
              edgeIds: graph.edges.map((edge) => edge.id),
            });
            return;
          }

          default:
            return;
        }
      }

      switch (key) {
        case 'v':
          setTool('select');
          break;

        case 'p':
          setTool('draw');
          break;

        case 'd':
          setTool('dimension');
          break;

        case 'g':
          toggleGrid();
          break;

        case 't':
          toggleTaper();
          break;

        case 'b': {
          if (selection.edgeIds.length === 0) {
            toast('Select a segment first', {
              description: 'B switches the selected segments between straight and curved.',
            });
            return;
          }
          // The whole selection follows the first segment rather than each
          // flipping independently, so pressing B twice is a no-op instead of
          // scrambling a mixed selection.
          const first = graph.edges.find((edge) => edge.id === selection.edgeIds[0]);
          const next = first?.curveType === 'bezier' ? 'straight' : 'bezier';
          updateGraph(
            (current) =>
              selection.edgeIds.reduce(
                (accumulated, id) => setCurveType(accumulated, id, next),
                current,
              ),
            { label: 'curve type' },
          );
          break;
        }

        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    bumpPaste,
    redo,
    setClipboard,
    setSelection,
    setTool,
    toggleGrid,
    toggleTaper,
    undo,
    updateGraph,
  ]);
}
