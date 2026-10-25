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
