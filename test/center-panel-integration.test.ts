import moment from 'moment';
import { TFile, type App } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { CenterPanel } from '../src/panels/CenterPanel';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { CalendarSettings } from '../src/settings/types';
import { StatusRegistry } from '../src/status/StatusRegistry';
import type {
  LocalDate,
  TaskApplicationApi,
  TaskCommandResult,
  TaskIndexEvent,
  TaskQueryApi,
  TaskSnapshot,
} from '../src/tasks';
import type { TaskQuery } from '../src/tasks/application/TaskApplicationApi';
import { TodayView } from '../src/views/TodayView';
import { WeekTimeGridView } from '../src/views/WeekTimeGridView';
import {
  configuredTaskApplication,
  createAppWithFiles,
  fixedToday,
  flushMicrotasks,
  freshContainer,
  seedTaskCache,
  task,
  useRealMoment,
} from './helpers';

const TODAY = moment().format('YYYY-MM-DD');

useRealMoment();

function queryApiForSnapshots(getTasks: () => readonly TaskSnapshot[]): TaskQueryApi {
  const list = (query?: TaskQuery): readonly TaskSnapshot[] =>
    getTasks()
      .filter((item) => query?.filePath === undefined || item.source.filePath === query.filePath)
      .filter(
        (item) => query?.folder === undefined || item.source.filePath.startsWith(query.folder),
      )
      .filter((item) => query?.tag === undefined || item.tags.includes(query.tag))
      .filter((item) => query?.statuses === undefined || query.statuses.includes(item.status))
      .filter((item) => {
        if (query?.dateRange === undefined) return true;
        const dates = [
          item.planning.due,
          item.planning.scheduled,
          item.planning.start,
          item.presentation.dailyNoteDate,
        ].filter((date): date is LocalDate => date !== undefined);
        return dates.some((date) => date >= query.dateRange!.from && date <= query.dateRange!.to);
      });

  return {
    list,
    forCalendarDates: (dates) => {
      const wanted = new Set(dates);
      return getTasks().filter((item) =>
        [
          item.planning.due,
          item.planning.scheduled,
          item.planning.start,
          item.presentation.dailyNoteDate,
        ].some((date) => date !== undefined && wanted.has(date)),
      );
    },
    resolve: (ref) => {
      const found = getTasks().find(
        (item) => item.ref.filePath === ref.filePath && item.ref.line === ref.line,
      );
      return found ? { type: 'exact', task: found } : { type: 'not-found', ref };
    },
    subscribe: () => () => {},
  };
}

function makeStaticPanel(
  state: AppState,
  snapshots: readonly TaskSnapshot[],
  settings: CalendarSettings = DEFAULT_SETTINGS,
  app: App = {} as App,
): CenterPanel {
  return new CenterPanel(
    state,
    app,
    settings,
    queryApiForSnapshots(() => snapshots),
    new StatusRegistry(settings.taskStatuses),
  );
}

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
function call<T>(panel: CenterPanel, method: string, ...args: unknown[]): Promise<T> | T {
  const fn = (panel as unknown as Record<string, (...a: unknown[]) => T>)[method]!;
  return fn.call(panel, ...args);
}

/**
 * Wire up a real CenterPanel + real task index/application API + real AppState.
 * Vault is pre-populated with `files`; each seeded file also gets a task cache.
 */
async function makePanel(
  files: Record<string, string>,
  settings: CalendarSettings = DEFAULT_SETTINGS,
  seeds: Array<{ path: string; items: Array<{ task: string; parent: number; line: number }> }> = [],
): Promise<{
  panel: CenterPanel;
  state: AppState;
  index: TaskQueryApi;
  tasks: TaskApplicationApi;
  app: App;
}> {
  const app = await createAppWithFiles(files);
  for (const s of seeds) seedTaskCache(app, s.path, s.items);
  const state = new AppState();
  const taskApplication = configuredTaskApplication(app, settings);
  await taskApplication.index.initialize();
  const panel = new CenterPanel(
    state,
    app,
    settings,
    taskApplication.index,
    taskApplication.statusRegistry,
    undefined,
    null,
    null,
    taskApplication.tasks,
  );
  return {
    panel,
    state,
    index: taskApplication.index,
    tasks: taskApplication.tasks,
    app,
  };
}

describe('CenterPanel.createTask', () => {
  it("sel='today' creates through TaskApplicationApi in customFilePath when addToToday=false", async () => {
    const settings: CalendarSettings = {
      ...DEFAULT_SETTINGS,
      addToToday: false,
      customFilePath: 'inbox.md',
      taskPrefix: '',
    };
    const { panel, state, app } = await makePanel({ 'inbox.md': '- [ ] existing' }, settings);
    state.set('selectedList', 'today');
    fixedToday(TODAY);
    await call<void>(panel, 'createTask', 'buy milk');
    const content = await readMd(app, 'inbox.md');
    expect(content).toContain(`- [ ] buy milk 📅 ${TODAY}`);
  });

  it("sel='upcoming' uses the same configured TaskApplicationApi route as today", async () => {
    const settings: CalendarSettings = {
      ...DEFAULT_SETTINGS,
      addToToday: false,
      customFilePath: 'inbox.md',
      taskPrefix: '',
    };
    const { panel, state, app } = await makePanel({ 'inbox.md': '' }, settings);
    state.set('selectedList', 'upcoming');
    fixedToday(TODAY);
    await call<void>(panel, 'createTask', 'future task');
    const content = await readMd(app, 'inbox.md');
    // CURRENT BEHAVIOR: upcoming uses today's date as the due date (same as 'today')
    expect(content).toContain(`- [ ] future task 📅 ${TODAY}`);
  });

  it("sel='inbox' tag mode appends task line with inboxTag to customFilePath", async () => {
    const settings: CalendarSettings = {
      ...DEFAULT_SETTINGS,
      addToToday: false,
      customFilePath: 'Inbox.md',
      inbox: { mode: 'tag', tag: '#inbox', removeTagOnAssign: true },
    };
    const { panel, state, app } = await makePanel({ 'Inbox.md': '- [ ] existing' }, settings);
    state.set('selectedList', 'inbox');
    await call<void>(panel, 'createTask', 'new inbox task');
    const content = await readMd(app, 'Inbox.md');
    expect(content).toContain('- [ ] new inbox task #inbox');
  });

  it("sel='inbox' untagged mode appends plain task line to customFilePath", async () => {
    const settings: CalendarSettings = {
      ...DEFAULT_SETTINGS,
      addToToday: false,
      customFilePath: 'Inbox.md',
      inbox: { mode: 'untagged', tag: '', removeTagOnAssign: true },
    };
    const { panel, state, app } = await makePanel({ 'Inbox.md': '- [ ] existing' }, settings);
    state.set('selectedList', 'inbox');
    await call<void>(panel, 'createTask', 'plain task');
    const content = await readMd(app, 'Inbox.md');
    expect(content).toContain('- [ ] plain task');
    expect(content).not.toContain('#inbox');
  });

  it("sel={type:'tag'} appends task line with the tag to customFilePath", async () => {
    const settings: CalendarSettings = {
      ...DEFAULT_SETTINGS,
      addToToday: false,
      customFilePath: 'Inbox.md',
    };
    const { panel, state, app } = await makePanel({ 'Inbox.md': '' }, settings);
    state.set('selectedList', { type: 'tag', tag: '#work' });
    await call<void>(panel, 'createTask', 'tagged task');
    const content = await readMd(app, 'Inbox.md');
    expect(content).toContain('- [ ] tagged task #work');
  });

  it('routes the inbox body/tag rule through TaskApplicationApi to the configured daily note', async () => {
    const settings: CalendarSettings = {
      ...DEFAULT_SETTINGS,
      addToToday: true,
      inbox: { mode: 'tag', tag: '#inbox', removeTagOnAssign: true },
      dailyNoteProvider: 'manual',
      manualDailyNotePath: 'periodic/daily/YYYY-MM-DD',
    };
    const { panel, state, app } = await makePanel(
      { [`periodic/daily/${TODAY}.md`]: '# Today\n' },
      settings,
    );
    state.set('selectedList', 'inbox');
    fixedToday(TODAY);
    await call<void>(panel, 'createTask', 'today inbox task');
    const content = await readMd(app, `periodic/daily/${TODAY}.md`);
    expect(content).toContain('- [ ] today inbox task #inbox');
  });
});

describe('CenterPanel.deleteTask', () => {
  it('single-line task (no subtaskRange) removes exactly one line', async () => {
    const { panel, index, app } = await makePanel(
      { 't.md': '- [ ] keep\n- [ ] delete me\n- [ ] keep2' },
      DEFAULT_SETTINGS,
      [{ path: 't.md', items: [{ task: ' ', parent: -1, line: 1 }] }],
    );
    const target = index.list().find((item) => item.title === 'delete me')!;
    await call<void>(panel, 'deleteTask', target);
    const content = await readMd(app, 't.md');
    expect(content).toBe('- [ ] keep\n- [ ] keep2');
  });

  it('multi-line root task removes its complete source block', async () => {
    // The root snapshot owns the indented subtask in source.originalBlock.
    const content = '- [ ] parent\n    - [ ] sub\n- [ ] other';
    const { panel, index, app } = await makePanel({ 't.md': content }, DEFAULT_SETTINGS, [
      { path: 't.md', items: [{ task: ' ', parent: -1, line: 0 }] },
    ]);
    const target = index.list()[0]!;
    await call<void>(panel, 'deleteTask', target);
    const after = await readMd(app, 't.md');
    expect(after).toBe('- [ ] other');
  });

  it('file not found (task source path missing from vault) is a no-op', async () => {
    const { panel, index } = await makePanel({ 't.md': '- [ ] x' }, DEFAULT_SETTINGS, [
      { path: 't.md', items: [{ task: ' ', parent: -1, line: 0 }] },
    ]);
    const original = index.list()[0]!;
    const target: TaskSnapshot = {
      ...original,
      ref: { ...original.ref, filePath: 'does-not-exist.md' },
      source: { ...original.source, filePath: 'does-not-exist.md' },
    };
    await expect(call<void>(panel, 'deleteTask', target)).resolves.toBeUndefined();
  });

  it('clears taskStack when the deleted task was the stack top', async () => {
    const { panel, state, index } = await makePanel({ 't.md': '- [ ] x' }, DEFAULT_SETTINGS, [
      { path: 't.md', items: [{ task: ' ', parent: -1, line: 0 }] },
    ]);
    const target = index.list()[0]!;
    state.set('taskStack', [target]);
    await call<void>(panel, 'deleteTask', target);
    expect(state.get('taskStack')).toEqual([]);
  });
});

