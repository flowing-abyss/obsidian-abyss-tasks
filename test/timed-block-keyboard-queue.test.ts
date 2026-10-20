import { describe, expect, it, vi } from 'vitest';
import { CalendarCommands } from '../src/panels/calendar/calendarCommands';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import {
  localDate,
  type TaskApplicationApi,
  type TaskCommandResult,
  type TaskRef,
  type TaskSnapshot,
} from '../src/tasks';
import {
  TimedBlockKeyboardQueue,
  type TimedBlockKeyboardQueueHooks,
} from '../src/ui/timedBlockKeyboardQueue';
import {
  calendarMutationTarget,
  projectCalendarOccurrences,
  taskSnapshotForCalendarOccurrence,
} from '../src/views/calendarOccurrences';
import type { TimedBlockKeyboardIntent } from '../src/views/timegrid/renderTimedBlocks';
import {
  configuredTaskApplication,
  createAppWithFiles,
  expectDefined,
  flushMicrotasks,
  metadataChangedEmitter,
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
      ...(overrides.due === null ? {} : { due: overrides.due ?? '2026-07-20' }),
      ...(overrides.scheduled === undefined ? {} : { scheduled: overrides.scheduled }),
      ...(overrides.start === undefined ? {} : { start: overrides.start }),
      time,
      ...(overrides.duration === undefined ? {} : { duration: overrides.duration }),
    },
  });
}

function ok(updated: TaskSnapshot): TaskCommandResult {
  return { type: 'ok', changed: true, outcome: { type: 'task', task: updated } };
}

function okUnchanged(updated: TaskSnapshot): TaskCommandResult {
  return { type: 'ok', changed: false, outcome: { type: 'task', task: updated } };
}

function refMatching(expected: Partial<TaskRef>): TaskRef {
  return expect.objectContaining(expected) as TaskRef;
}

function harness(execute = vi.fn<TaskApplicationApi['execute']>()) {
  const api: TaskApplicationApi = {
    queries: queryApiForTasks(() => []),
    execute,
  };
  const hooks = {
    onCommitted: vi.fn<TimedBlockKeyboardQueueHooks['onCommitted']>(),
    onSettled: vi.fn<TimedBlockKeyboardQueueHooks['onSettled']>(),
    present: vi.fn<TimedBlockKeyboardQueueHooks['present']>(),
    onInvalidated: vi.fn<TimedBlockKeyboardQueueHooks['onInvalidated']>(),
  };
  return { api, hooks, queue: new TimedBlockKeyboardQueue(api, hooks) };
}

async function expectSecondCall(execute: ReturnType<typeof vi.fn>): Promise<void> {
  await vi.waitFor(() => {
    expect(execute).toHaveBeenCalledTimes(2);
  });
}

