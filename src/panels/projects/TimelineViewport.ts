import { addCivilDays, parseProjectDate } from '../../projects/projectDates';
import { isTimelineScale, type TimelineScale, type TimelineScope } from './timelinePreferences';

const MILLIS_PER_CIVIL_DAY = 86_400_000;
export const TIMELINE_SAME_DAY_RANGE_MIN_WIDTH = 6;
export const TIMELINE_POINT_SIZE = 8;
export const TIMELINE_MILESTONE_SIZE = 10;

const PIXELS_PER_DAY = {
  portfolio: { week: 28, month: 12, quarter: 5, year: 2 },
  tasks: { day: 64, week: 28, month: 12 },
  workNotes: { day: 48, week: 24, month: 10, quarter: 4, year: 2 },
} as const;

export interface TimelineViewport<S extends TimelineScope = TimelineScope> {
  readonly scope: S;
  readonly scale: TimelineScale<S>;
  readonly focalDate: string;
  readonly viewportWidth: number;
  readonly pixelsPerDay: number;
}

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

function civilDateFromMetadata(value: string): string {
  const parsed = parseProjectDate(value);
  if (!parsed) throw new RangeError(`Invalid timeline endpoint: ${value}`);
  return parsed.raw.slice(0, 10);
}

function civilDayOrdinal(date: string): number {
  return parseProjectDate(civilDate(date))!.instantMs / MILLIS_PER_CIVIL_DAY;
}

function civilDayDistance(from: string, to: string): number {
  return civilDayOrdinal(to) - civilDayOrdinal(from);
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

export function createTimelineViewport<S extends TimelineScope>(input: {
  readonly scope: S;
  readonly scale: TimelineScale<S>;
  readonly focalDate: string;
  readonly viewportWidth: number;
}): TimelineViewport<S> {
  if (!isTimelineScale(input.scope, input.scale)) {
    throw new RangeError(`Scale ${String(input.scale)} is invalid for ${input.scope}`);
  }
  return {
    scope: input.scope,
    scale: input.scale,
    focalDate: civilDate(input.focalDate),
    viewportWidth: requireViewportWidth(input.viewportWidth),
    pixelsPerDay: timelinePixelsPerDay(input.scope, input.scale),
  };
}

export function civilDateToX(viewport: TimelineViewport, date: string): number {
  return (
    viewport.viewportWidth / 2 + civilDayDistance(viewport.focalDate, date) * viewport.pixelsPerDay
  );
}

export function timelineDateAtX(viewport: TimelineViewport, x: number): string {
  if (!Number.isFinite(x)) throw new RangeError('Timeline coordinate must be finite');
  const dayOffset = Math.floor((x - viewport.viewportWidth / 2) / viewport.pixelsPerDay);
  return shiftedCivilDate(viewport.focalDate, dayOffset);
}

export function timelineVisibleWindow(viewport: TimelineViewport): {
  readonly start: string;
  readonly end: string;
  readonly dates: readonly string[];
} {
  const centerX = viewport.viewportWidth / 2;
  const startOffset = Math.floor(-centerX / viewport.pixelsPerDay);
  const endOffset = Math.ceil((viewport.viewportWidth - centerX) / viewport.pixelsPerDay) - 1;
  const start = shiftedCivilDate(viewport.focalDate, startOffset);
  const end = shiftedCivilDate(viewport.focalDate, endOffset);
  const dates = Array.from({ length: endOffset - startOffset + 1 }, (_, index) =>
    shiftedCivilDate(start, index),
  );
  return { start, end, dates };
}

export function reframeTimelineViewport<S extends TimelineScope>(
  viewport: TimelineViewport<S>,
  changes: { readonly scale?: TimelineScale<S>; readonly viewportWidth?: number },
): TimelineViewport<S> {
  return createTimelineViewport({
    scope: viewport.scope,
    scale: changes.scale ?? viewport.scale,
    focalDate: viewport.focalDate,
    viewportWidth: changes.viewportWidth ?? viewport.viewportWidth,
  });
}

export function todayCenteredTimelineViewport<S extends TimelineScope>(
  viewport: TimelineViewport<S>,
  today: string,
): TimelineViewport<S> {
  return createTimelineViewport({
    scope: viewport.scope,
    scale: viewport.scale,
    focalDate: today,
    viewportWidth: viewport.viewportWidth,
  });
}

export function geometryForTimelineItem(
  viewport: TimelineViewport,
  item: TimelineGeometryInput,
): TimelineGeometry {
  if (item.kind === 'range') {
    const start = civilDateFromMetadata(item.start);
    const end = civilDateFromMetadata(item.end);
    if (civilDayDistance(start, end) < 0) throw new RangeError('Timeline range is reversed');
    const startX = civilDateToX(viewport, start);
    const endX = civilDateToX(viewport, shiftedCivilDate(end, 1));
    const sameDay = start === end;
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

  const date = civilDateFromMetadata(item.at);
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
