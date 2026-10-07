import { Notice, type App } from 'obsidian';
import type { AppState } from '../../app/AppState';
import type { LinkToken } from '../../markdown/links';
import type { ProjectManager } from '../../projects/ProjectManager';
import type { StatusRegistry } from '../../status/StatusRegistry';
import type {
  CalendarTaskSource,
  LocalDate,
  TaskApplicationApi,
  TaskArchiveSession,
  TaskCommand,
  TaskCommandResult,
  TaskNodeRef,
  TaskNodeSnapshot,
  TaskOccurrenceCompletion,
  TaskPatch,
  TaskPriority,
  TaskQueryApi,
  TaskRef,
  TaskSnapshot,
  TaskTextTarget,
} from '../../tasks';
import { LinkEditModal } from '../../ui/LinkEditModal';
import type { InteractionOwnershipPort } from '../../ui/interactionOwnership';
import { moveTaskToProjectWithRecovery } from '../../ui/moveTaskToProject';
import { runAsyncAction } from '../../ui/runAsyncAction';
import {
  presentTaskArchiveResult,
  presentTaskCommandResult,
  requestTaskStatusChange,
} from '../../ui/taskCommandResult';
import {
  rootTaskNodeRef,
  rootTaskRef,
  taskNodeRef,
  taskSelectionRefPath,
  type TaskSelectionNode,
} from '../../ui/taskSelection';
import {
  calendarMutationTarget,
  calendarOccurrenceForTask,
  isForecastCalendarTask,
} from '../../views/calendarOccurrences';
import { rebaseTaskRowKey, taskRowKey, type TaskListRows } from '../task-list/taskListRows';
import type { TaskRowSelection } from '../task-list/taskRowSelection';

import { rootTaskNodeSnapshot, sameTaskNodeRef, taskNodeSourceLine } from '../../tasks';
import { proveOwnedTaskSelection } from '../../ui/ownedTaskSelection';
import { executeTaskHierarchy } from '../../ui/taskHierarchyActions';
import {
  planTaskNodeBatch,
  taskNodeContains,
  type TaskNodeBatchKind,
  type TaskSelectedNode,
} from './taskNodeBatch';

export type TaskCommandSubject = TaskSelectionNode | TaskNodeSnapshot;
export function commandNode(subject: TaskCommandSubject): TaskSelectionNode {
  return 'root' in subject ? subject.node : subject;
}
export function commandTarget(subject: TaskCommandSubject): TaskNodeRef | undefined {
  if ('root' in subject) return subject.target;
  return 'source' in subject ? calendarMutationTarget(subject) : taskNodeRef(subject);
}
export function commandPatch(
  subject: TaskCommandSubject,
  patch: TaskPatch,
): TaskCommand | undefined {
  const target = commandTarget(subject);
  if (target === undefined) return undefined;
  if (target.type === 'task') return { type: 'patch', target, patch };
  return { type: 'patch', target, patch };
}

export function commandSource(
  subject: TaskCommandSubject,
  queries: TaskQueryApi,
): CalendarTaskSource | undefined {
  const target = commandTarget(subject);
  if (target === undefined) return undefined;
  const owner = queries.resolve(rootTaskNodeRef(target));
  if (owner.type === 'exact') {
    const path = taskSelectionRefPath(owner.task, target);
    const node = path?.[path.length - 1];
    if (node !== undefined) return { root: owner.task, node, target };
  }
  presentTaskCommandResult({ type: 'not-found', target });
  return undefined;
}

interface PendingTask<T> {
  task: TaskNodeSnapshot;
  readonly original: T;
}

