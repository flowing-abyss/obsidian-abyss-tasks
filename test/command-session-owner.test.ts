import { afterEach, expect, it } from 'vitest';
import type { TasksApiV1 } from '../api';
import { CommandSession } from '../src/ai/CommandSession';
import { CommandSessionOwner } from '../src/ai/CommandSessionOwner';
import { CommandSessionStore } from '../src/ai/CommandSessionStore';
import type { CommandAgentPort } from '../src/ai/commandTypes';
import { deferred, expectDefined } from './helpers';
import { publicApiHarness, type PublicApiHarness } from './support/publicApiHarness';

const harnesses: PublicApiHarness[] = [];
const owners: CommandSessionOwner[] = [];
afterEach(() => {
  owners.splice(0).forEach((owner) => {
    owner.dispose();
  });
  harnesses.splice(0).forEach((harness) => {
    harness.dispose();
  });
});
async function setup(initial?: unknown) {
  const h = await publicApiHarness({ 'a.md': '- [ ] Existing\n' });
  harnesses.push(h);
  let raw: unknown = initial,
    failed = false,
    saves = 0,
    ids = 0,
    clients = 0;
  let now = Date.UTC(2026, 7, 1, 12);
  let live: CommandSession;
  let api: TasksApiV1;
  type CreateResult = Awaited<ReturnType<NonNullable<TasksApiV1['tasks']['create']>>>;
  let aroundCreate = async (write: () => Promise<CreateResult>) => write();
  let run: CommandAgentPort['run'] = async () => {};
  const timers = new Set<() => void>();
  let afterSave: (() => void) | undefined;
  const storage = {
    load: () => structuredClone(raw),
    save: (value: unknown) => {
      saves++;
      if (failed) throw new Error('quota');
      raw = structuredClone(value);
      const callback = afterSave;
      afterSave = undefined;
      callback?.();
    },
  };
  const createOwner = () => {
    const store = new CommandSessionStore({ storage, now: () => now });
    const owner = new CommandSessionOwner({
      store,
      schedule: (callback) => {
        timers.add(callback);
        return () => {
          timers.delete(callback);
        };
      },
      createSession: (journal, transitions) => {
        clients++;
        const facade = h.client(`owner-${clients}`);
        api = {
          ...facade,
          tasks: {
            ...facade.tasks,
            create: (input, options) =>
              aroundCreate(() => expectDefined(facade.tasks.create)(input, options)),
          },
        };
        live = new CommandSession({
          api,
          journal,
          transitions,
          now: () => now,
          id: () => `session-${++ids}`,
          agent: { run: (input) => run(input) },
        });
        return live;
      },
    });
    owners.push(owner);
    return { owner, store };
  };
  const { owner, store } = createOwner();
  return {
    ...h,
    owner,
    store,
    createOwner,
    session: () => live,
    api: () => api,
    aroundCreate: (work: typeof aroundCreate) => {
      aroundCreate = work;
    },
    afterSave: (callback: () => void) => {
      afterSave = callback;
    },
    raw: () => structuredClone(raw),
    saves: () => saves,
    clients: () => clients,
    fail: (value: boolean) => {
      failed = value;
    },
    clock: (value: number) => {
      now = value;
      h.clock(value);
    },
    run: (value: CommandAgentPort['run']) => {
      run = value;
    },
    tick: async () => {
      for (const timer of [...timers]) {
        timers.delete(timer);
        timer();
      }
      await Promise.resolve();
    },
  };
}
it('retains the same runtime and exact unsent state through hide and reopen, with coalesced typing writes', async () => {
  const h = await setup();
  h.owner.open();
  for (let i = 0; i < 100; i++) h.owner.setInput(`Unsent ${i}`);
  expect(h.saves()).toBe(0);
  const before = h.owner.snapshot();
  await h.owner.hide();
  expect(h.owner.open()).toEqual(before);
  expect(h.clients()).toBe(1);
  expect(h.saves()).toBe(1);
  const reloaded = h.createOwner().owner;
  expect(reloaded.snapshot().input).toBe('Unsent 99');
});
it('persists every normal command and retains the current runtime when a required transition save fails', async () => {
  const h = await setup();
  h.owner.open();
  await h.owner.submit('Remember the full original intent');
  const id = h.owner.snapshot().id;
  h.fail(true);
  expect(await h.owner.newSession('keep')).toBe(false);
  expect(h.owner.snapshot().id).toBe(id);
  expect(h.owner.snapshot().exchanges[0]?.text).toBe('Remember the full original intent');
  h.fail(false);
  expect(await h.owner.newSession('keep')).toBe(true);
  expect(h.owner.snapshot().id).not.toBe(id);
  expect(h.clients()).toBe(1);
  expect(
    h.owner.recent().find((record) => record.snapshot.id === id)?.snapshot.exchanges[0]?.text,
  ).toBe('Remember the full original intent');
});
it('keeps malformed storage untouched while permitting in-memory planning', async () => {
  const h = await setup({ version: 99, future: true });
  h.owner.open();
  await h.owner.submit('Inspect without a write');
  await h.owner.flush();
  expect(h.owner.snapshot().exchanges).toEqual([{ role: 'user', text: 'Inspect without a write' }]);
  expect(h.owner.persistenceFailure()?.code).toBe('UNREADABLE_HISTORY');
  expect(h.owner.snapshot().status.kind).toBe('error');
  expect(h.raw()).toEqual({ version: 99, future: true });
  expect(h.saves()).toBe(0);
});
it('revokes delayed old-owner callbacks before a replacement can write history', async () => {
  const h = await setup();
  const wait = deferred<void>();
  h.run(async ({ signal }) => {
    await wait.promise;
    if (!signal.aborted) throw new Error('accepted stale turn');
  });
  const running = h.owner.submit('Delayed command');
  h.owner.dispose();
  const replacement = h.createOwner().owner;
  replacement.setInput('Replacement input');
  await replacement.flush();
  const saved = h.raw();
  wait.resolve();
  await running;
  await h.tick();
  expect(h.raw()).toEqual(saved);
  expect(replacement.snapshot().input).toBe('Replacement input');
});
it('selection storage failure leaves the active session and its unsent input intact', async () => {
  const h = await setup();
  const first = h.owner.snapshot().id;
  await h.owner.newSession('keep');
  h.owner.setInput('Do not lose this');
  const current = h.owner.snapshot().id;
  h.fail(true);
  expect(await h.owner.select(first)).toBe(false);
  expect(h.owner.snapshot().id).toBe(current);
  expect(h.owner.snapshot().input).toBe('Do not lose this');
});

