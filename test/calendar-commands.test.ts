// @vitest-environment node
import type * as ObsidianModule from 'obsidian';
import { Notice } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { CalendarCommands } from '../src/panels/calendar/calendarCommands';
import {
  localDate,
  type TaskApplicationApi,
  type TaskCommand,
  type TaskSnapshot,
} from '../src/tasks';
import { canonicalStatusCatalog, expectDefined, task, taskQueryApi } from './helpers';

import { applyTaskCommand } from '../src/tasks/infrastructure/markdown/applyTaskCommand';
import { TaskMarkdownCodec } from '../src/tasks/infrastructure/markdown/TaskMarkdownCodec';

vi.mock('obsidian', async () => {
  const actual = await vi.importActual<typeof ObsidianModule>('obsidian');
  return { ...actual, Notice: vi.fn() };
});

function harness(tasks: readonly TaskSnapshot[] = []): {
  commands: CalendarCommands;
  execute: ReturnType<typeof vi.fn<TaskApplicationApi['execute']>>;
  lastCommand(): TaskCommand | undefined;
} {
  const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
    type: 'ok',
    changed: true,
    outcome: { type: 'task', task: task({ source: { filePath: 'f.md', line: 0 } }) },
  });
  const queries = taskQueryApi({ list: () => tasks });
  const commands = new CalendarCommands({ tasks: { queries, execute }, queries });
  return { commands, execute, lastCommand: () => execute.mock.lastCall?.[0] };
}

const dragData = (snapshot: TaskSnapshot): string =>
  `${snapshot.source.filePath}:::${snapshot.source.line}`;

describe('CalendarCommands.rescheduleFromDrag', () => {
  it('reschedules an all-day task to the target date', async () => {
    const plain = task({ planning: { due: '2026-09-20' } });
    const h = harness([plain]);
    await h.commands.rescheduleFromDrag(dragData(plain), '2026-09-23');
    expect(h.lastCommand()).toEqual({
      type: 'patch',
      target: { type: 'task', ref: plain.ref },
      patch: { due: { type: 'set', value: '2026-09-23' } },
    });
  });

  it('moves a timed task with an anchor by the day difference', async () => {
    const timed = task({ planning: { due: '2026-09-20', time: '09:00' } });
    const h = harness([timed]);
    await h.commands.rescheduleFromDrag(dragData(timed), '2026-09-23');
    expect(h.lastCommand()).toEqual({
      type: 'patch',
      target: { type: 'task', ref: timed.ref },
      patch: {
        due: { type: 'set', value: '2026-09-23' },
        time: { type: 'clear' },
        duration: { type: 'clear' },
      },
    });
  });

  it('converts a timed task without any anchor to all-day on the target date', async () => {
    const floating = task({ planning: { time: '09:00' } });
    const h = harness([floating]);
    await h.commands.rescheduleFromDrag(dragData(floating), '2026-09-23');
    expect(h.lastCommand()).toEqual({
      type: 'convert-to-all-day',
      ref: floating.ref,
      date: '2026-09-23',
    });
  });

  it('ignores malformed payloads, unknown tasks, invalid dates, and a missing application', async () => {
    const plain = task({ planning: { due: '2026-09-20' } });
    const h = harness([plain]);
    await h.commands.rescheduleFromDrag('no-separator', '2026-09-23');
    await h.commands.rescheduleFromDrag('f.md:::99', '2026-09-23');
    await h.commands.rescheduleFromDrag(dragData(plain), 'not-a-date');
    expect(h.execute).not.toHaveBeenCalled();
    const absent = new CalendarCommands({
      tasks: undefined,
      queries: taskQueryApi({ list: () => [plain] }),
    });
    await expect(absent.rescheduleFromDrag(dragData(plain), '2026-09-23')).resolves.toBeUndefined();
  });
});

