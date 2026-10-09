import { expect, it } from 'vitest';
import { prepareStatisticsDataset } from '../src/statistics/statisticsDataset';
import { StatisticsSession } from '../src/statistics/statisticsSession';
import { required } from '../src/statistics/statisticsWork';
import type { StatisticsRequest, StatisticsViewModel } from '../src/statistics/types';
import { closed, date, request, source, task, work } from './helpers/statisticsFixtures';
const value = (v: StatisticsViewModel, id: string) =>
  v.sections.flatMap((s) => s.metrics).find((m) => m.id === id)?.value;
async function views(
  tasks: Parameters<typeof source>[0],
  options: Partial<StatisticsRequest> = {},
) {
  const ds = await prepareStatisticsDataset(source(tasks), [], work);
  const session = new StatisticsSession(required(ds));
  return {
    get: async (view: StatisticsRequest['view']) =>
      required(await session.view(request({ ...options, view }), work)),
  };
}
it('conserves midnight clipping and separates start-cohort sessions', async () => {
  const v = await views(
    [task('midnight', { timeEntries: [closed('2026-09-30T23:50Z', '2026-10-01T00:20Z')] })],
    { period: 'today', nowMs: Date.parse('2026-10-01T12:00Z') },
  );
  for (const name of ['allocation', 'timeline', 'patterns'] as const)
    expect(value(await v.get(name), 'recorded-minutes')).toBe(20);
  expect(value(await v.get('sessions'), 'session-count')).toBe(0);
  const pattern = await v.get('patterns');
  const mark = required(
    required(required(pattern.sections[0]).charts[0]).marks.find((m) => m.x === 0 && m.y === 'Thu'),
  );
  expect(mark.numerator).toBe(20);
  expect(
    required(pattern.evidence(required(mark.selectionId), 0, 50).rows[0]).contributionMinutes,
  ).toBe(20);
});
it('keeps century and >400-day intervals clipped in their middle', async () => {
  const v = await views([task('century', { timeEntries: [closed('1900-01-01', '2000-01-01')] })], {
    period: 'today',
    nowMs: Date.parse('1950-06-01T12:00Z'),
    calendarTransitions: [],
  });
  expect(value(await v.get('allocation'), 'recorded-minutes')).toBe(720);
  const pattern = await v.get('patterns');
  expect(
    required(required(pattern.sections[0]).charts[0])
      .marks.filter((m) => m.denominator !== 0)
      .every((m) => m.weight === 60),
  ).toBe(true);
});
it.each([
  { day: '2026-03-29', before: 0, after: 60, total: 1380, hourMinutes: 0, exposure: 0 },
  { day: '2026-10-25', before: 60, after: 0, total: 1500, hourMinutes: 120, exposure: 2 },
] as const)(
  'conserves DST exposure on %s',
  async ({ day, before, after, total, hourMinutes, exposure }) => {
    const transition = Date.parse(`${day}T01:00Z`),
      offsetAt = (ms: number) => (ms < transition ? before : after);
    const start = day === '2026-03-29' ? '2026-03-29T00:00Z' : '2026-10-24T23:00Z',
      end = day === '2026-03-29' ? '2026-03-29T23:00Z' : '2026-10-26T00:00Z';
    const v = await views([task('continuous', { timeEntries: [closed(start, end)] })], {
      period: 'today',
      nowMs: Date.parse(end) - 1,
      offsetAt,
    });
    const p = await v.get('patterns');
    expect(value(p, 'recorded-minutes')).toBeCloseTo(total - 1 / 60000);
    const cell = required(
      required(required(p.sections[0]).charts[0]).marks.find((m) => m.x === 1 && m.y === 'Sun'),
    );
    expect(cell.numerator).toBe(hourMinutes);
    expect(cell.denominator).toBe(exposure);
    expect(cell.weight).toBe(exposure === 0 ? undefined : 60);
  },
);
it('clips running/future-ended entries and keeps zero sessions without false timeline spans', async () => {
  const v = await views(
    [
      task('entries', {
        timeEntries: [
          {
            state: 'running',
            startMs: Date.parse('2026-10-04T10:10Z'),
            relativeLine: 1,
            originalMarkdown: 'running',
          },
          closed('2026-10-04T09:00Z', '2026-10-04T11:00Z', 2),
          closed('2026-10-04T08:00Z', '2026-10-04T08:00Z', 3),
          { state: 'broken', relativeLine: 4, originalMarkdown: 'broken' },
        ],
      }),
    ],
    { period: 'today', nowMs: Date.parse('2026-10-04T10:30Z') },
  );
  expect(value(await v.get('allocation'), 'recorded-minutes')).toBe(110);
  const s = await v.get('sessions');
  expect(value(s, 'session-count')).toBe(1);
  expect(s.evidence('sessions', 0, 50).total).toBe(1);
  expect(value(s, 'median')).toBe(0);
  expect(required(required((await v.get('timeline')).sections[0]).charts[0]).marks).toHaveLength(2);
});
it('counts overlapping owners and normalized tags without double-counting grand totals', async () => {
  const v = await views(
    [
      task('A', {
        tags: ['Work', 'work', 'Home'],
        timeEntries: [closed('2026-10-04T09:00Z', '2026-10-04T10:00Z')],
      }),
      task('B', { timeEntries: [closed('2026-10-04T09:30Z', '2026-10-04T10:30Z')] }),
    ],
    { period: 'today', group: 'tag' },
  );
  const a = await v.get('allocation');
  expect(value(a, 'recorded-minutes')).toBe(120);
  expect(required(a.sections[0]?.charts[0]?.marks.find((m) => m.key === 'tag:work')).weight).toBe(
    60,
  );
  expect(
    required(a.sections[0]?.charts[0]).marks.reduce((sum, m) => sum + (m.weight ?? 0), 0),
  ).toBe(180);
});
it('does owner sweep before scope; hidden overlaps and intermediate owners break transitions', async () => {
  const v = await views(
    [
      task('A', { timeEntries: [closed('2026-10-04T09:00Z', '2026-10-04T12:00Z')] }),
      task('B', {
        tags: ['selected'],
        timeEntries: [closed('2026-10-04T10:00Z', '2026-10-04T10:30Z')],
      }),
      task('C', {
        tags: ['selected'],
        timeEntries: [closed('2026-10-04T10:32Z', '2026-10-04T11:00Z')],
      }),
    ],
    { scope: { type: 'tag', tag: 'selected' } },
  );
  expect(value(await v.get('sessions'), 'recorded-changes')).toBe(0);
  const chain = await views(
    [
      task('A', {
        tags: ['selected'],
        timeEntries: [
          closed('2026-10-04T09:00Z', '2026-10-04T10:00Z'),
          closed('2026-10-04T09:30Z', '2026-10-04T09:45Z', 2),
        ],
      }),
      task('B', {
        tags: ['selected'],
        timeEntries: [closed('2026-10-04T10:00Z', '2026-10-04T10:20Z')],
      }),
      task('X', { timeEntries: [closed('2026-10-04T10:21Z', '2026-10-04T10:30Z')] }),
      task('C', {
        tags: ['selected'],
        timeEntries: [closed('2026-10-04T10:31Z', '2026-10-04T10:50Z')],
      }),
    ],
    { scope: { type: 'tag', tag: 'selected' } },
  );
  expect(value(await chain.get('sessions'), 'recorded-changes')).toBe(1);
});
it('density timeline preserves all evidence after 700 marks', async () => {
  const tasks = Array.from({ length: 750 }, (_, i) =>
    task(`T${i}`, { timeEntries: [closed('2026-10-04T09:00Z', '2026-10-04T10:00Z')] }),
  );
  const v = await views(tasks, { period: 'today' });
  const timeline = await v.get('timeline');
  expect(required(required(timeline.sections[0]).charts[0]).marks.length).toBeLessThanOrEqual(700);
  expect(value(timeline, 'recorded-minutes')).toBe(45000);
  const mark = required(
    required(required(timeline.sections[0]).charts[0]).marks.find(
      (m) => m.selectionId !== undefined,
    ),
  );
  expect(timeline.evidence(required(mark.selectionId), 700, 50).total).toBe(750);
});
it('conserves subsecond endpoints through two exact transitions inside a sampling cell', async () => {
  const transitions = [
      Date.parse('2026-10-04T00:15:30.250Z'),
      Date.parse('2026-10-04T00:45:30.250Z'),
    ],
    offsetAt = (ms: number) =>
      ms >= required(transitions[0]) && ms < required(transitions[1]) ? 30 : 0;
  const v = await views(
    [task('exact', { timeEntries: [closed('2026-10-04T00:00Z', '2026-10-04T01:00Z')] })],
    {
      period: 'today',
      nowMs: Date.parse('2026-10-04T01:00Z'),
      offsetAt,
      calendarTransitions: transitions,
    },
  );
  const p = await v.get('patterns'),
    marks = required(required(p.sections[0]).charts[0]).marks;
  expect(value(p, 'recorded-minutes')).toBe(60);
  expect(marks.reduce((sum, m) => sum + (m.numerator ?? 0), 0)).toBe(60);
  expect(marks.reduce((sum, m) => sum + (m.denominator ?? 0), 0)).toBe(1);
  for (const mark of marks.filter((m) => (m.denominator ?? 0) > 0))
    expect(mark.weight).toBeCloseTo(60, 10);
});
it('retains full century duration with bounded history marks and complete source evidence', async () => {
  const v = await views([task('century', { timeEntries: [closed('1900-01-01', '2000-01-01')] })], {
    period: 'all',
    nowMs: Date.parse('2000-01-01T00:00Z'),
    calendarTransitions: [],
  });
  const a = await v.get('allocation');
  expect(value(a, 'recorded-minutes')).toBe(52594560);
  expect(a.sections.flatMap((s) => s.charts).flatMap((c) => c.marks).length).toBeLessThan(245);
  const p = await v.get('patterns');
  expect(required(required(p.sections[0]).charts[0]).marks.every((m) => m.weight === 60)).toBe(
    true,
  );
});
it('exposes every normalized tag in one ranking beyond the former page cap', async () => {
  const tags = Array.from({ length: 170 }, (_, i) => `tag${i}`);
  const v = await views(
    [task('tagged', { tags, timeEntries: [closed('2026-10-04T09:00Z', '2026-10-04T10:00Z')] })],
    { group: 'tag', page: 14 },
  );
  const a = await v.get('allocation');
  expect(required(a.sections[0]).charts).toHaveLength(1);
  expect(a.sections[0]?.charts[0]?.marks).toHaveLength(170);
  expect(value(a, 'recorded-minutes')).toBe(60);
  expect(value(a, 'group-count')).toBe(170);
});
it('counts exactly five-minute adjacency but rejects one additional millisecond', async () => {
  const nodes = [
    task('A', { timeEntries: [closed('2026-10-04T09:00Z', '2026-10-04T10:00Z')] }),
    task('B', { timeEntries: [closed('2026-10-04T10:05Z', '2026-10-04T10:20Z')] }),
    task('C', { timeEntries: [closed('2026-10-04T10:25:00.001Z', '2026-10-04T11:00Z')] }),
  ];
  expect(value(await (await views(nodes)).get('sessions'), 'recorded-changes')).toBe(1);
});
it('preserves equal-duration share boundaries', async () => {
  const nodes = Array.from({ length: 1000 }, (_, i) =>
    task(`share${i}`, {
      timeEntries: i < 100 ? [closed('2026-10-04T09:00Z', '2026-10-04T10:00Z')] : [],
    }),
  );
  const a = await (await views(nodes)).get('allocation'),
    share = required(a.sections.find((section) => section.id === 'concentration')?.charts[0]);
  expect(share.marks.some((mark) => mark.x === 10 && mark.y === 100)).toBe(true);
});
it('separates untagged from the real none tag', async () => {
  const t = await (
    await views(
      [
        task('untagged', { timeEntries: [closed('2026-10-04T09:00Z', '2026-10-04T10:00Z')] }),
        task('none', {
          tags: ['none'],
          timeEntries: [closed('2026-10-04T09:00Z', '2026-10-04T10:00Z')],
        }),
      ],
      { group: 'tag' },
    )
  ).get('allocation');
  expect(value(t, 'group-count')).toBe(2);
});
it('includes a zero-length closed session exactly at as-of without a Timeline interval', async () => {
  const v = await views([
    task('zero-now', { timeEntries: [closed('2026-10-04T12:00Z', '2026-10-04T12:00Z')] }),
  ]);
  const s = await v.get('sessions');
  expect(value(s, 'session-count')).toBe(1);
  expect(value(s, 'median')).toBe(0);
  expect(s.evidence('sessions', 0, 50).total).toBe(1);
  expect(value(s, 'recorded-minutes')).toBe(0);
  expect(required(required((await v.get('timeline')).sections[0]).charts[0]).marks).toEqual([]);
});
it.each([
  {
    day: '2026-03-29',
    before: 0,
    after: 60,
    previous: '2026-03-28',
    previousStart: '09:00',
    currentStart: '08:00',
    expected: [
      [0, 60],
      [120, 240],
    ],
  },
  {
    day: '2026-10-25',
    before: 60,
    after: 0,
    previous: '2026-10-24',
    previousStart: '08:00',
    currentStart: '09:00',
    expected: [
      [60, 120],
      [60, 180],
    ],
  },
])(
  'aligns local clocks and preserves transition geometry on $day',
  async ({ day, before, after, previous, previousStart, currentStart, expected }) => {
    const transition = Date.parse(`${day}T01:00Z`);
    const v = await views(
      [
        task('previous-nine', {
          timeEntries: [
            closed(`${previous}T${previousStart}Z`, `${previous}T${previousStart}:01Z`),
          ],
        }),
        task('current-nine', {
          timeEntries: [closed(`${day}T${currentStart}Z`, `${day}T${currentStart}:01Z`)],
        }),
        task('crossing', { timeEntries: [closed(`${day}T00:00Z`, `${day}T03:00Z`)] }),
      ],
      {
        period: 'week',
        nowMs: Date.parse(`${day}T12:00Z`),
        offsetAt: (ms) => (ms < transition ? before : after),
      },
    );
    const model = await v.get('timeline');
    const chart = required(required(model.sections[0]).charts[0]);
    expect(chart.x).toMatchObject({ label: 'Time of day', domain: [0, 1440] });
    expect(chart.marks.filter((m) => m.label?.endsWith('nine') === true).map((m) => m.x)).toEqual([
      540, 540,
    ]);
    const crossing = chart.marks.filter((m) => m.label === 'crossing');
    expect(crossing.map((m) => [m.x, m.x2])).toEqual(expected);
    expect(crossing.map((m) => m.clock?.offsetMinutes)).toEqual([before, after]);
    expect(crossing.map((m) => m.clock?.startMs)).toEqual([
      Date.parse(`${day}T00:00Z`),
      transition,
    ]);
    expect(crossing.every((m) => m.clock?.startLabel.includes(day) === true)).toBe(true);
    expect(crossing.reduce((n, m) => n + (m.weight ?? 0), 0)).toBe(180);
    for (const mark of crossing)
      expect(model.evidence(required(mark.selectionId), 0, 50).rows[0]?.contributionMinutes).toBe(
        mark.weight,
      );
    const overview = required(required(model.sections[0]).charts[1]);
    expect(overview.marks).toHaveLength(1);
    expect(overview.marks[0]?.selected).toBe(true);
    expect(
      model.chartActions.find(([id]) => id === overview.marks[0]?.selectionId)?.[1],
    ).toMatchObject({ type: 'week' });
  },
);
it('pages actual overview weeks and keeps clipped totals separate from week activation', async () => {
  const dataset = required(
    await prepareStatisticsDataset(
      source([task('long', { timeEntries: [closed('2020-01-01', '2026-10-04T12:00Z')] })]),
      [],
      work,
    ),
  );
  const session = new StatisticsSession(dataset);
  const latest = required(await session.view(request({ view: 'timeline', period: 'all' }), work));
  expect(required(required(latest.sections[0]).charts[1]).marks.length).toBeLessThanOrEqual(104);
  expect(latest.actions.some((a) => a.type === 'page' && a.label === 'Earlier weeks')).toBe(true);
  const first = required(
    await session.view(request({ view: 'timeline', period: 'all', page: 0 }), work),
  );
  const chart = required(required(first.sections[0]).charts[1]);
  expect(chart.marks).toHaveLength(104);
  expect(chart.marks[0]).toMatchObject({ x: '2019-12-30', y: 7200 });
  expect(first.chartActions[0]?.[1]).toMatchObject({ type: 'week', weekStart: '2019-12-30' });
  expect(first.evidence(required(chart.marks[0]?.selectionId), 0, 50).total).toBe(0);
  expect(first.actions.some((a) => a.type === 'page' && a.label === 'Later weeks')).toBe(true);
});
it.each([
  { day: '2026-03-29', before: 0, after: 60, expected: 0 },
  { day: '2026-10-25', before: 60, after: 0, expected: 120 },
])(
  'retains exact local-hour density across the $day offset transition',
  async ({ day, before, after, expected }) => {
    const transition = Date.parse(`${day}T01:00Z`);
    const v = await views(
      Array.from({ length: 701 }, (_, i) =>
        task(`dense-${i}`, { timeEntries: [closed(`${day}T00:00Z`, `${day}T03:00Z`)] }),
      ),
      {
        period: 'today',
        nowMs: Date.parse(`${day}T12:00Z`),
        offsetAt: (ms) => (ms < transition ? before : after),
      },
    );
    const model = await v.get('timeline');
    const chart = required(required(model.sections[0]).charts[0]);
    expect(chart.layout).toBe('density');
    expect(chart.marks.reduce((n, m) => n + (m.weight ?? 0), 0)).toBe(701 * 180);
    const repeated = chart.marks.find((m) => m.x === 60);
    if (expected === 0) expect(repeated).toBeUndefined();
    else {
      expect(repeated?.weight).toBe(701 * expected);
      expect(repeated?.clockRanges?.map((c) => c.offsetMinutes)).toEqual([60, 0]);
      const evidence = model.evidence(required(repeated?.selectionId), 700, 50);
      expect(evidence.total).toBe(701);
      expect(evidence.rows).toHaveLength(1);
      expect(evidence.rows[0]?.contributionMinutes).toBe(expected);
    }
    const week = required(required(model.sections[0]).metrics.find((m) => m.id === 'week-minutes'));
    expect(model.evidence(required(week.selectionId), 0, 1).rows[0]?.contributionMinutes).toBe(180);
  },
);
it('uses configured first-day weeks and refreshes immutable chart actions when pages change', async () => {
  const dataset = required(
    await prepareStatisticsDataset(
      source([task('long', { timeEntries: [closed('2020-01-01', '2026-10-04T12:00Z')] })]),
      [],
      work,
    ),
  );
  const session = new StatisticsSession(dataset);
  const options = request({ view: 'timeline', period: 'all', firstDayOfWeek: 0, page: 0 });
  const first = required(await session.view(options, work));
  expect(first.chartActions[0]?.[1]).toMatchObject({ type: 'week', weekStart: '2019-12-29' });
  expect(Object.isFrozen(first.chartActions)).toBe(true);
  expect(Object.isFrozen(first.chartActions[0])).toBe(true);
  expect(Object.isFrozen(first.chartActions[0]?.[1])).toBe(true);
  expect(await session.view(options, work)).toBe(first);
  const next = required(await session.view({ ...options, page: 1 }, work));
  expect(next.chartActions[0]?.[0]).not.toBe(first.chartActions[0]?.[0]);
  const action = required(next.chartActions[0]?.[1]);
  expect(action.type).toBe('week');
  if (action.type === 'week') {
    const selected = required(
      await session.view({ ...options, page: 1, weekStart: action.weekStart }, work),
    );
    expect(selected.sections[0]?.charts[1]?.marks[0]?.selected).toBe(true);
    expect(
      required(selected.sections[0]).metrics.find((metric) => metric.id === 'week-minutes'),
    ).toMatchObject({ label: 'Selected week' });
    expect(selected.dateLabel).toBe(first.dateLabel);
  }
});
it('exposes sub-hour gap geometry inside dense local-clock cells', async () => {
  const transition = Date.parse('2026-03-29T01:00Z');
  const v = await views(
    Array.from({ length: 701 }, (_, i) =>
      task(`half-gap-${i}`, { timeEntries: [closed('2026-03-29T00:00Z', '2026-03-29T02:00Z')] }),
    ),
    {
      period: 'today',
      nowMs: Date.parse('2026-03-29T12:00Z'),
      offsetAt: (ms) => (ms < transition ? 0 : 30),
    },
  );
  const model = await v.get('timeline');
  const mark = required(
    required(required(model.sections[0]).charts[0]).marks.find((m) => m.x === 60),
  );
  expect(mark.weight).toBe(701 * 30);
  expect(mark.clockRanges?.map((c) => [c.localStartMinutes, c.localEndMinutes])).toEqual([
    [90, 120],
  ]);
  expect(model.evidence(required(mark.selectionId), 700, 50).rows[0]?.contributionMinutes).toBe(30);
});
it('supplies explicit local clock labels for timeline and hourly patterns', async () => {
  const v = await views([
    task('timed', { timeEntries: [closed('2026-10-01T09:00Z', '2026-10-01T10:00Z')] }),
  ]);
  const timeline = required(required((await v.get('timeline')).sections[0]).charts[0]).x;
  const patterns = required(required((await v.get('patterns')).sections[0]).charts[0]).x;
  if (timeline.type !== 'number' || patterns.type !== 'number')
    throw new Error('Expected numeric clock axes');
  expect(timeline.tickLabels).toContainEqual([540, '09:00']);
  expect(timeline.tickLabels).toContainEqual([1440, '24:00']);
  expect(patterns.tickLabels).toContainEqual([9, '09:00']);
});
it('names recorded minutes, elapsed exposure and fractional mean in pattern detail', async () => {
  const v = await views(
    [
      task('tiny', {
        timeEntries: [closed('2026-10-01T09:00:00.000Z', '2026-10-01T09:00:00.015Z')],
      }),
    ],
    { period: 'today', nowMs: Date.parse('2026-10-01T12:00Z') },
  );
  const chart = required(required((await v.get('patterns')).sections[0]).charts[0]);
  const positive = required(chart.marks.find((mark) => mark.x === 9 && mark.y === 'Thu'));
  const unavailable = required(chart.marks.find((mark) => mark.x === 15 && mark.y === 'Thu'));
  expect(positive.detail).toContain('0.00025 recorded minutes / 1 elapsed exposure hours');
  expect(positive.detail).toContain('mean 0.00025 minutes per hour');
  expect(unavailable.detail).toContain('No elapsed exposure');
});

