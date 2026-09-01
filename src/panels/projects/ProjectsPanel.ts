import { Notice, Platform, TFile, type App } from 'obsidian';
import type { AppState } from '../../app/AppState';
import type {
  ProjectCommandService,
  ProjectMetadataCommandResult,
  ProjectPropertyCommandResult,
  ProjectRangeCommandResult,
} from '../../projects/ProjectCommandService';
import type { ProjectCreateResult, ProjectManager } from '../../projects/ProjectManager';
import type { ProjectStore } from '../../projects/ProjectStore';
import { parseProjectDate } from '../../projects/projectDates';
import type { ProjectPropertyWrite } from '../../projects/properties/ProjectPropertyAdapter';
import type { ProjectPropertyWriteResult } from '../../projects/properties/ProjectPropertyCommands';
import type { ProjectPriority, ProjectWorkspaceSnapshot } from '../../projects/types';
import type { WorkNoteCommandService } from '../../projects/work-notes/WorkNoteCommandService';
import { isAuditAccepted } from '../../projects/work-notes/compatibility';
import type { MilestoneRollup } from '../../projects/work-notes/rollups';
import type { WorkNoteCommandResult } from '../../projects/work-notes/types';
import type {
  CalendarSettings,
  ProjectTasksViewState,
  PropertyFilter,
  WorkNotesCollectionPreference,
  WorkNotesViewState,
} from '../../settings/types';
import {
  deriveInspectorSelection,
  inspectorSelectionKey,
} from '../../ui/inspector/InspectorSelection';
import { tableVisibleFields } from '../../ui/table/TablePreferences';
import { ProjectWorkspaceSession } from './ProjectWorkspaceSession';
import { renderProjectsBoard } from './ProjectsBoardView';
import { renderProjectDashboard } from './ProjectsDashboardView';
import {
  focusExistingProjectCapture,
  renderProjectsList,
  showNewProjectInput,
} from './ProjectsListView';
import { projectTableFields, renderProjectsTable } from './ProjectsTableView';
import {
  renderContainerResponsiveTimeline,
  renderProjectsTimeline,
  renderWorkNotesTimeline,
} from './ProjectsTimelineView';
import { renderProjectsToolbar } from './ProjectsToolbar';
import { renderWorkNotesView, selectWorkNotes } from './WorkNotesView';
import type { BoardViewPreference } from './boardPreferences';
import type { ProjectChildRenderHandle } from './viewContext';

