import { firstVisibleWeekDate, weekStartOffset } from '../domain/weekGridOffset';

export type CalViewType = 'today' | 'week' | 'month';

/**
 * The exact set of dates a calendar view will render for the given
 * view type/date/first-day-of-week, mirroring TodayView/WeekTimeGridView/
 * MonthGridView's own date math. Used to scope a TaskQueryApi calendar-projection
 * query to only the visible range, instead of scanning every task in the vault.
 */
export function visibleCalendarDates(
  viewType: CalViewType,
  calDate: ReturnType<typeof window.moment>,
  firstDayOfWeek: number,
): string[] {
  if (viewType === 'today') {
    return [calDate.format('YYYY-MM-DD')];
  }

  if (viewType === 'week') {
    const week = window.moment(firstVisibleWeekDate(calDate, firstDayOfWeek), 'YYYY-MM-DD');
    const dates: string[] = [];
    for (let i = 0; i < 7; i++) {
      dates.push(week.clone().add(i, 'days').format('YYYY-MM-DD'));
    }
    return dates;
  }

  // month: 6 weeks x 7 days, matching MonthGridView's cell grid exactly (including
  // prev/next-month overflow cells, which are visible and must be included).
  const month = calDate.clone().date(1);
  const firstDayOfMonth = parseInt(month.format('d'), 10);
  const dates: string[] = [];
  let starts = weekStartOffset(firstDayOfMonth, firstDayOfWeek);
  for (let w = 0; w < 6; w++) {
    for (let i = starts; i < starts + 7; i++) {
      dates.push(month.clone().add(i, 'days').format('YYYY-MM-DD'));
    }
    starts += 7;
  }
  return dates;
}
