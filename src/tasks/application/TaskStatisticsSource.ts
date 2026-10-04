import type { TaskSnapshot } from '../domain/types';

/** A separate, session-only read capability; archive values confer no command authority. */
export interface TaskStatisticsSource {
  readStatistics(): TaskStatisticsSnapshot;
  subscribeStatistics(listener: () => void): () => void;
  refreshStatistics(): Promise<void>;
  whenStatisticsSettled(): Promise<void>;
  isStatisticsCurrent(snapshot: TaskStatisticsSnapshot): boolean;
}

export interface TaskStatisticsDateIssue {
  readonly line: number;
  readonly field: 'created' | 'completion' | 'cancelled' | 'due' | 'scheduled' | 'start';
  readonly reason: 'invalid-date' | 'ambiguous-date';
}

export interface TaskStatisticsFile {
  readonly path: string;
  readonly revision: number;
  readonly kind: 'live' | 'archive';
  readonly roots: readonly TaskSnapshot[];
  readonly dateIssues: readonly TaskStatisticsDateIssue[];
}

export interface TaskStatisticsSourceIssue {
  readonly path: string;
  readonly reason: 'read-failed' | 'projection-failed';
}

export interface TaskStatisticsSnapshot {
  readonly revision: number;
  /** All initial approved-source acquisitions settled; issues may still make coverage partial. */
  readonly ready: boolean;
  readonly files: readonly TaskStatisticsFile[];
  readonly issues: readonly TaskStatisticsSourceIssue[];
}
