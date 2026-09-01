import { TFile, type App } from 'obsidian';
import type {
  MoveRecovery,
  TaskApplicationApi,
  TaskCommandResult,
  TaskRef,
  TaskSnapshot,
} from '../../tasks';
import type { WorkNoteSnapshot } from './types';

interface WorkNoteDeletionSource {
  list(): readonly WorkNoteSnapshot[];
  get(path: string): WorkNoteSnapshot | undefined;
}

interface WorkNoteDeletionPreviewState {
  readonly note: WorkNoteSnapshot;
  readonly tasks: readonly TaskSnapshot[];
  readonly identity: WorkNoteDeletionIdentity;
  readonly frontmatterRaw: string;
  readonly attemptGeneration: number;
}

type ExpectedTaskRevision = TaskRef;

type WorkNoteDeletionAction = 'cancel' | 'move-to-project' | 'move-to-work-note';

interface VaultDeletionTransactions {
  readonly tails: Map<string, Promise<void>>;
  readonly generations: Map<string, number>;
  readonly recoveryOnly: Map<string, number>;
  readonly recoveries: Map<string, WorkNoteDeletionRecovery>;
}

const vaultDeletionTransactions = new WeakMap<object, VaultDeletionTransactions>();

function cloneRecovery(recovery: WorkNoteDeletionRecovery): WorkNoteDeletionRecovery {
  return {
    ...recovery,
    settledTaskRefs: recovery.settledTaskRefs.map((ref) => ({ ...ref })),
    remainingTaskRefs: recovery.remainingTaskRefs.map((ref) => ({ ...ref })),
    sourceIdentity: { ...recovery.sourceIdentity },
    copiedSourceRemains: recovery.copiedSourceRemains.map((entry) => ({
      ...entry,
      source: { ...entry.source },
      copiedTask: { ...entry.copiedTask, ref: { ...entry.copiedTask.ref } },
    })),
  };
}

export interface WorkNoteDeletionRecovery {
  readonly notePath: string;
  readonly destinationPath: string;
  readonly settledTaskRefs: readonly TaskRef[];
  readonly remainingTaskRefs: readonly TaskRef[];
  readonly settledTaskCount: number;
  readonly remainingTaskCount: number;
  /** A destination copy already exists; restart must only remove the guarded source. */
  readonly copiedSourceRemains: readonly MoveRecovery[];
  /** Exact source observation at the partial boundary; restart is a CAS operation. */
  readonly sourceIdentity: WorkNoteDeletionIdentity;
  /** Consumed-attempt generation; only this explicit recovery may continue the partial move. */
  readonly attemptGeneration: number;
}

export interface WorkNoteDeletionIdentity {
  readonly path: string;
  readonly content: string;
  readonly mtime: number;
  readonly size: number;
}

interface WorkNoteQuarantineIdentity extends WorkNoteDeletionIdentity {
  readonly originalPath: string;
}

type QuarantineResult =
  | { readonly type: 'ok'; readonly identity: WorkNoteQuarantineIdentity }
  | { readonly type: 'conflict' | 'io-error' };

export interface WorkNoteDeletionPort {
  observe(path: string): Promise<WorkNoteDeletionIdentity | null>;
  quarantine(expected: WorkNoteDeletionIdentity): Promise<QuarantineResult>;
  remove(
    expected: WorkNoteQuarantineIdentity,
  ): Promise<{ readonly type: 'ok' | 'conflict' | 'io-error' }>;
  restore(expected: WorkNoteQuarantineIdentity): Promise<void>;
}

export type WorkNoteDeletionPreview =
  | { readonly type: 'decision-required'; readonly taskCount: number }
  | { readonly type: 'ready'; readonly taskCount: 0 }
  | { readonly type: 'invalid'; readonly reason: 'missing-source' | 'ambiguous-ownership' };

export interface WorkNoteDeleteCommand {
  readonly action: WorkNoteDeletionAction;
  readonly destinationWorkNotePath?: string;
  readonly expectedTaskRevisions: readonly ExpectedTaskRevision[];
  readonly recovery?: WorkNoteDeletionRecovery;
  readonly note?: WorkNoteSnapshot;
}

