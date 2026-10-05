import type { BrowserTaskScheduler } from '../browserTaskScheduler';
import {
  TaskSearchError,
  type DependencyDirection,
  type TaskDependencyEligibility,
  type TaskDependencyQueryApi,
  type TaskNodeRef,
  type TaskNodeSnapshot,
  type TaskSearchAddress,
  type TaskSearchApi,
  type TaskSearchEligibilityBatch,
  type TaskSearchEligibilityRequest,
  type TaskSearchHit,
  type TaskSearchState,
} from '../tasks';
import { rejectionLabel, type DependencySearchOption } from './dependencySearch';
import { taskNodeLine } from './taskSelection';

export interface DependencyCandidate {
  readonly offset: number;
  readonly hit: TaskSearchHit;
  readonly eligibility: TaskDependencyEligibility;
}
export interface DependencyCandidateRange {
  readonly generation: number;
  readonly offset: number;
  readonly candidates: readonly DependencyCandidate[];
}
export interface TaskDependencySearchSession {
  readonly generation: number;
  readonly totalCandidates: number;
  readRange(offset: number, limit: number, signal: AbortSignal): Promise<DependencyCandidateRange>;
  options(
    candidates: readonly DependencyCandidate[],
    signal: AbortSignal,
  ): Promise<readonly DependencySearchOption[]>;
  resolve(address: TaskSearchAddress, signal: AbortSignal): Promise<TaskNodeSnapshot>;
  close(): void;
}
export interface TaskDependencySearchProvider {
  open(
    query: string,
    current: TaskNodeRef,
    direction: DependencyDirection,
    signal: AbortSignal,
  ): Promise<TaskDependencySearchSession>;
}
type SearchCursor = Awaited<ReturnType<TaskSearchApi['open']>>;
type SearchBatch = Awaited<ReturnType<TaskSearchApi['read']>>;
export function createTaskDependencySearchProvider(
  search: TaskSearchApi,
  queries: TaskDependencyQueryApi,
  scheduler: Pick<BrowserTaskScheduler, 'yield'>,
): TaskDependencySearchProvider {
  return {
    open: async (query, current, direction, signal) => {
      const session = new DependencySession(
        { search, queries, scheduler },
        { current, direction },
        signal,
      );
      try {
        await session.open(query);
        return session;
      } catch (error) {
        session.close();
        throw error;
      }
    },
  };
}

