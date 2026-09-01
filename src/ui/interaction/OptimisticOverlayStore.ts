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
  readonly undoAvailable?: boolean;
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
  /** Atomically reconciles one complete canonical batch, including proven key successors. */
  observeCanonicalBatch(
    publications: readonly OptimisticCanonicalPublication<TSnapshot>[],
    sequence?: number,
    continuity?: (observed: TSnapshot, published: TSnapshot) => boolean,
  ): void;
  /** Reconciles one complete canonical batch; stale omissions cannot cancel newer authority. */
  reconcileCanonicalKeys(keys: ReadonlySet<string>, sequence?: number): void;
  observeCommandResult(key: string, result: TResult, transactionId: number, token: object): void;
  read(key: string): TSnapshot | undefined;
  cancel(key: string, reason: OptimisticRollbackReason, transactionId: number, token: object): void;
  active(key: string): OptimisticTransaction<TSnapshot, TPatch> | undefined;
  subscribe(
    listener: (settlement?: OptimisticOverlaySettlement) => void,
    owner?: OptimisticOverlayOwner,
  ): () => void;
  configure(options: OptimisticOverlayStoreOptions<TSnapshot, TPatch, TResult>): void;
  dispose(): void;
}

interface OptimisticCanonicalPublication<TSnapshot> {
  readonly key: string;
  readonly snapshot: TSnapshot;
  readonly revision: string;
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
  readonly token: object;
  key: string;
  transaction?: OptimisticTransaction<TSnapshot, TPatch>;
  overlay?: TSnapshot;
  canonical?: TSnapshot;
  timeout?: ReturnType<Window['setTimeout']>;
  lastPublicationSequence?: number;
  deadline?: number;
  matches?: (snapshot: TSnapshot, patch: TPatch) => boolean;
  isSuccess?: (result: CommandResult) => boolean;
  ownerId?: string;
  undoAvailable?: boolean;
  commandSucceeded?: boolean;
  publicationMatched?: boolean;
}

const applicationStores = new WeakMap<object, Map<string, { dispose(): void }>>();
const applicationPublicationSequences = new WeakMap<object, number>();

/** Allocates one source-batch watermark shared by every pane and entity store in an application. */
export function nextOptimisticPublicationSequence(application: object): number {
  const sequence = (applicationPublicationSequences.get(application) ?? 0) + 1;
  applicationPublicationSequences.set(application, sequence);
  return sequence;
}

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

