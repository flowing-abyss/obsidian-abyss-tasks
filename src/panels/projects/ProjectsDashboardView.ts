import { Menu, Notice, setIcon } from 'obsidian';
import {
  projectHealthProjection,
  type ProjectHealthProjection,
} from '../../projects/ProjectHealthProjection';
import { selectProjectTasks } from '../../projects/selectProjectTasks';
import type { ProjectWorkspaceSnapshot } from '../../projects/types';
import type {
  ProjectTasksViewState,
  PropertyFilter,
  WorkNotesViewState,
} from '../../settings/types';
import { renderCollectionControls } from '../../ui/collection/CollectionControls';
import {
  deriveInspectorSelection,
  inspectorSelectionKey,
} from '../../ui/inspector/InspectorSelection';
import { showMenuAtMouseEventWithFocus } from '../../ui/nativeMenuFocus';
import { projectStatusMenuModel } from './boardProjection';
import { renderProgressBar } from './progressBar';
import { ProjectWorkspaceSession } from './ProjectWorkspaceSession';
import { taskTimelineItem } from './timelineProjection';
import {
  joinedNextAction,
  type ProjectChildRenderHandle,
  type ProjectsDashboardContext,
} from './viewContext';

export type ProjectWorkspaceScope = 'tasks' | 'work-notes';
export type ProjectWorkspaceLayout = 'list' | 'board' | 'timeline';

function reportPreferenceError(error: unknown): void {
  const conflict = error instanceof Error && error.name === 'CollectionPreferenceConflictError';
  new Notice(
    conflict
      ? 'Project collection changed elsewhere. Your change was not saved; review the settled view.'
      : 'Project collection preference was not saved. Nothing changed; try again.',
  );
}

