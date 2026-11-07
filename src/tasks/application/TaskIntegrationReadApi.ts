import type {
  AcceptedNoteSource,
  NoteSourceReadApi,
  TaskReadObservation,
  TaskReadResult,
  TaskReadScope,
} from '../../notes/NoteSourceApi';
import type { TaskNodeSnapshot } from '../domain/taskDependencies';
import type { TaskOccurrenceAddress, TaskOccurrenceWitness } from '../domain/taskOccurrence';
import type { TrackedTotal } from '../domain/timeTracking';
import type { TaskSnapshot, TaskStatus } from '../domain/types';
export type { TaskReadObservation, TaskReadResult, TaskReadScope } from '../../notes/NoteSourceApi';

export interface TaskSourceHealthChange {
  readonly filePath: string;
  readonly fileIdentity: object;
  readonly acquisition: object;
  readonly phase: 'pending' | 'failed' | 'settled';
}
export interface TaskAcceptedSourceEvidence {
  readonly filePath: string;
  readonly fileIdentity: object;
  readonly content: string;
  readonly settledAcquisitions: readonly object[];
}
export interface TaskAcceptedOccurrenceChange {
  readonly sources: readonly TaskAcceptedSourceEvidence[];
  readonly paths: readonly string[];
  readonly before: readonly TaskSnapshot[];
  readonly after: readonly TaskSnapshot[];
  readonly witnesses: readonly TaskOccurrenceWitness[];
  readonly invalidated: readonly TaskOccurrenceAddress[];
  readonly restored: boolean;
  readonly operation?: object;
}
export type TaskReadEvent =
  | {
      readonly type: 'accepted';
      readonly observation: TaskReadObservation;
      readonly change: TaskAcceptedOccurrenceChange;
    }
  | { readonly type: 'state' | 'changed'; readonly observation: TaskReadObservation }
  | {
      readonly type: 'health';
      readonly observation: TaskReadObservation;
      readonly change: TaskSourceHealthChange;
    };
export interface TaskIntegrationReadStateApi {
  capture(): TaskReadObservation;
  subscribe(listener: (event: TaskReadEvent) => void): {
    readonly state: TaskReadObservation;
    readonly unsubscribe: () => void;
  };
  coverage(scope?: TaskReadScope): TaskReadResult<true>;
}

export interface TaskNodeReadQuery extends TaskReadScope {
  readonly statuses?: readonly TaskStatus[];
  readonly tagsAll?: readonly string[];
  readonly dates?: ReadonlyArray<{
    readonly field: 'created' | 'start' | 'scheduled' | 'due' | 'completion' | 'cancelled';
    readonly from?: string;
    readonly to?: string;
  }>;
}
export interface TaskReadNode {
  readonly value: TaskNodeSnapshot;
  readonly address: TaskOccurrenceAddress;
  readonly parent?: TaskOccurrenceAddress;
  readonly line: number;
  readonly status: TaskStatus;
  readonly dates: Readonly<
    Partial<Record<'created' | 'start' | 'scheduled' | 'due' | 'completion' | 'cancelled', string>>
  >;
  readonly time?: string;
  readonly durationMinutes?: number;
}
export interface TaskReadPage {
  readonly nodes: readonly TaskReadNode[];
  readonly next?: { readonly path: string; readonly line: number };
}
export interface TaskIntegrationReadApi extends TaskIntegrationReadStateApi {
  activateOccurrences(): void;
  page(
    query: TaskNodeReadQuery,
    limit: number,
    after?: { readonly path: string; readonly line: number },
    expectedGeneration?: number,
  ): TaskReadResult<TaskReadPage>;
  node(address: TaskOccurrenceAddress): TaskReadResult<TaskReadNode>;
  resolve(
    selector:
      | { readonly source: { readonly path: string; readonly line: number } }
      | { readonly authoredId: string },
  ): TaskReadResult<{
    readonly nodes: readonly TaskReadNode[];
    readonly ambiguous: boolean;
    readonly truncated: boolean;
  }>;
  statuses(): TaskReadResult<
    ReadonlyArray<{
      readonly symbol: string;
      readonly status: TaskStatus;
      readonly defaultForStatus: boolean;
    }>
  >;
  canDisclose(address: TaskOccurrenceAddress): boolean;
}

/** Task/project projection over the same accepted Markdown source owner. */
interface ProjectAcceptedSource extends AcceptedNoteSource {
  readonly roots: readonly TaskSnapshot[];
  readonly tracked: TrackedTotal;
}
export interface ProjectSourceReadApi extends NoteSourceReadApi {
  get(path: string): TaskReadResult<ProjectAcceptedSource | undefined>;
  acquire(path: string): Promise<TaskReadResult<ProjectAcceptedSource | undefined>>;
}
