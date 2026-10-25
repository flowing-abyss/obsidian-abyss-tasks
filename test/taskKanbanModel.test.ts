import { describe, expect, it } from 'vitest';
import { indexedRows, type TaskListTaskRow } from '../src/panels/task-list/taskListRows';
import type { ListViewState, TaskStatusDef } from '../src/settings/types';
import { buildTaskKanbanModel } from '../src/task-lists/taskKanbanModel';
import {
  defaultTaskKanbanSettings,
  normalizeTaskKanbanSettings,
  taskCollectionListState,
} from '../src/task-lists/taskKanbanSettings';
import type { TaskPriority } from '../src/tasks';

interface Value {
  readonly statusSymbol: string;
  readonly priority: TaskPriority;
}
const statuses: TaskStatusDef[] = [
  { id: 'todo', symbol: ' ', name: 'To do', type: 'todo', icon: '', core: true },
  { id: 'doing', symbol: '/', name: 'Doing', type: 'in-progress', icon: 'circle-dot', core: false },
  { id: 'done', symbol: 'x', name: 'Done', type: 'done', icon: 'check', core: true },
];
function row(key: string, symbol: string, priority: TaskPriority = 'D'): TaskListTaskRow<Value> {
  return { kind: 'task', key, taskKey: key, task: { statusSymbol: symbol, priority } };
}
describe('task Kanban organization', () => {
  it('keeps active List preferences independent while sharing explicit filters', () => {
    const legacy: ListViewState = {
      groupBy: 'date',
      sortBy: { field: 'title', dir: 'desc' },
      filters: [{ type: 'tag', value: '#work' }],
      statusGroups: ['todo', 'in-progress'],
    };
    const board = taskCollectionListState({ ...legacy, view: 'kanban' });
    expect(board).toMatchObject({
      groupBy: 'none',
      sortBy: { field: 'priority', dir: 'asc' },
      filters: [{ type: 'tag', value: '#work' }],
    });
    expect(board.statusGroups).toBeUndefined();
    expect(taskCollectionListState(legacy)).toBe(legacy);
    expect(legacy.statusGroups).toEqual(['todo', 'in-progress']);
    expect(legacy.sortBy).toEqual({ field: 'title', dir: 'desc' });
  });
  it('keeps empty custom columns and unknown symbols without duplicating physical nodes', () => {
    const first = row('note:1', ' ');
    const model = buildTaskKanbanModel(
      indexedRows([
        first,
        row('note:2', '/'),
        { ...first, key: 'second-occurrence' },
        row('note:3', '?'),
      ]),
      statuses,
      defaultTaskKanbanSettings(),
      (v) => v,
    );
    expect(model.columns.map((c) => [c.key, c.rows.taskCount])).toEqual([
      ['status:todo', 1],
      ['status:doing', 1],
      ['status:done', 0],
      ['unknown:?', 1],
    ]);
    expect(model.rows.taskCount).toBe(3);
    expect(model.rows.task('note:1')).toBe(first.task);
    expect(model.columns[3]?.status).toBeUndefined();
  });
  it('groups by priority inside each status while retaining the exact row and completion policy', () => {
    const first = {
      ...row('one', '/', 'A'),
      presentation: {
        kind: 'today' as const,
        displayDate: '2026-10-25' as never,
        completion: { kind: 'allowed' as const },
      },
    };
    const model = buildTaskKanbanModel(
      indexedRows([row('two', '/', 'D'), first, row('three', '/', 'A')]),
      statuses,
      { ...defaultTaskKanbanSettings(), groupBy: 'priority' },
      (v) => v,
    );
    const column = model.columns[1];
    expect(
      Array.from(column?.rows.slice(0, 20) ?? []).map((r) =>
        r.kind === 'group' ? r.label : r.key,
      ),
    ).toEqual(['Highest', 'one', 'three', 'Normal', 'two']);
    expect(model.rows.rowAt(1)).toBe(first);
  });
  it('hides selected statuses without hiding unknown symbols or changing input', () => {
    const rows = indexedRows([row('one', 'x'), row('two', '?')]);
    const model = buildTaskKanbanModel(
      rows,
      statuses,
      { ...defaultTaskKanbanSettings(), hiddenStatuses: ['done'], collapsedColumns: ['doing'] },
      (v) => v,
    );
    expect(model.columns.map((c) => c.key)).toEqual(['status:todo', 'status:doing', 'unknown:?']);
    expect(model.rows.taskCount).toBe(1);
    expect(rows.taskCount).toBe(2);
  });
  it('normalizes malformed board values independently and detaches mutable defaults', () => {
    const value = normalizeTaskKanbanSettings({
      sortBy: { field: 'bad', dir: 'wrong' },
      hiddenStatuses: ['doing', 8, 'doing'],
      descriptionLines: 99,
      groupBy: 'tag',
    });
    expect(value).toEqual({ ...defaultTaskKanbanSettings(), hiddenStatuses: ['doing'] });
    value.hiddenStatuses.push('done');
    expect(defaultTaskKanbanSettings().hiddenStatuses).toEqual([]);
  });
});
