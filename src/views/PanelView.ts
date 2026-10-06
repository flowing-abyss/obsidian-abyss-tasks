import { ItemView, Notice, Platform, Scope, setIcon, TFile, type WorkspaceLeaf } from 'obsidian';
import { AppState, type AppStateData } from '../app/AppState';
import { createBrowserTaskScheduler } from '../browserTaskScheduler';
import { CenterPanel } from '../panels/CenterPanel';
import { LeftPanel } from '../panels/LeftPanel';
import { RailPanel } from '../panels/RailPanel';
import { RightPanel } from '../panels/RightPanel';
import { initialCalendarView } from '../panels/calendar/calendarPolicy';
import { ProjectManager } from '../projects/ProjectManager';
import { ProjectStore } from '../projects/ProjectStore';
import type { ShortcutActionId } from '../settings/shortcuts';
import type { CalendarSettings } from '../settings/types';
import {
  noteDeleteChange,
  noteRenameChange,
  type NotePathChange,
} from '../settings/viewStatePaths';
import type { StatusRegistry } from '../status/StatusRegistry';
import type { TagManager } from '../tags/TagManager';
import { prefixForDiscoveredGroupId, resolveEffectiveTagGroups } from '../tags/effectiveTagGroups';
import { collectTaskNodeTags } from '../tags/taskTagCatalog';
import type {
  CommentTimeContextProvider,
  TaskApplicationApi,
  TaskCaptureApplicationApi,
  TaskCommand,
  TaskCommandResult,
  TaskIndexEvent,
  TaskNodeRef,
  TaskQueryApi,
  TaskRef,
  TaskResolution,
  TaskSearchApi,
  TaskSnapshot,
  TimeTrackingQueryApi,
} from '../tasks';
import { parseRecurrenceRule, taskCommandRootRef, taskNodeAddress } from '../tasks';
import {
  createTaskDependencySearchProvider,
  type TaskDependencySearchProvider,
} from '../ui/TaskDependencySearchProvider';
import {
  CreationPresentationController,
  type CreationRevealAuthority,
} from '../ui/creation/CreationPresentationController';
import { InteractionRegistry } from '../ui/interactionOwnership';
import { bindLocalSearchScope } from '../ui/localSearchKeys';
import { nativeInteractionBlocksPanelShortcuts } from '../ui/nativeInteractionBlocker';
import { PanelShortcutRouter } from '../ui/panelShortcutRouter';
import { prefersReducedMotion } from '../ui/reducedMotion';
import {
  CaptureTargetResolver,
  type CaptureContext,
} from '../ui/taskCapture/CaptureTargetResolver';
import { QuickCaptureCoordinator } from '../ui/taskCapture/QuickCaptureCoordinator';
import { presentTaskCommandResult, type CreationResultDescription } from '../ui/taskCommandResult';
import {
  rebuildTaskSelection,
  renamedRootSelection,
  rootTaskNodeRef,
  rootTaskRef,
  selectedRootResolution,
  type TaskSelectionNode,
} from '../ui/taskSelection';
import {
  mountRailTrackingWidget,
  type RailTrackingWidgetHandle,
} from '../ui/timeTracking/RailTrackingWidget';
import { deviceTrackedTimeContext, type TrackingSurface } from '../ui/timeTracking/TimeBadge';
import { TrackingTicker } from '../ui/timeTracking/TrackingTicker';
import { createTrackingActions } from '../ui/timeTracking/trackingActions';
import { CompactPaneAccess } from './CompactPaneAccess';
import { PanelNavigator } from './panelNavigation';
import { PANEL_DISPLAY_TEXT, panelTitle } from './panelTitle';

export const PANEL_VIEW_TYPE = 'task-calendar-panel';

/** Set on the panel root while the phone keyboard is up; the stylesheet drops the bottom inset. */
const KEYBOARD_CLASS = 'abyss-panel-view--keyboard';

/** Obsidian's leaf refreshes its tab header from getDisplayText, but the call is undocumented. */
function hasHeaderRefresh(value: unknown): value is { updateHeader(): void } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'updateHeader') === 'function'
  );
}

/** The in-view header title element Obsidian fills once at load, when the view exposes it. */
function headerTitleElement(
  value: unknown,
  realm: Window & typeof window,
): HTMLElement | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const titleEl: unknown = Reflect.get(value, 'titleEl');
  return titleEl instanceof realm.HTMLElement ? titleEl : undefined;
}

interface PanelLayoutElements {
  readonly layout: HTMLElement;
  readonly rail: HTMLElement;
  readonly left: HTMLElement;
  readonly center: HTMLElement;
  readonly right: HTMLElement;
  readonly quickCaptureHost: HTMLElement;
}

type PanelViewDependencies = [
  settings: CalendarSettings,
  tagManager: TagManager,
  queries: TaskQueryApi & TimeTrackingQueryApi,
  tasks: TaskApplicationApi & TaskCaptureApplicationApi,
  statusRegistry: StatusRegistry,
  onSaveSettings?: () => Promise<void>,
  commentTimeContext?: CommentTimeContextProvider,
  onSaveViewState?: () => Promise<void>,
  projectManager?: ProjectManager,
  search?: TaskSearchApi,
];

function hasFinitePositiveBounds(bounds: DOMRect): boolean {
  const coordinates = [bounds.left, bounds.top, bounds.width, bounds.height];
  return coordinates.every(Number.isFinite) && bounds.width > 0 && bounds.height > 0;
}

function hasPositiveClientRect(element: HTMLElement): boolean {
  return Array.from(element.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0);
}

function positiveRenderedArea(element: HTMLElement): DOMRect | null {
  const bounds = element.getBoundingClientRect();
  return hasFinitePositiveBounds(bounds) && hasPositiveClientRect(element) ? bounds : null;
}

function intersectsOwnerViewport(bounds: DOMRect, ownerWindow: Window | null): boolean {
  if (ownerWindow == null) return true;
  const width = ownerWindow.innerWidth;
  const height = ownerWindow.innerHeight;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return true;
  return bounds.right > 0 && bounds.bottom > 0 && bounds.left < width && bounds.top < height;
}

function hasPresentedPanelGeometry(element: HTMLElement, ownerWindow: Window | null): boolean {
  const bounds = positiveRenderedArea(element);
  return bounds !== null && intersectsOwnerViewport(bounds, ownerWindow);
}

function hasVisibleAncestors(element: HTMLElement, ownerWindow: Window | null): boolean {
  let current: HTMLElement | null = element;
  while (current != null) {
    if (current.hidden !== false) return false;
    const style = ownerWindow?.getComputedStyle(current);
    if (style?.display === 'none' || style?.visibility === 'hidden') return false;
    current = current.parentElement;
  }
  return true;
}

/** The commands that take a root task out of its note, so its line may pass to the next task. */
const ROOT_REMOVALS: ReadonlySet<TaskCommand['type']> = new Set(['delete', 'archive', 'move']);

