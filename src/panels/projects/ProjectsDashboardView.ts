import { Menu, setIcon } from 'obsidian';
import { selectProjectTasks } from '../../projects/selectProjectTasks';
import type { ProjectWorkspaceSnapshot } from '../../projects/types';
import {
  deriveInspectorSelection,
  inspectorSelectionKey,
} from '../../ui/inspector/InspectorSelection';
import { showMenuAtMouseEventWithFocus } from '../../ui/nativeMenuFocus';
import { projectStatusMenuModel } from './boardProjection';
import { renderProgressBar } from './progressBar';
import { ProjectWorkspaceSession } from './ProjectWorkspaceSession';
import { taskTimelineItem, workNoteTimelineItem } from './timelineProjection';
import {
  joinedNextAction,
  type ProjectChildRenderHandle,
  type ProjectsDashboardContext,
} from './viewContext';

export type ProjectWorkspaceScope = 'tasks' | 'work-notes';
export type ProjectWorkspaceLayout = 'list' | 'board' | 'timeline';

/** Detail view for a single project: header, stats, description, its tasks. */
export function renderProjectDashboard(
  container: HTMLElement,
  snapshot: ProjectWorkspaceSnapshot | undefined,
  ctx: ProjectsDashboardContext,
): ProjectChildRenderHandle {
  container.addClass('abyss-projects-dashboard');

  const back = container.createEl('button', { cls: 'abyss-project-back' });
  setIcon(back, 'arrow-left');
  back.createSpan({ text: 'Back to projects' });
  back.addEventListener('click', () => ctx.state.set('projectsPanel', { view: 'list' }));

  if (!snapshot) {
    container.createDiv({ cls: 'abyss-projects-empty', text: 'Project not found' });
    return { destroy: () => container.empty() };
  }
  const project = snapshot.project;
  const session = ctx.workspaceSession ?? new ProjectWorkspaceSession();
  session.openProject(project.path);
  const taskScope = session.scopeSession('tasks');
  const workNotesScope = session.scopeSession('work-notes');
  const taskViewState = taskScope.effectiveView(ctx.settings.projects.view.tasks);
  const workNotesViewState = workNotesScope.effectiveView(ctx.settings.projects.view.workNotes);
  const selectedTasks = selectProjectTasks({
    actions: snapshot.tasks,
    viewState: taskViewState,
    settings: ctx.settings,
    ...(taskScope.textQuery && { textQuery: taskScope.textQuery }),
  });
  const allWorkNotes = [...snapshot.workNotes, ...snapshot.milestones];
  const selectedWorkNotes =
    ctx.selectWorkNotes?.(allWorkNotes, workNotesViewState, workNotesScope.textQuery) ??
    allWorkNotes;
  const workNotesAvailable =
    ctx.workNotesAvailable ?? (allWorkNotes.length > 0 || ctx.renderWorkNotes !== undefined);
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

  const header = container.createDiv({ cls: 'abyss-project-dashboard-header' });
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

  const open = header.createEl('button', {
    cls: 'abyss-project-open-btn',
    attr: { 'aria-label': 'Open note' },
  });
  setIcon(open, 'file-text');
  open.addEventListener('click', () => ctx.openNote(project.path));

  const stats = container.createDiv({ cls: 'abyss-project-dashboard-stats' });
  renderProgressBar(
    stats,
    snapshot.taskRollup.done,
    snapshot.taskRollup.total,
    `${project.name} task progress`,
  );
  const nextAction = joinedNextAction(snapshot.tasks);
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
    next.addEventListener('click', () => ctx.state.set('taskStack', [nextAction.task]));
  }

  const rawDesc = project.frontmatter['description'];
  const desc = typeof rawDesc === 'string' ? rawDesc.trim() : '';
  if (desc) {
    container.createDiv({ cls: 'abyss-project-description', text: desc });
  }

  let scope: ProjectWorkspaceScope = session.scope;
  let layout: ProjectWorkspaceLayout = session.layout;
  if (scope === 'work-notes' && !workNotesAvailable) {
    scope = 'tasks';
    session.scope = scope;
    layout = session.layout;
  }
  const workspace = container.createDiv({
    cls: 'abyss-project-tasks',
    attr: { 'data-project-workspace': '' },
  });
  const workspaceTitle = workspace.createEl('h3', {
    cls: 'abyss-project-tasks-title',
    text: scope === 'work-notes' ? 'Work Notes' : 'Tasks',
  });
  const toolbar = workspace.createDiv({ cls: 'abyss-project-workspace-toolbar' });
  const content = workspace.createDiv({ cls: 'abyss-project-tasks-content' });
  const scopeButtons: HTMLButtonElement[] = [];
  const layoutButtons: HTMLButtonElement[] = [];
  const boardAvailable = (): boolean =>
    scope === 'tasks' ? ctx.renderTaskBoard !== undefined : ctx.renderWorkNoteBoard !== undefined;
  const timelineAvailable = (): boolean =>
    scope === 'tasks'
      ? ctx.renderTaskTimeline !== undefined &&
        selectedTasks.some(({ task }) => taskTimelineItem(task).kind !== 'undated')
      : ctx.renderWorkNoteTimeline !== undefined &&
        selectedWorkNotes.some((note) => workNoteTimelineItem(note).kind !== 'undated');
  let syncTimelineButton = (): void => undefined;
  let child: ProjectChildRenderHandle | null = null;
  let destroyed = false;
  let arbitrationVersion = 0;

  const publishEffectiveInspector = (): void => {
    const version = ++arbitrationVersion;
    queueMicrotask(() => {
      if (destroyed || version !== arbitrationVersion) return;
      const rememberedTask = session.tasks.inspectorRef();
      const visibleTask = rememberedTask
        ? selectedTasks.find(
            ({ task }) =>
              task.ref.filePath === rememberedTask.filePath &&
              task.ref.line === rememberedTask.line &&
              task.ref.revision === rememberedTask.revision,
          )
        : undefined;
      const rememberedWorkNotePath = session.scopeSession('work-notes').selection.inspectorKey;
      const visibleWorkNote = rememberedWorkNotePath
        ? selectedWorkNotes.find(({ path }) => path === rememberedWorkNotePath)
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
    workspace.dataset['scope'] = scope;
    workspace.dataset['layout'] = layout;
    workspaceTitle.setText(scope === 'work-notes' ? 'Work Notes' : 'Tasks');
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
        child = ctx.renderWorkNoteTimeline(content, project.path, selectedWorkNotes);
      } else if (layout === 'board' && ctx.renderWorkNoteBoard) {
        child = ctx.renderWorkNoteBoard(content, project.path, selectedWorkNotes);
      } else {
        child = ctx.renderWorkNotes?.(content, project.path, selectedWorkNotes) ?? null;
      }
    } else if (layout === 'timeline' && ctx.renderTaskTimeline) {
      child = ctx.renderTaskTimeline(content, project.path, selectedTasks, taskViewState);
    } else if (layout === 'board' && ctx.renderTaskBoard) {
      child = ctx.renderTaskBoard(content, project.path, selectedTasks, taskViewState);
    } else {
      child = ctx.renderTasks(content, project.path, selectedTasks, taskViewState);
    }
    publishEffectiveInspector();
  };

  const scopeButton = (value: ProjectWorkspaceScope, label: string, selectable = true): void => {
    const button = toolbar.createEl('button', {
      text: label,
      attr: { type: 'button', 'data-project-scope': value },
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
  const layoutButton = (value: ProjectWorkspaceLayout, label: string, selectable = true): void => {
    const button = toolbar.createEl('button', {
      text: label,
      attr: { type: 'button', 'data-project-layout': value },
    });
    button.disabled = !selectable;
    button.setAttribute('aria-disabled', String(!selectable));
    if (selectable) {
      button.addEventListener('click', () => {
        layout = value;
        session.layout = layout;
        renderWorkspace();
      });
    }
    layoutButtons.push(button);
  };

  scopeButton('tasks', 'Tasks');
  if (workNotesAvailable) {
    scopeButton('work-notes', 'Work Notes', ctx.renderWorkNotes !== undefined);
  }
  const useAsDefault = toolbar.createEl('button', {
    text: 'Use as default',
    attr: { type: 'button', 'data-project-use-as-default': '' },
  });
  useAsDefault.addEventListener('click', () => {
    session.requestUseAsDefault(scope);
    const intent = session.consumeUseAsDefaultIntent();
    if (intent) ctx.onUseWorkspaceDefault?.(intent);
  });
  layoutButton('list', 'List');
  if (
    snapshot.tasks.length > 0 ||
    ctx.renderTaskBoard !== undefined ||
    ctx.renderWorkNoteBoard !== undefined
  ) {
    const button = toolbar.createEl('button', {
      text: 'Board',
      attr: { type: 'button', 'data-project-layout': 'board' },
    });
    button.disabled = !boardAvailable();
    button.setAttribute('aria-disabled', String(button.disabled));
    button.addEventListener('click', () => {
      if (!boardAvailable()) return;
      layout = 'board';
      session.layout = layout;
      renderWorkspace();
    });
    layoutButtons.push(button);
  }
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
    timelineButton = toolbar.createEl('button', {
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
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      arbitrationVersion += 1;
      child?.destroy();
      child = null;
      container.empty();
    },
  };
}
