// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  indexedRows,
  NO_TASK_LIST_ROWS,
  type TaskListOrder,
  type TaskListRows,
} from '../src/panels/task-list/taskListRows';
import { TaskRowSelection } from '../src/panels/task-list/taskRowSelection';
import { localDate } from '../src/tasks';

function orderOf(...keys: string[]): TaskListOrder {
  return {
    revision: keys.join(','),
    taskCount: keys.length,
    taskKeyAt: (index) => keys[index],
    indexOf: (key) => keys.indexOf(key),
  };
}

const order = orderOf('a', 'b', 'c', 'd', 'e');

/** The selected keys in display order with the anchor and the focus. */
function snapshot(selection: TaskRowSelection, within: TaskListOrder = order) {
  return {
    selected: selection.inOrder(within),
    anchor: selection.anchor,
    focus: selection.focus,
  };
}

describe('TaskRowSelection clicks', () => {
  it('starts empty and inactive', () => {
    const selection = new TaskRowSelection();

    expect(selection.size).toBe(0);
    expect(selection.isActive()).toBe(false);
    expect(snapshot(selection)).toEqual({ selected: [], anchor: null, focus: null });
  });

  it('collapses to one key with nothing selected', () => {
    const selection = new TaskRowSelection();
    selection.toggle('a');
    selection.toggle('b');

    selection.collapseTo('c');

    expect(snapshot(selection)).toEqual({ selected: [], anchor: 'c', focus: 'c' });
  });

  it('toggles on and off and moves the anchor even when toggling off', () => {
    const selection = new TaskRowSelection();

    selection.toggle('b');
    selection.toggle('d');
    expect(snapshot(selection)).toEqual({ selected: ['b', 'd'], anchor: 'd', focus: 'd' });

    selection.toggle('b');
    expect(snapshot(selection)).toEqual({ selected: ['d'], anchor: 'b', focus: 'b' });
    expect(selection.has('b')).toBe(false);
    expect(selection.has('d')).toBe(true);
    expect(selection.size).toBe(1);
  });

  it('reports activity while a key, an anchor, or a focus is held', () => {
    const selection = new TaskRowSelection();

    selection.collapseTo('a');
    expect(selection.isActive()).toBe(true);
    selection.clear();
    expect(selection.isActive()).toBe(false);
    selection.toggle('a');
    selection.toggle('a');
    expect(selection.size).toBe(0);
    expect(selection.isActive()).toBe(true);
    selection.clear();
    expect(snapshot(selection)).toEqual({ selected: [], anchor: null, focus: null });
  });
});

describe('TaskRowSelection ranges', () => {
  it('extends from a listed anchor in display order', () => {
    const selection = new TaskRowSelection();
    selection.collapseTo('b');

    selection.extendTo('d', order);

    expect(snapshot(selection)).toEqual({ selected: ['b', 'c', 'd'], anchor: 'b', focus: 'd' });
  });

  it('reverses across the anchor and replaces the older range', () => {
    const selection = new TaskRowSelection();
    selection.collapseTo('c');
    selection.extendTo('e', order);

    selection.extendTo('a', order);

    expect(snapshot(selection)).toEqual({ selected: ['a', 'b', 'c'], anchor: 'c', focus: 'a' });
  });

  it('replaces toggled keys outside the range', () => {
    const selection = new TaskRowSelection();
    selection.toggle('e');
    selection.toggle('b');

    selection.extendTo('c', order);

    expect(snapshot(selection)).toEqual({ selected: ['b', 'c'], anchor: 'b', focus: 'c' });
  });

  it('starts a range from the fallback, then from the key, when the anchor is hidden', () => {
    const selection = new TaskRowSelection();
    selection.collapseTo('hidden');
    selection.extendTo('c', order, 'b');
    expect(snapshot(selection)).toEqual({ selected: ['b', 'c'], anchor: 'b', focus: 'c' });

    selection.collapseTo('hidden');
    selection.extendTo('c', order);
    expect(snapshot(selection)).toEqual({ selected: ['c'], anchor: 'c', focus: 'c' });
  });
});

