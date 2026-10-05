import { Menu, setIcon } from 'obsidian';
import { projectTrackedDisplayValue } from '../../projects/projectTableModel';
import { projectStatusDisplayName } from '../../projects/status';
import type { Project } from '../../projects/types';
import type { ProjectStatus } from '../../settings/types';
import { showMenuAtMouseEventWithFocus } from '../../ui/nativeMenuFocus';
import { renderProgressBar } from './progressBar';
import { applyProjectStatusPresentation } from './projectStatusPresentation';
import type { ProjectsDashboardContext } from './viewContext';

const dashboardProjects = new WeakMap<HTMLElement, { project: Project }>();

/** Refresh the same project's presentation without detaching its task or capture owner. */
export function refreshProjectDashboard(
  container: HTMLElement,
  project: Project | undefined,
  renderTasks: ProjectsDashboardContext['renderTasks'],
  statuses: readonly ProjectStatus[],
): boolean {
  const current = dashboardProjects.get(container);
  const taskHost = container.querySelector<HTMLElement>('.abyss-project-tasks');
  if (project === undefined || current?.project.path !== project.path || taskHost === null)
    return false;
  const taskTop = taskHost.getBoundingClientRect().top;
  const hadTaskScroll = container.scrollTop > 0;
  current.project = project;
  const title = container.querySelector('.abyss-project-dashboard-title');
  if (title !== null) title.textContent = project.name;
  refreshProjectDashboardStatus(container, project, statuses);
  const stats = container.querySelector<HTMLElement>('.abyss-project-dashboard-stats');
  if (stats !== null) {
    stats.empty();
    renderProgressBar(stats, project.stats);
    renderTrackedTime(stats, project);
  }
  refreshProjectDescription(container, project, taskHost);
  if (hadTaskScroll) {
    const correction = taskHost.getBoundingClientRect().top - taskTop;
    if (Math.abs(correction) > 0.01) container.scrollTop += correction;
  }
  renderTasks(taskHost, project.path);
  return true;
}

function refreshProjectDescription(
  container: HTMLElement,
  project: Project,
  taskHost: HTMLElement,
): void {
  const raw = project.frontmatter['description'];
  const description = typeof raw === 'string' ? raw.trim() : '';
  const previous = container.querySelector<HTMLElement>('.abyss-project-description');
  if (description === '') previous?.remove();
  else {
    const element = previous ?? container.createDiv({ cls: 'abyss-project-description' });
    element.textContent = description;
    if (previous === null) container.insertBefore(element, taskHost);
  }
}

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
  const current = { project };
  dashboardProjects.set(container, current);
  const statuses = ctx.settings.projects.statuses;
  const status = projectStatus(project, statuses);

  const header = container.createDiv({ cls: 'abyss-project-dashboard-header' });
  header.createEl('h2', { cls: 'abyss-project-dashboard-title', text: project.name });

  const pill = header.createEl('button', {
    cls: 'abyss-status-pill',
  });
  patchProjectDashboardStatus(pill, project, status);
  pill.addEventListener('click', (e) => {
    const menu = new Menu();
    for (const s of ctx.settings.projects.statuses) {
      menu.addItem((item) =>
        item
          .setTitle(projectStatusDisplayName(s))
          .setChecked(s.id === current.project.statusId)
          .onClick(() => {
            ctx.onSetStatus(current.project.path, s.id);
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
    ctx.openNote(current.project.path);
  });

  const stats = container.createDiv({ cls: 'abyss-project-dashboard-stats' });
  renderProgressBar(stats, project.stats);
  renderTrackedTime(stats, project);

  const rawDesc = project.frontmatter['description'];
  const desc = typeof rawDesc === 'string' ? rawDesc.trim() : '';
  if (desc.length > 0) {
    container.createDiv({ cls: 'abyss-project-description', text: desc });
  }

  const taskHost = container.createDiv({ cls: 'abyss-project-tasks' });
  ctx.renderTasks(taskHost, project.path);
}

/** The note's tracked total, left out entirely while a project has recorded no time. */
function renderTrackedTime(stats: HTMLElement, project: Project): void {
  const tracked = projectTrackedDisplayValue(project.stats, Date.now());
  if (tracked === '') return;
  const time = stats.createDiv({ cls: 'abyss-project-time' });
  time.createSpan({ cls: 'abyss-project-time-label', text: 'Time' });
  time.createSpan({ cls: 'abyss-project-time-value', text: tracked });
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
  applyProjectStatusPresentation(pill, status);
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
