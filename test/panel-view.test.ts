// eslint-disable-next-line import/no-nodejs-modules -- computed layout test loads the shipped CSS.
import { readFileSync } from 'node:fs';
import { Notice, TFile, WorkspaceLeaf, type App } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppState, type ListSelection } from '../src/app/AppState';
import type { Project, ProjectWorkspaceSnapshot } from '../src/projects/types';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { CalendarSettings } from '../src/settings/types';
import { TagManager } from '../src/tags/TagManager';
import type {
  TaskApplicationApi,
  TaskCaptureApplicationApi,
  TaskCommandResult,
  TaskCreateSession,
  TaskIndexEvent,
  TaskQueryApi,
  TaskRef,
} from '../src/tasks';
import type { CreationPresentationController } from '../src/ui/creation/CreationPresentationController';
import type { InteractionRegistry } from '../src/ui/interactionOwnership';
import type { CaptureTarget } from '../src/ui/taskCapture/CaptureTargetResolver';
import type { QuickCaptureCoordinator } from '../src/ui/taskCapture/QuickCaptureCoordinator';
import { requestTaskCompletion } from '../src/ui/taskCommandResult';
import { taskNodeLine } from '../src/ui/taskSelection';
import { MonthGridView } from '../src/views/MonthGridView';
import { PANEL_VIEW_TYPE, PanelView } from '../src/views/PanelView';
import type { PanelNavigator } from '../src/views/panelNavigation';
import {
  configuredTaskApplication,
  createAppWithFiles,
  deferred,
  flushMicrotasks,
  queryApiForTasks,
  seedTaskCache,
  task,
  useRealMoment,
} from './helpers';

function makeTagManager(app: App, settings: CalendarSettings = DEFAULT_SETTINGS): TagManager {
  const save = vi.fn().mockResolvedValue(undefined);
  return new TagManager(app, settings, save);
}

useRealMoment();

const shippedStyles = readFileSync(`${import.meta.dirname}/../styles.css`, 'utf8');

function panelCaptureTarget(execute: TaskCreateSession['execute']): CaptureTarget {
  return {
    label: 'Test destination',
    context: { type: 'list', selection: 'today' },
    session: {
      type: 'ready',
      destination: { filePath: 'Capture.md', insertion: { type: 'append' } },
      execute,
    },
    markdownPrefix: '',
    markdownSuffixes: [],
  };
}

function successfulCaptureResult(): TaskCommandResult {
  return {
    type: 'ok',
    changed: true,
    outcome: {
      type: 'task',
      task: task({ title: 'Captured', source: { filePath: 'Capture.md', line: 0 } }),
    },
  };
}

