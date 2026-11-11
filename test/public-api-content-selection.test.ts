import { afterEach, expect, it } from 'vitest';
import type { ApiResultV1, ContentPlanV1 } from '../api';
import { expectDefined } from './helpers';
import { publicApiHarness, type PublicApiHarness } from './support/publicApiHarness';
const owners: PublicApiHarness[] = [];
afterEach(() => {
  owners.splice(0).forEach((owner) => {
    owner.dispose();
  });
});
function ok<T>(value: ApiResultV1<T>): T {
  if (!value.ok) throw new Error(value.error.code);
  return value.value;
}
async function setup() {
  const h = await publicApiHarness({
    'a.md': '- [ ] Original\n\t- Existing comment\n\t- [ ] Duplicate\n\t- [ ] Duplicate\n',
    'copy.md': '- [ ] Copy\n\t- Copied comment\n',
  });
  owners.push(h);
  const api = h.client();
  const root = expectDefined(
    ok(await api.tasks.list()).items.find((task) => task.source.path === 'a.md'),
  );
  const prepare = expectDefined(api.tasks.prepare);
  let plan = ok(
    await prepare({
      kind: 'edit',
      target: root.target,
      expectedRevision: root.revision,
      operation: {
        type: 'patch',
        target: root.target,
        patch: {
          markdownTitle: { type: 'set', value: 'Pending title' },
          scheduled: { type: 'set', value: '2026-08-02' },
        },
      },
    }),
  );
  plan = ok(
    await prepare({
      kind: 'append',
      plan: plan.target,
      expectedPlanRevision: plan.revision,
      operation: {
        type: 'add-child',
        target: expectDefined(plan.after).target,
        markdownTitle: 'Pending child',
      },
    }),
  );
  return { ...h, api, root, plan, prepare };
}
function request(plan: ContentPlanV1, requestId: string) {
  return {
    plan: plan.target,
    expectedPlanRevision: plan.revision,
    requestId,
    expiresAt: Date.UTC(2026, 7, 1, 12) + 60000,
  };
}
it('selects only the date and rebases the sealed structural remainder after exact successful receipt', async () => {
  const h = await setup();
  const selected = ok(
    await h.prepare({
      kind: 'select-fields',
      plan: h.plan.target,
      expectedPlanRevision: h.plan.revision,
      selections: [{ target: expectDefined(h.plan.after).target, fields: ['scheduled'] }],
    }),
  );
  expect(selected.after?.markdownTitle).toBe('Original');
  expect(selected.after?.children).toHaveLength(2);
  expect((await expectDefined(h.api.tasks.apply)(request(selected, 'selected'))).ok).toBe(true);
  expect(await h.read('a.md')).toContain('Original ⏳ 2026-08-02');
  expect(await h.read('a.md')).not.toContain('Pending');
  const remainder = ok(
    await h.prepare({
      kind: 'refresh',
      plan: h.plan.target,
      expectedPlanRevision: h.plan.revision,
      afterRequestId: 'selected',
    }),
  );
  expect(remainder.before?.dates.scheduled).toBe('2026-08-02');
  expect(remainder.hasChanges).toBe(true);
  expect(remainder.after?.markdownTitle).toBe('Pending title');
  expect(remainder.after?.children).toHaveLength(3);
  expect(remainder.after?.comments[0]?.text).toBe('Existing comment');
  expect((await expectDefined(h.api.tasks.apply)(request(remainder, 'remainder'))).ok).toBe(true);
  expect(await h.read('a.md')).toContain('Pending title ⏳ 2026-08-02');
  expect((await h.read('a.md')).match(/Pending child/g)).toHaveLength(1);
});
it('retains exact selection receipt lineage through an ordinary refresh', async () => {
  const h = await setup();
  const selected = ok(
    await h.prepare({
      kind: 'select-fields',
      plan: h.plan.target,
      expectedPlanRevision: h.plan.revision,
      selections: [{ target: expectDefined(h.plan.after).target, fields: ['scheduled'] }],
    }),
  );
  const refreshed = ok(
    await h.prepare({
      kind: 'refresh',
      plan: selected.target,
      expectedPlanRevision: selected.revision,
    }),
  );
  expect(
    (await expectDefined(h.api.tasks.apply)(request(refreshed, 'refreshed-selection'))).ok,
  ).toBe(true);
  const remainder = ok(
    await h.prepare({
      kind: 'refresh',
      plan: h.plan.target,
      expectedPlanRevision: h.plan.revision,
      afterRequestId: 'refreshed-selection',
    }),
  );
  expect(remainder.after?.markdownTitle).toBe('Pending title');
  expect(remainder.before?.dates.scheduled).toBe('2026-08-02');
});
it.each(['append', 'copy', 'external root'] as const)(
  'refuses refreshed selection privilege after %s',
  async (mode) => {
    const h = await setup();
    const selected = ok(
      await h.prepare({
        kind: 'select-fields',
        plan: h.plan.target,
        expectedPlanRevision: h.plan.revision,
        selections: [{ target: expectDefined(h.plan.after).target, fields: ['scheduled'] }],
      }),
    );
    let refreshed = ok(
      await h.prepare({
        kind: 'refresh',
        plan: selected.target,
        expectedPlanRevision: selected.revision,
      }),
    );
    if (mode !== 'external root') {
      const source = expectDefined(
        ok(await h.api.tasks.list()).items.find((task) => task.source.path === 'copy.md'),
      );
      refreshed = ok(
        await h.prepare({
          kind: 'append',
          plan: refreshed.target,
          expectedPlanRevision: refreshed.revision,
          operation:
            mode === 'copy'
              ? {
                  type: 'copy-subtree',
                  source: source.target,
                  expectedSourceRevision: source.revision,
                  target: expectDefined(refreshed.after).target,
                }
              : {
                  type: 'add-comment',
                  target: expectDefined(refreshed.after).target,
                  text: 'Independent refinement',
                },
        }),
      );
    }
    expect(
      (await expectDefined(h.api.tasks.apply)(request(refreshed, 'refreshed-selection'))).ok,
    ).toBe(true);
    if (mode === 'external root')
      await h.external('a.md', (await h.read('a.md')).replace('Original', 'External'));
    const result = await h.prepare({
      kind: 'refresh',
      plan: h.plan.target,
      expectedPlanRevision: h.plan.revision,
      afterRequestId: 'refreshed-selection',
    });
    expect(result.ok).toBe(false);
    if (mode !== 'external root')
      expect(result).toMatchObject({ error: { code: 'INVALID_SELECTION_RECEIPT' } });
    expect(await h.read('a.md')).not.toContain('Pending title');
  },
);
it('keeps structural remainder pending after every scalar change was selected', async () => {
  const h = await setup();
  const selected = ok(
    await h.prepare({
      kind: 'select-fields',
      plan: h.plan.target,
      expectedPlanRevision: h.plan.revision,
      selections: [
        { target: expectDefined(h.plan.after).target, fields: ['markdownTitle', 'scheduled'] },
      ],
    }),
  );
  expect(selected.hasChanges).toBe(true);
  expect((await expectDefined(h.api.tasks.apply)(request(selected, 'all-fields'))).ok).toBe(true);
  const remainder = ok(
    await h.prepare({
      kind: 'refresh',
      plan: h.plan.target,
      expectedPlanRevision: h.plan.revision,
      afterRequestId: 'all-fields',
    }),
  );
  expect(remainder.before?.markdownTitle).toBe(remainder.after?.markdownTitle);
  expect(remainder.before?.dates).toEqual(remainder.after?.dates);
  expect(remainder.before?.children).toHaveLength(2);
  expect(remainder.after?.children).toHaveLength(3);
  expect(remainder.hasChanges).toBe(true);
  expect(await h.read('a.md')).not.toContain('Pending child');
});
it('preserves canonical copy evidence, comment ownership and duplicate children across a partial save', async () => {
  const h = await setup();
  const source = expectDefined(
    ok(await h.api.tasks.list()).items.find((task) => task.source.path === 'copy.md'),
  );
  const full = ok(
    await h.prepare({
      kind: 'append',
      plan: h.plan.target,
      expectedPlanRevision: h.plan.revision,
      operation: {
        type: 'copy-subtree',
        source: source.target,
        expectedSourceRevision: source.revision,
        target: expectDefined(h.plan.after).target,
      },
    }),
  );
  const selected = ok(
    await h.prepare({
      kind: 'select-fields',
      plan: full.target,
      expectedPlanRevision: full.revision,
      selections: [{ target: expectDefined(full.after).target, fields: ['scheduled'] }],
    }),
  );
  expect((await expectDefined(h.api.tasks.apply)(request(selected, 'date'))).ok).toBe(true);
  const remainder = ok(
    await h.prepare({
      kind: 'refresh',
      plan: full.target,
      expectedPlanRevision: full.revision,
      afterRequestId: 'date',
    }),
  );
  expect(remainder.copies).toHaveLength(1);
  expect(remainder.after?.children.map((child) => child.markdownTitle)).toEqual([
    'Duplicate',
    'Duplicate',
    'Pending child',
    'Copy',
  ]);
  expect((await expectDefined(h.api.tasks.apply)(request(remainder, 'rest'))).ok).toBe(true);
  expect((await h.read('a.md')).match(/Copied comment/g)).toHaveLength(1);
  expect(await h.read('copy.md')).toBe('- [ ] Copy\n\t- Copied comment\n');
});
it.each(['missing receipt', 'foreign consumer', 'wrong revision', 'external root'])(
  'refuses remainder adoption after %s',
  async (reason) => {
    const h = await setup();
    const selected = ok(
      await h.prepare({
        kind: 'select-fields',
        plan: h.plan.target,
        expectedPlanRevision: h.plan.revision,
        selections: [{ target: expectDefined(h.plan.after).target, fields: ['scheduled'] }],
      }),
    );
    let remainder = h.plan;
    if (reason === 'wrong revision')
      remainder = ok(
        await h.prepare({
          kind: 'append',
          plan: h.plan.target,
          expectedPlanRevision: h.plan.revision,
          operation: {
            type: 'add-comment',
            target: expectDefined(h.plan.after).target,
            text: 'Later',
          },
        }),
      );
    expect((await expectDefined(h.api.tasks.apply)(request(selected, 'date'))).ok).toBe(true);
    if (reason === 'external root')
      await h.external('a.md', (await h.read('a.md')).replace('Original', 'External'));
    const prepare =
      reason === 'foreign consumer' ? expectDefined(h.client('foreign').tasks.prepare) : h.prepare;
    expect(
      (
        await prepare({
          kind: 'refresh',
          plan: remainder.target,
          expectedPlanRevision: remainder.revision,
          afterRequestId: reason === 'missing receipt' ? 'missing' : 'date',
        })
      ).ok,
    ).toBe(false);
    expect(await h.read('a.md')).not.toContain('Pending');
  },
);
it('keeps ordinary refresh strict after a same-root field write', async () => {
  const h = await setup();
  const selected = ok(
    await h.prepare({
      kind: 'select-fields',
      plan: h.plan.target,
      expectedPlanRevision: h.plan.revision,
      selections: [{ target: expectDefined(h.plan.after).target, fields: ['scheduled'] }],
    }),
  );
  expect((await expectDefined(h.api.tasks.apply)(request(selected, 'date'))).ok).toBe(true);
  expect(
    (
      await h.prepare({
        kind: 'refresh',
        plan: h.plan.target,
        expectedPlanRevision: h.plan.revision,
      })
    ).ok,
  ).toBe(false);
});
it('rejects a foreign successful selection receipt even when both clients observed the same original root', async () => {
  const h = await setup(),
    foreign = h.client('foreign');
  const root = expectDefined(
    ok(await foreign.tasks.list()).items.find((task) => task.source.path === 'a.md'),
  );
  const prepare = expectDefined(foreign.tasks.prepare);
  const plan = ok(
    await prepare({
      kind: 'edit',
      target: root.target,
      expectedRevision: root.revision,
      operation: {
        type: 'patch',
        target: root.target,
        patch: { scheduled: { type: 'set', value: '2026-08-02' } },
      },
    }),
  );
  const selected = ok(
    await prepare({
      kind: 'select-fields',
      plan: plan.target,
      expectedPlanRevision: plan.revision,
      selections: [{ target: expectDefined(plan.after).target, fields: ['scheduled'] }],
    }),
  );
  expect((await expectDefined(foreign.tasks.apply)(request(selected, 'foreign-date'))).ok).toBe(
    true,
  );
  expect(
    await h.prepare({
      kind: 'refresh',
      plan: h.plan.target,
      expectedPlanRevision: h.plan.revision,
      afterRequestId: 'foreign-date',
    }),
  ).toMatchObject({ ok: false, error: { code: 'INVALID_SELECTION_RECEIPT' } });
});
it('rebases description line offsets while preserving duplicate task and comment correspondence', async () => {
  const h = await setup();
  const full = ok(
    await h.prepare({
      kind: 'append',
      plan: h.plan.target,
      expectedPlanRevision: h.plan.revision,
      operation: {
        type: 'description',
        target: expectDefined(h.plan.after).target,
        text: 'First line\nSecond line',
      },
    }),
  );
  const selected = ok(
    await h.prepare({
      kind: 'select-fields',
      plan: full.target,
      expectedPlanRevision: full.revision,
      selections: [{ target: expectDefined(full.after).target, fields: ['description'] }],
    }),
  );
  expect((await expectDefined(h.api.tasks.apply)(request(selected, 'description'))).ok).toBe(true);
  const remainder = ok(
    await h.prepare({
      kind: 'refresh',
      plan: full.target,
      expectedPlanRevision: full.revision,
      afterRequestId: 'description',
    }),
  );
  expect(remainder.before?.description).toBe('First line\nSecond line');
  expect(remainder.after?.children.map((node) => node.markdownTitle)).toEqual([
    'Duplicate',
    'Duplicate',
    'Pending child',
  ]);
  const saved = await expectDefined(h.api.tasks.apply)(request(remainder, 'rest'));
  expect(saved.ok).toBe(true);
  if (!saved.ok) throw new Error(saved.error.code);
  const continuity = saved.receipt.contentContinuity.correspondence;
  expect(continuity.state).toBe('complete');
  if (continuity.state !== 'complete') throw new Error('Missing continuity');
  expect(new Set(continuity.tasks.map((pair) => pair.committedTarget)).size).toBe(
    continuity.tasks.length,
  );
  expect((await h.read('a.md')).match(/Existing comment/g)).toHaveLength(1);
  expect((await h.read('a.md')).match(/Duplicate/g)).toHaveLength(2);
});
