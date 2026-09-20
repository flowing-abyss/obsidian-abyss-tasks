import {
  MAX_PROJECT_CALENDAR_YEAR,
  MIN_PROJECT_CALENDAR_YEAR,
  parseProjectDate,
  projectCalendarDay,
  projectCalendarDayFromOrdinal,
  projectCalendarDayOrdinal,
} from './projectDateValue';
import {
  planProjectTimelineEdit,
  PROJECT_TIMELINE_INVALID_RANGE_REASON,
  projectTimelineRawEditEligibility,
  type ProjectTimelineEditIntent,
  type ProjectTimelineRawEndpoint,
} from './projectTimelineEdits';
import type { ProjectTimelineRange } from './projectTimelineModel';

export interface ProjectTimelineEndpointValues {
  readonly start: ProjectTimelineRawEndpoint;
  readonly end: ProjectTimelineRawEndpoint;
}

export type ProjectTimelineEndpointEditPlan =
  | {
      readonly kind: 'ready';
      readonly range: ProjectTimelineRange;
      readonly start: ProjectTimelineRawEndpoint;
      readonly end: ProjectTimelineRawEndpoint;
    }
  | { readonly kind: 'rejected'; readonly reason: string };

type ResolvedEndpoint =
  | { readonly kind: 'ready'; readonly endpoint: ProjectTimelineRawEndpoint }
  | { readonly kind: 'rejected'; readonly reason: string };

const INVALID_PROPOSAL =
  'The proposed Timeline date is invalid or outside the supported years 0100–9999.';
