import type { TaskNodeSnapshot } from '../domain/taskDependencies';
import type { TaskOccurrenceAddress } from '../domain/taskOccurrence';
import type { TaskStatus } from '../domain/types';

export interface TaskReadObservation {
  readonly revision: number;
  readonly generation: number;
  readonly scopeRevision: number;
  readonly semanticsRevision: number;
  readonly lifecycle: 'initializing' | 'ready' | 'failed' | 'disposed';
}
export interface TaskReadScope {
  readonly path?: string;
  readonly folder?: string;
}
type TaskReadFailure =
  | 'not-ready'
  | 'failed'
  | 'disposed'
  | 'incomplete'
  | 'generation-changed'
  | 'unavailable'
  | 'missing'
  | 'stale'
  | 'ambiguous';
export type TaskReadResult<T> =
  | { readonly type: 'ok'; readonly value: T; readonly observation: TaskReadObservation }
  | { readonly type: 'error'; readonly reason: TaskReadFailure };
export interface TaskSourceHealthChange {
  readonly filePath: string;
  readonly fileIdentity: object;
  readonly acquisition: object;
  readonly phase: 'pending' | 'failed' | 'settled';
}
export type TaskReadEvent =
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
