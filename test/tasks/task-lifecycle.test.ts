import type * as ObsidianModule from 'obsidian';
import type { App } from 'obsidian';
import { Notice, TFile } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { DailyNoteResolver } from '../../src/resolvers/DailyNoteResolver';
import { DEFAULT_SETTINGS } from '../../src/settings/defaults';
import { toStatusRules } from '../../src/settings/statusCatalogAdapter';
import type { CalendarSettings } from '../../src/settings/types';
import type {
  TaskDependencyQueryApi,
  TaskQueryApi,
} from '../../src/tasks/application/TaskApplicationApi';
import { TaskApplicationService } from '../../src/tasks/application/TaskApplicationService';
import type { TaskBehaviorSettingsProvider } from '../../src/tasks/application/TaskBehaviorSettings';
import type { TaskDestinationProvider } from '../../src/tasks/application/TaskDestinationProvider';
import type { TaskDraft, TaskRepository } from '../../src/tasks/application/TaskRepository';
import { StatusCatalog } from '../../src/tasks/domain/StatusCatalog';
import type { TaskDestination, TaskRef, TaskSnapshot } from '../../src/tasks/domain/types';
import { localDate } from '../../src/tasks/domain/validation';
import { TaskIndex } from '../../src/tasks/infrastructure/TaskIndex';
import { TaskBlockEditor } from '../../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { TaskLocator } from '../../src/tasks/infrastructure/markdown/TaskLocator';
import { TaskMarkdownCodec } from '../../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import {
  ObsidianTaskDestinationProvider,
  type ConfiguredTaskDestination,
} from '../../src/tasks/infrastructure/obsidian/ObsidianTaskDestinationProvider';
import { ObsidianTaskRepository } from '../../src/tasks/infrastructure/obsidian/ObsidianTaskRepository';
import { presentTaskCreationResult } from '../../src/ui/taskCommandResult';
import { createAppWithFiles, methodOf, taskQueryApi, useRealMoment } from '../helpers';
import { InMemoryTaskRepository } from '../support/InMemoryTaskRepository';
import { expectDefined } from './../helpers';

vi.mock('obsidian', async () => {
  const actual = await vi.importActual<typeof ObsidianModule>('obsidian');
  return { ...actual, Notice: vi.fn() };
});

type Adapter = 'in-memory' | 'obsidian';

useRealMoment();

interface Harness {
  readonly repository: TaskRepository;
  readonly snapshots: (content: string) => readonly TaskSnapshot[];
  readonly read: () => Promise<string>;
}

const path = 'tasks.md';
const appendDestination: TaskDestination = { filePath: path, insertion: { type: 'append' } };

type ApplicationResult = Awaited<ReturnType<TaskApplicationService['execute']>>;

function taskFrom(result: ApplicationResult, message: string): TaskSnapshot {
  if (result.type !== 'ok' || result.outcome.type !== 'task') throw new Error(message);
  return result.outcome.task;
}

function fileAt(app: App, filePath: string): TFile {
  const file = app.vault.getAbstractFileByPath(filePath);
  expect(file).toBeInstanceOf(TFile);
  if (!(file instanceof TFile)) throw new Error(`missing ${filePath}`);
  return file;
}

async function makeHarness(adapter: Adapter, source: string): Promise<Harness> {
  const app = await createAppWithFiles({ [path]: source });
  const catalog = new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses));
  const codec = new TaskMarkdownCodec(catalog);
  const index = new TaskIndex(app, {
    statusCatalog: catalog,
    dailyNoteFormat: DEFAULT_SETTINGS.desktop.dailyNoteFormat,
  });
  const snapshots = (content: string) => index.snapshotsFromContent(path, content);
  if (adapter === 'in-memory') {
    const repository = new InMemoryTaskRepository({
      files: { [path]: source },
      codec,
      snapshotsFromContent: (_path, content) => snapshots(content),
    });
    return { repository, snapshots, read: async () => repository.content(path) ?? '' };
  }
  const repository = new ObsidianTaskRepository(app, {
    codec,
    editor: new TaskBlockEditor(),
    locator: new TaskLocator(),
    snapshotsFromContent: (_path, content) => snapshots(content),
  });
  return {
    repository,
    snapshots,
    read: async () => {
      const file = app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) throw new Error('missing task file');
      return app.vault.cachedRead(file);
    },
  };
}

function applicationFor(app: App, settings: CalendarSettings) {
  const catalog = new StatusCatalog(toStatusRules(settings.taskStatuses));
  const codec = new TaskMarkdownCodec(catalog);
  const index = new TaskIndex(app, {
    statusCatalog: catalog,
    dailyNoteFormat: settings.desktop.dailyNoteFormat,
  });
  const repository = new ObsidianTaskRepository(app, {
    codec,
    editor: new TaskBlockEditor(),
    locator: new TaskLocator(),
    snapshotsFromContent: (filePath, content) => index.snapshotsFromContent(filePath, content),
  });
  const dailyNotes = new DailyNoteResolver(app, settings);
  const provider = new ObsidianTaskDestinationProvider(
    app,
    () => configuredDestination(settings),
    () => dailyNotes.planDailyNoteDestination(),
  );
  return new TaskApplicationService(
    index,
    repository,
    catalog,
    { today: () => localDate('2026-07-14') },
    provider,
  );
}

