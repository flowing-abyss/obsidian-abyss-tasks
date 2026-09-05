import { Notice, requireApiVersion } from 'obsidian';
import type { TaskApplicationApi, TaskCommand, TaskCommandResult } from '../tasks';
import { presentTaskCommandResult } from './taskCommandResult';

export interface TaskUndoSpec {
  readonly message: string;
  readonly execute: () => Promise<TaskCommandResult>;
}

export function presentTaskUndoNotice(spec: TaskUndoSpec): Notice {
  const ownerDocument = activeDocument;
  const invoking = ownerDocument.activeElement;
  const restoreFocus = invoking?.closest<HTMLElement>('.abyss-subtask-row') ?? invoking;
  const fragment = ownerDocument.adoptNode(createFragment());
  fragment.append(ownerDocument.createTextNode(`${spec.message} `));
  const action = fragment.createEl('button', {
    cls: 'mod-cta',
    text: 'Undo',
    attr: { type: 'button' },
  });
  const notice = new Notice(fragment, 8_000);
  // Older supported Obsidian versions expose the fragment action, but no containerEl.
  const button = requireApiVersion('1.8.7')
    ? (notice.containerEl.querySelector<HTMLButtonElement>('button') ?? action)
    : action;
  let inFlight = false;
  const undo = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    button.disabled = true;
    const result = await spec.execute();
    notice.hide();
    if (result.type !== 'ok') {
      presentTaskCommandResult(result);
      return;
    }
    const ownerWindow = ownerDocument.defaultView;
    if (
      ownerWindow !== null &&
      restoreFocus instanceof ownerWindow.HTMLElement &&
      restoreFocus.isConnected
    ) {
      if (!restoreFocus.hasAttribute('tabindex')) restoreFocus.tabIndex = -1;
      restoreFocus.focus({ preventScroll: true });
    }
  };
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    undo().catch((error: unknown) => {
      notice.hide();
      console.error('[abyss-tasks] Undo failed', { operation: 'undo', cause: error });
      presentTaskCommandResult({ type: 'io-error', cause: 'undo-error', contentState: 'unknown' });
    });
  });
  return notice;
}

export function presentTaskMutationResult(
  tasks: TaskApplicationApi,
  result: TaskCommandResult,
): void {
  if (result.type !== 'ok') {
    presentTaskCommandResult(result);
    return;
  }
  if (!result.changed) return;
  const inverse = mutationInverse(result);
  if (inverse !== undefined) {
    presentTaskUndoNotice({
      message: inverse.message,
      execute: () => tasks.execute(inverse.command),
    });
  }
}

function mutationInverse(
  result: Extract<TaskCommandResult, { readonly type: 'ok' }>,
): { readonly message: string; readonly command: TaskCommand } | undefined {
  const { outcome } = result;
  if (outcome.type === 'task' && outcome.subtaskRemovalRecovery !== undefined) {
    return {
      message: 'Sub-task deleted.',
      command: { type: 'restore-subtask', ...outcome.subtaskRemovalRecovery },
    };
  }
  if (outcome.type !== 'dependency') return undefined;
  if (outcome.change === 'added') {
    return {
      message: 'Dependency added.',
      command: {
        type: 'remove-dependency',
        dependent: outcome.dependent.target,
        dependencyId: outcome.dependencyId,
      },
    };
  }
  if (outcome.change === 'removed' && outcome.removalRecovery !== undefined) {
    return {
      message: 'Dependency removed.',
      command: {
        type: 'restore-dependency',
        dependent: outcome.dependent.target,
        recovery: outcome.removalRecovery,
      },
    };
  }
  return undefined;
}
