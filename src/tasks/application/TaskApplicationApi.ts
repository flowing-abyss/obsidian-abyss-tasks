import type { TaskCommand, TaskCommandResult } from '../domain/commands';
import type {
  TaskDependencyEligibility,
  TaskDependencyProjection,
  TaskNodeSnapshot,
} from '../domain/taskDependencies';
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

export type TaskIndexEvent =
  | { readonly type: 'initialized' }
  | { readonly type: 'changed'; readonly files: readonly string[] }
  | { readonly type: 'renamed'; readonly oldPath: string; readonly newPath: string }
  | { readonly type: 'deleted'; readonly path: string };

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
  list(query?: TaskQuery): readonly TaskSnapshot[];
  forCalendarProjection(dates: readonly LocalDate[]): CalendarProjectionSources;
  resolve(ref: TaskRef): TaskResolution;
  subscribe(listener: (event: TaskIndexEvent) => void): () => void;
}

export interface TaskApplicationApi {
  readonly queries: TaskQueryApi & TaskDependencyQueryApi;
  /** Includes atomic linked-child creation; presentation never sequences repository edits. */
  execute(command: TaskCommand): Promise<TaskCommandResult>;
}

export interface TaskDependencyQueryApi {
  listNodes(query?: TaskQuery): readonly TaskNodeSnapshot[];
  dependencies(target: TaskNodeRef): TaskDependencyProjection;
  dependencyEligibility(
    blocker: TaskNodeRef,
    dependent: TaskNodeRef,
    options?: {
      readonly without: Omit<Extract<TaskCommand, { type: 'reverse-dependency' }>, 'type'>;
    },
  ): TaskDependencyEligibility;
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
