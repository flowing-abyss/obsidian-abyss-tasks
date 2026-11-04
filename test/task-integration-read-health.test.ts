import { TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StatusCatalog } from '../src/tasks/domain/StatusCatalog';
import { TaskIntegrationReadState } from '../src/tasks/infrastructure/TaskIntegrationReadState';
import { deferred, flushMicrotasks } from './helpers';
import { publicApiHarness, type PublicApiHarness } from './support/publicApiHarness';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
async function harness(...args: Parameters<typeof publicApiHarness>) {
  const h = await publicApiHarness(...args);
  cleanups.push(() => {
    h.dispose();
  });
  return h;
}
function file(h: PublicApiHarness, path: string): TFile {
  const result = h.app.vault.getAbstractFileByPath(path);
  if (!(result instanceof TFile)) throw new Error('Missing test source');
  return result;
}

describe('integration source health', () => {
  it('does not clear a newer failure with an obsolete acquisition', () => {
    const state = new TaskIntegrationReadState();
    state.setLifecycle('ready');
    const source = {};
    const old = state.begin('empty.md', source, {});
    const current = state.begin('empty.md', source, {});
    state.fail(current);
    state.accept(old);
    expect(state.coverage()).toMatchObject({ type: 'error', reason: 'incomplete' });
  });

  it('tracks pending verification and failed empty sources independently of UI task count', async () => {
    const h = await harness({ 'empty.md': '', 'tasks.md': '- [ ] Task' });
    h.index.installCommittedContent('empty.md', '');
    const pending = deferred<void>();
    vi.spyOn(h.app.vault, 'read').mockImplementationOnce(async () => {
      await pending.promise;
      throw new Error('secret read detail');
    });
    const before = h.reads.capture();
    h.app.metadataCache.trigger('changed', file(h, 'empty.md'), 'unconfirmed', {});
    expect(h.index.list({ filePath: 'empty.md' })).toEqual([]);
    expect(h.reads.coverage()).toMatchObject({ type: 'error', reason: 'incomplete' });
    expect(h.reads.capture().generation).toBeGreaterThan(before.generation);
    expect(h.reads.coverage({ path: 'tasks.md' }).type).toBe('ok');
    expect(h.reads.coverage({ folder: 'unrelated' }).type).toBe('ok');
    pending.resolve();
    await flushMicrotasks();
    expect(h.reads.coverage()).toMatchObject({ type: 'error', reason: 'incomplete' });
    await h.app.fileManager.trashFile(file(h, 'empty.md'));
    expect(h.reads.coverage().type).toBe('ok');
  });

  it('reports startup failure, retry, and disposal separately from incomplete coverage', async () => {
    const h = await harness({ 'empty.md': '' }, { initialize: false });
    expect(h.reads.coverage()).toMatchObject({ reason: 'not-ready' });
    vi.spyOn(h.app.vault, 'getMarkdownFiles').mockImplementationOnce(() => {
      throw new Error('startup');
    });
    await expect(h.index.initialize()).rejects.toThrow('startup');
    expect(h.reads.capture().lifecycle).toBe('failed');
    expect(h.reads.coverage()).toMatchObject({ reason: 'failed' });
    await h.index.initialize();
    expect(h.reads.coverage().type).toBe('ok');
    h.dispose();
    expect(h.reads.coverage()).toMatchObject({ reason: 'disposed' });
  });

  it('recovers from an unchanged-byte observation without changing ordinary list semantics', async () => {
    const h = await harness({ 'empty.md': '' });
    const read = vi.spyOn(h.app.vault, 'cachedRead').mockRejectedValueOnce(new Error('read'));
    await h.index.refreshSourceExclusion(undefined);
    expect(h.index.list()).toEqual([]);
    expect(h.reads.coverage()).toMatchObject({ reason: 'incomplete' });
    const failed = h.reads.capture();
    read.mockRestore();
    await h.external('empty.md', '');
    expect(h.reads.coverage().type).toBe('ok');
    expect(h.reads.capture().generation).toBeGreaterThan(failed.generation);
  });

  it('settles a confirmed committed echo but rejects conflicting unconfirmed bytes', async () => {
    const h = await harness({ 'empty.md': '' });
    h.index.installCommittedContent('empty.md', '');
    h.app.metadataCache.trigger('changed', file(h, 'empty.md'), 'obsolete cache', {});
    await flushMicrotasks();
    expect(h.reads.coverage().type).toBe('ok');
    vi.spyOn(h.app.vault, 'read').mockResolvedValueOnce('neither accepted nor observed');
    h.app.metadataCache.trigger('changed', file(h, 'empty.md'), 'obsolete cache', {});
    await flushMicrotasks();
    expect(h.reads.coverage()).toMatchObject({ reason: 'incomplete' });
  });

  it('makes policy refresh incomplete synchronously even when task membership is unchanged', async () => {
    const h = await harness({ 'empty.md': '' });
    const pending = deferred<string>();
    vi.spyOn(h.app.vault, 'cachedRead').mockImplementationOnce(() => pending.promise);
    const prior = h.reads.capture();
    const refresh = h.index.refreshSourceExclusion(() => false);
    expect(h.reads.capture().scopeRevision).toBeGreaterThan(prior.scopeRevision);
    expect(h.reads.coverage()).toMatchObject({ reason: 'incomplete' });
    pending.resolve('');
    await refresh;
    expect(h.reads.coverage().type).toBe('ok');
  });

  it('registers atomically, isolates subscribers, and skips listeners removed during publication', () => {
    const state = new TaskIntegrationReadState();
    let unsubscribe = () => {};
    state.subscribe(() => {
      unsubscribe();
    });
    const observed = vi.fn();
    const registration = state.subscribe(observed);
    unsubscribe = registration.unsubscribe;
    expect(registration.state).toEqual(state.capture());
    state.setLifecycle('ready');
    expect(observed).not.toHaveBeenCalled();
  });

  it('carries failed health across rename and ignores replacement-file completions', () => {
    const state = new TaskIntegrationReadState();
    state.setLifecycle('ready');
    const source = {};
    const old = state.begin('old.md', source, {});
    state.fail(old);
    state.rename('old.md', 'new.md', source);
    expect(state.coverage({ path: 'old.md' }).type).toBe('ok');
    expect(state.coverage({ path: 'new.md' })).toMatchObject({ reason: 'incomplete' });
    const replacement = state.begin('new.md', {}, {});
    state.accept(old);
    state.remove('new.md', source);
    expect(state.coverage()).toMatchObject({ reason: 'incomplete' });
    state.accept(replacement);
    expect(state.coverage().type).toBe('ok');
  });
  it('keeps a late successful reload from overwriting a newer failed acquisition', async () => {
    const h = await harness({ 'empty.md': '' });
    const old = deferred<string>();
    const read = vi.spyOn(h.app.vault, 'cachedRead');
    read.mockImplementationOnce(() => old.promise);
    const first = h.index.refreshSourceExclusion(undefined);
    read.mockRejectedValueOnce(new Error('newer failed'));
    await h.index.refreshSourceExclusion(undefined);
    expect(h.reads.coverage()).toMatchObject({ reason: 'incomplete' });
    old.resolve('- [ ] Obsolete');
    await first;
    expect(h.index.list()).toEqual([]);
    expect(h.reads.coverage()).toMatchObject({ reason: 'incomplete' });
  });

  it('keeps empty startup read failures incomplete after initialization settles', async () => {
    const h = await harness({ 'empty.md': '', 'tasks.md': '- [ ] Task' }, { initialize: false });
    const gate = deferred<void>();
    const read = h.app.vault.cachedRead.bind(h.app.vault);
    vi.spyOn(h.app.vault, 'cachedRead').mockImplementation(async (target) => {
      if (target.path !== 'empty.md') return read(target);
      await gate.promise;
      throw new Error('read unavailable');
    });
    const initializing = h.index.initialize();
    await flushMicrotasks();
    expect(h.reads.coverage()).toMatchObject({ reason: 'not-ready' });
    gate.resolve();
    await initializing;
    expect(h.reads.capture().lifecycle).toBe('ready');
    expect(h.reads.coverage()).toMatchObject({ reason: 'incomplete' });
    expect(h.index.list().map((task) => task.title)).toEqual(['Task']);
  });

  it('does not let an obsolete verification clear a newer failure after a committed install', async () => {
    const h = await harness({ 'empty.md': '' });
    h.index.installCommittedContent('empty.md', '');
    const old = deferred<string>();
    const read = vi.spyOn(h.app.vault, 'read').mockImplementationOnce(() => old.promise);
    h.app.metadataCache.trigger('changed', file(h, 'empty.md'), 'old metadata', {});
    h.index.installCommittedContent('empty.md', '');
    expect(h.reads.coverage().type).toBe('ok');
    read.mockRejectedValueOnce(new Error('new read failed'));
    h.app.metadataCache.trigger('changed', file(h, 'empty.md'), 'new metadata', {});
    await flushMicrotasks();
    old.resolve('');
    await flushMicrotasks();
    expect(h.reads.coverage()).toMatchObject({ reason: 'incomplete' });
    await h.external('empty.md', '');
    expect(h.reads.coverage().type).toBe('ok');
  });

  it('carries unresolved health through a real rename until the new-path read settles', async () => {
    const h = await harness({ 'old.md': '' });
    vi.spyOn(h.app.vault, 'cachedRead').mockRejectedValueOnce(new Error('failed'));
    await h.index.refreshSourceExclusion(undefined);
    const pending = deferred<string>();
    vi.spyOn(h.app.vault, 'cachedRead').mockImplementationOnce(() => pending.promise);
    await h.app.vault.rename(file(h, 'old.md'), 'new.md');
    expect(h.reads.coverage({ path: 'old.md' }).type).toBe('ok');
    expect(h.reads.coverage({ path: 'new.md' })).toMatchObject({ reason: 'incomplete' });
    pending.resolve('');
    await flushMicrotasks();
    expect(h.reads.coverage().type).toBe('ok');
  });

  it('advances effective status semantics independently of ordinary list snapshots', async () => {
    const h = await harness({ 'tasks.md': '- [ ] Task' });
    const before = h.reads.capture();
    const catalog = new StatusCatalog([
      { id: 'open', symbol: ' ', type: 'cancelled', defaultForType: true },
    ]);
    h.index.setStatusCatalog(catalog);
    expect(h.reads.capture().semanticsRevision).toBeGreaterThan(before.semanticsRevision);
    expect(h.index.list()[0]?.status).toBe('open');
    const same = h.reads.capture();
    h.index.setStatusCatalog(catalog);
    expect(h.reads.capture()).toEqual(same);
  });

  it('terminates safely on counter exhaustion and reports only sanitized diagnostics', () => {
    const state = new TaskIntegrationReadState();
    state.setLifecycle('ready');
    Object.defineProperty(state, 'observation_abyssPrivate', {
      value: { ...state.capture(), revision: Number.MAX_SAFE_INTEGER },
      writable: true,
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const events: string[] = [];
    state.subscribe((event) => events.push(event.observation.lifecycle));
    state.begin('secret-path.md', {}, {});
    expect(state.coverage()).toMatchObject({ reason: 'failed' });
    expect(state.capture().revision).toBe(Number.MAX_SAFE_INTEGER);
    state.setLifecycle('ready');
    expect(state.capture().lifecycle).toBe('failed');
    expect(events).toEqual(['failed']);
    expect(error.mock.calls).toEqual([['[abyss-tasks] Integration observation counter exhausted']]);
    state.dispose();
    expect(state.capture().lifecycle).toBe('disposed');
  });

  it('isolates listener exceptions and stops publication after disposal', () => {
    const state = new TaskIntegrationReadState();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    state.subscribe(() => {
      throw new Error('secret subscriber detail');
    });
    const observed = vi.fn();
    const subscription = state.subscribe(observed);
    state.setLifecycle('ready');
    expect(observed).toHaveBeenCalledTimes(1);
    expect(subscription.state.lifecycle).toBe('initializing');
    expect(error.mock.calls).toEqual([['[abyss-tasks] Integration read subscriber failed']]);
    subscription.unsubscribe();
    state.dispose();
    state.setLifecycle('ready');
    expect(observed).toHaveBeenCalledTimes(1);
  });
  it('prunes an accepted empty source missing after an attempt without delete ownership', async () => {
    const h = await harness({ 'empty.md': '' }, { initialize: false });
    h.index.installCommittedContent('empty.md', '');
    vi.spyOn(h.app.vault, 'on').mockImplementationOnce(() => {
      throw new Error('registration failed');
    });
    await expect(h.index.initialize()).rejects.toThrow('registration failed');
    await h.app.fileManager.trashFile(file(h, 'empty.md'));
    await h.index.initialize();
    expect(h.reads.coverage().type).toBe('ok');
    expect(h.index.list()).toEqual([]);
  });

  it('keeps preview projections from settling a failed source', async () => {
    const h = await harness({ 'empty.md': '' });
    vi.spyOn(h.app.vault, 'cachedRead').mockRejectedValueOnce(new Error('read failed'));
    await h.index.refreshSourceExclusion(undefined);
    h.index.previewContent('empty.md', '- [ ] Preview');
    expect(h.reads.coverage()).toMatchObject({ reason: 'incomplete' });
    expect(h.index.list()).toEqual([]);
  });

  it('ignores a late acquisition for a deleted file after its replacement is healthy', async () => {
    const h = await harness({ 'empty.md': '' });
    h.index.installCommittedContent('empty.md', '');
    const pending = deferred<string>();
    vi.spyOn(h.app.vault, 'read').mockImplementationOnce(() => pending.promise);
    h.app.metadataCache.trigger('changed', file(h, 'empty.md'), 'old source', {});
    await h.app.fileManager.trashFile(file(h, 'empty.md'));
    await h.app.vault.create('empty.md', '- [ ] Replacement');
    await flushMicrotasks();
    pending.resolve('old source');
    await flushMicrotasks();
    expect(h.reads.coverage().type).toBe('ok');
    expect(h.index.list()[0]?.title).toBe('Replacement');
  });
  it('publishes rename health only with relocated canonical data and blocks reentrant reads during relocation', async () => {
    const h = await harness({ 'old.md': '- [ ] Task' });
    const acceptedPaths: string[][] = [];
    const check = (): void => {
      if (h.reads.coverage().type === 'ok')
        acceptedPaths.push(h.index.list().map((task) => task.source.filePath));
    };
    h.reads.subscribe(check);
    h.index.searchSource().subscribe(check);
    await h.app.vault.rename(file(h, 'old.md'), 'new.md');
    expect(acceptedPaths.length).toBeGreaterThan(0);
    expect(acceptedPaths.every((paths) => paths.length === 1 && paths[0] === 'new.md')).toBe(true);
    expect(h.reads.coverage().type).toBe('ok');
  });

  it('keeps event revisions ordered through reentrant health publication', () => {
    const state = new TaskIntegrationReadState();
    state.setLifecycle('ready');
    let nested = false;
    state.subscribe(() => {
      if (nested) return;
      nested = true;
      state.begin('second.md', {}, {});
    });
    const revisions: number[] = [];
    state.subscribe((event) => {
      revisions.push(event.observation.revision);
    });
    state.begin('first.md', {}, {});
    expect(revisions).toEqual([...revisions].sort((a, b) => a - b));
    expect(revisions).toHaveLength(2);
  });
  it('does not deliver held events to a subscription registered after their observation', () => {
    const state = new TaskIntegrationReadState();
    state.setLifecycle('ready');
    const observed = vi.fn();
    state.batch(() => {
      state.begin('first.md', {}, {});
      state.subscribe(observed);
    });
    expect(observed).not.toHaveBeenCalled();
    state.begin('second.md', {}, {});
    expect(observed).toHaveBeenCalledTimes(1);
  });

  it('owns duplicate callback registrations independently', () => {
    const state = new TaskIntegrationReadState();
    const observed = vi.fn();
    const first = state.subscribe(observed);
    state.subscribe(observed);
    first.unsubscribe();
    state.setLifecycle('ready');
    expect(observed).toHaveBeenCalledTimes(1);
  });
  it('keeps verified committed echoes incomplete after an empty UI failure until accepted recovery', async () => {
    const h = await harness({ 'tasks.md': '- [ ] Task' });
    h.index.installCommittedContent('tasks.md', '- [ ] Task');
    vi.spyOn(h.app.vault, 'cachedRead').mockRejectedValueOnce(new Error('read failed'));
    await h.index.refreshSourceExclusion(undefined);
    expect(h.index.list()).toEqual([]);
    expect(h.reads.coverage()).toMatchObject({ reason: 'incomplete' });
    h.app.metadataCache.trigger('changed', file(h, 'tasks.md'), 'obsolete cache', {});
    await flushMicrotasks();
    expect(h.reads.coverage()).toMatchObject({ reason: 'incomplete' });
    expect(h.index.list()).toEqual([]);
    await h.external('tasks.md', '- [ ] Task');
    expect(h.reads.coverage().type).toBe('ok');
    expect(h.index.list()[0]?.title).toBe('Task');
  });

  it('ignores a stale delete event for an already replaced file identity', async () => {
    const h = await harness({ 'tasks.md': '- [ ] Old' });
    const old = file(h, 'tasks.md');
    await h.app.fileManager.trashFile(old);
    await h.app.vault.create('tasks.md', '- [ ] Replacement');
    await flushMicrotasks();
    h.app.vault.trigger('delete', old);
    expect(h.reads.coverage().type).toBe('ok');
    expect(h.index.list()[0]?.title).toBe('Replacement');
  });
});
