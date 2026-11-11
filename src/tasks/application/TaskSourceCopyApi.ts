import type { CommentRef, TaskNodeRef, TaskSnapshot } from '../domain/types';

export type TaskSourceCopy =
  | { readonly type: 'comment'; readonly source: CommentRef; readonly parent: TaskNodeRef }
  | { readonly type: 'subtree'; readonly source: TaskNodeRef; readonly parent: TaskNodeRef };

/** Source selection is historical evidence, never source removal authority. */
export interface TaskSourceCopyEvidence {
  readonly type: 'comment' | 'subtree';
  readonly sourceRoot: TaskSnapshot;
  readonly source: TaskSourceCopy['source'];
  readonly state: 'retained' | 'unavailable';
  readonly tasks: ReadonlyArray<{
    readonly source: TaskNodeRef;
    readonly destination: TaskNodeRef;
  }>;
  readonly comments: ReadonlyArray<{
    readonly source: CommentRef;
    readonly destination: CommentRef;
  }>;
}

export interface TaskMergePreservationEntry {
  readonly kind: 'header' | 'description' | 'comment' | 'subtree' | 'residual' | 'constraint';
  readonly field: string;
  readonly state: 'retained' | 'held';
  readonly reason?: string;
}
/** Read-only inventory at one destination candidate and exact accepted source basis. */
export interface TaskMergePreservation {
  readonly sourceRoot: TaskSnapshot;
  readonly state: 'covered' | 'held';
  readonly entries: readonly TaskMergePreservationEntry[];
}