describe('CalendarCommands.setTimeFromDrag', () => {
  it('moves a span to a time slot keeping the day difference', async () => {
    const span = task({ planning: { start: '2026-09-20', due: '2026-09-21' } });
    const h = harness([span]);
    await h.commands.setTimeFromDrag(dragData(span), '2026-09-23', '10:15');
    expect(h.lastCommand()).toEqual({
      type: 'move-time-slot',
      ref: span.ref,
      days: 2,
      time: '10:15',
    });
  });

  it('sets a time slot on a single-day task', async () => {
    const plain = task({ planning: { due: '2026-09-20' } });
    const h = harness([plain]);
    await h.commands.setTimeFromDrag(dragData(plain), '2026-09-23', '10:15');
    expect(h.lastCommand()).toEqual({
      type: 'patch',
      target: { type: 'task', ref: plain.ref },
      patch: { due: { type: 'set', value: '2026-09-23' }, time: { type: 'set', value: '10:15' } },
    });
  });

  it('swallows an invalid time', async () => {
    const plain = task({ planning: { due: '2026-09-20' } });
    const h = harness([plain]);
    await h.commands.setTimeFromDrag(dragData(plain), '2026-09-23', '25:99');
    expect(h.execute).not.toHaveBeenCalled();
  });
});

describe('CalendarCommands timed gestures', () => {
  it('moves a timed block to the all-day row or to a slot', async () => {
    const timed = task({ planning: { due: '2026-09-20', time: '09:00' } });
    const h = harness();
    await h.commands.commitTimedMove(timed, {
      date: localDate('2026-09-21'),
      startMinutes: 0,
      dayDelta: 1,
      destination: 'all-day',
    });
    expect(h.lastCommand()).toEqual({
      type: 'patch',
      target: { type: 'task', ref: timed.ref },
      patch: {
        due: { type: 'set', value: '2026-09-21' },
        time: { type: 'clear' },
        duration: { type: 'clear' },
      },
    });
    await h.commands.commitTimedMove(timed, {
      date: localDate('2026-09-21'),
      startMinutes: 615,
      dayDelta: 1,
      destination: 'time-grid',
    });
    expect(h.lastCommand()).toEqual({
      type: 'patch',
      target: { type: 'task', ref: timed.ref },
      patch: { due: { type: 'set', value: '2026-09-21' }, time: { type: 'set', value: '10:15' } },
    });
  });

  it('sets time and duration from a vertical resize', async () => {
    const timed = task({ planning: { due: '2026-09-20', time: '09:00', duration: 30 } });
    const h = harness();
    await h.commands.commitTimedDuration(timed, {
      edge: 'end',
      startMinutes: 540,
      durationMinutes: 45,
      endMinutes: 585,
    });
    expect(h.lastCommand()).toMatchObject({
      type: 'patch',
      target: { type: 'task', ref: timed.ref },
      patch: {
        time: { type: 'set', value: '09:00' },
        duration: { type: 'set', value: 45 },
      },
    });
  });

  it('sets a span boundary and a span shift', async () => {
    const span = task({ planning: { start: '2026-09-20', due: '2026-09-21' } });
    const h = harness();
    await h.commands.commitTimedBoundary(span, {
      boundary: 'due',
      date: localDate('2026-09-25'),
      dayDelta: 4,
    });
    expect(h.lastCommand()).toEqual({
      type: 'set-span-boundary',
      ref: span.ref,
      boundary: 'due',
      date: '2026-09-25',
    });
    await h.commands.commitSpanMove(span, {
      grabbedDate: localDate('2026-09-20'),
      targetDate: localDate('2026-09-22'),
      days: 2,
    });
    expect(h.lastCommand()).toEqual({ type: 'shift-schedule', ref: span.ref, days: 2 });
  });
});

