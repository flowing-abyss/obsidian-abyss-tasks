import { Component, type App, type Menu } from 'obsidian';
import type { AppState } from '../app/AppState';
import { isListViewOptionsCustomized, listSelectionToKey } from '../app/listViewState';
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
import {
  localDate,
  type CommentTimeContextProvider,
  type LocalDate,
  type TaskApplicationApi,
  type TaskCaptureApplicationApi,
  type TaskCommandResult,
  type TaskQueryApi,
  type TaskRef,
  type TaskSearchApi,
  type TaskSnapshot,
} from '../tasks';
import { showDatePickerPopover } from '../ui/DatePickerPopover';
import { TaskModal } from '../ui/TaskModal';
import { isRealmHTMLElement } from '../ui/domRealm';
import { isImeOwnedEvent } from '../ui/ime';
import { noInteractionOwnership, type InteractionOwnershipPort } from '../ui/interactionOwnership';
import { showMenuAtMouseEventWithFocus } from '../ui/nativeMenuFocus';
import { mountAnchoredRecurrenceEditor } from '../ui/recurrence/RecurrenceEditor';
import { runAsyncAction } from '../ui/runAsyncAction';
import { showStatusMenuAt } from '../ui/statusMenu';
import { type CreationResultDescription } from '../ui/taskCommandResult';
import type { TaskDependencyLookup } from '../ui/taskDependencyPresentation';
import { bindTaskHierarchyDrop, executeTaskHierarchy } from '../ui/taskHierarchyActions';
import { startTaskNodeDrag } from '../ui/taskNodeDrag';
import { renderedTaskNodeElements } from '../ui/taskPresentationIdentity';
import type { TaskRenderOutcome, TaskRenderScope } from '../ui/taskRenderScope';
import { taskNodeRef } from '../ui/taskSelection';
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
import { TaskCardRenderer, type TaskCardSearchPresentation } from './center/TaskCardRenderer';
import { TaskCommands } from './center/TaskCommands';
import { TaskMenus } from './center/TaskMenus';
import { TaskSearch, type TaskSearchOptions, type TaskSearchRowOptions } from './center/TaskSearch';
import { TaskSearchReveal } from './center/TaskSearchReveal';
import { taskSearchDestination } from './center/taskSearchDestination';
import { ProjectsPanel } from './projects/ProjectsPanel';
import type { TaskSearchPageModel } from './task-list/TaskSearchPages';
import {
  mountTaskListRows,
  NO_MOUNTED_TASK_LIST_ROWS,
  type MountedTaskListRows,
} from './task-list/taskListRowView';
import {
  buildTaskListRows,
  buildTaskSearchPageRows,
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
    ((result: TaskCommandResult, description: CreationResultDescription) => void) | undefined;
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
  private taskDatePickerCleanup_abyssPrivate: (() => void) | null = null;
  private taskCardRenderGeneration_abyssPrivate = 0;
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
    hidden: boolean;
  } | null = null;
  private showingTaskMenu_abyssPrivate = false;
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
  /** The rows the last card render mounted; every card render starts from none. */
  private mountedRows_abyssPrivate: MountedTaskListRows = NO_MOUNTED_TASK_LIST_ROWS;
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
  ) => void;
  private readonly onRenderComplete_abyssPrivate: (root: HTMLElement) => void;
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
    this.taskSearchReveal_abyssPrivate = new TaskSearchReveal(
      () => this.el.ownerDocument.defaultView ?? null,
      () => this.state_abyssPrivate.taskSelectionIntentGeneration,
      (card) => {
        this.scrollTaskCardIntoView_abyssPrivate(card);
      },
    );
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
        mountInteractions: (card, task, rowKey, onActivate) => {
          this.mountTaskCardInteractions_abyssPrivate(card, task, rowKey, onActivate);
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
          this.clearPagedSelection_abyssPrivate();
        },
        renderControls: (host) => {
          const button = this.searchControls_abyssPrivate.renderViewStateButton(host);
          this.searchHeader_abyssPrivate = { host, button, chips: [] };
          this.syncSearchHeader_abyssPrivate();
        },
        prepareDependencies: async (generation, signal) => {
          if (this.tasks_abyssPrivate === undefined)
            throw new Error('Task dependency capability missing');
          await this.tasks_abyssPrivate.queries.prepareDependencies(generation, signal);
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
        revealTask: (task) => {
          const key = this.mountedRows_abyssPrivate.rows.occurrencesOf(taskRowKey(task))[0];
          if (key === undefined) return;
          const current = this.mountedRows_abyssPrivate.rows.task(key);
          const card = this.mountedRows_abyssPrivate.element(key);
          if (
            current != null &&
            card?.isConnected === true &&
            this.sameCardRef_abyssPrivate(current.ref, task.ref)
          )
            this.taskSearchReveal_abyssPrivate.show(card);
        },
        beginResults: () => {
          this.beginTaskCardRender_abyssPrivate();
          this.md_abyssPrivate.unload();
          this.md_abyssPrivate = new Component();
          this.md_abyssPrivate.load();
        },
        renderRows: (host, page, scope, options) =>
          this.mountSearchPage_abyssPrivate(host, page, scope, options),
        completeResults: () => {
          this.completeTaskCardRender_abyssPrivate();
        },
      },
    });
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

  private clearPagedSelection_abyssPrivate(): void {
    const selected = this.rowSelection_abyssPrivate.size > 0;
    this.rowSelection_abyssPrivate.clear();
    this.updateSelectionVisuals_abyssPrivate();
    if (selected)
      this.el
        .querySelector('.abyss-selection-live')
        ?.setText('Selection cleared for the new results page');
  }

  private async mountSearchPage_abyssPrivate(
    host: HTMLElement,
    page: TaskSearchPageModel,
    scope: TaskRenderScope,
    options: TaskSearchRowOptions,
  ): Promise<TaskRenderOutcome> {
    const groupBy =
      this.state_abyssPrivate.get('mode') === 'search'
        ? this.searchView_abyssPrivate.list.groupBy
        : this.state_abyssPrivate.get('centerListViewState').groupBy;
    this.mountTaskRows_abyssPrivate(
      host,
      buildTaskSearchPageRows(page, groupBy),
      this.effectiveTagGroups_abyssPrivate(),
      { ...options, scope },
    );
    this.rowSelection_abyssPrivate.reconcile(this.listOrder_abyssPrivate());
    this.updateSelectionVisuals_abyssPrivate();
    return this.mountedRows_abyssPrivate.settled;
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
        openDatePicker: (anchor, selectedTasks) => {
          this.openTaskDatePicker_abyssPrivate(anchor, selectedTasks);
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
        this.cardReturn_abyssPrivate = null;
        this.captureSessions_abyssPrivate.cancelStaleListCapture();
        this.calendar_abyssPrivate.cancelKeyboardInteraction();
      }),
      this.state_abyssPrivate.on('searchQuery', (query) => {
        this.taskSearch_abyssPrivate.queryChanged(query);
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
    this.wholeCardFocus_abyssPrivate = null;
    this.cardReturn_abyssPrivate = null;
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
        detail: this.detailOccurrenceKey_abyssPrivate(),
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
      this.cardReturn_abyssPrivate = null;
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

  onWindowMigrated(): void {
    this.taskSearchReveal_abyssPrivate.cancelPulse();
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
    this.cardReturn_abyssPrivate = null;
    this.renderCardFocus_abyssPrivate = null;
    this.trackingUnsubscribe_abyssPrivate?.();
    this.trackingUnsubscribe_abyssPrivate = undefined;
    // Nothing can repaint them any more, and their elements go with the panel.
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
    const retainTaskShell = this.canRetainTaskShell_abyssPrivate(mode);
    const shell = this.taskShell_abyssPrivate;
    if (
      retainTaskShell &&
      shell !== null &&
      this.hasPagedTasks_abyssPrivate() &&
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
      this.prepareRender_abyssPrivate(mode);
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
    this.captureSessions_abyssPrivate.unmountActiveCapture();
    this.clearTaskDatePicker_abyssPrivate();
    this.renderingRecurrenceCleanup_abyssPrivate = true;
    try {
      this.dismissRecurrenceEditor_abyssPrivate();
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

  private hasPagedTasks_abyssPrivate(): boolean {
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
    const scrollTop = scroll.scrollTop;
    const scrollLeft = scroll.scrollLeft;
    if (this.hasPagedTasks_abyssPrivate()) {
      addBar.empty();
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
    onCard?: (card: HTMLElement, task: TaskSnapshot) => void,
  ): void {
    this.mountTaskRows_abyssPrivate(
      container,
      buildTaskListRows(tasks, { by: 'none' }),
      tagGroups,
      { onCard },
    );
  }

  /** The one place list rows become elements; the handle it keeps serves every later patch. */
  private mountTaskRows_abyssPrivate(
    container: HTMLElement,
    rows: TaskListRows,
    tagGroups: readonly EffectiveTagGroup[],
    options: {
      readonly onCard?: ((card: HTMLElement, task: TaskSnapshot) => void) | undefined;
      readonly scope?: TaskRenderScope;
      readonly presentations?: ReadonlyMap<TaskSnapshot, TaskCardSearchPresentation> | undefined;
      readonly onActivate?: ((task: TaskSnapshot) => void) | undefined;
    } = {},
  ): void {
    const { onCard, scope, onActivate, presentations } = options;
    this.mountedRows_abyssPrivate = mountTaskListRows(
      container,
      rows,
      (host, row) => {
        const selected = this.isTaskCardSelected_abyssPrivate(row.task);
        const card = this.taskCardRenderer_abyssPrivate.render(host, row.task, tagGroups, {
          selected,
          search: presentations?.get(row.task),
          onActivate:
            onActivate === undefined
              ? undefined
              : () => {
                  onActivate(row.task);
                },
          rowKey: row.key,
          ...(scope === undefined ? {} : { renderScope: scope }),
          showDelete: selected && this.rowSelection_abyssPrivate.size === 0,
        });
        onCard?.(card, row.task);
        return card;
      },
      scope,
    );
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
      const task = this.mountedRows_abyssPrivate.rows.task(key);
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
    this.mountedRows_abyssPrivate.cancel();
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
    onActivate?: () => void,
  ): void {
    card.addEventListener('click', (event) => {
      if (onActivate !== undefined) {
        onActivate();
        return;
      }
      this.handleTaskCardClick_abyssPrivate(event, task, rowKey);
    });
    if (onActivate !== undefined) {
      card.tabIndex = 0;
      card.addEventListener('keydown', (event) => {
        if (
          event.target !== card ||
          isImeOwnedEvent(event) ||
          (event.key !== 'Enter' && event.key !== ' ')
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        onActivate();
      });
    }
    this.mountTaskCardDrag_abyssPrivate(card, task);
    card.addEventListener('contextmenu', (event) => {
      this.handleTaskContextMenu_abyssPrivate(event, card, task, rowKey);
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
    if (this.tasks_abyssPrivate !== undefined) {
      const tasks = this.tasks_abyssPrivate;
      this.md_abyssPrivate.register(
        bindTaskHierarchyDrop(card, {
          state: this.state_abyssPrivate,
          tasks,
          parent: () =>
            this.state_abyssPrivate.get('mode') === 'tasks'
              ? { type: 'task', ref: task.ref }
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

  private sameCardRef_abyssPrivate(a: TaskRef, b: TaskRef): boolean {
    return a.filePath === b.filePath && a.line === b.line && a.revision === b.revision;
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

  private returnExactCard_abyssPrivate(ref: TaskRef, key: string): boolean {
    const task = this.mountedRows_abyssPrivate.rows.task(key);
    const card = this.mountedRows_abyssPrivate.element(key);
    if (
      this.state_abyssPrivate.get('mode') !== 'tasks' ||
      task == null ||
      !this.sameCardRef_abyssPrivate(task.ref, ref) ||
      card?.isConnected !== true ||
      card.ownerDocument !== this.el.ownerDocument
    )
      return false;
    card.focus({ preventScroll: true });
    this.scrollTaskCardIntoView_abyssPrivate(card);
    return true;
  }

  private armCardReturn_abyssPrivate(
    opener: HTMLElement,
    kind: 'menu' | 'recurrence',
  ): CenterPanel['cardReturn_abyssPrivate'] {
    const key = this.eventTaskCardKey_abyssPrivate(opener);
    const task = key == null ? undefined : this.mountedRows_abyssPrivate.rows.task(key);
    if (
      key == null ||
      task == null ||
      opener.isConnected !== true ||
      opener.ownerDocument !== this.el.ownerDocument
    )
      return null;
    const record: NonNullable<CenterPanel['cardReturn_abyssPrivate']> = {
      original: task,
      key,
      ref: task.ref,
      opener,
      list: this.listViewControls_abyssPrivate.activeListKey(),
      kind,
      surface: undefined,
      pending: false,
      hidden: false,
    };
    this.cardReturn_abyssPrivate = record;
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
    this.cardReturn_abyssPrivate = null;
  }

  private finishCardReturn_abyssPrivate(): void {
    const record = this.cardReturn_abyssPrivate;
    if (record == null || record.pending || !record.hidden) return;
    this.cardReturn_abyssPrivate = null;
    if (
      record.list === this.listViewControls_abyssPrivate.activeListKey() &&
      this.neutralCardFocus_abyssPrivate(record.opener, record.surface)
    )
      this.returnExactCard_abyssPrivate(record.ref, record.key);
  }

  private showTaskMenu_abyssPrivate(menu: Menu, event: MouseEvent, card: HTMLElement): void {
    const record = this.armCardReturn_abyssPrivate(card, 'menu');
    menu.onHide(() => {
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
        else this.cardReturn_abyssPrivate = null;
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
    const selectedTasks = this.selectedTasksInVisualOrder_abyssPrivate();
    if (selectedTasks.length >= 2) {
      this.taskMenus_abyssPrivate.showBulkContextMenu(event, card, selectedTasks);
      return;
    }
    const menu = this.taskMenus_abyssPrivate.createTaskContextMenu(card, task);
    this.showTaskMenu_abyssPrivate(menu, event, card);
  }

  /** The selected tasks in display order, as the snapshots their cards were rendered from. */
  private selectedTasksInVisualOrder_abyssPrivate(): TaskSnapshot[] {
    const order = this.listOrder_abyssPrivate();
    const unique = new Map<string, TaskSnapshot>();
    for (const key of this.rowSelection_abyssPrivate.inOrder(order)) {
      const task = order.task(key);
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
  ): void {
    this.clearTaskDatePicker_abyssPrivate();
    const focusKey = this.taskDateTriggerKey_abyssPrivate(anchor);
    const openerRef =
      focusKey === undefined ? undefined : this.mountedRows_abyssPrivate.rows.task(focusKey)?.ref;
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
        restoreFocus: () =>
          this.focusTaskDateTrigger_abyssPrivate(
            focusKey,
            openerRef === undefined ? [] : [openerRef],
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
        const originalRef = this.mountedRows_abyssPrivate.rows.task(pendingFocus.key)?.ref;
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

  private clearTaskDatePicker_abyssPrivate(): void {
    this.taskDatePickerCleanup_abyssPrivate?.();
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
  ): boolean {
    const task = this.mountedRows_abyssPrivate.rows.task(key);
    if (task === undefined || !refs.some((ref) => this.sameCardRef_abyssPrivate(task.ref, ref)))
      return false;
    const card = this.mountedRows_abyssPrivate.element(key);
    if (card?.isConnected !== true) return false;
    card.focus({ preventScroll: true });
    this.wholeCardFocus_abyssPrivate = null;
    this.scrollTaskCardIntoView_abyssPrivate(card);
    return true;
  }

  private completeTaskCardRender_abyssPrivate(): void {
    const focused = this.renderCardFocus_abyssPrivate;
    this.renderCardFocus_abyssPrivate = null;
    if (
      focused?.list === this.listViewControls_abyssPrivate.activeListKey() &&
      this.neutralCardFocus_abyssPrivate(focused.opener)
    ) {
      this.returnExactCard_abyssPrivate(focused.ref, focused.key);
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
    this.taskDateFocusRefs_abyssPrivate = [];
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
    const count = this.selectedTasksInVisualOrder_abyssPrivate().length;
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
    this.listViewControls_abyssPrivate.closeViewStatePopover();
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
          else this.cardReturn_abyssPrivate = null;
          record.pending = false;
          record.hidden = true;
          this.finishCardReturn_abyssPrivate();
        }
        return result;
      },
      onClose: () => {
        if (this.recurrenceEditorCleanup_abyssPrivate === cleanup) {
          this.recurrenceEditorCleanup_abyssPrivate = null;
          if (
            !this.renderingRecurrenceCleanup_abyssPrivate &&
            this.cardReturn_abyssPrivate?.kind === 'recurrence'
          )
            this.cardReturn_abyssPrivate = null;
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
      this.cardReturn_abyssPrivate = null;
    const cleanup = this.recurrenceEditorCleanup_abyssPrivate;
    this.recurrenceEditorCleanup_abyssPrivate = null;
    cleanup?.();
  }
}