it('gives repeated owner transitions distinct occurrence identities and event instants', async () => {
  const ds = required(
    await prepareStatisticsDataset(
      source([
        task('A', {
          timeEntries: [
            closed('2026-10-04T08:00Z', '2026-10-04T08:10Z'),
            closed('2026-10-04T08:20Z', '2026-10-04T08:30Z', 2),
          ],
        }),
        task('B', {
          timeEntries: [
            closed('2026-10-04T08:10Z', '2026-10-04T08:20Z'),
            closed('2026-10-04T08:30Z', '2026-10-04T08:40Z', 2),
          ],
        }),
      ]),
      [],
      work,
    ),
  );
  const view = required(await new StatisticsSession(ds).view(request({ view: 'sessions' }), work));
  const rows = view.evidence('recorded-changes', 0, 50).rows;
  expect(rows).toHaveLength(3);
  expect(new Set(rows.map((r) => r.key)).size).toBe(3);
  expect(rows.map((r) => r.atMs)).toEqual(
    ['08:10', '08:20', '08:30'].map((t) => Date.parse(`2026-10-04T${t}Z`)),
  );
  expect(view.sections[0]?.charts[0]?.x).toMatchObject({
    categories: [
      '0',
      'Up to 5',
      'Over 5–15',
      'Over 15–30',
      'Over 30–60',
      'Over 60–120',
      'Over 120–240',
      'Over 240',
    ],
  });
});
it('uses bounded project series on intervals and explicit measured intensity scales', async () => {
  const tasks = Array.from({ length: 15 }, (_, i) =>
    task(`P${i}`, { timeEntries: [closed('2026-10-04T08:00Z', '2026-10-04T08:10Z')] }),
  );
  const ds = required(
    await prepareStatisticsDataset(
      source(tasks),
      tasks.map((t) => ({ path: t.ref.filePath, name: t.title })),
      work,
    ),
  );
  const session = new StatisticsSession(ds);
  const timeline = required(await session.view(request({ view: 'timeline' }), work));
  const chart = required(timeline.sections[0]?.charts[0]);
  expect(chart.series).toHaveLength(13);
  expect(
    chart.marks.every((mark) => chart.series.some((series) => series.key === mark.series)),
  ).toBe(true);
  const remaining = required(
    timeline.sections[0]?.legend.find((item) => item.label === 'Remaining projects'),
  );
  expect(timeline.evidence(required(remaining.selectionId), 0, 50).total).toBe(3);
  const patterns = required(await session.view(request({ view: 'patterns' }), work));
  expect(patterns.sections[0]?.charts[0]?.intensityScale?.unit).toBe(
    'mean minutes per elapsed hour',
  );
});

