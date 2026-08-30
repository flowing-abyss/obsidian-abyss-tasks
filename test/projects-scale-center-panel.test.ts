// eslint-disable-next-line no-restricted-imports, import/no-extraneous-dependencies
import { Menu, type App } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { CenterPanel } from '../src/panels/CenterPanel';
import { ProjectTaskCollectionSession } from '../src/panels/projects/ProjectTaskCollectionSession';
import type { Project, ProjectAction, ProjectWorkspaceSnapshot } from '../src/projects/types';
import type { WorkNoteSnapshot } from '../src/projects/work-notes/types';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { CalendarSettings } from '../src/settings/types';
import { StatusRegistry } from '../src/status/StatusRegistry';
import type { TaskApplicationApi, TaskCommandResult, TaskSnapshot } from '../src/tasks';
import { PROJECTS_SCALE_FIXTURE, type ProjectsScaleTaskRecord } from './fixtures/projects-scale';
import {
  deferred,
  flushMicrotasks,
  freshContainer,
  task,
  taskQueryApi,
  useRealMoment,
} from './helpers';

useRealMoment();

const mounted: HTMLElement[] = [];

afterEach(() => {
  for (const element of mounted.splice(0)) element.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function scaleSettings(
  groupBy: CalendarSettings['projects']['view']['tasks']['groupBy'],
): CalendarSettings {
  return {
    ...DEFAULT_SETTINGS,
    projects: {
      ...DEFAULT_SETTINGS.projects,
      view: {
        ...DEFAULT_SETTINGS.projects.view,
        tasks: {
          ...DEFAULT_SETTINGS.projects.view.tasks,
          groupBy,
          statusGroups: ['todo', 'in-progress', 'done', 'cancelled'],
        },
      },
    },
  };
}

function statusSymbol(status: ProjectsScaleTaskRecord['status']): string {
  if (status === 'done') return 'x';
  if (status === 'cancelled') return '-';
  if (status === 'in-progress') return '/';
  return ' ';
}

function snapshotTask(record: ProjectsScaleTaskRecord, forceOpen = false): TaskSnapshot {
  return task({
    ref: record.ref,
    title: record.title,
    markdownTitle: record.title,
    status: forceOpen ? 'open' : record.status,
    statusSymbol: forceOpen ? ' ' : statusSymbol(record.status),
    priority: record.priority,
    tags: ['#task/inbox'],
    planning: {
      ...(record.scheduled && { scheduled: record.scheduled }),
      ...(record.due && record.due !== 'invalid-date' && { due: record.due.slice(0, 10) }),
    },
    dependency: {
      ...(record.taskId && { id: record.taskId }),
      dependsOn: [...record.dependsOn],
    },
    source: {
      filePath: record.ref.filePath,
      line: record.ref.line,
      originalMarkdown: record.markdown,
      originalBlock: record.originalBlock,
    },
    ...(record.line % 23 === 0 && {
      description: 'Expanded variable-height card used by the scale window contract.',
    }),
  });
}

function workspaceSnapshot(
  project: Project,
  actions: readonly ProjectAction[],
  workNotes: readonly WorkNoteSnapshot[] = [],
): ProjectWorkspaceSnapshot {
  const done = actions.filter(({ task: candidate }) => candidate.status === 'done').length;
  const cancelled = actions.filter(
    ({ task: candidate }) => candidate.status === 'cancelled',
  ).length;
  const inProgress = actions.filter(
    ({ task: candidate }) => candidate.status === 'in-progress',
  ).length;
  const total = actions.length - cancelled;
  return {
    project,
    tasks: actions,
    workNotes,
    milestones: [],
    taskRollup: {
      total,
      done,
      cancelled,
      inProgress,
      open: actions.length - done - cancelled - inProgress,
      progress: total === 0 ? null : done / total,
    },
    workNoteRollup: { active: workNotes.length, completed: 0, dropped: 0 },
    milestoneRollups: new Map(),
    workNoteRelations: [],
    overdue: { tasks: 0, workNotes: 0 },
    dependencies: { blocked: 1, invalid: 0, diagnostics: [] },
    diagnostics: [],
  };
}

interface ScaleHarness {
  readonly panel: CenterPanel;
  readonly state: AppState;
  readonly root: HTMLElement;
  readonly tasks: readonly TaskSnapshot[];
  readonly actions: readonly ProjectAction[];
  readonly execute: ReturnType<typeof vi.fn>;
  update(actions: readonly ProjectAction[]): void;
}

function mountScaleProject(
  options: {
    readonly groupBy?: CalendarSettings['projects']['view']['tasks']['groupBy'];
    readonly forceOpen?: boolean;
    readonly withWorkNote?: boolean;
  } = {},
): ScaleHarness {
  const baseSettings = scaleSettings(options.groupBy ?? 'none');
  const settings: CalendarSettings = options.forceOpen
    ? {
        ...baseSettings,
        projects: {
          ...baseSettings.projects,
          view: {
            ...baseSettings.projects.view,
            tasks: {
              ...baseSettings.projects.view.tasks,
              sortBy: { field: 'title', dir: 'asc' },
            },
          },
        },
      }
    : baseSettings;
  const tasks = PROJECTS_SCALE_FIXTURE.executionTasks.map((record) =>
    snapshotTask(record, options.forceOpen),
  );
  const projectPath = PROJECTS_SCALE_FIXTURE.projectPaths[0]!;
  const project: Project = {
    path: projectPath,
    name: 'Scale project',
    frontmatter: {},
    tags: [],
    statusId: settings.projects.defaultStatusId,
    rawStatus: 'active',
    range: {},
    stats: {
      total: tasks.length,
      done: 0,
      cancelled: 0,
      inProgress: 0,
      open: tasks.length,
      progress: 0,
    },
  };
  const actions = tasks.map(
    (candidate, index): ProjectAction => ({
      task: candidate,
      projectPath,
      dependency:
        index === 80 ? { type: 'blocked', prerequisites: [tasks[0]!.ref] } : { type: 'allowed' },
      owner:
        PROJECTS_SCALE_FIXTURE.executionTasks[index]!.ownerPath ===
        PROJECTS_SCALE_FIXTURE.executionTasks[index]!.projectPath
          ? { type: 'project', path: candidate.ref.filePath }
          : { type: 'work-note', path: candidate.ref.filePath },
    }),
  );
  const workNotes: readonly WorkNoteSnapshot[] = options.withWorkNote
    ? [
        {
          path: 'Work Notes/Scale note.md',
          presetRevision: 1,
          presetFingerprint: 'scale-fixture',
          kind: 'ordinary',
          projectPath,
          statusId: settings.projects.defaultStatusId,
          rawStatus: 'Active',
          writableStatusShape: true,
          range: {},
          blockedByPaths: [],
          relatedPaths: [],
          diagnostics: [],
        },
      ]
    : [];
  let currentTasks: readonly TaskSnapshot[] = tasks;
  const queries = taskQueryApi({
    list: () => currentTasks,
    resolve: (ref) => {
      const exact = currentTasks.find(
        (candidate) =>
          candidate.ref.filePath === ref.filePath &&
          candidate.ref.line === ref.line &&
          candidate.ref.revision === ref.revision,
      );
      return exact
        ? { type: 'exact' as const, task: exact, basis: { observed: exact } }
        : { type: 'not-found' as const, ref };
    },
  });
  const execute = vi.fn().mockResolvedValue({
    type: 'invalid',
    issues: [{ code: 'invalid-target' }],
  });
  const application = { queries, execute } as TaskApplicationApi;
  const workNoteCommands = options.withWorkNote
    ? ({
        capabilities: () => ({ update: true, create: true }),
        statuses: () => settings.projects.statuses,
        observe: (note: WorkNoteSnapshot) => note,
        setStatus: vi.fn(),
        create: vi.fn(),
      } as never)
    : undefined;
  const state = new AppState();
  state.set('projectsPanel', { view: 'dashboard', path: projectPath });
  state.set('mode', 'projects');
  const projectStore = {
    list: () => [project],
    get: () => project,
    activeForLeftPanel: () => [project],
    onUpdate: () => () => {},
    refresh: () => {},
  } as never;
  const projectManager = {
    setStatus: vi.fn(),
    undoStatus: vi.fn(),
    create: vi.fn(),
  } as never;
  const panel = new CenterPanel(
    state,
    {} as App,
    settings,
    queries,
    new StatusRegistry(settings.taskStatuses),
    undefined,
    projectStore,
    projectManager,
    application,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    [workspaceSnapshot(project, actions, workNotes)],
    workNoteCommands,
  );
  panel.setProjectSnapshots([workspaceSnapshot(project, actions, workNotes)]);
  const root = freshContainer();
  root.addClass('abyss-test-center-attached');
  mounted.push(root);
  activeDocument.body.append(root);
  panel.mount(root);
  return {
    panel,
    state,
    root,
    tasks,
    actions,
    execute,
    update(nextActions) {
      currentTasks = nextActions.map(({ task: candidate }) => candidate);
      panel.setProjectSnapshots([workspaceSnapshot(project, nextActions, workNotes)]);
      panel.refresh();
    },
  };
}

function cardFor(root: HTMLElement, taskSnapshot: TaskSnapshot): HTMLElement | null {
  return (
    Array.from(root.querySelectorAll<HTMLElement>('.abyss-task-card')).find(
      (card) =>
        card.dataset['filePath'] === taskSnapshot.ref.filePath &&
        card.dataset['line'] === String(taskSnapshot.ref.line),
    ) ?? null
  );
}

function installMeasuredProjectScrollGeometry(initialViewport = 640): {
  setViewport(value: number): void;
  resizeOwner(owner: HTMLElement): boolean;
  resizeRow(key: string, height: number): boolean;
  ownerObserverCount(owner: HTMLElement): number;
  ownerObserverDisconnected(owner: HTMLElement): boolean;
  disconnectedCount(): number;
  scrollAssignments(owner: HTMLElement): readonly number[];
} {
  let viewport = initialViewport;
  let disconnects = 0;
  const scrollOffsets = new WeakMap<HTMLElement, number>();
  const scrollAssignments = new WeakMap<HTMLElement, number[]>();
  const measuredRows = new Map<string, number>();
  const observers = new Set<{
    readonly callback: ResizeObserverCallback;
    readonly targets: Set<Element>;
    readonly observed: Set<Element>;
    disconnected: boolean;
  }>();
  class ControlledResizeObserver implements ResizeObserver {
    private readonly record: {
      readonly callback: ResizeObserverCallback;
      readonly targets: Set<Element>;
      readonly observed: Set<Element>;
      disconnected: boolean;
    };

    constructor(callback: ResizeObserverCallback) {
      this.record = {
        callback,
        targets: new Set(),
        observed: new Set(),
        disconnected: false,
      };
      observers.add(this.record);
    }

    observe(target: Element): void {
      this.record.targets.add(target);
      this.record.observed.add(target);
    }

    unobserve(target: Element): void {
      this.record.targets.delete(target);
    }

    disconnect(): void {
      this.record.disconnected = true;
      this.record.targets.clear();
      disconnects += 1;
    }
  }
  vi.stubGlobal('ResizeObserver', ControlledResizeObserver);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ): DOMRect {
    const key = this.dataset['virtualRowKey'];
    const height = key
      ? (measuredRows.get(key) ?? (this.dataset['virtualRowKind'] === 'group-header' ? 36 : 56))
      : 0;
    return {
      x: 0,
      y: 0,
      width: 800,
      height,
      top: 0,
      right: 800,
      bottom: height,
      left: 0,
      toJSON: () => ({}),
    };
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ): number {
    return this.classList.contains('abyss-project-tasks-scroll') ? viewport : 48;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ): number {
    if (!this.classList.contains('abyss-project-tasks-scroll')) return 48;
    const spacers = Array.from(this.querySelectorAll<HTMLElement>('[data-virtual-spacer]')).reduce(
      (sum, spacer) => sum + Number.parseFloat(spacer.style.height || '0'),
      0,
    );
    const rows = Array.from(this.querySelectorAll<HTMLElement>('[data-virtual-row-key]')).reduce(
      (sum, row) => sum + row.getBoundingClientRect().height,
      0,
    );
    return spacers + rows;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(function (
    this: HTMLElement,
  ): number {
    return scrollOffsets.get(this) ?? 0;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(function (
    this: HTMLElement,
    value: number,
  ): void {
    const maximum = Math.max(0, this.scrollHeight - this.clientHeight);
    const applied = Math.max(0, Math.min(value, maximum));
    scrollOffsets.set(this, applied);
    const assignments = scrollAssignments.get(this) ?? [];
    assignments.push(applied);
    scrollAssignments.set(this, assignments);
  });
  return {
    setViewport(value) {
      viewport = value;
    },
    resizeOwner(owner) {
      let delivered = false;
      for (const observer of observers) {
        if (!observer.targets.has(owner)) continue;
        delivered = true;
        observer.callback(
          [
            {
              target: owner,
              contentRect: owner.getBoundingClientRect(),
            } as unknown as ResizeObserverEntry,
          ],
          {} as ResizeObserver,
        );
      }
      return delivered;
    },
    resizeRow(key, height) {
      measuredRows.set(key, height);
      let delivered = false;
      for (const observer of observers) {
        const target = [...observer.targets].find(
          (candidate) =>
            candidate instanceof HTMLElement && candidate.dataset['virtualRowKey'] === key,
        );
        if (!target) continue;
        delivered = true;
        observer.callback(
          [
            {
              target,
              contentRect: target.getBoundingClientRect(),
            } as ResizeObserverEntry,
          ],
          {} as ResizeObserver,
        );
      }
      return delivered;
    },
    ownerObserverCount: (owner) =>
      [...observers].filter(({ targets }) => targets.has(owner)).length,
    ownerObserverDisconnected: (owner) =>
      [...observers].some(({ disconnected, observed }) => disconnected && observed.has(owner)),
    disconnectedCount: () => disconnects,
    scrollAssignments: (owner) => scrollAssignments.get(owner) ?? [],
  };
}

function click(target: HTMLElement, init: MouseEventInit = {}): void {
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
}

function key(target: HTMLElement, value: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: value,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

function projectTaskSession(panel: CenterPanel): ProjectTaskCollectionSession {
  return (
    panel as unknown as {
      readonly projectWorkspaceSession: { readonly tasks: ProjectTaskCollectionSession };
    }
  ).projectWorkspaceSession.tasks;
}

describe('Projects Tasks/List scale integration RED', () => {
  it('mounts a bounded grouped variable-height collection under one measured scroll owner', () => {
    installMeasuredProjectScrollGeometry();
    const { panel, root } = mountScaleProject({ groupBy: 'priority' });
    try {
      const owners = root.querySelectorAll<HTMLElement>(
        '[data-virtual-scroll-owner="project-tasks"]',
      );
      expect(owners).toHaveLength(1);
      const owner = owners[0]!;
      expect(owner.clientHeight).toBe(640);
      expect(owner.scrollHeight).toBeGreaterThan(owner.clientHeight);
      expect(owner.querySelectorAll('.abyss-task-card').length).toBeLessThanOrEqual(60);
      expect(
        owner.querySelectorAll('[data-virtual-row-kind="group-header"]').length,
      ).toBeGreaterThan(0);
      expect(root.querySelector('.abyss-add-task-bar')?.parentElement).not.toBe(owner);
    } finally {
      panel.destroy();
    }
  });

  it('keeps off-window range actions exact through the real bulk command path', async () => {
    installMeasuredProjectScrollGeometry();
    const { panel, root, tasks, actions, execute } = mountScaleProject({ forceOpen: true });
    const menuActions = new Map<string, () => void>();
    const makeMenu = (): Menu =>
      ({
        addItem(callback: (item: never) => unknown) {
          let title = '';
          const item = {
            dom: document.createElement('div'),
            setTitle(value: string) {
              title = value;
              return item;
            },
            setSection: () => item,
            setDisabled: () => item,
            setIcon: () => item,
            setChecked: () => item,
            onClick(handler: () => void) {
              menuActions.set(title, handler);
              return item;
            },
            setSubmenu: () => makeMenu(),
          };
          callback(item as never);
          return this;
        },
      }) as unknown as Menu;
    vi.spyOn(Menu.prototype, 'addItem').mockImplementation(function (this: Menu, callback) {
      makeMenu().addItem(callback);
      return this;
    });
    try {
      const owner = root.querySelector<HTMLElement>('.abyss-project-tasks-scroll')!;
      const first = cardFor(root, tasks[0]!)!;
      click(first, { ctrlKey: true });
      owner.scrollTop = 80 * 56;
      owner.dispatchEvent(new Event('scroll', { bubbles: false }));

      const target = cardFor(root, tasks[80]!);
      expect(cardFor(root, tasks[0]!)).toBeNull();
      expect(owner.querySelectorAll('.abyss-task-card').length).toBeLessThanOrEqual(60);
      expect(target).not.toBeNull();
      expect(
        target?.querySelector('.abyss-task-dependency-badge')?.getAttribute('aria-label'),
      ).toBe('Blocked by 1 prerequisite');
      click(target!, { shiftKey: true });
      expect(root.querySelector('.abyss-selection-live')?.textContent).toBe('81 tasks selected');
      expect(stateRef(root.ownerDocument.activeElement)).toEqual(tasks[80]!.ref);
      const selectedActions = projectTaskSession(panel).selectedActions();
      expect(selectedActions).toHaveLength(81);
      expect(selectedActions[80]!.task.ref).toEqual(tasks[80]!.ref);
      expect(selectedActions[80]!.dependency).toEqual({
        type: 'blocked',
        prerequisites: [tasks[0]!.ref],
      });
      expect(selectedActions[80]!.owner).toEqual({
        type: 'project',
        path: tasks[80]!.ref.filePath,
      });

      target!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      expect(menuActions.get('Done')).toBeDefined();
      menuActions.get('Done')!();
      await Promise.resolve();
      await Promise.resolve();

      const sentRefs = execute.mock.calls.map(
        ([command]) =>
          (command as { readonly target: { readonly ref: TaskSnapshot['ref'] } }).target.ref,
      );
      expect(sentRefs).toEqual(actions.slice(0, 81).map(({ task: candidate }) => candidate.ref));
      expect(new Set(sentRefs.map((ref) => ref.revision)).size).toBe(81);
    } finally {
      panel.destroy();
    }
  });

  it('keeps the real Project Task Board on the sole TaskRef collection authority through settlement and replacement', async () => {
    installMeasuredProjectScrollGeometry();
    const harness = mountScaleProject({ forceOpen: true });
    const { panel, root, tasks, actions, execute } = harness;
    const pending = deferred<TaskCommandResult>();
    execute.mockReturnValueOnce(pending.promise);
    try {
      click(root.querySelector<HTMLButtonElement>('[data-project-layout="board"]')!);
      const inspectedCard = cardFor(root, tasks[4]!)!;
      click(inspectedCard);
      const card = Array.from(
        root.querySelectorAll<HTMLElement>('.abyss-board .abyss-task-card'),
      ).find((candidate) => {
        const candidateRef = stateRef(candidate);
        return candidateRef !== null && candidateRef.line !== tasks[4]!.ref.line;
      })!;
      expect(card).toBeDefined();
      const targetTask = tasks.find(
        ({ ref }) => ref.filePath === stateRef(card)?.filePath && ref.line === stateRef(card)?.line,
      )!;
      const boardItem = card.closest<HTMLElement>('[data-board-item]')!;
      const semanticFocus = boardItem.querySelector<HTMLElement>('[data-board-item-focus]')!;
      click(card, { ctrlKey: true });
      semanticFocus.focus();

      const destination = Array.from(
        root.querySelectorAll<HTMLElement>('[data-board-column]'),
      ).find((column) =>
        column.querySelector('.abyss-board-column-label')?.textContent?.includes('In progress'),
      )!;
      boardItem.dispatchEvent(new Event('dragstart', { bubbles: true }));
      destination.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
      const updatedTask = { ...targetTask, status: 'in-progress' as const, statusSymbol: '/' };
      const updatedActions = actions.map((action) =>
        action.task.ref === targetTask.ref ? { ...action, task: updatedTask } : action,
      );
      pending.resolve({
        type: 'ok',
        changed: true,
        outcome: { type: 'task', task: updatedTask },
      });
      await flushMicrotasks();

      const session = projectTaskSession(panel);
      expect(session.isSelected(targetTask.ref)).toBe(true);
      expect(session.focusedRef()).toEqual(targetTask.ref);
      expect(session.inspectorRef()).toEqual(tasks[4]!.ref);
      expect(closestStateRef(root.ownerDocument.activeElement)).toEqual(targetTask.ref);
      expect(session.selectedActions().map(({ task: selected }) => selected.ref)).toEqual([
        targetTask.ref,
      ]);

      harness.update(updatedActions);
      expect(session.isSelected(updatedTask.ref)).toBe(true);
      expect(session.focusedRef()).toEqual(updatedTask.ref);
      expect(session.inspectorRef()).toEqual(tasks[4]!.ref);
      expect(closestStateRef(root.ownerDocument.activeElement)).toEqual(updatedTask.ref);
    } finally {
      panel.destroy();
    }
  });

  it('routes the real Project Task Timeline semantic focus through the same TaskRef authority', () => {
    installMeasuredProjectScrollGeometry();
    const { panel, root } = mountScaleProject({ forceOpen: true });
    try {
      click(root.querySelector<HTMLButtonElement>('[data-project-layout="timeline"]')!);
      const row = root.querySelector<HTMLElement>('.abyss-timeline-row:has(.abyss-task-card)')!;
      const ref = stateRef(row.querySelector('.abyss-task-card'))!;
      row.querySelector<HTMLElement>('[data-timeline-primary]')!.focus();

      expect(projectTaskSession(panel).focusedRef()).toEqual(ref);
      expect(projectTaskSession(panel).shouldRestoreFocus()).toBe(true);
      expect(
        (
          panel as unknown as {
            projectWorkspaceSession: { timelines: { tasks: { focusedKey: string | null } } };
          }
        ).projectWorkspaceSession.timelines.tasks.focusedKey,
      ).toBeNull();
    } finally {
      panel.destroy();
    }
  });

  it('executes a whole Task Timeline move as one atomic start-and-due patch', async () => {
    installMeasuredProjectScrollGeometry();
    const harness = mountScaleProject({ forceOpen: true });
    const original = harness.actions[0]!;
    const rangedTask: TaskSnapshot = {
      ...original.task,
      planning: { start: '2026-08-27' as never, due: '2026-08-29' as never },
    };
    harness.update([{ ...original, task: rangedTask }]);
    try {
      click(harness.root.querySelector<HTMLButtonElement>('[data-project-layout="timeline"]')!);
      const move = harness.root.querySelector<HTMLElement>('[data-timeline-target="range-move"]')!;

      key(move, 'ArrowRight');
      key(move, 'Enter');
      await flushMicrotasks();

      expect(harness.execute).toHaveBeenCalledOnce();
      expect(harness.execute).toHaveBeenCalledWith({
        type: 'patch',
        target: { type: 'task', ref: rangedTask.ref },
        patch: {
          start: { type: 'set', value: '2026-08-28' },
          due: { type: 'set', value: '2026-08-30' },
        },
      });
    } finally {
      harness.panel.destroy();
    }
  });

  it('renders the production Task Timeline as an agenda from its container width', () => {
    installMeasuredProjectScrollGeometry();
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
      this: HTMLElement,
    ): number {
      return this.classList.contains('abyss-project-tasks-content') ? 600 : 800;
    });
    const { panel, root } = mountScaleProject({ forceOpen: true });
    try {
      click(root.querySelector<HTMLButtonElement>('[data-project-layout="timeline"]')!);
      expect(root.querySelector('.abyss-timeline')?.classList).toContain('is-agenda');
      expect(root.querySelector('.abyss-timeline-axis')).toBeNull();
    } finally {
      panel.destroy();
    }
  });

  it('tears down the real Task owner before Work Notes without installing a local inspector listener', () => {
    const geometry = installMeasuredProjectScrollGeometry();
    const addListener = vi.spyOn(activeDocument, 'addEventListener');
    const { panel, root } = mountScaleProject({ forceOpen: true, withWorkNote: true });
    const outside = root.ownerDocument.createElement('button');
    root.ownerDocument.body.append(outside);
    try {
      const oldOwner = root.querySelector<HTMLElement>('.abyss-project-tasks-scroll')!;
      const pointerAddsBefore = addListener.mock.calls.length;
      click(root.querySelector<HTMLButtonElement>('[data-project-scope="work-notes"]')!);

      expect(oldOwner.isConnected).toBe(false);
      expect(geometry.ownerObserverDisconnected(oldOwner)).toBe(true);

      const workNotePointerListener = addListener.mock.calls
        .slice(pointerAddsBefore)
        .find(([type]) => type === 'pointerdown')?.[1];
      expect(workNotePointerListener).toBeUndefined();
      root.querySelector<HTMLButtonElement>('[data-work-note-identity-control]')!.click();
      const workspace = (
        panel as unknown as {
          projectWorkspaceSession: {
            workNotes: { inspectorPath: string | null };
          };
        }
      ).projectWorkspaceSession;
      expect(workspace.workNotes.inspectorPath).toBe('Work Notes/Scale note.md');

      click(root.querySelector<HTMLButtonElement>('[data-project-scope="tasks"]')!);
      expect(workspace.workNotes.inspectorPath).toBe('Work Notes/Scale note.md');
    } finally {
      outside.remove();
      panel.destroy();
    }
  });

  it('moves Arrow Home End and Page across remount boundaries with one semantic focus target', () => {
    installMeasuredProjectScrollGeometry();
    const { panel, root, state, tasks } = mountScaleProject({ forceOpen: true });
    try {
      const owner = root.querySelector<HTMLElement>('.abyss-project-tasks-scroll')!;
      const first = cardFor(root, tasks[0]!)!;
      click(first);
      first.focus();

      const end = key(first, 'End');
      expect(end.defaultPrevented).toBe(true);
      expect(cardFor(root, tasks[0]!)).toBeNull();
      const finalTask = tasks[tasks.length - 1]!;
      const last = cardFor(root, finalTask)!;
      expect(last).not.toBeNull();
      expect(stateRef(root.ownerDocument.activeElement)).toEqual(finalTask.ref);
      expect(owner.scrollTop).toBeGreaterThan(0);
      expect(root.querySelectorAll('.abyss-task-card[tabindex="0"]')).toHaveLength(1);
      expect((state.get('taskStack')[0] as TaskSnapshot | undefined)?.ref).toEqual(finalTask.ref);

      const home = key(last, 'Home');
      expect(home.defaultPrevented).toBe(true);
      expect(stateRef(root.ownerDocument.activeElement)).toEqual(tasks[0]!.ref);
      expect(owner.scrollTop).toBe(0);

      const page = key(root.ownerDocument.activeElement as HTMLElement, 'PageDown');
      expect(page.defaultPrevented).toBe(true);
      const afterPage = stateRef(root.ownerDocument.activeElement);
      expect(afterPage).not.toEqual(tasks[0]!.ref);
      const arrow = key(root.ownerDocument.activeElement as HTMLElement, 'ArrowDown');
      expect(arrow.defaultPrevented).toBe(true);
      expect(stateRef(root.ownerDocument.activeElement)).not.toEqual(afterPage);
      expect(root.querySelectorAll('.abyss-task-card[tabindex="0"]')).toHaveLength(1);
    } finally {
      panel.destroy();
    }
  });

  it('clears a removed duplicate-title inspector, retargets focus, and announces once', () => {
    installMeasuredProjectScrollGeometry();
    const harness = mountScaleProject({ forceOpen: true });
    const { panel, root, state, tasks, actions } = harness;
    try {
      const duplicates = tasks.filter(({ title }) => title === 'Repeated title');
      expect(duplicates.length).toBeGreaterThan(2);
      const focused = duplicates[1]!;
      const sameTitleSurvivor = duplicates[2]!;
      const beforeOrder = projectTaskSession(panel).orderedActions();
      const logicalIndex = beforeOrder.findIndex(
        ({ task: candidate }) => candidate.ref === focused.ref,
      );
      const owner = root.querySelector<HTMLElement>('.abyss-project-tasks-scroll')!;
      owner.scrollTop = logicalIndex * 56;
      owner.dispatchEvent(new Event('scroll'));
      const card = cardFor(root, focused)!;
      click(card);
      card.focus();
      expect((state.get('taskStack')[0] as TaskSnapshot).ref).toEqual(focused.ref);
      expect(sameTitleSurvivor.ref).not.toEqual(focused.ref);

      const live = root.querySelector<HTMLElement>('.abyss-selection-live')!;
      const observer = new MutationObserver(() => undefined);
      observer.observe(live, { childList: true, characterData: true, subtree: true });
      const remaining = actions.filter(({ task: candidate }) => candidate.ref !== focused.ref);
      harness.update(remaining);

      expect(state.get('taskStack')).toEqual([]);
      expect(projectTaskSession(panel).inspectorRef()).toBeNull();
      const afterOrder = projectTaskSession(panel).orderedActions();
      expect(projectTaskSession(panel).focusedRef()).toEqual(
        afterOrder[Math.min(logicalIndex, afterOrder.length - 1)]!.task.ref,
      );
      expect(stateRef(root.ownerDocument.activeElement)).toEqual(
        projectTaskSession(panel).focusedRef(),
      );
      expect(live.textContent).toBe('Focused task is no longer available');
      expect(observer.takeRecords()).toHaveLength(1);

      harness.update(remaining);
      expect(observer.takeRecords()).toHaveLength(0);
      observer.disconnect();
    } finally {
      panel.destroy();
    }
  });

  it('does not restore Project task focus after an intentional external blur', () => {
    installMeasuredProjectScrollGeometry();
    const { panel, root, tasks, actions, update } = mountScaleProject({ forceOpen: true });
    const outside = root.ownerDocument.createElement('button');
    root.ownerDocument.body.append(outside);
    try {
      const owner = root.querySelector<HTMLElement>('.abyss-project-tasks-scroll')!;
      const first = cardFor(root, tasks[0]!)!;
      click(first);
      first.focus();
      outside.focus();
      owner.scrollTop = 80 * 56;
      owner.dispatchEvent(new Event('scroll'));
      expect(cardFor(root, tasks[0]!)).toBeNull();

      update(actions);

      expect(root.ownerDocument.activeElement).toBe(outside);
      expect(projectTaskSession(panel).shouldRestoreFocus()).toBe(false);
    } finally {
      outside.remove();
      panel.destroy();
    }
  });

  it('restores an owned unique Project task focus across an unchanged full rerender', () => {
    installMeasuredProjectScrollGeometry();
    const { panel, root, tasks, actions, update } = mountScaleProject({ forceOpen: true });
    try {
      let owner = root.querySelector<HTMLElement>('.abyss-project-tasks-scroll')!;
      owner.scrollTop = 80 * 56;
      owner.dispatchEvent(new Event('scroll'));
      const target = cardFor(root, tasks[80]!)!;
      click(target);
      target.focus();
      expect(stateRef(root.ownerDocument.activeElement)).toEqual(tasks[80]!.ref);

      update(actions);
      owner = root.querySelector<HTMLElement>('.abyss-project-tasks-scroll')!;

      expect(cardFor(root, tasks[80]!)).not.toBeNull();
      expect(stateRef(root.ownerDocument.activeElement)).toEqual(tasks[80]!.ref);
      expect(owner.querySelectorAll('.abyss-task-card[tabindex="0"]')).toHaveLength(1);
      expect(projectTaskSession(panel).shouldRestoreFocus()).toBe(true);
    } finally {
      panel.destroy();
    }
  });

  it('adopts external Project inspector open and close through the collection session', () => {
    installMeasuredProjectScrollGeometry();
    const { panel, root, state, tasks } = mountScaleProject({ forceOpen: true });
    try {
      state.set('taskStack', [tasks[80]!]);

      expect(projectTaskSession(panel).inspectorRef()).toEqual(tasks[80]!.ref);
      expect(stateRef(root.ownerDocument.activeElement)).toEqual(tasks[80]!.ref);
      expect(cardFor(root, tasks[80]!)).not.toBeNull();

      state.set('taskStack', []);
      expect(projectTaskSession(panel).inspectorRef()).toBeNull();
    } finally {
      panel.destroy();
    }
  });

  it('does not leak ordinary Tasks multi-selection into a Project single-card context menu', () => {
    installMeasuredProjectScrollGeometry();
    const { panel, root, state } = mountScaleProject({ forceOpen: true });
    const titles: string[] = [];
    const makeMenu = (): Menu =>
      ({
        addItem(callback: (item: never) => unknown) {
          const item = {
            dom: document.createElement('div'),
            setTitle(value: string) {
              titles.push(value);
              return item;
            },
            setSection: () => item,
            setDisabled: () => item,
            setIcon: () => item,
            setChecked: () => item,
            onClick: () => item,
            setSubmenu: () => makeMenu(),
          };
          callback(item as never);
          return this;
        },
      }) as unknown as Menu;
    vi.spyOn(Menu.prototype, 'addItem').mockImplementation(function (this: Menu, callback) {
      makeMenu().addItem(callback);
      return this;
    });
    try {
      state.set('selectedList', 'inbox');
      state.set('mode', 'tasks');
      const ordinaryCards = Array.from(root.querySelectorAll<HTMLElement>('.abyss-task-card'));
      expect(ordinaryCards.length).toBeGreaterThan(2);
      click(ordinaryCards[0]!, { ctrlKey: true });
      click(ordinaryCards[1]!, { ctrlKey: true });
      expect(root.querySelector('.abyss-selection-live')?.textContent).toBe('2 tasks selected');

      state.set('mode', 'projects');
      const projectCard = root.querySelector<HTMLElement>(
        '.abyss-project-tasks-scroll .abyss-task-card',
      )!;
      projectCard.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));

      expect(titles.some((title) => title.endsWith('tasks selected'))).toBe(false);
      expect(titles).toContain('Today');
    } finally {
      panel.destroy();
    }
  });

  it('seeds deep restore before scroll, then preserves the first visible row across remeasure and resize', () => {
    const geometry = installMeasuredProjectScrollGeometry();
    const harness = mountScaleProject({ forceOpen: true });
    const { panel, root, actions, update } = harness;
    try {
      let owner = root.querySelector<HTMLElement>('.abyss-project-tasks-scroll')!;
      owner.scrollTop = 80 * 56;
      owner.dispatchEvent(new Event('scroll'));
      const firstVisible = owner.dataset['virtualFirstVisible'];
      expect(firstVisible).toBeTruthy();

      const expandedAbove = actions.map((action, index) =>
        index === 70
          ? {
              ...action,
              task: {
                ...action.task,
                description: 'Expanded above the viewport after the initial measurement.',
              },
            }
          : action,
      );
      update(expandedAbove);
      owner = root.querySelector<HTMLElement>('.abyss-project-tasks-scroll')!;

      expect(owner.scrollHeight).toBeGreaterThan(owner.scrollTop + owner.clientHeight);
      expect(owner.scrollTop).toBeGreaterThan(0);
      expect(owner.dataset['virtualFirstVisible']).toBe(firstVisible);

      const mountedAbove = Array.from(
        owner.querySelectorAll<HTMLElement>('[data-virtual-row-key]'),
      ).find((row) => row.dataset['virtualRowKey'] !== firstVisible);
      expect(mountedAbove).toBeDefined();
      const keyAbove = mountedAbove!.dataset['virtualRowKey']!;
      const beforeResize = owner.scrollTop;
      expect(geometry.resizeRow(keyAbove, mountedAbove!.getBoundingClientRect().height + 64)).toBe(
        true,
      );
      expect(owner.scrollTop).toBe(beforeResize + 64);
      expect(owner.dataset['virtualFirstVisible']).toBe(firstVisible);

      const compensatedScroll = owner.scrollTop;
      update(expandedAbove);
      owner = root.querySelector<HTMLElement>('.abyss-project-tasks-scroll')!;
      expect(owner.dataset['virtualFirstVisible']).toBe(firstVisible);
      expect(owner.scrollTop).toBe(compensatedScroll);
      expect(geometry.scrollAssignments(owner).find((value) => value > 0)).toBe(compensatedScroll);

      geometry.setViewport(420);
      owner.ownerDocument.defaultView!.dispatchEvent(new Event('resize'));
      expect(owner.clientHeight).toBe(420);
      expect(owner.dataset['virtualFirstVisible']).toBe(firstVisible);
    } finally {
      panel.destroy();
    }
    expect(geometry.disconnectedCount()).toBeGreaterThan(0);
  });

  it('recomputes the bounded Task range from one owner-scoped resize observer', () => {
    const geometry = installMeasuredProjectScrollGeometry(640);
    const { panel, root } = mountScaleProject({ forceOpen: true });
    const owner = root.querySelector<HTMLElement>('.abyss-project-tasks-scroll')!;
    try {
      owner.scrollTop = 80 * 56;
      owner.dispatchEvent(new Event('scroll'));
      const firstVisible = owner.dataset['virtualFirstVisible'];
      const beforeCount = owner.querySelectorAll('.abyss-task-card').length;
      expect(geometry.ownerObserverCount(owner)).toBe(1);

      geometry.setViewport(280);
      expect(geometry.resizeOwner(owner)).toBe(true);
      expect(owner.dataset['virtualFirstVisible']).toBe(firstVisible);
      expect(owner.querySelectorAll('.abyss-task-card').length).toBeLessThan(beforeCount);
    } finally {
      panel.destroy();
    }
    expect(geometry.ownerObserverDisconnected(owner)).toBe(true);
  });
});

function stateRef(target: Element | null): TaskSnapshot['ref'] | null {
  if (!(target instanceof HTMLElement) || !target.classList.contains('abyss-task-card'))
    return null;
  const serialized = target.getAttribute('data-abyss-task-ref-key');
  if (!serialized) return null;
  const parsed = JSON.parse(serialized) as unknown;
  if (
    !Array.isArray(parsed) ||
    typeof parsed[0] !== 'string' ||
    !Number.isInteger(parsed[1]) ||
    typeof parsed[2] !== 'string'
  ) {
    return null;
  }
  return { filePath: parsed[0], line: parsed[1] as number, revision: parsed[2] };
}

function closestStateRef(target: Element | null): TaskSnapshot['ref'] | null {
  if (!(target instanceof HTMLElement)) return null;
  return stateRef(target.closest<HTMLElement>('[data-abyss-task-ref-key]'));
}
