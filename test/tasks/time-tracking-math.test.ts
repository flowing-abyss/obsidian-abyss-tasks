import { describe, expect, it } from 'vitest';
import {
  addEntryToTotal,
  entryDurationMs,
  entryOverlapMs,
  groupTrackedDays,
  localDayStartMs,
  resumeTarget,
  shiftLocalDayStartMs,
  subtreeTotal,
  totalMs,
  type TimeEntryIssue,
  type TimeEntrySnapshot,
  type TrackedDay,
  type TrackedDayRow,
  type TrackedEntry,
  type TrackedTotal,
} from '../../src/tasks/domain/timeTracking';

const H = 3_600_000;
const M = 60_000;
const plus3 = (): number => 180;
const at = (iso: string): number => Date.parse(iso);
const closed = (start: string, end: string, relativeLine = 1): TimeEntrySnapshot => ({
  relativeLine,
  originalMarkdown: `- ${start} → ${end}`,
  state: 'closed',
  startMs: at(start),
  endMs: at(end),
});
const running = (start: string, relativeLine = 1): TimeEntrySnapshot => ({
  relativeLine,
  originalMarkdown: `- ${start} →`,
  state: 'running',
  startMs: at(start),
});
const brokenIssue: TimeEntryIssue = 'invalid-end';
const broken: TimeEntrySnapshot = {
  relativeLine: 9,
  originalMarkdown: '- x',
  state: 'broken',
  issue: brokenIssue,
  startMs: 0,
};
const tracked = (
  title: string,
  line: number,
  entry: TimeEntrySnapshot,
  status: TrackedEntry['status'] = 'open',
): TrackedEntry => ({
  filePath: 'a.md',
  root: { filePath: 'a.md', line, revision: `r${line}` },
  target: { type: 'task', ref: { filePath: 'a.md', line, revision: `r${line}` } },
  title,
  status,
  entry,
});

describe('durations', () => {
  it('measures closed, running and broken entries', () => {
    expect(
      entryDurationMs(closed('2026-09-17T09:00:00+03:00', '2026-09-17T10:30:00+03:00'), 0),
    ).toBe(90 * M);
    expect(
      entryDurationMs(running('2026-09-17T09:00:00+03:00'), at('2026-09-17T09:12:07+03:00')),
    ).toBe(12 * M + 7000);
    expect(
      entryDurationMs(running('2026-09-17T09:00:00+03:00'), at('2026-09-17T08:00:00+03:00')),
    ).toBe(0);
    expect(entryDurationMs(broken, 10 * H)).toBe(0);
  });

  it('clips an entry to a range', () => {
    const entry = closed('2026-09-17T23:30:00+03:00', '2026-09-18T00:15:00+03:00');
    const midnight = at('2026-09-18T00:00:00+03:00');
    expect(entryOverlapMs(entry, midnight - 24 * H, midnight, 0)).toBe(30 * M);
    expect(entryOverlapMs(entry, midnight, midnight + 24 * H, 0)).toBe(15 * M);
    expect(entryOverlapMs(entry, midnight + H, midnight + 2 * H, 0)).toBe(0);
  });

  it('sums a subtree and ignores broken entries', () => {
    const total: TrackedTotal = subtreeTotal({
      timeEntries: [closed('2026-09-17T09:00:00+03:00', '2026-09-17T10:00:00+03:00'), broken],
      subtasks: [{ timeEntries: [running('2026-09-17T11:00:00+03:00')], subtasks: [] }],
    });
    expect(total.closedMs).toBe(H);
    expect(total.openStartsMs).toEqual([at('2026-09-17T11:00:00+03:00')]);
    expect(totalMs(total, at('2026-09-17T11:30:00+03:00'))).toBe(H + 30 * M);
  });

  it('accumulates entries into a mutable total', () => {
    const total = { closedMs: 0, openStartsMs: [] as number[] };
    addEntryToTotal(total, closed('2026-09-17T09:00:00+03:00', '2026-09-17T09:45:00+03:00'));
    addEntryToTotal(total, running('2026-09-17T10:00:00+03:00'));
    addEntryToTotal(total, broken);
    expect(total.closedMs).toBe(45 * M);
    expect(total.openStartsMs).toEqual([at('2026-09-17T10:00:00+03:00')]);
  });
});

describe('local days', () => {
  it('finds local midnight for a fixed offset', () => {
    expect(localDayStartMs(at('2026-09-18T14:05:00+03:00'), plus3)).toBe(
      at('2026-09-18T00:00:00+03:00'),
    );
    expect(localDayStartMs(at('2026-09-18T00:00:00+03:00'), plus3)).toBe(
      at('2026-09-18T00:00:00+03:00'),
    );
  });

  it('shifts across a DST change by wall days', () => {
    const flip = at('2026-03-29T01:00:00Z');
    const dst = (epochMs: number): number => (epochMs >= flip ? 120 : 60);
    const day = localDayStartMs(at('2026-03-29T12:00:00+02:00'), dst);
    expect(day).toBe(at('2026-03-29T00:00:00+01:00'));
    expect(shiftLocalDayStartMs(day, 1, dst)).toBe(at('2026-03-30T00:00:00+02:00'));
    expect(shiftLocalDayStartMs(day, -1, dst)).toBe(at('2026-03-28T00:00:00+01:00'));
  });
});

describe('groupTrackedDays', () => {
  const now = at('2026-09-18T15:00:00+03:00');
  const entries = [
    tracked('Write report', 1, closed('2026-09-18T09:00:00+03:00', '2026-09-18T10:00:00+03:00')),
    tracked('Write report', 1, running('2026-09-18T14:00:00+03:00', 2)),
    tracked('Review PR', 5, closed('2026-09-18T11:00:00+03:00', '2026-09-18T13:05:00+03:00')),
    tracked('Night shift', 9, closed('2026-09-17T23:30:00+03:00', '2026-09-18T00:15:00+03:00')),
    tracked('Broken', 12, broken),
    tracked('Old', 15, closed('2026-09-01T09:00:00+03:00', '2026-09-01T10:00:00+03:00')),
  ];

  it('groups by local day, clips at midnight, merges entries of one node, sorts by last activity', () => {
    const days: readonly TrackedDay[] = groupTrackedDays(entries, {
      nowMs: now,
      offsetAt: plus3,
      days: 7,
    });
    expect(days.map((day) => day.dayStartMs)).toEqual([
      at('2026-09-18T00:00:00+03:00'),
      at('2026-09-17T00:00:00+03:00'),
    ]);
    const today = days[0];
    expect(
      today?.rows.map((row: TrackedDayRow) => [
        row.entryOfRecord.title,
        row.trackedMs,
        row.running,
      ]),
    ).toEqual([
      ['Write report', 2 * H, true],
      ['Review PR', 2 * H + 5 * M, false],
      ['Night shift', 15 * M, false],
    ]);
    expect(today?.totalMs).toBe(4 * H + 20 * M);
    expect(days[1]?.rows.map((row) => [row.entryOfRecord.title, row.trackedMs])).toEqual([
      ['Night shift', 30 * M],
    ]);
  });

  it('picks the resume target by most recent activity', () => {
    expect(resumeTarget(entries)?.title).toBe('Write report');
    expect(resumeTarget(entries.filter((item) => item.entry.state !== 'running'))?.title).toBe(
      'Review PR',
    );
    expect(resumeTarget([])).toBeUndefined();
  });
});
