/** Result shape shared by guarded command adapters without coupling this UI store to an entity. */
export interface CommandResult {
  readonly type: string;
}

export interface OptimisticTransaction<TSnapshot, TPatch> {
  readonly id: number;
  readonly key: string;
  readonly observed: TSnapshot;
  readonly observedRevision: string;
  readonly patch: TPatch;
  readonly startedAt: number;
}

interface OptimisticOverlaySettlement {
  readonly transactionId: number;
  readonly message: string;
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
  observeCommandResult(key: string, result: TResult, transactionId: number): void;
  read(key: string): TSnapshot | undefined;
  cancel(key: string, reason: OptimisticRollbackReason, transactionId: number): void;
  active(key: string): OptimisticTransaction<TSnapshot, TPatch> | undefined;
  subscribe(listener: (settlement?: OptimisticOverlaySettlement) => void): () => void;
  configure(options: OptimisticOverlayStoreOptions<TSnapshot, TPatch, TResult>): void;
  dispose(): void;
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
  timerWindow?: Pick<Window, 'setTimeout' | 'clearTimeout'>;
  deadline?: number;
  matches?: (snapshot: TSnapshot, patch: TPatch) => boolean;
  isSuccess?: (result: CommandResult) => boolean;
}

const applicationStores = new WeakMap<object, Map<string, { dispose(): void }>>();

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
  if (reason === 'published') return 'Item moved. Undo available.';
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
  let currentOptions = options;
  let nextTransactionId = 0;
  const listeners = new Set<(settlement?: OptimisticOverlaySettlement) => void>();
  let settlementOwner: ((settlement?: OptimisticOverlaySettlement) => void) | undefined;
  const notify = (settlement?: OptimisticOverlaySettlement): void => {
    for (const listener of listeners)
      listener(listener === settlementOwner ? settlement : undefined);
  };

  const settle = (key: string, reason: OptimisticRollbackReason | 'published'): void => {
    const entry = entries.get(key);
    if (!entry?.transaction) return;
    if (entry.timeout !== undefined) entry.timerWindow?.clearTimeout(entry.timeout);
    entry.timeout = undefined;
    const transaction = entry.transaction;
    entry.transaction = undefined;
    entry.overlay = undefined;
    if (entry.announced) return;
    entry.announced = true;
    const message = announcement(reason);
    currentOptions.announce?.(message);
    notify({ transactionId: transaction.id, message });
  };

  const store: OptimisticOverlayStore<TSnapshot, TPatch, TResult> = {
    begin(observed, observedRevision, patch) {
      const key = currentOptions.keyOf(observed);
      const existing = entries.get(key);
      if (existing?.transaction) return existing.transaction;
      const now = currentOptions.now ?? Date.now;
      const frozenObserved = freezeSnapshot(observed);
      const transaction = Object.freeze({
        id: ++nextTransactionId,
        key,
        observed: frozenObserved,
        observedRevision,
        patch: freezeSnapshot(patch),
        startedAt: now(),
      });
      entries.set(key, {
        transaction,
        overlay: currentOptions.apply(frozenObserved, transaction.patch),
        canonical: frozenObserved,
        announced: false,
        matches: currentOptions.matches,
        isSuccess: currentOptions.isSuccess as (result: CommandResult) => boolean,
        timerWindow: currentOptions.timerWindow ?? window,
      });
      const entry = entries.get(key)!;
      const timeoutMs = Math.max(0, currentOptions.timeoutMs ?? 0);
      if (timeoutMs > 0) {
        entry.deadline = transaction.startedAt + timeoutMs;
        entry.timeout = entry.timerWindow!.setTimeout(
          () => store.cancel(key, 'timeout', transaction.id),
          timeoutMs,
        );
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
        entry.matches?.(snapshot, transaction.patch) === true
          ? 'published'
          : 'competing-publication',
      );
    },

    observeCommandResult(key, result, transactionId) {
      const entry = entries.get(key);
      if (!entry?.transaction || entry.transaction.id !== transactionId) return;
      if (entry.isSuccess?.(result)) return;
      const reason = rollbackReason(result);
      this.cancel(key, reason ?? 'io', entry.transaction.id);
      // A successful command is deliberately not settlement: wait for source publication.
    },

    read(key) {
      const entry = entries.get(key);
      return entry?.overlay ?? entry?.canonical;
    },

    cancel(key, reason, transactionId) {
      const entry = entries.get(key);
      if (!entry?.transaction || entry.transaction.id !== transactionId) return;
      entry.canonical ??= entry.transaction.observed;
      settle(key, reason);
    },

    active(key) {
      return entries.get(key)?.transaction;
    },

    subscribe(listener) {
      listeners.add(listener);
      settlementOwner = listener;
      return () => {
        listeners.delete(listener);
        if (settlementOwner === listener) {
          const active = [...listeners];
          settlementOwner = active[active.length - 1];
        }
      };
    },

    configure(next) {
      currentOptions = next;
      const now = currentOptions.now ?? Date.now;
      for (const entry of entries.values()) {
        const transaction = entry.transaction;
        if (!transaction || entry.deadline === undefined) continue;
        if (entry.timeout !== undefined) entry.timerWindow?.clearTimeout(entry.timeout);
        entry.timerWindow = currentOptions.timerWindow ?? window;
        entry.timeout = entry.timerWindow.setTimeout(
          () => store.cancel(transaction.key, 'timeout', transaction.id),
          Math.max(0, entry.deadline - now()),
        );
      }
    },

    dispose() {
      for (const entry of entries.values()) {
        if (entry.timeout !== undefined) entry.timerWindow?.clearTimeout(entry.timeout);
      }
      entries.clear();
      listeners.clear();
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
  if (existing) {
    existing.configure(options);
    return existing;
  }
  const created = createOptimisticOverlayStore(options);
  stores.set(name, created);
  return created;
}

/** Releases every named UI store for an application during plugin unload. */
export function disposeOptimisticOverlayStores(application: object): void {
  const stores = applicationStores.get(application);
  if (!stores) return;
  for (const store of stores.values()) store.dispose();
  applicationStores.delete(application);
}
