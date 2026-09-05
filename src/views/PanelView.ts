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
  if (
    command.type === 'add-subtask' ||
    command.type === 'restore-subtask' ||
    command.type === 'add-comment'
  ) {
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
  private state_abyssPrivate!: AppState;
  private rail_abyssPrivate!: RailPanel;
  private left_abyssPrivate!: LeftPanel;
  private center_abyssPrivate!: CenterPanel;
  private right_abyssPrivate!: RightPanel;
  private queryUnsub_abyssPrivate: (() => void) | undefined;
  private modeUnsub_abyssPrivate: (() => void) | undefined;
  private selectionUnsub_abyssPrivate: (() => void) | undefined;
  private selectedListRenameUnsub_abyssPrivate: (() => void) | undefined;
  private projectStore_abyssPrivate?: ProjectStore;
  private projectStoreUnsub_abyssPrivate?: () => void;
  private creationPresentation_abyssPrivate: CreationPresentationController | undefined;
  private ownedWriteRef_abyssPrivate: TaskRef | undefined = undefined;
  private interactionRegistry_abyssPrivate: InteractionRegistry<ShortcutActionId> | undefined;
  private quickCapture_abyssPrivate: QuickCaptureCoordinator | undefined;
  private shortcutRouter_abyssPrivate: PanelShortcutRouter | undefined;
  private panelNavigation_abyssPrivate!: PanelNavigator;
  private compactPaneElements_abyssPrivate: CompactPaneElements | undefined;
  private compactPaneCleanup_abyssPrivate: (() => void) | undefined;
  private compactPaneRefresh_abyssPrivate: (() => void) | undefined;
  private compactPaneOpen_abyssPrivate: CompactPane | null = null;
  private compactTaskSelectionKey_abyssPrivate: string | undefined = undefined;
  private compactLeftCollapsed_abyssPrivate = false;
  private compactRightCollapsed_abyssPrivate = false;
  private pendingCompactPane_abyssPrivate: PendingCompactPane | undefined = undefined;
  private readonly settings_abyssPrivate: CalendarSettings;
  private readonly tagManager_abyssPrivate: TagManager;
  private readonly queries_abyssPrivate: TaskQueryApi;
  private readonly tasks_abyssPrivate: TaskApplicationApi & TaskCaptureApplicationApi;
  private readonly statusRegistry_abyssPrivate: StatusRegistry;
  private readonly onSaveSettings_abyssPrivate: () => Promise<void>;
  private readonly commentTimeContext_abyssPrivate: CommentTimeContextProvider | undefined;

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
    this.settings_abyssPrivate = settings;
    this.tagManager_abyssPrivate = tagManager;
    this.queries_abyssPrivate = queries;
    this.tasks_abyssPrivate = tasks;
    this.statusRegistry_abyssPrivate = statusRegistry;
    this.onSaveSettings_abyssPrivate = onSaveSettings;
    this.commentTimeContext_abyssPrivate = commentTimeContext;
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

    this.state_abyssPrivate = new AppState();
    this.interactionRegistry_abyssPrivate = new InteractionRegistry<ShortcutActionId>();
    this.initializeNavigation_abyssPrivate();
    const selectionTasks = this.createSelectionTasks_abyssPrivate();
    const elements = this.createLayout_abyssPrivate();
    const resolver = new DailyNoteResolver(this.app, this.settings_abyssPrivate);
    const projectStore = new ProjectStore(
      this.app,
      this.queries_abyssPrivate,
      this.settings_abyssPrivate,
    );
    projectStore.initialize();
    this.projectStore_abyssPrivate = projectStore;
    const projectManager = new ProjectManager(
      this.app,
      this.settings_abyssPrivate,
      resolver,
      selectionTasks,
    );
    this.createPanels_abyssPrivate(selectionTasks, projectStore, projectManager);
    this.registerProjectUpdates_abyssPrivate(projectStore);
    this.registerWorkspaceUpdates_abyssPrivate();
    this.mountPanels_abyssPrivate(elements);
    this.initializeCapture_abyssPrivate(elements, selectionTasks);
    this.subscribeToState_abyssPrivate(elements.layout);
    this.subscribeToQueries_abyssPrivate();
    return Promise.resolve();
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
          this.pendingCompactPane_abyssPrivate = undefined;
          this.closeCompactPane_abyssPrivate(false);
          this.quickCapture_abyssPrivate?.openOrFocus();
        },
      },
      this.onSaveSettings_abyssPrivate,
    );
    this.selectedListRenameUnsub_abyssPrivate =
      this.tagManager_abyssPrivate.registerSelectedListState({
        getSelectedList: () => this.state_abyssPrivate.get('selectedList'),
        setSelectedList: (selection) => {
          this.panelNavigation_abyssPrivate.rebaseListIdentity(selection);
        },
      });
  }

  private createSelectionTasks_abyssPrivate(): TaskApplicationApi & TaskCaptureApplicationApi {
    return {
      queries: this.tasks_abyssPrivate.queries,
      planCreate: (destination) => this.tasks_abyssPrivate.planCreate(destination),
      execute: async (command) => {
        const initiatingRef = commandRootRef(command);
        const result = await this.tasks_abyssPrivate.execute(command);
        if (initiatingRef != null) this.convergeOwnCommand_abyssPrivate(initiatingRef, result);
        return result;
      },
    };
  }

  private createLayout_abyssPrivate(): PanelLayoutElements {
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
    this.mountCompactPaneAccess_abyssPrivate({
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

  private createPanels_abyssPrivate(
    selectionTasks: TaskApplicationApi & TaskCaptureApplicationApi,
    projectStore: ProjectStore,
    projectManager: ProjectManager,
  ): void {
    this.rail_abyssPrivate = new RailPanel(
      this.state_abyssPrivate,
      this.app as never,
      this.panelNavigation_abyssPrivate,
    );
    this.left_abyssPrivate = new LeftPanel(
      this.state_abyssPrivate,
      this.settings_abyssPrivate,
      this.tagManager_abyssPrivate,
      this.app,
      this.queries_abyssPrivate,
      selectionTasks,
      this.onSaveSettings_abyssPrivate,
      projectStore,
      projectManager,
      this.panelNavigation_abyssPrivate,
    );
    this.center_abyssPrivate = new CenterPanel(
      this.state_abyssPrivate,
      this.app,
      this.settings_abyssPrivate,
      this.queries_abyssPrivate,
      this.statusRegistry_abyssPrivate,
      this.onSaveSettings_abyssPrivate,
      projectStore,
      projectManager,
      selectionTasks,
      this.commentTimeContext_abyssPrivate,
      selectionTasks,
      (result, description) => this.creationPresentation_abyssPrivate?.present(result, description),
      (root) => this.creationPresentation_abyssPrivate?.afterRender(root),
      this.interactionRegistry_abyssPrivate,
      this.panelNavigation_abyssPrivate,
    );
    this.right_abyssPrivate = new RightPanel(
      this.state_abyssPrivate,
      this.app,
      this.statusRegistry_abyssPrivate,
      this.settings_abyssPrivate,
      undefined,
      this.tasks_abyssPrivate,
      undefined,
      (event) => {
        this.trackOwnWrite_abyssPrivate(event);
      },
      this.commentTimeContext_abyssPrivate,
      this.interactionRegistry_abyssPrivate,
    );
  }

  private registerProjectUpdates_abyssPrivate(projectStore: ProjectStore): void {
    this.projectStoreUnsub_abyssPrivate = projectStore.onUpdate(() => {
      this.left_abyssPrivate.refresh();
      if (this.state_abyssPrivate.get('mode') === 'projects') this.center_abyssPrivate.refresh();
    });
  }

  private registerWorkspaceUpdates_abyssPrivate(): void {
    this.registerEvent(
      this.app.workspace.on('css-change', () => {
        this.compactPaneRefresh_abyssPrivate?.();
        this.center_abyssPrivate.refresh();
      }),
    );

    // Keep project selection / dashboard path valid across note rename & delete.
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (!(file instanceof TFile)) return;
        const sel = this.state_abyssPrivate.get('selectedList');
        if (typeof sel === 'object' && sel.type === 'project' && sel.path === oldPath) {
          this.panelNavigation_abyssPrivate.rebaseListIdentity({
            type: 'project',
            path: file.path,
          });
        }
        const panel = this.state_abyssPrivate.get('projectsPanel');
        if (panel.view === 'dashboard' && panel.path === oldPath) {
          this.state_abyssPrivate.set('projectsPanel', { view: 'dashboard', path: file.path });
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        const sel = this.state_abyssPrivate.get('selectedList');
        if (typeof sel === 'object' && sel.type === 'project' && sel.path === file.path) {
          this.panelNavigation_abyssPrivate.rebaseListIdentity('today');
        }
        const panel = this.state_abyssPrivate.get('projectsPanel');
        if (panel.view === 'dashboard' && panel.path === file.path) {
          this.state_abyssPrivate.set('projectsPanel', { view: 'list' });
        }
      }),
    );
  }

  private mountPanels_abyssPrivate(elements: PanelLayoutElements): void {
    this.rail_abyssPrivate.mount(elements.rail);
    this.left_abyssPrivate.mount(elements.left);
    this.center_abyssPrivate.mount(elements.center);
    this.right_abyssPrivate.mount(elements.right);
  }

  private initializeCapture_abyssPrivate(
    elements: PanelLayoutElements,
    selectionTasks: TaskApplicationApi & TaskCaptureApplicationApi,
  ): void {
    const interactionRegistry = this.interactionRegistry_abyssPrivate;
    if (interactionRegistry === undefined)
      throw new Error('Panel interaction registry is unavailable');
    const captureTargets = new CaptureTargetResolver(selectionTasks, this.settings_abyssPrivate);
    this.quickCapture_abyssPrivate = new QuickCaptureCoordinator({
      host: elements.quickCaptureHost,
      context: () => this.quickCaptureContext_abyssPrivate(),
      resolveTarget: (context) => captureTargets.resolve(context),
      interactionOwnership: interactionRegistry,
      onResult: (result, description) => {
        this.creationPresentation_abyssPrivate?.present(result, description);
        const pendingPane = this.pendingCompactPane_abyssPrivate;
        this.pendingCompactPane_abyssPrivate = undefined;
        if (description.kind === 'success' && pendingPane != null) {
          this.scheduleCompactPaneOpen_abyssPrivate(pendingPane);
        }
      },
    });
    const ownerDocument = elements.layout.ownerDocument;
    this.shortcutRouter_abyssPrivate = new PanelShortcutRouter({
      ownerDocument,
      isActive: () => this.ownsPanelShortcuts_abyssPrivate(),
      settings: () => this.settings_abyssPrivate.shortcuts,
      platform: { mod: Platform.isMacOS ? 'meta' : 'ctrl' },
      actions: this.panelNavigation_abyssPrivate,
      registry: interactionRegistry,
      nativeHostBlocks: () => nativeInteractionBlocksPanelShortcuts(ownerDocument),
    });
  }

  private subscribeToState_abyssPrivate(layout: HTMLElement): void {
    this.modeUnsub_abyssPrivate = this.state_abyssPrivate.on('mode', (mode) => {
      layout.className = `abyss-layout abyss-layout--${mode}`;
      if (mode !== 'tasks') {
        this.pendingCompactPane_abyssPrivate = undefined;
        this.closeCompactPane_abyssPrivate(false);
      } else if (
        this.compactRightCollapsed_abyssPrivate &&
        this.state_abyssPrivate.get('taskStack').length > 0
      ) {
        this.openCompactPane_abyssPrivate('right', false);
      }
    });
    this.selectionUnsub_abyssPrivate = this.state_abyssPrivate.on('taskStack', (stack) => {
      this.handleTaskStackChange_abyssPrivate(stack);
    });
  }

  private handleTaskStackChange_abyssPrivate(stack: readonly TaskSelectionNode[]): void {
    const selected = stack[0];
    const selectedRef = selected == null ? undefined : rootTaskRef(selected);
    const selectionKey =
      selectedRef == null ? undefined : `${selectedRef.filePath}\u0000${String(selectedRef.line)}`;
    this.updateCompactTaskSelection_abyssPrivate(selectionKey);
    if (this.ownedWriteRef_abyssPrivate == null) return;
    if (
      selectedRef == null ||
      !this.sameRef_abyssPrivate(selectedRef, this.ownedWriteRef_abyssPrivate)
    ) {
      this.ownedWriteRef_abyssPrivate = undefined;
    }
  }

  private updateCompactTaskSelection_abyssPrivate(selectionKey: string | undefined): void {
    const selectionChanged =
      selectionKey !== undefined && selectionKey !== this.compactTaskSelectionKey_abyssPrivate;
    if (
      selectionChanged &&
      this.state_abyssPrivate.get('mode') === 'tasks' &&
      this.compactRightCollapsed_abyssPrivate
    ) {
      this.openCompactPane_abyssPrivate('right', false);
    } else if (selectionKey === undefined && this.compactPaneOpen_abyssPrivate === 'right') {
      this.closeCompactPane_abyssPrivate(false);
    }
    this.compactTaskSelectionKey_abyssPrivate = selectionKey;
  }

  private subscribeToQueries_abyssPrivate(): void {
    this.queryUnsub_abyssPrivate = this.queries_abyssPrivate.subscribe((event) => {
      this.left_abyssPrivate.refresh();
      if (this.state_abyssPrivate.get('mode') !== 'calendar') this.center_abyssPrivate.refresh();
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
      this.applyResolution_abyssPrivate(this.queries_abyssPrivate.resolve(ref));
    });
  }

  override async onClose(): Promise<void> {
    this.resetCompactPaneState_abyssPrivate();
    this.destroyInteractionControllers_abyssPrivate();
    this.releaseSubscriptions_abyssPrivate();
    this.destroyOwnedViews_abyssPrivate();
    this.contentEl.empty();
  }

  private resetCompactPaneState_abyssPrivate(): void {
    this.compactPaneCleanup_abyssPrivate?.();
    this.compactPaneCleanup_abyssPrivate = undefined;
    this.compactPaneRefresh_abyssPrivate = undefined;
    this.closeCompactPane_abyssPrivate(false);
    this.compactPaneElements_abyssPrivate = undefined;
    this.compactTaskSelectionKey_abyssPrivate = undefined;
    this.compactLeftCollapsed_abyssPrivate = false;
    this.compactRightCollapsed_abyssPrivate = false;
    this.pendingCompactPane_abyssPrivate = undefined;
  }

  private destroyInteractionControllers_abyssPrivate(): void {
    this.shortcutRouter_abyssPrivate?.destroy();
    this.shortcutRouter_abyssPrivate = undefined;
    this.quickCapture_abyssPrivate?.destroy();
    this.quickCapture_abyssPrivate = undefined;
    this.interactionRegistry_abyssPrivate?.destroy();
    this.interactionRegistry_abyssPrivate = undefined;
  }

  private releaseSubscriptions_abyssPrivate(): void {
    this.modeUnsub_abyssPrivate?.();
    this.selectionUnsub_abyssPrivate?.();
    this.selectedListRenameUnsub_abyssPrivate?.();
    this.queryUnsub_abyssPrivate?.();
    this.projectStoreUnsub_abyssPrivate?.();
  }

  private destroyOwnedViews_abyssPrivate(): void {
    this.creationPresentation_abyssPrivate?.destroy();
    this.creationPresentation_abyssPrivate = undefined;
    this.projectStore_abyssPrivate?.destroy();
    this.rail_abyssPrivate.destroy();
    this.left_abyssPrivate.destroy();
    this.center_abyssPrivate.destroy();
    this.right_abyssPrivate.destroy();
  }

  private mountCompactPaneAccess_abyssPrivate(elements: CompactPaneAccessElements): void {
    configureCompactPaneElements(elements);
    this.compactPaneElements_abyssPrivate = elements;
    const { layout, leftButton, rightButton } = elements;
    const toggleLeft = (): void => {
      this.toggleCompactPane_abyssPrivate('left');
    };
    const toggleRight = (): void => {
      this.toggleCompactPane_abyssPrivate('right');
    };
    const ownerDocument = elements.layout.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    const updateCompactWidth = (width?: number): void => {
      const measuredWidth = width ?? layout.getBoundingClientRect().width;
      this.updateCompactPaneAvailability_abyssPrivate(
        measuredWidth > 0 && Number.isFinite(measuredWidth) ? measuredWidth : Infinity,
        ownerWindow,
      );
    };
    const onWindowResize = (): void => {
      updateCompactWidth();
    };
    this.compactPaneRefresh_abyssPrivate = onWindowResize;
    const onKeyDown = (event: KeyboardEvent): void => {
      this.handleCompactEscape_abyssPrivate(event, ownerDocument);
    };
    const onPointerDown = (event: PointerEvent): void => {
      this.handleCompactOutsidePointer_abyssPrivate(event);
    };
    leftButton.addEventListener('click', toggleLeft);
    rightButton.addEventListener('click', toggleRight);
    ownerDocument.addEventListener('keydown', onKeyDown);
    ownerDocument.addEventListener('pointerdown', onPointerDown, true);
    ownerWindow?.addEventListener('resize', onWindowResize);
    const resizeObserver = this.createCompactResizeObserver_abyssPrivate(
      layout,
      ownerWindow,
      updateCompactWidth,
    );
    resizeObserver?.observe(layout);
    updateCompactWidth();
    this.compactPaneCleanup_abyssPrivate = () => {
      leftButton.removeEventListener('click', toggleLeft);
      rightButton.removeEventListener('click', toggleRight);
      ownerDocument.removeEventListener('keydown', onKeyDown);
      ownerDocument.removeEventListener('pointerdown', onPointerDown, true);
      ownerWindow?.removeEventListener('resize', onWindowResize);
      resizeObserver?.disconnect();
      if (this.compactPaneRefresh_abyssPrivate === onWindowResize)
        this.compactPaneRefresh_abyssPrivate = undefined;
    };
  }

  private createCompactResizeObserver_abyssPrivate(
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

  private handleCompactEscape_abyssPrivate(event: KeyboardEvent, ownerDocument: Document): void {
    const pane = this.compactPaneOpen_abyssPrivate;
    if (
      event.key !== 'Escape' ||
      isImeKeyboardEvent(event) ||
      event.defaultPrevented ||
      pane === null ||
      !this.isCompactPaneCollapsed_abyssPrivate(pane) ||
      this.interactionRegistry_abyssPrivate?.allows('openCalendar') === false ||
      nativeInteractionBlocksPanelShortcuts(ownerDocument)
    ) {
      return;
    }
    event.preventDefault();
    this.closeCompactPane_abyssPrivate(true);
  }

  private handleCompactOutsidePointer_abyssPrivate(event: PointerEvent): void {
    const elements = this.compactPaneElements_abyssPrivate;
    const pane = this.compactPaneOpen_abyssPrivate;
    if (
      elements == null ||
      pane === null ||
      !this.isCompactPaneCollapsed_abyssPrivate(pane) ||
      this.interactionRegistry_abyssPrivate?.allows('openCalendar') === false
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
    this.closeCompactPane_abyssPrivate(false);
  }

  private toggleCompactPane_abyssPrivate(pane: CompactPane): void {
    if (this.compactPaneOpen_abyssPrivate === pane) {
      this.closeCompactPane_abyssPrivate(true);
      return;
    }
    this.openCompactPane_abyssPrivate(pane, true);
  }

  private openCompactPane_abyssPrivate(pane: CompactPane, moveFocus: boolean): void {
    const elements = this.compactPaneElements_abyssPrivate;
    if (
      elements == null ||
      !this.isCompactPaneCollapsed_abyssPrivate(pane) ||
      this.state_abyssPrivate.get('mode') !== 'tasks'
    ) {
      return;
    }
    const quickCapture = this.quickCapture_abyssPrivate;
    if (quickCapture != null && quickCapture.phase !== 'closed') {
      if (quickCapture.isSubmitting) this.pendingCompactPane_abyssPrivate = { pane, moveFocus };
      return;
    }
    const activePane = pane === 'left' ? elements.left : elements.right;
    const inactivePane = pane === 'left' ? elements.right : elements.left;
    activePane.addClass('is-compact-open');
    inactivePane.removeClass('is-compact-open');
    this.setCompactPaneButtonState_abyssPrivate(elements.leftButton, 'task lists', pane === 'left');
    this.setCompactPaneButtonState_abyssPrivate(
      elements.rightButton,
      'task details',
      pane === 'right',
    );
    this.compactPaneOpen_abyssPrivate = pane;
    if (moveFocus) activePane.focus({ preventScroll: true });
  }

  private scheduleCompactPaneOpen_abyssPrivate(pending: PendingCompactPane): void {
    void Promise.resolve().then(
      () => {
        this.openCompactPane_abyssPrivate(pending.pane, pending.moveFocus);
      },
      () => undefined,
    );
  }

  private closeCompactPane_abyssPrivate(restoreFocus: boolean): void {
    const elements = this.compactPaneElements_abyssPrivate;
    const pane = this.compactPaneOpen_abyssPrivate;
    this.compactPaneOpen_abyssPrivate = null;
    if (elements == null) return;
    elements.left.removeClass('is-compact-open');
    elements.right.removeClass('is-compact-open');
    this.setCompactPaneButtonState_abyssPrivate(elements.leftButton, 'task lists', false);
    this.setCompactPaneButtonState_abyssPrivate(elements.rightButton, 'task details', false);
    if (restoreFocus && pane !== null) {
      const button = pane === 'left' ? elements.leftButton : elements.rightButton;
      if (button.isConnected) button.focus({ preventScroll: true });
    }
  }

  private setCompactPaneButtonState_abyssPrivate(
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

  private updateCompactPaneAvailability_abyssPrivate(
    width: number,
    ownerWindow: Window | null,
  ): void {
    const rem = this.rootFontSize_abyssPrivate(ownerWindow);
    const wasRightCollapsed = this.compactRightCollapsed_abyssPrivate;
    this.compactRightCollapsed_abyssPrivate = width <= COMPACT_RIGHT_MAX_REM * rem;
    this.compactLeftCollapsed_abyssPrivate = width <= COMPACT_LEFT_MAX_REM * rem;
    this.discardExpandedPendingPane_abyssPrivate();
    this.closeExpandedCompactPane_abyssPrivate();
    this.openNewlyCollapsedTaskDetails_abyssPrivate(wasRightCollapsed);
  }

  private rootFontSize_abyssPrivate(ownerWindow: Window | null): number {
    const value = Number.parseFloat(
      ownerWindow?.getComputedStyle(this.contentEl.ownerDocument.documentElement).fontSize ?? '',
    );
    return Number.isFinite(value) && value > 0 ? value : 16;
  }

  private discardExpandedPendingPane_abyssPrivate(): void {
    const pending = this.pendingCompactPane_abyssPrivate;
    if (pending != null && !this.isCompactPaneCollapsed_abyssPrivate(pending.pane)) {
      this.pendingCompactPane_abyssPrivate = undefined;
    }
  }

  private closeExpandedCompactPane_abyssPrivate(): void {
    const pane = this.compactPaneOpen_abyssPrivate;
    if (pane !== null && !this.isCompactPaneCollapsed_abyssPrivate(pane))
      this.closeCompactPane_abyssPrivate(false);
  }

  private openNewlyCollapsedTaskDetails_abyssPrivate(wasRightCollapsed: boolean): void {
    if (
      !wasRightCollapsed &&
      this.compactRightCollapsed_abyssPrivate &&
      this.state_abyssPrivate.get('mode') === 'tasks' &&
      this.state_abyssPrivate.get('taskStack').length > 0
    ) {
      this.openCompactPane_abyssPrivate('right', false);
    }
  }

  private isCompactPaneCollapsed_abyssPrivate(pane: CompactPane): boolean {
    return pane === 'left'
      ? this.compactLeftCollapsed_abyssPrivate
      : this.compactRightCollapsed_abyssPrivate;
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
    this.state_abyssPrivate.set('taskStack', []);
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

  private convergeOwnCommand_abyssPrivate(initiatingRef: TaskRef, result: TaskCommandResult): void {
    if (result.type !== 'ok' || result.outcome.type !== 'task') return;
    const stack = this.state_abyssPrivate.get('taskStack');
    const selectedRef = stack[0] != null ? rootTaskRef(stack[0]) : undefined;
    if (selectedRef == null || !this.sameRef_abyssPrivate(selectedRef, initiatingRef)) return;
    const updated = result.outcome.task;
    const draft = this.right_abyssPrivate.captureDraftState();
    this.state_abyssPrivate.updateInspectorSelection(rebuildTaskSelection(updated, stack));
    this.right_abyssPrivate.restoreDraftState(draft, updated);
    this.ownedWriteRef_abyssPrivate = result.changed ? { ...updated.ref } : undefined;
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
