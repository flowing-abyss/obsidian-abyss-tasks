import { Menu, setIcon } from 'obsidian';
import type { ProjectPropertyCommandResult } from '../../projects/ProjectCommandService';
import type { ProjectWorkspaceSnapshot } from '../../projects/types';
import type {
  WorkNoteCommandResult,
  WorkNoteSnapshot,
  WorkNoteStatusDefinition,
} from '../../projects/work-notes/types';
import { showMenuAtMouseEventWithFocus } from '../../ui/nativeMenuFocus';
import type { BoardColumn, BoardMutation, BoardMutationResult } from './boardProjection';
import {
  createProjectBoardMutation,
  createWorkNoteBoardMutation,
  projectBoardColumns,
  workNoteBoardColumns,
} from './boardProjection';
import { BoundedWindow } from './BoundedWindow';
import {
  focusExistingProjectCapture,
  renderProjectRow,
  showNewProjectInput,
} from './ProjectsListView';
import { renderProjectsToolbar } from './ProjectsToolbar';
import type { LogicalViewportSession, WorkNoteBoardSession } from './ProjectWorkspaceSession';
import { boardColumnViewport, logicalViewportFirst } from './ProjectWorkspaceSession';
import type { ProjectsListContext } from './viewContext';

const BOARD_ITEM_EXTENT = 88;
const BOARD_FALLBACK_VISIBLE_ITEMS = 10;
const BOARD_OVERSCAN = 4;
let nextBoardId = 0;

export interface BoardViewOptions<T> {
  readonly columns: readonly BoardColumn<T>[];
  readonly mutation: BoardMutation<T>;
  readonly itemKey: (item: T) => string;
  readonly renderItem: (host: HTMLElement, item: T) => HTMLElement;
  readonly visibleColumnKeys?: ReadonlySet<string>;
  readonly manageStatusMenu?: boolean;
  readonly mutationEnabled?: boolean;
  readonly mutationDisabledTitle?: string;
  readonly onMutation?: (item: T, columnKey: string, result: BoardMutationResult) => void;
  readonly executeMutation?: (
    command: () => Promise<BoardMutationResult>,
    initiator: HTMLElement,
  ) => Promise<BoardMutationResult>;
  readonly session?: WorkNoteBoardSession;
  /** Semantic collection focus owned outside Board geometry (for Project Tasks). */
  readonly focusedItemKey?: () => string | null;
  readonly shouldRestoreItemFocus?: () => boolean;
  readonly onItemFocus?: (item: T) => void;
  readonly onItemBlur?: () => void;
  readonly initialUndo?: {
    readonly item: T;
    readonly columnKey: string;
    readonly result: BoardMutationResult;
  };
  readonly initialUndoInFlight?: boolean;
  readonly undo?: (
    item: T,
    columnKey: string,
    result: BoardMutationResult,
  ) => Promise<BoardMutationResult>;
}

export interface BoardViewHandle {
  destroy(): void;
}

export interface WorkNotesBoardOptions {
  readonly notes: readonly WorkNoteSnapshot[];
  readonly statuses: readonly WorkNoteStatusDefinition[];
  readonly onMoveStatus: (
    note: WorkNoteSnapshot,
    statusId: string,
  ) => Promise<WorkNoteCommandResult>;
  readonly renderItem: (host: HTMLElement, note: WorkNoteSnapshot) => HTMLElement;
  readonly executeMutation?: (
    command: () => Promise<WorkNoteCommandResult>,
    initiator: HTMLElement,
  ) => Promise<WorkNoteCommandResult>;
  readonly session?: WorkNoteBoardSession;
  readonly commandsEnabled?: boolean;
}

function successful(result: BoardMutationResult): boolean {
  return result !== undefined && result.type === 'ok' && (!('changed' in result) || result.changed);
}

function isProjectStatusMove(
  result: BoardMutationResult,
): result is Extract<ProjectPropertyCommandResult, { type: 'ok' }> {
  return result !== undefined && result.type === 'ok' && 'nextStatusId' in result;
}

