import {
  parseProjectDate,
  projectCalendarDayFromOrdinal,
  projectCalendarDayFromParsed,
  projectCalendarDayOrdinal,
  type ParsedProjectDate,
} from './projectDateValue';
import {
  findProjectFieldById,
  projectFieldValue,
  type ProjectTableSettings,
} from './projectFields';
import {
  buildProjectTableModel,
  type ProjectTableGroup,
  type ProjectTableModelInput,
} from './projectTableModel';
import type { ProjectTimelineScale, ProjectTimelineSettings } from './projectTimelineSettings';
import type { Project } from './types';

export type ProjectTimelineRange =
  | { readonly kind: 'closed'; readonly startDay: string; readonly endDay: string }
  | { readonly kind: 'open-end'; readonly startDay: string }
  | { readonly kind: 'open-start'; readonly endDay: string }
  | { readonly kind: 'unscheduled' }
  | { readonly kind: 'malformed'; readonly start: unknown; readonly end: unknown };

export interface ProjectTimelineRow {
  readonly occurrenceId: string;
  readonly project: Project;
  readonly range: ProjectTimelineRange;
}

export interface ProjectTimelineGroup extends Omit<ProjectTableGroup, 'projects'> {
  readonly rows: ProjectTimelineRow[];
}

export interface ProjectTimelineModel {
  readonly groups: ProjectTimelineGroup[];
  readonly uniqueVisibleCount: number;
  readonly availableStatusGroups: ReturnType<
    typeof buildProjectTableModel
  >['availableStatusGroups'];
}

export interface ProjectTimelineModelInput extends Omit<ProjectTableModelInput, 'settings'> {
  readonly settings: ProjectTimelineSettings;
  readonly tableSettings?: ProjectTableSettings;
}

export interface ProjectTimelineWindow {
  readonly startDay: string;
  readonly endDay: string;
  readonly dayCount: number;
  readonly scale: ProjectTimelineScale;
  readonly ticks: readonly ProjectTimelineTick[];
}

export interface ProjectTimelineTick {
  readonly day: string;
  readonly label: string;
}

export interface ProjectTimelineBarGeometry {
  readonly leftPercent: number;
  readonly widthPercent: number;
}

const DAY_MS = 86_400_000;

function dayOrdinal(day: string): number {
  return projectCalendarDayOrdinal(day) as number;
}

function dayString(ordinal: number): string {
  return projectCalendarDayFromOrdinal(ordinal) as string;
}

