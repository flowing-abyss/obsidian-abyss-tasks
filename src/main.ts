import taskSearchWorkerSource from 'abyss-task-search-worker';
import { getAllTags, normalizePath, Notice, Plugin, TFile, type TAbstractFile } from 'obsidian';
import { extractMarkdownBodyTags } from './markdown/markdownTagRename';
import { compileNotePathPattern, type NotePathPattern } from './markdown/notePathPattern';
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
  isViewStateWritesSuspended,
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
import type { CalendarSettings } from './settings/types';
import { ViewStatePathOwner } from './settings/ViewStatePathOwner';
import { StatusRegistry } from './status/StatusRegistry';
import { TagManager } from './tags/TagManager';
import type { TaskSearchApi } from './tasks';
import {
  localDate,
  recentTrackingWindow,
  resumeTarget,
  type TaskApplicationApi,
  type TaskCaptureApplicationApi,
  type TaskDependencyQueryApi,
  type TaskInsertionPolicy,
  type TaskQueryApi,
  type TaskStatisticsSource,
  type TimeTrackingQueryApi,
} from './tasks';
import { TaskApplicationService } from './tasks/application/TaskApplicationService';
import {
  TaskDependencyService,
  type TaskDiagnosticSink,
} from './tasks/application/TaskDependencyService';
import type {
  TaskSearchDiagnostic,
  TaskSearchScheduler,
} from './tasks/application/TaskSearchBackend';
import { systemClock } from './tasks/domain/clock';
import type { CommentTimeContextProvider } from './tasks/domain/commentTimeLabel';
import { StatusCatalog } from './tasks/domain/StatusCatalog';
import { systemCommentTimeContext } from './tasks/infrastructure/commentTimeContext';
import { TaskBlockEditor } from './tasks/infrastructure/markdown/TaskBlockEditor';
import { parseMarkdownFrontmatter } from './tasks/infrastructure/markdown/taskBlockSyntax';
import { TaskLocator } from './tasks/infrastructure/markdown/TaskLocator';
import { TaskMarkdownCodec } from './tasks/infrastructure/markdown/TaskMarkdownCodec';
import { nativeTaskIndentUnit } from './tasks/infrastructure/obsidian/nativeTaskIndentation';
import { ObsidianTaskDestinationProvider } from './tasks/infrastructure/obsidian/ObsidianTaskDestinationProvider';
import { ObsidianTaskRepository } from './tasks/infrastructure/obsidian/ObsidianTaskRepository';
import {
  BrowserTaskSearchBackend,
  createBrowserSearchScheduler,
} from './tasks/infrastructure/search/BrowserTaskSearchBackend';
import { createMiniSearchTaskEngine } from './tasks/infrastructure/search/MiniSearchTaskEngine';
import { createSearchWordSegmenter } from './tasks/infrastructure/search/searchWordSegmenter';
import { TaskSearchRuntime } from './tasks/infrastructure/search/TaskSearchRuntime';
import { TaskSearchService } from './tasks/infrastructure/search/TaskSearchService';
import { TaskIndex, type TaskSourceMetadata } from './tasks/infrastructure/TaskIndex';
import { TaskRefAuthority } from './tasks/infrastructure/TaskRefAuthority';
import { presentTaskCommandResult } from './ui/taskCommandResult';
import { createTrackingActions } from './ui/timeTracking/trackingActions';
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
const NO_RESUME_TARGET = 'There is no recent task to resume';
const DEVICE_OFFSET_AT = (epochMs: number): number => -new Date(epochMs).getTimezoneOffset();

export default class TaskCalendarPlugin extends Plugin {
  override settings!: CalendarSettings;
  tagManager!: TagManager;
  queries!: TaskQueryApi & TaskDependencyQueryApi & TimeTrackingQueryApi;
  tasks!: TaskApplicationApi & TaskCaptureApplicationApi;
  private taskIndex!: TaskIndex;
  taskStatistics!: TaskStatisticsSource;
  private statisticsArchivePattern!: NotePathPattern;
  private taskSearch!: TaskSearchService;
  get search(): TaskSearchApi {
    return this.taskSearch;
  }
  private statusCatalog!: StatusCatalog;
  private statusRegistry!: StatusRegistry;
  private projectManager!: ProjectManager;
  private projectProperties!: ProjectPropertyCatalog;
  private settingsPersistence!: SettingsPersistenceCoordinator;
  private viewStatePaths!: ViewStatePathOwner;
  private effectiveTaskStorage!: TaskStorageSettings;
  private projectPropertyCaptureQueue: Promise<void> = Promise.resolve();