describe('TimedBlockKeyboardQueue', () => {
  it.each(['pending', 'settled'] as const)(
    'preserves the due point authority after a %s keyboard edit of its scheduled point',
    async (phase) => {
      const app = await createAppWithFiles({
        'qa.md': '- [ ] Paired ⏳ 2026-10-19 📅 2026-10-20 ⏰ 09:00 ⏱️ 1h',
      });
      seedTaskCache(app, 'qa.md', [{ task: ' ', parent: -1, line: 0 }]);
      const application = configuredTaskApplication(app, DEFAULT_SETTINGS);
      await application.index.initialize();
      try {
        const displays = () => {
          const root = expectDefined(application.index.list()[0]);
          return projectCalendarOccurrences(
            {
              materialized: [{ root, node: root, target: { type: 'task', ref: root.ref } }],
              recurringSources: [],
            },
            { from: localDate('2026-10-19'), to: localDate('2026-10-22') },
            { removeScheduledDate: false },
          ).occurrences.map(taskSnapshotForCalendarOccurrence);
        };
        const gate = deferred<void>();
        const execute = vi.fn<TaskApplicationApi['execute']>(async (...args) => {
          await gate.promise;
          return application.tasks.execute(...args);
        });
        const hooks = harness().hooks;
        const queue = new TimedBlockKeyboardQueue({ ...application.tasks, execute }, hooks);
        const [scheduled, due] = displays();
        queue.enqueue(expectDefined(scheduled), { type: 'move-time', deltaMinutes: 15 });
        const pending =
          phase === 'pending' ? queue.settlePointerTask(expectDefined(due)) : undefined;
        gate.resolve();
        await vi.waitFor(() => {
          expect(hooks.onSettled).toHaveBeenCalledOnce();
        });
        const currentDue = expectDefined(displays()[1]);
        const pointer = await (pending ?? queue.settlePointerTask(currentDue));
        const commands = new CalendarCommands({
          tasks: application.tasks,
          queries: application.tasks.queries,
        });
        await commands.commitTimedMove(
          pointer,
          {
            date: localDate('2026-10-22'),
            startMinutes: 600,
            dayDelta: 2,
            destination: 'time-grid',
          },
          phase === 'pending' ? expectDefined(due) : currentDue,
        );
        expect(application.index.list()[0]?.planning).toMatchObject({
          scheduled: '2026-10-19',
          due: '2026-10-22',
          time: '10:00',
        });
      } finally {
        application.index.destroy();
      }
    },
  );

  it.each([
    {
      handoff: 'keyboard',
      external: false,
      direct: false,
      pointer: false,
      duration: undefined,
      settled: 'onSettled',
      time: '10:30',
      title: 'B',
    },
    {
      handoff: 'external',
      external: true,
      direct: false,
      pointer: false,
      duration: undefined,
      settled: 'onSettled',
      time: '10:00',
      title: 'Replacement',
    },
    {
      handoff: 'pointer',
      external: false,
      direct: false,
      pointer: true,
      duration: 90,
      settled: 'onSettled',
      time: '10:00',
      title: 'B',
    },
    {
      handoff: 'direct-pointer',
      external: false,
      direct: true,
      pointer: true,
      duration: 90,
      settled: 'onSettled',
      time: '10:00',
      title: 'B',
    },
    {
      handoff: 'direct-pointer-external',
      external: true,
      direct: true,
      pointer: true,
      duration: undefined,
      settled: 'onInvalidated',
      time: '10:00',
      title: 'Replacement',
    },
  ] as const)(
    'carries only the owned sibling root change ($handoff)',
    async ({ external, direct, pointer: usePointer, duration, settled, time, title }) => {
      const app = await createAppWithFiles({
        'qa.md': '- [ ] Parent\n  - [ ] A 📅 2026-10-20 ⏰ 09:00\n  - [ ] B 📅 2026-10-20 ⏰ 10:00',
      });
      seedTaskCache(app, 'qa.md', [{ task: ' ', parent: -1, line: 0 }]);
      const application = configuredTaskApplication(app, DEFAULT_SETTINGS);
      await application.index.initialize();
      try {
        const root = expectDefined(application.index.list()[0]);
        const displays = projectCalendarOccurrences(
          {
            materialized: root.subtasks.map((node) => ({
              root,
              node,
              target: { type: 'subtask' as const, ref: node.ref },
            })),
            recurringSources: [],
          },
          { from: localDate('2026-10-20'), to: localDate('2026-10-20') },
          { removeScheduledDate: false },
        ).occurrences.map(taskSnapshotForCalendarOccurrence);
        const gate = deferred<void>();
        const execute = vi.fn<TaskApplicationApi['execute']>(async (...args) => {
          const first = execute.mock.calls.length === 1;
          if (first) await gate.promise;
          const result = await application.tasks.execute(...args);
          if (!first || !external || result.type !== 'ok' || result.outcome.type !== 'task')
            return result;
          const file = expectDefined(app.vault.getFileByPath('qa.md'));
          const text = (await app.vault.read(file)).replace('- [ ] B ', '- [ ] Replacement ');
          await app.vault.modify(file, text);
          metadataChangedEmitter(app)(file, text, app.metadataCache.getFileCache(file) ?? {});
          await flushMicrotasks();
          return {
            ...result,
            outcome: { ...result.outcome, task: expectDefined(application.index.list()[0]) },
          };
        });
        const hooks = harness().hooks;
        const queue = new TimedBlockKeyboardQueue({ ...application.tasks, execute }, hooks);
        queue.enqueue(expectDefined(displays[0]), { type: 'move-time', deltaMinutes: 15 });
        if (!direct) {
          queue.enqueue(expectDefined(displays[1]), { type: 'move-time', deltaMinutes: 15 });
          queue.enqueue(expectDefined(displays[1]), { type: 'move-time', deltaMinutes: 15 });
        }
        const pointer = usePointer
          ? queue.settlePointerTask(expectDefined(displays[1]))
          : undefined;
        gate.resolve();
        if (pointer !== undefined) {
          const commands = new CalendarCommands({
            tasks: application.tasks,
            queries: application.tasks.queries,
          });
          await commands.setDuration(await pointer, 90);
          expect(application.index.list()[0]?.subtasks[1]?.planning.duration).toBe(duration);
        }
        await vi.waitFor(() => {
          expect(hooks[settled]).toHaveBeenCalledOnce();
        });
        expect(application.index.list()[0]?.subtasks.map((node) => node.planning.time)).toEqual([
          '09:15',
          time,
        ]);
        expect(application.index.list()[0]?.subtasks[1]?.title).toBe(title);
      } finally {
        application.index.destroy();
      }
    },
  );

  it.each([false, true])(
    'carries sibling authority across successive receipts (published=%s)',
    async (published) => {
      const app = await createAppWithFiles({
        'qa.md': '- [ ] Parent\n  - [ ] A 📅 2026-10-20 ⏰ 09:00\n  - [ ] B 📅 2026-10-20 ⏰ 11:00',
      });
      seedTaskCache(app, 'qa.md', [{ task: ' ', parent: -1, line: 0 }]);
      const application = configuredTaskApplication(app, DEFAULT_SETTINGS);
      await application.index.initialize();
      try {
        const displays = () =>
          projectCalendarOccurrences(
            application.index.forCalendarProjection([localDate('2026-10-20')]),
            { from: localDate('2026-10-20'), to: localDate('2026-10-20') },
            { removeScheduledDate: false },
          )
            .occurrences.filter((o) => o.source.target.type === 'subtask')
            .map(taskSnapshotForCalendarOccurrence);
        let [a, b] = displays();
        const hooks = harness().hooks;
        const queue = new TimedBlockKeyboardQueue(application.tasks, hooks);
        queue.enqueue(expectDefined(a), { type: 'move-time', deltaMinutes: 15 });
        await vi.waitFor(() => {
          expect(hooks.onSettled).toHaveBeenCalledTimes(1);
        });
        if (published) {
          queue.published();
          [a, b] = displays();
        }
        queue.enqueue(expectDefined(a), { type: 'move-time', deltaMinutes: 15 });
        await vi.waitFor(() => {
          expect(hooks.onSettled).toHaveBeenCalledTimes(2);
        });
        const commands = new CalendarCommands({
          tasks: application.tasks,
          queries: application.index,
        });
        await commands.setDuration(await queue.settlePointerTask(expectDefined(b)), 90);
        expect(application.index.list()[0]?.subtasks.map((node) => node.planning)).toEqual([
          expect.objectContaining({ time: '09:30' }),
          expect.objectContaining({ time: '11:00', duration: 90 }),
        ]);
      } finally {
        application.index.destroy();
      }
    },
  );

  it.each([false, true])(
    'settles a forecast pointer against its owned series (child=%s)',
    async (child) => {
      const text = '- [ ] Series 📅 2026-10-20 ⏰ 09:00 ⏱️ 1h 🔁 every day';
      const app = await createAppWithFiles({ 'qa.md': child ? `- [ ] Parent\n  ${text}` : text });
      seedTaskCache(app, 'qa.md', [{ task: ' ', parent: -1, line: 0 }]);
      const application = configuredTaskApplication(app, DEFAULT_SETTINGS);
      await application.index.initialize();
      try {
        const range = { from: localDate('2026-10-20'), to: localDate('2026-10-21') };
        const occurrences = projectCalendarOccurrences(
          application.index.forCalendarProjection([range.from, range.to]),
          range,
          { removeScheduledDate: false },
        ).occurrences;
        const materialized = taskSnapshotForCalendarOccurrence(
          expectDefined(
            occurrences.find(
              (o) => o.kind === 'materialized' && o.source.node.recurrence !== undefined,
            ),
          ),
        );
        const forecast = taskSnapshotForCalendarOccurrence(
          expectDefined(occurrences.find((o) => o.kind === 'forecast')),
        );
        const gate = deferred<void>();
        const execute = vi.fn<TaskApplicationApi['execute']>(async (...args) => {
          await gate.promise;
          return application.tasks.execute(...args);
        });
        const queue = new TimedBlockKeyboardQueue(
          { ...application.tasks, execute },
          harness().hooks,
        );
        queue.enqueue(materialized, { type: 'move-time', deltaMinutes: 15 });
        queue.enqueue(materialized, { type: 'move-time', deltaMinutes: 15 });
        const pending = queue.settlePointerTask(forecast);
        gate.resolve();
        const successor = await pending;
        expect(successor.planning.due).toBe('2026-10-21');
        const commands = new CalendarCommands({
          tasks: application.tasks,
          queries: application.index,
        });
        await commands.commitTimedDuration(
          successor,
          { startMinutes: 540, durationMinutes: 90, endMinutes: 630, edge: 'end' },
          forecast,
        );
        const root = expectDefined(application.index.list()[0]);
        const node = child ? expectDefined(root.subtasks[0]) : root;
        expect(node.planning).toMatchObject({ due: '2026-10-20', time: '09:15', duration: 75 });
        expect(node.recurrence).toBeDefined();
        expect(execute).toHaveBeenCalledOnce();
      } finally {
        application.index.destroy();
      }
    },
  );

  it('continues keyboard edits on an origin still retained by a pointer gesture', async () => {
    const original = taskAt('09:00');
    const updated = taskAt('09:15', 'revision-2');
    const execute = vi
      .fn<TaskApplicationApi['execute']>()
      .mockResolvedValueOnce(ok(updated))
      .mockResolvedValueOnce(ok(taskAt('09:30', 'revision-3')));
    const { queue, hooks } = harness(execute);
    queue.enqueue(original, { type: 'move-time', deltaMinutes: 15 });
    await vi.waitFor(() => {
      expect(hooks.onSettled).toHaveBeenCalledOnce();
    });
    queue.enqueue(original, { type: 'move-time', deltaMinutes: 15 });
    expect(execute).toHaveBeenLastCalledWith({
      type: 'patch',
      target: { type: 'task', ref: updated.ref },
      patch: { time: { type: 'set', value: '09:30' } },
    });
  });

  it('hands a pending pointer commit its owned receipt and discards unsent repeats', async () => {
    const receipt = deferred<TaskCommandResult>();
    const execute = vi.fn().mockReturnValue(receipt.promise);
    const { queue } = harness(execute);
    const original = taskAt('09:00');
    const updated = taskAt('09:15', 'revision-2');
    queue.enqueue(original, { type: 'move-time', deltaMinutes: 15 });
    queue.enqueue(original, { type: 'move-time', deltaMinutes: 15 });
    const successor = queue.settlePointerTask(original);
    receipt.resolve(ok(updated));
    expect(await successor).toBe(updated);
    expect(execute).toHaveBeenCalledOnce();
    expect(await queue.settlePointerTask(original)).toBe(updated);
    const external = taskAt('12:00', 'external-replacement');
    expect(await queue.settlePointerTask(external)).toBe(external);
    queue.cancel();
    expect(await queue.settlePointerTask(original)).toBe(original);
  });

  it.each(['cancel', 'refuse'] as const)(
    'does not grant a pointer successor after keyboard %s',
    async (ending) => {
      const receipt = deferred<TaskCommandResult>();
      const { queue } = harness(vi.fn().mockReturnValue(receipt.promise));
      const original = taskAt('09:00');
      queue.enqueue(original, { type: 'move-time', deltaMinutes: 15 });
      const successor = queue.settlePointerTask(original);
      if (ending === 'cancel') queue.cancel();
      receipt.resolve(
        ending === 'cancel'
          ? ok(taskAt('09:15', 'revision-2'))
          : { type: 'not-found', target: { type: 'task', ref: original.ref } },
      );
      expect(await successor).toBe(original);
    },
  );

  it.each(['move-time', 'resize-duration'] as const)(
    'preserves reversal after a coalesced %s reaches its lower clamp',
    async (type) => {
      const app = await createAppWithFiles({
        'qa.md': '- [ ] task 📅 2026-07-20 ⏰ 00:15 ⏱️ 10m\n',
      });
      seedTaskCache(app, 'qa.md', [{ task: ' ', parent: -1, line: 0 }]);
      const application = configuredTaskApplication(app, DEFAULT_SETTINGS);
      await application.index.initialize();
      const gate = deferred<void>();
      const execute = vi.fn<TaskApplicationApi['execute']>(async (...args) => {
        if (execute.mock.calls.length === 1) await gate.promise;
        return application.tasks.execute(...args);
      });
      const hooks = harness().hooks;
      const queue = new TimedBlockKeyboardQueue({ ...application.tasks, execute }, hooks);
      const original = expectDefined(application.index.list({ filePath: 'qa.md' })[0]);
      const up: TimedBlockKeyboardIntent =
        type === 'move-time' ? { type, deltaMinutes: -15 } : { type, deltaMinutes: -5 };
      const down: TimedBlockKeyboardIntent =
        type === 'move-time' ? { type, deltaMinutes: 15 } : { type, deltaMinutes: 5 };
      for (let index = 0; index < 11; index++) queue.enqueue(original, up);
      queue.enqueue(original, down);
      queue.enqueue(original, down);
      gate.resolve();
      await vi.waitFor(() => {
        expect(hooks.onSettled).toHaveBeenCalledOnce();
      });
      expect(application.index.list({ filePath: 'qa.md' })[0]?.planning).toMatchObject(
        type === 'move-time' ? { time: '00:30', duration: 10 } : { time: '00:15', duration: 15 },
      );
      expect(execute).toHaveBeenCalledTimes(3);
      application.index.destroy();
    },
  );

  it.each([
    ['move-time', '14:15', 60],
    ['resize-duration', '09:00', 165],
  ] as const)(
    'coalesces held %s inputs behind one pending write and rebases the accumulated target',
    async (type, expectedTime, expectedDuration) => {
      const source = '- [ ] task 📅 2026-07-20 ⏰ 09:00 ⏱️ 1h\n';
      const app = await createAppWithFiles({ 'qa.md': source });
      seedTaskCache(app, 'qa.md', [{ task: ' ', parent: -1, line: 0 }]);
      const application = configuredTaskApplication(app, DEFAULT_SETTINGS);
      await application.index.initialize();
      const gate = deferred<void>();
      const execute = vi.fn<TaskApplicationApi['execute']>(async (...args) => {
        if (execute.mock.calls.length === 1) await gate.promise;
        return application.tasks.execute(...args);
      });
      const hooks = harness().hooks;
      const queue = new TimedBlockKeyboardQueue({ ...application.tasks, execute }, hooks);
      const original = expectDefined(application.index.list({ filePath: 'qa.md' })[0]);
      const intent: TimedBlockKeyboardIntent =
        type === 'move-time' ? { type, deltaMinutes: 15 } : { type, deltaMinutes: 5 };
      for (let index = 0; index < 21; index++) queue.enqueue(original, intent);
      gate.resolve();
      await vi.waitFor(() => {
        expect(hooks.onSettled).toHaveBeenCalledOnce();
      });
      expect(application.index.list({ filePath: 'qa.md' })[0]?.planning).toMatchObject({
        time: expectedTime,
        duration: expectedDuration,
      });
      expect(execute).toHaveBeenCalledTimes(2);
      application.index.destroy();
    },
  );

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
    await vi.waitFor(() => {
      expect(hooks.onSettled).toHaveBeenCalledOnce();
    });

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
      target: { type: 'task', ref: refMatching({ revision: 'revision-2' }) },
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
      .mockReturnValueOnce(expectDefined(results[0]).promise)
      .mockReturnValueOnce(expectDefined(results[1]).promise)
      .mockReturnValueOnce(expectDefined(results[2]).promise);
    const { queue } = harness(execute);

    queue.enqueue(taskAt('09:00', 'revision-1', { duration: 60 }), {
      type: 'resize-duration',
      deltaMinutes: 5,
    });
    queue.enqueue(taskAt('09:00', 'revision-1', { duration: 60 }), {
      type: 'resize-duration',
      deltaMinutes: 5,
    });
    expectDefined(results[0]).resolve(ok(taskAt('09:00', 'revision-2', { duration: 65 })));
    await expectSecondCall(execute);
    expect(execute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ patch: { duration: { type: 'set', value: 70 } } }),
    );
    expectDefined(results[1]).resolve(ok(taskAt('09:00', 'revision-3', { duration: 70 })));
    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(2);
    });

    queue.enqueue(taskAt('10:00', 'revision-4'), {
      type: 'resize-duration',
      deltaMinutes: 5,
    });
    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(3);
    });
    expect(execute).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ patch: { duration: { type: 'set', value: 65 } } }),
    );
    expectDefined(results[2]).resolve(ok(taskAt('10:00', 'revision-5', { duration: 65 })));
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
    expect(execute).toHaveBeenNthCalledWith(
      1,
      {
        type: 'shift-schedule',
        ref: refMatching({ revision: 'revision-1' }),
        days: 1,
      },
      expect.any(Object) as NonNullable<Parameters<TaskApplicationApi['execute']>[1]>,
    );

    first.resolve(ok(taskAt('09:00', 'revision-2', { due: '2026-07-21' })));
    await expectSecondCall(execute);
    expect(execute).toHaveBeenNthCalledWith(
      2,
      {
        type: 'shift-schedule',
        ref: refMatching({ revision: 'revision-2' }),
        days: 1,
      },
      expect.any(Object) as NonNullable<Parameters<TaskApplicationApi['execute']>[1]>,
    );
    second.resolve(ok(taskAt('09:00', 'revision-3', { due: '2026-07-22' })));
  });

  it('shrinks only the due date, stops at start, and preserves a queued right extension', async () => {
    const source = '- [ ] task 🛫 2026-07-20 📅 2026-07-22 ⏰ 09:00\n';
    const app = await createAppWithFiles({ 'qa.md': source });
    seedTaskCache(app, 'qa.md', [{ task: ' ', parent: -1, line: 0 }]);
    const application = configuredTaskApplication(app, DEFAULT_SETTINGS);
    await application.index.initialize();
    const hooks = harness().hooks;
    const queue = new TimedBlockKeyboardQueue(application.tasks, hooks);
    const original = expectDefined(application.index.list({ filePath: 'qa.md' })[0]);

    queue.enqueue(original, { type: 'extend-due', days: -1 });
    queue.enqueue(original, { type: 'extend-due', days: -1 });
    queue.enqueue(original, { type: 'extend-due', days: -1 });
    queue.enqueue(original, { type: 'extend-due', days: 1 });
    await vi.waitFor(() => {
      expect(hooks.onSettled).toHaveBeenCalledOnce();
    });

    expect(hooks.onCommitted.mock.calls.map(([updated]) => updated.planning)).toEqual([
      expect.objectContaining({ start: '2026-07-20', due: '2026-07-21' }),
      expect.objectContaining({ start: '2026-07-20', due: '2026-07-20' }),
      expect.objectContaining({ start: '2026-07-20', due: '2026-07-21' }),
    ]);
    expect(application.index.list({ filePath: 'qa.md' })[0]?.planning).toMatchObject({
      start: '2026-07-20',
      due: '2026-07-21',
    });
    application.index.destroy();
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
      expect(execute).toHaveBeenNthCalledWith(
        1,
        {
          type: 'extend-span',
          ref: refMatching({ revision: 'revision-1' }),
          due: '2026-07-11',
        },
        expect.any(Object) as NonNullable<Parameters<TaskApplicationApi['execute']>[1]>,
      );

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
      expect(execute).toHaveBeenNthCalledWith(
        2,
        {
          type: 'extend-span',
          ref: refMatching({ revision: 'revision-2' }),
          due: '2026-07-12',
        },
        expect.any(Object) as NonNullable<Parameters<TaskApplicationApi['execute']>[1]>,
      );
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
        onCommitted: vi.fn<TimedBlockKeyboardQueueHooks['onCommitted']>(),
        onSettled: vi.fn<TimedBlockKeyboardQueueHooks['onSettled']>(),
        present: vi.fn<TimedBlockKeyboardQueueHooks['present']>(),
        onInvalidated: vi.fn<TimedBlockKeyboardQueueHooks['onInvalidated']>(),
      };
      const queue = new TimedBlockKeyboardQueue(application.tasks, hooks);
      const original = expectDefined(application.index.list({ filePath: 'qa.md' })[0]);

      queue.enqueue(original, { type: 'extend-due', days: 1 });
      queue.enqueue(original, { type: 'extend-due', days: 1 });
      await vi.waitFor(() => {
        expect(hooks.onSettled).toHaveBeenCalledOnce();
      });
      await flushMicrotasks();

      const final = hooks.onCommitted.mock.calls[1]?.[0];
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
      const file = expectDefined(app.vault.getMarkdownFiles()[0]);
      const content = await app.vault.cachedRead(file);
      expect(content).toContain('🛫 2026-07-10');
      expect(content).toContain('⏳ 2026-07-10');
      expect(content).toContain('📅 2026-07-12');
      expect(content).not.toContain('2026-08-30');
      application.index.destroy();
    },
  );

  it.each([
    ['due-only', { due: '2026-07-10' }],
    ['scheduled-only', { due: null, scheduled: '2026-07-10' }],
    ['scheduled with an unrelated deadline', { due: '2026-08-30', scheduled: '2026-07-10' }],
    ['single-day span', { start: '2026-07-10', due: '2026-07-10' }],
    [
      'scheduled with an earlier start',
      { start: '2026-07-08', scheduled: '2026-07-10', due: null },
    ],
  ] as const)('does nothing when shrinking a %s task', (_label, planning) => {
    const execute = vi.fn<TaskApplicationApi['execute']>();
    const { queue, hooks } = harness(execute);
    queue.enqueue(taskAt('09:00', 'revision-1', planning), { type: 'extend-due', days: -1 });
    expect(execute).not.toHaveBeenCalled();
    expect(hooks.onSettled).toHaveBeenCalledWith('qa.md:0', 1, {
      executed: false,
      anyChanged: false,
      sourceChanged: false,
    });
  });

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
          ref: refMatching({ line: 5, revision: 'revision-2' }),
        },
      }),
    );
    const final = taskAt('09:30', 'revision-3', { line: 5 });
    second.resolve(ok(final));
    await vi.waitFor(() => {
      expect(hooks.onSettled).toHaveBeenCalledOnce();
    });
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
          ref: refMatching({ line: 5, revision: 'revision-2' }),
        },
      }),
    );
    second.resolve(ok(final));
    await vi.waitFor(() => {
      expect(hooks.onSettled).toHaveBeenCalledOnce();
    });

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
          ref: refMatching({ line: 4, revision: 'replacement-revision' }),
        },
      }),
    );
    second.resolve(ok(taskAt('14:15', 'replacement-revision-2', { line: 4 })));
    await vi.waitFor(() => {
      expect(hooks.onSettled).toHaveBeenCalledOnce();
    });
    expect(hooks.onSettled.mock.calls[0]?.[1]).toBe(2);
  });

  it.each([
    ['lower due', '0000-01-01', { type: 'extend-due', days: -1 }],
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
    await vi.waitFor(() => {
      expect(hooks.onSettled).toHaveBeenCalledOnce();
    });

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
      await vi.waitFor(() => {
        expect(hooks.onSettled).toHaveBeenCalledOnce();
      });

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
    await vi.waitFor(() => {
      expect(hooks.onSettled).toHaveBeenCalledOnce();
    });

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
      await vi.waitFor(() => {
        expect(hooks.onSettled).toHaveBeenCalledOnce();
      });

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
  ] as const)(
    'clamps %s mutations',
    (
      ...[_name, snapshot, intent, field, value]: readonly [
        string,
        TaskSnapshot,
        TimedBlockKeyboardIntent,
        'time' | 'duration',
        string | number,
      ]
    ) => {
      const execute = vi
        .fn<TaskApplicationApi['execute']>()
        .mockImplementation(() => new Promise(() => {}));
      const { queue } = harness(execute);
      queue.enqueue(snapshot, intent);
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({ patch: { [field]: { type: 'set', value } } }),
      );
    },
  );

  it('presents a failure, cancels the remaining sequence, and settles once', async () => {
    const first = deferred<TaskCommandResult>();
    const execute = vi.fn<TaskApplicationApi['execute']>().mockReturnValueOnce(first.promise);
    const { queue, hooks } = harness(execute);
    const snapshot = taskAt('09:00');

    queue.enqueue(snapshot, { type: 'move-time', deltaMinutes: 15 });
    queue.enqueue(snapshot, { type: 'move-time', deltaMinutes: 15 });
    const failure: TaskCommandResult = { type: 'conflict', current: snapshot };
    first.resolve(failure);
    await vi.waitFor(() => {
      expect(hooks.onSettled).toHaveBeenCalledTimes(1);
    });

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
        target: { type: 'task', ref: refMatching({ filePath: 'b.md' }) },
      }),
    );

    const updatedB = taskAt('10:15', 'b-2', { filePath: 'b.md' });
    second.resolve(ok(updatedB));
    await vi.waitFor(() => {
      expect(hooks.onSettled).toHaveBeenCalledTimes(1);
    });
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

