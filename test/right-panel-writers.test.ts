// eslint-disable-next-line no-restricted-imports, import/no-extraneous-dependencies
import moment from 'moment';
import { TFile, type App } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { RightPanel } from '../src/panels/RightPanel';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { toStatusRules } from '../src/settings/statusCatalogAdapter';
import type { CalendarSettings, TagGroup } from '../src/settings/types';
import type {
  SubtaskSnapshot,
  TaskApplicationApi,
  TaskCommandResult,
  TaskCommentSnapshot,
  TaskSnapshot,
} from '../src/tasks';
import { TaskApplicationService } from '../src/tasks/application/TaskApplicationService';
import { StatusCatalog } from '../src/tasks/domain/StatusCatalog';
import type { TaskRef } from '../src/tasks/domain/types';
import { TaskIndex } from '../src/tasks/infrastructure/TaskIndex';
import { TaskBlockEditor } from '../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { TaskLocator } from '../src/tasks/infrastructure/markdown/TaskLocator';
import { TaskMarkdownCodec } from '../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { ObsidianTaskRepository } from '../src/tasks/infrastructure/obsidian/ObsidianTaskRepository';
import { openInFile } from '../src/ui/taskNavigation';
import { rootTaskRef, taskNodeLine } from '../src/ui/taskSelection';
import {
  createAppWithFiles,
  flushMicrotasks,
  freshContainer,
  seedTaskCache,
  subtask,
  task,
  taskComment,
  testStatusRegistry,
  useRealMoment,
} from './helpers';

useRealMoment();

/**
 * Read a markdown file's current content via the vault. Throws if the path is
 * not a TFile so tests fail loudly when a write didn't happen.
 */
async function readMd(app: App, path: string): Promise<string> {
  const f = app.vault.getAbstractFileByPath(path);
  if (!(f instanceof TFile)) throw new Error(`${path} is not a TFile`);
  return app.vault.cachedRead(f);
}

/** Bracket-access helper to call private methods (preserves `this` binding). */
function call<T>(panel: RightPanel, method: string, ...args: unknown[]): T {
  const candidate = args[0];
  if (
    (method === 'toggleSubTask' ||
      method === 'updatePriority' ||
      method === 'setStatus' ||
      method === 'addTag' ||
      method === 'removeTag' ||
      method === 'updateTaskTitle' ||
      method === 'appendToTitle' ||
      method === 'updateDescription' ||
      method === 'addSubTask' ||
      method === 'addComment' ||
      method === 'updateComment' ||
      method === 'deleteComment' ||
      method === 'deleteTask') &&
    typeof candidate === 'object' &&
    candidate !== null
  ) {
    const taskLike = candidate as TaskSnapshot | SubtaskSnapshot;
    const roots = (panel as unknown as { tasks: TaskApplicationApi }).tasks.queries.list();
    let found: TaskSnapshot | SubtaskSnapshot | undefined;
    let foundRoot: TaskSnapshot | undefined;
    for (const root of roots) {
      const queue: Array<TaskSnapshot | SubtaskSnapshot> = [root];
      while (queue.length > 0) {
        const current = queue.shift()!;
        if (
          root.source.filePath === rootTaskRef(taskLike).filePath &&
          taskNodeLine(root, current) === absoluteFixtureLine(taskLike)
        ) {
          found = current;
          foundRoot = root;
          break;
        }
        queue.push(...current.subtasks);
      }
      if (found) break;
    }
    if (found && foundRoot) {
      Object.assign(candidate, { ref: found.ref });
      if ((method === 'updateComment' || method === 'deleteComment') && args[1]) {
        const staleComment = args[1] as TaskCommentSnapshot;
        const parentLine = taskNodeLine(foundRoot, found);
        const currentComment = found.comments.find(
          (comment) =>
            parentLine + comment.ref.relativeLine === parentLine + staleComment.ref.relativeLine &&
            comment.text === staleComment.text,
        );
        if (currentComment) Object.assign(staleComment, { ref: currentComment.ref });
      }
    }
  }
  const fn = (panel as unknown as Record<string, (...a: unknown[]) => T>)[method]!;
  return fn.call(panel, ...args);
}

function absoluteFixtureLine(taskLike: TaskSnapshot | SubtaskSnapshot): number {
  if ('source' in taskLike) return taskLike.source.line;
  let line = rootTaskRef(taskLike).line;
  let ref = taskLike.ref;
  const offsets: number[] = [];
  while ('parent' in ref) {
    offsets.unshift(ref.relativeLine);
    if (ref.parent.type === 'task') break;
    ref = ref.parent.ref;
  }
  return offsets.reduce((sum, offset) => sum + offset, line);
}

/**
 * Wire up a real RightPanel + real AppState with seeded files and task cache.
 * RightPanel writers use only the final task application contract plus view state.
 */
async function makePanel(
  files: Record<string, string>,
  settings: CalendarSettings = DEFAULT_SETTINGS,
  seeds: Array<{ path: string; items: Array<{ task: string; parent: number; line: number }> }> = [],
  onSuccessfulMutation?: (ref?: TaskRef) => void,
): Promise<{ panel: RightPanel; state: AppState; app: App }> {
  const app = await createAppWithFiles(files);
  for (const s of seeds) seedTaskCache(app, s.path, s.items);
  const state = new AppState();
  const statusCatalog = new StatusCatalog(toStatusRules(settings.taskStatuses));
  const index = new TaskIndex(app, {
    statusCatalog,
    dailyNoteFormat: settings.desktop.dailyNoteFormat,
  });
  const tasks = new TaskApplicationService(
    index,
    new ObsidianTaskRepository(app, {
      codec: new TaskMarkdownCodec(statusCatalog),
      editor: new TaskBlockEditor(),
      locator: new TaskLocator(),
      snapshotsFromContent: (path, content) => index.snapshotsFromContent(path, content),
    }),
    statusCatalog,
    { today: () => '2026-07-14' as never },
  );
  await index.initialize();
  const panel = new RightPanel(
    state,
    app,
    testStatusRegistry(),
    settings,
    onSuccessfulMutation,
    tasks,
  );
  return { panel, state, app };
}

describe('RightPanel.getTagColor', () => {
  it('prefix mode: exact match returns group.color', async () => {
    const group: TagGroup = {
      id: 'g1',
      name: 'Work',
      mode: 'prefix',
      prefix: 'work',
      color: '#ff0000',
    };
    const settings: CalendarSettings = { ...DEFAULT_SETTINGS, tagGroups: [group] };
    const { panel } = await makePanel({ 't.md': '- [ ] x' }, settings);
    expect(call<string | undefined>(panel, 'getTagColor', '#work')).toBe('#ff0000');
  });

  it('prefix mode: slash subtag matches (e.g. #work/deep)', async () => {
    const group: TagGroup = {
      id: 'g1',
      name: 'Work',
      mode: 'prefix',
      prefix: 'work',
      color: '#ff0000',
    };
    const settings: CalendarSettings = { ...DEFAULT_SETTINGS, tagGroups: [group] };
    const { panel } = await makePanel({ 't.md': '- [ ] x' }, settings);
    expect(call<string | undefined>(panel, 'getTagColor', '#work/deep')).toBe('#ff0000');
  });

  it('manual mode: matches tag with or without leading #', async () => {
    const group: TagGroup = {
      id: 'g1',
      name: 'Manual',
      mode: 'manual',
      tags: ['#urgent', 'low'],
      color: '#00ff00',
    };
    const settings: CalendarSettings = { ...DEFAULT_SETTINGS, tagGroups: [group] };
    const { panel } = await makePanel({ 't.md': '- [ ] x' }, settings);
    expect(call<string | undefined>(panel, 'getTagColor', '#urgent')).toBe('#00ff00');
    expect(call<string | undefined>(panel, 'getTagColor', '#low')).toBe('#00ff00');
  });

  it('no matching group → undefined', async () => {
    const group: TagGroup = {
      id: 'g1',
      name: 'Work',
      mode: 'prefix',
      prefix: 'work',
      color: '#ff0000',
    };
    const settings: CalendarSettings = { ...DEFAULT_SETTINGS, tagGroups: [group] };
    const { panel } = await makePanel({ 't.md': '- [ ] x' }, settings);
    expect(call<string | undefined>(panel, 'getTagColor', '#personal')).toBeUndefined();
  });

  it('no settings → undefined', async () => {
    const app = await createAppWithFiles({ 't.md': '- [ ] x' });
    const state = new AppState();
    const panel = new RightPanel(state, app, testStatusRegistry(), undefined);
    expect(call<string | undefined>(panel, 'getTagColor', '#anything')).toBeUndefined();
  });
});

