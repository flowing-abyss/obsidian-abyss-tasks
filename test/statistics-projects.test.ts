import { expect, it } from 'vitest';
import { statisticsMarkDescription } from '../src/panels/statistics/statisticsFormat';
import { prepareStatisticsDataset } from '../src/statistics/statisticsDataset';
import { StatisticsSession } from '../src/statistics/statisticsSession';
import { required } from '../src/statistics/statisticsWork';
import { closed, date, request, source, task, work } from './helpers/statisticsFixtures';
const metrics = (v: Awaited<ReturnType<StatisticsSession['view']>>) =>
  required(v).sections.flatMap((s) => s.metrics);
const metricValue = (v: Awaited<ReturnType<StatisticsSession['view']>>, id: string) =>
  required(metrics(v).find((m) => m.id === id)).value;
it.each(['done', 'cancelled'] as const)(
  'retires a retained dependency focus after its prerequisite becomes %s',
  async (status) => {
    const nodes = [task('A', { dependencyId: 'A' }), task('B', { dependsOn: ['A'] })];
    const initial = required(await prepareStatisticsDataset(source(nodes), [], work));
    const focused = request({ view: 'dependencies', focusKey: required(initial.tasks[0]).key });
    const before = required(await new StatisticsSession(initial).view(focused, work));
    expect(metricValue(before, 'downstream')).toBe(1);
    const changed = required(
      await prepareStatisticsDataset(
        source([{ ...required(nodes[0]), status }, required(nodes[1])]),
        [],
        work,
      ),
    );
    const after = required(await new StatisticsSession(changed).view(focused, work));
    expect(metricValue(after, 'waiting')).toBe(0);
    expect(after.sections.flatMap((s) => s.charts).some((c) => c.kind === 'network')).toBe(false);
    expect(metrics(after).some((m) => ['direct', 'sole', 'downstream'].includes(m.id))).toBe(false);
    expect(after.sections[0]?.emptyMessage).toContain('No resolved waiting');
  },
);
it('keeps shared blockers visible at the cap and qualifies every omitted incoming relation', async () => {
  const nodes = [
    task('A', { dependencyId: 'A' }),
    task('X', { dependencyId: 'X' }),
    ...Array.from({ length: 79 }, (_, i) =>
      task(`D${i}`, { tags: ['scope'], dependsOn: ['A', 'X'] }),
    ),
  ];
  const ds = required(await prepareStatisticsDataset(source(nodes), [], work));
  const view = required(
    await new StatisticsSession(ds).view(
      request({
        view: 'dependencies',
        scope: { type: 'tag', tag: 'scope' },
        focusKey: required(ds.tasks[0]).key,
      }),
      work,
    ),
  );
  const chart = required(view.sections[0]?.charts.find((c) => c.kind === 'network'));
  expect(chart.marks).toHaveLength(80);
  expect(chart.marks.map((m) => m.label)).toContain('X');
  expect(chart.edges).toHaveLength(156);
  expect(chart.facet?.description).toContain('80 of 81 tasks');
  expect(chart.facet?.description).toContain('156 of 158 relations');
  expect(chart.facet?.description).toContain('Prerequisite → dependent');
  expect(metricValue(view, 'direct')).toBe(79);
  expect(metricValue(view, 'downstream')).toBe(79);
  expect(metricValue(view, 'sole')).toBe(0);
  expect(view.evidence('direct', 50, 50).total).toBe(79);
  expect(view.evidence('chain-edges', 150, 50).total).toBe(158);
  expect(view.evidence('chain-omitted', 0, 50).total).toBe(1);
  for (const mark of chart.marks.filter((m) => required(m.label).startsWith('D'))) {
    expect(chart.edges?.filter((edge) => edge.to === mark.key)).toHaveLength(2);
    expect(mark.observation?.values).toContainEqual({
      label: 'Omitted prerequisites or relations',
      value: 0,
    });
  }
});
it('counts incoming context omitted by the edge cap for each dense dependency node', async () => {
  const dense = required(
    await prepareStatisticsDataset(
      source(
        Array.from({ length: 20 }, (_, i) =>
          task(`dense${i}`, {
            dependencyId: `id${i}`,
            dependsOn: Array.from({ length: i }, (_, j) => `id${j}`),
          }),
        ),
      ),
      [],
      work,
    ),
  );
  const capped = required(
    await new StatisticsSession(dense).view(
      request({ view: 'dependencies', focusKey: required(dense.tasks[0]).key }),
      work,
    ),
  );
  const graph = required(capped.sections[0]?.charts.find((c) => c.kind === 'network'));
  for (const mark of graph.marks) {
    const shown = required(graph.edges).filter((edge) => edge.to === mark.key).length;
    expect(mark.observation?.values).toContainEqual({
      label: 'Omitted prerequisites or relations',
      value: Number(mark.label?.slice(5)) - shown,
    });
  }
});
it('keeps dependency scope and current status explicit with exact affected-task diagnostics', async () => {
  const nodes = [
    task('A', { dependencyId: 'A' }),
    task('Done', { dependencyId: 'done', status: 'done' }),
    task('B', {
      dependencyId: 'B',
      tags: ['scope'],
      dependsOn: ['A', 'done', 'missing-1', 'missing-2', 'archived'],
    }),
    task('Outside', { dependencyId: 'outside', dependsOn: ['A'] }),
    task('Outside leaf', { dependsOn: ['outside'] }),
    task('Closed unresolved', { status: 'done', tags: ['scope'], dependsOn: ['missing-3'] }),
    task('Duplicate 1', { dependencyId: 'dup' }),
    task('Duplicate 2', { dependencyId: 'dup' }),
    task('Ambiguous', { tags: ['scope'], dependsOn: ['dup'] }),
    task('Cycle 1', { tags: ['scope'], dependencyId: 'c1', dependsOn: ['c2'] }),
    task('Cycle 2', { tags: ['scope'], dependencyId: 'c2', dependsOn: ['c1'] }),
  ];
  const ds = required(
    await prepareStatisticsDataset(
      source(nodes, [task('Archived', { dependencyId: 'archived' })]),
      [],
      work,
    ),
  );
  const view = required(
    await new StatisticsSession(ds).view(
      request({
        view: 'dependencies',
        scope: { type: 'tag', tag: 'scope' },
        focusKey: required(ds.tasks[0]).key,
      }),
      work,
    ),
  );
  const chart = required(view.sections[0]?.charts.find((c) => c.kind === 'network'));
  expect(chart.marks.map((m) => m.label)).toEqual(['A', 'B']);
  expect(chart.series.find((s) => s.key === 'external')?.label).toBe('Outside scope');
  expect(chart.series.find((s) => s.key === 'focus')?.label).toContain('Outside scope');
  expect(metricValue(view, 'waiting')).toBe(3);
  expect(metricValue(view, 'downstream')).toBe(1);
  expect(metricValue(view, 'sole')).toBe(0);
  expect(metrics(view).find((m) => m.id === 'dependency:missing')).toMatchObject({
    value: 1,
    label: 'Tasks with unresolved IDs',
  });
  expect(metrics(view).find((m) => m.id === 'dependency:ambiguous')).toMatchObject({
    value: 1,
    label: 'Tasks with duplicate-ID references',
  });
  expect(metrics(view).find((m) => m.id === 'dependency:cyclic')).toMatchObject({
    value: 2,
    label: 'Tasks in cycles',
  });
  const missing = view.evidence('dependency:missing', 0, 50).rows;
  expect(missing.map((r) => r.title)).toEqual(['B']);
  expect(required(missing[0]).context).toContain('missing-1, missing-2, archived');
  expect(view.evidence('dependency:ambiguous', 0, 50).rows[0]?.context).toContain('dup');
  const rank = required(view.sections[0]?.charts[0]);
  expect(
    statisticsMarkDescription(required(rank.marks.find((m) => m.label === 'A')), rank),
  ).toContain('Waiting directly: 1 task');
  expect(rank.marks.find((m) => m.label === 'A')?.observation).toMatchObject({
    values: [{ label: 'Waiting directly', value: 1, unit: 'tasks' }],
  });
  expect(required(rank.marks.find((m) => m.label === 'A')).observation?.note).toContain(
    'Inspect dependencies',
  );
  expect(view.actions).toContainEqual({
    type: 'focus',
    label: 'Back to prerequisites',
    focusKey: undefined,
  });
});
it('retains outside-scope paths only when they explain scoped downstream waiting work', async () => {
  const ds = required(
    await prepareStatisticsDataset(
      source([
        task('A', { dependencyId: 'A' }),
        task('Co', { dependencyId: 'co' }),
        task('Bridge', { dependencyId: 'bridge', dependsOn: ['A', 'co'] }),
        task('Scoped', { tags: ['scope'], dependsOn: ['bridge'] }),
        task('Direct', { tags: ['scope'], dependsOn: ['A'] }),
        task('Unrelated leaf', { dependsOn: ['A'] }),
      ]),
      [],
      work,
    ),
  );
  const view = required(
    await new StatisticsSession(ds).view(
      request({
        view: 'dependencies',
        scope: { type: 'tag', tag: 'scope' },
        focusKey: required(ds.tasks[0]).key,
      }),
      work,
    ),
  );
  expect(metricValue(view, 'direct')).toBe(1);
  expect(metricValue(view, 'downstream')).toBe(2);
  expect(view.evidence('downstream', 0, 50).rows.map((row) => row.title)).toEqual([
    'Direct',
    'Scoped',
  ]);
  const chart = required(required(view.sections[0]).charts.find((c) => c.kind === 'network'));
  expect(chart.marks.map((m) => m.label)).toEqual(['A', 'Co', 'Bridge', 'Direct', 'Scoped']);
  expect(chart.marks.filter((m) => m.series === 'external').map((m) => m.label)).toEqual([
    'Co',
    'Bridge',
  ]);
});
it('returns to the same prerequisite page and clamps it after the waiting population shrinks', async () => {
  const nodes = Array.from({ length: 14 }, (_, i) => [
    task(`P${String(i).padStart(2, '0')}`, { dependencyId: `id${i}` }),
    task(`D${i}`, { dependsOn: [`id${i}`] }),
  ]).flat();
  const ds = required(await prepareStatisticsDataset(source(nodes), [], work));
  const session = new StatisticsSession(ds),
    req = request({ view: 'dependencies', page: 1 });
  const rank = required(await session.view(req, work));
  const marks = required(required(rank.sections[0]).charts[0]).marks;
  const focus = required(await session.view({ ...req, focusKey: required(marks[0]).key }, work));
  expect(focus.actions).toContainEqual({
    type: 'focus',
    label: 'Back to prerequisites',
    focusKey: undefined,
  });
  const back = required(await session.view({ ...req, focusKey: undefined }, work));
  expect(required(required(back.sections[0]).charts[0]).marks.map((m) => m.label)).toEqual([
    'P12',
    'P13',
  ]);
  const shrunk = required(await prepareStatisticsDataset(source(nodes.slice(0, 4)), [], work));
  const stale = required(
    await new StatisticsSession(shrunk).view({ ...req, focusKey: required(marks[0]).key }, work),
  );
  expect(required(required(stale.sections[0]).charts[0]).marks.map((m) => m.label)).toEqual([
    'P00',
    'P01',
  ]);
});
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
it.each(['done', 'cancelled'] as const)(
  'matches the native dependency golden populations before and after A becomes %s',
  async (status) => {
    const tagged = { tags: ['analysis-clarity-deps-20261009'] };
    const nodes = [
      task('Prerequisite A', { ...tagged, dependencyId: 'A' }),
      task('Co-prerequisite X', { ...tagged, dependencyId: 'X' }),
      ...Array.from({ length: 79 }, (_, i) =>
        task(`Shared${i}`, { ...tagged, dependsOn: ['A', 'X'] }),
      ),
      task('Sole A', { ...tagged, dependsOn: ['A'] }),
      task('Missing open', { ...tagged, dependsOn: ['missing-1', 'missing-2'] }),
      task('Missing closed', { ...tagged, status: 'done', dependsOn: ['missing-3'] }),
      task('Duplicate1', { dependencyId: 'duplicate' }),
      task('Duplicate2', { dependencyId: 'duplicate' }),
      task('Ambiguous', { ...tagged, dependsOn: ['duplicate'] }),
      task('Cycle left', { ...tagged, dependencyId: 'left', dependsOn: ['right'] }),
      task('Cycle right', { ...tagged, dependencyId: 'right', dependsOn: ['left'] }),
      task('Outside branch', { dependsOn: ['A'] }),
    ];
    const ds = required(await prepareStatisticsDataset(source(nodes), [], work));
    const req = request({
      view: 'dependencies',
      scope: { type: 'tag', tag: 'analysis-clarity-deps-20261009' },
      focusKey: required(ds.tasks[0]).key,
    });
    const initial = required(await new StatisticsSession(ds).view(req, work));
    for (const [id, want] of [
      ['waiting', 82],
      ['direct', 80],
      ['sole', 1],
      ['dependency:missing', 1],
      ['dependency:ambiguous', 1],
      ['dependency:cyclic', 2],
    ] as const)
      expect(metricValue(initial, id)).toBe(want);
    expect(
      required(required(initial.sections[0]).charts[0]).marks.find(
        (m) => m.label === 'Co-prerequisite X',
      )?.y,
    ).toBe(79);
    expect(initial.evidence('downstream', 0, 50).total).toBe(80);
    const changed = required(
      await prepareStatisticsDataset(
        source([{ ...required(nodes[0]), status }, ...nodes.slice(1)]),
        [],
        work,
      ),
    );
    const after = required(await new StatisticsSession(changed).view(req, work));
    for (const [id, want] of [
      ['waiting', 81],
      ['direct', 79],
      ['downstream', 79],
      ['sole', 79],
    ] as const)
      expect(metricValue(after, id)).toBe(want);
    expect(
      required(required(after.sections[0]).charts[0]).marks.some(
        (m) => m.label === 'Prerequisite A',
      ),
    ).toBe(false);
    expect(
      after.sections[0]?.charts
        .find((c) => c.kind === 'network')
        ?.marks.some((m) => m.label === 'Prerequisite A'),
    ).toBe(false);
  },
);
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
    type: 'focus',
    focusKey: 'project:A.md',
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

