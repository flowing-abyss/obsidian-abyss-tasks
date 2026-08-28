import { Menu, setIcon } from 'obsidian';
import { orderedGroups, type StatusGroup } from '../../projects/status';
import type { Project, ProjectWorkspaceSnapshot } from '../../projects/types';
import type { ProjectStatus } from '../../settings/types';
import { showMenuAtMouseEventWithFocus } from '../../ui/nativeMenuFocus';
import { BoundedWindow } from './BoundedWindow';
import { renderProjectsToolbar } from './ProjectsToolbar';
import { projectStatusMenuModel } from './boardProjection';
import { renderProgressBar } from './progressBar';
import { joinedNextAction, type ProjectsListContext } from './viewContext';

const PORTFOLIO_ITEM_EXTENT = 52;
const PORTFOLIO_FALLBACK_VISIBLE_ROWS = 10;
const PORTFOLIO_OVERSCAN = 6;

function fixedItemViewport(
  scrollTop: number,
  viewportExtent: number,
  itemExtent: number,
  count: number,
): { first: number; visible: number } {
  const collectionExtent = count * itemExtent;
  const top = Math.min(collectionExtent, Math.max(0, scrollTop));
  const first = Math.floor(top / itemExtent);
  if (viewportExtent <= 0) return { first, visible: PORTFOLIO_FALLBACK_VISIBLE_ROWS };
  const end = Math.min(count, Math.ceil((top + viewportExtent) / itemExtent));
  return { first, visible: Math.max(0, end - first) };
}

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

