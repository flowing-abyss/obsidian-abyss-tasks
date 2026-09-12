import { Menu, setIcon } from 'obsidian';
import { projectStatusDisplayName } from '../../projects/status';
import type { Project } from '../../projects/types';
import type { ProjectStatus } from '../../settings/types';
import { showMenuAtMouseEventWithFocus } from '../../ui/nativeMenuFocus';
import { renderProgressBar } from './progressBar';
import type { ProjectsDashboardContext } from './viewContext';

/** Detail view for a single project: header, stats, description, its tasks. */
export function renderProjectDashboard(
  container: HTMLElement,
  project: Project | undefined,
  ctx: ProjectsDashboardContext,
): void {
  container.addClass('abyss-projects-dashboard');

  const back = container.createEl('button', { cls: 'abyss-project-back' });
  setIcon(back, 'arrow-left');
  back.createSpan({ text: 'Back to projects' });
  back.addEventListener('click', () => {
    ctx.state.set('projectsPanel', { view: 'table' });
  });

  if (project == null) {
    container.createDiv({ cls: 'abyss-projects-empty', text: 'Project not found' });
    return;
  }

  renderProjectDetails(container, project, ctx);
}

function renderProjectDetails(
  container: HTMLElement,
  project: Project,
  ctx: ProjectsDashboardContext,
): void {
  const statuses = ctx.settings.projects.statuses;
  const status = projectStatus(project, statuses);

  const header = container.createDiv({ cls: 'abyss-project-dashboard-header' });
  header.createEl('h2', { cls: 'abyss-project-dashboard-title', text: project.name });

  const pill = header.createEl('button', {
    cls: 'abyss-status-pill abyss-project-table-status-pill',
  });
  patchProjectDashboardStatus(pill, project, status);
  pill.addEventListener('click', (e) => {
    const menu = new Menu();
    for (const s of ctx.settings.projects.statuses) {
      menu.addItem((item) =>
        item
          .setTitle(projectStatusDisplayName(s))
          .setChecked(s.id === project.statusId)
          .onClick(() => {
            ctx.onSetStatus(project.path, s.id);
          }),
      );
    }
    showMenuAtMouseEventWithFocus(menu, e);
  });

  const open = header.createEl('button', {
    cls: 'abyss-project-open-btn',
    attr: { 'aria-label': 'Open note' },
  });
  setIcon(open, 'file-text');
  open.addEventListener('click', () => {
    ctx.openNote(project.path);
  });

  const stats = container.createDiv({ cls: 'abyss-project-dashboard-stats' });
  renderProgressBar(stats, project.stats);

  const rawDesc = project.frontmatter['description'];
  const desc = typeof rawDesc === 'string' ? rawDesc.trim() : '';
  if (desc.length > 0) {
    container.createDiv({ cls: 'abyss-project-description', text: desc });
  }

  const taskHost = container.createDiv({ cls: 'abyss-project-tasks' });
  ctx.renderTasks(taskHost, project.path);
}

/** Refreshes the dashboard's status presentation without replacing its retained content. */
export function refreshProjectDashboardStatus(
  container: HTMLElement,
  project: Project | undefined,
  statuses: readonly ProjectStatus[],
): void {
  if (project === undefined) return;
  const pill = container.querySelector<HTMLElement>('.abyss-status-pill');
  if (pill === null) return;
  patchProjectDashboardStatus(pill, project, projectStatus(project, statuses));
}

function patchProjectDashboardStatus(
  pill: HTMLElement,
  project: Project,
  status: ProjectStatus | undefined,
): void {
  pill.toggleClass('is-text', status?.display === 'text');
  pill.toggleClass('is-dot', status?.display === 'dot');
  pill.style.removeProperty('--abyss-project-status-color');
  const statusColor = status?.color;
  if (statusColor !== undefined && statusColor.length > 0) {
    pill.style.setProperty('--abyss-project-status-color', statusColor);
  }
  pill.setText(
    status === undefined ? (project.rawStatus ?? 'No status') : projectStatusDisplayName(status),
  );
}

function projectStatus(
  project: Project,
  statuses: readonly ProjectStatus[],
): ProjectStatus | undefined {
  if (project.statusId === null || project.statusId.length === 0) return undefined;
  return statuses.find((status) => status.id === project.statusId);
}
