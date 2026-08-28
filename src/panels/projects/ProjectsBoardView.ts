import { Menu, setIcon } from 'obsidian';
import { validateLifecycleConfiguration } from '../../projects/lifecycle';
import type { ProjectPropertyCommandResult } from '../../projects/ProjectCommandService';
import type { ProjectWorkspaceSnapshot } from '../../projects/types';
import type {
  WorkNoteCommandResult,
  WorkNoteSnapshot,
  WorkNoteStatusDefinition,
} from '../../projects/work-notes/types';
import { showMenuAtMouseEventWithFocus } from '../../ui/nativeMenuFocus';
import {
  BoardInteractionController,
  type BoardAnnouncement,
  type BoardDestinationGeometry,
  type BoardObservedPosition,
  type BoardRect,
  type BoardRenderProjection,
} from './BoardInteractionController';
import type { BoardViewPreference } from './boardPreferences';
import {
  collapseBoardColumn,
  hideBoardColumn,
  moveBoardColumn,
  reconcileBoardPreference,
  resetBoardPreference,
  restoreBoardColumn,
} from './boardPreferences';
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
  readonly columnPreferences?: {
    readonly value: BoardViewPreference;
    readonly onChange: (next: BoardViewPreference) => void | Promise<void>;
    readonly terminalLeftIds: readonly string[];
    readonly terminalRightIds: readonly string[];
  };
  /** Opts only the Portfolio renderer into Task 5's pointer/keyboard interaction adapter. */
  readonly interactionController?: boolean;
  readonly itemLabel?: (item: T) => string;
  readonly announce?: (message: string) => void;
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

function boardRect(rect: DOMRect): BoardRect {
  return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
}

