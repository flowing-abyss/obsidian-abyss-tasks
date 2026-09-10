import { TFile, type App } from 'obsidian';
import type { AppState } from '../../app/AppState';
import {
  ObsidianProjectProperties,
  type ProjectPropertyCatalog,
} from '../../projects/ObsidianProjectProperties';
import type { ExpectedProjectStatus, ProjectManager } from '../../projects/ProjectManager';
import type { ProjectStore } from '../../projects/ProjectStore';
import { ProjectEditHistory } from '../../projects/projectEditHistory';
import type { ProjectCellChange, ProjectEditResult } from '../../projects/projectEdits';
import type { CalendarSettings } from '../../settings/types';
import { runAsyncAction } from '../../ui/runAsyncAction';
import { renderProjectDashboard } from './ProjectsDashboardView';
import { ProjectsTableView } from './ProjectsTableView';

export interface ProjectsPanelOptions {
  renderTasks?: (host: HTMLElement, path: string) => void;
  saveViewState?: () => Promise<void>;
  saveStatic?: () => Promise<void>;
  projectProperties?: ProjectPropertyCatalog;
}

/** Owns one long-lived table session and swaps it with the existing dashboard. */
export class ProjectsPanel {
  private readonly state: AppState;
  private readonly projectStore: ProjectStore;
  private readonly projectManager: ProjectManager;
  private readonly settings: CalendarSettings;
  private readonly app: App;
  private readonly renderTasks: (host: HTMLElement, path: string) => void;
  private readonly saveViewState: () => Promise<void>;
  private readonly saveStatic: (() => Promise<void>) | undefined;
  private readonly projectProperties: ProjectPropertyCatalog;
  private readonly editHistory: ProjectEditHistory;
  private el: HTMLElement | null = null;
  private tableHost: HTMLElement | null = null;
  private tableView: ProjectsTableView | null = null;
  private dashboardHost: HTMLElement | null = null;
  private offs: Array<() => void> = [];

  constructor(
    ...args: [AppState, ProjectStore, ProjectManager, CalendarSettings, App, ProjectsPanelOptions?]
  ) {
    const [state, projectStore, projectManager, settings, app, opts = {}] = args;
    this.state = state;
    this.projectStore = projectStore;
    this.projectManager = projectManager;
    this.settings = settings;
    this.app = app;
    this.renderTasks = opts.renderTasks ?? ((): void => {});
    this.saveViewState = opts.saveViewState ?? (async (): Promise<void> => {});
    this.saveStatic = opts.saveStatic;
    this.projectProperties = opts.projectProperties ?? new ObsidianProjectProperties(app);
    this.editHistory = new ProjectEditHistory((changes) => this.applyTableEdits(changes));
  }

  mount(el: HTMLElement): void {
    this.el = el;
    el.addClass('abyss-projects-panel');
    this.tableHost = el.createDiv({ cls: 'abyss-projects-table-session' });
    this.tableView = new ProjectsTableView(this.tableHost, {
      app: this.app,
      state: this.state,
      settings: this.settings,
      catalog: this.projectProperties,
      saveViewState: this.saveViewState,
      ...(this.saveStatic === undefined ? {} : { saveStatic: this.saveStatic }),
      applyEdits: (changes) => this.applyTableEdits(changes),
      history: this.editHistory,
      createProject: (name) => this.createProject(name),
      openProject: (path) => {
        this.state.set('projectsPanel', { view: 'dashboard', path });
      },
      revalidateSourceObservation: (observation) =>
        this.projectStore.revalidateSourceObservation(observation),
    });
    this.tableView.mount(this.projectStore.list());
    this.offs.push(
      this.state.on('projectsPanel', () => {
        this.syncView();
      }),
      this.projectProperties.onChange(() => {
        this.tableView?.refreshFields();
      }),
      this.projectStore.onSourceObservation((observation) => {
        this.tableView?.observeProjectSource(observation);
      }),
    );
    this.syncView();
  }

  refresh(): void {
    if (this.el === null) return;
    const view = this.state.get('projectsPanel');
    if (view.view === 'table') this.tableView?.update(this.projectStore.list());
    else this.renderDashboard(view.path);
  }

  /** Rebuilds table field/column projections while preserving the owned table session. */
  refreshTableSettings(): void {
    this.tableView?.refreshFields();
  }

  /** Runs an action after the table's active draft is committed or explicitly cancelled. */
  finishTableEditorBefore(action: () => void): void {
    const table = this.tableView;
    if (table === null) action();
    else table.finishEditorBeforeAction(action);
  }

  selectedProjectPath(): string | undefined {
    if (this.state.get('projectsPanel').view !== 'table') return undefined;
    return this.tableView?.selectedProjectPath();
  }

  destroy(): void {
    for (const off of this.offs) off();
    this.offs = [];
    this.tableView?.destroy();
    this.tableView = null;
    this.tableHost?.remove();
    this.tableHost = null;
    this.dashboardHost?.remove();
    this.dashboardHost = null;
    this.el?.empty();
    this.el = null;
  }

  private async createProject(name: string): Promise<void> {
    await this.projectManager.create(name);
    this.projectStore.refresh();
  }

  private async saveStatus(
    path: string,
    statusId: string,
    expectedStatus?: ExpectedProjectStatus,
  ): Promise<void> {
    await this.projectManager.setStatus(path, statusId, expectedStatus);
    this.projectStore.refresh();
  }

  private async applyTableEdits(changes: readonly ProjectCellChange[]): Promise<ProjectEditResult> {
    return this.projectManager.applyEdits(changes);
  }

  private openNote(path: string): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    runAsyncAction(this.app.workspace.getLeaf(false).openFile(file), 'Could not open project note');
  }

  private syncView(): void {
    const el = this.el;
    const tableHost = this.tableHost;
    if (el === null || tableHost === null) return;
    const view = this.state.get('projectsPanel');
    if (view.view === 'table') {
      this.dashboardHost?.remove();
      this.dashboardHost = null;
      el.appendChild(tableHost);
      this.tableView?.update(this.projectStore.list());
      return;
    }
    tableHost.remove();
    this.renderDashboard(view.path);
  }

  private renderDashboard(path: string): void {
    const el = this.el;
    if (el === null) return;
    this.dashboardHost?.remove();
    const host = el.createDiv({ cls: 'abyss-project-dashboard-session' });
    this.dashboardHost = host;
    renderProjectDashboard(host, this.projectStore.get(path), {
      state: this.state,
      settings: this.settings,
      onSetStatus: (projectPath, statusId) => {
        runAsyncAction(this.saveStatus(projectPath, statusId), 'Could not update project status');
      },
      openNote: (projectPath) => {
        this.openNote(projectPath);
      },
      renderTasks: this.renderTasks,
    });
  }
}
