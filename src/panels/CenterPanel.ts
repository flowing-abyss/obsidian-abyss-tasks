import { Component, setIcon, type App } from 'obsidian';
import type { AppState } from '../app/AppState';
import {
  isListViewCustomized,
  listSelectionToKey,
  normalizeStatusGroups,
  statusGroupsEqual,
} from '../app/listViewState';
import { noteNameOfPath } from '../markdown/noteName';
import { PRIORITY_LEVELS } from '../priority';
import type { ProjectManager } from '../projects/ProjectManager';
import type { ProjectStore } from '../projects/ProjectStore';
import { getListViewDefaults } from '../settings/defaults';
import type { CalendarSettings, ListViewState, PropertyFilter } from '../settings/types';
import type { StatusRegistry } from '../status/StatusRegistry';
import { ACTIVE_STATUS_GROUPS, ALL_STATUS_GROUPS, TYPE_LABELS } from '../status/statusConstants';
import {
  resolveEffectiveTagGroups,
  tagMatchesGroup,
  type EffectiveTagGroup,
} from '../tags/effectiveTagGroups';
import { collectTaskNodeTags } from '../tags/taskTagCatalog';
import { searchTaskList, selectTaskList } from '../task-lists/TaskListSelector';
import {
  localDate,
  subtreeTotal,
  taskNodeAddress,
  totalMs,
  type CommentTimeContextProvider,
  type LocalDate,
  type TaskApplicationApi,
  type TaskCaptureApplicationApi,
  type TaskCommandResult,
  type TaskNodeSnapshot,
  type TaskQueryApi,
  type TaskRef,
  type TaskSnapshot,
  type TaskStatusType,
  type TrackedTotal,
} from '../tasks';
import { showDatePickerPopover } from '../ui/DatePickerPopover';
import { renderStatusMarker } from '../ui/StatusMarker';
import { TaskModal } from '../ui/TaskModal';
import {
  openViewOptionsPopover,
  type ViewOptionsMultiRow,
  type ViewOptionsSingleRow,
} from '../ui/ViewOptionsPopover';
import { isRealmHTMLElement } from '../ui/domRealm';
import { isImeOwnedEvent } from '../ui/ime';
import { noInteractionOwnership, type InteractionOwnershipPort } from '../ui/interactionOwnership';
import { showMenuAtMouseEventWithFocus } from '../ui/nativeMenuFocus';
import { mountAnchoredRecurrenceEditor } from '../ui/recurrence/RecurrenceEditor';
import {
  recurrenceBadgeInput,
  renderRecurrenceBadge,
} from '../ui/recurrence/renderRecurrenceBadge';
import { renderTaskText } from '../ui/renderTaskText';
import { runAsyncAction } from '../ui/runAsyncAction';
import { renderSourceNoteChip, shouldShowSourceNote } from '../ui/sourceNoteChip';
import { showStatusMenuAt } from '../ui/statusMenu';
import { type CreationResultDescription } from '../ui/taskCommandResult';
import {
  dependencyCompletionBlocked,
  renderDependencyIndicator,
  type TaskDependencyLookup,
} from '../ui/taskDependencyPresentation';
import { startTaskNodeDrag } from '../ui/taskNodeDrag';
import {
  applyTaskPresentationIdentity,
  renderedTaskNodeElements,
} from '../ui/taskPresentationIdentity';
import { taskNodeRef } from '../ui/taskSelection';
import type { TrackingSurface } from '../ui/timeTracking/TimeBadge';
import type { TrackingTickerState } from '../ui/timeTracking/TrackingTicker';
import { formatTrackedDuration } from '../ui/timeTracking/formatTracked';
import {
  calendarMutationTarget,
  calendarOccurrenceForTask,
  calendarPatchCommand,
  calendarSourcePatchCommand,
  hasOtherCalendarRecurrenceOwner,
  isForecastCalendarTask,
  type CalendarTaskSource,
} from '../views/calendarOccurrences';
import { PanelNavigator, type PanelNavigationActions } from '../views/panelNavigation';
import { listSelectionTitle } from '../views/panelTitle';
import { CalendarMode, type CalendarModeHost } from './calendar/CalendarMode';
import type { CalViewType } from './calendar/calendarViewType';
import { CaptureSessions } from './center/CaptureSessions';
import { TaskCommands } from './center/TaskCommands';
import { TaskMenus } from './center/TaskMenus';
import { ProjectsPanel } from './projects/ProjectsPanel';
import {
  mountTaskListRows,
  NO_MOUNTED_TASK_LIST_ROWS,
  type MountedTaskListRows,
} from './task-list/taskListRowView';
import {
  buildTaskListRows,
  NO_TASK_LIST_ROWS,
  taskListGrouping,
  taskRowKey,
  taskStackRowKey,
  type TaskListRows,
} from './task-list/taskListRows';
import { TaskRowSelection } from './task-list/taskRowSelection';

interface CenterPanelOptions {
  readonly state: AppState;
  readonly app: App;
  readonly settings: CalendarSettings;
  readonly queries: TaskQueryApi;
  readonly statusRegistry: StatusRegistry;
  readonly onSaveSettings?: (() => Promise<void>) | undefined;
  readonly projectStore?: ProjectStore | null | undefined;
  readonly projectManager?: ProjectManager | null | undefined;
  readonly tasks?: TaskApplicationApi | undefined;
  readonly commentTimeContext?: CommentTimeContextProvider | undefined;
  readonly captureApplication?: (TaskApplicationApi & TaskCaptureApplicationApi) | undefined;
  readonly onCreationResult?:
    ((result: TaskCommandResult, description: CreationResultDescription) => void) | undefined;
  readonly onRenderComplete?: ((root: HTMLElement) => void) | undefined;
  readonly interactionOwnership?: InteractionOwnershipPort | undefined;
  readonly navigation?: PanelNavigationActions | undefined;
  readonly onSaveViewState?: (() => Promise<void>) | undefined;
  readonly timeTracking?: TrackingSurface | undefined;
  readonly onRenderTaskHeaderActions?:
    ((header: HTMLElement, title: HTMLElement, controls: HTMLElement) => void) | undefined;
}

/** One rendered card badge a tick can repaint without asking the index anything again. */
interface RunningCardBadge {
  readonly total: TrackedTotal;
  readonly value: HTMLElement;
}

/** How a card badge names the root a running entry belongs to, for the tick that repaints it. */
function trackingRootAddress(ref: TaskRef): string {
  return taskNodeAddress({ type: 'task', ref });
}

