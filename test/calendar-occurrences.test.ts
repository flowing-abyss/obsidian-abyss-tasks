import { RRule } from 'rrule';
import { describe, expect, it, vi } from 'vitest';
import type { DateRange, TaskPlanning, TaskSnapshot } from '../src/tasks/domain/types';
import { localDate } from '../src/tasks/domain/validation';
import {
  projectCalendarOccurrences,
  taskSnapshotForCalendarOccurrence,
  type CalendarProjectionIssue,
  type CalendarProjectionSources,
  type CalendarTaskSource,
} from '../src/views/calendarOccurrences';
import { taskLayoutIdentity } from '../src/views/timegrid/layout';
import { task } from './helpers';

const keepScheduled = { removeScheduledDate: false } as const;

function range(from: string, to: string): DateRange {
  return { from: localDate(from), to: localDate(to) };
}

function source(root: TaskSnapshot): CalendarTaskSource {
  return {
    root,
    target: { type: 'task', ref: root.ref },
    node: root,
  };
}

function rootSource(
  title: string,
  options: {
    readonly filePath?: string;
    readonly line?: number;
    readonly revision?: string;
    readonly planning?: Partial<TaskPlanning>;
    readonly recurrence?: string;
    readonly status?: TaskSnapshot['status'];
  } = {},
): CalendarTaskSource {
  return source(
    task({
      title,
      status: options.status ?? 'open',
      recurrence: options.recurrence,
      planning: options.planning,
      source: { filePath: options.filePath ?? 'Tasks.md', line: options.line ?? 0 },
      ref: { revision: options.revision ?? `revision:${title}` },
    }),
  );
}

function project(
  sources: Partial<CalendarProjectionSources>,
  visible: DateRange = range('2026-08-08', '2026-08-08'),
) {
  return projectCalendarOccurrences(
    {
      materialized: sources.materialized ?? [],
      recurringSources: sources.recurringSources ?? [],
    },
    visible,
    keepScheduled,
  );
}

