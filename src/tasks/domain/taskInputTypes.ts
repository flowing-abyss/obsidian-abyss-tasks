import type { TaskPatch } from './commands';
import type { LocalDate, LocalTime, TaskPlanning, TaskPriority } from './types';
import type { TaskIssue } from './validation';

export type TaskInputInitial = Omit<TaskPatch, 'markdownTitle'>;
export interface TaskInputRange {
  readonly from: number;
  readonly to: number;
}
export type TaskInputPlanningRole = 'due' | 'scheduled' | 'start' | 'time';
export interface TaskInputCarrier {
  readonly role: TaskInputPlanningRole;
  readonly range: TaskInputRange;
  readonly value?: LocalDate | LocalTime;
}
export interface TaskInputInspection {
  readonly tags: ReadonlyArray<{ readonly value: string; readonly range: TaskInputRange }>;
  readonly carriers: readonly TaskInputCarrier[];
  readonly protectedRanges: readonly TaskInputRange[];
}
export interface TaskCreatePreviewMetadata {
  readonly markdownTitle: string;
  readonly tags: readonly string[];
  readonly planning: Pick<TaskPlanning, 'due' | 'scheduled' | 'start' | 'time' | 'duration'>;
  readonly priority: TaskPriority;
}
export type TaskCreatePreview =
  | {
      readonly type: 'valid';
      readonly metadata: TaskCreatePreviewMetadata;
      readonly sourcePlanning: Pick<TaskPlanning, 'due' | 'scheduled' | 'start' | 'time'>;
    }
  | { readonly type: 'invalid'; readonly issues: readonly TaskIssue[] }
  | { readonly type: 'unavailable'; readonly cause: 'destination' | 'preview-capability' };