class DependencySession implements TaskDependencySearchSession {
  readonly #controller = new AbortController();
  #cursor: SearchCursor | undefined;
  #state: TaskSearchState | undefined;
  #failure: TaskSearchError | undefined;
  #unsubscribe: (() => void) | undefined;
  #pending: AbortController | undefined;
  #completion: Promise<void> | undefined;
  readonly #abort = (): void => {
    this.close();
  };

  constructor(
    private readonly ports: {
      readonly search: TaskSearchApi;
      readonly queries: TaskDependencyQueryApi;
      readonly scheduler: Pick<BrowserTaskScheduler, 'yield'>;
    },
    private readonly selection: {
      readonly current: TaskNodeRef;
      readonly direction: DependencyDirection;
    },
    private readonly owner: AbortSignal,
  ) {
    this.#unsubscribe = ports.search.subscribe((state) => {
      this.#state = state;
      if (this.#cursor !== undefined) this.#invalidate(state);
    });
    owner.addEventListener('abort', this.#abort, { once: true });
    if (owner.aborted) this.close();
  }

  async open(query: string): Promise<void> {
    this.#check();
    let root = this.selection.current;
    while (root.type === 'subtask') root = root.ref.parent;
    const cursor = await this.ports.search.open(
      {
        kind: 'nodes',
        query,
        includeSourcePath: true,
        preferFilePath: root.ref.filePath,
      },
      this.#controller.signal,
    );
    this.#cursor = cursor;
    if (this.#failure !== undefined) this.#release();
    if (this.#state !== undefined) this.#invalidate(this.#state);
    this.#check();
  }

  #invalidate(state: TaskSearchState): void {
    if (state.phase === 'failed')
      this.#stop(new TaskSearchError('unavailable', 'Search unavailable', state.episode));
    else if (state.phase === 'disposed')
      this.#stop(new TaskSearchError('disposed', 'Search disposed'));
    else if (state.generation !== this.#cursor?.generation || state.phase === 'recovering')
      this.#stop(new TaskSearchError('stale', 'Task generation changed'));
  }

  #check(signal?: AbortSignal): void {
    if (this.#failure !== undefined) throw this.#failure;
    if (signal?.aborted === true) throw new TaskSearchError('aborted', 'Search cancelled');
  }

  #release(): void {
    const cursor = this.#cursor;
    this.#cursor = undefined;
    if (cursor !== undefined) this.ports.search.release(cursor);
  }

  #stop(error: TaskSearchError): void {
    if (this.#failure !== undefined) return;
    this.#failure = error;
    this.#controller.abort();
    this.owner.removeEventListener('abort', this.#abort);
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#release();
  }

  close(): void {
    this.#stop(new TaskSearchError('aborted', 'Search cancelled'));
  }

  async #operate<T>(signal: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.#check(signal);
    this.#pending?.abort();
    const previous = this.#completion;
    let finish!: () => void;
    const completion = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.#completion = completion;
    const controller = new AbortController();
    this.#pending = controller;
    const abort = (): void => {
      controller.abort();
    };
    signal.addEventListener('abort', abort, { once: true });
    this.#controller.signal.addEventListener('abort', abort, { once: true });
    try {
      await previous;
      this.#check(controller.signal);
      const result = await run(controller.signal);
      this.#check(controller.signal);
      return result;
    } catch (error) {
      this.#check(controller.signal);
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
      this.#controller.signal.removeEventListener('abort', abort);
      if (this.#pending === controller) this.#pending = undefined;
      if (this.#completion === completion) this.#completion = undefined;
      finish();
    }
  }

  #eligibility(
    addresses: readonly TaskSearchAddress[],
    signal: AbortSignal,
  ): Promise<TaskSearchEligibilityBatch> {
    this.#check(signal);
    const cursor = this.#cursor;
    if (cursor === undefined) throw new TaskSearchError('stale', 'Task changed');
    const request: TaskSearchEligibilityRequest = {
      expectedGeneration: cursor.generation,
      current: this.selection.current,
      direction: this.selection.direction,
      addresses,
    };
    return this.ports.queries.searchEligibility(request, signal);
  }

  get generation(): number {
    this.#check();
    if (this.#cursor === undefined) throw new TaskSearchError('stale', 'Task changed');
    return this.#cursor.generation;
  }
  get totalCandidates(): number {
    this.#check();
    if (this.#cursor === undefined) throw new TaskSearchError('stale', 'Task changed');
    return this.#cursor.total;
  }
  readRange(offset: number, limit: number, signal: AbortSignal): Promise<DependencyCandidateRange> {
    return this.#operate(signal, async (requestSignal) => {
      const cursor = this.#cursor;
      if (cursor === undefined) throw new TaskSearchError('stale', 'Task changed');
      validateInterval(offset, limit, cursor.total);
      const batch =
        offset === cursor.total
          ? undefined
          : await this.ports.search.read(cursor, offset, limit, requestSignal);
      this.#check(requestSignal);
      const hits = batch?.hits ?? [];
      if (batch !== undefined) validateRange(batch, cursor, offset, limit);
      const checked = await this.#eligibility(
        hits.map((hit) => hit.address),
        requestSignal,
      );
      this.#check(requestSignal);
      if (checked.generation !== cursor.generation)
        throw new TaskSearchError('stale', 'Task generation changed');
      if (checked.items.length !== hits.length)
        throw new TaskSearchError('unavailable', 'Missing dependency eligibility');
      const candidates = hits.map((hit, index) => {
        const item = checked.items[index];
        if (item === undefined || !sameAddress(item.address, hit.address))
          throw new TaskSearchError('unavailable', 'Invalid dependency eligibility');
        return { offset: offset + index, hit, eligibility: item.eligibility };
      });
      return { generation: cursor.generation, offset, candidates };
    });
  }

  options(
    candidates: readonly DependencyCandidate[],
    signal: AbortSignal,
  ): Promise<readonly DependencySearchOption[]> {
    return this.#operate(signal, async (requestSignal) => {
      const roots = demandedRoots(candidates);
      const options = new Map<number, DependencySearchOption>();
      let batch: DependencyCandidate[] = [];
      let rootCount = 0;
      const project = async (): Promise<void> => {
        if (batch.length === 0) return;
        const hydrated = await this.ports.search.resolveHits(
          batch.map((c) => c.hit),
          requestSignal,
        );
        this.#check(requestSignal);
        if (hydrated.length !== batch.length)
          throw new TaskSearchError('unavailable', 'Missing dependency labels');
        for (const [index, { hit, task }] of hydrated.entries()) {
          const candidate = batch[index];
          if (candidate === undefined || !sameAddress(candidate.hit.address, hit.address))
            throw new TaskSearchError('unavailable', 'Invalid dependency labels');
          const eligibility = candidate.eligibility;
          options.set(candidate.offset, {
            address: hit.address,
            offset: candidate.offset,
            title: task.node.title,
            context: `${task.root.source.filePath}:${taskNodeLine(task.root, task.node) + 1}`,
            directions: eligibility.type === 'allowed' ? [this.selection.direction] : [],
            ...(eligibility.type === 'rejected' && {
              disabledReason: rejectionLabel(eligibility.reason),
            }),
          });
        }
        batch = [];
        rootCount = 0;
      };
      for (const group of roots.values()) {
        if (batch.length + group.length > 200 || rootCount === 50) {
          await project();
          await this.ports.scheduler.yield(requestSignal);
          this.#check(requestSignal);
        }
        for (let start = 0; start < group.length; start += 200) {
          if (start > 0) {
            await project();
            await this.ports.scheduler.yield(requestSignal);
            this.#check(requestSignal);
          }
          batch.push(...group.slice(start, start + 200));
          rootCount++;
        }
      }
      await project();
      this.#check(requestSignal);
      return candidates.flatMap((candidate) => {
        const option = options.get(candidate.offset);
        return option === undefined ? [] : [option];
      });
    });
  }

  resolve(address: TaskSearchAddress, signal: AbortSignal): Promise<TaskNodeSnapshot> {
    return this.#operate(signal, async (requestSignal) => {
      const hydrated = await this.ports.search.resolveHits([{ address, score: 0 }], requestSignal);
      this.#check(requestSignal);
      const checked = await this.#eligibility([address], requestSignal);
      this.#check(requestSignal);
      const task = hydrated[0]?.task;
      if (
        task === undefined ||
        checked.generation !== this.generation ||
        checked.items[0]?.eligibility.type !== 'allowed' ||
        !sameAddress(checked.items[0].address, address)
      )
        throw new TaskSearchError('stale', 'Task changed');
      return task;
    });
  }
}