describe('RightPanel recurrence writer', () => {
  it('saves recurrence and completion policy through one application patch', async () => {
    const source = '- [ ] Task 📅 2026-08-09\n';
    const { panel, state, app } = await makePanel({ 't.md': source }, DEFAULT_SETTINGS, [
      { path: 't.md', items: [{ task: ' ', parent: -1, line: 0 }] },
    ]);
    const current = (panel as unknown as { tasks: TaskApplicationApi }).tasks.queries.list({
      filePath: 't.md',
    })[0]!;
    const el = freshContainer();
    panel.mount(el);
    state.set('taskStack', [current]);
    const process = vi.spyOn(app.vault, 'process');

    el.querySelector<HTMLButtonElement>('.tc-repeat-chip')!.click();
    const weekdays = Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find(
      (candidate) => candidate.textContent === 'Weekdays',
    )!;
    weekdays.click();
    const completed = el.querySelector<HTMLSelectElement>('[aria-label="Completed task"]')!;
    completed.value = 'delete';
    completed.dispatchEvent(new Event('change', { bubbles: true }));
    el.querySelector<HTMLButtonElement>('.tc-recurrence-save')!.click();
    await flushMicrotasks();

    expect(process).toHaveBeenCalledOnce();
    expect(await readMd(app, 't.md')).toBe('- [ ] Task 🔁 every weekday 🏁 delete 📅 2026-08-09\n');
  });
});

describe('RightPanel planning API delegation', () => {
  it('routes due/scheduled/start set and clear through TaskApplicationApi', async () => {
    const app = await createAppWithFiles({ 't.md': '- [ ] task\n' });
    const state = new AppState();
    const ref: TaskRef = { filePath: 't.md', line: 0, revision: 'r' };
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'not-found',
      target: { type: 'task', ref },
    });
    const tasks: TaskApplicationApi = {
      queries: {
        list: () => [],
        forCalendarDates: () => [],
        resolve: (target) => ({ type: 'not-found', ref: target }),
        subscribe: () => () => {},
      },
      execute,
    };
    const panel = new RightPanel(
      state,
      app,
      testStatusRegistry(),
      DEFAULT_SETTINGS,
      undefined,
      tasks,
    );
    const current = Object.assign(task({ source: { filePath: 't.md', line: 0 } }), { ref });
    const process = vi.spyOn(app.vault, 'process');

    await call(panel, 'updateDue', current, '2026-07-20');
    await call(panel, 'clearDate', current);
    await call(panel, 'updateScheduled', current, '2026-07-21');
    await call(panel, 'clearScheduled', current);
    await call(panel, 'updateStart', current, '2026-07-19');
    await call(panel, 'clearStart', current);

    expect(execute.mock.calls.map(([command]) => command)).toEqual([
      {
        type: 'patch',
        target: { type: 'task', ref },
        patch: { due: { type: 'set', value: '2026-07-20' } },
      },
      { type: 'patch', target: { type: 'task', ref }, patch: { due: { type: 'clear' } } },
      {
        type: 'patch',
        target: { type: 'task', ref },
        patch: { scheduled: { type: 'set', value: '2026-07-21' } },
      },
      { type: 'patch', target: { type: 'task', ref }, patch: { scheduled: { type: 'clear' } } },
      {
        type: 'patch',
        target: { type: 'task', ref },
        patch: { start: { type: 'set', value: '2026-07-19' } },
      },
      { type: 'patch', target: { type: 'task', ref }, patch: { start: { type: 'clear' } } },
    ]);
    expect(process).not.toHaveBeenCalled();
  });

  it('clears the effective Date field scheduled-only, while preserving due-first when both exist', async () => {
    const app = await createAppWithFiles({ 't.md': '- [ ] task ⏳ 2026-07-20\n' });
    const state = new AppState();
    const ref: TaskRef = { filePath: 't.md', line: 0, revision: 'r' };
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'not-found',
      target: { type: 'task', ref },
    });
    const tasks: TaskApplicationApi = {
      queries: {
        list: () => [],
        forCalendarDates: () => [],
        resolve: (target) => ({ type: 'not-found', ref: target }),
        subscribe: () => () => {},
      },
      execute,
    };
    const panel = new RightPanel(
      state,
      app,
      testStatusRegistry(),
      DEFAULT_SETTINGS,
      undefined,
      tasks,
    );
    const current = Object.assign(
      task({
        planning: { due: undefined, scheduled: '2026-07-20' },
        source: { filePath: 't.md', line: 0 },
      }),
      { ref },
    );

    await call(panel, 'clearDate', current);

    expect(execute).toHaveBeenCalledWith({
      type: 'patch',
      target: { type: 'task', ref },
      patch: { scheduled: { type: 'clear' } },
    });

    execute.mockClear();
    await call(
      panel,
      'clearDate',
      Object.assign(
        task({
          planning: { due: '2026-07-21', scheduled: '2026-07-20' },
          source: { filePath: 't.md', line: 0 },
        }),
        { ref },
      ),
    );
    expect(execute).toHaveBeenCalledWith({
      type: 'patch',
      target: { type: 'task', ref },
      patch: { due: { type: 'clear' } },
    });
  });

  it('routes root duration and root/subtask time edits through one typed patch each', async () => {
    const app = await createAppWithFiles({ 't.md': '- [ ] task\n  - [ ] child\n' });
    const state = new AppState();
    const rootRef: TaskRef = { filePath: 't.md', line: 0, revision: 'r' };
    const childRef = {
      parent: { type: 'task' as const, ref: rootRef },
      relativeLine: 1,
      originalBlock: '  - [ ] child',
    };
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'not-found',
      target: { type: 'task', ref: rootRef },
    });
    const tasks: TaskApplicationApi = {
      queries: {
        list: () => [],
        forCalendarDates: () => [],
        resolve: (target) => ({ type: 'not-found', ref: target }),
        subscribe: () => () => {},
      },
      execute,
    };
    const panel = new RightPanel(
      state,
      app,
      testStatusRegistry(),
      DEFAULT_SETTINGS,
      undefined,
      tasks,
    );
    const root = Object.assign(task({ source: { filePath: 't.md', line: 0 } }), { ref: rootRef });
    const child = Object.assign(task({ source: { filePath: 't.md', line: 1 } }), { ref: childRef });
    const process = vi.spyOn(app.vault, 'process');

    await call(panel, 'updateTime', root, '14:30');
    await call(panel, 'updateTime', child, '15:45');
    await call(panel, 'updateTime', child, '');
    await call(panel, 'updateDuration', root, 90);
    await call(panel, 'clearDuration', root);

    expect(execute.mock.calls.map(([command]) => command)).toEqual([
      {
        type: 'patch',
        target: { type: 'task', ref: rootRef },
        patch: { time: { type: 'set', value: '14:30' } },
      },
      {
        type: 'patch',
        target: { type: 'subtask', ref: childRef },
        patch: { time: { type: 'set', value: '15:45' } },
      },
      {
        type: 'patch',
        target: { type: 'subtask', ref: childRef },
        patch: { time: { type: 'clear' } },
      },
      {
        type: 'patch',
        target: { type: 'task', ref: rootRef },
        patch: { duration: { type: 'set', value: 90 } },
      },
      {
        type: 'patch',
        target: { type: 'task', ref: rootRef },
        patch: { duration: { type: 'clear' } },
      },
    ]);
    expect(execute).toHaveBeenCalledTimes(5);
    expect(process).not.toHaveBeenCalled();
  });

  it('keeps the edited nested task selected from the returned fresh aggregate', async () => {
    const app = await createAppWithFiles({ 't.md': '- [ ] root\n  - [ ] child\n' });
    const state = new AppState();
    const rootRef: TaskRef = { filePath: 't.md', line: 0, revision: 'old-root' };
    const childRef = {
      parent: { type: 'task' as const, ref: rootRef },
      relativeLine: 1,
      originalBlock: '  - [ ] child',
    };
    const freshRootRef: TaskRef = { ...rootRef, revision: 'new-root' };
    const freshChildRef = {
      ...childRef,
      parent: { type: 'task' as const, ref: freshRootRef },
      originalBlock: '  - [ ] child 📅 2026-07-20',
    };
    const freshRoot = {
      ref: freshRootRef,
      title: 'root',
      markdownTitle: 'root',
      status: 'open' as const,
      statusSymbol: ' ',
      priority: 'D' as const,
      onCompletion: 'keep' as const,
      onCompletionExplicit: false,
      planning: {},
      tags: [],
      subtasks: [
        {
          ref: freshChildRef,
          title: 'child',
          markdownTitle: 'child',
          status: 'open' as const,
          statusSymbol: ' ',
          priority: 'D' as const,
          onCompletion: 'keep' as const,
          onCompletionExplicit: false,
          planning: { due: '2026-07-20' as import('../src/tasks').LocalDate },
          tags: [],
          subtasks: [],
          comments: [],
        },
      ],
      comments: [],
      source: {
        filePath: 't.md',
        line: 0,
        originalMarkdown: '- [ ] root',
        originalBlock: '- [ ] root\n  - [ ] child',
      },
      presentation: { linkCount: 0 },
    };
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'ok',
      changed: true,
      outcome: { type: 'task', task: freshRoot },
    });
    const tasks: TaskApplicationApi = {
      queries: {
        list: () => [],
        forCalendarDates: () => [],
        resolve: (target) => ({ type: 'not-found', ref: target }),
        subscribe: () => () => {},
      },
      execute,
    };
    const panel = new RightPanel(
      state,
      app,
      testStatusRegistry(),
      DEFAULT_SETTINGS,
      undefined,
      tasks,
    );
    const legacyRoot = Object.assign(
      task({ title: 'root', source: { filePath: 't.md', line: 0 } }),
      {
        ref: rootRef,
      },
    );
    const legacyChild = Object.assign(
      task({ title: 'child', source: { filePath: 't.md', line: 1 } }),
      {
        ref: childRef,
      },
    );
    state.set('taskStack', [legacyRoot, legacyChild]);

    await call(panel, 'updateDue', legacyChild, '2026-07-20');

    expect(state.get('taskStack')).toHaveLength(2);
    expect(state.get('taskStack')[1]).toMatchObject({
      planning: { due: '2026-07-20' },
      ref: freshChildRef,
    });
  });

  it.each(['root', 'child'] as const)(
    'does not restore a previously selected %s when its async planning result arrives late',
    async (selection) => {
      const app = await createAppWithFiles({
        'a.md': '- [ ] A\n  - [ ] A child\n',
        'b.md': '- [ ] B\n',
      });
      const state = new AppState();
      const acknowledge = vi.fn<(ref?: TaskRef) => void>();
      const rootRef: TaskRef = { filePath: 'a.md', line: 0, revision: 'old-a' };
      const childRef = {
        parent: { type: 'task' as const, ref: rootRef },
        relativeLine: 1,
        originalBlock: '  - [ ] A child',
      };
      let resolveExecute!: (result: TaskCommandResult) => void;
      const execute = vi.fn<TaskApplicationApi['execute']>().mockImplementation(
        () =>
          new Promise<TaskCommandResult>((resolve) => {
            resolveExecute = resolve;
          }),
      );
      const tasks: TaskApplicationApi = {
        queries: {
          list: () => [],
          forCalendarDates: () => [],
          resolve: (target) => ({ type: 'not-found', ref: target }),
          subscribe: () => () => {},
        },
        execute,
      };
      const panel = new RightPanel(
        state,
        app,
        testStatusRegistry(),
        DEFAULT_SETTINGS,
        acknowledge,
        tasks,
      );
      const legacyRoot = Object.assign(
        task({ title: 'A', source: { filePath: 'a.md', line: 0 } }),
        {
          ref: rootRef,
        },
      );
      const legacyChild = Object.assign(
        task({ title: 'A child', source: { filePath: 'a.md', line: 1 } }),
        {
          ref: childRef,
        },
      );
      state.set('taskStack', selection === 'child' ? [legacyRoot, legacyChild] : [legacyRoot]);
      const pending = call<Promise<void>>(
        panel,
        'updateDue',
        selection === 'child' ? legacyChild : legacyRoot,
        '2026-07-20',
      );

      const other = Object.assign(task({ title: 'B', source: { filePath: 'b.md', line: 0 } }), {
        ref: { filePath: 'b.md', line: 0, revision: 'b' },
      });
      state.set('taskStack', [other]);
      const freshRootRef: TaskRef = { ...rootRef, revision: 'new-a' };
      const freshRoot: TaskSnapshot = {
        ref: freshRootRef,
        title: 'A',
        markdownTitle: 'A',
        status: 'open',
        statusSymbol: ' ',
        priority: 'D',
        onCompletion: 'keep' as const,
        onCompletionExplicit: false,
        planning:
          selection === 'root' ? { due: '2026-07-20' as import('../src/tasks').LocalDate } : {},
        tags: [],
        subtasks:
          selection === 'child'
            ? [
                {
                  ref: {
                    ...childRef,
                    parent: { type: 'task', ref: freshRootRef },
                    originalBlock: '  - [ ] A child 📅 2026-07-20',
                  },
                  title: 'A child',
                  markdownTitle: 'A child',
                  status: 'open',
                  statusSymbol: ' ',
                  priority: 'D',
                  onCompletion: 'keep' as const,
                  onCompletionExplicit: false,
                  planning: { due: '2026-07-20' as import('../src/tasks').LocalDate },
                  tags: [],
                  subtasks: [],
                  comments: [],
                },
              ]
            : [],
        comments: [],
        source: {
          filePath: 'a.md',
          line: 0,
          originalMarkdown: '- [ ] A',
          originalBlock:
            selection === 'child' ? '- [ ] A\n  - [ ] A child 📅 2026-07-20' : '- [ ] A',
        },
        presentation: { linkCount: 0 },
      };
      resolveExecute({
        type: 'ok',
        changed: true,
        outcome: { type: 'task', task: freshRoot },
      });
      await pending;

      expect(state.get('taskStack')).toEqual([other]);
      expect(acknowledge).toHaveBeenCalledWith(freshRootRef);
    },
  );
});

