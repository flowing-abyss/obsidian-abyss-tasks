import { parseRecurrenceRule, type RecurrenceIssueCode } from './recurrence';
import type { DurationMinutes, LocalDate, LocalTime } from './types';

type TaskIssueCode =
  | 'invalid-title'
  | 'invalid-date'
  | 'invalid-time'
  | 'invalid-duration'
  | 'invalid-status'
  | 'inverted-span'
  | 'duplicate-field'
  | 'invalid-task-syntax'
  | 'invalid-target'
  | 'destination-unavailable'
  | 'invalid-on-completion'
  | RecurrenceIssueCode;

export interface TaskIssue {
  readonly code: TaskIssueCode;
  readonly field?: string;
}

export type TaskValidationField =
  | 'title'
  | 'status'
  | 'due'
  | 'scheduled'
  | 'start'
  | 'completion'
  | 'cancelled'
  | 'time'
  | 'duration'
  | 'recurrence'
  | 'on-completion';

/** Source-line edits must never be able to introduce another Markdown line. */
export function isSingleLineText(value: string): boolean {
  return !/[\r\n]/u.test(value);
}

export interface TaskValidationState {
  readonly markdownTitle: string;
  readonly statusSymbol: string;
  readonly statusConfigured: boolean;
  readonly planning: {
    readonly due?: string;
    readonly scheduled?: string;
    readonly start?: string;
    readonly completion?: string;
    readonly cancelled?: string;
    readonly time?: string;
    readonly duration?: number;
  };
  readonly recurrence?: string;
  readonly onCompletion: 'keep' | 'delete';
  readonly malformedFields?: readonly TaskValidationField[];
}

export function localDate(value: string): LocalDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) throw new Error('invalid-date');
  const [, ys, ms, ds] = match;
  const y = Number(ys);
  const m = Number(ms);
  const d = Number(ds);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (m < 1 || m > 12 || d < 1 || d > days[m - 1]!) {
    throw new Error('invalid-date');
  }
  return value as LocalDate;
}

export function localTime(value: string): LocalTime {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/u.test(value)) throw new Error('invalid-time');
  return value as LocalTime;
}

export function durationMinutes(value: number): DurationMinutes {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error('invalid-duration');
  }
  return value as DurationMinutes;
}

export function formatDurationMinutes(value: DurationMinutes): string {
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  if (hours > 0 && minutes > 0) return `${hours}h${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

function isValidDate(value: string | undefined): boolean {
  if (value === undefined) return false;
  try {
    localDate(value);
    return true;
  } catch {
    return false;
  }
}

function isValidTime(value: string | undefined): boolean {
  if (value === undefined) return false;
  try {
    localTime(value);
    return true;
  } catch {
    return false;
  }
}

function isValidDuration(value: number | undefined): boolean {
  if (value === undefined) return false;
  try {
    durationMinutes(value);
    return true;
  } catch {
    return false;
  }
}

function recurrenceIssues(
  state: TaskValidationState,
  malformed: ReadonlySet<TaskValidationField>,
  fields: ReadonlySet<TaskValidationField>,
): readonly TaskIssue[] {
  if (!fields.has('recurrence')) return [];
  const parsed = state.recurrence === undefined ? undefined : parseRecurrenceRule(state.recurrence);
  if (!malformed.has('recurrence') && parsed?.type !== 'invalid') return [];
  return [
    {
      code: parsed?.type === 'invalid' ? parsed.code : 'unparseable-rule',
      field: 'recurrence',
    },
  ];
}

function completionPolicyIssues(
  malformed: ReadonlySet<TaskValidationField>,
  fields: ReadonlySet<TaskValidationField>,
): readonly TaskIssue[] {
  return fields.has('on-completion') && malformed.has('on-completion')
    ? [{ code: 'invalid-on-completion', field: 'on-completion' }]
    : [];
}

/** Validate only fields introduced by an edit, plus their semantic dependencies. */
export function validateTaskChange(
  state: TaskValidationState,
  changedFields: ReadonlySet<TaskValidationField>,
): TaskIssue[] {
  const fields = new Set(changedFields);
  if (fields.has('start') || fields.has('due')) {
    fields.add('start');
    fields.add('due');
  }

  const malformed = new Set(state.malformedFields ?? []);
  const issues: TaskIssue[] = [];
  if (fields.has('title') && state.markdownTitle.trim().length === 0) {
    issues.push({ code: 'invalid-title', field: 'title' });
  }
  if (fields.has('status') && (state.statusSymbol.length !== 1 || !state.statusConfigured)) {
    issues.push({ code: 'invalid-status', field: 'status' });
  }

  const dateFields = ['start', 'scheduled', 'due', 'completion', 'cancelled'] as const;
  const validDates = new Set<string>();
  for (const field of dateFields) {
    if (!fields.has(field)) continue;
    const value = state.planning[field];
    if (value === undefined && !malformed.has(field)) continue;
    if (malformed.has(field) || !isValidDate(value)) {
      issues.push({ code: 'invalid-date', field });
    } else {
      validDates.add(field);
    }
  }

  if (fields.has('time')) {
    const value = state.planning.time;
    if (malformed.has('time') || (value !== undefined && !isValidTime(value))) {
      issues.push({ code: 'invalid-time', field: 'time' });
    }
  }
  if (fields.has('duration')) {
    const value = state.planning.duration;
    if (malformed.has('duration') || (value !== undefined && !isValidDuration(value))) {
      issues.push({ code: 'invalid-duration', field: 'duration' });
    }
  }
  issues.push(...recurrenceIssues(state, malformed, fields));
  issues.push(...completionPolicyIssues(malformed, fields));

  if (
    fields.has('start') &&
    fields.has('due') &&
    validDates.has('start') &&
    validDates.has('due') &&
    state.planning.start! > state.planning.due!
  ) {
    issues.push({ code: 'inverted-span', field: 'start,due' });
  }
  return issues;
}
