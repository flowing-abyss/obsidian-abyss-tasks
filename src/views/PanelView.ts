import { ItemView, Platform, setIcon, TFile, type WorkspaceLeaf } from 'obsidian';
import { AppState } from '../app/AppState';
import { CenterPanel } from '../panels/CenterPanel';
import { LeftPanel } from '../panels/LeftPanel';
import { RailPanel } from '../panels/RailPanel';
import { RightPanel } from '../panels/RightPanel';
import { ProjectManager } from '../projects/ProjectManager';
import { ProjectStore } from '../projects/ProjectStore';
import { DailyNoteResolver } from '../resolvers/DailyNoteResolver';
import type { ShortcutActionId } from '../settings/shortcuts';
import type { CalendarSettings } from '../settings/types';
import type { StatusRegistry } from '../status/StatusRegistry';
import type { TagManager } from '../tags/TagManager';
import type {
  CommentTimeContextProvider,
  TaskApplicationApi,
  TaskCaptureApplicationApi,
  TaskCommandResult,
  TaskIndexEvent,
  TaskNodeRef,
  TaskQueryApi,
  TaskRef,
  TaskResolution,
} from '../tasks';
import { CreationPresentationController } from '../ui/creation/CreationPresentationController';
import { InteractionRegistry } from '../ui/interactionOwnership';
import { nativeInteractionBlocksPanelShortcuts } from '../ui/nativeInteractionBlocker';
import { PanelShortcutRouter } from '../ui/panelShortcutRouter';
import {
  CaptureTargetResolver,
  type CaptureContext,
} from '../ui/taskCapture/CaptureTargetResolver';
import { QuickCaptureCoordinator } from '../ui/taskCapture/QuickCaptureCoordinator';
import {
  rebuildTaskSelection,
  renamedRootSelection,
  rootTaskRef,
  type TaskSelectionNode,
} from '../ui/taskSelection';
import { PanelNavigator } from './panelNavigation';

export const PANEL_VIEW_TYPE = 'task-calendar-panel';
const PANEL_DISPLAY_TEXT = 'Abyss Tasks';

let panelViewInstanceSequence = 0;
const COMPACT_RIGHT_MAX_REM = 58;
const COMPACT_LEFT_MAX_REM = 38;

type CompactPane = 'left' | 'right';

interface CompactPaneElements {
  readonly left: HTMLElement;
  readonly right: HTMLElement;
  readonly leftButton: HTMLButtonElement;
  readonly rightButton: HTMLButtonElement;
}

interface CompactPaneAccessElements extends CompactPaneElements {
  readonly layout: HTMLElement;
}

interface PendingCompactPane {
  readonly pane: CompactPane;
  readonly moveFocus: boolean;
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
  queries: TaskQueryApi,
  tasks: TaskApplicationApi & TaskCaptureApplicationApi,
  statusRegistry: StatusRegistry,
  onSaveSettings?: () => Promise<void>,
  commentTimeContext?: CommentTimeContextProvider,
];

function rootRefOfNode(target: TaskNodeRef): TaskRef {
  let current = target;
  while (current.type === 'subtask') current = current.ref.parent;
  return current.ref;
}

type TaskCommand = Parameters<TaskApplicationApi['execute']>[0];

type RootlessCommand = Extract<
  TaskCommand,
  { readonly type: 'create' | 'add-dependency' | 'remove-dependency' | 'restore-dependency' }
>;
type DirectTargetCommand = Extract<
  TaskCommand,
  {
    type: 'patch' | 'append-title' | 'set-status' | 'toggle-completion' | 'set-description';
  }
>;
type SubtaskReferenceCommand = Extract<
  TaskCommand,
  { readonly type: 'delete-subtask' | 'reorder-subtask' }
>;
type CommentReferenceCommand = Extract<
  TaskCommand,
  { readonly type: 'update-comment' | 'delete-comment' }
>;

const DIRECT_TARGET_COMMAND_TYPES = new Set<TaskCommand['type']>([
  'patch',
  'append-title',
  'set-status',
  'toggle-completion',
  'set-description',
]);
const SUBTASK_REFERENCE_COMMAND_TYPES = new Set<TaskCommand['type']>([
  'delete-subtask',
  'reorder-subtask',
]);
const COMMENT_REFERENCE_COMMAND_TYPES = new Set<TaskCommand['type']>([
  'update-comment',
  'delete-comment',
]);

function isDirectTargetCommand(command: TaskCommand): command is DirectTargetCommand {
  return DIRECT_TARGET_COMMAND_TYPES.has(command.type);
}

