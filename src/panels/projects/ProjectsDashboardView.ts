import { Menu, setIcon } from 'obsidian';
import type { ProjectWorkspaceSnapshot } from '../../projects/types';
import { showMenuAtMouseEventWithFocus } from '../../ui/nativeMenuFocus';
import { renderProgressBar } from './progressBar';
import { joinedNextAction, type ProjectsDashboardContext } from './viewContext';

/** Detail view for a single project: header, stats, description, its tasks. */
export function renderProjectDashboard(
  container: HTMLElement,
  snapshot: ProjectWorkspaceSnapshot | undefined,
  ctx: ProjectsDashboardContext,
): void {
  container.addClass('abyss-projects-dashboard');

  const back = container.createEl('button', { cls: 'abyss-project-back' });
  setIcon(back, 'arrow-left');
  back.createSpan({ text: 'Back to projects' });
  back.addEventListener('click', () => ctx.state.set('projectsPanel', { view: 'list' }));

  if (!snapshot) {
    container.createDiv({ cls: 'abyss-projects-empty', text: 'Project not found' });
    return;
  }
  const project = snapshot.project;

  const statuses = ctx.settings.projects.statuses;
  const status = project.statusId ? statuses.find((s) => s.id === project.statusId) : undefined;

  const header = container.createDiv({ cls: 'abyss-project-dashboard-header' });
  header.createEl('h2', { cls: 'abyss-project-dashboard-title', text: project.name });

  const pill = header.createEl('button', { cls: 'abyss-status-pill' });
  if (status?.color) pill.style.background = status.color;
  pill.setText(status?.label ?? project.rawStatus ?? 'No status');
  pill.addEventListener('click', (e) => {
    const menu = new Menu();
    for (const s of statuses) {
      menu.addItem((item) =>
        item
          .setTitle(s.label)
          .setChecked(s.id === project.statusId)
          .onClick(() => ctx.onSetStatus(project.path, s.id)),
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
  renderProgressBar(stats, snapshot.taskRollup.done, snapshot.taskRollup.total);
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

  const taskHost = container.createDiv({ cls: 'abyss-project-tasks' });
  taskHost.createEl('h3', { cls: 'abyss-project-tasks-title', text: 'Tasks' });
  const taskContent = taskHost.createDiv({ cls: 'abyss-project-tasks-content' });
  ctx.renderTasks(taskContent, project.path, snapshot.tasks);
}
