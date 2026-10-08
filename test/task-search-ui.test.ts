import { MarkdownRenderer, Menu } from 'obsidian';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { SettingsPersistenceCoordinator } from '../src/settings/persistence';
import { deferred, expectDefined, flushMicrotasks, methodOf, useRealMoment } from './helpers';
import { taskCardMountBound } from './support/taskPanelViewport';
import { mountCanonicalSearchUi } from './support/taskSearchUiHarness';
import { taskViewportOwner } from './support/taskViewportOwner';
useRealMoment();
afterEach(() => vi.restoreAllMocks());
it('reaches the logical end through bounded mounts without retrieving on scroll', async () => {
  const h = await mountCanonicalSearchUi(
    { 'a.md': Array.from({ length: 1200 }, (_, i) => `- [ ] needle ${i}`).join('\n') },
    structuredClone(DEFAULT_SETTINGS),
  );
  try {
    vi.spyOn(h.index, 'list').mockImplementation(() => {
      throw new Error('Full list clone');
    });
    vi.spyOn(h.index, 'listNodes').mockImplementation(() => {
      throw new Error('Full node clone');
    });
    h.query('needle');
    await h.completed();
    expect(h.root.querySelectorAll('.abyss-task-card').length).toBeGreaterThan(0);
    expect(h.root.querySelectorAll('.abyss-task-card').length).toBeLessThanOrEqual(
      taskCardMountBound(h.root, 1),
    );
    expect(h.root.dataset['searchLogicalResults']).toBe('1200');
    expect(h.root.querySelector('[aria-label="Next page"]')).toBeNull();
    const before = h.backends.reduce((sum, backend) => sum + backend.searchCalls, 0);
    const scroll = expectDefined(h.root.querySelector<HTMLElement>('.abyss-center-scroll'));
    scroll.scrollTop = 1200 * 64;
    scroll.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => {
      expect(h.root.textContent).toContain('needle 1199');
    });
    expect(h.backends.reduce((sum, backend) => sum + backend.searchCalls, 0)).toBe(before);
  } finally {
    h.dispose();
  }
});
it.each([
  ['- [ ] needle', '- [ ] needle second', '2'],
  ['- [ ] other', '- [ ] needle', '1'],
])('joins drained generation across an accepted update (%s)', async (a, b, want) => {
  const h = await mountCanonicalSearchUi(
    { 'a.md': a, 'b.md': '' },
    structuredClone(DEFAULT_SETTINGS),
  );
  try {
    const entered = deferred<void>(),
      gate = deferred<void>();
    const original = h.index.organization.bind(h.index);
    let paused = false;
    const requests: Array<{ expectedGeneration: number; roots?: readonly unknown[] }> = [];
    const observed: Array<{
      phase: string | undefined;
      generation: string | undefined;
      total: string | undefined;
    }> = [];
    const observer = new MutationObserver(() => {
      observed.push({
        phase: h.root.dataset['searchPhase'],
        generation: h.root.dataset['searchGeneration'],
        total: h.root.dataset['searchLogicalResults'],
      });
    });
    observer.observe(h.root, { attributes: true });
    vi.spyOn(h.index, 'organization').mockImplementation(async function* (request, signal) {
      requests.push(request);
      if (!paused) {
        paused = true;
        entered.resolve();
        await gate.promise;
      }
      yield* original(request, signal);
    });
    h.query('needle');
    await entered.promise;
    h.index.installCommittedContent('b.md', b);
    gate.resolve();
    await h.completed();
    expect(h.root.dataset['searchLogicalResults']).toBe(want);
    if (a.includes('other')) expect(requests[0]?.roots).toEqual([]);
    const g = h.root.dataset['searchGeneration'];
    expect(
      observed
        .filter((e) => e.phase === 'complete' && e.generation === g)
        .every((e) => e.total === want),
    ).toBe(true);
    observer.disconnect();
  } finally {
    h.dispose();
  }
});
it('keeps hydrated rows pending until the actual Markdown renderer settles', async () => {
  const entered = deferred<HTMLElement>(),
    finish = deferred<void>();
  vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, _text, el) => {
    entered.resolve(el);
    await finish.promise;
    el.createEl('strong', { text: _text });
  });
  const h = await mountCanonicalSearchUi(
    { 'a.md': '- [ ] **budget**' },
    structuredClone(DEFAULT_SETTINGS),
  );
  try {
    h.query('budget');
    await entered.promise;
    await flushMicrotasks();
    expect(h.root.dataset['searchPhase']).toBe('pending');
    expect(h.root.getAttribute('aria-busy')).toBe('true');
    finish.resolve();
    await h.completed();
    expect(h.root.dataset['searchPhase']).toBe('complete');
  } finally {
    finish.resolve();
    h.dispose();
  }
});

