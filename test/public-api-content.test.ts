import { afterEach, expect, it, vi } from 'vitest';
import type { ApiResultV1 } from '../api';
import { TaskTreeReader } from '../src/integrations/taskTreeApi';
import { deferred, metadataChangedEmitter } from './helpers';
import { publicApiHarness, type PublicApiHarness } from './support/publicApiHarness';
const owners: PublicApiHarness[] = [];
it('returns canonical recurrence issues while retaining the prior valid task plan', async () => {
  const original = '- [ ] Зал ⏳ 2026-11-11 ⏰ 10:00 [unknown:: keep]\n';
  const h = await publicApiHarness({ 'a.md': original });
  owners.push(h);
  const api = h.client();
  const task = required(ok(await api.tasks.list()).items[0]);
  const prepare = required(api.tasks.prepare);
  const plan = ok(
    await prepare({ kind: 'edit', target: task.target, expectedRevision: task.revision }),
  );
  const request = (value: string) => ({
    kind: 'append' as const,
    plan: plan.target,
    expectedPlanRevision: plan.revision,
    operation: {
      type: 'patch' as const,
      target: required(plan.after ?? undefined).target,
      patch: { recurrence: { type: 'set' as const, value } },
    },
  });
  const rejected = await prepare(request('каждую среду'));
  expect(rejected).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
  if (rejected.ok) throw new Error('Raw localized recurrence must be rejected');
  expect(rejected.error.message).toContain('recurrence');
  expect(rejected.error.message).toContain('must-start-with-every');
  const accepted = ok(await prepare(request('every week on Wednesday')));
  expect(accepted.after).toMatchObject({
    recurrence: 'every week on Wednesday',
    dates: { scheduled: '2026-11-11' },
    time: '10:00',
  });
  expect(await h.read('a.md')).toBe(original);
});
it('copies an accepted cross-file root comment after a prepared description with preambles', async () => {
  const h = await publicApiHarness({
    'A/source.md':
      '# Перенос\n\n- [ ] Исходная задача\n  - > Исходное описание.\n  - 2021-01-02: Важный комментарий.\n  - [ ] Проверить результат\n',
    'B/target.md': '# Итог\n\n- [ ] Итог\n',
  });
  owners.push(h);
  const c = h.client();
  const roots = ok(await c.tasks.list()).items;
  const source = required(roots.find((r) => r.source.path === 'A/source.md'));
  const target = required(roots.find((r) => r.source.path === 'B/target.md'));
  const tree = ok(await required(c.tasks.tree)({ target: source.target })).tree;
  let p = ok(
    await required(c.tasks.prepare)({
      kind: 'edit',
      target: target.target,
      expectedRevision: target.revision,
    }),
  );
  p = ok(
    await required(c.tasks.prepare)({
      kind: 'append',
      plan: p.target,
      expectedPlanRevision: p.revision,
      operation: {
        type: 'description',
        target: required(p.after ?? undefined).target,
        text: 'Исходная задача\nИсходное описание.',
      },
    }),
  );
  p = ok(
    await required(c.tasks.prepare)({
      kind: 'append',
      plan: p.target,
      expectedPlanRevision: p.revision,
      operation: {
        type: 'copy-comment',
        source: required(tree.comments[0]).target,
        target: required(p.after ?? undefined).target,
      },
    }),
  );
  expect(p.after?.comments[0]?.text).toBe('Важный комментарий.');
  expect(p.copies?.[0]?.state).toBe('retained');
});
afterEach(() => {
  owners.splice(0).forEach((h) => {
    h.dispose();
  });
});
async function setup(content: string) {
  const h = await publicApiHarness({ 'a.md': content });
  owners.push(h);
  return h;
}
function pauseFirstRefresh(h: PublicApiHarness) {
  const started = deferred<void>(),
    resume = deferred<void>(),
    prepare = h.service.prepare.bind(h.service);
  let first = true;
  vi.spyOn(h.service, 'prepare').mockImplementationOnce(async (snapshot, commands) => {
    const native = await prepare(snapshot, commands);
    if (native.type !== 'ready') return native;
    return {
      ...native,
      refresh: async (current) => {
        if (first) {
          first = false;
          started.resolve();
          await resume.promise;
        }
        return await native.refresh(current);
      },
    };
  });
  return { started, resume };
}
function ok<T>(result: ApiResultV1<T>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing value');
  return value;
}
it('expands canonical ordered trees with owner-bound comments and full scalar text', async () => {
  const h = await setup(
    '- [ ] Root #One\n  - > Description\n  - [ ] Same\n    - [ ] Deep\n  - 2026-08-01: First\n  - [ ] Same\n    - 2026-08-01: Second\n',
  );
  const client = h.client();
  const root = required(ok(await client.tasks.list()).items[0]);
  const first = ok(await required(client.tasks.tree)({ target: root.target, limit: 2 }));
  expect(first.tree.description).toBe('Description');
  expect(first.tree.entries.map((e) => e.kind)).toEqual(['child', 'comment']);
  expect(first.tree.children[0]?.complete).toBe(false);
  expect(first.truncated).toBe(true);
  const second = ok(
    await required(client.tasks.tree)({
      target: root.target,
      limit: 2,
      cursor: required(first.nextCursor),
    }),
  );
  expect(second.tree.children[0]?.target).not.toBe(first.tree.children[0]?.target);
  const deep = ok(
    await required(client.tasks.tree)({ target: required(first.tree.children[0]).target }),
  );
  expect(deep.tree.children[0]?.title).toBe('Deep');
  expect(first.tree.comments[0]?.parentTarget).toBe(root.target);
  expect(ok(await required(client.tasks.tags)()).items).toEqual(['#One']);
});
it('previews without writes, preserves duplicate child identity, consumes the family and replays receipts', async () => {
  const h = await setup('- [ ] Root\n  - [ ] Same\n  - [ ] Same\n');
  const c = h.client();
  const root = required(ok(await c.tasks.list()).items[0]);
  const p = ok(
    await required(c.tasks.prepare)({
      kind: 'edit',
      target: root.target,
      expectedRevision: root.revision,
    }),
  );
  const child = required(p.after?.children[1]);
  const next = ok(
    await required(c.tasks.prepare)({
      kind: 'append',
      plan: p.target,
      expectedPlanRevision: p.revision,
      operation: {
        type: 'patch',
        target: child.target,
        patch: { due: { type: 'set', value: '2026-08-02' } },
      },
    }),
  );
  expect(next.after?.children[1]?.target).toBe(child.target);
  expect(await h.read('a.md')).not.toContain('2026-08-02');
  const input = {
    plan: next.target,
    expectedPlanRevision: next.revision,
    requestId: 'save',
    expiresAt: Date.UTC(2026, 7, 1, 12) + 60000,
  };
  const saved = await required(c.tasks.apply)(input);
  expect(saved.ok).toBe(true);
  expect(saved.receipt?.contentContinuity.correspondence.state).toBe('complete');
  expect(await required(c.tasks.apply)(input)).toEqual(saved);
  expect(await required(c.tasks.apply)({ ...input, requestId: 'again' })).toMatchObject({
    ok: false,
    effects: 'unchanged',
  });
  expect(
    await required(c.tasks.apply)({ ...input, plan: p.target, expectedPlanRevision: p.revision }),
  ).toMatchObject({ ok: false, error: { code: 'REQUEST_ID_REUSED' } });
});
it('creates metadata and a nested tree only from a prepared creation plan', async () => {
  const h = await setup('- [ ] Existing\n');
  const c = h.client();
  const p = ok(
    await required(c.tasks.prepare)({
      kind: 'create',
      destination: { type: 'note', path: 'a.md', insertion: { type: 'append' } },
      tree: {
        markdownTitle: 'New',
        initial: { due: { type: 'set', value: '2026-08-02' }, tags: { add: ['#Work'] } },
        children: [{ markdownTitle: 'Child' }],
      },
    }),
  );
  expect(p.before).toBeNull();
  expect(p.after?.source).toBeUndefined();
  expect(await h.read('a.md')).toBe('- [ ] Existing\n');
  const saved = await required(c.tasks.create)({
    plan: p.target,
    expectedPlanRevision: p.revision,
    requestId: 'create',
    expiresAt: Date.UTC(2026, 7, 1, 12) + 60000,
  });
  expect(saved.ok).toBe(true);
  const receipt = required(saved.receipt);
  expect(receipt.task).toBeDefined();
  const tree = ok(await required(c.tasks.tree)({ target: required(receipt.task).target }));
  expect(tree.tree.children[0]?.title).toBe('Child');
  expect(tree.tree.dates.due).toBe('2026-08-02');
});
it('refuses stale revisions and disposed clients', async () => {
  const h = await setup('- [ ] Root\n');
  const c = h.client();
  const root = required(ok(await c.tasks.list()).items[0]);
  expect(
    await required(c.tasks.prepare)({ kind: 'edit', target: root.target, expectedRevision: 'old' }),
  ).toMatchObject({ ok: false, error: { code: 'REVISION_CONFLICT' } });
  c.dispose();
  expect(await required(c.tasks.tree)({ target: root.target })).toMatchObject({
    ok: false,
    error: { code: 'DISPOSED' },
  });
});
it('searches title and body through native retrieval, filters all candidates, and scopes tag identity', async () => {
  const h = await setup(
    '- [ ] Needle #One\n  - > Elsewhere\n- [x] Same #one\n  - > Needle\n- [ ] Same #Two\n  - > Needle\n',
  );
  const c = h.client();
  const title = ok(await required(c.tasks.search)({ query: 'Needle', fields: 'title' }));
  expect(title.items.map((t) => t.title)).toEqual(['Needle']);
  const body = ok(
    await required(c.tasks.search)({
      query: 'Needle',
      fields: 'body',
      statuses: ['open'],
      limit: 1,
    }),
  );
  expect(body.items.map((t) => t.title)).toEqual(['Same']);
  expect(body.complete).toBe(true);
  expect(ok(await required(c.tasks.tags)({ path: 'a.md' })).items).toEqual(['#One', '#Two']);
});

