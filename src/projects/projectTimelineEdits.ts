import {
  MAX_PROJECT_CALENDAR_YEAR,
  MIN_PROJECT_CALENDAR_YEAR,
  parseProjectDate,
  projectCalendarDayFromOrdinal,
  projectCalendarDayOrdinal,
} from './projectDateValue';
import type { ProjectTimelineRange } from './projectTimelineModel';

export type ProjectTimelineEditIntent =
  | { readonly type: 'move'; readonly deltaDays: number }
  | { readonly type: 'resizeStart'; readonly day: string }
  | { readonly type: 'resizeEnd'; readonly day: string }
  | { readonly type: 'adjustEnd'; readonly deltaDays: number }
  | { readonly type: 'setStart'; readonly day: string }
  | { readonly type: 'setEnd'; readonly day: string }
  | { readonly type: 'draw'; readonly startDay: string; readonly endDay: string };

export type ProjectTimelineRelativeEditIntent = Extract<
  ProjectTimelineEditIntent,
  { readonly type: 'move' | 'adjustEnd' }
>;

export type ProjectTimelineEditPlan =
  | { readonly kind: 'ready'; readonly startDay?: string; readonly endDay?: string }
  | { readonly kind: 'rejected'; readonly reason: string };

export interface ProjectTimelineRawEndpoint {
  readonly exists: boolean;
  readonly value: unknown;
}

export type ProjectTimelineRawEditEligibility =
  { readonly kind: 'eligible' } | { readonly kind: 'ineligible'; readonly reason: string };

export const PROJECT_TIMELINE_INVALID_RANGE_REASON =
  'Invalid project dates must be repaired in the date fields before Timeline editing.';
const INVALID_PROPOSED_DAY_REASON = 'The proposed Timeline date is invalid.';
const OUTSIDE_SUPPORTED_YEARS_REASON = `The proposed Timeline date is outside the supported years ${String(MIN_PROJECT_CALENDAR_YEAR).padStart(4, '0')}–${MAX_PROJECT_CALENDAR_YEAR}.`;

function rejected(reason: string): ProjectTimelineEditPlan {
  return { kind: 'rejected', reason };
}

function ordinal(day: string): number | undefined {
  return projectCalendarDayOrdinal(day);
}

function shifted(day: string, deltaDays: number): string | undefined {
  const current = ordinal(day);
  if (current === undefined || !Number.isSafeInteger(deltaDays)) return undefined;
  const result = projectCalendarDayFromOrdinal(current + deltaDays);
  return parseProjectDate(result)?.kind === 'date' ? result : undefined;
}

function proposedDay(day: string): { readonly day: string; readonly ordinal: number } | undefined {
  if (parseProjectDate(day)?.kind !== 'date') return undefined;
  const value = ordinal(day);
  return value === undefined ? undefined : { day, ordinal: value };
}

function ready(startDay?: string, endDay?: string): ProjectTimelineEditPlan {
  return {
    kind: 'ready',
    ...(startDay === undefined ? {} : { startDay }),
    ...(endDay === undefined ? {} : { endDay }),
  };
}

function planMove(range: ProjectTimelineRange, deltaDays: number): ProjectTimelineEditPlan {
  if (!Number.isSafeInteger(deltaDays)) return rejected(INVALID_PROPOSED_DAY_REASON);
  if (range.kind === 'closed') {
    const startDay = shifted(range.startDay, deltaDays);
    const endDay = shifted(range.endDay, deltaDays);
    return startDay === undefined || endDay === undefined
      ? rejected(OUTSIDE_SUPPORTED_YEARS_REASON)
      : ready(startDay, endDay);
  }
  if (range.kind === 'open-end') {
    const startDay = shifted(range.startDay, deltaDays);
    return startDay === undefined ? rejected(OUTSIDE_SUPPORTED_YEARS_REASON) : ready(startDay);
  }
  if (range.kind === 'open-start') {
    const endDay = shifted(range.endDay, deltaDays);
    return endDay === undefined
      ? rejected(OUTSIDE_SUPPORTED_YEARS_REASON)
      : ready(undefined, endDay);
  }
  return rejected(PROJECT_TIMELINE_INVALID_RANGE_REASON);
}

function planStart(range: ProjectTimelineRange, day: string): ProjectTimelineEditPlan {
  const proposed = proposedDay(day);
  if (proposed === undefined) return rejected(INVALID_PROPOSED_DAY_REASON);
  if (range.kind === 'closed' || range.kind === 'open-start') {
    const end = ordinal(range.endDay);
    if (end === undefined) return rejected(PROJECT_TIMELINE_INVALID_RANGE_REASON);
    return ready(proposed.ordinal > end ? range.endDay : proposed.day, range.endDay);
  }
  return range.kind === 'open-end' || range.kind === 'unscheduled'
    ? ready(proposed.day)
    : rejected(PROJECT_TIMELINE_INVALID_RANGE_REASON);
}