it('retains exact selection on sort changes and retires changed group/query occurrences', async () => {
  const h = await mountCanonicalSearchUi(
    { 'a.md': Array.from({ length: 101 }, (_, i) => `- [ ] needle ${i}`).join('\n') },
    structuredClone(DEFAULT_SETTINGS),
    'tasks',
  );
  try {
    h.query('needle');
    await h.completed();
    const card = expectDefined(h.root.querySelector<HTMLElement>('.abyss-task-card'));
    card.click();
    const inspector = h.state.get('taskStack');
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true }));
    expect(h.panel['rowSelection_abyssPrivate'].size).toBe(101);
    const hydrate = vi.spyOn(h.index, 'resolveSearchHits');
    h.panel['updateSelectionVisuals_abyssPrivate']();
    expect(hydrate).not.toHaveBeenCalled();
    h.state.set('centerListViewState', {
      ...h.state.get('centerListViewState'),
      sortBy: { field: 'title', dir: 'asc' },
    });
    await h.completed();
    expect(h.panel['rowSelection_abyssPrivate'].size).toBe(101);
    h.state.set('centerListViewState', {
      ...h.state.get('centerListViewState'),
      groupBy: 'priority',
    });
    await h.completed();
    expect(h.panel['rowSelection_abyssPrivate'].size).toBe(0);
    expect(h.root.querySelector('.abyss-group-header')?.textContent).toContain('101');
    const grouped = expectDefined(h.root.querySelector<HTMLElement>('.abyss-task-card'));
    grouped.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true }));
    expect(h.panel['rowSelection_abyssPrivate'].size).toBe(101);
    h.query('needle 100');
    await h.completed();
    expect(h.panel['rowSelection_abyssPrivate'].size).toBe(0);
    expect(h.state.get('taskStack')).toEqual(inspector);
  } finally {
    h.dispose();
  }
});
it('renders inline failure and retries after actual Markdown rejection', async () => {
  const render = vi.spyOn(MarkdownRenderer, 'render').mockRejectedValue(new Error('render failed'));
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const h = await mountCanonicalSearchUi(
    { 'a.md': '- [ ] **budget**' },
    structuredClone(DEFAULT_SETTINGS),
  );
  try {
    h.query('budget');
    await expect(h.completed()).rejects.toThrow();
    expect(h.root.dataset['searchPhase']).toBe('error');
    expect(h.root.getAttribute('aria-busy')).toBe('false');
    const documents = vi.spyOn(h.source, 'documents');
    render.mockImplementation(async (_app, text, el) => {
      el.setText(text);
    });
    h.query('budget ');
    await h.completed();
    expect(h.root.dataset['searchPhase']).toBe('complete');
    expect(log).toHaveBeenCalled();
    expect(documents).not.toHaveBeenCalled();
  } finally {
    h.dispose();
  }
});
it('property chips filter canonical Search without saved-list writes or full clones', async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const before = structuredClone(settings.listViewStates);
  const h = await mountCanonicalSearchUi(
    { 'a.md': '- [ ] needle #needle-work\n- [ ] needle #needle-home' },
    settings,
  );
  try {
    h.query('needle');
    await h.completed();
    vi.spyOn(h.index, 'list').mockImplementation(() => {
      throw new Error('full list');
    });
    vi.spyOn(h.index, 'listNodes').mockImplementation(() => {
      throw new Error('full nodes');
    });
    expectDefined(h.root.querySelector<HTMLElement>('.abyss-task-tag')).click();
    await h.completed();
    expect(h.state.get('mode')).toBe('search');
    expect(h.root.querySelectorAll('.abyss-task-card')).toHaveLength(1);
    expect(h.root.querySelector('.abyss-filter-chip')?.textContent).toContain('#needle-work');
    expect(settings.listViewStates).toEqual(before);
  } finally {
    h.dispose();
  }
});

