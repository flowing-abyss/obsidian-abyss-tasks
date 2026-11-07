import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/settings/defaults';
import { toStatusRules } from '../../src/settings/statusCatalogAdapter';
import type { TaskAcceptedOccurrenceChange } from '../../src/tasks/application/TaskIntegrationReadApi';
import { atomDateTime } from '../../src/tasks/domain/commentTimestamp';
import { StatusCatalog } from '../../src/tasks/domain/StatusCatalog';
import { timeEntryRef } from '../../src/tasks/domain/timeTracking';
import { localDate } from '../../src/tasks/domain/validation';
import { TaskBlockEditor } from '../../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { TaskLocator } from '../../src/tasks/infrastructure/markdown/TaskLocator';
import { TaskMarkdownCodec } from '../../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { ObsidianTaskRepository } from '../../src/tasks/infrastructure/obsidian/ObsidianTaskRepository';
import { expectDefined, flushMicrotasks, metadataChangedEmitter } from '../helpers';
import { publicApiHarness, type PublicApiHarness } from '../support/publicApiHarness';

const opened: PublicApiHarness[] = [];
afterEach(() => {
  for (const h of opened.splice(0)) h.dispose();
});
async function setup(source: string) {
  const h = await publicApiHarness({ 'tasks.md': source });
  opened.push(h);
  const codec = new TaskMarkdownCodec(
    new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses)),
  );
  const repository = new ObsidianTaskRepository(h.app, {
    codec,
    editor: new TaskBlockEditor(),
    locator: new TaskLocator(h.authority),
    refAuthority: h.authority,
    snapshotsFromContent: (path, content) => h.index.previewContent(path, content),
    snapshotState: h.index,
  });
  const changes: TaskAcceptedOccurrenceChange[] = [];
  h.reads.activateOccurrences();
  h.reads.subscribe((event) => {
    if (event.type === 'accepted') changes.push(event.change);
  });
  return { ...h, repository, changes };
}

it('continues all physical nodes through an ordinary deep-child field edit before returning', async () => {
  const h = await setup('- [ ] Root\n  - [ ] Child\n    - [ ] Grandchild\n  - [ ] Sibling\n');
  const root = expectDefined(h.index.list()[0]);
  const child = expectDefined(expectDefined(root.subtasks[0]).subtasks[0]);
  const result = await h.repository.edit({
    type: 'set-status',
    target: { type: 'subtask', ref: child.ref },
    symbol: 'x',
    stamp: localDate('2026-08-01'),
  });
  expect(result.type).toBe('committed');
  expect(h.changes[0]?.witnesses.map((value) => value.kind)).toEqual([
    'continued',
    'continued',
    'continued',
    'continued',
  ]);
  expect(h.changes[0]?.invalidated).toEqual([]);
});

it('maps task offsets through inserted comments and tracking lines', async () => {
  const h = await setup('- [ ] Root\n  - [ ] Child\n    - [ ] Grandchild\n');
  for (const command of [
    {
      type: 'add-comment' as const,
      text: 'first\nsecond',
      stamp: atomDateTime('2026-08-01T12:00:00Z'),
    },
    { type: 'add-time-entry' as const, stamp: atomDateTime('2026-08-01T12:00:00Z') },
  ]) {
    const root = expectDefined(h.index.list()[0]);
    h.changes.length = 0;
    expect(
      await h.repository.edit({ ...command, parent: { type: 'task', ref: root.ref } }),
    ).toMatchObject({ type: 'committed' });
    expect(h.changes[0]?.witnesses).toHaveLength(3);
    expect(h.changes[0]?.invalidated).toEqual([]);
    const page = h.reads.page({}, 10);
    if (page.type !== 'ok') throw new Error('No page');
    expect(
      h.changes[0]?.witnesses.flatMap((value) => (value.kind === 'continued' ? [value.after] : [])),
    ).toEqual(page.value.nodes.map((value) => value.address));
  }
});

it('provides semantic evidence during an early metadata publication', async () => {
  const h = await setup('- [ ] Root\n  - [ ] Child\n');
  const originalProcess = h.app.vault.process.bind(h.app.vault);
  const fire = metadataChangedEmitter(h.app);
  vi.spyOn(h.app.vault, 'process').mockImplementation(async (file, transform) => {
    const result = await originalProcess(file, transform);
    fire(file, result, {});
    await flushMicrotasks();
    expect(h.changes[0]?.witnesses).toHaveLength(2);
    return result;
  });
  const root = expectDefined(h.index.list()[0]);
  expect(
    await h.repository.edit({
      type: 'set-status',
      target: { type: 'task', ref: root.ref },
      symbol: 'x',
      stamp: localDate('2026-08-01'),
    }),
  ).toMatchObject({ type: 'committed' });
});

