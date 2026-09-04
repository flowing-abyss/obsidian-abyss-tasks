export type TaskStatus = 'open' | 'done' | 'cancelled' | 'in-progress';
export type TaskStatusType = 'todo' | 'in-progress' | 'done' | 'cancelled';
export type TaskPriority = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
export type OnCompletion = 'keep' | 'delete';

import type { CommentTimestamp } from './commentTimestamp';

declare const localDateBrand: unique symbol;
declare const localTimeBrand: unique symbol;
declare const durationBrand: unique symbol;
export type LocalDate = string & { readonly [localDateBrand]: true };
export type LocalTime = string & { readonly [localTimeBrand]: true };
export type DurationMinutes = number & { readonly [durationBrand]: true };

export interface TaskStatusRule {
  readonly id: string;
  readonly symbol: string;
  readonly type: TaskStatusType;
  readonly defaultForType: boolean;
}

export interface DateRange {
  readonly from: LocalDate;
  readonly to: LocalDate;
}

export interface TaskRef {
  readonly filePath: string;
  readonly line: number;
  readonly revision: string;
}

export type TaskInsertionPolicy =
  { readonly type: 'append' } | { readonly type: 'section'; readonly heading: string };

export interface TaskDestination {
  readonly filePath: string;
  readonly insertion: TaskInsertionPolicy;
}

export interface SubtaskRef {
  readonly parent: TaskNodeRef;
  readonly relativeLine: number;
  readonly originalBlock: string;
}

export interface CommentRef {
  readonly parent: TaskNodeRef;
  readonly relativeLine: number;
  readonly originalMarkdown: string;
}

export type TaskNodeRef =
  | { readonly type: 'task'; readonly ref: TaskRef }
  | { readonly type: 'subtask'; readonly ref: SubtaskRef };

export function sameTaskNodeRef(left: TaskNodeRef, right: TaskNodeRef): boolean {
  if (left.type !== right.type) return false;
  if (left.type === 'task' && right.type === 'task') {
    return (
      left.ref.filePath === right.ref.filePath &&
      left.ref.line === right.ref.line &&
      left.ref.revision === right.ref.revision
    );
  }
  if (left.type === 'subtask' && right.type === 'subtask') {
    return (
      left.ref.relativeLine === right.ref.relativeLine &&
      left.ref.originalBlock === right.ref.originalBlock &&
      sameTaskNodeRef(left.ref.parent, right.ref.parent)
    );
  }
  return false;
}

export type TaskMutationTarget =
  TaskNodeRef | { readonly type: 'comment'; readonly ref: CommentRef };

export type TaskTextTarget =
  | { readonly type: 'title'; readonly target: TaskNodeRef }
  | { readonly type: 'description'; readonly target: TaskNodeRef }
  | { readonly type: 'comment'; readonly ref: CommentRef };

export interface TaskPlanning {
  readonly created?: LocalDate;
  readonly due?: LocalDate;
  readonly scheduled?: LocalDate;
  readonly start?: LocalDate;
  readonly completion?: LocalDate;
  readonly cancelled?: LocalDate;
  readonly time?: LocalTime;
  readonly duration?: DurationMinutes;
}

export interface SubtaskPlanning {
  readonly created?: LocalDate;
  readonly due?: LocalDate;
  readonly scheduled?: LocalDate;
  readonly start?: LocalDate;
  readonly completion?: LocalDate;
  readonly cancelled?: LocalDate;
  readonly time?: LocalTime;
}

interface TaskSource {
  readonly filePath: string;
  readonly line: number;
  readonly originalMarkdown: string;
  /** Complete root block as observed, for safe review of revision conflicts. */
  readonly originalBlock: string;
}

interface TaskPresentationMetadata {
  readonly linkCount: number;
  readonly dailyNoteDate?: LocalDate;
  readonly noteColor?: string;
  readonly noteTextColor?: string;
  readonly noteIcon?: string;
}

export interface TaskDependencyFields {
  readonly dependencyId?: string;
  readonly dependsOn: readonly string[];
}

export interface TaskCommentSnapshot {
  readonly ref: CommentRef;
  readonly timestamp?: CommentTimestamp;
  readonly text: string;
}

export interface SubtaskSnapshot extends TaskDependencyFields {
  readonly ref: SubtaskRef;
  readonly title: string;
  readonly markdownTitle: string;
  readonly status: TaskStatus;
  readonly statusSymbol: string;
  readonly priority: TaskPriority;
  readonly planning: SubtaskPlanning;
  readonly tags: readonly string[];
  readonly recurrence?: string;
  readonly onCompletion: OnCompletion;
  readonly onCompletionExplicit: boolean;
  readonly subtasks: readonly SubtaskSnapshot[];
  readonly comments: readonly TaskCommentSnapshot[];
  readonly description?: string;
}

export interface TaskSnapshot extends TaskDependencyFields {
  readonly ref: TaskRef;
  readonly title: string;
  readonly markdownTitle: string;
  readonly status: TaskStatus;
  readonly statusSymbol: string;
  readonly priority: TaskPriority;
  readonly planning: TaskPlanning;
  readonly tags: readonly string[];
  readonly recurrence?: string;
  readonly onCompletion: OnCompletion;
  readonly onCompletionExplicit: boolean;
  readonly subtasks: readonly SubtaskSnapshot[];
  readonly comments: readonly TaskCommentSnapshot[];
  readonly description?: string;
  readonly source: TaskSource;
  readonly presentation: TaskPresentationMetadata;
}