it('keeps scalar text untruncated and binds cursors to revisions and limits', async () => {
  const text = 'Large '.repeat(20000).trimEnd();
  const h = await setup(`- [ ] Root\n  - > ${text}\n  - 2026-08-01: ${text}\n  - [ ] Child\n`);
  const c = h.client();
  const root = required(ok(await c.tasks.list()).items[0]);
  const page = ok(await required(c.tasks.tree)({ target: root.target, limit: 1 }));
  expect(page.tree.description).toBe(text.trimEnd());
  expect(page.tree.comments[0]?.text).toBe(text.trimEnd());
  expect(
    await required(c.tasks.tree)({
      target: root.target,
      limit: 2,
      cursor: required(page.nextCursor),
    }),
  ).toMatchObject({ ok: false, error: { code: 'STALE_CURSOR' } });
});
it('keeps equal comments under their actual parents and rejects older plan comment handles', async () => {
  const h = await setup(
    '- [ ] Root\n  - [ ] A\n    - 2026-08-01: Same\n  - [ ] B\n    - 2026-08-01: Same\n',
  );
  const c = h.client();
  const root = required(ok(await c.tasks.list()).items[0]);
  const p = ok(
    await required(c.tasks.prepare)({
      kind: 'edit',
      target: root.target,
      expectedRevision: root.revision,
    }),
  );
  const a = required(p.after?.children[0]),
    b = required(p.after?.children[1]);
  const aa = ok(
    await required(c.tasks.tree)({
      target: a.target,
      plan: p.target,
      expectedPlanRevision: p.revision,
    }),
  );
  const bb = ok(
    await required(c.tasks.tree)({
      target: b.target,
      plan: p.target,
      expectedPlanRevision: p.revision,
    }),
  );
  const comment = required(aa.tree.comments[0]);
  expect(comment.target).not.toBe(bb.tree.comments[0]?.target);
  expect(comment.parentTarget).toBe(a.target);
  const next = ok(
    await required(c.tasks.prepare)({
      kind: 'append',
      plan: p.target,
      expectedPlanRevision: p.revision,
      operation: { type: 'update-comment', target: comment.target, text: 'Changed' },
    }),
  );
  expect(
    await required(c.tasks.prepare)({
      kind: 'append',
      plan: next.target,
      expectedPlanRevision: next.revision,
      operation: { type: 'remove-comment', target: comment.target },
    }),
  ).toMatchObject({ ok: false });
  const a2 = ok(
    await required(c.tasks.tree)({
      target: a.target,
      plan: next.target,
      expectedPlanRevision: next.revision,
    }),
  );
  expect(a2.tree.comments[0]?.text).toBe('Changed');
  const b2 = ok(
    await required(c.tasks.tree)({
      target: b.target,
      plan: next.target,
      expectedPlanRevision: next.revision,
    }),
  );
  expect(b2.tree.comments[0]?.text).toBe('Same');
});
it('reports observed own and subtree work even when entry evidence is paged', async () => {
  const h = await setup(
    '- [ ] Root\n  - 2026-08-01T10:00:00+00:00 → 2026-08-01T11:00:00+00:00\n  - [ ] Child\n    - 2026-08-01T11:30:00+00:00 →\n',
  );
  const c = h.client();
  const root = required(ok(await c.tasks.list()).items[0]);
  const first = ok(await required(c.tasks.tree)({ target: root.target, limit: 1 }));
  expect(first.tree.entries.map((e) => e.kind)).toEqual(['time-entry']);
  expect(first.tree.activity.own.closedMs).toBe(3600000);
  expect(first.tree.activity.subtree.runningMsAtObservation).toBe(1800000);
  expect(first.tree.activity.subtree.lastRecordedWorkAtMs).toBe(Date.UTC(2026, 7, 1, 12));
  h.clock(Date.UTC(2026, 7, 1, 12, 0, 30));
  const second = ok(
    await required(c.tasks.tree)({
      target: root.target,
      limit: 1,
      cursor: required(first.nextCursor),
    }),
  );
  expect(second.tree.activity).toEqual(first.tree.activity);
});
it('maps issued new equal-title children and only issued final candidate tasks', async () => {
  const h = await setup('- [ ] Root\n  - [ ] Same\n');
  const c = h.client();
  const root = required(ok(await c.tasks.list()).items[0]);
  let p = ok(
    await required(c.tasks.prepare)({
      kind: 'edit',
      target: root.target,
      expectedRevision: root.revision,
    }),
  );
  p = ok(
    await required(c.tasks.prepare)({
      kind: 'append',
      plan: p.target,
      expectedPlanRevision: p.revision,
      operation: {
        type: 'add-child',
        target: required(p.after ?? undefined).target,
        markdownTitle: 'Same',
      },
    }),
  );
  const child = required(p.after?.children[1]);
  const saved = await required(c.tasks.apply)({
    plan: p.target,
    expectedPlanRevision: p.revision,
    requestId: 'children',
    expiresAt: Date.UTC(2026, 7, 1, 12) + 60000,
  });
  expect(saved.ok).toBe(true);
  const correspondence = required(saved.receipt).contentContinuity.correspondence;
  expect(correspondence.state).toBe('complete');
  if (correspondence.state !== 'complete') return;
  expect(correspondence.tasks).toHaveLength(3);
  const mapped = required(correspondence.tasks.find((t) => t.preparedTarget === child.target));
  expect(ok(await c.tasks.get(mapped.committedTarget)).source.line).toBe(2);
});
it('returns complete deletion and unchanged commit receipts without replaying either family', async () => {
  const h = await setup('- [ ] Root\n');
  const c = h.client();
  let root = required(ok(await c.tasks.list()).items[0]);
  const p = ok(
    await required(c.tasks.prepare)({
      kind: 'edit',
      target: root.target,
      expectedRevision: root.revision,
    }),
  );
  const noop = await required(c.tasks.apply)({
    plan: p.target,
    expectedPlanRevision: p.revision,
    requestId: 'noop',
    expiresAt: Date.UTC(2026, 7, 1, 12) + 60000,
  });
  expect(noop).toMatchObject({
    ok: true,
    receipt: { outcome: 'noop', effects: 'unchanged', snapshots: 'complete' },
  });
  root = ok(await c.tasks.get(root.target));
  const deletion = ok(
    await required(c.tasks.prepare)({
      kind: 'edit',
      target: root.target,
      expectedRevision: root.revision,
      operation: { type: 'remove', target: root.target },
    }),
  );
  expect(deletion.after).toBeNull();
  const deleted = await required(c.tasks.apply)({
    plan: deletion.target,
    expectedPlanRevision: deletion.revision,
    requestId: 'delete',
    expiresAt: Date.UTC(2026, 7, 1, 12) + 60000,
  });
  expect(deleted).toMatchObject({
    ok: true,
    receipt: {
      contentContinuity: { correspondence: { state: 'complete', root: null, tasks: [] } },
    },
  });
  expect(await h.read('a.md')).toBe('');
});
it('refreshes a pending same-file plan after an acknowledged commit and retires its old writer version', async () => {
  const h = await setup('- [ ] Existing\n');
  const c = h.client();
  const destination = {
    type: 'note' as const,
    path: 'a.md',
    insertion: { type: 'prepend' as const },
  };
  const first = ok(
    await required(c.tasks.prepare)({
      kind: 'create',
      destination,
      tree: { markdownTitle: 'One' },
    }),
  );
  const second = ok(
    await required(c.tasks.prepare)({
      kind: 'create',
      destination,
      tree: { markdownTitle: 'Two' },
    }),
  );
  expect(
    (
      await required(c.tasks.create)({
        plan: first.target,
        expectedPlanRevision: first.revision,
        requestId: 'first',
        expiresAt: Date.UTC(2026, 7, 1, 12) + 60000,
      })
    ).ok,
  ).toBe(true);
  const refreshed = ok(
    await required(c.tasks.prepare)({
      kind: 'refresh',
      plan: second.target,
      expectedPlanRevision: second.revision,
    }),
  );
  expect(refreshed.after?.markdownTitle).toBe(second.after?.markdownTitle);
  expect(refreshed.after?.target).toBe(second.after?.target);
  expect(
    await required(c.tasks.create)({
      plan: second.target,
      expectedPlanRevision: second.revision,
      requestId: 'old',
      expiresAt: Date.UTC(2026, 7, 1, 12) + 60000,
    }),
  ).toMatchObject({ ok: false, effects: 'unchanged' });
  expect(
    (
      await required(c.tasks.create)({
        plan: refreshed.target,
        expectedPlanRevision: refreshed.revision,
        requestId: 'second',
        expiresAt: Date.UTC(2026, 7, 1, 12) + 60000,
      })
    ).ok,
  ).toBe(true);
  expect((await h.read('a.md')).indexOf('Two')).toBeLessThan((await h.read('a.md')).indexOf('One'));
});
it('finds filtered matches beyond a native page and keeps duplicates distinct', async () => {
  const h = await setup(
    Array.from({ length: 501 }, (_, i) => `- [${i < 500 ? 'x' : ' '}] Same\n  - > Needle\n`).join(
      '',
    ),
  );
  const c = h.client();
  const result = ok(
    await required(c.tasks.search)({
      query: 'Needle',
      fields: 'body',
      statuses: ['open'],
      limit: 1,
    }),
  );
  expect(result.items).toHaveLength(1);
  expect(result.items[0]?.source.line).toBe(1000);
  expect(result.complete).toBe(true);
  const all = ok(await required(c.tasks.search)({ query: 'Same', fields: 'title', limit: 2 }));
  expect(all.items[0]?.target).not.toBe(all.items[1]?.target);
  expect(all.truncated).toBe(true);
});
it('rejects cross-epoch handles, malformed input and shared request namespace collisions', async () => {
  const h = await setup('- [ ] Root\n');
  const other = await setup('- [ ] Root\n');
  const c = h.client(),
    root = required(ok(await c.tasks.list()).items[0]);
  expect(await required(other.client().tasks.tree)({ target: root.target })).toMatchObject({
    ok: false,
    error: { code: 'EXPIRED_TARGET' },
  });
  expect(
    await required(c.tasks.prepare)({
      kind: 'edit',
      target: root.target,
      expectedRevision: root.revision,
      operation: {
        type: 'patch',
        target: root.target,
        patch: { due: { type: 'set', value: '2026-99-40' } },
      },
    }),
  ).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
  const p = ok(
    await required(c.tasks.prepare)({
      kind: 'edit',
      target: root.target,
      expectedRevision: root.revision,
    }),
  );
  const request = { requestId: 'shared', expiresAt: Date.UTC(2026, 7, 1, 12) + 60000 };
  await c.tasks.complete({ ...request, target: root.target, expectedRevision: root.revision });
  expect(
    await required(c.tasks.apply)({ ...request, plan: p.target, expectedPlanRevision: p.revision }),
  ).toMatchObject({ ok: false, error: { code: 'REQUEST_ID_REUSED' }, effects: 'unchanged' });
});