it('continues exact unique external relocation and invalidates changed or duplicate source', async () => {
  const h = await setup('- [ ] Root\n  - [ ] Child\n');
  await h.external('tasks.md', 'heading\n- [ ] Root\n  - [ ] Child\n');
  expect(
    h.changes.find((change) => change.witnesses.length > 0)?.witnesses.map((value) => value.kind),
  ).toEqual(['continued', 'continued']);
  expect(h.changes[h.changes.length - 1]?.invalidated).toEqual([]);
  h.changes.length = 0;
  await h.external('tasks.md', 'heading\n- [ ] Changed\n  - [ ] Child\n');
  expect(h.changes[h.changes.length - 1]?.witnesses).toEqual([]);
  expect(h.changes.flatMap((change) => change.invalidated)).toHaveLength(2);
  await h.external('tasks.md', '- [ ] Same\n- [ ] Same\n');
  await h.external('tasks.md', 'heading\n- [ ] Same\n- [ ] Same\n');
  expect(h.changes[h.changes.length - 1]?.witnesses).toEqual([]);
});

it('does not resurrect occurrences across external delete/recreate', async () => {
  const h = await setup('- [ ] Root\n  - [ ] Child\n');
  const file = expectDefined(h.app.vault.getFileByPath('tasks.md'));
  await h.app.fileManager.trashFile(file);
  await h.app.vault.create('tasks.md', '- [ ] Root\n  - [ ] Child\n');
  await flushMicrotasks();
  expect(h.changes.flatMap((value) => value.witnesses)).toEqual([]);
  expect(h.changes.flatMap((value) => value.invalidated)).toHaveLength(2);
});

it('renames duplicate roots by owned file and physical coordinates', async () => {
  const h = await setup('- [ ] Same\n  - [ ] Same\n- [ ] Same\n  - [ ] Same\n');
  await h.app.vault.rename(expectDefined(h.app.vault.getFileByPath('tasks.md')), 'renamed.md');
  expect(h.changes[0]?.witnesses).toHaveLength(4);
  expect(h.changes[0]?.invalidated).toEqual([]);
  for (const value of h.changes[0]?.witnesses ?? []) {
    expect(value.kind).toBe('continued');
    if (value.kind === 'continued') {
      expect(value.after.rootLine).toBe(value.before.rootLine);
      expect(value.after.nodeOffset).toBe(value.before.nodeOffset);
      expect(value.after.filePath).toBe('renamed.md');
      expect(value.after.rootRevision).not.toBe(value.before.rootRevision);
    }
  }
});

it.each(['policy', 'statistics'] as const)(
  'confirms unchanged %s refresh rename before continuing old nodes',
  async (mode) => {
    const h = await publicApiHarness(
      { 'tasks.md': '- [ ] Root\n  - [ ] Child\n' },
      { index: mode === 'policy' ? { excludeSource: () => false } : {} },
    );
    opened.push(h);
    if (mode === 'statistics') {
      h.index.subscribeStatistics(() => {});
      await h.index.whenStatisticsSettled();
    }
    h.reads.activateOccurrences();
    const changes: TaskAcceptedOccurrenceChange[] = [];
    h.reads.subscribe((event) => {
      if (event.type === 'accepted') changes.push(event.change);
    });
    const originalRead = h.app.vault.cachedRead.bind(h.app.vault);
    let finish: (() => void) | undefined;
    vi.spyOn(h.app.vault, 'cachedRead').mockImplementation(async (file) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return originalRead(file);
    });
    await h.app.vault.rename(expectDefined(h.app.vault.getFileByPath('tasks.md')), 'renamed.md');
    expect(changes.flatMap((change) => change.witnesses)).toEqual([]);
    expect(changes.flatMap((change) => change.invalidated)).toEqual([]);
    expect(h.reads.coverage()).toMatchObject({ type: 'error', reason: 'incomplete' });
    let sawAccepted = false;
    const renamedCallbacks: boolean[] = [];
    const readsDuringAcceptance: Array<ReturnType<typeof h.reads.page>> = [];
    h.reads.subscribe((event) => {
      if (event.type === 'accepted' && event.change.witnesses.length > 0) {
        sawAccepted = true;
        readsDuringAcceptance.push(h.reads.page({}, 10));
      }
    });
    h.index.subscribe((event) => {
      if (event.type === 'renamed') renamedCallbacks.push(sawAccepted);
    });
    expectDefined(finish)();
    await flushMicrotasks();
    expect(renamedCallbacks).toEqual([true]);
    expect(readsDuringAcceptance).toHaveLength(1);
    const current = expectDefined(readsDuringAcceptance[0]);
    expect(current.type).toBe('ok');
    if (current.type === 'ok')
      expect(current.value.nodes.every((node) => node.address.filePath === 'renamed.md')).toBe(
        true,
      );
    expect(changes.flatMap((change) => change.witnesses).map((value) => value.kind)).toEqual([
      'continued',
      'continued',
    ]);
    expect(changes.flatMap((change) => change.invalidated)).toEqual([]);
  },
);

