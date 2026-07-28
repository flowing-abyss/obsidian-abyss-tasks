// eslint-disable-next-line no-restricted-imports, import/no-extraneous-dependencies
import moment from 'moment';
import { TFile, type App } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { CenterPanel } from '../src/panels/CenterPanel';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { toStatusRules } from '../src/settings/statusCatalogAdapter';
import { StatusRegistry } from '../src/status/StatusRegistry';
import type { TaskApplicationApi, TaskSnapshot } from '../src/tasks';
import { TaskApplicationService } from '../src/tasks/application/TaskApplicationService';
import { StatusCatalog } from '../src/tasks/domain/StatusCatalog';
import type { TaskRef } from '../src/tasks/domain/types';
import { TaskIndex } from '../src/tasks/infrastructure/TaskIndex';
import { TaskBlockEditor } from '../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { TaskLocator } from '../src/tasks/infrastructure/markdown/TaskLocator';
import { TaskMarkdownCodec } from '../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { ObsidianTaskRepository } from '../src/tasks/infrastructure/obsidian/ObsidianTaskRepository';
import { createAppWithFiles, makeStubStore, task, useRealMoment } from './helpers';

useRealMoment();

async function readMd(app: App, path: string): Promise<string> {
  const f = app.vault.getAbstractFileByPath(path);
  if (!(f instanceof TFile)) throw new Error(`${path} is not a TFile`);
  return app.vault.cachedRead(f);
}

function callPrivate<T>(panel: CenterPanel, method: string, ...args: unknown[]): T {
  const fn = (panel as unknown as Record<string, (...a: unknown[]) => T>)[method]!;
  return fn.call(panel, ...args);
}

async function makePanel(
  files: Record<string, string>,
  extraTasks: TaskSnapshot[] = [],
): Promise<{ panel: CenterPanel; app: App }> {
  const app = await createAppWithFiles(files);
  const statusCatalog = new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses));
  const index = new TaskIndex(app, {
    statusCatalog,
    dailyNoteFormat: DEFAULT_SETTINGS.desktop.dailyNoteFormat,
  });
  for (const current of extraTasks) {
    const snapshot = index
      .snapshotsFromContent(current.source.filePath, files[current.source.filePath] ?? '')
      .find((candidate) => candidate.source.line === current.source.line);
    if (snapshot) Object.assign(current, { ref: snapshot.ref });
  }
  const state = new AppState();
  const store = makeStubStore(extraTasks, app);
  const snapshots = Object.entries(files).flatMap(([path, content]) =>
    index.snapshotsFromContent(path, content),
  );
  const queries: TaskApplicationApi['queries'] = {
    list: (query) =>
      snapshots.filter(
        (snapshot) => query?.filePath === undefined || snapshot.ref.filePath === query.filePath,
      ),
    forCalendarDates: () => snapshots,
    resolve: (ref) => {
      const found = snapshots.find(
        (snapshot) => snapshot.ref.filePath === ref.filePath && snapshot.ref.line === ref.line,
      );
      return found ? { type: 'exact', task: found } : { type: 'not-found', ref };
    },
    subscribe: () => () => {},
  };
  const repository = new ObsidianTaskRepository(app, {
    codec: new TaskMarkdownCodec(statusCatalog),
    editor: new TaskBlockEditor(),
    locator: new TaskLocator(),
    snapshotsFromContent: (path, content) => index.snapshotsFromContent(path, content),
  });
  const tasks = new TaskApplicationService(queries, repository, statusCatalog, {
    today: () => '2026-07-14' as never,
  });
  const panel = new CenterPanel(
    state,
    app,
    DEFAULT_SETTINGS,
    queries,
    new StatusRegistry(DEFAULT_SETTINGS.taskStatuses),
    undefined,
    null,
    null,
    tasks,
  );
  return { panel, app };
}

