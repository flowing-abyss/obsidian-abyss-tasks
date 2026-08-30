import { addCivilDays, parseProjectDate } from '../../projects/projectDates';
import { isTimelineScale, type TimelineScale, type TimelineScope } from './timelinePreferences';

const MILLIS_PER_CIVIL_DAY = 86_400_000;
const FIRST_SUPPORTED_CIVIL_DATE = '0000-01-01';
const LAST_SUPPORTED_CIVIL_DATE = '9999-12-31';
export const TIMELINE_SAME_DAY_RANGE_MIN_WIDTH = 6;
export const TIMELINE_POINT_SIZE = 8;
export const TIMELINE_MILESTONE_SIZE = 10;

const PIXELS_PER_DAY = {
  portfolio: { week: 28, month: 12, quarter: 5, year: 2 },
  tasks: { day: 64, week: 28, month: 12 },
  workNotes: { day: 48, week: 24, month: 10, quarter: 4, year: 2 },
} as const;

interface TimelineViewportForScope<S extends TimelineScope> {
  readonly scope: S;
  readonly scale: TimelineScale<S>;
  readonly focalDate: string;
  readonly viewportWidth: number;
  readonly pixelsPerDay: number;
}

export type TimelineViewport<S extends TimelineScope = TimelineScope> = S extends TimelineScope
  ? TimelineViewportForScope<S>
  : never;

type TimelineViewportInput<S extends TimelineScope = TimelineScope> = S extends TimelineScope
  ? {
      readonly scope: S;
      readonly scale: TimelineScale<S>;
      readonly focalDate: string;
      readonly viewportWidth: number;
    }
  : never;

export type TimelineGeometryInput =
  | { readonly kind: 'range'; readonly start: string; readonly end: string }
  | { readonly kind: 'point' | 'milestone'; readonly at: string };

export type TimelineGeometry =
  | {
      readonly kind: 'range';
      readonly left: number;
      readonly width: number;
      readonly unclippedLeft: number;
      readonly unclippedWidth: number;
      readonly visible: boolean;
      readonly clippedStart: boolean;
      readonly clippedEnd: boolean;
    }
  | {
      readonly kind: 'point';
      readonly centerX: number;
      readonly size: number;
      readonly visible: boolean;
      readonly clipped: boolean;
    }
  | {
      readonly kind: 'milestone';
      readonly shape: 'diamond';
      readonly centerX: number;
      readonly size: number;
      readonly visible: boolean;
      readonly clipped: boolean;
    };

function civilDate(value: string): string {
  const parsed = parseProjectDate(value);
  if (!parsed || parsed.precision !== 'date') throw new RangeError(`Invalid civil date: ${value}`);
  return parsed.raw;
}

function timelineEndpoint(value: string): NonNullable<ReturnType<typeof parseProjectDate>> {
  const parsed = parseProjectDate(value);
  if (!parsed) throw new RangeError(`Invalid timeline endpoint: ${value}`);
  return parsed;
}

function civilDayOrdinal(date: string): number {
  return parseProjectDate(civilDate(date))!.instantMs / MILLIS_PER_CIVIL_DAY;
}

function civilDayDistance(from: string, to: string): number {
  return civilDayOrdinal(to) - civilDayOrdinal(from);
}

const FIRST_SUPPORTED_CIVIL_DAY = civilDayOrdinal(FIRST_SUPPORTED_CIVIL_DATE);
const LAST_SUPPORTED_CIVIL_DAY = civilDayOrdinal(LAST_SUPPORTED_CIVIL_DATE);

function clampCivilDayOffset(date: string, delta: number): number {
  const origin = civilDayOrdinal(date);
  return Math.max(
    FIRST_SUPPORTED_CIVIL_DAY - origin,
    Math.min(LAST_SUPPORTED_CIVIL_DAY - origin, delta),
  );
}

function timelinePixelsPerDay<S extends TimelineScope>(scope: S, scale: TimelineScale<S>): number {
  const scales = PIXELS_PER_DAY[scope] as Readonly<Record<string, number>>;
  const pixels = scales[scale];
  if (pixels === undefined) throw new RangeError(`Scale ${String(scale)} is invalid for ${scope}`);
  return pixels;
}

function requireViewportWidth(value: number): number {
  if (!Number.isFinite(value) || value <= 0)
    throw new RangeError('Viewport width must be positive');
  return value;
}

function shiftedCivilDate(date: string, delta: number): string {
  const shifted = addCivilDays(date, delta);
  if (shifted === undefined)
    throw new RangeError('Civil date shift is outside the supported range');
  return shifted;
}

export function createTimelineViewport<S extends TimelineScope>(
  input: TimelineViewportInput<S>,
): TimelineViewport<S> {
  if (!isTimelineScale(input.scope, input.scale)) {
    throw new RangeError(`Scale ${String(input.scale)} is invalid for ${input.scope}`);
  }
  return {
    scope: input.scope,
    scale: input.scale,
    focalDate: civilDate(input.focalDate),
    viewportWidth: requireViewportWidth(input.viewportWidth),
    pixelsPerDay: timelinePixelsPerDay(input.scope, input.scale),
  } as TimelineViewport<S>;
}