describe('RightPanel.formatDate', () => {
  // formatDate reads window.moment(); use fake timers + real moment module so
  // window.moment() reflects the frozen system time. No vault access needed.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-25T12:00:00Z'));
    (window as unknown as { moment: unknown }).moment = moment;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makePanelNoVault(): RightPanel {
    const state = new AppState();
    const app = { vault: { getAbstractFileByPath: () => null } } as unknown as App;
    return new RightPanel(state, app, testStatusRegistry(), DEFAULT_SETTINGS);
  }

  it('today → "Today"', () => {
    const panel = makePanelNoVault();
    expect(call<string>(panel, 'formatDate', '2026-06-25')).toBe('Today');
  });

  it('tomorrow → "Tomorrow"', () => {
    const panel = makePanelNoVault();
    expect(call<string>(panel, 'formatDate', '2026-06-26')).toBe('Tomorrow');
  });

  it('other date → "D MMM" format', () => {
    const panel = makePanelNoVault();
    expect(call<string>(panel, 'formatDate', '2026-07-25')).toBe('25 Jul');
  });
});

describe('RightPanel.updateTaskTitle', () => {
  it('routes root replacement and nested attachment append through TaskApplicationApi', async () => {
    const app = await createAppWithFiles({ 't.md': '- [ ] root\n  - [ ] child\n' });
    const state = new AppState();
    const rootRef: TaskRef = { filePath: 't.md', line: 0, revision: 'root' };
    const childRef = {
      parent: { type: 'task' as const, ref: rootRef },
      relativeLine: 1,
      originalBlock: '  - [ ] child',
    };
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'not-found',
      target: { type: 'task', ref: rootRef },
    });
    const tasks: TaskApplicationApi = {
      queries: {
        list: () => [],
        forCalendarDates: () => [],
        resolve: (target) => ({ type: 'not-found', ref: target }),
        subscribe: () => () => {},
      },
      execute,
    };
    const panel = new RightPanel(
      state,
      app,
      testStatusRegistry(),
      DEFAULT_SETTINGS,
      undefined,
      tasks,
    );
    const root = Object.assign(task({ source: { filePath: 't.md', line: 0 } }), { ref: rootRef });
    const child = Object.assign(task({ source: { filePath: 't.md', line: 1 } }), { ref: childRef });
    const process = vi.spyOn(app.vault, 'process');

    await call<Promise<void>>(panel, 'updateTaskTitle', root, 'New [[Title]]');
    await call<Promise<void>>(panel, 'appendToTitle', child, '[[attachment.png|image]]');

    expect(execute.mock.calls.map(([command]) => command)).toEqual([
      {
        type: 'patch',
        target: { type: 'task', ref: rootRef },
        patch: { markdownTitle: { type: 'set', value: 'New [[Title]]' } },
      },
      {
        type: 'append-title',
        target: { type: 'subtask', ref: childRef },
        markdown: '[[attachment.png|image]]',
      },
    ]);
    expect(process).not.toHaveBeenCalled();
  });

  it('acknowledges the initiating root when selection changes during an async write', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acknowledge = vi.fn<(ref?: TaskRef) => void>();
    const { panel, state, app } = await makePanel(
      { 't.md': '- [ ] old title' },
      DEFAULT_SETTINGS,
      [],
      acknowledge,
    );
    const originalProcess = app.vault.process.bind(app.vault);
    vi.spyOn(app.vault, 'process').mockImplementation(async (file, transform) => {
      await gate;
      return originalProcess(file, transform);
    });
    const first = (panel as unknown as { tasks: TaskApplicationApi }).tasks.queries.list()[0]!;
    const second = Object.assign(task({ source: { filePath: 'other.md', line: 0 } }), {
      ref: { filePath: 'other.md', line: 0, revision: 'second' },
    });
    state.set('taskStack', [first]);
    const pending = call<Promise<void>>(panel, 'updateTaskTitle', first, 'new title');
    state.set('taskStack', [second]);
    release();
    await pending;
    expect(acknowledge).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: 't.md', line: 0 }),
    );
    expect(acknowledge.mock.calls[0]?.[0]?.revision).not.toBe(first.ref.revision);
  });

  it('acknowledges a successful local write for revision reanchoring', async () => {
    const acknowledge = vi.fn();
    const { panel } = await makePanel(
      { 't.md': '- [ ] old title' },
      DEFAULT_SETTINGS,
      [],
      acknowledge,
    );
    await call<Promise<void>>(
      panel,
      'updateTaskTitle',
      task({
        source: {
          filePath: 't.md',
          line: 0,
          originalMarkdown: '- [ ] old title',
          originalBlock: '- [ ] old title',
        },
      }),
      'new title',
    );
    expect(acknowledge).toHaveBeenCalledOnce();
  });

  it('does not acknowledge a successful no-op with unchanged source', async () => {
    const acknowledge = vi.fn();
    const { panel } = await makePanel(
      { 't.md': '- [ ] same title' },
      DEFAULT_SETTINGS,
      [],
      acknowledge,
    );
    await call<Promise<void>>(
      panel,
      'updateTaskTitle',
      task({
        source: {
          filePath: 't.md',
          line: 0,
          originalMarkdown: '- [ ] same title',
          originalBlock: '- [ ] same title',
        },
      }),
      'same title',
    );
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it('replaces title preserving prefix and metadata suffix', async () => {
    const { panel, app } = await makePanel({ 't.md': '- [ ] old title 📅 2026-06-20' });
    const t = task({
      title: 'old title',
      planning: { due: '2026-06-20' },
      source: {
        filePath: 't.md',
        line: 0,
        originalMarkdown: '- [ ] old title 📅 2026-06-20',
        originalBlock: '- [ ] old title 📅 2026-06-20',
      },
    });
    await call<Promise<void>>(panel, 'updateTaskTitle', t, 'new title');
    const content = await readMd(app, 't.md');
    expect(content).toContain('new title');
    expect(content).toContain('📅 2026-06-20');
    expect(content).not.toContain('old title');
  });

  it('preserves tags in suffix', async () => {
    const { panel, app } = await makePanel({ 't.md': '- [ ] old #work' });
    const t = task({
      title: 'old',
      source: {
        filePath: 't.md',
        line: 0,
        originalMarkdown: '- [ ] old #work',
        originalBlock: '- [ ] old #work',
      },
    });
    await call<Promise<void>>(panel, 'updateTaskTitle', t, 'renamed');
    const content = await readMd(app, 't.md');
    expect(content).toContain('renamed');
    expect(content).toContain('#work');
  });

  it('no-op if line has no checkbox prefix', async () => {
    const { panel, app } = await makePanel({ 't.md': 'just plain text' });
    const t = task({
      title: 'plain',
      source: {
        filePath: 't.md',
        line: 0,
        originalMarkdown: 'just plain text',
        originalBlock: 'just plain text',
      },
    });
    await call<Promise<void>>(panel, 'updateTaskTitle', t, 'renamed');
    const content = await readMd(app, 't.md');
    expect(content).toBe('just plain text');
  });

  it('file not found → no-op (no throw)', async () => {
    const { panel } = await makePanel({ 't.md': '- [ ] x' });
    const t = task({
      title: 'x',
      source: {
        filePath: 'missing.md',
        line: 0,
        originalMarkdown: '- [ ] x',
        originalBlock: '- [ ] x',
      },
    });
    await expect(
      call<Promise<void>>(panel, 'updateTaskTitle', t, 'renamed'),
    ).resolves.toBeUndefined();
  });
});