it('preserves committed effects when exact accepted readback is unavailable', async () => {
  const h = await setup('- [ ] Root\n');
  const c = h.client(),
    root = required(ok(await c.tasks.list()).items[0]);
  const p = ok(
    await required(c.tasks.prepare)({
      kind: 'edit',
      target: root.target,
      expectedRevision: root.revision,
      operation: {
        type: 'patch',
        target: root.target,
        patch: { priority: { type: 'set', value: 'A' } },
      },
    }),
  );
  const read = vi.spyOn(h.reads, 'node').mockReturnValue({ type: 'error', reason: 'unavailable' });
  const input = {
    plan: p.target,
    expectedPlanRevision: p.revision,
    requestId: 'no-read',
    expiresAt: Date.UTC(2026, 7, 1, 12) + 60000,
  };
  const saved = await required(c.tasks.apply)(input);
  read.mockRestore();
  expect(saved).toMatchObject({
    ok: true,
    receipt: {
      effects: 'committed',
      snapshots: 'unavailable',
      contentContinuity: { correspondence: { state: 'unavailable' } },
    },
  });
  expect(await required(c.tasks.apply)(input)).toEqual(saved);
  expect(await h.read('a.md')).toContain('🔺');
});
it('does not disclose retained plans after source permission is withdrawn', async () => {
  const h = await setup('- [ ] Secret\n');
  const c = h.client(),
    root = required(ok(await c.tasks.list()).items[0]);
  const p = ok(
    await required(c.tasks.prepare)({
      kind: 'edit',
      target: root.target,
      expectedRevision: root.revision,
    }),
  );
  await h.index.refreshSourceExclusion(() => true);
  expect(
    await required(c.tasks.tree)({
      target: required(p.after ?? undefined).target,
      plan: p.target,
      expectedPlanRevision: p.revision,
    }),
  ).toMatchObject({ ok: false, error: { code: 'TARGET_UNAVAILABLE' } });
});
it('keeps a resumed search cursor usable after its predecessor expires', async () => {
  const h = await setup('- [ ] Same\n- [ ] Same\n- [ ] Same\n');
  const c = h.client();
  const a = ok(await required(c.tasks.search)({ query: 'Same', limit: 1 }));
  h.clock(Date.UTC(2026, 7, 1, 12, 0, 30));
  const b = ok(
    await required(c.tasks.search)({ query: 'Same', limit: 1, cursor: required(a.nextCursor) }),
  );
  h.clock(Date.UTC(2026, 7, 1, 12, 1, 5));
  const d = ok(
    await required(c.tasks.search)({ query: 'Same', limit: 1, cursor: required(b.nextCursor) }),
  );
  expect(d.items[0]?.source.line).toBe(2);
});

it('rejects unsupported initial statuses as a typed user input error', async () => {
  const h = await setup('- [ ] Existing\n');
  expect(
    await required(h.client().tasks.prepare)({
      kind: 'create',
      destination: { type: 'note', path: 'a.md', insertion: { type: 'append' } },
      tree: { markdownTitle: 'New', initial: { statusSymbol: '?' } },
    }),
  ).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_STATUS' } });
});

it('refreshes the retained second physical duplicate root after a shifting sibling creation', async () => {
  const h = await setup('- [ ] Same\n- [ ] Same\n');
  const c = h.client(),
    roots = ok(await c.tasks.list()).items,
    second = required(roots[1]);
  const deletion = ok(
    await required(c.tasks.prepare)({
      kind: 'edit',
      target: second.target,
      expectedRevision: second.revision,
      operation: { type: 'remove', target: second.target },
    }),
  );
  const creation = ok(
    await required(c.tasks.prepare)({
      kind: 'create',
      destination: { type: 'note', path: 'a.md', insertion: { type: 'prepend' } },
      tree: { markdownTitle: 'Inserted' },
    }),
  );
  const expiresAt = Date.UTC(2026, 7, 1, 12) + 60000;
  expect(
    (
      await required(c.tasks.create)({
        plan: creation.target,
        expectedPlanRevision: creation.revision,
        requestId: 'shift',
        expiresAt,
      })
    ).ok,
  ).toBe(true);
  const refreshed = ok(
    await required(c.tasks.prepare)({
      kind: 'refresh',
      plan: deletion.target,
      expectedPlanRevision: deletion.revision,
    }),
  );
  expect(refreshed.before).toEqual(deletion.before);
  expect(
    (
      await required(c.tasks.apply)({
        plan: refreshed.target,
        expectedPlanRevision: refreshed.revision,
        requestId: 'delete-second',
        expiresAt,
      })
    ).ok,
  ).toBe(true);
  expect(ok(await c.tasks.list()).items.map((task) => task.title)).toEqual(['Inserted', 'Same']);
  expect(ok(await c.tasks.get(required(roots[0]).target)).title).toBe('Same');
});

it('issues late before-descendant handles from the proven current root after refresh', async () => {
  const h = await setup('- [ ] Root\n  - [ ] Child\n    - [ ] Deep\n');
  const c = h.client(),
    root = required(ok(await c.tasks.list()).items[0]);
  const p = ok(
    await required(c.tasks.prepare)({
      kind: 'edit',
      target: root.target,
      expectedRevision: root.revision,
    }),
  );
  const creation = ok(
    await required(c.tasks.prepare)({
      kind: 'create',
      destination: { type: 'note', path: 'a.md', insertion: { type: 'prepend' } },
      tree: { markdownTitle: 'Inserted' },
    }),
  );
  await required(c.tasks.create)({
    plan: creation.target,
    expectedPlanRevision: creation.revision,
    requestId: 'shift-before',
    expiresAt: Date.UTC(2026, 7, 1, 12) + 60000,
  });
  const refreshed = ok(
    await required(c.tasks.prepare)({
      kind: 'refresh',
      plan: p.target,
      expectedPlanRevision: p.revision,
    }),
  );
  const child = required(refreshed.before?.children[0]);
  const expanded = ok(
    await required(c.tasks.tree)({
      target: child.target,
      plan: refreshed.target,
      expectedPlanRevision: refreshed.revision,
      side: 'before',
    }),
  );
  const deep = required(expanded.tree.children[0]);
  expect(ok(await c.tasks.get(deep.target)).source.line).toBe(3);
  const after = ok(
    await required(c.tasks.tree)({
      target: required(refreshed.after?.children[0]).target,
      plan: refreshed.target,
      expectedPlanRevision: refreshed.revision,
    }),
  );
  expect(after.tree.children[0]?.target).toBe(deep.target);
});

it('does not map a committed equal-title insertion to an old occurrence when accepted installation is unavailable', async () => {
  const h = await setup('- [ ] Same ➕ 2026-08-01\n');
  const c = h.client(),
    old = required(ok(await c.tasks.list()).items[0]);
  const p = ok(
    await required(c.tasks.prepare)({
      kind: 'create',
      destination: { type: 'note', path: 'a.md', insertion: { type: 'prepend' } },
      tree: { markdownTitle: 'Same' },
    }),
  );
  const install = vi.spyOn(h.index, 'reconcileCommittedSource').mockResolvedValue(false);
  const result = await required(c.tasks.create)({
    plan: p.target,
    expectedPlanRevision: p.revision,
    requestId: 'unavailable-install',
    expiresAt: Date.UTC(2026, 7, 1, 12) + 60000,
  });
  install.mockRestore();
  expect(result).toMatchObject({
    ok: true,
    receipt: {
      effects: 'committed',
      snapshots: 'unavailable',
      contentContinuity: { correspondence: { state: 'unavailable' } },
    },
  });
  expect(result.receipt?.task?.target).not.toBe(old.target);
  expect(await h.read('a.md')).toBe('- [ ] Same ➕ 2026-08-01\n- [ ] Same ➕ 2026-08-01\n');
});

it('does not retain invisible plans or pins for invalid first operations', async () => {
  const h = await setup('- [ ] Root\n');
  const c = h.client(),
    root = required(ok(await c.tasks.list()).items[0]);
  for (let index = 0; index < 130; index++)
    await required(c.tasks.prepare)({
      kind: 'edit',
      target: root.target,
      expectedRevision: root.revision,
      operation: { type: 'remove', target: 'unissued' },
    });
  expect(
    (
      await required(c.tasks.prepare)({
        kind: 'edit',
        target: root.target,
        expectedRevision: root.revision,
      })
    ).ok,
  ).toBe(true);
});

it('retains duplicate unexpanded descendants across appends while new siblings remain plan-owned', async () => {
  const h = await setup('- [ ] Root\n  - [ ] Child\n    - [ ] Same\n    - [ ] Same\n');
  const c = h.client(),
    items = ok(await c.tasks.list()).items,
    root = required(items[0]);
  let plan = ok(
    await required(c.tasks.prepare)({
      kind: 'edit',
      target: root.target,
      expectedRevision: root.revision,
    }),
  );
  const child = required(plan.after?.children[0]);
  plan = ok(
    await required(c.tasks.prepare)({
      kind: 'append',
      plan: plan.target,
      expectedPlanRevision: plan.revision,
      operation: { type: 'add-child', target: child.target, markdownTitle: 'Same' },
    }),
  );
  plan = ok(
    await required(c.tasks.prepare)({
      kind: 'append',
      plan: plan.target,
      expectedPlanRevision: plan.revision,
      operation: {
        type: 'patch',
        target: required(plan.after ?? undefined).target,
        patch: { priority: { type: 'set', value: 'A' } },
      },
    }),
  );
  const expanded = ok(
    await required(c.tasks.tree)({
      target: child.target,
      plan: plan.target,
      expectedPlanRevision: plan.revision,
    }),
  );
  expect(expanded.tree.children.map((node) => node.target).slice(0, 2)).toEqual([
    required(items[2]).target,
    required(items[3]).target,
  ]);
  const added = required(expanded.tree.children[2]);
  expect(added.target).not.toBe(required(items[2]).target);
  expect(await c.tasks.get(added.target)).toMatchObject({
    ok: false,
    error: { code: 'EXPIRED_TARGET' },
  });
});