it.each(['changed', 'failed', 'superseded', 'replaced'] as const)(
  'invalidates only pending rename predecessors when the read is %s',
  async (mode) => {
    const content = '- [ ] Root\n  - [ ] Child\n';
    const h = await publicApiHarness(
      { 'tasks.md': content },
      { index: { excludeSource: () => false } },
    );
    opened.push(h);
    h.reads.activateOccurrences();
    const page = h.reads.page({}, 10);
    if (page.type !== 'ok') throw new Error('No page');
    const oldAddresses = page.value.nodes.map((value) => value.address);
    const changes: TaskAcceptedOccurrenceChange[] = [];
    h.reads.subscribe((event) => {
      if (event.type === 'accepted') changes.push(event.change);
    });
    let finish: ((content: string) => void) | undefined;
    let fail: ((reason: Error) => void) | undefined;
    vi.spyOn(h.app.vault, 'cachedRead').mockImplementationOnce(
      () =>
        new Promise<string>((resolve, reject) => {
          finish = resolve;
          fail = reject;
        }),
    );
    await h.app.vault.rename(expectDefined(h.app.vault.getFileByPath('tasks.md')), 'renamed.md');
    expect(oldAddresses.every((address) => !h.reads.canDisclose(address))).toBe(true);
    if (mode === 'failed') expectDefined(fail)(new Error('rename read failed'));
    else {
      if (mode === 'superseded') await h.external('renamed.md', '- [ ] Newer\n');
      if (mode === 'replaced') {
        await h.app.fileManager.trashFile(expectDefined(h.app.vault.getFileByPath('renamed.md')));
        await h.app.vault.create('renamed.md', content);
        await flushMicrotasks();
      }
      expectDefined(finish)(mode === 'changed' ? '- [ ] Changed\n' : content);
    }
    await flushMicrotasks();
    expect(changes.flatMap((change) => change.witnesses)).toEqual([]);
    expect(changes.flatMap((change) => change.invalidated)).toEqual(oldAddresses);
    if (mode === 'superseded' || mode === 'replaced') expect(h.reads.page({}, 10).type).toBe('ok');
  },
);

it('rechecks path exclusion immediately during rename', async () => {
  const h = await publicApiHarness(
    { 'tasks.md': '- [ ] Root' },
    { index: { excludeSource: (source) => source.filePath === 'hidden.md' } },
  );
  opened.push(h);
  h.reads.activateOccurrences();
  const changes: TaskAcceptedOccurrenceChange[] = [];
  h.reads.subscribe((event) => {
    if (event.type === 'accepted') changes.push(event.change);
  });
  await h.app.vault.rename(expectDefined(h.app.vault.getFileByPath('tasks.md')), 'hidden.md');
  expect(changes.flatMap((change) => change.witnesses)).toEqual([]);
  expect(changes.flatMap((change) => change.invalidated)).toHaveLength(1);
  await flushMicrotasks();
  expect(h.index.list()).toEqual([]);
});