export class CenterPanel {
  private el!: HTMLElement;
  private readonly offs_abyssPrivate: Array<() => void> = [];
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
  private taskModal_abyssPrivate: TaskModal | null = null;
  /** The list's multi-selection, anchor, and keyboard focus, kept across renders and modes. */
  private readonly rowSelection_abyssPrivate = new TaskRowSelection();
  private readonly taskCommands_abyssPrivate: TaskCommands;
  private readonly taskMenus_abyssPrivate: TaskMenus;
  private lastAnnouncedSelectionCount_abyssPrivate = 0;
  /** The rows the last card render mounted; every card render starts from none. */
  private mountedRows_abyssPrivate: MountedTaskListRows = NO_MOUNTED_TASK_LIST_ROWS;
  private filterDebounce_abyssPrivate = 0;
  private refocusSearch_abyssPrivate = false;
  private taskShell_abyssPrivate: {
    readonly key: string;
    readonly header: HTMLElement;
    readonly title: HTMLElement;
    readonly controls: HTMLElement;
    filterChips: HTMLElement[];
    readonly viewButton: HTMLButtonElement;
    readonly filterInput: HTMLInputElement;
    readonly scroll: HTMLElement;
    readonly addBar: HTMLElement;
  } | null = null;
  private readonly onSaveViewState_abyssPrivate: () => Promise<void>;
  private readonly onSaveSettings_abyssPrivate: (() => Promise<void>) | undefined;
  private md_abyssPrivate = new Component();
  private searchInputEl_abyssPrivate: HTMLInputElement | null = null;
  private searchResultsEl_abyssPrivate: HTMLElement | null = null;
  private searchResultsFrame_abyssPrivate: number | null = null;

  private projectsPanel_abyssPrivate: ProjectsPanel | null = null;
  private readonly captureApplication_abyssPrivate:
    (TaskApplicationApi & TaskCaptureApplicationApi) | null;
  private readonly captureSessions_abyssPrivate: CaptureSessions;
  private readonly navigation_abyssPrivate: PanelNavigationActions;
  private readonly calendar_abyssPrivate: CalendarMode;
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
  private readonly timeTracking_abyssPrivate: TrackingSurface | undefined;
  private readonly onRenderTaskHeaderActions_abyssPrivate:
    ((header: HTMLElement, title: HTMLElement, controls: HTMLElement) => void) | undefined;
  /** The running card badges of the current render, keyed by the root address a tick looks up. */
  private readonly runningCardBadges_abyssPrivate = new Map<string, RunningCardBadge>();
  /** The one instant every card badge of the current render is read against. */
  private cardRenderNowMs_abyssPrivate = 0;
  private trackingUnsubscribe_abyssPrivate: (() => void) | undefined;

  constructor(options: CenterPanelOptions) {
    const {
      state,
      app,
      settings,
      queries,
      statusRegistry,
      onSaveSettings,
      projectStore = null,
      projectManager = null,
      tasks,
      commentTimeContext,
      captureApplication,
      onCreationResult = (): void => {},
      onRenderComplete = (): void => {},
      interactionOwnership = noInteractionOwnership,
      navigation,
      onSaveViewState = async () => {},
      timeTracking,
      onRenderTaskHeaderActions,
    } = options;
    this.state_abyssPrivate = state;
    this.app_abyssPrivate = app;
    this.settings_abyssPrivate = settings;
    this.queries_abyssPrivate = queries;
    this.statusRegistry_abyssPrivate = statusRegistry;
    this.onSaveViewState_abyssPrivate = onSaveViewState;
    this.onSaveSettings_abyssPrivate = onSaveSettings;
    this.projectStore_abyssPrivate = projectStore;
    this.projectManager_abyssPrivate = projectManager;
    this.tasks_abyssPrivate = tasks;
    this.commentTimeContext_abyssPrivate = commentTimeContext;
    this.onCreationResult_abyssPrivate = onCreationResult;
    this.onRenderComplete_abyssPrivate = onRenderComplete;
    this.interactionOwnership_abyssPrivate = interactionOwnership;
    this.timeTracking_abyssPrivate = timeTracking;
    this.onRenderTaskHeaderActions_abyssPrivate = onRenderTaskHeaderActions;
    this.captureApplication_abyssPrivate = captureApplication ?? null;
    this.navigation_abyssPrivate = this.createNavigation_abyssPrivate(navigation);
    this.taskCommands_abyssPrivate = new TaskCommands({
      app,
      state,
      tasks,
      statusRegistry,
      interactionOwnership,
      projectManager,
      selection: this.rowSelection_abyssPrivate,
      onSelectionChanged: () => {
        this.updateSelectionVisuals_abyssPrivate();
      },
    });
    this.taskMenus_abyssPrivate = this.createTaskMenus_abyssPrivate();
    this.captureSessions_abyssPrivate = this.createCaptureSessions_abyssPrivate();
    this.calendar_abyssPrivate = new CalendarMode({
      state,
      app,
      settings,
      queries,
      tasks,
      statusRegistry,
      interactionOwnership: this.interactionOwnership_abyssPrivate,
      navigation: this.navigation_abyssPrivate,
      host: this.createCalendarHost_abyssPrivate(),
    });
  }

  private createCaptureSessions_abyssPrivate(): CaptureSessions {
    return new CaptureSessions({
      state: this.state_abyssPrivate,
      settings: this.settings_abyssPrivate,
      application: this.captureApplication_abyssPrivate,
      listNodes: () => this.tasks_abyssPrivate?.queries.listNodes() ?? [],
      onCreationResult: (result, description) => {
        this.onCreationResult_abyssPrivate(result, description);
      },
      root: () => this.el,
    });
  }

  private createTaskMenus_abyssPrivate(): TaskMenus {
    return new TaskMenus({
      app: this.app_abyssPrivate,
      settings: this.settings_abyssPrivate,
      statusRegistry: this.statusRegistry_abyssPrivate,
      interactionOwnership: this.interactionOwnership_abyssPrivate,
      timeTracking: this.timeTracking_abyssPrivate,
      commands: this.taskCommands_abyssPrivate,
      host: {
        openDatePicker: (anchor, selectedTasks) => {
          this.openTaskDatePicker_abyssPrivate(anchor, selectedTasks);
        },
        openRecurrenceEditor: (anchor, task) => {
          this.openRecurrenceEditor_abyssPrivate(anchor, task);
        },
        addFilter: (filter) => {
          this.addPropertyFilter_abyssPrivate(filter);
        },
        tagCatalog: () => this.taskTagCatalog_abyssPrivate(),
        tagColor: (tag, groups) => this.getTagColor_abyssPrivate(tag, groups),
      },
    });
  }

