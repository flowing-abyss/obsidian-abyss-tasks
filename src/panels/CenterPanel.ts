import { Component, Menu, Notice, setIcon, type App, type MenuItem } from 'obsidian';
import type { AppState } from '../app/AppState';
import { listSelectionToKey, normalizeStatusGroups, statusGroupsEqual } from '../app/listViewState';
import { firstVisibleWeekDate } from '../domain/weekGridOffset';
import type { LinkToken } from '../parser/links';
import { PRIORITY_LEVELS } from '../priority';
import {
  acknowledgeProjectedNextActions,
  NextActionService,
  projectedNextAction,
  projectedNextActionToken,
  subscribeProjectedNextActions,
  type NextActionConflict,
} from '../projects/NextActionService';
import type { ProjectCommandService } from '../projects/ProjectCommandService';
import type { ProjectManager } from '../projects/ProjectManager';
import type { ProjectStore } from '../projects/ProjectStore';
import type { ProjectAction, ProjectWorkspaceSnapshot } from '../projects/types';
import type { WorkNoteCommandService } from '../projects/work-notes/WorkNoteCommandService';
import { DEFAULT_VIEW_CONFIG, getListViewDefaults } from '../settings/defaults';
import type {
  CalendarSettings,
  ListViewState,
  ProjectTasksViewState,
  PropertyFilter,
  ResolvedConfig,
} from '../settings/types';
import type { StatusRegistry } from '../status/StatusRegistry';
import { ACTIVE_STATUS_GROUPS, ALL_STATUS_GROUPS, TYPE_LABELS } from '../status/statusConstants';
import { searchTaskList, selectTaskList } from '../task-lists/TaskListSelector';
import type { DependencyCompletionDecision, DependencyProjectionPort } from '../tasks';
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
import { renderCollectionControls } from '../ui/collection/CollectionControls';
import { renderDependencyBadge } from '../ui/dependencyPresentation';
import { renderEntityActionLayer } from '../ui/entity/EntityActionLayer';
import { EntityPresentation } from '../ui/entity/EntityPresentation';
import { inspectorSelectionKey, type InspectorSelection } from '../ui/inspector/InspectorSelection';
import { nextOptimisticPublicationSequence } from '../ui/interaction/OptimisticOverlayStore';
import { noInteractionOwnership, type InteractionOwnershipPort } from '../ui/interactionOwnership';
import { moveTaskToProjectWithRecovery } from '../ui/moveTaskToProject';
import { showMenuAtMouseEventWithFocus } from '../ui/nativeMenuFocus';
import { mountAnchoredRecurrenceEditor } from '../ui/recurrence/RecurrenceEditor';
import {
  recurrenceBadgeInput,
  renderRecurrenceBadge,
} from '../ui/recurrence/renderRecurrenceBadge';
import { renderTaskText } from '../ui/renderTaskText';
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
  presentBulkTaskCommandResults,
  presentTaskCommandResult,
  requestTaskCompletion,
  type CreationResultDescription,
} from '../ui/taskCommandResult';
import { openInFile } from '../ui/taskNavigation';
import { applyTaskPresentationIdentity, taskPresentationKey } from '../ui/taskPresentationIdentity';
import { rootTaskRef, taskNodeLine } from '../ui/taskSelection';
import { TimedBlockKeyboardQueue } from '../ui/timedBlockKeyboardQueue';
import { MonthGridView } from '../views/MonthGridView';
import { TodayView } from '../views/TodayView';
import { WeekTimeGridView } from '../views/WeekTimeGridView';
import {
  calendarDependencyDecision,
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
import type {
  ProjectTaskCollectionEffect,
  ProjectTaskCollectionSession,
} from './projects/ProjectTaskCollectionSession';
import { ProjectWorkspaceSession } from './projects/ProjectWorkspaceSession';
import { renderProjectTasksBoard } from './projects/ProjectsBoardView';
import { ProjectsPanel, type PendingProjectBoardUndo } from './projects/ProjectsPanel';
import {
  renderContainerResponsiveTimeline,
  renderTasksTimeline,
} from './projects/ProjectsTimelineView';
import { buildBoardPreference } from './projects/boardPreferences';
import {
  createProjectActionBoardMutation,
  createTaskBoardMutation,
  type BoardMutation,
} from './projects/boardProjection';
import type { TimelinePointRole } from './projects/timelineProjection';
import type { ProjectChildRenderHandle } from './projects/viewContext';
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

type ProjectTaskVirtualRow =
  | {
      readonly kind: 'group-header';
      readonly key: string;
      readonly label: string;
      readonly count: number;
    }
  | { readonly kind: 'task'; readonly key: string; readonly action: ProjectAction };

interface MountedProjectTaskList {
  readonly owner: HTMLElement;
  readonly rows: readonly ProjectTaskVirtualRow[];
  readonly taskRowIndex: ReadonlyMap<string, number>;
  renderWindow(): void;
}

interface TaskCollectionControlBinding {
  readonly viewState: ListViewState;
  readonly defaults: ListViewState;
  readonly onUpdate: (next: ListViewState) => void;
  readonly onRemoveFilter?: (index: number) => void;
}

type CalendarCapturePlacement =
  | { readonly type: 'calendar-timed'; readonly date: string; readonly time: string }
  | { readonly type: 'calendar-all-day'; readonly date: string }
  | { readonly type: 'calendar-month'; readonly date: string };

type BarCapturePlacement =
  | { readonly type: 'list'; readonly selectionKey: string }
  | { readonly type: 'project'; readonly path: string; readonly statusSymbol?: string };

type PanelCapturePlacement = BarCapturePlacement | CalendarCapturePlacement;

interface PanelCaptureSession {
  readonly requestId: number;
  readonly placement: PanelCapturePlacement;
  readonly controller: TaskCaptureController;
  surface?: CaptureSurface;
  host?: HTMLElement;
  feedbackHost?: HTMLElement;
  returnFocus?: HTMLElement;
  restoreFocusOnClose: boolean;
  focusOnMount: boolean;
}

function isRealmHTMLElement(target: EventTarget | null): target is HTMLElement {
  if (!target || !('ownerDocument' in target)) return false;
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
  if (dom) {
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
  private offs: Array<() => void> = [];
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
  private keyboardQueue: TimedBlockKeyboardQueue | null = null;
  private pendingTimedBlockFocus: TimedBlockFocusLocator | undefined;
  private settledKeyboardSequences = new Set<number>();
  private restoredKeyboardSequences = new Set<number>();
  private committedKeyboardSequences = new Set<number>();
  private pendingTimedBlockRestorations = new Map<number, PendingTimedBlockRestoration>();
  private nextTimedBlockRestoration = 0;
  private nextTimedBlockFocusSequence = 0;
  private calendarRenderGeneration = 0;
  private taskModal: TaskModal | null = null;
  private selectedTaskKeys = new Set<string>();
  private selectionLiveEl: HTMLElement | null = null;
  private lastAnnouncedSelectionCount = 0;
  private selectionAnchorKey: string | null = null;
  private selectionFocusKey: string | null = null;
  private filterDebounce = 0;
  private refocusSearch = false;
  // Set true while a status-group toggle click is in flight, so that the
  // full re-render triggered by updateViewState re-opens the popover with
  // the "Status group" row still expanded (multi-select shouldn't close on pick).
  private reopenStatusGroupPopover = false;
  private onSaveSettings: () => Promise<void>;
  private readonly persistsSettings: boolean;
  private md = new Component();
  private searchInputEl: HTMLInputElement | null = null;
  private searchResultsEl: HTMLElement | null = null;
  private searchResultsFrame: number | null = null;

  private projectsPanel: ProjectsPanel | null = null;
  // CenterPanel survives the ProjectStore subscriber's full projects-mode redraw; the inner
  // ProjectsPanel does not. Keep Board Undo only for that redraw boundary, never in settings.
  private pendingProjectBoardUndo: PendingProjectBoardUndo | undefined;
  private pendingProjectBoardUndoObservedNext = false;
  private projectPublicationSequence = 0;
  private readonly projectPathSuccessors = new Map<string, string>();
  private readonly projectWorkspaceSession: ProjectWorkspaceSession;
  private projectTaskList: MountedProjectTaskList | null = null;
  private projectTaskListCleanup: (() => void) | null = null;
  private readonly nextActions: NextActionService | null;
  private readonly captureApplication: (TaskApplicationApi & TaskCaptureApplicationApi) | null;
  private readonly captureTargets: CaptureTargetResolver | null;
  private captureRequestId = 0;
  private resolvingCapture: {
    readonly requestId: number;
    readonly placement: PanelCapturePlacement;
  } | null = null;
  private activeCapture: PanelCaptureSession | null = null;
  private readonly navigation: PanelNavigationActions;

  constructor(
    private state: AppState,
    private app: App,
    private settings: CalendarSettings,
    private queries: TaskQueryApi,
    private statusRegistry: StatusRegistry,
    onSaveSettings?: () => Promise<void>,
    private projectStore: ProjectStore | null = null,
    private projectManager: ProjectManager | null = null,
    private tasks?: TaskApplicationApi,
    private commentTimeContext?: CommentTimeContextProvider,
    captureApplication?: TaskApplicationApi & TaskCaptureApplicationApi,
    private readonly onCreationResult: (
      result: TaskCommandResult,
      description: CreationResultDescription,
    ) => void = () => {},
    private readonly onRenderComplete: (root: HTMLElement) => void = () => {},
    private readonly interactionOwnership: InteractionOwnershipPort = noInteractionOwnership,
    navigation?: PanelNavigationActions,
    private projectSnapshots: readonly ProjectWorkspaceSnapshot[] = [],
    private readonly workNoteCommands?: WorkNoteCommandService,
    private readonly projectCommands?: ProjectCommandService,
    private readonly dependencyProjection?: DependencyProjectionPort,
    collectionState: ProjectWorkspaceSession = new ProjectWorkspaceSession(),
    private readonly currentProjectMembership?: (
      projectPath: string,
      candidate: TaskSnapshot,
    ) => boolean,
    private readonly awaitProjectMembership?: ConstructorParameters<typeof NextActionService>[2],
  ) {
    this.projectWorkspaceSession = collectionState;
    if (projectSnapshots.length > 0)
      this.projectPublicationSequence = nextOptimisticPublicationSequence(this.app);
    this.onSaveSettings = onSaveSettings ?? (async (): Promise<void> => {});
    this.persistsSettings = onSaveSettings !== undefined;
    this.projectWorkspaceSession.bindCollectionPreferences(
      settings,
      this.persistsSettings ? this.onSaveSettings : undefined,
    );
    this.captureApplication = captureApplication ?? null;
    this.nextActions = tasks
      ? new NextActionService(
          tasks,
          (projectPath, candidate) =>
            this.currentProjectMembership?.(projectPath, candidate) ??
            this.projectSnapshots.some(
              (snapshot) =>
                snapshot.project.path === projectPath &&
                snapshot.tasks.some(
                  ({ task }) =>
                    task.ref.filePath === candidate.ref.filePath &&
                    task.ref.line === candidate.ref.line,
                ),
            ),
          this.awaitProjectMembership,
        )
      : null;
    this.captureTargets = this.captureApplication
      ? new CaptureTargetResolver(this.captureApplication, settings)
      : null;
    this.navigation =
      navigation ??
      new PanelNavigator(
        state,
        settings,
        {
          calendarView: () => this.calendarView(),
          setCalendarView: (view) => this.setCalendarView(view),
          openQuickCapture: () => undefined,
        },
        this.onSaveSettings,
        this.projectWorkspaceSession,
      );
    if (tasks) {
      this.keyboardQueue = new TimedBlockKeyboardQueue(tasks, {
        onCommitted: (task, intent, sequence, changed) => {
          this.handleKeyboardCommit(task, intent, sequence, changed);
        },
        onSettled: (_taskKey, sequence, summary) => {
          if (this.pendingTimedBlockFocus?.queueSequence === sequence) {
            if (
              (summary.anyChanged || summary.sourceChanged) &&
              !this.committedKeyboardSequences.has(sequence)
            ) {
              this.committedKeyboardSequences.add(sequence);
              this.deferTimedBlockFocus(this.el, this.calendarRenderGeneration);
            }
            const pendingRestoration = this.hasPendingTimedBlockRestoration(sequence);
            if (
              (!summary.anyChanged && !summary.sourceChanged && !pendingRestoration) ||
              this.restoredKeyboardSequences.has(sequence)
            ) {
              this.clearTimedBlockFocus(sequence);
            } else {
              this.settledKeyboardSequences.add(sequence);
            }
          }
        },
        present: (result) => {
          presentTaskCommandResult(result);
          if (result.type !== 'ok' || result.outcome.type !== 'task') {
            this.clearTimedBlockFocus();
          }
        },
      });
    }
  }

  private handleCollectionKeyDown(event: KeyboardEvent): void {
    const projectSession =
      this.state.get('mode') === 'projects' && this.projectTaskList
        ? this.projectWorkspaceSession.tasks
        : null;
    if (this.clearCollectionSelection(event, projectSession)) return;
    if (projectSession && this.handleProjectCollectionKey(event, projectSession)) return;
    this.handleTaskCollectionKey(event);
  }

  private clearCollectionSelection(
    event: KeyboardEvent,
    projectSession: ProjectTaskCollectionSession | null,
  ): boolean {
    if (event.key !== 'Escape') return false;
    const hasSelection =
      (projectSession?.selectedCount() ?? 0) > 0 ||
      this.selectedTaskKeys.size > 0 ||
      this.selectionAnchorKey !== null ||
      this.selectionFocusKey !== null;
    if (!hasSelection) return false;
    projectSession?.clearSelection();
    this.selectedTaskKeys.clear();
    this.selectionAnchorKey = null;
    this.selectionFocusKey = null;
    this.updateSelectionVisuals();
    return true;
  }

  private handleProjectCollectionKey(
    event: KeyboardEvent,
    session: ProjectTaskCollectionSession,
  ): boolean {
    const keys = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp']);
    if (!keys.has(event.key) || !this.projectTaskList) return false;
    const target = event.target;
    if (
      isRealmHTMLElement(target) &&
      target.closest(
        'input, textarea, select, button, a, [contenteditable]:not([contenteditable="false"]), .abyss-status-marker, .abyss-popover',
      )
    ) {
      return true;
    }
    event.preventDefault();
    if (event.key === 'Home' || event.key === 'End') {
      session.moveFocus({
        type: event.key === 'Home' ? 'home' : 'end',
        extendSelection: event.shiftKey,
      });
    } else if (event.key === 'PageDown' || event.key === 'PageUp') {
      session.moveFocus({
        type: 'page',
        pages: event.key === 'PageDown' ? 1 : -1,
        pageSize: Math.max(1, Math.floor(this.projectTaskList.owner.clientHeight / 56)),
        extendSelection: event.shiftKey,
      });
    } else {
      session.moveFocus({
        type: 'step',
        delta: event.key === 'ArrowDown' ? 1 : -1,
        extendSelection: event.shiftKey,
      });
    }
    this.updateSelectionVisuals();
    this.applyProjectTaskEffect(session.consumeEffect() ?? session.restoreEffect());
    return true;
  }

  private handleTaskCollectionKey(event: KeyboardEvent): void {
    if (
      (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') ||
      this.state.get('mode') !== 'tasks'
    ) {
      return;
    }
    const target = event.target;
    if (
      isRealmHTMLElement(target) &&
      target.closest(
        'input, textarea, select, button, a, [contenteditable]:not([contenteditable="false"]), .abyss-status-marker, .abyss-popover',
      )
    ) {
      return;
    }
    const keys = this.visibleTaskKeys();
    if (keys.length === 0) return;
    event.preventDefault();
    const targetCard = isRealmHTMLElement(target)
      ? target.closest<HTMLElement>('.abyss-task-card')
      : null;
    const targetKey =
      targetCard && this.el.contains(targetCard)
        ? `${targetCard.dataset['filePath'] ?? ''}:${targetCard.dataset['line'] ?? ''}`
        : null;
    const detailCard = this.visibleTaskCards().find((card) =>
      card.classList.contains('is-selected'),
    );
    const detailKey = detailCard
      ? `${detailCard.dataset['filePath'] ?? ''}:${detailCard.dataset['line'] ?? ''}`
      : null;
    const currentKey = [this.selectionFocusKey, targetKey, detailKey].find(
      (candidate): candidate is string => candidate !== null && keys.includes(candidate),
    );
    const currentIndex = currentKey ? keys.indexOf(currentKey) : -1;
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    let nextIndex: number;
    if (currentIndex >= 0) {
      nextIndex = Math.max(0, Math.min(keys.length - 1, currentIndex + delta));
    } else {
      nextIndex = event.key === 'ArrowDown' ? 0 : keys.length - 1;
    }
    const nextKey = keys[nextIndex];
    if (!nextKey) return;
    if (event.shiftKey) {
      const anchor =
        this.selectionAnchorKey && keys.includes(this.selectionAnchorKey)
          ? this.selectionAnchorKey
          : currentKey;
      this.selectionAnchorKey = anchor ?? nextKey;
      this.selectionFocusKey = nextKey;
      this.replaceRangeSelection(this.selectionAnchorKey, nextKey, keys);
    } else {
      this.selectedTaskKeys.clear();
      this.selectionAnchorKey = nextKey;
      this.selectionFocusKey = nextKey;
      this.updateSelectionVisuals();
      const task = this.taskForKey(nextKey);
      if (task) this.state.set('taskStack', [task]);
    }
    this.focusTaskKey(nextKey);
  }

  mount(container: HTMLElement): void {
    this.el = container;
    this.forecastMenuOwner = createForecastContextMenuOwner(
      container.ownerDocument,
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
      this.dependencyProjection,
    );

    // Initialize per-list state before first render
    const initialKey = listSelectionToKey(this.state.get('selectedList'));
    this.projectWorkspaceSession.activateMainTaskCollection(initialKey);
    const initialVs = this.mainTaskViewState();
    this.projectWorkspaceSession.updateMainTaskSession({
      query: this.state.get('centerFilter'),
    });
    if (this.persistsSettings) this.state.set('centerListViewState', initialVs);
    if (this.tasks) {
      this.offs.push(
        subscribeProjectedNextActions(this.tasks, () => {
          if (this.state.get('mode') === 'projects') this.refresh();
        }),
      );
    }

    this.offs.push(
      this.state.on('selectedList', () => {
        this.projectWorkspaceSession.activateMainTaskCollection(this.activeListKey());
        this.cancelStaleListCapture();
        this.selectedTaskKeys.clear();
        this.selectionAnchorKey = null;
        this.selectionFocusKey = null;
      }),
      this.state.on('mode', () => {
        this.cancelStaleListCapture();
        this.cancelKeyboardInteraction();
        this.selectedTaskKeys.clear();
        this.selectionAnchorKey = null;
        this.selectionFocusKey = null;
      }),
      this.state.on('searchQuery', (query) => this.handleSearchQueryChanged(query)),
      this.state.on('taskStack', () => {
        const stack = this.state.get('taskStack');
        const root = stack[0];
        const current = stack[stack.length - 1];
        if (
          this.state.get('mode') === 'projects' &&
          this.projectWorkspaceSession.tasks.orderedActions().length > 0
        ) {
          const session = this.projectWorkspaceSession.tasks;
          if (root) session.setInspector(rootTaskRef(root));
          else session.setInspector(null);
          this.applyProjectTaskEffect(session.consumeEffect());
        }
        this.el.querySelectorAll<HTMLElement>('.abyss-task-card').forEach((card) => {
          const isSelected =
            root !== undefined &&
            current !== undefined &&
            card.dataset['filePath'] === rootTaskRef(root).filePath &&
            card.dataset['line'] === String(taskNodeLine(root as TaskSnapshot, current));
          card.classList.toggle('is-selected', isSelected);
        });
      }),
      this.state.onCommit((changed) => {
        if (changed.size === 0 && this.state.get('mode') === 'calendar') {
          this.cancelKeyboardInteraction();
        }
        if (
          changed.size === 0 ||
          changed.has('selectedList') ||
          changed.has('centerListViewState') ||
          changed.has('centerFilter') ||
          changed.has('mode')
        ) {
          this.render();
        }
      }),
    );
    this.render();
    this.el.setAttribute('tabindex', '0');
    const onKeyDown = (e: KeyboardEvent): void => this.handleCollectionKeyDown(e);
    this.el.addEventListener('keydown', onKeyDown);
    this.offs.push(() => this.el.removeEventListener('keydown', onKeyDown));
    const onFocusIn = (event: FocusEvent): void => {
      const target = event.target;
      const taskDateFocusKey = this.taskDateFocusContinuityKey;
      if (taskDateFocusKey !== null && this.taskDateTriggerKey(target) !== taskDateFocusKey) {
        this.abandonTaskDateFocus();
      }
      if (!isRealmHTMLElement(target)) return;
      const projectWorkspace = this.el.querySelector<HTMLElement>('[data-project-workspace]');
      if (
        this.state.get('mode') === 'projects' &&
        projectWorkspace &&
        !projectWorkspace.contains(target)
      ) {
        this.projectWorkspaceSession.tasks.intentionalBlur();
      }
      const ownerDocument = this.el.ownerDocument;
      // Calendar remount removal can leave body as activeElement without emitting focusin. An
      // actual body focusin has already revoked task-date ownership above; timed-block restoration
      // still treats body/documentElement as transient renderer state.
      if (target === ownerDocument.body || target === ownerDocument.documentElement) return;
      const block = target.closest<HTMLElement>('.abyss-tg-block');
      if (block && this.el.contains(block)) {
        this.retainTimedBlockFocus(block);
      } else if (this.pendingTimedBlockFocus) {
        this.cancelKeyboardInteraction();
      }
    };
    const ownerDocument = this.el.ownerDocument;
    ownerDocument.addEventListener('focusin', onFocusIn);
    this.offs.push(() => ownerDocument.removeEventListener('focusin', onFocusIn));
    const onPointerDown = (event: PointerEvent): void => {
      const taskDateFocusKey = this.taskDateFocusContinuityKey;
      if (taskDateFocusKey !== null && this.taskDateTriggerKey(event.target) !== taskDateFocusKey) {
        this.abandonTaskDateFocus();
      }
    };
    ownerDocument.addEventListener('pointerdown', onPointerDown, true);
    this.offs.push(() => ownerDocument.removeEventListener('pointerdown', onPointerDown, true));
    const ownerWindow = ownerDocument.defaultView;
    const onOwnerWindowBlur = (): void => {
      this.abandonTaskDateFocus();
      if (this.pendingTimedBlockFocus) this.cancelKeyboardInteraction();
    };
    ownerWindow?.addEventListener('blur', onOwnerWindowBlur);
    this.offs.push(() => ownerWindow?.removeEventListener('blur', onOwnerWindowBlur));
  }

  refresh(): void {
    if (
      this.state.get('mode') === 'search' &&
      this.searchInputEl?.isConnected &&
      this.searchResultsEl?.isConnected
    ) {
      this.scheduleSearchResults(this.state.get('searchQuery'));
      return;
    }
    this.render();
  }

  /** Clears the scope-local child remembered by the common inspector close action. */
  closeProjectChildInspector(selection: InspectorSelection): void {
    if (selection.type === 'task') {
      this.projectWorkspaceSession.tasks.setInspector(null);
      return;
    }
    if (selection.type !== 'work-note') return;
    const session = this.projectWorkspaceSession.scopeSession('work-notes');
    if (session.selection.inspectorKey === selection.path) {
      session.selection.inspectorKey = null;
    }
    if (this.projectWorkspaceSession.workNotes.inspectorPath === selection.path) {
      this.projectWorkspaceSession.workNotes.inspectorPath = null;
    }
  }

  renameProjectWorkspacePath(sourcePath: string, destinationPath: string): void {
    this.projectWorkspaceSession.renamePath(sourcePath, destinationPath);
    this.projectPathSuccessors.set(sourcePath, destinationPath);
    if (this.pendingProjectBoardUndo?.path === sourcePath) {
      this.pendingProjectBoardUndo = {
        ...this.pendingProjectBoardUndo,
        path: destinationPath,
      };
    }
  }

  setProjectSnapshots(snapshots: readonly ProjectWorkspaceSnapshot[]): void {
    this.projectSnapshots = snapshots;
    this.projectPublicationSequence = nextOptimisticPublicationSequence(this.app);
  }

  private isProjectPathSuccessor(sourcePath: string, destinationPath: string): boolean {
    const visited = new Set<string>();
    let current: string | undefined = sourcePath;
    while (current && !visited.has(current)) {
      if (current === destinationPath) return true;
      visited.add(current);
      current = this.projectPathSuccessors.get(current);
    }
    return false;
  }

  projectCaptureContext(projectPath: string, requestedStatusSymbol?: string): CaptureContext {
    const focusedRef = this.projectWorkspaceSession.tasks.focusedRef();
    const focused = focusedRef
      ? this.projectWorkspaceSession.tasks.actionForRef(focusedRef)
      : undefined;
    const task =
      this.projectWorkspaceSession.scope === 'tasks' && focused?.projectPath === projectPath
        ? focused.task
        : undefined;
    const selectedBoardStatus =
      this.projectWorkspaceSession.scope === 'tasks' &&
      this.projectWorkspaceSession.layout === 'board'
        ? this.statusRegistry
            .all()
            .find(({ id }) => id === this.projectWorkspaceSession.taskBoard.selectedColumnKey)
            ?.symbol
        : undefined;
    const statusSymbol = requestedStatusSymbol ?? selectedBoardStatus ?? task?.statusSymbol;
    const priority = requestedStatusSymbol === undefined ? task?.priority : undefined;
    return {
      type: 'project-workspace',
      projectPath,
      destinationPath: projectPath,
      ...(statusSymbol !== undefined && { statusSymbol }),
      ...(priority !== undefined && { priority }),
    };
  }

  private neutralProjectCaptureContext(projectPath: string): CaptureContext {
    return { type: 'project-workspace', projectPath, destinationPath: projectPath };
  }

  private reconcilePendingProjectBoardUndo(): void {
    const pending = this.pendingProjectBoardUndo;
    if (!pending) return;
    const statusId = this.projectSnapshots.find(({ project }) => project.path === pending.path)
      ?.project.statusId;
    if (statusId === pending.result.nextStatusId) {
      this.pendingProjectBoardUndoObservedNext = true;
      return;
    }
    if (!this.pendingProjectBoardUndoObservedNext && statusId === pending.result.previousStatusId) {
      return;
    }
    this.pendingProjectBoardUndo = undefined;
    this.pendingProjectBoardUndoObservedNext = false;
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
    this.offs.forEach((f) => f());
    this.destroyCalendarView();
    this.destroyProjectTaskList();
    this.destroyProjectsPanel();
    this.projectWorkspaceSession.destroy();
    this.md.unload();
    this.el?.empty();
    this.selectionLiveEl = null;
  }

  private destroyProjectsPanel(preserveWorkspaceSession = false): void {
    this.projectsPanel?.destroy({ preserveWorkspaceSession });
    this.projectsPanel = null;
  }

  private destroyProjectTaskList(): void {
    this.projectTaskListCleanup?.();
    this.projectTaskListCleanup = null;
    this.projectTaskList = null;
  }

  /** Renders a project's tasks (reusing the card component) plus an add bar that writes into the note. */
  private renderProjectTasks(
    host: HTMLElement,
    path: string,
    actions: readonly ProjectAction[],
    viewState: ProjectTasksViewState = this.settings.projects.view.tasks,
    allActions: readonly ProjectAction[] = actions,
    onAddPropertyFilter: (filter: PropertyFilter) => void = (filter) =>
      this.addPropertyFilter(filter),
  ): ProjectChildRenderHandle {
    this.destroyProjectTaskList();
    const scroll = host.createDiv({ cls: 'abyss-center-scroll abyss-project-tasks-scroll' });
    scroll.dataset['virtualScrollOwner'] = 'project-tasks';
    if (actions.length === 0) {
      scroll.createDiv({ cls: 'abyss-center-empty', text: 'No tasks yet' });
    } else {
      this.mountProjectTaskCollection(
        scroll,
        path,
        actions,
        viewState,
        allActions,
        onAddPropertyFilter,
      );
    }

    const bar = host.createDiv({ cls: 'abyss-add-task-bar' });
    this.renderCaptureHost(bar, { type: 'project', path });
    this.completeTaskCardRender();
    return {
      destroy: () => {
        if (this.projectTaskList?.owner === scroll) this.destroyProjectTaskList();
        host.empty();
      },
    };
  }

  private projectTaskRows(
    actions: readonly ProjectAction[],
    viewState: ProjectTasksViewState,
  ): {
    readonly rows: readonly ProjectTaskVirtualRow[];
    readonly orderedActions: readonly ProjectAction[];
  } {
    const actionByKey = new Map(
      actions.map((action) => [taskPresentationKey(action.task.ref), action] as const),
    );
    const taskRow = (task: TaskSnapshot): ProjectTaskVirtualRow => {
      const key = taskPresentationKey(task.ref);
      const action = actionByKey.get(key);
      if (!action) throw new Error(`Missing ProjectAction for ${key}`);
      return { kind: 'task', key, action };
    };
    const groupBy = viewState.groupBy;
    if (groupBy === 'none') {
      return {
        rows: actions.map(({ task }) => taskRow(task)),
        orderedActions: [...actions],
      };
    }
    const tasks = actions.map(({ task }) => task);
    const today = localDate(window.moment().format('YYYY-MM-DD'));
    const tomorrow = window.moment().add(1, 'day').format('YYYY-MM-DD');
    let groups;
    switch (groupBy) {
      case 'date':
        groups = groupTasksByDate([...tasks], today, tomorrow);
        break;
      case 'priority':
        groups = groupTasksByPriority([...tasks]);
        break;
      case 'status':
        groups = groupTasksByStatus([...tasks], this.statusRegistry);
        break;
      case 'tag':
        groups = groupTasksByTag([...tasks]);
        break;
    }
    const rows: ProjectTaskVirtualRow[] = [];
    const orderedActions: ProjectAction[] = [];
    let groupIndex = 0;
    for (const group of groups) {
      if (group.tasks.length === 0) continue;
      rows.push({
        kind: 'group-header',
        key: `group:${groupBy}:${String(groupIndex)}:${group.label}`,
        label: group.label,
        count: group.tasks.length,
      });
      groupIndex += 1;
      for (const task of group.tasks) {
        const key = taskPresentationKey(task.ref);
        const action = actionByKey.get(key);
        if (!action) throw new Error(`Missing ProjectAction for ${key}`);
        const row: ProjectTaskVirtualRow = { kind: 'task', key, action };
        rows.push(row);
        orderedActions.push(action);
      }
    }
    return { rows, orderedActions };
  }

  private mountProjectTaskCollection(
    owner: HTMLElement,
    projectPath: string,
    actions: readonly ProjectAction[],
    viewState: ProjectTasksViewState,
    allActions: readonly ProjectAction[] = actions,
    onAddPropertyFilter: (filter: PropertyFilter) => void = (filter) =>
      this.addPropertyFilter(filter),
  ): void {
    const { rows, orderedActions } = this.projectTaskRows(actions, viewState);
    const session = this.projectWorkspaceSession.tasks;
    session.setResolver((ref) => this.queries.resolve(ref));
    session.reconcile(orderedActions, allActions);
    const geometry = this.projectWorkspaceSession.taskListGeometry;
    const rowKeys = rows.map(({ key }) => key);
    geometry.setKeys(rowKeys);
    for (const row of rows) {
      if (geometry.hasMeasurement(row.key)) continue;
      let estimate = 56;
      if (row.kind === 'group-header') estimate = 36;
      else if (row.action.task.description) estimate = 88;
      geometry.measure(row.key, estimate);
    }

    const topSpacer = owner.createDiv({
      cls: 'abyss-project-virtual-spacer',
      attr: { 'data-virtual-spacer': 'top', 'aria-hidden': 'true' },
    });
    const rowsHost = owner.createDiv({ cls: 'abyss-project-virtual-rows' });
    const bottomSpacer = owner.createDiv({
      cls: 'abyss-project-virtual-spacer',
      attr: { 'data-virtual-spacer': 'bottom', 'aria-hidden': 'true' },
    });
    const viewport = this.projectWorkspaceSession.taskListViewport;
    const viewportExtent = Math.max(1, owner.clientHeight);
    const seeded = geometry.seed({
      firstKey: viewport.firstRowKey,
      firstIndex: viewport.firstIndex,
      viewportExtent,
    });
    owner.dataset['virtualTotalExtent'] = String(seeded.totalExtent);
    bottomSpacer.style.height = `${String(seeded.totalExtent)}px`;
    if (seeded.scrollTop > 0) owner.scrollTop = seeded.scrollTop;

    const taskRowIndex = new Map<string, number>();
    rows.forEach((row, index) => {
      if (row.kind === 'task') taskRowIndex.set(taskPresentationKey(row.action.task.ref), index);
    });
    let rendering = false;
    let rerenderAfterMeasurement = false;
    let lastRangeStart = -1;
    let lastRangeEnd = -1;
    let renderWindow: () => void = () => {};
    const captureAnchor = (): {
      readonly key: string | null;
      readonly intraRowOffset: number;
    } => {
      const range = geometry.range({
        scrollTop: owner.scrollTop,
        viewportExtent: Math.max(1, owner.clientHeight),
      });
      return {
        key: rows[range.firstVisible]?.key ?? null,
        intraRowOffset: owner.scrollTop - geometry.offsetOf(range.firstVisible),
      };
    };
    const restoreAnchor = (anchor: {
      readonly key: string | null;
      readonly intraRowOffset: number;
    }): void => {
      if (anchor.key === null) return;
      const index = rowKeys.indexOf(anchor.key);
      if (index < 0) return;
      owner.scrollTop = geometry.offsetOf(index) + anchor.intraRowOffset;
    };
    const measureRows = (
      measurements: readonly { readonly element: HTMLElement; readonly extent: number }[],
    ): void => {
      if (measurements.length === 0) return;
      const anchor = captureAnchor();
      let changed = false;
      for (const { element, extent } of measurements) {
        const key = element.dataset['virtualRowKey'];
        if (key && extent > 0) changed = geometry.measure(key, extent) || changed;
      }
      if (!changed) return;
      restoreAnchor(anchor);
      lastRangeStart = -1;
      lastRangeEnd = -1;
      if (rendering) rerenderAfterMeasurement = true;
      else renderWindow();
    };
    const ResizeObserverCtor = owner.ownerDocument.defaultView?.ResizeObserver;
    const resizeObserver = ResizeObserverCtor
      ? new ResizeObserverCtor((entries: ResizeObserverEntry[]) => {
          measureRows(
            entries.flatMap((entry) => {
              if (!isRealmHTMLElement(entry.target)) return [];
              const borderBox = entry.borderBoxSize?.[0];
              const extent = borderBox?.blockSize ?? entry.contentRect.height;
              return [{ element: entry.target, extent }];
            }),
          );
        })
      : null;
    renderWindow = (): void => {
      if (rendering) return;
      rendering = true;
      rerenderAfterMeasurement = false;
      try {
        const range = geometry.range({
          scrollTop: owner.scrollTop,
          viewportExtent: Math.max(1, owner.clientHeight),
        });
        viewport.firstIndex = range.firstVisible;
        viewport.firstRowKey = rows[range.firstVisible]?.key ?? null;
        owner.dataset['virtualFirstVisible'] = viewport.firstRowKey ?? '';
        owner.dataset['virtualTotalExtent'] = String(range.totalExtent);
        topSpacer.style.height = `${String(range.startSpacer)}px`;
        bottomSpacer.style.height = `${String(range.endSpacer)}px`;
        if (range.start !== lastRangeStart || range.end !== lastRangeEnd) {
          resizeObserver?.disconnect();
          rowsHost.empty();
          const mountedRows: HTMLElement[] = [];
          for (let index = range.start; index < range.end; index += 1) {
            const row = rows[index]!;
            if (row.kind === 'group-header') {
              const element = rowsHost.createDiv({
                cls:
                  index === 0
                    ? 'abyss-group-header abyss-group-header--first'
                    : 'abyss-group-header',
                text: `${row.label}  ${String(row.count)}`,
                attr: {
                  'data-virtual-row-kind': 'group-header',
                  'data-virtual-row-key': row.key,
                  'data-virtual-row-index': String(index),
                },
              });
              mountedRows.push(element);
            } else {
              const card = this.renderTaskCard(rowsHost, row.action.task, {
                projectPath,
                dependencyDecision: row.action.dependency,
                projectTaskCollection: true,
                ...(this.tasks && {
                  nextActionState: (task) => projectedNextAction(this.tasks!, task),
                }),
                onAddPropertyFilter,
              });
              card.dataset['virtualRowKind'] = 'task';
              card.dataset['virtualRowKey'] = row.key;
              card.dataset['virtualRowIndex'] = String(index);
              mountedRows.push(card);
            }
          }
          for (const element of mountedRows) resizeObserver?.observe(element);
          lastRangeStart = range.start;
          lastRangeEnd = range.end;
          this.updateSelectionVisuals();
          measureRows(
            mountedRows.map((element) => ({
              element,
              extent: element.getBoundingClientRect().height,
            })),
          );
        }
      } finally {
        rendering = false;
      }
      if (rerenderAfterMeasurement) renderWindow();
    };
    const onScroll = (): void => renderWindow();
    const onResize = (): void => {
      lastRangeStart = -1;
      lastRangeEnd = -1;
      renderWindow();
    };
    const ownerResizeObserver = ResizeObserverCtor
      ? new ResizeObserverCtor(() => onResize())
      : null;
    owner.addEventListener('scroll', onScroll);
    owner.ownerDocument.defaultView?.addEventListener('resize', onResize);
    ownerResizeObserver?.observe(owner);
    this.projectTaskList = { owner, rows, taskRowIndex, renderWindow };
    this.projectTaskListCleanup = () => {
      resizeObserver?.disconnect();
      ownerResizeObserver?.disconnect();
      owner.removeEventListener('scroll', onScroll);
      owner.ownerDocument.defaultView?.removeEventListener('resize', onResize);
    };
    renderWindow();
    this.applyProjectTaskEffect(session.consumeEffect() ?? session.restoreEffect());
  }

  private applyProjectTaskEffect(effect: ProjectTaskCollectionEffect | null): void {
    if (!effect) return;
    const mounted = this.projectTaskList;
    if (mounted && effect.scrollTo) {
      const rowIndex = mounted.taskRowIndex.get(taskPresentationKey(effect.scrollTo));
      if (rowIndex !== undefined) {
        const geometry = this.projectWorkspaceSession.taskListGeometry;
        const rowTop = geometry.offsetOf(rowIndex);
        const rowBottom = rowTop + geometry.extentOf(mounted.rows[rowIndex]!.key);
        const viewportBottom = mounted.owner.scrollTop + mounted.owner.clientHeight;
        if (rowTop < mounted.owner.scrollTop) mounted.owner.scrollTop = rowTop;
        else if (rowBottom > viewportBottom) {
          mounted.owner.scrollTop = Math.max(0, rowBottom - mounted.owner.clientHeight);
        }
        mounted.renderWindow();
      }
    }
    if (mounted && effect.focus) {
      const wanted = taskPresentationKey(effect.focus);
      const cards = Array.from(mounted.owner.querySelectorAll<HTMLElement>('.abyss-task-card'));
      for (const card of cards) card.tabIndex = -1;
      const target = cards.find((card) => card.getAttribute('data-abyss-task-ref-key') === wanted);
      if (target) {
        target.tabIndex = 0;
        target.focus({ preventScroll: true });
      }
    }
    if ('inspect' in effect) {
      const action = effect.inspect
        ? this.projectWorkspaceSession.tasks.actionForRef(effect.inspect)
        : undefined;
      const selection = action ? ({ type: 'task', task: action.task.ref } as const) : null;
      const origin = selection
        ? (Array.from(this.el.querySelectorAll<HTMLElement>('[data-inspector-origin-key]')).find(
            (candidate) =>
              candidate.dataset['inspectorOriginKey'] === inspectorSelectionKey(selection),
          ) ?? null)
        : null;
      this.state.batch(() => {
        this.state.set('taskStack', action ? [action.task] : []);
        this.state.set('inspectorSelection', selection);
        this.state.set('inspectorOrigin', selection ? { selection, element: origin } : null);
      });
    }
    if (effect.notice) {
      const live = this.selectionLiveRegion();
      const message =
        effect.notice === 'focused-item-ambiguous'
          ? 'Focused task is ambiguous and is no longer selected'
          : 'Focused task is no longer available';
      if (live.textContent !== message) live.textContent = message;
    }
  }

  private renderProjectTaskBoard(
    host: HTMLElement,
    path: string,
    actions: readonly ProjectAction[],
    viewState: ProjectTasksViewState = this.settings.projects.view.tasks,
    allActions: readonly ProjectAction[] = actions,
    onAddPropertyFilter: (filter: PropertyFilter) => void = (filter) =>
      this.addPropertyFilter(filter),
  ): ProjectChildRenderHandle {
    this.destroyProjectTaskList();
    const session = this.projectWorkspaceSession.tasks;
    session.setResolver((ref) => this.queries.resolve(ref));
    session.reconcile(actions, allActions);
    let board: ProjectChildRenderHandle | null = null;
    {
      const statuses = this.statusRegistry.all();
      const allowedTypes = viewState.statusGroups;
      const visibleStatusIds = new Set(
        statuses
          .filter(
            ({ type }) => !allowedTypes || allowedTypes.length === 0 || allowedTypes.includes(type),
          )
          .map(({ id }) => id),
      );
      const boardHost = host.createDiv();
      const taskBoardSession = this.projectWorkspaceSession.taskBoard;
      const taskPreference = this.projectWorkspaceSession.collectionPreference(path, 'tasks');
      const preference = taskPreference.layoutPreferences['board']?.board ?? {
        ...buildBoardPreference(statuses.map(({ id }) => id)),
        terminalDefaultsApplied: true,
      };
      const openColumnCapture = (statusSymbol: string): void => {
        const placement: BarCapturePlacement = { type: 'project', path, statusSymbol };
        this.openCapture(placement, this.projectCaptureContext(path, statusSymbol));
      };
      const canonicalActions =
        this.projectSnapshots.length === 0
          ? allActions
          : [
              ...new Map(
                this.projectSnapshots
                  .flatMap((snapshot) => snapshot.tasks)
                  .map((action) => [taskPresentationKey(action.task.ref), action] as const),
              ).values(),
            ];
      board = renderProjectTasksBoard(boardHost, {
        actions,
        canonicalActions,
        ...(this.projectPublicationSequence > 0 && {
          publicationSequence: this.projectPublicationSequence,
        }),
        statuses,
        visibleColumnKeys: visibleStatusIds,
        onMoveStatus: (task, symbol) => this.setTaskStatus(task, symbol, false),
        session: taskBoardSession,
        columnPreference: preference,
        onColumnPreferenceChange: (next) =>
          this.projectWorkspaceSession
            .updateCollectionPreference(path, 'tasks', (current) => ({
              ...current,
              layoutPreferences: {
                ...current.layoutPreferences,
                board: { board: next },
              },
            }))
            .then(() => undefined),
        columnPreferenceSaving: this.projectWorkspaceSession.collectionPreferenceSaving(
          path,
          'tasks',
        ),
        autoPersistInitialColumnPreference:
          this.projectWorkspaceSession.shouldAutoPersistCollectionPreference(path, 'tasks'),
        focusedItemKey: () => {
          const focused = session.focusedRef();
          return focused ? taskPresentationKey(focused) : null;
        },
        shouldRestoreItemFocus: () => session.shouldRestoreFocus(),
        onItemFocus: ({ task }) => {
          session.focusOnly(task.ref);
          taskBoardSession.selectedColumnKey =
            statuses.find(({ symbol }) => symbol === task.statusSymbol)?.id ?? null;
        },
        onItemBlur: () => session.intentionalBlur(),
        announce: (message) => {
          this.selectionLiveRegion().textContent = message;
        },
        overlayScope: this.app,
        taskSuccessor: (observed, published) =>
          this.isTaskPublicationSuccessor(observed, published),
        renderItem: (container, action, statusGuard) =>
          this.renderTaskCard(container, action.task, {
            projectPath: path,
            dependencyDecision: action.dependency,
            projectTaskCollection: true,
            projectTaskBoard: true,
            statusMutationPending: statusGuard.pending,
            blockStatusMutationIfPending: statusGuard.blockIfPending,
            ...(this.tasks && {
              nextActionState: (task) => projectedNextAction(this.tasks!, task),
            }),
            manageStatusMenu: false,
            onAddPropertyFilter,
          }),
        renderColumnAdd: (container, status) => {
          container.addClass('abyss-add-task-bar');
          this.renderCaptureHost(container, { type: 'project', path, statusSymbol: status.symbol });
        },
        onCollapsedColumnAddRequest: (status) => openColumnCapture(status.symbol),
      });
    }
    const bar = host.createDiv({ cls: 'abyss-add-task-bar' });
    this.renderCaptureHost(bar, { type: 'project', path });
    this.completeTaskCardRender();
    this.updateSelectionVisuals();
    this.applyProjectTaskEffect(session.consumeEffect() ?? session.restoreEffect());
    return {
      destroy: () => {
        board?.destroy();
        host.empty();
      },
    };
  }

  private async setProjectTimelineTaskDate(
    task: TaskSnapshot,
    role: TimelinePointRole,
    date: string,
  ): Promise<TaskCommandResult> {
    if (!this.tasks || role === 'milestone') throw new Error('Task Timeline mutation unavailable');
    const value = localDate(date);
    let command;
    if (role === 'start' || role === 'end') {
      const ref = calendarRootTaskRef(task);
      if (!ref) throw new Error('Task Timeline target unavailable');
      command = {
        type: 'set-span-boundary' as const,
        ref,
        boundary: role === 'start' ? ('start' as const) : ('due' as const),
        date: value,
      };
    } else {
      command = calendarPatchCommand(task, {
        [role]: { type: 'set' as const, value },
      });
      if (!command) throw new Error('Task Timeline target unavailable');
    }
    const result = await this.tasks.execute(command);
    presentTaskCommandResult(result);
    return result;
  }

  private async setProjectTimelineTaskRange(
    task: TaskSnapshot,
    start: string,
    end: string,
  ): Promise<TaskCommandResult> {
    if (!this.tasks) throw new Error('Task Timeline mutation unavailable');
    const command = calendarPatchCommand(task, {
      start: { type: 'set', value: localDate(start) },
      due: { type: 'set', value: localDate(end) },
    });
    if (!command) throw new Error('Task Timeline target unavailable');
    const result = await this.tasks.execute(command);
    presentTaskCommandResult(result);
    return result;
  }

  private isTaskPublicationSuccessor(observed: TaskSnapshot, published: TaskSnapshot): boolean {
    const resolution = this.queries.resolve(observed.ref);
    let current: TaskSnapshot | undefined;
    if (resolution.type === 'exact') current = resolution.task;
    else if (resolution.type === 'rebased' || resolution.type === 'visual') {
      current = resolution.current;
    }
    return (
      current !== undefined &&
      current.ref.filePath === published.ref.filePath &&
      current.ref.line === published.ref.line &&
      current.ref.revision === published.ref.revision
    );
  }

  private renderProjectTaskTimeline(
    host: HTMLElement,
    path: string,
    actions: readonly ProjectAction[],
    _viewState: ProjectTasksViewState = this.settings.projects.view.tasks,
    allActions: readonly ProjectAction[] = actions,
    onAddPropertyFilter: (filter: PropertyFilter) => void = (filter) =>
      this.addPropertyFilter(filter),
  ): ProjectChildRenderHandle {
    this.destroyProjectTaskList();
    const session = this.projectWorkspaceSession.tasks;
    session.setResolver((ref) => this.queries.resolve(ref));
    session.reconcile(actions, allActions);
    const canonicalActions =
      this.projectSnapshots.length === 0
        ? allActions
        : [
            ...new Map(
              this.projectSnapshots
                .flatMap((snapshot) => snapshot.tasks)
                .map((action) => [taskPresentationKey(action.task.ref), action] as const),
            ).values(),
          ];
    const timelinePreference = this.projectWorkspaceSession.collectionPreference(path, 'tasks')
      .layoutPreferences['timeline']?.timeline ?? {
      version: 1 as const,
      ...this.settings.projects.view.timeline.tasks,
    };
    const timeline = renderContainerResponsiveTimeline(host, (isNarrow) =>
      renderTasksTimeline(host, {
        actions,
        canonicalActions,
        ...(this.projectSnapshots.length > 0 && {
          overlayScope: this.app,
          publicationSequence: this.projectPublicationSequence,
          taskSuccessor: (observed: TaskSnapshot, published: TaskSnapshot) =>
            this.isTaskPublicationSuccessor(observed, published),
        }),
        collectionSession: session,
        session: this.projectWorkspaceSession.timelines.tasks,
        isNarrow,
        scale: timelinePreference.scale,
        identityWidth: timelinePreference.identityWidth,
        onPresentationChange: (presentation) =>
          this.projectWorkspaceSession
            .updateCollectionPreference(path, 'tasks', (current) => ({
              ...current,
              layoutPreferences: {
                ...current.layoutPreferences,
                timeline: {
                  timeline: {
                    version: 1,
                    scale: presentation.scale,
                    identityWidth: presentation.identityWidth,
                  },
                },
              },
            }))
            .then(
              () => undefined,
              () => undefined,
            ),
        renderTask: (identity, action) => {
          this.renderTaskCard(identity, action.task, {
            projectPath: path,
            dependencyDecision: action.dependency,
            projectTaskCollection: true,
            ...(this.tasks && {
              nextActionState: (task) => projectedNextAction(this.tasks!, task),
            }),
            onAddPropertyFilter,
          });
        },
        onSetDate: (task, role, date) => this.setProjectTimelineTaskDate(task, role, date),
        onSetRange: (task, start, end) => this.setProjectTimelineTaskRange(task, start, end),
      }),
    );
    this.completeTaskCardRender();
    this.updateSelectionVisuals();
    this.applyProjectTaskEffect(session.consumeEffect() ?? session.restoreEffect());
    return {
      destroy: () => {
        timeline.destroy();
        host.empty();
      },
    };
  }

  private projectActionBoardMutation(): BoardMutation<ProjectAction> {
    return createProjectActionBoardMutation(this.statusRegistry.all(), (task, symbol) =>
      this.setTaskStatus(task, symbol),
    );
  }

  /** Compatibility seam for the shared Task board adapter tests and non-Project callers. */
  private taskBoardMutation(): BoardMutation<TaskSnapshot> {
    return createTaskBoardMutation(this.statusRegistry.all(), (task, symbol) =>
      this.setTaskStatus(task, symbol),
    );
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
    this.unmountActiveCapture();
    this.clearTaskDatePicker();
    this.dismissRecurrenceEditor();
    this.viewStatePopoverCleanup?.();
    this.clearSearchShell();
    this.destroyProjectTaskList();

    const mode = this.state.get('mode');

    if (mode !== 'search') {
      this.md.unload();
      this.md = new Component();
      this.md.load();
    }

    if (mode !== 'projects') {
      this.destroyProjectsPanel();
      this.pendingProjectBoardUndo = undefined;
      this.pendingProjectBoardUndoObservedNext = false;
      this.projectWorkspaceSession.closeProject();
    }

    if (mode === 'calendar') {
      // Explicit refreshes (configuration/theme/view changes) remain full renders.
      this.captureActiveTimedBlockFocus();
      this.pendingCalScrollTop =
        this.el.querySelector<HTMLElement>('.abyss-tg-grid-row')?.scrollTop;
      this.el.empty();
      this.el.addClass('abyss-center--calendar');
      this.destroyCalendarView();
      this.renderCalendarMode();
      return;
    }

    this.el.removeClass('abyss-center--calendar');
    this.destroyCalendarView();
    this.el.empty();

    if (mode === 'search') {
      this.renderSearch();
      return;
    }

    if (mode === 'projects') {
      this.el.addClass('abyss-center--projects');
      if (this.projectStore && this.projectManager) {
        this.reconcilePendingProjectBoardUndo();
        // Rebuild the panel fresh; it owns its own subscriptions and cleans them
        // up in destroy(), so recreating on each render is leak-free.
        this.destroyProjectsPanel(true);
        this.projectsPanel = new ProjectsPanel(
          this.state,
          this.projectStore,
          this.projectManager,
          this.settings,
          this.app,
          {
            renderTasks: (host, path, tasks, viewState, allTasks, onAddPropertyFilter) =>
              this.renderProjectTasks(host, path, tasks, viewState, allTasks, onAddPropertyFilter),
            renderTaskBoard: (host, path, tasks, viewState, allTasks, onAddPropertyFilter) =>
              this.renderProjectTaskBoard(
                host,
                path,
                tasks,
                viewState,
                allTasks,
                onAddPropertyFilter,
              ),
            renderTaskTimeline: (host, path, tasks, viewState, allTasks, onAddPropertyFilter) =>
              this.renderProjectTaskTimeline(
                host,
                path,
                tasks,
                viewState,
                allTasks,
                onAddPropertyFilter,
              ),
            snapshots: this.projectSnapshots,
            ...(this.persistsSettings ? { onSaveSettings: this.onSaveSettings } : {}),
            pendingBoardUndo: this.pendingProjectBoardUndoObservedNext
              ? this.pendingProjectBoardUndo
              : undefined,
            ...(this.projectPublicationSequence > 0 && {
              publicationSequence: this.projectPublicationSequence,
            }),
            pathSuccessor: (observedPath, publishedPath) =>
              this.isProjectPathSuccessor(observedPath, publishedPath),
            onBoardUndoPending: (pending) => {
              this.pendingProjectBoardUndo = pending;
              this.pendingProjectBoardUndoObservedNext = false;
              this.reconcilePendingProjectBoardUndo();
              if (this.pendingProjectBoardUndoObservedNext) this.refresh();
              else this.projectStore?.refresh();
            },
            boardUndoOwner: {
              started: (pending) => {
                if (this.pendingProjectBoardUndo?.result !== pending.result) return;
                this.pendingProjectBoardUndo = {
                  ...this.pendingProjectBoardUndo,
                  undoInFlight: true,
                };
              },
              resolved: (pending, successful) => {
                if (this.pendingProjectBoardUndo?.result !== pending.result) return;
                if (successful) {
                  this.pendingProjectBoardUndo = undefined;
                  this.pendingProjectBoardUndoObservedNext = false;
                } else {
                  this.pendingProjectBoardUndo = {
                    ...this.pendingProjectBoardUndo,
                    undoInFlight: false,
                  };
                }
                this.projectStore?.refresh();
                this.refresh();
              },
            },
            boardUndoTransferable: true,
            workNoteCommands: this.workNoteCommands,
            projectCommands: this.projectCommands,
            workspaceSession: this.projectWorkspaceSession,
            onAnnounce: (message) => {
              this.selectionLiveRegion().textContent = message;
            },
            onTaskContextMenu: (event, projectPath, action, anchor) =>
              this.showProjectNextActionMenu(event, projectPath, action.task, anchor),
            ...(this.tasks && {
              nextActionState: (task) => projectedNextAction(this.tasks!, task),
            }),
          },
        );
        // Mount into a dedicated child so ProjectsPanel's own class/DOM never
        // lands on the shared center element (which would leak layout into tasks mode).
        const host = this.el.createDiv({ cls: 'abyss-projects-host' });
        this.projectsPanel.mount(host);
        // Only the Project dashboard has consumed its summary and task surface;
        // do not retire a different project's bridge from the overview list.
        const visibleProject = this.state.get('projectsPanel');
        if (this.tasks && visibleProject.view === 'dashboard') {
          acknowledgeProjectedNextActions(
            this.tasks,
            visibleProject.path,
            projectedNextActionToken(this.tasks, visibleProject.path),
          );
        }
        this.onRenderComplete(this.el);
      } else {
        this.el.createDiv({ cls: 'abyss-center-empty', text: 'Projects unavailable' });
        this.onRenderComplete(this.el);
      }
      return;
    }
    this.el.removeClass('abyss-center--projects');

    // Header: title + right-aligned [chips] [↕] [search]
    const header = this.el.createDiv({ cls: 'abyss-center-header' });
    header.createEl('h2', { cls: 'abyss-center-title', text: this.getTitle() });

    const { searchInput, element: collectionControls } = renderCollectionControls(header, {
      query: this.mainTaskQuery(),
      searchLabel: 'Filter tasks',
      toolbarLabel: 'Task collection controls',
      actions: [
        {
          kind: 'filter',
          label: 'Filter',
          icon: 'list-filter',
          onActivate: (event) =>
            this.showViewStatePopover(
              event.currentTarget as HTMLElement,
              this.mainTaskCollectionControlBinding(),
            ),
        },
        {
          kind: 'group',
          label: 'Group',
          icon: 'layout-list',
          onActivate: (event) =>
            this.showViewStatePopover(
              event.currentTarget as HTMLElement,
              this.mainTaskCollectionControlBinding(),
            ),
        },
        {
          kind: 'sort',
          label: 'Sort',
          icon: 'arrow-up-down',
          className: 'abyss-view-state-btn',
          onActivate: (event) =>
            this.showViewStatePopover(
              event.currentTarget as HTMLElement,
              this.mainTaskCollectionControlBinding(),
            ),
        },
      ],
      renderActiveChips: (controls) => this.renderPropertyChips(controls),
      onQueryInput: (value) => {
        window.clearTimeout(this.filterDebounce);
        this.filterDebounce = window.setTimeout(() => {
          this.refocusSearch = true;
          this.projectWorkspaceSession.updateMainTaskSession({ query: value });
          this.state.set('centerFilter', value);
        }, 150);
      },
    });
    if (this.reopenStatusGroupPopover) {
      this.reopenStatusGroupPopover = false;
      const trigger = collectionControls.querySelector<HTMLElement>('.abyss-view-state-btn');
      if (trigger)
        this.showViewStatePopover(trigger, this.mainTaskCollectionControlBinding(), true);
    }
    if (!searchInput) throw new Error('Task collection requires a search input');
    // Restore focus + caret after a debounced filter re-render so typing stays smooth.
    if (this.refocusSearch) {
      this.refocusSearch = false;
      window.setTimeout(() => {
        searchInput.focus();
        searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);
      }, 0);
    }
    const tasks = this.getFilteredTasks();
    const scroll = this.el.createDiv({ cls: 'abyss-center-scroll' });

    if (tasks.length === 0) {
      scroll.createDiv({ cls: 'abyss-center-empty', text: 'No tasks' });
    } else {
      this.renderWithGrouping(scroll, tasks);
    }

    this.renderAddTaskBar();
    this.reconcileTaskSelection(this.visibleTaskKeys());
    this.updateSelectionVisuals();
    this.completeTaskCardRender();
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
    const nav = this.el.createDiv({ cls: 'abyss-cal-nav' });

    const leftGroup = nav.createDiv({ cls: 'abyss-cal-nav-left' });
    const prevBtn = leftGroup.createEl('button', {
      cls: 'abyss-cal-nav-btn',
      attr: { 'aria-label': 'Previous' },
    });
    setIcon(prevBtn, 'chevron-left');

    const titleGroup = leftGroup.createDiv({ cls: 'abyss-cal-nav-title-group' });
    const monthBtn = titleGroup.createEl('button', {
      cls: 'abyss-cal-nav-month',
      attr: { 'aria-haspopup': 'dialog', 'aria-expanded': 'false' },
    });
    const yearBtn = titleGroup.createEl('button', {
      cls: 'abyss-cal-nav-year',
      attr: { 'aria-haspopup': 'dialog', 'aria-expanded': 'false' },
    });

    const nextBtn = leftGroup.createEl('button', {
      cls: 'abyss-cal-nav-btn',
      attr: { 'aria-label': 'Next' },
    });
    setIcon(nextBtn, 'chevron-right');

    const rightGroup = nav.createDiv({ cls: 'abyss-cal-nav-right' });
    const todayBtn = rightGroup.createEl('button', { cls: 'abyss-cal-nav-today', text: 'Today' });

    const viewSwitcher = rightGroup.createDiv({ cls: 'abyss-cal-view-switcher' });
    const CAL_VIEWS = ['today', 'week', 'month'] as const;
    for (const v of CAL_VIEWS) {
      const btn = viewSwitcher.createEl('button', {
        cls: `abyss-cal-view-btn${this.calViewType === v ? ' is-active' : ''}`,
        text: v === 'today' ? 'Day' : v.charAt(0).toUpperCase() + v.slice(1),
      });
      btn.addEventListener('click', () => {
        this.navigation.openCalendarView(v);
      });
    }

    const viewContainer = this.el.createDiv({ cls: 'abyss-cal-body' });

    const updateTitle = (): void => {
      if (this.calViewType === 'week') {
        monthBtn.textContent = `Week ${this.calDate.format('w')}`;
        yearBtn.textContent = this.calDate.format('YYYY');
      } else if (this.calViewType === 'today') {
        monthBtn.textContent = this.calDate.format('MMMM D');
        yearBtn.textContent = this.calDate.format('YYYY');
      } else {
        monthBtn.textContent = this.calDate.format('MMMM');
        yearBtn.textContent = this.calDate.format('YYYY');
      }
    };
    updateTitle();

    const handleTaskClick = (t: TaskSnapshot): void => {
      if (calendarRootTaskRef(t) === undefined) return;
      this.taskModal?.open(t);
    };
    const handleForecastClick = (source: CalendarTaskSource, referenceDate: LocalDate): void => {
      this.taskModal?.open(source.root);
      const modal = activeDocument.querySelector<HTMLElement>('.abyss-modal');
      if (!modal) return;
      const context = modal.createDiv({
        cls: 'abyss-forecast-source-context',
        text: `Forecast for ${referenceDate}`,
      });
      modal.prepend(context);
    };
    const handleForecastContextMenu = (source: CalendarTaskSource): void => {
      this.openForecastRecurrenceEditor(viewContainer, source);
    };
    const handleDrop = (dragData: string, targetDate: string): void => {
      void this.rescheduleTask(dragData, targetDate);
    };
    const handleDropTime = (dragData: string, date: string, time: string): void => {
      void this.setTaskTimeFromDrop(dragData, date, time);
    };
    const handleTimeChange = (t: TaskSnapshot, newStartMinutes: number): void => {
      if (isForecastCalendarTask(t)) return;
      void this.updateTaskTime(t, newStartMinutes);
    };
    const handleDurationChange = (t: TaskSnapshot, newDurationMinutes: number): void => {
      if (isForecastCalendarTask(t)) return;
      void this.updateTaskDuration(t, newDurationMinutes);
    };
    const handleTimedMove = (t: TaskSnapshot, target: TimedDragTarget): void => {
      if (isForecastCalendarTask(t)) return;
      void this.commitTimedMove(t, target);
    };
    const handleTimedDuration = (t: TaskSnapshot, target: TimedVerticalResizeTarget): void => {
      if (isForecastCalendarTask(t)) return;
      void this.commitTimedDuration(t, target);
    };
    const handleTimedBoundary = (t: TaskSnapshot, target: TimedBoundaryTarget): void => {
      if (isForecastCalendarTask(t)) return;
      void this.commitTimedBoundary(t, target);
    };
    const handleSpanMove = (t: TaskSnapshot, target: SpanMoveTarget): void => {
      if (isForecastCalendarTask(t)) return;
      void this.commitSpanMove(t, target);
    };
    const handleSpanBoundary = (t: TaskSnapshot, target: InteractiveSpanBoundaryTarget): void => {
      if (isForecastCalendarTask(t)) return;
      void this.commitTimedBoundary(t, target);
    };
    const handleStartChange = (t: TaskSnapshot, newStart: string): void => {
      if (isForecastCalendarTask(t)) return;
      void this.updateTaskStart(t, newStart);
    };
    const handleDueChange = (t: TaskSnapshot, newDue: string): void => {
      if (isForecastCalendarTask(t)) return;
      void this.rescheduleTaskDue(t, newDue);
    };
    const handleExtendToSpan = (t: TaskSnapshot, newDue: string): void => {
      if (isForecastCalendarTask(t)) return;
      void this.extendTaskToSpan(t, newDue);
    };
    const handleKeyboardIntent = (task: TaskSnapshot, intent: TimedBlockKeyboardIntent): void => {
      if (calendarRootTaskRef(task) === undefined) return;
      if (!this.keyboardQueue) return;
      const active = this.el.ownerDocument.activeElement;
      const originElement = isRealmHTMLElement(active)
        ? (active.closest<HTMLElement>('.abyss-tg-block') ?? undefined)
        : undefined;
      const previousQueueSequence = this.pendingTimedBlockFocus?.queueSequence;
      const focusSequence = ++this.nextTimedBlockFocusSequence;
      const provisionalFocus: TimedBlockFocusLocator = {
        filePath: task.source.filePath,
        line: task.source.line,
        segmentDate: originElement?.dataset['tgSegmentDate'],
        sequence: focusSequence,
        originElement,
      };
      this.pendingTimedBlockFocus = provisionalFocus;
      const queueSequence = this.keyboardQueue.enqueue(task, intent);
      if (queueSequence === undefined) {
        if (this.pendingTimedBlockFocus?.sequence === focusSequence) {
          this.clearTimedBlockFocus();
        }
        if (previousQueueSequence !== undefined) {
          this.clearKeyboardSequenceState(previousQueueSequence);
        }
        return;
      }
      if (this.pendingTimedBlockFocus?.sequence !== focusSequence) return;
      if (previousQueueSequence !== undefined && previousQueueSequence !== queueSequence) {
        this.clearKeyboardSequenceState(previousQueueSequence);
      }
      this.settledKeyboardSequences.delete(queueSequence);
      if (previousQueueSequence !== queueSequence) {
        this.restoredKeyboardSequences.delete(queueSequence);
        this.committedKeyboardSequences.delete(queueSequence);
      }
      this.pendingTimedBlockFocus = {
        ...provisionalFocus,
        queueSequence,
      };
    };
    const handleCreateAtTime = (date: string, time: string): void => {
      const dayColumn = viewContainer.querySelector<HTMLElement>(
        `.abyss-tg-day-column[data-tg-date="${date}"]`,
      );
      const hourColumnEl = dayColumn?.querySelector<HTMLElement>('.abyss-tg-hour-column');
      if (!hourColumnEl) return;
      this.showTimeGridQuickAdd(hourColumnEl, date, time);
    };
    const handleCreateAtDate = (date: string): void => {
      const cell = viewContainer.querySelector<HTMLElement>(`[data-mg-date="${date}"]`);
      if (!cell) return;
      this.showFillCellQuickAdd(cell, date, 'abyss-mg-quick-add');
    };
    const handleCreateAtDateAllDay = (date: string): void => {
      // Scoped to .abyss-tg-allday-cell specifically: HourGrid.ts's day-column element also
      // carries data-tg-date (for edge-resize date resolution), so a bare attribute selector
      // would risk matching the wrong element.
      const cell = viewContainer.querySelector<HTMLElement>(
        `.abyss-tg-allday-cell[data-tg-date="${date}"]`,
      );
      if (!cell) return;
      this.showFillCellQuickAdd(cell, date, 'abyss-tg-allday-quick-add');
    };

    const startPositionFor = (viewType: CalViewType, firstDayOfWeek: number): string => {
      if (viewType === 'week') {
        return firstVisibleWeekDate(this.calDate, firstDayOfWeek);
      }
      if (viewType === 'today') return this.calDate.format('YYYY-MM-DD');
      return this.calDate.format('YYYY-MM');
    };

    const currentCalendarContent = (): {
      readonly config: ResolvedConfig;
      readonly issues: readonly CalendarProjectionIssue[];
      readonly tasks: TaskSnapshot[];
    } => {
      const firstDayOfWeek =
        this.settings.desktop.firstDayOfWeek ?? DEFAULT_VIEW_CONFIG.firstDayOfWeek;
      const config: ResolvedConfig = {
        ...DEFAULT_VIEW_CONFIG,
        ...this.settings.desktop,
        isMobile: false,
        sourceNoteDisplay: this.settings.sourceNoteDisplay,
        customFilePath: this.settings.customFilePath,
        startPosition: startPositionFor(this.calViewType, firstDayOfWeek),
      };
      const visibleDates = visibleCalendarDates(
        this.calViewType,
        this.calDate,
        config.firstDayOfWeek,
      );
      const projection = this.queries.forCalendarProjection(
        visibleDates as unknown as readonly LocalDate[],
      );
      const occurrences = projectCalendarOccurrences(
        projection,
        {
          from: localDate(visibleDates[0]!),
          to: localDate(visibleDates[visibleDates.length - 1]!),
        },
        { removeScheduledDate: this.settings.recurrence.removeScheduledDate },
      );
      return {
        config,
        issues: occurrences.issues,
        tasks: occurrences.occurrences.map(taskSnapshotForCalendarOccurrence),
      };
    };

    const mountView = (): void => {
      this.dismissRecurrenceEditor();
      forecastMenuOwner.dismiss();
      this.captureActiveTimedBlockFocus();
      this.unmountActiveCapture();
      const pendingQueueSequence = this.pendingTimedBlockFocus?.queueSequence;
      if (pendingQueueSequence !== undefined) {
        this.restoredKeyboardSequences.delete(pendingQueueSequence);
      }
      const renderGeneration = ++this.calendarRenderGeneration;
      // Full mounts replace the grid, so carry its native scroll position when this is an
      // explicit same-date refresh. Query notifications never enter this path: patchView retains
      // the grid itself. The fallback covers render() emptying the outer center before this
      // closure can inspect its former viewContainer.
      const outgoingGridRow = viewContainer.querySelector<HTMLElement>('.abyss-tg-grid-row');
      const preservedScrollTop = outgoingGridRow
        ? outgoingGridRow.scrollTop
        : this.pendingCalScrollTop;
      this.pendingCalScrollTop = undefined;

      this.calViewInstance?.destroy();
      viewContainer.empty();
      const { config, issues, tasks } = currentCalendarContent();

      // Only scroll-to-now when this (viewType, date) pair is new. Explicit same-date refreshes
      // must not jump back to center; query patches do not invoke this full-mount path.
      const scrollKey = `${this.calViewType}:${this.calDate.format('YYYY-MM-DD')}`;
      const shouldScrollToNow = scrollKey !== this.lastScrolledCalKey;
      this.lastScrolledCalKey = scrollKey;

      if (this.calViewType === 'today') {
        this.calViewInstance = new TodayView({
          app: this.app,
          forecastMenuOwner,
          onTaskClick: handleTaskClick,
          onForecastClick: handleForecastClick,
          onForecastContextMenu: handleForecastContextMenu,
          dependencyDecision: (task) => calendarDependencyDecision(task, this.dependencyProjection),
          onDrop: handleDrop,
          onDropTime: handleDropTime,
          onCreateAtTime: handleCreateAtTime,
          onCreateAtDate: handleCreateAtDateAllDay,
          onTimeChange: handleTimeChange,
          onDurationChange: handleDurationChange,
          onTimedMove: handleTimedMove,
          onTimedDuration: handleTimedDuration,
          onTimedBoundary: handleTimedBoundary,
          onSpanMove: handleSpanMove,
          onSpanBoundary: handleSpanBoundary,
          onStartChange: handleStartChange,
          onDueChange: handleDueChange,
          onExtendToSpan: handleExtendToSpan,
          onKeyboardIntent: handleKeyboardIntent,
          onToggle: (t) => {
            void this.toggleTask(t);
          },
          onSetStatus: (t, status) => {
            void this.setTaskStatus(t, status);
          },
          onSetPriority: (t, priority) => {
            void this.setPriority(t, priority);
          },
          interactionOwnership: this.interactionOwnership,
          statusRegistry: this.statusRegistry,
          tagGroups: this.settings.tagGroups,
        });
      } else if (this.calViewType === 'week') {
        this.calViewInstance = new WeekTimeGridView({
          app: this.app,
          forecastMenuOwner,
          onTaskClick: handleTaskClick,
          onForecastClick: handleForecastClick,
          onForecastContextMenu: handleForecastContextMenu,
          dependencyDecision: (task) => calendarDependencyDecision(task, this.dependencyProjection),
          onDrop: handleDrop,
          onDropTime: handleDropTime,
          onCreateAtTime: handleCreateAtTime,
          onCreateAtDate: handleCreateAtDateAllDay,
          onDayHeaderClick: (date) => {
            this.cancelKeyboardInteraction();
            this.calViewType = 'today';
            this.calDate = window.moment(date);
            this.render();
          },
          onTimeChange: handleTimeChange,
          onDurationChange: handleDurationChange,
          onTimedMove: handleTimedMove,
          onTimedDuration: handleTimedDuration,
          onTimedBoundary: handleTimedBoundary,
          onSpanMove: handleSpanMove,
          onSpanBoundary: handleSpanBoundary,
          onStartChange: handleStartChange,
          onDueChange: handleDueChange,
          onExtendToSpan: handleExtendToSpan,
          onKeyboardIntent: handleKeyboardIntent,
          onToggle: (t) => {
            void this.toggleTask(t);
          },
          onSetStatus: (t, status) => {
            void this.setTaskStatus(t, status);
          },
          onSetPriority: (t, priority) => {
            void this.setPriority(t, priority);
          },
          interactionOwnership: this.interactionOwnership,
          statusRegistry: this.statusRegistry,
          tagGroups: this.settings.tagGroups,
        });
      } else {
        this.calViewInstance = new MonthGridView({
          app: this.app,
          forecastMenuOwner,
          onDayClick: (date) => {
            this.cancelKeyboardInteraction();
            this.calViewType = 'today';
            this.calDate = window.moment(date);
            this.render();
          },
          onCreateAtDate: handleCreateAtDate,
          onTaskClick: handleTaskClick,
          onForecastClick: handleForecastClick,
          onForecastContextMenu: handleForecastContextMenu,
          dependencyDecision: (task) => calendarDependencyDecision(task, this.dependencyProjection),
          onDrop: handleDrop,
          onSpanMove: handleSpanMove,
          onSpanBoundary: handleSpanBoundary,
          onToggle: (t) => {
            void this.toggleTask(t);
          },
          onSetStatus: (t, status) => {
            void this.setTaskStatus(t, status);
          },
          onSetPriority: (t, priority) => {
            void this.setPriority(t, priority);
          },
          onWeekClick: (wk, yr) => {
            this.cancelKeyboardInteraction();
            this.calViewType = 'week';
            this.calDate = window
              .moment()
              .isoWeekYear(parseInt(yr, 10))
              .isoWeek(parseInt(wk, 10))
              .startOf('isoWeek');
            this.render();
          },
          interactionOwnership: this.interactionOwnership,
          statusRegistry: this.statusRegistry,
          tagGroups: this.settings.tagGroups,
        });
      }
      this.calViewInstance.render(
        viewContainer,
        tasks,
        config,
        shouldScrollToNow,
        preservedScrollTop,
      );
      projectionDiagnosticOwner.update(viewContainer, issues);
      this.remountActiveCapture();
      this.onRenderComplete(viewContainer);
      this.deferTimedBlockFocus(viewContainer, renderGeneration);
    };

    const patchView = (): void => {
      if (!this.calViewInstance) {
        mountView();
        return;
      }
      this.dismissRecurrenceEditor();
      forecastMenuOwner.dismiss();
      this.captureActiveTimedBlockFocus();
      const pendingQueueSequence = this.pendingTimedBlockFocus?.queueSequence;
      if (pendingQueueSequence !== undefined) {
        this.restoredKeyboardSequences.delete(pendingQueueSequence);
      }
      const renderGeneration = ++this.calendarRenderGeneration;
      const { config, issues, tasks } = currentCalendarContent();
      this.unmountActiveCapture();
      this.calViewInstance.patch(viewContainer, tasks, config);
      projectionDiagnosticOwner.update(viewContainer, issues);
      this.remountActiveCapture();
      this.onRenderComplete(viewContainer);
      this.deferTimedBlockFocus(viewContainer, renderGeneration);
    };

    mountView();

    // Month/year/prev/next/today nav — unchanged from the existing implementation
    monthBtn.addEventListener('click', () => {
      const existing = this.el.querySelector('.abyss-month-picker');
      if (existing) {
        this.clearCalendarPicker();
        return;
      }
      this.clearCalendarPicker();
      const picker = this.el.createDiv({
        cls: 'abyss-month-picker abyss-popover',
        attr: { role: 'dialog', 'aria-modal': 'false', 'aria-label': 'Select month' },
      });
      const MONTH_NAMES = [
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
      MONTH_NAMES.forEach((m, i) => {
        const selected = i === this.calDate.month();
        const btn = picker.createEl('button', {
          cls: 'abyss-month-picker-btn',
          text: m,
          attr: { 'aria-pressed': String(selected) },
        });
        if (selected) btn.addClass('is-active');
        btn.addEventListener('click', () => {
          this.cancelKeyboardInteraction();
          this.clearCalendarPicker(true);
          this.calDate = this.calDate.clone().month(i).date(1);
          updateTitle();
          mountView();
        });
      });
      monthBtn.after(picker);
      this.armCalendarPicker(picker, monthBtn);
    });

    yearBtn.addEventListener('click', () => {
      const existing = this.el.querySelector('.abyss-year-picker');
      if (existing) {
        this.clearCalendarPicker();
        return;
      }
      this.clearCalendarPicker();
      const picker = this.el.createDiv({
        cls: 'abyss-year-picker abyss-popover',
        attr: { role: 'dialog', 'aria-modal': 'false', 'aria-label': 'Select year' },
      });
      const currentYear = this.calDate.year();
      for (let y = currentYear - 5; y <= currentYear + 5; y++) {
        const selected = y === currentYear;
        const btn = picker.createEl('button', {
          cls: 'abyss-year-picker-btn',
          text: String(y),
          attr: { 'aria-pressed': String(selected) },
        });
        if (selected) btn.addClass('is-active');
        btn.addEventListener('click', () => {
          this.cancelKeyboardInteraction();
          this.clearCalendarPicker(true);
          this.calDate = this.calDate.clone().year(y).date(1);
          updateTitle();
          mountView();
        });
      }
      yearBtn.after(picker);
      this.armCalendarPicker(picker, yearBtn);
    });

    prevBtn.addEventListener('click', () => {
      this.cancelKeyboardInteraction();
      if (this.calViewType === 'week')
        this.calDate = this.calDate.clone().subtract(7, 'days').startOf('isoWeek');
      else if (this.calViewType === 'today') this.calDate = this.calDate.clone().subtract(1, 'day');
      else this.calDate = this.calDate.clone().subtract(1, 'months').date(1);
      updateTitle();
      mountView();
    });

    nextBtn.addEventListener('click', () => {
      this.cancelKeyboardInteraction();
      if (this.calViewType === 'week')
        this.calDate = this.calDate.clone().add(7, 'days').startOf('isoWeek');
      else if (this.calViewType === 'today') this.calDate = this.calDate.clone().add(1, 'day');
      else this.calDate = this.calDate.clone().add(1, 'months').date(1);
      updateTitle();
      mountView();
    });

    todayBtn.addEventListener('click', () => {
      this.cancelKeyboardInteraction();
      if (this.calViewType === 'week') this.calDate = window.moment().startOf('isoWeek');
      else if (this.calViewType === 'today') this.calDate = window.moment();
      else this.calDate = window.moment().date(1);
      updateTitle();
      mountView();
    });

    this.calUnsubscribe = this.queries.subscribe(() => patchView());
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
    if (!block) return;
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
    const isDifferentPreCommitOrigin =
      pending?.queueSequence !== undefined &&
      !this.committedKeyboardSequences.has(pending.queueSequence) &&
      pending.originElement !== undefined &&
      block !== pending.originElement;
    if (isDifferentPreCommitOrigin) {
      this.keyboardQueue?.cancel();
      this.clearTimedBlockFocus(pending.queueSequence);
      this.pendingTimedBlockFocus = {
        filePath,
        line,
        segmentDate,
        sequence: ++this.nextTimedBlockFocusSequence,
        originElement: block,
      };
      return;
    }
    if (
      pending?.filePath === filePath &&
      pending.line === line &&
      pending.segmentDate === segmentDate
    )
      return;
    if (pending?.queueSequence !== undefined) {
      this.keyboardQueue?.cancel();
      this.clearKeyboardSequenceState(pending.queueSequence);
    }
    this.pendingTimedBlockFocus = {
      filePath,
      line,
      segmentDate,
      sequence: ++this.nextTimedBlockFocusSequence,
      originElement: block,
    };
  }

  private deferTimedBlockFocus(container: HTMLElement, renderGeneration: number): void {
    const scheduled = this.pendingTimedBlockFocus;
    if (!scheduled) return;
    const focusSequence = scheduled.sequence;
    const queueSequence = scheduled.queueSequence;
    if (queueSequence !== undefined && !this.committedKeyboardSequences.has(queueSequence)) return;

    const scheduledCandidate = Array.from(
      container.querySelectorAll<HTMLElement>('.abyss-tg-block'),
    ).find(
      (block) =>
        block.dataset['abyssTaskFile'] === scheduled.filePath &&
        block.dataset['abyssTaskLine'] === String(scheduled.line) &&
        (scheduled.segmentDate === undefined ||
          block.dataset['tgSegmentDate'] === scheduled.segmentDate),
    );
    if (queueSequence !== undefined && scheduledCandidate === scheduled.originElement) return;
    const restorationId =
      queueSequence !== undefined &&
      scheduledCandidate?.isConnected === true &&
      scheduledCandidate !== scheduled.originElement
        ? ++this.nextTimedBlockRestoration
        : undefined;
    if (restorationId !== undefined && queueSequence !== undefined) {
      this.pendingTimedBlockRestorations.set(restorationId, {
        queueSequence,
        focusSequence,
        renderGeneration,
      });
    }

    window.setTimeout(() => {
      if (
        restorationId !== undefined &&
        !this.pendingTimedBlockRestorations.delete(restorationId)
      ) {
        return;
      }
      if (renderGeneration !== this.calendarRenderGeneration) return;
      const pending = this.pendingTimedBlockFocus;
      if (!pending || pending.sequence !== focusSequence || this.state.get('mode') !== 'calendar')
        return;
      if (
        pending.queueSequence !== undefined &&
        !this.committedKeyboardSequences.has(pending.queueSequence)
      ) {
        return;
      }
      const candidate = Array.from(container.querySelectorAll<HTMLElement>('.abyss-tg-block')).find(
        (block) =>
          block.dataset['abyssTaskFile'] === pending.filePath &&
          block.dataset['abyssTaskLine'] === String(pending.line) &&
          (pending.segmentDate === undefined ||
            block.dataset['tgSegmentDate'] === pending.segmentDate),
      );
      if (
        !candidate?.isConnected ||
        !isRealmHTMLElement(candidate) ||
        candidate.ownerDocument !== this.el.ownerDocument
      ) {
        return;
      }
      candidate.focus();
      candidate.classList.add('is-selected');
      if (
        candidate.ownerDocument.activeElement !== candidate ||
        this.pendingTimedBlockFocus?.sequence !== pending.sequence
      ) {
        return;
      }
      if (pending.queueSequence === undefined) {
        this.clearTimedBlockFocus();
        return;
      }
      this.restoredKeyboardSequences.add(pending.queueSequence);
      if (this.settledKeyboardSequences.has(pending.queueSequence)) {
        this.clearTimedBlockFocus(pending.queueSequence);
      }
    }, 0);
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
    if (!pending || pending.queueSequence !== queueSequence) return false;
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
    let pending = this.pendingTimedBlockFocus;
    if (
      !pending ||
      pending.queueSequence !== queueSequence ||
      this.state.get('mode') !== 'calendar'
    ) {
      return;
    }
    this.committedKeyboardSequences.add(queueSequence);
    const sourceChanged =
      pending.filePath !== updated.source.filePath || pending.line !== updated.source.line;
    let nextSegmentDate = pending.segmentDate;
    if (changed && intent.type === 'shift-schedule' && pending.segmentDate !== undefined) {
      try {
        nextSegmentDate = shiftLocalDate(localDate(pending.segmentDate), intent.days);
      } catch {
        nextSegmentDate = pending.segmentDate;
      }
    }
    const segmentChanged = nextSegmentDate !== pending.segmentDate;
    if (changed || sourceChanged || segmentChanged) {
      this.restoredKeyboardSequences.delete(queueSequence);
    }
    if (sourceChanged || segmentChanged) {
      pending = {
        ...pending,
        filePath: updated.source.filePath,
        line: updated.source.line,
        segmentDate: nextSegmentDate,
        sequence: ++this.nextTimedBlockFocusSequence,
      };
      this.pendingTimedBlockFocus = pending;
    }
    if (
      changed ||
      sourceChanged ||
      segmentChanged ||
      !this.restoredKeyboardSequences.has(queueSequence)
    ) {
      this.deferTimedBlockFocus(this.el, this.calendarRenderGeneration);
    }
    if (intent.type !== 'shift-schedule') return;

    const anchor =
      updated.planning.start && updated.planning.due
        ? updated.planning.due
        : (updated.planning.scheduled ?? updated.planning.due);
    const followDate = nextSegmentDate ?? anchor;
    if (!followDate) return;

    const firstDayOfWeek =
      this.settings.desktop.firstDayOfWeek ?? DEFAULT_VIEW_CONFIG.firstDayOfWeek;
    const shouldFollow =
      this.calViewType === 'today' ||
      (this.calViewType === 'week' &&
        !visibleCalendarDates('week', this.calDate, firstDayOfWeek).includes(followDate));
    if (!shouldFollow) return;
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
    input.addEventListener('input', () => this.state.set('searchQuery', input.value));
    input.addEventListener('keydown', (event) => {
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- Chromium IME sentinel.
      if (event.isComposing || event.keyCode === 229 || event.key !== 'Escape') return;
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
    if (
      this.state.get('mode') !== 'search' ||
      !this.searchInputEl?.isConnected ||
      !this.searchResultsEl?.isConnected
    ) {
      return;
    }
    if (this.searchInputEl.value !== query) this.searchInputEl.value = query;
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
      if (this.state.get('mode') !== 'search' || !input?.isConnected || !results?.isConnected) {
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

    if (!query) {
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
      if (!task) return;
      cardEl.addEventListener(
        'click',
        (e) => {
          e.stopPropagation();
          const todayStr = localDate(window.moment().format('YYYY-MM-DD'));
          const d = task.planning.due ?? task.planning.scheduled;
          let list: 'inbox' | 'today' | 'upcoming' = 'inbox';
          if ((task.planning.due && task.planning.due < todayStr) || d === todayStr) {
            list = 'today';
          } else if (d && d > todayStr) {
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
    const vs = this.mainTaskViewState();
    const today = localDate(window.moment().format('YYYY-MM-DD'));
    const tomorrow = window.moment().add(1, 'day').format('YYYY-MM-DD');

    if (vs.groupBy === 'none') {
      this.renderFlat(container, tasks);
      return;
    }

    let groups: Array<{ label: string; tasks: TaskSnapshot[] }>;
    if (vs.groupBy === 'date') {
      groups = groupTasksByDate(tasks, today, tomorrow);
    } else if (vs.groupBy === 'priority') {
      groups = groupTasksByPriority(tasks);
    } else if (vs.groupBy === 'status') {
      groups = groupTasksByStatus(tasks, this.statusRegistry);
    } else {
      groups = groupTasksByTag(tasks);
    }

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

  private renderFlat(container: HTMLElement, tasks: TaskSnapshot[]): void {
    for (const task of tasks) this.renderTaskCard(container, task);
  }

  // This method retains the legacy list/timeline interaction surface; Board-only
  // presentation is deliberately isolated by projectTaskBoard below.
  // eslint-disable-next-line sonarjs/cognitive-complexity
  private renderTaskCard(
    container: HTMLElement,
    task: TaskSnapshot,
    context: {
      readonly projectPath?: string;
      readonly manageStatusMenu?: boolean;
      readonly manageStatusMarker?: boolean;
      readonly dependencyDecision?: DependencyCompletionDecision;
      readonly projectTaskCollection?: boolean;
      /** Only Board cards use the shared Board EntityPresentation slot layout. */
      readonly projectTaskBoard?: boolean;
      readonly statusMutationPending?: boolean;
      readonly blockStatusMutationIfPending?: () => boolean;
      readonly nextActionState?: (task: TaskSnapshot) => boolean | undefined;
      readonly onAddPropertyFilter?: (filter: PropertyFilter) => void;
    } = {},
  ): HTMLElement {
    const dependencyDecision =
      context.dependencyDecision ?? this.dependencyProjection?.evaluateCompletion(task);
    const stack = this.state.get('taskStack');
    const root = stack[0];
    const current = stack[stack.length - 1];
    const isSelected =
      root !== undefined &&
      'source' in root &&
      current !== undefined &&
      taskNodeLine(root, current) === task.source.line &&
      root.source.filePath === task.source.filePath;

    const card = container.createDiv({
      cls: `abyss-task-card${isSelected ? ' is-selected' : ''}`,
      attr: { tabindex: '-1' },
    });
    const isNextAction = context.nextActionState?.(task) ?? task.tags.includes('#task/next_action');
    if (isNextAction) card.dataset['nextAction'] = 'true';
    applyTaskPresentationIdentity(card, task.ref);
    card.dataset['inspectorOriginKey'] = inspectorSelectionKey({ type: 'task', task: task.ref });
    card.dataset['filePath'] = task.source.filePath;
    card.dataset['line'] = String(task.source.line);
    this.registerProjectTaskFocus(card, task, context.projectTaskCollection === true);

    if (context.projectTaskBoard === true) {
      const due = task.planning.due ?? task.planning.scheduled;
      const tags = task.tags ?? [];
      const subtaskCount = task.subtasks?.length ?? 0;
      const doneCount = task.subtasks?.filter((subtask) => subtask.status === 'done').length ?? 0;
      const addPropertyFilter =
        context.onAddPropertyFilter ?? ((filter: PropertyFilter) => this.addPropertyFilter(filter));
      new EntityPresentation({
        layout: 'board-card',
        className: 'abyss-task-board-presentation',
        primaryClassName: 'abyss-entity-primary',
        secondaryClassName: 'abyss-entity-secondary',
        primarySlots: ['status', 'identity', 'priority', 'date'],
        secondarySlots: ['health', 'progress', 'relations', 'secondary'],
        status: {
          value: task.statusSymbol,
          text: '',
          element: 'div',
          className: 'abyss-task-board-status',
          content: (slot) =>
            renderStatusMarker(slot, {
              task,
              registry: this.statusRegistry,
              interactive: context.manageStatusMarker !== false,
              disabled: context.statusMutationPending === true,
              onDisabledInteraction: () => context.blockStatusMutationIfPending?.() ?? false,
              ...(dependencyDecision && { completionDecision: dependencyDecision }),
              onLeftClick: () => {
                if (context.blockStatusMutationIfPending?.()) return;
                void this.toggleTask(task);
              },
              onContextMenu: (event) => {
                event.stopPropagation();
                if (context.blockStatusMutationIfPending?.()) return;
                this.openStatusMenu(event, task, context.blockStatusMutationIfPending);
              },
            }),
        },
        identity: {
          value: task.title,
          text: '',
          element: 'div',
          className: 'abyss-task-board-identity',
          content: (slot) => {
            const title = slot.createEl('span', {
              cls: 'abyss-task-title',
              attr: { title: task.title },
            });
            renderTaskText(title, task.markdownTitle, {
              app: this.app,
              sourcePath: task.source.filePath,
              component: this.md,
              onEditLink: (occurrence, token) => this.editTaskLink(task, occurrence, token),
            });
          },
        },
        priority: { value: task.priority, className: 'abyss-task-board-priority' },
        ...(due && {
          date: {
            value: task.planning.time
              ? `${this.formatDate(due)} ${task.planning.time}`
              : this.formatDate(due),
            className: `abyss-task-date ${this.getDateClass(due)}`.trim(),
            onClick: (event) => {
              event.stopPropagation();
              addPropertyFilter({ type: 'date', value: due });
            },
          },
        }),
        ...(dependencyDecision && {
          health: {
            value: dependencyDecision.type,
            text: '',
            className: 'abyss-task-board-health',
            content: (slot) => renderDependencyBadge(slot, dependencyDecision),
          },
        }),
        ...(subtaskCount > 0 && {
          progress: {
            value: `${String(doneCount)}/${String(subtaskCount)} complete`,
            className: 'abyss-task-count-badge',
          },
        }),
        ...(tags.length > 0 && {
          relations: {
            value: tags.join(' '),
            text: '',
            className: 'abyss-task-board-relations',
            content: (slot) => {
              for (const tag of tags.slice(0, 2)) {
                const tagEl = slot.createEl('span', { cls: 'abyss-task-tag', text: tag });
                const color = this.getTagColor(tag);
                if (color) {
                  tagEl.setCssProps({ '--abyss-tag-color': color });
                  tagEl.addClass('abyss-task-tag--colored');
                }
                tagEl.addEventListener('click', (event) => {
                  event.stopPropagation();
                  addPropertyFilter({ type: 'tag', value: tag });
                });
              }
            },
          },
        }),
        ...(task.description && {
          secondary: { value: task.description.split('\n')[0] ?? '', className: 'abyss-task-desc' },
        }),
        actions: [
          {
            label: 'Delete task',
            icon: 'x',
            onClick: (event) => {
              event.stopPropagation();
              void this.deleteTask(task);
            },
          },
        ],
      }).render(card);
    } else {
      const cardContent = card;
      const mainRow = cardContent.createDiv({ cls: 'abyss-task-card-main-row' });

      renderStatusMarker(mainRow, {
        task,
        registry: this.statusRegistry,
        interactive: context.manageStatusMarker !== false,
        ...(dependencyDecision && { completionDecision: dependencyDecision }),
        onLeftClick: () => void this.toggleTask(task),
        onContextMenu: (ev) => {
          ev.stopPropagation();
          this.openStatusMenu(ev, task);
        },
      });

      // Pre-compute metadata needed in both body and meta-right
      const today = localDate(window.moment().format('YYYY-MM-DD'));
      const sel = this.state.get('selectedList');
      const d = task.planning.due ?? task.planning.scheduled; // only explicit dates show a badge
      const tags = task.tags ?? [];
      const subtaskCount = task.subtasks?.length ?? 0;
      const commentCount = task.comments?.length ?? 0;
      const doneCount = task.subtasks?.filter((s) => s.status === 'done').length ?? 0;
      const suppressToday = sel === 'today' && d === today;
      const addPropertyFilter =
        context.onAddPropertyFilter ?? ((filter: PropertyFilter) => this.addPropertyFilter(filter));

      const body = mainRow.createDiv({ cls: 'abyss-task-body' });
      const titleRow = body.createDiv({ cls: 'abyss-task-title-row' });

      if (dependencyDecision) {
        renderDependencyBadge(titleRow, dependencyDecision);
      }

      if (task.recurrence) {
        renderRecurrenceBadge(titleRow, recurrenceBadgeInput(task.recurrence));
      }

      // Count badges BEFORE title text so they're seen while reading left-to-right
      if (subtaskCount > 0) {
        const badge = titleRow.createEl('span', { cls: 'abyss-task-count-badge' });
        setIcon(badge, 'check-square');
        badge.createEl('span', { text: `${doneCount}/${subtaskCount}` });
      }
      if (commentCount > 0) {
        const badge = titleRow.createEl('span', { cls: 'abyss-task-count-badge' });
        setIcon(badge, 'message-square');
        badge.createEl('span', { text: String(commentCount) });
      }
      // Attached materials: link count precomputed by TaskIndex (no per-render parsing).
      const linkCount = task.presentation.linkCount ?? 0;
      if (linkCount > 0) {
        const badge = titleRow.createEl('span', { cls: 'abyss-task-count-badge' });
        setIcon(badge, 'paperclip');
        badge.createEl('span', { text: String(linkCount) });
      }

      const titleEl = titleRow.createEl('span', {
        cls: 'abyss-task-title',
        attr: { title: task.title },
      });
      renderTaskText(titleEl, task.markdownTitle, {
        app: this.app,
        sourcePath: task.source.filePath,
        component: this.md,
        onEditLink: (occ, token) => this.editTaskLink(task, occ, token),
      });
      if (task.description) {
        const descEl = cardContent.createDiv({ cls: 'abyss-task-desc' });
        // Render the first description line as markdown so links are clickable here too.
        // No onEditLink: the card is a compact preview; link editing happens in the panel.
        renderTaskText(descEl, task.description.split('\n')[0] ?? '', {
          app: this.app,
          sourcePath: task.source.filePath,
          component: this.md,
        });
      }

      const showSourceNote = shouldShowSourceNote(
        task,
        this.settings.sourceNoteDisplay,
        this.settings.customFilePath,
      );
      const hasRightMeta =
        showSourceNote || (d && !suppressToday) || task.planning.time || tags.length > 0;
      if (hasRightMeta) {
        const metaRight = mainRow.createDiv({ cls: 'abyss-task-meta-right' });

        // Date + optional time: date part and time part are separately clickable
        if (d && !suppressToday) {
          const dateEl = metaRight.createEl('span', {
            cls: `abyss-task-date ${this.getDateClass(d)}`.trim(),
          });
          // Date part: calendar icon + date text — click to filter by date
          const datePart = dateEl.createEl('span', {
            cls: 'abyss-task-date-part abyss-cursor-pointer',
          });
          const calIcon = datePart.createEl('span', { cls: 'abyss-date-icon' });
          setIcon(calIcon, 'calendar');
          datePart.createEl('span', { text: this.formatDate(d) });
          datePart.addEventListener('click', (e) => {
            e.stopPropagation();
            addPropertyFilter({ type: 'date', value: d });
          });
          // Time part: clock icon + time text — click to filter by time
          if (task.planning.time) {
            const timePart = dateEl.createEl('span', {
              cls: 'abyss-task-time-part abyss-cursor-pointer',
            });
            const clockIcon = timePart.createEl('span', { cls: 'abyss-date-icon' });
            setIcon(clockIcon, 'clock');
            timePart.createEl('span', { text: task.planning.time });
            timePart.addEventListener('click', (e) => {
              e.stopPropagation();
              addPropertyFilter({ type: 'time', value: task.planning.time! });
            });
          }
        } else if (!d && task.planning.time) {
          const timeEl = metaRight.createEl('span', {
            cls: 'abyss-task-date abyss-cursor-pointer',
          });
          const clockIcon = timeEl.createEl('span', { cls: 'abyss-date-icon' });
          setIcon(clockIcon, 'clock');
          timeEl.createEl('span', { text: task.planning.time });
          timeEl.addEventListener('click', (e) => {
            e.stopPropagation();
            addPropertyFilter({ type: 'time', value: task.planning.time! });
          });
        }

        // Source note chip before tags
        if (showSourceNote) {
          renderSourceNoteChip(metaRight, task, (filePath) => {
            addPropertyFilter({ type: 'file', filePath });
          });
        }

        // Tags last (max 2, with group color)
        for (const tag of tags.slice(0, 2)) {
          const tagEl = metaRight.createEl('span', { cls: 'abyss-task-tag', text: tag });
          const color = this.getTagColor(tag);
          if (color) {
            tagEl.setCssProps({ '--abyss-tag-color': color });
            tagEl.addClass('abyss-task-tag--colored');
          }
          tagEl.addEventListener('click', (e) => {
            e.stopPropagation();
            addPropertyFilter({ type: 'tag', value: tag });
          });
          tagEl.addClass('abyss-cursor-pointer');
          // Drop target: dragging a tag onto a chip replaces it
          tagEl.addEventListener('dragover', (e) => {
            const dragging = this.state.get('draggingTag');
            if (!dragging || dragging === tag) return;
            e.preventDefault();
            e.stopPropagation();
            tagEl.classList.add('abyss-drop-target');
          });
          tagEl.addEventListener('dragleave', () => {
            tagEl.classList.remove('abyss-drop-target');
          });
          tagEl.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            tagEl.classList.remove('abyss-drop-target');
            const dragging = this.state.get('draggingTag');
            if (!dragging || dragging === tag) return;
            void this.patchTaskTags(task, [dragging], [tag]);
          });
        }
      }
    }

    card.addEventListener('click', (e) => {
      const key = this.taskKey(task);

      if (context.projectTaskCollection) {
        const session = this.projectWorkspaceSession.tasks;
        if (e.ctrlKey || e.metaKey) session.toggle(task.ref);
        else if (e.shiftKey) session.extendTo(task.ref);
        else session.activate(task.ref);
        this.updateSelectionVisuals();
        this.applyProjectTaskEffect(session.consumeEffect());
        return;
      }

      if (e.ctrlKey || e.metaKey) {
        // Ctrl/Cmd+Click: toggle this task in selection
        if (this.selectedTaskKeys.has(key)) {
          this.selectedTaskKeys.delete(key);
        } else {
          this.selectedTaskKeys.add(key);
        }
        this.selectionAnchorKey = key;
        this.selectionFocusKey = key;
        this.updateSelectionVisuals();
        this.focusTaskKey(key);
        return;
      }

      if (e.shiftKey) {
        const keys = this.visibleTaskKeys();
        const anchor =
          this.selectionAnchorKey && keys.includes(this.selectionAnchorKey)
            ? this.selectionAnchorKey
            : key;
        this.selectionAnchorKey = anchor;
        this.selectionFocusKey = key;
        this.replaceRangeSelection(anchor, key, keys);
        this.focusTaskKey(key);
        return;
      }

      // Plain click: clear selection, open in RightPanel
      this.selectedTaskKeys.clear();
      this.selectionAnchorKey = key;
      this.selectionFocusKey = key;
      this.updateSelectionVisuals();
      this.focusTaskKey(key);
      this.state.set('taskStack', [task]);
    });

    if (!context.projectTaskBoard)
      renderEntityActionLayer(card, {
        className: 'abyss-task-delete-btn',
        label: 'Delete task',
        icon: 'x',
        onActivate: (e) => {
          e.stopPropagation();
          void this.deleteTask(task);
        },
      });

    // Drag source
    card.setAttribute('draggable', 'true');
    card.addEventListener('dragstart', () => {
      this.state.set('draggingTask', task);
      card.classList.add('abyss-dragging');
    });
    card.addEventListener('dragend', () => {
      this.state.set('draggingTask', null);
      card.classList.remove('abyss-dragging');
    });

    // Drop target for tag→task drag, and for project→task drag (drop a project
    // onto a task to move that task into the project note).
    card.addEventListener('dragover', (e) => {
      const project = this.state.get('draggingProject');
      const canDropProject =
        !!project && project !== task.source.filePath && !!this.projectManager && !!this.tasks;
      if (!this.state.get('draggingTag') && !canDropProject) return;
      e.preventDefault();
      card.classList.add('abyss-drop-target');
    });
    card.addEventListener('dragleave', () => {
      card.classList.remove('abyss-drop-target');
    });
    card.addEventListener('drop', (e) => {
      card.classList.remove('abyss-drop-target');
      const tag = this.state.get('draggingTag');
      const project = this.state.get('draggingProject');
      if (tag) {
        e.preventDefault();
        void this.assignTagFromInbox(task, tag);
      } else if (project && project !== task.source.filePath && this.projectManager && this.tasks) {
        e.preventDefault();
        const ref = task.ref;
        if (ref) {
          void moveTaskToProjectWithRecovery(
            this.app,
            this.tasks,
            this.projectManager,
            ref,
            project,
          );
        }
      }
    });

    // Right-click context menu
    if (context.manageStatusMenu !== false)
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const key = this.taskKey(task);

        if (context.projectTaskCollection) {
          const session = this.projectWorkspaceSession.tasks;
          if (session.selectedCount() > 0 && !session.isSelected(task.ref)) {
            session.clearSelection();
            this.updateSelectionVisuals();
          }
          const selected = session.selectedActions();
          if (selected.length >= 2) {
            this.showBulkContextMenu(
              e,
              card,
              selected.map(({ task: selectedTask }) => selectedTask),
            );
            return;
          }
        }

        if (!context.projectTaskCollection) {
          // If right-clicking an unselected card while others are selected → clear and show single menu
          if (this.selectedTaskKeys.size > 0 && !this.selectedTaskKeys.has(key)) {
            this.selectedTaskKeys.clear();
            this.selectionAnchorKey = null;
            this.selectionFocusKey = null;
            this.updateSelectionVisuals();
          }

          // ── BULK MENU (2+ tasks selected) ─────────────────────
          if (this.selectedTaskKeys.size >= 2) {
            this.showBulkContextMenu(e, card);
            return;
          }
        }

        const menu = new Menu();
        this.populateCanonicalTaskMenu(menu, task, card, context);
        showMenuAtMouseEventWithFocus(menu, e, { restoreFocusTo: card });
      });
    return card;
  }

  private registerProjectTaskFocus(
    card: HTMLElement,
    task: TaskSnapshot,
    projectTaskCollection: boolean,
  ): void {
    if (!projectTaskCollection) return;
    card.addEventListener('focus', () => {
      this.projectWorkspaceSession.tasks.focusOnly(task.ref);
    });
  }

  private bulkTagIndicator(count: number, total: number): string {
    if (count === total) return '✓ ';
    if (count > 0) return '~ ';
    return '';
  }

  private makeBulkTagRemoveHandler(selectedTasks: TaskSnapshot[], pinnedTag: string): () => void {
    return () =>
      void Promise.all(selectedTasks.map((task) => this.patchTaskTags(task, [], [pinnedTag])));
  }

  private makeBulkTagAddHandler(selectedTasks: TaskSnapshot[], pinnedTag: string): () => void {
    return () =>
      void Promise.all(selectedTasks.map((task) => this.patchTaskTags(task, [pinnedTag], [])));
  }

  private addBulkTagItem(menu: Menu, pinnedTag: string, selectedTasks: TaskSnapshot[]): void {
    const count = selectedTasks.filter((task) => task.tags?.includes(pinnedTag) === true).length;
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
          .onClick(() => void this.setPriority(task, level.value));
        applyPriorityFlagColor(si, level.value);
      });
    }
  }

  private buildBulkPrioritySubmenu(sub: Menu, selectedTasks: TaskSnapshot[]): void {
    for (const level of PRIORITY_LEVELS) {
      sub.addItem((si) => {
        si.setTitle(level.label)
          .setIcon('flag')
          .onClick(
            () => void Promise.all(selectedTasks.map((t) => this.setPriority(t, level.value))),
          );
        applyPriorityFlagColor(si, level.value);
      });
    }
  }

  private getTaskTags(task: TaskSnapshot): Set<string> {
    return new Set(task.tags ?? []);
  }

  private async patchTaskTags(
    task: TaskSnapshot,
    add: readonly string[],
    remove: readonly string[],
  ): Promise<void> {
    const ref = task.ref;
    if (!ref || !this.tasks) return;
    presentTaskCommandResult(
      await this.tasks.execute({
        type: 'patch',
        target: { type: 'task', ref },
        patch: { tags: { add, remove } },
      }),
    );
  }

  private async updateProjectNextAction(
    projectPath: string,
    task: TaskSnapshot,
    clear: boolean,
  ): Promise<void> {
    if (!this.nextActions) return;
    const result = clear
      ? await this.nextActions.clear(projectPath, task)
      : await this.nextActions.set(projectPath, task);
    if (result.type === 'integrity-conflict') {
      this.presentNextActionConflict(result);
      return;
    }
    presentTaskCommandResult(result);
  }

  private populateCanonicalTaskMenu(
    menu: Menu,
    task: TaskSnapshot,
    anchor: HTMLElement,
    context: {
      readonly projectPath?: string;
      readonly nextActionState?: (task: TaskSnapshot) => boolean | undefined;
      readonly onAddPropertyFilter?: (filter: PropertyFilter) => void;
    },
  ): void {
    const today = localDate(window.moment().format('YYYY-MM-DD'));
    const tomorrow = shiftLocalDate(today, 1);
    menu.addItem((item) =>
      item
        .setTitle('Today')
        .setIcon('calendar')
        .setSection('today')
        .setChecked(task.planning.due === today)
        .onClick(() => void this.toggleTaskDuePreset(task, today)),
    );
    if (tomorrow) {
      menu.addItem((item) =>
        item
          .setTitle('Tomorrow')
          .setIcon('calendar-plus')
          .setSection('today')
          .setChecked(task.planning.due === tomorrow)
          .onClick(() => void this.toggleTaskDuePreset(task, tomorrow)),
      );
    }
    for (const pinnedTag of this.settings.pinnedTags) {
      const hasTag = this.getTaskTags(task).has(pinnedTag);
      menu.addItem((item) =>
        item
          .setTitle(pinnedTag)
          .setIcon('tag')
          .setSection('tags')
          .setChecked(hasTag)
          .onClick(
            () =>
              void this.patchTaskTags(task, hasTag ? [] : [pinnedTag], hasTag ? [pinnedTag] : []),
          ),
      );
    }
    if (context.projectPath !== undefined && this.nextActions) {
      const active = context.nextActionState?.(task) ?? task.tags.includes('#task/next_action');
      menu.addItem((item) =>
        item
          .setTitle(active ? 'Clear Next Action' : 'Set as Next Action')
          .setIcon(active ? 'list-x' : 'list-checks')
          .setSection('actions')
          .onClick(() => void this.updateProjectNextAction(context.projectPath!, task, active)),
      );
    }
    menu.addItem((item) => {
      item.setTitle('Priority').setIcon('arrow-up-narrow-wide').setSection('priority');
      this.buildPrioritySubmenu(getSubmenu(item), task);
    });
    menu.addItem((item) => {
      item.setTitle('Status').setIcon('check-square').setSection('priority');
      buildStatusSubmenu(
        getSubmenu(item),
        task,
        this.statusRegistry,
        (status) => void this.setTaskStatus(task, status),
      );
    });
    const addPropertyFilter =
      context.onAddPropertyFilter ?? ((filter: PropertyFilter) => this.addPropertyFilter(filter));
    menu.addItem((item) =>
      item
        .setTitle('Filter by this priority')
        .setIcon('filter')
        .setSection('priority')
        .onClick(() => addPropertyFilter({ type: 'priority', value: task.priority })),
    );
    menu.addItem((item) =>
      item
        .setTitle('Filter by this status')
        .setIcon('filter')
        .setSection('priority')
        .onClick(() => addPropertyFilter({ type: 'status', value: task.statusSymbol })),
    );
    menu.addItem((item) =>
      item
        .setTitle('Set date…')
        .setIcon('calendar-cog')
        .setSection('actions')
        .onClick(() => this.openTaskDatePicker(anchor, [task])),
    );
    menu.addItem((item) =>
      item
        .setTitle('Set tag…')
        .setIcon('hash')
        .setSection('actions')
        .onClick(() => this.openTagPicker(task)),
    );
    menu.addItem((item) =>
      item
        .setTitle('Edit repeat…')
        .setIcon('repeat-2')
        .setSection('actions')
        .onClick(() => this.openRecurrenceEditor(anchor, task)),
    );
    menu.addItem((item) =>
      item
        .setTitle('Open in note')
        .setIcon('file-text')
        .setSection('actions')
        .onClick(() => void openInFile(this.app, task)),
    );
    menu.addItem((item) =>
      item
        .setTitle('Delete')
        .setIcon('trash-2')
        .setSection('danger')
        .onClick(() => void this.deleteTask(task)),
    );
  }

  /** The Project Table and task cards invoke one canonical task action model. */
  private showProjectNextActionMenu(
    event: MouseEvent,
    projectPath: string,
    task: TaskSnapshot,
    anchor?: HTMLElement,
  ): void {
    event.preventDefault();
    const menu = new Menu();
    this.populateCanonicalTaskMenu(menu, task, anchor ?? this.el, {
      projectPath,
      ...(this.tasks && {
        nextActionState: (candidate) => projectedNextAction(this.tasks!, candidate),
      }),
    });
    showMenuAtMouseEventWithFocus(menu, event, {
      ...(anchor && { restoreFocusTo: anchor }),
    });
  }

  private presentNextActionConflict(conflict: NextActionConflict): void {
    const existing = conflict.tasks[0];
    if (!existing) {
      new Notice(
        `Next Action integrity needs review: ${conflict.diagnostic}. The task index was rescanned; refresh the Project and choose one action.`,
      );
      return;
    }
    const count = conflict.tasks.length;
    const conflictingTasks = count === 1 ? 'another task' : `${count} other tasks`;
    this.taskModal?.open(
      existing,
      `Next Action is already set on ${conflictingTasks}. Review the existing task here; nothing was changed.`,
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
      void this.patchTaskTags(task, toAdd, toRemove);
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
      void Promise.all(selectedTasks.map((task) => this.patchTaskTags(task, toAdd, toRemove)));
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

  private showBulkContextMenu(
    e: MouseEvent,
    _card: HTMLElement,
    projectSelectedTasks?: readonly TaskSnapshot[],
  ): void {
    const selectedTasks = projectSelectedTasks
      ? [...projectSelectedTasks]
      : this.visibleTaskKeys()
          .filter((key) => this.selectedTaskKeys.has(key))
          .map((key) => this.taskForKey(key))
          .filter((task): task is TaskSnapshot => task !== undefined);

    const menu = new Menu();
    const today = localDate(window.moment().format('YYYY-MM-DD'));
    const tomorrow = shiftLocalDate(today, 1);
    const allHaveToday = selectedTasks.every((t) => t.planning.due === today);

    // Header (non-interactive label)
    menu.addItem((item) =>
      item
        .setTitle(`${selectedTasks.length} tasks selected`)
        .setSection('header')
        .setDisabled(true),
    );

    // Today toggle
    menu.addItem((item) =>
      item
        .setTitle('Today')
        .setIcon('calendar')
        .setSection('today')
        .setChecked(allHaveToday)
        .onClick(() => void this.applyBulkDuePreset(selectedTasks, today)),
    );

    if (tomorrow) {
      const allHaveTomorrow = selectedTasks.every((task) => task.planning.due === tomorrow);
      menu.addItem((item) =>
        item
          .setTitle('Tomorrow')
          .setIcon('calendar-plus')
          .setSection('today')
          .setChecked(allHaveTomorrow)
          .onClick(() => void this.applyBulkDuePreset(selectedTasks, tomorrow)),
      );
    }

    // Pinned tags
    for (const pinnedTag of this.settings.pinnedTags) {
      this.addBulkTagItem(menu, pinnedTag, selectedTasks);
    }

    // Priority (submenu)
    menu.addItem((item) => {
      item.setTitle('Priority').setIcon('arrow-up-narrow-wide').setSection('priority');
      const sub = getSubmenu(item);
      this.buildBulkPrioritySubmenu(sub, selectedTasks);
    });

    // Status (submenu) — applies to all selected tasks
    menu.addItem((item) => {
      item.setTitle('Status').setIcon('check-square').setSection('priority');
      const sub = getSubmenu(item);
      buildStatusSubmenu(sub, selectedTasks[0]!, this.statusRegistry, (c) => {
        void this.applyBulkStatus(selectedTasks, c);
      });
    });

    menu.addItem((item) =>
      item
        .setTitle('Set date…')
        .setIcon('calendar-cog')
        .setSection('actions')
        .onClick(() => this.openTaskDatePicker(_card, selectedTasks)),
    );

    // Set tag…
    menu.addItem((item) =>
      item
        .setTitle('Set tag…')
        .setIcon('hash')
        .setSection('actions')
        .onClick(() => this.openBulkTagPicker(selectedTasks)),
    );

    // Delete all
    menu.addItem((item) =>
      item
        .setTitle('Delete all')
        .setIcon('trash-2')
        .setSection('danger')
        .onClick(() => void this.deleteBulkTasks(selectedTasks)),
    );

    showMenuAtMouseEventWithFocus(menu, e);
  }

  private mainTaskCollectionControlBinding(): TaskCollectionControlBinding {
    const listKey = this.activeListKey();
    return {
      viewState: this.mainTaskViewState(),
      defaults: getListViewDefaults(listKey),
      onUpdate: (next) => this.updateViewState(next),
      onRemoveFilter: (index) => this.removePropertyFilter(index),
    };
  }

  private renderPropertyChips(
    container: HTMLElement,
    binding: TaskCollectionControlBinding = this.mainTaskCollectionControlBinding(),
  ): void {
    const vs = binding.viewState;
    for (let i = 0; i < vs.filters.length; i++) {
      const f = vs.filters[i]!;
      const label = this.filterChipLabel(f);
      const chip = container.createEl('span', { cls: 'abyss-filter-chip' });
      chip.createEl('span', { cls: 'abyss-filter-chip-label', text: label });
      const x = chip.createEl('button', { cls: 'abyss-filter-chip-x', text: '×' });
      const idx = i;
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        if (binding.onRemoveFilter) {
          binding.onRemoveFilter(idx);
          return;
        }
        binding.onUpdate({ ...vs, filters: vs.filters.filter((_, index) => index !== idx) });
      });
    }
  }

  private filterChipLabel(f: PropertyFilter): string {
    if (f.type === 'tag') return f.value;
    if (f.type === 'file') return `📄 ${f.filePath.split('/').pop()?.replace(/\.md$/, '') ?? ''}`;
    if (f.type === 'time') return `⏰ ${f.value}`;
    if (f.type === 'status') return this.statusRegistry.bySymbol(f.value)?.name ?? f.value;
    if (f.type === 'date') return `📅 ${this.formatDate(f.value)}`;
    const level = PRIORITY_LEVELS.find((l) => l.value === f.value);
    if (!level) return f.value;
    // D/None has no emoji and reads as "Normal" here (distinct from the
    // "None" label used in priority-picker menus).
    return level.emoji ? `${level.emoji} ${level.label}` : 'Normal';
  }

  private addPropertyFilter(filter: PropertyFilter): void {
    const vs = this.mainTaskViewState();
    const already = vs.filters.some((f) => {
      if (f.type !== filter.type) return false;
      if (f.type === 'file' && filter.type === 'file') return f.filePath === filter.filePath;
      if (f.type === 'tag' && filter.type === 'tag') return f.value === filter.value;
      if (f.type === 'time' && filter.type === 'time') return f.value === filter.value;
      if (f.type === 'priority' && filter.type === 'priority') return f.value === filter.value;
      if (f.type === 'status' && filter.type === 'status') return f.value === filter.value;
      if (f.type === 'date' && filter.type === 'date') return f.value === filter.value;
      return false;
    });
    if (already) return;
    const next: ListViewState = { ...vs, filters: [...vs.filters, filter] };
    this.updateViewState(next);
  }

  private removePropertyFilter(idx: number): void {
    const vs = this.mainTaskViewState();
    this.updateViewState({ ...vs, filters: vs.filters.filter((_, index) => index !== idx) });
  }

  private updateViewState(next: ListViewState): void {
    if (!this.persistsSettings) {
      this.state.set('centerListViewState', next);
      return;
    }
    void this.projectWorkspaceSession
      .updateMainTaskPreference((current) => ({
        ...current,
        filters: [...next.filters],
        group: next.groupBy,
        sort: { ...next.sortBy },
        layoutPreferences: {
          ...current.layoutPreferences,
          primary: { ...(next.statusGroups && { statusGroups: [...next.statusGroups] }) },
        },
      }))
      .then(() =>
        this.state.set('centerListViewState', this.projectWorkspaceSession.mainTaskView()),
      )
      .catch((error: unknown) => {
        const conflict =
          error instanceof Error && error.name === 'CollectionPreferenceConflictError';
        new Notice(
          conflict
            ? 'Task list preferences changed elsewhere. Your change was not saved; review the settled list.'
            : 'Task list preference was not saved. Nothing changed; try again.',
        );
      });
  }

  private activeListKey(): string {
    return listSelectionToKey(this.state.get('selectedList'));
  }

  private mainTaskViewState(): ListViewState {
    return this.persistsSettings
      ? this.projectWorkspaceSession.mainTaskView()
      : this.state.get('centerListViewState');
  }

  private mainTaskQuery(): string {
    return this.persistsSettings
      ? this.projectWorkspaceSession.mainTaskSession().query
      : this.state.get('centerFilter');
  }

  private showViewStatePopover(
    anchor: HTMLElement,
    binding: TaskCollectionControlBinding = this.mainTaskCollectionControlBinding(),
    autoOpenStatusGroupRow = false,
  ): void {
    if (this.viewStatePopoverCleanup) {
      this.viewStatePopoverCleanup(true);
      return;
    }

    const vs = binding.viewState;
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

    const bindExpandableRow = (rowMain: HTMLElement, subList: HTMLElement): void => {
      const toggle = (): void => {
        const isOpen = !subList.hasClass('abyss-hidden');
        popover.querySelectorAll<HTMLElement>('.abyss-view-state-sublist').forEach((el) => {
          el.addClass('abyss-hidden');
        });
        popover.querySelectorAll<HTMLElement>('.abyss-view-state-row-main').forEach((el) => {
          el.removeClass('is-open');
          el.setAttribute('aria-expanded', 'false');
        });
        if (!isOpen) {
          subList.removeClass('abyss-hidden');
          rowMain.addClass('is-open');
          rowMain.setAttribute('aria-expanded', 'true');
        }
      };
      rowMain.addEventListener('click', toggle);
      rowMain.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        toggle();
      });
    };

    const makeRow = (
      icon: string,
      label: string,
      displayValue: string,
      activeValue: string,
      defaultValue: string,
      options: Array<{ label: string; value: string }>,
      onSelect: (value: string) => void,
    ): void => {
      const row = popover.createDiv({ cls: 'abyss-view-state-row' });
      const rowMain = row.createDiv({
        cls: 'abyss-view-state-row-main',
        attr: { role: 'button', tabindex: '0', 'aria-expanded': 'false' },
      });
      const iconEl = rowMain.createEl('span', { cls: 'abyss-view-state-row-icon' });
      setIcon(iconEl, icon);
      rowMain.createEl('span', { cls: 'abyss-view-state-row-label', text: label });
      rowMain.createEl('span', { cls: 'abyss-view-state-row-value', text: displayValue });
      const chevEl = rowMain.createEl('span', { cls: 'abyss-view-state-row-chevron' });
      setIcon(chevEl, 'chevron-right');

      const subList = row.createDiv({ cls: 'abyss-view-state-sublist abyss-hidden' });
      bindExpandableRow(rowMain, subList);

      for (const opt of options) {
        const isActive = opt.value === activeValue;
        const isDefault = opt.value === defaultValue;
        const optEl = subList.createEl('button', {
          cls: 'abyss-view-state-option',
          attr: { 'aria-pressed': String(isActive) },
        });
        const checkEl = optEl.createEl('span', { cls: 'abyss-view-state-option-check' });
        if (isActive) setIcon(checkEl, 'check');
        optEl.createEl('span', { cls: 'abyss-view-state-option-label', text: opt.label });
        if (isDefault) {
          optEl.createEl('span', { cls: 'abyss-view-state-option-default', text: 'Default' });
        }
        optEl.addEventListener('click', () => {
          close();
          onSelect(opt.value);
        });
      }
    };

    // Like makeRow, but options toggle membership in a set rather than
    // selecting a single value, and the popover stays open after a click
    // so multiple options can be picked. `presets`, if given, render as
    // plain (non-checkable) shortcut buttons above a divider, ahead of the
    // toggle options — they just set the whole selection in one click.
    const makeMultiRow = (
      icon: string,
      label: string,
      displayValue: string,
      selected: readonly string[],
      options: Array<{ label: string; value: string }>,
      onToggle: (value: string) => void,
      initiallyOpen = false,
      presets: Array<{ label: string; onClick: () => void; isActive?: boolean }> = [],
    ): void => {
      const row = popover.createDiv({ cls: 'abyss-view-state-row' });
      const rowMain = row.createDiv({
        cls: 'abyss-view-state-row-main',
        attr: { role: 'button', tabindex: '0', 'aria-expanded': String(initiallyOpen) },
      });
      const iconEl = rowMain.createEl('span', { cls: 'abyss-view-state-row-icon' });
      setIcon(iconEl, icon);
      rowMain.createEl('span', { cls: 'abyss-view-state-row-label', text: label });
      rowMain.createEl('span', { cls: 'abyss-view-state-row-value', text: displayValue });
      const chevEl = rowMain.createEl('span', { cls: 'abyss-view-state-row-chevron' });
      setIcon(chevEl, 'chevron-right');

      const subList = row.createDiv({ cls: 'abyss-view-state-sublist abyss-hidden' });
      if (initiallyOpen) {
        subList.removeClass('abyss-hidden');
        rowMain.addClass('is-open');
      }
      bindExpandableRow(rowMain, subList);

      for (const preset of presets) {
        const optEl = subList.createEl('button', {
          cls: 'abyss-view-state-option',
          attr: { 'aria-pressed': String(preset.isActive === true) },
        });
        const checkEl = optEl.createEl('span', { cls: 'abyss-view-state-option-check' });
        if (preset.isActive) setIcon(checkEl, 'check');
        optEl.createEl('span', { cls: 'abyss-view-state-option-label', text: preset.label });
        optEl.addEventListener('click', () => preset.onClick());
      }
      if (presets.length > 0) {
        subList.createDiv({ cls: 'abyss-view-state-sublist-divider' });
      }

      for (const opt of options) {
        const isActive = selected.includes(opt.value);
        const optEl = subList.createEl('button', {
          cls: 'abyss-view-state-option',
          attr: { 'aria-pressed': String(isActive) },
        });
        const checkEl = optEl.createEl('span', { cls: 'abyss-view-state-option-check' });
        if (isActive) setIcon(checkEl, 'check');
        optEl.createEl('span', { cls: 'abyss-view-state-option-label', text: opt.label });
        optEl.addEventListener('click', () => {
          onToggle(opt.value);
        });
      }
    };

    const GROUP_BY_OPTIONS = [
      { label: 'None', value: 'none' },
      { label: 'Date', value: 'date' },
      { label: 'Priority', value: 'priority' },
      { label: 'Tag', value: 'tag' },
      { label: 'Status', value: 'status' },
    ];
    const GROUP_LABELS: Record<string, string> = {
      none: 'None',
      date: 'Date',
      priority: 'Priority',
      tag: 'Tag',
      status: 'Status',
    };

    const sortDirArrow = vs.sortBy.dir === 'asc' ? '↑' : '↓';
    const sortFieldArrow = (field: string): string =>
      vs.sortBy.field === field ? sortDirArrow : '';
    const SORT_BY_OPTIONS = [
      { label: `Date ${sortFieldArrow('date')}`.trim(), value: 'date' },
      { label: `Priority ${sortFieldArrow('priority')}`.trim(), value: 'priority' },
      { label: `Title ${sortFieldArrow('title')}`.trim(), value: 'title' },
      { label: `Tag ${sortFieldArrow('tag')}`.trim(), value: 'tag' },
      { label: `Status ${sortFieldArrow('status')}`.trim(), value: 'status' },
    ];
    const sortLabel = `${vs.sortBy.field.charAt(0).toUpperCase() + vs.sortBy.field.slice(1)} ${vs.sortBy.dir === 'asc' ? '↑' : '↓'}`;

    const STATUS_GROUP_OPTIONS: Array<{ label: string; value: TaskStatusType }> =
      ALL_STATUS_GROUPS.map((value) => ({ label: TYPE_LABELS[value], value }));

    // Unified status display value: All (undefined/all 4), Active (exactly
    // the open+in-progress pair), otherwise a count of the selected groups.
    const showDisplayValue = (selected: TaskStatusType[] | undefined): string => {
      const effective = normalizeStatusGroups(selected) ?? ALL_STATUS_GROUPS;
      if (effective.length >= 4) return 'All';
      if (statusGroupsEqual(effective, ACTIVE_STATUS_GROUPS)) return 'Active';
      return `${effective.length} selected`;
    };

    const defaults = binding.defaults;

    makeRow(
      'layout-list',
      'Group by',
      GROUP_LABELS[vs.groupBy] ?? vs.groupBy,
      vs.groupBy,
      defaults.groupBy,
      GROUP_BY_OPTIONS,
      (val) => {
        binding.onUpdate({ ...vs, groupBy: val as ListViewState['groupBy'] });
      },
    );

    makeRow(
      'arrow-up-down',
      'Sort by',
      sortLabel,
      vs.sortBy.field,
      defaults.sortBy.field,
      SORT_BY_OPTIONS,
      (val) => {
        const field = val as ListViewState['sortBy']['field'];
        const dir: 'asc' | 'desc' =
          vs.sortBy.field === field && vs.sortBy.dir === 'asc' ? 'desc' : 'asc';
        binding.onUpdate({ ...vs, sortBy: { field, dir } });
      },
    );

    // Single unified Status control replaces the old duplicate confirmation path.
    // single-select and Status group multi-select, which contradicted each
    // other. "Active"/"All" are one-click presets; the 4 toggles below them
    // are the actual source of truth (presets just set their state).
    const applyStatusGroupsChange = (nextStatusGroups: TaskStatusType[] | undefined): void => {
      this.reopenStatusGroupPopover = true;
      close();
      binding.onUpdate({ ...vs, statusGroups: nextStatusGroups });
    };

    makeMultiRow(
      'eye',
      'Status',
      showDisplayValue(vs.statusGroups),
      vs.statusGroups ?? ALL_STATUS_GROUPS,
      STATUS_GROUP_OPTIONS,
      (val) => {
        const value = val as TaskStatusType;
        const current = vs.statusGroups ?? ALL_STATUS_GROUPS;
        const next = current.includes(value)
          ? current.filter((g) => g !== value)
          : [...current, value];
        // All 4 selected (or none, treated the same as "all") is the default — store
        // undefined so the state stays clean and matches getListViewDefaults.
        const nextStatusGroups = next.length === 0 || next.length >= 4 ? undefined : next;
        applyStatusGroupsChange(nextStatusGroups);
      },
      autoOpenStatusGroupRow,
      [
        {
          label: 'Active',
          onClick: () => applyStatusGroupsChange(ACTIVE_STATUS_GROUPS),
          isActive: statusGroupsEqual(vs.statusGroups, ACTIVE_STATUS_GROUPS),
        },
        {
          label: 'All',
          onClick: () => applyStatusGroupsChange(undefined),
          isActive: normalizeStatusGroups(vs.statusGroups) === undefined,
        },
      ],
    );

    // Reset to defaults row — only shown when state differs from defaults.
    // Same predicate as the left-panel customization dot.
    if (
      vs.groupBy !== defaults.groupBy ||
      vs.sortBy.field !== defaults.sortBy.field ||
      vs.sortBy.dir !== defaults.sortBy.dir ||
      !statusGroupsEqual(vs.statusGroups, defaults.statusGroups)
    ) {
      const resetRow = popover.createDiv({ cls: 'abyss-view-state-reset' });
      const resetBtn = resetRow.createEl('button', {
        cls: 'abyss-view-state-reset-btn',
        text: 'Reset to defaults',
      });
      resetBtn.addEventListener('click', () => {
        close();
        binding.onUpdate({ ...defaults, filters: [...defaults.filters] });
      });
    }

    anchor.after(popover);
    popover.querySelector<HTMLElement>('.abyss-view-state-row-main')?.focus();
    dismissTimer = window.setTimeout(() => {
      dismissTimer = undefined;
      if (!popover.isConnected) return;
      ownerDocument.addEventListener('click', dismiss, true);
      dismissListening = true;
    }, 0);
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
    if (placement.type === 'project') {
      host.dataset['abyssCapturePath'] = placement.path;
      if (placement.statusSymbol !== undefined) {
        host.dataset['abyssCaptureStatus'] = placement.statusSymbol;
      }
    }
    if (placement.type === 'list') {
      host.dataset['abyssCaptureSelection'] = placement.selectionKey;
    }
    const trigger = host.createEl('button', {
      cls: 'abyss-add-task-trigger',
      attr: { type: 'button' },
    });
    trigger.createEl('span', { cls: 'abyss-add-task-plus', text: '+' });
    trigger.createEl('span', { cls: 'abyss-add-task-label', text: 'Add task' });
    trigger.addEventListener('click', () => {
      let context: CaptureContext;
      if (placement.type === 'project') {
        context =
          placement.statusSymbol === undefined
            ? this.neutralProjectCaptureContext(placement.path)
            : this.projectCaptureContext(placement.path, placement.statusSymbol);
      } else {
        context = { type: 'list', selection: this.state.get('selectedList') };
      }
      this.openCapture(placement, context, trigger);
    });
    const active = this.activeCapture;
    if (active && this.sameCapturePlacement(active.placement, placement)) {
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
    if (!this.captureTargets) return;
    this.cancelActiveCapture();
    const requestId = ++this.captureRequestId;
    this.resolvingCapture = { requestId, placement };
    void this.captureTargets.resolve(context).then((resolvedTarget) => {
      if (requestId !== this.captureRequestId) return;
      this.resolvingCapture = null;
      const target = this.targetForCapturePlacement(resolvedTarget, placement);
      let session!: PanelCaptureSession;
      const controller = new TaskCaptureController({
        target,
        describe: describeTaskCreationResult,
        onResult: (result, description) => {
          if (description.kind !== 'success') session.restoreFocusOnClose = false;
          this.onCreationResult(result, description);
        },
        onRequestClose: () => this.closeCapture(session),
      });
      session = {
        requestId,
        placement,
        controller,
        ...(returnFocus !== null && { returnFocus }),
        restoreFocusOnClose: false,
        focusOnMount: true,
      };
      this.activeCapture = session;
      this.remountActiveCapture();
    });
  }

  private remountActiveCapture(): void {
    const active = this.activeCapture;
    if (!active) return;
    const placement = active.placement;
    if (this.isCalendarCapturePlacement(placement)) {
      const host = this.calendarCaptureHost(placement);
      if (host) this.mountCaptureSurface(active, host);
      return;
    }
    const host = [...this.el.querySelectorAll<HTMLElement>('[data-abyss-capture-host]')].find(
      (candidate) =>
        placement.type === 'project'
          ? candidate.dataset['abyssCaptureHost'] === 'project' &&
            candidate.dataset['abyssCapturePath'] === placement.path &&
            candidate.dataset['abyssCaptureStatus'] === placement.statusSymbol
          : candidate.dataset['abyssCaptureHost'] === 'list' &&
            candidate.dataset['abyssCaptureSelection'] === placement.selectionKey,
    );
    if (host) this.mountCaptureSurface(active, host);
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
      if (!hourColumn) return null;
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
    if (!cell) return null;
    const wrapperClass =
      placement.type === 'calendar-month' ? 'abyss-mg-quick-add' : 'abyss-tg-allday-quick-add';
    const host = this.captureWrapper(cell, wrapperClass);
    host.dataset['abyssCaptureHost'] = placement.type;
    host.dataset['abyssCaptureDate'] = placement.date;
    return host;
  }

  private captureWrapper(parent: HTMLElement, className: string): HTMLElement {
    const current = [...parent.children].find(
      (candidate): candidate is HTMLElement =>
        candidate.instanceOf(parent.ownerDocument.defaultView!.HTMLElement) &&
        candidate.classList.contains(className),
    );
    return current ?? parent.createDiv({ cls: className });
  }

  private mountCaptureSurface(active: PanelCaptureSession, host: HTMLElement): void {
    if (this.activeCapture !== active) return;
    if (active.surface?.element.isConnected && active.host === host) return;
    this.unmountActiveCapture();
    let feedbackHost: HTMLElement | undefined;
    if (this.isCalendarCapturePlacement(active.placement)) {
      host.empty();
      feedbackHost = this.el.createDiv({ cls: 'abyss-calendar-capture-feedback' });
      active.feedbackHost = feedbackHost;
    } else {
      const trigger = host.querySelector<HTMLButtonElement>('.abyss-add-task-trigger');
      if (trigger) {
        trigger.hidden = true;
        active.returnFocus = trigger;
      }
    }
    const options =
      active.placement.type === 'calendar-timed'
        ? {
            placeholder: `Task at ${active.placement.time}…`,
            ...(feedbackHost && { feedbackHost }),
            onEscape: () => {
              active.restoreFocusOnClose = true;
            },
          }
        : {
            ...(feedbackHost && { feedbackHost }),
            onEscape: () => {
              active.restoreFocusOnClose = true;
            },
          };
    const presentation =
      active.placement.type === 'list' || active.placement.type === 'project'
        ? 'inline'
        : 'default';
    const surface = new CaptureSurface(host, active.controller, { ...options, presentation });
    const legacyInputClass = this.calendarCaptureInputClass(active.placement);
    if (legacyInputClass) surface.input.addClass(legacyInputClass);
    active.surface = surface;
    active.host = host;
    if (active.focusOnMount) {
      active.focusOnMount = false;
      surface.focus();
    }
  }

  private unmountActiveCapture(): void {
    const active = this.activeCapture;
    const surface = active?.surface;
    if (!active || !surface) return;
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
    if (host?.isConnected) {
      if (this.isCalendarCapturePlacement(placement)) host.remove();
      else {
        host.querySelector<HTMLButtonElement>('.abyss-add-task-trigger')?.removeAttribute('hidden');
      }
    }
    if (
      restoreFocus &&
      captureOwnedFocus &&
      returnFocus &&
      this.canRestoreCaptureFocus(returnFocus)
    ) {
      returnFocus.focus({ preventScroll: true });
    }
  }

  private cancelActiveCapture(): void {
    this.captureRequestId++;
    this.resolvingCapture = null;
    const active = this.activeCapture;
    if (!active) return;
    const host = active.host;
    const placement = active.placement;
    this.unmountActiveCapture();
    active.controller.destroy();
    this.activeCapture = null;
    if (host?.isConnected) {
      if (this.isCalendarCapturePlacement(placement)) host.remove();
      else {
        host.querySelector<HTMLButtonElement>('.abyss-add-task-trigger')?.removeAttribute('hidden');
      }
    }
  }

  private sameCapturePlacement(left: PanelCapturePlacement, right: PanelCapturePlacement): boolean {
    if (left.type !== right.type) return false;
    if (left.type === 'project') {
      return (
        right.type === 'project' &&
        left.path === right.path &&
        left.statusSymbol === right.statusSymbol
      );
    }
    if (left.type === 'calendar-timed') {
      return (
        right.type === 'calendar-timed' && left.date === right.date && left.time === right.time
      );
    }
    if (left.type === 'calendar-all-day') {
      return right.type === 'calendar-all-day' && left.date === right.date;
    }
    if (left.type === 'calendar-month') {
      return right.type === 'calendar-month' && left.date === right.date;
    }
    return right.type === 'list' && left.selectionKey === right.selectionKey;
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
    if (!ownerWindow) return false;
    const style = ownerWindow.getComputedStyle(element);
    return (
      style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse'
    );
  }

  private async deleteTask(task: TaskSnapshot): Promise<void> {
    const ref = task.ref;
    if (!ref || !this.tasks) return;
    const result = await this.tasks.execute({ type: 'delete', ref });
    presentTaskCommandResult(result);
    if (result.type !== 'ok' || result.outcome.type !== 'deleted') return;
    const stack = this.state.get('taskStack');
    const current = stack[0] ? rootTaskRef(stack[0]) : undefined;
    if (current && this.sameTaskRef(current, ref)) {
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
        viewState: this.mainTaskViewState(),
        settings: this.settings,
        today: window.moment().format('YYYY-MM-DD') as LocalDate,
        textQuery: this.mainTaskQuery(),
      }),
    ];
  }

  private getTitle(): string {
    const sel = this.state.get('selectedList');
    if (sel === 'inbox') return 'Inbox';
    if (sel === 'today') return 'Today';
    if (sel === 'upcoming') return 'Upcoming';
    if (typeof sel === 'object' && sel.type === 'tag') return sel.tag;
    if (typeof sel === 'object' && sel.type === 'project') return projectNameFromPath(sel.path);
    if (typeof sel === 'object' && sel.type === 'group') {
      const group = this.settings.tagGroups.find((g) => g.id === sel.groupId);
      return group?.name ?? 'Group';
    }
    return 'Tasks';
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
      if (group.mode === 'prefix' && group.prefix) {
        if (noHash === group.prefix || noHash.startsWith(`${group.prefix}/`)) {
          return group.color;
        }
      } else if (group.mode === 'manual' && group.tags) {
        if (group.tags.includes(tag) || group.tags.includes(noHash)) {
          return group.color;
        }
      }
    }
    return undefined;
  }

  private async rescheduleTask(dragData: string, targetDate: string): Promise<void> {
    const parts = dragData.split(':::');
    if (parts.length < 2) return;
    const [filePath, lineStr] = parts;
    const line = parseInt(lineStr ?? '0', 10);
    if (!filePath || isNaN(line)) return;

    const task = [...this.queries.list({ filePath })].find((t) => t.source.line === line);
    if (!task) return;

    const ref = task.ref;
    if (!ref || !this.tasks) return;
    try {
      const date = localDate(targetDate);
      const anchor =
        task.planning.start && task.planning.due
          ? task.planning.due
          : (task.planning.scheduled ?? task.planning.due);
      let command: Parameters<TaskApplicationApi['execute']>[0];
      if (!task.planning.time) command = { type: 'reschedule', ref, date };
      else if (!anchor) command = { type: 'convert-to-all-day', ref, date };
      else {
        command = {
          type: 'move-to-all-day',
          ref,
          days: daysBetweenLocalDates(anchor, date),
        };
      }
      presentTaskCommandResult(await this.tasks.execute(command));
    } catch {
      // Calendar controls supply the date; malformed gesture input remains a no-op.
    }
  }

  private async setTaskTimeFromDrop(dragData: string, date: string, time: string): Promise<void> {
    const parts = dragData.split(':::');
    if (parts.length < 2) return;
    const [filePath, lineStr] = parts;
    const line = parseInt(lineStr ?? '0', 10);
    if (!filePath || isNaN(line)) return;

    const task = [...this.queries.list({ filePath })].find((t) => t.source.line === line);
    if (!task) return;

    const ref = task.ref;
    if (!ref || !this.tasks) return;
    try {
      const targetDate = localDate(date);
      const targetTime = localTime(time);
      presentTaskCommandResult(
        await this.tasks.execute(
          task.planning.start && task.planning.due
            ? {
                type: 'move-time-slot',
                ref,
                days: daysBetweenLocalDates(task.planning.due, targetDate),
                time: targetTime,
              }
            : { type: 'set-time-slot', ref, date: targetDate, time: targetTime },
        ),
      );
    } catch {
      // A malformed drag payload is ignored without touching the task.
    }
  }

  private async commitTimedMove(task: TaskSnapshot, target: TimedDragTarget): Promise<void> {
    const ref = calendarRootTaskRef(task);
    if (!this.tasks || !ref) return;
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
    if (!this.tasks) return;
    try {
      const command = calendarPatchCommand(task, {
        time: {
          type: 'set',
          value: localTime(minutesToTimeString(target.startMinutes)),
        },
        duration: { type: 'set', value: durationMinutes(target.durationMinutes) },
      });
      if (!command) return;
      presentTaskCommandResult(await this.tasks.execute(command));
    } catch {
      // Keep the previous duration if a forged target fails validation.
    }
  }

  private async commitSpanMove(task: TaskSnapshot, target: SpanMoveTarget): Promise<void> {
    const ref = calendarRootTaskRef(task);
    if (!this.tasks || !ref || target.days === 0) return;
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
    if (!this.tasks || !ref) return;
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
    if (!this.tasks) return;
    try {
      const command = calendarPatchCommand(task, {
        time: { type: 'set', value: localTime(minutesToTimeString(newStartMinutes)) },
      });
      if (!command) return;
      presentTaskCommandResult(await this.tasks.execute(command));
    } catch {
      // Keep the previous valid time when gesture arithmetic is out of range.
    }
  }

  private async updateTaskDuration(task: TaskSnapshot, newDurationMinutes: number): Promise<void> {
    if (!this.tasks) return;
    try {
      const command = calendarPatchCommand(task, {
        duration: { type: 'set', value: durationMinutes(newDurationMinutes) },
      });
      if (!command) return;
      presentTaskCommandResult(await this.tasks.execute(command));
    } catch {
      // Keep the previous valid duration when gesture arithmetic is invalid.
    }
  }

  private async updateTaskStart(task: TaskSnapshot, newStart: string): Promise<void> {
    const ref = calendarRootTaskRef(task);
    if (!ref || !this.tasks) return;
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
    if (!ref || !this.tasks) return;
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
    if (!(task.planning.start ?? task.planning.scheduled ?? task.planning.due)) return;
    const ref = calendarRootTaskRef(task);
    if (!ref || !this.tasks) return;
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
    if (!target || !this.tasks) return;
    new LinkEditModal(
      this.app,
      token,
      (newRaw) => {
        void this.tasks!.execute({
          type: 'edit-link',
          target: { type: 'title', target },
          occurrence: occ,
          replacement: newRaw,
        }).then(presentTaskCommandResult);
      },
      task.source.filePath,
      this.interactionOwnership,
    ).open();
  }

  private async toggleDueToday(task: TaskSnapshot): Promise<void> {
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
    if (!command || !this.tasks) return false;
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
      firstDue && tasks.every((task) => task.planning.due === firstDue) ? firstDue : undefined;
    let cleanup: (() => void) | undefined;
    cleanup = showDatePickerPopover({
      owner: this.el,
      anchor,
      boundary: this.el,
      interactionOwnership: this.interactionOwnership,
      ...(initialValue !== undefined && { initialValue }),
      onPick: (inputValue) => {
        try {
          const value = localDate(inputValue);
          const pendingFocus = focusKey
            ? {
                key: focusKey,
                armedRenderGeneration: this.taskCardRenderGeneration,
                changed: false,
              }
            : undefined;
          if (pendingFocus) {
            this.pendingTaskDateFocus = pendingFocus;
            this.taskDateFocusContinuityKey = pendingFocus.key;
          }
          const update =
            tasks.length === 1
              ? this.setTaskDue(tasks[0]!, value)
              : this.applyDueInOrder(tasks, value);
          if (pendingFocus) {
            const settleFocus = (changed: boolean): void => {
              if (this.pendingTaskDateFocus !== pendingFocus) return;
              if (!changed) {
                this.clearTaskDateFocusContinuity(pendingFocus.key);
                return;
              }
              pendingFocus.changed = true;
              this.releaseSettledTaskDateFocus(pendingFocus);
            };
            const abandonFocus = (): void => settleFocus(false);
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
    if (!target || !('ownerDocument' in target)) return undefined;
    const ownerDocument = (target as { readonly ownerDocument?: Document }).ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    if (!ownerWindow || !(target instanceof ownerWindow.Element)) return undefined;
    const card = target.closest<HTMLElement>('.abyss-task-card');
    const filePath = card?.dataset['filePath'];
    const line = card?.dataset['line'];
    return card && this.el.contains(card) && filePath !== undefined && line !== undefined
      ? `${filePath}:${line}`
      : undefined;
  }

  private focusTaskDateTrigger(key: string): boolean {
    const card = Array.from(this.el.querySelectorAll<HTMLElement>('.abyss-task-card')).find(
      (candidate) =>
        `${candidate.dataset['filePath'] ?? ''}:${candidate.dataset['line'] ?? ''}` === key,
    );
    if (!card?.isConnected) return false;
    card.focus({ preventScroll: true });
    card.scrollIntoView?.({ block: 'nearest' });
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
    if (pending?.changed) this.releaseSettledTaskDateFocus(pending, restored);
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
    return scroll ? Array.from(scroll.querySelectorAll<HTMLElement>('.abyss-task-card')) : [];
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
    if (!this.selectionAnchorKey || !visible.has(this.selectionAnchorKey)) {
      this.selectionAnchorKey = firstSelected;
    }
    if (!this.selectionFocusKey || !visible.has(this.selectionFocusKey)) {
      this.selectionFocusKey = firstSelected;
    }
  }

  private focusTaskKey(key: string): void {
    const index = this.visibleTaskKeys().indexOf(key);
    const card = index === -1 ? undefined : this.visibleTaskCards()[index];
    if (!card) return;
    card.focus({ preventScroll: true });
    card.scrollIntoView?.({ block: 'nearest' });
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
    const projectWorkspaceActive =
      this.state.get('mode') === 'projects' &&
      this.projectWorkspaceSession.tasks.orderedActions().length > 0;
    const projectSelection = projectWorkspaceActive
      ? new Set(
          this.projectWorkspaceSession.tasks
            .selectedActions()
            .map(({ task }) => taskPresentationKey(task.ref)),
        )
      : null;
    this.el.querySelectorAll<HTMLElement>('.abyss-task-card').forEach((card) => {
      const key = `${card.dataset['filePath'] ?? ''}:${card.dataset['line'] ?? ''}`;
      const presentationKey = card.getAttribute('data-abyss-task-ref-key') ?? key;
      const isProjectCard = card.closest('[data-project-workspace]') !== null;
      const isSelected =
        projectSelection && isProjectCard
          ? projectSelection.has(presentationKey)
          : this.selectedTaskKeys.has(key);
      const selectedStateId = `abyss-selected-state-${encodeURIComponent(presentationKey)}`;
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
          .filter((id) => id && id !== selectedStateId && id !== selectedState?.id);
        if (describedBy.length > 0) {
          card.setAttribute('aria-describedby', describedBy.join(' '));
        } else {
          card.removeAttribute('aria-describedby');
        }
      }
    });

    const live = this.selectionLiveRegion();
    const count = projectWorkspaceActive
      ? this.projectWorkspaceSession.tasks.selectedCount()
      : this.selectedTaskKeys.size;
    if (count !== this.lastAnnouncedSelectionCount) {
      this.lastAnnouncedSelectionCount = count;
      live.textContent = `${count} ${count === 1 ? 'task' : 'tasks'} selected`;
    }
  }

  private selectionLiveRegion(): HTMLElement {
    const live = this.selectionLiveEl ?? this.el.ownerDocument.createElement('div');
    if (this.selectionLiveEl === null) {
      live.className = 'abyss-selection-live abyss-sr-only';
      live.setAttribute('aria-live', 'polite');
      live.setAttribute('aria-atomic', 'true');
      this.selectionLiveEl = live;
    }
    if (!live.isConnected || live.parentElement !== this.el) this.el.append(live);
    return live;
  }

  private async setPriority(
    task: TaskSnapshot,
    priority: 'A' | 'B' | 'C' | 'D' | 'E' | 'F',
  ): Promise<void> {
    if (isForecastCalendarTask(task)) return;
    const command = calendarPatchCommand(task, {
      priority: { type: 'set', value: priority },
    });
    if (!command || !this.tasks) return;
    presentTaskCommandResult(await this.tasks.execute(command));
  }

  private openStatusMenu(
    event: MouseEvent,
    task: TaskSnapshot,
    blockStatusMutationIfPending?: () => boolean,
  ): void {
    this.clearTaskDatePicker();
    this.dismissRecurrenceEditor();
    this.viewStatePopoverCleanup?.();
    showStatusMenuAt(event, {
      task,
      registry: this.statusRegistry,
      owner: this.md,
      onPickStatus: (symbol) => {
        if (blockStatusMutationIfPending?.()) return;
        void this.setTaskStatus(task, symbol);
      },
      onPickPriority: (priority) => void this.setPriority(task, priority),
      interactionOwnership: this.interactionOwnership,
    });
  }

  private toggleTask(task: TaskSnapshot): Promise<void> {
    if (isForecastCalendarTask(task)) return Promise.resolve(undefined);
    return requestTaskCompletion(
      task,
      () => this.commitTaskToggle(task),
      this.interactionOwnership,
      this.completionConfirmationAbortController.signal,
    );
  }

  private async commitTaskToggle(task: TaskSnapshot): Promise<void> {
    const target = calendarMutationTarget(task);
    if (!target || !this.tasks) return;
    presentTaskCommandResult(
      await this.tasks.execute({
        type: 'toggle-completion',
        target,
      }),
    );
  }

  private setTaskStatus(
    task: TaskSnapshot,
    symbol: string,
    present = true,
  ): Promise<TaskCommandResult | undefined> {
    if (isForecastCalendarTask(task)) return Promise.resolve(undefined);
    if (this.statusRegistry.bySymbol(symbol)?.type === 'done') {
      let result: TaskCommandResult | undefined;
      return requestTaskCompletion(
        task,
        async () => {
          result = await this.commitTaskStatus(task, symbol, present);
        },
        this.interactionOwnership,
        this.completionConfirmationAbortController.signal,
      ).then(() => result);
    }
    return this.commitTaskStatus(task, symbol, present);
  }

  private async applyBulkStatus(tasks: readonly TaskSnapshot[], symbol: string): Promise<void> {
    const results = await Promise.all(tasks.map((task) => this.setTaskStatus(task, symbol, false)));
    presentBulkTaskCommandResults(
      results.filter((result): result is TaskCommandResult => result !== undefined),
    );
  }

  private async commitTaskStatus(
    task: TaskSnapshot,
    symbol: string,
    present = true,
  ): Promise<TaskCommandResult | undefined> {
    const target = calendarMutationTarget(task);
    if (!target || !this.tasks) return;
    const result = await this.tasks.execute({ type: 'set-status', target, symbol });
    if (present) presentTaskCommandResult(result);
    return result;
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
    let cleanup: () => void;
    const handle = mountAnchoredRecurrenceEditor({
      anchor,
      source,
      policy: { removeScheduledDate: this.settings.recurrence.removeScheduledDate },
      ownershipConflict: hasOtherCalendarRecurrenceOwner(source),
      onSubmit: (patch) => {
        const command = calendarPatchCommand(task, patch);
        if (!this.tasks || !command) {
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
    cleanup = () => handle.dismiss();
    this.recurrenceEditorCleanup = cleanup;
  }

  private openForecastRecurrenceEditor(anchor: HTMLElement, source: CalendarTaskSource): void {
    this.dismissRecurrenceEditor();
    let cleanup: () => void;
    const handle = mountAnchoredRecurrenceEditor({
      anchor,
      source,
      policy: { removeScheduledDate: this.settings.recurrence.removeScheduledDate },
      ownershipConflict: hasOtherCalendarRecurrenceOwner(source),
      onSubmit: (patch) => {
        if (!this.tasks) {
          return Promise.resolve({
            type: 'io-error' as const,
            cause: 'application-unavailable',
            contentState: 'unchanged' as const,
          });
        }
        const command = calendarSourcePatchCommand(source, patch);
        if (!command) {
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
    cleanup = () => handle.dismiss();
    this.recurrenceEditorCleanup = cleanup;
  }

  private dismissRecurrenceEditor(): void {
    const cleanup = this.recurrenceEditorCleanup;
    this.recurrenceEditorCleanup = null;
    cleanup?.();
  }
}
