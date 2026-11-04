import { TFile, type App } from 'obsidian';
import { DEFAULT_SETTINGS } from '../../src/settings/defaults';
import { toStatusRules } from '../../src/settings/statusCatalogAdapter';
import type { TaskIntegrationReadStateApi } from '../../src/tasks/application/TaskIntegrationReadApi';
import { StatusCatalog } from '../../src/tasks/domain/StatusCatalog';
import { TaskIndex, type TaskIndexOptions } from '../../src/tasks/infrastructure/TaskIndex';
import { TaskRefAuthority } from '../../src/tasks/infrastructure/TaskRefAuthority';
import { createAppWithFiles, flushMicrotasks, metadataChangedEmitter } from '../helpers';

export interface PublicApiHarness {
  readonly app: App;
  readonly index: TaskIndex;
  readonly reads: TaskIntegrationReadStateApi;
  readonly authority: TaskRefAuthority;
  read(path: string): Promise<string>;
  external(path: string, content: string): Promise<void>;
  dispose(): void;
}

export async function publicApiHarness(
  files: Readonly<Record<string, string>>,
  options: { readonly initialize?: boolean; readonly index?: Partial<TaskIndexOptions> } = {},
): Promise<PublicApiHarness> {
  const app = await createAppWithFiles({ ...files });
  const statusCatalog = new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses));
  const authority = new TaskRefAuthority('public-api-test');
  const fireChanged = metadataChangedEmitter(app);
  const index = new TaskIndex(app, { statusCatalog, refAuthority: authority, ...options.index });
  const file = (path: string): TFile => {
    const target = app.vault.getAbstractFileByPath(path);
    if (!(target instanceof TFile)) throw new Error('Missing test source');
    return target;
  };
  if (options.initialize !== false) await index.initialize();
  return {
    app,
    index,
    authority,
    reads: index.integrationReads(),
    read: (path) => app.vault.read(file(path)),
    external: async (path, content) => {
      const target = file(path);
      await app.vault.modify(target, content);
      fireChanged(target, content, {});
      await flushMicrotasks();
    },
    dispose: () => {
      index.destroy();
    },
  };
}