it.each(['90d', '6m'] as const)(
  'labels cumulative %s endpoints and preserves exact prefix evidence',
  async (period) => {
    const ds = required(
      await prepareStatisticsDataset(
        source([
          task('early', {
            status: 'done',
            planning: { created: date('2026-04-05'), completion: date('2026-09-29') },
          }),
          task('late', {
            status: 'done',
            planning: { created: date('2026-10-01'), completion: date('2026-10-04') },
          }),
        ]),
        [],
        work,
      ),
    );
    const view = required(
      await new StatisticsSession(ds).view(request({ view: 'movement', period }), work),
    );
    const chart = required(view.sections[0]?.charts[0]);
    const last = required(chart.marks.filter((m) => m.series === 'completed').slice(-1)[0]);
    expect(last.label).toBe('Through 2026-10-04');
    expect(last.observation?.values).toContainEqual({
      label: 'Completed',
      value: 2,
      unit: 'tasks',
    });
    expect(last.observation?.values).toContainEqual({
      label: 'Dates counted',
      value: period === '90d' ? '2026-07-07 - 2026-10-04' : '2026-04-05 - 2026-10-04',
    });
    expect(view.evidence(required(last.selectionId), 0, 50).rows.map((r) => r.title)).toEqual([
      'early',
      'late',
    ]);
    expect(chart.x.label).toBe('Through date');
    expect(required(chart.x.tickLabels).slice(-1)[0]?.[1]).toBe('2026-10-04');
    expect(chart.x.tickLabels?.[0]).toEqual(
      period === '90d' ? [6, '2026-07-12'] : [26, '2026-04-30'],
    );
    expect(last.x).toBe(period === '90d' ? 90 : 183);
    expect(chart.marks[0]?.selectionId).toBeUndefined();
  },
);
it('keeps Movement page scales, focus scope, positions and undated project coverage truthful', async () => {
  const projects = Array.from({ length: 14 }, (_, i) => ({
    path: `P${String(i).padStart(2, '0')}.md`,
    name: i === 0 || i === 12 ? 'Same' : `P${i}`,
  }));
  const nodes = projects.flatMap((project, i) =>
    Array.from({ length: i === 0 ? 20 : 1 }, (_, j) =>
      task(`T${i}-${j}`, {
        ref: { filePath: project.path, line: j, revision: '1' },
        status: 'done',
        tags: j === 0 ? ['chosen'] : [],
        planning: i === 13 ? {} : { created: date('2026-10-01'), completion: date('2026-10-04') },
      }),
    ),
  );
  const ds = required(await prepareStatisticsDataset(source(nodes), projects, work)),
    session = new StatisticsSession(ds);
  const first = required(await session.view(request({ view: 'movement', page: 0 }), work));
  const second = required(await session.view(request({ view: 'movement', page: 1 }), work));
  expect(required(required(first.sections[1]).charts[0]).x).toMatchObject({ domain: [0, 20] });
  expect(required(required(second.sections[1]).charts[0]).x).toMatchObject({ domain: [0, 20] });
  expect(required(second.sections[0]).reading).toContain('Projects 13 to 14 of 14');
  const undated = required(
    required(second.sections[0]).charts.find((c) => c.facet?.key === 'project:P13.md'),
  );
  expect(undated.emptyMessage).toContain('No usable event dates');
  expect(undated.marks).toHaveLength(0);
  expect(second.evidence('movement-unavailable:project:P13.md:created', 0, 50).total).toBe(1);
  expect(
    required(required(first.sections[0]).charts[0]).marks.some(
      (mark) => mark.series === 'cancelled' && mark.y === 0,
    ),
  ).toBe(true);
  expect(required(required(required(first.sections[0]).charts[0]).facet).label).toBe(
    'Same · P00.md',
  );
  expect(required(required(required(second.sections[0]).charts[0]).facet).label).toBe(
    'Same · P12.md',
  );
  expect(
    required(first.sections[1]).metrics.every((m) => m.label.includes('All projects in scope')),
  ).toBe(true);
  const scopedRequest = request({
    view: 'movement',
    page: 1,
    scope: { type: 'tag', tag: 'chosen' },
  });
  const scoped = required(await session.view(scopedRequest, work));
  const action = required(scoped.chartActions.find(([id]) => id === 'focus:project:P12.md'))[1];
  expect(action).toMatchObject({ type: 'focus', focusKey: 'project:P12.md' });
  const focus = required(
    await session.view({ ...scopedRequest, focusKey: 'project:P12.md' }, work),
  );
  expect(required(focus.sections[0]).charts).toHaveLength(1);
  expect(
    required(required(focus.sections[1]).charts[0]).marks.reduce(
      (sum, mark) => sum + (mark.weight ?? 0),
      0,
    ),
  ).toBe(1);
  expect(focus.actions).toContainEqual({
    type: 'focus',
    label: 'Back to projects',
    focusKey: undefined,
  });
  const back = required(await session.view({ ...scopedRequest, focusKey: undefined }, work));
  expect(required(back.sections[0]).charts.map((c) => c.id)).toEqual(
    required(scoped.sections[0]).charts.map((c) => c.id),
  );
  const shrunk = required(
    await prepareStatisticsDataset(
      source(nodes.filter((n) => n.ref.filePath === 'P00.md')),
      projects,
      work,
    ),
  );
  const stale = required(
    await new StatisticsSession(shrunk).view(
      { ...scopedRequest, focusKey: 'project:P12.md' },
      work,
    ),
  );
  expect(required(stale.sections[0]).charts).toHaveLength(1);
  expect(required(stale.sections[0]).reading).toContain('Projects 1 to 1 of 1');
});
it('separates missing creation and completion before creation with exact origin evidence', async () => {
  const ds = required(
    await prepareStatisticsDataset(
      source([
        task('missing', { status: 'done', planning: { completion: date('2026-10-02') } }),
        task('reversed', {
          status: 'done',
          planning: { created: date('2026-10-03'), completion: date('2026-10-02') },
        }),
      ]),
      [],
      work,
    ),
  );
  const view = required(await new StatisticsSession(ds).view(request({ view: 'movement' }), work));
  expect(view.evidence('completion-origin:unknown', 0, 50).rows.map((r) => r.title)).toEqual([
    'missing',
  ]);
  expect(view.evidence('completion-origin:before-created', 0, 50).rows.map((r) => r.title)).toEqual(
    ['reversed'],
  );
});
it('keeps unknown-only Aging explicit and qualifies project captions across bounded pages', async () => {
  const ds = required(await prepareStatisticsDataset(source([task('unknown')]), [], work));
  const unknown = required(await new StatisticsSession(ds).view(request({ view: 'aging' }), work));
  expect(required(unknown.sections[0]).emptyMessage).toContain('age unavailable');
  expect(required(unknown.sections[0]).reading).toContain('including those with no recorded time');
  const projects = Array.from({ length: 13 }, (_, i) => ({
    path: `P${String(i).padStart(2, '0')}.md`,
    name: i === 0 || i === 12 ? 'Same' : `P${i}`,
  }));
  const owners = projects.flatMap((p, i) =>
    Array.from({ length: i === 12 ? 50 : 1 }, (_, j) =>
      task(`O${i}-${j}`, {
        ref: { filePath: p.path, line: j, revision: '1' },
        planning: { created: date(i === 12 ? '2026-07-01' : '2026-10-04') },
      }),
    ),
  );
  const dataset = required(await prepareStatisticsDataset(source(owners), projects, work));
  const session = new StatisticsSession(dataset);
  const first = required(await session.view(request({ view: 'aging' }), work));
  const last = required(await session.view(request({ view: 'aging', page: 99 }), work));
  expect(required(required(required(first.sections[1]).charts[0]).facet).label).toBe(
    'Same · P00.md',
  );
  expect(required(required(required(last.sections[1]).charts[0]).facet).label).toBe(
    'Same · P12.md',
  );
  expect(required(required(last.sections[1]).charts[0]).y).toMatchObject({ domain: [0, 50] });
  expect(required(required(last.sections[1]).charts[0]).marks.slice(-1)[0]).toMatchObject({
    x: 'Age unavailable',
    series: 'unavailable',
  });
  expect(last.actions[0]).toMatchObject({ type: 'page', page: 0 });
});

