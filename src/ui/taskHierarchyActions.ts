import type { AppState, TaskNodeDragPayload } from '../app/AppState';
import {
  hierarchyWouldCycle,
  sameTaskNodeRef,
  type TaskApplicationApi,
  type TaskCommand,
  type TaskCommandResult,
  type TaskNodeRef,
  type TaskQueryApi,
  type TaskSnapshot,
} from '../tasks';
import { isForecastCalendarTask } from '../views/calendarOccurrences';
import { runAsyncAction } from './runAsyncAction';
import { presentTaskCommandResult } from './taskCommandResult';
import {
  rootTaskNodeRef,
  taskNodeRef,
  taskSelectionPath,
  type TaskSelectionNode,
} from './taskSelection';

export function hierarchyDropCommand(
  payload: TaskNodeDragPayload | null,
  parent: TaskNodeRef,
): Extract<TaskCommand, { type: 'reparent-task' }> | undefined {
  if (
    payload === null ||
    payload.source === 'inspector-relation' ||
    isForecastCalendarTask(payload.task.root)
  )
    return undefined;
  const source = payload.task.target;
  return hierarchyWouldCycle(source, parent)
    ? undefined
    : { type: 'reparent-task', source, parent };
}

/** Preview requires the exact live path; the repository remains the write authority. */
function livePath(queries: TaskQueryApi, target: TaskNodeRef): TaskSelectionNode[] | undefined {
  const result = queries.resolve(rootTaskNodeRef(target));
  if (
    result.type !== 'exact' ||
    !sameTaskNodeRef(taskNodeRef(result.task), { type: 'task', ref: rootTaskNodeRef(target) })
  )
    return undefined;
  return pathInRoot(result.task, target);
}

function pathInRoot(root: TaskSnapshot, target: TaskNodeRef): TaskSelectionNode[] | undefined {
  if (!sameTaskNodeRef(taskNodeRef(root), { type: 'task', ref: rootTaskNodeRef(target) }))
    return undefined;
  const chain: TaskNodeRef[] = [];
  let current = target;
  while (current.type === 'subtask') {
    chain.unshift(current);
    current = current.ref.parent;
  }
  const stack: TaskSelectionNode[] = [root];
  for (const child of chain) {
    const matches = stack[stack.length - 1]?.subtasks.filter((node) =>
      sameTaskNodeRef(taskNodeRef(node), child),
    );
    if (matches?.length !== 1 || matches[0] === undefined) return undefined;
    stack.push(matches[0]);
  }
  return stack;
}

interface HierarchyDropOptions {
  readonly state: AppState;
  readonly tasks: TaskApplicationApi;
  readonly parent: () => TaskNodeRef | undefined;
  readonly execute: (command: Extract<TaskCommand, { type: 'reparent-task' }>) => Promise<void>;
}

/** Bind after the surface's tag/project/attachment handlers, which retain first refusal. */
export function bindTaskHierarchyDrop(
  surface: HTMLElement,
  options: HierarchyDropOptions,
): () => void {
  const target = new HierarchyDropTarget(surface, options);
  return () => {
    target.dispose();
  };
}

