import { MarkdownRenderer, Menu, Notice } from 'obsidian';
import { afterEach, expect, it, vi } from 'vitest';
import type { TaskSearch, TaskSearchOptions } from '../src/panels/center/TaskSearch';
import { TaskSearchReveal } from '../src/panels/center/TaskSearchReveal';
import { CenterPanel } from '../src/panels/CenterPanel';
import { ProjectStore } from '../src/projects/ProjectStore';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { TaskSearchError } from '../src/tasks';
import { TaskSearchService } from '../src/tasks/infrastructure/search/TaskSearchService';
import { TaskIndex } from '../src/tasks/infrastructure/TaskIndex';
import { taskNodeRef } from '../src/ui/taskSelection';
import { deferred, expectDefined, flushMicrotasks, methodOf, useRealMoment } from './helpers';
import { taskCardMountBound } from './support/taskPanelViewport';
import { createCanonicalSearchHarness } from './support/taskSearchHarness';
import {
  mountCanonicalSearchUi,
  searchUiCancellationDiagnostic,
} from './support/taskSearchUiHarness';
import { CANONICAL_SEARCH_SCALE_AUDIT_TIMEOUT_MS } from './support/timeouts';
import { recordVirtualSurfaceResources } from './support/virtualSurfaceResources';

useRealMoment();
afterEach(() => vi.restoreAllMocks());

async function navigationSearchHarness(
  count = 101,
  organizationScheduler?: TaskSearchOptions['organizationScheduler'],
  rootTitle = 'zzz needle',
  ...completion: [readYield?: (signal: AbortSignal) => Promise<void>, lifetimeSignal?: AbortSignal]
) {
  const [readYield, lifetimeSignal] = completion;
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.listViewStates = {
    inbox: {
      groupBy: 'none',
      sortBy: { field: 'title', dir: 'asc' },
      filters: [],
      statusGroups: ['todo'],
    },
  };
  const targetMarkdown = [
    `- [ ] ${rootTitle}`,
    '  - > unrelated',
    '  - [ ] repeated',
    '    - > padding',
    '    - [ ] repeated',
    '      - 2026-10-04: grandchild needle',
  ].join('\n');
  // Real 50k roots across bounded files isolate complete-order organization from giant-file parsing
  // and vocabulary scaling; the native/resource corpus belongs to Task4. Every address is canonical.
  const files =
    count === 50000
      ? {
          ...Object.fromEntries(
            Array.from({ length: 100 }, (_, file) => [
              `bulk/${String(file).padStart(3, '0')}.md`,
              Array.from(
                { length: file === 99 ? 499 : 500 },
                (_, line) => `- [ ] aaa ${line}`,
              ).join('\n'),
            ]),
          ),
          'a.md': targetMarkdown,
        }
      : {
          'a.md': [
            ...Array.from(
              { length: count - 1 },
              (_, i) => `- [ ] aaa ${String(i).padStart(5, '0')}`,
            ),
            targetMarkdown,
          ].join('\n'),
        };
  const h = await mountCanonicalSearchUi(
    files,
    settings,
    'search',
    organizationScheduler,
    false,
    undefined,
    readYield,
    lifetimeSignal,
  );
  try {
    // This fixture exercises organization/reveal; cold preparation has separate coverage.
    await h.search.prepare(lifetimeSignal ?? new AbortController().signal);
    h.query('needle');
    await h.completed('initial-search');
    const owners = h.panel as unknown as {
      taskSearch_abyssPrivate: TaskSearch;
      taskSearchReveal_abyssPrivate: TaskSearchReveal;
    };
    const list = vi.spyOn(h.index, 'list');
    const nodes = vi.spyOn(h.index, 'listNodes');
    const cursor = await h.search.open(
      { kind: 'roots', query: 'needle' },
      lifetimeSignal ?? new AbortController().signal,
    );
    const page = await h.search.read(cursor, 0, 50, lifetimeSignal ?? new AbortController().signal);
    const hit = expectDefined(page.hits[0]);
    const child = { ...hit.address, childLines: [2, 2] };
    return {
      ...h,
      settings,
      list,
      nodes,
      receipt: () => owners.taskSearchReveal_abyssPrivate.current(),
      activateChild: () => owners.taskSearch_abyssPrivate.activate(child),
      captureNavigation: () =>
        structuredClone({
          mode: h.state.get('mode'),
          selectedList: h.state.get('selectedList'),
          taskStack: h.state.get('taskStack'),
          inspectorBackStack: h.state.get('inspectorBackStack'),
          query: h.state.get('searchQuery'),
          receipt: owners.taskSearchReveal_abyssPrivate.current(),
          lists: settings.listViewStates,
        }),
    };
  } catch (error) {
    h.dispose();
    throw error;
  }
}

it.each(['initialization', 'mount', 'preparation', 'lookup'] as const)(
  'releases acquired navigation owners when %s rejects before returning a harness',
  async (stage) => {
    const resources = recordVirtualSurfaceResources();
    const empty = resources.counts();
    const initialElements = new Set(document.body.children);
    const acquired: {
      panel?: CenterPanel;
      index?: TaskIndex;
      search?: TaskSearchService;
    } = {};
    const mount = methodOf(CenterPanel.prototype, 'mount');
    vi.spyOn(CenterPanel.prototype, 'mount').mockImplementation(function (this: CenterPanel, root) {
      acquired.panel = this;
      mount.call(this, root);
      if (stage === 'mount') throw failure;
    });
    const initialize = methodOf(TaskIndex.prototype, 'initialize');
    vi.spyOn(TaskIndex.prototype, 'initialize').mockImplementation(function (this: TaskIndex) {
      acquired.index = this;
      return initialize.call(this).then(() => {
        if (stage === 'initialization') throw failure;
      });
    });
    const failure = new Error('Navigation setup rejected');
    if (stage === 'preparation') {
      vi.spyOn(TaskSearchService.prototype, 'prepare').mockImplementationOnce(async function (
        this: TaskSearchService,
      ) {
        acquired.search = this;
        throw failure;
      });
    } else if (stage === 'lookup') {
      const read = methodOf(TaskSearchService.prototype, 'read');
      vi.spyOn(TaskSearchService.prototype, 'read').mockImplementation(async function (
        this: TaskSearchService,
        ...args
      ) {
        acquired.search = this;
        if (args[2] === 50) {
          expect(resources.counts().components).toBeGreaterThan(empty.components);
          throw failure;
        }
        return await read.call(this, ...args);
      });
    }
    try {
      await expect(navigationSearchHarness()).rejects.toBe(failure);
      expect(resources.counts()).toEqual(empty);
      expect([...document.body.children].filter((el) => !initialElements.has(el))).toHaveLength(0);
      const subscription = expectDefined(acquired.index)
        .searchSource()
        .subscribe(() => {});
      subscription.unsubscribe();
      expect(subscription.state.type).toBe('disposed');
    } finally {
      // Also release the real owners when checking the pre-fix rejection path.
      acquired.panel?.destroy();
      acquired.search?.dispose();
      acquired.index?.destroy();
      for (const el of [...document.body.children]) if (!initialElements.has(el)) el.remove();
    }
  },
);

it.each(['panel', 'search'] as const)(
  'releases later owners and detaches cancellation after %s teardown throws',
  async (owner) => {
    const lifetime = new AbortController();
    const h = await mountCanonicalSearchUi(
      { 'a.md': '- [ ] needle' },
      structuredClone(DEFAULT_SETTINGS),
      'search',
      undefined,
      false,
      undefined,
      undefined,
      lifetime.signal,
    );
    const destroyPanel = h.panel.destroy.bind(h.panel);
    const disposeSearch = h.search.dispose.bind(h.search);
    const failure = new Error(`${owner} teardown failed`);
    const release = (
      owner === 'panel' ? vi.spyOn(h.panel, 'destroy') : vi.spyOn(h.search, 'dispose')
    ).mockImplementation(() => {
      if (owner === 'search') disposeSearch();
      throw failure;
    });
    const remove = vi.spyOn(lifetime.signal, 'removeEventListener');
    try {
      expect(() => {
        h.dispose();
      }).toThrow(failure);
      expect(h.root.isConnected).toBe(false);
      const snapshot = h.source.subscribe(() => {});
      snapshot.unsubscribe();
      expect(snapshot.state.type).toBe('disposed');
      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
      expect(() => {
        h.dispose();
      }).not.toThrow();
      expect(() => {
        h.close();
      }).not.toThrow();
    } finally {
      release.mockRestore();
      destroyPanel();
      disposeSearch();
      h.index.destroy();
      h.root.remove();
      h.dispose();
    }
  },
);

