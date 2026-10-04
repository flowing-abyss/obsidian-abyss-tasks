import type {
  TaskSearchApi,
  TaskSearchCursor,
  TaskSearchPage,
  TaskSearchRequest,
  TaskSearchState,
} from '../../application/TaskSearchApi';
import type {
  TaskSearchBackend,
  TaskSearchBackendPage,
  TaskSearchServiceOptions,
} from '../../application/TaskSearchBackend';
import type { TaskSearchEngineRequest } from '../../application/TaskSearchEngine';
import type {
  TaskSearchDocument,
  TaskSearchEngineHit,
  TaskSearchSourceEvent,
  TaskSearchSourceState,
} from '../../application/TaskSearchSource';
import { prepareSearchQuery } from '../../domain/searchMatchPolicy';
import {
  TaskSearchError,
  type TaskSearchErrorCode,
  type TaskSearchHit,
  type TaskSearchHydratedHit,
} from '../../domain/taskSearchTypes';
import { validateSearchPage } from './TaskSearchRuntime';

interface Ownership {
  readonly cursor: TaskSearchCursor;
  readonly backend: TaskSearchBackend | undefined;
  readonly backendCursor: TaskSearchCursor | undefined;
  readonly cleanup: () => void;
  lastUsed: number;
  nextOffset: number;
}
function cancelled(): TaskSearchError {
  return new TaskSearchError('aborted', 'Search cancelled');
}
function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw cancelled();
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      reject(cancelled());
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    void promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort);
    });
  });
}
/** Plugin-lifetime owner. Source authority and addresses never cross the backend boundary. */
export class TaskSearchService implements TaskSearchApi {
  private state: TaskSearchState = {
    phase: 'idle',
    generation: 0,
    completedFiles: 0,
    totalFiles: 0,
  };
  private sourceState: TaskSearchSourceState = { type: 'initializing', generation: 0 };
  private readonly listeners = new Set<(state: TaskSearchState) => void>();
  private readonly wake = new Set<() => void>();
  private readonly versions = new Map<string, number>();
  private readonly dirty = new Map<string, number | null>();
  private readonly cursors = new Map<string, Ownership>();
  private readonly pendingPages = new Map<
    string,
    { end: number | undefined; page: Promise<TaskSearchBackendPage> }
  >();
  private readonly browse = new Map<string, readonly TaskSearchEngineHit[]>();
  private readonly retired = new Map<string, TaskSearchErrorCode>();
  private readonly unsubscribe: () => void;
  private backend: TaskSearchBackend | undefined;
  private unsubscribeFailure: (() => void) | undefined;
  private mode: 'worker' | 'inline' = 'worker';
  private run = new AbortController();
  private pumping = false;
  private opening: Promise<void> = Promise.resolve();
  private wanted = false;
  private published = -1;
  private generation = 0;
  private readonly cursorEpoch = [...crypto.getRandomValues(new Uint32Array(4))].join('-');
  private sequence = 0;
  private clock = 0;
  private episode = 0;
  private failures = 0;
  private completed = 0;
  constructor(private readonly options: TaskSearchServiceOptions) {
    const subscription = options.source.subscribe((event) => {
      this.accept(event);
    });
    this.unsubscribe = subscription.unsubscribe;
    this.accept({ type: 'state', state: subscription.state });
  }
  subscribe(listener: (state: TaskSearchState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit(state: TaskSearchState): void {
    this.state = state;
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch {
        this.diagnose('subscriber');
      }
    }
    for (const resolve of [...this.wake]) resolve();
  }
  private progress(phase: 'idle' | 'waiting' | 'building' | 'updating' | 'recovering'): void {
    this.emit({
      phase,
      generation: this.generation,
      completedFiles: this.completed,
      totalFiles: this.versions.size,
    });
  }
  private accept(event: TaskSearchSourceEvent): void {
    if (this.state.phase === 'disposed') return;
    const failed = this.state.phase === 'failed' ? this.state : undefined;
    this.generation = event.type === 'state' ? event.state.generation : event.generation;
    this.invalidate('stale');
    if (event.type === 'state' && !this.acceptState(event.state)) return;
    if (event.type === 'files') this.acceptFiles(event.files);
    if (failed !== undefined) {
      this.emit({ ...failed, generation: this.generation });
      return;
    }
    let phase: 'idle' | 'waiting' | 'updating' = 'idle';
    if (this.wanted) phase = this.backend === undefined ? 'waiting' : 'updating';
    this.progress(phase);
    this.start();
  }
  private acceptFiles(files: ReadonlyArray<{ path: string; version: number | null }>): void {
    for (const file of files) {
      if (file.version === null) this.versions.delete(file.path);
      else this.versions.set(file.path, file.version);
      this.dirty.set(file.path, file.version);
    }
  }
  private acceptState(state: TaskSearchSourceState): boolean {
    this.sourceState = state;
    if (state.type === 'disposed') {
      this.dispose();
      return false;
    }
    if (state.type === 'failed') {
      this.fail('source');
      return false;
    }
    if (state.type === 'ready') {
      this.versions.clear();
      for (const file of this.options.source.files()) {
        this.versions.set(file.path, file.version);
        this.dirty.set(file.path, file.version);
      }
    }
    return true;
  }
  private start(): void {
    if (
      !this.wanted ||
      this.pumping ||
      this.sourceState.type !== 'ready' ||
      this.state.phase === 'failed' ||
      this.state.phase === 'disposed'
    )
      return;
    this.pumping = true;
    const run = this.run;
    void this.pump(run.signal)
      .catch(() => {
        if (!run.signal.aborted) this.recover('execution');
      })
      .finally(() => {
        this.pumping = false;
        if (this.state.phase !== 'ready') this.start();
      });
  }
  private async ensureBackend(signal: AbortSignal): Promise<TaskSearchBackend> {
    if (this.backend === undefined) {
      this.progress(this.failures > 0 ? 'recovering' : 'building');
      let backend: TaskSearchBackend;
      try {
        backend = await this.options.createBackend(this.mode);
      } catch {
        checkAbort(signal);
        if (this.mode === 'inline')
          throw new TaskSearchError('unavailable', 'Search startup failed');
        this.diagnose('startup');
        this.mode = 'inline';
        backend = await this.options.createBackend('inline');
      }
      if (signal.aborted) {
        backend.dispose();
        throw cancelled();
      }
      this.backend = backend;
      this.unsubscribeFailure = backend.subscribeFailure(() => {
        if (this.backend === backend) this.recover('worker');
      });
    }
    return this.backend;
  }
  private async pump(signal: AbortSignal): Promise<void> {
    const backend = await this.ensureBackend(signal);
    for (;;) {
      checkAbort(signal);
      const entry = this.dirty.entries().next();
      if (entry.done === true) {
        const generation = this.generation;
        await backend.mutate({ type: 'publish', generation });
        checkAbort(signal);
        if (generation !== this.generation || this.dirty.size > 0) continue;
        this.published = generation;
        this.emit({ phase: 'ready', generation, compatibility: this.mode === 'inline' });
        return;
      }
      const [path, version] = entry.value;
      this.dirty.delete(path);
      await this.reconcile(backend, path, version, signal);
      checkAbort(signal);
      this.completed++;
      this.progress(this.published < 0 ? 'building' : 'updating');
    }
  }
  private async reconcile(
    backend: TaskSearchBackend,
    path: string,
    version: number | null,
    signal: AbortSignal,
  ): Promise<void> {
    if (version === null) await backend.mutate({ type: 'remove', path });
    else {
      try {
        await this.sendFile(backend, path, version, signal);
      } catch (error) {
        if (!(error instanceof TaskSearchError && error.code === 'stale')) throw error;
      }
    }
  }
  private async sendFile(
    backend: TaskSearchBackend,
    path: string,
    version: number,
    signal: AbortSignal,
  ): Promise<void> {
    const check = (): void => {
      checkAbort(signal);
      if (this.versions.get(path) !== version)
        throw new TaskSearchError('stale', 'Source file changed');
    };
    const pause = async (): Promise<void> => {
      check();
      await this.options.scheduler.yield(signal);
      check();
    };
    check();
    await backend.mutate({ type: 'begin', path });
    check();
    // One acknowledged payload at a time also meets the two-in-flight ceiling. Each payload is
    // released before projecting another; an oversized document therefore always travels alone.
    let documents: TaskSearchDocument[] = [];
    let bytes = 0;
    let slice = this.options.scheduler.now();
    const flush = async (): Promise<void> => {
      if (documents.length > 0) {
        check();
        const payload = documents;
        documents = [];
        bytes = 0;
        await backend.mutate({ type: 'add', documents: payload });
      }
      await pause();
      slice = this.options.scheduler.now();
    };
    for (const document of this.options.source.documents({ path, version })) {
      check();
      // Three bytes per UTF-16 unit conservatively bounds UTF-8 payload bytes without
      // allocating an encoded clone merely to measure it. Coordinates have a bounded allowance.
      const size =
        128 +
        document.order.filePath.length * 3 +
        document.order.childLines.length * 8 +
        (document.title.length +
          document.description.length +
          document.comments.length +
          document.tags.length +
          document.metadata.length +
          document.links.length +
          document.sourcePath.length) *
          3;
      if (documents.length > 0 && (documents.length >= 128 || bytes + size > 262144)) await flush();
      documents.push(document);
      bytes += size;
      if (bytes >= 262144 || documents.length >= 128 || this.options.scheduler.now() - slice >= 6)
        await flush();
    }
    await flush();
    check();
    await backend.mutate({ type: 'commit', path });
  }
  private diagnose(phase: string): void {
    this.options.diagnose({
      phase,
      backend: this.mode,
      generation: this.generation,
      pathCount: this.dirty.size,
      error: new TaskSearchError('unavailable', 'Task search operation failed'),
    });
  }
  private stopBackend(): void {
    this.run.abort();
    this.run = new AbortController();
    this.unsubscribeFailure?.();
    this.unsubscribeFailure = undefined;
    this.backend?.dispose();
    this.backend = undefined;
    this.published = -1;
  }
  private recover(phase: string): void {
    if (this.state.phase === 'disposed' || this.state.phase === 'failed') return;
    this.diagnose(phase);
    this.invalidate('unavailable');
    this.stopBackend();
    if (this.mode === 'inline') {
      this.fail(phase);
      return;
    }
    if (++this.failures > 1) this.mode = 'inline';
    for (const [path, version] of this.versions) this.dirty.set(path, version);
    this.progress('recovering');
    this.start();
  }
  private fail(phase: string): void {
    this.diagnose(phase);
    this.stopBackend();
    this.invalidate('unavailable');
    this.emit({ phase: 'failed', generation: this.generation, episode: ++this.episode });
  }
  async retry(): Promise<void> {
    this.check();
    this.stopBackend();
    this.invalidate('unavailable');
    this.failures = 0;
    this.mode = 'worker';
    this.wanted = true;
    for (const [path, version] of this.versions) this.dirty.set(path, version);
    this.progress('recovering');
    this.start();
    await this.waitReady(new AbortController().signal, true);
  }
  private check(signal?: AbortSignal): void {
    if (signal !== undefined) checkAbort(signal);
    if (this.state.phase === 'disposed') throw new TaskSearchError('disposed', 'Search disposed');
  }
  private async waitReady(signal: AbortSignal, index: boolean): Promise<void> {
    for (;;) {
      this.check(signal);
      if (this.sourceState.type === 'failed' || this.state.phase === 'failed')
        throw new TaskSearchError('unavailable', 'Search unavailable', this.episode);
      if (
        this.sourceState.type === 'ready' &&
        (!index || (this.state.phase === 'ready' && this.published === this.generation))
      )
        return;
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          this.wake.delete(done);
          signal.removeEventListener('abort', abort);
        };
        const done = (): void => {
          cleanup();
          resolve();
        };
        const abort = (): void => {
          cleanup();
          reject(cancelled());
        };
        this.wake.add(done);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  }
  private async emptyBrowse(
    request: TaskSearchRequest,
    generation: number,
    signal: AbortSignal,
  ): Promise<readonly TaskSearchEngineHit[]> {
    const candidates: TaskSearchEngineHit[] = [];
    if (request.kind === 'nodes') {
      const files = this.options.source
        .files()
        .filter((file) => request.filePath === undefined || file.path === request.filePath);
      files.sort((a, b) => {
        const preference =
          Number(b.path === request.preferFilePath) - Number(a.path === request.preferFilePath);
        return preference !== 0 ? preference : a.path.localeCompare(b.path);
      });
      let slice = this.options.scheduler.now();
      for (const file of files)
        for (const node of this.options.source.nodes(file)) {
          candidates.push({ id: node.id, score: 0 });
          if (candidates.length % 128 === 0 || this.options.scheduler.now() - slice >= 6) {
            await this.options.scheduler.yield(signal);
            this.checkGeneration(generation, signal);
            slice = this.options.scheduler.now();
          }
        }
    }
    return candidates;
  }
  async open(request: TaskSearchRequest, signal: AbortSignal): Promise<TaskSearchCursor> {
    this.check(signal);
    const query = prepareSearchQuery(request.query, this.options.segment);
    await this.waitReady(signal, false);
    const generation = this.generation;
    if (request.query.trim() === '') {
      const hits = await this.emptyBrowse(request, generation, signal);
      this.checkGeneration(generation, signal);
      return this.own(request.kind, generation, signal, {
        backend: undefined,
        backendCursor: undefined,
        hits,
      });
    }
    this.wanted = true;
    this.start();
    await this.waitReady(signal, true);
    const pending = this.opening.then(() =>
      this.openBackend(
        { ...request, query, includeSourcePath: request.includeSourcePath ?? false },
        generation,
        signal,
      ),
    );
    // Reserve/release global capacity before the backend allocates its next vector. Serializing
    // allocation also prevents concurrent opens from making the backend evict a different owner.
    this.opening = pending.then(
      () => {},
      () => {},
    );
    return abortable(pending, signal);
  }
  private async openBackend(
    request: TaskSearchEngineRequest,
    generation: number,
    signal: AbortSignal,
  ): Promise<TaskSearchCursor> {
    this.checkGeneration(generation, signal);
    const backend = this.backend;
    if (backend === undefined) throw new TaskSearchError('unavailable', 'Search unavailable');
    this.makeRoom();
    const pending = backend.open(request, generation);
    // An aborted caller owns even a late-opened backend vector.
    void pending.then(
      (cursor) => {
        if (signal.aborted || generation !== this.generation || backend !== this.backend)
          backend.release(cursor);
      },
      () => {},
    );
    const backendCursor = await pending;
    this.checkGeneration(generation, signal);
    return this.own(request.kind, generation, signal, { backend, backendCursor, hits: undefined });
  }
  private makeRoom(): void {
    if (this.cursors.size < 4) return;
    const oldest = [...this.cursors.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (oldest !== undefined) this.retire(oldest.cursor.id, 'cursor-expired');
  }
  private own(
    kind: TaskSearchRequest['kind'],
    generation: number,
    signal: AbortSignal,
    result: {
      backend: TaskSearchBackend | undefined;
      backendCursor: TaskSearchCursor | undefined;
      hits: readonly TaskSearchEngineHit[] | undefined;
    },
  ): TaskSearchCursor {
    const { backend, backendCursor, hits } = result;
    const common = {
      id: `${this.cursorEpoch}-${++this.sequence}`,
      generation,
      total: hits?.length ?? backendCursor?.total ?? 0,
    };
    const cursor: TaskSearchCursor =
      kind === 'roots'
        ? { ...common, kind: 'roots', access: 'forward' }
        : { ...common, kind: 'nodes', access: 'random' };
    this.makeRoom();
    const abort = (): void => {
      this.retire(cursor.id, 'aborted');
    };
    signal.addEventListener('abort', abort, { once: true });
    this.cursors.set(cursor.id, {
      cursor,
      backend,
      backendCursor,
      cleanup: () => {
        signal.removeEventListener('abort', abort);
      },
      lastUsed: ++this.clock,
      nextOffset: 0,
    });
    if (hits !== undefined) this.browse.set(cursor.id, hits);
    return cursor;
  }
  private checkGeneration(generation: number, signal: AbortSignal): void {
    this.check(signal);
    if (generation !== this.generation)
      throw new TaskSearchError('stale', 'Search generation changed');
  }
  async read(
    cursor: TaskSearchCursor,
    offset: number,
    limit: number,
    signal: AbortSignal,
  ): Promise<TaskSearchPage> {
    this.checkGeneration(cursor.generation, signal);
    const owner = this.cursors.get(cursor.id);
    if (owner === undefined)
      throw new TaskSearchError(
        this.retired.get(cursor.id) ?? 'cursor-expired',
        'Search cursor unavailable',
      );
    validateSearchPage(cursor, owner.cursor, offset, limit);
    this.checkForwardOffset(owner, offset);
    const page = await abortable(this.numericPage(owner, offset, limit), signal);
    const ids = page.hits;
    const done = page.done;
    this.checkGeneration(cursor.generation, signal);
    if (!this.cursors.has(cursor.id))
      throw new TaskSearchError(
        this.retired.get(cursor.id) ?? 'cursor-expired',
        'Search cursor unavailable',
      );
    const hits = ids.map((hit) => {
      const address = this.options.source.address(hit.id);
      if (address === undefined) throw new TaskSearchError('stale', 'Search address changed');
      return { address, score: hit.score };
    });
    this.checkForwardOffset(owner, offset);
    owner.nextOffset = offset + ids.length;
    if (this.pendingPages.get(cursor.id)?.end === owner.nextOffset)
      this.pendingPages.delete(cursor.id);
    owner.lastUsed = ++this.clock;
    if (cursor.access === 'forward' && done) this.release(cursor);
    return { cursor: owner.cursor, offset, hits, done };
  }
  private async numericPage(
    owner: Ownership,
    offset: number,
    limit: number,
  ): Promise<TaskSearchBackendPage> {
    if (owner.backend !== undefined && owner.backendCursor !== undefined)
      return this.backendPage(owner, offset, limit);
    const hits = (this.browse.get(owner.cursor.id) ?? []).slice(offset, offset + limit);
    return { cursor: owner.cursor, offset, hits, done: offset + hits.length >= owner.cursor.total };
  }
  private backendPage(
    owner: Ownership,
    offset: number,
    limit: number,
  ): Promise<TaskSearchBackendPage> {
    if (owner.backend === undefined || owner.backendCursor === undefined)
      throw new TaskSearchError('unavailable', 'Backend unavailable');
    if (owner.cursor.access === 'random')
      return owner.backend.read(owner.backendCursor, offset, limit);
    const pending = this.pendingPages.get(owner.cursor.id);
    if (pending !== undefined)
      return pending.page.then((page) => this.pendingSlice(page, offset, limit));
    const entry: { end: number | undefined; page: Promise<TaskSearchBackendPage> } = {
      end: undefined,
      page: owner.backend.read(owner.backendCursor, offset, limit).then((page) => {
        entry.end = page.offset + page.hits.length;
        return page;
      }),
    };
    this.pendingPages.set(owner.cursor.id, entry);
    return entry.page;
  }
  private pendingSlice(
    page: TaskSearchBackendPage,
    offset: number,
    limit: number,
  ): TaskSearchBackendPage {
    const hits = page.hits.slice(offset - page.offset, offset - page.offset + limit);
    return {
      cursor: page.cursor,
      offset,
      hits,
      done: page.done && offset + hits.length === page.offset + page.hits.length,
    };
  }
  private checkForwardOffset(owner: Ownership, offset: number): void {
    if (owner.cursor.access === 'forward' && offset !== owner.nextOffset)
      throw new TaskSearchError('invalid-request', 'Read in order');
  }

  release(cursor: TaskSearchCursor): void {
    this.retire(cursor.id, 'cursor-expired');
  }
  private retire(id: string, code: TaskSearchErrorCode): void {
    const owner = this.cursors.get(id);
    if (owner === undefined) return;
    owner.cleanup();
    if (owner.backendCursor !== undefined) owner.backend?.release(owner.backendCursor);
    this.cursors.delete(id);
    this.browse.delete(id);
    this.pendingPages.delete(id);
    this.retired.set(id, code);
    if (this.retired.size > 32) {
      const oldest = this.retired.keys().next();
      if (oldest.done !== true) this.retired.delete(oldest.value);
    }
  }
  private invalidate(code: TaskSearchErrorCode): void {
    for (const id of this.cursors.keys()) this.retire(id, code);
  }
  async resolvePage(
    hits: readonly TaskSearchHit[],
    signal: AbortSignal,
  ): Promise<readonly TaskSearchHydratedHit[]> {
    this.check(signal);
    return this.options.reads.resolveSearchPage(hits, signal);
  }
  dispose(): void {
    if (this.state.phase === 'disposed') return;
    this.unsubscribe();
    this.invalidate('disposed');
    this.stopBackend();
    this.dirty.clear();
    this.versions.clear();
    this.retired.clear();
    this.emit({ phase: 'disposed', generation: this.generation });
    this.listeners.clear();
  }
}
