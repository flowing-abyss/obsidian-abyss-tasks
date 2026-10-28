import type { App } from 'obsidian';
import type { AppState } from '../../app/AppState';
import {
  ObsidianProjectProperties,
  type ProjectPropertyCatalog,
} from '../../projects/ObsidianProjectProperties';
import type { ProjectManager } from '../../projects/ProjectManager';
import { ProjectMutationSession } from '../../projects/ProjectMutationSession';
import type { ProjectStore } from '../../projects/ProjectStore';
import type { ProjectCreateRequest } from '../../projects/projectCreation';
import { ProjectEditValidationError } from '../../projects/projectEditError';
import { ProjectEditHistory } from '../../projects/projectEditHistory';
import type { ProjectCellChange, ProjectEditResult } from '../../projects/projectEdits';
import { buildProjectFieldCatalog } from '../../projects/projectFields';
import type { Project } from '../../projects/types';
import type { CalendarSettings } from '../../settings/types';
import type { LocalSearchFocusTarget } from '../../ui/localSearchKeys';
import { changeProjectStatus, openProjectNote } from '../../ui/projectActions';
import { runAsyncAction } from '../../ui/runAsyncAction';
import type {
  TimelineContextOverlay,
  TimelineContextOverlayLayout,
} from '../timeline/TimelineContextOverlay';
import { ProjectDashboardTimeline } from './ProjectDashboardTimeline';
import {
  disposeProjectDashboard,
  finishProjectDashboardEditorBefore,
  refreshProjectDashboard,
  renderProjectDashboard,
} from './ProjectsDashboardView';
import { ProjectsTableView } from './ProjectsTableView';

