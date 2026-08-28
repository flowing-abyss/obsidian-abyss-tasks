export type InspectorDraftField =
  | 'status'
  | 'priority'
  | 'start'
  | 'end'
  | 'description'
  | 'comment';

export type InspectorDraftResult =
  | 'ok'
  | 'unchanged'
  | 'conflict'
  | 'unsupported'
  | 'invalid'
  | 'io-error';

export type InspectorDraftIdentity =
  | { readonly type: 'project'; readonly path: string }
  | { readonly type: 'work-note'; readonly path: string; readonly projectPath: string };

export interface InspectorDraftCapture {
  readonly value: string;
  readonly baseline: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly hadFocus: boolean;
  readonly pending?: boolean;
  readonly result?: InspectorDraftResult;
  readonly detached?: boolean;
  readonly operationId?: object;
  /** Raw compare-and-set observation captured when this edit session began. */
  readonly observation?: unknown;
}

export interface InspectorDraftEntry extends InspectorDraftCapture {
  readonly identity: InspectorDraftIdentity;
  readonly field: InspectorDraftField;
  readonly dirty: boolean;
  readonly pending: boolean;
  readonly detached: boolean;
}

function identityKey(identity: InspectorDraftIdentity): string {
  return `${identity.type}:${identity.path}`;
}

function entryKey(identity: InspectorDraftIdentity, field: InspectorDraftField): string {
  return `${identityKey(identity)}\0${field}`;
}

function copyIdentity(identity: InspectorDraftIdentity): InspectorDraftIdentity {
  return identity.type === 'project'
    ? { type: 'project', path: identity.path }
    : { type: 'work-note', path: identity.path, projectPath: identity.projectPath };
}

function renamedIdentity(
  identity: InspectorDraftIdentity,
  oldPath: string,
  newPath: string,
): InspectorDraftIdentity {
  if (identity.type === 'project') {
    return identity.path === oldPath ? { type: 'project', path: newPath } : identity;
  }
  return {
    type: 'work-note',
    path: identity.path === oldPath ? newPath : identity.path,
    projectPath: identity.projectPath === oldPath ? newPath : identity.projectPath,
  };
}

/**
 * DOM-independent continuity for Project and Work Note inspector edits.
 * Task inspector drafts deliberately remain owned by RightPanel.
 */
export class InspectorDraftRegistry {
  private readonly entriesByKey = new Map<string, InspectorDraftEntry>();
  private collisionRecoveries: InspectorDraftEntry[] = [];

  capture(
    identity: InspectorDraftIdentity,
    field: InspectorDraftField,
    capture: InspectorDraftCapture,
  ): InspectorDraftEntry {
    if (capture.hadFocus) {
      const key = identityKey(identity);
      for (const [storedKey, stored] of this.entriesByKey) {
        if (identityKey(stored.identity) === key && stored.field !== field && stored.hadFocus) {
          this.entriesByKey.set(storedKey, { ...stored, hadFocus: false });
        }
      }
    }
    const entry: InspectorDraftEntry = {
      ...capture,
      identity: copyIdentity(identity),
      field,
      dirty: capture.value !== capture.baseline,
      pending: capture.pending ?? false,
      detached: capture.detached ?? false,
    };
    this.entriesByKey.set(entryKey(identity, field), entry);
    return entry;
  }

  get(
    identity: InspectorDraftIdentity,
    field: InspectorDraftField,
  ): InspectorDraftEntry | undefined {
    return this.entriesByKey.get(entryKey(identity, field));
  }

  reconcile(
    identity: InspectorDraftIdentity,
    field: InspectorDraftField,
    baseline: string,
    observation?: unknown,
  ): InspectorDraftEntry {
    const current = this.get(identity, field);
    if (!current) {
      return this.capture(identity, field, {
        value: baseline,
        baseline,
        selectionStart: baseline.length,
        selectionEnd: baseline.length,
        hadFocus: false,
        observation,
      });
    }
    if (current.value === baseline) {
      return this.capture(identity, field, {
        ...current,
        value: baseline,
        baseline,
        pending: false,
        detached: false,
        observation,
      });
    }
    if (!current.dirty && !current.pending) {
      return this.capture(identity, field, {
        ...current,
        value: baseline,
        baseline,
        detached: false,
        observation,
      });
    }
    return this.capture(identity, field, { ...current, detached: false });
  }

  markPending(
    identity: InspectorDraftIdentity,
    field: InspectorDraftField,
    value: string,
    baseline: string,
    hadFocus: boolean,
  ): InspectorDraftEntry {
    const current = this.get(identity, field);
    const operationId = Object.freeze({});
    return this.capture(identity, field, {
      value,
      baseline,
      selectionStart: current?.selectionStart ?? value.length,
      selectionEnd: current?.selectionEnd ?? value.length,
      hadFocus: hadFocus || current?.hadFocus === true,
      pending: true,
      detached: false,
      operationId,
      observation: current?.observation,
      result: undefined,
    });
  }

