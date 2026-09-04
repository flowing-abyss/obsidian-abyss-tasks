import { Menu, setIcon } from 'obsidian';
import { orderedGroups, type StatusGroup } from '../../projects/status';
import type { Project } from '../../projects/types';
import type { ProjectStatus } from '../../settings/types';
import { showMenuAtMouseEventWithFocus } from '../../ui/nativeMenuFocus';
import { runAsyncAction } from '../../ui/runAsyncAction';
import { renderProgressBar } from './progressBar';
import type { ProjectsListContext } from './viewContext';

function projectsInGroup(group: StatusGroup, projects: Project[]): Project[] {
  if (group.statusId !== null) return projects.filter((p) => p.statusId === group.statusId);
  if (group.key.startsWith('raw:')) {
    return projects.filter((p) => p.statusId === null && p.rawStatus === group.label);
  }
  return projects.filter((p) => p.statusId === null && p.rawStatus === null);
}

function parentFolder(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

function showNewProjectInput(scroll: HTMLElement, onCreate: (name: string) => Promise<void>): void {
  const existing = scroll.querySelector('.abyss-projects-new-input');
  if (existing != null) {
    (existing as HTMLInputElement).focus();
    return;
  }
  const input = scroll.createEl('input', {
    cls: 'abyss-projects-new-input',
    attr: { type: 'text', placeholder: 'Project name…' },
  });
  scroll.insertBefore(input, scroll.firstChild);
  let committed = false;
  const commit = (): void => {
    if (committed) return;
    committed = true;
    const name = input.value.trim();
    if (name.length > 0) runAsyncAction(onCreate(name), 'Could not create project');
    else input.remove();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      committed = true;
      input.remove();
    }
  });
  input.addEventListener('blur', () => {
    window.setTimeout(() => {
      if (activeDocument.activeElement !== input) commit();
    }, 150);
  });
  window.setTimeout(() => {
    input.focus();
  }, 0);
}

/** Overview: all projects grouped by status (defined order → discovered → No status). */
export function renderProjectsList(
  container: HTMLElement,
  projects: Project[],
  ctx: ProjectsListContext,
): void {
  container.addClass('abyss-projects-list');

  const header = container.createDiv({ cls: 'abyss-projects-toolbar' });
  header.createEl('h2', { cls: 'abyss-projects-title', text: 'Projects' });
  const newBtn = header.createEl('button', { cls: 'abyss-projects-new', text: 'New project' });

  const statuses = ctx.settings.projects.statuses;
  const statusById = new Map(statuses.map((s) => [s.id, s]));

  // Names appearing more than once → disambiguate rows with their folder.
  const nameCounts = new Map<string, number>();
  for (const p of projects) nameCounts.set(p.name, (nameCounts.get(p.name) ?? 0) + 1);

  const scroll = container.createDiv({ cls: 'abyss-projects-scroll' });

  // "New project" shows an inline input at the top of the list — the same
  // interaction as the left-panel "+", never a modal (kept consistent).
  newBtn.addEventListener('click', () => {
    showNewProjectInput(scroll, ctx.onCreate);
  });

  if (projects.length === 0) {
    scroll.createDiv({ cls: 'abyss-projects-empty', text: 'No projects yet' });
    return;
  }

  for (const group of orderedGroups(statuses, projects)) {
    const inGroup = projectsInGroup(group, projects);
    if (inGroup.length === 0) continue;

    const groupEl = scroll.createDiv({ cls: 'abyss-projects-group' });
    const gHeader = groupEl.createDiv({ cls: 'abyss-projects-group-header' });
    if (group.color !== undefined && group.color !== '') {
      const dot = gHeader.createSpan({ cls: 'abyss-status-dot' });
      dot.style.background = group.color;
    }
    gHeader.createSpan({ cls: 'abyss-projects-group-label', text: group.label });
    gHeader.createSpan({ cls: 'abyss-projects-group-count', text: String(inGroup.length) });

    for (const project of inGroup) {
      renderRow(groupEl, project, statusById, statuses, nameCounts, ctx);
    }
  }
}

function renderRow(
  ...args: [
    HTMLElement,
    Project,
    Map<string, ProjectStatus>,
    ProjectStatus[],
    Map<string, number>,
    ProjectsListContext,
  ]
): void {
  const [parent, project, statusById, statuses, nameCounts, ctx] = args;
  const row = parent.createDiv({ cls: 'abyss-project-row' });

  const status =
    project.statusId !== null && project.statusId !== ''
      ? statusById.get(project.statusId)
      : undefined;
  const dot = row.createSpan({ cls: 'abyss-status-dot' });
  if (status?.color !== undefined && status.color !== '') {
    dot.style.background = status.color;
  }

  const nameWrap = row.createDiv({ cls: 'abyss-project-row-name' });
  nameWrap.createSpan({ cls: 'abyss-project-name', text: project.name });
  if ((nameCounts.get(project.name) ?? 0) > 1) {
    nameWrap.createSpan({ cls: 'abyss-project-folder', text: parentFolder(project.path) });
  }

  renderProgressBar(row, project.stats.done, project.stats.total);

  const actions = row.createDiv({ cls: 'abyss-project-row-actions' });

  const statusBtn = actions.createEl('button', {
    cls: 'abyss-project-status-btn',
    attr: { 'aria-label': 'Change status' },
  });
  setIcon(statusBtn, 'circle-dot');
  statusBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = new Menu();
    for (const s of statuses) {
      menu.addItem((item) =>
        item
          .setTitle(s.label)
          .setChecked(s.id === project.statusId)
          .onClick(() => {
            ctx.onSetStatus(project.path, s.id);
          }),
      );
    }
    showMenuAtMouseEventWithFocus(menu, e);
  });

  const openBtn = actions.createEl('button', {
    cls: 'abyss-project-open-btn',
    attr: { 'aria-label': 'Open note' },
  });
  setIcon(openBtn, 'file-text');
  openBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    ctx.openNote(project.path);
  });

  row.addEventListener('click', () => {
    ctx.state.set('projectsPanel', { view: 'dashboard', path: project.path });
  });
}