function joinedProjectSnapshot(statuses: readonly ('open' | 'done')[]): ProjectWorkspaceSnapshot {
  const project: Project = {
    path: 'Projects/A.md',
    name: 'A',
    frontmatter: {},
    tags: [],
    statusId: DEFAULT_SETTINGS.projects.statuses[0]!.id,
    rawStatus: null,
    range: {},
    stats: { total: 0, done: 0, cancelled: 0, inProgress: 0, open: 0, progress: null },
  };
  const actions = statuses.map((status, index) => {
    const snapshot = task({
      title: `Joined ${status}`,
      status,
      ref: { filePath: 'Work/A.md', line: index, revision: `${status}:${String(index)}` },
      source: { filePath: 'Work/A.md', line: index },
    });
    return {
      task: snapshot,
      projectPath: project.path,
      dependency: { type: 'allowed' as const },
      owner: { type: 'work-note' as const, path: 'Work/A.md' },
    };
  });
  const done = statuses.filter((status) => status === 'done').length;
  const open = statuses.length - done;
  return {
    project,
    tasks: actions,
    workNotes: [],
    milestones: [],
    taskRollup: {
      total: statuses.length,
      done,
      cancelled: 0,
      inProgress: 0,
      open,
      progress: statuses.length === 0 ? null : done / statuses.length,
    },
    workNoteRollup: { active: 0, completed: 0, dropped: 0 },
    milestoneRollups: new Map(),
    workNoteRelations: [],
    overdue: { tasks: 0, workNotes: 0 },
    dependencies: { blocked: 0, invalid: 0, diagnostics: [] },
    diagnostics: [],
  };
}

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
  it('forwards application dependency IDs into a calendar TaskModal', async () => {
    const app = await createAppWithFiles({});
    const today = window.moment().format('YYYY-MM-DD');
    const dependent = task({
      title: 'Calendar dependent',
      planning: { due: today },
      source: { filePath: 'Tasks.md', line: 0 },
    });
    const candidate = task({
      title: 'Candidate without ID',
      source: { filePath: 'Tasks.md', line: 1 },
    });
    const queries = queryApiForTasks(() => [dependent, candidate]);
    const newDependencyId = vi.fn(() => 'modal-generated');
    const setDependency = vi.fn().mockResolvedValue({
      type: 'invalid' as const,
      issues: [{ code: 'invalid-target' as const, field: 'dependency' }],
    });
    const tasks = {
      queries,
      execute: vi.fn().mockResolvedValue({
        type: 'invalid' as const,
        issues: [{ code: 'invalid-target' as const }],
      }),
      planCreate: vi.fn().mockResolvedValue({
        type: 'unavailable' as const,
        execute: vi.fn(),
      }),
      newDependencyId,
      setDependency,
    } satisfies TaskApplicationApi & TaskCaptureApplicationApi;
    const projection = {
      evaluateCompletion: () => ({ type: 'allowed' as const }),
      inspect: () => ({ decision: { type: 'allowed' as const }, relations: [] }),
      subscribe: () => () => undefined,
    };
    const leaf = new (WorkspaceLeaf as unknown as { new (app: App): WorkspaceLeaf })(app);
    const view = new PanelView(
      leaf,
      structuredClone(DEFAULT_SETTINGS),
      makeTagManager(app),
      queries,
      tasks,
      configuredTaskApplication(app, DEFAULT_SETTINGS).statusRegistry,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      projection,
    );
    await view.onOpen();
    const state = (view as unknown as { state: AppState }).state;
    const center = view as unknown as {
      center: { setCalendarView(view: 'today'): void; render(): void };
    };
    state.set('mode', 'calendar');
    center.center.setCalendarView('today');
    center.center.render();
    await flushMicrotasks();
    const occurrence = Array.from(
      view.contentEl.querySelectorAll<HTMLElement>('.abyss-tg-body'),
    ).find((element) => element.textContent?.includes('Calendar dependent'));
    expect(occurrence).toBeDefined();
    occurrence!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    activeDocument
      .querySelector<HTMLButtonElement>('.abyss-modal [data-dependency-trigger]')!
      .click();
    const button = activeDocument.querySelector<HTMLButtonElement>(
      '.abyss-modal [data-dependency-candidate]',
    )!;

    expect(button.getAttribute('aria-disabled')).toBeNull();
    button.click();
    await flushMicrotasks();
    expect(newDependencyId).toHaveBeenCalledOnce();
    expect(setDependency).toHaveBeenCalledOnce();
    await view.onClose();
  });

  it('renders Project surfaces from coordinator snapshots instead of component indexes', async () => {
    const app = await createAppWithFiles({});
    const settings = structuredClone(DEFAULT_SETTINGS);
    const taskApplication = configuredTaskApplication(app, settings);
    await taskApplication.index.initialize();
    const leaf = new (WorkspaceLeaf as unknown as { new (app: App): WorkspaceLeaf })(app);
    const initial = joinedProjectSnapshot(['open', 'open']);
    const staleProject = initial.project;
    const projectStore = {
      list: () => [staleProject],
      get: () => staleProject,
      activeForLeftPanel: () => [staleProject],
      onUpdate: () => () => {},
      refresh: () => {},
    } as never;
    let workspaceListener:
      | ((snapshots: readonly ProjectWorkspaceSnapshot[], event: unknown) => void)
      | undefined;
    const onWorkspaceUpdate = vi.fn(
      (listener: (snapshots: readonly ProjectWorkspaceSnapshot[], event: unknown) => void) => {
        workspaceListener = listener;
        return () => {};
      },
    );
    const projectWorkspace = {
      list: () => [initial],
      get: () => initial,
      onUpdate: onWorkspaceUpdate,
      absorbOwnCommit: () => {},
    } as never;
    const view = new PanelView(
      leaf,
      settings,
      makeTagManager(app, settings),
      taskApplication.index,
      taskApplication.tasks as TaskApplicationApi & TaskCaptureApplicationApi,
      taskApplication.statusRegistry,
      undefined,
      undefined,
      undefined,
      undefined,
      projectStore,
      projectWorkspace,
    );
    await view.onOpen();

    const projectItem = Array.from(view.contentEl.querySelectorAll('.abyss-project-item')).find(
      (element) => element.querySelector('.abyss-left-label')?.textContent === 'A',
    );
    expect(projectItem?.querySelector('.abyss-left-count')?.textContent).toBe('2');

    const state = (view as unknown as { state: AppState }).state;
    state.set('mode', 'projects');
    state.set('projectsPanel', { view: 'dashboard', path: 'Projects/A.md' });
    const dependencyOnly: ProjectWorkspaceSnapshot = {
      ...initial,
      tasks: initial.tasks.map((action, index) =>
        index === 0
          ? {
              ...action,
              dependency: {
                type: 'blocked' as const,
                prerequisites: [{ filePath: 'Prep.md', line: 0, revision: 'prep' }],
              },
            }
          : action,
      ),
      dependencies: { blocked: 1, invalid: 0, diagnostics: [] },
    };
    workspaceListener?.([dependencyOnly], {
      snapshots: [dependencyOnly],
      projectPaths: ['Projects/A.md'],
    });

    expect(onWorkspaceUpdate).toHaveBeenCalledOnce();
    expect(
      view.contentEl.querySelector('.abyss-task-dependency-badge')?.getAttribute('aria-label'),
    ).toBe('Blocked by 1 prerequisite');

    const settled = joinedProjectSnapshot(['open', 'done']);
    workspaceListener?.([settled], { snapshots: [settled], projectPaths: ['Projects/A.md'] });
    expect(view.contentEl.querySelector('.abyss-progress-label')?.textContent).toBe('1/2');
    expect(view.contentEl.querySelector('.abyss-project-tasks')?.textContent).toContain(
      'Joined open',
    );
    expect(view.contentEl.querySelector('.abyss-project-tasks')?.textContent).not.toContain(
      'Joined done',
    );
    expect(view.contentEl.querySelector('[aria-label="Set as Next Action"]')).toBeNull();

    await view.onClose();
    taskApplication.index.destroy();
  });

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

    it('owns one stable Quick Capture host in the center shell across every mode rerender', () => {
      const layout = view.contentEl.querySelector('.abyss-layout')!;
      const host = layout.querySelector('.abyss-quick-capture-host');
      const shell = layout.querySelector('.abyss-center-shell');
      const center = layout.querySelector('.abyss-center');

      expect(host).not.toBeNull();
      expect(shell).not.toBeNull();
      expect(center).not.toBeNull();
      expect(layout.querySelectorAll('.abyss-quick-capture-host')).toHaveLength(1);
      expect(host?.parentElement).toBe(shell);
      expect(center?.parentElement).toBe(shell);
      expect(host?.closest('.abyss-center-shell')).toBe(shell);
      expect(host?.closest('.abyss-rail, .abyss-left, .abyss-right')).toBeNull();

      const internals = view as unknown as { panelNavigation: PanelNavigator };
      internals.panelNavigation.openCalendar();
      internals.panelNavigation.openSearch();
      internals.panelNavigation.openProjects();
      internals.panelNavigation.openTasks();

      expect(layout.querySelector('.abyss-quick-capture-host')).toBe(host);
      expect(layout.querySelector('.abyss-center-shell')).toBe(shell);
      expect(layout.querySelector('.abyss-center')).toBe(center);
      expect(host?.parentElement).toBe(shell);
    });

    it('resolves global Quick Capture against the current Project without inventing task defaults', () => {
      const focused = task({
        title: 'Focused project task',
        status: 'in-progress',
        statusSymbol: '/',
        priority: 'A',
        source: { filePath: 'Projects/Current.md', line: 2 },
      });
      const internals = view as unknown as {
        state: AppState;
        quickCaptureContext(): unknown;
        center: {
          projectWorkspaceSession: {
            tasks: {
              reconcile(actions: readonly unknown[]): void;
              focusOnly(ref: TaskRef): void;
            };
          };
        };
      };
      internals.state.set('mode', 'projects');
      internals.state.set('projectsPanel', { view: 'dashboard', path: 'Projects/Current.md' });

      expect(internals.quickCaptureContext()).toEqual({
        type: 'project-workspace',
        projectPath: 'Projects/Current.md',
        destinationPath: 'Projects/Current.md',
      });

      internals.center.projectWorkspaceSession.tasks.reconcile([
        {
          task: focused,
          projectPath: 'Projects/Current.md',
          dependency: { type: 'allowed' },
          owner: { type: 'project', path: 'Projects/Current.md' },
        },
      ]);
      internals.center.projectWorkspaceSession.tasks.focusOnly(focused.ref);

      expect(internals.quickCaptureContext()).toEqual({
        type: 'project-workspace',
        projectPath: 'Projects/Current.md',
        destinationPath: 'Projects/Current.md',
        statusSymbol: '/',
        priority: 'A',
      });
    });

    it('keeps collapsed Tasks panes reachable through keyboard-native compact controls', () => {
      activeDocument.body.appendChild(view.containerEl);
      const internals = view as unknown as { state: AppState; panelNavigation: PanelNavigator };
      const layout = view.contentEl.querySelector<HTMLElement>('.abyss-layout')!;
      const left = layout.querySelector<HTMLElement>('.abyss-left')!;
      const right = layout.querySelector<HTMLElement>('.abyss-right')!;
      const lists = layout.querySelector<HTMLButtonElement>('[aria-label="Show task lists"]')!;
      const details = layout.querySelector<HTMLButtonElement>('[aria-label="Show task details"]')!;

      expect(lists.tagName).toBe('BUTTON');
      expect(details.tagName).toBe('BUTTON');
      expect(lists.getAttribute('aria-controls')).toBe(left.id);
      expect(details.getAttribute('aria-controls')).toBe(right.id);
      expect(lists.getAttribute('aria-expanded')).toBe('false');
      expect(details.getAttribute('aria-expanded')).toBe('false');

      setGeometry(layout, rect(0, 0, 1200, 480));
      window.dispatchEvent(new Event('resize'));
      details.focus();
      internals.state.set('taskStack', [task()]);
      const desktopEscape = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      activeDocument.dispatchEvent(desktopEscape);
      expect(desktopEscape.defaultPrevented).toBe(false);
      expect(right.classList.contains('is-compact-open')).toBe(false);
      expect(activeDocument.activeElement).toBe(details);

      internals.state.set('taskStack', []);
      setGeometry(layout, rect(0, 0, 440, 480));
      window.dispatchEvent(new Event('resize'));

      lists.click();
      expect(left.classList.contains('is-compact-open')).toBe(true);
      expect(lists.getAttribute('aria-expanded')).toBe('true');
      expect(lists.getAttribute('aria-label')).toBe('Hide task lists');
      expect(activeDocument.activeElement).toBe(left);

      details.click();
      expect(left.classList.contains('is-compact-open')).toBe(false);
      expect(right.classList.contains('is-compact-open')).toBe(true);
      expect(lists.getAttribute('aria-expanded')).toBe('false');
      expect(details.getAttribute('aria-expanded')).toBe('true');
      expect(lists.getAttribute('aria-label')).toBe('Show task lists');
      expect(details.getAttribute('aria-label')).toBe('Hide task details');
      expect(activeDocument.activeElement).toBe(right);

      const composingEscape = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
        isComposing: true,
      });
      activeDocument.dispatchEvent(composingEscape);
      expect(composingEscape.defaultPrevented).toBe(false);
      expect(right.classList.contains('is-compact-open')).toBe(true);

      const legacyComposingEscape = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(legacyComposingEscape, 'keyCode', { value: 229 });
      activeDocument.dispatchEvent(legacyComposingEscape);
      expect(legacyComposingEscape.defaultPrevented).toBe(false);
      expect(right.classList.contains('is-compact-open')).toBe(true);

      const nativeMenu = activeDocument.body.createDiv({ cls: 'menu' });
      setGeometry(nativeMenu, rect(20, 20, 180, 80));
      const nativeEscape = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      activeDocument.dispatchEvent(nativeEscape);
      expect(nativeEscape.defaultPrevented).toBe(false);
      expect(right.classList.contains('is-compact-open')).toBe(true);
      nativeMenu.remove();

      const escape = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      activeDocument.dispatchEvent(escape);
      expect(escape.defaultPrevented).toBe(true);
      expect(right.classList.contains('is-compact-open')).toBe(false);
      expect(details.getAttribute('aria-expanded')).toBe('false');
      expect(details.getAttribute('aria-label')).toBe('Show task details');
      expect(activeDocument.activeElement).toBe(details);

      internals.state.set('taskStack', [task()]);
      expect(right.classList.contains('is-compact-open')).toBe(true);
      expect(details.getAttribute('aria-expanded')).toBe('true');
      expect(right.getAttribute('role')).toBe('dialog');
      expect(right.getAttribute('aria-modal')).toBe('true');
      const taskClose = right.querySelector<HTMLButtonElement>('.abyss-inspector-shell-close')!;
      expect(taskClose.getAttribute('aria-label')).toBe('Close Task details');
      const titleView = right.querySelector<HTMLElement>('.abyss-right-title-view')!;
      titleView.click();
      const title = right.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit')!;
      const originalTitle = title.value;
      title.value = `${originalTitle} draft`;
      title.dispatchEvent(new Event('input', { bubbles: true }));
      activeDocument.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      expect(internals.state.get('taskStack')).not.toEqual([]);
      expect(right.classList.contains('is-compact-open')).toBe(true);
      title.value = originalTitle;
      title.dispatchEvent(new Event('input', { bubbles: true }));
      activeDocument.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      expect(internals.state.get('taskStack')).toEqual([]);
      expect(right.classList.contains('is-compact-open')).toBe(false);
      expect(activeDocument.activeElement).toBe(details);

      internals.state.set('taskStack', [task()]);
      right.querySelector<HTMLButtonElement>('.abyss-inspector-shell-close')!.click();
      expect(internals.state.get('taskStack')).toEqual([]);
      expect(right.classList.contains('is-compact-open')).toBe(false);
      expect(activeDocument.activeElement).toBe(details);
      expect(right.getAttribute('aria-modal')).toBeNull();
      expect(right.dataset['inspectorLayout']).toBeUndefined();

      internals.panelNavigation.openCalendar();
      expect(left.classList.contains('is-compact-open')).toBe(false);
      expect(right.classList.contains('is-compact-open')).toBe(false);
      expect(lists.getAttribute('aria-expanded')).toBe('false');
      expect(details.getAttribute('aria-expanded')).toBe('false');

      internals.state.set('taskStack', []);
      internals.state.set('taskStack', [task()]);
      const calendarEscape = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      activeDocument.dispatchEvent(calendarEscape);
      expect(calendarEscape.defaultPrevented).toBe(false);
      expect(right.classList.contains('is-compact-open')).toBe(false);
    });

    it('keeps the joined Task inspector presented in Projects mode with compact ownership', () => {
      activeDocument.body.appendChild(view.containerEl);
      const style = activeDocument.head.createEl('style');
      style.textContent = shippedStyles;
      const internals = view as unknown as { state: AppState; panelNavigation: PanelNavigator };
      const layout = view.contentEl.querySelector<HTMLElement>('.abyss-layout')!;
      const right = layout.querySelector<HTMLElement>('.abyss-right')!;
      const details = layout.querySelector<HTMLButtonElement>('.abyss-compact-pane-button--right')!;

      try {
        setGeometry(layout, rect(0, 0, 1200, 480));
        window.dispatchEvent(new Event('resize'));
        internals.panelNavigation.openProjects();
        internals.state.set('taskStack', [task({ title: 'Joined Project Task' })]);

        expect(getComputedStyle(right).display).not.toBe('none');
        expect(right.textContent).toContain('Joined Project Task');

        setGeometry(layout, rect(0, 0, 390, 480));
        window.dispatchEvent(new Event('resize'));
        expect(right.classList.contains('is-compact-open')).toBe(true);
        expect(details.getAttribute('aria-expanded')).toBe('true');
      } finally {
        style.remove();
      }
    });

    it.each(['resolving', 'open'] as const)(
      'does not destroy a %s Quick Capture generation when a compact pane is requested',
      (phase) => {
        const internals = view as unknown as { quickCapture: QuickCaptureCoordinator };
        const layout = view.contentEl.querySelector<HTMLElement>('.abyss-layout')!;
        const right = layout.querySelector<HTMLElement>('.abyss-right')!;
        const details = layout.querySelector<HTMLButtonElement>(
          '[aria-label="Show task details"]',
        )!;
        setGeometry(layout, rect(0, 0, 390, 480));
        window.dispatchEvent(new Event('resize'));
        const close = vi.spyOn(internals.quickCapture, 'close');
        vi.spyOn(internals.quickCapture, 'phase', 'get').mockReturnValue(phase);

        details.click();

        expect(close).not.toHaveBeenCalled();
        expect(right.classList.contains('is-compact-open')).toBe(false);
        expect(details.getAttribute('aria-expanded')).toBe('false');
      },
    );

    it('reconciles compact-pane ownership at the exact 58rem and 38rem boundaries', () => {
      activeDocument.body.appendChild(view.containerEl);
      const layout = view.contentEl.querySelector<HTMLElement>('.abyss-layout')!;
      const left = layout.querySelector<HTMLElement>('.abyss-left')!;
      const right = layout.querySelector<HTMLElement>('.abyss-right')!;
      const lists = layout.querySelector<HTMLButtonElement>('.abyss-compact-pane-button--left')!;
      const details = layout.querySelector<HTMLButtonElement>('.abyss-compact-pane-button--right')!;
      const resizeTo = (width: number): void => {
        setGeometry(layout, rect(0, 0, width, 480));
        window.dispatchEvent(new Event('resize'));
      };

      resizeTo(929);
      details.click();
      expect(right.classList.contains('is-compact-open')).toBe(false);

      resizeTo(928);
      details.click();
      expect(right.classList.contains('is-compact-open')).toBe(true);
      details.click();
      lists.click();
      expect(left.classList.contains('is-compact-open')).toBe(false);

      resizeTo(608);
      lists.click();
      expect(left.classList.contains('is-compact-open')).toBe(true);
      resizeTo(609);
      expect(left.classList.contains('is-compact-open')).toBe(false);
      expect(lists.getAttribute('aria-expanded')).toBe('false');

      details.click();
      expect(right.classList.contains('is-compact-open')).toBe(true);
      resizeTo(929);
      expect(right.classList.contains('is-compact-open')).toBe(false);
      expect(details.getAttribute('aria-expanded')).toBe('false');
      const escape = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      activeDocument.dispatchEvent(escape);
      expect(escape.defaultPrevented).toBe(false);
    });

    it('reconciles rem-based pane ownership on css-change without a width change', () => {
      activeDocument.body.appendChild(view.containerEl);
      const layout = view.contentEl.querySelector<HTMLElement>('.abyss-layout')!;
      const right = layout.querySelector<HTMLElement>('.abyss-right')!;
      const details = layout.querySelector<HTMLButtonElement>('.abyss-compact-pane-button--right')!;
      const root = activeDocument.documentElement;
      const previousFontSize = root.style.fontSize;
      setGeometry(layout, rect(0, 0, 950, 480));

      try {
        root.style.fontSize = '16px';
        window.dispatchEvent(new Event('resize'));
        details.click();
        expect(right.classList.contains('is-compact-open')).toBe(false);

        root.style.fontSize = '17px';
        app.workspace.trigger('css-change');
        details.click();
        expect(right.classList.contains('is-compact-open')).toBe(true);

        root.style.fontSize = '16px';
        app.workspace.trigger('css-change');
        expect(right.classList.contains('is-compact-open')).toBe(false);
        expect(details.getAttribute('aria-expanded')).toBe('false');
      } finally {
        root.style.fontSize = previousFontSize;
        app.workspace.trigger('css-change');
      }
    });

    it.each(['left control', 'right control', 'task selection'] as const)(
      'preserves an exact pending-blur failure through a compact %s conflict',
      async (trigger) => {
        activeDocument.body.appendChild(view.containerEl);
        const internals = view as unknown as {
          state: AppState;
          quickCapture: QuickCaptureCoordinator;
          creationPresentation: CreationPresentationController;
          interactionRegistry: InteractionRegistry<string>;
        };
        const layout = view.contentEl.querySelector<HTMLElement>('.abyss-layout')!;
        const left = layout.querySelector<HTMLElement>('.abyss-left')!;
        const right = layout.querySelector<HTMLElement>('.abyss-right')!;
        const leftButton = layout.querySelector<HTMLButtonElement>(
          '.abyss-compact-pane-button--left',
        )!;
        const rightButton = layout.querySelector<HTMLButtonElement>(
          '.abyss-compact-pane-button--right',
        )!;
        setGeometry(layout, rect(0, 0, 390, 480));
        window.dispatchEvent(new Event('resize'));

        const pending = deferred<TaskCommandResult>();
        const execute = vi.fn(() => pending.promise);
        const options = (
          internals.quickCapture as unknown as {
            options: { resolveTarget: () => Promise<CaptureTarget> };
          }
        ).options;
        options.resolveTarget = async () => panelCaptureTarget(execute);
        const present = vi
          .spyOn(internals.creationPresentation, 'present')
          .mockImplementation(() => undefined);

        internals.quickCapture.openOrFocus();
        await flushMicrotasks(0);
        const input = layout.querySelector<HTMLInputElement>('.abyss-quick-capture-input')!;
        input.value = '  exact failed draft  ';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const conflictTarget =
          trigger === 'left control'
            ? leftButton
            : trigger === 'right control'
              ? rightButton
              : layout;
        conflictTarget.dispatchEvent(
          new Event('pointerdown', { bubbles: true, cancelable: true, composed: true }),
        );
        if (trigger === 'task selection') internals.state.set('taskStack', [task()]);
        else conflictTarget.click();

        expect(execute).toHaveBeenCalledOnce();
        expect(internals.quickCapture.phase).toBe('open');
        expect(input.readOnly).toBe(true);
        expect(left.classList.contains('is-compact-open')).toBe(false);
        expect(right.classList.contains('is-compact-open')).toBe(false);

        const failure: TaskCommandResult = {
          type: 'invalid',
          issues: [{ code: 'invalid-title', field: 'title' }],
        };
        pending.resolve(failure);
        await flushMicrotasks(0);

        expect(internals.quickCapture.phase).toBe('open');
        expect(input.value).toBe('  exact failed draft  ');
        expect(input.getAttribute('aria-invalid')).toBe('true');
        expect(layout.querySelector('.abyss-capture-error')?.textContent).toBe(
          'The new task is invalid and was not created.',
        );
        expect(present).toHaveBeenCalledOnce();
        expect(present).toHaveBeenCalledWith(failure, expect.objectContaining({ kind: 'error' }));
        expect(internals.interactionRegistry.allows('openCalendar')).toBe(false);

        input.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
          }),
        );
        expect(internals.quickCapture.phase).toBe('closed');
        expect(internals.interactionRegistry.allows('openCalendar')).toBe(true);
      },
    );

    it('delivers a pending-blur success before allowing the requested compact pane', async () => {
      activeDocument.body.appendChild(view.containerEl);
      const internals = view as unknown as {
        quickCapture: QuickCaptureCoordinator;
        creationPresentation: CreationPresentationController;
        interactionRegistry: InteractionRegistry<string>;
      };
      const layout = view.contentEl.querySelector<HTMLElement>('.abyss-layout')!;
      const right = layout.querySelector<HTMLElement>('.abyss-right')!;
      const details = layout.querySelector<HTMLButtonElement>('.abyss-compact-pane-button--right')!;
      setGeometry(layout, rect(0, 0, 390, 480));
      window.dispatchEvent(new Event('resize'));

      const pending = deferred<TaskCommandResult>();
      const execute = vi.fn(() => pending.promise);
      const options = (
        internals.quickCapture as unknown as {
          options: { resolveTarget: () => Promise<CaptureTarget> };
        }
      ).options;
      options.resolveTarget = async () => panelCaptureTarget(execute);
      const present = vi
        .spyOn(internals.creationPresentation, 'present')
        .mockImplementation(() => undefined);

      internals.quickCapture.openOrFocus();
      await flushMicrotasks(0);
      const input = layout.querySelector<HTMLInputElement>('.abyss-quick-capture-input')!;
      input.value = 'captured once';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      details.dispatchEvent(
        new Event('pointerdown', { bubbles: true, cancelable: true, composed: true }),
      );
      details.click();
      expect(execute).toHaveBeenCalledOnce();
      expect(right.classList.contains('is-compact-open')).toBe(false);

      const result = successfulCaptureResult();
      pending.resolve(result);
      await flushMicrotasks(0);

      expect(internals.quickCapture.phase).toBe('closed');
      expect(layout.querySelector('.abyss-quick-capture-input')).toBeNull();
      expect(present).toHaveBeenCalledOnce();
      expect(present).toHaveBeenCalledWith(result, expect.objectContaining({ kind: 'success' }));
      expect(internals.interactionRegistry.allows('openCalendar')).toBe(true);
      expect(right.classList.contains('is-compact-open')).toBe(true);
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

    it('gives the recurrence-delete alertdialog modal precedence in the live panel router', async () => {
      document.body.appendChild(view.containerEl);
      app.workspace.activeLeaf = leaf;
      document.body.tabIndex = -1;
      document.body.focus();
      const internals = view as unknown as {
        state: AppState;
        interactionRegistry: InteractionRegistry<string>;
      };
      const before = {
        mode: internals.state.get('mode'),
        selectedList: internals.state.get('selectedList'),
        taskStack: internals.state.get('taskStack'),
        searchQuery: internals.state.get('searchQuery'),
      };
      const completion = requestTaskCompletion(
        { status: 'open', recurrence: 'tomorrow', onCompletion: 'delete' },
        vi.fn(),
        internals.interactionRegistry,
      );
      const surface = activeDocument.querySelector<HTMLElement>(
        '.abyss-recurrence-delete-confirm',
      )!;
      const cancel = Array.from(surface.querySelectorAll<HTMLButtonElement>('button')).find(
        (candidate) => candidate.textContent === 'Cancel',
      )!;
      cancel.blur();
      document.body.focus();

      const suppressed = [
        new KeyboardEvent('keydown', {
          key: 'c',
          code: 'KeyC',
          bubbles: true,
          cancelable: true,
        }),
        new KeyboardEvent('keydown', {
          key: 'l',
          code: 'KeyL',
          bubbles: true,
          cancelable: true,
        }),
        new KeyboardEvent('keydown', {
          key: 'q',
          code: 'KeyQ',
          bubbles: true,
          cancelable: true,
        }),
      ];
      suppressed.forEach((event) => document.body.dispatchEvent(event));
      await flushMicrotasks(0);

      suppressed.forEach((event) => expect(event.defaultPrevented).toBe(false));
      expect({
        mode: internals.state.get('mode'),
        selectedList: internals.state.get('selectedList'),
        taskStack: internals.state.get('taskStack'),
        searchQuery: internals.state.get('searchQuery'),
      }).toEqual(before);
      expect(activeDocument.querySelector('.abyss-recurrence-delete-confirm')).toBe(surface);
      expect(view.contentEl.querySelector('.abyss-capture-surface')).toBeNull();

      cancel.click();
      await completion;
      const afterDismissal = new KeyboardEvent('keydown', {
        key: 'c',
        code: 'KeyC',
        bubbles: true,
        cancelable: true,
      });
      document.body.dispatchEvent(afterDismissal);
      expect(afterDismissal.defaultPrevented).toBe(true);
      expect(internals.state.get('mode')).toBe('calendar');
    });

    it.each(['CenterPanel', 'RightPanel'] as const)(
      'releases the live recurrence dialog owner when PanelView tears down the %s path',
      async (path) => {
        const invalidDelete = task({ recurrence: 'tomorrow', onCompletion: 'delete' });
        const internals = view as unknown as {
          center: { toggleTask(task: typeof invalidDelete): Promise<void> };
          right: { toggleTaskLike(task: typeof invalidDelete): Promise<void> };
          interactionRegistry: InteractionRegistry<string>;
        };
        const completion =
          path === 'CenterPanel'
            ? internals.center.toggleTask(invalidDelete)
            : internals.right.toggleTaskLike(invalidDelete);
        const registry = internals.interactionRegistry;
        const surface = activeDocument.querySelector<HTMLElement>(
          '.abyss-recurrence-delete-confirm',
        )!;

        expect(registry.allows('openCalendar')).toBe(false);
        await view.onClose();
        await completion;

        expect(surface.isConnected).toBe(false);
        expect(registry.allows('openCalendar')).toBe(true);
      },
    );

    it('keeps TaskModal ownership layered after its RightPanel recurrence dialog closes', async () => {
      const invalidDelete = task({ recurrence: 'tomorrow', onCompletion: 'delete' });
      const internals = view as unknown as {
        center: {
          taskModal: {
            open(task: typeof invalidDelete): void;
            close(): void;
            innerPanel: { toggleTaskLike(task: typeof invalidDelete): Promise<void> };
          };
        };
        interactionRegistry: InteractionRegistry<string>;
      };
      const modal = internals.center.taskModal;
      modal.open(invalidDelete);
      const completion = modal.innerPanel.toggleTaskLike(invalidDelete);
      const surface = activeDocument.querySelector<HTMLElement>(
        '.abyss-recurrence-delete-confirm',
      )!;

      expect(internals.interactionRegistry.allows('openCalendar')).toBe(false);
      surface.querySelector<HTMLButtonElement>('button')?.click();
      await completion;
      expect(internals.interactionRegistry.allows('openCalendar')).toBe(false);

      modal.close();
      expect(internals.interactionRegistry.allows('openCalendar')).toBe(true);
    });

    it('settles a live recurrence dialog and releases both owners when TaskModal closes', async () => {
      const invalidDelete = task({ recurrence: 'tomorrow', onCompletion: 'delete' });
      const internals = view as unknown as {
        center: {
          taskModal: {
            open(task: typeof invalidDelete): void;
            close(): void;
            innerPanel: { toggleTaskLike(task: typeof invalidDelete): Promise<void> };
          };
        };
        interactionRegistry: InteractionRegistry<string>;
      };
      const modal = internals.center.taskModal;
      const releaseModal = vi.fn();
      const releaseDialog = vi.fn();
      const acquire = vi
        .spyOn(internals.interactionRegistry, 'acquire')
        .mockReturnValueOnce({ release: releaseModal })
        .mockReturnValueOnce({ release: releaseDialog });

      modal.open(invalidDelete);
      const completion = modal.innerPanel.toggleTaskLike(invalidDelete);
      const surface = activeDocument.querySelector<HTMLElement>(
        '.abyss-recurrence-delete-confirm',
      )!;
      expect(surface.isConnected).toBe(true);
      expect(acquire).toHaveBeenCalledTimes(2);

      modal.close();
      await completion;
      modal.close();

      expect(surface.isConnected).toBe(false);
      expect(releaseModal).toHaveBeenCalledOnce();
      expect(releaseDialog).toHaveBeenCalledOnce();
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

    it('clears a Project inspector after leaving Projects without mutating during delivery', async () => {
      const state = (view as unknown as { state: AppState }).state;
      state.set('mode', 'projects');
      state.set('inspectorSelection', { type: 'project', path: 'Projects/A.md' });

      expect(() => state.set('mode', 'tasks')).not.toThrow();
      await flushMicrotasks();

      expect(state.get('inspectorSelection')).toBeNull();
      expect(state.get('inspectorOrigin')).toBeNull();
    });

    it('switches the production Project inspector between region and dirty narrow dialog ownership', () => {
      const internals = view as unknown as {
        state: AppState;
        inspectorDrafts: {
          capture(
            identity: { type: 'project'; path: string },
            field: 'description',
            capture: {
              value: string;
              baseline: string;
              selectionStart: number;
              selectionEnd: number;
              hadFocus: boolean;
            },
          ): void;
        };
        updateCompactPaneAvailability(width: number, ownerWindow: Window | null): void;
      };
      const identity = { type: 'project' as const, path: 'Projects/Missing.md' };
      internals.inspectorDrafts.capture(identity, 'description', {
        value: 'Recover me',
        baseline: 'Published',
        selectionStart: 3,
        selectionEnd: 3,
        hadFocus: false,
      });
      internals.state.set('mode', 'projects');
      internals.state.set('inspectorSelection', identity);

      expect(view.contentEl.querySelector('.abyss-inspector-shell')?.getAttribute('role')).toBe(
        'region',
      );
      internals.updateCompactPaneAvailability(600, view.contentEl.ownerDocument.defaultView);
      const right = view.contentEl.querySelector<HTMLElement>('.abyss-right')!;
      const dialog = right.querySelector<HTMLElement>('.abyss-inspector-shell')!;
      expect(dialog.getAttribute('role')).toBe('dialog');
      expect(dialog.getAttribute('aria-modal')).toBe('true');
      expect(right.classList.contains('is-compact-open')).toBe(true);

      view.contentEl.ownerDocument.body.dispatchEvent(
        new Event('pointerdown', { bubbles: true, cancelable: true }),
      );
      expect(right.classList.contains('is-compact-open')).toBe(true);
      expect(right.querySelector('.abyss-inspector-shell')).not.toBeNull();
      expect(internals.state.get('inspectorSelection')).toEqual(identity);

      internals.updateCompactPaneAvailability(1200, view.contentEl.ownerDocument.defaultView);
      expect(right.querySelector('.abyss-inspector-shell')?.getAttribute('role')).toBe('region');
      expect(right.classList.contains('is-compact-open')).toBe(false);
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
