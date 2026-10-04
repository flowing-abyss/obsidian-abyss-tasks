import { MarkdownRenderer, type App } from 'obsidian';
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { AppState } from '../src/app/AppState';
import { CenterPanel } from '../src/panels/CenterPanel';
import type { TaskCardMount } from '../src/panels/center/TaskCardRenderer';
import { TaskSearch } from '../src/panels/center/TaskSearch';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { StatusRegistry } from '../src/status/StatusRegistry';
import type { TaskSnapshot } from '../src/tasks';
import { PanelNavigator } from '../src/views/panelNavigation';
import { expectDefined, fixedToday, freshContainer, task, taskQueryApi } from './helpers';
import { prepareTaskPanelViewport } from './support/taskPanelViewport';
import { taskViewportOwner } from './support/taskViewportOwner';

fixedToday('2026-06-25');
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const release of cleanup.splice(0)) release();
});

function frames() {
  const queued = new Map<number, FrameRequestCallback>();
  let next = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    queued.set(++next, callback);
    return next;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => queued.delete(id));
  return {
    queued,
    flush() {
      const current = [...queued.values()];
      queued.clear();
      for (const callback of current) callback(0);
      return current.length;
    },
  };
}

function fixtures(count: number) {
  return Array.from({ length: count }, (_, line) =>
    task({ title: `needle ${line}`, source: { filePath: 'search.md', line } }),
  );
}

function harness(initial = fixtures(1200)) {
  const clock = frames();
  const state = new AppState();
  state.set('mode', 'search');
  state.set('searchQuery', 'needle');
  let snapshots = initial;
  const list = vi.fn(() => snapshots);
  const root = freshContainer();
  prepareTaskPanelViewport(root);
  root.tabIndex = 0;
  // The real CenterPanel supplies mounting; Search still owns the ordered array and query.
  const panelState = new AppState();
  panelState.set('mode', 'search');
  const panel = new CenterPanel({
    state: panelState,
    app: {} as App,
    settings: DEFAULT_SETTINGS,
    queries: taskQueryApi(),
    statusRegistry: new StatusRegistry(DEFAULT_SETTINGS.taskStatuses),
  });
  const panelRoot = freshContainer();
  prepareTaskPanelViewport(panelRoot);
  panel.mount(panelRoot);
  const navigation = new PanelNavigator(state, DEFAULT_SETTINGS, {
    calendarView: () => 'month',
    setCalendarView: () => undefined,
    openQuickCapture: () => undefined,
  });
  const openList = vi.spyOn(navigation, 'openList').mockImplementation(() => undefined);
  const revealTask = vi.fn();
  const completeResults = vi.fn();
  const supplied: TaskSnapshot[][] = [];
  const bindings: Array<(card: HTMLElement, task: TaskSnapshot) => void | (() => void)> = [];
  const failResults = vi.fn();
  const mountLayer = panel as unknown as {
    renderFlat_abyssPrivate(
      host: HTMLElement,
      tasks: TaskSnapshot[],
      groups: undefined,
      options: {
        onCard: (card: HTMLElement, task: TaskSnapshot) => void | (() => void);
        failure?: 'report' | 'throw';
      },
    ): void;
  };
  const search = new TaskSearch({
    state,
    queries: { list },
    navigation,
    host: {
      beginResults: () => undefined,
      completeResults,
      failResults,
      revealTask,
      renderRows: (host, tasks, onCard) => {
        supplied.push(tasks);
        bindings.push(onCard);
        mountLayer.renderFlat_abyssPrivate(host, tasks, undefined, { onCard, failure: 'throw' });
      },
    },
  });
  search.render(root);
  const results = expectDefined(root.querySelector<HTMLElement>('.abyss-center-scroll'));
  const input = expectDefined(root.querySelector<HTMLInputElement>('.abyss-search-global'));
  cleanup.push(() => {
    search.clear();
    panel.destroy();
    root.remove();
    panelRoot.remove();
  });
  return {
    clock,
    state,
    panel,
    search,
    root,
    results,
    input,
    list,
    supplied,
    openList,
    revealTask,
    completeResults,
    failResults,
    bindings,
    mountLayer,
    replace(tasks: TaskSnapshot[]) {
      snapshots = tasks;
      search.refresh();
      clock.flush();
    },
  };
}

