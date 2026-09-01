/** Result shape shared by guarded command adapters without coupling this UI store to an entity. */
export interface CommandResult {
  readonly type: string;
}

export interface OptimisticTransaction<TSnapshot, TPatch> {
  readonly key: string;
  readonly observed: TSnapshot;
  readonly observedRevision: string;
  readonly patch: TPatch;
  readonly startedAt: number;
}

export interface OptimisticOverlayStore<
  TSnapshot,
  TPatch,
  TResult extends CommandResult = CommandResult,
> {
  begin(
    observed: TSnapshot,
    observedRevision: string,
    patch: TPatch,
  ): OptimisticTransaction<TSnapshot, TPatch>;
  observePublication(key: string, snapshot: TSnapshot, revision: string): void;
  observeCommandResult(key: string, result: TResult): void;
  read(key: string): TSnapshot | undefined;
  cancel(key: string, reason: OptimisticRollbackReason): void;
  subscribe(listener: () => void): () => void;
}

type OptimisticRollbackReason = 'conflict' | 'io' | 'timeout' | 'competing-publication';

export interface OptimisticOverlayStoreOptions<
  TSnapshot,
  TPatch,
  TResult extends CommandResult = CommandResult,
> {
  readonly keyOf: (snapshot: TSnapshot) => string;
  readonly apply: (observed: TSnapshot, patch: TPatch) => TSnapshot;
  readonly matches: (snapshot: TSnapshot, patch: TPatch) => boolean;
  readonly isSuccess: (result: TResult) => boolean;
  /** Emits exactly one settlement result per transaction. */
  readonly announce?: (message: string) => void;
  /** Source publication deadline; a timeout only removes this UI projection. */
  readonly timeoutMs?: number;
  /** Owning document window; callers in popouts provide that window explicitly. */
  readonly timerWindow?: Pick<Window, 'setTimeout' | 'clearTimeout'>;
  readonly now?: () => number;
}

interface Entry<TSnapshot, TPatch> {
  transaction?: OptimisticTransaction<TSnapshot, TPatch>;
  overlay?: TSnapshot;
  canonical?: TSnapshot;
  announced: boolean;
  timeout?: ReturnType<Window['setTimeout']>;
}

const applicationStores = new WeakMap<
  object,
  Map<string, OptimisticOverlayStore<unknown, unknown>>
>();

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function freezeSnapshot<T>(value: T): T {
  return value !== null && typeof value === 'object' ? deepFreeze(structuredClone(value)) : value;
}

function rollbackReason(result: CommandResult): OptimisticRollbackReason | undefined {
  if (result.type === 'conflict' || result.type === 'compatibility-conflict') return 'conflict';
  if (result.type === 'timeout') return 'timeout';
  if (result.type === 'io-error' || result.type === 'failure') return 'io';
  return undefined;
}

function announcement(reason: OptimisticRollbackReason | 'published'): string {
  if (reason === 'published') return 'Item moved';
  if (reason === 'conflict') return 'Item changed outside the board';
  if (reason === 'timeout') return 'Item move timed out';
  if (reason === 'competing-publication') return 'Item changed outside the board';
  return 'Item could not be moved';
}

/**
 * Application-owned optimistic projection. It never writes an entity: commands and
 * canonical source publications remain the data authorities.
 */
export function createOptimisticOverlayStore<
  TSnapshot,
  TPatch,
  TResult extends CommandResult = CommandResult,
>(
  options: OptimisticOverlayStoreOptions<TSnapshot, TPatch, TResult>,
): OptimisticOverlayStore<TSnapshot, TPatch, TResult> {
  const entries = new Map<string, Entry<TSnapshot, TPatch>>();
  const now = options.now ?? Date.now;
  const timeoutMs = Math.max(0, options.timeoutMs ?? 0);
  const timerWindow = options.timerWindow ?? window;
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const settle = (key: string, reason: OptimisticRollbackReason | 'published'): void => {
    const entry = entries.get(key);
    if (!entry?.transaction) return;
    if (entry.timeout !== undefined) timerWindow.clearTimeout(entry.timeout);
    entry.timeout = undefined;
    entry.transaction = undefined;
    entry.overlay = undefined;
    if (entry.announced) return;
    entry.announced = true;
    options.announce?.(announcement(reason));
    notify();
  };

  const store: OptimisticOverlayStore<TSnapshot, TPatch, TResult> = {
    begin(observed, observedRevision, patch) {
      const key = options.keyOf(observed);
      const existing = entries.get(key);
      if (existing?.transaction) return existing.transaction;
      const frozenObserved = freezeSnapshot(observed);
      const transaction = Object.freeze({
        key,
        observed: frozenObserved,
        observedRevision,
        patch: freezeSnapshot(patch),
        startedAt: now(),
      });
      entries.set(key, {
        transaction,
        overlay: options.apply(frozenObserved, transaction.patch),
        canonical: frozenObserved,
        announced: false,
      });
      const entry = entries.get(key)!;
      if (timeoutMs > 0) {
        entry.timeout = timerWindow.setTimeout(() => store.cancel(key, 'timeout'), timeoutMs);
      }
      return transaction;
    },

    observePublication(key, snapshot, revision) {
      const entry = entries.get(key);
      if (!entry) {
        entries.set(key, { canonical: snapshot, announced: false });
        return;
      }
      const transaction = entry.transaction;
      if (!transaction) {
        entry.canonical = snapshot;
        return;
      }
      // A remount often repeats the exact source observation. It cannot settle our write.
      if (revision === transaction.observedRevision) return;
      entry.canonical = snapshot;
      settle(
        key,
        options.matches(snapshot, transaction.patch) ? 'published' : 'competing-publication',
      );
    },

    observeCommandResult(key, result) {
      if (options.isSuccess(result)) return;
      const reason = rollbackReason(result);
      this.cancel(key, reason ?? 'io');
      // A successful command is deliberately not settlement: wait for source publication.
    },

    read(key) {
      const entry = entries.get(key);
      return entry?.overlay ?? entry?.canonical;
    },

    cancel(key, reason) {
      const entry = entries.get(key);
      if (!entry?.transaction) return;
      entry.canonical ??= entry.transaction.observed;
      settle(key, reason);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return store;
}

/** Returns the single named presentation store owned by an application instance. */
export function optimisticOverlayStoreFor<
  TSnapshot,
  TPatch,
  TResult extends CommandResult = CommandResult,
>(
  application: object,
  name: string,
  options: OptimisticOverlayStoreOptions<TSnapshot, TPatch, TResult>,
): OptimisticOverlayStore<TSnapshot, TPatch, TResult> {
  let stores = applicationStores.get(application);
  if (!stores) {
    stores = new Map();
    applicationStores.set(application, stores);
  }
  const existing = stores.get(name) as
    | OptimisticOverlayStore<TSnapshot, TPatch, TResult>
    | undefined;
  if (existing) return existing;
  const created = createOptimisticOverlayStore(options);
  stores.set(name, created);
  return created;
}
