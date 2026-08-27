import { Notice, type App } from 'obsidian';
import {
  parseRecurrenceRule,
  type TaskApplicationApi,
  type TaskCommandResult,
  type TaskSnapshot,
} from '../tasks';
import { noInteractionOwnership, type InteractionOwnershipPort } from './interactionOwnership';
import { TaskMoveRecoveryModal } from './TaskMoveRecoveryModal';

interface CompletionConfirmationTask {
  readonly status: string;
  readonly recurrence?: string;
  readonly onCompletion: 'keep' | 'delete';
}

let dismissActiveCompletionConfirmation: (() => void) | undefined;

export function requestTaskCompletion(
  task: CompletionConfirmationTask,
  onConfirm: () => void | Promise<unknown>,
  interactionOwnership: InteractionOwnershipPort = noInteractionOwnership,
  teardownSignal?: AbortSignal,
): Promise<void> {
  const recurrence = task.recurrence;
  if (
    task.status === 'done' ||
    task.onCompletion !== 'delete' ||
    recurrence === undefined ||
    parseRecurrenceRule(recurrence).type === 'valid'
  ) {
    try {
      return Promise.resolve(onConfirm()).then(() => undefined);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
  if (teardownSignal?.aborted) return Promise.resolve();

  const ownerDocument = activeDocument;
  const ownerWindow = ownerDocument.defaultView;
  const isOwnerHTMLElement = (element: Element | null): element is HTMLElement =>
    ownerWindow !== null && element instanceof ownerWindow.HTMLElement;

  return new Promise<void>((resolve, reject) => {
    dismissActiveCompletionConfirmation?.();
    const previousFocus = ownerDocument.activeElement;
    const ownershipToken = interactionOwnership.acquire({ blocksShortcuts: true });
    const surface = ownerDocument.body.createDiv({
      cls: 'abyss-recurrence-delete-confirm',
      attr: {
        role: 'alertdialog',
        'aria-modal': 'true',
        'aria-labelledby': 'abyss-recurrence-delete-confirm-title',
        'aria-describedby': 'abyss-recurrence-delete-confirm-description',
      },
    });
    const dialog = surface.createDiv({ cls: 'abyss-recurrence-delete-confirm-dialog' });
    dialog.createEl('h3', {
      cls: 'abyss-recurrence-delete-confirm-title',
      text: 'Delete completed task?',
      attr: { id: 'abyss-recurrence-delete-confirm-title' },
    });
    dialog.createEl('p', {
      cls: 'abyss-recurrence-delete-confirm-description',
      text: 'The complete task and its sub-tasks will be deleted. No next occurrence will be created.',
      attr: { id: 'abyss-recurrence-delete-confirm-description' },
    });
    const actions = dialog.createDiv({ cls: 'abyss-recurrence-delete-confirm-actions' });
    const cancel = actions.createEl('button', { text: 'Cancel', attr: { type: 'button' } });
    const confirm = actions.createEl('button', {
      cls: 'mod-warning abyss-recurrence-delete-confirm-button',
      text: 'Delete completed task',
      attr: { type: 'button' },
    });

    let removed = false;
    const remove = (): boolean => {
      if (removed) return false;
      removed = true;
      surface.remove();
      ownerDocument.removeEventListener('keydown', onKeyDown, true);
      teardownSignal?.removeEventListener('abort', onTeardown);
      ownershipToken.release();
      if (dismissActiveCompletionConfirmation === dismiss) {
        dismissActiveCompletionConfirmation = undefined;
      }
      return true;
    };
    const cancelCompletion = (restoreFocus: boolean): void => {
      if (!remove()) return;
      if (restoreFocus && isOwnerHTMLElement(previousFocus) && previousFocus.isConnected) {
        previousFocus.focus();
      }
      resolve();
    };
    const confirmCompletion = (): void => {
      if (!remove()) return;
      if (isOwnerHTMLElement(previousFocus) && previousFocus.isConnected) previousFocus.focus();
      Promise.resolve()
        .then(onConfirm)
        .then(() => resolve(), reject);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Tab') {
        const active = ownerDocument.activeElement;
        let target: HTMLButtonElement | undefined;
        if (event.shiftKey && active === cancel) {
          target = confirm;
        } else if ((!event.shiftKey && active === confirm) || !surface.contains(active)) {
          target = cancel;
        }
        if (target) {
          event.preventDefault();
          target.focus();
        }
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        cancelCompletion(true);
      }
    };
    const dismiss = (): void => cancelCompletion(false);
    const onTeardown = (): void => dismiss();
    cancel.addEventListener('click', () => cancelCompletion(true));
    confirm.addEventListener('click', confirmCompletion);
    surface.addEventListener('click', (event) => {
      if (event.target === surface) cancelCompletion(true);
    });
    ownerDocument.addEventListener('keydown', onKeyDown, true);
    teardownSignal?.addEventListener('abort', onTeardown, { once: true });
    dismissActiveCompletionConfirmation = dismiss;
    cancel.focus();
  });
}

export function presentTaskCommandResult(result: TaskCommandResult): void {
  if (result.type === 'ok') return;
  new Notice(describeCommandError(result).message);
}

interface CommandErrorDescription {
  readonly message: string;
  readonly requiresRecovery: boolean;
}

function describeCommandError(
  result: Exclude<TaskCommandResult, { readonly type: 'ok' }>,
): CommandErrorDescription {
  switch (result.type) {
    case 'conflict':
      return {
        message: 'This task changed before the update could be applied.',
        requiresRecovery: true,
      };
    case 'ambiguous':
      return {
        message: 'Multiple matching tasks were found. Reopen the task and try again.',
        requiresRecovery: true,
      };
    case 'not-found':
      return { message: 'This task no longer exists.', requiresRecovery: true };
    case 'invalid':
      return { message: 'The task update is invalid and was not saved.', requiresRecovery: false };
    case 'blocked':
      return {
        message:
          result.dependency.type === 'blocked'
            ? 'Complete the prerequisite tasks first.'
            : 'Task dependencies are invalid and completion was not saved.',
        requiresRecovery: false,
      };
    case 'io-error':
      return { message: 'Failed to update task. Please try again.', requiresRecovery: true };
    case 'partial':
      return {
        message:
          result.operation === 'move'
            ? 'The task was copied, but the original could not be removed.'
            : 'The new task tags were saved, but older tags could not be removed.',
        requiresRecovery: true,
      };
  }
}

export function presentTaskMoveResult(
  app: App,
  tasks: TaskApplicationApi,
  result: TaskCommandResult,
): void {
  if (result.type === 'partial' && result.operation === 'move') {
    new TaskMoveRecoveryModal(app, tasks, result.recovery).open();
    return;
  }
  if (result.type === 'io-error' && result.contentState === 'unknown') {
    const target = result.path ?? 'the target file';
    new Notice(
      `Could not confirm whether the move to ${target} was saved. Rescan and inspect the target and original task before taking any action. Do not retry the move.`,
    );
    return;
  }
  presentTaskCommandResult(result);
}

export function presentTaskCreationResult(
  result: TaskCommandResult,
  options: { readonly announceSuccess: boolean } = { announceSuccess: true },
): void {
  const description = describeTaskCreationResult(result);
  if (description.kind === 'success') {
    if (!options.announceSuccess || description.task === undefined) return;
    new Notice(description.message);
    return;
  }
  new Notice(description.message);
}

export interface CreationResultDescription {
  readonly kind: 'success' | 'error';
  readonly message: string;
  readonly ariaLive: 'polite' | 'assertive';
  readonly task?: TaskSnapshot;
  readonly requiresRecovery: boolean;
}

export function describeTaskCreationResult(result: TaskCommandResult): CreationResultDescription {
  if (result.type === 'ok') {
    if (result.outcome.type !== 'task') {
      return {
        kind: 'success',
        message: '',
        ariaLive: 'polite',
        requiresRecovery: false,
      };
    }
    const path = result.outcome.task.source.filePath;
    return {
      kind: 'success',
      message: `Task added to ${path.split('/').pop() ?? path}`,
      ariaLive: 'polite',
      task: result.outcome.task,
      requiresRecovery: false,
    };
  }

  if (result.type === 'invalid') {
    const unavailable = result.issues.some((issue) => issue.code === 'destination-unavailable');
    return {
      kind: 'error',
      message: unavailable
        ? 'No target file found for task.'
        : 'The new task is invalid and was not created.',
      ariaLive: 'assertive',
      requiresRecovery: unavailable,
    };
  }

  if (result.type === 'io-error') {
    return {
      kind: 'error',
      message: 'Failed to create task. Please try again.',
      ariaLive: 'assertive',
      requiresRecovery: true,
    };
  }

  const error = describeCommandError(result);
  return {
    kind: 'error',
    message: error.message,
    ariaLive: 'assertive',
    requiresRecovery: error.requiresRecovery,
  };
}