describe('materialized child timed keyboard authority', () => {
  it.each([
    [
      'time',
      { type: 'move-time', deltaMinutes: 15 },
      { time: '10:30', duration: 90, scheduled: '2026-10-08' },
    ],
    [
      'duration',
      { type: 'resize-duration', deltaMinutes: 5 },
      { time: '10:00', duration: 100, scheduled: '2026-10-08' },
    ],
    [
      'date',
      { type: 'shift-schedule', days: 1 },
      { time: '10:00', duration: 90, scheduled: '2026-10-10' },
    ],
    [
      'span',
      { type: 'extend-due', days: 1 },
      {
        time: '10:00',
        duration: 90,
        scheduled: '2026-10-08',
        start: '2026-10-08',
        due: '2026-10-10',
      },
    ],
  ] as const)(
    'keeps two queued %s edits on the exact canonical child',
    async (_name, intent, planning) => {
      const source =
        'Untouched prose.\n- [ ] Parent ⏳ 2026-10-08 ⏰ 12:00\n  - [ ] Child ⏳ 2026-10-08 ⏰ 10:00 ⏱️ 90m\n  - [ ] Sibling ⏳ 2026-10-08 ⏰ 10:00 ⏱️ 90m\nTrailing prose.\n';
      const app = await createAppWithFiles({ 'qa.md': source });
      seedTaskCache(app, 'qa.md', [{ task: ' ', parent: -1, line: 1 }]);
      const application = configuredTaskApplication(app, DEFAULT_SETTINGS);
      await application.index.initialize();
      try {
        const root = expectDefined(application.index.list()[0]);
        const node = expectDefined(root.subtasks[0]);
        const projection = projectCalendarOccurrences(
          {
            materialized: [{ root, node, target: { type: 'subtask', ref: node.ref } }],
            recurringSources: [],
          },
          { from: localDate('2026-10-08'), to: localDate('2026-10-10') },
          { removeScheduledDate: false },
        );
        const display = taskSnapshotForCalendarOccurrence(expectDefined(projection.occurrences[0]));
        const hooks = harness().hooks,
          queue = new TimedBlockKeyboardQueue(application.tasks, hooks);
        queue.enqueue(display, intent);
        queue.enqueue(display, intent);
        await vi.waitFor(() => {
          expect(hooks.onSettled).toHaveBeenCalledOnce();
        });
        const updated = expectDefined(application.index.list()[0]);
        expect(updated.planning).toEqual(root.planning);
        expect(updated.subtasks[0]?.planning).toEqual(planning);
        expect(updated.subtasks[1]?.ref.originalBlock).toBe(
          '  - [ ] Sibling ⏳ 2026-10-08 ⏰ 10:00 ⏱️ 90m',
        );
        expect(hooks.onCommitted).toHaveBeenCalledTimes(2);
        for (const [committed] of hooks.onCommitted.mock.calls) {
          expect(committed.title).toBe('Child');
          expect(calendarMutationTarget(committed)?.type).toBe('subtask');
        }
        const pointerTask = await queue.settlePointerTask(display);
        expect(pointerTask.planning).toEqual(planning);
        expect(calendarMutationTarget(pointerTask)).toEqual({
          type: 'subtask',
          ref: updated.subtasks[0]?.ref,
        });
        const file = expectDefined(app.vault.getFileByPath('qa.md'));
        const bytes = await app.vault.read(file);
        expect(bytes.startsWith('Untouched prose.\n- [ ] Parent ⏳ 2026-10-08 ⏰ 12:00\n')).toBe(
          true,
        );
        expect(
          bytes.endsWith('  - [ ] Sibling ⏳ 2026-10-08 ⏰ 10:00 ⏱️ 90m\nTrailing prose.\n'),
        ).toBe(true);
      } finally {
        application.index.destroy();
      }
    },
  );
});