it('retains the explicitly focused deep child before any expansion', async () => {
  const h = await setup('- [ ] Root\n  - [ ] Child\n    - [ ] Focused\n');
  const c = h.client(),
    focused = required(ok(await c.tasks.list()).items[2]);
  const p = ok(
    await required(c.tasks.prepare)({
      kind: 'edit',
      target: focused.target,
      expectedRevision: focused.revision,
    }),
  );
  const after = ok(
    await required(c.tasks.tree)({
      target: focused.target,
      plan: p.target,
      expectedPlanRevision: p.revision,
    }),
  );
  expect(after.tree.title).toBe('Focused');
  const before = ok(
    await required(c.tasks.tree)({
      target: focused.target,
      plan: p.target,
      expectedPlanRevision: p.revision,
      side: 'before',
    }),
  );
  expect(before.tree.target).toBe(focused.target);
  const saved = await required(c.tasks.apply)({
    plan: p.target,
    expectedPlanRevision: p.revision,
    requestId: 'focused',
    expiresAt: Date.UTC(2026, 7, 1, 12) + 60000,
  });
  const correspondence = required(saved.receipt).contentContinuity.correspondence;
  expect(correspondence.state).toBe('complete');
  if (correspondence.state === 'complete')
    expect(
      correspondence.tasks.some(
        (pair) => pair.preparedTarget === focused.target && pair.committedTarget === focused.target,
      ),
    ).toBe(true);
});

it.each(['apply', 'create'] as const)(
  'redacts current %s receipt disclosure on replay without changing retained effects',
  async (method) => {
    const h = await setup('- [ ] Root\n');
    const c = h.client(),
      root = required(ok(await c.tasks.list()).items[0]);
    const writes = vi.spyOn(h.app.vault, 'process');
    const plan = ok(
      await required(c.tasks.prepare)(
        method === 'apply'
          ? {
              kind: 'edit',
              target: root.target,
              expectedRevision: root.revision,
              operation: {
                type: 'patch',
                target: root.target,
                patch: { priority: { type: 'set', value: 'A' } },
              },
            }
          : {
              kind: 'create',
              destination: { type: 'note', path: 'a.md', insertion: { type: 'append' } },
              tree: { markdownTitle: 'Created' },
            },
      ),
    );
    const input = {
        plan: plan.target,
        expectedPlanRevision: plan.revision,
        requestId: `disclosure-${method}`,
        expiresAt: Date.UTC(2026, 7, 1, 12) + 60000,
      },
      run = required(c.tasks[method]);
    const saved = await run(input);
    expect(saved).toMatchObject({
      ok: true,
      receipt: {
        effects: 'committed',
        snapshots: 'complete',
        contentContinuity: { correspondence: { state: 'complete' } },
      },
    });
    const content = await h.read('a.md');
    await h.index.refreshSourceExclusion(() => true);
    const replay = await run(input);
    expect(replay).toMatchObject({
      ok: true,
      receipt: {
        requestId: input.requestId,
        outcome: 'changed',
        effects: 'committed',
        snapshots: 'redacted',
        contentContinuity: { correspondence: { state: 'redacted' } },
      },
    });
    expect(replay.receipt?.destinationEffects).toBe(saved.receipt?.destinationEffects);
    expect(replay.receipt?.task).toBeUndefined();
    expect(writes).toHaveBeenCalledTimes(1);
    expect(await h.read('a.md')).toBe(content);
    expect(saved.receipt?.snapshots).toBe('complete');
  },
);
it('redacts delivery after client disposal while preserving an admitted commit and live-peer replay', async () => {
  const h = await setup('- [ ] Root\n');
  const c = h.client(),
    peer = h.client(),
    root = required(ok(await c.tasks.list()).items[0]);
  const p = ok(
    await required(c.tasks.prepare)({
      kind: 'edit',
      target: root.target,
      expectedRevision: root.revision,
      operation: {
        type: 'patch',
        target: root.target,
        patch: { priority: { type: 'set', value: 'A' } },
      },
    }),
  );
  const started = deferred<void>(),
    resume = deferred<void>(),
    process = h.app.vault.process.bind(h.app.vault);
  const writes = vi.spyOn(h.app.vault, 'process').mockImplementation(async (file, transform) => {
    started.resolve();
    await resume.promise;
    return await process(file, transform);
  });
  const input = {
    plan: p.target,
    expectedPlanRevision: p.revision,
    requestId: 'dispose-delivery',
    expiresAt: Date.UTC(2026, 7, 1, 12) + 60000,
  };
  const pending = required(c.tasks.apply)(input);
  await started.promise;
  c.dispose();
  resume.resolve();
  const result = await pending;
  expect(result).toMatchObject({
    ok: true,
    receipt: {
      effects: 'committed',
      snapshots: 'redacted',
      contentContinuity: { correspondence: { state: 'redacted' } },
    },
  });
  expect(result.receipt?.task).toBeUndefined();
  const replay = await required(peer.tasks.apply)(input);
  expect(replay).toMatchObject({
    ok: true,
    receipt: {
      effects: 'committed',
      snapshots: 'complete',
      contentContinuity: { correspondence: { state: 'complete' } },
    },
  });
  expect(writes).toHaveBeenCalledTimes(1);
  expect(await h.read('a.md')).toContain('🔺');
});
it('releases unpublished immediately aborted edit preparations', async () => {
  const h = await setup('- [ ] Root\n');
  const c = h.client(),
    root = required(ok(await c.tasks.list()).items[0]);
  for (let i = 0; i < 130; i++) {
    const controller = new AbortController();
    const pending = required(c.tasks.prepare)(
      { kind: 'edit', target: root.target, expectedRevision: root.revision },
      { signal: controller.signal },
    );
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, error: { code: 'ABORTED' } });
  }
  expect(
    (
      await required(c.tasks.prepare)({
        kind: 'edit',
        target: root.target,
        expectedRevision: root.revision,
      })
    ).ok,
  ).toBe(true);
  expect(await h.read('a.md')).toBe('- [ ] Root\n');
});
it('does not retire the visible predecessor when native refresh is cancelled before delivery', async () => {
  const h = await setup('- [ ] Root\n');
  const c = h.client(),
    root = required(ok(await c.tasks.list()).items[0]),
    started = deferred<void>(),
    resume = deferred<void>(),
    prepare = h.service.prepare.bind(h.service);
  vi.spyOn(h.service, 'prepare').mockImplementationOnce(async (snapshot, commands) => {
    const native = await prepare(snapshot, commands);
    return native.type !== 'ready'
      ? native
      : {
          ...native,
          refresh: async (current) => {
            started.resolve();
            await resume.promise;
            return await native.refresh(current);
          },
        };
  });
  const p = ok(
    await required(c.tasks.prepare)({
      kind: 'edit',
      target: root.target,
      expectedRevision: root.revision,
    }),
  );
  const controller = new AbortController();
  const pending = required(c.tasks.prepare)(
    { kind: 'refresh', plan: p.target, expectedPlanRevision: p.revision },
    { signal: controller.signal },
  );
  await started.promise;
  controller.abort();
  resume.resolve();
  expect(await pending).toMatchObject({ ok: false, error: { code: 'ABORTED' } });
  const refreshed = ok(
    await required(c.tasks.prepare)({
      kind: 'refresh',
      plan: p.target,
      expectedPlanRevision: p.revision,
    }),
  );
  expect(
    (
      await required(c.tasks.apply)({
        plan: refreshed.target,
        expectedPlanRevision: refreshed.revision,
        requestId: 'after-cancel',
        expiresAt: Date.UTC(2026, 7, 1, 12) + 60000,
      })
    ).ok,
  ).toBe(true);
  expect(await h.read('a.md')).toBe('- [ ] Root\n');
});

it('keeps a concurrently published refresh version when an older refresh delivery is cancelled', async () => {
  const h = await setup('- [ ] Root\n'),
    c = h.client(),
    root = required(ok(await c.tasks.list()).items[0]),
    pause = pauseFirstRefresh(h);
  const p = ok(
      await required(c.tasks.prepare)({
        kind: 'edit',
        target: root.target,
        expectedRevision: root.revision,
      }),
    ),
    controller = new AbortController();
  const pending = required(c.tasks.prepare)(
    { kind: 'refresh', plan: p.target, expectedPlanRevision: p.revision },
    { signal: controller.signal },
  );
  await pause.started.promise;
  const visible = ok(
    await required(c.tasks.prepare)({
      kind: 'refresh',
      plan: p.target,
      expectedPlanRevision: p.revision,
    }),
  );
  controller.abort();
  pause.resume.resolve();
  expect(await pending).toMatchObject({ ok: false, error: { code: 'ABORTED' } });
  const expiresAt = Date.UTC(2026, 7, 1, 12) + 60000;
  expect(
    await required(c.tasks.apply)({
      plan: p.target,
      expectedPlanRevision: p.revision,
      requestId: 'old-visible',
      expiresAt,
    }),
  ).toMatchObject({ ok: false, error: { code: 'PLAN_CONSUMED' } });
  expect(
    (
      await required(c.tasks.apply)({
        plan: visible.target,
        expectedPlanRevision: visible.revision,
        requestId: 'new-visible',
        expiresAt,
      })
    ).ok,
  ).toBe(true);
  expect(await h.read('a.md')).toBe('- [ ] Root\n');
});
it('keeps an independently admitted write while a concurrent refresh is cancelled', async () => {
  const h = await setup('- [ ] Root\n'),
    c = h.client(),
    root = required(ok(await c.tasks.list()).items[0]),
    pause = pauseFirstRefresh(h);
  const p = ok(
      await required(c.tasks.prepare)({
        kind: 'edit',
        target: root.target,
        expectedRevision: root.revision,
      }),
    ),
    controller = new AbortController();
  const pending = required(c.tasks.prepare)(
    { kind: 'refresh', plan: p.target, expectedPlanRevision: p.revision },
    { signal: controller.signal },
  );
  await pause.started.promise;
  const visible = ok(
    await required(c.tasks.prepare)({
      kind: 'append',
      plan: p.target,
      expectedPlanRevision: p.revision,
      operation: {
        type: 'patch',
        target: root.target,
        patch: { priority: { type: 'set', value: 'A' } },
      },
    }),
  );
  const started = deferred<void>(),
    resume = deferred<void>(),
    process = h.app.vault.process.bind(h.app.vault),
    writes = vi.spyOn(h.app.vault, 'process').mockImplementation(async (file, transform) => {
      started.resolve();
      await resume.promise;
      return await process(file, transform);
    });
  const input = {
      plan: visible.target,
      expectedPlanRevision: visible.revision,
      requestId: 'admitted-concurrent',
      expiresAt: Date.UTC(2026, 7, 1, 12) + 60000,
    },
    writing = required(c.tasks.apply)(input);
  await started.promise;
  controller.abort();
  pause.resume.resolve();
  expect(await pending).toMatchObject({ ok: false, error: { code: 'ABORTED' } });
  resume.resolve();
  const saved = await writing;
  expect(saved).toMatchObject({
    ok: true,
    receipt: { effects: 'committed', snapshots: 'complete' },
  });
  expect(await required(c.tasks.apply)(input)).toEqual(saved);
  expect(writes).toHaveBeenCalledTimes(1);
  expect(await h.read('a.md')).toContain('🔺');
});

