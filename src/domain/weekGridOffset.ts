/**
 * Given an anchor date's weekday (moment's `d` format: Sunday=0..Saturday=6) and the
 * configured first-day-of-week (same 0-6 numbering), returns the (always <= 0) day offset
 * from the anchor to the start of the "firstDayOfWeek-aligned" week that contains it.
 *
 * Every week/month grid in this codebase (WeekTimeGridView, MonthGridView, WeekView,
 * MonthView, visibleCalendarDates) needs to turn an arbitrary anchor date into a run of 7
 * (or 7*6, for months) consecutive days that both starts on `firstDayOfWeek` and genuinely
 * contains the anchor. The naive `firstDayOfWeek - weekday` (no wraparound) is only correct
 * when `weekday >= firstDayOfWeek`; when the anchor's weekday is numerically *before*
 * firstDayOfWeek (the common case: anchor is a Sunday (0) and firstDayOfWeek is Monday (1)),
 * that arithmetic yields a *positive* offset, walking forward into the following week
 * instead of back to the start of the current one — entirely excluding the anchor date from
 * the rendered range. Wrapping via `% 7` (normalized to stay non-negative) fixes this for
 * every weekday/firstDayOfWeek combination.
 */
export function weekStartOffset(weekday: number, firstDayOfWeek: number): number {
  // `|| 0` collapses the `-0` that arithmetic yields when weekday === firstDayOfWeek
  // into a plain `0` — behaviorally identical for date math, but avoids surprising
  // `Object.is`-based equality checks (e.g. `toBe(0)` in tests).
  const offset = -(((weekday - firstDayOfWeek) % 7) + 7) % 7;
  return offset === 0 ? 0 : offset;
}

/** Returns the exact local date of the configured week start containing `anchor`. */
export function firstVisibleWeekDate(
  anchor: ReturnType<typeof window.moment>,
  firstDayOfWeek: number,
): string {
  const weekday = parseInt(anchor.format('d'), 10);
  return anchor.clone().add(weekStartOffset(weekday, firstDayOfWeek), 'days').format('YYYY-MM-DD');
}

/**
 * Resolves the week view's start position. Internal producers use an exact YYYY-MM-DD first
 * visible date; the old YYYY-ww label remains readable for stored/external configurations.
 */
export function resolveWeekStartPosition(
  startPosition: string | undefined,
  firstDayOfWeek: number,
  fallback: ReturnType<typeof window.moment>,
): ReturnType<typeof window.moment> {
  if (/^\d{4}-\d{2}-\d{2}$/.test(startPosition ?? '')) {
    return window.moment(startPosition, 'YYYY-MM-DD');
  }
  if (/^\d{4}-\d{2}$/.test(startPosition ?? '')) {
    return window.moment(startPosition, 'YYYY-ww').startOf('week').add(firstDayOfWeek, 'days');
  }
  return window.moment(firstVisibleWeekDate(fallback, firstDayOfWeek), 'YYYY-MM-DD');
}
