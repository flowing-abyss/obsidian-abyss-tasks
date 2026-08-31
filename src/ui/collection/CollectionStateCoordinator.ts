import type { CollectionSessionState, PersistedCollectionPreference } from '../../settings/types';

export type CollectionScopeKey =
  | 'tasks:main'
  | 'projects:portfolio'
  | `project:${string}:tasks`
  | `project:${string}:work-notes`;

export interface CollectionPreferencePort<TPreference> {
  read(scope: CollectionScopeKey): TPreference;
  update(
    scope: CollectionScopeKey,
    expectedVersion: number,
    next: TPreference,
  ): Promise<TPreference>;
  subscribe(scope: CollectionScopeKey, listener: (next: TPreference) => void): () => void;
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
  private readonly migrated = new Map<CollectionScopeKey, TPreference>();

  constructor(
    private readonly ports: {
      readonly preferences: CollectionPreferencePort<TPreference>;
      readonly sessions: CollectionSessionPort;
      readonly migratePreference: (current: TPreference) => TPreference;
    },
  ) {}

  preference(scope: CollectionScopeKey): TPreference {
    const cached = this.migrated.get(scope);
    if (cached) return cached;
    const next = this.ports.migratePreference(this.ports.preferences.read(scope));
    this.migrated.set(scope, next);
    return next;
  }

  /** Settings owners call this after their backing object is replaced externally. */
  invalidatePreferences(): void {
    this.migrated.clear();
  }

  async updatePreference(
    scope: CollectionScopeKey,
    expectedVersion: number,
    next: TPreference,
  ): Promise<TPreference> {
    const previous = this.migrated.get(scope);
    this.migrated.set(scope, this.ports.migratePreference(next));
    try {
      const settled = await this.ports.preferences.update(scope, expectedVersion, next);
      const migrated = this.ports.migratePreference(settled);
      this.migrated.set(scope, migrated);
      return migrated;
    } catch (error) {
      if (previous) this.migrated.set(scope, previous);
      else this.migrated.delete(scope);
      throw error;
    }
  }

  subscribePreference(
    scope: CollectionScopeKey,
    listener: (next: TPreference) => void,
  ): () => void {
    return this.ports.preferences.subscribe(scope, (next) => {
      const migrated = this.ports.migratePreference(next);
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
