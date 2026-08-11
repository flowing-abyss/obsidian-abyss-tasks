import type { TaskCommand, TaskCommandResult } from '../domain/commands';
import type { TaskResolution } from '../domain/taskReconciliation';
import type {
  DateRange,
  LocalDate,
  SubtaskSnapshot,
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
  readonly queries: TaskQueryApi;
  execute(command: TaskCommand): Promise<TaskCommandResult>;
}
