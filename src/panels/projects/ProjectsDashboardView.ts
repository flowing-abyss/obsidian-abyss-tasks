import { Menu, setIcon } from 'obsidian';
import { projectStatusDisplayName } from '../../projects/status';
import type { Project } from '../../projects/types';
import type { ProjectStatus } from '../../settings/types';
import { showMenuAtMouseEventWithFocus } from '../../ui/nativeMenuFocus';
import { renderProgressBar } from './progressBar';
import { ProjectDashboardProperties } from './ProjectDashboardProperties';
import { applyProjectStatusPresentation } from './projectStatusPresentation';
import type { ProjectsDashboardContext } from './viewContext';

interface DashboardState {
  project: Project;
  header: HTMLElement;
  back: HTMLElement;
  pill: HTMLElement;
  properties?: ProjectDashboardProperties;
  disposeMenu: () => void;
}
const dashboardProjects = new WeakMap<HTMLElement, DashboardState>();

export function disposeProjectDashboard(container: HTMLElement | null | undefined): void {
  if (container == null) return;
  const current = dashboardProjects.get(container);
  current?.disposeMenu();
  current?.properties?.destroy();
  dashboardProjects.delete(container);
}

export function finishProjectDashboardEditorBefore(
  container: HTMLElement | null,
  action: () => void,
): boolean {
  const properties = container === null ? undefined : dashboardProjects.get(container)?.properties;
  if (properties === undefined) return false;
  properties.finishBefore(action);
  return true;
}

function finishAction(ctx: ProjectsDashboardContext, action: () => void): void {
  if (ctx.finishEditorBefore === undefined) action();
  else ctx.finishEditorBefore(action);
}

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
  current.project = project;
  const title = current.header.querySelector('.abyss-project-dashboard-title');
  if (title !== null) title.textContent = project.name;
  patchProjectDashboardStatus(current.pill, project, projectStatus(project, statuses));
  const stats = current.header.querySelector<HTMLElement>('.abyss-project-dashboard-stats');
  if (stats !== null) {
    stats.empty();
    renderProgressBar(stats, project.stats);
  }
  current.properties?.refresh();
  renderTasks(taskHost, project.path);
  attachDashboardHeader(taskHost, current);
  return true;
}

function attachDashboardHeader(taskHost: HTMLElement, current: DashboardState): void {
  const toolbar = taskHost.querySelector<HTMLElement>('.abyss-center-header');
  if (toolbar !== null && current.header.parentElement !== toolbar)
    toolbar.prepend(current.back, current.header);
  const filters = toolbar?.querySelector('.abyss-task-collection-filters');
  if (filters !== undefined && filters !== null && filters.nextElementSibling !== current.pill)
    filters.after(current.pill);
}

/** Detail view for a single project: header, stats, description, its tasks. */
export function renderProjectDashboard(
  container: HTMLElement,
  project: Project | undefined,
  ctx: ProjectsDashboardContext,
): void {
  container.addClass('abyss-projects-dashboard');

  const header = container.createDiv({ cls: 'abyss-project-dashboard-header' });
  const back = header.createEl('button', {
    cls: 'abyss-project-back',
    attr: { 'aria-label': 'Back to projects' },
  });
  setIcon(back, 'arrow-left');
  back.addEventListener('click', () => {
    finishAction(ctx, () => {
      ctx.state.set('projectsPanel', { view: 'table' });
    });
  });

  if (project == null) {
    container.createDiv({ cls: 'abyss-projects-empty', text: 'Project not found' });
    return;
  }

  renderProjectDetails(container, { header, back }, project, ctx);
}

function renderProjectDetails(
  container: HTMLElement,
  { header, back }: Pick<DashboardState, 'header' | 'back'>,
  project: Project,
  ctx: ProjectsDashboardContext,
): void {
  const pill = header.createEl('button', { cls: 'abyss-status-pill' });
  const current: DashboardState = { project, header, back, pill, disposeMenu: () => {} };
  dashboardProjects.set(container, current);
  const title = header.createEl('button', {
    cls: 'abyss-project-dashboard-title',
    text: project.name,
  });
  title.addEventListener('click', () => {
    finishAction(ctx, () => {
      ctx.openNote(current.project.path);
    });
  });
  const metadata = header.createDiv({ cls: 'abyss-project-dashboard-metadata' });
  const stats = metadata.createDiv({ cls: 'abyss-project-dashboard-stats' });
  renderProgressBar(stats, project.stats);
  patchProjectDashboardStatus(
    pill,
    project,
    projectStatus(project, ctx.settings.projects.statuses),
  );
  current.disposeMenu = bindStatusMenu(pill, current, ctx);
  current.properties = new ProjectDashboardProperties(
    container,
    metadata,
    () => current.project,
    ctx,
  );
  const taskHost = container.createDiv({ cls: 'abyss-project-tasks' });
  ctx.renderTasks(taskHost, project.path);
  attachDashboardHeader(taskHost, current);
}

/** Capture the closing press before Obsidian's outside-click dismissal removes the native menu. */
function bindStatusMenu(
  pill: HTMLElement,
  current: DashboardState,
  ctx: ProjectsDashboardContext,
): () => void {
  let menu: Menu | undefined;
  let closingPress = false;
  let release = (): void => {};
  const bind = (): void => {
    release();
    const win = pill.ownerDocument.defaultView;
    const press = (pointer: PointerEvent): void => {
      closingPress = menu !== undefined && pointer.composedPath().includes(pill);
      if (closingPress) menu?.hide();
    };
    const cancel = (): void => {
      closingPress = false;
    };
    win?.addEventListener('pointerdown', press, true);
    win?.addEventListener('pointercancel', cancel, true);
    release = () => {
      win?.removeEventListener('pointerdown', press, true);
      win?.removeEventListener('pointercancel', cancel, true);
    };
  };
  bind();
  const migration = pill.onWindowMigrated(() => {
    menu?.hide();
    bind();
  });
  pill.addEventListener('click', (event) => {
    if (closingPress) {
      closingPress = false;
      return;
    }
    if (menu !== undefined) {
      menu.hide();
      return;
    }
    const next = new Menu();
    menu = next;
    pill.setAttribute('aria-expanded', 'true');
    for (const status of ctx.settings.projects.statuses) {
      next.addItem((item) =>
        item
          .setTitle(projectStatusDisplayName(status))
          .setChecked(status.id === current.project.statusId)
          .onClick(() => {
            ctx.onSetStatus(current.project.path, status.id);
          }),
      );
    }
    next.onHide(() => {
      if (menu === next) menu = undefined;
      pill.setAttribute('aria-expanded', 'false');
    });
    showMenuAtMouseEventWithFocus(next, event);
  });
  return () => {
    menu?.hide();
    release();
    migration();
  };
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
