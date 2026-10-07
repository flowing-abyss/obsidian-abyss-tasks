import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/settings/defaults';
import { localDate, localTime } from '../../src/tasks';
import {
  taskHasFutureDate,
  taskOccupiedDates,
  taskOccurrenceCompletion,
  taskTodayOccurrence,
} from '../../src/tasks/domain/taskOccupiedDates';
import { expectDefined } from '../helpers';
import { createCanonicalSearchHarness } from '../support/taskSearchHarness';

describe('occupied task dates', () => {
  it('owns today once, expires once, and ignores scheduled dates outside valid ranges', () => {
    const planning = {
      start: localDate('2026-10-07'),
      due: localDate('2026-10-09'),
      scheduled: localDate('2026-11-01'),
    };
    expect(taskOccupiedDates(planning)).toEqual({
      kind: 'interval',
      start: '2026-10-07',
      due: '2026-10-09',
    });
    expect(taskTodayOccurrence(planning, localDate('2026-10-08'))).toEqual({
      category: 'today',
      displayDate: '2026-10-08',
      completion: { kind: 'continuation', due: '2026-10-09' },
    });
    expect(taskTodayOccurrence(planning, localDate('2026-10-10'))).toEqual({
      category: 'overdue',
      displayDate: '2026-10-09',
      completion: { kind: 'allowed' },
    });
    expect(taskHasFutureDate(planning, localDate('2026-10-09'))).toBe(false);
    expect(taskTodayOccurrence(planning, localDate('2026-10-06'))).toBeUndefined();
    expect(taskOccurrenceCompletion(planning)).toEqual({ kind: 'allowed' });
    expect(taskOccurrenceCompletion(planning, localDate('2026-10-09'))).toEqual({
      kind: 'allowed',
    });
  });
  it('keeps inverted distinct roles without repairing dates', () => {
    const planning = {
      start: localDate('2026-10-09'),
      due: localDate('2026-10-07'),
      scheduled: localDate('2026-10-09'),
    };
    expect(taskOccupiedDates(planning)).toEqual({
      kind: 'points',
      points: [
        { date: '2026-10-07', roles: ['due'] },
        { date: '2026-10-09', roles: ['start', 'scheduled'] },
      ],
    });
    expect(taskTodayOccurrence(planning, localDate('2026-10-09'))).toEqual({
      category: 'overdue',
      displayDate: '2026-10-07',
      completion: { kind: 'allowed' },
    });
    expect(taskHasFutureDate(planning, localDate('2026-10-08'))).toBe(true);
    expect(taskOccurrenceCompletion(planning, localDate('2026-10-07'))).toEqual({
      kind: 'allowed',
    });
  });
  it.each(['0000-01-01', '2028-02-29', '2026-03-08', '2026-11-01', '9999-12-31'])(
    'uses civil boundaries at %s',
    (value) => {
      const date = localDate(value);
      expect(taskTodayOccurrence({ start: date, due: date }, date)).toEqual({
        category: 'today',
        displayDate: date,
        completion: { kind: 'allowed' },
      });
      expect(taskTodayOccurrence({ start: date }, date)?.category).toBe('today');
      expect(taskHasFutureDate({ start: date }, date)).toBe(false);
    },
  );
  it('does not increment past the date domain or invent overdue start/scheduled dates', () => {
    expect(taskHasFutureDate({ start: localDate('9999-12-31') }, localDate('9999-12-30'))).toBe(
      true,
    );
    expect(
      taskTodayOccurrence(
        { start: localDate('2026-10-07'), scheduled: localDate('2026-10-07') },
        localDate('2026-10-08'),
      ),
    ).toBeUndefined();
    expect(taskOccupiedDates({ time: localTime('12:00') })).toEqual({ kind: 'points', points: [] });
  });
  it('uses parsed valid siblings without fabricating a malformed authored date', async () => {
    const h = await createCanonicalSearchHarness(
      {
        'dates.md': '- [ ] Legacy 🛫 2026-02-30 ⏳ 2026-10-08',
      },
      DEFAULT_SETTINGS,
    );
    try {
      expect(taskOccupiedDates(expectDefined(h.index.list()[0]).planning)).toEqual({
        kind: 'points',
        points: [{ date: '2026-10-08', roles: ['scheduled'] }],
      });
    } finally {
      h.close();
    }
  });
});
