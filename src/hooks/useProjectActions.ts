import { useCallback } from 'react';
import { toast } from 'sonner';
import { canSaveInPlace } from '../lib/fileAccess';
import { useProjectStore, type OpenResult } from '../store/projectStore';
import { useUiStore } from '../store/uiStore';

/**
 * The project menu's behaviour, in one place.
 *
 * Wraps the store's file actions with the two things a store should not own:
 * user-facing feedback, and the "you have unsaved work" gate in front of any
 * action that would discard the open project.
 */
export function useProjectActions() {
  const newProject = useProjectStore((state) => state.newProject);
  const openProjectFromDisk = useProjectStore((state) => state.openProject);
  const openProjectText = useProjectStore((state) => state.openProjectText);
  const saveProjectToDisk = useProjectStore((state) => state.saveProject);
  const requestConfirm = useUiStore((state) => state.requestConfirm);

  /** Returns true when it is safe to throw away the current project. */
  const confirmDiscard = useCallback(
    async (action: string) => {
      const { isDirty, project } = useProjectStore.getState();
      if (!isDirty) return true;
      return requestConfirm({
        title: 'Discard unsaved changes?',
        message: `“${project.meta.name}” has changes that haven't been saved to a file. ${action} will discard them.`,
        confirmLabel: 'Discard and continue',
        destructive: true,
      });
    },
    [requestConfirm],
  );

  const save = useCallback(
    async ({ saveAs = false }: { saveAs?: boolean } = {}) => {
      const result = await saveProjectToDisk(saveAs ? 'save-as' : 'save');

      switch (result.status) {
        case 'saved':
          toast.success(result.inPlace ? 'Project saved' : `Saved to ${result.fileName}`);
          break;
        case 'downloaded':
          toast.success(`Downloaded ${result.fileName}`, {
            description: canSaveInPlace()
              ? undefined
              : 'Your browser cannot write files in place, so each save downloads a new copy. Chrome or Edge can save over the same file.',
          });
          break;
        case 'error':
          toast.error("Couldn't save the project", { description: result.message });
          break;
        case 'cancelled':
          break;
      }

      return result;
    },
    [saveProjectToDisk],
  );

  /**
   * Writes a detached snapshot of the project, named from its title.
   *
   * Deliberately quieter about the file system than `save`: the copy is not
   * the file the user is working in, so there is nothing to say about in-place
   * writes or handles. What matters is where it landed and that the open
   * project is untouched.
   */
  const saveCopy = useCallback(async () => {
    const result = await saveProjectToDisk('copy');

    switch (result.status) {
      case 'saved':
      case 'downloaded':
        toast.success(`Copy saved as ${result.fileName}`, {
          description: 'Your open project is unchanged — Save still writes to the original file.',
        });
        break;
      case 'error':
        toast.error("Couldn't save a copy", { description: result.message });
        break;
      case 'cancelled':
        break;
    }

    return result;
  }, [saveProjectToDisk]);

  const open = useCallback(async () => {
    if (!(await confirmDiscard('Opening another project'))) return;
    return reportOpen(await openProjectFromDisk());
  }, [confirmDiscard, openProjectFromDisk]);

  /** Opens a file the user dropped rather than picked, with the same gate and feedback. */
  const openFile = useCallback(
    async (file: File) => {
      if (!(await confirmDiscard('Opening another project'))) return;
      return reportOpen(openProjectText(await file.text(), file.name));
    },
    [confirmDiscard, openProjectText],
  );

  const create = useCallback(async () => {
    if (!(await confirmDiscard('Starting a new project'))) return;
    newProject();
    toast.success('New project started');
  }, [confirmDiscard, newProject]);

  return { create, open, openFile, save, saveCopy, confirmDiscard };
}

/** The toast for each way an open can end, shared by picking and dropping a file. */
function reportOpen(result: OpenResult): OpenResult {
  switch (result.status) {
    case 'opened':
      toast.success(`Opened “${result.projectName}”`);
      // Forward-compatibility notes and the like: worth showing, not worth
      // stopping for.
      for (const warning of result.warnings) {
        toast.warning('Note about this file', { description: warning, duration: 8000 });
      }
      break;
    case 'invalid':
      toast.error(result.message, {
        description: result.details.join(' '),
        duration: 12_000,
      });
      break;
    case 'error':
      toast.error("Couldn't read that file", { description: result.message });
      break;
    case 'cancelled':
      break;
  }
  return result;
}