it('does not publish an old render after three frames and query replacement or disposal', async () => {
  const entered = deferred<HTMLElement>(),
    finish = deferred<void>();
  vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, text, el) => {
    entered.resolve(el);
    await finish.promise;
    el.setText(text);
  });
  const h = await mountCanonicalSearchUi(
    { 'a.md': '- [ ] **budget**\n- [ ] other' },
    structuredClone(DEFAULT_SETTINGS),
  );
  try {
    h.query('budget');
    await entered.promise;
    for (let i = 0; i < 3; i++)
      await new Promise<void>((r) =>
        h.root.ownerDocument.defaultView?.requestAnimationFrame(() => {
          r();
        }),
      );
    expect(h.root.dataset['searchPhase']).toBe('pending');
    h.query('other');
    await h.completed();
    const request = h.root.dataset['searchRequest'];
    finish.resolve();
    await flushMicrotasks();
    expect(h.root.dataset['searchRequest']).toBe(request);
    expect(h.root.textContent).toContain('other');
    expect(h.root.textContent).not.toContain('budget');
  } finally {
    finish.resolve();
    h.dispose();
  }
});
it('prepares the real canonical graph before first badge and retries a semantic generation join', async () => {
  const h = await mountCanonicalSearchUi(
    { 'a.md': '- [ ] needle' },
    structuredClone(DEFAULT_SETTINGS),
  );
  try {
    const entered = deferred<void>(),
      gate = deferred<void>();
    const original = h.index.prepareDependencies.bind(h.index);
    let once = false;
    vi.spyOn(h.index, 'prepareDependencies').mockImplementation(async (g, signal) => {
      if (!once) {
        once = true;
        entered.resolve();
        await gate.promise;
      }
      await original(g, signal);
    });
    const summary = vi.spyOn(h.index, 'dependencySummary');
    h.query('needle');
    await entered.promise;
    expect(h.root.querySelector('.abyss-task-card[aria-busy="true"]')).not.toBeNull();
    expect(h.root.querySelector('.abyss-status-marker')).toBeNull();
    expect(summary).not.toHaveBeenCalled();
    h.index.setStatusCatalog(h.statusCatalog);
    gate.resolve();
    await h.completed();
    expect(h.root.querySelectorAll('.abyss-task-card')).toHaveLength(1);
    expect(summary).toHaveBeenCalled();
  } finally {
    h.dispose();
  }
});
it('reuses the plugin service through mode changes and aborts one panel without stopping another', async () => {
  const h = await mountCanonicalSearchUi(
    { 'a.md': '- [ ] needle' },
    structuredClone(DEFAULT_SETTINGS),
  );
  try {
    const source = h.source;
    const documents = vi.spyOn(source, 'documents');
    h.query('needle');
    await h.completed();
    const builds = documents.mock.calls.length;
    expect(builds).toBe(1);
    h.state.set('mode', 'tasks');
    expect(h.root.querySelector('.abyss-search-global')).toBeNull();
    h.state.set('mode', 'search');
    await h.completed();
    expect(documents.mock.calls).toHaveLength(builds);
    const firstAbort = new AbortController(),
      secondAbort = new AbortController();
    const first = h.search.open({ kind: 'roots', query: 'needle' }, firstAbort.signal);
    const second = h.search.open({ kind: 'nodes', query: 'needle' }, secondAbort.signal);
    firstAbort.abort();
    await expect(first).rejects.toThrow();
    const cursor = await second;
    expect((await h.search.read(cursor, 0, 30, secondAbort.signal)).hits).toHaveLength(1);
    h.search.release(cursor);
  } finally {
    h.dispose();
  }
});

