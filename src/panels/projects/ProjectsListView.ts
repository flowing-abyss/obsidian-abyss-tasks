import { Menu, setIcon } from 'obsidian';
import {
  projectHealthProjection,
  type ProjectHealthProjection,
} from '../../projects/ProjectHealthProjection';
import type { ProjectCreateResult } from '../../projects/ProjectManager';
import { orderedGroups, type StatusGroup } from '../../projects/status';
import type { Project, ProjectWorkspaceSnapshot } from '../../projects/types';
import type { ProjectStatus } from '../../settings/types';
import {
  EntityPresentation,
  type EntityPresentationSlot,
} from '../../ui/entity/EntityPresentation';
import { showMenuAtMouseEventWithFocus } from '../../ui/nativeMenuFocus';
import { BoundedWindow } from './BoundedWindow';
import type { ProjectCaptureSession } from './ProjectWorkspaceSession';
import { renderProjectsToolbar } from './ProjectsToolbar';
import { projectPriorityMenuModel, projectStatusMenuModel } from './boardProjection';
import { renderProgressBar } from './progressBar';
import type { ProjectsListContext } from './viewContext';

export type { ProjectCaptureSession } from './ProjectWorkspaceSession';

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

interface ProjectCaptureOptions {
  readonly session: ProjectCaptureSession;
  readonly trigger: HTMLButtonElement;
  readonly liveRegion: HTMLElement;
  readonly openNote?: (path: string) => void;
  readonly onSettled?: () => void;
}

function captureMessage(result: Extract<ProjectCreateResult, { type: 'file-created' }>): string {
  if (!result.indexed && result.status === 'conflict') {
    return 'Project note created, but it is not visible in Projects and its default status could not be applied.';
  }
  if (!result.indexed) return 'Project note created, but it is not visible in Projects.';
  if (result.status === 'conflict') {
    return 'Project created, but its default status could not be applied.';
  }
  return 'Project created.';
}