it('releases unpublished preparations when the final caller-owned signal getter fails', async () => {
  const h = await setup('- [ ] Root\n'),
    c = h.client(),
    root = required(ok(await c.tasks.list()).items[0]);
  for (let i = 0; i < 130; i++) {
    let reads = 0;
    const signal = {
      get aborted() {
        if (++reads === 3) throw new Error('Late signal failure');
        return false;
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    expect(
      await required(c.tasks.prepare)(
        { kind: 'edit', target: root.target, expectedRevision: root.revision },
        { signal },
      ),
    ).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
  }
  expect(
    (
      await required(c.tasks.prepare)({
        kind: 'edit',
        target: root.target,
        expectedRevision: root.revision,
      })
    ).ok,
  ).toBe(true);
  expect(await h.read('a.md')).toBe('- [ ] Root\n');
});

it('retains a refresh predecessor while BOM metadata coverage settles through a public event', async () => {
  const h = await setup('\uFEFF- [ ] Root\n');
  const c = h.client();
  const root = required(ok(await c.tasks.list()).items[0]);
  const prepare = required(c.tasks.prepare);
  const plan = ok(
    await prepare({
      kind: 'edit',
      target: root.target,
      expectedRevision: root.revision,
      operation: { type: 'description', target: root.target, text: 'Sealed description' },
    }),
  );
  const settled = deferred<void>();
  let coverageFailure: unknown;
  const unsubscribe = ok(
    c.subscribe((event) => {
      if (event.type === 'state') return;
      void c.tasks.list().then(
        (result) => {
          if (result.ok) settled.resolve();
        },
        (error: unknown) => {
          coverageFailure = error;
          settled.resolve();
        },
      );
    }),
  );
  const writes = vi.spyOn(h.app.vault, 'process');
  const read = h.app.vault.read.bind(h.app.vault);
  vi.spyOn(h.app.vault, 'read').mockImplementationOnce(async (file) => {
    const text = await read(file);
    metadataChangedEmitter(h.app)(file, text.slice(1), {});
    return text;
  });
  const request = {
    kind: 'refresh' as const,
    plan: plan.target,
    expectedPlanRevision: plan.revision,
  };
  const refused = await prepare(request);
  await settled.promise;
  expect(coverageFailure).toBeUndefined();
  const refreshed = ok(await prepare(request));
  expect(refreshed.after?.description).toBe('Sealed description');
  expect(writes).not.toHaveBeenCalled();
  expect(refused).toMatchObject({ ok: false, error: { code: 'INCOMPLETE_READ' } });
  unsubscribe();
});

it('refines initial status through opaque current plan handles', async () => {
  const h = await setup('- [ ] Existing\n');
  const c = h.client();
  const p = ok(
    await required(c.tasks.prepare)({
      kind: 'create',
      destination: { type: 'note', path: 'a.md', insertion: { type: 'append' } },
      tree: { markdownTitle: 'New' },
    }),
  );
  const next = ok(
    await required(c.tasks.prepare)({
      kind: 'append',
      plan: p.target,
      expectedPlanRevision: p.revision,
      operation: {
        type: 'set-initial-status',
        target: required(p.after ?? undefined).target,
        symbol: 'x',
      },
    }),
  );
  expect(next.after?.status).toBe('done');
  expect(await h.read('a.md')).toBe('- [ ] Existing\n');
});
it('admits UTF-8 preparation input at the advertised cap and rejects one byte above before native work', async () => {
  const h = await setup('- [ ] Existing\n');
  const c = h.client();
  const cap = required(c.info.contentLimits).maxPreparationInputBytes;
  const input = {
    kind: 'create' as const,
    destination: { type: 'note' as const, path: 'a.md', insertion: { type: 'append' as const } },
    tree: { markdownTitle: 'New', description: '' },
  };
  const overhead = new TextEncoder().encode(JSON.stringify(input)).length;
  input.tree.description =
    'é'.repeat(Math.floor((cap - overhead) / 2)) + 'a'.repeat((cap - overhead) % 2);
  const native = vi.spyOn(h.service, 'prepareCreateTree');
  expect((await required(c.tasks.prepare)(input)).ok).toBe(true);
  expect(native).toHaveBeenCalledTimes(1);
  input.tree.description += 'a';
  expect(await required(c.tasks.prepare)(input)).toMatchObject({
    ok: false,
    error: { code: 'INVALID_ARGUMENT' },
  });
  expect(native).toHaveBeenCalledTimes(1);
});
it('copies a revision-selected source subtree and returns exact fresh task/comment correspondence', async () => {
  const h = await setup(
    '- [ ] Target\n- [x] Source [unknown:: keep]\n  - 2020-01-02: Old\n  - [ ] Same\n  - [ ] Same\n',
  );
  const c = h.client();
  const roots = ok(await c.tasks.list()).items;
  const target = required(roots[0]),
    source = required(roots[1]);
  const p = ok(
    await required(c.tasks.prepare)({
      kind: 'edit',
      target: target.target,
      expectedRevision: target.revision,
    }),
  );
  const copied = ok(
    await required(c.tasks.prepare)({
      kind: 'append',
      plan: p.target,
      expectedPlanRevision: p.revision,
      operation: {
        type: 'copy-subtree',
        source: source.target,
        expectedSourceRevision: source.revision,
        target: required(p.after ?? undefined).target,
      },
    }),
  );
  const evidence = required(copied.copies?.[0]);
  expect(evidence.state).toBe('retained');
  expect(evidence.tasks).toHaveLength(3);
  expect(evidence.comments).toHaveLength(1);
  expect(new Set(evidence.tasks.map((t) => t.destinationTarget)).size).toBe(3);
  expect(evidence.tasks[0]?.destinationTarget).not.toBe(source.target);
  expect(
    await required(c.tasks.prepare)({
      kind: 'append',
      plan: p.target,
      expectedPlanRevision: p.revision,
      operation: {
        type: 'copy-subtree',
        source: source.target,
        expectedSourceRevision: 'old',
        target: required(p.after ?? undefined).target,
      },
    }),
  ).toMatchObject({ ok: false, error: { code: 'REVISION_CONFLICT' } });
  const saved = await required(c.tasks.apply)({
    plan: copied.target,
    expectedPlanRevision: copied.revision,
    requestId: 'copy',
    expiresAt: Date.UTC(2026, 7, 1, 12) + 60000,
  });
  expect(saved.ok).toBe(true);
  expect(saved.receipt?.contentContinuity.correspondence.state).toBe('complete');
  const map = saved.receipt?.contentContinuity.correspondence;
  expect(map?.state === 'complete' ? map.comments : undefined).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ preparedTarget: evidence.comments[0]?.destinationTarget }),
    ]),
  );
});
it('binds merge coverage to one plan revision and clears it on a later edit', async () => {
  const h = await setup('- [ ] Target\n  - > Source\n- [ ] Source\n');
  const c = h.client();
  const roots = ok(await c.tasks.list()).items;
  const target = required(roots[0]),
    source = required(roots[1]);
  const p = ok(
    await required(c.tasks.prepare)({
      kind: 'edit',
      target: target.target,
      expectedRevision: target.revision,
    }),
  );
  const assessed = ok(
    await required(c.tasks.prepare)({
      kind: 'append',
      plan: p.target,
      expectedPlanRevision: p.revision,
      operation: {
        type: 'assess-merge',
        source: source.target,
        expectedSourceRevision: source.revision,
        target: required(p.after ?? undefined).target,
      },
    }),
  );
  expect(assessed.mergePreservation).toMatchObject({
    state: 'covered',
    sourceRoot: { target: source.target, revision: source.revision },
    planRevision: assessed.revision,
  });
  const edited = ok(
    await required(c.tasks.prepare)({
      kind: 'append',
      plan: assessed.target,
      expectedPlanRevision: assessed.revision,
      operation: {
        type: 'description',
        target: required(assessed.after ?? undefined).target,
        text: null,
      },
    }),
  );
  expect(edited.mergePreservation).toBeUndefined();
  expect(await h.read('a.md')).toBe('- [ ] Target\n  - > Source\n- [ ] Source\n');
});
it('moves one selected same-root duplicate comment through copy and exact original-source continuation', async () => {
  const h = await setup('- [ ] Root\r\n  - Same\r\n  - Same\r\n  - [ ] Child\r\n');
  const c = h.client();
  const root = required(ok(await c.tasks.list()).items[0]);
  const tree = ok(await required(c.tasks.tree)({ target: root.target })).tree;
  const selected = required(tree.comments[0]);
  let p = ok(
    await required(c.tasks.prepare)({
      kind: 'edit',
      target: root.target,
      expectedRevision: root.revision,
    }),
  );
  p = ok(
    await required(c.tasks.prepare)({
      kind: 'append',
      plan: p.target,
      expectedPlanRevision: p.revision,
      operation: {
        type: 'copy-comment',
        source: selected.target,
        target: required(p.after?.children[0]).target,
      },
    }),
  );
  p = ok(
    await required(c.tasks.prepare)({
      kind: 'append',
      plan: p.target,
      expectedPlanRevision: p.revision,
      operation: { type: 'remove-comment', target: selected.target },
    }),
  );
  expect(p.after?.comments).toHaveLength(1);
  const child = ok(
    await required(c.tasks.tree)({
      plan: p.target,
      expectedPlanRevision: p.revision,
      target: required(p.after?.children[0]).target,
    }),
  ).tree;
  expect(child.comments).toHaveLength(1);
  expect(await h.read('a.md')).toBe('- [ ] Root\r\n  - Same\r\n  - Same\r\n  - [ ] Child\r\n');
  expect(
    (
      await required(c.tasks.apply)({
        plan: p.target,
        expectedPlanRevision: p.revision,
        requestId: 'move-comment',
        expiresAt: Date.UTC(2026, 7, 1, 12) + 60000,
      })
    ).ok,
  ).toBe(true);
});
it('preserves known commit effects when comment receipt allocation is unavailable', async () => {
  const h = await setup('- [ ] Root\n');
  const c = h.client();
  const root = required(ok(await c.tasks.list()).items[0]);
  const p = ok(
    await required(c.tasks.prepare)({
      kind: 'edit',
      target: root.target,
      expectedRevision: root.revision,
      operation: { type: 'add-comment', target: root.target, text: 'Saved' },
    }),
  );
  const allocation = vi.spyOn(TaskTreeReader.prototype, 'entry').mockImplementationOnce(() => {
    throw new Error('Content entry capacity exhausted');
  });
  const input = {
    plan: p.target,
    expectedPlanRevision: p.revision,
    requestId: 'comment-proof-unavailable',
    expiresAt: Date.UTC(2026, 7, 1, 12) + 60000,
  };
  const result = await required(c.tasks.apply)(input);
  allocation.mockRestore();
  expect(result).toMatchObject({
    ok: true,
    receipt: {
      effects: 'committed',
      snapshots: 'unavailable',
      contentContinuity: { correspondence: { state: 'unavailable' } },
    },
  });
  expect(await required(c.tasks.apply)(input)).toEqual(result);
  expect((await h.read('a.md')).match(/Saved/gu)).toHaveLength(1);
});

