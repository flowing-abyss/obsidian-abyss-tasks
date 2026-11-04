import { afterEach, expect, it, vi } from 'vitest';
import type { ApiResultV1 } from '../api';
import { StatusCatalog } from '../src/tasks/domain/StatusCatalog';
import { publicApiHarness, type PublicApiHarness } from './support/publicApiHarness';
const harnesses: PublicApiHarness[] = [];
afterEach(() => {
  harnesses.splice(0).forEach((h) => {
    h.dispose();
  });
});
async function setup() {
  const h = await publicApiHarness({ 'a.md': '- [ ] Secret 🆔 id\n- [ ] Other\n', 'empty.md': '' });
  harnesses.push(h);
  return h;
}
function ok<T>(r: ApiResultV1<T>): T {
  if (!r.ok) {
    throw new Error(r.error.code);
  }
  return r.value;
}
function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('Missing fixture value');
  }
  return value;
}

it('rechecks disclosure immediately before asynchronous delivery', async () => {
  const h = await setup();
  const client = h.client();
  const target = required(ok(await client.tasks.list()).items[0]).target;
  const get = client.tasks.get(target);
  const list = client.tasks.list();
  const refresh = h.index.refreshSourceExclusion((source) => source.filePath === 'a.md');
  expect(await get).toMatchObject({ error: { code: 'TARGET_UNAVAILABLE' } });
  const result = await list;
  expect(result.ok ? result.value.items.length : result.error.code).toBe('INCOMPLETE_READ');
  await refresh;
  expect(ok(await client.tasks.list()).items).toEqual([]);
  expect(ok(await client.tasks.resolve({ authoredId: 'id' })).type).toBe('not-found');
});
it('honors disposal and cancellation before data delivery', async () => {
  const h = await setup();
  const client = h.client();
  const pending = client.tasks.list();
  client.dispose();
  expect(await pending).toMatchObject({ error: { code: 'DISPOSED' } });
  const signal = new AbortController();
  const read = h.client().tasks.list(undefined, { signal: signal.signal });
  signal.abort();
  expect(await read).toMatchObject({ error: { code: 'ABORTED' } });
});
it('prioritizes stale cursors over newly failed source health and requires complete ID coverage', async () => {
  const h = await setup();
  const client = h.client();
  const page = ok(await client.tasks.list({ limit: 1 }));
  vi.spyOn(h.app.vault, 'cachedRead').mockRejectedValueOnce(new Error('secret source failure'));
  await h.index.refreshSourceExclusion(undefined);
  expect(await client.tasks.list({ limit: 1, cursor: required(page.nextCursor) })).toMatchObject({
    error: { code: 'STALE_CURSOR' },
  });
  expect(await client.tasks.resolve({ authoredId: 'missing' })).toMatchObject({
    error: { code: 'INCOMPLETE_READ' },
  });
  expect((await client.tasks.statuses()).ok).toBe(true);
});
it('keeps stale and expired identities distinct', async () => {
  const h = await setup();
  const client = h.client();
  const original = required(ok(await client.tasks.list()).items[0]);
  await h.external('a.md', '- [ ] Different\n');
  expect(await client.tasks.get(original.target)).toMatchObject({
    error: { code: 'STALE_TARGET' },
  });
  h.clock(Date.UTC(2026, 7, 1, 13));
  expect(await client.tasks.get(original.target)).toMatchObject({
    error: { code: 'EXPIRED_TARGET' },
  });
});
it('invalidates cursors on semantics and scope changes', async () => {
  const h = await setup();
  const client = h.client();
  const first = ok(await client.tasks.list({ limit: 1 }));
  h.index.setStatusCatalog(
    new StatusCatalog([{ id: 'open', symbol: ' ', type: 'in-progress', defaultForType: true }]),
  );
  expect(await client.tasks.list({ limit: 1, cursor: required(first.nextCursor) })).toMatchObject({
    error: { code: 'STALE_CURSOR' },
  });
});
it('sanitizes unexpected read failures', async () => {
  const h = await setup();
  const client = h.client();
  vi.spyOn(h.reads, 'page').mockImplementationOnce(() => {
    throw new Error('a.md secret title');
  });
  const result = await client.tasks.list();
  expect(result).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
  if (result.ok) throw new Error('Expected failure');
  expect(typeof result.error.diagnosticId).toBe('string');
  expect(JSON.stringify(result)).not.toMatch(/a\.md|secret title/);
});

it('distinguishes a permitted unhealthy target from unavailable disclosure', async () => {
  const h = await setup();
  const client = h.client();
  const target = required(ok(await client.tasks.list()).items[0]).target;
  vi.spyOn(h.app.vault, 'cachedRead').mockRejectedValue(new Error('read failure'));
  await h.index.refreshSourceExclusion(undefined);
  expect(await client.tasks.get(target)).toMatchObject({ error: { code: 'INCOMPLETE_READ' } });
  expect(await client.tasks.resolve({ source: { path: 'a.md', line: 0 } })).toMatchObject({
    error: { code: 'INCOMPLETE_READ' },
  });
  expect(JSON.stringify(await client.tasks.get(target))).not.toContain('a.md');
});

it('redacts a proven rename into an excluded path', async () => {
  const h = await setup();
  const client = h.client();
  const target = required(ok(await client.tasks.list()).items[0]).target;
  await h.index.refreshSourceExclusion((source) => source.filePath === 'hidden.md');
  const file = h.app.vault.getFileByPath('a.md');
  if (file === null) throw new Error('Missing fixture source');
  await h.app.vault.rename(file, 'hidden.md');
  expect(await client.tasks.get(target)).toMatchObject({ error: { code: 'TARGET_UNAVAILABLE' } });
  expect(ok(await client.tasks.resolve({ source: { path: 'hidden.md', line: 0 } })).type).toBe(
    'not-found',
  );
});

it('omits invalid metadata and all source blocks, comments, and tracking entries', async () => {
  const h = await setup();
  await h.external(
    'a.md',
    '- [?] Odd 📅 2026-02-30 ⏰ 25:99 🔁 every nonsense\n  > confidential comment\n  ⏱ 2026-08-01 09:00 - 10:00\n- [ ] Valid ⏰ 09:30 ⏱️ 1h30m\n',
  );
  const rows = ok(await h.client().tasks.list()).items;
  const bad = required(rows[0]);
  expect(bad.dates).toEqual({});
  expect('time' in bad).toBe(false);
  expect('durationMinutes' in bad).toBe(false);
  expect(bad.recurrence).toBe('every nonsense');
  expect(bad.statusSymbol).toBe('?');
  expect(bad.status).toBe('open');
  expect(rows[1]).toMatchObject({ time: '09:30', durationMinutes: 90 });
  expect(JSON.stringify(rows)).not.toMatch(
    /confidential|originalBlock|originalMarkdown|timeEntries|comments|rootRevision/,
  );
});
