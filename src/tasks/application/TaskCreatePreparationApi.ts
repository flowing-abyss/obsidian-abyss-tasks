import type { TaskCommandResult } from '../domain/commands';
import type { TaskDestination, TaskSnapshot } from '../domain/types';
import type { CreateTaskCommandDestination, CreateTaskCommandInitial } from './TaskApplicationApi';
import type {
  PreparedTaskEditCommand,
  TaskPreparedNodeContinuation,
} from './TaskEditPreparationApi';
import type { ProjectTaskDestination } from './TaskProjectCommands';

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
      sharesDestinationBasis(other: TaskCreatePreparation): boolean;
      refresh(options?: {
        readonly createdDestinationAnchor?: TaskSnapshot;
      }): Promise<TaskCreatePreparation>;
      commit(): Promise<TaskCreateCommitResult>;
    }
  | { readonly type: 'invalid'; readonly result: TaskCommandResult };