function adjacentTabIndex(key: string, current: number, count: number): number | null {
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key === 'ArrowLeft') return Math.max(0, current - 1);
  if (key === 'ArrowRight') return Math.min(count - 1, current + 1);
  return null;
}

function boardPanelLabel(
  visible: boolean,
  tabId: string,
  label: string,
): Readonly<Record<string, string>> {
  return visible ? { 'aria-labelledby': tabId } : { 'aria-label': label };
}

/** Semantically neutral, bounded Kanban shell shared by Project and Task adapters. */
/* eslint-disable sonarjs/no-nested-functions -- Per-column DOM listeners share the bounded window lifecycle. */
export function renderBoard<T>(
  container: HTMLElement,
  options: BoardViewOptions<T>,
): BoardViewHandle {
  container.addClass('abyss-board');
  const boardId = `abyss-board-${String(++nextBoardId)}`;
  const overrides = new Map<string, string>();
  let dragging: { readonly item: T; readonly initiator: HTMLElement } | null = null;
  const selectedFromSession = options.session?.selectedColumnKey;
  let selectedColumnKey =
    options.columns.find(
      (column) =>
        column.key === selectedFromSession && options.visibleColumnKeys?.has(column.key) !== false,
    )?.key ??
    options.columns.find((column) => options.visibleColumnKeys?.has(column.key) !== false)?.key ??
    options.columns[0]?.key ??
    '';
  if (options.session) options.session.selectedColumnKey = selectedColumnKey;
  let destroyed = false;
  let undoPending: {
    readonly item: T;
    readonly columnKey: string;
    readonly result: BoardMutationResult;
  } | null = options.initialUndo ?? null;
  let undoInFlight = options.initialUndoInFlight === true;
  const cleanups: Array<() => void> = [];

  const showStatusMenu = (event: MouseEvent, item: T, initiator: HTMLElement): void => {
    if (undoInFlight || options.mutationEnabled === false) return;
    const actions = options.mutation.menuItems(item);
    if (actions.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const menu = new Menu();
    for (const action of actions) {
      menu.addItem((menuItem) =>
        menuItem
          .setTitle(action.label)
          .setIcon(action.icon)
          .setChecked(action.checked)
          .setDisabled(action.disabled)
          .onClick(() => commitMove(item, action.columnKey, initiator)),
      );
    }
    showMenuAtMouseEventWithFocus(menu, event);
  };

  const projectedItems = (column: BoardColumn<T>): readonly T[] => {
    const retained = column.items.filter((item) => {
      const target = overrides.get(options.itemKey(item));
      return target === undefined || target === column.key;
    });
    const moved = options.columns.flatMap((source) =>
      source.items.filter((item) => overrides.get(options.itemKey(item)) === column.key),
    );
    const seen = new Set<string>();
    return [...retained, ...moved].filter((item) => {
      const key = options.itemKey(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  const commitMove = (item: T, columnKey: string, initiator: HTMLElement): void => {
    if (undoInFlight || options.mutationEnabled === false) return;
    if (options.session) {
      options.session.focusedKey = options.itemKey(item);
      options.session.restoreFocus = true;
    }
    const command = (): Promise<BoardMutationResult> => options.mutation.move(item, columnKey);
    const pending = options.executeMutation?.(command, initiator) ?? command();
    void pending
      .then((result) => {
        if (destroyed) return;
        if (!successful(result)) return;
        overrides.set(options.itemKey(item), columnKey);
        dragging = null;
        if (options.undo) undoPending = { item, columnKey, result };
        options.onMutation?.(item, columnKey, result);
        render();
      })
      .catch(() => undefined);
  };

  const renderUndo = (host: HTMLElement): void => {
    if (!undoPending || !options.undo) return;
    const pending = undoPending;
    const undo = host.createEl('button', {
      cls: 'abyss-board-undo',
      text: 'Undo',
      attr: { type: 'button', 'data-board-undo': '' },
    });
    undo.disabled = undoInFlight;
    undo.setAttribute('aria-disabled', String(undoInFlight));
    if (undoInFlight) undo.setAttribute('aria-busy', 'true');
    undo.addEventListener('click', () => {
      if (undoInFlight) return;
      undoInFlight = true;
      undo.disabled = true;
      undo.setAttribute('aria-disabled', 'true');
      render();
      container.querySelector<HTMLElement>('.abyss-board-toolbar')?.focus({ preventScroll: true });
      void options
        .undo?.(pending.item, pending.columnKey, pending.result)
        .then((result) => {
          if (destroyed) return;
          if (successful(result)) {
            overrides.delete(options.itemKey(pending.item));
            undoPending = null;
          }
        })
        .catch(() => undefined)
        .finally(() => {
          if (destroyed) return;
          undoInFlight = false;
          render();
        });
    });
  };

  const render = (): void => {
    const focusedTabKey =
      container.ownerDocument.activeElement?.getAttribute('data-board-column-tab');
    for (const cleanup of cleanups.splice(0)) cleanup();
    container.empty();
    container.toggleAttribute('aria-busy', undoInFlight);
    const toolbar = container.createDiv({
      cls: 'abyss-board-toolbar',
      attr: { tabindex: '-1' },
    });
    toolbar.createDiv({
      cls: 'abyss-board-undo-status',
      text: undoInFlight ? 'Undoing status change…' : '',
      attr: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
    });
    renderUndo(toolbar);
    const tabs = container.createDiv({
      cls: 'abyss-board-column-tabs',
      attr: { role: 'tablist', 'aria-label': 'Board columns' },
    });
    const board = container.createDiv({ cls: 'abyss-board-columns' });
    const tabColumns = options.columns.filter(
      (column) => options.visibleColumnKeys?.has(column.key) !== false,
    );

    const setDraggingState = (active: boolean): void => {
      board.classList.toggle('is-drag-active', active);
      board
        .querySelectorAll<HTMLElement>('.abyss-board-column[data-terminal-filtered="true"]')
        .forEach((column) => {
          column.classList.toggle('is-collapsed', !active);
          if (!active) {
            delete column.dataset['boardTerminalDragZone'];
            return;
          }
          column.dataset['boardTerminalDragZone'] =
            column.dataset['boardColumnRole'] === 'terminal-left' ? 'left' : 'right';
        });
    };

    for (const column of options.columns) {
      const visible = options.visibleColumnKeys?.has(column.key) !== false;
      const terminal = column.role === 'terminal-left' || column.role === 'terminal-right';
      if (!visible && !terminal) continue;
      if (visible || !terminal) {
        const tabId = `${boardId}-tab-${column.key.replace(/[^a-zA-Z0-9_-]/gu, '-')}`;
        const panelId = `${boardId}-panel-${column.key.replace(/[^a-zA-Z0-9_-]/gu, '-')}`;
        const tab = tabs.createEl('button', {
          cls: `abyss-board-column-tab${selectedColumnKey === column.key ? ' is-active' : ''}`,
          text: column.label,
          attr: {
            type: 'button',
            role: 'tab',
            id: tabId,
            tabindex: selectedColumnKey === column.key ? '0' : '-1',
            'aria-controls': panelId,
            'aria-selected': String(selectedColumnKey === column.key),
            'data-board-column-tab': column.key,
          },
        });
        tab.addEventListener('click', () => {
          selectedColumnKey = column.key;
          if (options.session) options.session.selectedColumnKey = column.key;
          render();
        });
        tab.addEventListener('keydown', (event) => {
          const current = tabColumns.findIndex(({ key }) => key === column.key);
          const next = adjacentTabIndex(event.key, current, tabColumns.length);
          if (next === null) return;
          event.preventDefault();
          const nextColumn = tabColumns[next];
          if (!nextColumn) return;
          selectedColumnKey = nextColumn.key;
          if (options.session) options.session.selectedColumnKey = nextColumn.key;
          render();
          container
            .querySelector<HTMLElement>(`[data-board-column-tab="${nextColumn.key}"]`)
            ?.focus({ preventScroll: true });
        });
      }

      const columnToken = column.key.replace(/[^a-zA-Z0-9_-]/gu, '-');
      const columnEl = board.createDiv({
        cls: `abyss-board-column${selectedColumnKey === column.key ? ' is-active' : ''}${
          !visible && terminal ? ' is-collapsed' : ''
        }`,
        attr: {
          'data-board-column': column.key,
          'data-board-column-role': column.role,
          'data-selected-column': String(selectedColumnKey === column.key),
          role: 'tabpanel',
          id: `${boardId}-panel-${columnToken}`,
          ...boardPanelLabel(visible, `${boardId}-tab-${columnToken}`, column.label),
          ...(terminal && !visible ? { 'data-terminal-filtered': 'true' } : {}),
        },
      });
      const items = visible ? projectedItems(column) : [];
      const header = columnEl.createDiv({ cls: 'abyss-board-column-header' });
      header.createSpan({ cls: 'abyss-board-column-label', text: column.label });
      header.createSpan({
        cls: 'abyss-board-column-count',
        text: String(items.length),
        attr: {
          'aria-label': `${String(items.length)} item${items.length === 1 ? '' : 's'} in ${column.label}`,
        },
      });
      const scroll = columnEl.createDiv({ cls: 'abyss-board-column-scroll' });
      const itemsHost = scroll.createDiv({
        cls: 'abyss-board-items',
        attr: { tabindex: '-1', 'aria-label': `${column.label} items` },
      });
      const keys = items.map(options.itemKey);
      const bounded = new BoundedWindow(keys, BOARD_OVERSCAN);
      const sessionColumn: LogicalViewportSession | undefined = boardColumnViewport(
        options.session,
        column.key,
      );
      const focusedKey = options.focusedItemKey?.() ?? options.session?.focusedKey;
      if (focusedKey) bounded.focus(focusedKey);
      const initialFirst = logicalViewportFirst(sessionColumn, keys);
      scroll.scrollTop = initialFirst * BOARD_ITEM_EXTENT;
      const viewport = (): { first: number; visible: number } => {
        const first = Math.floor(Math.max(0, scroll.scrollTop) / BOARD_ITEM_EXTENT);
        const visibleItems =
          scroll.clientHeight > 0
            ? Math.ceil(scroll.clientHeight / BOARD_ITEM_EXTENT)
            : BOARD_FALLBACK_VISIBLE_ITEMS;
        return { first, visible: visibleItems };
      };
      const renderWindow = (restoreFocus = false): void => {
        if (destroyed) return;
        const result = bounded.render(itemsHost, {
          ...viewport(),
          itemExtent: BOARD_ITEM_EXTENT,
          restoreFocus,
          render: (host, key, logicalIndex) => {
            const item = items[logicalIndex]!;
            const itemEl = options.renderItem(host, item);
            itemEl.dataset['boardItem'] = key;
            const itemIsInteractive = itemEl.matches(
              'button, a[href], input, select, textarea, [role="button"], [role="checkbox"], [tabindex]:not([tabindex="-1"])',
            );
            if (!itemIsInteractive) itemEl.setAttribute('role', 'group');
            const focusTarget =
              (itemIsInteractive
                ? itemEl
                : itemEl.querySelector<HTMLElement>(
                    '[data-project-identity-control], [data-work-note-identity-control], .abyss-status-marker[role="checkbox"], button, a[href], input, select, textarea',
                  )) ?? itemEl;
            if (focusTarget.tabIndex < 0) focusTarget.tabIndex = 0;
            focusTarget.dataset['boardItemFocus'] = key;
            focusTarget.dataset['boardItem'] = key;
            const mutationLocked = undoInFlight || options.mutationEnabled === false;
            itemEl.setAttribute('draggable', String(!mutationLocked));
            focusTarget.addEventListener('focus', () => {
              bounded.focus(key);
              options.onItemFocus?.(item);
              if (options.session) {
                options.session.focusedKey = key;
                options.session.restoreFocus = true;
              }
            });
            focusTarget.addEventListener('keydown', (event) => {
              if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
              event.preventDefault();
              bounded.focus(key);
              if (bounded.move(event.key === 'ArrowDown' ? 1 : -1) === null) return;
              const nextFirst = bounded.viewportForFocus(viewport());
              scroll.scrollTop = nextFirst * BOARD_ITEM_EXTENT;
              renderWindow(true);
            });
            itemEl.addEventListener('dragstart', () => {
              if (mutationLocked) return;
              dragging = { item, initiator: focusTarget };
              setDraggingState(true);
            });
            itemEl.addEventListener('dragend', () => {
              dragging = null;
              setDraggingState(false);
            });
            if (options.manageStatusMenu !== false) {
              itemEl.addEventListener('contextmenu', (event) => {
                showStatusMenu(event, item, focusTarget);
              });
              const statusMenu = itemEl.createEl('button', {
                cls: 'abyss-board-status-menu',
                attr: {
                  type: 'button',
                  'data-board-status-menu': key,
                  'aria-label': 'Change status',
                  title:
                    options.mutationEnabled === false
                      ? (options.mutationDisabledTitle ?? 'Status changes are unavailable')
                      : 'Change status',
                },
              });
              statusMenu.disabled = mutationLocked;
              statusMenu.setAttribute('aria-disabled', String(mutationLocked));
              if (focusTarget === itemEl) host.appendChild(statusMenu);
              setIcon(statusMenu, 'ellipsis');
              statusMenu.addEventListener('click', (event) =>
                showStatusMenu(event, item, statusMenu),
              );
            }
            return focusTarget;
          },
        });
        if (restoreFocus) scroll.scrollTop = result.first * BOARD_ITEM_EXTENT;
      };
      const rememberViewport = (): void => {
        if (!sessionColumn) return;
        sessionColumn.firstIndex = viewport().first;
        sessionColumn.firstKey = keys[sessionColumn.firstIndex] ?? null;
      };
      const onScroll = (): void => {
        rememberViewport();
        renderWindow(false);
      };
      scroll.addEventListener('scroll', onScroll);
      cleanups.push(() => scroll.removeEventListener('scroll', onScroll));
      const onFocusOut = (): void => {
        queueMicrotask(() => {
          if (!container.isConnected || container.contains(container.ownerDocument.activeElement)) {
            return;
          }
          if (options.session) options.session.restoreFocus = false;
          options.onItemBlur?.();
        });
      };
      itemsHost.addEventListener('focusout', onFocusOut);
      cleanups.push(() => itemsHost.removeEventListener('focusout', onFocusOut));
      renderWindow(
        (options.shouldRestoreItemFocus?.() ?? options.session?.restoreFocus === true) &&
          focusedKey !== undefined &&
          focusedKey !== null &&
          keys.includes(focusedKey),
      );
      rememberViewport();

      columnEl.addEventListener('dragover', (event) => {
        if (dragging === null || (!visible && !terminal)) return;
        event.preventDefault();
        columnEl.addClass('is-drop-target');
      });
      columnEl.addEventListener('dragleave', () => columnEl.removeClass('is-drop-target'));
      columnEl.addEventListener('drop', (event) => {
        if (undoInFlight || options.mutationEnabled === false) return;
        const dragged = dragging;
        if (dragged === null) return;
        event.preventDefault();
        columnEl.removeClass('is-drop-target');
        commitMove(dragged.item, column.key, dragged.initiator);
      });
    }
    if (focusedTabKey !== null) {
      Array.from(container.querySelectorAll<HTMLElement>('[data-board-column-tab]'))
        .find(({ dataset }) => dataset['boardColumnTab'] === focusedTabKey)
        ?.focus({ preventScroll: true });
    }
  };

  render();
  return {
    destroy: () => {
      destroyed = true;
      for (const cleanup of cleanups.splice(0)) cleanup();
      container.empty();
    },
  };
}
/* eslint-enable sonarjs/no-nested-functions */

/** Adapts guarded Work Note status commands to the shared bounded board and menu model. */
export function renderWorkNotesBoard(
  container: HTMLElement,
  options: WorkNotesBoardOptions,
): BoardViewHandle {
  const mutation = createWorkNoteBoardMutation(options.statuses, options.onMoveStatus);
  return renderBoard(container, {
    columns: workNoteBoardColumns(options.statuses, options.notes),
    mutation,
    itemKey: ({ path }) => path,
    renderItem: options.renderItem,
    session: options.session,
    mutationEnabled: options.commandsEnabled,
    mutationDisabledTitle: 'Requires an accepted compatibility audit with update capability',
    executeMutation:
      options.executeMutation === undefined
        ? undefined
        : (command, initiator) =>
            options.executeMutation!(
              async () => (await command()) as WorkNoteCommandResult,
              initiator,
            ),
  });
}

export interface ProjectsBoardOptions extends ProjectsListContext {
  readonly snapshots: readonly ProjectWorkspaceSnapshot[];
  readonly onMoveStatus: (path: string, statusId: string) => Promise<ProjectPropertyCommandResult>;
  readonly onUndoStatus: (
    path: string,
    expectedStatusId: string,
    previousStatusId: string | null,
  ) => Promise<ProjectPropertyCommandResult>;
  readonly pendingUndo?: {
    readonly path: string;
    readonly columnKey: string;
    readonly result: Extract<ProjectPropertyCommandResult, { type: 'ok' }>;
    readonly undoInFlight?: boolean;
  };
  readonly onUndoPending?: (pending: NonNullable<ProjectsBoardOptions['pendingUndo']>) => void;
  readonly onUndoStarted?: (pending: NonNullable<ProjectsBoardOptions['pendingUndo']>) => void;
  readonly onUndoResolved?: (
    pending: NonNullable<ProjectsBoardOptions['pendingUndo']>,
    successful: boolean,
  ) => void;
  readonly session?: WorkNoteBoardSession;
}

/** Adapts Project lifecycle records to the shared board shell. */
export function renderProjectsBoard(
  container: HTMLElement,
  options: ProjectsBoardOptions,
): BoardViewHandle {
  let destroyed = false;
  const toolbar = renderProjectsToolbar(container, options);
  const { newProjectButton } = toolbar;
  const boardHost = container.createDiv();
  const captureSession = options.captureSession ?? {
    open: false,
    draft: '',
    pending: false,
    createdPath: null,
  };
  let captureCleanup: (() => void) | undefined;
  const openCapture = (): void => {
    captureSession.open = true;
    if (focusExistingProjectCapture(toolbar.captureHost)) return;
    captureCleanup?.();
    captureCleanup = showNewProjectInput(toolbar.captureHost, options.onCreate, {
      session: captureSession,
      trigger: newProjectButton,
      liveRegion: toolbar.liveRegion,
      openNote: options.openNote,
      onSettled: options.onCaptureSettled,
    });
  };
  newProjectButton.addEventListener('click', openCapture);
  if (captureSession.open) openCapture();
  const statuses = options.settings.projects.statuses;
  const snapshots = options.snapshots.map((snapshot) => ({
    ...snapshot,
    project: { ...snapshot.project, stats: snapshot.taskRollup },
  }));
  const snapshotByPath = new Map(snapshots.map((snapshot) => [snapshot.project.path, snapshot]));
  const projects = snapshots.map(({ project }) => project);
  const nameCounts = new Map<string, number>();
  for (const project of projects) {
    nameCounts.set(project.name, (nameCounts.get(project.name) ?? 0) + 1);
  }
  const statusById = new Map(statuses.map((status) => [status.id, status]));
  const visibleColumnKeys = new Set(options.settings.projects.view.visibleStatusIds);
  if (options.settings.projects.view.includeUnmapped) visibleColumnKeys.add('unmapped');
  const createdProject = projects.find(({ path }) => path === captureSession.createdPath);
  if (createdProject?.statusId) visibleColumnKeys.add(createdProject.statusId);
  else if (createdProject) visibleColumnKeys.add('unmapped');
  const columns = projectBoardColumns(statuses, projects);
  if (createdProject && options.session) {
    const createdColumn = columns.find((column) =>
      column.items.some(({ path }) => path === createdProject.path),
    );
    if (createdColumn) {
      const createdIndex = createdColumn.items.findIndex(
        ({ path }) => path === createdProject.path,
      );
      options.session.selectedColumnKey = createdColumn.key;
      options.session.focusedKey = createdProject.path;
      options.session.restoreFocus = true;
      const columnViewport = boardColumnViewport(options.session, createdColumn.key);
      if (columnViewport) {
        columnViewport.firstKey = createdProject.path;
        columnViewport.firstIndex = createdIndex;
        columnViewport.focusedKey = createdProject.path;
        columnViewport.restoreFocus = true;
      }
    }
  }
  const mutation = createProjectBoardMutation(statuses, (project, statusId) =>
    options.onMoveStatus(project.path, statusId),
  );
  const pendingUndo = options.pendingUndo;
  const initialUndo =
    pendingUndo === undefined
      ? undefined
      : (() => {
          const item = projects.find((project) => project.path === pendingUndo.path);
          return item ? { ...pendingUndo, item } : undefined;
        })();
  if (pendingUndo && !initialUndo) {
    queueMicrotask(() => {
      if (!destroyed) options.onUndoResolved?.(pendingUndo, true);
    });
  }
  const board = renderBoard(boardHost, {
    columns,
    visibleColumnKeys,
    mutation,
    undo: (project, columnKey, result) => {
      if (!isProjectStatusMove(result)) return Promise.resolve(result);
      const operation = { path: project.path, columnKey, result };
      options.onUndoStarted?.(operation);
      return options
        .onUndoStatus(project.path, result.nextStatusId, result.previousStatusId)
        .then((undoResult) => {
          options.onUndoResolved?.(operation, successful(undoResult));
          return undoResult;
        })
        .catch((error: unknown) => {
          options.onUndoResolved?.(operation, false);
          throw error;
        });
    },
    initialUndo,
    initialUndoInFlight: pendingUndo?.undoInFlight,
    onMutation: (project, columnKey, result) => {
      if (!isProjectStatusMove(result)) return;
      options.onUndoPending?.({ path: project.path, columnKey, result });
    },
    itemKey: (project) => project.path,
    renderItem: (host, project) => {
      const snapshot = snapshotByPath.get(project.path);
      if (!snapshot) return host.createDiv();
      return renderProjectRow(
        host,
        snapshot,
        statusById,
        statuses,
        nameCounts,
        options,
        () => undefined,
        () => undefined,
        false,
        false,
      );
    },
    session: options.session,
  });
  if (captureSession.createdPath) {
    const createdPath = captureSession.createdPath;
    queueMicrotask(() => {
      if (destroyed) return;
      const row = Array.from(boardHost.querySelectorAll<HTMLElement>('[data-project-path]')).find(
        ({ dataset }) => dataset['projectPath'] === createdPath,
      );
      row?.addClass('is-just-created');
      row?.querySelector<HTMLElement>('[data-project-identity-control]')?.focus({
        preventScroll: true,
      });
      row?.scrollIntoView?.({ block: 'nearest' });
      if (row) captureSession.createdPath = null;
    });
  }
  return {
    destroy: () => {
      destroyed = true;
      captureCleanup?.();
      toolbar.destroy();
      board.destroy();
    },
  };
}
