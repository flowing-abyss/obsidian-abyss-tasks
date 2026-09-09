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
import {
  openViewOptionsPopover,
  type ViewOptionsMultiRow,
  type ViewOptionsSingleRow,
} from '../ui/ViewOptionsPopover';
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
import {
  dependencyCompletionBlocked,
  renderDependencyIndicator,
  type TaskDependencyLookup,
} from '../ui/taskDependencyPresentation';
import { openInFile } from '../ui/taskNavigation';
import { startTaskNodeDrag } from '../ui/taskNodeDrag';
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
  private readonly completionConfirmationAbortController_abyssPrivate = new AbortController();
  private el!: HTMLElement;
  private readonly offs_abyssPrivate: Array<() => void> = [];
  private calViewType_abyssPrivate: CalViewType = 'month';
  private calDate_abyssPrivate = window.moment().date(1);
  private calViewInstance_abyssPrivate: TodayView | WeekTimeGridView | MonthGridView | null = null;
  private calUnsubscribe_abyssPrivate: (() => void) | null = null;
  private calendarPickerCleanup_abyssPrivate: ((restoreFocus?: boolean) => void) | null = null;
  private taskDatePickerCleanup_abyssPrivate: (() => void) | null = null;
  private taskCardRenderGeneration_abyssPrivate = 0;
  private taskDateFocusContinuityKey_abyssPrivate: string | null = null;
  private pendingTaskDateFocus_abyssPrivate: {
    key: string;
    armedRenderGeneration: number;
    changed: boolean;
  } | null = null;
  private recurrenceEditorCleanup_abyssPrivate: (() => void) | null = null;
  private viewStatePopoverCleanup_abyssPrivate: ((restoreFocus?: boolean) => void) | null = null;
  private forecastMenuOwner_abyssPrivate: ForecastContextMenuOwner | null = null;
  private projectionDiagnosticOwner_abyssPrivate: CalendarProjectionDiagnosticOwner | null = null;
  // Full renders replace the view instance, so keep the last scroll-to-now key at panel scope.
  // Query notifications use the incremental patch path and never consult this state.
  private lastScrolledCalKey_abyssPrivate: string | null = null;
  // A deliberate full refresh empties the outer calendar before mountView can inspect its grid.
  // Carry scrollTop across that boundary; query patches retain the grid node and need no fallback.
  private pendingCalScrollTop_abyssPrivate: number | undefined = undefined;
  private readonly keyboardQueue_abyssPrivate: TimedBlockKeyboardQueue | null;
  private pendingTimedBlockFocus_abyssPrivate: TimedBlockFocusLocator | undefined;
  private readonly settledKeyboardSequences_abyssPrivate = new Set<number>();
  private readonly restoredKeyboardSequences_abyssPrivate = new Set<number>();
  private readonly committedKeyboardSequences_abyssPrivate = new Set<number>();
  private readonly pendingTimedBlockRestorations_abyssPrivate = new Map<
    number,
    PendingTimedBlockRestoration
  >();
  private nextTimedBlockRestoration_abyssPrivate = 0;
  private nextTimedBlockFocusSequence_abyssPrivate = 0;
  private calendarRenderGeneration_abyssPrivate = 0;
  private taskModal_abyssPrivate: TaskModal | null = null;
  private readonly selectedTaskKeys_abyssPrivate = new Set<string>();
  private lastAnnouncedSelectionCount_abyssPrivate = 0;
  private selectionAnchorKey_abyssPrivate: string | null = null;
  private selectionFocusKey_abyssPrivate: string | null = null;
  private filterDebounce_abyssPrivate = 0;
  private refocusSearch_abyssPrivate = false;
  // Set true while a status-group toggle click is in flight, so that the
  // full re-render triggered by updateViewState re-opens the popover with
  // the "Status group" row still expanded (multi-select shouldn't close on pick).
  private reopenStatusGroupPopover_abyssPrivate = false;
  private readonly onSaveSettings_abyssPrivate: () => Promise<void>;
  private md_abyssPrivate = new Component();
  private searchInputEl_abyssPrivate: HTMLInputElement | null = null;
  private searchResultsEl_abyssPrivate: HTMLElement | null = null;
  private searchResultsFrame_abyssPrivate: number | null = null;

  private projectsPanel_abyssPrivate: ProjectsPanel | null = null;
  private readonly captureApplication_abyssPrivate:
    (TaskApplicationApi & TaskCaptureApplicationApi) | null;
  private readonly captureTargets_abyssPrivate: CaptureTargetResolver | null;
  private captureRequestId_abyssPrivate = 0;
  private resolvingCapture_abyssPrivate: {
    readonly requestId: number;
    readonly placement: PanelCapturePlacement;
  } | null = null;
  private activeCapture_abyssPrivate: PanelCaptureSession | null = null;
  private readonly navigation_abyssPrivate: PanelNavigationActions;
  private readonly state_abyssPrivate: AppState;
  private readonly app_abyssPrivate: App;
  private readonly settings_abyssPrivate: CalendarSettings;
  private readonly queries_abyssPrivate: TaskQueryApi;
  private readonly statusRegistry_abyssPrivate: StatusRegistry;
  private readonly projectStore_abyssPrivate: ProjectStore | null;
  private readonly projectManager_abyssPrivate: ProjectManager | null;
  private readonly tasks_abyssPrivate: TaskApplicationApi | undefined;
  private endTaskDrag_abyssPrivate: (() => void) | undefined;
  private readonly commentTimeContext_abyssPrivate: CommentTimeContextProvider | undefined;
  private readonly onCreationResult_abyssPrivate: (
    result: TaskCommandResult,
    description: CreationResultDescription,
  ) => void;
  private readonly onRenderComplete_abyssPrivate: (root: HTMLElement) => void;
  private readonly interactionOwnership_abyssPrivate: InteractionOwnershipPort;

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
    this.state_abyssPrivate = state;
    this.app_abyssPrivate = app;
    this.settings_abyssPrivate = settings;
    this.queries_abyssPrivate = queries;
    this.statusRegistry_abyssPrivate = statusRegistry;
    this.onSaveSettings_abyssPrivate = onSaveSettings;
    this.projectStore_abyssPrivate = projectStore;
    this.projectManager_abyssPrivate = projectManager;
    this.tasks_abyssPrivate = tasks;
    this.commentTimeContext_abyssPrivate = commentTimeContext;
    this.onCreationResult_abyssPrivate = onCreationResult;
    this.onRenderComplete_abyssPrivate = onRenderComplete;
    this.interactionOwnership_abyssPrivate = interactionOwnership;
    this.captureApplication_abyssPrivate = captureApplication ?? null;
    this.captureTargets_abyssPrivate =
      this.captureApplication_abyssPrivate != null
        ? new CaptureTargetResolver(this.captureApplication_abyssPrivate, settings)
        : null;
    this.navigation_abyssPrivate = this.createNavigation_abyssPrivate(navigation);
    this.keyboardQueue_abyssPrivate = this.createKeyboardQueue_abyssPrivate(tasks);
  }

  private createNavigation_abyssPrivate(
    navigation: PanelNavigationActions | undefined,
  ): PanelNavigationActions {
    return (
      navigation ??
      new PanelNavigator(
        this.state_abyssPrivate,
        this.settings_abyssPrivate,
        {
          calendarView: () => this.calendarView(),
          setCalendarView: (view) => {
            this.setCalendarView(view);
          },
          openQuickCapture: () => undefined,
        },
        this.onSaveSettings_abyssPrivate,
      )
    );
  }

  private createKeyboardQueue_abyssPrivate(
    tasks: TaskApplicationApi | undefined,
  ): TimedBlockKeyboardQueue | null {
    if (tasks == null) return null;
    return new TimedBlockKeyboardQueue(tasks, {
      onCommitted: (task, intent, sequence, changed) => {
        this.handleKeyboardCommit_abyssPrivate(task, intent, sequence, changed);
      },
      onSettled: (_taskKey, sequence, summary) => {
        this.handleKeyboardSettled_abyssPrivate(
          sequence,
          summary.anyChanged,
          summary.sourceChanged,
        );
      },
      present: (result) => {
        presentTaskCommandResult(result);
        if (result.type !== 'ok' || result.outcome.type !== 'task') {
          this.clearTimedBlockFocus_abyssPrivate();
        }
      },
    });
  }

  private handleKeyboardSettled_abyssPrivate(
    sequence: number,
    anyChanged: boolean,
    sourceChanged: boolean,
  ): void {
    if (this.pendingTimedBlockFocus_abyssPrivate?.queueSequence !== sequence) return;
    if (
      (anyChanged || sourceChanged) &&
      !this.committedKeyboardSequences_abyssPrivate.has(sequence)
    ) {
      this.committedKeyboardSequences_abyssPrivate.add(sequence);
      this.deferTimedBlockFocus_abyssPrivate(this.el, this.calendarRenderGeneration_abyssPrivate);
    }
    const pendingRestoration = this.hasPendingTimedBlockRestoration_abyssPrivate(sequence);
    if (
      (!anyChanged && !sourceChanged && !pendingRestoration) ||
      this.restoredKeyboardSequences_abyssPrivate.has(sequence)
    ) {
      this.clearTimedBlockFocus_abyssPrivate(sequence);
      return;
    }
    this.settledKeyboardSequences_abyssPrivate.add(sequence);
  }

  mount(container: HTMLElement): void {
    this.el = container;
    this.initializeOwnedUi_abyssPrivate(container.ownerDocument);
    this.initializeListViewState_abyssPrivate();
    this.subscribeToState_abyssPrivate();
    this.render_abyssPrivate();
    this.el.setAttribute('tabindex', '0');
    this.mountKeyboardNavigation_abyssPrivate();
    this.mountFocusContinuity_abyssPrivate();
  }

  private initializeOwnedUi_abyssPrivate(ownerDocument: Document): void {
    this.forecastMenuOwner_abyssPrivate = createForecastContextMenuOwner(
      ownerDocument,
      this.interactionOwnership_abyssPrivate,
    );
    this.taskModal_abyssPrivate = new TaskModal(
      this.app_abyssPrivate,
      this.statusRegistry_abyssPrivate,
      this.settings_abyssPrivate,
      this.queries_abyssPrivate,
      this.tasks_abyssPrivate,
      this.commentTimeContext_abyssPrivate,
      this.interactionOwnership_abyssPrivate,
    );
  }

  private initializeListViewState_abyssPrivate(): void {
    const key = listSelectionToKey(this.state_abyssPrivate.get('selectedList'));
    const viewState = this.settings_abyssPrivate.listViewStates?.[key] ?? getListViewDefaults(key);
    this.state_abyssPrivate.set('centerListViewState', viewState);
  }

  private subscribeToState_abyssPrivate(): void {
    this.offs_abyssPrivate.push(
      this.state_abyssPrivate.on('selectedList', () => {
        this.handleSelectedListChanged_abyssPrivate();
      }),
      this.state_abyssPrivate.on('mode', () => {
        this.cancelStaleListCapture_abyssPrivate();
        this.cancelKeyboardInteraction_abyssPrivate();
      }),
      this.state_abyssPrivate.on('searchQuery', (query) => {
        this.handleSearchQueryChanged_abyssPrivate(query);
      }),
      this.state_abyssPrivate.on('taskStack', () => {
        this.updateTaskStackSelection_abyssPrivate();
      }),
      this.state_abyssPrivate.on('projectsPanel', (next, previous) => {
        if (previous.view === 'dashboard' && next.view === 'table') {
          this.cancelActiveCapture_abyssPrivate();
        }
      }),
      this.state_abyssPrivate.onCommit((changed) => {
        this.handleStateCommit_abyssPrivate(changed);
      }),
    );
  }

  private handleSelectedListChanged_abyssPrivate(): void {
    this.cancelStaleListCapture_abyssPrivate();
    this.selectedTaskKeys_abyssPrivate.clear();
    this.selectionAnchorKey_abyssPrivate = null;
    this.selectionFocusKey_abyssPrivate = null;
  }

  private updateTaskStackSelection_abyssPrivate(): void {
    const stack = this.state_abyssPrivate.get('taskStack');
    const root = stack[0];
    const current = stack[stack.length - 1];
    this.el.querySelectorAll<HTMLElement>('.abyss-task-card').forEach((card) => {
      const isSelected =
        root !== undefined &&
        current !== undefined &&
        card.dataset['filePath'] === rootTaskRef(root).filePath &&
        card.dataset['line'] === String(taskNodeLine(root as TaskSnapshot, current));
      card.classList.toggle('is-selected', isSelected);
      this.syncTaskDeleteButton_abyssPrivate(
        card,
        isSelected && current === root && this.selectedTaskKeys_abyssPrivate.size === 0
          ? (root as TaskSnapshot)
          : undefined,
      );
    });
  }

  private handleStateCommit_abyssPrivate(changed: ReadonlySet<string>): void {
    if (changed.size === 0 && this.state_abyssPrivate.get('mode') === 'calendar') {
      this.cancelKeyboardInteraction_abyssPrivate();
    }
    const renderKeys = ['selectedList', 'centerListViewState', 'centerFilter', 'mode'];
    if (changed.size === 0 || renderKeys.some((key) => changed.has(key)))
      this.render_abyssPrivate();
  }

  private mountKeyboardNavigation_abyssPrivate(): void {
    const onKeyDown = (event: KeyboardEvent): void => {
      this.handlePanelKeyDown_abyssPrivate(event);
    };
    this.el.addEventListener('keydown', onKeyDown);
    this.offs_abyssPrivate.push(() => {
      this.el.removeEventListener('keydown', onKeyDown);
    });
  }

  private handlePanelKeyDown_abyssPrivate(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.hasTaskSelection_abyssPrivate()) {
      this.clearTaskSelection_abyssPrivate();
      return;
    }
    if (!this.isTaskNavigationEvent_abyssPrivate(event)) return;
    const keys = this.visibleTaskKeys_abyssPrivate();
    if (keys.length === 0) return;
    event.preventDefault();
    this.moveTaskSelection_abyssPrivate(event, keys);
  }

  private hasTaskSelection_abyssPrivate(): boolean {
    return (
      this.selectedTaskKeys_abyssPrivate.size > 0 ||
      this.selectionAnchorKey_abyssPrivate !== null ||
      this.selectionFocusKey_abyssPrivate !== null
    );
  }

  private clearTaskSelection_abyssPrivate(): void {
    this.selectedTaskKeys_abyssPrivate.clear();
    this.selectionAnchorKey_abyssPrivate = null;
    this.selectionFocusKey_abyssPrivate = null;
    this.updateSelectionVisuals_abyssPrivate();
  }

  private isTaskNavigationEvent_abyssPrivate(event: KeyboardEvent): boolean {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return false;
    if (this.state_abyssPrivate.get('mode') !== 'tasks') return false;
    const target = event.target;
    if (!isRealmHTMLElement(target)) return true;
    return (
      target.closest(
        'input, textarea, select, button, a, [contenteditable]:not([contenteditable="false"]), .abyss-status-marker, .abyss-status-control, .abyss-popover',
      ) == null
    );
  }

  private moveTaskSelection_abyssPrivate(event: KeyboardEvent, keys: readonly string[]): void {
    const currentKey = this.currentNavigationKey_abyssPrivate(event.target, keys);
    const nextKey = this.nextNavigationKey_abyssPrivate(event.key, currentKey, keys);
    if (nextKey === undefined || nextKey === '') return;
    if (event.shiftKey) this.extendKeyboardSelection_abyssPrivate(currentKey, nextKey, keys);
    else this.replaceKeyboardSelection_abyssPrivate(nextKey);
    this.focusTaskKey_abyssPrivate(nextKey);
  }

  private currentNavigationKey_abyssPrivate(
    target: EventTarget | null,
    keys: readonly string[],
  ): string | undefined {
    const targetCard = isRealmHTMLElement(target)
      ? target.closest<HTMLElement>('.abyss-task-card')
      : null;
    const targetKey =
      targetCard != null && this.el.contains(targetCard)
        ? this.taskCardKey_abyssPrivate(targetCard)
        : null;
    const detailCard = this.visibleTaskCards_abyssPrivate().find((card) =>
      card.classList.contains('is-selected'),
    );
    const detailKey = detailCard == null ? null : this.taskCardKey_abyssPrivate(detailCard);
    return [this.selectionFocusKey_abyssPrivate, targetKey, detailKey].find(
      (candidate): candidate is string => candidate !== null && keys.includes(candidate),
    );
  }

  private taskCardKey_abyssPrivate(card: HTMLElement): string {
    return `${card.dataset['filePath'] ?? ''}:${card.dataset['line'] ?? ''}`;
  }

  private nextNavigationKey_abyssPrivate(
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

  private extendKeyboardSelection_abyssPrivate(
    currentKey: string | undefined,
    nextKey: string,
    keys: readonly string[],
  ): void {
    const anchor =
      this.selectionAnchorKey_abyssPrivate !== null &&
      keys.includes(this.selectionAnchorKey_abyssPrivate)
        ? this.selectionAnchorKey_abyssPrivate
        : currentKey;
    this.selectionAnchorKey_abyssPrivate = anchor ?? nextKey;
    this.selectionFocusKey_abyssPrivate = nextKey;
    this.replaceRangeSelection_abyssPrivate(this.selectionAnchorKey_abyssPrivate, nextKey, keys);
  }

  private replaceKeyboardSelection_abyssPrivate(nextKey: string): void {
    this.selectedTaskKeys_abyssPrivate.clear();
    this.selectionAnchorKey_abyssPrivate = nextKey;
    this.selectionFocusKey_abyssPrivate = nextKey;
    this.updateSelectionVisuals_abyssPrivate();
    const task = this.taskForKey_abyssPrivate(nextKey);
    if (task != null) this.state_abyssPrivate.set('taskStack', [task]);
  }

  private mountFocusContinuity_abyssPrivate(): void {
    const onFocusIn = (event: FocusEvent): void => {
      this.handlePanelFocusIn_abyssPrivate(event.target);
    };
    const ownerDocument = this.el.ownerDocument;
    ownerDocument.addEventListener('focusin', onFocusIn);
    this.offs_abyssPrivate.push(() => {
      ownerDocument.removeEventListener('focusin', onFocusIn);
    });
    const onPointerDown = (event: PointerEvent): void => {
      this.revokeTaskDateFocusOutside_abyssPrivate(event.target);
    };
    ownerDocument.addEventListener('pointerdown', onPointerDown, true);
    this.offs_abyssPrivate.push(() => {
      ownerDocument.removeEventListener('pointerdown', onPointerDown, true);
    });
    const ownerWindow = ownerDocument.defaultView;
    const onOwnerWindowBlur = (): void => {
      this.abandonTaskDateFocus_abyssPrivate();
      if (this.pendingTimedBlockFocus_abyssPrivate != null)
        this.cancelKeyboardInteraction_abyssPrivate();
    };
    ownerWindow?.addEventListener('blur', onOwnerWindowBlur);
    this.offs_abyssPrivate.push(() => {
      ownerWindow?.removeEventListener('blur', onOwnerWindowBlur);
    });
  }

  private handlePanelFocusIn_abyssPrivate(target: EventTarget | null): void {
    this.revokeTaskDateFocusOutside_abyssPrivate(target);
    if (!isRealmHTMLElement(target)) return;
    const ownerDocument = this.el.ownerDocument;
    if (target === ownerDocument.body || target === ownerDocument.documentElement) return;
    const block = target.closest<HTMLElement>('.abyss-tg-block');
    if (block != null && this.el.contains(block)) this.retainTimedBlockFocus_abyssPrivate(block);
    else if (this.pendingTimedBlockFocus_abyssPrivate != null)
      this.cancelKeyboardInteraction_abyssPrivate();
  }

  private revokeTaskDateFocusOutside_abyssPrivate(target: EventTarget | null): void {
    const key = this.taskDateFocusContinuityKey_abyssPrivate;
    if (key !== null && this.taskDateTriggerKey_abyssPrivate(target) !== key)
      this.abandonTaskDateFocus_abyssPrivate();
  }

  refresh(): void {
    if (this.refreshMountedProjects_abyssPrivate(this.state_abyssPrivate.get('mode'))) return;
    if (
      this.state_abyssPrivate.get('mode') === 'search' &&
      (this.searchInputEl_abyssPrivate?.isConnected ?? false) &&
      (this.searchResultsEl_abyssPrivate?.isConnected ?? false)
    ) {
      this.scheduleSearchResults_abyssPrivate(this.state_abyssPrivate.get('searchQuery'));
      return;
    }
    this.render_abyssPrivate();
  }

  refreshProjectTableSettings(): void {
    this.projectsPanel_abyssPrivate?.refreshTableSettings();
  }

  /** Keeps project-table draft ownership at the table before a mode transition. */
  finishProjectTableEditorBefore(action: () => void): void {
    const panel = this.projectsPanel_abyssPrivate;
    if (panel === null) action();
    else panel.finishTableEditorBefore(action);
  }

  calendarView(): CalViewType {
    return this.calViewType_abyssPrivate;
  }

  setCalendarView(view: CalViewType): void {
    this.calViewType_abyssPrivate = view;
    if (view === 'week') this.calDate_abyssPrivate = window.moment().startOf('isoWeek');
    else if (view === 'today') this.calDate_abyssPrivate = window.moment();
    else this.calDate_abyssPrivate = window.moment().date(1);
  }

  destroy(): void {
    this.endTaskDrag_abyssPrivate?.();
    this.completionConfirmationAbortController_abyssPrivate.abort();
    this.cancelActiveCapture_abyssPrivate();
    this.cancelKeyboardInteraction_abyssPrivate();
    this.abandonTaskDateFocus_abyssPrivate();
    this.clearSearchShell_abyssPrivate();
    this.clearTaskDatePicker_abyssPrivate();
    this.dismissRecurrenceEditor_abyssPrivate();
    this.viewStatePopoverCleanup_abyssPrivate?.();
    this.taskModal_abyssPrivate?.close();
    window.clearTimeout(this.filterDebounce_abyssPrivate);
    this.offs_abyssPrivate.forEach((f) => {
      f();
    });
    this.destroyCalendarView_abyssPrivate();
    this.destroyProjectsPanel_abyssPrivate();
    this.md_abyssPrivate.unload();
    if ('el' in this) this.el.empty();
  }

  private destroyProjectsPanel_abyssPrivate(): void {
    this.projectsPanel_abyssPrivate?.destroy();
    this.projectsPanel_abyssPrivate = null;
  }

  /** Renders a project's tasks (reusing the card component) plus an add bar that writes into the note. */
  private renderProjectTasks_abyssPrivate(host: HTMLElement, path: string): void {
    const tasks = [...this.queries_abyssPrivate.list({ filePath: path })];
    const scroll = host.createDiv({ cls: 'abyss-center-scroll abyss-project-tasks-scroll' });
    if (tasks.length === 0) {
      scroll.createDiv({ cls: 'abyss-center-empty', text: 'No tasks yet' });
    } else {
      for (const task of tasks) this.renderTaskCard_abyssPrivate(scroll, task);
    }

    const bar = host.createDiv({ cls: 'abyss-add-task-bar' });
    this.renderCaptureHost_abyssPrivate(bar, { type: 'project', path });
    this.completeTaskCardRender_abyssPrivate();
  }

  private destroyCalendarView_abyssPrivate(): void {
    this.forecastMenuOwner_abyssPrivate?.dismiss();
    this.projectionDiagnosticOwner_abyssPrivate?.destroy();
    this.projectionDiagnosticOwner_abyssPrivate = null;
    this.clearCalendarPicker_abyssPrivate();
    this.calUnsubscribe_abyssPrivate?.();
    this.calUnsubscribe_abyssPrivate = null;
    this.calViewInstance_abyssPrivate?.destroy();
    this.calViewInstance_abyssPrivate = null;
  }

  private clearCalendarPicker_abyssPrivate(restoreFocus = false): void {
    this.calendarPickerCleanup_abyssPrivate?.(restoreFocus);
  }

  private armCalendarPicker_abyssPrivate(picker: HTMLElement, anchor: HTMLElement): void {
    const ownerDocument = this.el.ownerDocument;
    const ownershipToken = this.interactionOwnership_abyssPrivate.acquire({
      blocksShortcuts: true,
    });
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
      if (this.calendarPickerCleanup_abyssPrivate === cleanup)
        this.calendarPickerCleanup_abyssPrivate = null;
      if (restoreFocus && anchor.isConnected) anchor.focus();
    };
    this.calendarPickerCleanup_abyssPrivate = cleanup;
    anchor.setAttribute('aria-expanded', 'true');
    picker.addEventListener('keydown', onKeyDown);
    const selectedOption = picker.querySelector<HTMLElement>('button.is-active');
    const firstOption = picker.querySelector<HTMLElement>('button:not(:disabled)');
    (selectedOption ?? firstOption)?.focus({ preventScroll: true });
    registrationTimer = window.setTimeout(() => {
      registrationTimer = undefined;
      if (this.calendarPickerCleanup_abyssPrivate !== cleanup || !picker.isConnected) return;
      ownerDocument.addEventListener('click', dismiss, true);
      listening = true;
    }, 0);
  }

  private render_abyssPrivate(): void {
    const mode = this.state_abyssPrivate.get('mode');
    if (this.refreshMountedProjects_abyssPrivate(mode)) return;
    this.prepareRender_abyssPrivate(mode);
    if (mode !== 'projects') this.destroyProjectsPanel_abyssPrivate();
    if (mode === 'calendar') {
      this.renderCalendarRoot_abyssPrivate();
      return;
    }
    this.prepareNonCalendarRoot_abyssPrivate();
    if (mode === 'search') {
      this.renderSearch_abyssPrivate();
      return;
    }
    if (mode === 'projects') {
      this.renderProjectsMode_abyssPrivate();
      return;
    }
    this.renderTasksMode_abyssPrivate();
  }

  private refreshMountedProjects_abyssPrivate(mode: string): boolean {
    const panel = this.projectsPanel_abyssPrivate;
    if (mode !== 'projects' || panel === null) return false;
    if (this.state_abyssPrivate.get('projectsPanel').view === 'dashboard') {
      this.prepareRender_abyssPrivate(mode);
    }
    panel.refresh();
    return true;
  }

  private prepareRender_abyssPrivate(mode: string): void {
    this.unmountActiveCapture_abyssPrivate();
    this.clearTaskDatePicker_abyssPrivate();
    this.dismissRecurrenceEditor_abyssPrivate();
    this.viewStatePopoverCleanup_abyssPrivate?.();
    this.clearSearchShell_abyssPrivate();
    if (mode === 'search') return;
    this.md_abyssPrivate.unload();
    this.md_abyssPrivate = new Component();
    this.md_abyssPrivate.load();
  }

  private renderCalendarRoot_abyssPrivate(): void {
    this.captureActiveTimedBlockFocus_abyssPrivate();
    this.pendingCalScrollTop_abyssPrivate =
      this.el.querySelector<HTMLElement>('.abyss-tg-grid-row')?.scrollTop;
    this.el.empty();
    this.el.addClass('abyss-center--calendar');
    this.destroyCalendarView_abyssPrivate();
    this.renderCalendarMode_abyssPrivate();
  }

  private prepareNonCalendarRoot_abyssPrivate(): void {
    this.el.removeClass('abyss-center--calendar');
    this.destroyCalendarView_abyssPrivate();
    this.el.empty();
  }

  private renderProjectsMode_abyssPrivate(): void {
    this.el.addClass('abyss-center--projects');
    if (this.projectStore_abyssPrivate == null || this.projectManager_abyssPrivate == null) {
      this.el.createDiv({ cls: 'abyss-center-empty', text: 'Projects unavailable' });
      this.onRenderComplete_abyssPrivate(this.el);
      return;
    }
    this.destroyProjectsPanel_abyssPrivate();
    this.projectsPanel_abyssPrivate = new ProjectsPanel(
      this.state_abyssPrivate,
      this.projectStore_abyssPrivate,
      this.projectManager_abyssPrivate,
      this.settings_abyssPrivate,
      this.app_abyssPrivate,
      {
        saveSettings: this.onSaveSettings_abyssPrivate,
        renderTasks: (host, path) => {
          this.renderProjectTasks_abyssPrivate(host, path);
        },
      },
    );
    const host = this.el.createDiv({ cls: 'abyss-projects-host' });
    this.projectsPanel_abyssPrivate.mount(host);
    this.onRenderComplete_abyssPrivate(this.el);
  }

  private renderTasksMode_abyssPrivate(): void {
    this.el.removeClass('abyss-center--projects');
    const header = this.el.createDiv({ cls: 'abyss-center-header' });
    header.createEl('h2', { cls: 'abyss-center-title', text: this.getTitle_abyssPrivate() });
    const controls = header.createDiv({ cls: 'abyss-center-controls' });
    this.renderPropertyChips_abyssPrivate(controls);
    this.renderViewStateButton_abyssPrivate(controls);
    this.renderTaskFilterInput_abyssPrivate(controls);
    const tasks = this.getFilteredTasks_abyssPrivate();
    const scroll = this.el.createDiv({ cls: 'abyss-center-scroll' });
    if (tasks.length === 0) scroll.createDiv({ cls: 'abyss-center-empty', text: 'No tasks' });
    else this.renderWithGrouping_abyssPrivate(scroll, tasks);
    this.renderAddTaskBar_abyssPrivate();
    this.reconcileTaskSelection_abyssPrivate(this.visibleTaskKeys_abyssPrivate());
    this.updateSelectionVisuals_abyssPrivate();
    this.completeTaskCardRender_abyssPrivate();
  }

  private renderTaskFilterInput_abyssPrivate(controls: HTMLElement): void {
    const searchInput = controls.createEl('input', {
      cls: 'abyss-center-search',
      attr: { type: 'text', placeholder: 'Filter…', 'aria-label': 'Filter tasks' },
    });
    searchInput.value = this.state_abyssPrivate.get('centerFilter');
    if (this.refocusSearch_abyssPrivate) {
      this.refocusSearch_abyssPrivate = false;
      window.setTimeout(() => {
        searchInput.focus();
        searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);
      }, 0);
    }
    searchInput.addEventListener('input', () => {
      window.clearTimeout(this.filterDebounce_abyssPrivate);
      this.filterDebounce_abyssPrivate = window.setTimeout(() => {
        this.refocusSearch_abyssPrivate = true;
        this.state_abyssPrivate.set('centerFilter', searchInput.value);
      }, 150);
    });
  }

  private renderCalendarMode_abyssPrivate(): void {
    const forecastMenuOwner =
      this.forecastMenuOwner_abyssPrivate ??
      createForecastContextMenuOwner(this.el.ownerDocument, this.interactionOwnership_abyssPrivate);
    this.forecastMenuOwner_abyssPrivate = forecastMenuOwner;
    const projectionDiagnosticOwner = createCalendarProjectionDiagnosticOwner(
      this.el.ownerDocument,
    );
    this.projectionDiagnosticOwner_abyssPrivate = projectionDiagnosticOwner;
    const navigation = this.createCalendarNavigation_abyssPrivate();
    const viewContainer = this.el.createDiv({ cls: 'abyss-cal-body' });
    const updateTitle = (): void => {
      this.updateCalendarTitle_abyssPrivate(navigation);
    };
    updateTitle();
    const handlers = this.createCalendarHandlers_abyssPrivate(viewContainer);
    const context: CalendarRenderContext = {
      viewContainer,
      forecastMenuOwner,
      projectionDiagnosticOwner,
      handlers,
    };
    const mountView = (): void => {
      this.mountCalendarView_abyssPrivate(context);
    };
    const patchView = (): void => {
      this.patchCalendarView_abyssPrivate(context, mountView);
    };
    mountView();

    this.bindCalendarNavigation_abyssPrivate(navigation, updateTitle, mountView);
    this.calUnsubscribe_abyssPrivate = this.queries_abyssPrivate.subscribe(() => {
      patchView();
    });
  }

  private createCalendarNavigation_abyssPrivate(): CalendarNavigationElements {
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
    this.renderCalendarViewSwitcher_abyssPrivate(right);
    return { prevButton, monthButton, yearButton, nextButton, todayButton };
  }

  private currentCalendarContent_abyssPrivate(): CalendarContent {
    const config = this.calendarConfig_abyssPrivate();
    const visibleDates = visibleCalendarDates(
      this.calViewType_abyssPrivate,
      this.calDate_abyssPrivate,
      config.firstDayOfWeek,
    );
    const firstVisibleDate = visibleDates[0];
    const lastVisibleDate = visibleDates[visibleDates.length - 1];
    if (firstVisibleDate === undefined || lastVisibleDate === undefined) {
      return { config, issues: [], tasks: [] };
    }
    const projection = this.queries_abyssPrivate.forCalendarProjection(
      visibleDates as unknown as readonly LocalDate[],
    );
    const occurrences = projectCalendarOccurrences(
      projection,
      { from: localDate(firstVisibleDate), to: localDate(lastVisibleDate) },
      { removeScheduledDate: this.settings_abyssPrivate.recurrence.removeScheduledDate },
    );
    return {
      config,
      issues: occurrences.issues,
      tasks: occurrences.occurrences.map(taskSnapshotForCalendarOccurrence),
    };
  }

  private calendarConfig_abyssPrivate(): ResolvedConfig {
    const firstDayOfWeek = this.settings_abyssPrivate.desktop.firstDayOfWeek;
    return {
      ...DEFAULT_VIEW_CONFIG,
      ...this.settings_abyssPrivate.desktop,
      isMobile: false,
      sourceNoteDisplay: this.settings_abyssPrivate.sourceNoteDisplay,
      customFilePath: this.settings_abyssPrivate.customFilePath,
      startPosition: this.calendarStartPosition_abyssPrivate(firstDayOfWeek),
    };
  }

  private calendarStartPosition_abyssPrivate(firstDayOfWeek: number): string {
    if (this.calViewType_abyssPrivate === 'week')
      return firstVisibleWeekDate(this.calDate_abyssPrivate, firstDayOfWeek);
    if (this.calViewType_abyssPrivate === 'today')
      return this.calDate_abyssPrivate.format('YYYY-MM-DD');
    return this.calDate_abyssPrivate.format('YYYY-MM');
  }

  private createCalendarView_abyssPrivate(
    forecastMenuOwner: ForecastContextMenuOwner,
    handlers: CalendarHandlers,
  ): TodayView | WeekTimeGridView | MonthGridView {
    if (this.calViewType_abyssPrivate === 'today')
      return this.createTodayCalendarView_abyssPrivate(forecastMenuOwner, handlers);
    if (this.calViewType_abyssPrivate === 'week')
      return this.createWeekCalendarView_abyssPrivate(forecastMenuOwner, handlers);
    return this.createMonthCalendarView_abyssPrivate(forecastMenuOwner, handlers);
  }

  private createTodayCalendarView_abyssPrivate(
    forecastMenuOwner: ForecastContextMenuOwner,
    handlers: CalendarHandlers,
  ): TodayView {
    return new TodayView({
      app: this.app_abyssPrivate,
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
      dependenciesFor: this.dependenciesFor_abyssPrivate,
      onSetStatus: handlers.onSetStatus,
      onSetPriority: handlers.onSetPriority,
      interactionOwnership: this.interactionOwnership_abyssPrivate,
      statusRegistry: this.statusRegistry_abyssPrivate,
      tagGroups: this.settings_abyssPrivate.tagGroups,
    });
  }

  private createWeekCalendarView_abyssPrivate(
    forecastMenuOwner: ForecastContextMenuOwner,
    handlers: CalendarHandlers,
  ): WeekTimeGridView {
    return new WeekTimeGridView({
      app: this.app_abyssPrivate,
      forecastMenuOwner,
      onTaskClick: handlers.onTaskClick,
      onForecastClick: handlers.onForecastClick,
      onForecastContextMenu: handlers.onForecastContextMenu,
      onDrop: handlers.onDrop,
      onDropTime: handlers.onDropTime,
      onCreateAtTime: handlers.onCreateAtTime,
      onCreateAtDate: handlers.onCreateAtDateAllDay,
      onDayHeaderClick: (date) => {
        this.openCalendarDay_abyssPrivate(date);
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
      dependenciesFor: this.dependenciesFor_abyssPrivate,
      onSetStatus: handlers.onSetStatus,
      onSetPriority: handlers.onSetPriority,
      interactionOwnership: this.interactionOwnership_abyssPrivate,
      statusRegistry: this.statusRegistry_abyssPrivate,
      tagGroups: this.settings_abyssPrivate.tagGroups,
    });
  }

  private createMonthCalendarView_abyssPrivate(
    forecastMenuOwner: ForecastContextMenuOwner,
    handlers: CalendarHandlers,
  ): MonthGridView {
    return new MonthGridView({
      app: this.app_abyssPrivate,
      forecastMenuOwner,
      onDayClick: (date) => {
        this.openCalendarDay_abyssPrivate(date);
      },
      onCreateAtDate: handlers.onCreateAtDate,
      onTaskClick: handlers.onTaskClick,
      onForecastClick: handlers.onForecastClick,
      onForecastContextMenu: handlers.onForecastContextMenu,
      onDrop: handlers.onDrop,
      onSpanMove: handlers.onSpanMove,
      onSpanBoundary: handlers.onSpanBoundary,
      onToggle: handlers.onToggle,
      dependenciesFor: this.dependenciesFor_abyssPrivate,
      onSetStatus: handlers.onSetStatus,
      onSetPriority: handlers.onSetPriority,
      onWeekClick: (week, year) => {
        this.openCalendarWeek_abyssPrivate(week, year);
      },
      interactionOwnership: this.interactionOwnership_abyssPrivate,
      statusRegistry: this.statusRegistry_abyssPrivate,
      tagGroups: this.settings_abyssPrivate.tagGroups,
    });
  }

  private openCalendarDay_abyssPrivate(date: string): void {
    this.cancelKeyboardInteraction_abyssPrivate();
    this.calViewType_abyssPrivate = 'today';
    this.calDate_abyssPrivate = window.moment(date);
    this.render_abyssPrivate();
  }

  private openCalendarWeek_abyssPrivate(week: string, year: string): void {
    this.cancelKeyboardInteraction_abyssPrivate();
    this.calViewType_abyssPrivate = 'week';
    this.calDate_abyssPrivate = window
      .moment()
      .isoWeekYear(Number.parseInt(year, 10))
      .isoWeek(Number.parseInt(week, 10))
      .startOf('isoWeek');
    this.render_abyssPrivate();
  }

  private renderCalendarViewSwitcher_abyssPrivate(host: HTMLElement): void {
    const switcher = host.createDiv({ cls: 'abyss-cal-view-switcher' });
    for (const view of ['today', 'week', 'month'] as const) {
      const button = switcher.createEl('button', {
        cls: `abyss-cal-view-btn${this.calViewType_abyssPrivate === view ? ' is-active' : ''}`,
        text: view === 'today' ? 'Day' : this.capitalize_abyssPrivate(view),
      });
      button.addEventListener('click', () => {
        this.navigation_abyssPrivate.openCalendarView(view);
      });
    }
  }

  private updateCalendarTitle_abyssPrivate(navigation: CalendarNavigationElements): void {
    if (this.calViewType_abyssPrivate === 'week') {
      navigation.monthButton.textContent = `Week ${this.calDate_abyssPrivate.format('w')}`;
    } else if (this.calViewType_abyssPrivate === 'today') {
      navigation.monthButton.textContent = this.calDate_abyssPrivate.format('MMMM D');
    } else {
      navigation.monthButton.textContent = this.calDate_abyssPrivate.format('MMMM');
    }
    navigation.yearButton.textContent = this.calDate_abyssPrivate.format('YYYY');
  }

  private mountCalendarView_abyssPrivate(context: CalendarRenderContext): void {
    this.prepareCalendarViewUpdate_abyssPrivate(context.forecastMenuOwner);
    this.unmountActiveCapture_abyssPrivate();
    const renderGeneration = ++this.calendarRenderGeneration_abyssPrivate;
    const grid = context.viewContainer.querySelector<HTMLElement>('.abyss-tg-grid-row');
    const preservedScrollTop = grid?.scrollTop ?? this.pendingCalScrollTop_abyssPrivate;
    this.pendingCalScrollTop_abyssPrivate = undefined;
    this.calViewInstance_abyssPrivate?.destroy();
    context.viewContainer.empty();
    const { config, issues, tasks } = this.currentCalendarContent_abyssPrivate();
    const shouldScrollToNow = this.shouldScrollCalendarToNow_abyssPrivate();
    this.calViewInstance_abyssPrivate = this.createCalendarView_abyssPrivate(
      context.forecastMenuOwner,
      context.handlers,
    );
    this.calViewInstance_abyssPrivate.render(
      context.viewContainer,
      tasks,
      config,
      shouldScrollToNow,
      preservedScrollTop,
    );
    this.finishCalendarViewUpdate_abyssPrivate(context, issues, renderGeneration);
  }

  private patchCalendarView_abyssPrivate(
    context: CalendarRenderContext,
    mountView: () => void,
  ): void {
    if (this.calViewInstance_abyssPrivate == null) {
      mountView();
      return;
    }
    this.prepareCalendarViewUpdate_abyssPrivate(context.forecastMenuOwner);
    const renderGeneration = ++this.calendarRenderGeneration_abyssPrivate;
    const { config, issues, tasks } = this.currentCalendarContent_abyssPrivate();
    this.unmountActiveCapture_abyssPrivate();
    this.calViewInstance_abyssPrivate.patch(context.viewContainer, tasks, config);
    this.finishCalendarViewUpdate_abyssPrivate(context, issues, renderGeneration);
  }

  private prepareCalendarViewUpdate_abyssPrivate(
    forecastMenuOwner: ForecastContextMenuOwner,
  ): void {
    this.dismissRecurrenceEditor_abyssPrivate();
    forecastMenuOwner.dismiss();
    this.captureActiveTimedBlockFocus_abyssPrivate();
    const queueSequence = this.pendingTimedBlockFocus_abyssPrivate?.queueSequence;
    if (queueSequence !== undefined)
      this.restoredKeyboardSequences_abyssPrivate.delete(queueSequence);
  }

  private finishCalendarViewUpdate_abyssPrivate(
    context: CalendarRenderContext,
    issues: readonly CalendarProjectionIssue[],
    renderGeneration: number,
  ): void {
    context.projectionDiagnosticOwner.update(context.viewContainer, issues);
    this.remountActiveCapture_abyssPrivate();
    this.onRenderComplete_abyssPrivate(context.viewContainer);
    this.deferTimedBlockFocus_abyssPrivate(context.viewContainer, renderGeneration);
  }

  private shouldScrollCalendarToNow_abyssPrivate(): boolean {
    const key = `${this.calViewType_abyssPrivate}:${this.calDate_abyssPrivate.format('YYYY-MM-DD')}`;
    const shouldScroll = key !== this.lastScrolledCalKey_abyssPrivate;
    this.lastScrolledCalKey_abyssPrivate = key;
    return shouldScroll;
  }

  private bindCalendarNavigation_abyssPrivate(
    navigation: CalendarNavigationElements,
    updateTitle: () => void,
    mountView: () => void,
  ): void {
    navigation.monthButton.addEventListener('click', () => {
      this.toggleMonthPicker_abyssPrivate(navigation.monthButton, updateTitle, mountView);
    });
    navigation.yearButton.addEventListener('click', () => {
      this.toggleYearPicker_abyssPrivate(navigation.yearButton, updateTitle, mountView);
    });
    navigation.prevButton.addEventListener('click', () => {
      this.navigateCalendar_abyssPrivate(-1, updateTitle, mountView);
    });
    navigation.nextButton.addEventListener('click', () => {
      this.navigateCalendar_abyssPrivate(1, updateTitle, mountView);
    });
    navigation.todayButton.addEventListener('click', () => {
      this.navigateCalendarToday_abyssPrivate(updateTitle, mountView);
    });
  }

  private toggleMonthPicker_abyssPrivate(
    anchor: HTMLElement,
    updateTitle: () => void,
    mountView: () => void,
  ): void {
    if (this.el.querySelector('.abyss-month-picker') != null) {
      this.clearCalendarPicker_abyssPrivate();
      return;
    }
    this.clearCalendarPicker_abyssPrivate();
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
      const selected = month === this.calDate_abyssPrivate.month();
      const button = picker.createEl('button', {
        cls: 'abyss-month-picker-btn',
        text: name,
        attr: { 'aria-pressed': String(selected) },
      });
      if (selected) button.addClass('is-active');
      button.addEventListener('click', () => {
        this.selectCalendarMonth_abyssPrivate(month, updateTitle, mountView);
      });
    });
    anchor.after(picker);
    this.armCalendarPicker_abyssPrivate(picker, anchor);
  }

  private selectCalendarMonth_abyssPrivate(
    month: number,
    updateTitle: () => void,
    mountView: () => void,
  ): void {
    this.cancelKeyboardInteraction_abyssPrivate();
    this.clearCalendarPicker_abyssPrivate(true);
    this.calDate_abyssPrivate = this.calDate_abyssPrivate.clone().month(month).date(1);
    updateTitle();
    mountView();
  }

  private toggleYearPicker_abyssPrivate(
    anchor: HTMLElement,
    updateTitle: () => void,
    mountView: () => void,
  ): void {
    if (this.el.querySelector('.abyss-year-picker') != null) {
      this.clearCalendarPicker_abyssPrivate();
      return;
    }
    this.clearCalendarPicker_abyssPrivate();
    const picker = this.el.createDiv({
      cls: 'abyss-year-picker abyss-popover',
      attr: { role: 'dialog', 'aria-modal': 'false', 'aria-label': 'Select year' },
    });
    const currentYear = this.calDate_abyssPrivate.year();
    for (let year = currentYear - 5; year <= currentYear + 5; year++) {
      this.renderYearPickerOption_abyssPrivate(picker, year, currentYear, [updateTitle, mountView]);
    }
    anchor.after(picker);
    this.armCalendarPicker_abyssPrivate(picker, anchor);
  }

  private renderYearPickerOption_abyssPrivate(
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
      this.cancelKeyboardInteraction_abyssPrivate();
      this.clearCalendarPicker_abyssPrivate(true);
      this.calDate_abyssPrivate = this.calDate_abyssPrivate.clone().year(year).date(1);
      callbacks[0]();
      callbacks[1]();
    });
  }

  private navigateCalendar_abyssPrivate(
    direction: -1 | 1,
    updateTitle: () => void,
    mountView: () => void,
  ): void {
    this.cancelKeyboardInteraction_abyssPrivate();
    const operation = direction === 1 ? 'add' : 'subtract';
    if (this.calViewType_abyssPrivate === 'week') {
      this.calDate_abyssPrivate = this.calDate_abyssPrivate
        .clone()
        [operation](7, 'days')
        .startOf('isoWeek');
    } else if (this.calViewType_abyssPrivate === 'today') {
      this.calDate_abyssPrivate = this.calDate_abyssPrivate.clone()[operation](1, 'day');
    } else {
      this.calDate_abyssPrivate = this.calDate_abyssPrivate.clone()[operation](1, 'months').date(1);
    }
    updateTitle();
    mountView();
  }

  private navigateCalendarToday_abyssPrivate(updateTitle: () => void, mountView: () => void): void {
    this.cancelKeyboardInteraction_abyssPrivate();
    if (this.calViewType_abyssPrivate === 'week')
      this.calDate_abyssPrivate = window.moment().startOf('isoWeek');
    else if (this.calViewType_abyssPrivate === 'today') this.calDate_abyssPrivate = window.moment();
    else this.calDate_abyssPrivate = window.moment().date(1);
    updateTitle();
    mountView();
  }

  private createCalendarNavigationHandlers_abyssPrivate(
    viewContainer: HTMLElement,
  ): Pick<
    CalendarHandlers,
    | 'onTaskClick'
    | 'onForecastClick'
    | 'onForecastContextMenu'
    | 'onDrop'
    | 'onDropTime'
    | 'onCreateAtTime'
    | 'onCreateAtDate'
    | 'onCreateAtDateAllDay'
  > {
    return {
      onTaskClick: (task) => {
        if (calendarRootTaskRef(task) !== undefined) this.taskModal_abyssPrivate?.open(task);
      },
      onForecastClick: (source, referenceDate) => {
        this.openForecastTask_abyssPrivate(source, referenceDate);
      },
      onForecastContextMenu: (source) => {
        this.openForecastRecurrenceEditor_abyssPrivate(viewContainer, source);
      },
      onDrop: (dragData, targetDate) => {
        runAsyncAction(this.rescheduleTask_abyssPrivate(dragData, targetDate));
      },
      onDropTime: (dragData, date, time) => {
        runAsyncAction(this.setTaskTimeFromDrop_abyssPrivate(dragData, date, time));
      },
      onCreateAtTime: (date, time) => {
        this.createCalendarTaskAtTime_abyssPrivate(viewContainer, date, time);
      },
      onCreateAtDate: (date) => {
        this.createCalendarTaskAtDate_abyssPrivate(viewContainer, date, false);
      },
      onCreateAtDateAllDay: (date) => {
        this.createCalendarTaskAtDate_abyssPrivate(viewContainer, date, true);
      },
    };
  }

  private createCalendarHandlers_abyssPrivate(viewContainer: HTMLElement): CalendarHandlers {
    return {
      ...this.createCalendarNavigationHandlers_abyssPrivate(viewContainer),
      onTimeChange: (task, minutes) => {
        this.runCalendarTaskAction_abyssPrivate(task, () =>
          this.updateTaskTime_abyssPrivate(task, minutes),
        );
      },
      onDurationChange: (task, minutes) => {
        this.runCalendarTaskAction_abyssPrivate(task, () =>
          this.updateTaskDuration_abyssPrivate(task, minutes),
        );
      },
      onTimedMove: (task, target) => {
        this.runCalendarTaskAction_abyssPrivate(task, () =>
          this.commitTimedMove_abyssPrivate(task, target),
        );
      },
      onTimedDuration: (task, target) => {
        this.runCalendarTaskAction_abyssPrivate(task, () =>
          this.commitTimedDuration_abyssPrivate(task, target),
        );
      },
      onTimedBoundary: (task, target) => {
        this.runCalendarTaskAction_abyssPrivate(task, () =>
          this.commitTimedBoundary_abyssPrivate(task, target),
        );
      },
      onSpanMove: (task, target) => {
        this.runCalendarTaskAction_abyssPrivate(task, () =>
          this.commitSpanMove_abyssPrivate(task, target),
        );
      },
      onSpanBoundary: (task, target) => {
        this.runCalendarTaskAction_abyssPrivate(task, () =>
          this.commitTimedBoundary_abyssPrivate(task, target),
        );
      },
      onStartChange: (task, start) => {
        this.runCalendarTaskAction_abyssPrivate(task, () =>
          this.updateTaskStart_abyssPrivate(task, start),
        );
      },
      onDueChange: (task, due) => {
        this.runCalendarTaskAction_abyssPrivate(task, () =>
          this.rescheduleTaskDue_abyssPrivate(task, due),
        );
      },
      onExtendToSpan: (task, due) => {
        this.runCalendarTaskAction_abyssPrivate(task, () =>
          this.extendTaskToSpan_abyssPrivate(task, due),
        );
      },
      onKeyboardIntent: (task, intent) => {
        this.handleCalendarKeyboardIntent_abyssPrivate(task, intent);
      },
      onToggle: (task) => {
        runAsyncAction(this.toggleTask_abyssPrivate(task));
      },
      onSetStatus: (task, status) => {
        runAsyncAction(this.setTaskStatus_abyssPrivate(task, status));
      },
      onSetPriority: (task, priority) => {
        runAsyncAction(this.setPriority_abyssPrivate(task, priority));
      },
    };
  }

  private openForecastTask_abyssPrivate(
    source: CalendarTaskSource,
    referenceDate: LocalDate,
  ): void {
    this.taskModal_abyssPrivate?.open(source.root);
    const modal = activeDocument.querySelector<HTMLElement>('.abyss-modal');
    if (modal == null) return;
    const context = modal.createDiv({
      cls: 'abyss-forecast-source-context',
      text: `Forecast for ${referenceDate}`,
    });
    modal.prepend(context);
  }

  private runCalendarTaskAction_abyssPrivate(
    task: TaskSnapshot,
    action: () => Promise<void>,
  ): void {
    if (isForecastCalendarTask(task)) return;
    runAsyncAction(action());
  }

  private createCalendarTaskAtTime_abyssPrivate(
    container: HTMLElement,
    date: string,
    time: string,
  ): void {
    const day = container.querySelector<HTMLElement>(
      `.abyss-tg-day-column[data-tg-date="${date}"]`,
    );
    const hourColumn = day?.querySelector<HTMLElement>('.abyss-tg-hour-column');
    if (hourColumn != null) this.showTimeGridQuickAdd_abyssPrivate(hourColumn, date, time);
  }

  private createCalendarTaskAtDate_abyssPrivate(
    container: HTMLElement,
    date: string,
    allDay: boolean,
  ): void {
    const selector = allDay
      ? `.abyss-tg-allday-cell[data-tg-date="${date}"]`
      : `[data-mg-date="${date}"]`;
    const cell = container.querySelector<HTMLElement>(selector);
    if (cell == null) return;
    this.showFillCellQuickAdd_abyssPrivate(
      cell,
      date,
      allDay ? 'abyss-tg-allday-quick-add' : 'abyss-mg-quick-add',
    );
  }

  private handleCalendarKeyboardIntent_abyssPrivate(
    task: TaskSnapshot,
    intent: TimedBlockKeyboardIntent,
  ): void {
    if (calendarRootTaskRef(task) === undefined || this.keyboardQueue_abyssPrivate == null) return;
    const active = this.el.ownerDocument.activeElement;
    const originElement = isRealmHTMLElement(active)
      ? (active.closest<HTMLElement>('.abyss-tg-block') ?? undefined)
      : undefined;
    const previousQueueSequence = this.pendingTimedBlockFocus_abyssPrivate?.queueSequence;
    const provisionalFocus = this.provisionalTimedBlockFocus_abyssPrivate(task, originElement);
    this.pendingTimedBlockFocus_abyssPrivate = provisionalFocus;
    const queueSequence = this.keyboardQueue_abyssPrivate.enqueue(task, intent);
    if (queueSequence === undefined) {
      this.handleRejectedKeyboardIntent_abyssPrivate(
        provisionalFocus.sequence,
        previousQueueSequence,
      );
      return;
    }
    this.acceptKeyboardIntent_abyssPrivate(provisionalFocus, queueSequence, previousQueueSequence);
  }

  private provisionalTimedBlockFocus_abyssPrivate(
    task: TaskSnapshot,
    originElement: HTMLElement | undefined,
  ): TimedBlockFocusLocator {
    const segmentDate = originElement?.dataset['tgSegmentDate'];
    return {
      filePath: task.source.filePath,
      line: task.source.line,
      ...(segmentDate !== undefined && { segmentDate }),
      sequence: ++this.nextTimedBlockFocusSequence_abyssPrivate,
      ...(originElement !== undefined && { originElement }),
    };
  }

  private handleRejectedKeyboardIntent_abyssPrivate(
    focusSequence: number,
    previousQueueSequence: number | undefined,
  ): void {
    if (this.pendingTimedBlockFocus_abyssPrivate?.sequence === focusSequence)
      this.clearTimedBlockFocus_abyssPrivate();
    if (previousQueueSequence !== undefined)
      this.clearKeyboardSequenceState_abyssPrivate(previousQueueSequence);
  }

  private acceptKeyboardIntent_abyssPrivate(
    provisionalFocus: TimedBlockFocusLocator,
    queueSequence: number,
    previousQueueSequence: number | undefined,
  ): void {
    if (this.pendingTimedBlockFocus_abyssPrivate?.sequence !== provisionalFocus.sequence) return;
    if (previousQueueSequence !== undefined && previousQueueSequence !== queueSequence) {
      this.clearKeyboardSequenceState_abyssPrivate(previousQueueSequence);
    }
    this.settledKeyboardSequences_abyssPrivate.delete(queueSequence);
    if (previousQueueSequence !== queueSequence) {
      this.restoredKeyboardSequences_abyssPrivate.delete(queueSequence);
      this.committedKeyboardSequences_abyssPrivate.delete(queueSequence);
    }
    this.pendingTimedBlockFocus_abyssPrivate = { ...provisionalFocus, queueSequence };
  }

  private cancelKeyboardInteraction_abyssPrivate(): void {
    this.keyboardQueue_abyssPrivate?.cancel();
    this.pendingTimedBlockFocus_abyssPrivate = undefined;
    this.settledKeyboardSequences_abyssPrivate.clear();
    this.restoredKeyboardSequences_abyssPrivate.clear();
    this.committedKeyboardSequences_abyssPrivate.clear();
    this.pendingTimedBlockRestorations_abyssPrivate.clear();
    this.calendarRenderGeneration_abyssPrivate += 1;
  }

  private captureActiveTimedBlockFocus_abyssPrivate(): void {
    if (this.pendingTimedBlockFocus_abyssPrivate?.queueSequence !== undefined) return;
    const active = this.el.ownerDocument.activeElement;
    if (!isRealmHTMLElement(active) || !this.el.contains(active)) return;
    const block = active.closest<HTMLElement>('.abyss-tg-block');
    if (block == null) return;
    this.retainTimedBlockFocus_abyssPrivate(block);
  }

  private retainTimedBlockFocus_abyssPrivate(block: HTMLElement): void {
    const filePath = block.dataset['abyssTaskFile'];
    const lineText = block.dataset['abyssTaskLine'];
    if (filePath === undefined || lineText === undefined) return;
    const line = Number(lineText);
    if (!Number.isInteger(line)) return;
    const segmentDate = block.dataset['tgSegmentDate'];

    const pending = this.pendingTimedBlockFocus_abyssPrivate;
    if (this.isDifferentPreCommitOrigin_abyssPrivate(block, pending)) {
      this.replacePreCommitFocus_abyssPrivate(block, pending.queueSequence, {
        filePath,
        line,
        ...(segmentDate !== undefined && { segmentDate }),
      });
      return;
    }
    if (this.sameTimedBlockFocus_abyssPrivate(pending, filePath, line, segmentDate)) return;
    if (pending?.queueSequence !== undefined) {
      this.keyboardQueue_abyssPrivate?.cancel();
      this.clearKeyboardSequenceState_abyssPrivate(pending.queueSequence);
    }
    this.pendingTimedBlockFocus_abyssPrivate = this.createTimedBlockFocus_abyssPrivate(
      block,
      filePath,
      line,
      segmentDate,
    );
  }

  private isDifferentPreCommitOrigin_abyssPrivate(
    block: HTMLElement,
    pending: TimedBlockFocusLocator | undefined,
  ): pending is TimedBlockFocusLocator & { readonly queueSequence: number } {
    return (
      pending?.queueSequence !== undefined &&
      !this.committedKeyboardSequences_abyssPrivate.has(pending.queueSequence) &&
      pending.originElement !== undefined &&
      block !== pending.originElement
    );
  }

  private replacePreCommitFocus_abyssPrivate(
    block: HTMLElement,
    queueSequence: number,
    locator: Pick<TimedBlockFocusLocator, 'filePath' | 'line' | 'segmentDate'>,
  ): void {
    this.keyboardQueue_abyssPrivate?.cancel();
    this.clearTimedBlockFocus_abyssPrivate(queueSequence);
    this.pendingTimedBlockFocus_abyssPrivate = this.createTimedBlockFocus_abyssPrivate(
      block,
      locator.filePath,
      locator.line,
      locator.segmentDate,
    );
  }

  private sameTimedBlockFocus_abyssPrivate(
    pending: TimedBlockFocusLocator | undefined,
    filePath: string,
    line: number,
    segmentDate: string | undefined,
  ): boolean {
    return (
      pending?.filePath === filePath && pending.line === line && pending.segmentDate === segmentDate
    );
  }

  private createTimedBlockFocus_abyssPrivate(
    block: HTMLElement,
    filePath: string,
    line: number,
    segmentDate: string | undefined,
  ): TimedBlockFocusLocator {
    return {
      filePath,
      line,
      ...(segmentDate !== undefined && { segmentDate }),
      sequence: ++this.nextTimedBlockFocusSequence_abyssPrivate,
      originElement: block,
    };
  }

  private deferTimedBlockFocus_abyssPrivate(
    container: HTMLElement,
    renderGeneration: number,
  ): void {
    const scheduled = this.pendingTimedBlockFocus_abyssPrivate;
    if (scheduled == null) return;
    const focusSequence = scheduled.sequence;
    const queueSequence = scheduled.queueSequence;
    if (
      queueSequence !== undefined &&
      !this.committedKeyboardSequences_abyssPrivate.has(queueSequence)
    )
      return;

    const scheduledCandidate = this.findTimedBlock_abyssPrivate(container, scheduled);
    if (queueSequence !== undefined && scheduledCandidate === scheduled.originElement) return;
    const restorationId = this.reserveTimedBlockRestoration_abyssPrivate(
      scheduledCandidate,
      scheduled,
      renderGeneration,
    );

    window.setTimeout(() => {
      this.restoreDeferredTimedBlockFocus_abyssPrivate(container, {
        focusSequence,
        renderGeneration,
        ...(restorationId !== undefined && { restorationId }),
      });
    }, 0);
  }

  private reserveTimedBlockRestoration_abyssPrivate(
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
    const restorationId = ++this.nextTimedBlockRestoration_abyssPrivate;
    this.pendingTimedBlockRestorations_abyssPrivate.set(restorationId, {
      queueSequence,
      focusSequence: scheduled.sequence,
      renderGeneration,
    });
    return restorationId;
  }

  private findTimedBlock_abyssPrivate(
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

  private restoreDeferredTimedBlockFocus_abyssPrivate(
    container: HTMLElement,
    options: {
      readonly focusSequence: number;
      readonly renderGeneration: number;
      readonly restorationId?: number;
    },
  ): void {
    if (!this.canRunTimedBlockRestoration_abyssPrivate(options)) return;
    const pending = this.pendingTimedBlockFocus_abyssPrivate;
    if (!this.isPendingTimedBlockRestorable_abyssPrivate(pending, options.focusSequence)) return;
    const candidate = this.findTimedBlock_abyssPrivate(container, pending);
    if (!this.isRestorableTimedBlock_abyssPrivate(candidate)) return;
    candidate.focus();
    candidate.classList.add('is-selected');
    if (!this.didRestoreTimedBlock_abyssPrivate(candidate, pending.sequence)) return;
    this.finishTimedBlockRestoration_abyssPrivate(pending.queueSequence);
  }

  private canRunTimedBlockRestoration_abyssPrivate(options: {
    readonly renderGeneration: number;
    readonly restorationId?: number;
  }): boolean {
    if (
      options.restorationId !== undefined &&
      !this.pendingTimedBlockRestorations_abyssPrivate.delete(options.restorationId)
    ) {
      return false;
    }
    return options.renderGeneration === this.calendarRenderGeneration_abyssPrivate;
  }

  private isPendingTimedBlockRestorable_abyssPrivate(
    pending: TimedBlockFocusLocator | undefined,
    focusSequence: number,
  ): pending is TimedBlockFocusLocator {
    if (pending?.sequence !== focusSequence || this.state_abyssPrivate.get('mode') !== 'calendar')
      return false;
    return (
      pending.queueSequence === undefined ||
      this.committedKeyboardSequences_abyssPrivate.has(pending.queueSequence)
    );
  }

  private isRestorableTimedBlock_abyssPrivate(
    candidate: HTMLElement | undefined,
  ): candidate is HTMLElement {
    return (
      candidate !== undefined &&
      candidate.isConnected &&
      isRealmHTMLElement(candidate) &&
      candidate.ownerDocument === this.el.ownerDocument
    );
  }

  private didRestoreTimedBlock_abyssPrivate(candidate: HTMLElement, sequence: number): boolean {
    return (
      candidate.ownerDocument.activeElement === candidate &&
      this.pendingTimedBlockFocus_abyssPrivate?.sequence === sequence
    );
  }

  private finishTimedBlockRestoration_abyssPrivate(queueSequence: number | undefined): void {
    if (queueSequence === undefined) {
      this.clearTimedBlockFocus_abyssPrivate();
      return;
    }
    this.restoredKeyboardSequences_abyssPrivate.add(queueSequence);
    if (this.settledKeyboardSequences_abyssPrivate.has(queueSequence))
      this.clearTimedBlockFocus_abyssPrivate(queueSequence);
  }

  private clearTimedBlockFocus_abyssPrivate(queueSequence?: number): void {
    const pending = this.pendingTimedBlockFocus_abyssPrivate;
    if (queueSequence !== undefined && pending?.queueSequence !== queueSequence) return;
    const ownedSequence = pending?.queueSequence ?? queueSequence;
    if (ownedSequence !== undefined) {
      this.clearKeyboardSequenceState_abyssPrivate(ownedSequence);
    }
    this.pendingTimedBlockFocus_abyssPrivate = undefined;
  }

  private hasPendingTimedBlockRestoration_abyssPrivate(queueSequence: number): boolean {
    const pending = this.pendingTimedBlockFocus_abyssPrivate;
    if (pending?.queueSequence !== queueSequence) return false;
    return Array.from(this.pendingTimedBlockRestorations_abyssPrivate.values()).some(
      (restoration) =>
        restoration.queueSequence === queueSequence &&
        restoration.focusSequence === pending.sequence &&
        restoration.renderGeneration === this.calendarRenderGeneration_abyssPrivate,
    );
  }

  private clearKeyboardSequenceState_abyssPrivate(queueSequence: number): void {
    this.settledKeyboardSequences_abyssPrivate.delete(queueSequence);
    this.restoredKeyboardSequences_abyssPrivate.delete(queueSequence);
    this.committedKeyboardSequences_abyssPrivate.delete(queueSequence);
    for (const [id, restoration] of this.pendingTimedBlockRestorations_abyssPrivate) {
      if (restoration.queueSequence === queueSequence) {
        this.pendingTimedBlockRestorations_abyssPrivate.delete(id);
      }
    }
  }

  private handleKeyboardCommit_abyssPrivate(
    updated: TaskSnapshot,
    intent: TimedBlockKeyboardIntent,
    queueSequence: number,
    changed: boolean,
  ): void {
    const pending = this.pendingTimedBlockFocus_abyssPrivate;
    if (!this.acceptsKeyboardCommit_abyssPrivate(pending, queueSequence)) return;
    this.committedKeyboardSequences_abyssPrivate.add(queueSequence);
    const sourceChanged =
      pending.filePath !== updated.source.filePath || pending.line !== updated.source.line;
    const nextSegmentDate = this.shiftFocusedSegmentDate_abyssPrivate(pending, intent, changed);
    const segmentChanged = nextSegmentDate !== pending.segmentDate;
    const identityChanged = [sourceChanged, segmentChanged].includes(true);
    const presentationChanged = [changed, identityChanged].includes(true);
    if (presentationChanged) this.restoredKeyboardSequences_abyssPrivate.delete(queueSequence);
    if (identityChanged) {
      this.pendingTimedBlockFocus_abyssPrivate = {
        ...pending,
        filePath: updated.source.filePath,
        line: updated.source.line,
        ...(nextSegmentDate !== undefined && { segmentDate: nextSegmentDate }),
        sequence: ++this.nextTimedBlockFocusSequence_abyssPrivate,
      };
    }
    if (presentationChanged || !this.restoredKeyboardSequences_abyssPrivate.has(queueSequence)) {
      this.deferTimedBlockFocus_abyssPrivate(this.el, this.calendarRenderGeneration_abyssPrivate);
    }
    if (intent.type === 'shift-schedule')
      this.followShiftedTask_abyssPrivate(updated, nextSegmentDate);
  }

  private acceptsKeyboardCommit_abyssPrivate(
    pending: TimedBlockFocusLocator | undefined,
    queueSequence: number,
  ): pending is TimedBlockFocusLocator {
    return (
      pending?.queueSequence === queueSequence && this.state_abyssPrivate.get('mode') === 'calendar'
    );
  }

  private shiftFocusedSegmentDate_abyssPrivate(
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

  private followShiftedTask_abyssPrivate(
    updated: TaskSnapshot,
    nextSegmentDate: string | undefined,
  ): void {
    const anchor =
      updated.planning.start != null && updated.planning.due != null
        ? updated.planning.due
        : (updated.planning.scheduled ?? updated.planning.due);
    const followDate = nextSegmentDate ?? anchor;
    if (followDate === undefined || followDate === '') return;
    const firstDayOfWeek = this.settings_abyssPrivate.desktop.firstDayOfWeek;
    const outsideWeek = !visibleCalendarDates(
      'week',
      this.calDate_abyssPrivate,
      firstDayOfWeek,
    ).includes(followDate);
    if (
      this.calViewType_abyssPrivate !== 'today' &&
      (this.calViewType_abyssPrivate !== 'week' || !outsideWeek)
    )
      return;
    this.calDate_abyssPrivate = window.moment(followDate);
    this.render_abyssPrivate();
  }

  private renderSearch_abyssPrivate(): void {
    const header = this.el.createDiv({ cls: 'abyss-center-header' });
    header.createEl('h2', { cls: 'abyss-center-title', text: 'Search' });
    const input = header.createEl('input', {
      cls: 'abyss-center-search abyss-search-global',
      attr: { type: 'text', placeholder: 'Search all tasks…', 'aria-label': 'Search all tasks' },
    });
    input.value = this.state_abyssPrivate.get('searchQuery');
    input.addEventListener('input', () => {
      this.state_abyssPrivate.set('searchQuery', input.value);
    });
    input.addEventListener('keydown', (event) => {
      if (isImeOwnedEvent(event) || event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (this.el.isConnected) this.el.focus({ preventScroll: true });
    });
    this.searchInputEl_abyssPrivate = input;

    const results = this.el.createDiv({ cls: 'abyss-center-scroll' });
    this.searchResultsEl_abyssPrivate = results;
    this.renderSearchResults_abyssPrivate(results, input.value);

    window.setTimeout(() => {
      if (this.searchInputEl_abyssPrivate === input && input.isConnected) input.focus();
    }, 0);
  }

  private handleSearchQueryChanged_abyssPrivate(query: string): void {
    const input = this.searchInputEl_abyssPrivate;
    const results = this.searchResultsEl_abyssPrivate;
    if (
      this.state_abyssPrivate.get('mode') !== 'search' ||
      input === null ||
      !input.isConnected ||
      results?.isConnected !== true
    ) {
      return;
    }
    if (input.value !== query) input.value = query;
    this.scheduleSearchResults_abyssPrivate(query);
  }

  private scheduleSearchResults_abyssPrivate(query: string): void {
    if (this.searchResultsFrame_abyssPrivate !== null) {
      window.cancelAnimationFrame(this.searchResultsFrame_abyssPrivate);
    }
    this.searchResultsFrame_abyssPrivate = window.requestAnimationFrame(() => {
      this.searchResultsFrame_abyssPrivate = null;
      const input = this.searchInputEl_abyssPrivate;
      const results = this.searchResultsEl_abyssPrivate;
      if (
        this.state_abyssPrivate.get('mode') !== 'search' ||
        input === null ||
        !input.isConnected ||
        results?.isConnected !== true
      ) {
        return;
      }
      this.renderSearchResults_abyssPrivate(results, query);
    });
  }

  private clearSearchShell_abyssPrivate(): void {
    if (this.searchResultsFrame_abyssPrivate !== null) {
      window.cancelAnimationFrame(this.searchResultsFrame_abyssPrivate);
      this.searchResultsFrame_abyssPrivate = null;
    }
    this.searchInputEl_abyssPrivate = null;
    this.searchResultsEl_abyssPrivate = null;
  }

  private renderSearchResults_abyssPrivate(host: HTMLElement, query: string): void {
    this.md_abyssPrivate.unload();
    this.md_abyssPrivate = new Component();
    this.md_abyssPrivate.load();
    host.empty();
    host.toggleClass('abyss-search-empty', query.length === 0);

    if (query.length === 0) {
      host.createEl('p', { cls: 'abyss-empty-state', text: 'Type to search tasks…' });
      this.completeTaskCardRender_abyssPrivate();
      return;
    }

    const matchingTasks = [...searchTaskList(this.queries_abyssPrivate.list(), query)];
    if (matchingTasks.length === 0) {
      host.createDiv({ cls: 'abyss-center-empty', text: 'No results' });
      this.completeTaskCardRender_abyssPrivate();
      return;
    }
    this.renderFlat_abyssPrivate(host, matchingTasks);

    // Navigate to task in tasks mode when clicking a search result
    host.querySelectorAll<HTMLElement>('.abyss-task-card').forEach((cardEl, idx) => {
      const task = matchingTasks[idx];
      if (task == null) return;
      cardEl.addEventListener(
        'click',
        (e) => {
          const statusControl = cardEl.querySelector('.abyss-status-control, .abyss-status-marker');
          if (statusControl?.contains(e.target as Node) === true) return;
          e.stopPropagation();
          const todayStr = localDate(window.moment().format('YYYY-MM-DD'));
          const d = task.planning.due ?? task.planning.scheduled;
          let list: 'inbox' | 'today' | 'upcoming' = 'inbox';
          if ((task.planning.due != null && task.planning.due < todayStr) || d === todayStr) {
            list = 'today';
          } else if (d != null && d > todayStr) {
            list = 'upcoming';
          }
          this.navigation_abyssPrivate.openList(list);
          this.state_abyssPrivate.set('taskStack', [task]);
        },
        { capture: true },
      );
    });
    this.completeTaskCardRender_abyssPrivate();
  }

  private renderWithGrouping_abyssPrivate(container: HTMLElement, tasks: TaskSnapshot[]): void {
    const vs = this.state_abyssPrivate.get('centerListViewState');
    const today = localDate(window.moment().format('YYYY-MM-DD'));
    const tomorrow = window.moment().add(1, 'day').format('YYYY-MM-DD');

    if (vs.groupBy === 'none') {
      this.renderFlat_abyssPrivate(container, tasks);
      return;
    }

    const groups = this.groupTasks_abyssPrivate(tasks, vs.groupBy, today, tomorrow);

    let firstGroup = true;
    for (const group of groups) {
      if (group.tasks.length === 0) continue;
      const cls = firstGroup
        ? 'abyss-group-header abyss-group-header--first'
        : 'abyss-group-header';
      container.createDiv({ cls, text: `${group.label}  ${group.tasks.length}` });
      firstGroup = false;
      for (const task of group.tasks) this.renderTaskCard_abyssPrivate(container, task);
    }
  }

  private groupTasks_abyssPrivate(
    tasks: TaskSnapshot[],
    groupBy: ListViewState['groupBy'],
    today: LocalDate,
    tomorrow: string,
  ): Array<{ label: string; tasks: TaskSnapshot[] }> {
    if (groupBy === 'date') return groupTasksByDate(tasks, today, tomorrow);
    if (groupBy === 'priority') return groupTasksByPriority(tasks);
    if (groupBy === 'status') return groupTasksByStatus(tasks, this.statusRegistry_abyssPrivate);
    return groupTasksByTag(tasks);
  }

  private renderFlat_abyssPrivate(container: HTMLElement, tasks: TaskSnapshot[]): void {
    for (const task of tasks) this.renderTaskCard_abyssPrivate(container, task);
  }

  private renderTaskCard_abyssPrivate(container: HTMLElement, task: TaskSnapshot): void {
    const isSelected = this.isTaskCardSelected_abyssPrivate(task);
    const card = container.createDiv({
      cls: `abyss-task-card${isSelected ? ' is-selected' : ''}`,
      attr: { tabindex: '-1' },
    });
    applyTaskPresentationIdentity(card, task.ref);
    card.dataset['filePath'] = task.source.filePath;
    card.dataset['line'] = String(task.source.line);

    const mainRow = card.createDiv({ cls: 'abyss-task-card-main-row' });
    this.renderTaskStatus_abyssPrivate(mainRow, task);
    this.renderTaskCardBody_abyssPrivate(mainRow, card, task);
    this.renderTaskCardMetadata_abyssPrivate(mainRow, task);
    this.mountTaskCardInteractions_abyssPrivate(card, task);
    this.syncTaskDeleteButton_abyssPrivate(
      card,
      isSelected && this.selectedTaskKeys_abyssPrivate.size === 0 ? task : undefined,
    );
  }

  private isTaskCardSelected_abyssPrivate(task: TaskSnapshot): boolean {
    const stack = this.state_abyssPrivate.get('taskStack');
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

  private renderTaskStatus_abyssPrivate(mainRow: HTMLElement, task: TaskSnapshot): void {
    const projection = this.dependenciesFor_abyssPrivate(task);
    renderStatusMarker(mainRow, {
      task,
      registry: this.statusRegistry_abyssPrivate,
      completionBlocked: dependencyCompletionBlocked(projection),
      onLeftClick: () => {
        runAsyncAction(this.toggleTask_abyssPrivate(task));
      },
      onContextMenu: (event) => {
        event.stopPropagation();
        this.openStatusMenu_abyssPrivate(event, task);
      },
    });
    renderDependencyIndicator(mainRow, projection);
  }

  private readonly dependenciesFor_abyssPrivate: TaskDependencyLookup = (task) => {
    const target = calendarMutationTarget(task);
    return target === undefined ? undefined : this.tasks_abyssPrivate?.queries.dependencies(target);
  };

  private renderTaskCardBody_abyssPrivate(
    mainRow: HTMLElement,
    card: HTMLElement,
    task: TaskSnapshot,
  ): void {
    const body = mainRow.createDiv({ cls: 'abyss-task-body' });
    const titleRow = body.createDiv({ cls: 'abyss-task-title-row' });
    const recurrence = task.recurrence;
    if (recurrence !== undefined && recurrence !== '') {
      renderRecurrenceBadge(titleRow, recurrenceBadgeInput(recurrence));
    }
    this.renderTaskCountBadges_abyssPrivate(titleRow, task);
    const titleEl = titleRow.createSpan({ cls: 'abyss-task-title' });
    renderTaskText(titleEl, task.markdownTitle, {
      app: this.app_abyssPrivate,
      sourcePath: task.source.filePath,
      component: this.md_abyssPrivate,
      onEditLink: (occurrence, token) => {
        this.editTaskLink_abyssPrivate(task, occurrence, token);
      },
    });
    this.renderTaskDescription_abyssPrivate(card, task);
  }

  private renderTaskCountBadges_abyssPrivate(titleRow: HTMLElement, task: TaskSnapshot): void {
    const subtaskCount = task.subtasks.length;
    if (subtaskCount > 0) {
      const doneCount = task.subtasks.filter((subtask) => subtask.status === 'done').length;
      this.renderTaskCountBadge_abyssPrivate(
        titleRow,
        'check-square',
        `${doneCount}/${subtaskCount}`,
      );
    }
    if (task.comments.length > 0) {
      this.renderTaskCountBadge_abyssPrivate(
        titleRow,
        'message-square',
        String(task.comments.length),
      );
    }
    if (task.presentation.linkCount > 0) {
      this.renderTaskCountBadge_abyssPrivate(
        titleRow,
        'paperclip',
        String(task.presentation.linkCount),
      );
    }
  }

  private renderTaskCountBadge_abyssPrivate(host: HTMLElement, icon: string, text: string): void {
    const badge = host.createSpan({ cls: 'abyss-task-count-badge' });
    setIcon(badge, icon);
    badge.createSpan({ text });
  }

  private renderTaskDescription_abyssPrivate(card: HTMLElement, task: TaskSnapshot): void {
    const description = task.description;
    if (description === undefined || description === '') return;
    const descriptionElement = card.createDiv({ cls: 'abyss-task-desc' });
    renderTaskText(descriptionElement, description.split('\n')[0] ?? '', {
      app: this.app_abyssPrivate,
      sourcePath: task.source.filePath,
      component: this.md_abyssPrivate,
    });
  }

  private renderTaskCardMetadata_abyssPrivate(mainRow: HTMLElement, task: TaskSnapshot): void {
    const today = localDate(window.moment().format('YYYY-MM-DD'));
    const sel = this.state_abyssPrivate.get('selectedList');
    const d = task.planning.due ?? task.planning.scheduled;
    const tags = task.tags;
    const suppressToday = sel === 'today' && d === today;
    const showSourceNote = shouldShowSourceNote(
      task,
      this.settings_abyssPrivate.sourceNoteDisplay,
      this.settings_abyssPrivate.customFilePath,
    );
    const hasRightMeta =
      showSourceNote ||
      (d != null && !suppressToday) ||
      task.planning.time != null ||
      tags.length > 0;
    if (!hasRightMeta) return;
    const metaRight = mainRow.createDiv({ cls: 'abyss-task-meta-right' });
    this.renderTaskDateMetadata_abyssPrivate(metaRight, task, d, suppressToday);
    if (showSourceNote) {
      renderSourceNoteChip(metaRight, task, (filePath) => {
        this.addPropertyFilter_abyssPrivate({ type: 'file', filePath });
      });
    }
    for (const tag of tags.slice(0, 2))
      this.renderTaskTagMetadata_abyssPrivate(metaRight, task, tag);
  }

  private renderTaskDateMetadata_abyssPrivate(
    host: HTMLElement,
    task: TaskSnapshot,
    date: LocalDate | undefined,
    suppressToday: boolean,
  ): void {
    const time = task.planning.time;
    if (date != null && !suppressToday) {
      const dateElement = host.createSpan({
        cls: `abyss-task-date ${this.getDateClass_abyssPrivate(date)}`.trim(),
      });
      this.renderDateFilterPart_abyssPrivate(dateElement, date);
      if (time != null)
        this.renderTimeFilterPart_abyssPrivate(dateElement, time, 'abyss-task-time-part');
      return;
    }
    if (date == null && time != null)
      this.renderTimeFilterPart_abyssPrivate(host, time, 'abyss-task-date');
  }

  private renderDateFilterPart_abyssPrivate(host: HTMLElement, date: LocalDate): void {
    const part = host.createSpan({ cls: 'abyss-task-date-part abyss-cursor-pointer' });
    const icon = part.createSpan({ cls: 'abyss-date-icon' });
    setIcon(icon, 'calendar');
    part.createSpan({ text: this.formatDate_abyssPrivate(date) });
    part.addEventListener('click', (event) => {
      event.stopPropagation();
      this.addPropertyFilter_abyssPrivate({ type: 'date', value: date });
    });
  }

  private renderTimeFilterPart_abyssPrivate(
    host: HTMLElement,
    time: string,
    className: string,
  ): void {
    const part = host.createSpan({ cls: `${className} abyss-cursor-pointer` });
    const icon = part.createSpan({ cls: 'abyss-date-icon' });
    setIcon(icon, 'clock');
    part.createSpan({ text: time });
    part.addEventListener('click', (event) => {
      event.stopPropagation();
      this.addPropertyFilter_abyssPrivate({ type: 'time', value: time });
    });
  }

  private renderTaskTagMetadata_abyssPrivate(
    host: HTMLElement,
    task: TaskSnapshot,
    tag: string,
  ): void {
    const element = host.createSpan({ cls: 'abyss-task-tag abyss-cursor-pointer', text: tag });
    const color = this.getTagColor_abyssPrivate(tag);
    if (color !== undefined && color !== '') {
      element.setCssProps({ '--abyss-tag-color': color });
      element.addClass('abyss-task-tag--colored');
    }
    element.addEventListener('click', (event) => {
      event.stopPropagation();
      this.addPropertyFilter_abyssPrivate({ type: 'tag', value: tag });
    });
    element.addEventListener('dragover', (event) => {
      const dragging = this.state_abyssPrivate.get('draggingTag');
      if (dragging === null || dragging === '' || dragging === tag) return;
      event.preventDefault();
      event.stopPropagation();
      element.classList.add('abyss-drop-target');
    });
    element.addEventListener('dragleave', () => {
      element.classList.remove('abyss-drop-target');
    });
    element.addEventListener('drop', (event) => {
      this.handleTaskTagDrop_abyssPrivate(event, element, task, tag);
    });
  }

  private handleTaskTagDrop_abyssPrivate(
    event: DragEvent,
    element: HTMLElement,
    task: TaskSnapshot,
    replacedTag: string,
  ): void {
    event.preventDefault();
    event.stopPropagation();
    element.classList.remove('abyss-drop-target');
    const dragging = this.state_abyssPrivate.get('draggingTag');
    if (dragging === null || dragging === '' || dragging === replacedTag) return;
    runAsyncAction(this.patchTaskTags_abyssPrivate(task, [dragging], [replacedTag]));
  }

  private mountTaskCardInteractions_abyssPrivate(card: HTMLElement, task: TaskSnapshot): void {
    card.addEventListener('click', (event) => {
      this.handleTaskCardClick_abyssPrivate(event, task);
    });
    this.mountTaskCardDrag_abyssPrivate(card, task);
    card.addEventListener('contextmenu', (event) => {
      this.handleTaskContextMenu_abyssPrivate(event, card, task);
    });
  }

  private syncTaskDeleteButton_abyssPrivate(
    card: HTMLElement,
    task: TaskSnapshot | undefined,
  ): void {
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
      runAsyncAction(this.deleteTask_abyssPrivate(task));
    });
  }

  private handleTaskCardClick_abyssPrivate(event: MouseEvent, task: TaskSnapshot): void {
    const key = this.taskKey_abyssPrivate(task);
    if (event.ctrlKey || event.metaKey) {
      if (this.selectedTaskKeys_abyssPrivate.has(key))
        this.selectedTaskKeys_abyssPrivate.delete(key);
      else this.selectedTaskKeys_abyssPrivate.add(key);
      this.selectionAnchorKey_abyssPrivate = key;
      this.selectionFocusKey_abyssPrivate = key;
      this.updateSelectionVisuals_abyssPrivate();
      this.focusTaskKey_abyssPrivate(key);
      return;
    }
    if (event.shiftKey) {
      const keys = this.visibleTaskKeys_abyssPrivate();
      const anchor =
        this.selectionAnchorKey_abyssPrivate !== null &&
        keys.includes(this.selectionAnchorKey_abyssPrivate)
          ? this.selectionAnchorKey_abyssPrivate
          : key;
      this.selectionAnchorKey_abyssPrivate = anchor;
      this.selectionFocusKey_abyssPrivate = key;
      this.replaceRangeSelection_abyssPrivate(anchor, key, keys);
      this.focusTaskKey_abyssPrivate(key);
      return;
    }
    this.selectedTaskKeys_abyssPrivate.clear();
    this.selectionAnchorKey_abyssPrivate = key;
    this.selectionFocusKey_abyssPrivate = key;
    this.updateSelectionVisuals_abyssPrivate();
    this.focusTaskKey_abyssPrivate(key);
    this.state_abyssPrivate.set('taskStack', [task]);
  }

  private mountTaskCardDrag_abyssPrivate(card: HTMLElement, task: TaskSnapshot): void {
    if (isForecastCalendarTask(task)) return;
    card.setAttribute('draggable', 'true');
    card.addEventListener('dragstart', () => {
      this.endTaskDrag_abyssPrivate?.();
      card.classList.add('abyss-dragging');
      this.endTaskDrag_abyssPrivate = startTaskNodeDrag(this.state_abyssPrivate, this.el, card, {
        payload: {
          source: 'center-card',
          task: { root: task, path: [], node: task, target: { type: 'task', ref: task.ref } },
        },
        onEnd: () => {
          card.classList.remove('abyss-dragging');
        },
      });
    });
    card.addEventListener('dragover', (event) => {
      const draggingTag = this.state_abyssPrivate.get('draggingTag');
      if (
        (draggingTag === null || draggingTag === '') &&
        !this.canDropProjectOnTask_abyssPrivate(task)
      )
        return;
      event.preventDefault();
      card.classList.add('abyss-drop-target');
    });
    card.addEventListener('dragleave', () => {
      card.classList.remove('abyss-drop-target');
    });
    card.addEventListener('drop', (event) => {
      this.handleTaskCardDrop_abyssPrivate(event, card, task);
    });
  }

  private canDropProjectOnTask_abyssPrivate(task: TaskSnapshot): boolean {
    const project = this.state_abyssPrivate.get('draggingProject');
    return (
      project !== null &&
      project !== '' &&
      project !== task.source.filePath &&
      this.projectManager_abyssPrivate != null &&
      this.tasks_abyssPrivate != null
    );
  }

  private handleTaskCardDrop_abyssPrivate(
    event: DragEvent,
    card: HTMLElement,
    task: TaskSnapshot,
  ): void {
    card.classList.remove('abyss-drop-target');
    const tag = this.state_abyssPrivate.get('draggingTag');
    if (tag !== null && tag !== '') {
      event.preventDefault();
      runAsyncAction(this.assignTagFromInbox_abyssPrivate(task, tag));
      return;
    }
    const project = this.state_abyssPrivate.get('draggingProject');
    if (
      !this.canDropProjectOnTask_abyssPrivate(task) ||
      project === null ||
      this.tasks_abyssPrivate == null ||
      this.projectManager_abyssPrivate == null
    )
      return;
    event.preventDefault();
    runAsyncAction(
      moveTaskToProjectWithRecovery(
        this.app_abyssPrivate,
        this.tasks_abyssPrivate,
        this.projectManager_abyssPrivate,
        task.ref,
        project,
      ),
    );
  }

  private handleTaskContextMenu_abyssPrivate(
    event: MouseEvent,
    card: HTMLElement,
    task: TaskSnapshot,
  ): void {
    event.preventDefault();
    const key = this.taskKey_abyssPrivate(task);
    if (this.selectedTaskKeys_abyssPrivate.size > 0 && !this.selectedTaskKeys_abyssPrivate.has(key))
      this.clearTaskSelection_abyssPrivate();
    if (this.selectedTaskKeys_abyssPrivate.size >= 2) {
      this.showBulkContextMenu_abyssPrivate(event, card);
      return;
    }
    const menu = this.createTaskContextMenu_abyssPrivate(card, task);
    showMenuAtMouseEventWithFocus(menu, event);
  }

  private createTaskContextMenu_abyssPrivate(card: HTMLElement, task: TaskSnapshot): Menu {
    const today = localDate(window.moment().format('YYYY-MM-DD'));
    const menu = new Menu();
    this.addTaskDateMenuItems_abyssPrivate(menu, card, task, today);
    this.addTaskTagMenuItems_abyssPrivate(menu, task);
    this.addTaskPropertyMenuItems_abyssPrivate(menu, task);
    this.addTaskActionMenuItems_abyssPrivate(menu, card, task);
    return menu;
  }

  private addTaskDateMenuItems_abyssPrivate(
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
          runAsyncAction(this.toggleTaskDuePreset_abyssPrivate(task, today));
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
            runAsyncAction(this.toggleTaskDuePreset_abyssPrivate(task, tomorrow));
          }),
      );
    }
    menu.addItem((item) =>
      item
        .setTitle('Set date…')
        .setIcon('calendar-cog')
        .setSection('actions')
        .onClick(() => {
          this.openTaskDatePicker_abyssPrivate(card, [task]);
        }),
    );
  }

  private addTaskTagMenuItems_abyssPrivate(menu: Menu, task: TaskSnapshot): void {
    for (const pinnedTag of this.settings_abyssPrivate.pinnedTags) {
      const hasTag = this.getTaskTags_abyssPrivate(task).has(pinnedTag);
      menu.addItem((item) =>
        item
          .setTitle(pinnedTag)
          .setIcon('tag')
          .setSection('tags')
          .setChecked(hasTag)
          .onClick(() => {
            runAsyncAction(
              this.patchTaskTags_abyssPrivate(
                task,
                hasTag ? [] : [pinnedTag],
                hasTag ? [pinnedTag] : [],
              ),
            );
          }),
      );
    }
  }

  private addTaskPropertyMenuItems_abyssPrivate(menu: Menu, task: TaskSnapshot): void {
    menu.addItem((item) => {
      item.setTitle('Priority').setIcon('arrow-up-narrow-wide').setSection('priority');
      const sub = getSubmenu(item);
      this.buildPrioritySubmenu_abyssPrivate(sub, task);
    });

    // ── Status (submenu) ──────────────────────────────────
    menu.addItem((item) => {
      item.setTitle('Status').setIcon('check-square').setSection('priority');
      const sub = getSubmenu(item);
      buildStatusSubmenu(sub, task, this.statusRegistry_abyssPrivate, (c) => {
        runAsyncAction(this.setTaskStatus_abyssPrivate(task, c));
      });
    });

    menu.addItem((item) =>
      item
        .setTitle('Filter by this priority')
        .setIcon('filter')
        .setSection('priority')
        .onClick(() => {
          this.addPropertyFilter_abyssPrivate({ type: 'priority', value: task.priority });
        }),
    );

    menu.addItem((item) =>
      item
        .setTitle('Filter by this status')
        .setIcon('filter')
        .setSection('priority')
        .onClick(() => {
          this.addPropertyFilter_abyssPrivate({ type: 'status', value: task.statusSymbol });
        }),
    );
  }

  private addTaskActionMenuItems_abyssPrivate(
    menu: Menu,
    card: HTMLElement,
    task: TaskSnapshot,
  ): void {
    menu.addItem((item) =>
      item
        .setTitle('Set tag…')
        .setIcon('hash')
        .setSection('actions')
        .onClick(() => {
          this.openTagPicker_abyssPrivate(task);
        }),
    );

    menu.addItem((item) => {
      item
        .setTitle('Edit repeat…')
        .setIcon('repeat-2')
        .setSection('actions')
        .onClick(() => {
          this.openRecurrenceEditor_abyssPrivate(card, task);
        });
    });

    menu.addItem((item) =>
      item
        .setTitle('Open in note')
        .setIcon('file-text')
        .setSection('actions')
        .onClick(() => {
          runAsyncAction(openInFile(this.app_abyssPrivate, task));
        }),
    );

    menu.addItem((item) =>
      item
        .setTitle('Delete')
        .setIcon('trash-2')
        .setSection('danger')
        .onClick(() => {
          runAsyncAction(this.deleteTask_abyssPrivate(task));
        }),
    );
  }

  private bulkTagIndicator_abyssPrivate(count: number, total: number): string {
    if (count === total) return '✓ ';
    if (count > 0) return '~ ';
    return '';
  }

  private makeBulkTagRemoveHandler_abyssPrivate(
    selectedTasks: TaskSnapshot[],
    pinnedTag: string,
  ): () => void {
    return () => {
      runAsyncAction(
        Promise.all(
          selectedTasks.map((task) => this.patchTaskTags_abyssPrivate(task, [], [pinnedTag])),
        ),
      );
    };
  }

  private makeBulkTagAddHandler_abyssPrivate(
    selectedTasks: TaskSnapshot[],
    pinnedTag: string,
  ): () => void {
    return () => {
      runAsyncAction(
        Promise.all(
          selectedTasks.map((task) => this.patchTaskTags_abyssPrivate(task, [pinnedTag], [])),
        ),
      );
    };
  }

  private addBulkTagItem_abyssPrivate(
    menu: Menu,
    pinnedTag: string,
    selectedTasks: TaskSnapshot[],
  ): void {
    const count = selectedTasks.filter((task) => task.tags.includes(pinnedTag)).length;
    const allHave = count === selectedTasks.length;
    const indicator = this.bulkTagIndicator_abyssPrivate(count, selectedTasks.length);
    const clickHandler = allHave
      ? this.makeBulkTagRemoveHandler_abyssPrivate(selectedTasks, pinnedTag)
      : this.makeBulkTagAddHandler_abyssPrivate(selectedTasks, pinnedTag);
    menu.addItem((item) =>
      item
        .setTitle(`${indicator}${pinnedTag}  (${count}/${selectedTasks.length})`)
        .setIcon('tag')
        .setSection('tags')
        .onClick(clickHandler),
    );
  }

  private async deleteBulkTasks_abyssPrivate(selectedTasks: TaskSnapshot[]): Promise<void> {
    const sorted = [...selectedTasks].sort((a, b) => b.source.line - a.source.line);
    for (const t of sorted) await this.deleteTask_abyssPrivate(t);
    this.selectedTaskKeys_abyssPrivate.clear();
    this.selectionAnchorKey_abyssPrivate = null;
    this.selectionFocusKey_abyssPrivate = null;
    this.updateSelectionVisuals_abyssPrivate();
  }

  private buildPrioritySubmenu_abyssPrivate(sub: Menu, task: TaskSnapshot): void {
    for (const level of PRIORITY_LEVELS) {
      sub.addItem((si) => {
        si.setTitle(level.label)
          .setIcon('flag')
          .setChecked(task.priority === level.value)
          .onClick(() => {
            runAsyncAction(this.setPriority_abyssPrivate(task, level.value));
          });
        applyPriorityFlagColor(si, level.value);
      });
    }
  }

  private buildBulkPrioritySubmenu_abyssPrivate(sub: Menu, selectedTasks: TaskSnapshot[]): void {
    for (const level of PRIORITY_LEVELS) {
      sub.addItem((si) => {
        si.setTitle(level.label)
          .setIcon('flag')
          .onClick(() => {
            runAsyncAction(
              Promise.all(selectedTasks.map((t) => this.setPriority_abyssPrivate(t, level.value))),
            );
          });
        applyPriorityFlagColor(si, level.value);
      });
    }
  }

  private getTaskTags_abyssPrivate(task: TaskSnapshot): Set<string> {
    return new Set(task.tags);
  }

  private async patchTaskTags_abyssPrivate(
    task: TaskSnapshot,
    add: readonly string[],
    remove: readonly string[],
  ): Promise<void> {
    const ref = task.ref;
    if (this.tasks_abyssPrivate == null) return;
    presentTaskCommandResult(
      await this.tasks_abyssPrivate.execute({
        type: 'patch',
        target: { type: 'task', ref },
        patch: { tags: { add, remove } },
      }),
    );
  }

  private async assignTagFromInbox_abyssPrivate(task: TaskSnapshot, tag: string): Promise<void> {
    const inboxTag = this.settings_abyssPrivate.inbox.tag;
    const remove =
      this.settings_abyssPrivate.inbox.removeTagOnAssign &&
      this.getTaskTags_abyssPrivate(task).has(inboxTag)
        ? [inboxTag]
        : [];
    await this.patchTaskTags_abyssPrivate(task, [tag], remove);
  }

  private openTagPicker_abyssPrivate(task: TaskSnapshot): void {
    const currentTags = this.getTaskTags_abyssPrivate(task);
    const handleCommit = (toAdd: string[], toRemove: string[]): void => {
      runAsyncAction(this.patchTaskTags_abyssPrivate(task, toAdd, toRemove));
    };
    new TagPickerModal(
      this.app_abyssPrivate,
      (tag) => this.getTagColor_abyssPrivate(tag),
      currentTags,
      new Set(),
      handleCommit,
      this.interactionOwnership_abyssPrivate,
    ).open();
  }

  private openBulkTagPicker_abyssPrivate(selectedTasks: TaskSnapshot[]): void {
    const tagSets = selectedTasks.map((t) => this.getTaskTags_abyssPrivate(t));
    const allTags = new Set(tagSets.flatMap((s) => [...s]));
    const hasAll = (tag: string): boolean => tagSets.every((s) => s.has(tag));
    const currentTags = new Set([...allTags].filter(hasAll));
    const partialTags = new Set([...allTags].filter((tag) => !hasAll(tag)));
    const handleBulkCommit = (toAdd: string[], toRemove: string[]): void => {
      runAsyncAction(
        Promise.all(
          selectedTasks.map((task) => this.patchTaskTags_abyssPrivate(task, toAdd, toRemove)),
        ),
      );
    };
    new TagPickerModal(
      this.app_abyssPrivate,
      (tag) => this.getTagColor_abyssPrivate(tag),
      currentTags,
      partialTags,
      handleBulkCommit,
      this.interactionOwnership_abyssPrivate,
    ).open();
  }

  private showBulkContextMenu_abyssPrivate(event: MouseEvent, card: HTMLElement): void {
    const selectedTasks = this.selectedTasksInVisualOrder_abyssPrivate();
    const firstSelectedTask = selectedTasks[0];
    if (firstSelectedTask === undefined) return;
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle(`${selectedTasks.length} tasks selected`)
        .setSection('header')
        .setDisabled(true),
    );
    this.addBulkDateMenuItems_abyssPrivate(menu, selectedTasks, card);
    for (const pinnedTag of this.settings_abyssPrivate.pinnedTags) {
      this.addBulkTagItem_abyssPrivate(menu, pinnedTag, selectedTasks);
    }
    this.addBulkPropertyMenuItems_abyssPrivate(menu, selectedTasks, firstSelectedTask);
    this.addBulkActionMenuItems_abyssPrivate(menu, selectedTasks);
    showMenuAtMouseEventWithFocus(menu, event);
  }

  private selectedTasksInVisualOrder_abyssPrivate(): TaskSnapshot[] {
    const selectedKeys = this.visibleTaskKeys_abyssPrivate().filter((key) =>
      this.selectedTaskKeys_abyssPrivate.has(key),
    );
    const allTasks = [...this.queries_abyssPrivate.list()];
    return selectedKeys
      .map((k) => {
        const lastColon = k.lastIndexOf(':');
        const fp = k.slice(0, lastColon);
        const lineNum = parseInt(k.slice(lastColon + 1), 10);
        return allTasks.find((t) => t.source.filePath === fp && t.source.line === lineNum);
      })
      .filter((t) => t !== undefined);
  }

  private addBulkDateMenuItems_abyssPrivate(
    menu: Menu,
    selectedTasks: TaskSnapshot[],
    card: HTMLElement,
  ): void {
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
          runAsyncAction(this.applyBulkDuePreset_abyssPrivate(selectedTasks, today));
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
            runAsyncAction(this.applyBulkDuePreset_abyssPrivate(selectedTasks, tomorrow));
          }),
      );
    }
    menu.addItem((item) =>
      item
        .setTitle('Set date…')
        .setIcon('calendar-cog')
        .setSection('actions')
        .onClick(() => {
          this.openTaskDatePicker_abyssPrivate(card, selectedTasks);
        }),
    );
  }

  private addBulkPropertyMenuItems_abyssPrivate(
    menu: Menu,
    selectedTasks: TaskSnapshot[],
    firstSelectedTask: TaskSnapshot,
  ): void {
    menu.addItem((item) => {
      item.setTitle('Priority').setIcon('arrow-up-narrow-wide').setSection('priority');
      const sub = getSubmenu(item);
      this.buildBulkPrioritySubmenu_abyssPrivate(sub, selectedTasks);
    });

    menu.addItem((item) => {
      item.setTitle('Status').setIcon('check-square').setSection('priority');
      const sub = getSubmenu(item);
      buildStatusSubmenu(sub, firstSelectedTask, this.statusRegistry_abyssPrivate, (c) => {
        runAsyncAction(
          Promise.all(selectedTasks.map((t) => this.setTaskStatus_abyssPrivate(t, c))),
        );
      });
    });
  }

  private addBulkActionMenuItems_abyssPrivate(menu: Menu, selectedTasks: TaskSnapshot[]): void {
    menu.addItem((item) =>
      item
        .setTitle('Set tag…')
        .setIcon('hash')
        .setSection('actions')
        .onClick(() => {
          this.openBulkTagPicker_abyssPrivate(selectedTasks);
        }),
    );

    menu.addItem((item) =>
      item
        .setTitle('Delete all')
        .setIcon('trash-2')
        .setSection('danger')
        .onClick(() => {
          runAsyncAction(this.deleteBulkTasks_abyssPrivate(selectedTasks));
        }),
    );
  }

  private renderPropertyChips_abyssPrivate(container: HTMLElement): void {
    const vs = this.state_abyssPrivate.get('centerListViewState');
    for (const [i, f] of vs.filters.entries()) {
      const label = this.filterChipLabel_abyssPrivate(f);
      const chip = container.createSpan({ cls: 'abyss-filter-chip' });
      chip.createSpan({ cls: 'abyss-filter-chip-label', text: label });
      const x = chip.createEl('button', { cls: 'abyss-filter-chip-x', text: '×' });
      const idx = i;
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        this.removePropertyFilter_abyssPrivate(idx);
      });
    }
  }

  private filterChipLabel_abyssPrivate(f: PropertyFilter): string {
    if (f.type === 'file') {
      return `📄 ${f.filePath.split('/').pop()?.replace(/\.md$/, '') ?? ''}`;
    }
    if (f.type !== 'priority') return this.nonPriorityFilterLabel_abyssPrivate(f);
    const level = PRIORITY_LEVELS.find((l) => l.value === f.value);
    if (level == null) return f.value;
    // D/None has no emoji and reads as "Normal" here (distinct from the
    // "None" label used in priority-picker menus).
    return level.emoji.length > 0 ? `${level.emoji} ${level.label}` : 'Normal';
  }

  private nonPriorityFilterLabel_abyssPrivate(
    filter: Exclude<PropertyFilter, { readonly type: 'file' } | { readonly type: 'priority' }>,
  ): string {
    if (filter.type === 'tag') return filter.value;
    if (filter.type === 'time') return `⏰ ${filter.value}`;
    if (filter.type === 'status') {
      return this.statusRegistry_abyssPrivate.bySymbol(filter.value)?.name ?? filter.value;
    }
    return `📅 ${this.formatDate_abyssPrivate(filter.value)}`;
  }

  private addPropertyFilter_abyssPrivate(filter: PropertyFilter): void {
    const vs = this.state_abyssPrivate.get('centerListViewState');
    const key = this.propertyFilterKey_abyssPrivate(filter);
    const already = vs.filters.some(
      (existing) => this.propertyFilterKey_abyssPrivate(existing) === key,
    );
    if (already) return;
    const next: ListViewState = { ...vs, filters: [...vs.filters, filter] };
    this.updateViewState_abyssPrivate(next);
  }

  private propertyFilterKey_abyssPrivate(filter: PropertyFilter): string {
    return filter.type === 'file'
      ? `${filter.type}:${filter.filePath}`
      : `${filter.type}:${filter.value}`;
  }

  private removePropertyFilter_abyssPrivate(idx: number): void {
    const vs = this.state_abyssPrivate.get('centerListViewState');
    const next: ListViewState = { ...vs, filters: vs.filters.filter((_, i) => i !== idx) };
    this.updateViewState_abyssPrivate(next);
  }

  private updateViewState_abyssPrivate(next: ListViewState): void {
    this.settings_abyssPrivate.listViewStates ??= {};
    this.settings_abyssPrivate.listViewStates[this.activeListKey_abyssPrivate()] = next;
    runAsyncAction(this.onSaveSettings_abyssPrivate());
    this.state_abyssPrivate.set('centerListViewState', next);
  }

  private activeListKey_abyssPrivate(): string {
    return listSelectionToKey(this.state_abyssPrivate.get('selectedList'));
  }

  private renderViewStateButton_abyssPrivate(container: HTMLElement): void {
    const vs = this.state_abyssPrivate.get('centerListViewState');
    const defaults = getListViewDefaults(this.activeListKey_abyssPrivate());
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
      this.showViewStatePopover_abyssPrivate(btn);
    });

    if (this.reopenStatusGroupPopover_abyssPrivate) {
      this.reopenStatusGroupPopover_abyssPrivate = false;
      this.showViewStatePopover_abyssPrivate(btn, true);
    }
  }

  private showViewStatePopover_abyssPrivate(
    anchor: HTMLElement,
    autoOpenStatusGroupRow = false,
  ): void {
    if (this.viewStatePopoverCleanup_abyssPrivate != null) {
      this.viewStatePopoverCleanup_abyssPrivate(true);
      return;
    }

    const viewState = this.state_abyssPrivate.get('centerListViewState');
    const defaults = getListViewDefaults(this.activeListKey_abyssPrivate());
    const close = openViewOptionsPopover({
      host: this.el,
      anchor,
      rows: [
        this.groupByRowSpec_abyssPrivate(viewState, defaults),
        this.sortByRowSpec_abyssPrivate(viewState, defaults),
        this.statusGroupsRowSpec_abyssPrivate(viewState, autoOpenStatusGroupRow),
      ],
      showReset: isListViewCustomized(viewState, this.activeListKey_abyssPrivate()),
      onReset: () => {
        this.updateViewState_abyssPrivate(getListViewDefaults(this.activeListKey_abyssPrivate()));
      },
      interactionOwnership: this.interactionOwnership_abyssPrivate,
      onClose: () => {
        if (this.viewStatePopoverCleanup_abyssPrivate === close) {
          this.viewStatePopoverCleanup_abyssPrivate = null;
        }
      },
    });
    this.viewStatePopoverCleanup_abyssPrivate = close;
  }

  private groupByRowSpec_abyssPrivate(
    viewState: ListViewState,
    defaults: ListViewState,
  ): ViewOptionsSingleRow {
    const labels: Record<string, string> = {
      none: 'None',
      date: 'Date',
      priority: 'Priority',
      tag: 'Tag',
      status: 'Status',
    };
    return {
      kind: 'single',
      icon: 'layout-list',
      label: 'Group by',
      displayValue: labels[viewState.groupBy] ?? viewState.groupBy,
      activeValue: viewState.groupBy,
      options: Object.entries(labels).map(([value, label]) => ({
        label,
        value,
        isDefault: value === defaults.groupBy,
      })),
      onSelect: (value) => {
        this.updateViewState_abyssPrivate({
          ...viewState,
          groupBy: value as ListViewState['groupBy'],
        });
      },
    };
  }

  private sortByRowSpec_abyssPrivate(
    viewState: ListViewState,
    defaults: ListViewState,
  ): ViewOptionsSingleRow {
    const arrow = viewState.sortBy.dir === 'asc' ? '↑' : '↓';
    const fields: Array<ListViewState['sortBy']['field']> = [
      'date',
      'priority',
      'title',
      'tag',
      'status',
    ];
    return {
      kind: 'single',
      icon: 'arrow-up-down',
      label: 'Sort by',
      displayValue: `${this.capitalize_abyssPrivate(viewState.sortBy.field)} ${arrow}`,
      activeValue: viewState.sortBy.field,
      options: fields.map((field) => ({
        label:
          `${this.capitalize_abyssPrivate(field)} ${viewState.sortBy.field === field ? arrow : ''}`.trim(),
        value: field,
        isDefault: field === defaults.sortBy.field,
      })),
      onSelect: (value) => {
        const field = value as ListViewState['sortBy']['field'];
        const dir =
          viewState.sortBy.field === field && viewState.sortBy.dir === 'asc' ? 'desc' : 'asc';
        this.updateViewState_abyssPrivate({ ...viewState, sortBy: { field, dir } });
      },
    };
  }

  private capitalize_abyssPrivate(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  private statusGroupsRowSpec_abyssPrivate(
    viewState: ListViewState,
    initiallyOpen: boolean,
  ): ViewOptionsMultiRow {
    const apply = (groups: TaskStatusType[] | undefined): void => {
      this.applyStatusGroupsChange_abyssPrivate(viewState, groups);
    };
    return {
      kind: 'multi',
      icon: 'eye',
      label: 'Show',
      displayValue: this.statusGroupsLabel_abyssPrivate(viewState.statusGroups),
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
          onSelect: () => {
            apply(ACTIVE_STATUS_GROUPS);
          },
          active: statusGroupsEqual(viewState.statusGroups, ACTIVE_STATUS_GROUPS),
        },
        {
          label: 'All',
          onSelect: () => {
            apply(undefined);
          },
          active: normalizeStatusGroups(viewState.statusGroups) === undefined,
        },
      ],
    };
  }

  private statusGroupsLabel_abyssPrivate(selected: TaskStatusType[] | undefined): string {
    const effective = normalizeStatusGroups(selected) ?? ALL_STATUS_GROUPS;
    if (effective.length >= 4) return 'All';
    if (statusGroupsEqual(effective, ACTIVE_STATUS_GROUPS)) return 'Active';
    return `${effective.length} selected`;
  }

  private applyStatusGroupsChange_abyssPrivate(
    viewState: ListViewState,
    groups: TaskStatusType[] | undefined,
  ): void {
    this.reopenStatusGroupPopover_abyssPrivate = true;
    this.viewStatePopoverCleanup_abyssPrivate?.();
    const withoutStatusGroups = { ...viewState };
    delete withoutStatusGroups.statusGroups;
    this.updateViewState_abyssPrivate(
      groups === undefined ? withoutStatusGroups : { ...viewState, statusGroups: groups },
    );
  }

  /** Keep the positioned calendar wrapper while delegating capture state and submission. */
  private showTimeGridQuickAdd_abyssPrivate(
    _hourColumnEl: HTMLElement,
    date: string,
    time: string,
  ): void {
    this.openCapture_abyssPrivate(
      { type: 'calendar-timed', date, time },
      { type: 'default', source: 'calendar' },
    );
  }

  /** Month and all-day cells share capture behavior but retain their existing geometry wrappers. */
  private showFillCellQuickAdd_abyssPrivate(
    _cell: HTMLElement,
    date: string,
    popCls: string,
  ): void {
    const placement: CalendarCapturePlacement =
      popCls === 'abyss-mg-quick-add'
        ? { type: 'calendar-month', date }
        : { type: 'calendar-all-day', date };
    this.openCapture_abyssPrivate(placement, { type: 'default', source: 'calendar' });
  }

  private renderAddTaskBar_abyssPrivate(): void {
    const bar = this.el.createDiv({ cls: 'abyss-add-task-bar' });
    this.renderCaptureHost_abyssPrivate(bar, {
      type: 'list',
      selectionKey: listSelectionToKey(this.state_abyssPrivate.get('selectedList')),
    });
  }

  private renderCaptureHost_abyssPrivate(host: HTMLElement, placement: BarCapturePlacement): void {
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
          : { type: 'list', selection: this.state_abyssPrivate.get('selectedList') };
      this.openCapture_abyssPrivate(placement, context, trigger);
    });
    const active = this.activeCapture_abyssPrivate;
    if (active != null && this.sameCapturePlacement_abyssPrivate(active.placement, placement)) {
      trigger.hidden = true;
      active.returnFocus = trigger;
      this.mountCaptureSurface_abyssPrivate(active, host);
    }
  }

  private openCapture_abyssPrivate(
    placement: PanelCapturePlacement,
    context: CaptureContext,
    returnFocus = this.currentCaptureFocusOrigin_abyssPrivate(),
  ): void {
    if (this.captureTargets_abyssPrivate == null) return;
    this.cancelActiveCapture_abyssPrivate();
    const requestId = ++this.captureRequestId_abyssPrivate;
    this.resolvingCapture_abyssPrivate = { requestId, placement };
    runAsyncAction(
      this.captureTargets_abyssPrivate.resolve(context).then((resolvedTarget) => {
        if (requestId !== this.captureRequestId_abyssPrivate) return;
        this.resolvingCapture_abyssPrivate = null;
        const target = this.targetForCapturePlacement_abyssPrivate(resolvedTarget, placement);
        const controller = new TaskCaptureController({
          target,
          describe: describeTaskCreationResult,
          onResult: (result, description) => {
            const current = this.activeCapture_abyssPrivate;
            if (current?.requestId === requestId && description.kind !== 'success') {
              current.restoreFocusOnClose = false;
            }
            this.onCreationResult_abyssPrivate(result, description);
          },
          onRequestClose: () => {
            this.closeCaptureByRequestId_abyssPrivate(requestId);
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
        this.activeCapture_abyssPrivate = session;
        this.remountActiveCapture_abyssPrivate();
      }),
    );
  }

  private remountActiveCapture_abyssPrivate(): void {
    const active = this.activeCapture_abyssPrivate;
    if (active == null) return;
    const placement = active.placement;
    if (this.isCalendarCapturePlacement_abyssPrivate(placement)) {
      const host = this.calendarCaptureHost_abyssPrivate(placement);
      if (host != null) this.mountCaptureSurface_abyssPrivate(active, host);
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
    if (host != null) this.mountCaptureSurface_abyssPrivate(active, host);
  }

  private targetForCapturePlacement_abyssPrivate(
    target: CaptureTarget,
    placement: PanelCapturePlacement,
  ): CaptureTarget {
    if (!this.isCalendarCapturePlacement_abyssPrivate(placement)) return target;
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

  private calendarCaptureHost_abyssPrivate(
    placement: CalendarCapturePlacement,
  ): HTMLElement | null {
    if (placement.type === 'calendar-timed') {
      const day = [...this.el.querySelectorAll<HTMLElement>('.abyss-tg-day-column')].find(
        (candidate) => candidate.dataset['tgDate'] === placement.date,
      );
      const hourColumn = day?.querySelector<HTMLElement>('.abyss-tg-hour-column');
      if (hourColumn == null) return null;
      const host = this.captureWrapper_abyssPrivate(hourColumn, 'abyss-tg-quick-add');
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
    const host = this.captureWrapper_abyssPrivate(cell, wrapperClass);
    host.dataset['abyssCaptureHost'] = placement.type;
    host.dataset['abyssCaptureDate'] = placement.date;
    return host;
  }

  private captureWrapper_abyssPrivate(parent: HTMLElement, className: string): HTMLElement {
    const ownerWindow = parent.ownerDocument.defaultView;
    const current = [...parent.children].find(
      (candidate): candidate is HTMLElement =>
        ownerWindow != null &&
        candidate.instanceOf(ownerWindow.HTMLElement) &&
        candidate.classList.contains(className),
    );
    return current ?? parent.createDiv({ cls: className });
  }

  private mountCaptureSurface_abyssPrivate(active: PanelCaptureSession, host: HTMLElement): void {
    if (this.activeCapture_abyssPrivate !== active) return;
    if (this.isCaptureSurfaceMounted_abyssPrivate(active, host)) return;
    this.unmountActiveCapture_abyssPrivate();
    const feedbackHost = this.prepareCaptureHost_abyssPrivate(active, host);
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
    this.applyCaptureInputClass_abyssPrivate(surface, active.placement);
    active.surface = surface;
    active.host = host;
    this.focusNewCaptureSurface_abyssPrivate(active, surface);
  }

  private isCaptureSurfaceMounted_abyssPrivate(
    active: PanelCaptureSession,
    host: HTMLElement,
  ): boolean {
    return active.surface?.element.isConnected === true && active.host === host;
  }

  private applyCaptureInputClass_abyssPrivate(
    surface: CaptureSurface,
    placement: PanelCapturePlacement,
  ): void {
    const className = this.calendarCaptureInputClass_abyssPrivate(placement);
    if (className !== undefined && className !== '') surface.input.addClass(className);
  }

  private focusNewCaptureSurface_abyssPrivate(
    active: PanelCaptureSession,
    surface: CaptureSurface,
  ): void {
    if (!active.focusOnMount) return;
    active.focusOnMount = false;
    surface.focus();
  }

  private prepareCaptureHost_abyssPrivate(
    active: PanelCaptureSession,
    host: HTMLElement,
  ): HTMLElement | undefined {
    if (this.isCalendarCapturePlacement_abyssPrivate(active.placement)) {
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

  private unmountActiveCapture_abyssPrivate(): void {
    const active = this.activeCapture_abyssPrivate;
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

  private closeCapture_abyssPrivate(active: PanelCaptureSession): void {
    if (this.activeCapture_abyssPrivate !== active) return;
    const host = active.host;
    const placement = active.placement;
    const returnFocus = active.returnFocus;
    const restoreFocus = active.restoreFocusOnClose;
    const captureOwnedFocus =
      active.surface !== undefined &&
      active.surface.input.ownerDocument.activeElement === active.surface.input;
    this.unmountActiveCapture_abyssPrivate();
    active.controller.destroy();
    this.activeCapture_abyssPrivate = null;
    this.restoreCaptureHost_abyssPrivate(host, placement);
    if (
      restoreFocus &&
      captureOwnedFocus &&
      returnFocus != null &&
      this.canRestoreCaptureFocus_abyssPrivate(returnFocus)
    ) {
      returnFocus.focus({ preventScroll: true });
    }
  }

  private closeCaptureByRequestId_abyssPrivate(requestId: number): void {
    const active = this.activeCapture_abyssPrivate;
    if (active?.requestId === requestId) this.closeCapture_abyssPrivate(active);
  }

  private cancelActiveCapture_abyssPrivate(): void {
    this.captureRequestId_abyssPrivate++;
    this.resolvingCapture_abyssPrivate = null;
    const active = this.activeCapture_abyssPrivate;
    if (active == null) return;
    const host = active.host;
    const placement = active.placement;
    this.unmountActiveCapture_abyssPrivate();
    active.controller.destroy();
    this.activeCapture_abyssPrivate = null;
    this.restoreCaptureHost_abyssPrivate(host, placement);
  }

  private restoreCaptureHost_abyssPrivate(
    host: HTMLElement | undefined,
    placement: PanelCapturePlacement,
  ): void {
    if (host?.isConnected !== true) return;
    if (this.isCalendarCapturePlacement_abyssPrivate(placement)) {
      host.remove();
      return;
    }
    host.querySelector<HTMLButtonElement>('.abyss-add-task-trigger')?.removeAttribute('hidden');
  }

  private sameCapturePlacement_abyssPrivate(
    left: PanelCapturePlacement,
    right: PanelCapturePlacement,
  ): boolean {
    return (
      this.capturePlacementKey_abyssPrivate(left) === this.capturePlacementKey_abyssPrivate(right)
    );
  }

  private capturePlacementKey_abyssPrivate(placement: PanelCapturePlacement): string {
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

  private cancelStaleListCapture_abyssPrivate(): void {
    const placement =
      this.activeCapture_abyssPrivate?.placement ?? this.resolvingCapture_abyssPrivate?.placement;
    if (placement?.type !== 'list') return;
    const currentSelectionKey = listSelectionToKey(this.state_abyssPrivate.get('selectedList'));
    if (
      this.state_abyssPrivate.get('mode') !== 'tasks' ||
      placement.selectionKey !== currentSelectionKey
    ) {
      this.cancelActiveCapture_abyssPrivate();
    }
  }

  private isCalendarCapturePlacement_abyssPrivate(
    placement: PanelCapturePlacement,
  ): placement is CalendarCapturePlacement {
    return placement.type.startsWith('calendar-');
  }

  private calendarCaptureInputClass_abyssPrivate(
    placement: PanelCapturePlacement,
  ): string | undefined {
    if (placement.type === 'calendar-timed') return 'abyss-tg-quick-add-input';
    if (placement.type === 'calendar-all-day') return 'abyss-tg-allday-quick-add-input';
    if (placement.type === 'calendar-month') return 'abyss-mg-quick-add-input';
    return undefined;
  }

  private currentCaptureFocusOrigin_abyssPrivate(): HTMLElement | null {
    const active = this.el.ownerDocument.activeElement;
    return isRealmHTMLElement(active) ? active : null;
  }

  private canRestoreCaptureFocus_abyssPrivate(element: HTMLElement): boolean {
    if (!element.isConnected) return false;
    const ownerWindow = element.ownerDocument.defaultView;
    if (ownerWindow == null) return false;
    const style = ownerWindow.getComputedStyle(element);
    return (
      style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse'
    );
  }

  private async deleteTask_abyssPrivate(task: TaskSnapshot): Promise<void> {
    const ref = task.ref;
    if (this.tasks_abyssPrivate == null) return;
    const result = await this.tasks_abyssPrivate.execute({ type: 'delete', ref });
    presentTaskCommandResult(result);
    if (result.type !== 'ok' || result.outcome.type !== 'deleted') return;
    const stack = this.state_abyssPrivate.get('taskStack');
    const current = stack[0] != null ? rootTaskRef(stack[0]) : undefined;
    if (current != null && this.sameTaskRef_abyssPrivate(current, ref)) {
      this.state_abyssPrivate.set('taskStack', []);
    }
  }

  private sameTaskRef_abyssPrivate(left: TaskRef, right: TaskRef): boolean {
    return (
      left.filePath === right.filePath &&
      left.line === right.line &&
      left.revision === right.revision
    );
  }

  private getFilteredTasks_abyssPrivate(): TaskSnapshot[] {
    return [
      ...selectTaskList({
        tasks: this.queries_abyssPrivate.list(),
        selection: this.state_abyssPrivate.get('selectedList'),
        viewState: this.state_abyssPrivate.get('centerListViewState'),
        settings: this.settings_abyssPrivate,
        today: window.moment().format('YYYY-MM-DD') as LocalDate,
        textQuery: this.state_abyssPrivate.get('centerFilter'),
      }),
    ];
  }

  private getTitle_abyssPrivate(): string {
    const sel: unknown = this.state_abyssPrivate.get('selectedList');
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
    return this.structuredSelectionTitle_abyssPrivate(selection);
  }

  private structuredSelectionTitle_abyssPrivate(selection: {
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
        const group = this.settings_abyssPrivate.tagGroups.find(
          (candidate) => candidate.id === selection.groupId,
        );
        return group?.name ?? 'Group';
      }
      case undefined:
      default:
        return 'Tasks';
    }
  }

  private formatDate_abyssPrivate(d: string): string {
    const today = window.moment().format('YYYY-MM-DD');
    const tomorrow = window.moment().add(1, 'day').format('YYYY-MM-DD');
    if (d === today) return 'Today';
    if (d === tomorrow) return 'Tomorrow';
    const m = window.moment(d, 'YYYY-MM-DD');
    const diff = m.diff(window.moment(), 'days');
    if (diff > -7 && diff < 7) return m.format('ddd D MMM');
    return m.format('D MMM');
  }

  private getDateClass_abyssPrivate(d: string): string {
    const today = window.moment().format('YYYY-MM-DD');
    if (d < today) return 'is-overdue';
    if (d === today) return 'is-today';
    const tomorrow = window.moment().add(1, 'day').format('YYYY-MM-DD');
    if (d === tomorrow) return 'is-tomorrow';
    const dayAfter = window.moment().add(2, 'days').format('YYYY-MM-DD');
    if (d === dayAfter) return 'is-soon';
    return '';
  }

  private getTagColor_abyssPrivate(tag: string): string | undefined {
    const noHash = tag.replace(/^#/, '');
    for (const group of this.settings_abyssPrivate.tagGroups) {
      if (this.tagMatchesGroup_abyssPrivate(tag, noHash, group)) return group.color;
    }
    return undefined;
  }

  private tagMatchesGroup_abyssPrivate(
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

  private async rescheduleTask_abyssPrivate(dragData: string, targetDate: string): Promise<void> {
    const task = this.taskFromDragData_abyssPrivate(dragData);
    if (this.tasks_abyssPrivate == null) return;
    if (task == null) return;
    try {
      const date = localDate(targetDate);
      const command = this.rescheduleCommand_abyssPrivate(task, date);
      presentTaskCommandResult(await this.tasks_abyssPrivate.execute(command));
    } catch {
      // Calendar controls supply the date; malformed gesture input remains a no-op.
    }
  }

  private async setTaskTimeFromDrop_abyssPrivate(
    dragData: string,
    date: string,
    time: string,
  ): Promise<void> {
    const task = this.taskFromDragData_abyssPrivate(dragData);
    if (this.tasks_abyssPrivate == null) return;
    if (task == null) return;
    try {
      const targetDate = localDate(date);
      const targetTime = localTime(time);
      presentTaskCommandResult(
        await this.tasks_abyssPrivate.execute(
          this.timeDropCommand_abyssPrivate(task, targetDate, targetTime),
        ),
      );
    } catch {
      // A malformed drag payload is ignored without touching the task.
    }
  }

  private taskFromDragData_abyssPrivate(dragData: string): TaskSnapshot | undefined {
    const [filePath, lineText] = dragData.split(':::');
    const line = Number.parseInt(lineText ?? '', 10);
    if (filePath === undefined || filePath === '' || !Number.isInteger(line)) return undefined;
    return [...this.queries_abyssPrivate.list({ filePath })].find(
      (task) => task.source.line === line,
    );
  }

  private rescheduleCommand_abyssPrivate(
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

  private timeDropCommand_abyssPrivate(
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

  private async commitTimedMove_abyssPrivate(
    task: TaskSnapshot,
    target: TimedDragTarget,
  ): Promise<void> {
    const ref = calendarRootTaskRef(task);
    if (this.tasks_abyssPrivate == null || ref == null) return;
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
      presentTaskCommandResult(await this.tasks_abyssPrivate.execute(command));
    } catch {
      // Geometry and command validation share the same target; malformed values remain no-ops.
    }
  }

  private async commitTimedDuration_abyssPrivate(
    task: TaskSnapshot,
    target: TimedVerticalResizeTarget,
  ): Promise<void> {
    if (this.tasks_abyssPrivate == null) return;
    try {
      const command = calendarPatchCommand(task, {
        time: {
          type: 'set',
          value: localTime(minutesToTimeString(target.startMinutes)),
        },
        duration: { type: 'set', value: durationMinutes(target.durationMinutes) },
      });
      if (command == null) return;
      presentTaskCommandResult(await this.tasks_abyssPrivate.execute(command));
    } catch {
      // Keep the previous duration if a forged target fails validation.
    }
  }

  private async commitSpanMove_abyssPrivate(
    task: TaskSnapshot,
    target: SpanMoveTarget,
  ): Promise<void> {
    const ref = calendarRootTaskRef(task);
    if (this.tasks_abyssPrivate == null || ref == null || target.days === 0) return;
    try {
      presentTaskCommandResult(
        await this.tasks_abyssPrivate.execute({ type: 'shift-schedule', ref, days: target.days }),
      );
    } catch {
      // The shared resolver validates the exact frozen delta again at the command boundary.
    }
  }

  private async commitTimedBoundary_abyssPrivate(
    task: TaskSnapshot,
    target: TimedBoundaryTarget,
  ): Promise<void> {
    const ref = calendarRootTaskRef(task);
    if (this.tasks_abyssPrivate == null || ref == null) return;
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
      presentTaskCommandResult(await this.tasks_abyssPrivate.execute(command));
    } catch {
      // Boundary geometry is validated again by the application command.
    }
  }

  private async updateTaskTime_abyssPrivate(
    task: TaskSnapshot,
    newStartMinutes: number,
  ): Promise<void> {
    if (this.tasks_abyssPrivate == null) return;
    try {
      const command = calendarPatchCommand(task, {
        time: { type: 'set', value: localTime(minutesToTimeString(newStartMinutes)) },
      });
      if (command == null) return;
      presentTaskCommandResult(await this.tasks_abyssPrivate.execute(command));
    } catch {
      // Keep the previous valid time when gesture arithmetic is out of range.
    }
  }

  private async updateTaskDuration_abyssPrivate(
    task: TaskSnapshot,
    newDurationMinutes: number,
  ): Promise<void> {
    if (this.tasks_abyssPrivate == null) return;
    try {
      const command = calendarPatchCommand(task, {
        duration: { type: 'set', value: durationMinutes(newDurationMinutes) },
      });
      if (command == null) return;
      presentTaskCommandResult(await this.tasks_abyssPrivate.execute(command));
    } catch {
      // Keep the previous valid duration when gesture arithmetic is invalid.
    }
  }

  private async updateTaskStart_abyssPrivate(task: TaskSnapshot, newStart: string): Promise<void> {
    const ref = calendarRootTaskRef(task);
    if (ref == null || this.tasks_abyssPrivate == null) return;
    try {
      presentTaskCommandResult(
        await this.tasks_abyssPrivate.execute({
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

  private async rescheduleTaskDue_abyssPrivate(task: TaskSnapshot, newDue: string): Promise<void> {
    const ref = calendarRootTaskRef(task);
    if (ref == null || this.tasks_abyssPrivate == null) return;
    try {
      presentTaskCommandResult(
        await this.tasks_abyssPrivate.execute({
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
  private async extendTaskToSpan_abyssPrivate(task: TaskSnapshot, newDue: string): Promise<void> {
    if ((task.planning.start ?? task.planning.scheduled ?? task.planning.due) == null) return;
    const ref = calendarRootTaskRef(task);
    if (ref == null || this.tasks_abyssPrivate == null) return;
    try {
      presentTaskCommandResult(
        await this.tasks_abyssPrivate.execute({ type: 'extend-span', ref, due: localDate(newDue) }),
      );
    } catch {
      // Calendar controls supply the boundary; malformed input remains a no-op.
    }
  }

  private editTaskLink_abyssPrivate(task: TaskSnapshot, occ: number, token: LinkToken): void {
    const target = calendarMutationTarget(task);
    const tasks = this.tasks_abyssPrivate;
    if (target == null || tasks == null) return;
    new LinkEditModal(
      this.app_abyssPrivate,
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
        );
      },
      task.source.filePath,
      this.interactionOwnership_abyssPrivate,
    ).open();
  }

  /** @internal Retained as a focused command seam for date-preset interactions and tests. */
  async toggleDueToday(task: TaskSnapshot): Promise<void> {
    const today = localDate(window.moment().format('YYYY-MM-DD'));
    await this.toggleTaskDuePreset_abyssPrivate(task, today);
  }

  private async toggleTaskDuePreset_abyssPrivate(
    task: TaskSnapshot,
    value: LocalDate,
  ): Promise<void> {
    await this.setTaskDue_abyssPrivate(task, task.planning.due === value ? null : value);
  }

  private async setTaskDue_abyssPrivate(
    task: TaskSnapshot,
    value: LocalDate | null,
  ): Promise<boolean> {
    const command = calendarPatchCommand(task, {
      due: value === null ? { type: 'clear' } : { type: 'set', value },
    });
    if (command == null || this.tasks_abyssPrivate == null) return false;
    const result = await this.tasks_abyssPrivate.execute(command);
    presentTaskCommandResult(result);
    return result.type === 'ok' && result.changed;
  }

  private async applyDueInOrder_abyssPrivate(
    tasks: readonly TaskSnapshot[],
    value: LocalDate,
  ): Promise<boolean> {
    let changed = false;
    for (const task of tasks) {
      const taskChanged = await this.setTaskDue_abyssPrivate(task, value);
      changed = taskChanged || changed;
    }
    return changed;
  }

  private async applyBulkDuePreset_abyssPrivate(
    tasks: readonly TaskSnapshot[],
    value: LocalDate,
  ): Promise<void> {
    const shouldClear = tasks.every((task) => task.planning.due === value);
    if (!shouldClear) {
      await this.applyDueInOrder_abyssPrivate(tasks, value);
      return;
    }
    for (const task of tasks) await this.setTaskDue_abyssPrivate(task, null);
  }

  private openTaskDatePicker_abyssPrivate(
    anchor: HTMLElement,
    tasks: readonly TaskSnapshot[],
  ): void {
    this.clearTaskDatePicker_abyssPrivate();
    const focusKey = this.taskDateTriggerKey_abyssPrivate(anchor);
    const firstDue = tasks[0]?.planning.due;
    const initialValue =
      firstDue != null && tasks.every((task) => task.planning.due === firstDue)
        ? firstDue
        : undefined;
    const cleanup = showDatePickerPopover({
      owner: this.el,
      anchor,
      boundary: this.el,
      interactionOwnership: this.interactionOwnership_abyssPrivate,
      ...(initialValue !== undefined && { initialValue }),
      onPick: (inputValue) => {
        try {
          const value = localDate(inputValue);
          const pendingFocus =
            focusKey !== undefined && focusKey !== ''
              ? {
                  key: focusKey,
                  armedRenderGeneration: this.taskCardRenderGeneration_abyssPrivate,
                  changed: false,
                }
              : undefined;
          if (pendingFocus != null) {
            this.pendingTaskDateFocus_abyssPrivate = pendingFocus;
            this.taskDateFocusContinuityKey_abyssPrivate = pendingFocus.key;
          }
          const firstTask = tasks[0];
          if (firstTask === undefined) return;
          const update =
            tasks.length === 1
              ? this.setTaskDue_abyssPrivate(firstTask, value)
              : this.applyDueInOrder_abyssPrivate(tasks, value);
          if (pendingFocus != null) {
            const settleFocus = (changed: boolean): void => {
              if (this.pendingTaskDateFocus_abyssPrivate !== pendingFocus) return;
              if (!changed) {
                this.clearTaskDateFocusContinuity_abyssPrivate(pendingFocus.key);
                return;
              }
              pendingFocus.changed = true;
              this.releaseSettledTaskDateFocus_abyssPrivate(pendingFocus);
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
        this.taskDatePickerCleanup_abyssPrivate = null;
      },
      ...(focusKey !== undefined && {
        restoreFocus: () => this.focusTaskDateTrigger_abyssPrivate(focusKey),
      }),
    });
    this.taskDatePickerCleanup_abyssPrivate = cleanup;
  }

  private clearTaskDatePicker_abyssPrivate(): void {
    this.taskDatePickerCleanup_abyssPrivate?.();
  }

  private taskDateTriggerKey_abyssPrivate(target: EventTarget | null): string | undefined {
    if (!this.isElementFromPanelRealm_abyssPrivate(target)) return undefined;
    const card = target.closest<HTMLElement>('.abyss-task-card');
    if (card == null || !this.el.contains(card)) return undefined;
    const filePath = card.dataset['filePath'];
    const line = card.dataset['line'];
    return filePath === undefined || line === undefined ? undefined : `${filePath}:${line}`;
  }

  private isElementFromPanelRealm_abyssPrivate(target: EventTarget | null): target is Element {
    if (target == null || !('ownerDocument' in target)) return false;
    const ownerDocument = (target as { readonly ownerDocument?: Document }).ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    return ownerWindow != null && target instanceof ownerWindow.Element;
  }

  private focusTaskDateTrigger_abyssPrivate(key: string): boolean {
    const card = Array.from(this.el.querySelectorAll<HTMLElement>('.abyss-task-card')).find(
      (candidate) =>
        `${candidate.dataset['filePath'] ?? ''}:${candidate.dataset['line'] ?? ''}` === key,
    );
    if (card?.isConnected !== true) return false;
    card.focus({ preventScroll: true });
    this.scrollTaskCardIntoView_abyssPrivate(card);
    return true;
  }

  private completeTaskCardRender_abyssPrivate(): void {
    this.taskCardRenderGeneration_abyssPrivate += 1;
    this.onRenderComplete_abyssPrivate(this.el);
    const continuityKey = this.taskDateFocusContinuityKey_abyssPrivate;
    const restored =
      continuityKey !== null && this.focusTaskDateTrigger_abyssPrivate(continuityKey);
    if (continuityKey !== null && !restored) {
      this.clearTaskDateFocusContinuity_abyssPrivate(continuityKey);
      return;
    }
    const pending = this.pendingTaskDateFocus_abyssPrivate;
    if (pending?.changed === true) this.releaseSettledTaskDateFocus_abyssPrivate(pending, restored);
  }

  private releaseSettledTaskDateFocus_abyssPrivate(
    pending: NonNullable<CenterPanel['pendingTaskDateFocus_abyssPrivate']>,
    restored = this.focusTaskDateTrigger_abyssPrivate(pending.key),
  ): void {
    if (
      this.pendingTaskDateFocus_abyssPrivate !== pending ||
      !pending.changed ||
      this.taskCardRenderGeneration_abyssPrivate <= pending.armedRenderGeneration
    ) {
      return;
    }
    this.pendingTaskDateFocus_abyssPrivate = null;
    if (!restored && this.taskDateFocusContinuityKey_abyssPrivate === pending.key) {
      this.taskDateFocusContinuityKey_abyssPrivate = null;
    }
  }

  private clearTaskDateFocusContinuity_abyssPrivate(key: string): void {
    if (this.pendingTaskDateFocus_abyssPrivate?.key === key) {
      this.pendingTaskDateFocus_abyssPrivate = null;
    }
    if (this.taskDateFocusContinuityKey_abyssPrivate === key)
      this.taskDateFocusContinuityKey_abyssPrivate = null;
  }

  private abandonTaskDateFocus_abyssPrivate(): void {
    this.pendingTaskDateFocus_abyssPrivate = null;
    this.taskDateFocusContinuityKey_abyssPrivate = null;
  }

  private taskKey_abyssPrivate(task: TaskSnapshot): string {
    return `${task.source.filePath}:${task.source.line}`;
  }

  private visibleTaskCards_abyssPrivate(): HTMLElement[] {
    if (this.state_abyssPrivate.get('mode') !== 'tasks') return [];
    const scroll = Array.from(this.el.children).find((child) =>
      child.classList.contains('abyss-center-scroll'),
    );
    return scroll != null
      ? Array.from(scroll.querySelectorAll<HTMLElement>('.abyss-task-card'))
      : [];
  }

  private visibleTaskKeys_abyssPrivate(): string[] {
    return this.visibleTaskCards_abyssPrivate().map(
      (card) => `${card.dataset['filePath'] ?? ''}:${card.dataset['line'] ?? ''}`,
    );
  }

  private replaceRangeSelection_abyssPrivate(
    anchor: string,
    focus: string,
    keys: readonly string[],
  ): void {
    const anchorIndex = keys.indexOf(anchor);
    const focusIndex = keys.indexOf(focus);
    this.selectedTaskKeys_abyssPrivate.clear();
    if (anchorIndex !== -1 && focusIndex !== -1) {
      const from = Math.min(anchorIndex, focusIndex);
      const to = Math.max(anchorIndex, focusIndex);
      for (const key of keys.slice(from, to + 1)) this.selectedTaskKeys_abyssPrivate.add(key);
    }
    this.updateSelectionVisuals_abyssPrivate();
  }

  private reconcileTaskSelection_abyssPrivate(keys: readonly string[]): void {
    const visible = new Set(keys);
    for (const key of this.selectedTaskKeys_abyssPrivate) {
      if (!visible.has(key)) this.selectedTaskKeys_abyssPrivate.delete(key);
    }
    const firstSelected = keys.find((key) => this.selectedTaskKeys_abyssPrivate.has(key)) ?? null;
    if (
      this.selectionAnchorKey_abyssPrivate === null ||
      this.selectionAnchorKey_abyssPrivate === '' ||
      !visible.has(this.selectionAnchorKey_abyssPrivate)
    ) {
      this.selectionAnchorKey_abyssPrivate = firstSelected;
    }
    if (
      this.selectionFocusKey_abyssPrivate === null ||
      this.selectionFocusKey_abyssPrivate === '' ||
      !visible.has(this.selectionFocusKey_abyssPrivate)
    ) {
      this.selectionFocusKey_abyssPrivate = firstSelected;
    }
  }

  private focusTaskKey_abyssPrivate(key: string): void {
    const index = this.visibleTaskKeys_abyssPrivate().indexOf(key);
    const card = index === -1 ? undefined : this.visibleTaskCards_abyssPrivate()[index];
    if (card == null) return;
    card.focus({ preventScroll: true });
    this.scrollTaskCardIntoView_abyssPrivate(card);
  }

  private scrollTaskCardIntoView_abyssPrivate(card: HTMLElement): void {
    const scrollHost = card as Partial<Pick<HTMLElement, 'scrollIntoView'>>;
    scrollHost.scrollIntoView?.({ block: 'nearest' });
  }

  private taskForKey_abyssPrivate(key: string): TaskSnapshot | undefined {
    const separator = key.lastIndexOf(':');
    if (separator === -1) return undefined;
    const filePath = key.slice(0, separator);
    const line = Number(key.slice(separator + 1));
    if (!Number.isInteger(line)) return undefined;
    return this.queries_abyssPrivate
      .list()
      .find((task) => task.source.filePath === filePath && task.source.line === line);
  }

  private updateSelectionVisuals_abyssPrivate(): void {
    this.el.querySelectorAll<HTMLElement>('.abyss-task-card').forEach((card) => {
      const key = `${card.dataset['filePath'] ?? ''}:${card.dataset['line'] ?? ''}`;
      const isSelected = this.selectedTaskKeys_abyssPrivate.has(key);
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
    this.updateTaskStackSelection_abyssPrivate();

    const live =
      this.el.querySelector<HTMLElement>('.abyss-selection-live') ??
      this.el.createDiv({
        cls: 'abyss-selection-live abyss-sr-only',
        attr: { 'aria-live': 'polite', 'aria-atomic': 'true' },
      });
    const count = this.selectedTaskKeys_abyssPrivate.size;
    if (count !== this.lastAnnouncedSelectionCount_abyssPrivate) {
      this.lastAnnouncedSelectionCount_abyssPrivate = count;
      live.textContent = `${count} ${count === 1 ? 'task' : 'tasks'} selected`;
    }
  }

  private async setPriority_abyssPrivate(
    task: TaskSnapshot,
    priority: 'A' | 'B' | 'C' | 'D' | 'E' | 'F',
  ): Promise<void> {
    if (isForecastCalendarTask(task)) return;
    const command = calendarPatchCommand(task, {
      priority: { type: 'set', value: priority },
    });
    if (command == null || this.tasks_abyssPrivate == null) return;
    presentTaskCommandResult(await this.tasks_abyssPrivate.execute(command));
  }

  private openStatusMenu_abyssPrivate(event: MouseEvent, task: TaskSnapshot): void {
    this.clearTaskDatePicker_abyssPrivate();
    this.dismissRecurrenceEditor_abyssPrivate();
    this.viewStatePopoverCleanup_abyssPrivate?.();
    showStatusMenuAt(event, {
      task,
      registry: this.statusRegistry_abyssPrivate,
      owner: this.md_abyssPrivate,
      onPickStatus: (symbol) => {
        runAsyncAction(this.setTaskStatus_abyssPrivate(task, symbol));
      },
      onPickPriority: (priority) => {
        runAsyncAction(this.setPriority_abyssPrivate(task, priority));
      },
      interactionOwnership: this.interactionOwnership_abyssPrivate,
    });
  }

  private toggleTask_abyssPrivate(task: TaskSnapshot): Promise<void> {
    if (isForecastCalendarTask(task)) return Promise.resolve();
    return requestTaskCompletion(
      task,
      () => this.commitTaskToggle_abyssPrivate(task),
      this.interactionOwnership_abyssPrivate,
      this.completionConfirmationAbortController_abyssPrivate.signal,
    );
  }

  private async commitTaskToggle_abyssPrivate(task: TaskSnapshot): Promise<void> {
    const target = calendarMutationTarget(task);
    if (target == null || this.tasks_abyssPrivate == null) return;
    presentTaskCommandResult(
      await this.tasks_abyssPrivate.execute({
        type: 'toggle-completion',
        target,
      }),
    );
  }

  private setTaskStatus_abyssPrivate(task: TaskSnapshot, symbol: string): Promise<void> {
    if (isForecastCalendarTask(task)) return Promise.resolve();
    if (this.statusRegistry_abyssPrivate.bySymbol(symbol)?.type === 'done') {
      return requestTaskCompletion(
        task,
        () => this.commitTaskStatus_abyssPrivate(task, symbol),
        this.interactionOwnership_abyssPrivate,
        this.completionConfirmationAbortController_abyssPrivate.signal,
      );
    }
    return this.commitTaskStatus_abyssPrivate(task, symbol);
  }

  private async commitTaskStatus_abyssPrivate(task: TaskSnapshot, symbol: string): Promise<void> {
    const target = calendarMutationTarget(task);
    if (target == null || this.tasks_abyssPrivate == null) return;
    presentTaskCommandResult(
      await this.tasks_abyssPrivate.execute({
        type: 'set-status',
        target,
        symbol,
      }),
    );
  }

  private openRecurrenceEditor_abyssPrivate(anchor: HTMLElement, task: TaskSnapshot): void {
    if (isForecastCalendarTask(task)) return;
    this.dismissRecurrenceEditor_abyssPrivate();
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
      policy: { removeScheduledDate: this.settings_abyssPrivate.recurrence.removeScheduledDate },
      ownershipConflict: hasOtherCalendarRecurrenceOwner(source),
      onSubmit: (patch) => {
        const command = calendarPatchCommand(task, patch);
        if (this.tasks_abyssPrivate == null || command == null) {
          return Promise.resolve({
            type: 'io-error' as const,
            cause: 'application-unavailable',
            contentState: 'unchanged' as const,
          });
        }
        return this.tasks_abyssPrivate.execute(command);
      },
      onClose: () => {
        if (this.recurrenceEditorCleanup_abyssPrivate === cleanup) {
          this.recurrenceEditorCleanup_abyssPrivate = null;
        }
      },
      interactionOwnership: this.interactionOwnership_abyssPrivate,
    });
    lifecycle.handle = handle;
    this.recurrenceEditorCleanup_abyssPrivate = cleanup;
  }

  private openForecastRecurrenceEditor_abyssPrivate(
    anchor: HTMLElement,
    source: CalendarTaskSource,
  ): void {
    this.dismissRecurrenceEditor_abyssPrivate();
    const lifecycle: { handle?: ReturnType<typeof mountAnchoredRecurrenceEditor> } = {};
    const cleanup = (): void => {
      lifecycle.handle?.dismiss();
    };
    const handle = mountAnchoredRecurrenceEditor({
      anchor,
      source,
      policy: { removeScheduledDate: this.settings_abyssPrivate.recurrence.removeScheduledDate },
      ownershipConflict: hasOtherCalendarRecurrenceOwner(source),
      onSubmit: (patch) => {
        if (this.tasks_abyssPrivate == null) {
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
        return this.tasks_abyssPrivate.execute(command);
      },
      onClose: () => {
        if (this.recurrenceEditorCleanup_abyssPrivate === cleanup) {
          this.recurrenceEditorCleanup_abyssPrivate = null;
        }
      },
      interactionOwnership: this.interactionOwnership_abyssPrivate,
    });
    lifecycle.handle = handle;
    this.recurrenceEditorCleanup_abyssPrivate = cleanup;
  }

  private dismissRecurrenceEditor_abyssPrivate(): void {
    const cleanup = this.recurrenceEditorCleanup_abyssPrivate;
    this.recurrenceEditorCleanup_abyssPrivate = null;
    cleanup?.();
  }
}
