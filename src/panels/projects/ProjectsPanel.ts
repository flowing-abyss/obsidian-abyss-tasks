import { Platform, TFile, type App } from 'obsidian';
import type { AppState } from '../../app/AppState';
import type {
  ProjectCommandService,
  ProjectPropertyCommandResult,
} from '../../projects/ProjectCommandService';
import type { ProjectManager } from '../../projects/ProjectManager';
import type { ProjectStore } from '../../projects/ProjectStore';
import type { ProjectWorkspaceSnapshot } from '../../projects/types';
import type { WorkNoteCommandService } from '../../projects/work-notes/WorkNoteCommandService';
import type { MilestoneRollup } from '../../projects/work-notes/rollups';
import type { WorkNoteCommandResult } from '../../projects/work-notes/types';
import type {
  CalendarSettings,
  ProjectTasksViewState,
  WorkNotesViewState,
} from '../../settings/types';
import {
  ProjectWorkspaceSession,
  type UseProjectWorkspaceDefaultIntent,
} from './ProjectWorkspaceSession';
import { renderProjectsBoard } from './ProjectsBoardView';
import { renderProjectDashboard } from './ProjectsDashboardView';
import { renderProjectsList, showNewProjectInput } from './ProjectsListView';
import { renderProjectsTimeline, renderWorkNotesTimeline } from './ProjectsTimelineView';
import { renderProjectsToolbar } from './ProjectsToolbar';
import { renderWorkNotesView, selectWorkNotes } from './WorkNotesView';
import { projectTimelineItem } from './timelineProjection';
import type { ProjectChildRenderHandle } from './viewContext';

export interface ProjectsPanelOptions {
  /** Render a project's tasks into `host` (PanelView wires this to reuse task rendering). */
  renderTasks?: (
    host: HTMLElement,
    path: string,
    tasks: ProjectWorkspaceSnapshot['tasks'],
  ) => ProjectChildRenderHandle;
  renderTaskBoard?: (
    host: HTMLElement,
    path: string,
    tasks: ProjectWorkspaceSnapshot['tasks'],
  ) => ProjectChildRenderHandle;
  renderTaskTimeline?: (
    host: HTMLElement,
    path: string,
    tasks: ProjectWorkspaceSnapshot['tasks'],
  ) => ProjectChildRenderHandle;
  snapshots?: readonly ProjectWorkspaceSnapshot[];
  onSaveSettings?: () => Promise<void>;
  pendingBoardUndo?: PendingProjectBoardUndo;
  onBoardUndoPending?: (pending: PendingProjectBoardUndo) => void;
  onBoardUndoStarted?: (pending: PendingProjectBoardUndo) => void;
  onBoardUndoResolved?: (pending: PendingProjectBoardUndo, successful: boolean) => void;
  boardUndoOwner?: {
    started(pending: PendingProjectBoardUndo): void;
    resolved(pending: PendingProjectBoardUndo, successful: boolean): void;
  };
  workNoteCommands?: WorkNoteCommandService;
  projectCommands?: ProjectCommandService;
  workspaceSession?: ProjectWorkspaceSession;
  onAnnounce?: (message: string) => void;
}

export interface PendingProjectBoardUndo {
  readonly path: string;
  readonly columnKey: string;
  readonly result: Extract<ProjectPropertyCommandResult, { type: 'ok' }>;
  readonly undoInFlight?: boolean;
}

/**
 * The `projects` mode surface. Self-contained deep mode: switches internally
 * between the List overview and a single-project Dashboard via `projectsPanel`
 * state, never touching the global `mode`.
 */
export class ProjectsPanel {
  private el!: HTMLElement;
  private offs: Array<() => void> = [];
  private readonly renderTasks: NonNullable<ProjectsPanelOptions['renderTasks']>;
  private readonly renderTaskBoard: ProjectsPanelOptions['renderTaskBoard'];
  private readonly renderTaskTimeline: ProjectsPanelOptions['renderTaskTimeline'];
  private readonly snapshots: readonly ProjectWorkspaceSnapshot[];
  private readonly onSaveSettings: () => Promise<void>;
  private readonly pendingBoardUndo: PendingProjectBoardUndo | undefined;
  private readonly onBoardUndoPending: ((pending: PendingProjectBoardUndo) => void) | undefined;
  private readonly onBoardUndoStarted: ((pending: PendingProjectBoardUndo) => void) | undefined;
  private readonly onBoardUndoResolved:
    | ((pending: PendingProjectBoardUndo, successful: boolean) => void)
    | undefined;
  private readonly boardUndoOwner: ProjectsPanelOptions['boardUndoOwner'];
  private readonly workNoteCommands: WorkNoteCommandService | undefined;
  private readonly projectCommands: ProjectCommandService | undefined;
  private readonly workspaceSession: ProjectWorkspaceSession;
  private readonly onAnnounce: (message: string) => void;
  private viewCleanup: (() => void) | null = null;
  private readonly portfolioScroll = new Map<string, number>();