async function stageCreate(h: Awaited<ReturnType<typeof setup>>, title = 'Created once') {
  const result = await expectDefined(h.api().tasks.prepare)({
    kind: 'create',
    destination: { type: 'note', path: 'a.md', insertion: { type: 'append' } },
    tree: { markdownTitle: title },
  });
  if (!result.ok) throw new Error(result.error.code);
  h.session().stage({ kind: 'task', plan: result.value });
  return result.value;
}
it('keeps real receipt/readback after post-write storage failure and never duplicates the applied create', async () => {
  const h = await setup();
  await stageCreate(h);
  h.aroundCreate(async (write) => {
    const result = await write();
    h.fail(true);
    return result;
  });
  expect(await h.owner.confirm()).toBe(false);
  expect(h.owner.snapshot().journal[0]?.effects).toBe('committed');
  expect(h.owner.snapshot().actual[0]?.title).toBe('Created once');
  expect(h.owner.snapshot().blocked).toBe(true);
  h.fail(false);
  expect(await h.owner.confirm()).toBe(false);
  expect((await h.read('a.md')).match(/Created once/g)).toHaveLength(1);
});
it('external session switching drains an admitted effect while hide preserves its real outcome', async () => {
  const h = await setup();
  await stageCreate(h);
  const admitted = deferred<void>(),
    finish = deferred<void>();
  h.aroundCreate(async (write) => {
    const result = await write();
    admitted.resolve();
    await finish.promise;
    return result;
  });
  const id = h.owner.snapshot().id;
  const writing = h.owner.confirm();
  await admitted.promise;
  await h.owner.hide();
  const switching = h.owner.newSession('keep');
  expect(h.owner.snapshot().id).toBe(id);
  finish.resolve();
  expect(await writing).toBe(true);
  expect(await switching).toBe(true);
  expect(
    h.owner.recent().find((entry) => entry.snapshot.id === id)?.snapshot.journal[0]?.effects,
  ).toBe('committed');
  expect((await h.read('a.md')).match(/Created once/g)).toHaveLength(1);
});