function isSubtaskReferenceCommand(command: TaskCommand): command is SubtaskReferenceCommand {
  return SUBTASK_REFERENCE_COMMAND_TYPES.has(command.type);
}

function isCommentReferenceCommand(command: TaskCommand): command is CommentReferenceCommand {
  return COMMENT_REFERENCE_COMMAND_TYPES.has(command.type);
}

function isRootlessCommand(command: TaskCommand): command is RootlessCommand {
  return (
    command.type === 'create' ||
    command.type === 'add-dependency' ||
    command.type === 'remove-dependency' ||
    command.type === 'restore-dependency'
  );
}

function commandRootRef(command: TaskCommand): TaskRef | undefined {
  if (isRootlessCommand(command)) return undefined;
  if (isDirectTargetCommand(command)) return rootRefOfNode(command.target);
  if (command.type === 'edit-link') {
    return rootRefOfNode(
      command.target.type === 'comment' ? command.target.ref.parent : command.target.target,
    );
  }
  if (command.type === 'add-subtask' || command.type === 'add-comment') {
    return rootRefOfNode(command.parent);
  }
  if (isSubtaskReferenceCommand(command)) {
    return rootRefOfNode(command.subtask.parent);
  }
  if (isCommentReferenceCommand(command)) {
    return rootRefOfNode(command.comment.parent);
  }
  return command.ref;
}

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

function isImeKeyboardEvent(event: KeyboardEvent): boolean {
  const legacyCode = (event as unknown as { readonly keyCode?: number }).keyCode;
  return event.isComposing || legacyCode === 229;
}

function hasVisibleAncestors(element: HTMLElement, ownerWindow: Window | null): boolean {
  let current: HTMLElement | null = element;
  while (current != null) {
    if (current.hidden) return false;
    const style = ownerWindow?.getComputedStyle(current);
    if (style?.display === 'none' || style?.visibility === 'hidden') return false;
    current = current.parentElement;
  }
  return true;
}

function configureCompactPaneElements(elements: CompactPaneAccessElements): void {
  const instanceId = ++panelViewInstanceSequence;
  elements.left.id = `abyss-task-lists-${String(instanceId)}`;
  elements.right.id = `abyss-task-details-${String(instanceId)}`;
  elements.left.tabIndex = -1;
  elements.right.tabIndex = -1;
  elements.left.setAttribute('role', 'region');
  elements.left.setAttribute('aria-label', 'Task lists');
  elements.right.setAttribute('role', 'region');
  elements.right.setAttribute('aria-label', 'Task details');
  elements.leftButton.setAttribute('aria-controls', elements.left.id);
  elements.rightButton.setAttribute('aria-controls', elements.right.id);
}

type ResizeObserverConstructor = new (callback: ResizeObserverCallback) => ResizeObserver;

function isResizeObserverConstructor(value: unknown): value is ResizeObserverConstructor {
  return typeof value === 'function';
}

