import { expect, it, vi } from 'vitest';
import { StatisticsEvidence } from '../src/panels/statistics/StatisticsEvidence';
import { prepareStatisticsDataset, StatisticsSession } from '../src/statistics';
import { required } from '../src/statistics/statisticsWork';
import type { TaskStatisticsSource } from '../src/tasks';
import { closed, date, request, source, task, work } from './helpers/statisticsFixtures';
it('renders one shared live root with exact matched children, and archives have source-only actions', async () => {
  const root = task('Root');
  const children = [0, 1].map((index) => ({
    ...task(`Child ${index}`, { planning: { created: date('2026-10-01') } }),
    ref: {
      parent: { type: 'task' as const, ref: root.ref },
      relativeLine: index + 1,
      originalBlock: `child${index}`,
    },
  }));
  const live = { ...root, subtasks: children };
  const archived = task('Archived', { planning: { created: date('2026-10-01') } });
  const snapshot = source([live], [archived]);
  let current = true;
  const port: TaskStatisticsSource = {
    readStatistics: () => snapshot,
    isStatisticsCurrent: () => current,
    whenStatisticsSettled: async () => {},
    refreshStatistics: async () => {},
    subscribeStatistics: () => () => {},
  };
  const queries = {
    resolve: vi.fn(() =>
      current
        ? { type: 'exact' as const, task: live, basis: { observed: live } }
        : { type: 'not-found' as const, ref: live.ref },
    ),
  };
  const host = { renderRoot: vi.fn(), select: vi.fn(), openSource: vi.fn(async () => {}) };
  const evidence = new StatisticsEvidence(port, queries, host);
  const dataset = required(await prepareStatisticsDataset(snapshot, [], work));
  const model = required(await new StatisticsSession(dataset).view(request(), work));
  const element = document.body.createDiv();
  evidence.render(element, model, 'created', vi.fn());
  expect(host.renderRoot).toHaveBeenCalledTimes(1);
  expect(element.textContent).toContain('3 matching records');
  expect(element.textContent).toContain('2 matched subtask records shown');
  const buttons = [...element.querySelectorAll('button')];
  buttons.find((button) => button.textContent.includes('Child 1'))?.click();
  expect(host.select).toHaveBeenCalledWith([live, children[1]]);
  buttons.find((button) => button.textContent.includes('Archived'))?.click();
  expect(host.openSource).toHaveBeenCalledWith('Archived.md', 0);
  expect(queries.resolve).not.toHaveBeenCalledWith(archived.ref);
  current = false;
  buttons.find((button) => button.textContent.includes('Child 0'))?.click();
  buttons.find((button) => button.textContent.includes('Archived'))?.click();
  expect(host.select).toHaveBeenCalledTimes(1);
  expect(host.openSource).toHaveBeenCalledTimes(1);
  expect(element.textContent).toContain('changed or was removed');
  element.remove();
});
it('pages physical source rows in batches of 50 and retains occurrence-specific keys', async () => {
  const nodes = Array.from({ length: 101 }, (_, i) =>
    task(`Task${i}`, { planning: { created: date('2026-10-01') } }),
  );
  const snapshot = source([], nodes);
  const port: TaskStatisticsSource = {
    readStatistics: () => snapshot,
    isStatisticsCurrent: () => true,
    whenStatisticsSettled: async () => {},
    refreshStatistics: async () => {},
    subscribeStatistics: () => () => {},
  };
  const model = required(
    await new StatisticsSession(required(await prepareStatisticsDataset(snapshot, [], work))).view(
      request(),
      work,
    ),
  );
  const element = document.body.createDiv();
  new StatisticsEvidence(
    port,
    { resolve: (ref) => ({ type: 'not-found', ref }) },
    { renderRoot: vi.fn(), select: vi.fn(), openSource: async () => {} },
  ).render(element, model, 'created', vi.fn());
  expect(element.querySelectorAll('[data-evidence-key]')).toHaveLength(50);
  [...element.querySelectorAll('button')]
    .find((button) => button.textContent === 'Load more')
    ?.click();
  expect(element.querySelectorAll('[data-evidence-key]')).toHaveLength(100);
  [...element.querySelectorAll('button')]
    .find((button) => button.textContent === 'Load more')
    ?.click();
  expect(element.querySelectorAll('[data-evidence-key]')).toHaveLength(101);
  element.remove();
});

it('renders repeated owner changes as distinct native evidence rows with their event context', async () => {
  const snapshot = source(
    [],
    [
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
    ],
  );
  const model = required(
    await new StatisticsSession(required(await prepareStatisticsDataset(snapshot, [], work))).view(
      request({ view: 'sessions' }),
      work,
    ),
  );
  const port: TaskStatisticsSource = {
    readStatistics: () => snapshot,
    isStatisticsCurrent: () => true,
    whenStatisticsSettled: async () => {},
    refreshStatistics: async () => {},
    subscribeStatistics: () => () => {},
  };
  const element = document.body.createDiv();
  new StatisticsEvidence(
    port,
    { resolve: (ref) => ({ type: 'not-found', ref }) },
    { renderRoot: vi.fn(), select: vi.fn(), openSource: async () => {} },
  ).render(element, model, 'recorded-changes', vi.fn());
  const rows = [...element.querySelectorAll<HTMLElement>('[data-evidence-key]')];
  expect(rows).toHaveLength(3);
  expect(new Set(rows.map((row) => row.dataset['evidenceKey'])).size).toBe(3);
  for (const [index, row] of model.evidence('recorded-changes', 0, 50).rows.entries())
    expect(rows[index]?.textContent).toContain(new Date(required(row.atMs)).toLocaleString('en'));
  element.remove();
});
