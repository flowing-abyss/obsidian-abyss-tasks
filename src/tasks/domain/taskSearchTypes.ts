import type { TaskDependencyProjection, TaskNodeSnapshot } from './taskDependencies';
import type { TrackedTotal } from './timeTracking';
import type { TaskSnapshot } from './types';

export interface TaskSearchAddress {
  readonly epoch: string;
  readonly version: number;
  readonly rootId: number;
  readonly childLines: readonly number[];
}
export interface TaskSearchHit {
  readonly address: TaskSearchAddress;
  readonly score: number;
}
export interface TaskSearchHydratedHit {
  readonly hit: TaskSearchHit;
  readonly task: TaskNodeSnapshot;
}
export interface TaskOrganizationRecord {
  readonly address: TaskSearchAddress;
  readonly title: string;
  readonly markdownTitle: string;
  readonly source: Pick<TaskSnapshot['source'], 'filePath' | 'line'>;
  readonly status: TaskSnapshot['status'];
  readonly statusSymbol: string;
  readonly priority: TaskSnapshot['priority'];
  readonly planning: TaskSnapshot['planning'];
  readonly tags: readonly string[];
  readonly treeTags: readonly string[];
  readonly tracked: TrackedTotal;
}
export interface TaskOrganizationRequest {
  readonly expectedGeneration: number;
  readonly roots?: readonly TaskSearchAddress[];
  readonly filePath?: string;
}
export interface TaskOrganizationBatch {
  readonly generation: number;
  readonly items: readonly TaskOrganizationRecord[];
}
export type TaskDependencySummary = Pick<
  TaskDependencyProjection,
  'activeBlockedByCount' | 'activeBlocksCount'
>;
export type TaskSearchErrorCode =
  | 'aborted'
  | 'stale'
  | 'cursor-expired'
  | 'invalid-request'
  | 'invalid-query'
  | 'unavailable'
  | 'disposed';
export class TaskSearchError extends Error {
  constructor(
    readonly code: TaskSearchErrorCode,
    message: string,
    readonly episode?: number,
  ) {
    super(message);
    this.name = 'TaskSearchError';
  }
}