it('distinguishes excluded and future days from observed zero in a partial selected week', async () => {
  const v = await views(
    [task('early', { timeEntries: [closed('2026-09-09T23:50Z', '2026-09-10T00:20Z')] })],
    { period: '30d', nowMs: Date.parse('2026-10-09T10:30Z'), weekStart: date('2026-09-07') },
  );
  const model = await v.get('timeline');
  const section = required(model.sections[0]);
  expect(section.reading).toContain('Sep 7–13, 2026');
  expect(section.reading).toContain('Included Sep 10–13');
  expect(value(model, 'day:0')).toBeNull();
  expect(value(model, 'day:2')).toBeNull();
  expect(value(model, 'day:3')).toBe(20);
  expect(value(model, 'day:4')).toBe(0);
  expect(section.charts[0]?.y.tickLabels).toContainEqual([
    '2026-09-07',
    '2026-09-07 · Outside period',
  ]);
  const today = await (
    await views([], { period: 'today', nowMs: Date.parse('2026-10-09T10:30Z') })
  ).get('timeline');
  expect(value(today, 'day:4')).toBe(0);
  expect(value(today, 'day:5')).toBeNull();
  expect(today.sections[0]?.charts[0]?.y.tickLabels).toContainEqual([
    '2026-10-10',
    '2026-10-10 · Not yet elapsed',
  ]);
});

