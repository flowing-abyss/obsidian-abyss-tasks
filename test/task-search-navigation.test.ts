import { MarkdownRenderer, Menu, Notice } from 'obsidian';
import { afterEach, expect, it, vi } from 'vitest';
import type { TaskSearch, TaskSearchOptions } from '../src/panels/center/TaskSearch';
import { TaskSearchReveal } from '../src/panels/center/TaskSearchReveal';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { deferred, expectDefined, flushMicrotasks, methodOf, useRealMoment } from './helpers';
import { taskCardMountBound } from './support/taskPanelViewport';
import { mountCanonicalSearchUi } from './support/taskSearchUiHarness';

useRealMoment();
afterEach(() => vi.restoreAllMocks());

async function navigationSearchHarness(
  count = 101,
  organizationScheduler?: TaskSearchOptions['organizationScheduler'],
  rootTitle = 'zzz needle',
) {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.listViewStates = {
    inbox: {
      groupBy: 'none',
      sortBy: { field: 'title', dir: 'asc' },
      filters: [],
      statusGroups: ['todo'],
    },
  };
  const markdown = [
    ...Array.from({ length: count - 1 }, (_, i) => `- [ ] aaa ${String(i).padStart(5, '0')}`),
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
          'a.md': markdown
            .split('\n')
            .slice(count - 1)
            .join('\n'),
        }
      : { 'a.md': markdown };
  const h = await mountCanonicalSearchUi(files, settings, 'search', organizationScheduler);
  // This fixture exercises organization/reveal; cold preparation has separate coverage.
  await h.search.prepare(new AbortController().signal);
  h.query('needle');
  await h.completed();
  const owners = h.panel as unknown as {
    taskSearch_abyssPrivate: TaskSearch;
    taskSearchReveal_abyssPrivate: TaskSearchReveal;
  };
  const list = vi.spyOn(h.index, 'list');
  const nodes = vi.spyOn(h.index, 'listNodes');
  const cursor = await h.search.open(
    { kind: 'roots', query: 'needle' },
    new AbortController().signal,
  );
  const page = await h.search.read(cursor, 0, 50, new AbortController().signal);
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
}

it('installs exact child and receipt before mode delivery, then reaches its exact root in the complete compact order', async () => {
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
    expect(h.root.querySelector('.is-search-revealed')?.textContent).toContain('zzz needle');
    expect(h.root.dataset['searchLogicalResults']).toBe('101');
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
    expect(h.root.textContent).toContain('Revealed from search');
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
    expect(h.list).toHaveBeenCalled();
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
    h.index.installCommittedContent('a.md', '- [ ] changed needle');
    expectDefined(release)();
    await activating;
    expect(h.captureNavigation()).toEqual(before);
    await h.completed();
    expect(h.root.textContent).toContain('Task changed. Search again.');
    h.query('changed');
    await h.completed();
    expect(h.root.textContent).not.toContain('Task changed. Search again.');
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
    expect(h.root.querySelectorAll('.abyss-task-card')).toHaveLength(1);
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
        expect(h.index.list().find((task) => task.title === 'zzz needle')?.status).toBe('done');
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

it('navigates the last of 50k real compact records cooperatively with bounded exact hydration', async () => {
  let yields = 0;
  const h = await navigationSearchHarness(50000, () => ({
    now: () => 0,
    yield: async () => {
      yields++;
    },
  }));
  const hydrate = vi.spyOn(h.search, 'resolveHits');
  try {
    await h.activateChild();
    await h.completed();
    expect(hydrate.mock.calls.every(([hits]) => hits.length <= 50)).toBe(true);
    expect(
      new Set(hydrate.mock.calls.flatMap(([hits]) => hits.map((hit) => hit.address.rootId))).size,
    ).toBeLessThan(100);
    expect(yields).toBeGreaterThan(300);
    expect(h.root.dataset['searchLogicalResults']).toBe('50000');
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
});

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
      h.query('needle');
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
      expect(h.root.dataset['searchLogicalResults']).toBe(surface === 'reveal' ? '2' : '1');
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
        expect(h.root.querySelector('.is-search-revealed')?.textContent).toContain('zzz');
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
    await h.activateChild();
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
