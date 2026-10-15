import type {
  TaskSearchApi,
  TaskSearchBatch,
  TaskSearchCursor,
  TaskSearchRequest,
  TaskSearchState,
} from '../../application/TaskSearchApi';
import type {
  TaskSearchBackend,
  TaskSearchBackendBatch,
  TaskSearchServiceOptions,
} from '../../application/TaskSearchBackend';
import {
  validTaskSearchMatchScope,
  type TaskSearchEngineRequest,
} from '../../application/TaskSearchEngine';
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
import { validateSearchBatch } from './TaskSearchRuntime';

interface Ownership {
  cursor: TaskSearchCursor;
  readonly backend: TaskSearchBackend | undefined;
  backendCursor: TaskSearchCursor | undefined;
  readonly cleanup: () => void;
  readonly allocation: AbortController;
  retired?: TaskSearchErrorCode;
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
  private state_abyssPrivate: TaskSearchState = {
    phase: 'idle',
    generation: 0,
    semanticsRevision: 0,
    completedFiles: 0,
    totalFiles: 0,
  };
  private sourceState_abyssPrivate: TaskSearchSourceState = {
    type: 'initializing',
    generation: 0,
    semanticsRevision: 0,
  };
  private readonly listeners_abyssPrivate = new Set<(state: TaskSearchState) => void>();
  private readonly wake_abyssPrivate = new Set<() => void>();
  private readonly versions_abyssPrivate = new Map<string, number>();
  private readonly dirty_abyssPrivate = new Map<string, number | null>();
  private readonly cursors_abyssPrivate = new Map<string, Ownership>();
  private readonly pendingBatches = new Map<
    string,
    { end: number | undefined; batch: Promise<TaskSearchBackendBatch> }
  >();
  private readonly browse = new Map<string, readonly TaskSearchEngineHit[]>();
  private readonly retired_abyssPrivate = new Map<string, TaskSearchErrorCode>();
  private readonly unsubscribe_abyssPrivate: () => void;
  private backend_abyssPrivate: TaskSearchBackend | undefined;
  private unsubscribeFailure_abyssPrivate: (() => void) | undefined;
  private mode_abyssPrivate: 'worker' | 'inline' = 'worker';
  private run_abyssPrivate = new AbortController();
  private pumping_abyssPrivate = false;
  private opening_abyssPrivate: Promise<void> = Promise.resolve();
  private reserving_abyssPrivate: Promise<void> = Promise.resolve();
  private releasing_abyssPrivate: Promise<void> = Promise.resolve();
  private wanted_abyssPrivate = false;
  private published_abyssPrivate = -1;
  private generation_abyssPrivate = 0;
  private semanticsRevision_abyssPrivate = 0;
  private readonly cursorEpoch_abyssPrivate = [...crypto.getRandomValues(new Uint32Array(4))].join(
    '-',
  );
  private sequence_abyssPrivate = 0;
  private clock_abyssPrivate = 0;
  private episode_abyssPrivate = 0;
  private failures_abyssPrivate = 0;
  private completed_abyssPrivate = 0;
  private nextRecoveryAt_abyssPrivate = 0;
  private sourceFailed_abyssPrivate = false;
  constructor(private readonly options: TaskSearchServiceOptions) {
    const subscription = options.source.subscribe((event) => {
      this.accept_abyssPrivate(event);
    });
    this.unsubscribe_abyssPrivate = subscription.unsubscribe;
    this.accept_abyssPrivate({ type: 'state', state: subscription.state });
  }
  subscribe(listener: (state: TaskSearchState) => void): () => void {
    this.listeners_abyssPrivate.add(listener);
    listener(this.state_abyssPrivate);
    return () => {
      this.listeners_abyssPrivate.delete(listener);
    };
  }
  private emit_abyssPrivate(state: TaskSearchState): void {
    this.state_abyssPrivate = state;
    for (const listener of this.listeners_abyssPrivate) {
      try {
        listener(state);
      } catch {
        this.diagnose_abyssPrivate('subscriber');
      }
    }
    for (const resolve of [...this.wake_abyssPrivate]) resolve();
  }
  private progress_abyssPrivate(
    phase: 'idle' | 'waiting' | 'building' | 'updating' | 'recovering',
  ): void {
    this.emit_abyssPrivate({
      phase,
      generation: this.generation_abyssPrivate,
      semanticsRevision: this.semanticsRevision_abyssPrivate,
      completedFiles: this.completed_abyssPrivate,
      totalFiles: this.versions_abyssPrivate.size,
    });
  }
  private accept_abyssPrivate(event: TaskSearchSourceEvent): void {
    if (this.state_abyssPrivate.phase === 'disposed') return;
    const failed = this.state_abyssPrivate.phase === 'failed' ? this.state_abyssPrivate : undefined;
    const generation = event.type === 'state' ? event.state.generation : event.generation;
    const wasSourceFailed = this.sourceFailed_abyssPrivate;
    const previousSource = this.sourceState_abyssPrivate.type;
    const previousGeneration = this.generation_abyssPrivate;
    this.generation_abyssPrivate = generation;
    this.semanticsRevision_abyssPrivate =
      event.type === 'state' ? event.state.semanticsRevision : event.semanticsRevision;
    if (generation !== previousGeneration) this.invalidate_abyssPrivate('stale');
    if (event.type === 'state' && !this.acceptState_abyssPrivate(event.state)) return;
    if (event.type === 'files') this.acceptFiles_abyssPrivate(event.files);
    if (this.duplicateReadiness_abyssPrivate(event, previousSource, previousGeneration)) return;
    this.continueAfterSource_abyssPrivate(failed, wasSourceFailed);
  }
  private duplicateReadiness_abyssPrivate(
    event: TaskSearchSourceEvent,
    previousSource: TaskSearchSourceState['type'],
    previousGeneration: number,
  ): boolean {
    // A duplicate readiness observation neither invalidates live cursors nor republishes the backend.
    return (
      event.type === 'state' &&
      event.state.type === 'ready' &&
      previousSource === 'ready' &&
      this.generation_abyssPrivate === previousGeneration &&
      this.dirty_abyssPrivate.size === 0
    );
  }
  private continueAfterSource_abyssPrivate(
    failed: Extract<TaskSearchState, { phase: 'failed' }> | undefined,
    wasSourceFailed: boolean,
  ): void {
    if (failed !== undefined) {
      if (
        wasSourceFailed &&
        this.sourceState_abyssPrivate.type === 'ready' &&
        this.wanted_abyssPrivate
      )
        this.beginRecovery_abyssPrivate();
      else
        this.emit_abyssPrivate({
          ...failed,
          generation: this.generation_abyssPrivate,
          semanticsRevision: this.semanticsRevision_abyssPrivate,
        });
      return;
    }
    let phase: 'idle' | 'waiting' | 'updating' = 'idle';
    if (this.wanted_abyssPrivate)
      phase = this.backend_abyssPrivate === undefined ? 'waiting' : 'updating';
    this.progress_abyssPrivate(phase);
    this.start_abyssPrivate();
  }
  private acceptFiles_abyssPrivate(
    files: ReadonlyArray<{ path: string; version: number | null }>,
  ): void {
    for (const file of files) {
      if (file.version === null) {
        if (!this.versions_abyssPrivate.delete(file.path)) continue;
      } else {
        if (this.versions_abyssPrivate.get(file.path) === file.version) continue;
        this.versions_abyssPrivate.set(file.path, file.version);
      }
      this.dirty_abyssPrivate.set(file.path, file.version);
    }
  }
  private acceptState_abyssPrivate(state: TaskSearchSourceState): boolean {
    this.sourceState_abyssPrivate = state;
    if (state.type === 'disposed') {
      this.dispose();
      return false;
    }
    if (state.type === 'failed') {
      this.sourceFailed_abyssPrivate = true;
      this.fail_abyssPrivate('source');
      return false;
    }
    if (state.type === 'ready') {
      this.sourceFailed_abyssPrivate = false;
      const files = this.options.source.files();
      const present = new Set(files.map((file) => file.path));
      this.acceptFiles_abyssPrivate(
        [...this.versions_abyssPrivate.keys()]
          .filter((path) => !present.has(path))
          .map((path) => ({ path, version: null })),
      );
      this.acceptFiles_abyssPrivate(files);
    }
    return true;
  }
  private start_abyssPrivate(): void {
    if (
      !this.wanted_abyssPrivate ||
      (this.state_abyssPrivate.phase === 'ready' &&
        this.published_abyssPrivate === this.generation_abyssPrivate &&
        this.dirty_abyssPrivate.size === 0) ||
      this.pumping_abyssPrivate ||
      this.sourceState_abyssPrivate.type !== 'ready' ||
      this.state_abyssPrivate.phase === 'failed' ||
      this.state_abyssPrivate.phase === 'disposed'
    )
      return;
    this.pumping_abyssPrivate = true;
    const run = this.run_abyssPrivate;
    void this.pump_abyssPrivate(run.signal)
      .catch(() => {
        if (!run.signal.aborted) this.recover_abyssPrivate('execution');
      })
      .finally(() => {
        this.pumping_abyssPrivate = false;
        if (this.state_abyssPrivate.phase !== 'ready') this.start_abyssPrivate();
      });
  }
  private async ensureBackend_abyssPrivate(signal: AbortSignal): Promise<TaskSearchBackend> {
    if (this.backend_abyssPrivate === undefined) {
      this.progress_abyssPrivate(this.failures_abyssPrivate > 0 ? 'recovering' : 'building');
      let backend: TaskSearchBackend;
      try {
        backend = await this.options.createBackend(this.mode_abyssPrivate, signal);
      } catch {
        checkAbort(signal);
        if (this.mode_abyssPrivate === 'inline')
          throw new TaskSearchError('unavailable', 'Search startup failed');
        this.diagnose_abyssPrivate('startup');
        this.mode_abyssPrivate = 'inline';
        backend = await this.options.createBackend('inline', signal);
      }
      if (signal.aborted) {
        backend.dispose();
        throw cancelled();
      }
      this.backend_abyssPrivate = backend;
      this.unsubscribeFailure_abyssPrivate = backend.subscribeFailure(() => {
        if (this.backend_abyssPrivate === backend) this.recover_abyssPrivate('worker');
      });
    }
    return this.backend_abyssPrivate;
  }
  private async pump_abyssPrivate(signal: AbortSignal): Promise<void> {
    const backend = await this.ensureBackend_abyssPrivate(signal);
    for (;;) {
      checkAbort(signal);
      const entry = this.dirty_abyssPrivate.entries().next();
      if (entry.done === true) {
        const generation = this.generation_abyssPrivate;
        await backend.mutate({ type: 'publish', generation });
        checkAbort(signal);
        if (generation !== this.generation_abyssPrivate || this.dirty_abyssPrivate.size > 0)
          continue;
        this.published_abyssPrivate = generation;
        this.emit_abyssPrivate({
          phase: 'ready',
          generation,
          semanticsRevision: this.semanticsRevision_abyssPrivate,
          compatibility: this.mode_abyssPrivate === 'inline',
        });
        return;
      }
      const [path, version] = entry.value;
      this.dirty_abyssPrivate.delete(path);
      await this.reconcile_abyssPrivate(backend, path, version, signal);
      checkAbort(signal);
      this.completed_abyssPrivate++;
      this.progress_abyssPrivate(this.published_abyssPrivate < 0 ? 'building' : 'updating');
    }
  }
  private async reconcile_abyssPrivate(
    backend: TaskSearchBackend,
    path: string,
    version: number | null,
    signal: AbortSignal,
  ): Promise<void> {
    if (version === null) await backend.mutate({ type: 'remove', path });
    else {
      try {
        await this.sendFile_abyssPrivate(backend, path, version, signal);
      } catch (error) {
        if (!(error instanceof TaskSearchError && error.code === 'stale')) throw error;
      }
    }
  }
  private async sendFile_abyssPrivate(
    backend: TaskSearchBackend,
    path: string,
    version: number,
    signal: AbortSignal,
  ): Promise<void> {
    const check = (): void => {
      checkAbort(signal);
      if (this.versions_abyssPrivate.get(path) !== version)
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
  private diagnose_abyssPrivate(phase: string): void {
    this.options.diagnose({
      phase,
      backend: this.mode_abyssPrivate,
      generation: this.generation_abyssPrivate,
      pathCount: this.dirty_abyssPrivate.size,
      error: new TaskSearchError('unavailable', 'Task search operation failed'),
    });
  }
  private stopBackend_abyssPrivate(): void {
    this.run_abyssPrivate.abort();
    this.run_abyssPrivate = new AbortController();
    this.unsubscribeFailure_abyssPrivate?.();
    this.unsubscribeFailure_abyssPrivate = undefined;
    this.backend_abyssPrivate?.dispose();
    this.backend_abyssPrivate = undefined;
    this.published_abyssPrivate = -1;
  }
  private recover_abyssPrivate(phase: string): void {
    if (this.state_abyssPrivate.phase === 'disposed' || this.state_abyssPrivate.phase === 'failed')
      return;
    this.diagnose_abyssPrivate(phase);
    this.invalidate_abyssPrivate('unavailable');
    this.stopBackend_abyssPrivate();
    if (this.mode_abyssPrivate === 'inline') {
      this.fail_abyssPrivate(phase);
      return;
    }
    if (++this.failures_abyssPrivate > 1) this.mode_abyssPrivate = 'inline';
    for (const [path, version] of this.versions_abyssPrivate)
      this.dirty_abyssPrivate.set(path, version);
    this.progress_abyssPrivate('recovering');
    this.start_abyssPrivate();
  }
  private fail_abyssPrivate(phase: string): void {
    if (this.state_abyssPrivate.phase === 'disposed' || this.state_abyssPrivate.phase === 'failed')
      return;
    this.diagnose_abyssPrivate(phase);
    this.stopBackend_abyssPrivate();
    this.invalidate_abyssPrivate('unavailable');
    this.nextRecoveryAt_abyssPrivate = this.options.scheduler.now() + 5000;
    this.emit_abyssPrivate({
      phase: 'failed',
      generation: this.generation_abyssPrivate,
      semanticsRevision: this.semanticsRevision_abyssPrivate,
      episode: ++this.episode_abyssPrivate,
    });
  }
  private beginRecovery_abyssPrivate(): void {
    const signal = this.run_abyssPrivate.signal;
    this.failures_abyssPrivate = 0;
    this.mode_abyssPrivate = 'worker';
    for (const [path, version] of this.versions_abyssPrivate)
      this.dirty_abyssPrivate.set(path, version);
    // Publish synchronously so concurrent ordinary intents join this attempt.
    this.progress_abyssPrivate('recovering');
    if (this.sourceState_abyssPrivate.type === 'failed') {
      void Promise.resolve()
        .then(async () => {
          checkAbort(signal);
          await this.options.source.ensureReady();
          checkAbort(signal);
          if (this.sourceState_abyssPrivate.type !== 'ready') this.fail_abyssPrivate('source');
          else this.start_abyssPrivate();
        })
        .catch(() => {
          if (!signal.aborted) this.fail_abyssPrivate('source');
        });
    } else this.start_abyssPrivate();
  }
  /** Shared plugin preparation; cancelling a waiter never cancels the shared build. */
  async prepare(signal: AbortSignal): Promise<void> {
    this.check_abyssPrivate(signal);
    this.wanted_abyssPrivate = true;
    this.start_abyssPrivate();
    await this.waitReady_abyssPrivate(signal, true);
  }
  private check_abyssPrivate(signal?: AbortSignal): void {
    if (signal !== undefined) checkAbort(signal);
    if (this.state_abyssPrivate.phase === 'disposed')
      throw new TaskSearchError('disposed', 'Search disposed');
  }
  private async waitReady_abyssPrivate(signal: AbortSignal, index: boolean): Promise<void> {
    for (;;) {
      this.check_abyssPrivate(signal);
      if (this.state_abyssPrivate.phase === 'failed')
        throw new TaskSearchError('unavailable', 'Search unavailable', this.episode_abyssPrivate);
      if (
        this.sourceState_abyssPrivate.type === 'ready' &&
        (!index ||
          (this.state_abyssPrivate.phase === 'ready' &&
            this.published_abyssPrivate === this.generation_abyssPrivate))
      )
        return;
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          this.wake_abyssPrivate.delete(done);
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
        this.wake_abyssPrivate.add(done);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  }
  private async emptyBrowse_abyssPrivate(
    request: TaskSearchRequest,
    generation: number,
    signal: AbortSignal,
  ): Promise<readonly TaskSearchEngineHit[]> {
    if (request.kind === 'roots') return [];
    const candidates: TaskSearchEngineHit[] = [];
    const abort = (): void => {
      candidates.length = 0;
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      checkAbort(signal);
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
            this.checkGeneration_abyssPrivate(generation, signal);
            slice = this.options.scheduler.now();
          }
        }
      return candidates;
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
  async open(request: TaskSearchRequest, signal: AbortSignal): Promise<TaskSearchCursor> {
    this.check_abyssPrivate(signal);
    if (!validTaskSearchMatchScope(request))
      throw new TaskSearchError('invalid-request', 'Invalid search match scope');
    const query = prepareSearchQuery(request.query, this.options.segment);
    const empty = request.query.trim() === '';
    if (empty) await this.waitReady_abyssPrivate(signal, false);
    else {
      this.wanted_abyssPrivate = true;
      if (
        this.state_abyssPrivate.phase === 'failed' &&
        this.options.scheduler.now() >= this.nextRecoveryAt_abyssPrivate
      )
        this.beginRecovery_abyssPrivate();
      await this.prepare(signal);
    }
    const generation = this.generation_abyssPrivate;
    const allocate = (): Promise<TaskSearchCursor> =>
      this.allocate_abyssPrivate(request, query, generation, signal);
    if (empty) return allocate();
    const pending = this.opening_abyssPrivate.then(allocate);
    this.opening_abyssPrivate = pending.then(
      () => {},
      () => {},
    );
    return abortable(pending, signal);
  }
  private async allocate_abyssPrivate(
    request: TaskSearchRequest,
    query: TaskSearchEngineRequest['query'],
    generation: number,
    signal: AbortSignal,
  ): Promise<TaskSearchCursor> {
    const empty = request.query.trim() === '';
    this.checkGeneration_abyssPrivate(generation, signal);
    const backend = empty ? undefined : this.backend_abyssPrivate;
    const run = this.run_abyssPrivate;
    if (!empty && backend === undefined)
      throw new TaskSearchError('unavailable', 'Search unavailable');
    // Register the allocation before building either kind of vector. Its ID can release a
    // backend vector while the transport still holds the open reply.
    const owner = await this.reserve_abyssPrivate(request.kind, generation, signal, backend);
    try {
      checkAbort(owner.allocation.signal);
      if (backend !== undefined && backend !== this.backend_abyssPrivate)
        throw new TaskSearchError('unavailable', 'Search backend changed');
      if (backend === undefined) {
        const hits = await abortable(
          this.emptyBrowse_abyssPrivate(request, generation, owner.allocation.signal),
          owner.allocation.signal,
        );
        this.checkGeneration_abyssPrivate(generation, signal);
        checkAbort(owner.allocation.signal);
        owner.cursor = { ...owner.cursor, total: hits.length };
        this.browse.set(owner.cursor.id, hits);
      } else {
        const cursor = await abortable(
          backend.open(
            { ...request, query, includeSourcePath: request.includeSourcePath ?? false },
            generation,
            owner.cursor.id,
          ),
          owner.allocation.signal,
        );
        this.checkGeneration_abyssPrivate(generation, signal);
        checkAbort(owner.allocation.signal);
        owner.cursor = cursor;
        owner.backendCursor = cursor;
      }
      return owner.cursor;
    } catch (error) {
      const failure = this.operationError_abyssPrivate(error, owner, run, signal);
      this.retire_abyssPrivate(owner.cursor.id, failure.code);
      throw failure;
    }
  }
  private operationError_abyssPrivate(
    error: unknown,
    owner: Ownership,
    run: AbortController,
    signal: AbortSignal,
  ): TaskSearchError {
    let code: TaskSearchErrorCode = 'unavailable';
    if (signal.aborted) code = 'aborted';
    else if (owner.retired !== undefined) code = owner.retired;
    else if (owner.cursor.generation !== this.generation_abyssPrivate) code = 'stale';
    else if (error instanceof TaskSearchError) code = error.code;
    const expected = code !== 'unavailable' && code !== 'disposed';
    if (!expected && this.ownsOperation_abyssPrivate(owner, run, signal)) {
      this.recover_abyssPrivate('execution');
      code = 'unavailable';
    }
    return new TaskSearchError(code, 'Search operation unavailable');
  }
  private ownsOperation_abyssPrivate(
    owner: Ownership,
    run: AbortController,
    signal: AbortSignal,
  ): boolean {
    return (
      this.run_abyssPrivate === run &&
      !run.signal.aborted &&
      this.backend_abyssPrivate === owner.backend &&
      owner.backend !== undefined &&
      this.cursors_abyssPrivate.get(owner.cursor.id) === owner &&
      owner.retired === undefined &&
      !signal.aborted &&
      owner.cursor.generation === this.generation_abyssPrivate
    );
  }
  private makeRoom_abyssPrivate(): void {
    if (this.cursors_abyssPrivate.size < 4) return;
    const oldest = [...this.cursors_abyssPrivate.values()].sort(
      (a, b) => a.lastUsed - b.lastUsed,
    )[0];
    if (oldest !== undefined) this.retire_abyssPrivate(oldest.cursor.id, 'cursor-expired');
  }
  private reserve_abyssPrivate(
    kind: TaskSearchRequest['kind'],
    generation: number,
    signal: AbortSignal,
    backend: TaskSearchBackend | undefined,
  ): Promise<Ownership> {
    const pending = this.reserving_abyssPrivate.then(async () => {
      await this.releasing_abyssPrivate;
      this.checkGeneration_abyssPrivate(generation, signal);
      this.makeRoom_abyssPrivate();
      await this.releasing_abyssPrivate;
      this.checkGeneration_abyssPrivate(generation, signal);
      const common = {
        id: `${this.cursorEpoch_abyssPrivate}-${++this.sequence_abyssPrivate}`,
        generation,
        total: 0,
      };
      const cursor: TaskSearchCursor =
        kind === 'roots'
          ? { ...common, kind: 'roots', access: 'forward' }
          : { ...common, kind: 'nodes', access: 'random' };
      const abort = (): void => {
        this.retire_abyssPrivate(cursor.id, 'aborted');
      };
      signal.addEventListener('abort', abort, { once: true });
      const owner: Ownership = {
        cursor,
        backend,
        backendCursor: backend === undefined ? undefined : cursor,
        allocation: new AbortController(),
        cleanup: () => {
          signal.removeEventListener('abort', abort);
        },
        lastUsed: ++this.clock_abyssPrivate,
        nextOffset: 0,
      };
      this.cursors_abyssPrivate.set(cursor.id, owner);
      return owner;
    });
    this.reserving_abyssPrivate = pending.then(
      () => {},
      () => {},
    );
    return abortable(pending, signal);
  }
  private checkGeneration_abyssPrivate(generation: number, signal: AbortSignal): void {
    this.check_abyssPrivate(signal);
    if (generation !== this.generation_abyssPrivate)
      throw new TaskSearchError('stale', 'Search generation changed');
  }
  async read(
    cursor: TaskSearchCursor,
    offset: number,
    limit: number,
    signal: AbortSignal,
  ): Promise<TaskSearchBatch> {
    this.checkGeneration_abyssPrivate(cursor.generation, signal);
    const owner = this.cursors_abyssPrivate.get(cursor.id);
    if (owner === undefined)
      throw new TaskSearchError(
        this.retired_abyssPrivate.get(cursor.id) ?? 'cursor-expired',
        'Search cursor unavailable',
      );
    validateSearchBatch(cursor, owner.cursor, offset, limit);
    this.checkForwardOffset_abyssPrivate(owner, offset);
    const run = this.run_abyssPrivate;
    const reading = this.numericBatch_abyssPrivate(owner, offset, limit).catch((error: unknown) => {
      const failure = this.operationError_abyssPrivate(error, owner, run, signal);
      if (!signal.aborted) this.retire_abyssPrivate(owner.cursor.id, failure.code);
      throw failure;
    });
    const batch = await abortable(reading, signal);
    const ids = batch.hits;
    const done = batch.done;
    this.checkGeneration_abyssPrivate(cursor.generation, signal);
    if (!this.cursors_abyssPrivate.has(cursor.id))
      throw new TaskSearchError(
        this.retired_abyssPrivate.get(cursor.id) ?? 'cursor-expired',
        'Search cursor unavailable',
      );
    const hits = ids.map((hit) => {
      const address = this.options.source.address(hit.id);
      if (address === undefined) throw new TaskSearchError('stale', 'Search address changed');
      return { address, score: hit.score };
    });
    this.checkForwardOffset_abyssPrivate(owner, offset);
    owner.nextOffset = offset + ids.length;
    if (this.pendingBatches.get(cursor.id)?.end === owner.nextOffset)
      this.pendingBatches.delete(cursor.id);
    owner.lastUsed = ++this.clock_abyssPrivate;
    if (cursor.access === 'forward' && done) this.release(cursor);
    return { cursor: owner.cursor, offset, hits, done };
  }
  private async numericBatch_abyssPrivate(
    owner: Ownership,
    offset: number,
    limit: number,
  ): Promise<TaskSearchBackendBatch> {
    if (owner.backend !== undefined && owner.backendCursor !== undefined)
      return this.backendBatch_abyssPrivate(owner, offset, limit);
    const hits = (this.browse.get(owner.cursor.id) ?? []).slice(offset, offset + limit);
    return { cursor: owner.cursor, offset, hits, done: offset + hits.length >= owner.cursor.total };
  }
  private backendBatch_abyssPrivate(
    owner: Ownership,
    offset: number,
    limit: number,
  ): Promise<TaskSearchBackendBatch> {
    if (owner.backend === undefined || owner.backendCursor === undefined)
      throw new TaskSearchError('unavailable', 'Backend unavailable');
    if (owner.cursor.access === 'random')
      return owner.backend.read(owner.backendCursor, offset, limit);
    const pending = this.pendingBatches.get(owner.cursor.id);
    if (pending !== undefined)
      return pending.batch.then((batch) => this.pendingBatch_abyssPrivate(batch, offset, limit));
    const entry: { end: number | undefined; batch: Promise<TaskSearchBackendBatch> } = {
      end: undefined,
      batch: owner.backend
        .read(owner.backendCursor, offset, limit)
        .then((batch) => {
          entry.end = batch.offset + batch.hits.length;
          return batch;
        })
        .catch((error: unknown) => {
          if (this.pendingBatches.get(owner.cursor.id) === entry)
            this.pendingBatches.delete(owner.cursor.id);
          throw error;
        }),
    };
    this.pendingBatches.set(owner.cursor.id, entry);
    return entry.batch;
  }
  private pendingBatch_abyssPrivate(
    batch: TaskSearchBackendBatch,
    offset: number,
    limit: number,
  ): TaskSearchBackendBatch {
    const hits = batch.hits.slice(offset - batch.offset, offset - batch.offset + limit);
    return {
      cursor: batch.cursor,
      offset,
      hits,
      done: batch.done && offset + hits.length === batch.offset + batch.hits.length,
    };
  }
  private checkForwardOffset_abyssPrivate(owner: Ownership, offset: number): void {
    if (owner.cursor.access === 'forward' && offset !== owner.nextOffset)
      throw new TaskSearchError('invalid-request', 'Read in order');
  }

  release(cursor: TaskSearchCursor): void {
    this.retire_abyssPrivate(cursor.id, 'cursor-expired');
  }
  private retire_abyssPrivate(id: string, code: TaskSearchErrorCode): void {
    const owner = this.cursors_abyssPrivate.get(id);
    if (owner === undefined) return;
    owner.retired = code;
    owner.allocation.abort();
    owner.cleanup();
    if (owner.backendCursor !== undefined && owner.backend !== undefined) {
      const released = Promise.resolve(owner.backend.release(owner.backendCursor)).catch(() => {
        if (this.backend_abyssPrivate === owner.backend) this.recover_abyssPrivate('release');
      });
      // A posted Worker release still owns its vector until acknowledged (or disposed).
      this.releasing_abyssPrivate = Promise.all([this.releasing_abyssPrivate, released]).then(
        () => {},
      );
    }
    this.cursors_abyssPrivate.delete(id);
    this.browse.delete(id);
    this.pendingBatches.delete(id);
    this.retired_abyssPrivate.set(id, code);
    if (this.retired_abyssPrivate.size > 32) {
      const oldest = this.retired_abyssPrivate.keys().next();
      if (oldest.done !== true) this.retired_abyssPrivate.delete(oldest.value);
    }
  }
  private invalidate_abyssPrivate(code: TaskSearchErrorCode): void {
    for (const id of this.cursors_abyssPrivate.keys()) this.retire_abyssPrivate(id, code);
  }
  async resolveHits(
    hits: readonly TaskSearchHit[],
    signal: AbortSignal,
  ): Promise<readonly TaskSearchHydratedHit[]> {
    this.check_abyssPrivate(signal);
    return this.options.reads.resolveSearchHits(hits, signal);
  }
  dispose(): void {
    if (this.state_abyssPrivate.phase === 'disposed') return;
    this.unsubscribe_abyssPrivate();
    this.invalidate_abyssPrivate('disposed');
    this.stopBackend_abyssPrivate();
    this.dirty_abyssPrivate.clear();
    this.versions_abyssPrivate.clear();
    this.retired_abyssPrivate.clear();
    this.emit_abyssPrivate({
      phase: 'disposed',
      generation: this.generation_abyssPrivate,
      semanticsRevision: this.semanticsRevision_abyssPrivate,
    });
    this.listeners_abyssPrivate.clear();
  }
}