it('releases the canonical index when Search disposal throws and repeated close is safe', async () => {
  const h = await createCanonicalSearchHarness(
    { 'a.md': '- [ ] needle' },
    structuredClone(DEFAULT_SETTINGS),
  );
  const disposeSearch = h.search.dispose.bind(h.search);
  const failure = new Error('Search teardown failed');
  const release = vi.spyOn(h.search, 'dispose').mockImplementation(() => {
    disposeSearch();
    throw failure;
  });
  try {
    expect(() => {
      h.close();
    }).toThrow(failure);
    const snapshot = h.source.subscribe(() => {});
    snapshot.unsubscribe();
    expect(snapshot.state.type).toBe('disposed');
    expect(() => {
      h.close();
    }).not.toThrow();
  } finally {
    release.mockRestore();
    disposeSearch();
    h.index.destroy();
  }
});

it('reports the original cancellation cleanup failure after releasing later UI owners', async () => {
  const lifetime = new AbortController();
  const h = await mountCanonicalSearchUi(
    { 'a.md': '- [ ] needle' },
    structuredClone(DEFAULT_SETTINGS),
    'search',
    undefined,
    false,
    undefined,
    undefined,
    lifetime.signal,
  );
  const destroyPanel = h.panel.destroy.bind(h.panel);
  const disposeSearch = h.search.dispose.bind(h.search);
  const failure = new Error('Panel teardown failed');
  const secondary = new Error('Search teardown also failed');
  const panelRelease = vi.spyOn(h.panel, 'destroy').mockImplementation(() => {
    throw failure;
  });
  const searchRelease = vi.spyOn(h.search, 'dispose').mockImplementation(() => {
    disposeSearch();
    throw secondary;
  });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const remove = vi.spyOn(lifetime.signal, 'removeEventListener');
  h.root.dataset['searchPhase'] = 'pending';
  const waiting = h.completed('destination-reveal').catch((error: unknown) => error);
  try {
    lifetime.abort();
    expect(await waiting).toBeInstanceOf(Error);
    expect(log).toHaveBeenCalledExactlyOnceWith(
      '[abyss-tasks] Search UI cancellation cleanup failed',
      failure,
    );
    expect(h.root.isConnected).toBe(false);
    const snapshot = h.source.subscribe(() => {});
    snapshot.unsubscribe();
    expect(snapshot.state.type).toBe('disposed');
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(() => {
      h.dispose();
    }).not.toThrow();
  } finally {
    panelRelease.mockRestore();
    searchRelease.mockRestore();
    destroyPanel();
    disposeSearch();
    h.index.destroy();
    h.dispose();
  }
});

it('reports setup cancellation cleanup failure and detaches its listener', async () => {
  const lifetime = new AbortController();
  const held = deferred<void>();
  const entered = deferred<TaskIndex>();
  const initialize = methodOf(TaskIndex.prototype, 'initialize');
  vi.spyOn(TaskIndex.prototype, 'initialize').mockImplementation(async function (this: TaskIndex) {
    await initialize.call(this);
    entered.resolve(this);
    await held.promise;
  });
  const acquiring = createCanonicalSearchHarness(
    { 'a.md': '- [ ] needle' },
    structuredClone(DEFAULT_SETTINGS),
    true,
    undefined,
    undefined,
    undefined,
    lifetime.signal,
  ).catch((error: unknown) => error);
  const index = await entered.promise;
  const destroy = index.destroy.bind(index);
  const failure = new Error('Index teardown failed');
  const release = vi.spyOn(index, 'destroy').mockImplementation(() => {
    destroy();
    throw failure;
  });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const remove = vi.spyOn(lifetime.signal, 'removeEventListener');
  try {
    lifetime.abort();
    expect(log).toHaveBeenCalledExactlyOnceWith(
      '[abyss-tasks] Search setup cancellation cleanup failed',
      failure,
    );
    const snapshot = index.searchSource().subscribe(() => {});
    snapshot.unsubscribe();
    expect(snapshot.state.type).toBe('disposed');
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    held.resolve();
    expect(await acquiring).toBeInstanceOf(Error);
  } finally {
    held.resolve();
    await acquiring;
    release.mockRestore();
    destroy();
  }
});

it('cancels acquired initialization before any panel is published', async () => {
  const lifetime = new AbortController();
  const held = deferred<void>();
  const entered = deferred<TaskIndex>();
  const initialize = methodOf(TaskIndex.prototype, 'initialize');
  vi.spyOn(TaskIndex.prototype, 'initialize').mockImplementation(async function (this: TaskIndex) {
    await initialize.call(this);
    entered.resolve(this);
    await held.promise;
  });
  const mount = vi.spyOn(CenterPanel.prototype, 'mount');
  const acquiring = mountCanonicalSearchUi(
    { 'a.md': '- [ ] needle' },
    structuredClone(DEFAULT_SETTINGS),
    'search',
    undefined,
    false,
    undefined,
    undefined,
    lifetime.signal,
  );
  const result = acquiring.then(
    (h) => {
      h.dispose();
      return 'published';
    },
    (error: unknown) => error,
  );
  const index = await entered.promise;
  lifetime.abort(new Error('Setup cancelled'));
  const snapshot = index.searchSource().subscribe(() => {});
  try {
    expect(snapshot.state.type).toBe('disposed');
  } finally {
    snapshot.unsubscribe();
    held.resolve();
    await result;
    index.destroy();
  }
  expect(await result).toBeInstanceOf(Error);
  expect(mount).not.toHaveBeenCalled();
});

it('cancels first preparation before the navigation factory returns', async () => {
  const resources = recordVirtualSurfaceResources();
  const empty = resources.counts();
  const lifetime = new AbortController();
  const entered = deferred<void>();
  const prepare = methodOf(TaskSearchService.prototype, 'prepare');
  let pendingTurn: ReturnType<typeof setImmediate> | undefined;
  let turnRan = false;
  vi.spyOn(TaskSearchService.prototype, 'prepare').mockImplementationOnce(async function (
    this: TaskSearchService,
    signal,
  ) {
    await prepare.call(this, signal);
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        clearImmediate(expectDefined(pendingTurn));
        signal.removeEventListener('abort', abort);
        reject(new TaskSearchError('aborted', 'Held preparation cancelled'));
      };
      pendingTurn = setImmediate(() => {
        turnRan = true;
        signal.removeEventListener('abort', abort);
        resolve();
      });
      signal.addEventListener('abort', abort, { once: true });
      entered.resolve();
    });
  });
  const acquiring = navigationSearchHarness(2, undefined, 'zzz needle', undefined, lifetime.signal);
  const result = acquiring.then(
    (h) => {
      h.dispose();
      return 'published';
    },
    (error: unknown) => error,
  );
  await entered.promise;
  lifetime.abort();
  expect(resources.counts()).toEqual(empty);
  expect(await result).toBeInstanceOf(Error);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(turnRan).toBe(false);
});