describe('CenterPanel planning API delegation', () => {
  it('sends reschedule through TaskApplicationApi without touching the vault directly', async () => {
    const app = await createAppWithFiles({ 'f.md': '- [ ] task\n' });
    const state = new AppState();
    const store = makeStubStore([], app);
    const queries = (store as unknown as { taskQueries: TaskApplicationApi['queries'] })
      .taskQueries;
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'not-found',
      target: { type: 'task', ref: { filePath: 'f.md', line: 0, revision: 'r' } },
    });
    const tasks: TaskApplicationApi = { queries, execute };
    const panel = new CenterPanel(
      state,
      app,
      DEFAULT_SETTINGS,
      queries,
      new StatusRegistry(DEFAULT_SETTINGS.taskStatuses),
      undefined,
      null,
      null,
      tasks,
    );
    const ref: TaskRef = { filePath: 'f.md', line: 0, revision: 'r' };
    const current = Object.assign(task({ source: { filePath: 'f.md', line: 0 } }), { ref });
    vi.spyOn(queries, 'list').mockReturnValue([
      {
        ref,
        title: 'task',
        markdownTitle: 'task',
        status: 'open',
        statusSymbol: ' ',
        priority: 'D',
        planning: {},
        tags: [],
        subtasks: [],
        comments: [],
        source: {
          filePath: 'f.md',
          line: 0,
          originalMarkdown: '- [ ] task',
          originalBlock: '- [ ] task',
        },
        presentation: { linkCount: 0 },
      },
    ]);
    const process = vi.spyOn(app.vault, 'process');

    await callPrivate(panel, 'rescheduleTask', 'f.md:::0', '2026-07-20');
    await callPrivate(panel, 'toggleDueToday', current);
    await callPrivate(panel, 'updateTaskStart', current, '2026-07-18');
    await callPrivate(panel, 'rescheduleTaskDue', current, '2026-07-22');
    await callPrivate(panel, 'setTaskDue', current, '2026-07-23');
    await callPrivate(panel, 'setTaskDue', current, null);

    expect(execute).toHaveBeenNthCalledWith(1, {
      type: 'reschedule',
      ref,
      date: '2026-07-20',
    });
    expect(execute).toHaveBeenNthCalledWith(2, {
      type: 'patch',
      target: { type: 'task', ref },
      patch: { due: { type: 'set', value: moment().format('YYYY-MM-DD') } },
    });
    expect(execute).toHaveBeenNthCalledWith(3, {
      type: 'set-span-boundary',
      ref,
      boundary: 'start',
      date: '2026-07-18',
    });
    expect(execute).toHaveBeenNthCalledWith(4, {
      type: 'set-span-boundary',
      ref,
      boundary: 'due',
      date: '2026-07-22',
    });
    expect(execute).toHaveBeenNthCalledWith(5, {
      type: 'patch',
      target: { type: 'task', ref },
      patch: { due: { type: 'set', value: '2026-07-23' } },
    });
    expect(execute).toHaveBeenNthCalledWith(6, {
      type: 'patch',
      target: { type: 'task', ref },
      patch: { due: { type: 'clear' } },
    });
    expect(process).not.toHaveBeenCalled();
  });

  it('routes every time/span gesture through one typed command without touching the vault', async () => {
    const app = await createAppWithFiles({
      'f.md': '- [ ] task 📅 2026-07-20 ⏰ 09:00 ⏱️ 1h\n',
    });
    const state = new AppState();
    const ref: TaskRef = { filePath: 'f.md', line: 0, revision: 'r' };
    const current = Object.assign(
      task({
        planning: { due: '2026-07-20', time: '09:00', duration: 60 },
        source: {
          filePath: 'f.md',
          line: 0,
          originalMarkdown: '- [ ] task 📅 2026-07-20 ⏰ 09:00 ⏱️ 1h',
          originalBlock: '- [ ] task 📅 2026-07-20 ⏰ 09:00 ⏱️ 1h',
        },
      }),
      { ref },
    );
    const store = makeStubStore([current], app);
    const queries = (store as unknown as { taskQueries: TaskApplicationApi['queries'] })
      .taskQueries;
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'not-found',
      target: { type: 'task', ref },
    });
    const panel = new CenterPanel(
      state,
      app,
      DEFAULT_SETTINGS,
      queries,
      new StatusRegistry(DEFAULT_SETTINGS.taskStatuses),
      undefined,
      null,
      null,
      { queries, execute },
    );
    vi.spyOn(queries, 'list').mockReturnValue([
      {
        ref,
        title: 'task',
        markdownTitle: 'task',
        status: 'open',
        statusSymbol: ' ',
        priority: 'D',
        planning: {
          start: '2026-07-18',
          due: '2026-07-20',
          time: '09:00',
          duration: 60,
        } as never,
        tags: [],
        subtasks: [],
        comments: [],
        source: {
          filePath: 'f.md',
          line: 0,
          originalMarkdown: '- [ ] task 📅 2026-07-20 ⏰ 09:00 ⏱️ 1h',
          originalBlock: '- [ ] task 📅 2026-07-20 ⏰ 09:00 ⏱️ 1h',
        },
        presentation: { linkCount: 0 },
      },
    ]);
    const process = vi.spyOn(app.vault, 'process');

    await callPrivate(panel, 'setTaskTimeFromDrop', 'f.md:::0', '2026-07-21', '10:15');
    await callPrivate(panel, 'updateTaskTime', current, 11 * 60 + 30);
    await callPrivate(panel, 'updateTaskDuration', current, 90);
    await callPrivate(panel, 'updateTaskStart', current, '2026-07-19');
    await callPrivate(panel, 'rescheduleTaskDue', current, '2026-07-22');
    await callPrivate(panel, 'extendTaskToSpan', current, '2026-07-23');
    await callPrivate(panel, 'rescheduleTask', 'f.md:::0', '2026-07-24');

    expect(execute.mock.calls.map(([command]) => command)).toEqual([
      {
        type: 'move-time-slot',
        ref,
        days: 1,
        time: '10:15',
      },
      {
        type: 'patch',
        target: { type: 'task', ref },
        patch: { time: { type: 'set', value: '11:30' } },
      },
      {
        type: 'patch',
        target: { type: 'task', ref },
        patch: { duration: { type: 'set', value: 90 } },
      },
      {
        type: 'set-span-boundary',
        ref,
        boundary: 'start',
        date: '2026-07-19',
      },
      {
        type: 'set-span-boundary',
        ref,
        boundary: 'due',
        date: '2026-07-22',
      },
      { type: 'extend-span', ref, due: '2026-07-23' },
      { type: 'move-to-all-day', ref, days: 4 },
    ]);
    expect(execute).toHaveBeenCalledTimes(7);
    expect(process).not.toHaveBeenCalled();
  });
});

