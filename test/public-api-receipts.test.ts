import { afterEach, expect, it, vi } from 'vitest';
import type { TaskApiContext } from '../src/integrations/TaskApiProvider';
import { TaskCursorRegistry } from '../src/integrations/TaskCursorRegistry';
import { TaskIdentityRegistry } from '../src/integrations/TaskIdentityRegistry';
import { TaskRequestRegistry } from '../src/integrations/TaskRequestRegistry';
import { createTaskApiMutations } from '../src/integrations/taskApiMutations';
import { createTaskApiReads, readError } from '../src/integrations/taskApiReads';
import { deferred, expectDefined, flushMicrotasks } from './helpers';
import { publicApiHarness, type PublicApiHarness } from './support/publicApiHarness';
const harnesses: PublicApiHarness[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const h of harnesses.splice(0)) h.dispose();
});
async function setup(content = '- [ ] Secret task\n') {
  const h = await publicApiHarness({ 'a.md': content });
  harnesses.push(h);
  const client = h.client();
  const found = await client.tasks.resolve({ source: { path: 'a.md', line: 0 } });
  if (!found.ok || found.value.type !== 'found') throw new Error('Missing fixture');
  return {
    h,
    client,
    input: {
      target: found.value.task.target,
      expectedRevision: found.value.task.revision,
      requestId: 'one',
      expiresAt: Date.UTC(2026, 7, 1, 12) + 300_000,
    },
  };
}
it('replays immutable historical values while current proof is retained', async () => {
  const { client, input } = await setup();
  const original = await client.tasks.complete(input);
  expect(original).toMatchObject({ ok: true, receipt: { original: { task: { status: 'done' } } } });
  const current = await client.tasks.get(input.target);
  if (!current.ok) throw new Error('Missing completed task');
  await client.tasks.toggleCompletion({
    ...input,
    requestId: 'two',
    expectedRevision: current.value.revision,
  });
  const replay = await client.tasks.complete(input);
  expect(replay).toEqual(original);
  expect(replay).not.toBe(original);
});
it.each(['exclude', 'edit'] as const)(
  'redacts replay after %s without mutating retained receipt',
  async (change) => {
    const { h, client, input } = await setup();
    const original = await client.tasks.complete(input);
    if (change === 'exclude') await h.index.refreshSourceExclusion(() => true);
    else await h.external('a.md', '- [ ] Other\n');
    const replay = await client.tasks.complete(input);
    expect(replay).toMatchObject({
      ok: true,
      receipt: {
        effects: 'committed',
        snapshots: 'redacted',
        warnings: [{ code: 'RESULT_SNAPSHOT_REDACTED', message: expect.any(String) as unknown }],
      },
    });
    expect(JSON.stringify(replay)).not.toMatch(/Secret task|a\.md/);
    expect(original).toMatchObject({
      ok: true,
      receipt: { original: { task: { title: 'Secret task' } } },
    });
  },
);
it.each([false, true])(
  'preserves proven recurrence facts across unload, early acceptance=%s',
  async (early) => {
    const { h, client, input } = await setup('- [ ] Repeat 🔁 every day 📅 2026-08-01\n');
    const hold = deferred<void>();
    const entered = deferred<void>();
    vi.spyOn(h.app.vault, 'process').mockImplementation(async (file, fn) => {
      const content = fn(await h.app.vault.read(file));
      // A real metadata acceptance can precede the writer promise settlement.
      if (early) h.index.installCommittedContent(file.path, content);
      entered.resolve();
      await hold.promise;
      await h.app.vault.modify(file, content);
      return content;
    });
    let accepted = 0;
    h.reads.subscribe((event) => {
      if (event.type === 'accepted') accepted++;
    });
    const pending = client.tasks.complete(input);
    await entered.promise;
    await flushMicrotasks();
    h.dispose();
    hold.resolve();
    expect(accepted).toBe(early ? 1 : 0);
    const result = await pending;
    expect(result).toMatchObject({
      receipt: {
        effects: 'committed',
        original: { target: input.target, state: 'retained' },
        next: { target: expect.any(String) as unknown },
        snapshots: 'unavailable',
      },
    });
    expect(result.receipt?.original.task).toBeUndefined();
    expect(result.receipt?.next?.task).toBeUndefined();
  },
);