describe('CenterPanel.rescheduleTask', () => {
  it('task with due date → 📅 replaced with targetDate', async () => {
    const { panel, index, app } = await makePanel(
      { 't.md': '- [ ] task 📅 2026-06-20' },
      DEFAULT_SETTINGS,
      [{ path: 't.md', items: [{ task: ' ', parent: -1, line: 0 }] }],
    );
    const target = index.list()[0]!;
    await call<void>(panel, 'rescheduleTask', `${target.source.filePath}:::0`, '2026-06-28');
    const content = await readMd(app, 't.md');
    expect(content).toBe('- [ ] task 📅 2026-06-28');
  });

  it('task with scheduled (no due) → ⏳ replaced with targetDate', async () => {
    const { panel, index, app } = await makePanel(
      { 't.md': '- [ ] task ⏳ 2026-06-20' },
      DEFAULT_SETTINGS,
      [{ path: 't.md', items: [{ task: ' ', parent: -1, line: 0 }] }],
    );
    const target = index.list()[0]!;
    await call<void>(panel, 'rescheduleTask', `${target.source.filePath}:::0`, '2026-06-28');
    const content = await readMd(app, 't.md');
    expect(content).toBe('- [ ] task ⏳ 2026-06-28');
  });

  it('task with no due/scheduled → 📅 targetDate appended', async () => {
    const { panel, index, app } = await makePanel(
      { 't.md': '- [ ] plain task' },
      DEFAULT_SETTINGS,
      [{ path: 't.md', items: [{ task: ' ', parent: -1, line: 0 }] }],
    );
    const target = index.list()[0]!;
    await call<void>(panel, 'rescheduleTask', `${target.source.filePath}:::0`, '2026-06-28');
    const content = await readMd(app, 't.md');
    expect(content).toBe('- [ ] plain task 📅 2026-06-28');
  });

  it('invalid dragData (no ::: separator) → no-op', async () => {
    const { panel, index, app } = await makePanel(
      { 't.md': '- [ ] task 📅 2026-06-20' },
      DEFAULT_SETTINGS,
      [{ path: 't.md', items: [{ task: ' ', parent: -1, line: 0 }] }],
    );
    await call<void>(panel, 'rescheduleTask', 'bogus', '2026-06-28');
    const content = await readMd(app, 't.md');
    expect(content).toBe('- [ ] task 📅 2026-06-20');
    expect(index.list()[0]?.planning.due).toBe('2026-06-20');
  });

  it('task not found in the query index → no-op', async () => {
    const { panel, index, app } = await makePanel(
      { 't.md': '- [ ] task 📅 2026-06-20' },
      DEFAULT_SETTINGS,
      [{ path: 't.md', items: [{ task: ' ', parent: -1, line: 0 }] }],
    );
    // Reference a line that doesn't match any parsed task
    await call<void>(panel, 'rescheduleTask', 't.md:::999', '2026-06-28');
    const content = await readMd(app, 't.md');
    expect(content).toBe('- [ ] task 📅 2026-06-20');
    expect(index.list()[0]?.planning.due).toBe('2026-06-20');
  });

  // Task 26: dropping a previously-timed block onto the all-day/"No-time" row reuses this
  // same onDrop path (renderAllDayCell's generic onDrop callback) — the inverse of Round 2
  // Task 8's setTaskTimeFromDrop. A task carrying ⏰/⏱️ tokens must have both stripped, in
  // addition to the date move every onDrop call already performs.
  it('a previously-timed task dropped onto the all-day row has ⏰ time and ⏱️ duration stripped, date still moved', async () => {
    const { panel, index, app } = await makePanel(
      { 't.md': '- [ ] task 📅 2026-06-20 ⏰ 09:00 ⏱️ 1h30m' },
      DEFAULT_SETTINGS,
      [{ path: 't.md', items: [{ task: ' ', parent: -1, line: 0 }] }],
    );
    const target = index.list()[0]!;
    expect(target.planning.time).toBe('09:00');
    await call<void>(panel, 'rescheduleTask', `${target.source.filePath}:::0`, '2026-06-28');
    const content = await readMd(app, 't.md');
    expect(content).toBe('- [ ] task 📅 2026-06-28');
    expect(content).not.toContain('⏰');
    expect(content).not.toContain('⏱️');
  });

  it('a task with time but no duration dropped onto the all-day row strips only ⏰', async () => {
    const { panel, index, app } = await makePanel(
      { 't.md': '- [ ] task 📅 2026-06-20 ⏰ 09:00' },
      DEFAULT_SETTINGS,
      [{ path: 't.md', items: [{ task: ' ', parent: -1, line: 0 }] }],
    );
    const target = index.list()[0]!;
    await call<void>(panel, 'rescheduleTask', `${target.source.filePath}:::0`, '2026-06-28');
    const content = await readMd(app, 't.md');
    expect(content).toBe('- [ ] task 📅 2026-06-28');
  });

  it('a task with no time is unaffected by the time/duration-stripping branch (unchanged prior behavior)', async () => {
    const { panel, index, app } = await makePanel(
      { 't.md': '- [ ] task 📅 2026-06-20' },
      DEFAULT_SETTINGS,
      [{ path: 't.md', items: [{ task: ' ', parent: -1, line: 0 }] }],
    );
    const target = index.list()[0]!;
    await call<void>(panel, 'rescheduleTask', `${target.source.filePath}:::0`, '2026-06-28');
    const content = await readMd(app, 't.md');
    expect(content).toBe('- [ ] task 📅 2026-06-28');
  });
});

describe('CenterPanel.renderWithGrouping (date grouping)', () => {
  fixedToday('2026-06-25');

  /**
   * Call the private renderWithGrouping directly with groupBy='date' to exercise
   * the bucketing logic in isolation.
   */
  function renderWithGroupingByDate(tasks: TaskSnapshot[]): HTMLElement {
    const state = new AppState();
    state.set('centerListViewState', {
      groupBy: 'date',
      sortBy: { field: 'date', dir: 'asc' },
      statusGroups: undefined,
      filters: [],
    });
    const panel = makeStaticPanel(state, tasks);
    const container = freshContainer();
    void call<void>(panel, 'renderWithGrouping', container, tasks);
    return container;
  }

  it('buckets tasks into Overdue/Today/Tomorrow/Upcoming with counts', () => {
    const tasks = [
      task({
        title: 'overdue',
        planning: { due: '2026-06-20' },
        source: { filePath: 't.md', line: 0 },
      }),
      task({
        title: 'today',
        planning: { due: '2026-06-25' },
        source: { filePath: 't.md', line: 1 },
      }),
      task({
        title: 'tomorrow',
        planning: { due: '2026-06-26' },
        source: { filePath: 't.md', line: 2 },
      }),
      task({
        title: 'upcoming',
        planning: { due: '2026-07-05' },
        source: { filePath: 't.md', line: 3 },
      }),
    ];
    const container = renderWithGroupingByDate(tasks);
    const headers = container.querySelectorAll('.tc-group-header');
    const labels = Array.from(headers).map((h) => h.textContent?.trim());
    expect(labels).toContain('Overdue  1');
    expect(labels).toContain('Today  1');
    expect(labels).toContain('Tomorrow  1');
    expect(labels).toContain('Upcoming  1');
  });

  it('empty groups are skipped (only non-empty groups render)', () => {
    const tasks = [
      task({
        title: 'today only',
        planning: { due: '2026-06-25' },
        source: { filePath: 't.md', line: 0 },
      }),
    ];
    const container = renderWithGroupingByDate(tasks);
    const headers = container.querySelectorAll('.tc-group-header');
    const labels = Array.from(headers).map((h) => h.textContent?.trim());
    expect(labels).toEqual(['Today  1']);
  });

  it('no-date task falls into "No date" bucket (not Overdue)', () => {
    const tasks = [task({ title: 'no date', source: { filePath: 't.md', line: 0 } })];
    const container = renderWithGroupingByDate(tasks);
    const headers = container.querySelectorAll('.tc-group-header');
    const labels = Array.from(headers).map((h) => h.textContent?.trim());
    expect(labels).toEqual(['No date  1']);
  });
});

describe('CenterPanel.renderSearch', () => {
  fixedToday('2026-06-25');

  it('renders matching task cards for a query', () => {
    const tasks = [
      task({ title: 'buy milk', source: { filePath: 'a.md', line: 0 } }),
      task({ title: 'walk dog', source: { filePath: 'b.md', line: 0 } }),
    ];
    const state = new AppState();
    state.set('mode', 'search');
    state.set('searchQuery', 'milk');
    const panel = makeStaticPanel(state, tasks);
    panel.mount(freshContainer());
    const cards = panel['el'].querySelectorAll('.tc-task-card');
    expect(cards).toHaveLength(1);
    // Title renders via MarkdownRenderer (mocked as a noop in tests), so identity
    // is asserted via the card's stable file-path/line dataset instead of title text.
    expect(cards[0]?.querySelector('.tc-task-title')).toBeTruthy();
    expect((cards[0] as HTMLElement).dataset['filePath']).toBe('a.md');
    expect((cards[0] as HTMLElement).dataset['line']).toBe('0');
    panel.destroy();
  });

  it('clicking a result sets selectedList + mode + taskStack on state', () => {
    const t = task({
      title: 'buy milk',
      planning: { due: '2026-06-25' },
      source: { filePath: 'a.md', line: 0 },
    });
    const state = new AppState();
    state.set('mode', 'search');
    state.set('searchQuery', 'milk');
    const panel = makeStaticPanel(state, [t]);
    panel.mount(freshContainer());
    const card = panel['el'].querySelector<HTMLElement>('.tc-task-card')!;
    card.click();
    expect(state.get('mode')).toBe('tasks');
    expect(state.get('selectedList')).toBe('today');
    expect(state.get('taskStack')).toEqual([
      expect.objectContaining({
        ref: expect.objectContaining({ filePath: t.ref.filePath, line: t.ref.line }),
        title: t.title,
      }),
    ]);
    panel.destroy();
  });
});