export interface ProjectsPanelOptions {
  /** Render a project's tasks into `host` (PanelView wires this to reuse task rendering). */
  renderTasks?: (
    host: HTMLElement,
    path: string,
    tasks: ProjectWorkspaceSnapshot['tasks'],
    viewState: ProjectTasksViewState,
    allTasks?: ProjectWorkspaceSnapshot['tasks'],
    onAddPropertyFilter?: (filter: PropertyFilter) => void,
  ) => ProjectChildRenderHandle;
  renderTaskBoard?: (
    host: HTMLElement,
    path: string,
    tasks: ProjectWorkspaceSnapshot['tasks'],
    viewState: ProjectTasksViewState,
    allTasks?: ProjectWorkspaceSnapshot['tasks'],
    onAddPropertyFilter?: (filter: PropertyFilter) => void,
  ) => ProjectChildRenderHandle;
  renderTaskTimeline?: (
    host: HTMLElement,
    path: string,
    tasks: ProjectWorkspaceSnapshot['tasks'],
    viewState: ProjectTasksViewState,
    allTasks?: ProjectWorkspaceSnapshot['tasks'],
    onAddPropertyFilter?: (filter: PropertyFilter) => void,
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
  onTaskContextMenu?: (
    event: MouseEvent,
    projectPath: string,
    task: ProjectWorkspaceSnapshot['tasks'][number],
    anchor?: HTMLElement,
  ) => void;
  nextActionState?: (
    task: ProjectWorkspaceSnapshot['tasks'][number]['task'],
  ) => boolean | undefined;
  /** Monotonic ProjectWorkspaceReadModel publication owned by CenterPanel. */
  publicationSequence?: number;
  pathSuccessor?: (observedPath: string, publishedPath: string) => boolean;
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
  private readonly persistCollectionPreferences: boolean;
  private readonly onAnnounce: (message: string) => void;
  private readonly onTaskContextMenu: ProjectsPanelOptions['onTaskContextMenu'];
  private readonly nextActionState: ProjectsPanelOptions['nextActionState'];
  private readonly publicationSequence: number | undefined;
  private readonly pathSuccessor: ProjectsPanelOptions['pathSuccessor'];
  private viewCleanup: (() => void) | null = null;
  /** The dashboard owns a mounted collection instance until an actual close. */
  private dashboardSessionPath: string | null = null;
  private readonly portfolioScroll = new Map<string, number>();
  private portfolioFocusIntent: string | null = null;

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
    this.persistCollectionPreferences = opts.onSaveSettings !== undefined;
    this.pendingBoardUndo = opts.pendingBoardUndo;
    this.onBoardUndoPending = opts.onBoardUndoPending;
    this.onBoardUndoStarted = opts.onBoardUndoStarted;
    this.onBoardUndoResolved = opts.onBoardUndoResolved;
    this.boardUndoOwner = opts.boardUndoOwner;
    this.workNoteCommands = opts.workNoteCommands;
    this.projectCommands = opts.projectCommands;
    this.workspaceSession = opts.workspaceSession ?? new ProjectWorkspaceSession();
    this.workspaceSession.bindCollectionPreferences(settings, opts.onSaveSettings);
    this.onAnnounce = opts.onAnnounce ?? ((): void => {});
    this.onTaskContextMenu = opts.onTaskContextMenu;
    this.nextActionState = opts.nextActionState;
    this.publicationSequence = opts.publicationSequence;
    this.pathSuccessor = opts.pathSuccessor;
  }