describe('CenterPanel root lifecycle API delegation', () => {
  it('creates configured and project tasks through typed commands without direct vault writes', async () => {
    const app = await createAppWithFiles({ 'Projects/A.md': '# Project\n' });
    const state = new AppState();
    const store = makeStubStore([], app);
    const queries = (store as unknown as { taskQueries: TaskApplicationApi['queries'] })
      .taskQueries;
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'invalid',
      issues: [{ code: 'invalid-target' }],
    });
    const panel = new CenterPanel(
      state,
      app,
      DEFAULT_SETTINGS,
      queries,
      new StatusRegistry(DEFAULT_SETTINGS.taskStatuses),
      undefined,
      null,
      null,
      { queries, execute },
    );
    const process = vi.spyOn(app.vault, 'process');

    state.set('selectedList', 'today');
    await callPrivate(panel, 'createTask', 'buy milk');
    expect(execute).toHaveBeenLastCalledWith({
      type: 'create',
      destination: { type: 'configured-default' },
      markdownBody: '#task/one-off buy milk',
      initial: { due: { type: 'set', value: expect.any(String) } },
    });

    state.set('selectedList', { type: 'project', path: 'Projects/A.md' });
    await callPrivate(panel, 'createTask', 'project task');
    expect(execute).toHaveBeenLastCalledWith({
      type: 'create',
      destination: {
        type: 'explicit',
        destination: { filePath: 'Projects/A.md', insertion: { type: 'append' } },
      },
      markdownBody: 'project task',
    });
    expect(process).not.toHaveBeenCalled();
  });

  it.each([
    ['missing custom path', {}, 'Capture', 'Capture.md'],
    ['custom path with extension', {}, 'Capture.md', 'Capture.md'],
    ['existing extensionless custom file', { Capture: '' }, 'Capture', 'Capture'],
    ['existing custom Markdown file', { 'Capture.md': '' }, 'Capture', 'Capture.md'],
    ['missing default inbox', {}, '', 'Inbox.md'],
  ])(
    'requests provider preparation for $name using legacy path resolution',
    async (_name, files, customFilePath, filePath) => {
      const app = await createAppWithFiles(files);
      const state = new AppState();
      state.set('selectedList', 'inbox');
      const store = makeStubStore([], app);
      const queries = (store as unknown as { taskQueries: TaskApplicationApi['queries'] })
        .taskQueries;
      const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
        type: 'invalid',
        issues: [{ code: 'destination-unavailable', field: 'destination' }],
      });
      const panel = new CenterPanel(
        state,
        app,
        { ...DEFAULT_SETTINGS, addToToday: false, customFilePath },
        queries,
        new StatusRegistry(DEFAULT_SETTINGS.taskStatuses),
        undefined,
        null,
        null,
        { queries, execute },
      );

      await callPrivate(panel, 'createTask', 'captured');

      expect(execute).toHaveBeenCalledWith({
        type: 'create',
        destination: {
          type: 'explicit',
          destination: { filePath, insertion: { type: 'append' } },
          provision: 'if-missing',
        },
        markdownBody: `captured ${DEFAULT_SETTINGS.inbox.tag}`,
      });
    },
  );

  it('does not clear a newly selected task when an earlier deletion resolves late', async () => {
    const app = await createAppWithFiles({ 'f.md': '- [ ] old\n- [ ] new\n' });
    const oldRef: TaskRef = { filePath: 'f.md', line: 0, revision: 'old' };
    const oldTask = Object.assign(task({ title: 'old', source: { filePath: 'f.md', line: 0 } }), {
      ref: oldRef,
    });
    const newTask = task({ title: 'new', source: { filePath: 'f.md', line: 1 } });
    const state = new AppState();
    state.set('taskStack', [oldTask]);
    const store = makeStubStore([oldTask, newTask], app);
    const queries = (store as unknown as { taskQueries: TaskApplicationApi['queries'] })
      .taskQueries;
    let finish!: (result: Awaited<ReturnType<TaskApplicationApi['execute']>>) => void;
    const execute = vi
      .fn<TaskApplicationApi['execute']>()
      .mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const panel = new CenterPanel(
      state,
      app,
      DEFAULT_SETTINGS,
      queries,
      new StatusRegistry(DEFAULT_SETTINGS.taskStatuses),
      undefined,
      null,
      null,
      { queries, execute },
    );

    const pending = callPrivate<Promise<void>>(panel, 'deleteTask', oldTask);
    expect(execute).toHaveBeenCalledWith({ type: 'delete', ref: oldRef });
    state.set('taskStack', [newTask]);
    finish({ type: 'ok', outcome: { type: 'deleted', ref: oldRef }, changed: true });
    await pending;

    expect(state.get('taskStack')).toEqual([newTask]);
  });
});

