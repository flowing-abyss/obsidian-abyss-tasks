import type {
  MoveRecovery,
  TaskCommand,
  TaskCommandOutcome,
  TaskResolutionCandidate,
  TaskStatusTarget,
} from '../domain/commands';
import type { AtomDateTime } from '../domain/commentTimestamp';
import type { RecurrencePolicy } from '../domain/recurrence';
import type { DependencyDirection } from '../domain/taskDependencies';
import { isTaskDependencyId } from '../domain/taskLineSourceModel';
import type { RebaseEvidence, RootReconciliationBasis } from '../domain/taskReconciliation';
import type {
  LocalDate,
  SubtaskSnapshot,
  TaskDestination,
  TaskMutationTarget,
  TaskNodeRef,
  TaskRef,
  TaskSnapshot,
} from '../domain/types';
import { sameTaskNodeRef } from '../domain/types';
import type { TaskIssue } from '../domain/validation';

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
      | { readonly type: 'add-dependency' | 'remove-dependency' | 'restore-dependency' }
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
  | { readonly type: 'set-dependency-id'; readonly target: TaskNodeRef; readonly id: string }
  | {
      readonly type: 'set-depends-on';
      readonly target: TaskNodeRef;
      readonly ids: readonly string[];
      /** Restore only a source line whose dependency edit reproduces the current line. */
      readonly restoreSource?: string;
    }
  | ({
      readonly type: 'add-subtask';
      readonly parent: TaskStatusTarget;
      readonly text: string;
    } & AddSubtaskLifecycle);

export function dependencyMetadataIssues(command: TaskEditCommand): readonly TaskIssue[] {
  if (command.type === 'set-dependency-id') {
    return command.id.length === 0 || isTaskDependencyId(command.id)
      ? []
      : [{ code: 'invalid-target', field: 'dependency-id' }];
  }
  if (command.type === 'set-depends-on' && !command.ids.every(isTaskDependencyId)) {
    return [{ code: 'invalid-target', field: 'depends-on' }];
  }
  return [];
}

export function subtaskRestorationIssues(
  command: TaskCommand | TaskEditCommand,
): readonly TaskIssue[] {
  if (command.type !== 'restore-subtask') return [];
  const { relativeLine, lineEnding } = command.placement;
  const invalid =
    !Number.isSafeInteger(relativeLine) ||
    relativeLine <= 0 ||
    !validRestorationEnding(lineEnding) ||
    !restorationAnchorsOwned(command);
  return invalid ? [{ code: 'invalid-target', field: 'subtask' }] : [];
}

export function subtaskRestorationGapIsCurrent(
  command: Extract<TaskCommand, { readonly type: 'restore-subtask' }>,
  current: TaskSnapshot | SubtaskSnapshot,
): boolean {
  const source = 'source' in current ? current.source.originalBlock : current.ref.originalBlock;
  const parent: TaskNodeRef =
    'source' in current
      ? { type: 'task', ref: current.ref }
      : { type: 'subtask', ref: current.ref };
  return (
    command.placement.relativeLine <= source.split(/\r?\n/u).length ||
    sameTaskNodeRef(command.parent, parent)
  );
}

function validRestorationEnding(value: unknown): boolean {
  return value === undefined || value === '\n' || value === '\r\n';
}

function restorationAnchorsOwned(
  command: Extract<TaskCommand, { readonly type: 'restore-subtask' }>,
): boolean {
  return [command.placement.before, command.placement.after].every(
    (anchor) => anchor === undefined || sameTaskNodeRef(anchor.parent, command.parent),
  );
}

export interface TaskDraft {
  readonly markdownBody: string;
  readonly initial?: NonNullable<Extract<TaskCommand, { readonly type: 'create' }>['initial']>;
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

export interface CreateDependencySubtaskRequest extends RevisionPrecondition {
  readonly direction: DependencyDirection;
  readonly text: string;
  readonly currentId?: string;
  readonly childId?: string;
  readonly today: LocalDate;
  readonly addCreatedDate: boolean;
}

export interface TaskEditBatchRequest {
  readonly filePath: string;
  readonly edits: readonly TaskEditRequest[];
  readonly outcomeTarget: TaskNodeRef;
}

export interface TaskMoveRequest extends RevisionPrecondition {
  readonly destination: TaskDestination;
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
  | { readonly type: 'committed'; readonly outcome: TaskCommandOutcome; readonly changed: boolean }
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
  /** Atomically edits dependency metadata and returns the outcome target's fresh root. */
  editBatch(request: TaskEditBatchRequest): Promise<TaskRepositoryResult>;
  /** Creates a direct child and its dependency edge in one guarded root edit. */
  createDependencySubtask(request: CreateDependencySubtaskRequest): Promise<TaskRepositoryResult>;
  completeRecurrence(
    request: RecurrenceCompletionRevisionRequest | RecurrenceCompletionRequest,
  ): Promise<TaskRepositoryResult>;
  create(destination: TaskDestination, draft: TaskDraft): Promise<TaskRepositoryResult>;
  move(
    request: TaskMoveRequest | TaskRef,
    legacyDestination?: TaskDestination,
  ): Promise<TaskRepositoryResult>;
}