  private createCalendarHost_abyssPrivate(): CalendarModeHost {
    return {
      rerender: () => {
        this.render_abyssPrivate();
      },
      openTask: (task) => {
        this.taskModal_abyssPrivate?.open(task);
      },
      openForecastTask: (source, referenceDate) => {
        this.openForecastTask_abyssPrivate(source, referenceDate);
      },
      toggleTask: (task) => this.taskCommands_abyssPrivate.toggleTask(task),
      setTaskStatus: (task, symbol) => this.taskCommands_abyssPrivate.setTaskStatus(task, symbol),
      setPriority: (task, priority) => this.taskCommands_abyssPrivate.setPriority(task, priority),
      dependenciesFor: (task) => this.dependenciesFor_abyssPrivate(task),
      tagGroups: () => this.effectiveTagGroups_abyssPrivate(),
      openForecastRecurrenceEditor: (anchor, source) => {
        this.openForecastRecurrenceEditor_abyssPrivate(anchor, source);
      },
      dismissRecurrenceEditor: () => {
        this.dismissRecurrenceEditor_abyssPrivate();
      },
      openCapture: (placement) => {
        this.captureSessions_abyssPrivate.openCapture(placement, {
          type: 'default',
          source: 'calendar',
        });
      },
      unmountActiveCapture: () => {
        this.captureSessions_abyssPrivate.unmountActiveCapture();
      },
      remountActiveCapture: () => {
        this.captureSessions_abyssPrivate.remountActiveCapture();
      },
      syncTaskStackSelection: () => {
        this.updateTaskStackSelection_abyssPrivate();
      },
      onRenderComplete: (root) => {
        this.onRenderComplete_abyssPrivate(root);
      },
    };
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
        this.onSaveViewState_abyssPrivate,
      )
    );
  }

  mount(container: HTMLElement): void {
    this.el = container;
    this.initializeOwnedUi_abyssPrivate();
    this.initializeListViewState_abyssPrivate();
    this.subscribeToState_abyssPrivate();
    this.subscribeToTracking_abyssPrivate();
    this.render_abyssPrivate();
    this.el.setAttribute('tabindex', '0');
    this.mountKeyboardNavigation_abyssPrivate();
    this.mountFocusContinuity_abyssPrivate();
  }

  private initializeOwnedUi_abyssPrivate(): void {
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
        this.captureSessions_abyssPrivate.cancelStaleListCapture();
        this.calendar_abyssPrivate.cancelKeyboardInteraction();
      }),
      this.state_abyssPrivate.on('searchQuery', (query) => {
        this.handleSearchQueryChanged_abyssPrivate(query);
      }),
      this.state_abyssPrivate.on('taskStack', () => {
        this.updateTaskStackSelection_abyssPrivate();
      }),
      this.state_abyssPrivate.on('projectsPanel', (next, previous) => {
        if (previous.view === 'dashboard' && next.view === 'table') {
          this.captureSessions_abyssPrivate.cancelActiveCapture();
        }
      }),
      this.state_abyssPrivate.onCommit((changed) => {
        this.handleStateCommit_abyssPrivate(changed);
      }),
    );
  }

  private handleSelectedListChanged_abyssPrivate(): void {
    this.captureSessions_abyssPrivate.cancelStaleListCapture();
    this.rowSelection_abyssPrivate.clear();
  }

  private updateTaskStackSelection_abyssPrivate(): void {
    const stack = this.state_abyssPrivate.get('taskStack');
    const root = stack[0];
    const current = stack[stack.length - 1];
    const detailKey = taskStackRowKey(stack);
    const deletable =
      root !== undefined &&
      'source' in root &&
      current === root &&
      this.rowSelection_abyssPrivate.size === 0
        ? root
        : undefined;
    for (const [key, card] of this.mountedRows_abyssPrivate.cards()) {
      const isSelected = key === detailKey;
      card.classList.toggle('is-selected', isSelected);
      this.syncTaskDeleteButton_abyssPrivate(card, isSelected ? deletable : undefined);
    }
    this.el.querySelectorAll<HTMLElement>('.abyss-calendar-item.is-selected').forEach((item) => {
      item.classList.remove('is-selected');
    });
    if (current !== undefined) {
      renderedTaskNodeElements(this.el, taskNodeRef(current)).forEach((item) => {
        item.classList.add('is-selected');
      });
    }
  }

  private handleStateCommit_abyssPrivate(changed: ReadonlySet<string>): void {
    if (changed.size === 0 && this.state_abyssPrivate.get('mode') === 'calendar') {
      this.calendar_abyssPrivate.cancelKeyboardInteraction();
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
    if (isImeOwnedEvent(event)) return;
    if (event.key === 'Escape' && this.rowSelection_abyssPrivate.isActive()) {
      this.clearTaskSelection_abyssPrivate();
      return;
    }
    if (!this.isTaskNavigationEvent_abyssPrivate(event)) return;
    const order = this.listOrder_abyssPrivate();
    if (order.taskKeys.length === 0) return;
    event.preventDefault();
    this.moveTaskSelection_abyssPrivate(event, order);
  }

  private clearTaskSelection_abyssPrivate(): void {
    this.rowSelection_abyssPrivate.clear();
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

  /** Model, visuals, the opened task for a plain arrow, then focus, as the list always did. */
  private moveTaskSelection_abyssPrivate(event: KeyboardEvent, order: TaskListRows): void {
    const extend = event.shiftKey;
    const next = this.rowSelection_abyssPrivate.move(
      event.key === 'ArrowDown' ? 'down' : 'up',
      order,
      {
        target: this.eventTaskCardKey_abyssPrivate(event.target),
        detail: taskStackRowKey(this.state_abyssPrivate.get('taskStack')),
      },
      extend,
    );
    if (next === undefined) return;
    this.updateSelectionVisuals_abyssPrivate();
    const task = extend ? undefined : order.task(next);
    if (task !== undefined) this.state_abyssPrivate.set('taskStack', [task]);
    this.focusTaskKey_abyssPrivate(next);
  }

  /** The key of the card a key event came from, read from that card. */
  private eventTaskCardKey_abyssPrivate(target: EventTarget | null): string | undefined {
    const card = isRealmHTMLElement(target)
      ? target.closest<HTMLElement>('.abyss-task-card')
      : null;
    return card != null && this.el.contains(card)
      ? `${card.dataset['filePath'] ?? ''}:${card.dataset['line'] ?? ''}`
      : undefined;
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
    const onOwnerWindowBlur = (event: Event): void => {
      const nextTarget = (event as FocusEvent).relatedTarget;
      if (
        isRealmHTMLElement(nextTarget) &&
        nextTarget.isConnected &&
        nextTarget.ownerDocument === ownerDocument
      )
        return;
      this.abandonTaskDateFocus_abyssPrivate();
      if (this.calendar_abyssPrivate.hasPendingTimedBlockFocus())
        this.calendar_abyssPrivate.cancelKeyboardInteraction();
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
    if (block != null && this.el.contains(block))
      this.calendar_abyssPrivate.retainTimedBlockFocus(block);
    else if (this.calendar_abyssPrivate.hasPendingTimedBlockFocus())
      this.calendar_abyssPrivate.cancelKeyboardInteraction();
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

  selectedProjectPath(): string | undefined {
    if (this.state_abyssPrivate.get('mode') !== 'projects') return undefined;
    return this.projectsPanel_abyssPrivate?.selectedProjectPath();
  }

  calendarView(): CalViewType {
    return this.calendar_abyssPrivate.view();
  }

  /** The heading of the tasks list for the current selection, as the center header shows it. */
  title(): string {
    return this.getTitle_abyssPrivate();
  }

  setCalendarView(view: CalViewType): void {
    this.calendar_abyssPrivate.setView(view);
  }

  destroy(): void {
    this.trackingUnsubscribe_abyssPrivate?.();
    this.trackingUnsubscribe_abyssPrivate = undefined;
    // Nothing can repaint them any more, and their elements go with the panel.
    this.runningCardBadges_abyssPrivate.clear();
    this.endTaskDrag_abyssPrivate?.();
    this.taskCommands_abyssPrivate.dispose();
    this.captureSessions_abyssPrivate.cancelActiveCapture();
    this.calendar_abyssPrivate.cancelKeyboardInteraction();
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
    this.calendar_abyssPrivate.destroy();
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
    this.beginTaskCardRender_abyssPrivate();
    const tasks = [...this.queries_abyssPrivate.list({ filePath: path })];
    const tagGroups = this.effectiveTagGroups_abyssPrivate();
    const scroll = host.createDiv({ cls: 'abyss-center-scroll abyss-project-tasks-scroll' });
    if (tasks.length === 0) {
      scroll.createDiv({ cls: 'abyss-center-empty', text: 'No tasks yet' });
    } else {
      this.renderFlat_abyssPrivate(scroll, tasks, tagGroups);
    }

    const bar = host.createDiv({ cls: 'abyss-add-task-bar' });
    this.captureSessions_abyssPrivate.renderCaptureHost(bar, { type: 'project', path });
    this.completeTaskCardRender_abyssPrivate();
  }

  private render_abyssPrivate(): void {
    const mode = this.state_abyssPrivate.get('mode');
    if (this.refreshMountedProjects_abyssPrivate(mode)) return;
    this.beginTaskCardRender_abyssPrivate();
    const retainTaskShell = this.canRetainTaskShell_abyssPrivate(mode);
    this.prepareRender_abyssPrivate(mode, retainTaskShell);
    if (mode !== 'projects') this.destroyProjectsPanel_abyssPrivate();
    if (mode === 'calendar') {
      this.el.removeClass('abyss-center--projects');
      this.el.addClass('abyss-center--calendar');
      this.calendar_abyssPrivate.render(this.el);
      return;
    }
    this.prepareNonCalendarRoot_abyssPrivate(retainTaskShell);
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

  private canRetainTaskShell_abyssPrivate(mode: string): boolean {
    const shell = this.taskShell_abyssPrivate;
    return (
      mode === 'tasks' &&
      shell?.key === this.activeListKey_abyssPrivate() &&
      shell.header.isConnected &&
      shell.scroll.isConnected &&
      shell.addBar.isConnected
    );
  }

  private prepareRender_abyssPrivate(mode: string, retainTaskShell = false): void {
    this.captureSessions_abyssPrivate.unmountActiveCapture();
    this.clearTaskDatePicker_abyssPrivate();
    this.dismissRecurrenceEditor_abyssPrivate();
    if (!retainTaskShell) this.viewStatePopoverCleanup_abyssPrivate?.();
    this.clearSearchShell_abyssPrivate();
    if (mode === 'search') return;
    this.md_abyssPrivate.unload();
    this.md_abyssPrivate = new Component();
    this.md_abyssPrivate.load();
  }

  private prepareNonCalendarRoot_abyssPrivate(retainTaskShell = false): void {
    this.el.removeClass('abyss-center--calendar');
    this.calendar_abyssPrivate.unmount();
    if (!retainTaskShell) {
      this.clearTaskShell_abyssPrivate();
      this.el.empty();
    }
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
        saveViewState: this.onSaveViewState_abyssPrivate,
        ...(this.onSaveSettings_abyssPrivate === undefined
          ? {}
          : { saveStatic: this.onSaveSettings_abyssPrivate }),
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
    const shell = this.ensureTaskShell_abyssPrivate();
    this.syncTaskHeader_abyssPrivate(shell);
    const { scroll, addBar } = shell;
    const scrollTop = scroll.scrollTop;
    const scrollLeft = scroll.scrollLeft;
    const staging = scroll.cloneNode(false) as HTMLElement;
    const tasks = this.getFilteredTasks_abyssPrivate();
    const tagGroups = this.effectiveTagGroups_abyssPrivate();
    if (tasks.length === 0) staging.createDiv({ cls: 'abyss-center-empty', text: 'No tasks' });
    else this.renderWithGrouping_abyssPrivate(staging, tasks, tagGroups);
    scroll.replaceChildren(...staging.childNodes);
    if (scrollTop !== 0) {
      scroll.scrollTop = Math.min(
        scrollTop,
        Math.max(0, scroll.scrollHeight - scroll.clientHeight),
      );
    }
    if (scrollLeft !== 0) {
      scroll.scrollLeft = Math.min(
        scrollLeft,
        Math.max(0, scroll.scrollWidth - scroll.clientWidth),
      );
    }
    addBar.empty();
    this.captureSessions_abyssPrivate.renderCaptureHost(addBar, {
      type: 'list',
      selectionKey: listSelectionToKey(this.state_abyssPrivate.get('selectedList')),
    });
    this.rowSelection_abyssPrivate.reconcile(this.listOrder_abyssPrivate());
    this.updateSelectionVisuals_abyssPrivate();
    this.completeTaskCardRender_abyssPrivate();
  }

  private ensureTaskShell_abyssPrivate(): NonNullable<CenterPanel['taskShell_abyssPrivate']> {
    if (this.canRetainTaskShell_abyssPrivate('tasks')) {
      return this.taskShell_abyssPrivate as NonNullable<CenterPanel['taskShell_abyssPrivate']>;
    }
    this.clearTaskShell_abyssPrivate();
    const header = this.el.createDiv({ cls: 'abyss-center-header' });
    const title = header.createEl('h2', { cls: 'abyss-center-title' });
    const controls = header.createDiv({ cls: 'abyss-center-controls' });
    const viewButton = this.renderViewStateButton_abyssPrivate(controls);
    const filterInput = this.renderTaskFilterInput_abyssPrivate(controls);
    this.onRenderTaskHeaderActions_abyssPrivate?.(header, title, controls);
    const scroll = this.el.createDiv({ cls: 'abyss-center-scroll' });
    const addBar = this.el.createDiv({ cls: 'abyss-add-task-bar' });
    const shell: NonNullable<CenterPanel['taskShell_abyssPrivate']> = {
      key: this.activeListKey_abyssPrivate(),
      header,
      title,
      controls,
      filterChips: [],
      viewButton,
      filterInput,
      scroll,
      addBar,
    };
    this.taskShell_abyssPrivate = shell;
    return shell;
  }

  private syncTaskHeader_abyssPrivate(
    shell: NonNullable<CenterPanel['taskShell_abyssPrivate']>,
  ): void {
    shell.title.setText(this.getTitle_abyssPrivate());
    for (const chip of shell.filterChips) chip.remove();
    shell.filterChips = this.renderPropertyChips_abyssPrivate(shell.controls, shell.viewButton);
    const viewState = this.state_abyssPrivate.get('centerListViewState');
    shell.viewButton.toggleClass(
      'abyss-view-state-btn--active',
      isListViewCustomized(viewState, this.activeListKey_abyssPrivate()),
    );
    const { filterInput } = shell;
    const filter = this.state_abyssPrivate.get('centerFilter');
    if (filterInput.value !== filter) filterInput.value = filter;
    if (this.refocusSearch_abyssPrivate) {
      this.refocusSearch_abyssPrivate = false;
      window.setTimeout(() => {
        if (!filterInput.isConnected) return;
        filterInput.focus();
        filterInput.setSelectionRange(filterInput.value.length, filterInput.value.length);
      }, 0);
    }
  }

  private clearTaskShell_abyssPrivate(): void {
    this.taskShell_abyssPrivate = null;
  }

  private renderTaskFilterInput_abyssPrivate(controls: HTMLElement): HTMLInputElement {
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
    return searchInput;
  }

  private openForecastTask_abyssPrivate(
    source: CalendarTaskSource,
    referenceDate: LocalDate,
  ): void {
    // The anchored editor ignores presses on its own anchor, so close it before the modal opens.
    this.dismissRecurrenceEditor_abyssPrivate();
    this.taskModal_abyssPrivate?.open(source.root);
    const modal = activeDocument.querySelector<HTMLElement>('.abyss-modal');
    if (modal == null) return;
    const context = modal.createDiv({
      cls: 'abyss-forecast-source-context',
      text: `Forecast for ${referenceDate}`,
    });
    modal.prepend(context);
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
    this.beginTaskCardRender_abyssPrivate();
    this.md_abyssPrivate.unload();
    this.md_abyssPrivate = new Component();
    this.md_abyssPrivate.load();
    host.empty();
    host.toggleClass('abyss-search-empty', query.length === 0);

    if (query.length === 0) {
      host.createDiv({ cls: 'abyss-center-empty', text: 'Type to search tasks…' });
      this.completeTaskCardRender_abyssPrivate();
      return;
    }

    const matchingTasks = [...searchTaskList(this.queries_abyssPrivate.list(), query)];
    if (matchingTasks.length === 0) {
      host.createDiv({ cls: 'abyss-center-empty', text: 'No results' });
      this.completeTaskCardRender_abyssPrivate();
      return;
    }
    this.renderFlat_abyssPrivate(
      host,
      matchingTasks,
      this.effectiveTagGroups_abyssPrivate(),
      (card, task) => {
        this.mountSearchResultNavigation_abyssPrivate(card, task);
      },
    );
    this.completeTaskCardRender_abyssPrivate();
  }

  /**
   * A click on a Search result opens Today, Upcoming, or Inbox with the task selected, except on
   * its status control. The capture listener joins after the card's own listeners.
   */
  private mountSearchResultNavigation_abyssPrivate(card: HTMLElement, task: TaskSnapshot): void {
    card.addEventListener(
      'click',
      (e) => {
        const statusControl = card.querySelector('.abyss-status-control, .abyss-status-marker');
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
  }

  private renderWithGrouping_abyssPrivate(
    container: HTMLElement,
    tasks: TaskSnapshot[],
    tagGroups: readonly EffectiveTagGroup[] = this.effectiveTagGroups_abyssPrivate(),
  ): void {
    const vs = this.state_abyssPrivate.get('centerListViewState');
    const grouping = taskListGrouping(vs.groupBy, {
      today: localDate(window.moment().format('YYYY-MM-DD')),
      tomorrow: window.moment().add(1, 'day').format('YYYY-MM-DD'),
      statuses: this.statusRegistry_abyssPrivate,
    });
    this.mountTaskRows_abyssPrivate(container, buildTaskListRows(tasks, grouping), tagGroups);
  }

  /** Mounts the tasks as ungrouped rows: Search results and a dashboard list. */
  private renderFlat_abyssPrivate(
    container: HTMLElement,
    tasks: TaskSnapshot[],
    tagGroups: readonly EffectiveTagGroup[] = this.effectiveTagGroups_abyssPrivate(),
    onCard?: (card: HTMLElement, task: TaskSnapshot) => void,
  ): void {
    this.mountTaskRows_abyssPrivate(
      container,
      buildTaskListRows(tasks, { by: 'none' }),
      tagGroups,
      onCard,
    );
  }

  /** The one place list rows become elements; the handle it keeps serves every later patch. */
  private mountTaskRows_abyssPrivate(
    container: HTMLElement,
    rows: TaskListRows,
    tagGroups: readonly EffectiveTagGroup[],
    onCard?: (card: HTMLElement, task: TaskSnapshot) => void,
  ): void {
    this.mountedRows_abyssPrivate = mountTaskListRows(container, rows, (host, row) => {
      const card = this.renderTaskCard_abyssPrivate(host, row.task, tagGroups);
      onCard?.(card, row.task);
      return card;
    });
  }

  private renderTaskCard_abyssPrivate(
    container: HTMLElement,
    task: TaskSnapshot,
    tagGroups: readonly EffectiveTagGroup[] = this.effectiveTagGroups_abyssPrivate(),
  ): HTMLElement {
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
    this.renderTaskCardBody_abyssPrivate(mainRow, task);
    this.renderTaskCardMetadata_abyssPrivate(mainRow, task, tagGroups);
    this.mountTaskCardInteractions_abyssPrivate(card, task);
    this.syncTaskDeleteButton_abyssPrivate(
      card,
      isSelected && this.rowSelection_abyssPrivate.size === 0 ? task : undefined,
    );
    return card;
  }

  private isTaskCardSelected_abyssPrivate(task: TaskSnapshot): boolean {
    return taskStackRowKey(this.state_abyssPrivate.get('taskStack')) === taskRowKey(task);
  }

  private renderTaskStatus_abyssPrivate(mainRow: HTMLElement, task: TaskSnapshot): void {
    const projection = this.dependenciesFor_abyssPrivate(task);
    renderStatusMarker(mainRow, {
      task,
      registry: this.statusRegistry_abyssPrivate,
      completionBlocked: dependencyCompletionBlocked(projection),
      onLeftClick: () => {
        runAsyncAction(this.taskCommands_abyssPrivate.toggleTask(task));
      },
      onContextMenu: (event) => {
        event.stopPropagation();
        this.openStatusMenu_abyssPrivate(event, task);
      },
    });
    mainRow.toggleClass(
      'abyss-task-card-main-row--has-dep',
      renderDependencyIndicator(mainRow, projection) !== undefined,
    );
  }

  private readonly dependenciesFor_abyssPrivate: TaskDependencyLookup = (task) => {
    const target = calendarMutationTarget(task);
    return target === undefined ? undefined : this.tasks_abyssPrivate?.queries.dependencies(target);
  };

  private renderTaskCardBody_abyssPrivate(mainRow: HTMLElement, task: TaskSnapshot): void {
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
        this.taskCommands_abyssPrivate.editTaskLink(task, occurrence, token);
      },
    });
    this.renderTaskDescription_abyssPrivate(body, task);
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
    this.renderTrackedTimeBadge_abyssPrivate(titleRow, task);
  }

  private renderTaskCountBadge_abyssPrivate(
    host: HTMLElement,
    icon: string,
    text: string,
    cls = 'abyss-task-count-badge',
  ): { readonly badge: HTMLElement; readonly value: HTMLElement } {
    const badge = host.createSpan({ cls });
    setIcon(badge, icon);
    return { badge, value: badge.createSpan({ text }) };
  }

  /**
   * A render owns the badges it creates and the instant they are read against, so the previous
   * render's badges go with it and every card in this one shows the same clock.
   */
  private beginTaskCardRender_abyssPrivate(): void {
    this.mountedRows_abyssPrivate = NO_MOUNTED_TASK_LIST_ROWS;
    this.runningCardBadges_abyssPrivate.clear();
    this.cardRenderNowMs_abyssPrivate = this.timeTracking_abyssPrivate?.context().nowMs ?? 0;
  }

  /**
   * Tracked time on a card, as a passive reading of the snapshot the render was handed. A running
   * subtree keeps its total here so the shared tick is one addition per running root and one DOM
   * write per displayed minute, never a walk of the list or a question to the index.
   */
  private renderTrackedTimeBadge_abyssPrivate(titleRow: HTMLElement, task: TaskSnapshot): void {
    const tracking = this.timeTracking_abyssPrivate;
    if (tracking === undefined || isForecastCalendarTask(task)) return;
    const total = subtreeTotal(task);
    const running = total.openStartsMs.length > 0;
    const tracked = totalMs(total, this.cardRenderNowMs_abyssPrivate);
    if (!running && tracked <= 0) return;
    const { badge, value } = this.renderTaskCountBadge_abyssPrivate(
      titleRow,
      'timer',
      formatTrackedDuration(tracked),
      `abyss-task-count-badge abyss-task-time-badge${running ? ' is-tracking' : ''}`,
    );
    if (!running) return;
    const address = trackingRootAddress(task.ref);
    badge.dataset['trackingRoot'] = address;
    this.runningCardBadges_abyssPrivate.set(address, { total, value });
  }

  /** One subscription per panel repaints the running roots, and only those. */
  private subscribeToTracking_abyssPrivate(): void {
    const tracking = this.timeTracking_abyssPrivate;
    if (tracking === undefined) return;
    // A remount must not leave the previous mount listening, so the panel keeps exactly one.
    this.trackingUnsubscribe_abyssPrivate?.();
    this.trackingUnsubscribe_abyssPrivate = tracking.ticker.subscribe((state) => {
      this.paintRunningCardBadges_abyssPrivate(state);
    });
  }

  private paintRunningCardBadges_abyssPrivate({ nowMs, active }: TrackingTickerState): void {
    const badges = this.runningCardBadges_abyssPrivate;
    if (badges.size === 0) return;
    for (const entry of active) {
      // The entry already carries its root's address, so a tick reads a string rather than builds one.
      const badge = badges.get(entry.rootAddress);
      if (badge === undefined) continue;
      const tracked = formatTrackedDuration(totalMs(badge.total, nowMs));
      if (badge.value.textContent !== tracked) badge.value.setText(tracked);
    }
  }

  private renderTaskDescription_abyssPrivate(host: HTMLElement, task: TaskSnapshot): void {
    const description = task.description;
    if (description === undefined || description === '') return;
    const descriptionElement = host.createDiv({ cls: 'abyss-task-desc' });
    renderTaskText(descriptionElement, description.split('\n')[0] ?? '', {
      app: this.app_abyssPrivate,
      sourcePath: task.source.filePath,
      component: this.md_abyssPrivate,
    });
  }

  private renderTaskCardMetadata_abyssPrivate(
    mainRow: HTMLElement,
    task: TaskSnapshot,
    tagGroups: readonly EffectiveTagGroup[],
  ): void {
    const today = localDate(window.moment().format('YYYY-MM-DD'));
    const sel = this.state_abyssPrivate.get('selectedList');
    const d = task.planning.due ?? task.planning.scheduled;
    const tags = task.tags;
    const suppressToday = sel === 'today' && d === today;
    const showSourceNote = shouldShowSourceNote(
      task,
      this.settings_abyssPrivate.sourceNoteDisplay,
      this.settings_abyssPrivate.taskFilePath,
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
      this.renderTaskTagMetadata_abyssPrivate(metaRight, task, tag, tagGroups);
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
    tagGroups: readonly EffectiveTagGroup[],
  ): void {
    const element = host.createSpan({ cls: 'abyss-task-tag abyss-cursor-pointer', text: tag });
    const color = this.getTagColor_abyssPrivate(tag, tagGroups);
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
    runAsyncAction(this.taskCommands_abyssPrivate.patchTaskTags(task, [dragging], [replacedTag]));
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
      runAsyncAction(this.taskCommands_abyssPrivate.deleteTask(task));
    });
  }

  private handleTaskCardClick_abyssPrivate(event: MouseEvent, task: TaskSnapshot): void {
    const key = taskRowKey(task);
    if (event.ctrlKey || event.metaKey) {
      this.rowSelection_abyssPrivate.toggle(key);
      this.updateSelectionVisuals_abyssPrivate();
      this.focusTaskKey_abyssPrivate(key);
      return;
    }
    if (event.shiftKey) {
      this.rowSelection_abyssPrivate.extendTo(key, this.listOrder_abyssPrivate());
      this.updateSelectionVisuals_abyssPrivate();
      this.focusTaskKey_abyssPrivate(key);
      return;
    }
    this.rowSelection_abyssPrivate.collapseTo(key);
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
      runAsyncAction(this.taskCommands_abyssPrivate.patchTaskTags(task, [tag], []));
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
    runAsyncAction(this.taskCommands_abyssPrivate.moveTaskToProject(task, project));
  }

  private handleTaskContextMenu_abyssPrivate(
    event: MouseEvent,
    card: HTMLElement,
    task: TaskSnapshot,
  ): void {
    event.preventDefault();
    const key = taskRowKey(task);
    const selection = this.rowSelection_abyssPrivate;
    if (selection.size > 0 && !selection.has(key)) this.clearTaskSelection_abyssPrivate();
    if (selection.size >= 2) {
      this.taskMenus_abyssPrivate.showBulkContextMenu(
        event,
        card,
        this.selectedTasksInVisualOrder_abyssPrivate(),
      );
      return;
    }
    const menu = this.taskMenus_abyssPrivate.createTaskContextMenu(card, task);
    showMenuAtMouseEventWithFocus(menu, event);
  }

  /** The selected tasks in display order, as the snapshots their cards were rendered from. */
  private selectedTasksInVisualOrder_abyssPrivate(): TaskSnapshot[] {
    const order = this.listOrder_abyssPrivate();
    return this.rowSelection_abyssPrivate.inOrder(order).flatMap((key) => {
      const task = order.task(key);
      return task === undefined ? [] : [task];
    });
  }

  /** Renders one chip per filter right before the view-state button and returns them in order. */
  private renderPropertyChips_abyssPrivate(
    controls: HTMLElement,
    viewButton: HTMLElement,
  ): HTMLElement[] {
    const vs = this.state_abyssPrivate.get('centerListViewState');
    const chips: HTMLElement[] = [];
    for (const [i, f] of vs.filters.entries()) {
      const label = this.filterChipLabel_abyssPrivate(f);
      const chip = controls.createSpan({ cls: 'abyss-filter-chip' });
      viewButton.before(chip);
      chip.createSpan({ cls: 'abyss-filter-chip-label', text: label });
      const x = chip.createEl('button', { cls: 'abyss-filter-chip-x', text: '×' });
      const idx = i;
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        this.removePropertyFilter_abyssPrivate(idx);
      });
      chips.push(chip);
    }
    return chips;
  }

  private filterChipLabel_abyssPrivate(f: PropertyFilter): string {
    if (f.type === 'file') {
      return `📄 ${noteNameOfPath(f.filePath)}`;
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
    runAsyncAction(this.onSaveViewState_abyssPrivate(), 'Could not save list view state');
    this.state_abyssPrivate.set('centerListViewState', next);
  }

  private activeListKey_abyssPrivate(): string {
    return listSelectionToKey(this.state_abyssPrivate.get('selectedList'));
  }

  private renderViewStateButton_abyssPrivate(container: HTMLElement): HTMLButtonElement {
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
    return btn;
  }

  private showViewStatePopover_abyssPrivate(anchor: HTMLElement): void {
    if (this.viewStatePopoverCleanup_abyssPrivate != null) {
      this.viewStatePopoverCleanup_abyssPrivate(true);
      return;
    }

    const defaults = getListViewDefaults(this.activeListKey_abyssPrivate());
    const close = openViewOptionsPopover({
      host: this.el,
      anchor,
      rows: [
        this.groupByRowSpec_abyssPrivate(defaults),
        this.sortByRowSpec_abyssPrivate(defaults),
        this.statusGroupsRowSpec_abyssPrivate(),
      ],
      showReset: () =>
        isListViewCustomized(
          this.state_abyssPrivate.get('centerListViewState'),
          this.activeListKey_abyssPrivate(),
        ),
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

  private groupByRowSpec_abyssPrivate(defaults: ListViewState): ViewOptionsSingleRow {
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
      displayValue: () => {
        const groupBy = this.state_abyssPrivate.get('centerListViewState').groupBy;
        return labels[groupBy] ?? groupBy;
      },
      activeValue: () => this.state_abyssPrivate.get('centerListViewState').groupBy,
      options: Object.entries(labels).map(([value, label]) => ({
        label,
        value,
        isDefault: value === defaults.groupBy,
      })),
      onSelect: (value) => {
        const viewState = this.state_abyssPrivate.get('centerListViewState');
        this.updateViewState_abyssPrivate({
          ...viewState,
          groupBy: value as ListViewState['groupBy'],
        });
      },
    };
  }

  private sortByRowSpec_abyssPrivate(defaults: ListViewState): ViewOptionsSingleRow {
    const fields: Array<ListViewState['sortBy']['field']> = [
      'date',
      'priority',
      'title',
      'tag',
      'status',
      'tracked',
    ];
    return {
      kind: 'single',
      icon: 'arrow-up-down',
      label: 'Sort by',
      displayValue: () => {
        const { sortBy } = this.state_abyssPrivate.get('centerListViewState');
        return `${this.capitalize_abyssPrivate(sortBy.field)} ${sortBy.dir === 'asc' ? '↑' : '↓'}`;
      },
      activeValue: () => this.state_abyssPrivate.get('centerListViewState').sortBy.field,
      options: fields.map((field) => ({
        label: () => {
          const { sortBy } = this.state_abyssPrivate.get('centerListViewState');
          const arrow = sortBy.dir === 'asc' ? '↑' : '↓';
          return `${this.capitalize_abyssPrivate(field)} ${sortBy.field === field ? arrow : ''}`.trim();
        },
        value: field,
        isDefault: field === defaults.sortBy.field,
      })),
      onSelect: (value) => {
        const viewState = this.state_abyssPrivate.get('centerListViewState');
        const field = value as ListViewState['sortBy']['field'];
        // Tracked time is asked for to find where the time went, so it opens on the busiest task;
        // every other field opens ascending. Choosing the field again flips it either way.
        const opening = field === 'tracked' ? 'desc' : 'asc';
        const flipped = viewState.sortBy.dir === 'asc' ? 'desc' : 'asc';
        const dir = viewState.sortBy.field === field ? flipped : opening;
        this.updateViewState_abyssPrivate({ ...viewState, sortBy: { field, dir } });
      },
    };
  }

  private capitalize_abyssPrivate(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  private statusGroupsRowSpec_abyssPrivate(): ViewOptionsMultiRow {
    const apply = (groups: TaskStatusType[] | undefined): void => {
      this.applyStatusGroupsChange_abyssPrivate(groups);
    };
    return {
      kind: 'multi',
      icon: 'eye',
      label: 'Show',
      displayValue: () =>
        this.statusGroupsLabel_abyssPrivate(
          this.state_abyssPrivate.get('centerListViewState').statusGroups,
        ),
      selected: () =>
        this.state_abyssPrivate.get('centerListViewState').statusGroups ?? ALL_STATUS_GROUPS,
      options: ALL_STATUS_GROUPS.map((value) => ({ label: TYPE_LABELS[value], value })),
      onToggle: (rawValue) => {
        const value = rawValue as TaskStatusType;
        const viewState = this.state_abyssPrivate.get('centerListViewState');
        const current = viewState.statusGroups ?? ALL_STATUS_GROUPS;
        const next = current.includes(value)
          ? current.filter((group) => group !== value)
          : [...current, value];
        apply(next.length === 0 || next.length >= 4 ? undefined : next);
      },
      presets: [
        {
          label: 'Active',
          onSelect: () => {
            apply(ACTIVE_STATUS_GROUPS);
          },
          active: () =>
            statusGroupsEqual(
              this.state_abyssPrivate.get('centerListViewState').statusGroups,
              ACTIVE_STATUS_GROUPS,
            ),
        },
        {
          label: 'All',
          onSelect: () => {
            apply(undefined);
          },
          active: () =>
            normalizeStatusGroups(
              this.state_abyssPrivate.get('centerListViewState').statusGroups,
            ) === undefined,
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

  private applyStatusGroupsChange_abyssPrivate(groups: TaskStatusType[] | undefined): void {
    const viewState = this.state_abyssPrivate.get('centerListViewState');
    const withoutStatusGroups = { ...viewState };
    delete withoutStatusGroups.statusGroups;
    this.updateViewState_abyssPrivate(
      groups === undefined ? withoutStatusGroups : { ...viewState, statusGroups: groups },
    );
  }

  private getFilteredTasks_abyssPrivate(): TaskSnapshot[] {
    const selection = this.state_abyssPrivate.get('selectedList');
    let query: { filePath: string } | { tag: string } | undefined;
    if (typeof selection === 'object') {
      if (selection.type === 'project') query = { filePath: selection.path };
    }
    return [
      ...selectTaskList({
        tasks: this.queries_abyssPrivate.list(query),
        selection,
        viewState: this.state_abyssPrivate.get('centerListViewState'),
        settings: this.settings_abyssPrivate,
        today: window.moment().format('YYYY-MM-DD') as LocalDate,
        // The clock this render pass already read, so sorting by tracked time and the badges it
        // orders agree on one instant instead of each asking the ticker again.
        nowMs: this.cardRenderNowMs_abyssPrivate,
        textQuery: this.state_abyssPrivate.get('centerFilter'),
      }),
    ];
  }

  private getTitle_abyssPrivate(): string {
    const selection = this.state_abyssPrivate.get('selectedList');
    const groups =
      typeof selection === 'object' && selection.type === 'group'
        ? this.effectiveTagGroups_abyssPrivate()
        : [];
    return listSelectionTitle(selection, groups);
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

  private getTagColor_abyssPrivate(
    tag: string,
    tagGroups: readonly EffectiveTagGroup[] = this.effectiveTagGroups_abyssPrivate(),
  ): string | undefined {
    for (const group of tagGroups) {
      if (tagMatchesGroup(tag, group)) return group.color;
    }
    return undefined;
  }

  private effectiveTagGroups_abyssPrivate(): readonly EffectiveTagGroup[] {
    return this.taskTagCatalog_abyssPrivate().groups;
  }

  private taskTagCatalog_abyssPrivate(): {
    readonly nodes: readonly TaskNodeSnapshot[];
    readonly groups: readonly EffectiveTagGroup[];
  } {
    const nodes = this.tasks_abyssPrivate?.queries.listNodes() ?? [];
    return {
      nodes,
      groups: resolveEffectiveTagGroups(this.settings_abyssPrivate, collectTaskNodeTags(nodes)),
    };
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
      onPick: (inputValue, pick) => {
        // A pick made by leaving the picker arms no focus continuity: focus stays where it went.
        this.pickTaskDate_abyssPrivate(tasks, inputValue, pick.returnFocus ? focusKey : undefined);
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

  private pickTaskDate_abyssPrivate(
    tasks: readonly TaskSnapshot[],
    inputValue: string,
    focusKey: string | undefined,
  ): void {
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
          ? this.taskCommands_abyssPrivate.setTaskDue(firstTask, value)
          : this.taskCommands_abyssPrivate.applyDueInOrder(tasks, value);
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

  /** Returns focus to a card after its date picker in every mode, as the picker has no fallback. */
  private focusTaskDateTrigger_abyssPrivate(key: string): boolean {
    const card = this.mountedRows_abyssPrivate.element(key);
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

  /**
   * The order selection and the keyboard work in: the mounted rows in Lists and Tags, none in
   * Search, a dashboard, or Calendar.
   */
  private listOrder_abyssPrivate(): TaskListRows {
    return this.state_abyssPrivate.get('mode') === 'tasks'
      ? this.mountedRows_abyssPrivate.rows
      : NO_TASK_LIST_ROWS;
  }

  /** Focuses and scrolls to a listed card; a click in Search or a dashboard moves nothing. */
  private focusTaskKey_abyssPrivate(key: string): void {
    if (this.listOrder_abyssPrivate().indexOf(key) === -1) return;
    const card = this.mountedRows_abyssPrivate.element(key);
    if (card?.isConnected !== true) return;
    card.focus({ preventScroll: true });
    this.scrollTaskCardIntoView_abyssPrivate(card);
  }

  private scrollTaskCardIntoView_abyssPrivate(card: HTMLElement): void {
    const scrollHost = card as Partial<Pick<HTMLElement, 'scrollIntoView'>>;
    scrollHost.scrollIntoView?.({ block: 'nearest' });
  }

  private updateSelectionVisuals_abyssPrivate(): void {
    for (const [key, card] of this.mountedRows_abyssPrivate.cards()) {
      this.patchCardSelection_abyssPrivate(card, key, this.rowSelection_abyssPrivate.has(key));
    }
    this.updateTaskStackSelection_abyssPrivate();

    const live =
      this.el.querySelector<HTMLElement>('.abyss-selection-live') ??
      this.el.createDiv({
        cls: 'abyss-selection-live abyss-sr-only',
        attr: { 'aria-live': 'polite', 'aria-atomic': 'true' },
      });
    const count = this.rowSelection_abyssPrivate.size;
    if (count !== this.lastAnnouncedSelectionCount_abyssPrivate) {
      this.lastAnnouncedSelectionCount_abyssPrivate = count;
      live.textContent = `${count} ${count === 1 ? 'task' : 'tasks'} selected`;
    }
  }

  /**
   * One card's multi-selection look and its "Selected" description, patched in place; a windowed
   * renderer can run it on each card it mounts.
   */
  private patchCardSelection_abyssPrivate(
    card: HTMLElement,
    key: string,
    isSelected: boolean,
  ): void {
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
        .filter((id): boolean => Boolean(id) && id !== selectedStateId && id !== selectedState?.id);
      if (describedBy.length > 0) {
        card.setAttribute('aria-describedby', describedBy.join(' '));
      } else {
        card.removeAttribute('aria-describedby');
      }
    }
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
        runAsyncAction(this.taskCommands_abyssPrivate.setTaskStatus(task, symbol));
      },
      onPickPriority: (priority) => {
        runAsyncAction(this.taskCommands_abyssPrivate.setPriority(task, priority));
      },
      interactionOwnership: this.interactionOwnership_abyssPrivate,
    });
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
