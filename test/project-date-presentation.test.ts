import { describe, expect, it } from 'vitest';
import { formatProjectRelativeDate } from '../src/panels/projects/projectDatePresentation';

describe('formatProjectRelativeDate', () => {
  const now = new Date(2026, 8, 10, 23, 0, 0);

  it.each([
    ['2026-09-10', 'today'],
    ['2026-09-11', 'tomorrow'],
    ['2026-09-09', 'yesterday'],
    ['2026-09-20', 'in 10 days'],
  ])('uses local calendar days for %s', (value, expected) => {
    expect(formatProjectRelativeDate(value, now, 'en')).toBe(expected);
  });

  it.each([
    ['2026-09-10T23:15:00', 'in 15 minutes'],
    ['2026-09-10T22:45:00', '15 minutes ago'],
    ['2026-09-10T23:00:29', 'now'],
    ['2026-09-10T22:59:30', '1 minute ago'],
  ])('uses elapsed time for %s', (value, expected) => {
    expect(formatProjectRelativeDate(value, now, 'en')).toBe(expected);
  });

  it('preserves an explicit datetime offset', () => {
    expect(
      formatProjectRelativeDate(
        '2026-09-11T02:00:00+01:00',
        new Date('2026-09-10T23:00:00Z'),
        'en',
      ),
    ).toBe('in 2 hours');
  });

  it.each([
    undefined,
    null,
    '',
    ' ',
    'invalid-date',
    '09/10/2026',
    '2026-02-30',
    '2026-02-30T12:00:00',
    '2026-09-10T24:00:00',
  ])('returns undefined for non-date value %j', (value) => {
    expect(formatProjectRelativeDate(value, now, 'en')).toBeUndefined();
  });

  it('keeps date-only values stable across a daylight-saving boundary', () => {
    expect(formatProjectRelativeDate('2026-03-09', new Date(2026, 2, 8, 23, 30), 'en')).toBe(
      'tomorrow',
    );
  });
});
