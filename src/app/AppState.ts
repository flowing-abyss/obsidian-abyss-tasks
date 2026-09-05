import { getListViewDefaults } from '../settings/defaults';
import type { ListViewState } from '../settings/types';
import {
  cloneTaskSnapshot,
  sameTaskNodeRef,
  type TaskNodeSnapshot,
  type TaskSnapshot,
} from '../tasks';
import { taskNodeRef, type TaskSelectionNode } from '../ui/taskSelection';

export type ViewMode = 'tasks' | 'calendar' | 'search' | 'projects';

export type ListSelection =
  | 'inbox'
  | 'today'
  | 'upcoming'
  | { type: 'tag'; tag: string }
  | { type: 'group'; groupId: string }
  | { type: 'project'; path: string };

type ProjectsPanelState = { view: 'list' } | { view: 'dashboard'; path: string };

export interface InspectorHistoryFrame {
  readonly taskStack: readonly TaskSelectionNode[];
}

export interface AppStateData {
  mode: ViewMode;
  selectedList: ListSelection;
  taskStack: TaskSelectionNode[];
  readonly inspectorBackStack: readonly InspectorHistoryFrame[];
  centerFilter: string;
  searchQuery: string;
  draggingTask: TaskSnapshot | null;
  draggingTag: string | null;
  draggingProject: string | null;
  centerListViewState: ListViewState;
  projectsPanel: ProjectsPanelState;
}

type Listener<T> = (value: T, prev: T) => void;
type CommitListener = (changed: ReadonlySet<keyof AppStateData>) => void;

interface PendingChange {
  prev: unknown;
  value: unknown;
}

class AppStateReentrantMutationError extends Error {
  constructor(readonly key: keyof AppStateData) {
    super(`Cannot set AppState.${String(key)} during notification delivery`);
    this.name = 'AppStateReentrantMutationError';
  }
}