describe('CenterPanel.setPriority', () => {
  it('adds priority emoji when task has none', async () => {
    const t = task({
      priority: 'D',
      source: {
        filePath: 'n.md',
        line: 0,
        originalMarkdown: '- [ ] Task',
        originalBlock: '- [ ] Task',
      },
    });
    const { panel, app } = await makePanel({ 'n.md': '- [ ] Task\n' }, [t]);
    await callPrivate(panel, 'setPriority', t, 'A');
    const content = await readMd(app, 'n.md');
    expect(content).toContain('🔺');
  });

  it('removes all priority emojis when D (normal) is selected', async () => {
    const raw = '- [ ] Task 🔺';
    const t = task({
      priority: 'A',
      source: { filePath: 'n.md', line: 0, originalMarkdown: raw, originalBlock: raw },
    });
    const { panel, app } = await makePanel({ 'n.md': `${raw}\n` }, [t]);
    await callPrivate(panel, 'setPriority', t, 'D');
    const content = await readMd(app, 'n.md');
    expect(content).not.toMatch(/[🔺⏫🔼🔽⏬]/u);
  });

  it('replaces existing priority with new one', async () => {
    const raw = '- [ ] Task ⏫';
    const t = task({
      priority: 'B',
      source: { filePath: 'n.md', line: 0, originalMarkdown: raw, originalBlock: raw },
    });
    const { panel, app } = await makePanel({ 'n.md': `${raw}\n` }, [t]);
    await callPrivate(panel, 'setPriority', t, 'C');
    const content = await readMd(app, 'n.md');
    expect(content).toContain('🔼');
    expect(content).not.toContain('⏫');
  });
});

