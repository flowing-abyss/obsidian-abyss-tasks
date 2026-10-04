import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TaskListSurface,
  type TaskListPresentation,
} from '../src/panels/task-list/TaskListSurface';
import { buildTaskListRows, type TaskListRow } from '../src/panels/task-list/taskListRows';
import { expectDefined, freshContainer, task } from './helpers';

const presentation: TaskListPresentation = {
  revision: 'layout:1',
  preserveAnchor: true,
  estimate: () => 48,
  measurementRevision: (row) => (row.kind === 'task' ? row.task.title : row.label),
};
function rows(count: number) {
  return buildTaskListRows(
    Array.from({ length: count }, (_, line) =>
      task({ title: `Task ${line}`, source: { filePath: 'n.md', line } }),
    ),
    { by: 'none' },
  );
}
function harness(clampWrites = false) {
  const scroll = freshContainer();
  document.body.append(scroll);
  Object.defineProperty(document, 'fonts', { value: new EventTarget(), configurable: true });
  const host = scroll.createDiv();
  const frames = new Map<number, FrameRequestCallback>();
  let next = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    frames.set(++next, cb);
    return next;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id);
  });
  const observed = new Set<Element>();
  let resize: ResizeObserverCallback | undefined;
  class Observer {
    constructor(callback: ResizeObserverCallback) {
      resize = callback;
    }
    observe(element: Element) {
      observed.add(element);
    }
    unobserve(element: Element) {
      observed.delete(element);
    }
    disconnect() {
      observed.clear();
    }
  }
  vi.stubGlobal('ResizeObserver', Observer);
  let height = 480;
  let width = 600;
  let top = 0;
  let origin = 0;
  host.getBoundingClientRect = () => ({ top: origin - top }) as DOMRect;
  scroll.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
  const writes = vi.fn((value: number) => {
    const extent = Array.from(host.children).reduce((sum, child) => {
      const element = child as HTMLElement;
      return (
        sum +
        (element.hasClass('abyss-virtual-row-spacer')
          ? Number.parseFloat(element.style.getPropertyValue('--abyss-virtual-row-height'))
          : element.getBoundingClientRect().height)
      );
    }, 0);
    top = clampWrites ? Math.max(0, Math.min(value, origin + extent - height)) : value;
  });
  Object.defineProperties(scroll, {
    clientHeight: { get: () => height },
    scrollTop: { get: () => top, set: writes, configurable: true },
  });
  Object.defineProperty(host, 'clientWidth', { get: () => width });
  const heights = new Map<string, number>();
  const destroyed: string[] = [];
  const mount = vi.fn((container: HTMLElement, row: TaskListRow) => {
    const element = container.createDiv();
    const label = element.createSpan({ text: row.kind === 'task' ? row.task.title : row.label });
    element.dataset['key'] = row.key;
    element.tabIndex = -1;
    element.getBoundingClientRect = () => ({
      height: heights.get(row.key) ?? 48,
      width,
      top: 0,
      bottom: 48,
      left: 0,
      right: width,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    return {
      element,
      update: (nextRow: TaskListRow) => {
        label.textContent = nextRow.kind === 'task' ? nextRow.task.title : nextRow.label;
      },
      destroy: () => {
        destroyed.push(row.key);
        element.remove();
      },
    };
  });
  const reportFailure = vi.fn();
  const surface = new TaskListSurface({
    host,
    scroll,
    mount,
    mountedChanged: vi.fn(),
    reportFailure,
  });
  return {
    host,
    scroll,
    surface,
    mount,
    destroyed,
    heights,
    writes,
    observed,
    reportFailure,
    origin(value: number) {
      origin = value;
    },
    scrollTo(value: number) {
      top = value;
      scroll.dispatchEvent(new Event('scroll'));
    },
    size(w: number, h: number) {
      width = w;
      height = h;
    },
    resize() {
      resize?.([], {} as ResizeObserver);
    },
    frame() {
      const pending = [...frames.values()];
      frames.clear();
      for (const cb of pending) cb(0);
    },
    pending: () => frames.size,
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.empty();
});

describe('TaskListSurface', () => {
  it('bounds 10,000 rows, reveals synchronously, keeps sparse owner pins, and tears down once', () => {
    const h = harness();
    const list = rows(10000);
    h.surface.update(list, presentation);
    expect([...h.surface.cards()].length).toBeLessThanOrEqual(100);
    const last = expectDefined(list.taskKeys[list.taskKeys.length - 1]);
    expect(h.surface.element(last)).toBeUndefined();
    expect(h.surface.reveal(last)).toBe(h.surface.element(last));
    const release = h.surface.pin(last);
    const second = h.surface.pin(last);
    h.surface.reveal('n.md:0');
    expect(h.surface.element(last)?.isConnected).toBe(true);
    expect([...h.surface.cards()].slice(-1).map(([key]) => key)).toEqual([last]);
    release();
    release();
    h.frame();
    expect(h.surface.element(last)?.isConnected).toBe(true);
    second();
    h.frame();
    expect(h.surface.element(last)).toBeUndefined();
    expect(
      [...h.host.children]
        .filter((el) => el.hasAttribute('aria-hidden'))
        .every((el) => el.getAttribute('aria-hidden') === 'true'),
    ).toBe(true);
    h.surface.destroy();
    h.surface.destroy();
    expect(h.host.childElementCount).toBe(0);
    expect(h.observed.size).toBe(0);
    expect(h.pending()).toBe(0);
    expect(h.destroyed).toHaveLength(h.mount.mock.calls.length);
  });
  it('never rewrites fractional, elastic, or unchanged ordinary native scrolling', () => {
    const h = harness();
    h.surface.update(rows(1000), presentation);
    h.writes.mockClear();
    for (const top of [120.5, -12, -12, 120.5, 120.5]) {
      h.scrollTo(top);
      h.frame();
    }
    expect(h.writes).not.toHaveBeenCalled();
    h.surface.reveal('n.md:999');
    expect(h.writes).toHaveBeenCalledTimes(1);
  });
  it('corrects async growth above the anchor once, and ignores invalid or unchanged sizes', () => {
    const h = harness();
    h.surface.update(rows(100), presentation);
    h.scrollTo(120.5);
    h.frame();
    h.writes.mockClear();
    h.heights.set('n.md:0', 96);
    h.heights.set('n.md:1', Number.NaN);
    h.resize();
    h.frame();
    expect(h.writes.mock.calls).toEqual([[168.5]]);
    h.resize();
    h.frame();
    expect(h.writes).toHaveBeenCalledTimes(1);
    expect(h.pending()).toBe(0);
  });
  it('invalidates offscreen measurements for width and presentation changes', () => {
    const h = harness();
    h.heights.set('n.md:0', 96);
    h.surface.update(rows(100), presentation);
    h.surface.reveal('n.md:99');
    h.heights.clear();
    h.writes.mockClear();
    h.size(300, 480);
    h.resize();
    h.frame();
    h.surface.reveal('n.md:0');
    h.surface.reveal('n.md:99');
    expect(h.scroll.scrollTop).toBe(4320);
    h.heights.set('n.md:0', 96);
    h.surface.reveal('n.md:0');
    h.resize();
    h.frame();
    h.surface.reveal('n.md:99');
    h.heights.clear();
    h.surface.update(rows(100), { ...presentation, revision: 'layout:2' });
    h.surface.reveal('n.md:0');
    h.surface.reveal('n.md:99');
    expect(h.scroll.scrollTop).toBe(4320);
  });
  it('keeps focused descendants connected until focus leaves, but revokes removed keys', () => {
    const h = harness();
    h.surface.update(rows(100), presentation);
    const first = expectDefined(h.surface.element('n.md:0'));
    first.focus();
    h.surface.reveal('n.md:99');
    expect(first.isConnected).toBe(true);
    first.blur();
    h.frame();
    expect(first.isConnected).toBe(false);
    const release = h.surface.pin('n.md:99');
    h.surface.update(rows(2), presentation);
    expect(h.surface.element('n.md:99')).toBeUndefined();
    release();
    h.frame();
    expect(h.scroll.scrollTop).toBe(0);
  });
  it('does no work while inactive and revalidates on resume', () => {
    const h = harness();
    h.size(600, 0);
    h.surface.update(rows(100), presentation);
    expect(h.mount).not.toHaveBeenCalled();
    expect(h.surface.reveal('n.md:99')).toBeUndefined();
    h.size(600, 480);
    h.surface.resume();
    expect(h.surface.element('n.md:0')).toBeDefined();
    h.surface.suspend();
    h.scrollTo(1000);
    h.resize();
    h.frame();
    expect(h.pending()).toBe(0);
    h.surface.resume();
    expect(h.surface.element('n.md:20')).toBeDefined();
    h.host.remove();
    h.scrollTo(2000);
    h.frame();
    expect(h.pending()).toBe(0);
  });
  it('reports initial and later frame failures once through its owner and cancels the pass', () => {
    const h = harness();
    const error = new Error('mount failed');
    h.mount.mockImplementationOnce(() => {
      throw error;
    });
    h.surface.update(rows(100), presentation);
    expect(h.reportFailure.mock.calls).toEqual([[error]]);
    h.surface.update(rows(100), presentation);
    h.mount.mockImplementationOnce(() => {
      throw error;
    });
    h.scrollTo(2000);
    h.frame();
    expect(h.reportFailure.mock.calls).toEqual([[error], [error]]);
    expect(h.pending()).toBe(0);
  });
});

it('uses the host content origin for reveal inside a scroller with preceding content', () => {
  const h = harness();
  h.origin(100);
  h.surface.update(rows(100), presentation);
  h.surface.reveal('n.md:99');
  expect(h.scroll.scrollTop).toBe(4420);
});

it('preserves elastic scroll when changed measurements need no anchor correction', () => {
  const h = harness();
  h.surface.update(rows(100), presentation);
  h.scrollTo(-12);
  h.heights.set('n.md:2', 96);
  h.writes.mockClear();
  h.frame();
  expect(h.writes).not.toHaveBeenCalled();
});

it('stops repeated observer failures until an explicit refresh can recover', () => {
  const h = harness();
  h.surface.update(rows(100), presentation);
  const element = expectDefined(h.surface.element('n.md:0'));
  element.getBoundingClientRect = () => {
    throw new Error('measurement failed');
  };
  h.resize();
  h.frame();
  h.resize();
  h.frame();
  expect(h.reportFailure).toHaveBeenCalledTimes(1);
});

it('refreshes snapshots received while hidden before exposing mounts on resume', () => {
  const h = harness();
  h.surface.update(rows(10), presentation);
  h.size(600, 0);
  h.surface.update(
    buildTaskListRows(
      [task({ title: 'Changed while hidden', source: { filePath: 'n.md', line: 0 } })],
      { by: 'none' },
    ),
    presentation,
  );
  h.size(600, 480);
  h.surface.resume();
  expect(h.surface.element('n.md:0')?.textContent).toBe('Changed while hidden');
});

it('restores a fractional anchor after prepend against the new mounted DOM extent', () => {
  const h = harness(true);
  const list = rows(100);
  h.surface.update(list, presentation);
  h.scrollTo(4272.5);
  h.frame();
  const original = h.surface.element('n.md:89');
  const added = Array.from({ length: 100 }, (_, line) =>
    task({ title: `Added ${line}`, source: { filePath: 'added.md', line } }),
  );
  const prior = list.rows.flatMap((row) => (row.kind === 'task' ? [row.task] : []));
  h.surface.update(buildTaskListRows([...added, ...prior], { by: 'none' }), presentation);
  expect(h.scroll.scrollTop).toBe(9072.5);
  expect(h.surface.element('n.md:89')).toBe(original);
  h.surface.destroy();
});

it('preserves the actual focused descendant when its row reorders across a sparse pin', () => {
  const h = harness();
  const list = rows(100);
  h.surface.update(list, presentation);
  h.surface.reveal('n.md:99');
  const pinned = h.surface.pin('n.md:99');
  h.surface.reveal('n.md:1');
  const control = h.surface.element('n.md:1')?.createEl('input');
  control?.focus();
  const tasks = list.rows.flatMap((row) => (row.kind === 'task' ? [row.task] : []));
  h.surface.update(buildTaskListRows([...tasks].reverse(), { by: 'none' }), presentation);
  expect(document.activeElement).toBe(control);
  expect(h.surface.element('n.md:1')?.contains(control ?? null)).toBe(true);
  expect(h.surface.rows.taskKeys[0]).toBe('n.md:99');
  pinned();
  h.surface.destroy();
});

it('invalidates conflicting owners before moving their nodes and keeps snapshots current', () => {
  const h = harness();
  const list = rows(100);
  h.surface.update(list, presentation);
  const first = expectDefined(h.surface.element('n.md:1'));
  const control = first.createEl('input');
  control.focus();
  h.surface.reveal('n.md:99');
  const last = expectDefined(h.surface.element('n.md:99'));
  const canceled = vi.fn(() => {
    expect(first.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.activeElement).toBe(control);
  });
  const release = h.surface.pin('n.md:99', canceled);
  const tasks = list.rows.flatMap((row) => (row.kind === 'task' ? [row.task] : []));
  const changed = tasks.map((value) => task({ ...value, title: `Updated ${value.title}` }));
  h.surface.update(buildTaskListRows([...changed].reverse(), { by: 'none' }), presentation);
  expect(canceled).toHaveBeenCalledExactlyOnceWith();
  expect(document.activeElement).toBe(control);
  expect(first.textContent).toBe('Updated Task 1');
  expect([...h.surface.cards()].map(([key]) => key)).toEqual(
    h.surface.rows.taskKeys.filter((key) => h.surface.element(key) !== undefined),
  );
  release();
  h.surface.destroy();
  expect(canceled).toHaveBeenCalledTimes(1);
});

it('revokes removed and disposed acquisitions before eviction, with idempotent release', () => {
  const h = harness();
  h.surface.update(rows(3), presentation);
  const removed = expectDefined(h.surface.element('n.md:2'));
  let release = () => {};
  const canceled = vi.fn(() => {
    expect(removed.isConnected).toBe(true);
    release();
  });
  release = h.surface.pin('n.md:2', canceled);
  h.surface.update(rows(2), presentation);
  expect(canceled).toHaveBeenCalledTimes(1);
  expect(removed.isConnected).toBe(false);
  release();
  const remaining = expectDefined(h.surface.element('n.md:1'));
  const disposed = vi.fn(() => {
    expect(remaining.isConnected).toBe(true);
  });
  h.surface.pin('n.md:1', disposed);
  h.surface.destroy();
  h.surface.destroy();
  expect(disposed).toHaveBeenCalledTimes(1);
});

it('reports a throwing cancellation once after revoking every conflicting acquisition', () => {
  const h = harness();
  const list = rows(3);
  h.surface.update(list, presentation);
  h.surface.element('n.md:0')?.focus();
  const error = new Error('cancel failed');
  const first = vi.fn(() => {
    throw error;
  });
  const second = vi.fn();
  h.surface.pin('n.md:1', first);
  h.surface.pin('n.md:2', second);
  const tasks = list.rows.flatMap((row) => (row.kind === 'task' ? [row.task] : []));
  tasks.reverse();
  const reverse = buildTaskListRows(tasks, { by: 'none' });
  h.surface.update(reverse, presentation);
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
  expect(h.reportFailure).toHaveBeenCalledExactlyOnceWith(error);
  h.surface.update(reverse, presentation);
  expect([...h.surface.cards()].map(([key]) => key)).toEqual(reverse.taskKeys);
  expect(first).toHaveBeenCalledTimes(1);
  h.surface.destroy();
});

it('lets a cancellation reenter update without applying the superseded projection', () => {
  const h = harness();
  const list = rows(3);
  h.surface.update(list, presentation);
  h.surface.element('n.md:0')?.focus();
  h.surface.pin('n.md:2', () => {
    h.surface.update(rows(4), presentation);
  });
  const tasks = list.rows.flatMap((row) => (row.kind === 'task' ? [row.task] : []));
  tasks.reverse();
  h.surface.update(buildTaskListRows(tasks, { by: 'none' }), presentation);
  expect(h.surface.rows.taskKeys).toEqual(rows(4).taskKeys);
  expect([...h.surface.cards()].map(([key]) => key)).toEqual(rows(4).taskKeys);
  h.surface.destroy();
});

it('establishes a grown layout extent before restoring its fractional anchor', () => {
  const h = harness(true);
  const list = rows(100);
  h.surface.update(list, presentation);
  h.scrollTo(4272.5);
  h.frame();
  for (const key of list.taskKeys) h.heights.set(key, 96);
  h.surface.update(list, { ...presentation, revision: 'layout:2', estimate: () => 96 });
  expect(h.scroll.scrollTop).toBe(8544.5);
  expect(h.surface.element('n.md:89')).toBeDefined();
  h.surface.destroy();
});

it('keeps a reentrant document-rebind refresh authoritative during owner cancellation', () => {
  const h = harness();
  h.surface.update(rows(3), presentation);
  let replacement: HTMLElement | undefined;
  h.surface.pin('n.md:1', () => {
    h.surface.update(rows(4), presentation);
    replacement = h.surface.element('n.md:3');
  });
  h.surface.suspend();
  h.surface.resume();
  expect(replacement).toBeDefined();
  expect(h.surface.element('n.md:3')).toBe(replacement);
  expect(replacement?.isConnected).toBe(true);
  h.surface.destroy();
});

it('positions a newly mounted offscreen pin above the focused window before protecting it', () => {
  const h = harness();
  h.surface.update(rows(100), presentation);
  h.surface.reveal('n.md:99');
  const control = expectDefined(h.surface.element('n.md:99')).createEl('input');
  control.focus();
  expect(h.surface.element('n.md:0')).toBeUndefined();
  const canceled = vi.fn();
  const release = h.surface.pin('n.md:0', canceled);
  h.frame();
  const pinned = expectDefined(h.surface.element('n.md:0'));
  const assertOrder = () => {
    expect(h.host.firstElementChild).toBe(pinned);
    expect(h.host.children[1]?.classList.contains('abyss-virtual-row-spacer')).toBe(true);
    const actual = Array.from(h.host.children).flatMap((element) => {
      const key = (element as HTMLElement).dataset['key'];
      return key === undefined ? [] : [key];
    });
    expect(actual).toEqual([...h.surface.cards()].map(([key]) => key));
    expect(document.activeElement).toBe(control);
    expect(canceled).not.toHaveBeenCalled();
  };
  assertOrder();
  h.resize();
  h.frame();
  assertOrder();
  release();
  h.surface.destroy();
});

it('propagates a supplied synchronous mount failure without reporting and recovers on refresh', () => {
  const h = harness();
  const error = new Error('supplied mount');
  h.surface.update(rows(100), presentation);
  h.scrollTo(2000);
  expect(h.pending()).toBe(1);
  h.mount.mockImplementationOnce(() => {
    throw error;
  });
  expect(() => {
    h.surface.update(rows(100), presentation, 'throw');
  }).toThrow(error);
  expect(h.reportFailure).not.toHaveBeenCalled();
  expect(h.pending()).toBe(0);
  h.scrollTo(3000);
  h.resize();
  h.frame();
  expect(h.pending()).toBe(0);
  h.surface.update(rows(100), presentation, 'throw');
  expect(h.surface.element('n.md:65')).toBeDefined();
});

it('contains a later native frame failure after a supplied throw-mode update', () => {
  const h = harness();
  const error = new Error('native mount');
  h.surface.update(rows(100), presentation, 'throw');
  h.mount.mockImplementationOnce(() => {
    throw error;
  });
  h.scrollTo(2000);
  expect(h.pending()).toBe(1);
  expect(() => {
    h.frame();
  }).not.toThrow();
  expect(h.reportFailure).toHaveBeenCalledExactlyOnceWith(error);
  h.scrollTo(3000);
  h.resize();
  h.frame();
  expect(h.reportFailure).toHaveBeenCalledTimes(1);
});

it('invalidates offscreen font measurements through the actual font completion event', () => {
  const h = harness();
  h.heights.set('n.md:0', 96);
  h.surface.update(rows(100), presentation);
  h.surface.reveal('n.md:99');
  h.heights.clear();
  document.fonts.dispatchEvent(new Event('loadingdone'));
  h.frame();
  h.surface.reveal('n.md:99');
  expect(h.scroll.scrollTop).toBe(4320);
});

it('rebinds adopted task rows and cancels old native work before disposing new-owner callbacks', () => {
  const h = harness();
  h.surface.update(rows(100), presentation);
  h.scrollTo(1000);
  const frame = document.body.createEl('iframe');
  const doc = expectDefined(frame.contentDocument);
  const win = expectDefined(frame.contentWindow);
  Object.defineProperty(doc, 'fonts', { value: new EventTarget(), configurable: true });
  Object.defineProperty(win, 'ResizeObserver', {
    value: window.ResizeObserver,
    configurable: true,
  });
  const pending: FrameRequestCallback[] = [];
  vi.spyOn(win, 'requestAnimationFrame').mockImplementation((callback) => {
    pending.push(callback);
    return pending.length;
  });
  const cancel = vi.spyOn(win, 'cancelAnimationFrame').mockImplementation(() => {});
  doc.body.append(h.scroll);
  h.surface.update(rows(100), presentation);
  expect(h.pending()).toBe(0);
  expect(h.surface.element('n.md:20')?.ownerDocument).toBe(doc);
  h.scroll.dispatchEvent(new Event('scroll'));
  expect(pending).toHaveLength(1);
  expectDefined(pending.shift())(0);
  h.scroll.dispatchEvent(new Event('scroll'));
  const late = [...pending];
  h.surface.destroy();
  expect(cancel).toHaveBeenCalled();
  late.forEach((callback) => {
    callback(0);
  });
  expect(h.observed.size).toBe(0);
  expect(h.host.children).toHaveLength(0);
  expect(h.reportFailure).not.toHaveBeenCalled();
});
