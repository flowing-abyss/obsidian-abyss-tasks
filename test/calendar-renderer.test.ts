import type { App } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { DependencyIndex } from '../src/projects/dependencies/DependencyIndex';
import { DependencyPolicy } from '../src/projects/dependencies/DependencyPolicy';
import { buildDefaultTaskStatuses, DEFAULT_SETTINGS } from '../src/settings/defaults';
import { toStatusRules } from '../src/settings/statusCatalogAdapter';
import { StatusRegistry } from '../src/status/StatusRegistry';
import {
  localDate,
  type LocalDate,
  type TaskApplicationApi,
  type TaskIndexEvent,
  type TaskSnapshot,
} from '../src/tasks';
import { TaskApplicationService } from '../src/tasks/application/TaskApplicationService';
import { StatusCatalog } from '../src/tasks/domain/StatusCatalog';
import { TaskIndex } from '../src/tasks/infrastructure/TaskIndex';
import { TaskRefAuthority } from '../src/tasks/infrastructure/TaskRefAuthority';
import { TaskLocator } from '../src/tasks/infrastructure/markdown/TaskLocator';
import { TaskMarkdownCodec } from '../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { CalendarRenderer } from '../src/ui/CalendarRenderer';
import { InteractionRegistry, noInteractionOwnership } from '../src/ui/interactionOwnership';
import * as statusMenu from '../src/ui/statusMenu';
import {
  calendarMutationTarget,
  projectCalendarOccurrences,
  taskSnapshotForCalendarOccurrence,
} from '../src/views/calendarOccurrences';
import {
  configuredTaskApplication,
  createAppWithFiles,
  fixedToday,
  flushMicrotasks,
  freshContainer,
  queryApiForTasks,
  resolvedConfig,
  seedTaskCache,
  task,
  useRealMoment,
} from './helpers';
import { InMemoryTaskRepository } from './support/InMemoryTaskRepository';

useRealMoment();

class StubStore {
  private tasks: TaskSnapshot[] = [];
  private listeners = new Set<(event: TaskIndexEvent) => void>();
  statusRegistry = new StatusRegistry(buildDefaultTaskStatuses());
  taskQueries = queryApiForTasks(
    () => this.tasks,
    (listener) => {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    },
  );
  emit(changedFile?: string): void {
    for (const listener of this.listeners) {
      listener({ type: 'changed', files: changedFile ? [changedFile] : [] });
    }
  }
  setTasks(t: TaskSnapshot[]): void {
    this.tasks = t;
  }
  toggleTask = vi.fn();
  setTaskStatus = vi.fn();
  setPriority = vi.fn();
  execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
    type: 'invalid',
    issues: [{ code: 'invalid-target' }],
  });
  addTask = vi.fn<(date: string, text: string) => Promise<void>>().mockResolvedValue(undefined);
}

function fakeApp(): App {
  return {} as App;
}

function makeRenderer(
  root: HTMLElement,
  store: StubStore,
  config: ReturnType<typeof resolvedConfig>,
  app: App,
): CalendarRenderer {
  return new CalendarRenderer(
    root,
    config,
    app,
    store.taskQueries,
    { queries: store.taskQueries, execute: store.execute },
    store.statusRegistry,
    '- [ ] ',
  );
}