/** The selection and inspector history before a removal, which a pending removal clears. */
type SelectionOrigin = Pick<AppStateData, 'taskStack' | 'inspectorBackStack'>;

export class PanelView extends ItemView {
  private state_abyssPrivate!: AppState;
  private rail_abyssPrivate!: RailPanel;
  private left_abyssPrivate!: LeftPanel;
  private center_abyssPrivate!: CenterPanel;
  private right_abyssPrivate!: RightPanel;
  private queryUnsub_abyssPrivate: (() => void) | undefined;
  private modeUnsub_abyssPrivate: (() => void) | undefined;
  private selectionUnsub_abyssPrivate: (() => void) | undefined;
  private listUnsub_abyssPrivate: (() => void) | undefined;
  /** The phone view header text; Obsidian reads it before onOpen and on every layout save. */
  private hostTitle_abyssPrivate = PANEL_DISPLAY_TEXT;
  private keyboardCleanup_abyssPrivate: (() => void) | undefined = undefined;
  private selectedListRenameUnsub_abyssPrivate: (() => void) | undefined;
  private projectStore_abyssPrivate?: ProjectStore;
  private projectStoreUnsub_abyssPrivate?: () => void;
  private creationPresentation_abyssPrivate: CreationPresentationController | undefined;
  private ownedWriteRef_abyssPrivate: TaskRef | undefined = undefined;
  private interactionRegistry_abyssPrivate: InteractionRegistry<ShortcutActionId> | undefined;
  private quickCapture_abyssPrivate: QuickCaptureCoordinator | undefined;
  private localScope_abyssPrivate: Scope | undefined;
  private priorScope_abyssPrivate: Scope | null = null;
  private unbindLocalScope_abyssPrivate: (() => void) | undefined;
  private shortcutRouter_abyssPrivate: PanelShortcutRouter | undefined = undefined;
  private shortcutDocument_abyssPrivate: Document | undefined = undefined;
  private shortcutMigrationCleanup_abyssPrivate: (() => void) | undefined = undefined;
  private panelNavigation_abyssPrivate!: PanelNavigator;
  private readonly compactPaneAccess_abyssPrivate: CompactPaneAccess;
  private readonly settings_abyssPrivate: CalendarSettings;
  private readonly tagManager_abyssPrivate: TagManager;
  private readonly search_abyssPrivate: TaskSearchApi | undefined;
  private readonly queries_abyssPrivate: TaskQueryApi & TimeTrackingQueryApi;
  private readonly tasks_abyssPrivate: TaskApplicationApi & TaskCaptureApplicationApi;
  private readonly statusRegistry_abyssPrivate: StatusRegistry;
  private readonly onSaveSettings_abyssPrivate: () => Promise<void>;
  private readonly onSaveViewState_abyssPrivate: () => Promise<void>;
  private readonly commentTimeContext_abyssPrivate: CommentTimeContextProvider | undefined;
  private readonly projectManager_abyssPrivate: ProjectManager | undefined;
  private timeTracking_abyssPrivate: TrackingSurface | undefined;
  private railTracking_abyssPrivate: RailTrackingWidgetHandle | undefined;
  private searchWait_abyssPrivate: AbortController | undefined = undefined;
  private panelsMounted_abyssPrivate = false;
  private searchOpportunityConsumed_abyssPrivate = false;
  private cancelSearchPresentation_abyssPrivate: (() => void) | undefined = undefined;
  private searchOpportunitiesCleanup_abyssPrivate: (() => void) | undefined = undefined;

  constructor(leaf: WorkspaceLeaf, ...dependencies: PanelViewDependencies) {
    super(leaf);
    const [
      settings,
      tagManager,
      queries,
      tasks,
      statusRegistry,
      onSaveSettings = async () => {},
      commentTimeContext,
      onSaveViewState = async () => {},
      projectManager,
      search,
    ] = dependencies;
    this.settings_abyssPrivate = settings;
    this.search_abyssPrivate = search;
    this.tagManager_abyssPrivate = tagManager;
    this.queries_abyssPrivate = queries;
    this.tasks_abyssPrivate = tasks;
    this.statusRegistry_abyssPrivate = statusRegistry;
    this.onSaveSettings_abyssPrivate = onSaveSettings;
    this.onSaveViewState_abyssPrivate = onSaveViewState;
    this.commentTimeContext_abyssPrivate = commentTimeContext;
    this.projectManager_abyssPrivate = projectManager;
    this.compactPaneAccess_abyssPrivate = new CompactPaneAccess({
      mode: () => this.state_abyssPrivate.get('mode'),
      hasSelectedTask: () => this.state_abyssPrivate.get('taskStack').length > 0,
      captureState: () => this.quickCapture_abyssPrivate,
      allowsPaneInteraction: () =>
        this.interactionRegistry_abyssPrivate?.allows('openCalendar') !== false,
    });
  }

  override getViewType(): string {
    return PANEL_VIEW_TYPE;
  }
  override getDisplayText(): string {
    return Platform.isPhone ? this.hostTitle_abyssPrivate : PANEL_DISPLAY_TEXT;
  }

  /** The center panel already names the list it renders; the phone header shows the same name. */
  private panelTitle_abyssPrivate(): string {
    return panelTitle(this.state_abyssPrivate.get('mode'), () => this.center_abyssPrivate.title());
  }

  /**
   * Obsidian reads getDisplayText at load, before onOpen, and on every layout save, so the phone
   * title is a cached field; this refresh recomputes it from the panel state and pushes it to the
   * host header.
   */
  private refreshHostHeader_abyssPrivate(): void {
    if (!Platform.isPhone) return;
    const title = this.panelTitle_abyssPrivate();
    this.hostTitle_abyssPrivate = title;
    const leaf: unknown = this.leaf;
    if (hasHeaderRefresh(leaf)) leaf.updateHeader();
    const realm = this.contentEl.ownerDocument.defaultView;
    if (realm === null) return;
    const titleEl = headerTitleElement(this, realm);
    if (titleEl !== undefined && titleEl.textContent !== title) titleEl.setText(title);
  }
  override getIcon(): string {
    return 'calendar-days';
  }

