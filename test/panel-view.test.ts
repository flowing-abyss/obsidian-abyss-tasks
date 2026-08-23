import { Notice, TFile, WorkspaceLeaf, type App } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppState, type ListSelection } from '../src/app/AppState';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { CalendarSettings } from '../src/settings/types';
import { TagManager } from '../src/tags/TagManager';
import type {
  TaskApplicationApi,
  TaskCaptureApplicationApi,
  TaskCommandResult,
  TaskIndexEvent,
  TaskQueryApi,
  TaskRef,
} from '../src/tasks';
import type { CreationPresentationController } from '../src/ui/creation/CreationPresentationController';
import type { InteractionRegistry } from '../src/ui/interactionOwnership';
import { taskNodeLine } from '../src/ui/taskSelection';
import { MonthGridView } from '../src/views/MonthGridView';
import { PANEL_VIEW_TYPE, PanelView } from '../src/views/PanelView';
import type { PanelNavigator } from '../src/views/panelNavigation';
import {
  configuredTaskApplication,
  createAppWithFiles,
  flushMicrotasks,
  seedTaskCache,
  task,
  useRealMoment,
} from './helpers';

function makeTagManager(app: App, settings: CalendarSettings = DEFAULT_SETTINGS): TagManager {
  const save = vi.fn().mockResolvedValue(undefined);
  return new TagManager(app, settings, save);
}

useRealMoment();

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return new DOMRect(left, top, width, height);
}

function rectList(rectangles: readonly DOMRect[]): DOMRectList {
  const values = [...rectangles];
  return Object.assign(values, {
    item: (index: number) => values[index] ?? null,
  }) as unknown as DOMRectList;
}

function setGeometry(
  element: Element,
  bounds: DOMRect,
  clientRects: readonly DOMRect[] = [bounds],
): void {
  const list = rectList(clientRects);
  Object.defineProperties(element, {
    getBoundingClientRect: { configurable: true, value: () => bounds },
    getClientRects: { configurable: true, value: () => list },
  });
}

function emitQueryEvent(queries: TaskQueryApi, event: TaskIndexEvent): void {
  const source = queries as unknown as {
    listeners: Array<(published: TaskIndexEvent) => void>;
  };
  for (const listener of [...source.listeners]) listener(event);
}

type TaskApplication = ReturnType<typeof configuredTaskApplication>;