it('omits source snapshots when policy excludes the source while the writer settles', async () => {
  const { h, client, input } = await setup();
  const process = h.app.vault.process.bind(h.app.vault);
  vi.spyOn(h.app.vault, 'process').mockImplementation(async (file, fn, options) => {
    const content = await process(file, fn, options);
    await h.index.refreshSourceExclusion(() => true);
    return content;
  });
  const result = await client.tasks.complete(input);
  expect(result).toMatchObject({
    ok: true,
    receipt: { effects: 'committed', original: { state: 'retained' }, snapshots: 'unavailable' },
  });
  expect(JSON.stringify(result)).not.toMatch(/Secret task|a\.md/);
});

// Compose the actual facade functions with a small real registry to reach capacity
// without constructing fifty thousand vault tasks. No index or writer decision is mocked.
async function bounded(content: string, maxTargets: number, line = 0) {
  const h = await publicApiHarness({ 'a.md': content });
  harnesses.push(h);
  const epoch = 'bounded';
  let time = Date.UTC(2026, 7, 1, 12);
  const now = () => time;
  const identities = new TaskIdentityRegistry({ epoch, now, maxTargets, idleTtlMs: 100 });
  h.reads.subscribe((event) => {
    if (event.type === 'accepted') identities.apply(event.change);
  });
  h.reads.activateOccurrences();
  const context: TaskApiContext = {
    reads: h.reads,
    identities,
    cursors: new TaskCursorRegistry({ epoch, now }),
    observation: (value) => ({ ...value, providerEpoch: epoch }),
    check: () => undefined,
    internal: () => readError('internal', 'INTERNAL_ERROR', 'Operation failed.'),
  };
  const tasks = {
    ...createTaskApiReads(context),
    ...createTaskApiMutations({
      api: context,
      mutations: h.service,
      requests: new TaskRequestRegistry({ epoch, now }),
      consumerId: 'test',
      epoch,
      isDisposed: () => false,
    }),
  };
  const selected = await tasks.resolve({ source: { path: 'a.md', line } });
  if (!selected.ok || selected.value.type !== 'found') throw new Error('Missing bounded fixture');
  return {
    h,
    tasks,
    identities,
    advance: () => {
      time += 1_000;
    },
    input: {
      target: selected.value.task.target,
      expectedRevision: selected.value.task.revision,
      requestId: 'bounded',
      expiresAt: now() + 300_000,
    },
  };
}
it('rejects recurring admission before writer execution when no next slot is available', async () => {
  const { h, tasks, input } = await bounded('- [ ] Repeat 🔁 every day\n', 1);
  const writer = vi.spyOn(h.app.vault, 'process');
  expect(await tasks.complete(input)).toMatchObject({
    ok: false,
    effects: 'unchanged',
    recovery: 'retry-same-request',
    error: { code: 'RESOURCE_LIMIT' },
  });
  expect(writer).not.toHaveBeenCalled();
});
it.each([false, true])(
  'reserves a mandatory next despite capacity pressure and lost proof=%s',
  async (loseProof) => {
    const { h, tasks, identities, input } = await bounded(
      '- [ ] Repeat 🔁 every day 📅 2026-08-01\n  - 2026-08-01T11:00:00Z →\n- [ ] Other\n',
      3,
    );
    let filled = false;
    h.reads.subscribe((event) => {
      if (event.type !== 'accepted' || filled) return;
      filled = true;
      const found = h.reads.page({}, 100);
      if (found.type !== 'ok') throw new Error('Missing accepted source');
      const other = found.value.nodes.find((node) => node.value.node.title === 'Other');
      if (other === undefined) throw new Error('Missing other');
      expect(identities.project(other, found.observation.semanticsRevision).ok).toBe(true);
      expect(identities.reserveNext()).toMatchObject({
        ok: false,
        error: { code: 'RESOURCE_LIMIT' },
      });
    });
    if (loseProof) {
      const process = h.app.vault.process.bind(h.app.vault);
      let calls = 0;
      vi.spyOn(h.app.vault, 'process').mockImplementation(async (file, fn, options) => {
        if (++calls === 2)
          await h.external('a.md', (await h.read('a.md')).replace('Repeat', 'Changed'));
        return process(file, fn, options);
      });
    }
    const result = await tasks.complete(input);
    expect(result).toMatchObject({
      ok: true,
      receipt: {
        effects: loseProof ? 'partial' : 'committed',
        next: { target: expect.any(String) as unknown },
      },
    });
    const next = expectDefined(expectDefined(result.receipt).next);
    expect(next.target).not.toBe(input.target);
    if (loseProof) expect(next.task).toBeUndefined();
    else expect(expectDefined(next.task).status).toBe('open');
  },
);
it('reuses a reentrantly projected next after a short timer changes its physical offset', async () => {
  const { h, tasks, identities, input } = await bounded(
    '- [ ] Repeat 🔁 every day 📅 2026-08-01\n  - 2026-08-01T11:59:30Z →\n  - 2026-08-01T11:00:00Z →\n',
    3,
  );
  let projected: string | undefined;
  h.reads.subscribe((event) => {
    if (event.type !== 'accepted' || projected !== undefined) return;
    const next = event.change.witnesses.find(
      (witness) => witness.kind === 'created' && witness.reason === 'recurrence',
    );
    if (next?.kind !== 'created') return;
    const read = h.reads.node(next.after);
    if (read.type !== 'ok') throw new Error('Missing accepted next');
    const identity = identities.project(read.value, read.observation.semanticsRevision);
    if (!identity.ok) throw new Error('Cannot project next');
    projected = identity.value.target;
  });
  const result = await tasks.complete(input);
  expect(projected).toBeDefined();
  expect(result).toMatchObject({
    ok: true,
    receipt: {
      next: { target: projected, task: { source: { line: 0 } } },
      warnings: [{ code: 'TRACKING_ENTRY_DISCARDED', message: expect.any(String) as unknown }],
    },
  });
  const final = result.receipt?.next;
  if (final === undefined) throw new Error('Missing next receipt');
  expect(await tasks.get(final.target)).toEqual({ ok: true, value: final.task });
});

