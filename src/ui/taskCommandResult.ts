import { Notice, type App } from 'obsidian';
import { parseRecurrenceRule, type TaskApplicationApi, type TaskCommandResult } from '../tasks';
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

  return new Promise<void>((resolve, reject) => {
    dismissActiveCompletionConfirmation?.();
    activeDocument.querySelector('.tc-recurrence-delete-confirm')?.remove();
    const previousFocus = activeDocument.activeElement;
    const surface = activeDocument.body.createDiv({
      cls: 'tc-recurrence-delete-confirm',
      attr: {
        role: 'alertdialog',
        'aria-modal': 'true',
        'aria-labelledby': 'tc-recurrence-delete-confirm-title',
        'aria-describedby': 'tc-recurrence-delete-confirm-description',
      },
    });
    const dialog = surface.createDiv({ cls: 'tc-recurrence-delete-confirm-dialog' });
    dialog.createEl('h3', {
      cls: 'tc-recurrence-delete-confirm-title',
      text: 'Delete completed task?',
      attr: { id: 'tc-recurrence-delete-confirm-title' },
    });
    dialog.createEl('p', {
      cls: 'tc-recurrence-delete-confirm-description',
      text: 'The complete task and its sub-tasks will be deleted. No next occurrence will be created.',
      attr: { id: 'tc-recurrence-delete-confirm-description' },
    });
    const actions = dialog.createDiv({ cls: 'tc-recurrence-delete-confirm-actions' });
    const cancel = actions.createEl('button', { text: 'Cancel', attr: { type: 'button' } });
    const confirm = actions.createEl('button', {
      cls: 'mod-warning tc-recurrence-delete-confirm-button',
      text: 'Delete completed task',
      attr: { type: 'button' },
    });

    const remove = (): void => {
      surface.remove();
      activeDocument.removeEventListener('keydown', onKeyDown, true);
      dismissActiveCompletionConfirmation = undefined;
    };
    const cancelCompletion = (restoreFocus: boolean): void => {
      remove();
      if (restoreFocus && previousFocus instanceof HTMLElement) previousFocus.focus();
      resolve();
    };
    const confirmCompletion = (): void => {
      remove();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
      Promise.resolve()
        .then(onConfirm)
        .then(() => resolve(), reject);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Tab') {
        const active = activeDocument.activeElement;
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
    cancel.addEventListener('click', () => cancelCompletion(true));
    confirm.addEventListener('click', confirmCompletion);
    surface.addEventListener('click', (event) => {
      if (event.target === surface) cancelCompletion(true);
    });
    activeDocument.addEventListener('keydown', onKeyDown, true);
    dismissActiveCompletionConfirmation = () => cancelCompletion(false);
    cancel.focus();
  });
}

export function presentTaskCommandResult(result: TaskCommandResult): void {
  if (result.type === 'ok') return;
  let message: string;
  switch (result.type) {
    case 'conflict':
      message = 'This task changed before the update could be applied.';
      break;
    case 'ambiguous':
      message = 'Multiple matching tasks were found. Reopen the task and try again.';
      break;
    case 'not-found':
      message = 'This task no longer exists.';
      break;
    case 'invalid':
      message = 'The task update is invalid and was not saved.';
      break;
    case 'io-error':
      message = 'Failed to update task. Please try again.';
      break;
    case 'partial':
      message = 'The task was copied, but the original could not be removed.';
      break;
  }
  new Notice(message);
}

export function presentTaskMoveResult(
  app: App,
  tasks: TaskApplicationApi,
  result: TaskCommandResult,
): void {
  if (result.type === 'partial') {
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
  if (result.type === 'ok') {
    if (!options.announceSuccess || result.outcome.type !== 'task') return;
    const path = result.outcome.task.source.filePath;
    new Notice(`Task added to ${path.split('/').pop() ?? path}`);
    return;
  }
  if (result.type === 'invalid') {
    const unavailable = result.issues.some((issue) => issue.code === 'destination-unavailable');
    new Notice(
      unavailable
        ? 'No target file found for task.'
        : 'The new task is invalid and was not created.',
    );
    return;
  }
  if (result.type === 'io-error') {
    new Notice('Failed to create task. Please try again.');
    return;
  }
  presentTaskCommandResult(result);
}
