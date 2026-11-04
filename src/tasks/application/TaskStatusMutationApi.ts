import type { TaskOccurrenceAddress } from '../domain/taskOccurrence';
import type { TaskNodeRef, TaskSnapshot } from '../domain/types';
import type { TaskReadObservation } from './TaskIntegrationReadApi';

export type TaskStrictStatusFailure =
  | 'revision-changed'
  | 'semantics-changed'
  | 'source-unavailable'
  | 'incomplete-read'
  | 'unsupported-precondition';
export interface TaskStrictWriteContext {
  readonly fileIdentity: object;
  readonly filePath: string;
  readonly content: string;
  readonly root: TaskSnapshot;
  readonly target: TaskNodeRef;
}
export interface TaskStatusOccurrenceEffects {
  readonly original: {
    readonly before: TaskOccurrenceAddress;
    readonly after?: TaskOccurrenceAddress;
  };
  readonly next?: TaskOccurrenceAddress;
}
export interface TaskStatusOccurrenceContinuation {
  readonly origin: TaskOccurrenceAddress;
  readonly state: 'retained' | 'removed' | 'unproven';
  readonly current?: TaskOccurrenceAddress;
}
export interface TaskStatusOccurrenceContinuations {
  readonly original: TaskStatusOccurrenceContinuation;
  readonly next?: TaskStatusOccurrenceContinuation;
}
export interface TaskStrictStatusGuard {
  readonly operation: object;
  check(current: TaskStrictWriteContext): TaskStrictStatusFailure | undefined;
  expectCommit(
    current: TaskStrictWriteContext,
    nextContent: string,
    effects?: TaskStatusOccurrenceEffects,
  ): void;
}
export interface TaskStatusReadLease {
  readonly observation: TaskReadObservation;
  guard(root: TaskSnapshot, target: TaskNodeRef): TaskStrictStatusGuard;
  failure(): TaskStrictStatusFailure | undefined;
  occurrences(): TaskStatusOccurrenceContinuations;
  markMainUnknown(): void;
  dispose(): void;
}
export interface TaskStatusReadBasisApi {
  lease(
    root: TaskSnapshot,
    target: TaskNodeRef,
    observation: TaskReadObservation,
  ):
    | { readonly type: 'ready'; readonly lease: TaskStatusReadLease }
    | { readonly type: 'rejected'; readonly reason: TaskStrictStatusFailure };
}