  override onOpen(): Promise<void> {
    this.createLocalScope_abyssPrivate();
    this.searchWait_abyssPrivate = new AbortController();
    this.panelsMounted_abyssPrivate = false;
    this.searchOpportunityConsumed_abyssPrivate = false;
    this.contentEl.empty();
    this.contentEl.addClass('abyss-panel-view');

    this.state_abyssPrivate = new AppState();
    this.interactionRegistry_abyssPrivate = new InteractionRegistry<ShortcutActionId>();
    this.initializeNavigation_abyssPrivate();
    const selectionTasks = this.createSelectionTasks_abyssPrivate();
    const elements = this.createLayout_abyssPrivate();
    const projectStore = new ProjectStore(
      this.app,
      this.queries_abyssPrivate,
      this.settings_abyssPrivate,
    );
    projectStore.initialize();
    this.projectStore_abyssPrivate = projectStore;
    const projectManager =
      this.projectManager_abyssPrivate ??
      new ProjectManager(
        this.app,
        this.settings_abyssPrivate,
        {
          createNoteFromTemplate: async () => {
            throw new Error('Project note creation is unavailable.');
          },
        },
        selectionTasks,
      );
    this.createPanels_abyssPrivate(selectionTasks, projectStore, projectManager);
    this.center_abyssPrivate.setCalendarView(initialCalendarView({ isPhone: Platform.isPhone }));
    this.registerProjectUpdates_abyssPrivate(projectStore);
    this.registerWorkspaceUpdates_abyssPrivate();
    this.mountPanels_abyssPrivate(elements);
    this.initializeCapture_abyssPrivate(elements, selectionTasks);
    this.subscribeToState_abyssPrivate(elements.layout);
    this.subscribeToQueries_abyssPrivate();
    this.refreshHostHeader_abyssPrivate();
    this.watchPhoneKeyboard_abyssPrivate();
    this.panelsMounted_abyssPrivate = true;
    this.registerSearchOpportunities_abyssPrivate();
    this.checkSearchOpportunity_abyssPrivate();
    return Promise.resolve();
  }

  private registerSearchOpportunities_abyssPrivate(): void {
    const wait = this.searchWait_abyssPrivate;
    const workspace = this.app.workspace;
    const check = (): void => {
      if (this.searchWait_abyssPrivate === wait && wait?.signal.aborted === false)
        this.checkSearchOpportunity_abyssPrivate();
    };
    const refs = [
      workspace.on('layout-change', check),
      workspace.on('active-leaf-change', check),
      workspace.on('resize', check),
    ];
    this.searchOpportunitiesCleanup_abyssPrivate = () => {
      for (const ref of refs) workspace.offref(ref);
    };
    workspace.onLayoutReady(check);
  }

  private canPrepareSearch_abyssPrivate(owner: NonNullable<Document['defaultView']>): boolean {
    return (
      this.panelsMounted_abyssPrivate &&
      this.searchWait_abyssPrivate?.signal.aborted === false &&
      this.app.workspace.layoutReady &&
      this.contentEl.isConnected &&
      this.contentEl.ownerDocument.defaultView === owner &&
      hasVisibleAncestors(this.contentEl, owner) &&
      hasPresentedPanelGeometry(this.containerEl, owner) &&
      hasPresentedPanelGeometry(this.contentEl, owner)
    );
  }

  /** A frame and a task offer the mounted shell a presentation opportunity, not a paint guarantee. */
  private checkSearchOpportunity_abyssPrivate(): void {
    const owner = this.contentEl.ownerDocument.defaultView;
    if (owner === null || !this.canPrepareSearch_abyssPrivate(owner)) {
      this.cancelSearchPresentation_abyssPrivate?.();
      return;
    }
    const search = this.search_abyssPrivate;
    if (
      search === undefined ||
      this.searchOpportunityConsumed_abyssPrivate ||
      this.cancelSearchPresentation_abyssPrivate !== undefined
    )
      return;
    const wait = this.searchWait_abyssPrivate;
    if (wait === undefined) return;
    let timer: number | undefined;
    const current = (): boolean =>
      this.searchWait_abyssPrivate === wait && this.canPrepareSearch_abyssPrivate(owner);
    const frame = owner.requestAnimationFrame(() => {
      if (!current()) {
        this.cancelSearchPresentation_abyssPrivate?.();
        return;
      }
      timer = owner.setTimeout(() => {
        this.cancelSearchPresentation_abyssPrivate = undefined;
        if (!current()) return;
        this.searchOpportunityConsumed_abyssPrivate = true;
        search.prepare(wait.signal).catch(() => {
          // The shared service owns sanitized failure diagnostics; only active input owns a Notice.
        });
      }, 0);
    });
    this.cancelSearchPresentation_abyssPrivate = () => {
      owner.cancelAnimationFrame(frame);
      if (timer !== undefined) owner.clearTimeout(timer);
      this.cancelSearchPresentation_abyssPrivate = undefined;
    };
  }

  /**
   * Obsidian hides its floating navigation while the keyboard is up, but only iOS subtracts the
   * keyboard from the host inset variable. The class drops the panel's inset on both platforms.
   */
  private watchPhoneKeyboard_abyssPrivate(): void {
    if (!Platform.isPhone) return;
    const realm = this.contentEl.ownerDocument.defaultView;
    if (realm === null) return;
    const show = (): void => {
      this.contentEl.addClass(KEYBOARD_CLASS);
    };
    const hide = (): void => {
      this.contentEl.removeClass(KEYBOARD_CLASS);
    };
    realm.addEventListener('keyboardWillShow', show);
    realm.addEventListener('keyboardWillHide', hide);
    this.keyboardCleanup_abyssPrivate = () => {
      realm.removeEventListener('keyboardWillShow', show);
      realm.removeEventListener('keyboardWillHide', hide);
      hide();
    };
  }

  refreshProjectTableSettings(): void {
    this.center_abyssPrivate.refreshProjectTableSettings();
  }

  refreshProjectSettings(): void {
    const result = this.projectStore_abyssPrivate?.refreshSettings();
    this.left_abyssPrivate.refresh();
    this.center_abyssPrivate.refresh();
    if (result === 'presentation') {
      if (this.state_abyssPrivate.get('mode') === 'projects') this.refreshProjectTableSettings();
    }
  }

  private initializeNavigation_abyssPrivate(): void {
    this.panelNavigation_abyssPrivate = new PanelNavigator(
      this.state_abyssPrivate,
      this.settings_abyssPrivate,
      {
        calendarView: () => this.center_abyssPrivate.calendarView(),
        setCalendarView: (view) => {
          this.center_abyssPrivate.setCalendarView(view);
        },
        openQuickCapture: () => {
          this.compactPaneAccess_abyssPrivate.cancelPending();
          this.compactPaneAccess_abyssPrivate.close(false);
          this.quickCapture_abyssPrivate?.openOrFocus();
        },
        clearTaskSearchReveal: () => {
          this.center_abyssPrivate.clearTaskSearchReveal();
        },
        finishProjectTableEditorBefore: (action) => {
          this.center_abyssPrivate.finishProjectTableEditorBefore(action);
        },
      },
      this.onSaveViewState_abyssPrivate,
    );
    this.selectedListRenameUnsub_abyssPrivate =
      this.tagManager_abyssPrivate.registerSelectedListState({
        applyTagRename: (change) => {
          this.panelNavigation_abyssPrivate.followTagRename(change);
        },
      });
  }