it.each([true, false])(
  'separates accepted and unchanged draft comment capabilities (accepted first: %s)',
  async (acceptedFirst) => {
    const h = await setup('- [ ] Source\n  - Saved\n- [ ] Target\n');
    const c = h.client();
    const roots = ok(await c.tasks.list()).items;
    const source = required(roots[0]),
      target = required(roots[1]);
    const accepted = acceptedFirst
      ? ok(await required(c.tasks.tree)({ target: source.target })).tree
      : undefined;
    const draft = ok(
      await required(c.tasks.prepare)({
        kind: 'edit',
        target: source.target,
        expectedRevision: source.revision,
      }),
    );
    const live = accepted ?? ok(await required(c.tasks.tree)({ target: source.target })).tree;
    const destination = ok(
      await required(c.tasks.prepare)({
        kind: 'edit',
        target: target.target,
        expectedRevision: target.revision,
      }),
    );
    const copy = (handle: string) =>
      required(c.tasks.prepare)({
        kind: 'append',
        plan: destination.target,
        expectedPlanRevision: destination.revision,
        operation: {
          type: 'copy-comment',
          source: handle,
          target: required(destination.after ?? undefined).target,
        },
      });
    expect(await copy(required(draft.after?.comments[0]).target)).toMatchObject({
      ok: false,
      error: { code: 'STALE_TARGET' },
    });
    expect(ok(await copy(required(live.comments[0]).target)).copies?.[0]?.state).toBe('retained');
  },
);

it.each(['![[#Section]]', '![photo](./photo.png)', '[[#Section]]'])(
  'does not certify cross-file flat merge description reference %s',
  async (description) => {
    const sourceText = `- [ ] Same\n\t- > ${description}\n\n# Section\nSource\n`;
    const targetText = `- [ ] Same\n\t- > ${description}\n\n# Section\nDestination\n`;
    const h = await publicApiHarness({ 'A/source.md': sourceText, 'B/target.md': targetText });
    owners.push(h);
    const c = h.client();
    const roots = ok(await c.tasks.list()).items;
    const source = required(roots.find((r) => r.source.path === 'A/source.md'));
    const target = required(roots.find((r) => r.source.path === 'B/target.md'));
    const p = ok(
      await required(c.tasks.prepare)({
        kind: 'edit',
        target: target.target,
        expectedRevision: target.revision,
      }),
    );
    const report = ok(
      await required(c.tasks.prepare)({
        kind: 'append',
        plan: p.target,
        expectedPlanRevision: p.revision,
        operation: {
          type: 'assess-merge',
          source: source.target,
          expectedSourceRevision: source.revision,
          target: required(p.after ?? undefined).target,
        },
      }),
    ).mergePreservation;
    expect(report?.state).toBe('held');
    expect(report?.entries).toContainEqual(
      expect.objectContaining({ kind: 'constraint', field: 'description-links', state: 'held' }),
    );
    expect(await h.read('A/source.md')).toBe(sourceText);
    expect(await h.read('B/target.md')).toBe(targetText);
  },
);

it('reorders exact duplicate siblings in a retained preparation with descendant and comment correspondence', async () => {
  const original =
    '- [ ] Root\r\n  - [ ] Same\r\n    - [ ] First descendant\r\n    - 2026-08-01: First comment\r\n  - [ ] Same\r\n    - [ ] Second descendant\r\n    - 2026-08-01: Second comment\r\n- [ ] Unrelated\r\n';
  const h = await setup(original);
  const c = h.client();
  const root = required(ok(await c.tasks.list()).items[0]);
  const initial = ok(
    await required(c.tasks.prepare)({
      kind: 'edit',
      target: root.target,
      expectedRevision: root.revision,
    }),
  );
  const before = ok(
    await required(c.tasks.tree)({
      target: root.target,
      plan: initial.target,
      expectedPlanRevision: initial.revision,
      side: 'after',
      limit: 500,
    }),
  ).tree;
  const first = required(before.children[0]);
  const second = ok(
    await required(c.tasks.tree)({
      target: required(before.children[1]).target,
      plan: initial.target,
      expectedPlanRevision: initial.revision,
      limit: 500,
    }),
  ).tree;
  const reordered = ok(
    await required(c.tasks.prepare)({
      kind: 'append',
      plan: initial.target,
      expectedPlanRevision: initial.revision,
      operation: {
        type: 'reorder',
        target: second.target,
        relativeTo: first.target,
        placement: 'before',
      },
    }),
  );
  const after = ok(
    await required(c.tasks.tree)({
      target: root.target,
      plan: reordered.target,
      expectedPlanRevision: reordered.revision,
      side: 'after',
      limit: 500,
    }),
  ).tree;
  expect(after.children.map((node) => node.target)).toEqual([second.target, first.target]);
  const moved = ok(
    await required(c.tasks.tree)({
      target: second.target,
      plan: reordered.target,
      expectedPlanRevision: reordered.revision,
      limit: 500,
    }),
  ).tree;
  expect(moved.children[0]?.target).toBe(second.children[0]?.target);
  expect(moved.comments[0]?.text).toBe('Second comment');
  expect(await h.read('a.md')).toBe(original);
  const refined = ok(
    await required(c.tasks.prepare)({
      kind: 'append',
      plan: reordered.target,
      expectedPlanRevision: reordered.revision,
      operation: { type: 'description', target: second.target, text: 'Exact moved child' },
    }),
  );
  const result = await required(c.tasks.apply)({
    plan: refined.target,
    expectedPlanRevision: refined.revision,
    requestId: 'reorder-save',
    expiresAt: Date.UTC(2026, 7, 1, 12) + 60000,
  });
  expect(result.ok).toBe(true);
  expect(result.receipt?.contentContinuity.correspondence.state).toBe('complete');
  const saved = await h.read('a.md');
  expect(saved.indexOf('Second descendant')).toBeLessThan(saved.indexOf('First descendant'));
  expect(saved).toContain('First comment\r\n- [ ] Unrelated\r\n');
  const current = ok(await required(c.tasks.tree)({ target: root.target })).tree;
  expect(current.children[0]?.description).toBe('Exact moved child');
  expect(current.children[1]?.description).toBeUndefined();
});

it('prepares a multi-root hierarchy through the content facade and maps the exact moved duplicate after commit', async () => {
  const h = await publicApiHarness({
    'source.md': '- [ ] Source\n  - [ ] Same\n    - [ ] Kept\n  - [ ] Same\n    - [ ] Moved\n',
    'target.md': '- [ ] Destination\n  - [ ] Same\n    - [ ] Existing\n',
  });
  owners.push(h);
  const c = h.client();
  const listed = ok(await c.tasks.list()).items;
  const children = listed.filter(
    (node) => node.title === 'Same' && node.source.path === 'source.md',
  );
  const source = required(children[1]);
  const parent = required(listed.find((node) => node.title === 'Destination'));
  const prepared = ok(
    await required(c.tasks.prepare)({
      kind: 'hierarchy',
      operation: {
        type: 'reparent',
        source: source.target,
        expectedSourceRevision: source.revision,
        parent: parent.target,
        expectedParentRevision: parent.revision,
      },
    }),
  );
  expect(prepared.kind).toBe('hierarchy');
  expect(prepared.before?.target).toBe(source.target);
  expect(prepared.after?.target).toBe(source.target);
  expect(prepared.affected?.before).toHaveLength(2);
  expect(prepared.affected?.after).toHaveLength(2);
  const after = ok(
    await required(c.tasks.tree)({
      target: source.target,
      plan: prepared.target,
      expectedPlanRevision: prepared.revision,
      limit: 500,
    }),
  ).tree;
  expect(after.children[0]?.title).toBe('Moved');
  expect(await h.read('source.md')).toContain('    - [ ] Moved');
  const input = {
    plan: prepared.target,
    expectedPlanRevision: prepared.revision,
    requestId: 'hierarchy',
    expiresAt: Date.UTC(2026, 7, 1, 12) + 60000,
  };
  const saved = await required(c.tasks.apply)(input);
  expect(saved.ok).toBe(true);
  expect(saved.receipt?.contentContinuity.correspondence.state).toBe('complete');
  expect(await required(c.tasks.apply)(input)).toEqual(saved);
  expect(await h.read('source.md')).toBe('- [ ] Source\n  - [ ] Same\n    - [ ] Kept\n');
  expect(await h.read('target.md')).toContain('- [ ] Existing\n  - [ ] Same\n    - [ ] Moved');
});

