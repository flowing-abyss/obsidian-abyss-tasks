import { projectCalendarDayFromOrdinal, projectCalendarDayOrdinal } from './projectDateValue';
import type { ProjectTimelineScale } from './projectTimelineSettings';

export const PROJECT_TIMELINE_MAX_TRACK_WIDTH = 16_000_000;

const DAY_MS = 86_400_000;
const DEFAULT_OVERSCAN_CELLS = 0;
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

const MINIMUM_DAY_WIDTH = {
  day: 32,
  week: 84 / 7,
  month: 120 / 28,
  quarter: 144 / 90,
  year: 200 / 365,
} satisfies Record<ProjectTimelineScale, number>;

export interface ProjectTimelineAxisWindow {
  readonly startDay: string;
  readonly endDay: string;
  readonly dayCount: number;
  readonly scale: ProjectTimelineScale;
}

export interface ProjectTimelineAxisCell {
  readonly startDay: string;
  readonly endDay: string;
  readonly startOrdinal: number;
  readonly endOrdinal: number;
  readonly label: string;
  readonly secondaryLabel?: string;
  readonly leftPercent: number;
  readonly rightPercent: number;
  readonly labelPercent: number;
  readonly isToday: boolean;
}

export interface ProjectTimelineGridBoundary {
  readonly day: string;
  readonly ordinal: number;
  readonly leftPercent: number;
  readonly weight: 'major' | 'minor';
}

export interface ProjectTimelineAxisLayout {
  readonly cells: readonly ProjectTimelineAxisCell[];
  readonly hierarchyCells: readonly ProjectTimelineAxisCell[];
  readonly gridBoundaries: readonly ProjectTimelineGridBoundary[];
}

export interface ProjectTimelineAxisSlice {
  readonly visibleStartDay: string;
  readonly visibleEndDay: string;
  readonly visibleStartPercent?: number;
  readonly overscanCells?: number;
  readonly todayDay?: string;
}

interface AxisLayoutBounds {
  readonly windowStart: number;
  readonly windowEnd: number;
  readonly firstVisible: number;
  readonly lastVisible: number;
  readonly windowDayCount: number;
  readonly visibleStartPercent: number;
  readonly todayOrdinal: number | undefined;
}

function ordinal(day: string): number {
  return projectCalendarDayOrdinal(day) as number;
}

function day(ordinalValue: number): string {
  return projectCalendarDayFromOrdinal(ordinalValue) as string;
}

function date(ordinalValue: number): Date {
  return new Date(ordinalValue * DAY_MS);
}

function dateOrdinal(value: Date): number {
  return Math.floor(value.getTime() / DAY_MS);
}

function intervalStart(ordinalValue: number, scale: ProjectTimelineScale): number {
  if (scale === 'day') return ordinalValue;
  const value = date(ordinalValue);
  if (scale === 'week') return ordinalValue - ((value.getUTCDay() + 6) % 7);
  if (scale === 'month') {
    value.setUTCFullYear(value.getUTCFullYear(), value.getUTCMonth(), 1);
  } else if (scale === 'quarter') {
    value.setUTCFullYear(value.getUTCFullYear(), Math.floor(value.getUTCMonth() / 3) * 3, 1);
  } else {
    value.setUTCFullYear(value.getUTCFullYear(), 0, 1);
  }
  return dateOrdinal(value);
}

function nextIntervalStart(ordinalValue: number, scale: ProjectTimelineScale): number {
  if (scale === 'day') return ordinalValue + 1;
  if (scale === 'week') return ordinalValue + 7;
  const value = date(ordinalValue);
  if (scale === 'month') {
    value.setUTCFullYear(value.getUTCFullYear(), value.getUTCMonth() + 1, 1);
  } else if (scale === 'quarter') {
    value.setUTCFullYear(value.getUTCFullYear(), value.getUTCMonth() + 3, 1);
  } else {
    value.setUTCFullYear(value.getUTCFullYear() + 1, 0, 1);
  }
  return dateOrdinal(value);
}

function previousIntervalStart(ordinalValue: number, scale: ProjectTimelineScale): number {
  return intervalStart(ordinalValue - 1, scale);
}

function isoWeekNumber(mondayOrdinal: number): number {
  const thursday = date(mondayOrdinal + 3);
  const isoYear = thursday.getUTCFullYear();
  const januaryFourth = new Date(0);
  januaryFourth.setUTCHours(0, 0, 0, 0);
  januaryFourth.setUTCFullYear(isoYear, 0, 4);
  const januaryFourthOrdinal = dateOrdinal(januaryFourth);
  const firstMonday = januaryFourthOrdinal - ((januaryFourth.getUTCDay() + 6) % 7);
  return Math.floor((mondayOrdinal - firstMonday) / 7) + 1;
}

