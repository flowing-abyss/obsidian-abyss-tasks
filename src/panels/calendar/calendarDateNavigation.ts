import { firstVisibleWeekDate } from '../../domain/weekGridOffset';
import { moment } from '../../obsidianMoment';
import type { CalViewType } from './calendarViewType';

/** The host Moment instance type, the only date type the calendar package passes around. */
export type CalendarMoment = ReturnType<typeof moment>;

export interface CalendarTitle {
  readonly primary: string;
  readonly year: string;
}

/** The date a view opens on when the user switches to it or presses Today. */
export function dateForView(view: CalViewType, now: CalendarMoment): CalendarMoment {
  if (view === 'week') return now.clone();
  if (view === 'today') return now.clone();
  return now.clone().date(1);
}

/** One step back or forward in the unit the view shows. Always returns a new moment. */
export function stepCalendarDate(
  view: CalViewType,
  date: CalendarMoment,
  direction: -1 | 1,
): CalendarMoment {
  const operation = direction === 1 ? 'add' : 'subtract';
  if (view === 'week') return date.clone()[operation](7, 'days');
  if (view === 'today') return date.clone()[operation](1, 'day');
  return date.clone()[operation](1, 'months').date(1);
}

/** The two toolbar labels: the primary button text and the year button text. */
export function calendarTitle(
  view: CalViewType,
  date: CalendarMoment,
  firstDayOfWeek: number,
): CalendarTitle {
  const year = date.format('YYYY');
  if (view === 'week') {
    const start = moment(firstVisibleWeekDate(date, firstDayOfWeek)).locale(date.locale());
    return { primary: `Week ${start.format('w')}`, year };
  }
  if (view === 'today') return { primary: date.format('MMMM D'), year };
  return { primary: date.format('MMMM'), year };
}

/** Identity of a (view, date) pair for the once-per-visit scroll-to-now. */
export function calendarScrollKey(view: CalViewType, date: CalendarMoment): string {
  return `${view}:${date.format('YYYY-MM-DD')}`;
}