it('reload retains historical preview and intent, then explicit review keeps its ID and invalidates old confirmation', async () => {
  const h = await setup();
  await stageCreate(h);
  await h.owner.submit('Create exactly this original tree');
  const original = h.owner.snapshot();
  await h.owner.flush();
  h.owner.dispose();
  const restored = h.createOwner().owner;
  expect(restored.snapshot().id).toBe(original.id);
  expect(restored.snapshot().trees).toEqual(original.trees);
  expect(restored.snapshot().recovery).toBe('historical');
  expect(await restored.confirm()).toBe(false);
  expect(await restored.review()).toBe(true);
  expect(restored.snapshot().id).toBe(original.id);
  expect(restored.snapshot().recovery).toBe('reviewing');
  expect(restored.snapshot().proposal.changes).toEqual([]);
  expect(restored.snapshot().recoveryEvidence?.proposal).toEqual(original.proposal);
  expect(restored.snapshot().exchanges).toEqual(original.exchanges);
  await stageCreate(h, 'Renewed preview');
  h.session().finishReview();
  expect(await restored.confirm(original.proposal.revision)).toBe(false);
  expect(await h.read('a.md')).not.toContain('Renewed preview');
  expect(await restored.confirm()).toBe(true);
});
it('kept same-runtime plan resumes only after public source proof and expiry requires renewed review', async () => {
  const h = await setup();
  await stageCreate(h);
  const id = h.owner.snapshot().id;
  await h.owner.newSession('keep');
  expect(await h.owner.select(id)).toBe(true);
  expect(h.owner.snapshot().recovery ?? 'live').toBe('live');
  await h.owner.newSession('keep');
  h.clock(Date.UTC(2026, 7, 1, 12) + 300001);
  expect(await h.owner.select(id)).toBe(true);
  expect(h.owner.snapshot().recovery).toBe('historical');
  expect(await h.owner.confirm()).toBe(false);
});
it('unresolved effects permit inspection and only explicit acknowledgement starts an independent session', async () => {
  const h = await setup();
  await stageCreate(h);
  h.aroundCreate(async (write) => {
    await write();
    return {
      ok: false,
      effects: 'unknown',
      recovery: 'reconcile',
      error: { category: 'io', code: 'LOST', message: 'Lost' },
    };
  });
  await h.owner.confirm();
  const id = h.owner.snapshot().id;
  let inspected = false;
  h.run(async () => {
    inspected = true;
  });
  await h.owner.submit('Show the current source');
  expect(inspected).toBe(true);
  const tasks = await h.api().tasks.list();
  if (!tasks.ok) throw new Error('list');
  const existing = expectDefined(tasks.value.items.find((task) => task.title === 'Existing'));
  expect(
    await h.owner.focus({ kind: 'task', target: existing.target, revision: existing.revision }),
  ).toBe(true);
  expect(await h.owner.newSession('discard')).toBe(false);
  expect(await h.owner.acknowledgeUncertainty()).toBe(true);
  expect(h.owner.snapshot().id).not.toBe(id);
  await h.owner.clearCompleted();
  expect(
    h.owner.recent().find((entry) => entry.snapshot.id === id)?.snapshot.journal[0]?.effects,
  ).toBe('unknown');
  expect((await h.read('a.md')).match(/Created once/g)).toHaveLength(1);
});