it('keeps an empty selected week reachable with its range and separate period minutes', async () => {
  const model = await (
    await views(
      [task('earlier', { timeEntries: [closed('2026-10-01T09:00Z', '2026-10-01T10:00Z')] })],
      { period: '30d', nowMs: Date.parse('2026-10-09T10:30Z') },
    )
  ).get('timeline');
  expect(value(model, 'recorded-minutes')).toBe(60);
  expect(value(model, 'week-minutes')).toBe(0);
  expect(model.sections[0]?.emptyMessage).toBe('No recorded time in this week.');
  expect(model.sections[0]?.reading).toContain('Oct 5–11, 2026');
  expect(
    model.actions.some((action) => action.type === 'week' && action.label === 'Previous week'),
  ).toBe(true);
});

it('gives hourly aggregation a truthful title and original physical evidence', async () => {
  const model = await (
    await views(
      Array.from({ length: 701 }, (_, i) =>
        task(`interval${i}`, { timeEntries: [closed('2026-10-04T10:10Z', '2026-10-04T10:15Z')] }),
      ),
      { period: 'today' },
    )
  ).get('timeline');
  const section = required(model.sections[0]),
    chart = required(section.charts[0]),
    mark = required(chart.marks[0]);
  expect(section.title).toBe('Recorded minutes by hour');
  expect(chart.accessibleLabel).toContain('hour');
  expect(mark.observation?.title).toContain('10:00–11:00');
  expect(mark.observation?.note).toContain('Hourly aggregate');
  expect(mark.observation?.values).toContainEqual({
    label: 'Recorded time',
    value: 3505,
    unit: 'minutes',
  });
  const evidence = model.evidence(required(mark.selectionId), 700, 50);
  expect(evidence.total).toBe(701);
  expect(evidence.rows[0]?.entryTiming).toEqual({
    startMs: Date.parse('2026-10-04T10:10Z'),
    endMs: Date.parse('2026-10-04T10:15Z'),
  });
  expect(evidence.rows[0]?.contributionMinutes).toBe(5);
});

