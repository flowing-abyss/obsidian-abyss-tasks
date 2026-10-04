import type { CalendarSettings } from '../../src/settings/types';
import type {
  TaskSearchBackend,
  TaskSearchDiagnostic,
  TaskSearchMutation,
  TaskSearchScheduler,
} from '../../src/tasks/application/TaskSearchBackend';
import type {
  TaskSearchDocument,
  TaskSearchFileVersion,
  TaskSearchSource,
  TaskSearchSourceEvent,
  TaskSearchSourceState,
} from '../../src/tasks/application/TaskSearchSource';
import {
  fallbackSearchWords,
  type SearchWordSegmenter,
} from '../../src/tasks/domain/searchMatchPolicy';
import { TaskSearchError } from '../../src/tasks/domain/taskSearchTypes';
import { createMiniSearchTaskEngine } from '../../src/tasks/infrastructure/search/MiniSearchTaskEngine';
import { TaskSearchRuntime } from '../../src/tasks/infrastructure/search/TaskSearchRuntime';
import { TaskSearchService } from '../../src/tasks/infrastructure/search/TaskSearchService';
import type { TaskIndex } from '../../src/tasks/infrastructure/TaskIndex';
import { configuredTaskApplication, createAppWithFiles } from '../helpers';

export function nodeDocuments(count: number): TaskSearchDocument[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    rootId: index + 1,
    order: { filePath: 'a.md', line: index, childLines: [] },
    title: `needle ${index}`,
    description: '',
    comments: '',
    tags: '',
    metadata: '',
    links: '',
    sourcePath: '',
  }));
}
export class FakeSearchSource implements TaskSearchSource {
  state: TaskSearchSourceState = { type: 'initializing', generation: 0 };
  readonly listeners = new Set<(event: TaskSearchSourceEvent) => void>();
  readonly store = new Map<string, { version: number; docs: readonly TaskSearchDocument[] }>();
  readonly iterations: string[] = [];
  subscribe(listener: (event: TaskSearchSourceEvent) => void) {
    this.listeners.add(listener);
    return {
      state: this.state,
      unsubscribe: () => {
        this.listeners.delete(listener);
      },
    };
  }
  emit(event: TaskSearchSourceEvent) {
    for (const listener of this.listeners) listener(event);
  }
  ready(files: readonly TaskSearchDocument[][]): void {
    for (const docs of files)
      if (docs[0] !== undefined) this.store.set(docs[0].order.filePath, { version: 1, docs });
    this.state = { type: 'ready', generation: this.state.generation + 1 };
    this.emit({ type: 'state', state: this.state });
  }
  replace(path: string, docs: readonly TaskSearchDocument[]): void {
    const version = (this.store.get(path)?.version ?? 0) + 1;
    this.store.set(path, { version, docs });
    this.state = { type: 'ready', generation: this.state.generation + 1 };
    this.emit({ type: 'files', generation: this.state.generation, files: [{ path, version }] });
  }
  fail(cause: unknown): void {
    this.state = { type: 'failed', generation: this.state.generation, cause };
    this.emit({ type: 'state', state: this.state });
  }
  dispose(): void {
    this.state = { type: 'disposed', generation: this.state.generation };
    this.emit({ type: 'state', state: this.state });
  }
  async ensureReady(): Promise<void> {
    if (this.state.type === 'failed') throw new Error('Source unavailable');
  }
  files() {
    return [...this.store].map(([path, { version }]) => ({ path, version }));
  }
  *documents(file: TaskSearchFileVersion) {
    this.iterations.push(file.path);
    for (const doc of this.store.get(file.path)?.docs ?? []) {
      if (this.store.get(file.path)?.version !== file.version)
        throw new TaskSearchError('stale', 'Changed');
      yield doc;
    }
  }
  nodes(file: TaskSearchFileVersion) {
    return this.documents(file);
  }
  address(id: number) {
    for (const { docs, version } of this.store.values()) {
      const doc = docs.find((d) => d.id === id);
      if (doc !== undefined)
        return { epoch: 'fixture', version, rootId: doc.rootId, childLines: doc.order.childLines };
    }
    return undefined;
  }
}
export class ControlledSearchScheduler implements TaskSearchScheduler {
  private held = false;
  private readonly pending: Array<() => void> = [];
  now() {
    return performance.now();
  }
  async yield(signal: AbortSignal): Promise<void> {
    if (this.held) await new Promise<void>((resolve) => this.pending.push(resolve));
    if (signal.aborted) throw new TaskSearchError('aborted', 'Cancelled');
  }
  delay(_ms: number, signal: AbortSignal) {
    return this.yield(signal);
  }
  hold(): void {
    this.held = true;
  }
  async flush(): Promise<void> {
    this.held = false;
    for (const resolve of this.pending.splice(0)) resolve();
    await Promise.resolve();
  }
}
export class FakeSearchBackend extends TaskSearchRuntime {
  searchCalls = 0;
  readonly operations: TaskSearchMutation[] = [];
  readonly crashListeners = new Set<(cause: unknown) => void>();
  constructor(segment: SearchWordSegmenter = fallbackSearchWords) {
    super(createMiniSearchTaskEngine(segment));
  }
  override subscribeFailure(listener: (cause: unknown) => void) {
    this.crashListeners.add(listener);
    return () => {
      this.crashListeners.delete(listener);
    };
  }
  override async mutate(op: TaskSearchMutation) {
    this.operations.push(
      op.type === 'add' ? { type: 'add', documents: op.documents.map((d) => ({ ...d })) } : op,
    );
    await super.mutate(op);
  }
  override async open(...args: Parameters<TaskSearchBackend['open']>) {
    this.searchCalls++;
    return super.open(...args);
  }
  async flush() {
    await Promise.resolve();
  }
  crash() {
    for (const listener of this.crashListeners) listener(new Error('Worker failed'));
  }
}
export function createTaskSearchHarness() {
  const source = new FakeSearchSource();
  const backends: FakeSearchBackend[] = [];
  const scheduler = new ControlledSearchScheduler();
  const service = new TaskSearchService({
    source,
    reads: { observedTags: () => [], async *organization() {}, resolveSearchPage: async () => [] },
    segment: fallbackSearchWords,
    scheduler,
    createBackend: async () => {
      const backend = new FakeSearchBackend();
      backends.push(backend);
      return backend;
    },
    diagnose: () => {},
  });
  return { service, source, backends, scheduler };
}
export async function createCanonicalSearchHarness(
  files: Record<string, string>,
  settings: CalendarSettings,
  initialize = true,
  segment: SearchWordSegmenter = fallbackSearchWords,
) {
  const app = await createAppWithFiles(files);
  const parts = configuredTaskApplication(app, settings, { authority: true });
  if (initialize) {
    await parts.index.initialize();
    for (const [path, text] of Object.entries(files))
      parts.index.installCommittedContent(path, text);
  }
  const source = parts.index.searchSource();
  const backends: FakeSearchBackend[] = [];
  const diagnostics: TaskSearchDiagnostic[] = [];
  const scheduler = new ControlledSearchScheduler();
  const search = new TaskSearchService({
    source,
    reads: parts.index,
    segment,
    scheduler,
    createBackend: async () => {
      const backend = new FakeSearchBackend(segment);
      backends.push(backend);
      return backend;
    },
    diagnose: (value) => {
      diagnostics.push(value);
    },
  });
  return {
    diagnostics,
    backends,
    scheduler,
    app,
    ...parts,
    source,
    search,
    close() {
      search.dispose();
      parts.index.destroy();
    },
  };
}
export function assertNoRevision(value: unknown, revision: string): void {
  if (typeof value === 'string' && value === revision)
    throw new Error('Source-bearing revision escaped');
  if (value !== null && typeof value === 'object')
    for (const [key, child] of Object.entries(value)) {
      if (key === revision || ['ref', 'revision', 'originalBlock'].includes(key))
        throw new Error(`Rich property escaped: ${key}`);
      assertNoRevision(child, revision);
    }
}

/** Real service for fixtures that already own a canonical index/application. */
export function canonicalSearchForIndex(index: TaskIndex) {
  return new TaskSearchService({
    source: index.searchSource(),
    reads: index,
    segment: fallbackSearchWords,
    scheduler: new ControlledSearchScheduler(),
    createBackend: async () =>
      new TaskSearchRuntime(createMiniSearchTaskEngine(fallbackSearchWords)),
    diagnose: () => {},
  });
}
