import { TFile } from 'obsidian';
import { afterEach, expect, it, vi } from 'vitest';
import type { TaskDtoV1 } from '../api';
import { compileQuery, compileQueryPathProof } from '../src/query/evaluateQuery';
import { taskSourceIgnoreQuery } from '../src/settings/taskStorageSettings';
import type { TaskSourceMetadata } from '../src/tasks/infrastructure/TaskIndex';
import { deferred, flushMicrotasks, seedTaskCache } from './helpers';
import { publicApiHarness, type PublicApiHarness } from './support/publicApiHarness';

const harnesses: PublicApiHarness[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const h of harnesses.splice(0)) h.dispose();
});
function policy(
  queryText = taskSourceIgnoreQuery({
    taskArchivePath: 'hidden.md',
    taskIgnoreQuery: '#private',
  }),
) {
  const query = compileQuery(queryText);
  return {
    excludeSource: (source: TaskSourceMetadata) =>
      query(source.filePath, source.tags, source.frontmatter),
    excludePath: compileQueryPathProof(queryText),
  };
}
async function setup(initialize = true) {
  const h = await publicApiHarness(
    {
      'tasks.md': '- [ ] Allowed 🆔 allowed\n',
      'hidden.md': '- [ ] Secret 🆔 allowed\n',
    },
    { initialize, index: policy() },
  );
  harnesses.push(h);
  return h;
}
async function allowedTask(h: PublicApiHarness): Promise<TaskDtoV1> {
  const result = await h.client().tasks.list({ path: 'tasks.md' });
  if (!result.ok || result.value.items[0] === undefined) throw new Error('Missing allowed task');
  return result.value.items[0];
}
function request(task: TaskDtoV1) {
  return {
    target: task.target,
    expectedRevision: task.revision,
    requestId: 'complete',
    expiresAt: Date.UTC(2026, 7, 1, 12, 5),
  };
}
async function permitsSibling(h: PublicApiHarness) {
  const client = h.client();
  expect(await client.ready()).toMatchObject({ ok: true });
  const task = await allowedTask(h);
  expect.soft(await client.tasks.list()).toMatchObject({ ok: true, value: { items: [task] } });
  expect.soft(await client.tasks.resolve({ authoredId: 'allowed' })).toMatchObject({
    ok: true,
    value: { type: 'found', task },
  });
  expect.soft(await client.tasks.list({ path: 'hidden.md' })).toMatchObject({
    ok: true,
    value: { items: [] },
  });
  expect.soft(await client.tasks.complete(request(task))).toMatchObject({
    ok: true,
    receipt: { effects: 'committed', original: { task: { status: 'done' } } },
  });
  expect.soft(await h.read('tasks.md')).toContain('- [x] Allowed');
  expect(await h.read('hidden.md')).toBe('- [ ] Secret 🆔 allowed\n');
}
it('permits scans, authored-ID resolution and strict completion after a path-excluded startup read fails', async () => {
  const h = await setup(false);
  const read = h.app.vault.cachedRead.bind(h.app.vault);
  vi.spyOn(h.app.vault, 'cachedRead').mockImplementation(async (file) => {
    if (file.path === 'hidden.md') throw new Error('unreadable secret');
    return read(file);
  });
  await h.index.initialize();
  await permitsSibling(h);
});
it('permits the healthy sibling while a path-excluded policy refresh is pending', async () => {
  const h = await setup();
  const pending = deferred<string>();
  const read = h.app.vault.cachedRead.bind(h.app.vault);
  vi.spyOn(h.app.vault, 'cachedRead').mockImplementation((file) =>
    file.path === 'hidden.md' ? pending.promise : read(file),
  );
  const current = policy();
  const refresh = h.index.refreshSourceExclusion(current.excludeSource, current.excludePath);
  try {
    await flushMicrotasks();
    await permitsSibling(h);
  } finally {
    pending.resolve('- [ ] Secret 🆔 allowed\n');
    await refresh;
  }
});