it('describes selected clipped portions and running endpoints without completing a running entry', async () => {
  const model = await (
    await views(
      [
        task('clipped', { timeEntries: [closed('2026-10-08T23:50Z', '2026-10-09T00:20Z')] }),
        task('running', {
          timeEntries: [
            {
              state: 'running',
              startMs: Date.parse('2026-10-09T10:10Z'),
              relativeLine: 1,
              originalMarkdown: 'running',
            },
          ],
        }),
      ],
      { period: 'today', nowMs: Date.parse('2026-10-09T10:30Z') },
    )
  ).get('timeline');
  const marks = required(model.sections[0]?.charts[0]).marks;
  const clipped = required(marks.find((mark) => mark.label === 'clipped'));
  expect(required(clipped.observation).note).toContain('Portion shown');
  expect(required(clipped.observation).title).toContain('00:00–00:20');
  expect(
    required(clipped.observation).values.find((v) => v.label === 'Full session start')?.value,
  ).toContain('2026-10-08T23:50');
  expect(model.evidence(required(clipped.selectionId), 0, 1).rows[0]?.entryTiming?.startMs).toBe(
    Date.parse('2026-10-08T23:50Z'),
  );
  const running = required(marks.find((mark) => mark.label === 'running'));
  expect(required(running.observation).note).toContain('Running through');
  expect(required(running.observation).note).toContain('10:30');
  expect(required(running.observation).values.some((v) => v.label === 'Full session end')).toBe(
    false,
  );
  expect(
    model.evidence(required(running.selectionId), 0, 1).rows[0]?.entryTiming?.endMs,
  ).toBeUndefined();
});

