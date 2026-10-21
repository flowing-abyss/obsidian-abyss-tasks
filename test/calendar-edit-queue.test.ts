import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { durationMinutes, localDate, localTime } from '../src/tasks';
import { CalendarEditQueue } from '../src/ui/calendarEditQueue';
import {
  calendarOccurrenceForRender,
  calendarTaskWithPlanning,
  projectCalendarOccurrences,
  taskSnapshotForCalendarOccurrence,
} from '../src/views/calendarOccurrences';
import { timedEditCommand } from '../src/views/timegrid/timedEditPlanning';
import {
  configuredTaskApplication,
  createAppWithFiles,
  expectDefined,
  seedTaskCache,
  useRealMoment,
} from './helpers';

useRealMoment();
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

it('proves a date command before a following edit of the same span', async () => {
  const app = await createAppWithFiles({
    'calendar.md': '- [ ] Span 🛫 2026-10-21 📅 2026-10-22 ⏰ 09:00 ⏱️ 1h',
  });
  seedTaskCache(app, 'calendar.md', [{ task: ' ', parent: -1, line: 0 }]);
  const application = configuredTaskApplication(app, structuredClone(DEFAULT_SETTINGS), {
    authority: true,
  });
  await application.index.initialize();
  cleanups.push(() => {
    application.index.destroy();
  });
  const task = expectDefined(application.index.list()[0]);
  const queue = new CalendarEditQueue(application.tasks);
  const first = queue.execute(task, (current) => ({
    type: 'shift-schedule',
    ref: current.ref,
    days: 1,
  }));
  const second = queue.execute(task, (current) => ({
    type: 'patch',
    target: { type: 'task', ref: current.ref },
    patch: { duration: { type: 'set', value: durationMinutes(90) } },
  }));
  await Promise.all([first, second]);
  expect(application.index.list()[0]?.planning).toEqual({
    start: '2026-10-22',
    due: '2026-10-23',
    time: '09:00',
    duration: 90,
  });
});

it('continues queued planning edits through the public API after the root moves to another line', async () => {
  const app = await createAppWithFiles({
    'calendar.md': '- [ ] Target 📅 2026-10-21 ⏰ 09:00 ⏱️ 1h\n  - [ ] Keep child',
  });
  seedTaskCache(app, 'calendar.md', [
    { task: ' ', parent: -1, line: 0 },
    { task: ' ', parent: 0, line: 1 },
  ]);
  const application = configuredTaskApplication(app, structuredClone(DEFAULT_SETTINGS), {
    authority: true,
  });
  await application.index.initialize();
  cleanups.push(() => {
    application.index.destroy();
  });
  const task = expectDefined(application.index.list()[0]);
  const execute = vi.spyOn(application.tasks, 'execute');
  const queue = new CalendarEditQueue(application.tasks);
  const file = expectDefined(app.vault.getFileByPath('calendar.md'));
  await app.vault.modify(file, `# Header\n${await app.vault.read(file)}`);
  const first = queue.execute(task, (current) => ({
    type: 'patch',
    target: { type: 'task', ref: current.ref },
    patch: { time: { type: 'set', value: localTime('09:15') } },
  }));
  const second = queue.execute(task, (current) => ({
    type: 'patch',
    target: { type: 'task', ref: current.ref },
    patch: { duration: { type: 'set', value: durationMinutes(90) } },
  }));
  const [firstReceipt, secondReceipt] = await Promise.all([first, second]);
  expect(firstReceipt?.proof).toBeDefined();
  expect(secondReceipt?.proof).toBeDefined();
  expect(execute).toHaveBeenCalledTimes(2);
  expect(execute.mock.calls[0]?.[0]).toMatchObject({ target: { ref: { line: 0 } } });
  expect(execute.mock.calls[1]?.[0]).toMatchObject({ target: { ref: { line: 1 } } });
  expect(application.index.list()[0]?.planning).toEqual({
    due: '2026-10-21',
    time: '09:15',
    duration: 90,
  });
  expect(await app.vault.read(file)).toContain('  - [ ] Keep child');
});

it('uses the canonical opposite edge when a fresh gesture starts from retained speculative planning', async () => {
  const app = await createAppWithFiles({
    'calendar.md': '- [ ] Target 📅 2026-10-21 ⏰ 09:00 ⏱️ 1h',
  });
  seedTaskCache(app, 'calendar.md', [{ task: ' ', parent: -1, line: 0 }]);
  const application = configuredTaskApplication(app, structuredClone(DEFAULT_SETTINGS), {
    authority: true,
  });
  await application.index.initialize();
  cleanups.push(() => {
    application.index.destroy();
  });
  const source = expectDefined(application.index.list()[0]);
  const display = calendarTaskWithPlanning(
    taskSnapshotForCalendarOccurrence(calendarOccurrenceForRender(source)),
    { ...source.planning, time: localTime('10:00') },
  );
  const queue = new CalendarEditQueue(application.tasks);
  const receipt = await queue.execute(display, (current) =>
    timedEditCommand(
      current,
      {
        type: 'resize',
        target: { edge: 'end', startMinutes: 600, endMinutes: 690, durationMinutes: 90 },
      },
      display,
    ),
  );
  expect(receipt?.proof).toBeDefined();
  expect(application.index.list()[0]?.planning).toEqual({
    due: '2026-10-21',
    time: '09:00',
    duration: 150,
  });
});

it('restores absent canonical duration before resizing retained forecast planning', async () => {
  const app = await createAppWithFiles({
    'calendar.md': '- [ ] Repeating 📅 2026-10-21 ⏰ 09:00 🔁 every day',
  });
  seedTaskCache(app, 'calendar.md', [{ task: ' ', parent: -1, line: 0 }]);
  const application = configuredTaskApplication(app, structuredClone(DEFAULT_SETTINGS), {
    authority: true,
  });
  await application.index.initialize();
  cleanups.push(() => {
    application.index.destroy();
  });
  const date = localDate('2026-10-22');
  const forecast = expectDefined(
    projectCalendarOccurrences(
      application.tasks.queries.forCalendarProjection([date]),
      { from: date, to: date },
      DEFAULT_SETTINGS.recurrence,
    ).occurrences.find((entry) => entry.kind === 'forecast'),
  );
  const display = taskSnapshotForCalendarOccurrence({
    ...forecast,
    planning: { ...forecast.planning, duration: durationMinutes(90) },
  });
  const queue = new CalendarEditQueue(application.tasks);
  const receipt = await queue.execute(display, (current) =>
    timedEditCommand(
      current,
      {
        type: 'resize',
        target: { edge: 'start', startMinutes: 555, endMinutes: 630, durationMinutes: 75 },
      },
      display,
    ),
  );
  expect(receipt?.proof).toBeDefined();
  expect(application.index.list()[0]?.planning).toEqual({
    due: '2026-10-21',
    time: '09:15',
    duration: 45,
  });
});