function currentLocalDate(): string {
  const now = new Date();
  return `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function healthReason(health: ProjectHealthProjection): string {
  switch (health.reason.type) {
    case 'overdue-next-action':
      return 'Next action overdue';
    case 'blocked-critical-path':
      return 'Critical path blocked';
    case 'overdue-actionable-work':
      return 'Actionable work overdue';
    case 'blocked-next-action':
      return 'Next action blocked';
    case 'unblocked-next-action':
      return 'Next action ready';
    case 'insufficient-actionable-evidence':
      return 'No actionable next action';
  }
}

function compactDate(health: ProjectHealthProjection): string | undefined {
  const raw = health.date?.value;
  if (!raw) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(raw);
  if (!match) return undefined;
  const instant = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(instant);
}

function propertyFilterIdentity(filter: PropertyFilter): string {
  return filter.type === 'file'
    ? `${filter.type}:${filter.filePath}`
    : `${filter.type}:${filter.value}`;
}

/** Detail view for a single project: header, stats, description, its tasks. */
export function renderProjectDashboard(
  container: HTMLElement,
  snapshot: ProjectWorkspaceSnapshot | undefined,
  ctx: ProjectsDashboardContext,
): ProjectChildRenderHandle {
  container.addClass('abyss-projects-dashboard');

  if (!snapshot) {
    const back = container.createEl('button', { cls: 'abyss-project-back' });
    setIcon(back, 'arrow-left');
    back.createSpan({ text: 'Back to projects' });
    back.addEventListener('click', () => ctx.state.set('projectsPanel', { view: 'list' }));
    container.createDiv({ cls: 'abyss-projects-empty', text: 'Project not found' });
    return { destroy: () => container.empty() };
  }
  const project = snapshot.project;
  const session = ctx.workspaceSession ?? new ProjectWorkspaceSession();
  session.bindCollectionPreferences(ctx.settings, ctx.onSaveSettings);
  session.openProject(project.path);
  const taskScope = session.scopeSession('tasks');
  const workNotesScope = session.scopeSession('work-notes');
  const allWorkNotes = [...snapshot.workNotes, ...snapshot.milestones];
  const workNotesAvailable =
    ctx.workNotesAvailable ?? (allWorkNotes.length > 0 || ctx.renderWorkNotes !== undefined);
  const workNotesAvailability =
    ctx.workNotesAvailability ?? ({ state: workNotesAvailable ? 'available' : 'hidden' } as const);
  const taskViewState = (): ProjectTasksViewState => session.collectionView(project.path, 'tasks');
  const workNotesViewState = (): WorkNotesViewState =>
    session.collectionView(project.path, 'work-notes');
  const selectedTasks = (): readonly (typeof snapshot.tasks)[number][] =>
    selectProjectTasks({
      actions: snapshot.tasks,
      viewState: taskViewState(),
      settings: ctx.settings,
      ...(taskScope.textQuery && { textQuery: taskScope.textQuery }),
    });
  const selectedWorkNotes = (): typeof allWorkNotes =>
    (ctx.selectWorkNotes?.(allWorkNotes, workNotesViewState(), workNotesScope.textQuery) ??
      allWorkNotes) as typeof allWorkNotes;
  const sameSelection = (
    left: ReturnType<typeof deriveInspectorSelection> | null,
    right: ReturnType<typeof deriveInspectorSelection>,
  ): boolean => {
    if (left?.type !== right.type) return false;
    if (left.type === 'project' && right.type === 'project') return left.path === right.path;
    if (left.type === 'work-note' && right.type === 'work-note') {
      return left.path === right.path && left.projectPath === right.projectPath;
    }
    return (
      left.type === 'task' &&
      right.type === 'task' &&
      left.task.filePath === right.task.filePath &&
      left.task.line === right.task.line &&
      left.task.revision === right.task.revision
    );
  };

  const statuses = ctx.settings.projects.statuses;
  const status = project.statusId ? statuses.find((s) => s.id === project.statusId) : undefined;

  const health = projectHealthProjection(snapshot, { today: ctx.today?.() ?? currentLocalDate() });
  const summary = container.createDiv({
    cls: 'abyss-project-dashboard-summary',
    attr: { 'data-project-summary': '' },
  });
  const header = summary.createDiv({
    cls: 'abyss-project-dashboard-header',
    attr: { 'data-project-summary-row': 'primary' },
  });
  const back = header.createEl('button', {
    cls: 'abyss-project-back',
    attr: { type: 'button', 'aria-label': 'Back to projects', title: 'Back to projects' },
  });
  setIcon(back, 'arrow-left');
  back.addEventListener('click', () => ctx.state.set('projectsPanel', { view: 'list' }));
  const inspect = header.createEl('button', {
    cls: 'abyss-project-dashboard-title',
    text: project.name,
    attr: { type: 'button', 'aria-label': `Open project details for ${project.name}` },
  });
  const projectInspectorSelection = { type: 'project' as const, path: project.path };
  inspect.dataset['inspectorOriginKey'] = inspectorSelectionKey(projectInspectorSelection);
  inspect.addEventListener('click', () =>
    ctx.state.batch(() => {
      if (session.scope === 'tasks') session.tasks.setInspector(null);
      else session.scopeSession('work-notes').selection.inspectorKey = null;
      ctx.state.set('inspectorSelection', projectInspectorSelection);
      ctx.state.set('inspectorOrigin', { selection: projectInspectorSelection, element: inspect });
    }),
  );

  header.createSpan({
    cls: `abyss-project-health abyss-project-health--${health.severity}`,
    attr: {
      role: 'img',
      title: healthReason(health),
      'aria-label': `Project health: ${health.severity}; ${healthReason(health)}`,
    },
  });

  const pill = header.createEl('button', {
    cls: 'abyss-status-pill',
    attr: { type: 'button', 'aria-label': 'Change project status', title: 'Change project status' },
  });
  if (status?.color) pill.style.setProperty('--abyss-project-status-accent', status.color);
  pill.setText(status?.label ?? project.rawStatus ?? 'No status');
  pill.addEventListener('click', (e) => {
    const menu = new Menu();
    for (const action of projectStatusMenuModel(statuses, project)) {
      menu.addItem((item) =>
        item
          .setTitle(action.label)
          .setIcon(action.icon)
          .setChecked(action.checked)
          .setDisabled(action.disabled)
          .onClick(() => ctx.onSetStatus(project.path, action.columnKey)),
      );
    }
    showMenuAtMouseEventWithFocus(menu, e);
  });

  if (project.priority && project.priority !== 'D') {
    header.createSpan({
      cls: 'abyss-project-priority',
      text: project.priority,
      attr: { 'data-priority': project.priority, 'aria-label': `Priority ${project.priority}` },
    });
  }

  const open = header.createEl('button', {
    cls: 'abyss-project-open-btn',
    attr: { 'aria-label': 'Open note' },
  });
  setIcon(open, 'file-text');
  open.addEventListener('click', () => ctx.openNote(project.path));

  const stats = summary.createDiv({
    cls: 'abyss-project-dashboard-stats',
    attr: { 'data-project-summary-row': 'secondary' },
  });
  renderProgressBar(
    stats,
    snapshot.taskRollup.done,
    snapshot.taskRollup.total,
    `${project.name} task progress`,
  );
  const nextAction = health.selectedNextAction ?? joinedNextAction(snapshot.tasks);
  if (nextAction) {
    /* eslint-disable obsidianmd/ui/sentence-case -- Next Action is a named planning concept. */
    const next = stats.createEl('button', {
      cls: 'abyss-project-next-action',
      attr: {
        type: 'button',
        'aria-label': 'Open Next Action',
        title: 'Open Next Action',
      },
    });
    /* eslint-enable obsidianmd/ui/sentence-case */
    setIcon(next, 'list-checks');
    next.addEventListener('click', () => {
      scope = 'tasks';
      session.scope = scope;
      layout = session.layout;
      renderWorkspace();
      if (!session.tasks.activate(nextAction.task.ref)) {
        session.tasks.reconcile(snapshot.tasks, snapshot.tasks);
        session.tasks.activate(nextAction.task.ref);
      }
      session.tasks.consumeEffect();
      const selection = deriveInspectorSelection({
        project: { type: 'project', path: project.path },
        activeScope: 'tasks',
        task: { type: 'task', task: nextAction.task.ref },
      });
      next.dataset['inspectorOriginKey'] = inspectorSelectionKey(selection);
      ctx.state.batch(() => {
        ctx.state.set('taskStack', [nextAction.task]);
        ctx.state.set('inspectorSelection', selection);
        ctx.state.set('inspectorOrigin', { selection, element: next });
      });
    });
    stats.createSpan({ cls: 'abyss-project-summary-next-title', text: nextAction.task.title });
  } else {
    stats.createSpan({
      cls: 'abyss-project-summary-reason',
      text: healthReason(health),
      attr: { 'data-project-summary-reason': '' },
    });
  }
  if (nextAction && (health.severity === 'off-track' || health.severity === 'at-risk')) {
    stats.createSpan({ cls: 'abyss-project-summary-risk', text: healthReason(health) });
  }
  const date = compactDate(health);
  if (date) stats.createSpan({ cls: 'abyss-project-date-signal', text: date });

  let scope: ProjectWorkspaceScope = session.scope;
  let layout: ProjectWorkspaceLayout = session.layout;
  if (scope === 'work-notes' && workNotesAvailability.state !== 'available') {
    scope = 'tasks';
    session.scope = scope;
    layout = session.layout;
  }
  const workspace = container.createDiv({
    cls: 'abyss-project-tasks',
    attr: { 'data-project-workspace': '' },
  });
  const scopeButtons: HTMLButtonElement[] = [];
  const layoutButtons: HTMLButtonElement[] = [];
  const boardAvailable = (): boolean =>
    scope === 'tasks' ? ctx.renderTaskBoard !== undefined : ctx.renderWorkNoteBoard !== undefined;
  const timelineAvailable = (): boolean =>
    scope === 'tasks'
      ? ctx.renderTaskTimeline !== undefined &&
        snapshot.tasks.some(({ task }) => taskTimelineItem(task).kind !== 'undated')
      : ctx.renderWorkNoteTimeline !== undefined && allWorkNotes.length > 0;
  let syncTimelineButton = (): void => undefined;
  let collectionControls: ReturnType<typeof renderCollectionControls> | null = null;
  let scopeGroup!: HTMLElement;
  let workspaceTitle!: HTMLElement;
  let child: ProjectChildRenderHandle | null = null;
  let destroyed = false;
  let arbitrationVersion = 0;

  const publishEffectiveInspector = (): void => {
    const version = ++arbitrationVersion;
    queueMicrotask(() => {
      if (destroyed || version !== arbitrationVersion) return;
      const rememberedTask = session.tasks.inspectorRef();
      const visibleTask = rememberedTask
        ? selectedTasks().find(
            ({ task }) =>
              task.ref.filePath === rememberedTask.filePath &&
              task.ref.line === rememberedTask.line &&
              task.ref.revision === rememberedTask.revision,
          )
        : undefined;
      const rememberedWorkNotePath = session.scopeSession('work-notes').selection.inspectorKey;
      const visibleWorkNote = rememberedWorkNotePath
        ? selectedWorkNotes().find(({ path }) => path === rememberedWorkNotePath)
        : undefined;
      const effective = deriveInspectorSelection({
        project: { type: 'project', path: project.path },
        activeScope: session.scope,
        ...(visibleTask && { task: { type: 'task', task: visibleTask.task.ref } as const }),
        ...(visibleWorkNote && {
          workNote: {
            type: 'work-note' as const,
            path: visibleWorkNote.path,
            projectPath: project.path,
          },
        }),
      });
      const key = inspectorSelectionKey(effective);
      const effectiveOrigin =
        Array.from(container.querySelectorAll<HTMLElement>('[data-inspector-origin-key]')).find(
          (candidate) => candidate.dataset['inspectorOriginKey'] === key,
        ) ?? inspect;
      const currentOrigin = ctx.state.get('inspectorOrigin');
      if (
        !sameSelection(ctx.state.get('inspectorSelection'), effective) ||
        !currentOrigin ||
        !sameSelection(currentOrigin.selection, effective) ||
        currentOrigin.element !== effectiveOrigin
      ) {
        ctx.state.batch(() => {
          ctx.state.set('inspectorSelection', effective);
          ctx.state.set('inspectorOrigin', { selection: effective, element: effectiveOrigin });
        });
      }
    });
  };

  const renderWorkspace = (): void => {
    if (destroyed) return;
    syncTimelineButton();
    if (collectionControls) {
      const input = collectionControls.searchInput;
      if (!input) return;
      const query = scope === 'tasks' ? taskScope.textQuery : workNotesScope.textQuery;
      input.value = query;
      input.setAttribute('aria-label', scope === 'tasks' ? 'Filter tasks' : 'Filter Work Notes');
    }
    workspace.dataset['scope'] = scope;
    workspace.dataset['layout'] = layout;
    workspaceTitle?.setText(scope === 'work-notes' ? 'Work Notes' : 'Tasks');
    for (const button of scopeButtons) {
      const active = button.dataset['projectScope'] === scope;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    for (const button of layoutButtons) {
      const active = button.dataset['projectLayout'] === layout;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
      if (button.dataset['projectLayout'] === 'board') {
        button.disabled = !boardAvailable();
        button.setAttribute('aria-disabled', String(button.disabled));
      } else if (button.dataset['projectLayout'] === 'timeline') {
        button.disabled = !timelineAvailable();
        button.setAttribute('aria-disabled', String(button.disabled));
      }
    }
    child?.destroy();
    child = null;
    content.empty();
    if (scope === 'work-notes') {
      if (layout === 'timeline' && ctx.renderWorkNoteTimeline) {
        child = ctx.renderWorkNoteTimeline(content, project.path, selectedWorkNotes());
      } else if (layout === 'board' && ctx.renderWorkNoteBoard) {
        child = ctx.renderWorkNoteBoard(content, project.path, selectedWorkNotes());
      } else {
        child =
          ctx.renderWorkNotes?.(content, project.path, selectedWorkNotes(), workNotesViewState()) ??
          null;
      }
    } else if (layout === 'timeline' && ctx.renderTaskTimeline) {
      child = ctx.renderTaskTimeline(
        content,
        project.path,
        selectedTasks(),
        taskViewState(),
        snapshot.tasks,
        addTaskFilter,
      );
    } else if (layout === 'board' && ctx.renderTaskBoard) {
      child = ctx.renderTaskBoard(
        content,
        project.path,
        selectedTasks(),
        taskViewState(),
        snapshot.tasks,
        addTaskFilter,
      );
    } else {
      child = ctx.renderTasks(
        content,
        project.path,
        selectedTasks(),
        taskViewState(),
        snapshot.tasks,
        addTaskFilter,
      );
    }
    publishEffectiveInspector();
  };

  const scopeButton = (
    value: ProjectWorkspaceScope,
    label: string,
    selectable = true,
    reason?: string,
  ): void => {
    const button = scopeGroup.createEl('button', {
      text: label,
      attr: {
        type: 'button',
        'data-project-scope': value,
        ...(reason ? { title: reason, 'aria-label': `${label}: ${reason}` } : {}),
      },
    });
    button.disabled = !selectable;
    button.setAttribute('aria-disabled', String(!selectable));
    if (selectable) {
      button.addEventListener('click', () => {
        scope = value;
        session.scope = scope;
        layout = session.layout;
        renderWorkspace();
      });
    }
    scopeButtons.push(button);
  };
  let layoutHost!: HTMLElement;
  const layoutButton = (value: ProjectWorkspaceLayout, label: string, selectable = true): void => {
    const button = layoutHost.createEl('button', {
      text: label,
      attr: { type: 'button', 'data-project-layout': value },
    });
    button.disabled = !selectable;
    button.setAttribute('aria-disabled', String(!selectable));
    if (selectable) {
      button.addEventListener('click', () => {
        void session
          .updateCollectionPreference(project.path, scope, (current) => ({
            ...current,
            layout: value,
          }))
          .then(() => {
            layout = value;
            renderWorkspace();
          })
          .catch(reportPreferenceError);
      });
    }
    layoutButtons.push(button);
  };

  const updateTaskView = (next: ProjectTasksViewState): void => {
    void session
      .updateCollectionPreference(project.path, 'tasks', (current) => {
        const layoutPreference = { ...current.layoutPreferences['primary'], table: next.table };
        if (next.statusGroups) layoutPreference.statusGroups = next.statusGroups;
        else delete layoutPreference.statusGroups;
        return {
          ...current,
          filters: [...next.filters],
          group: next.groupBy,
          sort: { ...next.sortBy },
          layoutPreferences: { ...current.layoutPreferences, primary: layoutPreference },
        };
      })
      .then(() => renderWorkspace())
      .catch(reportPreferenceError);
  };
  const addTaskFilter = (filter: PropertyFilter): void => {
    const current = taskViewState();
    const identity = propertyFilterIdentity(filter);
    if (current.filters.some((candidate) => propertyFilterIdentity(candidate) === identity)) return;
    updateTaskView({ ...current, filters: [...current.filters, filter] });
  };
  const updateWorkNotesView = (next: WorkNotesViewState): void => {
    void session
      .updateCollectionPreference(project.path, 'work-notes', (current) => ({
        ...current,
        filters: [...next.statusIds],
        group: next.groupBy,
        sort: { ...next.sortBy },
      }))
      .then(() => renderWorkspace())
      .catch(reportPreferenceError);
  };
  const showWorkspaceMenu = (menu: Menu, event: MouseEvent): void => {
    const trigger = event.currentTarget as HTMLButtonElement | null;
    trigger?.setAttribute('aria-expanded', 'true');
    menu.onHide(() => {
      if (!trigger) return;
      trigger.setAttribute('aria-expanded', 'false');
      if (trigger.isConnected) trigger.focus({ preventScroll: true });
    });
    showMenuAtMouseEventWithFocus(menu, event);
  };
  const showFilterMenu = (event: MouseEvent): void => {
    const menu = new Menu();
    if (scope === 'tasks') {
      menu.addItem((item) =>
        item
          .setTitle('Active')
          .onClick(() =>
            updateTaskView({ ...taskViewState(), statusGroups: ['todo', 'in-progress'] }),
          ),
      );
      menu.addItem((item) =>
        item.setTitle('All').onClick(() => {
          const next = { ...taskViewState() };
          delete next.statusGroups;
          updateTaskView(next);
        }),
      );
    } else {
      menu.addItem((item) =>
        item
          .setTitle('All')
          .onClick(() => updateWorkNotesView({ ...workNotesViewState(), statusIds: [] })),
      );
      for (const status of ctx.workNoteStatuses ?? []) {
        menu.addItem((item) =>
          item
            .setTitle(status.label)
            .setChecked(workNotesViewState().statusIds.includes(status.id))
            .onClick(() =>
              updateWorkNotesView({ ...workNotesViewState(), statusIds: [status.id] }),
            ),
        );
      }
    }
    showWorkspaceMenu(menu, event);
  };
  const showGroupMenu = (event: MouseEvent): void => {
    const menu = new Menu();
    const values =
      scope === 'tasks'
        ? (['none', 'date', 'priority', 'tag', 'status'] as const)
        : (['none', 'status', 'priority', 'milestone'] as const);
    for (const value of values) {
      menu.addItem((item) =>
        item
          .setTitle(value === 'none' ? 'None' : `${value[0]!.toUpperCase()}${value.slice(1)}`)
          .onClick(() => {
            if (scope === 'tasks')
              updateTaskView({
                ...taskViewState(),
                groupBy: value as ProjectTasksViewState['groupBy'],
              });
            else
              updateWorkNotesView({
                ...workNotesViewState(),
                groupBy: value as WorkNotesViewState['groupBy'],
              });
          }),
      );
    }
    showWorkspaceMenu(menu, event);
  };
  const showSortMenu = (event: MouseEvent): void => {
    const menu = new Menu();
    const fields =
      scope === 'tasks'
        ? (['date', 'priority', 'title', 'tag', 'status'] as const)
        : (['title', 'status', 'priority', 'start', 'end', 'updated'] as const);
    for (const field of fields) {
      menu.addItem((item) =>
        item.setTitle(`${field[0]!.toUpperCase()}${field.slice(1)}`).onClick(() => {
          if (scope === 'tasks') {
            const current = taskViewState().sortBy;
            updateTaskView({
              ...taskViewState(),
              sortBy: {
                field: field as ProjectTasksViewState['sortBy']['field'],
                dir: current.field === field && current.dir === 'asc' ? 'desc' : 'asc',
              },
            });
          } else {
            const current = workNotesViewState().sortBy;
            updateWorkNotesView({
              ...workNotesViewState(),
              sortBy: {
                field: field as WorkNotesViewState['sortBy']['field'],
                dir: current.field === field && current.dir === 'asc' ? 'desc' : 'asc',
              },
            });
          }
        }),
      );
    }
    showWorkspaceMenu(menu, event);
  };

  collectionControls = renderCollectionControls(workspace, {
    query: scope === 'tasks' ? taskScope.textQuery : workNotesScope.textQuery,
    searchLabel: scope === 'tasks' ? 'Filter tasks' : 'Filter Work Notes',
    toolbarLabel: 'Project collection controls',
    renderLeading: (host) => {
      scopeGroup = host.createDiv({
        cls: 'abyss-project-scope-controls',
        attr: { 'data-project-scope-controls': '', role: 'group', 'aria-label': 'Project scope' },
      });
      workspaceTitle = scopeGroup.createEl('h3', {
        cls: 'abyss-project-tasks-title',
        text: 'Tasks',
      });
      scopeButton('tasks', 'Tasks');
      if (workNotesAvailability.state === 'available') {
        scopeButton('work-notes', 'Work Notes', ctx.renderWorkNotes !== undefined);
      } else if (workNotesAvailability.state === 'invalid') {
        scopeButton('work-notes', 'Work Notes', false, workNotesAvailability.reason);
        const settings = scopeGroup.createEl('button', {
          text: 'Settings',
          attr: { type: 'button', 'data-work-notes-settings': '' },
        });
        settings.addEventListener('click', () => ctx.onOpenWorkNotesSettings?.());
      }
    },
    renderLayout: (host) => {
      layoutHost = host.createDiv({
        cls: 'abyss-project-layout-controls',
        attr: { role: 'group', 'aria-label': 'Collection layout' },
      });
      layoutButton('list', 'List');
      if (
        snapshot.tasks.length > 0 ||
        ctx.renderTaskBoard !== undefined ||
        ctx.renderWorkNoteBoard !== undefined
      ) {
        layoutButton('board', 'Board');
      }
    },
    actions: [
      { kind: 'filter', label: 'Filter', icon: 'list-filter', onActivate: showFilterMenu },
      { kind: 'group', label: 'Group', icon: 'layout-list', onActivate: showGroupMenu },
      { kind: 'sort', label: 'Sort', icon: 'arrow-up-down', onActivate: showSortMenu },
    ],
    onQueryInput: (value) => {
      if (scope === 'tasks') taskScope.textQuery = value;
      else workNotesScope.textQuery = value;
      renderWorkspace();
    },
    renderAdd: (host) => {
      const add = host.createEl('button', {
        cls: 'abyss-project-add',
        attr: {
          type: 'button',
          'data-project-add': '',
          'aria-label': 'Add item',
          title: 'Add item',
        },
      });
      setIcon(add, 'plus');
      add.addEventListener('click', () => {
        const selector =
          scope === 'tasks'
            ? '[data-project-task-capture], .abyss-add-task-trigger'
            : '[data-work-note-create], .abyss-work-note-create';
        content.querySelector<HTMLButtonElement>(selector)?.click();
      });
    },
  });
  for (const kind of ['filter', 'group', 'sort'] as const) {
    const trigger = collectionControls.element.querySelector<HTMLButtonElement>(
      `[data-collection-${kind}]`,
    );
    trigger?.setAttribute('aria-haspopup', 'menu');
    trigger?.setAttribute('aria-expanded', 'false');
  }
  const content = workspace.createDiv({ cls: 'abyss-project-tasks-content' });
  let timelineButton: HTMLButtonElement | null = null;
  syncTimelineButton = (): void => {
    if (!timelineAvailable()) {
      if (layout === 'timeline') {
        layout = 'list';
        session.layout = layout;
      }
      if (timelineButton) {
        const index = layoutButtons.indexOf(timelineButton);
        if (index >= 0) layoutButtons.splice(index, 1);
        timelineButton.remove();
        timelineButton = null;
      }
      return;
    }
    if (timelineButton) return;
    timelineButton = layoutHost.createEl('button', {
      text: 'Timeline',
      attr: { type: 'button', 'data-project-layout': 'timeline' },
    });
    timelineButton.addEventListener('click', () => {
      if (!timelineAvailable()) return;
      layout = 'timeline';
      session.layout = layout;
      renderWorkspace();
    });
    layoutButtons.push(timelineButton);
  };
  renderWorkspace();
  return {
    destroy: (releaseSession = true) => {
      if (destroyed) return;
      destroyed = true;
      arbitrationVersion += 1;
      child?.destroy();
      child = null;
      if (releaseSession) session.releaseCollectionSessions(project.path);
      container.empty();
    },
  };
}
