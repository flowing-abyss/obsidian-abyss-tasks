import {
  durationMinutes,
  localTime,
  sameTaskNodeRef,
  shiftLocalDate,
  taskNodeSourceLine,
  type TaskApplicationApi,
  type TaskCommand,
  type TaskCommandResult,
  type TaskSnapshot,
} from '../tasks';
import {
  calendarMutationTarget,
  calendarOccurrenceForRender,
  calendarOccurrenceForTask,
  calendarPatchCommand,
  calendarShiftScheduleCommand,
  calendarSpanBoundaryCommand,
} from '../views/calendarOccurrences';
import { TIMED_STEP_MINUTES } from '../views/timegrid/dragGeometry';
import type { TimedBlockKeyboardIntent } from '../views/timegrid/renderTimedBlocks';
import type {
  CalendarEditExecutor,
  CalendarEditQueue,
  CalendarEditReceipt,
} from './calendarEditQueue';
import { calendarEditWitness } from './calendarEditWitness';
import { calendarTaskWithOwnedNode, calendarTaskWithOwnedRoot } from './calendarOwnedTask';
import { proveOwnedTaskSelection, type OwnedTaskSelectionProof } from './ownedTaskSelection';
import { runAsyncAction } from './runAsyncAction';
import { taskNodeRef, taskSelectionRefPath, type TaskSelectionNode } from './taskSelection';

export interface TimedBlockKeyboardQueueHooks {
  holdPublication?(): () => void;
  onCommitted(
    task: TaskSnapshot,
    intent: TimedBlockKeyboardIntent,
    sequence: number,
    changed: boolean,
  ): void;
  onSettled(taskKey: string, sequence: number, summary: TimedBlockKeyboardSequenceSummary): void;
  onNoop?(task: TaskSnapshot, sequence: number): void;
  present(result: TaskCommandResult): void;
  onInvalidated(sequence: number): void;
}

interface TimedBlockKeyboardSequenceSummary {
  readonly executed: boolean;
  readonly anyChanged: boolean;
  readonly sourceChanged: boolean;
}

interface QueuedIntent {
  readonly intent: TimedBlockKeyboardIntent;
  readonly sequence: number;
  readonly repetitions: number;
  readonly execute: CalendarEditExecutor | undefined;
}

const MIN_START_MINUTES = 0;
const MAX_START_MINUTES = 24 * 60 - TIMED_STEP_MINUTES;
const MIN_DURATION_MINUTES = TIMED_STEP_MINUTES;
const MAX_DURATION_MINUTES = 24 * 60;
const DEFAULT_DURATION_MINUTES = 60;

function sourceKey(task: TaskSnapshot): string {
  const target = calendarOccurrenceForRender(task).source.target;
  return `${task.source.filePath}:${taskNodeSourceLine(target)}`;
}

function sourceIdentity(task: TaskSnapshot): string {
  return `${sourceKey(task)}:${task.ref.revision}`;
}