it.each(['external', 'dispose'] as const)(
  'cancels a pending destination receipt through %s ownership',
  async (ending) => {
    const resources = recordVirtualSurfaceResources();
    const empty = resources.counts();
    const lifetime = new AbortController();
    const h = await navigationSearchHarness(2, undefined, 'zzz needle', undefined, lifetime.signal);
    const entered = deferred<void>();
    const hydrate = h.search.resolveHits.bind(h.search);
    let pendingTurn: ReturnType<typeof setImmediate> | undefined;
    let turnRan = false;
    vi.spyOn(h.search, 'resolveHits').mockImplementation(async (hits, signal) => {
      const result = await hydrate(hits, signal);
      if (h.state.get('mode') === 'tasks')
        await new Promise<void>((resolve, reject) => {
          const abort = (): void => {
            clearImmediate(expectDefined(pendingTurn));
            signal.removeEventListener('abort', abort);
            reject(new TaskSearchError('aborted', 'Held destination cancelled'));
          };
          pendingTurn = setImmediate(() => {
            turnRan = true;
            signal.removeEventListener('abort', abort);
            resolve();
          });
          signal.addEventListener('abort', abort, { once: true });
          entered.resolve();
        });
      return result;
    });
    try {
      await h.activateChild();
      await entered.promise;
      const waiting = h.completed('destination-reveal').catch((error: unknown) => error);
      if (ending === 'external') lifetime.abort();
      else h.dispose();
      expect(await waiting).toBeInstanceOf(Error);
      expect(String(await waiting)).toContain('destination-reveal');
      if (ending === 'external')
        expect(searchUiCancellationDiagnostic(lifetime.signal)).toContain('destination-reveal');
      expect(h.root.isConnected).toBe(false);
      const snapshot = h.source.subscribe(() => {});
      snapshot.unsubscribe();
      expect(snapshot.state.type).toBe('disposed');
      expect(resources.counts()).toEqual(empty);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(turnRan).toBe(false);
      h.dispose();
      expect(resources.counts()).toEqual(empty);
      await flushMicrotasks();
    } finally {
      h.dispose();
    }
  },
);

it('normal finish aborts the local lifetime and releases acquired owners', async ({
  signal,
  onTestFinished,
}) => {
  const lifetime = new AbortController();
  const abort = (): void => {
    lifetime.abort(signal.reason);
  };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  onTestFinished(() => {
    expect(lifetime.signal.aborted).toBe(true);
    expect(h.root.isConnected).toBe(false);
    const snapshot = h.source.subscribe(() => {});
    snapshot.unsubscribe();
    expect(snapshot.state.type).toBe('disposed');
  });
  onTestFinished(() => {
    signal.removeEventListener('abort', abort);
    lifetime.abort(new Error('Search test finished'));
  });
  const h = await mountCanonicalSearchUi(
    { 'a.md': '- [ ] needle' },
    structuredClone(DEFAULT_SETTINGS),
    'search',
    undefined,
    false,
    undefined,
    undefined,
    lifetime.signal,
  );
});

it('installs exact child and receipt before mode delivery, then reaches its exact child in the complete compact order', async () => {
  const h = await navigationSearchHarness();
  try {
    const deliveries: unknown[] = [];
    h.state.on('mode', () =>
      deliveries.push({
        receipt: h.receipt()?.address.childLines,
        path: h.state.get('taskStack').map((n) => n.title),
      }),
    );
    await h.activateChild();
    await h.completed();
    expect(deliveries).toEqual([{ receipt: [2, 2], path: ['zzz needle', 'repeated', 'repeated'] }]);
    expect(h.root.querySelectorAll('.abyss-task-card').length).toBeGreaterThan(0);
    expect(h.root.querySelectorAll('.abyss-task-card').length).toBeLessThanOrEqual(
      taskCardMountBound(h.root, 1),
    );
    expect(h.root.querySelector('.is-search-revealed')?.textContent).toContain('repeated');
    expect(h.root.dataset['searchLogicalResults']).toBe('102');
    expect(h.root.querySelector('.abyss-search-paging')).toBeNull();
    expect(h.list).not.toHaveBeenCalled();
    expect(h.nodes).not.toHaveBeenCalled();
  } finally {
    h.dispose();
  }
});

it.each([
  'source-replaced',
  'status-semantics',
  'project-context',
  'deleted-recreated',
  'owner-disposed',
  'new-selection',
] as const)('vetoes delayed %s without persistence or selection changes', async (reason) => {
  const h = await navigationSearchHarness();
  let accept: (() => void) | undefined;
  h.panel.finishProjectTableEditorBefore = (action) => {
    accept = action;
  };
  try {
    const before = h.captureNavigation();
    await h.activateChild();
    expect(h.captureNavigation()).toEqual(before);
    if (reason === 'source-replaced') h.index.installCommittedContent('a.md', '- [ ] replacement');
    if (reason === 'deleted-recreated') {
      h.index.installCommittedContent('a.md', '');
      h.index.installCommittedContent('a.md', '- [ ] zzz needle\n  - [ ] repeated');
    }
    if (reason === 'status-semantics') h.index.setStatusCatalog(h.statusCatalog);
    if (reason === 'project-context') h.panel.refresh('projects');
    if (reason === 'owner-disposed') h.panel.destroy();
    if (reason === 'new-selection') h.state.set('taskStack', []);
    const expected = h.captureNavigation();
    expectDefined(accept)();
    expect(h.captureNavigation()).toEqual(expected);
    expect(h.list).not.toHaveBeenCalled();
    expect(h.nodes).not.toHaveBeenCalled();
  } finally {
    h.dispose();
  }
});

it('accepts a delayed live guard with the child installed at the first delivery', async () => {
  const h = await navigationSearchHarness();
  let accept: (() => void) | undefined;
  h.panel.finishProjectTableEditorBefore = (action) => {
    accept = action;
  };
  try {
    await h.activateChild();
    expect(h.state.get('mode')).toBe('search');
    expectDefined(accept)();
    expect(h.receipt()?.address.childLines).toEqual([2, 2]);
    expect(h.state.get('taskStack')).toHaveLength(3);
    await h.completed();
    expect(h.list).not.toHaveBeenCalled();
  } finally {
    h.dispose();
  }
});

it('uses shared card Enter activation and never selects a range for Search', async () => {
  const h = await navigationSearchHarness();
  try {
    const card = expectDefined(h.root.querySelector<HTMLElement>('.abyss-task-card'));
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => {
      expect(h.state.get('mode')).toBe('tasks');
    });
    await h.completed();
    expect(h.receipt()?.address.childLines).toEqual([]);
    expect(h.root.querySelectorAll('.abyss-task-card').length).toBeLessThanOrEqual(
      taskCardMountBound(h.root, 1),
    );
    expect(h.root.querySelector('.is-search-revealed')?.textContent).toContain('zzz needle');
  } finally {
    h.dispose();
  }
});

it('temporarily includes an excluded completed target without changing saved filters', async () => {
  const h = await navigationSearchHarness();
  try {
    h.index.installCommittedContent('a.md', '- [x] needle #outside');
    await h.completed();
    const before = structuredClone(h.settings.listViewStates?.['inbox']);
    expectDefined(h.root.querySelector<HTMLElement>('.abyss-task-card')).click();
    await vi.waitFor(() => {
      expect(h.state.get('mode')).toBe('tasks');
    });
    await h.completed();
    expect(h.root.querySelectorAll('.abyss-task-card')).toHaveLength(1);
    expect(h.root.textContent).toContain('Revealed task');
    expect(h.settings.listViewStates?.['inbox']).toEqual(before);
    expect(h.list).not.toHaveBeenCalled();
    expect(h.nodes).not.toHaveBeenCalled();
  } finally {
    h.dispose();
  }
});

it('expires a deleted receipt into ordinary Tasks without selecting a successor', async () => {
  const h = await navigationSearchHarness();
  try {
    await h.activateChild();
    await h.completed();
    h.index.installCommittedContent('a.md', '- [ ] replacement at old location');
    await vi.waitFor(() => {
      expect(h.receipt()).toBeUndefined();
    });
    expect(h.root.textContent).toContain('replacement at old location');
    expect(h.root.textContent).not.toContain('Type to search');
    expect(h.root.querySelectorAll('.abyss-task-card')).toHaveLength(1);
    expect(h.state.get('taskStack')[h.state.get('taskStack').length - 1]?.title).not.toBe(
      'replacement at old location',
    );
    expect(h.nodes).toHaveBeenCalled();
  } finally {
    h.dispose();
  }
});

