import { TFile, type App } from 'obsidian';
import type { TasksApiV1 } from '../../api';
import { TaskApiProvider } from '../../src/integrations/TaskApiProvider';
import { NoteApplicationService } from '../../src/notes/NoteApplicationService';
import { NoteHostAdapter } from '../../src/notes/NoteHostAdapter';
import { NoteTemplateService } from '../../src/notes/NoteTemplateService';
import { DEFAULT_SETTINGS } from '../../src/settings/defaults';
import { toStatusRules } from '../../src/settings/statusCatalogAdapter';
import { TaskApplicationService } from '../../src/tasks/application/TaskApplicationService';
import type { TaskBehaviorSettingsProvider } from '../../src/tasks/application/TaskBehaviorSettings';
import type { TaskIntegrationReadApi } from '../../src/tasks/application/TaskIntegrationReadApi';
import type { TaskStatusReadBasisApi } from '../../src/tasks/application/TaskStatusMutationApi';
import { clockFrom } from '../../src/tasks/domain/clock';
import { fallbackSearchWords } from '../../src/tasks/domain/searchMatchPolicy';
import { StatusCatalog } from '../../src/tasks/domain/StatusCatalog';
import { TaskBlockEditor } from '../../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { TaskLocator } from '../../src/tasks/infrastructure/markdown/TaskLocator';
import { TaskMarkdownCodec } from '../../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { CanonicalNoteTaskProtection } from '../../src/tasks/infrastructure/obsidian/NoteTaskProtection';
import { ObsidianTaskDestinationProvider } from '../../src/tasks/infrastructure/obsidian/ObsidianTaskDestinationProvider';
import { ObsidianTaskRepository } from '../../src/tasks/infrastructure/obsidian/ObsidianTaskRepository';
import { runTaskFileMutation } from '../../src/tasks/infrastructure/obsidian/taskFileMutationQueue';
import { createMiniSearchTaskEngine } from '../../src/tasks/infrastructure/search/MiniSearchTaskEngine';
import { TaskSearchRuntime } from '../../src/tasks/infrastructure/search/TaskSearchRuntime';
import { TaskSearchService } from '../../src/tasks/infrastructure/search/TaskSearchService';
import { TaskIndex, type TaskIndexOptions } from '../../src/tasks/infrastructure/TaskIndex';
import { TaskRefAuthority } from '../../src/tasks/infrastructure/TaskRefAuthority';
import { createAppWithFiles, flushMicrotasks, metadataChangedEmitter } from '../helpers';

let providerEpoch = 0;

export interface PublicApiHarness {
  readonly provider: TaskApiProvider;
  client(consumerId?: string): TasksApiV1;
  readonly app: App;
  readonly index: TaskIndex;
  readonly service: TaskApplicationService;
  readonly noteService: NoteApplicationService;
  clock(ms: number): void;
  readonly reads: TaskIntegrationReadApi;
  readonly statusReadBasis: TaskStatusReadBasisApi;
  readonly authority: TaskRefAuthority;
  read(path: string): Promise<string>;
  external(path: string, content: string): Promise<void>;
  dispose(): void;
}

export async function publicApiHarness(
  files: Readonly<Record<string, string>>,
  options: {
    readonly initialize?: boolean;
    readonly provision?: boolean;
    readonly index?: Partial<TaskIndexOptions>;
    readonly behaviorSettings?: TaskBehaviorSettingsProvider;
  } = {},
): Promise<PublicApiHarness> {
  const app = await createAppWithFiles({ ...files });
  const statusCatalog =
    options.index?.statusCatalog ?? new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses));
  const authority = new TaskRefAuthority('public-api-test');
  const fireChanged = metadataChangedEmitter(app);
  const index = new TaskIndex(app, { statusCatalog, refAuthority: authority, ...options.index });
  const file = (path: string): TFile => {
    const target = app.vault.getAbstractFileByPath(path);
    if (!(target instanceof TFile)) throw new Error('Missing test source');
    return target;
  };
  if (options.initialize !== false) await index.initialize();
  let now = Date.UTC(2026, 7, 1, 12);
  const repository = new ObsidianTaskRepository(app, {
    codec: new TaskMarkdownCodec(statusCatalog),
    editor: new TaskBlockEditor(),
    locator: new TaskLocator(authority),
    snapshotsFromContent: (path, content) => index.previewContent(path, content),
    refAuthority: authority,
    snapshotState: index,
    preparedRootQueries: index,
    preparedRootSources: index.projectSources(),
    preparedRootReads: index.integrationReads(),
  });
  const templates = new NoteTemplateService(app);
  const destinations =
    options.provision === true
      ? new ObsidianTaskDestinationProvider(
          () => ({
            taskFilePath: 'a.md',
            taskTemplatePath: '',
            capturedToday: '2026-08-01',
            insertion: { type: 'append' },
          }),
          (path, template, title) => templates.ensureNote(path, template, title),
          () => false,
          {
            canonicalize: (path) => path,
            readNote: (path) => {
              const sources = index.projectSources(),
                source = sources.get(path),
                file = app.vault.getFileByPath(path);
              return source.type === 'ok' &&
                source.value !== undefined &&
                file !== null &&
                sources.matchesFile(source.value, file)
                ? { file, content: source.value.content }
                : undefined;
            },
            planNote: (path, template, title) => templates.planStaticNote(path, template, title),
          },
        )
      : undefined;
  const service = new TaskApplicationService(
    index,
    repository,
    statusCatalog,
    { read: () => clockFrom(now, 0).read() },
    destinations,
    options.behaviorSettings,
    undefined,
    undefined,
    undefined,
    index.statusReadBasis(),
  );
  const reads = index.integrationReads();
  const search = new TaskSearchService({
    source: index.searchSource(),
    reads: index,
    segment: fallbackSearchWords,
    scheduler: { now: () => now, yield: async () => {}, delay: async () => {} },
    createBackend: async () =>
      new TaskSearchRuntime(createMiniSearchTaskEngine(fallbackSearchWords)),
    diagnose: () => {},
  });
  const noteSources = index.projectSources();
  const noteService = new NoteApplicationService(app, noteSources, {
    capture: () => reads.capture(),
    host: new NoteHostAdapter(app, noteSources, (source) => index.noteStructure(source)),
    protection: new CanonicalNoteTaskProtection(app, index, authority),
    serialize: (path, work) => runTaskFileMutation(app, path, work),
  });
  const provider = new TaskApiProvider({
    notes: noteService,
    search,
    reads,
    mutations: service,
    content: {
      edits: service,
      creates: service,
      hierarchies: service,
      statuses: () => statusCatalog.all(),
    },
    pluginVersion: '2.3.2',
    epoch: `test-${++providerEpoch}`,
    now: () => now,
    diagnostic: () => {},
  });
  return {
    provider,
    client: (consumerId = 'test') => {
      const result = provider.getApi(1, { consumerId });
      if (!result.ok) throw new Error(result.error.code);
      return result.value;
    },
    app,
    service,
    noteService,
    clock: (ms) => {
      now = ms;
    },
    index,
    authority,
    reads,
    statusReadBasis: index.statusReadBasis(),
    read: (path) => app.vault.read(file(path)),
    external: async (path, content) => {
      const target = file(path);
      await app.vault.modify(target, content);
      fireChanged(target, content, {});
      await flushMicrotasks();
    },
    dispose: () => {
      provider.dispose();
      search.dispose();
      index.destroy();
    },
  };
}
