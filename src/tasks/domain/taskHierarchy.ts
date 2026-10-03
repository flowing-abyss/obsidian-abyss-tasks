import type { TaskCommand, TaskOccurrenceResult } from './commands';
import { taskNodeChain } from './taskCommandTargets';
import { sameTaskNodeRef, type SubtaskRef, type TaskNodeRef, type TaskSnapshot } from './types';

export type TaskHierarchyCommand =
  | { readonly type: 'reparent-task'; readonly source: TaskNodeRef; readonly parent: TaskNodeRef }
  | { readonly type: 'promote-subtask'; readonly subtask: SubtaskRef };
export interface TaskHierarchyOutcome {
  readonly type: 'hierarchy';
  readonly source: TaskNodeRef;
  readonly moved: TaskOccurrenceResult;
  readonly affectedRoots: readonly TaskSnapshot[];
}
export interface TaskHierarchyRecovery {
  readonly source: TaskNodeRef;
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly state: 'copied-source-remains' | 'unknown';
  readonly cause: 'conflict' | 'not-found' | 'ambiguous' | 'io-error';
}
export function hierarchySource(command: TaskHierarchyCommand): TaskNodeRef {
  return command.type === 'reparent-task'
    ? command.source
    : { type: 'subtask', ref: command.subtask };
}
export function hierarchyWouldCycle(source: TaskNodeRef, parent: TaskNodeRef): boolean {
  return (
    sameTaskNodeRef(source, parent) ||
    taskNodeChain(parent).some((ref) => sameTaskNodeRef(source, ref.parent))
  );
}

export function isHierarchyCommand(command: TaskCommand): command is TaskHierarchyCommand {
  return command.type === 'reparent-task' || command.type === 'promote-subtask';
}