function centerHarness(snapshots: TaskSnapshot[]) {
  const clock = frames();
  const state = new AppState();
  state.set('mode', 'search');
  state.set('searchQuery', 'needle');
  const root = freshContainer();
  prepareTaskPanelViewport(root);
  const complete = vi.fn();
  const panel = new CenterPanel({
    state,
    app: {} as App,
    settings: DEFAULT_SETTINGS,
    queries: taskQueryApi({ list: () => snapshots }),
    statusRegistry: new StatusRegistry(DEFAULT_SETTINGS.taskStatuses),
    onRenderComplete: complete,
  });
  cleanup.push(() => {
    panel.destroy();
    root.remove();
  });
  return { clock, state, root, complete, panel };
}

describe('Search supplied result viewport', () => {
  it('keeps complete supplied order with bounded mounts and no query or completion on scrolling', () => {
    const h = harness();
    expect(h.supplied[0]).toHaveLength(1200);
    expect(h.supplied[0]?.map((row) => row.source.line)).toEqual(
      Array.from({ length: 1200 }, (_, line) => line),
    );
    expect(h.results.querySelectorAll('.abyss-task-card').length).toBeLessThanOrEqual(100);
    const queries = h.list.mock.calls.length;
    const completions = h.completeResults.mock.calls.length;
    h.input.focus();
    h.input.setSelectionRange(1, 4);
    h.results.scrollTop = 20000;
    h.results.dispatchEvent(new Event('scroll'));
    expect(h.clock.flush()).toBeGreaterThan(0);
    expect(h.list.mock.calls).toHaveLength(queries);
    expect(h.completeResults.mock.calls).toHaveLength(completions);
    expect(h.input.isConnected).toBe(true);
    expect(h.input.value).toBe('needle');
    expect(h.input.selectionStart).toBe(1);
    expect(h.input.selectionEnd).toBe(4);
    expect(document.activeElement).toBe(h.input);
    expect(h.results.querySelectorAll('.abyss-task-card').length).toBeLessThanOrEqual(100);
    const card = expectDefined(h.results.querySelector<HTMLElement>('.abyss-task-card'));
    const line = Number(card.dataset['line']);
    card.click();
    expect(h.openList).toHaveBeenCalledExactlyOnceWith('inbox');
    expect(h.state.get('taskStack')).toEqual([h.supplied[0]?.[line]]);
    expect(h.revealTask).toHaveBeenCalledExactlyOnceWith(h.supplied[0]?.[line]);
    const composing = new KeyboardEvent('keydown', {
      key: 'Escape',
      isComposing: true,
      bubbles: true,
    });
    h.input.dispatchEvent(composing);
    expect(document.activeElement).toBe(h.input);
    h.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.activeElement).toBe(h.root);
  });

  it.each([12345.625, -0.625])(
    'preserves native scroll %s on an executed viewport frame',
    (top) => {
      const h = harness();
      h.clock.flush();
      let nativeTop = top;
      const write = vi.fn((value: number) => {
        nativeTop = value;
      });
      Object.defineProperty(h.results, 'scrollTop', { get: () => nativeTop, set: write });
      h.results.dispatchEvent(new Event('scroll'));
      expect(h.clock.flush()).toBeGreaterThan(0);
      expect(write).not.toHaveBeenCalled();
      expect(h.results.scrollTop).toBe(top);
    },
  );

  it('preserves retained result identity and rebinds one current navigation listener per update', () => {
    const h = harness(fixtures(1));
    const card = expectDefined(h.results.querySelector<HTMLElement>('.abyss-task-card'));
    const add = vi.spyOn(card, 'addEventListener');
    const remove = vi.spyOn(card, 'removeEventListener');
    let updated = expectDefined(h.supplied[0]?.[0]);
    for (let revision = 1; revision <= 4; revision++) {
      updated = task({
        title: `needle revision ${revision}`,
        planning: { due: '2026-07-01' },
        source: { filePath: 'search.md', line: 0 },
      });
      h.replace([updated]);
      expect(h.results.querySelector('.abyss-task-card')).toBe(card);
    }
    card.click();
    expect(h.openList).toHaveBeenCalledExactlyOnceWith('upcoming');
    expect(h.state.get('taskStack')[0]).toBe(updated);
    expect(h.revealTask).toHaveBeenCalledExactlyOnceWith(updated);
    const captures = (calls: typeof add.mock.calls) =>
      calls.filter(
        ([event, , options]) =>
          event === 'click' &&
          (options === true || (typeof options === 'object' && options.capture === true)),
      );
    expect(captures(add.mock.calls)).toHaveLength(4);
    expect(captures(remove.mock.calls)).toHaveLength(4);
    h.replace([]);
    expect(captures(remove.mock.calls)).toHaveLength(5);
    card.click();
    expect(h.openList).toHaveBeenCalledTimes(1);
    h.replace([updated]);
    expectDefined(h.results.querySelector<HTMLElement>('.abyss-task-card')).click();
    expect(h.openList).toHaveBeenCalledTimes(2);
    expect(h.revealTask).toHaveBeenLastCalledWith(updated);
  });

  it('consumes a renderer-only ordered subset without expanding it', () => {
    const full = fixtures(1200);
    const supplied = full.slice(200, 250).reverse();
    const h = harness([]);
    const calls = h.list.mock.calls.length;
    h.mountLayer.renderFlat_abyssPrivate(h.results, supplied, undefined, {
      onCard: () => undefined,
    });
    const layer = h.panel as unknown as {
      mountedRows_abyssPrivate: {
        rows: { taskKeys: readonly string[]; task(key: string): TaskSnapshot | undefined };
      };
    };
    const logical = layer.mountedRows_abyssPrivate.rows;
    expect(logical.taskKeys).toHaveLength(50);
    expect(logical.taskKeys.map((key) => logical.task(key)?.source.line)).toEqual(
      Array.from({ length: 50 }, (_, i) => 249 - i),
    );
    expect(h.list.mock.calls).toHaveLength(calls);
  });

  it('ignores obsolete query frames after a new query and after host replacement', () => {
    const h = harness();
    h.search.queryChanged('obsolete');
    const obsolete = expectDefined([...h.clock.queued.values()][h.clock.queued.size - 1]);
    h.search.queryChanged('needle 1199');
    const before = h.list.mock.calls.length;
    obsolete(0);
    expect(h.list.mock.calls).toHaveLength(before);
    expect(h.clock.flush()).toBeGreaterThan(0);
    const calls = h.list.mock.calls.length;
    obsolete(0);
    expect(h.list.mock.calls).toHaveLength(calls);
    expect(h.supplied[h.supplied.length - 1]?.map((row) => row.source.line)).toEqual([1199]);
    h.search.queryChanged('obsolete');
    const oldHostFrame = expectDefined([...h.clock.queued.values()][h.clock.queued.size - 1]);
    h.search.clear();
    h.root.empty();
    h.search.render(h.root);
    const afterReplacement = h.list.mock.calls.length;
    oldHostFrame(0);
    expect(h.list.mock.calls).toHaveLength(afterReplacement);
  });

  it('contains an initial direct Search host failure without completing', () => {
    const state = new AppState();
    state.set('mode', 'search');
    state.set('searchQuery', 'needle');
    const error = new Error('initial mount');
    const failResults = vi.fn();
    const completeResults = vi.fn();
    const root = freshContainer();
    prepareTaskPanelViewport(root);
    const navigation = new PanelNavigator(state, DEFAULT_SETTINGS, {
      calendarView: () => 'month',
      setCalendarView: () => undefined,
      openQuickCapture: () => undefined,
    });
    const search = new TaskSearch({
      state,
      queries: { list: () => fixtures(1) },
      navigation,
      host: {
        beginResults: () => undefined,
        revealTask: () => undefined,
        failResults,
        completeResults,
        renderRows: () => {
          throw error;
        },
      },
    });
    expect(() => {
      search.render(root);
    }).not.toThrow();
    expect(failResults).toHaveBeenCalledExactlyOnceWith(error);
    expect(completeResults).not.toHaveBeenCalled();
    search.clear();
    root.remove();
  });

  it('does not bind an obsolete supplied callback onto a replaced result host', () => {
    const h = harness(fixtures(1));
    const obsolete = expectDefined(h.bindings[0]);
    h.search.queryChanged('needle 0');
    h.clock.flush();
    const card = h.results.createDiv();
    obsolete(card, expectDefined(h.supplied[0]?.[0]));
    card.click();
    expect(h.openList).not.toHaveBeenCalled();
    expect(h.revealTask).not.toHaveBeenCalled();
  });

  it('does not complete an initial synchronous result mount failure', () => {
    const h = harness([]);
    const error = new Error('mount failed');
    vi.spyOn(h.mountLayer, 'renderFlat_abyssPrivate').mockImplementation(() => {
      throw error;
    });
    h.completeResults.mockClear();
    expect(() => {
      h.replace(fixtures(1));
    }).not.toThrow();
    expect(h.failResults).toHaveBeenCalledExactlyOnceWith(error);
    expect(h.completeResults).not.toHaveBeenCalled();
  });

  it('cleans partial initial Search rows before their pending text failure and permits retry', async () => {
    const snapshots = fixtures(2).map((row) => ({ ...row, markdownTitle: '**needle**' }));
    const h = centerHarness(snapshots);
    const error = new Error('second row');
    let reject!: (error: Error) => void;
    let first: HTMLElement | null = null;
    let removed: MockInstance<HTMLElement['removeEventListener']> | undefined;
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const render = vi
      .spyOn(MarkdownRenderer, 'render')
      .mockImplementationOnce((_app, _text, holder) => {
        first = holder.closest('.abyss-task-card');
        if (first !== null) removed = vi.spyOn(first, 'removeEventListener');
        return new Promise<void>((_resolve, fail) => {
          reject = fail;
        });
      })
      .mockImplementationOnce(() => {
        throw error;
      });
    expect(() => {
      h.panel.mount(h.root);
    }).not.toThrow();
    expect(h.complete).not.toHaveBeenCalled();
    expect(diagnostic).toHaveBeenCalledTimes(1);
    expect(h.root.querySelectorAll('.abyss-task-card')).toHaveLength(0);
    expect(
      removed?.mock.calls.some(([event, , capture]) => event === 'click' && capture === true),
    ).toBe(true);
    reject(new Error('old text'));
    await Promise.resolve();
    await Promise.resolve();
    expect(diagnostic).toHaveBeenCalledTimes(1);
    expect(h.root.querySelector('.abyss-search-global')?.isConnected).toBe(true);
    render.mockResolvedValue(undefined);
    h.panel.refresh();
    expect(h.clock.flush()).toBeGreaterThan(0);
    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(h.root.querySelectorAll('.abyss-task-card')).toHaveLength(2);
  });

  it('destroys a failed retained update after releasing navigation and then recovers', () => {
    const h = centerHarness(fixtures(1));
    const renderer = (
      h.panel as unknown as {
        taskCardRenderer_abyssPrivate: {
          mount(...args: unknown[]): TaskCardMount;
        };
      }
    ).taskCardRenderer_abyssPrivate;
    const mount = renderer.mount.bind(renderer);
    let fail = true;
    vi.spyOn(renderer, 'mount').mockImplementation((...args) => {
      const card = mount(...args);
      const update = card.update.bind(card);
      return {
        ...card,
        update: (...next) => {
          if (fail) throw new Error('retained update');
          update(...next);
        },
      };
    });
    h.panel.mount(h.root);
    const card = expectDefined(h.root.querySelector<HTMLElement>('.abyss-task-card'));
    const removed = vi.spyOn(card, 'removeEventListener');
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.complete.mockClear();
    h.panel.refresh();
    expect(() => {
      h.clock.flush();
    }).not.toThrow();
    expect(h.complete).not.toHaveBeenCalled();
    expect(diagnostic).toHaveBeenCalledTimes(1);
    expect(
      removed.mock.calls.some(([event, , capture]) => event === 'click' && capture === true),
    ).toBe(true);
    expect(card.isConnected).toBe(false);
    card.click();
    expect(h.state.get('mode')).toBe('search');
    fail = false;
    h.panel.refresh();
    expect(h.clock.flush()).toBeGreaterThan(0);
    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(h.root.querySelectorAll('.abyss-task-card')).toHaveLength(1);
  });

  it('destroys a newly created card when external navigation binding throws', () => {
    const h = harness([]);
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const error = new Error('binding failed');
    expect(() => {
      h.mountLayer.renderFlat_abyssPrivate(h.results, fixtures(1), undefined, {
        onCard: () => {
          throw error;
        },
        failure: 'throw',
      });
    }).toThrow(error);
    expect(h.results.querySelectorAll('.abyss-task-card')).toHaveLength(0);
    expect(diagnostic).not.toHaveBeenCalled();
  });

  it('reports live viewport text failure once without failing a replacement query', async () => {
    const h = centerHarness(fixtures(1200).map((row) => ({ ...row, markdownTitle: '**needle**' })));
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const render = vi.spyOn(MarkdownRenderer, 'render').mockResolvedValue(undefined);
    h.panel.mount(h.root);
    h.clock.flush();
    const results = expectDefined(h.root.querySelector<HTMLElement>('.abyss-center-scroll'));
    let rejectLive!: (error: Error) => void;
    render.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, fail) => {
          rejectLive = fail;
        }),
    );
    results.scrollTop = 20000;
    results.dispatchEvent(new Event('scroll'));
    expect(h.clock.flush()).toBeGreaterThan(0);
    rejectLive(new Error('live text'));
    await Promise.resolve();
    await Promise.resolve();
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith('[abyss-tasks] Could not render task list', {
      kind: 'Error',
    });
    expect(h.complete).toHaveBeenCalledTimes(1);
    let rejectObsolete!: (error: Error) => void;
    render.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, fail) => {
          rejectObsolete = fail;
        }),
    );
    results.scrollTop = 40000;
    results.dispatchEvent(new Event('scroll'));
    expect(h.clock.flush()).toBeGreaterThan(0);
    // A distinct query still supplies the same rows; replacement must invalidate their lifetimes.
    h.state.set('searchQuery', 'needle ');
    expect(h.clock.flush()).toBeGreaterThan(0);
    expect(h.complete).toHaveBeenCalledTimes(2);
    rejectObsolete(new Error('obsolete text'));
    await Promise.resolve();
    await Promise.resolve();
    expect(diagnostic).toHaveBeenCalledTimes(1);
    expect(h.complete).toHaveBeenCalledTimes(2);
  });

  it('preserves the same-query anchor and replaces result lifetimes on a changed query', () => {
    const h = centerHarness(fixtures(1200));
    h.panel.mount(h.root);
    h.clock.flush();
    const results = expectDefined(h.root.querySelector<HTMLElement>('.abyss-center-scroll'));
    results.scrollTop = 20000.625;
    results.dispatchEvent(new Event('scroll'));
    expect(h.clock.flush()).toBeGreaterThan(0);
    const retained = expectDefined(results.querySelector<HTMLElement>('.abyss-task-card'));
    h.panel.refresh();
    expect(h.clock.flush()).toBeGreaterThan(0);
    expect(results.scrollTop).toBe(20000.625);
    expect(retained.isConnected).toBe(true);
    h.state.set('searchQuery', 'needle ');
    expect(h.clock.flush()).toBeGreaterThan(0);
    expect(retained.isConnected).toBe(false);
    expect(h.root.querySelector('.abyss-center-scroll')).toBe(results);
  });

  it('does not fail or complete a superseded reentrant result pass', () => {
    const h = harness(fixtures(1));
    const mount = h.mountLayer.renderFlat_abyssPrivate.bind(h.mountLayer);
    vi.spyOn(h.mountLayer, 'renderFlat_abyssPrivate')
      .mockImplementationOnce(() => {
        h.search.queryChanged('needle 0');
        throw new Error('obsolete pass');
      })
      .mockImplementation(mount);
    h.completeResults.mockClear();
    h.search.refresh();
    expect(h.clock.flush()).toBeGreaterThan(0);
    expect(h.failResults).not.toHaveBeenCalled();
    expect(h.completeResults).not.toHaveBeenCalled();
    expect(h.clock.flush()).toBeGreaterThan(0);
    expect(h.completeResults).toHaveBeenCalledTimes(1);
  });
});

