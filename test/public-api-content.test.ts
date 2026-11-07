import { afterEach, expect, it, vi } from 'vitest';
import type { ApiResultV1 } from '../api';
import { deferred } from './helpers';
import { publicApiHarness, type PublicApiHarness } from './support/publicApiHarness';
const owners: PublicApiHarness[] = [];
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