it('duplicates outgoing occurrences with full counts and deduplicates the existing bulk command', async () => {
  const h = await mountCanonicalSearchUi(
    { 'a.md': '- [ ] needle [[Alice]] [[Bob]]' },
    structuredClone(DEFAULT_SETTINGS),
    'tasks',
  );
  try {
    h.state.set('selectedList', { type: 'project', path: 'a.md' });
    h.state.set('centerListViewState', {
      ...h.state.get('centerListViewState'),
      groupBy: 'outgoing-link',
    });
    h.query('needle');
    await h.completed();
    const cards = [...h.root.querySelectorAll<HTMLElement>('.abyss-task-card')];
    expect(cards).toHaveLength(2);
    expect(h.root.dataset['searchLogicalResults']).toBe('1');
    expect(h.root.querySelector('.abyss-search-count')).toBeNull();
    expect(h.root.querySelector('.abyss-search-footer')).toBeNull();
    for (const card of cards)
      card.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }));
    const targets = h.panel['taskMenuTargets_abyssPrivate']();
    const selected = (await targets.resolve(targets.signal)).map((entry) => entry.task);
    expect(selected).toHaveLength(1);
    const execute = vi.spyOn(h.tasks, 'execute').mockResolvedValue({
      type: 'io-error',
      cause: 'repository-error',
      contentState: 'unchanged',
    });
    await h.panel['taskCommands_abyssPrivate'].deleteBulkTasks(selected);
    expect(execute).toHaveBeenCalledTimes(1);
  } finally {
    h.dispose();
  }
});

it('keeps Search relevance and all-status reset transient while Tasks controls retain their owner', async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const before = structuredClone(settings.listViewStates);
  const h = await mountCanonicalSearchUi({ 'a.md': '- [ ] needle\n- [x] needle done' }, settings);
  try {
    h.query('needle');
    await h.completed();
    expect(h.root.querySelectorAll('.abyss-task-card')).toHaveLength(2);
    expectDefined(h.root.querySelector<HTMLButtonElement>('.abyss-view-state-btn')).click();
    const option = (text: string) =>
      expectDefined(
        [...h.root.querySelectorAll<HTMLButtonElement>('.abyss-view-state-option')].find((b) =>
          b.textContent.includes(text),
        ),
      );
    option('Relevance');
    option('Priority').click();
    await h.completed();
    expectDefined(h.root.querySelector<HTMLButtonElement>('.abyss-view-state-reset-btn')).click();
    await h.completed();
    expect(h.root.querySelectorAll('.abyss-task-card')).toHaveLength(2);
    expect(settings.listViewStates).toEqual(before);
  } finally {
    h.dispose();
  }
});

it('rejects an old organization after a status-only semantic generation changes with stable file handles', async () => {
  const h = await mountCanonicalSearchUi(
    { 'a.md': '- [ ] needle' },
    structuredClone(DEFAULT_SETTINGS),
  );
  const entered = deferred<void>(),
    gate = deferred<void>();
  const original = h.index.organization.bind(h.index);
  let paused = false,
    oldRejected = false;
  try {
    vi.spyOn(h.index, 'organization').mockImplementation(async function* (request, signal) {
      const old = !paused;
      if (old) {
        paused = true;
        entered.resolve();
        await gate.promise;
      }
      try {
        yield* original(request, signal);
      } catch (error) {
        if (old) oldRejected = true;
        throw error;
      }
    });
    h.query('needle');
    await entered.promise;
    h.index.setStatusCatalog(h.statusCatalog);
    gate.resolve();
    await h.completed();
    expect(oldRejected).toBe(true);
    expect(h.root.dataset['searchLogicalResults']).toBe('1');
  } finally {
    gate.resolve();
    h.dispose();
  }
});