describe('TaskRowSelection arrows', () => {
  it('moves from the focus before the event card and the detail card', () => {
    const selection = new TaskRowSelection();
    selection.collapseTo('b');

    expect(selection.move('down', order, { target: 'd', detail: 'e' }, false)).toBe('c');
    expect(snapshot(selection)).toEqual({ selected: [], anchor: 'c', focus: 'c' });
  });

  it('skips unlisted origins and prefers the event card to the detail card', () => {
    const hidden = new TaskRowSelection();
    hidden.collapseTo('hidden');
    expect(hidden.move('down', order, { target: 'gone', detail: 'd' }, false)).toBe('e');

    const fresh = new TaskRowSelection();
    expect(fresh.move('up', order, { target: 'c', detail: 'e' }, false)).toBe('b');
  });

  it('starts at the first row going down and at the last going up', () => {
    expect(new TaskRowSelection().move('down', order, {}, false)).toBe('a');
    expect(new TaskRowSelection().move('up', order, {}, false)).toBe('e');
  });

  it('clamps at both ends without wrapping', () => {
    const selection = new TaskRowSelection();
    selection.collapseTo('e');
    expect(selection.move('down', order, {}, false)).toBe('e');

    selection.collapseTo('a');
    expect(selection.move('up', order, {}, false)).toBe('a');
  });

  it('grows, shrinks, and crosses the anchor with Shift', () => {
    const selection = new TaskRowSelection();
    selection.collapseTo('b');

    selection.move('down', order, {}, true);
    selection.move('down', order, {}, true);
    expect(snapshot(selection)).toEqual({ selected: ['b', 'c', 'd'], anchor: 'b', focus: 'd' });

    selection.move('up', order, {}, true);
    expect(snapshot(selection)).toEqual({ selected: ['b', 'c'], anchor: 'b', focus: 'c' });

    selection.move('up', order, {}, true);
    selection.move('up', order, {}, true);
    expect(snapshot(selection)).toEqual({ selected: ['a', 'b'], anchor: 'b', focus: 'a' });
  });

  it('selects one row with Shift from nothing', () => {
    const selection = new TaskRowSelection();

    expect(selection.move('down', order, {}, true)).toBe('a');
    expect(snapshot(selection)).toEqual({ selected: ['a'], anchor: 'a', focus: 'a' });
  });

  it('extends with Shift from where the move began when the anchor is hidden', () => {
    const selection = new TaskRowSelection();
    selection.collapseTo('hidden');

    expect(selection.move('down', order, { detail: 'b' }, true)).toBe('c');
    expect(snapshot(selection)).toEqual({ selected: ['b', 'c'], anchor: 'b', focus: 'c' });
  });
});

describe('TaskRowSelection after renders and writes', () => {
  it('drops hidden keys and moves a hidden anchor and focus to the first kept key', () => {
    const selection = new TaskRowSelection();
    selection.toggle('d');
    selection.toggle('b');
    selection.toggle('e');
    const shorter = orderOf('a', 'b', 'c', 'd');

    selection.reconcile(shorter);

    expect(snapshot(selection, shorter)).toEqual({ selected: ['b', 'd'], anchor: 'b', focus: 'b' });
    expect(selection.size).toBe(2);
  });

  it('keeps a listed anchor and focus', () => {
    const selection = new TaskRowSelection();
    selection.toggle('b');
    selection.toggle('d');

    selection.reconcile(order);

    expect(snapshot(selection)).toEqual({ selected: ['b', 'd'], anchor: 'd', focus: 'd' });
  });

  it('keeps a listed anchor and moves a hidden focus to the first kept key', () => {
    const selection = new TaskRowSelection();
    selection.collapseTo('d');
    selection.extendTo('b', order);
    const withoutB = orderOf('a', 'c', 'd', 'e');

    selection.reconcile(withoutB);

    expect(snapshot(selection, withoutB)).toEqual({
      selected: ['c', 'd'],
      anchor: 'd',
      focus: 'c',
    });
  });

  it('clears an empty or unmatched anchor and focus when nothing listed stays', () => {
    const empty = new TaskRowSelection();
    empty.collapseTo('');
    empty.reconcile(order);
    expect(empty.isActive()).toBe(false);

    const gone = new TaskRowSelection();
    gone.toggle('b');
    gone.reconcile(orderOf('a', 'c'));
    expect(snapshot(gone)).toEqual({ selected: [], anchor: null, focus: null });
  });

  it('lists the selection in display order whatever order it was added in', () => {
    const selection = new TaskRowSelection();
    selection.toggle('e');
    selection.toggle('a');
    selection.toggle('c');

    expect(selection.inOrder(order)).toEqual(['a', 'c', 'e']);
    expect(selection.inOrder(orderOf('e', 'd', 'c', 'b', 'a'))).toEqual(['e', 'c', 'a']);
  });

  it('drops one key and keeps the anchor', () => {
    const selection = new TaskRowSelection();
    selection.toggle('a');
    selection.toggle('b');

    selection.delete('a');

    expect(snapshot(selection)).toEqual({ selected: ['b'], anchor: 'b', focus: 'b' });
  });

  it('rebases onto resolved keys with the first one leading', () => {
    const selection = new TaskRowSelection();
    selection.toggle('a');
    selection.toggle('b');

    selection.replaceWith(['d', 'c', 'd']);
    expect(snapshot(selection)).toEqual({ selected: ['c', 'd'], anchor: 'd', focus: 'd' });
    expect(selection.size).toBe(2);

    selection.replaceWith([]);
    expect(selection.isActive()).toBe(false);
  });
});

