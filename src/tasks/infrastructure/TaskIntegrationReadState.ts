import type {
  TaskAcceptedOccurrenceChange,
  TaskIntegrationReadStateApi,
  TaskReadEvent,
  TaskReadObservation,
  TaskReadResult,
  TaskReadScope,
  TaskSourceHealthChange,
} from '../application/TaskIntegrationReadApi';

interface SourceHealth {
  readonly superseded: object[];
  path: string;
  readonly fileIdentity: object;
  readonly acquisition: object;
  phase: TaskSourceHealthChange['phase'];
}

interface ReadListener {
  readonly inward?: true;
  revision: number;
  readonly receive: (event: TaskReadEvent) => void;
}
interface ReadPublication {
  readonly event: TaskReadEvent;
  readonly listeners: readonly ReadListener[];
}

function matchesScope(path: string, scope?: TaskReadScope): boolean {
  if (scope?.path !== undefined && scope.path !== path) return false;
  const folder = scope?.folder;
  return folder === undefined || folder === '' || path.startsWith(`${folder.replace(/\/$/, '')}/`);
}

/** Completeness belongs to source observations, including files with no task records. */
export class TaskIntegrationReadState implements TaskIntegrationReadStateApi {
  private observation_abyssPrivate: TaskReadObservation = Object.freeze({
    revision: 0,
    generation: 0,
    scopeRevision: 0,
    semanticsRevision: 0,
    lifecycle: 'initializing',
  });
  private exhausted_abyssPrivate = false;
  private readonly sources_abyssPrivate = new Map<string, SourceHealth>();
  private readonly acquisitions_abyssPrivate = new WeakMap<object, SourceHealth>();
  private publicationDepth_abyssPrivate = 0;
  private publishing_abyssPrivate = false;
  private accepting_abyssPrivate = false;
  private readonly acceptedEvents_abyssPrivate: ReadPublication[] = [];
  private readonly events_abyssPrivate: ReadPublication[] = [];
  private readonly listeners_abyssPrivate = new Set<ReadListener>();

  constructor(
    private readonly excludedPath_abyssPrivate: (path: string) => boolean = () => false,
  ) {}

  capture(): TaskReadObservation {
    return this.observation_abyssPrivate;
  }

  subscribe(
    listener: (event: TaskReadEvent) => void,
  ): ReturnType<TaskIntegrationReadStateApi['subscribe']> {
    const record = { receive: listener, revision: this.capture().revision };
    if (this.capture().lifecycle !== 'disposed') this.listeners_abyssPrivate.add(record);
    return {
      state: this.capture(),
      unsubscribe: () => {
        this.listeners_abyssPrivate.delete(record);
      },
    };
  }

  subscribeInward(
    listener: (event: TaskReadEvent) => void,
  ): ReturnType<TaskIntegrationReadStateApi['subscribe']> {
    const record: ReadListener = {
      receive: listener,
      revision: this.capture().revision,
      inward: true,
    };
    if (this.capture().lifecycle !== 'disposed') this.listeners_abyssPrivate.add(record);
    return {
      state: this.capture(),
      unsubscribe: () => {
        this.listeners_abyssPrivate.delete(record);
      },
    };
  }

  coverage(scope?: TaskReadScope): TaskReadResult<true> {
    const observation = this.capture();
    if (observation.lifecycle !== 'ready')
      return {
        type: 'error',
        reason: observation.lifecycle === 'initializing' ? 'not-ready' : observation.lifecycle,
      };
    // Nested installation may advance roots beyond the acceptance currently being delivered.
    if (this.publicationDepth_abyssPrivate > 0 || this.acceptedEvents_abyssPrivate.length > 0)
      return { type: 'error', reason: 'incomplete' };
    if (this.incomplete_abyssPrivate(scope)) return { type: 'error', reason: 'incomplete' };
    return Object.freeze({ type: 'ok', value: true, observation });
  }

  private incomplete_abyssPrivate(scope?: TaskReadScope): boolean {
    const sources =
      scope?.path === undefined
        ? this.sources_abyssPrivate.values()
        : [this.sources_abyssPrivate.get(scope.path)];
    for (const source of sources) {
      if (
        source !== undefined &&
        matchesScope(source.path, scope) &&
        source.phase !== 'settled' &&
        !this.excludedPath_abyssPrivate(source.path)
      )
        return true;
    }
    return false;
  }