describe('CenterPanel.rescheduleTask anchor priority', () => {
  it('moves scheduled date when both scheduled and due are set (scheduled wins)', async () => {
    const raw = '- [ ] t ⏳ 2026-07-02 📅 2026-07-10';
    const t = task({
      planning: { scheduled: '2026-07-02', due: '2026-07-10' },
      source: { filePath: 'f.md', line: 0, originalMarkdown: raw, originalBlock: raw },
    });
    const { panel, app } = await makePanel({ 'f.md': `${raw}\n` }, [t]);
    await callPrivate(panel, 'rescheduleTask', 'f.md:::0', '2026-07-03');
    const content = await readMd(app, 'f.md');
    expect(content).toContain('⏳ 2026-07-03');
    expect(content).toContain('📅 2026-07-10'); // due untouched
  });

  it('moves due date when only due is set', async () => {
    const raw = '- [ ] t 📅 2026-07-10';
    const t = task({
      planning: { due: '2026-07-10' },
      source: { filePath: 'f.md', line: 0, originalMarkdown: raw, originalBlock: raw },
    });
    const { panel, app } = await makePanel({ 'f.md': `${raw}\n` }, [t]);
    await callPrivate(panel, 'rescheduleTask', 'f.md:::0', '2026-07-11');
    const content = await readMd(app, 'f.md');
    expect(content).toContain('📅 2026-07-11');
  });

  it('adds a new due date when neither is set', async () => {
    const raw = '- [ ] t';
    const t = task({
      source: { filePath: 'f.md', line: 0, originalMarkdown: raw, originalBlock: raw },
    });
    const { panel, app } = await makePanel({ 'f.md': `${raw}\n` }, [t]);
    await callPrivate(panel, 'rescheduleTask', 'f.md:::0', '2026-07-12');
    const content = await readMd(app, 'f.md');
    expect(content).toContain('📅 2026-07-12');
  });
});

