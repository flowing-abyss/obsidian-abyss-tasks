import { TFile, type App } from 'obsidian';
import type { AppState } from '../../app/AppState';
import type { ProjectPropertyCommandResult } from '../../projects/ProjectCommandService';
import type { ProjectManager } from '../../projects/ProjectManager';
import type { ProjectStore } from '../../projects/ProjectStore';
import type { ProjectWorkspaceSnapshot } from '../../projects/types';
import type { WorkNoteCommandService } from '../../projects/work-notes/WorkNoteCommandService';
import type { WorkNoteCommandResult } from '../../projects/work-notes/types';
import type { CalendarSettings } from '../../settings/types';
import { ProjectWorkspaceSession } from './ProjectWorkspaceSession';
import { renderProjectsBoard } from './ProjectsBoardView';
import { renderProjectDashboard } from './ProjectsDashboardView';
import { renderProjectsList } from './ProjectsListView';
import { renderWorkNotesView } from './WorkNotesView';

export interface ProjectsPanelOptions {
  /** Render a project's tasks into `host` (PanelView wires this to reuse task rendering). */
  renderTasks?: (host: HTMLElement, path: string, tasks: ProjectWorkspaceSnapshot['tasks']) => void;
  renderTaskBoard?: (
    host: HTMLElement,
    path: string,
    tasks: ProjectWorkspaceSnapshot['tasks'],
  ) => void;
  snapshots?: readonly ProjectWorkspaceSnapshot[];
  onSaveSettings?: () => Promise<void>;
  pendingBoardUndo?: PendingProjectBoardUndo;
  onBoardUndoPending?: (pending: PendingProjectBoardUndo) => void;
  onBoardUndoResolved?: () => void;
  workNoteCommands?: WorkNoteCommandService;
  workspaceSession?: ProjectWorkspaceSession;
}

export interface PendingProjectBoardUndo {
  readonly path: string;
  readonly columnKey: string;
  readonly result: Extract<ProjectPropertyCommandResult, { type: 'ok' }>;
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
  private readonly snapshots: readonly ProjectWorkspaceSnapshot[];
  private readonly onSaveSettings: () => Promise<void>;
  private readonly pendingBoardUndo: PendingProjectBoardUndo | undefined;
  private readonly onBoardUndoPending: ((pending: PendingProjectBoardUndo) => void) | undefined;
  private readonly onBoardUndoResolved: (() => void) | undefined;
  private readonly workNoteCommands: WorkNoteCommandService | undefined;
  private readonly workspaceSession: ProjectWorkspaceSession;
  private viewCleanup: (() => void) | null = null;

  constructor(
    private state: AppState,
    private projectStore: ProjectStore,
    private projectManager: ProjectManager,
    private settings: CalendarSettings,
    private app: App,
    opts: ProjectsPanelOptions = {},
  ) {
    this.renderTasks = opts.renderTasks ?? ((): void => {});
    this.renderTaskBoard = opts.renderTaskBoard;
    this.snapshots = opts.snapshots ?? [];
    this.onSaveSettings = opts.onSaveSettings ?? (async (): Promise<void> => {});
    this.pendingBoardUndo = opts.pendingBoardUndo;
    this.onBoardUndoPending = opts.onBoardUndoPending;
    this.onBoardUndoResolved = opts.onBoardUndoResolved;
    this.workNoteCommands = opts.workNoteCommands;
    this.workspaceSession = opts.workspaceSession ?? new ProjectWorkspaceSession();
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

  private renderWorkNotes(
    host: HTMLElement,
    projectPath: string,
    notes: ProjectWorkspaceSnapshot['workNotes'],
    layout: 'list' | 'board',
  ): void {
    if (!this.workNoteCommands) return;
    const capabilities = this.workNoteCommands.capabilities();
    renderWorkNotesView(host, {
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
    });
  }

  private render(): void {
    this.viewCleanup?.();
    this.viewCleanup = null;
    this.el.empty();
    this.el.addClass('abyss-projects-panel');
    const view = this.state.get('projectsPanel');

    if (view.view === 'dashboard') {
      const container = this.el.createDiv();
      renderProjectDashboard(
        container,
        this.snapshots.find(({ project }) => project.path === view.path),
        {
          state: this.state,
          settings: this.settings,
          onSetStatus: (p, id) => void this.setStatus(p, id),
          openNote: (p) => this.openNote(p),
          workspaceSession: this.workspaceSession,
          renderTasks: this.renderTasks,
          ...(this.renderTaskBoard ? { renderTaskBoard: this.renderTaskBoard } : {}),
          ...(this.workNoteCommands
            ? {
                renderWorkNotes: (host, path, notes) =>
                  this.renderWorkNotes(host, path, notes, 'list'),
                renderWorkNoteBoard: (host, path, notes) =>
                  this.renderWorkNotes(host, path, notes, 'board'),
              }
            : {}),
        },
      );
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
    if (this.settings.projects.view.portfolioLayout === 'board') {
      const board = renderProjectsBoard(container, {
        ...listContext,
        snapshots: this.snapshots,
        onMoveStatus: (path, statusId) => this.setStatus(path, statusId, false),
        onUndoStatus: (path, expectedStatusId, previousStatusId) =>
          this.undoStatus(path, expectedStatusId, previousStatusId, false),
        pendingUndo: this.pendingBoardUndo,
        onUndoPending: (pending) => {
          this.onBoardUndoPending?.(pending);
        },
        onUndoResolved: () => {
          this.onBoardUndoResolved?.();
        },
      });
      this.viewCleanup = () => board.destroy();
    } else {
      this.viewCleanup = renderProjectsList(container, this.snapshots, listContext);
    }
  }

  destroy(): void {
    this.viewCleanup?.();
    this.viewCleanup = null;
    this.offs.forEach((f) => f());
    this.offs = [];
    this.el?.empty();
  }
}
