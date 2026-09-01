import { ItemView, Menu, Notice, Platform, setIcon, TFile, type WorkspaceLeaf } from 'obsidian';
import { AppState } from '../app/AppState';
import { CenterPanel } from '../panels/CenterPanel';
import { LeftPanel } from '../panels/LeftPanel';
import { RailPanel } from '../panels/RailPanel';
import { RightPanel } from '../panels/RightPanel';
import {
  renderInspectorDraftRecovery,
  renderProjectInspector,
} from '../panels/projects/ProjectInspector';
import { ProjectWorkspaceSession } from '../panels/projects/ProjectWorkspaceSession';
import { renderWorkNoteInspector } from '../panels/projects/WorkNoteInspector';
import { ProjectCommandService } from '../projects/ProjectCommandService';
import { projectHealthProjection } from '../projects/ProjectHealthProjection';
import { ProjectManager } from '../projects/ProjectManager';
import { ProjectStore } from '../projects/ProjectStore';
import type { ProjectWorkspaceCoordinator } from '../projects/ProjectWorkspaceCoordinator';
import { inspectProjectLifecycleFrontmatter } from '../projects/lifecycle';
import { parseProjectDate } from '../projects/projectDates';
import type { ProjectAction, ProjectWorkspaceSnapshot } from '../projects/types';
import type { MilestoneCommandAdapter } from '../projects/work-notes/MilestoneCommandAdapter';
import type { WorkNoteCommandService } from '../projects/work-notes/WorkNoteCommandService';
import type {
  WorkNoteDeletionCoordinator,
  WorkNoteDeletionRecovery,
} from '../projects/work-notes/WorkNoteDeletionCoordinator';
import type { WorkNoteIndex } from '../projects/work-notes/WorkNoteIndex';
import type { WorkNoteRelationCommandService } from '../projects/work-notes/WorkNoteRelationCommandService';
import type { RelationWriteCommand, WorkNoteSnapshot } from '../projects/work-notes/types';
import { DailyNoteResolver } from '../resolvers/DailyNoteResolver';
import type { ShortcutActionId } from '../settings/shortcuts';
import type { CalendarSettings } from '../settings/types';
import type { StatusRegistry } from '../status/StatusRegistry';
import type { TagManager } from '../tags/TagManager';
import type {
  CommentTimeContextProvider,
  DependencyProjectionPort,
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
import {
  inspectorSelectionKey,
  rebaseInspectorSelectionPath,
  type InspectorFocusOrigin,
} from '../ui/inspector/InspectorSelection';
import { mountInspectorShell } from '../ui/inspector/InspectorShell';
import { InteractionRegistry } from '../ui/interactionOwnership';
import { nativeInteractionBlocksPanelShortcuts } from '../ui/nativeInteractionBlocker';
import { showMenuAtMouseEventWithFocus } from '../ui/nativeMenuFocus';
import { PanelShortcutRouter } from '../ui/panelShortcutRouter';
import { InspectorDraftRegistry } from '../ui/projectDraftContinuity';
import {
  CaptureTargetResolver,
  type CaptureContext,
} from '../ui/taskCapture/CaptureTargetResolver';
import { QuickCaptureCoordinator } from '../ui/taskCapture/QuickCaptureCoordinator';
import { presentTaskCreationResult, presentTaskMoveResult } from '../ui/taskCommandResult';
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

function projectHealthReason(snapshot: ProjectWorkspaceSnapshot, today: string): string {
  const health = projectHealthProjection(snapshot, { today });
  const reason = health.reason.type.replace(/-/gu, ' ');
  const date = health.date ? ` · ${health.date.value}` : '';
  return `${health.severity.replace('-', ' ')} · ${reason}${date}`;
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

function isTaskOwnershipResult(
  result: TaskCommandResult | import('../projects/work-notes/types').WorkNoteCommandResult,
): result is TaskCommandResult {
  if (result.type === 'ok') return 'changed' in result;
  if (result.type === 'partial') return 'operation' in result;
  if (result.type === 'io-error') return 'cause' in result;
  if (result.type === 'conflict' || result.type === 'invalid') return !('field' in result);
  return false;
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
  private inspectorSelectionUnsub?: () => void;
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
  private modeInspectorClearVersion = 0;
  private readonly inspectorDrafts = new InspectorDraftRegistry();
  private collectionState?: ProjectWorkspaceSession;
  private readonly workNoteDeletionRecovery = new Map<
    string,
    {
      readonly destinationPath: string;
      readonly expectedTaskRevisions: readonly TaskRef[];
      readonly recovery: WorkNoteDeletionRecovery;
    }
  >();
  private readonly pendingWorkNoteDeletions = new Set<string>();

  private inspectorReturnTarget(origin: InspectorFocusOrigin | null): HTMLElement | null {
    if (origin?.element?.isConnected) return origin.element;
    if (!origin) return null;
    const key = inspectorSelectionKey(origin.selection);
    return (
      Array.from(this.contentEl.querySelectorAll<HTMLElement>('[data-inspector-origin-key]')).find(
        (element) => element.dataset['inspectorOriginKey'] === key,
      ) ?? null
    );
  }

  private async executeWorkNoteDeletion(
    note: WorkNoteSnapshot,
    destinationPath: string,
    expectedTaskRevisions: readonly TaskRef[],
    recovery?: WorkNoteDeletionRecovery,
  ): Promise<void> {
    if (!this.workNoteDeletion || this.pendingWorkNoteDeletions.has(note.path)) return;
    this.pendingWorkNoteDeletions.add(note.path);
    try {
      const result = await this.workNoteDeletion.delete({
        note,
        action: destinationPath === note.projectPath ? 'move-to-project' : 'move-to-work-note',
        ...(destinationPath !== note.projectPath && {
          destinationWorkNotePath: destinationPath,
        }),
        expectedTaskRevisions,
        ...(recovery && { recovery }),
      });
      if (result.type === 'ok') {
        this.workNoteDeletionRecovery.delete(note.path);
        new Notice(`${note.kind === 'milestone' ? 'Milestone' : 'Work note'} deleted.`);
        this.state.batch(() => {
          this.state.set('inspectorSelection', { type: 'project', path: note.projectPath });
          this.state.set('inspectorOrigin', null);
        });
        this.center.refresh();
        return;
      }
      if (result.type === 'partial') {
        this.workNoteDeletionRecovery.set(note.path, {
          destinationPath,
          expectedTaskRevisions,
          recovery: result.recovery,
        });
        new Notice(
          `Deletion paused: ${String(result.recovery.remainingTaskCount)} tasks remain. The note was kept.`,
        );
        return;
      }
      this.workNoteDeletionRecovery.delete(note.path);
      if (result.type !== 'cancelled')
        new Notice('Work note was not deleted. Review changes and retry.');
    } finally {
      this.pendingWorkNoteDeletions.delete(note.path);
    }
  }

  private async requestWorkNoteDeletion(
    note: WorkNoteSnapshot,
    candidates: readonly WorkNoteSnapshot[],
    event: MouseEvent,
  ): Promise<void> {
    if (!this.workNoteDeletion) return;
    const recovery = this.workNoteDeletionRecovery.get(note.path);
    if (recovery) {
      await this.executeWorkNoteDeletion(
        note,
        recovery.destinationPath,
        recovery.expectedTaskRevisions,
        recovery.recovery,
      );
      return;
    }
    const preview = await this.workNoteDeletion.preview(note);
    if (preview.type === 'invalid') {
      new Notice('Work note was not deleted because ownership changed.');
      return;
    }
    const expectedTaskRevisions = this.workNoteDeletion.previewedTaskRevisions();
    if (preview.type === 'ready') {
      await this.executeWorkNoteDeletion(note, note.projectPath, expectedTaskRevisions);
      return;
    }
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle(`Move ${String(preview.taskCount)} tasks to project and delete`)
        .setIcon('folder-input')
        .onClick(() => this.executeWorkNoteDeletion(note, note.projectPath, expectedTaskRevisions)),
    );
    for (const candidate of candidates.filter(
      (candidate) => candidate.path !== note.path && candidate.projectPath === note.projectPath,
    )) {
      menu.addItem((item) =>
        item
          .setTitle(
            `Move tasks to ${(candidate.path.split('/').pop() ?? candidate.path).replace(/\.md$/u, '')}`,
          )
          .setIcon('notebook-tabs')
          .onClick(() => this.executeWorkNoteDeletion(note, candidate.path, expectedTaskRevisions)),
      );
    }
    showMenuAtMouseEventWithFocus(menu, event);
  }

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
    private readonly workNoteCommands?: WorkNoteCommandService,
    private readonly dependencyProjection?: DependencyProjectionPort,
    private readonly projectClock?: NonNullable<
      ConstructorParameters<typeof ProjectCommandService>[2]
    >,
    private readonly projectWorkspacePreferenceOwner?: object,
    private readonly workNoteRelations?: WorkNoteRelationCommandService,
    private readonly milestoneCommands?: MilestoneCommandAdapter,
    private readonly workNoteDeletion?: WorkNoteDeletionCoordinator,
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
    this.collectionState = new ProjectWorkspaceSession(this.projectWorkspacePreferenceOwner);
    this.collectionState.bindCollectionPreferences(this.settings, this.onSaveSettings);
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
      this.collectionState,
    );
    this.selectedListRenameUnsub = this.tagManager.registerSelectedListState({
      getSelectedList: () => this.state.get('selectedList'),
      setSelectedList: (selection) => this.panelNavigation.rebaseListIdentity(selection),
    });
    const selectionTasks: TaskApplicationApi & TaskCaptureApplicationApi = {
      queries: this.tasks.queries,
      planCreate: (destination) => this.tasks.planCreate(destination),
      applyRootTagChanges: (intent) =>
        this.tasks.applyRootTagChanges?.(intent) ??
        Promise.resolve({
          type: 'invalid',
          issues: [{ code: 'invalid-target', field: 'root-tags' }],
        }),
      setDependency: (intent) =>
        this.tasks.setDependency?.(intent) ??
        Promise.resolve({
          type: 'invalid',
          issues: [{ code: 'invalid-target', field: 'dependency' }],
        }),
      clearDependency: (intent) =>
        this.tasks.clearDependency?.(intent) ??
        Promise.resolve({
          type: 'invalid',
          issues: [{ code: 'invalid-target', field: 'dependency' }],
        }),
      ...(this.tasks.newDependencyId && {
        newDependencyId: () => this.tasks.newDependencyId!(),
      }),
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
      new ProjectCommandService(this.app, () => this.settings.projects.statuses, this.projectClock);
    const projectManager = new ProjectManager(
      this.app,
      this.settings,
      resolver,
      selectionTasks,
      projectCommands,
      projectStore,
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
      this.workNoteCommands,
      projectCommands,
      this.dependencyProjection,
      this.collectionState,
      (projectPath, candidate) =>
        this.projectWorkspace
          ?.get(projectPath)
          ?.tasks.some(
            ({ task }) =>
              task.ref.filePath === candidate.ref.filePath && task.ref.line === candidate.ref.line,
          ) === true,
      (settled) => this.projectWorkspace?.awaitTaskPublication(settled) ?? Promise.resolve(),
      this.workNoteRelations,
      this.milestoneCommands,
    );
    this.right = new RightPanel(
      this.state,
      this.app,
      this.statusRegistry,
      this.settings,
      undefined,
      this.tasks,
      (actions, action) => {
        const ownerPath = action?.owner.type === 'work-note' ? action.owner.path : undefined;
        if (ownerPath && ownerPath !== action?.milestonePath) {
          const backlink = actions.createEl('button', {
            cls: 'abyss-task-work-note-backlink',
            text: (ownerPath.split('/').pop() ?? ownerPath).replace(/\.md$/u, ''),
            attr: {
              type: 'button',
              'aria-label': `Open owning Work Note ${ownerPath}`,
              title: 'Open owning work note',
            },
          });
          setIcon(backlink, 'notebook-tabs');
          backlink.addEventListener('click', () => {
            const file = this.app.vault.getAbstractFileByPath(ownerPath);
            if (file instanceof TFile) void this.app.workspace.getLeaf(false).openFile(file);
          });
        }
        if (!action?.milestonePath) return;
        const milestonePath = action.milestonePath;
        const milestone = actions.createEl('button', {
          cls: 'abyss-task-milestone-backlink',
          text: (milestonePath.split('/').pop() ?? milestonePath).replace(/\.md$/u, ''),
          attr: {
            type: 'button',
            'aria-label': `Open Milestone ${milestonePath}`,
            title: 'Open milestone',
          },
        });
        setIcon(milestone, 'milestone');
        milestone.addEventListener('click', () => {
          const file = this.app.vault.getAbstractFileByPath(milestonePath);
          if (file instanceof TFile) void this.app.workspace.getLeaf(false).openFile(file);
        });
      },
      (event) => this.trackOwnWrite(event),
      this.commentTimeContext,
      this.interactionRegistry,
      this.dependencyProjection,
      (dependent) => {
        const snapshots = this.projectWorkspace?.list() ?? [];
        const memberships = snapshots.filter(({ tasks }) =>
          tasks.some(
            ({ task }) =>
              task.ref.filePath === dependent.ref.filePath && task.ref.line === dependent.ref.line,
          ),
        );
        const project =
          memberships.length === 1 ? memberships[0]!.tasks.map(({ task }) => task) : [];
        const projectKeys = new Set(
          project.map(({ ref }) => `${ref.filePath}\u0000${String(ref.line)}`),
        );
        return {
          project,
          other: this.queries
            .list()
            .filter(
              ({ ref }) =>
                !projectKeys.has(`${ref.filePath}\u0000${String(ref.line)}`) &&
                !(ref.filePath === dependent.ref.filePath && ref.line === dependent.ref.line),
            ),
        };
      },
      (host, selection) => {
        const onDraftSettled = (): void => {
          queueMicrotask(() => this.right.refresh());
        };
        const snapshots = this.projectWorkspace?.list() ?? [];
        const narrow = Platform.isMobile || this.compactRightCollapsed;
        const origin = this.state.get('inspectorOrigin');
        const returnFocus = (): HTMLElement | null => this.inspectorReturnTarget(origin);
        const preserveAndCloseShell =
          (shell: ReturnType<typeof mountInspectorShell>): (() => void) =>
          () => {
            const active = shell.element.ownerDocument.activeElement;
            if (active && shell.element.contains(active)) {
              active.dispatchEvent(new Event('select'));
            }
            shell.close(false);
          };
        const closeInspector = (next: typeof selection | null): void => {
          if (next?.type === 'project') this.center.closeProjectChildInspector(selection);
          this.state.batch(() => {
            this.state.set('inspectorSelection', next);
            this.state.set('inspectorOrigin', null);
          });
        };
        const openNote = (path: string): void => {
          const file = this.app.vault.getAbstractFileByPath(path);
          if (file instanceof TFile) void this.app.workspace.getLeaf(false).openFile(file);
        };
        if (selection.type === 'project') {
          const snapshot = snapshots.find(({ project }) => project.path === selection.path);
          if (!snapshot) {
            const identity = { type: 'project' as const, path: selection.path };
            this.inspectorDrafts.detach(identity);
            const projectRecovery = () =>
              this.inspectorDrafts
                .detached()
                .filter(
                  (draft) =>
                    (draft.identity.type === 'project' && draft.identity.path === selection.path) ||
                    (draft.identity.type === 'work-note' &&
                      draft.identity.projectPath === selection.path),
                );
            const recovery = projectRecovery();
            if (recovery.length === 0) return () => undefined;
            const shell = mountInspectorShell(host, {
              label: 'Project draft recovery',
              narrow,
              returnFocus,
              onRequestClose: () => closeInspector(null),
              isDirty: () => projectRecovery().length > 0,
              render: (content) =>
                renderInspectorDraftRecovery(content, recovery, (draft) =>
                  this.inspectorDrafts.discardEntry(draft),
                ),
            });
            return preserveAndCloseShell(shell);
          }
          const setStatus = (statusId: string) => {
            const lifecycle = inspectProjectLifecycleFrontmatter(
              this.settings.projects.statuses,
              snapshot.project.frontmatter,
            ).lifecycle;
            return projectCommands.setStatus(
              { path: snapshot.project.path, ...lifecycle },
              statusId,
            );
          };
          const shell = mountInspectorShell(host, {
            label: 'Project details',
            narrow,
            returnFocus,
            onRequestClose: () => closeInspector(null),
            isDirty: () =>
              this.inspectorDrafts.hasDirty({ type: 'project', path: snapshot.project.path }),
            render: (content) =>
              renderProjectInspector(content, {
                project: snapshot.project,
                taskRollup: snapshot.taskRollup,
                ...(this.projectClock
                  ? {
                      healthReason: projectHealthReason(
                        snapshot,
                        this.projectClock.read().localDate,
                      ),
                    }
                  : {}),
                openNote,
                commands: projectCommands,
                statuses: this.settings.projects.statuses,
                commentTimeContext: this.commentTimeContext,
                draftRegistry: this.inspectorDrafts,
                onDraftSettled,
                onSetStatus: setStatus,
              }),
          });
          return preserveAndCloseShell(shell);
        }
        if (selection.type !== 'work-note' || !this.workNoteCommands) return undefined;
        const note = snapshots
          .flatMap((snapshot) => [...snapshot.workNotes, ...snapshot.milestones])
          .find((candidate) => candidate.path === selection.path);
        if (!note) {
          this.inspectorDrafts.detach({
            type: 'work-note',
            path: selection.path,
            projectPath: selection.projectPath,
          });
          queueMicrotask(() => {
            if (this.state.get('inspectorSelection') !== selection) return;
            const fallback = {
              type: 'project',
              path: selection.projectPath,
            } as const;
            this.state.batch(() => {
              this.state.set('inspectorSelection', fallback);
              this.state.set('inspectorOrigin', { selection: fallback, element: null });
            });
          });
          return () => undefined;
        }
        const setStatus = (current: typeof note, statusId: string) => {
          if (current.kind === 'milestone' && this.milestoneCommands) {
            return this.milestoneCommands.setLifecycle(current, statusId);
          }
          const observed = this.workNoteCommands!.observe(current);
          return observed
            ? this.workNoteCommands!.setStatus(observed, statusId)
            : Promise.resolve({ type: 'invalid' as const, field: 'path' as const });
        };
        const relationCandidates = snapshots
          .filter(({ project }) => project.path === note.projectPath)
          .flatMap((snapshot) => [...snapshot.workNotes, ...snapshot.milestones]);
        const relationObservation = this.workNoteCommands.observe(note);
        const relationCommand = <TValue extends string | null>(
          field: 'milestone' | 'related' | 'blockedBy',
          value: TValue,
        ): RelationWriteCommand<TValue> => ({
          notePath: note.path,
          expectedRaw:
            relationObservation?.fields[this.settings.projects.workNoteCompatibility.fields[field]],
          expectedPresetRevision: String(note.presetRevision),
          expectedPresetFingerprint: note.presetFingerprint,
          value,
        });
        const setMilestoneRelation = async (
          _current: typeof note,
          milestone: typeof note | null,
        ) => {
          return this.workNoteRelations!.setMilestone(
            relationCommand('milestone', milestone?.path ?? null),
          );
        };
        const toggleRelatedRelation = async (
          _current: typeof note,
          target: typeof note,
          present: boolean,
        ) => {
          const command = relationCommand('related', target.path);
          return present
            ? this.workNoteRelations!.removeRelated(command)
            : this.workNoteRelations!.addRelated(command);
        };
        const toggleBlockedByRelation = async (
          _current: typeof note,
          target: typeof note,
          present: boolean,
        ) => {
          const command = relationCommand('blockedBy', target.path);
          return present
            ? this.workNoteRelations!.removeBlockedBy(command)
            : this.workNoteRelations!.addBlockedBy(command);
        };
        const showOwnedTasks = (): void => {
          const tasks = this.collectionState?.scopeSession('tasks');
          if (tasks) {
            tasks.textQuery = '';
            tasks.openSurface = `work-note-owner:${note.path}`;
          }
          if (this.collectionState) this.collectionState.scope = 'tasks';
          this.state.batch(() => {
            this.state.set('projectsPanel', { view: 'dashboard', path: note.projectPath });
            this.state.set('inspectorSelection', { type: 'project', path: note.projectPath });
            this.state.set('inspectorOrigin', null);
          });
          this.center.refresh();
        };
        const shell = mountInspectorShell(host, {
          label: 'Work Note details',
          narrow,
          returnFocus,
          onRequestClose: () => closeInspector({ type: 'project', path: note.projectPath }),
          isDirty: () =>
            this.inspectorDrafts.hasDirty({
              type: 'work-note',
              path: note.path,
              projectPath: note.projectPath,
            }),
          render: (content) => {
            const milestoneRangeObservation =
              note.kind === 'milestone' ? this.milestoneCommands?.observeDates(note) : null;
            const fieldObservation = this.workNoteCommands!.observe(note);
            const projectSnapshot = snapshots.find(
              ({ project }) => project.path === note.projectPath,
            );
            renderWorkNoteInspector(content, note, {
              statuses: this.workNoteCommands!.statuses(),
              commandsEnabled: this.workNoteCommands!.capabilities().update,
              onSetStatus: setStatus,
              openNote,
              ...(this.workNoteRelations && relationObservation
                ? {
                    relationCandidates,
                    onSetMilestone: setMilestoneRelation,
                    onToggleRelated: toggleRelatedRelation,
                    onToggleBlockedBy: toggleBlockedByRelation,
                  }
                : {}),
              taskRollup: snapshots
                .find(({ project }) => project.path === note.projectPath)
                ?.workNoteTaskRollups?.get(note.path),
              milestoneRollup: projectSnapshot?.milestoneRollups.get(note.path),
              onShowTasks: showOwnedTasks,
              ...(this.milestoneCommands && {
                onCreateTask: async (current: typeof note, markdownBody: string) => {
                  const result = await this.milestoneCommands!.createTask(current, markdownBody);
                  if (isTaskOwnershipResult(result)) presentTaskCreationResult(result);
                  if (result.type === 'ok') onDraftSettled();
                  return result;
                },
              }),
              taskMoveCandidates: (projectSnapshot?.tasks ?? []).filter(
                ({ owner }) => owner.type !== 'work-note' || owner.path !== note.path,
              ),
              ...(this.milestoneCommands && {
                onMoveTask: async (current: typeof note, action: ProjectAction) => {
                  const result = await this.milestoneCommands!.moveTask(action.task, current);
                  if (isTaskOwnershipResult(result)) {
                    presentTaskMoveResult(this.app, this.tasks, result);
                  }
                  if (result.type === 'ok') onDraftSettled();
                  return result;
                },
              }),
              ...(note.kind === 'milestone' && this.milestoneCommands
                ? {
                    onSetTitle: (current, title) =>
                      this.milestoneCommands!.setTitle(current, title),
                    ...(milestoneRangeObservation && {
                      onSetDate: (
                        _current: typeof note,
                        field: 'start' | 'end',
                        raw: string | null,
                      ) => {
                        const value = raw === null ? null : parseProjectDate(raw);
                        if (raw !== null && !value) {
                          return Promise.resolve({ type: 'invalid' as const, field });
                        }
                        return this.milestoneCommands!.setDates(milestoneRangeObservation, {
                          [field]: value,
                        });
                      },
                    }),
                    ...(fieldObservation && {
                      onSetPriority: (_current: typeof note, value: string | null) =>
                        this.milestoneCommands!.setPriority(fieldObservation, value),
                      onSetDescription: (_current: typeof note, value: string | null) =>
                        this.milestoneCommands!.setDescription(fieldObservation, value),
                    }),
                  }
                : {}),
              ...(this.workNoteDeletion && {
                onDelete: async (current, event) =>
                  this.requestWorkNoteDeletion(current, relationCandidates, event),
              }),
              draftRegistry: this.inspectorDrafts,
              onDraftSettled,
            });
          },
        });
        return preserveAndCloseShell(shell);
      },
      {
        narrow: () => Platform.isMobile || this.compactRightCollapsed,
        returnFocus: () => this.compactPaneElements?.rightButton ?? null,
        onRequestClose: () => {
          this.state.set('taskStack', []);
          this.closeCompactPane(false);
        },
      },
      (task) =>
        (this.projectWorkspace?.list() ?? [])
          .flatMap(({ tasks }) => tasks)
          .find(
            (action) =>
              action.task.ref.filePath === task.ref.filePath &&
              action.task.ref.line === task.ref.line &&
              action.task.ref.revision === task.ref.revision,
          ),
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
      if (this.state.get('mode') === 'projects') {
        this.center.refresh();
        this.right.refresh();
      }
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
        this.inspectorDrafts.renamePath(oldPath, file.path);
        this.center.renameProjectWorkspacePath(oldPath, file.path);
        const inspector = this.state.get('inspectorSelection');
        const origin = this.state.get('inspectorOrigin');
        if (inspector) {
          const rebased = rebaseInspectorSelectionPath(inspector, oldPath, file.path);
          const rebasedOrigin = origin
            ? {
                selection: rebaseInspectorSelectionPath(origin.selection, oldPath, file.path),
                element: origin.element,
              }
            : null;
          if (rebased !== inspector || rebasedOrigin?.selection !== origin?.selection) {
            this.state.batch(() => {
              this.state.set('inspectorSelection', rebased);
              this.state.set('inspectorOrigin', rebasedOrigin);
            });
          }
        }
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
        this.inspectorDrafts.detachPath(file.path);
        const inspector = this.state.get('inspectorSelection');
        if (inspector?.type === 'project' && inspector.path === file.path) {
          const identity = { type: 'project' as const, path: inspector.path };
          this.inspectorDrafts.detach(identity);
          if (!this.inspectorDrafts.hasDirty(identity)) {
            this.state.batch(() => {
              this.state.set('inspectorSelection', null);
              this.state.set('inspectorOrigin', null);
            });
          }
        } else if (inspector?.type === 'work-note' && inspector.path === file.path) {
          this.inspectorDrafts.detach({
            type: 'work-note',
            path: inspector.path,
            projectPath: inspector.projectPath,
          });
          const fallback = {
            type: 'project',
            path: inspector.projectPath,
          } as const;
          this.state.batch(() => {
            this.state.set('inspectorSelection', fallback);
            this.state.set('inspectorOrigin', { selection: fallback, element: null });
          });
        }
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
      const clearVersion = ++this.modeInspectorClearVersion;
      if (mode !== 'projects') {
        queueMicrotask(() => {
          if (
            clearVersion !== this.modeInspectorClearVersion ||
            this.state.get('mode') === 'projects'
          ) {
            return;
          }
          const inspector = this.state.get('inspectorSelection');
          if (!inspector || inspector.type === 'task') return;
          this.state.batch(() => {
            this.state.set('inspectorSelection', null);
            this.state.set('inspectorOrigin', null);
          });
        });
      }
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
    this.inspectorSelectionUnsub = this.state.on('inspectorSelection', (selection) => {
      if (selection && this.state.get('mode') === 'projects' && this.compactRightCollapsed) {
        this.openCompactPane('right', false);
      } else if (!selection && this.compactPaneOpen === 'right') {
        this.closeCompactPane(false);
      }
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
    this.modeInspectorClearVersion += 1;
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
    this.inspectorSelectionUnsub?.();
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
    this.collectionState?.destroy();
    this.collectionState = undefined;
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
        pane === 'right' &&
        (activePane.matches('.abyss-inspector-shell') ||
          activePane.querySelector('.abyss-inspector-shell'))
      ) {
        return;
      }
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
    if (wasRightCollapsed !== this.compactRightCollapsed) this.right?.refresh();

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
      (this.state.get('taskStack').length > 0 ||
        (this.state.get('mode') === 'projects' && this.state.get('inspectorSelection') !== null))
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
        return this.center.projectCaptureContext(projectsPanel.path);
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
