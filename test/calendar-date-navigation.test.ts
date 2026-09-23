import { describe, expect, it } from 'vitest';
import { moment } from '../src/obsidianMoment';
import {
  calendarScrollKey,
  calendarTitle,
  dateForView,
  isoWeekStart,
  stepCalendarDate,
} from '../src/panels/calendar/calendarDateNavigation';
import { initialCalendarView } from '../src/panels/calendar/calendarPolicy';
import { useRealMoment } from './helpers';

useRealMoment();

const day = (value: string): string => value;

describe('dateForView', () => {
  const now = moment('2026-09-23T15:30:00');

  it('opens the week view on the ISO week start', () => {
    expect(dateForView('week', now).format('YYYY-MM-DD')).toBe(day('2026-09-21'));
  });

  it('opens the day view on the given instant', () => {
    expect(dateForView('today', now).format('YYYY-MM-DD HH:mm')).toBe('2026-09-23 15:30');
  });

  it('opens the month view on the first of the month', () => {
    expect(dateForView('month', now).format('YYYY-MM-DD')).toBe(day('2026-09-01'));
  });

  it('never returns the instant it was given', () => {
    for (const view of ['today', 'week', 'month'] as const) {
      expect(dateForView(view, now)).not.toBe(now);
    }
    expect(now.format('YYYY-MM-DD HH:mm')).toBe('2026-09-23 15:30');
  });
});

describe('stepCalendarDate', () => {
  it('steps the week view by seven days and snaps to the ISO week start', () => {
    const date = moment('2026-09-23');
    expect(stepCalendarDate('week', date, 1).format('YYYY-MM-DD')).toBe(day('2026-09-28'));
    expect(stepCalendarDate('week', date, -1).format('YYYY-MM-DD')).toBe(day('2026-09-14'));
  });

  it('steps the day view by one day', () => {
    const date = moment('2026-09-30');
    expect(stepCalendarDate('today', date, 1).format('YYYY-MM-DD')).toBe(day('2026-10-01'));
    expect(stepCalendarDate('today', date, -1).format('YYYY-MM-DD')).toBe(day('2026-09-29'));
  });

  it('steps the month view by one month and lands on the first', () => {
    const date = moment('2026-01-31');
    expect(stepCalendarDate('month', date, 1).format('YYYY-MM-DD')).toBe(day('2026-02-01'));
    expect(stepCalendarDate('month', date, -1).format('YYYY-MM-DD')).toBe(day('2025-12-01'));
  });

  it('leaves the given date untouched', () => {
    const date = moment('2026-09-23');
    stepCalendarDate('month', date, 1);
    expect(date.format('YYYY-MM-DD')).toBe(day('2026-09-23'));
  });
});

describe('isoWeekStart', () => {
  it('resolves the Monday of an ISO week that starts in the previous year', () => {
    const now = moment('2026-09-23');
    expect(isoWeekStart('1', '2026', now).format('YYYY-MM-DD')).toBe(day('2025-12-29'));
  });

  it('resolves week 53 of a long year', () => {
    const now = moment('2026-09-23');
    expect(isoWeekStart('53', '2020', now).format('YYYY-MM-DD')).toBe(day('2020-12-28'));
  });
});

describe('calendarTitle', () => {
  const date = moment('2026-09-23');

  it('labels the week view with the locale week number', () => {
    expect(calendarTitle('week', date)).toEqual({
      primary: `Week ${date.format('w')}`,
      year: '2026',
    });
  });

  it('labels the day view with month and day', () => {
    expect(calendarTitle('today', date)).toEqual({ primary: 'September 23', year: '2026' });
  });

  it('labels the month view with the month name', () => {
    expect(calendarTitle('month', date)).toEqual({ primary: 'September', year: '2026' });
  });
});

describe('calendarScrollKey', () => {
  it('keys on the view and the calendar date', () => {
    expect(calendarScrollKey('week', moment('2026-09-21'))).toBe('week:2026-09-21');
    expect(calendarScrollKey('today', moment('2026-09-21'))).toBe('today:2026-09-21');
  });
});

describe('initialCalendarView', () => {
  it('starts phones on the day view and everything else on the month grid', () => {
    expect(initialCalendarView({ isPhone: true })).toBe('today');
    expect(initialCalendarView({ isPhone: false })).toBe('month');
  });
});