it('rebinds normalized child duration before the next queued time edit', async () => {
  const source = '- [ ] Parent\n  - [ ] Child ⏳ 2026-10-08 ⏰ 23:30 ⏱️ 30m\n';
  const app = await createAppWithFiles({ 'qa.md': source });
  seedTaskCache(app, 'qa.md', [{ task: ' ', parent: -1, line: 0 }]);
  const application = configuredTaskApplication(app, DEFAULT_SETTINGS);
  await application.index.initialize();
  try {
    const root = expectDefined(application.index.list()[0]),
      node = expectDefined(root.subtasks[0]);
    const display = taskSnapshotForCalendarOccurrence(
      expectDefined(
        projectCalendarOccurrences(
          {
            materialized: [{ root, node, target: { type: 'subtask', ref: node.ref } }],
            recurringSources: [],
          },
          { from: localDate('2026-10-08'), to: localDate('2026-10-08') },
          { removeScheduledDate: false },
        ).occurrences[0],
      ),
    );
    const hooks = harness().hooks,
      queue = new TimedBlockKeyboardQueue(application.tasks, hooks);
    queue.enqueue(display, { type: 'resize-duration', deltaMinutes: 5 });
    queue.enqueue(display, { type: 'move-time', deltaMinutes: -15 });
    await vi.waitFor(() => {
      expect(hooks.onSettled).toHaveBeenCalledOnce();
    });
    expect(application.index.list()[0]?.subtasks[0]?.planning).toEqual({
      scheduled: '2026-10-08',
      time: '23:15',
      duration: 30,
    });
    expect(application.index.list()[0]?.planning).toEqual({});
    expect(hooks.onCommitted.mock.calls.map(([task]) => task.planning.duration)).toEqual([30, 30]);
    expect(hooks.onInvalidated).not.toHaveBeenCalled();
  } finally {
    application.index.destroy();
  }
});