async function blocksSibling(h: PublicApiHarness) {
  const client = h.client();
  const task = await allowedTask(h);
  expect(await client.tasks.list()).toMatchObject({
    ok: false,
    error: { code: 'INCOMPLETE_READ' },
  });
  expect(await client.tasks.resolve({ authoredId: 'allowed' })).toMatchObject({
    ok: false,
    error: { code: 'INCOMPLETE_READ' },
  });
  expect(await client.tasks.complete(request(task))).toMatchObject({
    ok: false,
    error: { code: 'INCOMPLETE_READ' },
    effects: 'unchanged',
    recovery: 'reread',
  });
  expect(await h.read('tasks.md')).toBe('- [ ] Allowed 🆔 allowed\n');
}
it.each(['pending', 'failed'] as const)(
  'keeps %s relevant sources incomplete despite stale excluded tags/frontmatter',
  async (phase) => {
    for (const query of [
      '#private',
      'private=true',
      '"hidden.md" AND #private',
      'NOT #public',
      'NOT public=true',
      '"other.md" OR #private',
    ]) {
      const current = policy(`(${query}) AND NOT "tasks.md"`);
      const content = '---\nprivate: true\n---\n- [ ] Secret #private 🆔 allowed\n';
      const h = await publicApiHarness(
        {
          'tasks.md': '- [ ] Allowed 🆔 allowed\n',
          'hidden.md': content,
        },
        { index: current },
      );
      harnesses.push(h);
      // The accepted source and the host cache both claim exclusion, but new bytes are unavailable.
      seedTaskCache(h.app, 'hidden.md', [{ task: ' ', parent: -1, line: 3 }], {
        private: true,
        tags: ['private'],
      });
      const pending = deferred<void>();
      const read = h.app.vault.cachedRead.bind(h.app.vault);
      vi.spyOn(h.app.vault, 'cachedRead').mockImplementation(async (file) => {
        if (file.path !== 'hidden.md') return read(file);
        if (phase === 'pending') await pending.promise;
        throw new Error('unreadable current bytes');
      });
      const refresh = h.index.refreshSourceExclusion(current.excludeSource, current.excludePath);
      try {
        if (phase === 'failed') await refresh;
        else await flushMicrotasks();
        await blocksSibling(h);
      } finally {
        pending.resolve();
        await refresh;
      }
    }
  },
);
it('retains failed source health when policy widens to include its path', async () => {
  const h = await setup(false);
  const read = h.app.vault.cachedRead.bind(h.app.vault);
  vi.spyOn(h.app.vault, 'cachedRead').mockImplementation(async (file) => {
    if (file.path === 'hidden.md') throw new Error('unreadable');
    return read(file);
  });
  await h.index.initialize();
  expect(await h.client().tasks.list()).toMatchObject({ ok: true });
  const refresh = h.index.refreshSourceExclusion(undefined);
  expect(h.reads.coverage()).toMatchObject({ type: 'error', reason: 'incomplete' });
  await refresh;
  await blocksSibling(h);
});
it('rechecks path exclusion after an unhealthy file moves out of and back into the excluded path', async () => {
  const h = await setup(false);
  const read = h.app.vault.cachedRead.bind(h.app.vault);
  vi.spyOn(h.app.vault, 'cachedRead').mockImplementation(async (file) => {
    if (file.path !== 'tasks.md') throw new Error('unreadable');
    return read(file);
  });
  await h.index.initialize();
  const file = h.app.vault.getAbstractFileByPath('hidden.md');
  if (!(file instanceof TFile)) throw new Error('Missing hidden source');
  expect(await h.client().tasks.list()).toMatchObject({ ok: true });
  await h.app.vault.rename(file, 'visible.md');
  await flushMicrotasks();
  await blocksSibling(h);
  await h.app.vault.rename(file, 'hidden.md');
  await flushMicrotasks();
  const client = h.client('after-rename');
  expect(await client.tasks.list()).toMatchObject({
    ok: true,
    value: { items: [{ title: 'Allowed' }] },
  });
  expect(await client.tasks.complete(request(await allowedTask(h)))).toMatchObject({ ok: true });
});
it.each(['pending', 'failed'] as const)(
  'does not infer path proof from an arbitrary predicate for a %s source',
  async (phase) => {
    const h = await setup();
    const pending = deferred<void>();
    const read = h.app.vault.cachedRead.bind(h.app.vault);
    vi.spyOn(h.app.vault, 'cachedRead').mockImplementation(async (file) => {
      if (file.path !== 'hidden.md') return read(file);
      if (phase === 'pending') await pending.promise;
      throw new Error('unreadable');
    });
    const refresh = h.index.refreshSourceExclusion((source) => source.filePath === 'hidden.md');
    try {
      if (phase === 'failed') await refresh;
      else await flushMicrotasks();
      await blocksSibling(h);
    } finally {
      pending.resolve();
      await refresh;
    }
  },
);

it.each(['pending', 'failed'] as const)(
  'withholds an issued target after path exclusion while its source is %s',
  async (phase) => {
    const h = await publicApiHarness({
      'tasks.md': '- [ ] Allowed 🆔 allowed\n',
      'hidden.md': '- [ ] Secret 🆔 allowed\n',
    });
    harnesses.push(h);
    const client = h.client();
    const before = await client.tasks.list({ path: 'hidden.md' });
    if (!before.ok || before.value.items[0] === undefined) throw new Error('Missing secret task');
    const hidden = before.value.items[0];
    const pending = deferred<void>();
    const read = h.app.vault.cachedRead.bind(h.app.vault);
    vi.spyOn(h.app.vault, 'cachedRead').mockImplementation(async (file) => {
      if (file.path !== 'hidden.md') return read(file);
      if (phase === 'pending') await pending.promise;
      throw new Error('unreadable');
    });
    const current = policy();
    const refresh = h.index.refreshSourceExclusion(current.excludeSource, current.excludePath);
    try {
      if (phase === 'failed') await refresh;
      else await flushMicrotasks();
      expect(await client.tasks.get(hidden.target)).toMatchObject({
        ok: false,
        error: { code: 'TARGET_UNAVAILABLE' },
      });
      await permitsSibling(h);
    } finally {
      pending.resolve();
      await refresh;
    }
  },
);
