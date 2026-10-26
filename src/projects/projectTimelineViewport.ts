import {
  MAX_PROJECT_CALENDAR_YEAR,
  MIN_PROJECT_CALENDAR_YEAR,
  projectCalendarDayFromOrdinal,
  projectCalendarDayOrdinal,
} from './projectDateValue';
import { PROJECT_TIMELINE_MAX_TRACK_WIDTH, projectTimelineDayWidth } from './projectTimelineAxis';
import type { ProjectTimelineWindow } from './projectTimelineModel';
import type { ProjectTimelineScale } from './projectTimelineSettings';

export { projectTimelineDayWidth } from './projectTimelineAxis';

export interface TimelineViewport {
  readonly window: ProjectTimelineWindow;
  readonly dayWidth: number;
  readonly trackWidth: number;
}

export interface TimelineViewportPosition {
  readonly viewport: TimelineViewport;
  readonly left: number;
}

const MINIMUM_TRACK_WIDTH = 32768;
const BUFFER_SCREENS = 9;
const EDGE_SCREENS = 2;
const FIRST_DAY = projectCalendarDayOrdinal(
  `${String(MIN_PROJECT_CALENDAR_YEAR).padStart(4, '0')}-01-01`,
) as number;
const LAST_DAY = projectCalendarDayOrdinal(`${String(MAX_PROJECT_CALENDAR_YEAR)}-12-31`) as number;

function usablePixels(width: number): number {
  return Number.isFinite(width)
    ? Math.max(1, Math.min(PROJECT_TIMELINE_MAX_TRACK_WIDTH / BUFFER_SCREENS, width))
    : 1;
}

function nativeLeft(viewport: TimelineViewport, left: number, usableWidth: number): number {
  return Math.max(
    0,
    Math.min(Math.max(0, viewport.trackWidth - usableWidth), Number.isFinite(left) ? left : 0),
  );
}

function windowAt(
  center: number,
  scale: ProjectTimelineScale,
  dayCount: number,
): ProjectTimelineWindow {
  const start = Math.max(
    FIRST_DAY,
    Math.min(LAST_DAY - dayCount + 1, Math.floor(center - dayCount / 2)),
  );
  return {
    startDay: projectCalendarDayFromOrdinal(start) as string,
    endDay: projectCalendarDayFromOrdinal(start + dayCount - 1) as string,
    dayCount,
    scale,
  };
}

/** Uses a bounded physical track while preserving the scale's exact calendar density. */
export function timelineViewportAt(
  centerOrdinal: number,
  scale: ProjectTimelineScale,
  usableWidth: number,
): TimelineViewportPosition {
  const usable = usablePixels(usableWidth);
  const dayWidth = projectTimelineDayWidth(scale);
  const dayCount = Math.min(
    LAST_DAY - FIRST_DAY + 1,
    Math.floor(PROJECT_TIMELINE_MAX_TRACK_WIDTH / dayWidth),
    Math.ceil(Math.max(MINIMUM_TRACK_WIDTH, BUFFER_SCREENS * usable) / dayWidth),
  );
  const center = Number.isFinite(centerOrdinal)
    ? Math.max(FIRST_DAY, Math.min(LAST_DAY + 1, centerOrdinal))
    : FIRST_DAY;
  const window = windowAt(center, scale, dayCount);
  const viewport = { window, dayWidth, trackWidth: dayCount * dayWidth };
  const left =
    (center - (projectCalendarDayOrdinal(window.startDay) as number)) * dayWidth - usable / 2;
  return { viewport, left: nativeLeft(viewport, left, usable) };
}

export function timelineViewportCenter(
  viewport: TimelineViewport,
  left: number,
  usableWidth: number,
): number {
  const usable = usablePixels(usableWidth);
  return (
    (projectCalendarDayOrdinal(viewport.window.startDay) as number) +
    (nativeLeft(viewport, left, usable) + usable / 2) / viewport.dayWidth
  );
}

/** Repositions the physical buffer without moving any date on screen. */
export function rebaseTimelineViewport(
  viewport: TimelineViewport,
  left: number,
  usableWidth: number,
): TimelineViewportPosition {
  const usable = usablePixels(usableWidth);
  const offset = nativeLeft(viewport, left, usable);
  const maximum = Math.max(0, viewport.trackWidth - usable);
  if (offset > EDGE_SCREENS * usable && maximum - offset > EDGE_SCREENS * usable) {
    return { viewport, left: offset };
  }
  const center = timelineViewportCenter(viewport, offset, usable);
  const window = windowAt(center, viewport.window.scale, viewport.window.dayCount);
  if (window.startDay === viewport.window.startDay) return { viewport, left: offset };
  const dayShift =
    (projectCalendarDayOrdinal(viewport.window.startDay) as number) -
    (projectCalendarDayOrdinal(window.startDay) as number);
  return {
    viewport: { ...viewport, window },
    left: nativeLeft(viewport, offset + dayShift * viewport.dayWidth, usable),
  };
}
