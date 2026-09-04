import { TFile, type App } from 'obsidian';
import type { AppState } from '../../app/AppState';
import type { ProjectManager } from '../../projects/ProjectManager';
import type { ProjectStore } from '../../projects/ProjectStore';
import type { CalendarSettings } from '../../settings/types';
import { runAsyncAction } from '../../ui/runAsyncAction';
import { renderProjectDashboard } from './ProjectsDashboardView';
import { renderProjectsList } from './ProjectsListView';

export interface ProjectsPanelOptions {
  /** Render a project's tasks into `host` (PanelView wires this to reuse task rendering). */
  renderTasks?: (host: HTMLElement, path: string) => void;
}

/**
 * The `projects` mode surface. Self-contained deep mode: switches internally
 * between the List overview and a single-project Dashboard via `projectsPanel`
 * state, never touching the global `mode`.
 */
export class ProjectsPanel {
  private readonly state: AppState;
  private readonly projectStore: ProjectStore;
  private readonly projectManager: ProjectManager;
  private readonly settings: CalendarSettings;
  private readonly app: App;
  private el: HTMLElement | null = null;
  private offs: Array<() => void> = [];
  private readonly renderTasks: (host: HTMLElement, path: string) => void;

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
    this.offs.push(
      this.state.on('projectsPanel', () => {
        this.render();
      }),
    );
    this.render();
  }

  refresh(): void {
    if (this.el !== null) this.render();
  }

  private setStatus(path: string, statusId: string): void {
    runAsyncAction(
      this.projectManager.setStatus(path, statusId).then(() => {
        this.projectStore.refresh();
      }),
      'Could not update project status',
    );
  }

  private openNote(path: string): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      runAsyncAction(
        this.app.workspace.getLeaf(false).openFile(file),
        'Could not open project note',
      );
    }
  }

  private render(): void {
    const el = this.el;
    if (el === null) return;
    el.empty();
    el.addClass('abyss-projects-panel');
    const view = this.state.get('projectsPanel');

    if (view.view === 'dashboard') {
      const container = el.createDiv();
      renderProjectDashboard(container, this.projectStore.get(view.path), {
        state: this.state,
        settings: this.settings,
        onSetStatus: (p, id) => {
          this.setStatus(p, id);
        },
        openNote: (p) => {
          this.openNote(p);
        },
        renderTasks: this.renderTasks,
      });
      return;
    }

    const container = el.createDiv();
    renderProjectsList(container, this.projectStore.list(), {
      state: this.state,
      settings: this.settings,
      onCreate: (name) => this.createProject(name),
      onSetStatus: (p, id) => {
        this.setStatus(p, id);
      },
      openNote: (p) => {
        this.openNote(p);
      },
    });
  }

  destroy(): void {
    this.offs.forEach((f) => {
      f();
    });
    this.offs = [];
    this.el?.empty();
    this.el = null;
  }
}