function planEnd(range: ProjectTimelineRange, day: string): ProjectTimelineEditPlan {
  const proposed = proposedDay(day);
  if (proposed === undefined) return rejected(INVALID_PROPOSED_DAY_REASON);
  if (range.kind === 'closed' || range.kind === 'open-end') {
    const start = ordinal(range.startDay);
    if (start === undefined) return rejected(PROJECT_TIMELINE_INVALID_RANGE_REASON);
    return ready(range.startDay, proposed.ordinal < start ? range.startDay : proposed.day);
  }
  return range.kind === 'open-start' || range.kind === 'unscheduled'
    ? ready(undefined, proposed.day)
    : rejected(PROJECT_TIMELINE_INVALID_RANGE_REASON);
}

function planOpenEndAdjustment(
  range: Extract<ProjectTimelineRange, { kind: 'open-end' }>,
  deltaDays: number,
): ProjectTimelineEditPlan {
  const endDay = shifted(range.startDay, Math.max(0, deltaDays));
  return endDay === undefined
    ? rejected(OUTSIDE_SUPPORTED_YEARS_REASON)
    : ready(range.startDay, endDay);
}

function planClosedEndAdjustment(
  range: Extract<ProjectTimelineRange, { kind: 'closed' }>,
  deltaDays: number,
): ProjectTimelineEditPlan {
  const proposed = shifted(range.endDay, deltaDays);
  const start = ordinal(range.startDay);
  const end = proposed === undefined ? undefined : ordinal(proposed);
  if (proposed === undefined || end === undefined) return rejected(OUTSIDE_SUPPORTED_YEARS_REASON);
  return ready(range.startDay, start !== undefined && end < start ? range.startDay : proposed);
}

function planAdjustEnd(range: ProjectTimelineRange, deltaDays: number): ProjectTimelineEditPlan {
  if (!Number.isSafeInteger(deltaDays)) return rejected(INVALID_PROPOSED_DAY_REASON);
  if (range.kind === 'open-end') return planOpenEndAdjustment(range, deltaDays);
  if (range.kind === 'closed') return planClosedEndAdjustment(range, deltaDays);
  if (range.kind === 'open-start') {
    const endDay = shifted(range.endDay, deltaDays);
    return endDay === undefined
      ? rejected(OUTSIDE_SUPPORTED_YEARS_REASON)
      : ready(undefined, endDay);
  }
  return rejected(PROJECT_TIMELINE_INVALID_RANGE_REASON);
}

function planDraw(
  range: ProjectTimelineRange,
  startDay: string,
  endDay: string,
): ProjectTimelineEditPlan {
  if (range.kind !== 'unscheduled') return rejected(PROJECT_TIMELINE_INVALID_RANGE_REASON);
  const start = proposedDay(startDay);
  const end = proposedDay(endDay);
  if (start === undefined || end === undefined) return rejected(INVALID_PROPOSED_DAY_REASON);
  return start.ordinal <= end.ordinal ? ready(start.day, end.day) : ready(end.day, start.day);
}

/** Resolves a Timeline gesture into desired date-only endpoints without writing metadata. */
export function planProjectTimelineEdit(
  range: ProjectTimelineRange,
  intent: ProjectTimelineEditIntent,
): ProjectTimelineEditPlan {
  if (range.kind === 'malformed') return rejected(PROJECT_TIMELINE_INVALID_RANGE_REASON);
  if (intent.type === 'move') return planMove(range, intent.deltaDays);
  if (intent.type === 'resizeStart' || intent.type === 'setStart') {
    return planStart(range, intent.day);
  }
  if (intent.type === 'resizeEnd' || intent.type === 'setEnd') return planEnd(range, intent.day);
  if (intent.type === 'adjustEnd') return planAdjustEnd(range, intent.deltaDays);
  return planDraw(range, intent.startDay, intent.endDay);
}

function endpointEligibility(
  label: 'Start' | 'End',
  endpoint: ProjectTimelineRawEndpoint,
): ProjectTimelineRawEditEligibility {
  if (
    !endpoint.exists ||
    endpoint.value === undefined ||
    endpoint.value === null ||
    endpoint.value === ''
  ) {
    return { kind: 'eligible' };
  }
  const parsed = parseProjectDate(endpoint.value);
  if (parsed?.kind === 'date') return { kind: 'eligible' };
  const detail = parsed?.kind === 'datetime' ? 'contains a date and time' : 'is not a valid date';
  return {
    kind: 'ineligible',
    reason: `${label} ${detail}. Use the Start and End fields to edit this range.`,
  };
}

/** Rejects gesture editing when a nonempty raw endpoint cannot round-trip as a date-only value. */
export function projectTimelineRawEditEligibility(
  start: ProjectTimelineRawEndpoint,
  end: ProjectTimelineRawEndpoint,
): ProjectTimelineRawEditEligibility {
  const startEligibility = endpointEligibility('Start', start);
  return startEligibility.kind === 'ineligible'
    ? startEligibility
    : endpointEligibility('End', end);
}
