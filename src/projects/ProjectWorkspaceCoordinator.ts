import type { ProjectStatus } from '../settings/types';
import type { TaskIndexEvent, TaskIndexSettledEvent, TaskQueryApi } from '../tasks';
import type { ProjectStoreEvent, ProjectStoreSettledEvent } from './ProjectStore';
import { ProjectWorkspaceReadModel } from './ProjectWorkspaceReadModel';
import type { Project, ProjectWorkspaceSnapshot } from './types';
import type {
  WorkNoteIndexEvent,
  WorkNoteIndexSettledEvent,
  WorkNoteSnapshot,
} from './work-notes/types';

type Source = 'project' | 'task' | 'work-note';

interface ProjectSource {
  isReady?(): boolean;
  list(): readonly Project[];
  onUpdate(listener: (event: ProjectStoreEvent) => void): () => void;
  onSettled?(listener: (event: ProjectStoreSettledEvent) => void): () => void;
}

type TaskSource = Pick<TaskQueryApi, 'isReady' | 'list' | 'subscribe' | 'subscribeSettled'>;

interface WorkNoteSource {
  isReady?(): boolean;
  list(): readonly WorkNoteSnapshot[];
  diagnosticsFor(path: string): readonly WorkNoteSnapshot['diagnostics'][number][];
  onUpdate(listener: (event: WorkNoteIndexEvent) => void): () => void;
  onSettled?(listener: (event: WorkNoteIndexSettledEvent) => void): () => void;
}

interface PendingPath {
  readonly required: Map<Source, number>;
}

export interface ProjectWorkspacePublication {
  readonly snapshots: readonly ProjectWorkspaceSnapshot[];
  readonly projectPaths: readonly string[];
}

function taskEventPaths(event: TaskIndexEvent): readonly string[] {
  if (event.type === 'changed') return event.files;
  if (event.type === 'renamed') return [event.oldPath, event.newPath];
  if (event.type === 'deleted') return [event.path];
  if (event.type === 'settled') return event.files.map(({ path }) => path);
  return [];
}

function snapshotSignature(snapshots: readonly ProjectWorkspaceSnapshot[]): string {
  return JSON.stringify(
    snapshots.map((snapshot) => ({
      ...snapshot,
      milestoneRollups: [...snapshot.milestoneRollups.entries()],
    })),
  );
}

export class ProjectWorkspaceCoordinator {
  readonly readModel: ProjectWorkspaceReadModel;
  private unsubs: Array<() => void> = [];
  private listeners = new Set<
    (snapshots: readonly ProjectWorkspaceSnapshot[], event: ProjectWorkspacePublication) => void
  >();
  private latest = new Map<Source, Map<string, number>>([
    ['project', new Map()],
    ['task', new Map()],
    ['work-note', new Map()],
  ]);
  private pending = new Map<string, PendingPath>();
  private projectPaths = new Set<string>();
  private workNotePaths = new Set<string>();
  private ownCommitPaths = new Set<string>();
  private taskInFlight = new Map<string, number>();
  private invalidatedProjectPaths = new Set<string>();
  private publishScheduled = false;
  private started = false;
  private signature = '[]';
  private readySources = new Set<Source>();
  private awaitingInitialization = false;