  private portfolioScrollKey(scroll: HTMLElement): string {
    const column = scroll.closest<HTMLElement>('[data-board-column]');
    if (column) return `board:${column.dataset['boardColumn'] ?? ''}`;
    return scroll.classList.contains('abyss-timeline-scroll') ? 'timeline' : 'overview';
  }

  constructor(
    private state: AppState,
    private projectStore: ProjectStore,
    private projectManager: ProjectManager,
    private settings: CalendarSettings,
    private app: App,
    opts: ProjectsPanelOptions = {},
  ) {
    this.renderTasks = opts.renderTasks ?? (() => ({ destroy: () => undefined }));
    this.renderTaskBoard = opts.renderTaskBoard;
    this.renderTaskTimeline = opts.renderTaskTimeline;
    this.snapshots = opts.snapshots ?? [];
    this.onSaveSettings = opts.onSaveSettings ?? (async (): Promise<void> => {});
    this.pendingBoardUndo = opts.pendingBoardUndo;
    this.onBoardUndoPending = opts.onBoardUndoPending;
    this.onBoardUndoStarted = opts.onBoardUndoStarted;
    this.onBoardUndoResolved = opts.onBoardUndoResolved;
    this.boardUndoOwner = opts.boardUndoOwner;
    this.workNoteCommands = opts.workNoteCommands;
    this.projectCommands = opts.projectCommands;
    this.workspaceSession = opts.workspaceSession ?? new ProjectWorkspaceSession();
    this.onAnnounce = opts.onAnnounce ?? ((): void => {});
  }

  private async createProject(name: string): Promise<void> {
    await this.projectManager.create(name);
    this.projectStore.refresh();
  }

  mount(el: HTMLElement): void {
    this.el = el;
    // Only internal list⇄dashboard navigation is self-managed here. Project data
    // changes arrive via CenterPanel rebuilding this panel (projects mode), so we
    // deliberately do NOT also subscribe to projectStore.onUpdate — that would
    // double-render on every store update.
    this.offs.push(this.state.on('projectsPanel', () => this.render()));
    this.render();
  }

  refresh(): void {
    if (this.el) this.render();
  }

  private async setStatus(path: string, statusId: string, refresh = true) {
    const result = await this.projectManager.setStatus(path, statusId);
    if (refresh && result.type === 'ok') this.projectStore.refresh();
    return result;
  }

  private async undoStatus(
    path: string,
    expectedStatusId: string,
    previousStatusId: string | null,
    refresh = true,
  ) {
    const result = await this.projectManager.undoStatus(path, expectedStatusId, previousStatusId);
    if (refresh && result.type === 'ok') this.projectStore.refresh();
    return result;
  }