  override async onload(): Promise<void> {
    await this.loadSettings();
    for (const ref of this.viewStatePaths.listen(this.app.vault)) this.registerEvent(ref);
    this.projectProperties = new ObsidianProjectProperties(this.app);
    this.registerProjectPropertyCaptureOpportunities();
    await this.captureProjectPropertyDefinitions();
    this.initializeTaskServices();
    const commentTimeContext: CommentTimeContextProvider = systemCommentTimeContext;
    this.registerPanel(commentTimeContext);
    this.registerCommands();
    this.addSettingTab(new CalendarSettingsTab(this.app, this));
    this.initializeIndexWhenReady();
  }

  private initializeSearch(scheduler: TaskSearchScheduler): void {
    const segment = createSearchWordSegmenter();
    this.taskSearch = new TaskSearchService({
      source: this.taskIndex.searchSource(),
      reads: this.taskIndex,
      segment,
      scheduler,
      createBackend: async (mode, signal) =>
        mode === 'worker'
          ? BrowserTaskSearchBackend.create(taskSearchWorkerSource, signal)
          : new TaskSearchRuntime(createMiniSearchTaskEngine(segment)),
      diagnose: (value: TaskSearchDiagnostic) => {
        console.error('[abyss-tasks] search operation failed', value);
      },
    });
  }