it('never executes forecast keyboard intents even when called directly', () => {
  const root = taskAt('10:00'),
    source = { root, node: root, target: { type: 'task' as const, ref: root.ref } };
  const forecast = taskSnapshotForCalendarOccurrence({
    kind: 'forecast',
    key: 'forecast-only',
    source,
    planning: root.planning,
    referenceDate: localDate('2026-10-09'),
    ordinal: 1,
  });
  const execute = vi.fn<TaskApplicationApi['execute']>();
  const { queue, hooks } = harness(execute);
  for (const intent of [
    { type: 'move-time', deltaMinutes: 15 },
    { type: 'resize-duration', deltaMinutes: 5 },
    { type: 'shift-schedule', days: 1 },
    { type: 'extend-due', days: 1 },
  ] as const)
    expect(queue.enqueue(forecast, intent)).toBeUndefined();
  expect(execute).not.toHaveBeenCalled();
  expect(hooks.onCommitted).not.toHaveBeenCalled();
});

it('retires queued child edits when a successful result cannot prove the owned child successor', async () => {
  const source = '- [ ] Parent\n  - [ ] Child ⏳ 2026-10-08 ⏰ 10:00 ⏱️ 90m\n  - [ ] Sibling\n';
  const app = await createAppWithFiles({ 'qa.md': source });
  seedTaskCache(app, 'qa.md', [{ task: ' ', parent: -1, line: 0 }]);
  const application = configuredTaskApplication(app, DEFAULT_SETTINGS);
  await application.index.initialize();
  try {
    const root = expectDefined(application.index.list()[0]),
      node = expectDefined(root.subtasks[0]);
    const display = taskSnapshotForCalendarOccurrence(
      expectDefined(
        projectCalendarOccurrences(
          {
            materialized: [{ root, node, target: { type: 'subtask', ref: node.ref } }],
            recurringSources: [],
          },
          { from: localDate('2026-10-08'), to: localDate('2026-10-08') },
          { removeScheduledDate: false },
        ).occurrences[0],
      ),
    );
    const release = deferred<void>();
    let executions = 0;
    const api: TaskApplicationApi = {
      queries: application.tasks.queries,
      execute: async (command, options) => {
        executions++;
        const result = await application.tasks.execute(command, options);
        await release.promise;
        return result.type === 'ok' && result.outcome.type === 'task'
          ? {
              ...result,
              outcome: { ...result.outcome, task: { ...result.outcome.task, subtasks: [] } },
            }
          : result;
      },
    };
    const hooks = harness().hooks,
      queue = new TimedBlockKeyboardQueue(api, hooks);
    queue.enqueue(display, { type: 'resize-duration', deltaMinutes: 5 });
    queue.enqueue(display, { type: 'move-time', deltaMinutes: 15 });
    release.resolve();
    await vi.waitFor(() => {
      expect(hooks.onInvalidated).toHaveBeenCalledOnce();
    });
    expect(executions).toBe(1);
    expect(application.index.list()[0]?.planning).toEqual({});
    expect(application.index.list()[0]?.subtasks[0]?.planning).toEqual({
      scheduled: '2026-10-08',
      time: '10:00',
      duration: 95,
    });
    expect(hooks.onCommitted).not.toHaveBeenCalled();
  } finally {
    application.index.destroy();
  }
});

