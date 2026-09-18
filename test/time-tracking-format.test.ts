import { describe, expect, it } from 'vitest';
import type { OffsetAt, TimeEntrySnapshot } from '../src/tasks';
import {
  formatDayHeading,
  formatSessionRange,
  formatTrackedClock,
  formatTrackedDuration,
  formatTrackedTicker,
  staleTrackingQuestion,
} from '../src/ui/timeTracking/formatTracked';

const MINUTE = 60_000;
const HOUR = 3_600_000;

/** A fixed eastern offset, so every expectation is a plain arithmetic consequence of it. */
const plus3: OffsetAt = () => 180;
const utc: OffsetAt = () => 0;

const at = (iso: string): number => Date.parse(iso);

/**
 * `en-GB` is the one English locale whose short calendar label carries no comma, so the day
 * headings read as the sentence fragments the surfaces embed. The September abbreviation is
 * ICU's own (`Sept`), which is why the December cases pin the plain `Wed 16 Dec` shape.
 */
const context = (nowIso: string, offsetAt: OffsetAt = plus3, locale = 'en-GB') => ({
  nowMs: at(nowIso),
  offsetAt,
  locale,
});

const closed = (start: string, end: string): TimeEntrySnapshot => ({
  relativeLine: 1,
  originalMarkdown: `- ${start} → ${end}`,
  state: 'closed',
  startMs: at(start),
  endMs: at(end),
});

const running = (start: string): TimeEntrySnapshot => ({
  relativeLine: 1,
  originalMarkdown: `- ${start} →`,
  state: 'running',
  startMs: at(start),
});

const broken: TimeEntrySnapshot = {
  relativeLine: 2,
  originalMarkdown: '- not a stamp →',
  state: 'broken',
  issue: 'invalid-start',
};

describe('formatTrackedDuration', () => {
  it.each([
    [0, '0m'],
    [59_999, '0m'],
    [MINUTE, '1m'],
    [15 * MINUTE, '15m'],
    [80 * MINUTE, '1h 20m'],
    [HOUR, '1h'],
    [120 * MINUTE, '2h'],
    [HOUR + 59_999, '1h'],
    [25 * HOUR + MINUTE, '25h 1m'],
  ])('formats %i ms as %s', (ms, expected) => {
    expect(formatTrackedDuration(ms)).toBe(expected);
  });

  it('never reports negative time', () => {
    expect(formatTrackedDuration(-5 * MINUTE)).toBe('0m');
  });
});

describe('formatTrackedClock', () => {
  it.each([
    [0, '0:00'],
    [59_999, '0:00'],
    [107 * MINUTE, '1:47'],
    [725 * MINUTE, '12:05'],
    [HOUR, '1:00'],
  ])('formats %i ms as %s', (ms, expected) => {
    expect(formatTrackedClock(ms)).toBe(expected);
  });
});

describe('formatTrackedTicker', () => {
  it.each([
    [0, '0:00:00'],
    [727_000, '0:12:07'],
    [999, '0:00:00'],
    [HOUR + MINUTE + 1000, '1:01:01'],
    [25 * HOUR, '25:00:00'],
  ])('formats %i ms as %s', (ms, expected) => {
    expect(formatTrackedTicker(ms)).toBe(expected);
  });
});

describe('formatDayHeading', () => {
  const now = '2026-09-20T16:00:00+03:00';

  it('names the day that holds the clock', () => {
    expect(formatDayHeading(at('2026-09-20T00:00:00+03:00'), context(now))).toBe('Today');
  });

  it('names the day before it', () => {
    expect(formatDayHeading(at('2026-09-19T00:00:00+03:00'), context(now))).toBe('Yesterday');
  });

  it('falls back to the weekday and calendar date', () => {
    expect(formatDayHeading(at('2026-09-16T00:00:00+03:00'), context(now))).toBe('Wed 16 Sept');
    expect(
      formatDayHeading(at('2026-12-16T00:00:00+03:00'), context('2026-12-20T16:00:00+03:00')),
    ).toBe('Wed 16 Dec');
  });

  it('reads the day through the supplied offset rather than the ambient zone', () => {
    expect(formatDayHeading(at('2026-09-20T00:00:00Z'), context(now, utc))).toBe('Today');
    expect(formatDayHeading(at('2026-09-19T00:00:00Z'), context(now, utc))).toBe('Yesterday');
  });
});

describe('formatSessionRange', () => {
  const now = '2026-09-20T16:00:00+03:00';

  it('shows a closed session inside today as two wall times', () => {
    const entry = closed('2026-09-20T09:12:00+03:00', '2026-09-20T10:32:00+03:00');
    expect(formatSessionRange(entry, context(now))).toBe('Today 09:12 → 10:32');
  });

  it('shows a closed session from the day before', () => {
    const entry = closed('2026-09-19T18:40:00+03:00', '2026-09-19T18:55:00+03:00');
    expect(formatSessionRange(entry, context(now))).toBe('Yesterday 18:40 → 18:55');
  });

  it('shows an older session with its calendar day', () => {
    const entry = closed('2026-09-16T09:12:00+03:00', '2026-09-16T10:32:00+03:00');
    expect(formatSessionRange(entry, context(now))).toBe('Wed 16 Sept 09:12 → 10:32');
  });

  it('leaves a running session open', () => {
    expect(formatSessionRange(running('2026-09-20T14:05:00+03:00'), context(now))).toBe(
      'Today 14:05 →',
    );
  });

  it('repeats the day when a session crosses midnight', () => {
    const entry = closed('2026-09-19T23:30:00+03:00', '2026-09-20T00:15:00+03:00');
    expect(formatSessionRange(entry, context(now))).toBe('Yesterday 23:30 → Today 00:15');
  });

  it('renders the wall times through the supplied offset', () => {
    const entry = closed('2026-09-20T09:12:00+03:00', '2026-09-20T10:32:00+03:00');
    expect(formatSessionRange(entry, context(now, utc))).toBe('Today 06:12 → 07:32');
  });

  it('has no range to show for a broken entry', () => {
    expect(formatSessionRange(broken, context(now))).toBe('');
  });
});

describe('staleTrackingQuestion', () => {
  it('stays quiet under twelve hours', () => {
    const now = '2026-09-20T16:00:00+03:00';
    expect(staleTrackingQuestion(at(now) - (12 * HOUR - MINUTE), context(now))).toBeUndefined();
  });

  it('asks from exactly twelve hours', () => {
    const now = '2026-09-20T16:00:00+03:00';
    expect(staleTrackingQuestion(at(now) - 12 * HOUR, context(now))).toBe(
      'Still tracking since 04:00?',
    );
  });

  it('names the day before by word', () => {
    expect(
      staleTrackingQuestion(at('2026-09-19T14:05:00+03:00'), context('2026-09-20T02:05:00+03:00')),
    ).toBe('Still tracking since yesterday at 14:05?');
  });

  it('names an older day by its calendar date', () => {
    expect(
      staleTrackingQuestion(at('2026-09-16T14:05:00+03:00'), context('2026-09-20T10:00:00+03:00')),
    ).toBe('Still tracking since 16 Sept at 14:05?');
    expect(
      staleTrackingQuestion(at('2026-12-16T14:05:00+03:00'), context('2026-12-20T10:00:00+03:00')),
    ).toBe('Still tracking since 16 Dec at 14:05?');
  });
});