describe('RightPanel.updateDescription', () => {
  it('inserts a new description line when none exists', async () => {
    const { panel, app } = await makePanel({ 't.md': '- [ ] task\n- [ ] other' });
    const t = task({
      title: 'task',
      source: {
        filePath: 't.md',
        line: 0,
        originalMarkdown: '- [ ] task',
        originalBlock: '- [ ] task',
      },
    });
    await call<Promise<void>>(panel, 'updateDescription', t, 'a description');
    const content = await readMd(app, 't.md');
    expect(content).toContain('- > a description');
    expect(content).toContain('- [ ] task');
    expect(content).toContain('- [ ] other');
  });

  it('removes existing description lines before inserting new (single line desc)', async () => {
    // When subtaskRange is provided, lines between rangeStart and rangeEnd are filtered
    // for `- > ` lines. Use range 0..1 to cover the desc line at index 1.
    const content = '- [ ] task\n  - > old desc\n- [ ] other';
    const { panel, app } = await makePanel({ 't.md': content });
    const t = task({
      title: 'task',
      source: {
        filePath: 't.md',
        line: 0,
        originalMarkdown: '- [ ] task',
        originalBlock: '- [ ] task',
      },
    });
    await call<Promise<void>>(panel, 'updateDescription', t, 'new desc');
    const after = await readMd(app, 't.md');
    expect(after).toContain('- > new desc');
    expect(after).not.toContain('old desc');
  });

  it('empty description removes existing desc lines only', async () => {
    const content = '- [ ] task\n  - > old desc\n- [ ] other';
    const { panel, app } = await makePanel({ 't.md': content });
    const t = task({
      title: 'task',
      source: {
        filePath: 't.md',
        line: 0,
        originalMarkdown: '- [ ] task',
        originalBlock: '- [ ] task',
      },
    });
    await call<Promise<void>>(panel, 'updateDescription', t, '');
    const after = await readMd(app, 't.md');
    expect(after).not.toContain('- >');
    expect(after).toContain('- [ ] task');
    expect(after).toContain('- [ ] other');
  });

  it('uses the revisioned block to replace an existing description without legacy range data', async () => {
    const content = '- [ ] task\n  - > old desc\n- [ ] other';
    const { panel, app } = await makePanel({ 't.md': content });
    const t = task({
      title: 'task',
      source: {
        filePath: 't.md',
        line: 0,
        originalMarkdown: '- [ ] task',
        originalBlock: '- [ ] task',
      },
    });
    await call<Promise<void>>(panel, 'updateDescription', t, 'new desc');
    const after = await readMd(app, 't.md');
    expect(after).not.toContain('old desc');
    expect(after).toContain('new desc');
  });

  it('multi-line description inserts multiple - > lines', async () => {
    const { panel, app } = await makePanel({ 't.md': '- [ ] task\n- [ ] other' });
    const t = task({
      title: 'task',
      source: {
        filePath: 't.md',
        line: 0,
        originalMarkdown: '- [ ] task',
        originalBlock: '- [ ] task',
      },
    });
    await call<Promise<void>>(panel, 'updateDescription', t, 'line one\nline two');
    const after = await readMd(app, 't.md');
    expect(after).toContain('- > line one');
    expect(after).toContain('- > line two');
  });

  it('file not found → no-op', async () => {
    const { panel } = await makePanel({ 't.md': '- [ ] x' });
    const t = task({
      title: 'x',
      source: {
        filePath: 'missing.md',
        line: 0,
        originalMarkdown: '- [ ] x',
        originalBlock: '- [ ] x',
      },
    });
    await expect(call<Promise<boolean>>(panel, 'updateDescription', t, 'desc')).resolves.toBe(
      false,
    );
  });
});

