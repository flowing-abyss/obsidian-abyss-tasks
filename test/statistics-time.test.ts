import { expect, it } from 'vitest';
import { prepareStatisticsDataset } from '../src/statistics/statisticsDataset';
import { StatisticsSession } from '../src/statistics/statisticsSession';
import { required } from '../src/statistics/statisticsWork';
import type { StatisticsRequest, StatisticsViewModel } from '../src/statistics/types';
import { closed, request, source, task, work } from './helpers/statisticsFixtures';
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
  expect(
    required(required(a.sections[0]).charts.find((c) => c.facet?.label === 'work')).marks.reduce(
      (s, m) => s + Number(m.weight),
      0,
    ),
  ).toBe(60);
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
it('exposes every normalized tag beyond the facet cap and project remainder', async () => {
  const tags = Array.from({ length: 170 }, (_, i) => `tag${i}`);
  const v = await views(
    [task('tagged', { tags, timeEntries: [closed('2026-10-04T09:00Z', '2026-10-04T10:00Z')] })],
    { group: 'tag', page: 14 },
  );
  const a = await v.get('allocation');
  expect(required(a.sections[0]).charts).toHaveLength(2);
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
