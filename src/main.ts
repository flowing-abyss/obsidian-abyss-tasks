import { Plugin, TFile } from 'obsidian';
import { buildCommitIdentity } from './buildIdentity';
import { registerCodeBlock, resolveConfig } from './code-block/registerCodeBlock';
import { disposeProjectWorkspacePreferenceAuthority } from './panels/projects/ProjectWorkspaceSession';
import { DependencyIndex } from './projects/dependencies/DependencyIndex';
import { DependencyPolicy } from './projects/dependencies/DependencyPolicy';
import { ProjectCommandService } from './projects/ProjectCommandService';
import { ProjectStore } from './projects/ProjectStore';
import { ProjectWorkspaceCoordinator } from './projects/ProjectWorkspaceCoordinator';
import { PROHIBITED_WORK_NOTE_MUTATION_COMMAND_IDS } from './projects/work-notes/commands';
import {
  MilestoneCommandAdapter,
  type MilestoneTaskMembership,
} from './projects/work-notes/MilestoneCommandAdapter';
import type {
  WorkNoteCompatibilityAcceptanceResult,
  WorkNoteCompatibilityDisableResult,
  WorkNoteCompatibilityPreset,
  WorkNoteCompatibilityPreview,
  WorkNoteCompatibilityToken,
  WorkNoteCompatibilityValidationResult,
  WorkNoteValidatedApplyResult,
} from './projects/work-notes/types';
import { WorkNoteCommandService } from './projects/work-notes/WorkNoteCommandService';
import { WorkNoteDeletionCoordinator } from './projects/work-notes/WorkNoteDeletionCoordinator';
import { WorkNoteIndex } from './projects/work-notes/WorkNoteIndex';
import { WorkNoteRelationCommandService } from './projects/work-notes/WorkNoteRelationCommandService';
import { DailyNoteResolver } from './resolvers/DailyNoteResolver';
import { DEFAULT_SETTINGS } from './settings/defaults';
import { migrateSettings } from './settings/migration';
import { beginSettingsSave } from './settings/settingsSaveRevision';
import { CalendarSettingsTab } from './settings/SettingsTab';
import { toStatusRules } from './settings/statusCatalogAdapter';
import type { CalendarSettings, CodeBlockParams } from './settings/types';
import { StatusRegistry } from './status/StatusRegistry';
import { TagManager } from './tags/TagManager';
import {
  localDate,
  type TaskApplicationApi,
  type TaskCaptureApplicationApi,
  type TaskQueryApi,
} from './tasks';
import { TaskApplicationService } from './tasks/application/TaskApplicationService';
import { systemClock } from './tasks/domain/clock';
import type { CommentTimeContextProvider } from './tasks/domain/commentTimeLabel';
import { StatusCatalog } from './tasks/domain/StatusCatalog';
import { systemCommentTimeContext } from './tasks/infrastructure/commentTimeContext';
import { TaskBlockEditor } from './tasks/infrastructure/markdown/TaskBlockEditor';
import { TaskLocator } from './tasks/infrastructure/markdown/TaskLocator';
import { TaskMarkdownCodec } from './tasks/infrastructure/markdown/TaskMarkdownCodec';
import { ObsidianTaskDestinationProvider } from './tasks/infrastructure/obsidian/ObsidianTaskDestinationProvider';
import { ObsidianTaskRepository } from './tasks/infrastructure/obsidian/ObsidianTaskRepository';
import { TaskIndex } from './tasks/infrastructure/TaskIndex';
import { TaskRefAuthority } from './tasks/infrastructure/TaskRefAuthority';
import { CalendarRenderer } from './ui/CalendarRenderer';
import { disposeOptimisticOverlayStores } from './ui/interaction/OptimisticOverlayStore';
import { PANEL_VIEW_TYPE, PanelView } from './views/PanelView';

