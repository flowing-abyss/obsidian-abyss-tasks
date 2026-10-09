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
  expect(
    view?.sections
      .find((s) => s.id === 'new-outcomes')
      ?.charts[0]?.marks.find((m) => m.key === 'new-open')?.weight,
  ).toBe(2);
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
  expect(view?.sections[0]?.charts[0]?.series.map((s) => s.key)).toEqual([
    'created',
    'completed',
    'cancelled',
  ]);
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
  const first = required(
    await session.view(request({ view: 'cohorts', period: 'all', cohortsExpanded: true }), work),
  );
  expect(required(first.sections[0]).charts[0]?.marks).toHaveLength(520);
  expect(first.actions).toContainEqual({ type: 'page', label: 'Older weeks', page: 1 });
  const second = required(
    await session.view(
      request({ view: 'cohorts', period: 'all', page: 1, cohortsExpanded: true }),
      work,
    ),
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
it('separates current outcomes of new tasks from event totals in a four-status composition', async () => {
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
  expect(section.charts[0]?.marks.map((mark) => mark.weight)).toEqual([1, 0, 1, 1]);
  expect(
    section.charts[0]?.marks.map(
      (mark) => view.evidence(required(mark.selectionId), 0, 50).rows[0]?.title,
    ),
  ).toEqual(['Open', undefined, 'Done', 'Cancelled']);
});
it('keeps event/new-cohort/current populations together and deadline outcome paints distinct', async () => {
  const { statisticsSeriesPaint } = await import('../src/panels/statistics/statisticsFormat');
  const ds = required(
    await prepareStatisticsDataset(
      source([task('New', { planning: { created: date('2026-10-01'), due: date('2026-10-03') } })]),
      [],
      work,
    ),
  );
  const session = new StatisticsSession(ds);
  const rhythm = required(await session.view(request(), work));
  expect(rhythm.sections.map((s) => s.id)).toEqual(['events', 'new-outcomes', 'current']);
  expect(rhythm.sections[0]?.metrics.some((m) => m.id === 'open-now')).toBe(false);
  expect(rhythm.sections[2]?.metrics.find((m) => m.id === 'open-now')?.value).toBe(1);
  const deadlines = required(await session.view(request({ view: 'deadlines' }), work));
  const outcomes = required(deadlines.sections[0]?.charts[0]);
  expect(
    new Set(outcomes.series.map((series) => statisticsSeriesPaint(series, outcomes.series))).size,
  ).toBe(6);
});

it('shows three dated event series and four exclusive current creation outcomes', async () => {
  const nodes = [
    task('open', { planning: { created: date('2026-10-05') } }),
    task('progress', { status: 'in-progress', planning: { created: date('2026-10-06') } }),
    task('done', {
      status: 'done',
      recurrence: 'every day',
      planning: { created: date('2026-10-06'), completion: date('2026-10-08') },
    }),
    task('cancelled', {
      status: 'cancelled',
      planning: { created: date('2026-10-07'), cancelled: date('2026-10-09') },
    }),
  ];
  const parent = required(nodes[2]);
  const child = task('child', {
    status: 'done',
    planning: { created: date('2026-10-06'), completion: date('2026-10-08') },
  });
  nodes[2] = {
    ...parent,
    subtasks: [
      {
        ...child,
        ref: { parent: { type: 'task', ref: parent.ref }, relativeLine: 1, originalBlock: 'child' },
      },
    ],
  };
  const ds = required(await prepareStatisticsDataset(source(nodes), [], work));
  const view = required(
    await new StatisticsSession(ds).view(
      request({ period: 'week', nowMs: Date.parse('2026-10-09T12:00Z') }),
      work,
    ),
  );
  const chart = required(view.sections[0]?.charts[0]);
  expect(chart.series.map((s) => s.label)).toEqual(['Created', 'Completed', 'Cancelled']);
  expect(chart.marks).toHaveLength(15);
  expect(chart.marks.find((m) => m.key === 'created:1')?.observation).toMatchObject({
    title: '2026-10-06 · Created',
    values: [{ label: 'Count', value: 3, unit: 'tasks' }],
  });
  expect(chart.marks.find((m) => m.key === 'completed:0')?.observation?.values[0]?.value).toBe(0);
  const outcomes = required(view.sections.find((s) => s.id === 'new-outcomes'));
  expect(outcomes.charts[0]?.series.map((s) => s.label)).toEqual([
    'Not started',
    'In progress',
    'Completed',
    'Cancelled',
  ]);
  expect(outcomes.charts[0]?.marks.map((m) => m.weight)).toEqual([1, 1, 2, 1]);
  expect(outcomes.metrics).toEqual([]);
  expect(view.evidence('created:1', 0, 50).rows.map((row) => row.title)).toEqual([
    'progress',
    'done',
    'child',
  ]);
  expect(chart.marks.find((m) => m.key === 'created:1')?.observation?.note).toContain(
    '2 recurring',
  );
  expect(view.evidence('in-progress-now', 0, 50).rows.map((r) => r.title)).toEqual(['progress']);
});

it('separates in-period creation defects from scope-wide undatable completions with exact reasons', async () => {
  const snapshot = source([
    task('measured', {
      status: 'done',
      planning: { created: date('2026-10-09'), completion: date('2026-10-09') },
    }),
    task('missing-created', { status: 'done', planning: { completion: date('2026-10-08') } }),
    task('invalid-created', {
      status: 'done',
      planning: { created: date('2026-10-06'), completion: date('2026-10-08') },
    }),
    task('reversed', {
      status: 'done',
      planning: { created: date('2026-10-09'), completion: date('2026-10-08') },
    }),
    task('missing-completion', { status: 'done', planning: { created: date('2020-01-01') } }),
    task('invalid-completion', { status: 'done', planning: { completion: date('2026-10-08') } }),
    task('future-completion', { status: 'done', planning: { completion: date('2026-10-10') } }),
  ]);
  const files = snapshot.files.map((f) => {
    if (f.path === 'measured.md')
      return {
        ...f,
        dateIssues: [{ line: 0, field: 'due' as const, reason: 'invalid-date' as const }],
      };
    if (f.path === 'invalid-created.md')
      return {
        ...f,
        dateIssues: [{ line: 0, field: 'created' as const, reason: 'ambiguous-date' as const }],
      };
    if (f.path === 'invalid-completion.md')
      return {
        ...f,
        dateIssues: [{ line: 0, field: 'completion' as const, reason: 'invalid-date' as const }],
      };
    return f;
  });
  const ds = required(await prepareStatisticsDataset({ ...snapshot, files }, [], work));
  const session = new StatisticsSession(ds);
  const week = required(
    await session.view(
      request({ view: 'completion', period: 'week', nowMs: Date.parse('2026-10-09T12:00Z') }),
      work,
    ),
  );
  const metrics = week.sections.flatMap((s) => s.metrics);
  expect(metrics.find((m) => m.id === 'valid-pairs')?.value).toBe(1);
  expect(metrics.find((m) => m.id === 'missing-pairs')?.value).toBe(3);
  for (const [id, title, reason] of [
    ['creation-missing', 'missing-created', 'Creation date missing'],
    ['creation-invalid', 'invalid-created', 'Creation date invalid or ambiguous'],
    ['creation-reversed', 'reversed', 'Completion before creation'],
    ['completion-missing', 'missing-completion', 'Completion date missing'],
    ['completion-invalid', 'invalid-completion', 'Completion date invalid or ambiguous'],
    ['completion-future', 'future-completion', 'Completion date after today'],
  ])
    expect(week.evidence(required(id), 0, 50).rows).toMatchObject([{ title, context: reason }]);
  const today = required(
    await session.view(
      request({ view: 'completion', period: 'today', nowMs: Date.parse('2026-10-09T12:00Z') }),
      work,
    ),
  );
  expect(today.sections[0]?.metrics.find((m) => m.id === 'missing-pairs')?.value).toBe(0);
  expect(today.evidence('completion-missing', 0, 50).total).toBe(1);
  const empty = required(
    await session.view(
      request({ view: 'completion', period: 'today', nowMs: Date.parse('2026-10-10T12:00Z') }),
      work,
    ),
  );
  expect(empty.sections[0]?.emptyMessage).toBeDefined();
});

it('roundtrips recent and expanded cohorts without changing dates or denominators and bounds windows', async () => {
  const nodes = Array.from({ length: 105 }, (_, i) =>
    task(`cohort${i}`, {
      planning: {
        created: date(
          new Date(Date.parse('2024-01-01') + i * 7 * 86400000).toISOString().slice(0, 10),
        ),
      },
    }),
  );
  const session = new StatisticsSession(
    required(await prepareStatisticsDataset(source(nodes), [], work)),
  );
  const req = request({ view: 'cohorts', period: 'all' });
  const recent = required(await session.view(req, work));
  const expanded = required(await session.view({ ...req, cohortsExpanded: true }, work));
  const again = required(await session.view(req, work));
  const marks = (view: typeof recent) => required(view.sections[0]?.charts[0]).marks;
  expect(marks(recent)).toHaveLength(40);
  expect(marks(expanded)).toHaveLength(520);
  expect(expanded.dateLabel).toBe(recent.dateLabel);
  const existing = required(marks(recent)[0]);
  expect(required(marks(expanded).find((m) => m.key === existing.key)).denominator).toBe(
    existing.denominator,
  );
  expect(again.sections).toEqual(recent.sections);
  expect(expanded.actions).toContainEqual({
    type: 'cohorts',
    label: 'Show recent cohorts',
    expanded: false,
  });
  expect(expanded.actions).toContainEqual({ type: 'page', label: 'Older weeks', page: 1 });
  const stale = required(await session.view({ ...req, cohortsExpanded: true, page: 99 }, work));
  expect(marks(stale)).toHaveLength(5);
});

it('labels partial cohort weeks with included dates and offers no expansion for eight or fewer', async () => {
  const session = new StatisticsSession(
    required(
      await prepareStatisticsDataset(
        source([task('partial', { planning: { created: date('2026-09-10') } })]),
        [],
        work,
      ),
    ),
  );
  const view = required(
    await session.view(
      request({ view: 'cohorts', period: '30d', nowMs: Date.parse('2026-10-09T12:00Z') }),
      work,
    ),
  );
  expect(view.actions).toEqual([]);
  const cell = required(view.sections[0]?.charts[0]?.marks[0]);
  expect(cell.observation?.title).toContain('2026-09-10 – 2026-09-13');
  expect(cell.observation?.note).toContain('Partial week');
  expect(cell.observation?.values).toContainEqual({ label: 'Cohort', value: 1, unit: 'tasks' });
});

it('labels due-today outcomes and measures lateness by completion period independently of due period', async () => {
  const ds = required(
    await prepareStatisticsDataset(
      source([
        task('today', { planning: { due: date('2026-10-09') } }),
        task('old-due', {
          status: 'done',
          planning: { due: date('2026-09-01'), completion: date('2026-10-09') },
        }),
      ]),
      [],
      work,
    ),
  );
  const view = required(
    await new StatisticsSession(ds).view(
      request({ view: 'deadlines', period: 'today', nowMs: Date.parse('2026-10-09T12:00Z') }),
      work,
    ),
  );
  expect(view.sections[0]?.charts[0]?.series.find((s) => s.key === 'upcoming')?.label).toBe(
    'Due today',
  );
  expect(view.sections[0]?.charts[0]?.series.find((s) => s.key === 'overdue')?.label).toBe(
    'Due cohort · overdue',
  );
  const lateness = required(view.sections.find((s) => s.id === 'lateness'));
  expect(lateness.charts[0]?.marks.reduce((sum, m) => sum + Number(m.y), 0)).toBe(1);
  expect(lateness.reading).toContain('completed in this period');
});

it('reports the actual inclusive partial weekly interval and zero counts without inventing daily rates', async () => {
  const session = new StatisticsSession(
    required(
      await prepareStatisticsDataset(
        source([
          task('monday', { planning: { created: date('2026-10-05') } }),
          task('friday', { planning: { created: date('2026-10-09') } }),
        ]),
        [],
        work,
      ),
    ),
  );
  const view = required(
    await session.view(request({ period: '90d', nowMs: Date.parse('2026-10-09T12:00Z') }), work),
  );
  const chart = required(view.sections[0]?.charts[0]);
  const mark = required(chart.marks.find((m) => m.series === 'created' && m.x === '2026-10-05'));
  expect(mark.observation?.title).toBe('2026-10-05 – 2026-10-09 · Created');
  expect(mark.observation?.values).toEqual([{ label: 'Count', value: 2, unit: 'tasks' }]);
  expect(mark.observation?.note).toContain('Partial week');
  expect(view.evidence(required(mark.selectionId), 0, 50).rows.map((r) => r.title)).toEqual([
    'monday',
    'friday',
  ]);
});

it('keeps unavailable due dates in separate missing and authored-invalid coverage', async () => {
  const snapshot = source([
    task('absent'),
    task('invalid', { planning: { due: date('2026-10-01') } }),
  ]);
  const files = snapshot.files.map((f) =>
    f.path === 'invalid.md'
      ? { ...f, dateIssues: [{ line: 0, field: 'due' as const, reason: 'invalid-date' as const }] }
      : f,
  );
  const session = new StatisticsSession(
    required(await prepareStatisticsDataset({ ...snapshot, files }, [], work)),
  );
  const view = required(await session.view(request({ view: 'deadlines' }), work));
  expect(view.evidence('due-missing', 0, 50).rows).toMatchObject([
    { title: 'absent', context: 'No due date' },
  ]);
  expect(view.evidence('due-invalid', 0, 50).rows).toMatchObject([
    { title: 'invalid', context: 'Due date invalid or ambiguous' },
  ]);
});

it('measures literal age boundaries including physical children and archive while excluding recurring descendants', async () => {
  const ages = [0, 1, 3, 4, 7, 8, 14, 15, 30, 31, 60, 61];
  const nodes = ages.map((age, i) =>
    task(`age${i}`, {
      status: 'done',
      planning: {
        created: date(
          new Date(Date.parse('2026-10-09') - age * 86400000).toISOString().slice(0, 10),
        ),
        completion: date('2026-10-09'),
      },
    }),
  );
  const parent = required(nodes.shift()),
    child = required(nodes.shift()),
    archived = required(nodes.pop());
  const repeating = task('recurring-root', {
    recurrence: 'every day',
    status: 'done',
    planning: { created: date('2026-10-09'), completion: date('2026-10-09') },
  });
  const nested = (root: typeof parent, node: typeof child) => ({
    ...node,
    ref: {
      parent: { type: 'task' as const, ref: root.ref },
      relativeLine: 1,
      originalBlock: node.title,
    },
  });
  const snapshot = source(
    [
      { ...parent, subtasks: [nested(parent, child)] },
      ...nodes,
      {
        ...repeating,
        subtasks: [
          nested(
            repeating,
            task('recurring-child', {
              status: 'done',
              planning: { created: date('2026-10-09'), completion: date('2026-10-09') },
            }),
          ),
        ],
      },
    ],
    [archived],
  );
  const view = required(
    await new StatisticsSession(required(await prepareStatisticsDataset(snapshot, [], work))).view(
      request({ view: 'completion', period: 'today', nowMs: Date.parse('2026-10-09T12:00Z') }),
      work,
    ),
  );
  const section = required(view.sections[0]),
    marks = required(section.charts[0]).marks;
  expect(marks.map((mark) => mark.y)).toEqual([1, 1, 1, 2, 2, 2, 2, 1]);
  expect(section.metrics.find((m) => m.id === 'valid-pairs')?.value).toBe(12);
  expect(section.metrics.find((m) => m.id === 'median')?.value).toBe(11);
  expect(section.metrics.find((m) => m.id === 'p90')?.value).toBe(60);
  expect(marks.map((mark) => view.evidence(required(mark.selectionId), 0, 50).total)).toEqual([
    1, 1, 1, 2, 2, 2, 2, 1,
  ]);
  expect(view.evidence('valid-pairs', 0, 50).rows.map((row) => row.title)).not.toContain(
    'recurring-child',
  );
});