export type WorkNoteDeletionResult =
  | { readonly type: 'cancelled' }
  | { readonly type: 'invalid-decision'; readonly reason: string }
  | { readonly type: 'ok'; readonly path: string; readonly movedTaskCount: number }
  | {
      readonly type: 'partial';
      readonly path: string;
      readonly reason: 'external-edit' | 'io-error' | 'ambiguous-task' | 'not-found';
      readonly recovery: WorkNoteDeletionRecovery;
    };

function taskKey(ref: TaskRef): string {
  return `${ref.filePath}\u0000${String(ref.line)}\u0000${ref.revision}`;
}

function sourceLineKey(ref: TaskRef): string {
  return `${ref.filePath}\u0000${String(ref.line)}`;
}

type DeletionPartialReason = Extract<
  WorkNoteDeletionResult,
  { readonly type: 'partial' }
>['reason'];

function partialReason(result: TaskCommandResult): DeletionPartialReason {
  if (result.type === 'conflict') return 'external-edit';
  if (result.type === 'ambiguous') return 'ambiguous-task';
  if (result.type === 'not-found') return 'not-found';
  return 'io-error';
}

function sameIdentity(
  left: WorkNoteDeletionIdentity | null,
  right: WorkNoteDeletionIdentity,
): boolean {
  return (
    left !== null &&
    left.path === right.path &&
    left.content === right.content &&
    left.mtime === right.mtime &&
    left.size === right.size
  );
}

function rawFrontmatter(content: string): string {
  const separator = content.startsWith('---\r\n') ? '\r\n' : '\n';
  if (!content.startsWith(`---${separator}`)) return '';
  const end = content.indexOf(`${separator}---`, 4);
  return end < 0 ? content : content.slice(0, end + separator.length + 3);
}

/** Mirrors the canonical complete-root deletion shape without becoming a Task parser. */
function expectedContentAfterTaskRemoval(
  content: string,
  task: TaskSnapshot,
  expectedLine: number,
): string | null {
  const block = task.source.originalBlock;
  if (block.length === 0) return null;
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '\n' && index + 1 < content.length) starts.push(index + 1);
  }
  const at = starts[expectedLine];
  if (at === undefined) return null;
  if (!content.startsWith(block, at)) return null;
  const after = at + block.length;
  if (after !== content.length && content[after] !== '\n' && content[after] !== '\r') return null;
  if (content.startsWith('\r\n', after)) return content.slice(0, at) + content.slice(after + 2);
  if (content[after] === '\n') return content.slice(0, at) + content.slice(after + 1);
  if (at > 0 && content[at - 1] === '\n') {
    const from = at > 1 && content[at - 2] === '\r' ? at - 2 : at - 1;
    return content.slice(0, from) + content.slice(after);
  }
  return content.slice(0, at) + content.slice(after);
}

function expectedTaskTransition(
  before: WorkNoteDeletionIdentity,
  after: WorkNoteDeletionIdentity | null,
  task: TaskSnapshot,
  expectedLine: number,
): after is WorkNoteDeletionIdentity {
  if (!after) return false;
  return after.content === expectedContentAfterTaskRemoval(before.content, task, expectedLine);
}

function blockLineCount(task: TaskSnapshot): number {
  return task.source.originalBlock.split(/\r?\n/u).length;
}

class ObsidianWorkNoteDeletionPort implements WorkNoteDeletionPort {
  constructor(private readonly app: App) {}