function localDay(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

function tickLabel(ordinal: number, scale: ProjectTimelineScale): string {
  const value = new Date(ordinal * 86_400_000);
  const year = value.getUTCFullYear();
  const month = value.getUTCMonth();
  const date = value.getUTCDate();
  if (scale === 'day') return `${WEEKDAYS[value.getUTCDay()]} ${date}`;
  if (scale === 'week') return `${MONTHS[month]} ${date}`;
  if (scale === 'month') return MONTHS[month] as string;
  if (scale === 'quarter') return `Q${Math.floor(month / 3) + 1} ${year}`;
  return String(year).padStart(4, '0');
}

function nextTickOrdinal(ordinal: number, scale: ProjectTimelineScale): number {
  if (scale === 'day') return ordinal + 1;
  if (scale === 'week') return ordinal + 7;
  const value = new Date(ordinal * 86_400_000);
  if (scale === 'month') value.setUTCFullYear(value.getUTCFullYear(), value.getUTCMonth() + 1, 1);
  else if (scale === 'quarter') {
    value.setUTCFullYear(value.getUTCFullYear(), value.getUTCMonth() + 3, 1);
  } else value.setUTCFullYear(value.getUTCFullYear() + 1, 0, 1);
  return Math.floor(value.getTime() / 86_400_000);
}

function firstWeekTick(first: number, value: Date): number {
  const offset = (value.getUTCDay() + 6) % 7;
  return first + (offset === 0 ? 0 : 7 - offset);
}

function firstMonthTick(value: Date): number {
  if (value.getUTCDate() > 1) {
    value.setUTCFullYear(value.getUTCFullYear(), value.getUTCMonth() + 1, 1);
  }
  return Math.floor(value.getTime() / 86_400_000);
}

function firstQuarterTick(value: Date): number {
  const month = value.getUTCMonth();
  const quarterMonth = Math.floor(month / 3) * 3;
  const onQuarterStart = month === quarterMonth && value.getUTCDate() === 1;
  value.setUTCFullYear(value.getUTCFullYear(), onQuarterStart ? quarterMonth : quarterMonth + 3, 1);
  return Math.floor(value.getTime() / 86_400_000);
}

function firstYearTick(value: Date): number {
  if (value.getUTCMonth() !== 0 || value.getUTCDate() !== 1) {
    value.setUTCFullYear(value.getUTCFullYear() + 1, 0, 1);
  }
  return Math.floor(value.getTime() / 86_400_000);
}

function firstTickOrdinal(first: number, scale: ProjectTimelineScale): number {
  if (scale === 'day') return first;
  const value = new Date(first * DAY_MS);
  if (scale === 'week') return firstWeekTick(first, value);
  if (scale === 'month') return firstMonthTick(value);
  if (scale === 'quarter') return firstQuarterTick(value);
  return firstYearTick(value);
}

function timelineTicks(
  first: number,
  last: number,
  scale: ProjectTimelineScale,
): ProjectTimelineTick[] {
  const ordinals: number[] = [];
  for (
    let ordinal = firstTickOrdinal(first, scale);
    ordinal <= last;
    ordinal = nextTickOrdinal(ordinal, scale)
  ) {
    ordinals.push(ordinal);
  }
  if (ordinals.length === 0) ordinals.push(first);
  const stride = Math.max(1, Math.ceil(ordinals.length / 14));
  return ordinals
    .filter((_ordinal, index) => index % stride === 0)
    .map((ordinal) => ({ day: dayString(ordinal), label: tickLabel(ordinal, scale) }));
}

function missingDate(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function malformedEndpoint(missing: boolean, parsed: ParsedProjectDate | undefined): boolean {
  return !missing && parsed === undefined;
}

function malformedEndpoints(
  startMissing: boolean,
  start: ParsedProjectDate | undefined,
  endMissing: boolean,
  end: ParsedProjectDate | undefined,
): boolean {
  return malformedEndpoint(startMissing, start) || malformedEndpoint(endMissing, end);
}

function parsedEndpoint(value: unknown): ParsedProjectDate | undefined {
  return missingDate(value) ? undefined : parseProjectDate(value);
}

function reversedEndpoints(
  start: ParsedProjectDate | undefined,
  end: ParsedProjectDate | undefined,
): boolean {
  return start !== undefined && end !== undefined && end.value.getTime() < start.value.getTime();
}

function projectedRange(
  start: ParsedProjectDate | undefined,
  end: ParsedProjectDate | undefined,
): ProjectTimelineRange {
  const startDay = start === undefined ? undefined : projectCalendarDayFromParsed(start);
  const endDay = end === undefined ? undefined : projectCalendarDayFromParsed(end);
  if (startDay !== undefined && endDay !== undefined) return { kind: 'closed', startDay, endDay };
  if (startDay === undefined) return { kind: 'open-start', endDay: endDay as string };
  return { kind: 'open-end', startDay };
}

function timelineRange(project: Project, input: ProjectTimelineModelInput): ProjectTimelineRange {
  const startField = findProjectFieldById(input.fields, 'start');
  const endField = findProjectFieldById(input.fields, 'end');
  const start = startField === undefined ? undefined : projectFieldValue(project, startField);
  const end = endField === undefined ? undefined : projectFieldValue(project, endField);
  const startMissing = missingDate(start);
  const endMissing = missingDate(end);
  if (startMissing && endMissing) return { kind: 'unscheduled' };
  const parsedStart = parsedEndpoint(start);
  const parsedEnd = parsedEndpoint(end);
  if (malformedEndpoints(startMissing, parsedStart, endMissing, parsedEnd)) {
    return { kind: 'malformed', start, end };
  }
  if (reversedEndpoints(parsedStart, parsedEnd)) {
    return { kind: 'malformed', start, end };
  }
  return projectedRange(parsedStart, parsedEnd);
}

function tableProjectionSettings(input: ProjectTimelineModelInput): ProjectTableSettings {
  const base = input.tableSettings;
  return {
    columns: (base?.columns ?? input.fields.map(({ id }) => ({ id, visible: true }))).map(
      (column) => ({
        ...column,
      }),
    ),
    showDescription: base?.showDescription ?? true,
    ...(base?.progress === undefined ? {} : { progress: base.progress }),
    ...(base?.dateDisplay === undefined ? {} : { dateDisplay: base.dateDisplay }),
    groupBy: input.settings.groupBy,
    sortBy: { ...input.settings.sortBy },
    hiddenStatuses: [...input.settings.hiddenStatuses],
  };
}

export function buildProjectTimelineModel(input: ProjectTimelineModelInput): ProjectTimelineModel {
  const shared = buildProjectTableModel({ ...input, settings: tableProjectionSettings(input) });
  const groups = shared.groups
    .map(({ projects, ...group }) => ({
      ...group,
      rows: projects
        .map((project) => ({
          occurrenceId: `${group.key}\u0000${project.path}`,
          project,
          range: timelineRange(project, input),
        }))
        .filter(({ range }) => input.settings.showUnscheduled || range.kind !== 'unscheduled'),
    }))
    .filter(({ rows }) => rows.length > 0);
  const visiblePaths = new Set(
    groups.flatMap(({ rows }) => rows.map(({ project }) => project.path)),
  );
  return {
    groups,
    uniqueVisibleCount: visiblePaths.size,
    availableStatusGroups: shared.availableStatusGroups,
  };
}

const FIXED_WINDOW_SPECS = {
  day: { weekOffset: 0, dayCount: 14 },
  week: { weekOffset: -35, dayCount: 84 },
} as const;

function calendarYearRadius(scale: 'month' | 'quarter' | 'year'): number {
  if (scale === 'month') return 0;
  return scale === 'quarter' ? 1 : 2;
}

export function projectTimelineWindow(
  anchor: Date,
  scale: ProjectTimelineScale,
): ProjectTimelineWindow {
  const anchorOrdinal = dayOrdinal(localDay(anchor));
  const anchorValue = new Date(anchorOrdinal * DAY_MS);
  const year = anchorValue.getUTCFullYear();
  let first: number;
  let last: number;
  if (scale === 'day' || scale === 'week') {
    const weekStart = anchorOrdinal - ((anchorValue.getUTCDay() + 6) % 7);
    const spec = FIXED_WINDOW_SPECS[scale];
    first = weekStart + spec.weekOffset;
    last = first + spec.dayCount - 1;
  } else {
    const yearRadius = calendarYearRadius(scale);
    first = dayOrdinal(`${String(year - yearRadius).padStart(4, '0')}-01-01`);
    last = dayOrdinal(`${String(year + yearRadius).padStart(4, '0')}-12-31`);
  }
  return projectTimelineWindowForRange(dayString(first), dayString(last), scale);
}

/** Builds an inclusive range window with a bounded axis tick count. */
export function projectTimelineWindowForRange(
  startDay: string,
  endDay: string,
  scale: ProjectTimelineScale = 'day',
): ProjectTimelineWindow {
  const first = dayOrdinal(startDay);
  const last = Math.max(first, dayOrdinal(endDay));
  const dayCount = last - first + 1;
  return {
    startDay: dayString(first),
    endDay: dayString(last),
    dayCount,
    scale,
    ticks: timelineTicks(first, last, scale),
  };
}

export function projectTimelineBarGeometry(
  range: ProjectTimelineRange,
  window: ProjectTimelineWindow,
): ProjectTimelineBarGeometry | undefined {
  if (range.kind === 'unscheduled' || range.kind === 'malformed') return undefined;
  const windowStart = dayOrdinal(window.startDay);
  const windowEnd = dayOrdinal(window.endDay);
  const start = range.kind === 'open-start' ? dayOrdinal(range.endDay) : dayOrdinal(range.startDay);
  const end = range.kind === 'open-end' ? dayOrdinal(range.startDay) : dayOrdinal(range.endDay);
  const visibleStart = Math.max(windowStart, start);
  const visibleEnd = Math.min(windowEnd, end);
  if (visibleStart > visibleEnd) return undefined;
  return {
    leftPercent: ((visibleStart - windowStart) / window.dayCount) * 100,
    widthPercent: ((visibleEnd - visibleStart + 1) / window.dayCount) * 100,
  };
}
