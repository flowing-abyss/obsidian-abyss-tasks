import { parseRecurrenceRule, type RecurrenceIssueCode } from './recurrence';
import { durationMinutes, localDate, localTime } from './valueObjects';

export { durationMinutes, formatDurationMinutes, localDate, localTime } from './valueObjects';

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

function expandedValidationFields(
  changedFields: ReadonlySet<TaskValidationField>,
): Set<TaskValidationField> {
  const fields = new Set(changedFields);
  if (fields.has('start') || fields.has('due')) {
    fields.add('start');
    fields.add('due');
  }
  return fields;
}

function identityIssues(
  state: TaskValidationState,
  fields: ReadonlySet<TaskValidationField>,
): TaskIssue[] {
  const issues: TaskIssue[] = [];
  if (fields.has('title') && state.markdownTitle.trim().length === 0) {
    issues.push({ code: 'invalid-title', field: 'title' });
  }
  if (fields.has('status') && (state.statusSymbol.length !== 1 || !state.statusConfigured)) {
    issues.push({ code: 'invalid-status', field: 'status' });
  }
  return issues;
}

const DATE_FIELDS = ['start', 'scheduled', 'due', 'completion', 'cancelled'] as const;

function dateIssues(
  state: TaskValidationState,
  fields: ReadonlySet<TaskValidationField>,
  malformed: ReadonlySet<TaskValidationField>,
): { readonly issues: TaskIssue[]; readonly validDates: Set<string> } {
  const issues: TaskIssue[] = [];
  const validDates = new Set<string>();
  for (const field of DATE_FIELDS) {
    if (!fields.has(field)) continue;
    const value = state.planning[field];
    if (value === undefined && !malformed.has(field)) continue;
    if (malformed.has(field) || !isValidDate(value)) {
      issues.push({ code: 'invalid-date', field });
    } else {
      validDates.add(field);
    }
  }
  return { issues, validDates };
}

function timeAndDurationIssues(
  state: TaskValidationState,
  fields: ReadonlySet<TaskValidationField>,
  malformed: ReadonlySet<TaskValidationField>,
): TaskIssue[] {
  const issues: TaskIssue[] = [];
  const time = state.planning.time;
  if (fields.has('time') && (malformed.has('time') || (time !== undefined && !isValidTime(time)))) {
    issues.push({ code: 'invalid-time', field: 'time' });
  }
  const duration = state.planning.duration;
  if (
    fields.has('duration') &&
    (malformed.has('duration') || (duration !== undefined && !isValidDuration(duration)))
  ) {
    issues.push({ code: 'invalid-duration', field: 'duration' });
  }
  return issues;
}

function invertedSpanIssue(
  state: TaskValidationState,
  fields: ReadonlySet<TaskValidationField>,
  validDates: ReadonlySet<string>,
): TaskIssue[] {
  const { start, due } = state.planning;
  return fields.has('start') &&
    fields.has('due') &&
    validDates.has('start') &&
    validDates.has('due') &&
    start !== undefined &&
    due !== undefined &&
    start > due
    ? [{ code: 'inverted-span', field: 'start,due' }]
    : [];
}

/** Validate only fields introduced by an edit, plus their semantic dependencies. */
export function validateTaskChange(
  state: TaskValidationState,
  changedFields: ReadonlySet<TaskValidationField>,
): TaskIssue[] {
  const fields = expandedValidationFields(changedFields);
  const malformed = new Set(state.malformedFields ?? []);
  const dates = dateIssues(state, fields, malformed);
  return [
    ...identityIssues(state, fields),
    ...dates.issues,
    ...timeAndDurationIssues(state, fields, malformed),
    ...recurrenceIssues(state, malformed, fields),
    ...completionPolicyIssues(malformed, fields),
    ...invertedSpanIssue(state, fields, dates.validDates),
  ];
}