it('reload treats a persisted admission as unresolved even when the last snapshot predates blocked state', async () => {
  const h = await setup();
  await stageCreate(h);
  const admitted = deferred<void>(),
    finish = deferred<void>();
  h.aroundCreate(async (write) => {
    const result = await write();
    admitted.resolve();
    await finish.promise;
    return result;
  });
  const writing = h.owner.confirm();
  await admitted.promise;
  h.owner.dispose();
  const replacement = h.createOwner().owner;
  expect(replacement.snapshot().blocked).toBe(true);
  expect(replacement.snapshot().recovery).toBe('uncertain');
  expect(await replacement.review()).toBe(false);
  const before = h.raw();
  finish.resolve();
  await writing;
  expect(h.raw()).toEqual(before);
  expect(await replacement.confirm()).toBe(false);
  expect((await h.read('a.md')).match(/Created once/g)).toHaveLength(1);
});
it('changed source or ambiguous identity prevents same-runtime plan resumption', async () => {
  const h = await setup();
  const initial = await h.api().tasks.list();
  if (!initial.ok) throw new Error('list');
  const task = expectDefined(initial.value.items[0]);
  const prepared = await expectDefined(h.api().tasks.prepare)({
    kind: 'edit',
    target: task.target,
    expectedRevision: task.revision,
    operation: {
      type: 'patch',
      target: task.target,
      patch: { markdownTitle: { type: 'set', value: 'Intended' } },
    },
  });
  if (!prepared.ok) throw new Error(prepared.error.code);
  h.session().stage({ kind: 'task', plan: prepared.value });
  const id = h.owner.snapshot().id;
  await h.owner.newSession('keep');
  await h.external(
    'a.md',
    '- [ ] Existing changed externally\n- [ ] Existing changed externally\n',
  );
  await h.owner.select(id);
  expect(h.owner.snapshot().recovery).toBe('historical');
  expect(await h.owner.confirm()).toBe(false);
  expect(await h.read('a.md')).not.toContain('Intended');
});

it('binds a submission after an external selection to the selected session', async () => {
  const h = await setup();
  const first = h.owner.snapshot().id;
  await h.owner.newSession('keep');
  const received: string[] = [];
  h.run(async ({ session }) => {
    received.push(session.id);
  });
  await Promise.all([h.owner.select(first), h.owner.submit('For the selected conversation')]);
  expect(received).toEqual([first]);
  expect(h.owner.snapshot().exchanges.slice(-1)[0]?.text).toBe('For the selected conversation');
});

it('never reports Saved when a real receipt retains per-resource uncertainty', async () => {
  const h = await setup();
  await stageCreate(h);
  h.aroundCreate(async (write) => {
    const result = await write();
    return result.ok
      ? { ...result, receipt: { ...result.receipt, destinationEffects: 'unknown' } }
      : result;
  });
  expect(await h.owner.confirm()).toBe(false);
  expect(h.owner.snapshot().status.kind).toBe('error');
  expect(h.owner.snapshot().blocked).toBe(true);
  expect(h.owner.snapshot().actual[0]?.title).toBe('Created once');
  expect(await h.owner.confirm()).toBe(false);
  expect((await h.read('a.md')).match(/Created once/g)).toHaveLength(1);
});

it('cancellation during archive persistence cannot select an unaccepted new session', async () => {
  const h = await setup();
  const id = h.owner.snapshot().id;
  h.run(async ({ signal }) => {
    await h.session().newSession('keep', signal);
  });
  h.afterSave(() => {
    h.session().cancelTurn();
  });
  await h.owner.submit('Start an independent conversation');
  expect(h.owner.snapshot().id).toBe(id);
  expect(h.store.activeId()).toBe(id);
});

it.each(['hide', 'stop'] as const)(
  'retains newer unsent input while %s lets an admitted write settle exactly once',
  async (action) => {
    const h = await setup();
    await stageCreate(h);
    h.owner.setInput('The confirmed command');
    const admitted = deferred<void>(),
      finish = deferred<void>();
    h.aroundCreate(async (write) => {
      const result = await write();
      admitted.resolve();
      await finish.promise;
      return result;
    });
    const writing = h.owner.confirm();
    await admitted.promise;
    const unsent = 'Next instruction, still unsent';
    h.owner.setInput(unsent);
    await h.owner[action]();
    finish.resolve();
    expect(await writing).toBe(true);
    expect(h.owner.open().input).toBe(unsent);
    expect(h.owner.snapshot().actual[0]?.title).toBe('Created once');
    expect((await h.read('a.md')).match(/Created once/g)).toHaveLength(1);
    const restored = h.createOwner().owner;
    expect(restored.snapshot().input).toBe(unsent);
  },
);