describe('projectCalendarOccurrences', () => {
  it('preserves materialized planning and creates revision-free semantic occurrence keys', () => {
    const current = rootSource('current', {
      planning: { due: localDate('2026-08-08') },
      recurrence: 'every day',
      revision: 'ephemeral-revision',
    });

    const result = project({ materialized: [current] });

    expect(result.occurrences).toHaveLength(1);
    expect(result.occurrences[0]).toMatchObject({
      kind: 'materialized',
      key: 'Tasks.md:0:2026-08-08',
      planning: { due: '2026-08-08' },
      recurring: true,
    });
    expect(result.occurrences[0]?.key).not.toContain(current.root.ref.revision);
    expect(result.issues).toEqual([]);
  });

  it('projects daily and weekly sources whose current occurrence is outside the viewport', () => {
    const daily = rootSource('daily', {
      line: 2,
      planning: { due: localDate('2026-08-07') },
      recurrence: 'every day',
    });
    const weekly = rootSource('weekly', {
      line: 1,
      planning: { due: localDate('2026-08-03') },
      recurrence: 'every week on Monday',
    });

    const result = project(
      { recurringSources: [daily, weekly] },
      range('2026-08-08', '2026-08-10'),
    );

    expect(
      result.occurrences.map((occurrence) => [
        occurrence.source.node.title,
        occurrence.kind === 'forecast' ? occurrence.referenceDate : undefined,
      ]),
    ).toEqual([
      ['daily', '2026-08-08'],
      ['daily', '2026-08-09'],
      ['weekly', '2026-08-10'],
      ['daily', '2026-08-10'],
    ]);
  });

  it.each([
    {
      name: 'ordinary February and following short months',
      anchor: '2023-01-31',
      visible: range('2023-02-01', '2023-04-30'),
      want: ['2023-02-28', '2023-03-31', '2023-04-30'],
    },
    {
      name: 'leap February',
      anchor: '2024-01-31',
      visible: range('2024-02-01', '2024-02-29'),
      want: ['2024-02-29'],
    },
  ])('projects every month on the last across $name', ({ anchor, visible, want }) => {
    const monthly = rootSource('month end', {
      planning: { due: localDate(anchor) },
      recurrence: 'every month on the last',
    });

    const result = project({ recurringSources: [monthly] }, visible);

    expect(
      result.occurrences.map((occurrence) =>
        occurrence.kind === 'forecast' ? occurrence.referenceDate : undefined,
      ),
    ).toEqual(want);
  });

  it('extends expansion bounds for scheduled and due offsets, then filters overlap candidates', () => {
    const offset = rootSource('offset', {
      planning: {
        scheduled: localDate('2026-08-01'),
        due: localDate('2026-08-05'),
      },
      recurrence: 'every day',
    });

    const result = project({ recurringSources: [offset] }, range('2026-08-08', '2026-08-08'));

    expect(
      result.occurrences.map((occurrence) => ({
        referenceDate: occurrence.kind === 'forecast' ? occurrence.referenceDate : undefined,
        planning: occurrence.planning,
      })),
    ).toEqual([
      {
        referenceDate: '2026-08-08',
        planning: { scheduled: '2026-08-04', due: '2026-08-08' },
      },
      {
        referenceDate: '2026-08-12',
        planning: { scheduled: '2026-08-08', due: '2026-08-12' },
      },
    ]);
  });

  it('ignores removed scheduled offsets when seeking a distant visible due forecast', () => {
    const daily = rootSource('remove scheduled bounds', {
      planning: {
        due: localDate('2020-01-01'),
        scheduled: localDate('2030-01-01'),
      },
      recurrence: 'every day',
    });

    const result = projectCalendarOccurrences(
      { materialized: [], recurringSources: [daily] },
      range('2031-01-01', '2031-01-01'),
      { removeScheduledDate: true },
    );

    expect(result.occurrences).toHaveLength(1);
    expect(result.occurrences[0]?.planning).toEqual({ due: '2031-01-01' });
    expect(result.issues).toEqual([]);
  });

  it('projects every multi-day span that crosses either visible boundary', () => {
    const span = rootSource('span', {
      planning: { start: localDate('2026-08-01'), due: localDate('2026-08-03') },
      recurrence: 'every day',
    });

    const result = project({ recurringSources: [span] }, range('2026-08-05', '2026-08-05'));

    expect(result.occurrences.map(({ planning }) => planning)).toEqual([
      { start: '2026-08-03', due: '2026-08-05' },
      { start: '2026-08-04', due: '2026-08-06' },
      { start: '2026-08-05', due: '2026-08-07' },
    ]);
  });

  it('carries semantic occurrence keys into layout identity for overlapping forecasts', () => {
    const span = rootSource('overlapping span', {
      planning: { start: localDate('2026-08-01'), due: localDate('2026-08-03') },
      recurrence: 'every day',
    });

    const snapshots = project(
      { recurringSources: [span] },
      range('2026-08-02', '2026-08-08'),
    ).occurrences.map(taskSnapshotForCalendarOccurrence);

    expect(snapshots.length).toBeGreaterThan(1);
    expect(new Set(snapshots.map(taskLayoutIdentity)).size).toBe(snapshots.length);
    const firstOccurrence = project({ recurringSources: [span] }, range('2026-08-02', '2026-08-02'))
      .occurrences[0]!;
    const firstSnapshot = taskSnapshotForCalendarOccurrence(firstOccurrence);
    expect(firstSnapshot.ref).toBe(firstOccurrence.source.root.ref);
  });

  it('preserves timed planning and leaves untimed forecasts untimed', () => {
    const timed = rootSource('timed', {
      line: 1,
      planning: {
        due: localDate('2026-08-07'),
        time: '09:30' as never,
        duration: 90 as never,
      },
      recurrence: 'every day',
    });
    const untimed = rootSource('untimed', {
      line: 2,
      planning: { due: localDate('2026-08-07') },
      recurrence: 'every day',
    });

    const result = project({ recurringSources: [untimed, timed] });

    expect(
      result.occurrences.map(({ source: item, planning }) => [item.node.title, planning]),
    ).toEqual([
      ['timed', { due: '2026-08-08', time: '09:30', duration: 90 }],
      ['untimed', { due: '2026-08-08' }],
    ]);
  });

  it('excludes invalid, undated, when-done, done, and cancelled forecast sources', () => {
    const dated = { due: localDate('2026-08-07') };
    const sources = [
      rootSource('invalid', { planning: dated, recurrence: 'weekly' }),
      rootSource('undated', { recurrence: 'every day' }),
      rootSource('when done', { planning: dated, recurrence: 'every day when done' }),
      rootSource('done', { planning: dated, recurrence: 'every day', status: 'done' }),
      rootSource('cancelled', { planning: dated, recurrence: 'every day', status: 'cancelled' }),
    ];

    expect(project({ recurringSources: sources })).toEqual({ occurrences: [], issues: [] });
  });

  it('deduplicates semantic occurrences and returns stable date, time, and source ordering', () => {
    const laterFile = rootSource('later file', {
      filePath: 'B.md',
      planning: { due: localDate('2026-08-07') },
      recurrence: 'every day',
    });
    const earlierFile = rootSource('earlier file', {
      filePath: 'A.md',
      planning: { due: localDate('2026-08-07'), time: '08:00' as never },
      recurrence: 'every day',
    });

    const result = project({
      recurringSources: [laterFile, earlierFile, laterFile, earlierFile],
    });

    expect(result.occurrences.map(({ key }) => key)).toEqual([
      'A.md:0:2026-08-08',
      'B.md:0:2026-08-08',
    ]);
  });

  it('uses one semantic key for a span while segment presentation keys remain distinct', () => {
    const span = rootSource('span', {
      planning: { start: localDate('2026-08-06'), due: localDate('2026-08-08') },
    });
    const occurrence = project({ materialized: [span] }).occurrences[0]!;

    const bodyOccurrence = occurrence;
    const deadlineOccurrence = occurrence;
    expect(bodyOccurrence.key).toBe(deadlineOccurrence.key);
    expect(`${bodyOccurrence.key}:body`).not.toBe(`${deadlineOccurrence.key}:deadline`);
  });

  it('returns an explicit 512 visible-occurrence diagnostic and frozen forecast values', () => {
    const daily = rootSource('daily', {
      planning: { due: localDate('2026-01-01') },
      recurrence: 'every day',
    });

    const result = project({ recurringSources: [daily] }, range('2026-01-02', '2027-12-31'));

    expect(result.occurrences).toHaveLength(512);
    const expectedIssues: readonly CalendarProjectionIssue[] = [
      {
        code: 'forecast-limit-reached',
        source: daily.root.ref,
        phase: 'visible-occurrences',
        limit: 512,
      },
    ];
    expect(result.issues).toEqual(expectedIssues);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.occurrences)).toBe(true);
    expect(Object.isFrozen(result.occurrences[0])).toBe(true);
    expect(Object.isFrozen(result.occurrences[0]?.planning)).toBe(true);
    expect('ref' in result.occurrences[0]!).toBe(false);
  });

  it('returns an explicit 4096 sequential-seek diagnostic', () => {
    const monthly = rootSource('monthly', {
      planning: { due: localDate('1000-01-31') },
      recurrence: 'every month',
    });

    const result = project({ recurringSources: [monthly] }, range('1400-01-01', '1400-12-31'));

    expect(result).toEqual({
      occurrences: [],
      issues: [
        {
          code: 'forecast-limit-reached',
          source: monthly.root.ref,
          phase: 'sequential-seek',
          limit: 4096,
        },
      ],
    });
  });

  it('compiles one raw rule once across distinct source projections', () => {
    const parseText = vi.spyOn(RRule, 'parseText');
    const first = rootSource('first', {
      line: 1,
      planning: { due: localDate('2026-08-01') },
      recurrence: 'every 17 days',
      revision: 'first-revision',
    });
    const second = rootSource('second', {
      line: 2,
      planning: { due: localDate('2026-08-01') },
      recurrence: 'every 17 days',
      revision: 'second-revision',
    });

    project({ recurringSources: [first, second] }, range('2026-08-18', '2026-08-18'));

    expect(parseText).toHaveBeenCalledTimes(1);
    parseText.mockRestore();
  });

  it('invalidates projection cache entries by revision and evicts old entries within 300 sources', () => {
    let planningReads = 0;
    const counted = (revision: string): CalendarTaskSource => {
      const root = task({
        title: revision,
        recurrence: 'every 19 days',
        ref: { revision },
      });
      Object.defineProperty(root, 'planning', {
        configurable: true,
        get: () => {
          planningReads++;
          return { due: localDate('2026-08-01') };
        },
      });
      return source(root);
    };
    const first = counted('cache-first');

    project({ recurringSources: [first] }, range('2026-08-20', '2026-08-20'));
    expect(planningReads).toBeGreaterThan(0);
    planningReads = 0;
    project({ recurringSources: [first] }, range('2026-08-20', '2026-08-20'));
    expect(planningReads).toBe(0);

    const revised = counted('cache-revised');
    project({ recurringSources: [revised] }, range('2026-08-20', '2026-08-20'));
    expect(planningReads).toBeGreaterThan(0);

    for (let index = 0; index < 300; index++) {
      project({ recurringSources: [counted(`cache-${index}`)] }, range('2026-08-20', '2026-08-20'));
    }
    planningReads = 0;
    project({ recurringSources: [first] }, range('2026-08-20', '2026-08-20'));
    expect(planningReads).toBeGreaterThan(0);
  });
});
