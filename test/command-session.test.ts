import { afterEach, expect, it } from 'vitest';
import type { ApiResultV1 } from '../api';
import { sameReviewedContent } from '../src/ai/commandSchemas';
import { CommandSession } from '../src/ai/CommandSession';
import type { CommandAgentPort, CommandSessionSnapshot } from '../src/ai/commandTypes';
import { deferred, expectDefined } from './helpers';
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
async function setup() {
  const h = await publicApiHarness({ 'a.md': '- [ ] Existing\n' });
  owners.push(h);
  const api = h.client();
  const saved: CommandSessionSnapshot[] = [];
  let run: CommandAgentPort['run'] = async () => {};
  const session = new CommandSession({
    api,
    journal: {
      save: async (state) => {
        saved.push(state);
      },
    },
    now: () => Date.UTC(2026, 7, 1, 12),
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
  expect(h.session.snapshot().input).toBe('Second');
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
  expect(h.session.snapshot().input).toBe(text);
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
  expect(h.session.snapshot().input).toBe('First');
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