it('retains a submitted follow-up while a menu-confirmed write is still settling', async () => {
  const h = await setup();
  await stageCreate(h);
  const admitted = deferred<void>(),
    finish = deferred<void>();
  h.aroundCreate(async (write) => {
    const result = await write();
    admitted.resolve();
    await finish.promise;
    return result;
  });
  const received: string[] = [];
  h.run(async ({ text }) => {
    received.push(text);
  });
  const writing = h.owner.confirm();
  await admitted.promise;
  const next = h.owner.submit('Follow-up intent');
  finish.resolve();
  await Promise.all([writing, next]);
  expect(received).toEqual(['Follow-up intent']);
  expect(h.owner.snapshot().input).toBe('Follow-up intent');
  expect((await h.read('a.md')).match(/Created once/g)).toHaveLength(1);
});

it('history cannot bypass uncertainty acknowledgement and acknowledged evidence remains inspectable after reload', async () => {
  const h = await setup();
  const first = h.owner.snapshot().id;
  await h.owner.newSession('keep');
  await stageCreate(h);
  h.aroundCreate(async (write) => {
    await write();
    return {
      ok: false,
      effects: 'unknown',
      recovery: 'reconcile',
      error: { category: 'io', code: 'LOST', message: 'Lost' },
    };
  });
  await h.owner.confirm();
  const uncertain = h.owner.snapshot().id;
  expect(await h.owner.select(first)).toBe(false);
  expect(h.owner.snapshot().id).toBe(uncertain);
  expect(h.store.activeId()).toBe(uncertain);
  expect(h.owner.snapshot().status.kind).toBe('question');
  expect(await h.owner.acknowledgeUncertainty()).toBe(true);
  const independent = h.owner.snapshot().id;
  expect(await h.owner.select(uncertain)).toBe(true);
  expect(h.owner.snapshot().blocked).toBe(true);
  expect(await h.owner.confirm()).toBe(false);
  h.owner.dispose();
  const reloaded = h.createOwner().owner;
  expect(reloaded.snapshot().id).toBe(uncertain);
  expect(await reloaded.select(independent)).toBe(true);
  await reloaded.clearCompleted();
  expect(
    reloaded.recent().find((record) => record.snapshot.id === uncertain)?.snapshot.blocked,
  ).toBe(true);
  expect((await h.read('a.md')).match(/Created once/g)).toHaveLength(1);
});

it('a verified direct status receipt does not make a separate pending draft uncertain on reload', async () => {
  const h = await setup();
  const listed = await h.api().tasks.list();
  if (!listed.ok) throw new Error('list');
  const task = expectDefined(listed.value.items[0]);
  await stageCreate(h, 'Retained draft');
  expect(
    await h.owner.applyStatus({ target: task.target, revision: task.revision, symbol: 'x' }),
  ).toBe(true);
  expect(await h.read('a.md')).toBe('- [x] Existing ✅ 2026-08-01\n');
  const retained = h.owner.snapshot().proposal;
  expect(retained.changes).toHaveLength(1);
  await h.owner.flush();
  h.owner.dispose();
  const reloaded = h.createOwner().owner;
  expect(reloaded.snapshot().proposal).toEqual(retained);
  expect(reloaded.snapshot().blocked).toBe(false);
  expect(reloaded.snapshot().recovery).toBe('historical');
  expect(await reloaded.confirm()).toBe(false);
  expect(await reloaded.review()).toBe(true);
});

