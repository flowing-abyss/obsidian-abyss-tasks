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

/** Builds an inclusive range window for scale-aware calendar geometry. */
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
  };
}

/** Fits literal project bounds outward to complete units for the selected scale. */
export function projectTimelineFitWindow(
  startDay: string,
  endDay: string,
  scale: ProjectTimelineScale,
): ProjectTimelineWindow {
  let first = dayOrdinal(startDay);
  let last = Math.max(first, dayOrdinal(endDay));
  if (scale === 'week') {
    const firstWeekday = (new Date(first * DAY_MS).getUTCDay() + 6) % 7;
    const lastWeekday = (new Date(last * DAY_MS).getUTCDay() + 6) % 7;
    first -= firstWeekday;
    last += 6 - lastWeekday;
  } else if (scale !== 'day') {
    const firstValue = new Date(first * DAY_MS);
    const lastValue = new Date(last * DAY_MS);
    if (scale === 'month') {
      firstValue.setUTCDate(1);
      lastValue.setUTCFullYear(lastValue.getUTCFullYear(), lastValue.getUTCMonth() + 1, 0);
    } else if (scale === 'quarter') {
      const firstQuarter = Math.floor(firstValue.getUTCMonth() / 3) * 3;
      const lastQuarter = Math.floor(lastValue.getUTCMonth() / 3) * 3;
      firstValue.setUTCFullYear(firstValue.getUTCFullYear(), firstQuarter, 1);
      lastValue.setUTCFullYear(lastValue.getUTCFullYear(), lastQuarter + 3, 0);
    } else {
      firstValue.setUTCFullYear(firstValue.getUTCFullYear(), 0, 1);
      lastValue.setUTCFullYear(lastValue.getUTCFullYear(), 12, 0);
    }
    first = Math.floor(firstValue.getTime() / DAY_MS);
    last = Math.floor(lastValue.getTime() / DAY_MS);
  }
  return projectTimelineWindowForRange(dayString(first), dayString(last), scale);
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
