import { afterEach, expect, it, vi } from 'vitest';
import { TaskListSurface } from '../src/panels/task-list/TaskListSurface';
import {
  TaskSearchRows,
  type TaskSearchRowsIdentity,
  type TaskSearchRowsOptions,
} from '../src/panels/task-list/TaskSearchRows';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type {
  TaskSearchOccurrence,
  TaskSearchOrganization,
} from '../src/task-lists/taskSearchOrganization';
import type {
  TaskNodeSnapshot,
  TaskSearchHydratedHit,
  TaskSearchState,
  TaskSnapshot,
} from '../src/tasks';
import * as cloning from '../src/tasks/domain/cloneTaskSnapshot';
import type { TaskRenderOutcome } from '../src/ui/taskRenderScope';
import { deferred, expectDefined, flushMicrotasks, useRealMoment } from './helpers';
import { finiteOccurrences, occurrenceRows } from './support/taskOrganizationRows';
import { prepareTaskPanelViewport } from './support/taskPanelViewport';
import { createCanonicalSearchHarness } from './support/taskSearchHarness';
import { mountCanonicalSearchUi } from './support/taskSearchUiHarness';
import { taskKeys } from './task-list-row-assertions';
useRealMoment();
afterEach(() => {
  vi.restoreAllMocks();
  document.body.empty();
});