const TIME_SUFFIX = /T\d{2}:\d{2}(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?$/u;

function localClockOnDay(source: Date, day: string): Date | undefined {
  if (parseProjectDate(day)?.kind !== 'date') return undefined;
  const [year, month, date] = day.split('-').map(Number);
  if (
    year === undefined ||
    month === undefined ||
    date === undefined ||
    year < MIN_PROJECT_CALENDAR_YEAR ||
    year > MAX_PROJECT_CALENDAR_YEAR
  )
    return undefined;
  const expected = [
    year,
    month - 1,
    date,
    source.getHours(),
    source.getMinutes(),
    source.getSeconds(),
    source.getMilliseconds(),
  ];
  const value = new Date(0);
  value.setFullYear(year, month - 1, date);
  value.setHours(
    source.getHours(),
    source.getMinutes(),
    source.getSeconds(),
    source.getMilliseconds(),
  );
  const actual = [
    value.getFullYear(),
    value.getMonth(),
    value.getDate(),
    value.getHours(),
    value.getMinutes(),
    value.getSeconds(),
    value.getMilliseconds(),
  ];
  return actual.every((part, index) => part === expected[index]) ? value : undefined;
}

function sourceOffsetMinutes(suffix: string): number {
  if (suffix === '' || suffix === 'Z') return 0;
  const sign = suffix.startsWith('-') ? -1 : 1;
  return sign * (Number(suffix.slice(1, 3)) * 60 + Number(suffix.slice(4, 6)));
}

function serializationClock(
  value: Date,
  suffix: string,
): readonly [number, number, number, number, number, number, number] {
  const clock = new Date(value.getTime() + sourceOffsetMinutes(suffix) * 60_000);
  if (suffix === '')
    return [
      clock.getFullYear(),
      clock.getMonth() + 1,
      clock.getDate(),
      clock.getHours(),
      clock.getMinutes(),
      clock.getSeconds(),
      clock.getMilliseconds(),
    ];
  return [
    clock.getUTCFullYear(),
    clock.getUTCMonth() + 1,
    clock.getUTCDate(),
    clock.getUTCHours(),
    clock.getUTCMinutes(),
    clock.getUTCSeconds(),
    clock.getUTCMilliseconds(),
  ];
}

function requiredFractionDigits(millisecond: number): number {
  if (millisecond === 0) return 0;
  if (millisecond % 100 === 0) return 1;
  return millisecond % 10 === 0 ? 2 : 3;
}

function serializeClockPrecision(
  second: number,
  millisecond: number,
  sourceSeconds: string | undefined,
  sourceFraction: string | undefined,
): string {
  const precision = Math.max(sourceFraction?.length ?? 0, requiredFractionDigits(millisecond));
  const seconds =
    sourceSeconds !== undefined || second !== 0 || precision > 0
      ? `:${String(second).padStart(2, '0')}`
      : '';
  const fraction =
    precision > 0 ? `.${String(millisecond).padStart(3, '0').slice(0, precision)}` : '';
  return seconds + fraction;
}

function serializeLikeSource(value: Date, source: string): string | undefined {
  const match = TIME_SUFFIX.exec(source);
  if (match === null) return undefined;
  const suffix = match[3] ?? '';
  const [year, month, date, hour, minute, second, millisecond] = serializationClock(value, suffix);
  if (year < MIN_PROJECT_CALENDAR_YEAR || year > MAX_PROJECT_CALENDAR_YEAR) return undefined;
  const pad = (part: number): string => String(part).padStart(2, '0');
  const day = `${String(year).padStart(4, '0')}-${pad(month)}-${pad(date)}`;
  const precision = serializeClockPrecision(second, millisecond, match[1], match[2]);
  const serialized = `${day}T${pad(hour)}:${pad(minute)}${precision}${suffix}`;
  return parseProjectDate(serialized)?.value.getTime() === value.getTime() ? serialized : undefined;
}

function supportedDay(day: string): boolean {
  const parsed = parseProjectDate(day);
  return (
    parsed?.kind === 'date' &&
    parsed.value.getFullYear() >= MIN_PROJECT_CALENDAR_YEAR &&
    parsed.value.getFullYear() <= MAX_PROJECT_CALENDAR_YEAR
  );
}

function parsedEndpoint(endpoint: ProjectTimelineRawEndpoint): ReturnType<typeof parseProjectDate> {
  return endpoint.exists ? parseProjectDate(endpoint.value) : undefined;
}

function timedEndpointOnDay(
  label: 'Start' | 'End',
  source: Date,
  encoding: string,
  desiredDay: string,
): ResolvedEndpoint {
  const clock = localClockOnDay(source, desiredDay);
  if (clock === undefined)
    return {
      kind: 'rejected',
      reason: `${label}'s local time does not exist on ${desiredDay}. Choose another day or edit its time in the date field.`,
    };
  const value = serializeLikeSource(clock, encoding);
  return value === undefined
    ? { kind: 'rejected', reason: INVALID_PROPOSAL }
    : { kind: 'ready', endpoint: { exists: true, value } };
}

function endpointOnDay(
  label: 'Start' | 'End',
  source: ProjectTimelineRawEndpoint,
  counterpart: ProjectTimelineRawEndpoint,
  desiredDay: string | undefined,
): ResolvedEndpoint {
  if (
    desiredDay === undefined ||
    (source.exists && projectCalendarDay(source.value) === desiredDay)
  )
    return { kind: 'ready', endpoint: source };
  if (!supportedDay(desiredDay)) return { kind: 'rejected', reason: INVALID_PROPOSAL };
  const template = parsedEndpoint(source) === undefined ? counterpart : source;
  const parsed = parsedEndpoint(template);
  if (parsed?.kind !== 'datetime' || typeof template.value !== 'string')
    return { kind: 'ready', endpoint: { exists: true, value: desiredDay } };
  return timedEndpointOnDay(label, parsed.value, template.value, desiredDay);
}

function reversed(endpoints: ProjectTimelineEndpointValues): boolean {
  const start = endpoints.start.exists ? parseProjectDate(endpoints.start.value) : undefined;
  const end = endpoints.end.exists ? parseProjectDate(endpoints.end.value) : undefined;
  return start !== undefined && end !== undefined && start.value.getTime() > end.value.getTime();
}

function projectedRange(endpoints: ProjectTimelineEndpointValues): ProjectTimelineRange {
  const startDay = endpoints.start.exists ? projectCalendarDay(endpoints.start.value) : undefined;
  const endDay = endpoints.end.exists ? projectCalendarDay(endpoints.end.value) : undefined;
  if (startDay !== undefined && endDay !== undefined) return { kind: 'closed', startDay, endDay };
  if (startDay !== undefined) return { kind: 'open-end', startDay };
  if (endDay !== undefined) return { kind: 'open-start', endDay };
  return { kind: 'unscheduled' };
}

function shiftEditedEndpoint(
  final: ProjectTimelineEndpointValues,
  original: ProjectTimelineEndpointValues,
  editsStart: boolean,
): ResolvedEndpoint {
  const endpoint = editsStart ? final.start : final.end;
  const ordinal = projectCalendarDayOrdinal(projectCalendarDay(endpoint.value));
  if (ordinal === undefined) return { kind: 'rejected', reason: INVALID_PROPOSAL };
  const direction = editsStart ? -1 : 1;
  const nextDay = projectCalendarDayFromOrdinal(ordinal + direction);
  if (nextDay === undefined || !supportedDay(nextDay))
    return { kind: 'rejected', reason: INVALID_PROPOSAL };
  return editsStart
    ? endpointOnDay('Start', original.start, original.end, nextDay)
    : endpointOnDay('End', original.end, original.start, nextDay);
}

function orderedPlan(
  proposed: ProjectTimelineEndpointValues,
  original: ProjectTimelineEndpointValues,
  intent: ProjectTimelineEditIntent,
): ProjectTimelineEndpointEditPlan {
  let final = proposed;
  const editsStart = intent.type === 'resizeStart' || intent.type === 'setStart';
  while (reversed(final)) {
    if (intent.type === 'move' || intent.type === 'draw')
      return {
        kind: 'rejected',
        reason: 'The proposed Timeline move would reverse the project dates.',
      };
    const resolved = shiftEditedEndpoint(final, original, editsStart);
    if (resolved.kind === 'rejected') return resolved;
    final = editsStart
      ? { ...final, start: resolved.endpoint }
      : { ...final, end: resolved.endpoint };
  }
  return { kind: 'ready', range: projectedRange(final), ...final };
}

/** Resolves calendar intent into lossless raw endpoints and their final displayed range. */
export function planProjectTimelineEndpointEdit(
  range: ProjectTimelineRange,
  endpoints: ProjectTimelineEndpointValues,
  intent: ProjectTimelineEditIntent,
): ProjectTimelineEndpointEditPlan {
  const eligibility = projectTimelineRawEditEligibility(endpoints.start, endpoints.end);
  if (eligibility.kind === 'ineligible') return { kind: 'rejected', reason: eligibility.reason };
  if (reversed(endpoints))
    return { kind: 'rejected', reason: PROJECT_TIMELINE_INVALID_RANGE_REASON };
  const days = planProjectTimelineEdit(range, intent);
  if (days.kind === 'rejected') return days;
  const start = endpointOnDay('Start', endpoints.start, endpoints.end, days.startDay);
  if (start.kind === 'rejected') return start;
  const end = endpointOnDay('End', endpoints.end, endpoints.start, days.endDay);
  if (end.kind === 'rejected') return end;
  return orderedPlan({ start: start.endpoint, end: end.endpoint }, endpoints, intent);
}
