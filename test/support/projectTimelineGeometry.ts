import { projectCalendarDayOrdinal } from '../../src/projects/projectDateValue';
import { expectDefined } from '../helpers';

/** Recover the physical window from a rendered interval, without using accessible copy. */
export function projectTimelineBounds(host: ParentNode): { first: number; days: number } {
  const cell = expectDefined(host.querySelector<HTMLElement>('.abyss-project-timeline-axis-cell'));
  const start = projectCalendarDayOrdinal(expectDefined(cell.dataset['startDay'])) as number;
  const end = projectCalendarDayOrdinal(expectDefined(cell.dataset['endDay'])) as number;
  const days = Math.round(((end - start + 1) * 100) / parseFloat(cell.style.width));
  return { first: start - Math.round((parseFloat(cell.style.left) / 100) * days), days };
}

/** Read the displayed calendar center independently of its movable physical origin. */
export function projectTimelineLogicalCenter(scroll: HTMLElement): number {
  const { first, days } = projectTimelineBounds(scroll);
  const track = expectDefined(
    scroll.querySelector<HTMLElement>('.abyss-project-timeline-axis-dates'),
  );
  const summary = expectDefined(
    scroll.querySelector<HTMLElement>('.abyss-project-timeline-axis-summary'),
  );
  const usable = scroll.clientWidth - summary.getBoundingClientRect().width;
  const trackWidth =
    track.dataset['trackWidth'] === undefined
      ? parseFloat(scroll.style.getPropertyValue('--abyss-project-timeline-track-width'))
      : Number(track.dataset['trackWidth']);
  return first + (scroll.scrollLeft + usable / 2) / (trackWidth / days);
}
