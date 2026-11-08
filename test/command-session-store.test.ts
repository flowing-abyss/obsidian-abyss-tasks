import { expect, it } from 'vitest';
import { CommandSessionStore } from '../src/ai/CommandSessionStore';
import type { CommandSessionSnapshot } from '../src/ai/commandTypes';

function session(id = 'one', patch: Partial<CommandSessionSnapshot> = {}): CommandSessionSnapshot {
  return {
    id,
    input: '',
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
    ...patch,
  };
}
function setup(initial: unknown = null) {
  let raw: unknown = initial;
  let writes = 0;
  let quota = false;
  let mismatch = false;
  const storage = {
    load: (): unknown => raw,
    save: (value: unknown): void => {
      writes++;
      if (quota) throw new Error('secret provider failure');
      raw = mismatch ? { version: 1, activeSessionId: null, sessions: [] } : structuredClone(value);
    },
  };
  let now = 10;
  return {
    store: new CommandSessionStore({ storage, now: () => now++ }),
    storage,
    raw: () => raw,
    writes: () => writes,
    quota: (value: boolean) => {
      quota = value;
    },
    mismatch: (value: boolean) => {
      mismatch = value;
    },
  };
}
it('loads missing storage without writing and roundtrips complete detached historical records', async () => {
  const h = setup();
  expect(h.store.records()).toEqual([]);
  expect(h.writes()).toBe(0);
  const input = session('one', {
    input: 'Я remember 🪼',
    exchanges: Array.from({ length: 50 }, (_, n) => ({
      role: 'user',
      text: `Constraint ${n} ${'a'.repeat(5000)}`,
    })),
  });
  await h.store.create(input);
  const reopened = new CommandSessionStore({ storage: h.storage, now: () => 100 });
  expect(reopened.activeId()).toBe('one');
  expect(reopened.records()).toEqual([{ handles: 'historical', updatedAt: 10, snapshot: input }]);
  const records = reopened.records();
  const first = records[0];
  if (first === undefined) throw new Error('Missing retained record.');
  Object.assign(first.snapshot, { input: 'mutated externally' });
  expect(reopened.records()[0]?.snapshot.input).toBe('Я remember 🪼');
});
it.each([
  {},
  { version: 2, sessions: [] },
  { version: 1, activeSessionId: null },
  { version: 1, activeSessionId: 'missing', sessions: [] },
  {
    version: 1,
    activeSessionId: null,
    sessions: [{ handles: 'historical', updatedAt: 1, snapshot: { id: 'malformed' } }],
  },
])('preserves malformed or future raw storage and pauses all writes (%j)', async (raw) => {
  const h = setup(raw);
  expect(h.store.failure()?.code).toBe('UNREADABLE_HISTORY');
  await expect(h.store.create(session())).rejects.toMatchObject({ code: 'UNREADABLE_HISTORY' });
  expect(h.raw()).toBe(raw);
  expect(h.writes()).toBe(0);
  expect(h.store.records()[0]?.snapshot.id).toBe('one');
});
it('reports load exceptions without exposing raw diagnostics', async () => {
  const store = new CommandSessionStore({
    storage: {
      load: () => {
        throw new Error('secret');
      },
      save: () => {
        throw new Error('unexpected');
      },
    },
    now: () => 1,
  });
  expect(store.failure()).toMatchObject({ code: 'UNREADABLE_HISTORY' });
  expect(JSON.stringify(store.failure())).not.toContain('secret');
  await expect(store.save(session())).rejects.toMatchObject({ code: 'UNREADABLE_HISTORY' });
});
it('separates explicit selection from late archived journal saves', async () => {
  const h = setup();
  await h.store.create(session('old'));
  await h.store.create(session('current'));
  await h.store.save(session('old', { input: 'late outcome' }));
  expect(h.store.activeId()).toBe('current');
  await h.store.select('old');
  expect(h.store.activeId()).toBe('old');
  await expect(h.store.select('missing')).rejects.toMatchObject({ code: 'MISSING_SESSION' });
  expect(h.store.activeId()).toBe('old');
});
it('prunes oldest eligible completed records to twenty while retaining the active record', async () => {
  const h = setup();
  await h.store.create(session('active'));
  for (let n = 0; n < 23; n++) await h.store.save(session(`done-${n}`));
  expect(h.store.records()).toHaveLength(20);
  expect(h.store.records().map((record) => record.snapshot.id)).toEqual([
    'active',
    ...Array.from({ length: 19 }, (_, n) => `done-${n + 4}`),
  ]);
  await h.store.clearCompleted();
  expect(h.store.records().map((record) => record.snapshot.id)).toEqual(['active']);
});
it('keeps inactive pending input, questions, proposals, and admitted or uncertain journals under count pressure and explicit clearing', async () => {
  const h = setup();
  const change = {
    kind: 'status',
    target: 'task',
    revision: 'revision',
    symbol: 'x',
    nuance: '',
  } as const;
  await h.store.create(session('active'));
  await h.store.save(session('input', { input: 'draft' }));
  await h.store.save(session('question', { activeQuestion: 'When?' }));
  await h.store.save(
    session('proposal', { proposal: { revision: 1, operations: 1, changes: [change] } }),
  );
  for (const [id, state, effects] of [
    ['admitted', 'admitted', undefined],
    ['unknown', 'settled', 'unknown'],
    ['partial', 'settled', 'partial'],
  ] as const) {
    await h.store.save(
      session(id, {
        journal: [
          {
            id: 'entry',
            proposalRevision: 1,
            change,
            request: { requestId: 'request', expiresAt: 100 },
            state,
            ...(effects === undefined ? {} : { effects }),
          },
        ],
      }),
    );
  }
  for (let n = 0; n < 23; n++) await h.store.save(session(`done-${n}`));
  await h.store.clearCompleted();
  expect(h.store.records().map((record) => record.snapshot.id)).toEqual([
    'active',
    'input',
    'question',
    'proposal',
    'admitted',
    'unknown',
    'partial',
  ]);
});
it('prunes completed history by UTF-8 bytes and retains a full Unicode command on refusal', async () => {
  const h = setup();
  await h.store.create(session('active', { input: 'retained' }));
  await h.store.save(session('old', { exchanges: [{ role: 'user', text: 'a'.repeat(1200000) }] }));
  await h.store.save(session('new', { exchanges: [{ role: 'user', text: 'a'.repeat(1200000) }] }));
  expect(h.store.records().map((record) => record.snapshot.id)).toEqual(['active', 'new']);
  const raw = h.raw();
  const unicode = '界'.repeat(750000);
  await expect(h.store.save(session('protected', { input: unicode }))).rejects.toMatchObject({
    code: 'HISTORY_LIMIT',
  });
  expect(h.raw()).toBe(raw);
  expect(h.store.records().find((r) => r.snapshot.id === 'protected')?.snapshot.input).toBe(
    unicode,
  );
  await expect(h.store.clearCompleted()).rejects.toMatchObject({ code: 'HISTORY_LIMIT' });
  expect(h.store.records().find((r) => r.snapshot.id === 'protected')).toBeDefined();
});
it('retains valid memory after quota failure and rejects awaited saves until verified readback succeeds', async () => {
  const h = setup();
  await h.store.create(session());
  const raw = h.raw();
  h.quota(true);
  await expect(h.store.save(session('one', { input: 'unsaved' }))).rejects.toMatchObject({
    code: 'WRITE_FAILED',
  });
  expect(h.raw()).toBe(raw);
  expect(h.store.records()[0]?.snapshot.input).toBe('unsaved');
  expect(JSON.stringify(h.store.failure())).not.toContain('secret');
  h.quota(false);
  h.mismatch(true);
  await expect(h.store.save(session('one', { input: 'still unsaved' }))).rejects.toMatchObject({
    code: 'READBACK_MISMATCH',
  });
  expect(h.store.records()[0]?.snapshot.input).toBe('still unsaved');
  h.mismatch(false);
  await h.store.save(session('one', { input: 'saved finally' }));
  expect(h.store.failure()).toBeNull();
});
it('refuses invalid or structurally oversized input without replacing validated memory or disk', async () => {
  const h = setup();
  await h.store.create(session());
  const raw = h.raw();
  const cycle: Record<string, unknown> = {};
  cycle['self'] = cycle;
  await expect(h.store.save({ ...session(), extra: cycle })).rejects.toMatchObject({
    code: 'INVALID_SNAPSHOT',
  });
  await expect(
    h.store.save(session('one', { input: 'a'.repeat(17 * 1024 * 1024) })),
  ).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT' });
  expect(h.store.records()[0]?.snapshot.input).toBe('');
  expect(h.raw()).toBe(raw);
});

