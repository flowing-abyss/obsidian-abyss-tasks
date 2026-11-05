import { afterEach, expect, it, vi } from 'vitest';
import type {
  ApiResultV1,
  ListTasksV1,
  MutationResultV1,
  ObservationV1,
  TaskDtoV1,
  TasksApiProviderV1,
  TasksApiV1,
} from '../api';
import { StatusCatalog } from '../src/tasks/domain/StatusCatalog';
import { publicApiHarness, type PublicApiHarness } from './support/publicApiHarness';

const harnesses: PublicApiHarness[] = [];
const now = Date.UTC(2026, 7, 1, 12);
afterEach(() => {
  vi.restoreAllMocks();
  for (const h of harnesses.splice(0)) h.dispose();
});

function ok<T>(result: ApiResultV1<T>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing fixture value');
  return value;
}

function request(task: TaskDtoV1, requestId: string) {
  return {
    target: task.target,
    expectedRevision: task.revision,
    requestId,
    expiresAt: now + 300_000,
  };
}

// One attempt only: callers retain their published rows on any failure and restart.
async function scan(
  client: TasksApiV1,
  query: ListTasksV1,
  latestRevision: () => number,
  afterPage: (last: boolean) => Promise<void> = async () => {},
): Promise<ApiResultV1<readonly TaskDtoV1[]>> {
  const startedAt = latestRevision();
  const staged: TaskDtoV1[] = [];
  let observation: ObservationV1 | undefined;
  let cursor: string | undefined;
  const invalidated = {
    ok: false,
    error: { category: 'conflict', code: 'SCAN_INVALIDATED', message: 'Restart the scan.' },
  } as const;
  do {
    const result = await client.tasks.list({
      ...query,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    if (!result.ok) return result;
    const page = result.value;
    observation ??= page;
    const basis = observation;
    if (
      (
        ['providerEpoch', 'revision', 'generation', 'scopeRevision', 'semanticsRevision'] as const
      ).some((field) => page[field] !== basis[field])
    ) {
      return invalidated;
    }
    staged.push(...page.items);
    cursor = page.nextCursor;
    await afterPage(cursor === undefined);
  } while (cursor !== undefined);
  if (latestRevision() !== startedAt || observation.revision !== startedAt) return invalidated;
  return { ok: true, value: staged };
}

it('publishes only coherent scans after startup and stops callbacks at cleanup', async () => {
  const h = await publicApiHarness({ 'a.md': '- [ ] A\n- [ ] B\n' }, { initialize: false });
  harnesses.push(h);
  const provider: TasksApiProviderV1 = h.provider;
  const client = ok(provider.getApi(1, { consumerId: 'calendar' }));
  expect(client.info.apiVersion).toBe(1);
  let latest = -1;
  const callback = vi.fn((event: ObservationV1) => {
    latest = event.revision;
  });
  const unsubscribe = ok(client.subscribe(callback));
  expect(callback).toHaveBeenCalledTimes(1);
  const ready = client.ready();
  await h.index.initialize();
  expect(ok(await ready).lifecycle).toBe('ready');

  let published: readonly TaskDtoV1[] = [];
  let changed = false;
  const interrupted = await scan(
    client,
    { limit: 1 },
    () => latest,
    async (last) => {
      if (!last && !changed) {
        changed = true;
        await h.external('a.md', '- [ ] A edited\n- [ ] B\n');
      }
    },
  );
  if (interrupted.ok) published = interrupted.value;
  expect(interrupted).toMatchObject({ ok: false, error: { code: 'STALE_CURSOR' } });
  expect(published).toEqual([]);
  published = ok(await scan(client, { limit: 1 }, () => latest));
  expect(published.map((row) => row.title)).toEqual(['A edited', 'B']);

  const prior = published;
  const lateChange = await scan(
    client,
    { limit: 1 },
    () => latest,
    async (last) => {
      if (last) await h.external('a.md', '- [ ] A edited\n- [ ] B edited\n');
    },
  );
  if (lateChange.ok) published = lateChange.value;
  expect(lateChange).toMatchObject({ ok: false, error: { code: 'SCAN_INVALIDATED' } });
  expect(published).toBe(prior);
  published = ok(await scan(client, { limit: 1 }, () => latest));
  expect(published.map((row) => row.title)).toEqual(['A edited', 'B edited']);

  unsubscribe();
  const calls = callback.mock.calls.length;
  const disposedCallback = vi.fn();
  ok(client.subscribe(disposedCallback));
  await h.external('a.md', '- [ ] After unsubscribe\n');
  expect(callback).toHaveBeenCalledTimes(calls);
  expect(disposedCallback.mock.calls.length).toBeGreaterThan(1);
  client.dispose();
  const disposedCalls = disposedCallback.mock.calls.length;
  await h.external('a.md', '- [ ] After client disposal\n');
  h.dispose();
  expect(disposedCallback).toHaveBeenCalledTimes(disposedCalls);
});

it('keeps published calendar rows when an unreadable empty note prevents complete coverage', async () => {
  const source = '- [ ] One 🆔 one 📅 2026-08-01\n- [ ] Two 📅 2026-08-02\n';
  const h = await publicApiHarness({ 'a.md': source, 'empty.md': '' });
  harnesses.push(h);
  const client = h.client('calendar');
  let latest = -1;
  ok(
    client.subscribe((event) => {
      latest = event.revision;
    }),
  );
  let published = ok(await scan(client, { limit: 1 }, () => latest));
  expect(published.map((row) => row.dates.due)).toEqual(['2026-08-01', '2026-08-02']);
  const prior = published;
  const cachedRead = h.app.vault.cachedRead.bind(h.app.vault);
  const failure = vi.spyOn(h.app.vault, 'cachedRead').mockImplementation(async (file) => {
    if (file.path === 'empty.md') throw new Error('Unreadable empty note');
    return cachedRead(file);
  });
  await h.index.refreshSourceExclusion(undefined);
  expect(ok(await client.ready()).lifecycle).toBe('ready');
  const incomplete = await scan(client, { limit: 1 }, () => latest);
  if (incomplete.ok) published = incomplete.value;
  expect(incomplete).toMatchObject({ ok: false, error: { code: 'INCOMPLETE_READ' } });
  expect(await client.tasks.resolve({ authoredId: 'one' })).toMatchObject({
    ok: false,
    error: { code: 'INCOMPLETE_READ' },
  });
  expect(published).toBe(prior);
  expect(await h.read('a.md')).toBe(source);
  expect(await h.read('empty.md')).toBe('');
  failure.mockRestore();
  await h.index.refreshSourceExclusion(undefined);
  published = ok(await scan(client, { limit: 1 }, () => latest));
  expect(published).toHaveLength(2);
  expect(published.map((row) => row.title)).toEqual(['One', 'Two']);
});

it('composes calendar filters with inclusive dates, folder boundaries and independent child matches', async () => {
  const h = await publicApiHarness({
    'Projects/Alpha.md': [
      '# Alpha',
      '- [ ] First #WORK 📅 2026-08-01',
      '- [ ] Last #work 📅 2026-08-31',
      '- [ ] Before #work 📅 2026-07-31',
      '- [ ] After #work 📅 2026-09-01',
      '- [x] Done #work 📅 2026-08-10',
      '- [ ] Untagged 📅 2026-08-10',
      '- [ ] Parent',
      '  - [ ] Child #WoRk 📅 2026-08-15',
      '',
    ].join('\n'),
    'Projects-old/Other.md': '- [ ] Wrong folder #work 📅 2026-08-10\n',
  });
  harnesses.push(h);
  const client = h.client('calendar');
  let latest = -1;
  ok(
    client.subscribe((event) => {
      latest = event.revision;
    }),
  );
  const rows = ok(
    await scan(
      client,
      {
        folder: 'Projects',
        statuses: ['open'],
        tagsAll: ['#wOrK'],
        dates: [{ field: 'due', from: '2026-08-01', to: '2026-08-31' }],
        limit: 1,
      },
      () => latest,
    ),
  );
  expect(rows.map((row) => ({ title: row.title, source: row.source, due: row.dates.due }))).toEqual(
    [
      { title: 'First', source: { path: 'Projects/Alpha.md', line: 1 }, due: '2026-08-01' },
      { title: 'Last', source: { path: 'Projects/Alpha.md', line: 2 }, due: '2026-08-31' },
      { title: 'Child', source: { path: 'Projects/Alpha.md', line: 8 }, due: '2026-08-15' },
    ],
  );
  const child = required(rows[2]);
  expect(ok(await client.tasks.get(child.target))).toEqual(child);
  expect(ok(await client.tasks.get(required(child.parentTarget))).title).toBe('Parent');
});

it('refuses an ambiguous authored ID until the consumer explicitly selects a source', async () => {
  const h = await publicApiHarness({ 'a.md': '- [ ] First 🆔 shared\n- [ ] Second 🆔 shared\n' });
  harnesses.push(h);
  const client = h.client('calendar');
  const writes = vi.spyOn(h.app.vault, 'process');
  const resolution = ok(await client.tasks.resolve({ authoredId: 'shared' }));
  expect(resolution.type).toBe('ambiguous');
  if (resolution.type !== 'ambiguous') throw new Error('Expected explicit source selection');
  expect(resolution.truncated).toBe(false);
  expect(resolution.candidates.map((row) => row.source.line)).toEqual([0, 1]);
  expect(ok(await client.tasks.resolve({ authoredId: 'absent' })).type).toBe('not-found');
  expect(writes).not.toHaveBeenCalled();
  expect(await h.read('a.md')).toBe('- [ ] First 🆔 shared\n- [ ] Second 🆔 shared\n');

  const selected = ok(await client.tasks.resolve({ source: { path: 'a.md', line: 1 } }));
  if (selected.type !== 'found') throw new Error('Missing selected task');
  expect(await client.tasks.complete(request(selected.task, 'complete-selected'))).toMatchObject({
    ok: true,
    receipt: { effects: 'committed' },
  });
  const markdown = await h.read('a.md');
  expect(markdown).toContain('- [ ] First 🆔 shared');
  expect(markdown).toContain('- [x] Second 🆔 shared');
  expect(ok(await client.tasks.get(required(resolution.candidates[0]).target)).status).toBe('open');
  expect(ok(await client.tasks.get(selected.task.target)).status).toBe('done');
});

it('uses catalog defaults and freshly read revisions for each status intent', async () => {
  const h = await publicApiHarness(
    { 'a.md': '- [ ] Task\n' },
    {
      index: {
        statusCatalog: new StatusCatalog([
          { id: 'open', symbol: ' ', type: 'todo', defaultForType: true },
          { id: 'progress', symbol: '/', type: 'in-progress', defaultForType: true },
          { id: 'done', symbol: 'x', type: 'done', defaultForType: true },
        ]),
      },
    },
  );
  harnesses.push(h);
  const client = h.client('calendar');
  const catalog = ok(await client.tasks.statuses());
  const progress = required(
    catalog.items.find((item) => item.status === 'in-progress' && item.defaultForStatus),
  );
  const open = required(
    catalog.items.find((item) => item.status === 'open' && item.defaultForStatus),
  );
  const done = required(
    catalog.items.find((item) => item.status === 'done' && item.defaultForStatus),
  );
  const original = required(ok(await client.tasks.list()).items[0]);
  expect(
    await client.tasks.setStatus({ ...request(original, 'start'), symbol: progress.symbol }),
  ).toMatchObject({ ok: true });
  const started = ok(await client.tasks.get(original.target));
  expect(started).toMatchObject({ status: 'in-progress', statusSymbol: progress.symbol });
  expect(started.revision).not.toBe(original.revision);
  expect(await h.read('a.md')).toBe('- [/] Task\n');
  expect(await client.tasks.complete(request(started, 'finish'))).toMatchObject({ ok: true });
  const completed = ok(await client.tasks.get(started.target));
  expect(completed).toMatchObject({ status: 'done', statusSymbol: done.symbol });
  expect(completed.revision).not.toBe(started.revision);
  expect(await h.read('a.md')).toContain('- [x] Task');
  expect(await client.tasks.toggleCompletion(request(completed, 'reopen'))).toMatchObject({
    ok: true,
  });
  const reopened = ok(await client.tasks.get(completed.target));
  expect(reopened).toMatchObject({ status: 'open', statusSymbol: open.symbol });
  expect(reopened.revision).not.toBe(completed.revision);
  expect(await h.read('a.md')).toBe('- [ ] Task\n');
});

it.each(['before-catalog', 'before-write'] as const)(
  'rejects a status intent when catalog semantics change %s, then rereads deliberately',
  async (timing) => {
    const source = '- [ ] Task\n';
    const catalog = new StatusCatalog([
      { id: 'open', symbol: ' ', type: 'todo', defaultForType: true },
      { id: 'progress', symbol: '/', type: 'in-progress', defaultForType: true },
      { id: 'done', symbol: 'x', type: 'done', defaultForType: true },
    ]);
    const h = await publicApiHarness({ 'a.md': source }, { index: { statusCatalog: catalog } });
    harnesses.push(h);
    const client = h.client('calendar');
    const original = required(ok(await client.tasks.list()).items[0]);
    const current = ok(await client.tasks.get(original.target));
    const changeCatalog = () => {
      catalog.replace([
        { id: 'open', symbol: ' ', type: 'todo', defaultForType: true },
        { id: 'cancelled', symbol: '/', type: 'cancelled', defaultForType: true },
        { id: 'progress', symbol: '>', type: 'in-progress', defaultForType: true },
        { id: 'done', symbol: 'x', type: 'done', defaultForType: true },
      ]);
      h.index.setStatusCatalog(catalog);
    };
    if (timing === 'before-catalog') changeCatalog();
    const statuses = ok(await client.tasks.statuses());
    const progress = required(
      statuses.items.find((item) => item.status === 'in-progress' && item.defaultForStatus),
    );
    if (timing === 'before-write') changeCatalog();
    const writes = vi.spyOn(h.app.vault, 'process');
    expect(
      await client.tasks.setStatus({
        ...request(current, 'before-settings'),
        symbol: progress.symbol,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'REVISION_CONFLICT' },
      effects: 'unchanged',
      recovery: 'reread',
    });
    expect(writes).not.toHaveBeenCalled();
    expect(await h.read('a.md')).toBe(source);

    const fresh = ok(await client.tasks.get(current.target));
    const freshCatalog = ok(await client.tasks.statuses());
    const desired = required(
      freshCatalog.items.find((item) => item.status === 'in-progress' && item.defaultForStatus),
    );
    expect(desired.symbol).toBe('>');
    expect(freshCatalog.items).toContainEqual({
      symbol: '/',
      status: 'cancelled',
      defaultForStatus: true,
    });
    expect(
      await client.tasks.setStatus({ ...request(fresh, 'after-settings'), symbol: desired.symbol }),
    ).toMatchObject({ ok: true, receipt: { effects: 'committed' } });
    expect(ok(await client.tasks.get(fresh.target))).toMatchObject({
      status: 'in-progress',
      statusSymbol: '>',
    });
    expect(await h.read('a.md')).toBe('- [>] Task\n');
  },
);

it.each(['keep', 'delete'] as const)(
  'replays %s recurrence receipts across clients before advancing the next occurrence',
  async (policy) => {
    const h = await publicApiHarness({
      'a.md': `- [ ] Repeat 🔁 every day 📅 2026-08-01 🏁 ${policy}\n`,
    });
    harnesses.push(h);
    const client = h.client('calendar');
    const original = required(ok(await client.tasks.list()).items[0]);
    const input = request(original, 'first-occurrence');
    const writes = vi.spyOn(h.app.vault, 'process');
    const first: MutationResultV1 = await client.tasks.complete(input);
    expect(first).toMatchObject({ ok: true });
    if (!first.ok) throw new Error(first.error.code);
    expect(first.receipt).toMatchObject({
      providerEpoch: client.info.providerEpoch,
      requestId: 'first-occurrence',
      acceptedAt: now,
      expiresAt: input.expiresAt,
      outcome: 'changed',
      effects: 'committed',
      recovery: 'none',
      snapshots: 'complete',
      warnings: [],
      original: { target: original.target, state: policy === 'keep' ? 'retained' : 'removed' },
      next: { task: { status: 'open', dates: { due: '2026-08-02' } } },
    });
    if (policy === 'keep')
      expect(first.receipt.original.task).toMatchObject({
        status: 'done',
        dates: { due: '2026-08-01' },
      });
    else expect(first.receipt.original.task).toBeUndefined();
    const saved = await h.read('a.md');
    const count = writes.mock.calls.length;
    client.dispose();
    const reconnected = h.client('calendar');
    expect(await reconnected.tasks.complete(input)).toEqual(first);
    expect(writes).toHaveBeenCalledTimes(count);
    expect(await h.read('a.md')).toBe(saved);
    const next = ok(await reconnected.tasks.get(required(first.receipt.next).target));
    expect(next.dates.due).toBe('2026-08-02');
    expect(next.target).not.toBe(original.target);
    const second = await reconnected.tasks.complete(request(next, 'second-occurrence'));
    if (!second.ok) throw new Error(second.error.code);
    expect(second.receipt).toMatchObject({
      effects: 'committed',
      next: { task: { dates: { due: '2026-08-03' } } },
    });
    const third = ok(await reconnected.tasks.get(required(second.receipt.next).target));
    expect(new Set([original.target, next.target, third.target]).size).toBe(3);
    expect(third.status).toBe('open');
    let latest = -1;
    ok(
      reconnected.subscribe((event) => {
        latest = event.revision;
      }),
    );
    const published = ok(await scan(reconnected, { limit: 1 }, () => latest));
    expect(published.map((row) => ({ due: row.dates.due, status: row.status }))).toEqual(
      policy === 'keep'
        ? [
            { due: '2026-08-03', status: 'open' },
            { due: '2026-08-02', status: 'done' },
            { due: '2026-08-01', status: 'done' },
          ]
        : [{ due: '2026-08-03', status: 'open' }],
    );
    const markdown = await h.read('a.md');
    expect(markdown.match(/^- \[[ x]\] Repeat/gm)).toHaveLength(policy === 'keep' ? 3 : 1);
    expect(markdown).toContain('📅 2026-08-03');
  },
);

it('rereads a child after a user root edit without overwriting parent or sibling text', async () => {
  const h = await publicApiHarness({
    'a.md': '- [ ] Parent\n  - [ ] Child 🆔 child\n  - [ ] Sibling\n',
  });
  harnesses.push(h);
  const client = h.client('calendar');
  const resolution = ok(await client.tasks.resolve({ authoredId: 'child' }));
  if (resolution.type !== 'found') throw new Error('Missing child');
  const stale = request(resolution.task, 'stale-child');
  const root = required(h.index.listNodes().find((node) => node.node.title === 'Parent'));
  expect(
    (await h.service.execute({ type: 'append-title', target: root.target, markdown: 'user edit' }))
      .type,
  ).toBe('ok');
  const edited = await h.read('a.md');
  expect(edited).toBe('- [ ] Parent user edit\n  - [ ] Child 🆔 child\n  - [ ] Sibling\n');
  const writes = vi.spyOn(h.app.vault, 'process');
  expect(await client.tasks.complete(stale)).toMatchObject({
    ok: false,
    error: { code: 'REVISION_CONFLICT' },
    effects: 'unchanged',
    recovery: 'reread',
  });
  expect(writes).not.toHaveBeenCalled();
  expect(await h.read('a.md')).toBe(edited);
  const fresh = ok(await client.tasks.resolve({ authoredId: 'child' }));
  if (fresh.type !== 'found') throw new Error('Missing edited child');
  expect(fresh.task.revision).not.toBe(resolution.task.revision);
  expect(await client.tasks.complete(request(fresh.task, 'fresh-child'))).toMatchObject({
    ok: true,
  });
  const markdown = await h.read('a.md');
  expect(markdown).toContain('- [ ] Parent user edit\n');
  expect(markdown).toContain('  - [x] Child 🆔 child');
  expect(markdown).toContain('  - [ ] Sibling\n');
});

it('reconnects after provider reload by authored ID and makes a new deliberate intent', async () => {
  const h = await publicApiHarness({ 'a.md': '- [ ] Task 🆔 unique\n' });
  harnesses.push(h);
  const client = h.client('calendar');
  const original = required(ok(await client.tasks.list()).items[0]);
  const oldRequest = request(original, 'before-reload');
  expect(await client.tasks.complete(oldRequest)).toMatchObject({ ok: true });
  const saved = await h.read('a.md');
  expect(saved).toContain('- [x] Task 🆔 unique');
  h.dispose();
  const reloaded = await publicApiHarness({ 'a.md': saved });
  harnesses.push(reloaded);
  const fresh = reloaded.client('calendar');
  expect(await client.tasks.list()).toMatchObject({ ok: false, error: { code: 'DISPOSED' } });
  expect(fresh.info.providerEpoch).not.toBe(client.info.providerEpoch);
  const resolved = ok(await fresh.tasks.resolve({ authoredId: 'unique' }));
  if (resolved.type !== 'found') throw new Error('Missing reloaded task');
  expect(resolved.task.status).toBe('done');
  expect(resolved.task.target).not.toBe(original.target);
  expect(await fresh.tasks.get(original.target)).toMatchObject({
    ok: false,
    error: { code: 'EXPIRED_TARGET' },
  });
  const writes = vi.spyOn(reloaded.app.vault, 'process');
  expect(await fresh.tasks.complete(oldRequest)).toMatchObject({
    ok: false,
    effects: 'unchanged',
    error: { code: 'EXPIRED_TARGET' },
  });
  expect(writes).not.toHaveBeenCalled();
  expect(await reloaded.read('a.md')).toBe(saved);
  expect(
    await fresh.tasks.toggleCompletion(request(resolved.task, 'after-reload-reopen')),
  ).toMatchObject({ ok: true });
  expect(ok(await fresh.tasks.get(resolved.task.target)).status).toBe('open');
  expect(await reloaded.read('a.md')).toBe('- [ ] Task 🆔 unique\n');
});

it.each(['event-delivered', 'readback-available', 'readback-unavailable'] as const)(
  'reconciles a lost write acknowledgment with %s',
  async (evidence) => {
    const h = await publicApiHarness({ 'a.md': '- [ ] Task 🆔 uncertain\n' });
    harnesses.push(h);
    const client = h.client('calendar');
    let latest = -1;
    ok(
      client.subscribe((event) => {
        latest = event.revision;
      }),
    );
    let published = ok(await scan(client, { limit: 1 }, () => latest));
    const prior = published;
    const original = required(published[0]);
    const input = request(original, 'uncertain-completion');
    const process = h.app.vault.process.bind(h.app.vault);
    const read = h.app.vault.read.bind(h.app.vault);
    let acknowledgmentLost = false;
    // Readback can recover source bytes without proving an occurrence continuation.
    // The third case keeps even those bytes unavailable until consumer recovery.
    const unavailableRead = vi.spyOn(h.app.vault, 'read').mockImplementation(async (file) => {
      if (evidence === 'readback-unavailable' && acknowledgmentLost)
        throw new Error('Recovery read unavailable');
      return read(file);
    });
    // The adapter branch loses acknowledgment before Vault can emit modify. Both
    // paths execute the real repository transform and persist its actual bytes.
    const writes = vi
      .spyOn(h.app.vault, 'process')
      .mockImplementation(async (file, update, options) => {
        if (evidence === 'event-delivered') await process(file, update, options);
        else await h.app.vault.adapter.process(file.path, update, options);
        acknowledgmentLost = true;
        throw new Error('Acknowledgment lost after actual write');
      });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const uncertain = await client.tasks.complete(input);
    expect(uncertain).toMatchObject(
      evidence !== 'event-delivered'
        ? {
            ok: false,
            error: { code: 'IO_ERROR' },
            effects: 'unknown',
            recovery: 'reconcile',
            receipt: {
              outcome: 'failed',
              original: { state: 'unproven' },
              snapshots: 'unavailable',
            },
          }
        : {
            ok: true,
            receipt: {
              outcome: 'changed',
              effects: 'committed',
              recovery: 'none',
              original: { state: 'retained', task: { status: 'done' } },
              snapshots: 'complete',
            },
          },
    );
    expect(published).toBe(prior);
    expect(required(published[0]).status).toBe('open');
    unavailableRead.mockRestore();
    const actual = await h.read('a.md');
    expect(actual).toContain('- [x] Task 🆔 uncertain');
    expect(await client.tasks.complete(input)).toEqual(uncertain);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(await h.read('a.md')).toBe(actual);
    writes.mockRestore();
    await h.index.refreshSourceExclusion(undefined);
    published = ok(await scan(client, { limit: 1 }, () => latest));
    expect(published).toHaveLength(1);
    expect(required(published[0])).toMatchObject({ status: 'done', authoredId: 'uncertain' });
    expect(await h.read('a.md')).toBe(actual);
  },
);
