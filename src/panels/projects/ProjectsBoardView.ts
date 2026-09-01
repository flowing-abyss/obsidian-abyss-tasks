import { Menu, setIcon } from 'obsidian';
import { validateLifecycleConfiguration } from '../../projects/lifecycle';
import type { ProjectPropertyCommandResult } from '../../projects/ProjectCommandService';
import type { ProjectAction, ProjectWorkspaceSnapshot } from '../../projects/types';
import type {
  WorkNoteCommandResult,
  WorkNoteSnapshot,
  WorkNoteStatusDefinition,
} from '../../projects/work-notes/types';
import type { TaskStatusDef } from '../../settings/types';
import type { TaskSnapshot } from '../../tasks';
import {
  optimisticOverlayStoreFor,
  type OptimisticOverlayStore,
  type OptimisticTransaction,
} from '../../ui/interaction/OptimisticOverlayStore';
import { showMenuAtMouseEventWithFocus } from '../../ui/nativeMenuFocus';
import { taskPresentationKey } from '../../ui/taskPresentationIdentity';
import {
  BoardInteractionController,
  type BoardAnnouncement,
  type BoardDestinationGeometry,
  type BoardMoveIntent,
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
  createProjectActionBoardMutation,
  createProjectBoardMutation,
  createWorkNoteBoardMutation,
  projectActionBoardColumns,
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
  /** Presentation preferences can remain editable when entity mutation is read-only. */
  readonly presentationEnabled?: boolean;
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
    /** Canonical Settings order, independent of a persisted presentation override. */
    readonly configuredColumnIds?: readonly string[];
    readonly terminalLeftIds: readonly string[];
    readonly terminalRightIds: readonly string[];
  };
  /** Opts only the Portfolio renderer into Task 5's pointer/keyboard interaction adapter. */
  readonly interactionController?: boolean;
  readonly itemLabel?: (item: T) => string;
  /** Canonical cross-column order used for landing and temporary post-move projection. */
  readonly canonicalItems?: readonly T[];
  readonly announce?: (message: string) => void;
  /** Application-owned status projection retained while a guarded write waits for source publication. */
  readonly optimisticOverlay?: {
    readonly store: OptimisticOverlayStore<T, string>;
    /** Stable write identity, intentionally distinct from a revision-sensitive DOM item key. */
    readonly keyOf: (item: T) => string;
    readonly revision: (item: T) => string;
    /** Ordered source generation when the entity provider exposes one. */
    readonly publicationSequence?: (item: T) => number | undefined;
    /** Proven entity continuity when a canonical source key changes. */
    readonly continuity?: (observed: T, published: T) => boolean;
    /** Explicit capability for publication text; omitted preserves legacy generic boards. */
    readonly undoAvailable?: boolean;
    /** Returns the configured board column for either an observed or optimistic entity. */
    readonly columnKey: (item: T) => string;
    /** The active Board mount owns the live-region callback for registry-backed stores. */
    readonly presentationAnnouncement?: boolean;
  };
  readonly renderColumnFooter?: (host: HTMLElement, column: BoardColumn<T>) => void;
  readonly onCollapsedColumnFooterRequest?: (column: BoardColumn<T>) => void;
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
  readonly announce?: (message: string) => void;
  readonly columnPreference?: BoardViewPreference;
  readonly onColumnPreferenceChange?: (next: BoardViewPreference) => void;
  readonly overlayScope?: object;
}