it('keeps activation source proof live while exact hydration is delayed', async () => {
  const h = await navigationSearchHarness();
  let release: (() => void) | undefined;
  const hydrate = h.search.resolveHits.bind(h.search);
  let hold = true;
  vi.spyOn(h.search, 'resolveHits').mockImplementation(async (hits, signal) => {
    const result = await hydrate(hits, signal);
    if (hold) {
      hold = false;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return result;
  });
  try {
    const before = h.captureNavigation();
    const activating = h.activateChild();
    await vi.waitFor(() => {
      expect(release).toBeDefined();
    });
    const retry = deferred<Awaited<ReturnType<typeof h.search.open>>>();
    const open = vi.spyOn(h.search, 'open').mockReturnValue(retry.promise);
    h.index.installCommittedContent('a.md', '- [ ] changed needle');
    expect(h.root.querySelector('.abyss-search-status')?.textContent).toBe(
      'Task changed. Search again.',
    );
    expectDefined(release)();
    await activating;
    expect(h.captureNavigation()).toEqual(before);
    await vi.waitFor(() => {
      expect(open).toHaveBeenCalled();
    });
    expect(h.root.querySelector('.abyss-search-status')?.textContent).toBe(
      'Task changed. Search again.',
    );
    open.mockRestore();
    retry.resolve(
      await h.search.open({ kind: 'roots', query: 'needle' }, new AbortController().signal),
    );
    await h.completed();
    expect(h.root.querySelector('.abyss-search-changed')).toBeNull();
    expect(h.root.querySelector('.abyss-search-status')?.classList.contains('abyss-sr-only')).toBe(
      true,
    );
    h.query('changed');
    await h.completed();
    expect(h.root.textContent).not.toContain('Task changed. Search again.');
  } finally {
    h.dispose();
  }
});

it('keeps the stale hydration announcement through synchronous retry scheduling', async () => {
  const h = await navigationSearchHarness();
  const retry = deferred<Awaited<ReturnType<typeof h.search.open>>>();
  try {
    const before = h.captureNavigation();
    const resolve = vi
      .spyOn(h.search, 'resolveHits')
      .mockRejectedValueOnce(new TaskSearchError('stale', 'Task changed'));
    const open = vi.spyOn(h.search, 'open').mockReturnValue(retry.promise);
    await h.activateChild();
    expect(h.captureNavigation()).toEqual(before);
    expect(h.root.dataset['searchPhase']).toBe('pending');
    expect(h.root.querySelector('.abyss-search-status')?.textContent).toBe(
      'Task changed. Search again.',
    );
    await vi.waitFor(() => {
      expect(open).toHaveBeenCalled();
    });
    resolve.mockRestore();
    open.mockRestore();
    retry.resolve(
      await h.search.open({ kind: 'roots', query: 'needle' }, new AbortController().signal),
    );
    await h.completed();
    expect(h.root.querySelector('.abyss-search-status')?.textContent).toBe('Search complete');
  } finally {
    h.dispose();
  }
});

it('chooses configured prefix children in actual sidebar order after archived pins', async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.pinnedTags = ['#hidden'];
  settings.archivedTags = ['#hidden'];
  settings.tagGroups = [{ id: 'work', name: 'Work', mode: 'prefix', prefix: 'work' }];
  const h = await mountCanonicalSearchUi(
    { 'a.md': '- [ ] needle #hidden\n  - [ ] child #Work/Two #Work/One' },
    settings,
  );
  try {
    h.query('needle');
    await h.completed();
    const all = vi.spyOn(h.index, 'list');
    const nodes = vi.spyOn(h.index, 'listNodes');
    expectDefined(h.root.querySelector<HTMLElement>('.abyss-task-card')).click();
    await vi.waitFor(() => {
      expect(h.state.get('mode')).toBe('tasks');
    });
    expect(h.state.get('selectedList')).toEqual({ type: 'tag', tag: '#Work/One' });
    await h.completed();
    expect(h.root.querySelectorAll('.abyss-task-card')).toHaveLength(2);
    expect(all).not.toHaveBeenCalled();
    expect(nodes).not.toHaveBeenCalled();
  } finally {
    h.dispose();
  }
});

it.each(['timer', 'selection', 'navigation', 'dispose'] as const)(
  'ends the owned two-second pulse on %s',
  async (reason) => {
    const h = await navigationSearchHarness();
    const owner: Window = expectDefined(h.root.ownerDocument.defaultView);
    const timers = new Map<number, () => void>();
    const set = owner.setTimeout.bind(owner);
    const clear = vi.spyOn(owner, 'clearTimeout');
    vi.spyOn(owner, 'setTimeout').mockImplementation((callback, delay) => {
      const id = set(callback, delay);
      if (delay === 2000 && typeof callback === 'function') timers.set(id, callback as () => void);
      return id;
    });
    try {
      await h.activateChild();
      await h.completed();
      const card = expectDefined(h.root.querySelector<HTMLElement>('.is-search-revealed'));
      expect(owner.document.activeElement).not.toBe(card);
      const timer = expectDefined([...timers][0]);
      if (reason === 'selection') h.state.set('taskStack', []);
      if (reason === 'timer') timer[1]();
      if (reason === 'dispose') h.panel.destroy();
      if (reason === 'navigation') h.panel['navigation_abyssPrivate'].openList('inbox');
      expect(clear).toHaveBeenCalledWith(timer[0]);
      expect(card.classList.contains('is-search-revealed')).toBe(false);
      if (reason === 'selection' || reason === 'timer') expect(h.receipt()).toBeDefined();
      timer[1]();
      expect(card.classList.contains('is-search-revealed')).toBe(false);
    } finally {
      h.dispose();
    }
  },
);

it('explicit same-list navigation ends the transient inclusion receipt', async () => {
  const h = await navigationSearchHarness();
  try {
    await h.activateChild();
    await h.completed();
    const owner = h.panel as unknown as {
      navigation_abyssPrivate: { openList(selection: 'inbox'): void };
    };
    owner.navigation_abyssPrivate.openList('inbox');
    expect(h.receipt()).toBeUndefined();
  } finally {
    h.dispose();
  }
});

it.each(['command-toggle', 'other-root-update'] as const)(
  'keeps ordinary Tasks usable after %s expires the receipt',
  async (reason) => {
    const h = await navigationSearchHarness(2);
    try {
      await h.activateChild();
      await h.completed();
      if (reason === 'command-toggle') {
        expectDefined(
          h.root.querySelector<HTMLElement>('.is-search-revealed .abyss-status-marker'),
        ).click();
      } else
        h.index.installCommittedContent(
          'a.md',
          '- [ ] changed other root\n- [ ] zzz needle\n  - > unrelated\n  - [ ] repeated\n    - > padding\n    - [ ] repeated\n      - 2026-10-04: grandchild needle',
        );
      await vi.waitFor(() => {
        expect(h.receipt()).toBeUndefined();
      });
      expect(h.state.get('mode')).toBe('tasks');
      expect(h.state.get('selectedList')).toBe('inbox');
      expect(h.root.textContent).not.toContain('Type to search');
      expect(h.root.dataset['searchPhase']).not.toBe('pending');
      expect(h.root.dataset['searchLogicalResults']).toBeUndefined();
      expect(h.root.querySelectorAll('.abyss-task-card').length).toBeGreaterThan(0);
      if (reason === 'command-toggle')
        expect(
          h.index.list().find((task) => task.title === 'zzz needle')?.subtasks[0]?.subtasks[0]
            ?.status,
        ).toBe('done');
      else expect(h.root.textContent).toContain('changed other root');
      const input = expectDefined(h.root.querySelector<HTMLInputElement>('.abyss-center-search'));
      input.value = 'aaa';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await h.completed();
      expect(h.root.dataset['searchPhase']).toBe('complete');
    } finally {
      h.dispose();
    }
  },
);