it('makes only positive pattern cells actionable and reports zero-positive data', async () => {
  const v = await views([], { period: 'today', nowMs: Date.parse('2026-10-01T12:00Z') });
  const model = await v.get('patterns'),
    chart = required(model.sections[0]?.charts[0]);
  expect(model.sections[0]?.emptyMessage).toBe('No recorded time in this period.');
  expect(chart.intensityScale?.domain).toEqual([0, 0]);
  expect(chart.marks.every((mark) => mark.selectionId === undefined)).toBe(true);
  const zero = required(chart.marks.find((mark) => mark.x === 9 && mark.y === 'Thu'));
  expect(zero.state).toBe('measured');
  expect(zero.observation?.values).toContainEqual({
    label: 'Recorded time',
    value: 0,
    unit: 'minutes',
  });
  expect(zero.observation?.values).toContainEqual({
    label: 'Elapsed exposure',
    value: 1,
    unit: 'hours',
  });
  const future = required(chart.marks.find((mark) => mark.x === 13 && mark.y === 'Thu'));
  expect(future.state).toBe('unavailable');
  expect(future.observation?.values).toContainEqual({ label: 'Rate', value: null, unit: 'min/h' });
});

it('keeps session exclusions in the starts cohort and undatable coverage scope-wide', async () => {
  const model = await (
    await views(
      [
        task('sessions', {
          timeEntries: [
            closed('2026-10-08T23:50Z', '2026-10-09T00:20Z'),
            {
              state: 'running',
              startMs: Date.parse('2026-10-09T10:10Z'),
              relativeLine: 2,
              originalMarkdown: 'running',
            },
            closed('2026-10-09T09:00Z', '2026-10-09T11:00Z', 3),
            { state: 'broken', relativeLine: 4, originalMarkdown: 'broken' },
            {
              state: 'running',
              startMs: Date.parse('2026-10-10T09:00Z'),
              relativeLine: 5,
              originalMarkdown: 'future running',
            },
            closed('2026-10-10T09:00Z', '2026-10-10T11:00Z', 6),
          ],
        }),
      ],
      { period: 'today', nowMs: Date.parse('2026-10-09T10:30Z') },
    )
  ).get('sessions');
  expect(value(model, 'recorded-minutes')).toBe(130);
  expect(value(model, 'session-count')).toBe(0);
  expect(value(model, 'running-excluded')).toBe(1);
  expect(value(model, 'future-end-excluded')).toBe(1);
  const section = required(model.sections[0]);
  expect(section.reading).toContain('Started in this period');
  expect(section.emptyMessage).toBe('No closed sessions started in this period.');
  expect(section.metrics.find((m) => m.id === 'broken-excluded')).toMatchObject({
    role: 'coverage',
    label: 'Unusable time entries in scope (all dates)',
    value: 1,
  });
  expect(section.metrics.find((m) => m.id === 'running-excluded')?.role).toBe('coverage');
  expect(section.charts[0]?.marks.every((mark) => mark.selectionId === undefined)).toBe(true);
});

it('reports session bin counts once and preserves a real zero-duration sample', async () => {
  const model = await (
    await views([
      task('two', {
        timeEntries: [
          closed('2026-10-04T08:00Z', '2026-10-04T08:10Z'),
          closed('2026-10-04T09:00Z', '2026-10-04T09:12Z', 2),
        ],
      }),
    ])
  ).get('sessions');
  const chart = required(model.sections[0]?.charts[0]),
    mark = required(chart.marks.find((m) => m.y === 2));
  expect(chart.y.label).toBe('Sessions');
  expect(mark.observation).toEqual({
    title: 'Over 5–15 min',
    values: [{ label: 'Sessions', value: 2, unit: 'sessions' }],
  });
  const zero = await (
    await views([task('zero', { timeEntries: [closed('2026-10-04T08:00Z', '2026-10-04T08:00Z')] })])
  ).get('sessions');
  expect(zero.sections[0]?.emptyMessage).toBeUndefined();
  expect(value(zero, 'median')).toBe(0);
  expect(zero.sections[0]?.charts[0]?.marks[0]?.observation?.values[0]?.value).toBe(1);
});

it('keeps a small positive interval and its physical task identifiable in the observation', async () => {
  const model = await (
    await views(
      [
        task('tiny', {
          timeEntries: [closed('2026-10-01T09:00:00.000Z', '2026-10-01T09:00:00.015Z')],
        }),
      ],
      { period: 'today', nowMs: Date.parse('2026-10-01T12:00Z') },
    )
  ).get('timeline');
  const chart = required(model.sections[0]?.charts[0]),
    mark = required(chart.marks[0]);
  expect(mark.observation?.title).toContain('09:00–09:00:00.015');
  expect(mark.observation?.values).toContainEqual({ label: 'Task', value: 'tiny' });
  expect(mark.observation?.values).toContainEqual({
    label: 'Recorded time',
    value: 0.00025,
    unit: 'minutes',
  });
  expect(chart.y.tickLabels?.find(([day]) => day === '2026-10-01')?.[1]).not.toContain(' · 0 min');
});

