import { TFile, type App } from 'obsidian';
import type { TasksApiV1 } from '../../api';
import { TaskApiProvider } from '../../src/integrations/TaskApiProvider';
import { DEFAULT_SETTINGS } from '../../src/settings/defaults';
import { toStatusRules } from '../../src/settings/statusCatalogAdapter';
import { TaskApplicationService } from '../../src/tasks/application/TaskApplicationService';
import type { TaskBehaviorSettingsProvider } from '../../src/tasks/application/TaskBehaviorSettings';
import type { TaskIntegrationReadApi } from '../../src/tasks/application/TaskIntegrationReadApi';
import type { TaskStatusReadBasisApi } from '../../src/tasks/application/TaskStatusMutationApi';
import { clockFrom } from '../../src/tasks/domain/clock';
import { StatusCatalog } from '../../src/tasks/domain/StatusCatalog';
import { TaskBlockEditor } from '../../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { TaskLocator } from '../../src/tasks/infrastructure/markdown/TaskLocator';
import { TaskMarkdownCodec } from '../../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { ObsidianTaskRepository } from '../../src/tasks/infrastructure/obsidian/ObsidianTaskRepository';
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
  });
  const service = new TaskApplicationService(
    index,
    repository,
    statusCatalog,
    { read: () => clockFrom(now, 0).read() },
    undefined,
    options.behaviorSettings,
    undefined,
    undefined,
    undefined,
    index.statusReadBasis(),
  );
  const reads = index.integrationReads();
  const provider = new TaskApiProvider({
    reads,
    mutations: service,
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
      index.destroy();
    },
  };
}