  async observe(path: string): Promise<WorkNoteDeletionIdentity | null> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return null;
    const content = await this.app.vault.read(file);
    return { path, content, mtime: file.stat.mtime, size: file.stat.size };
  }

  async quarantine(expected: WorkNoteDeletionIdentity): Promise<QuarantineResult> {
    try {
      if (!sameIdentity(await this.observe(expected.path), expected)) return { type: 'conflict' };
      const file = this.app.vault.getAbstractFileByPath(expected.path);
      if (!(file instanceof TFile)) return { type: 'conflict' };
      const quarantinePath = `${expected.path}.task-calendar-quarantine-${String(Date.now())}`;
      await this.app.vault.rename(file, quarantinePath);
      const observed = await this.observe(quarantinePath);
      if (!observed) return { type: 'io-error' };
      const quarantined = { ...observed, originalPath: expected.path };
      if (observed.content !== expected.content || observed.size !== expected.size) {
        await this.restore(quarantined);
        return { type: 'conflict' };
      }
      return { type: 'ok', identity: quarantined };
    } catch {
      return { type: 'io-error' };
    }
  }

  async remove(
    expected: WorkNoteQuarantineIdentity,
  ): Promise<{ readonly type: 'ok' | 'conflict' | 'io-error' }> {
    try {
      if (!sameIdentity(await this.observe(expected.path), expected)) return { type: 'conflict' };
      const file = this.app.vault.getAbstractFileByPath(expected.path);
      if (!(file instanceof TFile)) return { type: 'conflict' };
      await this.app.fileManager.trashFile(file);
      return { type: 'ok' };
    } catch {
      return { type: 'io-error' };
    }
  }

  async restore(expected: WorkNoteQuarantineIdentity): Promise<void> {
    const quarantined = this.app.vault.getAbstractFileByPath(expected.path);
    if (!(quarantined instanceof TFile)) return;
    if (this.app.vault.getAbstractFileByPath(expected.originalPath)) return;
    await this.app.vault.rename(quarantined, expected.originalPath);
  }
}

/**
 * Coordinates destructive Work Note deletion without becoming a Task or note data authority.
 * Recovery capability state is vault-scoped so a caller can reacquire it after UI teardown.
 */
export class WorkNoteDeletionCoordinator {
  private previewed?: WorkNoteDeletionPreviewState;
  private readonly deletion: WorkNoteDeletionPort;

  constructor(
    private readonly app: App,
    private readonly tasks: Pick<TaskApplicationApi, 'queries' | 'execute'>,
    private readonly workNotes: WorkNoteDeletionSource,
    deletion?: WorkNoteDeletionPort,
  ) {
    this.deletion = deletion ?? new ObsidianWorkNoteDeletionPort(app);
  }

  private transactions(): VaultDeletionTransactions {
    let transactions = vaultDeletionTransactions.get(this.app.vault);
    if (!transactions) {
      transactions = {
        tails: new Map(),
        generations: new Map(),
        recoveryOnly: new Map(),
        recoveries: new Map(),
      };
      vaultDeletionTransactions.set(this.app.vault, transactions);
    }
    return transactions;
  }

  async preview(note: WorkNoteSnapshot): Promise<WorkNoteDeletionPreview> {
    const current = this.workNotes.get(note.path);
    if (!current || current.path !== note.path) {
      return { type: 'invalid', reason: 'missing-source' };
    }
    if (
      current.projectPath !== note.projectPath ||
      current.kind !== note.kind ||
      current.presetRevision !== note.presetRevision ||
      current.presetFingerprint !== note.presetFingerprint ||
      current.diagnostics.some(({ type }) =>
        ['multiple-projects', 'ambiguous-project', 'invalid-project-entry'].includes(type),
      )
    ) {
      return { type: 'invalid', reason: 'ambiguous-ownership' };
    }
    const identity = await this.deletion.observe(note.path);
    if (!identity) return { type: 'invalid', reason: 'missing-source' };
    const tasks = this.tasks.queries.list({ filePath: note.path });
    this.previewed = {
      note: current,
      tasks,
      identity,
      frontmatterRaw: rawFrontmatter(identity.content),
      attemptGeneration: this.transactions().generations.get(note.path) ?? 0,
    };
    return tasks.length === 0
      ? { type: 'ready', taskCount: 0 }
      : { type: 'decision-required', taskCount: tasks.length };
  }

  previewedTaskRevisions(): readonly TaskRef[] {
    return (this.previewed?.tasks ?? []).map(({ ref }) => ({ ...ref }));
  }

  /** Coordinator-owned recovery survives inspector/panel teardown and is safe to resume verbatim. */
  pendingRecovery(notePath: string): WorkNoteDeletionRecovery | undefined {
    const recovery = this.transactions().recoveries.get(notePath);
    return recovery ? cloneRecovery(recovery) : undefined;
  }

  /** A copied destination can never be abandoned into an ordinary retry that could recopy it. */
  abandonRecovery(
    notePath: string,
  ):
    | { readonly type: 'ok' }
    | { readonly type: 'blocked'; readonly reason: 'source-cleanup-required' } {
    const transactions = this.transactions();
    if (transactions.recoveryOnly.has(notePath)) {
      return { type: 'blocked', reason: 'source-cleanup-required' };
    }
    transactions.recoveries.delete(notePath);
    return { type: 'ok' };
  }