it.each([false, true])(
  'a %s stale status queued after selection cannot change its session or source',
  async (valid) => {
    const h = await setup();
    const first = h.owner.snapshot().id;
    await h.owner.newSession('keep');
    const listed = await h.api().tasks.list();
    if (!listed.ok) throw new Error('list');
    const task = expectDefined(listed.value.items[0]);
    const waiting = deferred<void>(),
      started = deferred<void>();
    h.run(async () => {
      started.resolve();
      await waiting.promise;
    });
    const running = h.owner.submit('Wait for a model response');
    await started.promise;
    const selection = h.owner.select(first);
    await Promise.resolve();
    const status = h.owner.applyStatus({
      target: task.target,
      revision: valid ? task.revision : 'stale',
      symbol: 'x',
    });
    waiting.resolve();
    await running;
    expect(await selection).toBe(true);
    expect(await status).toBe(false);
    expect(h.owner.snapshot().id).toBe(first);
    expect(h.store.activeId()).toBe(first);
    expect(await h.read('a.md')).toBe('- [ ] Existing\n');
  },
);

it('a real status queued before selection settles in its original session', async () => {
  const h = await setup();
  const first = h.owner.snapshot().id;
  await h.owner.newSession('keep');
  const original = h.owner.snapshot().id;
  const listed = await h.api().tasks.list();
  if (!listed.ok) throw new Error('list');
  const task = expectDefined(listed.value.items[0]);
  const waiting = deferred<void>(),
    started = deferred<void>();
  h.run(async () => {
    started.resolve();
    await waiting.promise;
  });
  const running = h.owner.submit('Wait for a model response');
  await started.promise;
  const status = h.owner.applyStatus({ target: task.target, revision: task.revision, symbol: 'x' });
  const selection = h.owner.select(first);
  waiting.resolve();
  await running;
  expect(await status).toBe(true);
  expect(await selection).toBe(true);
  expect(h.owner.snapshot().id).toBe(first);
  expect(h.store.activeId()).toBe(first);
  expect(
    h.owner.recent().find((record) => record.snapshot.id === original)?.snapshot.journal[0]
      ?.effects,
  ).toBe('committed');
  expect(await h.read('a.md')).toBe('- [x] Existing ✅ 2026-08-01\n');
});

it('a refused restore reports failure and restores the live selection after a competing direct write', async () => {
  const h = await setup();
  const first = h.owner.snapshot().id;
  await h.owner.newSession('keep');
  const active = h.owner.snapshot().id;
  const listed = await h.api().tasks.list();
  if (!listed.ok) throw new Error('list');
  const task = expectDefined(listed.value.items[0]);
  let writing: Promise<boolean> | undefined;
  h.afterSave(() => {
    h.afterSave(() => {
      writing = h
        .session()
        .applyStatus({ target: task.target, revision: task.revision, symbol: 'x' });
    });
  });
  expect(await h.owner.select(first)).toBe(false);
  expect(await expectDefined(writing)).toBe(true);
  expect(h.owner.snapshot().id).toBe(active);
  expect(h.store.activeId()).toBe(active);
  expect(await h.read('a.md')).toBe('- [x] Existing ✅ 2026-08-01\n');
});

it('hide cancels queued status and selection before their admission without changing the active record', async () => {
  const h = await setup();
  const first = h.owner.snapshot().id;
  await h.owner.newSession('keep');
  const active = h.owner.snapshot().id;
  const listed = await h.api().tasks.list();
  if (!listed.ok) throw new Error('list');
  const task = expectDefined(listed.value.items[0]);
  const waiting = deferred<void>(),
    started = deferred<void>();
  h.run(async () => {
    started.resolve();
    await waiting.promise;
  });
  const running = h.owner.submit('Waiting');
  await started.promise;
  const selecting = h.owner.select(first);
  await Promise.resolve();
  const status = h.owner.applyStatus({ target: task.target, revision: task.revision, symbol: 'x' });
  const queuedSelection = h.owner.select(first);
  await h.owner.hide();
  waiting.resolve();
  await running;
  expect(await selecting).toBe(false);
  expect(await queuedSelection).toBe(false);
  expect(await status).toBe(false);
  expect(h.owner.snapshot().id).toBe(active);
  expect(h.store.activeId()).toBe(active);
  expect(await h.read('a.md')).toBe('- [ ] Existing\n');
});