it('scrolls already-active Search after transient popout adoption without requerying or completing results', () => {
  const h = harness();
  h.clock.flush();
  h.input.value = 'needle';
  h.input.setSelectionRange(1, 4);
  h.input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  const queries = h.list.mock.calls.length;
  const completions = h.completeResults.mock.calls.length;
  h.root.remove();
  h.results.dispatchEvent(new Event('scroll'));
  h.clock.flush();
  const owner = taskViewportOwner();
  owner.doc.body.append(h.root);
  h.results.scrollTop = 76000.5;
  h.results.dispatchEvent(new owner.win.Event('scroll'));
  owner.flush();
  const mounted = [...h.results.querySelectorAll<HTMLElement>('.abyss-task-card')];
  expect(mounted.some((card) => Number(card.dataset['line']) > 1100)).toBe(true);
  expect(mounted.length).toBeLessThan(100);
  expect(h.list.mock.calls).toHaveLength(queries);
  expect(h.completeResults.mock.calls).toHaveLength(completions);
  expect(h.supplied[0]).toHaveLength(1200);
  expect(h.root.querySelector('.abyss-search-global')).toBe(h.input);
  expect(h.input.value).toBe('needle');
  expect([h.input.selectionStart, h.input.selectionEnd]).toEqual([1, 4]);
  expect(h.results.scrollTop).toBe(76000.5);
  h.input.dispatchEvent(
    new owner.win.KeyboardEvent('keydown', {
      key: 'Escape',
      isComposing: true,
      bubbles: true,
    }),
  );
  expect(h.input.isConnected).toBe(true);
  h.search.clear();
  h.panel.destroy();
  owner.destroy();
});