describe('TaskRowSelection with an empty order', () => {
  it('moves nowhere, clears on Shift, and lists nothing', () => {
    const selection = new TaskRowSelection();
    selection.toggle('a');
    selection.toggle('b');

    expect(selection.move('down', NO_TASK_LIST_ROWS, { target: 'a' }, false)).toBeUndefined();
    expect(snapshot(selection)).toEqual({ selected: ['a', 'b'], anchor: 'b', focus: 'b' });
    expect(selection.inOrder(NO_TASK_LIST_ROWS)).toEqual([]);

    selection.extendTo('a', NO_TASK_LIST_ROWS);
    expect(selection.size).toBe(0);
    expect(snapshot(selection)).toEqual({ selected: [], anchor: 'a', focus: 'a' });
  });
});

describe('TaskRowSelection select-all', () => {
  it('selects the complete ordered projection while preserving a valid range lead', () => {
    const selection = new TaskRowSelection();
    selection.collapseTo('b');
    selection.extendTo('d', order);
    selection.selectAll(order, { target: 'a', detail: 'e' });
    selection.selectAll(order, {});
    expect(snapshot(selection)).toEqual({
      selected: ['a', 'b', 'c', 'd', 'e'],
      anchor: 'b',
      focus: 'd',
    });
    expect(selection.move('down', order, {}, true)).toBe('e');
    expect(snapshot(selection)).toEqual({
      selected: ['b', 'c', 'd', 'e'],
      anchor: 'b',
      focus: 'e',
    });
    selection.selectAll(order, {});
    expect(selection.move('up', order, {}, false)).toBe('d');
    expect(snapshot(selection)).toEqual({ selected: [], anchor: 'd', focus: 'd' });
  });

  it.each([
    { origin: { target: 'c', detail: 'd' }, want: 'c' },
    { origin: { target: 'gone', detail: 'd' }, want: 'd' },
    { origin: { target: 'gone', detail: 'gone' }, want: 'a' },
  ])('replaces stale leads using the first listed origin: $want', ({ origin, want }) => {
    const selection = new TaskRowSelection();
    selection.toggle('gone');
    selection.selectAll(order, origin);
    expect(snapshot(selection)).toEqual({
      selected: ['a', 'b', 'c', 'd', 'e'],
      anchor: want,
      focus: want,
    });
    expect(selection.size).toBe(5);
  });

  it('replaces old membership with reordered occurrences and clears an empty projection', () => {
    const selection = new TaskRowSelection();
    selection.selectAll(order, {});
    const filtered = orderOf('occurrence-b2', 'occurrence-a', 'occurrence-b1');
    selection.selectAll(filtered, { target: 'occurrence-b1' });
    expect(snapshot(selection, filtered)).toEqual({
      selected: ['occurrence-b2', 'occurrence-a', 'occurrence-b1'],
      anchor: 'occurrence-b1',
      focus: 'occurrence-b1',
    });
    expect(selection.has('a')).toBe(false);
    selection.selectAll(NO_TASK_LIST_ROWS, {});
    expect(snapshot(selection)).toEqual({ selected: [], anchor: null, focus: null });
  });
});

