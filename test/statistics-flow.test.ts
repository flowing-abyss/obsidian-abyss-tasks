import { expect, it } from 'vitest';
import { prepareStatisticsDataset } from '../src/statistics/statisticsDataset';
import { StatisticsSession } from '../src/statistics/statisticsSession';
import { required } from '../src/statistics/statisticsWork';
import { date, request, source, task, work } from './helpers/statisticsFixtures';
it('keeps creation outcomes separate from completion events and their exact evidence', async () => {
  const dataset = await prepareStatisticsDataset(
    source([
      task('A', { planning: { created: date('2026-10-01') } }),
      task('B', {
        status: 'done',
        planning: { created: date('2026-10-02'), completion: date('2026-10-03') },
      }),
      task('C', { planning: { created: date('2026-10-04') } }),
      task('D', {
        status: 'done',
        planning: { created: date('2026-09-01'), completion: date('2026-10-02') },
      }),
    ]),
    [],
    work,
  );
  const view = await new StatisticsSession(required(dataset)).view(request(), work);
  const metrics = required(view).sections.flatMap((s) => s.metrics);
  expect(metrics.find((m) => m.id === 'created')?.value).toBe(3);
  expect(metrics.find((m) => m.id === 'completed')?.value).toBe(2);
  expect(metrics.find((m) => m.id === 'new-open')?.value).toBe(2);
  expect(
    required(view)
      .evidence('new-open', 0, 50)
      .rows.map((r) => r.title),
  ).toEqual(['A', 'C']);
  expect(
    required(view)
      .evidence('completed', 0, 50)
      .rows.map((r) => r.title),
  ).toEqual(['B', 'D']);
  const section = required(required(view).sections[0]);
  const recurringSeries = required(section.charts[0]).series.filter(
    (series) => series.muted === true,
  );
  expect(recurringSeries.length).toBeGreaterThan(0);
  for (const series of recurringSeries)
    expect(section.legend.find((legend) => legend.key === series.key)?.muted).toBe(series.muted);
});
it('preserves missing current ages and excludes archived open nodes', async () => {
  const tasks = Array.from({ length: 104 }, (_, i) => task(`missing${i}`));
  const dataset = await prepareStatisticsDataset(source(tasks, [task('archived')]), [], work);
  const view = await new StatisticsSession(required(dataset)).view(request(), work);
  expect(
    required(view)
      .sections.flatMap((s) => s.metrics)
      .find((m) => m.id === 'open-now')?.value,
  ).toBe(104);
  expect(required(view).evidence('age:unknown', 100, 50).rows).toHaveLength(4);
  expect(required(view).evidence('age:unknown', 0, 1000).rows).toHaveLength(50);
});
it('rejects future/reversed completion pairs and uses a nearest-rank P90', async () => {
  const tasks = [
    task('one', {
      status: 'done',
      planning: { created: date('2026-10-01'), completion: date('2026-10-02') },
    }),
    task('three', {
      status: 'done',
      planning: { created: date('2026-09-30'), completion: date('2026-10-03') },
    }),
    task('future', {
      status: 'done',
      planning: { created: date('2026-10-01'), completion: date('2026-10-05') },
    }),
    task('reverse', {
      status: 'done',
      planning: { created: date('2026-10-04'), completion: date('2026-10-02') },
    }),
  ];
  const ds = await prepareStatisticsDataset(source(tasks), [], work);
  const view = await new StatisticsSession(required(ds)).view(
    request({ view: 'completion' }),
    work,
  );
  const metrics = required(required(view).sections[0]).metrics;
  expect(metrics.find((m) => m.id === 'valid-pairs')?.value).toBe(2);
  expect(metrics.find((m) => m.id === 'median')?.value).toBe(2);
  expect(metrics.find((m) => m.id === 'p90')?.value).toBe(3);
});
it('cohorts mature only after the last horizon day, retaining cancelled denominators', async () => {
  const ds = await prepareStatisticsDataset(
    source([
      task('done', {
        status: 'done',
        planning: { created: date('2026-10-01'), completion: date('2026-10-02') },
      }),
      task('cancel', {
        status: 'cancelled',
        planning: { created: date('2026-10-02'), cancelled: date('2026-10-03') },
      }),
    ]),
    [],
    work,
  );
  const session = new StatisticsSession(required(ds));
  const immature = await session.view(
    request({ view: 'cohorts', nowMs: Date.parse('2026-10-05T12:00Z') }),
    work,
  );
  const mature = await session.view(
    request({ view: 'cohorts', nowMs: Date.parse('2026-10-06T12:00Z') }),
    work,
  );
  const cell = (v: NonNullable<typeof mature>) =>
    required(required(required(v.sections[0]).charts[0]).marks.find((m) => m.x === 3));
  expect(cell(required(immature)).state).toBe('immature');
  expect(cell(required(mature)).weight).toBe(50);
  expect(cell(required(mature)).denominator).toBe(2);
  expect(required(mature).evidence(required(cell(required(mature)).selectionId), 0, 50).total).toBe(
    2,
  );
});
it('deadlines use saved due date outcomes and retain unknown completion timing', async () => {
  const ds = await prepareStatisticsDataset(
    source([
      task('late', {
        status: 'done',
        planning: { due: date('2026-10-01'), completion: date('2026-10-02') },
      }),
      task('today', { planning: { due: date('2026-10-04') } }),
      task('unknown', { status: 'done', planning: { due: date('2026-10-01') } }),
    ]),
    [],
    work,
  );
  const view = await new StatisticsSession(required(ds)).view(request({ view: 'deadlines' }), work);
  expect(required(view).evidence('deadline:late', 0, 50).rows[0]?.title).toBe('late');
  expect(required(view).evidence('deadline:upcoming', 0, 50).total).toBe(1);
  expect(required(view).evidence('deadline:unknown', 0, 50).total).toBe(1);
});
it('distinguishes missing and future event dates from a measured zero', async () => {
  const ds = required(
    await prepareStatisticsDataset(
      source([
        task('missing'),
        task('future', {
          status: 'done',
          planning: { created: date('2026-10-05'), completion: date('2026-10-06') },
        }),
      ]),
      [],
      work,
    ),
  );
  const v = required(await new StatisticsSession(ds).view(request(), work));
  const metrics = v.sections.flatMap((s) => s.metrics);
  expect(metrics.find((m) => m.id === 'created-unknown')?.value).toBe(2);
  expect(metrics.find((m) => m.id === 'completed-unknown')?.value).toBe(1);
  expect(v.evidence('created-unknown', 0, 50).rows.map((row) => row.title)).toEqual([
    'missing',
    'future',
  ]);
});
it('pages the 105th creation cohort without truncating its denominator', async () => {
  const nodes = Array.from({ length: 105 }, (_, i) =>
    task(`week${i}`, {
      planning: {
        created: date(
          new Date(Date.parse('2024-01-01') + i * 7 * 86400000).toISOString().slice(0, 10),
        ),
      },
    }),
  );
  const ds = required(await prepareStatisticsDataset(source(nodes), [], work)),
    session = new StatisticsSession(ds);
  const first = required(await session.view(request({ view: 'cohorts', period: 'all' }), work));
  expect(required(first.sections[0]).charts[0]?.marks).toHaveLength(520);
  expect(first.actions).toContainEqual({ type: 'page', label: 'Next groups', page: 1 });
  const second = required(
    await session.view(request({ view: 'cohorts', period: 'all', page: 1 }), work),
  );
  const mark = required(required(second.sections[0]).charts[0]?.marks[0]);
  expect(second.evidence(required(mark.selectionId), 0, 50).total).toBe(1);
});
it('uses the cohort classifier in cell evidence, including unknown timing', async () => {
  const ds = required(
    await prepareStatisticsDataset(
      source([
        task('within', {
          status: 'done',
          planning: { created: date('2026-10-01'), completion: date('2026-10-02') },
        }),
        task('cancelled', { status: 'cancelled', planning: { created: date('2026-10-01') } }),
        task('unknown', { status: 'done', planning: { created: date('2026-10-01') } }),
      ]),
      [],
      work,
    ),
  );
  const view = required(
      await new StatisticsSession(ds).view(
        request({ view: 'cohorts', nowMs: Date.parse('2026-10-06T12:00Z') }),
        work,
      ),
    ),
    cell = required(
      required(required(view.sections[0]).charts[0]).marks.find((mark) => mark.x === 3),
    );
  expect(cell.state).toBe('unknown');
  expect(cell.weight).toBeUndefined();
  expect(view.evidence(required(cell.selectionId), 0, 50).rows.map((row) => row.context)).toEqual([
    'Within 3 days',
    'Cancelled',
    'Unknown timing',
  ]);
});
it('discloses scoped due and cohort date eligibility separately from period outcomes', async () => {
  const ds = required(
    await prepareStatisticsDataset(
      source([
        task('missing', { tags: ['chosen'] }),
        task('future', {
          tags: ['chosen'],
          planning: { created: date('2027-01-01'), due: date('2027-01-01') },
        }),
        task('known', { tags: ['chosen'], planning: { created: date('2026-10-01') } }),
        task('hidden'),
      ]),
      [],
      work,
    ),
  );
  const session = new StatisticsSession(ds);
  for (const [view, field, known, unavailable] of [
    ['deadlines', 'due', 1, 2],
    ['cohorts', 'created', 1, 2],
  ] as const) {
    const v = required(
      await session.view(request({ view, scope: { type: 'tag', tag: 'chosen' } }), work),
    );
    const metrics = v.sections.flatMap((s) => s.metrics);
    expect(metrics.find((m) => m.id === `${field}-known`)).toMatchObject({
      value: known,
      role: 'coverage',
    });
    const missing = required(metrics.find((m) => m.id === `${field}-unavailable`));
    expect(missing).toMatchObject({ value: unavailable, role: 'coverage' });
    expect(v.evidence(required(missing.selectionId), 0, 50).total).toBe(unavailable);
    if (view === 'deadlines')
      expect(metrics.filter((m) => m.role !== 'coverage').every((m) => m.value === 0)).toBe(true);
  }
});

