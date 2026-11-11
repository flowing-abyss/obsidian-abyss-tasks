import { afterEach, expect, it, vi } from 'vitest';
import type { TaskDtoV1, TasksApiV1 } from '../api';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { publicApiHarness, type PublicApiHarness } from './support/publicApiHarness';

const harnesses: PublicApiHarness[] = [];
const now = Date.UTC(2026, 7, 1, 12);
afterEach(() => {
  vi.restoreAllMocks();
  for (const h of harnesses.splice(0)) h.dispose();
});
async function setup(content: string, placement: 'before' | 'after' = 'after') {
  const h = await publicApiHarness(
    { 'a.md': content },
    {
      behaviorSettings: () => ({
        ...DEFAULT_SETTINGS,
        recurrence: { ...DEFAULT_SETTINGS.recurrence, newOccurrencePlacement: placement },
      }),
    },
  );
  harnesses.push(h);
  return { h, client: h.client() };
}
async function task(client: TasksApiV1, line = 0): Promise<TaskDtoV1> {
  const result = await client.tasks.resolve({ source: { path: 'a.md', line } });
  if (!result.ok || result.value.type !== 'found') throw new Error('Missing fixture');
  return result.value.task;
}
function request(value: TaskDtoV1, requestId = 'one') {
  return {
    target: value.target,
    expectedRevision: value.revision,
    requestId,
    expiresAt: now + 300_000,
  };
}
it('completes, replays, and performs a freshly guarded noop', async () => {
  const { h, client } = await setup('- [ ] Task\n');
  const input = request(await task(client));
  const writes = vi.spyOn(h.app.vault, 'process');
  const result = await client.tasks.complete(input);
  expect(result).toMatchObject({
    ok: true,
    receipt: {
      outcome: 'changed',
      effects: 'committed',
      snapshots: 'complete',
      original: { target: input.target, state: 'retained', task: { status: 'done' } },
    },
  });
  expect(await client.tasks.complete(input)).toEqual(result);
  expect(writes).toHaveBeenCalledTimes(1);
  expect(await client.tasks.complete(request(await task(client), 'two'))).toMatchObject({
    ok: true,
    receipt: { outcome: 'noop', effects: 'unchanged' },
  });
  expect(writes).toHaveBeenCalledTimes(2);
});
it('sets configured symbols and toggles the guarded semantic state', async () => {
  const { client } = await setup('- [ ] Task\n');
  expect(
    await client.tasks.setStatus({ ...request(await task(client)), symbol: 'X' }),
  ).toMatchObject({ ok: true, receipt: { original: { task: { statusSymbol: 'x' } } } });
  expect(await client.tasks.toggleCompletion(request(await task(client), 'two'))).toMatchObject({
    ok: true,
    receipt: { original: { task: { status: 'open' } } },
  });
  expect(
    await client.tasks.setStatus({ ...request(await task(client), 'three'), symbol: '?' }),
  ).toMatchObject({ ok: false, effects: 'unchanged', error: { code: 'UNSUPPORTED_STATUS' } });
});
it('retains accepted blocker failures for replay without exposing blocker text', async () => {
  const { h, client } = await setup('- [ ] Task ⛔ block\n- [ ] Secret blocker 🆔 block\n');
  const input = request(await task(client));
  const result = await client.tasks.complete(input);
  expect(result).toMatchObject({
    ok: false,
    effects: 'unchanged',
    error: { code: 'DEPENDENCY_BLOCKED' },
    receipt: { outcome: 'failed' },
  });
  expect(JSON.stringify(result)).not.toContain('Secret blocker');
  await h.external('a.md', '- [ ] Task\n');
  expect(await client.tasks.complete(input)).toMatchObject({
    ok: false,
    error: { code: 'DEPENDENCY_BLOCKED' },
  });
});
it.each([false, true])('reports selected deletion, nested=%s', async (nested) => {
  const { h, client } = await setup(
    nested ? '- [ ] Root\n  - [ ] Child 🏁 delete\n' : '- [ ] Task 🏁 delete\n',
  );
  const input = request(await task(client, nested ? 1 : 0));
  expect(await client.tasks.complete(input)).toMatchObject({
    ok: true,
    receipt: { effects: 'committed', original: { target: input.target, state: 'removed' } },
  });
  expect(await h.read('a.md')).not.toContain(nested ? 'Child' : 'Task');
});
it.each(['before', 'after'] as const)(
  'hydrates final nested recurrence identities after timer offsets (%s)',
  async (placement) => {
    const { h, client } = await setup(
      '- [ ] Root\n  - [ ] Repeat 🔁 every day 📅 2026-08-01\n    - 2026-08-01T11:59:30Z →\n    - [ ] Child\n      - 2026-08-01T11:00:00Z →\n',
      placement,
    );
    const input = request(await task(client, 1));
    const result = await client.tasks.complete(input);
    expect(result).toMatchObject({
      ok: true,
      receipt: {
        effects: 'committed',
        snapshots: 'complete',
        original: { target: input.target, state: 'retained', task: { status: 'done' } },
        next: { task: { status: 'open' } },
        warnings: [{ code: 'TRACKING_ENTRY_DISCARDED' }],
      },
    });
    if (!result.ok || result.receipt.next === undefined) throw new Error('Missing recurrence');
    expect(result.receipt.next.target).not.toBe(input.target);
    expect(await client.tasks.get(input.target)).toEqual({
      ok: true,
      value: result.receipt.original.task,
    });
    expect(await client.tasks.get(result.receipt.next.target)).toEqual({
      ok: true,
      value: result.receipt.next.task,
    });
    expect(await client.tasks.complete(input)).toEqual(result);
    expect(await h.read('a.md')).not.toContain('11:59:30');
  },
);
it.each(['keep', 'delete'])(
  'maps recurrence %s and preserves invalid recurrence behavior',
  async (mode) => {
    const { client } = await setup(`- [ ] Repeat 🔁 every day 📅 2026-08-01 🏁 ${mode}\n`);
    const result = await client.tasks.complete(request(await task(client)));
    expect(result).toMatchObject({
      ok: true,
      receipt: {
        original: { state: mode === 'keep' ? 'retained' : 'removed' },
        next: { task: { status: 'open' } },
      },
    });
    const invalid = await setup('- [ ] Repeat 🔁 every nonsense\n');
    expect(await invalid.client.tasks.complete(request(await task(invalid.client)))).toMatchObject({
      ok: true,
      receipt: { original: { state: 'retained' } },
    });
  },
);
it.each(['partial', 'unknown'] as const)(
  'preserves committed status when tracking is %s',
  async (failure) => {
    const { h, client } = await setup('- [ ] Task\n  - 2026-08-01T11:00:00Z →\n');
    const input = request(await task(client));
    const process = h.app.vault.process.bind(h.app.vault);
    let calls = 0;
    vi.spyOn(h.app.vault, 'process').mockImplementation(async (file, fn, options) => {
      if (++calls === 2) {
        if (failure === 'unknown') throw new Error('secret vault text');
        await h.external('a.md', (await h.read('a.md')).replace('Task', 'External'));
      }
      return process(file, fn, options);
    });
    const result = await client.tasks.complete(input);
    expect(result).toMatchObject({
      ok: true,
      receipt: {
        effects: 'partial',
        original: { state: 'retained' },
        warnings: expect.arrayContaining([
          {
            code: failure === 'unknown' ? 'TRACKING_UNKNOWN' : 'TRACKING_INCOMPLETE',
            message: expect.any(String) as unknown,
          },
        ]) as unknown,
      },
    });
    expect(JSON.stringify(result)).not.toContain('secret vault text');
    if (failure === 'partial') expect(result.receipt?.original.task).toBeUndefined();
  },
);