class HierarchyDropTarget {
  #preview: { readonly payload: TaskNodeDragPayload; readonly parent: TaskNodeRef } | undefined;
  #releasePreview: (() => void) | undefined;
  constructor(
    readonly surface: HTMLElement,
    readonly options: HierarchyDropOptions,
  ) {
    surface.addEventListener('dragover', this.#over);
    surface.addEventListener('dragleave', this.#leave);
    surface.addEventListener('drop', this.#drop);
  }
  readonly #clear = (): void => {
    if (this.#preview !== undefined) this.surface.classList.remove('abyss-drop-target');
    this.#preview = undefined;
    this.#releasePreview?.();
    this.#releasePreview = undefined;
  };
  #eligible(event: DragEvent): ReturnType<typeof hierarchyDropCommand> {
    const { state, tasks, parent } = this.options;
    if (event.defaultPrevented || !this.surface.isConnected || specificDrag(state, event))
      return undefined;
    const target = parent();
    if (target === undefined) return undefined;
    const command = hierarchyDropCommand(state.get('draggingTaskNode'), target);
    return command !== undefined &&
      livePath(tasks.queries, command.source) !== undefined &&
      livePath(tasks.queries, command.parent) !== undefined
      ? command
      : undefined;
  }
  #observe(command: Extract<TaskCommand, { type: 'reparent-task' }>): (() => void) | undefined {
    const OwnerMutationObserver = this.surface.ownerDocument.defaultView?.MutationObserver;
    if (OwnerMutationObserver === undefined) return undefined;
    const { state, tasks } = this.options;
    const offDrag = state.on('draggingTaskNode', this.#clear);
    const offSelection = state.on('taskStack', this.#clear);
    const offMode = state.on('mode', this.#clear);
    const offQueries = tasks.queries.subscribe(() => {
      if (
        livePath(tasks.queries, command.source) === undefined ||
        livePath(tasks.queries, command.parent) === undefined
      )
        this.#clear();
    });
    const observer = new OwnerMutationObserver(() => {
      if (!this.surface.isConnected) this.#clear();
    });
    observer.observe(this.surface.ownerDocument, { childList: true, subtree: true });
    return () => {
      offDrag();
      offSelection();
      offMode();
      offQueries();
      observer.disconnect();
    };
  }
  readonly #over = (event: DragEvent): void => {
    if (event.defaultPrevented) return;
    const command = this.#eligible(event);
    const payload = this.options.state.get('draggingTaskNode');
    if (command === undefined || payload === null) {
      this.#clear();
      return;
    }
    if (this.#preview === undefined) {
      this.#releasePreview = this.#observe(command);
      if (this.#releasePreview === undefined) return;
      this.#preview = { payload, parent: command.parent };
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer != null) event.dataTransfer.dropEffect = 'move';
    this.surface.classList.add('abyss-drop-target');
  };
  readonly #leave = (event: DragEvent): void => {
    if (!this.surface.contains(event.relatedTarget as Node | null)) this.#clear();
  };
  readonly #drop = (event: DragEvent): void => {
    const command = this.#eligible(event);
    const captured = this.#preview;
    this.#clear();
    if (captured === undefined) return;
    const payload = this.options.state.get('draggingTaskNode');
    if (
      command === undefined ||
      captured.payload !== payload ||
      !sameTaskNodeRef(command.parent, captured.parent)
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    // Claim the single physical payload before starting a command, including duplicate occurrences.
    this.options.state.set('draggingTaskNode', null);
    runAsyncAction(this.options.execute(command));
  };
  dispose(): void {
    this.#clear();
    this.surface.removeEventListener('dragover', this.#over);
    this.surface.removeEventListener('dragleave', this.#leave);
    this.surface.removeEventListener('drop', this.#drop);
  }
}
function specificDrag(state: AppState, event: DragEvent): boolean {
  const tag = state.get('draggingTag');
  const project = state.get('draggingProject');
  return (
    (tag !== null && tag !== '') ||
    (project !== null && project !== '') ||
    event.dataTransfer?.types.includes('Files') === true
  );
}

/** Map only a captured exact descendant path relative to the command-owned moved subtree. */
function movedSelection(
  selection: readonly TaskSelectionNode[],
  source: TaskNodeRef,
  moved: { readonly root: TaskSnapshot; readonly target: TaskNodeRef },
): TaskSelectionNode[] | undefined {
  const selectedRoot = selection[0];
  if (selectedRoot === undefined || !('source' in selectedRoot)) return undefined;
  const start = selection.findIndex((node) => sameTaskNodeRef(taskNodeRef(node), source));
  if (start === -1) return undefined;
  if (!exactSelectionPath(selectedRoot, selection)) return undefined;
  const destination = pathInRoot(moved.root, moved.target);
  if (destination === undefined) return undefined;
  return carryDescendants(destination, selection.slice(start));
}
function exactSelectionPath(root: TaskSnapshot, selection: readonly TaskSelectionNode[]): boolean {
  const selected = selection[selection.length - 1];
  const path = selected === undefined ? undefined : taskSelectionPath(root, selected);
  return (
    path?.length === selection.length &&
    path.every((node, index) => {
      const captured = selection[index];
      return captured !== undefined && sameTaskNodeRef(taskNodeRef(node), taskNodeRef(captured));
    })
  );
}
function carryDescendants(
  destination: TaskSelectionNode[],
  subtree: readonly TaskSelectionNode[],
): TaskSelectionNode[] | undefined {
  const stack = [...destination];
  for (let index = 1; index < subtree.length; index++) {
    const before = subtree[index - 1];
    const child = subtree[index];
    if (before === undefined || child === undefined) return undefined;
    const places = before.subtasks.flatMap((node, at) =>
      sameTaskNodeRef(taskNodeRef(node), taskNodeRef(child)) ? [at] : [],
    );
    const at = places.length === 1 ? places[0] : undefined;
    const successor = at === undefined ? undefined : stack[stack.length - 1]?.subtasks[at];
    if (successor === undefined) return undefined;
    stack.push(successor);
  }
  return stack;
}
type HierarchyCommand = Extract<TaskCommand, { type: 'reparent-task' | 'promote-subtask' }>;
type HierarchyOutcome = Extract<
  Extract<TaskCommandResult, { type: 'ok' }>['outcome'],
  { type: 'hierarchy' }
>;
function changedHierarchyOutcome(
  result: TaskCommandResult,
  source: TaskNodeRef,
): HierarchyOutcome | undefined {
  return result.type === 'ok' &&
    result.changed &&
    result.outcome.type === 'hierarchy' &&
    sameTaskNodeRef(result.outcome.source, source)
    ? result.outcome
    : undefined;
}

function hierarchySource(command: HierarchyCommand): TaskNodeRef {
  return command.type === 'reparent-task'
    ? command.source
    : { type: 'subtask', ref: command.subtask };
}
function hierarchyRemovalHold(state: AppState, command: HierarchyCommand): () => void {
  return command.type === 'reparent-task' && command.source.type === 'task'
    ? state.beginTaskRemoval(command.source.ref)
    : () => {};
}
function unknownHierarchyResult(command: HierarchyCommand): TaskCommandResult {
  const source = hierarchySource(command);
  return {
    type: 'partial',
    operation: 'hierarchy',
    recovery: {
      source,
      sourcePath: rootTaskNodeRef(source).filePath,
      destinationPath: rootTaskNodeRef(command.type === 'reparent-task' ? command.parent : source)
        .filePath,
      state: 'unknown',
      cause: 'io-error',
    },
  };
}

/** One presentation boundary owns failures and success selection for both hierarchy surfaces. */
export async function executeTaskHierarchy(
  state: AppState,
  tasks: TaskApplicationApi,
  command: Extract<TaskCommand, { type: 'reparent-task' | 'promote-subtask' }>,
  active: () => boolean,
): Promise<void> {
  const source = hierarchySource(command);
  const selection = [...state.get('taskStack')];
  const intent = state.taskSelectionIntentGeneration;
  const release = hierarchyRemovalHold(state, command);
  try {
    let result: TaskCommandResult;
    try {
      result = await tasks.execute(command);
    } catch (error: unknown) {
      console.error('[abyss-tasks] Could not transfer task hierarchy', { command, error });
      result = unknownHierarchyResult(command);
    }
    presentTaskCommandResult(result);
    const outcome = changedHierarchyOutcome(result, source);
    if (outcome === undefined || state.taskSelectionIntentGeneration !== intent || !active())
      return;
    const successor = movedSelection(selection, source, outcome.moved);
    if (successor !== undefined && livePath(tasks.queries, outcome.moved.target) !== undefined) {
      state.batch(() => {
        state.set('inspectorBackStack', []);
        state.updateInspectorSelection(successor);
      });
    }
  } finally {
    release();
  }
}