function configuredDestination(settings: CalendarSettings): ConfiguredTaskDestination {
  return {
    addToToday: settings.addToToday,
    customFilePath: settings.customFilePath,
    insertion:
      settings.taskInsertionMode === 'section' && settings.taskInsertionSection.trim().length > 0
        ? { type: 'section', heading: settings.taskInsertionSection }
        : { type: 'append' },
  };
}

function rootRef(harness: Harness, content: string, line = 0): TaskRef {
  const task = harness.snapshots(content).find((candidate) => candidate.source.line === line);
  if (task == null) throw new Error(`missing task at line ${line}`);
  return task.ref;
}

for (const adapter of ['in-memory', 'obsidian'] as const) {
  describe(`${adapter} root task lifecycle contract`, () => {
    it.each([
      {
        name: 'an empty destination',
        source: '',
        expected: '- [ ] new task 📅 2026-07-20',
      },
      {
        name: 'LF with a final newline',
        source: '# Tasks\n',
        expected: '# Tasks\n- [ ] new task 📅 2026-07-20\n',
      },
      {
        name: 'LF without a final newline',
        source: '# Tasks',
        expected: '# Tasks\n- [ ] new task 📅 2026-07-20',
      },
      {
        name: 'CRLF with a final newline',
        source: '# Tasks\r\n',
        expected: '# Tasks\r\n- [ ] new task 📅 2026-07-20\r\n',
      },
      {
        name: 'CRLF without a final newline',
        source: '# Tasks\r\nnotes',
        expected: '# Tasks\r\nnotes\r\n- [ ] new task 📅 2026-07-20',
      },
    ])(
      'appends losslessly for $name and returns the exact inserted snapshot',
      async ({ source, expected }) => {
        const harness = await makeHarness(adapter, source);
        const result = await harness.repository.create(appendDestination, {
          markdownBody: 'new task',
          initial: { due: { type: 'set', value: localDate('2026-07-20') } },
        });

        expect(result).toMatchObject({
          type: 'committed',
          changed: true,
          outcome: {
            type: 'task',
            task: {
              markdownTitle: 'new task',
              planning: { due: '2026-07-20' },
              source: { filePath: path },
            },
          },
        });
        expect(await harness.read()).toBe(expected);
        if (result.type === 'committed' && result.outcome.type === 'task') {
          const taskAt = expected.indexOf('- [ ] new task');
          expect(result.outcome.task.source.line).toBe(
            expected.slice(0, taskAt).split(/\r?\n/u).length - 1,
          );
        }
      },
    );

    it('inserts under an explicit section and preserves Tasks carriers without generating an ID', async () => {
      const source = '# Project\n\n## Tasks\n- [ ] existing\n\n## Notes\n';
      const harness = await makeHarness(adapter, source);
      const destination: TaskDestination = {
        filePath: path,
        insertion: { type: 'section', heading: '## Tasks' },
      };

      const result = await harness.repository.create(destination, {
        markdownBody: 'linked 🆔 existing-id ⛔ dep_1 ^keep',
      });

      expect(result).toMatchObject({
        type: 'committed',
        outcome: { type: 'task', task: { source: { filePath: path, line: 3 } } },
      });
      const content = await harness.read();
      expect(content).toContain(
        '## Tasks\n- [ ] linked 🆔 existing-id ⛔ dep_1 ^keep\n- [ ] existing',
      );
      expect(content).not.toMatch(/🆔 (?!existing-id)/u);
    });

    it('creates a missing section and returns the inserted duplicate by its known offset', async () => {
      const source = '# Project\n- [ ] duplicate\n';
      const harness = await makeHarness(adapter, source);
      const destination: TaskDestination = {
        filePath: path,
        insertion: { type: 'section', heading: '## Tasks' },
      };

      const result = await harness.repository.create(destination, { markdownBody: 'duplicate' });

      expect(await harness.read()).toBe(
        '# Project\n- [ ] duplicate\n\n## Tasks\n- [ ] duplicate\n',
      );
      expect(result).toMatchObject({
        type: 'committed',
        outcome: { type: 'task', task: { source: { line: 4 } } },
      });
    });

    it('parses the body then replaces one initial field and rejects duplicate target fields atomically', async () => {
      const harness = await makeHarness(adapter, '- [ ] existing\n');

      await expect(
        harness.repository.create(appendDestination, {
          markdownBody: 'one due 📅 2026-07-19',
          initial: { due: { type: 'set', value: localDate('2026-07-20') } },
        }),
      ).resolves.toMatchObject({
        type: 'committed',
        outcome: { type: 'task', task: { planning: { due: '2026-07-20' } } },
      });

      const beforeDuplicate = await harness.read();
      await expect(
        harness.repository.create(appendDestination, {
          markdownBody: 'duplicate 📅 2026-07-18 📅 2026-07-19',
          initial: { due: { type: 'set', value: localDate('2026-07-20') } },
        }),
      ).resolves.toEqual({
        type: 'invalid',
        issues: [{ code: 'duplicate-field', field: 'due' }],
      });
      expect(await harness.read()).toBe(beforeDuplicate);
    });

    it('inserts one stamped task block and never writes an invalid second root', async () => {
      const harness = await makeHarness(adapter, '# Tasks\n');
      const draft: TaskDraft & { today: ReturnType<typeof localDate>; addCreatedDate: boolean } = {
        markdownBody: 'Parent\n  - [ ] Child',
        today: localDate('2026-08-01'),
        addCreatedDate: true,
      };

      await expect(harness.repository.create(appendDestination, draft)).resolves.toMatchObject({
        type: 'committed',
        outcome: {
          type: 'task',
          task: {
            planning: { created: '2026-08-01' },
            subtasks: [{ planning: { created: '2026-08-01' } }],
          },
        },
      });
      expect(await harness.read()).toBe(
        '# Tasks\n- [ ] Parent ➕ 2026-08-01\n  - [ ] Child ➕ 2026-08-01\n',
      );

      const before = await harness.read();
      await expect(
        harness.repository.create(appendDestination, {
          ...draft,
          markdownBody: 'Parent\n- [ ] Second root',
        }),
      ).resolves.toMatchObject({ type: 'invalid' });
      expect(await harness.read()).toBe(before);
    });

    it('deletes the exact confirmed root and its complete nested block', async () => {
      const source =
        '- [ ] root\n  - > description\n  - [ ] child\n    - [ ] descendant\n- [ ] keep\n';
      const harness = await makeHarness(adapter, source);
      const ref = rootRef(harness, source);

      await expect(harness.repository.edit({ type: 'delete', ref })).resolves.toEqual({
        type: 'committed',
        outcome: { type: 'deleted', ref },
        changed: true,
      });
      expect(await harness.read()).toBe('- [ ] keep\n');
    });

    it('never deletes a same-line replacement through a stale reference', async () => {
      const source = '- [ ] original\n- [ ] keep\n';
      const harness = await makeHarness(adapter, source);
      const stale = rootRef(harness, source);
      await harness.repository.edit({
        type: 'patch',
        target: { type: 'task', ref: stale },
        patch: { markdownTitle: { type: 'set', value: 'replacement' } },
      });
      const changed = await harness.read();

      await expect(harness.repository.edit({ type: 'delete', ref: stale })).resolves.toMatchObject({
        type: 'conflict',
        current: { markdownTitle: 'replacement' },
      });
      expect(await harness.read()).toBe(changed);
    });
  });
}

