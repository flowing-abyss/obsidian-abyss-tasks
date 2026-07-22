import { describe, expect, it } from 'vitest';
import { visibleCalendarDates } from '../src/panels/visibleCalendarDates';
import { useRealMoment } from './helpers';

useRealMoment();

describe('visibleCalendarDates', () => {
  it('today: returns exactly the one date', () => {
    const dates = visibleCalendarDates('today', window.moment('2026-07-10'), 1);
    expect(dates).toEqual(['2026-07-10']);
  });

  it('week: returns 7 consecutive dates respecting firstDayOfWeek', () => {
    const dates = visibleCalendarDates('week', window.moment('2026-07-10'), 1);
    expect(dates).toHaveLength(7);
    expect(dates[0]).toBe('2026-07-06'); // Monday
    expect(dates[6]).toBe('2026-07-12'); // Sunday
  });

  it('week: shifts start day when firstDayOfWeek is Sunday', () => {
    const dates = visibleCalendarDates('week', window.moment('2026-07-10'), 0);
    expect(dates[0]).toBe('2026-07-05'); // Sunday
  });

  it('week: keeps a late-December anchor in its exact Monday-first week across New Year', () => {
    const calDate = window.moment('2025-12-29'); // a Monday
    const dates = visibleCalendarDates('week', calDate, 1);
    expect(dates).toEqual([
      '2025-12-29',
      '2025-12-30',
      '2025-12-31',
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
      '2026-01-04',
    ]);
  });

  it("month: returns exactly 42 dates (6 weeks x 7 days), matching MonthGridView's cell count", () => {
    const dates = visibleCalendarDates('month', window.moment('2026-07-01'), 1);
    expect(dates).toHaveLength(42);
    // July 2026 starts on a Wednesday; with firstDayOfWeek=1 (Monday), the grid
    // starts on Mon 2026-06-29 and the month itself (2026-07-01..31) is fully covered.
    expect(dates).toContain('2026-06-29');
    expect(dates).toContain('2026-07-01');
    expect(dates).toContain('2026-07-31');
  });
});