  begin(path: string, fileIdentity: object, observationId: object): object {
    const previous = this.sources_abyssPrivate.get(path);
    const superseded =
      previous?.fileIdentity === fileIdentity && previous.phase === 'pending'
        ? [...previous.superseded, previous.acquisition]
        : [];
    const source: SourceHealth = {
      superseded,
      path,
      fileIdentity,
      acquisition: observationId,
      phase: 'pending',
    };
    if (this.closed_abyssPrivate()) return observationId;
    this.sources_abyssPrivate.set(path, source);
    this.acquisitions_abyssPrivate.set(observationId, source);
    this.health_abyssPrivate(source);
    return observationId;
  }

  accept(token: object): void {
    this.settle_abyssPrivate(token, 'settled');
  }
  fail(token: object): void {
    this.settle_abyssPrivate(token, 'failed');
  }

  private settle_abyssPrivate(token: object, phase: SourceHealth['phase']): void {
    const source = this.acquisitions_abyssPrivate.get(token);
    if (
      this.closed_abyssPrivate() ||
      source === undefined ||
      this.sources_abyssPrivate.get(source.path) !== source ||
      source.phase === phase
    )
      return;
    source.phase = phase;
    if (phase === 'failed') source.superseded.length = 0;
    this.health_abyssPrivate(source);
  }

  remove(path: string, fileIdentity: object): void {
    if (
      this.closed_abyssPrivate() ||
      this.sources_abyssPrivate.get(path)?.fileIdentity !== fileIdentity
    )
      return;
    this.sources_abyssPrivate.delete(path);
    this.changed_abyssPrivate();
  }

  rename(oldPath: string, newPath: string, fileIdentity: object): void {
    const source = this.sources_abyssPrivate.get(oldPath);
    if (this.closed_abyssPrivate() || source?.fileIdentity !== fileIdentity) return;
    this.sources_abyssPrivate.delete(oldPath);
    source.path = newPath;
    this.sources_abyssPrivate.set(newPath, source);
    this.changed_abyssPrivate();
  }

  isUnsettled(path: string, fileIdentity: object): boolean {
    const source = this.sources_abyssPrivate.get(path);
    return source?.fileIdentity === fileIdentity && source.phase !== 'settled';
  }

  /** Enumerates health owners for confirmed-absence pruning, never source contents. */
  sources(): ReadonlyArray<{ readonly path: string; readonly fileIdentity: object }> {
    return [...this.sources_abyssPrivate.values()].map(({ path, fileIdentity }) => ({
      path,
      fileIdentity,
    }));
  }

  advanceScope(): void {
    if (this.closed_abyssPrivate()) return;
    // Policy refresh must be incomplete even inside its synchronous invalidation callback.
    for (const source of this.sources_abyssPrivate.values()) {
      source.phase = 'pending';
      source.superseded.length = 0;
    }
    if (this.advance_abyssPrivate('scopeRevision'))
      this.publish_abyssPrivate({ type: 'changed', observation: this.capture() });
  }

  advanceSemantics(): void {
    if (this.advance_abyssPrivate('semanticsRevision'))
      this.publish_abyssPrivate({ type: 'changed', observation: this.capture() });
  }

  advanceProjectObservation(): void {
    this.changed_abyssPrivate();
  }

  setLifecycle(lifecycle: TaskReadObservation['lifecycle']): void {
    if (this.closed_abyssPrivate() || lifecycle === this.capture().lifecycle) return;
    if (!this.advance_abyssPrivate()) return;
    this.observation_abyssPrivate = Object.freeze({ ...this.capture(), lifecycle });
    if (lifecycle !== 'ready')
      for (const source of this.sources_abyssPrivate.values()) source.superseded.length = 0;
    this.publish_abyssPrivate({ type: 'state', observation: this.capture() });
  }

  dispose(): void {
    if (this.capture().lifecycle === 'disposed') return;
    this.setLifecycle('disposed');
    // Exhaustion is terminal, but disposal still releases ownership without incrementing.
    if (this.capture().lifecycle !== 'disposed')
      this.observation_abyssPrivate = Object.freeze({ ...this.capture(), lifecycle: 'disposed' });
    this.listeners_abyssPrivate.clear();
    this.sources_abyssPrivate.clear();
  }

  /** Canonical relocation is synchronous; outward readers cannot observe its intermediate state. */
  batch(change: () => void, accepted?: () => void): void {
    this.publicationDepth_abyssPrivate += 1;
    try {
      change();
    } finally {
      this.publicationDepth_abyssPrivate -= 1;
      accepted?.();
      this.flush_abyssPrivate();
    }
  }

  currentAcquisition(path: string, fileIdentity: object): object | undefined {
    const source = this.sources_abyssPrivate.get(path);
    return source?.fileIdentity === fileIdentity ? source.acquisition : undefined;
  }