function announcement(
  reason: OptimisticRollbackReason | 'published',
  undoAvailable: boolean | undefined,
): string {
  if (reason === 'published')
    return undoAvailable === true ? 'Item moved. Undo available.' : 'Item moved.';
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
  const entriesByToken = new Map<object, Entry<TSnapshot, TPatch>>();
  const keyToToken = new Map<string, object>();
  let currentOptions = options;
  // The scheduler is application-owned. configure() is allowed to refresh semantic
  // functions for future transactions, but never moves an in-flight timeout.
  const scheduler = options.timerWindow ?? window;
  let nextTransactionId = 0;
  let nextPublicationSequence = 0;
  let lastCompletePublicationSequence: number | undefined;
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

  const entryForKey = (key: string): Entry<TSnapshot, TPatch> | undefined => {
    const token = keyToToken.get(key);
    return token === undefined ? undefined : entriesByToken.get(token);
  };

  const removeEntry = (entry: Entry<TSnapshot, TPatch>): void => {
    if (entry.timeout !== undefined) scheduler.clearTimeout(entry.timeout);
    entriesByToken.delete(entry.token);
    for (const [key, token] of keyToToken) if (token === entry.token) keyToToken.delete(key);
  };

  const bindKey = (entry: Entry<TSnapshot, TPatch>, key: string): boolean => {
    const occupant = entryForKey(key);
    if (occupant && occupant !== entry && occupant.transaction) return false;
    if (occupant && occupant !== entry) removeEntry(occupant);
    for (const [candidate, token] of keyToToken) {
      if (token === entry.token) keyToToken.delete(candidate);
    }
    entry.key = key;
    keyToToken.set(key, entry.token);
    return true;
  };

  const settle = (
    entry: Entry<TSnapshot, TPatch>,
    reason: OptimisticRollbackReason | 'published',
    remove = false,
  ): void => {
    if (!entry?.transaction) return;
    if (entry.timeout !== undefined) scheduler.clearTimeout(entry.timeout);
    entry.timeout = undefined;
    const transaction = entry.transaction;
    entry.transaction = undefined;
    entry.overlay = undefined;
    entry.commandSucceeded = undefined;
    entry.publicationMatched = undefined;
    if (remove) removeEntry(entry);
    const message = announcement(reason, entry.undoAvailable);
    const owner = ownerFor(entry.ownerId);
    // Direct stores retain their explicit callback; application stores use a current,
    // mounted owner so a dead popout can never receive the terminal announcement.
    (owner?.announce ?? (entry.ownerId ? undefined : currentOptions.announce))?.(message);
    notify(
      { transactionId: transaction.id, message, reason, published: reason === 'published' },
      owner?.id,
    );
  };

  const nextSequence = (supplied?: number): number => {
    if (supplied === undefined) return ++nextPublicationSequence;
    nextPublicationSequence = Math.max(nextPublicationSequence, supplied);
    return supplied;
  };

  const acceptCompleteSequence = (supplied?: number): number | undefined => {
    const sequence = nextSequence(supplied);
    if (
      lastCompletePublicationSequence !== undefined &&
      sequence <= lastCompletePublicationSequence
    )
      return undefined;
    lastCompletePublicationSequence = sequence;
    return sequence;
  };

  const observeEntryPublication = (
    entry: Entry<TSnapshot, TPatch>,
    publication: OptimisticCanonicalPublication<TSnapshot>,
    sequence: number,
    relocated: boolean,
  ): void => {
    if (entry.lastPublicationSequence !== undefined && sequence <= entry.lastPublicationSequence)
      return;
    entry.lastPublicationSequence = sequence;
    const transaction = entry.transaction;
    if (!transaction) {
      entry.canonical = publication.snapshot;
      return;
    }
    // Repeating the same logical source observation is a remount, not publication
    // evidence for the command. A proven relocation is evidence even when the source
    // revision is preserved by a rename or line shift.
    if (!relocated && publication.revision === transaction.observedRevision) return;
    entry.canonical = publication.snapshot;
    if (entry.matches?.(publication.snapshot, transaction.patch) !== true) {
      settle(entry, 'competing-publication');
      return;
    }
    entry.publicationMatched = true;
    if (entry.commandSucceeded) settle(entry, 'published');
  };

  const createCanonicalEntry = (
    publication: OptimisticCanonicalPublication<TSnapshot>,
    sequence: number,
  ): Entry<TSnapshot, TPatch> => {
    const token = Object.freeze({});
    const entry: Entry<TSnapshot, TPatch> = {
      token,
      key: publication.key,
      canonical: publication.snapshot,
      lastPublicationSequence: sequence,
    };
    entriesByToken.set(token, entry);
    keyToToken.set(publication.key, token);
    return entry;
  };

  const observeSingle = (
    publication: OptimisticCanonicalPublication<TSnapshot>,
    sequence: number,
    continuity?: (observed: TSnapshot, published: TSnapshot) => boolean,
  ): void => {
    let entry = entryForKey(publication.key);
    let relocated = false;
    if (
      entry?.transaction &&
      continuity &&
      (entry.lastPublicationSequence === undefined || sequence > entry.lastPublicationSequence) &&
      !continuity(entry.transaction.observed, publication.snapshot)
    ) {
      settle(entry, 'competing-publication', true);
      createCanonicalEntry(publication, sequence);
      return;
    }
    if (!entry && continuity) {
      const candidates = [...entriesByToken.values()].filter(
        (candidate) =>
          candidate.transaction && continuity(candidate.transaction.observed, publication.snapshot),
      );
      if (candidates.length === 1) {
        entry = candidates[0];
        relocated = entry?.key !== publication.key;
        if (entry && !bindKey(entry, publication.key)) entry = undefined;
      }
    }
    if (!entry) {
      createCanonicalEntry(publication, sequence);
      return;
    }
    observeEntryPublication(entry, publication, sequence, relocated);
  };

  const cleanupMissingKeys = (keys: ReadonlySet<string>, sequence: number): void => {
    for (const [key, token] of [...keyToToken]) {
      if (keys.has(key)) continue;
      const entry = entriesByToken.get(token);
      if (!entry) {
        keyToToken.delete(key);
        continue;
      }
      if (entry.lastPublicationSequence !== undefined && sequence <= entry.lastPublicationSequence)
        continue;
      entry.lastPublicationSequence = sequence;
      if (entry.transaction) settle(entry, 'competing-publication', true);
      else removeEntry(entry);
    }
  };

  const pruneBlockedSuccessors = (
    proposals: Map<Entry<TSnapshot, TPatch>, OptimisticCanonicalPublication<TSnapshot>>,
  ): void => {
    let changed = true;
    while (changed) {
      changed = false;
      const moving = new Set(
        [...proposals]
          .filter(([entry, publication]) => entry.key !== publication.key)
          .map(([entry]) => entry),
      );
      for (const [entry, publication] of [...proposals]) {
        const occupant = entryForKey(publication.key);
        if (occupant?.transaction && occupant !== entry && !moving.has(occupant)) {
          proposals.delete(entry);
          changed = true;
        }
      }
    }
  };

  const successorProposals = (
    batch: readonly OptimisticCanonicalPublication<TSnapshot>[],
    byKey: ReadonlyMap<string, OptimisticCanonicalPublication<TSnapshot>>,
    sequence: number,
    continuity?: (observed: TSnapshot, published: TSnapshot) => boolean,
  ): Map<Entry<TSnapshot, TPatch>, OptimisticCanonicalPublication<TSnapshot>> => {
    const proposals = new Map<
      Entry<TSnapshot, TPatch>,
      OptimisticCanonicalPublication<TSnapshot>
    >();
    const active = [...entriesByToken.values()].filter(
      (entry) =>
        entry.transaction &&
        (entry.lastPublicationSequence === undefined || sequence > entry.lastPublicationSequence),
    );
    for (const entry of active) {
      const successors = continuity
        ? batch.filter((publication) =>
            continuity(entry.transaction!.observed, publication.snapshot),
          )
        : [];
      let publication: OptimisticCanonicalPublication<TSnapshot> | undefined;
      if (continuity) {
        if (successors.length === 1) publication = successors[0];
      } else publication = byKey.get(entry.key);
      if (publication) proposals.set(entry, publication);
    }
    const targetCounts = new Map<string, number>();
    for (const publication of proposals.values()) {
      targetCounts.set(publication.key, (targetCounts.get(publication.key) ?? 0) + 1);
    }
    for (const [entry, publication] of [...proposals]) {
      if ((targetCounts.get(publication.key) ?? 0) !== 1) proposals.delete(entry);
    }
    pruneBlockedSuccessors(proposals);
    return proposals;
  };

  const relocatedSuccessorTargets = (
    batch: readonly OptimisticCanonicalPublication<TSnapshot>[],
    continuity?: (observed: TSnapshot, published: TSnapshot) => boolean,
  ): ReadonlySet<string> => {
    const targets = new Set<string>();
    if (!continuity) return targets;
    for (const entry of entriesByToken.values()) {
      if (!entry.transaction) continue;
      for (const publication of batch) {
        if (
          entry.key !== publication.key &&
          continuity(entry.transaction.observed, publication.snapshot)
        ) {
          targets.add(publication.key);
        }
      }
    }
    return targets;
  };

  const rebindSuccessors = (
    proposals: ReadonlyMap<Entry<TSnapshot, TPatch>, OptimisticCanonicalPublication<TSnapshot>>,
  ): ReadonlySet<string> => {
    // Remove every predecessor binding first so overlapping shifts (1→2, 2→3)
    // cannot overwrite another live transaction during rebinding.
    for (const [entry, publication] of proposals) {
      if (entry.key !== publication.key && keyToToken.get(entry.key) === entry.token) {
        keyToToken.delete(entry.key);
      }
    }
    const claimed = new Set<string>();
    for (const [entry, publication] of proposals) {
      const occupant = entryForKey(publication.key);
      if (occupant && occupant !== entry && !occupant.transaction) removeEntry(occupant);
      entry.key = publication.key;
      keyToToken.set(publication.key, entry.token);
      claimed.add(publication.key);
    }
    return claimed;
  };

  const store: OptimisticOverlayStore<TSnapshot, TPatch, TResult> = {
    begin(observed, observedRevision, patch, owner) {
      const key = currentOptions.keyOf(observed);
      const existing = entryForKey(key);
      if (existing?.transaction) return existing.transaction;
      const now = currentOptions.now ?? Date.now;
      const frozenObserved = freezeSnapshot(observed);
      const token = Object.freeze({});
      const transaction = Object.freeze({
        id: ++nextTransactionId,
        key,
        observed: frozenObserved,
        observedRevision,
        patch: freezeSnapshot(patch),
        startedAt: now(),
        token,
      });
      if (existing) removeEntry(existing);
      const entry: Entry<TSnapshot, TPatch> = {
        token,
        key,
        transaction,
        overlay: currentOptions.apply(frozenObserved, transaction.patch),
        canonical: frozenObserved,
        matches: currentOptions.matches,
        isSuccess: currentOptions.isSuccess as (result: CommandResult) => boolean,
        ownerId: owner?.id,
        undoAvailable: owner?.undoAvailable,
        // Preserve the source watermark across consecutive transactions on one
        // logical entity. Otherwise an old r1 arriving after tx2 could be accepted.
        lastPublicationSequence: existing?.lastPublicationSequence,
      };
      entriesByToken.set(token, entry);
      keyToToken.set(key, token);
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
      observeSingle({ key, snapshot, revision }, nextSequence(suppliedSequence), continuity);
    },

    observeCanonicalBatch(publications, suppliedSequence, continuity) {
      const sequence = acceptCompleteSequence(suppliedSequence);
      if (sequence === undefined) return;
      const byKey = new Map(publications.map((publication) => [publication.key, publication]));
      const batch = [...byKey.values()];
      const successorTargets = relocatedSuccessorTargets(batch, continuity);
      const proposals = successorProposals(batch, byKey, sequence, continuity);
      const claimed = rebindSuccessors(proposals);
      for (const [entry, publication] of proposals) {
        observeEntryPublication(
          entry,
          publication,
          sequence,
          publication.key !== entry.transaction?.key,
        );
      }
      for (const publication of batch) {
        if (claimed.has(publication.key)) continue;
        const entry = entryForKey(publication.key);
        const proofCandidates =
          entry?.transaction && continuity
            ? batch.filter((candidate) =>
                continuity(entry.transaction!.observed, candidate.snapshot),
              )
            : [];
        const exactProof =
          continuity === undefined ||
          (proofCandidates.length === 1 && proofCandidates[0] === publication);
        if (entry?.transaction && (!exactProof || successorTargets.has(publication.key))) {
          settle(entry, 'competing-publication', true);
          createCanonicalEntry(publication, sequence);
        } else if (entry) observeEntryPublication(entry, publication, sequence, false);
        else createCanonicalEntry(publication, sequence);
      }
      cleanupMissingKeys(new Set(byKey.keys()), sequence);
    },

    observeCommandResult(_key, result, transactionId, token) {
      const entry = entriesByToken.get(token);
      if (
        !entry?.transaction ||
        entry.transaction.id !== transactionId ||
        entry.transaction.token !== token
      )
        return;
      if (entry.isSuccess?.(result)) {
        entry.commandSucceeded = true;
        if (entry.publicationMatched) settle(entry, 'published');
        return;
      }
      const reason = rollbackReason(result);
      settle(entry, reason ?? 'io');
    },

    read(key) {
      const entry = entryForKey(key);
      return entry?.overlay ?? entry?.canonical;
    },

    cancel(_key, reason, transactionId, token) {
      const entry = entriesByToken.get(token);
      if (
        !entry?.transaction ||
        entry.transaction.id !== transactionId ||
        entry.transaction.token !== token
      )
        return;
      entry.canonical ??= entry.transaction.observed;
      settle(entry, reason);
    },

    active(key) {
      return entryForKey(key)?.transaction;
    },

    reconcileCanonicalKeys(keys, suppliedSequence) {
      const sequence = acceptCompleteSequence(suppliedSequence);
      if (sequence !== undefined) cleanupMissingKeys(keys, sequence);
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
      for (const entry of entriesByToken.values()) {
        if (entry.timeout !== undefined) scheduler.clearTimeout(entry.timeout);
      }
      entriesByToken.clear();
      keyToToken.clear();
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
  applicationPublicationSequences.delete(application);
}
