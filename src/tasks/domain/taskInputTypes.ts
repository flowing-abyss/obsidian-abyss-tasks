import type { ClockReading } from './clock';
import type { TaskPatch } from './commands';
import type { LocalDate, LocalTime, TaskPlanning, TaskPriority } from './types';
import type { TaskIssue } from './validation';
import { localTime } from './validation';

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
interface TaskCreateContextMetadata {
  readonly tags: readonly string[];
  readonly planning: Pick<TaskPlanning, 'due' | 'scheduled' | 'start' | 'time' | 'duration'>;
  readonly priority: TaskPriority;
}
interface TaskCreatePreviewMetadata extends TaskCreateContextMetadata {
  readonly markdownTitle: string;
}
export interface TaskCreateInboxPreview {
  readonly member: boolean;
  readonly serviceTag?: string;
}
export type TaskCreatePreview =
  | {
      readonly type: 'valid';
      readonly metadata: TaskCreatePreviewMetadata;
      readonly sourcePlanning: Pick<TaskPlanning, 'due' | 'scheduled' | 'start' | 'time'>;
      readonly inbox?: TaskCreateInboxPreview;
    }
  | { readonly type: 'invalid'; readonly issues: readonly TaskIssue[] }
  | { readonly type: 'unavailable'; readonly cause: 'destination' | 'preview-capability' };
export type TaskCreateContextPreview =
  | {
      readonly type: 'ready';
      readonly referenceDate: LocalDate;
      readonly metadata: TaskCreateContextMetadata;
      readonly sourcePlanning: Pick<TaskPlanning, 'due' | 'scheduled' | 'start' | 'time'>;
      readonly inbox?: TaskCreateInboxPreview;
    }
  | Extract<TaskCreatePreview, { readonly type: 'invalid' | 'unavailable' }>;
export interface TaskInputReference {
  readonly epochMs: number;
  readonly localDate: LocalDate;
  readonly localTime: LocalTime;
  readonly second: number;
  readonly offsetMinutes: number;
}
export interface TaskInputCandidate {
  readonly kind: 'date-time';
  readonly status: 'point' | 'partial' | 'range' | 'unsupported';
  readonly ranges: readonly TaskInputRange[];
  readonly dateRanges: readonly TaskInputRange[];
  readonly timeRanges: readonly TaskInputRange[];
  readonly date?: LocalDate;
  readonly time?: LocalTime;
  readonly dateOrigin?: 'named' | 'relative' | 'weekday';
  readonly yearExplicit?: boolean;
  readonly reason?:
    | 'multiple'
    | 'range'
    | 'vague-time'
    | 'recurrence'
    | 'negation'
    | 'timezone'
    | 'content'
    | 'numeric'
    | 'invalid-time';
}

export function taskInputReference(reading: ClockReading): TaskInputReference {
  return {
    epochMs: reading.epochMs,
    localDate: reading.localDate,
    localTime: localTime(reading.atom.slice(11, 16)),
    second: Number(reading.atom.slice(17, 19)),
    offsetMinutes: reading.offsetMinutes,
  };
}