describe('CalendarCommands field setters', () => {
  it('sets time, duration, start, due, and extends to a span', async () => {
    const timed = task({ planning: { due: '2026-09-20', time: '09:00' } });
    const h = harness();
    await h.commands.setTime(timed, 630);
    expect(h.lastCommand()).toMatchObject({
      type: 'patch',
      target: { type: 'task', ref: timed.ref },
      patch: { time: { type: 'set', value: '10:30' } },
    });
    await h.commands.setDuration(timed, 90);
    expect(h.lastCommand()).toMatchObject({
      type: 'patch',
      target: { type: 'task', ref: timed.ref },
      patch: { duration: { type: 'set', value: 90 } },
    });
    await h.commands.setStart(timed, '2026-09-18');
    expect(h.lastCommand()).toEqual({
      type: 'set-span-boundary',
      ref: timed.ref,
      boundary: 'start',
      date: '2026-09-18',
    });
    await h.commands.setDue(timed, '2026-09-26');
    expect(h.lastCommand()).toEqual({
      type: 'set-span-boundary',
      ref: timed.ref,
      boundary: 'due',
      date: '2026-09-26',
    });
    await h.commands.extendToSpan(timed, '2026-09-27');
    expect(h.lastCommand()).toEqual({ type: 'extend-span', ref: timed.ref, due: '2026-09-27' });
  });

  it('swallows invalid values and presents failures as notices', async () => {
    const timed = task({ planning: { due: '2026-09-20', time: '09:00' } });
    const h = harness();
    await h.commands.setStart(timed, 'never');
    expect(h.execute).not.toHaveBeenCalled();
    h.execute.mockResolvedValueOnce({ type: 'invalid', issues: [{ code: 'invalid-target' }] });
    await h.commands.setDue(timed, '2026-09-26');
    expect(Notice).toHaveBeenCalledTimes(1);
  });
});

describe('calendar writes use the authored duration invariant', () => {
  it.each([
    [5940, '09:00', 1, '⏰ 09:00 ⏱️ 15h 📅 2026-09-21'],
    [5940, '23:45', 0, '⏰ 23:45 ⏱️ 15m 📅 2026-09-20'],
    [5940, '20:30', 1, '⏰ 20:30 ⏱️ 3h30m 📅 2026-09-21'],
    [60, '09:00', 1, '⏰ 09:00 ⏱️ 1h 📅 2026-09-21'],
  ])('commits %i minutes at %s after a %i-day move', async (duration, time, dayDelta, expected) => {
    const timed = task({ planning: { due: '2026-09-20', time: '20:30', duration } });
    const h = harness();
    await h.commands.commitTimedMove(timed, {
      destination: 'time-grid',
      date: localDate(dayDelta === 0 ? '2026-09-20' : '2026-09-21'),
      dayDelta,
      startMinutes: Number(time.slice(0, 2)) * 60 + Number(time.slice(3)),
    });
    const command = h.lastCommand();
    expect(command?.type).toBe('patch');
    if (command?.type !== 'patch') throw new Error('expected point patch');
    const codec = new TaskMarkdownCodec(canonicalStatusCatalog());
    expect(
      applyTaskCommand(
        codec,
        `- [ ] Task ⏰ 20:30 ⏱️ ${duration === 60 ? '1h' : '99h'} 📅 2026-09-20`,
        command,
      ),
    ).toEqual({ type: 'changed', content: `- [ ] Task ${expected}` });
  });
});

it('resizes an actual materialized child through exact planning and the canonical writer', async () => {
  const source = '- [ ] Root\n  - [ ] Timed ⏳ 2026-10-08 ⏰ 09:00 ⏱️ 1h';
  const statuses = canonicalStatusCatalog();
  const codec = new TaskMarkdownCodec(statuses);
  const root = expectDefined(
    projectTaskSnapshot({
      codec,
      statusCatalog: statuses,
      filePath: 'tasks.md',
      lines: source.split('\n'),
      line: 0,
      exactBlock: source,
      ref: { filePath: 'tasks.md', line: 0, revision: 'old' },
      presentation: { linkCount: 0 },
      offsetAt: () => 0,
    }),
  );
  const node = expectDefined(root.subtasks[0]);
  expect(node.planning.duration).toBe(60);
  const occurrence = expectDefined(
    projectCalendarOccurrences(
      {
        materialized: [{ root, node, target: { type: 'subtask', ref: node.ref } }],
        recurringSources: [],
      },
      { from: localDate('2026-10-08'), to: localDate('2026-10-08') },
      { removeScheduledDate: false },
    ).occurrences[0],
  );
  const display = taskSnapshotForCalendarOccurrence(occurrence);
  const h = harness();
  await h.commands.setDuration(display, 90);
  const command = h.lastCommand();
  expect(command).toEqual({
    type: 'patch',
    target: { type: 'subtask', ref: node.ref },
    patch: { duration: { type: 'set', value: 90 } },
  });
  if (command?.type !== 'patch') throw new Error('expected exact patch');
  expect(applyTaskCommand(codec, expectDefined(source.split('\n')[1]), command)).toEqual({
    type: 'changed',
    content: '  - [ ] Timed ⏳ 2026-10-08 ⏰ 09:00 ⏱️ 1h30m',
  });
});