it('does not let a queued child intent overwrite a source replacement after its first commit', async () => {
  const source = '- [ ] Parent\n  - [ ] Child ⏳ 2026-10-08 ⏰ 10:00 ⏱️ 90m\n';
  const app = await createAppWithFiles({ 'qa.md': source });
  seedTaskCache(app, 'qa.md', [{ task: ' ', parent: -1, line: 0 }]);
  const application = configuredTaskApplication(app, DEFAULT_SETTINGS);
  await application.index.initialize();
  try {
    const root = expectDefined(application.index.list()[0]),
      node = expectDefined(root.subtasks[0]);
    const display = taskSnapshotForCalendarOccurrence(
      expectDefined(
        projectCalendarOccurrences(
          {
            materialized: [{ root, node, target: { type: 'subtask', ref: node.ref } }],
            recurringSources: [],
          },
          { from: localDate('2026-10-08'), to: localDate('2026-10-08') },
          { removeScheduledDate: false },
        ).occurrences[0],
      ),
    );
    const committed = deferred<void>(),
      release = deferred<void>();
    let calls = 0;
    const api: TaskApplicationApi = {
      queries: application.tasks.queries,
      execute: async (command, options) => {
        calls++;
        const result = await application.tasks.execute(command, options);
        if (calls === 1) {
          committed.resolve();
          await release.promise;
        }
        return result;
      },
    };
    const hooks = harness().hooks,
      queue = new TimedBlockKeyboardQueue(api, hooks);
    queue.enqueue(display, { type: 'resize-duration', deltaMinutes: 5 });
    queue.enqueue(display, { type: 'move-time', deltaMinutes: 15 });
    await committed.promise;
    const file = expectDefined(app.vault.getFileByPath('qa.md')),
      external = (await app.vault.read(file)).replace('Child', 'External replacement');
    await app.vault.modify(file, external);
    application.index.installCommittedContent('qa.md', external);
    release.resolve();
    await vi.waitFor(() => {
      expect(hooks.onSettled).toHaveBeenCalledOnce();
    });
    expect(await app.vault.read(file)).toBe(external);
    expect(application.index.list()[0]?.planning).toEqual({});
    expect(hooks.onCommitted).toHaveBeenCalledOnce();
    expect(hooks.present.mock.calls[1]?.[0].type).not.toBe('ok');
  } finally {
    application.index.destroy();
  }
});

