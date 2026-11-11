import { expect, it } from 'vitest';
import { CommandSessionStore } from '../src/ai/CommandSessionStore';
import type { CommandSessionSnapshot } from '../src/ai/commandTypes';
import { deferred, expectDefined } from './helpers';
import { commandSessionStorage } from './support/commandSessionStorage';

function snapshot(id: string, input = 'Meaningful command'): CommandSessionSnapshot {
  return {
    id,
    input,
    focus: [],
    context: '',
    trees: [],
    entities: { tasks: [], projects: [], notes: [] },
    exchanges: [],
    activeQuestion: null,
    status: { kind: 'ready', message: '' },
    proposal: { revision: 0, operations: 0, changes: [] },
    journal: [],
    actual: [],
    blocked: false,
  };
}
async function setup(initial: unknown = null) {
  const h = commandSessionStorage(initial);
  let time = 10;
  const open = () =>
    CommandSessionStore.open({ storage: h.storage, fileId: h.fileId, now: () => time++ });
  return { ...h, open, store: await open() };
}
it('retains more than twenty independent session files and more than two MiB without pruning', async () => {
  const h = await setup();
  for (let i = 0; i < 24; i++) await h.store.create(snapshot(String(i), 'a'.repeat(100000)));
  expect((await h.open()).records()).toHaveLength(24);
});
it('captures queued snapshots before I/O and tombstones a deleted session against late saves and reload', async () => {
  const h = await setup();
  await h.store.create(snapshot('one'));
  const hold = deferred<void>(),
    started = deferred<void>();
  const write = h.storage.write;
  const captured: string[] = [];
  h.storage.write = async (...args) => {
    if (args[0].kind === 'session') captured.push(args[1]);
    started.resolve();
    await hold.promise;
    await write(...args);
  };
  const value = snapshot('one', 'Captured');
  const save = h.store.save(value);
  await started.promise;
  Object.assign(value, { input: 'Mutated later' });
  const remove = h.store.remove('one');
  hold.resolve();
  await save;
  await remove;
  expect(JSON.parse(expectDefined(captured[0]))).toMatchObject({ snapshot: { input: 'Captured' } });
  await expect(h.store.save(snapshot('one'))).rejects.toMatchObject({ code: 'DELETED_SESSION' });
  expect((await h.open()).records()).toEqual([]);
});
it('does not reorder or advance activity for selection or unchanged snapshots', async () => {
  const h = await setup();
  await h.store.create(snapshot('one'));
  await h.store.create(snapshot('two'));
  const initial = h.store.records();
  await h.store.select('one');
  await h.store.save(snapshot('one'));
  expect(h.store.records()).toEqual(initial);
  await h.store.save(snapshot('one', 'Changed'));
  expect(h.store.records().map((r) => r.snapshot.id)).toEqual(['one', 'two']);
  expect(h.store.records()[0]?.createdAt).toBe(initial[1]?.createdAt);
});
it('does not accumulate empty sessions', async () => {
  const h = await setup();
  for (let i = 0; i < 30; i++) await h.store.create(snapshot(String(i), ''));
  expect(h.store.records()).toEqual([]);
  expect(h.files.size).toBeLessThanOrEqual(1);
});
it('blocks clear-all without partial deletion when any unknown write remains', async () => {
  const h = await setup();
  await h.store.create(snapshot('safe'));
  await h.store.create({ ...snapshot('blocked'), blocked: true });
  await expect(h.store.clearHistory()).rejects.toMatchObject({ code: 'UNRESOLVED_WRITES' });
  expect(h.store.records()).toHaveLength(2);
});
it('rejects a changed control file without overwriting external bytes', async () => {
  const h = await setup();
  await h.store.create(snapshot('one'));
  await h.store.create(snapshot('two'));
  const external = JSON.stringify({ version: 99 });
  h.files.set('state', external);
  await expect(h.store.select('one')).rejects.toMatchObject({ code: 'WRITE_FAILED' });
  expect(h.files.get('state')).toBe(external);
  expect(h.store.activeId()).toBe('two');
});
it('requires exact readback and retains validated memory on failure', async () => {
  const h = await setup();
  const write = h.storage.write;
  h.storage.write = async (key, text, previous) => {
    await write(key, text, previous);
    if (key.kind === 'session') h.files.set(key.fileId, `${text} `);
  };
  await expect(h.store.create(snapshot('one'))).rejects.toMatchObject({
    code: 'READBACK_MISMATCH',
  });
  expect(h.store.records()[0]?.snapshot.input).toBe('Meaningful command');
});
it.each([
  '{',
  '{"version":99}',
  '{"version":1,"activeSessionId":null,"legacyImported":true,"deletedFiles":[],"extra":true}',
])('preserves malformed, future or unrecognized state: %s', async (raw) => {
  const h = commandSessionStorage();
  h.files.set('state', raw);
  const store = await CommandSessionStore.open({ ...h, now: () => 1 });
  expect(store.failure()?.code).toBe('UNREADABLE_HISTORY');
  await expect(store.save(snapshot('one'))).rejects.toMatchObject({ code: 'UNREADABLE_HISTORY' });
  expect(h.files.get('state')).toBe(raw);
});
it('imports once, preserves original timestamps, and never resurrects deletion from uncleared legacy data', async () => {
  const legacy = {
    version: 1,
    activeSessionId: 'old',
    sessions: [{ handles: 'historical', updatedAt: 7, snapshot: snapshot('old') }],
  };
  const h = commandSessionStorage(legacy);
  h.storage.clearLegacy = () => {
    throw new Error('cleanup failed');
  };
  const open = () => CommandSessionStore.open({ ...h, now: () => 20 });
  const first = await open();
  expect(first.records()[0]).toMatchObject({ createdAt: 7, updatedAt: 7 });
  await first.remove('old');
  expect((await open()).records()).toEqual([]);
});
it('retries a partial import without overwriting newer JSON or duplicating logical sessions', async () => {
  const legacy = {
    version: 1,
    activeSessionId: 'old',
    sessions: ['old', 'other'].map((id) => ({
      handles: 'historical',
      updatedAt: 7,
      snapshot: snapshot(id),
    })),
  };
  const h = commandSessionStorage(legacy),
    write = h.storage.write;
  let writes = 0;
  h.storage.write = async (...args) => {
    if (++writes === 2) throw new Error('partial');
    await write(...args);
  };
  const open = () => CommandSessionStore.open({ ...h, now: () => 20 });
  expect((await open()).failure()).not.toBeNull();
  const [fileId, text] = expectDefined([...h.files.entries()][0]);
  h.files.set(
    fileId,
    JSON.stringify({
      ...(JSON.parse(text) as object),
      updatedAt: 12,
      title: 'Newer',
      snapshot: snapshot('old', 'Newer'),
    }),
  );
  h.storage.write = write;
  const restored = await open();
  expect(restored.failure()).toBeNull();
  expect(restored.records()).toHaveLength(2);
  expect(restored.records()[0]?.snapshot.input).toBe('Newer');
  expect(h.legacy()).toBeNull();
});
it('rejects duplicate logical IDs in distinct JSON files without changing either', async () => {
  const h = await setup();
  await h.store.create(snapshot('one'));
  const text = expectDefined([...h.files.entries()].find(([id]) => id !== 'state'))[1];
  h.files.set(h.fileId(), text);
  const before = [...h.files];
  expect((await h.open()).failure()?.code).toBe('UNREADABLE_HISTORY');
  expect([...h.files]).toEqual(before);
});

