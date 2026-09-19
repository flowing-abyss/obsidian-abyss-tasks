import { getAllTags, normalizePath, Notice, Plugin, type TAbstractFile } from 'obsidian';
import { registerCodeBlock, resolveConfig } from './code-block/registerCodeBlock';
import { NoteTemplateService } from './notes/NoteTemplateService';
import { initializeProjectPropertyDefinitions } from './projects/initializeProjectPropertyDefinitions';
import {
  ObsidianProjectProperties,
  type ProjectPropertyCatalog,
} from './projects/ObsidianProjectProperties';
import { ProjectManager } from './projects/ProjectManager';
import { evaluateQuery } from './query/evaluateQuery';
import { DEFAULT_SETTINGS } from './settings/defaults';
import {
  SettingsPersistenceCoordinator,
  type SettingsPersistencePort,
} from './settings/persistence';
import { reportSettingsDraftSaveFailure } from './settings/settingsSaveFailure';
import { beginSettingsSave, latestSettingsSaveRevision } from './settings/settingsSaveRevision';
import { CalendarSettingsTab } from './settings/SettingsTab';
import { toStatusRules } from './settings/statusCatalogAdapter';
import {
  taskSourceIgnoreQuery,
  validateTaskStorageDraft,
  type TaskStorageSettings,
} from './settings/taskStorageSettings';
import type { CalendarSettings, CodeBlockParams } from './settings/types';
import { StatusRegistry } from './status/StatusRegistry';
import { TagManager } from './tags/TagManager';
import {
  localDate,
  type TaskApplicationApi,
  type TaskCaptureApplicationApi,
  type TaskDependencyQueryApi,
  type TaskInsertionPolicy,
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
import { TaskIndex, type TaskSourceMetadata } from './tasks/infrastructure/TaskIndex';
import { TaskRefAuthority } from './tasks/infrastructure/TaskRefAuthority';
import { CalendarRenderer } from './ui/CalendarRenderer';
import { PANEL_VIEW_TYPE, PanelView } from './views/PanelView';

function configuredTaskInsertion(settings: CalendarSettings): TaskInsertionPolicy {
  if (settings.taskInsertionMode === 'section' && settings.taskInsertionSection.trim().length > 0) {
    return {
      type: 'section',
      heading: settings.taskInsertionSection,
      position: settings.taskInsertionSectionPosition,
    };
  }
  return settings.taskInsertionMode === 'prepend' ? { type: 'prepend' } : { type: 'append' };
}

export default class TaskCalendarPlugin extends Plugin {
  override settings!: CalendarSettings;
  tagManager!: TagManager;
  queries!: TaskQueryApi & TaskDependencyQueryApi;
  tasks!: TaskApplicationApi & TaskCaptureApplicationApi;
  private taskIndex!: TaskIndex;
  private statusCatalog!: StatusCatalog;
  private statusRegistry!: StatusRegistry;
  private projectManager!: ProjectManager;
  private projectProperties!: ProjectPropertyCatalog;
  private settingsPersistence!: SettingsPersistenceCoordinator;
  private effectiveTaskStorage!: TaskStorageSettings;
  private projectPropertyCaptureQueue: Promise<void> = Promise.resolve();

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.projectProperties = new ObsidianProjectProperties(this.app);
    this.registerProjectPropertyCaptureOpportunities();
    await this.captureProjectPropertyDefinitions();
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
    this.effectiveTaskStorage = {
      taskArchivePath: this.settings.taskArchivePath,
      taskIgnoreQuery: this.settings.taskIgnoreQuery,
    };
    this.taskIndex = new TaskIndex(this.app, {
      statusCatalog: this.statusCatalog,
      dailyNoteFormat: this.settings.desktop.dailyNoteFormat,
      ...(this.settings.desktop.globalTaskFilter.length > 0
        ? { globalTaskFilter: this.settings.desktop.globalTaskFilter }
        : {}),
      refAuthority,
      excludeSource: (source) => this.isTaskSourceExcluded(source),
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
    const noteTemplates = new NoteTemplateService(this.app);
    const destinationProvider = new ObsidianTaskDestinationProvider(
      () => ({
        taskFilePath: this.settings.taskFilePath,
        taskArchivePath: this.effectiveTaskStorage.taskArchivePath,
        taskTemplatePath: this.settings.taskTemplatePath,
        capturedToday: window.moment().format('YYYY-MM-DD'),
        insertion: configuredTaskInsertion(this.settings),
      }),
      (filePath, templatePath, title) => noteTemplates.ensureNote(filePath, templatePath, title),
      (filePath) => this.isExcludedDestination(filePath),
      (filePath) => this.canonicalTaskDestinationPath(filePath),
    );
    const diagnostics: TaskDiagnosticSink = (diagnostic, error) => {
      console.error('[abyss-tasks] task operation failed', diagnostic, error);
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
    this.projectManager = new ProjectManager(
      this.app,
      this.settings,
      noteTemplates,
      this.tasks,
      this.projectProperties,
    );
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
          this.projectManager,
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
      this.captureProjectPropertyDefinitions().catch((error: unknown) => {
        console.error('[abyss-tasks] project property capture failed unexpectedly', error);
      });
      this.taskIndex.initialize().catch((error: unknown) => {
        console.error('[abyss-tasks] task index initialization failed', error);
      });
    });
  }

  private registerProjectPropertyCaptureOpportunities(): void {
    let used = false;
    this.registerEvent(
      this.app.metadataCache.on('resolved', () => {
        if (used) return;
        used = true;
        this.captureProjectPropertyDefinitions().catch((error: unknown) => {
          console.error('[abyss-tasks] project property capture failed unexpectedly', error);
        });
      }),
    );
  }

  private async captureProjectPropertyDefinitions(): Promise<void> {
    const capture = this.projectPropertyCaptureQueue.then(async () => {
      await initializeProjectPropertyDefinitions({
        projects: this.settings.projects,
        catalog: this.projectProperties,
        save: () => this.saveSettings(),
      });
    });
    this.projectPropertyCaptureQueue = capture.then(
      () => undefined,
      () => undefined,
    );
    try {
      await capture;
    } catch (error) {
      reportSettingsDraftSaveFailure(
        {
          action: 'save captured project property types',
          save: () => this.saveSettings(),
        },
        error,
      );
    }
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

  async saveTaskStorageSettings(draft: TaskStorageSettings): Promise<void> {
    const current = {
      taskArchivePath: this.settings.taskArchivePath,
      taskIgnoreQuery: this.settings.taskIgnoreQuery,
    };
    const validated = validateTaskStorageDraft(current, draft);
    if (validated.type === 'invalid') throw new Error(validated.message);
    this.settings.taskArchivePath = validated.settings.taskArchivePath;
    this.settings.taskIgnoreQuery = validated.settings.taskIgnoreQuery;
    const save = this.saveSettings();
    const revision = latestSettingsSaveRevision(this.settings);
    try {
      await save;
    } catch (error) {
      if (latestSettingsSaveRevision(this.settings) === revision) {
        this.settings.taskArchivePath = current.taskArchivePath;
        this.settings.taskIgnoreQuery = current.taskIgnoreQuery;
      }
      throw error;
    }
    this.effectiveTaskStorage = { ...validated.settings };
    await this.taskIndex.refreshSourceExclusion((source) => this.isTaskSourceExcluded(source));
  }

  private isTaskSourceExcluded(source: TaskSourceMetadata): boolean {
    return evaluateQuery(
      taskSourceIgnoreQuery(this.effectiveTaskStorage),
      source.filePath,
      [...source.tags],
      { ...source.frontmatter },
    );
  }

  private isExcludedDestination(filePath: string): boolean {
    const actual = this.app.vault
      .getMarkdownFiles()
      .find((file) => file.path.toLowerCase() === filePath.toLowerCase());
    const cache = actual === undefined ? null : this.app.metadataCache.getFileCache(actual);
    return this.isTaskSourceExcluded({
      filePath: actual?.path ?? filePath,
      tags: [...(cache == null ? [] : (getAllTags(cache) ?? []))],
      frontmatter: { ...(cache?.frontmatter ?? {}) },
    });
  }

  private canonicalTaskDestinationPath(filePath: string): string {
    interface CaseInsensitiveVaultLookup {
      getAbstractFileByPathInsensitive?(path: string): TAbstractFile | null;
    }
    const vault = this.app.vault as typeof this.app.vault & CaseInsensitiveVaultLookup;
    const existing = vault.getAbstractFileByPathInsensitive?.(filePath);
    if (existing != null) return existing.path;
    const slash = filePath.lastIndexOf('/');
    if (slash < 0) return filePath;
    const parent = vault.getAbstractFileByPathInsensitive?.(filePath.slice(0, slash));
    return parent == null ? filePath : `${parent.path}/${filePath.slice(slash + 1)}`;
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
