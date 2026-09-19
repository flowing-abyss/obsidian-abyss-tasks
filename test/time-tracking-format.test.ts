import { describe, expect, it } from 'vitest';
import {
  formatTrackedDuration as publicFormatTrackedDuration,
  type OffsetAt,
  type TimeEntrySnapshot,
} from '../src/tasks';
import {
  formatDayHeading,
  formatSessionClockRange,
  formatTrackedDuration,
  formatTrackedGain,
  staleTrackingQuestion,
} from '../src/ui/timeTracking/formatTracked';

const MINUTE = 60_000;
const HOUR = 3_600_000;

/** A fixed eastern offset, so every expectation is a plain arithmetic consequence of it. */
const plus3: OffsetAt = () => 180;
const utc: OffsetAt = () => 0;

const at = (iso: string): number => Date.parse(iso);

const context = (nowIso: string, offsetAt: OffsetAt = plus3) => ({
  nowMs: at(nowIso),
  offsetAt,
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
  it('delegates to the one task-domain formatter instead of keeping its own copy', () => {
    expect(formatTrackedDuration).toBe(publicFormatTrackedDuration);
  });

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

  it('reads an uncountable total as no time instead of rejecting it', () => {
    expect(formatTrackedDuration(Number.NaN)).toBe('0m');
    expect(formatTrackedDuration(Number.POSITIVE_INFINITY)).toBe('0m');
  });
});

describe('formatTrackedGain', () => {
  it('says a total a popover shows as what it added', () => {
    expect(formatTrackedGain(formatTrackedDuration(80 * MINUTE))).toBe('+1h 20m');
  });

  it('says a running total the same way, seconds and all', () => {
    expect(formatTrackedGain('12m 5s')).toBe('+12m 5s');
  });

  it('keeps a total of nothing as the nothing it is', () => {
    expect(formatTrackedGain('0m')).toBe('+0m');
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
    expect(formatDayHeading(at('2026-09-16T00:00:00+03:00'), context(now))).toBe('Wed 16 Sep');
  });

  it('names every month in fixed English short form', () => {
    const later = context('2027-03-01T12:00:00Z', utc);
    expect(
      Array.from({ length: 12 }, (_, month) => formatDayHeading(Date.UTC(2026, month, 16), later)),
    ).toEqual([
      'Fri 16 Jan',
      'Mon 16 Feb',
      'Mon 16 Mar',
      'Thu 16 Apr',
      'Sat 16 May',
      'Tue 16 Jun',
      'Thu 16 Jul',
      'Sun 16 Aug',
      'Wed 16 Sep',
      'Fri 16 Oct',
      'Mon 16 Nov',
      'Wed 16 Dec',
    ]);
  });

  it('names every weekday in fixed English short form', () => {
    const later = context('2027-03-01T12:00:00Z', utc);
    expect(
      Array.from({ length: 7 }, (_, index) =>
        formatDayHeading(Date.UTC(2026, 7, 10 + index), later),
      ),
    ).toEqual([
      'Mon 10 Aug',
      'Tue 11 Aug',
      'Wed 12 Aug',
      'Thu 13 Aug',
      'Fri 14 Aug',
      'Sat 15 Aug',
      'Sun 16 Aug',
    ]);
  });

  it('reads the day through the supplied offset rather than the ambient zone', () => {
    expect(formatDayHeading(at('2026-09-20T00:00:00Z'), context(now, utc))).toBe('Today');
    expect(formatDayHeading(at('2026-09-19T00:00:00Z'), context(now, utc))).toBe('Yesterday');
  });
});

/** The day now lives in the group heading above the row, so a range carries wall times only. */
describe('formatSessionClockRange', () => {
  const now = '2026-09-20T16:00:00+03:00';

  it('shows a closed session as two wall times', () => {
    const entry = closed('2026-09-20T09:12:00+03:00', '2026-09-20T10:32:00+03:00');
    expect(formatSessionClockRange(entry, context(now))).toBe('09:12 → 10:32');
  });

  it('names no day on a session older than yesterday', () => {
    const entry = closed('2026-09-16T09:12:00+03:00', '2026-09-16T10:32:00+03:00');
    expect(formatSessionClockRange(entry, context(now))).toBe('09:12 → 10:32');
  });

  it('leaves a running session open', () => {
    expect(formatSessionClockRange(running('2026-09-20T14:05:00+03:00'), context(now))).toBe(
      '14:05 →',
    );
  });

  it('shows both wall times of a session that crossed midnight', () => {
    const entry = closed('2026-09-19T23:30:00+03:00', '2026-09-20T00:15:00+03:00');
    expect(formatSessionClockRange(entry, context(now))).toBe('23:30 → 00:15');
  });

  it('renders the wall times through the supplied offset', () => {
    const entry = closed('2026-09-20T09:12:00+03:00', '2026-09-20T10:32:00+03:00');
    expect(formatSessionClockRange(entry, context(now, utc))).toBe('06:12 → 07:32');
  });

  it('has no range to show for a broken entry', () => {
    expect(formatSessionClockRange(broken, context(now))).toBe('');
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

  it('names an older day by its calendar date, without the weekday', () => {
    expect(
      staleTrackingQuestion(at('2026-09-16T14:05:00+03:00'), context('2026-09-20T10:00:00+03:00')),
    ).toBe('Still tracking since 16 Sep at 14:05?');
    expect(
      staleTrackingQuestion(at('2026-12-16T14:05:00+03:00'), context('2026-12-20T10:00:00+03:00')),
    ).toBe('Still tracking since 16 Dec at 14:05?');
  });
});
