import { TFile, type App } from 'obsidian';
import { vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/settings/defaults';
import { toStatusRules } from '../../src/settings/statusCatalogAdapter';
import { TaskApplicationService } from '../../src/tasks/application/TaskApplicationService';
import type { TaskBehaviorSettingsProvider } from '../../src/tasks/application/TaskBehaviorSettings';
import type { TaskDestinationProvider } from '../../src/tasks/application/TaskDestinationProvider';
import type { TaskEditPreparation } from '../../src/tasks/application/TaskEditPreparationApi';
import { clockFrom, type Clock } from '../../src/tasks/domain/clock';
import { StatusCatalog } from '../../src/tasks/domain/StatusCatalog';
import { TaskBlockEditor } from '../../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { TaskLocator } from '../../src/tasks/infrastructure/markdown/TaskLocator';
import { TaskMarkdownCodec } from '../../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { ObsidianTaskRepository } from '../../src/tasks/infrastructure/obsidian/ObsidianTaskRepository';
import type { TaskIndexOptions } from '../../src/tasks/infrastructure/TaskIndex';
import { TaskIndex } from '../../src/tasks/infrastructure/TaskIndex';
import { TaskRefAuthority } from '../../src/tasks/infrastructure/TaskRefAuthority';
import { createAppWithFiles, expectDefined } from '../helpers';

export function ready(value: TaskEditPreparation): Extract<TaskEditPreparation, { type: 'ready' }> {
  if (value.type !== 'ready') throw new Error(`Preparation failed: ${JSON.stringify(value)}`);
  return value;
}

export async function taskEditPreparationHarness(
  content: string,
  options: {
    index?: Partial<TaskIndexOptions>;
    behavior?: TaskBehaviorSettingsProvider;
    clock?: Clock;
    files?: Record<string, string>;
    destination?: (app: App, index: TaskIndex) => TaskDestinationProvider;
  } = {},
) {
  const path = 'tasks.md';
  const app = await createAppWithFiles({ [path]: content, ...options.files });
  const catalog = new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses));
  const authority = new TaskRefAuthority('prepared-test');
  const index = new TaskIndex(app, {
    statusCatalog: catalog,
    refAuthority: authority,
    ...options.index,
  });
  await index.initialize();
  const sources = index.projectSources();
  const repository = new ObsidianTaskRepository(app, {
    codec: new TaskMarkdownCodec(catalog),
    editor: new TaskBlockEditor(),
    locator: new TaskLocator(authority),
    refAuthority: authority,
    snapshotState: index,
    snapshotsFromContent: (path, text) => index.previewContent(path, text),
    preparedRootQueries: index,
    preparedRootSources: sources,
    preparedRootReads: index.integrationReads(),
  });
  const service = new TaskApplicationService(
    index,
    repository,
    catalog,
    options.clock ?? clockFrom(Date.UTC(2026, 10, 7, 12), 0),
    options.destination?.(app, index),
    options.behavior,
  );
  const process = app.vault.process.bind(app.vault);
  const writes = vi.spyOn(app.vault, 'process');
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) throw new Error('Missing fixture');
  return {
    app,
    index,
    authority,
    service,
    catalog,
    repository,
    sources,
    writes,
    process,
    file,
    root: expectDefined(index.list()[0]),
    read: () => app.vault.read(file),
  };
}
