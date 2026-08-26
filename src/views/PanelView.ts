import { ItemView, Platform, setIcon, TFile, type WorkspaceLeaf } from 'obsidian';
import { AppState } from '../app/AppState';
import { CenterPanel } from '../panels/CenterPanel';
import { LeftPanel } from '../panels/LeftPanel';
import { RailPanel } from '../panels/RailPanel';
import { RightPanel } from '../panels/RightPanel';
import { ProjectCommandService } from '../projects/ProjectCommandService';
import { ProjectManager } from '../projects/ProjectManager';
import { ProjectStore } from '../projects/ProjectStore';
import type { ProjectWorkspaceCoordinator } from '../projects/ProjectWorkspaceCoordinator';
import type { ProjectWorkspaceSnapshot } from '../projects/types';
import type { WorkNoteIndex } from '../projects/work-notes/WorkNoteIndex';
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

interface PendingCompactPane {
  readonly pane: CompactPane;
  readonly moveFocus: boolean;
}

function rootRefOfNode(target: TaskNodeRef): TaskRef {
  let current = target;
  while (current.type === 'subtask') current = current.ref.parent;
  return current.ref;
}

type TaskCommand = Parameters<TaskApplicationApi['execute']>[0];

function commandRootRef(command: TaskCommand): TaskRef | undefined {
  if (command.type === 'create') return undefined;
  if (
    command.type === 'patch' ||
    command.type === 'append-title' ||
    command.type === 'set-status' ||
    command.type === 'toggle-completion' ||
    command.type === 'set-description'
  ) {
    return rootRefOfNode(command.target);
  }
  if (command.type === 'edit-link') {
    return rootRefOfNode(
      command.target.type === 'comment' ? command.target.ref.parent : command.target.target,
    );
  }
  if (command.type === 'add-subtask' || command.type === 'add-comment') {
    return rootRefOfNode(command.parent);
  }
  if (command.type === 'delete-subtask' || command.type === 'reorder-subtask') {
    return rootRefOfNode(command.subtask.parent);
  }
  if (command.type === 'update-comment' || command.type === 'delete-comment') {
    return rootRefOfNode(command.comment.parent);
  }
  return command.ref;
}

function positiveRenderedArea(element: HTMLElement): DOMRect | null {
  const bounds = element.getBoundingClientRect();
  if (
    !Number.isFinite(bounds.left) ||
    !Number.isFinite(bounds.top) ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height) ||
    bounds.width <= 0 ||
    bounds.height <= 0
  ) {
    return null;
  }
  const rects = element.getClientRects();
  for (let index = 0; index < rects.length; index++) {
    const rect = rects[index];
    if (rect && rect.width > 0 && rect.height > 0) return bounds;
  }
  return null;
}

function intersectsOwnerViewport(bounds: DOMRect, ownerWindow: Window | null): boolean {
  if (!ownerWindow) return true;
  const width = ownerWindow.innerWidth;
  const height = ownerWindow.innerHeight;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return true;
  return bounds.right > 0 && bounds.bottom > 0 && bounds.left < width && bounds.top < height;
}

function hasPresentedPanelGeometry(element: HTMLElement, ownerWindow: Window | null): boolean {
  const bounds = positiveRenderedArea(element);
  return bounds !== null && intersectsOwnerViewport(bounds, ownerWindow);
}