it('an old detached card cannot activate through a newer live request', async () => {
  const h = await navigationSearchHarness();
  try {
    const old = expectDefined(h.root.querySelector<HTMLElement>('.abyss-task-card'));
    h.query('aaa');
    await h.completed();
    const hydration = vi.spyOn(h.search, 'resolveHits');
    old.click();
    expect(hydration).not.toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.state.get('mode')).toBe('search');
    expect(h.receipt()).toBeUndefined();
    expect(h.state.get('taskStack')).toEqual([]);
  } finally {
    h.dispose();
  }
});

async function runCanonicalSearchNavigationScaleAudit({
  signal,
  onTestFinished,
}: {
  signal: AbortSignal;
  onTestFinished: (cleanup: () => void) => void;
}): Promise<void> {
  const lifetime = new AbortController();
  const abort = (): void => {
    lifetime.abort(signal.reason);
  };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  onTestFinished(() => {
    signal.removeEventListener('abort', abort);
    lifetime.abort(new Error('Search test finished'));
    const diagnostic = searchUiCancellationDiagnostic(lifetime.signal);
    if (signal.aborted && diagnostic !== undefined) console.error(diagnostic);
  });
  let yields = 0;
  let readYields = 0;
  // Node's global setImmediate gives this correctness fixture a real cancellable task turn.
  const readYield = (signal: AbortSignal): Promise<void> => {
    readYields++;
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new TaskSearchError('aborted', 'Fixture read cancelled'));
        return;
      }
      const abort = (): void => {
        clearImmediate(turn);
        signal.removeEventListener('abort', abort);
        reject(new TaskSearchError('aborted', 'Fixture read cancelled'));
      };
      const turn = setImmediate(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      });
      signal.addEventListener('abort', abort, { once: true });
    });
  };
  const h = await navigationSearchHarness(
    50000,
    () => ({
      now: () => 0,
      yield: async () => {
        yields++;
      },
    }),
    'zzz needle',
    readYield,
    lifetime.signal,
  );
  const hydrate = vi.spyOn(h.search, 'resolveHits');
  try {
    await h.activateChild();
    await h.completed('destination-reveal');
    expect(hydrate.mock.calls.every(([hits]) => hits.length <= 50)).toBe(true);
    expect(
      new Set(hydrate.mock.calls.flatMap(([hits]) => hits.map((hit) => hit.address.rootId))).size,
    ).toBeLessThan(100);
    expect(yields).toBeGreaterThan(300);
    expect(readYields).toBeGreaterThan(1000);
    expect(h.root.dataset['searchLogicalResults']).toBe('50001');
    expect(h.root.querySelector('.abyss-search-paging')).toBeNull();
    expect(h.root.querySelectorAll('.abyss-task-card').length).toBeGreaterThan(0);
    expect(h.root.querySelectorAll('.abyss-task-card').length).toBeLessThanOrEqual(
      taskCardMountBound(h.root, 1),
    );
    expect(h.state.get('taskStack').map((node) => node.title)).toEqual([
      'zzz needle',
      'repeated',
      'repeated',
    ]);
    expect(h.receipt()?.address.childLines).toEqual([2, 2]);
    expect(h.list).not.toHaveBeenCalled();
    expect(h.nodes).not.toHaveBeenCalled();
  } finally {
    h.dispose();
  }
}

it(
  'navigates the last of 50k real compact records cooperatively with bounded exact hydration',
  runCanonicalSearchNavigationScaleAudit,
  CANONICAL_SEARCH_SCALE_AUDIT_TIMEOUT_MS,
);

it('a later inspector selection cancels reveal presentation while the destination hydrates', async () => {
  const h = await navigationSearchHarness();
  const hydrate = h.search.resolveHits.bind(h.search);
  let release: (() => void) | undefined;
  let held = false;
  vi.spyOn(h.search, 'resolveHits').mockImplementation(async (hits, signal) => {
    const result = await hydrate(hits, signal);
    if (
      !held &&
      h.state.get('mode') === 'tasks' &&
      hits.some((hit) => hit.address.rootId === h.receipt()?.address.rootId)
    ) {
      held = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return result;
  });
  try {
    await h.activateChild();
    await vi.waitFor(() => {
      expect(release).toBeDefined();
    });
    h.state.set('taskStack', []);
    expectDefined(release)();
    await h.completed();
    expect(h.root.querySelector('.is-search-revealed')).toBeNull();
    expect(h.state.get('taskStack')).toEqual([]);
    expect(h.receipt()).toBeDefined();
  } finally {
    h.dispose();
  }
});

it.each(['link', 'status', 'tag', 'menu', 'drag'] as const)(
  'keeps %s on its shared-card owner instead of Search activation',
  async (action) => {
    const originalAddItem = methodOf(Menu.prototype, 'addItem');
    vi.spyOn(Menu.prototype, 'addItem').mockImplementation(function (this: Menu, callback) {
      return originalAddItem.call(this, (item) => {
        (item as unknown as { dom: HTMLElement }).dom = createDiv();
        callback(item);
      });
    });
    vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, _source, host) => {
      host.createSpan({ text: 'needle ' });
      host.createEl('a', {
        cls: 'internal-link',
        text: 'Alias',
        attr: { 'data-href': 'Somewhere' },
      });
    });
    const h = await mountCanonicalSearchUi(
      { 'a.md': '- [ ] needle [[Somewhere|Alias]] #work' },
      structuredClone(DEFAULT_SETTINGS),
    );
    try {
      h.query(action === 'tag' ? 'work' : 'needle');
      await h.completed();
      const owner = h.panel as unknown as { taskSearch_abyssPrivate: TaskSearch };
      const activate = vi.spyOn(owner.taskSearch_abyssPrivate, 'activate');
      const card = expectDefined(h.root.querySelector<HTMLElement>('.abyss-task-card'));
      if (action === 'link') expectDefined(card.querySelector<HTMLElement>('a')).click();
      if (action === 'status')
        expectDefined(card.querySelector<HTMLElement>('.abyss-status-marker')).click();
      if (action === 'tag')
        expectDefined(card.querySelector<HTMLElement>('.abyss-task-tag')).click();
      if (action === 'menu') card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
      if (action === 'drag') card.dispatchEvent(new Event('dragstart', { bubbles: true }));
      expect(activate).not.toHaveBeenCalled();
      expect(h.state.get('mode')).toBe('search');
      if (action === 'status')
        await vi.waitFor(() => {
          expect(h.index.list()[0]?.status).toBe('done');
        });
    } finally {
      h.dispose();
    }
  },
);

it('aborts exact activation hydration immediately on a newer inspector intent', async () => {
  const h = await navigationSearchHarness();
  const hydrate = h.search.resolveHits.bind(h.search);
  let release: (() => void) | undefined;
  let activationSignal: AbortSignal | undefined;
  vi.spyOn(h.search, 'resolveHits').mockImplementation(async (hits, signal) => {
    const result = await hydrate(hits, signal);
    activationSignal = signal;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return result;
  });
  try {
    const activating = h.activateChild();
    await vi.waitFor(() => {
      expect(release).toBeDefined();
    });
    h.state.set('taskStack', []);
    expect(activationSignal?.aborted).toBe(true);
    expectDefined(release)();
    await activating;
    expect(h.state.get('mode')).toBe('search');
    expect(h.receipt()).toBeUndefined();
  } finally {
    release?.();
    h.dispose();
  }
});

