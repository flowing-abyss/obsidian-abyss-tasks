import { TFile } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { toStatusRules } from '../src/settings/statusCatalogAdapter';
import { TaskApplicationService } from '../src/tasks/application/TaskApplicationService';
import type { TaskRepository } from '../src/tasks/application/TaskRepository';
import { StatusCatalog } from '../src/tasks/domain/StatusCatalog';
import { localDate } from '../src/tasks/domain/validation';
import { TaskIndex } from '../src/tasks/infrastructure/TaskIndex';
import { TaskBlockEditor } from '../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { TaskLocator } from '../src/tasks/infrastructure/markdown/TaskLocator';
import { TaskMarkdownCodec } from '../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { ObsidianTaskRepository } from '../src/tasks/infrastructure/obsidian/ObsidianTaskRepository';
import { createAppWithFiles, expectDefined } from './helpers';

const catalog = new StatusCatalog([
  { id: 'todo', symbol: 't', type: 'todo', defaultForType: true },
  { id: 'doing', symbol: '!', type: 'in-progress', defaultForType: true },
  { id: 'done', symbol: 'd', type: 'done', defaultForType: true },
  { id: 'done-alt', symbol: 'z', type: 'done', defaultForType: false },
  { id: 'cancelled', symbol: 'c', type: 'cancelled', defaultForType: true },
  { id: 'cancelled-alt', symbol: 'k', type: 'cancelled', defaultForType: false },
]);

async function setup(source: string) {
  const app = await createAppWithFiles({ 'tasks.md': source });
  const editor = new TaskBlockEditor();
  const locator = new TaskLocator();
  const index = new TaskIndex(app, { statusCatalog: catalog, dailyNoteFormat: 'YYYY-MM-DD' });
  const repository = new ObsidianTaskRepository(app, {
    codec: new TaskMarkdownCodec(catalog),
    editor,
    locator,
    snapshotsFromContent: (path, content) => index.snapshotsFromContent(path, content),
  });
  const root = expectDefined(index.snapshotsFromContent('tasks.md', source)[0]);
  const read = async () => {
    const file = app.vault.getAbstractFileByPath('tasks.md');
    if (!(file instanceof TFile)) throw new Error('missing file');
    return app.vault.cachedRead(file);
  };
  return { repository, root, read };
}

describe('status repository contract', () => {
  it.each([
    ['t', undefined],
    ['!', undefined],
    ['d', '✅'],
    ['c', '❌'],
  ] as const)('applies configured status %s atomically', async (symbol, stampMarker) => {
    const h = await setup('- [?] task 🆔 keep ⛔ dep ^block');
    const result = await h.repository.edit({
      type: 'set-status',
      target: { type: 'task', ref: h.root.ref },
      symbol,
      ...(stampMarker === undefined ? {} : { stamp: localDate('2026-07-14') }),
    });
    expect(result).toMatchObject({ type: 'committed', changed: true });
    const content = await h.read();
    expect(content).toContain(`- [${symbol}] task`);
    if (stampMarker !== undefined) expect(content).toContain(`${stampMarker} 2026-07-14`);
    expect(content).toContain('🆔 keep ⛔ dep');
    expect(content).toContain('^block');
  });

  it('reopens by removing both completion and cancellation stamps', async () => {
    const h = await setup('- [d] task ✅ 2026-07-01 ❌ 2026-07-02 custom');
    await h.repository.edit({
      type: 'set-status',
      target: { type: 'task', ref: h.root.ref },
      symbol: 't',
    });
    expect(await h.read()).toBe('- [t] task custom');
  });

  it.each([
    ['d', 'z', '✅ 2026-07-01'],
    ['c', 'k', '❌ 2026-07-01'],
  ] as const)('preserves the existing stamp across same-type %s → %s', async (from, to, stamp) => {
    const h = await setup(`- [${from}] task ${stamp} custom`);
    await expect(
      h.repository.edit({
        type: 'set-status',
        target: { type: 'task', ref: h.root.ref },
        symbol: to,
      }),
    ).resolves.toMatchObject({ type: 'committed', changed: true });
    expect(await h.read()).toBe(`- [${to}] task ${stamp} custom`);
  });

  it('edits an exactly referenced nested task and returns the updated root', async () => {
    const h = await setup('- [t] root\n  - [t] child\n    - [t] nested');
    const nested = expectDefined(expectDefined(h.root.subtasks[0]).subtasks[0]);
    const result = await h.repository.edit({
      type: 'set-status',
      target: { type: 'subtask', ref: nested.ref },
      symbol: 'd',
      stamp: localDate('2026-07-14'),
    });
    expect(result).toMatchObject({
      type: 'committed',
      changed: true,
      outcome: { type: 'task', task: { subtasks: [{ subtasks: [{ status: 'done' }] }] } },
    });
    expect(await h.read()).toContain('    - [d] nested ✅ 2026-07-14');
  });

  it('returns unchanged for reselecting a status and stale conflict after a real change', async () => {
    const h = await setup('- [d] task ✅ 2026-07-01');
    await expect(
      h.repository.edit({
        type: 'set-status',
        target: { type: 'task', ref: h.root.ref },
        symbol: 'd',
      }),
    ).resolves.toMatchObject({ type: 'committed', changed: false });
    await h.repository.edit({
      type: 'set-status',
      target: { type: 'task', ref: h.root.ref },
      symbol: 't',
    });
    await expect(
      h.repository.edit({
        type: 'set-status',
        target: { type: 'task', ref: h.root.ref },
        symbol: '!',
      }),
    ).resolves.toMatchObject({ type: 'conflict', current: { statusSymbol: 't' } });
  });
});

