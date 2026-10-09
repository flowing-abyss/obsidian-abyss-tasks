import { expect, it } from 'vitest';
import { prepareStatisticsDataset } from '../src/statistics/statisticsDataset';
import { StatisticsSession } from '../src/statistics/statisticsSession';
import { required } from '../src/statistics/statisticsWork';
import { date, request, source, task, work } from './helpers/statisticsFixtures';

async function session() {
  return new StatisticsSession(
    required(
      await prepareStatisticsDataset(
        source(
          [
            task('Active', { planning: { created: date('2026-10-01') }, dependsOn: ['blocker'] }),
            task('Paused', { planning: { created: date('2026-10-02') }, dependencyId: 'blocker' }),
            task('Custom', { planning: { created: date('2026-10-03') } }),
            task('No status', { planning: { created: date('2026-10-03') } }),
            task('Outside', { planning: { created: date('2026-10-03') } }),
          ],
          [task('Archived', { planning: { created: date('2026-10-01') } })],
        ),
        [
          { path: 'Active.md', name: 'Active project', statusKey: 'id:active' },
          { path: 'Paused.md', name: 'Paused project', statusKey: 'id:paused' },
          { path: 'Custom.md', name: 'Custom project', statusKey: 'raw:Waiting' },
          { path: 'No status.md', name: 'Unclassified project', statusKey: 'none' },
        ],
        work,
      ),
    ),
  );
}

it.each(['movement', 'aging', 'dependencies'] as const)(
  'filters %s and its evidence by current project status',
  async (view) => {
    const model = required(
      await (await session()).view(request({ view, projectStatus: 'id:active' }), work),
    );
    expect(model.coverage.scope.nodes).toBe(1);
    const metrics = model.sections.flatMap((section) => section.metrics);
    if (view === 'movement') {
      const chart = required(model.sections[0]?.charts[0]);
      expect(model.sections[0]?.charts).toHaveLength(1);
      expect(chart.facet?.label).toBe('Active project');
      const mark = required(chart.marks.find((item) => item.series === 'created' && item.y === 1));
      expect(
        model.evidence(required(mark.selectionId), 0, 50).rows.map((row) => row.title),
      ).toEqual(['Active']);
      expect(metrics.find((item) => item.id === 'created-known')?.value).toBe(1);
      expect(model.evidence('created-known', 0, 50).rows.map((row) => row.title)).toEqual([
        'Active',
      ]);
    } else if (view === 'aging') {
      expect(model.evidence('open-now', 0, 50).rows.map((row) => row.title)).toEqual(['Active']);
    } else {
      expect(metrics.find((item) => item.id === 'waiting')?.value).toBe(1);
      const blocker = required(model.sections[0]?.charts[0]?.marks[0]);
      expect(blocker.label).toBe('Paused');
    }
  },
);

it.each([
  ['raw:Waiting', 'Custom project'],
  ['none', 'Unclassified project'],
  ['id:removed', undefined],
] as const)(
  'keeps %s separate from tasks outside projects and archived tasks',
  async (projectStatus, label) => {
    const model = required(
      await (await session()).view(request({ view: 'movement', projectStatus }), work),
    );
    expect(model.coverage.scope.nodes).toBe(label === undefined ? 0 : 1);
    expect(model.sections[0]?.charts.map((chart) => chart.facet?.label)).toEqual(
      label === undefined ? [] : [label],
    );
  },
);

it('invalidates cached project results without applying their status filter to Flow or Time', async () => {
  const model = await session();
  const all = request({ view: 'movement' });
  expect(required(await model.view(all, work)).coverage.scope.nodes).toBe(6);
  const active = required(await model.view({ ...all, projectStatus: 'id:active' }, work));
  expect(active.coverage.scope.nodes).toBe(1);
  expect(await model.view({ ...all, projectStatus: 'id:active' }, work)).toBe(active);
  expect(required(await model.view(all, work)).coverage.scope.nodes).toBe(6);
  for (const view of ['rhythm', 'allocation'] as const) {
    const unfiltered = required(await model.view(request({ view }), work));
    expect(await model.view(request({ view, projectStatus: 'id:active' }), work)).toBe(unfiltered);
    expect(unfiltered.coverage.scope.nodes).toBe(6);
  }
});

it('keeps prerequisites from other project statuses as context without counting them as filtered work', async () => {
  const model = await session();
  const selection = request({ view: 'dependencies', projectStatus: 'id:active' });
  const overview = required(await model.view(selection, work));
  const action = required(overview.chartActions[0]?.[1]);
  if (action.type !== 'chain') throw new Error('Expected a prerequisite action');
  const focused = required(await model.view({ ...selection, focusKey: action.focusKey }, work));
  const network = required(focused.sections[0]?.charts.find((chart) => chart.kind === 'network'));
  expect(network.series.find((item) => item.key === 'focus')?.label).toContain('Outside scope');
  expect(network.marks.map((mark) => mark.label)).toEqual(['Paused', 'Active']);
  expect(focused.evidence('downstream', 0, 50).rows.map((row) => row.title)).toEqual(['Active']);
});
