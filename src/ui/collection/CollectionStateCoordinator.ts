import type { CollectionSessionState, PersistedCollectionPreference } from '../../settings/types';

export type CollectionScopeKey =
  | 'tasks:main'
  | 'projects:portfolio'
  | `project:${string}:tasks`
  | `project:${string}:work-notes`;

export interface CollectionPreferenceSnapshot<TPreference> {
  /** Opaque persistence identity pinned when this snapshot was read. */
  readonly persistenceIdentity: string;
  readonly revision: number;
  readonly preference: TPreference;
}

export class CollectionPreferenceConflictError extends Error {
  constructor() {
    super('collection preference revision conflict');
    this.name = 'CollectionPreferenceConflictError';
  }
}

export interface CollectionPreferencePort<TPreference> {
  read(scope: CollectionScopeKey): CollectionPreferenceSnapshot<TPreference>;
  update(
    scope: CollectionScopeKey,
    expected: CollectionPreferenceSnapshot<TPreference>,
    next: TPreference,
  ): Promise<CollectionPreferenceSnapshot<TPreference>>;
  subscribe(
    scope: CollectionScopeKey,
    listener: (next: CollectionPreferenceSnapshot<TPreference>) => void,
  ): () => void;
}

export interface CollectionSessionPort {
  read(instanceKey: string): CollectionSessionState;
  update(instanceKey: string, next: CollectionSessionState): void;
  subscribe(instanceKey: string, listener: (next: CollectionSessionState) => void): () => void;
  release(instanceKey: string): void;
}

export type AnyCollectionPreference = PersistedCollectionPreference<
  unknown,
  unknown,
  unknown,
  unknown,
  unknown
>;

const EMPTY_COLLECTION_SESSION: CollectionSessionState = {
  query: '',
  selectionKey: null,
  focusedKey: null,
  scrollAnchor: null,
  openSurface: null,
};

function copySession(state: CollectionSessionState): CollectionSessionState {
  return { ...state };
}

/** In-memory ownership for state which must not escape a mounted collection instance. */
export class InMemoryCollectionSessionPort implements CollectionSessionPort {
  private readonly values = new Map<string, CollectionSessionState>();
  private readonly listeners = new Map<string, Set<(next: CollectionSessionState) => void>>();

  read(instanceKey: string): CollectionSessionState {
    return copySession(this.values.get(instanceKey) ?? EMPTY_COLLECTION_SESSION);
  }

  update(instanceKey: string, next: CollectionSessionState): void {
    const snapshot = copySession(next);
    this.values.set(instanceKey, snapshot);
    for (const listener of this.listeners.get(instanceKey) ?? []) listener(copySession(snapshot));
  }

  subscribe(instanceKey: string, listener: (next: CollectionSessionState) => void): () => void {
    const scoped = this.listeners.get(instanceKey) ?? new Set();
    scoped.add(listener);
    this.listeners.set(instanceKey, scoped);
    return () => {
      scoped.delete(listener);
      if (scoped.size === 0) this.listeners.delete(instanceKey);
    };
  }

  release(instanceKey: string): void {
    this.values.delete(instanceKey);
    this.listeners.delete(instanceKey);
  }
}

/**
 * The only boundary between versioned collection preferences and a mounted
 * collection's transient interaction state. Search, selection, focus, scroll,
 * and open surfaces are intentionally exposed only through the session port.
 */
export class CollectionStateCoordinator<TPreference extends AnyCollectionPreference> {
  private readonly migrated = new Map<
    CollectionScopeKey,
    CollectionPreferenceSnapshot<TPreference>
  >();
  private readonly writeQueues = new Map<CollectionScopeKey, Promise<void>>();

  constructor(
    private readonly ports: {
      readonly preferences: CollectionPreferencePort<TPreference>;
      readonly sessions: CollectionSessionPort;
      readonly migratePreference: (current: TPreference) => TPreference;
    },
  ) {}

  preference(scope: CollectionScopeKey): TPreference {
    return this.preferenceSnapshot(scope).preference;
  }

  preferenceSnapshot(scope: CollectionScopeKey): CollectionPreferenceSnapshot<TPreference> {
    const cached = this.migrated.get(scope);
    if (cached) return cached;
    const current = this.ports.preferences.read(scope);
    const next = {
      persistenceIdentity: current.persistenceIdentity,
      revision: current.revision,
      preference: this.ports.migratePreference(current.preference),
    };
    this.migrated.set(scope, next);
    return next;
  }

  /** Settings owners call this after their backing object is replaced externally. */
  invalidatePreferences(): void {
    this.migrated.clear();
  }

  invalidatePreference(scope: CollectionScopeKey): void {
    this.migrated.delete(scope);
  }

  async updatePreference(
    scope: CollectionScopeKey,
    expected: CollectionPreferenceSnapshot<TPreference>,
    next: TPreference,
  ): Promise<CollectionPreferenceSnapshot<TPreference>> {
    const previousWrite = this.writeQueues.get(scope) ?? Promise.resolve();
    const result = previousWrite.then(async () => {
      const settled = await this.ports.preferences.update(scope, expected, next);
      const migrated = {
        persistenceIdentity: settled.persistenceIdentity,
        revision: settled.revision,
        preference: this.ports.migratePreference(settled.preference),
      };
      if (this.migrated.get(scope)?.persistenceIdentity === expected.persistenceIdentity)
        this.migrated.set(scope, migrated);
      return migrated;
    });
    const queue = result.then(
      () => undefined,
      () => undefined,
    );
    this.writeQueues.set(scope, queue);
    void queue.finally(() => {
      if (this.writeQueues.get(scope) === queue) this.writeQueues.delete(scope);
    });
    return result;
  }

  subscribePreference(
    scope: CollectionScopeKey,
    listener: (next: CollectionPreferenceSnapshot<TPreference>) => void,
  ): () => void {
    return this.ports.preferences.subscribe(scope, (next) => {
      const migrated = {
        persistenceIdentity: next.persistenceIdentity,
        revision: next.revision,
        preference: this.ports.migratePreference(next.preference),
      };
      if (this.migrated.get(scope)?.persistenceIdentity === next.persistenceIdentity)
        this.migrated.set(scope, migrated);
      listener(migrated);
    });
  }

  session(instanceKey: string): CollectionSessionState {
    return this.ports.sessions.read(instanceKey);
  }

  updateSession(instanceKey: string, next: CollectionSessionState): void {
    this.ports.sessions.update(instanceKey, next);
  }

  subscribeSession(
    instanceKey: string,
    listener: (next: CollectionSessionState) => void,
  ): () => void {
    return this.ports.sessions.subscribe(instanceKey, listener);
  }

  release(instanceKey: string): void {
    this.ports.sessions.release(instanceKey);
  }
}
