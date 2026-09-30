// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { NO_TASK_LIST_ROWS, type TaskListOrder } from '../src/panels/task-list/taskListRows';
import { TaskRowSelection } from '../src/panels/task-list/taskRowSelection';

function orderOf(...keys: string[]): TaskListOrder {
  return { taskKeys: keys, indexOf: (key) => keys.indexOf(key) };
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