it.each([
  {
    groupId: 'discovered:prefix:work',
    collision: false,
    want: 'needle',
    initial: 2,
    markdown: '- [ ] needle #work',
  },
  {
    groupId: 'discovered:prefix:WORK',
    collision: false,
    want: 'needle',
    initial: 2,
    markdown: '- [ ] needle #Work',
  },
  {
    groupId: 'discovered:prefix:work',
    collision: true,
    want: 'needle configured',
    initial: 1,
    markdown: '- [ ] needle #work',
  },
  {
    groupId: 'discovered:prefix:WORK::1',
    collision: true,
    want: 'needle',
    initial: 2,
    markdown: '- [ ] needle #work',
  },
  {
    groupId: 'discovered:prefix:work',
    collision: false,
    want: undefined,
    initial: 2,
    markdown: '- [ ] needle\n  - [ ] child #Work',
  },
] as const)(
  'Tasks filter retains canonical group $groupId (collision: $collision, $markdown)',
  async ({ groupId, collision, want, initial, markdown }) => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.tagGroups = collision
      ? [{ id: 'discovered:prefix:work', name: 'Configured', mode: 'manual', tags: ['#personal'] }]
      : [];
    const h = await mountCanonicalSearchUi(
      {
        'a.md': markdown,
        'b.md': '- [ ] unrelated #work/child',
        ...(collision ? { 'c.md': '- [ ] needle configured #personal' } : {}),
      },
      settings,
      'tasks',
    );
    try {
      h.state.set('selectedList', { type: 'group', groupId });
      expect(h.root.querySelectorAll('.abyss-task-card')).toHaveLength(initial);
      vi.spyOn(h.index, 'list').mockImplementation(() => {
        throw new Error('Full task clone');
      });
      vi.spyOn(h.index, 'listNodes').mockImplementation(() => {
        throw new Error('Full node clone');
      });
      h.query('needle');
      await h.completed();
      expect(h.root.dataset['searchLogicalResults']).toBe(want === undefined ? '0' : '1');
      const cards = h.root.querySelectorAll('.abyss-task-card');
      expect(cards).toHaveLength(want === undefined ? 0 : 1);
      expect(cards[0]?.querySelector('.abyss-task-title')?.textContent).toBe(want);
    } finally {
      h.dispose();
    }
  },
);

it.each(['outside-focus', 'query', 'source', 'migration'] as const)(
  'revokes delayed keyboard target authority after %s',
  async (reason) => {
    const h = await mountCanonicalSearchUi(
      { 'a.md': Array.from({ length: 1200 }, (_, n) => `- [ ] needle ${n}`).join('\n') },
      structuredClone(DEFAULT_SETTINGS),
      'tasks',
    );
    const held = deferred<void>();
    let migrated: ReturnType<typeof taskViewportOwner> | undefined;
    let outside: HTMLInputElement | undefined;
    try {
      h.query('needle');
      await h.completed();
      const acquire = h.index.resolveSearchHits.bind(h.index);
      const entered = deferred<void>();
      vi.spyOn(h.index, 'resolveSearchHits').mockImplementation(async (hits, signal) => {
        entered.resolve();
        await held.promise;
        return acquire(hits, signal);
      });
      h.panel['rowSelection_abyssPrivate'].collapseTo('a.md:999');
      h.root.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      await entered.promise;
      expect(h.state.get('taskStack')).toHaveLength(0);
      if (reason === 'outside-focus') {
        outside = document.body.createEl('input');
        outside.focus();
      }
      if (reason === 'query') h.query('different');
      if (reason === 'source') h.index.installCommittedContent('a.md', '- [ ] replacement needle');
      if (reason === 'migration') {
        migrated = taskViewportOwner();
        migrated.doc.body.append(h.root);
        h.panel.onWindowMigrated();
      }
      held.resolve();
      await flushMicrotasks();
      if (outside !== undefined) expect(document.activeElement).toBe(outside);
      expect(h.state.get('taskStack')).toHaveLength(0);
    } finally {
      held.resolve();
      h.dispose();
      migrated?.destroy();
      outside?.remove();
    }
  },
);

it('opens and focuses the exact ready unmounted keyboard destination', async () => {
  const h = await mountCanonicalSearchUi(
    { 'a.md': Array.from({ length: 1200 }, (_, n) => `- [ ] needle ${n}`).join('\n') },
    structuredClone(DEFAULT_SETTINGS),
    'tasks',
  );
  try {
    h.query('needle');
    await h.completed();
    h.panel['rowSelection_abyssPrivate'].collapseTo('a.md:999');
    h.root.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await vi.waitFor(() => {
      expect(h.state.get('taskStack')[0]?.title).toBe('needle 1000');
    });
    expect(document.activeElement).toBe(h.root.querySelector('[data-row-key="a.md:1000"]'));
  } finally {
    h.dispose();
  }
});

