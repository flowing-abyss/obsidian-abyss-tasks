import { TFile, type App } from 'obsidian';
import type { TaskApplicationApi, TaskCommandResult, TaskRef, TaskSnapshot } from '../../tasks';
import type { WorkNoteSnapshot } from './types';

interface WorkNoteDeletionSource {
  list(): readonly WorkNoteSnapshot[];
  get(path: string): WorkNoteSnapshot | undefined;
}

type ExpectedTaskRevision = TaskRef;

type WorkNoteDeletionAction = 'cancel' | 'move-to-project' | 'move-to-work-note';

export interface WorkNoteDeletionRecovery {
  readonly notePath: string;
  readonly destinationPath: string;
  readonly settledTaskRefs: readonly TaskRef[];
  readonly remainingTaskRefs: readonly TaskRef[];
  readonly settledTaskCount: number;
  readonly remainingTaskCount: number;
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

/**
 * Coordinates destructive Work Note deletion without becoming a Task or note data authority.
 * The recovery record is caller-owned and can be passed back after an external edit is resolved.
 */
export class WorkNoteDeletionCoordinator {
  private previewed?: { readonly note: WorkNoteSnapshot; readonly tasks: readonly TaskSnapshot[] };

  constructor(
    private readonly app: App,
    private readonly tasks: Pick<TaskApplicationApi, 'queries' | 'execute'>,
    private readonly workNotes: WorkNoteDeletionSource,
  ) {}

  preview(note: WorkNoteSnapshot): Promise<WorkNoteDeletionPreview> {
    const current = this.workNotes.get(note.path);
    if (!current || current.path !== note.path) {
      return Promise.resolve({ type: 'invalid', reason: 'missing-source' });
    }
    if (
      current.projectPath !== note.projectPath ||
      current.diagnostics.some(({ type }) =>
        ['multiple-projects', 'ambiguous-project', 'invalid-project-entry'].includes(type),
      )
    ) {
      return Promise.resolve({ type: 'invalid', reason: 'ambiguous-ownership' });
    }
    const tasks = this.tasks.queries.list({ filePath: note.path });
    this.previewed = { note: current, tasks };
    return Promise.resolve(
      tasks.length === 0
        ? { type: 'ready', taskCount: 0 }
        : { type: 'decision-required', taskCount: tasks.length },
    );
  }

  previewedTaskRevisions(): readonly TaskRef[] {
    return (this.previewed?.tasks ?? []).map(({ ref }) => ({ ...ref }));
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
    settled: readonly TaskRef[],
    remaining: readonly TaskRef[],
  ): WorkNoteDeletionRecovery {
    return {
      notePath,
      destinationPath,
      settledTaskRefs: settled.map((ref) => ({ ...ref })),
      remainingTaskRefs: remaining.map((ref) => ({ ...ref })),
      settledTaskCount: settled.length,
      remainingTaskCount: remaining.length,
    };
  }

  async delete(command: WorkNoteDeleteCommand): Promise<WorkNoteDeletionResult> {
    if (command.action === 'cancel') return { type: 'cancelled' };
    const note = command.note ?? this.previewed?.note;
    if (!note) return { type: 'invalid-decision', reason: 'Preview the Work Note first.' };
    const decision = this.decision(note, command);
    if ('type' in decision) return decision;
    if (
      command.recovery &&
      (command.recovery.notePath !== note.path ||
        command.recovery.destinationPath !== decision.destinationPath)
    ) {
      return { type: 'invalid-decision', reason: 'The recovery destination changed.' };
    }

    const currentTasks = this.tasks.queries.list({ filePath: note.path });
    const expectedBySource = new Map(
      command.expectedTaskRevisions.map((ref) => [sourceLineKey(ref), ref] as const),
    );
    const settled = [...(command.recovery?.settledTaskRefs ?? [])];
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
        recovery: this.recovery(note.path, decision.destinationPath, settled, expectedPending),
      };
    }

    for (let index = 0; index < pending.length; index += 1) {
      const task = pending[index]!;
      const result = await this.tasks.execute({
        type: 'move',
        ref: task.ref,
        destination: { filePath: decision.destinationPath, insertion: { type: 'append' } },
      });
      if (result.type !== 'ok') {
        return {
          type: 'partial',
          path: note.path,
          reason: partialReason(result),
          recovery: this.recovery(
            note.path,
            decision.destinationPath,
            settled,
            pending.slice(index).map(({ ref }) => ref),
          ),
        };
      }
      settled.push(task.ref);
      settledKeys.add(taskKey(task.ref));
    }

    if (!this.tasks.queries.rescan) {
      return {
        type: 'partial',
        path: note.path,
        reason: 'io-error',
        recovery: this.recovery(note.path, decision.destinationPath, settled, []),
      };
    }
    try {
      await this.tasks.queries.rescan();
    } catch {
      return {
        type: 'partial',
        path: note.path,
        reason: 'io-error',
        recovery: this.recovery(note.path, decision.destinationPath, settled, []),
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
          settled,
          finalUnexpectedTasks.map(({ ref }) => ref),
        ),
      };
    }

    const file = this.app.vault.getAbstractFileByPath(note.path);
    if (!(file instanceof TFile)) {
      return { type: 'invalid-decision', reason: 'The Work Note no longer exists.' };
    }
    try {
      await this.app.fileManager.trashFile(file);
      return { type: 'ok', path: note.path, movedTaskCount: settled.length };
    } catch {
      return {
        type: 'partial',
        path: note.path,
        reason: 'io-error',
        recovery: this.recovery(note.path, decision.destinationPath, settled, []),
      };
    }
  }
}
