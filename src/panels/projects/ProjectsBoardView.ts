import { Menu } from 'obsidian';
import type { ProjectPropertyCommandResult } from '../../projects/ProjectCommandService';
import type { ProjectWorkspaceSnapshot } from '../../projects/types';
import { showMenuAtMouseEventWithFocus } from '../../ui/nativeMenuFocus';
import type { BoardColumn, BoardMutation, BoardMutationResult } from './boardProjection';
import { createProjectBoardMutation, projectBoardColumns } from './boardProjection';
import { BoundedWindow } from './BoundedWindow';
import { renderProjectRow } from './ProjectsListView';
import type { ProjectsListContext } from './viewContext';

const BOARD_ITEM_EXTENT = 88;
const BOARD_FALLBACK_VISIBLE_ITEMS = 10;
const BOARD_OVERSCAN = 4;

export interface BoardViewOptions<T> {
  readonly columns: readonly BoardColumn<T>[];
  readonly mutation: BoardMutation<T>;
  readonly itemKey: (item: T) => string;
  readonly renderItem: (host: HTMLElement, item: T) => HTMLElement;
  readonly visibleColumnKeys?: ReadonlySet<string>;
  readonly manageStatusMenu?: boolean;
  readonly onMutation?: (item: T, columnKey: string, result: BoardMutationResult) => void;
  readonly undo?: (
    item: T,
    columnKey: string,
    result: BoardMutationResult,
  ) => Promise<BoardMutationResult>;
}

export interface BoardViewHandle {
  destroy(): void;
}

function successful(result: BoardMutationResult): boolean {
  return result === undefined || result.type === 'ok';
}

function isProjectStatusMove(
  result: BoardMutationResult,
): result is Extract<ProjectPropertyCommandResult, { type: 'ok' }> {
  return result !== undefined && result.type === 'ok' && 'nextStatusId' in result;
}

