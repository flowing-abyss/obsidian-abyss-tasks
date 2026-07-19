import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { TaskApplicationApi, TaskCommandResult, TaskSnapshot } from '../src/tasks';
import { TimedBlockKeyboardQueue } from '../src/ui/timedBlockKeyboardQueue';
import type { TimedBlockKeyboardIntent } from '../src/views/timegrid/renderTimedBlocks';
import {
  configuredTaskApplication,
  createAppWithFiles,
  flushMicrotasks,
  queryApiForTasks,
  seedTaskCache,
  task,
} from './helpers';

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
    due?: string | null;
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
      due: overrides.due === null ? undefined : (overrides.due ?? '2026-07-20'),
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

function okUnchanged(updated: TaskSnapshot): TaskCommandResult {
  return { type: 'ok', changed: false, outcome: { type: 'task', task: updated } };
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
  it('reports each committed result changed state to the focus owner', async () => {
    const first = deferred<TaskCommandResult>();
    const second = deferred<TaskCommandResult>();
    const execute = vi
      .fn<TaskApplicationApi['execute']>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { queue, hooks } = harness(execute);
    const original = taskAt('00:15', 'revision-1');
    const boundary = taskAt('00:00', 'revision-2');

    queue.enqueue(original, { type: 'move-time', deltaMinutes: -15 });
    queue.enqueue(original, { type: 'move-time', deltaMinutes: -15 });
    first.resolve(ok(boundary));
    await expectSecondCall(execute);
    second.resolve(okUnchanged(boundary));
    await vi.waitFor(() => expect(hooks.onSettled).toHaveBeenCalledOnce());

    expect(hooks.onCommitted.mock.calls.map((call) => call[3])).toEqual([true, false]);
  });

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
    ['scheduled-only', null, '2026-07-10'],
    ['scheduled with an unrelated deadline', '2026-08-30', '2026-07-10'],
  ] as const)(
    'extends a %s task right from its rendered scheduled anchor, then from returned due',
    async (_label, originalDue, scheduled) => {
      const first = deferred<TaskCommandResult>();
      const second = deferred<TaskCommandResult>();
      const execute = vi
        .fn<TaskApplicationApi['execute']>()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);
      const { queue } = harness(execute);
      const original = taskAt('09:00', 'revision-1', { due: originalDue, scheduled });

      queue.enqueue(original, { type: 'extend-due', days: 1 });
      queue.enqueue(original, { type: 'extend-due', days: 1 });
      expect(execute).toHaveBeenNthCalledWith(1, {
        type: 'extend-span',
        ref: expect.objectContaining({ revision: 'revision-1' }),
        due: '2026-07-11',
      });

      first.resolve(
        ok(
          taskAt('09:00', 'revision-2', {
            scheduled,
            start: scheduled,
            due: '2026-07-11',
          }),
        ),
      );
      await expectSecondCall(execute);
      expect(execute).toHaveBeenNthCalledWith(2, {
        type: 'extend-span',
        ref: expect.objectContaining({ revision: 'revision-2' }),
        due: '2026-07-12',
      });
      second.resolve(
        ok(
          taskAt('09:00', 'revision-3', {
            scheduled,
            start: scheduled,
            due: '2026-07-12',
          }),
        ),
      );
    },
  );

  it.each([
    ['scheduled-only', '- [ ] task ⏳ 2026-07-10 ⏰ 09:00\n'],
    ['scheduled with an unrelated deadline', '- [ ] task ⏳ 2026-07-10 📅 2026-08-30 ⏰ 09:00\n'],
  ] as const)(
    'repeats a %s right extension through parsed repository/index outcomes',
    async (_label, source) => {
      const app = await createAppWithFiles({ 'qa.md': source });
      seedTaskCache(app, 'qa.md', [{ task: ' ', parent: -1, line: 0 }]);
      const application = configuredTaskApplication(app, DEFAULT_SETTINGS);
      await application.index.initialize();
      const hooks = {
        onCommitted: vi.fn(),
        onSettled: vi.fn(),
        present: vi.fn(),
      };
      const queue = new TimedBlockKeyboardQueue(application.tasks, hooks);
      const original = application.index.list({ filePath: 'qa.md' })[0]!;

      queue.enqueue(original, { type: 'extend-due', days: 1 });
      queue.enqueue(original, { type: 'extend-due', days: 1 });
      await vi.waitFor(() => expect(hooks.onSettled).toHaveBeenCalledOnce());
      await flushMicrotasks();

      const final = hooks.onCommitted.mock.calls[1]?.[0] as TaskSnapshot | undefined;
      expect(final?.planning).toMatchObject({
        start: '2026-07-10',
        scheduled: '2026-07-10',
        due: '2026-07-12',
      });
      expect(application.index.list({ filePath: 'qa.md' })[0]?.planning).toMatchObject({
        start: '2026-07-10',
        scheduled: '2026-07-10',
        due: '2026-07-12',
      });
      const file = app.vault.getMarkdownFiles()[0]!;
      const content = await app.vault.cachedRead(file);
      expect(content).toContain('🛫 2026-07-10');
      expect(content).toContain('⏳ 2026-07-10');
      expect(content).toContain('📅 2026-07-12');
      expect(content).not.toContain('2026-08-30');
      application.index.destroy();
    },
  );

  it.each([
    ['scheduled-only', null, '2026-07-10'],
    ['scheduled with an unrelated deadline', '2026-08-30', '2026-07-10'],
  ] as const)(
    'extends a %s task left by atomically creating a span around its rendered anchor',
    (_label, originalDue, scheduled) => {
      const execute = vi
        .fn<TaskApplicationApi['execute']>()
        .mockImplementation(() => new Promise(() => {}));
      const { queue } = harness(execute);

      queue.enqueue(taskAt('09:00', 'revision-1', { due: originalDue, scheduled }), {
        type: 'extend-start',
        days: -1,
      });

      expect(execute).toHaveBeenCalledWith({
        type: 'patch',
        target: { type: 'task', ref: expect.objectContaining({ revision: 'revision-1' }) },
        patch: {
          start: { type: 'set', value: '2026-07-09' },
          due: { type: 'set', value: '2026-07-10' },
        },
      });
    },
  );

  it('rebases the active task identity when a returned snapshot moves to another source line', async () => {
    const first = deferred<TaskCommandResult>();
    const second = deferred<TaskCommandResult>();
    const execute = vi
      .fn<TaskApplicationApi['execute']>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { queue, hooks } = harness(execute);
    const original = taskAt('09:00', 'revision-1', { line: 4 });

    queue.enqueue(original, { type: 'move-time', deltaMinutes: 15 });
    queue.enqueue(original, { type: 'move-time', deltaMinutes: 15 });
    const moved = taskAt('09:15', 'revision-2', { line: 5 });
    first.resolve(ok(moved));
    await expectSecondCall(execute);

    expect(execute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        target: {
          type: 'task',
          ref: expect.objectContaining({ line: 5, revision: 'revision-2' }),
        },
      }),
    );
    const final = taskAt('09:30', 'revision-3', { line: 5 });
    second.resolve(ok(final));
    await vi.waitFor(() => expect(hooks.onSettled).toHaveBeenCalledOnce());
    expect(hooks.onCommitted.mock.calls.map((call) => call[2])).toEqual([1, 1]);
    expect(hooks.onSettled).toHaveBeenCalledWith('qa.md:5', 1, {
      executed: true,
      anyChanged: true,
      sourceChanged: true,
    });
  });

  it('keeps outgoing source aliases in the same sequence and executes them against the latest returned ref', async () => {
    const first = deferred<TaskCommandResult>();
    const second = deferred<TaskCommandResult>();
    const execute = vi
      .fn<TaskApplicationApi['execute']>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { queue, hooks } = harness(execute);
    const original = taskAt('09:00', 'revision-1', { line: 4 });
    const moved = taskAt('09:15', 'revision-2', { line: 5 });
    const final = taskAt('09:30', 'revision-3', { line: 6 });
    hooks.onCommitted.mockImplementationOnce(() => {
      expect(queue.enqueue(original, { type: 'move-time', deltaMinutes: 15 })).toBe(1);
    });

    expect(queue.enqueue(original, { type: 'move-time', deltaMinutes: 15 })).toBe(1);
    first.resolve(ok(moved));
    await expectSecondCall(execute);

    expect(execute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        target: {
          type: 'task',
          ref: expect.objectContaining({ line: 5, revision: 'revision-2' }),
        },
      }),
    );
    second.resolve(ok(final));
    await vi.waitFor(() => expect(hooks.onSettled).toHaveBeenCalledOnce());

    expect(hooks.onCommitted.mock.calls.map((call) => call[2])).toEqual([1, 1]);
    expect(hooks.onSettled).toHaveBeenCalledWith(
      'qa.md:6',
      1,
      expect.objectContaining({ executed: true, anyChanged: true }),
    );
  });

  it('starts a new sequence for an unknown revision that now occupies an outgoing source line', async () => {
    const first = deferred<TaskCommandResult>();
    const second = deferred<TaskCommandResult>();
    const execute = vi
      .fn<TaskApplicationApi['execute']>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { queue, hooks } = harness(execute);
    const original = taskAt('09:00', 'revision-1', { line: 4 });
    const moved = taskAt('09:15', 'revision-2', { line: 5 });
    const replacement = taskAt('14:00', 'replacement-revision', { line: 4 });
    let replacementSequence: number | undefined;
    hooks.onCommitted.mockImplementationOnce(() => {
      replacementSequence = queue.enqueue(replacement, { type: 'move-time', deltaMinutes: 15 });
    });

    queue.enqueue(original, { type: 'move-time', deltaMinutes: 15 });
    first.resolve(ok(moved));
    await expectSecondCall(execute);

    expect(replacementSequence).toBe(2);
    expect(execute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        target: {
          type: 'task',
          ref: expect.objectContaining({ line: 4, revision: 'replacement-revision' }),
        },
      }),
    );
    second.resolve(ok(taskAt('14:15', 'replacement-revision-2', { line: 4 })));
    await vi.waitFor(() => expect(hooks.onSettled).toHaveBeenCalledOnce());
    expect(hooks.onSettled.mock.calls[0]?.[1]).toBe(2);
  });

  it.each([
    ['lower start', '0000-01-01', { type: 'extend-start', days: -1 }],
    ['upper due', '9999-12-31', { type: 'extend-due', days: 1 }],
  ] as const)('settles a %s boundary intent without executing', async (_label, due, intent) => {
    const execute = vi.fn<TaskApplicationApi['execute']>();
    const { queue, hooks } = harness(execute);

    const sequence = queue.enqueue(taskAt('09:00', 'revision-1', { due }), intent);

    expect(sequence).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
    expect(hooks.onSettled).toHaveBeenCalledWith('qa.md:0', 1, {
      executed: false,
      anyChanged: false,
      sourceChanged: false,
    });
  });

  it('settles an executed unchanged command without reporting a sequence change', async () => {
    const result = deferred<TaskCommandResult>();
    const execute = vi.fn<TaskApplicationApi['execute']>().mockReturnValueOnce(result.promise);
    const { queue, hooks } = harness(execute);
    const snapshot = taskAt('00:00');

    queue.enqueue(snapshot, { type: 'move-time', deltaMinutes: -15 });
    result.resolve(okUnchanged(snapshot));
    await vi.waitFor(() => expect(hooks.onSettled).toHaveBeenCalledOnce());

    expect(hooks.onSettled).toHaveBeenCalledWith('qa.md:0', 1, {
      executed: true,
      anyChanged: false,
      sourceChanged: false,
    });
  });

  it.each([
    ['line', { line: 4 }, { line: 5 }],
    ['path', { filePath: 'before.md' }, { filePath: 'after.md' }],
  ] as const)(
    'reports a changed:false %s move as a source change',
    async (_label, originalOverrides, movedOverrides) => {
      const result = deferred<TaskCommandResult>();
      const execute = vi.fn<TaskApplicationApi['execute']>().mockReturnValueOnce(result.promise);
      const { queue, hooks } = harness(execute);
      const original = taskAt('09:00', 'revision-1', originalOverrides);
      const moved = taskAt('09:00', 'revision-2', movedOverrides);

      queue.enqueue(original, { type: 'move-time', deltaMinutes: 15 });
      result.resolve(okUnchanged(moved));
      await vi.waitFor(() => expect(hooks.onSettled).toHaveBeenCalledOnce());

      expect(hooks.onSettled).toHaveBeenCalledWith(
        `${moved.source.filePath}:${moved.source.line}`,
        1,
        {
          executed: true,
          anyChanged: false,
          sourceChanged: true,
        },
      );
    },
  );

  it('retains anyChanged when an earlier command changed and a later command is unchanged', async () => {
    const first = deferred<TaskCommandResult>();
    const second = deferred<TaskCommandResult>();
    const execute = vi
      .fn<TaskApplicationApi['execute']>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { queue, hooks } = harness(execute);
    const original = taskAt('00:15');
    const clamped = taskAt('00:00', 'revision-2');

    queue.enqueue(original, { type: 'move-time', deltaMinutes: -15 });
    queue.enqueue(original, { type: 'move-time', deltaMinutes: -15 });
    first.resolve(ok(clamped));
    await expectSecondCall(execute);
    second.resolve(okUnchanged(clamped));
    await vi.waitFor(() => expect(hooks.onSettled).toHaveBeenCalledOnce());

    expect(hooks.onSettled).toHaveBeenCalledWith('qa.md:0', 1, {
      executed: true,
      anyChanged: true,
      sourceChanged: false,
    });
  });

  it.each(['throw', 'reject'] as const)(
    'presents repository io-error and cancels queued work after execute %s',
    async (failureMode) => {
      const execute = vi.fn<TaskApplicationApi['execute']>().mockImplementation(() => {
        if (failureMode === 'throw') throw new Error('boom');
        return Promise.reject(new Error('boom'));
      });
      const { queue, hooks } = harness(execute);
      const original = taskAt('09:00');

      queue.enqueue(original, { type: 'move-time', deltaMinutes: 15 });
      if (failureMode === 'reject') {
        queue.enqueue(original, { type: 'move-time', deltaMinutes: 15 });
      }
      await vi.waitFor(() => expect(hooks.onSettled).toHaveBeenCalledOnce());

      expect(execute).toHaveBeenCalledOnce();
      expect(hooks.present).toHaveBeenCalledWith({
        type: 'io-error',
        cause: 'repository-error',
        contentState: 'unknown',
      });
      expect(hooks.onCommitted).not.toHaveBeenCalled();
    },
  );

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
    expect(hooks.onSettled).toHaveBeenCalledWith('qa.md:0', 1, {
      executed: true,
      anyChanged: false,
      sourceChanged: false,
    });
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
      true,
    );
    expect(hooks.onSettled).toHaveBeenCalledWith('b.md:0', 2, {
      executed: true,
      anyChanged: true,
      sourceChanged: false,
    });
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