  private createSelectionTasks_abyssPrivate(): TaskApplicationApi & TaskCaptureApplicationApi {
    return {
      queries: this.tasks_abyssPrivate.queries,
      planCreate: (destination, options) =>
        options === undefined
          ? this.tasks_abyssPrivate.planCreate(destination)
          : this.tasks_abyssPrivate.planCreate(destination, options),
      ...(this.tasks_abyssPrivate.planArchive === undefined
        ? {}
        : {
            planArchive: async () => {
              const session = await this.tasks_abyssPrivate.planArchive?.();
              if (session === undefined) {
                throw new Error('Archive planning became unavailable');
              }
              if (session.type !== 'ready') return session;
              return {
                ...session,
                execute: (ref: TaskRef) =>
                  this.runOwnCommand_abyssPrivate(ref, true, () => session.execute(ref)),
              };
            },
          }),
      execute: (command) =>
        this.runOwnCommand_abyssPrivate(
          taskCommandRootRef(command),
          this.commandMayRemoveRoot_abyssPrivate(command),
          () => this.tasks_abyssPrivate.execute(command),
        ),
    };
  }

  private createInspectorTasks_abyssPrivate(
    selectionTasks: TaskApplicationApi,
  ): TaskApplicationApi {
    const raw = this.tasks_abyssPrivate;
    const planArchive = raw.planArchive?.bind(raw);
    return {
      queries: raw.queries,
      execute: (command) =>
        (command.type === 'set-status' || command.type === 'toggle-completion') &&
        this.commandMayRemoveRoot_abyssPrivate(command)
          ? selectionTasks.execute(command)
          : raw.execute(command),
      ...(planArchive === undefined ? {} : { planArchive }),
    };
  }

  private commandMayRemoveRoot_abyssPrivate(command: TaskCommand): boolean {
    if (ROOT_REMOVALS.has(command.type)) return true;
    if (
      (command.type !== 'set-status' && command.type !== 'toggle-completion') ||
      command.target.type !== 'task'
    )
      return false;
    const current = this.currentDeletingRoot_abyssPrivate(command.target.ref);
    if (current == null) return false;
    const requested =
      command.type === 'set-status'
        ? this.statusRegistry_abyssPrivate.bySymbol(command.symbol)
        : this.statusRegistry_abyssPrivate.defaultForType('done');
    if (requested?.type !== 'done') return false;
    return current.recurrence == null || parseRecurrenceRule(current.recurrence).type !== 'valid';
  }

  private currentDeletingRoot_abyssPrivate(ref: TaskRef): TaskSnapshot | undefined {
    const resolution = this.tasks_abyssPrivate.queries.resolve(ref);
    let current: TaskSnapshot;
    if (resolution.type === 'exact') current = resolution.task;
    else if (resolution.type === 'rebased') current = resolution.current;
    else return undefined;
    if (current.onCompletion !== 'delete') return undefined;
    if (this.statusRegistry_abyssPrivate.typeForSymbol(current.statusSymbol) === 'done')
      return undefined;
    return current;
  }

  /**
   * Runs a command of the panel's selection wrapper and converges the selection on its result. A
   * removal of the root holds it pending in the panel's state until the command settles.
   */
  private async runOwnCommand_abyssPrivate(
    initiatingRef: TaskRef | undefined,
    removesRoot: boolean,
    run: () => Promise<TaskCommandResult>,
  ): Promise<TaskCommandResult> {
    const state = this.state_abyssPrivate;
    const origin: SelectionOrigin | undefined = removesRoot
      ? { taskStack: state.get('taskStack'), inspectorBackStack: state.get('inspectorBackStack') }
      : undefined;
    const release =
      removesRoot && initiatingRef != null ? state.beginTaskRemoval(initiatingRef) : undefined;
    try {
      const result = await run();
      if (initiatingRef != null)
        this.convergeOwnCommand_abyssPrivate(initiatingRef, result, origin);
      return result;
    } finally {
      release?.();
    }
  }

  private createLayout_abyssPrivate(): PanelLayoutElements {
    const layout = this.contentEl.createDiv({ cls: 'abyss-layout abyss-layout--tasks' });
    const railEl = layout.createDiv({ cls: 'abyss-rail' });
    const leftEl = layout.createDiv({ cls: 'abyss-left' });
    const centerShell = layout.createDiv({ cls: 'abyss-center-shell' });
    const compactLeftButton = centerShell.createEl('button');
    compactLeftButton.addClass('abyss-compact-pane-button', 'abyss-compact-pane-button--left');
    compactLeftButton.setAttrs({
      type: 'button',
      'aria-label': 'Show task lists',
      'aria-expanded': 'false',
    });
    setIcon(compactLeftButton, 'panel-left');
    const compactRightButton = centerShell.createEl('button');
    compactRightButton.addClass('abyss-compact-pane-button', 'abyss-compact-pane-button--right');
    compactRightButton.setAttrs({
      type: 'button',
      'aria-label': 'Show task details',
      'aria-expanded': 'false',
    });
    setIcon(compactRightButton, 'panel-right');
    const centerEl = centerShell.createDiv({ cls: 'abyss-center' });
    const quickCaptureHost = centerShell.createDiv({ cls: 'abyss-quick-capture-host' });
    const rightEl = layout.createDiv({ cls: 'abyss-right' });
    this.compactPaneAccess_abyssPrivate.mount({
      layout,
      left: leftEl,
      right: rightEl,
      leftButton: compactLeftButton,
      rightButton: compactRightButton,
    });
    const creationFeedback = layout.createDiv({ cls: 'abyss-creation-feedback' });
    this.creationPresentation_abyssPrivate = new CreationPresentationController({
      host: creationFeedback,
      queries: this.queries_abyssPrivate,
      reducedMotion: () => prefersReducedMotion(creationFeedback.ownerDocument.defaultView),
      now: () => Date.now(),
    });
    return {
      layout,
      rail: railEl,
      left: leftEl,
      center: centerEl,
      right: rightEl,
      quickCaptureHost,
    };
  }