describe('PanelView', () => {
  describe('empty vault suite', () => {
    let app: Awaited<ReturnType<typeof createAppWithFiles>>;
    let taskApplication: TaskApplication;
    let leaf: WorkspaceLeaf;
    let view: PanelView;
    let tagManager: TagManager;
    let settings: CalendarSettings;

    beforeEach(async () => {
      app = await createAppWithFiles({});
      settings = structuredClone(DEFAULT_SETTINGS);
      taskApplication = configuredTaskApplication(app, settings);
      await taskApplication.index.initialize();
      await flushMicrotasks();
      leaf = new (WorkspaceLeaf as unknown as { new (app: App): WorkspaceLeaf })(app);
      tagManager = makeTagManager(app, settings);
      view = new PanelView(
        leaf,
        settings,
        tagManager,
        taskApplication.index,
        taskApplication.tasks as TaskApplicationApi & TaskCaptureApplicationApi,
        taskApplication.statusRegistry,
      );
      vi.spyOn(app.workspace, 'getActiveViewOfType').mockImplementation((type) =>
        type === PanelView && app.workspace.activeLeaf === leaf ? (view as never) : null,
      );
      await view.onOpen();
      setGeometry(view.containerEl, rect(20, 20, 640, 480));
      setGeometry(view.contentEl, rect(20, 20, 640, 480));
    });

    afterEach(async () => {
      await view.onClose();
      view.containerEl.remove();
      app.workspace.activeLeaf = null;
      taskApplication.index.destroy();
    });

    it('adds abyss-panel-view class to contentEl', () => {
      expect(view.contentEl.classList.contains('abyss-panel-view')).toBe(true);
    });

    it('creates abyss-layout with 4 zones', () => {
      const layout = view.contentEl.querySelector('.abyss-layout');
      expect(layout).not.toBeNull();
      expect(layout?.querySelector('.abyss-rail')).not.toBeNull();
      expect(layout?.querySelector('.abyss-left')).not.toBeNull();
      expect(layout?.querySelector('.abyss-center')).not.toBeNull();
      expect(layout?.querySelector('.abyss-right')).not.toBeNull();
    });

    it('owns one stable out-of-flow creation feedback host inside the layout', () => {
      const layout = view.contentEl.querySelector('.abyss-layout');
      const feedback = layout?.querySelector('.abyss-creation-feedback');

      expect(feedback).not.toBeNull();
      expect(feedback?.getAttribute('role')).toBe('status');
      expect(feedback?.getAttribute('aria-live')).toBe('polite');
      expect(feedback?.getAttribute('aria-atomic')).toBe('true');
      expect(layout?.querySelectorAll('.abyss-creation-feedback')).toHaveLength(1);
    });

    it('owns one stable Quick Capture host outside every renderable panel zone', () => {
      const layout = view.contentEl.querySelector('.abyss-layout')!;
      const host = layout.querySelector('.abyss-quick-capture-host');

      expect(host).not.toBeNull();
      expect(layout.querySelectorAll('.abyss-quick-capture-host')).toHaveLength(1);
      expect(host?.closest('.abyss-rail, .abyss-left, .abyss-center, .abyss-right')).toBeNull();

      const internals = view as unknown as { panelNavigation: PanelNavigator };
      internals.panelNavigation.openCalendar();
      internals.panelNavigation.openSearch();
      internals.panelNavigation.openProjects();
      internals.panelNavigation.openTasks();

      expect(layout.querySelector('.abyss-quick-capture-host')).toBe(host);
    });

    it('routes shortcuts only for its connected visible active leaf and detaches on close', async () => {
      const internals = view as unknown as { panelNavigation: PanelNavigator };
      const openQuickCapture = vi
        .spyOn(internals.panelNavigation, 'openQuickCapture')
        .mockImplementation(() => undefined);
      app.workspace.activeLeaf = leaf;

      document.body.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'q',
          code: 'KeyQ',
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(openQuickCapture).not.toHaveBeenCalled();

      document.body.appendChild(view.containerEl);
      app.workspace.activeLeaf = null;
      view.contentEl.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'q',
          code: 'KeyQ',
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(openQuickCapture).not.toHaveBeenCalled();

      app.workspace.activeLeaf = leaf;
      view.containerEl.style.display = 'none';
      view.contentEl.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'q',
          code: 'KeyQ',
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(openQuickCapture).not.toHaveBeenCalled();

      view.containerEl.style.display = '';
      view.contentEl.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'й',
          code: 'KeyQ',
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(openQuickCapture).toHaveBeenCalledOnce();

      await view.onClose();
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'q',
          code: 'KeyQ',
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(openQuickCapture).toHaveBeenCalledOnce();
    });

    it.each([
      ['zero-area bounds', (element: HTMLElement) => setGeometry(element, rect(20, 20, 0, 480))],
      [
        'no rendered client rectangles',
        (element: HTMLElement) => setGeometry(element, rect(20, 20, 640, 480), []),
      ],
      [
        'offscreen bounds',
        (element: HTMLElement) => setGeometry(element, rect(window.innerWidth + 20, 20, 640, 480)),
      ],
    ] as const)(
      'does not route shortcuts from an active connected pane with %s',
      (_reason, hide) => {
        document.body.appendChild(view.containerEl);
        app.workspace.activeLeaf = leaf;
        hide(view.contentEl);
        const event = new KeyboardEvent('keydown', {
          key: 'q',
          code: 'KeyQ',
          bubbles: true,
          cancelable: true,
        });

        view.contentEl.dispatchEvent(event);

        expect(event.defaultPrevented).toBe(false);
        expect(view.contentEl.querySelector('.abyss-quick-capture-host')?.children).toHaveLength(0);
      },
    );

    it('applies shortcut settings edits immediately without recreating the PanelView', () => {
      document.body.appendChild(view.containerEl);
      app.workspace.activeLeaf = leaf;
      const internals = view as unknown as { panelNavigation: PanelNavigator };
      const openSearch = vi.spyOn(internals.panelNavigation, 'openSearch');

      view.contentEl.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 's',
          code: 'KeyS',
          bubbles: true,
          cancelable: true,
        }),
      );
      settings.shortcuts.openSearch = 'E';
      const stale = new KeyboardEvent('keydown', {
        key: 's',
        code: 'KeyS',
        bubbles: true,
        cancelable: true,
      });
      view.contentEl.dispatchEvent(stale);
      const current = new KeyboardEvent('keydown', {
        key: 'e',
        code: 'KeyE',
        bubbles: true,
        cancelable: true,
      });
      view.contentEl.dispatchEvent(current);

      expect(openSearch).toHaveBeenCalledTimes(2);
      expect(stale.defaultPrevented).toBe(false);
      expect(current.defaultPrevented).toBe(true);
    });

    it('opens and owns Quick Capture without changing mode, then refocuses only from panel chrome', async () => {
      document.body.appendChild(view.containerEl);
      app.workspace.activeLeaf = leaf;
      const application = taskApplication.tasks as TaskApplicationApi & TaskCaptureApplicationApi;
      const execute = vi.fn().mockResolvedValue({
        type: 'ok',
        changed: true,
        outcome: {
          type: 'task',
          task: task({ source: { filePath: 'capture.md', line: 0 } }),
        },
      } satisfies TaskCommandResult);
      vi.spyOn(application, 'planCreate').mockResolvedValue({
        type: 'ready',
        destination: { filePath: 'capture.md', insertion: { type: 'append' } },
        execute,
      });
      const internals = view as unknown as { state: AppState; panelNavigation: PanelNavigator };
      internals.panelNavigation.openSearch();
      await flushMicrotasks(0);
      const chrome = view.contentEl.querySelector<HTMLElement>('.abyss-rail')!;
      chrome.tabIndex = 0;
      chrome.focus();

      const openEvent = new KeyboardEvent('keydown', {
        key: 'q',
        code: 'KeyQ',
        bubbles: true,
        cancelable: true,
      });
      chrome.dispatchEvent(openEvent);
      await flushMicrotasks(0);
      const input = view.contentEl.querySelector<HTMLInputElement>(
        '.abyss-quick-capture-host .abyss-quick-capture-input',
      )!;

      expect(openEvent.defaultPrevented).toBe(true);
      expect(internals.state.get('mode')).toBe('search');
      expect(document.activeElement).toBe(input);
      const navigation = new KeyboardEvent('keydown', {
        key: 'c',
        code: 'KeyC',
        bubbles: true,
        cancelable: true,
      });
      chrome.dispatchEvent(navigation);
      expect(navigation.defaultPrevented).toBe(false);
      expect(internals.state.get('mode')).toBe('search');

      chrome.focus();
      chrome.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'q',
          code: 'KeyQ',
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(document.activeElement).toBe(input);

      const typedQ = new KeyboardEvent('keydown', {
        key: 'q',
        code: 'KeyQ',
        bubbles: true,
        cancelable: true,
      });
      input.dispatchEvent(typedQ);
      input.value = 'q';
      input.dispatchEvent(new Event('input', { bubbles: true }));

      expect(typedQ.defaultPrevented).toBe(false);
      expect(input.value).toBe('q');
      expect(view.contentEl.querySelectorAll('.abyss-capture-surface')).toHaveLength(1);
    });

    it('reports complete list, project, search, calendar mount, and calendar patch boundaries', () => {
      const internals = view as unknown as {
        state: AppState;
        center: { refresh(): void };
        creationPresentation: CreationPresentationController;
      };
      const afterRender = vi.spyOn(internals.creationPresentation, 'afterRender');

      internals.center.refresh();
      expect(afterRender).toHaveBeenCalledWith(
        view.contentEl.querySelector<HTMLElement>('.abyss-center'),
      );

      afterRender.mockClear();
      internals.state.set('mode', 'projects');
      expect(afterRender).toHaveBeenCalled();

      afterRender.mockClear();
      internals.state.set('mode', 'search');
      expect(afterRender).toHaveBeenCalled();

      afterRender.mockClear();
      internals.state.set('mode', 'calendar');
      expect(afterRender).toHaveBeenCalledWith(
        view.contentEl.querySelector<HTMLElement>('.abyss-cal-body'),
      );

      afterRender.mockClear();
      emitQueryEvent(taskApplication.index, { type: 'changed', files: ['x.md'] });
      expect(afterRender).toHaveBeenCalledWith(
        view.contentEl.querySelector<HTMLElement>('.abyss-cal-body'),
      );
    });

    it('routes Center creation results to the stable host without a Notice', async () => {
      const created = task({ source: { filePath: 'capture.md', line: 0 } });
      const result: TaskCommandResult = {
        type: 'ok',
        changed: true,
        outcome: { type: 'task', task: created },
      };
      const sessionExecute = vi.fn(async () => result);
      const captureApplication = taskApplication.tasks as TaskApplicationApi &
        TaskCaptureApplicationApi;
      const planCreate = vi.spyOn(captureApplication, 'planCreate').mockResolvedValue({
        type: 'ready',
        destination: { filePath: 'capture.md', insertion: { type: 'append' } },
        execute: sessionExecute,
      });
      const notice = vi.spyOn(
        Notice.prototype as unknown as {
          constructor__(message: string | DocumentFragment, duration?: number): void;
        },
        'constructor__',
      );
      view.contentEl.querySelector<HTMLElement>('.abyss-add-task-trigger')?.click();
      await flushMicrotasks();
      const input = view.contentEl.querySelector<HTMLInputElement>('.abyss-quick-capture-input')!;
      input.value = 'captured task';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
      await flushMicrotasks();

      expect(planCreate).toHaveBeenCalledOnce();
      expect(sessionExecute).toHaveBeenCalledOnce();
      expect(view.contentEl.querySelector('.abyss-creation-feedback')?.textContent).toBe(
        'Task added to capture.md',
      );
      expect(notice).not.toHaveBeenCalled();
    });

    it('destroys creation presentation ownership on close', async () => {
      const controller = (
        view as unknown as { creationPresentation: CreationPresentationController }
      ).creationPresentation;
      const destroy = vi.spyOn(controller, 'destroy');

      await view.onClose();

      expect(destroy).toHaveBeenCalledOnce();
    });

    it('supplies one live interaction registry to both panels and destroys it after panel teardown', async () => {
      const internals = view as unknown as {
        interactionRegistry: InteractionRegistry<string>;
        center: { interactionOwnership: unknown };
        right: { interactionOwnership: unknown };
      };
      const registry = internals.interactionRegistry;

      expect(registry).toBeDefined();
      expect(internals.center.interactionOwnership).toBe(registry);
      expect(internals.right.interactionOwnership).toBe(registry);
      registry.acquire({ blocksShortcuts: true });
      expect(registry.allows('navigate')).toBe(false);

      await view.onClose();

      expect(registry.allows('navigate')).toBe(true);
      registry.acquire({ blocksShortcuts: true });
      expect(registry.allows('navigate')).toBe(true);
    });

    it('keeps planCreate on the PanelView application wrapper', async () => {
      const application = taskApplication.tasks as TaskApplicationApi & TaskCaptureApplicationApi;
      const planCreate = vi.spyOn(application, 'planCreate');
      const center = (
        view as unknown as {
          center: {
            captureApplication: (TaskApplicationApi & TaskCaptureApplicationApi) | null;
          };
        }
      ).center;

      expect(center.captureApplication).not.toBeNull();
      await center.captureApplication?.planCreate({
        type: 'explicit',
        destination: { filePath: 'planned.md', insertion: { type: 'append' } },
      });

      expect(planCreate).toHaveBeenCalledWith({
        type: 'explicit',
        destination: { filePath: 'planned.md', insertion: { type: 'append' } },
      });
    });

    it('abyss-rail has 4 rail buttons (tasks/projects/calendar/search) + 1 settings button', () => {
      const railBtns = view.contentEl.querySelectorAll('.abyss-rail .abyss-rail-btn');
      expect(railBtns).toHaveLength(5);
    });

    it('abyss-left shows Inbox / Today / Upcoming smart lists', () => {
      const labels = Array.from(
        view.contentEl.querySelectorAll('.abyss-left .abyss-left-label'),
      ).map((l) => l.textContent);
      expect(labels).toContain('Inbox');
      expect(labels).toContain('Today');
      expect(labels).toContain('Upcoming');
    });

    it('shares semantic navigation across Rail, Left, and tag identity bridges', async () => {
      const internals = view as unknown as { state: AppState; panelNavigation: PanelNavigator };
      const openCalendar = vi.spyOn(internals.panelNavigation, 'openCalendar');
      const openList = vi.spyOn(internals.panelNavigation, 'openList');
      const rebaseListIdentity = vi.spyOn(internals.panelNavigation, 'rebaseListIdentity');

      view.contentEl
        .querySelector<HTMLButtonElement>('.abyss-rail [aria-label="Calendar"]')!
        .click();
      view.contentEl.querySelector<HTMLElement>('.abyss-left-item')!.click();

      expect(openCalendar).toHaveBeenCalledOnce();
      expect(openList).toHaveBeenCalledWith('inbox');

      internals.state.set('selectedList', { type: 'tag', tag: '#work' });
      await tagManager.renameTagExact('#work', '#focus');

      expect(rebaseListIdentity).toHaveBeenCalledWith({ type: 'tag', tag: '#focus' });
    });

    it('mode change to calendar updates layout class', () => {
      const state = (view as unknown as { state: AppState }).state;
      const layout = view.contentEl.querySelector('.abyss-layout') as HTMLElement;
      const before = layout.className;
      state.set('mode', 'calendar');
      expect(layout.className).not.toBe(before);
      expect(layout.className).toContain('abyss-layout--calendar');
    });

    it.each([
      {
        scope: 'exact',
        selected: '#work',
        expected: '#focus',
      },
      {
        scope: 'prefix',
        selected: '#work/deep/child',
        expected: '#focus/deep/child',
      },
    ] as const)(
      'rebases the active $scope tag list after a vault identity rename',
      async ({ scope, selected, expected }) => {
        const state = (view as unknown as { state: AppState }).state;
        state.set('selectedList', { type: 'tag', tag: selected });

        if (scope === 'exact') {
          await tagManager.renameTagExact('#work', '#focus');
        } else {
          await tagManager.renameTagPrefix('#work', '#focus');
        }

        expect(state.get('selectedList')).toEqual({ type: 'tag', tag: expected });
      },
    );

    it.each([
      ['calendar', 'tag rename'],
      ['search', 'tag rename'],
      ['projects', 'tag rename'],
      ['calendar', 'project rename'],
      ['search', 'project rename'],
      ['projects', 'project rename'],
      ['calendar', 'project delete'],
      ['search', 'project delete'],
      ['projects', 'project delete'],
    ] as const)(
      'keeps %s active during background %s identity maintenance',
      async (mode, event) => {
        const internals = view as unknown as {
          state: AppState;
          panelNavigation: PanelNavigator;
        };
        const rebase = vi.spyOn(internals.panelNavigation, 'rebaseListIdentity');
        let expected: ListSelection;

        if (event === 'tag rename') {
          internals.panelNavigation.openList({ type: 'tag', tag: '#work' });
          if (mode === 'calendar') internals.panelNavigation.openCalendar();
          else if (mode === 'search') internals.panelNavigation.openSearch();
          else internals.panelNavigation.openProjects();
          rebase.mockClear();
          await tagManager.renameTagExact('#work', '#focus');
          expected = { type: 'tag', tag: '#focus' };
        } else {
          const file = await app.vault.create('Project.md', '');
          internals.panelNavigation.openList({ type: 'project', path: file.path });
          if (mode === 'calendar') internals.panelNavigation.openCalendar();
          else if (mode === 'search') internals.panelNavigation.openSearch();
          else internals.panelNavigation.openProjects();
          rebase.mockClear();
          if (event === 'project rename') {
            await app.vault.rename(file, 'Renamed.md');
            expected = { type: 'project', path: 'Renamed.md' };
          } else {
            await app.vault.delete(file);
            expected = 'today';
          }
        }

        expect(rebase).toHaveBeenCalledWith(expected);
        expect(internals.state.get('mode')).toBe(mode);
        expect(internals.state.get('selectedList')).toEqual(expected);
      },
    );

    it('does not change an active group selection during a prefix rename', async () => {
      const state = (view as unknown as { state: AppState }).state;
      const selection = { type: 'group', groupId: 'work-group' } as const;
      state.set('selectedList', selection);

      await tagManager.renameTagPrefix('#work', '#focus');

      expect(state.get('selectedList')).toBe(selection);
    });

    it('detaches the selected-list rename boundary when the panel closes', async () => {
      const state = (view as unknown as { state: AppState }).state;
      await view.onClose();
      state.set('selectedList', { type: 'tag', tag: '#work/deep' });

      await tagManager.renameTagPrefix('#work', '#focus');

      expect(state.get('selectedList')).toEqual({ type: 'tag', tag: '#work/deep' });
    });

    it('query update with empty taskStack → no error', () => {
      const state = (view as unknown as { state: AppState }).state;
      state.set('taskStack', []);
      expect(() =>
        emitQueryEvent(taskApplication.index, { type: 'changed', files: ['x.md'] }),
      ).not.toThrow();
    });

    it('recomputes rendered tag contrast when Obsidian emits css-change', () => {
      const panels = view as unknown as { center: { refresh(): void } };
      const refresh = vi.spyOn(panels.center, 'refresh');
      app.workspace.trigger('css-change');
      expect(refresh).toHaveBeenCalledOnce();
    });

    it('lets CenterPanel own the sole calendar patch while PanelView refreshes only LeftPanel', () => {
      const state = (view as unknown as { state: AppState }).state;
      const panels = view as unknown as {
        left: { refresh(): void };
        center: { refresh(): void };
      };
      state.set('mode', 'calendar');
      const leftRefresh = vi.spyOn(panels.left, 'refresh');
      const centerRefresh = vi.spyOn(panels.center, 'refresh');
      const calendarPatch = vi.spyOn(MonthGridView.prototype, 'patch');

      emitQueryEvent(taskApplication.index, { type: 'changed', files: ['x.md'] });

      expect(leftRefresh).toHaveBeenCalledOnce();
      expect(centerRefresh).not.toHaveBeenCalled();
      expect(calendarPatch).toHaveBeenCalledOnce();
    });

    it.each(['tasks', 'search', 'projects'] as const)(
      'keeps PanelView center.refresh ownership in %s mode',
      (mode) => {
        const state = (view as unknown as { state: AppState }).state;
        const panels = view as unknown as {
          left: { refresh(): void };
          center: { refresh(): void };
        };
        state.set('mode', mode);
        const leftRefresh = vi.spyOn(panels.left, 'refresh');
        const centerRefresh = vi.spyOn(panels.center, 'refresh');

        emitQueryEvent(taskApplication.index, { type: 'changed', files: ['x.md'] });

        expect(leftRefresh).toHaveBeenCalledOnce();
        expect(centerRefresh).toHaveBeenCalledOnce();
      },
    );

    it('onClose empties contentEl', async () => {
      await view.onClose();
      expect(view.contentEl.children).toHaveLength(0);
    });

    it('onClose unsubs mode listener (different mode value does not mutate layout)', async () => {
      const state = (view as unknown as { state: AppState }).state;
      const layout = view.contentEl.querySelector('.abyss-layout') as HTMLElement;
      const before = layout.className;
      await view.onClose();
      state.set('mode', 'search'); // different value
      expect(layout.className).toBe(before); // listener removed → no change
    });

    it('getViewType returns task-calendar-panel', () => {
      expect(view.getViewType()).toBe(PANEL_VIEW_TYPE);
    });

    it('getDisplayText returns "Abyss Tasks"', () => {
      expect(view.getDisplayText()).toBe('Abyss Tasks');
    });

    it('getIcon returns calendar-days', () => {
      expect(view.getIcon()).toBe('calendar-days');
    });
  });

  describe('populated vault suite', () => {
    let app: Awaited<ReturnType<typeof createAppWithFiles>>;
    let taskApplication: TaskApplication;
    let leaf: WorkspaceLeaf;
    let view: PanelView;

    beforeEach(async () => {
      app = await createAppWithFiles({
        'today.md': `- [ ] task one 📅 ${window.moment().format('YYYY-MM-DD')}`,
      });
      seedTaskCache(app, 'today.md', [{ task: ' ', parent: -1, line: 0 }]);
      taskApplication = configuredTaskApplication(app, DEFAULT_SETTINGS, { authority: true });
      await taskApplication.index.initialize();
      await flushMicrotasks();
      leaf = new (WorkspaceLeaf as unknown as { new (app: App): WorkspaceLeaf })(app);
      view = new PanelView(
        leaf,
        DEFAULT_SETTINGS,
        makeTagManager(app),
        taskApplication.index,
        taskApplication.tasks as TaskApplicationApi & TaskCaptureApplicationApi,
        taskApplication.statusRegistry,
      );
      await view.onOpen();
    });

    afterEach(async () => {
      await view.onClose();
      taskApplication.index.destroy();
    });

    it('query update matching root task path → taskStack replaced with fresh task', () => {
      const state = (view as unknown as { state: AppState }).state;
      const tasks = taskApplication.index.list();
      const root = tasks[0]!;
      state.set('taskStack', [root]);
      emitQueryEvent(taskApplication.index, {
        type: 'changed',
        files: [root.source.filePath],
      });
      const stack = state.get('taskStack');
      expect(stack).toHaveLength(1);
      expect(stack[0] && 'source' in stack[0] ? stack[0].source.filePath : undefined).toBe(
        root.source.filePath,
      );
    });

    it('query update with non-matching changedFile → taskStack unchanged', () => {
      const state = (view as unknown as { state: AppState }).state;
      const root = taskApplication.index.list()[0]!;
      state.set('taskStack', [root]);
      const before = state.get('taskStack');
      emitQueryEvent(taskApplication.index, { type: 'changed', files: ['other.md'] });
      expect(state.get('taskStack')).toBe(before);
    });

    it('query update when root task deleted → taskStack reset to []', async () => {
      const state = (view as unknown as { state: AppState }).state;
      const root = taskApplication.index.list()[0]!;
      state.set('taskStack', [root]);
      const file = app.vault.getAbstractFileByPath(root.source.filePath);
      if (!file) throw new Error('root task file missing');
      await app.vault.delete(file);
      await flushMicrotasks();
      expect(state.get('taskStack')).toHaveLength(0);
    });

    it('keeps the selected task and dirty draft on the fresh ref across a vault rename', async () => {
      const state = (view as unknown as { state: AppState }).state;
      const root = taskApplication.index.list()[0]!;
      state.set('taskStack', [root]);
      const comment = view.contentEl.querySelector<HTMLTextAreaElement>('.abyss-comment-input')!;
      comment.value = 'rename-safe panel draft';
      comment.focus();
      const file = app.vault.getAbstractFileByPath(root.source.filePath);
      if (!file) throw new Error('root task file missing');

      await app.vault.rename(file, 'renamed.md');
      await flushMicrotasks();
      await new Promise((resolve) => window.setTimeout(resolve, 0));

      expect(state.get('taskStack')[0]).toMatchObject({
        ref: { filePath: 'renamed.md' },
        source: { filePath: 'renamed.md' },
      });
      const restored = view.contentEl.querySelector<HTMLTextAreaElement>('.abyss-comment-input')!;
      expect(restored.value).toBe('rename-safe panel draft');
      expect(view.contentEl.querySelector('.abyss-detached-draft')).toBeNull();
    });

    it('consumes an actual submitted comment across the service/index early event', async () => {
      const state = (view as unknown as { state: AppState }).state;
      const root = taskApplication.index.list()[0]!;
      state.set('taskStack', [root]);
      const observedResolutions: unknown[] = [];
      const off = taskApplication.index.subscribe((event) => {
        if (event.type === 'changed') {
          observedResolutions.push(taskApplication.index.resolve(root.ref));
        }
      });
      const input = view.contentEl.querySelector<HTMLTextAreaElement>('.abyss-comment-input')!;
      input.value = 'actual interleaving comment';

      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
      await flushMicrotasks();
      await flushMicrotasks();

      const file = app.vault.getAbstractFileByPath(root.source.filePath);
      if (!(file instanceof TFile)) throw new Error('root task file missing');
      const content = await app.vault.cachedRead(file);
      expect(content.match(/actual interleaving comment/gu)).toHaveLength(1);
      expect(taskApplication.index.list()[0]?.comments).toHaveLength(1);
      expect(observedResolutions).toHaveLength(1);
      expect(observedResolutions[0]).toMatchObject({
        type: 'rebased',
        evidence: 'authority-transition',
      });
      expect(view.contentEl.querySelector<HTMLTextAreaElement>('.abyss-comment-input')?.value).toBe(
        '',
      );
      expect(view.contentEl.querySelector('.abyss-detached-draft')).toBeNull();
      expect(view.contentEl.querySelector('.abyss-task-selection-message')).toBeNull();
      off();
    });

    it('restores one escrow after an observed repository candidate rolls back on process failure', async () => {
      const state = (view as unknown as { state: AppState }).state;
      const root = taskApplication.index.list()[0]!;
      state.set('taskStack', [root]);
      const original = await app.vault.read(app.vault.getMarkdownFiles()[0]!);
      vi.spyOn(app.vault, 'process').mockImplementation(async (file, transform) => {
        const candidate = transform(original);
        const cache = app.metadataCache.getFileCache(file);
        if (!cache) throw new Error('task cache missing');
        app.metadataCache.trigger('changed', file, candidate, cache);
        await flushMicrotasks();
        throw new Error('simulated process rollback');
      });
      const input = view.contentEl.querySelector<HTMLTextAreaElement>('.abyss-comment-input')!;
      input.value = 'rollback actual comment';

      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
      await flushMicrotasks();
      await flushMicrotasks();

      const file = app.vault.getMarkdownFiles()[0]!;
      expect(await app.vault.read(file)).toBe(original);
      expect(taskApplication.index.list()[0]?.comments).toHaveLength(0);
      const live =
        view.contentEl.querySelector<HTMLTextAreaElement>('.abyss-comment-input')?.value ?? '';
      const detached = view.contentEl.querySelector('.abyss-detached-draft')?.textContent ?? '';
      expect(`${live}${detached}`.match(/rollback actual comment/gu)).toHaveLength(1);
      expect(view.contentEl.querySelector('.abyss-task-selection-message')).toBeNull();
    });

    it('clears owned-write acknowledgement when deletion/switch changes the selected root', () => {
      const state = (view as unknown as { state: AppState }).state;
      const root = taskApplication.index.list()[0]!;
      state.set('taskStack', [root]);
      (view as unknown as { acknowledgeOwnWrite(task: typeof root): void }).acknowledgeOwnWrite(
        root,
      );
      state.set('taskStack', []);
      const otherRoot = {
        ...root,
        ref: { filePath: 'other.md', line: 0, revision: 'other-old' },
        source: { ...root.source, filePath: 'other.md', line: 0 },
      };
      state.set('taskStack', [otherRoot]);
      (
        view as unknown as {
          applyResolution(result: { type: 'uncertain'; ref: TaskRef }): void;
        }
      ).applyResolution({ type: 'uncertain', ref: otherRoot.ref });
      expect(state.get('taskStack')).toEqual([]);
      expect(view.contentEl.querySelector('.abyss-task-selection-message')).toBeNull();
    });

    it('rejects a late write acknowledgement after selection switched away from its root', () => {
      const state = (view as unknown as { state: AppState }).state;
      const first = taskApplication.index.list()[0]!;
      const firstView = first;
      const secondView = {
        ...firstView,
        ref: { filePath: 'other.md', line: 0, revision: 'second' },
        source: { ...first.source, filePath: 'other.md', line: 0 },
      };
      state.set('taskStack', [firstView]);
      state.set('taskStack', [secondView]);
      (view as unknown as { acknowledgeOwnWrite(ref: typeof first.ref): void }).acknowledgeOwnWrite(
        first.ref,
      );
      state.set('taskStack', [firstView]);
      (
        view as unknown as {
          applyResolution(result: { type: 'uncertain'; ref: TaskRef }): void;
        }
      ).applyResolution({ type: 'uncertain', ref: first.ref });
      expect(state.get('taskStack')).toEqual([]);
      expect(view.contentEl.querySelector('.abyss-task-selection-message')).toBeNull();
    });

    it('converges a selected Center or Left command immediately and accepts the next index event', () => {
      const state = (view as unknown as { state: AppState }).state;
      const observed = taskApplication.index.list()[0]!;
      const updated = {
        ...observed,
        ref: { ...observed.ref, revision: 'owned-update' },
        title: 'Owned update',
        markdownTitle: 'Owned update',
      };
      const result: TaskCommandResult = {
        type: 'ok',
        outcome: { type: 'task', task: updated },
        changed: true,
      };
      state.set('taskStack', [observed]);

      (
        view as unknown as {
          convergeOwnCommand(initiatingRef: TaskRef, result: TaskCommandResult): void;
        }
      ).convergeOwnCommand(observed.ref, result);

      expect(state.get('taskStack')[0]).toMatchObject({ title: 'Owned update', ref: updated.ref });
      (
        view as unknown as {
          applyResolution(resolution: { type: 'exact'; task: typeof updated }): void;
        }
      ).applyResolution({ type: 'exact', task: updated });
      expect(view.contentEl.querySelector('.abyss-task-selection-stale')).toBeNull();
    });

    it('preserves the full RightPanel DOM draft bundle while a no-op Center command converges', async () => {
      const state = (view as unknown as { state: AppState }).state;
      const observed = taskApplication.index.list()[0]!;
      state.set('taskStack', [observed]);
      activeDocument.body.append(view.contentEl);
      view.contentEl.querySelector<HTMLElement>('.abyss-right-title-view')!.click();
      await flushMicrotasks();
      const title = view.contentEl.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit')!;
      title.value = 'unsaved title';
      title.focus();
      title.setSelectionRange(1, 6);
      const comment = view.contentEl.querySelector<HTMLTextAreaElement>('.abyss-comment-input')!;
      comment.value = 'unsaved comment';
      comment.setSelectionRange(2, 9);
      const execute = vi.spyOn(taskApplication.tasks, 'execute');

      (
        view as unknown as {
          convergeOwnCommand(initiatingRef: TaskRef, result: TaskCommandResult): void;
        }
      ).convergeOwnCommand(observed.ref, {
        type: 'ok',
        outcome: { type: 'task', task: observed },
        changed: false,
      });
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));

      const restoredTitle =
        view.contentEl.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit')!;
      const restoredComment =
        view.contentEl.querySelector<HTMLTextAreaElement>('.abyss-comment-input')!;
      expect(restoredTitle.value).toBe('unsaved title');
      expect(restoredTitle.selectionStart).toBe(1);
      expect(restoredTitle.selectionEnd).toBe(6);
      expect(restoredComment.value).toBe('unsaved comment');
      expect(restoredComment.selectionStart).toBe(2);
      expect(restoredComment.selectionEnd).toBe(9);
      expect(activeDocument.activeElement).toBe(restoredTitle);
      expect(execute).not.toHaveBeenCalled();
    });

    it('keeps uncertainty silent when the matching command result wins the race', () => {
      const state = (view as unknown as { state: AppState }).state;
      const observed = taskApplication.index.list()[0]!;
      const updated = {
        ...observed,
        ref: { ...observed.ref, revision: 'owned-after-conflict' },
        title: 'Owned after conflict',
      };
      state.set('taskStack', [observed]);
      (
        view as unknown as {
          applyResolution(resolution: { type: 'uncertain'; ref: TaskRef }): void;
        }
      ).applyResolution({ type: 'uncertain', ref: observed.ref });
      expect(view.contentEl.querySelector('.abyss-task-selection-message')).toBeNull();

      (
        view as unknown as {
          convergeOwnCommand(initiatingRef: TaskRef, result: TaskCommandResult): void;
        }
      ).convergeOwnCommand(observed.ref, {
        type: 'ok',
        outcome: { type: 'task', task: updated },
        changed: true,
      });

      expect(state.get('taskStack')).toEqual([]);
      expect(view.contentEl.querySelector('.abyss-task-selection-stale')).toBeNull();
    });

    it('renders a fresh visual candidate and detaches the stale draft without a message', () => {
      const state = (view as unknown as { state: AppState }).state;
      const observed = taskApplication.index.list()[0]!;
      const current = {
        ...observed,
        ref: { ...observed.ref, revision: 'visual-current' },
        title: 'Visual current',
        markdownTitle: 'Visual current',
      };
      state.set('taskStack', [observed]);
      const comment = view.contentEl.querySelector<HTMLTextAreaElement>('.abyss-comment-input')!;
      comment.value = 'stale local draft';

      (
        view as unknown as {
          applyResolution(resolution: {
            type: 'visual';
            stale: TaskRef;
            current: typeof current;
            evidence: 'same-line';
          }): void;
        }
      ).applyResolution({
        type: 'visual',
        stale: observed.ref,
        current,
        evidence: 'same-line',
      });

      expect(state.get('taskStack')[0]).toMatchObject({
        title: 'Visual current',
        ref: current.ref,
      });
      expect(view.contentEl.querySelector('.abyss-detached-draft')?.textContent).toContain(
        'stale local draft',
      );
      expect(view.contentEl.querySelector('.abyss-task-selection-message')).toBeNull();
    });

    it('does not let a late Center or Left result replace a different selection', () => {
      const state = (view as unknown as { state: AppState }).state;
      const first = taskApplication.index.list()[0]!;
      const second = {
        ...first,
        ref: { filePath: 'other.md', line: 0, revision: 'second' },
        source: { ...first.source, filePath: 'other.md', line: 0 },
      };
      const updated = {
        ...first,
        ref: { ...first.ref, revision: 'late-update' },
        title: 'Late update',
      };
      state.set('taskStack', [first]);
      state.set('taskStack', [second]);

      (
        view as unknown as {
          convergeOwnCommand(initiatingRef: TaskRef, result: TaskCommandResult): void;
        }
      ).convergeOwnCommand(first.ref, {
        type: 'ok',
        outcome: { type: 'task', task: updated },
        changed: true,
      });

      expect(state.get('taskStack')[0]).toBe(second);
    });

    it('refresh updates left panel count badges after index change (DOM assertion)', async () => {
      // Initial: one open task due today → Today count badge = "1"
      const left = view.contentEl.querySelector('.abyss-left') as HTMLElement;
      const todayItem = Array.from(left.querySelectorAll('.abyss-left-item')).find(
        (el) => el.querySelector('.abyss-left-label')?.textContent === 'Today',
      ) as HTMLElement | undefined;
      expect(todayItem?.querySelector('.abyss-left-count')?.textContent).toBe('1');
      // Toggle the task done via file mutation (simulates an external vault edit).
      const file = app.vault.getMarkdownFiles()[0]!;
      await app.vault.process(file, (data) => data.replace('- [ ]', '- [x]'));
      await flushMicrotasks();
      // After refresh: no open tasks due today → Today count badge absent (count 0 → not rendered)
      const todayItemAfter = Array.from(left.querySelectorAll('.abyss-left-item')).find(
        (el) => el.querySelector('.abyss-left-label')?.textContent === 'Today',
      ) as HTMLElement | undefined;
      expect(todayItemAfter?.querySelector('.abyss-left-count')?.textContent ?? '0').toBe('0');
    });
  });

  describe('deep-stack rebuild suite', () => {
    let app: Awaited<ReturnType<typeof createAppWithFiles>>;
    let taskApplication: TaskApplication;
    let leaf: WorkspaceLeaf;
    let view: PanelView;

    beforeEach(async () => {
      app = await createAppWithFiles({
        'tasks.md': `- [ ] parent task 📅 ${window.moment().format('YYYY-MM-DD')}\n  - [ ] subtask one`,
      });
      seedTaskCache(app, 'tasks.md', [
        { task: ' ', parent: -1, line: 0 },
        { task: ' ', parent: 0, line: 1 },
      ]);
      taskApplication = configuredTaskApplication(app, DEFAULT_SETTINGS);
      await taskApplication.index.initialize();
      await flushMicrotasks();
      leaf = new (WorkspaceLeaf as unknown as { new (app: App): WorkspaceLeaf })(app);
      view = new PanelView(
        leaf,
        DEFAULT_SETTINGS,
        makeTagManager(app),
        taskApplication.index,
        taskApplication.tasks as TaskApplicationApi & TaskCaptureApplicationApi,
        taskApplication.statusRegistry,
      );
      await view.onOpen();
    });

    afterEach(async () => {
      await view.onClose();
      taskApplication.index.destroy();
    });

    it('exact resolution rebuilds a deep stack with the fresh subtask', () => {
      const state = (view as unknown as { state: AppState }).state;
      const tasks = taskApplication.index.list();
      const root = tasks[0]!;
      const sub = root.subtasks[0];
      expect(sub).toBeDefined();
      // Set a 2-level stack: [root, subtask]
      state.set('taskStack', [root, sub!]);
      const snapshot = taskApplication.index.list({ filePath: root.source.filePath })[0]!;
      (
        view as unknown as {
          applyResolution(result: { type: 'exact'; task: typeof snapshot }): void;
        }
      ).applyResolution({ type: 'exact', task: snapshot });
      const stack = state.get('taskStack');
      // Stack should still have 2 elements (root + fresh subtask found by line match)
      expect(stack).toHaveLength(2);
      expect(stack[0] && 'source' in stack[0] ? stack[0].source.filePath : undefined).toBe(
        root.source.filePath,
      );
      expect(taskNodeLine(snapshot, stack[1]!)).toBe(taskNodeLine(root, sub!));
    });

    it('exact resolution truncates a deep stack when the subtask identity is stale', () => {
      const state = (view as unknown as { state: AppState }).state;
      const tasks = taskApplication.index.list();
      const root = tasks[0]!;
      // Create a fake subtask with a line number that doesn't exist in fresh data
      const original = root.subtasks[0]!;
      const fakeSub = {
        ...original,
        ref: {
          ...original.ref,
          relativeLine: 999,
          originalBlock: '  - [ ] different child',
        },
      };
      state.set('taskStack', [root, fakeSub]);
      const snapshot = taskApplication.index.list({ filePath: root.source.filePath })[0]!;
      (
        view as unknown as {
          applyResolution(result: { type: 'exact'; task: typeof snapshot }): void;
        }
      ).applyResolution({ type: 'exact', task: snapshot });
      const stack = state.get('taskStack');
      // Fresh subtask not found at line 999 → break → stack truncated to [freshRoot]
      expect(stack).toHaveLength(1);
    });
  });
});
