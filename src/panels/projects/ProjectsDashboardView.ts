import { Menu, setIcon } from 'obsidian';
import { findFrontmatterProperty } from '../../projects/projectFields';
import { projectTrackedDisplayValue } from '../../projects/projectTableModel';
import { projectStatusDisplayName } from '../../projects/status';
import type { Project } from '../../projects/types';
import type { ProjectsSettings, ProjectStatus } from '../../settings/types';
import { showMenuAtMouseEventWithFocus } from '../../ui/nativeMenuFocus';
import { renderProgressBar } from './progressBar';
import { formatProjectPrettyDate } from './projectDatePresentation';
import { applyProjectStatusPresentation } from './projectStatusPresentation';
import type { ProjectsDashboardContext } from './viewContext';

const dashboardProjects = new WeakMap<
  HTMLElement,
  { project: Project; header: HTMLElement; settings: ProjectsSettings }
>();

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
  refreshProjectDashboardStatus(current.header, project, statuses);
  const stats = current.header.querySelector<HTMLElement>('.abyss-project-dashboard-stats');
  if (stats !== null) {
    stats.empty();
    renderProgressBar(stats, project.stats);
  }
  refreshProjectMetadata(current.header, project, current.settings);
  renderTasks(taskHost, project.path);
  attachDashboardHeader(taskHost, current.header);
  return true;
}

function attachDashboardHeader(taskHost: HTMLElement, header: HTMLElement): void {
  const toolbar = taskHost.querySelector<HTMLElement>('.abyss-center-header');
  if (toolbar !== null && header.parentElement !== toolbar) toolbar.prepend(header);
}

function metadataText(value: unknown): string {
  if (Array.isArray(value)) return value.map(metadataText).filter(Boolean).join(', ');
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return '';
}

function refreshProjectDates(
  header: HTMLElement,
  project: Project,
  settings: ProjectsSettings,
): void {
  const dates = header.querySelector<HTMLElement>('.abyss-project-dashboard-dates');
  if (dates !== null) {
    dates.empty();
    for (const [label, key] of [
      ['Start', settings.startProperty],
      ['End', settings.endProperty],
    ] as const) {
      const raw = findFrontmatterProperty(project.frontmatter, key)?.value;
      if (metadataText(raw) === '') continue;
      const value =
        formatProjectPrettyDate(
          raw,
          header.ownerDocument.defaultView?.navigator.language ?? 'en',
        ) ?? metadataText(raw);
      const chip = dates.createSpan({
        cls: 'abyss-project-dashboard-date',
        attr: { 'aria-label': `${label}: ${value}` },
      });
      setIcon(chip.createSpan(), label === 'Start' ? 'calendar-arrow-up' : 'calendar-check');
      chip.createSpan({ text: value });
    }
  }
}

function refreshProjectMetadata(
  header: HTMLElement,
  project: Project,
  settings: ProjectsSettings,
): void {
  refreshProjectDates(header, project, settings);
  const body = header.querySelector<HTMLElement>('.abyss-project-dashboard-properties');
  if (body === null) return;
  body.empty();
  const description = metadataText(project.frontmatter['description']).trim();
  if (description !== '') body.createDiv({ cls: 'abyss-project-description', text: description });
  renderTrackedTime(body, project);
  const excluded = new Set(['position', 'description', settings.statusProperty.toLowerCase()]);
  for (const [key, raw] of Object.entries(project.frontmatter)) {
    if (excluded.has(key.toLowerCase())) continue;
    const value = metadataText(raw);
    if (value === '') continue;
    const row = body.createDiv({ cls: 'abyss-project-dashboard-property' });
    row.createSpan({ text: key });
    row.createSpan({ text: value });
  }
  if (body.childElementCount === 0) body.createDiv({ text: 'No additional properties' });
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
    ctx.state.set('projectsPanel', { view: 'table' });
  });

  if (project == null) {
    container.createDiv({ cls: 'abyss-projects-empty', text: 'Project not found' });
    return;
  }

  renderProjectDetails(container, header, project, ctx);
}

function renderProjectDetails(
  container: HTMLElement,
  header: HTMLElement,
  project: Project,
  ctx: ProjectsDashboardContext,
): void {
  const current = { project, header, settings: ctx.settings.projects };
  dashboardProjects.set(container, current);
  const statuses = ctx.settings.projects.statuses;
  const status = projectStatus(project, statuses);

  header.createEl('h2', { cls: 'abyss-project-dashboard-title', text: project.name });

  const stats = header.createDiv({ cls: 'abyss-project-dashboard-stats' });
  renderProgressBar(stats, project.stats);

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

  header.createDiv({ cls: 'abyss-project-dashboard-dates' });
  const details = header.createEl('details', { cls: 'abyss-project-dashboard-details' });
  const summary = details.createEl('summary', { attr: { 'aria-label': 'Project properties' } });
  setIcon(summary, 'info');
  details.createDiv({ cls: 'abyss-project-dashboard-properties abyss-popover' });
  details.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      details.open = false;
      summary.focus();
    }
  });
  details.addEventListener('focusout', (event) => {
    if (event.relatedTarget instanceof Node && !details.contains(event.relatedTarget))
      details.open = false;
  });
  refreshProjectMetadata(header, project, ctx.settings.projects);
  const taskHost = container.createDiv({ cls: 'abyss-project-tasks' });
  ctx.renderTasks(taskHost, project.path);
  attachDashboardHeader(taskHost, header);
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
function refreshProjectDashboardStatus(
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
