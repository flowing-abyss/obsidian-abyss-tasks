import type { App } from 'obsidian';
import type { AppState } from '../../app/AppState';
import type { LinkToken } from '../../markdown/links';
import type { ProjectManager } from '../../projects/ProjectManager';
import type { StatusRegistry } from '../../status/StatusRegistry';
import type {
  LocalDate,
  TaskApplicationApi,
  TaskArchiveSession,
  TaskCommandResult,
  TaskQueryApi,
  TaskRef,
  TaskSnapshot,
} from '../../tasks';
import { LinkEditModal } from '../../ui/LinkEditModal';
import type { InteractionOwnershipPort } from '../../ui/interactionOwnership';
import { moveTaskToProjectWithRecovery } from '../../ui/moveTaskToProject';
import { runAsyncAction } from '../../ui/runAsyncAction';
import {
  presentTaskArchiveResult,
  presentTaskCommandResult,
  requestTaskCompletion,
} from '../../ui/taskCommandResult';
import { rootTaskRef } from '../../ui/taskSelection';
import {
  calendarMutationTarget,
  calendarPatchCommand,
  isForecastCalendarTask,
} from '../../views/calendarOccurrences';
import { taskRowKey } from '../task-list/taskListRows';
import type { TaskRowSelection } from '../task-list/taskRowSelection';

interface TaskCommandsOptions {
  readonly app: App;
  readonly state: AppState;
  readonly tasks: TaskApplicationApi | undefined;
  readonly statusRegistry: StatusRegistry;
  readonly interactionOwnership: InteractionOwnershipPort;
  readonly projectManager: ProjectManager | null;
  readonly selection: TaskRowSelection;
  readonly onSelectionChanged: () => void;
}

export class TaskCommands {
  readonly #app: App;
  readonly #state: AppState;
  readonly #tasks: TaskApplicationApi | undefined;
  readonly #statusRegistry: StatusRegistry;
  readonly #interactionOwnership: InteractionOwnershipPort;
  readonly #projectManager: ProjectManager | null;
  readonly #selection: TaskRowSelection;
  readonly #onSelectionChanged: () => void;
  readonly #completionConfirmationAbortController = new AbortController();

  constructor(options: TaskCommandsOptions) {
    this.#app = options.app;
    this.#state = options.state;
    this.#tasks = options.tasks;
    this.#statusRegistry = options.statusRegistry;
    this.#interactionOwnership = options.interactionOwnership;
    this.#projectManager = options.projectManager;
    this.#selection = options.selection;
    this.#onSelectionChanged = options.onSelectionChanged;
  }

  async deleteBulkTasks(selectedTasks: TaskSnapshot[]): Promise<void> {
    const sorted = [...selectedTasks].sort((a, b) => b.source.line - a.source.line);
    for (const t of sorted) await this.deleteTask(t);
    this.#selection.clear();
    this.#onSelectionChanged();
  }

  async archiveTasks(selectedTasks: readonly TaskSnapshot[]): Promise<void> {
    const tasks = this.#tasks;
    if (tasks == null) return;
    const pending = selectedTasks.map((task) => ({
      task,
      selected: this.#selection.has(taskRowKey(task)),
    }));
    const session: TaskArchiveSession | undefined = await tasks.planArchive?.();
    for (let next = pending[0]; next !== undefined; next = pending[0]) {
      const { task } = next;
      const result =
        session?.type === 'ready'
          ? await session.execute(task.ref)
          : await tasks.execute({ type: 'archive', ref: task.ref });
      presentTaskArchiveResult(this.#app, tasks, result);
      this.#removeArchivedSelection(task, result);
      const archived = result.type === 'ok' && result.outcome.type === 'archived';
      if (archived) pending.shift();
      this.#refreshArchiveSelection(pending, tasks.queries);
      if (!archived) break;
    }
    this.#onSelectionChanged();
  }

  #refreshArchiveSelection(
    pending: Array<{ task: TaskSnapshot; selected: boolean }>,
    queries: TaskQueryApi,
  ): void {
    // Each removal can shift every remaining root in the file. Consume the proven
    // transition now, before the next write replaces that reconciliation evidence.
    const kept: string[] = [];
    for (const remaining of pending) {
      const resolution = queries.resolve(remaining.task.ref);
      if (resolution.type === 'exact') remaining.task = resolution.task;
      else if (resolution.type === 'rebased') remaining.task = resolution.current;
      else continue;
      if (remaining.selected) kept.push(taskRowKey(remaining.task));
    }
    this.#selection.replaceWith(kept);
  }