it('refreshes retained real cards for child-only status semantics without changing exact source addresses or rebuilding search', async () => {
  const h = await mountCanonicalSearchUi(
    { 'a.md': '- [ ] needle root\n  - [x] child' },
    structuredClone(DEFAULT_SETTINGS),
  );
  try {
    h.query('needle');
    await h.completed();
    const before = expectDefined(h.panel['taskSurface_abyssPrivate']?.search);
    const key = expectDefined(before.order.taskKeyAt(0));
    const address = before.order.task(key)?.address;
    const holder = expectDefined(h.root.querySelector<HTMLElement>('.abyss-task-card'));
    const hydrate = vi.spyOn(h.index, 'resolveSearchHits');
    const documents = vi.spyOn(h.source, 'documents');
    const backend = h.backends.map((backend) => ({
      backend,
      operations: backend.operations.length,
    }));
    h.statusCatalog.replace(
      h.statusCatalog
        .all()
        .map((rule) =>
          rule.symbol === 'x' ? { ...rule, type: 'todo', defaultForType: false } : rule,
        ),
    );
    h.index.setStatusCatalog(h.statusCatalog);
    await h.completed();
    const after = expectDefined(h.panel['taskSurface_abyssPrivate']?.search);
    expect(after.order.task(key)?.address).toEqual(address);
    expect(after.identity.semanticsRevision).toBe(before.identity.semanticsRevision + 1);
    expect(after.order.task(key)?.menu.status).toBe(before.order.task(key)?.menu.status);
    expect(h.root.querySelector('.abyss-task-card')).toBe(holder);
    expect(await after.rows.snapshot(key, new AbortController().signal)).toMatchObject({
      node: { subtasks: [{ status: 'open' }] },
    });
    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(documents).not.toHaveBeenCalled();
    for (const item of backend)
      expect(item.backend.operations.slice(item.operations).map((op) => op.type)).toEqual([
        'publish',
      ]);
  } finally {
    h.dispose();
  }
});

it('selects a Shift range across the complete compact order without selected-root hydration', async () => {
  const h = await mountCanonicalSearchUi(
    { 'a.md': Array.from({ length: 101 }, (_, n) => `- [ ] needle ${n}`).join('\n') },
    structuredClone(DEFAULT_SETTINGS),
    'tasks',
  );
  try {
    h.query('needle');
    await h.completed();
    const first = expectDefined(
      h.root.querySelector<HTMLElement>('.abyss-task-card[data-line="0"]'),
    );
    first.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }));
    const scroll = expectDefined(h.root.querySelector<HTMLElement>('.abyss-center-scroll'));
    scroll.scrollTop = 101 * 64;
    scroll.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => {
      expect(h.root.querySelector('.abyss-task-card[data-line="100"]')).not.toBeNull();
    });
    const hydrate = vi.spyOn(h.index, 'resolveSearchHits');
    expectDefined(
      h.root.querySelector<HTMLElement>('.abyss-task-card[data-line="100"]'),
    ).dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    expect(h.panel['rowSelection_abyssPrivate'].size).toBe(101);
    expect(h.root.querySelector('.abyss-selection-live')?.textContent).toContain('101');
    expect(hydrate).not.toHaveBeenCalled();
  } finally {
    h.dispose();
  }
});

