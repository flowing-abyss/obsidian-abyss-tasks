import { expect, it } from 'vitest';
import { prepareStatisticsDataset } from '../src/statistics/statisticsDataset';
import { StatisticsSession } from '../src/statistics/statisticsSession';
import { required } from '../src/statistics/statisticsWork';
import type { StatisticsViewId } from '../src/statistics/types';
import { closed, date, request, source, task, work } from './helpers/statisticsFixtures';
it('caches identical requests but invalidates exact as-of, scope and transition identity', async () => {
  const ds = await prepareStatisticsDataset(
    source([
      task('A', {
        timeEntries: [
          {
            state: 'running',
            startMs: Date.parse('2026-10-04T09:00Z'),
            relativeLine: 1,
            originalMarkdown: 'running',
          },
        ],
      }),
    ]),
    [],
    work,
  );
  const session = new StatisticsSession(required(ds)),
    r = request({ view: 'allocation' });
  const first = await session.view(r, work);
  expect(await session.view(r, work)).toBe(first);
  expect(await session.view({ ...r, nowMs: r.nowMs + 1 }, work)).not.toBe(first);
  expect(await session.view({ ...r, scope: { type: 'archive' } }, work)).not.toBe(first);
  expect(await session.view({ ...r, calendarTransitions: [] }, work)).not.toBe(first);
});
it('yields/cancels node and entry normalization and cold aggregation', async () => {
  const nodes = Array.from({ length: 3000 }, (_, i) =>
    task(`N${i}`, { planning: { created: date('2026-10-01') } }),
  );
  let cancelled = false,
    yields = 0;
  const port = {
    yieldControl: async () => {
      yields++;
      cancelled = true;
    },
    isCancelled: () => cancelled,
  };
  expect(await prepareStatisticsDataset(source(nodes), [], port)).toBeUndefined();
  expect(yields).toBe(1);
  cancelled = false;
  const ds = await prepareStatisticsDataset(source(nodes), [], work);
  expect(await new StatisticsSession(required(ds)).view(request(), port)).toBeUndefined();
  const many = task('many', {
    timeEntries: Array.from({ length: 2001 }, (_, i) =>
      closed('2026-10-04T09:00Z', '2026-10-04T10:00Z', i + 1),
    ),
  });
  cancelled = false;
  expect(await prepareStatisticsDataset(source([many]), [], port)).toBeUndefined();
});
it('excludes ambiguous first date carriers without losing current physical children or recurrence', async () => {
  const root = task('root', { recurrence: 'every day', planning: { created: date('2026-10-01') } });
  const child = task('child', { planning: { created: date('2026-10-02') } });
  const nested = {
    ...child,
    ref: {
      parent: { type: 'task' as const, ref: root.ref },
      relativeLine: 1,
      originalBlock: 'child',
    },
  };
  const s = source([{ ...root, subtasks: [nested] }]);
  const ds = await prepareStatisticsDataset(
    {
      ...s,
      files: s.files.map((f) => ({
        ...f,
        dateIssues: [{ line: 0, field: 'created' as const, reason: 'ambiguous-date' as const }],
      })),
    },
    [],
    work,
  );
  expect(required(ds).tasks).toHaveLength(2);
  expect(required(ds).tasks.map((t) => t.recurring)).toEqual([true, true]);
  expect(required(required(ds).tasks[0]).created).toBeUndefined();
  expect(required(required(ds).tasks[1]).created).toBe('2026-10-02');
  const v = await new StatisticsSession(required(ds)).view(request(), work);
  expect(required(v).evidence('created', 0, 50).total).toBe(1);
  expect(required(v).evidence('open-now', 0, 50).total).toBe(2);
  const cohorts = required(
    await new StatisticsSession(required(ds)).view(request({ view: 'cohorts' }), work),
  );
  expect(cohorts.sections[0]?.charts[0]?.marks).toEqual([]);
  expect(
    cohorts.sections[0]?.metrics
      .filter((metric) => metric.role === 'coverage')
      .every((metric) => metric.value === 0),
  ).toBe(true);
});
it('reuses calendar preparation when only a view changes', async () => {
  let probes = 0;
  const offsetAt = (): number => {
    probes++;
    return 0;
  };
  const ds = await prepareStatisticsDataset(
    source([task('old', { planning: { created: date('1900-01-01') } })]),
    [],
    work,
  );
  const session = new StatisticsSession(required(ds)),
    r = request({ period: 'all', offsetAt });
  await session.view(r, work);
  const first = probes;
  await session.view({ ...r, view: 'completion' }, work);
  expect(probes - first).toBe(0);
});
it('separates scoped retained counts from global source readiness and issues', async () => {
  const live = task('live', {
      tags: ['selected'],
      timeEntries: [closed('2026-10-04T09:00Z', '2026-10-04T10:00Z')],
    }),
    archive = task('archive', {
      timeEntries: [{ state: 'broken', relativeLine: 1, originalMarkdown: 'broken' }],
    });
  const original = source([live], [archive]);
  const snapshot = { ...original, issues: [{ path: 'unread.md', reason: 'read-failed' as const }] };
  const ds = required(await prepareStatisticsDataset(snapshot, [], work)),
    session = new StatisticsSession(ds);
  const a = required(await session.view(request({ scope: { type: 'archive' } }), work)),
    t = required(await session.view(request({ scope: { type: 'tag', tag: 'selected' } }), work));
  expect(a.coverage.source.nodes).toBe(2);
  expect(a.coverage.source.sourceIssues).toHaveLength(1);
  expect(a.coverage.scope).toEqual({
    nodes: 1,
    live: 0,
    archive: 1,
    entries: 1,
    brokenEntries: 1,
    dateIssues: 0,
  });
  expect(t.coverage.scope.nodes).toBe(1);
  expect(t.coverage.scope.live).toBe(1);
  expect(t.coverage.source.sourceIssues).toHaveLength(1);
  expect(a.evidence('open-now', 0, 50).total).toBe(0);
});
it('reconciles all eleven views against the independent ten-role retained-evidence oracle', async () => {
  const created = [
    '2026-09-28',
    '2026-09-29',
    '2026-09-28',
    '2026-09-01',
    '2026-09-30',
    '2026-09-30',
    '2026-10-01',
    '2026-09-28',
    '2026-09-28',
    undefined,
  ];
  const due = [
    '2026-10-03',
    '2026-10-04',
    '2026-10-01',
    '2026-09-29',
    undefined,
    '2026-10-01',
    '2026-10-02',
    '2026-10-04',
    '2026-10-02',
    '2026-10-03',
  ];
  const completion = [
    undefined,
    undefined,
    '2026-10-01',
    '2026-09-30',
    undefined,
    '2026-10-02',
    undefined,
    undefined,
    '2026-10-03',
    undefined,
  ];
  const nodes = Array.from({ length: 10 }, (_, i) =>
    task(`role${i}`, {
      ref: { filePath: i < 8 ? 'alpha.md' : 'archive.md', line: i * 10, revision: '1' },
      status: required(
        (
          [
            'open',
            'in-progress',
            'done',
            'done',
            'open',
            'done',
            'cancelled',
            'open',
            'done',
            'open',
          ] as const
        )[i],
      ),
      planning: {
        ...(created[i] === undefined ? {} : { created: date(required(created[i])) }),
        ...(due[i] === undefined ? {} : { due: date(required(due[i])) }),
        ...(completion[i] === undefined ? {} : { completion: date(required(completion[i])) }),
        ...(i === 6 ? { cancelled: date('2026-10-03') } : {}),
      },
      tags: i % 2 === 0 ? ['Common', 'Red', 'RED'] : ['Common'],
      timeEntries: [
        closed('2026-09-28T09:00Z', '2026-09-28T09:30Z'),
        closed('2026-10-01T23:50Z', '2026-10-02T00:10Z', 2),
        oracleLastEntry(i),
      ],
    }),
  );
  const root = required(nodes[4]);
  nodes[4] = {
    ...root,
    recurrence: 'every day',
    dependencyId: 'C',
    dependsOn: ['A'],
    subtasks: [
      {
        ...required(nodes[5]),
        ref: { parent: { type: 'task', ref: root.ref }, relativeLine: 4, originalBlock: 'child' },
      },
    ],
  };
  nodes[0] = { ...required(nodes[0]), dependencyId: 'A' };
  nodes[1] = { ...required(nodes[1]), dependencyId: 'B', dependsOn: ['A'] };
  nodes[7] = { ...required(nodes[7]), dependsOn: ['B', 'C'] };
  const ds = required(
    await prepareStatisticsDataset(
      {
        revision: 1,
        ready: true,
        issues: [],
        files: [
          {
            path: 'alpha.md',
            kind: 'live',
            revision: 1,
            roots: nodes.slice(0, 8).filter((_, i) => i !== 5),
            dateIssues: [{ line: 70, field: 'created', reason: 'ambiguous-date' }],
          },
          {
            path: 'archive.md',
            kind: 'archive',
            revision: 1,
            roots: nodes.slice(8),
            dateIssues: [],
          },
        ],
      },
      [{ path: 'alpha.md', name: 'Same name' }],
      work,
    ),
  );
  const session = new StatisticsSession(ds);
  const get = async (view: StatisticsViewId) =>
    required(await session.view(request({ view, period: 'week', calendarTransitions: [] }), work));
  const rhythm = await get('rhythm');
  const m = (v: typeof rhythm, id: string) =>
    v.sections.flatMap((s) => s.metrics).find((value) => value.id === id)?.value;
  expect([
    m(rhythm, 'created'),
    m(rhythm, 'completed'),
    m(rhythm, 'cancelled'),
    m(rhythm, 'new-open'),
    m(rhythm, 'open-now'),
  ]).toEqual([7, 4, 1, 3, 4]);
  const complete = await get('completion');
  expect([m(complete, 'valid-pairs'), m(complete, 'median'), m(complete, 'p90')]).toEqual([
    3, 5, 29,
  ]);
  const deadlines = await get('deadlines');
  expect(
    ['on-time', 'late', 'overdue', 'upcoming', 'cancelled', 'unknown'].map((id) =>
      m(deadlines, id),
    ),
  ).toEqual([1, 3, 2, 2, 1, 0]);
  const cohorts = await get('cohorts'),
    cells = required(required(cohorts.sections[0]).charts[0]).marks;
  expect(cells.map((cell) => cell.denominator)).toEqual([5, 5, 5, 5, 5]);
  expect(required(cells[0]).weight).toBe(0);
  expect(required(cells[1]).state).toBe('immature');
  const allocation = await get('allocation');
  expect(m(allocation, 'recorded-minutes')).toBe(9980);
  expect(required(allocation.sections[0]).legend.map((item) => item.value)).toEqual([9475, 505]);
  const timeline = await get('timeline');
  expect(m(timeline, 'week-minutes')).toBe(9980);
  expect([0, 1, 2, 3, 4, 5, 6].map((day) => m(timeline, `day:${day}`))).toEqual([
    1740, 1440, 1440, 1540, 1540, 1440, 840,
  ]);
  const sessions = await get('sessions');
  expect([
    m(sessions, 'session-count'),
    m(sessions, 'median'),
    m(sessions, 'p90'),
    m(sessions, 'recorded-changes'),
  ]).toEqual([21, 20, 30, 0]);
  const patterns = await get('patterns'),
    heatmap = required(required(patterns.sections[0]).charts[0]).marks;
  expect(heatmap.reduce((sum, mark) => sum + (mark.numerator ?? 0), 0)).toBe(9980);
  expect(heatmap.reduce((sum, mark) => sum + (mark.denominator ?? 0), 0)).toBe(156);
  expect(heatmap.find((mark) => mark.x === 9 && mark.y === 'Mon')?.weight).toBe(360);
  const movement = await get('movement');
  expect([
    m(movement, 'completion-origin:before'),
    m(movement, 'completion-origin:new'),
    m(movement, 'completion-origin:unknown'),
  ]).toEqual([1, 3, 0]);
  const aging = await get('aging');
  expect([m(aging, 'open-now'), m(aging, 'unknown-age')]).toEqual([4, 1]);
  expect(
    required(required(aging.sections[0]).charts[0]).marks.map((mark) => [
      mark.x,
      mark.y,
      mark.weight,
    ]),
  ).toEqual([
    [6, 65, 1],
    [5, 65, 1],
    [4, 65, 1],
  ]);
  const dependencies = required(
    await session.view(
      request({
        view: 'dependencies',
        period: 'week',
        calendarTransitions: [],
        focusKey: required(ds.tasks[0]).key,
      }),
      work,
    ),
  );
  expect([
    m(dependencies, 'direct'),
    m(dependencies, 'downstream'),
    m(dependencies, 'sole'),
  ]).toEqual([2, 3, 2]);
});

function oracleLastEntry(role: number): ReturnType<typeof closed> {
  if (role === 9) return closed('1926-10-04T12:00Z', '2026-10-04T12:00Z', 3);
  return closed('2026-10-04T11:45Z', role === 7 ? '2026-10-04T11:45Z' : '2026-10-04T12:15Z', 3);
}