it('protects uncertain receipt evidence even if the enclosing entry claims committed effects', async () => {
  const h = setup();
  await h.store.create(session('active'));
  const change = {
    kind: 'status',
    target: 'task',
    revision: 'revision',
    symbol: 'x',
    nuance: '',
  } as const;
  await h.store.save(
    session('uncertain', {
      journal: [
        {
          id: 'entry',
          proposalRevision: 1,
          change,
          request: { requestId: 'request', expiresAt: 100 },
          state: 'settled',
          effects: 'committed',
          receipt: {
            providerEpoch: 'epoch',
            requestId: 'request',
            acceptedAt: 10,
            expiresAt: 100,
            outcome: 'failed',
            effects: 'unknown',
            recovery: 'reconcile',
            original: { target: 'task', state: 'unproven' },
            snapshots: 'unavailable',
            warnings: [],
          },
        },
      ],
    }),
  );
  await h.store.clearCompleted();
  expect(h.store.records().map((record) => record.snapshot.id)).toEqual(['active', 'uncertain']);
});

it('releases all failed-save protection after a later verified envelope includes those records', async () => {
  const h = setup();
  await h.store.create(session('active'));
  h.quota(true);
  await expect(h.store.save(session('earlier'))).rejects.toMatchObject({ code: 'WRITE_FAILED' });
  h.quota(false);
  await h.store.save(session('later'));
  await h.store.clearCompleted();
  expect(h.store.records().map((record) => record.snapshot.id)).toEqual(['active']);
});

