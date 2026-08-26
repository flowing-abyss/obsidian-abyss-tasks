import { Menu, setIcon } from 'obsidian';
import { orderedGroups, type StatusGroup } from '../../projects/status';
import type { Project, ProjectWorkspaceSnapshot } from '../../projects/types';
import type { ProjectStatus } from '../../settings/types';
import { showMenuAtMouseEventWithFocus } from '../../ui/nativeMenuFocus';
import { BoundedWindow } from './BoundedWindow';
import { renderProjectsToolbar } from './ProjectsToolbar';
import { renderProgressBar } from './progressBar';
import { joinedNextAction, type ProjectsListContext } from './viewContext';

const PORTFOLIO_ITEM_EXTENT = 52;
const PORTFOLIO_FALLBACK_VISIBLE_ROWS = 10;
const PORTFOLIO_OVERSCAN = 6;

type PortfolioEntry =
  | {
      readonly type: 'group';
      readonly key: string;
      readonly group: StatusGroup;
      readonly count: number;
    }
  | {
      readonly type: 'project';
      readonly key: string;
      readonly snapshot: ProjectWorkspaceSnapshot;
    };

function isProjectWindowKey(key: string): boolean {
  return key.startsWith('project:');
}

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
  if (existing) {
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
    if (name) void onCreate(name);
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
  window.setTimeout(() => input.focus(), 0);
}

/** Overview: all projects grouped by status (defined order → discovered → No status). */
export function renderProjectsList(
  container: HTMLElement,
  snapshots: readonly ProjectWorkspaceSnapshot[],
  ctx: ProjectsListContext,
): () => void {
  container.addClass('abyss-projects-list');
  const { newProjectButton } = renderProjectsToolbar(container, ctx);

  const statuses = ctx.settings.projects.statuses;
  const statusById = new Map(statuses.map((s) => [s.id, s]));
  const visibleStatusIds = new Set(ctx.settings.projects.view.visibleStatusIds);
  const visibleSnapshots = snapshots.filter(({ project }) =>
    project.statusId === null
      ? ctx.settings.projects.view.includeUnmapped
      : visibleStatusIds.has(project.statusId),
  );
  const projects = visibleSnapshots.map(({ project, taskRollup }) => ({
    ...project,
    stats: taskRollup,
  }));
  const snapshotByPath = new Map(
    visibleSnapshots.map((snapshot) => [snapshot.project.path, snapshot]),
  );

  // Names appearing more than once → disambiguate rows with their folder.
  const nameCounts = new Map<string, number>();
  for (const p of projects) nameCounts.set(p.name, (nameCounts.get(p.name) ?? 0) + 1);

  const scroll = container.createDiv({ cls: 'abyss-projects-scroll' });

  // "New project" shows an inline input at the top of the list — the same
  // interaction as the left-panel "+", never a modal (kept consistent).
  newProjectButton.addEventListener('click', () => showNewProjectInput(scroll, ctx.onCreate));

  if (visibleSnapshots.length === 0) {
    scroll.createDiv({
      cls: 'abyss-projects-empty',
      text: snapshots.length === 0 ? 'No projects yet' : 'No projects match the status filters',
    });
    return (): void => {};
  }

  const entries: PortfolioEntry[] = [];
  for (const group of orderedGroups(statuses, projects)) {
    const inGroup = projectsInGroup(group, projects);
    if (inGroup.length === 0) continue;
    entries.push({ type: 'group', key: `group:${group.key}`, group, count: inGroup.length });
    for (const project of inGroup) {
      const snapshot = snapshotByPath.get(project.path);
      if (snapshot) {
        entries.push({ type: 'project', key: `project:${project.path}`, snapshot });
      }
    }
  }

  const rowsHost = scroll.createDiv({ cls: 'abyss-projects-window' });
  const bounded = new BoundedWindow(
    entries.map(({ key }) => key),
    PORTFOLIO_OVERSCAN,
  );
  const viewport = (): { first: number; visible: number } => ({
    first: Math.floor(scroll.scrollTop / PORTFOLIO_ITEM_EXTENT),
    visible:
      scroll.clientHeight > 0
        ? Math.max(1, Math.ceil(scroll.clientHeight / PORTFOLIO_ITEM_EXTENT))
        : PORTFOLIO_FALLBACK_VISIBLE_ROWS,
  });
  const renderWindow = (restoreFocus = false): void => {
    const result = bounded.render(rowsHost, {
      ...viewport(),
      itemExtent: PORTFOLIO_ITEM_EXTENT,
      restoreFocus,
      render: (host, _key, logicalIndex) => {
        const entry = entries[logicalIndex]!;
        if (entry.type === 'group') return renderGroupHeader(host, entry.group, entry.count);
        return renderRow(
          host,
          entry.snapshot,
          statusById,
          statuses,
          nameCounts,
          ctx,
          (path) => bounded.focus(`project:${path}`),
          (path, delta) => {
            bounded.focus(`project:${path}`);
            if (bounded.move(delta, isProjectWindowKey) === null) return;
            const nextFirst = bounded.viewportForFocus(viewport());
            scroll.scrollTop = nextFirst * PORTFOLIO_ITEM_EXTENT;
            renderWindow(true);
          },
        );
      },
    });
    if (restoreFocus) scroll.scrollTop = result.first * PORTFOLIO_ITEM_EXTENT;
  };
  const onScroll = (): void => renderWindow(false);
  scroll.addEventListener('scroll', onScroll);
  renderWindow();
  return (): void => scroll.removeEventListener('scroll', onScroll);
}