describe('bound occurrence selection', () => {
  const one = { identity: 'one' };
  const two = { identity: 'two' };
  function rowsOf(entries: ReadonlyArray<[string, string, object]>) {
    return indexedRows(
      entries.map(([key, taskKey, task]) => ({ kind: 'task' as const, key, taskKey, task })),
    );
  }

  it('captures the full order before reversal and never selects an inserted row', () => {
    const rows = rowsOf([
      ['one-a', 'one', one],
      ['two', 'two', two],
      ['one-b', 'one', one],
    ]);
    const selection = new TaskRowSelection();
    selection.bind(rows);
    selection.collapseTo('one-a');
    expect(selection.moveEdge('last', rows, {}, true)).toBe('one-b');
    expect(selection.size).toBe(3);
    expect(selection.selectedNodes(rows).map((n) => n.taskKey)).toEqual(['one', 'two']);
    const before = selection.ranges();
    const reversed = rowsOf([
      ['one-b', 'one', one],
      ['new-unselected', 'new', {}],
      ['two', 'two', two],
      ['one-a', 'one', one],
    ]);
    selection.bind(reversed, {
      physicalKeys: new Map([
        ['one', 'one'],
        ['two', 'two'],
      ]),
    });
    expect(selection.ranges()).toEqual(before);
    expect(selection.size).toBe(3);
    expect(selection.has('new-unselected')).toBe(false);
    selection.toggle('two');
    expect(selection.size).toBe(2);
    selection.toggle('two');
    expect(selection.size).toBe(3);
  });

  it('drops unproved replacement objects and does not restore filtered selection', () => {
    const selection = new TaskRowSelection();
    const original = rowsOf([
      ['one', 'one', one],
      ['two', 'two', two],
    ]);
    selection.bind(original);
    selection.selectAll(original, {});
    const narrowed = rowsOf([['one', 'one', one]]);
    selection.bind(narrowed);
    expect(selection.size).toBe(1);
    selection.bind(original);
    expect(selection.has('two')).toBe(false);
    selection.bind(rowsOf([['one', 'one', { identity: 'one' }]]), { physicalKeys: new Map() });
    expect(selection.size).toBe(0);
  });

  it('moves only the proved physical key while preserving date and group identity', () => {
    const day = localDate('2026-10-08');
    const makeRows = (key: string, date = day, groupKey = 'group:date:today') =>
      indexedRows([
        { kind: 'group' as const, key: groupKey, label: 'Today', count: 1, first: true },
        {
          kind: 'task' as const,
          key,
          taskKey: key,
          task: {},
          presentation: {
            kind: 'today' as const,
            displayDate: date,
            completion: { kind: 'allowed' as const },
          },
        },
      ]);
    const original = makeRows('one');
    const selection = new TaskRowSelection();
    selection.bind(original);
    selection.selectAll(original, {});
    selection.bind(makeRows('successor'), { physicalKeys: new Map([['one', 'successor']]) });
    expect(selection.ranges()).toEqual([
      {
        kind: 'dates',
        taskKey: 'successor',
        occurrenceKind: 'today',
        groupKey: 'group:date:today',
        from: day,
        to: day,
      },
    ]);
    selection.bind(makeRows('successor', localDate('2026-10-09')), {
      physicalKeys: new Map([['successor', 'successor']]),
    });
    expect(selection.size).toBe(0);
  });

  it('selects ten million logical rows with bounded lookups', () => {
    const count = 10_000_000;
    let lookups = 0;
    let captures = 0;
    const range = {
      kind: 'dates' as const,
      taskKey: 'one',
      occurrenceKind: 'daily' as const,
      groupKey: 'upcoming-date',
      from: localDate('0001-01-01'),
      to: localDate('9999-12-31'),
    };
    const base = indexedRows([{ kind: 'task' as const, key: '0', taskKey: 'one', task: one }]);
    const rows: TaskListRows<object> = {
      ...base,
      taskCount: count,
      rowCount: count,
      taskKeyAt: (index) => {
        if (++lookups > 30) throw new Error('Enumerated logical keys');
        return index >= 0 && index < count ? String(index) : undefined;
      },
      indexOf: (key) => {
        if (++lookups > 30) throw new Error('Enumerated logical keys');
        const i = Number(key);
        return Number.isInteger(i) && i >= 0 && i < count ? i : -1;
      },
      captureSelection: (selection) => {
        captures++;
        expect(selection.spans).toEqual([{ from: 0, to: count - 1 }]);
        expect(selection.include).toEqual([]);
        expect(selection.exclude).toEqual([]);
        return [range];
      },
      selectedCount: (ranges) => (ranges.length === 0 ? 0 : count),
      isSelected: (key, ranges) => ranges.length > 0 && Number(key) >= 0 && Number(key) < count,
      selectedNodes: (ranges) =>
        ranges.length === 0 ? [] : [{ taskKey: 'one', task: one, completion: { kind: 'allowed' } }],
    };
    const selection = new TaskRowSelection();
    selection.bind(rows);
    selection.collapseTo('0');
    expect(selection.moveEdge('last', rows, {}, true)).toBe('9999999');
    expect(selection.size).toBe(count);
    expect(selection.ranges()).toEqual([range]);
    expect(selection.selectedNodes(rows)).toHaveLength(1);
    selection.selectAll(rows, {});
    expect(selection.size).toBe(count);
    expect(lookups).toBeLessThan(30);
    expect(captures).toBeLessThanOrEqual(2);
  });
});