export function showNewProjectInput(
  host: HTMLElement,
  onCreate: (name: string) => Promise<ProjectCreateResult | void>,
  options?: ProjectCaptureOptions,
): () => void {
  if (focusExistingProjectCapture(host)) return (): void => {};
  const session = options?.session ?? {
    open: true,
    draft: '',
    pending: false,
    createdPath: null,
  };
  session.open = true;
  const capture = host.createDiv({
    cls: 'abyss-project-capture',
    attr: { role: 'dialog', 'aria-modal': 'false', 'aria-label': 'New project' },
  });
  const input = capture.createEl('input', {
    cls: 'abyss-projects-new-input',
    value: session.draft,
    attr: {
      type: 'text',
      placeholder: 'Project name…',
      'aria-label': 'Project name',
    },
  });
  input.disabled = session.pending;
  const feedback = capture.createSpan({ cls: 'abyss-project-capture-feedback' });
  let destroyed = false;
  let removeOutsidePointer = (): void => {};
  const announce = (message: string): void => {
    feedback.textContent = message;
    if (options) options.liveRegion.textContent = message;
  };
  const close = (clearDraft: boolean): void => {
    session.open = false;
    session.pending = false;
    if (clearDraft) {
      session.draft = '';
      session.terminalResult = undefined;
    }
    removeOutsidePointer();
    capture.remove();
    options?.trigger.focus({ preventScroll: true });
  };
  const renderTerminal = (result: Extract<ProjectCreateResult, { type: 'file-created' }>): void => {
    session.terminalResult = result;
    session.pending = false;
    session.draft = '';
    input.remove();
    if (capture.querySelector('.abyss-project-capture-open-note')) return;
    capture
      .createEl('button', {
        cls: 'abyss-project-capture-open-note',
        text: 'Open created note',
        attr: { type: 'button' },
      })
      .addEventListener('click', () => {
        options?.openNote?.(result.path);
        close(true);
      });
  };
  const settle = (result: ProjectCreateResult | void): void => {
    if (result?.type === 'failed-before-create') {
      session.pending = false;
      session.terminalResult = undefined;
      input.disabled = false;
      announce(result.reason);
      input.focus({ preventScroll: true });
      return;
    }
    if (result?.type === 'file-created') {
      session.createdPath = result.indexed ? result.path : null;
      announce(captureMessage(result));
      if (!result.indexed) {
        renderTerminal(result);
        return;
      }
    } else {
      announce('Project created.');
    }
    close(true);
    options?.onSettled?.();
  };
  const observe = (promise: Promise<ProjectCreateResult | void>): void => {
    void promise.then((result) => {
      if (destroyed || session.pendingPromise !== promise) return;
      session.pendingPromise = undefined;
      settle(result);
    });
  };
  const commit = (): void => {
    if (session.pending) return;
    const name = input.value.trim();
    if (!name) {
      close(true);
      return;
    }
    session.draft = name;
    session.pending = true;
    input.disabled = true;
    announce('Creating project…');
    const createProject = async (): Promise<ProjectCreateResult | void> => {
      try {
        return await onCreate(name);
      } catch {
        return {
          type: 'failed-before-create',
          reason: 'Project note could not be created.',
        };
      }
    };
    const promise = createProject();
    session.pendingPromise = promise;
    observe(promise);
  };
  input.addEventListener('input', () => {
    session.draft = input.value;
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && !e.repeat) {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape' && !session.pending) {
      e.preventDefault();
      close(true);
    }
  });
  capture.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || session.pending) return;
    event.preventDefault();
    close(true);
  });
  const onOutsidePointer = (event: PointerEvent): void => {
    const target = event.target;
    if (
      !(target instanceof Node) ||
      capture.contains(target) ||
      options?.trigger.contains(target)
    ) {
      return;
    }
    if (session.draft.trim().length === 0 && !session.pending) close(true);
  };
  host.ownerDocument.addEventListener('pointerdown', onOutsidePointer);
  removeOutsidePointer = (): void => {
    host.ownerDocument.removeEventListener('pointerdown', onOutsidePointer);
  };
  if (session.pending && session.pendingPromise) {
    announce('Creating project…');
    observe(session.pendingPromise);
  } else if (session.terminalResult && !session.terminalResult.indexed) {
    announce(captureMessage(session.terminalResult));
    renderTerminal(session.terminalResult);
  }
  window.setTimeout(() => {
    capture.querySelector<HTMLElement>('input, button')?.focus();
  }, 0);
  return (): void => {
    destroyed = true;
    removeOutsidePointer();
  };
}

export function focusExistingProjectCapture(host: HTMLElement): boolean {
  const existing = host.querySelector<HTMLElement>('.abyss-project-capture');
  if (!existing) return false;
  existing.querySelector<HTMLElement>('input, button')?.focus({ preventScroll: true });
  return true;
}