describe('CenterPanel source note chip', () => {
  fixedToday('2026-06-25');

  function makeSearchPanel(
    tasks: TaskSnapshot[],
    settingsOverrides: Partial<typeof DEFAULT_SETTINGS> = {},
  ): CenterPanel {
    const state = new AppState();
    state.set('mode', 'search');
    state.set('searchQuery', tasks[0]?.title ?? '');
    const panel = makeStaticPanel(state, tasks, {
      ...DEFAULT_SETTINGS,
      ...settingsOverrides,
    });
    panel.mount(freshContainer());
    return panel;
  }

  it('sourceNoteDisplay always → chip shown for daily note task', () => {
    const t = task({
      title: 'daily task',
      planning: { due: '2026-06-25' },
      source: { filePath: 'periodic/daily/2026-06-25.md' },
      presentation: { dailyNoteDate: '2026-06-25' },
    });
    const panel = makeSearchPanel([t], { sourceNoteDisplay: 'always' });
    expect(panel['el'].querySelector('.tc-task-source-note')).not.toBeNull();
    panel.destroy();
  });

  it('sourceNoteDisplay never → no chip', () => {
    const t = task({
      title: 'project task',
      tags: ['#work'],
      planning: { due: '2026-06-25' },
      source: { filePath: 'Projects/alpha.md' },
    });
    const panel = makeSearchPanel([t], { sourceNoteDisplay: 'never' });
    expect(panel['el'].querySelector('.tc-task-source-note')).toBeNull();
    panel.destroy();
  });

  it('sourceNoteDisplay non-default → chip for project note', () => {
    const t = task({
      title: 'project task',
      planning: { due: '2026-06-25' },
      source: { filePath: 'Projects/alpha.md' },
    });
    const panel = makeSearchPanel([t], { sourceNoteDisplay: 'non-default' });
    const chip = panel['el'].querySelector('.tc-task-source-note');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain('alpha');
    panel.destroy();
  });

  it('sourceNoteDisplay non-default → no chip for daily note task', () => {
    const t = task({
      title: 'daily task',
      planning: { due: '2026-06-25' },
      source: { filePath: 'periodic/daily/2026-06-25.md' },
      presentation: { dailyNoteDate: '2026-06-25' },
    });
    const panel = makeSearchPanel([t], { sourceNoteDisplay: 'non-default' });
    expect(panel['el'].querySelector('.tc-task-source-note')).toBeNull();
    panel.destroy();
  });

  it('chip appears before tag in tc-task-meta-right', () => {
    const t = task({
      title: 'project task',
      tags: ['#work'],
      planning: { due: '2026-06-25' },
      source: {
        filePath: 'Projects/alpha.md',
        originalMarkdown: '- [ ] project task #work',
        originalBlock: '- [ ] project task #work',
      },
    });
    const panel = makeSearchPanel([t], { sourceNoteDisplay: 'always' });
    const meta = panel['el'].querySelector('.tc-task-meta-right');
    expect(meta).not.toBeNull();
    const children = Array.from(meta!.children);
    const noteIdx = children.findIndex((el) => el.classList.contains('tc-task-source-note'));
    const tagIdx = children.findIndex((el) => el.classList.contains('tc-task-tag'));
    expect(noteIdx).toBeGreaterThanOrEqual(0);
    expect(tagIdx).toBeGreaterThan(noteIdx);
    panel.destroy();
  });
});

describe('CenterPanel project selection', () => {
  it("sel={type:'project'} filters tasks to that note and titles by basename", async () => {
    const files = {
      'Projects/A.md': '- [ ] task one\n- [ ] task two\n',
      'Other.md': '- [ ] elsewhere\n',
    };
    const seeds = [
      {
        path: 'Projects/A.md',
        items: [
          { task: ' ', parent: -1, line: 0 },
          { task: ' ', parent: -1, line: 1 },
        ],
      },
      { path: 'Other.md', items: [{ task: ' ', parent: -1, line: 0 }] },
    ];
    const { panel, state } = await makePanel(files, DEFAULT_SETTINGS, seeds);
    state.set('selectedList', { type: 'project', path: 'Projects/A.md' });
    const tasks = call<TaskSnapshot[]>(panel, 'getFilteredTasks') as TaskSnapshot[];
    expect(tasks.length).toBe(2);
    expect(tasks.every((item) => item.source.filePath === 'Projects/A.md')).toBe(true);
    expect(call<string>(panel, 'getTitle')).toBe('A');
  });

  it("sel={type:'project'} createTask appends into the project note", async () => {
    const { panel, state, app } = await makePanel({ 'Projects/A.md': '# Project A\n' });
    state.set('selectedList', { type: 'project', path: 'Projects/A.md' });
    await call<void>(panel, 'createTask', 'write the brief');
    const content = await readMd(app, 'Projects/A.md');
    expect(content).toContain('- [ ] write the brief');
  });

  it("sel={type:'project'} createTask honors the project section-insertion setting", async () => {
    const settings: CalendarSettings = {
      ...DEFAULT_SETTINGS,
      // Project creation uses the project-specific insertion setting, not the global one.
      projects: {
        ...DEFAULT_SETTINGS.projects,
        taskInsertionMode: 'section',
        taskInsertionSection: '## Tasks',
      },
    };
    const { panel, state, app } = await makePanel(
      { 'Projects/A.md': '# Project A\n\n## Tasks\n- [ ] existing\n' },
      settings,
    );
    state.set('selectedList', { type: 'project', path: 'Projects/A.md' });
    await call<void>(panel, 'createTask', 'under section');
    const content = await readMd(app, 'Projects/A.md');
    const lines = content.split('\n');
    const sectionIdx = lines.findIndex((l) => l.trim() === '## Tasks');
    expect(lines[sectionIdx + 1]).toBe('- [ ] under section');
  });
});

describe('CenterPanel projects mode teardown (regression)', () => {
  function stubProjectStore() {
    return {
      list: () => [],
      get: () => undefined,
      activeForLeftPanel: () => [],
      onUpdate: () => () => {},
      refresh: () => {},
    } as never;
  }
  function stubProjectManager() {
    return { setStatus: async () => {}, create: async () => null } as never;
  }

  async function makeProjectsPanel(): Promise<{
    panel: CenterPanel;
    state: AppState;
    el: HTMLElement;
  }> {
    const app = await createAppWithFiles({ 'Projects/A.md': '---\nstatus: active\n---\n' });
    const taskApplication = configuredTaskApplication(app, DEFAULT_SETTINGS);
    await taskApplication.index.initialize();
    const state = new AppState();
    const panel = new CenterPanel(
      state,
      app,
      DEFAULT_SETTINGS,
      taskApplication.index,
      taskApplication.statusRegistry,
      async () => {},
      stubProjectStore(),
      stubProjectManager(),
      taskApplication.tasks,
    );
    const el = freshContainer();
    panel.mount(el);
    return { panel, state, el };
  }

  it('mounts the projects panel on a child host, not the shared center element', async () => {
    const { state, el } = await makeProjectsPanel();
    state.set('mode', 'projects');
    // The projects panel class lives on the child host, never on the center el.
    expect(el.classList.contains('tc-projects-panel')).toBe(false);
    expect(el.querySelector('.tc-projects-host .tc-projects-list')).toBeTruthy();
  });

  it('leaving projects mode restores a clean tasks center (no leaked class or DOM)', async () => {
    const { state, el } = await makeProjectsPanel();
    state.set('mode', 'projects');
    // Back to tasks with a tag selection.
    state.set('selectedList', { type: 'tag', tag: '#work' });
    state.set('mode', 'tasks');
    expect(el.classList.contains('tc-projects-panel')).toBe(false);
    expect(el.classList.contains('tc-center--projects')).toBe(false);
    expect(el.querySelector('.tc-projects-host')).toBeNull();
    // Normal tasks-mode header (title + controls) renders again.
    expect(el.querySelector('.tc-center-header')).toBeTruthy();
    expect(el.querySelector('.tc-center-scroll')).toBeTruthy();
  });
});

