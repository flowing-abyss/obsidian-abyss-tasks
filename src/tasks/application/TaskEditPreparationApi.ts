import type { TaskCommand, TaskCommandResult } from '../domain/commands';
import type { CommentRef, TaskNodeRef, TaskSnapshot } from '../domain/types';
import type {
  TaskMergePreservation,
  TaskSourceCopy,
  TaskSourceCopyEvidence,
} from './TaskSourceCopyApi';

export type PreparedTaskEditCommand = Extract<
  TaskCommand,
  {
    type:
      | 'patch'
      | 'set-description'
      | 'add-subtask'
      | 'delete-subtask'
      | 'add-comment'
      | 'update-comment'
      | 'delete-comment'
      | 'delete';
  }
>;

export interface TaskInitialStatusRefinement {
  readonly target: TaskNodeRef;
  readonly symbol: string;
}

export interface TaskPreparedNodeContinuation {
  readonly before: TaskNodeRef;
  readonly after?: TaskNodeRef;
}

export interface TaskEditPreparationApi {
  prepare(
    root: TaskSnapshot,
    commands: readonly PreparedTaskEditCommand[],
  ): Promise<TaskEditPreparation>;
}

export interface TaskEditRefreshUnavailable {
  readonly type: 'unavailable';
  readonly reason: 'source-incomplete';
}

export type TaskEditPreparation =
  | {
      readonly type: 'ready';
      readonly before: TaskSnapshot;
      readonly continuations: readonly TaskPreparedNodeContinuation[];
      readonly after: TaskSnapshot | null;
      /** Immutable continuation; command refs must belong to this preparation's after tree. */
      append(command: PreparedTaskEditCommand): TaskEditPreparation;
      refineInitialStatus(input: TaskInitialStatusRefinement): TaskEditPreparation;
      readonly copies: readonly TaskSourceCopyEvidence[];
      sourceCopiesAvailable(): boolean;
      continueSourceComment(source: CommentRef): CommentRef | undefined;
      assessMerge(source: TaskNodeRef): Promise<TaskMergePreservation | undefined>;
      copySource(input: TaskSourceCopy): Promise<TaskEditPreparation>;
      refresh(current: TaskSnapshot): Promise<TaskEditPreparation | TaskEditRefreshUnavailable>;
      /** One attempt, with the same detached receipt on subsequent calls, including failures. */
      commit(): Promise<TaskCommandResult>;
    }
  | { readonly type: 'invalid'; readonly result: TaskCommandResult };

export function isPreparedTaskEditCommand(
  command: TaskCommand,
): command is PreparedTaskEditCommand {
  return (
    command.type === 'patch' ||
    command.type === 'set-description' ||
    command.type === 'add-subtask' ||
    command.type === 'delete-subtask' ||
    command.type === 'add-comment' ||
    command.type === 'update-comment' ||
    command.type === 'delete-comment' ||
    command.type === 'delete'
  );
}