it('keeps the observation cutoff separate from earlier portions of a running session', async () => {
  const model = await (
    await views(
      [
        task('across midnight', {
          timeEntries: [
            {
              state: 'running',
              startMs: Date.parse('2026-10-08T23:50Z'),
              relativeLine: 1,
              originalMarkdown: 'running',
            },
          ],
        }),
      ],
      { period: 'week', nowMs: Date.parse('2026-10-09T10:30Z') },
    )
  ).get('timeline');
  const fragments = required(model.sections[0]?.charts[0]).marks;
  expect(fragments).toHaveLength(2);
  expect(fragments[0]?.observation?.title).toContain('23:50–24:00');
  for (const mark of fragments) {
    expect(mark.observation?.note).toContain('Running through 2026-10-09T10:30');
    expect(mark.observation?.values.some((value) => value.label === 'Full session end')).toBe(
      false,
    );
    expect(
      model.evidence(required(mark.selectionId), 0, 1).rows[0]?.entryTiming?.endMs,
    ).toBeUndefined();
  }
});

it.each([16, 17, 700, 701])(
  'bounds %i simultaneous timeline entries while preserving hourly evidence',
  async (count) => {
    const model = await (
      await views(
        Array.from({ length: count }, (_, i) =>
          task(`parallel${i}`, {
            timeEntries: [closed('2026-10-04T10:10Z', '2026-10-04T10:15Z')],
          }),
        ),
        { period: 'today' },
      )
    ).get('timeline');
    const chart = required(model.sections[0]?.charts[0]);
    expect(chart.layout).toBe(count === 16 ? undefined : 'density');
    expect(value(model, 'week-minutes')).toBe(count * 5);
    expect(chart.marks.reduce((total, mark) => total + (mark.weight ?? 0), 0)).toBe(count * 5);
    const mark = required(chart.marks[0]);
    expect(model.evidence(required(mark.selectionId), 0, 50).total).toBe(count === 16 ? 1 : count);
    expect(
      model
        .evidence(required(mark.selectionId), 0, 50)
        .rows.every((row) => row.contributionMinutes === 5),
    ).toBe(true);
  },
);

it('keeps sequential local-clock intervals sparse and counts repeated-hour overlaps for the lane bound', async () => {
  const sequential = await (
    await views(
      [
        task('sequential', {
          timeEntries: Array.from({ length: 100 }, (_, i) =>
            closed(
              new Date(Date.parse('2026-10-04T09:00Z') + i * 60000).toISOString(),
              new Date(Date.parse('2026-10-04T09:00Z') + (i + 1) * 60000).toISOString(),
              i + 1,
            ),
          ),
        }),
      ],
      { period: 'today' },
    )
  ).get('timeline');
  expect(sequential.sections[0]?.charts[0]?.layout).toBeUndefined();
  expect(sequential.sections[0]?.charts[0]?.marks).toHaveLength(100);
  const transition = Date.parse('2026-10-25T01:00Z');
  const repeated = await (
    await views(
      Array.from({ length: 9 }, (_, i) =>
        task(`fold${i}`, {
          timeEntries: [closed('2026-10-25T00:00Z', '2026-10-25T02:00Z')],
        }),
      ),
      {
        period: 'today',
        nowMs: Date.parse('2026-10-25T12:00Z'),
        offsetAt: (ms) => (ms < transition ? 60 : 0),
      },
    )
  ).get('timeline');
  const chart = required(repeated.sections[0]?.charts[0]),
    mark = required(chart.marks.find((mark) => mark.x === 60));
  expect(chart.layout).toBe('density');
  expect(mark.weight).toBe(1080);
  expect(mark.clockRanges?.map((range) => range.offsetMinutes)).toEqual([60, 0]);
  expect(repeated.evidence(required(mark.selectionId), 0, 50).total).toBe(9);
  expect(
    repeated
      .evidence(required(mark.selectionId), 0, 50)
      .rows.every((row) => row.contributionMinutes === 120),
  ).toBe(true);
});

it('keeps the selected-week reading compact while retaining precise physical observation endpoints', async () => {
  const model = await (
    await views(
      [
        task('precise', {
          timeEntries: [closed('2026-10-09T09:00:00.000Z', '2026-10-09T09:00:00.015Z')],
        }),
      ],
      { period: 'today', nowMs: Date.parse('2026-10-09T10:30:09.249Z'), offsetAt: () => 420 },
    )
  ).get('timeline');
  expect(model.sections[0]?.reading).toBe(
    'Oct 5–11, 2026 · Included Oct 9 · Through 17:30 UTC+7 · overlapping entries add',
  );
  const mark = required(model.sections[0]?.charts[0]?.marks[0]);
  expect(mark.observation?.title).toContain('16:00–16:00:00.015');
  expect(mark.clock?.endMs).toBe(Date.parse('2026-10-09T09:00:00.015Z'));
  expect(model.evidence(required(mark.selectionId), 0, 1).rows[0]?.entryTiming?.endMs).toBe(
    Date.parse('2026-10-09T09:00:00.015Z'),
  );
});

