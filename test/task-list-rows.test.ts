// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  buildTaskListRows,
  NO_TASK_LIST_ROWS,
  rebaseTaskRowKey,
  taskListGrouping,
  taskRowKey,
  taskStackRowKey,
  type TaskListGrouping,
  type TaskListRows,
} from '../src/panels/task-list/taskListRows';
import { buildDefaultTaskStatuses } from '../src/settings/defaults';
import { StatusRegistry } from '../src/status/StatusRegistry';
import type { TaskSnapshot } from '../src/tasks';
import { expectDefined, subtask, task, type TaskFixtureInput } from './helpers';

const TODAY = '2026-06-26';
const TOMORROW = '2026-06-27';
const statuses = new StatusRegistry(buildDefaultTaskStatuses());
const byDate: TaskListGrouping = { by: 'date', today: TODAY, tomorrow: TOMORROW };

/** A root task on `line` of list.md. */
function at(line: number, overrides: TaskFixtureInput = {}): TaskSnapshot {
  return task({ title: `task ${line}`, ...overrides, source: { filePath: 'list.md', line } });
}

/** Each row as its key, and a header also as `label | count`, plus `| first` on the first one. */
function describeRows(list: TaskListRows): string[] {
  return list.rows.map((row) => {
    if (row.kind === 'task') return row.key;
    const header = `${row.key} | ${row.label} | ${row.count}`;
    return row.first ? `${header} | first` : header;
  });
}

describe('taskRowKey', () => {
  it('keys a root task by its note and line', () => {
    expect(taskRowKey(at(3))).toBe('list.md:3');
  });
});

describe('buildTaskListRows', () => {
  it('keeps the input order without headers when ungrouped', () => {
    const list = buildTaskListRows([at(2), at(0), at(1)], { by: 'none' });

    expect(describeRows(list)).toEqual(['list.md:2', 'list.md:0', 'list.md:1']);
    expect(list.taskKeys).toEqual(['list.md:2', 'list.md:0', 'list.md:1']);
  });

  it('puts date headers in fixed order with counts, the first flag, and no empty bucket', () => {
    const list = buildTaskListRows(
      [
        at(4, { planning: { due: '2026-07-05' } }),
        at(3, { planning: { due: '2026-06-25' } }),
        at(1),
        at(0, { planning: { due: '2026-06-20' } }),
        at(2, { planning: { due: TODAY } }),
      ],
      byDate,
    );

    expect(describeRows(list)).toEqual([
      'group:date:Overdue | Overdue | 2 | first',
      'list.md:3',
      'list.md:0',
      'group:date:Today | Today | 1',
      'list.md:2',
      'group:date:Upcoming | Upcoming | 1',
      'list.md:4',
      'group:date:No date | No date | 1',
      'list.md:1',
    ]);
    expect(list.taskKeys).toEqual([
      'list.md:3',
      'list.md:0',
      'list.md:2',
      'list.md:4',
      'list.md:1',
    ]);
  });

  it('groups by priority in priority order', () => {
    const list = buildTaskListRows(
      [at(0, { priority: 'C' }), at(1, { priority: 'A' }), at(2, { priority: 'C' })],
      { by: 'priority' },
    );

    expect(describeRows(list)).toEqual([
      'group:priority:A | 🔺 Highest | 1 | first',
      'list.md:1',
      'group:priority:C | 🔼 Medium | 2',
      'list.md:0',
      'list.md:2',
    ]);
  });

  it('keys status headers by status id, so two statuses sharing a name stay distinct', () => {
    const shared = new StatusRegistry([
      ...buildDefaultTaskStatuses(),
      { id: 'status-5', symbol: '?', name: 'To-do', type: 'todo', icon: '', core: false },
    ]);
    const list = buildTaskListRows(
      [at(0, { statusSymbol: '?' }), at(1, { statusSymbol: '@' }), at(2, { statusSymbol: ' ' })],
      { by: 'status', statuses: shared },
    );

    expect(describeRows(list)).toEqual([
      'group:status:status-1 | To-do | 1 | first',
      'list.md:2',
      'group:status:status-5 | To-do | 1',
      'list.md:0',
      'group:status:__other__ | Other | 1',
      'list.md:1',
    ]);
  });

  it('groups by first tag with No tag last', () => {
    const list = buildTaskListRows(
      [at(0, { tags: ['#work'] }), at(1), at(2, { tags: ['#art', '#work'] })],
      { by: 'tag' },
    );

    expect(describeRows(list)).toEqual([
      'group:tag:#art | #art | 1 | first',
      'list.md:2',
      'group:tag:#work | #work | 1',
      'list.md:0',
      'group:tag:No tag | No tag | 1',
      'list.md:1',
    ]);
  });

  it('answers lookups for task rows only', () => {
    const first = at(0);
    const second = at(1);
    const list = buildTaskListRows([first, second], byDate);

    expect(list.indexOf('list.md:1')).toBe(1);
    expect(list.task('list.md:1')).toBe(second);
    expect(list.indexOf('group:date:No date')).toBe(-1);
    expect(list.task('group:date:No date')).toBeUndefined();
    expect(list.indexOf('other.md:0')).toBe(-1);
    expect(list.task('other.md:0')).toBeUndefined();
  });

  it('keeps keys across fresh snapshots and a header key across a count change', () => {
    const before = buildTaskListRows([at(0), at(1)], byDate);
    const after = buildTaskListRows(
      [
        at(0, { ref: { revision: 'fresh-0' } }),
        at(1, { ref: { revision: 'fresh-1' } }),
        at(2, { ref: { revision: 'fresh-2' } }),
      ],
      byDate,
    );

    expect(after.taskKeys.slice(0, 2)).toEqual(before.taskKeys);
    expect(before.rows[0]).toEqual({
      kind: 'group',
      key: 'group:date:No date',
      label: 'No date',
      count: 2,
      first: true,
    });
    expect(after.rows[0]).toEqual({
      kind: 'group',
      key: 'group:date:No date',
      label: 'No date',
      count: 3,
      first: true,
    });
  });

  it('gives a root with sub-tasks one row', () => {
    const root = at(0, {
      subtasks: [
        subtask({ title: 'child', root: { filePath: 'list.md', line: 0 } }),
        subtask({ title: 'other child', ref: { relativeLine: 2 }, root: { filePath: 'list.md' } }),
      ],
    });

    expect(describeRows(buildTaskListRows([root, at(3)], { by: 'none' }))).toEqual([
      'list.md:0',
      'list.md:3',
    ]);
  });
});

