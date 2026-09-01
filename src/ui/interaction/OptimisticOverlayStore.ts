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
  /** Immutable command correlation. A late result from another move is ignored. */
  readonly token: object;
}

interface OptimisticOverlaySettlement {
  readonly transactionId: number;
  readonly message: string;
  readonly reason: OptimisticRollbackReason | 'published';
  /** A success is undoable only after its matching canonical publication. */
  readonly published: boolean;
}

interface OptimisticOverlayOwner {
  /** Stable for one mounted board, never a DOM/window identity. */
  readonly id: string;
  readonly announce?: (message: string) => void;
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
    owner?: OptimisticOverlayOwner,
  ): OptimisticTransaction<TSnapshot, TPatch>;
  /** sequence must be monotonic for a canonical source; stale publications are ignored. */
  observePublication(
    key: string,
    snapshot: TSnapshot,
    revision: string,
    sequence?: number,
    continuity?: (observed: TSnapshot, published: TSnapshot) => boolean,
  ): void;
  observeCommandResult(key: string, result: TResult, transactionId: number, token?: object): void;
  read(key: string): TSnapshot | undefined;
  cancel(
    key: string,
    reason: OptimisticRollbackReason,
    transactionId: number,
    token?: object,
  ): void;
  active(key: string): OptimisticTransaction<TSnapshot, TPatch> | undefined;
  subscribe(
    listener: (settlement?: OptimisticOverlaySettlement) => void,
    owner?: OptimisticOverlayOwner,
  ): () => void;
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
  /**
   * Scheduler chosen when the application store is created. It is intentionally never
   * replaced by a remounted pane or popout window.
   */
  readonly timerWindow?: Pick<Window, 'setTimeout' | 'clearTimeout'>;
  readonly now?: () => number;
}

interface Entry<TSnapshot, TPatch> {
  transaction?: OptimisticTransaction<TSnapshot, TPatch>;
  overlay?: TSnapshot;
  canonical?: TSnapshot;
  announced: boolean;
  timeout?: ReturnType<Window['setTimeout']>;
  lastPublicationSequence?: number;
  deadline?: number;
  matches?: (snapshot: TSnapshot, patch: TPatch) => boolean;
  isSuccess?: (result: CommandResult) => boolean;
  ownerId?: string;
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
  // The scheduler is application-owned. configure() is allowed to refresh semantic
  // functions for future transactions, but never moves an in-flight timeout.
  const scheduler = options.timerWindow ?? window;
  let nextTransactionId = 0;
  let nextPublicationSequence = 0;
  const listeners = new Map<
    (settlement?: OptimisticOverlaySettlement) => void,
    OptimisticOverlayOwner | undefined
  >();
  const notify = (settlement?: OptimisticOverlaySettlement, ownerId?: string): void => {
    for (const [listener, owner] of listeners) {
      listener(settlement && owner?.id === ownerId ? settlement : undefined);
    }
  };

  const ownerFor = (preferred?: string): OptimisticOverlayOwner | undefined => {
    if (preferred) {
      for (const owner of listeners.values()) if (owner?.id === preferred) return owner;
    }
    // Deterministic fallback: most recently registered live mount, never a closed pane.
    const active = [...listeners.values()].filter(
      (owner): owner is OptimisticOverlayOwner => !!owner,
    );
    return active[active.length - 1];
  };

  const settle = (key: string, reason: OptimisticRollbackReason | 'published'): void => {
    const entry = entries.get(key);
    if (!entry?.transaction) return;
    if (entry.timeout !== undefined) scheduler.clearTimeout(entry.timeout);
    entry.timeout = undefined;
    const transaction = entry.transaction;
    entry.transaction = undefined;
    entry.overlay = undefined;
    if (entry.announced) return;
    entry.announced = true;
    const message = announcement(reason);
    const owner = ownerFor(entry.ownerId);
    // Direct stores retain their explicit callback; application stores use a current,
    // mounted owner so a dead popout can never receive the terminal announcement.
    (owner?.announce ?? (entry.ownerId ? undefined : currentOptions.announce))?.(message);
    notify(
      { transactionId: transaction.id, message, reason, published: reason === 'published' },
      owner?.id,
    );
  };

  const store: OptimisticOverlayStore<TSnapshot, TPatch, TResult> = {
    begin(observed, observedRevision, patch, owner) {
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
        token: Object.freeze({}),
      });
      entries.set(key, {
        transaction,
        overlay: currentOptions.apply(frozenObserved, transaction.patch),
        canonical: frozenObserved,
        announced: false,
        matches: currentOptions.matches,
        isSuccess: currentOptions.isSuccess as (result: CommandResult) => boolean,
        ownerId: owner?.id,
        // Preserve the source watermark across consecutive transactions on one
        // logical entity. Otherwise an old r1 arriving after tx2 could be accepted.
        lastPublicationSequence: existing?.lastPublicationSequence,
      });
      const entry = entries.get(key)!;
      const timeoutMs = Math.max(0, currentOptions.timeoutMs ?? 0);
      if (timeoutMs > 0) {
        entry.deadline = transaction.startedAt + timeoutMs;
        entry.timeout = scheduler.setTimeout(
          () => store.cancel(key, 'timeout', transaction.id, transaction.token),
          timeoutMs,
        );
      }
      return transaction;
    },

    observePublication(key, snapshot, revision, suppliedSequence, continuity) {
      const sequence = suppliedSequence ?? ++nextPublicationSequence;
      let entry = entries.get(key);
      // A TaskRef may receive a proven successor after a status write, line shift or
      // rename. Rebind only when the entity adapter supplies that authoritative proof;
      // never guess by title, path, or a stale line number.
      if (!entry && continuity) {
        const previous = [...entries.entries()].find(
          ([, candidate]) =>
            candidate.transaction && continuity(candidate.transaction.observed, snapshot),
        );
        if (previous) {
          entry = previous[1];
          entries.set(key, entry);
        }
      }
      if (!entry) {
        entries.set(key, {
          canonical: snapshot,
          announced: false,
          lastPublicationSequence: sequence,
        });
        return;
      }
      if (entry.lastPublicationSequence !== undefined && sequence <= entry.lastPublicationSequence)
        return;
      entry.lastPublicationSequence = sequence;
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

    observeCommandResult(key, result, transactionId, token) {
      const entry = entries.get(key);
      if (
        !entry?.transaction ||
        entry.transaction.id !== transactionId ||
        (token !== undefined && entry.transaction.token !== token)
      )
        return;
      if (entry.isSuccess?.(result)) return;
      const reason = rollbackReason(result);
      this.cancel(key, reason ?? 'io', entry.transaction.id, entry.transaction.token);
      // A successful command is deliberately not settlement: wait for source publication.
    },

    read(key) {
      const entry = entries.get(key);
      return entry?.overlay ?? entry?.canonical;
    },

    cancel(key, reason, transactionId, token) {
      const entry = entries.get(key);
      if (
        !entry?.transaction ||
        entry.transaction.id !== transactionId ||
        (token !== undefined && entry.transaction.token !== token)
      )
        return;
      entry.canonical ??= entry.transaction.observed;
      settle(key, reason);
    },

    active(key) {
      return entries.get(key)?.transaction;
    },

    subscribe(listener, owner) {
      listeners.set(listener, owner);
      return () => {
        listeners.delete(listener);
      };
    },

    configure(next) {
      currentOptions = next;
    },

    dispose() {
      for (const entry of entries.values()) {
        if (entry.timeout !== undefined) scheduler.clearTimeout(entry.timeout);
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