describe('CalendarRenderer', () => {
  describe('construction & mount', () => {
    it('constructor sets activeViewType from config.defaultView', () => {
      const store = new StubStore();
      const root = freshContainer();
      const r = makeRenderer(root, store, resolvedConfig({ defaultView: 'week' }), fakeApp());
      r.mount();
      expect(root.getAttribute('view')).toBe('week');
      r.destroy();
    });

    it('selectedDate = moment().date(1) when no startPosition', () => {
      const store = new StubStore();
      const root = freshContainer();
      const r = makeRenderer(root, store, resolvedConfig(), fakeApp());
      r.mount();
      // currentTitle reflects selectedDate month
      const tb = root.querySelector('.current') as HTMLButtonElement;
      expect(tb.textContent).toBe(
        `${window.moment().format('MMMM')} ${window.moment().format('YYYY')}`,
      );
      r.destroy();
    });

    it('selectedDate = moment(startPosition).date(1) when set', () => {
      const store = new StubStore();
      const root = freshContainer();
      const r = makeRenderer(root, store, resolvedConfig({ startPosition: '2026-03' }), fakeApp());
      r.mount();
      const tb = root.querySelector('.current') as HTMLButtonElement;
      expect(tb.textContent).toContain('March');
      expect(tb.textContent).toContain('2026');
      r.destroy();
    });

    it('preserves an exact configured startPosition when defaultView is week', () => {
      const store = new StubStore();
      const root = freshContainer();
      const r = makeRenderer(
        root,
        store,
        resolvedConfig({ defaultView: 'week', startPosition: '2025-12-29', firstDayOfWeek: 1 }),
        fakeApp(),
      );
      r.mount();
      const tb = root.querySelector('.current') as HTMLButtonElement;
      expect(tb.textContent).toBe('Week 1 · 2025');
      const dates = Array.from(root.querySelectorAll<HTMLAnchorElement>('.cellName')).map((cell) =>
        cell.getAttribute('href')?.split('/').pop(),
      );
      expect(dates).toEqual([
        '2025-12-29',
        '2025-12-30',
        '2025-12-31',
        '2026-01-01',
        '2026-01-02',
        '2026-01-03',
        '2026-01-04',
      ]);
      r.destroy();
    });

    it('mount wraps everything in a span', () => {
      const store = new StubStore();
      const root = freshContainer();
      const r = makeRenderer(root, store, resolvedConfig(), fakeApp());
      r.mount();
      expect(root.querySelector(':scope > span')).not.toBeNull();
      r.destroy();
    });

    it('mount instantiates Toolbar (.buttons present)', () => {
      const store = new StubStore();
      const root = freshContainer();
      const r = makeRenderer(root, store, resolvedConfig(), fakeApp());
      r.mount();
      expect(root.querySelector('.buttons')).not.toBeNull();
      r.destroy();
    });

    it('mount subscribes to store.onUpdate — emit triggers patch + updateToolbar', () => {
      const store = new StubStore();
      const root = freshContainer();
      const r = makeRenderer(root, store, resolvedConfig(), fakeApp());
      r.mount();
      store.setTasks([
        task({ status: 'open', planning: { due: window.moment().format('YYYY-MM-DD') } }),
      ]);
      store.emit();
      // after emit, toolbar stats should reflect 1 due task
      expect(
        root.querySelector('.statisticPopup li[data-group="due"] .stat-count')?.textContent,
      ).toBe('1');
      r.destroy();
    });
  });

  describe('view switching', () => {
    it('default month → grid with .gridHeads + .wrappers', () => {
      const store = new StubStore();
      const root = freshContainer();
      const r = makeRenderer(root, store, resolvedConfig({ defaultView: 'month' }), fakeApp());
      r.mount();
      expect(root.querySelector('.gridHeads')).not.toBeNull();
      expect(root.querySelector('.wrappers')).not.toBeNull();
      r.destroy();
    });

    it('switchView("week") → 7 cells', () => {
      const store = new StubStore();
      const root = freshContainer();
      const r = makeRenderer(root, store, resolvedConfig({ defaultView: 'month' }), fakeApp());
      r.mount();
      // click weekView button
      (root.querySelector('.weekView') as HTMLButtonElement).click();
      expect(root.querySelectorAll('.cell')).toHaveLength(7);
      r.destroy();
    });

    it('switchView("list") → .abyss-list-view present', () => {
      const store = new StubStore();
      const root = freshContainer();
      const r = makeRenderer(root, store, resolvedConfig({ defaultView: 'month' }), fakeApp());
      r.mount();
      (root.querySelector('.listView') as HTMLButtonElement).click();
      expect(root.querySelector('.abyss-list-view')).not.toBeNull();
      r.destroy();
    });

    it('renders List from persisted snapshots without requesting or merging forecasts', () => {
      const store = new StubStore();
      const persisted = task({
        title: 'Persisted daily repeat',
        recurrence: 'every day',
        planning: { due: window.moment().format('YYYY-MM-DD') },
      });
      store.setTasks([persisted]);
      const projection = vi.spyOn(store.taskQueries, 'forCalendarProjection');
      const root = freshContainer();
      const r = makeRenderer(
        root,
        store,
        resolvedConfig({ defaultView: 'list', startPosition: window.moment().format('YYYY-MM') }),
        fakeApp(),
      );

      r.mount();

      expect(projection).not.toHaveBeenCalled();
      expect(root.querySelectorAll('.abyss-list-task')).toHaveLength(1);
      expect(root.querySelector('.abyss-list-date-count')?.textContent).toBe('1');
      expect(root.querySelector("[data-recurrence-forecast='true']")).toBeNull();
      r.destroy();
    });

    it('switchView back to month restores month grid', () => {
      const store = new StubStore();
      const root = freshContainer();
      const r = makeRenderer(root, store, resolvedConfig({ defaultView: 'month' }), fakeApp());
      r.mount();
      (root.querySelector('.weekView') as HTMLButtonElement).click();
      expect(root.querySelector('.gridHeads')).toBeNull();
      (root.querySelector('.monthView') as HTMLButtonElement).click();
      expect(root.querySelector('.gridHeads')).not.toBeNull();
      r.destroy();
    });

    it('switchView(sameType) is a no-op', () => {
      const store = new StubStore();
      const root = freshContainer();
      const r = makeRenderer(root, store, resolvedConfig({ defaultView: 'month' }), fakeApp());
      r.mount();
      const gridBefore = root.querySelector('.grid');
      (root.querySelector('.monthView') as HTMLButtonElement).click();
      const gridAfter = root.querySelector('.grid');
      expect(gridAfter).toBe(gridBefore);
      r.destroy();
    });
  });

  describe('navigation', () => {
    it('onPrev in month → previous month title', () => {
      const store = new StubStore();
      const root = freshContainer();
      const r = makeRenderer(root, store, resolvedConfig({ defaultView: 'month' }), fakeApp());
      r.mount();
      const prevTitle = (root.querySelector('.current') as HTMLButtonElement).textContent;
      (root.querySelector('.previous') as HTMLButtonElement).click();
      const newTitle = (root.querySelector('.current') as HTMLButtonElement).textContent;
      expect(newTitle).not.toBe(prevTitle);
      r.destroy();
    });

    it('onNext in month → next month title', () => {
      const store = new StubStore();
      const root = freshContainer();
      const r = makeRenderer(root, store, resolvedConfig({ defaultView: 'month' }), fakeApp());
      r.mount();
      const prevTitle = (root.querySelector('.current') as HTMLButtonElement).textContent;
      (root.querySelector('.next') as HTMLButtonElement).click();
      expect((root.querySelector('.current') as HTMLButtonElement).textContent).not.toBe(prevTitle);
      r.destroy();
    });

    it('onToday resets to current month', () => {
      const store = new StubStore();
      const root = freshContainer();
      const r = makeRenderer(
        root,
        store,
        resolvedConfig({ defaultView: 'month', startPosition: '2026-01' }),
        fakeApp(),
      );
      r.mount();
      // navigate away then today
      (root.querySelector('.next') as HTMLButtonElement).click();
      (root.querySelector('.current') as HTMLButtonElement).click(); // "current" button = onToday
      expect((root.querySelector('.current') as HTMLButtonElement).textContent).toContain(
        window.moment().format('MMMM'),
      );
      r.destroy();
    });

    it('currentTitle week format = "Week N · YYYY"', () => {
      const store = new StubStore();
      const root = freshContainer();
      const r = makeRenderer(root, store, resolvedConfig({ defaultView: 'week' }), fakeApp());
      r.mount();
      expect((root.querySelector('.current') as HTMLButtonElement).textContent).toMatch(
        /^Week \d+ · \d{4}$/,
      );
      r.destroy();
    });
  });

  describe('toolbar wiring', () => {
    it('onFilterToggle toggles rootEl "filter" class', () => {
      const store = new StubStore();
      const root = freshContainer();
      const r = makeRenderer(root, store, resolvedConfig(), fakeApp());
      r.mount();
      expect(root.classList.contains('filter')).toBe(false);
      (root.querySelector('.filter') as HTMLButtonElement).click();
      expect(root.classList.contains('filter')).toBe(true);
      (root.querySelector('.filter') as HTMLButtonElement).click();
      expect(root.classList.contains('filter')).toBe(false);
      r.destroy();
    });

    it('onOverdueHighlight toggles overdue button active', () => {
      const store = new StubStore();
      const root = freshContainer();
      const r = makeRenderer(root, store, resolvedConfig(), fakeApp());
      r.mount();
      const btn = root.querySelector('.overdueHighlighter') as HTMLButtonElement;
      btn.click();
      expect(btn.classList.contains('active')).toBe(true);
      btn.click();
      expect(btn.classList.contains('active')).toBe(false);
      r.destroy();
    });

    it('onStatFilter(group) → rootEl gains focus<Group> class', () => {
      const store = new StubStore();
      const root = freshContainer();
      const r = makeRenderer(root, store, resolvedConfig(), fakeApp());
      r.mount();
      // open stat popup and click a group li
      (root.querySelector('.statistic') as HTMLButtonElement).click();
      (root.querySelector('.statisticPopup li[data-group="due"]') as HTMLElement).click();
      expect(root.classList.contains('focusDue')).toBe(true);
      r.destroy();
    });

    it('onStatFilter(null) → all focus* classes removed', () => {
      const store = new StubStore();
      const root = freshContainer();
      const r = makeRenderer(root, store, resolvedConfig(), fakeApp());
      r.mount();
      (root.querySelector('.statistic') as HTMLButtonElement).click();
      const li = root.querySelector('.statisticPopup li[data-group="due"]') as HTMLElement;
      li.click(); // activate
      li.click(); // deactivate → onStatFilter(null)
      expect(root.className.split(' ').filter((c) => c.startsWith('focus'))).toHaveLength(0);
      r.destroy();
    });

    it('onStyleChange("style3") → style class swapped on rootEl', () => {
      const store = new StubStore();
      const root = freshContainer();
      const r = makeRenderer(
        root,
        store,
        resolvedConfig({ defaultView: 'month', style: 'style1' }),
        fakeApp(),
      );
      r.mount();
      // open style popup by clicking active view button
      (root.querySelector('.monthView') as HTMLButtonElement).click();
      (root.querySelector('.weekViewContext li[data-style="style3"]') as HTMLElement).click();
      expect(root.classList.contains('style3')).toBe(true);
      expect(root.classList.contains('style1')).toBe(false);
      r.destroy();
    });
  });

  describe('stats computation', () => {
    it('stats reflect TaskQueryApi snapshots', () => {
      const store = new StubStore();
      const root = freshContainer();
      const r = makeRenderer(root, store, resolvedConfig(), fakeApp());
      r.mount();
      const todayStr = window.moment().format('YYYY-MM-DD');
      store.setTasks([
        task({ status: 'done' }),
        task({ status: 'open', planning: { due: todayStr } }),
        task({ status: 'open', planning: { due: '2020-01-01' } }),
        task({ status: 'open', planning: { start: todayStr } }),
      ]);
      store.emit();
      expect(
        root.querySelector('.statisticPopup li[data-group="done"] .stat-count')?.textContent,
      ).toBe('1');
      // CURRENT BEHAVIOR: "due" counts all open tasks with a due field (both today and 2020-01-01).
      expect(
        root.querySelector('.statisticPopup li[data-group="due"] .stat-count')?.textContent,
      ).toBe('2');
      expect(
        root.querySelector('.statisticPopup li[data-group="start"] .stat-count')?.textContent,
      ).toBe('1');
      r.destroy();
    });
  });

  describe('callbacks', () => {
    it('onWeekClick switches to week view + updates selectedDate', () => {
      const store = new StubStore();
      const root = freshContainer();
      const r = makeRenderer(root, store, resolvedConfig({ defaultView: 'month' }), fakeApp());
      r.mount();
      // find first wrapperButton and click it (triggers onWeekClick)
      const wBtn = root.querySelector('.wrapperButton') as HTMLElement;
      wBtn.click();
      // view should switch to week → 7 cells
      expect(root.querySelectorAll('.cell')).toHaveLength(7);
      r.destroy();
    });

    // CURRENT BEHAVIOR (follow-up: FU-20): onWeekClick while already in week view
    // updates selectedDate but does NOT re-render (switchView early-returns on same type).
    // This bug is NOT triggerable through the CalendarRenderer UI alone (onWeekClick is
    // only wired to MonthView's wrapperButton, absent in week view). It's reachable only
    // via CenterPanel's separate onWeekClick wiring. Pinned as documentation-only —
    // no executable test here; covered conceptually by the switchView(sameType) no-op test above.
    it('FU-20: onWeekClick-in-week-view no-rerender bug is unreachable via CalendarRenderer UI', () => {
      const store = new StubStore();
      const root = freshContainer();
      const r = makeRenderer(root, store, resolvedConfig({ defaultView: 'week' }), fakeApp());
      r.mount();
      // Week view has no .wrapperButton elements to click, so the bug cannot manifest here.
      expect(root.querySelectorAll('.wrapperButton')).toHaveLength(0);
      r.destroy();
    });

    it('onToggle(task) sends toggle intent through TaskApplicationApi', () => {
      const store = new StubStore();
      const root = freshContainer();
      const r = makeRenderer(root, store, resolvedConfig({ defaultView: 'month' }), fakeApp());
      r.mount();
      const todayStr = window.moment().format('YYYY-MM-DD');
      const t = task({ status: 'open', planning: { due: todayStr } });
      store.setTasks([t]);
      store.emit();
      // click the status marker inside the task card
      const marker = root.querySelector('.task .abyss-status-marker') as HTMLElement;
      marker.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      expect(store.execute).toHaveBeenCalledWith({
        type: 'toggle-completion',
        target: {
          type: 'task',
          ref: expect.objectContaining({ filePath: t.ref.filePath, line: t.ref.line }),
        },
      });
      r.destroy();
    });

    it.each([
      { surface: 'month', view: 'month' as const, startPosition: '2026-08', time: '' },
      { surface: 'week all-day', view: 'week' as const, startPosition: '2026-08-24', time: '' },
      {
        surface: 'week timed',
        view: 'week' as const,
        startPosition: '2026-08-24',
        time: ' ⏰ 09:00',
      },
    ])(
      'blocks a dependent completion from the rendered $surface calendar before repository mutation',
      async ({ view, startPosition, time }) => {
        const path = 'Tasks.md';
        const source = '- [ ] Prepare 🆔 prep\n' + `- [ ] Ship ⛔ prep 📅 2026-08-28${time}\n`;
        const app = await createAppWithFiles({ [path]: source });
        const statusCatalog = new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses));
        const authority = new TaskRefAuthority('calendar-dependency-policy');
        const index = new TaskIndex(app, {
          statusCatalog,
          dailyNoteFormat: DEFAULT_SETTINGS.desktop.dailyNoteFormat,
          refAuthority: authority,
        });
        await index.initialize();
        index.installCommittedContent(path, source);
        const graph = new DependencyIndex(index);
        const policy = new DependencyPolicy(graph);
        const repository = new InMemoryTaskRepository({
          files: { [path]: source },
          codec: new TaskMarkdownCodec(statusCatalog),
          snapshotsFromContent: (filePath, content) => index.previewContent(filePath, content),
          locator: new TaskLocator(authority),
          refAuthority: authority,
          snapshotState: index,
        });
        const application = new TaskApplicationService(
          index,
          repository,
          statusCatalog,
          { today: () => localDate('2026-08-28') },
          undefined,
          undefined,
          graph,
          policy,
        );
        const execute = vi.spyOn(application, 'execute');
        const root = freshContainer();
        const renderer = new CalendarRenderer(
          root,
          resolvedConfig({ defaultView: view, startPosition }),
          app,
          index,
          application,
          new StatusRegistry(DEFAULT_SETTINGS.taskStatuses),
          '',
          { removeScheduledDate: false },
          undefined,
          noInteractionOwnership,
          policy,
        );
        renderer.mount();

        const cards = Array.from(root.querySelectorAll<HTMLElement>('.task'));
        expect(cards.map((card) => card.textContent)).toContainEqual(
          expect.stringContaining('Ship'),
        );
        const ship = cards.find((card) => card.textContent?.includes('Ship'));
        expect(ship).toBeDefined();
        const marker = ship?.querySelector<HTMLElement>('.abyss-status-marker');
        expect(marker?.getAttribute('aria-disabled')).toBe('true');
        expect(marker?.hasAttribute('disabled')).toBe(false);
        ship
          ?.querySelector<HTMLElement>('.abyss-status-marker')
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await flushMicrotasks();

        expect(execute).toHaveBeenCalledOnce();
        await expect(execute.mock.results[0]?.value).resolves.toMatchObject({
          type: 'blocked',
          operation: 'completion',
        });
        expect(repository.content(path)).toBe(source);
        renderer.destroy();
        graph.destroy();
        index.destroy();
      },
    );

    it.each([
      { activation: 'click' as const, label: 'click' },
      { activation: 'Enter' as const, label: 'Enter' },
      { activation: ' ' as const, label: 'Space' },
    ])(
      'keeps a calendar subtask occurrence completion available on $label when its root is blocked',
      async ({ activation }) => {
        const path = 'Tasks.md';
        const source = [
          '- [ ] Prepare 🆔 prep',
          '- [ ] Blocked root ⛔ prep',
          '  - [ ] Planned subtask 🔁 every day 📅 2026-08-28',
        ].join('\n');
        const app = await createAppWithFiles({ [path]: source });
        const statusCatalog = new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses));
        const authority = new TaskRefAuthority(`calendar-subtask-${activation}`);
        const index = new TaskIndex(app, {
          statusCatalog,
          dailyNoteFormat: DEFAULT_SETTINGS.desktop.dailyNoteFormat,
          refAuthority: authority,
        });
        await index.initialize();
        index.installCommittedContent(path, source);
        const graph = new DependencyIndex(index);
        const policy = new DependencyPolicy(graph);
        const repository = new InMemoryTaskRepository({
          files: { [path]: source },
          codec: new TaskMarkdownCodec(statusCatalog),
          snapshotsFromContent: (filePath, content) => index.previewContent(filePath, content),
          locator: new TaskLocator(authority),
          refAuthority: authority,
          snapshotState: index,
        });
        const application = new TaskApplicationService(
          index,
          repository,
          statusCatalog,
          { today: () => localDate('2026-08-28') },
          undefined,
          undefined,
          graph,
          policy,
        );
        const execute = vi.spyOn(application, 'execute');
        const root = freshContainer();
        const renderer = new CalendarRenderer(
          root,
          resolvedConfig({ defaultView: 'month', startPosition: '2026-08' }),
          app,
          index,
          application,
          new StatusRegistry(DEFAULT_SETTINGS.taskStatuses),
          '',
          { removeScheduledDate: false },
          undefined,
          noInteractionOwnership,
          policy,
        );
        renderer.mount();

        const card = Array.from(root.querySelectorAll<HTMLElement>('.task')).find((candidate) =>
          candidate.textContent?.includes('Planned subtask'),
        );
        expect(card).toBeDefined();
        const marker = card!.querySelector<HTMLElement>('.abyss-status-marker')!;
        expect(marker.hasAttribute('aria-disabled')).toBe(false);
        marker.dispatchEvent(
          activation === 'click'
            ? new MouseEvent('click', { bubbles: true, cancelable: true })
            : new KeyboardEvent('keydown', {
                key: activation,
                bubbles: true,
                cancelable: true,
              }),
        );
        await flushMicrotasks();

        expect(execute).toHaveBeenCalledOnce();
        expect(execute).toHaveBeenCalledWith({
          type: 'toggle-completion',
          target: expect.objectContaining({ type: 'subtask' }),
        });
        await expect(execute.mock.results[0]?.value).resolves.toMatchObject({ type: 'ok' });
        expect(repository.content(path)).toContain(
          '  - [x] Planned subtask 🔁 every day 📅 2026-08-28',
        );
        expect(repository.content(path)).toContain('- [ ] Blocked root ⛔ prep');
        renderer.destroy();
        graph.destroy();
        index.destroy();
      },
    );

    it('renders forecast badges without counting or mutating projected occurrences', () => {
      const store = new StubStore();
      const root = freshContainer();
      const current = task({
        title: 'Repeat source',
        recurrence: 'every day',
        planning: { due: '2026-08-01' },
      });
      store.setTasks([current]);
      const r = makeRenderer(
        root,
        store,
        resolvedConfig({ defaultView: 'month', startPosition: '2026-08' }),
        fakeApp(),
      );

      r.mount();

      const forecastBadge = root.querySelector<HTMLElement>("[data-recurrence-forecast='true']");
      expect(forecastBadge).not.toBeNull();
      const forecastCard = forecastBadge?.closest<HTMLElement>('.task');
      expect(forecastCard?.getAttribute('draggable')).toBeNull();
      forecastCard?.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );
      forecastCard
        ?.querySelector<HTMLElement>('.abyss-status-marker')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      expect(store.execute).not.toHaveBeenCalled();
      expect(
        root.querySelector('.statisticPopup li[data-group="recurrence"] .stat-count')?.textContent,
      ).toBe('1');
      r.destroy();
    });

    it('materializes one Tasks-compatible successor through the calendar and reloads without a duplicate', async () => {
      const path = 'Projects/Recurring.md';
      const originalMarkdown = '- [ ] Daily review #project 🔁 every day 📅 2026-08-03\n';
      const app = await createAppWithFiles({ [path]: originalMarkdown });
      const statusCatalog = new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses));
      const authority = new TaskRefAuthority('cross-surface-calendar');
      const index = new TaskIndex(app, {
        statusCatalog,
        dailyNoteFormat: DEFAULT_SETTINGS.desktop.dailyNoteFormat,
        refAuthority: authority,
      });
      await index.initialize();
      const repository = new InMemoryTaskRepository({
        files: { [path]: originalMarkdown },
        codec: new TaskMarkdownCodec(statusCatalog),
        snapshotsFromContent: (filePath, content) => index.previewContent(filePath, content),
        locator: new TaskLocator(authority),
        refAuthority: authority,
        snapshotState: index,
      });
      const application = new TaskApplicationService(
        index,
        repository,
        statusCatalog,
        { today: () => localDate('2026-08-03') },
        undefined,
        () => ({
          taskLifecycle: { addCreatedDate: true, addCompletionDate: true },
          recurrence: { newOccurrencePlacement: 'before', removeScheduledDate: false },
        }),
      );
      const execute = vi.spyOn(application, 'execute');
      const rangeDates = (from: string, days: number): LocalDate[] =>
        Array.from({ length: days }, (_, offset) =>
          localDate(window.moment(from).add(offset, 'days').format('YYYY-MM-DD')),
        );
      const monthDates = rangeDates('2026-08-01', 31);
      const weekDates = rangeDates('2026-08-03', 7);
      const projectionFor = (dates: LocalDate[]) =>
        projectCalendarOccurrences(
          index.forCalendarProjection(dates),
          { from: dates[0]!, to: dates[dates.length - 1]! },
          { removeScheduledDate: false },
        );
      const monthBefore = projectionFor(monthDates);
      const weekBefore = projectionFor(weekDates);
      const materialized = monthBefore.occurrences.find(
        (occurrence) => occurrence.kind === 'materialized',
      )!;
      const calendarTask = taskSnapshotForCalendarOccurrence(materialized);
      const exactTarget = calendarMutationTarget(calendarTask)!;
      const consumedRevision = exactTarget.type === 'task' ? exactTarget.ref.revision : '';

      expect(monthBefore.occurrences.filter(({ kind }) => kind === 'forecast').length).toBe(28);
      expect(weekBefore.occurrences.map(({ kind, planning }) => [kind, planning.due])).toEqual([
        ['materialized', '2026-08-03'],
        ['forecast', '2026-08-04'],
        ['forecast', '2026-08-05'],
        ['forecast', '2026-08-06'],
        ['forecast', '2026-08-07'],
        ['forecast', '2026-08-08'],
        ['forecast', '2026-08-09'],
      ]);
      expect(exactTarget).toEqual(materialized.source.target);
      expect(consumedRevision).not.toMatch(/(?:fake|test):/u);

      const root = freshContainer();
      const renderer = new CalendarRenderer(
        root,
        resolvedConfig({ defaultView: 'month', startPosition: '2026-08' }),
        app,
        index,
        application,
        new StatusRegistry(DEFAULT_SETTINGS.taskStatuses),
      );
      renderer.mount();

      try {
        const materializedCard = Array.from(root.querySelectorAll<HTMLElement>('.task')).find(
          (card) => card.querySelector("[data-recurrence-forecast='true']") === null,
        );
        expect(materializedCard).toBeDefined();
        materializedCard
          ?.querySelector<HTMLElement>('.abyss-status-marker')
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await flushMicrotasks(30);

        expect(execute).toHaveBeenCalledTimes(1);
        expect(execute).toHaveBeenCalledWith({ type: 'toggle-completion', target: exactTarget });
        expect(repository.content(path)).toBe(
          '- [ ] Daily review #project 🔁 every day ➕ 2026-08-03 📅 2026-08-04\n' +
            '- [x] Daily review #project 🔁 every day 📅 2026-08-03 ✅ 2026-08-03\n',
        );

        const persisted = index.list({ filePath: path });
        const active = persisted.filter((candidate) => candidate.status === 'open');
        expect(
          active.map(({ planning, ref }) => ({ due: planning.due, revision: ref.revision })),
        ).toEqual([{ due: '2026-08-04', revision: expect.any(String) }]);
        expect(active[0]?.ref.revision).not.toBe(consumedRevision);
        expect(persisted.filter((candidate) => candidate.status === 'done')).toHaveLength(1);

        const afterProjection = projectionFor(rangeDates('2026-08-04', 7));
        expect(
          afterProjection.occurrences.map(({ kind, planning }) => [kind, planning.due]),
        ).toEqual([
          ['materialized', '2026-08-04'],
          ['forecast', '2026-08-05'],
          ['forecast', '2026-08-06'],
          ['forecast', '2026-08-07'],
          ['forecast', '2026-08-08'],
          ['forecast', '2026-08-09'],
          ['forecast', '2026-08-10'],
        ]);
        expect(new Set(afterProjection.occurrences.map(({ key }) => key)).size).toBe(
          afterProjection.occurrences.length,
        );

        const beforeStaleRetry = repository.content(path);
        await expect(
          application.execute({ type: 'toggle-completion', target: exactTarget }),
        ).resolves.toMatchObject({ type: 'conflict' });
        expect(repository.content(path)).toBe(beforeStaleRetry);

        const reloadedApp = await createAppWithFiles({ [path]: repository.content(path)! });
        seedTaskCache(reloadedApp, path, [
          { task: ' ', parent: -1, line: 0 },
          { task: 'x', parent: -1, line: 1 },
        ]);
        const reloaded = new TaskIndex(reloadedApp, {
          statusCatalog,
          dailyNoteFormat: DEFAULT_SETTINGS.desktop.dailyNoteFormat,
          refAuthority: new TaskRefAuthority('cross-surface-reload'),
        });
        await reloaded.initialize();
        try {
          const reloadedPersisted = reloaded.list({ filePath: path });
          const reloadedProjection = projectCalendarOccurrences(
            reloaded.forCalendarProjection(rangeDates('2026-08-04', 7)),
            { from: localDate('2026-08-04'), to: localDate('2026-08-10') },
            { removeScheduledDate: false },
          );
          expect(
            reloadedPersisted.map(({ status, planning, source }) => ({
              status,
              due: planning.due,
              line: source.line,
              markdown: source.originalMarkdown,
            })),
          ).toEqual([
            {
              status: 'open',
              due: '2026-08-04',
              line: 0,
              markdown: '- [ ] Daily review #project 🔁 every day ➕ 2026-08-03 📅 2026-08-04',
            },
            {
              status: 'done',
              due: '2026-08-03',
              line: 1,
              markdown: '- [x] Daily review #project 🔁 every day 📅 2026-08-03 ✅ 2026-08-03',
            },
          ]);
          expect(
            reloadedPersisted.filter(
              ({ status, planning }) => status === 'open' && planning.due === '2026-08-04',
            ),
          ).toHaveLength(1);
          expect(reloadedPersisted[0]?.ref.revision).not.toBe(active[0]?.ref.revision);
          expect(reloaded.resolve(active[0]!.ref)).toMatchObject({
            type: 'visual',
            evidence: 'same-line',
          });
          expect(
            reloadedProjection.occurrences.filter(
              ({ kind, planning }) => kind === 'materialized' && planning.due === '2026-08-04',
            ),
          ).toHaveLength(1);
          expect(new Set(reloadedProjection.occurrences.map(({ key }) => key)).size).toBe(
            reloadedProjection.occurrences.length,
          );
          expect(repository.content(path)).not.toContain('🆔');
        } finally {
          reloaded.destroy();
        }
      } finally {
        renderer.destroy();
        index.destroy();
      }
    });

    it('keeps a nested owner represented through its persisted root alongside ordinary overdue tasks', async () => {
      const nestedDate = window.moment().format('YYYY-MM-DD');
      const overdueDate = window.moment().subtract(1, 'day').format('YYYY-MM-DD');
      const app = await createAppWithFiles({
        'list.md': [
          `- [ ] Parent 📅 ${nestedDate}`,
          `  - [ ] Nested repeat 🔁 every week ⏰ 07:31 📅 ${nestedDate}`,
        ].join('\n'),
        'overdue.md': `- [ ] Legacy overdue ⏰ 06:11 📅 ${overdueDate}`,
      });
      const configured = configuredTaskApplication(app, DEFAULT_SETTINGS);
      await configured.index.initialize();
      expect(
        configured.tasks.queries.list().map(({ title, planning }) => ({ title, planning })),
      ).toEqual([
        { title: 'Parent', planning: { due: nestedDate } },
        { title: 'Legacy overdue', planning: { due: overdueDate, time: '06:11' } },
      ]);
      const persistedRoot = configured.tasks.queries.list()[0]!;
      const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
        type: 'invalid',
        issues: [{ code: 'invalid-target' }],
      });
      const root = freshContainer();
      const r = new CalendarRenderer(
        root,
        resolvedConfig({
          defaultView: 'list',
          startPosition: window.moment().format('YYYY-MM'),
        }),
        app,
        configured.tasks.queries,
        { queries: configured.tasks.queries, execute },
        configured.statusRegistry,
      );

      r.mount();

      const overdueSection = root.querySelector('.abyss-list-overdue-header')?.parentElement;
      expect(
        overdueSection?.querySelector('.abyss-list-date-count')?.textContent,
        'the ordinary root retains legacy overdue rendering',
      ).toBe('1');
      expect(overdueSection?.querySelector('.abyss-task-time')?.textContent).toBe('06:11');
      const todaySection = Array.from(
        root.querySelectorAll<HTMLElement>('.abyss-list-section'),
      ).find((section) => section.querySelector('.abyss-list-date-label')?.textContent === 'Today');
      const persistedRow = Array.from(
        todaySection?.querySelectorAll<HTMLElement>('.abyss-list-task') ?? [],
      ).find((row) => row.querySelector('.abyss-task-progress')?.textContent === '0/1');
      expect(persistedRow, 'the persisted root represents its nested owner').toBeDefined();
      expect(persistedRow?.querySelector('.abyss-task-time')).toBeNull();
      expect(root.textContent).not.toContain('07:31');
      persistedRow
        ?.querySelector<HTMLElement>('.abyss-status-marker')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      expect(execute).toHaveBeenCalledWith({
        type: 'toggle-completion',
        target: { type: 'task', ref: persistedRoot.ref },
      });

      r.destroy();
      configured.index.destroy();
    });

    it('opens recurrence from the materialized task body but keeps checkbox menus focused on task state', () => {
      const store = new StubStore();
      const root = freshContainer();
      const r = makeRenderer(root, store, resolvedConfig({ defaultView: 'month' }), fakeApp());
      const todayStr = window.moment().format('YYYY-MM-DD');
      store.setTasks([
        task({ status: 'open', recurrence: 'every week', planning: { due: todayStr } }),
      ]);
      r.mount();

      const body = root.querySelector<HTMLElement>('.task .inner-link')!;
      const marker = root.querySelector<HTMLElement>('.task .abyss-status-marker')!;

      body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      const recurrence = activeDocument.querySelector<HTMLElement>('.abyss-recurrence-popover');
      expect(recurrence?.querySelector<HTMLInputElement>('.abyss-recurrence-raw')?.value).toBe(
        'every week',
      );
      recurrence
        ?.querySelector<HTMLElement>('.abyss-recurrence-editor')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

      marker.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      expect(activeDocument.querySelector('.abyss-status-popover-edit-repeat')).toBeNull();
      expect(activeDocument.querySelector('.abyss-recurrence-popover')).toBeNull();
      r.destroy();
    });

    it('tears down the body-mounted status menu on calendar rerender and destroy', () => {
      vi.useFakeTimers();
      const store = new StubStore();
      const root = freshContainer();
      const r = makeRenderer(root, store, resolvedConfig({ defaultView: 'month' }), fakeApp());
      const todayStr = window.moment().format('YYYY-MM-DD');
      store.setTasks([task({ title: 'Before patch', planning: { due: todayStr } })]);
      const remove = vi.spyOn(root.ownerDocument, 'removeEventListener');
      const owned = r as unknown as { statusMenuCleanup: (() => void) | null };
      r.mount();

      try {
        root
          .querySelector<HTMLElement>('.task .abyss-status-marker')!
          .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        vi.runOnlyPendingTimers();
        expect(activeDocument.querySelector('.abyss-status-popover')).not.toBeNull();
        expect(owned.statusMenuCleanup).not.toBeNull();

        activeDocument.querySelector<HTMLButtonElement>('.abyss-status-popover-flag')!.click();
        expect(activeDocument.querySelector('.abyss-status-popover')).toBeNull();
        expect(owned.statusMenuCleanup).toBeNull();

        root
          .querySelector<HTMLElement>('.task .abyss-status-marker')!
          .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        vi.runOnlyPendingTimers();

        store.setTasks([task({ title: 'After patch', planning: { due: todayStr } })]);
        store.emit();
        expect(activeDocument.querySelector('.abyss-status-popover')).toBeNull();

        root
          .querySelector<HTMLElement>('.task .abyss-status-marker')!
          .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        vi.runOnlyPendingTimers();
        expect(activeDocument.querySelector('.abyss-status-popover')).not.toBeNull();

        r.destroy();
        expect(activeDocument.querySelector('.abyss-status-popover')).toBeNull();
        expect(remove.mock.calls.some(([type]) => type === 'keydown')).toBe(true);
        expect(remove.mock.calls.some(([type]) => type === 'mousedown')).toBe(true);
      } finally {
        r.destroy();
        activeDocument
          .querySelectorAll('.abyss-status-popover')
          .forEach((element) => element.remove());
        remove.mockRestore();
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    });

    it('releases an ordinarily closed status handle without letting a stale close clear its successor', () => {
      const closeNotifications: Array<() => void> = [];
      const handles: Array<{ element: HTMLElement; close: () => void }> = [];
      const show = vi.spyOn(statusMenu, 'showStatusMenuAt').mockImplementation((_event, opts) => {
        const element = activeDocument.body.createDiv({ cls: 'abyss-status-popover' });
        const { onClose } = opts;
        let closed = false;
        const handle = {
          element,
          close: (): void => {
            if (closed) return;
            closed = true;
            element.remove();
            onClose?.();
          },
        };
        closeNotifications.push(() => onClose?.());
        handles.push(handle);
        return handle;
      });
      const store = new StubStore();
      const root = freshContainer();
      const r = makeRenderer(root, store, resolvedConfig({ defaultView: 'month' }), fakeApp());
      const owned = r as unknown as { statusMenuCleanup: (() => void) | null };
      store.setTasks([
        task({
          title: 'Status lifecycle',
          planning: { due: window.moment().format('YYYY-MM-DD') },
        }),
      ]);
      r.mount();

      try {
        const marker = root.querySelector<HTMLElement>('.task .abyss-status-marker')!;
        marker.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        expect(owned.statusMenuCleanup).not.toBeNull();

        handles[0]!.close();
        expect(owned.statusMenuCleanup).toBeNull();

        marker.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        const successorCleanup = owned.statusMenuCleanup;
        expect(successorCleanup).not.toBeNull();

        closeNotifications[0]!();
        expect(owned.statusMenuCleanup).toBe(successorCleanup);
        expect(handles[1]!.element.isConnected).toBe(true);
      } finally {
        r.destroy();
        for (const handle of handles) handle.close();
        show.mockRestore();
      }
    });

    it('requires a real confirmation click before invalid Delete completion removes the subtree', async () => {
      const todayStr = window.moment().format('YYYY-MM-DD');
      const app = await createAppWithFiles({
        'repeat.md': `- [ ] Invalid repeat 🔁 tomorrow 🏁 delete 📅 ${todayStr}\n  - [ ] Child\n`,
      });
      const settings = resolvedConfig({ defaultView: 'month' });
      const configured = configuredTaskApplication(app, DEFAULT_SETTINGS);
      await configured.index.initialize();
      const root = freshContainer();
      const r = new CalendarRenderer(
        root,
        settings,
        app,
        configured.tasks.queries,
        configured.tasks,
        configured.statusRegistry,
      );
      r.mount();

      root
        .querySelector<HTMLElement>('.task .abyss-status-marker')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

      const confirmation = activeDocument.querySelector<HTMLElement>(
        '.abyss-recurrence-delete-confirm',
      );
      expect(confirmation?.getAttribute('role')).toBe('alertdialog');
      expect(confirmation?.textContent).toContain(
        'The complete task and its sub-tasks will be deleted. No next occurrence will be created.',
      );
      expect(configured.tasks.queries.list()).toHaveLength(1);

      confirmation
        ?.querySelector<HTMLButtonElement>('.abyss-recurrence-delete-confirm-button')
        ?.click();
      await flushMicrotasks();

      expect(configured.tasks.queries.list()).toHaveLength(0);
      r.destroy();
      configured.index.destroy();
    });

    it('keeps the invalid Delete subtree unchanged when its real confirmation is cancelled', async () => {
      const todayStr = window.moment().format('YYYY-MM-DD');
      const app = await createAppWithFiles({
        'repeat-cancel.md':
          `- [ ] Invalid repeat 🔁 tomorrow 🏁 delete 📅 ${todayStr}\n` + '  - [ ] Child\n',
      });
      const configured = configuredTaskApplication(app, DEFAULT_SETTINGS);
      await configured.index.initialize();
      const root = freshContainer();
      const r = new CalendarRenderer(
        root,
        resolvedConfig({ defaultView: 'month' }),
        app,
        configured.tasks.queries,
        configured.tasks,
        configured.statusRegistry,
      );
      r.mount();

      root
        .querySelector<HTMLElement>('.task .abyss-status-marker')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      const confirmation = activeDocument.querySelector<HTMLElement>(
        '.abyss-recurrence-delete-confirm',
      )!;
      Array.from(confirmation.querySelectorAll<HTMLButtonElement>('button'))
        .find((candidate) => candidate.textContent === 'Cancel')
        ?.click();
      await flushMicrotasks();

      expect(activeDocument.querySelector('.abyss-recurrence-delete-confirm')).toBeNull();
      expect(configured.tasks.queries.list()).toHaveLength(1);
      expect(configured.tasks.queries.list()[0]?.subtasks).toHaveLength(1);
      r.destroy();
      configured.index.destroy();
    });

    it('releases CalendarRenderer recurrence-dialog ownership on renderer teardown', async () => {
      const todayStr = window.moment().format('YYYY-MM-DD');
      const app = await createAppWithFiles({
        'repeat-destroy.md': `- [ ] Invalid repeat 🔁 tomorrow 🏁 delete 📅 ${todayStr}\n`,
      });
      const configured = configuredTaskApplication(app, DEFAULT_SETTINGS);
      await configured.index.initialize();
      const registry = new InteractionRegistry<string>();
      const root = freshContainer();
      const renderer = new CalendarRenderer(
        root,
        resolvedConfig({ defaultView: 'month' }),
        app,
        configured.tasks.queries,
        configured.tasks,
        configured.statusRegistry,
        '',
        { removeScheduledDate: false },
        undefined,
        registry,
      );
      renderer.mount();

      root
        .querySelector<HTMLElement>('.task .abyss-status-marker')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      const confirmation = activeDocument.querySelector<HTMLElement>(
        '.abyss-recurrence-delete-confirm',
      )!;
      expect(registry.allows('navigate')).toBe(false);

      renderer.destroy();
      await flushMicrotasks();

      expect(confirmation.isConnected).toBe(false);
      expect(registry.allows('navigate')).toBe(true);
      expect(configured.tasks.queries.list()).toHaveLength(1);
      registry.destroy();
      configured.index.destroy();
    });
  });

  // Regression coverage: a commit that fixed CenterPanel/WeekTimeGridView's "today
  // excluded when today is Sunday and week starts Monday" bug copy-pasted the same
  // `.subtract(firstDayOfWeek, 'days')` compensation onto CalendarRenderer.buildConfig,
  // but CalendarRenderer's `selectedDate` (unlike CenterPanel's `calDate`) was *already*
  // collapsed to a week boundary via `.startOf('week')` before that compensation ran —
  // so the same patch that fixed the Sunday case there broke the Mon-Sat case here. This
  // is the exact kind of exhaustive weekday x firstDayOfWeek matrix test that was missing
  // (test/week-time-grid-view.test.ts has one; this file and test/week-view.test.ts did
  // not) and that would have caught the regression before it shipped.
  describe('week view always contains "today", for every weekday and firstDayOfWeek', () => {
    // 2026-07-06..12 is a real Mon..Sun span.
    const weekdays: Array<{ date: string; label: string }> = [
      { date: '2026-07-06', label: 'Monday' },
      { date: '2026-07-07', label: 'Tuesday' },
      { date: '2026-07-08', label: 'Wednesday' },
      { date: '2026-07-09', label: 'Thursday' },
      { date: '2026-07-10', label: 'Friday' },
      { date: '2026-07-11', label: 'Saturday' },
      { date: '2026-07-12', label: 'Sunday' },
    ];

    function cellDates(root: HTMLElement): string[] {
      return Array.from(root.querySelectorAll('.cellName')).map((el) => {
        const href = (el as HTMLAnchorElement).getAttribute('href') as string;
        return href.split('/').pop() as string;
      });
    }

    for (const { date, label } of weekdays) {
      describe(`today is ${label} (${date})`, () => {
        fixedToday(date);

        for (const firstDayOfWeek of [0, 1] as const) {
          it(`fresh mount with defaultView 'week' contains today exactly once, spans 7 consecutive days, starts on firstDayOfWeek=${firstDayOfWeek}`, () => {
            const store = new StubStore();
            const root = freshContainer();
            const r = makeRenderer(
              root,
              store,
              resolvedConfig({ defaultView: 'week', firstDayOfWeek }),
              fakeApp(),
            );
            r.mount();

            const dates = cellDates(root);
            expect(dates).toHaveLength(7);
            expect(dates.filter((d) => d === date)).toHaveLength(1);
            for (let i = 1; i < dates.length; i++) {
              expect(window.moment(dates[i]).diff(window.moment(dates[i - 1]), 'days')).toBe(1);
            }
            expect(parseInt(window.moment(dates[0]).format('d'), 10)).toBe(firstDayOfWeek);

            r.destroy();
          });

          it(`switching to week view then clicking "today" contains today exactly once, spans 7 consecutive days, starts on firstDayOfWeek=${firstDayOfWeek}`, () => {
            const store = new StubStore();
            const root = freshContainer();
            const r = makeRenderer(
              root,
              store,
              resolvedConfig({ defaultView: 'month', firstDayOfWeek }),
              fakeApp(),
            );
            r.mount();
            (root.querySelector('.weekView') as HTMLButtonElement).click();
            // "current" button triggers onToday → goToday()
            (root.querySelector('.current') as HTMLButtonElement).click();

            const dates = cellDates(root);
            expect(dates).toHaveLength(7);
            expect(dates.filter((d) => d === date)).toHaveLength(1);
            for (let i = 1; i < dates.length; i++) {
              expect(window.moment(dates[i]).diff(window.moment(dates[i - 1]), 'days')).toBe(1);
            }
            expect(parseInt(window.moment(dates[0]).format('d'), 10)).toBe(firstDayOfWeek);

            r.destroy();
          });
        }
      });
    }
  });

  describe('destroy', () => {
    it('unsubscribes from store', () => {
      const store = new StubStore();
      const root = freshContainer();
      const r = makeRenderer(root, store, resolvedConfig(), fakeApp());
      r.mount();
      r.destroy();
      // emit after destroy should not throw and should not update DOM
      expect(() => store.emit()).not.toThrow();
    });

    it('empties rootEl', () => {
      const store = new StubStore();
      const root = freshContainer();
      const r = makeRenderer(root, store, resolvedConfig(), fakeApp());
      r.mount();
      r.destroy();
      expect(root.children).toHaveLength(0);
    });
  });
});
