import {
  durationMinutes,
  localTime,
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
  calendarTaskWithPlanning,
  taskSnapshotForCalendarOccurrence,
} from '../views/calendarOccurrences';
import type { TimedBlockKeyboardIntent } from '../views/timegrid/renderTimedBlocks';
import { proveOwnedTaskSelection } from './ownedTaskSelection';
import { runAsyncAction } from './runAsyncAction';
import { taskNodeRef, taskSelectionRefPath, type TaskSelectionNode } from './taskSelection';

export interface TimedBlockKeyboardQueueHooks {
  onCommitted(
    task: TaskSnapshot,
    intent: TimedBlockKeyboardIntent,
    sequence: number,
    changed: boolean,
  ): void;
  onSettled(taskKey: string, sequence: number, summary: TimedBlockKeyboardSequenceSummary): void;
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
}

const MIN_START_MINUTES = 0;
const MAX_START_MINUTES = 24 * 60 - 15;
const MIN_DURATION_MINUTES = 5;
const MAX_DURATION_MINUTES = 24 * 60;
const DEFAULT_DURATION_MINUTES = 60;

function sourceKey(task: TaskSnapshot): string {
  const target = calendarMutationTarget(task);
  return `${task.source.filePath}:${target === undefined ? task.source.line : taskNodeSourceLine(target)}`;
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

function commandFor(task: TaskSnapshot, intent: TimedBlockKeyboardIntent): TaskCommand | undefined {
  switch (intent.type) {
    case 'move-time': {
      const next = clamp(
        timeMinutes(task.planning.time) + intent.deltaMinutes,
        MIN_START_MINUTES,
        MAX_START_MINUTES,
      );
      return calendarPatchCommand(task, {
        time: { type: 'set', value: localTime(timeString(next)) },
      });
    }
    case 'resize-duration': {
      const next = clamp(
        (task.planning.duration ?? DEFAULT_DURATION_MINUTES) + intent.deltaMinutes,
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
    readonly command: TaskCommand;
    readonly intent: TimedBlockKeyboardIntent;
    readonly changed: boolean;
  },
): TaskSnapshot | undefined {
  const occurrence = calendarOccurrenceForTask(previous);
  if (occurrence === undefined) return current;
  if (occurrence.kind !== 'materialized') return undefined;
  let node: TaskSelectionNode | undefined = current;
  if (occurrence.source.target.type === 'subtask') {
    const path = taskSelectionRefPath(current, occurrence.source.target);
    node = change.changed
      ? proveOwnedTaskSelection(current, [occurrence.source.root], change.command)?.nodeSuccessor(
          occurrence.source.target,
        )
      : path?.[path.length - 1];
  }
  if (node === undefined) return undefined;
  const display = taskSnapshotForCalendarOccurrence({
    ...occurrence,
    source: { root: current, node, target: taskNodeRef(node) },
    planning: node.planning,
  });
  return calendarTaskWithPlanning(
    display,
    node.planning,
    change.intent.type === 'extend-due' ? 'create-span' : undefined,
  );
}

export class TimedBlockKeyboardQueue {
  private pending: QueuedIntent[] = [];
  private processing = false;
  private nextSequence = 0;
  private activeSequence: number | undefined;
  private activeTaskKey: string | undefined;
  private activeTaskIdentities = new Set<string>();
  private activeSnapshot: TaskSnapshot | undefined;
  private activeExecuted = false;
  private activeAnyChanged = false;
  private activeSourceChanged = false;

  constructor(
    private readonly api: TaskApplicationApi,
    private readonly hooks: TimedBlockKeyboardQueueHooks,
  ) {}

  enqueue(task: TaskSnapshot, intent: TimedBlockKeyboardIntent): number | undefined {
    if (calendarMutationTarget(task) === undefined) return undefined;
    const taskKey = sourceKey(task);
    const taskIdentity = sourceIdentity(task);
    if (this.activeSequence === undefined || !this.activeTaskIdentities.has(taskIdentity)) {
      this.activeSequence = ++this.nextSequence;
      this.activeTaskKey = taskKey;
      this.activeTaskIdentities = new Set([taskIdentity]);
      this.activeSnapshot = task;
      this.activeExecuted = false;
      this.activeAnyChanged = false;
      this.activeSourceChanged = false;
      this.pending = [];
    }
    const sequence = this.activeSequence;
    this.pending.push({ intent, sequence });
    this.processNext();
    return this.activeSequence === sequence ? sequence : undefined;
  }

  cancel(): void {
    this.pending = [];
    this.activeSequence = undefined;
    this.activeTaskKey = undefined;
    this.activeTaskIdentities.clear();
    this.activeSnapshot = undefined;
    this.activeExecuted = false;
    this.activeAnyChanged = false;
    this.activeSourceChanged = false;
  }

  private processNext(): void {
    if (this.processing) return;
    const queued = this.pending.shift();
    if (queued == null) return;
    if (queued.sequence !== this.activeSequence || this.activeSnapshot == null) {
      this.processNext();
      return;
    }

    const command = commandFor(this.activeSnapshot, queued.intent);
    if (command == null) {
      if (this.pending.some((entry) => entry.sequence === queued.sequence)) {
        this.processNext();
        return;
      }
      this.finishSequence(queued.sequence);
      return;
    }

    this.processing = true;
    this.activeExecuted = true;
    runAsyncAction(this.run(command, queued, this.activeSnapshot), 'Could not update timed task');
  }

  private async run(
    command: TaskCommand,
    queued: QueuedIntent,
    previous: TaskSnapshot,
  ): Promise<void> {
    try {
      let prepared = command;
      const result =
        calendarMutationTarget(previous)?.type === 'subtask'
          ? await this.api.execute(command, {
              onPreparedPatch: (patch) => {
                prepared = patch;
              },
            })
          : await this.api.execute(command);
      if (queued.sequence !== this.activeSequence) return;

      this.hooks.present(result);
      if (result.type !== 'ok' || result.outcome.type !== 'task') {
        this.pending = this.pending.filter((entry) => entry.sequence !== queued.sequence);
        this.finishSequence(queued.sequence);
        return;
      }

      const updated = committedSnapshot(previous, result.outcome.task, {
        command: prepared,
        intent: queued.intent,
        changed: result.changed,
      });
      if (updated === undefined) {
        this.hooks.onInvalidated(queued.sequence);
        this.cancel();
        return;
      }
      this.acceptCommit(updated, queued, result.changed);
    } catch {
      if (queued.sequence !== this.activeSequence) return;
      this.hooks.present({
        type: 'io-error',
        cause: 'repository-error',
        contentState: 'unknown',
      });
      this.pending = this.pending.filter((entry) => entry.sequence !== queued.sequence);
      this.finishSequence(queued.sequence);
    } finally {
      this.processing = false;
      this.processNext();
    }
  }

  private acceptCommit(updated: TaskSnapshot, queued: QueuedIntent, changed: boolean): void {
    this.activeSnapshot = updated;
    const nextTaskKey = sourceKey(updated);
    this.activeSourceChanged ||= nextTaskKey !== this.activeTaskKey;
    this.activeTaskKey = nextTaskKey;
    this.activeTaskIdentities.add(sourceIdentity(updated));
    this.activeAnyChanged ||= changed;
    this.hooks.onCommitted(updated, queued.intent, queued.sequence, changed);
    if (!this.pending.some((entry) => entry.sequence === queued.sequence)) {
      this.finishSequence(queued.sequence);
    }
  }

  private finishSequence(sequence: number): void {
    if (
      sequence !== this.activeSequence ||
      this.activeTaskKey === undefined ||
      this.activeTaskKey.length === 0
    ) {
      return;
    }
    const taskKey = this.activeTaskKey;
    const summary: TimedBlockKeyboardSequenceSummary = {
      executed: this.activeExecuted,
      anyChanged: this.activeAnyChanged,
      sourceChanged: this.activeSourceChanged,
    };
    this.activeSequence = undefined;
    this.activeTaskKey = undefined;
    this.activeTaskIdentities.clear();
    this.activeSnapshot = undefined;
    this.activeExecuted = false;
    this.activeAnyChanged = false;
    this.activeSourceChanged = false;
    this.hooks.onSettled(taskKey, sequence, summary);
  }
}
