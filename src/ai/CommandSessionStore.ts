import { z } from 'zod';
import {
  commandActivity,
  commandSessionMetadata,
  hasCommandHistoryContent,
} from './commandHistoryMetadata';
import {
  hasUnresolvedCommandWrites,
  isCompletedCommandSession,
  parseCommandHistory,
  parseCommandSessionFile,
  projectCommandSnapshot,
  type CommandHistoryEnvelope,
  type CommandSessionFile,
  type HistoricalCommandSession,
  type HistoricalCommandSnapshot,
} from './commandRecovery';

export type CommandHistoryFileKey =
  { readonly kind: 'state' } | { readonly kind: 'session'; readonly fileId: string };
/** Main supplies narrowly scoped native callbacks; filenames never derive from logical IDs. */
export interface CommandSessionStoragePort {
  listSessions(this: void): Promise<readonly string[]>;
  read(this: void, key: CommandHistoryFileKey): Promise<string | null>;
  write(
    this: void,
    key: CommandHistoryFileKey,
    text: string,
    previous: string | null,
  ): Promise<void>;
  remove(this: void, fileId: string): Promise<void>;
  loadLegacy(this: void): unknown;
  clearLegacy(this: void): void;
}
export interface CommandSessionStoreOptions {
  readonly storage: CommandSessionStoragePort;
  readonly now: () => number;
  readonly fileId: () => string;
}
export type CommandPersistenceFailureCode =
  | 'UNREADABLE_HISTORY'
  | 'INVALID_SNAPSHOT'
  | 'HISTORY_LIMIT'
  | 'WRITE_FAILED'
  | 'READBACK_MISMATCH'
  | 'MISSING_SESSION'
  | 'DELETED_SESSION'
  | 'UNRESOLVED_WRITES'
  | 'DELETE_FAILED'
  | 'LEGACY_DIVERGED'
  | 'LEGACY_CLEANUP_FAILED';
export class CommandPersistenceFailure extends Error {
  constructor(readonly code: CommandPersistenceFailureCode) {
    super(FAILURE_MESSAGES[code]);
    this.name = 'CommandPersistenceFailure';
  }
}
const FAILURE_MESSAGES: Record<CommandPersistenceFailureCode, string> = {
  UNREADABLE_HISTORY: 'Local history could not be loaded. Existing storage is preserved.',
  INVALID_SNAPSHOT: 'This session could not be stored. Keep it open.',
  HISTORY_LIMIT: 'This session is too large to save. Keep it open.',
  WRITE_FAILED: 'Local history could not be saved. Keep this session open.',
  READBACK_MISMATCH: 'Local history save could not be verified. Keep this session open.',
  MISSING_SESSION: 'This session is unavailable.',
  DELETED_SESSION: 'This session has been deleted.',
  UNRESOLVED_WRITES: 'History contains an unresolved write. Review it before deleting history.',
  DELETE_FAILED: 'Some history files could not be removed. Their deletion is retained.',
  LEGACY_DIVERGED:
    'An earlier draft on this device differs from the vault history. Its original local copy has been kept.',
  LEGACY_CLEANUP_FAILED: 'History was imported, but its old copy could not be removed.',
};
export function isCommandSessionFileId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
const fileIdSchema = z.string().refine(isCommandSessionFileId);
const stateFields = {
  activeSessionId: z.string().min(1).nullable(),
  legacyImported: z.boolean(),
  deletedFiles: z.array(fileIdSchema),
};
const stateSchema = z
  .discriminatedUnion('version', [
    z.strictObject({ version: z.literal(1), ...stateFields }),
    z.strictObject({
      version: z.literal(2),
      ...stateFields,
      deletedSessions: z.record(fileIdSchema, z.string().min(1)),
    }),
  ])
  .refine((state) => {
    if (!state.legacyImported && state.deletedFiles.length > 0) return false;
    if (state.version === 1) return true;
    const files = new Set(state.deletedFiles);
    return Object.keys(state.deletedSessions).every((id) => files.has(id));
  });
