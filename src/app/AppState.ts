import { getListViewDefaults } from '../settings/defaults';
import type { ListViewState } from '../settings/types';
import type { TaskSnapshot } from '../tasks';
import type { InspectorFocusOrigin, InspectorSelection } from '../ui/inspector/InspectorSelection';
import type { TaskSelectionNode } from '../ui/taskSelection';

export type ViewMode = 'tasks' | 'calendar' | 'search' | 'projects';

export type ListSelection =
  | 'inbox'
  | 'today'
  | 'upcoming'
  | { type: 'tag'; tag: string }
  | { type: 'group'; groupId: string }
  | { type: 'project'; path: string };

type ProjectsPanelState = { view: 'list' } | { view: 'dashboard'; path: string };

export interface AppStateData {
  mode: ViewMode;
  selectedList: ListSelection;
  taskStack: TaskSelectionNode[];
  centerFilter: string;
  searchQuery: string;
  draggingTask: TaskSnapshot | null;
  draggingTag: string | null;
  draggingProject: string | null;
  centerListViewState: ListViewState;
  projectsPanel: ProjectsPanelState;
  inspectorSelection: InspectorSelection | null;
  /** Ephemeral trigger used only to restore focus when a narrow inspector closes. */
  inspectorOrigin: InspectorFocusOrigin | null;
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

export class AppState {
  private data: AppStateData = {
    mode: 'tasks',
    selectedList: 'today',
    taskStack: [],
    centerFilter: '',
    searchQuery: '',
    draggingTask: null,
    draggingTag: null,
    draggingProject: null,
    centerListViewState: getListViewDefaults('today'),
    projectsPanel: { view: 'list' },
    inspectorSelection: null,
    inspectorOrigin: null,
  };

  private listeners = new Map<keyof AppStateData, Set<Listener<unknown>>>();
  private commitListeners = new Set<CommitListener>();
  private pendingChanges = new Map<keyof AppStateData, PendingChange>();
  private batchDepth = 0;
  private delivering = false;

  get<K extends keyof AppStateData>(key: K): AppStateData[K] {
    return this.data[key];
  }

  set<K extends keyof AppStateData>(key: K, value: AppStateData[K]): void {
    const prev = this.data[key];
    if (prev === value) return;
    if (this.delivering) throw new AppStateReentrantMutationError(key);
    this.data[key] = value;
    if (this.batchDepth > 0) {
      const pending = this.pendingChanges.get(key);
      if (pending) pending.value = value;
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
    if (!bucket) return;
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
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    const bucket = this.listeners.get(key)!;
    bucket.add(listener as Listener<unknown>);
    return () => {
      bucket.delete(listener as Listener<unknown>);
    };
  }
}
