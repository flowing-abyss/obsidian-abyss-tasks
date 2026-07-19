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

export interface TimedBlockKeyboardQueueHooks {
  onCommitted(task: TaskSnapshot, intent: TimedBlockKeyboardIntent, sequence: number): void;
  onSettled(taskKey: string, sequence: number): void;
  present(result: TaskCommandResult): void;
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

function timeMinutes(value: string | undefined): number {
  if (!value) return 0;
  const [hours, minutes] = value.split(':').map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

function timeString(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
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
      const base = task.planning.start ?? task.planning.scheduled ?? task.planning.due;
      if (!base) return undefined;
      const date = shiftLocalDate(base, intent.days);
      return date
        ? { type: 'set-span-boundary', ref: task.ref, boundary: 'start', date }
        : undefined;
    }
    case 'extend-due': {
      const base = task.planning.due ?? task.planning.scheduled ?? task.planning.start;
      if (!base) return undefined;
      const due = shiftLocalDate(base, intent.days);
      return due ? { type: 'extend-span', ref: task.ref, due } : undefined;
    }
  }
}

export class TimedBlockKeyboardQueue {
  private pending: QueuedIntent[] = [];
  private processing = false;
  private nextSequence = 0;
  private activeSequence: number | undefined;
  private activeTaskKey: string | undefined;
  private activeSnapshot: TaskSnapshot | undefined;

  constructor(
    private api: TaskApplicationApi,
    private hooks: TimedBlockKeyboardQueueHooks,
  ) {}

  enqueue(task: TaskSnapshot, intent: TimedBlockKeyboardIntent): number {
    const taskKey = sourceKey(task);
    if (this.activeSequence === undefined || taskKey !== this.activeTaskKey) {
      this.activeSequence = ++this.nextSequence;
      this.activeTaskKey = taskKey;
      this.activeSnapshot = task;
      this.pending = [];
    }
    const sequence = this.activeSequence;
    this.pending.push({ intent, sequence });
    this.processNext();
    return sequence;
  }

  cancel(): void {
    this.pending = [];
    this.activeSequence = undefined;
    this.activeTaskKey = undefined;
    this.activeSnapshot = undefined;
  }

  private processNext(): void {
    if (this.processing) return;
    const queued = this.pending.shift();
    if (!queued) return;
    if (queued.sequence !== this.activeSequence || !this.activeSnapshot) {
      this.processNext();
      return;
    }

    const command = commandFor(this.activeSnapshot, queued.intent);
    if (!command) {
      this.finishSequence(queued.sequence);
      return;
    }

    this.processing = true;
    void this.run(command, queued);
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
      this.hooks.onCommitted(result.outcome.task, queued.intent, queued.sequence);
      if (!this.pending.some((entry) => entry.sequence === queued.sequence)) {
        this.finishSequence(queued.sequence);
      }
    } catch {
      if (queued.sequence !== this.activeSequence) return;
      this.pending = this.pending.filter((entry) => entry.sequence !== queued.sequence);
      this.finishSequence(queued.sequence);
    } finally {
      this.processing = false;
      this.processNext();
    }
  }

  private finishSequence(sequence: number): void {
    if (sequence !== this.activeSequence || !this.activeTaskKey) return;
    const taskKey = this.activeTaskKey;
    this.activeSequence = undefined;
    this.activeTaskKey = undefined;
    this.activeSnapshot = undefined;
    this.hooks.onSettled(taskKey, sequence);
  }
}
