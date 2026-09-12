import { TFile, type App } from 'obsidian';
import type { AppState } from '../../app/AppState';
import {
  ObsidianProjectProperties,
  type ProjectPropertyCatalog,
} from '../../projects/ObsidianProjectProperties';
import type { ExpectedProjectStatus, ProjectManager } from '../../projects/ProjectManager';
import type { ProjectStore } from '../../projects/ProjectStore';
import type { ProjectCreateRequest } from '../../projects/projectCreation';
import { ProjectEditHistory } from '../../projects/projectEditHistory';
import type { ProjectCellChange, ProjectEditResult } from '../../projects/projectEdits';
import type { CalendarSettings } from '../../settings/types';
import { runAsyncAction } from '../../ui/runAsyncAction';
import { refreshProjectDashboardStatus, renderProjectDashboard } from './ProjectsDashboardView';
import { ProjectsTableView } from './ProjectsTableView';

export interface ProjectsPanelOptions {
  renderTasks?: (host: HTMLElement, path: string) => void;
  saveViewState?: () => Promise<void>;
  saveStatic?: () => Promise<void>;
  projectProperties?: ProjectPropertyCatalog;
}

/** Owns one long-lived project overview session and swaps it with the existing dashboard. */
export class ProjectsPanel {
  private readonly state_abyssPrivate: AppState;
  private readonly projectStore_abyssPrivate: ProjectStore;
  private readonly projectManager_abyssPrivate: ProjectManager;
  private readonly settings_abyssPrivate: CalendarSettings;
  private readonly app_abyssPrivate: App;
  private readonly renderTasks_abyssPrivate: (host: HTMLElement, path: string) => void;
  private readonly saveViewState_abyssPrivate: () => Promise<void>;
  private readonly saveStatic_abyssPrivate: (() => Promise<void>) | undefined;
  private readonly projectProperties_abyssPrivate: ProjectPropertyCatalog;
  private readonly editHistory_abyssPrivate: ProjectEditHistory;
  private el_abyssPrivate: HTMLElement | null = null;
  private tableHost_abyssPrivate: HTMLElement | null = null;
  private tableView_abyssPrivate: ProjectsTableView | null = null;
  private dashboardHost_abyssPrivate: HTMLElement | null = null;
  private offs_abyssPrivate: Array<() => void> = [];

  constructor(
    ...args: [AppState, ProjectStore, ProjectManager, CalendarSettings, App, ProjectsPanelOptions?]
  ) {
    const [state, projectStore, projectManager, settings, app, opts = {}] = args;
    this.state_abyssPrivate = state;
    this.projectStore_abyssPrivate = projectStore;
    this.projectManager_abyssPrivate = projectManager;
    this.settings_abyssPrivate = settings;
    this.app_abyssPrivate = app;
    this.renderTasks_abyssPrivate = opts.renderTasks ?? ((): void => {});
    this.saveViewState_abyssPrivate = opts.saveViewState ?? (async (): Promise<void> => {});
    this.saveStatic_abyssPrivate = opts.saveStatic;
    this.projectProperties_abyssPrivate =
      opts.projectProperties ?? new ObsidianProjectProperties(app);
    this.editHistory_abyssPrivate = new ProjectEditHistory((changes) =>
      this.applyProjectEdits_abyssPrivate(changes),
    );
  }

  mount(el: HTMLElement): void {
    this.el_abyssPrivate = el;
    el.addClass('abyss-projects-panel');
    this.tableHost_abyssPrivate = el.createDiv({ cls: 'abyss-projects-table-session' });
    this.tableView_abyssPrivate = new ProjectsTableView(this.tableHost_abyssPrivate, {
      app: this.app_abyssPrivate,
      state: this.state_abyssPrivate,
      settings: this.settings_abyssPrivate,
      catalog: this.projectProperties_abyssPrivate,
      saveViewState: this.saveViewState_abyssPrivate,
      ...(this.saveStatic_abyssPrivate === undefined
        ? {}
        : { saveStatic: this.saveStatic_abyssPrivate }),
      applyEdits: (changes) => this.applyProjectEdits_abyssPrivate(changes),
      history: this.editHistory_abyssPrivate,
      createProject: (request) => this.createProject_abyssPrivate(request),
      openProject: (path) => {
        this.state_abyssPrivate.set('projectsPanel', { view: 'dashboard', path });
      },
      openNote: (path) => {
        this.openNote_abyssPrivate(path);
      },
      revalidateSourceObservation: (observation) =>
        this.projectStore_abyssPrivate.revalidateSourceObservation(observation),
    });
    this.tableView_abyssPrivate.mount(this.projectStore_abyssPrivate.list());
    this.offs_abyssPrivate.push(
      this.state_abyssPrivate.on('projectsPanel', () => {
        this.syncView_abyssPrivate();
      }),
      this.projectProperties_abyssPrivate.onChange(() => {
        this.tableView_abyssPrivate?.refreshFields();
      }),
      this.projectStore_abyssPrivate.onSourceObservation((observation) => {
        this.tableView_abyssPrivate?.observeProjectSource(observation);
      }),
    );
    this.syncView_abyssPrivate();
  }