it.each(['reveal', 'filter'] as const)(
  'settles completed %s results after terminal backend failure without losing exact selection',
  async (surface) => {
    const notice = vi
      .spyOn(
        Notice.prototype as unknown as { constructor__(message: string): void },
        'constructor__',
      )
      .mockImplementation(() => {});
    const h = await navigationSearchHarness(2);
    const hydration = vi.spyOn(h.search, 'resolveHits');
    const preparation = vi.spyOn(h.search, 'prepare');
    const phases: string[] = [];
    const unsubscribe = h.search.subscribe((state) => phases.push(state.phase));
    const input = (text: string): void => {
      const element = expectDefined(h.root.querySelector<HTMLInputElement>('.abyss-center-search'));
      element.value = text;
      element.dispatchEvent(new Event('input', { bubbles: true }));
    };
    try {
      await h.activateChild();
      await h.completed();
      expect(h.state.get('centerFilter')).toBe('');
      expect(h.receipt()?.address.childLines).toEqual([2, 2]);
      if (surface === 'filter') {
        input('needle');
        await h.completed();
      }
      // Exhaust real worker recovery, then let the inline-backed surface finish too.
      for (const index of [0, 1]) {
        expectDefined(h.backends[index]).crash();
        await h.completed();
      }
      // The render receipt precedes #run's finally: drain its owner task turn before crashing.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      expect(hydration.mock.settledResults.length).toBeGreaterThan(0);
      expect(hydration.mock.settledResults.every((result) => result.type === 'fulfilled')).toBe(
        true,
      );
      expect(preparation.mock.settledResults.every((result) => result.type === 'fulfilled')).toBe(
        true,
      );
      expect(h.root.dataset['searchPhase']).toBe('complete');
      expect(h.root.dataset['searchLogicalResults']).toBe(surface === 'reveal' ? '3' : '1');
      const before = h.captureNavigation();
      const status = h.root.querySelector('.abyss-search-status');
      expectDefined(h.backends[2]).crash();
      expect(phases[phases.length - 1]).toBe('failed');
      expect(h.root.dataset['searchPhase']).toBe('error');
      expect(h.root.getAttribute('aria-busy')).toBe('false');
      expect(h.root.dataset['searchLogicalResults']).toBeUndefined();
      expect(h.root.querySelector('.abyss-search-paging')).toBeNull();
      expect(status?.textContent).toContain('Could not load task results');
      expect(notice).toHaveBeenCalledTimes(1);
      expect(h.captureNavigation()).toEqual(before);

      // Passive reveal refresh cannot recover the service or create a second notification.
      h.panel.refresh();
      await expect(h.completed()).rejects.toThrow();
      expect(notice).toHaveBeenCalledTimes(1);
      expect(h.captureNavigation()).toEqual(before);
      input('needle ');
      await expect(h.completed()).rejects.toThrow();
      input('needle  ');
      await expect(h.completed()).rejects.toThrow();
      expect(h.root.querySelector('.abyss-search-status')).toBe(status);
      expect(notice).toHaveBeenCalledTimes(1);
      expect(h.backends).toHaveLength(3);
      expect(h.state.get('taskStack')).toEqual(before.taskStack);

      // Only eligible ordinary input, after the existing service cooldown, recovers.
      const now = h.scheduler.now();
      vi.spyOn(h.scheduler, 'now').mockReturnValue(now + 5001);
      input('needle');
      await h.completed();
      expect(phases[phases.length - 1]).toBe('ready');
      expect(h.root.dataset['searchLogicalResults']).toBe('1');
      expect(h.root.querySelectorAll('.abyss-task-card')).toHaveLength(1);
      expect(h.state.get('mode')).toBe(before.mode);
      expect(h.state.get('selectedList')).toEqual(before.selectedList);
      expect(h.state.get('taskStack')).toEqual(before.taskStack);
      expect(notice).toHaveBeenCalledTimes(1);
      h.search.dispose();
      h.search.dispose();
      expect(h.root.dataset['searchPhase']).toBe('error');
      expect(h.root.getAttribute('aria-busy')).toBe('false');
      expect(h.root.dataset['searchLogicalResults']).toBeUndefined();
      expect(notice).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
      h.dispose();
    }
  },
);

it.each(['live', 'failed-live', 'closed', 'detached'] as const)(
  'handles service disposal for a completed %s reveal without leaking notifications',
  async (owner) => {
    const notice = vi
      .spyOn(
        Notice.prototype as unknown as { constructor__(message: string): void },
        'constructor__',
      )
      .mockImplementation(() => {});
    const h = await navigationSearchHarness(2);
    try {
      await h.activateChild();
      await h.completed();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      const before = h.captureNavigation();
      if (owner === 'failed-live') {
        for (const index of [0, 1]) {
          expectDefined(h.backends[index]).crash();
          await h.completed();
        }
        expectDefined(h.backends[2]).crash();
        expect(h.root.dataset['searchPhase']).toBe('error');
      }
      if (owner === 'closed') h.panel.destroy();
      if (owner === 'detached') h.root.remove();
      h.search.dispose();
      h.search.dispose();
      if (owner === 'live' || owner === 'failed-live') {
        expect(h.root.dataset['searchPhase']).toBe('error');
        expect(h.root.getAttribute('aria-busy')).toBe('false');
        expect(h.root.dataset['searchLogicalResults']).toBeUndefined();
        expect(h.captureNavigation()).toEqual(before);
      }
      expect(notice).toHaveBeenCalledTimes(owner === 'live' || owner === 'failed-live' ? 1 : 0);
    } finally {
      h.dispose();
    }
  },
);

it('consumes one reveal scroll and preserves the absolute pulse deadline across remount', () => {
  let now = 10000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const scroll = vi.fn();
  const owner = new TaskSearchReveal(
    () => window,
    () => 1,
    scroll,
  );
  owner.install({
    id: 1,
    selection: 'inbox',
    address: { epoch: 'source', version: 1, rootId: 1, childLines: [] },
  });
  owner.committed(new Set(['mode']));
  const first = document.body.createDiv();
  owner.show(first);
  now += 700;
  first.remove();
  const second = document.body.createDiv();
  owner.show(second);
  expect(scroll).toHaveBeenCalledTimes(1);
  expect(second.hasClass('is-search-revealed')).toBe(true);
  now += 1301;
  const third = document.body.createDiv();
  owner.show(third);
  expect(third.hasClass('is-search-revealed')).toBe(false);
  expect(scroll).toHaveBeenCalledTimes(1);
  owner.dispose();
});