describe('CenterPanel calendar mode — Today/Week/Month switcher', () => {
  async function makeCalendarPanel(): Promise<{
    panel: CenterPanel;
    state: AppState;
    el: HTMLElement;
    app: App;
  }> {
    const { panel, state, app } = await makePanel(
      { 't.md': '- [ ] task 📅 2026-06-15' },
      DEFAULT_SETTINGS,
      [{ path: 't.md', items: [{ task: ' ', parent: -1, line: 0 }] }],
    );
    const el = freshContainer();
    panel.mount(el);
    state.set('mode', 'calendar');
    return { panel, state, el, app };
  }

  it('view switcher shows Day, Week, Month (not Today/Week/Month)', async () => {
    const { el } = await makeCalendarPanel();
    const labels = Array.from(el.querySelectorAll('.tc-cal-view-btn')).map((b) => b.textContent);
    expect(labels).toEqual(['Day', 'Week', 'Month']);
  });

  it('defaults to Month and mounts MonthGridView', async () => {
    const { el } = await makeCalendarPanel();
    expect(el.querySelector('.tc-mg-grid')).not.toBeNull();
  });

  it('clicking Today switches to TodayView', async () => {
    const { el } = await makeCalendarPanel();
    (
      Array.from(el.querySelectorAll('.tc-cal-view-btn')).find(
        (b) => b.textContent === 'Day',
      ) as HTMLElement
    ).click();
    expect(el.querySelector('.tc-tg-root')).not.toBeNull();
  });

  it('clicking a Month day cell drills into Day (Today) view for that specific date', async () => {
    const { el } = await makeCalendarPanel();
    const cell = el.querySelector(
      '.tc-mg-cell:not(.is-outside-month)[data-mg-date]',
    ) as HTMLElement;
    const date = cell.getAttribute('data-mg-date')!;
    cell.click();
    // A single day column for the clicked date — not a 7-column week — confirms Today, not Week.
    const columns = el.querySelectorAll('.tc-tg-day-column');
    expect(columns).toHaveLength(1);
    expect(columns[0]?.getAttribute('data-tg-date')).toBe(date);
  });

  it('clicking a Week header cell drills into Day (Today) view for that specific date', async () => {
    const { el } = await makeCalendarPanel();
    (
      Array.from(el.querySelectorAll('.tc-cal-view-btn')).find(
        (b) => b.textContent === 'Week',
      ) as HTMLElement
    ).click();
    const headerCells = Array.from(el.querySelectorAll('.tc-tg-header-cell'));
    expect(headerCells.length).toBeGreaterThan(1); // sanity: still in Week (multi-column)
    const dayColumnsBefore = Array.from(el.querySelectorAll('.tc-tg-day-column'));
    const targetDate = dayColumnsBefore[2]?.getAttribute('data-tg-date');
    (headerCells[2] as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const columns = el.querySelectorAll('.tc-tg-day-column');
    expect(columns).toHaveLength(1);
    expect(columns[0]?.getAttribute('data-tg-date')).toBe(targetDate);
  });

  it('clicking inside the all-day band in Week view does not drill into Today (separate row from the header)', async () => {
    const { el } = await makeCalendarPanel();
    (
      Array.from(el.querySelectorAll('.tc-cal-view-btn')).find(
        (b) => b.textContent === 'Week',
      ) as HTMLElement
    ).click();
    const alldayCell = el.querySelector('.tc-tg-allday-cell') as HTMLElement;
    alldayCell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(el.querySelectorAll('.tc-tg-day-column')).toHaveLength(7);
  });

  it('no 🎨 style-cycle button is rendered in the new calendar toolbar', async () => {
    const { el } = await makeCalendarPanel();
    expect(el.querySelector('.tc-cal-style-btn')).toBeNull();
  });

  it('right-clicking a Month-view checkbox opens the status/priority popover instead of the task-edit modal, and picking a priority mutates the file through the task API', async () => {
    // The task must fall on a currently-visible day of the default (today's) month, so it's
    // anchored to TODAY rather than makeCalendarPanel's fixed June 2026 seed task.
    const { panel, state, app } = await makePanel(
      { 't.md': `- [ ] task 📅 ${TODAY}` },
      DEFAULT_SETTINGS,
      [{ path: 't.md', items: [{ task: ' ', parent: -1, line: 0 }] }],
    );
    const el = freshContainer();
    panel.mount(el);
    state.set('mode', 'calendar');
    const marker = el.querySelector(
      '.tc-mg-plain .tc-status-marker, .tc-mg-deadline-marker .tc-status-marker',
    ) as HTMLElement;
    expect(marker).not.toBeNull();

    // Right-click the checkbox: opens the popover, not the TaskModal (no modal container appended).
    marker.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const popover = document.querySelector('.tc-status-popover');
    expect(popover).not.toBeNull();
    expect(document.querySelector('.modal')).toBeNull();

    const flagBtn = popover!.querySelector(
      '.tc-status-popover-flag[data-tc-priority="A"]',
    ) as HTMLElement;
    expect(flagBtn).not.toBeNull();
    flagBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushMicrotasks();

    const content = await readMd(app, 't.md');
    expect(content).toContain('🔺');
  });
});

describe('CenterPanel calendar mode — scroll-to-now dedup (Task 27)', () => {
  async function makeCalendarPanel(): Promise<{
    panel: CenterPanel;
    state: AppState;
    index: TaskQueryApi;
    tasks: TaskApplicationApi;
    el: HTMLElement;
    app: App;
  }> {
    const { panel, state, index, tasks, app } = await makePanel(
      { 't.md': `- [ ] task 📅 ${TODAY}` },
      DEFAULT_SETTINGS,
      [{ path: 't.md', items: [{ task: ' ', parent: -1, line: 0 }] }],
    );
    const el = freshContainer();
    panel.mount(el);
    state.set('mode', 'calendar');
    return { panel, state, index, tasks, el, app };
  }

  function clickViewBtn(el: HTMLElement, label: 'Day' | 'Week' | 'Month'): void {
    (
      Array.from(el.querySelectorAll('.tc-cal-view-btn')).find(
        (b) => b.textContent === label,
      ) as HTMLElement
    ).click();
  }

  function lastShouldScrollToNow(spy: { mock: { calls: unknown[][] } }): unknown {
    const calls = spy.mock.calls;
    const lastCall = calls[calls.length - 1];
    return lastCall?.[3];
  }

  it('switching into Week view for the first time scrolls (shouldScrollToNow=true)', async () => {
    const renderSpy = vi.spyOn(WeekTimeGridView.prototype, 'render');
    const { el } = await makeCalendarPanel();
    clickViewBtn(el, 'Week');
    expect(lastShouldScrollToNow(renderSpy)).toBe(true);
    renderSpy.mockRestore();
  });

  it('a reactive task-index update re-render of the same view/date does not scroll again', async () => {
    const renderSpy = vi.spyOn(WeekTimeGridView.prototype, 'render');
    const { el, index, tasks } = await makeCalendarPanel();
    clickViewBtn(el, 'Week');
    expect(lastShouldScrollToNow(renderSpy)).toBe(true);

    // Simulate an index-driven re-render (e.g. toggling a checkbox anywhere), which routes
    // through the query subscription in renderCalendarMode -> mountView(), NOT
    // through CenterPanel.render() — this is the exact path the brief's root cause describes.
    const seededTask = index.list({ filePath: 't.md' })[0]!;
    await tasks.execute({
      type: 'toggle-completion',
      target: { type: 'task', ref: seededTask.ref },
    });
    await flushMicrotasks();

    expect(lastShouldScrollToNow(renderSpy)).toBe(false);
    renderSpy.mockRestore();
  });

  it('switching view type (Week -> Day -> Week) scrolls again each time, since it is a new pair', async () => {
    const weekSpy = vi.spyOn(WeekTimeGridView.prototype, 'render');
    const todaySpy = vi.spyOn(TodayView.prototype, 'render');
    const { el } = await makeCalendarPanel();

    clickViewBtn(el, 'Week');
    expect(lastShouldScrollToNow(weekSpy)).toBe(true);

    clickViewBtn(el, 'Day');
    expect(lastShouldScrollToNow(todaySpy)).toBe(true);

    clickViewBtn(el, 'Week');
    expect(lastShouldScrollToNow(weekSpy)).toBe(true);

    weekSpy.mockRestore();
    todaySpy.mockRestore();
  });

  it('navigating to a different date (next week) scrolls again, since it is a new pair', async () => {
    const renderSpy = vi.spyOn(WeekTimeGridView.prototype, 'render');
    const { el } = await makeCalendarPanel();
    clickViewBtn(el, 'Week');
    expect(lastShouldScrollToNow(renderSpy)).toBe(true);

    const nextBtn = el.querySelector('.tc-cal-nav-btn[aria-label="Next"]') as HTMLElement;
    expect(nextBtn).not.toBeNull();
    nextBtn.click();

    expect(lastShouldScrollToNow(renderSpy)).toBe(true);
    renderSpy.mockRestore();
  });

  it("Round 2 Task 16's periodic now-line-repositioning interval is unaffected: it still registers on a scroll-suppressed reactive re-render", async () => {
    const { el, index, tasks } = await makeCalendarPanel();
    clickViewBtn(el, 'Week');

    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval');

    // Same view/date -> shouldScrollToNow will be false on this reactive re-render, but the
    // now-line interval must still be torn down (old view destroy()) and re-registered (new
    // view render()) exactly as before this change.
    const seededTask = index.list({ filePath: 't.md' })[0]!;
    await tasks.execute({
      type: 'toggle-completion',
      target: { type: 'task', ref: seededTask.ref },
    });
    await flushMicrotasks();

    expect(clearIntervalSpy).toHaveBeenCalled();
    expect(setIntervalSpy).toHaveBeenCalled();

    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });
});

describe('CenterPanel calendar mode — preserve scroll position across reactive re-render (Task 31)', () => {
  async function makeCalendarPanel(): Promise<{
    panel: CenterPanel;
    state: AppState;
    index: TaskQueryApi;
    tasks: TaskApplicationApi;
    el: HTMLElement;
    app: App;
  }> {
    const { panel, state, index, tasks, app } = await makePanel(
      { 't.md': `- [ ] task 📅 ${TODAY}` },
      DEFAULT_SETTINGS,
      [{ path: 't.md', items: [{ task: ' ', parent: -1, line: 0 }] }],
    );
    const el = freshContainer();
    panel.mount(el);
    state.set('mode', 'calendar');
    return { panel, state, index, tasks, el, app };
  }

  function clickViewBtn(el: HTMLElement, label: 'Day' | 'Week' | 'Month'): void {
    (
      Array.from(el.querySelectorAll('.tc-cal-view-btn')).find(
        (b) => b.textContent === label,
      ) as HTMLElement
    ).click();
  }

  it('a reactive re-render (checkbox toggle elsewhere) preserves the exact scrollTop the user had, instead of resetting to 0', async () => {
    const { el, index, tasks } = await makeCalendarPanel();
    clickViewBtn(el, 'Week');

    const gridRowEl = el.querySelector('.tc-tg-grid-row') as HTMLElement;
    expect(gridRowEl).not.toBeNull();
    // Simulate the user having scrolled away from "now" to some arbitrary position.
    gridRowEl.scrollTop = 777;
    expect(gridRowEl.scrollTop).toBe(777);

    // Reactive re-render of the SAME view/date, via the query subscription, exactly the
    // path a checkbox toggle anywhere in the vault takes (not through CenterPanel.render()).
    const seededTask = index.list({ filePath: 't.md' })[0]!;
    await tasks.execute({
      type: 'toggle-completion',
      target: { type: 'task', ref: seededTask.ref },
    });
    await flushMicrotasks();

    const newGridRowEl = el.querySelector('.tc-tg-grid-row') as HTMLElement;
    expect(newGridRowEl).not.toBeNull();
    // A brand-new DOM element (destroy/recreate cycle), but its scrollTop must equal the OLD
    // value — not 0, and not re-centered on "now".
    expect(newGridRowEl).not.toBe(gridRowEl);
    expect(newGridRowEl.scrollTop).toBe(777);
  });

  it('a genuine navigation to a new view/date (Week -> Day) does not inherit the stale prior scroll position', async () => {
    const { el } = await makeCalendarPanel();
    clickViewBtn(el, 'Week');

    const gridRowEl = el.querySelector('.tc-tg-grid-row') as HTMLElement;
    gridRowEl.scrollTop = 777;

    // Genuine navigation: switching view type is a new (viewType, date) pair, so
    // shouldScrollToNow is true here and must take priority over any stale prior scrollTop.
    clickViewBtn(el, 'Day');

    const newGridRowEl = el.querySelector('.tc-tg-grid-row') as HTMLElement;
    expect(newGridRowEl).not.toBeNull();
    expect(newGridRowEl).not.toBe(gridRowEl);
    // Must NOT equal the stale Week-view scrollTop (777) it never asked to inherit.
    expect(newGridRowEl.scrollTop).not.toBe(777);
  });

  it('switching from Month (no grid-row) into Week does not error and scrolls to now as a fresh navigation', async () => {
    const { el } = await makeCalendarPanel();
    // Default calViewType is 'month' — no `.tc-tg-grid-row` exists yet.
    expect(el.querySelector('.tc-tg-grid-row')).toBeNull();

    clickViewBtn(el, 'Week');
    const gridRowEl = el.querySelector('.tc-tg-grid-row') as HTMLElement;
    expect(gridRowEl).not.toBeNull();
  });
});

describe('CenterPanel calendar mode — click-to-create', () => {
  const clickToCreateSettings: CalendarSettings = {
    ...DEFAULT_SETTINGS,
    addToToday: false,
    customFilePath: 'inbox.md',
    taskPrefix: '',
  };

  async function makeClickToCreatePanel(): Promise<{ state: AppState; el: HTMLElement; app: App }> {
    const { panel, state, app } = await makePanel({ 'inbox.md': '' }, clickToCreateSettings);
    const el = freshContainer();
    panel.mount(el);
    state.set('mode', 'calendar');
    return { state, el, app };
  }

  it("Month day cell's + button opens an inline quick-add; Enter writes a plain task on that date", async () => {
    const { el, app } = await makeClickToCreatePanel();
    const cell = el.querySelector(
      '.tc-mg-cell:not(.is-outside-month)[data-mg-date]',
    ) as HTMLElement;
    const date = cell.getAttribute('data-mg-date')!;
    const addBtn = cell.querySelector('.tc-mg-add-btn') as HTMLElement;
    addBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const input = el.querySelector('.tc-mg-quick-add-input') as HTMLInputElement;
    expect(input).toBeTruthy();
    input.value = 'water the plants';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushMicrotasks();

    const content = await readMd(app, 'inbox.md');
    expect(content).toContain(`- [ ] water the plants 📅 ${date}`);
  });

  it('clicking the + button does not also drill into Week (onDayClick suppressed)', async () => {
    const { el } = await makeClickToCreatePanel();
    const cell = el.querySelector(
      '.tc-mg-cell:not(.is-outside-month)[data-mg-date]',
    ) as HTMLElement;
    const addBtn = cell.querySelector('.tc-mg-add-btn') as HTMLElement;
    addBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // Still on Month (a drill-down would swap in the hour grid).
    expect(el.querySelector('.tc-mg-grid')).not.toBeNull();
    expect(el.querySelector('.tc-tg-day-column')).toBeNull();
  });

  it('clicking elsewhere in a Month day cell still drills into Day (Today) view, unaffected by the + button', async () => {
    const { el } = await makeClickToCreatePanel();
    const cell = el.querySelector(
      '.tc-mg-cell:not(.is-outside-month)[data-mg-date]',
    ) as HTMLElement;
    cell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(el.querySelectorAll('.tc-tg-day-column')).toHaveLength(1);
  });

  it('clicking empty hour-grid space in Today view opens an inline quick-add; Enter writes a timed task', async () => {
    const { el, app } = await makeClickToCreatePanel();
    (
      Array.from(el.querySelectorAll('.tc-cal-view-btn')).find(
        (b) => b.textContent === 'Day',
      ) as HTMLElement
    ).click();

    const hourColumnEl = el.querySelector('.tc-tg-hour-column') as HTMLElement;
    const date = (el.querySelector('.tc-tg-day-column') as HTMLElement).getAttribute(
      'data-tg-date',
    )!;
    vi.spyOn(hourColumnEl, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      left: 0,
    } as DOMRect);
    hourColumnEl.dispatchEvent(new MouseEvent('click', { bubbles: true, clientY: 480 })); // 480px = 10:00

    const input = el.querySelector('.tc-tg-quick-add-input') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.placeholder).toBe('Task at 10:00…');
    input.value = 'stand-up';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushMicrotasks();

    const content = await readMd(app, 'inbox.md');
    expect(content).toContain(`- [ ] stand-up ⏰ 10:00 📅 ${date}`);
  });

  it('clicking on an existing timed block in the hour grid does not open the quick-add', async () => {
    const { panel, state } = await makePanel(
      { 't.md': `- [ ] timed ⏰ 09:00 📅 ${TODAY}` },
      clickToCreateSettings,
      [{ path: 't.md', items: [{ task: ' ', parent: -1, line: 0 }] }],
    );
    const el = freshContainer();
    panel.mount(el);
    state.set('mode', 'calendar');
    (
      Array.from(el.querySelectorAll('.tc-cal-view-btn')).find(
        (b) => b.textContent === 'Day',
      ) as HTMLElement
    ).click();

    const block = el.querySelector('.tc-tg-block') as HTMLElement;
    expect(block).toBeTruthy();
    block.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(el.querySelector('.tc-tg-quick-add')).toBeNull();
  });

  it('clicking empty space in the all-day/"no-time" row in Today view opens an inline quick-add; Enter writes a plain (untimed) task', async () => {
    const { el, app } = await makeClickToCreatePanel();
    (
      Array.from(el.querySelectorAll('.tc-cal-view-btn')).find(
        (b) => b.textContent === 'Day',
      ) as HTMLElement
    ).click();

    const alldayCell = el.querySelector('.tc-tg-allday-cell') as HTMLElement;
    const date = (el.querySelector('.tc-tg-day-column') as HTMLElement).getAttribute(
      'data-tg-date',
    )!;
    alldayCell.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const input = el.querySelector('.tc-tg-allday-quick-add-input') as HTMLInputElement;
    expect(input).toBeTruthy();
    input.value = 'renew passport';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushMicrotasks();

    const content = await readMd(app, 'inbox.md');
    expect(content).toContain(`- [ ] renew passport 📅 ${date}`);
  });

  it('clicking empty space in the all-day row in Week view opens an inline quick-add; Enter writes a plain task on that day', async () => {
    const { el, app } = await makeClickToCreatePanel();
    (
      Array.from(el.querySelectorAll('.tc-cal-view-btn')).find(
        (b) => b.textContent === 'Week',
      ) as HTMLElement
    ).click();

    const alldayCell = el.querySelector('.tc-tg-allday-cell') as HTMLElement;
    const date = alldayCell.getAttribute('data-tg-date')!;
    alldayCell.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const input = el.querySelector('.tc-tg-allday-quick-add-input') as HTMLInputElement;
    expect(input).toBeTruthy();
    input.value = 'water plants';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushMicrotasks();

    const content = await readMd(app, 'inbox.md');
    expect(content).toContain(`- [ ] water plants 📅 ${date}`);
  });

  it('clicking on an existing item in the all-day row does not open the quick-add (guarded, same as the hour grid)', async () => {
    const { panel, state } = await makePanel(
      { 't.md': `- [ ] plain task 📅 ${TODAY}` },
      clickToCreateSettings,
      [{ path: 't.md', items: [{ task: ' ', parent: -1, line: 0 }] }],
    );
    fixedToday(TODAY);
    const el = freshContainer();
    panel.mount(el);
    state.set('mode', 'calendar');
    (
      Array.from(el.querySelectorAll('.tc-cal-view-btn')).find(
        (b) => b.textContent === 'Day',
      ) as HTMLElement
    ).click();

    const chip = el.querySelector('.tc-tg-plain') as HTMLElement;
    expect(chip).toBeTruthy();
    chip.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(el.querySelector('.tc-tg-allday-quick-add')).toBeNull();
  });
});