  refresh(): void {
    if (this.el_abyssPrivate === null) return;
    const view = this.state_abyssPrivate.get('projectsPanel');
    if (view.view === 'table') {
      this.tableView_abyssPrivate?.update(this.projectStore_abyssPrivate.list());
    } else this.renderDashboard_abyssPrivate(view.path);
  }

  /** Rebuilds overview field projections while preserving the owned table and board sessions. */
  refreshTableSettings(): void {
    this.tableView_abyssPrivate?.refreshFields();
    const dashboard = this.dashboardHost_abyssPrivate;
    const view = this.state_abyssPrivate.get('projectsPanel');
    if (dashboard !== null && view.view === 'dashboard') {
      refreshProjectDashboardStatus(
        dashboard,
        this.projectStore_abyssPrivate.get(view.path),
        this.settings_abyssPrivate.projects.statuses,
      );
    }
  }

  /** Runs an action after the project overview's active draft is committed or cancelled. */
  finishTableEditorBefore(action: () => void): void {
    const table = this.tableView_abyssPrivate;
    if (table === null) action();
    else table.finishEditorBeforeAction(action);
  }

  selectedProjectPath(): string | undefined {
    if (this.state_abyssPrivate.get('projectsPanel').view !== 'table') return undefined;
    return this.tableView_abyssPrivate?.selectedProjectPath();
  }

  destroy(): void {
    for (const off of this.offs_abyssPrivate) off();
    this.offs_abyssPrivate = [];
    this.tableView_abyssPrivate?.destroy();
    this.tableView_abyssPrivate = null;
    this.tableHost_abyssPrivate?.remove();
    this.tableHost_abyssPrivate = null;
    this.dashboardHost_abyssPrivate?.remove();
    this.dashboardHost_abyssPrivate = null;
    this.el_abyssPrivate?.empty();
    this.el_abyssPrivate = null;
  }

  private async createProject_abyssPrivate(request: ProjectCreateRequest): Promise<string | null> {
    if (request.recoveryPath !== undefined) {
      if (request.statusId === undefined) {
        throw new Error('A project status is required to recover project creation.');
      }
      await this.projectManager_abyssPrivate.setStatus(request.recoveryPath, request.statusId);
      this.projectStore_abyssPrivate.refresh();
      return request.recoveryPath;
    }
    const file = await this.projectManager_abyssPrivate.create(request.name, {
      ...(request.statusId === undefined ? {} : { statusId: request.statusId }),
      openFile: false,
    });
    this.projectStore_abyssPrivate.refresh();
    return file?.path ?? null;
  }

  private async saveStatus_abyssPrivate(
    path: string,
    statusId: string,
    expectedStatus?: ExpectedProjectStatus,
  ): Promise<void> {
    await this.projectManager_abyssPrivate.setStatus(path, statusId, expectedStatus);
    this.projectStore_abyssPrivate.refresh();
  }

  private async applyProjectEdits_abyssPrivate(
    changes: readonly ProjectCellChange[],
  ): Promise<ProjectEditResult> {
    return this.projectManager_abyssPrivate.applyEdits(changes);
  }

  private openNote_abyssPrivate(path: string): void {
    const file = this.app_abyssPrivate.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    runAsyncAction(
      this.app_abyssPrivate.workspace.getLeaf(false).openFile(file),
      'Could not open project note',
    );
  }

  private syncView_abyssPrivate(): void {
    const el = this.el_abyssPrivate;
    const tableHost = this.tableHost_abyssPrivate;
    if (el === null || tableHost === null) return;
    const view = this.state_abyssPrivate.get('projectsPanel');
    if (view.view === 'table') {
      this.dashboardHost_abyssPrivate?.remove();
      this.dashboardHost_abyssPrivate = null;
      el.appendChild(tableHost);
      this.tableView_abyssPrivate?.update(this.projectStore_abyssPrivate.list());
      return;
    }
    tableHost.remove();
    this.renderDashboard_abyssPrivate(view.path);
  }

  private renderDashboard_abyssPrivate(path: string): void {
    const el = this.el_abyssPrivate;
    if (el === null) return;
    this.dashboardHost_abyssPrivate?.remove();
    const host = el.createDiv({ cls: 'abyss-project-dashboard-session' });
    this.dashboardHost_abyssPrivate = host;
    renderProjectDashboard(host, this.projectStore_abyssPrivate.get(path), {
      state: this.state_abyssPrivate,
      settings: this.settings_abyssPrivate,
      onSetStatus: (projectPath, statusId) => {
        runAsyncAction(
          this.saveStatus_abyssPrivate(projectPath, statusId),
          'Could not update project status',
        );
      },
      openNote: (projectPath) => {
        this.openNote_abyssPrivate(projectPath);
      },
      renderTasks: this.renderTasks_abyssPrivate,
    });
  }
}
