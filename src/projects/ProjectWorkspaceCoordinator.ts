import type { ProjectStatus } from '../settings/types';
import type { TaskIndexEvent, TaskIndexSettledEvent, TaskQueryApi } from '../tasks';
import type { DependencyProjectionPort } from '../tasks/application/DependencyPolicyPort';
import type { ProjectStoreEvent, ProjectStoreSettledEvent } from './ProjectStore';
import {
  ProjectWorkspaceReadModel,
  type ProjectWorkspaceBucketDelta,
  type ProjectWorkspaceOwnership,
} from './ProjectWorkspaceReadModel';
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
  get(path: string): Project | undefined;
  onUpdate(listener: (event: ProjectStoreEvent) => void): () => void;
  onSettled?(listener: (event: ProjectStoreSettledEvent) => void): () => void;
}

type TaskSource = Pick<TaskQueryApi, 'isReady' | 'list' | 'subscribe' | 'subscribeSettled'>;

interface WorkNoteSource {
  isReady?(): boolean;
  list(): readonly WorkNoteSnapshot[];
  get(path: string): WorkNoteSnapshot | undefined;
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
  private workNoteOwnership = new Map<string, ProjectWorkspaceOwnership>();
  private pendingWorkNoteDeltas = new Map<
    string,
    NonNullable<ProjectWorkspaceBucketDelta['workNotes']>[number]
  >();
  private pendingTaskSources = new Map<
    string,
    NonNullable<ProjectWorkspaceBucketDelta['taskSources']>[number]
  >();
  private ownCommitPaths = new Set<string>();
  private taskInFlight = new Map<string, number>();
  private invalidatedProjectPaths = new Set<string>();
  private dependencyProjectPaths = new Set<string>();
  private publishScheduled = false;
  private publicationVersion = 0;
  private publicationWaiters: Array<{ readonly after: number; readonly resolve: () => void }> = [];
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
      readonly dependencies?: DependencyProjectionPort;
    } = {},
  ) {
    this.readModel = new ProjectWorkspaceReadModel({
      projects,
      tasks,
      workNotes,
      statuses,
      ...options,
    });
    this.dependencies = options.dependencies;
  }

  private readonly dependencies: DependencyProjectionPort | undefined;

  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubs.push(
      this.projects.onUpdate((event) => this.onProjectUpdate(event)),
      this.tasks.subscribe((event) => this.onTaskEvent(event)),
      this.workNotes.onUpdate((event) => this.onWorkNoteUpdate(event)),
    );
    if (this.dependencies) {
      this.unsubs.push(this.dependencies.subscribe((event) => this.onDependencyUpdate(event)));
    }
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

  /** Wait until task-settlement has rebuilt the joined Project/Work Note read model. */
  awaitTaskPublication(_event: TaskIndexSettledEvent): Promise<void> {
    if (!this.started || this.awaitingInitialization) return Promise.resolve();
    // A full TaskIndex rescan may enumerate unchanged files without producing
    // matching ProjectStore/WorkNote generations. Rebuild from all current
    // settled sources instead of waiting for a hypothetical future event.
    const snapshots = this.readModel.rebuild();
    this.captureOwnership();
    this.signature = snapshotSignature(snapshots);
    this.publicationVersion += 1;
    for (const waiter of this.publicationWaiters) waiter.resolve();
    this.publicationWaiters = [];
    const event: ProjectWorkspacePublication = {
      snapshots,
      projectPaths: snapshots.map(({ project }) => project.path).sort((a, b) => a.localeCompare(b)),
    };
    for (const listener of this.listeners) listener(snapshots, event);
    return Promise.resolve();
  }

  absorbOwnCommit(paths: readonly string[]): void {
    for (const path of paths) this.ownCommitPaths.add(path);
  }

  private captureOwnership(): void {
    this.projectPaths = new Set(this.projects.list().map(({ path }) => path));
    const workNotes = this.workNotes.list();
    this.workNotePaths = new Set(workNotes.map(({ path }) => path));
    this.workNoteOwnership = new Map(
      workNotes.map((note) => [
        note.path,
        {
          projectPath: note.projectPath,
          kind: note.kind,
          milestonePath: note.milestonePath ?? null,
        },
      ]),
    );
  }

  private currentWorkNoteOwnership(path: string): ProjectWorkspaceOwnership | null {
    const note = this.workNotes.get(path);
    return note
      ? {
          projectPath: note.projectPath,
          kind: note.kind,
          milestonePath: note.milestonePath ?? null,
        }
      : null;
  }

  private recordTaskSource(path: string): void {
    const before = new Set<string>();
    if (this.projectPaths.has(path)) before.add(path);
    const previousOwner = this.workNoteOwnership.get(path);
    if (previousOwner) before.add(previousOwner.projectPath);
    const after = new Set<string>();
    if (this.projects.get(path)) after.add(path);
    const currentOwner = this.currentWorkNoteOwnership(path);
    if (currentOwner) after.add(currentOwner.projectPath);
    const existing = this.pendingTaskSources.get(path);
    this.pendingTaskSources.set(path, {
      path,
      beforeProjectPaths: existing?.beforeProjectPaths ?? [...before],
      afterProjectPaths: [...after],
    });
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
    for (const path of paths) {
      this.invalidatedProjectPaths.add(path);
      this.requireNext(path, 'project');
    }
  }

  private onTaskEvent(event: TaskIndexEvent): void {
    if (event.type === 'initialized' || event.type === 'settled') return;
    for (const path of taskEventPaths(event)) {
      this.recordTaskSource(path);
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
    for (const { path, generation } of event.taskBarriers) {
      this.recordTaskSource(path);
      this.requireAtLeast(path, 'task', generation);
    }
    for (const path of event.changedPaths) {
      const existing = this.pendingWorkNoteDeltas.get(path);
      this.pendingWorkNoteDeltas.set(path, {
        path,
        before: existing?.before ?? this.workNoteOwnership.get(path) ?? null,
        after: this.currentWorkNoteOwnership(path),
      });
      this.requireNext(path, 'work-note');
      if (this.workNotes.get(path)) this.workNotePaths.add(path);
    }
    for (const projectPath of event.invalidatedProjectPaths) {
      this.invalidatedProjectPaths.add(projectPath);
    }
  }

  private onDependencyUpdate(
    event: import('../tasks/application/DependencyPolicyPort').DependencyProjectionUpdate,
  ): void {
    for (const path of new Set(event.affected.map((ref) => ref.filePath))) {
      const projectPath = this.projectPaths.has(path)
        ? path
        : (this.workNotes.get(path)?.projectPath ?? this.workNoteOwnership.get(path)?.projectPath);
      if (!projectPath) continue;
      this.invalidatedProjectPaths.add(projectPath);
      this.dependencyProjectPaths.add(projectPath);
    }
    for (const path of event.causalTaskPaths) this.requireNext(path, 'task');
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
    this.pendingWorkNoteDeltas.clear();
    this.pendingTaskSources.clear();
    this.dependencyProjectPaths.clear();
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
          this.recordTaskSource(file.path);
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
      const delta: ProjectWorkspaceBucketDelta = {
        projectPaths: [...this.invalidatedProjectPaths],
        workNotes: [...this.pendingWorkNoteDeltas.values()],
        taskSources: [...this.pendingTaskSources.values()],
        dependencyProjectPaths: [...this.dependencyProjectPaths],
      };
      this.pending.clear();
      this.invalidatedProjectPaths.clear();
      this.pendingWorkNoteDeltas.clear();
      this.pendingTaskSources.clear();
      this.dependencyProjectPaths.clear();
      const result = this.readModel.rebuildBuckets(delta);
      const snapshots = result.snapshots;
      this.applyOwnershipDelta(delta);
      this.publicationVersion += 1;
      const ready = this.publicationWaiters.filter(({ after }) => after < this.publicationVersion);
      this.publicationWaiters = this.publicationWaiters.filter(
        ({ after }) => after >= this.publicationVersion,
      );
      for (const waiter of ready) waiter.resolve();
      if (result.changedProjectPaths.length === 0) return;
      this.signature = snapshotSignature(snapshots);
      const event: ProjectWorkspacePublication = {
        snapshots,
        projectPaths: result.changedProjectPaths,
      };
      for (const listener of this.listeners) listener(snapshots, event);
    });
  }

  private applyOwnershipDelta(delta: ProjectWorkspaceBucketDelta): void {
    for (const projectPath of delta.projectPaths ?? []) {
      if (this.projects.get(projectPath)) this.projectPaths.add(projectPath);
      else this.projectPaths.delete(projectPath);
    }
    for (const change of delta.workNotes ?? []) {
      if (change.before && change.after === null) {
        this.workNotePaths.delete(change.path);
        this.workNoteOwnership.delete(change.path);
      } else if (change.after) {
        this.workNotePaths.add(change.path);
        this.workNoteOwnership.set(change.path, change.after);
      }
    }
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
    this.pendingWorkNoteDeltas.clear();
    this.pendingTaskSources.clear();
    this.dependencyProjectPaths.clear();
    this.readySources.clear();
    this.awaitingInitialization = false;
    this.publishScheduled = false;
    for (const waiter of this.publicationWaiters) waiter.resolve();
    this.publicationWaiters = [];
  }
}
