import { Component, Notice, type App, type Menu } from 'obsidian';
import type { AppState } from '../app/AppState';
import { isListViewOptionsCustomized, listSelectionToKey } from '../app/listViewState';
import { createBrowserTaskScheduler } from '../browserTaskScheduler';
import { moment } from '../obsidianMoment';
import type { ProjectManager } from '../projects/ProjectManager';
import type { ProjectStore } from '../projects/ProjectStore';
import type { CalendarSettings } from '../settings/types';
import type { StatusRegistry } from '../status/StatusRegistry';
import {
  isTagNavigationArchived,
  resolveEffectiveTagGroups,
  tagMatchesGroup,
  tagNavigationGroupTags,
  type EffectiveTagGroup,
} from '../tags/effectiveTagGroups';
import { selectTaskList } from '../task-lists/TaskListSelector';
import { outgoingTaskLinkValues, type TaskLinkValues } from '../task-lists/taskLinkValues';
import type {
  TaskSearchOccurrence,
  TaskSearchOrganization,
} from '../task-lists/taskSearchOrganization';
import {
  localDate,
  taskReconciliationKey,
  TaskSearchError,
  type CommentTimeContextProvider,
  type LocalDate,
  type TaskApplicationApi,
  type TaskCaptureApplicationApi,
  type TaskCommandResult,
  type TaskQueryApi,
  type TaskRef,
  type TaskSearchAddress,
  type TaskSearchApi,
  type TaskSnapshot,
} from '../tasks';
import { showDatePickerPopover } from '../ui/DatePickerPopover';
import { TaskModal } from '../ui/TaskModal';
import type {
  CreationRevealAuthority,
  CreationRevealRequest,
} from '../ui/creation/CreationPresentationController';
import { isRealmHTMLElement } from '../ui/domRealm';
import { isImeOwnedEvent } from '../ui/ime';
import { noInteractionOwnership, type InteractionOwnershipPort } from '../ui/interactionOwnership';
import type { LocalSearchFocusTarget } from '../ui/localSearchKeys';
import { showMenuAtMouseEventWithFocus } from '../ui/nativeMenuFocus';
import { mountAnchoredRecurrenceEditor } from '../ui/recurrence/RecurrenceEditor';
import { runAsyncAction } from '../ui/runAsyncAction';
import { showStatusMenuAt } from '../ui/statusMenu';
import { type CreationResultDescription } from '../ui/taskCommandResult';
import type { TaskDependencyLookup } from '../ui/taskDependencyPresentation';
import { bindTaskHierarchyDrop, executeTaskHierarchy } from '../ui/taskHierarchyActions';
import { startTaskNodeDrag } from '../ui/taskNodeDrag';
import { renderedTaskElements, renderedTaskNodeElements } from '../ui/taskPresentationIdentity';
import type { TaskRenderOutcome, TaskRenderScope } from '../ui/taskRenderScope';
import { rootTaskRef, taskNodeRef, type TaskSelectionNode } from '../ui/taskSelection';
import type { TrackingSurface } from '../ui/timeTracking/TimeBadge';
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
import { ListViewControls, type ListViewControlsStatePort } from './center/ListViewControls';
import type { SearchViewState } from './center/SearchViewState';
import {
  TaskCardRenderer,
  type TaskCardInteractionContext,
  type TaskCardMount,
} from './center/TaskCardRenderer';
import { TaskCommands } from './center/TaskCommands';
import { TaskMenus, type TaskMenuTargets } from './center/TaskMenus';
import { TaskSearch, type TaskSearchOptions, type TaskSearchRowOptions } from './center/TaskSearch';
import { TaskSearchReveal } from './center/TaskSearchReveal';
import { taskSearchDestination } from './center/taskSearchDestination';
import { mountTaskSearchKeyboardActivation } from './center/taskSearchKeyboardActivation';
import { ProjectsPanel } from './projects/ProjectsPanel';
import { TaskListSurface, type TaskRowMount } from './task-list/TaskListSurface';
import { TaskSearchRows, type TaskSearchRowsIdentity } from './task-list/TaskSearchRows';
import {
  mountTaskListRow,
  NO_MOUNTED_TASK_LIST_ROWS,
  type MountedTaskListRows,
} from './task-list/taskListRowView';
import {
  buildTaskListRows,
  indexedRows,
  NO_TASK_LIST_ROWS,
  taskListGrouping,
  taskRowKey,
  taskStackRowKey,
  type TaskListRow,
  type TaskListRows,
} from './task-list/taskListRows';
import { TaskRowSelection } from './task-list/taskRowSelection';

type SurfaceTask = TaskSnapshot | TaskSearchOccurrence;
interface TaskRowOptions {
  readonly signal?: AbortSignal;
  readonly isCurrent?: () => boolean;
  readonly reportFailure?: (error: unknown) => void;
  scope?: TaskRenderScope;
  readonly onCard?: (card: HTMLElement, task: TaskSnapshot) => void | (() => void);
  readonly failure?: 'report' | 'throw';
}

interface TaskSurfaceState {
  readonly host: HTMLElement;
  readonly surface: TaskListSurface<SurfaceTask>;
  tagGroups: readonly EffectiveTagGroup[];
  options: TaskRowOptions;
  search?: {
    readonly rows: TaskSearchRows;
    readonly identity: TaskSearchRowsIdentity;
    readonly order: TaskListRows<TaskSearchOccurrence>;
  };
}
interface CreationRowAttempt {
  readonly retained: TaskSurfaceState;
  readonly ref: TaskRef;
  readonly key: string;
  readonly request: CreationRevealRequest;
  isCurrent(): boolean;
}

interface CenterPanelOptions {
  readonly state: AppState;
  readonly app: App;
  readonly settings: CalendarSettings;
  readonly queries: TaskQueryApi;
  readonly search?: TaskSearchApi;
  readonly organizationScheduler?: TaskSearchOptions['organizationScheduler'];
  readonly statusRegistry: StatusRegistry;
  readonly onSaveSettings?: (() => Promise<void>) | undefined;
  readonly projectStore?: ProjectStore | null | undefined;
  readonly projectManager?: ProjectManager | null | undefined;
  readonly tasks?: TaskApplicationApi | undefined;
  readonly commentTimeContext?: CommentTimeContextProvider | undefined;
  readonly captureApplication?: (TaskApplicationApi & TaskCaptureApplicationApi) | undefined;
  readonly onCreationResult?:
    | ((
        result: TaskCommandResult,
        description: CreationResultDescription,
        revealAuthority?: CreationRevealAuthority,
      ) => void)
    | undefined;
  readonly onTaskRowsSettled?: ((root: HTMLElement) => void) | undefined;
  readonly onRenderComplete?: ((root: HTMLElement) => void) | undefined;
  readonly interactionOwnership?: InteractionOwnershipPort | undefined;
  readonly navigation?: PanelNavigationActions | undefined;
  readonly onSaveViewState?: (() => Promise<void>) | undefined;
  readonly timeTracking?: TrackingSurface | undefined;
  readonly onRenderTaskHeaderActions?:
    ((header: HTMLElement, title: HTMLElement, controls: HTMLElement) => void) | undefined;
}