  private createPanels_abyssPrivate(
    selectionTasks: TaskApplicationApi & TaskCaptureApplicationApi,
    projectStore: ProjectStore,
    projectManager: ProjectManager,
  ): void {
    const timeTracking = this.createTrackingSurface_abyssPrivate();
    this.rail_abyssPrivate = new RailPanel(
      this.state_abyssPrivate,
      this.app as never,
      this.panelNavigation_abyssPrivate,
    );
    this.left_abyssPrivate = new LeftPanel({
      state: this.state_abyssPrivate,
      settings: this.settings_abyssPrivate,
      tagManager: this.tagManager_abyssPrivate,
      app: this.app,
      queries: this.queries_abyssPrivate,
      tasks: selectionTasks,
      projectStore,
      projectManager,
      navigation: this.panelNavigation_abyssPrivate,
      onSaveViewState: this.onSaveViewState_abyssPrivate,
    });
    this.center_abyssPrivate = new CenterPanel({
      ...(this.search_abyssPrivate === undefined ? {} : { search: this.search_abyssPrivate }),
      state: this.state_abyssPrivate,
      app: this.app,
      settings: this.settings_abyssPrivate,
      queries: this.queries_abyssPrivate,
      statusRegistry: this.statusRegistry_abyssPrivate,
      onSaveSettings: this.onSaveSettings_abyssPrivate,
      projectStore,
      projectManager,
      tasks: selectionTasks,
      commentTimeContext: this.commentTimeContext_abyssPrivate,
      captureApplication: selectionTasks,
      onCreationResult: (result, description, revealAuthority) => {
        this.presentCreationResult_abyssPrivate(result, description, revealAuthority);
      },
      onTaskRowsSettled: (root) => this.creationPresentation_abyssPrivate?.refreshMounted(root),
      onRenderComplete: (root) => {
        this.creationPresentation_abyssPrivate?.afterRender(root);
        this.checkSearchOpportunity_abyssPrivate();
      },
      interactionOwnership: this.interactionRegistry_abyssPrivate,
      navigation: this.panelNavigation_abyssPrivate,
      onSaveViewState: this.onSaveViewState_abyssPrivate,
      timeTracking,
      onRenderTaskHeaderActions: (header, _title, controls) => {
        this.compactPaneAccess_abyssPrivate.attachHeader(header, controls);
      },
    });
    this.right_abyssPrivate = new RightPanel({
      localSearchScope:
        this.localScope_abyssPrivate === undefined
          ? undefined
          : {
              parent: this.localScope_abyssPrivate,
              keymap: this.app.keymap,
            },
      state: this.state_abyssPrivate,
      app: this.app,
      statusRegistry: this.statusRegistry_abyssPrivate,
      settings: this.settings_abyssPrivate,
      tasks: this.createInspectorTasks_abyssPrivate(selectionTasks),
      search: this.search_abyssPrivate,
      dependencySearch: this.createDependencySearch_abyssPrivate(),
      onMutationLifecycle: (event) => {
        if (event.operation !== 'hierarchy') this.trackOwnWrite_abyssPrivate(event);
      },
      commentTimeContext: this.commentTimeContext_abyssPrivate,
      interactionOwnership: this.interactionRegistry_abyssPrivate,
      timeTracking,
    });
  }

  private createDependencySearch_abyssPrivate(): TaskDependencySearchProvider | undefined {
    const search = this.search_abyssPrivate;
    if (search === undefined) return undefined;
    return {
      open: (query, current, direction, signal) =>
        createTaskDependencySearchProvider(
          search,
          this.tasks_abyssPrivate.queries,
          createBrowserTaskScheduler(this.contentEl.ownerDocument.defaultView ?? activeWindow),
        ).open(query, current, direction, signal),
    };
  }

  /** One tick and one write boundary for every tracking control this view hosts. */
  private createTrackingSurface_abyssPrivate(): TrackingSurface {
    const surface: TrackingSurface = {
      ticker: new TrackingTicker({
        queries: this.tasks_abyssPrivate.queries,
        now: () => Date.now(),
        win: this.contentEl.ownerDocument.defaultView ?? activeWindow,
      }),
      actions: createTrackingActions(this.tasks_abyssPrivate, presentTaskCommandResult),
      context: deviceTrackedTimeContext,
    };
    this.timeTracking_abyssPrivate = surface;
    return surface;
  }

  private registerProjectUpdates_abyssPrivate(projectStore: ProjectStore): void {
    this.projectStoreUnsub_abyssPrivate = projectStore.onUpdate(() => {
      this.left_abyssPrivate.refresh();
      this.center_abyssPrivate.refresh('projects');
    });
  }

