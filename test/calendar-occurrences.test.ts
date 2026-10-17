// @vitest-environment node
import { RRule } from 'rrule';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as tasks from '../src/tasks';
import type { DateRange, TaskPlanning, TaskSnapshot } from '../src/tasks/domain/types';
import { durationMinutes, localDate, localTime } from '../src/tasks/domain/validation';
import { TaskMarkdownCodec } from '../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { projectTaskSnapshot } from '../src/tasks/infrastructure/markdown/TaskSnapshotProjector';
import {
  calendarOccurrenceForTask,
  calendarPointPatchCommand,
  calendarShiftScheduleCommand,
  calendarTaskWithPlanning,
  projectCalendarOccurrences,
  taskSnapshotForCalendarOccurrence,
  type CalendarProjectionIssue,
  type CalendarProjectionSources,
  type CalendarTaskSource,
} from '../src/views/calendarOccurrences';
import { taskLayoutIdentity } from '../src/views/timegrid/layout';
import { canonicalStatusCatalog, expectDefined, subtask, task } from './helpers';

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
      ...(options.recurrence === undefined ? {} : { recurrence: options.recurrence }),
      ...(options.planning === undefined ? {} : { planning: options.planning }),
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
  afterEach(() => vi.restoreAllMocks());

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

  it('retains dependency metadata for materialized occurrences and strips it from forecasts', () => {
    const recurring = source(
      task({
        title: 'dependent recurrence',
        dependencyId: 'daily-build',
        dependsOn: ['schema', 'auth', 'schema'],
        planning: { due: '2026-08-08' },
        recurrence: 'every day',
      }),
    );
    const materializedOccurrence = expectDefined(
      project({ materialized: [recurring] }).occurrences[0],
    );
    const forecastOccurrence = expectDefined(
      project({ recurringSources: [recurring] }, range('2026-08-09', '2026-08-09')).occurrences[0],
    );

    expect(taskSnapshotForCalendarOccurrence(materializedOccurrence)).toMatchObject({
      dependencyId: 'daily-build',
      dependsOn: ['schema', 'auth', 'schema'],
    });
    const forecast = taskSnapshotForCalendarOccurrence(forecastOccurrence);
    expect(forecast.dependencyId).toBeUndefined();
    expect(forecast.dependsOn).toEqual([]);
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

  it.each([
    {
      name: 'last day of February',
      rule: 'every February on the last',
      anchor: '2024-02-29',
      visible: range('2025-02-01', '2025-02-28'),
      want: ['2025-02-28'],
    },
    {
      name: 'multiple months and dates',
      rule: 'every April and December on the 1st and 24th',
      anchor: '2026-04-01',
      visible: range('2026-04-02', '2026-12-31'),
      want: ['2026-04-24', '2026-12-01', '2026-12-24'],
    },
    {
      name: 'biennial leap date',
      rule: 'every 2 years on February 29th',
      anchor: '2024-02-29',
      visible: range('2025-01-01', '2028-12-31'),
      want: ['2028-02-29'],
    },
  ])('projects Tasks yearly grammar for $name', ({ name, rule, anchor, visible, want }) => {
    const yearly = rootSource(name, {
      planning: { due: localDate(anchor) },
      recurrence: rule,
    });

    const result = project({ recurringSources: [yearly] }, visible);

    expect(
      result.occurrences.map((occurrence) =>
        occurrence.kind === 'forecast' ? occurrence.referenceDate : undefined,
      ),
    ).toEqual(want);
    expect(result.issues).toEqual([]);
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

  it.each([
    { removeScheduledDate: false, forecastReferences: ['2026-08-09'] },
    { removeScheduledDate: true, forecastReferences: [] },
  ])(
    'admits authored intervals by their range while preserving forecast scheduled offsets when removeScheduledDate=$removeScheduledDate',
    ({ removeScheduledDate, forecastReferences }) => {
      const combined = rootSource('combined planning', {
        planning: {
          start: localDate('2026-08-01'),
          due: localDate('2026-08-02'),
          scheduled: localDate('2026-08-10'),
        },
        recurrence: 'every week',
      });
      const policy = { removeScheduledDate };

      const materialized = projectCalendarOccurrences(
        { materialized: [combined], recurringSources: [] },
        range('2026-08-10', '2026-08-10'),
        policy,
      );
      const forecasts = projectCalendarOccurrences(
        { materialized: [], recurringSources: [combined] },
        range('2026-08-17', '2026-08-17'),
        policy,
      );

      expect({
        materializedPlanning: materialized.occurrences.map((occurrence) => occurrence.planning),
        forecastReferences: forecasts.occurrences.map((occurrence) =>
          occurrence.kind === 'forecast' ? occurrence.referenceDate : undefined,
        ),
      }).toEqual({
        materializedPlanning: [],
        forecastReferences,
      });
    },
  );

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
    const firstOccurrence = expectDefined(
      project({ recurringSources: [span] }, range('2026-08-02', '2026-08-02')).occurrences[0],
    );
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
    const occurrence = expectDefined(project({ materialized: [span] }).occurrences[0]);

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
    expect('ref' in expectDefined(result.occurrences[0])).toBe(false);
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

  it('expands equivalent root and child forecasts once while hydrating exact current identities', () => {
    const expansion = vi.spyOn(tasks, 'expandRecurrenceReferences');
    const first = rootSource('first', {
      filePath: 'A.md',
      line: 7,
      revision: 'first',
      planning: { due: localDate('2051-08-01') },
      recurrence: 'every 17 days',
    });
    const second = rootSource('second', {
      filePath: 'B.md',
      line: 9,
      revision: 'second',
      planning: { due: localDate('2051-08-01') },
      recurrence: 'every 17 days',
    });
    const child = subtask({
      title: 'child',
      recurrence: 'every 17 days',
      planning: { due: '2051-08-01' },
      ref: { parent: second.target, relativeLine: 2 },
    });
    const nested = subtask({
      title: 'nested',
      recurrence: 'every 17 days',
      planning: { due: '2051-08-01' },
      ref: { parent: { type: 'subtask', ref: child.ref }, relativeLine: 3 },
    });
    const secondSource = source({ ...second.root, subtasks: [{ ...child, subtasks: [nested] }] });
    const nestedSource: CalendarTaskSource = {
      root: secondSource.root,
      node: nested,
      target: { type: 'subtask', ref: nested.ref },
    };
    const result = project(
      { recurringSources: [nestedSource, secondSource, first, first] },
      range('2051-08-18', '2051-09-04'),
    );

    expect(result.occurrences.map(({ key }) => key)).toEqual([
      'A.md:7:2051-08-18',
      'B.md:9:2051-08-18',
      'B.md:9:subtask:2.3:2051-08-18',
      'A.md:7:2051-09-04',
      'B.md:9:2051-09-04',
      'B.md:9:subtask:2.3:2051-09-04',
    ]);
    expect(result.occurrences.map((value) => value.kind === 'forecast' && value.ordinal)).toEqual([
      1, 1, 1, 2, 2, 2,
    ]);
    for (const [index, current] of [first, secondSource, nestedSource].entries()) {
      const occurrence = expectDefined(result.occurrences[index]);
      expect(occurrence.source).toBe(current);
      expect(occurrence.source.target).toBe(current.target);
      expect(taskSnapshotForCalendarOccurrence(occurrence).ref).toBe(current.root.ref);
    }
    expect(expansion).toHaveBeenCalledTimes(1);
  });

  it('keeps authored occurrences ahead of shared forecasts with the same semantic key', () => {
    const original = rootSource('original', {
      line: 12,
      recurrence: 'every day',
      planning: { due: localDate('2058-01-01') },
    });
    const other = rootSource('other', {
      line: 13,
      recurrence: 'every day',
      planning: { due: localDate('2058-01-01') },
    });
    const authored = rootSource('authored', {
      line: 12,
      planning: { due: localDate('2058-01-02') },
    });
    const result = project(
      { materialized: [authored], recurringSources: [other, original, original] },
      range('2058-01-02', '2058-01-02'),
    );
    expect(result.occurrences.map(({ key, kind }) => [key, kind])).toEqual([
      ['Tasks.md:12:2058-01-02', 'materialized'],
      ['Tasks.md:13:2058-01-02', 'forecast'],
    ]);
    expect(result.occurrences[0]?.source).toBe(authored);
    expect(result.occurrences[1]?.source).toBe(other);
  });

  it('reuses calculations after revision, title and unrelated metadata edits with fresh source data', () => {
    const expansion = vi.spyOn(tasks, 'expandRecurrenceReferences');
    const first = rootSource('before', {
      planning: { due: localDate('2052-08-01') },
      recurrence: 'every 19 days',
      revision: 'before',
    });
    const visible = range('2052-08-20', '2052-08-20');
    project({ recurringSources: [first] }, visible);
    const current = source(
      task({
        ...first.root,
        title: 'after',
        markdownTitle: 'after',
        tags: ['new'],
        ref: { ...first.root.ref, revision: 'after' },
        planning: {
          ...first.node.planning,
          created: '2050-01-01',
          completion: '2050-02-01',
          cancelled: '2050-03-01',
        },
      }),
    );
    const occurrence = expectDefined(
      project({ recurringSources: [current] }, visible).occurrences[0],
    );
    expect(occurrence.key).toBe('Tasks.md:0:2052-08-20');
    expect(occurrence.source).toBe(current);
    expect(occurrence.planning).toEqual({ due: '2052-08-20' });
    expect(taskSnapshotForCalendarOccurrence(occurrence)).toMatchObject({
      title: 'after',
      tags: ['new'],
      ref: { revision: 'after' },
    });
    expect(expansion).toHaveBeenCalledTimes(1);
  });

  it.each(
    [
      {
        name: 'raw spelling',
        recurrence: 'every 2 days ',
        references: ['2053-03-03', '2053-03-05', '2053-03-07'],
        first: { due: '2053-03-03', time: '09:00', duration: 60 },
      },
      {
        name: 'raw recurrence',
        recurrence: 'every 3 days',
        references: ['2053-03-04', '2053-03-07'],
        first: { due: '2053-03-04', time: '09:00', duration: 60 },
      },
      {
        name: 'due reference',
        planning: { due: localDate('2053-03-02') },
        references: ['2053-03-04', '2053-03-06'],
        first: { due: '2053-03-04', time: '09:00', duration: 60 },
      },
      {
        name: 'start interval',
        planning: { start: localDate('2053-02-28') },
        references: ['2053-03-03', '2053-03-05', '2053-03-07'],
        first: { start: '2053-03-02', due: '2053-03-03', time: '09:00', duration: 60 },
      },
      {
        name: 'scheduled offset',
        planning: { scheduled: localDate('2053-02-28') },
        references: ['2053-03-03', '2053-03-05', '2053-03-07'],
        first: { scheduled: '2053-03-02', due: '2053-03-03', time: '09:00', duration: 60 },
      },
      {
        name: 'time',
        planning: { time: localTime('10:00') },
        references: ['2053-03-03', '2053-03-05', '2053-03-07'],
        first: { due: '2053-03-03', time: '10:00', duration: 60 },
      },
      {
        name: 'duration',
        planning: { duration: durationMinutes(90) },
        references: ['2053-03-03', '2053-03-05', '2053-03-07'],
        first: { due: '2053-03-03', time: '09:00', duration: 90 },
      },
      {
        name: 'status',
        status: 'in-progress' as const,
        references: ['2053-03-03', '2053-03-05', '2053-03-07'],
        first: { due: '2053-03-03', time: '09:00', duration: 60 },
      },
      {
        name: 'lower visible bound',
        visible: range('2053-03-05', '2053-03-07'),
        references: ['2053-03-05', '2053-03-07'],
        first: { due: '2053-03-05', time: '09:00', duration: 60 },
      },
      {
        name: 'upper visible bound',
        visible: range('2053-03-03', '2053-03-05'),
        references: ['2053-03-03', '2053-03-05'],
        first: { due: '2053-03-03', time: '09:00', duration: 60 },
      },
      {
        name: 'scheduled policy',
        policy: { removeScheduledDate: true },
        references: ['2053-03-03', '2053-03-05', '2053-03-07'],
        first: { due: '2053-03-03', time: '09:00', duration: 60 },
      },
    ].map((testCase, index) => ({ ...testCase, cacheDuration: 100 + index })),
  )(
    'separates changed $name inputs without relying on source revisions',
    ({
      name,
      planning,
      recurrence,
      status,
      visible,
      policy,
      references,
      first,
      cacheDuration: duration,
    }) => {
      const expansion = vi.spyOn(tasks, 'expandRecurrenceReferences');
      // Each case has its own consumed duration so the module cache starts cold.
      const basePlanning = {
        due: localDate('2053-03-01'),
        time: localTime('09:00'),
        duration: durationMinutes(duration),
      };
      const current = rootSource(`semantic ${name}`, {
        planning: basePlanning,
        recurrence: 'every 2 days',
      });
      const baseVisible = range('2053-03-03', '2053-03-07');
      project({ recurringSources: [current] }, baseVisible);
      const changed = source({
        ...current.root,
        planning: { ...basePlanning, ...planning },
        recurrence: recurrence ?? 'every 2 days',
        status: status ?? current.node.status,
      });
      const result = projectCalendarOccurrences(
        { materialized: [], recurringSources: [changed] },
        visible ?? baseVisible,
        policy ?? keepScheduled,
      );
      expect(
        result.occurrences.map((value) => value.kind === 'forecast' && value.referenceDate),
      ).toEqual(references);
      expect(result.occurrences[0]?.planning).toEqual({
        ...first,
        duration: planning?.duration ?? duration,
      });
      expect(result.occurrences[0]?.source).toBe(changed);
      expect(expansion).toHaveBeenCalledTimes(2);
    },
  );

  it('keeps invalid, when-done, missing-rule, undated and terminal sources excluded after warming compatible forecasts', () => {
    const expansion = vi.spyOn(tasks, 'expandRecurrenceReferences');
    const current = rootSource('eligibility', {
      planning: { due: localDate('2054-08-01') },
      recurrence: 'every day',
    });
    const visible = range('2054-08-02', '2054-08-02');
    expect(project({ recurringSources: [current] }, visible).occurrences).toHaveLength(1);
    for (const changes of [
      { recurrence: 'weekly' },
      { recurrence: 'every day when done' },
      { planning: {} },
      { status: 'done' as const },
      { status: 'cancelled' as const },
    ]) {
      const changed = source({ ...current.root, ...changes });
      expect(project({ recurringSources: [changed] }, visible)).toEqual({
        occurrences: [],
        issues: [],
      });
    }
    const withoutRule = rootSource('eligibility', { planning: current.root.planning });
    expect(project({ recurringSources: [withoutRule] }, visible)).toEqual({
      occurrences: [],
      issues: [],
    });
    expect(expansion).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      rule: 'every day',
      anchor: '2055-01-01',
      visible: range('2055-01-02', '2056-12-31'),
      count: 512,
      phase: 'visible-occurrences',
      limit: 512,
    },
    {
      rule: 'every month',
      anchor: '1100-01-31',
      visible: range('1500-01-01', '1500-12-31'),
      count: 0,
      phase: 'sequential-seek',
      limit: 4096,
    },
  ])(
    'shares $phase results with fresh diagnostic source refs',
    ({ rule, anchor, visible, count, phase, limit }) => {
      const expansion = vi.spyOn(tasks, 'expandRecurrenceReferences');
      const first = rootSource('limited first', {
        line: 21,
        recurrence: rule,
        planning: { due: localDate(anchor) },
      });
      project({ recurringSources: [first] }, visible);
      const current = rootSource('limited current', {
        filePath: 'Current.md',
        line: 22,
        revision: 'current-limit',
        recurrence: rule,
        planning: { due: localDate(anchor) },
      });
      const result = project({ recurringSources: [current] }, visible);
      expect(result.occurrences).toHaveLength(count);
      expect(result.issues).toEqual([
        { code: 'forecast-limit-reached', source: current.root.ref, phase, limit },
      ]);
      expect(Object.isFrozen(result.issues[0])).toBe(true);
      if (count > 0) {
        const occurrence = expectDefined(result.occurrences[0]);
        expect(occurrence).toMatchObject({ key: 'Current.md:22:2055-01-02', ordinal: 1 });
        expect(occurrence.source).toBe(current);
        expect(Object.isFrozen(occurrence.planning)).toBe(true);
      }
      expect(expansion).toHaveBeenCalledTimes(1);
    },
  );

  it('evicts semantic forecast entries beyond 256 while refreshing recently used entries', () => {
    const expansion = vi.spyOn(tasks, 'expandRecurrenceReferences');
    const entry = (duration: number, line = duration) =>
      rootSource('bounded', {
        line,
        recurrence: 'every day',
        planning: { due: localDate('2057-01-01'), duration: durationMinutes(duration) },
      });
    const visible = range('2057-01-02', '2057-01-02');
    for (let index = 1; index <= 256; index++)
      project({ recurringSources: [entry(index)] }, visible);
    expect(expansion).toHaveBeenCalledTimes(256);
    project({ recurringSources: [entry(1, 900)] }, visible);
    expect(expansion).toHaveBeenCalledTimes(256);
    project({ recurringSources: [entry(257)] }, visible);
    project({ recurringSources: [entry(1)] }, visible);
    expect(expansion).toHaveBeenCalledTimes(257);
    project({ recurringSources: [entry(2)] }, visible);
    expect(expansion).toHaveBeenCalledTimes(258);
    for (let index = 258; index <= 300; index++)
      project({ recurringSources: [entry(index)] }, visible);
    project({ recurringSources: [entry(3)] }, visible);
    expect(expansion).toHaveBeenCalledTimes(302);
  });
});

it('retains exact date roles for real ordinary child and root points', () => {
  const text =
    '- [ ] Root 🛫 2026-10-08\n  - [ ] Start only 🛫 2026-10-08\n  - [ ] Timed ⏳ 2026-10-08 ⏰ 09:00 ⏱️ 1h\n  - [ ] Inverted 🛫 2026-10-10 📅 2026-10-08 ⏳ 2026-10-10';
  const statusCatalog = canonicalStatusCatalog();
  const root = expectDefined(
    projectTaskSnapshot({
      codec: new TaskMarkdownCodec(statusCatalog),
      statusCatalog,
      filePath: 'Tasks.md',
      lines: text.split('\n'),
      line: 0,
      exactBlock: text,
      ref: { filePath: 'Tasks.md', line: 0, revision: 'old' },
      presentation: { linkCount: 0 },
      offsetAt: () => 0,
    }),
  );
  const sources: CalendarTaskSource[] = [
    source(root),
    ...root.subtasks.map((node) => ({
      root,
      node,
      target: { type: 'subtask' as const, ref: node.ref },
    })),
  ];
  expect(root.subtasks[1]?.planning).toMatchObject({ duration: 60 });
  const result = project({ materialized: sources }, range('2026-10-08', '2026-10-10'));
  expect(result.occurrences).toHaveLength(5);
  for (const title of ['Root', 'Start only']) {
    const occurrence = expectDefined(
      result.occurrences.find((value) => value.source.node.title === title),
    );
    expect(occurrence).toMatchObject({
      occupied: { kind: 'point', date: '2026-10-08', roles: ['start'] },
    });
    const display = taskSnapshotForCalendarOccurrence(occurrence);
    const spanPlanning = { ...display.planning, due: localDate('2026-10-09') };
    const ordinaryPreview = calendarTaskWithPlanning(display, spanPlanning);
    const spanPreview = calendarTaskWithPlanning(display, spanPlanning, 'create-span');
    expect(calendarOccurrenceForTask(ordinaryPreview)).toMatchObject({
      occupied: { kind: 'point' },
    });
    const promoted = expectDefined(calendarOccurrenceForTask(spanPreview));
    expect(promoted).toMatchObject({
      occupied: { kind: 'interval', start: '2026-10-08', due: '2026-10-09' },
    });
    expect(promoted.source).toBe(occurrence.source);
    expect(promoted.key).toBe(occurrence.key);
    expect(calendarOccurrenceForTask(display)).toBe(occurrence);
    const invalid = calendarTaskWithPlanning(
      display,
      { ...spanPlanning, due: localDate('2026-10-07') },
      'create-span',
    );
    expect(calendarOccurrenceForTask(invalid)).toMatchObject({ occupied: { kind: 'point' } });

    expect(
      calendarPointPatchCommand(
        taskSnapshotForCalendarOccurrence(occurrence),
        localDate('2026-10-09'),
      ),
    ).toEqual({
      type: 'patch',
      target: occurrence.source.target,
      patch: { start: { type: 'set', value: '2026-10-09' } },
    });
  }
  const inverted = expectDefined(
    result.occurrences.find(
      (value) =>
        value.source.node.title === 'Inverted' &&
        value.kind === 'materialized' &&
        value.occupied.kind === 'point' &&
        value.occupied.date === '2026-10-10',
    ),
  );
  expect(
    calendarPointPatchCommand(taskSnapshotForCalendarOccurrence(inverted), localDate('2026-10-07')),
  ).toEqual({
    type: 'patch',
    target: inverted.source.target,
    patch: {
      start: { type: 'set', value: '2026-10-07' },
      scheduled: { type: 'set', value: '2026-10-07' },
    },
  });
  const preview = calendarTaskWithPlanning(taskSnapshotForCalendarOccurrence(inverted), {
    ...inverted.planning,
    start: localDate('2026-10-07'),
    scheduled: localDate('2026-10-07'),
  });
  expect(calendarOccurrenceForTask(preview)).toMatchObject({
    occupied: { kind: 'point', date: '2026-10-07', roles: ['start', 'scheduled'] },
  });
  expect(calendarShiftScheduleCommand(taskSnapshotForCalendarOccurrence(inverted), -3)).toEqual({
    type: 'patch',
    target: inverted.source.target,
    patch: {
      start: { type: 'set', value: '2026-10-07' },
      scheduled: { type: 'set', value: '2026-10-07' },
    },
  });
});
