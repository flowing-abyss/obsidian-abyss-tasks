import { Notice, TFile, type App } from 'obsidian';
import type { ProjectManager } from '../projects/ProjectManager';
import { withFailureCause } from '../projects/projectCreation';
import { isProjectEditValidationError } from '../projects/projectEditError';

/** A validation message as it is; otherwise the status sentence and its cause. */
export function projectStatusFailureNotice(error: unknown): string {
  return isProjectEditValidationError(error)
    ? error.message
    : withFailureCause('Could not change the project status.', error);
}

/** Sets a status from a menu without inline feedback; a failure raises one Notice. */
export async function changeProjectStatus(
  manager: Pick<ProjectManager, 'setStatus'>,
  change: { readonly path: string; readonly statusId: string },
  onChanged: () => void,
): Promise<void> {
  try {
    await manager.setStatus(change.path, change.statusId);
  } catch (error) {
    if (!isProjectEditValidationError(error)) {
      console.error('[abyss-tasks] Could not change the project status', {
        ...change,
        cause: error,
      });
    }
    new Notice(projectStatusFailureNotice(error));
    return;
  }
  onChanged();
}

/** Opens a project's note in the current leaf; a missing note or a failed open raises a Notice. */
export async function openProjectNote(app: App, path: string): Promise<void> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) {
    new Notice(`Could not find ${path}.`);
    return;
  }
  try {
    await app.workspace.getLeaf(false).openFile(file);
  } catch (error) {
    console.error('[abyss-tasks] Could not open the project note', { path, error });
    new Notice(withFailureCause(`Could not open ${path}.`, error));
  }
}