it('keeps deletion markers after physical removal fails and cleans delayed files on reopening', async () => {
  const h = await setup();
  await h.store.create(snapshot('one'));
  const file = expectDefined([...h.files].find(([id]) => id !== 'state'));
  const remove = h.storage.remove;
  h.storage.remove = async () => {
    throw new Error('denied');
  };
  await expect(h.store.remove('one')).rejects.toMatchObject({ code: 'DELETE_FAILED' });
  expect(h.store.records()).toEqual([]);
  h.storage.remove = remove;
  h.files.set(file[0], file[1]);
  expect((await h.open()).records()).toEqual([]);
  expect(h.files.has(file[0])).toBe(false);
  expect(JSON.parse(expectDefined(h.files.get('state')))).toMatchObject({
    deletedFiles: [file[0]],
  });
});
it('blocks mutation during an incomplete import and preserves duplicate legacy IDs', async () => {
  const record = { handles: 'historical', updatedAt: 7, snapshot: snapshot('old') };
  const raw = { version: 1, activeSessionId: 'old', sessions: [record, record] };
  const h = await setup(raw);
  expect(h.store.failure()?.code).toBe('UNREADABLE_HISTORY');
  await expect(h.store.clearHistory()).rejects.toMatchObject({ code: 'UNREADABLE_HISTORY' });
  expect(h.files.size).toBe(0);
  expect(h.legacy()).toEqual(raw);
});
it('ignores restoration and status bookkeeping when ordering meaningful activity', async () => {
  const h = await setup();
  await h.store.create(snapshot('one'));
  await h.store.create(snapshot('two'));
  const before = h.store
    .records()
    .map((record) => ({ id: record.snapshot.id, updatedAt: record.updatedAt }));
  await h.store.save({
    ...snapshot('one'),
    recovery: 'historical',
    status: { kind: 'ready', message: 'Restored' },
  });
  expect(
    h.store.records().map((record) => ({ id: record.snapshot.id, updatedAt: record.updatedAt })),
  ).toEqual(before);
});
it('uses the focused project name and preserves it when the current proposal clears', async () => {
  const h = await setup();
  const project = {
    target: 'project',
    revision: 'r',
    name: 'Focused project',
    path: 'Project.md',
    status: { state: 'configured' as const, id: 'active' },
    stats: {
      total: 0,
      done: 0,
      cancelled: 0,
      inProgress: 0,
      tracked: { closedMs: 0, openStartsMs: [] },
    },
    tags: [],
    fields: [],
  };
  const state = {
    ...snapshot('one'),
    focus: [{ kind: 'project' as const, target: 'project' }],
    entities: { tasks: [], projects: [project], notes: [] },
  };
  await h.store.create(state);
  expect(h.store.records()[0]?.title).toBe('Focused project');
  await h.store.save(snapshot('one', 'New command without an entity'));
  expect(h.store.records()[0]?.title).toBe('Focused project');
});

