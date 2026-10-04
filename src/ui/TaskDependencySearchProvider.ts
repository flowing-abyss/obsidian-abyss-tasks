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

export interface DependencyCandidatePage {
  readonly startOffset: number;
  readonly nextOffset: number;
  readonly totalCandidates: number;
  readonly options: readonly DependencySearchOption[];
  readonly hasMore: boolean;
  readonly budgetExhausted: boolean;
}
export interface TaskDependencySearchSession {
  page(offset: number, signal: AbortSignal): Promise<DependencyCandidatePage>;
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
interface IncludedCandidate {
  readonly hit: TaskSearchHit;
  readonly eligibility: TaskDependencyEligibility;
  readonly offset: number;
}

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
    const controller = new AbortController();
    this.#pending = controller;
    const abort = (): void => {
      controller.abort();
    };
    signal.addEventListener('abort', abort, { once: true });
    this.#controller.signal.addEventListener('abort', abort, { once: true });
    try {
      this.#check(signal);
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

  page(offset: number, signal: AbortSignal): Promise<DependencyCandidatePage> {
    return this.#operate(signal, (requestSignal) => this.#page(offset, requestSignal));
  }

  async #page(offset: number, signal: AbortSignal): Promise<DependencyCandidatePage> {
    const cursor = this.#cursor;
    if (cursor === undefined) throw new TaskSearchError('stale', 'Task changed');
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > cursor.total)
      throw new TaskSearchError('invalid-request', 'Invalid candidate offset');
    if (offset === cursor.total) {
      const eligibility = await this.#eligibility([], signal);
      this.#check(signal);
      if (eligibility.generation !== cursor.generation)
        throw new TaskSearchError('stale', 'Task generation changed');
    }
    const { included, nextOffset, evaluated } = await this.#scan(cursor, offset, signal);
    const options = await this.#hydrate(included, signal);
    this.#check(signal);
    const hasMore = nextOffset < cursor.total;
    return {
      startOffset: offset,
      nextOffset,
      totalCandidates: cursor.total,
      options,
      hasMore,
      budgetExhausted: hasMore && included.length < 30 && evaluated >= 90,
    };
  }

  async #scan(
    cursor: SearchCursor,
    offset: number,
    signal: AbortSignal,
  ): Promise<{
    readonly included: IncludedCandidate[];
    readonly nextOffset: number;
    readonly evaluated: number;
  }> {
    const included: IncludedCandidate[] = [];
    let nextOffset = offset;
    let evaluated = 0;
    while (nextOffset < cursor.total && included.length < 30 && evaluated < 90) {
      const batch = await this.ports.search.read(cursor, nextOffset, 30, signal);
      this.#check(signal);
      if (batch.hits.length === 0)
        throw new TaskSearchError('unavailable', 'Missing dependency candidates');
      const eligibility = await this.#eligibility(
        batch.hits.map((hit) => hit.address),
        signal,
      );
      this.#check(signal);
      if (eligibility.generation !== cursor.generation)
        throw new TaskSearchError('stale', 'Task generation changed');
      evaluated += batch.hits.length;
      nextOffset += this.#include(batch.hits, eligibility, included, nextOffset);
      await this.ports.scheduler.yield(signal);
      this.#check(signal);
    }
    return { included, nextOffset, evaluated };
  }

  #include(
    hits: readonly TaskSearchHit[],
    batch: TaskSearchEligibilityBatch,
    included: IncludedCandidate[],
    offset: number,
  ): number {
    let consumed = 0;
    for (const [index, hit] of hits.entries()) {
      const item = batch.items[index];
      if (item === undefined)
        throw new TaskSearchError('unavailable', 'Missing dependency eligibility');
      consumed++;
      if (
        item.eligibility.type === 'allowed' ||
        !['self', 'duplicate', 'inverse'].includes(item.eligibility.reason)
      )
        included.push({ hit, eligibility: item.eligibility, offset: offset + index });
      if (included.length === 30) break;
    }
    return consumed;
  }

  async #hydrate(
    included: readonly IncludedCandidate[],
    signal: AbortSignal,
  ): Promise<readonly DependencySearchOption[]> {
    if (included.length === 0) return [];
    const hydrated = await this.ports.search.resolvePage(
      included.map(({ hit }) => hit),
      signal,
    );
    this.#check(signal);
    return hydrated.map(({ hit, task }, index) => {
      const candidate = included[index];
      if (candidate === undefined)
        throw new TaskSearchError('unavailable', 'Missing dependency eligibility');
      const eligibility = candidate.eligibility;
      return {
        address: hit.address,
        offset: candidate.offset,
        task,
        title: task.node.title,
        context: `${task.root.source.filePath}:${taskNodeLine(task.root, task.node) + 1}`,
        directions: eligibility.type === 'allowed' ? [this.selection.direction] : [],
        ...(eligibility.type === 'rejected' && {
          disabledReason: rejectionLabel(eligibility.reason),
        }),
      };
    });
  }

  resolve(address: TaskSearchAddress, signal: AbortSignal): Promise<TaskNodeSnapshot> {
    return this.#operate(signal, async (requestSignal) => {
      const hydrated = await this.ports.search.resolvePage([{ address, score: 0 }], requestSignal);
      this.#check(requestSignal);
      const checked = await this.#eligibility([address], requestSignal);
      this.#check(requestSignal);
      const task = hydrated[0]?.task;
      if (task === undefined || checked.items[0]?.eligibility.type !== 'allowed')
        throw new TaskSearchError('stale', 'Task changed');
      return task;
    });
  }
}
