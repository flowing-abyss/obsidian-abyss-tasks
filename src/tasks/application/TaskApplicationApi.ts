import type { TaskCommand, TaskCommandResult } from '../domain/commands';
import type { TaskResolution } from '../domain/taskReconciliation';
import type {
  DateRange,
  LocalDate,
  SubtaskSnapshot,
  TaskDestination,
  TaskNodeRef,
  TaskRef,
  TaskSnapshot,
  TaskStatus,
} from '../domain/types';

export interface TaskQuery {
  readonly filePath?: string;
  readonly folder?: string;
  readonly tag?: string;
  readonly statuses?: readonly TaskStatus[];
  readonly dateRange?: DateRange;
}

interface TaskIndexFileSettlement {
  readonly path: string;
  readonly generation: number;
}

export type TaskIndexSettledEvent =
  | {
      readonly type: 'settled';
      readonly reason: 'index' | 'initialization';
      readonly files: readonly TaskIndexFileSettlement[];
    }
  | {
      readonly type: 'settled';
      readonly reason: 'topology';
      readonly topology: {
        readonly type: 'folder-rename';
        readonly oldPath: string;
        readonly newPath: string;
      };
      readonly files: readonly TaskIndexFileSettlement[];
    };

export type TaskIndexEvent =
  | { readonly type: 'initialized' }
  | { readonly type: 'changed'; readonly files: readonly string[] }
  | { readonly type: 'renamed'; readonly oldPath: string; readonly newPath: string }
  | { readonly type: 'deleted'; readonly path: string }
  | TaskIndexSettledEvent;

export interface CalendarTaskSource {
  readonly root: TaskSnapshot;
  readonly target: TaskNodeRef;
  readonly node: TaskSnapshot | SubtaskSnapshot;
}

export interface CalendarProjectionSources {
  readonly materialized: readonly CalendarTaskSource[];
  readonly recurringSources: readonly CalendarTaskSource[];
}

export interface TaskQueryApi {
  isReady?(): boolean;
  list(query?: TaskQuery): readonly TaskSnapshot[];
  forCalendarProjection(dates: readonly LocalDate[]): CalendarProjectionSources;
  resolve(ref: TaskRef): TaskResolution;
  subscribe(listener: (event: TaskIndexEvent) => void): () => void;
  /** Optional compatibility port for consumers that coordinate completed per-file parses. */
  subscribeSettled?(listener: (event: TaskIndexSettledEvent) => void): () => void;
}

export interface TaskApplicationApi {
  readonly queries: TaskQueryApi;
  execute(command: TaskCommand): Promise<TaskCommandResult>;
  /** Produces a fresh Tasks-compatible ID; uniqueness remains validator-authoritative. */
  newDependencyId?(): string;
  setDependency?(intent: DependencyCommandIntent): Promise<TaskCommandResult>;
  clearDependency?(intent: DependencyClearIntent): Promise<TaskCommandResult>;
  applyRootTagChanges?(intent: TaskRootTagChangesIntent): Promise<TaskCommandResult>;
}

export interface DependencyCommandIntent {
  readonly prerequisite: TaskRef;
  readonly dependent: TaskRef;
  /** Proposed Tasks-compatible ID, used only when the prerequisite has no ID yet. */
  readonly dependencyId: string;
  readonly enabled: boolean;
}

export interface DependencyClearIntent {
  readonly dependent: TaskRef;
  readonly dependencyId: string;
}

interface TaskRootTagChange {
  readonly task: TaskSnapshot;
  readonly tags: {
    readonly add?: readonly string[];
    readonly remove?: readonly string[];
  };
}

/** Neutral ordered root-tag intent used by any feature that coordinates canonical task roots. */
export interface TaskRootTagChangesIntent {
  readonly primary: TaskRef;
  readonly changes: readonly TaskRootTagChange[];
}

export type CreateTaskCommand = Extract<TaskCommand, { readonly type: 'create' }>;
export type CreateTaskCommandDestination = CreateTaskCommand['destination'];
export type CreateTaskCommandInitial = NonNullable<CreateTaskCommand['initial']>;

interface TaskCreateRequest {
  readonly markdownBody: string;
  readonly initial?: CreateTaskCommandInitial;
}

export type TaskCreateSession =
  | {
      readonly type: 'ready';
      readonly destination: TaskDestination;
      execute(request: TaskCreateRequest): Promise<TaskCommandResult>;
    }
  | {
      readonly type: 'unavailable';
      execute(request: TaskCreateRequest): Promise<TaskCommandResult>;
    };

export interface TaskCaptureApplicationApi {
  planCreate(destination: CreateTaskCommandDestination): Promise<TaskCreateSession>;
}
