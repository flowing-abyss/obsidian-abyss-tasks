// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  buildTaskListRows,
  indexedRows,
  NO_TASK_LIST_ROWS,
  taskListGrouping,
  taskRowKey,
  taskStackRowKey,
  type TaskListGrouping,
  type TaskListRows,
} from '../src/panels/task-list/taskListRows';
import { buildDefaultTaskStatuses } from '../src/settings/defaults';
import { StatusRegistry } from '../src/status/StatusRegistry';
import { localDate, type TaskSnapshot } from '../src/tasks';
import { expectDefined, subtask, task, type TaskFixtureInput } from './helpers';
import { taskKeys } from './task-list-row-assertions';

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
  return [...list.slice(0, list.rowCount)].map((row) => {
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
    expect(taskKeys(list)).toEqual(['list.md:2', 'list.md:0', 'list.md:1']);
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
    expect(taskKeys(list)).toEqual([
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

    expect(taskKeys(after).slice(0, 2)).toEqual(taskKeys(before));
    expect(before.rowAt(0)).toEqual({
      kind: 'group',
      key: 'group:date:No date',
      label: 'No date',
      dateGroup: {},
      count: 2,
      first: true,
    });
    expect(after.rowAt(0)).toEqual({
      kind: 'group',
      key: 'group:date:No date',
      label: 'No date',
      dateGroup: {},
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
    expect([...NO_TASK_LIST_ROWS.slice(0, NO_TASK_LIST_ROWS.rowCount)]).toEqual([]);
    expect(taskKeys(NO_TASK_LIST_ROWS)).toEqual([]);
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
    const cards = [...list.slice(0, list.rowCount)].filter((row) => row.kind === 'task');
    expect(cards).toHaveLength(3);
    expect(new Set(cards.map((row) => row.key)).size).toBe(3);
    expect(cards.map((row) => row.taskKey)).toEqual(['list.md:2', 'list.md:2', 'list.md:3']);
    expect(taskKeys(list).filter((key) => list.physicalKey(key) === 'list.md:2')).toEqual(
      cards.slice(0, 2).map((row) => row.key),
    );
    expect(list.physicalKey(expectDefined(cards[1]).key)).toBe('list.md:2');
    expect(
      [...list.slice(0, list.rowCount)]
        .filter((row) => row.kind === 'group')
        .map((row) => row.label),
    ).toEqual(['Alice', 'Bob', 'No outgoing links']);
  });
  it('keeps same-name source notes separate and disambiguates their labels', () => {
    const list = buildTaskListRows(
      [
        task({ source: { filePath: 'B/Tasks.md', line: 0 } }),
        task({ source: { filePath: 'A/Tasks.md', line: 0 } }),
      ],
      { by: 'source-note' },
    );
    expect(
      [...list.slice(0, list.rowCount)]
        .filter((row) => row.kind === 'group')
        .map((row) => row.label),
    ).toEqual(['A/Tasks', 'B/Tasks']);
    expect(taskKeys(list)).toEqual(['A/Tasks.md:0', 'B/Tasks.md:0']);
  });
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

describe('indexed finite row contract', () => {
  const group = (key: string) => ({
    kind: 'group' as const,
    key,
    label: key,
    count: 1,
    first: false,
  });
  it('indexes headers, occurrence order and deduplicated physical selection', () => {
    const rows = indexedRows<string>(
      [
        group('group:a'),
        { kind: 'task', key: 'a:one', taskKey: 'one', task: 'first' },
        { kind: 'task', key: 'a:two', taskKey: 'two', task: 'second' },
        group('group:b'),
        { kind: 'task', key: 'b:one', taskKey: 'one', task: 'first' },
      ],
      'r1',
    );
    expect(rows.revision).toBe('r1');
    expect([rows.rowCount, rows.taskCount]).toEqual([5, 3]);
    expect(rows.taskKeyAt(2)).toBe('b:one');
    expect(rows.indexOf('group:a')).toBe(-1);
    expect(rows.rowIndexOf('b:one')).toBe(4);
    expect(rows.firstOccurrenceOf('one')).toBe('a:one');
    const selected = rows.captureSelection({
      spans: [{ from: 0, to: 2 }],
      include: [],
      exclude: ['a:two'],
    });
    expect(rows.selectedCount(selected)).toBe(2);
    expect(rows.selectedNodes(selected).map((n) => n.taskKey)).toEqual(['one']);
    expect(rows.isSelected('b:one', selected)).toBe(true);
    expect(rows.isSelected('a:two', selected)).toBe(false);
    expect(rows.isSelected('group:a', selected)).toBe(false);
    expect([...rows.slice(3, 5)].map((r) => r.key)).toEqual(['group:b', 'b:one']);
    expect(rows.estimatedOffset(4, { group: 20, task: 50 })).toBe(140);
    expect(rows.estimatedOffset(5, { group: 20, task: 50 })).toBe(190);
    expect(rows).not.toHaveProperty('rows');
    expect(rows).not.toHaveProperty('taskKeys');
    expect(rows).not.toHaveProperty('occurrencesOf');
  });

  it('clamps bounded reads and spans and rejects unsafe indices', () => {
    const rows = indexedRows([{ kind: 'task', key: 'a', taskKey: 'a', task: 42 }]);
    expect([...rows.slice(-20, 20)]).toHaveLength(1);
    expect([...rows.slice(1, 0)]).toEqual([]);
    for (const index of [NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(rows.rowAt(index)).toBeUndefined();
      expect(rows.taskKeyAt(index)).toBeUndefined();
      expect([...rows.slice(index, 1)]).toEqual([]);
      expect([...rows.slice(0, index)]).toEqual([]);
      expect(
        rows.captureSelection({ spans: [{ from: index, to: 1 }], include: [], exclude: [] }),
      ).toEqual([]);
    }
    const selected = rows.captureSelection({
      spans: [{ from: -20, to: 20 }],
      include: [],
      exclude: [],
    });
    expect(rows.selectedNodes(selected)).toEqual([
      { taskKey: 'a', task: 42, completion: { kind: 'allowed' } },
    ]);
    expect(rows.rowAt(-1)).toBeUndefined();
    expect(rows.firstOccurrenceOf('missing')).toBeUndefined();
    expect(rows.rowIndexOf('missing')).toBe(-1);
  });

  it('keeps exact date, kind and group identity across refreshed orders and midnight', () => {
    const today = {
      kind: 'today' as const,
      displayDate: localDate('2026-10-07'),
      completion: { kind: 'allowed' as const },
    };
    const rows = indexedRows([
      group('group:outgoing-link:a'),
      { kind: 'task', key: 'a:today', taskKey: 'physical', task: 1, presentation: today },
      group('group:outgoing-link:b'),
      { kind: 'task', key: 'b:today', taskKey: 'physical', task: 1, presentation: today },
      {
        kind: 'task',
        key: 'daily',
        taskKey: 'physical',
        task: 1,
        presentation: { ...today, kind: 'daily' },
      },
    ]);
    const selected = rows.captureSelection({ spans: [], include: ['a:today'], exclude: [] });
    expect(selected).toEqual([
      {
        kind: 'dates',
        taskKey: 'physical',
        occurrenceKind: 'today',
        groupKey: 'group:outgoing-link:a',
        from: '2026-10-07',
        to: '2026-10-07',
      },
    ]);
    expect(rows.isSelected('b:today', selected)).toBe(false);
    expect(rows.isSelected('daily', selected)).toBe(false);
    const next = indexedRows([
      group('group:outgoing-link:a'),
      {
        kind: 'task',
        key: 'a:tomorrow',
        taskKey: 'physical',
        task: 1,
        presentation: { ...today, displayDate: localDate('2026-10-08') },
      },
    ]);
    expect(next.selectedCount(selected)).toBe(0);
    const daily = rows.captureSelection({ spans: [], include: ['daily'], exclude: [] });
    expect(daily[0]).toMatchObject({ occurrenceKind: 'daily', groupKey: 'upcoming-date' });
  });

  it('applies sparse overrides and aggregates completion only from selected copies', () => {
    const rows = indexedRows([
      {
        kind: 'task',
        key: 'day7',
        taskKey: 'physical',
        task: 1,
        presentation: {
          kind: 'daily',
          displayDate: localDate('2026-10-07'),
          completion: { kind: 'continuation', due: localDate('2026-10-09') },
        },
      },
      {
        kind: 'task',
        key: 'day8',
        taskKey: 'physical',
        task: 1,
        presentation: {
          kind: 'daily',
          displayDate: localDate('2026-10-08'),
          completion: { kind: 'continuation', due: localDate('2026-10-09') },
        },
      },
      {
        kind: 'task',
        key: 'day9',
        taskKey: 'physical',
        task: 1,
        presentation: {
          kind: 'daily',
          displayDate: localDate('2026-10-09'),
          completion: { kind: 'allowed' },
        },
      },
    ]);
    const selected = rows.captureSelection({
      spans: [{ from: 0, to: 2 }],
      include: ['day9'],
      exclude: ['day8', 'day9'],
    });
    expect(rows.selectedCount(selected)).toBe(1);
    expect(rows.selectedNodes(selected)[0]?.completion).toEqual({
      kind: 'continuation',
      due: localDate('2026-10-09'),
    });
    const mixed = rows.captureSelection({
      spans: [{ from: 0, to: 0 }],
      include: ['day9'],
      exclude: [],
    });
    expect(rows.selectedCount(mixed)).toBe(2);
    expect(rows.isSelected('day8', mixed)).toBe(false);
    expect(rows.selectedNodes(mixed)).toEqual([
      { taskKey: 'physical', task: 1, completion: { kind: 'allowed' } },
    ]);
  });

  it('does not infer occurrence presentation from a generic payload', () => {
    const task = {
      kind: 'daily',
      displayDate: localDate('2026-10-07'),
      completion: { kind: 'continuation', due: localDate('2026-10-09') },
    };
    const rows = indexedRows([{ kind: 'task', key: 'one', taskKey: 'one', task }]);
    const selected = rows.captureSelection({ spans: [], include: ['one'], exclude: [] });
    expect(selected).toEqual([{ kind: 'group', taskKey: 'one', groupKey: '' }]);
    expect(rows.selectedNodes(selected)[0]?.completion).toEqual({ kind: 'allowed' });
  });
});

it('exports captured exact dates only for single-day date buckets', () => {
  const rows = buildTaskListRows(
    [at(0, { planning: { due: TODAY } }), at(1, { planning: { due: TOMORROW } }), at(2)],
    byDate,
  );
  expect(
    [...rows.slice(0, rows.rowCount)]
      .filter((row) => row.kind === 'group')
      .map((row) => [row.label, row.dateGroup]),
  ).toEqual([
    ['Today', { date: TODAY }],
    ['Tomorrow', { date: TOMORROW }],
    ['No date', {}],
  ]);
});
