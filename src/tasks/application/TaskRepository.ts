import type {
  MoveRecovery,
  TaskCommand,
  TaskCommandOutcome,
  TaskResolutionCandidate,
  TaskStatusTarget,
} from '../domain/commands';
import type {
  LocalDate,
  TaskDestination,
  TaskMutationTarget,
  TaskRef,
  TaskSnapshot,
} from '../domain/types';
import type { TaskIssue } from '../domain/validation';

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
      readonly stamp: LocalDate;
    }
  | {
      readonly type: 'add-subtask';
      readonly parent: TaskStatusTarget;
      readonly text: string;
      readonly today?: LocalDate;
      readonly addCreatedDate?: boolean;
    };

export interface TaskDraft {
  readonly markdownBody: string;
  readonly initial?: NonNullable<Extract<TaskCommand, { readonly type: 'create' }>['initial']>;
  readonly today?: LocalDate;
  readonly addCreatedDate?: boolean;
}

export type TaskRepositoryResult =
  | { readonly type: 'committed'; readonly outcome: TaskCommandOutcome; readonly changed: boolean }
  | { readonly type: 'conflict'; readonly current: TaskSnapshot }
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
  edit(command: TaskEditCommand): Promise<TaskRepositoryResult>;
  create(destination: TaskDestination, draft: TaskDraft): Promise<TaskRepositoryResult>;
  move(ref: TaskRef, destination: TaskDestination): Promise<TaskRepositoryResult>;
}