it('continues exact nodes through short tracking-line discard and multiline comment deletion', async () => {
  const h = await setup(
    '- [ ] Root\n  - 2026-08-01T10:00:00Z →\n  - 2026-08-01: first\n    second\n  - [ ] Child\n    - [ ] Grandchild\n',
  );
  let root = expectDefined(h.index.list()[0]);
  const entry = expectDefined(root.timeEntries[0]);
  expect(
    await h.repository.edit({
      type: 'close-time-entry',
      entry: timeEntryRef({ type: 'task', ref: root.ref }, entry),
      stamp: atomDateTime('2026-08-01T10:00:01Z'),
      endMs: Date.parse('2026-08-01T10:00:01Z'),
      minimumMs: 2000,
    }),
  ).toMatchObject({ type: 'committed' });
  const discard = expectDefined(h.changes.find((change) => change.witnesses.length > 0));
  expect(
    discard.witnesses.flatMap((value) =>
      value.kind === 'continued' ? [[value.before.nodeOffset, value.after.nodeOffset]] : [],
    ),
  ).toEqual([
    [0, 0],
    [4, 3],
    [5, 4],
  ]);
  root = expectDefined(h.index.list()[0]);
  h.changes.length = 0;
  expect(
    await h.repository.edit({
      type: 'delete-comment',
      comment: expectDefined(root.comments[0]).ref,
    }),
  ).toMatchObject({ type: 'committed' });
  const deleted = expectDefined(h.changes.find((change) => change.witnesses.length > 0));
  expect(
    deleted.witnesses.flatMap((value) =>
      value.kind === 'continued' ? [[value.before.nodeOffset, value.after.nodeOffset]] : [],
    ),
  ).toEqual([
    [0, 0],
    [3, 1],
    [4, 2],
  ]);
});

it('continues existing physical nodes through insertion and gives the new child fresh identity', async () => {
  const h = await setup('- [ ] Root\n  - [ ] Child\n');
  const root = expectDefined(h.index.list()[0]);
  expect(
    await h.repository.edit({
      type: 'add-subtask',
      parent: { type: 'task', ref: root.ref },
      text: 'New',
      today: localDate('2026-08-01'),
      addCreatedDate: false,
    }),
  ).toMatchObject({ type: 'committed' });
  expect(h.changes[0]?.witnesses.map((witness) => witness.kind)).toEqual([
    'continued',
    'continued',
  ]);
  expect(h.changes[0]?.invalidated).toEqual([]);
  const page = h.reads.page({}, 10);
  if (page.type !== 'ok') throw new Error('No page');
  expect(page.value.nodes).toHaveLength(3);
  expect(
    h.changes[0]?.witnesses.flatMap((witness) =>
      witness.kind === 'continued' ? [witness.after] : [],
    ),
  ).toEqual(page.value.nodes.slice(0, 2).map((node) => node.address));
});

it('invalidates promoted hierarchy occurrences without treating the copied subtree as a continuation', async () => {
  const h = await setup('- [ ] Root\n  - [ ] Child\n    - [ ] Grandchild\n');
  const root = expectDefined(h.index.list()[0]);
  const child = expectDefined(root.subtasks[0]);
  expect(
    await h.repository.hierarchy({
      command: { type: 'promote-subtask', subtask: child.ref },
      source: {
        baseRoot: root,
        baseTarget: { type: 'subtask', ref: child.ref },
        reconciliation: { observed: root },
      },
    }),
  ).toMatchObject({ type: 'committed' });
  expect(h.changes.flatMap((change) => change.witnesses)).toEqual([]);
  expect(h.changes.flatMap((change) => change.invalidated)).toHaveLength(3);
});

it('invalidates cross-file moves without granting continuity from a destination copy', async () => {
  const h = await setup('- [ ] Root\n  - [ ] Child\n');
  await h.app.vault.create('destination.md', '');
  await flushMicrotasks();
  h.changes.length = 0;
  const root = expectDefined(h.index.list()[0]);
  expect(
    await h.repository.move(root.ref, {
      filePath: 'destination.md',
      insertion: { type: 'append' },
    }),
  ).toMatchObject({ type: 'committed' });
  expect(h.changes.flatMap((change) => change.witnesses)).toEqual([]);
  expect(h.changes.flatMap((change) => change.invalidated)).toHaveLength(2);
});

it('keeps unsettled rename health and invalidates its unconfirmed predecessors', async () => {
  const h = await setup('- [ ] Root\n  - [ ] Child\n');
  let finish: ((content: string) => void) | undefined;
  vi.spyOn(h.app.vault, 'cachedRead').mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const reload = h.index.refreshSourceExclusion(undefined);
  try {
    expect(h.reads.coverage()).toMatchObject({ type: 'error', reason: 'incomplete' });
    await h.app.vault.rename(expectDefined(h.app.vault.getFileByPath('tasks.md')), 'renamed.md');
    await flushMicrotasks();
    expect(h.changes.flatMap((change) => change.witnesses)).toEqual([]);
    expect(h.changes.flatMap((change) => change.invalidated)).toHaveLength(2);
  } finally {
    expectDefined(finish)('- [ ] Obsolete read');
    await reload;
  }
  expect(h.index.list()[0]?.title).toBe('Root');
});
