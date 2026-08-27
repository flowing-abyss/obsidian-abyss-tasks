import { TFile, type App } from 'obsidian';
import type { AppState } from '../../app/AppState';
import type { ProjectManager } from '../../projects/ProjectManager';
import type { ProjectStore } from '../../projects/ProjectStore';
import type { ProjectWorkspaceSnapshot } from '../../projects/types';
import type { CalendarSettings } from '../../settings/types';
import { renderProjectsBoard } from './ProjectsBoardView';
import { renderProjectDashboard } from './ProjectsDashboardView';
import { renderProjectsList } from './ProjectsListView';

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

  private async setStatus(path: string, statusId: string) {
    const result = await this.projectManager.setStatus(path, statusId);
    if (result.type === 'ok') this.projectStore.refresh();
    return result;
  }

  private async undoStatus(
    path: string,
    expectedStatusId: string,
    previousStatusId: string | null,
  ) {
    const result = await this.projectManager.undoStatus(path, expectedStatusId, previousStatusId);
    if (result.type === 'ok') this.projectStore.refresh();
    return result;
  }

  private openNote(path: string): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) void this.app.workspace.getLeaf(false).openFile(file);
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
          renderTasks: this.renderTasks,
          ...(this.renderTaskBoard ? { renderTaskBoard: this.renderTaskBoard } : {}),
        },
      );
      return;
    }

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
        onMoveStatus: (path, statusId) => this.setStatus(path, statusId),
        onUndoStatus: (path, expectedStatusId, previousStatusId) =>
          this.undoStatus(path, expectedStatusId, previousStatusId),
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
