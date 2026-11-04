import { TFile, type App, type CachedMetadata } from 'obsidian';
import { DEFAULT_SETTINGS } from '../../src/settings/defaults';
import { toStatusRules } from '../../src/settings/statusCatalogAdapter';
import type {
  RevisionPrecondition,
  TaskRepository,
} from '../../src/tasks/application/TaskRepository';
import { StatusCatalog } from '../../src/tasks/domain/StatusCatalog';
import type { TaskNodeRef, TaskSnapshot } from '../../src/tasks/domain/types';
import { TaskBlockEditor } from '../../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { TaskLocator } from '../../src/tasks/infrastructure/markdown/TaskLocator';
import { TaskMarkdownCodec } from '../../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { ObsidianTaskRepository } from '../../src/tasks/infrastructure/obsidian/ObsidianTaskRepository';
import { TaskIndex } from '../../src/tasks/infrastructure/TaskIndex';
import {
  TaskRefAuthority,
  type TaskSnapshotState,
} from '../../src/tasks/infrastructure/TaskRefAuthority';
import { createAppWithFiles, flushMicrotasks, metadataChangedEmitter } from '../helpers';
import { InMemoryTaskRepository } from './InMemoryTaskRepository';
type Adapter = 'in-memory' | 'obsidian';

interface Harness {
  readonly app: App;
  readonly repository: TaskRepository;
  readonly snapshots: (content: string) => readonly TaskSnapshot[];
  readonly read: () => Promise<string>;
  readonly index: TaskIndex;
  readonly authority: TaskRefAuthority;
  readonly fireChanged: (file: TFile, data: string, cache: CachedMetadata) => void;
}

interface HarnessOptions {
  readonly failFinalProjection?: boolean;
  readonly session?: string;
  readonly extraFiles?: Readonly<Record<string, string>>;
}

const path = 'tasks.md';

export async function makeRepositoryHarness(
  adapter: Adapter,
  source: string,
  options: HarnessOptions = {},
): Promise<Harness> {
  const files = { [path]: source, ...options.extraFiles };
  const app = await createAppWithFiles(files);
  const statusCatalog = new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses));
  const codec = new TaskMarkdownCodec(statusCatalog);
  const authority = new TaskRefAuthority(options.session ?? `${adapter}-session`);
  const fireChanged = metadataChangedEmitter(app);
  const index = new TaskIndex(app, {
    statusCatalog,

    refAuthority: authority,
  });
  await index.initialize();
  for (const [filePath, content] of Object.entries(files)) {
    index.installCommittedContent(filePath, content);
  }
  await flushMicrotasks();
  const snapshotState: TaskSnapshotState = {
    currentRoots: (path) => index.currentRoots(path),
    installCommittedBatch: (contents, proof) => index.installCommittedBatch(contents, proof),
    currentRoot: (filePath, line, blockSource) => index.currentRoot(filePath, line, blockSource),
    previewContent: (filePath, content) => {
      if (options.failFinalProjection === true && content !== source)
        throw new Error('injected projection failure');
      return index.previewContent(filePath, content);
    },
    installCommittedContent: (filePath, content) =>
      index.installCommittedContent(filePath, content),
  };
  const snapshots = (content: string) => snapshotState.previewContent(path, content);
  const snapshotsFromContent = (filePath: string, content: string) => {
    if (options.failFinalProjection === true && content !== source)
      throw new Error('injected projection failure');
    return index.previewContent(filePath, content);
  };
  const locator = new TaskLocator(authority);
  if (adapter === 'in-memory') {
    const repository = new InMemoryTaskRepository({
      files,
      fileIdentity: (path) => app.vault.getAbstractFileByPath(path) ?? undefined,
      codec,
      snapshotsFromContent,
      locator,
      refAuthority: authority,
      snapshotState,
    });
    return {
      app,
      repository,
      snapshots,
      index,
      authority,
      fireChanged,
      read: async () => repository.content(path) ?? '',
    };
  }
  const repository = new ObsidianTaskRepository(app, {
    codec,
    editor: new TaskBlockEditor(),
    locator,
    snapshotsFromContent,
    refAuthority: authority,
    snapshotState,
  });
  return {
    app,
    repository,
    snapshots,
    index,
    authority,
    fireChanged,
    read: async () => {
      const file = app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) throw new Error('missing task file');
      return app.vault.cachedRead(file);
    },
  };
}

export function revisionPrecondition(
  baseRoot: TaskSnapshot,
  baseTarget: TaskNodeRef,
): RevisionPrecondition {
  return { baseRoot, baseTarget, reconciliation: { observed: baseRoot } };
}
