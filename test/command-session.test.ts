import { afterEach, expect, it } from 'vitest';
import type { ApiResultV1, TasksApiV1 } from '../api';
import { canonicalCommandPlan, canonicalCommandTree } from '../src/ai/commandReads';
import { sameReviewedContent } from '../src/ai/commandSchemas';
import { CommandSession } from '../src/ai/CommandSession';
import { CommandSessionStore } from '../src/ai/CommandSessionStore';
import type { CommandAgentPort, CommandSessionSnapshot } from '../src/ai/commandTypes';
import { deferred, expectDefined } from './helpers';
import { commandSessionStorage } from './support/commandSessionStorage';
import { publicApiHarness, type PublicApiHarness } from './support/publicApiHarness';
const owners: PublicApiHarness[] = [];
afterEach(() => {
  owners.splice(0).forEach((h) => {
    h.dispose();
  });
});
function ok<T>(r: ApiResultV1<T>): T {
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
}
it('clears admitted input before planning completes and retains the exact exchange', async () => {
  const h = await setup();
  const gate = deferred<void>();
  h.setRun(async () => gate.promise);
  h.session.setInput('Accepted task');
  const capture = h.session.captureInput();
  const pending = h.session.submit('Accepted task');
  expect(h.session.snapshot().input).toBe('');
  expect(capture.current()).toBe(true);
  expect(h.session.captureInput().dirty).toBe(false);
  expect(h.session.snapshot().exchanges).toContainEqual({ role: 'user', text: 'Accepted task' });
  gate.resolve();
  await pending;
});
it('shares immutable proposal data across input edits while detaching incoming plans', async () => {
  const { session, api } = await setup();
  const result = ok(
    await expectDefined(api.tasks.prepare)({
      kind: 'create',
      destination: { type: 'note', path: 'a.md', insertion: { type: 'append' } },
      tree: { markdownTitle: 'Original' },
    }),
  );
  const plan = await canonicalCommandPlan(api, result, new AbortController().signal, {
    now: () => 0,
    deadline: 5000,
  });
  session.stage({ kind: 'task', plan });
  const first = session.snapshot();
  const change = first.proposal.changes[0];
  if (change?.kind !== 'task') throw new Error('Missing task proposal');
  const reviewed = expectDefined(change.plan.after);
  expect(Object.isFrozen(reviewed)).toBe(true);
  const supplied = expectDefined(plan.after);
  Object.assign(supplied, { markdownTitle: 'Changed by caller' });
  expect(reviewed.markdownTitle).toBe('Original');
  session.setInput('next');
  const next = session.snapshot();
  expect(first.input).toBe('');
  expect(next.input).toBe('next');
  expect(next.proposal).toBe(first.proposal);
});
it.each([false, true])(
  'restores failed admitted text only without a newer composer edit (newer=%s)',
  async (newer) => {
    const h = await setup();
    const gate = deferred<void>();
    h.setRun(async () => {
      await gate.promise;
      throw new Error('Synthetic failure');
    });
    h.session.setInput('Accepted task');
    const pending = h.session.submit('Accepted task');
    expect(h.session.snapshot().input).toBe('');
    if (newer) h.session.setInput('Newer draft');
    gate.resolve();
    await pending;
    expect(h.session.snapshot().input).toBe(newer ? 'Newer draft' : 'Accepted task');
    expect(h.session.captureInput().dirty).toBe(true);
    expect(h.session.snapshot().status.kind).toBe('error');
  },
);
it.each([false, true])(
  'preserves a newer draft while a queued command is admitted or stopped (stopped=%s)',
  async (stopped) => {
    const h = await setup();
    const gate = deferred<void>();
    const seen: string[] = [];
    h.setRun(async ({ text }) => {
      seen.push(text);
      if (text === 'First') await gate.promise;
    });
    const first = h.session.submit('First');
    h.session.setInput('Queued');
    const queued = h.session.submit('Queued');
    h.session.setInput('Newer draft');
    if (stopped) h.session.cancelTurn();
    gate.resolve();
    await Promise.all([first, queued]);
    expect(h.session.snapshot().input).toBe('Newer draft');
    expect(h.session.captureInput().dirty).toBe(true);
    expect(seen).toEqual(stopped ? ['First'] : ['First', 'Queued']);
  },
);
it('retains rejected admission input without adding an exchange', async () => {
  const h = await setup();
  h.session.setInput('Unsent');
  await h.session.submit('Unsent', undefined, undefined, () => false);
  expect(h.session.snapshot().input).toBe('Unsent');
  expect(h.session.snapshot().exchanges).toEqual([]);
});
async function setup(
  files: Record<string, string> = { 'a.md': '- [ ] Existing\n' },
  configure: (api: TasksApiV1) => TasksApiV1 = (api) => api,
  now: () => number = () => Date.UTC(2026, 7, 1, 12),
) {
  const h = await publicApiHarness(files);
  owners.push(h);
  const api = configure(h.client());
  const saved: CommandSessionSnapshot[] = [];
  let run: CommandAgentPort['run'] = async () => {};
  const session = new CommandSession({
    api,
    journal: {
      save: async (state) => {
        saved.push(state);
      },
    },
    now,
    id: (() => {
      let i = 0;
      return () => `command-${++i}`;
    })(),
    agent: { run: (input) => run(input) },
  });
  return {
    ...h,
    api,
    session,
    saved,
    setRun: (next: CommandAgentPort['run']) => {
      run = next;
    },
  };
}
it('cancels selected preparation without admitting a write or replacing the stopped status', async () => {
  const entered = deferred<void>(),
    release = deferred<void>();
  const h = await setup(undefined, (api) => ({
    ...api,
    tasks: {
      ...api.tasks,
      prepare: async (input, options) => {
        if (input.kind === 'select-fields') {
          entered.resolve();
          await release.promise;
        }
        return expectDefined(api.tasks.prepare)(input, options);
      },
    },
  }));
  const root = expectDefined(ok(await h.api.tasks.list()).items[0]);
  const plan = ok(
    await expectDefined(h.api.tasks.prepare)({
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
  h.session.stage({ kind: 'task', plan });
  h.setRun(async ({ signal, session }) => {
    await h.session.confirmFromTurn(session.proposal.revision, signal, false, {
      proposalRevision: session.proposal.revision,
      changes: [
        {
          kind: 'task-fields',
          index: 0,
          plan: plan.target,
          expectedPlanRevision: plan.revision,
          target: expectDefined(plan.after).target,
          fields: ['scheduled'],
        },
      ],
    });
  });
  const pending = h.session.submit('Save the date only');
  await entered.promise;
  h.session.cancelTurn();
  release.resolve();
  await pending;
  expect(h.session.snapshot().status).toEqual({
    kind: 'ready',
    message: 'Stopped. Your draft is retained.',
  });
  expect(h.session.snapshot().journal).toHaveLength(0);
  expect(await h.read('a.md')).toBe('- [ ] Existing\n');
});
it('retains successful selected receipts and blocks replay when remainder refresh fails', async () => {
  const h = await setup(undefined, (api) => ({
    ...api,
    tasks: {
      ...api.tasks,
      prepare: async (input, options) => {
        if (input.kind === 'refresh' && input.afterRequestId !== undefined)
          return {
            ok: false,
            error: { category: 'conflict', code: 'REFRESH_REJECTED', message: 'Source changed' },
          };
        return expectDefined(api.tasks.prepare)(input, options);
      },
    },
  }));
  const root = expectDefined(ok(await h.api.tasks.list()).items[0]);
  const plan = ok(
    await expectDefined(h.api.tasks.prepare)({
      kind: 'edit',
      target: root.target,
      expectedRevision: root.revision,
      operation: {
        type: 'patch',
        target: root.target,
        patch: {
          markdownTitle: { type: 'set', value: 'Pending' },
          scheduled: { type: 'set', value: '2026-08-02' },
        },
      },
    }),
  );
  h.session.stage({ kind: 'task', plan });
  h.setRun(async ({ signal, session }) => {
    await h.session.confirmFromTurn(session.proposal.revision, signal, false, {
      proposalRevision: session.proposal.revision,
      changes: [
        {
          kind: 'task-fields',
          index: 0,
          plan: plan.target,
          expectedPlanRevision: plan.revision,
          target: expectDefined(plan.after).target,
          fields: ['scheduled'],
        },
      ],
    });
  });
  await h.session.submit('Save only the date');
  expect(await h.read('a.md')).toBe('- [ ] Existing ⏳ 2026-08-02\n');
  expect(h.session.snapshot()).toMatchObject({
    blocked: true,
    recovery: 'uncertain',
    status: { kind: 'error' },
  });
  expect(h.session.snapshot().journal).toMatchObject([{ state: 'settled', effects: 'committed' }]);
  expect(h.session.snapshot().proposal.changes).toEqual([{ kind: 'task', plan }]);
  await h.session.submit('');
  expect(h.session.snapshot().journal).toHaveLength(1);
  expect(await h.read('a.md')).not.toContain('Pending');
});
it.each([false, true])(
  'retires only a canonically proven empty remainder with other pending work: %s',
  async (otherPending) => {
    const h = await setup();
    const root = expectDefined(ok(await h.api.tasks.list()).items[0]);
    const plan = ok(
      await expectDefined(h.api.tasks.prepare)({
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
    h.session.stage({ kind: 'task', plan });
    const other = otherPending
      ? ok(
          await expectDefined(h.api.notes).prepare({
            kind: 'create',
            path: 'Other.md',
            title: 'Other',
            text: 'Pending note',
          }),
        )
      : undefined;
    if (other !== undefined) h.session.stage({ kind: 'note', plan: other });
    h.setRun(async ({ signal, session }) => {
      await h.session.confirmFromTurn(session.proposal.revision, signal, false, {
        proposalRevision: session.proposal.revision,
        changes: [
          {
            kind: 'task-fields',
            index: 0,
            plan: plan.target,
            expectedPlanRevision: plan.revision,
            target: expectDefined(plan.after).target,
            fields: ['scheduled'],
          },
        ],
      });
    });
    await h.session.submit('Save only the date');
    expect(h.session.snapshot().status.kind).toBe(otherPending ? 'ready' : 'saved');
    expect(h.session.snapshot().proposal.changes).toEqual(
      other === undefined ? [] : [{ kind: 'note', plan: other }],
    );
    expect(h.app.vault.getFileByPath('Other.md')).toBeNull();
    expect(h.session.snapshot().journal).toHaveLength(1);
  },
);
it('checks the exact note review basis for a bound session but keeps headless confirmation available', async () => {
  const h = await setup();
  const notes = expectDefined(h.api.notes);
  const plan = ok(
    await notes.prepare({
      kind: 'create',
      path: 'Review.md',
      title: 'Review',
      text: 'First draft.',
    }),
  );
  h.session.stage({ kind: 'note', plan });
  const headless = await setup();
  const other = ok(
    await expectDefined(headless.api.notes).prepare({
      kind: 'create',
      path: 'Headless.md',
      title: 'Headless',
      text: 'Explicit client approval.',
    }),
  );
  headless.session.stage({ kind: 'note', plan: other });
  await headless.session.submit('');
  expect(headless.session.snapshot().status.kind).toBe('saved');
  h.session.requireNoteReview();
  const basis = h.session.snapshot();
  const reviewed = (value: { sessionId: string; proposalRevision: number }) =>
    value.sessionId === basis.id && value.proposalRevision === basis.proposal.revision;
  const refined = ok(
    await notes.prepare({
      kind: 'refine',
      plan: plan.target,
      expectedPlanRevision: plan.revision,
      operation: { type: 'replace-body', text: 'Current draft.' },
    }),
  );
  h.session.stage({ kind: 'note', plan: refined });
  await h.session.submit(
    '',
    { sessionId: basis.id, proposalRevision: basis.proposal.revision },
    () => true,
  );
  expect(h.app.vault.getFileByPath('Review.md')).toBeNull();
  expect(await h.session.confirm(undefined, reviewed)).toBe(false);
  expect(h.app.vault.getFileByPath('Review.md')).toBeNull();
  expect(await h.session.confirm(undefined, () => true)).toBe(true);
  expect(await h.read('Review.md')).toContain('Current draft.');
});
it('previews clear creation and empty Enter saves the entire agreed tree after journaling', async () => {
  const h = await setup();
  h.setRun(async () => {
    const plan = ok(
      await expectDefined(h.api.tasks.prepare)({
        kind: 'create',
        destination: { type: 'note', path: 'a.md', insertion: { type: 'append' } },
        tree: {
          markdownTitle: 'Parent',
          children: [{ markdownTitle: 'Child A' }, { markdownTitle: 'Child B' }],
        },
      }),
    );
    h.session.stage({ kind: 'task', plan });
  });
  await h.session.submit('Create parent with two children');
  expect(await h.read('a.md')).toBe('- [ ] Existing\n');
  expect(h.session.snapshot().proposal.changes).toHaveLength(1);
  await h.session.submit('');
  expect(await h.read('a.md')).toContain(
    '- [ ] Parent ➕ 2026-08-01\n\t- [ ] Child A ➕ 2026-08-01\n\t- [ ] Child B ➕ 2026-08-01',
  );
  expect(h.session.snapshot().status.kind).toBe('saved');
  expect(h.saved.some((s) => s.journal.some((j) => j.state === 'admitted'))).toBe(true);
  expect(h.session.snapshot().journal[0]?.state).toBe('settled');
});
it('never commits an active question with empty Enter or stale semantic consent', async () => {
  const h = await setup();
  h.session.question('Which day?');
  await h.session.submit('');
  expect(h.session.snapshot().status.kind).toBe('question');
  expect(await h.session.confirm(999)).toBe(false);
  expect(await h.read('a.md')).toBe('- [ ] Existing\n');
});
it('applies note review admission only to the explicitly selected work', async () => {
  const h = await setup();
  const plan = ok(
    await expectDefined(h.api.tasks.prepare)({
      kind: 'create',
      destination: { type: 'note', path: 'a.md', insertion: { type: 'append' } },
      tree: { markdownTitle: 'Selected task' },
    }),
  );
  const note = ok(
    await expectDefined(h.api.notes).prepare({
      kind: 'create',
      path: 'Pending.md',
      title: 'Pending',
      text: 'Still awaiting render',
    }),
  );
  h.session.stage({ kind: 'task', plan });
  h.session.stage({ kind: 'note', plan: note });
  h.session.requireNoteReview();
  h.setRun(async ({ signal, session }) => {
    await h.session.confirmFromTurn(session.proposal.revision, signal, false, {
      proposalRevision: session.proposal.revision,
      changes: [{ kind: 'change', index: 0 }],
    });
  });
  await h.session.submit('Save only the task');
  expect(await h.read('a.md')).toContain('Selected task');
  expect(h.app.vault.getFileByPath('Pending.md')).toBeNull();
  expect(h.session.snapshot().proposal.changes).toEqual([{ kind: 'note', plan: note }]);
});
it.each(['both-children', 'repeat-owner', 'whole-and-fields', 'stale-revision'] as const)(
  'preserves the parent draft for exact field selections within one tree (%s)',
  async (mode) => {
    const original = '- [ ] Root\n\t- [ ] First\n\t- [ ] Second\n';
    const h = await setup({ 'a.md': original });
    const root = expectDefined(ok(await h.api.tasks.list()).items[0]);
    const prepare = expectDefined(h.api.tasks.prepare);
    let plan = ok(
      await prepare({
        kind: 'edit',
        target: root.target,
        expectedRevision: root.revision,
        operation: {
          type: 'patch',
          target: root.target,
          patch: { markdownTitle: { type: 'set', value: 'Pending name' } },
        },
      }),
    );
    for (const index of [0, 1]) {
      const target = expectDefined(plan.after?.children[index]).target;
      plan = ok(
        await prepare({
          kind: 'append',
          plan: plan.target,
          expectedPlanRevision: plan.revision,
          operation: {
            type: 'patch',
            target,
            patch: { due: { type: 'set', value: '2026-11-23' } },
          },
        }),
      );
    }
    const reviewed = plan;
    h.session.stage({ kind: 'task', plan: reviewed });
    h.setRun(async ({ signal, session }) => {
      const first = {
        kind: 'task-fields' as const,
        index: 0,
        plan: reviewed.target,
        expectedPlanRevision: reviewed.revision,
        target: expectDefined(reviewed.after?.children[0]).target,
        fields: ['due'] as const,
      };
      const second =
        mode === 'whole-and-fields'
          ? { kind: 'change' as const, index: 0 }
          : {
              ...first,
              target:
                mode === 'repeat-owner'
                  ? first.target
                  : expectDefined(reviewed.after?.children[1]).target,
              expectedPlanRevision: mode === 'stale-revision' ? 'old' : reviewed.revision,
            };
      await h.session.confirmFromTurn(session.proposal.revision, signal, false, {
        proposalRevision: session.proposal.revision,
        changes: [first, second],
      });
    });
    await h.session.submit('Save only both child dates. Keep the parent name pending.');
    if (mode !== 'both-children') {
      expect(h.session.snapshot().journal).toHaveLength(0);
      expect(await h.read('a.md')).toBe(original);
      return;
    }
    expect(await h.read('a.md')).toBe(
      '- [ ] Root\n\t- [ ] First 📅 2026-11-23\n\t- [ ] Second 📅 2026-11-23\n',
    );
    expect(h.session.snapshot().journal).toHaveLength(1);
    expect(h.session.snapshot().proposal.changes).toHaveLength(1);
    await h.session.submit('');
    expect(await h.read('a.md')).toContain('- [ ] Pending name\n');
    expect(h.session.snapshot().journal).toHaveLength(2);
  },
);

it('saves semantically selected date fields while retaining the title and child for later whole confirmation', async () => {
  const h = await setup();
  const root = expectDefined(ok(await h.api.tasks.list()).items[0]);
  const prepare = expectDefined(h.api.tasks.prepare);
  const initial = ok(
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
  const plan = ok(
    await prepare({
      kind: 'append',
      plan: initial.target,
      expectedPlanRevision: initial.revision,
      operation: {
        type: 'add-child',
        target: expectDefined(initial.after).target,
        markdownTitle: 'Pending child',
      },
    }),
  );
  h.session.stage({ kind: 'task', plan });
  h.setRun(async ({ signal, session }) => {
    await h.session.confirmFromTurn(session.proposal.revision, signal, false, {
      proposalRevision: session.proposal.revision,
      changes: [
        {
          kind: 'task-fields',
          index: 0,
          plan: plan.target,
          expectedPlanRevision: plan.revision,
          target: expectDefined(plan.after).target,
          fields: ['scheduled'],
        },
      ],
    });
  });
  await h.session.submit('Save only the date; keep the rest pending');
  expect(await h.read('a.md')).toBe('- [ ] Existing ⏳ 2026-08-02\n');
  expect(h.session.snapshot().proposal.changes).toHaveLength(1);
  expect(h.session.snapshot().status.kind).toBe('ready');
  expect(h.session.snapshot().status.message).not.toBe('Saved.');
  await h.session.submit('');
  expect(await h.read('a.md')).toContain('Pending title ⏳ 2026-08-02');
  expect((await h.read('a.md')).match(/Pending child/g)).toHaveLength(1);
  expect(h.session.snapshot().status.kind).toBe('saved');
});
it('routes nonempty input through semantic reasoning regardless of confirmation spelling', async () => {
  const h = await setup();
  const received: string[] = [];
  h.setRun(async ({ text }) => {
    received.push(text);
  });
  await h.session.submit('okay');
  await h.session.submit('да');
  expect(received).toEqual(['okay', 'да']);
});
it.each(['stale scope', 'unknown change', 'unsaved child'])(
  'rejects %s before admitting a limited write',
  async (reason) => {
    const h = await setup();
    const plan = ok(
      await expectDefined(h.api.tasks.prepare)({
        kind: 'create',
        destination: { type: 'note', path: 'a.md', insertion: { type: 'append' } },
        tree: { markdownTitle: 'Parent', children: [{ markdownTitle: 'Child' }] },
      }),
    );
    h.session.stage({ kind: 'task', plan });
    h.setRun(async ({ signal, session }) => {
      await h.session.confirmFromTurn(session.proposal.revision, signal, false, {
        proposalRevision: session.proposal.revision + (reason === 'stale scope' ? 1 : 0),
        changes:
          reason === 'unsaved child'
            ? [
                {
                  kind: 'task-fields',
                  index: 0,
                  plan: plan.target,
                  expectedPlanRevision: plan.revision,
                  target: expectDefined(plan.after?.children[0]).target,
                  fields: ['markdownTitle'],
                },
              ]
            : [{ kind: 'change', index: reason === 'unknown change' ? 99 : 0 }],
      });
    });
    await h.session.submit('Save only this part');
    expect(await h.read('a.md')).toBe('- [ ] Existing\n');
    expect(h.session.snapshot().journal).toHaveLength(0);
    expect(h.session.snapshot().proposal.changes).toHaveLength(1);
    expect(h.session.snapshot().status.kind).toBe(
      reason === 'unsaved child' ? 'question' : 'error',
    );
  },
);
it('asks before selecting content while a saved-node lifecycle change remains pending', async () => {
  const h = await setup();
  const root = expectDefined(ok(await h.api.tasks.list()).items[0]);
  const plan = ok(
    await expectDefined(h.api.tasks.prepare)({
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
  h.session.stage({ kind: 'task', plan });
  h.session.stage({
    kind: 'status',
    target: root.target,
    revision: root.revision,
    symbol: 'x',
    nuance: 'Complete with normal lifecycle',
  });
  h.setRun(async ({ signal, session }) => {
    await h.session.confirmFromTurn(session.proposal.revision, signal, false, {
      proposalRevision: session.proposal.revision,
      changes: [
        {
          kind: 'task-fields',
          index: 0,
          plan: plan.target,
          expectedPlanRevision: plan.revision,
          target: expectDefined(plan.after).target,
          fields: ['scheduled'],
        },
      ],
    });
  });
  await h.session.submit('Save only the date');
  expect(h.session.snapshot().status.kind).toBe('question');
  expect(h.session.snapshot().journal).toHaveLength(0);
  expect(await h.read('a.md')).toBe('- [ ] Existing\n');
});
it.each([
  { count: 2, reversed: false },
  { count: 4, reversed: false },
  { count: 4, reversed: true },
])(
  'retains $count same-note partial plans, reverse multiline order: $reversed',
  async ({ count, reversed }) => {
    const names = ['One', 'Two', 'Three', 'Four'].slice(0, count);
    const h = await setup({ 'a.md': names.map((name) => `- [ ] ${name}\n`).join('') });
    const roots = ok(await h.api.tasks.list()).items;
    const ordered = reversed ? [...roots].reverse() : roots;
    for (const root of ordered) {
      let plan = ok(
        await expectDefined(h.api.tasks.prepare)({
          kind: 'edit',
          target: root.target,
          expectedRevision: root.revision,
          operation: {
            type: 'patch',
            target: root.target,
            patch: {
              markdownTitle: { type: 'set', value: `${root.markdownTitle} pending` },
              scheduled: { type: 'set', value: '2026-08-02' },
              due: { type: 'set', value: '2026-08-03' },
            },
          },
        }),
      );
      if (reversed)
        plan = ok(
          await expectDefined(h.api.tasks.prepare)({
            kind: 'append',
            plan: plan.target,
            expectedPlanRevision: plan.revision,
            operation: {
              type: 'description',
              target: expectDefined(plan.after).target,
              text: `First ${root.markdownTitle}\nSecond ${root.markdownTitle}`,
            },
          }),
        );
      h.session.stage({ kind: 'task', plan });
    }
    let second = false;
    h.setRun(async ({ signal, session }) => {
      await h.session.confirmFromTurn(session.proposal.revision, signal, false, {
        proposalRevision: session.proposal.revision,
        changes: session.proposal.changes.flatMap((change, index) =>
          change.kind !== 'task'
            ? []
            : [
                {
                  kind: 'task-fields',
                  index,
                  plan: change.plan.target,
                  expectedPlanRevision: change.plan.revision,
                  target: expectDefined(change.plan.after).target,
                  fields: second ? ['scheduled', 'due'] : [reversed ? 'description' : 'scheduled'],
                },
              ],
        ),
      });
    });
    await h.session.submit('Save selected fields; keep all other changes pending');
    expect(h.session.snapshot()).toMatchObject({ blocked: false, status: { kind: 'ready' } });
    expect(h.session.snapshot().proposal.changes).toHaveLength(count);
    expect(h.session.snapshot().journal).toHaveLength(count);
    expect(ok(await h.api.tasks.list()).items.map((root) => root.markdownTitle)).toEqual(names);
    if (reversed) for (const name of names) expect(await h.read('a.md')).toContain(`First ${name}`);
    else
      expect(await h.read('a.md')).toBe(
        names.map((name) => `- [ ] ${name} ⏳ 2026-08-02\n`).join(''),
      );
    second = true;
    await h.session.submit('Save the dates; keep titles pending');
    expect(h.session.snapshot()).toMatchObject({ blocked: false, status: { kind: 'ready' } });
    expect(h.session.snapshot().journal).toHaveLength(count * 2);
    expect(ok(await h.api.tasks.list()).items.map((root) => root.markdownTitle)).toEqual(names);
    expect(await h.session.confirm()).toBe(true);
    const saved = ok(await h.api.tasks.list()).items;
    expect(saved.map((root) => root.markdownTitle)).toEqual(names.map((name) => `${name} pending`));
    expect(
      saved.every(
        (root) => root.dates.scheduled === '2026-08-02' && root.dates.due === '2026-08-03',
      ),
    ).toBe(true);
    if (reversed)
      for (const name of names) {
        expect(await h.read('a.md')).toContain(`First ${name}`);
        expect(await h.read('a.md')).toContain(`Second ${name}`);
      }
    expect(h.session.snapshot().journal).toHaveLength(count * 3);
    expect(h.session.snapshot().status.kind).toBe('saved');
    expect(await h.session.confirm()).toBe(false);
  },
);
it.each([false, true])(
  'selects fields after a whole sibling save shifts the retained plan, with copied duplicates: %s',
  async (withCopies) => {
    const h = await setup({
      'a.md': `- [ ] One\n- [ ] Two\n${withCopies ? '\t- [ ] Same\n\t\t- Child comment\n\t- [ ] Same\n' : ''}`,
      'copy.md': '- [ ] Copy\n\t- Copied comment\n',
    });
    const roots = ok(await h.api.tasks.list({ path: 'a.md' })).items.filter(
      (root) => root.parentTarget === undefined,
    );
    const one = expectDefined(roots[0]),
      two = expectDefined(roots[1]);
    const prepare = expectDefined(h.api.tasks.prepare);
    const first = ok(
      await prepare({
        kind: 'edit',
        target: one.target,
        expectedRevision: one.revision,
        operation: { type: 'description', target: one.target, text: 'Added description' },
      }),
    );
    let pending = ok(
      await prepare({
        kind: 'edit',
        target: two.target,
        expectedRevision: two.revision,
        operation: {
          type: 'patch',
          target: two.target,
          patch: {
            markdownTitle: { type: 'set', value: 'Two pending' },
            scheduled: { type: 'set', value: '2026-08-02' },
          },
        },
      }),
    );
    if (withCopies) {
      const source = expectDefined(ok(await h.api.tasks.list({ path: 'copy.md' })).items[0]);
      pending = ok(
        await prepare({
          kind: 'append',
          plan: pending.target,
          expectedPlanRevision: pending.revision,
          operation: {
            type: 'copy-subtree',
            source: source.target,
            expectedSourceRevision: source.revision,
            target: expectDefined(pending.after).target,
          },
        }),
      );
    }
    pending = await canonicalCommandPlan(h.api, pending, new AbortController().signal, {
      now: () => Date.UTC(2026, 7, 1, 12),
      deadline: Date.UTC(2026, 7, 1, 12) + 5000,
    });
    h.session.stage({ kind: 'task', plan: first });
    h.session.stage({ kind: 'task', plan: pending });
    let fieldsOnly = false;
    h.setRun(async ({ signal, session }) => {
      const change = expectDefined(session.proposal.changes[0]);
      if (change.kind !== 'task') throw new Error('Expected retained task');
      await h.session.confirmFromTurn(session.proposal.revision, signal, false, {
        proposalRevision: session.proposal.revision,
        changes: fieldsOnly
          ? [
              {
                kind: 'task-fields',
                index: 0,
                plan: change.plan.target,
                expectedPlanRevision: change.plan.revision,
                target: expectDefined(change.plan.after).target,
                fields: ['scheduled'],
              },
            ]
          : [{ kind: 'change', index: 0 }],
      });
    });
    await h.session.submit('Save only the first whole change');
    expect(h.session.snapshot()).toMatchObject({ blocked: false, status: { kind: 'ready' } });
    expect(h.session.snapshot().journal).toHaveLength(1);
    const refreshed = expectDefined(h.session.snapshot().proposal.changes[0]);
    if (refreshed.kind !== 'task') throw new Error('Expected refreshed task');
    expect(refreshed.plan.before?.source).toEqual(pending.before?.source);
    expect(ok(await h.api.tasks.get(two.target)).source.line).toBeGreaterThan(two.source.line);
    fieldsOnly = true;
    await h.session.submit('Save only its date');
    expect(h.session.snapshot()).toMatchObject({ blocked: false, status: { kind: 'ready' } });
    expect(h.session.snapshot().journal).toHaveLength(2);
    expect(await h.read('a.md')).toContain('- [ ] Two ⏳ 2026-08-02');
    expect(await h.read('a.md')).not.toContain('Two pending');
    expect(await h.read('a.md')).not.toContain('Copied comment');
    const remainder = expectDefined(h.session.snapshot().proposal.changes[0]);
    if (remainder.kind !== 'task') throw new Error('Expected remaining title');
    if (withCopies) expect(remainder.plan.copies).toHaveLength(1);
    expect(await h.session.confirm()).toBe(true);
    expect(h.session.snapshot().journal).toHaveLength(3);
    expect(h.session.snapshot().status.kind).toBe('saved');
    expect(await h.read('a.md')).toContain('Added description');
    expect(await h.read('a.md')).toContain('- [ ] Two pending ⏳ 2026-08-02');
    if (withCopies) {
      expect((await h.read('a.md')).match(/- \[ \] Same/g)).toHaveLength(2);
      expect((await h.read('a.md')).match(/Copied comment/g)).toHaveLength(1);
      expect((await h.read('a.md')).match(/Child comment/g)).toHaveLength(1);
    }
  },
);
it('refuses new writes if awaited journal persistence fails', async () => {
  const h = await setup();
  const session = new CommandSession({
    api: h.api,
    journal: {
      save: async () => {
        throw new Error('disk full');
      },
    },
    now: () => Date.UTC(2026, 7, 1, 12),
    id: () => 'failure',
    agent: { run: async () => {} },
  });
  const plan = ok(
    await expectDefined(h.api.tasks.prepare)({
      kind: 'create',
      destination: { type: 'note', path: 'a.md', insertion: { type: 'append' } },
      tree: { markdownTitle: 'Never write' },
    }),
  );
  session.stage({ kind: 'task', plan });
  await session.confirm();
  expect(await h.read('a.md')).toBe('- [ ] Existing\n');
  expect(session.snapshot().status.kind).toBe('error');
  expect(session.snapshot().blocked).toBe(false);
  expect(session.snapshot().journal[0]).toMatchObject({
    state: 'settled',
    effects: 'unchanged',
    error: 'STORAGE_BEFORE_ADMISSION',
  });
});
it('hiding at rest preserves the exact question, input, and proposal', async () => {
  const h = await setup();
  h.session.setInput('Unsent detail');
  h.session.question('Which day?');
  const before = h.session.snapshot();
  h.session.cancelTurn();
  expect(h.session.snapshot()).toEqual(before);
});
it('retains dirty work when a new session is requested without a disposition', async () => {
  const h = await setup();
  const plan = ok(
    await expectDefined(h.api.tasks.prepare)({
      kind: 'create',
      destination: { type: 'note', path: 'a.md', insertion: { type: 'append' } },
      tree: { markdownTitle: 'Retained' },
    }),
  );
  h.session.stage({ kind: 'task', plan });
  const id = h.session.snapshot().id;
  await h.session.newSession();
  expect(h.session.snapshot().id).toBe(id);
  expect(h.session.snapshot().proposal.changes).toHaveLength(1);
  expect(h.session.snapshot().activeQuestion).not.toBeNull();
});

it('does not replay an unknown native effect on another confirmation', async () => {
  const h = await setup();
  const create = expectDefined(h.api.tasks.create);
  let writes = 0;
  const api = {
    ...h.api,
    tasks: {
      ...h.api.tasks,
      create: async (input: Parameters<typeof create>[0]) => {
        writes++;
        await create(input);
        return {
          ok: false as const,
          error: { code: 'LOST', category: 'io' as const, message: 'Lost receipt' },
          effects: 'unknown' as const,
          recovery: 'reconcile' as const,
        };
      },
    },
  };
  const session = new CommandSession({
    api,
    agent: { run: async () => {} },
    journal: { save: async () => {} },
    now: () => Date.UTC(2026, 7, 1, 12),
    id: (() => {
      let i = 0;
      return () => `lost-${++i}`;
    })(),
  });
  const plan = ok(
    await expectDefined(api.tasks.prepare)({
      kind: 'create',
      destination: { type: 'note', path: 'a.md', insertion: { type: 'append' } },
      tree: { markdownTitle: 'Written once' },
    }),
  );
  session.stage({ kind: 'task', plan });
  await session.confirm();
  await session.confirm();
  expect(writes).toBe(1);
  expect(session.snapshot().blocked).toBe(true);
  expect(session.snapshot().journal[0]?.effects).toBe('unknown');
  expect(await h.read('a.md')).toContain('Written once');
});
it('an expired preview refuses before effect admission and remains reviewable', async () => {
  const h = await setup();
  const plan = ok(
    await expectDefined(h.api.tasks.prepare)({
      kind: 'create',
      destination: { type: 'note', path: 'a.md', insertion: { type: 'append' } },
      tree: { markdownTitle: 'Expired' },
    }),
  );
  const session = new CommandSession({
    api: h.api,
    agent: { run: async () => {} },
    journal: { save: async () => {} },
    now: () => plan.expiresAt + 1,
    id: () => 'expired',
  });
  session.stage({ kind: 'task', plan });
  await session.confirm();
  expect(session.snapshot().journal).toHaveLength(0);
  expect(session.snapshot().blocked).toBe(false);
  expect(await h.read('a.md')).not.toContain('Expired');
});
it('ignores empty Enter while planning and interprets fresh input after cancelling the old turn', async () => {
  const h = await setup();
  let firstResolve: () => void = () => {};
  const first = new Promise<void>((r) => {
    firstResolve = r;
  });
  const seen: string[] = [];
  h.setRun(async ({ text, signal }) => {
    seen.push(text);
    if (text === 'First') {
      await first;
      if (signal.aborted) return;
    } else h.session.status('ready', 'Latest input accepted.');
  });
  const pending = h.session.submit('First');
  await Promise.resolve();
  await h.session.submit('');
  expect(h.session.snapshot().journal).toHaveLength(0);
  const next = h.session.submit('Second');
  firstResolve();
  await Promise.all([pending, next]);
  expect(seen).toEqual(['First', 'Second']);
  expect(h.session.snapshot().input).toBe('');
  expect(h.session.snapshot().exchanges.slice(-1)).toEqual([{ role: 'user', text: 'Second' }]);
});
it('counts changed nodes rather than an unchanged large surrounding tree', async () => {
  const h = await publicApiHarness({
    'a.md': ['- [ ] Root', ...Array.from({ length: 60 }, (_, i) => `  - [ ] Child ${i}`), ''].join(
      '\n',
    ),
  });
  owners.push(h);
  const api = h.client();
  const items = ok(await api.tasks.list()).items;
  const root = expectDefined(items.find((i) => i.title === 'Root'));
  const child = expectDefined(items.find((i) => i.title === 'Child 59'));
  const plan = ok(
    await expectDefined(api.tasks.prepare)({
      kind: 'edit',
      target: root.target,
      expectedRevision: root.revision,
      operation: {
        type: 'patch',
        target: child.target,
        patch: { markdownTitle: { type: 'set', value: 'Only last' } },
      },
    }),
  );
  const session = new CommandSession({
    api,
    agent: { run: async () => {} },
    journal: { save: async () => {} },
    now: () => Date.UTC(2026, 7, 1, 12),
    id: () => 'large',
  });
  expect(() => {
    session.stage({ kind: 'task', plan });
  }).not.toThrow();
});
it('saved-row status leaves unrelated content pending and stale for reviewed reconciliation', async () => {
  const h = await setup();
  const task = expectDefined(ok(await h.api.tasks.list()).items[0]);
  const plan = ok(
    await expectDefined(h.api.tasks.prepare)({
      kind: 'edit',
      target: task.target,
      expectedRevision: task.revision,
      operation: {
        type: 'patch',
        target: task.target,
        patch: { markdownTitle: { type: 'set', value: 'Pending title' } },
      },
    }),
  );
  h.session.stage({ kind: 'task', plan });
  await h.session.applyStatus({ target: task.target, revision: task.revision, symbol: 'x' });
  expect(await h.read('a.md')).toContain('- [x] Existing');
  expect(await h.read('a.md')).not.toContain('Pending title');
  expect(h.session.snapshot().proposal.changes).toHaveLength(1);
  await h.session.confirm();
  expect(h.session.snapshot().status.kind).toBe('error');
  expect(await h.read('a.md')).not.toContain('Pending title');
});
it('Escape during the pre-effect journal wait refuses the still-unadmitted write', async () => {
  const h = await setup();
  let release: () => void = () => {};
  const waiting = new Promise<void>((r) => {
    release = r;
  });
  let entered: () => void = () => {};
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const session = new CommandSession({
    api: h.api,
    journal: {
      save: async (s) => {
        if (s.journal[s.journal.length - 1]?.state === 'admitted') {
          entered();
          await waiting;
        }
      },
    },
    now: () => Date.UTC(2026, 7, 1, 12),
    id: (() => {
      let i = 0;
      return () => `stop-${++i}`;
    })(),
    agent: { run: async () => {} },
  });
  const plan = ok(
    await expectDefined(h.api.tasks.prepare)({
      kind: 'create',
      destination: { type: 'note', path: 'a.md', insertion: { type: 'append' } },
      tree: { markdownTitle: 'Should not write' },
    }),
  );
  session.stage({ kind: 'task', plan });
  const saving = session.confirm();
  await started;
  session.cancelTurn();
  release();
  await saving;
  expect(await h.read('a.md')).not.toContain('Should not write');
  expect(session.snapshot().journal).toMatchObject([
    { state: 'settled', effects: 'unchanged', error: 'CANCELLED_BEFORE_ADMISSION' },
  ]);
});
it('Escape after native admission lets the real receipt settle and read back', async () => {
  const h = await setup();
  const native = expectDefined(h.api.tasks.create);
  let release: () => void = () => {};
  const waiting = new Promise<void>((r) => {
    release = r;
  });
  let entered: () => void = () => {};
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const api = {
    ...h.api,
    tasks: {
      ...h.api.tasks,
      create: async (...args: Parameters<typeof native>) => {
        const result = await native(...args);
        entered();
        await waiting;
        return result;
      },
    },
  };
  const session = new CommandSession({
    api,
    journal: { save: async () => {} },
    now: () => Date.UTC(2026, 7, 1, 12),
    id: (() => {
      let i = 0;
      return () => `admitted-${++i}`;
    })(),
    agent: { run: async () => {} },
  });
  const plan = ok(
    await expectDefined(api.tasks.prepare)({
      kind: 'create',
      destination: { type: 'note', path: 'a.md', insertion: { type: 'append' } },
      tree: { markdownTitle: 'Admitted' },
    }),
  );
  session.stage({ kind: 'task', plan });
  const saving = session.confirm();
  await started;
  session.cancelTurn();
  release();
  await saving;
  expect(session.snapshot().status.kind).toBe('saved');
  expect(session.snapshot().actual[0]?.title).toBe('Admitted');
  expect(await h.read('a.md')).toContain('Admitted');
});

it('cancellation settles a dispatched facade call but never issues the next batch write', async () => {
  const h = await setup();
  const native = expectDefined(h.api.tasks.create);
  const admitted = deferred<void>(),
    release = deferred<void>();
  let calls = 0;
  const api = {
    ...h.api,
    tasks: {
      ...h.api.tasks,
      create: async (...args: Parameters<typeof native>) => {
        calls++;
        admitted.resolve();
        await release.promise;
        return native(...args);
      },
    },
  };
  const session = new CommandSession({
    api,
    journal: { save: async () => {} },
    now: () => Date.UTC(2026, 7, 1, 12),
    id: (() => {
      let id = 0;
      return () => `batch-${++id}`;
    })(),
    agent: { run: async () => {} },
  });
  for (const markdownTitle of ['Admitted first', 'Unissued second']) {
    const plan = ok(
      await expectDefined(api.tasks.prepare)({
        kind: 'create',
        destination: { type: 'note', path: 'a.md', insertion: { type: 'append' } },
        tree: { markdownTitle },
      }),
    );
    session.stage({ kind: 'task', plan });
  }
  const saving = session.confirm();
  await admitted.promise;
  session.cancelTurn();
  expect(await h.read('a.md')).toBe('- [ ] Existing\n');
  release.resolve();
  expect(await saving).toBe(false);
  expect(calls).toBe(1);
  expect(await h.read('a.md')).toBe('- [ ] Existing\n- [ ] Admitted first ➕ 2026-08-01\n');
  expect(session.snapshot().journal).toMatchObject([{ state: 'settled', effects: 'committed' }]);
  expect(session.snapshot().actual[0]?.title).toBe('Admitted first');
});

it('reviewed-value comparison permits source line shifts but never a different source path', async () => {
  const h = await setup();
  const task = expectDefined(ok(await h.api.tasks.list({})).items[0]);
  const plan = ok(
    await expectDefined(h.api.tasks.prepare)({
      kind: 'edit',
      target: task.target,
      expectedRevision: task.revision,
    }),
  );
  const moved = structuredClone(plan);
  const before = expectDefined(moved.before ?? undefined);
  const source = expectDefined(before.source);
  Object.assign(source, { line: source.line + 4 });
  expect(sameReviewedContent(plan, moved)).toBe(true);
  Object.assign(source, { path: 'different.md' });
  expect(sameReviewedContent(plan, moved)).toBe(false);
});

it('counts removed nodes by retained handles without charging shifted siblings', async () => {
  const h = await publicApiHarness({
    'a.md': ['- [ ] Root', ...Array.from({ length: 60 }, (_, i) => `  - [ ] Child ${i}`), ''].join(
      '\n',
    ),
  });
  owners.push(h);
  const api = h.client(),
    items = ok(await api.tasks.list()).items;
  const root = expectDefined(items.find((t) => t.title === 'Root'));
  const first = expectDefined(items.find((t) => t.title === 'Child 0'));
  const plan = ok(
    await expectDefined(api.tasks.prepare)({
      kind: 'edit',
      target: root.target,
      expectedRevision: root.revision,
      operation: { type: 'remove', target: first.target },
    }),
  );
  const session = new CommandSession({
    api,
    agent: { run: async () => {} },
    journal: { save: async () => {} },
    now: () => Date.UTC(2026, 7, 1),
    id: () => 'shift',
  });
  expect(() => {
    session.stage({ kind: 'task', plan });
  }).not.toThrow();
  const cleanup = ok(
    await expectDefined(api.tasks.prepare)({
      kind: 'edit',
      target: root.target,
      expectedRevision: root.revision,
      operation: { type: 'remove', target: root.target },
    }),
  );
  expect(() => {
    session.stage({
      kind: 'cleanup',
      plan: cleanup,
      destinationPlan: 'other',
      destinationRevision: 'other',
    });
  }).toThrow('too large');
});

it('clears the prior saved actual tree after a verified root deletion', async () => {
  const h = await setup();
  const original = expectDefined(ok(await h.api.tasks.list()).items[0]);
  const prepare = expectDefined(h.api.tasks.prepare);
  h.session.stage({
    kind: 'task',
    plan: ok(
      await prepare({
        kind: 'edit',
        target: original.target,
        expectedRevision: original.revision,
        operation: {
          type: 'patch',
          target: original.target,
          patch: { markdownTitle: { type: 'set', value: 'Saved first' } },
        },
      }),
    ),
  });
  expect(await h.session.confirm()).toBe(true);
  const saved = expectDefined(h.session.snapshot().actual[0]);
  h.session.stage({
    kind: 'task',
    plan: ok(
      await prepare({
        kind: 'edit',
        target: saved.target,
        expectedRevision: saved.revision,
        operation: { type: 'remove', target: saved.target },
      }),
    ),
  });
  expect(await h.session.confirm()).toBe(true);
  expect(h.session.snapshot().actual).toHaveLength(0);
  expect(await h.read('a.md')).not.toContain('Saved first');
});

it('verifies the whole focus selection before publishing and retains it on a failed selection', async () => {
  const h = await setup();
  const task = expectDefined(ok(await h.api.tasks.list()).items[0]);
  expect(
    await h.session.focus({ kind: 'task', target: task.target, revision: task.revision }),
  ).toBe(true);
  const previous = h.session.snapshot().focus;
  const seen: string[] = [];
  const stop = h.session.subscribe((snapshot) => {
    seen.push(...snapshot.focus.map((entry) => entry.target));
  });
  expect(
    await h.session.focus([
      { kind: 'task', target: task.target, revision: task.revision },
      { kind: 'task', target: 'unknown-task', revision: 'unknown' },
    ]),
  ).toBe(false);
  expect(h.session.snapshot().focus).toEqual(previous);
  expect(seen).not.toContain('unknown-task');
  expect(await h.session.focus([])).toBe(true);
  expect(h.session.snapshot().focus).toHaveLength(0);
  stop();
});

it('selects a draft child by plan, remaps it through verified receipt and clears it on root deletion', async () => {
  const h = await setup();
  const prepare = expectDefined(h.api.tasks.prepare);
  const plan = ok(
    await prepare({
      kind: 'create',
      destination: { type: 'note', path: 'a.md', insertion: { type: 'append' } },
      tree: { markdownTitle: 'Selected root', children: [{ markdownTitle: 'Selected child' }] },
    }),
  );
  h.session.stage({ kind: 'task', plan });
  const child = expectDefined(plan.after?.children[0]);
  expect(
    await h.session.focus({
      kind: 'task',
      target: child.target,
      plan: plan.target,
      expectedPlanRevision: plan.revision,
    }),
  ).toBe(true);
  expect(h.session.snapshot().entities.tasks[0]?.tree.title).toBe('Selected child');
  expect(await h.session.confirm()).toBe(true);
  const selected = expectDefined(h.session.snapshot().focus[0]);
  expect(selected).not.toHaveProperty('plan');
  expect(ok(await h.api.tasks.get(selected.target)).title).toBe('Selected child');
  const root = expectDefined(
    h.session.snapshot().actual.find((tree) => tree.title === 'Selected root'),
  );
  h.session.stage({
    kind: 'task',
    plan: ok(
      await prepare({
        kind: 'edit',
        target: root.target,
        expectedRevision: root.revision,
        operation: { type: 'remove', target: root.target },
      }),
    ),
  });
  expect(await h.session.confirm()).toBe(true);
  expect(h.session.snapshot().focus).toHaveLength(0);
});

it('preserves selected focus on cancellation and rebinds retained draft nodes after refinement', async () => {
  const h = await setup();
  const prepare = expectDefined(h.api.tasks.prepare);
  const plan = ok(
    await prepare({
      kind: 'create',
      destination: { type: 'note', path: 'a.md', insertion: { type: 'append' } },
      tree: { markdownTitle: 'Draft', children: [{ markdownTitle: 'Child' }] },
    }),
  );
  h.session.stage({ kind: 'task', plan });
  const child = expectDefined(plan.after?.children[0]);
  expect(
    await h.session.focus({
      kind: 'task',
      target: child.target,
      plan: plan.target,
      expectedPlanRevision: plan.revision,
    }),
  ).toBe(true);
  const previous = h.session.snapshot().focus;
  const abort = new AbortController();
  abort.abort();
  expect(await h.session.focus([], abort.signal)).toBe(false);
  expect(h.session.snapshot().focus).toEqual(previous);
  const refined = ok(
    await prepare({
      kind: 'append',
      plan: plan.target,
      expectedPlanRevision: plan.revision,
      operation: {
        type: 'patch',
        target: child.target,
        patch: { markdownTitle: { type: 'set', value: 'Refined' } },
      },
    }),
  );
  h.session.stage({ kind: 'task', plan: refined });
  expect(h.session.snapshot().focus).toEqual([
    {
      kind: 'task',
      target: child.target,
      plan: refined.target,
      expectedPlanRevision: refined.revision,
    },
  ]);
  h.session.discardDraft(refined.target, refined.revision);
  expect(h.session.snapshot().focus).toEqual([]);
});

it('resolves an exact uniquely owned draft focus while rejecting stale or conflicting supplied bases', async () => {
  const h = await setup();
  const plan = ok(
    await expectDefined(h.api.tasks.prepare)({
      kind: 'create',
      destination: { type: 'note', path: 'a.md', insertion: { type: 'append' } },
      tree: { markdownTitle: 'Draft', children: [{ markdownTitle: 'Child' }] },
    }),
  );
  h.session.stage({ kind: 'task', plan });
  const child = expectDefined(plan.after?.children[0]);
  expect(
    await h.session.focus({ kind: 'task', target: child.target, revision: child.revision }),
  ).toBe(true);
  const selected = [
    { kind: 'task', target: child.target, plan: plan.target, expectedPlanRevision: plan.revision },
  ];
  expect(h.session.snapshot().focus).toEqual(selected);
  expect(await h.session.focus({ kind: 'task', target: child.target, revision: 'stale' })).toBe(
    false,
  );
  expect(h.session.snapshot().focus).toEqual(selected);
  expect(
    await h.session.focus({
      kind: 'task',
      target: child.target,
      plan: 'wrong',
      expectedPlanRevision: plan.revision,
    }),
  ).toBe(false);
  expect(h.session.snapshot().focus).toEqual(selected);
  expect(
    await h.session.focus({ kind: 'task', target: child.target, revision: plan.revision }),
  ).toBe(true);
});

it('requires an explicit plan when the same accepted node is present in two current plans', async () => {
  const h = await setup();
  const prepare = expectDefined(h.api.tasks.prepare);
  const root = expectDefined(ok(await h.api.tasks.list()).items[0]);
  const withChild = ok(
    await prepare({
      kind: 'edit',
      target: root.target,
      expectedRevision: root.revision,
      operation: { type: 'add-child', target: root.target, markdownTitle: 'Child' },
    }),
  );
  h.session.stage({ kind: 'task', plan: withChild });
  expect(await h.session.confirm()).toBe(true);
  const saved = ok(await expectDefined(h.api.tasks.tree)({ target: root.target }));
  const child = expectDefined(saved.tree.children[0]);
  const rootPlan = ok(
    await prepare({ kind: 'edit', target: root.target, expectedRevision: saved.tree.revision }),
  );
  const childPlan = ok(
    await prepare({ kind: 'edit', target: child.target, expectedRevision: child.revision }),
  );
  h.session.stage({ kind: 'task', plan: rootPlan });
  h.session.stage({ kind: 'task', plan: childPlan });
  expect(
    await h.session.focus({ kind: 'task', target: child.target, revision: child.revision }),
  ).toBe(false);
  expect(h.session.snapshot().focus).toEqual([]);
  expect(
    await h.session.focus({
      kind: 'task',
      target: child.target,
      plan: childPlan.target,
      expectedPlanRevision: childPlan.revision,
    }),
  ).toBe(true);
});
it('retains original intent and every visible exchange beyond the model working window', async () => {
  const h = await setup();
  h.session.exchange('user', 'Never move the original task out of its project.');
  for (let index = 0; index < 20; index++) h.session.exchange('agent', `Revision ${index}`);
  expect(h.session.snapshot().exchanges).toHaveLength(21);
  expect(h.session.snapshot().exchanges[0]?.text).toBe(
    'Never move the original task out of its project.',
  );
});
it('retains trailing constraints in an accepted long user command', async () => {
  const h = await setup();
  const text = `${'a'.repeat(4100)} Keep the original destination.`;
  await h.session.submit(text);
  expect(h.session.snapshot().exchanges[0]?.text).toBe(text);
  expect(h.session.snapshot().input).toBe('');
});
it('rejects oversized commands before interpretation and retains the complete input', async () => {
  const h = await setup();
  let interpreted = false;
  h.setRun(async () => {
    interpreted = true;
  });
  const text = `${'a'.repeat(16000)} Keep this final constraint.`;
  await h.session.submit(text);
  expect(interpreted).toBe(false);
  expect(h.session.snapshot().input).toBe(text);
  expect(h.session.snapshot().exchanges).toHaveLength(0);
  expect(h.session.snapshot().status.kind).toBe('error');
});

it.each([false, true])(
  'drains prior planning before retaining oversized input (queued=%s)',
  async (queued) => {
    const h = await setup();
    const first = deferred<void>();
    const calls: string[] = [];
    let priorSignal: AbortSignal | undefined;
    h.setRun(async ({ text, signal }) => {
      calls.push(text);
      if (text === 'First') {
        priorSignal = signal;
        await first.promise;
      }
      h.session.status('ready', `Finished ${text}`);
    });
    const pending = h.session.submit('First');
    const next = queued ? h.session.submit('Second') : Promise.resolve();
    const text = 'x'.repeat(16001);
    const rejected = h.session.submit(text);
    const cancelled = priorSignal?.aborted;
    first.resolve();
    await Promise.all([pending, next, rejected]);
    expect(cancelled).toBe(true);
    expect(h.session.snapshot().input).toBe(text);
    expect(h.session.snapshot().status.kind).toBe('error');
    expect(calls).not.toContain(text);
    expect(h.session.snapshot().exchanges.some((entry) => entry.text === text)).toBe(false);
  },
);
it('does not publish rejected input after disposal while draining a previous turn', async () => {
  const h = await setup();
  const first = deferred<void>();
  h.setRun(async () => {
    await first.promise;
  });
  const pending = h.session.submit('First');
  const rejected = h.session.submit('x'.repeat(16001));
  h.session.dispose();
  first.resolve();
  await Promise.all([pending, rejected]);
  expect(h.session.snapshot().input).toBe('');
  expect(h.session.snapshot().exchanges).toEqual([{ role: 'user', text: 'First' }]);
});
it('retains oversized input after a cancelled planning turn settles its admitted write', async () => {
  const h = await setup();
  const native = expectDefined(h.api.tasks.create);
  const admitted = deferred<void>();
  const release = deferred<void>();
  let writes = 0;
  const api = {
    ...h.api,
    tasks: {
      ...h.api.tasks,
      create: async (...args: Parameters<typeof native>) => {
        writes++;
        const result = await native(...args);
        admitted.resolve();
        await release.promise;
        return result;
      },
    },
  };
  const session: CommandSession = new CommandSession({
    api,
    journal: { save: async () => {} },
    now: () => Date.UTC(2026, 7, 1, 12),
    id: (() => {
      let id = 0;
      return () => `reject-admitted-${++id}`;
    })(),
    agent: {
      run: async ({ signal }) => {
        await session.confirmFromTurn(session.snapshot().proposal.revision, signal);
      },
    },
  });
  const plan = ok(
    await expectDefined(api.tasks.prepare)({
      kind: 'create',
      destination: { type: 'note', path: 'a.md', insertion: { type: 'append' } },
      tree: { markdownTitle: 'Admitted once' },
    }),
  );
  session.stage({ kind: 'task', plan });
  const saving = session.submit('Save this');
  await admitted.promise;
  const text = 'x'.repeat(16001);
  const rejected = session.submit(text);
  release.resolve();
  await Promise.all([saving, rejected]);
  expect(writes).toBe(1);
  expect(session.snapshot().journal[0]?.state).toBe('settled');
  expect(session.snapshot().actual[0]?.title).toBe('Admitted once');
  expect(session.snapshot().input).toBe(text);
  expect(session.snapshot().status.kind).toBe('error');
  expect(await h.read('a.md')).toContain('Admitted once');
});

it('asks once before unrelated focus can hide pending work, then cancels without losing either target', async () => {
  const h = await setup();
  const existing = ok(await h.api.tasks.list()).items[0];
  const plan = ok(
    await expectDefined(h.api.tasks.prepare)({
      kind: 'create',
      destination: { type: 'note', path: 'a.md', insertion: { type: 'append' } },
      tree: { markdownTitle: 'Pending parent', children: [{ markdownTitle: 'Pending child' }] },
    }),
  );
  h.session.stage({ kind: 'task', plan });
  await h.session.focus({ kind: 'task', target: expectDefined(plan.after).target });
  await h.session.focus({ kind: 'task', target: expectDefined(plan.after?.children[0]).target });
  expect(h.session.snapshot().activeQuestion).toBeNull();
  const previous = h.session.snapshot().focus;
  expect(
    await h.session.focus({
      kind: 'task',
      target: expectDefined(existing).target,
      revision: expectDefined(existing).revision,
    }),
  ).toBe(false);
  expect(h.session.snapshot().pendingTransition).toMatchObject({
    kind: 'focus',
    target: [{ target: expectDefined(existing).target }],
  });
  expect(h.session.snapshot().focus).toEqual(previous);
  await h.session.submit('');
  expect(await h.read('a.md')).not.toContain('Pending parent');
  expect(await h.session.resolveTransition('cancel')).toBe(true);
  expect(h.session.snapshot().focus).toEqual(previous);
  expect(h.session.snapshot().proposal.changes).toHaveLength(1);
});
it('save-and-switch commits only the agreed prior scope and leaves the next draft for review', async () => {
  const h = await setup();
  const existing = expectDefined(ok(await h.api.tasks.list()).items[0]);
  const prepare = expectDefined(h.api.tasks.prepare);
  const first = ok(
    await prepare({
      kind: 'create',
      destination: { type: 'note', path: 'a.md', insertion: { type: 'append' } },
      tree: { markdownTitle: 'Prior' },
    }),
  );
  h.session.stage({ kind: 'task', plan: first });
  await h.session.focus({ kind: 'task', target: expectDefined(first.after).target });
  await h.session.focus({ kind: 'task', target: existing.target, revision: existing.revision });
  expect(await h.session.resolveTransition('save')).toBe(true);
  const next = ok(
    await prepare({
      kind: 'create',
      destination: { type: 'note', path: 'a.md', insertion: { type: 'append' } },
      tree: { markdownTitle: 'Next' },
    }),
  );
  h.session.stage({ kind: 'task', plan: next });
  expect(await h.read('a.md')).toContain('Prior');
  expect(await h.read('a.md')).not.toContain('Next');
  expect(h.session.snapshot().proposal.changes).toHaveLength(1);
});

it('hide cancels a queued turn as well as the running interpretation while retaining its unsent text', async () => {
  const h = await setup();
  const wait = deferred<void>();
  const accepted: string[] = [];
  h.setRun(async ({ text }) => {
    accepted.push(text);
    await wait.promise;
  });
  const first = h.session.submit('First');
  const queued = h.session.submit('Retain unsent');
  h.session.cancelTurn();
  wait.resolve();
  await Promise.all([first, queued]);
  expect(accepted).toEqual(['First']);
  expect(h.session.snapshot().input).toBe('Retain unsent');
});

it('a late failure from a semantic session switch cannot replace the new session status', async () => {
  const h = await setup();
  const original = h.session.snapshot().id;
  h.setRun(async ({ signal }) => {
    await h.session.newSession('keep', signal);
    throw new Error('old turn failed after switching');
  });
  await h.session.submit('Separate session');
  expect(h.session.snapshot().id).not.toBe(original);
  expect(h.session.snapshot().status.kind).toBe('ready');
});

it('keeping a draft after a disposition question retains its original unresolved question in history', async () => {
  const h = await setup();
  const plan = ok(
    await expectDefined(h.api.tasks.prepare)({
      kind: 'create',
      destination: { type: 'note', path: 'a.md', insertion: { type: 'append' } },
      tree: { markdownTitle: 'Needs a date' },
    }),
  );
  h.session.stage({ kind: 'task', plan });
  h.session.question('Which date should this use?');
  await h.session.newSession();
  expect(await h.session.resolveTransition('keep')).toBe(true);
  expect(h.saved[0]?.activeQuestion).toBe('Which date should this use?');
});

it('stages a new-node checkbox in its exact plan and keeps saved-node status as lifecycle intent', async () => {
  const h = await setup();
  const plan = ok(
    await expectDefined(h.api.tasks.prepare)({
      kind: 'create',
      destination: { type: 'note', path: 'a.md', insertion: { type: 'append' } },
      tree: { markdownTitle: 'Draft', children: [{ markdownTitle: 'Child' }] },
    }),
  );
  h.session.stage({ kind: 'task', plan });
  const child = expectDefined(plan.after?.children[0]);
  expect(
    await h.session.stageStatus({
      target: child.target,
      revision: child.revision,
      plan: plan.target,
      expectedPlanRevision: plan.revision,
      symbol: 'x',
    }),
  ).toBe(true);
  const staged = h.session.snapshot().proposal.changes[0];
  expect(staged?.kind === 'task' && staged.plan.after?.children[0]?.statusSymbol).toBe('x');
  expect(await h.read('a.md')).toBe('- [ ] Existing\n');
  expect(
    await h.session.stageStatus({
      target: child.target,
      revision: child.revision,
      plan: plan.target,
      expectedPlanRevision: plan.revision,
      symbol: ' ',
    }),
  ).toBe(false);
  const saved = ok(await h.api.tasks.list({})).items[0];
  const existing = expectDefined(saved);
  const edit = ok(
    await expectDefined(h.api.tasks.prepare)({
      kind: 'edit',
      target: existing.target,
      expectedRevision: existing.revision,
    }),
  );
  h.session.stage({ kind: 'task', plan: edit });
  const current = expectDefined(edit.after);
  expect(
    await h.session.stageStatus({
      target: current.target,
      revision: current.revision,
      plan: edit.target,
      expectedPlanRevision: edit.revision,
      symbol: 'x',
    }),
  ).toBe(true);
  expect(
    h.session
      .snapshot()
      .proposal.changes.some(
        (change) =>
          change.kind === 'status' &&
          change.target === current.target &&
          change.plan === edit.target,
      ),
  ).toBe(true);
  expect(await h.read('a.md')).toBe('- [ ] Existing\n');
});
it('supplies the latest bounded ambient view hint to each subsequent turn', async () => {
  const h = await setup();
  const seen: string[] = [];
  h.setRun(async ({ session }) => {
    seen.push(session.context);
  });
  h.session.updateContext('View: week');
  await h.session.submit('Inspect');
  h.session.updateContext('View: projects');
  await h.session.submit('Inspect again');
  expect(seen).toEqual(['View: week', 'View: projects']);
  h.session.updateContext('x'.repeat(12000));
  expect(h.session.snapshot().context.length).toBeLessThanOrEqual(8000);
});
it('resolves native navigation only from an accepted opaque target and current revision', async () => {
  const h = await setup();
  const task = expectDefined(ok(await h.api.tasks.list({})).items[0]);
  const target = h.provider.nativeTaskTarget(task.target, task.revision);
  expect(target).toEqual(h.index.listNodes()[0]?.target);
  expect(h.provider.nativeTaskTarget('Existing', task.revision)).toBeUndefined();
  expect(h.provider.nativeTaskTarget(task.target, 'old')).toBeUndefined();
  await h.external('a.md', '- [ ] Replacement\n');
  expect(h.provider.nativeTaskTarget(task.target, task.revision)).toBeUndefined();
});

it.each(['target', 'plan', 'revision'])(
  'rejects mismatched %s while reviewing a saved pending removal',
  async (mismatch) => {
    const h = await setup();
    const original = expectDefined(ok(await h.api.tasks.list()).items[0]);
    const plan = ok(
      await expectDefined(h.api.tasks.prepare)({
        kind: 'edit',
        target: original.target,
        expectedRevision: original.revision,
        operation: { type: 'remove', target: original.target },
      }),
    );
    h.session.stage({ kind: 'task', plan });
    const focus = {
      kind: 'task' as const,
      target: original.target,
      plan: plan.target,
      expectedPlanRevision: plan.revision,
    };
    const wrong = { ...focus };
    if (mismatch === 'target') wrong.target = 'unknown';
    else if (mismatch === 'plan') wrong.plan = 'unrelated';
    else wrong.expectedPlanRevision = 'stale';
    expect(await h.session.focus(wrong)).toBe(false);
    expect(h.session.snapshot().focus).toEqual([]);
    expect(await h.read('a.md')).toBe('- [ ] Existing\n');
    expect(await h.session.focus(focus)).toBe(true);
    expect(h.session.snapshot().focus).toEqual([focus]);
  },
);

it('keeps a voice proposal basis through planning but rejects another focus before queued admission', async () => {
  const h = await setup();
  const captured = h.session.captureSubmission();
  const first = deferred<void>();
  let calls = 0;
  h.setRun(async () => {
    calls++;
    if (calls === 1) await first.promise;
  });
  const planning = h.session.submit('Plan');
  const queued = h.session.submit('Spoken refinement', captured.basis, undefined, () =>
    captured.current(),
  );
  const plan = ok(
    await expectDefined(h.api.tasks.prepare)({
      kind: 'create',
      destination: { type: 'note', path: 'a.md', insertion: { type: 'append' } },
      tree: { markdownTitle: 'Another subject' },
    }),
  );
  h.session.stage({ kind: 'task', plan });
  expect(captured.current()).toBe(true);
  expect(captured.basis.proposalRevision).toBe(0);
  await h.session.focus({
    kind: 'task',
    target: expectDefined(plan.after).target,
    plan: plan.target,
    expectedPlanRevision: plan.revision,
  });
  expect(captured.current()).toBe(false);
  first.resolve();
  await Promise.all([planning, queued]);
  expect(calls).toBe(1);
  expect(await h.read('a.md')).toBe('- [ ] Existing\n');
});
it('retires captured speech when a verified write removes its focused object without a successor', async () => {
  const h = await setup();
  const task = expectDefined(ok(await h.api.tasks.list({})).items[0]);
  await h.session.focus({ kind: 'task', target: task.target, revision: task.revision });
  const captured = h.session.captureSubmission();
  h.session.remapFocus(new Map([[task.target, null]]));
  expect(captured.current()).toBe(false);
});

it('clears shared draft provenance after whitespace confirmation without clearing later edits', async () => {
  const h = await setup();
  const plan = ok(
    await expectDefined(h.api.tasks.prepare)({
      kind: 'create',
      destination: { type: 'note', path: 'a.md', insertion: { type: 'append' } },
      tree: { markdownTitle: 'Confirmed' },
    }),
  );
  h.session.stage({ kind: 'task', plan });
  h.session.setInput(' ');
  expect(h.session.captureInput().dirty).toBe(true);
  await h.session.submit(' ');
  expect(h.session.snapshot().status.kind).toBe('saved');
  expect(h.session.snapshot().input).toBe('');
  expect(h.session.captureInput().dirty).toBe(false);
});

it('keeps a retained clarification visible when a semantic turn makes no disposition', async () => {
  const h = await setup();
  h.session.question('Which exact task?');
  await h.session.submit('Continue');
  expect(h.session.snapshot().activeQuestion).toBe('Which exact task?');
  expect(h.session.snapshot().status).toEqual({ kind: 'question', message: 'Which exact task?' });
});

it('saves the reviewed proposal before completing a new-session Save disposition', async () => {
  const h = await setup();
  const plan = ok(
    await expectDefined(h.api.tasks.prepare)({
      kind: 'create',
      destination: { type: 'note', path: 'a.md', insertion: { type: 'append' } },
      tree: { markdownTitle: 'New' },
    }),
  );
  h.session.stage({ kind: 'task', plan });
  const original = h.session.snapshot().id;
  expect(await h.session.newSession()).toBe(false);
  expect(await h.session.resolveTransition('save')).toBe(true);
  expect(h.session.snapshot().id).not.toBe(original);
  expect(await h.read('a.md')).toContain('New');
});

it.each(['reparent', 'promote'] as const)(
  'keeps %s hierarchy focus within the exact affected root and follows its saved correspondence',
  async (kind) => {
    const source =
      '- [ ] Workspace\n  - [ ] Same\n    - [ ] First leaf\n  - [ ] Same\n    - [ ] Second leaf\n';
    const h = await setup({ 'a.md': source });
    const listed = ok(await h.api.tasks.list()).items;
    const root = expectDefined(listed.find((node) => node.source.line === 0));
    const parent = expectDefined(listed.find((node) => node.source.line === 1));
    const moving = expectDefined(listed.find((node) => node.source.line === 3));
    const prepared = ok(
      await expectDefined(h.api.tasks.prepare)({
        kind: 'hierarchy',
        operation:
          kind === 'reparent'
            ? {
                type: 'reparent',
                source: moving.target,
                expectedSourceRevision: moving.revision,
                parent: parent.target,
                expectedParentRevision: parent.revision,
              }
            : { type: 'promote', source: moving.target, expectedSourceRevision: moving.revision },
      }),
    );
    const plan = await canonicalCommandPlan(h.api, prepared, new AbortController().signal, {
      now: () => Date.UTC(2026, 7, 1, 12),
      deadline: Date.UTC(2026, 7, 1, 12) + 5000,
    });
    h.session.stage({ kind: 'task', plan });
    expect(
      await h.session.focus({
        kind: 'task',
        target: moving.target,
        plan: plan.target,
        expectedPlanRevision: plan.revision,
      }),
    ).toBe(true);
    expect(
      await h.session.focus({
        kind: 'task',
        target: root.target,
        plan: plan.target,
        expectedPlanRevision: plan.revision,
      }),
    ).toBe(true);
    expect(h.session.snapshot().pendingTransition ?? null).toBeNull();
    expect(h.session.snapshot().activeQuestion).toBeNull();
    expect(await h.read('a.md')).toBe(source);
    expect(await h.session.confirm()).toBe(true);
    const focus = expectDefined(h.session.snapshot().focus[0]);
    expect(focus.kind).toBe('task');
    const current = ok(await h.api.tasks.get(focus.target));
    expect(current.markdownTitle).toBe('Workspace');
    expect(current.parentTarget).toBeUndefined();
    expect(focus.revision).toBe(current.revision);
    expect(h.session.snapshot().journal).toHaveLength(1);
    expect(await h.read('a.md')).toBe(
      kind === 'reparent'
        ? '- [ ] Workspace\n  - [ ] Same\n    - [ ] First leaf\n    - [ ] Same\n      - [ ] Second leaf\n'
        : '- [ ] Workspace\n  - [ ] Same\n    - [ ] First leaf\n- [ ] Same\n  - [ ] Second leaf\n',
    );
  },
);

const readbackSource =
  '- [ ] Root 🔁 every week on Wednesday\n  - Root comment\n  - [ ] Child A\n    - 2026-08-01: Dated child comment\n    - 2026-08-01T09:00:00+00:00 → 2026-08-01T09:45:00+00:00\n    - [ ] Grandchild\n      - Grandchild comment\n  - [ ] Child B\n';
async function stageReadbackEdit(h: Awaited<ReturnType<typeof setup>>) {
  const root = expectDefined(ok(await h.api.tasks.list()).items[0]);
  const plan = ok(
    await expectDefined(h.api.tasks.prepare)({
      kind: 'edit',
      target: root.target,
      expectedRevision: root.revision,
      operation: {
        type: 'patch',
        target: root.target,
        patch: {
          recurrence: { type: 'set', value: 'every week on Friday' },
        },
      },
    }),
  );
  const complete = await canonicalCommandPlan(h.api, plan, new AbortController().signal, {
    now: () => 0,
    deadline: 5000,
  });
  h.session.stage({ kind: 'task', plan: complete });
  return root;
}
it('publishes complete committed descendants and restores the exact actual tree from verified JSON without native reads', async () => {
  let applies = 0;
  const h = await setup({ 'a.md': readbackSource }, (api) => ({
    ...api,
    tasks: {
      ...api.tasks,
      apply: async (...args) => {
        applies++;
        return expectDefined(api.tasks.apply)(...args);
      },
    },
  }));
  const root = await stageReadbackEdit(h);
  const shallow = ok(await expectDefined(h.api.tasks.tree)({ target: root.target, limit: 500 }));
  expect(shallow.tree.complete).toBe(false);
  expect(shallow.tree.children[0]?.comments).toEqual([]);
  expect(await h.session.confirm()).toBe(true);
  const snapshot = h.session.snapshot();
  const actual = expectDefined(snapshot.actual[0]);
  expect(actual).toMatchObject({
    complete: true,
    truncated: false,
    comments: [{ text: 'Root comment' }],
    children: [
      {
        complete: true,
        comments: [
          { text: 'Dated child comment', timestamp: { precision: 'day', value: '2026-08-01' } },
        ],
        timeEntries: [
          {
            startMs: Date.parse('2026-08-01T09:00:00+00:00'),
            endMs: Date.parse('2026-08-01T09:45:00+00:00'),
            state: 'closed',
          },
        ],
        children: [{ complete: true, comments: [{ text: 'Grandchild comment' }] }],
      },
      { complete: true, markdownTitle: 'Child B' },
    ],
  });
  const current = ok(
    await expectDefined(h.api.tasks.tree)({
      target: actual.target,
      expectedRevision: actual.revision,
    }),
  );
  const canonical = await canonicalCommandTree(h.api, current, new AbortController().signal, {
    now: () => 0,
    deadline: 5000,
  });
  expect(actual).toEqual(canonical.tree);
  expect(await h.read('a.md')).toBe(readbackSource.replace('Wednesday', 'Friday'));
  expect(applies).toBe(1);
  const storage = commandSessionStorage();
  const open = () => CommandSessionStore.open({ ...storage, now: () => 1 });
  const store = await open();
  await store.create(snapshot);
  const restored = expectDefined((await open()).records()[0]).snapshot;
  const historical = new CommandSession({
    api: {
      ...h.api,
      tasks: {
        ...h.api.tasks,
        tree: async () => {
          throw new Error('Historical reads are forbidden');
        },
      },
    },
    agent: { run: async () => {} },
    journal: { save: async () => {} },
    now: () => 1,
    id: () => 'restored',
  });
  expect(historical.restore(restored)).toBe(true);
  expect(historical.snapshot().actual).toEqual(snapshot.actual);
  expect(historical.readOnly()).toBe(true);
  expect(await historical.confirm()).toBe(false);
  expect(applies).toBe(1);
  historical.dispose();
});
it('exhausts per-owner cursors before publishing a saved tree with more than 500 entries', async () => {
  const comments = Array.from({ length: 503 }, (_, i) => `  - Comment ${i}\n`).join('');
  const h = await setup({ 'a.md': `- [ ] Root\n${comments}  - [ ] Child\n    - Nested\n` });
  const root = expectDefined(ok(await h.api.tasks.list()).items[0]);
  h.session.stage({
    kind: 'status',
    target: root.target,
    revision: root.revision,
    symbol: 'x',
    nuance: 'Complete with normal lifecycle',
  });
  expect(await h.session.confirm()).toBe(true);
  const tree = expectDefined(h.session.snapshot().actual[0]);
  expect(tree.complete).toBe(true);
  expect(tree.comments.map((comment) => comment.text)).toEqual(
    Array.from({ length: 503 }, (_, i) => `Comment ${i}`),
  );
  expect(tree.entries).toHaveLength(504);
  expect(tree.children[0]?.comments[0]?.text).toBe('Nested');
});
it.each(['read failure', 'revision change', 'deadline'])(
  'retains the committed receipt and prohibits replay after descendant %s',
  async (failure) => {
    let applies = 0;
    let clock = Date.UTC(2026, 7, 1, 12);
    const h = await setup(
      { 'a.md': readbackSource },
      (api) => ({
        ...api,
        tasks: {
          ...api.tasks,
          apply: async (...args) => {
            applies++;
            return expectDefined(api.tasks.apply)(...args);
          },
          tree: async (input, options) => {
            const result = await expectDefined(api.tasks.tree)(input, options);
            if (applies > 0 && result.ok && result.value.tree.markdownTitle === 'Child A') {
              if (failure === 'read failure') throw new Error('Unavailable descendant');
              if (failure === 'deadline') {
                clock += 6000;
                return result;
              }
              return {
                ...result,
                value: {
                  ...result.value,
                  tree: { ...result.value.tree, revision: 'changed-revision' },
                },
              };
            }
            return result;
          },
        },
      }),
      () => clock,
    );
    await stageReadbackEdit(h);
    expect(await h.session.confirm()).toBe(false);
    expect(h.session.snapshot().status.message).toBe(
      'The write settled, but the complete saved result could not be verified. Review the current source before continuing.',
    );
    expect(h.session.snapshot()).toMatchObject({
      status: { kind: 'error' },
      blocked: true,
      journal: [{ state: 'settled', effects: 'committed', receipt: { effects: 'committed' } }],
      actual: [],
    });
    expect(await h.session.confirm()).toBe(false);
    expect(applies).toBe(1);
    expect(await h.read('a.md')).toBe(readbackSource.replace('Wednesday', 'Friday'));
  },
);

it.each(['thinking', 'searching', 'writing'] as const)(
  'restores interrupted %s as stopped history without replay, including Stop and reopen',
  async (kind) => {
    const h = await setup();
    await h.session.submit('Retained exchange');
    const plan = ok(
      await expectDefined(h.api.tasks.prepare)({
        kind: 'create',
        destination: { type: 'note', path: 'a.md', insertion: { type: 'append' } },
        tree: { markdownTitle: 'Pending draft', children: [{ markdownTitle: 'Retained child' }] },
      }),
    );
    h.session.stage({ kind: 'task', plan });
    const listed = ok(await h.api.tasks.list());
    const actual = ok(
      await expectDefined(h.api.tasks.tree)({ target: expectDefined(listed.items[0]).target }),
    );
    h.session.setInput('Unsent draft');
    const snapshot: CommandSessionSnapshot = {
      ...h.session.snapshot(),
      status: { kind, message: 'Active operation' },
      actual: [actual.tree],
      activeQuestion: 'Retained question?',
      journal:
        kind === 'writing'
          ? [
              {
                id: 'interrupted',
                proposalRevision: 0,
                change: {
                  kind: 'status',
                  target: 'task',
                  revision: 'revision',
                  symbol: 'x',
                  nuance: '',
                },
                request: { requestId: 'request', expiresAt: 100 },
                state: 'admitted',
              },
            ]
          : [],
    };
    let calls = 0;
    h.setRun(async () => {
      calls++;
    });
    expect(h.session.restore(snapshot)).toBe(true);
    const restored = h.session.snapshot();
    expect(restored.status.kind).toBe(kind === 'writing' ? 'error' : 'ready');
    expect(restored.recovery).toBe(kind === 'writing' ? 'uncertain' : 'historical');
    expect(restored.blocked).toBe(kind === 'writing');
    h.session.cancelTurn();
    expect(h.session.restore(h.session.snapshot())).toBe(true);
    for (const key of [
      'input',
      'proposal',
      'actual',
      'activeQuestion',
      'exchanges',
      'journal',
    ] as const)
      expect(h.session.snapshot()[key]).toEqual(snapshot[key]);
    expect(h.session.snapshot().status).toEqual(restored.status);
    expect(await h.session.confirm()).toBe(false);
    expect(calls).toBe(0);
  },
);

it.each([false, true])(
  'composes protected prose and task edits in the same note (task first=%s)',
  async (taskFirst) => {
    const h = await setup({ 'a.md': 'Original prose\n\n- [ ] Existing\n' });
    const root = expectDefined(ok(await h.api.tasks.list()).items[0]);
    const task = ok(
      await expectDefined(h.api.tasks.prepare)({
        kind: 'edit',
        target: root.target,
        expectedRevision: root.revision,
        operation: {
          type: 'patch',
          target: root.target,
          patch: { markdownTitle: { type: 'set', value: 'Renamed' } },
        },
      }),
    );
    const notes = expectDefined(h.api.notes);
    const page = ok(await notes.read({ selector: { path: 'a.md' } }));
    const section = expectDefined(
      page.segments.find((segment) => segment.section.kind === 'prose'),
    );
    const note = ok(
      await notes.prepare({
        kind: 'edit',
        target: page.note.target,
        expectedRevision: page.note.revision,
        operation: {
          type: 'replace-section',
          section: section.section.target,
          text: 'Changed prose\n\n',
        },
      }),
    );
    if (taskFirst) h.session.stage({ kind: 'task', plan: task });
    h.session.stage({ kind: 'note', plan: note });
    if (!taskFirst) h.session.stage({ kind: 'task', plan: task });
    expect(await h.session.confirm()).toBe(true);
    expect(await h.read('a.md')).toBe('Changed prose\n\n- [ ] Renamed\n');
    expect(h.session.snapshot().journal.map((entry) => entry.effects)).toEqual([
      'committed',
      'committed',
    ]);
  },
);

it('does not dispatch project creation after cancellation during schema read', async () => {
  const entered = deferred<void>(),
    release = deferred<void>();
  let holding = false;
  const created: string[] = [];
  const schema = {
    providerEpoch: 'epoch',
    revision: 1,
    generation: 1,
    scopeRevision: 1,
    semanticsRevision: 1,
    statuses: [],
    fields: [],
  };
  const h = await setup(undefined, (api) => ({
    ...api,
    projects: {
      schema: async () => {
        if (holding) {
          entered.resolve();
          await release.promise;
        }
        return { ok: true as const, value: schema };
      },
      create: async (input: { name: string }) => {
        created.push(input.name);
        return {
          ok: false as const,
          effects: 'unchanged' as const,
          recovery: 'none' as const,
          error: {
            code: 'INVALID_ARGUMENT' as const,
            category: 'validation' as const,
            message: 'failed',
          },
        };
      },
    } as unknown as NonNullable<TasksApiV1['projects']>,
  }));
  h.session.stage({ kind: 'project-create', id: 'p', name: 'New project', schema });
  holding = true;
  const writing = h.session.confirm();
  await entered.promise;
  h.session.cancelTurn();
  release.resolve();
  await writing;
  expect(created).toEqual([]);
  expect(h.session.snapshot().journal[0]).toMatchObject({ state: 'settled', effects: 'unchanged' });
});

it('settles a project request already dispatched when cancellation arrives', async () => {
  const entered = deferred<void>(),
    release = deferred<void>();
  const schema = {
    providerEpoch: 'epoch',
    revision: 1,
    generation: 1,
    scopeRevision: 1,
    semanticsRevision: 1,
    statuses: [],
    fields: [],
  };
  let calls = 0;
  let settlementSignal: AbortSignal | undefined;
  const h = await setup(undefined, (api) => ({
    ...api,
    projects: {
      schema: async () => ({ ok: true as const, value: schema }),
      create: async (_input: unknown, options?: { signal?: AbortSignal }) => {
        settlementSignal = options?.signal;
        calls++;
        entered.resolve();
        await release.promise;
        return {
          ok: false as const,
          effects: 'unchanged' as const,
          recovery: 'none' as const,
          error: {
            code: 'INVALID_ARGUMENT' as const,
            category: 'validation' as const,
            message: 'failed',
          },
        };
      },
    } as unknown as NonNullable<TasksApiV1['projects']>,
  }));
  h.session.stage({ kind: 'project-create', id: 'p', name: 'New project', schema });
  const writing = h.session.confirm();
  await entered.promise;
  h.session.cancelTurn();
  expect(expectDefined(settlementSignal).aborted).toBe(false);
  release.resolve();
  await writing;
  expect(calls).toBe(1);
  expect(h.session.snapshot().journal).toMatchObject([
    { state: 'settled', effects: 'unchanged', error: 'INVALID_ARGUMENT' },
  ]);
});

it('refuses a same-note task continuation when external task meaning changes after prose is saved', async () => {
  let changeSource: () => Promise<void> = async () => {};
  const h = await setup({ 'a.md': 'Original prose\n\n- [ ] Existing\n' }, (api) => ({
    ...api,
    tasks: {
      ...api.tasks,
      prepare: async (input, options) => {
        if (input.kind === 'refresh') await changeSource();
        return expectDefined(api.tasks.prepare)(input, options);
      },
    },
  }));
  changeSource = async () => h.external('a.md', 'Changed prose\n\n- [ ] External\n');
  const root = expectDefined(ok(await h.api.tasks.list()).items[0]);
  const task = ok(
    await expectDefined(h.api.tasks.prepare)({
      kind: 'edit',
      target: root.target,
      expectedRevision: root.revision,
      operation: {
        type: 'patch',
        target: root.target,
        patch: { markdownTitle: { type: 'set', value: 'Renamed' } },
      },
    }),
  );
  const notes = expectDefined(h.api.notes);
  const page = ok(await notes.read({ selector: { path: 'a.md' } }));
  const section = expectDefined(page.segments.find((segment) => segment.section.kind === 'prose'));
  const note = ok(
    await notes.prepare({
      kind: 'edit',
      target: page.note.target,
      expectedRevision: page.note.revision,
      operation: {
        type: 'replace-section',
        section: section.section.target,
        text: 'Changed prose\n\n',
      },
    }),
  );
  h.session.stage({ kind: 'note', plan: note });
  h.session.stage({ kind: 'task', plan: task });
  expect(await h.session.confirm()).toBe(false);
  expect(await h.read('a.md')).toBe('Changed prose\n\n- [ ] External\n');
  expect(h.session.snapshot().journal).toHaveLength(1);
  expect(h.session.snapshot().journal[0]).toMatchObject({ state: 'settled', effects: 'committed' });
});

it('refreshes an edited child after a prose insertion shifts it while preserving its sibling', async () => {
  const h = await setup({ 'a.md': 'Intro\n\n- [ ] Parent\n\t- [ ] Child\n\t- [ ] Sibling\n' });
  const tasks = ok(await h.api.tasks.list()).items;
  const child = expectDefined(tasks.find((item) => item.markdownTitle === 'Child'));
  const task = ok(
    await expectDefined(h.api.tasks.prepare)({
      kind: 'edit',
      target: child.target,
      expectedRevision: child.revision,
      operation: {
        type: 'patch',
        target: child.target,
        patch: { markdownTitle: { type: 'set', value: 'Renamed child' } },
      },
    }),
  );
  const notes = expectDefined(h.api.notes);
  const page = ok(await notes.read({ selector: { path: 'a.md' } }));
  const section = expectDefined(page.segments.find((segment) => segment.section.kind === 'prose'));
  const note = ok(
    await notes.prepare({
      kind: 'edit',
      target: page.note.target,
      expectedRevision: page.note.revision,
      operation: { type: 'append', section: section.section.target, text: 'Inserted\n\n' },
    }),
  );
  h.session.stage({ kind: 'task', plan: task });
  h.session.stage({ kind: 'note', plan: note });
  expect(await h.session.confirm()).toBe(true);
  expect(await h.read('a.md')).toBe(
    'Intro\n\nInserted\n\n- [ ] Parent\n\t- [ ] Renamed child\n\t- [ ] Sibling\n',
  );
  expect(h.session.snapshot().journal.map((entry) => entry.effects)).toEqual([
    'committed',
    'committed',
  ]);
});

it('does not apply a dependent task when the preceding note edit fails', async () => {
  const h = await setup({ 'a.md': 'Original prose\n\n- [ ] Existing\n' });
  const root = expectDefined(ok(await h.api.tasks.list()).items[0]);
  const task = ok(
    await expectDefined(h.api.tasks.prepare)({
      kind: 'edit',
      target: root.target,
      expectedRevision: root.revision,
      operation: {
        type: 'patch',
        target: root.target,
        patch: { markdownTitle: { type: 'set', value: 'Renamed' } },
      },
    }),
  );
  const notes = expectDefined(h.api.notes);
  const page = ok(await notes.read({ selector: { path: 'a.md' } }));
  const section = expectDefined(page.segments.find((segment) => segment.section.kind === 'prose'));
  const note = ok(
    await notes.prepare({
      kind: 'edit',
      target: page.note.target,
      expectedRevision: page.note.revision,
      operation: {
        type: 'replace-section',
        section: section.section.target,
        text: 'Changed prose\n\n',
      },
    }),
  );
  h.session.stage({ kind: 'note', plan: note });
  h.session.stage({ kind: 'task', plan: task });
  await h.external('a.md', 'External prose\n\n- [ ] Existing\n');
  expect(await h.session.confirm()).toBe(false);
  expect(await h.read('a.md')).toBe('External prose\n\n- [ ] Existing\n');
  expect(h.session.snapshot().journal).toHaveLength(1);
  expect(h.session.snapshot().journal[0]).toMatchObject({ state: 'settled', effects: 'unchanged' });
});