it.each([
  { mode: 'same-file', sourceLine: 5, parentPath: 'source.md', parentLine: 11, after: 'both' },
  { mode: 'cross-file', sourceLine: 5, parentPath: 'target.md', parentLine: 2, after: 'both' },
  { mode: 'promote', sourceLine: 5, parentPath: 'target.md', parentLine: 2, after: 'promoted' },
  { mode: 'root', sourceLine: 2, parentPath: 'target.md', parentLine: 2, after: 'destination' },
] as const)(
  'limits $mode hierarchy review to exact participating roots while retaining unrelated duplicates',
  async ({ mode, sourceLine, parentPath, parentLine, after }) => {
    const sourceText =
      '- [ ] Duplicate\n  - > Unrelated before\n- [ ] Source\n  - [ ] Same\n    - > First child\n  - [ ] Same\n    - > Second child\n- [ ] Duplicate\n  - > Unrelated after\n';
    const targetText =
      '- [ ] Duplicate\n  - > Unrelated target\n- [ ] Destination\n  - [ ] Same\n    - > Existing child\n';
    const files =
      mode === 'same-file'
        ? { 'source.md': sourceText + targetText }
        : { 'source.md': sourceText, 'target.md': targetText };
    const h = await publicApiHarness(files);
    owners.push(h);
    const c = h.client();
    const listed = ok(await c.tasks.list()).items;
    const root = required(
      listed.find((node) => node.source.path === 'source.md' && node.source.line === 2),
    );
    const source = required(
      listed.find((node) => node.source.path === 'source.md' && node.source.line === sourceLine),
    );
    const parent = required(
      listed.find((node) => node.source.path === parentPath && node.source.line === parentLine),
    );
    const plan = ok(
      await required(c.tasks.prepare)({
        kind: 'hierarchy',
        operation:
          mode === 'promote'
            ? { type: 'promote', source: source.target, expectedSourceRevision: source.revision }
            : {
                type: 'reparent',
                source: source.target,
                expectedSourceRevision: source.revision,
                parent: parent.target,
                expectedParentRevision: parent.revision,
              },
      }),
    );
    expect(plan.affected?.before.map((node) => node.target)).toEqual(
      mode === 'promote' ? [root.target] : [root.target, parent.target],
    );
    const afterTargets = {
      promoted: [root.target, source.target],
      destination: [parent.target],
      both: [root.target, parent.target],
    };
    expect(new Set(plan.affected?.after.map((node) => node.target))).toEqual(
      new Set(afterTargets[after]),
    );
    expect(plan.after?.target).toBe(source.target);
    const saved = await required(c.tasks.apply)({
      plan: plan.target,
      expectedPlanRevision: plan.revision,
      requestId: `scoped-${mode}`,
      expiresAt: Date.UTC(2026, 7, 1, 12) + 60000,
    });
    expect(saved.ok).toBe(true);
    expect(saved.receipt?.contentContinuity.correspondence.state).toBe('complete');
    const allText = (await Promise.all(Object.keys(files).map((path) => h.read(path)))).join('');
    for (const text of [
      'Unrelated before',
      'Unrelated after',
      'Unrelated target',
      'First child',
      'Second child',
      'Existing child',
    ])
      expect(allText.split(text)).toHaveLength(2);
  },
);

it('rejects hierarchy cycles and stale parent revisions while preserving a live review', async () => {
  const h = await setup('- [ ] Root\n  - [ ] Child\n    - [ ] Deep\n- [ ] Parent\n');
  const c = h.client(),
    listed = ok(await c.tasks.list()).items;
  const root = required(listed.find((n) => n.title === 'Root'));
  const child = required(listed.find((n) => n.title === 'Child'));
  const deep = required(listed.find((n) => n.title === 'Deep'));
  const parent = required(listed.find((n) => n.title === 'Parent'));
  const prepare = required(c.tasks.prepare);
  expect(
    await prepare({
      kind: 'hierarchy',
      operation: {
        type: 'reparent',
        source: root.target,
        expectedSourceRevision: root.revision,
        parent: deep.target,
        expectedParentRevision: deep.revision,
      },
    }),
  ).toMatchObject({ ok: false });
  expect(
    await prepare({
      kind: 'hierarchy',
      operation: {
        type: 'reparent',
        source: child.target,
        expectedSourceRevision: child.revision,
        parent: parent.target,
        expectedParentRevision: 'stale',
      },
    }),
  ).toMatchObject({ ok: false });
  const p = ok(
    await prepare({
      kind: 'hierarchy',
      operation: { type: 'promote', source: child.target, expectedSourceRevision: child.revision },
    }),
  );
  expect(p.after?.target).toBe(child.target);
  expect(p.after?.parentTarget).toBeUndefined();
  expect(p.affected?.after.map((node) => node.target)).toEqual([root.target, child.target]);
  expect(
    await prepare({
      kind: 'append',
      plan: p.target,
      expectedPlanRevision: p.revision,
      operation: { type: 'description', target: child.target, text: 'Not silently composed' },
    }),
  ).toMatchObject({ ok: false, error: { code: 'HIERARCHY_REVIEW' } });
  const saved = await required(c.tasks.apply)({
    plan: p.target,
    expectedPlanRevision: p.revision,
    requestId: 'promote',
    expiresAt: Date.UTC(2026, 7, 1, 12) + 60000,
  });
  expect(saved.receipt?.contentContinuity.correspondence.state).toBe('complete');
  expect(await h.read('a.md')).toBe('- [ ] Root\n- [ ] Child\n  - [ ] Deep\n- [ ] Parent\n');
});

it('retains unknown native hierarchy effects and never replays a failed cross-note movement', async () => {
  const h = await publicApiHarness({ 'source.md': '- [ ] Move\n', 'target.md': '- [ ] Parent\n' });
  owners.push(h);
  const c = h.client(),
    listed = ok(await c.tasks.list()).items;
  const source = required(listed.find((n) => n.title === 'Move')),
    parent = required(listed.find((n) => n.title === 'Parent'));
  const p = ok(
    await required(c.tasks.prepare)({
      kind: 'hierarchy',
      operation: {
        type: 'reparent',
        source: source.target,
        expectedSourceRevision: source.revision,
        parent: parent.target,
        expectedParentRevision: parent.revision,
      },
    }),
  );
  const process = h.app.vault.process.bind(h.app.vault);
  let effects = 0;
  vi.spyOn(h.app.vault, 'process').mockImplementation(async (file, transform, options) => {
    effects++;
    if (file.path === 'source.md' || effects > 1)
      throw new Error('Source failed; compensation unavailable');
    return process(file, transform, options);
  });
  const input = {
    plan: p.target,
    expectedPlanRevision: p.revision,
    requestId: 'uncertain-hierarchy',
    expiresAt: Date.UTC(2026, 7, 1, 12) + 60000,
  };
  const saved = await required(c.tasks.apply)(input);
  expect(saved).toMatchObject({
    ok: false,
    effects: 'unknown',
    recovery: 'reconcile',
    receipt: { contentContinuity: { correspondence: { state: 'unavailable' } } },
  });
  const count = effects;
  await required(c.tasks.apply)(input);
  await required(c.tasks.apply)({ ...input, requestId: 'do-not-repeat' });
  expect(effects).toBe(count);
  expect(await h.read('source.md')).toBe('- [ ] Move\n');
  expect(await h.read('target.md')).toContain('- [ ] Move');
});

it('previews an already-parented hierarchy as unchanged without reserving or writing', async () => {
  const h = await setup('- [ ] Root\n  - [ ] Child\n- [ ] Other\n');
  const c = h.client(),
    items = ok(await c.tasks.list()).items;
  const root = required(items.find((n) => n.title === 'Root')),
    child = required(items.find((n) => n.title === 'Child'));
  const reserve = vi.spyOn(h.authority, 'reserveStructuralMutation'),
    write = vi.spyOn(h.app.vault, 'process');
  const p = ok(
    await required(c.tasks.prepare)({
      kind: 'hierarchy',
      operation: {
        type: 'reparent',
        source: child.target,
        expectedSourceRevision: child.revision,
        parent: root.target,
        expectedParentRevision: root.revision,
      },
    }),
  );
  const result = await required(c.tasks.apply)({
    plan: p.target,
    expectedPlanRevision: p.revision,
    requestId: 'unchanged-hierarchy',
    expiresAt: Date.UTC(2026, 7, 1, 12) + 60000,
  });
  expect(result).toMatchObject({
    ok: true,
    receipt: { effects: 'unchanged', contentContinuity: { correspondence: { state: 'complete' } } },
  });
  expect(reserve).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});

it('withholds every hierarchy view and admission when the destination becomes undisclosable', async () => {
  const h = await publicApiHarness({ 'source.md': '- [ ] Move\n', 'target.md': '- [ ] Parent\n' });
  owners.push(h);
  const c = h.client(),
    items = ok(await c.tasks.list()).items;
  const source = required(items.find((n) => n.title === 'Move')),
    parent = required(items.find((n) => n.title === 'Parent'));
  const p = ok(
    await required(c.tasks.prepare)({
      kind: 'hierarchy',
      operation: {
        type: 'reparent',
        source: source.target,
        expectedSourceRevision: source.revision,
        parent: parent.target,
        expectedParentRevision: parent.revision,
      },
    }),
  );
  vi.spyOn(h.reads, 'canDisclose').mockImplementation(
    (address) => address.filePath !== 'target.md',
  );
  expect(
    await required(c.tasks.tree)({
      target: source.target,
      plan: p.target,
      expectedPlanRevision: p.revision,
    }),
  ).toMatchObject({ ok: false });
  expect(
    await required(c.tasks.apply)({
      plan: p.target,
      expectedPlanRevision: p.revision,
      requestId: 'hidden-hierarchy',
      expiresAt: Date.UTC(2026, 7, 1, 12) + 60000,
    }),
  ).toMatchObject({ ok: false, effects: 'unchanged' });
  expect(await h.read('source.md')).toBe('- [ ] Move\n');
  expect(await h.read('target.md')).toBe('- [ ] Parent\n');
});