it('restarts cancelled Markdown on a same-query filter refresh with the identical root', async () => {
  const h = await mountCanonicalSearchUi(
    { 'a.md': '- [ ] **needle**' },
    structuredClone(DEFAULT_SETTINGS),
    'tasks',
  );
  const held = deferred<void>(),
    entered = deferred<void>();
  const outcomes: string[] = [];
  const publish = h.panel['mountSearchRows_abyssPrivate'].bind(h.panel);
  vi.spyOn(h.panel, 'mountSearchRows_abyssPrivate').mockImplementation(async (...args) => {
    const outcome = await publish(...args);
    outcomes.push(outcome.type);
    return outcome;
  });
  const render = vi
    .spyOn(MarkdownRenderer, 'render')
    .mockImplementation(async (_app, text, holder) => {
      holder.createEl('strong', { text });
      entered.resolve();
      await held.promise;
    });
  const hydrate = vi.spyOn(h.index, 'resolveSearchHits');
  try {
    h.query('needle');
    await entered.promise;
    const card = expectDefined(h.root.querySelector('.abyss-task-card'));
    h.panel.refresh();
    held.resolve();
    await vi.waitFor(() => {
      expect(outcomes.length).toBeGreaterThanOrEqual(2);
    });
    expect({
      outcomes,
      phase: h.root.dataset['searchPhase'],
      renders: render.mock.calls.length,
    }).toEqual({ outcomes: ['cancelled', 'ready'], phase: 'complete', renders: 2 });
    expect(h.root.querySelector('.abyss-task-card')).toBe(card);
    const text = expectDefined(card.querySelector<HTMLElement>('strong'));
    text.tabIndex = 0;
    text.focus();
    h.panel.refresh();
    await vi.waitFor(() => {
      expect(outcomes).toEqual(['cancelled', 'ready', 'ready']);
    });
    expect(card.querySelector('strong')).toBe(text);
    expect(document.activeElement).toBe(text);
    expect(render).toHaveBeenCalledTimes(2);
    expect(hydrate).toHaveBeenCalledTimes(1);
  } finally {
    held.resolve();
    h.dispose();
  }
});

it('retires a hidden hydration failure quietly and resumes on native scroll', async () => {
  const h = await mountCanonicalSearchUi(
    { 'a.md': '- [ ] needle' },
    structuredClone(DEFAULT_SETTINGS),
  );
  const held = deferred<void>(),
    entered = deferred<void>();
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
  const hydrate = vi.spyOn(h.index, 'resolveSearchHits').mockImplementationOnce(async () => {
    entered.resolve();
    await held.promise;
    throw new Error('late hidden read failure');
  });
  try {
    h.query('needle');
    await entered.promise;
    const holder = expectDefined(h.root.querySelector<HTMLElement>('.abyss-task-card'));
    h.root.hide();
    held.resolve();
    await flushMicrotasks();
    await flushMicrotasks();
    expect({
      diagnostics: diagnostic.mock.calls.length,
      phase: h.root.dataset['searchPhase'],
    }).toEqual({ diagnostics: 0, phase: 'pending' });
    h.root.show();
    expectDefined(h.root.querySelector('.abyss-center-scroll')).dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => {
      expect(holder.textContent).toContain('needle');
    });
    expect(holder.isConnected).toBe(true);
    expect(holder.inert).toBe(false);
    expect(hydrate).toHaveBeenCalledTimes(2);
    expect(diagnostic).not.toHaveBeenCalled();
  } finally {
    held.resolve();
    h.dispose();
  }
});

it.each(['tasks', 'search'] as const)(
  'retains a focused compact %s recurrence editor across scroll and retires it on source replacement',
  async (mode) => {
    const h = await mountCanonicalSearchUi(
      {
        'a.md': '- [ ] needle first',
        'b.md': Array.from({ length: 120 }, (_, n) => `- [ ] needle ${n}`).join('\n'),
      },
      structuredClone(DEFAULT_SETTINGS),
      mode,
    );
    try {
      h.query('needle');
      await h.completed();
      const original = expectDefined(h.index.list({ filePath: 'a.md' })[0]);
      const card = expectDefined(h.root.querySelector<HTMLElement>('[data-file-path="a.md"]'));
      h.panel['openRecurrenceEditor_abyssPrivate'](card, original);
      const editor = expectDefined(
        document.querySelector<HTMLElement>('.abyss-recurrence-popover'),
      );
      await vi.waitFor(() => {
        expect(editor.contains(document.activeElement)).toBe(true);
      });
      const entry = expectDefined(
        editor.querySelector<HTMLInputElement>('.abyss-recurrence-interval'),
      );
      entry.focus();
      entry.value = '3';
      entry.dispatchEvent(new Event('input', { bubbles: true }));
      const input = expectDefined(
        editor.querySelector<HTMLInputElement>('.abyss-recurrence-interval'),
      );
      const scroll = expectDefined(h.root.querySelector<HTMLElement>('.abyss-center-scroll'));
      scroll.scrollTop = 120 * 64;
      scroll.dispatchEvent(new Event('scroll'));
      await vi.waitFor(() => {
        expect(h.root.textContent).toContain('needle 119');
      });
      expect(card.isConnected).toBe(true);
      expect(editor.isConnected).toBe(true);
      expect(document.activeElement).toBe(input);
      expect(input.value).toBe('3');
      h.index.installCommittedContent('a.md', '- [ ] needle replacement');
      await h.completed();
      expect(editor.isConnected).toBe(false);
      expect(card.isConnected).toBe(false);
      expect(document.activeElement).not.toBe(input);
      expect(scroll.scrollTop).toBeGreaterThan(0);
    } finally {
      h.dispose();
    }
  },
);

