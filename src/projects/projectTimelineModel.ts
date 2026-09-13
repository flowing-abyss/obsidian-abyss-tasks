import {
  parseProjectDate,
  projectCalendarDayFromParsed,
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
  readonly ticks: readonly string[];
}

export interface ProjectTimelineBarGeometry {
  readonly leftPercent: number;
  readonly widthPercent: number;
}

const DAY_MS = 86_400_000;

function dayOrdinal(day: string): number {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const value = new Date(0);
  value.setUTCHours(0, 0, 0, 0);
  value.setUTCFullYear(year, month - 1, date);
  return Math.floor(value.getTime() / DAY_MS);
}

function dayString(ordinal: number): string {
  const value = new Date(ordinal * DAY_MS);
  const year = String(value.getUTCFullYear()).padStart(4, '0');
  const month = String(value.getUTCMonth() + 1).padStart(2, '0');
  const date = String(value.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${date}`;
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

export function projectTimelineWindow(
  anchor: Date,
  scale: ProjectTimelineScale,
): ProjectTimelineWindow {
  const start = new Date(0);
  start.setFullYear(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  if (scale === 'week') {
    const mondayOffset = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - mondayOffset);
    end.setTime(start.getTime());
    end.setDate(end.getDate() + 6);
  } else if (scale === 'month') {
    start.setDate(1);
    end.setFullYear(start.getFullYear(), start.getMonth() + 1, 0);
  } else {
    const quarter = Math.floor(start.getMonth() / 3) * 3;
    start.setMonth(quarter, 1);
    end.setFullYear(start.getFullYear(), quarter + 3, 0);
  }
  return projectTimelineWindowForRange(localDay(start), localDay(end));
}

/** Builds an inclusive range window with a bounded axis tick count. */
export function projectTimelineWindowForRange(
  startDay: string,
  endDay: string,
): ProjectTimelineWindow {
  const first = dayOrdinal(startDay);
  const last = Math.max(first, dayOrdinal(endDay));
  const dayCount = last - first + 1;
  const step = Math.max(1, Math.ceil(dayCount / 14));
  const ticks: string[] = [];
  for (let ordinal = first; ordinal <= last; ordinal += step) ticks.push(dayString(ordinal));
  if (ticks[ticks.length - 1] !== dayString(last)) ticks.push(dayString(last));
  return { startDay: dayString(first), endDay: dayString(last), dayCount, ticks };
}

export function projectTimelineBarGeometry(
  range: ProjectTimelineRange,
  window: ProjectTimelineWindow,
): ProjectTimelineBarGeometry | undefined {
  if (range.kind === 'unscheduled' || range.kind === 'malformed') return undefined;
  const windowStart = dayOrdinal(window.startDay);
  const windowEnd = dayOrdinal(window.endDay);
  const start = range.kind === 'open-start' ? windowStart : dayOrdinal(range.startDay);
  const end = range.kind === 'open-end' ? windowEnd : dayOrdinal(range.endDay);
  const visibleStart = Math.max(windowStart, start);
  const visibleEnd = Math.min(windowEnd, end);
  if (visibleStart > visibleEnd) return undefined;
  return {
    leftPercent: ((visibleStart - windowStart) / window.dayCount) * 100,
    widthPercent: ((visibleEnd - visibleStart + 1) / window.dayCount) * 100,
  };
}