function boardAnnouncementText(
  announcement: BoardAnnouncement<string, string>,
  labelForColumn: (columnId: string) => string,
): string {
  switch (announcement.type) {
    case 'pickup':
      return `Picked up item from ${labelForColumn(announcement.sourceColumnId)}`;
    case 'destination':
      return announcement.destination.kind === 'hidden-disclosure'
        ? 'Hidden columns available'
        : `${labelForColumn(announcement.destination.columnId)}, position ${String((announcement.position ?? 0) + 1)}`;
    case 'commit-pending':
      return 'Moving item';
    case 'success':
      return 'Item moved';
    case 'cancel':
      return 'Move cancelled';
    case 'conflict':
      return announcement.reason ?? 'Item changed outside the board';
    case 'failure':
      return announcement.reason ?? 'Item could not be moved';
    case 'undo-available':
      return 'Move complete. Undo available';
    case 'undo-success':
      return 'Move undone';
    case 'undo-conflict':
      return announcement.reason ?? 'Undo refused because the item changed';
    case 'undo-failure':
      return announcement.reason ?? 'Undo failed';
  }
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
  const configuredColumnIds = options.columns
    .filter(({ role }) => role !== 'unmapped')
    .map(({ key }) => key);
  const preferenceRoles = options.columnPreferences
    ? {
        terminalLeftIds: options.columnPreferences.terminalLeftIds,
        terminalRightIds: options.columnPreferences.terminalRightIds,
      }
    : undefined;
  let columnPreference = options.columnPreferences
    ? reconcileBoardPreference(
        options.columnPreferences.value,
        configuredColumnIds,
        preferenceRoles,
      )
    : undefined;
  const initialTerminalDefaultsApplied =
    options.columnPreferences?.value['terminalDefaultsApplied'] === true;
  if (columnPreference && !initialTerminalDefaultsApplied) {
    columnPreference = {
      ...columnPreference,
      terminalDefaultsApplied: true,
      collapsedColumnIds: [
        ...new Set([
          ...columnPreference.collapsedColumnIds,
          ...(preferenceRoles?.terminalLeftIds ?? []),
          ...(preferenceRoles?.terminalRightIds ?? []),
        ]),
      ],
    };
    void options.columnPreferences?.onChange(columnPreference);
  } else if (
    columnPreference &&
    JSON.stringify(columnPreference) !== JSON.stringify(options.columnPreferences?.value)
  ) {
    void options.columnPreferences?.onChange(columnPreference);
  }
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
  type UndoAuthority = {
    readonly item: T;
    readonly columnKey: string;
    readonly result: BoardMutationResult;
  };
  let interactionProjection: BoardRenderProjection<string, string> | undefined;
  let pointerOwner: HTMLElement | null = null;
  let interactionController: BoardInteractionController<string, string, UndoAuthority> | undefined;

  const updateColumnPreference = (next: BoardViewPreference): void => {
    columnPreference = { ...next, terminalDefaultsApplied: true };
    void options.columnPreferences?.onChange(columnPreference);
    render();
  };

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
          .onClick(() => {
            if (!interactionController) {
              commitMove(item, action.columnKey, initiator);
              return;
            }
            const source = observedPosition(item);
            if (!source) return;
            void interactionController.requestMove({
              itemId: options.itemKey(item),
              source,
              destinationColumnId: action.columnKey,
              enabled: options.mutationEnabled !== false,
            });
          }),
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

  const itemByKey = (key: string): T | undefined =>
    options.columns.flatMap(({ items }) => items).find((item) => options.itemKey(item) === key);

  const observedPosition = (item: T): BoardObservedPosition<string> | undefined => {
    const itemKey = options.itemKey(item);
    for (const column of options.columns) {
      const position = projectedItems(column).findIndex(
        (candidate) => options.itemKey(candidate) === itemKey,
      );
      if (position >= 0) {
        return {
          columnId: column.key,
          position,
          evidence: `canonical:${column.key}:${String(position)}`,
        };
      }
    }
    return undefined;
  };

  const applyInteractionProjection = (): void => {
    if (!interactionController || !interactionProjection || destroyed) return;
    container.querySelectorAll<HTMLElement>('[data-board-item-surface]').forEach((surface) => {
      surface.classList.remove('is-board-source-placeholder');
      surface.setAttribute('aria-grabbed', 'false');
    });
    container
      .querySelectorAll<HTMLElement>('[data-board-column]')
      .forEach((column) => column.classList.remove('is-board-active-destination'));
    container
      .querySelectorAll(
        '[data-board-landing-gap], [data-board-drag-preview], [data-board-hidden-target]',
      )
      .forEach((el) => el.remove());
    const projection = interactionProjection;
    if (projection.sourcePlaceholder) {
      const source = Array.from(
        container.querySelectorAll<HTMLElement>('[data-board-item-surface]'),
      ).find(({ dataset }) => dataset['boardItemSurface'] === projection.sourcePlaceholder!.itemId);
      source?.addClass('is-board-source-placeholder');
      source?.setAttribute('aria-grabbed', 'true');
    }
    if (projection.activeDestination && projection.activeDestination.kind !== 'hidden-disclosure') {
      const target = Array.from(
        container.querySelectorAll<HTMLElement>('[data-board-column]'),
      ).find(
        ({ dataset }) =>
          dataset['boardColumn'] ===
          (projection.activeDestination as { readonly columnId: string }).columnId,
      );
      target?.addClass('is-board-active-destination');
    }
    if (projection.landingGap) {
      const target = Array.from(
        container.querySelectorAll<HTMLElement>('[data-board-column]'),
      ).find(({ dataset }) => dataset['boardColumn'] === projection.landingGap!.columnId);
      const itemsHost = target?.querySelector<HTMLElement>('.abyss-board-items');
      if (itemsHost) {
        const gap = itemsHost.createDiv({
          cls: 'abyss-board-landing-gap',
          attr: { 'data-board-landing-gap': '' },
        });
        const children = Array.from(itemsHost.children).filter(
          (child) =>
            child !== gap && !(child as HTMLElement).hasAttribute('data-bounded-window-edge'),
        );
        itemsHost.insertBefore(gap, children[projection.landingGap.position] ?? null);
      }
    }
    if (projection.preview && projection.pickedItemId) {
      const item = itemByKey(projection.pickedItemId);
      const destination = projection.activeDestination;
      const destinationLabel =
        destination && destination.kind !== 'hidden-disclosure'
          ? (options.columns.find(({ key }) => key === destination.columnId)?.label ?? '')
          : '';
      const preview = container.createDiv({
        cls: 'abyss-board-drag-preview',
        attr: { 'data-board-drag-preview': '', 'aria-hidden': 'true' },
      });
      preview.createSpan({ text: item && options.itemLabel ? options.itemLabel(item) : '' });
      if (destinationLabel) preview.createEl('small', { text: destinationLabel });
      preview.style.left = `${String(projection.preview.anchor.x)}px`;
      preview.style.top = `${String(projection.preview.anchor.y)}px`;
    }
    const exposedHidden = projection.accessibility.dropTargets.filter(
      (
        destination,
      ): destination is Extract<typeof destination, { readonly exposedFromHidden: true }> =>
        'exposedFromHidden' in destination,
    );
    if (exposedHidden.length > 0) {
      const disclosure = container.querySelector<HTMLDetailsElement>('[data-board-hidden-columns]');
      const list = disclosure?.querySelector<HTMLElement>('.abyss-board-hidden-list');
      if (disclosure && list) {
        disclosure.open = true;
        for (const destination of exposedHidden) {
          const column = options.columns.find(({ key }) => key === destination.columnId);
          list.createDiv({
            cls: 'abyss-board-hidden-target',
            text: column?.label ?? destination.columnId,
            attr: {
              role: 'button',
              tabindex: '0',
              'aria-label': `Move to ${column?.label ?? destination.columnId}`,
              'data-board-hidden-target': destination.columnId,
            },
          });
        }
      }
    }
    const toolbar = container.querySelector<HTMLElement>('.abyss-board-toolbar');
    const existingUndo = toolbar?.querySelector<HTMLButtonElement>('[data-board-undo]');
    const effectivePending = undoInFlight || projection.pending;
    if (projection.accessibility.undoAvailable && toolbar && !existingUndo) {
      const undo = toolbar.createEl('button', {
        cls: 'abyss-board-undo',
        text: 'Undo',
        attr: { type: 'button', 'data-board-undo': '' },
      });
      undo.addEventListener('click', () => void interactionController?.undo());
    } else if (!projection.accessibility.undoAvailable && existingUndo && !undoPending) {
      existingUndo.remove();
    } else if (existingUndo) {
      existingUndo.disabled = effectivePending;
      existingUndo.setAttribute('aria-disabled', String(effectivePending));
      existingUndo.toggleAttribute('aria-busy', effectivePending);
    }
    container.querySelectorAll<HTMLButtonElement>('[data-board-status-menu]').forEach((control) => {
      control.disabled = effectivePending || options.mutationEnabled === false;
      control.setAttribute('aria-disabled', String(control.disabled));
    });
    container.toggleAttribute('aria-busy', effectivePending);
  };

  if (options.interactionController) {
    interactionController = new BoardInteractionController<string, string, UndoAuthority>({
      geometry: {
        snapshot: () => {
          const hidden = columnPreference?.hiddenColumnIds ?? [];
          const destinations: BoardDestinationGeometry<string>[] = Array.from(
            container.querySelectorAll<HTMLElement>('[data-board-column]'),
          ).map((column) => ({
            kind: column.classList.contains('is-column-collapsed')
              ? ('rail' as const)
              : ('column' as const),
            columnId: column.dataset['boardColumn']!,
            rect: boardRect(column.getBoundingClientRect()),
            enabled:
              options.mutationEnabled !== false && column.dataset['boardColumnRole'] !== 'unmapped',
          }));
          const disclosure = container.querySelector<HTMLElement>('[data-board-hidden-disclosure]');
          if (disclosure) {
            destinations.push({
              kind: 'hidden-disclosure',
              rect: boardRect(disclosure.getBoundingClientRect()),
              enabled: options.mutationEnabled !== false,
              hiddenColumnIds: hidden,
            });
          }
          for (const hiddenTarget of container.querySelectorAll<HTMLElement>(
            '[data-board-hidden-target]',
          )) {
            const columnId = hiddenTarget.dataset['boardHiddenTarget'];
            if (!columnId) continue;
            destinations.push({
              kind: 'column',
              columnId,
              rect: boardRect(hiddenTarget.getBoundingClientRect()),
              enabled: options.mutationEnabled !== false,
            });
          }
          return {
            destinations,
            items: Array.from(
              container.querySelectorAll<HTMLElement>('[data-board-item-surface]'),
            ).flatMap((surface) => {
              const itemId = surface.dataset['boardItemSurface'];
              const columnId =
                surface.closest<HTMLElement>('[data-board-column]')?.dataset['boardColumn'];
              return itemId && columnId
                ? [{ itemId, columnId, rect: boardRect(surface.getBoundingClientRect()) }]
                : [];
            }),
            scrollContainer: (() => {
              const scroller = container.querySelector<HTMLElement>('.abyss-board-columns');
              return scroller
                ? {
                    rect: boardRect(scroller.getBoundingClientRect()),
                    scrollLeft: scroller.scrollLeft,
                  }
                : undefined;
            })(),
          };
        },
        canonicalLanding: (itemId, destinationColumnId) => {
          const item = itemByKey(itemId);
          const destination = options.columns.find(({ key }) => key === destinationColumnId);
          if (!item || !destination || destination.role === 'unmapped') return undefined;
          const canonical = options.columns.flatMap(({ items }) => items);
          const itemRank = canonical.findIndex(
            (candidate) => options.itemKey(candidate) === itemId,
          );
          const target = projectedItems(destination).filter(
            (candidate) => options.itemKey(candidate) !== itemId,
          );
          const position = target.findIndex(
            (candidate) =>
              canonical.findIndex(
                (entry) => options.itemKey(entry) === options.itemKey(candidate),
              ) > itemRank,
          );
          const boundedPosition = position < 0 ? target.length : position;
          return {
            position: boundedPosition,
            evidence: `canonical:${destinationColumnId}:${String(boundedPosition)}`,
            gap: {
              columnId: destinationColumnId,
              position: boundedPosition,
              beforeItemId:
                boundedPosition > 0 ? options.itemKey(target[boundedPosition - 1]!) : undefined,
              afterItemId:
                boundedPosition < target.length
                  ? options.itemKey(target[boundedPosition]!)
                  : undefined,
            },
          };
        },
      },
      commitMove: async (intent) => {
        const item = itemByKey(intent.itemId);
        if (!item) return { type: 'failure', reason: 'Project is no longer available' };
        const result = await options.mutation.move(item, intent.destination.columnId);
        if (!successful(result)) {
          return {
            type: result?.type === 'conflict' ? 'conflict' : 'failure',
            reason: result && 'type' in result ? result.type : undefined,
          };
        }
        overrides.set(intent.itemId, intent.destination.columnId);
        const authority = { item, columnKey: intent.destination.columnId, result };
        options.onMutation?.(item, intent.destination.columnId, result);
        queueMicrotask(() => {
          if (!destroyed) render();
        });
        return { type: 'success', undo: { authority, evidence: intent.destination.evidence } };
      },
      undoMove:
        options.undo === undefined
          ? undefined
          : async ({ authority }) => {
              const result = await options.undo!(
                authority.item,
                authority.columnKey,
                authority.result,
              );
              if (!successful(result)) {
                return {
                  type: result?.type === 'conflict' ? 'conflict' : 'failure',
                  reason: result && 'type' in result ? result.type : undefined,
                };
              }
              overrides.delete(options.itemKey(authority.item));
              queueMicrotask(() => {
                if (!destroyed) render();
              });
              return { type: 'success' };
            },
      publish: (projection) => {
        interactionProjection = projection;
        applyInteractionProjection();
      },
      announce: (announcement) =>
        options.announce?.(
          boardAnnouncementText(
            announcement,
            (columnId) => options.columns.find(({ key }) => key === columnId)?.label ?? columnId,
          ),
        ),
      capturePointer: (pointerId) => pointerOwner?.setPointerCapture?.(pointerId),
      releasePointer: (pointerId) => pointerOwner?.releasePointerCapture?.(pointerId),
      requestAutoscroll: ({ direction, speed }) => {
        const scroller = container.querySelector<HTMLElement>('.abyss-board-columns');
        if (scroller && direction !== 0) scroller.scrollLeft += direction * speed;
      },
      restoreFocus: (itemId) => {
        Array.from(container.querySelectorAll<HTMLElement>('[data-board-item-focus]'))
          .find(({ dataset }) => dataset['boardItemFocus'] === itemId)
          ?.focus({ preventScroll: true });
      },
    });
    interactionProjection = interactionController.projection();
  }

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
    if (interactionController?.projection().accessibility.undoAvailable) {
      const undo = host.createEl('button', {
        cls: 'abyss-board-undo',
        text: 'Undo',
        attr: { type: 'button', 'data-board-undo': '' },
      });
      undo.addEventListener('click', () => void interactionController?.undo());
      return;
    }
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

  // eslint-disable-next-line sonarjs/cognitive-complexity -- One bounded render pass owns matching tab, column, virtualization, and interaction lifecycles.
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
    if (columnPreference?.['orderOverride'] === true) {
      const reset = toolbar.createEl('button', {
        cls: 'abyss-board-reset-order clickable-icon',
        attr: {
          type: 'button',
          title: 'Reset to status order',
          'aria-label': 'Reset to status order',
          'data-board-reset-order': '',
        },
      });
      setIcon(reset, 'rotate-ccw');
      reset.addEventListener('click', () =>
        updateColumnPreference({
          ...resetBoardPreference(columnPreference!, configuredColumnIds, preferenceRoles),
          orderOverride: false,
        }),
      );
    }
    const tabs = container.createDiv({
      cls: 'abyss-board-column-tabs',
      attr: { role: 'tablist', 'aria-label': 'Board columns' },
    });
    const board = container.createDiv({
      cls: 'abyss-board-columns',
      attr: {
        'data-board-interaction-root': '',
        ...(options.interactionController
          ? { 'aria-disabled': String(options.mutationEnabled === false) }
          : {}),
      },
    });
    const hiddenColumnIds = new Set(columnPreference?.hiddenColumnIds ?? []);
    const collapsedColumnIds = new Set(columnPreference?.collapsedColumnIds ?? []);
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
      if (hiddenColumnIds.has(column.key)) continue;
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
      const presentationCollapsed = collapsedColumnIds.has(column.key);
      const columnEl = board.createDiv({
        cls: `abyss-board-column${selectedColumnKey === column.key ? ' is-active' : ''}${
          !visible && terminal ? ' is-collapsed' : ''
        }${presentationCollapsed ? ' is-column-collapsed' : ''}`,
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
      if (columnPreference && column.role !== 'unmapped') {
        const actions = header.createDiv({ cls: 'abyss-board-column-actions' });
        const collapse = actions.createEl('button', {
          cls: 'clickable-icon',
          attr: {
            type: 'button',
            title: presentationCollapsed ? `Expand ${column.label}` : `Collapse ${column.label}`,
            'aria-label': presentationCollapsed
              ? `Expand ${column.label}`
              : `Collapse ${column.label}`,
            'data-board-collapse-column': column.key,
          },
        });
        setIcon(collapse, presentationCollapsed ? 'panel-left-open' : 'panel-left-close');
        collapse.addEventListener('click', () =>
          updateColumnPreference(
            presentationCollapsed
              ? restoreBoardColumn(columnPreference!, column.key)
              : collapseBoardColumn(columnPreference!, column.key),
          ),
        );
        if (!terminal) {
          const hide = actions.createEl('button', {
            cls: 'clickable-icon',
            attr: {
              type: 'button',
              title: `Hide ${column.label}`,
              'aria-label': `Hide ${column.label}`,
              'data-board-hide-column': column.key,
            },
          });
          setIcon(hide, 'eye-off');
          hide.addEventListener('click', () =>
            updateColumnPreference(hideBoardColumn(columnPreference!, column.key)),
          );
          const menuButton = actions.createEl('button', {
            cls: 'clickable-icon',
            attr: {
              type: 'button',
              title: `${column.label} column menu`,
              'aria-label': `${column.label} column menu`,
              'data-board-column-menu': column.key,
            },
          });
          setIcon(menuButton, 'more-horizontal');
          menuButton.addEventListener('click', (event) => {
            const menu = new Menu();
            for (const direction of ['left', 'right'] as const) {
              menu.addItem((item) =>
                item
                  .setTitle(`Move ${direction}`)
                  .setIcon(direction === 'left' ? 'arrow-left' : 'arrow-right')
                  .onClick(() =>
                    updateColumnPreference({
                      ...moveBoardColumn(
                        columnPreference!,
                        configuredColumnIds,
                        column.key,
                        direction,
                        preferenceRoles,
                      ),
                      orderOverride: true,
                    }),
                  ),
              );
            }
            menu.addItem((item) =>
              item
                .setTitle('Hide column')
                .setIcon('eye-off')
                .onClick(() =>
                  updateColumnPreference(hideBoardColumn(columnPreference!, column.key)),
                ),
            );
            showMenuAtMouseEventWithFocus(menu, event);
          });
          const handle = actions.createEl('button', {
            cls: 'clickable-icon abyss-board-reorder-handle',
            attr: {
              type: 'button',
              title: `Reorder ${column.label}`,
              'aria-label': `Reorder ${column.label}; use Left or Right arrow`,
              'data-board-reorder-handle': column.key,
            },
          });
          setIcon(handle, 'grip-vertical');
          handle.addEventListener('keydown', (event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            updateColumnPreference({
              ...moveBoardColumn(
                columnPreference!,
                configuredColumnIds,
                column.key,
                event.key === 'ArrowLeft' ? 'left' : 'right',
                preferenceRoles,
              ),
              orderOverride: true,
            });
          });
        }
      }
      const scroll = columnEl.createDiv({ cls: 'abyss-board-column-scroll' });
      if (presentationCollapsed) {
        scroll.hidden = true;
      }
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
            itemEl.dataset['boardItemSurface'] = key;
            itemEl.setAttribute(
              'draggable',
              String(!options.interactionController && !mutationLocked),
            );
            focusTarget.addEventListener('focus', () => {
              bounded.focus(key);
              options.onItemFocus?.(item);
              if (options.session) {
                options.session.focusedKey = key;
                options.session.restoreFocus = true;
              }
            });
            focusTarget.addEventListener('keydown', (event) => {
              if (
                interactionController &&
                [' ', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(event.key)
              ) {
                const source = observedPosition(item);
                if (!source && event.key !== 'Escape') return;
                event.preventDefault();
                void interactionController.keyDown({
                  key: event.key,
                  itemId: key,
                  source,
                  enabled: !mutationLocked,
                });
                return;
              }
              if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
              event.preventDefault();
              bounded.focus(key);
              if (bounded.move(event.key === 'ArrowDown' ? 1 : -1) === null) return;
              const nextFirst = bounded.viewportForFocus(viewport());
              scroll.scrollTop = nextFirst * BOARD_ITEM_EXTENT;
              renderWindow(true);
            });
            if (interactionController) {
              let suppressActivationAfterDrag = false;
              const point = (event: Event): { x: number; y: number } => {
                const pointer = event as MouseEvent;
                return { x: pointer.clientX, y: pointer.clientY };
              };
              const pointerId = (event: Event): number => (event as PointerEvent).pointerId ?? 1;
              itemEl.addEventListener('pointerdown', (event) => {
                const source = observedPosition(item);
                if (!source) return;
                pointerOwner = itemEl;
                interactionController.pointerDown({
                  pointerId: pointerId(event),
                  button: event.button,
                  isPrimary: event.isPrimary,
                  itemId: key,
                  source,
                  point: point(event),
                  enabled: !mutationLocked,
                });
              });
              itemEl.addEventListener('pointermove', (event) => {
                interactionController.pointerMove({
                  pointerId: pointerId(event),
                  point: point(event),
                });
                if (interactionController.projection().pickedItemId === key) {
                  suppressActivationAfterDrag = true;
                }
              });
              itemEl.addEventListener('pointerup', (event) => {
                void interactionController.pointerUp({
                  pointerId: pointerId(event),
                  point: point(event),
                });
              });
              itemEl.addEventListener('pointercancel', (event) => {
                interactionController.pointerCancel(pointerId(event));
              });
              itemEl.addEventListener('lostpointercapture', (event) => {
                interactionController.lostPointerCapture(pointerId(event));
              });
              itemEl.addEventListener(
                'click',
                (event) => {
                  if (!suppressActivationAfterDrag) return;
                  suppressActivationAfterDrag = false;
                  event.preventDefault();
                  event.stopImmediatePropagation();
                },
                true,
              );
            }
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
    if (columnPreference && hiddenColumnIds.size > 0) {
      const disclosure = container.createEl('details', {
        cls: 'abyss-board-hidden-columns',
        attr: { 'data-board-hidden-columns': '' },
      });
      const summary = disclosure.createEl('summary', {
        text: `Hidden (${String(hiddenColumnIds.size)})`,
        attr: { 'data-board-hidden-disclosure': '' },
      });
      summary.setAttribute('aria-label', `${String(hiddenColumnIds.size)} hidden board columns`);
      const list = disclosure.createDiv({ cls: 'abyss-board-hidden-list' });
      for (const key of hiddenColumnIds) {
        const column = options.columns.find(({ key: candidate }) => candidate === key);
        if (!column) continue;
        const restore = list.createEl('button', {
          text: column.label,
          attr: {
            type: 'button',
            'data-board-restore-column': column.key,
            'aria-label': `Restore ${column.label}`,
          },
        });
        restore.addEventListener('click', () =>
          updateColumnPreference(restoreBoardColumn(columnPreference!, column.key)),
        );
      }
    }
    if (focusedTabKey !== null) {
      Array.from(container.querySelectorAll<HTMLElement>('[data-board-column-tab]'))
        .find(({ dataset }) => dataset['boardColumnTab'] === focusedTabKey)
        ?.focus({ preventScroll: true });
    }
    applyInteractionProjection();
  };

  render();
  return {
    destroy: () => {
      destroyed = true;
      if (interactionController?.projection().pickedItemId) {
        void interactionController.keyDown({ key: 'Escape' });
      }
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
  readonly onAnnounce?: (message: string) => void;
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
  const lifecycle = validateLifecycleConfiguration(statuses);
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
  const terminalLeftIds = statuses
    .filter(({ behavior }) => behavior === 'dropped')
    .map(({ id }) => id);
  const terminalRightIds = statuses
    .filter(({ behavior }) => behavior === 'published')
    .map(({ id }) => id);
  const columns = projectBoardColumns(statuses, projects, {
    columnOrder: options.settings.projects.view.board.columnOrder,
    includeUnmapped: options.settings.projects.view.includeUnmapped,
  });
  if (!lifecycle.valid) {
    boardHost.createDiv({
      cls: 'abyss-board-lifecycle-diagnostic',
      text: lifecycle.diagnostics.map(({ message }) => message).join(' '),
      attr: { role: 'alert', 'data-board-lifecycle-diagnostic': '' },
    });
  }
  const boardSurface = boardHost.createDiv({ cls: 'abyss-portfolio-board-surface' });
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
  const board = renderBoard(boardSurface, {
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
        false,
      );
    },
    session: options.session,
    mutationEnabled: lifecycle.valid,
    mutationDisabledTitle: 'Repair duplicate Dropped or Published lifecycle statuses in Settings',
    interactionController: true,
    itemLabel: ({ name }) => name,
    announce: options.onAnnounce,
    columnPreferences: {
      value: options.settings.projects.view.board,
      terminalLeftIds,
      terminalRightIds,
      onChange: async (next) => {
        options.settings.projects.view.board = next;
        await options.onSaveSettings();
      },
    },
  });
  if (captureSession.createdPath) {
    const createdPath = captureSession.createdPath;
    queueMicrotask(() => {
      if (destroyed) return;
      const row = Array.from(
        boardSurface.querySelectorAll<HTMLElement>('[data-project-path]'),
      ).find(({ dataset }) => dataset['projectPath'] === createdPath);
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