describe('RightPanel.addSubTask', () => {
  it('without subtaskRange: inserts a new subtask line right after task line', async () => {
    const { panel, app } = await makePanel({ 't.md': '- [ ] parent\n- [ ] other' });
    const t = task({
      title: 'parent',
      source: {
        filePath: 't.md',
        line: 0,
        originalMarkdown: '- [ ] parent',
        originalBlock: '- [ ] parent',
      },
    });
    await call<Promise<void>>(panel, 'addSubTask', t, 'first sub');
    const after = await readMd(app, 't.md');
    const lines = after.split('\n');
    expect(lines[1]).toContain('- [ ] first sub');
    expect(lines[0]).toBe('- [ ] parent');
    expect(lines[2]).toBe('- [ ] other');
  });

  it('with subtaskRange: inserts after range.to', async () => {
    const content = '- [ ] parent\n    - [ ] existing sub\n- [ ] other';
    const { panel, app } = await makePanel({ 't.md': content });
    const t = task({
      title: 'parent',
      source: {
        filePath: 't.md',
        line: 0,
        originalMarkdown: '- [ ] parent',
        originalBlock: '- [ ] parent',
      },
    });
    await call<Promise<void>>(panel, 'addSubTask', t, 'new sub');
    const after = await readMd(app, 't.md');
    const lines = after.split('\n');
    // new sub should be at index 2 (after existing sub at index 1)
    expect(lines[2]).toContain('- [ ] new sub');
    expect(lines[3]).toBe('- [ ] other');
  });

  it('file not found → no-op', async () => {
    const { panel } = await makePanel({ 't.md': '- [ ] x' });
    const t = task({
      title: 'x',
      source: {
        filePath: 'missing.md',
        line: 0,
        originalMarkdown: '- [ ] x',
        originalBlock: '- [ ] x',
      },
    });
    await expect(call<Promise<boolean>>(panel, 'addSubTask', t, 'sub')).resolves.toBe(false);
  });
});

describe('RightPanel.toggleSubTask', () => {
  it('open → done: replaces "- [ ]" with "- [x]" (case-sensitive)', async () => {
    const { panel, app } = await makePanel({ 't.md': '  - [ ] sub' });
    const sub = subtask({
      title: 'sub',
      root: { filePath: 't.md', line: 0 },
      ref: { relativeLine: 0, originalBlock: '  - [ ] sub' },
    });
    await call<Promise<void>>(panel, 'toggleSubTask', sub);
    const after = await readMd(app, 't.md');
    expect(after).toContain('- [x]');
    expect(after).not.toContain('- [ ]');
  });

  // FU-28 fix: toggling is now registry-driven (via statusSymbol -> typeForSymbol),
  // not the stale/caller-supplied `status` field, so an uppercase "[X]" (done, via
  // the X->x alias) correctly toggles to the registry's default todo symbol.
  it('registry-driven: "- [X]" (done via X->x alias) toggles to open, ignoring stale status field', async () => {
    const { panel, app } = await makePanel({ 't.md': '  - [X] sub' });
    const sub = subtask({
      title: 'sub',
      status: 'open', // caller claims open, but statusSymbol 'X' resolves to done
      statusSymbol: 'X',
      root: { filePath: 't.md', line: 0 },
      ref: { relativeLine: 0, originalBlock: '  - [X] sub' },
    });
    await call<Promise<void>>(panel, 'toggleSubTask', sub);
    const after = await readMd(app, 't.md');
    expect(after).toBe('  - [ ] sub');
  });

  it('done → open: replaces "- [x]" with "- [ ]" (case-insensitive)', async () => {
    const { panel, app } = await makePanel({ 't.md': '  - [x] sub' });
    const sub = subtask({
      title: 'sub',
      status: 'done',
      statusSymbol: 'x',
      root: { filePath: 't.md', line: 0 },
      ref: { relativeLine: 0, originalBlock: '  - [x] sub' },
    });
    await call<Promise<void>>(panel, 'toggleSubTask', sub);
    const after = await readMd(app, 't.md');
    expect(after).toContain('- [ ]');
    expect(after).not.toContain('- [x]');
  });

  it('done → open: case-insensitive matches uppercase "- [X]"', async () => {
    const { panel, app } = await makePanel({ 't.md': '  - [X] sub' });
    const sub = subtask({
      title: 'sub',
      status: 'done',
      statusSymbol: 'X',
      root: { filePath: 't.md', line: 0 },
      ref: { relativeLine: 0, originalBlock: '  - [X] sub' },
    });
    await call<Promise<void>>(panel, 'toggleSubTask', sub);
    const after = await readMd(app, 't.md');
    expect(after).toContain('- [ ]');
  });

  it('file not found → no-op', async () => {
    const { panel } = await makePanel({ 't.md': '  - [ ] sub' });
    const sub = task({
      title: 'sub',
      source: {
        filePath: 'missing.md',
        originalMarkdown: '  - [ ] sub',
        originalBlock: '  - [ ] sub',
      },
    });
    await expect(call<Promise<void>>(panel, 'toggleSubTask', sub)).resolves.toBeUndefined();
  });
});

describe('RightPanel.addComment', () => {
  // addComment uses window.moment().format('YYYY-MM-DD') for the date stamp.
  // We freeze time AFTER createAppWithFiles (which uses setTimeout internally)
  // so the vault setup completes with real timers, then moment reports 2026-06-25.
  // Restore real timers in afterEach so subsequent describes aren't affected.
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Install fake timers frozen at 2026-06-25 for the addComment date stamp. */
  function freezeToday(): void {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-25T12:00:00Z'));
    (window as unknown as { moment: unknown }).moment = moment;
  }

  it('appends a comment line "- <today>: <text>" after the task line (no subtaskRange)', async () => {
    const { panel, state, app } = await makePanel({ 't.md': '- [ ] task\n- [ ] other' });
    freezeToday();
    const t = task({
      title: 'task',
      source: {
        filePath: 't.md',
        line: 0,
        originalMarkdown: '- [ ] task',
        originalBlock: '- [ ] task',
      },
    });
    state.set('taskStack', [t]);
    const commentList = freshContainer();
    const inputEl = freshContainer().createEl('textarea');
    await call<Promise<void>>(panel, 'addComment', t, 'hello', commentList, inputEl);
    const after = await readMd(app, 't.md');
    const lines = after.split('\n');
    // The returned snapshot drives the real panel; this detached list is not optimistically edited.
    expect(commentList.querySelectorAll('.tc-comment-row')).toHaveLength(0);
    expect(inputEl.value).toBe('');
    // Line 1 should be the comment (inserted at task.line + 1)
    expect(lines[1]).toContain('2026-07-14: hello');
    expect(lines[0]).toBe('- [ ] task');
    expect(lines[2]).toBe('- [ ] other');
  });

  it('with subtaskRange: inserts after range.to', async () => {
    const content = '- [ ] task\n    - [ ] sub\n- [ ] other';
    const { panel, app } = await makePanel({ 't.md': content });
    freezeToday();
    const t = task({
      title: 'task',
      source: {
        filePath: 't.md',
        line: 0,
        originalMarkdown: '- [ ] task',
        originalBlock: '- [ ] task',
      },
    });
    const commentList = freshContainer();
    const inputEl = freshContainer().createEl('textarea');
    await call<Promise<void>>(panel, 'addComment', t, 'c', commentList, inputEl);
    const after = await readMd(app, 't.md');
    const lines = after.split('\n');
    expect(lines[2]).toContain('2026-07-14: c');
    expect(lines[3]).toBe('- [ ] other');
  });

  it('keeps the draft and DOM unchanged when no revisioned parent can be resolved', async () => {
    const { panel, state } = await makePanel({ 't.md': '- [ ] task' });
    freezeToday();
    const t = task({
      title: 'task',
      source: {
        filePath: 't.md',
        line: 0,
        originalMarkdown: '- [ ] task',
        originalBlock: '- [ ] task',
      },
    });
    state.set('taskStack', [t]);
    const commentList = freshContainer();
    const inputEl = freshContainer().createEl('textarea');
    inputEl.value = 'pre-existing';
    const missing = task({
      title: 'task',
      source: {
        filePath: 'missing.md',
        line: 0,
        originalMarkdown: '- [ ] task',
        originalBlock: '- [ ] task',
      },
    });
    await expect(
      call<Promise<boolean>>(panel, 'addComment', missing, 'ghost', commentList, inputEl),
    ).resolves.toBe(false);
    expect(commentList.querySelectorAll('.tc-comment-row')).toHaveLength(0);
    expect(inputEl.value).toBe('pre-existing');
  });

  it('file not found → reports no commit', async () => {
    const { panel } = await makePanel({ 't.md': '- [ ] task' });
    freezeToday();
    const t = task({
      title: 'task',
      source: {
        filePath: 'missing.md',
        line: 0,
        originalMarkdown: '- [ ] task',
        originalBlock: '- [ ] task',
      },
    });
    const commentList = freshContainer();
    const inputEl = freshContainer().createEl('textarea');
    await expect(
      call<Promise<boolean>>(panel, 'addComment', t, 'x', commentList, inputEl),
    ).resolves.toBe(false);
  });
});

