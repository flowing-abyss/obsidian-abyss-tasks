import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TaskListSurface,
  type TaskListPresentation,
} from '../src/panels/task-list/TaskListSurface';
import {
  buildTaskListRows,
  indexedRows,
  type TaskListRow,
} from '../src/panels/task-list/taskListRows';
import { LogicalScrollWindow } from '../src/panels/virtualization/logicalScrollWindow';
import {
  cssDeclarationsFor,
  expectDefined,
  freshContainer,
  loadPluginStyles,
  task,
} from './helpers';
import { taskViewportOwner } from './support/taskViewportOwner';
import { numericRowSource } from './support/virtualSurfaceAudit';
import { taskKeys } from './task-list-row-assertions';

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
function harness(clampWrites = false, sameHost = false, clampExtent = false) {
  const scroll = freshContainer();
  document.body.append(scroll);
  Object.defineProperty(document, 'fonts', { value: new EventTarget(), configurable: true });
  const host = sameHost ? scroll : scroll.createDiv();
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
  let onMeasure: ((key: string) => void) | undefined;
  const frameRow = (element: HTMLElement): HTMLElement =>
    element.hasClass('abyss-virtual-row-frame')
      ? (expectDefined(element.firstElementChild) as HTMLElement)
      : element;
  const flowHeight = (element: HTMLElement): number => {
    if (element.hasClass('abyss-virtual-row-frame') && element.firstElementChild === null) return 0;
    if (
      element.hasClass('abyss-virtual-row-frame-clipped') ||
      element.hasClass('abyss-virtual-row-spacer')
    )
      return Number.parseFloat(element.style.getPropertyValue('--abyss-virtual-row-height'));
    return heights.get(frameRow(element).dataset['key'] ?? '') ?? 48;
  };
  const writes = vi.fn((value: number) => {
    const style = window.getComputedStyle(host);
    const padding = [style.paddingTop, style.paddingBottom].reduce((sum, value) => {
      const pixels = Number.parseFloat(value);
      return sum + (Number.isFinite(pixels) ? pixels : 0);
    }, 0);
    const extent = Array.from(host.children).reduce((sum, child) => {
      const element = child as HTMLElement;
      return sum + flowHeight(element);
    }, 0);
    top = clampWrites ? Math.max(0, Math.min(value, origin + padding + extent - height)) : value;
  });
  const nativeExtent = (): number =>
    Array.from(host.children).reduce((sum, child) => {
      const row = child as HTMLElement;
      return sum + flowHeight(row);
    }, origin);
  Object.defineProperties(scroll, {
    clientHeight: { get: () => height },
    scrollHeight: { get: nativeExtent, configurable: true },
    scrollTop: {
      get: () => {
        if (clampExtent) top = Math.max(0, Math.min(top, nativeExtent() - height));
        return top;
      },
      set: writes,
      configurable: true,
    },
  });
  Object.defineProperty(host, 'clientWidth', { get: () => width });
  const heights = new Map<string, number>();
  const destroyed: string[] = [];
  const mount = vi.fn((container: HTMLElement, row: TaskListRow) => {
    const element = container.createDiv();
    const label = element.createSpan({ text: row.kind === 'task' ? row.task.title : row.label });
    element.dataset['key'] = row.key;
    element.tabIndex = -1;
    element.getBoundingClientRect = () => {
      onMeasure?.(row.key);
      const padding = Number.parseFloat(window.getComputedStyle(host).paddingTop);
      let y = origin + host.clientTop + (Number.isFinite(padding) ? padding : 0) - top;
      for (const child of host.children) {
        if (child.contains(element)) break;
        const sibling = child as HTMLElement;
        y += flowHeight(sibling);
      }
      const offset = Number.parseFloat(
        element.style.getPropertyValue('--abyss-virtual-row-offset'),
      );
      y += Number.isFinite(offset) ? offset : 0;
      const rowHeight = heights.get(row.key) ?? 48;
      return {
        height: rowHeight,
        width,
        top: y,
        bottom: y + rowHeight,
        left: 0,
        right: width,
        x: 0,
        y,
        toJSON: () => ({}),
      };
    };
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
  const mountedChanged = vi.fn();
  const surface = new TaskListSurface({
    host,
    scroll,
    mount,
    mountedChanged,
    reportFailure,
  });
  return {
    host,
    style(
      property:
        | 'paddingTop'
        | 'paddingBottom'
        | 'paddingLeft'
        | 'paddingRight'
        | 'marginLeft'
        | 'marginRight'
        | 'fontWeight'
        | 'fontStyle'
        | 'letterSpacing',
      value: string,
      element = host,
    ) {
      element.style[property] = value;
    },
    scroll,
    surface,
    mount,
    destroyed,
    heights,
    writes,
    observed,
    frames,
    reportFailure,
    mountedChanged,
    onMeasure(callback: ((key: string) => void) | undefined) {
      onMeasure = callback;
    },
    resizeCallback: () => expectDefined(resize),
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

describe('surface transaction admission', () => {
  it('bounds size reads in a retained 10,000-row window without skipping measurements', () => {
    const h = harness(false, true);
    const counts = { widths: 0, heights: 0, rects: 0, mounts: 0, updates: 0, destroys: 0 };
    // Keep the numeric diagnostic independent of rich card and hydration costs.
    const host = h.host.createDiv();
    Object.defineProperties(host, {
      clientWidth: {
        get: () => {
          counts.widths++;
          return 700;
        },
      },
      clientHeight: {
        get: () => {
          counts.heights++;
          return 900;
        },
      },
      scrollHeight: { get: () => 640000 },
    });
    const surface = new TaskListSurface<number>({
      host,
      scroll: host,
      mount: (container) => {
        counts.mounts++;
        const element = container.createDiv();
        element.getBoundingClientRect = () => {
          counts.rects++;
          return { height: 64 } as DOMRect;
        };
        return {
          element,
          update: () => {
            counts.updates++;
          },
          destroy: () => {
            counts.destroys++;
            element.remove();
          },
        };
      },
      mountedChanged: () => {},
      reportFailure: (error) => {
        throw error;
      },
    });
    const list = indexedRows(
      Array.from({ length: 10000 }, (_, n) => ({
        kind: 'task' as const,
        key: String(n),
        taskKey: String(n),
        task: n,
      })),
    );
    const reset = () => {
      for (const key of Object.keys(counts) as Array<keyof typeof counts>) counts[key] = 0;
    };
    surface.update(list, {
      revision: 'fixed',
      preserveAnchor: true,
      estimate: () => 64,
      measurementRevision: () => '',
    });
    const initial = { ...counts };
    reset();
    host.scrollTop = 5000;
    host.dispatchEvent(new Event('scroll'));
    h.frame();
    const disjoint = { ...counts };
    const priorKeys = surface.mountedKeys();
    const priorElements = priorKeys.map((key) => surface.element(key));
    reset();
    host.scrollTop = 5001;
    host.dispatchEvent(new Event('scroll'));
    h.frame();
    expect(initial.mounts).toBeGreaterThan(0);
    expect(disjoint.mounts).toBeGreaterThan(0);
    expect(disjoint.destroys).toBe(initial.mounts);
    expect(surface.mountedKeys()).toEqual(priorKeys);
    expect(priorKeys.map((key) => surface.element(key))).toEqual(priorElements);
    expect(counts.mounts + counts.updates + counts.destroys).toBe(0);
    expect(counts.rects).toBe(priorKeys.length);
    expect(counts.widths).toBeLessThanOrEqual(40);
    expect(counts.heights).toBeLessThanOrEqual(40);
    surface.destroy();
    h.surface.destroy();
  });

  it.each([false, true])(
    'retires a mount hidden by its callback even if cleanup restores geometry: %s',
    (restore) => {
      const h = harness();
      const mount = expectDefined(h.mount.getMockImplementation());
      h.mount.mockImplementationOnce((host, row) => {
        const result = mount(host, row);
        h.size(0, 0);
        return {
          ...result,
          destroy: () => {
            result.destroy();
            if (restore) h.size(600, 480);
          },
        };
      });
      h.surface.update(rows(100), presentation);
      expect(h.mount).toHaveBeenCalledTimes(1);
      expect(h.surface.mountedKeys()).toEqual([]);
      expect(h.writes).not.toHaveBeenCalled();
      h.size(600, 480);
      h.surface.resume();
      expect(h.surface.element('n.md:0')?.isConnected).toBe(true);
      expect(h.reportFailure).not.toHaveBeenCalled();
      h.surface.destroy();
    },
  );

  it.each(['update', 'destroy'] as const)(
    'stops row work when a retained mount %s hides the surface',
    (operation) => {
      const h = harness();
      h.surface.update(rows(100), presentation);
      const mounts = h.mount.mock.results.map(
        (result) => result.value as ReturnType<typeof h.mount>,
      );
      const calls = mounts.map((mount) => {
        const original = mount[operation];
        return vi.spyOn(mount, operation).mockImplementation((row?: TaskListRow) => {
          if (operation === 'update') original(expectDefined(row));
          else (original as () => void)();
          h.size(0, 0);
        });
      });
      h.writes.mockClear();
      if (operation === 'update') h.surface.update(rows(100), { ...presentation, revision: 'new' });
      else {
        h.scrollTo(3000);
        h.frame();
      }
      expect(calls.reduce((sum, call) => sum + call.mock.calls.length, 0)).toBe(1);
      expect(h.writes).not.toHaveBeenCalled();
      for (const call of calls) call.mockRestore();
      h.size(600, 480);
      h.surface.resume();
      expect(h.surface.reveal('n.md:99')?.textContent).toBe('Task 99');
      expect(h.reportFailure).not.toHaveBeenCalled();
      h.surface.destroy();
    },
  );

  it.each(['update', 'rebind'] as const)(
    'preserves a source installed by %s eviction cleanup',
    (operation) => {
      const h = harness();
      h.surface.update(rows(3), presentation);
      const retiring = expectDefined(
        h.mount.mock.results[operation === 'update' ? 2 : 0]?.value,
      ) as ReturnType<typeof h.mount>;
      const destroy = retiring.destroy;
      let replacement: HTMLElement | undefined;
      vi.spyOn(retiring, 'destroy').mockImplementationOnce(() => {
        destroy();
        h.surface.update(rows(4), presentation);
        replacement = h.surface.element('n.md:3');
        h.mountedChanged.mockClear();
      });
      if (operation === 'update') h.surface.update(rows(2), presentation);
      else {
        h.surface.suspend();
        h.surface.resume();
      }
      expect(replacement?.isConnected).toBe(true);
      expect(h.surface.element('n.md:3')).toBe(replacement);
      expect(h.mountedChanged).not.toHaveBeenCalled();
      expect(h.surface.mountedKeys()).toEqual(['n.md:0', 'n.md:1', 'n.md:2', 'n.md:3']);
      expect(h.reportFailure).not.toHaveBeenCalled();
      h.surface.destroy();
    },
  );

  it.each(['hide', 'replace'] as const)('revalidates mounted settlement after %s', (operation) => {
    const h = harness();
    h.surface.update(rows(100), presentation);
    const measured = vi.fn();
    h.onMeasure(measured);
    let replacement: HTMLElement | undefined;
    h.mountedChanged.mockImplementationOnce(() => {
      if (operation === 'hide') h.size(0, 0);
      else {
        h.surface.update(rows(2), presentation);
        replacement = h.surface.element('n.md:0');
        measured.mockClear();
        h.writes.mockClear();
      }
    });
    h.writes.mockClear();
    expect(h.surface.reveal('n.md:99')).toBeUndefined();
    expect(measured).not.toHaveBeenCalled();
    expect(h.writes).not.toHaveBeenCalled();
    h.size(600, 480);
    h.resize();
    h.frame();
    if (operation === 'replace') expect(h.surface.element('n.md:0')).toBe(replacement);
    else expect(h.surface.reveal('n.md:99')).toBeDefined();
    expect(h.reportFailure).not.toHaveBeenCalled();
    h.surface.destroy();
  });

  it('stops publication after pin invalidation hides the surface', () => {
    const h = harness();
    const list = rows(3);
    h.surface.update(list, presentation);
    h.surface.element('n.md:0')?.focus();
    h.surface.pin('n.md:2', () => {
      h.size(0, 0);
    });
    const reversed = indexedRows([...list.slice(0, list.rowCount)].reverse());
    const updates = h.mount.mock.results.map((result) =>
      vi.spyOn(result.value as ReturnType<typeof h.mount>, 'update'),
    );
    h.writes.mockClear();
    h.surface.update(reversed, presentation);
    expect(updates.every((update) => update.mock.calls.length === 0)).toBe(true);
    expect(h.writes).not.toHaveBeenCalled();
    h.size(600, 480);
    h.surface.resume();
    expect(h.surface.mountedKeys()).toEqual(['n.md:2', 'n.md:1', 'n.md:0']);
    expect(h.reportFailure).not.toHaveBeenCalled();
    h.surface.destroy();
  });

  it.each([false, true])(
    'cancels hidden measurement readiness without reporting success or pending: %s',
    (waitForReady) => {
      const h = harness();
      const original = expectDefined(h.mount.getMockImplementation());
      let hide = false;
      const ready = vi.fn(() => {
        if (hide) h.size(0, 0);
        return !hide;
      });
      h.mount.mockImplementation((host, row) => ({
        ...original(host, row),
        measurementReady: ready,
      }));
      h.surface.update(rows(100), presentation);
      hide = true;
      ready.mockClear();
      h.writes.mockClear();
      expect(
        waitForReady
          ? h.surface.reveal('n.md:99', { waitForReady: true })
          : h.surface.reveal('n.md:99'),
      ).toBeUndefined();
      expect(ready).toHaveBeenCalledTimes(1);
      expect(h.writes).not.toHaveBeenCalled();
      hide = false;
      h.size(600, 480);
      h.surface.resume();
      expect(h.surface.reveal('n.md:99')).toBeDefined();
      expect(h.reportFailure).not.toHaveBeenCalled();
      h.surface.destroy();
    },
  );

  it('stops reveal corrections when destination validation hides the surface', () => {
    const h = harness();
    h.surface.update(rows(100), presentation);
    let reads = 0;
    h.onMeasure((key) => {
      if (key !== 'n.md:99' || ++reads !== 2) return;
      h.size(0, 0);
      h.destroyed.length = 0;
      h.writes.mockClear();
    });
    expect(h.surface.reveal('n.md:99')).toBeUndefined();
    expect(reads).toBe(2);
    expect(h.destroyed).toEqual([]);
    expect(h.writes).not.toHaveBeenCalled();
    h.onMeasure(undefined);
    h.size(600, 480);
    h.surface.resume();
    expect(h.surface.reveal('n.md:99')).toBeDefined();
    expect(h.reportFailure).not.toHaveBeenCalled();
    h.surface.destroy();
  });

  it.each(['beforeWrite', 'afterWrite'] as const)(
    'retires native ownership when %s hides without vetoing',
    (phase) => {
      const h = harness();
      h.surface.update(rows(100), presentation);
      const firstAfter = vi.fn(() => {
        if (phase === 'afterWrite') h.size(0, 0);
      });
      const release = h.surface.observeNativeWrites(
        {
          beforeWrite: () => {
            if (phase === 'beforeWrite') h.size(0, 0);
            return true;
          },
          afterWrite: firstAfter,
        },
        () => {},
      );
      const laterBefore = vi.fn(() => true);
      const laterAfter = vi.fn();
      const releaseLater = h.surface.observeNativeWrites(
        { beforeWrite: laterBefore, afterWrite: laterAfter },
        () => {},
      );
      h.writes.mockClear();
      expect(h.surface.reveal('n.md:99')).toBeUndefined();
      expect(h.writes).not.toHaveBeenCalled();
      expect(laterAfter).not.toHaveBeenCalled();
      if (phase === 'beforeWrite') {
        expect(firstAfter).not.toHaveBeenCalled();
        expect(laterBefore).not.toHaveBeenCalled();
      } else expect(firstAfter).toHaveBeenCalledTimes(1);
      release();
      releaseLater();
      h.size(600, 480);
      h.surface.resume();
      expect(h.surface.reveal('n.md:99')).toBeDefined();
      expect(h.reportFailure).not.toHaveBeenCalled();
      h.surface.destroy();
    },
  );
});

describe('TaskListSurface', () => {
  it('bounds 10,000 rows, reveals synchronously, keeps sparse owner pins, and tears down once', () => {
    const h = harness();
    const list = rows(10000);
    h.surface.update(list, presentation);
    expect([...h.surface.cards()].length).toBeLessThanOrEqual(100);
    const last = expectDefined(list.taskKeyAt(list.taskCount - 1));
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
  it('restores a retired search holder inside its same frame before mounted settlement', () => {
    const h = harness();
    h.surface.update(rows(1), presentation);
    const mount = expectDefined(h.mount.mock.results[0]?.value) as ReturnType<typeof h.mount>;
    const element = mount.element;
    const frame = element.parentElement;
    vi.spyOn(mount, 'update').mockImplementation(() => {
      element.remove();
    });
    h.surface.update(rows(1), presentation);
    expect(element.isConnected).toBe(true);
    expect(element.parentElement).toBe(frame);
    expect(h.surface.element('n.md:0')).toBe(element);
    expect(h.mount).toHaveBeenCalledTimes(1);
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
  const prior = [...list.slice(0, list.rowCount)].flatMap((row) =>
    row.kind === 'task' ? [row.task] : [],
  );
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
  const tasks = [...list.slice(0, list.rowCount)].flatMap((row) =>
    row.kind === 'task' ? [row.task] : [],
  );
  h.surface.update(buildTaskListRows([...tasks].reverse(), { by: 'none' }), presentation);
  expect(document.activeElement).toBe(control);
  expect(h.surface.element('n.md:1')?.contains(control ?? null)).toBe(true);
  expect(h.surface.rows.taskKeyAt(0)).toBe('n.md:99');
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
  const tasks = [...list.slice(0, list.rowCount)].flatMap((row) =>
    row.kind === 'task' ? [row.task] : [],
  );
  const changed = tasks.map((value) => task({ ...value, title: `Updated ${value.title}` }));
  h.surface.update(buildTaskListRows([...changed].reverse(), { by: 'none' }), presentation);
  expect(canceled).toHaveBeenCalledExactlyOnceWith();
  expect(document.activeElement).toBe(control);
  expect(first.textContent).toBe('Updated Task 1');
  expect([...h.surface.cards()].map(([key]) => key)).toEqual(
    taskKeys(h.surface.rows).filter((key) => h.surface.element(key) !== undefined),
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
  const tasks = [...list.slice(0, list.rowCount)].flatMap((row) =>
    row.kind === 'task' ? [row.task] : [],
  );
  tasks.reverse();
  const reverse = buildTaskListRows(tasks, { by: 'none' });
  h.surface.update(reverse, presentation);
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
  expect(h.reportFailure).toHaveBeenCalledExactlyOnceWith(error);
  h.surface.update(reverse, presentation);
  expect([...h.surface.cards()].map(([key]) => key)).toEqual(taskKeys(reverse));
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
  const tasks = [...list.slice(0, list.rowCount)].flatMap((row) =>
    row.kind === 'task' ? [row.task] : [],
  );
  tasks.reverse();
  h.surface.update(buildTaskListRows(tasks, { by: 'none' }), presentation);
  expect(taskKeys(h.surface.rows)).toEqual(taskKeys(rows(4)));
  expect([...h.surface.cards()].map(([key]) => key)).toEqual(taskKeys(rows(4)));
  h.surface.destroy();
});

it('establishes a grown layout extent before restoring its fractional anchor', () => {
  const h = harness(true);
  const list = rows(100);
  h.surface.update(list, presentation);
  h.scrollTo(4272.5);
  h.frame();
  for (const key of taskKeys(list)) h.heights.set(key, 96);
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
    expect(h.host.firstElementChild).toBe(pinned.parentElement);
    expect(h.host.children[1]?.classList.contains('abyss-virtual-row-spacer')).toBe(true);
    const actual = Array.from(h.host.children).flatMap((element) => {
      const key = (element.firstElementChild as HTMLElement | null)?.dataset['key'];
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

it('admits an adopted owner before coalescing a pending old-window frame', () => {
  const h = harness();
  h.surface.update(rows(1000), presentation);
  h.scrollTo(480);
  const oldFrame = expectDefined([...h.frames.values()][0]);
  const cancel = vi.spyOn(window, 'cancelAnimationFrame');
  const owner = taskViewportOwner();
  owner.doc.body.append(h.scroll);
  h.scrollTo(47520.5);
  expect(owner.frames.size).toBe(1);
  expect(cancel).toHaveBeenCalled();
  owner.flush();
  expect(h.surface.element('n.md:999')?.isConnected).toBe(true);
  expect([...h.surface.cards()].length).toBeLessThan(30);
  expect(taskKeys(h.surface.rows)).toHaveLength(1000);
  expect(h.scroll.scrollTop).toBe(47520.5);
  h.scrollTo(24000);
  const currentFrame = [...owner.frames.values()][0];
  oldFrame(0);
  expect([...owner.frames.values()]).toEqual([currentFrame]);
  owner.flush();
  expect(h.surface.element('n.md:500')?.isConnected).toBe(true);
  h.surface.destroy();
  owner.destroy();
});

it.each(['same owner', 'adopted owner'] as const)(
  'recovers from transient inactivity on ordinary scroll in the %s without refreshing',
  (destination) => {
    const h = harness();
    h.surface.update(rows(1000), presentation);
    h.scroll.remove();
    h.resize();
    h.frame();
    const mounted = h.mount.mock.calls.length;
    expect(h.pending()).toBe(0);
    const owner = destination === 'adopted owner' ? taskViewportOwner() : undefined;
    (owner?.doc ?? document).body.append(h.scroll);
    h.scrollTo(47520);
    if (owner === undefined) h.frame();
    else owner.flush();
    expect(h.surface.element('n.md:999')?.isConnected).toBe(true);
    expect(h.mount.mock.calls.length).toBeGreaterThan(mounted);
    expect([...h.surface.cards()].length).toBeLessThan(30);
    expect(taskKeys(h.surface.rows)).toHaveLength(1000);
    h.surface.destroy();
    expect(h.observed.size).toBe(0);
    expect(owner?.observers.every(({ elements }) => elements.size === 0) ?? true).toBe(true);
    owner?.destroy();
  },
);

it('keeps resize recovery alive after a zero-sized frame without mounting while hidden', () => {
  const h = harness();
  h.surface.update(rows(1000), presentation);
  h.scrollTo(47520);
  h.size(0, 0);
  h.frame();
  const mounted = h.mount.mock.calls.length;
  h.resize();
  expect(h.pending()).toBe(0);
  expect(h.mount).toHaveBeenCalledTimes(mounted);
  h.size(600, 480);
  if (h.observed.has(h.scroll)) h.resize();
  h.frame();
  expect(h.surface.element('n.md:999')?.isConnected).toBe(true);
  h.surface.destroy();
});

it('retired observer, font and frame callbacks cannot change current work or revive a destroyed surface', () => {
  const h = harness();
  const fontEvents = vi.spyOn(document.fonts, 'addEventListener');
  h.surface.update(rows(1000), presentation);
  const oldResize = h.resizeCallback();
  const oldFont = expectDefined(fontEvents.mock.calls.find(([name]) => name === 'loadingdone'))[1];
  h.scrollTo(480);
  const oldFrame = expectDefined([...h.frames.values()][0]);
  const owner = taskViewportOwner();
  owner.doc.body.append(h.scroll);
  // Explicit update isolates stale-callback safety from admission, tested separately above.
  h.surface.update(rows(1000), presentation);
  const deliverOld = () => {
    oldResize([], {} as ResizeObserver);
    if (typeof oldFont === 'function') oldFont(new Event('loadingdone'));
    else oldFont.handleEvent(new Event('loadingdone'));
    oldFrame(0);
  };
  h.scrollTo(47520);
  const pending = [...owner.frames];
  const mounts = h.mount.mock.calls.length;
  deliverOld();
  expect([...owner.frames]).toEqual(pending);
  expect(h.mount).toHaveBeenCalledTimes(mounts);
  owner.flush();
  expect(h.surface.element('n.md:999')?.isConnected).toBe(true);
  const requests = owner.request.mock.calls.length;
  deliverOld();
  expect(owner.request).toHaveBeenCalledTimes(requests);
  h.surface.destroy();
  deliverOld();
  for (const { callback } of owner.observers) callback([], {} as ResizeObserver);
  h.scroll.dispatchEvent(new owner.win.Event('scroll'));
  owner.flush();
  expect(h.host.children).toHaveLength(0);
  expect(owner.observers.every(({ elements }) => elements.size === 0)).toBe(true);
  expect(h.reportFailure).not.toHaveBeenCalled();
  owner.destroy();
});

it('a cancelled same-owner frame cannot consume a newer frame after temporary inactivity', () => {
  const h = harness();
  h.surface.update(rows(1000), presentation);
  h.scrollTo(480);
  const retired = expectDefined([...h.frames.values()][0]);
  h.size(600, 0);
  h.resize();
  h.size(600, 480);
  h.scrollTo(47520);
  const current = [...h.frames];
  const mounted = h.mount.mock.calls.length;
  retired(0);
  expect([...h.frames]).toEqual(current);
  expect(h.mount).toHaveBeenCalledTimes(mounted);
  h.frame();
  expect(h.surface.element('n.md:999')?.isConnected).toBe(true);
  h.surface.destroy();
});

it.each(['fontWeight', 'fontStyle', 'letterSpacing', 'fontSize'] as const)(
  'invalidates offscreen task heights after a loaded %s change without font loading',
  (property) => {
    const h = harness();
    h.heights.set('n.md:0', 96);
    h.surface.update(rows(100), presentation);
    h.surface.reveal('n.md:99');
    expect(h.scroll.scrollTop).toBe(4368);
    h.heights.clear();
    h.resize();
    h.frame();
    h.scrollTo(4300.25);
    h.frame();
    expect(h.scroll.scrollTop).toBe(4300.25);
    h.surface.reveal('n.md:99');
    expect(h.scroll.scrollTop).toBe(4368);
    h.host.style[property] = {
      fontWeight: '900',
      fontStyle: 'italic',
      letterSpacing: '2px',
      fontSize: '24px',
    }[property];
    h.resize();
    h.frame();
    h.surface.reveal('n.md:99');
    expect(h.scroll.scrollTop).toBe(4320);
    expect([...h.surface.cards()].length).toBeLessThan(30);
    h.surface.destroy();
  },
);

describe('task anchor through replacement estimates', () => {
  const estimated = { ...presentation, estimate: () => 64 };
  it.each(['frame', 'update', 'resume'] as const)(
    'retains a tall keyed anchor and corrects only preceding growth on %s',
    (route) => {
      const h = harness();
      const list = rows(100);
      h.heights.set('n.md:2', 120);
      h.surface.update(list, estimated);
      h.scrollTo(176);
      h.frame();
      const anchor = expectDefined(h.surface.element('n.md:2'));
      expect(anchor.getBoundingClientRect().top).toBe(-80);
      expect(anchor.getBoundingClientRect().bottom).toBe(40);
      h.heights.set('n.md:0', 68);
      h.heights.set('n.md:2', 160);
      h.style('fontWeight', '800');
      h.scrollTo(176.5);
      if (route === 'frame') h.frame();
      else if (route === 'update') h.surface.update(list, estimated);
      else {
        h.surface.suspend();
        h.surface.update(list, estimated);
        h.surface.resume();
      }
      expect(h.reportFailure).not.toHaveBeenCalled();
      const retained = expectDefined(h.surface.element('n.md:2'));
      if (route !== 'resume') expect(retained).toBe(anchor);
      expect(retained.getBoundingClientRect().top).toBe(-80.5);
      expect(h.scroll.scrollTop).toBe(196.5);
    },
  );
  it('keeps an anchor whose offset exceeds replacement overscan mounted for measurement', () => {
    const h = harness();
    h.heights.set('n.md:0', 1000);
    h.surface.update(rows(100), estimated);
    h.scrollTo(800);
    h.frame();
    const anchor = expectDefined(h.surface.element('n.md:0'));
    h.style('fontStyle', 'italic');
    h.heights.set('n.md:0', 1100);
    h.scrollTo(800.5);
    h.frame();
    expect(h.surface.element('n.md:0')).toBe(anchor);
    expect(anchor.getBoundingClientRect().top).toBe(-800.5);
    expect(anchor.getBoundingClientRect().bottom).toBe(299.5);
  });
  it.each([true, false])(
    'anchors the last four visible pixels with padding (same host %s)',
    (sameHost) => {
      const h = harness(false, sameHost);
      h.style('paddingTop', '8px');
      if (!sameHost) h.origin(100);
      h.heights.set('n.md:0', 120);
      h.surface.update(rows(100), estimated);
      h.scrollTo(sameHost ? 124 : 224);
      h.frame();
      const anchor = expectDefined(h.surface.element('n.md:0'));
      expect(anchor.getBoundingClientRect().bottom).toBe(4);
      h.heights.set('n.md:0', 160);
      h.style('letterSpacing', '1px');
      h.scrollTo(sameHost ? 124.5 : 224.5);
      h.frame();
      expect(h.surface.element('n.md:0')).toBe(anchor);
      expect(anchor.getBoundingClientRect().top).toBe(-116.5);
    },
  );
  it.each([true, false])(
    'preserves zero scroll through anchored update and resume (same host %s)',
    (sameHost) => {
      const h = harness(false, sameHost);
      h.style('paddingTop', '8px');
      if (!sameHost) {
        h.origin(100);
        Object.defineProperty(h.host, 'clientTop', { value: 2 });
      }
      const list = rows(100);
      h.surface.update(list, estimated);
      h.writes.mockClear();
      h.surface.update(list, estimated);
      h.surface.suspend();
      h.surface.update(list, estimated);
      h.surface.resume();
      h.surface.resume();
      expect(h.scroll.scrollTop).toBe(0);
      expect(h.writes).not.toHaveBeenCalled();
      expect(h.surface.element('n.md:0')?.getBoundingClientRect().top).toBe(sameHost ? 8 : 110);
    },
  );
  it('gives explicit reveal priority over a layout anchor and preserves ordinary elastic scroll', () => {
    const h = harness(false, true);
    h.style('paddingTop', '8px');
    h.heights.set('n.md:0', 120);
    h.surface.update(rows(100), estimated);
    h.scrollTo(88);
    h.frame();
    h.style('fontWeight', '800');
    h.surface.reveal('n.md:99');
    const target = expectDefined(h.surface.element('n.md:99'));
    expect(target.getBoundingClientRect().bottom).toBeLessThanOrEqual(480);
    expect(target.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
    h.surface.reveal('n.md:0');
    h.writes.mockClear();
    for (const top of [88.5, -12, -12, 88.5]) {
      h.scrollTo(top);
      h.frame();
    }
    expect(h.writes).not.toHaveBeenCalled();
  });
});

describe('explicit task reveal through destination measurement', () => {
  it.each([172, 900])(
    'retains the requested far row with actual height%s through native clamping and observer frames',
    (height) => {
      const h = harness(true);
      h.size(390, 684);
      for (let index = 0; index < 4000; index++) h.heights.set(`n.md:${index}`, height);
      h.surface.update(rows(4000), { ...presentation, estimate: () => 64 });
      h.style('fontWeight', '800');
      const key = 'n.md:3999';
      const requested = expectDefined(h.surface.reveal(key));
      const checkVisible = () => {
        expect(h.reportFailure).not.toHaveBeenCalled();
        expect(h.surface.element(key)).toBe(requested);
        expect(requested.isConnected).toBe(true);
        const rect = requested.getBoundingClientRect();
        expect(rect.bottom).toBeGreaterThan(0);
        expect(rect.top).toBeLessThan(684);
        expect(Number.isFinite(h.scroll.scrollTop)).toBe(true);
        expect(h.scroll.scrollTop).toBeGreaterThan(0);
        expect([...h.surface.cards()].length).toBeLessThan(30);
      };
      checkVisible();
      const initialTop = h.scroll.scrollTop;
      for (let frame = 0; frame < 3; frame++) {
        h.resize();
        h.scrollTo(h.scroll.scrollTop);
        h.frame();
        checkVisible();
      }
      expect(h.scroll.scrollTop).toBe(initialTop);
      // A tall row already intersects: repeating reveal must retain that native viewport.
      h.writes.mockClear();
      expect(h.surface.reveal(key)).toBe(requested);
      expect(h.writes).not.toHaveBeenCalled();
      h.scrollTo(initialTop - 0.5);
      h.frame();
      expect(h.scroll.scrollTop).toBe(initialTop - 0.5);
      expect(h.writes).not.toHaveBeenCalled();
      checkVisible();
    },
  );
});

it('exposes the actual sparse mounted keys and wakes existing measurements', () => {
  const h = harness();
  h.surface.update(rows(1200), presentation);
  expect(h.surface.mountedKeys()).toEqual([...h.surface.cards()].map(([key]) => key));
  const first = expectDefined(h.surface.mountedKeys()[0]);
  h.heights.set(first, 300);
  h.surface.refreshMeasurements();
  expect(h.frames.size).toBeGreaterThan(0);
  h.surface.destroy();
});

it('indexes compact numeric payloads without snapshot fields', () => {
  const compact = indexedRows([{ kind: 'task', key: 'occurrence', taskKey: 'physical', task: 42 }]);
  expect(compact.task('occurrence')).toBe(42);
  expect(compact.physicalKey('occurrence')).toBe('physical');
  expect(compact.firstOccurrenceOf('physical')).toBe('occurrence');
});

describe('synchronous reveal convergence', () => {
  it.each([35.5, 18])('keeps the final short row visible after measurement: %s', (actual) => {
    const h = harness(true);
    h.size(600, 935);
    h.style('paddingTop', '8px');
    h.style('paddingBottom', '8px');
    for (let n = 0; n < 1201; n++) h.heights.set(`n.md:${n}`, actual);
    h.surface.update(rows(1201), { ...presentation, estimate: () => 64 });
    const target = expectDefined(h.surface.reveal('n.md:1200'));
    const visible = () => {
      const rect = target.getBoundingClientRect();
      expect(rect.top).toBeGreaterThanOrEqual(0);
      expect(rect.bottom).toBeLessThanOrEqual(935);
      expect(target.isConnected).toBe(true);
      expect(h.reportFailure).not.toHaveBeenCalled();
      expect([...h.surface.cards()].length).toBeLessThan(120);
    };
    visible();
    const settledTop = h.scroll.scrollTop;
    for (let i = 0; i < 8; i++) {
      h.resize();
      h.frame();
      visible();
    }
    expect(h.scroll.scrollTop).toBe(settledTop);
    h.scrollTo(settledTop - 80.5);
    h.writes.mockClear();
    h.frame();
    expect(h.scroll.scrollTop).toBe(settledTop - 80.5);
    expect(h.writes).not.toHaveBeenCalled();
  });
  it.each([600, 1200])(
    'settles variable grouped rows at %s while retaining the focused input',
    (line) => {
      const h = harness(true);
      h.size(390, 684);
      h.style('paddingTop', '8px');
      h.style('paddingBottom', '8px');
      const list = rows(1201);
      const grouped = indexedRows(
        [...list.slice(0, list.rowCount)].flatMap((row, index): TaskListRow[] =>
          index % 100 === 0
            ? [
                {
                  kind: 'group',
                  key: `group:${index}`,
                  label: 'Group',
                  count: 100,
                  first: index === 0,
                },
                row,
              ]
            : [row],
        ),
      );
      for (let n = 0; n < 1201; n++) h.heights.set(`n.md:${n}`, n % 3 === 0 ? 90 : 18);
      h.surface.update(grouped, { ...presentation, estimate: () => 64 });
      const first = expectDefined(h.surface.element('n.md:0'));
      const input = first.createEl('input');
      input.value = 'capture draft';
      input.focus();
      input.setSelectionRange(4, 4);
      const target = expectDefined(h.surface.reveal(`n.md:${line}`));
      for (let i = 0; i < 8; i++) {
        expect(target.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
        expect(target.getBoundingClientRect().bottom).toBeLessThanOrEqual(684);
        expect(input.isConnected).toBe(true);
        expect(document.activeElement).toBe(input);
        expect(input.selectionStart).toBe(4);
        expect([...h.surface.cards()].length).toBeLessThan(120);
        h.resize();
        h.frame();
      }
      expect(h.reportFailure).not.toHaveBeenCalled();
    },
  );
  it.each([
    'removed',
    'revision',
    'destroyed',
    'owner',
    'detached',
    'suspended',
    'hidden',
    'reentrant reveal',
  ] as const)('cancels old reveal authority when %s during measurement', (change) => {
    const h = harness(true);
    const list = rows(1201);
    h.surface.update(list, presentation);
    const owner = change === 'owner' ? taskViewportOwner() : undefined;
    let latestTop = 0;
    h.onMeasure((key) => {
      if (key !== 'n.md:1200') return;
      h.onMeasure(undefined);
      if (change === 'removed') h.surface.update(rows(2), presentation);
      else if (change === 'revision') h.surface.update(list, { ...presentation, revision: 'new' });
      else if (change === 'destroyed') h.surface.destroy();
      else if (change === 'detached') h.scroll.remove();
      else if (change === 'suspended') h.surface.suspend();
      else if (change === 'hidden') h.size(0, 0);
      else if (owner !== undefined) owner.doc.body.append(h.scroll);
      else h.surface.reveal('n.md:0');
      latestTop = h.scroll.scrollTop;
      h.writes.mockClear();
    });
    expect(h.surface.reveal('n.md:1200')).toBeUndefined();
    expect(h.scroll.scrollTop).toBe(latestTop);
    expect(h.writes).not.toHaveBeenCalled();
    expect(h.reportFailure).not.toHaveBeenCalled();
    h.surface.destroy();
    owner?.destroy();
  });
  it('reports finite nonconvergence without returning a false success or leaking scroll correction', () => {
    const h = harness(true);
    for (let n = 0; n < 1201; n++) h.heights.set(`n.md:${n}`, 1);
    h.surface.update(rows(1201), { ...presentation, estimate: () => 64 });
    h.writes.mockClear();
    let targetReads = 0;
    h.onMeasure((key) => {
      if (key === 'n.md:1200') targetReads++;
    });
    expect(h.surface.reveal('n.md:1200')).toBeUndefined();
    expect(h.reportFailure).toHaveBeenCalledTimes(1);
    expect(targetReads).toBe(16);
    expect([...h.surface.cards()].length).toBeLessThan(500);
    expect(h.writes).not.toHaveBeenCalled();
    h.resize();
    h.frame();
    expect(h.writes).not.toHaveBeenCalled();
    expect(h.pending()).toBe(0);
  });
  it.each([40, -40])('corrects actual row placement by %s pixels before returning', (offset) => {
    const h = harness(true);
    h.surface.update(rows(1201), presentation);
    if (offset < 0) h.scrollTo(40000);
    const original = expectDefined(h.mount.getMockImplementation());
    h.mount.mockImplementation((host, row) => {
      const mounted = original(host, row);
      const read = mounted.element.getBoundingClientRect.bind(mounted.element);
      mounted.element.getBoundingClientRect = () => {
        const rect = read();
        return { ...rect, top: rect.top + offset, bottom: rect.bottom + offset };
      };
      return mounted;
    });
    h.writes.mockClear();
    const target = expectDefined(h.surface.reveal('n.md:600'));
    expect(target.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
    expect(target.getBoundingClientRect().bottom).toBeLessThanOrEqual(480);
    expect(h.writes).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 8; i++) {
      h.resize();
      h.frame();
    }
    expect(target.isConnected).toBe(true);
    expect(target.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
    expect(target.getBoundingClientRect().bottom).toBeLessThanOrEqual(480);
    expect(h.reportFailure).not.toHaveBeenCalled();
  });
  it('reports a native setter that cannot place the target rather than returning an offscreen row', () => {
    const h = harness();
    h.surface.update(rows(1201), presentation);
    Object.defineProperty(h.scroll, 'scrollTop', {
      get: () => 0,
      set: () => undefined,
      configurable: true,
    });
    expect(h.surface.reveal('n.md:1200')).toBeUndefined();
    expect(h.reportFailure).toHaveBeenCalledTimes(1);
    h.resize();
    h.frame();
    expect(h.pending()).toBe(0);
  });
  it('rejects changing geometry within the pass cap without scheduling a correction loop', () => {
    const h = harness(true);
    h.surface.update(rows(1201), presentation);
    let reads = 0;
    h.onMeasure((key) => {
      if (key === 'n.md:1200') h.heights.set(key, ++reads % 2 === 0 ? 49 : 80);
    });
    h.writes.mockClear();
    expect(h.surface.reveal('n.md:1200')).toBeUndefined();
    expect(reads).toBe(16);
    expect(h.reportFailure).toHaveBeenCalledTimes(1);
    expect(h.writes).not.toHaveBeenCalled();
    h.resize();
    h.frame();
    expect(h.pending()).toBe(0);
  });
  it('aligns the header of an initially offscreen tall target and retains an existing intersection', () => {
    const h = harness(true);
    h.style('paddingTop', '8px');
    h.style('paddingBottom', '8px');
    Object.defineProperty(h.scroll, 'clientTop', { value: 3 });
    h.origin(3);
    h.heights.set('n.md:999', 900);
    h.surface.update(rows(1000), { ...presentation, estimate: () => 64 });
    const target = expectDefined(h.surface.reveal('n.md:999'));
    expect(target.getBoundingClientRect().top).toBe(3);
    h.scrollTo(h.scroll.scrollTop + 100.5);
    h.frame();
    const top = h.scroll.scrollTop;
    h.writes.mockClear();
    expect(h.surface.reveal('n.md:999')).toBe(target);
    expect(h.scroll.scrollTop).toBe(top);
    expect(h.writes).not.toHaveBeenCalled();
  });
});

it('yields pending destination holders without replacing settled heights, then converges after hydration', () => {
  const h = harness(true);
  const ready = new Set<string>();
  const mounted = new Set<string>();
  const original = expectDefined(h.mount.getMockImplementation());
  h.mount.mockImplementation((host, row) => {
    mounted.add(row.key);
    h.heights.set(row.key, ready.has(row.key) ? 57 + (Number(row.key.split(':')[1]) % 3) * 90 : 12);
    const mount = original(host, row);
    return {
      ...mount,
      measurementReady: () => ready.has(row.key),
      destroy: () => {
        mounted.delete(row.key);
        mount.destroy();
      },
    };
  });
  const settle = (): void => {
    for (const key of mounted) {
      ready.add(key);
      h.heights.set(key, 57 + (Number(key.split(':')[1]) % 3) * 90);
    }
  };
  h.surface.update(rows(1201), { ...presentation, estimate: () => 64 });
  settle();
  const release = h.surface.pin('n.md:1200');
  settle();
  expect(h.surface.reveal('n.md:1200', { waitForReady: true })).toBe('pending');
  expect(h.reportFailure).not.toHaveBeenCalled();
  let result: ReturnType<TaskListSurface['reveal']>;
  for (let round = 0; round < 8; round++) {
    settle();
    result = h.surface.reveal('n.md:1200', { waitForReady: true });
    if (result !== 'pending') break;
  }
  expect(result).not.toBe('pending');
  const card = expectDefined(typeof result === 'string' ? undefined : result);
  expect(card.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
  expect(card.getBoundingClientRect().bottom).toBeLessThanOrEqual(480);
  expect(mounted.size).toBeLessThan(100);
  expect(h.reportFailure).not.toHaveBeenCalled();
  release();
  h.surface.destroy();
});

it.each(['removed', 'destroyed'] as const)(
  'retires a pending destination when its surface is %s before hydration',
  (change) => {
    const h = harness(true);
    const original = expectDefined(h.mount.getMockImplementation());
    let ready = false;
    h.mount.mockImplementation((host, row) => ({
      ...original(host, row),
      measurementReady: () => ready,
    }));
    h.surface.update(rows(1201), presentation);
    const release = h.surface.pin('n.md:1200');
    expect(h.surface.reveal('n.md:1200', { waitForReady: true })).toBe('pending');
    if (change === 'removed') h.surface.update(rows(2), presentation);
    else h.surface.destroy();
    release();
    ready = true;
    h.frame();
    h.writes.mockClear();
    expect(h.surface.reveal('n.md:1200', { waitForReady: true })).toBeUndefined();
    expect(h.writes).not.toHaveBeenCalled();
    expect(h.reportFailure).not.toHaveBeenCalled();
    h.surface.destroy();
    expect(h.pending()).toBe(0);
  },
);

describe('pinned native-write ownership', () => {
  it('acknowledges actual clamped and coalesced writes, including no-op validation', () => {
    const h = harness(true);
    h.surface.update(rows(100), presentation);
    let expected = h.scroll.scrollTop;
    const beforeWrite = vi.fn((top: number) => top === expected);
    const afterWrite = vi.fn((top: number) => {
      expected = top;
    });
    h.surface.pin('n.md:99', undefined, { beforeWrite, afterWrite });
    expect(h.surface.reveal('n.md:99')).toBeDefined();
    expect(expected).toBe(h.scroll.scrollTop);
    expect(afterWrite).toHaveBeenCalled();
    h.surface.reveal('n.md:98');
    expect(expected).toBe(h.scroll.scrollTop);
    beforeWrite.mockClear();
    h.surface.reveal('n.md:99');
    expect(beforeWrite).toHaveBeenCalled();
    expect(expected).toBe(h.scroll.scrollTop);
  });

  it('vetoes a pending native user move before an owned measurement write', () => {
    const h = harness();
    h.surface.update(rows(100), presentation);
    h.surface.reveal('n.md:80');
    const expected = h.scroll.scrollTop;
    const afterWrite = vi.fn();
    h.surface.pin('n.md:80', undefined, { beforeWrite: (top) => top === expected, afterWrite });
    h.scroll.scrollTop = expected - 17;
    h.heights.set('n.md:69', 96);
    h.surface.refreshMeasurements();
    h.writes.mockClear();
    h.frame();
    expect(h.scroll.scrollTop).toBe(expected - 17);
    expect(h.writes).not.toHaveBeenCalled();
    expect(afterWrite).not.toHaveBeenCalled();
  });

  it.each(['release', 'destroy'] as const)(
    'retires captured acknowledgements on reentrant %s',
    (operation) => {
      const h = harness();
      h.surface.update(rows(100), presentation);
      const afterWrite = vi.fn();
      let release = () => {};
      release = h.surface.pin('n.md:80', undefined, {
        beforeWrite: () => {
          if (operation === 'release') release();
          else h.surface.destroy();
          return true;
        },
        afterWrite,
      });
      h.surface.reveal('n.md:80');
      expect(afterWrite).not.toHaveBeenCalled();
      expect(h.reportFailure).not.toHaveBeenCalled();
    },
  );
});

it.each(['clamp', 'non-clamp'] as const)('validates owned DOM extent changes: %s', (scenario) => {
  const h = harness(true, false, true);
  const initial = rows(100);
  h.surface.update(initial, presentation);
  h.surface.reveal('n.md:99');
  let expected = h.scroll.scrollTop;
  const beforeWrite = vi.fn((top: number) => top === expected);
  const afterWrite = vi.fn((top: number) => {
    expected = top;
  });
  h.surface.pin('n.md:99', undefined, { beforeWrite, afterWrite });
  for (const result of h.mount.mock.results) {
    const mount = result.value as ReturnType<typeof h.mount>;
    vi.spyOn(mount, 'update').mockImplementation((row) => {
      if (scenario === 'clamp') h.heights.set(row.key, 24);
      else h.scroll.scrollTop -= 7;
    });
  }
  const before = expected;
  h.surface.update(initial, { ...presentation, revision: 'layout:2', estimate: () => 24 });
  if (scenario === 'clamp') {
    expect(afterWrite).toHaveBeenCalled();
    expect(afterWrite.mock.calls.some(([top]) => top < before)).toBe(true);
    expect(expected).toBe(h.scroll.scrollTop);
    expect(beforeWrite.mock.results.every((result) => result.value === true)).toBe(true);
  } else {
    expect(afterWrite).not.toHaveBeenCalled();
    expect(beforeWrite.mock.results.some((result) => result.value === false)).toBe(true);
  }
  expect(h.reportFailure).not.toHaveBeenCalled();
});

it('rechecks captured pin membership after an acknowledgement callback releases another owner', () => {
  const h = harness();
  h.surface.update(rows(100), presentation);
  let releaseSecond = () => {};
  h.surface.pin('n.md:80', undefined, {
    beforeWrite: () => true,
    afterWrite: () => {
      releaseSecond();
    },
  });
  const afterWrite = vi.fn();
  releaseSecond = h.surface.pin('n.md:80', undefined, { beforeWrite: () => true, afterWrite });
  h.surface.reveal('n.md:80');
  expect(afterWrite).not.toHaveBeenCalled();
  expect(h.reportFailure).not.toHaveBeenCalled();
});

it('rejects the old reconciliation after a before-write callback replaces rows', () => {
  const h = harness();
  h.surface.update(rows(100), presentation);
  let release = () => {};
  const afterWrite = vi.fn();
  release = h.surface.pin('n.md:80', undefined, {
    beforeWrite: () => {
      release();
      h.surface.update(rows(20), presentation);
      return true;
    },
    afterWrite,
  });
  expect(h.surface.reveal('n.md:80')).toBeUndefined();
  expect(afterWrite).not.toHaveBeenCalled();
  expect(h.reportFailure).not.toHaveBeenCalled();
});

it('acknowledges the actual native clamp of a pending reveal setter', () => {
  const h = harness(true);
  const mount = expectDefined(h.mount.getMockImplementation());
  h.mount.mockImplementation((host, row) => {
    h.heights.set(row.key, 12);
    return { ...mount(host, row), measurementReady: () => false };
  });
  h.surface.update(rows(100), presentation);
  let expected = h.scroll.scrollTop;
  const afterWrite = vi.fn((top: number) => {
    expected = top;
  });
  h.surface.pin('n.md:99', undefined, {
    beforeWrite: (top) => top === expected,
    afterWrite,
  });
  h.writes.mockClear();
  expect(h.surface.reveal('n.md:99', { waitForReady: true })).toBe('pending');
  const requested = expectDefined(h.writes.mock.calls[h.writes.mock.calls.length - 1]?.[0]);
  expect(h.scroll.scrollTop).toBeLessThan(requested);
  expect(expected).toBe(h.scroll.scrollTop);
  expect(afterWrite).toHaveBeenLastCalledWith(h.scroll.scrollTop);
});

it('vetoes pending user movement even when a reveal would need no native setter', () => {
  const h = harness();
  h.surface.update(rows(100), presentation);
  h.surface.reveal('n.md:80');
  const expected = h.scroll.scrollTop;
  const afterWrite = vi.fn();
  h.surface.pin('n.md:80', undefined, { beforeWrite: (top) => top === expected, afterWrite });
  h.scroll.scrollTop = expected + 1;
  h.writes.mockClear();
  expect(h.surface.reveal('n.md:80')).toBeUndefined();
  expect(h.writes).not.toHaveBeenCalled();
  expect(afterWrite).not.toHaveBeenCalled();
  expect(h.scroll.scrollTop).toBe(expected + 1);
});

it('preserves ordinary reconciliation without a native-write observer', () => {
  const h = harness();
  h.surface.update(rows(100), presentation);
  const mount = expectDefined(h.mount.getMockImplementation());
  h.mount.mockImplementation((host, row) => {
    h.scroll.scrollTop += 1;
    return mount(host, row);
  });
  expect(h.surface.reveal('n.md:80')).toBeDefined();
  expect(h.reportFailure).not.toHaveBeenCalled();
});

it('prevents intermediate extent clamping before later row callbacks restore some native extent', () => {
  const h = harness(true, false, true);
  const initial = rows(100);
  h.surface.update(initial, presentation);
  h.surface.reveal('n.md:99');
  let expected = h.scroll.scrollTop;
  const before = expected;
  const afterWrite = vi.fn((top: number) => {
    expected = top;
  });
  h.surface.pin('n.md:99', undefined, {
    beforeWrite: (top) => top === expected,
    afterWrite,
  });
  let during: number | undefined;
  for (const result of h.mount.mock.results) {
    const mount = result.value as ReturnType<typeof h.mount>;
    vi.spyOn(mount, 'update').mockImplementation((row) => {
      if (during !== undefined) return;
      // The earlier spacer shrink has forced native layout before this row grows.
      during = h.scroll.scrollTop;
      h.heights.set(row.key, 128);
    });
  }
  h.surface.update(initial, { ...presentation, revision: 'layout:2', estimate: () => 47 });
  expect(during).toBe(before);
  expect(afterWrite).toHaveBeenCalled();
  expect(expected).toBe(h.scroll.scrollTop);
  expect(h.host.querySelector('[data-abyss-scroll-guard]')).toBeNull();
  expect(h.reportFailure).not.toHaveBeenCalled();
});

it.each(['throw', 'destroy', 'replace', 'migrate', 'move'] as const)(
  'cleans up the transient extent reservation after a row callback causes %s',
  (operation) => {
    const h = harness();
    const owner = taskViewportOwner();
    h.surface.update(rows(100), presentation);
    let expected = h.scroll.scrollTop;
    const afterWrite = vi.fn((top: number) => {
      expected = top;
    });
    const release = h.surface.pin('n.md:80', undefined, {
      beforeWrite: (top) => top === expected,
      afterWrite,
    });
    const original = expectDefined(h.mount.getMockImplementation());
    let acted = false;
    h.mount.mockImplementation((host, row) => {
      const mount = original(host, row);
      if (!acted) {
        acted = true;
        expect(h.host.querySelector('[data-abyss-scroll-guard]')).not.toBeNull();
        const actions = {
          throw: () => {
            throw new Error('row failure');
          },
          destroy: () => {
            h.surface.destroy();
          },
          replace: () => {
            release();
            h.surface.update(rows(20), presentation);
          },
          migrate: () => {
            owner.doc.body.append(h.scroll);
          },
          move: () => {
            h.scroll.scrollTop += 17;
          },
        };
        actions[operation]();
      }
      return mount;
    });
    try {
      expect(h.surface.reveal('n.md:80')).toBeUndefined();
      expect(acted).toBe(true);
      expect(h.host.querySelector('[data-abyss-scroll-guard]')).toBeNull();
      expect(afterWrite).not.toHaveBeenCalled();
      expect(h.reportFailure).toHaveBeenCalledTimes(operation === 'throw' ? 1 : 0);
    } finally {
      h.surface.destroy();
      owner.destroy();
    }
  },
);

it('acknowledges a fractional final native clamp without reconstructing it from rounded dimensions', () => {
  const h = harness(true, false, true);
  const initial = rows(100);
  h.surface.update(initial, presentation);
  h.surface.reveal('n.md:99');
  let expected = h.scroll.scrollTop;
  const nativeHeight = expectDefined(Object.getOwnPropertyDescriptor(h.scroll, 'scrollHeight'));
  Object.defineProperty(h.scroll, 'scrollHeight', {
    get: () => Math.round(Number(nativeHeight.get?.call(h.scroll))),
  });
  const afterWrite = vi.fn((top: number) => {
    expected = top;
  });
  h.surface.pin('n.md:99', undefined, { beforeWrite: (top) => top === expected, afterWrite });
  for (const result of h.mount.mock.results) {
    const mount = result.value as ReturnType<typeof h.mount>;
    vi.spyOn(mount, 'update').mockImplementation((row) => {
      h.heights.set(row.key, 24.125);
    });
  }
  h.surface.update(initial, { ...presentation, revision: 'layout:2', estimate: () => 24.125 });
  expect(afterWrite).toHaveBeenCalled();
  expect(expected).toBe(h.scroll.scrollTop);
  expect(expected % 1).not.toBe(0);
  expect(h.host.querySelector('[data-abyss-scroll-guard]')).toBeNull();
});

function hugeRows() {
  const source = numericRowSource(0, 9_999_999);
  const payload = task({ title: 'Synthetic series' });
  return {
    ...indexedRows<typeof payload>([]),
    revision: 'huge',
    rowCount: source.length,
    taskCount: source.length,
    rowAt(index: number): TaskListRow | undefined {
      const row = source.rowAt(index);
      return row === undefined
        ? undefined
        : { kind: 'task', key: row.key, taskKey: row.key, task: payload };
    },
    rowIndexOf: source.indexOf.bind(source),
    indexOf: source.indexOf.bind(source),
    estimatedOffset: (index: number) => index * 48,
    anchorRanges: source.anchorRanges.bind(source),
    survivingNeighbor: source.survivingNeighbor.bind(source),
    slice() {
      throw new Error('Indexed surface must not enumerate the full source');
    },
  };
}
const hugePresentation = { ...presentation, indexedHeights: { group: 48, task: 48 } };
function pointer(scroll: HTMLElement, pointerType = 'mouse') {
  const event = new Event('pointerdown');
  Object.assign(event, { pointerType, button: 0, isPrimary: true });
  scroll.dispatchEvent(event);
}
function rowTop(h: ReturnType<typeof harness>, key: string) {
  return expectDefined(h.surface.element(key)).getBoundingClientRect().top;
}
describe('full-domain native task scrolling', () => {
  it('reaches end, top and fractional thumb positions without reveal and bounds native extent', () => {
    const h = harness(true);
    h.surface.update(hugeRows(), hugePresentation);
    expect(h.reportFailure).not.toHaveBeenCalled();
    expect(h.scroll.scrollHeight).toBe(1_000_000);
    pointer(h.scroll);
    h.scrollTo(h.scroll.scrollHeight - h.scroll.clientHeight);
    h.frame();
    expect(h.surface.element('number:9999999')).toBeDefined();
    expect(rowTop(h, 'number:9999999')).toBe(432);
    pointer(h.scroll);
    h.scrollTo(0);
    h.frame();
    expect(rowTop(h, 'number:0')).toBe(0);
    pointer(h.scroll);
    h.scrollTo(499760);
    h.frame();
    expect(rowTop(h, 'number:5000000')).toBe(240);
    expect(h.scroll.scrollHeight).toBe(1_000_000);
    expect(h.surface.mountedKeys().length).toBeLessThan(100);
  });
  it('attributes wheel and touch inertia locally, resets at pointer, scrollend and quiet timeout', () => {
    vi.useFakeTimers();
    try {
      const h = harness(true);
      h.surface.update(hugeRows(), hugePresentation);
      h.scrollTo(499760);
      h.frame();
      h.scroll.dispatchEvent(new Event('wheel'));
      h.scrollTo(h.scroll.scrollTop + 120);
      h.frame();
      expect(rowTop(h, 'number:5000000')).toBeCloseTo(120, 4);
      h.scroll.dispatchEvent(new Event('scroll'));
      h.frame();
      expect(rowTop(h, 'number:5000000')).toBeCloseTo(120, 4);
      pointer(h.scroll);
      h.scrollTo(499760);
      h.frame();
      expect(rowTop(h, 'number:5000000')).toBeCloseTo(240, 4);
      h.scroll.dispatchEvent(new Event('touchstart'));
      h.scrollTo(h.scroll.scrollTop + 60);
      h.frame();
      h.scrollTo(h.scroll.scrollTop + 60);
      h.frame();
      expect(rowTop(h, 'number:5000000')).toBeCloseTo(120, 4);
      h.scroll.dispatchEvent(new Event('scrollend'));
      h.scrollTo(499760);
      h.frame();
      expect(rowTop(h, 'number:5000000')).toBeCloseTo(240, 4);
      h.scroll.dispatchEvent(new Event('wheel'));
      h.scrollTo(h.scroll.scrollTop + 60);
      h.frame();
      vi.advanceTimersByTime(181);
      h.scrollTo(499760);
      h.frame();
      expect(rowTop(h, 'number:5000000')).toBeCloseTo(240, 4);
      h.surface.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
  it('keeps host offset separate and does not swallow newer native input before owned feedback', () => {
    const h = harness(true);
    h.origin(80);
    h.surface.update(hugeRows(), hugePresentation);
    pointer(h.scroll);
    h.scrollTo(499840);
    h.frame();
    h.scroll.dispatchEvent(new Event('wheel'));
    h.scrollTo(h.scroll.scrollTop + 120);
    h.frame();
    expect(rowTop(h, 'number:5000000')).toBeCloseTo(120, 4);
    h.scrollTo(h.scroll.scrollTop + 60);
    h.frame();
    expect(rowTop(h, 'number:5000000')).toBeCloseTo(60, 4);
    pointer(h.scroll);
    h.scrollTo(h.scroll.scrollHeight - 480);
    h.frame();
    expect(rowTop(h, 'number:9999999')).toBeCloseTo(432, 4);
  });
});

it('retires actionable mounts on a failed indexed refresh and retries on explicit update', () => {
  const h = harness();
  const list = hugeRows();
  h.surface.update(list, hugePresentation);
  const first = expectDefined(h.surface.element('number:0'));
  h.surface.update(
    {
      ...list,
      rowAt() {
        throw new Error('source failed');
      },
    },
    hugePresentation,
  );
  expect(h.reportFailure).toHaveBeenCalledTimes(1);
  expect(first.isConnected).toBe(false);
  expect(h.surface.mountedKeys()).toEqual([]);
  h.surface.update(list, hugePresentation);
  expect(h.surface.element('number:0')?.isConnected).toBe(true);
});

it('keeps logical precision when rounding produces no new native pixel and events coalesce', () => {
  const h = harness(true);
  const descriptor = expectDefined(Object.getOwnPropertyDescriptor(h.scroll, 'scrollTop'));
  Object.defineProperty(h.scroll, 'scrollTop', {
    ...descriptor,
    set(value: number) {
      descriptor.set?.call(h.scroll, Math.round(value));
    },
  });
  h.surface.update(hugeRows(), hugePresentation);
  h.scrollTo(499760);
  h.frame();
  h.scroll.dispatchEvent(new Event('wheel'));
  for (let i = 0; i < 4; i++) {
    h.scrollTo(h.scroll.scrollTop + 120);
    h.frame();
  }
  const placed = rowTop(h, 'number:5000005');
  expect(Math.abs(placed)).toBeLessThanOrEqual(0.5);
  h.scroll.dispatchEvent(new Event('scroll'));
  h.frame();
  expect(rowTop(h, 'number:5000005')).toBe(placed);
  expect(h.reportFailure).not.toHaveBeenCalled();
});

it.each(['blur', 'replace', 'page', 'touch-pointer'] as const)(
  'resolves %s input transitions through the native owner',
  (transition) => {
    const h = harness(true);
    const list = hugeRows();
    h.surface.update(list, hugePresentation);
    h.scrollTo(499760);
    h.frame();
    h.scroll.dispatchEvent(new Event('wheel'));
    h.scrollTo(h.scroll.scrollTop + 120);
    h.frame();
    if (transition === 'blur') window.dispatchEvent(new Event('blur'));
    if (transition === 'replace') h.surface.update(list, hugePresentation);
    if (transition === 'page') {
      pointer(h.scroll);
      h.scroll.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown' }));
    }
    if (transition === 'touch-pointer') {
      pointer(h.scroll);
      pointer(h.scroll, 'touch');
    }
    if (transition === 'blur' || transition === 'replace') {
      h.scrollTo(499760);
      h.frame();
      expect(rowTop(h, 'number:5000000')).toBeCloseTo(240, 4);
    } else {
      h.scrollTo(h.scroll.scrollTop + 120);
      h.frame();
      expect(rowTop(h, 'number:5000000')).toBeCloseTo(0, 4);
    }
  },
);

it('cancels captured-owner input timers and frames across adoption and unload', () => {
  vi.useFakeTimers();
  try {
    const h = harness(true);
    h.surface.update(hugeRows(), hugePresentation);
    h.scrollTo(499760);
    h.frame();
    h.scroll.dispatchEvent(new Event('wheel'));
    h.scrollTo(h.scroll.scrollTop + 120);
    const late = expectDefined([...h.frames.values()][0]);
    const owner = taskViewportOwner();
    owner.doc.body.append(h.scroll);
    h.scrollTo(499760);
    owner.flush();
    expect(rowTop(h, 'number:5000000')).toBeCloseTo(240, 4);
    late(0);
    vi.advanceTimersByTime(181);
    expect(rowTop(h, 'number:5000000')).toBeCloseTo(240, 4);
    h.scroll.dispatchEvent(new owner.win.Event('wheel'));
    h.scrollTo(h.scroll.scrollTop + 120);
    const pending = expectDefined([...owner.frames.values()][0]);
    owner.win.dispatchEvent(new owner.win.Event('unload'));
    h.scroll.dispatchEvent(new owner.win.Event('scroll'));
    expect(owner.frames.size).toBe(0);
    const calls = h.mount.mock.calls.length;
    pending(0);
    vi.advanceTimersByTime(181);
    expect(h.mount.mock.calls).toHaveLength(calls);
    h.surface.destroy();
    owner.destroy();
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  [0, 600_000],
  [9_999_999, 600_000],
  [0, 2_000_000],
  [9_999_999, 2_000_000],
])(
  'locally scrolls inside tall visible row %i with height %i at its exact mapped position',
  (index, height) => {
    const h = harness(true);
    const key = `number:${index}`;
    h.heights.set(key, height);
    h.surface.update(hugeRows(), hugePresentation);
    const element = expectDefined(h.surface.reveal(key));
    const input = element.createEl('input');
    input.value = 'retained tall edit';
    input.focus({ preventScroll: true });
    const frame = expectDefined(element.parentElement);
    const logicalTop = index * 48 + height / 2;
    const mapped = new LogicalScrollWindow().place(logicalTop, 480_000_000 + height - 48, 480);
    pointer(h.scroll);
    h.scrollTo(mapped.nativeTop);
    h.frame();
    expect(h.reportFailure).not.toHaveBeenCalled();
    expect(h.scroll.scrollHeight).toBe(1_000_000);
    expect(element.getBoundingClientRect().top).toBeCloseTo(-height / 2, 4);
    expect(element.getBoundingClientRect().height).toBe(height);
    h.scroll.dispatchEvent(new Event('wheel'));
    h.scrollTo(h.scroll.scrollTop + 120);
    h.frame();
    expect(element.getBoundingClientRect().top).toBeCloseTo(-height / 2 - 120, 4);
    expect(h.scroll.scrollHeight).toBe(1_000_000);
    expect(h.surface.element(key)).toBe(element);
    expect(element.parentElement).toBe(frame);
    expect(
      Number.parseFloat(frame.style.getPropertyValue('--abyss-virtual-row-height')),
    ).toBeLessThanOrEqual(1_000_000);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('retained tall edit');
  },
);

it.each([
  [false, 100, 80],
  [true, 100, 80],
  [false, 40, 20],
  [true, 40, 20],
])(
  'measures strict indexed replacement before native clamp with preserveAnchor=%s and height=%i',
  (preserveAnchor, height, expectedTop) => {
    const h = harness(true);
    h.size(600, 20);
    h.heights.set('n.md:0', 100);
    const source = rows(1);
    h.surface.update(source, { ...presentation, estimate: () => 100 });
    h.scrollTo(80);
    h.frame();
    h.heights.set('n.md:0', height);
    h.surface.update(
      {
        ...source,
        estimatedOffset(index) {
          if (index < 0 || index > 1) throw new Error(`Outside promised boundary: ${index}`);
          return index * 40;
        },
      },
      {
        ...presentation,
        revision: 'shrunken',
        preserveAnchor,
        indexedHeights: { group: 40, task: 40 },
      },
    );
    expect(h.reportFailure).not.toHaveBeenCalled();
    expect(h.scroll.scrollTop).toBe(expectedTop);
    expect(h.surface.element('n.md:0')?.getBoundingClientRect().height).toBe(height);
  },
);

it('keeps the same semantic row and frame through finite/compressed mode switches', () => {
  const h = harness(true);
  const huge = hugeRows();
  const finite = indexedRows([expectDefined(huge.rowAt(0))]);
  h.surface.update(finite, presentation);
  const element = expectDefined(h.surface.element('number:0'));
  const frame = expectDefined(element.parentElement);
  element.id = 'stable-row';
  element.setAttribute('role', 'option');
  const input = element.createEl('input');
  input.value = 'same editor';
  input.focus({ preventScroll: true });
  h.surface.pin('number:0');
  h.surface.update(huge, hugePresentation);
  pointer(h.scroll);
  h.scrollTo(999520);
  h.frame();
  expect(frame.hasClass('abyss-virtual-row-frame-clipped')).toBe(true);
  h.surface.update(finite, presentation);
  expect(h.surface.element('number:0')).toBe(element);
  expect(element.parentElement).toBe(frame);
  expect(frame.parentElement).toBe(h.host);
  expect(frame.hasClass('abyss-virtual-row-frame-clipped')).toBe(false);
  expect(frame.style.getPropertyValue('--abyss-virtual-row-height')).toBe('');
  expect(element.style.getPropertyValue('--abyss-virtual-row-offset')).toBe('');
  expect(element.style.getPropertyValue('--abyss-virtual-row-width')).toBe('');
  expect(element.hasClass('abyss-virtual-row-parked')).toBe(false);
  expect(element.id).toBe('stable-row');
  expect(element.getAttribute('role')).toBe('option');
  for (const attribute of ['role', 'tabindex', 'inert', 'aria-hidden'])
    expect(frame.hasAttribute(attribute)).toBe(false);
  expect(input.value).toBe('same editor');
  expect(document.activeElement).toBe(input);
  h.surface.destroy();
  expect(frame.isConnected).toBe(false);
});

it('parks oversized retained editors without shifting visible geometry, then restores the same input', async () => {
  const selector =
    '.abyss-task-list-surface > .abyss-virtual-row-frame > .abyss-virtual-row-parked';
  const declarations = cssDeclarationsFor(await loadPluginStyles(), selector);
  expect(declarations).toContain('opacity: 0');
  expect(declarations).toContain('pointer-events: none');
  const h = harness(true);
  h.style('paddingLeft', '13px');
  h.style('paddingRight', '27px');
  h.surface.update(hugeRows(), hugePresentation);
  const first = expectDefined(h.surface.element('number:0'));
  h.style('marginLeft', '7px', first);
  h.style('marginRight', '11px', first);
  const input = first.createEl('input');
  input.value = 'unfinished edit';
  input.focus({ preventScroll: true });
  h.heights.set('number:0', 300_000);
  h.heights.set('number:1', 300_000);
  h.surface.pin('number:0');
  h.surface.pin('number:1');
  h.frame();
  pointer(h.scroll);
  h.scrollTo(999520);
  h.frame();
  expect(h.reportFailure).not.toHaveBeenCalled();
  expect(h.scroll.scrollHeight).toBe(1_000_000);
  expect(rowTop(h, 'number:9999999')).toBeCloseTo(432, 4);
  expect(h.surface.element('number:0')).toBe(first);
  expect(first.isConnected).toBe(true);
  expect(first.hasClass('abyss-virtual-row-parked')).toBe(true);
  expect(first.matches(selector)).toBe(true);
  expect(first.style.getPropertyValue('--abyss-virtual-row-width')).toBe('542px');
  expect(first.getBoundingClientRect().height).toBe(300_000);
  expect(document.activeElement).toBe(input);
  h.onMeasure((key) => {
    if (
      key === 'number:0' &&
      Number.parseFloat(first.style.getPropertyValue('--abyss-virtual-row-width')) < 450
    )
      h.heights.set(key, 600_000);
  });
  h.size(500, 480);
  h.resize();
  h.frame();
  expect(first.style.getPropertyValue('--abyss-virtual-row-width')).toBe('442px');
  expect(first.getBoundingClientRect().height).toBe(600_000);
  expect(rowTop(h, 'number:9999999')).toBeCloseTo(432, 4);
  expect(h.scroll.scrollHeight).toBe(1_000_000);
  expect(h.surface.reveal('number:0')).toBe(first);
  expect(first.hasClass('abyss-virtual-row-parked')).toBe(false);
  expect(first.matches(selector)).toBe(false);
  expect(first.style.getPropertyValue('--abyss-virtual-row-width')).toBe('');
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe('unfinished edit');
  h.surface.destroy();
  expect(first.isConnected).toBe(false);
});

it('honors pinned native-write rejection before parking or replacing visible rows', () => {
  const h = harness(true);
  h.surface.update(hugeRows(), hugePresentation);
  const first = expectDefined(h.surface.element('number:0'));
  const frame = expectDefined(first.parentElement);
  const frameHeight = frame.style.getPropertyValue('--abyss-virtual-row-height');
  const offset = first.style.getPropertyValue('--abyss-virtual-row-offset');
  const observed: number[] = [];
  h.surface.pin('number:0', undefined, {
    beforeWrite(top) {
      observed.push(top);
      return false;
    },
    afterWrite() {
      throw new Error('rejected');
    },
  });
  pointer(h.scroll);
  h.scrollTo(999520);
  h.frame();
  expect(observed).toEqual([999520]);
  expect(first.hasClass('abyss-virtual-row-parked')).toBe(false);
  expect(first.parentElement).toBe(frame);
  expect(frame.style.getPropertyValue('--abyss-virtual-row-height')).toBe(frameHeight);
  expect(first.style.getPropertyValue('--abyss-virtual-row-offset')).toBe(offset);
  expect(h.surface.element('number:9999999')).toBeUndefined();
  expect(h.reportFailure).not.toHaveBeenCalled();
});

it('reveals a parked retained control when keyboard focus enters it', () => {
  const h = harness(true);
  h.surface.update(hugeRows(), hugePresentation);
  const first = expectDefined(h.surface.element('number:0'));
  const input = first.createEl('input');
  h.surface.pin('number:0');
  pointer(h.scroll);
  h.scrollTo(999520);
  h.frame();
  expect(first.hasClass('abyss-virtual-row-parked')).toBe(true);
  input.focus({ preventScroll: true });
  h.frame();
  expect(first.hasClass('abyss-virtual-row-parked')).toBe(false);
  expect(rowTop(h, 'number:0')).toBe(0);
  expect(document.activeElement).toBe(input);
});

it('can explicitly replace a failed source whose offset callback also fails', () => {
  const h = harness();
  h.surface.update(hugeRows(), hugePresentation);
  h.surface.update(
    {
      ...hugeRows(),
      estimatedOffset() {
        throw new Error('offset failed');
      },
    },
    hugePresentation,
  );
  expect(h.reportFailure).toHaveBeenCalledTimes(1);
  h.scrollTo(100);
  h.scrollTo(200);
  expect(h.reportFailure).toHaveBeenCalledTimes(1);
  h.surface.update(hugeRows(), hugePresentation);
  expect(h.surface.element('number:0')?.isConnected).toBe(true);
  expect(h.reportFailure).toHaveBeenCalledTimes(1);
});

it('retires an older owned receipt once local native input moves away and back before a frame', () => {
  const h = harness(true);
  h.surface.update(hugeRows(), hugePresentation);
  h.scrollTo(499760);
  h.frame();
  h.scroll.dispatchEvent(new Event('wheel'));
  h.scrollTo(499880);
  h.scrollTo(499760);
  h.frame();
  expect(rowTop(h, 'number:5000000')).toBeCloseTo(240, 4);
});

it('does not retire a replacement installed by a failed-pass pin cancellation', () => {
  const h = harness();
  const list = hugeRows();
  h.surface.update(list, hugePresentation);
  h.surface.pin('number:0', () => {
    h.surface.update(list, hugePresentation);
  });
  h.surface.update(
    {
      ...list,
      rowAt() {
        throw new Error('old source failed');
      },
    },
    hugePresentation,
  );
  expect(h.reportFailure).toHaveBeenCalledTimes(1);
  expect(h.surface.element('number:0')?.isConnected).toBe(true);
  h.resize();
  h.frame();
  expect(h.surface.element('number:0')?.isConnected).toBe(true);
});

it.each(['PageUp', 'PageDown'])(
  'keeps %s from a focused button local while Space remains activation',
  (key) => {
    const h = harness(true);
    h.surface.update(hugeRows(), hugePresentation);
    h.scrollTo(499760);
    h.frame();
    const button = expectDefined(h.surface.element('number:5000000')).createEl('button');
    button.focus({ preventScroll: true });
    button.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    h.scrollTo(h.scroll.scrollTop + 120);
    h.frame();
    expect(rowTop(h, 'number:5000000')).toBeCloseTo(120, 4);
    pointer(h.scroll);
    h.scrollTo(499760);
    h.frame();
    button.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    h.scrollTo(999520);
    h.frame();
    expect(rowTop(h, 'number:9999999')).toBe(432);
  },
);

it('keeps reveal and pin acquisitions closed while an indexed source is failed', () => {
  const h = harness();
  const list = hugeRows();
  h.surface.update(list, hugePresentation);
  h.surface.update(
    {
      ...list,
      rowAt() {
        throw new Error('failed rows');
      },
    },
    hugePresentation,
  );
  expect(() => h.surface.reveal('number:0')).not.toThrow();
  expect(h.surface.reveal('number:0')).toBeUndefined();
  const cancelled = vi.fn();
  expect(() => h.surface.pin('number:0', cancelled)).not.toThrow();
  h.surface.update(list, hugePresentation);
  h.surface.destroy();
  expect(cancelled).not.toHaveBeenCalled();
});

it.each(['reveal', 'pin'] as const)(
  'contains an indexed source failure first encountered by %s',
  (operation) => {
    const h = harness();
    const list = hugeRows();
    h.surface.update(
      {
        ...list,
        rowAt(index) {
          if (index > 100) throw new Error('far source failed');
          return list.rowAt(index);
        },
      },
      hugePresentation,
    );
    expect(h.reportFailure).not.toHaveBeenCalled();
    expect(() => h.surface[operation]('number:9999999')).not.toThrow();
    expect(h.reportFailure).toHaveBeenCalledTimes(1);
    expect(h.surface.mountedKeys()).toEqual([]);
  },
);