describe('taskListGrouping', () => {
  const context = { today: TODAY, tomorrow: TOMORROW, statuses };

  it('maps each known groupBy value', () => {
    expect(taskListGrouping('none', context)).toEqual({ by: 'none' });
    expect(taskListGrouping('date', context)).toEqual(byDate);
    expect(taskListGrouping('priority', context)).toEqual({ by: 'priority' });
    expect(taskListGrouping('tag', context)).toEqual({ by: 'tag' });
    expect(taskListGrouping('status', context)).toEqual({ by: 'status', statuses });
  });

  it('groups an unknown stored value by tag', () => {
    expect(taskListGrouping('project', context)).toEqual({ by: 'tag' });
  });
});

describe('taskStackRowKey', () => {
  const root = at(4);

  it('keys a root by its own line', () => {
    expect(taskStackRowKey([root])).toBe('list.md:4');
  });

  it('keys a sub-task by its root note and its own line', () => {
    const child = subtask({ ref: { relativeLine: 2 }, root: { filePath: 'list.md', line: 4 } });

    expect(taskStackRowKey([root, child])).toBe('list.md:6');
  });

  it('has no key for an empty stack', () => {
    expect(taskStackRowKey([])).toBeUndefined();
  });
});

describe('NO_TASK_LIST_ROWS', () => {
  it('holds no rows and answers no lookup', () => {
    expect(NO_TASK_LIST_ROWS.rows).toEqual([]);
    expect(NO_TASK_LIST_ROWS.taskKeys).toEqual([]);
    expect(NO_TASK_LIST_ROWS.indexOf('list.md:0')).toBe(-1);
    const rows: TaskListRows = NO_TASK_LIST_ROWS;
    expect(rows.task('list.md:0')).toBeUndefined();
  });
});

describe('note organization occurrences', () => {
  it('mounts one independently addressable occurrence per outgoing note and a no-link bucket', () => {
    const linked = at(2);
    const values = new Map([
      [
        taskRowKey(linked),
        [
          { key: 'note:People/Alice.md', label: 'Alice', target: 'People/Alice.md' },
          { key: 'note:People/Bob.md', label: 'Bob', target: 'People/Bob.md' },
        ],
      ],
    ]);
    const list = buildTaskListRows([linked, linked, at(3)], { by: 'outgoing-link', values });
    const cards = list.rows.filter((row) => row.kind === 'task');
    expect(cards).toHaveLength(3);
    expect(new Set(cards.map((row) => row.key)).size).toBe(3);
    expect(cards.map((row) => row.taskKey)).toEqual(['list.md:2', 'list.md:2', 'list.md:3']);
    expect(list.occurrencesOf('list.md:2')).toEqual(cards.slice(0, 2).map((row) => row.key));
    expect(list.physicalKey(expectDefined(cards[1]).key)).toBe('list.md:2');
    expect(list.rows.filter((row) => row.kind === 'group').map((row) => row.label)).toEqual([
      'Alice',
      'Bob',
      'No outgoing links',
    ]);
  });
  it('keeps same-name source notes separate and disambiguates their labels', () => {
    const list = buildTaskListRows(
      [
        task({ source: { filePath: 'B/Tasks.md', line: 0 } }),
        task({ source: { filePath: 'A/Tasks.md', line: 0 } }),
      ],
      { by: 'source-note' },
    );
    expect(list.rows.filter((row) => row.kind === 'group').map((row) => row.label)).toEqual([
      'A/Tasks',
      'B/Tasks',
    ]);
    expect(list.taskKeys).toEqual(['A/Tasks.md:0', 'B/Tasks.md:0']);
  });
});

it('rebases an occurrence address without changing its group and rejects unrelated keys', () => {
  expect(
    rebaseTaskRowKey(
      '["task-occurrence","outgoing-link","note:Bob.md","list.md:2"]',
      'list.md:2',
      'list.md:1',
    ),
  ).toBe('["task-occurrence","outgoing-link","note:Bob.md","list.md:1"]');
  expect(rebaseTaskRowKey('list.md:2', 'list.md:2', 'list.md:1')).toBe('list.md:1');
  expect(rebaseTaskRowKey('list.md:3', 'list.md:2', 'list.md:1')).toBe('list.md:3');
});

it('threads Today context to date rows for a scheduled task with a later due date', () => {
  const grouping = taskListGrouping('date', {
    today: TODAY,
    tomorrow: TOMORROW,
    statuses,
    todayList: true,
  });
  const rows = buildTaskListRows(
    [at(0, { planning: { scheduled: TODAY, due: '2026-07-20' } })],
    grouping,
  );
  expect(describeRows(rows)).toEqual(['group:date:Today | Today | 1 | first', 'list.md:0']);
});
