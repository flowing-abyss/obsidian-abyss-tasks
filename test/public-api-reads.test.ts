import { afterEach, expect, it, vi } from 'vitest';
import type { ApiResultV1 } from '../api';
import * as dependencyNodes from '../src/tasks/domain/taskDependencies';
import { publicApiHarness, type PublicApiHarness } from './support/publicApiHarness';
const harnesses: PublicApiHarness[] = [];
afterEach(() => {
  harnesses.splice(0).forEach((h) => {
    h.dispose();
  });
});
async function setup(files: Record<string, string>) {
  const h = await publicApiHarness(files);
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

it('projects nested matches with unfiltered parent identity and detached frozen JSON values', async () => {
  const h = await setup({
    'a.md': '- [ ] Root\n  - [x] **Child** #Mixed 🆔 child 📅 2026-08-01\n',
  });
  const client = h.client();
  const page = ok(await client.tasks.list({ statuses: ['done'] }));
  expect(page.items).toHaveLength(1);
  const child = required(page.items[0]);
  expect(child).toMatchObject({
    source: { path: 'a.md', line: 1 },
    status: 'done',
    tags: ['#Mixed'],
    authoredId: 'child',
    dates: { due: '2026-08-01' },
  });
  expect(ok(await client.tasks.get(required(child.parentTarget))).title).toBe('Root');
  expect(ok(await client.tasks.get(child.target))).toEqual(child);
  expect(JSON.parse(JSON.stringify(page))).toEqual(page);
  expect(Object.isFrozen(page.items)).toBe(true);
  expect(Object.isFrozen(child.dates)).toBe(true);
  expect(Object.keys(child).sort((a, b) => a.localeCompare(b))).toEqual(
    [
      'authoredId',
      'dates',
      'markdownTitle',
      'onCompletion',
      'onCompletionExplicit',
      'parentTarget',
      'priority',
      'revision',
      'source',
      'status',
      'statusSymbol',
      'tags',
      'target',
      'title',
    ].sort((a, b) => a.localeCompare(b)),
  );
});
it('paginates deterministically, binds the query, and snapshots inputs before yielding', async () => {
  const h = await setup({ 'b.md': '- [ ] B\n', 'a.md': '- [ ] A\n- [ ] C\n' });
  const client = h.client();
  const query = { limit: 1 };
  const pending = client.tasks.list(query);
  query.limit = 500;
  const first = ok(await pending);
  expect(first.items.map((x) => x.title)).toEqual(['A']);
  const second = ok(await client.tasks.list({ limit: 1, cursor: required(first.nextCursor) }));
  expect(second.items.map((x) => x.title)).toEqual(['C']);
  expect(
    ok(await client.tasks.list({ limit: 1, cursor: required(first.nextCursor) })).items,
  ).toEqual(second.items);
  expect(await client.tasks.list({ limit: 2, cursor: required(first.nextCursor) })).toMatchObject({
    error: { code: 'STALE_CURSOR' },
  });
});
it('resolves exact coordinates and ordered duplicate IDs with bounded candidates', async () => {
  const h = await setup({
    'a.md': Array.from({ length: 102 }, (_, i) => `- [ ] Item ${i} 🆔 duplicate`).join('\n'),
  });
  const client = h.client();
  const result = ok(await client.tasks.resolve({ authoredId: 'duplicate' }));
  expect(result.type).toBe('ambiguous');
  if (result.type !== 'ambiguous') throw new Error('Expected duplicates');
  expect(result.candidates).toHaveLength(100);
  expect(result.truncated).toBe(true);
  expect(result.candidates.map((x) => x.source.line)).toEqual(
    Array.from({ length: 100 }, (_, i) => i),
  );
  expect(ok(await client.tasks.resolve({ source: { path: 'a.md', line: 101 } })).type).toBe(
    'found',
  );
  expect(ok(await client.tasks.resolve({ authoredId: 'missing' })).type).toBe('not-found');
});
it('hydrates only a bounded page without whole-vault query enumeration', async () => {
  const h = await setup({
    'large.md': Array.from({ length: 2000 }, (_, i) => `- [ ] Item ${i}`).join('\n'),
  });
  const list = vi.spyOn(h.index, 'list');
  const listNodes = vi.spyOn(h.index, 'listNodes');
  const enumerate = vi.spyOn(dependencyNodes, 'enumerateTaskNodes');
  const pagePort = vi.spyOn(h.reads, 'page');
  const result = ok(await h.client().tasks.list({ limit: 3 }));
  expect(result.items).toHaveLength(3);
  expect(list).not.toHaveBeenCalled();
  expect(listNodes).not.toHaveBeenCalled();
  expect(enumerate).not.toHaveBeenCalled();
  const page = pagePort.mock.results[0]?.value as ReturnType<typeof h.reads.page> | undefined;
  if (page?.type !== 'ok') throw new Error('Expected bounded page');
  expect(page.value.nodes).toHaveLength(3);
});
it.each(['keep', 'delete'] as const)(
  'preserves ordinary UI %s recurrence identities before early event reads',
  async (policy) => {
    const h = await setup({ 'a.md': `- [ ] Repeat 🔁 every day 🛫 2026-08-01 🏁 ${policy}\n` });
    const client = h.client();
    const original = required(ok(await client.tasks.list()).items[0]);
    const pending: Array<ReturnType<typeof client.tasks.get>> = [];
    let armed = false;
    ok(
      client.subscribe(() => {
        if (armed) pending.push(client.tasks.get(original.target));
      }),
    );
    const root = required(h.index.list()[0]);
    armed = true;
    const result = await h.service.execute({
      type: 'toggle-completion',
      target: { type: 'task', ref: root.ref },
    });
    expect(result.type).toBe('ok');
    const current = await client.tasks.get(original.target);
    if (policy === 'keep') {
      expect(ok(current).target).toBe(original.target);
      expect(ok(current).status).toBe('done');
    } else expect(current).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(pending.length).toBeGreaterThan(0);
    for (const read of pending) {
      const value = await read;
      if (value.ok) expect(value.value.status).toBe('done');
      else expect(['NOT_FOUND', 'INCOMPLETE_READ']).toContain(value.error.code);
    }
    const next = required(ok(await client.tasks.list({ statuses: ['open'] })).items[0]);
    expect(next.target).not.toBe(original.target);
  },
);

it('keeps deep occurrence handles through ordinary UI edits and updates whole-root revisions', async () => {
  const h = await setup({ 'a.md': '- [ ] Root\n  - [ ] Child\n    - [ ] Deep\n' });
  const client = h.client();
  const before = ok(await client.tasks.list()).items;
  const deep = required(h.index.listNodes().find((node) => node.node.title === 'Deep'));
  expect(
    (await h.service.execute({ type: 'append-title', target: deep.target, markdown: ' edited' }))
      .type,
  ).toBe('ok');
  const after = ok(await client.tasks.list()).items;
  expect(after.map((item) => item.target)).toEqual(before.map((item) => item.target));
  expect(after.map((item) => item.revision)).not.toEqual(before.map((item) => item.revision));
  expect(after[2]?.title).toContain('edited');
});