  private decision(
    note: WorkNoteSnapshot,
    command: WorkNoteDeleteCommand,
  ): { readonly destinationPath: string } | WorkNoteDeletionResult {
    if (command.action === 'cancel') return { type: 'cancelled' };
    if (command.action === 'move-to-project') return { destinationPath: note.projectPath };
    const destinationPath = command.destinationWorkNotePath;
    const destination = destinationPath ? this.workNotes.get(destinationPath) : undefined;
    if (
      !destination ||
      destination.path === note.path ||
      destination.projectPath !== note.projectPath ||
      destination.diagnostics.some(({ type }) =>
        ['multiple-projects', 'ambiguous-project', 'invalid-project-entry'].includes(type),
      )
    ) {
      return { type: 'invalid-decision', reason: 'Choose another Work Note in this Project.' };
    }
    return { destinationPath: destination.path };
  }

  private recovery(
    notePath: string,
    destinationPath: string,
    sourceIdentity: WorkNoteDeletionIdentity,
    settled: readonly TaskRef[],
    remaining: readonly TaskRef[],
    copiedSourceRemains: readonly MoveRecovery[] = [],
  ): WorkNoteDeletionRecovery {
    const attemptGeneration = this.transactions().generations.get(notePath) ?? 0;
    if (copiedSourceRemains.length > 0) {
      this.transactions().recoveryOnly.set(notePath, attemptGeneration);
    }
    const recovery: WorkNoteDeletionRecovery = {
      notePath,
      destinationPath,
      settledTaskRefs: settled.map((ref) => ({ ...ref })),
      remainingTaskRefs: remaining.map((ref) => ({ ...ref })),
      settledTaskCount: settled.length,
      remainingTaskCount: remaining.length,
      sourceIdentity: { ...sourceIdentity },
      attemptGeneration,
      copiedSourceRemains: copiedSourceRemains.map((entry) => ({
        ...entry,
        source: { ...entry.source },
        copiedTask: { ...entry.copiedTask, ref: { ...entry.copiedTask.ref } },
      })),
    };
    this.transactions().recoveries.set(notePath, cloneRecovery(recovery));
    return recovery;
  }

  private sourceChangedBeforeSettlement(
    note: WorkNoteSnapshot,
    command: WorkNoteDeleteCommand,
    identity: WorkNoteDeletionIdentity | null,
    previewed: WorkNoteDeletionPreviewState,
  ): boolean {
    return (
      !identity ||
      !sameIdentity(identity, command.recovery?.sourceIdentity ?? previewed.identity) ||
      rawFrontmatter(identity.content) !== previewed.frontmatterRaw ||
      this.workNotes.get(note.path)?.projectPath !== previewed.note.projectPath
    );
  }

  private enqueue<T>(notePath: string, operation: () => Promise<T>): Promise<T> {
    const { tails } = this.transactions();
    const previous = tails.get(notePath) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    tails.set(notePath, tail);
    void tail.then(() => {
      if (tails?.get(notePath) === tail) tails.delete(notePath);
    });
    return current;
  }

  delete(command: WorkNoteDeleteCommand): Promise<WorkNoteDeletionResult> {
    if (command.action === 'cancel') return Promise.resolve({ type: 'cancelled' });
    const previewed = this.previewed;
    const note = command.note ?? previewed?.note;
    if (!note || !previewed || previewed.note.path !== note.path) {
      return Promise.resolve({
        type: 'invalid-decision',
        reason: 'Preview the Work Note first.',
      });
    }
    return this.enqueue(note.path, () => this.deleteInTransaction(command, note, previewed));
  }