it('does not reorder crash-restored uncertainty solely because restoration derives blocked state', async () => {
  const h = await setup();
  const state = snapshot('one');
  await h.store.create(state);
  await h.store.create(snapshot('two'));
  const before = h.store.records().map((record) => [record.snapshot.id, record.updatedAt]);
  await h.store.save({ ...state, blocked: true, recovery: 'uncertain' });
  expect(h.store.records().map((record) => [record.snapshot.id, record.updatedAt])).toEqual(before);
});

it('refuses a contradictory unfinished-import marker with deleted files instead of reimporting them', async () => {
  const legacy = {
    version: 1,
    activeSessionId: 'old',
    sessions: [{ handles: 'historical', updatedAt: 1, snapshot: snapshot('old') }],
  };
  const h = commandSessionStorage(legacy);
  const control = JSON.stringify({
    version: 1,
    activeSessionId: null,
    legacyImported: false,
    deletedFiles: [h.fileId()],
  });
  h.files.set('state', control);
  const store = await CommandSessionStore.open({ ...h, now: () => 10 });
  expect(store.failure()?.code).toBe('UNREADABLE_HISTORY');
  expect(h.files.size).toBe(1);
  expect(h.files.get('state')).toBe(control);
  expect(h.legacy()).toEqual(legacy);
});

