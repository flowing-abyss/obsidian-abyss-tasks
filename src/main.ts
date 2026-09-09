import { normalizePath, Notice, Plugin } from 'obsidian';
import { registerCodeBlock, resolveConfig } from './code-block/registerCodeBlock';
import { ProjectManager } from './projects/ProjectManager';
import { DailyNoteResolver } from './resolvers/DailyNoteResolver';
import { DEFAULT_SETTINGS } from './settings/defaults';
import {
  SettingsPersistenceCoordinator,
  type SettingsPersistencePort,
} from './settings/persistence';
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
  type TaskDependencyQueryApi,
  type TaskQueryApi,
} from './tasks';
import { TaskApplicationService } from './tasks/application/TaskApplicationService';
import {
  TaskDependencyService,
  type TaskDiagnosticSink,
} from './tasks/application/TaskDependencyService';
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
import { PANEL_VIEW_TYPE, PanelView } from './views/PanelView';

export default class TaskCalendarPlugin extends Plugin {
  override settings!: CalendarSettings;
  tagManager!: TagManager;
  queries!: TaskQueryApi & TaskDependencyQueryApi;
  tasks!: TaskApplicationApi & TaskCaptureApplicationApi;
  private taskIndex!: TaskIndex;
  private statusCatalog!: StatusCatalog;
  private statusRegistry!: StatusRegistry;
  private projectManager!: ProjectManager;
  private settingsPersistence!: SettingsPersistenceCoordinator;

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.initializeTaskServices();
    const commentTimeContext: CommentTimeContextProvider = systemCommentTimeContext;
    this.registerPanel(commentTimeContext);
    registerCodeBlock(
      this,
      this.settings,
      this.queries,
      this.tasks,
      this.statusRegistry,
      commentTimeContext,
    );
    this.registerCommands();
    this.addSettingTab(new CalendarSettingsTab(this.app, this));
    this.initializeIndexWhenReady();
    this.installLegacyCalendarShim(commentTimeContext);
  }

  private initializeTaskServices(): void {
    this.statusCatalog = new StatusCatalog(toStatusRules(this.settings.taskStatuses));
    this.statusRegistry = new StatusRegistry(this.settings.taskStatuses);
    const refAuthority = new TaskRefAuthority();
    this.taskIndex = new TaskIndex(this.app, {
      statusCatalog: this.statusCatalog,
      dailyNoteFormat: this.settings.desktop.dailyNoteFormat,
      ...(this.settings.desktop.globalTaskFilter.length > 0
        ? { globalTaskFilter: this.settings.desktop.globalTaskFilter }
        : {}),
      refAuthority,
    });
    const codec = new TaskMarkdownCodec(this.statusCatalog);
    const repository = new ObsidianTaskRepository(this.app, {
      codec,
      editor: new TaskBlockEditor(),
      locator: new TaskLocator(refAuthority),
      snapshotsFromContent: (path, content) => this.taskIndex.snapshotsFromContent(path, content),
      refAuthority,
      snapshotState: this.taskIndex,
    });
    const dailyNotes = new DailyNoteResolver(this.app, this.settings);
    const destinationProvider = new ObsidianTaskDestinationProvider(
      this.app,
      () => ({
        addToToday: this.settings.addToToday,
        customFilePath: this.settings.customFilePath,
        insertion:
          this.settings.taskInsertionMode === 'section' &&
          this.settings.taskInsertionSection.trim().length > 0
            ? { type: 'section', heading: this.settings.taskInsertionSection }
            : { type: 'append' },
      }),
      () => dailyNotes.planDailyNoteDestination(),
    );
    const diagnostics: TaskDiagnosticSink = (diagnostic, error) => {
      console.error('[abyss-tasks] task dependency operation failed', diagnostic, error);
    };
    this.tasks = new TaskApplicationService(
      this.taskIndex,
      repository,
      this.statusCatalog,
      systemClock(
        () => Date.now(),
        (epochMs) => -new Date(epochMs).getTimezoneOffset(),
        (epochMs) => localDate(window.moment(epochMs).format('YYYY-MM-DD')),
      ),
      destinationProvider,
      () => ({
        taskLifecycle: this.settings.taskLifecycle,
        recurrence: this.settings.recurrence,
      }),
      new TaskDependencyService(
        this.taskIndex,
        repository,
        () =>
          Array.from(crypto.getRandomValues(new Uint8Array(8)), (value) =>
            (value % 36).toString(36),
          ).join(''),
        diagnostics,
      ),
      diagnostics,
    );
    this.queries = this.tasks.queries;
    this.projectManager = new ProjectManager(this.app, this.settings, dailyNotes, this.tasks);
    this.tagManager = new TagManager(this.app, this.settings, () => this.saveSettings());
  }

  private registerPanel(commentTimeContext: CommentTimeContextProvider): void {
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
          () => this.saveViewState(),
        ),
    );
  }

  private registerCommands(): void {
    this.addCommand({
      id: 'open-panel',
      name: 'Open view',
      callback: async () => {
        await this.openPanel();
      },
    });
  }

  private initializeIndexWhenReady(): void {
    this.app.workspace.onLayoutReady(() => {
      this.taskIndex.initialize().catch((error: unknown) => {
        console.error('[abyss-tasks] task index initialization failed', error);
      });
    });
  }

  private installLegacyCalendarShim(commentTimeContext: CommentTimeContextProvider): void {
    // Legacy Dataview shim — remove after users migrate to native `task-calendar` code blocks
    (window as unknown as Record<string, unknown>)['renderCalendar'] = (
      dv: unknown,
      params: CodeBlockParams,
    ) => {
      const container = (dv as { container?: HTMLElement } | null)?.container ?? null;
      if (container == null) {
        console.warn('[abyss-tasks] renderCalendar: no Dataview container found');
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
      );
      renderer.mount();
    };
  }

  override onunload(): void {
    this.taskIndex.destroy();
    delete (window as unknown as Record<string, unknown>)['renderCalendar'];
  }

  async loadSettings(): Promise<void> {
    this.settingsPersistence = new SettingsPersistenceCoordinator(this.persistencePort());
    try {
      const loaded = await this.settingsPersistence.loadSettings(DEFAULT_SETTINGS);
      this.settings = loaded.settings;
      for (const message of loaded.notices) new Notice(message);
      if (loaded.issues.length > 0) {
        for (const issue of loaded.issues) {
          console.error('[abyss-tasks] saved view state is unavailable', issue);
        }
        new Notice(
          'Saved view state could not be loaded. View preferences are using temporary defaults; view preference writes are suspended to preserve the existing file.',
        );
      }
    } catch (error) {
      console.error('[abyss-tasks] settings load failed', error);
      new Notice(
        'Abyss tasks settings could not be loaded. Existing settings were left unchanged.',
      );
      throw error;
    }
  }

  async saveSettings(): Promise<void> {
    beginSettingsSave(this.settings);
    await this.settingsPersistence.saveSettings(this.settings);
    for (const leaf of this.app.workspace.getLeavesOfType(PANEL_VIEW_TYPE)) {
      if (leaf.view instanceof PanelView) leaf.view.refreshProjectSettings();
    }
  }

  async saveViewState(): Promise<void> {
    try {
      await this.settingsPersistence.saveViewState(this.settings);
    } catch (error) {
      console.error('[abyss-tasks] saved view state write failed', error);
      new Notice('Could not save view preferences. Your current session is unchanged.');
      throw error;
    }
  }

  refreshProjectTableSettings(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(PANEL_VIEW_TYPE)) {
      if (leaf.view instanceof PanelView) leaf.view.refreshProjectTableSettings();
    }
  }

  async renameProjectStatus(id: string, name: string, expectedName: string): Promise<void> {
    await this.projectManager.renameStatusDefinition(id, name, expectedName, () =>
      this.saveSettings(),
    );
  }

  rebuildTaskStatusSemantics(): void {
    this.statusCatalog.replace(toStatusRules(this.settings.taskStatuses));
    this.statusRegistry.replace(this.settings.taskStatuses);
    this.taskIndex.setStatusCatalog(this.statusCatalog);
  }

  private async openPanel(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(PANEL_VIEW_TYPE);
    if (existing.length > 0 && existing[0] != null) {
      await this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: PANEL_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  private persistencePort(): SettingsPersistencePort {
    const adapter = this.app.vault.adapter;
    const pluginDirectory =
      this.manifest.dir ?? normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}`);
    const statePath = normalizePath(`${pluginDirectory}/state.json`);
    return {
      loadStatic: () => this.loadData(),
      saveStatic: (data) => this.saveData(data),
      state: {
        path: statePath,
        exists: (path) => adapter.exists(path),
        read: (path) => adapter.read(path),
        write: (path, data) => adapter.write(path, data),
      },
    };
  }
}