  private openNote(path: string): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) void this.app.workspace.getLeaf(false).openFile(file);
  }

  private async setWorkNoteStatus(
    note: ProjectWorkspaceSnapshot['workNotes'][number],
    statusId: string,
  ): Promise<WorkNoteCommandResult> {
    const observed = this.workNoteCommands?.observe(note);
    if (!this.workNoteCommands || !observed) return { type: 'invalid', field: 'path' };
    return this.workNoteCommands.setStatus(observed, statusId);
  }

  private async useWorkspaceDefault(intent: UseProjectWorkspaceDefaultIntent): Promise<void> {
    if (intent.scope === 'tasks') {
      this.settings.projects.view.tasks = structuredClone(
        intent.viewState,
      ) as ProjectTasksViewState;
    } else {
      this.settings.projects.view.workNotes = structuredClone(
        intent.viewState,
      ) as WorkNotesViewState;
    }
    await this.onSaveSettings();
  }

  private renderWorkNotes(
    host: HTMLElement,
    projectPath: string,
    notes: ProjectWorkspaceSnapshot['workNotes'],
    layout: 'list' | 'board',
    milestoneRollups: ReadonlyMap<string, MilestoneRollup>,
  ): ProjectChildRenderHandle {
    if (!this.workNoteCommands) return { destroy: () => undefined };
    const capabilities = this.workNoteCommands.capabilities();
    const coarsePointer =
      Platform.isMobile ||
      host.ownerDocument.defaultView?.matchMedia?.('(pointer: coarse)').matches === true;
    const narrow = (): boolean =>
      Platform.isMobile || (host.clientWidth > 0 && host.clientWidth <= 672);
    let isNarrow = narrow();
    let child = renderWorkNotesView(host, {
      notes,
      statuses: this.workNoteCommands.statuses(),
      layout,
      viewState: this.settings.projects.view.workNotes,
      commandsEnabled: capabilities.update,
      createEnabled: capabilities.create,
      projectPath,
      onCreate: (request) => this.workNoteCommands!.create(request),
      onSetStatus: (note, statusId) => this.setWorkNoteStatus(note, statusId),
      openNote: (path) => this.openNote(path),
      session: this.workspaceSession.workNotes,
      announce: this.onAnnounce,
      isNarrow,
      coarsePointer,
      milestoneRollups,
    });
    let destroyed = false;
    const ResizeObserverCtor = host.ownerDocument.defaultView?.ResizeObserver;
    const observer = ResizeObserverCtor
      ? new ResizeObserverCtor(() => {
          if (destroyed) return;
          const next = narrow();
          if (next === isNarrow) return;
          isNarrow = next;
          child.destroy();
          child = renderWorkNotesView(host, {
            notes,
            statuses: this.workNoteCommands!.statuses(),
            layout,
            viewState: this.settings.projects.view.workNotes,
            commandsEnabled: capabilities.update,
            createEnabled: capabilities.create,
            projectPath,
            onCreate: (request) => this.workNoteCommands!.create(request),
            onSetStatus: (note, statusId) => this.setWorkNoteStatus(note, statusId),
            openNote: (path) => this.openNote(path),
            session: this.workspaceSession.workNotes,
            announce: this.onAnnounce,
            isNarrow,
            coarsePointer,
            milestoneRollups,
          });
        })
      : null;
    observer?.observe(host);
    return {
      destroy: () => {
        if (destroyed) return;
        destroyed = true;
        observer?.disconnect();
        child.destroy();
      },
    };
  }

  private renderWorkNoteTimeline(
    host: HTMLElement,
    notes: ProjectWorkspaceSnapshot['workNotes'],
  ): ProjectChildRenderHandle {
    if (!this.workNoteCommands) return { destroy: () => undefined };
    return renderWorkNotesTimeline(host, {
      notes,
      commands: this.workNoteCommands,
      commandsEnabled: this.workNoteCommands.capabilities().update,
      session: this.workspaceSession.timelines.workNotes,
      openNote: (path) => this.openNote(path),
    });
  }

  private capturePortfolioContinuity(): string | null {
    if (!this.el) return null;
    const active = this.el.ownerDocument.activeElement;
    let focusKey: string | null = null;
    if (active instanceof HTMLElement && this.el.contains(active)) {
      if (active.dataset['projectPortfolioLayout']) {
        focusKey = `layout:${active.dataset['projectPortfolioLayout']}`;
      } else if (active.dataset['projectStatusFilter']) {
        focusKey = `status:${active.dataset['projectStatusFilter']}`;
      } else if (active.hasAttribute('data-project-unmapped-filter')) {
        focusKey = 'unmapped';
      }
    }
    for (const scroll of this.el.querySelectorAll<HTMLElement>(
      '.abyss-projects-scroll, .abyss-timeline-scroll, .abyss-board-column-scroll',
    )) {
      this.portfolioScroll.set(this.portfolioScrollKey(scroll), scroll.scrollTop);
    }
    return focusKey;
  }

  private restorePortfolioContinuity(focusKey: string | null): void {
    for (const scroll of this.el.querySelectorAll<HTMLElement>(
      '.abyss-projects-scroll, .abyss-timeline-scroll, .abyss-board-column-scroll',
    )) {
      const top = this.portfolioScroll.get(this.portfolioScrollKey(scroll));
      if (top !== undefined) scroll.scrollTop = top;
    }
    if (!focusKey) return;
    const replacement = (() => {
      if (focusKey === 'unmapped') {
        return this.el.querySelector<HTMLElement>('[data-project-unmapped-filter]');
      }
      const [kind, value] = focusKey.split(':', 2);
      const attribute = kind === 'layout' ? 'projectPortfolioLayout' : 'projectStatusFilter';
      return (
        Array.from(
          this.el.querySelectorAll<HTMLElement>(
            '[data-project-portfolio-layout], [data-project-status-filter]',
          ),
        ).find((element) => element.dataset[attribute] === value) ?? null
      );
    })();
    replacement?.focus({ preventScroll: true });
  }

  private render(): void {
    const portfolioFocus = this.capturePortfolioContinuity();
    this.viewCleanup?.();
    this.viewCleanup = null;
    this.el.empty();
    this.el.addClass('abyss-projects-panel');
    const view = this.state.get('projectsPanel');

    if (view.view === 'dashboard') {
      const container = this.el.createDiv();
      const snapshot = this.snapshots.find(({ project }) => project.path === view.path);
      const dashboard = renderProjectDashboard(container, snapshot, {
        state: this.state,
        settings: this.settings,
        onSetStatus: (p, id) => void this.setStatus(p, id),
        openNote: (p) => this.openNote(p),
        workspaceSession: this.workspaceSession,
        renderTasks: this.renderTasks,
        ...(this.renderTaskBoard ? { renderTaskBoard: this.renderTaskBoard } : {}),
        ...(this.renderTaskTimeline ? { renderTaskTimeline: this.renderTaskTimeline } : {}),
        ...(this.workNoteCommands && snapshot
          ? {
              workNotesAvailable:
                snapshot.workNotes.length + snapshot.milestones.length > 0 ||
                this.workNoteCommands.capabilities().create,
              selectWorkNotes: (notes, viewState) =>
                selectWorkNotes({
                  notes,
                  statuses: this.workNoteCommands!.statuses(),
                  viewState,
                }),
              onUseWorkspaceDefault: (intent) => void this.useWorkspaceDefault(intent),
              renderWorkNotes: (host, path, notes) =>
                this.renderWorkNotes(host, path, notes, 'list', snapshot.milestoneRollups),
              renderWorkNoteBoard: (host, path, notes) =>
                this.renderWorkNotes(host, path, notes, 'board', snapshot.milestoneRollups),
              renderWorkNoteTimeline: (host, _path, notes) =>
                this.renderWorkNoteTimeline(host, notes),
            }
          : {}),
      });
      this.viewCleanup = () => dashboard.destroy();
      return;
    }

    this.workspaceSession.closeProject();
    const container = this.el.createDiv();
    const listContext = {
      state: this.state,
      settings: this.settings,
      onSaveSettings: this.onSaveSettings,
      onFiltersChanged: () => this.render(),
      onPortfolioLayoutChanged: () => this.render(),
      onCreate: (name: string) => this.createProject(name),
      onSetStatus: (p: string, id: string) => void this.setStatus(p, id),
      openNote: (p: string) => this.openNote(p),
    };
    const visibleStatusIds = new Set(this.settings.projects.view.visibleStatusIds);
    const timelineSnapshots = this.snapshots.filter(({ project }) =>
      project.statusId === null
        ? this.settings.projects.view.includeUnmapped
        : visibleStatusIds.has(project.statusId),
    );
    const timelineAvailable =
      this.projectCommands !== undefined &&
      timelineSnapshots.some(({ project }) => projectTimelineItem(project).kind !== 'undated');
    const portfolioContext = { ...listContext, timelineAvailable };
    if (this.settings.projects.view.portfolioLayout === 'timeline' && timelineAvailable) {
      const { newProjectButton } = renderProjectsToolbar(container, portfolioContext);
      const inputHost = container.createDiv({ cls: 'abyss-projects-new-input-host' });
      newProjectButton.addEventListener('click', () =>
        showNewProjectInput(inputHost, listContext.onCreate),
      );
      const timelineHost = container.createDiv({ cls: 'abyss-projects-timeline-host' });
      const handle = renderProjectsTimeline(timelineHost, {
        projects: timelineSnapshots.map(({ project }) => project),
        commands: this.projectCommands,
        session: this.workspaceSession.portfolioTimeline,
        openProject: (path) => this.state.set('projectsPanel', { view: 'dashboard', path }),
        onMutation: (_project, result) => {
          if (result.type === 'ok') this.projectStore.refresh();
        },
      });
      this.viewCleanup = () => handle.destroy();
      this.restorePortfolioContinuity(portfolioFocus);
      return;
    }
    if (this.settings.projects.view.portfolioLayout === 'timeline') {
      this.settings.projects.view.portfolioLayout = 'overview';
      void this.onSaveSettings();
    }
    if (this.settings.projects.view.portfolioLayout === 'board') {
      const board = renderProjectsBoard(container, {
        ...portfolioContext,
        snapshots: this.snapshots,
        onMoveStatus: (path, statusId) => this.setStatus(path, statusId, false),
        onUndoStatus: (path, expectedStatusId, previousStatusId) =>
          this.undoStatus(path, expectedStatusId, previousStatusId, false),
        pendingUndo: this.pendingBoardUndo,
        onUndoPending: (pending) => {
          this.onBoardUndoPending?.(pending);
        },
        onUndoStarted: (pending) => {
          this.boardUndoOwner?.started(pending);
          this.onBoardUndoStarted?.(pending);
        },
        onUndoResolved: (pending, successful) => {
          this.boardUndoOwner?.resolved(pending, successful);
          if (!this.viewCleanup) return;
          this.onBoardUndoResolved?.(pending, successful);
        },
        session: this.workspaceSession.portfolioBoard,
      });
      this.viewCleanup = () => board.destroy();
    } else {
      this.viewCleanup = renderProjectsList(container, this.snapshots, portfolioContext);
    }
    this.restorePortfolioContinuity(portfolioFocus);
  }

  destroy(): void {
    this.viewCleanup?.();
    this.viewCleanup = null;
    this.offs.forEach((f) => f());
    this.offs = [];
    this.el?.empty();
  }
}
