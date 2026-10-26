import { projectCalendarDayOrdinal } from '../../src/projects/projectDateValue';
import { expectDefined } from '../helpers';

/** Read the displayed calendar center independently of its movable physical origin. */
export function projectTimelineLogicalCenter(scroll: HTMLElement): number {
  const [start, end] = expectDefined(
    scroll.querySelector('.abyss-project-timeline-axis-range')?.textContent,
  ).split(' – ') as [string, string];
  const first = projectCalendarDayOrdinal(start) as number;
  const days = (projectCalendarDayOrdinal(end) as number) - first + 1;
  const track = expectDefined(
    scroll.querySelector<HTMLElement>('.abyss-project-timeline-axis-dates'),
  );
  const summary = expectDefined(
    scroll.querySelector<HTMLElement>('.abyss-project-timeline-axis-summary'),
  );
  const usable = scroll.clientWidth - summary.getBoundingClientRect().width;
  return first + (scroll.scrollLeft + usable / 2) / (Number(track.dataset['trackWidth']) / days);
}
