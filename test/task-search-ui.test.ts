import { MarkdownRenderer } from 'obsidian';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { deferred, expectDefined, flushMicrotasks, useRealMoment } from './helpers';
import { mountCanonicalSearchUi } from './support/taskSearchUiHarness';
useRealMoment();
afterEach(() => vi.restoreAllMocks());
it('bounds mounted pages and reaches every match without full list reads', async () => {
  const h = await mountCanonicalSearchUi(
    { 'a.md': Array.from({ length: 101 }, (_, i) => `- [ ] needle ${i}`).join('\n') },
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
    expect(h.root.querySelectorAll('.abyss-task-card')).toHaveLength(50);
    expect(h.root.dataset['searchLogicalResults']).toBe('101');
    expectDefined(h.root.querySelector<HTMLButtonElement>('[aria-label="Next page"]')).click();
    await h.completed();
    expect(h.root.querySelectorAll('.abyss-task-card')).toHaveLength(50);
    expectDefined(h.root.querySelector<HTMLButtonElement>('[aria-label="Next page"]')).click();
    await h.completed();
    expect(h.root.querySelectorAll('.abyss-task-card')).toHaveLength(1);
    expect(h.root.textContent).toContain('needle 100');
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

it('clears Tasks selection on page/query/sort changes without losing the inspector root', async () => {
  const h = await mountCanonicalSearchUi(
    { 'a.md': Array.from({ length: 101 }, (_, i) => `- [ ] needle ${i}`).join('\n') },
    structuredClone(DEFAULT_SETTINGS),
    'tasks',
  );
  try {
    h.query('needle');
    await h.completed();
    const cards = () => [...h.root.querySelectorAll<HTMLElement>('.abyss-task-card')];
    expectDefined(cards()[0]).click();
    const inspector = h.state.get('taskStack');
    for (const card of cards().slice(0, 2))
      card.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }));
    expect(h.root.querySelectorAll('.abyss-multi-selected')).toHaveLength(2);
    expectDefined(h.root.querySelector<HTMLButtonElement>('[aria-label="Next page"]')).click();
    await h.completed();
    expect(h.root.querySelectorAll('.abyss-multi-selected')).toHaveLength(0);
    const execute = vi.spyOn(h.tasks, 'execute');
    await h.panel['taskCommands_abyssPrivate'].deleteBulkTasks([]);
    expect(execute).not.toHaveBeenCalled();
    expect(h.root.textContent).toContain('Selection cleared');
    expect(h.state.get('taskStack')).toEqual(inspector);
    const last = expectDefined(cards()[cards().length - 1]);
    last.click();
    last.focus();
    last.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }),
    );
    expect(h.root.querySelectorAll('.abyss-multi-selected')).toHaveLength(1);
    expectDefined(h.root.querySelector<HTMLButtonElement>('[aria-label="Previous page"]')).click();
    await h.completed();
    expect(h.root.querySelectorAll('.abyss-multi-selected')).toHaveLength(0);
    h.state.set('centerListViewState', {
      ...h.state.get('centerListViewState'),
      groupBy: 'priority',
    });
    await h.completed();
    expect(h.root.querySelectorAll('.abyss-task-card')).toHaveLength(50);
    expect(h.root.querySelector('.abyss-group-header')?.textContent).toContain('101');
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
    { 'a.md': '- [ ] needle #work\n- [ ] needle #home' },
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
    expect(h.root.querySelector('.abyss-filter-chip')?.textContent).toContain('#work');
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
    expect(h.root.querySelectorAll('.abyss-task-card')).toHaveLength(0);
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
    expect(h.root.textContent).toContain('2 occurrences');
    for (const card of cards)
      card.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }));
    const selected = h.panel['selectedTasksInVisualOrder_abyssPrivate']();
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
