import { expect, it } from 'vitest';
import type { ApiResultV1, ListTasksV1 } from '../api';
import { TaskCursorRegistry } from '../src/integrations/TaskCursorRegistry';
import type { TaskReadObservation } from '../src/tasks/application/TaskIntegrationReadApi';
function ok<T>(result: ApiResultV1<T>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
const observation: TaskReadObservation = {
  revision: 1,
  generation: 2,
  scopeRevision: 3,
  semanticsRevision: 4,
  lifecycle: 'ready',
};
const after = { path: 'private.md', line: 13 };
it('binds a normalized complete query and allows identical page replay', () => {
  const registry = new TaskCursorRegistry({ epoch: 'epoch', now: () => 0 });
  const query: ListTasksV1 = {
    tagsAll: ['#HELLO', '#world'],
    statuses: ['open', 'done'],
    dates: [
      { field: 'due', to: '2026-08-01' },
      { field: 'created', from: '2026-01-01' },
    ],
  };
  const token = ok(registry.open(query, observation, after));
  const normalized: ListTasksV1 = {
    tagsAll: ['#world', '#hello'],
    statuses: ['done', 'open'],
    dates: [...(query.dates ?? [])].reverse(),
    limit: 100,
    cursor: token,
  };
  expect(ok(registry.resume(token, normalized, observation))).toEqual(after);
  expect(ok(registry.resume(token, normalized, { ...observation, revision: 99 }))).toEqual(after);
  expect(token).not.toMatch(/private|hello|2026/);
  expect(Object.isFrozen(ok(registry.resume(token, query, observation)))).toBe(true);
});
it.each(['generation', 'scopeRevision', 'semanticsRevision'] as const)(
  'rejects a changed %s',
  (field) => {
    const registry = new TaskCursorRegistry({ epoch: 'epoch', now: () => 0 });
    const token = ok(registry.open({}, observation, after));
    expect(registry.resume(token, {}, { ...observation, [field]: 99 })).toMatchObject({
      ok: false,
      error: { code: 'STALE_CURSOR' },
    });
  },
);
it.each<ListTasksV1>([
  { limit: 101 },
  { path: 'other.md' },
  { folder: '' },
  { tagsAll: ['#other'] },
  { statuses: ['done'] },
  { dates: [{ field: 'due', to: '2026-08-01' }] },
])('rejects query mismatch %j', (query) => {
  const registry = new TaskCursorRegistry({ epoch: 'epoch', now: () => 0 });
  const token = ok(registry.open({}, observation, after));
  expect(registry.resume(token, query, observation)).toMatchObject({
    ok: false,
    error: { code: 'STALE_CURSOR' },
  });
});
it('retires only expired capacity, never renews on replay, and rejects unknown epochs', () => {
  let now = 0;
  const registry = new TaskCursorRegistry({
    epoch: 'epoch',
    now: () => now,
    maxCursors: 1,
    ttlMs: 100,
  });
  const token = ok(registry.open({}, observation, after));
  expect(registry.open({}, observation, after)).toMatchObject({
    ok: false,
    error: { code: 'RESOURCE_LIMIT' },
  });
  now = 99;
  ok(registry.resume(token, {}, observation));
  now = 100;
  expect(registry.resume(token, {}, observation)).toMatchObject({
    ok: false,
    error: { code: 'STALE_CURSOR' },
  });
  expect(ok(registry.open({}, observation, after))).not.toBe(token);
  expect(registry.resume('other:c:1', {}, observation)).toMatchObject({
    ok: false,
    error: { code: 'STALE_CURSOR' },
  });
  registry.dispose();
  registry.dispose();
  expect(registry.open({}, observation, after)).toMatchObject({
    ok: false,
    error: { code: 'DISPOSED' },
  });
  expect(registry.resume(token, {}, observation)).toMatchObject({
    ok: false,
    error: { code: 'DISPOSED' },
  });
});

it('retires expired capacity even when issuance timestamps arrived out of order', () => {
  let now = 100;
  const registry = new TaskCursorRegistry({
    epoch: 'epoch',
    now: () => now,
    maxCursors: 2,
    ttlMs: 100,
  });
  const first = ok(registry.open({}, observation, after));
  now = 0;
  ok(registry.open({}, observation, after));
  now = 100;
  expect(registry.open({}, observation, after).ok).toBe(true);
  expect(ok(registry.resume(first, {}, observation))).toEqual(after);
});
