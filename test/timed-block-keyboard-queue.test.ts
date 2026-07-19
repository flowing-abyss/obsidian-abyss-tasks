import { describe, expect, it, vi } from 'vitest';
import type { TaskApplicationApi, TaskCommandResult, TaskSnapshot } from '../src/tasks';
import { TimedBlockKeyboardQueue } from '../src/ui/timedBlockKeyboardQueue';
import type { TimedBlockKeyboardIntent } from '../src/views/timegrid/renderTimedBlocks';
import { queryApiForTasks, task } from './helpers';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function taskAt(
  time: string,
  revision = 'revision-1',
  overrides: {
    filePath?: string;
    line?: number;
    duration?: number;
    due?: string;
    scheduled?: string;
    start?: string;
  } = {},
): TaskSnapshot {
  const filePath = overrides.filePath ?? 'qa.md';
  const line = overrides.line ?? 0;
  return task({
    ref: { filePath, line, revision },
    source: { filePath, line },
    planning: {
      due: overrides.due ?? '2026-07-20',
      scheduled: overrides.scheduled,
      start: overrides.start,
      time,
      duration: overrides.duration,
    },
  });
}

function ok(updated: TaskSnapshot): TaskCommandResult {
  return { type: 'ok', changed: true, outcome: { type: 'task', task: updated } };
}

function harness(execute = vi.fn<TaskApplicationApi['execute']>()) {
  const api: TaskApplicationApi = {
    queries: queryApiForTasks(() => []),
    execute,
  };
  const hooks = {
    onCommitted: vi.fn(),
    onSettled: vi.fn(),
    present: vi.fn(),
  };
  return { api, hooks, queue: new TimedBlockKeyboardQueue(api, hooks) };
}

async function expectSecondCall(execute: ReturnType<typeof vi.fn>): Promise<void> {
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
}