  // The explicit phases keep every destructive boundary and recovery identity auditable together.
  // eslint-disable-next-line sonarjs/cognitive-complexity
  private async deleteInTransaction(
    command: WorkNoteDeleteCommand,
    note: WorkNoteSnapshot,
    previewed: WorkNoteDeletionPreviewState,
  ): Promise<WorkNoteDeletionResult> {
    const transactions = this.transactions();
    const currentGeneration = transactions.generations.get(note.path) ?? 0;
    const expectedGeneration = command.recovery?.attemptGeneration ?? previewed.attemptGeneration;
    const recoveryOnlyGeneration = transactions.recoveryOnly.get(note.path);
    if (
      recoveryOnlyGeneration !== undefined &&
      command.recovery?.attemptGeneration !== recoveryOnlyGeneration
    ) {
      return {
        type: 'invalid-decision',
        reason: 'A partial copy exists. Use its explicit deletion recovery.',
      };
    }
    if (expectedGeneration !== currentGeneration) {
      return {
        type: 'invalid-decision',
        reason: 'This deletion preview was already consumed. Use its explicit recovery.',
      };
    }
    const decision = this.decision(note, command);
    if ('type' in decision) return decision;
    if (
      command.recovery &&
      (command.recovery.notePath !== note.path ||
        command.recovery.destinationPath !== decision.destinationPath)
    ) {
      return { type: 'invalid-decision', reason: 'The recovery destination changed.' };
    }

    const initialIdentity = await this.deletion.observe(note.path);
    if (this.sourceChangedBeforeSettlement(note, command, initialIdentity, previewed)) {
      return {
        type: 'partial',
        path: note.path,
        reason: 'external-edit',
        recovery: this.recovery(
          note.path,
          decision.destinationPath,
          initialIdentity ?? previewed.identity,
          command.recovery?.settledTaskRefs ?? [],
          command.expectedTaskRevisions,
          command.recovery?.copiedSourceRemains ?? [],
        ),
      };
    }
    if (!command.recovery) {
      transactions.recoveries.delete(note.path);
      transactions.generations.set(note.path, currentGeneration + 1);
    }

    let settlementIdentity = initialIdentity!;
    const settled = [...(command.recovery?.settledTaskRefs ?? [])];
    const previewTasks = new Map(previewed.tasks.map((task) => [taskKey(task.ref), task]));
    const expectedSourceLine = (task: TaskSnapshot): number => {
      const original = previewTasks.get(taskKey(task.ref)) ?? task;
      return settled.reduce((line, ref) => {
        const removed = previewTasks.get(taskKey(ref));
        return removed && removed.source.line < original.source.line
          ? line - blockLineCount(removed)
          : line;
      }, original.source.line);
    };
    const stablePreviewTask = (task: TaskSnapshot): TaskSnapshot | undefined => {
      const exact = previewTasks.get(taskKey(task.ref));
      if (exact && !settled.some((ref) => taskKey(ref) === taskKey(exact.ref))) return exact;
      const candidates = previewed.tasks.filter(
        (candidate) =>
          !settled.some((ref) => taskKey(ref) === taskKey(candidate.ref)) &&
          candidate.source.originalBlock === task.source.originalBlock &&
          expectedSourceLine(candidate) === task.source.line,
      );
      return candidates.length === 1 ? candidates[0] : undefined;
    };
    const copiedSourceRemains = [...(command.recovery?.copiedSourceRemains ?? [])];
    for (let index = 0; index < copiedSourceRemains.length; index += 1) {
      const recovery = copiedSourceRemains[index]!;
      if (!sameIdentity(await this.deletion.observe(note.path), settlementIdentity)) {
        return {
          type: 'partial',
          path: note.path,
          reason: 'external-edit',
          recovery: this.recovery(
            note.path,
            decision.destinationPath,
            settlementIdentity,
            settled,
            command.expectedTaskRevisions.filter(
              (ref) => !settled.some((done) => taskKey(done) === taskKey(ref)),
            ),
            copiedSourceRemains.slice(index),
          ),
        };
      }
      const destinationCopy = this.tasks.queries
        .list({ filePath: recovery.targetPath })
        .find(({ ref }) => taskKey(ref) === taskKey(recovery.copiedTask.ref));
      if (!destinationCopy) {
        return {
          type: 'partial',
          path: note.path,
          reason: 'external-edit',
          recovery: this.recovery(
            note.path,
            decision.destinationPath,
            settlementIdentity,
            settled,
            command.expectedTaskRevisions.filter(
              (ref) => !settled.some((done) => taskKey(done) === taskKey(ref)),
            ),
            copiedSourceRemains.slice(index),
          ),
        };
      }
      const sourceTask = this.tasks.queries
        .list({ filePath: note.path })
        .find(({ ref }) => taskKey(ref) === taskKey(recovery.source));
      if (!sourceTask) {
        return {
          type: 'partial',
          path: note.path,
          reason: 'external-edit',
          recovery: this.recovery(
            note.path,
            decision.destinationPath,
            settlementIdentity,
            settled,
            command.expectedTaskRevisions,
            copiedSourceRemains.slice(index),
          ),
        };
      }
      const stableSourceTask = stablePreviewTask(sourceTask);
      if (!stableSourceTask) {
        return {
          type: 'partial',
          path: note.path,
          reason: 'ambiguous-task',
          recovery: this.recovery(
            note.path,
            decision.destinationPath,
            settlementIdentity,
            settled,
            command.expectedTaskRevisions.filter(
              (ref) => !settled.some((done) => taskKey(done) === taskKey(ref)),
            ),
            copiedSourceRemains.slice(index),
          ),
        };
      }
      const cleanup = await this.tasks.execute({ type: 'delete', ref: recovery.source });
      const afterCleanup = await this.deletion.observe(note.path);
      if (cleanup.type !== 'ok') {
        return {
          type: 'partial',
          path: note.path,
          reason: partialReason(cleanup),
          recovery: this.recovery(
            note.path,
            decision.destinationPath,
            afterCleanup ?? settlementIdentity,
            settled,
            command.expectedTaskRevisions.filter(
              (ref) => !settled.some((done) => taskKey(done) === taskKey(ref)),
            ),
            copiedSourceRemains.slice(index),
          ),
        };
      }
      if (
        !expectedTaskTransition(
          settlementIdentity,
          afterCleanup,
          stableSourceTask,
          expectedSourceLine(stableSourceTask),
        )
      ) {
        return {
          type: 'partial',
          path: note.path,
          reason: afterCleanup ? 'external-edit' : 'not-found',
          recovery: this.recovery(
            note.path,
            decision.destinationPath,
            settlementIdentity,
            settled,
            command.expectedTaskRevisions,
            copiedSourceRemains.slice(index),
          ),
        };
      }
      settlementIdentity = afterCleanup;
      settled.push(stableSourceTask.ref);
    }

    const currentTasks = this.tasks.queries.list({ filePath: note.path });
    const expectedBySource = new Map(
      command.expectedTaskRevisions.map((ref) => [sourceLineKey(ref), ref] as const),
    );
    const settledKeys = new Set(settled.map(taskKey));
    const pending = currentTasks.filter(({ ref }) => !settledKeys.has(taskKey(ref)));
    const expectedPending = command.expectedTaskRevisions.filter(
      (ref) => !settledKeys.has(taskKey(ref)),
    );
    const currentSources = new Set(pending.map(({ ref }) => sourceLineKey(ref)));
    const expectedTaskMissing = expectedPending.some(
      (ref) => !currentSources.has(sourceLineKey(ref)),
    );
    const stale = pending.find(({ ref }) => {
      const expected = expectedBySource.get(sourceLineKey(ref));
      return !expected || expected.revision !== ref.revision;
    });
    if (stale || expectedTaskMissing || pending.length !== expectedPending.length) {
      return {
        type: 'partial',
        path: note.path,
        reason: 'external-edit',
        recovery: this.recovery(
          note.path,
          decision.destinationPath,
          settlementIdentity,
          settled,
          expectedPending,
        ),
      };
    }

    for (let index = 0; index < pending.length; index += 1) {
      const task = pending[index]!;
      if (!sameIdentity(await this.deletion.observe(note.path), settlementIdentity)) {
        return {
          type: 'partial',
          path: note.path,
          reason: 'external-edit',
          recovery: this.recovery(
            note.path,
            decision.destinationPath,
            settlementIdentity,
            settled,
            pending.slice(index).map(({ ref }) => ref),
          ),
        };
      }
      const result = await this.tasks.execute({
        type: 'move',
        ref: task.ref,
        destination: { filePath: decision.destinationPath, insertion: { type: 'append' } },
      });
      const afterMove = await this.deletion.observe(note.path);
      if (result.type !== 'ok') {
        const moveRecovery =
          result.type === 'partial' && result.operation === 'move' ? [result.recovery] : [];
        return {
          type: 'partial',
          path: note.path,
          reason: partialReason(result),
          recovery: this.recovery(
            note.path,
            decision.destinationPath,
            afterMove ?? settlementIdentity,
            settled,
            pending.slice(index).map(({ ref }) => ref),
            moveRecovery,
          ),
        };
      }
      if (!expectedTaskTransition(settlementIdentity, afterMove, task, expectedSourceLine(task))) {
        return {
          type: 'partial',
          path: note.path,
          reason: afterMove ? 'external-edit' : 'not-found',
          recovery: this.recovery(
            note.path,
            decision.destinationPath,
            settlementIdentity,
            settled,
            pending.slice(index).map(({ ref }) => ref),
          ),
        };
      }
      settlementIdentity = afterMove;
      settled.push(task.ref);
      settledKeys.add(taskKey(task.ref));
    }

    if (!this.tasks.queries.rescan) {
      return {
        type: 'partial',
        path: note.path,
        reason: 'io-error',
        recovery: this.recovery(
          note.path,
          decision.destinationPath,
          settlementIdentity,
          settled,
          [],
        ),
      };
    }
    try {
      await this.tasks.queries.rescan();
    } catch {
      return {
        type: 'partial',
        path: note.path,
        reason: 'io-error',
        recovery: this.recovery(
          note.path,
          decision.destinationPath,
          settlementIdentity,
          settled,
          [],
        ),
      };
    }

    const finalUnexpectedTasks = this.tasks.queries
      .list({ filePath: note.path })
      .filter(({ ref }) => !settledKeys.has(taskKey(ref)));
    if (finalUnexpectedTasks.length > 0) {
      return {
        type: 'partial',
        path: note.path,
        reason: 'external-edit',
        recovery: this.recovery(
          note.path,
          decision.destinationPath,
          settlementIdentity,
          settled,
          finalUnexpectedTasks.map(({ ref }) => ref),
        ),
      };
    }

    const finalIdentity = await this.deletion.observe(note.path);
    if (
      !sameIdentity(finalIdentity, settlementIdentity) ||
      rawFrontmatter(finalIdentity!.content) !== previewed.frontmatterRaw
    ) {
      return {
        type: 'partial',
        path: note.path,
        reason: 'external-edit',
        recovery: this.recovery(
          note.path,
          decision.destinationPath,
          finalIdentity ?? settlementIdentity,
          settled,
          [],
        ),
      };
    }
    const deletionIdentity = finalIdentity ?? settlementIdentity;
    const quarantined = await this.deletion.quarantine(deletionIdentity);
    if (quarantined.type !== 'ok') {
      return {
        type: 'partial',
        path: note.path,
        reason: quarantined.type === 'conflict' ? 'external-edit' : 'io-error',
        recovery: this.recovery(note.path, decision.destinationPath, deletionIdentity, settled, []),
      };
    }
    try {
      await this.tasks.queries.rescan();
      const afterQuarantine = this.tasks.queries
        .list({ filePath: note.path })
        .filter(({ ref }) => !settledKeys.has(taskKey(ref)));
      if (afterQuarantine.length > 0) {
        await this.deletion.restore(quarantined.identity);
        return {
          type: 'partial',
          path: note.path,
          reason: 'external-edit',
          recovery: this.recovery(
            note.path,
            decision.destinationPath,
            deletionIdentity,
            settled,
            afterQuarantine.map(({ ref }) => ref),
          ),
        };
      }
      const removed = await this.deletion.remove(quarantined.identity);
      if (removed.type === 'ok') {
        transactions.recoveryOnly.delete(note.path);
        transactions.recoveries.delete(note.path);
        if (command.recovery) {
          transactions.generations.set(note.path, currentGeneration + 1);
        }
        return { type: 'ok', path: note.path, movedTaskCount: settled.length };
      }
      await this.deletion.restore(quarantined.identity);
      return {
        type: 'partial',
        path: note.path,
        reason: removed.type === 'conflict' ? 'external-edit' : 'io-error',
        recovery: this.recovery(note.path, decision.destinationPath, deletionIdentity, settled, []),
      };
    } catch {
      await this.deletion.restore(quarantined.identity).catch(() => undefined);
      return {
        type: 'partial',
        path: note.path,
        reason: 'io-error',
        recovery: this.recovery(note.path, decision.destinationPath, deletionIdentity, settled, []),
      };
    }
  }
}