async function rowsHarness(
  count = 120,
  overrides: Partial<TaskSearchRowsOptions> = {},
  sourceText?: string,
  scope: 'roots' | 'nodes' = 'roots',
) {
  const h = await createCanonicalSearchHarness(
    {
      'many.md':
        sourceText ??
        Array.from(
          { length: count },
          (_, n) => `- [ ] Root ${n}\n  - > needle **detail ${n}**`,
        ).join('\n'),
    },
    structuredClone(DEFAULT_SETTINGS),
  );
  let publication: TaskSearchState | undefined;
  const unsubscribe = h.search.subscribe((state) => {
    publication = state;
  });
  const signal = new AbortController().signal;
  const source = h.source.subscribe(() => {});
  source.unsubscribe();
  const records = [];
  for await (const batch of h.index.organization(
    { expectedGeneration: source.state.generation, scope },
    signal,
  ))
    records.push(...batch.items);
  const occurrences: TaskSearchOccurrence[] = records.map((record) => ({
    depth: record.depth,
    presentation: { kind: 'node', completion: { kind: 'allowed' } },
    key: `${record.source.filePath}:${record.source.line}`,
    taskKey: `${record.source.filePath}:${record.source.line}`,
    address: record.address,
    score: 1,
    group: null,
    menu: {
      status: record.status,
      statusSymbol: record.statusSymbol,
      priority: record.priority,
      planning: record.planning,
      tags: record.tags,
    },
  }));
  const organization: TaskSearchOrganization = {
    generation: source.state.generation,
    scope: 'roots',
    rootTotal: count,
    rows: occurrenceRows(occurrences),
  };
  const controller = new AbortController();
  let identity: TaskSearchRowsIdentity = {
    request: 1,
    generation: organization.generation,
    semanticsRevision: expectDefined(publication).semanticsRevision,
    query: 'needle',
    signal: controller.signal,
  };
  const mounted: TaskSnapshot[] = [];
  const projections: TaskNodeSnapshot[] = [];
  const failure = vi.fn();
  const owner = new TaskSearchRows({
    search: h.search,
    scheduler: { yield: async () => {} },
    prepareDependencies: (g, s) => h.index.prepareDependencies(g, s),
    isCurrent: (next) => next === identity && !controller.signal.aborted,
    mountCard: (element, task) => {
      mounted.push(task.root);
      projections.push(task);
      element.addClass('abyss-task-card');
      return {
        element,
        settled: Promise.resolve({ type: 'ready' }),
        update: () => {},
        destroy: () => {
          element.remove();
        },
      };
    },
    updateCard: () => {},
    refreshMeasurements: () => {},
    reportFailure: failure,
    ...overrides,
  });
  const rows = owner.set(organization, 'none', identity);
  const host = document.body.createDiv();
  return {
    ...h,
    owner,
    rows,
    host,
    identity,
    organization,
    mounted,
    projections,
    failure,
    publication: () => expectDefined(publication),
    replace(next: TaskSearchRowsIdentity) {
      identity = next;
      return owner.set({ ...organization, generation: next.generation }, 'none', next);
    },
    dispose() {
      unsubscribe();
      owner.dispose();
      controller.abort();
      h.close();
    },
  };
}
it('shares one detached root across occurrences, bounds more than 50 demanded roots, and drops the last lease', async () => {
  const h = await rowsHarness();
  const hydrate = vi.spyOn(h.index, 'resolveSearchHits');
  const detach = vi.spyOn(cloning, 'taskSnapshotWithStatuses');
  const first = expectDefined(finiteOccurrences(h.organization)[0]);
  const repeated = { ...first, key: 'repeat' };
  const rows = h.owner.set(
    { ...h.organization, rows: occurrenceRows([...finiteOccurrences(h.organization), repeated]) },
    'none',
    h.identity,
  );
  const mounts = [...rows.slice(0, rows.rowCount)].map((row) => h.owner.mount(h.host, row));
  h.owner.mountedChanged(taskKeys(rows));
  expect(await h.owner.settleMounted(h.identity.signal)).toEqual({ type: 'ready' });
  expect(hydrate.mock.calls.length).toBeGreaterThan(2);
  expect(
    hydrate.mock.calls.every(
      ([hits]) => hits.length <= 200 && new Set(hits.map((hit) => hit.address.rootId)).size <= 50,
    ),
  ).toBe(true);
  expect(detach).toHaveBeenCalledTimes(120);
  expect(h.mounted.filter((task) => task.source.line === 0)).toEqual([h.mounted[0], h.mounted[0]]);
  mounts[0]?.destroy();
  expect(await h.owner.settleRow('repeat', h.identity.signal)).toEqual({ type: 'ready' });
  mounts[mounts.length - 1]?.destroy();
  const remount = h.owner.mount(h.host, expectDefined(rows.rowAt(0)));
  expect(await h.owner.settleRow(first.key, h.identity.signal)).toEqual({ type: 'ready' });
  expect(detach).toHaveBeenCalledTimes(121);
  remount.destroy();
  mounts.forEach((mount) => {
    mount.destroy();
  });
  h.dispose();
});
it('skips queued evicted roots and cancels a never-mounted row wait on dispose', async () => {
  const h = await rowsHarness(2);
  const hydrate = vi.spyOn(h.index, 'resolveSearchHits');
  const mounted = h.owner.mount(h.host, expectDefined(h.rows.rowAt(0)));
  mounted.destroy();
  const pending = h.owner.settleRow(expectDefined(h.rows.taskKeyAt(1)), h.identity.signal);
  h.owner.dispose();
  expect(await pending).toEqual({ type: 'cancelled' });
  expect(hydrate).not.toHaveBeenCalled();
  h.dispose();
});
it('cancels an evicted row immediately while its sibling retains a held batch', async () => {
  const h = await rowsHarness(2);
  const hold = deferred<void>();
  const read = h.index.resolveSearchHits.bind(h.index);
  const hydration = vi
    .spyOn(h.index, 'resolveSearchHits')
    .mockImplementation(async (hits, signal) => {
      await hold.promise;
      return read(hits, signal);
    });
  const mounts = [...h.rows.slice(0, h.rows.rowCount)].map((row) => h.owner.mount(h.host, row));
  const pending = h.owner.settleRow(expectDefined(h.rows.taskKeyAt(0)), h.identity.signal);
  await vi.waitFor(() => {
    expect(hydration).toHaveBeenCalledTimes(1);
  });
  mounts[0]?.destroy();
  expect(await pending).toEqual({ type: 'cancelled' });
  hold.resolve();
  expect(await h.owner.settleRow(expectDefined(h.rows.taskKeyAt(1)), h.identity.signal)).toEqual({
    type: 'ready',
  });
  h.dispose();
});
it('publishes compact logical results through the canonical UI (Phase B consumer)', async () => {
  const h = await mountCanonicalSearchUi(
    {
      'many.md': Array.from(
        { length: 1200 },
        (_, n) => `- [ ] Root ${n}\n  - > needle **detail ${n}**`,
      ).join('\n'),
    },
    structuredClone(DEFAULT_SETTINGS),
  );
  const hydrate = vi.spyOn(h.index, 'resolveSearchHits');
  try {
    h.query('needle');
    await h.completed();
    const mounted = h.root.querySelectorAll('.abyss-task-card').length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(1200);
    expect(
      new Set(hydrate.mock.calls.flatMap(([hits]) => hits.map((hit) => hit.address.rootId))).size,
    ).toBeLessThan(1200);
    expect(h.root.querySelector('.abyss-search-paging')).toBeNull();
  } finally {
    h.dispose();
  }
});