describe('CenterPanel.extendTaskToSpan', () => {
  it('freezes the original due as the new start and writes the new due, in one mutation', async () => {
    const raw = '- [ ] t 📅 2026-07-10';
    const t = task({
      planning: { due: '2026-07-10' },
      source: { filePath: 'f.md', line: 0, originalMarkdown: raw, originalBlock: raw },
    });
    const { panel, app } = await makePanel({ 'f.md': `${raw}\n` }, [t]);
    await callPrivate(panel, 'extendTaskToSpan', t, '2026-07-12');
    const content = await readMd(app, 'f.md');
    expect(content).toContain('🛫 2026-07-10');
    expect(content).toContain('📅 2026-07-12');
    expect(content).not.toContain('📅 2026-07-10');
  });

  it('extends a scheduled-only task (Bug A regression: used to silently no-op since it required task.due)', async () => {
    const raw = '- [ ] t ⏳ 2026-07-10';
    const t = task({
      planning: { scheduled: '2026-07-10' },
      source: { filePath: 'f.md', line: 0, originalMarkdown: raw, originalBlock: raw },
    });
    const { panel, app } = await makePanel({ 'f.md': `${raw}\n` }, [t]);
    await callPrivate(panel, 'extendTaskToSpan', t, '2026-07-12');
    const content = await readMd(app, 'f.md');
    // The original scheduled anchor freezes as start; the new date is written as due (a
    // due-centric span is always anchored by `due` once created — see bucketTasksForDate).
    expect(content).toContain('🛫 2026-07-10');
    expect(content).toContain('📅 2026-07-12');
    expect(content).toContain('⏳ 2026-07-10'); // scheduled itself stays untouched
  });

  it('freezes `scheduled` (not `due`) as the new start for a "deadline" task with distinct scheduled+due, keeping the resulting span non-reversed', async () => {
    // Interactive-CLI-verified regression: an earlier version of this fix froze `due` as start
    // here (`task.due ?? task.scheduled`), which — combined with the keyboard handler's own
    // scheduled-first date computation (Bug B fix) — produced an invalid reversed span (start
    // AFTER due) for exactly this task shape. `task.scheduled ?? task.due` (matching
    // bucketTasksForDate's own anchor priority) keeps the frozen start consistent with whichever
    // date the caller actually computed the new due from.
    const raw = '- [ ] t ⏳ 2026-07-12 📅 2026-07-17';
    const t = task({
      planning: { scheduled: '2026-07-12', due: '2026-07-17' },
      source: { filePath: 'f.md', line: 0, originalMarkdown: raw, originalBlock: raw },
    });
    const { panel, app } = await makePanel({ 'f.md': `${raw}\n` }, [t]);
    await callPrivate(panel, 'extendTaskToSpan', t, '2026-07-13');
    const content = await readMd(app, 'f.md');
    expect(content).toContain('🛫 2026-07-12');
    expect(content).toContain('📅 2026-07-13');
    expect(content).not.toContain('📅 2026-07-17');
    expect(content).toContain('⏳ 2026-07-12'); // scheduled itself stays untouched
  });

  it('re-extending an already-spanning task does not append a second 🛫 token', async () => {
    const raw = '- [ ] t 🛫 2026-07-08 📅 2026-07-10';
    const t = task({
      planning: { start: '2026-07-08', due: '2026-07-10' },
      source: { filePath: 'f.md', line: 0, originalMarkdown: raw, originalBlock: raw },
    });
    const { panel, app } = await makePanel({ 'f.md': `${raw}\n` }, [t]);
    await callPrivate(panel, 'extendTaskToSpan', t, '2026-07-12');
    const content = await readMd(app, 'f.md');
    expect(content.match(/🛫/gu)).toHaveLength(1);
    expect(content).toContain('🛫 2026-07-08');
    expect(content).toContain('📅 2026-07-12');
  });
});

describe('CenterPanel.setTaskTimeFromDrop', () => {
  it('adds both a new due date and a new time when neither is set (plain task dropped into hour grid)', async () => {
    const raw = '- [ ] t';
    const t = task({
      source: { filePath: 'f.md', line: 0, originalMarkdown: raw, originalBlock: raw },
    });
    const { panel, app } = await makePanel({ 'f.md': `${raw}\n` }, [t]);
    await callPrivate(panel, 'setTaskTimeFromDrop', 'f.md:::0', '2026-07-12', '14:30');
    const content = await readMd(app, 'f.md');
    expect(content).toContain('📅 2026-07-12');
    expect(content).toContain('⏰ 14:30');
  });

  it('writes the scheduled date (not due) when the task already has a scheduled date (scheduled wins)', async () => {
    const raw = '- [ ] t ⏳ 2026-07-02';
    const t = task({
      planning: { scheduled: '2026-07-02' },
      source: { filePath: 'f.md', line: 0, originalMarkdown: raw, originalBlock: raw },
    });
    const { panel, app } = await makePanel({ 'f.md': `${raw}\n` }, [t]);
    await callPrivate(panel, 'setTaskTimeFromDrop', 'f.md:::0', '2026-07-03', '09:00');
    const content = await readMd(app, 'f.md');
    expect(content).toContain('⏳ 2026-07-03');
    expect(content).toContain('⏰ 09:00');
  });

  it('replaces an existing time rather than duplicating the emoji', async () => {
    const raw = '- [ ] t 📅 2026-07-10 ⏰ 09:00';
    const t = task({
      planning: { due: '2026-07-10', time: '09:00' },
      source: { filePath: 'f.md', line: 0, originalMarkdown: raw, originalBlock: raw },
    });
    const { panel, app } = await makePanel({ 'f.md': `${raw}\n` }, [t]);
    await callPrivate(panel, 'setTaskTimeFromDrop', 'f.md:::0', '2026-07-10', '16:45');
    const content = await readMd(app, 'f.md');
    expect(content).toContain('⏰ 16:45');
    expect(content).not.toContain('⏰ 09:00');
    const matches = content.match(/⏰/gu);
    expect(matches).toHaveLength(1);
  });
});