  constructor(
    private readonly projects: ProjectSource,
    private readonly tasks: TaskSource,
    private readonly workNotes: WorkNoteSource,
    statuses: () => readonly ProjectStatus[],
    options: {
      readonly now?: () => number;
      readonly today?: () => string;
    } = {},
  ) {
    this.readModel = new ProjectWorkspaceReadModel({
      projects,
      tasks,
      workNotes,
      statuses,
      ...options,
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubs.push(
      this.projects.onUpdate((event) => this.onProjectUpdate(event)),
      this.tasks.subscribe((event) => this.onTaskEvent(event)),
      this.workNotes.onUpdate((event) => this.onWorkNoteUpdate(event)),
    );
    if (this.projects.onSettled) {
      this.unsubs.push(this.projects.onSettled((event) => this.onProjectSettled(event)));
    }
    if (this.tasks.subscribeSettled) {
      this.unsubs.push(this.tasks.subscribeSettled((event) => this.onTaskSettled(event)));
    }
    if (this.workNotes.onSettled) {
      this.unsubs.push(this.workNotes.onSettled((event) => this.onWorkNoteSettled(event)));
    }
    for (const [source, candidate] of [
      ['project', this.projects],
      ['task', this.tasks],
      ['work-note', this.workNotes],
    ] as const) {
      if (candidate.isReady?.() !== false) this.readySources.add(source);
    }
    this.awaitingInitialization = this.readySources.size < 3;
    if (!this.awaitingInitialization) {
      const initial = this.readModel.rebuild();
      this.signature = snapshotSignature(initial);
      this.captureOwnership();
    }
  }

  list(): readonly ProjectWorkspaceSnapshot[] {
    return this.readModel.list();
  }

  get(projectPath: string): ProjectWorkspaceSnapshot | undefined {
    return this.readModel.get(projectPath);
  }

  onUpdate(
    listener: (
      snapshots: readonly ProjectWorkspaceSnapshot[],
      event: ProjectWorkspacePublication,
    ) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  absorbOwnCommit(paths: readonly string[]): void {
    for (const path of paths) this.ownCommitPaths.add(path);
  }

  private captureOwnership(): void {
    this.projectPaths = new Set(this.projects.list().map(({ path }) => path));
    this.workNotePaths = new Set(this.workNotes.list().map(({ path }) => path));
  }

  private requireAtLeast(path: string, source: Source, generation: number): void {
    const current = this.pending.get(path) ?? { required: new Map<Source, number>() };
    const previous = current.required.get(source) ?? 0;
    current.required.set(source, Math.max(previous, generation));
    this.pending.set(path, current);
    this.scheduleIfReady();
  }

  private requireNext(path: string, source: Source): void {
    const current = this.pending.get(path);
    if (current?.required.has(source)) return;
    this.requireAtLeast(path, source, (this.latest.get(source)?.get(path) ?? 0) + 1);
  }

  private sourcesFor(path: string): readonly Source[] {
    if (this.projectPaths.has(path)) return ['task', 'project'];
    if (this.workNotePaths.has(path)) return ['task', 'work-note'];
    return [];
  }

  private onProjectUpdate(event: ProjectStoreEvent | undefined): void {
    const paths = event?.invalidatedProjectPaths ?? [...this.projectPaths];
    for (const path of paths) this.requireNext(path, 'project');
  }

  private onTaskEvent(event: TaskIndexEvent): void {
    if (event.type === 'initialized' || event.type === 'settled') return;
    for (const path of taskEventPaths(event)) {
      const taskGeneration = (this.latest.get('task')?.get(path) ?? 0) + 1;
      this.taskInFlight.set(path, taskGeneration);
      const sources = this.sourcesFor(path);
      if (sources.length === 0) continue;
      this.requireAtLeast(path, 'task', taskGeneration);
      for (const source of sources) {
        if (source !== 'task') this.requireNext(path, source);
      }
    }
  }

  private onWorkNoteUpdate(event: WorkNoteIndexEvent): void {
    const currentPaths = new Set(this.workNotes.list().map(({ path }) => path));
    for (const { path, generation } of event.taskBarriers) {
      this.requireAtLeast(path, 'task', generation);
    }
    for (const path of event.changedPaths) {
      this.requireNext(path, 'work-note');
      if (currentPaths.has(path)) this.workNotePaths.add(path);
    }
    for (const projectPath of event.invalidatedProjectPaths) {
      this.invalidatedProjectPaths.add(projectPath);
    }
  }

  private observe(source: Source, path: string, generation: number): void {
    this.latest.get(source)!.set(path, generation);
    this.scheduleIfReady();
  }

  private markInitialized(source: Source): void {
    this.readySources.add(source);
    if (!this.awaitingInitialization || this.readySources.size < 3) return;
    this.awaitingInitialization = false;
    this.pending.clear();
    this.invalidatedProjectPaths.clear();
    const snapshots = this.readModel.rebuild();
    this.captureOwnership();
    this.signature = snapshotSignature(snapshots);
    const event: ProjectWorkspacePublication = {
      snapshots,
      projectPaths: snapshots
        .map(({ project }) => project.path)
        .sort((left, right) => left.localeCompare(right)),
    };
    for (const listener of this.listeners) listener(snapshots, event);
  }

  private onProjectSettled(event: ProjectStoreSettledEvent): void {
    for (const file of event.files) {
      this.observe('project', file.path, file.generation);
    }
    if (event.reason === 'initialization') this.markInitialized('project');
  }

  private onTaskSettled(event: TaskIndexSettledEvent): void {
    for (const file of event.files) {
      this.observe('task', file.path, file.generation);
      if (event.reason === 'initialization') continue;
      this.taskInFlight.delete(file.path);
      this.ownCommitPaths.delete(file.path);
      if (!this.pending.has(file.path)) {
        const sources = this.sourcesFor(file.path);
        if (sources.length > 0) {
          this.requireAtLeast(file.path, 'task', file.generation);
          for (const source of sources) {
            if (source !== 'task') this.requireNext(file.path, source);
          }
        }
      }
    }
    if (event.reason === 'initialization') this.markInitialized('task');
  }

  private onWorkNoteSettled(event: WorkNoteIndexSettledEvent): void {
    for (const file of event.files) {
      this.observe('work-note', file.path, file.generation);
    }
    if (event.reason === 'initialization') this.markInitialized('work-note');
  }

  private allPendingReady(): boolean {
    if (this.pending.size === 0) return false;
    for (const [path, pending] of this.pending) {
      for (const [source, generation] of pending.required) {
        if ((this.latest.get(source)?.get(path) ?? 0) < generation) return false;
      }
    }
    return true;
  }

  private scheduleIfReady(): void {
    if (this.awaitingInitialization || !this.allPendingReady() || this.publishScheduled) return;
    this.publishScheduled = true;
    void Promise.resolve().then(() => {
      this.publishScheduled = false;
      if (!this.started || !this.allPendingReady()) return;
      const affectedProjectPaths = new Set<string>();
      for (const path of this.invalidatedProjectPaths) affectedProjectPaths.add(path);
      for (const path of this.pending.keys()) {
        if (this.projectPaths.has(path)) affectedProjectPaths.add(path);
        const note = this.workNotes.list().find((candidate) => candidate.path === path);
        if (note) affectedProjectPaths.add(note.projectPath);
      }
      this.pending.clear();
      this.invalidatedProjectPaths.clear();
      const snapshots = this.readModel.rebuild();
      this.captureOwnership();
      const nextSignature = snapshotSignature(snapshots);
      if (nextSignature === this.signature) return;
      this.signature = nextSignature;
      const event: ProjectWorkspacePublication = {
        snapshots,
        projectPaths: [...affectedProjectPaths].sort((left, right) => left.localeCompare(right)),
      };
      for (const listener of this.listeners) listener(snapshots, event);
    });
  }

  destroy(): void {
    if (!this.started) return;
    this.started = false;
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.listeners.clear();
    this.pending.clear();
    this.ownCommitPaths.clear();
    this.taskInFlight.clear();
    this.invalidatedProjectPaths.clear();
    this.readySources.clear();
    this.awaitingInitialization = false;
    this.publishScheduled = false;
  }
}