export function civilDateToX(viewport: TimelineViewport, date: string): number {
  return (
    viewport.viewportWidth / 2 + civilDayDistance(viewport.focalDate, date) * viewport.pixelsPerDay
  );
}

export function timelineDateAtX(viewport: TimelineViewport, x: number): string {
  if (!Number.isFinite(x)) throw new RangeError('Timeline coordinate must be finite');
  const dayOffset = Math.floor((x - viewport.viewportWidth / 2) / viewport.pixelsPerDay);
  return shiftedCivilDate(viewport.focalDate, clampCivilDayOffset(viewport.focalDate, dayOffset));
}

export function timelineVisibleWindow(viewport: TimelineViewport): {
  readonly start: string;
  readonly end: string;
  readonly dates: readonly string[];
} {
  const centerX = viewport.viewportWidth / 2;
  const startOffset = clampCivilDayOffset(
    viewport.focalDate,
    Math.floor(-centerX / viewport.pixelsPerDay),
  );
  const endOffset = clampCivilDayOffset(
    viewport.focalDate,
    Math.ceil((viewport.viewportWidth - centerX) / viewport.pixelsPerDay) - 1,
  );
  const start = shiftedCivilDate(viewport.focalDate, startOffset);
  const end = shiftedCivilDate(viewport.focalDate, endOffset);
  const dates = Array.from({ length: endOffset - startOffset + 1 }, (_, index) =>
    shiftedCivilDate(start, index),
  );
  return { start, end, dates };
}

export function reframeTimelineViewport<S extends TimelineScope>(
  viewport: TimelineViewport<S>,
  changes: { readonly scale?: TimelineScale<NoInfer<S>>; readonly viewportWidth?: number },
): TimelineViewport<S> {
  const scale = changes.scale ?? viewport.scale;
  const viewportWidth = requireViewportWidth(changes.viewportWidth ?? viewport.viewportWidth);
  return {
    scope: viewport.scope,
    scale,
    focalDate: viewport.focalDate,
    viewportWidth,
    pixelsPerDay: timelinePixelsPerDay(viewport.scope, scale),
  } as TimelineViewport<S>;
}

export function todayCenteredTimelineViewport<S extends TimelineScope>(
  viewport: TimelineViewport<S>,
  today: string,
): TimelineViewport<S> {
  return {
    scope: viewport.scope,
    scale: viewport.scale,
    focalDate: civilDate(today),
    viewportWidth: viewport.viewportWidth,
    pixelsPerDay: viewport.pixelsPerDay,
  } as TimelineViewport<S>;
}

export function geometryForTimelineItem(
  viewport: TimelineViewport,
  item: TimelineGeometryInput,
): TimelineGeometry {
  if (item.kind === 'range') {
    const startEndpoint = timelineEndpoint(item.start);
    const endEndpoint = timelineEndpoint(item.end);
    if (startEndpoint.instantMs > endEndpoint.instantMs) {
      throw new RangeError('Timeline range is reversed');
    }
    const start = startEndpoint.raw.slice(0, 10);
    const end = endEndpoint.raw.slice(0, 10);
    const civilOrder = civilDayDistance(start, end);
    const firstCivilDate = civilOrder >= 0 ? start : end;
    const lastCivilDate = civilOrder >= 0 ? end : start;
    const startX = civilDateToX(viewport, firstCivilDate);
    const endX = civilDateToX(viewport, lastCivilDate) + viewport.pixelsPerDay;
    const sameDay = firstCivilDate === lastCivilDate;
    const naturalWidth = endX - startX;
    const unclippedWidth = sameDay
      ? Math.max(naturalWidth, TIMELINE_SAME_DAY_RANGE_MIN_WIDTH)
      : naturalWidth;
    const unclippedLeft = sameDay ? startX + (naturalWidth - unclippedWidth) / 2 : startX;
    const unclippedRight = unclippedLeft + unclippedWidth;
    const left = Math.max(0, Math.min(viewport.viewportWidth, unclippedLeft));
    const right = Math.max(0, Math.min(viewport.viewportWidth, unclippedRight));
    const width = Math.max(0, right - left);
    return {
      kind: 'range',
      left,
      width,
      unclippedLeft,
      unclippedWidth,
      visible: width > 0,
      clippedStart: unclippedLeft < 0,
      clippedEnd: unclippedRight > viewport.viewportWidth,
    };
  }

  const date = timelineEndpoint(item.at).raw.slice(0, 10);
  const centerX = civilDateToX(viewport, date) + viewport.pixelsPerDay / 2;
  const size = item.kind === 'milestone' ? TIMELINE_MILESTONE_SIZE : TIMELINE_POINT_SIZE;
  const left = centerX - size / 2;
  const right = centerX + size / 2;
  const common = {
    centerX,
    size,
    visible: right > 0 && left < viewport.viewportWidth,
    clipped: left < 0 || right > viewport.viewportWidth,
  };
  return item.kind === 'milestone'
    ? { kind: 'milestone', shape: 'diamond', ...common }
    : { kind: 'point', ...common };
}
