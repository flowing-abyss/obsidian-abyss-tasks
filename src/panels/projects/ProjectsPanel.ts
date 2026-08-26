import { TFile, type App } from 'obsidian';
import type { AppState } from '../../app/AppState';
import type { ProjectManager } from '../../projects/ProjectManager';
import type { ProjectStore } from '../../projects/ProjectStore';
import type { ProjectWorkspaceSnapshot } from '../../projects/types';
import type { CalendarSettings } from '../../settings/types';
import { renderProjectDashboard } from './ProjectsDashboardView';
import { renderProjectsList } from './ProjectsListView';

export interface ProjectsPanelOptions {
  /** Render a project's tasks into `host` (PanelView wires this to reuse task rendering). */
  renderTasks?: (host: HTMLElement, path: string, tasks: ProjectWorkspaceSnapshot['tasks']) => void;
  snapshots?: readonly ProjectWorkspaceSnapshot[];
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
  private readonly snapshots: readonly ProjectWorkspaceSnapshot[];

  constructor(
    private state: AppState,
    private projectStore: ProjectStore,
    private projectManager: ProjectManager,
    private settings: CalendarSettings,
    private app: App,
    opts: ProjectsPanelOptions = {},
  ) {
    this.renderTasks = opts.renderTasks ?? ((): void => {});
    this.snapshots = opts.snapshots ?? [];
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

  private setStatus(path: string, statusId: string): void {
    void this.projectManager.setStatus(path, statusId).then(() => this.projectStore.refresh());
  }

  private openNote(path: string): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) void this.app.workspace.getLeaf(false).openFile(file);
  }

  private render(): void {
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
          onSetStatus: (p, id) => this.setStatus(p, id),
          openNote: (p) => this.openNote(p),
          renderTasks: this.renderTasks,
        },
      );
      return;
    }

    const container = this.el.createDiv();
    renderProjectsList(
      container,
      this.snapshots.map(({ project, taskRollup }) => ({ ...project, stats: taskRollup })),
      {
        state: this.state,
        settings: this.settings,
        onCreate: (name) => this.createProject(name),
        onSetStatus: (p, id) => this.setStatus(p, id),
        openNote: (p) => this.openNote(p),
      },
    );
  }

  destroy(): void {
    this.offs.forEach((f) => f());
    this.offs = [];
    this.el?.empty();
  }
}
