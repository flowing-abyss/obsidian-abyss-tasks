import { expect, it } from 'vitest';
import { prepareStatisticsDataset } from '../src/statistics/statisticsDataset';
import { StatisticsSession } from '../src/statistics/statisticsSession';
import { required } from '../src/statistics/statisticsWork';
import { closed, date, request, source, task, work } from './helpers/statisticsFixtures';
const metrics = (v: Awaited<ReturnType<StatisticsSession['view']>>) =>
  required(v).sections.flatMap((s) => s.metrics);
it('counts focused downstream once through external prerequisites and disqualifies unresolved sole claims', async () => {
  const nodes = [
    task('A', { dependencyId: 'A' }),
    task('X', { dependencyId: 'X' }),
    task('B', { tags: ['scope'], dependencyId: 'B', dependsOn: ['A', 'A'] }),
    task('C', { tags: ['scope'], dependencyId: 'C', dependsOn: ['A', 'X'] }),
    task('D', { tags: ['scope'], dependsOn: ['B', 'C'] }),
  ];
  const ds = await prepareStatisticsDataset(source(nodes), [], work);
  const view = await new StatisticsSession(required(ds)).view(
    request({
      view: 'dependencies',
      scope: { type: 'tag', tag: 'scope' },
      focusKey: required(required(ds).tasks[0]).key,
    }),
    work,
  );
  expect(metrics(view).find((m) => m.id === 'direct')?.value).toBe(2);
  expect(metrics(view).find((m) => m.id === 'downstream')?.value).toBe(3);
  expect(metrics(view).find((m) => m.id === 'sole')?.value).toBe(1);
  expect(
    required(view)
      .evidence('downstream', 0, 50)
      .rows.map((r) => r.title)
      .sort((a, b) => a.localeCompare(b)),
  ).toEqual(['B', 'C', 'D']);
  const bad = await prepareStatisticsDataset(
    source(nodes.map((t) => (t.title === 'B' ? { ...t, dependsOn: ['A', 'missing'] } : t))),
    [],
    work,
  );
  const badView = await new StatisticsSession(required(bad)).view(
    request({
      view: 'dependencies',
      scope: { type: 'tag', tag: 'scope' },
      focusKey: required(required(bad).tasks[0]).key,
    }),
    work,
  );
  expect(metrics(badView).find((m) => m.id === 'sole')?.value).toBe(0);
});
it('handles cycles, ambiguous IDs and canonical cancelled status without recursive traversal', async () => {
  const ds = await prepareStatisticsDataset(
    source([
      task('A', { dependencyId: 'A', dependsOn: ['B'] }),
      task('B', { dependencyId: 'B', dependsOn: ['A'] }),
      task('dup1', { dependencyId: 'X' }),
      task('dup2', { dependencyId: 'X' }),
      task('ambiguous', { dependsOn: ['X'] }),
      task('cancelled', { status: 'cancelled', dependencyId: 'cancelled', statusSymbol: ' ' }),
      task('free', { dependsOn: ['cancelled'] }),
    ]),
    [],
    work,
  );
  const v = await new StatisticsSession(required(ds)).view(
    request({ view: 'dependencies', focusKey: required(required(ds).tasks[0]).key }),
    work,
  );
  expect(metrics(v).find((m) => m.id === 'downstream')?.value).toBe(1);
  expect(metrics(v).find((m) => m.id === 'sole')?.value).toBe(0);
  expect(required(v).evidence('dependency:ambiguous', 0, 50).total).toBe(1);
  expect(
    required(v)
      .evidence('dependency:waiting', 0, 50)
      .rows.map((r) => r.title),
  ).not.toContain('free');
});
it('bounds a star graph while preserving omitted branches', async () => {
  const nodes = [
    task('root', { dependencyId: 'root' }),
    ...Array.from({ length: 200 }, (_, i) => task(`child${i}`, { dependsOn: ['root'] })),
  ];
  const ds = await prepareStatisticsDataset(source(nodes), [], work);
  const v = await new StatisticsSession(required(ds)).view(
    request({ view: 'dependencies', focusKey: required(required(ds).tasks[0]).key }),
    work,
  );
  expect(metrics(v).find((m) => m.id === 'downstream')?.value).toBe(200);
  const chart = required(
    required(v)
      .sections.flatMap((s) => s.charts)
      .find((c) => c.kind === 'network'),
  );
  expect(chart.marks.length).toBeLessThanOrEqual(80);
  expect(required(chart.edges).length).toBeLessThanOrEqual(160);
  expect(required(v).evidence('chain-omitted', 0, 50).total).toBe(121);
});
it('combines 100k coincident zero-time ages, keeping live-only evidence', async () => {
  const nodes = Array.from({ length: 100000 }, (_, i) =>
    task(`T${i}`, { planning: { created: date('2026-10-01') } }),
  );
  const ds = await prepareStatisticsDataset(
    source(nodes, [task('archive', { planning: { created: date('2026-10-01') } })]),
    [],
    work,
  );
  const v = await new StatisticsSession(required(ds)).view(request({ view: 'aging' }), work);
  expect(metrics(v).find((m) => m.id === 'open-now')?.value).toBe(100000);
  const chart = required(required(required(v).sections[0]).charts[0]);
  expect(chart.marks).toHaveLength(1);
  expect(required(chart.marks[0]).weight).toBe(100000);
  expect(
    required(v).evidence(required(required(chart.marks[0]).selectionId), 99950, 50).rows,
  ).toHaveLength(50);
});
it('keeps project path identities, archive unknown and no-project apart; cumulative selection has exact prefixes', async () => {
  const nodes = [
    task('A', { planning: { created: date('2026-10-01') } }),
    task('B', { planning: { created: date('2026-10-02') } }),
    task('C', { planning: { created: date('2026-10-03') } }),
  ];
  const ds = await prepareStatisticsDataset(
    source(nodes, [task('archive', { planning: { created: date('2026-10-01') } })]),
    [
      { path: 'A.md', name: 'Other' },
      { path: 'B.md', name: 'Other' },
    ],
    work,
  );
  const v = await new StatisticsSession(required(ds)).view(request({ view: 'movement' }), work);
  const charts = required(required(v).sections[0]).charts;
  expect(new Set(charts.map((c) => c.facet?.key)).size).toBe(4);
  const a = required(charts.find((c) => c.facet?.key === 'project:A.md'));
  expect(required(a.marks[0]).selectionId).toBeUndefined();
  const created = a.marks.filter((m) => m.series === 'created');
  const last = required(created[created.length - 1]);
  expect(
    required(v)
      .evidence(required(last.selectionId), 0, 50)
      .rows.map((r) => r.title),
  ).toEqual(['A']);
});
it('aging uses node-own all-time time, independent of selected period', async () => {
  const ds = await prepareStatisticsDataset(
    source([
      task('A', {
        planning: { created: date('2026-09-01') },
        timeEntries: [closed('2026-09-01T09:00Z', '2026-09-01T10:00Z')],
      }),
    ]),
    [],
    work,
  );
  const v = await new StatisticsSession(required(ds)).view(
    request({ view: 'aging', period: 'today' }),
    work,
  );
  expect(required(required(required(required(v).sections[0]).charts[0]).marks[0]).y).toBe(60);
});
it('traverses a long chain once only for an explicit focus and can cancel cold graph work', async () => {
  const nodes = Array.from({ length: 10000 }, (_, i) =>
    task(`chain${i}`, { dependencyId: `id${i}`, dependsOn: i === 0 ? [] : [`id${i - 1}`] }),
  );
  const ds = required(await prepareStatisticsDataset(source(nodes), [], work));
  const session = new StatisticsSession(ds),
    v = required(
      await session.view(
        request({ view: 'dependencies', focusKey: required(ds.tasks[0]).key }),
        work,
      ),
    );
  expect(metrics(v).find((m) => m.id === 'downstream')?.value).toBe(9999);
  expect(metrics(v).find((m) => m.id === 'sole')?.value).toBe(1);
  let cancelled = false;
  expect(
    await new StatisticsSession(ds).view(request({ view: 'dependencies' }), {
      yieldControl: async () => {
        cancelled = true;
      },
      isCancelled: () => cancelled,
    }),
  ).toBeUndefined();
});
it('keeps graph edges beyond the render cap inspectable with distinct evidence identities', async () => {
  const nodes = Array.from({ length: 20 }, (_, i) =>
    task(`dense${i}`, {
      dependencyId: `id${i}`,
      dependsOn: Array.from({ length: i }, (_, j) => `id${j}`),
    }),
  );
  const ds = required(await prepareStatisticsDataset(source(nodes), [], work)),
    view = required(
      await new StatisticsSession(ds).view(
        request({ view: 'dependencies', focusKey: required(ds.tasks[0]).key }),
        work,
      ),
    );
  const chart = required(view.sections.flatMap((s) => s.charts).find((c) => c.kind === 'network'));
  expect(chart.edges).toHaveLength(160);
  const page = view.evidence('chain-omitted-edges', 0, 50);
  expect(page.total).toBe(30);
  expect(new Set(page.rows.map((row) => row.key)).size).toBe(30);
});
it('bins dense distinct Aging coordinates without discarding physical owners', async () => {
  const nodes = Array.from({ length: 601 }, (_, i) =>
    task(`age${i}`, {
      planning: {
        created: date(new Date(Date.parse('2026-10-01') - i * 86400000).toISOString().slice(0, 10)),
      },
    }),
  );
  const ds = required(await prepareStatisticsDataset(source(nodes), [], work)),
    view = required(await new StatisticsSession(ds).view(request({ view: 'aging' }), work));
  const chart = required(required(view.sections[0]).charts[0]);
  expect(chart.marks.length).toBeLessThanOrEqual(600);
  expect(chart.marks.reduce((sum, mark) => sum + (mark.weight ?? 0), 0)).toBe(601);
});
it('exposes per-event date coverage for matching scoped terminal populations', async () => {
  const ds = required(
    await prepareStatisticsDataset(
      source([
        task('known', { tags: ['chosen'], planning: { created: date('2026-10-01') } }),
        task('missing', { tags: ['chosen'] }),
        task('done-missing', { tags: ['chosen'], status: 'done' }),
        task('cancel-missing', { tags: ['chosen'], status: 'cancelled' }),
        task('hidden-done', { status: 'done' }),
      ]),
      [],
      work,
    ),
  );
  const view = required(
    await new StatisticsSession(ds).view(
      request({ view: 'movement', scope: { type: 'tag', tag: 'chosen' } }),
      work,
    ),
  );
  for (const [id, count] of [
    ['created-known', 1],
    ['created-unavailable', 3],
    ['completed-known', 0],
    ['completed-unavailable', 1],
    ['cancelled-known', 0],
    ['cancelled-unavailable', 1],
  ] as const) {
    const m = required(metrics(view).find((item) => item.id === id));
    expect(m).toMatchObject({ value: count, role: 'coverage' });
    expect(view.evidence(required(m.selectionId), 0, 50).total).toBe(count);
  }
  expect(view.sections[0]?.charts[0]?.marks.some((m) => m.series === 'created' && m.y === 1)).toBe(
    true,
  );
});
it('provides civil date tick labels for cumulative bucket coordinates', async () => {
  const dataset = required(
    await prepareStatisticsDataset(
      source([task('dated', { planning: { created: date('2026-10-01') } })]),
      [],
      work,
    ),
  );
  const view = required(
    await new StatisticsSession(dataset).view(request({ view: 'movement', period: '7d' }), work),
  );
  const axis = required(required(view.sections[0]).charts[0]).x;
  expect(axis.type).toBe('number');
  if (axis.type === 'number') {
    expect(axis.tickLabels).toContainEqual([1, '2026-09-28']);
    expect(axis.tickLabels).toContainEqual([7, '2026-10-04']);
    expect(axis.tickLabels?.some(([value]) => value === 0)).toBe(false);
  }
});
it('binds movement facets and dependency ranks through opaque chart actions, with exact origin stacks', async () => {
  const nodes = [
    task('A', {
      status: 'done',
      planning: { created: date('2026-09-01'), completion: date('2026-10-01') },
    }),
    task('B', { dependencyId: 'B', planning: { created: date('2026-10-01') } }),
    task('C', { dependsOn: ['B'] }),
  ];
  const ds = required(
    await prepareStatisticsDataset(
      source(nodes),
      [
        { path: 'A.md', name: 'Same' },
        { path: 'B.md', name: 'Same' },
      ],
      work,
    ),
  );
  const session = new StatisticsSession(ds),
    movement = required(await session.view(request({ view: 'movement' }), work));
  const facet = required(
    movement.sections[0]?.charts.find((chart) => chart.facet?.key === 'project:A.md'),
  );
  expect(movement.chartActions.find(([id]) => id === facet.facet?.actionId)?.[1]).toMatchObject({
    type: 'scope',
    scope: { type: 'project', path: 'A.md' },
  });
  const origin = required(
    movement.sections.find((section) => section.id === 'completion-origins')?.charts[0],
  );
  expect(origin.x.type).toBe('number');
  expect(origin.y.type).toBe('band');
  const mark = required(origin.marks.find((mark) => mark.series === 'before' && mark.weight === 1));
  expect(movement.evidence(required(mark.selectionId), 0, 50).rows.map((row) => row.title)).toEqual(
    ['A'],
  );
  const deps = required(await session.view(request({ view: 'dependencies' }), work));
  const rank = required(deps.sections[0]?.charts[0]?.marks[0]);
  expect(deps.chartActions.find(([id]) => id === rank.selectionId)?.[1]).toMatchObject({
    type: 'chain',
    focusKey: ds.tasks[1]?.key,
  });
});
it('lays out a dependency fork as siblings and exposes titles without decoding source keys', async () => {
  const ds = required(
    await prepareStatisticsDataset(
      source([
        task('Prerequisite', { dependencyId: 'A' }),
        task('First branch', { dependsOn: ['A'] }),
        task('Second branch', { dependsOn: ['A'] }),
      ]),
      [],
      work,
    ),
  );
  const view = required(
    await new StatisticsSession(ds).view(
      request({ view: 'dependencies', focusKey: required(ds.tasks[0]).key }),
      work,
    ),
  );
  const charts = view.sections.flatMap((s) => s.charts),
    rank = required(charts.find((c) => c.id === 'dependency-rank')),
    graph = required(charts.find((c) => c.kind === 'network'));
  expect(rank.x.tickLabels).toEqual([[required(ds.tasks[0]).key, 'Prerequisite']]);
  const [a, b, c] = graph.marks.map((mark) => ({ x: Number(mark.x), y: Number(mark.y) }));
  expect(required(b).x).toBe(required(c).x);
  expect(required(a).x).toBeLessThan(required(b).x);
  expect(required(b).y).not.toBe(required(c).y);
  expect(required(a).y).toBe((required(b).y + required(c).y) / 2);
});