describe('TaskApplicationService lifecycle routing', () => {
  const queries: TaskQueryApi & TaskDependencyQueryApi = taskQueryApi();
  const catalog = new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses));
  const clock = { today: () => localDate('2026-07-14') };
  const committedTask = {
    ref: { filePath: path, line: 0, revision: 'created' },
    title: 'created',
    markdownTitle: 'created',
    status: 'open',
    statusSymbol: ' ',
    priority: 'D',
    onCompletion: 'keep' as const,
    onCompletionExplicit: false,
    planning: {},
    tags: [],
    dependsOn: [],
    subtasks: [],
    comments: [],
    source: {
      filePath: path,
      line: 0,
      originalMarkdown: '- [ ] created',
      originalBlock: '- [ ] created',
    },
    presentation: { linkCount: 0 },
  } satisfies TaskSnapshot;

  it('resolves only configured-default creation before delegating the exact draft', async () => {
    const create = vi.fn<TaskRepository['create']>().mockResolvedValue({
      type: 'committed',
      outcome: { type: 'task', task: committedTask },
      changed: true,
    });
    const edit = vi.fn<TaskRepository['edit']>();
    const destinationProvider: TaskDestinationProvider = {
      planConfiguredDefault: vi.fn(),
      planExplicit: vi.fn(),
      resolveConfiguredDefault: vi.fn().mockResolvedValue({
        type: 'resolved',
        destination: appendDestination,
      }),
      prepare: vi.fn().mockResolvedValue({ type: 'unavailable' }),
    };
    const application = new TaskApplicationService(
      queries,
      { edit, editBatch: vi.fn(), completeRecurrence: vi.fn(), create, move: vi.fn() },
      catalog,
      clock,
      destinationProvider,
    );
    const draft: TaskDraft = {
      markdownBody: 'created',
      initial: { due: { type: 'set', value: localDate('2026-07-20') } },
    };

    await expect(
      application.execute({
        type: 'create',
        destination: { type: 'configured-default' },
        ...draft,
      }),
    ).resolves.toEqual({
      type: 'ok',
      outcome: { type: 'task', task: committedTask },
      changed: true,
    });
    expect(methodOf(destinationProvider, 'resolveConfiguredDefault')).toHaveBeenCalledOnce();
    expect(methodOf(destinationProvider, 'prepare')).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(appendDestination, {
      ...draft,
      today: localDate('2026-07-14'),
      addCreatedDate: true,
    });
    expect(edit).not.toHaveBeenCalled();
  });

  it('passes an explicit destination through and reports unavailable configured defaults', async () => {
    const create = vi.fn<TaskRepository['create']>().mockResolvedValue({
      type: 'committed',
      outcome: { type: 'task', task: committedTask },
      changed: true,
    });
    const provider: TaskDestinationProvider = {
      planConfiguredDefault: vi.fn(),
      planExplicit: vi.fn(),
      resolveConfiguredDefault: vi.fn().mockResolvedValue({ type: 'unavailable' }),
      prepare: vi.fn().mockResolvedValue({
        type: 'resolved',
        destination: appendDestination,
      }),
    };
    const application = new TaskApplicationService(
      queries,
      { edit: vi.fn(), editBatch: vi.fn(), completeRecurrence: vi.fn(), create, move: vi.fn() },
      catalog,
      clock,
      provider,
    );

    await application.execute({
      type: 'create',
      destination: { type: 'explicit', destination: appendDestination },
      markdownBody: 'explicit',
    });
    expect(methodOf(provider, 'resolveConfiguredDefault')).not.toHaveBeenCalled();
    expect(methodOf(provider, 'prepare')).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(appendDestination, {
      markdownBody: 'explicit',
      today: localDate('2026-07-14'),
      addCreatedDate: true,
    });

    create.mockClear();
    await application.execute({
      type: 'create',
      destination: {
        type: 'explicit',
        destination: appendDestination,
        provision: 'if-missing',
      },
      markdownBody: 'prepared',
    });
    expect(methodOf(provider, 'prepare')).toHaveBeenCalledWith(appendDestination);
    expect(create).toHaveBeenCalledWith(appendDestination, {
      markdownBody: 'prepared',
      today: localDate('2026-07-14'),
      addCreatedDate: true,
    });

    await expect(
      application.execute({
        type: 'create',
        destination: { type: 'configured-default' },
        markdownBody: 'missing',
      }),
    ).resolves.toEqual({
      type: 'invalid',
      issues: [{ code: 'destination-unavailable', field: 'destination' }],
    });
  });

  it('normalizes and validates initial tags before creation', async () => {
    const create = vi.fn<TaskRepository['create']>().mockResolvedValue({
      type: 'committed',
      outcome: { type: 'task', task: committedTask },
      changed: true,
    });
    const application = new TaskApplicationService(
      queries,
      { edit: vi.fn(), editBatch: vi.fn(), completeRecurrence: vi.fn(), create, move: vi.fn() },
      catalog,
      clock,
    );

    await application.execute({
      type: 'create',
      destination: { type: 'explicit', destination: appendDestination },
      markdownBody: 'tagged',
      initial: { tags: { add: ['work', '#work'], remove: ['later'] } },
    });
    expect(create).toHaveBeenCalledWith(appendDestination, {
      markdownBody: 'tagged',
      initial: { tags: { add: ['#work'], remove: ['#later'] } },
      today: localDate('2026-07-14'),
      addCreatedDate: true,
    });

    create.mockClear();
    await expect(
      application.execute({
        type: 'create',
        destination: { type: 'explicit', destination: appendDestination },
        markdownBody: 'bad tags',
        initial: { tags: { add: ['bad tag'] } },
      }),
    ).resolves.toEqual({
      type: 'invalid',
      issues: [{ code: 'invalid-target', field: 'tags' }],
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('preserves legacy destination-error precedence over invalid initial tags', async () => {
    const create = vi.fn<TaskRepository['create']>();
    const destinationProvider = {
      planConfiguredDefault: vi.fn(),
      planExplicit: vi.fn(),
      resolveConfiguredDefault: vi.fn().mockResolvedValue({ type: 'unavailable' as const }),
      prepare: vi.fn(),
    } satisfies TaskDestinationProvider;
    const application = new TaskApplicationService(
      queries,
      { edit: vi.fn(), editBatch: vi.fn(), completeRecurrence: vi.fn(), create, move: vi.fn() },
      catalog,
      clock,
      destinationProvider,
    );

    await expect(
      application.execute({
        type: 'create',
        destination: { type: 'configured-default' },
        markdownBody: 'invalid tag target',
        initial: { tags: { add: ['bad tag'] } },
      }),
    ).resolves.toEqual({
      type: 'invalid',
      issues: [{ code: 'destination-unavailable', field: 'destination' }],
    });
    expect(destinationProvider.resolveConfiguredDefault).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
  });

  it('plans without provisioning and freezes clock, behavior, and preparation once per session', async () => {
    const create = vi.fn<TaskRepository['create']>().mockResolvedValue({
      type: 'committed',
      outcome: { type: 'task', task: committedTask },
      changed: true,
    });
    const prepare = vi.fn().mockResolvedValue({
      type: 'resolved' as const,
      destination: appendDestination,
    });
    const destinationProvider = {
      planConfiguredDefault: vi.fn().mockResolvedValue({
        destination: appendDestination,
        prepare,
      }),
      planExplicit: vi.fn(),
      resolveConfiguredDefault: vi.fn(),
      prepare: vi.fn(),
    } satisfies TaskDestinationProvider;
    let today = localDate('2026-07-14');
    let addCreatedDate = true;
    const clock = vi.fn(() => today);
    const behavior = vi.fn<TaskBehaviorSettingsProvider>(() => ({
      taskLifecycle: { addCreatedDate, addCompletionDate: true },
      recurrence: { newOccurrencePlacement: 'before', removeScheduledDate: false },
    }));
    const application = new TaskApplicationService(
      queries,
      { edit: vi.fn(), editBatch: vi.fn(), completeRecurrence: vi.fn(), create, move: vi.fn() },
      catalog,
      { today: clock },
      destinationProvider,
      behavior,
    );

    const session = await application.planCreate({ type: 'configured-default' });

    expect(session).toMatchObject({ type: 'ready', destination: appendDestination });
    expect(destinationProvider.planConfiguredDefault).toHaveBeenCalledOnce();
    expect(prepare).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(clock).toHaveBeenCalledOnce();
    expect(behavior).toHaveBeenCalledOnce();

    today = localDate('2026-08-22');
    addCreatedDate = false;
    await session.execute({ markdownBody: 'first planned task' });
    await session.execute({ markdownBody: 'second planned task' });

    expect(prepare).toHaveBeenCalledOnce();
    expect(create).toHaveBeenNthCalledWith(1, appendDestination, {
      markdownBody: 'first planned task',
      today: localDate('2026-07-14'),
      addCreatedDate: true,
    });
    expect(create).toHaveBeenNthCalledWith(2, appendDestination, {
      markdownBody: 'second planned task',
      today: localDate('2026-07-14'),
      addCreatedDate: true,
    });
    expect(clock).toHaveBeenCalledOnce();
    expect(behavior).toHaveBeenCalledOnce();
  });

  it('returns a frozen executable unavailable session without repository writes', async () => {
    const create = vi.fn<TaskRepository['create']>();
    const destinationProvider = {
      planConfiguredDefault: vi.fn().mockResolvedValue(undefined),
      planExplicit: vi.fn(),
      resolveConfiguredDefault: vi.fn(),
      prepare: vi.fn(),
    } satisfies TaskDestinationProvider;
    const application = new TaskApplicationService(
      queries,
      { edit: vi.fn(), editBatch: vi.fn(), completeRecurrence: vi.fn(), create, move: vi.fn() },
      catalog,
      clock,
      destinationProvider,
    );

    const session = await application.planCreate({ type: 'configured-default' });

    expect(session.type).toBe('unavailable');
    await expect(session.execute({ markdownBody: 'preserve this draft' })).resolves.toEqual({
      type: 'invalid',
      issues: [{ code: 'destination-unavailable', field: 'destination' }],
    });
    expect(destinationProvider.planConfiguredDefault).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
  });
});

describe('TaskApplicationService lifecycle settings', () => {
  const queries: TaskQueryApi & TaskDependencyQueryApi = taskQueryApi();

  it('snapshots lifecycle settings once per command for root and subtask creation/completion dates', async () => {
    const harness = await makeHarness('in-memory', '');
    const catalog = new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses));
    const behavior: TaskBehaviorSettingsProvider = vi.fn<TaskBehaviorSettingsProvider>(() => ({
      taskLifecycle: { addCreatedDate: true, addCompletionDate: true },
      recurrence: { newOccurrencePlacement: 'before' as const, removeScheduledDate: false },
    }));
    const api = new TaskApplicationService(
      queries,
      harness.repository,
      catalog,
      { today: () => localDate('2026-08-01') },
      undefined,
      behavior,
    );

    const created = await api.execute({
      type: 'create',
      destination: { type: 'explicit', destination: appendDestination },
      markdownBody: 'Parent\n  - [ ] Child',
    });
    expect(await harness.read()).toBe('- [ ] Parent ➕ 2026-08-01\n  - [ ] Child ➕ 2026-08-01');
    expect(behavior).toHaveBeenCalledOnce();
    const createdTask = taskFrom(created, 'task not created');

    const subtaskAdded = await api.execute({
      type: 'add-subtask',
      parent: { type: 'task', ref: createdTask.ref },
      text: 'Added later',
    });
    expect(await harness.read()).toBe(
      '- [ ] Parent ➕ 2026-08-01\n  - [ ] Child ➕ 2026-08-01\n  - [ ] Added later ➕ 2026-08-01',
    );
    const taskWithSubtask = taskFrom(subtaskAdded, 'subtask not added');

    const rootDone = await api.execute({
      type: 'set-status',
      target: { type: 'task', ref: taskWithSubtask.ref },
      symbol: 'x',
    });
    expect(rootDone).toMatchObject({
      type: 'ok',
      outcome: { type: 'task', task: { planning: { completion: '2026-08-01' } } },
    });
    expect(await harness.read()).toContain('- [x] Parent ➕ 2026-08-01 ✅ 2026-08-01');
    const completedRoot = taskFrom(rootDone, 'task not completed');

    const childDone = await api.execute({
      type: 'set-status',
      target: { type: 'subtask', ref: expectDefined(completedRoot.subtasks[0]).ref },
      symbol: 'x',
    });
    expect(childDone).toMatchObject({
      type: 'ok',
      outcome: { type: 'task' },
    });
    const completedChild = taskFrom(childDone, 'subtask not completed');
    expect(completedChild.subtasks[0]?.planning.completion).toBe('2026-08-01');

    const rootDoneAgain = await api.execute({
      type: 'set-status',
      target: { type: 'task', ref: completedChild.ref },
      symbol: 'x',
    });
    expect(rootDoneAgain).toMatchObject({
      type: 'ok',
      changed: false,
      outcome: { type: 'task', task: { planning: { completion: '2026-08-01' } } },
    });
    const unchangedRoot = taskFrom(rootDoneAgain, 'completed task not returned');

    const reopened = await api.execute({
      type: 'set-status',
      target: { type: 'task', ref: unchangedRoot.ref },
      symbol: ' ',
    });
    expect(reopened).toMatchObject({
      type: 'ok',
      outcome: { type: 'task', task: { planning: {} } },
    });
    expect((await harness.read()).split('\n')[0]).toBe('- [ ] Parent ➕ 2026-08-01');
    expect(behavior).toHaveBeenCalledTimes(6);
  });

  it('does not add creation or completion dates when lifecycle dates are disabled', async () => {
    const harness = await makeHarness('in-memory', '');
    const catalog = new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses));
    const api = new TaskApplicationService(
      queries,
      harness.repository,
      catalog,
      { today: () => localDate('2026-08-01') },
      undefined,
      () => ({
        taskLifecycle: { addCreatedDate: false, addCompletionDate: false },
        recurrence: { newOccurrencePlacement: 'before', removeScheduledDate: false },
      }),
    );

    const created = await api.execute({
      type: 'create',
      destination: { type: 'explicit', destination: appendDestination },
      markdownBody: 'No stamps',
    });
    if (created.type !== 'ok' || created.outcome.type !== 'task')
      throw new Error('task not created');
    await api.execute({
      type: 'set-status',
      target: { type: 'task', ref: created.outcome.task.ref },
      symbol: 'x',
    });

    expect(await harness.read()).toBe('- [x] No stamps');
  });
});