interface TaskCommandsOptions {
  readonly app: App;
  readonly state: AppState;
  readonly tasks: TaskApplicationApi | undefined;
  readonly statusRegistry: StatusRegistry;
  readonly interactionOwnership: InteractionOwnershipPort;
  readonly projectManager: ProjectManager | null;
  readonly selection: TaskRowSelection;
  readonly rows: () => Pick<TaskListRows, 'occurrencesOf'>;
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
  readonly #rows: () => Pick<TaskListRows, 'occurrencesOf'>;
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
    this.#rows = options.rows;
    this.#onSelectionChanged = options.onSelectionChanged;
  }

  async deleteBulkTasks(selectedTasks: readonly TaskCommandSubject[]): Promise<void> {
    await this.#batch(selectedTasks, 'subtree', ({ target }) =>
      target.type === 'task'
        ? { type: 'delete', ref: target.ref }
        : { type: 'delete-subtask', subtask: target.ref },
    );
    this.#selection.clear();
    this.#onSelectionChanged();
  }

  async archiveTasks(subjects: readonly TaskCommandSubject[]): Promise<void> {
    const tasks = this.#tasks;
    if (tasks == null) return;
    if (!this.#rootOnly(subjects)) return;
    const entries = this.#batchEntries(subjects, 'patch');
    if (entries === undefined) return;
    const selectedTasks = entries.map((entry) => entry.task.root);
    const pending = selectedTasks.map((task) => ({
      task,
      selected: this.#rows()
        .occurrencesOf(taskRowKey(task))
        .filter((key) => this.#selection.has(key)),
    }));
    const session: TaskArchiveSession | undefined = await tasks.planArchive?.();
    for (let next = pending[0]; next !== undefined; next = pending[0]) {
      const { task } = next;
      const archived = await this.#archiveOne(task, tasks, session);
      if (archived) pending.shift();
      const refreshed = this.#refreshArchiveSelection(pending, tasks.queries);
      if (!archived || !refreshed) break;
    }
    this.#onSelectionChanged();
  }

  async #archiveOne(
    task: TaskSnapshot,
    tasks: TaskApplicationApi,
    session: TaskArchiveSession | undefined,
  ): Promise<boolean> {
    const result =
      session?.type === 'ready'
        ? await session.execute(task.ref)
        : await tasks.execute({ type: 'archive', ref: task.ref });
    presentTaskArchiveResult(this.#app, tasks, result);
    this.#removeArchivedSelection(task, result);
    return result.type === 'ok' && result.outcome.type === 'archived';
  }

  #refreshArchiveSelection(
    pending: Array<{ task: TaskSnapshot; selected: string[] }>,
    queries: TaskQueryApi,
  ): boolean {
    // Each removal can shift every remaining root in the file. Consume the proven
    // transition now, before the next write replaces that reconciliation evidence.
    const kept: string[] = [];
    for (const remaining of pending) {
      const previous = taskRowKey(remaining.task);
      const resolution = queries.resolve(remaining.task.ref);
      if (resolution.type === 'exact') remaining.task = resolution.task;
      else if (resolution.type === 'rebased') remaining.task = resolution.current;
      else {
        presentTaskCommandResult({ type: 'not-found', target: taskNodeRef(remaining.task) });
        return false;
      }
      remaining.selected = remaining.selected.map((key) =>
        rebaseTaskRowKey(key, previous, taskRowKey(remaining.task)),
      );
      kept.push(...remaining.selected);
    }
    this.#selection.replaceWith(kept);
    return true;
  }

  #removeArchivedSelection(task: TaskSnapshot, result: TaskCommandResult): void {
    if (result.type !== 'ok' || result.outcome.type !== 'archived') return;
    for (const key of this.#rows().occurrencesOf(taskRowKey(task))) this.#selection.delete(key);
    const current = this.#state.get('taskStack')[0];
    if (current != null && this.#sameTaskRef(rootTaskRef(current), task.ref)) {
      this.#state.set('taskStack', []);
    }
  }

  async patchTaskTags<T extends TaskCommandSubject>(
    task: T,
    add: readonly string[],
    remove: readonly string[],
    onResult?: (task: T, result: TaskCommandResult) => void,
  ): Promise<void> {
    const command = commandPatch(task, {
      tags: {
        ...(add.length > 0 && { add }),
        ...(remove.length > 0 && { remove }),
      },
    });
    if (command === undefined || this.#tasks === undefined) return;
    const result = await this.#tasks.execute(command);
    presentTaskCommandResult(result);
    onResult?.(task, result);
  }

  async deleteTask(task: TaskCommandSubject): Promise<void> {
    const target = commandTarget(task);
    if (this.#tasks == null || target === undefined) return;
    const result = await this.#tasks.execute(
      target.type === 'task'
        ? { type: 'delete', ref: target.ref }
        : { type: 'delete-subtask', subtask: target.ref },
    );
    presentTaskCommandResult(result);
    this.#clearDeletedSelection(rootTaskNodeRef(target), result);
  }

  #clearDeletedSelection(ref: TaskRef, result: TaskCommandResult): void {
    if (result.type !== 'ok' || result.outcome.type !== 'deleted') return;
    const current = this.#state.get('taskStack')[0];
    if (current !== undefined && this.#sameTaskRef(rootTaskRef(current), ref))
      this.#state.set('taskStack', []);
  }

  #sameTaskRef(left: TaskRef, right: TaskRef): boolean {
    return (
      left.filePath === right.filePath &&
      left.line === right.line &&
      left.revision === right.revision
    );
  }

  editTaskLink(
    task: TaskCommandSubject,
    occ: number,
    token: LinkToken,
    textTarget?: TaskTextTarget,
  ): void {
    const target = commandTarget(task);
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
              target: textTarget ?? { type: 'title', target },
              occurrence: occ,
              replacement: newRaw,
            })
            .then(presentTaskCommandResult),
        );
      },
      rootTaskNodeRef(target).filePath,
      this.#interactionOwnership,
    ).open();
  }

  async toggleTaskDuePreset(task: TaskCommandSubject, value: LocalDate): Promise<void> {
    await this.setTaskDue(task, commandNode(task).planning.due === value ? null : value);
  }

  async setTaskDue<T extends TaskCommandSubject>(
    task: T,
    value: LocalDate | null,
    onResult?: (task: T, result: TaskCommandResult) => void,
  ): Promise<boolean> {
    const command = commandPatch(task, {
      due: value === null ? { type: 'clear' } : { type: 'set', value },
    });
    if (command == null || this.#tasks == null) return false;
    const result = await this.#tasks.execute(command);
    presentTaskCommandResult(result);
    onResult?.(task, result);
    return result.type === 'ok' && result.changed;
  }

  async applyDueInOrder<T extends TaskCommandSubject>(
    tasks: readonly T[],
    value: LocalDate,
    onResult?: (task: T, result: TaskCommandResult) => void,
  ): Promise<boolean> {
    return this.#batch(
      tasks,
      'patch',
      (task) => commandPatch(task, { due: { type: 'set', value } }),
      onResult,
    );
  }

  async applyBulkDuePreset<T extends TaskCommandSubject>(
    tasks: readonly T[],
    value: LocalDate,
    onResult?: (task: T, result: TaskCommandResult) => void,
  ): Promise<void> {
    const clear = tasks.every((task) => commandNode(task).planning.due === value);
    await this.#batch(
      tasks,
      'patch',
      (task) => commandPatch(task, { due: clear ? { type: 'clear' } : { type: 'set', value } }),
      onResult,
    );
  }

  async applyBulkTaskTags<T extends TaskCommandSubject>(
    tasks: readonly T[],
    add: readonly string[],
    remove: readonly string[],
    onResult?: (task: T, result: TaskCommandResult) => void,
  ): Promise<void> {
    await this.#batch(
      tasks,
      'patch',
      (task) =>
        commandPatch(task, {
          tags: { ...(add.length > 0 && { add }), ...(remove.length > 0 && { remove }) },
        }),
      onResult,
    );
  }

  async setPriority(task: TaskCommandSubject, priority: TaskPriority): Promise<void> {
    const command = commandPatch(task, { priority: { type: 'set', value: priority } });
    if (command !== undefined) await this.#submit(command);
  }

  async setBulkPriority(
    tasks: readonly TaskCommandSubject[],
    priority: TaskPriority,
  ): Promise<void> {
    await this.#batch(tasks, 'patch', (task) =>
      commandPatch(task, { priority: { type: 'set', value: priority } }),
    );
  }

  toggleTask(
    task: TaskCommandSubject,
    completion: TaskOccurrenceCompletion = { kind: 'allowed' },
  ): Promise<void> {
    return this.#status(task, undefined, completion);
  }

  setTaskStatus(
    task: TaskCommandSubject,
    symbol: string,
    completion: TaskOccurrenceCompletion = { kind: 'allowed' },
  ): Promise<void> {
    return this.#status(task, symbol, completion);
  }

  async #status(
    task: TaskCommandSubject,
    symbol: string | undefined,
    completion: TaskOccurrenceCompletion,
  ): Promise<void> {
    if (completion.kind !== 'allowed') return;
    const target = commandTarget(task);
    if (target === undefined) return;
    await requestTaskStatusChange(
      commandNode(task),
      symbol,
      this.#statusRegistry,
      async () => {
        await this.#submit(
          symbol === undefined
            ? { type: 'toggle-completion', target }
            : { type: 'set-status', target, symbol },
        );
      },
      this.#interactionOwnership,
      this.#completionConfirmationAbortController.signal,
    );
  }

  async setBulkTaskStatus(selected: readonly TaskSelectedNode[], symbol: string): Promise<void> {
    const all = planTaskNodeBatch(
      selected.map((entry) => entry.task),
      'status',
    );
    const eligible = all.filter((task) =>
      selected.some(
        (entry) =>
          sameTaskNodeRef(entry.task.target, task.target) && entry.completion.kind === 'allowed',
      ),
    );
    const excluded = all.length - eligible.length;
    if (excluded > 0)
      new Notice(
        `${excluded} task${excluded === 1 ? '' : 's'} unchanged: complete from the due-date row or task details.`,
      );
    await this.#batch(eligible, 'status', (task) => ({
      type: 'set-status',
      target: task.target,
      symbol,
    }));
  }

  async moveTaskToProject(task: TaskCommandSubject, path: string): Promise<void> {
    if (!this.#rootOnly([task])) return;
    const target = commandTarget(task);
    if (target?.type !== 'task' || this.#tasks == null || this.#projectManager == null) return;
    await moveTaskToProjectWithRecovery(
      this.#app,
      this.#tasks,
      this.#projectManager,
      target.ref,
      path,
    );
  }

  async promoteTask(task: TaskCommandSubject): Promise<void> {
    const target = commandTarget(task);
    if (target?.type !== 'subtask' || this.#tasks === undefined) return;
    await executeTaskHierarchy(
      this.#state,
      this.#tasks,
      { type: 'promote-subtask', subtask: target.ref },
      () => !this.#completionConfirmationAbortController.signal.aborted,
    );
  }

  #rootOnly(tasks: readonly TaskCommandSubject[]): boolean {
    if (tasks.every((task) => commandTarget(task)?.type === 'task')) return true;
    new Notice('Promote subtasks to independent tasks before archiving or moving them.');
    return false;
  }

  async #submit(command: TaskCommand): Promise<TaskCommandResult | undefined> {
    if (this.#tasks === undefined) return undefined;
    const result = await this.#tasks.execute(command);
    presentTaskCommandResult(result);
    if (command.type === 'delete') this.#clearDeletedSelection(command.ref, result);
    return result;
  }

  #projection(subject: TaskCommandSubject): TaskNodeSnapshot | undefined {
    if ('root' in subject) return subject;
    if ('source' in subject) {
      const occurrence = calendarOccurrenceForTask(subject);
      if (occurrence === undefined) return rootTaskNodeSnapshot(subject);
      if (isForecastCalendarTask(subject)) return undefined;
      const { root, target } = occurrence.source;
      return this.#nodeInRoot(root, target);
    }
    const resolved = this.#tasks?.queries.resolve(rootTaskRef(subject));
    return resolved?.type === 'exact'
      ? this.#nodeInRoot(resolved.task, taskNodeRef(subject))
      : undefined;
  }

  #nodeInRoot(root: TaskSnapshot, target: TaskNodeRef): TaskNodeSnapshot | undefined {
    const path = taskSelectionRefPath(root, target);
    const node = path?.[path.length - 1];
    if (path === undefined || node === undefined) return undefined;
    return {
      root,
      node,
      target: taskNodeRef(node),
      path: path
        .slice(1)
        .filter((child): child is TaskNodeSnapshot['path'][number] => !('source' in child)),
    };
  }

  #batchEntries<T extends TaskCommandSubject>(
    subjects: readonly T[],
    kind: TaskNodeBatchKind,
  ): Array<PendingTask<T>> | undefined {
    const captured: Array<PendingTask<T>> = [];
    for (const original of subjects) {
      const task = this.#projection(original);
      if (task === undefined) {
        const target = commandTarget(original);
        if (target !== undefined) presentTaskCommandResult({ type: 'not-found', target });
        return undefined;
      }
      captured.push({ original, task });
    }
    const planned = planTaskNodeBatch(
      captured.map((entry) => entry.task),
      kind,
    );
    const ordered =
      kind === 'subtree'
        ? [...planned].sort((a, b) => taskNodeSourceLine(b.target) - taskNodeSourceLine(a.target))
        : planned;
    return ordered.flatMap((task) => {
      const entry = captured.find((candidate) => candidate.task === task);
      return entry === undefined ? [] : [entry];
    });
  }

  async #batch<T extends TaskCommandSubject>(
    subjects: readonly T[],
    kind: TaskNodeBatchKind,
    build: (task: TaskNodeSnapshot) => TaskCommand | undefined,
    onResult?: (task: T, result: TaskCommandResult) => void,
  ): Promise<boolean> {
    const pending = this.#batchEntries(subjects, kind);
    if (pending === undefined) return false;
    let changed = false;
    for (const [index, entry] of pending.entries()) {
      const command = build(entry.task);
      if (command === undefined) break;
      const result = await this.#submitBatchCommand(entry.task, command);
      if (result === undefined) break;
      onResult?.(entry.original, result);
      if (result.type !== 'ok') break;
      changed ||= result.changed;
      if (!this.#refreshPending(pending.slice(index + 1), entry.task, command, result)) break;
    }
    return changed;
  }

  async #submitBatchCommand(
    task: TaskNodeSnapshot,
    command: TaskCommand,
  ): Promise<TaskCommandResult | undefined> {
    if (command.type !== 'set-status' && command.type !== 'toggle-completion')
      return this.#submit(command);
    const settled: { result?: TaskCommandResult } = {};
    await requestTaskStatusChange(
      task.node,
      command.type === 'set-status' ? command.symbol : undefined,
      this.#statusRegistry,
      async () => {
        const result = await this.#submit(command);
        if (result !== undefined) settled.result = result;
      },
      this.#interactionOwnership,
      this.#completionConfirmationAbortController.signal,
    );
    return settled.result;
  }

  #refreshPending<T>(
    pending: Array<PendingTask<T>>,
    edited: TaskNodeSnapshot,
    command: TaskCommand,
    result: Extract<TaskCommandResult, { type: 'ok' }>,
  ): boolean {
    for (const next of pending) {
      const fresh = this.#advance(next.task, edited, command, result);
      if (fresh === undefined) {
        presentTaskCommandResult({ type: 'not-found', target: next.task.target });
        return false;
      }
      next.task = fresh;
    }
    return true;
  }

  #advance(
    pending: TaskNodeSnapshot,
    edited: TaskNodeSnapshot,
    command: TaskCommand,
    result: Extract<TaskCommandResult, { type: 'ok' }>,
  ): TaskNodeSnapshot | undefined {
    const resolution = this.#tasks?.queries.resolve(pending.root.ref);
    if (resolution?.type !== 'exact' && resolution?.type !== 'rebased') return undefined;
    const current = resolution.type === 'exact' ? resolution.task : resolution.current;
    if (
      sameTaskNodeRef({ type: 'task', ref: pending.root.ref }, { type: 'task', ref: current.ref })
    )
      return pending;
    const sameRoot = sameTaskNodeRef(
      { type: 'task', ref: pending.root.ref },
      { type: 'task', ref: edited.root.ref },
    );
    if (sameRoot) return this.#advanceOwned(pending, current, { edited, command, result });
    // Other roots survive only via a proven byte-preserving relocation.
    if (pending.root.source.originalBlock !== current.source.originalBlock) return undefined;
    return this.#atRelativeLines(pending, current, 0);
  }

  #advanceOwned(
    pending: TaskNodeSnapshot,
    current: TaskSnapshot,
    {
      edited,
      command,
      result,
    }: {
      readonly edited: TaskNodeSnapshot;
      readonly command: TaskCommand;
      readonly result: Extract<TaskCommandResult, { type: 'ok' }>;
    },
  ): TaskNodeSnapshot | undefined {
    const node = proveOwnedTaskSelection(current, [pending.root], command)?.nodeSuccessor(
      pending.target,
    );
    if (node !== undefined) return this.#nodeInRoot(current, taskNodeRef(node));
    const owned = this.#resultRoot(edited, result);
    if (
      owned === undefined ||
      !sameTaskNodeRef({ type: 'task', ref: owned.ref }, { type: 'task', ref: current.ref })
    )
      return undefined;
    return this.#outsideEditedSubtree(pending, edited, current);
  }

  #resultRoot(
    edited: TaskNodeSnapshot,
    result: Extract<TaskCommandResult, { type: 'ok' }>,
  ): TaskSnapshot | undefined {
    if (result.outcome.type === 'task') return result.outcome.task;
    if (result.outcome.type === 'recurrence' && edited.target.type === 'subtask')
      return result.outcome.active.root;
    return undefined;
  }

  #atRelativeLines(
    pending: TaskNodeSnapshot,
    current: TaskSnapshot,
    delta: number,
  ): TaskNodeSnapshot | undefined {
    if (pending.target.type === 'task') return rootTaskNodeSnapshot(current);
    const wanted = taskNodeSourceLine(pending.target) - pending.root.source.line + delta;
    const visit = (node: TaskSelectionNode): TaskNodeSnapshot | undefined => {
      for (const child of node.subtasks) {
        const target = taskNodeRef(child);
        if (taskNodeSourceLine(target) - current.source.line === wanted)
          return this.#nodeInRoot(current, target);
        const nested = visit(child);
        if (nested !== undefined) return nested;
      }
      return undefined;
    };
    return visit(current);
  }

  // Structural completion can delete a child or insert its recurrence successor. Only
  // carry nodes outside that authored subtree after checking the complete surrounding
  // source against the exact returned root; no generated occurrence inherits a pending entry.
  #outsideEditedSubtree(
    pending: TaskNodeSnapshot,
    edited: TaskNodeSnapshot,
    current: TaskSnapshot,
  ): TaskNodeSnapshot | undefined {
    const change = this.#subtreeChange(edited, current);
    if (change === undefined) return undefined;
    const { start, end, delta } = change;
    const line = taskNodeSourceLine(pending.target) - pending.root.source.line;
    if (line >= start && line < end) return undefined;
    const next = this.#atRelativeLines(pending, current, line >= end ? delta : 0);
    if (next === undefined) return undefined;
    if (taskNodeContains(pending, edited)) return next;
    return next.target.type === 'subtask' &&
      pending.target.type === 'subtask' &&
      next.target.ref.originalBlock === pending.target.ref.originalBlock
      ? next
      : undefined;
  }

  #subtreeChange(
    edited: TaskNodeSnapshot,
    current: TaskSnapshot,
  ): { start: number; end: number; delta: number } | undefined {
    if (edited.target.type !== 'subtask') return undefined;
    const before = edited.root.source.originalBlock.split('\n');
    const after = current.source.originalBlock.split('\n');
    const start = taskNodeSourceLine(edited.target) - edited.root.source.line;
    const end = start + edited.target.ref.originalBlock.split('\n').length;
    const delta = after.length - before.length;
    if (
      !before.slice(0, start).every((line, i) => line === after[i]) ||
      !before.slice(end).every((line, i) => line === after[end + delta + i])
    )
      return undefined;
    return { start, end, delta };
  }

  dispose(): void {
    this.#completionConfirmationAbortController.abort();
  }
}