export class CenterPanel {
  private el!: HTMLElement;
  private readonly offs_abyssPrivate: Array<() => void> = [];
  private taskDatePickerCleanup_abyssPrivate: ((restoreFocus?: boolean) => void) | null = null;
  private taskCardRenderGeneration_abyssPrivate = 0;
  private captureContextRevision_abyssPrivate = 0;
  private readonly creationAttempts_abyssPrivate = new Set<() => void>();
  private taskRowsSettledQueued_abyssPrivate = false;
  private onTaskRowsSettled_abyssPrivate: ((root: HTMLElement) => void) | undefined;
  private taskDateFocusContinuityKey_abyssPrivate: string | null = null;
  private taskDateFocusRefs_abyssPrivate: TaskRef[] = [];
  private pendingTaskDateFocus_abyssPrivate: {
    key: string;
    armedRenderGeneration: number;
    changed: boolean;
  } | null = null;
  private cardReturn_abyssPrivate: {
    readonly original: TaskSnapshot;
    readonly key: string;
    ref: TaskRef;
    readonly opener: HTMLElement;
    readonly list: string;
    readonly kind: 'menu' | 'recurrence';
    surface: HTMLElement | undefined;
    pending: boolean;
    resolving: boolean;
    hidden: boolean;
    releasePin?: (() => void) | undefined;
  } | null = null;
  private showingTaskMenu_abyssPrivate = false;
  private taskMenuCleanup_abyssPrivate: (() => void) | null = null;
  private wholeCardFocus_abyssPrivate: HTMLElement | null = null;
  private renderingRecurrenceCleanup_abyssPrivate = false;
  private renderCardFocus_abyssPrivate: {
    readonly key: string;
    readonly ref: TaskRef;
    readonly list: string;
    readonly opener: HTMLElement;
  } | null = null;
  private recurrenceEditorCleanup_abyssPrivate: (() => void) | null = null;
  private readonly listViewControls_abyssPrivate: ListViewControls;
  private taskModal_abyssPrivate: TaskModal | null = null;
  /** The list's multi-selection, anchor, and keyboard focus, kept across renders and modes. */
  private readonly rowSelection_abyssPrivate = new TaskRowSelection();
  private readonly taskCommands_abyssPrivate: TaskCommands;
  private readonly taskMenus_abyssPrivate: TaskMenus;
  private lastAnnouncedSelectionCount_abyssPrivate = 0;
  /** Full logical rows and the bounded mounted-card lookup for the active list host. */
  private mountedRows_abyssPrivate: MountedTaskListRows<SurfaceTask> = NO_MOUNTED_TASK_LIST_ROWS;
  private readonly taskInteractionPins_abyssPrivate = new Set<{
    readonly key: string;
    readonly ref: TaskRef;
    readonly cancel: () => void;
  }>();
  private readonly mountedSnapshots_abyssPrivate = new Map<string, TaskSnapshot>();
  private keyboardTarget_abyssPrivate: AbortController | undefined;
  private taskSurface_abyssPrivate: TaskSurfaceState | null = null;
  private outgoingLinks_abyssPrivate: TaskLinkValues = new Map();
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
  private readonly taskSearch_abyssPrivate: TaskSearch;
  private readonly taskSearchReveal_abyssPrivate: TaskSearchReveal;
  private readonly searchApi_abyssPrivate: TaskSearchApi | undefined;
  private readonly searchControls_abyssPrivate: ListViewControls;
  private searchHeader_abyssPrivate: {
    host: HTMLElement;
    button: HTMLButtonElement;
    chips: HTMLElement[];
  } | null = null;
  private searchView_abyssPrivate: SearchViewState = {
    list: { groupBy: 'none', sortBy: { field: 'date', dir: 'asc' }, filters: [] },
    relevance: true,
  };

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
  private mounted_abyssPrivate = false;
  private readonly commentTimeContext_abyssPrivate: CommentTimeContextProvider | undefined;
  private readonly onCreationResult_abyssPrivate: (
    result: TaskCommandResult,
    description: CreationResultDescription,
    revealAuthority?: CreationRevealAuthority,
  ) => void;
  private onRenderComplete_abyssPrivate: (root: HTMLElement) => void = () => {};
  private readonly interactionOwnership_abyssPrivate: InteractionOwnershipPort;
  private readonly timeTracking_abyssPrivate: TrackingSurface | undefined;
  private readonly onRenderTaskHeaderActions_abyssPrivate:
    ((header: HTMLElement, title: HTMLElement, controls: HTMLElement) => void) | undefined;
  /** Owns card DOM and the running badges the shared ticker repaints. */
  private readonly taskCardRenderer_abyssPrivate: TaskCardRenderer;
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
    this.searchApi_abyssPrivate = options.search;
    this.taskSearchReveal_abyssPrivate = this.createTaskSearchReveal_abyssPrivate();
    this.statusRegistry_abyssPrivate = statusRegistry;
    this.onSaveViewState_abyssPrivate = onSaveViewState;
    this.onSaveSettings_abyssPrivate = onSaveSettings;
    this.projectStore_abyssPrivate = projectStore;
    this.projectManager_abyssPrivate = projectManager;
    this.tasks_abyssPrivate = tasks;
    this.commentTimeContext_abyssPrivate = commentTimeContext;
    this.onCreationResult_abyssPrivate = onCreationResult;
    this.configureRenderCallbacks_abyssPrivate(options, onRenderComplete);
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
      rows: () => this.mountedRows_abyssPrivate.rows,
      onSelectionChanged: () => {
        this.updateSelectionVisuals_abyssPrivate();
      },
    });
    this.taskMenus_abyssPrivate = this.createTaskMenus_abyssPrivate();
    this.captureSessions_abyssPrivate = this.createCaptureSessions_abyssPrivate();
    this.listViewControls_abyssPrivate = this.createListViewControls_abyssPrivate();
    this.searchControls_abyssPrivate = this.createSearchControls_abyssPrivate();
    this.taskCardRenderer_abyssPrivate = this.createTaskCardRenderer_abyssPrivate();
    this.taskSearch_abyssPrivate = this.createTaskSearch_abyssPrivate(
      options.organizationScheduler,
    );
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

  private createTaskCardRenderer_abyssPrivate(): TaskCardRenderer {
    return new TaskCardRenderer({
      app: this.app_abyssPrivate,
      state: this.state_abyssPrivate,
      settings: this.settings_abyssPrivate,
      statusRegistry: this.statusRegistry_abyssPrivate,
      commands: this.taskCommands_abyssPrivate,
      listControls: {
        addPropertyFilter: (filter) => {
          (this.state_abyssPrivate.get('mode') === 'search'
            ? this.searchControls_abyssPrivate
            : this.listViewControls_abyssPrivate
          ).addPropertyFilter(filter);
        },
      },
      trackingEnabled: this.timeTracking_abyssPrivate !== undefined,
      host: {
        component: () => this.md_abyssPrivate,
        dependenciesFor: (task) => this.dependenciesFor_abyssPrivate(task),
        dependenciesForNode: (target) => this.tasks_abyssPrivate?.queries.dependencySummary(target),
        mountInteractions: (card, task, rowKey, context) => {
          this.mountTaskCardInteractions_abyssPrivate(card, task, rowKey, context);
        },
        reportFailure: (error) => {
          this.reportTaskRenderFailure_abyssPrivate(error);
        },
        openStatusMenu: (event, task) => {
          this.openStatusMenu_abyssPrivate(event, task);
        },
        formatDate: (date) => this.formatDate_abyssPrivate(date),
        getDateClass: (date) => this.getDateClass_abyssPrivate(date),
        getTagColor: (tag, groups) => this.getTagColor_abyssPrivate(tag, groups),
      },
    });
  }

  private createTaskSearch_abyssPrivate(
    organizationScheduler: TaskSearchOptions['organizationScheduler'],
  ): TaskSearch {
    let query: string | undefined;
    return new TaskSearch({
      organizationScheduler,
      state: this.state_abyssPrivate,
      search: this.searchApi_abyssPrivate,
      reads: this.tasks_abyssPrivate?.queries,
      settings: this.settings_abyssPrivate,
      view: () =>
        this.state_abyssPrivate.get('mode') === 'search'
          ? this.searchView_abyssPrivate
          : { list: this.state_abyssPrivate.get('centerListViewState'), relevance: false },
      resolveLink: (target, sourcePath) =>
        this.app_abyssPrivate.metadataCache.getFirstLinkpathDest(target, sourcePath)?.path,
      navigation: this.navigation_abyssPrivate,
      host: {
        clearSelection: () => {
          this.clearResultsSelection_abyssPrivate();
        },
        renderControls: (host) => {
          const button = this.searchControls_abyssPrivate.renderViewStateButton(host);
          this.searchHeader_abyssPrivate = { host, button, chips: [] };
          this.syncSearchHeader_abyssPrivate();
        },
        destination: (root) =>
          taskSearchDestination({
            root,
            today: localDate(moment().format('YYYY-MM-DD')),
            settings: this.settings_abyssPrivate,
            projectPaths: new Set(
              this.projectStore_abyssPrivate?.list().map((project) => project.path) ?? [],
            ),
            configuredTags: this.searchDestinationTags_abyssPrivate(),
          }),
        installReveal: (receipt) => {
          this.taskSearchReveal_abyssPrivate.install(receipt);
        },
        currentReveal: () => this.taskSearchReveal_abyssPrivate.current(),
        expireReveal: () => {
          this.taskSearchReveal_abyssPrivate.clear();
          this.render_abyssPrivate();
        },
        revealTask: (key, identity) => this.revealSearchTask_abyssPrivate(key, identity),
        beginResults: () => {
          const nextQuery = this.state_abyssPrivate.get(
            this.state_abyssPrivate.get('mode') === 'search' ? 'searchQuery' : 'centerFilter',
          );
          if (query !== nextQuery) {
            this.destroyTaskSurface_abyssPrivate();
            this.taskSearchScrollReset_abyssPrivate = true;
          }
          query = nextQuery;
          this.beginTaskCardRender_abyssPrivate();
        },
        discardResults: () => {
          this.destroyTaskSurface_abyssPrivate();
        },
        renderRows: (host, organization, options) =>
          this.mountSearchRows_abyssPrivate(host, organization, options),
        completeResults: () => {
          this.completeTaskCardRender_abyssPrivate();
        },
      },
    });
  }

  private createTaskSearchReveal_abyssPrivate(): TaskSearchReveal {
    return new TaskSearchReveal(
      () => this.el.ownerDocument.defaultView ?? null,
      () => this.state_abyssPrivate.taskSelectionIntentGeneration,
      (card) => {
        if (this.taskSurface_abyssPrivate?.search === undefined)
          this.scrollTaskCardIntoView_abyssPrivate(card);
      },
    );
  }

  private async revealSearchTask_abyssPrivate(
    key: string,
    identity: TaskSearchRowsIdentity,
  ): Promise<void> {
    const retained = this.taskSurface_abyssPrivate;
    const compact = retained?.search;
    if (retained === null || compact?.identity !== identity) return;
    if (this.taskSearchReveal_abyssPrivate.consumedScroll) {
      this.refreshSearchPulse_abyssPrivate();
      return;
    }
    const intent = this.state_abyssPrivate.taskSelectionIntentGeneration;
    const owner = retained.host.ownerDocument.defaultView;
    const controller = new AbortController();
    const abort = (): void => {
      controller.abort();
    };
    const current = (): boolean =>
      !controller.signal.aborted &&
      !identity.signal.aborted &&
      retained === this.taskSurface_abyssPrivate &&
      retained.search === compact &&
      intent === this.state_abyssPrivate.taskSelectionIntentGeneration &&
      retained.host.ownerDocument.defaultView === owner &&
      this.creationHostVisible_abyssPrivate(retained.host);
    const off = this.state_abyssPrivate.onCommit(() => {
      if (!current()) abort();
    });
    identity.signal.addEventListener('abort', abort, { once: true });
    const release = retained.surface.pin(key, abort);
    try {
      const ready = await this.readyCompactCard_abyssPrivate(
        retained,
        key,
        controller.signal,
        current,
      );
      if (ready === undefined) return;
      if (current()) this.taskSearchReveal_abyssPrivate.show(ready.card);
    } catch (error) {
      if (current()) this.reportTaskRenderFailure_abyssPrivate(error);
    } finally {
      off();
      release();
      identity.signal.removeEventListener('abort', abort);
      controller.abort();
    }
  }

  private async readyCompactCard_abyssPrivate(
    retained: TaskSurfaceState,
    key: string,
    signal: AbortSignal,
    current: () => boolean,
  ): Promise<{ task: TaskSnapshot; card: HTMLElement } | undefined> {
    const compact = retained.search;
    if (compact === undefined) return undefined;
    const task = await this.snapshotForKey_abyssPrivate(key, signal);
    if (!current() || task === undefined) return undefined;
    const outcome = await compact.rows.settleRow(key, signal);
    if (!current() || outcome.type !== 'ready') return undefined;
    const mounted = this.mountedSnapshot_abyssPrivate(key);
    if (mounted === undefined || !this.sameCardRef_abyssPrivate(task.ref, mounted.ref))
      return undefined;
    const card = retained.surface.reveal(key);
    return current() && card !== undefined ? { task, card } : undefined;
  }

  private searchDestinationTags_abyssPrivate(): string[] {
    const settings = this.settings_abyssPrivate;
    const observed = this.queries_abyssPrivate.observedTags();
    return [
      ...settings.pinnedTags,
      ...settings.tagGroups
        .filter((group) => group.archived !== true)
        .flatMap((group) =>
          tagNavigationGroupTags(
            { ...group, origin: 'configured', archived: false },
            observed,
            settings.tagGroups,
          ),
        ),
    ].filter((tag) => !isTagNavigationArchived(settings, tag));
  }

  private createSearchControls_abyssPrivate(): ListViewControls {
    return new ListViewControls({
      state: this.state_abyssPrivate,
      settings: this.settings_abyssPrivate,
      statusRegistry: this.statusRegistry_abyssPrivate,
      interactionOwnership: this.interactionOwnership_abyssPrivate,
      saveViewState: this.onSaveViewState_abyssPrivate,
      host: { root: () => this.el, formatDate: (value) => this.formatDate_abyssPrivate(value) },
      statePort: this.createSearchStatePort_abyssPrivate(),
    });
  }

  private createSearchStatePort_abyssPrivate(): ListViewControlsStatePort {
    return {
      read: () => this.searchView_abyssPrivate.list,
      write: (list) => {
        this.searchView_abyssPrivate = { ...this.searchView_abyssPrivate, list };
        this.syncSearchHeader_abyssPrivate();
        this.taskSearch_abyssPrivate.refresh();
      },
      relevance: () => this.searchView_abyssPrivate.relevance,
      setRelevance: (relevance) => {
        this.searchView_abyssPrivate = { ...this.searchView_abyssPrivate, relevance };
        this.syncSearchHeader_abyssPrivate();
        this.taskSearch_abyssPrivate.refresh();
      },
      canUseRelevance: () => true,
    };
  }

  private syncSearchHeader_abyssPrivate(): void {
    const header = this.searchHeader_abyssPrivate;
    if (header === null) return;
    for (const chip of header.chips) chip.remove();
    header.chips = this.searchControls_abyssPrivate.renderPropertyChips(header.host, header.button);
    header.button.toggleClass(
      'abyss-view-state-btn--active',
      this.searchView_abyssPrivate.list.filters.length > 0 ||
        this.searchView_abyssPrivate.list.groupBy !== 'none' ||
        !this.searchView_abyssPrivate.relevance,
    );
  }

  private clearResultsSelection_abyssPrivate(): void {
    const selected = this.rowSelection_abyssPrivate.size > 0;
    this.rowSelection_abyssPrivate.clear();
    this.updateSelectionVisuals_abyssPrivate();
    if (selected)
      this.el
        .querySelector('.abyss-selection-live')
        ?.setText('Selection cleared for the new query');
  }

  private async mountSearchRows_abyssPrivate(
    host: HTMLElement,
    organization: TaskSearchOrganization,
    options: TaskSearchRowOptions,
  ): Promise<TaskRenderOutcome> {
    if (
      this.taskSurface_abyssPrivate?.host !== host ||
      this.taskSurface_abyssPrivate.search === undefined
    ) {
      if (!this.createSearchSurface_abyssPrivate(host, options.identity))
        return { type: 'cancelled' };
    }
    if (this.taskSearchScrollReset_abyssPrivate) {
      host.scrollTop = 0;
      this.taskSearchScrollReset_abyssPrivate = false;
    }
    const retained = this.taskSurface_abyssPrivate;
    const compact = retained?.search;
    if (retained === null || compact === undefined) return { type: 'cancelled' };
    const previous = compact.order;
    this.reconcileCompactSelection_abyssPrivate(previous, organization);
    retained.tagGroups = this.effectiveTagGroups_abyssPrivate();
    retained.options = {
      signal: options.identity.signal,
      isCurrent: options.isCurrent,
      reportFailure: options.reportFailure,
    };
    this.compactPresentation_abyssPrivate = options;
    const order = compact.rows.set(organization, options.groupBy, options.identity);
    retained.search = { rows: compact.rows, identity: options.identity, order };
    this.invalidateCompactInteractions_abyssPrivate(previous, order);
    this.mountedRows_abyssPrivate = retained.surface;
    retained.surface.update(
      order,
      {
        revision: JSON.stringify([
          this.settings_abyssPrivate.sourceNoteDisplay,
          this.settings_abyssPrivate.taskFilePath,
          retained.tagGroups,
        ]),
        preserveAnchor: options.preserveAnchor,
        estimate: (row) => (row.kind === 'group' ? 32 : 64),
        measurementRevision: (row) =>
          row.kind === 'group'
            ? `${row.label}:${row.count}`
            : JSON.stringify(
                this.rowMeasurementIdentity_abyssPrivate(
                  row.task,
                  options.identity.semanticsRevision,
                ),
              ),
      },
      'throw',
    );
    this.rowSelection_abyssPrivate.reconcile(this.listOrder_abyssPrivate());
    this.updateSelectionVisuals_abyssPrivate();
    return compact.rows.settleMounted(options.identity.signal);
  }

  private reconcileCompactSelection_abyssPrivate(
    previous: TaskListRows<TaskSearchOccurrence>,
    organization: TaskSearchOrganization,
  ): void {
    // A reused path/line cannot inherit selection from a different accepted source address.
    const incoming = new Map(organization.occurrences.map((o) => [o.key, o]));
    for (const key of this.rowSelection_abyssPrivate.inOrder(previous)) {
      const before = previous.task(key)?.address;
      const after = incoming.get(key)?.address;
      if (
        before !== undefined &&
        (after?.rootId !== before.rootId ||
          before.epoch !== after.epoch ||
          before.version !== after.version)
      )
        this.rowSelection_abyssPrivate.delete(key);
    }
  }

  private createSearchSurface_abyssPrivate(
    host: HTMLElement,
    identity: TaskSearchRowsIdentity,
  ): boolean {
    this.destroyTaskSurface_abyssPrivate();
    const search = this.searchApi_abyssPrivate;
    const owner = host.ownerDocument.defaultView;
    if (search === undefined || owner === null) return false;
    const rows = new TaskSearchRows({
      search,
      scheduler: createBrowserTaskScheduler(owner),
      prepareDependencies: (g, signal) =>
        this.tasks_abyssPrivate?.queries.prepareDependencies(g, signal) ??
        Promise.reject(new Error('Task dependency capability missing')),
      isCurrent: (identity) =>
        this.taskSurface_abyssPrivate?.search?.identity === identity &&
        this.taskSurface_abyssPrivate.options.isCurrent?.() !== false,
      mountCard: (element, task, occurrence) =>
        this.mountCompactCard_abyssPrivate(element, task, occurrence),
      updateCard: (card, task, occurrence) => {
        this.mountedSnapshots_abyssPrivate.set(occurrence.key, task);
        card.update(
          task,
          this.taskSurface_abyssPrivate?.tagGroups ?? [],
          this.compactCardOptions_abyssPrivate(task, occurrence),
        );
        this.observeTaskCardReceipt_abyssPrivate(card);
      },
      refreshMeasurements: () => this.taskSurface_abyssPrivate?.surface.refreshMeasurements(),
      reportFailure: (error) => {
        this.reportTaskRenderFailure_abyssPrivate(error);
      },
    });
    const surface = new TaskListSurface<SurfaceTask>({
      host,
      scroll: host,
      mount: (container, row) => {
        if (row.kind === 'task' && 'ref' in row.task) throw new Error('Expected compact row');
        const mount = rows.mount(
          container,
          row.kind === 'group' ? row : { ...row, task: row.task as TaskSearchOccurrence },
        );
        return {
          ...mount,
          destroy: () => {
            this.mountedSnapshots_abyssPrivate.delete(row.key);
            mount.destroy();
          },
        };
      },
      mountedChanged: () => {
        rows.mountedChanged(surface.mountedKeys());
        this.patchMountedSelection_abyssPrivate();
        this.scheduleTaskRowsSettled_abyssPrivate();
      },
      reportFailure: (error) => {
        this.reportTaskRenderFailure_abyssPrivate(error);
      },
    });
    this.taskSurface_abyssPrivate = {
      host,
      surface,
      tagGroups: [],
      options: {},
      search: { rows, identity, order: indexedRows<TaskSearchOccurrence>([]) },
    };
    return true;
  }

  private taskSearchScrollReset_abyssPrivate = false;
  private compactPresentation_abyssPrivate: TaskSearchRowOptions | undefined;
  private taskRowRevision_abyssPrivate(task: SurfaceTask): string {
    return 'ref' in task ? task.ref.revision : String(task.address.version);
  }
  private rowMeasurementIdentity_abyssPrivate(
    task: SurfaceTask,
    semanticsRevision?: number,
  ): unknown {
    return 'ref' in task ? task.ref : [task.address, semanticsRevision];
  }
  private compactCardOptions_abyssPrivate(
    task: TaskSnapshot,
    occurrence: TaskSearchOccurrence,
  ): Parameters<TaskCardMount['update']>[2] {
    const options = this.compactPresentation_abyssPrivate;
    return {
      ...this.taskCardOptions_abyssPrivate(task, occurrence.key),
      search: options?.presentation?.(task, occurrence.address),
      highlight: options?.highlight,
      onActivate:
        options?.onActivate === undefined
          ? undefined
          : () => options.onActivate?.(occurrence.address),
    };
  }
  private mountCompactCard_abyssPrivate(
    element: HTMLElement,
    task: TaskSnapshot,
    occurrence: TaskSearchOccurrence,
  ): TaskCardMount {
    const card = this.taskCardRenderer_abyssPrivate.mountInto(
      element,
      task,
      this.taskSurface_abyssPrivate?.tagGroups ?? [],
      this.compactCardOptions_abyssPrivate(task, occurrence),
    );
    this.mountedSnapshots_abyssPrivate.set(occurrence.key, task);
    this.observeTaskCardReceipt_abyssPrivate(card);
    return card;
  }
  private mountedSnapshot_abyssPrivate(key: string): TaskSnapshot | undefined {
    if (this.taskSurface_abyssPrivate?.search !== undefined)
      return this.mountedSnapshots_abyssPrivate.get(key);
    const task = this.mountedRows_abyssPrivate.rows.task(key);
    return task !== undefined && 'ref' in task ? task : undefined;
  }
  private invalidateCompactInteractions_abyssPrivate(
    previous: TaskListRows<TaskSearchOccurrence>,
    next: TaskListRows<TaskSearchOccurrence>,
  ): void {
    const same = (key: string): boolean => {
      const a = previous.task(key)?.address,
        b = next.task(key)?.address;
      return (
        a !== undefined && a.epoch === b?.epoch && a.version === b.version && a.rootId === b.rootId
      );
    };
    this.invalidateCompactReturn_abyssPrivate(same);
    for (const record of [...this.taskInteractionPins_abyssPrivate])
      if (!same(record.key)) {
        this.taskInteractionPins_abyssPrivate.delete(record);
        record.cancel();
      }
    const active = this.el.ownerDocument.activeElement;
    const key = this.eventTaskCardKey_abyssPrivate(active);
    if (key !== undefined && !same(key) && isRealmHTMLElement(active)) {
      active.blur();
      this.wholeCardFocus_abyssPrivate = null;
    }
  }

  private invalidateCompactReturn_abyssPrivate(same: (key: string) => boolean): void {
    const record = this.cardReturn_abyssPrivate;
    if (record !== null && !same(record.key)) this.clearCardReturn_abyssPrivate();
  }

  private createListViewControls_abyssPrivate(): ListViewControls {
    return new ListViewControls({
      state: this.state_abyssPrivate,
      settings: this.settings_abyssPrivate,
      statusRegistry: this.statusRegistry_abyssPrivate,
      interactionOwnership: this.interactionOwnership_abyssPrivate,
      saveViewState: this.onSaveViewState_abyssPrivate,
      host: {
        root: () => this.el,
        formatDate: (value) => this.formatDate_abyssPrivate(value),
      },
    });
  }

  private createCaptureSessions_abyssPrivate(): CaptureSessions {
    return new CaptureSessions({
      state: this.state_abyssPrivate,
      settings: this.settings_abyssPrivate,
      application: this.captureApplication_abyssPrivate,
      listNodes: () => this.tasks_abyssPrivate?.queries.listNodes() ?? [],
      captureReveal: (isCurrent) => this.captureRevealAuthority_abyssPrivate(isCurrent),
      onCreationResult: (result, description, revealAuthority) => {
        this.onCreationResult_abyssPrivate(result, description, revealAuthority);
      },
      root: () => this.el,
    });
  }

  private configureRenderCallbacks_abyssPrivate(
    options: CenterPanelOptions,
    complete: (root: HTMLElement) => void,
  ): void {
    this.onRenderComplete_abyssPrivate = complete;
    this.onTaskRowsSettled_abyssPrivate = options.onTaskRowsSettled;
  }

  private captureRevealAuthority_abyssPrivate(ownsCapture: () => boolean): CreationRevealAuthority {
    const retained = this.taskSurface_abyssPrivate;
    const context = this.captureContextRevision_abyssPrivate;
    const document = retained?.host.ownerDocument;
    const owner = document?.defaultView;
    const isCurrent = (): boolean =>
      retained !== null &&
      retained === this.taskSurface_abyssPrivate &&
      context === this.captureContextRevision_abyssPrivate &&
      retained.host.ownerDocument === document &&
      document.defaultView === owner &&
      this.creationHostVisible_abyssPrivate(retained.host) &&
      ownsCapture();
    return {
      isCurrent,
      reveal: (ref, request) => {
        const current = (): boolean =>
          isCurrent() && request.isCurrent() && !request.signal.aborted;
        if (!current() || retained === null) return undefined;
        const order = retained.search?.order ?? retained.surface.rows;
        const key = order.occurrencesOf(`${ref.filePath}:${ref.line}`)[0];
        if (key === undefined) return undefined;
        const attempt = { retained, ref, key, request, isCurrent: current };
        return retained.search === undefined
          ? this.revealSnapshotCreation_abyssPrivate(attempt)
          : this.revealCompactCreation_abyssPrivate(attempt);
      },
    };
  }

  private revealSnapshotCreation_abyssPrivate(
    attempt: CreationRowAttempt,
  ): HTMLElement | undefined {
    const { retained, ref, key } = attempt;
    const exact = (): boolean => {
      const task = this.mountedSnapshot_abyssPrivate(key);
      return task !== undefined && this.sameCardRef_abyssPrivate(task.ref, ref);
    };
    if (!exact()) return undefined;
    const element = retained.surface.reveal(key);
    return attempt.isCurrent() &&
      exact() &&
      element !== undefined &&
      this.readyCreationCard_abyssPrivate(element, ref)
      ? element
      : undefined;
  }

  private async revealCompactCreation_abyssPrivate(
    attempt: CreationRowAttempt,
  ): Promise<HTMLElement | undefined> {
    const { retained, key, request } = attempt;
    const compact = retained.search;
    const occurrence = compact?.order.task(key);
    const document = retained.host.ownerDocument;
    const owner = document.defaultView;
    if (compact === undefined || occurrence === undefined || owner === null) return undefined;
    const controller = new AbortController();
    const abort = (): void => {
      controller.abort();
    };
    const current = (): boolean =>
      !controller.signal.aborted &&
      attempt.isCurrent() &&
      retained.search === compact &&
      !compact.identity.signal.aborted &&
      compact.order.task(key) === occurrence &&
      retained.options.isCurrent?.() !== false;
    const checkVisibility = (): void => {
      if (!current()) abort();
    };
    let observer: ResizeObserver | undefined;
    let release: (() => void) | undefined;
    const cleanup = (): void => {
      release?.();
      observer?.disconnect();
      document.removeEventListener('visibilitychange', checkVisibility);
      request.signal.removeEventListener('abort', abort);
      compact.identity.signal.removeEventListener('abort', abort);
      this.creationAttempts_abyssPrivate.delete(abort);
    };
    controller.signal.addEventListener('abort', cleanup, { once: true });
    try {
      this.creationAttempts_abyssPrivate.add(abort);
      request.signal.addEventListener('abort', abort, { once: true });
      compact.identity.signal.addEventListener('abort', abort, { once: true });
      document.addEventListener('visibilitychange', checkVisibility);
      observer = new owner.ResizeObserver(checkVisibility);
      observer.observe(retained.host);
      release = retained.surface.pin(key, abort);
      if (
        !(await this.awaitCreationRow_abyssPrivate(
          attempt,
          compact.rows,
          controller.signal,
          current,
        ))
      )
        return undefined;
      return this.revealReadyCreation_abyssPrivate(attempt, current);
    } catch (error) {
      if (current()) this.reportTaskRenderFailure_abyssPrivate(error);
      return undefined;
    } finally {
      controller.abort();
      cleanup();
    }
  }

  private async awaitCreationRow_abyssPrivate(
    attempt: CreationRowAttempt,
    rows: TaskSearchRows,
    signal: AbortSignal,
    current: () => boolean,
  ): Promise<boolean> {
    if (!current()) return false;
    const snapshot = await this.snapshotForKey_abyssPrivate(attempt.key, signal);
    if (!current() || !this.exactCreationSnapshot_abyssPrivate(snapshot, attempt.ref)) return false;
    const outcome = await rows.settleRow(attempt.key, signal);
    return current() && outcome.type === 'ready';
  }

  private exactCreationSnapshot_abyssPrivate(
    task: TaskSnapshot | undefined,
    ref: TaskRef,
  ): boolean {
    return task !== undefined && this.sameCardRef_abyssPrivate(task.ref, ref);
  }

  private revealReadyCreation_abyssPrivate(
    attempt: CreationRowAttempt,
    current: () => boolean,
  ): HTMLElement | undefined {
    const element = attempt.retained.surface.reveal(attempt.key);
    return current() &&
      element !== undefined &&
      this.readyCreationCard_abyssPrivate(element, attempt.ref)
      ? element
      : undefined;
  }

  private async snapshotForKey_abyssPrivate(
    key: string,
    signal: AbortSignal,
  ): Promise<TaskSnapshot | undefined> {
    if (signal.aborted) return undefined;
    const retained = this.taskSurface_abyssPrivate;
    if (retained?.search !== undefined) return retained.search.rows.snapshot(key, signal);
    return this.mountedSnapshot_abyssPrivate(key);
  }

  private readyCreationCard_abyssPrivate(element: HTMLElement, ref: TaskRef): boolean {
    const rect = element.getBoundingClientRect();
    return (
      element.isConnected &&
      rect.width > 0 &&
      rect.height > 0 &&
      renderedTaskElements(this.el, ref).includes(element) &&
      this.creationHostVisible_abyssPrivate(element)
    );
  }

  private creationHostVisible_abyssPrivate(host: HTMLElement): boolean {
    const document = host.ownerDocument;
    const owner = document.defaultView;
    const rect = host.getBoundingClientRect();
    if (
      !host.isConnected ||
      document.hidden ||
      owner === null ||
      rect.width <= 0 ||
      rect.height <= 0
    )
      return false;
    for (let node: HTMLElement | null = host; node !== null; node = node.parentElement) {
      const style = owner.getComputedStyle(node);
      if (
        style.display === 'none' ||
        ['hidden', 'collapse'].includes(style.visibility) ||
        style.opacity === '0'
      )
        return false;
    }
    return true;
  }

  private cancelCreationAttempts_abyssPrivate(): void {
    for (const cancel of this.creationAttempts_abyssPrivate) cancel();
    this.creationAttempts_abyssPrivate.clear();
  }

  private sameSearchRoot_abyssPrivate(
    a: TaskSearchAddress | undefined,
    b: TaskSearchAddress,
  ): boolean {
    return a?.rootId === b.rootId && a.epoch === b.epoch && a.version === b.version;
  }

  private refreshSearchPulse_abyssPrivate(): void {
    const receipt = this.taskSearchReveal_abyssPrivate.current();
    const retained = this.taskSurface_abyssPrivate;
    if (receipt === undefined || retained === null) return;
    for (const key of retained.surface.mountedKeys()) {
      const address = retained.search?.order.task(key)?.address;
      if (
        !this.sameSearchRoot_abyssPrivate(address, receipt.address) ||
        this.mountedSnapshot_abyssPrivate(key) === undefined
      )
        continue;
      const card = retained.surface.element(key);
      if (card === undefined) continue;
      this.taskSearchReveal_abyssPrivate.refresh(card);
      return;
    }
  }

  private scheduleTaskRowsSettled_abyssPrivate(): void {
    if (this.taskRowsSettledQueued_abyssPrivate) return;
    const retained = this.taskSurface_abyssPrivate;
    const identity = retained?.search?.identity;
    const owner = retained?.host.ownerDocument.defaultView;
    this.taskRowsSettledQueued_abyssPrivate = true;
    void Promise.resolve()
      .then(() => {
        this.taskRowsSettledQueued_abyssPrivate = false;
        if (
          retained === null ||
          retained !== this.taskSurface_abyssPrivate ||
          retained.search?.identity !== identity ||
          retained.host.ownerDocument.defaultView !== owner ||
          retained.options.isCurrent?.() === false ||
          !this.creationHostVisible_abyssPrivate(retained.host)
        )
          return;
        this.refreshSearchPulse_abyssPrivate();
        this.onTaskRowsSettled_abyssPrivate?.(this.el);
      })
      .catch((error: unknown) => {
        if (retained === this.taskSurface_abyssPrivate)
          this.reportTaskRenderFailure_abyssPrivate(error);
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
        beginBulkResolution: (card) => {
          const record = this.cardReturn_abyssPrivate;
          if (record?.opener !== card) return () => {};
          record.resolving = true;
          return () => {
            if (this.cardReturn_abyssPrivate !== record) return;
            record.resolving = false;
            this.finishCardReturn_abyssPrivate();
          };
        },
        reportTargetFailure: (error) => {
          this.reportTaskRenderFailure_abyssPrivate(error);
        },
        showTaskMenu: (menu, event, card) => {
          this.showTaskMenu_abyssPrivate(menu, event, card);
        },
        applyBulkDuePreset: (card, tasks, value) => {
          this.applyBulkDuePreset_abyssPrivate(card, tasks, value);
        },
        applyBulkTaskTags: (card, tasks, add, remove) => {
          this.runBulkMenuAction_abyssPrivate(card, (onResult) =>
            Promise.all(
              tasks.map((task) =>
                this.taskCommands_abyssPrivate.patchTaskTags(task, add, remove, onResult),
              ),
            ),
          );
        },
        openDatePicker: (anchor, selectedTasks, targets) => {
          this.openTaskDatePicker_abyssPrivate(anchor, selectedTasks, targets);
        },
        openRecurrenceEditor: (anchor, task) => {
          this.openRecurrenceEditor_abyssPrivate(anchor, task);
        },
        addFilter: (filter) => {
          this.listViewControls_abyssPrivate.addPropertyFilter(filter);
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
          clearTaskSearchReveal: () => {
            this.clearTaskSearchReveal();
          },
          finishProjectTableEditorBefore: (action) => {
            this.finishProjectTableEditorBefore(action);
          },
        },
        this.onSaveViewState_abyssPrivate,
      )
    );
  }

  mount(container: HTMLElement): void {
    this.mounted_abyssPrivate = true;
    this.el = container;
    this.initializeOwnedUi_abyssPrivate();
    this.listViewControls_abyssPrivate.initializeListViewState();
    this.subscribeToState_abyssPrivate();
    this.subscribeToTracking_abyssPrivate();
    this.subscribeToLinkOrganization_abyssPrivate();
    this.render_abyssPrivate();
    this.el.setAttribute('tabindex', '0');
    this.mountKeyboardNavigation_abyssPrivate();
    this.mountFocusContinuity_abyssPrivate();
  }

  private subscribeToLinkOrganization_abyssPrivate(): void {
    const refresh = (): void => {
      this.taskSearch_abyssPrivate.refresh('links');
    };
    if (this.searchApi_abyssPrivate === undefined) return;
    const vault = this.app_abyssPrivate.vault;
    const refs = [
      vault.on('create', refresh),
      vault.on('rename', refresh),
      vault.on('delete', refresh),
    ];
    this.offs_abyssPrivate.push(() => {
      for (const ref of refs) vault.offref(ref);
    });
    const cache = this.app_abyssPrivate.metadataCache;
    const ref = cache.on('resolved', refresh);
    this.offs_abyssPrivate.push(() => {
      cache.offref(ref);
    });
  }

  private initializeOwnedUi_abyssPrivate(): void {
    this.taskModal_abyssPrivate = new TaskModal({
      app: this.app_abyssPrivate,
      statusRegistry: this.statusRegistry_abyssPrivate,
      settings: this.settings_abyssPrivate,
      queries: this.queries_abyssPrivate,
      search: this.searchApi_abyssPrivate,
      tasks: this.tasks_abyssPrivate,
      commentTimeContext: this.commentTimeContext_abyssPrivate,
      interactionOwnership: this.interactionOwnership_abyssPrivate,
    });
  }

  private subscribeToState_abyssPrivate(): void {
    this.offs_abyssPrivate.push(
      this.state_abyssPrivate.on('selectedList', () => {
        this.handleSelectedListChanged_abyssPrivate();
      }),
      this.state_abyssPrivate.on('mode', () => {
        this.wholeCardFocus_abyssPrivate = null;
        this.clearCardReturn_abyssPrivate();
        this.captureSessions_abyssPrivate.cancelStaleListCapture();
        this.calendar_abyssPrivate.cancelKeyboardInteraction();
      }),
      this.state_abyssPrivate.on('searchQuery', (query) => {
        this.taskSearch_abyssPrivate.queryChanged(query);
      }),
      this.state_abyssPrivate.on('taskStack', () => {
        this.updateTaskStackSelection_abyssPrivate();
      }),
      this.state_abyssPrivate.onCommit((changed) => {
        this.handleStateCommit_abyssPrivate(changed);
      }),
    );
  }

  private handleSelectedListChanged_abyssPrivate(): void {
    this.wholeCardFocus_abyssPrivate = null;
    this.clearCardReturn_abyssPrivate();
    this.captureSessions_abyssPrivate.cancelStaleListCapture();
    this.rowSelection_abyssPrivate.clear();
  }

  private detailOccurrenceKey_abyssPrivate(): string | undefined {
    const physical = taskStackRowKey(this.state_abyssPrivate.get('taskStack'));
    if (physical === undefined) return undefined;
    const rows = this.mountedRows_abyssPrivate.rows;
    const previous = this.rowSelection_abyssPrivate.focus;
    return previous !== null && rows.physicalKey(previous) === physical
      ? previous
      : rows.occurrencesOf(physical)[0];
  }

  private updateTaskStackSelection_abyssPrivate(): void {
    const stack = this.state_abyssPrivate.get('taskStack');
    const root = stack[0];
    const current = stack[stack.length - 1];
    const detailKey = this.detailOccurrenceKey_abyssPrivate();
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
      this.taskCardRenderer_abyssPrivate.syncDeleteButton(card, isSelected ? deletable : undefined);
    }
    this.el.querySelectorAll<HTMLElement>('.abyss-calendar-item.is-selected').forEach((item) => {
      item.classList.remove('is-selected');
    });
    if (current !== undefined) {
      renderedTaskNodeElements(this.el, taskNodeRef(current)).forEach((item) => {
        if (item.classList.contains('abyss-task-card')) return;
        item.classList.add('is-selected');
      });
    }
  }

  private handleStateCommit_abyssPrivate(changed: ReadonlySet<string>): void {
    this.taskSearchReveal_abyssPrivate.committed(changed);
    if (changed.size === 0 && this.state_abyssPrivate.get('mode') === 'calendar') {
      this.calendar_abyssPrivate.cancelKeyboardInteraction();
    }
    const renderKeys = ['selectedList', 'centerListViewState', 'centerFilter', 'mode'];
    if (renderKeys.some((key) => changed.has(key))) {
      this.menuIntent_abyssPrivate.abort();
      this.cancelCreationAttempts_abyssPrivate();
      this.captureContextRevision_abyssPrivate++;
    }
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
      if (this.state_abyssPrivate.get('mode') === 'tasks') {
        event.preventDefault();
        event.stopPropagation();
      }
      this.clearTaskSelection_abyssPrivate();
      return;
    }
    if (this.selectAllTaskRows_abyssPrivate(event)) return;
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
    return this.isTaskListKeyboardTarget_abyssPrivate(event.target);
  }

  private selectAllTaskRows_abyssPrivate(event: KeyboardEvent): boolean {
    if (
      event.defaultPrevented ||
      event.key.toLowerCase() !== 'a' ||
      event.ctrlKey === event.metaKey ||
      event.altKey ||
      event.shiftKey ||
      !this.isTaskListKeyboardTarget_abyssPrivate(event.target)
    )
      return false;
    const order = this.listOrder_abyssPrivate();
    if (order.taskKeys.length === 0) return false;
    event.preventDefault();
    event.stopPropagation();
    this.rowSelection_abyssPrivate.selectAll(order, {
      target: this.eventTaskCardKey_abyssPrivate(event.target),
      detail: this.detailOccurrenceKey_abyssPrivate(),
    });
    this.updateSelectionVisuals_abyssPrivate();
    return true;
  }

  private isTaskListKeyboardTarget_abyssPrivate(target: EventTarget | null): boolean {
    if (this.state_abyssPrivate.get('mode') !== 'tasks') return false;
    if (!isRealmHTMLElement(target)) return true;
    return (
      target.closest(
        'input, textarea, select, button, a, [contenteditable]:not([contenteditable="false"]), .abyss-status-marker, .abyss-status-control, .abyss-popover',
      ) == null
    );
  }

  /** Model, visuals, the opened task for a plain arrow, then focus, as the list always did. */
  private moveTaskSelection_abyssPrivate(
    event: KeyboardEvent,
    order: TaskListRows<SurfaceTask>,
  ): void {
    const extend = event.shiftKey;
    const next = this.rowSelection_abyssPrivate.move(
      event.key === 'ArrowDown' ? 'down' : 'up',
      order,
      {
        target: this.eventTaskCardKey_abyssPrivate(event.target),
        detail: this.detailOccurrenceKey_abyssPrivate(),
      },
      extend,
    );
    if (next === undefined) return;
    this.updateSelectionVisuals_abyssPrivate();
    if (this.taskSurface_abyssPrivate?.search !== undefined) {
      void this.readyKeyboardTarget_abyssPrivate(next, extend).catch((error: unknown) => {
        this.reportTaskRenderFailure_abyssPrivate(error);
      });
      return;
    }
    const task = extend ? undefined : this.mountedSnapshot_abyssPrivate(next);
    if (task !== undefined) this.state_abyssPrivate.set('taskStack', [task]);
    this.focusTaskKey_abyssPrivate(next);
  }

  private async readyKeyboardTarget_abyssPrivate(key: string, extend: boolean): Promise<void> {
    this.keyboardTarget_abyssPrivate?.abort();
    const controller = new AbortController();
    this.keyboardTarget_abyssPrivate = controller;
    const retained = this.taskSurface_abyssPrivate,
      compact = retained?.search;
    if (retained === null || compact === undefined) return;
    const doc = this.el.ownerDocument,
      owner = doc.defaultView,
      opener = doc.activeElement;
    const intent = this.state_abyssPrivate.taskSelectionIntentGeneration;
    const current = (): boolean =>
      !controller.signal.aborted &&
      !compact.identity.signal.aborted &&
      this.taskSurface_abyssPrivate === retained &&
      retained.search === compact &&
      this.rowSelection_abyssPrivate.focus === key &&
      this.state_abyssPrivate.get('mode') === 'tasks' &&
      this.state_abyssPrivate.taskSelectionIntentGeneration === intent &&
      this.keyboardFocusCurrent_abyssPrivate(doc, owner, opener, retained.host);
    const abort = (): void => {
      controller.abort();
    };
    const focus = (): void => {
      if (!current()) abort();
    };
    doc.addEventListener('focusin', focus);
    compact.identity.signal.addEventListener('abort', abort, { once: true });
    const release = retained.surface.pin(key, abort);
    try {
      const ready = await this.readyCompactCard_abyssPrivate(
        retained,
        key,
        controller.signal,
        current,
      );
      if (ready === undefined || !current()) return;
      if (!extend) this.state_abyssPrivate.set('taskStack', [ready.task]);
      ready.card.focus({ preventScroll: true });
    } catch (error) {
      if (current()) this.reportTaskRenderFailure_abyssPrivate(error);
    } finally {
      release();
      doc.removeEventListener('focusin', focus);
      compact.identity.signal.removeEventListener('abort', abort);
      controller.abort();
    }
  }

  private keyboardFocusCurrent_abyssPrivate(
    doc: Document,
    owner: Window | null,
    opener: Element | null,
    host: HTMLElement,
  ): boolean {
    return (
      doc.defaultView === owner &&
      this.el.ownerDocument === doc &&
      (doc.activeElement === opener || doc.activeElement === doc.body) &&
      this.creationHostVisible_abyssPrivate(host)
    );
  }

  /** The key of the card a key event came from, read from that card. */
  private eventTaskCardKey_abyssPrivate(target: EventTarget | null): string | undefined {
    const card = isRealmHTMLElement(target)
      ? target.closest<HTMLElement>('.abyss-task-card')
      : null;
    return card != null && this.el.contains(card)
      ? (card.dataset['rowKey'] ??
          `${card.dataset['filePath'] ?? ''}:${card.dataset['line'] ?? ''}`)
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
      if (
        event.target !== this.wholeCardFocus_abyssPrivate &&
        !(
          isRealmHTMLElement(event.target) &&
          this.wholeCardFocus_abyssPrivate?.contains(event.target) === true
        )
      )
        this.wholeCardFocus_abyssPrivate = null;
      this.revokeCardReturnOutside_abyssPrivate(event.target, true);
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
      this.clearCardReturn_abyssPrivate();
      this.wholeCardFocus_abyssPrivate = null;
      this.abandonTaskDateFocus_abyssPrivate();
      if (this.calendar_abyssPrivate.hasPendingTimedBlockFocus())
        this.calendar_abyssPrivate.cancelKeyboardInteraction();
    };
    ownerWindow?.addEventListener('blur', onOwnerWindowBlur);
    this.offs_abyssPrivate.push(() => {
      ownerWindow?.removeEventListener('blur', onOwnerWindowBlur);
    });
  }

  private captureWholeCardFocus_abyssPrivate(target: EventTarget | null): void {
    if (
      isRealmHTMLElement(target) &&
      target !== this.el.ownerDocument.body &&
      target !== this.el.ownerDocument.documentElement
    )
      this.wholeCardFocus_abyssPrivate =
        target.matches('.abyss-task-card') && this.el.contains(target) ? target : null;
  }

  private handlePanelFocusIn_abyssPrivate(target: EventTarget | null): void {
    this.captureWholeCardFocus_abyssPrivate(target);
    this.revokeCardReturnOutside_abyssPrivate(target);
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

  localSearchTarget(): LocalSearchFocusTarget | undefined {
    if (!this.el.isConnected) return undefined;
    const mode = this.state_abyssPrivate.get('mode');
    if (mode === 'search') return this.taskSearch_abyssPrivate.localSearchTarget();
    if (mode === 'projects') return this.projectsPanel_abyssPrivate?.localSearchTarget();
    if (mode !== 'tasks' || this.taskShell_abyssPrivate?.filterInput.isConnected !== true)
      return undefined;
    return { input: this.taskShell_abyssPrivate.filterInput, owner: this.el };
  }

  onWindowMigrated(): void {
    this.menuIntent_abyssPrivate.abort();
    this.cancelCreationAttempts_abyssPrivate();
    this.taskSearchReveal_abyssPrivate.cancelPulse();
    if (this.taskSurface_abyssPrivate?.search !== undefined) this.destroyTaskSurface_abyssPrivate();
    this.taskSearch_abyssPrivate.onWindowMigrated();
  }

  refresh(reason: 'view' | 'source' | 'projects' | 'links' = 'view'): void {
    if (this.refreshMountedProjects_abyssPrivate(this.state_abyssPrivate.get('mode'))) return;
    if (this.taskSearch_abyssPrivate.refresh(reason)) return;
    this.render_abyssPrivate();
  }

  refreshProjectTableSettings(): void {
    this.projectsPanel_abyssPrivate?.refreshTableSettings();
  }

  /** Keeps project-table draft ownership at the table before a mode transition. */
  clearTaskSearchReveal(): void {
    this.taskSearchReveal_abyssPrivate.clear();
  }

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
    this.mounted_abyssPrivate = false;
    this.wholeCardFocus_abyssPrivate = null;
    this.clearCardReturn_abyssPrivate();
    this.renderCardFocus_abyssPrivate = null;
    this.taskMenuCleanup_abyssPrivate?.();
    this.trackingUnsubscribe_abyssPrivate?.();
    this.trackingUnsubscribe_abyssPrivate = undefined;
    // Nothing can repaint them any more, and their elements go with the panel.
    this.destroyTaskSurface_abyssPrivate();
    this.taskCardRenderer_abyssPrivate.clear();
    this.endTaskDrag_abyssPrivate?.();
    this.taskCommands_abyssPrivate.dispose();
    this.captureSessions_abyssPrivate.cancelActiveCapture();
    this.calendar_abyssPrivate.cancelKeyboardInteraction();
    this.abandonTaskDateFocus_abyssPrivate();
    this.taskSearchReveal_abyssPrivate.dispose();
    this.taskSearch_abyssPrivate.clear();
    this.clearTaskDatePicker_abyssPrivate();
    this.dismissRecurrenceEditor_abyssPrivate();
    this.listViewControls_abyssPrivate.closeViewStatePopover();
    this.searchControls_abyssPrivate.closeViewStatePopover();
    this.taskModal_abyssPrivate?.close();
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
    const scroll =
      host.querySelector<HTMLElement>('.abyss-project-tasks-scroll') ??
      host.createDiv({ cls: 'abyss-center-scroll abyss-project-tasks-scroll' });
    this.renderFlat_abyssPrivate(scroll, tasks, tagGroups);
    this.renderTaskEmptyState_abyssPrivate(scroll, tasks.length === 0, 'No tasks yet');
    const bar =
      host.querySelector<HTMLElement>('.abyss-add-task-bar') ??
      host.createDiv({ cls: 'abyss-add-task-bar' });
    this.captureSessions_abyssPrivate.renderCaptureHost(bar, { type: 'project', path });
    this.completeTaskCardRender_abyssPrivate();
  }

  private render_abyssPrivate(): void {
    const mode = this.state_abyssPrivate.get('mode');
    if (this.refreshMountedProjects_abyssPrivate(mode)) return;
    const retainTaskShell = this.canRetainTaskShell_abyssPrivate(mode);
    const shell = this.taskShell_abyssPrivate;
    if (
      retainTaskShell &&
      shell !== null &&
      this.hasCompactTasks_abyssPrivate() &&
      this.taskSearch_abyssPrivate.refreshFilter(this.el, shell.scroll)
    ) {
      this.syncTaskHeader_abyssPrivate(shell);
      return;
    }
    this.beginTaskCardRender_abyssPrivate();
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
      this.taskSearch_abyssPrivate.render(this.el);
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
      this.prepareRender_abyssPrivate(
        mode,
        this.taskSurface_abyssPrivate?.host.isConnected === true,
      );
    }
    panel.refresh();
    return true;
  }

  private canRetainTaskShell_abyssPrivate(mode: string): boolean {
    const shell = this.taskShell_abyssPrivate;
    return (
      mode === 'tasks' &&
      shell?.key === this.listViewControls_abyssPrivate.activeListKey() &&
      shell.header.isConnected &&
      shell.scroll.isConnected &&
      shell.addBar.isConnected
    );
  }

  private prepareRender_abyssPrivate(mode: string, retainTaskShell = false): void {
    if (!retainTaskShell) {
      this.taskMenuCleanup_abyssPrivate?.();
      this.captureSessions_abyssPrivate.unmountActiveCapture();
    }
    if (!retainTaskShell) this.clearTaskDatePicker_abyssPrivate();
    this.renderingRecurrenceCleanup_abyssPrivate = true;
    try {
      if (!retainTaskShell) this.dismissRecurrenceEditor_abyssPrivate();
    } finally {
      this.renderingRecurrenceCleanup_abyssPrivate = false;
    }
    if (!retainTaskShell) this.listViewControls_abyssPrivate.closeViewStatePopover();
    this.taskSearch_abyssPrivate.clear();
    if (mode !== 'search') this.searchControls_abyssPrivate.closeViewStatePopover();
    if (mode === 'search') return;
    this.md_abyssPrivate.unload();
    this.md_abyssPrivate = new Component();
    this.md_abyssPrivate.load();
  }

  private prepareNonCalendarRoot_abyssPrivate(retainTaskShell = false): void {
    this.el.removeClass('abyss-center--calendar');
    this.calendar_abyssPrivate.unmount();
    if (!retainTaskShell) {
      this.destroyTaskSurface_abyssPrivate();
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
        unmountTasks: () => {
          this.captureSessions_abyssPrivate.cancelActiveCapture();
          this.clearTaskDatePicker_abyssPrivate();
          this.dismissRecurrenceEditor_abyssPrivate();
          this.destroyTaskSurface_abyssPrivate();
        },
        renderTasks: (host, path) => {
          this.renderProjectTasks_abyssPrivate(host, path);
        },
      },
    );
    const host = this.el.createDiv({ cls: 'abyss-projects-host' });
    this.projectsPanel_abyssPrivate.mount(host);
    this.onRenderComplete_abyssPrivate(this.el);
  }

  private hasCompactTasks_abyssPrivate(): boolean {
    return (
      this.state_abyssPrivate.get('centerFilter').length > 0 ||
      this.taskSearchReveal_abyssPrivate.current() !== undefined
    );
  }

  private renderTasksMode_abyssPrivate(): void {
    this.el.removeClass('abyss-center--projects');
    const shell = this.ensureTaskShell_abyssPrivate();
    this.syncTaskHeader_abyssPrivate(shell);
    const { scroll, addBar } = shell;
    if (this.hasCompactTasks_abyssPrivate()) {
      this.captureSessions_abyssPrivate.renderCaptureHost(addBar, {
        type: 'list',
        selectionKey: listSelectionToKey(this.state_abyssPrivate.get('selectedList')),
      });
      this.taskSearch_abyssPrivate.renderFilter(
        this.el,
        scroll,
        this.state_abyssPrivate.get('centerFilter'),
      );
      return;
    }
    const tasks = this.getFilteredTasks_abyssPrivate();
    this.renderWithGrouping_abyssPrivate(scroll, tasks, this.effectiveTagGroups_abyssPrivate());
    this.renderTaskEmptyState_abyssPrivate(scroll, tasks.length === 0, 'No tasks');
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
    const viewButton = this.listViewControls_abyssPrivate.renderViewStateButton(controls);
    const filterInput = this.renderTaskFilterInput_abyssPrivate(controls);
    this.onRenderTaskHeaderActions_abyssPrivate?.(header, title, controls);
    const scroll = this.el.createDiv({ cls: 'abyss-center-scroll' });
    const addBar = this.el.createDiv({ cls: 'abyss-add-task-bar' });
    const shell: NonNullable<CenterPanel['taskShell_abyssPrivate']> = {
      key: this.listViewControls_abyssPrivate.activeListKey(),
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
    shell.filterChips = this.listViewControls_abyssPrivate.renderPropertyChips(
      shell.controls,
      shell.viewButton,
    );
    const viewState = this.state_abyssPrivate.get('centerListViewState');
    shell.viewButton.toggleClass(
      'abyss-view-state-btn--active',
      isListViewOptionsCustomized(viewState, this.listViewControls_abyssPrivate.activeListKey()),
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
    let composing = false;
    searchInput.addEventListener('compositionstart', () => {
      composing = true;
    });
    searchInput.addEventListener('compositionend', () => {
      composing = false;
      this.state_abyssPrivate.set('centerFilter', searchInput.value);
    });
    searchInput.addEventListener('input', () => {
      if (composing) return;
      this.state_abyssPrivate.set('centerFilter', searchInput.value);
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

  private renderWithGrouping_abyssPrivate(
    container: HTMLElement,
    tasks: TaskSnapshot[],
    tagGroups: readonly EffectiveTagGroup[] = this.effectiveTagGroups_abyssPrivate(),
  ): void {
    const vs = this.state_abyssPrivate.get('centerListViewState');
    const grouping = taskListGrouping(vs.groupBy, {
      todayList: this.state_abyssPrivate.get('selectedList') === 'today',
      today: localDate(window.moment().format('YYYY-MM-DD')),
      tomorrow: window.moment().add(1, 'day').format('YYYY-MM-DD'),
      statuses: this.statusRegistry_abyssPrivate,
      outgoingLinks: this.outgoingLinks_abyssPrivate,
    });
    this.mountTaskRows_abyssPrivate(container, buildTaskListRows(tasks, grouping), tagGroups);
  }

  /** Mounts the tasks as ungrouped rows: Search results and a dashboard list. */
  private renderFlat_abyssPrivate(
    container: HTMLElement,
    tasks: TaskSnapshot[],
    tagGroups: readonly EffectiveTagGroup[] = this.effectiveTagGroups_abyssPrivate(),
    options: TaskRowOptions = {},
  ): void {
    this.mountTaskRows_abyssPrivate(
      container,
      buildTaskListRows(tasks, { by: 'none' }),
      tagGroups,
      options,
    );
  }

  /** The one place list rows become elements; the handle it keeps serves every later patch. */
  private mountTaskRows_abyssPrivate(
    container: HTMLElement,
    rows: TaskListRows,
    tagGroups: readonly EffectiveTagGroup[],
    options: TaskRowOptions = {},
  ): void {
    this.updateTaskSurface_abyssPrivate(container, rows, tagGroups, options);
  }

  private updateTaskSurface_abyssPrivate(
    host: HTMLElement,
    rows: TaskListRows,
    tagGroups: readonly EffectiveTagGroup[],
    options: TaskRowOptions = {},
  ): void {
    if (
      this.taskSurface_abyssPrivate?.host !== host ||
      this.taskSurface_abyssPrivate.search !== undefined
    ) {
      this.destroyTaskSurface_abyssPrivate();
      const surface = new TaskListSurface<SurfaceTask>({
        host,
        scroll: host.closest<HTMLElement>('.abyss-project-dashboard-session') ?? host,
        mount: (container, row) => {
          if (row.kind === 'task' && !('ref' in row.task)) throw new Error('Expected snapshot row');
          return this.mountTaskRow_abyssPrivate(
            container,
            row.kind === 'group' ? row : { ...row, task: row.task as TaskSnapshot },
            tagGroups,
          );
        },
        mountedChanged: () => {
          this.patchMountedSelection_abyssPrivate();
        },
        reportFailure: (error) => {
          this.reportTaskRenderFailure_abyssPrivate(error);
        },
      });
      this.taskSurface_abyssPrivate = { host, surface, tagGroups, options };
    }
    this.invalidateTaskInteractions_abyssPrivate(rows);
    const retained = this.taskSurface_abyssPrivate;
    retained.tagGroups = tagGroups;
    retained.options = options;
    this.mountedRows_abyssPrivate = retained.surface;
    retained.surface.update(
      rows,
      {
        revision: JSON.stringify([
          this.settings_abyssPrivate.sourceNoteDisplay,
          this.settings_abyssPrivate.taskFilePath,
          tagGroups,
        ]),
        preserveAnchor: true,
        estimate: (row) => (row.kind === 'group' ? 32 : 64),
        measurementRevision: (row) =>
          row.kind === 'task'
            ? this.taskRowRevision_abyssPrivate(row.task)
            : `${row.label}:${row.count}`,
      },
      options.failure ?? 'report',
    );
  }

  private mountTaskRow_abyssPrivate(
    container: HTMLElement,
    row: TaskListRow,
    tagGroups: readonly EffectiveTagGroup[],
  ): TaskRowMount {
    let card: TaskCardMount | undefined;
    let releaseNavigation: void | (() => void);
    const element = mountTaskListRow(container, row, (parent, taskRow) => {
      card = this.taskCardRenderer_abyssPrivate.mount(
        parent,
        taskRow.task,
        this.taskSurface_abyssPrivate?.tagGroups ?? tagGroups,
        this.taskCardOptions_abyssPrivate(taskRow.task, taskRow.key),
      );
      try {
        releaseNavigation = this.taskSurface_abyssPrivate?.options.onCard?.(
          card.element,
          taskRow.task,
        );
      } catch (error) {
        card.destroy();
        throw error;
      }
      this.observeTaskCardReceipt_abyssPrivate(card);
      return card.element;
    });
    return {
      element,
      update: (next) => {
        if (next.kind === 'task') {
          if (typeof releaseNavigation === 'function') releaseNavigation();
          releaseNavigation = undefined;
          card?.update(
            next.task,
            this.taskSurface_abyssPrivate?.tagGroups ?? tagGroups,
            this.taskCardOptions_abyssPrivate(next.task, next.key),
          );
          if (card !== undefined) this.observeTaskCardReceipt_abyssPrivate(card);
          releaseNavigation = this.taskSurface_abyssPrivate?.options.onCard?.(element, next.task);
        } else {
          element.textContent = `${next.label}  ${next.count}`;
          element.toggleClass('abyss-group-header--first', next.first);
        }
      },
      destroy: () => {
        if (typeof releaseNavigation === 'function') releaseNavigation();
        releaseNavigation = undefined;
        if (card !== undefined) card.destroy();
        else element.remove();
      },
    };
  }

  private observeTaskCardReceipt_abyssPrivate(card: TaskCardMount): void {
    const receipt = card.settled;
    void receipt
      .then((outcome) => {
        if (outcome.type === 'ready' && receipt === card.settled && card.element.isConnected)
          this.scheduleTaskRowsSettled_abyssPrivate();
      })
      .catch((error: unknown) => {
        this.reportTaskRenderFailure_abyssPrivate(error);
      });
  }

  private taskCardOptions_abyssPrivate(
    task: TaskSnapshot,
    rowKey: string,
  ): Parameters<TaskCardMount['update']>[2] {
    const options = this.taskSurface_abyssPrivate?.options;
    return {
      selected: this.isTaskCardSelected_abyssPrivate(task),
      showDelete: false,
      rowKey,
      get renderScope() {
        return options?.scope;
      },
      isCurrent: options?.isCurrent,
      signal: options?.signal,
      reportFailure: options?.reportFailure,
    };
  }

  private pinTaskInteraction_abyssPrivate(
    key: string,
    ref: TaskRef,
    cancel: () => void,
  ): () => void {
    const record = {
      key,
      ref,
      cancel: (): void => {
        this.taskInteractionPins_abyssPrivate.delete(record);
        release?.();
        cancel();
      },
    };
    this.taskInteractionPins_abyssPrivate.add(record);
    const release = this.taskSurface_abyssPrivate?.surface.pin(key, record.cancel);
    return () => {
      this.taskInteractionPins_abyssPrivate.delete(record);
      release?.();
    };
  }

  private invalidateTaskInteractions_abyssPrivate(rows: TaskListRows): void {
    for (const record of [...this.taskInteractionPins_abyssPrivate]) {
      const next = rows.task(record.key);
      if (next === undefined || !this.sameCardRef_abyssPrivate(next.ref, record.ref)) {
        this.taskInteractionPins_abyssPrivate.delete(record);
        record.cancel();
      }
    }
    this.invalidateTaskFocus_abyssPrivate(rows);
  }

  private invalidateTaskFocus_abyssPrivate(rows: TaskListRows): void {
    const active = this.el.ownerDocument.activeElement;
    const key = this.eventTaskCardKey_abyssPrivate(active);
    if (key === undefined || !isRealmHTMLElement(active)) return;
    const previous = this.mountedSnapshot_abyssPrivate(key);
    const next = rows.task(key);
    if (
      previous === undefined ||
      (next !== undefined && this.sameCardRef_abyssPrivate(previous.ref, next.ref))
    )
      return;
    if (next === undefined || !this.acceptedTaskFocusRef_abyssPrivate(key, next.ref)) {
      active.blur();
      this.wholeCardFocus_abyssPrivate = null;
    }
  }

  private acceptedTaskFocusRef_abyssPrivate(key: string, ref: TaskRef): boolean {
    if (
      this.taskDateFocusContinuityKey_abyssPrivate === key &&
      this.taskDateFocusRefs_abyssPrivate.some((accepted) =>
        this.sameCardRef_abyssPrivate(accepted, ref),
      )
    )
      return true;
    const record = this.cardReturn_abyssPrivate;
    return record?.key === key && this.sameCardRef_abyssPrivate(record.ref, ref);
  }

  private destroyTaskSurface_abyssPrivate(): void {
    this.cancelCreationAttempts_abyssPrivate();
    this.menuIntent_abyssPrivate.abort();
    const retained = this.taskSurface_abyssPrivate;
    this.taskSurface_abyssPrivate = null;
    retained?.search?.rows.dispose();
    retained?.surface.destroy();
    this.mountedSnapshots_abyssPrivate.clear();
    this.compactPresentation_abyssPrivate = undefined;
    this.keyboardTarget_abyssPrivate?.abort();
    this.mountedRows_abyssPrivate = NO_MOUNTED_TASK_LIST_ROWS;
  }

  private reportTaskRenderFailure_abyssPrivate(error: unknown): void {
    const report = this.taskSurface_abyssPrivate?.options.reportFailure;
    if (report !== undefined) {
      report(error);
      return;
    }
    new Notice('Could not render task list. Refresh the view to retry.');
    console.error('[abyss-tasks] Could not render task list', {
      kind: error instanceof Error ? error.name : typeof error,
    });
  }

  private renderTaskEmptyState_abyssPrivate(
    host: HTMLElement,
    empty: boolean,
    label: string,
  ): void {
    host.querySelector(':scope > .abyss-center-empty')?.remove();
    if (empty) host.createDiv({ cls: 'abyss-center-empty', text: label });
  }

  private isTaskCardSelected_abyssPrivate(task: TaskSnapshot): boolean {
    return taskStackRowKey(this.state_abyssPrivate.get('taskStack')) === taskRowKey(task);
  }

  private readonly dependenciesFor_abyssPrivate: TaskDependencyLookup = (task) => {
    const target = calendarMutationTarget(task);
    return target === undefined
      ? undefined
      : this.tasks_abyssPrivate?.queries.dependencySummary(target);
  };

  /**
   * A render owns the badges it creates and the instant they are read against, so the previous
   * render's badges go with it and every card in this one shows the same clock.
   */
  private beginTaskCardRender_abyssPrivate(): void {
    this.taskSearchReveal_abyssPrivate.cancelPulse();
    this.renderCardFocus_abyssPrivate = null;
    const active = this.el.ownerDocument.activeElement;
    for (const [key, card] of this.mountedRows_abyssPrivate.cards()) {
      const task = this.mountedSnapshot_abyssPrivate(key);
      if (
        active === card &&
        this.wholeCardFocus_abyssPrivate === card &&
        this.cardReturn_abyssPrivate === null &&
        task != null &&
        this.state_abyssPrivate.get('mode') === 'tasks'
      ) {
        this.renderCardFocus_abyssPrivate = {
          key,
          ref: task.ref,
          list: this.listViewControls_abyssPrivate.activeListKey(),
          opener: card,
        };
        break;
      }
    }
    if (this.taskSurface_abyssPrivate === null)
      this.mountedRows_abyssPrivate = NO_MOUNTED_TASK_LIST_ROWS;
    this.cardRenderNowMs_abyssPrivate = this.timeTracking_abyssPrivate?.context().nowMs ?? 0;
    this.taskCardRenderer_abyssPrivate.beginRender(this.cardRenderNowMs_abyssPrivate);
  }

  /** One subscription per panel repaints the running roots, and only those. */
  private subscribeToTracking_abyssPrivate(): void {
    const tracking = this.timeTracking_abyssPrivate;
    if (tracking === undefined) return;
    // A remount must not leave the previous mount listening, so the panel keeps exactly one.
    this.trackingUnsubscribe_abyssPrivate?.();
    this.trackingUnsubscribe_abyssPrivate = tracking.ticker.subscribe((state) => {
      this.taskCardRenderer_abyssPrivate.paintTracking(state);
    });
  }

  private mountTaskCardInteractions_abyssPrivate(
    card: HTMLElement,
    task: TaskSnapshot,
    rowKey = taskRowKey(task),
    context?: TaskCardInteractionContext,
  ): void {
    const currentTask = context?.currentTask ?? (() => task);
    const component = context?.component ?? this.md_abyssPrivate;
    component.registerDomEvent(card, 'click', (event) => {
      if (context?.onActivate !== undefined) {
        context.onActivate(currentTask());
        return;
      }
      this.handleTaskCardClick_abyssPrivate(event, currentTask(), rowKey);
    });
    if (context?.onActivate !== undefined) {
      mountTaskSearchKeyboardActivation(card, component, () => {
        context.onActivate?.(currentTask());
      });
    }
    this.mountTaskCardDrag_abyssPrivate(
      card,
      currentTask,
      context?.component ?? this.md_abyssPrivate,
    );
    component.registerDomEvent(card, 'contextmenu', (event) => {
      this.handleTaskContextMenu_abyssPrivate(event, card, currentTask(), rowKey);
    });
  }

  private handleTaskCardClick_abyssPrivate(
    event: MouseEvent,
    task: TaskSnapshot,
    key = taskRowKey(task),
  ): void {
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

  private mountTaskCardDrag_abyssPrivate(
    card: HTMLElement,
    currentTask: () => TaskSnapshot,
    component: Component,
  ): void {
    if (isForecastCalendarTask(currentTask())) return;
    card.setAttribute('draggable', 'true');
    component.register(() => {
      if (card.hasClass('abyss-dragging')) this.endTaskDrag_abyssPrivate?.();
    });
    component.registerDomEvent(card, 'dragstart', () => {
      const task = currentTask();
      this.endTaskDrag_abyssPrivate?.();
      const key = this.eventTaskCardKey_abyssPrivate(card);
      const releasePin =
        key === undefined
          ? undefined
          : this.pinTaskInteraction_abyssPrivate(key, task.ref, () =>
              this.endTaskDrag_abyssPrivate?.(),
            );
      card.classList.add('abyss-dragging');
      this.endTaskDrag_abyssPrivate = startTaskNodeDrag(this.state_abyssPrivate, this.el, card, {
        payload: {
          source: 'center-card',
          task: { root: task, path: [], node: task, target: { type: 'task', ref: task.ref } },
        },
        onEnd: () => {
          card.classList.remove('abyss-dragging');
          releasePin?.();
        },
      });
    });
    component.registerDomEvent(card, 'dragover', (event) => {
      const draggingTag = this.state_abyssPrivate.get('draggingTag');
      if (
        (draggingTag === null || draggingTag === '') &&
        !this.canDropProjectOnTask_abyssPrivate(currentTask())
      )
        return;
      event.preventDefault();
      card.classList.add('abyss-drop-target');
    });
    component.registerDomEvent(card, 'dragleave', () => {
      card.classList.remove('abyss-drop-target');
    });
    component.registerDomEvent(card, 'drop', (event) => {
      this.handleTaskCardDrop_abyssPrivate(event, card, currentTask());
    });
    if (this.tasks_abyssPrivate !== undefined) {
      const tasks = this.tasks_abyssPrivate;
      component.register(
        bindTaskHierarchyDrop(card, {
          state: this.state_abyssPrivate,
          tasks,
          parent: () =>
            this.state_abyssPrivate.get('mode') === 'tasks'
              ? { type: 'task', ref: currentTask().ref }
              : undefined,
          execute: (command) =>
            executeTaskHierarchy(
              this.state_abyssPrivate,
              tasks,
              command,
              () => this.mounted_abyssPrivate && this.el.isConnected,
            ),
        }),
      );
    }
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

  private clearCardReturn_abyssPrivate(): void {
    const previous = this.cardReturn_abyssPrivate;
    this.cardReturn_abyssPrivate = null;
    previous?.releasePin?.();
  }

  private sameCardRef_abyssPrivate(a: TaskRef, b: TaskRef): boolean {
    return taskReconciliationKey(a) === taskReconciliationKey(b);
  }

  private neutralCardFocus_abyssPrivate(opener: HTMLElement, surface?: HTMLElement): boolean {
    const doc = this.el.ownerDocument;
    const active = doc.activeElement;
    return (
      active === doc.body ||
      active === doc.documentElement ||
      active === opener ||
      (active != null && surface?.contains(active) === true)
    );
  }

  private connectedTaskCard_abyssPrivate(card: HTMLElement | undefined): card is HTMLElement {
    return card?.isConnected === true && card.ownerDocument === this.el.ownerDocument;
  }

  private returnExactCard_abyssPrivate(
    ref: TaskRef,
    key: string,
    ownsFocus: () => boolean,
  ): boolean {
    const valid = (): boolean => {
      const task = this.mountedSnapshot_abyssPrivate(key);
      return (
        this.state_abyssPrivate.get('mode') === 'tasks' &&
        task !== undefined &&
        this.sameCardRef_abyssPrivate(task.ref, ref) &&
        ownsFocus()
      );
    };
    if (!valid()) return false;
    const card =
      this.taskSurface_abyssPrivate?.surface.reveal(key) ??
      this.mountedRows_abyssPrivate.element(key);
    if (!valid() || !this.connectedTaskCard_abyssPrivate(card)) return false;
    card.focus({ preventScroll: true });
    if (this.taskSurface_abyssPrivate === null) this.scrollTaskCardIntoView_abyssPrivate(card);
    return true;
  }

  private armCardReturn_abyssPrivate(
    opener: HTMLElement,
    kind: 'menu' | 'recurrence',
  ): CenterPanel['cardReturn_abyssPrivate'] {
    const key = this.eventTaskCardKey_abyssPrivate(opener);
    const task = key == null ? undefined : this.mountedSnapshot_abyssPrivate(key);
    if (
      key == null ||
      task == null ||
      opener.isConnected !== true ||
      opener.ownerDocument !== this.el.ownerDocument
    )
      return null;
    this.clearCardReturn_abyssPrivate();
    const record: NonNullable<CenterPanel['cardReturn_abyssPrivate']> = {
      original: task,
      key,
      ref: task.ref,
      opener,
      list: this.listViewControls_abyssPrivate.activeListKey(),
      kind,
      surface: undefined,
      pending: false,
      resolving: false,
      hidden: false,
    };
    this.cardReturn_abyssPrivate = record;
    record.releasePin = this.taskSurface_abyssPrivate?.surface.pin(key, () => {
      if (this.cardReturn_abyssPrivate === record) this.clearCardReturn_abyssPrivate();
    });
    return record;
  }

  private ownsCardReturnTarget_abyssPrivate(
    record: NonNullable<CenterPanel['cardReturn_abyssPrivate']>,
    target: HTMLElement,
  ): boolean {
    return record.opener.contains(target) || record.surface?.contains(target) === true;
  }

  private revokeCardReturnOutside_abyssPrivate(target: EventTarget | null, pointer = false): void {
    const record = this.cardReturn_abyssPrivate;
    if (record == null || this.showingTaskMenu_abyssPrivate) return;
    const doc = this.el.ownerDocument;
    if (!pointer && (target === doc.body || target === doc.documentElement)) return;
    if (target === record.opener) return;
    if (isRealmHTMLElement(target) && this.ownsCardReturnTarget_abyssPrivate(record, target))
      return;
    this.clearCardReturn_abyssPrivate();
  }

  private finishCardReturn_abyssPrivate(): void {
    const record = this.cardReturn_abyssPrivate;
    if (record == null || record.pending || record.resolving || !record.hidden) return;
    this.returnExactCard_abyssPrivate(
      record.ref,
      record.key,
      () =>
        this.cardReturn_abyssPrivate === record &&
        record.list === this.listViewControls_abyssPrivate.activeListKey() &&
        this.neutralCardFocus_abyssPrivate(record.opener, record.surface),
    );
    if (this.cardReturn_abyssPrivate === record) this.clearCardReturn_abyssPrivate();
  }

  private showTaskMenu_abyssPrivate(menu: Menu, event: MouseEvent, card: HTMLElement): void {
    this.taskMenuCleanup_abyssPrivate?.();
    const record = this.armCardReturn_abyssPrivate(card, 'menu');
    const releasePin =
      record === null
        ? undefined
        : this.pinTaskInteraction_abyssPrivate(record.key, record.ref, () => {
            if (this.cardReturn_abyssPrivate === record && !record.pending)
              this.clearCardReturn_abyssPrivate();
            menu.hide();
          });
    const close = (): void => {
      releasePin?.();
      menu.hide();
      if (this.taskMenuCleanup_abyssPrivate === close) this.taskMenuCleanup_abyssPrivate = null;
    };
    this.taskMenuCleanup_abyssPrivate = close;
    menu.onHide(() => {
      releasePin?.();
      if (this.taskMenuCleanup_abyssPrivate === close) this.taskMenuCleanup_abyssPrivate = null;
      if (record == null || this.cardReturn_abyssPrivate !== record) return;
      record.hidden = true;
      this.finishCardReturn_abyssPrivate();
    });
    this.showingTaskMenu_abyssPrivate = true;
    try {
      const surface = showMenuAtMouseEventWithFocus(menu, event);
      if (record != null) record.surface = surface;
    } finally {
      this.showingTaskMenu_abyssPrivate = false;
    }
  }

  private applyBulkDuePreset_abyssPrivate(
    card: HTMLElement,
    tasks: readonly TaskSnapshot[],
    value: LocalDate,
  ): void {
    this.runBulkMenuAction_abyssPrivate(card, (onResult) =>
      this.taskCommands_abyssPrivate.applyBulkDuePreset(tasks, value, onResult),
    );
  }

  private runBulkMenuAction_abyssPrivate(
    card: HTMLElement,
    action: (onResult: (task: TaskSnapshot, result: TaskCommandResult) => void) => Promise<unknown>,
  ): void {
    const existing = this.cardReturn_abyssPrivate;
    const record =
      existing?.opener === card ? existing : this.armCardReturn_abyssPrivate(card, 'menu');
    if (record != null) {
      record.pending = true;
      if (record !== existing) record.hidden = true;
    }
    runAsyncAction(
      action((submitted, result) => {
        if (
          record == null ||
          this.cardReturn_abyssPrivate !== record ||
          !this.sameCardRef_abyssPrivate(submitted.ref, record.original.ref)
        )
          return;
        if (result.type === 'ok' && result.outcome.type === 'task')
          record.ref = result.outcome.task.ref;
        else this.clearCardReturn_abyssPrivate();
      }).finally(() => {
        if (record != null && this.cardReturn_abyssPrivate === record) {
          record.pending = false;
          this.finishCardReturn_abyssPrivate();
        }
      }),
    );
  }

  private handleTaskContextMenu_abyssPrivate(
    event: MouseEvent,
    card: HTMLElement,
    task: TaskSnapshot,
    key = taskRowKey(task),
  ): void {
    event.preventDefault();
    const selection = this.rowSelection_abyssPrivate;
    if (selection.size > 0 && !selection.has(key)) this.clearTaskSelection_abyssPrivate();
    const targets = this.taskMenuTargets_abyssPrivate();
    if (targets.summaries.length >= 2) {
      this.taskMenus_abyssPrivate.showBulkContextMenu(event, card, targets);
      return;
    }
    const menu = this.taskMenus_abyssPrivate.createTaskContextMenu(card, task);
    this.showTaskMenu_abyssPrivate(menu, event, card);
  }

  private menuIntent_abyssPrivate = new AbortController();
  private taskMenuTargets_abyssPrivate(): TaskMenuTargets {
    this.menuIntent_abyssPrivate.abort();
    const controller = new AbortController();
    this.menuIntent_abyssPrivate = controller;
    const order = this.listOrder_abyssPrivate();
    const keys = [
      ...new Map(
        this.rowSelection_abyssPrivate.inOrder(order).map((key) => [order.physicalKey(key), key]),
      ).values(),
    ];
    const compact = this.taskSurface_abyssPrivate?.search;
    const tasks = compact === undefined ? this.selectedTasksInVisualOrder_abyssPrivate() : [];
    const summaries =
      compact === undefined
        ? tasks
        : keys.flatMap((key) => {
            const row = compact.order.task(key);
            return row === undefined ? [] : [row.menu];
          });
    const abort = (): void => {
      controller.abort();
    };
    const off = this.queries_abyssPrivate.subscribe(abort);
    compact?.identity.signal.addEventListener('abort', abort, { once: true });
    controller.signal.addEventListener(
      'abort',
      () => {
        off();
        compact?.identity.signal.removeEventListener('abort', abort);
      },
      { once: true },
    );
    if (compact?.identity.signal.aborted === true) abort();
    return {
      signal: controller.signal,
      summaries,
      resolve: async (signal) => {
        this.assertMenuTargets_abyssPrivate(signal, controller.signal, compact);
        const resolved = compact === undefined ? tasks : await compact.rows.resolve(keys, signal);
        this.assertMenuTargets_abyssPrivate(signal, controller.signal, compact);
        if (compact === undefined) this.assertExactMenuSnapshots_abyssPrivate(resolved);
        return resolved;
      },
    };
  }
  private assertMenuTargets_abyssPrivate(
    signal: AbortSignal,
    intent: AbortSignal,
    compact: TaskSurfaceState['search'],
  ): void {
    if (signal.aborted || intent.aborted) throw new TaskSearchError('aborted', 'Menu cancelled');
    if (compact !== undefined && this.taskSurface_abyssPrivate?.search !== compact)
      throw new TaskSearchError('stale', 'Menu changed');
  }
  private assertExactMenuSnapshots_abyssPrivate(tasks: readonly TaskSnapshot[]): void {
    for (const task of tasks) {
      const proof = this.queries_abyssPrivate.resolve(task.ref);
      if (proof.type !== 'exact' || !this.sameCardRef_abyssPrivate(proof.task.ref, task.ref))
        throw new TaskSearchError('stale', 'Task changed');
    }
  }

  private async resolveMenuCommit_abyssPrivate(
    targets: TaskMenuTargets,
    submit: (tasks: readonly TaskSnapshot[]) => void,
  ): Promise<void> {
    try {
      const tasks = await targets.resolve(targets.signal);
      if (!targets.signal.aborted) submit(tasks);
    } catch (error) {
      if (
        !targets.signal.aborted &&
        !(error instanceof TaskSearchError && (error.code === 'stale' || error.code === 'aborted'))
      )
        this.reportTaskRenderFailure_abyssPrivate(error);
    }
  }

  /** The selected tasks in display order, as the snapshots their cards were rendered from. */
  private selectedTasksInVisualOrder_abyssPrivate(): TaskSnapshot[] {
    const order = this.listOrder_abyssPrivate();
    const unique = new Map<string, TaskSnapshot>();
    for (const key of this.rowSelection_abyssPrivate.inOrder(order)) {
      const task = this.mountedSnapshot_abyssPrivate(key);
      if (task !== undefined) unique.set(taskRowKey(task), task);
    }
    return [...unique.values()];
  }

  private getFilteredTasks_abyssPrivate(): TaskSnapshot[] {
    const selection = this.state_abyssPrivate.get('selectedList');
    let query: { filePath: string } | { tag: string } | undefined;
    if (typeof selection === 'object') {
      if (selection.type === 'project') query = { filePath: selection.path };
    }
    const tasks = this.queries_abyssPrivate.list(query);
    const viewState = this.state_abyssPrivate.get('centerListViewState');
    this.outgoingLinks_abyssPrivate =
      viewState.groupBy === 'outgoing-link' || viewState.sortBy.field === 'outgoing-link'
        ? new Map(
            tasks.map((task) => [
              taskRowKey(task),
              outgoingTaskLinkValues(
                task,
                (target, sourcePath) =>
                  this.app_abyssPrivate.metadataCache.getFirstLinkpathDest(target, sourcePath)
                    ?.path,
              ),
            ]),
          )
        : new Map();
    return [
      ...selectTaskList({
        tasks,
        outgoingLinks: this.outgoingLinks_abyssPrivate,
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
    readonly tags: readonly string[];
    readonly groups: readonly EffectiveTagGroup[];
  } {
    const tags = this.tasks_abyssPrivate?.queries.observedTags() ?? [];
    return {
      tags,
      groups: resolveEffectiveTagGroups(this.settings_abyssPrivate, tags),
    };
  }

  private openTaskDatePicker_abyssPrivate(
    anchor: HTMLElement,
    tasks: readonly TaskSnapshot[],
    targets?: TaskMenuTargets,
  ): void {
    this.clearTaskDatePicker_abyssPrivate();
    const focusKey = this.taskDateTriggerKey_abyssPrivate(anchor);
    const openerRef =
      focusKey === undefined ? undefined : this.mountedSnapshot_abyssPrivate(focusKey)?.ref;
    const firstDue = tasks[0]?.planning.due;
    const initialValue =
      firstDue != null && tasks.every((task) => task.planning.due === firstDue)
        ? firstDue
        : undefined;
    const releasePin =
      focusKey === undefined || openerRef === undefined
        ? undefined
        : this.pinTaskInteraction_abyssPrivate(focusKey, openerRef, () => {
            this.abandonTaskDateFocus_abyssPrivate();
            this.clearTaskDatePicker_abyssPrivate(false);
          });
    const cleanup = showDatePickerPopover({
      owner: this.el,
      anchor,
      boundary: this.el,
      interactionOwnership: this.interactionOwnership_abyssPrivate,
      ...(initialValue !== undefined && { initialValue }),
      onPick: (inputValue, pick) => {
        // A pick made by leaving the picker arms no focus continuity: focus stays where it went.
        const commit = (snapshots: readonly TaskSnapshot[]): void => {
          this.pickTaskDate_abyssPrivate(
            snapshots,
            inputValue,
            pick.returnFocus ? focusKey : undefined,
          );
        };
        if (targets === undefined) commit(tasks);
        else
          void this.resolveMenuCommit_abyssPrivate(targets, commit).catch((error: unknown) => {
            this.reportTaskRenderFailure_abyssPrivate(error);
          });
      },
      onClose: () => {
        this.taskDatePickerCleanup_abyssPrivate = null;
        releasePin?.();
      },
      ...(focusKey !== undefined && {
        restoreFocus: () =>
          this.focusTaskDateTrigger_abyssPrivate(
            focusKey,
            openerRef === undefined ? [] : [openerRef],
            () => this.neutralCardFocus_abyssPrivate(anchor),
          ),
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
        const originalRef = this.mountedSnapshot_abyssPrivate(pendingFocus.key)?.ref;
        this.taskDateFocusRefs_abyssPrivate = originalRef === undefined ? [] : [originalRef];
      }
      const firstTask = tasks[0];
      if (firstTask === undefined) return;
      const onResult = (submitted: TaskSnapshot, result: TaskCommandResult): void => {
        if (pendingFocus === undefined || this.pendingTaskDateFocus_abyssPrivate !== pendingFocus)
          return;
        const originalRef = this.taskDateFocusRefs_abyssPrivate[0];
        if (originalRef === undefined || !this.sameCardRef_abyssPrivate(submitted.ref, originalRef))
          return;
        if (result.type === 'ok' && result.outcome.type === 'task')
          this.taskDateFocusRefs_abyssPrivate.push(result.outcome.task.ref);
        else this.clearTaskDateFocusContinuity_abyssPrivate(pendingFocus.key);
      };
      const update =
        tasks.length === 1
          ? this.taskCommands_abyssPrivate.setTaskDue(firstTask, value, onResult)
          : this.taskCommands_abyssPrivate.applyDueInOrder(tasks, value, onResult);
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

  private clearTaskDatePicker_abyssPrivate(restoreFocus = true): void {
    this.taskDatePickerCleanup_abyssPrivate?.(restoreFocus);
  }

  private taskDateTriggerKey_abyssPrivate(target: EventTarget | null): string | undefined {
    if (!this.isElementFromPanelRealm_abyssPrivate(target)) return undefined;
    const card = target.closest<HTMLElement>('.abyss-task-card');
    if (card == null || !this.el.contains(card)) return undefined;
    const filePath = card.dataset['filePath'];
    const line = card.dataset['line'];
    return (
      card.dataset['rowKey'] ??
      (filePath === undefined || line === undefined ? undefined : `${filePath}:${line}`)
    );
  }

  private isElementFromPanelRealm_abyssPrivate(target: EventTarget | null): target is Element {
    if (target == null || !('ownerDocument' in target)) return false;
    const ownerDocument = (target as { readonly ownerDocument?: Document }).ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    return ownerWindow != null && target instanceof ownerWindow.Element;
  }

  /** Returns focus to a card after its date picker in every mode, as the picker has no fallback. */
  private focusTaskDateTrigger_abyssPrivate(
    key: string,
    refs: readonly TaskRef[] = this.taskDateFocusRefs_abyssPrivate,
    ownsFocus: () => boolean = () => this.taskDateFocusContinuityKey_abyssPrivate === key,
  ): boolean {
    const valid = (): boolean => {
      const task = this.mountedSnapshot_abyssPrivate(key);
      return (
        ownsFocus() &&
        task !== undefined &&
        refs.some((ref) => this.sameCardRef_abyssPrivate(task.ref, ref))
      );
    };
    if (!valid()) return false;
    const card =
      this.taskSurface_abyssPrivate?.surface.reveal(key) ??
      this.mountedRows_abyssPrivate.element(key);
    if (!valid() || !this.connectedTaskCard_abyssPrivate(card)) return false;
    card.focus({ preventScroll: true });
    this.wholeCardFocus_abyssPrivate = null;
    if (this.taskSurface_abyssPrivate === null) this.scrollTaskCardIntoView_abyssPrivate(card);
    return true;
  }

  private completeTaskCardRender_abyssPrivate(): void {
    const focused = this.renderCardFocus_abyssPrivate;
    this.renderCardFocus_abyssPrivate = null;
    if (
      focused?.list === this.listViewControls_abyssPrivate.activeListKey() &&
      this.neutralCardFocus_abyssPrivate(focused.opener)
    ) {
      this.returnExactCard_abyssPrivate(
        focused.ref,
        focused.key,
        () =>
          focused.list === this.listViewControls_abyssPrivate.activeListKey() &&
          this.neutralCardFocus_abyssPrivate(focused.opener),
      );
    }
    this.finishCardReturn_abyssPrivate();
    this.taskCardRenderGeneration_abyssPrivate += 1;
    this.onRenderComplete_abyssPrivate(this.el);
    this.restoreTaskDateContinuity_abyssPrivate();
  }

  private restoreTaskDateContinuity_abyssPrivate(): void {
    const continuityKey = this.taskDateFocusContinuityKey_abyssPrivate;
    const restored =
      continuityKey !== null && this.focusTaskDateTrigger_abyssPrivate(continuityKey);
    if (
      continuityKey !== null &&
      !restored &&
      this.pendingTaskDateFocus_abyssPrivate?.changed !== false
    ) {
      this.clearTaskDateFocusContinuity_abyssPrivate(continuityKey);
      return;
    }
    const pending = this.pendingTaskDateFocus_abyssPrivate;
    if (pending?.changed === true) this.releaseSettledTaskDateFocus_abyssPrivate(pending, restored);
  }

  private releaseSettledTaskDateFocus_abyssPrivate(
    pending: NonNullable<CenterPanel['pendingTaskDateFocus_abyssPrivate']>,
    restored?: boolean,
  ): void {
    if (
      this.pendingTaskDateFocus_abyssPrivate !== pending ||
      !pending.changed ||
      this.taskCardRenderGeneration_abyssPrivate <= pending.armedRenderGeneration
    ) {
      return;
    }
    const didRestore =
      restored ??
      this.focusTaskDateTrigger_abyssPrivate(
        pending.key,
        this.taskDateFocusRefs_abyssPrivate,
        () =>
          this.pendingTaskDateFocus_abyssPrivate === pending &&
          this.taskDateFocusContinuityKey_abyssPrivate === pending.key,
      );
    this.pendingTaskDateFocus_abyssPrivate = null;
    if (!didRestore && this.taskDateFocusContinuityKey_abyssPrivate === pending.key) {
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
    this.taskDateFocusRefs_abyssPrivate = [];
  }

  /**
   * The order selection and the keyboard work in: all logical rows in Lists and Tags, none in
   * Search, a dashboard, or Calendar.
   */
  private listOrder_abyssPrivate(): TaskListRows<SurfaceTask> {
    return this.state_abyssPrivate.get('mode') === 'tasks'
      ? this.mountedRows_abyssPrivate.rows
      : NO_TASK_LIST_ROWS;
  }

  /** Focuses and scrolls to a listed card; a click in Search or a dashboard moves nothing. */
  private focusTaskKey_abyssPrivate(key: string): void {
    if (this.listOrder_abyssPrivate().indexOf(key) === -1) return;
    const card =
      this.taskSurface_abyssPrivate?.surface.reveal(key) ??
      this.mountedRows_abyssPrivate.element(key);
    if (card?.isConnected !== true) return;
    card.focus({ preventScroll: true });
    if (this.taskSurface_abyssPrivate === null) this.scrollTaskCardIntoView_abyssPrivate(card);
  }

  private scrollTaskCardIntoView_abyssPrivate(card: HTMLElement): void {
    const scrollHost = card as Partial<Pick<HTMLElement, 'scrollIntoView'>>;
    scrollHost.scrollIntoView?.({ block: 'nearest' });
  }

  private patchMountedSelection_abyssPrivate(): void {
    for (const [key, card] of this.mountedRows_abyssPrivate.cards()) {
      this.patchCardSelection_abyssPrivate(card, key, this.rowSelection_abyssPrivate.has(key));
    }
    this.updateTaskStackSelection_abyssPrivate();
  }

  private updateSelectionVisuals_abyssPrivate(): void {
    this.menuIntent_abyssPrivate.abort();
    this.patchMountedSelection_abyssPrivate();
    const live =
      this.el.querySelector<HTMLElement>('.abyss-selection-live') ??
      this.el.createDiv({
        cls: 'abyss-selection-live abyss-sr-only',
        attr: { 'aria-live': 'polite', 'aria-atomic': 'true' },
      });
    const order = this.listOrder_abyssPrivate();
    const count = new Set(
      this.rowSelection_abyssPrivate.inOrder(order).map((key) => order.physicalKey(key)),
    ).size;
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

  private openStatusMenu_abyssPrivate(event: MouseEvent, task: TaskSelectionNode): void {
    this.clearTaskDatePicker_abyssPrivate();
    this.dismissRecurrenceEditor_abyssPrivate();
    this.listViewControls_abyssPrivate.closeViewStatePopover();
    const key = this.eventTaskCardKey_abyssPrivate(event.target);
    const releasePin =
      key === undefined
        ? undefined
        : this.pinTaskInteraction_abyssPrivate(key, rootTaskRef(task), () => {
            handle.close();
          });
    const handle = showStatusMenuAt(event, {
      task,
      registry: this.statusRegistry_abyssPrivate,
      ...(this.taskSurface_abyssPrivate === null ? { owner: this.md_abyssPrivate } : {}),
      onClose: () => {
        releasePin?.();
      },
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
    const key = this.eventTaskCardKey_abyssPrivate(anchor);
    const releasePin =
      key === undefined
        ? undefined
        : this.pinTaskInteraction_abyssPrivate(key, task.ref, () => {
            const previous = this.renderingRecurrenceCleanup_abyssPrivate;
            this.renderingRecurrenceCleanup_abyssPrivate = true;
            try {
              lifecycle.handle?.destroy();
            } finally {
              this.renderingRecurrenceCleanup_abyssPrivate = previous;
            }
          });
    const handle = mountAnchoredRecurrenceEditor({
      anchor,
      source,
      policy: { removeScheduledDate: this.settings_abyssPrivate.recurrence.removeScheduledDate },
      ownershipConflict: hasOtherCalendarRecurrenceOwner(source),
      onSubmit: async (patch) => {
        const command = calendarPatchCommand(task, patch);
        if (this.tasks_abyssPrivate == null || command == null) {
          return Promise.resolve({
            type: 'io-error' as const,
            cause: 'application-unavailable',
            contentState: 'unchanged' as const,
          });
        }
        const record = this.armCardReturn_abyssPrivate(anchor, 'recurrence');
        if (record != null) {
          record.surface =
            anchor.ownerDocument.querySelector<HTMLElement>('.abyss-recurrence-popover') ??
            undefined;
          record.pending = true;
        }
        const result = await this.tasks_abyssPrivate.execute(command);
        if (record != null && this.cardReturn_abyssPrivate === record) {
          if (result.type === 'ok' && result.outcome.type === 'task')
            record.ref = result.outcome.task.ref;
          else this.clearCardReturn_abyssPrivate();
          record.pending = false;
          record.hidden = true;
          this.finishCardReturn_abyssPrivate();
        }
        return result;
      },
      onClose: () => {
        releasePin?.();
        if (this.recurrenceEditorCleanup_abyssPrivate === cleanup) {
          this.recurrenceEditorCleanup_abyssPrivate = null;
          if (
            !this.renderingRecurrenceCleanup_abyssPrivate &&
            this.cardReturn_abyssPrivate?.kind === 'recurrence'
          )
            this.clearCardReturn_abyssPrivate();
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
    if (
      !this.renderingRecurrenceCleanup_abyssPrivate &&
      this.cardReturn_abyssPrivate?.kind === 'recurrence'
    )
      this.clearCardReturn_abyssPrivate();
    const cleanup = this.recurrenceEditorCleanup_abyssPrivate;
    this.recurrenceEditorCleanup_abyssPrivate = null;
    cleanup?.();
  }
}
