import { beforeAll, describe, expect, it } from 'vitest';
import {
  prepareStatisticsDataset,
  STATISTICS_VIEWS,
  StatisticsSession,
  type StatisticsDataset,
  type StatisticsViewId,
  type StatisticsViewModel,
} from '../src/statistics';
import { required } from '../src/statistics/statisticsWork';
import { request, work } from './helpers/statisticsFixtures';
import {
  scaleNodeKey,
  scaleProjects,
  scaleTransitions,
  statisticsScaleFixture,
} from './helpers/statisticsScaleFixtures';

function metric(view: StatisticsViewModel, id: string): number | null | undefined {
  if (id.startsWith('new-'))
    return chart(view, 'new-outcomes').marks.find((mark) => mark.key === id)?.weight;
  return view.sections.flatMap((section) => section.metrics).find((value) => value.id === id)
    ?.value;
}
function chart(view: StatisticsViewModel, id: string) {
  return required(
    view.sections.flatMap((section) => section.charts).find((value) => value.id === id),
  );
}
function pageChecks(view: StatisticsViewModel, id: string, total: number): void {
  const seen = new Set<string>();
  for (const offset of [...new Set([0, 50, 100, total - (total % 50 === 0 ? 50 : total % 50)])]) {
    if (offset < 0 || offset >= total) continue;
    const page = view.evidence(id, offset, 500);
    expect(page.total).toBe(total);
    expect(page.rows.length).toBeLessThanOrEqual(50);
    for (const row of page.rows) {
      expect(seen.has(row.key)).toBe(false);
      seen.add(row.key);
    }
    if (offset + 50 >= total) expect(page.nextOffset).toBeUndefined();
  }
  expect(view.evidence(id, total, 50)).toMatchObject({ total, rows: [], nextOffset: undefined });
}
function exhaust(view: StatisticsViewModel, id: string, expected: Set<string>): void {
  const found = new Set<string>();
  let offset: number | undefined = 0;
  while (offset !== undefined) {
    const page = view.evidence(id, offset, 50);
    expect(page.total).toBe(expected.size);
    for (const row of page.rows) {
      expect(found.has(row.key)).toBe(false);
      found.add(row.key);
    }
    offset = page.nextOffset;
  }
  expect(found).toEqual(expected);
}