function renderGroupHeader(parent: HTMLElement, group: StatusGroup, count: number): HTMLElement {
  const header = parent.createDiv({ cls: 'abyss-projects-group-header' });
  if (group.color) {
    const dot = header.createSpan({ cls: 'abyss-status-dot' });
    dot.style.background = group.color;
  }
  header.createSpan({ cls: 'abyss-projects-group-label', text: group.label });
  header.createSpan({ cls: 'abyss-projects-group-count', text: String(count) });
  return header;
}

function renderRow(
  parent: HTMLElement,
  snapshot: ProjectWorkspaceSnapshot,
  statusById: Map<string, ProjectStatus>,
  statuses: ProjectStatus[],
  nameCounts: Map<string, number>,
  ctx: ProjectsListContext,
  onFocus: (path: string) => void,
  onMoveFocus: (path: string, delta: number) => void,
): HTMLElement {
  const project = snapshot.project;
  const row = parent.createDiv({
    cls: 'abyss-project-row',
    attr: { tabindex: '0' },
  });

  const status = project.statusId ? statusById.get(project.statusId) : undefined;
  const dot = row.createSpan({ cls: 'abyss-status-dot' });
  if (status?.color) dot.style.background = status.color;

  const nameWrap = row.createDiv({ cls: 'abyss-project-row-name' });
  nameWrap.createSpan({ cls: 'abyss-project-name', text: project.name });
  if ((nameCounts.get(project.name) ?? 0) > 1) {
    nameWrap.createSpan({ cls: 'abyss-project-folder', text: parentFolder(project.path) });
  }

  const workNoteCount =
    snapshot.workNoteRollup.active +
    snapshot.workNoteRollup.completed +
    snapshot.workNoteRollup.dropped;
  const overdueCount = snapshot.overdue.tasks + snapshot.overdue.workNotes;
  const nextAction = joinedNextAction(snapshot.tasks);
  const hasMetadata =
    snapshot.taskRollup.total > 0 ||
    workNoteCount > 0 ||
    overdueCount > 0 ||
    snapshot.diagnostics.length > 0 ||
    nextAction !== undefined;

  if (hasMetadata) {
    const meta = row.createDiv({ cls: 'abyss-project-row-meta' });
    if (snapshot.taskRollup.total > 0) {
      const taskProgress = meta.createDiv({ cls: 'abyss-project-task-progress' });
      taskProgress.createSpan({ cls: 'abyss-project-metric-label', text: 'Tasks' });
      renderProgressBar(taskProgress, snapshot.taskRollup.done, snapshot.taskRollup.total);
    }
    if (workNoteCount > 0) {
      meta.createSpan({ cls: 'abyss-project-work-notes', text: `Work Notes ${workNoteCount}` });
    }
    if (overdueCount > 0) {
      const overdue = meta.createSpan({
        cls: 'abyss-project-attention abyss-project-overdue',
        attr: { title: `${String(overdueCount)} overdue` },
      });
      const icon = overdue.createSpan({ cls: 'abyss-project-attention-icon' });
      setIcon(icon, 'clock-alert');
      overdue.createSpan({ text: String(overdueCount) });
    }
    if (snapshot.diagnostics.length > 0) {
      const diagnostics = meta.createSpan({
        cls: 'abyss-project-attention abyss-project-diagnostics',
        attr: { title: `${String(snapshot.diagnostics.length)} diagnostics` },
      });
      const icon = diagnostics.createSpan({ cls: 'abyss-project-attention-icon' });
      setIcon(icon, 'triangle-alert');
      diagnostics.createSpan({ text: String(snapshot.diagnostics.length) });
    }
    if (nextAction) {
      /* eslint-disable obsidianmd/ui/sentence-case -- Next Action is a named planning concept. */
      const next = meta.createEl('button', {
        cls: 'abyss-project-next-action',
        attr: {
          type: 'button',
          'aria-label': 'Open Next Action',
          title: 'Open Next Action',
        },
      });
      /* eslint-enable obsidianmd/ui/sentence-case */
      setIcon(next, 'list-checks');
      next.addEventListener('click', (event) => {
        event.stopPropagation();
        ctx.state.set('taskStack', [nextAction.task]);
      });
    }
  }

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
          .onClick(() => ctx.onSetStatus(project.path, s.id)),
      );
    }
    showMenuAtMouseEventWithFocus(menu, e);
  });

  const openBtn = actions.createEl('button', {
    cls: 'abyss-project-open-btn',
    attr: { 'aria-label': 'Open note', title: 'Open note' },
  });
  setIcon(openBtn, 'file-text');
  openBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    ctx.openNote(project.path);
  });

  row.addEventListener('click', () => {
    ctx.state.set('projectsPanel', { view: 'dashboard', path: project.path });
  });
  row.addEventListener('keydown', (event) => {
    if (event.target === row && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      onMoveFocus(project.path, event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.target !== row) return;
    event.preventDefault();
    ctx.state.set('projectsPanel', { view: 'dashboard', path: project.path });
  });
  row.addEventListener('focus', () => onFocus(project.path));
  return row;
}