  private initializeTaskServices(): void {
    this.statusCatalog = new StatusCatalog(toStatusRules(this.settings.taskStatuses));
    this.statusRegistry = new StatusRegistry(this.settings.taskStatuses);
    const refAuthority = new TaskRefAuthority();
    const scheduler = createBrowserSearchScheduler();
    this.initializeTaskStatisticsPolicy();
    this.taskIndex = new TaskIndex(this.app, {
      statusCatalog: this.statusCatalog,
      refAuthority,
      excludeSource: (source) => this.isTaskSourceExcluded(source),
      statisticsFileKind: (path, tags, frontmatter) =>
        this.taskStatisticsFileKind(path, tags, frontmatter),
      readYield: (signal) => scheduler.yield(signal),
    });
    this.taskStatistics = this.taskIndex;
    this.initializeSearch(scheduler);
    const codec = new TaskMarkdownCodec(this.statusCatalog);
    const repository = new ObsidianTaskRepository(this.app, {
      codec,
      editor: new TaskBlockEditor(() => nativeTaskIndentUnit(this.app.vault)),
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
        DEVICE_OFFSET_AT,
        (epochMs) => localDate(window.moment(epochMs).format('YYYY-MM-DD')),
      ),
      destinationProvider,
      () => ({
        taskPrefix: this.settings.taskPrefix,
        applyTaskPrefixToSubtasks: this.settings.applyTaskPrefixToSubtasks,
        inbox: this.settings.inbox,
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
    this.initializeTagManager();
  }

  private initializeTagManager(): void {
    this.tagManager = new TagManager(this.app, this.settings, () => this.saveSettings(), {
      check: (change) => this.settingsPersistence.checkTagRename(this.settings, change),
      apply: async (change, applyLive) => {
        this.viewStatePaths.cancelPendingSave();
        const pending = this.settingsPersistence.renameTagViewState(this.settings, change);
        try {
          applyLive();
        } finally {
          await pending;
        }
      },
    });
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
          () => this.saveViewStateWithNotice(),
          this.projectManager,
          this.search,
          this.taskStatistics,
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
    this.addCommand({
      id: 'toggle-time-tracking',
      name: 'Pause or resume time tracking',
      callback: async () => {
        await this.toggleTimeTracking();
      },
    });
  }

  /**
   * One key for the whole timer. Something running is paused, and an idle vault picks up the task
   * that was tracked most recently, as long as it is still a task somebody can work on.
   */
  private async toggleTimeTracking(): Promise<void> {
    const actions = createTrackingActions(this.tasks, presentTaskCommandResult);
    if (this.queries.activeEntries().length > 0) {
      await actions.pause();
      return;
    }
    // The same window the rail widget groups, so the key and the widget always name one task.
    const span = recentTrackingWindow(Date.now(), DEVICE_OFFSET_AT);
    const recent = resumeTarget(this.queries.entriesOverlapping(span.fromMs, span.toMs));
    if (recent === undefined || recent.status === 'done' || recent.status === 'cancelled') {
      new Notice(NO_RESUME_TARGET);
      return;
    }
    await actions.start(recent.target);
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

  override onunload(): void {
    this.viewStatePaths.flushPendingSave();
    this.taskSearch.dispose();
    this.taskIndex.destroy();
  }

  async loadSettings(): Promise<void> {
    this.settingsPersistence = new SettingsPersistenceCoordinator(this.persistencePort());
    try {
      const loaded = await this.settingsPersistence.loadSettings(DEFAULT_SETTINGS);
      this.settings = loaded.settings;
      this.viewStatePaths = new ViewStatePathOwner(this.settings, () => this.saveViewState());
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
    this.refreshProjectSettings();
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
    this.statisticsArchivePattern = compileNotePathPattern(
      this.effectiveTaskStorage.taskArchivePath,
    );
    await this.taskIndex.refreshSourceExclusion((source) => this.isTaskSourceExcluded(source));
  }

  private initializeTaskStatisticsPolicy(): void {
    this.effectiveTaskStorage = {
      taskArchivePath: this.settings.taskArchivePath,
      taskIgnoreQuery: this.settings.taskIgnoreQuery,
    };
    this.statisticsArchivePattern = compileNotePathPattern(
      this.effectiveTaskStorage.taskArchivePath,
    );
  }

  private isTaskSourceExcluded(source: TaskSourceMetadata): boolean {
    return evaluateQuery(
      taskSourceIgnoreQuery(this.effectiveTaskStorage),
      source.filePath,
      [...source.tags],
      { ...source.frontmatter },
    );
  }

  private taskStatisticsFileKind(
    path: string,
    tags: readonly string[],
    frontmatter: Readonly<Record<string, unknown>>,
  ): 'live' | 'archive' | undefined {
    if (
      evaluateQuery(this.effectiveTaskStorage.taskIgnoreQuery, path, [...tags], { ...frontmatter })
    )
      return undefined;
    return this.statisticsArchivePattern.matches(path) ? 'archive' : 'live';
  }

  private async isExcludedDestination(filePath: string): Promise<boolean> {
    const actual = this.app.vault
      .getMarkdownFiles()
      .find((file) => file.path.toLowerCase() === filePath.toLowerCase());
    if (!(actual instanceof TFile)) {
      return this.isTaskSourceExcluded({ filePath, tags: [], frontmatter: {} });
    }
    const content = await this.app.vault.cachedRead(actual);
    const parsed = parseMarkdownFrontmatter(content.split(/\r?\n/u));
    const frontmatter = parsed.type === 'valid' ? (parsed.value ?? {}) : {};
    const frontmatterTags = getAllTags({ frontmatter }) ?? [];
    return this.isTaskSourceExcluded({
      filePath: actual.path,
      tags: [...new Set([...frontmatterTags, ...extractMarkdownBodyTags(content)])],
      frontmatter: { ...frontmatter },
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

  /**
   * A plain view-state write, like `saveSettings()`: it rethrows without presenting the failure.
   * The coordinator snapshots the whole runtime settings, so this write carries the note-path
   * owner's pending change and cancels that save.
   */
  async saveViewState(): Promise<void> {
    this.viewStatePaths.cancelPendingSave();
    await this.settingsPersistence.saveViewState(this.settings);
  }

  /**
   * The panel's route. A failed write gets this route's log and one Notice, then rejects, so the
   * caller may log its own context; a write refused while writes are suspended resolves silently.
   */
  private async saveViewStateWithNotice(): Promise<void> {
    try {
      await this.saveViewState();
    } catch (error) {
      if (isViewStateWritesSuspended(error)) return;
      console.error('[abyss-tasks] saved view state write failed', error);
      new Notice('Could not save view preferences. Your current session is unchanged.');
      throw error;
    }
  }

  /** Brings every open panel's project settings in line with the settings in memory. */
  refreshProjectSettings(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(PANEL_VIEW_TYPE)) {
      if (leaf.view instanceof PanelView) leaf.view.refreshProjectSettings();
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