function intervalLabels(
  ordinalValue: number,
  scale: ProjectTimelineScale,
): Pick<ProjectTimelineAxisCell, 'label' | 'secondaryLabel'> {
  const value = date(ordinalValue);
  if (scale === 'day') {
    return {
      label: WEEKDAYS[value.getUTCDay()] as string,
      secondaryLabel: String(value.getUTCDate()),
    };
  }
  if (scale === 'week') {
    return { label: `W${String(isoWeekNumber(ordinalValue)).padStart(2, '0')}` };
  }
  if (scale === 'month') return { label: MONTHS[value.getUTCMonth()] as string };
  if (scale === 'quarter') {
    return { label: `Q${String(Math.floor(value.getUTCMonth() / 3) + 1)}` };
  }
  return { label: String(value.getUTCFullYear()).padStart(4, '0') };
}

function hierarchyScale(scale: ProjectTimelineScale): ProjectTimelineScale | undefined {
  if (scale === 'day' || scale === 'week') return 'month';
  if (scale === 'month') return 'quarter';
  return scale === 'quarter' ? 'year' : undefined;
}

function hierarchyLabel(
  ordinalValue: number,
  scale: Exclude<ProjectTimelineScale, 'day' | 'week'>,
): Pick<ProjectTimelineAxisCell, 'label' | 'secondaryLabel'> {
  const value = date(ordinalValue);
  const year = String(value.getUTCFullYear()).padStart(4, '0');
  if (scale === 'month') {
    return { label: MONTHS[value.getUTCMonth()] as string, secondaryLabel: year };
  }
  if (scale === 'quarter') {
    return { label: `Q${String(Math.floor(value.getUTCMonth() / 3) + 1)}`, secondaryLabel: year };
  }
  return { label: year };
}

function expandedSlice(
  windowStart: number,
  windowEnd: number,
  slice: ProjectTimelineAxisSlice,
  scale: ProjectTimelineScale,
): readonly [number, number] {
  let first = Math.max(windowStart, Math.min(windowEnd, ordinal(slice.visibleStartDay)));
  let last = Math.max(first, Math.min(windowEnd, ordinal(slice.visibleEndDay)));
  const overscan = Math.max(0, Math.floor(slice.overscanCells ?? DEFAULT_OVERSCAN_CELLS));
  first = intervalStart(first, scale);
  last = nextIntervalStart(intervalStart(last, scale), scale) - 1;
  for (let index = 0; index < overscan; index += 1) {
    first = previousIntervalStart(first, scale);
    last = nextIntervalStart(last + 1, scale) - 1;
  }
  return [Math.max(windowStart, first), Math.min(windowEnd, last)];
}

function buildCells(
  bounds: AxisLayoutBounds,
  scale: ProjectTimelineScale,
  hierarchy: boolean,
): ProjectTimelineAxisCell[] {
  const cells: ProjectTimelineAxisCell[] = [];
  let unitStart = intervalStart(bounds.firstVisible, scale);
  while (unitStart <= bounds.lastVisible) {
    cells.push(buildCell(bounds, scale, hierarchy, unitStart));
    unitStart = nextIntervalStart(unitStart, scale);
  }
  return cells;
}

function buildCell(
  bounds: AxisLayoutBounds,
  scale: ProjectTimelineScale,
  hierarchy: boolean,
  unitStart: number,
): ProjectTimelineAxisCell {
  const startOrdinal = Math.max(bounds.windowStart, unitStart);
  const endOrdinal = Math.min(bounds.windowEnd, nextIntervalStart(unitStart, scale) - 1);
  const labels = hierarchy
    ? hierarchyLabel(unitStart, scale as Exclude<ProjectTimelineScale, 'day' | 'week'>)
    : intervalLabels(unitStart, scale);
  const leftPercent = ((startOrdinal - bounds.windowStart) / bounds.windowDayCount) * 100;
  const rightPercent = ((endOrdinal + 1 - bounds.windowStart) / bounds.windowDayCount) * 100;
  return {
    startDay: day(startOrdinal),
    endDay: day(endOrdinal),
    startOrdinal,
    endOrdinal,
    ...labels,
    leftPercent,
    rightPercent,
    labelPercent: hierarchy
      ? Math.max(leftPercent, Math.min(rightPercent, bounds.visibleStartPercent))
      : leftPercent,
    isToday:
      bounds.todayOrdinal !== undefined &&
      bounds.todayOrdinal >= startOrdinal &&
      bounds.todayOrdinal <= endOrdinal,
  };
}