it('rejects old revisions after effective semantics change before reserving work', async () => {
  const { h, client } = await setup('- [ ] Task\n');
  const input = request(await task(client));
  h.index.updateIntegrationSemantics('changed');
  const process = vi.spyOn(h.app.vault, 'process');
  expect(await client.tasks.complete(input)).toMatchObject({
    ok: false,
    effects: 'unchanged',
    error: { code: 'REVISION_CONFLICT' },
  });
  expect(process).not.toHaveBeenCalled();
});
it('keeps accepted operations alive after client disposal and cancellation', async () => {
  const { h, client } = await setup('- [ ] Task\n');
  const input = request(await task(client));
  const abort = new AbortController();
  const pending = client.tasks.complete(input, { signal: abort.signal });
  abort.abort();
  client.dispose();
  const result = await pending;
  expect(result).toMatchObject({ ok: true, receipt: { effects: 'committed' } });
  expect(await h.client().tasks.complete(input)).toEqual(result);
});
it('returns a sanitized unknown receipt for uncertain main I/O and replays it', async () => {
  const { h, client } = await setup('- [ ] Task\n');
  const input = request(await task(client));
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(h.app.vault, 'process').mockRejectedValue(new Error('secret vault text'));
  const result = await client.tasks.complete(input);
  expect(result).toMatchObject({
    ok: false,
    effects: 'unknown',
    recovery: 'reconcile',
    error: { code: 'IO_ERROR' },
    receipt: { original: { state: 'unproven' }, snapshots: 'unavailable' },
  });
  expect(await client.tasks.complete(input)).toEqual(result);
  expect(JSON.stringify([result, error.mock.calls])).not.toContain('secret vault text');
});
