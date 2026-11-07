import type { TaskOccurrenceAddress } from '../domain/taskOccurrence';
import type { TaskDestination, TaskSnapshot } from '../domain/types';
import type { TaskReadResult } from './TaskIntegrationReadApi';

export type ProjectTaskFailure =
  Extract<TaskReadResult<true>, { type: 'error' }>['reason'] | 'invalid' | 'unsupported' | 'io';
export type ProjectTaskEffect = 'unchanged' | 'committed' | 'unknown';
export interface ProjectTaskResult {
  readonly outcome: 'changed' | 'noop' | 'failed';
  readonly destinationCopy: ProjectTaskEffect;
  readonly sourceRemoval: ProjectTaskEffect;
  readonly reason?: ProjectTaskFailure;
  readonly task?: TaskOccurrenceAddress;
}
export function projectTaskFailure(reason: ProjectTaskFailure): ProjectTaskResult {
  return { outcome: 'failed', destinationCopy: 'unchanged', sourceRemoval: 'unchanged', reason };
}
export type ProjectTaskGuard = (
  file: object,
  live: string,
  candidate: string,
) => ProjectTaskFailure | undefined;
export interface ProjectTaskDestination extends TaskDestination {
  readonly check: ProjectTaskGuard;
  readonly refreshPrepared?: () => ProjectTaskDestination | undefined;
  /** Checks the same incarnation against its newly installed project observation. */
  readonly checkCopy: (file: object, content: string) => boolean;
}
export interface ProjectTaskSource {
  readonly root: TaskSnapshot;
  readonly check: ProjectTaskGuard;
}
export type ProjectTaskExecution = () => Promise<ProjectTaskResult>;
export interface TaskProjectCommands {
  prepareProjectCreate(destination: ProjectTaskDestination, title: string): ProjectTaskExecution;
  moveProjectRoot(
    destination: ProjectTaskDestination,
    source: ProjectTaskSource,
  ): Promise<ProjectTaskResult>;
}