  takeSettledAcquisitions(path: string, fileIdentity: object): readonly object[] {
    const source = this.sources_abyssPrivate.get(path);
    if (source?.fileIdentity !== fileIdentity || source.phase !== 'settled') return [];
    return [...source.superseded.splice(0), source.acquisition];
  }

  /** Accepted canonical installation reaches inward consumers before held health callbacks. */
  accepted(change: TaskAcceptedOccurrenceChange): void {
    if (!this.advance_abyssPrivate()) return;
    this.acceptedEvents_abyssPrivate.push({
      event: Object.freeze({ type: 'accepted', observation: this.capture(), change }),
      listeners: [...this.listeners_abyssPrivate],
    });
    this.flushAccepted_abyssPrivate();
  }

  private flushAccepted_abyssPrivate(): void {
    if (this.accepting_abyssPrivate) return;
    const publishing = this.publishing_abyssPrivate;
    this.publishing_abyssPrivate = true;
    this.accepting_abyssPrivate = true;
    try {
      for (
        let event = this.acceptedEvents_abyssPrivate.shift();
        event !== undefined;
        event = this.acceptedEvents_abyssPrivate.shift()
      ) {
        this.notify_abyssPrivate(event);
      }
    } finally {
      this.accepting_abyssPrivate = false;
      this.publishing_abyssPrivate = publishing;
      this.flush_abyssPrivate();
    }
  }

  private closed_abyssPrivate(): boolean {
    return this.exhausted_abyssPrivate || this.capture().lifecycle === 'disposed';
  }

  private advance_abyssPrivate(field?: 'scopeRevision' | 'semanticsRevision'): boolean {
    if (this.closed_abyssPrivate()) return false;
    const prior = this.capture();
    if (
      [prior.revision, prior.generation, ...(field === undefined ? [] : [prior[field]])].some(
        (value) => value >= Number.MAX_SAFE_INTEGER,
      )
    ) {
      this.exhausted_abyssPrivate = true;
      this.observation_abyssPrivate = Object.freeze({ ...prior, lifecycle: 'failed' });
      console.error('[abyss-tasks] Integration observation counter exhausted');
      this.publish_abyssPrivate({ type: 'state', observation: this.capture() });
      return false;
    }
    this.observation_abyssPrivate = Object.freeze({
      ...prior,
      revision: prior.revision + 1,
      generation: prior.generation + 1,
      ...(field === undefined ? {} : { [field]: prior[field] + 1 }),
    });
    return true;
  }

  private changed_abyssPrivate(): void {
    if (this.advance_abyssPrivate())
      this.publish_abyssPrivate({ type: 'changed', observation: this.capture() });
  }

  private health_abyssPrivate(source: SourceHealth): void {
    if (!this.advance_abyssPrivate()) return;
    this.publish_abyssPrivate({
      type: 'health',
      observation: this.capture(),
      change: Object.freeze({
        filePath: source.path,
        fileIdentity: source.fileIdentity,
        acquisition: source.acquisition,
        phase: source.phase,
      }),
    });
  }

  private publish_abyssPrivate(event: TaskReadEvent): void {
    this.events_abyssPrivate.push({
      event: Object.freeze(event),
      listeners: [...this.listeners_abyssPrivate],
    });
    this.flush_abyssPrivate();
  }

  private flush_abyssPrivate(): void {
    if (this.publicationDepth_abyssPrivate > 0 || this.publishing_abyssPrivate) return;
    this.publishing_abyssPrivate = true;
    try {
      for (
        let event = this.events_abyssPrivate.shift();
        event !== undefined;
        event = this.events_abyssPrivate.shift()
      ) {
        this.notify_abyssPrivate(event);
      }
    } finally {
      this.publishing_abyssPrivate = false;
    }
  }

  private notify_abyssPrivate(publication: ReadPublication): void {
    for (const listener of [...publication.listeners].sort(
      (left, right) => Number(right.inward === true) - Number(left.inward === true),
    )) {
      if (!this.listeners_abyssPrivate.has(listener)) continue;
      try {
        // An accepted installation can overtake held health evidence. Keep its exact tokens
        // and phases while reporting the latest observation to consumers already advanced.
        const event =
          publication.event.observation.revision < listener.revision
            ? Object.freeze({ ...publication.event, observation: this.capture() })
            : publication.event;
        listener.revision = event.observation.revision;
        listener.receive(event);
      } catch {
        console.error('[abyss-tasks] Integration read subscriber failed');
      }
    }
  }
}
