import { projectCalendarDayOrdinal } from '../../src/projects/projectDateValue';
import type { ProjectTimelineWindow } from '../../src/projects/projectTimelineModel';
import type { ProjectTimelineScale } from '../../src/projects/projectTimelineSettings';

/** Explicit date fixtures for geometry tests, independent of viewport navigation. */
export function timelineWindow(
  startDay: string,
  endDay: string,
  scale: ProjectTimelineScale = 'day',
): ProjectTimelineWindow {
  return {
    startDay,
    endDay,
    dayCount:
      (projectCalendarDayOrdinal(endDay) as number) -
      (projectCalendarDayOrdinal(startDay) as number) +
      1,
    scale,
  };
}