  private async createProject(name: string): Promise<ProjectCreateResult> {
    return await this.projectManager.create(name);
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

  private async setPriority(
    path: string,
    priority: ProjectPriority | null,
  ): Promise<ProjectMetadataCommandResult> {
    const project = this.snapshots.find((snapshot) => snapshot.project.path === path)?.project;
    if (!project || !this.projectCommands) return { type: 'invalid', field: 'path' };
    const observed = { path, value: project.observed?.priority ?? project.frontmatter['priority'] };
    const result = await this.projectCommands.setPriority(observed, priority);
    if (result.type === 'ok') this.projectStore.refresh();
    return result;
  }

  private async writeProperty(write: ProjectPropertyWrite): Promise<ProjectPropertyWriteResult> {
    if (!this.projectCommands) return { type: 'io-error' };
    const result = await this.projectCommands.setProperty(write);
    if (result.type === 'ok') this.projectStore.refresh();
    return result;
  }

  private async setDescription(path: string, description: string | null) {
    const project = this.snapshots.find((snapshot) => snapshot.project.path === path)?.project;
    if (!project || !this.projectCommands) return { type: 'invalid', field: 'path' } as const;
    const result = await this.projectCommands.setDescription(
      { path, value: project.observed?.description ?? project.frontmatter['description'] },
      description,
    );
    if (result.type === 'ok') this.projectStore.refresh();
    return result;
  }

  private async appendComment(path: string, body: string) {
    const project = this.snapshots.find((snapshot) => snapshot.project.path === path)?.project;
    if (!project || !this.projectCommands) return { type: 'invalid', field: 'path' } as const;
    const result = await this.projectCommands.appendComment(
      this.projectCommands.observeComments(project),
      body,
    );
    if (result.type === 'ok') this.projectStore.refresh();
    return result;
  }

  private async setRangeEndpoint(
    path: string,
    endpoint: 'start' | 'end',
    raw: string | null,
  ): Promise<ProjectRangeCommandResult> {
    const project = this.snapshots.find((snapshot) => snapshot.project.path === path)?.project;
    if (!project || !this.projectCommands) return { type: 'invalid', issue: 'path' };
    const value = raw === null ? null : parseProjectDate(raw);
    if (raw !== null && !value) {
      return { type: 'invalid', issue: endpoint === 'start' ? 'invalid-start' : 'invalid-end' };
    }
    const result = await this.projectCommands.setRange(
      {
        path,
        start: project.observed?.start ?? project.frontmatter['start'],
        end: project.observed?.end ?? project.frontmatter['end'],
      },
      endpoint === 'start' ? { start: value } : { end: value },
    );
    if (result.type === 'ok') this.projectStore.refresh();
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
    viewState: WorkNotesViewState,
    layout: 'list' | 'board',
    milestoneRollups: ReadonlyMap<string, MilestoneRollup>,
    canonicalNotes: ProjectWorkspaceSnapshot['workNotes'] = notes,
  ): ProjectChildRenderHandle {
    if (!this.workNoteCommands) return { destroy: () => undefined };
    const capabilities = this.workNoteCommands.capabilities();
    const coarsePointer =
      Platform.isMobile ||
      host.ownerDocument.defaultView?.matchMedia?.('(pointer: coarse)').matches === true;
    const narrow = (): boolean =>
      Platform.isMobile || (host.clientWidth > 0 && host.clientWidth <= 672);
    const boardPreference = (): BoardViewPreference | undefined =>
      (
        this.workspaceSession.collectionPreference(
          projectPath,
          'work-notes',
        ) as WorkNotesCollectionPreference
      ).layoutPreferences['board']?.board;
    const persistBoardPreference = (next: BoardViewPreference): Promise<void> =>
      this.workspaceSession
        .updateCollectionPreference(projectPath, 'work-notes', (current) => ({
          ...current,
          layoutPreferences: {
            ...current.layoutPreferences,
            board: { board: next },
          },
        }))
        .then(() => undefined);
    let isNarrow = narrow();
    let child = renderWorkNotesView(host, {
      notes,
      canonicalNotes,
      ...(this.publicationSequence !== undefined && {
        publicationSequence: this.publicationSequence,
      }),
      ...(this.pathSuccessor && { pathSuccessor: this.pathSuccessor }),
      statuses: this.workNoteCommands.statuses(),
      layout,
      viewState,
      commandsEnabled: capabilities.update,
      createEnabled: capabilities.create,
      projectPath,
      onCreate: (request) => this.workNoteCommands!.create(request),
      onSetStatus: (note, statusId) => this.setWorkNoteStatus(note, statusId),
      openNote: (path) => this.openNote(path),
      session: this.workspaceSession.workNotes,
      announce: this.onAnnounce,
      overlayScope: this.app,
      boardPreference: boardPreference(),
      onBoardPreferenceChange: persistBoardPreference,
      isNarrow,
      coarsePointer,
      milestoneRollups,
      onSelect: (note, origin) => {
        const selection = deriveInspectorSelection({
          project: { type: 'project', path: note.projectPath },
          activeScope: 'work-notes',
          workNote: { type: 'work-note', path: note.path, projectPath: note.projectPath },
        });
        origin.dataset['inspectorOriginKey'] = inspectorSelectionKey(selection);
        this.state.batch(() => {
          this.state.set('taskStack', []);
          this.state.set('inspectorSelection', selection);
          this.state.set('inspectorOrigin', { selection, element: origin });
        });
      },
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
            canonicalNotes,
            ...(this.publicationSequence !== undefined && {
              publicationSequence: this.publicationSequence,
            }),
            ...(this.pathSuccessor && { pathSuccessor: this.pathSuccessor }),
            statuses: this.workNoteCommands!.statuses(),
            layout,
            viewState,
            commandsEnabled: capabilities.update,
            createEnabled: capabilities.create,
            projectPath,
            onCreate: (request) => this.workNoteCommands!.create(request),
            onSetStatus: (note, statusId) => this.setWorkNoteStatus(note, statusId),
            openNote: (path) => this.openNote(path),
            session: this.workspaceSession.workNotes,
            announce: this.onAnnounce,
            overlayScope: this.app,
            boardPreference: boardPreference(),
            onBoardPreferenceChange: persistBoardPreference,
            isNarrow,
            coarsePointer,
            milestoneRollups,
            onSelect: (note, origin) => {
              const selection = deriveInspectorSelection({
                project: { type: 'project', path: note.projectPath },
                activeScope: 'work-notes',
                workNote: { type: 'work-note', path: note.path, projectPath: note.projectPath },
              });
              origin.dataset['inspectorOriginKey'] = inspectorSelectionKey(selection);
              this.state.batch(() => {
                this.state.set('taskStack', []);
                this.state.set('inspectorSelection', selection);
                this.state.set('inspectorOrigin', { selection, element: origin });
              });
            },
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
    const commands = this.workNoteCommands;
    if (!commands) return { destroy: () => undefined };
    return renderContainerResponsiveTimeline(host, (isNarrow) =>
      renderWorkNotesTimeline(host, {
        notes,
        commands,
        commandsEnabled: commands.capabilities().update,
        session: this.workspaceSession.timelines.workNotes,
        isNarrow,
        scale: this.settings.projects.view.timeline.workNotes.dateRange,
        identityWidth: this.settings.projects.view.timeline.workNotes.identityWidth,
        onPresentationChange: (presentation) => {
          this.settings.projects.view.timeline = {
            ...this.settings.projects.view.timeline,
            workNotes: {
              dateRange: presentation.scale,
              identityWidth: presentation.identityWidth,
            },
          };
          void this.onSaveSettings();
        },
        openNote: (path) => this.openNote(path),
        onSelect: (note, origin) => {
          this.workspaceSession.scopeSession('work-notes').selection.inspectorKey = note.path;
          const selection = deriveInspectorSelection({
            project: { type: 'project', path: note.projectPath },
            activeScope: 'work-notes',
            workNote: { type: 'work-note', path: note.path, projectPath: note.projectPath },
          });
          origin.dataset['inspectorOriginKey'] = inspectorSelectionKey(selection);
          this.state.batch(() => {
            this.state.set('taskStack', []);
            this.state.set('inspectorSelection', selection);
            this.state.set('inspectorOrigin', { selection, element: origin });
          });
        },
      }),
    );
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
      } else if (active.hasAttribute('data-collection-filter')) {
        focusKey = 'filter';
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
      if (focusKey === 'filter') {
        return this.el.querySelector<HTMLElement>('[data-collection-filter]');
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

  // The panel's existing top-level view switch is intentionally exhaustive.
  // eslint-disable-next-line sonarjs/cognitive-complexity
  private render(): void {
    const portfolioFocus = this.portfolioFocusIntent ?? this.capturePortfolioContinuity();
    this.portfolioFocusIntent = null;
    this.viewCleanup?.();
    this.viewCleanup = null;
    this.el.empty();
    this.el.addClass('abyss-projects-panel');
    const view = this.state.get('projectsPanel');

    if (view.view === 'dashboard') {
      const container = this.el.createDiv();
      const snapshot = this.snapshots.find(({ project }) => project.path === view.path);
      const workNotePreset = this.settings.projects.workNoteCompatibility;
      const workNoteCapabilities = this.workNoteCommands?.capabilities();
      let workNotesAvailability:
        | { readonly state: 'available' | 'hidden' }
        | { readonly state: 'invalid'; readonly reason: string };
      if (workNoteCapabilities?.update === true || workNoteCapabilities?.create === true) {
        workNotesAvailability = { state: 'available' };
      } else if (!workNotePreset.enabled) {
        workNotesAvailability = { state: 'hidden' };
      } else if (isAuditAccepted(workNotePreset)) {
        workNotesAvailability = { state: 'available' };
      } else {
        workNotesAvailability = {
          state: 'invalid',
          reason: 'Work Notes setup needs validation',
        };
      }
      // The overlay registry is application-owned, so disappearance is proven
      // against the complete cross-Project publication, not the active filter.
      const canonicalWorkNotes = [
        ...new Map(
          this.snapshots
            .flatMap((candidate) => [...candidate.workNotes, ...candidate.milestones])
            .map((note) => [note.path, note] as const),
        ).values(),
      ];
      const dashboard = renderProjectDashboard(container, snapshot, {
        state: this.state,
        settings: this.settings,
        ...(this.persistCollectionPreferences ? { onSaveSettings: this.onSaveSettings } : {}),
        onSetStatus: (p, id) => void this.setStatus(p, id),
        ...(this.onTaskContextMenu && {
          onTaskContextMenu: (
            event: MouseEvent,
            projectPath: string,
            task: ProjectWorkspaceSnapshot['tasks'][number],
            anchor?: HTMLElement,
          ) => this.onTaskContextMenu!(event, projectPath, task, anchor),
        }),
        ...(this.nextActionState && { nextActionState: this.nextActionState }),
        openNote: (p) => this.openNote(p),
        workspaceSession: this.workspaceSession,
        renderTasks: this.renderTasks,
        ...(this.renderTaskBoard ? { renderTaskBoard: this.renderTaskBoard } : {}),
        ...(this.renderTaskTimeline ? { renderTaskTimeline: this.renderTaskTimeline } : {}),
        workNotesAvailability,
        onOpenWorkNotesSettings: () => {
          const settingsController = (
            this.app as App & {
              readonly setting?: { open?(): void; openTabById?(id: string): void };
            }
          ).setting;
          settingsController?.open?.();
          settingsController?.openTabById?.('task-calendar');
        },
        ...(this.workNoteCommands && snapshot
          ? {
              workNotesAvailable:
                snapshot.workNotes.length + snapshot.milestones.length > 0 ||
                this.workNoteCommands.capabilities().create,
              workNoteStatuses: this.workNoteCommands.statuses(),
              selectWorkNotes: (notes, viewState, textQuery) =>
                selectWorkNotes({
                  notes,
                  statuses: this.workNoteCommands!.statuses(),
                  viewState,
                  textQuery,
                }),
              renderWorkNotes: (host, path, notes, viewState) =>
                this.renderWorkNotes(
                  host,
                  path,
                  notes,
                  viewState,
                  'list',
                  snapshot.milestoneRollups,
                  canonicalWorkNotes,
                ),
              renderWorkNoteBoard: (host, path, notes) =>
                this.renderWorkNotes(
                  host,
                  path,
                  notes,
                  this.workspaceSession.collectionView(path, 'work-notes'),
                  'board',
                  snapshot.milestoneRollups,
                  canonicalWorkNotes,
                ),
              renderWorkNoteTimeline: (host, _path, notes) =>
                this.renderWorkNoteTimeline(host, notes),
            }
          : {}),
      });
      this.dashboardSessionPath = view.path;
      // A data refresh replaces the DOM but is not a collection close: retain the
      // coordinator session for focus/query/scroll restoration into the next mount.
      this.viewCleanup = () =>
        (
          dashboard as ProjectChildRenderHandle & { destroy(releaseSession?: boolean): void }
        ).destroy(false);
      return;
    }

    if (this.dashboardSessionPath) {
      this.workspaceSession.releaseCollectionSessions(this.dashboardSessionPath);
      this.dashboardSessionPath = null;
    }
    this.workspaceSession.closeProject();
    const container = this.el.createDiv();
    const listContext = {
      state: this.state,
      settings: this.settings,
      onSaveSettings: this.onSaveSettings,
      collectionState: this.workspaceSession,
      portfolioFields: projectTableFields(this.snapshots),
      onFiltersChanged: () => {
        this.portfolioFocusIntent = null;
        this.render();
      },
      onPortfolioLayoutChanged: () => this.render(),
      onCaptureSettled: () => this.render(),
      onCreate: (name: string) => this.createProject(name),
      captureSession: this.workspaceSession.portfolioCapture,
      onSetStatus: (p: string, id: string) => void this.setStatus(p, id),
      onSetPriority: (p: string, priority: ProjectPriority | null) =>
        void this.setPriority(p, priority),
      openNote: (p: string) => this.openNote(p),
    };
    const portfolioPreference = this.workspaceSession.portfolioPreference();
    const visibleStatusIds = new Set(portfolioPreference.filters);
    const createdPath = this.workspaceSession.portfolioCapture.createdPath;
    const timelineSnapshots = this.snapshots.filter(
      ({ project }) =>
        project.path === createdPath ||
        (project.statusId === null
          ? visibleStatusIds.has('__unmapped__')
          : visibleStatusIds.has(project.statusId)),
    );
    const timelineAvailable = this.projectCommands !== undefined;
    const projectCommands = this.projectCommands;
    const portfolioContext = { ...listContext, timelineAvailable };
    if (portfolioPreference.layout === 'timeline' && projectCommands) {
      const toolbar = renderProjectsToolbar(container, portfolioContext);
      const { newProjectButton } = toolbar;
      let captureCleanup: (() => void) | undefined;
      const openCapture = (): void => {
        this.workspaceSession.portfolioCapture.open = true;
        if (focusExistingProjectCapture(toolbar.captureHost)) return;
        captureCleanup?.();
        captureCleanup = showNewProjectInput(toolbar.captureHost, listContext.onCreate, {
          session: this.workspaceSession.portfolioCapture,
          trigger: newProjectButton,
          liveRegion: toolbar.liveRegion,
          openNote: listContext.openNote,
          onSettled: listContext.onCaptureSettled,
        });
      };
      newProjectButton.addEventListener('click', openCapture);
      if (this.workspaceSession.portfolioCapture.open) openCapture();
      const timelineHost = container.createDiv({ cls: 'abyss-projects-timeline-host' });
      if (createdPath) {
        this.workspaceSession.portfolioTimeline.focusedKey = `project:${createdPath}`;
        this.workspaceSession.portfolioTimeline.restoreFocus = true;
      }
      const handle = renderContainerResponsiveTimeline(timelineHost, (isNarrow) =>
        renderProjectsTimeline(timelineHost, {
          projects: timelineSnapshots.map(({ project }) => project),
          snapshots: timelineSnapshots,
          commands: projectCommands,
          ...(this.workNoteCommands?.capabilities().update === true
            ? { milestoneCommands: this.workNoteCommands }
            : {}),
          session: this.workspaceSession.portfolioTimeline,
          isNarrow,
          scale: this.settings.projects.view.timeline.portfolio.scale,
          identityWidth: this.settings.projects.view.timeline.portfolio.identityWidth,
          onPresentationChange: (presentation) => {
            this.settings.projects.view.timeline = {
              ...this.settings.projects.view.timeline,
              portfolio: {
                scale: presentation.scale,
                identityWidth: presentation.identityWidth,
              },
            };
            void this.onSaveSettings();
          },
          openProject: (path) => this.state.set('projectsPanel', { view: 'dashboard', path }),
          onSelectMilestone: (note, origin) => {
            this.workspaceSession.scopeSession('work-notes').selection.inspectorKey = note.path;
            const selection = deriveInspectorSelection({
              project: { type: 'project', path: note.projectPath },
              activeScope: 'work-notes',
              workNote: { type: 'work-note', path: note.path, projectPath: note.projectPath },
            });
            origin.dataset['inspectorOriginKey'] = inspectorSelectionKey(selection);
            this.state.batch(() => {
              this.state.set('taskStack', []);
              this.state.set('inspectorSelection', selection);
              this.state.set('inspectorOrigin', { selection, element: origin });
            });
          },
          onMutation: (_project, result) => {
            if (result.type === 'ok') this.projectStore.refresh();
          },
          onMilestoneMutation: (_note, result) => {
            if (result.type === 'ok') this.projectStore.refresh();
          },
        }),
      );
      if (createdPath) {
        const identity = Array.from(
          timelineHost.querySelectorAll<HTMLElement>('[data-timeline-key]'),
        ).find(({ dataset }) => dataset['timelineKey'] === `project:${createdPath}`);
        const row = identity?.closest<HTMLElement>(
          '.abyss-timeline-row, .abyss-timeline-undated-row',
        );
        row?.addClass('is-just-created');
        identity
          ?.querySelector<HTMLElement>('[data-project-identity-control]')
          ?.focus({ preventScroll: true });
        row?.scrollIntoView?.({ block: 'nearest' });
        if (identity) this.workspaceSession.portfolioCapture.createdPath = null;
      }
      this.viewCleanup = () => {
        captureCleanup?.();
        toolbar.destroy();
        handle.destroy();
      };
      this.restorePortfolioContinuity(portfolioFocus);
      return;
    }
    if (portfolioPreference.layout === 'board') {
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
        onAnnounce: this.onAnnounce,
        overlayScope: this.app,
        ...(this.publicationSequence !== undefined && {
          publicationSequence: this.publicationSequence,
        }),
        ...(this.pathSuccessor && { pathSuccessor: this.pathSuccessor }),
      });
      this.viewCleanup = () => board.destroy();
    } else {
      this.viewCleanup = renderProjectsList(container, this.snapshots, {
        ...portfolioContext,
        renderOverview: (host, snapshots) => {
          const table = renderProjectsTable(host, snapshots, {
            settings: this.settings,
            preference:
              this.workspaceSession.portfolioPreference().layoutPreferences['overview']?.table,
            groupBy: this.workspaceSession.portfolioPreference().group,
            sortBy: this.workspaceSession.portfolioPreference().sort,
            onPreferenceChange: (next) => {
              void this.workspaceSession
                .updatePortfolioPreference((current) => ({
                  ...current,
                  visibleFields: tableVisibleFields(next),
                  layoutPreferences: {
                    ...current.layoutPreferences,
                    overview: { ...current.layoutPreferences['overview'], table: next },
                  },
                }))
                .then(() => this.render())
                .catch(
                  () =>
                    new Notice(
                      'Project table preference was not saved. Nothing changed; try again.',
                    ),
                );
            },
            onOpen: (path) => this.state.set('projectsPanel', { view: 'dashboard', path }),
            onOpenNote: (path) => this.openNote(path),
            onWriteProperty: (write) => this.writeProperty(write),
            onSetStatus: (path, statusId) => this.setStatus(path, statusId),
            onSetPriority: (path, priority) => this.setPriority(path, priority ?? null),
            onSetRange: (path, endpoint, raw) => this.setRangeEndpoint(path, endpoint, raw),
            onSetDescription: (path, description) => this.setDescription(path, description),
            onAppendComment: (path, body) => this.appendComment(path, body),
          });
          return { destroy: () => table.destroy() };
        },
      });
    }
    this.restorePortfolioContinuity(portfolioFocus);
  }

  destroy(options: { readonly preserveWorkspaceSession?: boolean } = {}): void {
    this.viewCleanup?.();
    this.viewCleanup = null;
    if (!options.preserveWorkspaceSession && this.dashboardSessionPath) {
      this.workspaceSession.releaseCollectionSessions(this.dashboardSessionPath);
      this.dashboardSessionPath = null;
    }
    this.offs.forEach((f) => f());
    this.offs = [];
    this.el?.empty();
  }
}