it('replaces coalesced partial-input titles with the full first submitted command', async () => {
  const h = await setup();
  await h.store.create(snapshot('one', 'C'));
  await h.store.save(snapshot('one', 'Compare these options'));
  expect(h.store.records()[0]?.title).toBe('Compare these options');
  await h.store.save({
    ...snapshot('one', ''),
    exchanges: [{ role: 'user', text: 'Compare these options' }],
  });
  expect(h.store.records()[0]?.title).toBe('Compare these options');
  await h.store.save({
    ...snapshot('one', 'A later draft'),
    exchanges: [{ role: 'user', text: 'Compare these options' }],
  });
  expect((await h.open()).records()[0]?.title).toBe('Compare these options');
});
it('maps metadata-expanded structural validation failures and retains the complete validated snapshot', async () => {
  const h = await setup();
  const command = 'a'.repeat(9 * 1024 * 1024);
  const value = { ...snapshot('large', ''), exchanges: [{ role: 'user' as const, text: command }] };
  await expect(h.store.create(value)).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT' });
  expect(h.store.failure()?.code).toBe('INVALID_SNAPSHOT');
  expect(h.store.records()[0]?.snapshot.exchanges[0]?.text).toBe(command);
  expect(h.files.size).toBe(0);
});

it('preserves entity-title provenance across reload when its text also matched a draft fallback', async () => {
  const h = await setup();
  const project = {
    target: 'project',
    revision: 'r',
    name: 'Same title',
    path: 'Project.md',
    status: { state: 'configured' as const, id: 'active' },
    stats: {
      total: 0,
      done: 0,
      cancelled: 0,
      inProgress: 0,
      tracked: { closedMs: 0, openStartsMs: [] },
    },
    tags: [],
    fields: [],
  };
  await h.store.create({
    ...snapshot('one', 'Same title'),
    focus: [{ kind: 'project', target: 'project' }],
    entities: { tasks: [], projects: [project], notes: [] },
  });
  await h.store.save(snapshot('one', 'Same title'));
  const reopened = await h.open();
  await reopened.save(snapshot('one', 'Another draft'));
  expect(reopened.records()[0]?.title).toBe('Same title');
});

it('corrects old-file partial-input labels without inferring entity provenance from differing text', async () => {
  const h = commandSessionStorage();
  h.files.set(
    h.fileId(),
    JSON.stringify({
      version: 1,
      handles: 'historical',
      createdAt: 1,
      updatedAt: 1,
      title: 'C',
      snapshot: snapshot('old', 'Compare these options'),
    }),
  );
  const store = await CommandSessionStore.open({ ...h, now: () => 2 });
  await store.save({
    ...snapshot('old', ''),
    exchanges: [{ role: 'user', text: 'Compare these options' }],
  });
  expect(store.records()[0]?.title).toBe('Compare these options');
  expect(store.records()[0]?.titleIsEntity).toBeUndefined();
});
it('derives old-file entity provenance from the retained project and preserves it on subsequent reopen', async () => {
  const h = commandSessionStorage();
  const project = {
    target: 'project',
    revision: 'r',
    name: 'Old project',
    path: 'Project.md',
    status: { state: 'configured' as const, id: 'active' },
    stats: {
      total: 0,
      done: 0,
      cancelled: 0,
      inProgress: 0,
      tracked: { closedMs: 0, openStartsMs: [] },
    },
    tags: [],
    fields: [],
  };
  const previous = {
    ...snapshot('old', 'Unrelated command'),
    focus: [{ kind: 'project', target: 'project' }],
    entities: { tasks: [], projects: [project], notes: [] },
  };
  h.files.set(
    h.fileId(),
    JSON.stringify({
      version: 1,
      handles: 'historical',
      createdAt: 1,
      updatedAt: 1,
      title: 'Old project',
      snapshot: previous,
    }),
  );
  const open = () => CommandSessionStore.open({ ...h, now: () => 2 });
  const store = await open();
  await store.save(snapshot('old', 'Another draft'));
  expect((await open()).records()[0]).toMatchObject({ title: 'Old project', titleIsEntity: true });
});