  #removeArchivedSelection(task: TaskSnapshot, result: TaskCommandResult): void {
    if (result.type !== 'ok' || result.outcome.type !== 'archived') return;
    this.#selection.delete(taskRowKey(task));
    const current = this.#state.get('taskStack')[0];
    if (current != null && this.#sameTaskRef(rootTaskRef(current), task.ref)) {
      this.#state.set('taskStack', []);
    }
  }

  async patchTaskTags(
    task: TaskSnapshot,
    add: readonly string[],
    remove: readonly string[],
  ): Promise<void> {
    const ref = task.ref;
    if (this.#tasks == null) return;
    presentTaskCommandResult(
      await this.#tasks.execute({
        type: 'patch',
        target: { type: 'task', ref },
        patch: {
          tags: {
            ...(add.length > 0 && { add }),
            ...(remove.length > 0 && { remove }),
          },
        },
      }),
    );
  }

  async deleteTask(task: TaskSnapshot): Promise<void> {
    const ref = task.ref;
    if (this.#tasks == null) return;
    const result = await this.#tasks.execute({ type: 'delete', ref });
    presentTaskCommandResult(result);
    if (result.type !== 'ok' || result.outcome.type !== 'deleted') return;
    const stack = this.#state.get('taskStack');
    const current = stack[0] != null ? rootTaskRef(stack[0]) : undefined;
    if (current != null && this.#sameTaskRef(current, ref)) {
      this.#state.set('taskStack', []);
    }
  }

  #sameTaskRef(left: TaskRef, right: TaskRef): boolean {
    return (
      left.filePath === right.filePath &&
      left.line === right.line &&
      left.revision === right.revision
    );
  }

  editTaskLink(task: TaskSnapshot, occ: number, token: LinkToken): void {
    const target = calendarMutationTarget(task);
    const tasks = this.#tasks;
    if (target == null || tasks == null) return;
    new LinkEditModal(
      this.#app,
      token,
      (newRaw) => {
        runAsyncAction(
          tasks
            .execute({
              type: 'edit-link',
              target: { type: 'title', target },
              occurrence: occ,
              replacement: newRaw,
            })
            .then(presentTaskCommandResult),
        );
      },
      task.source.filePath,
      this.#interactionOwnership,
    ).open();
  }

  async toggleTaskDuePreset(task: TaskSnapshot, value: LocalDate): Promise<void> {
    await this.setTaskDue(task, task.planning.due === value ? null : value);
  }

  async setTaskDue(task: TaskSnapshot, value: LocalDate | null): Promise<boolean> {
    const command = calendarPatchCommand(task, {
      due: value === null ? { type: 'clear' } : { type: 'set', value },
    });
    if (command == null || this.#tasks == null) return false;
    const result = await this.#tasks.execute(command);
    presentTaskCommandResult(result);
    return result.type === 'ok' && result.changed;
  }

  async applyDueInOrder(tasks: readonly TaskSnapshot[], value: LocalDate): Promise<boolean> {
    let changed = false;
    for (const task of tasks) {
      const taskChanged = await this.setTaskDue(task, value);
      changed = taskChanged || changed;
    }
    return changed;
  }

  async applyBulkDuePreset(tasks: readonly TaskSnapshot[], value: LocalDate): Promise<void> {
    const shouldClear = tasks.every((task) => task.planning.due === value);
    if (!shouldClear) {
      await this.applyDueInOrder(tasks, value);
      return;
    }
    for (const task of tasks) await this.setTaskDue(task, null);
  }

  async setPriority(
    task: TaskSnapshot,
    priority: 'A' | 'B' | 'C' | 'D' | 'E' | 'F',
  ): Promise<void> {
    if (isForecastCalendarTask(task)) return;
    const command = calendarPatchCommand(task, {
      priority: { type: 'set', value: priority },
    });
    if (command == null || this.#tasks == null) return;
    presentTaskCommandResult(await this.#tasks.execute(command));
  }

  toggleTask(task: TaskSnapshot): Promise<void> {
    if (isForecastCalendarTask(task)) return Promise.resolve();
    return requestTaskCompletion(
      task,
      () => this.#commitTaskToggle(task),
      this.#interactionOwnership,
      this.#completionConfirmationAbortController.signal,
    );
  }

  async #commitTaskToggle(task: TaskSnapshot): Promise<void> {
    const target = calendarMutationTarget(task);
    if (target == null || this.#tasks == null) return;
    presentTaskCommandResult(
      await this.#tasks.execute({
        type: 'toggle-completion',
        target,
      }),
    );
  }

  setTaskStatus(task: TaskSnapshot, symbol: string): Promise<void> {
    if (isForecastCalendarTask(task)) return Promise.resolve();
    if (this.#statusRegistry.bySymbol(symbol)?.type === 'done') {
      return requestTaskCompletion(
        task,
        () => this.#commitTaskStatus(task, symbol),
        this.#interactionOwnership,
        this.#completionConfirmationAbortController.signal,
      );
    }
    return this.#commitTaskStatus(task, symbol);
  }

  async #commitTaskStatus(task: TaskSnapshot, symbol: string): Promise<void> {
    const target = calendarMutationTarget(task);
    if (target == null || this.#tasks == null) return;
    presentTaskCommandResult(
      await this.#tasks.execute({
        type: 'set-status',
        target,
        symbol,
      }),
    );
  }

  async moveTaskToProject(task: TaskSnapshot, path: string): Promise<void> {
    if (this.#tasks == null || this.#projectManager == null) return;
    await moveTaskToProjectWithRecovery(
      this.#app,
      this.#tasks,
      this.#projectManager,
      task.ref,
      path,
    );
  }

  dispose(): void {
    this.#completionConfirmationAbortController.abort();
  }
}