function timeMinutes(value: string | undefined): number {
  if (value === undefined || value.length === 0) return 0;
  const [hours, minutes] = value.split(':').map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

function timeString(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function extendDueCommand(
  task: TaskSnapshot,
  intent: Extract<TimedBlockKeyboardIntent, { type: 'extend-due' }>,
): TaskCommand | undefined {
  const occurrence = calendarOccurrenceForRender(task);
  if (occurrence.kind !== 'materialized') return undefined;
  const occupied = occurrence.occupied;
  const hasSpan = occupied.kind === 'interval';
  if (intent.days < 0 && !hasSpan) return undefined;
  if (occupied.kind === 'point' && occupied.roles.length === 0) return undefined;
  const base = occupied.kind === 'interval' ? occupied.due : occupied.date;
  const due = shiftLocalDate(base, intent.days);
  const start = task.planning.start ?? base;
  if (due == null || due < start) return undefined;
  return calendarSpanBoundaryCommand(task, 'create-span', due);
}

function commandFor(
  task: TaskSnapshot,
  intent: TimedBlockKeyboardIntent,
  repetitions: number,
): TaskCommand | undefined {
  switch (intent.type) {
    case 'move-time': {
      const next = clamp(
        timeMinutes(task.planning.time) + intent.deltaMinutes * repetitions,
        MIN_START_MINUTES,
        MAX_START_MINUTES,
      );
      return calendarPatchCommand(task, {
        time: { type: 'set', value: localTime(timeString(next)) },
      });
    }
    case 'resize-duration': {
      const next = clamp(
        (task.planning.duration ?? DEFAULT_DURATION_MINUTES) + intent.deltaMinutes * repetitions,
        MIN_DURATION_MINUTES,
        MAX_DURATION_MINUTES,
      );
      return calendarPatchCommand(task, {
        duration: { type: 'set', value: durationMinutes(next) },
      });
    }
    case 'shift-schedule':
      return calendarOccurrenceForTask(task) === undefined
        ? { type: 'shift-schedule', ref: task.ref, days: intent.days }
        : calendarShiftScheduleCommand(task, intent.days);
    case 'extend-due': {
      return extendDueCommand(task, intent);
    }
  }
}

function committedSnapshot(
  previous: TaskSnapshot,
  current: TaskSnapshot,
  change: {
    readonly intent: TimedBlockKeyboardIntent;
    readonly changed: boolean;
    readonly proof: OwnedTaskSelectionProof | undefined;
  },
): TaskSnapshot | undefined {
  const occurrence = calendarOccurrenceForTask(previous);
  if (occurrence === undefined) return current;
  if (occurrence.kind !== 'materialized') return undefined;
  let node: TaskSelectionNode | undefined = current;
  if (occurrence.source.target.type === 'subtask') {
    const path = taskSelectionRefPath(current, occurrence.source.target);
    node = change.changed
      ? change.proof?.nodeSuccessor(occurrence.source.target)
      : path?.[path.length - 1];
  }
  if (node === undefined) return undefined;
  return calendarTaskWithOwnedNode(occurrence, current, node, change.intent.type === 'extend-due');
}

export class TimedBlockKeyboardQueue {
  private pending_abyssPrivate: QueuedIntent[] = [];
  private processing_abyssPrivate = false;
  private nextSequence_abyssPrivate = 0;
  private activeSequence_abyssPrivate: number | undefined;
  private pointerInterrupted_abyssPrivate = false;
  private activeTaskKey_abyssPrivate: string | undefined;
  private activeTaskIdentities_abyssPrivate = new Set<string>();
  private activeSnapshot_abyssPrivate: TaskSnapshot | undefined;
  private activeExecuted_abyssPrivate = false;
  private activeAnyChanged_abyssPrivate = false;
  private activeSourceChanged_abyssPrivate = false;
  private execution_abyssPrivate: Promise<void> | undefined;
  private settlement_abyssPrivate: (() => void) | undefined;
  private accepted_abyssPrivate:
    { readonly task: TaskSnapshot; readonly identities: ReadonlySet<string> } | undefined;

  private ownedRoot_abyssPrivate: { before: TaskSnapshot; current: TaskSnapshot } | undefined;

  constructor(
    private readonly api_abyssPrivate: TaskApplicationApi,
    private readonly hooks_abyssPrivate: TimedBlockKeyboardQueueHooks,
    private readonly edits_abyssPrivate?: CalendarEditQueue,
  ) {}

  enqueue(task: TaskSnapshot, intent: TimedBlockKeyboardIntent): number | undefined {
    if (calendarMutationTarget(task) === undefined) return undefined;
    const taskIdentity = sourceIdentity(task);
    if (
      this.activeSequence_abyssPrivate === undefined ||
      this.pointerInterrupted_abyssPrivate ||
      !this.activeTaskIdentities_abyssPrivate.has(taskIdentity)
    ) {
      const current = this.ownedSuccessor_abyssPrivate(task);
      this.accepted_abyssPrivate = undefined;
      this.activeSequence_abyssPrivate = ++this.nextSequence_abyssPrivate;
      this.pointerInterrupted_abyssPrivate = false;
      this.activeTaskKey_abyssPrivate = sourceKey(current);
      this.activeTaskIdentities_abyssPrivate = new Set([taskIdentity, sourceIdentity(current)]);
      this.activeSnapshot_abyssPrivate = current;
      this.activeExecuted_abyssPrivate = false;
      this.activeAnyChanged_abyssPrivate = false;
      this.activeSourceChanged_abyssPrivate = false;
      this.pending_abyssPrivate = [];
    }
    const sequence = this.activeSequence_abyssPrivate;
    this.append_abyssPrivate(task, intent, sequence);
    this.processNext_abyssPrivate();
    return this.activeSequence_abyssPrivate === sequence ? sequence : undefined;
  }

  private append_abyssPrivate(
    task: TaskSnapshot,
    intent: TimedBlockKeyboardIntent,
    sequence: number,
  ): void {
    const last = this.pending_abyssPrivate[this.pending_abyssPrivate.length - 1];
    if (
      last?.sequence === sequence &&
      'deltaMinutes' in last.intent &&
      'deltaMinutes' in intent &&
      last.intent.type === intent.type &&
      last.intent.deltaMinutes === intent.deltaMinutes
    ) {
      this.pending_abyssPrivate[this.pending_abyssPrivate.length - 1] = {
        ...last,
        repetitions: last.repetitions + 1,
      };
    } else
      this.pending_abyssPrivate.push({
        intent,
        sequence,
        repetitions: 1,
        execute: this.edits_abyssPrivate?.capture(task),
      });
  }

  cancel(): void {
    this.pending_abyssPrivate = [];
    this.activeSequence_abyssPrivate = undefined;
    this.pointerInterrupted_abyssPrivate = false;
    this.activeTaskKey_abyssPrivate = undefined;
    this.activeTaskIdentities_abyssPrivate.clear();
    this.activeSnapshot_abyssPrivate = undefined;
    this.activeExecuted_abyssPrivate = false;
    this.activeAnyChanged_abyssPrivate = false;
    this.activeSourceChanged_abyssPrivate = false;
    this.accepted_abyssPrivate = undefined;
    this.settlement_abyssPrivate = undefined;
    this.ownedRoot_abyssPrivate = undefined;
  }

  /** A replacement mount now exposes the current root, retiring the old DOM baseline. */
  published(): void {
    // An undispatched repeat already owns a captured lineage; the new DOM must still join it.
    if (!this.processing_abyssPrivate && this.pending_abyssPrivate.length === 0)
      this.edits_abyssPrivate?.published();
    const owned = this.ownedRoot_abyssPrivate;
    if (owned !== undefined) owned.before = owned.current;
  }

  /** A pointer gesture can have started on a retained version of our own keyboard edit. */
  settlePointerTask(task: TaskSnapshot): TaskSnapshot | Promise<TaskSnapshot> {
    const root = calendarOccurrenceForRender(task).source.root;
    const active = this.activeSnapshot_abyssPrivate;
    const activeRoot =
      active === undefined ? undefined : calendarOccurrenceForRender(active).source.root;
    if (activeRoot?.ref.filePath === root.ref.filePath && activeRoot.ref.line === root.ref.line) {
      const sequence = this.activeSequence_abyssPrivate;
      this.pointerInterrupted_abyssPrivate = true;
      this.pending_abyssPrivate = [];
      return (
        this.execution_abyssPrivate?.then(() => {
          if (sequence !== undefined) this.finishSequence_abyssPrivate(sequence);
          return this.ownedSuccessor_abyssPrivate(task);
        }) ?? task
      );
    }
    return this.ownedSuccessor_abyssPrivate(task);
  }

  private ownedSuccessor_abyssPrivate(task: TaskSnapshot): TaskSnapshot {
    const accepted = this.accepted_abyssPrivate;
    const identity = sourceIdentity(task);
    const occurrence = calendarOccurrenceForTask(task);
    if (accepted?.identities.has(identity) === true && sourceIdentity(accepted.task) !== identity) {
      const successor = calendarOccurrenceForRender(accepted.task);
      if (occurrence === undefined) return accepted.task;
      return calendarTaskWithOwnedNode(
        occurrence,
        successor.source.root,
        successor.source.node,
        successor.kind === 'materialized' && successor.occupied.kind === 'interval',
      );
    }
    const owned = this.ownedRoot_abyssPrivate;
    if (owned === undefined || occurrence === undefined) return task;
    return calendarTaskWithOwnedRoot(occurrence, owned) ?? task;
  }

  private processNext_abyssPrivate(): void {
    if (this.processing_abyssPrivate) return;
    const queued = this.pending_abyssPrivate.shift();
    if (queued == null) return;
    if (
      queued.sequence !== this.activeSequence_abyssPrivate ||
      this.activeSnapshot_abyssPrivate == null
    ) {
      this.processNext_abyssPrivate();
      return;
    }

    // Shared intents are validated only after preceding pointer edits have a proved receipt.
    const command =
      queued.execute === undefined
        ? commandFor(this.activeSnapshot_abyssPrivate, queued.intent, queued.repetitions)
        : undefined;
    if (queued.execute === undefined && command === undefined) {
      if (this.pending_abyssPrivate.some((entry) => entry.sequence === queued.sequence)) {
        this.processNext_abyssPrivate();
        return;
      }
      this.finishSequence_abyssPrivate(queued.sequence);
      return;
    }

    this.processing_abyssPrivate = true;
    this.execution_abyssPrivate = this.run_abyssPrivate(
      command,
      queued,
      this.activeSnapshot_abyssPrivate,
    );
    runAsyncAction(this.execution_abyssPrivate, 'Could not update timed task');
  }

  private async run_abyssPrivate(
    command: TaskCommand | undefined,
    queued: QueuedIntent,
    previous: TaskSnapshot,
  ): Promise<void> {
    const release = this.hooks_abyssPrivate.holdPublication?.();
    try {
      await this.execute_abyssPrivate(command, queued, previous);
    } finally {
      const settled = this.settlement_abyssPrivate;
      this.settlement_abyssPrivate = undefined;
      this.processing_abyssPrivate = false;
      // Tab can queue an edit for another block before this receipt. Keep its native target
      // until that command has a receipt too, rather than publishing into its focus gap.
      if (queued.sequence !== this.activeSequence_abyssPrivate) this.processNext_abyssPrivate();
      release?.();
      settled?.();
      this.processNext_abyssPrivate();
    }
  }

  private async execute_abyssPrivate(
    command: TaskCommand | undefined,
    queued: QueuedIntent,
    previous: TaskSnapshot,
  ): Promise<void> {
    try {
      const receipt = await this.executeCommand_abyssPrivate(command, queued, previous);
      if (receipt === undefined) {
        this.finishIfDrained_abyssPrivate(queued.sequence);
        return;
      }
      const { result, previous: current, proof: sharedProof } = receipt;
      const proof = this.recordOwnedRoot_abyssPrivate(receipt);
      if (queued.sequence !== this.activeSequence_abyssPrivate) {
        this.carryOwnedRoot_abyssPrivate();
        return;
      }

      this.hooks_abyssPrivate.present(result);
      if (result.type !== 'ok' || result.outcome.type !== 'task') {
        this.pending_abyssPrivate = this.pending_abyssPrivate.filter(
          (entry) => entry.sequence !== queued.sequence,
        );
        this.finishSequence_abyssPrivate(queued.sequence);
        return;
      }

      if (this.edits_abyssPrivate !== undefined && sharedProof === undefined) {
        this.hooks_abyssPrivate.onInvalidated(queued.sequence);
        this.cancel();
        return;
      }
      const updated = committedSnapshot(current, result.outcome.task, {
        intent: queued.intent,
        changed: result.changed,
        proof,
      });
      if (updated === undefined) {
        this.hooks_abyssPrivate.onInvalidated(queued.sequence);
        this.cancel();
        return;
      }
      this.acceptCommit_abyssPrivate(updated, queued, result.changed);
    } catch {
      if (queued.sequence !== this.activeSequence_abyssPrivate) return;
      this.hooks_abyssPrivate.present({
        type: 'io-error',
        cause: 'repository-error',
        contentState: 'unknown',
      });
      this.pending_abyssPrivate = this.pending_abyssPrivate.filter(
        (entry) => entry.sequence !== queued.sequence,
      );
      this.finishSequence_abyssPrivate(queued.sequence);
    }
  }

  private async executeCommand_abyssPrivate(
    command: TaskCommand | undefined,
    queued: QueuedIntent,
    previous: TaskSnapshot,
  ): Promise<CalendarEditReceipt | undefined> {
    if (queued.execute !== undefined)
      return this.executeQueued_abyssPrivate(queued.execute, queued);
    if (command === undefined) return undefined;
    this.recordExecution_abyssPrivate(queued.sequence);
    let prepared = calendarEditWitness(previous, command);
    const withWitness =
      calendarMutationTarget(previous)?.type === 'subtask' || command.type !== 'patch';
    const result = withWitness
      ? await this.api_abyssPrivate.execute(command, {
          onPreparedPatch: (patch) => {
            prepared = calendarEditWitness(previous, patch);
          },
        })
      : await this.api_abyssPrivate.execute(command);
    return { previous, command: prepared, result, proof: undefined };
  }

  private async executeQueued_abyssPrivate(
    execute: CalendarEditExecutor,
    queued: QueuedIntent,
  ): Promise<CalendarEditReceipt | undefined> {
    let unchanged: TaskSnapshot | undefined;
    const receipt = await execute((current) => {
      const command = commandFor(current, queued.intent, queued.repetitions);
      if (command !== undefined) this.recordExecution_abyssPrivate(queued.sequence);
      else unchanged = current;
      return command;
    });
    // Let the focus owner finish accepting this sequence before reporting a validated no-op.
    if (unchanged !== undefined) this.hooks_abyssPrivate.onNoop?.(unchanged, queued.sequence);
    return receipt;
  }

  private recordExecution_abyssPrivate(sequence: number): void {
    if (sequence === this.activeSequence_abyssPrivate) this.activeExecuted_abyssPrivate = true;
  }

  private recordOwnedRoot_abyssPrivate(
    receipt: CalendarEditReceipt,
  ): OwnedTaskSelectionProof | undefined {
    const { previous, result, command } = receipt;
    if (
      result.type !== 'ok' ||
      result.outcome.type !== 'task' ||
      this.activeSequence_abyssPrivate === undefined
    )
      return;
    const current = result.outcome.task;
    const root = calendarOccurrenceForRender(previous).source.root;
    const owned = this.ownedRoot_abyssPrivate;
    let proof = receipt.proof;
    if (this.edits_abyssPrivate === undefined)
      proof =
        command.type === 'patch' ? proveOwnedTaskSelection(current, [root], command) : undefined;
    if (proof === undefined) {
      this.ownedRoot_abyssPrivate = undefined;
      return;
    }
    this.ownedRoot_abyssPrivate = {
      before:
        owned !== undefined && sameTaskNodeRef(taskNodeRef(owned.current), taskNodeRef(root))
          ? owned.before
          : root,
      current,
    };
    return proof;
  }

  private carryOwnedRoot_abyssPrivate(): void {
    const active = this.activeSnapshot_abyssPrivate;
    if (active === undefined) return;
    const successor = this.ownedSuccessor_abyssPrivate(active);
    if (successor !== active) this.rememberOwnedSnapshot_abyssPrivate(successor);
  }

  private acceptCommit_abyssPrivate(
    updated: TaskSnapshot,
    queued: QueuedIntent,
    changed: boolean,
  ): void {
    this.rememberOwnedSnapshot_abyssPrivate(updated);
    this.activeAnyChanged_abyssPrivate ||= changed;
    this.hooks_abyssPrivate.onCommitted(updated, queued.intent, queued.sequence, changed);
    this.finishIfDrained_abyssPrivate(queued.sequence);
  }

  private finishIfDrained_abyssPrivate(sequence: number): void {
    if (!this.pending_abyssPrivate.some((entry) => entry.sequence === sequence))
      this.finishSequence_abyssPrivate(sequence);
  }

  private rememberOwnedSnapshot_abyssPrivate(updated: TaskSnapshot): void {
    this.activeSnapshot_abyssPrivate = updated;
    const nextTaskKey = sourceKey(updated);
    this.activeSourceChanged_abyssPrivate ||= nextTaskKey !== this.activeTaskKey_abyssPrivate;
    this.activeTaskKey_abyssPrivate = nextTaskKey;
    this.activeTaskIdentities_abyssPrivate.add(sourceIdentity(updated));
    this.accepted_abyssPrivate = {
      task: updated,
      identities: new Set(this.activeTaskIdentities_abyssPrivate),
    };
  }

  private finishSequence_abyssPrivate(sequence: number): void {
    if (
      sequence !== this.activeSequence_abyssPrivate ||
      this.activeTaskKey_abyssPrivate === undefined ||
      this.activeTaskKey_abyssPrivate.length === 0
    ) {
      return;
    }
    const taskKey = this.activeTaskKey_abyssPrivate;
    const summary: TimedBlockKeyboardSequenceSummary = {
      executed: this.activeExecuted_abyssPrivate,
      anyChanged: this.activeAnyChanged_abyssPrivate,
      sourceChanged: this.activeSourceChanged_abyssPrivate,
    };
    this.activeSequence_abyssPrivate = undefined;
    this.activeTaskKey_abyssPrivate = undefined;
    this.activeTaskIdentities_abyssPrivate.clear();
    this.activeSnapshot_abyssPrivate = undefined;
    this.activeExecuted_abyssPrivate = false;
    this.activeAnyChanged_abyssPrivate = false;
    this.activeSourceChanged_abyssPrivate = false;
    const settled = (): void => {
      this.hooks_abyssPrivate.onSettled(taskKey, sequence, summary);
    };
    // Even an unchanged receipt may release a dirty query publication. Keep its committed
    // focus locator until that replacement has received focus in the same turn.
    if (this.processing_abyssPrivate) this.settlement_abyssPrivate = settled;
    else settled();
  }
}
