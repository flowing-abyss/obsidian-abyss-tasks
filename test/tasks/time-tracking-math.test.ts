import { describe, expect, it } from 'vitest';
import {
  addEntryToTotal,
  entryDurationMs,
  entryOverlapMs,
  formatTrackedDuration,
  groupTrackedDays,
  localDayStartMs,
  openTimersExtraMs,
  resumeTarget,
  shiftLocalDayStartMs,
  subtreeTotal,
  taskNodeAddress,
  totalMs,
  type TimeEntryIssue,
  type TimeEntrySnapshot,
  type TrackedDay,
  type TrackedDayRow,
  type TrackedEntry,
  type TrackedTotal,
} from '../../src/tasks/domain/timeTracking';
import { expectDefined } from '../helpers';

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
): TrackedEntry => {
  const target = { type: 'task', ref: { filePath: 'a.md', line, revision: `r${line}` } } as const;
  const address = taskNodeAddress(target);
  return {
    filePath: 'a.md',
    root: target.ref,
    target,
    address,
    rootAddress: address,
    title,
    status,
    entry,
  };
};
const trackedSubtask = (
  title: string,
  line: number,
  relativeLine: number,
  entry: TimeEntrySnapshot,
): TrackedEntry => {
  const root = { type: 'task', ref: { filePath: 'a.md', line, revision: `r${line}` } } as const;
  const target = {
    type: 'subtask',
    ref: { parent: root, relativeLine, originalBlock: `- [ ] sub ${relativeLine}` },
  } as const;
  return {
    filePath: 'a.md',
    root: root.ref,
    target,
    address: taskNodeAddress(target),
    rootAddress: taskNodeAddress(root),
    title,
    status: 'open',
    entry,
  };
};

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

  it('clips a running entry at midnight', () => {
    const entry = running('2026-09-17T23:30:00+03:00');
    const midnight = at('2026-09-18T00:00:00+03:00');
    const nowMs = at('2026-09-18T00:20:00+03:00');
    expect(entryOverlapMs(entry, midnight - 24 * H, midnight, nowMs)).toBe(30 * M);
    expect(entryOverlapMs(entry, midnight, midnight + 24 * H, nowMs)).toBe(20 * M);
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

  // A zone that springs forward exactly at local midnight: -03:00 before 2026-10-18T03:00:00Z and
  // -02:00 from that instant on, so local 2026-10-18T00:00 never happens and the first moment of
  // that local day is the transition itself.
  const springAtMidnight = (epochMs: number): number =>
    epochMs >= at('2026-10-18T03:00:00Z') ? -120 : -180;

  it('lands on the transition when local midnight never happens', () => {
    expect(localDayStartMs(at('2026-10-18T15:00:00Z'), springAtMidnight)).toBe(
      at('2026-10-18T03:00:00Z'),
    );
    expect(localDayStartMs(at('2026-10-18T03:00:00Z'), springAtMidnight)).toBe(
      at('2026-10-18T03:00:00Z'),
    );
  });

  it('shifts onto a missing local midnight from either side', () => {
    const october17 = localDayStartMs(at('2026-10-17T15:00:00Z'), springAtMidnight);
    const october19 = localDayStartMs(at('2026-10-19T15:00:00Z'), springAtMidnight);
    expect(october17).toBe(at('2026-10-17T03:00:00Z'));
    expect(october19).toBe(at('2026-10-19T02:00:00Z'));
    expect(shiftLocalDayStartMs(october17, 1, springAtMidnight)).toBe(at('2026-10-18T03:00:00Z'));
    expect(shiftLocalDayStartMs(october19, -1, springAtMidnight)).toBe(at('2026-10-18T03:00:00Z'));
  });

  // A zone that falls back exactly at local midnight: -03:00 before 2026-11-01T03:00:00Z and
  // -04:00 from that instant on, so local 2026-11-01T00:00 happens once, at 2026-11-01T04:00:00Z.
  const fallBackAtMidnight = (epochMs: number): number =>
    epochMs >= at('2026-11-01T03:00:00Z') ? -240 : -180;

  it('leaves a fall back at local midnight alone', () => {
    const november1 = localDayStartMs(at('2026-11-01T18:00:00Z'), fallBackAtMidnight);
    const october31 = localDayStartMs(at('2026-10-31T15:00:00Z'), fallBackAtMidnight);
    expect(november1).toBe(at('2026-11-01T04:00:00Z'));
    expect(october31).toBe(at('2026-10-31T03:00:00Z'));
    expect(shiftLocalDayStartMs(october31, 1, fallBackAtMidnight)).toBe(at('2026-11-01T04:00:00Z'));
    expect(shiftLocalDayStartMs(november1, -1, fallBackAtMidnight)).toBe(
      at('2026-10-31T03:00:00Z'),
    );
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

  it('spreads one entry across every day it spans', () => {
    const days = groupTrackedDays(
      [tracked('Marathon', 20, closed('2026-09-16T22:00:00+03:00', '2026-09-18T01:00:00+03:00'))],
      { nowMs: now, offsetAt: plus3, days: 7 },
    );
    expect(days.map((day) => [day.dayStartMs, day.totalMs])).toEqual([
      [at('2026-09-18T00:00:00+03:00'), H],
      [at('2026-09-17T00:00:00+03:00'), 24 * H],
      [at('2026-09-16T00:00:00+03:00'), 2 * H],
    ]);
  });

  it('drops entries that cannot touch the window', () => {
    const outside = [
      tracked('Old', 15, closed('2026-09-01T09:00:00+03:00', '2026-09-01T10:00:00+03:00')),
      tracked('Later', 16, closed('2026-09-18T16:00:00+03:00', '2026-09-18T17:00:00+03:00')),
    ];
    expect(groupTrackedDays(outside, { nowMs: now, offsetAt: plus3, days: 7 })).toEqual([]);
  });

  it('keeps a running entry live only on the day that holds now', () => {
    const days = groupTrackedDays([tracked('Long run', 3, running('2026-09-17T22:00:00+03:00'))], {
      nowMs: now,
      offsetAt: plus3,
      days: 7,
    });
    expect(days.map((day) => [day.dayStartMs, day.totalMs])).toEqual([
      [at('2026-09-18T00:00:00+03:00'), 15 * H],
      [at('2026-09-17T00:00:00+03:00'), 2 * H],
    ]);
    expect(days[0]?.rows.map((row) => [row.running, row.lastActivityMs])).toEqual([[true, now]]);
    expect(days[1]?.rows.map((row) => [row.running, row.lastActivityMs])).toEqual([
      [false, at('2026-09-18T00:00:00+03:00')],
    ]);
  });

  it('never counts tracked time past now', () => {
    const days = groupTrackedDays(
      [tracked('Overrun', 4, closed('2026-09-18T14:00:00+03:00', '2026-09-18T18:00:00+03:00'))],
      { nowMs: now, offsetAt: plus3, days: 7 },
    );
    expect(days[0]?.rows.map((row) => [row.trackedMs, row.lastActivityMs])).toEqual([[H, now]]);
    expect(days[0]?.totalMs).toBe(H);
  });

  it('keeps sibling subtasks apart and merges repeats of one subtask', () => {
    const days = groupTrackedDays(
      [
        trackedSubtask(
          'Draft',
          1,
          3,
          closed('2026-09-18T09:00:00+03:00', '2026-09-18T09:30:00+03:00'),
        ),
        trackedSubtask(
          'Draft',
          1,
          3,
          closed('2026-09-18T10:00:00+03:00', '2026-09-18T10:15:00+03:00', 2),
        ),
        trackedSubtask(
          'Polish',
          1,
          5,
          closed('2026-09-18T11:00:00+03:00', '2026-09-18T11:10:00+03:00'),
        ),
      ],
      { nowMs: now, offsetAt: plus3, days: 7 },
    );
    expect(days[0]?.rows.map((row) => [row.entryOfRecord.title, row.trackedMs])).toEqual([
      ['Polish', 10 * M],
      ['Draft', 45 * M],
    ]);
  });

  it('gives a timer started this instant a row on the day that holds now', () => {
    const days = groupTrackedDays(
      [tracked('Fresh start', 7, running('2026-09-18T15:00:00+03:00'))],
      {
        nowMs: now,
        offsetAt: plus3,
        days: 7,
      },
    );
    expect(days.map((day) => [day.dayStartMs, day.totalMs])).toEqual([
      [at('2026-09-18T00:00:00+03:00'), 0],
    ]);
    expect(
      days[0]?.rows.map((row) => [
        row.entryOfRecord.title,
        row.trackedMs,
        row.running,
        row.lastActivityMs,
      ]),
    ).toEqual([['Fresh start', 0, true, now]]);
  });

  it('opens today for a node whose only earned time is on earlier days', () => {
    const days = groupTrackedDays(
      [
        tracked(
          'Write report',
          1,
          closed('2026-09-17T09:00:00+03:00', '2026-09-17T10:00:00+03:00'),
        ),
        tracked('Write report', 1, running('2026-09-18T15:00:00+03:00', 2)),
      ],
      { nowMs: now, offsetAt: plus3, days: 7 },
    );
    expect(days.map((day) => [day.dayStartMs, day.totalMs, day.rows.length])).toEqual([
      [at('2026-09-18T00:00:00+03:00'), 0, 1],
      [at('2026-09-17T00:00:00+03:00'), H, 1],
    ]);
    expect(days.map((day) => day.rows.map((row) => row.running))).toEqual([[true], [false]]);
  });

  it('marks a node tracking again without moving the total it already earned today', () => {
    const days = groupTrackedDays(
      [
        tracked('Review PR', 5, closed('2026-09-18T11:00:00+03:00', '2026-09-18T12:00:00+03:00')),
        tracked('Review PR', 5, running('2026-09-18T15:00:00+03:00', 2)),
      ],
      { nowMs: now, offsetAt: plus3, days: 7 },
    );
    expect(days[0]?.rows.map((row) => [row.trackedMs, row.running])).toEqual([[H, true]]);
    expect(days[0]?.totalMs).toBe(H);
  });

  it('still makes no row for a closed entry that lasted no time', () => {
    expect(
      groupTrackedDays(
        [tracked('Mistake', 8, closed('2026-09-18T12:00:00+03:00', '2026-09-18T12:00:00+03:00'))],
        { nowMs: now, offsetAt: plus3, days: 7 },
      ),
    ).toEqual([]);
  });

  it('freezes the days and the rows it hands out', () => {
    const days = groupTrackedDays(entries, { nowMs: now, offsetAt: plus3, days: 7 });
    expect(Object.isFrozen(days)).toBe(true);
    expect(days.every((day) => Object.isFrozen(day) && Object.isFrozen(day.rows))).toBe(true);
    expect(days.every((day) => day.rows.every((row) => Object.isFrozen(row)))).toBe(true);
    expect(days.every((day) => Object.isFrozen(day.openStartsMs))).toBe(true);
    expect(days.every((day) => day.rows.every((row) => Object.isFrozen(row.openStartsMs)))).toBe(
      true,
    );
  });

  it('keeps every open start on today and on the row that holds it', () => {
    const first = at('2026-09-18T13:00:00+03:00');
    const second = at('2026-09-18T14:30:00+03:00');
    const days = groupTrackedDays(
      [
        tracked('Write report', 1, running('2026-09-18T13:00:00+03:00', 2)),
        tracked('Review PR', 5, running('2026-09-18T14:30:00+03:00', 2)),
      ],
      { nowMs: now, offsetAt: plus3, days: 7 },
    );

    const today = expectDefined(days[0]);
    expect(today.openStartsMs).toEqual([first, second]);
    expect(today.rows.map((row) => [row.entryOfRecord.title, row.openStartsMs])).toEqual([
      ['Write report', [first]],
      ['Review PR', [second]],
    ]);
  });

  it('leaves an earlier day without any open start of its own', () => {
    const days = groupTrackedDays(
      [tracked('Write report', 1, running('2026-09-16T09:00:00+03:00', 2))],
      {
        nowMs: now,
        offsetAt: plus3,
        days: 7,
      },
    );

    expect(days.map((day) => day.openStartsMs.length)).toEqual([1, 0, 0]);
  });

  it('adds every open timer once the grouping instant has passed', () => {
    const first = at('2026-09-18T13:00:00+03:00');
    const second = at('2026-09-18T14:30:00+03:00');

    expect(openTimersExtraMs([first, second], now, now + 2 * M)).toBe(4 * M);
    expect(openTimersExtraMs([], now, now + 2 * M)).toBe(0);
    // A hand-written start ahead of the clock earns nothing until the clock reaches it.
    expect(openTimersExtraMs([now + 5 * M], now, now + 2 * M)).toBe(0);
  });
});

describe('formatTrackedDuration', () => {
  it.each([
    [0, '0m'],
    [59_999, '0m'],
    [M, '1m'],
    [15 * M, '15m'],
    [80 * M, '1h20m'],
    [H, '1h'],
    [120 * M, '2h'],
    [H + 59_999, '1h'],
    [25 * H + M, '25h1m'],
  ])('formats %i ms as %s', (ms, expected) => {
    expect(formatTrackedDuration(ms)).toBe(expected);
  });

  it('reads negative and uncountable totals as no time instead of rejecting them', () => {
    expect(formatTrackedDuration(-5 * M)).toBe('0m');
    expect(formatTrackedDuration(Number.NaN)).toBe('0m');
    expect(formatTrackedDuration(Number.POSITIVE_INFINITY)).toBe('0m');
  });
});