describe('RightPanel.updateComment', () => {
  it('preserves date prefix when present', async () => {
    const content = '- [ ] task\n  - 2026-06-20: old text\n- [ ] other';
    const { panel, app } = await makePanel({ 't.md': content });
    const t = task({
      title: 'task',
      source: {
        filePath: 't.md',
        line: 0,
        originalMarkdown: '- [ ] task',
        originalBlock: '- [ ] task',
      },
    });
    const comment = taskComment({ text: 'old text', date: '2026-06-20' });
    await call<Promise<void>>(panel, 'updateComment', t, comment, 'new text');
    const after = await readMd(app, 't.md');
    const lines = after.split('\n');
    expect(lines[1]).toBe('  - 2026-06-20: new text');
  });

  it('without date prefix: uses bare "- " prefix', async () => {
    const content = '- [ ] task\n  - plain comment\n- [ ] other';
    const { panel, app } = await makePanel({ 't.md': content });
    const t = task({
      title: 'task',
      source: {
        filePath: 't.md',
        line: 0,
        originalMarkdown: '- [ ] task',
        originalBlock: '- [ ] task',
      },
    });
    const comment = taskComment({ text: 'plain comment' });
    await call<Promise<void>>(panel, 'updateComment', t, comment, 'edited');
    const after = await readMd(app, 't.md');
    const lines = after.split('\n');
    expect(lines[1]).toBe('  - edited');
  });

  it('refuses to rewrite a malformed non-comment line', async () => {
    const content = '- [ ] task\n    not-a-comment\n- [ ] other';
    const { panel, app } = await makePanel({ 't.md': content });
    const t = task({
      title: 'task',
      source: {
        filePath: 't.md',
        line: 0,
        originalMarkdown: '- [ ] task',
        originalBlock: '- [ ] task',
      },
    });
    const comment = taskComment({
      text: 'not-a-comment',
      ref: { originalMarkdown: '    not-a-comment' },
    });
    await call<Promise<void>>(panel, 'updateComment', t, comment, 'replacement');
    const after = await readMd(app, 't.md');
    const lines = after.split('\n');
    expect(lines[1]).toBe('    not-a-comment');
  });

  it('file not found → no-op', async () => {
    const { panel } = await makePanel({ 't.md': '- [ ] x' });
    const t = task({
      title: 'x',
      source: {
        filePath: 'missing.md',
        line: 0,
        originalMarkdown: '- [ ] x',
        originalBlock: '- [ ] x',
      },
    });
    const comment = taskComment({ text: 'x' });
    await expect(call<Promise<boolean>>(panel, 'updateComment', t, comment, 'y')).resolves.toBe(
      false,
    );
  });
});

describe('RightPanel.deleteComment', () => {
  it('valid index removes the comment line', async () => {
    const content = '- [ ] task\n  - 2026-06-20: c1\n  - 2026-06-21: c2\n- [ ] other';
    const { panel, app } = await makePanel({ 't.md': content });
    const t = task({
      title: 'task',
      source: {
        filePath: 't.md',
        line: 0,
        originalMarkdown: '- [ ] task',
        originalBlock: '- [ ] task',
      },
    });
    const comment = taskComment({ text: 'c1', date: '2026-06-20' });
    await call<Promise<void>>(panel, 'deleteComment', t, comment);
    const after = await readMd(app, 't.md');
    const lines = after.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('- [ ] task');
    expect(lines[1]).toContain('c2');
    expect(lines[2]).toBe('- [ ] other');
  });

  it('out-of-range line: splice at non-existent index → no-op on content (CURRENT BEHAVIOR)', async () => {
    const content = '- [ ] task\n- [ ] other';
    const { panel, app } = await makePanel({ 't.md': content });
    const t = task({
      title: 'task',
      source: {
        filePath: 't.md',
        line: 0,
        originalMarkdown: '- [ ] task',
        originalBlock: '- [ ] task',
      },
    });
    // line 99 doesn't exist; splice(99,1) on a 2-element array is a no-op
    const comment = taskComment({ text: 'ghost', ref: { relativeLine: 99 } });
    await call<Promise<void>>(panel, 'deleteComment', t, comment);
    const after = await readMd(app, 't.md');
    expect(after).toBe(content);
  });

  it('file not found → no-op', async () => {
    const { panel } = await makePanel({ 't.md': '- [ ] x' });
    const t = task({
      title: 'x',
      source: {
        filePath: 'missing.md',
        line: 0,
        originalMarkdown: '- [ ] x',
        originalBlock: '- [ ] x',
      },
    });
    const comment = taskComment({ text: 'x', ref: { relativeLine: 0 } });
    await expect(call<Promise<boolean>>(panel, 'deleteComment', t, comment)).resolves.toBe(false);
  });
});

describe('RightPanel.updatePriority', () => {
  it('A → appends 🔺 (highest)', async () => {
    const { panel, app } = await makePanel({ 't.md': '- [ ] task' });
    const t = task({
      title: 'task',
      priority: 'D',
      source: {
        filePath: 't.md',
        line: 0,
        originalMarkdown: '- [ ] task',
        originalBlock: '- [ ] task',
      },
    });
    await call<Promise<void>>(panel, 'updatePriority', t, 'A');
    const after = await readMd(app, 't.md');
    expect(after).toContain('🔺');
  });

  it('B → appends ⏫', async () => {
    const { panel, app } = await makePanel({ 't.md': '- [ ] task' });
    const t = task({
      title: 'task',
      priority: 'D',
      source: {
        filePath: 't.md',
        line: 0,
        originalMarkdown: '- [ ] task',
        originalBlock: '- [ ] task',
      },
    });
    await call<Promise<void>>(panel, 'updatePriority', t, 'B');
    const after = await readMd(app, 't.md');
    expect(after).toContain('⏫');
  });

  it('C → sets Medium priority (🔼), replacing any existing emoji', async () => {
    const { panel, app } = await makePanel({ 't.md': '- [ ] task 🔺' });
    const t = task({
      title: 'task',
      priority: 'A',
      source: {
        filePath: 't.md',
        line: 0,
        originalMarkdown: '- [ ] task 🔺',
        originalBlock: '- [ ] task 🔺',
      },
    });
    await call<Promise<void>>(panel, 'updatePriority', t, 'C');
    const after = await readMd(app, 't.md');
    // C maps to 🔼 (Medium). The old 🔺 should be stripped and 🔼 appended.
    expect(after).not.toContain('🔺');
    expect(after).toContain('🔼');
  });

  it('D → strips all priority emojis, appends nothing (Normal = no emoji)', async () => {
    const { panel, app } = await makePanel({ 't.md': '- [ ] task 🔺' });
    const t = task({
      title: 'task',
      priority: 'A',
      source: {
        filePath: 't.md',
        line: 0,
        originalMarkdown: '- [ ] task 🔺',
        originalBlock: '- [ ] task 🔺',
      },
    });
    await call<Promise<void>>(panel, 'updatePriority', t, 'D');
    const after = await readMd(app, 't.md');
    // FU-30: D is not in PRIORITY_MAP, so no emoji is appended
    expect(after).not.toContain('🔺');
    expect(after).not.toContain('⏫');
    expect(after).not.toContain('🔼');
    expect(after).not.toContain('🔽');
    expect(after).not.toContain('⏬');
    expect(after).toBe('- [ ] task');
  });

  it('E → appends 🔽', async () => {
    const { panel, app } = await makePanel({ 't.md': '- [ ] task' });
    const t = task({
      title: 'task',
      priority: 'D',
      source: {
        filePath: 't.md',
        line: 0,
        originalMarkdown: '- [ ] task',
        originalBlock: '- [ ] task',
      },
    });
    await call<Promise<void>>(panel, 'updatePriority', t, 'E');
    const after = await readMd(app, 't.md');
    expect(after).toContain('🔽');
  });

  it('F → appends ⏬', async () => {
    const { panel, app } = await makePanel({ 't.md': '- [ ] task' });
    const t = task({
      title: 'task',
      priority: 'D',
      source: {
        filePath: 't.md',
        line: 0,
        originalMarkdown: '- [ ] task',
        originalBlock: '- [ ] task',
      },
    });
    await call<Promise<void>>(panel, 'updatePriority', t, 'F');
    const after = await readMd(app, 't.md');
    expect(after).toContain('⏬');
  });

  it('replaces existing priority emoji with new one', async () => {
    const { panel, app } = await makePanel({ 't.md': '- [ ] task 🔺' });
    const t = task({
      title: 'task',
      priority: 'A',
      source: {
        filePath: 't.md',
        line: 0,
        originalMarkdown: '- [ ] task 🔺',
        originalBlock: '- [ ] task 🔺',
      },
    });
    await call<Promise<void>>(panel, 'updatePriority', t, 'F');
    const after = await readMd(app, 't.md');
    expect(after).not.toContain('🔺');
    expect(after).toContain('⏬');
  });

  it('file not found → no-op', async () => {
    const { panel } = await makePanel({ 't.md': '- [ ] x' });
    const t = task({
      title: 'x',
      source: {
        filePath: 'missing.md',
        line: 0,
        originalMarkdown: '- [ ] x',
        originalBlock: '- [ ] x',
      },
    });
    await expect(call<Promise<void>>(panel, 'updatePriority', t, 'A')).resolves.toBeUndefined();
  });
});

