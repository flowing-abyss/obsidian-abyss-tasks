import { Plugin } from 'obsidian';
import { registerCodeBlock, resolveConfig } from './code-block/registerCodeBlock';
import { ProjectCommandService } from './projects/ProjectCommandService';
import { WorkNoteIndex } from './projects/work-notes/WorkNoteIndex';
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
import { PANEL_VIEW_TYPE, PanelView } from './views/PanelView';

export default class TaskCalendarPlugin extends Plugin {
  settings!: CalendarSettings;
  tagManager!: TagManager;
  queries!: TaskQueryApi;
  tasks!: TaskApplicationApi & TaskCaptureApplicationApi;
  private taskIndex!: TaskIndex;
  private statusCatalog!: StatusCatalog;
  private statusRegistry!: StatusRegistry;
  private projectCommands!: ProjectCommandService;
  private workNoteIndex!: WorkNoteIndex;

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
    );
    this.queries = this.tasks.queries;
    this.tagManager = new TagManager(this.app, this.settings, () => this.saveSettings());
    this.projectCommands = new ProjectCommandService(
      this.app,
      () => this.settings.projects.statuses,
    );
    this.workNoteIndex = new WorkNoteIndex(
      this.app,
      () => this.settings.projects.workNoteCompatibility,
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
      void this.taskIndex.initialize();
      this.workNoteIndex.initialize();
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
      );
      renderer.mount();
    };
  }

  onunload(): void {
    this.taskIndex.destroy();
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