it.each(['accepted', 'later-intent'] as const)(
  'waits for tall destination Markdown with %s reveal authority',
  async (reason) => {
    const h = await navigationSearchHarness(1200, undefined, 'zzz **needle**');
    let release: (() => void) | undefined;
    const rendered = deferred<void>();
    const surfaceReveal = vi.spyOn(h.panel['taskSearchReveal_abyssPrivate'], 'show');
    const render = vi
      .spyOn(MarkdownRenderer, 'render')
      .mockImplementation(async (_app, text, host) => {
        host.createEl('strong', { text });
        if (h.state.get('mode') === 'tasks' && text.includes('zzz')) {
          rendered.resolve();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
      });
    const bounds = expectDefined(
      vi.mocked(methodOf(HTMLElement.prototype, 'getBoundingClientRect')).getMockImplementation(),
    );
    vi.mocked(methodOf(HTMLElement.prototype, 'getBoundingClientRect')).mockImplementation(
      function (this: HTMLElement) {
        const rect = bounds.call(this);
        if (this.hasClass('abyss-task-card') && this.textContent.includes('zzz'))
          return { ...rect, height: 4096, bottom: 4096 };
        return rect;
      },
    );
    try {
      await h.activateChild();
      await rendered.promise;
      expect(h.root.querySelector('.is-search-revealed')).toBeNull();
      expect(surfaceReveal).not.toHaveBeenCalled();
      if (reason === 'later-intent') h.state.set('taskStack', []);
      expectDefined(release)();
      await h.completed();
      if (reason === 'accepted') {
        expect(h.root.querySelector('.is-search-revealed')?.textContent).toContain('repeated');
        expect(surfaceReveal).toHaveBeenCalledTimes(1);
        expect(h.state.get('taskStack').map((node) => node.title)).toEqual([
          'zzz **needle**',
          'repeated',
          'repeated',
        ]);
      } else {
        expect(h.root.querySelector('.is-search-revealed')).toBeNull();
        expect(surfaceReveal).not.toHaveBeenCalled();
        expect(h.state.get('taskStack')).toEqual([]);
      }
      expect(render).toHaveBeenCalled();
    } finally {
      release?.();
      h.dispose();
    }
  },
);

it('keeps the reveal pulse on the first physical occurrence when duplicate groups reconcile', async () => {
  const h = await navigationSearchHarness(2, undefined, 'zzz needle [[Alice]] [[Bob]]');
  try {
    expectDefined(expectDefined(h.settings.listViewStates)['inbox']).groupBy = 'outgoing-link';
    expectDefined(h.root.querySelector<HTMLElement>('.abyss-task-card')).click();
    await vi.waitFor(() => {
      expect(h.state.get('mode')).toBe('tasks');
    });
    await h.completed();
    const compact = expectDefined(h.panel['taskSurface_abyssPrivate']?.search);
    const target = expectDefined(h.state.get('taskStack')[0]);
    if (!('filePath' in target.ref)) throw new Error('Expected exact root destination');
    const first = expectDefined(
      compact.order.occurrencesOf(`${target.ref.filePath}:${target.ref.line}`)[0],
    );
    const scroll = expectDefined(h.root.querySelector<HTMLElement>('.abyss-center-scroll'));
    scroll.dispatchEvent(new Event('scroll'));
    await flushMicrotasks();
    await flushMicrotasks();
    expect(h.root.querySelector<HTMLElement>('.is-search-revealed')?.dataset['rowKey']).toBe(first);
  } finally {
    h.dispose();
  }
});

it.each(['accepted', 'later-selection', 'replacement', 'disposal'] as const)(
  'inspector exact child navigation owns a real delayed project guard through %s',
  async (outcome) => {
    const h = await navigationSearchHarness(3);
    try {
      const signal = new AbortController().signal;
      const cursor = await h.search.open({ kind: 'roots', query: 'needle' }, signal);
      const batch = await h.search.read(cursor, 0, 10, signal);
      h.search.release(cursor);
      const hit = expectDefined(
        (
          await h.search.resolveHits(
            [
              {
                address: { ...expectDefined(batch.hits[0]).address, childLines: [2, 2] },
                score: 0,
              },
            ],
            signal,
          )
        )[0],
      );
      h.state.set('taskStack', [hit.task.root]);
      h.state.set('mode', 'projects');
      let accept: (() => void) | undefined;
      vi.spyOn(h.panel, 'finishProjectTableEditorBefore').mockImplementation((action) => {
        accept = action;
      });
      await h.panel.showTaskInList(hit.task.target, { signal, isCurrent: () => true });
      expect(h.state.get('mode')).toBe('projects');
      const firstAccept = expectDefined(accept);
      if (outcome === 'later-selection') h.state.set('taskStack', []);
      if (outcome === 'replacement') {
        const firstCancel = h.panel['cancelListActivation_abyssPrivate'];
        await h.panel.showTaskInList(hit.task.target, { signal, isCurrent: () => true });
        expect(h.panel['cancelListActivation_abyssPrivate']).not.toBe(firstCancel);
        firstAccept();
        expect(h.state.get('mode')).toBe('projects');
        expect(h.receipt()).toBeUndefined();
      }
      if (outcome === 'disposal') {
        h.dispose();
        expect(h.panel['cancelListActivation_abyssPrivate']).toBeUndefined();
        firstAccept();
        expect(h.state.get('mode')).toBe('projects');
        expect(h.receipt()).toBeUndefined();
        return;
      }
      expectDefined(accept)();
      if (outcome === 'later-selection') {
        expect(h.state.get('mode')).toBe('projects');
        expect(h.state.get('taskStack')).toEqual([]);
        expect(h.receipt()).toBeUndefined();
      } else {
        expect(h.state.get('mode')).toBe('tasks');
        expect(h.state.get('taskStack')).toHaveLength(3);
        expect(h.state.get('selectedList')).toBe('inbox');
        expect(h.receipt()?.address.childLines).toEqual([2, 2]);
        expect(h.panel['cancelListActivation_abyssPrivate']).toBeUndefined();
        await h.completed();
        expect(h.root.querySelector('.is-search-revealed')).not.toBeNull();
      }
      expect(h.list).not.toHaveBeenCalled();
      expect(h.nodes).not.toHaveBeenCalled();
    } finally {
      h.dispose();
    }
  },
);

it.each([
  ['click', false],
  ['Enter', false],
  [' ', false],
  ['click', true],
  ['Enter', true],
  [' ', true],
] as const)(
  'selects deep child and reveals its filtered immediate parent by %s (compact=%s)',
  async (activation, compact) => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    const h = await mountCanonicalSearchUi(
      {
        'tree.md':
          '- [ ] Grandparent #one-off\n  - [ ] Parent #private\n    - [ ] Same #inbox 📅 2026-10-08\n  - [ ] Same #inbox 📅 2026-10-08',
      },
      settings,
      'tasks',
    );
    try {
      h.state.set('selectedList', { type: 'tag', tag: '#inbox' });
      h.panel.refresh();
      if (compact) {
        h.query('Same');
        await h.completed();
      }
      const cards = [...h.root.querySelectorAll<HTMLElement>('.abyss-task-card')];
      expect(cards.map((card) => card.dataset['line'])).toEqual(['2', '3']);
      const card = expectDefined(cards[0]);
      card.click();
      const selectedStack = h.state.get('taskStack');
      expect(selectedStack.map((n) => n.title)).toEqual(['Grandparent', 'Parent', 'Same']);
      const parentButton = expectDefined(
        card.querySelector<HTMLButtonElement>('.abyss-task-parent-btn'),
      );
      expect(parentButton.getAttribute('aria-label')).toContain('Parent');
      const show = vi.spyOn(h.panel, 'showTaskInList');
      if (activation === 'click') parentButton.click();
      else
        parentButton.dispatchEvent(
          new KeyboardEvent('keydown', { key: activation, bubbles: true, cancelable: true }),
        );
      await flushMicrotasks(40);
      expect(show).toHaveBeenCalledTimes(1);
      const revealTarget = show.mock.calls[0]?.[0];
      expect(revealTarget).toEqual(taskNodeRef(expectDefined(selectedStack[1])));
      await show.mock.results[0]?.value;
      await h.completed();
      expect(h.state.get('taskStack').map((n) => n.title)).toEqual(['Grandparent', 'Parent']);
      const parentCard = expectDefined(
        h.root.querySelector<HTMLElement>('.abyss-task-card[data-line="1"]'),
      );
      expect(parentCard.querySelector('.abyss-task-title')?.textContent).toBe('Parent');
      expect(parentCard.classList.contains('is-selected')).toBe(true);
    } finally {
      h.dispose();
    }
  },
);

it.each([false, true])(
  'preserves child capabilities in mixed bulk selection (compact=%s)',
  async (compact) => {
    const h = await mountCanonicalSearchUi(
      {
        'tree.md':
          '- [ ] Grandparent #inbox\n  - [ ] Parent #private\n    - [ ] Same #inbox 📅 2026-10-08\n  - [ ] Same #inbox 📅 2026-10-08',
      },
      structuredClone(DEFAULT_SETTINGS),
      'tasks',
    );
    try {
      h.state.set('selectedList', { type: 'tag', tag: '#inbox' });
      h.panel.refresh();
      if (compact) {
        h.query('#inbox');
        await h.completed();
      }
      const cards = [...h.root.querySelectorAll<HTMLElement>('.abyss-task-card')];
      expect(cards).toHaveLength(3);
      for (const card of cards)
        card.dispatchEvent(new MouseEvent('click', { ctrlKey: true, bubbles: true }));
      const targets = h.panel['taskMenuTargets_abyssPrivate']();
      expect(targets.summaries.map((summary) => summary.depth)).toEqual([2, 1, 0]);
      const selected = await targets.resolve(targets.signal);
      expect(selected.map((entry) => entry.task.path.length)).toEqual([2, 1, 0]);
    } finally {
      h.dispose();
    }
  },
);