function sameAddress(left: TaskSearchAddress, right: TaskSearchAddress): boolean {
  return (
    left.epoch === right.epoch &&
    left.version === right.version &&
    left.rootId === right.rootId &&
    left.childLines.length === right.childLines.length &&
    left.childLines.every((line, index) => line === right.childLines[index])
  );
}

function validateInterval(offset: number, limit: number, total: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > total ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 200
  )
    throw new TaskSearchError('invalid-request', 'Invalid candidate interval');
}
function validateRange(
  batch: SearchBatch,
  cursor: SearchCursor,
  offset: number,
  limit: number,
): void {
  if (
    batch.cursor.id !== cursor.id ||
    batch.cursor.generation !== cursor.generation ||
    batch.cursor.total !== cursor.total ||
    batch.cursor.kind !== 'nodes' ||
    batch.cursor.access !== cursor.access
  )
    throw new TaskSearchError('unavailable', 'Invalid dependency cursor');
  if (
    batch.offset !== offset ||
    batch.hits.length !== Math.min(limit, cursor.total - offset) ||
    batch.done !== (offset + batch.hits.length === cursor.total)
  )
    throw new TaskSearchError('unavailable', 'Invalid dependency range');
}
function demandedRoots(
  candidates: readonly DependencyCandidate[],
): Map<string, DependencyCandidate[]> {
  const roots = new Map<string, DependencyCandidate[]>();
  for (const candidate of candidates) {
    if (
      candidate.eligibility.type === 'rejected' &&
      ['self', 'duplicate', 'inverse'].includes(candidate.eligibility.reason)
    )
      continue;
    const address = candidate.hit.address;
    const key = JSON.stringify([address.epoch, address.version, address.rootId]);
    const group = roots.get(key) ?? [];
    group.push(candidate);
    roots.set(key, group);
  }
  return roots;
}