function deferredResult(): {
  promise: Promise<TaskCommandResult>;
  resolve(result: TaskCommandResult): void;
} {
  let resolve!: (result: TaskCommandResult) => void;
  const promise = new Promise<TaskCommandResult>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function keyboardSnapshot(
  date: string,
  time = '09:00',
  filePath = 'Folder/[qa] "task".md',
  revision = 'revision-1',
  line = 0,
): TaskSnapshot {
  return task({
    ref: { filePath, line, revision },
    source: { filePath, line },
    title: filePath,
    planning: { due: date, time, duration: 60 },
  });
}

function okTask(updated: TaskSnapshot): TaskCommandResult {
  return { type: 'ok', changed: true, outcome: { type: 'task', task: updated } };
}

function okTaskUnchanged(updated: TaskSnapshot): TaskCommandResult {
  return { type: 'ok', changed: false, outcome: { type: 'task', task: updated } };
}

function keyboardPanelHarness(
  initial: readonly TaskSnapshot[],
  execute: TaskApplicationApi['execute'],
): {
  panel: CenterPanel;
  state: AppState;
  el: HTMLElement;
  setSnapshots(next: readonly TaskSnapshot[]): void;
  emit(): void;
} {
  let snapshots = initial;
  const listeners = new Set<(event: TaskIndexEvent) => void>();
  const queries = queryApiForSnapshots(() => snapshots);
  queries.subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const tasks: TaskApplicationApi = { queries, execute };
  const state = new AppState();
  const panel = new CenterPanel(
    state,
    {} as App,
    DEFAULT_SETTINGS,
    queries,
    new StatusRegistry(DEFAULT_SETTINGS.taskStatuses),
    undefined,
    null,
    null,
    tasks,
  );
  const el = freshContainer();
  activeDocument.body.append(el);
  panel.mount(el);
  state.set('mode', 'calendar');
  return {
    panel,
    state,
    el,
    setSnapshots: (next) => {
      snapshots = next;
    },
    emit: () => {
      for (const listener of [...listeners]) {
        listener({ type: 'changed', files: snapshots.map((item) => item.source.filePath) });
      }
    },
  };
}

function clickCalendarView(el: HTMLElement, label: 'Day' | 'Week' | 'Month'): void {
  const button = Array.from(el.querySelectorAll<HTMLElement>('.tc-cal-view-btn')).find(
    (candidate) => candidate.textContent === label,
  );
  if (!button) throw new Error(`missing ${label} calendar view button`);
  button.click();
}

function timedBlock(el: HTMLElement, filePath?: string): HTMLElement {
  const blocks = Array.from(el.querySelectorAll<HTMLElement>('.tc-tg-block'));
  const found = filePath
    ? blocks.find((block) => block.dataset['tcTaskFile'] === filePath)
    : blocks[0];
  if (!found) throw new Error(`missing timed block${filePath ? ` for ${filePath}` : ''}`);
  return found;
}

function press(block: HTMLElement, key: string, shiftKey = false): void {
  block.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }));
}