describe.each([
  {
    n: 1000,
    m: 100,
    entries: 3000,
    minutes: 998000,
    created: 700,
    completed: 400,
    cancelled: 100,
    sessions: 2100,
  },
  {
    n: 10000,
    m: 1000,
    entries: 30000,
    minutes: 9980000,
    created: 7000,
    completed: 4000,
    cancelled: 1000,
    sessions: 21000,
  },
  {
    n: 100000,
    m: 10000,
    entries: 300000,
    minutes: 99800000,
    created: 70000,
    completed: 40000,
    cancelled: 10000,
    sessions: 210000,
  },
])(
  'exact physical evidence at N=$n',
  ({ n, m, entries, minutes, created, completed, cancelled, sessions }) => {
    const fixture = statisticsScaleFixture(n);
    let chunks = 0;
    const measured = {
      ...work,
      yieldControl: async () => {
        chunks++;
      },
    };
    let ds: StatisticsDataset;
    let session: StatisticsSession;
    const views = new Map<StatisticsViewId, StatisticsViewModel>();
    beforeAll(async () => {
      expect(fixture.files).toHaveLength(4);
      expect(required(fixture.files[3]).roots).toHaveLength(2 * m);
      expect(fixture.files.reduce((sum, file) => sum + file.roots.length, 0)).toBe(9 * m);
      ds = required(await prepareStatisticsDataset(fixture, scaleProjects, measured));
      expect(ds.coverage).toMatchObject({
        nodes: n,
        entries,
        live: 8 * m,
        archive: 2 * m,
        dateIssues: m,
        brokenEntries: 0,
        ready: true,
      });
      expect(new Set(ds.tasks.map((task) => task.key)).size).toBe(n);
      expect(new Set(ds.entries.map((entry) => entry.key)).size).toBe(entries);
      expect(ds.tasks.filter((task) => task.recurring)).toHaveLength(2 * m);
      expect(ds.tasks.every((task) => task.tags.length === (task.priority === 'A' ? 2 : 1))).toBe(
        true,
      );
      expect(chunks).toBeGreaterThanOrEqual(Math.floor((n + entries) / 1000));
      session = new StatisticsSession(ds);
    });
    const get = async (view: StatisticsViewId, options: Parameters<typeof request>[0] = {}) =>
      required(
        await session.view(
          request({ period: 'week', calendarTransitions: scaleTransitions, view, ...options }),
          measured,
        ),
      );
    const v = (id: StatisticsViewId) => required(views.get(id));
    it('rhythm retains exact totals and physical evidence', async () => {
      views.set('rhythm', await get('rhythm'));
      const rhythm = v('rhythm');
      expect(
        [
          'created',
          'completed',
          'cancelled',
          'open-now',
          'new-open',
          'new-done',
          'new-cancelled',
        ].map((id) => metric(rhythm, id)),
      ).toEqual([created, completed, cancelled, 4 * m, 2 * m, 3 * m, m]);
      const eventMarks = chart(rhythm, 'rhythm').marks;
      expect(
        eventMarks
          .filter((mark) => mark.series?.startsWith('created') === true)
          .reduce((sum, mark) => sum + Number(mark.weight), 0),
      ).toBe(created);
      for (const [index, value] of [3, 1, 2, 1, 0, 0, 0].entries()) {
        expect(
          eventMarks
            .filter((mark) => mark.key === `created:${index}`)
            .reduce((sum, mark) => sum + Number(mark.weight), 0),
        ).toBe(value * m);
      }
      pageChecks(rhythm, 'created:2', 2 * m);
      exhaust(
        rhythm,
        'created:2',
        new Set(
          Array.from({ length: m }, (_, j) => [scaleNodeKey(j, 4), scaleNodeKey(j, 5)]).flat(),
        ),
      );
      pageChecks(rhythm, 'age:unknown', m);
      expect(
        rhythm.evidence('age:unknown', 0, 50).rows.every((row) => row.title === 'Role 7'),
      ).toBe(true);
    });
    it('completion retains exact totals and physical evidence', async () => {
      views.set('completion', await get('completion'));
      const completion = v('completion');
      expect(
        ['valid-pairs', 'missing-pairs', 'median', 'p90'].map((id) => metric(completion, id)),
      ).toEqual([3 * m, 0, 5, 29]);
      expect(chart(completion, 'completion-age').marks.map((mark) => mark.y)).toEqual([
        0,
        0,
        m,
        m,
        0,
        m,
        0,
        0,
      ]);
      pageChecks(completion, 'completion-age:3', m);
      expect(
        completion
          .evidence('completion-age:3', 0, 50)
          .rows.every((row) => row.fileKind === 'archive' && row.title === 'Role 8'),
      ).toBe(true);
    });
    it('deadlines retains exact totals and physical evidence', async () => {
      views.set('deadlines', await get('deadlines'));
      const deadlines = v('deadlines');
      expect(
        ['on-time', 'late', 'overdue', 'upcoming', 'cancelled', 'unknown'].map((id) =>
          metric(deadlines, id),
        ),
      ).toEqual([m, 3 * m, m, 2 * m, m, 0]);
      expect(chart(deadlines, 'due-delta').marks.map((mark) => mark.y)).toEqual([
        0,
        0,
        m,
        3 * m,
        0,
        0,
        0,
        0,
      ]);
      pageChecks(deadlines, 'deadline:overdue', m);
      pageChecks(deadlines, 'deadline:archived-open', m);
    });
    it('cohorts retains exact totals and physical evidence', async () => {
      views.set('cohorts', await get('cohorts'));
      const cohort = chart(v('cohorts'), 'cohorts').marks;
      expect(cohort.map((mark) => mark.denominator)).toEqual([5 * m, 5 * m, 5 * m, 5 * m, 5 * m]);
      expect(cohort.map((mark) => mark.state)).toEqual([
        'measured',
        'immature',
        'immature',
        'immature',
        'immature',
      ]);
      expect(required(cohort[0]).weight).toBe(0);
    });
    it('allocation retains exact totals and physical evidence', async () => {
      views.set('allocation', await get('allocation'));
      const allocation = v('allocation');
      expect(metric(allocation, 'recorded-minutes')).toBe(minutes);
      expect(
        Object.fromEntries(
          chart(allocation, 'allocation-ranking:project').marks.map((mark) => [
            mark.key,
            mark.weight,
          ]),
        ),
      ).toEqual({
        'archive:unknown': 9475 * m,
        'project:projects/alpha.md': 404 * m,
        'project:projects/beta.md': 50.5 * m,
        unassigned: 50.5 * m,
      });
      const focused = await get('allocation', { focusKey: 'project:projects/beta.md' });
      const buckets = chart(focused, 'allocation-focus').marks;
      expect(buckets.map((mark) => mark.weight)).toEqual([24 * m, 0, 0, 8 * m, 8 * m, 0, 10.5 * m]);
      for (const [index, count] of [
        [0, 0.8 * m],
        [3, 0.8 * m],
        [4, 0.8 * m],
        [6, 0.7 * m],
      ]) {
        const id = required(required(buckets[required(index)]).selectionId);
        pageChecks(focused, id, required(count));
        expect(
          focused.evidence(id, 0, 50).rows.every((row) => row.filePath === 'projects/beta.md'),
        ).toBe(true);
      }
      expect(metric(allocation, 'task-denominator')).toBe(n);
      const share = chart(allocation, 'time-share').marks;
      expect(share.map((mark) => mark.x)).toEqual([0, 10, 90, 100]);
      expect(Number(required(share[1]).y) / 100).toBeCloseTo(941 / 998, 12);
      expect(Number(required(share[2]).y) / 100).toBeCloseTo(993 / 998, 12);
    });
    it('timeline retains exact totals and physical evidence', async () => {
      views.set('timeline', await get('timeline'));
      const timeline = v('timeline');
      expect([metric(timeline, 'recorded-minutes'), metric(timeline, 'week-minutes')]).toEqual([
        minutes,
        minutes,
      ]);
      expect(Array.from({ length: 7 }, (_, day) => metric(timeline, `day:${day}`))).toEqual(
        [1740, 1440, 1440, 1540, 1540, 1440, 840].map((amount) => amount * m),
      );
      expect(chart(timeline, 'timeline').layout).toBe('density');
      expect(chart(timeline, 'timeline').marks.length).toBeLessThanOrEqual(168);
      for (const [day, population] of [11, 1, 1, 11, 11, 1, 9].entries())
        pageChecks(timeline, `day-time:${day}`, population * m);
      pageChecks(timeline, 'week-time', 29 * m);
    });
    it('sessions retains exact totals and physical evidence', async () => {
      views.set('sessions', await get('sessions'));
      const sessionView = v('sessions');
      expect(
        ['session-count', 'median', 'p90', 'recorded-changes'].map((id) => metric(sessionView, id)),
      ).toEqual([sessions, 20, 30, 0]);
      expect(chart(sessionView, 'session-lengths').marks.map((mark) => mark.y)).toEqual([
        m,
        0,
        0,
        2 * n,
        0,
        0,
        0,
        0,
      ]);
      // Twenty-minute entries belong in the >15–30 interval along with thirty-minute entries.
    });
    it('patterns retains exact totals and physical evidence', async () => {
      views.set('patterns', await get('patterns'));
      const patterns = chart(v('patterns'), 'patterns').marks;
      expect(patterns.filter((mark) => mark.state === 'unavailable')).toHaveLength(12);
      expect(patterns.reduce((sum, mark) => sum + (mark.numerator ?? 0), 0)).toBe(minutes);
      expect(patterns.reduce((sum, mark) => sum + (mark.denominator ?? 0), 0)).toBe(156);
      const hourlyExceptions: Record<string, number> = {
        'Mon:9': 360,
        'Thu:23': 160,
        'Fri:0': 160,
        'Sun:11': 180,
      };
      for (const mark of patterns.filter((mark) => mark.state !== 'unavailable'))
        expect(mark.weight).toBe((hourlyExceptions[`${mark.y}:${mark.x}`] ?? 60) * m);
    });
    it.each([
      ['Mon', 9, 11],
      ['Tue', 9, 1],
      ['Sun', 11, 9],
    ] as const)(
      'pages exact Patterns %s hour %i physical sources',
      async (day, hour, population) => {
        const view = await get('patterns');
        const mark = required(
          chart(view, 'patterns').marks.find((mark) => mark.x === hour && mark.y === day),
        );
        pageChecks(view, required(mark.selectionId), population * m);
      },
    );
    it('movement retains exact totals and physical evidence', async () => {
      views.set('movement', await get('movement'));
      const movement = v('movement');
      expect(
        ['completion-origin:before', 'completion-origin:new', 'completion-origin:unknown'].map(
          (id) => metric(movement, id),
        ),
      ).toEqual([m, 3 * m, 0]);
      const movementCharts = required(movement.sections[0]).charts;
      for (const [key, values] of [
        ['project:projects/alpha.md', [4.8, 2.4, 0.8]],
        ['project:projects/beta.md', [0.6, 0.3, 0.1]],
        ['unassigned', [0.6, 0.3, 0.1]],
        ['archive:unknown', [1, 1, 0]],
      ] as const) {
        const marks = required(movementCharts.find((item) => item.facet?.key === key)).marks;
        expect(
          ['created', 'completed', 'cancelled'].map(
            (series) => marks.find((mark) => mark.series === series && mark.x === 7)?.y ?? 0,
          ),
        ).toEqual(values.map((value) => value * m));
        expect(
          marks
            .filter((mark) => mark.x === 0)
            .every((mark) => mark.y === 0 && mark.selectionId === undefined),
        ).toBe(true);
      }
    });
    it('aging retains exact totals and physical evidence', async () => {
      views.set('aging', await get('aging'));
      const aging = v('aging');
      expect([metric(aging, 'open-now'), metric(aging, 'unknown-age')]).toEqual([4 * m, m]);
      expect(
        required(aging.sections[0]?.charts[0]).marks.map((mark) => [
          mark.x,
          mark.y,
          mark.weight,
          mark.overdue,
        ]),
      ).toEqual([
        [6, 65, m, m],
        [5, 65, m, 0],
        [4, 65, m, 0],
      ]);
    });
    it('dependencies retains exact totals and physical evidence', async () => {
      views.set('dependencies', await get('dependencies'));
      const dependencies = await get('dependencies', { focusKey: scaleNodeKey(0, 0) });
      expect(
        ['direct', 'downstream', 'sole', 'chain-edges'].map((id) => metric(dependencies, id)),
      ).toEqual([2, 3, 2, 4]);
      expect(chart(dependencies, 'dependency-chain').marks).toHaveLength(4);
      expect(metric(dependencies, 'waiting')).toBe(3 * m);
      const priority = await get('dependencies', {
        focusKey: scaleNodeKey(0, 0),
        scope: { type: 'priority', priority: 'B' },
      });
      expect(['direct', 'downstream', 'sole'].map((id) => metric(priority, id))).toEqual([1, 2, 1]);
      const tags = await get('allocation', { group: 'tag' });
      expect(
        chart(tags, 'allocation-ranking:tag')
          .marks.map((mark) => mark.weight)
          .sort((a, b) => (a ?? 0) - (b ?? 0)),
      ).toEqual([325 * m, minutes]);
      const archive = await get('aging', { scope: { type: 'archive' } });
      expect(metric(archive, 'open-now')).toBe(0);
      expect(archive.coverage.scope.nodes).toBe(2 * m);
    });
    it('warm switching retains exact totals and physical evidence', async () => {
      const before = chunks;
      for (let i = 0; i < 30; i++) {
        const id = required(STATISTICS_VIEWS[i % STATISTICS_VIEWS.length]).id;
        await get(id);
      }
      // Return once to replace intentional scope/group/focus variants, then require zero warm work.
      const warmChunks = chunks;
      for (const { id } of STATISTICS_VIEWS) {
        const a = await get(id);
        expect(await get(id)).toBe(a);
      }
      expect(chunks).toBe(warmChunks);
      expect(chunks).toBeGreaterThanOrEqual(before);
      expect(session['cache'].size).toBeLessThanOrEqual(11);
    });
  },
);
