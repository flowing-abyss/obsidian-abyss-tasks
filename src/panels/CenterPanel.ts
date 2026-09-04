import { Component, Menu, setIcon, type App, type MenuItem } from 'obsidian';
import type { AppState } from '../app/AppState';
import {
  isListViewCustomized,
  listSelectionToKey,
  normalizeStatusGroups,
  statusGroupsEqual,
} from '../app/listViewState';
import { firstVisibleWeekDate } from '../domain/weekGridOffset';
import type { LinkToken } from '../markdown/links';
import { PRIORITY_LEVELS } from '../priority';
import type { ProjectManager } from '../projects/ProjectManager';
import type { ProjectStore } from '../projects/ProjectStore';
import { DEFAULT_VIEW_CONFIG, getListViewDefaults } from '../settings/defaults';
import type {
  CalendarSettings,
  ListViewState,
  PropertyFilter,
  ResolvedConfig,
} from '../settings/types';
import type { StatusRegistry } from '../status/StatusRegistry';
import { ACTIVE_STATUS_GROUPS, ALL_STATUS_GROUPS, TYPE_LABELS } from '../status/statusConstants';
import { searchTaskList, selectTaskList } from '../task-lists/TaskListSelector';
import {
  daysBetweenLocalDates,
  durationMinutes,
  localDate,
  localTime,
  shiftLocalDate,
  type CommentTimeContextProvider,
  type LocalDate,
  type TaskApplicationApi,
  type TaskCaptureApplicationApi,
  type TaskCommandResult,
  type TaskPriority,
  type TaskQueryApi,
  type TaskRef,
  type TaskSnapshot,
  type TaskStatusType,
} from '../tasks';
import { showDatePickerPopover } from '../ui/DatePickerPopover';
import { LinkEditModal } from '../ui/LinkEditModal';
import { renderStatusMarker } from '../ui/StatusMarker';
import { TagPickerModal } from '../ui/TagPickerModal';
import { TaskModal } from '../ui/TaskModal';
import { isImeOwnedEvent } from '../ui/ime';
import { noInteractionOwnership, type InteractionOwnershipPort } from '../ui/interactionOwnership';
import { moveTaskToProjectWithRecovery } from '../ui/moveTaskToProject';
import { showMenuAtMouseEventWithFocus } from '../ui/nativeMenuFocus';
import { mountAnchoredRecurrenceEditor } from '../ui/recurrence/RecurrenceEditor';
import {
  recurrenceBadgeInput,
  renderRecurrenceBadge,
} from '../ui/recurrence/renderRecurrenceBadge';
import { renderTaskText } from '../ui/renderTaskText';
import { runAsyncAction } from '../ui/runAsyncAction';
import { renderSourceNoteChip, shouldShowSourceNote } from '../ui/sourceNoteChip';
import { buildStatusSubmenu, showStatusMenuAt } from '../ui/statusMenu';
import { CaptureSurface } from '../ui/taskCapture/CaptureSurface';
import {
  CaptureTargetResolver,
  type CaptureContext,
  type CaptureTarget,
} from '../ui/taskCapture/CaptureTargetResolver';
import { TaskCaptureController } from '../ui/taskCapture/TaskCaptureController';
import {
  describeTaskCreationResult,
  presentTaskCommandResult,
  requestTaskCompletion,
  type CreationResultDescription,
} from '../ui/taskCommandResult';
import { openInFile } from '../ui/taskNavigation';
import { applyTaskPresentationIdentity } from '../ui/taskPresentationIdentity';
import { rootTaskRef, taskNodeLine } from '../ui/taskSelection';
import { TimedBlockKeyboardQueue } from '../ui/timedBlockKeyboardQueue';
import { MonthGridView } from '../views/MonthGridView';
import { TodayView } from '../views/TodayView';
import { WeekTimeGridView } from '../views/WeekTimeGridView';
import {
  calendarMutationTarget,
  calendarOccurrenceForTask,
  calendarPatchCommand,
  calendarRootTaskRef,
  calendarSourcePatchCommand,
  hasOtherCalendarRecurrenceOwner,
  isForecastCalendarTask,
  projectCalendarOccurrences,
  taskSnapshotForCalendarOccurrence,
  type CalendarProjectionIssue,
  type CalendarTaskSource,
} from '../views/calendarOccurrences';
import {
  PanelNavigator,
  type CalViewType,
  type PanelNavigationActions,
} from '../views/panelNavigation';
import type { InteractiveSpanBoundaryTarget, SpanMoveTarget } from '../views/spanInteractions';
import {
  groupTasksByDate,
  groupTasksByPriority,
  groupTasksByStatus,
  groupTasksByTag,
} from '../views/taskGrouping';
import type { TimedDragTarget, TimedVerticalResizeTarget } from '../views/timegrid/dragGeometry';
import {
  minutesToPixels,
  minutesToTimeString,
  timeStringToMinutes,
} from '../views/timegrid/layout';
import {
  createCalendarProjectionDiagnosticOwner,
  createForecastContextMenuOwner,
  type CalendarProjectionDiagnosticOwner,
  type ForecastContextMenuOwner,
} from '../views/timegrid/renderTaskMeta';
import type { TimedBlockKeyboardIntent } from '../views/timegrid/renderTimedBlocks';
import type { TimedBoundaryTarget } from '../views/timegrid/timedInteractions';
import { ProjectsPanel } from './projects/ProjectsPanel';
import { visibleCalendarDates } from './visibleCalendarDates';

interface TimedBlockFocusLocator {
  readonly filePath: string;
  readonly line: number;
  readonly segmentDate?: string;
  readonly sequence: number;
  readonly queueSequence?: number;
  readonly originElement?: HTMLElement;
}

interface PendingTimedBlockRestoration {
  readonly queueSequence: number;
  readonly focusSequence: number;
  readonly renderGeneration: number;
}

type CalendarCapturePlacement =
  | { readonly type: 'calendar-timed'; readonly date: string; readonly time: string }
  | { readonly type: 'calendar-all-day'; readonly date: string }
  | { readonly type: 'calendar-month'; readonly date: string };

type BarCapturePlacement =
  | { readonly type: 'list'; readonly selectionKey: string }
  | { readonly type: 'project'; readonly path: string };

type PanelCapturePlacement = BarCapturePlacement | CalendarCapturePlacement;

interface CalendarNavigationElements {
  readonly prevButton: HTMLButtonElement;
  readonly monthButton: HTMLButtonElement;
  readonly yearButton: HTMLButtonElement;
  readonly nextButton: HTMLButtonElement;
  readonly todayButton: HTMLButtonElement;
}

interface CalendarContent {
  readonly config: ResolvedConfig;
  readonly issues: readonly CalendarProjectionIssue[];
  readonly tasks: TaskSnapshot[];
}

interface CalendarHandlers {
  readonly onTaskClick: (task: TaskSnapshot) => void;
  readonly onForecastClick: (source: CalendarTaskSource, referenceDate: LocalDate) => void;
  readonly onForecastContextMenu: (source: CalendarTaskSource) => void;
  readonly onDrop: (dragData: string, targetDate: string) => void;
  readonly onDropTime: (dragData: string, date: string, time: string) => void;
  readonly onCreateAtTime: (date: string, time: string) => void;
  readonly onCreateAtDate: (date: string) => void;
  readonly onCreateAtDateAllDay: (date: string) => void;
  readonly onTimeChange: (task: TaskSnapshot, minutes: number) => void;
  readonly onDurationChange: (task: TaskSnapshot, minutes: number) => void;
  readonly onTimedMove: (task: TaskSnapshot, target: TimedDragTarget) => void;
  readonly onTimedDuration: (task: TaskSnapshot, target: TimedVerticalResizeTarget) => void;
  readonly onTimedBoundary: (task: TaskSnapshot, target: TimedBoundaryTarget) => void;
  readonly onSpanMove: (task: TaskSnapshot, target: SpanMoveTarget) => void;
  readonly onSpanBoundary: (task: TaskSnapshot, target: InteractiveSpanBoundaryTarget) => void;
  readonly onStartChange: (task: TaskSnapshot, start: string) => void;
  readonly onDueChange: (task: TaskSnapshot, due: string) => void;
  readonly onExtendToSpan: (task: TaskSnapshot, due: string) => void;
  readonly onKeyboardIntent: (task: TaskSnapshot, intent: TimedBlockKeyboardIntent) => void;
  readonly onToggle: (task: TaskSnapshot) => void;
  readonly onSetStatus: (task: TaskSnapshot, status: string) => void;
  readonly onSetPriority: (task: TaskSnapshot, priority: TaskPriority) => void;
}

interface CalendarRenderContext {
  readonly viewContainer: HTMLElement;
  readonly forecastMenuOwner: ForecastContextMenuOwner;
  readonly projectionDiagnosticOwner: CalendarProjectionDiagnosticOwner;
  readonly handlers: CalendarHandlers;
}

interface ViewStateOption {
  readonly label: string;
  readonly value: string;
}

interface ViewStateRowSpec {
  readonly icon: string;
  readonly label: string;
  readonly displayValue: string;
  readonly activeValue: string;
  readonly defaultValue: string;
  readonly options: readonly ViewStateOption[];
  readonly onSelect: (value: string) => void;
}

interface ViewStatePreset {
  readonly label: string;
  readonly onClick: () => void;
  readonly isActive?: boolean;
}

interface ViewStateMultiRowSpec {
  readonly icon: string;
  readonly label: string;
  readonly displayValue: string;
  readonly selected: readonly string[];
  readonly options: readonly ViewStateOption[];
  readonly onToggle: (value: string) => void;
  readonly initiallyOpen: boolean;
  readonly presets: readonly ViewStatePreset[];
}

interface ViewStatePopoverSession {
  readonly popover: HTMLElement;
  readonly close: (restoreFocus?: boolean) => void;
}

interface PanelCaptureSession {
  readonly requestId: number;
  readonly placement: PanelCapturePlacement;
  readonly controller: TaskCaptureController;
  surface?: CaptureSurface | undefined;
  host?: HTMLElement | undefined;
  feedbackHost?: HTMLElement | undefined;
  returnFocus?: HTMLElement;
  restoreFocusOnClose: boolean;
  focusOnMount: boolean;
}

type CenterPanelConstructorArgs = [
  state: AppState,
  app: App,
  settings: CalendarSettings,
  queries: TaskQueryApi,
  statusRegistry: StatusRegistry,
  onSaveSettings?: () => Promise<void>,
  projectStore?: ProjectStore | null,
  projectManager?: ProjectManager | null,
  tasks?: TaskApplicationApi,
  commentTimeContext?: CommentTimeContextProvider,
  captureApplication?: TaskApplicationApi & TaskCaptureApplicationApi,
  onCreationResult?: (result: TaskCommandResult, description: CreationResultDescription) => void,
  onRenderComplete?: (root: HTMLElement) => void,
  interactionOwnership?: InteractionOwnershipPort,
  navigation?: PanelNavigationActions,
];

function isRealmHTMLElement(target: EventTarget | null): target is HTMLElement {
  if (target == null || !('ownerDocument' in target)) return false;
  const ownerDocument = (target as { readonly ownerDocument?: Document }).ownerDocument;
  const realm = ownerDocument?.defaultView;
  return realm !== null && realm !== undefined && target instanceof realm.HTMLElement;
}

function projectNameFromPath(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.md$/, '');
}

/**
 * Colors a priority-submenu flag icon to match the rest of the UI (status
 * popover flags, flag settings, etc.) by tagging the item's undocumented
 * `.dom` element — Obsidian doesn't expose per-item icon styling otherwise.
 */
function applyPriorityFlagColor(si: MenuItem, value: TaskPriority): void {
  const dom = (si as unknown as { dom?: HTMLElement }).dom;
  if (dom != null) {
    dom.addClass('abyss-menu-priority-flag');
    dom.setAttribute('data-abyss-priority', value);
  }
}

/** Obsidian's MenuItem.setSubmenu() is undocumented; reach it via one shared cast. */
function getSubmenu(item: MenuItem): Menu {
  return (item as unknown as { setSubmenu(): Menu }).setSubmenu();
}

export class CenterPanel {
  private readonly completionConfirmationAbortController = new AbortController();
  private el!: HTMLElement;
  private readonly offs: Array<() => void> = [];
  private calViewType: CalViewType = 'month';
  private calDate = window.moment().date(1);
  private calViewInstance: TodayView | WeekTimeGridView | MonthGridView | null = null;
  private calUnsubscribe: (() => void) | null = null;
  private calendarPickerCleanup: ((restoreFocus?: boolean) => void) | null = null;
  private taskDatePickerCleanup: (() => void) | null = null;
  private taskCardRenderGeneration = 0;
  private taskDateFocusContinuityKey: string | null = null;
  private pendingTaskDateFocus: {
    key: string;
    armedRenderGeneration: number;
    changed: boolean;
  } | null = null;
  private recurrenceEditorCleanup: (() => void) | null = null;
  private viewStatePopoverCleanup: ((restoreFocus?: boolean) => void) | null = null;
  private forecastMenuOwner: ForecastContextMenuOwner | null = null;
  private projectionDiagnosticOwner: CalendarProjectionDiagnosticOwner | null = null;
  // Full renders replace the view instance, so keep the last scroll-to-now key at panel scope.
  // Query notifications use the incremental patch path and never consult this state.
  private lastScrolledCalKey: string | null = null;
  // A deliberate full refresh empties the outer calendar before mountView can inspect its grid.
  // Carry scrollTop across that boundary; query patches retain the grid node and need no fallback.
  private pendingCalScrollTop: number | undefined = undefined;
  private readonly keyboardQueue: TimedBlockKeyboardQueue | null;
  private pendingTimedBlockFocus: TimedBlockFocusLocator | undefined;
  private readonly settledKeyboardSequences = new Set<number>();
  private readonly restoredKeyboardSequences = new Set<number>();
  private readonly committedKeyboardSequences = new Set<number>();
  private readonly pendingTimedBlockRestorations = new Map<number, PendingTimedBlockRestoration>();
  private nextTimedBlockRestoration = 0;
  private nextTimedBlockFocusSequence = 0;
  private calendarRenderGeneration = 0;
  private taskModal: TaskModal | null = null;
  private readonly selectedTaskKeys = new Set<string>();
  private lastAnnouncedSelectionCount = 0;
  private selectionAnchorKey: string | null = null;
  private selectionFocusKey: string | null = null;
  private filterDebounce = 0;
  private refocusSearch = false;
  // Set true while a status-group toggle click is in flight, so that the
  // full re-render triggered by updateViewState re-opens the popover with
  // the "Status group" row still expanded (multi-select shouldn't close on pick).
  private reopenStatusGroupPopover = false;
  private readonly onSaveSettings: () => Promise<void>;
  private md = new Component();
  private searchInputEl: HTMLInputElement | null = null;
  private searchResultsEl: HTMLElement | null = null;
  private searchResultsFrame: number | null = null;

  private projectsPanel: ProjectsPanel | null = null;
  private readonly captureApplication: (TaskApplicationApi & TaskCaptureApplicationApi) | null;
  private readonly captureTargets: CaptureTargetResolver | null;
  private captureRequestId = 0;
  private resolvingCapture: {
    readonly requestId: number;
    readonly placement: PanelCapturePlacement;
  } | null = null;
  private activeCapture: PanelCaptureSession | null = null;
  private readonly navigation: PanelNavigationActions;
  private readonly state: AppState;
  private readonly app: App;
  private readonly settings: CalendarSettings;
  private readonly queries: TaskQueryApi;
  private readonly statusRegistry: StatusRegistry;
  private readonly projectStore: ProjectStore | null;
  private readonly projectManager: ProjectManager | null;
  private readonly tasks: TaskApplicationApi | undefined;
  private readonly commentTimeContext: CommentTimeContextProvider | undefined;
  private readonly onCreationResult: (
    result: TaskCommandResult,
    description: CreationResultDescription,
  ) => void;
  private readonly onRenderComplete: (root: HTMLElement) => void;
  private readonly interactionOwnership: InteractionOwnershipPort;

  constructor(...args: CenterPanelConstructorArgs) {
    const [
      state,
      app,
      settings,
      queries,
      statusRegistry,
      onSaveSettings = async (): Promise<void> => {},
      projectStore = null,
      projectManager = null,
      tasks,
      commentTimeContext,
      captureApplication,
      onCreationResult = (): void => {},
      onRenderComplete = (): void => {},
      interactionOwnership = noInteractionOwnership,
      navigation,
    ] = args;
    this.state = state;
    this.app = app;
    this.settings = settings;
    this.queries = queries;
    this.statusRegistry = statusRegistry;
    this.onSaveSettings = onSaveSettings;
    this.projectStore = projectStore;
    this.projectManager = projectManager;
    this.tasks = tasks;
    this.commentTimeContext = commentTimeContext;
    this.onCreationResult = onCreationResult;
    this.onRenderComplete = onRenderComplete;
    this.interactionOwnership = interactionOwnership;
    this.captureApplication = captureApplication ?? null;
    this.captureTargets =
      this.captureApplication != null
        ? new CaptureTargetResolver(this.captureApplication, settings)
        : null;
    this.navigation = this.createNavigation(navigation);
    this.keyboardQueue = this.createKeyboardQueue(tasks);
  }

  private createNavigation(navigation: PanelNavigationActions | undefined): PanelNavigationActions {
    return (
      navigation ??
      new PanelNavigator(
        this.state,
        this.settings,
        {
          calendarView: () => this.calendarView(),
          setCalendarView: (view) => {
            this.setCalendarView(view);
          },
          openQuickCapture: () => undefined,
        },
        this.onSaveSettings,
      )
    );
  }

  private createKeyboardQueue(
    tasks: TaskApplicationApi | undefined,
  ): TimedBlockKeyboardQueue | null {
    if (tasks == null) return null;
    return new TimedBlockKeyboardQueue(tasks, {
      onCommitted: (task, intent, sequence, changed) => {
        this.handleKeyboardCommit(task, intent, sequence, changed);
      },
      onSettled: (_taskKey, sequence, summary) => {
        this.handleKeyboardSettled(sequence, summary.anyChanged, summary.sourceChanged);
      },
      present: (result) => {
        presentTaskCommandResult(result);
        if (result.type !== 'ok' || result.outcome.type !== 'task') {
          this.clearTimedBlockFocus();
        }
      },
    });
  }

  private handleKeyboardSettled(
    sequence: number,
    anyChanged: boolean,
    sourceChanged: boolean,
  ): void {
    if (this.pendingTimedBlockFocus?.queueSequence !== sequence) return;
    if ((anyChanged || sourceChanged) && !this.committedKeyboardSequences.has(sequence)) {
      this.committedKeyboardSequences.add(sequence);
      this.deferTimedBlockFocus(this.el, this.calendarRenderGeneration);
    }
    const pendingRestoration = this.hasPendingTimedBlockRestoration(sequence);
    if (
      (!anyChanged && !sourceChanged && !pendingRestoration) ||
      this.restoredKeyboardSequences.has(sequence)
    ) {
      this.clearTimedBlockFocus(sequence);
      return;
    }
    this.settledKeyboardSequences.add(sequence);
  }

  mount(container: HTMLElement): void {
    this.el = container;
    this.initializeOwnedUi(container.ownerDocument);
    this.initializeListViewState();
    this.subscribeToState();
    this.render();
    this.el.setAttribute('tabindex', '0');
    this.mountKeyboardNavigation();
    this.mountFocusContinuity();
  }

  private initializeOwnedUi(ownerDocument: Document): void {
    this.forecastMenuOwner = createForecastContextMenuOwner(
      ownerDocument,
      this.interactionOwnership,
    );
    this.taskModal = new TaskModal(
      this.app,
      this.statusRegistry,
      this.settings,
      this.queries,
      this.tasks,
      this.commentTimeContext,
      this.interactionOwnership,
    );
  }

  private initializeListViewState(): void {
    const key = listSelectionToKey(this.state.get('selectedList'));
    const viewState = this.settings.listViewStates?.[key] ?? getListViewDefaults(key);
    this.state.set('centerListViewState', viewState);
  }