it('preserves committed facts if final snapshot projection unexpectedly fails', async () => {
  const { h, client, input } = await setup();
  const node = h.reads.node.bind(h.reads);
  let calls = 0;
  vi.spyOn(h.reads, 'node').mockImplementation((address) => {
    if (++calls > 1) throw new Error('secret vault text');
    return node(address);
  });
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const result = await client.tasks.complete(input);
  expect(result).toMatchObject({
    ok: true,
    receipt: { effects: 'committed', snapshots: 'unavailable', original: { state: 'retained' } },
  });
  expect(JSON.stringify([result, error.mock.calls])).not.toContain('secret vault text');
});

it('redacts historical receipt values after a proven rename enters an excluded folder', async () => {
  const { h, client, input } = await setup();
  await h.index.refreshSourceExclusion((source) => source.filePath.startsWith('hidden/'));
  const result = await client.tasks.complete(input);
  expect(result.ok).toBe(true);
  const file = h.app.vault.getFileByPath('a.md');
  if (file === null) throw new Error('Missing source');
  await h.app.vault.createFolder('hidden');
  await h.app.vault.rename(file, 'hidden/a.md');
  const replay = await client.tasks.complete(input);
  expect(replay).toMatchObject({
    ok: true,
    receipt: { effects: 'committed', snapshots: 'redacted' },
  });
  expect(JSON.stringify(replay)).not.toMatch(/Secret task|a\.md|hidden/);
});
it('redacts first delivery when permission changes after receipt mapping', async () => {
  const { h, client, input } = await setup();
  const node = h.reads.node.bind(h.reads);
  let calls = 0;
  let refresh: Promise<void> | undefined;
  vi.spyOn(h.reads, 'node').mockImplementation((address) => {
    const result = node(address);
    if (++calls === 2)
      queueMicrotask(() => {
        refresh = h.index.refreshSourceExclusion(() => true);
      });
    return result;
  });
  const result = await client.tasks.complete(input);
  await refresh;
  expect(result).toMatchObject({
    ok: true,
    receipt: { effects: 'committed', snapshots: 'redacted' },
  });
  expect(JSON.stringify(result)).not.toMatch(/Secret task|a\.md/);
});

