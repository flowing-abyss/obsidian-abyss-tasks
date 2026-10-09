import { Component, Notice, type App, type Menu } from 'obsidian';
import type { AppState, ListSelection } from '../app/AppState';
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
import { selectTaskNodes } from '../task-lists/TaskListSelector';
import { outgoingTaskLinkValues, type TaskLinkValues } from '../task-lists/taskLinkValues';
import type { TaskOccurrencePresentation } from '../task-lists/taskOccurrencePresentation';
import type {
  TaskSearchOccurrence,
  TaskSearchOrganization,
} from '../task-lists/taskSearchOrganization';
import type { TaskStatisticsSource } from '../tasks';
import {
  localDate,
  rootTaskNodeSnapshot,
  sameTaskNodeRef,
  taskNodeSourceLine,
  taskReconciliationKey,
  taskSearchAddressKey,
  TaskSearchError,
  taskTodayOccurrence,
  taskTreeNodes,
  type CommentTimeContextProvider,
  type LocalDate,
  type TaskApplicationApi,
  type TaskCaptureApplicationApi,
  type TaskCommandResult,
  type TaskNodeRef,
  type TaskNodeSnapshot,
  type TaskOccurrenceCompletion,
  type TaskQueryApi,
  type TaskRef,
  type TaskSearchAddress,
  type TaskSearchApi,
  type TaskSearchState,
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
import type { CaptureRevealAuthority } from '../ui/taskCapture/CaptureRevealIntent';
import { type CreationResultDescription } from '../ui/taskCommandResult';
import type { TaskDependencyLookup } from '../ui/taskDependencyPresentation';
import type { TaskListDraftHandoff } from '../ui/taskDraftContinuity';
import { bindTaskHierarchyDrop, executeTaskHierarchy } from '../ui/taskHierarchyActions';
import { startTaskNodeDrag } from '../ui/taskNodeDrag';
import { renderedTaskElements, renderedTaskNodeElements } from '../ui/taskPresentationIdentity';
import type { TaskRenderOutcome, TaskRenderScope } from '../ui/taskRenderScope';
import {
  rootTaskRef,
  taskNodeRef,
  taskSelectionRefPath,
  type TaskSelectionNode,
} from '../ui/taskSelection';
import type { TrackingSurface } from '../ui/timeTracking/TimeBadge';
import { deviceTrackedTimeContext } from '../ui/timeTracking/TimeBadge';
import {
  calendarMutationTarget,
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
import {
  commandNode,
  commandPatch,
  commandSource,
  commandTarget,
  TaskCommands,
  type TaskCommandSubject,
} from './center/TaskCommands';
import {
  navigateTaskListTarget,
  resolveTaskListRef,
  type ResolvedTaskListTarget,
  type TaskListNavigationRequest,
} from './center/TaskListNavigation';
import { TaskMenus, type TaskMenuTargets } from './center/TaskMenus';
import { TaskSearch, type TaskSearchOptions, type TaskSearchRowOptions } from './center/TaskSearch';
import { TaskSearchReveal, type TaskListInclusion } from './center/TaskSearchReveal';
import { taskSearchDestination } from './center/taskSearchDestination';
import { mountTaskSearchKeyboardActivation } from './center/taskSearchKeyboardActivation';
import { ProjectsPanel } from './projects/ProjectsPanel';
import { StatisticsMode } from './statistics/StatisticsMode';
import { TanStackStatisticsChart } from './statistics/TanStackStatisticsChart';
import { TaskListSurface, type TaskRowMount } from './task-list/TaskListSurface';
import { TaskSearchRows, type TaskSearchRowsIdentity } from './task-list/TaskSearchRows';
import {
  mountGroupHeader,
  mountTaskListRow,
  NO_MOUNTED_TASK_LIST_ROWS,
  type MountedTaskListRows,
} from './task-list/taskListRowView';
import {
  buildTaskNodeListRows,
  indexedRows,
  NO_TASK_LIST_ROWS,
  taskListGrouping,
  taskRowKey,
  taskStackRowKey,
  type TaskListRow,
  type TaskListRows,
} from './task-list/taskListRows';
import { TaskRowSelection } from './task-list/taskRowSelection';

type SurfaceTask = TaskNodeSnapshot | TaskSearchOccurrence;
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
interface CreationAttempt {
  readonly retained: TaskSurfaceState;
  readonly ref: TaskRef;
  readonly request: CreationRevealRequest;
  readonly scroll: RevealLifetime;
  readonly isCurrent: () => boolean;
}
interface CreationRowAttempt extends CreationAttempt {
  readonly key: string;
}

interface ListActivation extends TaskListNavigationRequest {
  readonly source: { generation?: number; observed?: TaskSearchState };
  readonly cancel: () => void;
}
interface RevealLifetime extends TaskListNavigationRequest {
  readonly cancel: () => void;
}

interface CreationInclusion {
  readonly inclusion: TaskListInclusion;
  readonly task: TaskSnapshot;
  accepted: boolean;
  element?: HTMLElement;
  publish(): void;
  readonly cancel: () => void;
}

interface CenterPanelOptions {
  readonly statisticsSource?: TaskStatisticsSource | undefined;
  readonly onTaskListDraftHandoff?: TaskListDraftHandoff | undefined;
  readonly state: AppState;
  readonly app: App;
  readonly settings: CalendarSettings;
  readonly queries: TaskQueryApi & Partial<Pick<TaskApplicationApi['queries'], 'listNodes'>>;
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
  private readonly onTaskListDraftHandoff_abyssPrivate: TaskListDraftHandoff | undefined;
  private el!: HTMLElement;
  private readonly statistics_abyssPrivate: StatisticsMode | undefined;
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
  private selectionRows_abyssPrivate: TaskListRows<SurfaceTask> = NO_TASK_LIST_ROWS;
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
  private readonly ordinaryCards_abyssPrivate = new Map<string, TaskCardMount>();
  private readonly mountedSnapshots_abyssPrivate = new Map<string, TaskNodeSnapshot>();
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
  private cancelListActivation_abyssPrivate: (() => void) | undefined;
  private revealId_abyssPrivate = 0;
  private creationInclusion_abyssPrivate: CreationInclusion | undefined;
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
  private readonly queries_abyssPrivate: CenterPanelOptions['queries'];
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
    this.onTaskListDraftHandoff_abyssPrivate = options.onTaskListDraftHandoff;
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
      selectedSnapshots: () =>
        [...this.selectionCandidates_abyssPrivate(this.selectionRows_abyssPrivate).values()].filter(
          (task): task is TaskNodeSnapshot => 'root' in task,
        ),
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
    [this.statistics_abyssPrivate, this.calendar_abyssPrivate] =
      this.createRetainedModes_abyssPrivate(options);
  }

  private createRetainedModes_abyssPrivate(
    options: CenterPanelOptions,
  ): readonly [StatisticsMode | undefined, CalendarMode] {
    const { state, app, settings, queries, tasks, statusRegistry } = options;
    return [
      this.createStatistics_abyssPrivate(options),
      new CalendarMode({
        state,
        app,
        settings,
        queries,
        tasks,
        statusRegistry,
        interactionOwnership: this.interactionOwnership_abyssPrivate,
        navigation: this.navigation_abyssPrivate,
        host: this.createCalendarHost_abyssPrivate(),
      }),
    ];
  }

  private createStatistics_abyssPrivate(options: CenterPanelOptions): StatisticsMode | undefined {
    const {
      state,
      app,
      settings,
      queries,
      projectStore,
      timeTracking,
      onRenderTaskHeaderActions,
      onRenderComplete = () => {},
    } = options;
    let statisticsGroups: readonly EffectiveTagGroup[] = [];
    return options.statisticsSource === undefined
      ? undefined
      : new StatisticsMode({
          state,
          app,
          settings,
          source: options.statisticsSource,
          queries,
          projects: projectStore ?? {
            list: () => [],
            onUpdate: () => () => {},
            whenSettled: async () => {},
          },
          renderer: new TanStackStatisticsChart(),
          context: timeTracking?.context ?? deviceTrackedTimeContext,
          ticker: timeTracking?.ticker,
          host: {
            renderComplete: () => {
              onRenderComplete(this.el);
            },
            header: onRenderTaskHeaderActions,
            beginEvidence: () => {
              this.beginTaskCardRender_abyssPrivate();
              this.md_abyssPrivate.unload();
              this.md_abyssPrivate = new Component();
              this.md_abyssPrivate.load();
              statisticsGroups = this.effectiveTagGroups_abyssPrivate();
            },
            renderRoot: (host, root) => {
              this.taskCardRenderer_abyssPrivate.render(host, root, statisticsGroups, {
                selected: taskStackRowKey(state.get('taskStack')) === taskRowKey(root),
                showDelete: false,
                rowKey: taskRowKey(root),
              });
            },
            select: (stack) => {
              state.set('taskStack', stack);
            },
            openSource: async (path, line) => {
              await app.workspace.openLinkText(path, '', false, { eState: { line } });
            },
          },
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
          if (this.state_abyssPrivate.get('mode') === 'statistics')
            this.navigation_abyssPrivate.openTasks();
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
        showTaskInList: (target, request) => this.showTaskInList(target, request),
        mountInteractions: (card, task, rowKey, context) => {
          this.mountTaskCardInteractions_abyssPrivate(card, task, rowKey, context);
        },
        reportFailure: (error) => {
          this.reportTaskRenderFailure_abyssPrivate(error);
        },
        openStatusMenu: (event, task, completion) => {
          this.openStatusMenu_abyssPrivate(event, task, completion);
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
        destination: (root) => this.taskListDestination_abyssPrivate(root),
        installReveal: (receipt) => {
          this.taskSearchReveal_abyssPrivate.install({
            ...receipt,
            id: ++this.revealId_abyssPrivate,
          });
        },
        currentReveal: () => this.taskSearchReveal_abyssPrivate.current(),
        currentInclusion: () => this.creationInclusion_abyssPrivate?.inclusion,
        expireReveal: () => {
          this.clearCreationInclusion_abyssPrivate();
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

  private taskListDestination_abyssPrivate(root: TaskSnapshot): ListSelection {
    return taskSearchDestination({
      root,
      today: localDate(moment().format('YYYY-MM-DD')),
      settings: this.settings_abyssPrivate,
      projectPaths: new Set(
        this.projectStore_abyssPrivate?.list().map((project) => project.path) ?? [],
      ),
      configuredTags: this.searchDestinationTags_abyssPrivate(),
    });
  }

  async showTaskInList(target: TaskNodeRef, request: TaskListNavigationRequest): Promise<void> {
    this.cancelListActivation_abyssPrivate?.();
    const search = this.searchApi_abyssPrivate;
    const reads = this.tasks_abyssPrivate?.queries;
    if (search === undefined || reads === undefined)
      throw new TaskSearchError('unavailable', 'Task search unavailable');
    const activation = this.createListActivation_abyssPrivate(search, request);
    const { source, cancel, isCurrent: current } = activation;
    try {
      await this.prepareListActivation_abyssPrivate(search, activation);
      const navigationRequest = activation;
      const resolved = await resolveTaskListRef({
        reads,
        search,
        target,
        generation: source.generation ?? 0,
        request: navigationRequest,
      });
      if (resolved === undefined || !current()) {
        cancel();
        return;
      }
      await navigateTaskListTarget(
        { type: 'resolved', target: resolved },
        {
          search,
          state: this.state_abyssPrivate,
          navigation: this.navigation_abyssPrivate,
          request: navigationRequest,
          destination: (root) => this.taskListDestination_abyssPrivate(root),
          installReveal: (address, selection) => {
            this.taskSearchReveal_abyssPrivate.install({
              id: ++this.revealId_abyssPrivate,
              address,
              selection,
            });
          },
          onCommitted: cancel,
          afterCommit: () => request.onCommitted?.(resolved.root, resolved.path),
        },
      );
    } catch (error) {
      if (current()) this.reportListActivationFailure_abyssPrivate(error);
      cancel();
    }
  }

  private async prepareListActivation_abyssPrivate(
    search: TaskSearchApi,
    activation: ListActivation,
  ): Promise<void> {
    await search.prepare(activation.signal);
    if (!activation.isCurrent()) throw new TaskSearchError('aborted', 'Navigation cancelled');
    if (activation.source.observed?.phase !== 'ready')
      throw new TaskSearchError('unavailable', 'Task search unavailable');
    activation.source.generation = activation.source.observed.generation;
  }

  private reportListActivationFailure_abyssPrivate(error: unknown): void {
    if (error instanceof TaskSearchError && error.code === 'aborted') return;
    if (error instanceof TaskSearchError && error.code === 'stale') {
      new Notice('Task changed. Show it in the task list again.');
      return;
    }
    console.error('[abyss-tasks] task list navigation failed', {
      phase: 'resolution',
      category: error instanceof Error ? error.name : typeof error,
    });
    new Notice('Could not show task in task list');
  }

  private createListActivation_abyssPrivate(
    search: TaskSearchApi,
    request: TaskListNavigationRequest,
  ): ListActivation {
    const controller = new AbortController();
    const intent = this.state_abyssPrivate.taskSelectionIntentGeneration;
    const window = this.el.ownerDocument.defaultView;
    const source: { generation?: number; observed?: TaskSearchState } = {};
    const current = (): boolean =>
      !controller.signal.aborted &&
      !request.signal.aborted &&
      request.isCurrent() &&
      this.el.isConnected &&
      this.el.ownerDocument.defaultView === window &&
      this.state_abyssPrivate.taskSelectionIntentGeneration === intent;
    let offSource = (): void => {};
    let offState = (): void => {};
    const cancel = (): void => {
      controller.abort();
      offSource();
      offState();
      request.signal.removeEventListener('abort', cancel);
      if (this.cancelListActivation_abyssPrivate === cancel)
        this.cancelListActivation_abyssPrivate = undefined;
    };
    this.cancelListActivation_abyssPrivate = cancel;
    request.signal.addEventListener('abort', cancel, { once: true });
    offState = this.state_abyssPrivate.onCommit(() => {
      if (!current()) cancel();
    });
    offSource = search.subscribe((state) => {
      source.observed = state;
      if (
        source.generation !== undefined &&
        (state.generation !== source.generation || state.phase !== 'ready')
      ) {
        if (current()) new Notice('Task changed. Show it in the task list again.');
        cancel();
      }
    });
    return { source, cancel, signal: controller.signal, isCurrent: current };
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
      const ready = await this.prepareTaskReveal_abyssPrivate(retained, key, {
        signal: controller.signal,
        isCurrent: current,
      });
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

  private async prepareTaskReveal_abyssPrivate(
    retained: TaskSurfaceState,
    key: string,
    request: TaskListNavigationRequest,
    options: { readonly expectedRef?: TaskRef; readonly scroll?: RevealLifetime } = {},
  ): Promise<{ task: TaskSnapshot; card: HTMLElement } | undefined> {
    const { expectedRef, scroll } = options;
    const lifetime = this.createRevealLifetime_abyssPrivate(retained, key, request, scroll);
    const current = lifetime.isCurrent;
    try {
      const task = await this.snapshotForKey_abyssPrivate(key, lifetime.signal);
      if (
        !current() ||
        task === undefined ||
        (expectedRef !== undefined && !this.sameCardRef_abyssPrivate(task.root.ref, expectedRef))
      )
        return undefined;
      return await this.settleTaskDestination_abyssPrivate(retained, key, task, lifetime);
    } finally {
      lifetime.cancel();
    }
  }

  private createRevealLifetime_abyssPrivate(
    retained: TaskSurfaceState,
    key: string,
    request: TaskListNavigationRequest,
    sharedScroll?: RevealLifetime,
  ): RevealLifetime {
    const compact = retained.search;
    const intent = this.state_abyssPrivate.taskSelectionIntentGeneration;
    const controller = new AbortController();
    const current = (): boolean =>
      !controller.signal.aborted &&
      !request.signal.aborted &&
      request.isCurrent() &&
      retained.search === compact &&
      retained.options.isCurrent?.() !== false &&
      intent === this.state_abyssPrivate.taskSelectionIntentGeneration;
    const scroll =
      sharedScroll ??
      this.createScrollLifetime_abyssPrivate(retained, {
        signal: controller.signal,
        isCurrent: current,
      });
    const abort = (): void => {
      controller.abort();
    };
    const release = retained.surface.pin(key, abort);
    const signals = [request.signal, scroll.signal, compact?.identity.signal];
    for (const signal of signals) signal?.addEventListener('abort', abort, { once: true });
    controller.signal.addEventListener(
      'abort',
      () => {
        release();
        for (const signal of signals) signal?.removeEventListener('abort', abort);
        if (sharedScroll === undefined) scroll.cancel();
      },
      { once: true },
    );
    if (signals.some((signal) => signal?.aborted === true)) abort();
    return {
      signal: controller.signal,
      isCurrent: () => {
        if (!current() || !scroll.isCurrent()) abort();
        return !controller.signal.aborted;
      },
      cancel: abort,
    };
  }

  private createScrollLifetime_abyssPrivate(
    retained: TaskSurfaceState,
    request: CreationRevealRequest,
  ): RevealLifetime {
    const controller = new AbortController();
    const abort = (): void => {
      controller.abort();
    };
    const window = retained.host.ownerDocument.defaultView;
    const current = (): boolean =>
      !controller.signal.aborted &&
      !request.signal.aborted &&
      request.isCurrent() &&
      retained === this.taskSurface_abyssPrivate &&
      retained.host.ownerDocument.defaultView === window &&
      this.creationHostVisible_abyssPrivate(retained.host);
    const scroll =
      retained.host.closest<HTMLElement>('.abyss-project-dashboard-session') ?? retained.host;
    let expectedTop = scroll.scrollTop;
    const beforeWrite = (top: number): boolean => {
      if (!current() || top !== expectedTop) abort();
      return !controller.signal.aborted;
    };
    const onScroll = (): void => {
      beforeWrite(scroll.scrollTop);
    };
    const observer = {
      beforeWrite,
      afterWrite: (top: number) => {
        expectedTop = top;
      },
    };
    const release = retained.surface.observeNativeWrites(observer, abort);
    const document = retained.host.ownerDocument;
    const checkVisibility = (): void => {
      if (!current()) abort();
    };
    const visibilityObserver =
      window === null ? undefined : new window.ResizeObserver(checkVisibility);
    visibilityObserver?.observe(retained.host);
    document.addEventListener('visibilitychange', checkVisibility);
    request.signal.addEventListener('abort', abort, { once: true });
    scroll.addEventListener('scroll', onScroll, { passive: true });
    const off = this.state_abyssPrivate.onCommit(() => {
      if (!current()) abort();
    });
    this.creationAttempts_abyssPrivate.add(abort);
    const dispose = (): void => {
      off();
      release();
      visibilityObserver?.disconnect();
      document.removeEventListener('visibilitychange', checkVisibility);
      this.creationAttempts_abyssPrivate.delete(abort);
      scroll.removeEventListener('scroll', onScroll);
      request.signal.removeEventListener('abort', abort);
    };
    controller.signal.addEventListener('abort', dispose, { once: true });
    return {
      signal: controller.signal,
      isCurrent: () => beforeWrite(scroll.scrollTop),
      cancel: abort,
    };
  }

  private revealReceipts_abyssPrivate(): Array<Promise<TaskRenderOutcome>> {
    return [...this.ordinaryCards_abyssPrivate.values()].map((card) => card.settled);
  }

  private async settleRevealRows_abyssPrivate(
    retained: TaskSurfaceState,
    key: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const rows = retained.search?.rows;
    const receipts =
      rows === undefined
        ? this.revealReceipts_abyssPrivate()
        : [rows.settleRow(key, signal), rows.settleMounted(signal)];
    let release = (): void => {};
    const cancelled = new Promise<TaskRenderOutcome[]>((resolve) => {
      const abort = (): void => {
        resolve([{ type: 'cancelled' }]);
      };
      signal.addEventListener('abort', abort, { once: true });
      release = () => {
        signal.removeEventListener('abort', abort);
      };
      if (signal.aborted) abort();
    });
    try {
      const outcomes = await Promise.race([Promise.all(receipts), cancelled]);
      for (const outcome of outcomes) {
        if (outcome.type === 'failed') throw outcome.error;
        if (outcome.type !== 'ready') return false;
      }
      return true;
    } finally {
      release();
    }
  }

  private async settleTaskDestination_abyssPrivate(
    retained: TaskSurfaceState,
    key: string,
    task: TaskNodeSnapshot,
    lifetime: TaskListNavigationRequest,
  ): Promise<{ task: TaskSnapshot; card: HTMLElement } | undefined> {
    for (let round = 0; round < 8 && lifetime.isCurrent(); round++) {
      const outcome = await this.settleDestinationRound_abyssPrivate(retained, key, lifetime);
      if (outcome.type === 'cancelled') return undefined;
      if (outcome.type === 'changed') continue;
      const card = outcome.card;
      const mounted = this.mountedProjection_abyssPrivate(key);
      if (mounted === undefined || !sameTaskNodeRef(task.target, mounted.target)) return undefined;
      return { task: task.root, card };
    }
    if (lifetime.isCurrent()) throw new Error('Task destination receipts did not converge');
    return undefined;
  }

  private async settleDestinationRound_abyssPrivate(
    retained: TaskSurfaceState,
    key: string,
    lifetime: TaskListNavigationRequest,
  ): Promise<{ type: 'cancelled' } | { type: 'changed' } | { type: 'ready'; card: HTMLElement }> {
    const rows = retained.search?.rows;
    if (!(await this.settleRevealRows_abyssPrivate(retained, key, lifetime.signal)))
      return { type: 'cancelled' };
    if (!lifetime.isCurrent()) return { type: 'cancelled' };
    const revision = rows?.receiptRevision;
    const receipts = this.revealReceipts_abyssPrivate();
    const card = retained.surface.reveal(key, { waitForReady: true });
    if (!lifetime.isCurrent() || card === undefined) return { type: 'cancelled' };
    if (!(await this.settleRevealRows_abyssPrivate(retained, key, lifetime.signal)))
      return { type: 'cancelled' };
    if (!lifetime.isCurrent()) return { type: 'cancelled' };
    const changed = this.revealReceiptsChanged_abyssPrivate(rows, revision, receipts);
    return this.destinationRoundOutcome_abyssPrivate(card, changed);
  }

  private destinationRoundOutcome_abyssPrivate(
    card: HTMLElement | 'pending',
    changed: boolean,
  ): { type: 'cancelled' } | { type: 'changed' } | { type: 'ready'; card: HTMLElement } {
    if (changed) return { type: 'changed' };
    return card === 'pending' ? { type: 'cancelled' } : { type: 'ready', card };
  }

  private revealReceiptsChanged_abyssPrivate(
    rows: TaskSearchRows | undefined,
    revision: number | undefined,
    receipts: Array<Promise<TaskRenderOutcome>>,
  ): boolean {
    return rows === undefined
      ? !this.sameRevealReceipts_abyssPrivate(receipts)
      : revision !== rows.receiptRevision;
  }

  private sameRevealReceipts_abyssPrivate(receipts: Array<Promise<TaskRenderOutcome>>): boolean {
    const current = this.revealReceipts_abyssPrivate();
    return (
      receipts.length === current.length &&
      receipts.every((receipt, index) => current[index] === receipt)
    );
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
    this.taskCommands_abyssPrivate.retireSelectionEvidence();
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

    retained.tagGroups = this.effectiveTagGroups_abyssPrivate();
    retained.options = {
      signal: options.identity.signal,
      isCurrent: options.isCurrent,
      reportFailure: options.reportFailure,
    };
    this.compactPresentation_abyssPrivate = options;
    const order = compact.rows.set(organization, options.groupBy, options.identity);
    this.reconcileCompactSelection_abyssPrivate(order, organization.generation);
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
        indexedHeights: { group: 32, task: 64 },
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
    this.updateSelectionVisuals_abyssPrivate();
    this.creationInclusion_abyssPrivate?.publish();
    return compact.rows.settleMounted(options.identity.signal);
  }

  private reconcileCompactSelection_abyssPrivate(
    next: TaskListRows<TaskSearchOccurrence>,
    generation: number,
  ): void {
    const physicalKeys = new Map<string, string>();
    const candidates = this.selectionCandidates_abyssPrivate(this.selectionRows_abyssPrivate);
    for (const [key, before] of candidates) {
      if (!('address' in before)) continue;
      const occurrence = next.firstOccurrenceOf(key);
      const after = occurrence === undefined ? undefined : next.task(occurrence);
      if (
        after !== undefined &&
        taskSearchAddressKey(before.address) === taskSearchAddressKey(after.address)
      )
        physicalKeys.set(key, key);
    }
    this.taskCommands_abyssPrivate.archiveSelectionRebase(
      (task) => {
        const key = taskRowKey(task);
        const occurrence = next.firstOccurrenceOf(key);
        const after = occurrence === undefined ? undefined : next.task(occurrence);
        return after !== undefined &&
          this.tasks_abyssPrivate?.queries.matchesSearchAddress(
            after.address,
            { type: 'task', ref: task.ref },
            generation,
          ) === true
          ? key
          : undefined;
      },
      (proof) => {
        for (const [before, after] of proof) physicalKeys.set(before, after);
        this.taskCommands_abyssPrivate.ownedSelectionRebase(
          (task) => {
            const key = `${task.root.source.filePath}:${taskNodeSourceLine(task.target)}`;
            const occurrence = next.firstOccurrenceOf(key);
            const after = occurrence === undefined ? undefined : next.task(occurrence);
            return after !== undefined &&
              this.tasks_abyssPrivate?.queries.matchesSearchAddress(
                after.address,
                task.target,
                generation,
              ) === true
              ? key
              : undefined;
          },
          (owned) => {
            for (const [before, after] of owned) physicalKeys.set(before, after);
            this.rowSelection_abyssPrivate.bind(next, { physicalKeys });
          },
        );
      },
    );
    this.selectionRows_abyssPrivate = next;
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
      ...(this.state_abyssPrivate.get('mode') === 'tasks' && {
        onDateCapture: (date) => {
          this.captureSessions_abyssPrivate.openDateCapture(date);
        },
      }),
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
          task.root,
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
        if (row.kind === 'task' && 'root' in row.task) throw new Error('Expected compact row');
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
    return 'root' in task ? task.root.ref.revision : String(task.address.version);
  }
  private rowMeasurementIdentity_abyssPrivate(
    task: SurfaceTask,
    semanticsRevision?: number,
  ): unknown {
    return 'root' in task ? task.target : [task.address, semanticsRevision];
  }
  private compactCardOptions_abyssPrivate(
    task: TaskNodeSnapshot,
    occurrence: TaskSearchOccurrence,
  ): Parameters<TaskCardMount['update']>[2] {
    const options = this.compactPresentation_abyssPrivate;
    return {
      ...this.taskCardOptions_abyssPrivate(task, occurrence.key),
      projection: task,
      occurrence: occurrence.presentation,
      selected: taskStackRowKey(this.state_abyssPrivate.get('taskStack')) === occurrence.taskKey,
      search: options?.presentation?.(task.root, occurrence.address),
      highlight: options?.highlight,
      onActivate:
        options?.onActivate === undefined
          ? undefined
          : () => options.onActivate?.(occurrence.address),
    };
  }
  private mountCompactCard_abyssPrivate(
    element: HTMLElement,
    task: TaskNodeSnapshot,
    occurrence: TaskSearchOccurrence,
  ): TaskCardMount {
    const card = this.taskCardRenderer_abyssPrivate.mountInto(
      element,
      task.root,
      this.taskSurface_abyssPrivate?.tagGroups ?? [],
      this.compactCardOptions_abyssPrivate(task, occurrence),
    );
    this.mountedSnapshots_abyssPrivate.set(occurrence.key, task);
    this.observeTaskCardReceipt_abyssPrivate(card);
    return card;
  }
  private mountedProjection_abyssPrivate(key: string): TaskNodeSnapshot | undefined {
    if (this.taskSurface_abyssPrivate?.search !== undefined)
      return this.mountedSnapshots_abyssPrivate.get(key);
    const task = this.mountedRows_abyssPrivate.rows.task(key);
    return task !== undefined && 'root' in task ? task : undefined;
  }
  private mountedSnapshot_abyssPrivate(key: string): TaskSnapshot | undefined {
    if (this.taskSurface_abyssPrivate?.search !== undefined)
      return this.mountedSnapshots_abyssPrivate.get(key)?.root;
    const task = this.mountedRows_abyssPrivate.rows.task(key);
    return task !== undefined && 'root' in task ? task.root : undefined;
  }
  private invalidateCompactInteractions_abyssPrivate(
    previous: TaskListRows<TaskSearchOccurrence>,
    next: TaskListRows<TaskSearchOccurrence>,
  ): void {
    const same = (key: string): boolean => {
      const a = previous.task(key)?.address,
        b = next.task(key)?.address;
      return (
        a !== undefined && b !== undefined && taskSearchAddressKey(a) === taskSearchAddressKey(b)
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

  /** Selection permission survives blur, but not a later selection or list context change. */
  captureCreationSelection(): () => boolean {
    const selection = this.state_abyssPrivate.taskSelectionIntentGeneration;
    const context = this.captureContextRevision_abyssPrivate;
    return () =>
      selection === this.state_abyssPrivate.taskSelectionIntentGeneration &&
      context === this.captureContextRevision_abyssPrivate;
  }

  private captureRevealAuthority_abyssPrivate(ownsCapture: () => boolean): CaptureRevealAuthority {
    const retained = this.taskSurface_abyssPrivate;
    const context = this.captureContextRevision_abyssPrivate;
    const document = retained?.host.ownerDocument;
    const owner = document?.defaultView;
    const ownsOrigin = (): boolean =>
      retained !== null &&
      retained === this.taskSurface_abyssPrivate &&
      context === this.captureContextRevision_abyssPrivate &&
      retained.host.ownerDocument === document &&
      document.defaultView === owner &&
      this.creationHostVisible_abyssPrivate(retained.host) &&
      ownsCapture();
    return {
      forSubmission: (submission) => {
        const canSelect = this.captureCreationSelection();
        let revealSelection: number | undefined;
        const lifetime =
          retained === null
            ? undefined
            : this.createScrollLifetime_abyssPrivate(retained, {
                signal: submission.signal,
                isCurrent: () =>
                  ownsOrigin() &&
                  submission.isCurrent() &&
                  (revealSelection === undefined ||
                    revealSelection === this.state_abyssPrivate.taskSelectionIntentGeneration),
              });
        let accepted = false;
        const isCurrent = (): boolean =>
          ownsOrigin() && (accepted || lifetime?.isCurrent() === true);
        return {
          canSelect,
          isCurrent,
          onPresented: (ref, element) => {
            accepted = true;
            const pending = this.creationInclusion_abyssPrivate;
            if (
              pending?.element === element &&
              this.sameCardRef_abyssPrivate(pending.task.ref, ref)
            )
              pending.accepted = true;
          },
          reveal: (ref, request) => {
            const intent = this.state_abyssPrivate.taskSelectionIntentGeneration;
            revealSelection = intent;
            const current = (): boolean =>
              isCurrent() &&
              request.isCurrent() &&
              !request.signal.aborted &&
              intent === this.state_abyssPrivate.taskSelectionIntentGeneration;
            if (!current() || retained === null || lifetime === undefined) return undefined;
            return this.revealCreatedTask_abyssPrivate({
              retained,
              ref,
              request,
              isCurrent: current,
              scroll: lifetime,
            });
          },
        };
      },
    };
  }

  private revealCreatedTask_abyssPrivate(
    attempt: CreationAttempt,
  ): Promise<HTMLElement | undefined> | undefined {
    const { retained, ref, isCurrent: current } = attempt;
    const previous = this.creationInclusion_abyssPrivate;
    if (previous !== undefined && !this.sameCardRef_abyssPrivate(previous.task.ref, ref)) {
      this.clearCreationInclusion_abyssPrivate();
      if (retained.search !== undefined) this.taskSearch_abyssPrivate.refresh();
      else this.render_abyssPrivate();
      return undefined;
    }
    const order = retained.search?.order ?? retained.surface.rows;
    const key = order.firstOccurrenceOf(`${ref.filePath}:${ref.line}`);
    const result =
      key === undefined
        ? this.includeCreatedTask_abyssPrivate(attempt)
        : this.revealSnapshotCreation_abyssPrivate({ ...attempt, key });
    return result.catch((error: unknown) => {
      if (current()) this.reportCaptureRevealFailure_abyssPrivate(retained, error);
      return undefined;
    });
  }

  /** Retains only the live task surface that the capture actually opened from. */
  captureCreationReveal(isCaptureCurrent: () => boolean): CaptureRevealAuthority | undefined {
    const retained = this.taskSurface_abyssPrivate;
    if (
      retained === null ||
      !this.el.contains(retained.host) ||
      !this.creationHostVisible_abyssPrivate(retained.host)
    )
      return undefined;
    return this.captureRevealAuthority_abyssPrivate(isCaptureCurrent);
  }

  private reportCaptureRevealFailure_abyssPrivate(
    retained: TaskSurfaceState,
    error: unknown,
  ): void {
    if (error instanceof TaskSearchError && (error.code === 'aborted' || error.code === 'stale'))
      return;
    if (retained.options.reportFailure !== undefined) retained.options.reportFailure(error);
    else this.reportTaskRenderFailure_abyssPrivate(error);
  }

  private clearCreationInclusion_abyssPrivate(): void {
    const previous = this.creationInclusion_abyssPrivate;
    this.creationInclusion_abyssPrivate = undefined;
    previous?.cancel();
  }

  private async includeCreatedTask_abyssPrivate(
    attempt: CreationAttempt,
  ): Promise<HTMLElement | undefined> {
    const { retained, ref, request, isCurrent: current, scroll } = attempt;
    this.clearCreationInclusion_abyssPrivate();
    const resolved = await this.resolveCreationInclusion_abyssPrivate(
      retained,
      ref,
      request,
      current,
    );
    if (!current() || resolved === undefined) return undefined;
    const { inclusion, published, aborted } = this.installCreationInclusion_abyssPrivate(
      retained,
      resolved.root,
      resolved.address,
      request,
    );
    if (retained.search !== undefined) {
      this.taskSearch_abyssPrivate.refresh();
      await published;
    } else this.mountCreationInclusion_abyssPrivate(retained, resolved.root);
    if (!current() || this.creationInclusion_abyssPrivate !== inclusion) {
      aborted();
      return undefined;
    }
    const key = (retained.search?.order ?? retained.surface.rows).firstOccurrenceOf(
      taskRowKey(resolved.root),
    );
    if (key === undefined) return undefined;
    const ready = await this.prepareTaskReveal_abyssPrivate(
      retained,
      key,
      { signal: request.signal, isCurrent: current },
      { expectedRef: ref, scroll },
    );
    return this.recordCreationElement_abyssPrivate(inclusion, ready?.card);
  }

  private async resolveCreationInclusion_abyssPrivate(
    retained: TaskSurfaceState,
    ref: TaskRef,
    request: CreationRevealRequest,
    current: () => boolean,
  ): Promise<ResolvedTaskListTarget | undefined> {
    const search = this.searchApi_abyssPrivate;
    const reads = this.tasks_abyssPrivate?.queries;
    if (search === undefined || reads === undefined || !current()) return undefined;
    let generation: number | undefined;
    const off = search.subscribe((state) => {
      if (state.phase === 'ready') generation = state.generation;
    });
    try {
      await search.prepare(request.signal);
    } finally {
      off();
    }
    if (!current() || generation === undefined) return undefined;
    if (retained.search !== undefined && retained.search.identity.generation !== generation)
      return undefined;
    return resolveTaskListRef({
      reads,
      search,
      target: { type: 'task', ref },
      generation,
      request: { signal: request.signal, isCurrent: current },
    });
  }

  private recordCreationElement_abyssPrivate(
    inclusion: CreationInclusion,
    element: HTMLElement | undefined,
  ): HTMLElement | undefined {
    if (element !== undefined && this.creationInclusion_abyssPrivate === inclusion)
      inclusion.element = element;
    return element;
  }

  private installCreationInclusion_abyssPrivate(
    retained: TaskSurfaceState,
    task: TaskSnapshot,
    address: TaskSearchAddress,
    request: CreationRevealRequest,
  ): { inclusion: CreationInclusion; published: Promise<void>; aborted: () => void } {
    let publish = (): void => {};
    const published = new Promise<void>((resolve) => {
      publish = resolve;
    });
    const cancel = (): void => {
      request.signal.removeEventListener('abort', aborted);
      publish();
    };
    const inclusion: CreationInclusion = {
      inclusion: { id: ++this.revealId_abyssPrivate, kind: 'creation', address },
      task,
      accepted: false,
      publish,
      cancel,
    };
    const aborted = (): void => {
      if (this.creationInclusion_abyssPrivate === inclusion && !inclusion.accepted) {
        this.clearCreationInclusion_abyssPrivate();
        if (retained === this.taskSurface_abyssPrivate) {
          if (retained.search !== undefined) this.taskSearch_abyssPrivate.refresh();
          else this.render_abyssPrivate();
        }
      } else cancel();
    };
    this.creationInclusion_abyssPrivate = inclusion;
    request.signal.addEventListener('abort', aborted, { once: true });
    return { inclusion, published, aborted };
  }

  private mountCreationInclusion_abyssPrivate(
    retained: TaskSurfaceState,
    task: TaskSnapshot,
  ): void {
    const rows = this.withCreationInclusion_abyssPrivate(
      retained.surface.rows as TaskListRows<TaskNodeSnapshot>,
      task,
    );
    this.mountTaskRows_abyssPrivate(retained.host, rows, retained.tagGroups);
  }

  private withCreationInclusion_abyssPrivate(
    rows: TaskListRows<TaskNodeSnapshot>,
    task: TaskSnapshot,
  ): TaskListRows<TaskNodeSnapshot> {
    const key = taskRowKey(task);
    return indexedRows([
      ...rows.slice(0, rows.rowCount),
      {
        kind: 'group',
        key: 'creation-reveal',
        label: 'Created task',
        count: 1,
        first: rows.taskCount === 0,
      },
      { kind: 'task', key, taskKey: key, task: rootTaskNodeSnapshot(task) },
    ]);
  }

  private async revealSnapshotCreation_abyssPrivate(
    attempt: CreationRowAttempt,
  ): Promise<HTMLElement | undefined> {
    const ready = await this.prepareTaskReveal_abyssPrivate(
      attempt.retained,
      attempt.key,
      { signal: attempt.request.signal, isCurrent: () => attempt.isCurrent() },
      { expectedRef: attempt.ref, scroll: attempt.scroll },
    );
    return ready !== undefined && this.readyCreationCard_abyssPrivate(ready.card, attempt.ref)
      ? ready.card
      : undefined;
  }

  private async snapshotForKey_abyssPrivate(
    key: string,
    signal: AbortSignal,
  ): Promise<TaskNodeSnapshot | undefined> {
    if (signal.aborted) return undefined;
    const retained = this.taskSurface_abyssPrivate;
    if (retained?.search !== undefined) return retained.search.rows.snapshot(key, signal);
    return this.mountedProjection_abyssPrivate(key);
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

  private sameSearchAddress_abyssPrivate(
    a: TaskSearchAddress | undefined,
    b: TaskSearchAddress,
  ): boolean {
    return a !== undefined && taskSearchAddressKey(a) === taskSearchAddressKey(b);
  }

  private refreshSearchPulse_abyssPrivate(): void {
    const receipt = this.taskSearchReveal_abyssPrivate.current();
    const retained = this.taskSurface_abyssPrivate;
    if (receipt === undefined || retained === null) return;
    for (const key of retained.surface.mountedKeys()) {
      const address = retained.search?.order.task(key)?.address;
      if (
        !this.sameSearchAddress_abyssPrivate(address, receipt.address) ||
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
      queries: this.queries_abyssPrivate,
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
            this.taskCommands_abyssPrivate.applyBulkTaskTags(tasks, add, remove, onResult),
          );
        },
        openDatePicker: (anchor, selectedTasks, targets) => {
          this.openTaskDatePicker_abyssPrivate(anchor, selectedTasks, targets);
        },
        openRecurrenceEditor: (anchor, task) => {
          this.openRecurrenceEditor_abyssPrivate(anchor, task);
        },
        addFilter: (filter) => {
          (this.state_abyssPrivate.get('mode') === 'search'
            ? this.searchControls_abyssPrivate
            : this.listViewControls_abyssPrivate
          ).addPropertyFilter(filter);
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
      onShowParent: (target, request) => this.showTaskInList(target, request),
      openTask: (task, initialTarget) => {
        this.taskModal_abyssPrivate?.open(task, undefined, initialTarget);
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
      onShowInTaskList: (target, request) => this.showTaskInList(target, request),
      onTaskListDraftHandoff: this.onTaskListDraftHandoff_abyssPrivate,
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
      this.state_abyssPrivate.on('mode', (_mode, previous) => {
        if (previous === 'statistics') this.statistics_abyssPrivate?.unmount();
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
    this.taskCommands_abyssPrivate.retireSelectionEvidence();
  }

  private detailOccurrenceKey_abyssPrivate(): string | undefined {
    const physical = taskStackRowKey(this.state_abyssPrivate.get('taskStack'));
    if (physical === undefined) return undefined;
    const rows = this.mountedRows_abyssPrivate.rows;
    const previous = this.rowSelection_abyssPrivate.focus;
    return previous !== null && rows.physicalKey(previous) === physical
      ? previous
      : rows.firstOccurrenceOf(physical);
  }

  private updateTaskStackSelection_abyssPrivate(): void {
    const stack = this.state_abyssPrivate.get('taskStack');
    if (this.state_abyssPrivate.get('mode') === 'statistics')
      this.updateStatisticsEvidenceSelection_abyssPrivate(taskStackRowKey(stack));
    const root = stack[0];
    const current = stack[stack.length - 1];
    const detailKey = this.detailOccurrenceKey_abyssPrivate();
    const deletable =
      root !== undefined && 'source' in root && this.rowSelection_abyssPrivate.size === 0
        ? current
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

  private updateStatisticsEvidenceSelection_abyssPrivate(selected: string | undefined): void {
    for (const card of this.el.querySelectorAll<HTMLElement>('.abyss-statistics .abyss-task-card'))
      card.classList.toggle(
        'is-selected',
        selected !== undefined && card.dataset['rowKey'] === selected,
      );
  }

  private handleStateCommit_abyssPrivate(changed: ReadonlySet<string>): void {
    const revealCommitted = this.taskSearchReveal_abyssPrivate.committed(changed);
    const hadCreationInclusion = this.creationInclusion_abyssPrivate !== undefined;
    if (
      ['taskStack', 'selectedList', 'centerFilter', 'centerListViewState', 'mode'].some((key) =>
        changed.has(key),
      )
    )
      this.clearCreationInclusion_abyssPrivate();
    if (changed.size === 0 && this.state_abyssPrivate.get('mode') === 'calendar') {
      this.calendar_abyssPrivate.cancelKeyboardInteraction();
    }
    const renderKeys = ['selectedList', 'centerListViewState', 'centerFilter', 'mode'];
    if (renderKeys.some((key) => changed.has(key))) {
      this.menuIntent_abyssPrivate.abort();
      this.cancelCreationAttempts_abyssPrivate();
      this.captureContextRevision_abyssPrivate++;
    }
    if (
      revealCommitted ||
      (hadCreationInclusion && changed.has('taskStack')) ||
      changed.size === 0 ||
      renderKeys.some((key) => changed.has(key))
    )
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
    if (order.taskCount === 0) return;
    event.preventDefault();
    this.moveTaskSelection_abyssPrivate(event, order);
  }

  private clearTaskSelection_abyssPrivate(): void {
    this.rowSelection_abyssPrivate.clear();
    this.taskCommands_abyssPrivate.retireSelectionEvidence();
    this.updateSelectionVisuals_abyssPrivate();
  }

  private isTaskNavigationEvent_abyssPrivate(event: KeyboardEvent): boolean {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return false;
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
    if (order.taskCount === 0) return false;
    event.preventDefault();
    event.stopPropagation();
    this.rowSelection_abyssPrivate.selectAll(order, {
      target: this.eventTaskCardKey_abyssPrivate(event.target),
      detail: this.detailOccurrenceKey_abyssPrivate(),
    });
    this.taskCommands_abyssPrivate.retireSelectionEvidence();
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
    const origin = {
      target: this.eventTaskCardKey_abyssPrivate(event.target),
      detail: this.detailOccurrenceKey_abyssPrivate(),
    };
    const edge = event.key === 'Home' ? 'first' : 'last';
    const direction = event.key === 'ArrowDown' ? 'down' : 'up';
    const next =
      event.key === 'Home' || event.key === 'End'
        ? this.rowSelection_abyssPrivate.moveEdge(edge, order, origin, extend)
        : this.rowSelection_abyssPrivate.move(direction, order, origin, extend);
    if (next === undefined) return;
    this.taskCommands_abyssPrivate.retireSelectionEvidence();
    this.updateSelectionVisuals_abyssPrivate();
    if (this.taskSurface_abyssPrivate?.search !== undefined) {
      void this.readyKeyboardTarget_abyssPrivate(next, extend).catch((error: unknown) => {
        this.reportTaskRenderFailure_abyssPrivate(error);
      });
      return;
    }
    const task = extend ? undefined : this.mountedProjection_abyssPrivate(next);
    if (task !== undefined) this.state_abyssPrivate.set('taskStack', [task.root, ...task.path]);
    this.focusTaskKey_abyssPrivate(next);
  }

  private selectMountedProjection_abyssPrivate(key: string): void {
    const projection = this.mountedProjection_abyssPrivate(key);
    if (projection !== undefined)
      this.state_abyssPrivate.set('taskStack', [projection.root, ...projection.path]);
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
      const ready = await this.prepareTaskReveal_abyssPrivate(retained, key, {
        signal: controller.signal,
        isCurrent: current,
      });
      if (ready === undefined || !current()) return;
      if (!extend) {
        this.selectMountedProjection_abyssPrivate(key);
      }
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

  followStatisticsNote(oldPath: string, newPath?: string): void {
    this.statistics_abyssPrivate?.followNote(oldPath, newPath);
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
    this.cancelListActivation_abyssPrivate?.();
    this.menuIntent_abyssPrivate.abort();
    this.cancelCreationAttempts_abyssPrivate();
    this.taskSearchReveal_abyssPrivate.cancelPulse();
    if (this.taskSurface_abyssPrivate?.search !== undefined) this.destroyTaskSurface_abyssPrivate();
    this.taskSearch_abyssPrivate.onWindowMigrated();
    if (this.state_abyssPrivate.get('mode') === 'statistics')
      this.statistics_abyssPrivate?.render(this.el);
  }

  refresh(reason: 'view' | 'source' | 'projects' | 'links' = 'view'): void {
    if (this.state_abyssPrivate.get('mode') === 'statistics') {
      this.statistics_abyssPrivate?.render(this.el);
      return;
    }
    if (reason === 'projects') this.cancelListActivation_abyssPrivate?.();
    if (this.refreshMountedProjects_abyssPrivate(this.state_abyssPrivate.get('mode'))) return;
    if (this.taskSearch_abyssPrivate.refresh(reason)) return;
    this.render_abyssPrivate();
  }

  refreshProjectTableSettings(): void {
    this.projectsPanel_abyssPrivate?.refreshTableSettings();
  }

  /** Keeps project-table draft ownership at the table before a mode transition. */
  clearTaskSearchReveal(): void {
    this.clearCreationInclusion_abyssPrivate();
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
    this.statistics_abyssPrivate?.destroy();
    this.releaseTaskSelection_abyssPrivate();
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

  private releaseTaskSelection_abyssPrivate(): void {
    this.rowSelection_abyssPrivate.clear();
    this.rowSelection_abyssPrivate.bind(NO_TASK_LIST_ROWS);
    this.selectionRows_abyssPrivate = NO_TASK_LIST_ROWS;
    this.cancelListActivation_abyssPrivate?.();
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
    if (mode === 'statistics' && this.statistics_abyssPrivate !== undefined) {
      if (this.el.querySelector('.abyss-statistics') === null) {
        this.beginTaskCardRender_abyssPrivate();
        this.prepareRender_abyssPrivate(mode);
        this.destroyProjectsPanel_abyssPrivate();
        this.prepareNonCalendarRoot_abyssPrivate();
        this.el.removeClass('abyss-center--projects');
      }
      this.statistics_abyssPrivate.render(this.el);
      return;
    }
    this.statistics_abyssPrivate?.unmount();
    this.renderOrdinaryMode_abyssPrivate(mode);
  }

  private renderOrdinaryMode_abyssPrivate(mode: string): void {
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
      this.destroyTaskSurface_abyssPrivate();
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
      this.state_abyssPrivate.get('mode') === 'tasks' &&
      (this.state_abyssPrivate.get('centerFilter').length > 0 ||
        this.taskSearchReveal_abyssPrivate.current() !== undefined ||
        this.creationInclusion_abyssPrivate !== undefined ||
        (this.state_abyssPrivate.get('selectedList') === 'upcoming' &&
          this.state_abyssPrivate.get('centerListViewState').groupBy === 'date'))
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
    tasks: TaskNodeSnapshot[],
    tagGroups: readonly EffectiveTagGroup[] = this.effectiveTagGroups_abyssPrivate(),
  ): void {
    const vs = this.state_abyssPrivate.get('centerListViewState');
    const today = localDate(window.moment().format('YYYY-MM-DD'));
    const todayList = this.state_abyssPrivate.get('selectedList') === 'today';
    const grouping = taskListGrouping(vs.groupBy, {
      todayList,
      today,
      tomorrow: window.moment().add(1, 'day').format('YYYY-MM-DD'),
      statuses: this.statusRegistry_abyssPrivate,
      outgoingLinks: this.outgoingLinks_abyssPrivate,
    });
    const grouped = buildTaskNodeListRows(tasks, grouping);
    const rows = todayList
      ? indexedRows(
          Array.from(grouped.slice(0, grouped.rowCount), (row) => {
            if (row.kind === 'group') return row;
            const occurrence = taskTodayOccurrence(row.task.node.planning, today);
            return occurrence === undefined
              ? row
              : {
                  ...row,
                  presentation: {
                    kind: 'today' as const,
                    displayDate: occurrence.displayDate,
                    completion: occurrence.completion,
                  },
                };
          }),
        )
      : grouped;
    const inclusion = this.creationInclusion_abyssPrivate;
    if (
      inclusion !== undefined &&
      rows.firstOccurrenceOf(taskRowKey(inclusion.task)) === undefined
    ) {
      const exact = this.queries_abyssPrivate.resolve(inclusion.task.ref);
      if (exact.type === 'exact') {
        this.mountTaskRows_abyssPrivate(
          container,
          this.withCreationInclusion_abyssPrivate(rows, inclusion.task),
          tagGroups,
        );
        return;
      }
      this.clearCreationInclusion_abyssPrivate();
    }
    this.mountTaskRows_abyssPrivate(container, rows, tagGroups);
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
      buildTaskNodeListRows(tasks.map(rootTaskNodeSnapshot), { by: 'none' }),
      tagGroups,
      options,
    );
  }

  /** The one place list rows become elements; the handle it keeps serves every later patch. */
  private mountTaskRows_abyssPrivate(
    container: HTMLElement,
    rows: TaskListRows<TaskNodeSnapshot>,
    tagGroups: readonly EffectiveTagGroup[],
    options: TaskRowOptions = {},
  ): void {
    this.updateTaskSurface_abyssPrivate(container, rows, tagGroups, options);
  }

  private updateTaskSurface_abyssPrivate(
    host: HTMLElement,
    rows: TaskListRows<TaskNodeSnapshot>,
    tagGroups: readonly EffectiveTagGroup[],
    options: TaskRowOptions = {},
  ): void {
    this.bindSnapshotSelection_abyssPrivate(rows);
    if (
      this.taskSurface_abyssPrivate?.host !== host ||
      this.taskSurface_abyssPrivate.search !== undefined
    ) {
      this.destroyTaskSurface_abyssPrivate();
      const surface = new TaskListSurface<SurfaceTask>({
        host,
        scroll: host.closest<HTMLElement>('.abyss-project-dashboard-session') ?? host,
        mount: (container, row) => {
          if (row.kind === 'task' && !('root' in row.task))
            throw new Error('Expected snapshot row');
          return this.mountTaskRow_abyssPrivate(
            container,
            row.kind === 'group' ? row : { ...row, task: row.task as TaskNodeSnapshot },
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

  private selectionCandidates_abyssPrivate<T>(rows: TaskListRows<T>): Map<string, T> {
    const candidates = new Map(
      this.rowSelection_abyssPrivate
        .selectedNodes(rows)
        .map((entry) => [entry.taskKey, entry.task]),
    );
    for (const key of [
      this.rowSelection_abyssPrivate.anchor,
      this.rowSelection_abyssPrivate.focus,
    ]) {
      if (key === null) continue;
      const task = rows.task(key),
        physical = rows.physicalKey(key);
      if (task !== undefined && physical !== undefined) candidates.set(physical, task);
    }
    return candidates;
  }

  private snapshotSelectionSuccessor_abyssPrivate(
    key: string,
    before: TaskNodeSnapshot,
    rows: TaskListRows<TaskNodeSnapshot>,
  ): string | undefined {
    const resolution = this.queries_abyssPrivate.resolve(before.root.ref);
    if (resolution.type !== 'exact' && resolution.type !== 'rebased') return undefined;
    const current = resolution.type === 'exact' ? resolution.task : resolution.current;
    if (resolution.type === 'rebased' && resolution.evidence !== 'byte-identical-relocation')
      return undefined;
    const line =
      Number(key.slice(key.lastIndexOf(':') + 1)) + current.source.line - before.root.source.line;
    const nextKey = `${current.source.filePath}:${line}`;
    const occurrence = rows.firstOccurrenceOf(nextKey);
    const after = occurrence === undefined ? undefined : rows.task(occurrence);
    return after !== undefined && this.sameCardRef_abyssPrivate(after.root.ref, current.ref)
      ? nextKey
      : undefined;
  }

  private bindSnapshotSelection_abyssPrivate(rows: TaskListRows<TaskNodeSnapshot>): void {
    if (this.state_abyssPrivate.get('mode') !== 'tasks') return;
    const previous = this.selectionRows_abyssPrivate;
    const physicalKeys = new Map<string, string>();
    for (const [key, before] of this.selectionCandidates_abyssPrivate(previous)) {
      if (!('root' in before)) continue;
      const nextKey = this.snapshotSelectionSuccessor_abyssPrivate(key, before, rows);
      if (nextKey !== undefined) physicalKeys.set(key, nextKey);
    }
    this.taskCommands_abyssPrivate.archiveSelectionRebase(
      (task) => {
        const key = rows.firstOccurrenceOf(taskRowKey(task));
        const mounted = key === undefined ? undefined : rows.task(key);
        return mounted !== undefined && this.sameCardRef_abyssPrivate(mounted.root.ref, task.ref)
          ? taskRowKey(task)
          : undefined;
      },
      (proof) => {
        for (const [before, after] of proof) physicalKeys.set(before, after);
        this.taskCommands_abyssPrivate.ownedSelectionRebase(
          (task) => {
            const key = `${task.root.source.filePath}:${taskNodeSourceLine(task.target)}`;
            const occurrence = rows.firstOccurrenceOf(key);
            const after = occurrence === undefined ? undefined : rows.task(occurrence);
            return after !== undefined && sameTaskNodeRef(after.target, task.target)
              ? key
              : undefined;
          },
          (owned) => {
            for (const [before, after] of owned) physicalKeys.set(before, after);
            this.rowSelection_abyssPrivate.bind(rows, { physicalKeys });
          },
        );
      },
    );
    this.selectionRows_abyssPrivate = rows;
  }

  private mountTaskRow_abyssPrivate(
    container: HTMLElement,
    row: TaskListRow<TaskNodeSnapshot>,
    tagGroups: readonly EffectiveTagGroup[],
  ): TaskRowMount<TaskNodeSnapshot> {
    if (row.kind === 'group')
      return mountGroupHeader(
        container,
        row,
        this.state_abyssPrivate.get('mode') === 'tasks'
          ? (date) => {
              this.captureSessions_abyssPrivate.openDateCapture(date);
            }
          : undefined,
      );
    let card: TaskCardMount | undefined;
    let releaseNavigation: void | (() => void);
    const element = mountTaskListRow(container, row, (parent, taskRow) => {
      card = this.taskCardRenderer_abyssPrivate.mount(
        parent,
        taskRow.task.root,
        this.taskSurface_abyssPrivate?.tagGroups ?? tagGroups,
        this.taskCardOptions_abyssPrivate(taskRow.task, taskRow.key, taskRow.presentation),
      );
      try {
        releaseNavigation = this.taskSurface_abyssPrivate?.options.onCard?.(
          card.element,
          taskRow.task.root,
        );
      } catch (error) {
        card.destroy();
        throw error;
      }
      this.ordinaryCards_abyssPrivate.set(taskRow.key, card);
      this.observeTaskCardReceipt_abyssPrivate(card);
      return card.element;
    });
    return {
      element,
      update: (next) => {
        if (next.kind === 'task') {
          if (card === undefined) return;
          if (typeof releaseNavigation === 'function') releaseNavigation();
          releaseNavigation = undefined;
          const groups = this.taskSurface_abyssPrivate?.tagGroups ?? tagGroups;
          const flags = this.taskCardOptions_abyssPrivate(next.task, next.key, next.presentation);
          if (!card.accepts(next.task.root, flags)) {
            card.destroy();
            element.empty();
            card = this.taskCardRenderer_abyssPrivate.mountInto(
              element,
              next.task.root,
              groups,
              flags,
            );
            this.ordinaryCards_abyssPrivate.set(next.key, card);
          } else card.update(next.task.root, groups, flags);
          this.observeTaskCardReceipt_abyssPrivate(card);
          releaseNavigation = this.taskSurface_abyssPrivate?.options.onCard?.(
            element,
            next.task.root,
          );
        }
      },
      destroy: () => {
        if (typeof releaseNavigation === 'function') releaseNavigation();
        releaseNavigation = undefined;
        this.ordinaryCards_abyssPrivate.delete(row.key);
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
    task: TaskNodeSnapshot,
    rowKey: string,
    occurrence?: TaskOccurrencePresentation,
  ): Parameters<TaskCardMount['update']>[2] {
    const options = this.taskSurface_abyssPrivate?.options;
    return {
      projection: task,
      ...(occurrence === undefined ? {} : { occurrence }),
      selected:
        taskStackRowKey(this.state_abyssPrivate.get('taskStack')) ===
        taskStackRowKey([task.root, ...task.path]),
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

  private invalidateTaskInteractions_abyssPrivate(rows: TaskListRows<TaskNodeSnapshot>): void {
    for (const record of [...this.taskInteractionPins_abyssPrivate]) {
      const next = rows.task(record.key);
      if (next === undefined || !this.sameCardRef_abyssPrivate(next.root.ref, record.ref)) {
        this.taskInteractionPins_abyssPrivate.delete(record);
        record.cancel();
      }
    }
    this.invalidateTaskFocus_abyssPrivate(rows);
  }

  private invalidateTaskFocus_abyssPrivate(rows: TaskListRows<TaskNodeSnapshot>): void {
    const active = this.el.ownerDocument.activeElement;
    const key = this.eventTaskCardKey_abyssPrivate(active);
    if (key === undefined || !isRealmHTMLElement(active)) return;
    const previous = this.mountedSnapshot_abyssPrivate(key);
    const next = rows.task(key);
    if (
      previous === undefined ||
      (next !== undefined && this.sameCardRef_abyssPrivate(previous.ref, next.root.ref))
    )
      return;
    if (next === undefined || !this.acceptedTaskFocusRef_abyssPrivate(key, next.root.ref)) {
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
    this.clearCreationInclusion_abyssPrivate();
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
    const currentProjection =
      context?.currentProjection ?? (() => rootTaskNodeSnapshot(currentTask()));
    const component = context?.component ?? this.md_abyssPrivate;
    component.registerDomEvent(card, 'click', (event) => {
      if (context?.onActivate !== undefined) {
        context.onActivate(currentTask());
        return;
      }
      this.handleTaskCardClick_abyssPrivate(event, currentTask(), rowKey, currentProjection());
    });
    if (context?.onActivate !== undefined) {
      mountTaskSearchKeyboardActivation(card, component, () => {
        context.onActivate?.(currentTask());
      });
    }
    this.mountTaskCardDrag_abyssPrivate(card, currentTask, component, currentProjection);
    component.registerDomEvent(card, 'contextmenu', (event) => {
      this.handleTaskContextMenu_abyssPrivate(event, card, currentProjection(), rowKey);
    });
  }

  private handleTaskCardClick_abyssPrivate(
    event: MouseEvent,
    task: TaskSnapshot,
    key = taskRowKey(task),
    projection = rootTaskNodeSnapshot(task),
  ): void {
    this.taskCommands_abyssPrivate.retireSelectionEvidence();
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
    this.state_abyssPrivate.set('taskStack', [projection.root, ...projection.path]);
  }

  private mountTaskCardDrag_abyssPrivate(
    card: HTMLElement,
    currentTask: () => TaskSnapshot,
    component: Component,
    currentProjection = () => rootTaskNodeSnapshot(currentTask()),
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
          task: currentProjection(),
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
        !(
          currentProjection().target.type === 'task' &&
          this.canDropProjectOnTask_abyssPrivate(currentTask())
        )
      )
        return;
      event.preventDefault();
      card.classList.add('abyss-drop-target');
    });
    component.registerDomEvent(card, 'dragleave', () => {
      card.classList.remove('abyss-drop-target');
    });
    component.registerDomEvent(card, 'drop', (event) => {
      this.handleTaskCardDrop_abyssPrivate(event, card, currentTask(), currentProjection());
    });
    if (this.tasks_abyssPrivate !== undefined) {
      const tasks = this.tasks_abyssPrivate;
      component.register(
        bindTaskHierarchyDrop(card, {
          state: this.state_abyssPrivate,
          tasks,
          parent: () =>
            this.state_abyssPrivate.get('mode') === 'tasks'
              ? currentProjection().target
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
    projection = rootTaskNodeSnapshot(task),
  ): void {
    card.classList.remove('abyss-drop-target');
    const tag = this.state_abyssPrivate.get('draggingTag');
    if (tag !== null && tag !== '') {
      event.preventDefault();
      runAsyncAction(this.taskCommands_abyssPrivate.patchTaskTags(projection, [tag], []));
      return;
    }
    const project = this.state_abyssPrivate.get('draggingProject');
    if (
      projection.target.type !== 'task' ||
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
    tasks: readonly TaskCommandSubject[],
    value: LocalDate,
  ): void {
    this.runBulkMenuAction_abyssPrivate(card, (onResult) =>
      this.taskCommands_abyssPrivate.applyBulkDuePreset(tasks, value, onResult),
    );
  }

  private runBulkMenuAction_abyssPrivate(
    card: HTMLElement,
    action: (
      onResult: (task: TaskCommandSubject, result: TaskCommandResult) => void,
    ) => Promise<unknown>,
  ): void {
    const existing = this.cardReturn_abyssPrivate;
    const record =
      existing?.opener === card ? existing : this.armCardReturn_abyssPrivate(card, 'menu');
    if (record != null) {
      record.pending = true;
      if (record !== existing) record.hidden = true;
    }
    let openerAccepted = false;
    runAsyncAction(
      action((submitted, result) => {
        if (record == null || this.cardReturn_abyssPrivate !== record) return;
        if (result.type !== 'ok') {
          if (!openerAccepted) this.clearCardReturn_abyssPrivate();
          return;
        }
        if (
          !this.sameCardRef_abyssPrivate(rootTaskRef(commandNode(submitted)), record.original.ref)
        )
          return;
        if (result.outcome.type === 'task') {
          openerAccepted = true;
          record.ref = result.outcome.task.ref;
        } else this.clearCardReturn_abyssPrivate();
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
    task: TaskNodeSnapshot,
    key: string,
  ): void {
    event.preventDefault();
    const selection = this.rowSelection_abyssPrivate;
    if (selection.size > 0 && !selection.has(key)) this.clearTaskSelection_abyssPrivate();
    const targets = this.taskMenuTargets_abyssPrivate();
    if (targets.summaries.length >= 2) {
      this.taskMenus_abyssPrivate.showBulkContextMenu(event, card, targets);
      return;
    }
    const representedTags =
      this.state_abyssPrivate.get('mode') === 'search'
        ? [...card.querySelectorAll('.abyss-task-tag')].map((tag) => tag.textContent)
        : [];
    const menu = this.taskMenus_abyssPrivate.createTaskContextMenu(card, task, representedTags);
    this.showTaskMenu_abyssPrivate(menu, event, card);
  }

  private menuIntent_abyssPrivate = new AbortController();
  private taskMenuTargets_abyssPrivate(): TaskMenuTargets {
    this.menuIntent_abyssPrivate.abort();
    const controller = new AbortController();
    this.menuIntent_abyssPrivate = controller;
    const order = this.listOrder_abyssPrivate();
    const selected = this.rowSelection_abyssPrivate.selectedNodes(order);
    const compact = this.taskSurface_abyssPrivate?.search;
    const tasks = selected.flatMap((entry) => ('root' in entry.task ? [entry.task] : []));
    const summaries = selected.map(({ task, completion }) =>
      'root' in task
        ? { ...task.node, depth: task.path.length, completion }
        : { ...task.menu, depth: task.depth, completion },
    );
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
        const resolved =
          compact === undefined
            ? tasks
            : await compact.rows.resolve(
                selected.flatMap((entry) => ('root' in entry.task ? [] : [entry.task.key])),
                signal,
              );
        this.assertMenuTargets_abyssPrivate(signal, controller.signal, compact);
        if (compact === undefined) this.assertExactMenuSnapshots_abyssPrivate(tasks);
        return resolved.map((task, index) => ({
          task,
          completion:
            selected[index]?.completion ??
            (() => {
              throw new TaskSearchError('stale', 'Selected node changed');
            })(),
        }));
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
  private assertExactMenuSnapshots_abyssPrivate(tasks: readonly TaskNodeSnapshot[]): void {
    for (const task of tasks) {
      const proof = this.queries_abyssPrivate.resolve(task.root.ref);
      if (proof.type !== 'exact' || !this.sameCardRef_abyssPrivate(proof.task.ref, task.root.ref))
        throw new TaskSearchError('stale', 'Task changed');
    }
  }

  private async resolveMenuCommit_abyssPrivate(
    targets: TaskMenuTargets,
    submit: (tasks: readonly TaskCommandSubject[]) => void,
  ): Promise<void> {
    try {
      const tasks = await targets.resolve(targets.signal);
      if (!targets.signal.aborted) submit(tasks.map((entry) => entry.task));
    } catch (error) {
      if (
        !targets.signal.aborted &&
        !(error instanceof TaskSearchError && error.code === 'aborted')
      )
        this.reportTaskRenderFailure_abyssPrivate(error);
    }
  }

  private taskNodeSnapshots_abyssPrivate(
    query: Parameters<TaskQueryApi['list']>[0],
  ): readonly TaskNodeSnapshot[] {
    if (query !== undefined) return this.queries_abyssPrivate.list(query).map(rootTaskNodeSnapshot);
    return (
      this.queries_abyssPrivate.listNodes?.() ??
      this.queries_abyssPrivate.list().flatMap((root) => [...taskTreeNodes(root)])
    );
  }

  private getFilteredTasks_abyssPrivate(): TaskNodeSnapshot[] {
    const selection = this.state_abyssPrivate.get('selectedList');
    let query: { filePath: string } | { tag: string } | undefined;
    if (typeof selection === 'object') {
      if (selection.type === 'project') query = { filePath: selection.path };
    }
    const nodes = this.taskNodeSnapshots_abyssPrivate(query);
    const tasks = query === undefined ? nodes : nodes.filter((task) => task.target.type === 'task');
    const viewState = this.state_abyssPrivate.get('centerListViewState');
    this.outgoingLinks_abyssPrivate =
      viewState.groupBy === 'outgoing-link' || viewState.sortBy.field === 'outgoing-link'
        ? new Map(
            tasks.map((task) => [
              taskStackRowKey([task.root, ...task.path]) ?? '',
              outgoingTaskLinkValues(
                { ...task.node, source: task.root.source },
                (target, sourcePath) =>
                  this.app_abyssPrivate.metadataCache.getFirstLinkpathDest(target, sourcePath)
                    ?.path,
              ),
            ]),
          )
        : new Map();
    return [
      ...selectTaskNodes({
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
    tasks: readonly TaskCommandSubject[],
    targets?: TaskMenuTargets,
  ): void {
    this.clearTaskDatePicker_abyssPrivate();
    const focusKey = this.taskDateTriggerKey_abyssPrivate(anchor);
    const openerRef =
      focusKey === undefined ? undefined : this.mountedSnapshot_abyssPrivate(focusKey)?.ref;
    const firstDue = tasks[0] === undefined ? undefined : commandNode(tasks[0]).planning.due;
    const initialValue =
      firstDue != null && tasks.every((task) => commandNode(task).planning.due === firstDue)
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
        const commit = (snapshots: readonly TaskCommandSubject[]): void => {
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
    tasks: readonly TaskCommandSubject[],
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
      const onResult = (submitted: TaskCommandSubject, result: TaskCommandResult): void => {
        if (pendingFocus === undefined || this.pendingTaskDateFocus_abyssPrivate !== pendingFocus)
          return;
        const originalRef = this.taskDateFocusRefs_abyssPrivate[0];
        if (
          originalRef === undefined ||
          !this.sameCardRef_abyssPrivate(rootTaskRef(commandNode(submitted)), originalRef)
        )
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
    const count = this.rowSelection_abyssPrivate.selectedNodes(order).length;
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

  private openTaskDetails_abyssPrivate(task: TaskCommandSubject): void {
    const source = commandSource(task, this.queries_abyssPrivate);
    if (source === undefined) return;
    const path = taskSelectionRefPath(source.root, source.target);
    if (path !== undefined) this.state_abyssPrivate.set('taskStack', path);
  }

  private openStatusMenu_abyssPrivate(
    event: MouseEvent,
    task: TaskSelectionNode,
    completion: TaskOccurrenceCompletion = { kind: 'allowed' },
  ): void {
    this.clearTaskDatePicker_abyssPrivate();
    this.dismissRecurrenceEditor_abyssPrivate();
    this.listViewControls_abyssPrivate.closeViewStatePopover();
    if (completion.kind === 'continuation') {
      this.openTaskDetails_abyssPrivate(task);
      return;
    }
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
        runAsyncAction(this.taskCommands_abyssPrivate.setTaskStatus(task, symbol, completion));
      },
      onPickPriority: (priority) => {
        runAsyncAction(this.taskCommands_abyssPrivate.setPriority(task, priority));
      },
      interactionOwnership: this.interactionOwnership_abyssPrivate,
    });
  }

  private openRecurrenceEditor_abyssPrivate(anchor: HTMLElement, task: TaskCommandSubject): void {
    if (commandTarget(task) === undefined) return;
    const source = commandSource(task, this.queries_abyssPrivate);
    if (source === undefined) return;
    const { root } = source;
    this.dismissRecurrenceEditor_abyssPrivate();
    const lifecycle: { handle?: ReturnType<typeof mountAnchoredRecurrenceEditor> } = {};
    const cleanup = (): void => {
      lifecycle.handle?.dismiss();
    };
    const key = this.eventTaskCardKey_abyssPrivate(anchor);
    const releasePin =
      key === undefined
        ? undefined
        : this.pinTaskInteraction_abyssPrivate(key, root.ref, () => {
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
        const command = commandPatch(task, patch);
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