export interface ProjectsPanelOptions {
  unmountTasks?: () => void;
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
  private readonly unmountTasks_abyssPrivate: () => void;
  private readonly renderTasks_abyssPrivate: (host: HTMLElement, path: string) => void;
  private readonly saveViewState_abyssPrivate: () => Promise<void>;
  private readonly saveStatic_abyssPrivate: (() => Promise<void>) | undefined;
  private readonly projectProperties_abyssPrivate: ProjectPropertyCatalog;
  private readonly editHistory_abyssPrivate: ProjectEditHistory;
  private mutationSession_abyssPrivate: ProjectMutationSession | null = null;
  private el_abyssPrivate: HTMLElement | null = null;
  private tableHost_abyssPrivate: HTMLElement | null = null;
  private tableView_abyssPrivate: ProjectsTableView | null = null;
  private dashboardHost_abyssPrivate: HTMLElement | null = null;
  private dashboardPath_abyssPrivate: string | null = null;
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
    this.unmountTasks_abyssPrivate = opts.unmountTasks ?? (() => {});
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
    const session = new ProjectMutationSession({
      revalidateSourceObservation: (observation) =>
        this.projectStore_abyssPrivate.revalidateSourceObservation(observation),
      onChange: (change) => {
        this.tableView_abyssPrivate?.onMutationSessionChange(change);
        const view = this.state_abyssPrivate.get('projectsPanel');
        if (
          view.view === 'dashboard' &&
          (change.type === 'projection' || (change.type === 'source' && view.path === change.path))
        )
          this.renderDashboard_abyssPrivate(view.path);
      },
    });
    this.mutationSession_abyssPrivate = session;
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
      mutationSession: session,
    });
    this.tableView_abyssPrivate.mount(this.projectStore_abyssPrivate.list());
    this.offs_abyssPrivate.push(
      this.state_abyssPrivate.on('projectsPanel', () => {
        this.syncView_abyssPrivate();
      }),
      this.projectProperties_abyssPrivate.onChange(() => {
        this.tableView_abyssPrivate?.refreshFields();
        const view = this.state_abyssPrivate.get('projectsPanel');
        if (view.view === 'dashboard') this.renderDashboard_abyssPrivate(view.path);
      }),
      this.projectStore_abyssPrivate.onSourceObservation((observation) => {
        session.observe(observation);
      }),
    );
    this.syncView_abyssPrivate(true);
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
      this.renderDashboard_abyssPrivate(view.path);
    }
  }

  mountDashboardTimeline(
    host: HTMLElement,
    layout: TimelineContextOverlayLayout,
  ): TimelineContextOverlay | undefined {
    const view = this.state_abyssPrivate.get('projectsPanel');
    if (view.view !== 'dashboard') return undefined;
    const path = view.path;
    return new ProjectDashboardTimeline(host, {
      ...layout,
      project: () => {
        const current = this.state_abyssPrivate.get('projectsPanel');
        return this.state_abyssPrivate.get('mode') === 'projects' &&
          current.view === 'dashboard' &&
          current.path === path
          ? this.dashboardProject_abyssPrivate(path)
          : undefined;
      },
      fields: () =>
        buildProjectFieldCatalog(
          this.settings_abyssPrivate.projects,
          this.projectProperties_abyssPrivate.list(),
        ),
      apply: (changes) =>
        this.runDashboardMutation_abyssPrivate(async () => {
          const result = await this.applyProjectEdits_abyssPrivate(changes);
          this.editHistory_abyssPrivate.record(result);
          return result;
        }),
      history: (direction) =>
        this.runDashboardMutation_abyssPrivate(() => this.editHistory_abyssPrivate[direction]()),
    });
  }

  private dashboardProject_abyssPrivate(path: string): Project | undefined {
    const project = this.projectStore_abyssPrivate.get(path);
    return project === undefined
      ? undefined
      : (this.mutationSession_abyssPrivate?.project(
          [project],
          this.settings_abyssPrivate.projects,
        )[0] ?? project);
  }

  private runDashboardMutation_abyssPrivate(
    mutation: () => Promise<ProjectEditResult>,
  ): Promise<ProjectEditResult> {
    const session = this.mutationSession_abyssPrivate;
    if (session === null)
      return Promise.reject(
        new ProjectEditValidationError('The project session is no longer available.'),
      );
    return session.run(async () => {
      const result = await mutation();
      if (result.applied.length > 0 && this.mutationSession_abyssPrivate === session) {
        session.publish(result.applied);
        this.projectStore_abyssPrivate.refresh();
      }
      return result;
    });
  }

  /** Runs an action after the project overview's active draft is committed or cancelled. */
  finishTableEditorBefore(action: () => void): void {
    if (finishProjectDashboardEditorBefore(this.dashboardHost_abyssPrivate, action)) return;
    const table = this.tableView_abyssPrivate;
    if (table === null) action();
    else table.finishEditorBeforeAction(action);
  }

  localSearchTarget(): LocalSearchFocusTarget | undefined {
    if (this.state_abyssPrivate.get('projectsPanel').view !== 'table') return undefined;
    return this.tableView_abyssPrivate?.localSearchTarget();
  }

  selectedProjectPath(): string | undefined {
    if (this.state_abyssPrivate.get('projectsPanel').view !== 'table') return undefined;
    return this.tableView_abyssPrivate?.selectedProjectPath();
  }

  destroy(): void {
    this.mutationSession_abyssPrivate?.dispose();
    this.mutationSession_abyssPrivate = null;
    for (const off of this.offs_abyssPrivate) off();
    this.offs_abyssPrivate = [];
    this.tableView_abyssPrivate?.destroy();
    this.tableView_abyssPrivate = null;
    this.tableHost_abyssPrivate?.remove();
    this.tableHost_abyssPrivate = null;
    if (this.dashboardHost_abyssPrivate !== null) this.unmountTasks_abyssPrivate();
    if (this.dashboardHost_abyssPrivate !== null)
      disposeProjectDashboard(this.dashboardHost_abyssPrivate);
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
    const file = await this.projectManager_abyssPrivate.create(
      request.name,
      request.statusId === undefined ? {} : { statusId: request.statusId },
    );
    this.projectStore_abyssPrivate.refresh();
    return file?.path ?? null;
  }

  private async applyProjectEdits_abyssPrivate(
    changes: readonly ProjectCellChange[],
  ): Promise<ProjectEditResult> {
    return this.projectManager_abyssPrivate.applyEdits(changes);
  }

  private changeProjectStatus_abyssPrivate(projectPath: string, statusId: string): void {
    const owner = this.mutationSession_abyssPrivate;
    if (owner === null) return;
    const name = this.settings_abyssPrivate.projects.statuses.find(
      ({ id }) => id === statusId,
    )?.name;
    let started = false;
    const action = owner.run(async () => {
      started = true;
      await changeProjectStatus(
        {
          setStatus: async (path, id) => {
            const result = await this.projectManager_abyssPrivate.setStatus(path, id, undefined, {
              name,
            });
            if (this.mutationSession_abyssPrivate === owner) owner.publish(result.applied);
            return result;
          },
        },
        { path: projectPath, statusId },
        () => {
          if (this.mutationSession_abyssPrivate === owner) this.projectStore_abyssPrivate.refresh();
        },
      );
    });
    runAsyncAction(
      action.catch((error: unknown) => {
        if (
          !started &&
          this.mutationSession_abyssPrivate !== owner &&
          error instanceof ProjectEditValidationError
        )
          return;
        throw error;
      }),
      'Could not update project status',
    );
  }

  private openNote_abyssPrivate(path: string, newTab = false): void {
    runAsyncAction(
      openProjectNote(this.app_abyssPrivate, path, newTab),
      'Could not open project note',
    );
  }

  private syncView_abyssPrivate(tableAlreadyCurrent = false): void {
    const el = this.el_abyssPrivate;
    const tableHost = this.tableHost_abyssPrivate;
    if (el === null || tableHost === null) return;
    const view = this.state_abyssPrivate.get('projectsPanel');
    if (view.view === 'table') {
      this.restoreOverview_abyssPrivate(tableHost, el, tableAlreadyCurrent);
      return;
    }
    this.tableView_abyssPrivate?.captureViewportBeforeHide();
    tableHost.remove();
    this.renderDashboard_abyssPrivate(view.path);
  }

  private restoreOverview_abyssPrivate(
    tableHost: HTMLElement,
    el: HTMLElement,
    tableAlreadyCurrent: boolean,
  ): void {
    const dashboard = this.dashboardHost_abyssPrivate;
    const allowFocus = dashboard?.contains(tableHost.ownerDocument.activeElement) === true;
    if (dashboard !== null) this.unmountTasks_abyssPrivate();
    if (dashboard !== null) disposeProjectDashboard(dashboard);
    dashboard?.remove();
    this.dashboardHost_abyssPrivate = null;
    el.appendChild(tableHost);
    if (!tableAlreadyCurrent)
      this.tableView_abyssPrivate?.update(this.projectStore_abyssPrivate.list());
    if (dashboard !== null) this.tableView_abyssPrivate?.restoreDashboardFocus(allowFocus);
  }

  private renderDashboard_abyssPrivate(path: string): void {
    const el = this.el_abyssPrivate;
    if (el === null) return;
    const previous = this.dashboardHost_abyssPrivate;
    if (
      previous !== null &&
      this.dashboardPath_abyssPrivate === path &&
      refreshProjectDashboard(
        previous,
        this.dashboardProject_abyssPrivate(path),
        this.renderTasks_abyssPrivate,
        this.settings_abyssPrivate.projects.statuses,
      )
    )
      return;
    // A render of the project already shown keeps its place; opening a project starts at its top.
    const scrollTop =
      previous !== null && this.dashboardPath_abyssPrivate === path ? previous.scrollTop : 0;
    if (previous !== null) this.unmountTasks_abyssPrivate();
    disposeProjectDashboard(previous);
    previous?.remove();
    const host = el.createDiv({ cls: 'abyss-project-dashboard-session' });
    this.dashboardHost_abyssPrivate = host;
    this.dashboardPath_abyssPrivate = path;
    renderProjectDashboard(host, this.dashboardProject_abyssPrivate(path), {
      finishEditorBefore: (action) => {
        this.finishTableEditorBefore(action);
      },
      editor: {
        app: this.app_abyssPrivate,
        catalog: this.projectProperties_abyssPrivate,
        capture: (project, field) => {
          const owner = this.mutationSession_abyssPrivate;
          const session = this.tableView_abyssPrivate?.createFieldEditorSession(project, field);
          if (session === undefined) return undefined;
          return {
            ...session,
            save: async (value) => {
              await session.save(value);
              if (this.mutationSession_abyssPrivate !== owner) return;
              this.projectStore_abyssPrivate.refresh();
            },
          };
        },
      },
      state: this.state_abyssPrivate,
      settings: this.settings_abyssPrivate,
      onSetStatus: (projectPath, statusId) => {
        this.changeProjectStatus_abyssPrivate(projectPath, statusId);
      },
      openNote: (projectPath) => {
        this.openNote_abyssPrivate(projectPath, true);
      },
      renderTasks: this.renderTasks_abyssPrivate,
    });
    if (scrollTop > 0) host.scrollTop = scrollTop;
  }
}