it('keeps historical effects when replay disclosure proof throws', async () => {
  const { h, client, input } = await setup();
  await client.tasks.complete(input);
  vi.spyOn(h.reads, 'canDisclose').mockImplementation(() => {
    throw new Error('secret vault text');
  });
  const replay = await client.tasks.complete(input);
  expect(replay).toMatchObject({
    ok: true,
    receipt: { effects: 'committed', snapshots: 'redacted' },
  });
  expect(JSON.stringify(replay)).not.toMatch(/Secret task|secret vault text|a\.md/);
});

it('retains the reserved next when final parent DTO allocation exhausts capacity', async () => {
  const { h, tasks, identities, input, advance } = await bounded(
    '- [ ] Root\n  - [ ] Repeat 🔁 every day 📅 2026-08-01\n- [ ] Other\n',
    3,
    1,
  );
  let filled = false;
  h.reads.subscribe((event) => {
    if (event.type !== 'accepted' || filled) return;
    filled = true;
    advance();
    const page = h.reads.page({}, 100);
    if (page.type !== 'ok') throw new Error('Missing source');
    const other = expectDefined(page.value.nodes.find((node) => node.value.node.title === 'Other'));
    expect(identities.project(other, page.observation.semanticsRevision).ok).toBe(true);
  });
  const result = await tasks.complete(input);
  expect(result).toMatchObject({
    ok: true,
    receipt: { effects: 'committed', snapshots: 'unavailable', recovery: 'reread' },
  });
  const receipt = expectDefined(result.receipt);
  expect(receipt.next?.target).toBeTypeOf('string');
  expect(receipt.next?.task).toBeUndefined();
  expect(receipt.original.task).toBeUndefined();
  expect(receipt.warnings.map((item) => item.code)).toContain('RESULT_SNAPSHOT_UNAVAILABLE');
});

it.each([false, true])(
  'reports skipped tracking after confirmed main publication fails, recurring=%s',
  async (recurring) => {
    const { h, client, input } = await setup(
      `- [ ] Task${recurring ? ' 🔁 every day 📅 2026-08-01' : ''}\n  - 2026-08-01T11:00:00Z →\n`,
    );
    const writes = vi.spyOn(h.app.vault, 'process');
    vi.spyOn(h.index, 'installCommittedContent').mockImplementation(() => {
      h.index.destroy();
      throw new Error('publication failed');
    });
    const result = await client.tasks.complete(input);
    expect(await h.read('a.md')).toContain('- [x] Task');
    expect(await h.read('a.md')).toContain('2026-08-01T11:00:00Z →\n');
    expect(writes).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: true,
      receipt: {
        outcome: 'changed',
        effects: 'partial',
        recovery: 'reread',
        original: { target: input.target, state: 'retained' },
        snapshots: 'unavailable',
        warnings: expect.arrayContaining([
          { code: 'TRACKING_INCOMPLETE', message: expect.any(String) as unknown },
        ]) as unknown,
      },
    });
    if (recurring)
      expect(result).toMatchObject({
        receipt: { next: { target: expect.any(String) as unknown } },
      });
    expect(await client.tasks.complete(input)).toMatchObject({
      ok: false,
      error: { code: 'DISPOSED' },
    });
    expect(writes).toHaveBeenCalledTimes(1);
  },
);