it('renders due-date bucket stacks with exact segment evidence and one-off cohort display', async () => {
  const ds = required(
    await prepareStatisticsDataset(
      source([
        task('First', { planning: { due: date('2026-10-01'), created: date('2026-10-01') } }),
        task('Second', { planning: { due: date('2026-10-02'), created: date('2026-10-01') } }),
        task('Repeating', { recurrence: 'every day', planning: { created: date('2026-10-01') } }),
      ]),
      [],
      work,
    ),
  );
  const session = new StatisticsSession(ds);
  const due = required(await session.view(request({ view: 'deadlines' }), work));
  const chart = required(due.sections[0]?.charts[0]);
  expect(new Set(chart.marks.map((m) => m.x)).size).toBe(4);
  const nonempty = chart.marks.filter((m) => (m.weight ?? 0) > 0);
  expect(nonempty).toHaveLength(2);
  expect(
    nonempty.map((m) => due.evidence(required(m.selectionId), 0, 50).rows.map((r) => r.title)),
  ).toEqual([['First'], ['Second']]);
  const cohorts = required(await session.view(request({ view: 'cohorts' }), work));
  const heat = required(cohorts.sections[0]?.charts[0]);
  expect(heat.intensityScale).toEqual({ domain: [0, 100], unit: '%' });
  expect(heat.marks[0]).toMatchObject({ denominator: 2, displayText: '0%' });
});
it('separates current outcomes of new tasks from event totals in a three-part composition', async () => {
  const ds = required(
    await prepareStatisticsDataset(
      source([
        task('Open', { planning: { created: date('2026-10-01') } }),
        task('Done', {
          status: 'done',
          planning: { created: date('2026-10-01'), completion: date('2026-10-02') },
        }),
        task('Cancelled', {
          status: 'cancelled',
          statusSymbol: '-',
          planning: { created: date('2026-10-01'), cancelled: date('2026-10-02') },
        }),
      ]),
      [],
      work,
    ),
  );
  const view = required(await new StatisticsSession(ds).view(request(), work));
  const section = required(view.sections.find((section) => section.id === 'new-outcomes'));
  expect(view.sections[0]?.metrics.map((metric) => metric.id)).not.toContain('new-open');
  expect(section.charts[0]?.marks.map((mark) => mark.weight)).toEqual([1, 1, 1]);
  expect(
    section.charts[0]?.marks.map(
      (mark) => view.evidence(required(mark.selectionId), 0, 50).rows[0]?.title,
    ),
  ).toEqual(['Open', 'Done', 'Cancelled']);
});