describe('CenterPanel.updateTaskTime — Task 33 data-safety net (the disappearing-task regression)', () => {
  // This is the exact scenario reproduced live via Obsidian CLI: a Pointer-Events drag on a
  // timed block's body computed newStartMinutes = 2093*60+15 (an extreme delta — the pointer was
  // released far outside the visible grid). Before this task's fix, `updateTaskTime` wrote
  // "⏰ 2093:15" straight to the file: `formatTaskLine`'s own `\d{1,2}` time-token grammar cannot
  // match a 3-digit hour, so the token failed to round-trip on the very next parse — `time` came
  // back `undefined`, the task silently dropped out of `tasksWithTime` in every Day/Week view,
  // and the garbage "⏰ 2093:15" text leaked into the visible title instead of being stripped as
  // metadata. This test drives `updateTaskTime` with that exact out-of-range minute value
  // directly (bypassing the drag-gesture clamp added in renderTimedBlocks.ts, so this test would
  // still catch a regression even if that clamp were ever removed/loosened) and asserts the
  // mutation-service safety net rejects the write outright: the original line must be preserved
  // byte-for-byte, and the task must still be present, valid, and correctly timed afterward.
  it('rejects an out-of-range minutes value that would corrupt the ⏰ token, leaving the original line completely untouched', async () => {
    const raw = '- [ ] Drag test alpha ⏰ 10:00 ⏱️ 1h 📅 2026-07-11';
    const t = task({
      planning: { time: '10:00', duration: 60, due: '2026-07-11' },
      source: { filePath: 'f.md', line: 0, originalMarkdown: raw, originalBlock: raw },
    });
    const { panel, app } = await makePanel({ 'f.md': `${raw}\n` }, [t]);

    await callPrivate(panel, 'updateTaskTime', t, 2093 * 60 + 15);

    const content = await readMd(app, 'f.md');
    expect(content).toBe(`${raw}\n`);
    expect(content).toContain('⏰ 10:00');
    expect(content).not.toContain('2093');
  });

  it('still accepts an ordinary, in-range time change (the safety net does not over-reject valid drags)', async () => {
    const raw = '- [ ] Drag test alpha ⏰ 10:00 ⏱️ 1h 📅 2026-07-11';
    const t = task({
      planning: { time: '10:00', duration: 60, due: '2026-07-11' },
      source: { filePath: 'f.md', line: 0, originalMarkdown: raw, originalBlock: raw },
    });
    const { panel, app } = await makePanel({ 'f.md': `${raw}\n` }, [t]);

    await callPrivate(panel, 'updateTaskTime', t, 11 * 60 + 30);

    const content = await readMd(app, 'f.md');
    expect(content).toContain('⏰ 11:30');
    expect(content).not.toContain('⏰ 10:00');
  });
});

describe('CenterPanel timed vertical resize', () => {
  it('patches time and duration atomically while preserving unrelated Markdown byte-for-byte', async () => {
    const raw = '- [ ] Atomic **label** #work ⏰ 09:00 keep-this ⏱️ 1h 📅 2026-07-06 ^task-anchor';
    const current = task({
      title: 'Atomic **label** #work keep-this ^task-anchor',
      planning: { due: '2026-07-06', time: '09:00', duration: 60 },
      source: { filePath: 'f.md', line: 0, originalMarkdown: raw, originalBlock: raw },
    });
    const { panel, app } = await makePanel({ 'f.md': `${raw}\n` }, [current]);

    await callPrivate(panel, 'commitTimedDuration', current, {
      edge: 'start',
      startMinutes: 8 * 60 + 30,
      durationMinutes: 90,
      endMinutes: 10 * 60,
    });

    expect(await readMd(app, 'f.md')).toBe(
      '- [ ] Atomic **label** #work ⏰ 08:30 keep-this ⏱️ 1h30m 📅 2026-07-06 ^task-anchor\n',
    );
  });
});
