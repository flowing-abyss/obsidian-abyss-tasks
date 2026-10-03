import { describe, expect, it, vi } from 'vitest';
import {
  buildTaskListRows,
  NO_TASK_LIST_ROWS,
  type TaskListTaskRow,
} from '../src/panels/task-list/taskListRows';
import {
  mountTaskListRows,
  NO_MOUNTED_TASK_LIST_ROWS,
} from '../src/panels/task-list/taskListRowView';
import { freshContainer, task } from './helpers';

const TODAY = '2026-06-26';

const rows = buildTaskListRows(
  [
    task({ title: 'late', planning: { due: '2026-06-20' }, source: { filePath: 'n.md', line: 0 } }),
    task({ title: 'loose', source: { filePath: 'n.md', line: 1 } }),
    task({ title: 'now', planning: { due: TODAY }, source: { filePath: 'n.md', line: 2 } }),
  ],
  { by: 'date', today: TODAY, tomorrow: '2026-06-27' },
);

function renderCard(container: HTMLElement, row: TaskListTaskRow): HTMLElement {
  return container.createDiv({ cls: 'abyss-task-card', text: row.task.title });
}

describe('mountTaskListRows', () => {
  it('appends one direct child per row in row order with the header classes and text', () => {
    const container = freshContainer();

    mountTaskListRows(container, rows, renderCard);

    expect(
      Array.from(container.children).map((child) => [child.className, child.textContent]),
    ).toEqual([
      ['abyss-group-header abyss-group-header--first', 'Overdue  1'],
      ['abyss-task-card', 'late'],
      ['abyss-group-header', 'Today  1'],
      ['abyss-task-card', 'now'],
      ['abyss-group-header', 'No date  1'],
      ['abyss-task-card', 'loose'],
    ]);
  });

  it('finds the mounted header or card of a key', () => {
    const container = freshContainer();

    const mounted = mountTaskListRows(container, rows, renderCard);

    expect(mounted.rows).toBe(rows);
    expect(mounted.element('group:date:Today')).toBe(container.children[2]);
    expect(mounted.element('n.md:2')).toBe(container.children[3]);
    expect(mounted.element('n.md:9')).toBeUndefined();
  });

  it('lists the cards renderTask returned, in row order', () => {
    const container = freshContainer();
    const renderTask = vi.fn(renderCard);

    const mounted = mountTaskListRows(container, rows, renderTask);

    const returned = renderTask.mock.results.map((result) => result.value as HTMLElement);
    expect([...mounted.cards()]).toEqual([
      ['n.md:0', returned[0]],
      ['n.md:2', returned[1]],
      ['n.md:1', returned[2]],
    ]);
    expect(renderTask.mock.calls.map(([host, row]) => [host, row.key])).toEqual([
      [container, 'n.md:0'],
      [container, 'n.md:2'],
      [container, 'n.md:1'],
    ]);
  });

  it('mounts nothing for zero rows', () => {
    const container = freshContainer();
    const renderTask = vi.fn(renderCard);

    const mounted = mountTaskListRows(container, NO_TASK_LIST_ROWS, renderTask);

    expect(container.childElementCount).toBe(0);
    expect(renderTask).not.toHaveBeenCalled();
    expect([...mounted.cards()]).toEqual([]);
    expect(mounted.element('n.md:0')).toBeUndefined();
  });
});

describe('NO_MOUNTED_TASK_LIST_ROWS', () => {
  it('holds the empty order and no element', () => {
    expect(NO_MOUNTED_TASK_LIST_ROWS.rows).toBe(NO_TASK_LIST_ROWS);
    expect([...NO_MOUNTED_TASK_LIST_ROWS.cards()]).toEqual([]);
    expect(NO_MOUNTED_TASK_LIST_ROWS.element('n.md:0')).toBeUndefined();
  });
});

it('mounts each outgoing occurrence with its own address and element', () => {
  const linked = task({ source: { filePath: 'n.md', line: 0 } });
  const list = buildTaskListRows([linked], {
    by: 'outgoing-link',
    values: new Map([
      [
        'n.md:0',
        [
          { key: 'note:Alice.md', label: 'Alice', target: 'Alice.md' },
          { key: 'note:Bob.md', label: 'Bob', target: 'Bob.md' },
        ],
      ],
    ]),
  });
  const container = freshContainer();
  const mounted = mountTaskListRows(container, list, renderCard);
  const cards = [...mounted.cards()];
  expect(cards).toHaveLength(2);
  expect(new Set(cards.map(([key]) => key)).size).toBe(2);
  expect(new Set(cards.map(([, card]) => card)).size).toBe(2);
  for (const [key, card] of cards) expect(mounted.element(key)).toBe(card);
});