import { projectTaskSnapshot } from '../src/tasks/infrastructure/markdown/TaskSnapshotProjector';
import {
  projectCalendarOccurrences,
  taskSnapshotForCalendarOccurrence,
} from '../src/views/calendarOccurrences';

it('keeps the start-only role when a root is dropped from a native task payload', async () => {
  const root = task({ planning: { start: '2026-10-08' } });
  const h = harness([root]);
  await h.commands.rescheduleFromDrag(dragData(root), '2026-10-09');
  expect(h.lastCommand()).toEqual({
    type: 'patch',
    target: { type: 'task', ref: root.ref },
    patch: { start: { type: 'set', value: '2026-10-09' } },
  });
  await h.commands.setTimeFromDrag(dragData(root), '2026-10-09', '09:00');
  expect(h.lastCommand()).toEqual({
    type: 'patch',
    target: { type: 'task', ref: root.ref },
    patch: { start: { type: 'set', value: '2026-10-09' }, time: { type: 'set', value: '09:00' } },
  });
});

it('moves and resizes a canonical child interval, retaining unrelated dates and root all-day semantics', async () => {
  const statuses = canonicalStatusCatalog();
  const codec = new TaskMarkdownCodec(statuses);
  const text =
    '- [ ] Parent\n  - [ ] Span 🛫 2026-10-07 📅 2026-10-09 ⏳ 2026-10-05 ⏰ 09:00 ⏱️ 1h';
  const root = expectDefined(
    projectTaskSnapshot({
      codec,
      statusCatalog: statuses,
      filePath: 'tasks.md',
      lines: text.split('\n'),
      line: 0,
      exactBlock: text,
      ref: { filePath: 'tasks.md', line: 0, revision: 'old' },
      presentation: { linkCount: 0 },
      offsetAt: () => 0,
    }),
  );
  const node = expectDefined(root.subtasks[0]);
  const occurrence = expectDefined(
    projectCalendarOccurrences(
      {
        materialized: [{ root, node, target: { type: 'subtask', ref: node.ref } }],
        recurringSources: [],
      },
      { from: localDate('2026-10-08'), to: localDate('2026-10-08') },
      { removeScheduledDate: false },
    ).occurrences[0],
  );
  const display = taskSnapshotForCalendarOccurrence(occurrence);
  const h = harness();
  await h.commands.commitTimedMove(display, {
    destination: 'time-grid',
    date: localDate('2026-10-09'),
    dayDelta: 1,
    startMinutes: 600,
  });
  expect(h.lastCommand()).toMatchObject({
    type: 'patch',
    target: { type: 'subtask', ref: node.ref },
    patch: {
      start: { type: 'set', value: '2026-10-08' },
      due: { type: 'set', value: '2026-10-10' },
      time: { type: 'set', value: '10:00' },
    },
  });
  const moved = expectDefined(h.lastCommand());
  if (moved.type !== 'patch') throw new Error('expected child patch');
  expect(applyTaskCommand(codec, node.ref.originalBlock, moved)).toEqual({
    type: 'changed',
    content: '  - [ ] Span 🛫 2026-10-08 📅 2026-10-10 ⏳ 2026-10-05 ⏰ 10:00 ⏱️ 1h',
  });
  await h.commands.setDue(display, '2026-10-11');
  expect(h.lastCommand()).toEqual({
    type: 'patch',
    target: { type: 'subtask', ref: node.ref },
    patch: { due: { type: 'set', value: '2026-10-11' } },
  });
  await h.commands.commitTimedMove(display, {
    destination: 'all-day',
    date: localDate('2026-10-09'),
    dayDelta: 1,
    startMinutes: 0,
  });
  const allDay = expectDefined(h.lastCommand());
  if (allDay.type !== 'patch') throw new Error('expected child patch');
  expect(applyTaskCommand(codec, node.ref.originalBlock, allDay)).toEqual({
    type: 'changed',
    content: '  - [ ] Span 🛫 2026-10-08 📅 2026-10-10 ⏳ 2026-10-05',
  });
});