export class PanelView extends ItemView {
  private state!: AppState;
  private rail!: RailPanel;
  private left!: LeftPanel;
  private center!: CenterPanel;
  private right!: RightPanel;
  private queryUnsub?: () => void;
  private modeUnsub?: () => void;
  private selectionUnsub?: () => void;
  private selectedListRenameUnsub?: () => void;
  private projectStore?: ProjectStore;
  private projectStoreUnsub?: () => void;
  private ownsProjectStore = false;
  private creationPresentation?: CreationPresentationController;
  private ownedWriteRef: TaskRef | undefined = undefined;
  private interactionRegistry?: InteractionRegistry<ShortcutActionId>;
  private quickCapture?: QuickCaptureCoordinator;
  private shortcutRouter?: PanelShortcutRouter;
  private panelNavigation!: PanelNavigator;
  private compactPaneElements?: CompactPaneElements;
  private compactPaneCleanup?: () => void;
  private compactPaneRefresh?: () => void;
  private compactPaneOpen: CompactPane | null = null;
  private compactTaskSelectionKey: string | undefined = undefined;
  private compactLeftCollapsed = false;
  private compactRightCollapsed = false;
  private pendingCompactPane: PendingCompactPane | undefined = undefined;
  constructor(
    leaf: WorkspaceLeaf,
    private settings: CalendarSettings,
    private tagManager: TagManager,
    private queries: TaskQueryApi,
    private readonly tasks: TaskApplicationApi & TaskCaptureApplicationApi,
    private statusRegistry: StatusRegistry,
    private onSaveSettings: () => Promise<void> = async () => {},
    private commentTimeContext?: CommentTimeContextProvider,
    private projectCommands?: ProjectCommandService,
    private readonly workNoteIndex?: WorkNoteIndex,
    private readonly injectedProjectStore?: ProjectStore,
    private readonly projectWorkspace?: ProjectWorkspaceCoordinator,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return PANEL_VIEW_TYPE;
  }
  getDisplayText(): string {
    // eslint-disable-next-line obsidianmd/ui/sentence-case -- The plugin's approved display name is branded title case.
    return 'Abyss Tasks';
  }
  getIcon(): string {
    return 'calendar-days';
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass('abyss-panel-view');

    this.state = new AppState();
    this.interactionRegistry = new InteractionRegistry<ShortcutActionId>();
    this.panelNavigation = new PanelNavigator(
      this.state,
      this.settings,
      {
        calendarView: () => this.center.calendarView(),
        setCalendarView: (view) => this.center.setCalendarView(view),
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
      setSelectedList: (selection) => this.panelNavigation.rebaseListIdentity(selection),
    });
    const selectionTasks: TaskApplicationApi & TaskCaptureApplicationApi = {
      queries: this.tasks.queries,
      planCreate: (destination) => this.tasks.planCreate(destination),
      execute: async (command) => {
        const initiatingRef = commandRootRef(command);
        const result = await this.tasks.execute(command);
        if (initiatingRef) this.convergeOwnCommand(initiatingRef, result);
        return result;
      },
    };

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
    this.mountCompactPaneAccess(layout, leftEl, rightEl, compactLeftButton, compactRightButton);
    const creationFeedback = layout.createDiv({ cls: 'abyss-creation-feedback' });
    this.creationPresentation = new CreationPresentationController({
      host: creationFeedback,
      queries: this.queries,
      reducedMotion: () =>
        creationFeedback.ownerDocument.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)')
          .matches ?? false,
      now: () => Date.now(),
    });

