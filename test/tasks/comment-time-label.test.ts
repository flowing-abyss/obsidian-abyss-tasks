import { describe, expect, it } from 'vitest';
import { formatCommentTimeLabel } from '../../src/tasks/domain/commentTimeLabel';
import { atomDateTime, type CommentTimestamp } from '../../src/tasks/domain/commentTimestamp';
import { localDate } from '../../src/tasks/domain/validation';

const NOW = Date.parse('2026-08-11T16:00:00Z');

function day(value: string): CommentTimestamp {
  return { precision: 'day', value: localDate(value), raw: value };
}

function instant(epochMs: number, raw = new Date(epochMs).toISOString()): CommentTimestamp {
  return { precision: 'instant', atom: atomDateTime(raw), epochMs, raw };
}

function label(timestamp: CommentTimestamp, nowEpochMs = NOW): string {
  return formatCommentTimeLabel({
    timestamp,
    nowEpochMs,
    today: localDate('2026-08-11'),
    locale: 'en-US',
    timeZone: 'Asia/Novosibirsk',
  });
}

describe('comment time labels', () => {
  it.each([
    ['2026-08-11', 'Today'],
    ['2026-08-10', 'Yesterday'],
    ['2026-08-09', '2 days ago'],
    ['2026-08-05', '6 days ago'],
    ['2026-08-12', 'Tomorrow'],
    ['2026-08-13', 'In 2 days'],
    ['2026-08-17', 'In 6 days'],
  ])('renders day-only %s by calendar-day precision', (value, expected) => {
    expect(label(day(value))).toBe(expected);
  });

  it('renders older day-only values as a localized civil date', () => {
    expect(label(day('2026-08-04'))).toBe('Aug 4, 2026');
  });

  it.each([
    [59_000, 'Just now'],
    [60_000, '1 minute ago'],
    [59 * 60_000 + 59_000, '59 minutes ago'],
    [60 * 60_000, '1 hour ago'],
    [80 * 60_000, '1 hour 20 minutes ago'],
    [23 * 60 * 60_000 + 59 * 60_000, '23 hours 59 minutes ago'],
    [24 * 60 * 60_000, '1 day ago'],
    [6 * 24 * 60 * 60_000 + 23 * 60 * 60_000, '6 days 23 hours ago'],
  ] as const)('renders elapsed past delta %d precisely', (delta, expected) => {
    expect(label(instant(NOW - delta))).toBe(expected);
  });

  it.each([
    [59_000, 'Just now'],
    [60_000, 'in 1 minute'],
    [80 * 60_000, 'in 1 hour 20 minutes'],
    [24 * 60 * 60_000, 'in 1 day'],
  ] as const)('renders elapsed future delta %d with symmetric skew handling', (delta, expected) => {
    expect(label(instant(NOW + delta))).toBe(expected);
  });

  it('uses elapsed time across DST rather than civil clock distance', () => {
    const afterSpringForward = Date.parse('2026-03-29T01:30:00Z');
    const beforeSpringForward = Date.parse('2026-03-29T00:30:00Z');
    expect(label(instant(beforeSpringForward), afterSpringForward)).toBe('1 hour ago');
  });

  it('renders instants older than seven elapsed days in the requested current zone', () => {
    const timestamp = instant(Date.parse('2026-08-01T20:30:00Z'));
    expect(label(timestamp)).toBe('Aug 2, 2026, 3:30 AM');
  });
});