describe('RightPanel.removeTag', () => {
  it('routes root removal and nested addition through typed patches without direct vault writes', async () => {
    const app = await createAppWithFiles({ 't.md': '- [ ] root #work\n  - [ ] child\n' });
    const state = new AppState();
    const rootRef: TaskRef = { filePath: 't.md', line: 0, revision: 'root' };
    const childRef = {
      parent: { type: 'task' as const, ref: rootRef },
      relativeLine: 1,
      originalBlock: '  - [ ] child',
    };
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'not-found',
      target: { type: 'task', ref: rootRef },
    });
    const tasks: TaskApplicationApi = {
      queries: {
        list: () => [],
        forCalendarDates: () => [],
        resolve: (target) => ({ type: 'not-found', ref: target }),
        subscribe: () => () => {},
      },
      execute,
    };
    const panel = new RightPanel(
      state,
      app,
      testStatusRegistry(),
      DEFAULT_SETTINGS,
      undefined,
      tasks,
    );
    const root = Object.assign(task({ source: { filePath: 't.md', line: 0 } }), { ref: rootRef });
    const child = Object.assign(task({ source: { filePath: 't.md', line: 1 } }), { ref: childRef });
    const process = vi.spyOn(app.vault, 'process');

    await call<Promise<void>>(panel, 'removeTag', root, '#work');
    await call<Promise<void>>(panel, 'addTag', child, 'child/next');

    expect(execute.mock.calls.map(([command]) => command)).toEqual([
      {
        type: 'patch',
        target: { type: 'task', ref: rootRef },
        patch: { tags: { remove: ['#work'] } },
      },
      {
        type: 'patch',
        target: { type: 'subtask', ref: childRef },
        patch: { tags: { add: ['child/next'] } },
      },
    ]);
    expect(process).not.toHaveBeenCalled();
  });

  it('removes a standalone tag (with leading #)', async () => {
    const { panel, app } = await makePanel({ 't.md': '- [ ] task #work' });
    const t = task({
      title: 'task',
      source: {
        filePath: 't.md',
        line: 0,
        originalMarkdown: '- [ ] task #work',
        originalBlock: '- [ ] task #work',
      },
    });
    await call<Promise<void>>(panel, 'removeTag', t, '#work');
    const after = await readMd(app, 't.md');
    expect(after).not.toContain('#work');
    expect(after).toContain('task');
  });

  it('removes a standalone tag (without leading #)', async () => {
    const { panel, app } = await makePanel({ 't.md': '- [ ] task #work' });
    const t = task({
      title: 'task',
      source: {
        filePath: 't.md',
        line: 0,
        originalMarkdown: '- [ ] task #work',
        originalBlock: '- [ ] task #work',
      },
    });
    await call<Promise<void>>(panel, 'removeTag', t, 'work');
    const after = await readMd(app, 't.md');
    expect(after).not.toContain('#work');
  });

  it('subtag guard: does not remove #work when only #work/deep matches (and vice versa)', async () => {
    const { panel, app } = await makePanel({ 't.md': '- [ ] task #work/deep' });
    const t = task({
      title: 'task',
      source: {
        filePath: 't.md',
        line: 0,
        originalMarkdown: '- [ ] task #work/deep',
        originalBlock: '- [ ] task #work/deep',
      },
    });
    // Removing "#work" should NOT remove "#work/deep" because the regex uses a
    // negative lookahead for word chars or subtag separator: (?![\w/-])
    await call<Promise<void>>(panel, 'removeTag', t, '#work');
    const after = await readMd(app, 't.md');
    expect(after).toContain('#work/deep');
  });

  it('removes #work and leaves #work/deep intact when both present', async () => {
    const content = '- [ ] task #work #work/deep';
    const { panel, app } = await makePanel({ 't.md': content });
    const t = task({
      title: 'task',
      source: { filePath: 't.md', line: 0, originalMarkdown: content, originalBlock: content },
    });
    await call<Promise<void>>(panel, 'removeTag', t, '#work');
    const after = await readMd(app, 't.md');
    // #work (standalone) is removed; #work/deep is kept due to the (?![\w/-]) lookahead
    expect(after).not.toMatch(/#work(?!\/)/u);
    expect(after).toContain('#work/deep');
  });

  it('file not found → no-op', async () => {
    const { panel } = await makePanel({ 't.md': '- [ ] x' });
    const t = task({
      title: 'x',
      source: {
        filePath: 'missing.md',
        line: 0,
        originalMarkdown: '- [ ] x',
        originalBlock: '- [ ] x',
      },
    });
    await expect(call<Promise<void>>(panel, 'removeTag', t, '#work')).resolves.toBeUndefined();
  });
});

