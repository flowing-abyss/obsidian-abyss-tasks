import { afterEach, expect, it } from 'vitest';
import type { ApiResultV1, ApplyTaskContentV1, ContentPlanV1 } from '../api';
import { TaskApiProvider } from '../src/integrations/TaskApiProvider';
import { useRealMoment } from './helpers';
import { taskCreatePreparationHarness } from './support/taskCreatePreparationHarness';
useRealMoment();
const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.splice(0).forEach((fn) => {
    fn();
  });
});
function ok<T>(r: ApiResultV1<T>): T {
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing fixture');
  return value;
}
async function setup() {
  const h = await taskCreatePreparationHarness();
  const now = Date.UTC(2026, 10, 7, 12);
  const provider = new TaskApiProvider({
    reads: h.index.integrationReads(),
    mutations: h.service,
    content: { edits: h.service, creates: h.service, statuses: () => h.catalog.all() },
    pluginVersion: 'test',
    epoch: `refresh-${crypto.randomUUID()}`,
    now: () => now,
    diagnostic: () => {},
  });
  cleanup.push(() => {
    provider.dispose();
    h.index.destroy();
  });
  const client = (consumerId = 'same') => ok(provider.getApi(1, { consumerId }));
  return { ...h, client, now };
}
function mutation(plan: ContentPlanV1, requestId: string, now: number): ApplyTaskContentV1 {
  return {
    plan: plan.target,
    expectedPlanRevision: plan.revision,
    requestId,
    expiresAt: now + 60000,
  };
}
it('adopts a newly provisioned note only from same-consumer proven successful task insertion', async () => {
  const h = await setup(),
    c = h.client(),
    prepare = required(c.tasks.prepare),
    create = required(c.tasks.create);
  const a = ok(
    await prepare({
      kind: 'create',
      destination: { type: 'configured-default' },
      tree: { markdownTitle: 'One' },
    }),
  );
  const b = ok(
    await prepare({
      kind: 'create',
      destination: { type: 'configured-default' },
      tree: { markdownTitle: 'Two', comments: [{ text: 'Frozen' }] },
    }),
  );
  const saved = await create(mutation(a, 'first', h.now));
  expect(saved).toMatchObject({
    ok: true,
    receipt: { effects: 'committed', destinationEffects: 'committed', snapshots: 'complete' },
  });
  expect(
    await prepare({
      kind: 'refresh',
      plan: b.target,
      expectedPlanRevision: b.revision,
      afterRequestId: 'missing',
    }),
  ).toMatchObject({ ok: false, error: { code: 'INVALID_CREATION_ANCHOR' } });
  const refreshed = ok(
    await prepare({
      kind: 'refresh',
      plan: b.target,
      expectedPlanRevision: b.revision,
      afterRequestId: 'first',
    }),
  );
  expect(refreshed.after?.comments).toEqual(
    b.after?.comments.map((comment) => ({
      ...comment,
      target: refreshed.after?.comments[0]?.target,
    })),
  );
  const second = await create(mutation(refreshed, 'second', h.now));
  expect(second).toMatchObject({
    ok: true,
    receipt: { effects: 'committed', destinationEffects: 'unchanged' },
  });
  expect(
    h.index
      .list()
      .filter((root) => root.ref.filePath === 'draft/new.md')
      .map((root) => root.title),
  ).toEqual(['One', 'Two']);
  expect(await create(mutation(a, 'first', h.now))).toEqual(saved);
  expect(
    await prepare({
      kind: 'refresh',
      plan: refreshed.target,
      expectedPlanRevision: refreshed.revision,
      afterRequestId: 'first',
    }),
  ).toMatchObject({ ok: false, error: { code: 'PLAN_CONSUMED' } });
});
it('rejects cross-consumer successful receipts and a different sealed destination basis', async () => {
  const h = await setup(),
    a = h.client('a'),
    b = h.client('b');
  const first = ok(
    await required(a.tasks.prepare)({
      kind: 'create',
      destination: { type: 'configured-default' },
      tree: { markdownTitle: 'One' },
    }),
  );
  const second = ok(
    await required(b.tasks.prepare)({
      kind: 'create',
      destination: { type: 'configured-default' },
      tree: { markdownTitle: 'Two' },
    }),
  );
  expect((await required(a.tasks.create)(mutation(first, 'first', h.now))).ok).toBe(true);
  expect(
    await required(b.tasks.prepare)({
      kind: 'refresh',
      plan: second.target,
      expectedPlanRevision: second.revision,
      afterRequestId: 'first',
    }),
  ).toMatchObject({ ok: false, error: { code: 'INVALID_CREATION_ANCHOR' } });
  const mismatched = ok(
    await required(a.tasks.prepare)({
      kind: 'create',
      destination: {
        type: 'note',
        path: 'other.md',
        insertion: { type: 'append' },
        provision: 'if-missing',
      },
      tree: { markdownTitle: 'Other' },
    }),
  );
  expect(
    await required(a.tasks.prepare)({
      kind: 'refresh',
      plan: mismatched.target,
      expectedPlanRevision: mismatched.revision,
      afterRequestId: 'first',
    }),
  ).toMatchObject({ ok: false, error: { code: 'INVALID_CREATION_ANCHOR' } });
});
