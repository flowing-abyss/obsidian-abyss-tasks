import { getListViewDefaults } from '../settings/defaults';
import type { ListViewState } from '../settings/types';
import type { TaskSnapshot } from '../tasks';
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
}

type Listener<T> = (value: T, prev: T) => void;
type CommitListener = (changed: ReadonlySet<keyof AppStateData>) => void;

interface PendingChange {
  prev: unknown;
  value: unknown;
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
  };

  private listeners = new Map<keyof AppStateData, Set<Listener<unknown>>>();
  private commitListeners = new Set<CommitListener>();
  private pendingChanges = new Map<keyof AppStateData, PendingChange>();
  private batchDepth = 0;

  get<K extends keyof AppStateData>(key: K): AppStateData[K] {
    return this.data[key];
  }

  set<K extends keyof AppStateData>(key: K, value: AppStateData[K]): void {
    const prev = this.data[key];
    if (prev === value) return;
    this.data[key] = value;
    if (this.batchDepth > 0) {
      const pending = this.pendingChanges.get(key);
      if (pending) pending.value = value;
      else this.pendingChanges.set(key, { prev, value });
      return;
    }
    this.notifyKey(key, value, prev);
    this.notifyCommit(new Set([key]));
  }

  batch(run: () => void): void {
    this.batchDepth += 1;
    try {
      run();
    } finally {
      this.batchDepth -= 1;
      if (this.batchDepth === 0) this.flushPendingChanges();
    }
  }

  onCommit(listener: CommitListener): () => void {
    this.commitListeners.add(listener);
    return () => {
      this.commitListeners.delete(listener);
    };
  }

  private flushPendingChanges(): void {
    const changes = this.pendingChanges;
    this.pendingChanges = new Map();
    for (const [key, change] of changes) {
      this.notifyKey(key, change.value, change.prev);
    }
    this.notifyCommit(new Set(changes.keys()));
  }

  private notifyKey(key: keyof AppStateData, value: unknown, prev: unknown): void {
    const bucket = this.listeners.get(key);
    if (bucket) {
      for (const cb of bucket) cb(value, prev);
    }
  }

  private notifyCommit(changed: ReadonlySet<keyof AppStateData>): void {
    for (const listener of this.commitListeners) listener(changed);
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
