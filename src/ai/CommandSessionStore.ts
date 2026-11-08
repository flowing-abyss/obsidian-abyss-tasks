import {
  isCompletedCommandSession,
  parseCommandHistory,
  projectCommandSnapshot,
  type CommandHistoryEnvelope,
  type HistoricalCommandSession,
  type HistoricalCommandSnapshot,
} from './commandRecovery';

/** Main supplies the single vault-local host port. This layer acquires no native writer. */
export interface CommandSessionStoragePort {
  load(): unknown;
  save(value: unknown): void;
}
export interface CommandSessionStoreOptions {
  readonly storage: CommandSessionStoragePort;
  readonly now: () => number;
}
export type CommandPersistenceFailureCode =
  | 'UNREADABLE_HISTORY'
  | 'INVALID_SNAPSHOT'
  | 'HISTORY_LIMIT'
  | 'WRITE_FAILED'
  | 'READBACK_MISMATCH'
  | 'MISSING_SESSION';
export class CommandPersistenceFailure extends Error {
  constructor(readonly code: CommandPersistenceFailureCode) {
    super(failureMessage(code));
    this.name = 'CommandPersistenceFailure';
  }
}
function failureMessage(code: CommandPersistenceFailureCode): string {
  switch (code) {
    case 'UNREADABLE_HISTORY':
      return 'Local history could not be loaded. Existing storage is preserved.';
    case 'INVALID_SNAPSHOT':
      return 'This session could not be stored. Keep it open.';
    case 'HISTORY_LIMIT':
      return 'Local history is full. Keep this session open.';
    case 'WRITE_FAILED':
      return 'Local history could not be saved. Keep this session open.';
    case 'READBACK_MISMATCH':
      return 'Local history save could not be verified. Keep this session open.';
    case 'MISSING_SESSION':
      return 'This session is unavailable.';
  }
}
const MAX_COMPLETED = 20;
const SOFT_BYTES = 2 * 1024 * 1024;
function byteSize(value: CommandHistoryEnvelope): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
/** One data owner, with detached history only; never constructs clients or resumes effects. */
export class CommandSessionStore {
  private data: CommandHistoryEnvelope = { version: 1, activeSessionId: null, sessions: [] };
  private readonly paused: boolean = false;
  private lastFailure: CommandPersistenceFailure | null = null;
  private readonly unsaved = new Set<string>();
  constructor(private readonly options: CommandSessionStoreOptions) {
    try {
      const raw = options.storage.load();
      if (raw !== null && raw !== undefined) this.data = parseCommandHistory(raw);
    } catch {
      this.paused = true;
      this.lastFailure = new CommandPersistenceFailure('UNREADABLE_HISTORY');
    }
  }
  records(): readonly HistoricalCommandSession[] {
    return structuredClone(this.data.sessions);
  }
  activeId(): string | null {
    return this.data.activeSessionId;
  }
  failure(): CommandPersistenceFailure | null {
    return this.lastFailure === null ? null : new CommandPersistenceFailure(this.lastFailure.code);
  }
  /** Compatible with the mandatory awaited journal; a late completion never selects its record. */
  async save(value: unknown): Promise<void> {
    this.stage(value);
    this.persist();
  }
  /** Explicit new active record. On rejection the caller must retain its live runtime. */
  async create(value: unknown): Promise<void> {
    const id = this.stage(value);
    this.persist({ ...this.data, activeSessionId: id });
  }
  async select(id: string): Promise<void> {
    if (!this.data.sessions.some((record) => record.snapshot.id === id))
      this.fail('MISSING_SESSION');
    this.persist({ ...this.data, activeSessionId: id });
  }
  async clearCompleted(): Promise<void> {
    const candidate = {
      ...this.data,
      sessions: this.data.sessions.filter(
        (record) => !this.eligible(record, this.data.activeSessionId),
      ),
    };
    this.persist(candidate);
  }
  private fail(code: CommandPersistenceFailureCode): never {
    this.lastFailure = new CommandPersistenceFailure(code);
    throw this.lastFailure;
  }
  private stage(value: unknown): string {
    let snapshot: HistoricalCommandSnapshot;
    try {
      snapshot = projectCommandSnapshot(value);
      const time = this.options.now();
      if (!Number.isFinite(time)) this.fail('INVALID_SNAPSHOT');
      const record: HistoricalCommandSession = { handles: 'historical', updatedAt: time, snapshot };
      const sessions = this.data.sessions.filter((entry) => entry.snapshot.id !== snapshot.id);
      // Preserve stable display order on update; timestamps determine pruning, not selection.
      const index = this.data.sessions.findIndex((entry) => entry.snapshot.id === snapshot.id);
      sessions.splice(index < 0 ? sessions.length : index, 0, record);
      this.data = {
        ...this.data,
        sessions,
        activeSessionId: this.data.activeSessionId,
      };
      this.unsaved.add(snapshot.id);
      return snapshot.id;
    } catch {
      this.fail('INVALID_SNAPSHOT');
    }
  }
  private eligible(record: HistoricalCommandSession, activeId: string | null): boolean {
    return (
      record.snapshot.id !== activeId &&
      !this.unsaved.has(record.snapshot.id) &&
      isCompletedCommandSession(record.snapshot)
    );
  }
  private bounded(candidate: CommandHistoryEnvelope): CommandHistoryEnvelope {
    let sessions = [...candidate.sessions];
    const oldest = sessions
      .filter((record) => this.eligible(record, candidate.activeSessionId))
      .sort((a, b) => a.updatedAt - b.updatedAt);
    while (
      sessions.filter((record) => isCompletedCommandSession(record.snapshot)).length >
        MAX_COMPLETED ||
      byteSize({ ...candidate, sessions }) > SOFT_BYTES
    ) {
      const next = oldest.shift();
      if (next === undefined) this.fail('HISTORY_LIMIT');
      sessions = sessions.filter((record) => record !== next);
    }
    return { ...candidate, sessions };
  }
  private persist(candidate = this.data): void {
    if (this.paused) this.fail('UNREADABLE_HISTORY');
    const representation = this.bounded(candidate);
    // Revalidate the complete representation before crossing the synchronous host port.
    let checked: CommandHistoryEnvelope;
    try {
      checked = parseCommandHistory(representation);
    } catch {
      this.fail('INVALID_SNAPSHOT');
    }
    const expected = JSON.stringify(checked);
    try {
      this.options.storage.save(structuredClone(checked));
    } catch {
      this.fail('WRITE_FAILED');
    }
    try {
      const raw = this.options.storage.load();
      // Compare raw too: a projection must not hide extra fields introduced by storage.
      if (JSON.stringify(raw) !== expected || JSON.stringify(parseCommandHistory(raw)) !== expected)
        this.fail('READBACK_MISMATCH');
    } catch {
      this.fail('READBACK_MISMATCH');
    }
    this.data = checked;
    this.unsaved.clear();
    this.lastFailure = null;
  }
}