it.each(['untagged', 'tag', 'both'] as const)(
  'prepares Inbox intent with the native %s policy',
  async (mode) => {
    const behaviorSettings = () => ({
      taskPrefix: '#task/one-off',
      applyTaskPrefixToSubtasks: true,
      inbox: { mode, tag: '#task/inbox', removeTagOnAssign: true },
      taskLifecycle: { addCreatedDate: false, addCompletionDate: false },
      recurrence: { newOccurrencePlacement: 'after' as const, removeScheduledDate: false },
    });
    const h = await publicApiHarness(
      { 'a.md': '- [ ] Existing\n' },
      { provision: true, behaviorSettings },
    );
    owners.push(h);
    const api = h.client();
    const p = ok(
      await required(api.tasks.prepare)({
        kind: 'create',
        intent: 'inbox',
        destination: { type: 'configured-default' },
        tree: { markdownTitle: 'Gym' },
      }),
    );
    expect(p.after?.tags).toEqual(mode === 'untagged' ? [] : ['#task/inbox']);
    expect(await h.read('a.md')).toBe('- [ ] Existing\n');
    const request = {
      plan: p.target,
      expectedPlanRevision: p.revision,
      requestId: `inbox-${mode}`,
      expiresAt: Date.UTC(2026, 7, 1, 12) + 60000,
    };
    const saved = await required(api.tasks.create)(request);
    if (!saved.ok) throw new Error(JSON.stringify(saved));
    expect(await required(api.tasks.create)(request)).toEqual(saved);
    expect((await h.read('a.md')).match(/Gym/gu)).toHaveLength(1);
  },
);

it('lists canonical Inbox membership with pagination and rejects changed policy', async () => {
  const behavior = {
    taskPrefix: '#task/one-off',
    applyTaskPrefixToSubtasks: false,
    inbox: {
      mode: 'both' as 'tag' | 'both' | 'untagged',
      tag: '#task/inbox',
      removeTagOnAssign: true,
    },
    taskLifecycle: { addCreatedDate: false, addCompletionDate: false },
    recurrence: { newOccurrencePlacement: 'after' as const, removeScheduledDate: false },
  };
  const h = await publicApiHarness(
    { 'a.md': '- [ ] Untagged\n  - [ ] Child\n- [ ] Tagged #task/inbox\n- [ ] Other #work\n' },
    { behaviorSettings: () => behavior },
  );
  owners.push(h);
  const api = h.client();
  const first = ok(await api.tasks.list({ inbox: true, limit: 1 }));
  expect(first.items.map((x) => x.title)).toEqual(['Untagged']);
  const second = ok(
    await api.tasks.list({ inbox: true, limit: 1, cursor: required(first.nextCursor) }),
  );
  expect(second.items.map((x) => x.title)).toEqual(['Tagged']);
  expect(
    ok(
      await api.tasks.list({ inbox: true, tagsAll: ['#task/inbox'], statuses: ['open'] }),
    ).items.map((x) => x.title),
  ).toEqual(['Tagged']);
  expect(ok(await api.tasks.list({ inbox: false })).items.map((x) => x.title)).toEqual([
    'Child',
    'Other',
  ]);
  behavior.inbox.mode = 'tag';
  expect(
    await api.tasks.list({ inbox: true, limit: 1, cursor: required(first.nextCursor) }),
  ).toMatchObject({ ok: false, error: { code: 'STALE_CURSOR' } });
});

it('searches only Inbox members using the frozen policy', async () => {
  const behavior = {
    taskPrefix: '',
    applyTaskPrefixToSubtasks: false,
    inbox: { mode: 'both' as const, tag: '#task/inbox', removeTagOnAssign: true },
    taskLifecycle: { addCreatedDate: false, addCompletionDate: false },
    recurrence: { newOccurrencePlacement: 'after' as const, removeScheduledDate: false },
  };
  const h = await publicApiHarness(
    {
      'a.md': '- [ ] Gym\n  - [ ] Gym child\n- [ ] Gym tagged #task/inbox\n- [ ] Gym other #work\n',
    },
    { behaviorSettings: () => behavior },
  );
  owners.push(h);
  const result = ok(await required(h.client().tasks.search)({ query: 'Gym', inbox: true }));
  expect(result.items.map((x) => x.title).sort((a, b) => a.localeCompare(b))).toEqual([
    'Gym',
    'Gym tagged',
  ]);
});

it('rejects Inbox search when its policy changes during the search', async () => {
  const h = await setup('- [ ] Gym\n');
  const original = h.service.creationPolicy.bind(h.service);
  const first = original();
  vi.spyOn(h.service, 'creationPolicy')
    .mockReturnValueOnce(first)
    .mockReturnValue({ ...first, inbox: { ...first.inbox, mode: 'tag', serviceTag: '#inbox' } });
  const result = await required(h.client().tasks.search)({ query: 'Gym', inbox: true });
  expect(result).toMatchObject({ ok: false, error: { code: 'INCOMPLETE_READ' } });
});

it('exposes ordinary and Inbox defaults through the optional policy read', async () => {
  const settings = {
    taskPrefix: '#task/one-off',
    applyTaskPrefixToSubtasks: false,
    inbox: { mode: 'both' as const, tag: '#task/inbox', removeTagOnAssign: true },
    taskLifecycle: { addCreatedDate: false, addCompletionDate: false },
    recurrence: { newOccurrencePlacement: 'after' as const, removeScheduledDate: false },
  };
  const h = await publicApiHarness({ 'a.md': '' }, { behaviorSettings: () => settings });
  owners.push(h);
  expect(ok(await required(h.client().tasks.creationPolicy)())).toMatchObject({
    taskPrefix: '#task/one-off',
    defaultTags: ['#task/one-off'],
    inbox: { mode: 'both', serviceTag: '#task/inbox' },
  });
});

it('binds Inbox search cursors to membership policy', async () => {
  const behavior = {
    taskPrefix: '',
    applyTaskPrefixToSubtasks: false,
    inbox: { mode: 'both' as 'tag' | 'both', tag: '#task/inbox', removeTagOnAssign: true },
    taskLifecycle: { addCreatedDate: false, addCompletionDate: false },
    recurrence: { newOccurrencePlacement: 'after' as const, removeScheduledDate: false },
  };
  const h = await publicApiHarness(
    { 'a.md': '- [ ] Gym one\n- [ ] Gym two #task/inbox\n' },
    { behaviorSettings: () => behavior },
  );
  owners.push(h);
  const search = required(h.client().tasks.search);
  const page = ok(await search({ query: 'Gym', inbox: true, limit: 1 }));
  behavior.inbox.mode = 'tag';
  expect(
    await search({ query: 'Gym', inbox: true, limit: 1, cursor: required(page.nextCursor) }),
  ).toMatchObject({ ok: false, error: { code: 'STALE_CURSOR' } });
});

it('preserves ordinary defaults and honors exact Inbox service-tag removals', async () => {
  const behavior = {
    taskPrefix: '#task/one-off',
    applyTaskPrefixToSubtasks: false,
    inbox: { mode: 'both' as 'both' | 'tag', tag: '#task/inbox', removeTagOnAssign: true },
    taskLifecycle: { addCreatedDate: false, addCompletionDate: false },
    recurrence: { newOccurrencePlacement: 'after' as const, removeScheduledDate: false },
  };
  const h = await publicApiHarness(
    { 'a.md': '' },
    { provision: true, behaviorSettings: () => behavior },
  );
  owners.push(h);
  const prepare = required(h.client().tasks.prepare);
  const base = {
    kind: 'create' as const,
    destination: { type: 'configured-default' as const },
    tree: { markdownTitle: 'Gym' },
  };
  expect(ok(await prepare(base)).after?.tags).toEqual(['#task/one-off']);
  expect(
    ok(await prepare({ ...base, tree: { markdownTitle: 'Gym', initial: { tags: { add: [] } } } }))
      .after?.tags,
  ).toEqual(['#task/one-off']);
  const without = {
    ...base,
    intent: 'inbox' as const,
    tree: { markdownTitle: 'Gym', initial: { tags: { remove: ['#task/inbox'] } } },
  };
  expect(ok(await prepare(without)).after?.tags).toEqual([]);
  behavior.inbox.mode = 'tag';
  expect(await prepare(without)).toMatchObject({ ok: false });
  expect(await h.read('a.md')).toBe('');
});

it('rejects Inbox filtering without a policy port while preserving ordinary reads', async () => {
  const h = await publicApiHarness(
    { 'a.md': '- [ ] Gym\n' },
    { policyAvailable: false, provision: true },
  );
  owners.push(h);
  const api = h.client();
  expect(ok(await api.tasks.list()).items).toHaveLength(1);
  expect(
    (
      await required(api.tasks.prepare)({
        kind: 'create',
        destination: { type: 'configured-default' },
        tree: { markdownTitle: 'Ordinary' },
      })
    ).ok,
  ).toBe(true);
  expect(
    await required(api.tasks.prepare)({
      kind: 'create',
      intent: 'inbox',
      destination: { type: 'configured-default' },
      tree: { markdownTitle: 'New' },
    }),
  ).toMatchObject({ ok: false, error: { code: 'INBOX_POLICY_UNAVAILABLE' } });
  expect(await api.tasks.list({ inbox: true })).toMatchObject({
    ok: false,
    error: { code: 'INBOX_POLICY_UNAVAILABLE' },
  });
  expect(ok(await required(api.tasks.search)({ query: 'Gym' })).items).toHaveLength(1);
  expect(await required(api.tasks.search)({ query: 'Gym', inbox: true })).toMatchObject({
    ok: false,
    error: { code: 'INBOX_POLICY_UNAVAILABLE' },
  });
});