it('ranks all 17 Allocation groups without paging, including zero totals and colliding names', async () => {
  const nodes = Array.from({ length: 17 }, (_, i) =>
    task(`P${i}`, {
      timeEntries:
        i === 16
          ? []
          : [closed('2026-10-04T09:00Z', `2026-10-04T09:${String(32 - i).padStart(2, '0')}Z`)],
    }),
  );
  const projects = nodes.map((node, i) => ({
    path: node.ref.filePath,
    name: i < 2 ? 'Build' : `Project ${i}`,
  }));
  const dataset = required(await prepareStatisticsDataset(source(nodes), projects, work));
  const session = new StatisticsSession(dataset);
  const overview = required(
    await session.view(request({ view: 'allocation', period: 'today', page: 3 }), work),
  );
  const chart = required(required(overview.sections[0]).charts[0]);
  expect(chart.rowViewport).toBe(true);
  expect(chart.marks).toHaveLength(17);
  expect(chart.x).toMatchObject({ type: 'number', domain: [0, 32], unit: 'minutes' });
  expect(chart.marks.map((m) => m.weight)).toEqual([
    32, 31, 30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20, 19, 18, 17, 0,
  ]);
  expect(required(chart.y.tickLabels).slice(0, 2)).toEqual([
    ['project:P0.md', 'Build · P0.md'],
    ['project:P1.md', 'Build · P1.md'],
  ]);
  expect(overview.actions.some((action) => action.type === 'page')).toBe(false);
  expect(required(overview.sections[0]).legend).toEqual([]);
  const focused = required(
    await session.view(
      request({ view: 'allocation', period: 'today', focusKey: 'project:P1.md' }),
      work,
    ),
  );
  expect(required(focused.sections[0]).title).toContain('Build · P1.md');
  expect(required(focused.sections[0]).charts).toHaveLength(1);
  expect(required(required(focused.sections[0]).charts[0]).y).toMatchObject({
    domain: [0, 31],
    unit: 'minutes',
  });
  expect(
    required(focused.sections[0]).metrics.find((metric) => metric.id === 'recorded-minutes'),
  ).toMatchObject({ value: 392, label: 'All recorded time in scope' });
  expect(
    required(focused.sections.find((section) => section.id === 'concentration')).reading,
  ).toContain('All tasks and subtasks in scope');
  const positive = required(
    required(required(focused.sections[0]).charts[0]).marks.find((m) => (m.weight ?? 0) > 0),
  );
  const evidence = focused.evidence(required(positive.selectionId), 0, 50);
  expect(evidence.total).toBe(1);
  expect(required(evidence.rows[0]).filePath).toBe('P1.md');
  expect(required(evidence.rows[0]).contributionMinutes).toBe(31);
  expect(focused.actions).toContainEqual({
    type: 'focus',
    label: 'All projects',
    focusKey: undefined,
  });
  expect(overview.chartActions).toContainEqual([
    'allocation-focus:project:P1.md',
    { type: 'focus', label: 'Build · P1.md', focusKey: 'project:P1.md' },
  ]);
  const stale = required(
    await session.view(request({ view: 'allocation', period: 'today', focusKey: 'removed' }), work),
  );
  expect(required(required(stale.sections[0]).charts[0]).rowViewport).toBe(true);
});
it('keeps tag focus within global scope and removes undefined zero-time concentration', async () => {
  const nodes = [
    task('included', {
      tags: ['work', 'home'],
      timeEntries: [closed('2026-10-04T09:00Z', '2026-10-04T10:00Z')],
    }),
    task('outside', {
      tags: ['home'],
      timeEntries: [closed('2026-10-04T09:00Z', '2026-10-04T11:00Z')],
    }),
  ];
  const view = await (
    await views(nodes, {
      view: 'allocation',
      period: 'today',
      group: 'tag',
      scope: { type: 'tag', tag: 'work' },
      focusKey: 'tag:home',
    })
  ).get('allocation');
  expect(view.sections[0]?.reading).toContain('Tags overlap');
  expect(view.sections[0]?.charts[0]?.marks.reduce((sum, m) => sum + (m.weight ?? 0), 0)).toBe(60);
  expect(view.actions).toEqual([{ type: 'focus', label: 'All tags', focusKey: undefined }]);
  const zero = await (await views([task('zero')], { period: 'today' })).get('allocation');
  const concentration = required(zero.sections.find((section) => section.id === 'concentration'));
  expect(concentration.charts[0]?.marks).toEqual([]);
  expect(concentration.emptyMessage).toBe('No recorded time in this period');
  expect(concentration.metrics[0]?.value).toBe(1);
});

it('keeps a ten-minute group readable against 100,000 scope minutes while preserving the ranking maximum', async () => {
  const nodes = Array.from({ length: 10000 }, (_, index) =>
    task(`ScaleGroup${index}`, {
      tags: ['common', `group${index}`],
      timeEntries: [closed('2026-10-04T09:00Z', '2026-10-04T09:10Z')],
    }),
  );
  const dataset = required(await prepareStatisticsDataset(source(nodes), [], work));
  const session = new StatisticsSession(dataset);
  const ranking = required(
    await session.view(request({ view: 'allocation', period: 'today', group: 'tag' }), work),
  );
  const overview = required(required(ranking.sections[0]).charts[0]);
  expect(overview.marks).toHaveLength(10001);
  expect(overview.x).toMatchObject({ domain: [0, 100000] });
  const focused = required(
    await session.view(
      request({ view: 'allocation', period: 'today', group: 'tag', focusKey: 'tag:group9999' }),
      work,
    ),
  );
  const chart = required(required(focused.sections[0]).charts[0]);
  expect(chart.y).toMatchObject({ domain: [0, 10] });
  expect(chart.marks.map((mark) => mark.weight)).toEqual([10]);
  const rows = focused.evidence(required(required(chart.marks[0]).selectionId), 0, 50);
  expect(rows.total).toBe(1);
  expect(required(rows.rows[0])).toMatchObject({
    filePath: 'ScaleGroup9999.md',
    contributionMinutes: 10,
  });
  expect(value(focused, 'recorded-minutes')).toBe(100000);
  expect(required(required(ranking.sections[0]).charts[0]).x).toMatchObject({
    domain: [0, 100000],
  });
});

it.each([
  { group: 'project' as const, name: 'No project', key: 'unassigned' },
  { group: 'tag' as const, name: 'Untagged', key: 'untagged' },
])(
  'keeps synthetic $name identity plain when real project names collide',
  async ({ group, name, key }) => {
    const dataset = required(
      await prepareStatisticsDataset(
        source([task('free')]),
        [
          { name, path: 'a.md' },
          { name, path: 'b.md' },
        ],
        work,
      ),
    );
    const view = required(
      await new StatisticsSession(dataset).view(request({ view: 'allocation', group }), work),
    );
    expect(required(required(view.sections[0]).charts[0]).y.tickLabels).toEqual([[key, name]]);
  },
);