export class PanelView extends ItemView {
  private state!: AppState;
  private rail!: RailPanel;
  private left!: LeftPanel;
  private center!: CenterPanel;
  private right!: RightPanel;
  private queryUnsub: (() => void) | undefined;
  private modeUnsub: (() => void) | undefined;
  private selectionUnsub: (() => void) | undefined;
  private selectedListRenameUnsub: (() => void) | undefined;
  private projectStore?: ProjectStore;
  private projectStoreUnsub?: () => void;
  private creationPresentation: CreationPresentationController | undefined;
  private ownedWriteRef: TaskRef | undefined = undefined;
  private interactionRegistry: InteractionRegistry<ShortcutActionId> | undefined;
  private quickCapture: QuickCaptureCoordinator | undefined;
  private shortcutRouter: PanelShortcutRouter | undefined;
  private panelNavigation!: PanelNavigator;
  private compactPaneElements: CompactPaneElements | undefined;
  private compactPaneCleanup: (() => void) | undefined;
  private compactPaneRefresh: (() => void) | undefined;
  private compactPaneOpen: CompactPane | null = null;
  private compactTaskSelectionKey: string | undefined = undefined;
  private compactLeftCollapsed = false;
  private compactRightCollapsed = false;
  private pendingCompactPane: PendingCompactPane | undefined = undefined;
  private readonly settings: CalendarSettings;
  private readonly tagManager: TagManager;
  private readonly queries: TaskQueryApi;
  private readonly tasks: TaskApplicationApi & TaskCaptureApplicationApi;
  private readonly statusRegistry: StatusRegistry;
  private readonly onSaveSettings: () => Promise<void>;
  private readonly commentTimeContext: CommentTimeContextProvider | undefined;

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
    ] = dependencies;
    this.settings = settings;
    this.tagManager = tagManager;
    this.queries = queries;
    this.tasks = tasks;
    this.statusRegistry = statusRegistry;
    this.onSaveSettings = onSaveSettings;
    this.commentTimeContext = commentTimeContext;
  }

  override getViewType(): string {
    return PANEL_VIEW_TYPE;
  }
  override getDisplayText(): string {
    return PANEL_DISPLAY_TEXT;
  }
  override getIcon(): string {
    return 'calendar-days';
  }

  override onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass('abyss-panel-view');

    this.state = new AppState();
    this.interactionRegistry = new InteractionRegistry<ShortcutActionId>();
    this.initializeNavigation();
    const selectionTasks = this.createSelectionTasks();
    const elements = this.createLayout();
    const resolver = new DailyNoteResolver(this.app, this.settings);
    const projectStore = new ProjectStore(this.app, this.queries, this.settings);
    projectStore.initialize();
    this.projectStore = projectStore;
    const projectManager = new ProjectManager(this.app, this.settings, resolver, selectionTasks);
    this.createPanels(selectionTasks, projectStore, projectManager);
    this.registerProjectUpdates(projectStore);
    this.registerWorkspaceUpdates();
    this.mountPanels(elements);
    this.initializeCapture(elements, selectionTasks);
    this.subscribeToState(elements.layout);
    this.subscribeToQueries();
    return Promise.resolve();
  }

  private initializeNavigation(): void {
    this.panelNavigation = new PanelNavigator(
      this.state,
      this.settings,
      {
        calendarView: () => this.center.calendarView(),
        setCalendarView: (view) => {
          this.center.setCalendarView(view);
        },
        openQuickCapture: () => {
          this.pendingCompactPane = undefined;
          this.closeCompactPane(false);
          this.quickCapture?.openOrFocus();
        },
      },
      this.onSaveSettings,
    );
    this.selectedListRenameUnsub = this.tagManager.registerSelectedListState({
      getSelectedList: () => this.state.get('selectedList'),
      setSelectedList: (selection) => {
        this.panelNavigation.rebaseListIdentity(selection);
      },
    });
  }

  private createSelectionTasks(): TaskApplicationApi & TaskCaptureApplicationApi {
    return {
      queries: this.tasks.queries,
      planCreate: (destination) => this.tasks.planCreate(destination),
      execute: async (command) => {
        const initiatingRef = commandRootRef(command);
        const result = await this.tasks.execute(command);
        if (initiatingRef != null) this.convergeOwnCommand(initiatingRef, result);
        return result;
      },
    };
  }

  private createLayout(): PanelLayoutElements {
    const layout = this.contentEl.createDiv({ cls: 'abyss-layout abyss-layout--tasks' });
    const railEl = layout.createDiv({ cls: 'abyss-rail' });
    const leftEl = layout.createDiv({ cls: 'abyss-left' });
    const centerShell = layout.createDiv({ cls: 'abyss-center-shell' });
    const compactPaneControls = centerShell.createDiv({
      cls: 'abyss-compact-pane-controls',
      attr: { role: 'toolbar', 'aria-label': 'Task panes' },
    });
    const compactLeftButton = compactPaneControls.createEl('button', {
      cls: 'abyss-compact-pane-button abyss-compact-pane-button--left',
      attr: {
        type: 'button',
        'aria-label': 'Show task lists',
        title: 'Show task lists',
        'aria-expanded': 'false',
      },
    });
    setIcon(compactLeftButton, 'panel-left');
    const compactRightButton = compactPaneControls.createEl('button', {
      cls: 'abyss-compact-pane-button abyss-compact-pane-button--right',
      attr: {
        type: 'button',
        'aria-label': 'Show task details',
        title: 'Show task details',
        'aria-expanded': 'false',
      },
    });
    setIcon(compactRightButton, 'panel-right');
    const centerEl = centerShell.createDiv({ cls: 'abyss-center' });
    const quickCaptureHost = centerShell.createDiv({ cls: 'abyss-quick-capture-host' });
    const rightEl = layout.createDiv({ cls: 'abyss-right' });
    this.mountCompactPaneAccess({
      layout,
      left: leftEl,
      right: rightEl,
      leftButton: compactLeftButton,
      rightButton: compactRightButton,
    });
    const creationFeedback = layout.createDiv({ cls: 'abyss-creation-feedback' });
    this.creationPresentation = new CreationPresentationController({
      host: creationFeedback,
      queries: this.queries,
      reducedMotion: () =>
        creationFeedback.ownerDocument.defaultView?.matchMedia('(prefers-reduced-motion: reduce)')
          .matches ?? false,
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

  private createPanels(
    selectionTasks: TaskApplicationApi & TaskCaptureApplicationApi,
    projectStore: ProjectStore,
    projectManager: ProjectManager,
  ): void {
    this.rail = new RailPanel(this.state, this.app as never, this.panelNavigation);
    this.left = new LeftPanel(
      this.state,
      this.settings,
      this.tagManager,
      this.app,
      this.queries,
      selectionTasks,
      this.onSaveSettings,
      projectStore,
      projectManager,
      this.panelNavigation,
    );
    this.center = new CenterPanel(
      this.state,
      this.app,
      this.settings,
      this.queries,
      this.statusRegistry,
      this.onSaveSettings,
      projectStore,
      projectManager,
      selectionTasks,
      this.commentTimeContext,
      selectionTasks,
      (result, description) => this.creationPresentation?.present(result, description),
      (root) => this.creationPresentation?.afterRender(root),
      this.interactionRegistry,
      this.panelNavigation,
    );
    this.right = new RightPanel(
      this.state,
      this.app,
      this.statusRegistry,
      this.settings,
      undefined,
      this.tasks,
      undefined,
      (event) => {
        this.trackOwnWrite(event);
      },
      this.commentTimeContext,
      this.interactionRegistry,
    );
  }

  private registerProjectUpdates(projectStore: ProjectStore): void {
    this.projectStoreUnsub = projectStore.onUpdate(() => {
      this.left.refresh();
      if (this.state.get('mode') === 'projects') this.center.refresh();
    });
  }

  private registerWorkspaceUpdates(): void {
    this.registerEvent(
      this.app.workspace.on('css-change', () => {
        this.compactPaneRefresh?.();
        this.center.refresh();
      }),
    );

    // Keep project selection / dashboard path valid across note rename & delete.
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (!(file instanceof TFile)) return;
        const sel = this.state.get('selectedList');
        if (typeof sel === 'object' && sel.type === 'project' && sel.path === oldPath) {
          this.panelNavigation.rebaseListIdentity({ type: 'project', path: file.path });
        }
        const panel = this.state.get('projectsPanel');
        if (panel.view === 'dashboard' && panel.path === oldPath) {
          this.state.set('projectsPanel', { view: 'dashboard', path: file.path });
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        const sel = this.state.get('selectedList');
        if (typeof sel === 'object' && sel.type === 'project' && sel.path === file.path) {
          this.panelNavigation.rebaseListIdentity('today');
        }
        const panel = this.state.get('projectsPanel');
        if (panel.view === 'dashboard' && panel.path === file.path) {
          this.state.set('projectsPanel', { view: 'list' });
        }
      }),
    );
  }

  private mountPanels(elements: PanelLayoutElements): void {
    this.rail.mount(elements.rail);
    this.left.mount(elements.left);
    this.center.mount(elements.center);
    this.right.mount(elements.right);
  }

  private initializeCapture(
    elements: PanelLayoutElements,
    selectionTasks: TaskApplicationApi & TaskCaptureApplicationApi,
  ): void {
    const interactionRegistry = this.interactionRegistry;
    if (interactionRegistry === undefined)
      throw new Error('Panel interaction registry is unavailable');
    const captureTargets = new CaptureTargetResolver(selectionTasks, this.settings);
    this.quickCapture = new QuickCaptureCoordinator({
      host: elements.quickCaptureHost,
      context: () => this.quickCaptureContext(),
      resolveTarget: (context) => captureTargets.resolve(context),
      interactionOwnership: interactionRegistry,
      onResult: (result, description) => {
        this.creationPresentation?.present(result, description);
        const pendingPane = this.pendingCompactPane;
        this.pendingCompactPane = undefined;
        if (description.kind === 'success' && pendingPane != null) {
          this.scheduleCompactPaneOpen(pendingPane);
        }
      },
    });
    const ownerDocument = elements.layout.ownerDocument;
    this.shortcutRouter = new PanelShortcutRouter({
      ownerDocument,
      isActive: () => this.ownsPanelShortcuts(),
      settings: () => this.settings.shortcuts,
      platform: { mod: Platform.isMacOS ? 'meta' : 'ctrl' },
      actions: this.panelNavigation,
      registry: interactionRegistry,
      nativeHostBlocks: () => nativeInteractionBlocksPanelShortcuts(ownerDocument),
    });
  }

  private subscribeToState(layout: HTMLElement): void {
    this.modeUnsub = this.state.on('mode', (mode) => {
      layout.className = `abyss-layout abyss-layout--${mode}`;
      if (mode !== 'tasks') {
        this.pendingCompactPane = undefined;
        this.closeCompactPane(false);
      } else if (this.compactRightCollapsed && this.state.get('taskStack').length > 0) {
        this.openCompactPane('right', false);
      }
    });
    this.selectionUnsub = this.state.on('taskStack', (stack) => {
      this.handleTaskStackChange(stack);
    });
  }

  private handleTaskStackChange(stack: readonly TaskSelectionNode[]): void {
    const selected = stack[0];
    const selectedRef = selected == null ? undefined : rootTaskRef(selected);
    const selectionKey =
      selectedRef == null ? undefined : `${selectedRef.filePath}\u0000${String(selectedRef.line)}`;
    this.updateCompactTaskSelection(selectionKey);
    if (this.ownedWriteRef == null) return;
    if (selectedRef == null || !this.sameRef(selectedRef, this.ownedWriteRef)) {
      this.ownedWriteRef = undefined;
    }
  }

  private updateCompactTaskSelection(selectionKey: string | undefined): void {
    const selectionChanged =
      selectionKey !== undefined && selectionKey !== this.compactTaskSelectionKey;
    if (selectionChanged && this.state.get('mode') === 'tasks' && this.compactRightCollapsed) {
      this.openCompactPane('right', false);
    } else if (selectionKey === undefined && this.compactPaneOpen === 'right') {
      this.closeCompactPane(false);
    }
    this.compactTaskSelectionKey = selectionKey;
  }

  private subscribeToQueries(): void {
    this.queryUnsub = this.queries.subscribe((event) => {
      this.left.refresh();
      if (this.state.get('mode') !== 'calendar') this.center.refresh();
      const stack = this.state.get('taskStack');
      if (stack.length === 0) return;
      const root = stack[0];
      const ref = root != null ? rootTaskRef(root) : undefined;
      if (ref == null || !this.affects(event, ref.filePath)) return;
      if (root != null && 'source' in root) {
        const renamed = renamedRootSelection(event, root, this.queries);
        if (renamed != null) {
          const draft = this.right.captureDraftState();
          this.ownedWriteRef = undefined;
          this.state.set('taskStack', rebuildTaskSelection(renamed, stack));
          this.right.restoreDraftState(draft, renamed);
          return;
        }
      }
      this.applyResolution(this.queries.resolve(ref));
    });
  }

  override async onClose(): Promise<void> {
    this.resetCompactPaneState();
    this.destroyInteractionControllers();
    this.releaseSubscriptions();
    this.destroyOwnedViews();
    this.contentEl.empty();
  }

  private resetCompactPaneState(): void {
    this.compactPaneCleanup?.();
    this.compactPaneCleanup = undefined;
    this.compactPaneRefresh = undefined;
    this.closeCompactPane(false);
    this.compactPaneElements = undefined;
    this.compactTaskSelectionKey = undefined;
    this.compactLeftCollapsed = false;
    this.compactRightCollapsed = false;
    this.pendingCompactPane = undefined;
  }

  private destroyInteractionControllers(): void {
    this.shortcutRouter?.destroy();
    this.shortcutRouter = undefined;
    this.quickCapture?.destroy();
    this.quickCapture = undefined;
    this.interactionRegistry?.destroy();
    this.interactionRegistry = undefined;
  }

  private releaseSubscriptions(): void {
    this.modeUnsub?.();
    this.selectionUnsub?.();
    this.selectedListRenameUnsub?.();
    this.queryUnsub?.();
    this.projectStoreUnsub?.();
  }

  private destroyOwnedViews(): void {
    this.creationPresentation?.destroy();
    this.creationPresentation = undefined;
    this.projectStore?.destroy();
    this.rail.destroy();
    this.left.destroy();
    this.center.destroy();
    this.right.destroy();
  }

  private mountCompactPaneAccess(elements: CompactPaneAccessElements): void {
    configureCompactPaneElements(elements);
    this.compactPaneElements = elements;
    const { layout, leftButton, rightButton } = elements;
    const toggleLeft = (): void => {
      this.toggleCompactPane('left');
    };
    const toggleRight = (): void => {
      this.toggleCompactPane('right');
    };
    const ownerDocument = elements.layout.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    const updateCompactWidth = (width?: number): void => {
      const measuredWidth = width ?? layout.getBoundingClientRect().width;
      this.updateCompactPaneAvailability(
        measuredWidth > 0 && Number.isFinite(measuredWidth) ? measuredWidth : Infinity,
        ownerWindow,
      );
    };
    const onWindowResize = (): void => {
      updateCompactWidth();
    };
    this.compactPaneRefresh = onWindowResize;
    const onKeyDown = (event: KeyboardEvent): void => {
      this.handleCompactEscape(event, ownerDocument);
    };
    const onPointerDown = (event: PointerEvent): void => {
      this.handleCompactOutsidePointer(event);
    };
    leftButton.addEventListener('click', toggleLeft);
    rightButton.addEventListener('click', toggleRight);
    ownerDocument.addEventListener('keydown', onKeyDown);
    ownerDocument.addEventListener('pointerdown', onPointerDown, true);
    ownerWindow?.addEventListener('resize', onWindowResize);
    const resizeObserver = this.createCompactResizeObserver(
      layout,
      ownerWindow,
      updateCompactWidth,
    );
    resizeObserver?.observe(layout);
    updateCompactWidth();
    this.compactPaneCleanup = () => {
      leftButton.removeEventListener('click', toggleLeft);
      rightButton.removeEventListener('click', toggleRight);
      ownerDocument.removeEventListener('keydown', onKeyDown);
      ownerDocument.removeEventListener('pointerdown', onPointerDown, true);
      ownerWindow?.removeEventListener('resize', onWindowResize);
      resizeObserver?.disconnect();
      if (this.compactPaneRefresh === onWindowResize) this.compactPaneRefresh = undefined;
    };
  }

  private createCompactResizeObserver(
    layout: HTMLElement,
    ownerWindow: Window | null,
    updateWidth: (width?: number) => void,
  ): ResizeObserver | null {
    const candidate: unknown =
      ownerWindow == null ? undefined : Reflect.get(ownerWindow, 'ResizeObserver');
    if (!isResizeObserverConstructor(candidate)) return null;
    return new candidate((entries) => {
      const entry = entries.find((candidate) => candidate.target === layout);
      updateWidth(entry?.contentRect.width);
    });
  }

  private handleCompactEscape(event: KeyboardEvent, ownerDocument: Document): void {
    const pane = this.compactPaneOpen;
    if (
      event.key !== 'Escape' ||
      isImeKeyboardEvent(event) ||
      event.defaultPrevented ||
      pane === null ||
      !this.isCompactPaneCollapsed(pane) ||
      this.interactionRegistry?.allows('openCalendar') === false ||
      nativeInteractionBlocksPanelShortcuts(ownerDocument)
    ) {
      return;
    }
    event.preventDefault();
    this.closeCompactPane(true);
  }

  private handleCompactOutsidePointer(event: PointerEvent): void {
    const elements = this.compactPaneElements;
    const pane = this.compactPaneOpen;
    if (
      elements == null ||
      pane === null ||
      !this.isCompactPaneCollapsed(pane) ||
      this.interactionRegistry?.allows('openCalendar') === false
    ) {
      return;
    }
    const path = event.composedPath();
    const activePane = pane === 'left' ? elements.left : elements.right;
    if (
      path.includes(activePane) ||
      path.includes(elements.leftButton) ||
      path.includes(elements.rightButton)
    ) {
      return;
    }
    this.closeCompactPane(false);
  }

  private toggleCompactPane(pane: CompactPane): void {
    if (this.compactPaneOpen === pane) {
      this.closeCompactPane(true);
      return;
    }
    this.openCompactPane(pane, true);
  }

  private openCompactPane(pane: CompactPane, moveFocus: boolean): void {
    const elements = this.compactPaneElements;
    if (
      elements == null ||
      !this.isCompactPaneCollapsed(pane) ||
      this.state.get('mode') !== 'tasks'
    ) {
      return;
    }
    const quickCapture = this.quickCapture;
    if (quickCapture != null && quickCapture.phase !== 'closed') {
      if (quickCapture.isSubmitting) this.pendingCompactPane = { pane, moveFocus };
      return;
    }
    const activePane = pane === 'left' ? elements.left : elements.right;
    const inactivePane = pane === 'left' ? elements.right : elements.left;
    activePane.addClass('is-compact-open');
    inactivePane.removeClass('is-compact-open');
    this.setCompactPaneButtonState(elements.leftButton, 'task lists', pane === 'left');
    this.setCompactPaneButtonState(elements.rightButton, 'task details', pane === 'right');
    this.compactPaneOpen = pane;
    if (moveFocus) activePane.focus({ preventScroll: true });
  }

  private scheduleCompactPaneOpen(pending: PendingCompactPane): void {
    void Promise.resolve().then(
      () => {
        this.openCompactPane(pending.pane, pending.moveFocus);
      },
      () => undefined,
    );
  }

  private closeCompactPane(restoreFocus: boolean): void {
    const elements = this.compactPaneElements;
    const pane = this.compactPaneOpen;
    this.compactPaneOpen = null;
    if (elements == null) return;
    elements.left.removeClass('is-compact-open');
    elements.right.removeClass('is-compact-open');
    this.setCompactPaneButtonState(elements.leftButton, 'task lists', false);
    this.setCompactPaneButtonState(elements.rightButton, 'task details', false);
    if (restoreFocus && pane !== null) {
      const button = pane === 'left' ? elements.leftButton : elements.rightButton;
      if (button.isConnected) button.focus({ preventScroll: true });
    }
  }

  private setCompactPaneButtonState(
    button: HTMLButtonElement,
    label: string,
    expanded: boolean,
  ): void {
    const action = expanded ? 'Hide' : 'Show';
    const description = `${action} ${label}`;
    button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    button.setAttribute('aria-label', description);
    button.setAttribute('title', description);
  }

  private updateCompactPaneAvailability(width: number, ownerWindow: Window | null): void {
    const rem = this.rootFontSize(ownerWindow);
    const wasRightCollapsed = this.compactRightCollapsed;
    this.compactRightCollapsed = width <= COMPACT_RIGHT_MAX_REM * rem;
    this.compactLeftCollapsed = width <= COMPACT_LEFT_MAX_REM * rem;
    this.discardExpandedPendingPane();
    this.closeExpandedCompactPane();
    this.openNewlyCollapsedTaskDetails(wasRightCollapsed);
  }

  private rootFontSize(ownerWindow: Window | null): number {
    const value = Number.parseFloat(
      ownerWindow?.getComputedStyle(this.contentEl.ownerDocument.documentElement).fontSize ?? '',
    );
    return Number.isFinite(value) && value > 0 ? value : 16;
  }

  private discardExpandedPendingPane(): void {
    const pending = this.pendingCompactPane;
    if (pending != null && !this.isCompactPaneCollapsed(pending.pane)) {
      this.pendingCompactPane = undefined;
    }
  }

  private closeExpandedCompactPane(): void {
    const pane = this.compactPaneOpen;
    if (pane !== null && !this.isCompactPaneCollapsed(pane)) this.closeCompactPane(false);
  }

  private openNewlyCollapsedTaskDetails(wasRightCollapsed: boolean): void {
    if (
      !wasRightCollapsed &&
      this.compactRightCollapsed &&
      this.state.get('mode') === 'tasks' &&
      this.state.get('taskStack').length > 0
    ) {
      this.openCompactPane('right', false);
    }
  }

  private isCompactPaneCollapsed(pane: CompactPane): boolean {
    return pane === 'left' ? this.compactLeftCollapsed : this.compactRightCollapsed;
  }

  private quickCaptureContext(): CaptureContext {
    const mode = this.state.get('mode');
    if (mode === 'tasks') {
      return { type: 'list', selection: this.state.get('selectedList') };
    }
    if (mode === 'projects') {
      const projectsPanel = this.state.get('projectsPanel');
      if (projectsPanel.view === 'dashboard') {
        return { type: 'project-dashboard', path: projectsPanel.path };
      }
    }
    return { type: 'default', source: mode };
  }

  private ownsPanelShortcuts(): boolean {
    if (!this.isActiveConnectedPanel()) return false;
    const ownerWindow = this.contentEl.ownerDocument.defaultView;
    if (!hasVisibleAncestors(this.contentEl, ownerWindow)) return false;
    return (
      hasPresentedPanelGeometry(this.containerEl, ownerWindow ?? null) &&
      hasPresentedPanelGeometry(this.contentEl, ownerWindow ?? null)
    );
  }

  private isActiveConnectedPanel(): boolean {
    return this.app.workspace.getActiveViewOfType(PanelView) === this && this.contentEl.isConnected;
  }

  private affects(event: TaskIndexEvent, path: string): boolean {
    if (event.type === 'initialized') return true;
    if (event.type === 'changed') return event.files.includes(path);
    if (event.type === 'renamed') return event.oldPath === path || event.newPath === path;
    return event.path === path;
  }

  private applyResolution(resolution: TaskResolution): void {
    const stack = this.state.get('taskStack');
    this.clearSelectionMessage();
    if (resolution.type === 'exact' || resolution.type === 'rebased') {
      this.applyResolvedSelection(resolution, stack);
      return;
    }
    const draft = this.right.captureDraftState();
    this.ownedWriteRef = undefined;
    if (resolution.type === 'visual') {
      this.state.set('taskStack', [resolution.current]);
      this.right.detachDraftState(draft);
      return;
    }
    this.state.set('taskStack', []);
    this.right.detachDraftState(draft);
  }

  private applyResolvedSelection(
    resolution: Extract<TaskResolution, { readonly type: 'exact' | 'rebased' }>,
    stack: readonly TaskSelectionNode[],
  ): void {
    const current = resolution.type === 'exact' ? resolution.task : resolution.current;
    const consumedOwnedRef = this.consumedOwnedRef(resolution);
    const draft =
      consumedOwnedRef != null
        ? this.right.captureDraftStateForOwnedTransition(consumedOwnedRef, current.ref)
        : this.right.captureDraftState();
    this.ownedWriteRef = undefined;
    this.state.set(
      'taskStack',
      rebuildTaskSelection(current, stack, {
        preserveDependencyChanges:
          resolution.type === 'rebased' && resolution.evidence === 'authority-transition',
      }),
    );
    this.right.restoreDraftState(draft, current);
  }

  private consumedOwnedRef(
    resolution: Extract<TaskResolution, { readonly type: 'exact' | 'rebased' }>,
  ): TaskRef | undefined {
    if (resolution.type !== 'rebased' || resolution.evidence !== 'authority-transition') {
      return undefined;
    }
    const ownedWriteRef = this.ownedWriteRef;
    return ownedWriteRef != null && this.sameRef(ownedWriteRef, resolution.previous.ref)
      ? ownedWriteRef
      : undefined;
  }

  private acknowledgeOwnWrite(taskOrRef?: TaskSelectionNode | TaskRef): void {
    const selected = this.state.get('taskStack')[0];
    const selectedRef = selected != null ? rootTaskRef(selected) : undefined;
    let suppliedRef: TaskRef | undefined;
    if (taskOrRef != null)
      suppliedRef = 'revision' in taskOrRef ? taskOrRef : rootTaskRef(taskOrRef);
    if (suppliedRef != null && (selectedRef == null || !this.sameRef(suppliedRef, selectedRef)))
      return;
    const acknowledged = suppliedRef ?? selectedRef;
    this.ownedWriteRef = acknowledged != null ? { ...acknowledged } : undefined;
  }

  private trackOwnWrite(event: {
    readonly phase: 'started' | 'settled';
    readonly ref: TaskRef;
  }): void {
    if (event.phase === 'started') {
      this.acknowledgeOwnWrite(event.ref);
      return;
    }
    if (this.ownedWriteRef != null && this.sameRef(this.ownedWriteRef, event.ref)) {
      this.ownedWriteRef = undefined;
    }
  }

  private convergeOwnCommand(initiatingRef: TaskRef, result: TaskCommandResult): void {
    if (result.type !== 'ok' || result.outcome.type !== 'task') return;
    const stack = this.state.get('taskStack');
    const selectedRef = stack[0] != null ? rootTaskRef(stack[0]) : undefined;
    if (selectedRef == null || !this.sameRef(selectedRef, initiatingRef)) return;
    const updated = result.outcome.task;
    const draft = this.right.captureDraftState();
    this.state.set('taskStack', rebuildTaskSelection(updated, stack));
    this.right.restoreDraftState(draft, updated);
    this.ownedWriteRef = result.changed ? { ...updated.ref } : undefined;
  }

  private sameRef(left: TaskRef, right: TaskRef): boolean {
    return (
      left.filePath === right.filePath &&
      left.line === right.line &&
      left.revision === right.revision
    );
  }

  private rightEl(): HTMLElement {
    return this.contentEl.querySelector<HTMLElement>('.abyss-right') ?? this.contentEl;
  }

  private clearSelectionMessage(): void {
    this.rightEl().querySelector('.abyss-task-selection-message')?.remove();
  }
}