describe('canonical descriptor intersection', () => {
  const dates = ['2026-10-08', '2026-10-09', '2026-10-10'].map(localDate);
  const task = {};
  function daily(reverse = false) {
    const rows = dates.map((date, index) => ({
      kind: 'task' as const,
      key: String(index),
      taskKey: 'one',
      task,
      presentation: {
        kind: 'daily' as const,
        displayDate: date,
        completion:
          index === 2
            ? { kind: 'allowed' as const }
            : { kind: 'continuation' as const, due: localDate('2026-10-10') },
      },
    }));
    if (reverse) rows.reverse();
    return indexedRows(rows);
  }
  it('normalizes overlaps and splits sparse exclusions, retaining the selected date lead in reverse order', () => {
    const rows = daily();
    const selection = new TaskRowSelection();
    selection.bind(rows);
    selection.collapseTo('1');
    selection.moveEdge('last', rows, {}, true);
    const ranges = selection.ranges();
    expect(
      rows.captureSelection({
        ranges: [...ranges, ...ranges],
        spans: [{ from: 1, to: 2 }],
        include: ['0'],
        exclude: ['1'],
      }),
    ).toEqual([
      {
        kind: 'dates',
        taskKey: 'one',
        occurrenceKind: 'daily',
        groupKey: 'upcoming-date',
        from: '2026-10-08',
        to: '2026-10-08',
      },
      {
        kind: 'dates',
        taskKey: 'one',
        occurrenceKind: 'daily',
        groupKey: 'upcoming-date',
        from: '2026-10-10',
        to: '2026-10-10',
      },
    ]);
    selection.bind(daily(true));
    expect(selection.anchor).toBe('1');
    expect(selection.focus).toBe('2');
    expect(selection.has('0')).toBe(false);
    expect(selection.size).toBe(2);
    selection.toggle('1');
    expect(selection.size).toBe(1);
    expect(selection.selectedNodes(daily())[0]?.completion.kind).toBe('allowed');
    selection.toggle('2');
    selection.toggle('0');
    expect(selection.selectedNodes(daily())[0]?.completion.kind).toBe('continuation');
  });

  it('chooses a selected later date, never an unselected physical first occurrence', () => {
    const rows = daily();
    const onlyLast = rows.captureSelection({ spans: [], include: ['2'], exclude: [] });
    expect(rows.firstSelectedKey(onlyLast)).toBe('2');
    expect(
      daily(true).firstSelectedKey(
        rows.captureSelection({ spans: [{ from: 1, to: 2 }], include: [], exclude: [] }),
      ),
    ).toBe('2');
    expect(rows.firstSelectedKey([])).toBeUndefined();
    const selection = new TaskRowSelection();
    selection.bind(rows);
    selection.toggle('2');
    selection.bind(daily(true));
    expect(selection.anchor).toBe('2');
    expect(selection.focus).toBe('2');
  });

  it('retires removed outgoing groups and deletes every selected copy of a physical node', () => {
    const rows = (groups: readonly string[]) =>
      indexedRows(
        groups.flatMap((groupKey) => [
          { kind: 'group' as const, key: groupKey, label: groupKey, count: 1, first: false },
          { kind: 'task' as const, key: `${groupKey}:one`, taskKey: 'one', task },
        ]),
      );
    const original = rows(['group:A', 'group:B']);
    const selection = new TaskRowSelection();
    selection.bind(original);
    selection.selectAll(original, {});
    selection.bind(rows(['group:B', 'group:C']));
    expect(selection.size).toBe(1);
    expect(selection.has('group:C:one')).toBe(false);
    selection.bind(original);
    expect(selection.has('group:A:one')).toBe(false);
    selection.deleteNode('one');
    expect(selection.size).toBe(0);
    expect(selection.ranges()).toEqual([]);
  });
});

it('ignores stale input orders instead of reinterpreting numeric selection', () => {
  const first = indexedRows([{ kind: 'task' as const, key: 'a', taskKey: 'a', task: 1 }]);
  const replacement = indexedRows([{ kind: 'task' as const, key: 'b', taskKey: 'b', task: 2 }]);
  const selection = new TaskRowSelection();
  selection.bind(first);
  selection.selectAll(first, {});
  selection.bind(replacement);
  expect(selection.moveEdge('last', first, {}, true)).toBeUndefined();
  selection.selectAll(first, {});
  selection.extendTo('a', first);
  expect(selection.size).toBe(0);
  expect(selection.has('b')).toBe(false);
});