  private registerWorkspaceUpdates_abyssPrivate(): void {
    this.registerEvent(
      this.app.workspace.on('css-change', () => {
        this.compactPaneAccess_abyssPrivate.refreshWidth();
        const mode = this.state_abyssPrivate.get('mode');
        if (
          mode !== 'search' &&
          !(mode === 'tasks' && this.state_abyssPrivate.get('centerFilter').length > 0)
        )
          this.center_abyssPrivate.refresh();
        this.checkSearchOpportunity_abyssPrivate();
      }),
    );

    // Keep the session's project selection, dashboard path, and file filters valid across note
    // renames and deletes. The plugin's owner has already rebased the saved view state.
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (!(file instanceof TFile)) return;
        const change = noteRenameChange(oldPath, file.path, file.extension);
        if (change !== undefined) this.followNoteChange_abyssPrivate(change);
      }),
    );
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (!(file instanceof TFile)) return;
        const change = noteDeleteChange(file.path, file.extension);
        if (change !== undefined) this.followNoteChange_abyssPrivate(change);
      }),
    );
  }

  private followNoteChange_abyssPrivate(change: NotePathChange): void {
    if (change.type === 'renamed') {
      this.panelNavigation_abyssPrivate.followNoteRename(change.oldPath, change.path);
      const panel = this.state_abyssPrivate.get('projectsPanel');
      if (panel.view === 'dashboard' && panel.path === change.oldPath) {
        this.state_abyssPrivate.set('projectsPanel', { view: 'dashboard', path: change.path });
      }
      return;
    }
    this.panelNavigation_abyssPrivate.followNoteDelete(change.path);
    const panel = this.state_abyssPrivate.get('projectsPanel');
    if (panel.view === 'dashboard' && panel.path === change.path) {
      this.state_abyssPrivate.set('projectsPanel', { view: 'table' });
    }
  }

  private mountPanels_abyssPrivate(elements: PanelLayoutElements): void {
    this.rail_abyssPrivate.mount(elements.rail);
    this.mountRailTracking_abyssPrivate(elements.layout);
    this.left_abyssPrivate.mount(elements.left);
    this.center_abyssPrivate.mount(elements.center);
    this.right_abyssPrivate.mount(elements.right);
  }

  /** The rail widget shares this view's one ticker and write boundary with every other control. */
  private mountRailTracking_abyssPrivate(layout: HTMLElement): void {
    const host = this.rail_abyssPrivate.trackingHost();
    const surface = this.timeTracking_abyssPrivate;
    if (host === undefined || surface === undefined) {
      // Silently skipping would leave the rail short of a control nobody could explain, so the
      // missing half is named where a diagnostic report can pick it up.
      console.warn(
        '[abyss-tasks] The rail time tracking widget was not mounted because',
        host === undefined ? 'the rail has no host element' : 'the view has no tracking surface',
      );
      return;
    }
    this.railTracking_abyssPrivate = mountRailTrackingWidget({
      host,
      popoverOwner: layout,
      boundary: layout,
      queries: this.tasks_abyssPrivate.queries,
      ticker: surface.ticker,
      actions: surface.actions,
      openTask: (target) => {
        this.openTrackedTask_abyssPrivate(target);
      },
      context: surface.context,
      ownership: this.interactionRegistry_abyssPrivate,
      win: layout.ownerDocument.defaultView ?? activeWindow,
    });
  }

  /**
   * Shows a tracked task the way a card selection does: the panel switches to Tasks, the node
   * becomes the inspector selection, and at a compact width the details pane opens, also for the
   * task already selected.
   */
  private openTrackedTask_abyssPrivate(target: TaskNodeRef): void {
    const address = taskNodeAddress(target);
    const node = this.tasks_abyssPrivate.queries
      .listNodes({ filePath: rootTaskNodeRef(target).filePath })
      .find((candidate) => taskNodeAddress(candidate.target) === address);
    if (node === undefined) {
      // The note moved on since the list was grouped, so the click reaches nothing. The reader is
      // told rather than left with a dead control, and the address goes to the console for whoever
      // has to find out which line went away.
      new Notice('That tracked task is no longer in its note');
      console.warn('[abyss-tasks] The tracked task is no longer in its note', address);
      return;
    }
    this.panelNavigation_abyssPrivate.openTasks();
    this.state_abyssPrivate.openInspectorDependency(node);
    // The hop begins no selection and leaves a task already selected as it is.
    this.compactPaneAccess_abyssPrivate.open('right', false);
  }

  private initializeCapture_abyssPrivate(
    elements: PanelLayoutElements,
    selectionTasks: TaskApplicationApi & TaskCaptureApplicationApi,
  ): void {
    const interactionRegistry = this.interactionRegistry_abyssPrivate;
    if (interactionRegistry === undefined)
      throw new Error('Panel interaction registry is unavailable');
    const captureTargets = new CaptureTargetResolver(
      selectionTasks,
      this.settings_abyssPrivate,
      undefined,
      () => selectionTasks.queries.listNodes(),
    );
    this.quickCapture_abyssPrivate = new QuickCaptureCoordinator({
      host: elements.quickCaptureHost,
      context: () => this.quickCaptureContext_abyssPrivate(),
      resolveTarget: (context) => captureTargets.resolve(context),
      interactionOwnership: interactionRegistry,
      onResult: (result, description) => {
        // Taken before presenting, so a presentation failure cannot leave it for a later capture.
        const pendingPane = this.compactPaneAccess_abyssPrivate.takePending();
        try {
          this.presentCreationResult_abyssPrivate(result, description);
        } finally {
          if (description.kind === 'success' && pendingPane != null) {
            this.compactPaneAccess_abyssPrivate.schedule(pendingPane);
          }
        }
      },
    });
    this.bindPanelShortcuts_abyssPrivate();
    this.shortcutMigrationCleanup_abyssPrivate = this.contentEl.onWindowMigrated(() => {
      this.bindPanelShortcuts_abyssPrivate();
      this.center_abyssPrivate.onWindowMigrated();
      this.right_abyssPrivate.onWindowMigrated();
      this.cancelSearchPresentation_abyssPrivate?.();
      this.checkSearchOpportunity_abyssPrivate();
    });
  }

  private createLocalScope_abyssPrivate(): void {
    this.priorScope_abyssPrivate = this.scope;
    const scope = new Scope(this.scope ?? this.app.scope);
    this.localScope_abyssPrivate = scope;
    this.scope = scope;
    this.unbindLocalScope_abyssPrivate = bindLocalSearchScope(
      scope,
      (event) => this.shortcutRouter_abyssPrivate?.routeLocalSearch(event, 'scope') ?? false,
    );
  }

  private bindPanelShortcuts_abyssPrivate(): void {
    const interactionRegistry = this.interactionRegistry_abyssPrivate;
    const ownerDocument = this.contentEl.ownerDocument;
    if (interactionRegistry == null || ownerDocument === this.shortcutDocument_abyssPrivate) return;
    this.shortcutRouter_abyssPrivate?.destroy();
    this.shortcutRouter_abyssPrivate = new PanelShortcutRouter({
      ownerDocument,
      ownerElement: this.contentEl,
      isActive: () => this.ownsPanelShortcuts_abyssPrivate(),
      settings: () => this.settings_abyssPrivate.shortcuts,
      platform: { mod: Platform.isMacOS ? 'meta' : 'ctrl' },
      actions: this.panelNavigation_abyssPrivate,
      registry: interactionRegistry,
      nativeHostBlocks: () => nativeInteractionBlocksPanelShortcuts(this.contentEl.ownerDocument),
      localSearchTarget: () => this.center_abyssPrivate.localSearchTarget(),
    });
    this.shortcutDocument_abyssPrivate = ownerDocument;
  }

  private presentCreationResult_abyssPrivate(
    result: TaskCommandResult,
    description: CreationResultDescription,
    revealAuthority?: CreationRevealAuthority,
  ): void {
    if (result.type === 'ok' && result.outcome.type === 'task') {
      const resolution = this.queries_abyssPrivate.resolve(result.outcome.task.ref);
      if (resolution.type === 'exact' || resolution.type === 'rebased') {
        const current = resolution.type === 'exact' ? resolution.task : resolution.current;
        this.state_abyssPrivate.set('taskStack', [current]);
      }
    }
    this.creationPresentation_abyssPrivate?.present(result, description, revealAuthority);
  }

  private subscribeToState_abyssPrivate(layout: HTMLElement): void {
    this.modeUnsub_abyssPrivate = this.state_abyssPrivate.on('mode', (mode) => {
      layout.className = `abyss-layout abyss-layout--${mode}`;
      this.compactPaneAccess_abyssPrivate.modeChanged(mode);
      this.refreshHostHeader_abyssPrivate();
    });
    const offStack = this.state_abyssPrivate.on('taskStack', (stack) => {
      this.handleTaskStackChange_abyssPrivate(stack);
    });
    // Beginning a selection shows its details, also for the task already selected; a refresh of the
    // selection by the index or by a command leaves a hidden pane hidden.
    const offBegun = this.state_abyssPrivate.onTaskSelectionBegun((stack) => {
      if (stack.length > 0) this.compactPaneAccess_abyssPrivate.selectionChanged(true);
    });
    this.selectionUnsub_abyssPrivate = () => {
      offStack();
      offBegun();
    };
    this.listUnsub_abyssPrivate = this.state_abyssPrivate.on('selectedList', () => {
      this.refreshHostHeader_abyssPrivate();
    });
  }

  private rebaseRetiredDiscoveredPrefix_abyssPrivate(): void {
    const selected = this.state_abyssPrivate.get('selectedList');
    if (
      typeof selected !== 'object' ||
      selected.type !== 'group' ||
      this.settings_abyssPrivate.tagGroups.some((group) => group.id === selected.groupId)
    ) {
      return;
    }
    const prefix = prefixForDiscoveredGroupId(selected.groupId);
    if (prefix === undefined) return;
    const observedTags = collectTaskNodeTags(this.tasks_abyssPrivate.queries.listNodes());
    const groups = resolveEffectiveTagGroups(this.settings_abyssPrivate, observedTags);
    if (groups.some((group) => group.id === selected.groupId)) return;
    const rootTag = `#${prefix}`;
    if (!observedTags.includes(rootTag)) return;
    this.panelNavigation_abyssPrivate.rebaseListIdentity({ type: 'tag', tag: rootTag });
  }

  private handleTaskStackChange_abyssPrivate(stack: readonly TaskSelectionNode[]): void {
    const selected = stack[0];
    const selectedRef = selected == null ? undefined : rootTaskRef(selected);
    if (selectedRef == null) this.compactPaneAccess_abyssPrivate.selectionChanged(false);
    if (this.ownedWriteRef_abyssPrivate == null) return;
    if (
      selectedRef == null ||
      !this.sameRef_abyssPrivate(selectedRef, this.ownedWriteRef_abyssPrivate)
    ) {
      this.ownedWriteRef_abyssPrivate = undefined;
    }
  }

  private subscribeToQueries_abyssPrivate(): void {
    this.queryUnsub_abyssPrivate = this.queries_abyssPrivate.subscribe((event) => {
      this.rebaseRetiredDiscoveredPrefix_abyssPrivate();
      this.left_abyssPrivate.refresh();
      if (this.state_abyssPrivate.get('mode') !== 'calendar')
        this.center_abyssPrivate.refresh('source');
      const stack = this.state_abyssPrivate.get('taskStack');
      if (stack.length === 0) return;
      const root = stack[0];
      const ref = root != null ? rootTaskRef(root) : undefined;
      if (ref == null || !this.affects_abyssPrivate(event, ref.filePath)) return;
      if (root != null && 'source' in root) {
        const renamed = renamedRootSelection(event, root, this.queries_abyssPrivate);
        if (renamed != null) {
          const draft = this.right_abyssPrivate.captureDraftState();
          this.ownedWriteRef_abyssPrivate = undefined;
          this.state_abyssPrivate.updateInspectorSelection(rebuildTaskSelection(renamed, stack));
          this.right_abyssPrivate.restoreDraftState(draft, renamed);
          return;
        }
      }
      this.applyResolution_abyssPrivate(
        selectedRootResolution(
          this.queries_abyssPrivate,
          ref,
          this.state_abyssPrivate.isTaskRemovalPending(ref),
        ),
      );
    });
  }

  override async onClose(): Promise<void> {
    this.panelsMounted_abyssPrivate = false;
    this.searchWait_abyssPrivate?.abort();
    this.cancelSearchPresentation_abyssPrivate?.();
    this.searchOpportunitiesCleanup_abyssPrivate?.();
    this.searchOpportunitiesCleanup_abyssPrivate = undefined;
    this.compactPaneAccess_abyssPrivate.reset();
    this.destroyInteractionControllers_abyssPrivate();
    this.releaseSubscriptions_abyssPrivate();
    this.destroyOwnedViews_abyssPrivate();
    this.unbindLocalScope_abyssPrivate?.();
    this.unbindLocalScope_abyssPrivate = undefined;
    if (this.localScope_abyssPrivate !== undefined && this.scope === this.localScope_abyssPrivate)
      this.scope = this.priorScope_abyssPrivate;
    this.localScope_abyssPrivate = undefined;
    this.keyboardCleanup_abyssPrivate?.();
    this.keyboardCleanup_abyssPrivate = undefined;
    this.contentEl.empty();
  }

  private destroyInteractionControllers_abyssPrivate(): void {
    this.shortcutMigrationCleanup_abyssPrivate?.();
    this.shortcutMigrationCleanup_abyssPrivate = undefined;
    this.shortcutRouter_abyssPrivate?.destroy();
    this.shortcutRouter_abyssPrivate = undefined;
    this.shortcutDocument_abyssPrivate = undefined;
    this.quickCapture_abyssPrivate?.destroy();
    this.quickCapture_abyssPrivate = undefined;
    this.interactionRegistry_abyssPrivate?.destroy();
    this.interactionRegistry_abyssPrivate = undefined;
  }

  private releaseSubscriptions_abyssPrivate(): void {
    this.modeUnsub_abyssPrivate?.();
    this.selectionUnsub_abyssPrivate?.();
    this.listUnsub_abyssPrivate?.();
    this.selectedListRenameUnsub_abyssPrivate?.();
    this.queryUnsub_abyssPrivate?.();
    this.projectStoreUnsub_abyssPrivate?.();
  }

  private destroyOwnedViews_abyssPrivate(): void {
    this.creationPresentation_abyssPrivate?.destroy();
    this.creationPresentation_abyssPrivate = undefined;
    this.railTracking_abyssPrivate?.destroy();
    this.railTracking_abyssPrivate = undefined;
    this.timeTracking_abyssPrivate?.ticker.destroy();
    this.timeTracking_abyssPrivate = undefined;
    this.projectStore_abyssPrivate?.destroy();
    this.rail_abyssPrivate.destroy();
    this.left_abyssPrivate.destroy();
    this.center_abyssPrivate.destroy();
    this.right_abyssPrivate.destroy();
  }

  private quickCaptureContext_abyssPrivate(): CaptureContext {
    const mode = this.state_abyssPrivate.get('mode');
    if (mode === 'tasks') {
      return { type: 'list', selection: this.state_abyssPrivate.get('selectedList') };
    }
    if (mode === 'projects') {
      const projectsPanel = this.state_abyssPrivate.get('projectsPanel');
      if (projectsPanel.view === 'dashboard') {
        return { type: 'project-dashboard', path: projectsPanel.path };
      }
      const selectedProjectPath = this.center_abyssPrivate.selectedProjectPath();
      if (selectedProjectPath !== undefined) {
        return { type: 'project-table', path: selectedProjectPath };
      }
    }
    return { type: 'default', source: mode };
  }

  private ownsPanelShortcuts_abyssPrivate(): boolean {
    if (!this.isActiveConnectedPanel_abyssPrivate()) return false;
    const ownerWindow = this.contentEl.ownerDocument.defaultView;
    if (!hasVisibleAncestors(this.contentEl, ownerWindow)) return false;
    return (
      hasPresentedPanelGeometry(this.containerEl, ownerWindow ?? null) &&
      hasPresentedPanelGeometry(this.contentEl, ownerWindow ?? null)
    );
  }

  private isActiveConnectedPanel_abyssPrivate(): boolean {
    return this.app.workspace.getActiveViewOfType(PanelView) === this && this.contentEl.isConnected;
  }

  private affects_abyssPrivate(event: TaskIndexEvent, path: string): boolean {
    if (event.type === 'initialized') return true;
    if (event.type === 'changed') return event.files.includes(path);
    if (event.type === 'renamed') return event.oldPath === path || event.newPath === path;
    return event.path === path;
  }

  private applyResolution_abyssPrivate(resolution: TaskResolution): void {
    const stack = this.state_abyssPrivate.get('taskStack');
    this.clearSelectionMessage_abyssPrivate();
    if (resolution.type === 'exact' || resolution.type === 'rebased') {
      this.applyResolvedSelection_abyssPrivate(resolution, stack);
      return;
    }
    const draft = this.right_abyssPrivate.captureDraftState();
    this.ownedWriteRef_abyssPrivate = undefined;
    if (resolution.type === 'visual') {
      this.state_abyssPrivate.updateInspectorSelection([resolution.current]);
      this.right_abyssPrivate.detachDraftState(draft);
      return;
    }
    this.state_abyssPrivate.clearReconciledTaskSelection();
    this.right_abyssPrivate.detachDraftState(draft);
  }

  private applyResolvedSelection_abyssPrivate(
    resolution: Extract<TaskResolution, { readonly type: 'exact' | 'rebased' }>,
    stack: readonly TaskSelectionNode[],
  ): void {
    const current = resolution.type === 'exact' ? resolution.task : resolution.current;
    const consumedOwnedRef = this.consumedOwnedRef_abyssPrivate(resolution);
    const ownedSelection = this.right_abyssPrivate.selectionForOwnedTransition(
      consumedOwnedRef,
      current,
      stack,
    );
    const draft =
      consumedOwnedRef != null
        ? this.right_abyssPrivate.captureDraftStateForOwnedTransition(consumedOwnedRef, current.ref)
        : this.right_abyssPrivate.captureDraftState();
    this.ownedWriteRef_abyssPrivate = undefined;
    this.state_abyssPrivate.updateInspectorSelection(
      ownedSelection ??
        rebuildTaskSelection(current, stack, {
          preserveDependencyChanges:
            resolution.type === 'rebased' && resolution.evidence === 'authority-transition',
        }),
    );
    this.right_abyssPrivate.restoreDraftState(draft, current);
  }

  private consumedOwnedRef_abyssPrivate(
    resolution: Extract<TaskResolution, { readonly type: 'exact' | 'rebased' }>,
  ): TaskRef | undefined {
    if (resolution.type !== 'rebased' || resolution.evidence !== 'authority-transition') {
      return undefined;
    }
    const ownedWriteRef = this.ownedWriteRef_abyssPrivate;
    return ownedWriteRef != null &&
      this.sameRef_abyssPrivate(ownedWriteRef, resolution.previous.ref)
      ? ownedWriteRef
      : undefined;
  }

  private acknowledgeOwnWrite_abyssPrivate(taskOrRef?: TaskSelectionNode | TaskRef): void {
    const selected = this.state_abyssPrivate.get('taskStack')[0];
    const selectedRef = selected != null ? rootTaskRef(selected) : undefined;
    let suppliedRef: TaskRef | undefined;
    if (taskOrRef != null)
      suppliedRef = 'revision' in taskOrRef ? taskOrRef : rootTaskRef(taskOrRef);
    if (
      suppliedRef != null &&
      (selectedRef == null || !this.sameRef_abyssPrivate(suppliedRef, selectedRef))
    )
      return;
    const acknowledged = suppliedRef ?? selectedRef;
    this.ownedWriteRef_abyssPrivate = acknowledged != null ? { ...acknowledged } : undefined;
  }

  private trackOwnWrite_abyssPrivate(event: {
    readonly phase: 'started' | 'settled';
    readonly ref: TaskRef;
  }): void {
    if (event.phase === 'started') {
      this.acknowledgeOwnWrite_abyssPrivate(event.ref);
      return;
    }
    if (
      this.ownedWriteRef_abyssPrivate != null &&
      this.sameRef_abyssPrivate(this.ownedWriteRef_abyssPrivate, event.ref)
    ) {
      this.ownedWriteRef_abyssPrivate = undefined;
    }
  }

  /**
   * Re-points the selection at the command's resulting task while the selection is the command's
   * root. A move that its pending removal cleared follows its task from the selection and the
   * inspector history it began with.
   */
  private convergeOwnCommand_abyssPrivate(
    initiatingRef: TaskRef,
    result: TaskCommandResult,
    origin?: SelectionOrigin,
  ): void {
    if (result.type !== 'ok') return;
    if (result.outcome.type === 'deleted') {
      this.clearDeletedSelection_abyssPrivate(initiatingRef, result.outcome.ref);
      return;
    }
    if (result.outcome.type !== 'task') return;
    this.convergeTaskSelection_abyssPrivate(
      initiatingRef,
      result.outcome.task,
      result.changed,
      origin,
    );
  }

  private convergeTaskSelection_abyssPrivate(
    initiatingRef: TaskRef,
    updated: TaskSnapshot,
    changed: boolean,
    origin?: SelectionOrigin,
  ): void {
    const state = this.state_abyssPrivate;
    const cleared = state.get('taskStack').length === 0 ? origin : undefined;
    const stack = cleared?.taskStack ?? state.get('taskStack');
    const root = stack[0];
    if (root == null || !this.sameRef_abyssPrivate(rootTaskRef(root), initiatingRef)) return;
    const draft = this.right_abyssPrivate.captureDraftState();
    state.batch(() => {
      if (cleared != null) state.set('inspectorBackStack', cleared.inspectorBackStack);
      state.updateInspectorSelection(rebuildTaskSelection(updated, stack));
    });
    // The restored history names lines from before the move. The index proves their successors
    // only until the next write to the note, so they follow the move now.
    if (cleared != null) this.right_abyssPrivate.refreshInspectorHistory();
    this.right_abyssPrivate.restoreDraftState(draft, updated);
    this.ownedWriteRef_abyssPrivate = changed ? { ...updated.ref } : undefined;
  }

  private clearDeletedSelection_abyssPrivate(initiatingRef: TaskRef, deletedRef: TaskRef): void {
    const root = this.state_abyssPrivate.get('taskStack')[0];
    if (root == null) return;
    if (!this.sameRef_abyssPrivate(deletedRef, initiatingRef)) return;
    if (!this.sameRef_abyssPrivate(rootTaskRef(root), initiatingRef)) return;
    this.state_abyssPrivate.set('taskStack', []);
  }

  private sameRef_abyssPrivate(left: TaskRef, right: TaskRef): boolean {
    return (
      left.filePath === right.filePath &&
      left.line === right.line &&
      left.revision === right.revision
    );
  }

  private rightEl_abyssPrivate(): HTMLElement {
    return this.contentEl.querySelector<HTMLElement>('.abyss-right') ?? this.contentEl;
  }

  private clearSelectionMessage_abyssPrivate(): void {
    this.rightEl_abyssPrivate().querySelector('.abyss-task-selection-message')?.remove();
  }
}