it.each([
  [
    'start-only',
    '🛫 2026-10-08',
    '2026-10-08',
    { start: '2026-10-08', due: '2026-10-09', time: '10:00' },
  ],
  [
    'inverted point',
    '🛫 2026-10-10 ⏳ 2026-10-10 📅 2026-10-08',
    '2026-10-10',
    { start: '2026-10-10', scheduled: '2026-10-10', due: '2026-10-11', time: '10:00' },
  ],
] as const)(
  'extends a materialized child %s from its occupied date',
  async (_label, dates, displayDate, want) => {
    const app = await createAppWithFiles({
      'qa.md': `- [ ] Parent\n  - [ ] Child ${dates} ⏰ 10:00\n`,
    });
    seedTaskCache(app, 'qa.md', [{ task: ' ', parent: -1, line: 0 }]);
    const application = configuredTaskApplication(app, DEFAULT_SETTINGS);
    await application.index.initialize();
    try {
      const root = expectDefined(application.index.list()[0]),
        node = expectDefined(root.subtasks[0]);
      const date = localDate(displayDate);
      const display = taskSnapshotForCalendarOccurrence(
        expectDefined(
          projectCalendarOccurrences(
            {
              materialized: [{ root, node, target: { type: 'subtask', ref: node.ref } }],
              recurringSources: [],
            },
            { from: date, to: date },
            { removeScheduledDate: false },
          ).occurrences[0],
        ),
      );
      const hooks = harness().hooks,
        queue = new TimedBlockKeyboardQueue(application.tasks, hooks);
      queue.enqueue(display, { type: 'extend-due', days: 1 });
      await vi.waitFor(() => {
        expect(hooks.onSettled).toHaveBeenCalledOnce();
      });
      expect(application.index.list()[0]?.subtasks[0]?.planning).toEqual(want);
      expect(application.index.list()[0]?.planning).toEqual({});
    } finally {
      application.index.destroy();
    }
  },
);