async function liveCatalogHarness(mutableType: 'in-progress' | 'done' = 'in-progress') {
  const app = await createAppWithFiles({ 'tasks.md': '- [w] task ✅ 2026-07-01' });
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.taskStatuses = [
    { id: 'todo', symbol: 't', name: 'Todo', type: 'todo', icon: '', core: true },
    {
      id: 'mutable',
      symbol: 'w',
      name: 'Waiting',
      type: mutableType,
      icon: '',
      core: false,
    },
    { id: 'done', symbol: 'd', name: 'Done', type: 'done', icon: '', core: true },
    { id: 'done-alt', symbol: 'z', name: 'Done alt', type: 'done', icon: '', core: false },
  ];
  const liveCatalog = new StatusCatalog(toStatusRules(settings.taskStatuses));
  const index = new TaskIndex(app, {
    statusCatalog: liveCatalog,
    dailyNoteFormat: settings.desktop.dailyNoteFormat,
  });
  await index.initialize();
  const indexed = expectDefined(index.list()[0]);
  const clock = { today: vi.fn(() => localDate('2026-07-14')) };
  const edit = vi.fn<TaskRepository['edit']>().mockResolvedValue({
    type: 'committed',
    outcome: { type: 'task', task: indexed },
    changed: true,
  });
  const application = new TaskApplicationService(
    index,
    {
      edit,
      editBatch: vi.fn(),
      createDependencySubtask: vi.fn(),
      completeRecurrence: vi.fn(),
      create: vi.fn(),
      move: vi.fn(),
    },
    liveCatalog,
    clock,
  );
  const rebuildAsDone = () => {
    settings.taskStatuses = settings.taskStatuses.map((status) =>
      status.symbol === 'w' ? { ...status, type: 'done' as const } : status,
    );
    liveCatalog.replace(toStatusRules(settings.taskStatuses));
    index.setStatusCatalog(liveCatalog);
  };
  const rebuildWithoutMutable = () => {
    settings.taskStatuses = settings.taskStatuses.filter((status) => status.symbol !== 'w');
    liveCatalog.replace(toStatusRules(settings.taskStatuses));
    index.setStatusCatalog(liveCatalog);
  };
  return {
    application,
    clock,
    edit,
    index,
    indexed,
    rebuildAsDone,
    rebuildWithoutMutable,
  };
}

describe('live status catalog transitions', () => {
  it.each([
    ['toggle-completion', 't'],
    ['set-status', 'z'],
  ] as const)(
    'uses the rebuilt semantic type for an indexed %s without waiting for a file event',
    async (operation, expectedSymbol) => {
      const h = await liveCatalogHarness();
      expect(h.indexed.status).toBe('in-progress');
      h.rebuildAsDone();
      expect(h.index.resolve(h.indexed.ref)).toMatchObject({
        type: 'exact',
        task: { status: 'in-progress', statusSymbol: 'w' },
      });
      h.clock.today.mockClear();

      await h.application.execute(
        operation === 'toggle-completion'
          ? { type: operation, target: { type: 'task', ref: h.indexed.ref } }
          : { type: operation, target: { type: 'task', ref: h.indexed.ref }, symbol: 'z' },
      );

      expect(h.clock.today).toHaveBeenCalledOnce();
      expect(h.edit).toHaveBeenCalledWith({
        type: 'set-status',
        target: { type: 'task', ref: h.indexed.ref },
        symbol: expectedSymbol,
        ...(operation === 'set-status' && { addCompletionDate: true }),
      });
    },
  );

  it('uses the rebuilt semantic type for a recent outcome while the index still has the old ref', async () => {
    const h = await liveCatalogHarness();
    const fresh = { ...h.indexed, ref: { ...h.indexed.ref, revision: 'fresh-before-rebuild' } };
    h.edit.mockResolvedValueOnce({
      type: 'committed',
      outcome: { type: 'task', task: fresh },
      changed: true,
    });
    const first = await h.application.execute({
      type: 'patch',
      target: { type: 'task', ref: h.indexed.ref },
      patch: { priority: { type: 'set', value: 'A' } },
    });
    if (first.type !== 'ok' || first.outcome.type !== 'task') throw new Error('missing outcome');
    h.rebuildAsDone();
    h.clock.today.mockClear();

    await h.application.execute({
      type: 'toggle-completion',
      target: { type: 'task', ref: first.outcome.task.ref },
    });

    expect(h.clock.today).toHaveBeenCalledOnce();
    expect(h.edit).toHaveBeenLastCalledWith({
      type: 'set-status',
      target: { type: 'task', ref: fresh.ref },
      symbol: 't',
    });
  });

  it.each([
    ['toggle-completion', 'd'],
    ['set-status', 'z'],
  ] as const)(
    'uses the live open fallback for an indexed symbol removed before %s',
    async (operation, expectedSymbol) => {
      const h = await liveCatalogHarness('done');
      expect(h.indexed).toMatchObject({ status: 'done', statusSymbol: 'w' });
      h.rebuildWithoutMutable();
      expect(h.index.resolve(h.indexed.ref)).toMatchObject({
        type: 'exact',
        task: { status: 'done', statusSymbol: 'w' },
      });
      h.clock.today.mockClear();

      await h.application.execute(
        operation === 'toggle-completion'
          ? { type: operation, target: { type: 'task', ref: h.indexed.ref } }
          : { type: operation, target: { type: 'task', ref: h.indexed.ref }, symbol: 'z' },
      );

      expect(h.clock.today).toHaveBeenCalledOnce();
      expect(h.edit).toHaveBeenCalledWith({
        type: 'set-status',
        target: { type: 'task', ref: h.indexed.ref },
        symbol: expectedSymbol,
        stamp: localDate('2026-07-14'),
        addCompletionDate: true,
      });
    },
  );
});