it('keeps fractional recorded-time density bounds aligned with contributing owners', async () => {
  const now = Date.parse('2026-10-04T12:00Z');
  const owners = Array.from({ length: 601 }, (_, i) =>
    task(`fraction${i}`, {
      planning: { created: date(new Date(now - i * 86400000).toISOString().slice(0, 10)) },
      timeEntries:
        i === 0 ? [] : [closed(new Date(now - i * 50).toISOString(), new Date(now).toISOString())],
    }),
  );
  const dataset = required(await prepareStatisticsDataset(source(owners), [], work));
  const view = required(
    await new StatisticsSession(dataset).view(request({ view: 'aging' }), work),
  );
  const chart = required(required(view.sections[0]).charts[0]);
  const last = required(chart.marks.find((mark) => mark.key === '29:19'));
  expect(last.y).toBeCloseTo(0.475);
  expect(last.y2).toBeCloseTo(0.5);
  expect(statisticsMarkDescription(last, chart)).toContain(
    'Recorded time (all time): ≥0.475 to ≤0.5 min',
  );
  expect(last.observation?.values[1]?.range).toMatchObject({
    from: 0.475,
    to: 0.5,
    inclusiveMaximum: true,
  });
  expect(view.evidence(required(last.selectionId), 0, 50).rows.map((row) => row.title)).toContain(
    'fraction600',
  );
});
