import type {
  MoveRecovery,
  TaskCommand,
  TaskCommandOutcome,
  TaskResolutionCandidate,
  TaskStatusTarget,
} from '../domain/commands';
import type { AtomDateTime } from '../domain/commentTimestamp';
import type { RecurrencePolicy } from '../domain/recurrence';
import type { RebaseEvidence, RootReconciliationBasis } from '../domain/taskReconciliation';
import type {
  LocalDate,
  TaskDestination,
  TaskMutationTarget,
  TaskRef,
  TaskSnapshot,
} from '../domain/types';
import type { TaskIssue } from '../domain/validation';
import { isTaskDependencyId } from '../domain/validation';

type AddSubtaskLifecycle =
  | { readonly today: LocalDate; readonly addCreatedDate: true }
  | { readonly today: LocalDate; readonly addCreatedDate: false };

export type TaskEditCommand =
  | Exclude<
      TaskCommand,
      | { readonly type: 'create' }
      | { readonly type: 'move' }
      | { readonly type: 'set-status' | 'toggle-completion' }
      | { readonly type: 'add-comment' }
      | { readonly type: 'add-subtask' }
    >
  | {
      readonly type: 'set-status';
      readonly target: TaskStatusTarget;
      readonly symbol: string;
      readonly stamp?: LocalDate;
      readonly addCompletionDate?: boolean;
    }
  | {
      readonly type: 'add-comment';
      readonly parent: TaskStatusTarget;
      readonly text: string;
      readonly stamp: AtomDateTime;
    }
  | ({
      readonly type: 'add-subtask';
      readonly parent: TaskStatusTarget;
      readonly text: string;
    } & AddSubtaskLifecycle);

export interface TaskDraft {
  readonly markdownBody: string;
  readonly initial?: Omit<
    NonNullable<Extract<TaskCommand, { readonly type: 'create' }>['initial']>,
    'statusSymbol'
  >;
  readonly initialStatus?: {
    readonly symbol: string;
    readonly stamp?: LocalDate;
    readonly addCompletionDate?: boolean;
  };
  readonly today?: LocalDate;
  readonly addCreatedDate?: boolean;
}

export interface RecurrenceCompletionRequest {
  readonly target: TaskStatusTarget;
  readonly doneSymbol: string;
  readonly today: LocalDate;
  readonly todoSymbol: string;
  readonly addCreatedDate: boolean;
  readonly addCompletionDate: boolean;
  readonly placement: 'before' | 'after';
  readonly policy: RecurrencePolicy;
}

export interface RevisionPrecondition {
  readonly baseRoot: TaskSnapshot;
  readonly baseTarget: TaskMutationTarget;
  readonly reconciliation: RootReconciliationBasis;
}

export interface TaskEditRequest extends RevisionPrecondition {
  readonly command: TaskEditCommand;
}

export interface TaskMoveRequest extends RevisionPrecondition {
  readonly destination: TaskDestination;
}

export interface RootTagRevisionChange extends RevisionPrecondition {
  readonly tags: NonNullable<import('../domain/commands').TaskPatch['tags']>;
}

export interface TaskRootTagEditRequest {
  readonly filePath: string;
  readonly primary: TaskRef;
  readonly changes: readonly RootTagRevisionChange[];
}

export type TaskDependencyEditCommand = Extract<
  TaskEditCommand,
  { readonly type: 'set-task-id' | 'set-task-dependency' }
>;

export interface TaskDependencyRevisionChange extends RevisionPrecondition {
  readonly command: TaskDependencyEditCommand;
}

export interface TaskDependencyEditRequest {
  readonly filePath: string;
  readonly primary: TaskRef;
  readonly changes: readonly TaskDependencyRevisionChange[];
}

function sameRootRef(left: TaskRef, right: TaskRef): boolean {
  return (
    left.filePath === right.filePath && left.line === right.line && left.revision === right.revision
  );
}

export function isTaskDependencyEditRequestValid(request: TaskDependencyEditRequest): boolean {
  const [idChange, edgeChange] = request.changes;
  return (
    request.changes.length === 2 &&
    idChange?.command.type === 'set-task-id' &&
    idChange.command.id !== null &&
    isTaskDependencyId(idChange.command.id) &&
    edgeChange?.command.type === 'set-task-dependency' &&
    edgeChange.command.enabled &&
    edgeChange.command.dependencyId === idChange.command.id &&
    idChange.baseRoot.ref.filePath === request.filePath &&
    edgeChange.baseRoot.ref.filePath === request.filePath &&
    sameRootRef(idChange.command.ref, idChange.baseRoot.ref) &&
    sameRootRef(edgeChange.command.ref, edgeChange.baseRoot.ref) &&
    sameRootRef(request.primary, edgeChange.baseRoot.ref) &&
    !sameRootRef(idChange.baseRoot.ref, edgeChange.baseRoot.ref)
  );
}

export interface RecurrenceCompletionRevisionRequest extends RevisionPrecondition {
  readonly command: RecurrenceCompletionRequest;
  readonly baseOwnedDescendants: string;
}

export type RepositoryRevisionResult =
  | {
      readonly type: 'rebased';
      readonly previous: TaskSnapshot;
      readonly current: TaskSnapshot;
      readonly evidence: RebaseEvidence;
    }
  | { readonly type: 'uncertain'; readonly target: TaskMutationTarget }
  | { readonly type: 'ambiguous'; readonly candidates: readonly TaskResolutionCandidate[] };

export type TaskRepositoryResult =
  | {
      readonly type: 'committed';
      readonly outcome: TaskCommandOutcome;
      readonly changed: boolean;
      readonly roots?: readonly TaskSnapshot[];
    }
  | { readonly type: 'conflict'; readonly current: TaskSnapshot }
  | RepositoryRevisionResult
  | { readonly type: 'not-found'; readonly target: TaskMutationTarget }
  | { readonly type: 'ambiguous'; readonly candidates: readonly TaskResolutionCandidate[] }
  | { readonly type: 'invalid'; readonly issues: readonly TaskIssue[] }
  | { readonly type: 'partial'; readonly operation: 'move'; readonly recovery: MoveRecovery }
  | {
      readonly type: 'io-error';
      readonly cause: string;
      readonly path?: string;
      readonly contentState: 'unchanged' | 'unknown';
    };

export interface TaskRepository {
  /** Production adapters opt in to immutable revision preconditions. */
  readonly supportsRevisionPreconditions?: true;
  edit(request: TaskEditRequest | TaskEditCommand): Promise<TaskRepositoryResult>;
  completeRecurrence(
    request: RecurrenceCompletionRevisionRequest | RecurrenceCompletionRequest,
  ): Promise<TaskRepositoryResult>;
  create(destination: TaskDestination, draft: TaskDraft): Promise<TaskRepositoryResult>;
  move(
    request: TaskMoveRequest | TaskRef,
    legacyDestination?: TaskDestination,
  ): Promise<TaskRepositoryResult>;
  editRootTags?(request: TaskRootTagEditRequest): Promise<TaskRepositoryResult>;
  editTaskDependencies?(request: TaskDependencyEditRequest): Promise<TaskRepositoryResult>;
}