it('routes mounted Search task-menu tag actions to transient chips and returns menu focus to its button', async () => {
  const addItem = methodOf(Menu.prototype, 'addItem');
  vi.spyOn(Menu.prototype, 'addItem').mockImplementation(function (this: Menu, cb) {
    return addItem.call(this, (item) => {
      (item as unknown as { dom: HTMLElement }).dom = createDiv();
      cb(item);
    });
  });
  let menu: Menu | undefined;
  vi.spyOn(Menu.prototype, 'showAtMouseEvent').mockImplementation(function (this: Menu) {
    menu = this.setParentElement(document.body);
    return this;
  });
  const settings = structuredClone(DEFAULT_SETTINGS),
    before = structuredClone(settings);
  const h = await mountCanonicalSearchUi(
    {
      'a.md':
        '- [ ] needle Public #work\n- [ ] needle Private #work #private\n- [ ] needle Nested #work/deep',
    },
    settings,
  );
  const saveStatic = vi.fn(async () => {}),
    write = vi.fn(async () => {});
  const coordinator = new SettingsPersistenceCoordinator({
    loadStatic: async () => ({}),
    saveStatic,
    state: { path: 'state.json', exists: async () => false, read: async () => '', write },
  });
  const save = vi
    .spyOn(h.panel, 'onSaveViewState_abyssPrivate')
    .mockImplementation(() => coordinator.saveViewState(settings));
  const menuItems = () =>
    (
      expectDefined(menu) as unknown as {
        menuItems__: Array<{ title__: string; submenu: Menu | null; onClick__: () => void }>;
      }
    ).menuItems__;
  try {
    h.query('needle');
    await h.completed();
    const publicButton = expectDefined(
      h.root.querySelector<HTMLButtonElement>('button[aria-label="Task actions"]'),
    );
    publicButton.focus();
    publicButton.click();
    expectDefined(menu).hide();
    expect(document.activeElement).toBe(publicButton);
    const buttons = h.root.querySelectorAll<HTMLButtonElement>('button[aria-label="Task actions"]');
    expectDefined(buttons[1]).click();
    const exclusion = expectDefined(
      menuItems().find((item) => item.title__ === 'Exclude tag')?.submenu,
    );
    const choices = (
      exclusion as unknown as { menuItems__: Array<{ title__: string; onClick__: () => void }> }
    ).menuItems__;
    expectDefined(choices.find((item) => item.title__ === '#private')).onClick__();
    expectDefined(menu).hide();
    await h.completed();
    expect(h.root.dataset['searchLogicalResults']).toBe('2');
    expect(h.root.querySelector('.abyss-filter-chip-label')?.textContent).toBe('−#private');
    expectDefined(
      h.root.querySelector<HTMLButtonElement>('button[aria-label="Task actions"]'),
    ).click();
    expectDefined(menuItems().find((item) => item.title__ === 'Include tag')).onClick__();
    expectDefined(menu).hide();
    await h.completed();
    expect(h.root.dataset['searchLogicalResults']).toBe('1');
    expect(h.root.textContent).toContain('needle Public');
    expect(
      [...h.root.querySelectorAll('.abyss-filter-chip-label')].map((el) => el.textContent),
    ).toEqual(['−#private', '#work']);
    expect(settings).toEqual(before);
    expect(save).not.toHaveBeenCalled();
    expect(saveStatic).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(h.state.get('taskStack')).toEqual([]);
  } finally {
    h.dispose();
  }
});