/** Semantically neutral, bounded Kanban shell shared by Project and Task adapters. */
/* eslint-disable sonarjs/no-nested-functions -- Per-column DOM listeners share the bounded window lifecycle. */
export function renderBoard<T>(
  container: HTMLElement,
  options: BoardViewOptions<T>,
): BoardViewHandle {
  container.addClass('abyss-board');
  const overrides = new Map<string, string>();
  let dragging: T | null = null;
  let selectedColumnKey =
    options.columns.find((column) => options.visibleColumnKeys?.has(column.key) !== false)?.key ??
    options.columns[0]?.key ??
    '';
  let destroyed = false;
  let undoPending: {
    readonly item: T;
    readonly columnKey: string;
    readonly result: BoardMutationResult;
  } | null = null;
  const cleanups: Array<() => void> = [];

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

  const commitMove = (item: T, columnKey: string): void => {
    void options.mutation.move(item, columnKey).then((result) => {
      if (!successful(result)) return;
      overrides.set(options.itemKey(item), columnKey);
      dragging = null;
      if (options.undo) undoPending = { item, columnKey, result };
      options.onMutation?.(item, columnKey, result);
      render();
    });
  };

  const render = (): void => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    container.empty();
    if (undoPending && options.undo) {
      const pending = undoPending;
      const undo = container.createEl('button', {
        cls: 'abyss-board-undo',
        text: 'Undo',
        attr: { type: 'button', 'data-board-undo': '' },
      });
      undo.addEventListener('click', () => {
        void options.undo?.(pending.item, pending.columnKey, pending.result).then((result) => {
          if (!successful(result)) return;
          overrides.delete(options.itemKey(pending.item));
          undoPending = null;
          render();
        });
      });
    }
    const tabs = container.createDiv({
      cls: 'abyss-board-column-tabs',
      attr: { role: 'tablist', 'aria-label': 'Board columns' },
    });
    const board = container.createDiv({ cls: 'abyss-board-columns' });

    const setDraggingState = (active: boolean): void => {
      board.classList.toggle('is-drag-active', active);
      board
        .querySelectorAll<HTMLElement>('.abyss-board-column[data-terminal-filtered="true"]')
        .forEach((column) => column.classList.toggle('is-collapsed', !active));
    };

    for (const column of options.columns) {
      const visible = options.visibleColumnKeys?.has(column.key) !== false;
      const terminal = column.role === 'terminal-left' || column.role === 'terminal-right';
      if (!visible && !terminal) continue;
      const tab = tabs.createEl('button', {
        cls: `abyss-board-column-tab${selectedColumnKey === column.key ? ' is-active' : ''}`,
        text: column.label,
        attr: {
          type: 'button',
          role: 'tab',
          'aria-selected': String(selectedColumnKey === column.key),
          'data-board-column-tab': column.key,
        },
      });
      tab.addEventListener('click', () => {
        selectedColumnKey = column.key;
        render();
      });

      const columnEl = board.createDiv({
        cls: `abyss-board-column${selectedColumnKey === column.key ? ' is-active' : ''}${
          !visible && terminal ? ' is-collapsed' : ''
        }`,
        attr: {
          'data-board-column': column.key,
          'data-board-column-role': column.role,
          ...(terminal && !visible ? { 'data-terminal-filtered': 'true' } : {}),
        },
      });
      const items = visible ? projectedItems(column) : [];
      const header = columnEl.createDiv({ cls: 'abyss-board-column-header' });
      header.createSpan({ cls: 'abyss-board-column-label', text: column.label });
      header.createSpan({ cls: 'abyss-board-column-count', text: String(items.length) });
      const scroll = columnEl.createDiv({ cls: 'abyss-board-column-scroll' });
      const itemsHost = scroll.createDiv({
        cls: 'abyss-board-items',
        attr: { tabindex: '-1', 'aria-label': `${column.label} items` },
      });
      const keys = items.map(options.itemKey);
      const bounded = new BoundedWindow(keys, BOARD_OVERSCAN);
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
            if (itemEl.tabIndex < 0) itemEl.tabIndex = 0;
            itemEl.setAttribute('draggable', 'true');
            itemEl.addEventListener('focus', () => bounded.focus(key));
            itemEl.addEventListener('keydown', (event) => {
              if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
              event.preventDefault();
              bounded.focus(key);
              if (bounded.move(event.key === 'ArrowDown' ? 1 : -1) === null) return;
              const nextFirst = bounded.viewportForFocus(viewport());
              scroll.scrollTop = nextFirst * BOARD_ITEM_EXTENT;
              renderWindow(true);
            });
            itemEl.addEventListener('dragstart', () => {
              dragging = item;
              setDraggingState(true);
            });
            itemEl.addEventListener('dragend', () => {
              dragging = null;
              setDraggingState(false);
            });
            if (options.manageStatusMenu !== false) {
              itemEl.addEventListener('contextmenu', (event) => {
                const actions = options.mutation.menuItems(item);
                if (actions.length === 0) return;
                event.preventDefault();
                const menu = new Menu();
                for (const action of actions) {
                  menu.addItem((menuItem) =>
                    menuItem
                      .setTitle(action.label)
                      .setIcon(action.icon)
                      .setChecked(action.checked)
                      .setDisabled(action.disabled)
                      .onClick(() => commitMove(item, action.columnKey)),
                  );
                }
                showMenuAtMouseEventWithFocus(menu, event);
              });
            }
            return itemEl;
          },
        });
        if (restoreFocus) scroll.scrollTop = result.first * BOARD_ITEM_EXTENT;
      };
      const onScroll = (): void => renderWindow(false);
      scroll.addEventListener('scroll', onScroll);
      cleanups.push(() => scroll.removeEventListener('scroll', onScroll));
      renderWindow();

      columnEl.addEventListener('dragover', (event) => {
        if (dragging === null || (!visible && !terminal)) return;
        event.preventDefault();
        columnEl.addClass('is-drop-target');
      });
      columnEl.addEventListener('dragleave', () => columnEl.removeClass('is-drop-target'));
      columnEl.addEventListener('drop', (event) => {
        const item = dragging;
        if (item === null) return;
        event.preventDefault();
        columnEl.removeClass('is-drop-target');
        commitMove(item, column.key);
      });
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

export interface ProjectsBoardOptions extends ProjectsListContext {
  readonly snapshots: readonly ProjectWorkspaceSnapshot[];
  readonly onMoveStatus: (path: string, statusId: string) => Promise<ProjectPropertyCommandResult>;
  readonly onUndoStatus: (
    path: string,
    expectedStatusId: string,
    previousStatusId: string | null,
  ) => Promise<ProjectPropertyCommandResult>;
}

/** Adapts Project lifecycle records to the shared board shell. */
export function renderProjectsBoard(
  container: HTMLElement,
  options: ProjectsBoardOptions,
): BoardViewHandle {
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
  const mutation = createProjectBoardMutation(statuses, (project, statusId) =>
    options.onMoveStatus(project.path, statusId),
  );
  return renderBoard(container, {
    columns: projectBoardColumns(statuses, projects),
    visibleColumnKeys,
    mutation,
    undo: (project, _columnKey, result) => {
      if (!isProjectStatusMove(result)) return Promise.resolve(result);
      return options.onUndoStatus(project.path, result.nextStatusId, result.previousStatusId);
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
      );
    },
  });
}