export interface ProjectTasksBoardOptions {
  readonly actions: readonly ProjectAction[];
  readonly statuses: readonly TaskStatusDef[];
  readonly onMoveStatus: (task: TaskSnapshot, symbol: string) => Promise<BoardMutationResult>;
  readonly renderItem: (host: HTMLElement, action: ProjectAction) => HTMLElement;
  readonly renderColumnAdd?: (host: HTMLElement, status: TaskStatusDef) => void;
  readonly onCollapsedColumnAddRequest?: (status: TaskStatusDef) => void;
  readonly visibleColumnKeys?: ReadonlySet<string>;
  readonly session?: WorkNoteBoardSession;
  readonly columnPreference?: BoardViewPreference;
  readonly onColumnPreferenceChange?: (next: BoardViewPreference) => void;
  readonly focusedItemKey?: () => string | null;
  readonly shouldRestoreItemFocus?: () => boolean;
  readonly onItemFocus?: (action: ProjectAction) => void;
  readonly onItemBlur?: () => void;
  readonly announce?: (message: string) => void;
  readonly overlayScope?: object;
  /** TaskIndex-proven successor relation; callers must not use fuzzy identity. */
  readonly taskSuccessor?: (observed: TaskSnapshot, published: TaskSnapshot) => boolean;
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
  type UndoAuthority = {
    readonly item: T;
    readonly columnKey: string;
    readonly result: BoardMutationResult;
  };
  let interactionController: BoardInteractionController<string, string, UndoAuthority> | undefined;
  const pendingOverlayUndos = new Map<
    number,
    {
      readonly authority: UndoAuthority;
      readonly evidence: string;
      readonly move: BoardMoveIntent<string, string>;
    }
  >();
  const presentationEnabled = options.presentationEnabled ?? options.mutationEnabled !== false;
  const overrides = new Map<string, string>();
  const sourceItems = [
    ...new Map(
      options.columns
        .flatMap(({ items }) => items)
        .map((item) => [options.itemKey(item), item] as const),
    ).values(),
  ];
  const overlayKey = (item: T): string =>
    options.optimisticOverlay?.keyOf(item) ?? options.itemKey(item);
  const overlayOwner = {
    id: boardId,
    announce: options.announce,
    undoAvailable: options.optimisticOverlay?.undoAvailable,
  };
  let destroyed = false;
  const unsubscribeOptimisticOverlay = options.optimisticOverlay?.store.subscribe((settlement) => {
    if (settlement) {
      const pendingUndo = pendingOverlayUndos.get(settlement.transactionId);
      pendingOverlayUndos.delete(settlement.transactionId);
      if (settlement.published && pendingUndo) {
        interactionController?.acceptPublishedUndo(
          pendingUndo.authority,
          pendingUndo.evidence,
          pendingUndo.move,
        );
      }
    }
    queueMicrotask(() => {
      if (!destroyed) render();
    });
  }, overlayOwner);
  for (const item of sourceItems) {
    options.optimisticOverlay?.store.observePublication(
      overlayKey(item),
      item,
      options.optimisticOverlay.revision(item),
      options.optimisticOverlay.publicationSequence?.(item),
      options.optimisticOverlay.continuity,
    );
  }
  const configuredColumnIds =
    options.columnPreferences?.configuredColumnIds ??
    options.columns.filter(({ role }) => role !== 'unmapped').map(({ key }) => key);
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
    if (presentationEnabled) void options.columnPreferences?.onChange(columnPreference);
  } else if (
    columnPreference &&
    JSON.stringify(columnPreference) !== JSON.stringify(options.columnPreferences?.value)
  ) {
    if (presentationEnabled) void options.columnPreferences?.onChange(columnPreference);
  }
  const presentationColumns = (): readonly BoardColumn<T>[] => {
    if (!columnPreference) return options.columns;
    const columnsByKey = new Map(options.columns.map((column) => [column.key, column]));
    const ordered = columnPreference.columnOrder.flatMap((key) => {
      const column = columnsByKey.get(key);
      return column && column.role !== 'unmapped' ? [column] : [];
    });
    const orderedKeys = new Set(ordered.map(({ key }) => key));
    ordered.push(
      ...options.columns.filter(({ key, role }) => role !== 'unmapped' && !orderedKeys.has(key)),
    );
    const unmapped = options.columns.filter(({ role }) => role === 'unmapped');
    const terminalRightIndex = ordered.findIndex(({ role }) => role === 'terminal-right');
    if (terminalRightIndex < 0) return [...ordered, ...unmapped];
    return [
      ...ordered.slice(0, terminalRightIndex),
      ...unmapped,
      ...ordered.slice(terminalRightIndex),
    ];
  };
  let dragging: { readonly item: T; readonly initiator: HTMLElement } | null = null;
  const selectableColumns = (): readonly BoardColumn<T>[] => {
    const hidden = new Set(columnPreference?.hiddenColumnIds ?? []);
    return presentationColumns().filter(
      (column) => options.visibleColumnKeys?.has(column.key) !== false && !hidden.has(column.key),
    );
  };
  const selectedFromSession = options.session?.selectedColumnKey;
  let selectedColumnKey =
    selectableColumns().find((column) => column.key === selectedFromSession)?.key ??
    selectableColumns()[0]?.key ??
    '';
  if (options.session) options.session.selectedColumnKey = selectedColumnKey;
  let undoPending: {
    readonly item: T;
    readonly columnKey: string;
    readonly result: BoardMutationResult;
  } | null = options.initialUndo ?? null;
  let undoInFlight = options.initialUndoInFlight === true;
  const cleanups: Array<() => void> = [];
  let interactionProjection: BoardRenderProjection<string, string> | undefined;
  let pointerOwner: HTMLElement | null = null;
  let activePointerId: number | undefined;
  let lastPointerPoint: { x: number; y: number } | undefined;
  let autoscrollDirection = 0;
  let autoscrollSpeed = 0;
  let autoscrollFrame: number | undefined;
  const ownerWindow = container.ownerDocument.defaultView;

  const stopAutoscroll = (): void => {
    autoscrollDirection = 0;
    autoscrollSpeed = 0;
    if (autoscrollFrame !== undefined) ownerWindow?.cancelAnimationFrame(autoscrollFrame);
    autoscrollFrame = undefined;
  };

  const stopAutoscrollWhenHidden = (): void => {
    if (container.ownerDocument.visibilityState === 'hidden') stopAutoscroll();
  };
  container.ownerDocument.addEventListener('visibilitychange', stopAutoscrollWhenHidden);

  const scheduleAutoscroll = (): void => {
    if (autoscrollFrame !== undefined || autoscrollDirection === 0 || !ownerWindow) return;
    autoscrollFrame = ownerWindow.requestAnimationFrame(() => {
      autoscrollFrame = undefined;
      if (destroyed || autoscrollDirection === 0) return;
      const scroller = container.querySelector<HTMLElement>('.abyss-board-columns');
      if (!scroller) {
        stopAutoscroll();
        return;
      }
      const before = scroller.scrollLeft;
      scroller.scrollLeft += autoscrollDirection * autoscrollSpeed;
      if (scroller.scrollLeft === before) {
        stopAutoscroll();
        return;
      }
      if (activePointerId !== undefined && lastPointerPoint) {
        interactionController?.pointerMove({
          pointerId: activePointerId,
          point: lastPointerPoint,
        });
      }
      scheduleAutoscroll();
    });
  };

  const updateColumnPreference = (next: BoardViewPreference): void => {
    if (!presentationEnabled) return;
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

  const canonicalRank =
    options.canonicalItems === undefined
      ? undefined
      : new Map(options.canonicalItems.map((item, index) => [options.itemKey(item), index]));

  const projectedItems = (column: BoardColumn<T>): readonly T[] => {
    if (options.optimisticOverlay) {
      return sourceItems
        .map((item) => options.optimisticOverlay!.store.read(overlayKey(item)) ?? item)
        .filter((item) => options.optimisticOverlay!.columnKey(item) === column.key);
    }
    const retained = column.items.filter((item) => {
      const target = overrides.get(options.itemKey(item));
      return target === undefined || target === column.key;
    });
    const moved = options.columns.flatMap((source) =>
      source.items.filter((item) => overrides.get(options.itemKey(item)) === column.key),
    );
    const seen = new Set<string>();
    const projected = [...retained, ...moved].filter((item) => {
      const key = options.itemKey(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return canonicalRank
      ? projected.sort(
          (left, right) =>
            (canonicalRank.get(options.itemKey(left)) ?? Number.MAX_SAFE_INTEGER) -
            (canonicalRank.get(options.itemKey(right)) ?? Number.MAX_SAFE_INTEGER),
        )
      : projected;
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

  const boardColumnElement = (columnId: string): HTMLElement | undefined =>
    Array.from(container.querySelectorAll<HTMLElement>('[data-board-column]')).find(
      ({ dataset }) => dataset['boardColumn'] === columnId,
    );

  const compactDestinationTab = (
    columnId: string,
    column: HTMLElement | undefined,
  ): HTMLElement | undefined => {
    const tab = Array.from(container.querySelectorAll<HTMLElement>('[data-board-column-tab]')).find(
      ({ dataset }) => dataset['boardColumnTab'] === columnId,
    );
    const rect = column?.getBoundingClientRect();
    return tab && (!rect || rect.width === 0 || rect.height === 0) ? tab : undefined;
  };

  const renderActiveDestination = (projection: BoardRenderProjection<string, string>): void => {
    const destination = projection.activeDestination;
    if (!destination || destination.kind === 'hidden-disclosure') return;
    const column = boardColumnElement(destination.columnId);
    (compactDestinationTab(destination.columnId, column) ?? column)?.addClass(
      'is-board-active-destination',
    );
  };

  const renderLandingGap = (projection: BoardRenderProjection<string, string>): void => {
    const landing = projection.landingGap;
    if (!landing) return;
    const column = boardColumnElement(landing.columnId);
    const compactTab = compactDestinationTab(landing.columnId, column);
    if (compactTab) {
      compactTab.createSpan({
        cls: 'abyss-board-tab-landing-gap',
        attr: { 'data-board-landing-gap': '', 'aria-hidden': 'true' },
      });
      return;
    }
    const itemsHost = column?.querySelector<HTMLElement>('.abyss-board-items');
    if (!itemsHost) return;
    const surfaces = Array.from(
      itemsHost.querySelectorAll<HTMLElement>('[data-board-item-surface]'),
    );
    const before = landing.beforeItemId
      ? (surfaces.find(({ dataset }) => dataset['boardItemSurface'] === landing.beforeItemId) ??
        null)
      : null;
    const after = landing.afterItemId
      ? (surfaces.find(({ dataset }) => dataset['boardItemSurface'] === landing.afterItemId) ??
        null)
      : null;
    const landingIsMounted =
      after !== null ||
      before !== null ||
      (landing.beforeItemId === undefined && landing.afterItemId === undefined);
    if (!landingIsMounted) return;
    const gap = itemsHost.createDiv({
      cls: 'abyss-board-landing-gap',
      attr: { 'data-board-landing-gap': '' },
    });
    itemsHost.insertBefore(gap, after ?? before?.nextSibling ?? null);
  };

  const renderInteractionPreview = (projection: BoardRenderProjection<string, string>): void => {
    if (!projection.preview || !projection.pickedItemId) return;
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
  };

  const applyInteractionProjection = (): void => {
    if (!interactionController || !interactionProjection || destroyed) return;
    container.querySelectorAll<HTMLElement>('[data-board-item-surface]').forEach((surface) => {
      surface.classList.remove('is-board-source-placeholder');
      surface.setAttribute('aria-grabbed', 'false');
    });
    container
      .querySelectorAll<HTMLElement>('[data-board-column], [data-board-column-tab]')
      .forEach((column) => column.classList.remove('is-board-active-destination'));
    container
      .querySelectorAll(
        '[data-board-landing-gap], [data-board-drag-preview], [data-board-hidden-target]',
      )
      .forEach((el) => el.remove());
    const projection = interactionProjection;
    if (!projection.accessibility.grabbed || projection.pending) stopAutoscroll();
    if (projection.sourcePlaceholder) {
      const source = Array.from(
        container.querySelectorAll<HTMLElement>('[data-board-item-surface]'),
      ).find(({ dataset }) => dataset['boardItemSurface'] === projection.sourcePlaceholder!.itemId);
      source?.addClass('is-board-source-placeholder');
      source?.setAttribute('aria-grabbed', 'true');
    }
    renderActiveDestination(projection);
    renderLandingGap(projection);
    renderInteractionPreview(projection);
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
          ).map((column) => {
            const columnRect = column.getBoundingClientRect();
            const hasColumnBox = columnRect.width > 0 && columnRect.height > 0;
            const compactTab = container.querySelector<HTMLElement>(
              `[data-board-column-tab="${column.dataset['boardColumn']!}"]`,
            );
            return {
              kind:
                column.classList.contains('is-column-collapsed') || !hasColumnBox
                  ? ('rail' as const)
                  : ('column' as const),
              columnId: column.dataset['boardColumn']!,
              rect: boardRect(
                !hasColumnBox && compactTab ? compactTab.getBoundingClientRect() : columnRect,
              ),
              enabled:
                options.mutationEnabled !== false &&
                column.dataset['boardColumnRole'] !== 'unmapped',
            };
          });
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
          const canonical = options.canonicalItems ?? options.columns.flatMap(({ items }) => items);
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
        const initiator =
          Array.from(container.querySelectorAll<HTMLElement>('[data-board-item-focus]')).find(
            ({ dataset }) => dataset['boardItemFocus'] === intent.itemId,
          ) ?? container;
        const command = (): Promise<BoardMutationResult> =>
          options.mutation.move(item, intent.destination.columnId);
        if (options.optimisticOverlay?.store.active(overlayKey(item))) {
          return { type: 'failure', reason: 'Move is already pending', announced: true };
        }
        const transaction: OptimisticTransaction<T, string> | undefined =
          options.optimisticOverlay?.store.begin(
            item,
            options.optimisticOverlay.revision(item),
            intent.destination.columnId,
            overlayOwner,
          );
        if (transaction) queueMicrotask(() => !destroyed && render());
        let result: BoardMutationResult;
        try {
          result = await (options.executeMutation?.(command, initiator) ?? command());
        } catch (error) {
          if (transaction) {
            options.optimisticOverlay?.store.cancel(
              overlayKey(item),
              'io',
              transaction.id,
              transaction.token,
            );
            queueMicrotask(() => !destroyed && render());
          }
          return {
            type: 'failure',
            reason: error instanceof Error ? error.message : String(error),
            announced: transaction !== undefined,
          };
        }
        if (transaction && result === undefined) {
          options.optimisticOverlay?.store.cancel(
            overlayKey(item),
            'io',
            transaction.id,
            transaction.token,
          );
          queueMicrotask(() => !destroyed && render());
          return { type: 'failure', reason: 'io-error', announced: true };
        }
        if (transaction && result !== undefined) {
          options.optimisticOverlay?.store.observeCommandResult(
            overlayKey(item),
            result,
            transaction.id,
            transaction.token,
          );
        }
        if (!successful(result)) {
          if (transaction) queueMicrotask(() => !destroyed && render());
          return {
            type: result?.type === 'conflict' ? 'conflict' : 'failure',
            reason: result && 'type' in result ? result.type : undefined,
            announced: transaction !== undefined,
          };
        }
        if (transaction) {
          const authority = { item, columnKey: intent.destination.columnId, result };
          if (options.undo) {
            pendingOverlayUndos.set(transaction.id, {
              authority,
              evidence: intent.destination.evidence,
              move: intent,
            });
          }
          options.onMutation?.(item, intent.destination.columnId, result);
          queueMicrotask(() => !destroyed && render());
          return {
            type: 'success',
            settled: false,
            undo: { authority, evidence: intent.destination.evidence },
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
        if (direction === 0) {
          stopAutoscroll();
          return;
        }
        autoscrollDirection = direction;
        autoscrollSpeed = speed;
        scheduleAutoscroll();
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
    if (options.optimisticOverlay?.store.active(overlayKey(item))) return;
    const transaction: OptimisticTransaction<T, string> | undefined =
      options.optimisticOverlay?.store.begin(
        item,
        options.optimisticOverlay.revision(item),
        columnKey,
        overlayOwner,
      );
    if (transaction) queueMicrotask(() => !destroyed && render());
    const pending = options.executeMutation?.(command, initiator) ?? command();
    void pending
      .then((result) => {
        if (destroyed) return;
        if (transaction && result === undefined) {
          options.optimisticOverlay?.store.cancel(
            overlayKey(item),
            'io',
            transaction.id,
            transaction.token,
          );
          render();
          return;
        }
        if (transaction && result !== undefined) {
          options.optimisticOverlay?.store.observeCommandResult(
            overlayKey(item),
            result,
            transaction.id,
            transaction.token,
          );
        }
        if (!successful(result)) return;
        if (transaction) {
          dragging = null;
          options.onMutation?.(item, columnKey, result);
          render();
          return;
        }
        overrides.set(options.itemKey(item), columnKey);
        dragging = null;
        if (options.undo) undoPending = { item, columnKey, result };
        options.onMutation?.(item, columnKey, result);
        render();
      })
      .catch(() => {
        if (!transaction || destroyed) return;
        options.optimisticOverlay?.store.cancel(
          overlayKey(item),
          'io',
          transaction.id,
          transaction.token,
        );
        render();
      });
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
    stopAutoscroll();
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
      reset.disabled = !presentationEnabled;
      reset.setAttribute('aria-disabled', String(reset.disabled));
      reset.addEventListener('click', () => {
        if (reset.disabled) return;
        updateColumnPreference({
          ...resetBoardPreference(columnPreference!, configuredColumnIds, preferenceRoles),
          orderOverride: false,
        });
      });
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
          ? {
              'data-board-mutation-enabled': String(options.mutationEnabled !== false),
              ...(!presentationEnabled && options.mutationEnabled === false
                ? { 'aria-disabled': 'true' }
                : {}),
            }
          : {}),
      },
    });
    const hiddenColumnIds = new Set(columnPreference?.hiddenColumnIds ?? []);
    const collapsedColumnIds = new Set(columnPreference?.collapsedColumnIds ?? []);
    const tabColumns = presentationColumns().filter(
      (column) =>
        options.visibleColumnKeys?.has(column.key) !== false && !hiddenColumnIds.has(column.key),
    );
    const selectionReconciled = !tabColumns.some(({ key }) => key === selectedColumnKey);
    if (selectionReconciled) {
      selectedColumnKey = tabColumns[0]?.key ?? '';
      if (options.session) options.session.selectedColumnKey = selectedColumnKey;
    }

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

    for (const column of presentationColumns()) {
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
        collapse.disabled = !presentationEnabled;
        collapse.setAttribute('aria-disabled', String(collapse.disabled));
        collapse.addEventListener('click', () => {
          if (collapse.disabled) return;
          updateColumnPreference(
            presentationCollapsed
              ? restoreBoardColumn(columnPreference!, column.key)
              : collapseBoardColumn(columnPreference!, column.key),
          );
        });
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
          hide.disabled = !presentationEnabled;
          hide.setAttribute('aria-disabled', String(hide.disabled));
          hide.addEventListener('click', () => {
            if (hide.disabled) return;
            updateColumnPreference(hideBoardColumn(columnPreference!, column.key));
          });
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
          menuButton.disabled = !presentationEnabled;
          menuButton.setAttribute('aria-disabled', String(menuButton.disabled));
          menuButton.addEventListener('click', (event) => {
            if (menuButton.disabled) return;
            const menu = new Menu();
            if (presentationCollapsed && options.onCollapsedColumnFooterRequest) {
              menu.addItem((item) =>
                item
                  .setTitle('Add task')
                  .setIcon('plus')
                  .onClick(() => {
                    selectedColumnKey = column.key;
                    if (options.session) options.session.selectedColumnKey = column.key;
                    updateColumnPreference(restoreBoardColumn(columnPreference!, column.key));
                    options.onCollapsedColumnFooterRequest?.(column);
                  }),
              );
            }
            for (const direction of ['left', 'right'] as const) {
              menu.addItem((item) =>
                item
                  .setTitle(`Move ${direction}`)
                  .setIcon(direction === 'left' ? 'arrow-left' : 'arrow-right')
                  .setDisabled(!presentationEnabled)
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
                .setDisabled(!presentationEnabled)
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
          handle.disabled = !presentationEnabled;
          handle.setAttribute('aria-disabled', String(handle.disabled));
          handle.addEventListener('keydown', (event) => {
            if (handle.disabled) return;
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
                activePointerId = pointerId(event);
                lastPointerPoint = point(event);
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
                lastPointerPoint = point(event);
                interactionController.pointerMove({
                  pointerId: pointerId(event),
                  point: point(event),
                });
                if (interactionController.projection().pickedItemId === key) {
                  suppressActivationAfterDrag = true;
                }
              });
              itemEl.addEventListener('pointerleave', stopAutoscroll);
              itemEl.addEventListener('pointerup', (event) => {
                stopAutoscroll();
                void interactionController.pointerUp({
                  pointerId: pointerId(event),
                  point: point(event),
                });
              });
              itemEl.addEventListener('pointercancel', (event) => {
                stopAutoscroll();
                interactionController.pointerCancel(pointerId(event));
              });
              itemEl.addEventListener('lostpointercapture', (event) => {
                stopAutoscroll();
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

      if (visible && !presentationCollapsed && options.renderColumnFooter) {
        const footer = scroll.createDiv({
          cls: 'abyss-board-column-footer',
          attr: { 'data-board-column-add': column.key },
        });
        options.renderColumnFooter(footer, column);
      }

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
        restore.disabled = !presentationEnabled;
        restore.setAttribute('aria-disabled', String(restore.disabled));
        restore.addEventListener('click', () => {
          if (restore.disabled) return;
          updateColumnPreference(restoreBoardColumn(columnPreference!, column.key));
        });
      }
    }
    if (focusedTabKey !== null || selectionReconciled) {
      const focusKey = focusedTabKey ?? selectedColumnKey;
      Array.from(container.querySelectorAll<HTMLElement>('[data-board-column-tab]'))
        .find(({ dataset }) => dataset['boardColumnTab'] === focusKey)
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
      stopAutoscroll();
      unsubscribeOptimisticOverlay?.();
      container.ownerDocument.removeEventListener('visibilitychange', stopAutoscrollWhenHidden);
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
  const optimisticOverlay = options.overlayScope
    ? {
        store: optimisticOverlayStoreFor<WorkNoteSnapshot, string>(
          options.overlayScope,
          'board:work-note-status',
          {
            keyOf: ({ path }) => path,
            apply: (note, statusId) => ({ ...note, statusId }),
            matches: (note, statusId) => note.statusId === statusId,
            isSuccess: (result) => result.type === 'ok',
            timeoutMs: 15_000,
          },
        ),
        keyOf: ({ path }: WorkNoteSnapshot) => path,
        // This is both a source guard and a rendered-card fingerprint. A non-status
        // edit must compete with (rather than silently settle) a pending status move.
        revision: (note: WorkNoteSnapshot) =>
          JSON.stringify({
            presetRevision: note.presetRevision,
            presetFingerprint: note.presetFingerprint,
            path: note.path,
            kind: note.kind,
            projectPath: note.projectPath,
            statusId: note.statusId,
            rawStatus: note.rawStatus,
            writableStatusShape: note.writableStatusShape,
            priority: note.priority,
            description: note.description,
            updated: note.updated,
            range: note.range,
            id: note.id,
            milestonePath: note.milestonePath,
            blockedByPaths: note.blockedByPaths,
            relatedPaths: note.relatedPaths,
            diagnostics: note.diagnostics,
          }),
        columnKey: (note: WorkNoteSnapshot) => note.statusId ?? 'unmapped',
        undoAvailable: false,
        presentationAnnouncement: true,
      }
    : undefined;
  return renderBoard(container, {
    columns: workNoteBoardColumns(options.statuses, options.notes),
    mutation,
    itemKey: ({ path }) => path,
    renderItem: options.renderItem,
    session: options.session,
    mutationEnabled: options.commandsEnabled,
    presentationEnabled: true,
    mutationDisabledTitle: 'Requires an accepted compatibility audit with update capability',
    interactionController: true,
    manageStatusMenu: true,
    canonicalItems: options.notes,
    itemLabel: ({ path }) => path.split('/').pop()?.replace(/\.md$/u, '') ?? path,
    announce: options.announce,
    ...(optimisticOverlay && { optimisticOverlay }),
    ...(options.columnPreference && {
      columnPreferences: {
        value: options.columnPreference,
        configuredColumnIds: options.statuses.map(({ id }) => id),
        terminalLeftIds: [],
        terminalRightIds: [],
        onChange: (next: BoardViewPreference) => options.onColumnPreferenceChange?.(next),
      },
    }),
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

/** Project Task entity port for the shared Task 6 board controller and DOM lifecycle. */
export function renderProjectTasksBoard(
  container: HTMLElement,
  options: ProjectTasksBoardOptions,
): BoardViewHandle {
  const mutation = createProjectActionBoardMutation(options.statuses, options.onMoveStatus);
  const statusById = new Map(options.statuses.map((status) => [status.id, status]));
  const taskIdCounts = new Map<string, number>();
  for (const { task } of options.actions) {
    const id = task.dependency?.id;
    if (id) taskIdCounts.set(id, (taskIdCounts.get(id) ?? 0) + 1);
  }
  const stableTaskStatusKey = ({ task }: ProjectAction): string => {
    // Tasks-compatible IDs survive both a status rewrite and a source relocation. Only
    // use them when unique; an ambiguous ID must retain precise source identity.
    const id = task.dependency?.id;
    if (id && taskIdCounts.get(id) === 1) return `id:${id}`;
    return `source:${task.ref.filePath}:${String(task.ref.line)}`;
  };
  const taskPublicationSequence = (revision: string): number | undefined => {
    const prefix = 'task-ref:1:';
    if (!revision.startsWith(prefix)) return undefined;
    try {
      const parsed = JSON.parse(revision.slice(prefix.length)) as unknown;
      if (!Array.isArray(parsed) || typeof parsed[1] !== 'string') return undefined;
      const generation = Number.parseInt(parsed[1], 36);
      return Number.isSafeInteger(generation) ? generation : undefined;
    } catch {
      return undefined;
    }
  };
  const optimisticOverlay = options.overlayScope
    ? {
        store: optimisticOverlayStoreFor<ProjectAction, string>(
          options.overlayScope,
          'board:task-status',
          {
            keyOf: stableTaskStatusKey,
            apply: (action, statusId) => {
              const status = statusById.get(statusId);
              if (!status) return action;
              let taskStatus: TaskSnapshot['status'];
              if (status.type === 'todo') taskStatus = 'open';
              else if (status.type === 'done') taskStatus = 'done';
              else taskStatus = status.type;
              return {
                ...action,
                task: { ...action.task, status: taskStatus, statusSymbol: status.symbol },
              };
            },
            matches: (action, statusId) =>
              statusById.get(statusId)?.symbol === action.task.statusSymbol,
            isSuccess: (result) => result.type === 'ok',
            timeoutMs: 15_000,
          },
        ),
        keyOf: stableTaskStatusKey,
        revision: ({ task }: ProjectAction) => task.ref.revision,
        publicationSequence: ({ task }: ProjectAction) =>
          taskPublicationSequence(task.ref.revision),
        ...(options.taskSuccessor && {
          continuity: (observed: ProjectAction, published: ProjectAction) =>
            options.taskSuccessor!(observed.task, published.task),
        }),
        columnKey: ({ task }: ProjectAction) =>
          options.statuses.find(({ symbol }) => symbol === task.statusSymbol)?.id ?? 'unmapped',
        undoAvailable: false,
        presentationAnnouncement: true,
      }
    : undefined;
  return renderBoard(container, {
    columns: projectActionBoardColumns(options.statuses, options.actions),
    visibleColumnKeys: options.visibleColumnKeys,
    canonicalItems: options.actions,
    mutation,
    itemKey: ({ task }) => taskPresentationKey(task.ref),
    itemLabel: ({ task }) => task.title,
    renderItem: options.renderItem,
    session: options.session,
    focusedItemKey: options.focusedItemKey,
    shouldRestoreItemFocus: options.shouldRestoreItemFocus,
    onItemFocus: options.onItemFocus,
    onItemBlur: options.onItemBlur,
    interactionController: true,
    announce: options.announce,
    ...(optimisticOverlay && { optimisticOverlay }),
    ...(options.columnPreference && {
      columnPreferences: {
        value: options.columnPreference,
        configuredColumnIds: options.statuses.map(({ id }) => id),
        terminalLeftIds: [],
        terminalRightIds: [],
        onChange: (next: BoardViewPreference) => options.onColumnPreferenceChange?.(next),
      },
    }),
    ...(options.renderColumnAdd && {
      renderColumnFooter: (host: HTMLElement, column: BoardColumn<ProjectAction>) => {
        const status = statusById.get(column.key);
        if (status) options.renderColumnAdd?.(host, status);
      },
    }),
    ...(options.onCollapsedColumnAddRequest && {
      onCollapsedColumnFooterRequest: (column: BoardColumn<ProjectAction>) => {
        const status = statusById.get(column.key);
        if (status) options.onCollapsedColumnAddRequest?.(status);
      },
    }),
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
  readonly overlayScope?: object;
}

/** Adapts Project lifecycle records to the shared board shell. */
export function renderProjectsBoard(
  container: HTMLElement,
  options: ProjectsBoardOptions,
): BoardViewHandle {
  let destroyed = false;
  const toolbar = renderProjectsToolbar(container, options);
  const { newProjectButton } = toolbar;
  const boardHost = container.createDiv({ cls: 'abyss-projects-board-host' });
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
  const optimisticOverlay = options.overlayScope
    ? {
        store: optimisticOverlayStoreFor<(typeof projects)[number], string>(
          options.overlayScope,
          'board:project-status',
          {
            keyOf: ({ path }) => path,
            apply: (project, statusId) => ({ ...project, statusId }),
            matches: (project, statusId) => project.statusId === statusId,
            isSuccess: (result) => result.type === 'ok',
            timeoutMs: 15_000,
          },
        ),
        keyOf: ({ path }: (typeof projects)[number]) => path,
        revision: (project: (typeof projects)[number]) =>
          JSON.stringify({
            path: project.path,
            frontmatter: project.frontmatter,
            statusId: project.statusId,
            rawStatus: project.rawStatus,
            priority: project.priority,
            description: project.description,
            comments: project.comments,
            observed: project.observed,
            diagnostics: project.metadataDiagnostics,
          }),
        columnKey: (project: (typeof projects)[number]) => project.statusId ?? 'unmapped',
        presentationAnnouncement: true,
      }
    : undefined;
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
    canonicalItems: projects,
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
        true,
        false,
      );
    },
    session: options.session,
    mutationEnabled: lifecycle.valid,
    mutationDisabledTitle: 'Repair duplicate Dropped or Published lifecycle statuses in Settings',
    interactionController: true,
    itemLabel: ({ name }) => name,
    announce: options.onAnnounce,
    ...(optimisticOverlay && { optimisticOverlay }),
    columnPreferences: {
      value: options.settings.projects.view.board,
      configuredColumnIds: statuses.map(({ id }) => id),
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
