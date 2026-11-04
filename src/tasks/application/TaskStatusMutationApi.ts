import type { TaskCommandResult } from '../domain/commands';
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

export type TaskStatusIntent =
  | { readonly type: 'complete' }
  | { readonly type: 'set-status'; readonly symbol: string }
  | { readonly type: 'toggle-completion' };
export interface TaskStatusMutationRequest {
  readonly root: TaskSnapshot;
  readonly target: TaskNodeRef;
  readonly observation: TaskReadObservation;
  readonly intent: TaskStatusIntent;
}
export interface CompletionFollowUpDetails {
  /** Last root proven by this operation, even when later source proof is lost. */
  readonly root?: TaskSnapshot;
  readonly discardedShortEntry: boolean;
  /** Timer writes confirmed before the pass stopped. */
  readonly closed: number;
  /** Entries still running in the last proven root, including entries set aside. */
  readonly unclosed: number;
  readonly state: 'complete' | 'partial' | 'unknown';
}
export type TaskStatusMutationOutcome =
  | {
      readonly type: 'result';
      readonly result: TaskCommandResult;
      readonly occurrences: TaskStatusOccurrenceContinuations;
      readonly followUp?: CompletionFollowUpDetails;
    }
  | {
      readonly type: 'rejected';
      readonly reason: TaskStrictStatusFailure | 'missing-default-status' | 'unsupported-status';
    };
export interface TaskStatusMutationApi {
  mutateStatus(request: TaskStatusMutationRequest): Promise<TaskStatusMutationOutcome>;
}
