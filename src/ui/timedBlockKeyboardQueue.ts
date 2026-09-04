import {
  durationMinutes,
  localTime,
  shiftLocalDate,
  type TaskApplicationApi,
  type TaskCommand,
  type TaskCommandResult,
  type TaskSnapshot,
} from '../tasks';
import type { TimedBlockKeyboardIntent } from '../views/timegrid/renderTimedBlocks';
import { runAsyncAction } from './runAsyncAction';

export interface TimedBlockKeyboardQueueHooks {
  onCommitted(
    task: TaskSnapshot,
    intent: TimedBlockKeyboardIntent,
    sequence: number,
    changed: boolean,
  ): void;
  onSettled(taskKey: string, sequence: number, summary: TimedBlockKeyboardSequenceSummary): void;
  present(result: TaskCommandResult): void;
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
  return `${task.source.filePath}:${task.source.line}`;
}

function sourceIdentity(task: TaskSnapshot): string {
  return `${task.source.filePath}:${task.source.line}:${task.ref.revision}`;
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

function extendStartCommand(
  task: TaskSnapshot,
  intent: Extract<TimedBlockKeyboardIntent, { type: 'extend-start' }>,
): TaskCommand | undefined {
  if (task.planning.start != null && task.planning.due != null) {
    const date = shiftLocalDate(task.planning.start, intent.days);
    return date != null
      ? { type: 'set-span-boundary', ref: task.ref, boundary: 'start', date }
      : undefined;
  }
  const anchor = task.planning.scheduled ?? task.planning.due;
  if (anchor == null) return undefined;
  const start = shiftLocalDate(anchor, intent.days);
  return start != null
    ? {
        type: 'patch',
        target: { type: 'task', ref: task.ref },
        patch: { start: { type: 'set', value: start }, due: { type: 'set', value: anchor } },
      }
    : undefined;
}

function extendDueCommand(
  task: TaskSnapshot,
  intent: Extract<TimedBlockKeyboardIntent, { type: 'extend-due' }>,
): TaskCommand | undefined {
  const base =
    task.planning.start != null && task.planning.due != null
      ? task.planning.due
      : (task.planning.scheduled ?? task.planning.due);
  if (base == null) return undefined;
  const due = shiftLocalDate(base, intent.days);
  return due != null ? { type: 'extend-span', ref: task.ref, due } : undefined;
}

function commandFor(task: TaskSnapshot, intent: TimedBlockKeyboardIntent): TaskCommand | undefined {
  switch (intent.type) {
    case 'move-time': {
      const next = clamp(
        timeMinutes(task.planning.time) + intent.deltaMinutes,
        MIN_START_MINUTES,
        MAX_START_MINUTES,
      );
      return {
        type: 'patch',
        target: { type: 'task', ref: task.ref },
        patch: { time: { type: 'set', value: localTime(timeString(next)) } },
      };
    }
    case 'resize-duration': {
      const next = clamp(
        (task.planning.duration ?? DEFAULT_DURATION_MINUTES) + intent.deltaMinutes,
        MIN_DURATION_MINUTES,
        MAX_DURATION_MINUTES,
      );
      return {
        type: 'patch',
        target: { type: 'task', ref: task.ref },
        patch: { duration: { type: 'set', value: durationMinutes(next) } },
      };
    }
    case 'shift-schedule':
      return { type: 'shift-schedule', ref: task.ref, days: intent.days };
    case 'extend-start': {
      return extendStartCommand(task, intent);
    }
    case 'extend-due': {
      return extendDueCommand(task, intent);
    }
  }
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
      this.finishSequence(queued.sequence);
      return;
    }

    this.processing = true;
    this.activeExecuted = true;
    runAsyncAction(this.run(command, queued), 'Could not update timed task');
  }

  private async run(command: TaskCommand, queued: QueuedIntent): Promise<void> {
    try {
      const result = await this.api.execute(command);
      if (queued.sequence !== this.activeSequence) return;

      this.hooks.present(result);
      if (result.type !== 'ok' || result.outcome.type !== 'task') {
        this.pending = this.pending.filter((entry) => entry.sequence !== queued.sequence);
        this.finishSequence(queued.sequence);
        return;
      }

      this.activeSnapshot = result.outcome.task;
      const nextTaskKey = sourceKey(result.outcome.task);
      this.activeSourceChanged ||= nextTaskKey !== this.activeTaskKey;
      this.activeTaskKey = nextTaskKey;
      this.activeTaskIdentities.add(sourceIdentity(result.outcome.task));
      this.activeAnyChanged ||= result.changed;
      this.hooks.onCommitted(result.outcome.task, queued.intent, queued.sequence, result.changed);
      if (!this.pending.some((entry) => entry.sequence === queued.sequence)) {
        this.finishSequence(queued.sequence);
      }
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