function boundaryScales(scale: ProjectTimelineScale): ReadonlyArray<{
  readonly scale: ProjectTimelineScale;
  readonly weight: ProjectTimelineGridBoundary['weight'];
}> {
  if (scale === 'day') {
    return [
      { scale: 'day', weight: 'minor' },
      { scale: 'week', weight: 'major' },
      { scale: 'month', weight: 'major' },
    ];
  }
  if (scale === 'week') {
    return [
      { scale: 'week', weight: 'major' },
      { scale: 'month', weight: 'major' },
    ];
  }
  if (scale === 'month') {
    return [
      { scale: 'week', weight: 'minor' },
      { scale: 'month', weight: 'major' },
    ];
  }
  if (scale === 'quarter') {
    return [
      { scale: 'month', weight: 'minor' },
      { scale: 'quarter', weight: 'major' },
    ];
  }
  return [
    { scale: 'quarter', weight: 'minor' },
    { scale: 'year', weight: 'major' },
  ];
}

function buildGridBoundaries(
  bounds: AxisLayoutBounds,
  scale: ProjectTimelineScale,
): ProjectTimelineGridBoundary[] {
  const { windowStart, windowDayCount } = bounds;
  const boundaries = new Map<number, ProjectTimelineGridBoundary['weight']>();
  for (const spec of boundaryScales(scale)) {
    addGridBoundaries(boundaries, bounds, spec);
  }
  return Array.from(boundaries, ([ordinalValue, weight]) => ({
    day: day(ordinalValue),
    ordinal: ordinalValue,
    leftPercent: ((ordinalValue - windowStart) / windowDayCount) * 100,
    weight,
  })).sort((left, right) => left.ordinal - right.ordinal);
}

function addGridBoundaries(
  boundaries: Map<number, ProjectTimelineGridBoundary['weight']>,
  bounds: AxisLayoutBounds,
  spec: {
    readonly scale: ProjectTimelineScale;
    readonly weight: ProjectTimelineGridBoundary['weight'];
  },
): void {
  let current = intervalStart(bounds.firstVisible, spec.scale);
  while (current <= bounds.lastVisible) {
    if (current >= bounds.windowStart) {
      const previous = boundaries.get(current);
      if (previous !== 'major') boundaries.set(current, spec.weight);
    }
    current = nextIntervalStart(current, spec.scale);
  }
}

export function projectTimelineAxisLayout(
  window: ProjectTimelineAxisWindow,
  slice: ProjectTimelineAxisSlice,
): ProjectTimelineAxisLayout {
  const windowStart = ordinal(window.startDay);
  const windowEnd = ordinal(window.endDay);
  const [firstVisible, lastVisible] = expandedSlice(windowStart, windowEnd, slice, window.scale);
  const todayOrdinal = slice.todayDay === undefined ? undefined : ordinal(slice.todayDay);
  const visibleStartOrdinal = Math.max(
    windowStart,
    Math.min(windowEnd, ordinal(slice.visibleStartDay)),
  );
  const visibleStartPercent = Math.max(
    0,
    Math.min(
      100,
      slice.visibleStartPercent ?? ((visibleStartOrdinal - windowStart) / window.dayCount) * 100,
    ),
  );
  const bounds: AxisLayoutBounds = {
    windowStart,
    windowEnd,
    firstVisible,
    lastVisible,
    windowDayCount: window.dayCount,
    visibleStartPercent,
    todayOrdinal,
  };
  const cells = buildCells(bounds, window.scale, false);
  const parentScale = hierarchyScale(window.scale);
  const hierarchyCells = parentScale === undefined ? [] : buildCells(bounds, parentScale, true);
  return {
    cells,
    hierarchyCells,
    gridBoundaries: buildGridBoundaries(bounds, window.scale),
  };
}

export function projectTimelineTrackWidth(
  window: ProjectTimelineAxisWindow,
  viewportWidth: number,
): number {
  const readableWidth = window.dayCount * MINIMUM_DAY_WIDTH[window.scale];
  const requested = Math.max(Number.isFinite(viewportWidth) ? viewportWidth : 0, readableWidth);
  return Math.min(PROJECT_TIMELINE_MAX_TRACK_WIDTH, Math.max(1, Math.ceil(requested)));
}