export function showNewProjectInput(
  host: HTMLElement,
  onCreate: (name: string) => Promise<void>,
): void {
  const existing = host.querySelector('.abyss-projects-new-input');
  if (existing) {
    (existing as HTMLInputElement).focus();
    return;
  }
  const input = host.createEl('input', {
    cls: 'abyss-projects-new-input',
    attr: { type: 'text', placeholder: 'Project name…' },
  });
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

  const newProjectInputHost = container.createDiv({ cls: 'abyss-projects-new-input-host' });
  const scroll = container.createDiv({ cls: 'abyss-projects-scroll' });

  // "New project" shows an inline input at the top of the list — the same
  // interaction as the left-panel "+", never a modal (kept consistent).
  newProjectButton.addEventListener('click', () =>
    showNewProjectInput(newProjectInputHost, ctx.onCreate),
  );

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

  const rowsHost = scroll.createDiv({
    cls: 'abyss-projects-window',
    attr: { tabindex: '-1', role: 'list', 'aria-label': 'Projects list' },
  });
  const bounded = new BoundedWindow(
    entries.map(({ key }) => key),
    PORTFOLIO_OVERSCAN,
  );
  const viewport = (): { first: number; visible: number } =>
    fixedItemViewport(scroll.scrollTop, scroll.clientHeight, PORTFOLIO_ITEM_EXTENT, entries.length);
  let destroyed = false;
  const renderWindow = (restoreFocus = false): void => {
    if (destroyed) return;
    const result = bounded.render(rowsHost, {
      ...viewport(),
      itemExtent: PORTFOLIO_ITEM_EXTENT,
      restoreFocus,
      render: (host, _key, logicalIndex) => {
        const entry = entries[logicalIndex]!;
        if (entry.type === 'group') return renderGroupHeader(host, entry.group, entry.count);
        return renderProjectRow(
          host,
          entry.snapshot,
          statusById,
          statuses,
          nameCounts,
          ctx,
          (path) => bounded.focus(`project:${path}`),
          (path, delta) => {
            bounded.focus(`project:${path}`);
            moveLogicalFocus(delta);
          },
        );
      },
    });
    if (restoreFocus) scroll.scrollTop = result.first * PORTFOLIO_ITEM_EXTENT;
  };
  const moveLogicalFocus = (delta: number): void => {
    if (bounded.move(delta, isProjectWindowKey) === null) return;
    const nextFirst = bounded.viewportForFocus(viewport());
    scroll.scrollTop = nextFirst * PORTFOLIO_ITEM_EXTENT;
    renderWindow(true);
  };
  const onScroll = (): void => renderWindow(false);
  const onWindowKeydown = (event: KeyboardEvent): void => {
    if (event.target !== rowsHost || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
    event.preventDefault();
    moveLogicalFocus(event.key === 'ArrowDown' ? 1 : -1);
  };
  scroll.addEventListener('scroll', onScroll);
  rowsHost.addEventListener('keydown', onWindowKeydown);
  renderWindow();
  const resizeObserver =
    typeof ResizeObserver === 'undefined'
      ? undefined
      : new ResizeObserver(() => renderWindow(false));
  resizeObserver?.observe(scroll);
  return (): void => {
    destroyed = true;
    resizeObserver?.disconnect();
    rowsHost.removeEventListener('keydown', onWindowKeydown);
    scroll.removeEventListener('scroll', onScroll);
  };
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

export function renderProjectRow(
  parent: HTMLElement,
  snapshot: ProjectWorkspaceSnapshot,
  statusById: Map<string, ProjectStatus>,
  statuses: ProjectStatus[],
  nameCounts: Map<string, number>,
  ctx: ProjectsListContext,
  onFocus: (path: string) => void,
  onMoveFocus: (path: string, delta: number) => void,
  ownsArrowNavigation = true,
  showStatusControl = true,
): HTMLElement {
  const project = snapshot.project;
  const row = parent.createDiv({
    cls: 'abyss-project-row',
    attr: { role: 'listitem' },
  });

  const status = project.statusId ? statusById.get(project.statusId) : undefined;
  const dot = row.createSpan({ cls: 'abyss-status-dot' });
  if (status?.color) dot.style.background = status.color;
  dot.setAttribute('role', 'img');
  dot.setAttribute(
    'aria-label',
    `Project status: ${status?.label ?? project.rawStatus ?? 'No status'}`,
  );

  const nameWrap = row.createEl('button', {
    cls: 'abyss-project-row-name abyss-project-identity-control',
    attr: {
      type: 'button',
      'data-project-identity-control': '',
      'aria-label': `Open project ${project.name}`,
    },
  });
  nameWrap.createSpan({ cls: 'abyss-project-name', text: project.name });
  if ((nameCounts.get(project.name) ?? 0) > 1) {
    nameWrap.createSpan({ cls: 'abyss-project-folder', text: parentFolder(project.path) });
  }

  const workNoteCount =
    snapshot.workNoteRollup.active +
    snapshot.workNoteRollup.completed +
    snapshot.workNoteRollup.dropped +
    snapshot.milestones.length;
  const overdueCount = snapshot.overdue.tasks + snapshot.overdue.workNotes;
  const nextAction = joinedNextAction(snapshot.tasks);
  const hasMetadata =
    snapshot.taskRollup.total > 0 ||
    workNoteCount > 0 ||
    overdueCount > 0 ||
    snapshot.diagnostics.length > 0 ||
    nextAction !== undefined;

  if (hasMetadata) {
    row.addClass('abyss-project-row--has-meta');
    const meta = row.createDiv({ cls: 'abyss-project-row-meta' });
    if (snapshot.taskRollup.total > 0) {
      const taskProgress = meta.createDiv({ cls: 'abyss-project-task-progress' });
      taskProgress.createSpan({ cls: 'abyss-project-metric-label', text: 'Tasks' });
      renderProgressBar(
        taskProgress,
        snapshot.taskRollup.done,
        snapshot.taskRollup.total,
        `${project.name} task progress`,
      );
    }
    if (workNoteCount > 0) {
      meta.createSpan({
        cls: 'abyss-project-work-notes',
        text: `Work Notes ${workNoteCount}`,
        attr: {
          'aria-label': `${String(workNoteCount)} Work Note${workNoteCount === 1 ? '' : 's'}`,
        },
      });
    }
    if (overdueCount > 0) {
      const overdue = meta.createSpan({
        cls: 'abyss-project-attention abyss-project-overdue',
        attr: {
          title: `${String(overdueCount)} overdue`,
          'aria-label': `${String(overdueCount)} overdue item${overdueCount === 1 ? '' : 's'}`,
        },
      });
      const icon = overdue.createSpan({ cls: 'abyss-project-attention-icon' });
      setIcon(icon, 'clock-alert');
      overdue.createSpan({ text: String(overdueCount) });
    }
    if (snapshot.diagnostics.length > 0) {
      const diagnostics = meta.createSpan({
        cls: 'abyss-project-attention abyss-project-diagnostics',
        attr: {
          title: `${String(snapshot.diagnostics.length)} diagnostics`,
          'aria-label': `${String(snapshot.diagnostics.length)} diagnostic${snapshot.diagnostics.length === 1 ? '' : 's'}`,
        },
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
    attr: { 'aria-label': 'Change status', title: 'Change status' },
  });
  statusBtn.toggle(showStatusControl);
  setIcon(statusBtn, 'circle-dot');
  statusBtn.addEventListener('click', (e) => {
    e.stopPropagation();
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

  const openBtn = actions.createEl('button', {
    cls: 'abyss-project-open-btn',
    attr: { 'aria-label': 'Open note', title: 'Open note' },
  });
  setIcon(openBtn, 'file-text');
  openBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    ctx.openNote(project.path);
  });

  nameWrap.addEventListener('click', () => {
    ctx.state.set('projectsPanel', { view: 'dashboard', path: project.path });
  });
  nameWrap.addEventListener('keydown', (event) => {
    if (
      ownsArrowNavigation &&
      event.target === nameWrap &&
      (event.key === 'ArrowDown' || event.key === 'ArrowUp')
    ) {
      event.preventDefault();
      onMoveFocus(project.path, event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.target !== nameWrap) return;
    event.preventDefault();
    ctx.state.set('projectsPanel', { view: 'dashboard', path: project.path });
  });
  nameWrap.addEventListener('focus', () => onFocus(project.path));
  return row;
}
