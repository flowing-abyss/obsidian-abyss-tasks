import { Menu, setIcon } from 'obsidian';
import { selectProjectTasks } from '../../projects/selectProjectTasks';
import type { ProjectWorkspaceSnapshot } from '../../projects/types';
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
  const selectedTasks = selectProjectTasks({
    actions: snapshot.tasks,
    viewState: ctx.settings.projects.view.tasks,
    settings: ctx.settings,
  });
  const allWorkNotes = [...snapshot.workNotes, ...snapshot.milestones];
  const selectedWorkNotes = ctx.selectWorkNotes?.(allWorkNotes) ?? allWorkNotes;
  const workNotesAvailable =
    ctx.workNotesAvailable ?? (allWorkNotes.length > 0 || ctx.renderWorkNotes !== undefined);

  const statuses = ctx.settings.projects.statuses;
  const status = project.statusId ? statuses.find((s) => s.id === project.statusId) : undefined;

  const header = container.createDiv({ cls: 'abyss-project-dashboard-header' });
  header.createEl('h2', { cls: 'abyss-project-dashboard-title', text: project.name });

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
    layout = 'list';
    session.scope = scope;
    session.layout = layout;
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
      child = ctx.renderTaskTimeline(content, project.path, selectedTasks);
    } else if (layout === 'board' && ctx.renderTaskBoard) {
      child = ctx.renderTaskBoard(content, project.path, selectedTasks);
    } else {
      child = ctx.renderTasks(content, project.path, selectedTasks);
    }
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
        layout = 'list';
        session.scope = scope;
        session.layout = layout;
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
      child?.destroy();
      child = null;
      container.empty();
    },
  };
}