  private subscribeToState(): void {
    this.offs.push(
      this.state.on('selectedList', () => {
        this.handleSelectedListChanged();
      }),
      this.state.on('mode', () => {
        this.cancelStaleListCapture();
        this.cancelKeyboardInteraction();
      }),
      this.state.on('searchQuery', (query) => {
        this.handleSearchQueryChanged(query);
      }),
      this.state.on('taskStack', () => {
        this.updateTaskStackSelection();
      }),
      this.state.onCommit((changed) => {
        this.handleStateCommit(changed);
      }),
    );
  }

  private handleSelectedListChanged(): void {
    this.cancelStaleListCapture();
    this.selectedTaskKeys.clear();
    this.selectionAnchorKey = null;
    this.selectionFocusKey = null;
  }

  private updateTaskStackSelection(): void {
    const stack = this.state.get('taskStack');
    const root = stack[0];
    const current = stack[stack.length - 1];
    this.el.querySelectorAll<HTMLElement>('.abyss-task-card').forEach((card) => {
      const isSelected =
        root !== undefined &&
        current !== undefined &&
        card.dataset['filePath'] === rootTaskRef(root).filePath &&
        card.dataset['line'] === String(taskNodeLine(root as TaskSnapshot, current));
      card.classList.toggle('is-selected', isSelected);
      this.syncTaskDeleteButton(
        card,
        isSelected && current === root && this.selectedTaskKeys.size === 0
          ? (root as TaskSnapshot)
          : undefined,
      );
    });
  }

  private handleStateCommit(changed: ReadonlySet<string>): void {
    if (changed.size === 0 && this.state.get('mode') === 'calendar') {
      this.cancelKeyboardInteraction();
    }
    const renderKeys = ['selectedList', 'centerListViewState', 'centerFilter', 'mode'];
    if (changed.size === 0 || renderKeys.some((key) => changed.has(key))) this.render();
  }

  private mountKeyboardNavigation(): void {
    const onKeyDown = (event: KeyboardEvent): void => {
      this.handlePanelKeyDown(event);
    };
    this.el.addEventListener('keydown', onKeyDown);
    this.offs.push(() => {
      this.el.removeEventListener('keydown', onKeyDown);
    });
  }

