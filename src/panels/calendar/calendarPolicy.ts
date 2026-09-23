import type { CalViewType } from './calendarViewType';

/** A phone screen fits one day. The month grid is unreadable there, so Day is the useful start. */
export function initialCalendarView(platform: { readonly isPhone: boolean }): CalViewType {
  return platform.isPhone ? 'today' : 'month';
}