function immutableChangedSet(
  values: Iterable<keyof AppStateData>,
): ReadonlySet<keyof AppStateData> {
  const changed = new Set(values);
  const rejectMutation = (): never => {
    throw new TypeError('AppState commit changes are immutable');
  };
  Object.defineProperties(changed, {
    add: { value: rejectMutation },
    delete: { value: rejectMutation },
    clear: { value: rejectMutation },
  });
  return Object.freeze(changed);
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Accept only a complete exact path; never repair an invalid history into another task. */
function inspectorFrame(stack: readonly TaskSelectionNode[]): InspectorHistoryFrame | undefined {
  const first = stack[0];
  if (first === undefined || !('source' in first)) return undefined;
  const detached: TaskSelectionNode[] = [cloneTaskSnapshot(first)];
  for (const node of stack.slice(1)) {
    const children = detached[detached.length - 1]?.subtasks.filter((candidate) =>
      sameTaskNodeRef(taskNodeRef(candidate), taskNodeRef(node)),
    );
    if (children?.length !== 1 || children[0] === undefined) return undefined;
    detached.push(children[0]);
  }
  return freeze({ taskStack: detached });
}

function sameInspectorFrame(left: InspectorHistoryFrame, right: InspectorHistoryFrame): boolean {
  return (
    left.taskStack.length === right.taskStack.length &&
    left.taskStack.every((node, index) => {
      const other = right.taskStack[index];
      return other !== undefined && sameTaskNodeRef(taskNodeRef(node), taskNodeRef(other));
    })
  );
}

export class AppState {
  private data: AppStateData = {
    mode: 'tasks',
    selectedList: 'today',
    taskStack: [],
    inspectorBackStack: Object.freeze([]),
    centerFilter: '',
    searchQuery: '',
    draggingTask: null,
    draggingTag: null,
    draggingProject: null,
    centerListViewState: getListViewDefaults('today'),
    projectsPanel: { view: 'list' },
  };

  private readonly listeners = new Map<keyof AppStateData, Set<Listener<unknown>>>();
  private readonly commitListeners = new Set<CommitListener>();
  private pendingChanges = new Map<keyof AppStateData, PendingChange>();
  private batchDepth = 0;
  private delivering = false;

  get<K extends keyof AppStateData>(key: K): AppStateData[K] {
    return this.data[key];
  }

  set<K extends keyof AppStateData>(key: K, value: AppStateData[K]): void {
    if (key === 'taskStack' && this.data.inspectorBackStack.length > 0) {
      this.batch(() => {
        this.setValue('inspectorBackStack', Object.freeze([]));
        this.setValue(key, value);
      });
      return;
    }
    if (key === 'inspectorBackStack') {
      const frames = (value as AppStateData['inspectorBackStack']).flatMap((frame) => {
        const detached = inspectorFrame(frame.taskStack);
        return detached === undefined ? [] : [detached];
      });
      this.setValue('inspectorBackStack', Object.freeze(frames));
      return;
    }
    this.setValue(key, value);
  }

  /** Refresh or navigate within the current frame without beginning a new selection. */
  updateInspectorSelection(stack: TaskSelectionNode[]): void {
    this.setValue('taskStack', stack);
  }

  /** Refresh proven frame successors without adding, popping, or selecting a frame. */
  updateInspectorHistoryFrames(frames: readonly InspectorHistoryFrame[]): void {
    const previous = this.data.inspectorBackStack;
    if (frames.length !== previous.length) return;
    const next = previous.map((frame, index) => {
      const candidate = frames[index];
      if (candidate === undefined || sameInspectorFrame(candidate, frame)) return frame;
      return inspectorFrame(candidate.taskStack) ?? frame;
    });
    if (next.every((frame, index) => frame === previous[index])) return;
    this.setValue('inspectorBackStack', Object.freeze(next));
  }

  openInspectorDependency(task: TaskNodeSnapshot): void {
    const destination = inspectorFrame([task.root, ...task.path]);
    if (destination === undefined) return;
    const selected = destination.taskStack[destination.taskStack.length - 1];
    const current = this.data.taskStack[this.data.taskStack.length - 1];
    if (selected === undefined || !sameTaskNodeRef(taskNodeRef(selected), task.target)) return;
    if (current !== undefined && sameTaskNodeRef(taskNodeRef(current), task.target)) return;
    const previous = inspectorFrame(this.data.taskStack);
    this.batch(() => {
      if (previous !== undefined) {
        this.setValue(
          'inspectorBackStack',
          Object.freeze([...this.data.inspectorBackStack, previous]),
        );
      }
      this.updateInspectorSelection(freeze([...destination.taskStack]));
    });
  }

  /** A presentation owner may supply a query-validated live successor before the atomic pop. */
  backInspectorDependency(resolvedStack?: readonly TaskSelectionNode[]): boolean {
    const frames = this.data.inspectorBackStack;
    const previous = frames[frames.length - 1];
    if (previous === undefined) return false;
    const destination = resolvedStack === undefined ? previous : inspectorFrame(resolvedStack);
    if (destination === undefined) return false;
    this.batch(() => {
      this.setValue('inspectorBackStack', Object.freeze(frames.slice(0, -1)));
      this.updateInspectorSelection(freeze([...destination.taskStack]));
    });
    return true;
  }

  private setValue<K extends keyof AppStateData>(key: K, value: AppStateData[K]): void {
    const prev = this.data[key];
    if (prev === value) return;
    if (this.delivering) throw new AppStateReentrantMutationError(key);
    this.data[key] = value;
    if (this.batchDepth > 0) {
      const pending = this.pendingChanges.get(key);
      if (pending != null) pending.value = value;
      else this.pendingChanges.set(key, { prev, value });
      return;
    }
    this.publishStandaloneChange(key, value, prev);
  }

  batch(run: () => void): void {
    this.batchDepth += 1;
    try {
      run();
    } finally {
      this.batchDepth -= 1;
      if (this.batchDepth === 0 && !this.delivering) this.flushPendingChanges(true);
    }
  }

  onCommit(listener: CommitListener): () => void {
    this.commitListeners.add(listener);
    return () => {
      this.commitListeners.delete(listener);
    };
  }

  private flushPendingChanges(forceCommit = false): void {
    if (this.delivering || (!forceCommit && this.pendingChanges.size === 0)) return;
    const changes = new Map(
      [...this.pendingChanges].filter(([, change]) => change.prev !== change.value),
    );
    this.pendingChanges = new Map();
    this.delivering = true;
    const errors: unknown[] = [];
    try {
      for (const [key, change] of changes) {
        this.notifyBatchKey(key, change.value, change.prev, errors);
      }
      this.notifyCommit(immutableChangedSet(changes.keys()), errors);
    } finally {
      this.delivering = false;
    }
    this.throwDeliveryErrors(errors);
  }

  private notifyBatchKey(
    key: keyof AppStateData,
    value: unknown,
    prev: unknown,
    errors: unknown[],
  ): void {
    const bucket = this.listeners.get(key);
    if (bucket == null) return;
    for (const cb of [...bucket]) {
      try {
        cb(value, prev);
      } catch (error) {
        errors.push(error);
      }
    }
  }

  private publishStandaloneChange(key: keyof AppStateData, value: unknown, prev: unknown): void {
    const errors: unknown[] = [];
    this.delivering = true;
    try {
      this.notifyBatchKey(key, value, prev, errors);
      this.notifyCommit(immutableChangedSet([key]), errors);
    } finally {
      this.delivering = false;
    }
    this.throwDeliveryErrors(errors);
  }

  private notifyCommit(changed: ReadonlySet<keyof AppStateData>, errors: unknown[]): void {
    for (const listener of [...this.commitListeners]) {
      try {
        listener(changed);
      } catch (error) {
        errors.push(error);
      }
    }
  }

  private throwDeliveryErrors(errors: readonly unknown[]): void {
    if (errors.length === 0) return;
    if (errors.length === 1) throw errors[0];
    const error = new Error(`${errors.length} AppState listeners failed`) as Error & {
      errors: readonly unknown[];
    };
    Object.defineProperty(error, 'errors', {
      value: Object.freeze([...errors]),
      enumerable: true,
    });
    throw error;
  }

  on<K extends keyof AppStateData>(key: K, listener: Listener<AppStateData[K]>): () => void {
    let bucket = this.listeners.get(key);
    if (bucket === undefined) {
      bucket = new Set();
      this.listeners.set(key, bucket);
    }
    bucket.add(listener as Listener<unknown>);
    return () => {
      bucket.delete(listener as Listener<unknown>);
    };
  }
}