it('refreshes ordinary child admission after status semantics change', async () => {
  const h = await mountCanonicalSearchUi(
    { 'tree.md': '- [ ] Grandparent #one-off\n  - [x] Child #inbox' },
    structuredClone(DEFAULT_SETTINGS),
    'tasks',
  );
  try {
    h.state.set('selectedList', { type: 'tag', tag: '#inbox' });
    h.panel.refresh();
    expect(h.root.querySelectorAll('.abyss-task-card')).toHaveLength(0);
    h.statusCatalog.replace(
      h.statusCatalog
        .all()
        .map((rule) =>
          rule.symbol === 'x' ? { ...rule, type: 'todo', defaultForType: false } : rule,
        ),
    );
    h.index.setStatusCatalog(h.statusCatalog);
    h.panel.refresh();
    expect(h.root.querySelectorAll('.abyss-task-card')).toHaveLength(1);
    expect(h.root.querySelector('.abyss-task-title')?.textContent).toBe('Child');
  } finally {
    h.dispose();
  }
});

async function projectChildRevealHarness() {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.projects.membershipQuery = 'Projects/';
  const h = await mountCanonicalSearchUi(
    {
      'Projects/Tree.md':
        '- [ ] Grandparent #one-off\n  - [ ] Parent #private\n    - [ ] Same #inbox 📅 2026-10-08\n  - [ ] Same #inbox 📅 2026-10-08\n- [ ] Other root',
    },
    settings,
    'tasks',
  );
  h.panel.destroy();
  const projects = new ProjectStore(h.app, h.index, settings);
  projects.initialize();
  const panel = new CenterPanel({
    state: h.state,
    app: h.app,
    settings,
    queries: h.index,
    search: h.search,
    statusRegistry: h.statusRegistry,
    tasks: h.tasks,
    projectStore: projects,
  });
  panel.mount(h.root);
  return {
    ...h,
    settings,
    projects,
    panel,
    dispose: () => {
      panel.destroy();
      projects.destroy();
      h.dispose();
    },
  };
}

it.each([false, true])(
  'reveals a nested parent in its project without expanding project membership (source compact=%s)',
  async (compact) => {
    const h = await projectChildRevealHarness();
    try {
      expect(h.projects.list().map((project) => project.path)).toEqual(['Projects/Tree.md']);
      h.panel['navigation_abyssPrivate'].openList({ type: 'project', path: 'Projects/Tree.md' });
      const lines = () =>
        [...h.root.querySelectorAll<HTMLElement>('.abyss-task-card')].map(
          (card) => card.dataset['line'],
        );
      expect(lines()).toEqual(['0', '4']);
      h.state.set('centerListViewState', {
        ...h.state.get('centerListViewState'),
        filters: [{ type: 'tag', value: '#one-off' }],
      });
      const projectView = structuredClone(h.state.get('centerListViewState'));
      h.panel['navigation_abyssPrivate'].openList({ type: 'tag', tag: '#inbox' });
      if (compact) {
        h.query('Same');
        await h.completed();
      }
      expect(lines()).toEqual(['2', '3']);
      const child = expectDefined(
        h.root.querySelector<HTMLElement>('.abyss-task-card[data-line="2"]'),
      );
      const population = vi.spyOn(h.index, 'list');
      const nodes = vi.spyOn(h.index, 'listNodes');
      const organization = vi.spyOn(h.index, 'organization');
      child.click();
      expect(h.state.get('taskStack').map((node) => node.title)).toEqual([
        'Grandparent',
        'Parent',
        'Same',
      ]);
      expectDefined(child.querySelector<HTMLButtonElement>('.abyss-task-parent-btn')).click();
      await vi.waitFor(() => {
        expect(h.state.get('selectedList')).toEqual({ type: 'project', path: 'Projects/Tree.md' });
      });
      await h.completed();
      expect(h.state.get('selectedList')).toEqual({ type: 'project', path: 'Projects/Tree.md' });
      expect(h.state.get('centerFilter')).toBe('');
      expect(h.state.get('centerListViewState')).toEqual(projectView);
      expect(h.state.get('taskStack').map((node) => node.title)).toEqual(['Grandparent', 'Parent']);
      expect(lines()).toEqual(['0', '1']);
      expect(population).not.toHaveBeenCalled();
      expect(nodes).not.toHaveBeenCalled();
      expect(organization).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'nodes', filePath: 'Projects/Tree.md' }),
        expect.any(AbortSignal),
      );
      const parent = expectDefined(
        h.root.querySelector<HTMLElement>('.abyss-task-card[data-line="1"]'),
      );
      expect(parent.querySelector('.abyss-task-title')?.textContent).toBe('Parent');
      expect(parent.classList.contains('is-selected')).toBe(true);
      expect(parent.classList.contains('is-search-revealed')).toBe(true);
      const projection = h.panel['mountedProjection_abyssPrivate'](
        expectDefined(parent.dataset['rowKey']),
      );
      expect(projection?.target).toEqual(taskNodeRef(expectDefined(h.state.get('taskStack')[1])));
      h.panel['navigation_abyssPrivate'].openList({ type: 'project', path: 'Projects/Tree.md' });
      await vi.waitFor(() => {
        expect(lines()).toEqual(['0']);
      });
      h.state.set('centerListViewState', { ...projectView, filters: [] });
      await vi.waitFor(() => {
        expect(lines()).toEqual(['0', '4']);
      });
    } finally {
      h.dispose();
    }
  },
);

it('quietly retires project child reveal while its compact projection is pending', async () => {
  const h = await projectChildRevealHarness();
  const entered = deferred<void>(),
    held = deferred<void>();
  const organization = h.index.organization.bind(h.index);
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const notices = vi.spyOn(
    Notice.prototype as unknown as { constructor__(message: string): void },
    'constructor__',
  );
  let pendingSignal: AbortSignal | undefined;
  vi.spyOn(h.index, 'organization').mockImplementation(async function* (request, signal) {
    for await (const batch of organization(request, signal)) {
      const selection = h.state.get('selectedList');
      if (typeof selection === 'object' && selection.type === 'project') {
        pendingSignal = signal;
        entered.resolve();
        await held.promise;
      }
      yield batch;
    }
  });
  try {
    h.panel['navigation_abyssPrivate'].openList({ type: 'tag', tag: '#inbox' });
    const child = expectDefined(
      h.root.querySelector<HTMLElement>('.abyss-task-card[data-line="2"]'),
    );
    expectDefined(child.querySelector<HTMLButtonElement>('.abyss-task-parent-btn')).click();
    await entered.promise;
    h.panel['navigation_abyssPrivate'].openList({ type: 'tag', tag: '#one-off' });
    h.state.set('taskStack', []);
    expect(pendingSignal?.aborted).toBe(true);
    held.resolve();
    await flushMicrotasks(50);
    expect(h.state.get('taskStack')).toEqual([]);
    expect(h.root.querySelectorAll('.abyss-task-card')).toHaveLength(1);
    expect(h.root.querySelector('.abyss-task-card')?.getAttribute('data-line')).toBe('0');
    expect(h.root.querySelector('.is-search-revealed')).toBeNull();
    expect(log).not.toHaveBeenCalled();
    expect(notices).not.toHaveBeenCalled();
  } finally {
    held.resolve();
    h.dispose();
  }
});

it('rejects a project parent reveal after its source becomes excluded', async () => {
  const h = await projectChildRevealHarness();
  const notices = vi.spyOn(
    Notice.prototype as unknown as { constructor__(message: string): void },
    'constructor__',
  );
  try {
    h.panel['navigation_abyssPrivate'].openList({ type: 'tag', tag: '#inbox' });
    const parent = expectDefined(h.index.listNodes().find(({ node }) => node.title === 'Parent'));
    await h.index.refreshSourceExclusion(({ filePath }) => filePath === 'Projects/Tree.md');
    h.panel.refresh('source');
    await h.panel.showTaskInList(parent.target, {
      signal: new AbortController().signal,
      isCurrent: () => true,
    });
    expect(h.state.get('selectedList')).toEqual({ type: 'tag', tag: '#inbox' });
    expect(h.state.get('taskStack')).toEqual([]);
    expect(h.root.querySelector('.abyss-task-card')).toBeNull();
    expect(h.panel['taskSearchReveal_abyssPrivate'].current()).toBeUndefined();
    expect(notices).toHaveBeenCalledExactlyOnceWith(
      'Task changed. Show it in the task list again.',
      undefined,
    );
  } finally {
    h.dispose();
  }
});