  settlePending(
    pendingEntry: InspectorDraftEntry,
    result: InspectorDraftResult,
    committedValue?: string,
  ): InspectorDraftEntry | undefined {
    const operationId = pendingEntry.operationId;
    const current = [...this.entriesByKey.values(), ...this.collisionRecoveries].find(
      (entry) => operationId !== undefined && entry.operationId === operationId,
    );
    if (!current) return undefined;
    const succeeded = (result === 'ok' || result === 'unchanged') && !current.detached;
    const value = succeeded ? (committedValue ?? current.value) : current.value;
    const settled: InspectorDraftEntry = {
      ...current,
      value,
      baseline: succeeded ? value : current.baseline,
      dirty: value !== (succeeded ? value : current.baseline),
      pending: false,
      result,
      hadFocus: succeeded ? false : current.hadFocus,
      operationId: undefined,
    };
    const key = entryKey(current.identity, current.field);
    if (this.entriesByKey.get(key) === current) this.entriesByKey.set(key, settled);
    else {
      this.collisionRecoveries = this.collisionRecoveries.map((entry) =>
        entry === current ? settled : entry,
      );
    }
    return settled;
  }

  settle(
    identity: InspectorDraftIdentity,
    field: InspectorDraftField,
    result: InspectorDraftResult,
    committedValue?: string,
  ): InspectorDraftEntry | undefined {
    const current = this.get(identity, field);
    if (!current) return undefined;
    if (current.operationId) return this.settlePending(current, result, committedValue);
    const succeeded = (result === 'ok' || result === 'unchanged') && !current.detached;
    const value = succeeded ? (committedValue ?? current.value) : current.value;
    return this.capture(identity, field, {
      ...current,
      value,
      baseline: succeeded ? value : current.baseline,
      pending: false,
      result,
      detached: current.detached,
      hadFocus: succeeded ? false : current.hadFocus,
    });
  }

  hasDirty(identity: InspectorDraftIdentity): boolean {
    const key = identityKey(identity);
    return [...this.entriesByKey.values(), ...this.collisionRecoveries].some(
      (entry) => identityKey(entry.identity) === key && entry.dirty,
    );
  }

  detach(identity: InspectorDraftIdentity): void {
    const key = identityKey(identity);
    for (const entry of [...this.entriesByKey.values()]) {
      if (identityKey(entry.identity) !== key) continue;
      if (!entry.dirty && !entry.pending) {
        this.entriesByKey.delete(entryKey(entry.identity, entry.field));
        continue;
      }
      this.capture(entry.identity, entry.field, { ...entry, pending: false, detached: true });
    }
  }

  detached(): readonly InspectorDraftEntry[] {
    return [...this.entriesByKey.values(), ...this.collisionRecoveries].filter(
      (entry) => entry.detached && entry.dirty,
    );
  }

  discard(identity: InspectorDraftIdentity, field: InspectorDraftField): void {
    this.entriesByKey.delete(entryKey(identity, field));
    this.collisionRecoveries = this.collisionRecoveries.filter(
      (entry) => entryKey(entry.identity, entry.field) !== entryKey(identity, field),
    );
  }

  discardEntry(entry: InspectorDraftEntry): void {
    const key = entryKey(entry.identity, entry.field);
    if (this.entriesByKey.get(key) === entry) this.entriesByKey.delete(key);
    this.collisionRecoveries = this.collisionRecoveries.filter((candidate) => candidate !== entry);
  }

  detachPath(path: string): void {
    const matches = (identity: InspectorDraftIdentity): boolean =>
      identity.path === path || (identity.type === 'work-note' && identity.projectPath === path);
    for (const entry of [...this.entriesByKey.values()]) {
      if (!matches(entry.identity)) continue;
      this.detach(entry.identity);
    }
    this.collisionRecoveries = this.collisionRecoveries
      .filter((entry) => entry.dirty)
      .map((entry) =>
        matches(entry.identity) ? { ...entry, pending: false, detached: true } : entry,
      );
  }

  renamePath(oldPath: string, newPath: string): void {
    if (oldPath === newPath) return;
    const current = [...this.entriesByKey.values()].map((entry) => ({
      entry,
      source:
        entry.identity.path === oldPath ||
        (entry.identity.type === 'work-note' && entry.identity.projectPath === oldPath),
    }));
    this.entriesByKey.clear();
    const groups = new Map<
      string,
      Array<{ readonly entry: InspectorDraftEntry; readonly source: boolean }>
    >();
    for (const candidate of current) {
      const identity = renamedIdentity(candidate.entry.identity, oldPath, newPath);
      const transformed = { ...candidate.entry, identity: copyIdentity(identity) };
      const key = entryKey(identity, transformed.field);
      const group = groups.get(key) ?? [];
      group.push({ entry: transformed, source: candidate.source });
      groups.set(key, group);
    }
    for (const [key, group] of groups) {
      const winner = group.find(({ source }) => source) ?? group[group.length - 1]!;
      this.entriesByKey.set(key, winner.entry);
      for (const candidate of group) {
        if (candidate === winner || !candidate.entry.dirty) continue;
        this.collisionRecoveries.push({
          ...candidate.entry,
          pending: false,
          detached: true,
        });
      }
    }
    this.collisionRecoveries = this.collisionRecoveries.map((entry) => ({
      ...entry,
      identity: copyIdentity(renamedIdentity(entry.identity, oldPath, newPath)),
    }));
  }
}
