import type { TaskCommandResult } from '../domain/commands';
import type { CommentRef, TaskDestination, TaskNodeRef, TaskSnapshot } from '../domain/types';
import type { CreateTaskCommandDestination, CreateTaskCommandInitial } from './TaskApplicationApi';
import type {
  PreparedTaskEditCommand,
  TaskInitialStatusRefinement,
  TaskPreparedNodeContinuation,
} from './TaskEditPreparationApi';
import type { ProjectTaskDestination } from './TaskProjectCommands';
import type {
  TaskMergePreservation,
  TaskSourceCopy,
  TaskSourceCopyEvidence,
} from './TaskSourceCopyApi';

export interface TaskCreateTreeNode {
  readonly markdownTitle: string;
  readonly initial?: CreateTaskCommandInitial;
  readonly description?: string;
  readonly comments?: ReadonlyArray<{ readonly text: string }>;
  readonly children?: readonly TaskCreateTreeNode[];
}
export type TaskCreatePreparationDestination =
  | CreateTaskCommandDestination
  | {
      readonly type: 'project';
      readonly destination: ProjectTaskDestination;
    };
export interface TaskCreatePreparationApi {
  prepareCreateTree(input: {
    readonly destination: TaskCreatePreparationDestination;
    readonly intent?: 'inbox';
    readonly tree: TaskCreateTreeNode;
  }): Promise<TaskCreatePreparation>;
}
export interface TaskCreateCommitResult {
  readonly result: TaskCommandResult;
  readonly destinationEffects: 'unchanged' | 'committed' | 'unknown';
}
export type TaskCreatePreparation =
  | {
      readonly type: 'ready';
      readonly destination: TaskDestination;
      readonly before: null;
      readonly after: TaskSnapshot;
      readonly continuations: readonly TaskPreparedNodeContinuation[];
      append(command: PreparedTaskEditCommand): TaskCreatePreparation;
      refineInitialStatus(input: TaskInitialStatusRefinement): TaskCreatePreparation;
      readonly copies: readonly TaskSourceCopyEvidence[];
      sourceCopiesAvailable(): boolean;
      continueSourceComment(source: CommentRef): CommentRef | undefined;
      assessMerge(source: TaskNodeRef): Promise<TaskMergePreservation | undefined>;
      copySource(input: TaskSourceCopy): Promise<TaskCreatePreparation>;
      sharesDestinationBasis(other: TaskCreatePreparation): boolean;
      refresh(options?: {
        readonly createdDestinationAnchor?: TaskSnapshot;
      }): Promise<TaskCreatePreparation>;
      commit(): Promise<TaskCreateCommitResult>;
    }
  | { readonly type: 'invalid'; readonly result: TaskCommandResult };