    const resolver = new DailyNoteResolver(this.app, this.settings);
    const projectStore =
      this.injectedProjectStore ?? new ProjectStore(this.app, this.queries, this.settings);
    if (!this.injectedProjectStore) {
      projectStore.initialize();
      this.ownsProjectStore = true;
    }
    this.projectStore = projectStore;
    const projectCommands =
      this.projectCommands ??
      new ProjectCommandService(this.app, () => this.settings.projects.statuses);
    const projectManager = new ProjectManager(
      this.app,
      this.settings,
      resolver,
      selectionTasks,
      projectCommands,
    );

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
      this.projectWorkspace?.list() ?? [],
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
      this.projectWorkspace?.list() ?? [],
    );
    this.right = new RightPanel(
      this.state,
      this.app,
      this.statusRegistry,
      this.settings,
      undefined,
      this.tasks,
      undefined,
      (event) => this.trackOwnWrite(event),
      this.commentTimeContext,
      this.interactionRegistry,
    );

    // Keep panels fresh when the project set / stats change. Only the left
    // panel's Projects section and the projects-mode center depend on this;
    // re-rendering the tasks-mode center here would double-render on every edit
    // (TaskIndex already refreshes it), so gate the center refresh to projects mode.
    const refreshProjectSurfaces = (snapshots?: readonly ProjectWorkspaceSnapshot[]): void => {
      if (snapshots) {
        this.left.setProjectSnapshots(snapshots);
        this.center.setProjectSnapshots(snapshots);
      }
      this.left.refresh();
      if (this.state.get('mode') === 'projects') this.center.refresh();
    };
    this.projectStoreUnsub = this.projectWorkspace
      ? this.projectWorkspace.onUpdate((snapshots) => refreshProjectSurfaces(snapshots))
      : projectStore.onUpdate(() => refreshProjectSurfaces());

    // Task 40 (Round 4): the tag-fill text-color contrast fix (tagFillContrast.ts) bakes a
    // computed `--abyss-tag-text-color` custom property into each block/item's inline style at
    // render time, from that moment's actual `--background-primary` — unlike a plain CSS
    // `var(--text-normal)` reference, this does NOT automatically track a live theme switch
    // (light/dark toggle, or swapping community themes) the way the rest of this view's colors
    // do, since nothing else here re-renders in response to one. Obsidian fires `css-change`
    // whenever the active theme/CSS changes; re-rendering the center panel (which owns every
    // tag-filled block: Month grid, Week/Day time grid, all-day rows) recomputes that property
    // against the new background so it doesn't stay stuck on a stale light/dark decision.
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

    this.rail.mount(railEl);
    this.left.mount(leftEl);
    this.center.mount(centerEl);
    this.right.mount(rightEl);

    const captureTargets = new CaptureTargetResolver(selectionTasks, this.settings);
    this.quickCapture = new QuickCaptureCoordinator({
      host: quickCaptureHost,
      context: () => this.quickCaptureContext(),
      resolveTarget: (context) => captureTargets.resolve(context),
      interactionOwnership: this.interactionRegistry,
      onResult: (result, description) => {
        this.creationPresentation?.present(result, description);
        const pendingPane = this.pendingCompactPane;
        this.pendingCompactPane = undefined;
        if (description.kind === 'success' && pendingPane) {
          void Promise.resolve().then(() => {
            this.openCompactPane(pendingPane.pane, pendingPane.moveFocus);
          });
        }
      },
    });
    const ownerDocument = layout.ownerDocument;
    this.shortcutRouter = new PanelShortcutRouter({
      ownerDocument,
      isActive: () => this.ownsPanelShortcuts(),
      settings: () => this.settings.shortcuts,
      platform: { mod: Platform.isMacOS ? 'meta' : 'ctrl' },
      actions: this.panelNavigation,
      registry: this.interactionRegistry,
      nativeHostBlocks: () => nativeInteractionBlocksPanelShortcuts(ownerDocument),
    });

    // Update layout class whenever mode changes
    this.modeUnsub = this.state.on('mode', (mode) => {
      layout.className = `abyss-layout abyss-layout--${mode}`;
      if (mode !== 'tasks' && mode !== 'projects') {
        this.pendingCompactPane = undefined;
        this.closeCompactPane(false);
      } else if (mode === 'projects' && this.compactPaneOpen === 'left') {
        this.closeCompactPane(false);
      }
      if (
        (mode === 'tasks' || mode === 'projects') &&
        this.compactRightCollapsed &&
        this.state.get('taskStack').length > 0
      ) {
        this.openCompactPane('right', false);
      }
    });
    this.selectionUnsub = this.state.on('taskStack', (stack) => {
      const selected = stack[0];
      const selectedRef = selected ? rootTaskRef(selected) : undefined;
      const selectionKey = selectedRef
        ? `${selectedRef.filePath}\u0000${String(selectedRef.line)}`
        : undefined;
      if (
        selectionKey &&
        selectionKey !== this.compactTaskSelectionKey &&
        (this.state.get('mode') === 'tasks' || this.state.get('mode') === 'projects') &&
        this.compactRightCollapsed
      ) {
        this.openCompactPane('right', false);
      } else if (!selectionKey && this.compactPaneOpen === 'right') {
        this.closeCompactPane(false);
      }
      this.compactTaskSelectionKey = selectionKey;
      if (!this.ownedWriteRef) return;
      const ref = stack[0] ? rootTaskRef(stack[0]) : undefined;
      if (!ref || !this.sameRef(ref, this.ownedWriteRef)) this.ownedWriteRef = undefined;
    });

    this.queryUnsub = this.queries.subscribe((event) => {
      this.left.refresh();
      if (this.state.get('mode') !== 'calendar') this.center.refresh();
      const stack = this.state.get('taskStack');
      if (stack.length === 0) return;
      const root = stack[0];
      const ref = root ? rootTaskRef(root) : undefined;
      if (!ref || !this.affects(event, ref.filePath)) return;
      if (root && 'source' in root) {
        const renamed = renamedRootSelection(event, root, this.queries);
        if (renamed) {
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

  // eslint-disable-next-line @typescript-eslint/require-await
  async onClose(): Promise<void> {
    this.compactPaneCleanup?.();
    this.compactPaneCleanup = undefined;
    this.compactPaneRefresh = undefined;
    this.closeCompactPane(false);
    this.compactPaneElements = undefined;
    this.compactTaskSelectionKey = undefined;
    this.compactLeftCollapsed = false;
    this.compactRightCollapsed = false;
    this.pendingCompactPane = undefined;
    this.shortcutRouter?.destroy();
    this.shortcutRouter = undefined;
    this.quickCapture?.destroy();
    this.quickCapture = undefined;
    this.modeUnsub?.();
    this.selectionUnsub?.();
    this.selectedListRenameUnsub?.();
    this.queryUnsub?.();
    this.projectStoreUnsub?.();
    this.creationPresentation?.destroy();
    this.creationPresentation = undefined;
    if (this.ownsProjectStore) this.projectStore?.destroy();
    this.ownsProjectStore = false;
    this.rail?.destroy();
    this.left?.destroy();
    this.center?.destroy();
    this.right?.destroy();
    this.interactionRegistry?.destroy();
    this.interactionRegistry = undefined;
    this.contentEl.empty();
  }

  private mountCompactPaneAccess(
    layout: HTMLElement,
    left: HTMLElement,
    right: HTMLElement,
    leftButton: HTMLButtonElement,
    rightButton: HTMLButtonElement,
  ): void {
    const instanceId = ++panelViewInstanceSequence;
    left.id = `abyss-task-lists-${String(instanceId)}`;
    right.id = `abyss-task-details-${String(instanceId)}`;
    left.tabIndex = -1;
    right.tabIndex = -1;
    left.setAttribute('role', 'region');
    left.setAttribute('aria-label', 'Task lists');
    right.setAttribute('role', 'region');
    right.setAttribute('aria-label', 'Task details');
    leftButton.setAttribute('aria-controls', left.id);
    rightButton.setAttribute('aria-controls', right.id);
    this.compactPaneElements = { left, right, leftButton, rightButton };

    const toggleLeft = (): void => this.toggleCompactPane('left');
    const toggleRight = (): void => this.toggleCompactPane('right');
    const ownerDocument = layout.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    const updateCompactWidth = (width?: number): void => {
      const measuredWidth = width ?? layout.getBoundingClientRect().width;
      this.updateCompactPaneAvailability(
        measuredWidth > 0 && Number.isFinite(measuredWidth) ? measuredWidth : Infinity,
        ownerWindow,
      );
    };
    const onWindowResize = (): void => updateCompactWidth();
    this.compactPaneRefresh = onWindowResize;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        event.key !== 'Escape' ||
        event.isComposing ||
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- Chromium can expose IME ownership only through the legacy 229 sentinel.
        event.keyCode === 229 ||
        event.defaultPrevented ||
        this.compactPaneOpen === null ||
        !this.isCompactPaneCollapsed(this.compactPaneOpen) ||
        this.interactionRegistry?.allows('openCalendar') === false ||
        nativeInteractionBlocksPanelShortcuts(ownerDocument)
      ) {
        return;
      }
      event.preventDefault();
      this.closeCompactPane(true);
    };
    const onPointerDown = (event: PointerEvent): void => {
      const elements = this.compactPaneElements;
      const pane = this.compactPaneOpen;
      if (
        !elements ||
        !pane ||
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
    };
    leftButton.addEventListener('click', toggleLeft);
    rightButton.addEventListener('click', toggleRight);
    ownerDocument.addEventListener('keydown', onKeyDown);
    ownerDocument.addEventListener('pointerdown', onPointerDown, true);
    ownerWindow?.addEventListener('resize', onWindowResize);
    const OwnerResizeObserver = ownerWindow?.ResizeObserver;
    const resizeObserver = OwnerResizeObserver
      ? new OwnerResizeObserver((entries) => {
          const entry = entries.find((candidate) => candidate.target === layout);
          updateCompactWidth(entry?.contentRect.width);
        })
      : null;
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

  private toggleCompactPane(pane: CompactPane): void {
    if (this.compactPaneOpen === pane) {
      this.closeCompactPane(true);
      return;
    }
    this.openCompactPane(pane, true);
  }

  private openCompactPane(pane: CompactPane, moveFocus: boolean): void {
    const elements = this.compactPaneElements;
    const mode = this.state.get('mode');
    const modeOwnsPane = mode === 'tasks' || (mode === 'projects' && pane === 'right');
    if (!elements || !this.isCompactPaneCollapsed(pane) || !modeOwnsPane) {
      return;
    }
    const quickCapture = this.quickCapture;
    if (quickCapture && quickCapture.phase !== 'closed') {
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

  private closeCompactPane(restoreFocus: boolean): void {
    const elements = this.compactPaneElements;
    const pane = this.compactPaneOpen;
    this.compactPaneOpen = null;
    if (!elements) return;
    elements.left.removeClass('is-compact-open');
    elements.right.removeClass('is-compact-open');
    this.setCompactPaneButtonState(elements.leftButton, 'task lists', false);
    this.setCompactPaneButtonState(elements.rightButton, 'task details', false);
    if (restoreFocus && pane) {
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
    const rootFontSize = Number.parseFloat(
      ownerWindow?.getComputedStyle(this.contentEl.ownerDocument.documentElement).fontSize ?? '',
    );
    const rem = Number.isFinite(rootFontSize) && rootFontSize > 0 ? rootFontSize : 16;
    const wasRightCollapsed = this.compactRightCollapsed;
    this.compactRightCollapsed = width <= COMPACT_RIGHT_MAX_REM * rem;
    this.compactLeftCollapsed = width <= COMPACT_LEFT_MAX_REM * rem;
    this.compactPaneElements?.right.classList.toggle(
      'is-compact-collapsed',
      this.compactRightCollapsed,
    );

    const pendingPane = this.pendingCompactPane;
    if (pendingPane && !this.isCompactPaneCollapsed(pendingPane.pane)) {
      this.pendingCompactPane = undefined;
    }

    const pane = this.compactPaneOpen;
    if (pane && !this.isCompactPaneCollapsed(pane)) this.closeCompactPane(false);
    if (
      !wasRightCollapsed &&
      this.compactRightCollapsed &&
      (this.state.get('mode') === 'tasks' || this.state.get('mode') === 'projects') &&
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
        return {
          type: 'project-workspace',
          projectPath: projectsPanel.path,
          destinationPath: projectsPanel.path,
        };
      }
    }
    return { type: 'default', source: mode };
  }

  private ownsPanelShortcuts(): boolean {
    if (this.app.workspace.getActiveViewOfType(PanelView) !== this || !this.contentEl.isConnected) {
      return false;
    }
    const ownerWindow = this.contentEl.ownerDocument.defaultView;
    let current: HTMLElement | null = this.contentEl;
    while (current) {
      if (current.hidden) return false;
      const style = ownerWindow?.getComputedStyle(current);
      if (style?.display === 'none' || style?.visibility === 'hidden') return false;
      current = current.parentElement;
    }
    return (
      hasPresentedPanelGeometry(this.containerEl, ownerWindow ?? null) &&
      hasPresentedPanelGeometry(this.contentEl, ownerWindow ?? null)
    );
  }

  private affects(event: TaskIndexEvent, path: string): boolean {
    if (event.type === 'initialized') return true;
    if (event.type === 'changed') return event.files.includes(path);
    if (event.type === 'settled') return event.files.some((file) => file.path === path);
    if (event.type === 'renamed') return event.oldPath === path || event.newPath === path;
    return event.path === path;
  }

  private applyResolution(resolution: TaskResolution): void {
    const stack = this.state.get('taskStack');
    this.clearSelectionMessage();
    if (resolution.type === 'exact' || resolution.type === 'rebased') {
      const current = resolution.type === 'exact' ? resolution.task : resolution.current;
      const consumedOwnedRef =
        resolution.type === 'rebased' &&
        resolution.evidence === 'authority-transition' &&
        this.ownedWriteRef &&
        this.sameRef(this.ownedWriteRef, resolution.previous.ref)
          ? this.ownedWriteRef
          : undefined;
      const draft = consumedOwnedRef
        ? this.right.captureDraftStateForOwnedTransition(consumedOwnedRef, current.ref)
        : this.right.captureDraftState();
      this.ownedWriteRef = undefined;
      this.state.set('taskStack', rebuildTaskSelection(current, stack));
      this.right.restoreDraftState(draft, current);
      return;
    }
    const draft = this.right.captureDraftState();
    this.ownedWriteRef = undefined;
    if (resolution.type === 'visual') {
      this.state.set('taskStack', [resolution.current]);
      this.right.detachDraftState(draft);
      return;
    }
    if (
      resolution.type === 'not-found' ||
      resolution.type === 'uncertain' ||
      resolution.type === 'ambiguous'
    ) {
      this.state.set('taskStack', []);
      this.right.detachDraftState(draft);
    }
  }

  private acknowledgeOwnWrite(taskOrRef?: TaskSelectionNode | TaskRef): void {
    const selected = this.state.get('taskStack')[0];
    const selectedRef = selected ? rootTaskRef(selected) : undefined;
    let suppliedRef: TaskRef | undefined;
    if (taskOrRef) suppliedRef = 'revision' in taskOrRef ? taskOrRef : rootTaskRef(taskOrRef);
    if (suppliedRef && (!selectedRef || !this.sameRef(suppliedRef, selectedRef))) return;
    const acknowledged = suppliedRef ?? selectedRef;
    this.ownedWriteRef = acknowledged ? { ...acknowledged } : undefined;
  }

  private trackOwnWrite(event: {
    readonly phase: 'started' | 'settled';
    readonly ref: TaskRef;
  }): void {
    if (event.phase === 'started') {
      this.acknowledgeOwnWrite(event.ref);
      return;
    }
    if (this.ownedWriteRef && this.sameRef(this.ownedWriteRef, event.ref)) {
      this.ownedWriteRef = undefined;
    }
  }

  private convergeOwnCommand(initiatingRef: TaskRef, result: TaskCommandResult): void {
    if (result.type !== 'ok' || result.outcome.type !== 'task') return;
    if (result.changed) {
      this.projectWorkspace?.absorbOwnCommit([
        initiatingRef.filePath,
        result.outcome.task.source.filePath,
      ]);
    }
    const stack = this.state.get('taskStack');
    const selectedRef = stack[0] ? rootTaskRef(stack[0]) : undefined;
    if (!selectedRef || !this.sameRef(selectedRef, initiatingRef)) return;
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