describe('ObsidianTaskDestinationProvider', () => {
  it('plans an existing explicit destination without creating it', async () => {
    const app = await createAppWithFiles({ 'existing.md': '# Existing\n' });
    const dailyNotes = new DailyNoteResolver(app, DEFAULT_SETTINGS);
    const provider = new ObsidianTaskDestinationProvider(
      app,
      () => configuredDestination(DEFAULT_SETTINGS),
      () => dailyNotes.planDailyNoteDestination(),
    );
    const create = vi.spyOn(app.vault, 'create');

    const plan = await provider.planExplicit({
      filePath: 'existing.md',
      insertion: { type: 'section', heading: '## Tasks' },
    });

    expect(plan.destination).toEqual({
      filePath: 'existing.md',
      insertion: { type: 'section', heading: '## Tasks' },
    });
    expect(create).not.toHaveBeenCalled();
    await expect(plan.prepare()).resolves.toEqual({
      type: 'resolved',
      destination: {
        filePath: 'existing.md',
        insertion: { type: 'section', heading: '## Tasks' },
      },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('creates and resolves a daily note without inserting task Markdown', async () => {
    const app = await createAppWithFiles({});
    (app as unknown as { plugins: unknown }).plugins = { getPlugin: () => null };
    (app as unknown as { internalPlugins: unknown }).internalPlugins = {
      getPluginById: () => null,
    };
    const settings = {
      ...DEFAULT_SETTINGS,
      addToToday: true,
      dailyNoteProvider: 'manual' as const,
      manualDailyNotePath: 'daily/YYYY-MM-DD',
      taskInsertionMode: 'section' as const,
      taskInsertionSection: '## Tasks',
    };
    const resolver = new DailyNoteResolver(app, settings);
    const provider = new ObsidianTaskDestinationProvider(
      app,
      () => configuredDestination(settings),
      () => resolver.planDailyNoteDestination(),
    );

    const result = await provider.resolveConfiguredDefault();

    expect(result).toMatchObject({
      type: 'resolved',
      destination: {
        insertion: { type: 'section', heading: '## Tasks' },
      },
    });
    if (result.type !== 'resolved') throw new Error('daily destination unavailable');
    expect(result.destination.filePath).toMatch(/^daily\/\d{4}-\d{2}-\d{2}\.md$/u);
    expect(await app.vault.cachedRead(fileAt(app, result.destination.filePath))).not.toContain(
      '- [ ]',
    );
  });

  it('creates an empty configured custom note and reports absent or failed destinations', async () => {
    const app = await createAppWithFiles({});
    let configured: ConfiguredTaskDestination = {
      addToToday: false,
      customFilePath: 'Inbox.md',
      insertion: { type: 'append' },
    };
    const custom = new ObsidianTaskDestinationProvider(
      app,
      () => configured,
      () => {
        throw new Error('daily plan not requested');
      },
    );
    const firstPlan = await custom.planConfiguredDefault();
    expect(firstPlan?.destination.filePath).toBe('Inbox.md');
    expect(firstPlan?.destination.insertion).not.toBe(configured.insertion);
    configured = {
      addToToday: false,
      customFilePath: 'Later.md',
      insertion: { type: 'section', heading: '## Tasks' },
    };
    expect((await custom.planConfiguredDefault())?.destination).toEqual({
      filePath: 'Later.md',
      insertion: { type: 'section', heading: '## Tasks' },
    });

    await expect(custom.resolveConfiguredDefault()).resolves.toEqual({
      type: 'resolved',
      destination: {
        filePath: 'Later.md',
        insertion: { type: 'section', heading: '## Tasks' },
      },
    });
    expect(app.vault.getAbstractFileByPath('Later.md')).toBeInstanceOf(TFile);

    const unavailableConfiguration: ConfiguredTaskDestination = {
      addToToday: false,
      customFilePath: '',
      insertion: { type: 'append' },
    };
    const unavailable = new ObsidianTaskDestinationProvider(
      app,
      () => unavailableConfiguration,
      () => {
        throw new Error('daily plan not requested');
      },
    );
    await expect(unavailable.resolveConfiguredDefault()).resolves.toEqual({
      type: 'unavailable',
    });

    const failedApp = await createAppWithFiles({});
    vi.spyOn(failedApp.vault, 'create').mockRejectedValue(new Error('disk full'));
    const failed = new ObsidianTaskDestinationProvider(
      failedApp,
      () => configured,
      () => {
        throw new Error('daily plan not requested');
      },
    );
    await expect(failed.resolveConfiguredDefault()).resolves.toEqual({ type: 'unavailable' });
  });

  it('reports thrown or rejected daily-note plans as unavailable', async () => {
    const app = await createAppWithFiles({});
    const configuration: ConfiguredTaskDestination = {
      addToToday: true,
      customFilePath: '',
      insertion: { type: 'append' },
    };
    const thrown = new ObsidianTaskDestinationProvider(
      app,
      () => configuration,
      () => {
        throw new Error('resolver failed');
      },
    );
    const rejected = new ObsidianTaskDestinationProvider(
      app,
      () => configuration,
      () => ({
        destination: { filePath: 'daily/today.md', insertion: { type: 'append' } },
        prepare: async () => await Promise.reject(new Error('provider failed')),
      }),
    );

    await expect(thrown.resolveConfiguredDefault()).resolves.toEqual({ type: 'unavailable' });
    await expect(rejected.resolveConfiguredDefault()).resolves.toEqual({ type: 'unavailable' });
  });
});

describe('configured destination end-to-end lifecycle', () => {
  it('executes a frozen daily-note session with exactly-once provisioning', async () => {
    const app = await createAppWithFiles({
      'templates/frozen.md': '# {{title}}\n\n## Frozen tasks\n',
      'templates/changed.md': '# Changed template\n',
    });
    (app as unknown as { plugins: unknown }).plugins = { getPlugin: () => null };
    const options = {
      folder: 'daily/frozen',
      format: 'YYYY-MM-DD',
      template: 'templates/frozen',
    };
    (app as unknown as { internalPlugins: unknown }).internalPlugins = {
      getPluginById: (id: string) =>
        id === 'daily-notes' ? { enabled: true, instance: { options } } : null,
    };
    const settings: CalendarSettings = {
      ...DEFAULT_SETTINGS,
      addToToday: true,
      dailyNoteProvider: 'core',
      taskInsertionMode: 'section',
      taskInsertionSection: '## Frozen tasks',
    };
    const application = applicationFor(app, settings);
    const create = vi.spyOn(app.vault, 'create');
    const createFolder = vi.spyOn(app.vault, 'createFolder');

    const session = await application.planCreate({ type: 'configured-default' });
    const today = window.moment().format('YYYY-MM-DD');

    expect(session).toMatchObject({
      type: 'ready',
      destination: {
        filePath: `daily/frozen/${today}.md`,
        insertion: { type: 'section', heading: '## Frozen tasks' },
      },
    });
    expect(create).not.toHaveBeenCalled();
    expect(createFolder).not.toHaveBeenCalled();

    options.folder = 'daily/changed';
    options.template = 'templates/changed';
    settings.taskInsertionMode = 'append';
    settings.taskInsertionSection = '## Changed tasks';
    await session.execute({ markdownBody: 'first frozen task' });
    await session.execute({ markdownBody: 'second frozen task' });

    expect(create).toHaveBeenCalledOnce();
    expect(createFolder).toHaveBeenCalledOnce();
    const content = await app.vault.cachedRead(fileAt(app, `daily/frozen/${today}.md`));
    expect(content).toContain(`# ${today}`);
    expect(content).toContain('## Frozen tasks\n- [ ] second frozen task');
    expect(content).toContain('- [ ] first frozen task');
    expect(content).not.toContain('Changed template');
    expect(app.vault.getAbstractFileByPath(`daily/changed/${today}.md`)).toBeNull();
  });

  it.each([
    {
      name: 'configured custom note',
      settings: { ...DEFAULT_SETTINGS, addToToday: false, customFilePath: 'Capture.md' },
      destination: { type: 'configured-default' } as const,
      path: 'Capture.md',
    },
    {
      name: 'provisioned Inbox note',
      settings: { ...DEFAULT_SETTINGS, addToToday: false, customFilePath: '' },
      destination: {
        type: 'explicit',
        destination: { filePath: 'Inbox.md', insertion: { type: 'append' } },
        provision: 'if-missing',
      } as const,
      path: 'Inbox.md',
    },
  ])('creates a missing $name before inserting through the repository', async (scenario) => {
    vi.mocked(Notice).mockClear();
    const app = await createAppWithFiles({});
    const application = applicationFor(app, scenario.settings);

    const result = await application.execute({
      type: 'create',
      destination: scenario.destination,
      markdownBody: 'first task',
    });

    expect(result).toMatchObject({
      type: 'ok',
      outcome: { type: 'task', task: { source: { filePath: scenario.path, line: 0 } } },
    });
    expect(await app.vault.cachedRead(fileAt(app, scenario.path))).toBe(
      '- [ ] first task ➕ 2026-07-14',
    );
    presentTaskCreationResult(result);
    expect(Notice).toHaveBeenCalledWith(`Task added to ${scenario.path}`);
  });

  it('creates a template-backed daily note and inserts through its section policy', async () => {
    vi.mocked(Notice).mockClear();
    const app = await createAppWithFiles({
      'template.md': '# {{title}}\n\n## Tasks\n\nDaily notes stay here.\n',
    });
    (app as unknown as { plugins: unknown }).plugins = { getPlugin: () => null };
    (app as unknown as { internalPlugins: unknown }).internalPlugins = {
      getPluginById: (id: string) =>
        id === 'daily-notes'
          ? {
              enabled: true,
              instance: {
                options: { folder: 'daily', format: 'YYYY-MM-DD', template: 'template' },
              },
            }
          : null,
    };
    const settings = {
      ...DEFAULT_SETTINGS,
      addToToday: true,
      dailyNoteProvider: 'core' as const,
      taskInsertionMode: 'section' as const,
      taskInsertionSection: '## Tasks',
    };
    const application = applicationFor(app, settings);
    const today = window.moment().format('YYYY-MM-DD');

    const result = await application.execute({
      type: 'create',
      destination: { type: 'configured-default' },
      markdownBody: 'planned task',
      initial: { due: { type: 'set', value: localDate('2026-07-20') } },
    });

    expect(result).toMatchObject({
      type: 'ok',
      outcome: {
        type: 'task',
        task: { source: { filePath: `daily/${today}.md`, line: 3 } },
      },
    });
    const content = await app.vault.cachedRead(fileAt(app, `daily/${today}.md`));
    expect(content).toContain(`# ${today}`);
    expect(content).toContain(`## Tasks\n- [ ] planned task ➕ 2026-07-14 📅 2026-07-20`);
    expect(content).toContain('Daily notes stay here.');
    expect(content.split(/\r?\n/u).filter((line) => /^- \[.\]/u.test(line))).toHaveLength(1);
    expect(content).not.toContain('🆔');
    presentTaskCreationResult(result);
    expect(Notice).toHaveBeenCalledWith(`Task added to ${today}.md`);
  });
});