describe('CenterPanel calendar mode — serialized keyboard focus and follow', () => {
  it('retains a special-path locator across two remounts and focuses only the newest connected block', async () => {
    const pending = deferredResult();
    const execute = vi.fn<TaskApplicationApi['execute']>().mockReturnValue(pending.promise);
    const original = keyboardSnapshot(TODAY);
    const updated = keyboardSnapshot(TODAY, '09:15', original.source.filePath, 'revision-2');
    const h = keyboardPanelHarness([original], execute);
    clickCalendarView(h.el, 'Day');

    const outgoing = timedBlock(h.el);
    outgoing.focus();
    press(outgoing, 'ArrowDown');
    expect(execute).toHaveBeenCalledOnce();

    h.setSnapshots([]);
    h.emit();
    expect(outgoing.isConnected).toBe(false);
    h.setSnapshots([updated]);
    h.emit();
    pending.resolve(okTask(updated));
    await flushMicrotasks();

    const connected = timedBlock(h.el);
    expect(connected).not.toBe(outgoing);
    expect(connected.isConnected).toBe(true);
    expect(activeDocument.activeElement).toBe(connected);
    expect(connected.classList.contains('is-selected')).toBe(true);
  });

  it('keeps vertical moves and duration changes on the same Day date', async () => {
    let current = keyboardSnapshot(TODAY);
    let h!: ReturnType<typeof keyboardPanelHarness>;
    const execute = vi.fn<TaskApplicationApi['execute']>().mockImplementation(async (command) => {
      const revision = `revision-${execute.mock.calls.length + 1}`;
      const isTaskPatch = command.type === 'patch' && command.target.type === 'task';
      const nextTime =
        isTaskPatch && command.patch.time?.type === 'set'
          ? command.patch.time.value
          : current.planning.time;
      const nextDuration =
        isTaskPatch && 'duration' in command.patch && command.patch.duration?.type === 'set'
          ? command.patch.duration.value
          : current.planning.duration;
      current = task({
        ...current,
        ref: { ...current.ref, revision },
        planning: { ...current.planning, time: nextTime, duration: nextDuration },
      });
      h.setSnapshots([current]);
      h.emit();
      return okTask(current);
    });
    h = keyboardPanelHarness([current], execute);
    clickCalendarView(h.el, 'Day');
    const dateBefore = h.el.querySelector('.tc-tg-day-column')?.getAttribute('data-tg-date');

    let block = timedBlock(h.el);
    block.focus();
    press(block, 'ArrowDown');
    await flushMicrotasks();
    block = timedBlock(h.el);
    press(block, 'ArrowDown', true);
    await flushMicrotasks();

    expect(execute).toHaveBeenCalledTimes(2);
    expect(h.el.querySelector('.tc-tg-day-column')?.getAttribute('data-tg-date')).toBe(dateBefore);
    expect(activeDocument.activeElement).toBe(timedBlock(h.el));
  });

  it('follows a successful horizontal move in Day view and restores focus there', async () => {
    const tomorrow = moment(TODAY).add(1, 'day').format('YYYY-MM-DD');
    const original = keyboardSnapshot(TODAY);
    const updated = keyboardSnapshot(tomorrow, '09:00', original.source.filePath, 'revision-2');
    let h!: ReturnType<typeof keyboardPanelHarness>;
    const execute = vi.fn<TaskApplicationApi['execute']>().mockImplementation(async () => {
      h.setSnapshots([updated]);
      h.emit();
      return okTask(updated);
    });
    h = keyboardPanelHarness([original], execute);
    clickCalendarView(h.el, 'Day');
    const block = timedBlock(h.el);
    block.focus();
    press(block, 'ArrowRight');
    await flushMicrotasks();

    expect(h.el.querySelector('.tc-tg-day-column')?.getAttribute('data-tg-date')).toBe(tomorrow);
    expect(activeDocument.activeElement).toBe(timedBlock(h.el));
  });

  it('retains sequence ownership through an intermediate remount and follows two rapid Day moves', async () => {
    const first = deferredResult();
    const second = deferredResult();
    const execute = vi
      .fn<TaskApplicationApi['execute']>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const dayOne = keyboardSnapshot(TODAY);
    const dayTwoDate = moment(TODAY).add(1, 'day').format('YYYY-MM-DD');
    const dayThreeDate = moment(TODAY).add(2, 'days').format('YYYY-MM-DD');
    const dayTwo = keyboardSnapshot(dayTwoDate, '09:00', dayOne.source.filePath, 'revision-2');
    const dayThree = keyboardSnapshot(dayThreeDate, '09:00', dayOne.source.filePath, 'revision-3');
    const h = keyboardPanelHarness([dayOne], execute);
    clickCalendarView(h.el, 'Day');

    const block = timedBlock(h.el);
    block.focus();
    press(block, 'ArrowRight');
    press(block, 'ArrowRight');
    expect(execute).toHaveBeenCalledOnce();

    h.setSnapshots([dayTwo]);
    h.emit();
    first.resolve(okTask(dayTwo));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    await flushMicrotasks();
    expect(h.el.querySelector('.tc-tg-day-column')?.getAttribute('data-tg-date')).toBe(dayTwoDate);

    h.setSnapshots([dayThree]);
    h.emit();
    second.resolve(okTask(dayThree));
    await flushMicrotasks();

    expect(h.el.querySelector('.tc-tg-day-column')?.getAttribute('data-tg-date')).toBe(
      dayThreeDate,
    );
    expect(activeDocument.activeElement).toBe(timedBlock(h.el));
  });

  it('keeps Week anchored for an in-range move and follows only after crossing its visible edge', async () => {
    const weekStart = moment().startOf('isoWeek');
    const inside = weekStart.clone().add(2, 'days').format('YYYY-MM-DD');
    const nextInside = weekStart.clone().add(3, 'days').format('YYYY-MM-DD');
    const edge = weekStart.clone().add(6, 'days').format('YYYY-MM-DD');
    const outside = weekStart.clone().add(7, 'days').format('YYYY-MM-DD');
    let current = keyboardSnapshot(inside);
    let h!: ReturnType<typeof keyboardPanelHarness>;
    const execute = vi.fn<TaskApplicationApi['execute']>().mockImplementation(async () => {
      const nextDate = current.planning.due === inside ? nextInside : outside;
      current = keyboardSnapshot(
        nextDate,
        '09:00',
        current.source.filePath,
        `revision-${execute.mock.calls.length + 1}`,
      );
      h.setSnapshots([current]);
      h.emit();
      return okTask(current);
    });
    h = keyboardPanelHarness([current], execute);
    clickCalendarView(h.el, 'Week');
    const originalDates = Array.from(h.el.querySelectorAll<HTMLElement>('.tc-tg-day-column')).map(
      (column) => column.dataset['tgDate'],
    );

    let block = timedBlock(h.el);
    block.focus();
    press(block, 'ArrowRight');
    await flushMicrotasks();
    expect(
      Array.from(h.el.querySelectorAll<HTMLElement>('.tc-tg-day-column')).map(
        (column) => column.dataset['tgDate'],
      ),
    ).toEqual(originalDates);

    current = keyboardSnapshot(edge, '09:00', current.source.filePath, 'revision-edge');
    h.setSnapshots([current]);
    h.emit();
    await flushMicrotasks();
    block = timedBlock(h.el);
    block.focus();
    press(block, 'ArrowRight');
    await flushMicrotasks();
    const followedDates = Array.from(h.el.querySelectorAll<HTMLElement>('.tc-tg-day-column')).map(
      (column) => column.dataset['tgDate'],
    );
    expect(followedDates).toContain(outside);
    expect(followedDates).not.toEqual(originalDates);
  });

  it('does not let task A late completion navigate or focus after task B owns the queue', async () => {
    const first = deferredResult();
    const second = deferredResult();
    const execute = vi
      .fn<TaskApplicationApi['execute']>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const taskA = keyboardSnapshot(TODAY, '09:00', 'a.md');
    const taskB = keyboardSnapshot(TODAY, '10:00', 'b.md');
    const h = keyboardPanelHarness([taskA, taskB], execute);
    clickCalendarView(h.el, 'Day');

    const blockA = timedBlock(h.el, 'a.md');
    blockA.focus();
    press(blockA, 'ArrowRight');
    const blockB = timedBlock(h.el, 'b.md');
    blockB.focus();
    press(blockB, 'ArrowDown');
    first.resolve(
      okTask(
        keyboardSnapshot(moment(TODAY).add(1, 'day').format('YYYY-MM-DD'), '09:00', 'a.md', 'a-2'),
      ),
    );
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(h.el.querySelector('.tc-tg-day-column')?.getAttribute('data-tg-date')).toBe(TODAY);

    const updatedB = keyboardSnapshot(TODAY, '10:15', 'b.md', 'b-2');
    h.setSnapshots([taskA, updatedB]);
    h.emit();
    second.resolve(okTask(updatedB));
    await flushMicrotasks();
    expect(activeDocument.activeElement).toBe(timedBlock(h.el, 'b.md'));
  });

  it('invalidates task A focus ownership as soon as a newer task B receives focus', async () => {
    const pending = deferredResult();
    const execute = vi.fn<TaskApplicationApi['execute']>().mockReturnValue(pending.promise);
    const taskA = keyboardSnapshot(TODAY, '09:00', 'a.md');
    const taskB = keyboardSnapshot(TODAY, '10:00', 'b.md');
    const h = keyboardPanelHarness([taskA, taskB], execute);
    clickCalendarView(h.el, 'Day');

    const blockA = timedBlock(h.el, 'a.md');
    blockA.focus();
    press(blockA, 'ArrowRight');
    const blockB = timedBlock(h.el, 'b.md');
    blockB.focus();
    pending.resolve(
      okTask(
        keyboardSnapshot(moment(TODAY).add(1, 'day').format('YYYY-MM-DD'), '09:00', 'a.md', 'a-2'),
      ),
    );
    await flushMicrotasks();

    expect(h.el.querySelector('.tc-tg-day-column')?.getAttribute('data-tg-date')).toBe(TODAY);
    expect(activeDocument.activeElement).toBe(blockB);
  });

  it('defers remount focus until the command commits and does not steal it after settlement', async () => {
    const pending = deferredResult();
    const execute = vi.fn<TaskApplicationApi['execute']>().mockReturnValue(pending.promise);
    const original = keyboardSnapshot(TODAY);
    const updated = keyboardSnapshot(TODAY, '09:15', original.source.filePath, 'revision-2');
    const h = keyboardPanelHarness([original], execute);
    clickCalendarView(h.el, 'Day');

    const block = timedBlock(h.el);
    block.focus();
    press(block, 'ArrowDown');
    h.setSnapshots([updated]);
    h.emit();
    await flushMicrotasks();
    const remounted = timedBlock(h.el);
    expect(activeDocument.activeElement).not.toBe(remounted);

    pending.resolve(okTask(updated));
    await flushMicrotasks();
    expect(activeDocument.activeElement).toBe(remounted);

    const other = h.el.querySelector<HTMLElement>('.tc-cal-nav-today')!;
    other.focus();
    h.emit();
    await flushMicrotasks();

    expect(activeDocument.activeElement).toBe(other);
  });

  it('abandons an in-flight sequence when focus moves to a non-task calendar control', async () => {
    const pending = deferredResult();
    const execute = vi.fn<TaskApplicationApi['execute']>().mockReturnValue(pending.promise);
    const original = keyboardSnapshot(TODAY);
    const tomorrow = moment(TODAY).add(1, 'day').format('YYYY-MM-DD');
    const updated = keyboardSnapshot(tomorrow, '09:00', original.source.filePath, 'revision-2');
    const h = keyboardPanelHarness([original], execute);
    clickCalendarView(h.el, 'Day');

    const block = timedBlock(h.el);
    block.focus();
    press(block, 'ArrowRight');
    const toolbarControl = h.el.querySelector<HTMLElement>('.tc-cal-nav-today')!;
    toolbarControl.focus();
    h.setSnapshots([updated]);
    h.emit();
    expect(toolbarControl.isConnected).toBe(true);
    expect(activeDocument.activeElement).toBe(toolbarControl);

    pending.resolve(okTask(updated));
    await flushMicrotasks();

    expect(h.el.querySelector('.tc-tg-day-column')?.getAttribute('data-tg-date')).toBe(TODAY);
    expect(activeDocument.activeElement).toBe(toolbarControl);
  });

  it('clears focus ownership when a clamped command executes without changing the task', async () => {
    const pending = deferredResult();
    const execute = vi.fn<TaskApplicationApi['execute']>().mockReturnValue(pending.promise);
    const original = keyboardSnapshot(TODAY, '00:00');
    const h = keyboardPanelHarness([original], execute);
    clickCalendarView(h.el, 'Day');

    const block = timedBlock(h.el);
    block.focus();
    press(block, 'ArrowUp');
    pending.resolve(okTaskUnchanged(original));
    await flushMicrotasks();

    const nav = h.el.querySelector<HTMLElement>('.tc-cal-nav-today')!;
    nav.focus();
    h.emit();
    await flushMicrotasks();

    expect(activeDocument.activeElement).toBe(nav);

    const current = timedBlock(h.el);
    current.focus();
    h.emit();
    await flushMicrotasks();

    const remounted = timedBlock(h.el);
    expect(remounted).not.toBe(current);
    expect(activeDocument.activeElement).toBe(remounted);
  });

  it.each([
    ['0000-01-01', 'ArrowLeft'],
    ['9999-12-31', 'ArrowRight'],
  ] as const)(
    'does not retain focus ownership for an unexecutable %s boundary extension',
    async (date, key) => {
      const execute = vi.fn<TaskApplicationApi['execute']>();
      const snapshot = keyboardSnapshot(date);
      const h = keyboardPanelHarness([snapshot], execute);
      const calendar = h.panel as unknown as {
        calViewType: 'today';
        calDate: ReturnType<typeof moment>;
      };
      calendar.calViewType = 'today';
      calendar.calDate = moment(date, 'YYYY-MM-DD');
      h.panel.refresh();

      const block = timedBlock(h.el);
      block.focus();
      press(block, key, true);
      expect(execute).not.toHaveBeenCalled();
      const other = h.el.querySelector<HTMLElement>('.tc-cal-nav-today')!;
      other.focus();
      h.emit();
      await flushMicrotasks();

      expect(activeDocument.activeElement).toBe(other);
    },
  );

  it.each([
    ['0000-01-01', 'ArrowLeft'],
    ['9999-12-31', 'ArrowRight'],
  ] as const)(
    'clears focus ownership when an in-flight command is followed by an unexecutable %s boundary intent',
    async (date, key) => {
      const pending = deferredResult();
      const execute = vi.fn<TaskApplicationApi['execute']>().mockReturnValue(pending.promise);
      const snapshot = keyboardSnapshot(date);
      const h = keyboardPanelHarness([snapshot], execute);
      const calendar = h.panel as unknown as {
        calViewType: 'today';
        calDate: ReturnType<typeof moment>;
      };
      calendar.calViewType = 'today';
      calendar.calDate = moment(date, 'YYYY-MM-DD');
      h.panel.refresh();

      const block = timedBlock(h.el);
      block.focus();
      press(block, 'ArrowDown');
      press(block, key, true);
      expect(execute).toHaveBeenCalledOnce();
      pending.resolve(okTaskUnchanged(snapshot));
      await flushMicrotasks();
      expect(execute).toHaveBeenCalledOnce();

      const nav = h.el.querySelector<HTMLElement>('.tc-cal-nav-today')!;
      nav.focus();
      h.emit();
      await flushMicrotasks();

      expect(activeDocument.activeElement).toBe(nav);
    },
  );

  it('retains focus ownership when an earlier command changed and the final command is a no-op', async () => {
    const first = deferredResult();
    const second = deferredResult();
    const execute = vi
      .fn<TaskApplicationApi['execute']>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const original = keyboardSnapshot(TODAY, '00:15');
    const changed = keyboardSnapshot(TODAY, '00:00', original.source.filePath, 'revision-2');
    const h = keyboardPanelHarness([original], execute);
    clickCalendarView(h.el, 'Day');

    const block = timedBlock(h.el);
    block.focus();
    press(block, 'ArrowUp');
    press(block, 'ArrowUp');
    first.resolve(okTask(changed));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    second.resolve(okTaskUnchanged(changed));
    await flushMicrotasks();

    h.setSnapshots([changed]);
    h.emit();
    await flushMicrotasks();

    expect(activeDocument.activeElement).toBe(timedBlock(h.el));
  });

  it('preserves an intermediate restoration through two queued no-op results', async () => {
    const first = deferredResult();
    const second = deferredResult();
    const third = deferredResult();
    const execute = vi
      .fn<TaskApplicationApi['execute']>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);
    const original = keyboardSnapshot(TODAY, '00:15', 'clamped.md', 'revision-1');
    const boundary = keyboardSnapshot(TODAY, '00:00', 'clamped.md', 'revision-2');
    const h = keyboardPanelHarness([original], execute);
    clickCalendarView(h.el, 'Day');

    const outgoing = timedBlock(h.el);
    outgoing.focus();
    press(outgoing, 'ArrowUp');
    press(outgoing, 'ArrowUp');
    first.resolve(okTask(boundary));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));

    h.setSnapshots([boundary]);
    h.emit();
    await flushMicrotasks();
    const restored = timedBlock(h.el);
    expect(activeDocument.activeElement).toBe(restored);
    press(restored, 'ArrowUp');

    second.resolve(okTaskUnchanged(boundary));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(3));
    third.resolve(okTaskUnchanged(boundary));
    await flushMicrotasks();

    const nav = h.el.querySelector<HTMLElement>('.tc-cal-nav-today')!;
    nav.focus();
    h.emit();
    await flushMicrotasks();

    expect(activeDocument.activeElement).toBe(nav);
  });

  it('invalidates an intermediate restoration when a later queued result changes', async () => {
    const first = deferredResult();
    const second = deferredResult();
    const third = deferredResult();
    const execute = vi
      .fn<TaskApplicationApi['execute']>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);
    const original = keyboardSnapshot(TODAY, '00:15', 'clamped.md', 'revision-1');
    const boundary = keyboardSnapshot(TODAY, '00:00', 'clamped.md', 'revision-2');
    const final = keyboardSnapshot(TODAY, '00:15', 'clamped.md', 'revision-3');
    const h = keyboardPanelHarness([original], execute);
    clickCalendarView(h.el, 'Day');

    const outgoing = timedBlock(h.el);
    outgoing.focus();
    press(outgoing, 'ArrowUp');
    press(outgoing, 'ArrowUp');
    first.resolve(okTask(boundary));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));

    h.setSnapshots([boundary]);
    h.emit();
    await flushMicrotasks();
    const restored = timedBlock(h.el);
    expect(activeDocument.activeElement).toBe(restored);
    press(restored, 'ArrowDown');

    second.resolve(okTaskUnchanged(boundary));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(3));
    third.resolve(okTask(final));
    await flushMicrotasks();

    h.setSnapshots([final]);
    h.emit();
    await flushMicrotasks();

    expect(activeDocument.activeElement).toBe(timedBlock(h.el));
  });

  it.each([
    ['vertical', 'ArrowDown', TODAY, '09:15'],
    ['horizontal', 'ArrowRight', moment(TODAY).add(1, 'day').format('YYYY-MM-DD'), '09:00'],
  ] as const)(
    'preserves a rebased queue locator when a %s result arrives before the index',
    async (_direction, key, updatedDate, updatedTime) => {
      const pending = deferredResult();
      const execute = vi.fn<TaskApplicationApi['execute']>().mockReturnValue(pending.promise);
      const original = keyboardSnapshot(TODAY, '09:00', 'moved.md', 'revision-1', 4);
      const moved = keyboardSnapshot(updatedDate, updatedTime, 'moved.md', 'revision-2', 5);
      const h = keyboardPanelHarness([original], execute);
      clickCalendarView(h.el, 'Day');

      const outgoing = timedBlock(h.el);
      outgoing.focus();
      press(outgoing, key);
      pending.resolve(okTask(moved));
      await flushMicrotasks();

      h.setSnapshots([moved]);
      h.emit();
      await flushMicrotasks();

      const focused = timedBlock(h.el);
      expect(focused.dataset['tcTaskLine']).toBe('5');
      expect(activeDocument.activeElement).toBe(focused);
    },
  );

  it.each(['before', 'after'] as const)(
    'retains a changed:false moved-source locator when the index arrives %s the result',
    async (indexOrder) => {
      const pending = deferredResult();
      const execute = vi.fn<TaskApplicationApi['execute']>().mockReturnValue(pending.promise);
      const original = keyboardSnapshot(TODAY, '09:00', 'moved.md', 'revision-1', 4);
      const moved = keyboardSnapshot(TODAY, '09:00', 'moved.md', 'revision-2', 5);
      const h = keyboardPanelHarness([original], execute);
      clickCalendarView(h.el, 'Day');

      const outgoing = timedBlock(h.el);
      outgoing.focus();
      press(outgoing, 'ArrowDown');
      if (indexOrder === 'before') {
        h.setSnapshots([moved]);
        h.emit();
        await flushMicrotasks();
      }

      pending.resolve(okTaskUnchanged(moved));
      await flushMicrotasks();
      if (indexOrder === 'after') {
        h.setSnapshots([moved]);
        h.emit();
        await flushMicrotasks();
      }

      const focused = timedBlock(h.el);
      expect(focused.dataset['tcTaskLine']).toBe('5');
      expect(activeDocument.activeElement).toBe(focused);

      const nav = h.el.querySelector<HTMLElement>('.tc-cal-nav-today')!;
      nav.focus();
      h.emit();
      await flushMicrotasks();
      expect(activeDocument.activeElement).toBe(nav);
    },
  );

  it('finishes a pending remount restoration when changed:false settles before its timer', async () => {
    const pending = deferredResult();
    const execute = vi.fn<TaskApplicationApi['execute']>().mockReturnValue(pending.promise);
    const original = keyboardSnapshot(TODAY, '09:00', 'same.md', 'revision-1', 4);
    const rebuilt = keyboardSnapshot(TODAY, '09:00', 'same.md', 'revision-2', 4);
    const h = keyboardPanelHarness([original], execute);
    clickCalendarView(h.el, 'Day');

    const outgoing = timedBlock(h.el);
    outgoing.focus();
    press(outgoing, 'ArrowDown');
    h.setSnapshots([rebuilt]);
    h.emit();
    expect(outgoing.isConnected).toBe(false);
    pending.resolve(okTaskUnchanged(rebuilt));
    await flushMicrotasks();

    const focused = timedBlock(h.el);
    expect(focused).not.toBe(outgoing);
    expect(activeDocument.activeElement).toBe(focused);
  });

  it('restores to an index candidate newer than the committed result revision', async () => {
    const pending = deferredResult();
    const execute = vi.fn<TaskApplicationApi['execute']>().mockReturnValue(pending.promise);
    const original = keyboardSnapshot(TODAY, '09:00', 'newer.md', 'revision-1', 4);
    const returned = keyboardSnapshot(TODAY, '09:15', 'newer.md', 'revision-2', 4);
    const indexed = keyboardSnapshot(TODAY, '09:30', 'newer.md', 'revision-3', 4);
    const h = keyboardPanelHarness([original], execute);
    clickCalendarView(h.el, 'Day');

    const outgoing = timedBlock(h.el);
    outgoing.focus();
    press(outgoing, 'ArrowDown');
    pending.resolve(okTask(returned));
    await flushMicrotasks();

    h.setSnapshots([indexed]);
    h.emit();
    await flushMicrotasks();

    const focused = timedBlock(h.el);
    expect(focused).not.toBe(outgoing);
    expect(activeDocument.activeElement).toBe(focused);
  });

  it('rebases the pending locator when a returned snapshot moves to a new line', async () => {
    const first = deferredResult();
    const second = deferredResult();
    const execute = vi
      .fn<TaskApplicationApi['execute']>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const original = keyboardSnapshot(TODAY, '09:00', 'moved.md', 'revision-1', 4);
    const moved = keyboardSnapshot(TODAY, '09:15', 'moved.md', 'revision-2', 5);
    const final = keyboardSnapshot(TODAY, '09:30', 'moved.md', 'revision-3', 5);
    const h = keyboardPanelHarness([original], execute);
    clickCalendarView(h.el, 'Day');

    const block = timedBlock(h.el);
    block.focus();
    press(block, 'ArrowDown');
    press(block, 'ArrowDown');
    h.setSnapshots([moved]);
    h.emit();
    first.resolve(okTask(moved));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(execute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        target: {
          type: 'task',
          ref: expect.objectContaining({ line: 5, revision: 'revision-2' }),
        },
      }),
    );

    h.setSnapshots([final]);
    h.emit();
    second.resolve(okTask(final));
    await flushMicrotasks();

    const focused = timedBlock(h.el);
    expect(focused.dataset['tcTaskLine']).toBe('5');
    expect(activeDocument.activeElement).toBe(focused);
  });

  it('invalidates an intermediate restored identity before the final moved outcome settles', async () => {
    const first = deferredResult();
    const second = deferredResult();
    const execute = vi
      .fn<TaskApplicationApi['execute']>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const original = keyboardSnapshot(TODAY, '09:00', 'moved.md', 'revision-1', 4);
    const intermediate = keyboardSnapshot(TODAY, '09:15', 'moved.md', 'revision-2', 5);
    const final = keyboardSnapshot(TODAY, '09:30', 'moved.md', 'revision-3', 6);
    const h = keyboardPanelHarness([original], execute);
    clickCalendarView(h.el, 'Day');

    const outgoing = timedBlock(h.el);
    outgoing.focus();
    press(outgoing, 'ArrowDown');
    press(outgoing, 'ArrowDown');
    first.resolve(okTask(intermediate));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    h.setSnapshots([intermediate]);
    h.emit();
    await flushMicrotasks();
    expect(activeDocument.activeElement).toBe(timedBlock(h.el));

    second.resolve(okTask(final));
    await flushMicrotasks();
    h.setSnapshots([final]);
    h.emit();
    await flushMicrotasks();

    const focused = timedBlock(h.el);
    expect(focused.dataset['tcTaskLine']).toBe('6');
    expect(activeDocument.activeElement).toBe(focused);
  });

  it('cancels an aliased sequence when explicit focus moves to a distinct timed block', async () => {
    const first = deferredResult();
    const staleSecond = deferredResult();
    const replacementResult = deferredResult();
    const execute = vi
      .fn<TaskApplicationApi['execute']>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(staleSecond.promise)
      .mockReturnValueOnce(replacementResult.promise);
    const original = keyboardSnapshot(TODAY, '09:00', 'shared.md', 'shared-revision', 4);
    const moved = keyboardSnapshot(TODAY, '09:15', 'shared.md', 'moved-revision', 5);
    const staleFinal = keyboardSnapshot(TODAY, '09:30', 'shared.md', 'stale-revision', 5);
    const replacement = keyboardSnapshot(TODAY, '14:00', 'shared.md', 'shared-revision', 4);
    const h = keyboardPanelHarness([original], execute);
    clickCalendarView(h.el, 'Day');

    const outgoing = timedBlock(h.el);
    outgoing.focus();
    press(outgoing, 'ArrowDown');
    press(outgoing, 'ArrowDown');
    first.resolve(okTask(moved));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));

    h.setSnapshots([replacement, moved]);
    h.emit();
    await flushMicrotasks();
    const replacementBlock = Array.from(h.el.querySelectorAll<HTMLElement>('.tc-tg-block')).find(
      (block) => block.dataset['tcTaskLine'] === '4',
    )!;
    replacementBlock.focus();
    press(replacementBlock, 'ArrowDown');

    staleSecond.resolve(okTask(staleFinal));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(3));
    expect(execute).toHaveBeenNthCalledWith(3, {
      type: 'patch',
      target: {
        type: 'task',
        ref: expect.objectContaining({
          line: 4,
          revision: 'shared-revision',
        }),
      },
      patch: { time: { type: 'set', value: '14:15' } },
    });

    replacementResult.resolve(
      okTask(keyboardSnapshot(TODAY, '14:15', 'shared.md', 'replacement-revision', 4)),
    );
  });

  it.each([
    ['same-revision', 'shared-revision'],
    ['different-revision', 'replacement-index-revision'],
  ] as const)(
    'cancels a pre-commit alias when %s replacement focus precedes the original result',
    async (_revisionKind, replacementRevision) => {
      const originalResult = deferredResult();
      const replacementResult = deferredResult();
      const execute = vi
        .fn<TaskApplicationApi['execute']>()
        .mockReturnValueOnce(originalResult.promise)
        .mockReturnValueOnce(replacementResult.promise);
      const original = keyboardSnapshot(TODAY, '09:00', 'shared.md', 'shared-revision', 4);
      const moved = keyboardSnapshot(TODAY, '09:15', 'shared.md', 'moved-revision', 5);
      const replacement = keyboardSnapshot(TODAY, '14:00', 'shared.md', replacementRevision, 4);
      const h = keyboardPanelHarness([original], execute);
      clickCalendarView(h.el, 'Day');

      const originBlock = timedBlock(h.el);
      originBlock.focus();
      press(originBlock, 'ArrowDown');
      h.setSnapshots([replacement, moved]);
      h.emit();
      await flushMicrotasks();

      const replacementBlock = Array.from(h.el.querySelectorAll<HTMLElement>('.tc-tg-block')).find(
        (block) => block.dataset['tcTaskLine'] === '4',
      )!;
      expect(activeDocument.activeElement).not.toBe(replacementBlock);
      replacementBlock.focus();
      press(replacementBlock, 'ArrowDown');
      originalResult.resolve(okTask(moved));
      await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));

      expect(execute).toHaveBeenNthCalledWith(2, {
        type: 'patch',
        target: {
          type: 'task',
          ref: expect.objectContaining({ line: 4, revision: replacementRevision }),
        },
        patch: { time: { type: 'set', value: '14:15' } },
      });
      replacementResult.resolve(
        okTask(keyboardSnapshot(TODAY, '14:15', 'shared.md', 'replacement-revision', 4)),
      );
    },
  );

  it.each(['throw', 'reject'] as const)(
    'clears focus ownership after execute %s and does not refocus on a later emit',
    async (failureMode) => {
      const execute = vi.fn<TaskApplicationApi['execute']>().mockImplementation(() => {
        if (failureMode === 'throw') throw new Error('boom');
        return Promise.reject(new Error('boom'));
      });
      const original = keyboardSnapshot(TODAY);
      const h = keyboardPanelHarness([original], execute);
      clickCalendarView(h.el, 'Day');

      const block = timedBlock(h.el);
      block.focus();
      press(block, 'ArrowDown');
      await flushMicrotasks();
      const other = h.el.querySelector<HTMLElement>('.tc-cal-nav-today')!;
      other.focus();
      h.emit();
      await flushMicrotasks();

      expect(activeDocument.activeElement).toBe(other);
    },
  );

  it('a failed horizontal command neither navigates nor steals focus', async () => {
    const pending = deferredResult();
    const original = keyboardSnapshot(TODAY);
    const execute = vi.fn<TaskApplicationApi['execute']>().mockReturnValue(pending.promise);
    const h = keyboardPanelHarness([original], execute);
    clickCalendarView(h.el, 'Day');
    const block = timedBlock(h.el);
    block.focus();
    press(block, 'ArrowRight');
    const other = h.el.querySelector<HTMLElement>('.tc-cal-nav-today')!;
    other.focus();
    pending.resolve({ type: 'conflict', current: original });
    await flushMicrotasks();

    expect(h.el.querySelector('.tc-tg-day-column')?.getAttribute('data-tg-date')).toBe(TODAY);
    expect(activeDocument.activeElement).toBe(other);
  });

  it.each(['view', 'mode', 'destroy'] as const)(
    '%s cancellation suppresses every late calendar hook',
    async (kind) => {
      const pending = deferredResult();
      const original = keyboardSnapshot(TODAY);
      const updated = keyboardSnapshot(
        moment(TODAY).add(1, 'day').format('YYYY-MM-DD'),
        '09:00',
        original.source.filePath,
        'revision-2',
      );
      const execute = vi.fn<TaskApplicationApi['execute']>().mockReturnValue(pending.promise);
      const h = keyboardPanelHarness([original], execute);
      clickCalendarView(h.el, 'Day');
      const block = timedBlock(h.el);
      block.focus();
      press(block, 'ArrowRight');

      if (kind === 'view') clickCalendarView(h.el, 'Month');
      else if (kind === 'mode') h.state.set('mode', 'tasks');
      else h.panel.destroy();
      pending.resolve(okTask(updated));
      await flushMicrotasks();

      expect(activeDocument.activeElement?.classList.contains('tc-tg-block')).toBe(false);
      if (kind === 'view') expect(h.el.querySelector('.tc-mg-grid')).not.toBeNull();
      if (kind === 'mode') expect(h.el.querySelector('.tc-center-header')).not.toBeNull();
      if (kind === 'destroy') expect(h.el.children).toHaveLength(0);
    },
  );
});