export default class TaskCalendarPlugin extends Plugin {
  settings!: CalendarSettings;
  tagManager!: TagManager;
  queries!: TaskQueryApi;
  tasks!: TaskApplicationApi & TaskCaptureApplicationApi;
  private taskIndex!: TaskIndex;
  private dependencyIndex!: DependencyIndex;
  private dependencyPolicy!: DependencyPolicy;
  private statusCatalog!: StatusCatalog;
  private statusRegistry!: StatusRegistry;
  private projectCommands!: ProjectCommandService;
  private projectStore!: ProjectStore;
  private projectWorkspace!: ProjectWorkspaceCoordinator;
  private workNoteIndex!: WorkNoteIndex;
  private workNoteCommands!: WorkNoteCommandService;
  private workNoteRelations!: WorkNoteRelationCommandService;
  private milestoneCommands!: MilestoneCommandAdapter;
  private workNoteDeletion!: WorkNoteDeletionCoordinator;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.statusCatalog = new StatusCatalog(toStatusRules(this.settings.taskStatuses));
    this.statusRegistry = new StatusRegistry(this.settings.taskStatuses);
    const refAuthority = new TaskRefAuthority();
    this.taskIndex = new TaskIndex(this.app, {
      statusCatalog: this.statusCatalog,
      dailyNoteFormat: this.settings.desktop.dailyNoteFormat,
      ...(this.settings.desktop.globalTaskFilter && {
        globalTaskFilter: this.settings.desktop.globalTaskFilter,
      }),
      refAuthority,
    });
    this.dependencyIndex = new DependencyIndex(this.taskIndex);
    this.dependencyPolicy = new DependencyPolicy(this.dependencyIndex);
    const codec = new TaskMarkdownCodec(this.statusCatalog);
    const repository = new ObsidianTaskRepository(this.app, {
      codec,
      editor: new TaskBlockEditor(),
      locator: new TaskLocator(refAuthority),
      snapshotsFromContent: (path, content) => this.taskIndex.snapshotsFromContent(path, content),
      refAuthority,
      snapshotState: this.taskIndex,
    });
    const destinationProvider = new ObsidianTaskDestinationProvider(
      this.app,
      this.settings,
      new DailyNoteResolver(this.app, this.settings),
    );
    const clock = systemClock(
      () => Date.now(),
      (epochMs) => -new Date(epochMs).getTimezoneOffset(),
      (epochMs) => localDate(window.moment(epochMs).format('YYYY-MM-DD')),
    );
    this.tasks = new TaskApplicationService(
      this.taskIndex,
      repository,
      this.statusCatalog,
      clock,
      destinationProvider,
      () => ({
        taskLifecycle: this.settings.taskLifecycle,
        recurrence: this.settings.recurrence,
      }),
      this.dependencyIndex,
      this.dependencyPolicy,
    );
    this.queries = this.tasks.queries;
    this.tagManager = new TagManager(this.app, this.settings, () => this.saveSettings());
    this.projectCommands = new ProjectCommandService(
      this.app,
      () => this.settings.projects.statuses,
      clock,
    );
    this.workNoteIndex = new WorkNoteIndex(
      this.app,
      () => this.settings.projects.workNoteCompatibility,
      this.queries,
      () => this.settings.projects.statuses,
      {
        persist: (preset) => this.persistWorkNoteCompatibility(preset),
      },
    );
    this.workNoteCommands = new WorkNoteCommandService(
      this.app,
      () => this.settings.projects.workNoteCompatibility,
      this.workNoteIndex,
      () => this.settings.projects.statuses,
    );
    this.projectStore = new ProjectStore(this.app, this.queries, this.settings);
    this.projectWorkspace = new ProjectWorkspaceCoordinator(
      this.projectStore,
      this.queries,
      this.workNoteIndex,
      () => this.settings.projects.statuses,
      {
        today: () => window.moment().format('YYYY-MM-DD'),
        dependencies: this.dependencyPolicy,
      },
    );
    const milestoneAuthority = {
      refresh: async () => {
        const event = await this.queries.rescan?.();
        if (!event) throw new Error('Task publication refresh is unavailable');
        await this.projectWorkspace.refreshForVerification(event);
      },
      taskMemberships: (candidate: Parameters<MilestoneCommandAdapter['assignTask']>[0]['task']) =>
        this.milestoneTaskMemberships(candidate),
      workNoteMemberships: (path: string) =>
        this.projectWorkspace
          .list()
          .flatMap((snapshot) => [...snapshot.workNotes, ...snapshot.milestones])
          .filter((note) => note.path === path),
    };
    this.workNoteRelations = new WorkNoteRelationCommandService(
      this.app,
      () => this.settings.projects.workNoteCompatibility,
      this.workNoteIndex,
      { refresh: milestoneAuthority.refresh },
    );
    this.milestoneCommands = new MilestoneCommandAdapter({
      tasks: this.tasks,
      workNotes: this.workNoteCommands,
      relations: this.workNoteRelations,
      authority: milestoneAuthority,
      open: (path) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) void this.app.workspace.getLeaf(false).openFile(file);
      },
      rename: (note, title) => this.workNoteCommands.setTitle(note, title),
    });
    this.workNoteDeletion = new WorkNoteDeletionCoordinator(
      this.app,
      this.tasks,
      this.workNoteIndex,
    );
    const commentTimeContext: CommentTimeContextProvider = systemCommentTimeContext;

    this.registerView(
      PANEL_VIEW_TYPE,
      (leaf) =>
        new PanelView(
          leaf,
          this.settings,
          this.tagManager,
          this.queries,
          this.tasks,
          this.statusRegistry,
          () => this.saveSettings(),
          commentTimeContext,
          this.projectCommands,
          this.workNoteIndex,
          this.projectStore,
          this.projectWorkspace,
          this.workNoteCommands,
          this.dependencyPolicy,
          clock,
          this,
          this.workNoteRelations,
          this.milestoneCommands,
          this.workNoteDeletion,
        ),
    );

    registerCodeBlock(this, this.settings, this.queries, this.tasks, this.statusRegistry);

    this.addCommand({
      id: 'open-panel',
      name: 'Open view',
      callback: () => {
        void this.openPanel();
      },
    });

    this.addSettingTab(new CalendarSettingsTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      this.projectWorkspace.start();
      this.workNoteIndex.initialize();
      this.projectStore.initialize();
      void this.taskIndex.initialize();
    });

    // Legacy Dataview shim — remove after users migrate to native `task-calendar` code blocks
    (window as unknown as Record<string, unknown>).renderCalendar = (
      dv: unknown,
      params: CodeBlockParams,
    ) => {
      const container = (dv as { container?: HTMLElement } | null)?.container ?? null;
      if (!container) {
        console.warn('[task-calendar] renderCalendar: no Dataview container found');
        return;
      }
      const renderer = new CalendarRenderer(
        container,
        resolveConfig(this.settings, params),
        this.app,
        this.queries,
        this.tasks,
        this.statusRegistry,
        this.settings.taskPrefix,
        this.settings.recurrence,
        commentTimeContext,
        undefined,
        this.dependencyPolicy,
      );
      renderer.mount();
    };
  }

  onunload(): void {
    disposeProjectWorkspacePreferenceAuthority(this);
    disposeOptimisticOverlayStores(this.app);
    this.projectWorkspace.destroy();
    this.projectStore.destroy();
    this.taskIndex.destroy();
    this.dependencyIndex.destroy();
    this.workNoteIndex.destroy();
    delete (window as unknown as Record<string, unknown>).renderCalendar;
  }

  async loadSettings(): Promise<void> {
    const raw = (await this.loadData()) as Record<string, unknown> | null | undefined;
    const data: Record<string, unknown> = raw ?? {};
    migrateSettings(data);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data) as CalendarSettings;
  }

  async saveSettings(): Promise<void> {
    beginSettingsSave(this.settings);
    await this.saveData(this.settings);
    if (Object.prototype.hasOwnProperty.call(this, 'workNoteIndex')) this.workNoteIndex.refresh();
  }

  async previewWorkNoteCompatibility(): Promise<WorkNoteCompatibilityPreview> {
    const preview = await this.workNoteIndex.previewCompatibility();
    const readOnlyPreview = { ...preview };
    delete readOnlyPreview.acceptanceToken;
    return readOnlyPreview;
  }

  async validateWorkNoteCompatibility(
    candidate: WorkNoteCompatibilityPreset,
  ): Promise<WorkNoteCompatibilityValidationResult> {
    return this.workNoteIndex.validateCompatibility(candidate);
  }

  async applyValidatedWorkNoteCompatibility(
    token: WorkNoteCompatibilityToken,
  ): Promise<WorkNoteValidatedApplyResult> {
    return this.workNoteIndex.acceptValidatedCompatibility(token);
  }

  private milestoneTaskMemberships(
    candidate: Parameters<MilestoneCommandAdapter['assignTask']>[0]['task'],
  ): readonly MilestoneTaskMembership[] {
    const memberships: MilestoneTaskMembership[] = [];
    for (const snapshot of this.projectWorkspace.list()) {
      for (const action of snapshot.tasks) {
        if (
          action.task.ref.filePath !== candidate.ref.filePath ||
          action.task.ref.line !== candidate.ref.line ||
          action.task.ref.revision !== candidate.ref.revision
        ) {
          continue;
        }
        const ownerNote =
          action.owner.type === 'work-note'
            ? [...snapshot.workNotes, ...snapshot.milestones].find(
                ({ path }) => path === action.owner.path,
              )
            : undefined;
        memberships.push({
          projectPath: snapshot.project.path,
          owner: action.owner,
          task: action.task,
          ...(ownerNote && { ownerNote }),
        });
      }
    }
    return memberships;
  }

  acceptWorkNoteCompatibility(
    _legacyToken: string,
  ): Promise<WorkNoteCompatibilityAcceptanceResult> {
    return Promise.resolve({
      type: 'compatibility-conflict',
      reason: 'exact-validation-required',
    });
  }

  async disableWorkNoteCompatibility(): Promise<WorkNoteCompatibilityDisableResult> {
    return this.workNoteIndex.disableCompatibility();
  }

  private async persistWorkNoteCompatibility(preset: WorkNoteCompatibilityPreset): Promise<void> {
    const persistedPreset = structuredClone(preset);
    const statusIds = Object.keys(persistedPreset.rawStatusByStatusId);
    const nextSettings = structuredClone(this.settings);
    nextSettings.projects.workNoteCompatibility = persistedPreset;
    nextSettings.projects.view.workNotes = {
      ...nextSettings.projects.view.workNotes,
      statusIds,
    };
    await this.saveData(nextSettings);
    beginSettingsSave(this.settings);
    this.settings.projects.workNoteCompatibility = structuredClone(persistedPreset);
    this.settings.projects.view.workNotes = {
      ...this.settings.projects.view.workNotes,
      statusIds,
    };
  }

  readOnlyCompatibilityDiagnostic(): {
    readonly buildCommit: string;
    readonly prohibitedWorkNoteMutationCommandIds: readonly string[];
  } {
    return {
      buildCommit: buildCommitIdentity(),
      prohibitedWorkNoteMutationCommandIds: PROHIBITED_WORK_NOTE_MUTATION_COMMAND_IDS,
    };
  }

  rebuildTaskStatusSemantics(): void {
    this.statusCatalog.replace(toStatusRules(this.settings.taskStatuses));
    this.statusRegistry.replace(this.settings.taskStatuses);
    this.taskIndex.setStatusCatalog(this.statusCatalog);
  }

  private async openPanel(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(PANEL_VIEW_TYPE);
    if (existing.length > 0 && existing[0]) {
      void this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: PANEL_VIEW_TYPE, active: true });
    void this.app.workspace.revealLeaf(leaf);
  }
}
