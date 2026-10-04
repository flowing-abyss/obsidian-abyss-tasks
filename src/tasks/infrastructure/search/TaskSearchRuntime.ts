import type { TaskSearchCursor } from '../../application/TaskSearchApi';
import type {
  TaskSearchBackend,
  TaskSearchBackendPage,
  TaskSearchMutation,
} from '../../application/TaskSearchBackend';
import type { TaskSearchEngine, TaskSearchEngineRequest } from '../../application/TaskSearchEngine';
import type { TaskSearchEngineHit } from '../../application/TaskSearchSource';
import { TaskSearchError } from '../../domain/taskSearchTypes';

interface RetainedSearchVector {
  readonly cursor: TaskSearchCursor;
  readonly hits: readonly TaskSearchEngineHit[];
  nextOffset: number;
  lastUsed: number;
}
export function validateSearchPage(
  cursor: TaskSearchCursor,
  expected: TaskSearchCursor,
  offset: number,
  limit: number,
): void {
  if (
    cursor.kind !== expected.kind ||
    cursor.access !== expected.access ||
    cursor.total !== expected.total
  )
    throw new TaskSearchError('invalid-request', 'Invalid search cursor');
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > cursor.total ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 200
  )
    throw new TaskSearchError('invalid-request', 'Invalid search page');
}
/** One engine and at most four compact vectors, shared by both execution backends. */
export class TaskSearchRuntime implements TaskSearchBackend {
  private readonly vectors = new Map<string, RetainedSearchVector>();
  private generation = -1;
  private published = false;
  private sequence = 0;
  private clock = 0;
  private disposed = false;
  private readonly files = new Set<string>();
  private readonly failures = new Set<(cause: unknown) => void>();
  private vacuumNeeded = false;
  private vacuumRunning = false;
  constructor(private readonly engine: TaskSearchEngine) {}
  subscribeFailure(listener: (cause: unknown) => void): () => void {
    this.failures.add(listener);
    return () => {
      this.failures.delete(listener);
    };
  }
  async mutate(operation: TaskSearchMutation): Promise<void> {
    this.check();
    if (operation.type !== 'publish') {
      this.published = false;
      this.vectors.clear();
    }
    switch (operation.type) {
      case 'begin':
        this.vacuumNeeded ||= this.files.has(operation.path);
        this.files.add(operation.path);
        this.engine.replaceBegin(operation.path);
        break;
      case 'add':
        this.engine.add(operation.documents);
        break;
      case 'commit':
        this.engine.replaceCommit(operation.path);
        break;
      case 'remove':
        if (this.files.delete(operation.path)) this.vacuumNeeded = true;
        this.engine.remove(operation.path);
        break;
      case 'publish':
        this.check();
        if (this.generation !== operation.generation) this.vectors.clear();
        this.generation = operation.generation;
        this.published = true;
        this.maintain();
    }
  }
  private maintain(): void {
    if (!this.vacuumNeeded || this.vacuumRunning || this.disposed) return;
    this.vacuumNeeded = false;
    this.vacuumRunning = true;
    // MiniSearch's public incremental vacuum supports searches and discards between batches.
    // Accepted publication is independent of reclaiming obsolete postings.
    void this.engine
      .vacuum()
      .catch((cause: unknown) => {
        if (!this.disposed) for (const listener of this.failures) listener(cause);
      })
      .finally(() => {
        this.vacuumRunning = false;
        if (this.published) this.maintain();
      });
  }
  async open(request: TaskSearchEngineRequest, generation: number): Promise<TaskSearchCursor> {
    this.check();
    if (!this.published) throw new TaskSearchError('unavailable', 'Search publication pending');
    if (generation !== this.generation)
      throw new TaskSearchError('stale', 'Search generation changed');
    const hits = this.engine.search(request);
    const common = { id: String(++this.sequence), generation, total: hits.length };
    const cursor: TaskSearchCursor =
      request.kind === 'roots'
        ? { ...common, kind: 'roots', access: 'forward' }
        : { ...common, kind: 'nodes', access: 'random' };
    if (this.vectors.size >= 4) {
      const oldest = [...this.vectors.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (oldest !== undefined) this.vectors.delete(oldest.cursor.id);
    }
    this.vectors.set(cursor.id, { cursor, hits, nextOffset: 0, lastUsed: ++this.clock });
    return cursor;
  }
  async read(
    cursor: TaskSearchCursor,
    offset: number,
    limit: number,
  ): Promise<TaskSearchBackendPage> {
    this.check();
    if (cursor.generation !== this.generation || !this.published)
      throw new TaskSearchError('stale', 'Search generation changed');
    const vector = this.vectors.get(cursor.id);
    if (vector === undefined) throw new TaskSearchError('cursor-expired', 'Search cursor expired');
    validateSearchPage(cursor, vector.cursor, offset, limit);
    if (cursor.access === 'forward' && offset !== vector.nextOffset)
      throw new TaskSearchError('invalid-request', 'Read in order');
    const hits = vector.hits.slice(offset, offset + limit);
    const done = offset + hits.length >= vector.hits.length;
    vector.lastUsed = ++this.clock;
    if (cursor.access === 'forward') {
      vector.nextOffset = offset + hits.length;
      if (done) this.vectors.delete(cursor.id);
    }
    return { cursor: vector.cursor, offset, hits, done };
  }
  release(cursor: TaskSearchCursor): void {
    this.vectors.delete(cursor.id);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.vectors.clear();
    this.files.clear();
    this.failures.clear();
    this.engine.dispose();
  }
  private check(): void {
    if (this.disposed) throw new TaskSearchError('disposed', 'Search runtime disposed');
  }
}