it('keeps the active selection on failed create/select while retaining newly authored memory', async () => {
  const h = setup();
  await h.store.create(session('active'));
  await h.store.save(session('archived', { input: 'existing draft' }));
  h.quota(true);
  await expect(h.store.select('archived')).rejects.toMatchObject({ code: 'WRITE_FAILED' });
  expect(h.store.activeId()).toBe('active');
  await expect(h.store.create(session('new', { input: 'new draft' }))).rejects.toMatchObject({
    code: 'WRITE_FAILED',
  });
  expect(h.store.activeId()).toBe('active');
  expect(h.store.records().find((r) => r.snapshot.id === 'new')?.snapshot.input).toBe('new draft');
});

type UnknownResource =
  | 'noteEffects'
  | 'noteDestinationEffects'
  | 'contentDestinationEffects'
  | 'destinationCopy'
  | 'sourceRemoval';
const unknownResources: readonly UnknownResource[] = [
  'noteEffects',
  'noteDestinationEffects',
  'contentDestinationEffects',
  'destinationCopy',
  'sourceRemoval',
];
function unknownResourceSession(resource: UnknownResource): CommandSessionSnapshot {
  const base = {
    providerEpoch: 'epoch',
    requestId: 'request',
    acceptedAt: 10,
    expiresAt: 100,
    outcome: 'changed',
    effects: 'committed',
    recovery: 'none',
  } as const;
  const plan = {
    providerEpoch: 'epoch',
    generation: 1,
    scopeRevision: 1,
    semanticsRevision: 1,
    target: 'plan',
    revision: 'revision',
    kind: 'edit',
    expiresAt: 100,
  } as const;
  let change: CommandSessionSnapshot['proposal']['changes'][number];
  let receipt: unknown;
  if (resource === 'noteEffects' || resource === 'noteDestinationEffects') {
    change = {
      kind: 'note',
      plan: { ...plan, path: 'Note.md', before: null, after: { text: 'Intent', complete: true } },
    };
    receipt = {
      ...base,
      plan: 'plan',
      planRevision: 'revision',
      warnings: [],
      noteEffects: resource === 'noteEffects' ? 'unknown' : 'committed',
      destinationEffects: resource === 'noteDestinationEffects' ? 'unknown' : 'committed',
    };
  } else if (resource === 'contentDestinationEffects') {
    change = { kind: 'task', plan: { ...plan, before: null, after: null } };
    receipt = {
      ...base,
      plan: 'plan',
      planRevision: 'revision',
      destinationEffects: 'unknown',
      snapshots: 'unavailable',
      warnings: [],
      contentContinuity: {
        plan: 'plan',
        planRevision: 'revision',
        correspondence: { state: 'unavailable' },
      },
    };
  } else {
    change = {
      kind: 'project',
      before: {
        target: 'project',
        revision: 'revision',
        path: 'Project.md',
        name: 'Project',
        status: { state: 'configured', id: 'active' },
        stats: {
          total: 0,
          done: 0,
          cancelled: 0,
          inProgress: 0,
          tracked: { closedMs: 0, openStartsMs: [] },
        },
        tags: [],
        fields: [],
      },
    };
    receipt = {
      ...base,
      project: { target: 'project', revision: 'revision' },
      destinationCopy: resource === 'destinationCopy' ? 'unknown' : 'committed',
      sourceRemoval: resource === 'sourceRemoval' ? 'unknown' : 'committed',
    };
  }
  return session('uncertain', {
    journal: [
      {
        id: 'entry',
        proposalRevision: 1,
        change,
        request: { requestId: 'request', expiresAt: 100 },
        state: 'settled',
        effects: 'committed',
        receipt,
      },
    ],
  });
}
function loadedUnknownResource(resource: UnknownResource) {
  const snapshot = unknownResourceSession(resource);
  const h = setup({
    version: 1,
    activeSessionId: 'active',
    sessions: [
      { handles: 'historical', updatedAt: 1, snapshot },
      { handles: 'historical', updatedAt: 2, snapshot: session('active') },
    ],
  });
  return { ...h, snapshot };
}
it.each(unknownResources)(
  'retains loaded %s uncertainty through explicit clearing',
  async (resource) => {
    const h = loadedUnknownResource(resource);
    expect(h.store.failure()).toBeNull();
    await h.store.clearCompleted();
    expect(h.store.records().map((record) => record.snapshot.id)).toEqual(['uncertain', 'active']);
    const reloaded = new CommandSessionStore({ storage: h.storage, now: () => 100 });
    expect(
      reloaded.records().find((record) => record.snapshot.id === 'uncertain')?.snapshot,
    ).toEqual(h.snapshot);
  },
);
it.each(unknownResources)(
  'retains loaded %s uncertainty through automatic history pressure',
  async (resource) => {
    const h = loadedUnknownResource(resource);
    expect(h.store.failure()).toBeNull();
    for (let n = 0; n < 20; n++) await h.store.save(session(`done-${n}`));
    expect(h.store.records().map((record) => record.snapshot.id)).toEqual([
      'uncertain',
      'active',
      ...Array.from({ length: 19 }, (_, n) => `done-${n + 1}`),
    ]);
    const reloaded = new CommandSessionStore({ storage: h.storage, now: () => 100 });
    expect(
      reloaded.records().find((record) => record.snapshot.id === 'uncertain')?.snapshot,
    ).toEqual(h.snapshot);
  },
);
it('retains only the session voice mode across reload, without recording state or audio', async () => {
  const h = setup();
  const value = {
    ...session('voice', { voiceMode: 'continuous', input: 'Retained text' }),
    recording: true,
    audio: ['private audio'],
    pendingTranscription: true,
  };
  await h.store.create(value);
  const reopened = new CommandSessionStore({ storage: h.storage, now: () => 100 });
  expect(reopened.records()[0]?.snapshot.voiceMode).toBe('continuous');
  expect(reopened.records()[0]?.snapshot.input).toBe('Retained text');
  expect(JSON.stringify(h.raw())).not.toContain('private audio');
  expect(JSON.stringify(h.raw())).not.toContain('recording');
  await reopened.create(session('manual'));
  expect(
    reopened.records().find((record) => record.snapshot.id === 'manual')?.snapshot.voiceMode,
  ).toBeUndefined();
});
