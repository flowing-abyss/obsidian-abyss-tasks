import { expect, it } from 'vitest';
import { indexedRows } from '../src/panels/task-list/taskListRows';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { buildTaskTimelineRows } from '../src/task-lists/taskTimelineRows';
import { defaultTaskTimelineSettings } from '../src/task-lists/taskTimelineSettings';
import { localDate, type TaskPlanning } from '../src/tasks';
it('filters status and truly undated tasks while retaining exact grouped row identities', () => {
  const tasks = [
    { statusSymbol: ' ', planning: { due: localDate('2026-10-26') } },
    { statusSymbol: 'x', planning: {} },
    { statusSymbol: ' ', planning: {} },
    { statusSymbol: ' ', planning: { scheduled: localDate('2026-10-28') } },
  ] satisfies Array<{ statusSymbol: string; planning: TaskPlanning }>;
  const rows = indexedRows([
    { kind: 'group' as const, key: 'g', label: 'Group', count: 4, first: true },
    ...tasks.map((task, i) => ({
      kind: 'task' as const,
      key: `n:${i}`,
      taskKey: `n:${i}`,
      task,
      groupKey: 'g',
    })),
  ]);
  const settings = {
    ...defaultTaskTimelineSettings(),
    showUnscheduled: false,
    hiddenStatuses: ['done'],
  };
  const result = buildTaskTimelineRows(rows, settings, DEFAULT_SETTINGS.taskStatuses, (v) => v);
  expect(result.taskCount).toBe(2);
  expect(result.rowAt(0)).toMatchObject({ kind: 'group', key: 'g', count: 2 });
  expect(result.rowAt(1)).toBe(rows.rowAt(1));
  expect(result.rowAt(2)).toBe(rows.rowAt(4));
});
it.each(['asc', 'desc'] as const)(
  'orders timeline dates by Start then Due (%s), with undated rows last',
  (dir) => {
    const tasks: Array<{ statusSymbol: string; planning: TaskPlanning }> = [
      {
        statusSymbol: ' ',
        planning: { start: localDate('2026-10-28'), due: localDate('2026-10-29') },
      },
      { statusSymbol: ' ', planning: {} },
      {
        statusSymbol: ' ',
        planning: { start: localDate('2026-10-26'), due: localDate('2026-10-30') },
      },
      {
        statusSymbol: ' ',
        planning: { start: localDate('2026-10-26'), due: localDate('2026-10-27') },
      },
      { statusSymbol: ' ', planning: { due: localDate('2026-10-27') } },
      { statusSymbol: ' ', planning: { scheduled: localDate('2026-10-31') } },
      {
        statusSymbol: ' ',
        planning: { start: localDate('2026-10-26'), due: localDate('2026-10-27') },
      },
    ];
    const rows = indexedRows(
      tasks.map((task, i) => ({ kind: 'task' as const, key: String(i), taskKey: String(i), task })),
    );
    const result = buildTaskTimelineRows(
      rows,
      { ...defaultTaskTimelineSettings(), sortBy: { field: 'date', dir } },
      [],
      (v) => v,
    );
    expect([...result.slice(0, result.rowCount)].map((row) => row.key)).toEqual(
      dir === 'asc' ? ['3', '6', '2', '4', '0', '5', '1'] : ['5', '0', '4', '2', '3', '6', '1'],
    );
  },
);