  private handlePanelKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.hasTaskSelection()) {
      this.clearTaskSelection();
      return;
    }
    if (!this.isTaskNavigationEvent(event)) return;
    const keys = this.visibleTaskKeys();
    if (keys.length === 0) return;
    event.preventDefault();
    this.moveTaskSelection(event, keys);
  }

  private hasTaskSelection(): boolean {
    return (
      this.selectedTaskKeys.size > 0 ||
      this.selectionAnchorKey !== null ||
      this.selectionFocusKey !== null
    );
  }

  private clearTaskSelection(): void {
    this.selectedTaskKeys.clear();
    this.selectionAnchorKey = null;
    this.selectionFocusKey = null;
    this.updateSelectionVisuals();
  }

  private isTaskNavigationEvent(event: KeyboardEvent): boolean {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return false;
    if (this.state.get('mode') !== 'tasks') return false;
    const target = event.target;
    if (!isRealmHTMLElement(target)) return true;
    return (
      target.closest(
        'input, textarea, select, button, a, [contenteditable]:not([contenteditable="false"]), .abyss-status-marker, .abyss-popover',
      ) == null
    );
  }

  private moveTaskSelection(event: KeyboardEvent, keys: readonly string[]): void {
    const currentKey = this.currentNavigationKey(event.target, keys);
    const nextKey = this.nextNavigationKey(event.key, currentKey, keys);
    if (nextKey === undefined || nextKey === '') return;
    if (event.shiftKey) this.extendKeyboardSelection(currentKey, nextKey, keys);
    else this.replaceKeyboardSelection(nextKey);
    this.focusTaskKey(nextKey);
  }

  private currentNavigationKey(
    target: EventTarget | null,
    keys: readonly string[],
  ): string | undefined {
    const targetCard = isRealmHTMLElement(target)
      ? target.closest<HTMLElement>('.abyss-task-card')
      : null;
    const targetKey =
      targetCard != null && this.el.contains(targetCard) ? this.taskCardKey(targetCard) : null;
    const detailCard = this.visibleTaskCards().find((card) =>
      card.classList.contains('is-selected'),
    );
    const detailKey = detailCard == null ? null : this.taskCardKey(detailCard);
    return [this.selectionFocusKey, targetKey, detailKey].find(
      (candidate): candidate is string => candidate !== null && keys.includes(candidate),
    );
  }

  private taskCardKey(card: HTMLElement): string {
    return `${card.dataset['filePath'] ?? ''}:${card.dataset['line'] ?? ''}`;
  }

  private nextNavigationKey(
    key: string,
    currentKey: string | undefined,
    keys: readonly string[],
  ): string | undefined {
    const currentIndex =
      currentKey === undefined || currentKey === '' ? -1 : keys.indexOf(currentKey);
    if (currentIndex === -1) return key === 'ArrowDown' ? keys[0] : keys[keys.length - 1];
    const delta = key === 'ArrowDown' ? 1 : -1;
    return keys[Math.max(0, Math.min(keys.length - 1, currentIndex + delta))];
  }

  private extendKeyboardSelection(
    currentKey: string | undefined,
    nextKey: string,
    keys: readonly string[],
  ): void {
    const anchor =
      this.selectionAnchorKey !== null && keys.includes(this.selectionAnchorKey)
        ? this.selectionAnchorKey
        : currentKey;
    this.selectionAnchorKey = anchor ?? nextKey;
    this.selectionFocusKey = nextKey;
    this.replaceRangeSelection(this.selectionAnchorKey, nextKey, keys);
  }

  private replaceKeyboardSelection(nextKey: string): void {
    this.selectedTaskKeys.clear();
    this.selectionAnchorKey = nextKey;
    this.selectionFocusKey = nextKey;
    this.updateSelectionVisuals();
    const task = this.taskForKey(nextKey);
    if (task != null) this.state.set('taskStack', [task]);
  }

  private mountFocusContinuity(): void {
    const onFocusIn = (event: FocusEvent): void => {
      this.handlePanelFocusIn(event.target);
    };
    const ownerDocument = this.el.ownerDocument;
    ownerDocument.addEventListener('focusin', onFocusIn);
    this.offs.push(() => {
      ownerDocument.removeEventListener('focusin', onFocusIn);
    });
    const onPointerDown = (event: PointerEvent): void => {
      this.revokeTaskDateFocusOutside(event.target);
    };
    ownerDocument.addEventListener('pointerdown', onPointerDown, true);
    this.offs.push(() => {
      ownerDocument.removeEventListener('pointerdown', onPointerDown, true);
    });
    const ownerWindow = ownerDocument.defaultView;
    const onOwnerWindowBlur = (): void => {
      this.abandonTaskDateFocus();
      if (this.pendingTimedBlockFocus != null) this.cancelKeyboardInteraction();
    };
    ownerWindow?.addEventListener('blur', onOwnerWindowBlur);
    this.offs.push(() => {
      ownerWindow?.removeEventListener('blur', onOwnerWindowBlur);
    });
  }

  private handlePanelFocusIn(target: EventTarget | null): void {
    this.revokeTaskDateFocusOutside(target);
    if (!isRealmHTMLElement(target)) return;
    const ownerDocument = this.el.ownerDocument;
    if (target === ownerDocument.body || target === ownerDocument.documentElement) return;
    const block = target.closest<HTMLElement>('.abyss-tg-block');
    if (block != null && this.el.contains(block)) this.retainTimedBlockFocus(block);
    else if (this.pendingTimedBlockFocus != null) this.cancelKeyboardInteraction();
  }

  private revokeTaskDateFocusOutside(target: EventTarget | null): void {
    const key = this.taskDateFocusContinuityKey;
    if (key !== null && this.taskDateTriggerKey(target) !== key) this.abandonTaskDateFocus();
  }

  refresh(): void {
    if (
      this.state.get('mode') === 'search' &&
      (this.searchInputEl?.isConnected ?? false) &&
      (this.searchResultsEl?.isConnected ?? false)
    ) {
      this.scheduleSearchResults(this.state.get('searchQuery'));
      return;
    }
    this.render();
  }

  calendarView(): CalViewType {
    return this.calViewType;
  }

  setCalendarView(view: CalViewType): void {
    this.calViewType = view;
    if (view === 'week') this.calDate = window.moment().startOf('isoWeek');
    else if (view === 'today') this.calDate = window.moment();
    else this.calDate = window.moment().date(1);
  }

  destroy(): void {
    this.completionConfirmationAbortController.abort();
    this.cancelActiveCapture();
    this.cancelKeyboardInteraction();
    this.abandonTaskDateFocus();
    this.clearSearchShell();
    this.clearTaskDatePicker();
    this.dismissRecurrenceEditor();
    this.viewStatePopoverCleanup?.();
    this.taskModal?.close();
    window.clearTimeout(this.filterDebounce);
    this.offs.forEach((f) => {
      f();
    });
    this.destroyCalendarView();
    this.destroyProjectsPanel();
    this.md.unload();
    if ('el' in this) this.el.empty();
  }

  private destroyProjectsPanel(): void {
    this.projectsPanel?.destroy();
    this.projectsPanel = null;
  }

  /** Renders a project's tasks (reusing the card component) plus an add bar that writes into the note. */
  private renderProjectTasks(host: HTMLElement, path: string): void {
    const tasks = [...this.queries.list({ filePath: path })];
    const scroll = host.createDiv({ cls: 'abyss-center-scroll abyss-project-tasks-scroll' });
    if (tasks.length === 0) {
      scroll.createDiv({ cls: 'abyss-center-empty', text: 'No tasks yet' });
    } else {
      for (const task of tasks) this.renderTaskCard(scroll, task);
    }

    const bar = host.createDiv({ cls: 'abyss-add-task-bar' });
    this.renderCaptureHost(bar, { type: 'project', path });
    this.completeTaskCardRender();
  }

  private destroyCalendarView(): void {
    this.forecastMenuOwner?.dismiss();
    this.projectionDiagnosticOwner?.destroy();
    this.projectionDiagnosticOwner = null;
    this.clearCalendarPicker();
    this.calUnsubscribe?.();
    this.calUnsubscribe = null;
    this.calViewInstance?.destroy();
    this.calViewInstance = null;
  }

  private clearCalendarPicker(restoreFocus = false): void {
    this.calendarPickerCleanup?.(restoreFocus);
  }

  private armCalendarPicker(picker: HTMLElement, anchor: HTMLElement): void {
    const ownerDocument = this.el.ownerDocument;
    const ownershipToken = this.interactionOwnership.acquire({ blocksShortcuts: true });
    let registrationTimer: number | undefined;
    let listening = false;
    const dismiss = (event: MouseEvent): void => {
      if (!picker.contains(event.target as Node) && event.target !== anchor) cleanup();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      cleanup(true);
    };
    const cleanup = (restoreFocus = false): void => {
      if (registrationTimer !== undefined) {
        window.clearTimeout(registrationTimer);
        registrationTimer = undefined;
      }
      if (listening) {
        ownerDocument.removeEventListener('click', dismiss, true);
        listening = false;
      }
      picker.removeEventListener('keydown', onKeyDown);
      picker.remove();
      anchor.setAttribute('aria-expanded', 'false');
      ownershipToken.release();
      if (this.calendarPickerCleanup === cleanup) this.calendarPickerCleanup = null;
      if (restoreFocus && anchor.isConnected) anchor.focus();
    };
    this.calendarPickerCleanup = cleanup;
    anchor.setAttribute('aria-expanded', 'true');
    picker.addEventListener('keydown', onKeyDown);
    const selectedOption = picker.querySelector<HTMLElement>('button.is-active');
    const firstOption = picker.querySelector<HTMLElement>('button:not(:disabled)');
    (selectedOption ?? firstOption)?.focus({ preventScroll: true });
    registrationTimer = window.setTimeout(() => {
      registrationTimer = undefined;
      if (this.calendarPickerCleanup !== cleanup || !picker.isConnected) return;
      ownerDocument.addEventListener('click', dismiss, true);
      listening = true;
    }, 0);
  }

  private render(): void {
    const mode = this.state.get('mode');
    this.prepareRender(mode);
    if (mode !== 'projects') this.destroyProjectsPanel();
    if (mode === 'calendar') {
      this.renderCalendarRoot();
      return;
    }
    this.prepareNonCalendarRoot();
    if (mode === 'search') {
      this.renderSearch();
      return;
    }
    if (mode === 'projects') {
      this.renderProjectsMode();
      return;
    }
    this.renderTasksMode();
  }

  private prepareRender(mode: string): void {
    this.unmountActiveCapture();
    this.clearTaskDatePicker();
    this.dismissRecurrenceEditor();
    this.viewStatePopoverCleanup?.();
    this.clearSearchShell();
    if (mode === 'search') return;
    this.md.unload();
    this.md = new Component();
    this.md.load();
  }

  private renderCalendarRoot(): void {
    this.captureActiveTimedBlockFocus();
    this.pendingCalScrollTop = this.el.querySelector<HTMLElement>('.abyss-tg-grid-row')?.scrollTop;
    this.el.empty();
    this.el.addClass('abyss-center--calendar');
    this.destroyCalendarView();
    this.renderCalendarMode();
  }

  private prepareNonCalendarRoot(): void {
    this.el.removeClass('abyss-center--calendar');
    this.destroyCalendarView();
    this.el.empty();
  }

  private renderProjectsMode(): void {
    this.el.addClass('abyss-center--projects');
    if (this.projectStore == null || this.projectManager == null) {
      this.el.createDiv({ cls: 'abyss-center-empty', text: 'Projects unavailable' });
      this.onRenderComplete(this.el);
      return;
    }
    this.destroyProjectsPanel();
    this.projectsPanel = new ProjectsPanel(
      this.state,
      this.projectStore,
      this.projectManager,
      this.settings,
      this.app,
      {
        renderTasks: (host, path) => {
          this.renderProjectTasks(host, path);
        },
      },
    );
    const host = this.el.createDiv({ cls: 'abyss-projects-host' });
    this.projectsPanel.mount(host);
    this.onRenderComplete(this.el);
  }

  private renderTasksMode(): void {
    this.el.removeClass('abyss-center--projects');
    const header = this.el.createDiv({ cls: 'abyss-center-header' });
    header.createEl('h2', { cls: 'abyss-center-title', text: this.getTitle() });
    const controls = header.createDiv({ cls: 'abyss-center-controls' });
    this.renderPropertyChips(controls);
    this.renderViewStateButton(controls);
    this.renderTaskFilterInput(controls);
    const tasks = this.getFilteredTasks();
    const scroll = this.el.createDiv({ cls: 'abyss-center-scroll' });
    if (tasks.length === 0) scroll.createDiv({ cls: 'abyss-center-empty', text: 'No tasks' });
    else this.renderWithGrouping(scroll, tasks);
    this.renderAddTaskBar();
    this.reconcileTaskSelection(this.visibleTaskKeys());
    this.updateSelectionVisuals();
    this.completeTaskCardRender();
  }

  private renderTaskFilterInput(controls: HTMLElement): void {
    const searchInput = controls.createEl('input', {
      cls: 'abyss-center-search',
      attr: { type: 'text', placeholder: 'Filter…', 'aria-label': 'Filter tasks' },
    });
    searchInput.value = this.state.get('centerFilter');
    if (this.refocusSearch) {
      this.refocusSearch = false;
      window.setTimeout(() => {
        searchInput.focus();
        searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);
      }, 0);
    }
    searchInput.addEventListener('input', () => {
      window.clearTimeout(this.filterDebounce);
      this.filterDebounce = window.setTimeout(() => {
        this.refocusSearch = true;
        this.state.set('centerFilter', searchInput.value);
      }, 150);
    });
  }

  private renderCalendarMode(): void {
    const forecastMenuOwner =
      this.forecastMenuOwner ??
      createForecastContextMenuOwner(this.el.ownerDocument, this.interactionOwnership);
    this.forecastMenuOwner = forecastMenuOwner;
    const projectionDiagnosticOwner = createCalendarProjectionDiagnosticOwner(
      this.el.ownerDocument,
    );
    this.projectionDiagnosticOwner = projectionDiagnosticOwner;
    const navigation = this.createCalendarNavigation();
    const viewContainer = this.el.createDiv({ cls: 'abyss-cal-body' });
    const updateTitle = (): void => {
      this.updateCalendarTitle(navigation);
    };
    updateTitle();
    const handlers = this.createCalendarHandlers(viewContainer);
    const context: CalendarRenderContext = {
      viewContainer,
      forecastMenuOwner,
      projectionDiagnosticOwner,
      handlers,
    };
    const mountView = (): void => {
      this.mountCalendarView(context);
    };
    const patchView = (): void => {
      this.patchCalendarView(context, mountView);
    };
    mountView();

    this.bindCalendarNavigation(navigation, updateTitle, mountView);
    this.calUnsubscribe = this.queries.subscribe(() => {
      patchView();
    });
  }

  private createCalendarNavigation(): CalendarNavigationElements {
    const nav = this.el.createDiv({ cls: 'abyss-cal-nav' });
    const left = nav.createDiv({ cls: 'abyss-cal-nav-left' });
    const prevButton = left.createEl('button', {
      cls: 'abyss-cal-nav-btn',
      attr: { 'aria-label': 'Previous' },
    });
    setIcon(prevButton, 'chevron-left');
    const title = left.createDiv({ cls: 'abyss-cal-nav-title-group' });
    const monthButton = title.createEl('button', {
      cls: 'abyss-cal-nav-month',
      attr: { 'aria-haspopup': 'dialog', 'aria-expanded': 'false' },
    });
    const yearButton = title.createEl('button', {
      cls: 'abyss-cal-nav-year',
      attr: { 'aria-haspopup': 'dialog', 'aria-expanded': 'false' },
    });
    const nextButton = left.createEl('button', {
      cls: 'abyss-cal-nav-btn',
      attr: { 'aria-label': 'Next' },
    });
    setIcon(nextButton, 'chevron-right');
    const right = nav.createDiv({ cls: 'abyss-cal-nav-right' });
    const todayButton = right.createEl('button', { cls: 'abyss-cal-nav-today', text: 'Today' });
    this.renderCalendarViewSwitcher(right);
    return { prevButton, monthButton, yearButton, nextButton, todayButton };
  }

  private currentCalendarContent(): CalendarContent {
    const config = this.calendarConfig();
    const visibleDates = visibleCalendarDates(
      this.calViewType,
      this.calDate,
      config.firstDayOfWeek,
    );
    const firstVisibleDate = visibleDates[0];
    const lastVisibleDate = visibleDates[visibleDates.length - 1];
    if (firstVisibleDate === undefined || lastVisibleDate === undefined) {
      return { config, issues: [], tasks: [] };
    }
    const projection = this.queries.forCalendarProjection(
      visibleDates as unknown as readonly LocalDate[],
    );
    const occurrences = projectCalendarOccurrences(
      projection,
      { from: localDate(firstVisibleDate), to: localDate(lastVisibleDate) },
      { removeScheduledDate: this.settings.recurrence.removeScheduledDate },
    );
    return {
      config,
      issues: occurrences.issues,
      tasks: occurrences.occurrences.map(taskSnapshotForCalendarOccurrence),
    };
  }

  private calendarConfig(): ResolvedConfig {
    const firstDayOfWeek = this.settings.desktop.firstDayOfWeek;
    return {
      ...DEFAULT_VIEW_CONFIG,
      ...this.settings.desktop,
      isMobile: false,
      sourceNoteDisplay: this.settings.sourceNoteDisplay,
      customFilePath: this.settings.customFilePath,
      startPosition: this.calendarStartPosition(firstDayOfWeek),
    };
  }

  private calendarStartPosition(firstDayOfWeek: number): string {
    if (this.calViewType === 'week') return firstVisibleWeekDate(this.calDate, firstDayOfWeek);
    if (this.calViewType === 'today') return this.calDate.format('YYYY-MM-DD');
    return this.calDate.format('YYYY-MM');
  }

  private createCalendarView(
    forecastMenuOwner: ForecastContextMenuOwner,
    handlers: CalendarHandlers,
  ): TodayView | WeekTimeGridView | MonthGridView {
    if (this.calViewType === 'today')
      return this.createTodayCalendarView(forecastMenuOwner, handlers);
    if (this.calViewType === 'week')
      return this.createWeekCalendarView(forecastMenuOwner, handlers);
    return this.createMonthCalendarView(forecastMenuOwner, handlers);
  }

  private createTodayCalendarView(
    forecastMenuOwner: ForecastContextMenuOwner,
    handlers: CalendarHandlers,
  ): TodayView {
    return new TodayView({
      app: this.app,
      forecastMenuOwner,
      onTaskClick: handlers.onTaskClick,
      onForecastClick: handlers.onForecastClick,
      onForecastContextMenu: handlers.onForecastContextMenu,
      onDrop: handlers.onDrop,
      onDropTime: handlers.onDropTime,
      onCreateAtTime: handlers.onCreateAtTime,
      onCreateAtDate: handlers.onCreateAtDateAllDay,
      onTimeChange: handlers.onTimeChange,
      onDurationChange: handlers.onDurationChange,
      onTimedMove: handlers.onTimedMove,
      onTimedDuration: handlers.onTimedDuration,
      onTimedBoundary: handlers.onTimedBoundary,
      onSpanMove: handlers.onSpanMove,
      onSpanBoundary: handlers.onSpanBoundary,
      onStartChange: handlers.onStartChange,
      onDueChange: handlers.onDueChange,
      onExtendToSpan: handlers.onExtendToSpan,
      onKeyboardIntent: handlers.onKeyboardIntent,
      onToggle: handlers.onToggle,
      onSetStatus: handlers.onSetStatus,
      onSetPriority: handlers.onSetPriority,
      interactionOwnership: this.interactionOwnership,
      statusRegistry: this.statusRegistry,
      tagGroups: this.settings.tagGroups,
    });
  }

  private createWeekCalendarView(
    forecastMenuOwner: ForecastContextMenuOwner,
    handlers: CalendarHandlers,
  ): WeekTimeGridView {
    return new WeekTimeGridView({
      app: this.app,
      forecastMenuOwner,
      onTaskClick: handlers.onTaskClick,
      onForecastClick: handlers.onForecastClick,
      onForecastContextMenu: handlers.onForecastContextMenu,
      onDrop: handlers.onDrop,
      onDropTime: handlers.onDropTime,
      onCreateAtTime: handlers.onCreateAtTime,
      onCreateAtDate: handlers.onCreateAtDateAllDay,
      onDayHeaderClick: (date) => {
        this.openCalendarDay(date);
      },
      onTimeChange: handlers.onTimeChange,
      onDurationChange: handlers.onDurationChange,
      onTimedMove: handlers.onTimedMove,
      onTimedDuration: handlers.onTimedDuration,
      onTimedBoundary: handlers.onTimedBoundary,
      onSpanMove: handlers.onSpanMove,
      onSpanBoundary: handlers.onSpanBoundary,
      onStartChange: handlers.onStartChange,
      onDueChange: handlers.onDueChange,
      onExtendToSpan: handlers.onExtendToSpan,
      onKeyboardIntent: handlers.onKeyboardIntent,
      onToggle: handlers.onToggle,
      onSetStatus: handlers.onSetStatus,
      onSetPriority: handlers.onSetPriority,
      interactionOwnership: this.interactionOwnership,
      statusRegistry: this.statusRegistry,
      tagGroups: this.settings.tagGroups,
    });
  }

  private createMonthCalendarView(
    forecastMenuOwner: ForecastContextMenuOwner,
    handlers: CalendarHandlers,
  ): MonthGridView {
    return new MonthGridView({
      app: this.app,
      forecastMenuOwner,
      onDayClick: (date) => {
        this.openCalendarDay(date);
      },
      onCreateAtDate: handlers.onCreateAtDate,
      onTaskClick: handlers.onTaskClick,
      onForecastClick: handlers.onForecastClick,
      onForecastContextMenu: handlers.onForecastContextMenu,
      onDrop: handlers.onDrop,
      onSpanMove: handlers.onSpanMove,
      onSpanBoundary: handlers.onSpanBoundary,
      onToggle: handlers.onToggle,
      onSetStatus: handlers.onSetStatus,
      onSetPriority: handlers.onSetPriority,
      onWeekClick: (week, year) => {
        this.openCalendarWeek(week, year);
      },
      interactionOwnership: this.interactionOwnership,
      statusRegistry: this.statusRegistry,
      tagGroups: this.settings.tagGroups,
    });
  }

  private openCalendarDay(date: string): void {
    this.cancelKeyboardInteraction();
    this.calViewType = 'today';
    this.calDate = window.moment(date);
    this.render();
  }

  private openCalendarWeek(week: string, year: string): void {
    this.cancelKeyboardInteraction();
    this.calViewType = 'week';
    this.calDate = window
      .moment()
      .isoWeekYear(Number.parseInt(year, 10))
      .isoWeek(Number.parseInt(week, 10))
      .startOf('isoWeek');
    this.render();
  }

  private renderCalendarViewSwitcher(host: HTMLElement): void {
    const switcher = host.createDiv({ cls: 'abyss-cal-view-switcher' });
    for (const view of ['today', 'week', 'month'] as const) {
      const button = switcher.createEl('button', {
        cls: `abyss-cal-view-btn${this.calViewType === view ? ' is-active' : ''}`,
        text: view === 'today' ? 'Day' : this.capitalize(view),
      });
      button.addEventListener('click', () => {
        this.navigation.openCalendarView(view);
      });
    }
  }

  private updateCalendarTitle(navigation: CalendarNavigationElements): void {
    if (this.calViewType === 'week') {
      navigation.monthButton.textContent = `Week ${this.calDate.format('w')}`;
    } else if (this.calViewType === 'today') {
      navigation.monthButton.textContent = this.calDate.format('MMMM D');
    } else {
      navigation.monthButton.textContent = this.calDate.format('MMMM');
    }
    navigation.yearButton.textContent = this.calDate.format('YYYY');
  }

  private mountCalendarView(context: CalendarRenderContext): void {
    this.prepareCalendarViewUpdate(context.forecastMenuOwner);
    this.unmountActiveCapture();
    const renderGeneration = ++this.calendarRenderGeneration;
    const grid = context.viewContainer.querySelector<HTMLElement>('.abyss-tg-grid-row');
    const preservedScrollTop = grid?.scrollTop ?? this.pendingCalScrollTop;
    this.pendingCalScrollTop = undefined;
    this.calViewInstance?.destroy();
    context.viewContainer.empty();
    const { config, issues, tasks } = this.currentCalendarContent();
    const shouldScrollToNow = this.shouldScrollCalendarToNow();
    this.calViewInstance = this.createCalendarView(context.forecastMenuOwner, context.handlers);
    this.calViewInstance.render(
      context.viewContainer,
      tasks,
      config,
      shouldScrollToNow,
      preservedScrollTop,
    );
    this.finishCalendarViewUpdate(context, issues, renderGeneration);
  }

  private patchCalendarView(context: CalendarRenderContext, mountView: () => void): void {
    if (this.calViewInstance == null) {
      mountView();
      return;
    }
    this.prepareCalendarViewUpdate(context.forecastMenuOwner);
    const renderGeneration = ++this.calendarRenderGeneration;
    const { config, issues, tasks } = this.currentCalendarContent();
    this.unmountActiveCapture();
    this.calViewInstance.patch(context.viewContainer, tasks, config);
    this.finishCalendarViewUpdate(context, issues, renderGeneration);
  }

  private prepareCalendarViewUpdate(forecastMenuOwner: ForecastContextMenuOwner): void {
    this.dismissRecurrenceEditor();
    forecastMenuOwner.dismiss();
    this.captureActiveTimedBlockFocus();
    const queueSequence = this.pendingTimedBlockFocus?.queueSequence;
    if (queueSequence !== undefined) this.restoredKeyboardSequences.delete(queueSequence);
  }

  private finishCalendarViewUpdate(
    context: CalendarRenderContext,
    issues: readonly CalendarProjectionIssue[],
    renderGeneration: number,
  ): void {
    context.projectionDiagnosticOwner.update(context.viewContainer, issues);
    this.remountActiveCapture();
    this.onRenderComplete(context.viewContainer);
    this.deferTimedBlockFocus(context.viewContainer, renderGeneration);
  }

  private shouldScrollCalendarToNow(): boolean {
    const key = `${this.calViewType}:${this.calDate.format('YYYY-MM-DD')}`;
    const shouldScroll = key !== this.lastScrolledCalKey;
    this.lastScrolledCalKey = key;
    return shouldScroll;
  }

  private bindCalendarNavigation(
    navigation: CalendarNavigationElements,
    updateTitle: () => void,
    mountView: () => void,
  ): void {
    navigation.monthButton.addEventListener('click', () => {
      this.toggleMonthPicker(navigation.monthButton, updateTitle, mountView);
    });
    navigation.yearButton.addEventListener('click', () => {
      this.toggleYearPicker(navigation.yearButton, updateTitle, mountView);
    });
    navigation.prevButton.addEventListener('click', () => {
      this.navigateCalendar(-1, updateTitle, mountView);
    });
    navigation.nextButton.addEventListener('click', () => {
      this.navigateCalendar(1, updateTitle, mountView);
    });
    navigation.todayButton.addEventListener('click', () => {
      this.navigateCalendarToday(updateTitle, mountView);
    });
  }

  private toggleMonthPicker(
    anchor: HTMLElement,
    updateTitle: () => void,
    mountView: () => void,
  ): void {
    if (this.el.querySelector('.abyss-month-picker') != null) {
      this.clearCalendarPicker();
      return;
    }
    this.clearCalendarPicker();
    const picker = this.el.createDiv({
      cls: 'abyss-month-picker abyss-popover',
      attr: { role: 'dialog', 'aria-modal': 'false', 'aria-label': 'Select month' },
    });
    const names = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    names.forEach((name, month) => {
      const selected = month === this.calDate.month();
      const button = picker.createEl('button', {
        cls: 'abyss-month-picker-btn',
        text: name,
        attr: { 'aria-pressed': String(selected) },
      });
      if (selected) button.addClass('is-active');
      button.addEventListener('click', () => {
        this.selectCalendarMonth(month, updateTitle, mountView);
      });
    });
    anchor.after(picker);
    this.armCalendarPicker(picker, anchor);
  }

  private selectCalendarMonth(month: number, updateTitle: () => void, mountView: () => void): void {
    this.cancelKeyboardInteraction();
    this.clearCalendarPicker(true);
    this.calDate = this.calDate.clone().month(month).date(1);
    updateTitle();
    mountView();
  }

  private toggleYearPicker(
    anchor: HTMLElement,
    updateTitle: () => void,
    mountView: () => void,
  ): void {
    if (this.el.querySelector('.abyss-year-picker') != null) {
      this.clearCalendarPicker();
      return;
    }
    this.clearCalendarPicker();
    const picker = this.el.createDiv({
      cls: 'abyss-year-picker abyss-popover',
      attr: { role: 'dialog', 'aria-modal': 'false', 'aria-label': 'Select year' },
    });
    const currentYear = this.calDate.year();
    for (let year = currentYear - 5; year <= currentYear + 5; year++) {
      this.renderYearPickerOption(picker, year, currentYear, [updateTitle, mountView]);
    }
    anchor.after(picker);
    this.armCalendarPicker(picker, anchor);
  }

  private renderYearPickerOption(
    picker: HTMLElement,
    year: number,
    currentYear: number,
    callbacks: readonly [updateTitle: () => void, mountView: () => void],
  ): void {
    const selected = year === currentYear;
    const button = picker.createEl('button', {
      cls: 'abyss-year-picker-btn',
      text: String(year),
      attr: { 'aria-pressed': String(selected) },
    });
    if (selected) button.addClass('is-active');
    button.addEventListener('click', () => {
      this.cancelKeyboardInteraction();
      this.clearCalendarPicker(true);
      this.calDate = this.calDate.clone().year(year).date(1);
      callbacks[0]();
      callbacks[1]();
    });
  }

  private navigateCalendar(
    direction: -1 | 1,
    updateTitle: () => void,
    mountView: () => void,
  ): void {
    this.cancelKeyboardInteraction();
    const operation = direction === 1 ? 'add' : 'subtract';
    if (this.calViewType === 'week') {
      this.calDate = this.calDate.clone()[operation](7, 'days').startOf('isoWeek');
    } else if (this.calViewType === 'today') {
      this.calDate = this.calDate.clone()[operation](1, 'day');
    } else {
      this.calDate = this.calDate.clone()[operation](1, 'months').date(1);
    }
    updateTitle();
    mountView();
  }

  private navigateCalendarToday(updateTitle: () => void, mountView: () => void): void {
    this.cancelKeyboardInteraction();
    if (this.calViewType === 'week') this.calDate = window.moment().startOf('isoWeek');
    else if (this.calViewType === 'today') this.calDate = window.moment();
    else this.calDate = window.moment().date(1);
    updateTitle();
    mountView();
  }

  private createCalendarHandlers(viewContainer: HTMLElement): CalendarHandlers {
    return {
      onTaskClick: (task) => {
        if (calendarRootTaskRef(task) !== undefined) this.taskModal?.open(task);
      },
      onForecastClick: (source, referenceDate) => {
        this.openForecastTask(source, referenceDate);
      },
      onForecastContextMenu: (source) => {
        this.openForecastRecurrenceEditor(viewContainer, source);
      },
      onDrop: (dragData, targetDate) => {
        runAsyncAction(this.rescheduleTask(dragData, targetDate), 'Could not complete UI action');
      },
      onDropTime: (dragData, date, time) => {
        runAsyncAction(
          this.setTaskTimeFromDrop(dragData, date, time),
          'Could not complete UI action',
        );
      },
      onCreateAtTime: (date, time) => {
        this.createCalendarTaskAtTime(viewContainer, date, time);
      },
      onCreateAtDate: (date) => {
        this.createCalendarTaskAtDate(viewContainer, date, false);
      },
      onCreateAtDateAllDay: (date) => {
        this.createCalendarTaskAtDate(viewContainer, date, true);
      },
      onTimeChange: (task, minutes) => {
        this.runCalendarTaskAction(task, () => this.updateTaskTime(task, minutes));
      },
      onDurationChange: (task, minutes) => {
        this.runCalendarTaskAction(task, () => this.updateTaskDuration(task, minutes));
      },
      onTimedMove: (task, target) => {
        this.runCalendarTaskAction(task, () => this.commitTimedMove(task, target));
      },
      onTimedDuration: (task, target) => {
        this.runCalendarTaskAction(task, () => this.commitTimedDuration(task, target));
      },
      onTimedBoundary: (task, target) => {
        this.runCalendarTaskAction(task, () => this.commitTimedBoundary(task, target));
      },
      onSpanMove: (task, target) => {
        this.runCalendarTaskAction(task, () => this.commitSpanMove(task, target));
      },
      onSpanBoundary: (task, target) => {
        this.runCalendarTaskAction(task, () => this.commitTimedBoundary(task, target));
      },
      onStartChange: (task, start) => {
        this.runCalendarTaskAction(task, () => this.updateTaskStart(task, start));
      },
      onDueChange: (task, due) => {
        this.runCalendarTaskAction(task, () => this.rescheduleTaskDue(task, due));
      },
      onExtendToSpan: (task, due) => {
        this.runCalendarTaskAction(task, () => this.extendTaskToSpan(task, due));
      },
      onKeyboardIntent: (task, intent) => {
        this.handleCalendarKeyboardIntent(task, intent);
      },
      onToggle: (task) => {
        runAsyncAction(this.toggleTask(task), 'Could not complete UI action');
      },
      onSetStatus: (task, status) => {
        runAsyncAction(this.setTaskStatus(task, status), 'Could not complete UI action');
      },
      onSetPriority: (task, priority) => {
        runAsyncAction(this.setPriority(task, priority), 'Could not complete UI action');
      },
    };
  }

  private openForecastTask(source: CalendarTaskSource, referenceDate: LocalDate): void {
    this.taskModal?.open(source.root);
    const modal = activeDocument.querySelector<HTMLElement>('.abyss-modal');
    if (modal == null) return;
    const context = modal.createDiv({
      cls: 'abyss-forecast-source-context',
      text: `Forecast for ${referenceDate}`,
    });
    modal.prepend(context);
  }

  private runCalendarTaskAction(task: TaskSnapshot, action: () => Promise<void>): void {
    if (isForecastCalendarTask(task)) return;
    runAsyncAction(action(), 'Could not complete UI action');
  }

  private createCalendarTaskAtTime(container: HTMLElement, date: string, time: string): void {
    const day = container.querySelector<HTMLElement>(
      `.abyss-tg-day-column[data-tg-date="${date}"]`,
    );
    const hourColumn = day?.querySelector<HTMLElement>('.abyss-tg-hour-column');
    if (hourColumn != null) this.showTimeGridQuickAdd(hourColumn, date, time);
  }

  private createCalendarTaskAtDate(container: HTMLElement, date: string, allDay: boolean): void {
    const selector = allDay
      ? `.abyss-tg-allday-cell[data-tg-date="${date}"]`
      : `[data-mg-date="${date}"]`;
    const cell = container.querySelector<HTMLElement>(selector);
    if (cell == null) return;
    this.showFillCellQuickAdd(
      cell,
      date,
      allDay ? 'abyss-tg-allday-quick-add' : 'abyss-mg-quick-add',
    );
  }

  private handleCalendarKeyboardIntent(task: TaskSnapshot, intent: TimedBlockKeyboardIntent): void {
    if (calendarRootTaskRef(task) === undefined || this.keyboardQueue == null) return;
    const active = this.el.ownerDocument.activeElement;
    const originElement = isRealmHTMLElement(active)
      ? (active.closest<HTMLElement>('.abyss-tg-block') ?? undefined)
      : undefined;
    const previousQueueSequence = this.pendingTimedBlockFocus?.queueSequence;
    const provisionalFocus = this.provisionalTimedBlockFocus(task, originElement);
    this.pendingTimedBlockFocus = provisionalFocus;
    const queueSequence = this.keyboardQueue.enqueue(task, intent);
    if (queueSequence === undefined) {
      this.handleRejectedKeyboardIntent(provisionalFocus.sequence, previousQueueSequence);
      return;
    }
    this.acceptKeyboardIntent(provisionalFocus, queueSequence, previousQueueSequence);
  }

  private provisionalTimedBlockFocus(
    task: TaskSnapshot,
    originElement: HTMLElement | undefined,
  ): TimedBlockFocusLocator {
    const segmentDate = originElement?.dataset['tgSegmentDate'];
    return {
      filePath: task.source.filePath,
      line: task.source.line,
      ...(segmentDate !== undefined && { segmentDate }),
      sequence: ++this.nextTimedBlockFocusSequence,
      ...(originElement !== undefined && { originElement }),
    };
  }

  private handleRejectedKeyboardIntent(
    focusSequence: number,
    previousQueueSequence: number | undefined,
  ): void {
    if (this.pendingTimedBlockFocus?.sequence === focusSequence) this.clearTimedBlockFocus();
    if (previousQueueSequence !== undefined) this.clearKeyboardSequenceState(previousQueueSequence);
  }

  private acceptKeyboardIntent(
    provisionalFocus: TimedBlockFocusLocator,
    queueSequence: number,
    previousQueueSequence: number | undefined,
  ): void {
    if (this.pendingTimedBlockFocus?.sequence !== provisionalFocus.sequence) return;
    if (previousQueueSequence !== undefined && previousQueueSequence !== queueSequence) {
      this.clearKeyboardSequenceState(previousQueueSequence);
    }
    this.settledKeyboardSequences.delete(queueSequence);
    if (previousQueueSequence !== queueSequence) {
      this.restoredKeyboardSequences.delete(queueSequence);
      this.committedKeyboardSequences.delete(queueSequence);
    }
    this.pendingTimedBlockFocus = { ...provisionalFocus, queueSequence };
  }

  private cancelKeyboardInteraction(): void {
    this.keyboardQueue?.cancel();
    this.pendingTimedBlockFocus = undefined;
    this.settledKeyboardSequences.clear();
    this.restoredKeyboardSequences.clear();
    this.committedKeyboardSequences.clear();
    this.pendingTimedBlockRestorations.clear();
    this.calendarRenderGeneration += 1;
  }

  private captureActiveTimedBlockFocus(): void {
    if (this.pendingTimedBlockFocus?.queueSequence !== undefined) return;
    const active = this.el.ownerDocument.activeElement;
    if (!isRealmHTMLElement(active) || !this.el.contains(active)) return;
    const block = active.closest<HTMLElement>('.abyss-tg-block');
    if (block == null) return;
    this.retainTimedBlockFocus(block);
  }

  private retainTimedBlockFocus(block: HTMLElement): void {
    const filePath = block.dataset['abyssTaskFile'];
    const lineText = block.dataset['abyssTaskLine'];
    if (filePath === undefined || lineText === undefined) return;
    const line = Number(lineText);
    if (!Number.isInteger(line)) return;
    const segmentDate = block.dataset['tgSegmentDate'];

    const pending = this.pendingTimedBlockFocus;
    if (this.isDifferentPreCommitOrigin(block, pending)) {
      this.replacePreCommitFocus(block, pending.queueSequence, {
        filePath,
        line,
        ...(segmentDate !== undefined && { segmentDate }),
      });
      return;
    }
    if (this.sameTimedBlockFocus(pending, filePath, line, segmentDate)) return;
    if (pending?.queueSequence !== undefined) {
      this.keyboardQueue?.cancel();
      this.clearKeyboardSequenceState(pending.queueSequence);
    }
    this.pendingTimedBlockFocus = this.createTimedBlockFocus(block, filePath, line, segmentDate);
  }

  private isDifferentPreCommitOrigin(
    block: HTMLElement,
    pending: TimedBlockFocusLocator | undefined,
  ): pending is TimedBlockFocusLocator & { readonly queueSequence: number } {
    return (
      pending?.queueSequence !== undefined &&
      !this.committedKeyboardSequences.has(pending.queueSequence) &&
      pending.originElement !== undefined &&
      block !== pending.originElement
    );
  }

  private replacePreCommitFocus(
    block: HTMLElement,
    queueSequence: number,
    locator: Pick<TimedBlockFocusLocator, 'filePath' | 'line' | 'segmentDate'>,
  ): void {
    this.keyboardQueue?.cancel();
    this.clearTimedBlockFocus(queueSequence);
    this.pendingTimedBlockFocus = this.createTimedBlockFocus(
      block,
      locator.filePath,
      locator.line,
      locator.segmentDate,
    );
  }

  private sameTimedBlockFocus(
    pending: TimedBlockFocusLocator | undefined,
    filePath: string,
    line: number,
    segmentDate: string | undefined,
  ): boolean {
    return (
      pending?.filePath === filePath && pending.line === line && pending.segmentDate === segmentDate
    );
  }

  private createTimedBlockFocus(
    block: HTMLElement,
    filePath: string,
    line: number,
    segmentDate: string | undefined,
  ): TimedBlockFocusLocator {
    return {
      filePath,
      line,
      ...(segmentDate !== undefined && { segmentDate }),
      sequence: ++this.nextTimedBlockFocusSequence,
      originElement: block,
    };
  }

  private deferTimedBlockFocus(container: HTMLElement, renderGeneration: number): void {
    const scheduled = this.pendingTimedBlockFocus;
    if (scheduled == null) return;
    const focusSequence = scheduled.sequence;
    const queueSequence = scheduled.queueSequence;
    if (queueSequence !== undefined && !this.committedKeyboardSequences.has(queueSequence)) return;

    const scheduledCandidate = this.findTimedBlock(container, scheduled);
    if (queueSequence !== undefined && scheduledCandidate === scheduled.originElement) return;
    const restorationId = this.reserveTimedBlockRestoration(
      scheduledCandidate,
      scheduled,
      renderGeneration,
    );

    window.setTimeout(() => {
      this.restoreDeferredTimedBlockFocus(container, {
        focusSequence,
        renderGeneration,
        ...(restorationId !== undefined && { restorationId }),
      });
    }, 0);
  }

  private reserveTimedBlockRestoration(
    candidate: HTMLElement | undefined,
    scheduled: TimedBlockFocusLocator,
    renderGeneration: number,
  ): number | undefined {
    const queueSequence = scheduled.queueSequence;
    if (
      queueSequence === undefined ||
      candidate?.isConnected !== true ||
      candidate === scheduled.originElement
    ) {
      return undefined;
    }
    const restorationId = ++this.nextTimedBlockRestoration;
    this.pendingTimedBlockRestorations.set(restorationId, {
      queueSequence,
      focusSequence: scheduled.sequence,
      renderGeneration,
    });
    return restorationId;
  }

  private findTimedBlock(
    container: HTMLElement,
    locator: Pick<TimedBlockFocusLocator, 'filePath' | 'line' | 'segmentDate'>,
  ): HTMLElement | undefined {
    return Array.from(container.querySelectorAll<HTMLElement>('.abyss-tg-block')).find(
      (block) =>
        block.dataset['abyssTaskFile'] === locator.filePath &&
        block.dataset['abyssTaskLine'] === String(locator.line) &&
        (locator.segmentDate === undefined ||
          block.dataset['tgSegmentDate'] === locator.segmentDate),
    );
  }

  private restoreDeferredTimedBlockFocus(
    container: HTMLElement,
    options: {
      readonly focusSequence: number;
      readonly renderGeneration: number;
      readonly restorationId?: number;
    },
  ): void {
    if (!this.canRunTimedBlockRestoration(options)) return;
    const pending = this.pendingTimedBlockFocus;
    if (!this.isPendingTimedBlockRestorable(pending, options.focusSequence)) return;
    const candidate = this.findTimedBlock(container, pending);
    if (!this.isRestorableTimedBlock(candidate)) return;
    candidate.focus();
    candidate.classList.add('is-selected');
    if (!this.didRestoreTimedBlock(candidate, pending.sequence)) return;
    this.finishTimedBlockRestoration(pending.queueSequence);
  }

  private canRunTimedBlockRestoration(options: {
    readonly renderGeneration: number;
    readonly restorationId?: number;
  }): boolean {
    if (
      options.restorationId !== undefined &&
      !this.pendingTimedBlockRestorations.delete(options.restorationId)
    ) {
      return false;
    }
    return options.renderGeneration === this.calendarRenderGeneration;
  }

  private isPendingTimedBlockRestorable(
    pending: TimedBlockFocusLocator | undefined,
    focusSequence: number,
  ): pending is TimedBlockFocusLocator {
    if (pending?.sequence !== focusSequence || this.state.get('mode') !== 'calendar') return false;
    return (
      pending.queueSequence === undefined ||
      this.committedKeyboardSequences.has(pending.queueSequence)
    );
  }

  private isRestorableTimedBlock(candidate: HTMLElement | undefined): candidate is HTMLElement {
    return (
      candidate !== undefined &&
      candidate.isConnected &&
      isRealmHTMLElement(candidate) &&
      candidate.ownerDocument === this.el.ownerDocument
    );
  }

  private didRestoreTimedBlock(candidate: HTMLElement, sequence: number): boolean {
    return (
      candidate.ownerDocument.activeElement === candidate &&
      this.pendingTimedBlockFocus?.sequence === sequence
    );
  }

  private finishTimedBlockRestoration(queueSequence: number | undefined): void {
    if (queueSequence === undefined) {
      this.clearTimedBlockFocus();
      return;
    }
    this.restoredKeyboardSequences.add(queueSequence);
    if (this.settledKeyboardSequences.has(queueSequence)) this.clearTimedBlockFocus(queueSequence);
  }

  private clearTimedBlockFocus(queueSequence?: number): void {
    const pending = this.pendingTimedBlockFocus;
    if (queueSequence !== undefined && pending?.queueSequence !== queueSequence) return;
    const ownedSequence = pending?.queueSequence ?? queueSequence;
    if (ownedSequence !== undefined) {
      this.clearKeyboardSequenceState(ownedSequence);
    }
    this.pendingTimedBlockFocus = undefined;
  }

  private hasPendingTimedBlockRestoration(queueSequence: number): boolean {
    const pending = this.pendingTimedBlockFocus;
    if (pending?.queueSequence !== queueSequence) return false;
    return Array.from(this.pendingTimedBlockRestorations.values()).some(
      (restoration) =>
        restoration.queueSequence === queueSequence &&
        restoration.focusSequence === pending.sequence &&
        restoration.renderGeneration === this.calendarRenderGeneration,
    );
  }

  private clearKeyboardSequenceState(queueSequence: number): void {
    this.settledKeyboardSequences.delete(queueSequence);
    this.restoredKeyboardSequences.delete(queueSequence);
    this.committedKeyboardSequences.delete(queueSequence);
    for (const [id, restoration] of this.pendingTimedBlockRestorations) {
      if (restoration.queueSequence === queueSequence) {
        this.pendingTimedBlockRestorations.delete(id);
      }
    }
  }

  private handleKeyboardCommit(
    updated: TaskSnapshot,
    intent: TimedBlockKeyboardIntent,
    queueSequence: number,
    changed: boolean,
  ): void {
    const pending = this.pendingTimedBlockFocus;
    if (!this.acceptsKeyboardCommit(pending, queueSequence)) return;
    this.committedKeyboardSequences.add(queueSequence);
    const sourceChanged =
      pending.filePath !== updated.source.filePath || pending.line !== updated.source.line;
    const nextSegmentDate = this.shiftFocusedSegmentDate(pending, intent, changed);
    const segmentChanged = nextSegmentDate !== pending.segmentDate;
    const identityChanged = [sourceChanged, segmentChanged].includes(true);
    const presentationChanged = [changed, identityChanged].includes(true);
    if (presentationChanged) this.restoredKeyboardSequences.delete(queueSequence);
    if (identityChanged) {
      this.pendingTimedBlockFocus = {
        ...pending,
        filePath: updated.source.filePath,
        line: updated.source.line,
        ...(nextSegmentDate !== undefined && { segmentDate: nextSegmentDate }),
        sequence: ++this.nextTimedBlockFocusSequence,
      };
    }
    if (presentationChanged || !this.restoredKeyboardSequences.has(queueSequence)) {
      this.deferTimedBlockFocus(this.el, this.calendarRenderGeneration);
    }
    if (intent.type === 'shift-schedule') this.followShiftedTask(updated, nextSegmentDate);
  }

  private acceptsKeyboardCommit(
    pending: TimedBlockFocusLocator | undefined,
    queueSequence: number,
  ): pending is TimedBlockFocusLocator {
    return pending?.queueSequence === queueSequence && this.state.get('mode') === 'calendar';
  }

  private shiftFocusedSegmentDate(
    pending: TimedBlockFocusLocator,
    intent: TimedBlockKeyboardIntent,
    changed: boolean,
  ): string | undefined {
    if (!changed || intent.type !== 'shift-schedule' || pending.segmentDate === undefined) {
      return pending.segmentDate;
    }
    try {
      return shiftLocalDate(localDate(pending.segmentDate), intent.days);
    } catch {
      return pending.segmentDate;
    }
  }

  private followShiftedTask(updated: TaskSnapshot, nextSegmentDate: string | undefined): void {
    const anchor =
      updated.planning.start != null && updated.planning.due != null
        ? updated.planning.due
        : (updated.planning.scheduled ?? updated.planning.due);
    const followDate = nextSegmentDate ?? anchor;
    if (followDate === undefined || followDate === '') return;
    const firstDayOfWeek = this.settings.desktop.firstDayOfWeek;
    const outsideWeek = !visibleCalendarDates('week', this.calDate, firstDayOfWeek).includes(
      followDate,
    );
    if (this.calViewType !== 'today' && (this.calViewType !== 'week' || !outsideWeek)) return;
    this.calDate = window.moment(followDate);
    this.render();
  }

  private renderSearch(): void {
    const header = this.el.createDiv({ cls: 'abyss-center-header' });
    header.createEl('h2', { cls: 'abyss-center-title', text: 'Search' });
    const input = header.createEl('input', {
      cls: 'abyss-center-search abyss-search-global',
      attr: { type: 'text', placeholder: 'Search all tasks…', 'aria-label': 'Search all tasks' },
    });
    input.value = this.state.get('searchQuery');
    input.addEventListener('input', () => {
      this.state.set('searchQuery', input.value);
    });
    input.addEventListener('keydown', (event) => {
      if (isImeOwnedEvent(event) || event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (this.el.isConnected) this.el.focus({ preventScroll: true });
    });
    this.searchInputEl = input;

    const results = this.el.createDiv({ cls: 'abyss-center-scroll' });
    this.searchResultsEl = results;
    this.renderSearchResults(results, input.value);

    window.setTimeout(() => {
      if (this.searchInputEl === input && input.isConnected) input.focus();
    }, 0);
  }

  private handleSearchQueryChanged(query: string): void {
    const input = this.searchInputEl;
    const results = this.searchResultsEl;
    if (
      this.state.get('mode') !== 'search' ||
      input === null ||
      !input.isConnected ||
      results?.isConnected !== true
    ) {
      return;
    }
    if (input.value !== query) input.value = query;
    this.scheduleSearchResults(query);
  }

  private scheduleSearchResults(query: string): void {
    if (this.searchResultsFrame !== null) {
      window.cancelAnimationFrame(this.searchResultsFrame);
    }
    this.searchResultsFrame = window.requestAnimationFrame(() => {
      this.searchResultsFrame = null;
      const input = this.searchInputEl;
      const results = this.searchResultsEl;
      if (
        this.state.get('mode') !== 'search' ||
        input === null ||
        !input.isConnected ||
        results?.isConnected !== true
      ) {
        return;
      }
      this.renderSearchResults(results, query);
    });
  }

  private clearSearchShell(): void {
    if (this.searchResultsFrame !== null) {
      window.cancelAnimationFrame(this.searchResultsFrame);
      this.searchResultsFrame = null;
    }
    this.searchInputEl = null;
    this.searchResultsEl = null;
  }

  private renderSearchResults(host: HTMLElement, query: string): void {
    this.md.unload();
    this.md = new Component();
    this.md.load();
    host.empty();
    host.toggleClass('abyss-search-empty', query.length === 0);

    if (query.length === 0) {
      host.createEl('p', { cls: 'abyss-empty-state', text: 'Type to search tasks…' });
      this.completeTaskCardRender();
      return;
    }

    const matchingTasks = [...searchTaskList(this.queries.list(), query)];
    if (matchingTasks.length === 0) {
      host.createDiv({ cls: 'abyss-center-empty', text: 'No results' });
      this.completeTaskCardRender();
      return;
    }
    this.renderFlat(host, matchingTasks);

    // Navigate to task in tasks mode when clicking a search result
    host.querySelectorAll<HTMLElement>('.abyss-task-card').forEach((cardEl, idx) => {
      const task = matchingTasks[idx];
      if (task == null) return;
      cardEl.addEventListener(
        'click',
        (e) => {
          e.stopPropagation();
          const todayStr = localDate(window.moment().format('YYYY-MM-DD'));
          const d = task.planning.due ?? task.planning.scheduled;
          let list: 'inbox' | 'today' | 'upcoming' = 'inbox';
          if ((task.planning.due != null && task.planning.due < todayStr) || d === todayStr) {
            list = 'today';
          } else if (d != null && d > todayStr) {
            list = 'upcoming';
          }
          this.navigation.openList(list);
          this.state.set('taskStack', [task]);
        },
        { capture: true },
      );
    });
    this.completeTaskCardRender();
  }

  private renderWithGrouping(container: HTMLElement, tasks: TaskSnapshot[]): void {
    const vs = this.state.get('centerListViewState');
    const today = localDate(window.moment().format('YYYY-MM-DD'));
    const tomorrow = window.moment().add(1, 'day').format('YYYY-MM-DD');

    if (vs.groupBy === 'none') {
      this.renderFlat(container, tasks);
      return;
    }

    const groups = this.groupTasks(tasks, vs.groupBy, today, tomorrow);

    let firstGroup = true;
    for (const group of groups) {
      if (group.tasks.length === 0) continue;
      const cls = firstGroup
        ? 'abyss-group-header abyss-group-header--first'
        : 'abyss-group-header';
      container.createDiv({ cls, text: `${group.label}  ${group.tasks.length}` });
      firstGroup = false;
      for (const task of group.tasks) this.renderTaskCard(container, task);
    }
  }

  private groupTasks(
    tasks: TaskSnapshot[],
    groupBy: ListViewState['groupBy'],
    today: LocalDate,
    tomorrow: string,
  ): Array<{ label: string; tasks: TaskSnapshot[] }> {
    if (groupBy === 'date') return groupTasksByDate(tasks, today, tomorrow);
    if (groupBy === 'priority') return groupTasksByPriority(tasks);
    if (groupBy === 'status') return groupTasksByStatus(tasks, this.statusRegistry);
    return groupTasksByTag(tasks);
  }

  private renderFlat(container: HTMLElement, tasks: TaskSnapshot[]): void {
    for (const task of tasks) this.renderTaskCard(container, task);
  }

  private renderTaskCard(container: HTMLElement, task: TaskSnapshot): void {
    const isSelected = this.isTaskCardSelected(task);
    const card = container.createDiv({
      cls: `abyss-task-card${isSelected ? ' is-selected' : ''}`,
      attr: { tabindex: '-1' },
    });
    applyTaskPresentationIdentity(card, task.ref);
    card.dataset['filePath'] = task.source.filePath;
    card.dataset['line'] = String(task.source.line);

    const mainRow = card.createDiv({ cls: 'abyss-task-card-main-row' });
    this.renderTaskStatus(mainRow, task);
    this.renderTaskCardBody(mainRow, card, task);
    this.renderTaskCardMetadata(mainRow, task);
    this.mountTaskCardInteractions(card, task);
    this.syncTaskDeleteButton(
      card,
      isSelected && this.selectedTaskKeys.size === 0 ? task : undefined,
    );
  }

  private isTaskCardSelected(task: TaskSnapshot): boolean {
    const stack = this.state.get('taskStack');
    const root = stack[0];
    const current = stack[stack.length - 1];
    return (
      root !== undefined &&
      'source' in root &&
      current !== undefined &&
      taskNodeLine(root, current) === task.source.line &&
      root.source.filePath === task.source.filePath
    );
  }

  private renderTaskStatus(mainRow: HTMLElement, task: TaskSnapshot): void {
    renderStatusMarker(mainRow, {
      task,
      registry: this.statusRegistry,
      onLeftClick: () => {
        runAsyncAction(this.toggleTask(task), 'Could not complete UI action');
      },
      onContextMenu: (event) => {
        event.stopPropagation();
        this.openStatusMenu(event, task);
      },
    });
  }

  private renderTaskCardBody(mainRow: HTMLElement, card: HTMLElement, task: TaskSnapshot): void {
    const body = mainRow.createDiv({ cls: 'abyss-task-body' });
    const titleRow = body.createDiv({ cls: 'abyss-task-title-row' });
    const recurrence = task.recurrence;
    if (recurrence !== undefined && recurrence !== '') {
      renderRecurrenceBadge(titleRow, recurrenceBadgeInput(recurrence));
    }
    this.renderTaskCountBadges(titleRow, task);
    const titleEl = titleRow.createSpan({ cls: 'abyss-task-title' });
    renderTaskText(titleEl, task.markdownTitle, {
      app: this.app,
      sourcePath: task.source.filePath,
      component: this.md,
      onEditLink: (occurrence, token) => {
        this.editTaskLink(task, occurrence, token);
      },
    });
    this.renderTaskDescription(card, task);
  }

  private renderTaskCountBadges(titleRow: HTMLElement, task: TaskSnapshot): void {
    const subtaskCount = task.subtasks.length;
    if (subtaskCount > 0) {
      const doneCount = task.subtasks.filter((subtask) => subtask.status === 'done').length;
      this.renderTaskCountBadge(titleRow, 'check-square', `${doneCount}/${subtaskCount}`);
    }
    if (task.comments.length > 0) {
      this.renderTaskCountBadge(titleRow, 'message-square', String(task.comments.length));
    }
    if (task.presentation.linkCount > 0) {
      this.renderTaskCountBadge(titleRow, 'paperclip', String(task.presentation.linkCount));
    }
  }

  private renderTaskCountBadge(host: HTMLElement, icon: string, text: string): void {
    const badge = host.createSpan({ cls: 'abyss-task-count-badge' });
    setIcon(badge, icon);
    badge.createSpan({ text });
  }

  private renderTaskDescription(card: HTMLElement, task: TaskSnapshot): void {
    const description = task.description;
    if (description === undefined || description === '') return;
    const descriptionElement = card.createDiv({ cls: 'abyss-task-desc' });
    renderTaskText(descriptionElement, description.split('\n')[0] ?? '', {
      app: this.app,
      sourcePath: task.source.filePath,
      component: this.md,
    });
  }

  private renderTaskCardMetadata(mainRow: HTMLElement, task: TaskSnapshot): void {
    const today = localDate(window.moment().format('YYYY-MM-DD'));
    const sel = this.state.get('selectedList');
    const d = task.planning.due ?? task.planning.scheduled;
    const tags = task.tags;
    const suppressToday = sel === 'today' && d === today;
    const showSourceNote = shouldShowSourceNote(
      task,
      this.settings.sourceNoteDisplay,
      this.settings.customFilePath,
    );
    const hasRightMeta =
      showSourceNote ||
      (d != null && !suppressToday) ||
      task.planning.time != null ||
      tags.length > 0;
    if (!hasRightMeta) return;
    const metaRight = mainRow.createDiv({ cls: 'abyss-task-meta-right' });
    this.renderTaskDateMetadata(metaRight, task, d, suppressToday);
    if (showSourceNote) {
      renderSourceNoteChip(metaRight, task, (filePath) => {
        this.addPropertyFilter({ type: 'file', filePath });
      });
    }
    for (const tag of tags.slice(0, 2)) this.renderTaskTagMetadata(metaRight, task, tag);
  }

  private renderTaskDateMetadata(
    host: HTMLElement,
    task: TaskSnapshot,
    date: LocalDate | undefined,
    suppressToday: boolean,
  ): void {
    const time = task.planning.time;
    if (date != null && !suppressToday) {
      const dateElement = host.createSpan({
        cls: `abyss-task-date ${this.getDateClass(date)}`.trim(),
      });
      this.renderDateFilterPart(dateElement, date);
      if (time != null) this.renderTimeFilterPart(dateElement, time, 'abyss-task-time-part');
      return;
    }
    if (date == null && time != null) this.renderTimeFilterPart(host, time, 'abyss-task-date');
  }

  private renderDateFilterPart(host: HTMLElement, date: LocalDate): void {
    const part = host.createSpan({ cls: 'abyss-task-date-part abyss-cursor-pointer' });
    const icon = part.createSpan({ cls: 'abyss-date-icon' });
    setIcon(icon, 'calendar');
    part.createSpan({ text: this.formatDate(date) });
    part.addEventListener('click', (event) => {
      event.stopPropagation();
      this.addPropertyFilter({ type: 'date', value: date });
    });
  }

  private renderTimeFilterPart(host: HTMLElement, time: string, className: string): void {
    const part = host.createSpan({ cls: `${className} abyss-cursor-pointer` });
    const icon = part.createSpan({ cls: 'abyss-date-icon' });
    setIcon(icon, 'clock');
    part.createSpan({ text: time });
    part.addEventListener('click', (event) => {
      event.stopPropagation();
      this.addPropertyFilter({ type: 'time', value: time });
    });
  }

  private renderTaskTagMetadata(host: HTMLElement, task: TaskSnapshot, tag: string): void {
    const element = host.createSpan({ cls: 'abyss-task-tag abyss-cursor-pointer', text: tag });
    const color = this.getTagColor(tag);
    if (color !== undefined && color !== '') {
      element.setCssProps({ '--abyss-tag-color': color });
      element.addClass('abyss-task-tag--colored');
    }
    element.addEventListener('click', (event) => {
      event.stopPropagation();
      this.addPropertyFilter({ type: 'tag', value: tag });
    });
    element.addEventListener('dragover', (event) => {
      const dragging = this.state.get('draggingTag');
      if (dragging === null || dragging === '' || dragging === tag) return;
      event.preventDefault();
      event.stopPropagation();
      element.classList.add('abyss-drop-target');
    });
    element.addEventListener('dragleave', () => {
      element.classList.remove('abyss-drop-target');
    });
    element.addEventListener('drop', (event) => {
      this.handleTaskTagDrop(event, element, task, tag);
    });
  }

  private handleTaskTagDrop(
    event: DragEvent,
    element: HTMLElement,
    task: TaskSnapshot,
    replacedTag: string,
  ): void {
    event.preventDefault();
    event.stopPropagation();
    element.classList.remove('abyss-drop-target');
    const dragging = this.state.get('draggingTag');
    if (dragging === null || dragging === '' || dragging === replacedTag) return;
    runAsyncAction(
      this.patchTaskTags(task, [dragging], [replacedTag]),
      'Could not complete UI action',
    );
  }

  private mountTaskCardInteractions(card: HTMLElement, task: TaskSnapshot): void {
    card.addEventListener('click', (event) => {
      this.handleTaskCardClick(event, task);
    });
    this.mountTaskCardDrag(card, task);
    card.addEventListener('contextmenu', (event) => {
      this.handleTaskContextMenu(event, card, task);
    });
  }

  private syncTaskDeleteButton(card: HTMLElement, task: TaskSnapshot | undefined): void {
    const mainRow = card.querySelector<HTMLElement>('.abyss-task-card-main-row');
    if (mainRow == null) return;
    const existing = mainRow.querySelector<HTMLButtonElement>('.abyss-task-delete-btn');
    if (task === undefined) {
      existing?.remove();
      mainRow.removeClass('abyss-task-card-main-row--has-delete');
      return;
    }
    mainRow.addClass('abyss-task-card-main-row--has-delete');
    if (existing != null) return;
    const deleteButton = mainRow.createEl('button', {
      cls: 'abyss-task-delete-btn',
      attr: { title: 'Delete task', 'aria-label': 'Delete task' },
    });
    setIcon(deleteButton, 'x');
    deleteButton.addEventListener('click', (event) => {
      event.stopPropagation();
      runAsyncAction(this.deleteTask(task), 'Could not complete UI action');
    });
  }

  private handleTaskCardClick(event: MouseEvent, task: TaskSnapshot): void {
    const key = this.taskKey(task);
    if (event.ctrlKey || event.metaKey) {
      if (this.selectedTaskKeys.has(key)) this.selectedTaskKeys.delete(key);
      else this.selectedTaskKeys.add(key);
      this.selectionAnchorKey = key;
      this.selectionFocusKey = key;
      this.updateSelectionVisuals();
      this.focusTaskKey(key);
      return;
    }
    if (event.shiftKey) {
      const keys = this.visibleTaskKeys();
      const anchor =
        this.selectionAnchorKey !== null && keys.includes(this.selectionAnchorKey)
          ? this.selectionAnchorKey
          : key;
      this.selectionAnchorKey = anchor;
      this.selectionFocusKey = key;
      this.replaceRangeSelection(anchor, key, keys);
      this.focusTaskKey(key);
      return;
    }
    this.selectedTaskKeys.clear();
    this.selectionAnchorKey = key;
    this.selectionFocusKey = key;
    this.updateSelectionVisuals();
    this.focusTaskKey(key);
    this.state.set('taskStack', [task]);
  }

  private mountTaskCardDrag(card: HTMLElement, task: TaskSnapshot): void {
    card.setAttribute('draggable', 'true');
    card.addEventListener('dragstart', () => {
      this.state.set('draggingTask', task);
      card.classList.add('abyss-dragging');
    });
    card.addEventListener('dragend', () => {
      this.state.set('draggingTask', null);
      card.classList.remove('abyss-dragging');
    });

    card.addEventListener('dragover', (event) => {
      const draggingTag = this.state.get('draggingTag');
      if ((draggingTag === null || draggingTag === '') && !this.canDropProjectOnTask(task)) return;
      event.preventDefault();
      card.classList.add('abyss-drop-target');
    });
    card.addEventListener('dragleave', () => {
      card.classList.remove('abyss-drop-target');
    });
    card.addEventListener('drop', (event) => {
      this.handleTaskCardDrop(event, card, task);
    });
  }

  private canDropProjectOnTask(task: TaskSnapshot): boolean {
    const project = this.state.get('draggingProject');
    return (
      project !== null &&
      project !== '' &&
      project !== task.source.filePath &&
      this.projectManager != null &&
      this.tasks != null
    );
  }

  private handleTaskCardDrop(event: DragEvent, card: HTMLElement, task: TaskSnapshot): void {
    card.classList.remove('abyss-drop-target');
    const tag = this.state.get('draggingTag');
    if (tag !== null && tag !== '') {
      event.preventDefault();
      runAsyncAction(this.assignTagFromInbox(task, tag), 'Could not complete UI action');
      return;
    }
    const project = this.state.get('draggingProject');
    if (
      !this.canDropProjectOnTask(task) ||
      project === null ||
      this.tasks == null ||
      this.projectManager == null
    )
      return;
    event.preventDefault();
    runAsyncAction(
      moveTaskToProjectWithRecovery(this.app, this.tasks, this.projectManager, task.ref, project),
      'Could not complete UI action',
    );
  }

  private handleTaskContextMenu(event: MouseEvent, card: HTMLElement, task: TaskSnapshot): void {
    event.preventDefault();
    const key = this.taskKey(task);
    if (this.selectedTaskKeys.size > 0 && !this.selectedTaskKeys.has(key))
      this.clearTaskSelection();
    if (this.selectedTaskKeys.size >= 2) {
      this.showBulkContextMenu(event, card);
      return;
    }
    const menu = this.createTaskContextMenu(card, task);
    showMenuAtMouseEventWithFocus(menu, event);
  }

  private createTaskContextMenu(card: HTMLElement, task: TaskSnapshot): Menu {
    const today = localDate(window.moment().format('YYYY-MM-DD'));
    const menu = new Menu();
    this.addTaskDateMenuItems(menu, card, task, today);
    this.addTaskTagMenuItems(menu, task);
    this.addTaskPropertyMenuItems(menu, task);
    this.addTaskActionMenuItems(menu, card, task);
    return menu;
  }

  private addTaskDateMenuItems(
    menu: Menu,
    card: HTMLElement,
    task: TaskSnapshot,
    today: LocalDate,
  ): void {
    const tomorrow = shiftLocalDate(today, 1);
    menu.addItem((item) =>
      item
        .setTitle('Today')
        .setIcon('calendar')
        .setSection('today')
        .setChecked(task.planning.due === today)
        .onClick(() => {
          runAsyncAction(this.toggleTaskDuePreset(task, today), 'Could not complete UI action');
        }),
    );

    if (tomorrow !== undefined) {
      menu.addItem((item) =>
        item
          .setTitle('Tomorrow')
          .setIcon('calendar-plus')
          .setSection('today')
          .setChecked(task.planning.due === tomorrow)
          .onClick(() => {
            runAsyncAction(
              this.toggleTaskDuePreset(task, tomorrow),
              'Could not complete UI action',
            );
          }),
      );
    }
    menu.addItem((item) =>
      item
        .setTitle('Set date…')
        .setIcon('calendar-cog')
        .setSection('actions')
        .onClick(() => {
          this.openTaskDatePicker(card, [task]);
        }),
    );
  }

  private addTaskTagMenuItems(menu: Menu, task: TaskSnapshot): void {
    for (const pinnedTag of this.settings.pinnedTags) {
      const hasTag = this.getTaskTags(task).has(pinnedTag);
      menu.addItem((item) =>
        item
          .setTitle(pinnedTag)
          .setIcon('tag')
          .setSection('tags')
          .setChecked(hasTag)
          .onClick(() => {
            runAsyncAction(
              this.patchTaskTags(task, hasTag ? [] : [pinnedTag], hasTag ? [pinnedTag] : []),
              'Could not complete UI action',
            );
          }),
      );
    }
  }

  private addTaskPropertyMenuItems(menu: Menu, task: TaskSnapshot): void {
    menu.addItem((item) => {
      item.setTitle('Priority').setIcon('arrow-up-narrow-wide').setSection('priority');
      const sub = getSubmenu(item);
      this.buildPrioritySubmenu(sub, task);
    });

    // ── Status (submenu) ──────────────────────────────────
    menu.addItem((item) => {
      item.setTitle('Status').setIcon('check-square').setSection('priority');
      const sub = getSubmenu(item);
      buildStatusSubmenu(sub, task, this.statusRegistry, (c) => {
        runAsyncAction(this.setTaskStatus(task, c), 'Could not complete UI action');
      });
    });

    menu.addItem((item) =>
      item
        .setTitle('Filter by this priority')
        .setIcon('filter')
        .setSection('priority')
        .onClick(() => {
          this.addPropertyFilter({ type: 'priority', value: task.priority });
        }),
    );

    menu.addItem((item) =>
      item
        .setTitle('Filter by this status')
        .setIcon('filter')
        .setSection('priority')
        .onClick(() => {
          this.addPropertyFilter({ type: 'status', value: task.statusSymbol });
        }),
    );
  }

  private addTaskActionMenuItems(menu: Menu, card: HTMLElement, task: TaskSnapshot): void {
    menu.addItem((item) =>
      item
        .setTitle('Set tag…')
        .setIcon('hash')
        .setSection('actions')
        .onClick(() => {
          this.openTagPicker(task);
        }),
    );

    menu.addItem((item) => {
      item
        .setTitle('Edit repeat…')
        .setIcon('repeat-2')
        .setSection('actions')
        .onClick(() => {
          this.openRecurrenceEditor(card, task);
        });
    });

    menu.addItem((item) =>
      item
        .setTitle('Open in note')
        .setIcon('file-text')
        .setSection('actions')
        .onClick(() => {
          runAsyncAction(openInFile(this.app, task), 'Could not complete UI action');
        }),
    );

    menu.addItem((item) =>
      item
        .setTitle('Delete')
        .setIcon('trash-2')
        .setSection('danger')
        .onClick(() => {
          runAsyncAction(this.deleteTask(task), 'Could not complete UI action');
        }),
    );
  }

  private bulkTagIndicator(count: number, total: number): string {
    if (count === total) return '✓ ';
    if (count > 0) return '~ ';
    return '';
  }

  private makeBulkTagRemoveHandler(selectedTasks: TaskSnapshot[], pinnedTag: string): () => void {
    return () => {
      runAsyncAction(
        Promise.all(selectedTasks.map((task) => this.patchTaskTags(task, [], [pinnedTag]))),
        'Could not complete UI action',
      );
    };
  }

  private makeBulkTagAddHandler(selectedTasks: TaskSnapshot[], pinnedTag: string): () => void {
    return () => {
      runAsyncAction(
        Promise.all(selectedTasks.map((task) => this.patchTaskTags(task, [pinnedTag], []))),
        'Could not complete UI action',
      );
    };
  }

  private addBulkTagItem(menu: Menu, pinnedTag: string, selectedTasks: TaskSnapshot[]): void {
    const count = selectedTasks.filter((task) => task.tags.includes(pinnedTag)).length;
    const allHave = count === selectedTasks.length;
    const indicator = this.bulkTagIndicator(count, selectedTasks.length);
    const clickHandler = allHave
      ? this.makeBulkTagRemoveHandler(selectedTasks, pinnedTag)
      : this.makeBulkTagAddHandler(selectedTasks, pinnedTag);
    menu.addItem((item) =>
      item
        .setTitle(`${indicator}${pinnedTag}  (${count}/${selectedTasks.length})`)
        .setIcon('tag')
        .setSection('tags')
        .onClick(clickHandler),
    );
  }

  private async deleteBulkTasks(selectedTasks: TaskSnapshot[]): Promise<void> {
    const sorted = [...selectedTasks].sort((a, b) => b.source.line - a.source.line);
    for (const t of sorted) await this.deleteTask(t);
    this.selectedTaskKeys.clear();
    this.selectionAnchorKey = null;
    this.selectionFocusKey = null;
    this.updateSelectionVisuals();
  }

  private buildPrioritySubmenu(sub: Menu, task: TaskSnapshot): void {
    for (const level of PRIORITY_LEVELS) {
      sub.addItem((si) => {
        si.setTitle(level.label)
          .setIcon('flag')
          .setChecked(task.priority === level.value)
          .onClick(() => {
            runAsyncAction(this.setPriority(task, level.value), 'Could not complete UI action');
          });
        applyPriorityFlagColor(si, level.value);
      });
    }
  }

  private buildBulkPrioritySubmenu(sub: Menu, selectedTasks: TaskSnapshot[]): void {
    for (const level of PRIORITY_LEVELS) {
      sub.addItem((si) => {
        si.setTitle(level.label)
          .setIcon('flag')
          .onClick(() => {
            runAsyncAction(
              Promise.all(selectedTasks.map((t) => this.setPriority(t, level.value))),
              'Could not complete UI action',
            );
          });
        applyPriorityFlagColor(si, level.value);
      });
    }
  }

  private getTaskTags(task: TaskSnapshot): Set<string> {
    return new Set(task.tags);
  }

  private async patchTaskTags(
    task: TaskSnapshot,
    add: readonly string[],
    remove: readonly string[],
  ): Promise<void> {
    const ref = task.ref;
    if (this.tasks == null) return;
    presentTaskCommandResult(
      await this.tasks.execute({
        type: 'patch',
        target: { type: 'task', ref },
        patch: { tags: { add, remove } },
      }),
    );
  }

  private async assignTagFromInbox(task: TaskSnapshot, tag: string): Promise<void> {
    const inboxTag = this.settings.inbox.tag;
    const remove =
      this.settings.inbox.removeTagOnAssign && this.getTaskTags(task).has(inboxTag)
        ? [inboxTag]
        : [];
    await this.patchTaskTags(task, [tag], remove);
  }

  private openTagPicker(task: TaskSnapshot): void {
    const currentTags = this.getTaskTags(task);
    const handleCommit = (toAdd: string[], toRemove: string[]): void => {
      runAsyncAction(this.patchTaskTags(task, toAdd, toRemove), 'Could not complete UI action');
    };
    new TagPickerModal(
      this.app,
      (tag) => this.getTagColor(tag),
      currentTags,
      new Set(),
      handleCommit,
      this.interactionOwnership,
    ).open();
  }

  private openBulkTagPicker(selectedTasks: TaskSnapshot[]): void {
    const tagSets = selectedTasks.map((t) => this.getTaskTags(t));
    const allTags = new Set(tagSets.flatMap((s) => [...s]));
    const hasAll = (tag: string): boolean => tagSets.every((s) => s.has(tag));
    const currentTags = new Set([...allTags].filter(hasAll));
    const partialTags = new Set([...allTags].filter((tag) => !hasAll(tag)));
    const handleBulkCommit = (toAdd: string[], toRemove: string[]): void => {
      runAsyncAction(
        Promise.all(selectedTasks.map((task) => this.patchTaskTags(task, toAdd, toRemove))),
        'Could not complete UI action',
      );
    };
    new TagPickerModal(
      this.app,
      (tag) => this.getTagColor(tag),
      currentTags,
      partialTags,
      handleBulkCommit,
      this.interactionOwnership,
    ).open();
  }

  private showBulkContextMenu(event: MouseEvent, card: HTMLElement): void {
    const selectedTasks = this.selectedTasksInVisualOrder();
    const firstSelectedTask = selectedTasks[0];
    if (firstSelectedTask === undefined) return;
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle(`${selectedTasks.length} tasks selected`)
        .setSection('header')
        .setDisabled(true),
    );
    this.addBulkDateMenuItems(menu, selectedTasks, card);
    for (const pinnedTag of this.settings.pinnedTags) {
      this.addBulkTagItem(menu, pinnedTag, selectedTasks);
    }
    this.addBulkPropertyMenuItems(menu, selectedTasks, firstSelectedTask);
    this.addBulkActionMenuItems(menu, selectedTasks);
    showMenuAtMouseEventWithFocus(menu, event);
  }

  private selectedTasksInVisualOrder(): TaskSnapshot[] {
    const selectedKeys = this.visibleTaskKeys().filter((key) => this.selectedTaskKeys.has(key));
    const allTasks = [...this.queries.list()];
    return selectedKeys
      .map((k) => {
        const lastColon = k.lastIndexOf(':');
        const fp = k.slice(0, lastColon);
        const lineNum = parseInt(k.slice(lastColon + 1), 10);
        return allTasks.find((t) => t.source.filePath === fp && t.source.line === lineNum);
      })
      .filter((t) => t !== undefined);
  }

  private addBulkDateMenuItems(menu: Menu, selectedTasks: TaskSnapshot[], card: HTMLElement): void {
    const today = localDate(window.moment().format('YYYY-MM-DD'));
    const tomorrow = shiftLocalDate(today, 1);
    const allHaveToday = selectedTasks.every((t) => t.planning.due === today);
    menu.addItem((item) =>
      item
        .setTitle('Today')
        .setIcon('calendar')
        .setSection('today')
        .setChecked(allHaveToday)
        .onClick(() => {
          runAsyncAction(
            this.applyBulkDuePreset(selectedTasks, today),
            'Could not complete UI action',
          );
        }),
    );

    if (tomorrow !== undefined) {
      const allHaveTomorrow = selectedTasks.every((task) => task.planning.due === tomorrow);
      menu.addItem((item) =>
        item
          .setTitle('Tomorrow')
          .setIcon('calendar-plus')
          .setSection('today')
          .setChecked(allHaveTomorrow)
          .onClick(() => {
            runAsyncAction(
              this.applyBulkDuePreset(selectedTasks, tomorrow),
              'Could not complete UI action',
            );
          }),
      );
    }
    menu.addItem((item) =>
      item
        .setTitle('Set date…')
        .setIcon('calendar-cog')
        .setSection('actions')
        .onClick(() => {
          this.openTaskDatePicker(card, selectedTasks);
        }),
    );
  }

  private addBulkPropertyMenuItems(
    menu: Menu,
    selectedTasks: TaskSnapshot[],
    firstSelectedTask: TaskSnapshot,
  ): void {
    menu.addItem((item) => {
      item.setTitle('Priority').setIcon('arrow-up-narrow-wide').setSection('priority');
      const sub = getSubmenu(item);
      this.buildBulkPrioritySubmenu(sub, selectedTasks);
    });

    menu.addItem((item) => {
      item.setTitle('Status').setIcon('check-square').setSection('priority');
      const sub = getSubmenu(item);
      buildStatusSubmenu(sub, firstSelectedTask, this.statusRegistry, (c) => {
        runAsyncAction(
          Promise.all(selectedTasks.map((t) => this.setTaskStatus(t, c))),
          'Could not complete UI action',
        );
      });
    });
  }

  private addBulkActionMenuItems(menu: Menu, selectedTasks: TaskSnapshot[]): void {
    menu.addItem((item) =>
      item
        .setTitle('Set tag…')
        .setIcon('hash')
        .setSection('actions')
        .onClick(() => {
          this.openBulkTagPicker(selectedTasks);
        }),
    );

    menu.addItem((item) =>
      item
        .setTitle('Delete all')
        .setIcon('trash-2')
        .setSection('danger')
        .onClick(() => {
          runAsyncAction(this.deleteBulkTasks(selectedTasks), 'Could not complete UI action');
        }),
    );
  }

  private renderPropertyChips(container: HTMLElement): void {
    const vs = this.state.get('centerListViewState');
    for (const [i, f] of vs.filters.entries()) {
      const label = this.filterChipLabel(f);
      const chip = container.createSpan({ cls: 'abyss-filter-chip' });
      chip.createSpan({ cls: 'abyss-filter-chip-label', text: label });
      const x = chip.createEl('button', { cls: 'abyss-filter-chip-x', text: '×' });
      const idx = i;
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        this.removePropertyFilter(idx);
      });
    }
  }

  private filterChipLabel(f: PropertyFilter): string {
    if (f.type === 'file') {
      return `📄 ${f.filePath.split('/').pop()?.replace(/\.md$/, '') ?? ''}`;
    }
    if (f.type !== 'priority') return this.nonPriorityFilterLabel(f);
    const level = PRIORITY_LEVELS.find((l) => l.value === f.value);
    if (level == null) return f.value;
    // D/None has no emoji and reads as "Normal" here (distinct from the
    // "None" label used in priority-picker menus).
    return level.emoji.length > 0 ? `${level.emoji} ${level.label}` : 'Normal';
  }

  private nonPriorityFilterLabel(
    filter: Exclude<PropertyFilter, { readonly type: 'file' } | { readonly type: 'priority' }>,
  ): string {
    if (filter.type === 'tag') return filter.value;
    if (filter.type === 'time') return `⏰ ${filter.value}`;
    if (filter.type === 'status') {
      return this.statusRegistry.bySymbol(filter.value)?.name ?? filter.value;
    }
    return `📅 ${this.formatDate(filter.value)}`;
  }

  private addPropertyFilter(filter: PropertyFilter): void {
    const vs = this.state.get('centerListViewState');
    const key = this.propertyFilterKey(filter);
    const already = vs.filters.some((existing) => this.propertyFilterKey(existing) === key);
    if (already) return;
    const next: ListViewState = { ...vs, filters: [...vs.filters, filter] };
    this.updateViewState(next);
  }

  private propertyFilterKey(filter: PropertyFilter): string {
    return filter.type === 'file'
      ? `${filter.type}:${filter.filePath}`
      : `${filter.type}:${filter.value}`;
  }

  private removePropertyFilter(idx: number): void {
    const vs = this.state.get('centerListViewState');
    const next: ListViewState = { ...vs, filters: vs.filters.filter((_, i) => i !== idx) };
    this.updateViewState(next);
  }

  private updateViewState(next: ListViewState): void {
    this.settings.listViewStates ??= {};
    this.settings.listViewStates[this.activeListKey()] = next;
    runAsyncAction(this.onSaveSettings(), 'Could not complete UI action');
    this.state.set('centerListViewState', next);
  }

  private activeListKey(): string {
    return listSelectionToKey(this.state.get('selectedList'));
  }

  private renderViewStateButton(container: HTMLElement): void {
    const vs = this.state.get('centerListViewState');
    const defaults = getListViewDefaults(this.activeListKey());
    const isNonDefault =
      vs.groupBy !== defaults.groupBy ||
      vs.sortBy.field !== defaults.sortBy.field ||
      vs.sortBy.dir !== defaults.sortBy.dir ||
      !statusGroupsEqual(vs.statusGroups, defaults.statusGroups);

    const btn = container.createEl('button', {
      cls: `abyss-view-state-btn${isNonDefault ? ' abyss-view-state-btn--active' : ''}`,
      attr: { 'aria-label': 'Sort & group options' },
    });
    setIcon(btn, 'arrow-up-down');
    btn.addEventListener('click', () => {
      this.showViewStatePopover(btn);
    });

    if (this.reopenStatusGroupPopover) {
      this.reopenStatusGroupPopover = false;
      this.showViewStatePopover(btn, true);
    }
  }

  private showViewStatePopover(anchor: HTMLElement, autoOpenStatusGroupRow = false): void {
    if (this.viewStatePopoverCleanup != null) {
      this.viewStatePopoverCleanup(true);
      return;
    }

    const vs = this.state.get('centerListViewState');
    const popover = this.el.createDiv({
      cls: 'abyss-view-state-popover abyss-popover',
      attr: { role: 'dialog', 'aria-label': 'Sort and group options' },
    });
    const ownerDocument = popover.ownerDocument;
    const ownershipToken = this.interactionOwnership.acquire({ blocksShortcuts: true });

    let dismissListening = false;
    let dismissTimer: number | undefined;
    let closed = false;
    const close = (restoreFocus = false): void => {
      if (closed) return;
      closed = true;
      if (dismissTimer !== undefined) {
        window.clearTimeout(dismissTimer);
        dismissTimer = undefined;
      }
      if (dismissListening) {
        ownerDocument.removeEventListener('click', dismiss, true);
        dismissListening = false;
      }
      popover.remove();
      if (this.viewStatePopoverCleanup === close) this.viewStatePopoverCleanup = null;
      ownershipToken.release();
      if (restoreFocus && anchor.isConnected) anchor.focus();
    };
    this.viewStatePopoverCleanup = close;
    const dismiss = (e: MouseEvent): void => {
      if (!popover.contains(e.target as Node) && e.target !== anchor) {
        close(false);
      }
    };
    popover.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    });

    this.renderViewStatePopoverRows({ popover, close }, vs, autoOpenStatusGroupRow);

    anchor.after(popover);
    popover.querySelector<HTMLElement>('.abyss-view-state-row-main')?.focus();
    dismissTimer = window.setTimeout(() => {
      dismissTimer = undefined;
      if (!popover.isConnected) return;
      ownerDocument.addEventListener('click', dismiss, true);
      dismissListening = true;
    }, 0);
  }

  private renderViewStatePopoverRows(
    session: ViewStatePopoverSession,
    viewState: ListViewState,
    autoOpenStatusGroupRow: boolean,
  ): void {
    const defaults = getListViewDefaults(this.activeListKey());
    this.renderViewStateRow(session, this.groupByRowSpec(viewState, defaults));
    this.renderViewStateRow(session, this.sortByRowSpec(viewState, defaults));
    this.renderViewStateMultiRow(
      session,
      this.statusGroupsRowSpec(session, viewState, autoOpenStatusGroupRow),
    );
    this.renderViewStateReset(session, viewState);
  }

  private groupByRowSpec(viewState: ListViewState, defaults: ListViewState): ViewStateRowSpec {
    const labels: Record<string, string> = {
      none: 'None',
      date: 'Date',
      priority: 'Priority',
      tag: 'Tag',
      status: 'Status',
    };
    return {
      icon: 'layout-list',
      label: 'Group by',
      displayValue: labels[viewState.groupBy] ?? viewState.groupBy,
      activeValue: viewState.groupBy,
      defaultValue: defaults.groupBy,
      options: Object.entries(labels).map(([value, label]) => ({ label, value })),
      onSelect: (value) => {
        this.updateViewState({ ...viewState, groupBy: value as ListViewState['groupBy'] });
      },
    };
  }

  private sortByRowSpec(viewState: ListViewState, defaults: ListViewState): ViewStateRowSpec {
    const arrow = viewState.sortBy.dir === 'asc' ? '↑' : '↓';
    const fields: Array<ListViewState['sortBy']['field']> = [
      'date',
      'priority',
      'title',
      'tag',
      'status',
    ];
    return {
      icon: 'arrow-up-down',
      label: 'Sort by',
      displayValue: `${this.capitalize(viewState.sortBy.field)} ${arrow}`,
      activeValue: viewState.sortBy.field,
      defaultValue: defaults.sortBy.field,
      options: fields.map((field) => ({
        label: `${this.capitalize(field)} ${viewState.sortBy.field === field ? arrow : ''}`.trim(),
        value: field,
      })),
      onSelect: (value) => {
        const field = value as ListViewState['sortBy']['field'];
        const dir =
          viewState.sortBy.field === field && viewState.sortBy.dir === 'asc' ? 'desc' : 'asc';
        this.updateViewState({ ...viewState, sortBy: { field, dir } });
      },
    };
  }

  private capitalize(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  private statusGroupsRowSpec(
    session: ViewStatePopoverSession,
    viewState: ListViewState,
    initiallyOpen: boolean,
  ): ViewStateMultiRowSpec {
    const apply = (groups: TaskStatusType[] | undefined): void => {
      this.applyStatusGroupsChange(session, viewState, groups);
    };
    return {
      icon: 'eye',
      label: 'Show',
      displayValue: this.statusGroupsLabel(viewState.statusGroups),
      selected: viewState.statusGroups ?? ALL_STATUS_GROUPS,
      options: ALL_STATUS_GROUPS.map((value) => ({ label: TYPE_LABELS[value], value })),
      onToggle: (rawValue) => {
        const value = rawValue as TaskStatusType;
        const current = viewState.statusGroups ?? ALL_STATUS_GROUPS;
        const next = current.includes(value)
          ? current.filter((group) => group !== value)
          : [...current, value];
        apply(next.length === 0 || next.length >= 4 ? undefined : next);
      },
      initiallyOpen,
      presets: [
        {
          label: 'Active',
          onClick: () => {
            apply(ACTIVE_STATUS_GROUPS);
          },
          isActive: statusGroupsEqual(viewState.statusGroups, ACTIVE_STATUS_GROUPS),
        },
        {
          label: 'All',
          onClick: () => {
            apply(undefined);
          },
          isActive: normalizeStatusGroups(viewState.statusGroups) === undefined,
        },
      ],
    };
  }

  private statusGroupsLabel(selected: TaskStatusType[] | undefined): string {
    const effective = normalizeStatusGroups(selected) ?? ALL_STATUS_GROUPS;
    if (effective.length >= 4) return 'All';
    if (statusGroupsEqual(effective, ACTIVE_STATUS_GROUPS)) return 'Active';
    return `${effective.length} selected`;
  }

  private applyStatusGroupsChange(
    session: ViewStatePopoverSession,
    viewState: ListViewState,
    groups: TaskStatusType[] | undefined,
  ): void {
    this.reopenStatusGroupPopover = true;
    session.close();
    const withoutStatusGroups = { ...viewState };
    delete withoutStatusGroups.statusGroups;
    this.updateViewState(
      groups === undefined ? withoutStatusGroups : { ...viewState, statusGroups: groups },
    );
  }

  private renderViewStateRow(session: ViewStatePopoverSession, spec: ViewStateRowSpec): void {
    const { rowMain, subList } = this.createViewStateRowShell(session.popover, spec, false);
    this.bindExpandableViewStateRow(session.popover, rowMain, subList);
    for (const option of spec.options) {
      const isActive = option.value === spec.activeValue;
      const element = this.createViewStateOption(subList, option.label, isActive);
      if (option.value === spec.defaultValue) {
        element.createSpan({ cls: 'abyss-view-state-option-default', text: 'Default' });
      }
      element.addEventListener('click', () => {
        session.close();
        spec.onSelect(option.value);
      });
    }
  }

  private renderViewStateMultiRow(
    session: ViewStatePopoverSession,
    spec: ViewStateMultiRowSpec,
  ): void {
    const { rowMain, subList } = this.createViewStateRowShell(
      session.popover,
      spec,
      spec.initiallyOpen,
    );
    this.bindExpandableViewStateRow(session.popover, rowMain, subList);
    for (const preset of spec.presets) {
      const element = this.createViewStateOption(subList, preset.label, preset.isActive === true);
      element.addEventListener('click', preset.onClick);
    }
    if (spec.presets.length > 0) subList.createDiv({ cls: 'abyss-view-state-sublist-divider' });
    for (const option of spec.options) {
      const element = this.createViewStateOption(
        subList,
        option.label,
        spec.selected.includes(option.value),
      );
      element.addEventListener('click', () => {
        spec.onToggle(option.value);
      });
    }
  }

  private createViewStateRowShell(
    popover: HTMLElement,
    spec: Pick<ViewStateRowSpec, 'icon' | 'label' | 'displayValue'>,
    initiallyOpen: boolean,
  ): { readonly rowMain: HTMLElement; readonly subList: HTMLElement } {
    const row = popover.createDiv({ cls: 'abyss-view-state-row' });
    const rowMain = row.createDiv({
      cls: 'abyss-view-state-row-main',
      attr: { role: 'button', tabindex: '0', 'aria-expanded': String(initiallyOpen) },
    });
    const icon = rowMain.createSpan({ cls: 'abyss-view-state-row-icon' });
    setIcon(icon, spec.icon);
    rowMain.createSpan({ cls: 'abyss-view-state-row-label', text: spec.label });
    rowMain.createSpan({ cls: 'abyss-view-state-row-value', text: spec.displayValue });
    const chevron = rowMain.createSpan({ cls: 'abyss-view-state-row-chevron' });
    setIcon(chevron, 'chevron-right');
    const subList = row.createDiv({ cls: 'abyss-view-state-sublist abyss-hidden' });
    if (initiallyOpen) {
      subList.removeClass('abyss-hidden');
      rowMain.addClass('is-open');
    }
    return { rowMain, subList };
  }

  private createViewStateOption(
    host: HTMLElement,
    label: string,
    active: boolean,
  ): HTMLButtonElement {
    const element = host.createEl('button', {
      cls: 'abyss-view-state-option',
      attr: { 'aria-pressed': String(active) },
    });
    const check = element.createSpan({ cls: 'abyss-view-state-option-check' });
    if (active) setIcon(check, 'check');
    element.createSpan({ cls: 'abyss-view-state-option-label', text: label });
    return element;
  }

  private bindExpandableViewStateRow(
    popover: HTMLElement,
    rowMain: HTMLElement,
    subList: HTMLElement,
  ): void {
    const toggle = (): void => {
      const shouldOpen = subList.hasClass('abyss-hidden');
      this.closeViewStateSublists(popover);
      if (!shouldOpen) return;
      subList.removeClass('abyss-hidden');
      rowMain.addClass('is-open');
      rowMain.setAttribute('aria-expanded', 'true');
    };
    rowMain.addEventListener('click', toggle);
    rowMain.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      toggle();
    });
  }

  private closeViewStateSublists(popover: HTMLElement): void {
    popover.querySelectorAll<HTMLElement>('.abyss-view-state-sublist').forEach((element) => {
      element.addClass('abyss-hidden');
    });
    popover.querySelectorAll<HTMLElement>('.abyss-view-state-row-main').forEach((element) => {
      element.removeClass('is-open');
      element.setAttribute('aria-expanded', 'false');
    });
  }

  private renderViewStateReset(session: ViewStatePopoverSession, viewState: ListViewState): void {
    if (!isListViewCustomized(viewState, this.activeListKey())) return;
    const row = session.popover.createDiv({ cls: 'abyss-view-state-reset' });
    const button = row.createEl('button', {
      cls: 'abyss-view-state-reset-btn',
      text: 'Reset to defaults',
    });
    button.addEventListener('click', () => {
      session.close();
      this.updateViewState(getListViewDefaults(this.activeListKey()));
    });
  }

  /** Keep the positioned calendar wrapper while delegating capture state and submission. */
  private showTimeGridQuickAdd(_hourColumnEl: HTMLElement, date: string, time: string): void {
    this.openCapture(
      { type: 'calendar-timed', date, time },
      { type: 'default', source: 'calendar' },
    );
  }

  /** Month and all-day cells share capture behavior but retain their existing geometry wrappers. */
  private showFillCellQuickAdd(_cell: HTMLElement, date: string, popCls: string): void {
    const placement: CalendarCapturePlacement =
      popCls === 'abyss-mg-quick-add'
        ? { type: 'calendar-month', date }
        : { type: 'calendar-all-day', date };
    this.openCapture(placement, { type: 'default', source: 'calendar' });
  }

  private renderAddTaskBar(): void {
    const bar = this.el.createDiv({ cls: 'abyss-add-task-bar' });
    this.renderCaptureHost(bar, {
      type: 'list',
      selectionKey: listSelectionToKey(this.state.get('selectedList')),
    });
  }

  private renderCaptureHost(host: HTMLElement, placement: BarCapturePlacement): void {
    host.dataset['abyssCaptureHost'] = placement.type;
    if (placement.type === 'project') host.dataset['abyssCapturePath'] = placement.path;
    if (placement.type === 'list') {
      host.dataset['abyssCaptureSelection'] = placement.selectionKey;
    }
    const trigger = host.createEl('button', {
      cls: 'abyss-add-task-trigger',
      attr: { type: 'button' },
    });
    trigger.createSpan({ cls: 'abyss-add-task-plus', text: '+' });
    trigger.createSpan({ cls: 'abyss-add-task-label', text: 'Add task' });
    trigger.addEventListener('click', () => {
      const context: CaptureContext =
        placement.type === 'project'
          ? { type: 'project-dashboard', path: placement.path }
          : { type: 'list', selection: this.state.get('selectedList') };
      this.openCapture(placement, context, trigger);
    });
    const active = this.activeCapture;
    if (active != null && this.sameCapturePlacement(active.placement, placement)) {
      trigger.hidden = true;
      active.returnFocus = trigger;
      this.mountCaptureSurface(active, host);
    }
  }

  private openCapture(
    placement: PanelCapturePlacement,
    context: CaptureContext,
    returnFocus = this.currentCaptureFocusOrigin(),
  ): void {
    if (this.captureTargets == null) return;
    this.cancelActiveCapture();
    const requestId = ++this.captureRequestId;
    this.resolvingCapture = { requestId, placement };
    runAsyncAction(
      this.captureTargets.resolve(context).then((resolvedTarget) => {
        if (requestId !== this.captureRequestId) return;
        this.resolvingCapture = null;
        const target = this.targetForCapturePlacement(resolvedTarget, placement);
        const controller = new TaskCaptureController({
          target,
          describe: describeTaskCreationResult,
          onResult: (result, description) => {
            const current = this.activeCapture;
            if (current?.requestId === requestId && description.kind !== 'success') {
              current.restoreFocusOnClose = false;
            }
            this.onCreationResult(result, description);
          },
          onRequestClose: () => {
            this.closeCaptureByRequestId(requestId);
          },
        });
        const session: PanelCaptureSession = {
          requestId,
          placement,
          controller,
          ...(returnFocus !== null && { returnFocus }),
          restoreFocusOnClose: false,
          focusOnMount: true,
        };
        this.activeCapture = session;
        this.remountActiveCapture();
      }),
      'Could not complete UI action',
    );
  }

  private remountActiveCapture(): void {
    const active = this.activeCapture;
    if (active == null) return;
    const placement = active.placement;
    if (this.isCalendarCapturePlacement(placement)) {
      const host = this.calendarCaptureHost(placement);
      if (host != null) this.mountCaptureSurface(active, host);
      return;
    }
    const host = [...this.el.querySelectorAll<HTMLElement>('[data-abyss-capture-host]')].find(
      (candidate) =>
        placement.type === 'project'
          ? candidate.dataset['abyssCaptureHost'] === 'project' &&
            candidate.dataset['abyssCapturePath'] === placement.path
          : candidate.dataset['abyssCaptureHost'] === 'list' &&
            candidate.dataset['abyssCaptureSelection'] === placement.selectionKey,
    );
    if (host != null) this.mountCaptureSurface(active, host);
  }

  private targetForCapturePlacement(
    target: CaptureTarget,
    placement: PanelCapturePlacement,
  ): CaptureTarget {
    if (!this.isCalendarCapturePlacement(placement)) return target;
    const label =
      placement.type === 'calendar-timed'
        ? `${placement.date} · ${placement.time}`
        : `${placement.date} · all day`;
    const initial = {
      ...target.initial,
      due: { type: 'set' as const, value: localDate(placement.date) },
      ...(placement.type === 'calendar-timed'
        ? { time: { type: 'set' as const, value: localTime(placement.time) } }
        : {}),
    };
    return { ...target, label, initial };
  }

  private calendarCaptureHost(placement: CalendarCapturePlacement): HTMLElement | null {
    if (placement.type === 'calendar-timed') {
      const day = [...this.el.querySelectorAll<HTMLElement>('.abyss-tg-day-column')].find(
        (candidate) => candidate.dataset['tgDate'] === placement.date,
      );
      const hourColumn = day?.querySelector<HTMLElement>('.abyss-tg-hour-column');
      if (hourColumn == null) return null;
      const host = this.captureWrapper(hourColumn, 'abyss-tg-quick-add');
      host.style.top = `${minutesToPixels(timeStringToMinutes(placement.time))}px`;
      host.dataset['abyssCaptureHost'] = placement.type;
      host.dataset['abyssCaptureDate'] = placement.date;
      host.dataset['abyssCaptureTime'] = placement.time;
      return host;
    }

    const selector =
      placement.type === 'calendar-month' ? '.abyss-mg-cell' : '.abyss-tg-allday-cell';
    const dateKey = placement.type === 'calendar-month' ? 'mgDate' : 'tgDate';
    const cell = [...this.el.querySelectorAll<HTMLElement>(selector)].find(
      (candidate) => candidate.dataset[dateKey] === placement.date,
    );
    if (cell == null) return null;
    const wrapperClass =
      placement.type === 'calendar-month' ? 'abyss-mg-quick-add' : 'abyss-tg-allday-quick-add';
    const host = this.captureWrapper(cell, wrapperClass);
    host.dataset['abyssCaptureHost'] = placement.type;
    host.dataset['abyssCaptureDate'] = placement.date;
    return host;
  }

  private captureWrapper(parent: HTMLElement, className: string): HTMLElement {
    const ownerWindow = parent.ownerDocument.defaultView;
    const current = [...parent.children].find(
      (candidate): candidate is HTMLElement =>
        ownerWindow != null &&
        candidate.instanceOf(ownerWindow.HTMLElement) &&
        candidate.classList.contains(className),
    );
    return current ?? parent.createDiv({ cls: className });
  }

  private mountCaptureSurface(active: PanelCaptureSession, host: HTMLElement): void {
    if (this.activeCapture !== active) return;
    if (this.isCaptureSurfaceMounted(active, host)) return;
    this.unmountActiveCapture();
    const feedbackHost = this.prepareCaptureHost(active, host);
    const onEscape = (): void => {
      active.restoreFocusOnClose = true;
    };
    const options = {
      ...(active.placement.type === 'calendar-timed' && {
        placeholder: `Task at ${active.placement.time}…`,
      }),
      ...(feedbackHost !== undefined && { feedbackHost }),
      onEscape,
    };
    const presentation =
      active.placement.type === 'list' || active.placement.type === 'project'
        ? 'inline'
        : 'default';
    const surface = new CaptureSurface(host, active.controller, { ...options, presentation });
    this.applyCaptureInputClass(surface, active.placement);
    active.surface = surface;
    active.host = host;
    this.focusNewCaptureSurface(active, surface);
  }

  private isCaptureSurfaceMounted(active: PanelCaptureSession, host: HTMLElement): boolean {
    return active.surface?.element.isConnected === true && active.host === host;
  }

  private applyCaptureInputClass(surface: CaptureSurface, placement: PanelCapturePlacement): void {
    const className = this.calendarCaptureInputClass(placement);
    if (className !== undefined && className !== '') surface.input.addClass(className);
  }

  private focusNewCaptureSurface(active: PanelCaptureSession, surface: CaptureSurface): void {
    if (!active.focusOnMount) return;
    active.focusOnMount = false;
    surface.focus();
  }

  private prepareCaptureHost(
    active: PanelCaptureSession,
    host: HTMLElement,
  ): HTMLElement | undefined {
    if (this.isCalendarCapturePlacement(active.placement)) {
      host.empty();
      const feedbackHost = this.el.createDiv({ cls: 'abyss-calendar-capture-feedback' });
      active.feedbackHost = feedbackHost;
      return feedbackHost;
    }
    const trigger = host.querySelector<HTMLButtonElement>('.abyss-add-task-trigger');
    if (trigger != null) {
      trigger.hidden = true;
      active.returnFocus = trigger;
    }
    return undefined;
  }

  private unmountActiveCapture(): void {
    const active = this.activeCapture;
    const surface = active?.surface;
    if (active == null || surface == null) return;
    active.focusOnMount =
      active.focusOnMount || surface.input.ownerDocument.activeElement === surface.input;
    active.surface = undefined;
    active.host = undefined;
    surface.destroy();
    active.feedbackHost?.remove();
    active.feedbackHost = undefined;
  }

  private closeCapture(active: PanelCaptureSession): void {
    if (this.activeCapture !== active) return;
    const host = active.host;
    const placement = active.placement;
    const returnFocus = active.returnFocus;
    const restoreFocus = active.restoreFocusOnClose;
    const captureOwnedFocus =
      active.surface !== undefined &&
      active.surface.input.ownerDocument.activeElement === active.surface.input;
    this.unmountActiveCapture();
    active.controller.destroy();
    this.activeCapture = null;
    this.restoreCaptureHost(host, placement);
    if (
      restoreFocus &&
      captureOwnedFocus &&
      returnFocus != null &&
      this.canRestoreCaptureFocus(returnFocus)
    ) {
      returnFocus.focus({ preventScroll: true });
    }
  }

  private closeCaptureByRequestId(requestId: number): void {
    const active = this.activeCapture;
    if (active?.requestId === requestId) this.closeCapture(active);
  }

  private cancelActiveCapture(): void {
    this.captureRequestId++;
    this.resolvingCapture = null;
    const active = this.activeCapture;
    if (active == null) return;
    const host = active.host;
    const placement = active.placement;
    this.unmountActiveCapture();
    active.controller.destroy();
    this.activeCapture = null;
    this.restoreCaptureHost(host, placement);
  }

  private restoreCaptureHost(
    host: HTMLElement | undefined,
    placement: PanelCapturePlacement,
  ): void {
    if (host?.isConnected !== true) return;
    if (this.isCalendarCapturePlacement(placement)) {
      host.remove();
      return;
    }
    host.querySelector<HTMLButtonElement>('.abyss-add-task-trigger')?.removeAttribute('hidden');
  }

  private sameCapturePlacement(left: PanelCapturePlacement, right: PanelCapturePlacement): boolean {
    return this.capturePlacementKey(left) === this.capturePlacementKey(right);
  }

  private capturePlacementKey(placement: PanelCapturePlacement): string {
    switch (placement.type) {
      case 'project':
        return `project:${placement.path}`;
      case 'calendar-timed':
        return `calendar-timed:${placement.date}:${placement.time}`;
      case 'calendar-all-day':
        return `calendar-all-day:${placement.date}`;
      case 'calendar-month':
        return `calendar-month:${placement.date}`;
      case 'list':
        return `list:${placement.selectionKey}`;
    }
  }

  private cancelStaleListCapture(): void {
    const placement = this.activeCapture?.placement ?? this.resolvingCapture?.placement;
    if (placement?.type !== 'list') return;
    const currentSelectionKey = listSelectionToKey(this.state.get('selectedList'));
    if (this.state.get('mode') !== 'tasks' || placement.selectionKey !== currentSelectionKey) {
      this.cancelActiveCapture();
    }
  }

  private isCalendarCapturePlacement(
    placement: PanelCapturePlacement,
  ): placement is CalendarCapturePlacement {
    return placement.type.startsWith('calendar-');
  }

  private calendarCaptureInputClass(placement: PanelCapturePlacement): string | undefined {
    if (placement.type === 'calendar-timed') return 'abyss-tg-quick-add-input';
    if (placement.type === 'calendar-all-day') return 'abyss-tg-allday-quick-add-input';
    if (placement.type === 'calendar-month') return 'abyss-mg-quick-add-input';
    return undefined;
  }

  private currentCaptureFocusOrigin(): HTMLElement | null {
    const active = this.el.ownerDocument.activeElement;
    return isRealmHTMLElement(active) ? active : null;
  }

  private canRestoreCaptureFocus(element: HTMLElement): boolean {
    if (!element.isConnected) return false;
    const ownerWindow = element.ownerDocument.defaultView;
    if (ownerWindow == null) return false;
    const style = ownerWindow.getComputedStyle(element);
    return (
      style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse'
    );
  }

  private async deleteTask(task: TaskSnapshot): Promise<void> {
    const ref = task.ref;
    if (this.tasks == null) return;
    const result = await this.tasks.execute({ type: 'delete', ref });
    presentTaskCommandResult(result);
    if (result.type !== 'ok' || result.outcome.type !== 'deleted') return;
    const stack = this.state.get('taskStack');
    const current = stack[0] != null ? rootTaskRef(stack[0]) : undefined;
    if (current != null && this.sameTaskRef(current, ref)) {
      this.state.set('taskStack', []);
    }
  }

  private sameTaskRef(left: TaskRef, right: TaskRef): boolean {
    return (
      left.filePath === right.filePath &&
      left.line === right.line &&
      left.revision === right.revision
    );
  }

  private getFilteredTasks(): TaskSnapshot[] {
    return [
      ...selectTaskList({
        tasks: this.queries.list(),
        selection: this.state.get('selectedList'),
        viewState: this.state.get('centerListViewState'),
        settings: this.settings,
        today: window.moment().format('YYYY-MM-DD') as LocalDate,
        textQuery: this.state.get('centerFilter'),
      }),
    ];
  }

  private getTitle(): string {
    const sel: unknown = this.state.get('selectedList');
    if (typeof sel === 'string') {
      const titles: Record<string, string> = {
        inbox: 'Inbox',
        today: 'Today',
        upcoming: 'Upcoming',
      };
      return titles[sel] ?? 'Tasks';
    }
    if (sel == null || typeof sel !== 'object') return 'Tasks';
    const selection = sel as {
      readonly type?: string;
      readonly tag?: string;
      readonly path?: string;
      readonly groupId?: string;
    };
    return this.structuredSelectionTitle(selection);
  }

  private structuredSelectionTitle(selection: {
    readonly type?: string;
    readonly tag?: string;
    readonly path?: string;
    readonly groupId?: string;
  }): string {
    switch (selection.type) {
      case 'tag':
        return selection.tag ?? 'Tasks';
      case 'project':
        return selection.path === undefined ? 'Tasks' : projectNameFromPath(selection.path);
      case 'group': {
        const group = this.settings.tagGroups.find(
          (candidate) => candidate.id === selection.groupId,
        );
        return group?.name ?? 'Group';
      }
      case undefined:
      default:
        return 'Tasks';
    }
  }

  private formatDate(d: string): string {
    const today = window.moment().format('YYYY-MM-DD');
    const tomorrow = window.moment().add(1, 'day').format('YYYY-MM-DD');
    if (d === today) return 'Today';
    if (d === tomorrow) return 'Tomorrow';
    const m = window.moment(d, 'YYYY-MM-DD');
    const diff = m.diff(window.moment(), 'days');
    if (diff > -7 && diff < 7) return m.format('ddd D MMM');
    return m.format('D MMM');
  }

  private getDateClass(d: string): string {
    const today = window.moment().format('YYYY-MM-DD');
    if (d < today) return 'is-overdue';
    if (d === today) return 'is-today';
    const tomorrow = window.moment().add(1, 'day').format('YYYY-MM-DD');
    if (d === tomorrow) return 'is-tomorrow';
    const dayAfter = window.moment().add(2, 'days').format('YYYY-MM-DD');
    if (d === dayAfter) return 'is-soon';
    return '';
  }

  private getTagColor(tag: string): string | undefined {
    const noHash = tag.replace(/^#/, '');
    for (const group of this.settings.tagGroups) {
      if (this.tagMatchesGroup(tag, noHash, group)) return group.color;
    }
    return undefined;
  }

  private tagMatchesGroup(
    tag: string,
    noHash: string,
    group: CalendarSettings['tagGroups'][number],
  ): boolean {
    if (group.mode === 'prefix' && group.prefix !== '') {
      return noHash === group.prefix || noHash.startsWith(`${group.prefix}/`);
    }
    return (
      group.mode === 'manual' &&
      group.tags != null &&
      (group.tags.includes(tag) || group.tags.includes(noHash))
    );
  }

  private async rescheduleTask(dragData: string, targetDate: string): Promise<void> {
    const task = this.taskFromDragData(dragData);
    if (this.tasks == null) return;
    if (task == null) return;
    try {
      const date = localDate(targetDate);
      const command = this.rescheduleCommand(task, date);
      presentTaskCommandResult(await this.tasks.execute(command));
    } catch {
      // Calendar controls supply the date; malformed gesture input remains a no-op.
    }
  }

  private async setTaskTimeFromDrop(dragData: string, date: string, time: string): Promise<void> {
    const task = this.taskFromDragData(dragData);
    if (this.tasks == null) return;
    if (task == null) return;
    try {
      const targetDate = localDate(date);
      const targetTime = localTime(time);
      presentTaskCommandResult(
        await this.tasks.execute(this.timeDropCommand(task, targetDate, targetTime)),
      );
    } catch {
      // A malformed drag payload is ignored without touching the task.
    }
  }

  private taskFromDragData(dragData: string): TaskSnapshot | undefined {
    const [filePath, lineText] = dragData.split(':::');
    const line = Number.parseInt(lineText ?? '', 10);
    if (filePath === undefined || filePath === '' || !Number.isInteger(line)) return undefined;
    return [...this.queries.list({ filePath })].find((task) => task.source.line === line);
  }

  private rescheduleCommand(
    task: TaskSnapshot,
    date: LocalDate,
  ): Parameters<TaskApplicationApi['execute']>[0] {
    if (task.planning.time == null) return { type: 'reschedule', ref: task.ref, date };
    const anchor =
      task.planning.start != null && task.planning.due != null
        ? task.planning.due
        : (task.planning.scheduled ?? task.planning.due);
    if (anchor == null) return { type: 'convert-to-all-day', ref: task.ref, date };
    return {
      type: 'move-to-all-day',
      ref: task.ref,
      days: daysBetweenLocalDates(anchor, date),
    };
  }

  private timeDropCommand(
    task: TaskSnapshot,
    date: LocalDate,
    time: ReturnType<typeof localTime>,
  ): Parameters<TaskApplicationApi['execute']>[0] {
    if (task.planning.start != null && task.planning.due != null) {
      return {
        type: 'move-time-slot',
        ref: task.ref,
        days: daysBetweenLocalDates(task.planning.due, date),
        time,
      };
    }
    return { type: 'set-time-slot', ref: task.ref, date, time };
  }

  private async commitTimedMove(task: TaskSnapshot, target: TimedDragTarget): Promise<void> {
    const ref = calendarRootTaskRef(task);
    if (this.tasks == null || ref == null) return;
    try {
      const command: Parameters<TaskApplicationApi['execute']>[0] =
        target.destination === 'all-day'
          ? { type: 'move-to-all-day', ref, days: target.dayDelta }
          : {
              type: 'move-time-slot',
              ref,
              days: target.dayDelta,
              time: localTime(minutesToTimeString(target.startMinutes)),
            };
      presentTaskCommandResult(await this.tasks.execute(command));
    } catch {
      // Geometry and command validation share the same target; malformed values remain no-ops.
    }
  }

  private async commitTimedDuration(
    task: TaskSnapshot,
    target: TimedVerticalResizeTarget,
  ): Promise<void> {
    if (this.tasks == null) return;
    try {
      const command = calendarPatchCommand(task, {
        time: {
          type: 'set',
          value: localTime(minutesToTimeString(target.startMinutes)),
        },
        duration: { type: 'set', value: durationMinutes(target.durationMinutes) },
      });
      if (command == null) return;
      presentTaskCommandResult(await this.tasks.execute(command));
    } catch {
      // Keep the previous duration if a forged target fails validation.
    }
  }

  private async commitSpanMove(task: TaskSnapshot, target: SpanMoveTarget): Promise<void> {
    const ref = calendarRootTaskRef(task);
    if (this.tasks == null || ref == null || target.days === 0) return;
    try {
      presentTaskCommandResult(
        await this.tasks.execute({ type: 'shift-schedule', ref, days: target.days }),
      );
    } catch {
      // The shared resolver validates the exact frozen delta again at the command boundary.
    }
  }

  private async commitTimedBoundary(
    task: TaskSnapshot,
    target: TimedBoundaryTarget,
  ): Promise<void> {
    const ref = calendarRootTaskRef(task);
    if (this.tasks == null || ref == null) return;
    try {
      const command: Parameters<TaskApplicationApi['execute']>[0] =
        target.boundary === 'create-span'
          ? { type: 'extend-span', ref, due: localDate(target.date) }
          : {
              type: 'set-span-boundary',
              ref,
              boundary: target.boundary,
              date: localDate(target.date),
            };
      presentTaskCommandResult(await this.tasks.execute(command));
    } catch {
      // Boundary geometry is validated again by the application command.
    }
  }

  private async updateTaskTime(task: TaskSnapshot, newStartMinutes: number): Promise<void> {
    if (this.tasks == null) return;
    try {
      const command = calendarPatchCommand(task, {
        time: { type: 'set', value: localTime(minutesToTimeString(newStartMinutes)) },
      });
      if (command == null) return;
      presentTaskCommandResult(await this.tasks.execute(command));
    } catch {
      // Keep the previous valid time when gesture arithmetic is out of range.
    }
  }

  private async updateTaskDuration(task: TaskSnapshot, newDurationMinutes: number): Promise<void> {
    if (this.tasks == null) return;
    try {
      const command = calendarPatchCommand(task, {
        duration: { type: 'set', value: durationMinutes(newDurationMinutes) },
      });
      if (command == null) return;
      presentTaskCommandResult(await this.tasks.execute(command));
    } catch {
      // Keep the previous valid duration when gesture arithmetic is invalid.
    }
  }

  private async updateTaskStart(task: TaskSnapshot, newStart: string): Promise<void> {
    const ref = calendarRootTaskRef(task);
    if (ref == null || this.tasks == null) return;
    try {
      presentTaskCommandResult(
        await this.tasks.execute({
          type: 'set-span-boundary',
          ref,
          boundary: 'start',
          date: localDate(newStart),
        }),
      );
    } catch {
      // Calendar controls supply the boundary; malformed input remains a no-op.
    }
  }

  private async rescheduleTaskDue(task: TaskSnapshot, newDue: string): Promise<void> {
    const ref = calendarRootTaskRef(task);
    if (ref == null || this.tasks == null) return;
    try {
      presentTaskCommandResult(
        await this.tasks.execute({
          type: 'set-span-boundary',
          ref,
          boundary: 'due',
          date: localDate(newDue),
        }),
      );
    } catch {
      // Calendar controls supply the boundary; malformed input remains a no-op.
    }
  }

  // The semantic command freezes the effective scheduled/due anchor when start is absent and
  // validates the final span atomically; presentation supplies only the dragged-to edge.
  private async extendTaskToSpan(task: TaskSnapshot, newDue: string): Promise<void> {
    if ((task.planning.start ?? task.planning.scheduled ?? task.planning.due) == null) return;
    const ref = calendarRootTaskRef(task);
    if (ref == null || this.tasks == null) return;
    try {
      presentTaskCommandResult(
        await this.tasks.execute({ type: 'extend-span', ref, due: localDate(newDue) }),
      );
    } catch {
      // Calendar controls supply the boundary; malformed input remains a no-op.
    }
  }

  private editTaskLink(task: TaskSnapshot, occ: number, token: LinkToken): void {
    const target = calendarMutationTarget(task);
    const tasks = this.tasks;
    if (target == null || tasks == null) return;
    new LinkEditModal(
      this.app,
      token,
      (newRaw) => {
        runAsyncAction(
          tasks
            .execute({
              type: 'edit-link',
              target: { type: 'title', target },
              occurrence: occ,
              replacement: newRaw,
            })
            .then(presentTaskCommandResult),
          'Could not complete UI action',
        );
      },
      task.source.filePath,
      this.interactionOwnership,
    ).open();
  }

  /** @internal Retained as a focused command seam for date-preset interactions and tests. */
  async toggleDueToday(task: TaskSnapshot): Promise<void> {
    const today = localDate(window.moment().format('YYYY-MM-DD'));
    await this.toggleTaskDuePreset(task, today);
  }

  private async toggleTaskDuePreset(task: TaskSnapshot, value: LocalDate): Promise<void> {
    await this.setTaskDue(task, task.planning.due === value ? null : value);
  }

  private async setTaskDue(task: TaskSnapshot, value: LocalDate | null): Promise<boolean> {
    const command = calendarPatchCommand(task, {
      due: value === null ? { type: 'clear' } : { type: 'set', value },
    });
    if (command == null || this.tasks == null) return false;
    const result = await this.tasks.execute(command);
    presentTaskCommandResult(result);
    return result.type === 'ok' && result.changed;
  }

  private async applyDueInOrder(
    tasks: readonly TaskSnapshot[],
    value: LocalDate,
  ): Promise<boolean> {
    let changed = false;
    for (const task of tasks) {
      const taskChanged = await this.setTaskDue(task, value);
      changed = taskChanged || changed;
    }
    return changed;
  }

  private async applyBulkDuePreset(
    tasks: readonly TaskSnapshot[],
    value: LocalDate,
  ): Promise<void> {
    const shouldClear = tasks.every((task) => task.planning.due === value);
    if (!shouldClear) {
      await this.applyDueInOrder(tasks, value);
      return;
    }
    for (const task of tasks) await this.setTaskDue(task, null);
  }

  private openTaskDatePicker(anchor: HTMLElement, tasks: readonly TaskSnapshot[]): void {
    this.clearTaskDatePicker();
    const focusKey = this.taskDateTriggerKey(anchor);
    const firstDue = tasks[0]?.planning.due;
    const initialValue =
      firstDue != null && tasks.every((task) => task.planning.due === firstDue)
        ? firstDue
        : undefined;
    const cleanup = showDatePickerPopover({
      owner: this.el,
      anchor,
      boundary: this.el,
      interactionOwnership: this.interactionOwnership,
      ...(initialValue !== undefined && { initialValue }),
      onPick: (inputValue) => {
        try {
          const value = localDate(inputValue);
          const pendingFocus =
            focusKey !== undefined && focusKey !== ''
              ? {
                  key: focusKey,
                  armedRenderGeneration: this.taskCardRenderGeneration,
                  changed: false,
                }
              : undefined;
          if (pendingFocus != null) {
            this.pendingTaskDateFocus = pendingFocus;
            this.taskDateFocusContinuityKey = pendingFocus.key;
          }
          const firstTask = tasks[0];
          if (firstTask === undefined) return;
          const update =
            tasks.length === 1
              ? this.setTaskDue(firstTask, value)
              : this.applyDueInOrder(tasks, value);
          if (pendingFocus != null) {
            const settleFocus = (changed: boolean): void => {
              if (this.pendingTaskDateFocus !== pendingFocus) return;
              if (!changed) {
                this.clearTaskDateFocusContinuity(pendingFocus.key);
                return;
              }
              pendingFocus.changed = true;
              this.releaseSettledTaskDateFocus(pendingFocus);
            };
            const abandonFocus = (): void => {
              settleFocus(false);
            };
            void update.then(settleFocus, abandonFocus);
          }
        } catch {
          // Native date inputs are normally valid; malformed programmatic values remain a no-op.
        }
      },
      onClose: () => {
        this.taskDatePickerCleanup = null;
      },
      ...(focusKey !== undefined && {
        restoreFocus: () => this.focusTaskDateTrigger(focusKey),
      }),
    });
    this.taskDatePickerCleanup = cleanup;
  }

  private clearTaskDatePicker(): void {
    this.taskDatePickerCleanup?.();
  }

  private taskDateTriggerKey(target: EventTarget | null): string | undefined {
    if (!this.isElementFromPanelRealm(target)) return undefined;
    const card = target.closest<HTMLElement>('.abyss-task-card');
    if (card == null || !this.el.contains(card)) return undefined;
    const filePath = card.dataset['filePath'];
    const line = card.dataset['line'];
    return filePath === undefined || line === undefined ? undefined : `${filePath}:${line}`;
  }

  private isElementFromPanelRealm(target: EventTarget | null): target is Element {
    if (target == null || !('ownerDocument' in target)) return false;
    const ownerDocument = (target as { readonly ownerDocument?: Document }).ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    return ownerWindow != null && target instanceof ownerWindow.Element;
  }

  private focusTaskDateTrigger(key: string): boolean {
    const card = Array.from(this.el.querySelectorAll<HTMLElement>('.abyss-task-card')).find(
      (candidate) =>
        `${candidate.dataset['filePath'] ?? ''}:${candidate.dataset['line'] ?? ''}` === key,
    );
    if (card?.isConnected !== true) return false;
    card.focus({ preventScroll: true });
    this.scrollTaskCardIntoView(card);
    return true;
  }

  private completeTaskCardRender(): void {
    this.taskCardRenderGeneration += 1;
    this.onRenderComplete(this.el);
    const continuityKey = this.taskDateFocusContinuityKey;
    const restored = continuityKey !== null && this.focusTaskDateTrigger(continuityKey);
    if (continuityKey !== null && !restored) {
      this.clearTaskDateFocusContinuity(continuityKey);
      return;
    }
    const pending = this.pendingTaskDateFocus;
    if (pending?.changed === true) this.releaseSettledTaskDateFocus(pending, restored);
  }

  private releaseSettledTaskDateFocus(
    pending: NonNullable<CenterPanel['pendingTaskDateFocus']>,
    restored = this.focusTaskDateTrigger(pending.key),
  ): void {
    if (
      this.pendingTaskDateFocus !== pending ||
      !pending.changed ||
      this.taskCardRenderGeneration <= pending.armedRenderGeneration
    ) {
      return;
    }
    this.pendingTaskDateFocus = null;
    if (!restored && this.taskDateFocusContinuityKey === pending.key) {
      this.taskDateFocusContinuityKey = null;
    }
  }

  private clearTaskDateFocusContinuity(key: string): void {
    if (this.pendingTaskDateFocus?.key === key) {
      this.pendingTaskDateFocus = null;
    }
    if (this.taskDateFocusContinuityKey === key) this.taskDateFocusContinuityKey = null;
  }

  private abandonTaskDateFocus(): void {
    this.pendingTaskDateFocus = null;
    this.taskDateFocusContinuityKey = null;
  }

  private taskKey(task: TaskSnapshot): string {
    return `${task.source.filePath}:${task.source.line}`;
  }

  private visibleTaskCards(): HTMLElement[] {
    if (this.state.get('mode') !== 'tasks') return [];
    const scroll = Array.from(this.el.children).find((child) =>
      child.classList.contains('abyss-center-scroll'),
    );
    return scroll != null
      ? Array.from(scroll.querySelectorAll<HTMLElement>('.abyss-task-card'))
      : [];
  }

  private visibleTaskKeys(): string[] {
    return this.visibleTaskCards().map(
      (card) => `${card.dataset['filePath'] ?? ''}:${card.dataset['line'] ?? ''}`,
    );
  }

  private replaceRangeSelection(anchor: string, focus: string, keys: readonly string[]): void {
    const anchorIndex = keys.indexOf(anchor);
    const focusIndex = keys.indexOf(focus);
    this.selectedTaskKeys.clear();
    if (anchorIndex !== -1 && focusIndex !== -1) {
      const from = Math.min(anchorIndex, focusIndex);
      const to = Math.max(anchorIndex, focusIndex);
      for (const key of keys.slice(from, to + 1)) this.selectedTaskKeys.add(key);
    }
    this.updateSelectionVisuals();
  }

  private reconcileTaskSelection(keys: readonly string[]): void {
    const visible = new Set(keys);
    for (const key of this.selectedTaskKeys) {
      if (!visible.has(key)) this.selectedTaskKeys.delete(key);
    }
    const firstSelected = keys.find((key) => this.selectedTaskKeys.has(key)) ?? null;
    if (
      this.selectionAnchorKey === null ||
      this.selectionAnchorKey === '' ||
      !visible.has(this.selectionAnchorKey)
    ) {
      this.selectionAnchorKey = firstSelected;
    }
    if (
      this.selectionFocusKey === null ||
      this.selectionFocusKey === '' ||
      !visible.has(this.selectionFocusKey)
    ) {
      this.selectionFocusKey = firstSelected;
    }
  }

  private focusTaskKey(key: string): void {
    const index = this.visibleTaskKeys().indexOf(key);
    const card = index === -1 ? undefined : this.visibleTaskCards()[index];
    if (card == null) return;
    card.focus({ preventScroll: true });
    this.scrollTaskCardIntoView(card);
  }

  private scrollTaskCardIntoView(card: HTMLElement): void {
    const scrollHost = card as Partial<Pick<HTMLElement, 'scrollIntoView'>>;
    scrollHost.scrollIntoView?.({ block: 'nearest' });
  }

  private taskForKey(key: string): TaskSnapshot | undefined {
    const separator = key.lastIndexOf(':');
    if (separator === -1) return undefined;
    const filePath = key.slice(0, separator);
    const line = Number(key.slice(separator + 1));
    if (!Number.isInteger(line)) return undefined;
    return this.queries
      .list()
      .find((task) => task.source.filePath === filePath && task.source.line === line);
  }

  private updateSelectionVisuals(): void {
    this.el.querySelectorAll<HTMLElement>('.abyss-task-card').forEach((card) => {
      const key = `${card.dataset['filePath'] ?? ''}:${card.dataset['line'] ?? ''}`;
      const isSelected = this.selectedTaskKeys.has(key);
      const selectedStateId = `abyss-selected-state-${encodeURIComponent(key)}`;
      const selectedState = card.querySelector<HTMLElement>('.abyss-selected-state');
      card.classList.toggle('abyss-multi-selected', isSelected);

      if (isSelected) {
        const description = selectedState ?? card.createDiv({ cls: 'abyss-selected-state' });
        description.addClass('abyss-sr-only');
        description.id = selectedStateId;
        description.textContent = 'Selected';
        const describedBy = (card.getAttribute('aria-describedby') ?? '')
          .split(/\s+/)
          .filter(Boolean);
        if (!describedBy.includes(selectedStateId)) {
          card.setAttribute('aria-describedby', [...describedBy, selectedStateId].join(' '));
        }
      } else {
        selectedState?.remove();
        const describedBy = (card.getAttribute('aria-describedby') ?? '')
          .split(/\s+/)
          .filter(
            (id): boolean => Boolean(id) && id !== selectedStateId && id !== selectedState?.id,
          );
        if (describedBy.length > 0) {
          card.setAttribute('aria-describedby', describedBy.join(' '));
        } else {
          card.removeAttribute('aria-describedby');
        }
      }
    });
    this.updateTaskStackSelection();

    const live =
      this.el.querySelector<HTMLElement>('.abyss-selection-live') ??
      this.el.createDiv({
        cls: 'abyss-selection-live abyss-sr-only',
        attr: { 'aria-live': 'polite', 'aria-atomic': 'true' },
      });
    const count = this.selectedTaskKeys.size;
    if (count !== this.lastAnnouncedSelectionCount) {
      this.lastAnnouncedSelectionCount = count;
      live.textContent = `${count} ${count === 1 ? 'task' : 'tasks'} selected`;
    }
  }

  private async setPriority(
    task: TaskSnapshot,
    priority: 'A' | 'B' | 'C' | 'D' | 'E' | 'F',
  ): Promise<void> {
    if (isForecastCalendarTask(task)) return;
    const command = calendarPatchCommand(task, {
      priority: { type: 'set', value: priority },
    });
    if (command == null || this.tasks == null) return;
    presentTaskCommandResult(await this.tasks.execute(command));
  }

  private openStatusMenu(event: MouseEvent, task: TaskSnapshot): void {
    this.clearTaskDatePicker();
    this.dismissRecurrenceEditor();
    this.viewStatePopoverCleanup?.();
    showStatusMenuAt(event, {
      task,
      registry: this.statusRegistry,
      owner: this.md,
      onPickStatus: (symbol) => {
        runAsyncAction(this.setTaskStatus(task, symbol), 'Could not complete UI action');
      },
      onPickPriority: (priority) => {
        runAsyncAction(this.setPriority(task, priority), 'Could not complete UI action');
      },
      interactionOwnership: this.interactionOwnership,
    });
  }

  private toggleTask(task: TaskSnapshot): Promise<void> {
    if (isForecastCalendarTask(task)) return Promise.resolve();
    return requestTaskCompletion(
      task,
      () => this.commitTaskToggle(task),
      this.interactionOwnership,
      this.completionConfirmationAbortController.signal,
    );
  }

  private async commitTaskToggle(task: TaskSnapshot): Promise<void> {
    const target = calendarMutationTarget(task);
    if (target == null || this.tasks == null) return;
    presentTaskCommandResult(
      await this.tasks.execute({
        type: 'toggle-completion',
        target,
      }),
    );
  }

  private setTaskStatus(task: TaskSnapshot, symbol: string): Promise<void> {
    if (isForecastCalendarTask(task)) return Promise.resolve();
    if (this.statusRegistry.bySymbol(symbol)?.type === 'done') {
      return requestTaskCompletion(
        task,
        () => this.commitTaskStatus(task, symbol),
        this.interactionOwnership,
        this.completionConfirmationAbortController.signal,
      );
    }
    return this.commitTaskStatus(task, symbol);
  }

  private async commitTaskStatus(task: TaskSnapshot, symbol: string): Promise<void> {
    const target = calendarMutationTarget(task);
    if (target == null || this.tasks == null) return;
    presentTaskCommandResult(
      await this.tasks.execute({
        type: 'set-status',
        target,
        symbol,
      }),
    );
  }

  private openRecurrenceEditor(anchor: HTMLElement, task: TaskSnapshot): void {
    if (isForecastCalendarTask(task)) return;
    this.dismissRecurrenceEditor();
    const occurrence = calendarOccurrenceForTask(task);
    const source = occurrence?.source ?? {
      root: task,
      target: { type: 'task' as const, ref: task.ref },
      node: task,
    };
    const lifecycle: { handle?: ReturnType<typeof mountAnchoredRecurrenceEditor> } = {};
    const cleanup = (): void => {
      lifecycle.handle?.dismiss();
    };
    const handle = mountAnchoredRecurrenceEditor({
      anchor,
      source,
      policy: { removeScheduledDate: this.settings.recurrence.removeScheduledDate },
      ownershipConflict: hasOtherCalendarRecurrenceOwner(source),
      onSubmit: (patch) => {
        const command = calendarPatchCommand(task, patch);
        if (this.tasks == null || command == null) {
          return Promise.resolve({
            type: 'io-error' as const,
            cause: 'application-unavailable',
            contentState: 'unchanged' as const,
          });
        }
        return this.tasks.execute(command);
      },
      onClose: () => {
        if (this.recurrenceEditorCleanup === cleanup) {
          this.recurrenceEditorCleanup = null;
        }
      },
      interactionOwnership: this.interactionOwnership,
    });
    lifecycle.handle = handle;
    this.recurrenceEditorCleanup = cleanup;
  }

  private openForecastRecurrenceEditor(anchor: HTMLElement, source: CalendarTaskSource): void {
    this.dismissRecurrenceEditor();
    const lifecycle: { handle?: ReturnType<typeof mountAnchoredRecurrenceEditor> } = {};
    const cleanup = (): void => {
      lifecycle.handle?.dismiss();
    };
    const handle = mountAnchoredRecurrenceEditor({
      anchor,
      source,
      policy: { removeScheduledDate: this.settings.recurrence.removeScheduledDate },
      ownershipConflict: hasOtherCalendarRecurrenceOwner(source),
      onSubmit: (patch) => {
        if (this.tasks == null) {
          return Promise.resolve({
            type: 'io-error' as const,
            cause: 'application-unavailable',
            contentState: 'unchanged' as const,
          });
        }
        const command = calendarSourcePatchCommand(source, patch);
        if (command == null) {
          return Promise.resolve({
            type: 'io-error' as const,
            cause: 'unsupported-calendar-patch',
            contentState: 'unchanged' as const,
          });
        }
        return this.tasks.execute(command);
      },
      onClose: () => {
        if (this.recurrenceEditorCleanup === cleanup) {
          this.recurrenceEditorCleanup = null;
        }
      },
      interactionOwnership: this.interactionOwnership,
    });
    lifecycle.handle = handle;
    this.recurrenceEditorCleanup = cleanup;
  }

  private dismissRecurrenceEditor(): void {
    const cleanup = this.recurrenceEditorCleanup;
    this.recurrenceEditorCleanup = null;
    cleanup?.();
  }
}