/** Overview: all projects grouped by status (defined order → discovered → No status). */
export function renderProjectsList(
  container: HTMLElement,
  snapshots: readonly ProjectWorkspaceSnapshot[],
  ctx: ProjectsListContext,
): () => void {
  container.addClass('abyss-projects-list');
  const toolbar = renderProjectsToolbar(container, ctx);
  const { newProjectButton } = toolbar;
  const captureSession =
    ctx.captureSession ??
    ({ open: false, draft: '', pending: false, createdPath: null } satisfies ProjectCaptureSession);

  const statuses = ctx.settings.projects.statuses;
  const statusById = new Map(statuses.map((s) => [s.id, s]));
  const visibleStatusIds = new Set(ctx.settings.projects.view.visibleStatusIds);
  const visibleSnapshots = snapshots.filter(
    ({ project }) =>
      project.path === captureSession.createdPath ||
      (project.statusId === null
        ? ctx.settings.projects.view.includeUnmapped
        : visibleStatusIds.has(project.statusId)),
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
  let captureCleanup: (() => void) | undefined;

  const openCapture = (): void => {
    captureSession.open = true;
    if (focusExistingProjectCapture(toolbar.captureHost)) return;
    captureCleanup?.();
    captureCleanup = showNewProjectInput(toolbar.captureHost, ctx.onCreate, {
      session: captureSession,
      trigger: newProjectButton,
      liveRegion: toolbar.liveRegion,
      openNote: ctx.openNote,
      onSettled: ctx.onCaptureSettled,
    });
  };

  newProjectButton.addEventListener('click', openCapture);
  if (captureSession.open) openCapture();

  if (visibleSnapshots.length === 0) {
    scroll.createDiv({
      cls: 'abyss-projects-empty',
      text: snapshots.length === 0 ? 'No projects yet' : 'No projects match the status filters',
    });
    return (): void => {
      captureCleanup?.();
      toolbar.destroy();
    };
  }

  if (ctx.renderOverview) {
    const table = ctx.renderOverview(scroll, visibleSnapshots);
    return (): void => {
      captureCleanup?.();
      table.destroy();
      toolbar.destroy();
    };
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
  const createdPath = captureSession.createdPath;
  if (createdPath && entries.some(({ key }) => key === `project:${createdPath}`)) {
    bounded.focus(`project:${createdPath}`);
    const first = bounded.viewportForFocus(viewport());
    scroll.scrollTop = first * PORTFOLIO_ITEM_EXTENT;
    renderWindow(true);
    const created = Array.from(rowsHost.querySelectorAll<HTMLElement>('[data-bounded-key]')).find(
      ({ dataset }) => dataset['boundedKey'] === `project:${createdPath}`,
    );
    created?.querySelector<HTMLElement>('[data-project-identity-control]')?.focus({
      preventScroll: true,
    });
    const createdRow = created?.matches('.abyss-project-row')
      ? created
      : created?.querySelector<HTMLElement>('.abyss-project-row');
    createdRow?.addClass('is-just-created');
    captureSession.createdPath = null;
  }
  const resizeObserver =
    typeof ResizeObserver === 'undefined'
      ? undefined
      : new ResizeObserver(() => renderWindow(false));
  resizeObserver?.observe(scroll);
  return (): void => {
    destroyed = true;
    resizeObserver?.disconnect();
    captureCleanup?.();
    toolbar.destroy();
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

function titleCaseHealth(severity: ProjectHealthProjection['severity']): string {
  return severity
    .split('-')
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(' ');
}

function healthReason(health: ProjectHealthProjection): string {
  switch (health.reason.type) {
    case 'overdue-next-action':
      return 'Next action overdue';
    case 'blocked-critical-path':
      return 'Critical path blocked';
    case 'overdue-actionable-work':
      return 'Actionable work overdue';
    case 'blocked-next-action':
      return 'Next action blocked';
    case 'unblocked-next-action':
      return 'Next action ready';
    case 'insufficient-actionable-evidence':
      return 'No actionable next action';
  }
}

function dateSignal(health: ProjectHealthProjection): string | undefined {
  if (!health.date) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(health.date.value);
  if (!match) return undefined;
  const instant = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
  const parts = new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).formatToParts(instant);
  const day = parts.find(({ type }) => type === 'day')?.value;
  const month = parts.find(({ type }) => type === 'month')?.value;
  if (!day || !month) return undefined;
  const compact = `${day} ${month}`;
  return health.date.type === 'overdue-actionable-task' ? `Overdue ${compact}` : compact;
}

function currentLocalDate(): string {
  const now = new Date();
  const year = String(now.getFullYear()).padStart(4, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
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
  spaceActivates = true,
  presentationLayout: 'row' | 'board-card' = 'row',
): HTMLElement {
  const project = snapshot.project;
  const row = parent.createDiv({
    cls: 'abyss-project-row',
    attr: { role: 'listitem', 'data-project-path': project.path },
  });

  const status = project.statusId ? statusById.get(project.statusId) : undefined;
  const health = projectHealthProjection(snapshot, {
    today: ctx.today?.() ?? currentLocalDate(),
  });
  const reason = healthReason(health);
  const nextAction = health.selectedNextAction;
  const date = dateSignal(health);
  const workNoteCount =
    snapshot.workNoteRollup.active +
    snapshot.workNoteRollup.completed +
    snapshot.workNoteRollup.dropped +
    snapshot.milestones.length;
  const diagnosticCount =
    snapshot.diagnostics.length +
    Math.max(snapshot.dependencies.invalid, snapshot.dependencies.diagnostics.length) +
    Number(health.flags.duplicateNextAction) +
    Number(health.flags.malformedNextAction) +
    Number(health.flags.rangeIssue !== undefined);
  const meaningfulReason = health.reason.type !== 'insufficient-actionable-evidence';
  const hasSecondaryMetadata = Boolean(
    nextAction || meaningfulReason || date || workNoteCount > 0 || diagnosticCount > 0,
  );
  if (!hasSecondaryMetadata) row.addClass('is-single-line');

  let secondary: EntityPresentationSlot | undefined;
  if (nextAction) {
    secondary = {
      value: nextAction.task.title,
      text: '',
      element: 'button',
      className: 'abyss-project-next-action',
      attributes: { type: 'button', 'aria-label': 'Open Next Action', title: 'Open Next Action' },
      content: (slot) => {
        setIcon(slot, 'list-checks');
        slot.createSpan({ cls: 'abyss-project-next-action-title', text: nextAction.task.title });
      },
      onClick: (event) => {
        event.stopPropagation();
        ctx.state.set('taskStack', [nextAction.task]);
      },
    };
  } else if (meaningfulReason) {
    secondary = { value: reason, className: 'abyss-project-health-reason' };
  }

  const boardCard = presentationLayout === 'board-card';
  let layout: 'board-card' | 'project-row-two-line' | 'project-row-single-line';
  if (boardCard) layout = 'board-card';
  else if (hasSecondaryMetadata) layout = 'project-row-two-line';
  else layout = 'project-row-single-line';
  const presentation = new EntityPresentation({
    layout,
    actionsClassName: 'abyss-project-row-actions',
    primarySlots: boardCard
      ? ['identity', 'priority', 'date']
      : ['health', 'identity', 'priority', 'progress'],
    secondarySlots: boardCard
      ? ['progress', 'health', 'relations', 'secondary']
      : ['secondary', 'date', 'relations'],
    primaryClassName: boardCard
      ? 'abyss-entity-primary'
      : 'abyss-project-row-line abyss-project-row-line--primary',
    secondaryClassName: boardCard
      ? 'abyss-entity-secondary'
      : 'abyss-project-row-line abyss-project-row-line--secondary',
    identity: {
      value: project.name,
      text: '',
      element: 'button',
      className: 'abyss-project-row-name abyss-project-identity-control',
      attributes: {
        type: 'button',
        'data-project-identity-control': '',
        'aria-label': `Open project ${project.name}; status ${status?.label ?? project.rawStatus ?? 'No status'}`,
        ...((nameCounts.get(project.name) ?? 0) > 1
          ? { title: `${project.name} — ${parentFolder(project.path)}` }
          : {}),
      },
      content: (slot) => slot.createSpan({ cls: 'abyss-project-name', text: project.name }),
      onClick: () => ctx.state.set('projectsPanel', { view: 'dashboard', path: project.path }),
      onKeydown: (event) => {
        if (ownsArrowNavigation && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
          event.preventDefault();
          onMoveFocus(project.path, event.key === 'ArrowDown' ? 1 : -1);
          return;
        }
        if (event.key !== 'Enter' && (event.key !== ' ' || !spaceActivates)) return;
        event.preventDefault();
        ctx.state.set('projectsPanel', { view: 'dashboard', path: project.path });
      },
      onFocus: () => onFocus(project.path),
    },
    priority: project.priority === 'D' ? undefined : project.priority,
    health: {
      value: reason,
      text: '',
      className: `abyss-project-health abyss-project-health--${health.severity}`,
      attributes: {
        role: 'img',
        'aria-label': `Project health: ${titleCaseHealth(health.severity)} — ${reason}`,
      },
    },
    progress:
      snapshot.taskRollup.total > 0
        ? {
            value: `${String(snapshot.taskRollup.done)}/${String(snapshot.taskRollup.total)}`,
            text: '',
            element: 'div',
            className: 'abyss-project-task-progress',
            content: (slot) =>
              renderProgressBar(
                slot,
                snapshot.taskRollup.done,
                snapshot.taskRollup.total,
                `${project.name} task progress`,
              ),
          }
        : undefined,
    date: date ? { value: date, className: 'abyss-project-date-signal' } : undefined,
    relations:
      workNoteCount > 0 || diagnosticCount > 0
        ? {
            value: `${String(workNoteCount)} Work Notes; ${String(diagnosticCount)} project diagnostics`,
            text: '',
            className: 'abyss-project-exceptions',
            content: (slot) => {
              if (workNoteCount > 0) {
                slot.createSpan({
                  cls: 'abyss-project-work-note-count',
                  text: String(workNoteCount),
                  attr: {
                    'aria-label': `${String(workNoteCount)} Work Notes`,
                    title: 'Work Notes',
                  },
                });
              }
              if (diagnosticCount > 0) {
                slot.createSpan({
                  cls: 'abyss-project-diagnostic-count',
                  text: String(diagnosticCount),
                  attr: {
                    'aria-label': `${String(diagnosticCount)} project diagnostics`,
                    title: 'Project diagnostics',
                  },
                });
              }
              slot.createSpan({
                cls: 'abyss-project-exception-summary',
                text: '!',
                attr: {
                  'aria-label': `${String(workNoteCount)} Work Notes; ${String(diagnosticCount)} project diagnostics`,
                },
              });
            },
          }
        : undefined,
    secondary,
    actions: [
      {
        label: 'Project actions',
        icon: 'ellipsis',
        onClick: (e) => {
          e.stopPropagation();
          const menu = new Menu();
          menu.addItem((item) =>
            item
              .setTitle('Open note')
              .setIcon('file-text')
              .onClick(() => ctx.openNote(project.path)),
          );
          if (showStatusControl) {
            const statusMenu = (
              menu.addItem((item) => item.setTitle('Status')) as unknown as {
                setSubmenu(): Menu;
              }
            ).setSubmenu();
            for (const action of projectStatusMenuModel(statuses, project))
              statusMenu.addItem((item) =>
                item
                  .setTitle(action.label)
                  .setIcon(action.icon)
                  .setChecked(action.checked)
                  .setDisabled(action.disabled)
                  .onClick(() => ctx.onSetStatus(project.path, action.columnKey)),
              );
          }
          const priorityMenu = (
            menu.addItem((item) => item.setTitle('Priority')) as unknown as {
              setSubmenu(): Menu;
            }
          ).setSubmenu();
          for (const priority of projectPriorityMenuModel(project)) {
            priorityMenu.addItem((item) =>
              item
                .setTitle(priority.label)
                .setIcon(priority.icon)
                .setChecked(priority.checked)
                .setDisabled(priority.disabled)
                .onClick(() => {
                  if (!priority.disabled)
                    ctx.onSetPriority?.(
                      project.path,
                      priority.columnKey as NonNullable<Project['priority']>,
                    );
                }),
            );
          }
          showMenuAtMouseEventWithFocus(menu, e);
        },
      },
    ],
  });
  presentation.render(row, { actionsParent: row });
  row.addEventListener('click', (event) => {
    if ((event.target as Element | null)?.closest('button, a, input, select, textarea')) return;
    ctx.state.set('projectsPanel', { view: 'dashboard', path: project.path });
  });
  return row;
}