describe('RightPanel.addTag', () => {
  it('without #: adds the # prefix', async () => {
    const { panel, app } = await makePanel({ 't.md': '- [ ] task' });
    const t = task({
      title: 'task',
      source: {
        filePath: 't.md',
        line: 0,
        originalMarkdown: '- [ ] task',
        originalBlock: '- [ ] task',
      },
    });
    await call<Promise<void>>(panel, 'addTag', t, 'work');
    const after = await readMd(app, 't.md');
    expect(after).toContain('#work');
  });

  it('with #: keeps the # as-is', async () => {
    const { panel, app } = await makePanel({ 't.md': '- [ ] task' });
    const t = task({
      title: 'task',
      source: {
        filePath: 't.md',
        line: 0,
        originalMarkdown: '- [ ] task',
        originalBlock: '- [ ] task',
      },
    });
    await call<Promise<void>>(panel, 'addTag', t, '#work');
    const after = await readMd(app, 't.md');
    expect(after).toContain('#work');
    expect(after.match(/#/gu)).toHaveLength(1);
  });

  it('file not found → no-op', async () => {
    const { panel } = await makePanel({ 't.md': '- [ ] x' });
    const t = task({
      title: 'x',
      source: {
        filePath: 'missing.md',
        line: 0,
        originalMarkdown: '- [ ] x',
        originalBlock: '- [ ] x',
      },
    });
    await expect(call<Promise<void>>(panel, 'addTag', t, 'work')).resolves.toBeUndefined();
  });
});

describe('RightPanel.deleteTask', () => {
  it('with subtaskRange: removes the whole block (from..to inclusive)', async () => {
    const content = '- [ ] parent\n    - [ ] sub\n- [ ] other';
    const { panel, state, app } = await makePanel({ 't.md': content });
    const t = task({
      title: 'parent',
      source: {
        filePath: 't.md',
        line: 0,
        originalMarkdown: '- [ ] parent',
        originalBlock: '- [ ] parent',
      },
    });
    state.set('taskStack', [t]);
    await call<Promise<void>>(panel, 'deleteTask', t);
    const after = await readMd(app, 't.md');
    expect(after).toBe('- [ ] other');
  });

  // CURRENT BEHAVIOR (follow-up: FU-26): deleteTask without subtaskRange only removes
  // the single task line (from = to = task.line). If the task has descendants (subtasks,
  // deleteTaskBlock now uses indentation scanning to find the actual block end,
  // so even without subtaskRange the entire indented block is deleted correctly.
  it('without subtaskRange: deletes the task and all indented descendants via indentation scan', async () => {
    const content = '- [ ] parent\n    - [ ] sub\n    - > desc line\n- [ ] other';
    const { panel, state, app } = await makePanel({ 't.md': content });
    const t = task({
      title: 'parent',
      source: {
        filePath: 't.md',
        line: 0,
        originalMarkdown: '- [ ] parent',
        originalBlock: '- [ ] parent',
      },
    });
    state.set('taskStack', [t]);
    await call<Promise<void>>(panel, 'deleteTask', t);
    const after = await readMd(app, 't.md');
    // Parent and all indented children are removed; the next sibling survives.
    expect(after).not.toContain('- [ ] parent');
    expect(after).not.toContain('- [ ] sub');
    expect(after).not.toContain('- > desc line');
    expect(after).toContain('- [ ] other');
  });

  it('clears taskStack after deletion', async () => {
    const { panel, state, app } = await makePanel({ 't.md': '- [ ] task\n- [ ] other' });
    const t = task({
      title: 'task',
      source: {
        filePath: 't.md',
        line: 0,
        originalMarkdown: '- [ ] task',
        originalBlock: '- [ ] task',
      },
    });
    state.set('taskStack', [t]);
    await call<Promise<void>>(panel, 'deleteTask', t);
    expect(state.get('taskStack')).toEqual([]);
    const after = await readMd(app, 't.md');
    expect(after).toBe('- [ ] other');
  });

  it('file not found → no-op, does not clear stack (early return before state.set)', async () => {
    const { panel, state } = await makePanel({ 't.md': '- [ ] x' });
    const t = task({
      title: 'x',
      source: {
        filePath: 'missing.md',
        line: 0,
        originalMarkdown: '- [ ] x',
        originalBlock: '- [ ] x',
      },
    });
    state.set('taskStack', [t]);
    await call<Promise<void>>(panel, 'deleteTask', t);
    // CURRENT BEHAVIOR: `if (!(file instanceof TFile)) return;` runs before state.set,
    // so the stack is NOT cleared when the file is missing.
    expect(state.get('taskStack')).toHaveLength(1);
  });
});

describe('openInFile (used by RightPanel)', () => {
  it('calls workspace.getLeaf("tab") + leaf.openFile(file) + editor.setCursor', async () => {
    const { app } = await makePanel({ 't.md': '- [ ] task' });
    const t = task({
      title: 'task',
      source: {
        filePath: 't.md',
        line: 3,
        originalMarkdown: '- [ ] task',
        originalBlock: '- [ ] task',
      },
    });
    // Build a leaf with a view + editor so openInFile can call setCursor.
    const leaf = app.workspace.getLeaf('tab');
    const setCursor = vi.fn();
    (leaf as unknown as { view: unknown }).view = { editor: { setCursor } };
    // getLeaf('tab') creates a new leaf each call, so spy to return our pre-seeded leaf.
    const getLeafSpy = vi.spyOn(app.workspace, 'getLeaf').mockImplementation(() => leaf);
    await openInFile(app, t);
    expect(getLeafSpy).toHaveBeenCalledWith('tab');
    expect((leaf as unknown as { file?: { path: string } }).file?.path).toBe('t.md');
    expect(setCursor).toHaveBeenCalledWith({ line: 3, ch: 0 });
    getLeafSpy.mockRestore();
  });

  it('file not found (not a TFile) → no-op, does not throw', async () => {
    const { app } = await makePanel({ 't.md': '- [ ] x' });
    const t = task({
      title: 'x',
      source: {
        filePath: 'missing.md',
        line: 0,
        originalMarkdown: '- [ ] x',
        originalBlock: '- [ ] x',
      },
    });
    await expect(openInFile(app, t)).resolves.toBeUndefined();
  });
});

describe('RightPanel — blockquote write-path preserves "> " formatting', () => {
  it('updateTaskTitle preserves the blockquote prefix and metadata', async () => {
    const { panel, app } = await makePanel(
      { 't.md': '> - [ ] old 📅 2026-06-20' },
      DEFAULT_SETTINGS,
      [{ path: 't.md', items: [{ task: ' ', parent: -1, line: 0 }] }],
    );
    const t = task({
      title: 'old',
      planning: { due: '2026-06-20' },
      source: {
        filePath: 't.md',
        line: 0,
        originalMarkdown: '> - [ ] old 📅 2026-06-20',
        originalBlock: '> - [ ] old 📅 2026-06-20',
      },
    });
    const indexed = (panel as unknown as { tasks: TaskApplicationApi }).tasks.queries.list({
      filePath: 't.md',
    })[0];
    expect(indexed).toBeDefined();
    Object.assign(t, { ref: indexed!.ref });
    await call<Promise<void>>(panel, 'updateTaskTitle', t, 'new');
    const after = await readMd(app, 't.md');
    expect(after).toBe('> - [ ] new 📅 2026-06-20');
  });

  it('addSubTask nests a quoted child under a blockquote parent', async () => {
    const { panel, app } = await makePanel(
      { 't.md': '> - [ ] parent\n> - [ ] other' },
      DEFAULT_SETTINGS,
      [
        {
          path: 't.md',
          items: [
            { task: ' ', parent: -1, line: 0 },
            { task: ' ', parent: -1, line: 1 },
          ],
        },
      ],
    );
    const t = task({
      title: 'parent',
      source: {
        filePath: 't.md',
        line: 0,
        originalMarkdown: '> - [ ] parent',
        originalBlock: '> - [ ] parent',
      },
    });
    await call<Promise<void>>(panel, 'addSubTask', t, 'child');
    const lines = (await readMd(app, 't.md')).split('\n');
    expect(lines[1]).toBe('>   - [ ] child ➕ 2026-07-14');
    expect(lines[2]).toBe('> - [ ] other');
  });

  it('updateDescription writes a quoted description line', async () => {
    const { panel, app } = await makePanel(
      { 't.md': '> - [ ] task\n> - [ ] other' },
      DEFAULT_SETTINGS,
      [
        {
          path: 't.md',
          items: [
            { task: ' ', parent: -1, line: 0 },
            { task: ' ', parent: -1, line: 1 },
          ],
        },
      ],
    );
    const t = task({
      title: 'task',
      source: {
        filePath: 't.md',
        line: 0,
        originalMarkdown: '> - [ ] task',
        originalBlock: '> - [ ] task',
      },
    });
    await call<Promise<void>>(panel, 'updateDescription', t, 'a desc');
    const after = await readMd(app, 't.md');
    expect(after).toContain('>   - > a desc');
    expect(after).toContain('> - [ ] other');
  });

  it('addComment writes a quoted comment line under a blockquote task', async () => {
    const { panel, app } = await makePanel(
      { 't.md': '> - [ ] task\n> - [ ] other' },
      DEFAULT_SETTINGS,
      [
        {
          path: 't.md',
          items: [
            { task: ' ', parent: -1, line: 0 },
            { task: ' ', parent: -1, line: 1 },
          ],
        },
      ],
    );
    const t = task({
      title: 'task',
      source: {
        filePath: 't.md',
        line: 0,
        originalMarkdown: '> - [ ] task',
        originalBlock: '> - [ ] task',
      },
    });
    const commentList = freshContainer();
    const inputEl = freshContainer().createEl('textarea');
    await call<Promise<void>>(panel, 'addComment', t, 'note', commentList, inputEl);
    const lines = (await readMd(app, 't.md')).split('\n');
    expect(lines[1]).toBe('>   - 2026-07-14: note');
  });

  it('updateComment preserves the blockquote prefix on a quoted comment', async () => {
    const content = '> - [ ] task\n>   - 2026-06-20: old\n> - [ ] other';
    const { panel, app } = await makePanel({ 't.md': content }, DEFAULT_SETTINGS, [
      {
        path: 't.md',
        items: [{ task: ' ', parent: -1, line: 0 }],
      },
    ]);
    const t = task({
      title: 'task',
      source: {
        filePath: 't.md',
        line: 0,
        originalMarkdown: '> - [ ] task',
        originalBlock: '> - [ ] task',
      },
    });
    const comment = taskComment({
      text: 'old',
      date: '2026-06-20',
      ref: { originalMarkdown: '>   - 2026-06-20: old' },
    });
    await call<Promise<void>>(panel, 'updateComment', t, comment, 'new');
    const lines = (await readMd(app, 't.md')).split('\n');
    expect(lines[1]).toBe('>   - 2026-06-20: new');
  });
});