type HistoryState = z.infer<typeof stateSchema>;
const MAX_FILE_BYTES = 24 * 1024 * 1024;
function parseFile(text: string): CommandSessionFile {
  if (new TextEncoder().encode(text).byteLength > MAX_FILE_BYTES) throw new Error('File too large');
  return parseCommandSessionFile(JSON.parse(text) as unknown);
}
/** One serial journal and detached history owner, initialized before any runtime is created. */
export class CommandSessionStore {
  private state: HistoryState = {
    version: 1,
    activeSessionId: null,
    legacyImported: false,
    deletedFiles: [],
  };
  private stateText: string | null = null;
  private readonly data = new Map<string, HistoricalCommandSession>();
  private readonly fileIds = new Map<string, string>();
  private readonly fileTexts = new Map<string, string | null>();
  private readonly deleted = new Set<string>();
  private paused = false;
  private lastFailure: CommandPersistenceFailure | null = null;
  private queue: Promise<void> = Promise.resolve();
  private constructor(private readonly options: CommandSessionStoreOptions) {}
  static async open(options: CommandSessionStoreOptions): Promise<CommandSessionStore> {
    const store = new CommandSessionStore(options);
    await store.initialize();
    return store;
  }
  records(): readonly HistoricalCommandSession[] {
    return structuredClone(
      [...this.data.values()]
        .filter((record) => hasCommandHistoryContent(record.snapshot))
        .sort((a, b) =>
          b.updatedAt === a.updatedAt
            ? a.snapshot.id.localeCompare(b.snapshot.id)
            : b.updatedAt - a.updatedAt,
        ),
    );
  }
  activeId(): string | null {
    return this.state.activeSessionId;
  }
  failure(): CommandPersistenceFailure | null {
    return this.lastFailure === null ? null : new CommandPersistenceFailure(this.lastFailure.code);
  }
  drained(): Promise<void> {
    return this.queue;
  }
  private fail(code: CommandPersistenceFailureCode): never {
    this.lastFailure = new CommandPersistenceFailure(code);
    throw this.lastFailure;
  }
  private enqueue(work: () => Promise<void>): Promise<void> {
    const operation = this.queue.then(work);
    this.queue = operation.catch(() => {});
    return operation;
  }
  private writable(): void {
    if (this.paused) this.fail('UNREADABLE_HISTORY');
  }
  private get deletedSessions(): Record<string, string> {
    return this.state.version === 2 ? this.state.deletedSessions : {};
  }
  private async initialize(): Promise<void> {
    try {
      this.stateText = await this.options.storage.read({ kind: 'state' });
      if (this.stateText !== null)
        this.state = stateSchema.parse(JSON.parse(this.stateText) as unknown);
      for (const id of Object.values(this.deletedSessions)) this.deleted.add(id);
      await this.loadRecords();
      if (this.state.activeSessionId !== null && !this.data.has(this.state.activeSessionId))
        throw new Error('Missing active session');
      this.state.activeSessionId = this.visibleSelection(this.state.activeSessionId);
      const local = this.options.storage.loadLegacy();
      if (local == null) {
        // Keep fresh installations free of writes until the first mutation.
        this.state.legacyImported = true;
      } else {
        await this.importLegacy(local);
      }
    } catch (cause) {
      this.paused = true;
      this.lastFailure =
        cause instanceof CommandPersistenceFailure
          ? cause
          : new CommandPersistenceFailure('UNREADABLE_HISTORY');
      return;
    }
    await this.cleanupDeleted();
  }
  private visibleSelection(id: string | null): string | null {
    const record = id === null ? undefined : this.data.get(id);
    return record !== undefined && hasCommandHistoryContent(record.snapshot) ? id : null;
  }
  private async loadRecords(): Promise<void> {
    const files = await this.options.storage.listSessions();
    if (new Set(files).size !== files.length || files.some((id) => !isCommandSessionFileId(id)))
      throw new Error('Invalid filenames');
    for (const fileId of files) {
      if (this.state.deletedFiles.includes(fileId)) continue;
      const text = await this.options.storage.read({ kind: 'session', fileId });
      if (text === null) throw new Error('Missing listed file');
      const file = parseFile(text);
      const record: HistoricalCommandSession = {
        handles: file.handles,
        createdAt: file.createdAt,
        updatedAt: file.updatedAt,
        title: file.title,
        ...(file.titleIsEntity === true ? { titleIsEntity: true as const } : {}),
        snapshot: file.snapshot,
      };
      if (this.data.has(record.snapshot.id) || this.deleted.has(record.snapshot.id))
        throw new Error('Duplicate or deleted session');
      this.data.set(record.snapshot.id, record);
      this.fileIds.set(record.snapshot.id, fileId);
      this.fileTexts.set(fileId, text);
    }
  }
  private async importLegacy(raw: unknown): Promise<void> {
    const legacy = parseCommandHistory(raw);
    const original = JSON.stringify(raw);
    const known = this.deletedSessions;
    const unknownDeletion = this.state.deletedFiles.some((file) => known[file] === undefined);
    const copied: Array<{ file: string; keepLocal: boolean }> = [];
    for (const old of legacy.sessions) {
      if (this.deleted.has(old.snapshot.id)) continue;
      copied.push(await this.importRecord(old, unknownDeletion));
    }
    await this.persistState({
      ...this.state,
      legacyImported: true,
      activeSessionId: this.state.activeSessionId ?? this.visibleSelection(legacy.activeSessionId),
    });
    for (const { file } of copied) await this.verifyStoredFile(file);
    if (copied.some((copy) => copy.keepLocal))
      this.lastFailure = new CommandPersistenceFailure('LEGACY_DIVERGED');
    else this.cleanupLegacy(original);
  }
  private async importRecord(
    old: CommandHistoryEnvelope['sessions'][number],
    unknownDeletion: boolean,
  ): Promise<{ file: string; keepLocal: boolean }> {
    const existing = this.data.get(old.snapshot.id);
    let keepLocal = false;
    if (existing === undefined) {
      // Version 1 tombstones cannot identify a missing logical session from another device.
      if (unknownDeletion) throw new Error('Cannot match local history to an older deletion');
      const record = { ...old, createdAt: old.updatedAt, ...commandSessionMetadata(old.snapshot) };
      this.data.set(old.snapshot.id, record);
      await this.persistRecord(record);
    } else {
      const different = JSON.stringify(existing.snapshot) !== JSON.stringify(old.snapshot);
      if (existing.updatedAt < old.updatedAt || (existing.updatedAt === old.updatedAt && different))
        throw new Error('Conflicting import');
      // A newer shared file cannot prove that another device's distinct earlier draft was copied.
      keepLocal = this.state.legacyImported && different;
    }
    const file = this.fileIds.get(old.snapshot.id);
    if (file === undefined) this.fail('READBACK_MISMATCH');
    return { file, keepLocal };
  }
  private async verifyStoredFile(fileId: string): Promise<void> {
    try {
      if (
        (await this.options.storage.read({ kind: 'session', fileId })) ===
        this.fileTexts.get(fileId)
      )
        return;
    } catch {
      // A failed read cannot confirm that these are still the bytes this store saw.
    }
    this.fail('READBACK_MISMATCH');
  }
  private cleanupLegacy(original: string): void {
    try {
      const current = this.options.storage.loadLegacy();
      if (current == null) return;
      if (JSON.stringify(current) !== original)
        throw new Error('Local history changed during import');
      this.options.storage.clearLegacy();
      if (this.options.storage.loadLegacy() != null) throw new Error('Cleanup unverified');
    } catch {
      this.lastFailure = new CommandPersistenceFailure('LEGACY_CLEANUP_FAILED');
    }
  }
  private async cleanupDeleted(): Promise<boolean> {
    let clean = true;
    for (const id of this.state.deletedFiles) {
      try {
        await this.options.storage.remove(id);
        if ((await this.options.storage.read({ kind: 'session', fileId: id })) !== null)
          throw new Error('Delete unverified');
      } catch {
        clean = false;
        this.lastFailure = new CommandPersistenceFailure('DELETE_FAILED');
      }
    }
    return clean;
  }
  private capture(value: unknown): HistoricalCommandSnapshot {
    try {
      return projectCommandSnapshot(value);
    } catch {
      this.fail('INVALID_SNAPSHOT');
    }
  }
  async save(value: unknown): Promise<void> {
    const snapshot = this.capture(value);
    return this.enqueue(() => this.saveSnapshot(snapshot, false));
  }
  async create(value: unknown, current: () => boolean = () => true): Promise<void> {
    const snapshot = this.capture(value);
    return this.enqueue(() => this.saveSnapshot(snapshot, true, current));
  }
  private stage(snapshot: HistoricalCommandSnapshot): HistoricalCommandSession {
    if (this.deleted.has(snapshot.id)) this.fail('DELETED_SESSION');
    const previous = this.data.get(snapshot.id);
    const changed =
      previous === undefined || commandActivity(previous.snapshot) !== commandActivity(snapshot);
    const time = changed ? this.options.now() : previous.updatedAt;
    if (!Number.isFinite(time)) this.fail('INVALID_SNAPSHOT');
    return {
      handles: 'historical',
      createdAt: previous?.createdAt ?? time,
      updatedAt: time,
      ...commandSessionMetadata(snapshot, previous),
      snapshot,
    };
  }
  private async saveSnapshot(
    snapshot: HistoricalCommandSnapshot,
    select: boolean,
    current: () => boolean = () => true,
  ): Promise<void> {
    const record = this.stage(snapshot);
    if (hasCommandHistoryContent(snapshot) || this.data.has(snapshot.id))
      this.data.set(snapshot.id, record);
    this.writable();
    if (this.data.has(snapshot.id)) await this.persistRecord(record);
    if (!current()) throw new Error('Session change retired');
    if (select || this.state.activeSessionId === snapshot.id) {
      await this.persistState({
        ...this.state,
        activeSessionId: this.visibleSelection(snapshot.id),
      });
    }
    this.lastFailure = null;
  }
  select(id: string, current: () => boolean = () => true): Promise<void> {
    return this.enqueue(async () => {
      this.writable();
      if (!this.data.has(id)) this.fail('MISSING_SESSION');
      if (!current()) throw new Error('Session selection retired');
      await this.persistState({ ...this.state, activeSessionId: id });
      this.lastFailure = null;
    });
  }
  remove(id: string): Promise<void> {
    return this.enqueue(() => this.deleteRecords([id]));
  }
  clearHistory(): Promise<void> {
    return this.enqueue(() => this.deleteRecords([...this.data.keys()]));
  }
  clearCompleted(): Promise<void> {
    return this.enqueue(() =>
      this.deleteRecords(
        [...this.data.values()]
          .filter(
            (record) =>
              record.snapshot.id !== this.activeId() && isCompletedCommandSession(record.snapshot),
          )
          .map((record) => record.snapshot.id),
      ),
    );
  }
  private async deleteRecords(ids: readonly string[]): Promise<void> {
    this.writable();
    for (const id of ids) {
      const record = this.data.get(id);
      if (record === undefined) this.fail('MISSING_SESSION');
      if (hasUnresolvedCommandWrites(record.snapshot)) this.fail('UNRESOLVED_WRITES');
    }
    const files = ids.flatMap((id) => {
      const file = this.fileIds.get(id);
      return file === undefined ? [] : [[file, id] as const];
    });
    for (const [file] of files) await this.verifyStoredFile(file);
    await this.persistState({
      ...this.state,
      version: 2,
      deletedSessions: {
        ...this.deletedSessions,
        ...Object.fromEntries(files),
      },
      activeSessionId: ids.includes(this.state.activeSessionId ?? '')
        ? null
        : this.state.activeSessionId,
      deletedFiles: [...new Set([...this.state.deletedFiles, ...files.map(([file]) => file)])],
    });
    for (const [file] of files) this.fileTexts.delete(file);
    for (const id of ids) {
      this.deleted.add(id);
      this.data.delete(id);
      this.fileIds.delete(id);
    }
    this.lastFailure = null;
    if (!(await this.cleanupDeleted())) this.fail('DELETE_FAILED');
  }
  private async persistRecord(record: HistoricalCommandSession): Promise<void> {
    let fileId = this.fileIds.get(record.snapshot.id);
    if (fileId === undefined) {
      fileId = this.options.fileId();
      if (
        !isCommandSessionFileId(fileId) ||
        this.fileTexts.has(fileId) ||
        this.state.deletedFiles.includes(fileId)
      )
        this.fail('INVALID_SNAPSHOT');
      this.fileIds.set(record.snapshot.id, fileId);
      this.fileTexts.set(fileId, null);
    }
    let text: string;
    try {
      text = JSON.stringify(parseCommandSessionFile({ version: 1, ...record }));
    } catch {
      this.fail('INVALID_SNAPSHOT');
    }
    if (new TextEncoder().encode(text).byteLength > MAX_FILE_BYTES) this.fail('HISTORY_LIMIT');
    const previous = this.fileTexts.get(fileId) ?? null;
    await this.writeVerified(
      { kind: 'session', fileId },
      text,
      previous,
      (raw) => JSON.stringify(parseFile(raw)) === text,
    );
    this.fileTexts.set(fileId, text);
  }
  private async persistState(candidate: HistoryState): Promise<void> {
    const text = JSON.stringify(stateSchema.parse(candidate));
    await this.writeVerified(
      { kind: 'state' },
      text,
      this.stateText,
      (raw) => JSON.stringify(stateSchema.parse(JSON.parse(raw) as unknown)) === text,
    );
    this.state = candidate;
    this.stateText = text;
  }
  private async writeVerified(
    key: CommandHistoryFileKey,
    text: string,
    previous: string | null,
    validate: (raw: string) => boolean,
  ): Promise<void> {
    try {
      if (text !== previous) {
        await this.options.storage.write(key, text, previous);
        // Remember only bytes this writer submitted; compare-before-write still rejects external changes.
        if (key.kind === 'state') this.stateText = text;
        else this.fileTexts.set(key.fileId, text);
      }
    } catch {
      this.fail('WRITE_FAILED');
    }
    try {
      const raw = await this.options.storage.read(key);
      if (raw !== text || !validate(raw)) this.fail('READBACK_MISMATCH');
    } catch {
      this.fail('READBACK_MISMATCH');
    }
  }
}