it('waits for a pinned row mount, then cancels held Markdown on last-lease unmount', async () => {
  const markdown = deferred<TaskRenderOutcome>();
  const h = await rowsHarness(1, {
    mountCard: (element) => ({
      element,
      settled: markdown.promise,
      update: () => {},
      destroy: () => {
        element.remove();
      },
    }),
  });
  const key = expectDefined(h.rows.taskKeyAt(0));
  const pending = h.owner.settleRow(key, h.identity.signal);
  const mount = h.owner.mount(h.host, expectDefined(h.rows.rowAt(0)));
  await vi.waitFor(() => {
    expect(h.host.firstElementChild?.getAttribute('aria-busy')).toBeNull();
  });
  mount.destroy();
  expect(await pending).toEqual({ type: 'cancelled' });
  markdown.resolve({ type: 'failed', error: new Error('late Markdown') });
  await Promise.resolve();
  expect(h.failure).not.toHaveBeenCalled();
  h.dispose();
});
it.each(['hidden', 'detached', 'migrated'] as const)(
  'does not hydrate or report queued %s demand',
  async (reason) => {
    const hold = deferred<void>();
    const h = await rowsHarness(1, { scheduler: { yield: () => hold.promise } });
    const read = vi.spyOn(h.index, 'resolveSearchHits');
    const mount = h.owner.mount(h.host, expectDefined(h.rows.rowAt(0)));
    if (reason === 'hidden') h.host.hide();
    if (reason === 'detached') h.host.remove();
    if (reason === 'migrated') {
      const frame = document.body.createEl('iframe');
      expectDefined(frame.contentDocument).body.append(h.host);
    }
    hold.resolve();
    expect(await h.owner.settleRow(expectDefined(h.rows.taskKeyAt(0)), h.identity.signal)).toEqual({
      type: 'cancelled',
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(read).not.toHaveBeenCalled();
    expect(h.failure).not.toHaveBeenCalled();
    mount.destroy();
    h.dispose();
  },
);
it('reuses exact roots across unrelated G only after new dependency readiness', async () => {
  const h = await rowsHarness(1);
  const read = vi.spyOn(h.index, 'resolveSearchHits');
  const row = expectDefined(h.rows.rowAt(0));
  const mount = h.owner.mount(h.host, row);
  expect(await h.owner.settleRow(row.key, h.identity.signal)).toEqual({ type: 'ready' });
  h.index.installCommittedContent('other.md', '- [ ] Unrelated');
  const source = h.source.subscribe(() => {});
  source.unsubscribe();
  const hold = deferred<void>();
  const prepare = h.index.prepareDependencies.bind(h.index);
  vi.spyOn(h.index, 'prepareDependencies').mockImplementation(async (g, signal) => {
    await hold.promise;
    return prepare(g, signal);
  });
  const next = {
    ...h.identity,
    request: 2,
    generation: source.state.generation,
    semanticsRevision: h.publication().semanticsRevision,
    signal: new AbortController().signal,
  };
  const rows = h.replace(next);
  mount.update(expectDefined(rows.rowAt(0)));
  let ready = false;
  const pending = h.owner.settleRow(row.key, next.signal).then((outcome) => {
    ready = true;
    return outcome;
  });
  await Promise.resolve();
  expect(ready).toBe(false);
  hold.resolve();
  expect(await pending).toEqual({ type: 'ready' });
  expect(read).toHaveBeenCalledTimes(1);
  mount.destroy();
  h.dispose();
});
it('releases a held allocation when its last lease leaves and starts new demand', async () => {
  const h = await rowsHarness(2);
  const held = deferred<readonly TaskSearchHydratedHit[]>();
  let batchSignal: AbortSignal | undefined;
  const actual = h.index.resolveSearchHits.bind(h.index);
  const read = vi
    .spyOn(h.index, 'resolveSearchHits')
    .mockImplementationOnce((_hits, signal) => {
      batchSignal = signal;
      return held.promise;
    })
    .mockImplementation(actual);
  const first = h.owner.mount(h.host, expectDefined(h.rows.rowAt(0)));
  await vi.waitFor(() => {
    expect(read).toHaveBeenCalledTimes(1);
  });
  first.destroy();
  expect(batchSignal?.aborted).toBe(true);
  const next = h.owner.mount(h.host, expectDefined(h.rows.rowAt(1)));
  expect(await h.owner.settleRow(expectDefined(h.rows.taskKeyAt(1)), h.identity.signal)).toEqual({
    type: 'ready',
  });
  held.resolve([]);
  next.destroy();
  h.dispose();
});
it('explicit bulk resolution preserves physical order through bounded calls and rejects stale membership', async () => {
  const h = await rowsHarness(101);
  const read = vi.spyOn(h.index, 'resolveSearchHits');
  const keys = taskKeys(h.rows).reverse();
  keys.push(expectDefined(keys[0]));
  const tasks = await h.owner.resolve(keys, h.identity.signal);
  expect(tasks).toHaveLength(101);
  expect(tasks[0]?.node.title).toBe('Root 100');
  expect(tasks[100]?.node.title).toBe('Root 0');
  expect(read.mock.calls.map(([hits]) => hits.length)).toEqual([50, 50, 1]);
  expect(h.mounted).toHaveLength(0);
  h.index.installCommittedContent('many.md', '- [ ] Changed');
  await expect(h.owner.resolve(keys, h.identity.signal)).rejects.toMatchObject({ code: 'stale' });
  h.dispose();
});

it('joins the final sparse set of the existing generic surface without hydrating logical rows', async () => {
  const h = await rowsHarness(1200);
  prepareTaskPanelViewport(h.host);
  const read = vi.spyOn(h.index, 'resolveSearchHits');
  const surface = new TaskListSurface<TaskSearchOccurrence>({
    host: h.host,
    scroll: h.host,
    mount: (host, row) => h.owner.mount(host, row),
    mountedChanged: () => {
      h.owner.mountedChanged(surface.mountedKeys());
    },
    reportFailure: h.failure,
  });
  surface.update(h.rows, {
    revision: 'test',
    preserveAnchor: false,
    estimate: () => 64,
    measurementRevision: (row) => row.key,
  });
  expect(await h.owner.settleMounted(h.identity.signal)).toEqual({ type: 'ready' });
  expect(surface.mountedKeys().length).toBeGreaterThan(0);
  expect(surface.mountedKeys().length).toBeLessThan(1200);
  expect(read.mock.calls.flatMap(([hits]) => hits)).toHaveLength(surface.mountedKeys().length);
  expect(h.failure).not.toHaveBeenCalled();
  surface.destroy();
  h.dispose();
});
it('fails a current card mount once and never completes its row as ready', async () => {
  const error = new Error('mount failed');
  const h = await rowsHarness(1, {
    mountCard: () => {
      throw error;
    },
  });
  h.owner.mount(h.host, expectDefined(h.rows.rowAt(0)));
  expect(await h.owner.settleRow(expectDefined(h.rows.taskKeyAt(0)), h.identity.signal)).toEqual({
    type: 'failed',
    error,
  });
  expect(h.failure).toHaveBeenCalledExactlyOnceWith(error);
  h.dispose();
});
it('cancels old zero and nonzero mounted joins on identity replacement', async () => {
  const h = await rowsHarness(1);
  const empty = h.owner.settleMounted(h.identity.signal);
  const next = { ...h.identity, request: 2, signal: new AbortController().signal };
  h.replace(next);
  expect(await empty).toEqual({ type: 'cancelled' });
  const row = expectDefined(h.rows.rowAt(0));
  h.owner.mount(h.host, row);
  h.owner.mountedChanged([row.key]);
  const pending = h.owner.settleMounted(next.signal);
  h.replace({ ...next, request: 3, signal: new AbortController().signal });
  expect(await pending).toEqual({ type: 'cancelled' });
  h.dispose();
});

it('invalidates classified roots on a semantic-only G while exact addresses remain stable (contract correction)', async () => {
  const h = await rowsHarness(1, {}, '- [ ] Root\n  - [x] Child');
  const key = expectDefined(h.rows.taskKeyAt(0));
  const mount = h.owner.mount(h.host, expectDefined(h.rows.rowAt(0)));
  try {
    expect(await h.owner.settleRow(key, h.identity.signal)).toEqual({ type: 'ready' });
    expect((await h.owner.snapshot(key, h.identity.signal)).node.subtasks[0]?.status).toBe('done');
    h.statusCatalog.replace(
      h.statusCatalog
        .all()
        .map((rule) =>
          rule.symbol === 'x' ? { ...rule, type: 'todo', defaultForType: false } : rule,
        ),
    );
    h.index.setStatusCatalog(h.statusCatalog);
    const source = h.source.subscribe(() => {});
    source.unsubscribe();
    const next = {
      ...h.identity,
      request: 2,
      generation: source.state.generation,
      semanticsRevision: h.publication().semanticsRevision,
      signal: new AbortController().signal,
    };
    const records = [];
    for await (const batch of h.index.organization(
      { expectedGeneration: next.generation },
      next.signal,
    ))
      records.push(...batch.items);
    expect(records[0]?.address).toEqual(finiteOccurrences(h.organization)[0]?.address);
    expect(records[0]?.status).toBe(finiteOccurrences(h.organization)[0]?.menu.status);
    const rows = h.replace(next);
    mount.update(expectDefined(rows.rowAt(0)));
    expect(await h.owner.settleRow(key, next.signal)).toEqual({ type: 'ready' });
    const canonical = await h.index.resolveSearchHits(
      [expectDefined(finiteOccurrences(h.organization)[0])],
      next.signal,
    );
    expect(canonical[0]?.task.root.subtasks[0]?.status).toBe('open');
    expect((await h.owner.snapshot(key, next.signal)).node.subtasks[0]?.status).toBe('open');
  } finally {
    mount.destroy();
    h.dispose();
  }
});

it('updates retained group header position and source-note identity', async () => {
  const h = await rowsHarness(1);
  const mount = h.owner.mount(h.host, {
    kind: 'group',
    key: 'group',
    label: 'Old',
    count: 1,
    first: true,
    sourcePath: 'old.md',
  });
  mount.update({
    kind: 'group',
    key: 'group',
    label: 'Current',
    count: 2,
    first: false,
    sourcePath: 'current.md',
  });
  expect(mount.element.hasClass('abyss-group-header--first')).toBe(false);
  expect(mount.element.textContent).toBe('Current  2');
  expect(mount.element.getAttribute('aria-label')).toBe('current.md');
  mount.destroy();
  h.dispose();
});

it('retains same-source cards and ignores old Markdown failure while semantic refresh awaits hydration', async () => {
  const markdown = deferred<TaskRenderOutcome>();
  const hydration = deferred<void>();
  const destroy = vi.fn();
  const updates: TaskSnapshot[] = [];
  let receipt = markdown.promise;
  const h = await rowsHarness(
    2,
    {
      mountCard: (element) => ({
        element,
        get settled() {
          return receipt;
        },
        update: () => {},
        destroy,
      }),
      updateCard: (_card, task) => {
        updates.push(task.root);
        receipt = Promise.resolve({ type: 'ready' });
      },
    },
    '- [ ] Root\n  - [x] Child\n- [ ] Undemanded',
  );
  const actual = h.index.resolveSearchHits.bind(h.index);
  const read = vi.spyOn(h.index, 'resolveSearchHits');
  const row = expectDefined(h.rows.rowAt(0));
  const mount = h.owner.mount(h.host, row);
  const holder = mount.element;
  const oldWait = h.owner.settleRow(row.key, h.identity.signal);
  await vi.waitFor(() => {
    expect(holder.hasAttribute('aria-busy')).toBe(false);
  });
  read.mockImplementationOnce(async (hits, signal) => {
    await hydration.promise;
    return actual(hits, signal);
  });
  h.statusCatalog.replace(
    h.statusCatalog
      .all()
      .map((rule) =>
        rule.symbol === 'x' ? { ...rule, type: 'todo', defaultForType: false } : rule,
      ),
  );
  h.index.setStatusCatalog(h.statusCatalog);
  const publication = h.publication();
  const next = {
    ...h.identity,
    request: 2,
    generation: publication.generation,
    semanticsRevision: publication.semanticsRevision,
    signal: new AbortController().signal,
  };
  const rows = h.replace(next);
  mount.update(expectDefined(rows.rowAt(0)));
  expect(await oldWait).toEqual({ type: 'cancelled' });
  markdown.resolve({ type: 'failed', error: new Error('obsolete Markdown') });
  await Promise.resolve();
  await Promise.resolve();
  expect(h.failure).not.toHaveBeenCalled();
  expect(destroy).not.toHaveBeenCalled();
  hydration.resolve();
  expect(await h.owner.settleRow(row.key, next.signal)).toEqual({ type: 'ready' });
  expect(updates[updates.length - 1]?.subtasks[0]?.status).toBe('open');
  expect(mount.element).toBe(holder);
  expect(read.mock.calls.map(([hits]) => hits.length)).toEqual([1, 1]);
  mount.destroy();
  h.dispose();
});

it('discards a late pre-semantic hydration and cancels its snapshot waiter before current acquisition settles', async () => {
  const h = await rowsHarness(1, {}, '- [ ] Root\n  - [x] Child');
  const held = deferred<readonly TaskSearchHydratedHit[]>();
  const actual = h.index.resolveSearchHits.bind(h.index);
  let old: readonly TaskSearchHydratedHit[] | undefined;
  let oldSignal: AbortSignal | undefined;
  vi.spyOn(h.index, 'resolveSearchHits').mockImplementationOnce(async (hits, signal) => {
    oldSignal = signal;
    old = await actual(hits, signal);
    return held.promise;
  });
  const row = expectDefined(h.rows.rowAt(0));
  const mount = h.owner.mount(h.host, row);
  const pending = h.owner.snapshot(row.key, h.identity.signal);
  const rejected = expect(pending).rejects.toMatchObject({ code: 'stale' });
  await vi.waitFor(() => {
    expect(old).toBeDefined();
  });
  h.statusCatalog.replace(
    h.statusCatalog
      .all()
      .map((rule) =>
        rule.symbol === 'x' ? { ...rule, type: 'todo', defaultForType: false } : rule,
      ),
  );
  h.index.setStatusCatalog(h.statusCatalog);
  const publication = h.publication();
  const next = {
    ...h.identity,
    request: 2,
    generation: publication.generation,
    semanticsRevision: publication.semanticsRevision,
    signal: new AbortController().signal,
  };
  const rows = h.replace(next);
  mount.update(expectDefined(rows.rowAt(0)));
  await rejected;
  expect(oldSignal?.aborted).toBe(true);
  expect(await h.owner.settleRow(row.key, next.signal)).toEqual({ type: 'ready' });
  held.resolve(expectDefined(old));
  await Promise.resolve();
  expect((await h.owner.snapshot(row.key, next.signal)).node.subtasks[0]?.status).toBe('open');
  expect(h.failure).not.toHaveBeenCalled();
  mount.destroy();
  h.dispose();
});

it.each(['sibling', 'explicit'] as const)(
  'retains failure reporting for a live %s sharing hidden root demand',
  async (demand) => {
    const h = await rowsHarness(1);
    const first = expectDefined(finiteOccurrences(h.organization)[0]);
    const repeated = { ...first, key: 'repeat' };
    const rows = h.owner.set(
      { ...h.organization, rows: occurrenceRows([first, repeated]) },
      'none',
      h.identity,
    );
    const held = deferred<void>(),
      entered = deferred<void>();
    const error = new Error('live read failure');
    vi.spyOn(h.index, 'resolveSearchHits').mockImplementationOnce(async () => {
      entered.resolve();
      await held.promise;
      throw error;
    });
    const hidden = h.owner.mount(h.host, expectDefined(rows.rowAt(0)));
    const sibling =
      demand === 'sibling' ? h.owner.mount(h.host, expectDefined(rows.rowAt(1))) : undefined;
    const explicit =
      demand === 'explicit'
        ? h.owner.snapshot(first.key, h.identity.signal).catch((reason: unknown) => reason)
        : undefined;
    try {
      await entered.promise;
      hidden.element.hide();
      held.resolve();
      if (explicit !== undefined) expect(await explicit).toBe(error);
      else
        expect(await h.owner.settleRow('repeat', h.identity.signal)).toEqual({
          type: 'failed',
          error,
        });
      expect(h.failure).toHaveBeenCalledExactlyOnceWith(error);
    } finally {
      held.resolve();
      sibling?.destroy();
      hidden.destroy();
      h.dispose();
    }
  },
);
it('drops a hidden dependency failure and prepares again on renewed mounted demand', async () => {
  const h = await rowsHarness(1);
  const held = deferred<void>(),
    entered = deferred<void>();
  vi.spyOn(h.index, 'prepareDependencies').mockImplementationOnce(async () => {
    entered.resolve();
    await held.promise;
    throw new Error('hidden dependency failure');
  });
  const row = expectDefined(h.rows.rowAt(0));
  const mount = h.owner.mount(h.host, row);
  try {
    await entered.promise;
    h.host.hide();
    held.resolve();
    await flushMicrotasks();
    expect(h.failure).not.toHaveBeenCalled();
    h.host.show();
    h.owner.mountedChanged([row.key]);
    expect(await h.owner.settleRow(row.key, h.identity.signal)).toEqual({ type: 'ready' });
  } finally {
    held.resolve();
    mount.destroy();
    h.dispose();
  }
});

it('fails only eligible roots in a shared allocation and leaves a hidden root resumable', async () => {
  const h = await rowsHarness(2);
  const held = deferred<void>(),
    entered = deferred<void>();
  const error = new Error('shared allocation failed');
  vi.spyOn(h.index, 'resolveSearchHits').mockImplementationOnce(async () => {
    entered.resolve();
    await held.promise;
    throw error;
  });
  const first = expectDefined(h.rows.rowAt(0));
  const second = expectDefined(h.rows.rowAt(1));
  const hidden = h.owner.mount(h.host, first);
  const live = h.owner.mount(h.host, second);
  try {
    await entered.promise;
    hidden.element.hide();
    held.resolve();
    expect(await h.owner.settleRow(second.key, h.identity.signal)).toEqual({
      type: 'failed',
      error,
    });
    expect(h.failure).toHaveBeenCalledExactlyOnceWith(error);
    hidden.element.show();
    h.owner.mountedChanged(taskKeys(h.rows));
    expect(await h.owner.settleRow(first.key, h.identity.signal)).toEqual({ type: 'ready' });
    expect(h.failure).toHaveBeenCalledTimes(1);
  } finally {
    held.resolve();
    hidden.destroy();
    live.destroy();
    h.dispose();
  }
});

it('admits measurements only for the current mounted card receipt', async () => {
  const receipt = deferred<TaskRenderOutcome>();
  const settled = vi.fn(() => receipt.promise);
  const h = await rowsHarness(1, {
    mountCard: (element) => ({
      element,
      get settled() {
        return settled();
      },
      update: () => {},
      destroy: () => {
        element.remove();
      },
    }),
  });
  try {
    const row = expectDefined(h.rows.rowAt(0));
    const mount = h.owner.mount(h.host, row);
    expect(mount.measurementReady?.()).toBe(false);
    receipt.resolve({ type: 'ready' });
    expect(await h.owner.settleRow(row.key, h.identity.signal)).toEqual({ type: 'ready' });
    expect(mount.measurementReady?.()).toBe(true);
    const next = deferred<TaskRenderOutcome>();
    settled.mockReturnValue(next.promise);
    expect(mount.measurementReady?.()).toBe(false);
    const changed = h.owner.settleRow(row.key, h.identity.signal);
    next.resolve({ type: 'ready' });
    expect(await changed).toEqual({ type: 'ready' });
    expect(mount.measurementReady?.()).toBe(true);
    mount.destroy();
    const remount = h.owner.mount(h.host, row);
    expect(remount.measurementReady?.()).toBe(false);
    expect(await h.owner.settleRow(row.key, h.identity.signal)).toEqual({ type: 'ready' });
    expect(remount.measurementReady?.()).toBe(true);
    remount.destroy();
  } finally {
    h.dispose();
  }
});

it('shares a rich root while mounting exact root, parent, and same-title sibling projections', async () => {
  const h = await rowsHarness(
    4,
    {},
    '- [ ] Grandparent #one-off\n  - [ ] Parent #private\n    - [ ] Same #inbox 📅 2026-10-08\n  - [ ] Same #inbox 📅 2026-10-08',
    'nodes',
  );
  const detach = vi.spyOn(cloning, 'taskSnapshotWithStatuses');
  const mounts = [...h.rows.slice(0, h.rows.rowCount)].map((row) => h.owner.mount(h.host, row));
  h.owner.mountedChanged(taskKeys(h.rows));
  try {
    expect(await h.owner.settleMounted(h.identity.signal)).toEqual({ type: 'ready' });
    expect(h.projections.map((task) => task.node.title)).toEqual([
      'Grandparent',
      'Parent',
      'Same',
      'Same',
    ]);
    expect(h.projections.map((task) => task.path.map((node) => node.ref.relativeLine))).toEqual([
      [],
      [1],
      [1, 1],
      [3],
    ]);
    expect(new Set(h.projections.map((task) => task.root)).size).toBe(1);
    expect(detach).toHaveBeenCalledTimes(1);
    const children = await h.owner.resolve(['many.md:2', 'many.md:3'], h.identity.signal);
    expect(children.map((task) => task.path.map((node) => node.title))).toEqual([
      ['Parent', 'Same'],
      ['Same'],
    ]);
  } finally {
    mounts.forEach((mount) => {
      mount.destroy();
    });
    h.dispose();
  }
});

it('does not accept the pending receipt of an exact child after its row is remounted', async () => {
  const held = deferred<TaskRenderOutcome>();
  let first = true;
  const h = await rowsHarness(
    2,
    {
      mountCard: (element) => {
        const settled = first ? held.promise : Promise.resolve({ type: 'ready' as const });
        first = false;
        return {
          element,
          settled,
          update: () => {},
          destroy: () => {
            element.remove();
          },
        };
      },
    },
    '- [ ] Root\n  - [ ] Child',
    'nodes',
  );
  const row = expectDefined(h.rows.rowAt(1));
  let mount = h.owner.mount(h.host, row);
  h.owner.mountedChanged([row.key]);
  await flushMicrotasks(20);
  const old = h.owner.settleRow(row.key, h.identity.signal);
  await flushMicrotasks();
  mount.destroy();
  mount = h.owner.mount(h.host, row);
  held.resolve({ type: 'ready' });
  try {
    expect(await old).toEqual({ type: 'cancelled' });
    expect(await h.owner.settleRow(row.key, h.identity.signal)).toEqual({ type: 'ready' });
  } finally {
    mount.destroy();
    h.dispose();
  }
});

it('removes actionable cards on live dependency failure and retries the same exact address', async () => {
  let fail = false;
  const h = await rowsHarness(1, {
    prepareDependencies: async () => {
      if (fail) throw new Error('unavailable');
    },
  });
  const row = expectDefined(h.rows.rowAt(0));
  const mount = h.owner.mount(h.host, row);
  h.owner.mountedChanged([row.key]);
  try {
    expect(await h.owner.settleRow(row.key, h.identity.signal)).toEqual({ type: 'ready' });
    fail = true;
    const failedIdentity = { ...h.identity, request: 2 };
    const rows = h.replace(failedIdentity);
    mount.update(expectDefined(rows.rowAt(0)));
    expect((await h.owner.settleRow(row.key, failedIdentity.signal)).type).toBe('failed');
    expect(mount.element.inert || !mount.element.isConnected).toBe(true);
    fail = false;
    const retry = { ...h.identity, request: 3 };
    const retried = h.replace(retry);
    h.host.append(mount.element);
    mount.update(expectDefined(retried.rowAt(0)));
    expect(await h.owner.settleRow(row.key, retry.signal)).toEqual({ type: 'ready' });
    expect(h.failure).toHaveBeenCalledTimes(1);
  } finally {
    mount.destroy();
    h.dispose();
  }
});
