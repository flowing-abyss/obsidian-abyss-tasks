import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { TaskSearchError } from '../src/tasks';
import { deferred, expectDefined, useRealMoment } from './helpers';
import { mountCanonicalSearchUi } from './support/taskSearchUiHarness';

useRealMoment();
afterEach(() => vi.restoreAllMocks());

it('refreshes the same query when a committed edit retires an opening cursor before generation joins', async () => {
  const original =
    '- [ ] needle old 📅 2026-10-12 #work\n' +
    '  - > <font color="#ff0000">Keep authored HTML</font>\n' +
    '  - [ ] needle child #nested';
  const untouched = '- [ ] unrelated 🆔 stable\n  - > Keep this description';
  const h = await mountCanonicalSearchUi(
    { 'a.md': original, 'b.md': untouched },
    structuredClone(DEFAULT_SETTINGS),
  );
  const entered = deferred<void>();
  const gate = deferred<void>();
  const failures: Array<{ code: string; aborted: boolean }> = [];
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await h.search.prepare(new AbortController().signal);
    const backend = expectDefined(h.backends[0]);
    const openBackend = backend.open.bind(backend);
    let held = false;
    vi.spyOn(backend, 'open').mockImplementation(async (...args) => {
      const cursor = await openBackend(...args);
      if (!held) {
        held = true;
        entered.resolve();
        await gate.promise;
      }
      return cursor;
    });
    const openService = h.search.open.bind(h.search);
    vi.spyOn(h.search, 'open').mockImplementation(async (...args) => {
      try {
        return await openService(...args);
      } catch (error) {
        if (error instanceof TaskSearchError)
          failures.push({ code: error.code, aborted: args[1].aborted });
        throw error;
      }
    });

    h.query('needle');
    await entered.promise;
    const task = expectDefined(h.index.list({ filePath: 'a.md' })[0]);
    const result = await h.tasks.execute({
      type: 'patch',
      target: { type: 'task', ref: task.ref },
      patch: { markdownTitle: { type: 'set', value: 'needle updated' } },
    });
    expect(result.type).toBe('ok');
    await vi.waitFor(() => {
      expect(failures).toEqual([{ code: 'stale', aborted: false }]);
    });
    gate.resolve();

    await h.completed();
    expect(h.root.dataset['searchLogicalResults']).toBe('1');
    expect(h.root.querySelector('.abyss-task-title')?.textContent).toContain('updated');
    expect(h.root.textContent).toContain('needle child');
    expect(h.root.querySelector('.abyss-task-title')?.textContent).not.toContain('old');
    expect(log).not.toHaveBeenCalled();
    expect(h.diagnostics).toEqual([]);
    expect(backend.searchCalls).toBe(2);
    expect(h.backends).toHaveLength(1);
    expect(h.state.get('searchQuery')).toBe('needle');
    expect(h.index.listNodes({ filePath: 'a.md' })).toHaveLength(2);
    expect(await h.app.vault.read(expectDefined(h.app.vault.getFileByPath('a.md')))).toBe(
      '- [ ] needle updated 📅 2026-10-12 #work\n' +
        '  - > <font color="#ff0000">Keep authored HTML</font>\n' +
        '  - [ ] needle child #nested',
    );
    expect(await h.app.vault.read(expectDefined(h.app.vault.getFileByPath('b.md')))).toBe(
      untouched,
    );
  } finally {
    gate.resolve();
    h.dispose();
  }
});