describe('TimedBlockKeyboardQueue', () => {
  it('serializes rapid time moves and rebases cumulative values on the returned snapshot/ref', async () => {
    const first = deferred<TaskCommandResult>();
    const second = deferred<TaskCommandResult>();
    const execute = vi
      .fn<TaskApplicationApi['execute']>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { queue } = harness(execute);

    queue.enqueue(taskAt('09:00'), { type: 'move-time', deltaMinutes: 15 });
    queue.enqueue(taskAt('09:00'), { type: 'move-time', deltaMinutes: 15 });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ patch: { time: { type: 'set', value: '09:15' } } }),
    );

    first.resolve(ok(taskAt('09:15', 'revision-2')));
    await expectSecondCall(execute);
    expect(execute).toHaveBeenNthCalledWith(2, {
      type: 'patch',
      target: { type: 'task', ref: expect.objectContaining({ revision: 'revision-2' }) },
      patch: { time: { type: 'set', value: '09:30' } },
    });
    second.resolve(ok(taskAt('09:30', 'revision-3')));
  });

  it('accumulates duration changes and defaults missing duration to 60 minutes', async () => {
    const results = [
      deferred<TaskCommandResult>(),
      deferred<TaskCommandResult>(),
      deferred<TaskCommandResult>(),
    ];
    const execute = vi
      .fn<TaskApplicationApi['execute']>()
      .mockReturnValueOnce(results[0]!.promise)
      .mockReturnValueOnce(results[1]!.promise)
      .mockReturnValueOnce(results[2]!.promise);
    const { queue } = harness(execute);

    queue.enqueue(taskAt('09:00', 'revision-1', { duration: 60 }), {
      type: 'resize-duration',
      deltaMinutes: 5,
    });
    queue.enqueue(taskAt('09:00', 'revision-1', { duration: 60 }), {
      type: 'resize-duration',
      deltaMinutes: 5,
    });
    results[0]!.resolve(ok(taskAt('09:00', 'revision-2', { duration: 65 })));
    await expectSecondCall(execute);
    expect(execute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ patch: { duration: { type: 'set', value: 70 } } }),
    );
    results[1]!.resolve(ok(taskAt('09:00', 'revision-3', { duration: 70 })));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));

    queue.enqueue(taskAt('10:00', 'revision-4'), {
      type: 'resize-duration',
      deltaMinutes: 5,
    });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(3));
    expect(execute).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ patch: { duration: { type: 'set', value: 65 } } }),
    );
    results[2]!.resolve(ok(taskAt('10:00', 'revision-5', { duration: 65 })));
  });

  it('rebases repeated schedule shifts on each returned revision', async () => {
    const first = deferred<TaskCommandResult>();
    const second = deferred<TaskCommandResult>();
    const execute = vi
      .fn<TaskApplicationApi['execute']>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { queue } = harness(execute);
    const intent: TimedBlockKeyboardIntent = { type: 'shift-schedule', days: 1 };

    queue.enqueue(taskAt('09:00', 'revision-1', { due: '2026-07-20' }), intent);
    queue.enqueue(taskAt('09:00', 'revision-1', { due: '2026-07-20' }), intent);
    expect(execute).toHaveBeenNthCalledWith(1, {
      type: 'shift-schedule',
      ref: expect.objectContaining({ revision: 'revision-1' }),
      days: 1,
    });

    first.resolve(ok(taskAt('09:00', 'revision-2', { due: '2026-07-21' })));
    await expectSecondCall(execute);
    expect(execute).toHaveBeenNthCalledWith(2, {
      type: 'shift-schedule',
      ref: expect.objectContaining({ revision: 'revision-2' }),
      days: 1,
    });
    second.resolve(ok(taskAt('09:00', 'revision-3', { due: '2026-07-22' })));
  });

  it('rebases repeated start and due extensions on returned span boundaries', async () => {
    const results = Array.from({ length: 4 }, () => deferred<TaskCommandResult>());
    const execute = vi.fn<TaskApplicationApi['execute']>();
    for (const result of results) execute.mockReturnValueOnce(result.promise);
    const { queue } = harness(execute);

    const span = taskAt('09:00', 'revision-1', {
      start: '2026-07-20',
      due: '2026-07-21',
    });
    queue.enqueue(span, { type: 'extend-start', days: -1 });
    queue.enqueue(span, { type: 'extend-start', days: -1 });
    expect(execute).toHaveBeenNthCalledWith(1, {
      type: 'set-span-boundary',
      ref: expect.objectContaining({ revision: 'revision-1' }),
      boundary: 'start',
      date: '2026-07-19',
    });
    results[0]!.resolve(
      ok(taskAt('09:00', 'revision-2', { start: '2026-07-19', due: '2026-07-21' })),
    );
    await expectSecondCall(execute);
    expect(execute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ boundary: 'start', date: '2026-07-18' }),
    );
    results[1]!.resolve(
      ok(taskAt('09:00', 'revision-3', { start: '2026-07-18', due: '2026-07-21' })),
    );
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));

    const dueSpan = taskAt('09:00', 'revision-4', {
      start: '2026-07-20',
      due: '2026-07-21',
    });
    queue.enqueue(dueSpan, { type: 'extend-due', days: 1 });
    queue.enqueue(dueSpan, { type: 'extend-due', days: 1 });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(3));
    expect(execute).toHaveBeenNthCalledWith(3, {
      type: 'extend-span',
      ref: expect.objectContaining({ revision: 'revision-4' }),
      due: '2026-07-22',
    });
    results[2]!.resolve(
      ok(taskAt('09:00', 'revision-5', { start: '2026-07-20', due: '2026-07-22' })),
    );
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(4));
    expect(execute).toHaveBeenNthCalledWith(4, expect.objectContaining({ due: '2026-07-23' }));
    results[3]!.resolve(
      ok(taskAt('09:00', 'revision-6', { start: '2026-07-20', due: '2026-07-23' })),
    );
  });

  it.each([
    ['time lower', taskAt('00:00'), { type: 'move-time', deltaMinutes: -15 }, 'time', '00:00'],
    ['time upper', taskAt('23:45'), { type: 'move-time', deltaMinutes: 15 }, 'time', '23:45'],
    [
      'duration lower',
      taskAt('09:00', 'revision-1', { duration: 5 }),
      { type: 'resize-duration', deltaMinutes: -5 },
      'duration',
      5,
    ],
    [
      'duration upper',
      taskAt('09:00', 'revision-1', { duration: 1440 }),
      { type: 'resize-duration', deltaMinutes: 5 },
      'duration',
      1440,
    ],
  ] as const)('clamps %s mutations', (_name, snapshot, intent, field, value) => {
    const execute = vi
      .fn<TaskApplicationApi['execute']>()
      .mockImplementation(() => new Promise(() => {}));
    const { queue } = harness(execute);
    queue.enqueue(snapshot, intent);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ patch: { [field]: { type: 'set', value } } }),
    );
  });

  it('presents a failure, cancels the remaining sequence, and settles once', async () => {
    const first = deferred<TaskCommandResult>();
    const execute = vi.fn<TaskApplicationApi['execute']>().mockReturnValueOnce(first.promise);
    const { queue, hooks } = harness(execute);
    const snapshot = taskAt('09:00');

    queue.enqueue(snapshot, { type: 'move-time', deltaMinutes: 15 });
    queue.enqueue(snapshot, { type: 'move-time', deltaMinutes: 15 });
    const failure: TaskCommandResult = { type: 'conflict', current: snapshot };
    first.resolve(failure);
    await vi.waitFor(() => expect(hooks.onSettled).toHaveBeenCalledTimes(1));

    expect(hooks.present).toHaveBeenCalledWith(failure);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(hooks.onCommitted).not.toHaveBeenCalled();
    expect(hooks.onSettled).toHaveBeenCalledWith('qa.md:0', 1);
  });

  it('gives a newly focused task ownership while a stale task remains in flight', async () => {
    const first = deferred<TaskCommandResult>();
    const second = deferred<TaskCommandResult>();
    const execute = vi
      .fn<TaskApplicationApi['execute']>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { queue, hooks } = harness(execute);
    const taskA = taskAt('09:00', 'a-1', { filePath: 'a.md' });
    const taskB = taskAt('10:00', 'b-1', { filePath: 'b.md' });

    queue.enqueue(taskA, { type: 'shift-schedule', days: 1 });
    queue.enqueue(taskB, { type: 'move-time', deltaMinutes: 15 });
    first.resolve(ok(taskAt('09:00', 'a-2', { filePath: 'a.md', due: '2026-07-21' })));
    await expectSecondCall(execute);

    expect(hooks.onCommitted).not.toHaveBeenCalled();
    expect(hooks.onSettled).not.toHaveBeenCalled();
    expect(execute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        target: { type: 'task', ref: expect.objectContaining({ filePath: 'b.md' }) },
      }),
    );

    const updatedB = taskAt('10:15', 'b-2', { filePath: 'b.md' });
    second.resolve(ok(updatedB));
    await vi.waitFor(() => expect(hooks.onSettled).toHaveBeenCalledTimes(1));
    expect(hooks.onCommitted).toHaveBeenCalledWith(
      updatedB,
      { type: 'move-time', deltaMinutes: 15 },
      2,
    );
    expect(hooks.onSettled).toHaveBeenCalledWith('b.md:0', 2);
  });

  it('cancel suppresses every late hook from an in-flight command', async () => {
    const result = deferred<TaskCommandResult>();
    const execute = vi.fn<TaskApplicationApi['execute']>().mockReturnValueOnce(result.promise);
    const { queue, hooks } = harness(execute);

    queue.enqueue(taskAt('09:00'), { type: 'move-time', deltaMinutes: 15 });
    queue.cancel();
    result.resolve(ok(taskAt('09:15', 'revision-2')));
    await Promise.resolve();
    await Promise.resolve();

    expect(hooks.present).not.toHaveBeenCalled();
    expect(hooks.onCommitted).not.toHaveBeenCalled();
    expect(hooks.onSettled).not.toHaveBeenCalled();
  });
});
