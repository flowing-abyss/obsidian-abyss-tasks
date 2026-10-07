import { expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { CalendarCommands } from '../src/panels/calendar/calendarCommands';
import { localDate, type TaskApplicationApi } from '../src/tasks';
import { startTaskNodeDrag } from '../src/ui/taskNodeDrag';
import {
  calendarNativeDragPayload,
  calendarTaskFromNativeDrag,
} from '../src/views/calendarNativeDrag';
import {
  projectCalendarOccurrences,
  taskSnapshotForCalendarOccurrence,
} from '../src/views/calendarOccurrences';
import { expectDefined, flushMicrotasks, freshContainer, taskQueryApi } from './helpers';
import { hierarchyHarness } from './support/taskHierarchyHarness';

async function nativeFixture(child: boolean) {
  const header = '- [ ] Node 🛫 2026-10-10 📅 2026-10-08 ⏳ 2026-10-10';
  const source = child ? `- [ ] Parent\n  ${header}\n` : `${header}\n`;
  const h = await hierarchyHarness({ 'source.md': source, 'target.md': '- [ ] Other\n' });
  const from = localDate('2026-10-08');
  const to = localDate('2026-10-10');
  const projection = projectCalendarOccurrences(
    h.index.forCalendarProjection([from, to]),
    { from, to },
    { removeScheduledDate: false },
  );
  const displays = projection.occurrences.map(taskSnapshotForCalendarOccurrence);
  const state = new AppState();
  const queries = taskQueryApi({ list: () => [h.source] });
  const execute = vi.fn<TaskApplicationApi['execute']>((command) => h.service.execute(command));
  const commands = new CalendarCommands({
    tasks: { queries, execute },
    queries,
    nativeDrag: () => state.get('draggingTaskNode'),
  });
  return { ...h, state, displays, commands, execute, original: source };
}

it.each([false, true])(
  'native root/child point drops preserve roles across date and time lanes, child=%s',
  async (child) => {
    const h = await nativeFixture(child);
    const payload = expectDefined(calendarNativeDragPayload(expectDefined(h.displays[1])));
    if (payload.source !== 'center-card' || payload.calendar === undefined)
      throw new Error('calendar context missing');
    h.state.set('draggingTaskNode', payload);
    const cloned = h.state.get('draggingTaskNode');
    expect(cloned).not.toBe(payload);
    expect(calendarTaskFromNativeDrag(payload.calendar.nativePayload, cloned)).toBeDefined();
    await h.commands.setTimeFromDrag(payload.calendar.nativePayload, '2026-10-07', '09:00');
    expect(await h.read('source.md')).toBe(
      h.original.replaceAll('2026-10-10', '2026-10-07').replace('Node 🛫', 'Node ⏰ 09:00 🛫'),
    );
    expect(h.execute.mock.calls[0]?.[0]).toMatchObject({
      type: 'patch',
      target: payload.task.target,
      patch: {
        start: { type: 'set', value: '2026-10-07' },
        scheduled: { type: 'set', value: '2026-10-07' },
      },
    });
    h.index.destroy();
  },
);

it.each([false, true])(
  'rejects different/retired point and changed source without root fallback, child=%s',
  async (child) => {
    const h = await nativeFixture(child);
    const first = expectDefined(calendarNativeDragPayload(expectDefined(h.displays[0])));
    const second = expectDefined(calendarNativeDragPayload(expectDefined(h.displays[1])));
    if (
      first.source !== 'center-card' ||
      second.source !== 'center-card' ||
      first.calendar === undefined ||
      second.calendar === undefined
    )
      throw new Error('missing context');
    h.state.set('draggingTaskNode', first);
    await h.commands.rescheduleFromDrag(second.calendar.nativePayload, '2026-10-07');
    h.state.set('draggingTaskNode', null);
    await h.commands.setTimeFromDrag(first.calendar.nativePayload, '2026-10-07', '09:00');
    expect(h.execute).not.toHaveBeenCalled();
    expect(await h.read('source.md')).toBe(h.original);
    h.state.set('draggingTaskNode', second);
    await h.app.vault.modify(h.file('source.md'), h.original.replace('Node 🛫', 'Changed node 🛫'));
    const competing = await h.read('source.md');
    await h.commands.rescheduleFromDrag(second.calendar.nativePayload, '2026-10-07');
    expect(await h.read('source.md')).toBe(competing);
    h.index.destroy();
  },
);

it('uses existing drag owner cleanup and refuses a tampered occupied context', async () => {
  const h = await nativeFixture(true);
  const payload = expectDefined(calendarNativeDragPayload(expectDefined(h.displays[1])));
  if (payload.source !== 'center-card' || payload.calendar === undefined)
    throw new Error('missing context');
  const container = freshContainer();
  const source = container.createDiv();
  const onEnd = vi.fn();
  const finish = startTaskNodeDrag(h.state, container, source, { payload, onEnd });
  const current = expectDefined(h.state.get('draggingTaskNode'));
  expect(
    calendarTaskFromNativeDrag(payload.calendar.nativePayload, {
      ...current,
      source: 'center-card',
      calendar: {
        ...payload.calendar,
        occupied: { kind: 'point', date: localDate('2026-10-10'), roles: ['due'] },
      },
    }),
  ).toBeUndefined();
  source.remove();
  await flushMicrotasks();
  expect(h.state.get('draggingTaskNode')).toBeNull();
  expect(
    calendarTaskFromNativeDrag(payload.calendar.nativePayload, h.state.get('draggingTaskNode')),
  ).toBeUndefined();
  expect(onEnd).toHaveBeenCalledOnce();
  finish();
  h.index.destroy();
});

it.each([false, true])(
  'native date drop retains exact point role context, child=%s',
  async (child) => {
    const h = await nativeFixture(child);
    const payload = expectDefined(calendarNativeDragPayload(expectDefined(h.displays[1])));
    if (payload.source !== 'center-card' || payload.calendar === undefined)
      throw new Error('missing context');
    h.state.set('draggingTaskNode', payload);
    await h.commands.rescheduleFromDrag(payload.calendar.nativePayload, '2026-10-07');
    expect(await h.read('source.md')).toBe(h.original.replaceAll('2026-10-10', '2026-10-07'));
    h.index.destroy();
  },
);

it('cannot publish a forecast as mutable native drag authority', async () => {
  const h = await hierarchyHarness({
    'source.md': '- [ ] Repeat 📅 2026-10-08 🔁 every day\n',
    'target.md': '- [ ] Other\n',
  });
  const date = localDate('2026-10-09');
  const projection = projectCalendarOccurrences(
    h.index.forCalendarProjection([date]),
    { from: date, to: date },
    { removeScheduledDate: false },
  );
  const occurrence = expectDefined(projection.occurrences[0]);
  expect(occurrence.kind).toBe('forecast');
  expect(calendarNativeDragPayload(taskSnapshotForCalendarOccurrence(occurrence))).toBeUndefined();
  h.index.destroy();
});

it.each(['date', 'time'] as const)(
  'native child interval %s drop keeps exact correlated target',
  async (destination) => {
    const original = '- [ ] Parent\n  - [ ] Interval 🛫 2026-10-08 📅 2026-10-10 ⏳ 2026-10-09\n';
    const h = await hierarchyHarness({ 'source.md': original, 'target.md': '- [ ] Other\n' });
    const from = localDate('2026-10-08');
    const to = localDate('2026-10-10');
    const occurrence = expectDefined(
      projectCalendarOccurrences(
        h.index.forCalendarProjection([from, to]),
        { from, to },
        { removeScheduledDate: false },
      ).occurrences[0],
    );
    const payload = expectDefined(
      calendarNativeDragPayload(taskSnapshotForCalendarOccurrence(occurrence)),
    );
    if (payload.source !== 'center-card' || payload.calendar === undefined)
      throw new Error('missing context');
    const state = new AppState();
    state.set('draggingTaskNode', payload);
    const queries = taskQueryApi({ list: () => [h.source] });
    const commands = new CalendarCommands({
      tasks: { queries, execute: (command) => h.service.execute(command) },
      queries,
      nativeDrag: () => state.get('draggingTaskNode'),
    });
    if (destination === 'date')
      await commands.rescheduleFromDrag(payload.calendar.nativePayload, '2026-10-11');
    else await commands.setTimeFromDrag(payload.calendar.nativePayload, '2026-10-11', '09:00');
    expect(await h.read('source.md')).toBe(
      `- [ ] Parent\n  - [ ] Interval${destination === 'time' ? ' ⏰ 09:00' : ''} 🛫 2026-10-09 📅 2026-10-11 ⏳ 2026-10-09\n`,
    );
    h.index.destroy();
  },
);

it.each(
  [false, true].flatMap((child) => ['native', 'pointer'].map((gesture) => ({ child, gesture }))),
)(
  'timed point conversion clears time and duration for $gesture child=$child',
  async ({ child, gesture }) => {
    const header = '- [ ] Timed 🛫 2026-10-08 ⏰ 09:00 ⏱️ 1h';
    const original = child ? `- [ ] Parent\n  ${header}\n` : `${header}\n`;
    const h = await hierarchyHarness({ 'source.md': original, 'target.md': '- [ ] Other\n' });
    const from = localDate('2026-10-08');
    const occurrence = expectDefined(
      projectCalendarOccurrences(
        h.index.forCalendarProjection([from]),
        { from, to: from },
        { removeScheduledDate: false },
      ).occurrences[0],
    );
    const display = taskSnapshotForCalendarOccurrence(occurrence);
    const payload = expectDefined(calendarNativeDragPayload(display));
    if (payload.source !== 'center-card' || payload.calendar === undefined)
      throw new Error('missing context');
    const state = new AppState();
    state.set('draggingTaskNode', payload);
    const queries = taskQueryApi({ list: () => [h.source] });
    const commands = new CalendarCommands({
      tasks: { queries, execute: (command) => h.service.execute(command) },
      queries,
      nativeDrag: () => state.get('draggingTaskNode'),
    });
    if (gesture === 'native')
      await commands.rescheduleFromDrag(payload.calendar.nativePayload, '2026-10-09');
    else
      await commands.commitTimedMove(display, {
        date: localDate('2026-10-09'),
        dayDelta: 1,
        destination: 'all-day',
        startMinutes: 540,
      });
    expect(await h.read('source.md')).toBe(
      original.replace('2026-10-08 ⏰ 09:00 ⏱️ 1h', '2026-10-09'),
    );
    h.index.destroy();
  },
);

it.each([false, true])(
  'retains authored duration on an untimed point date move, child=%s',
  async (child) => {
    const header = '- [ ] Node 🛫 2026-10-08 ⏱️ 1h';
    const original = child ? `- [ ] Parent\n  ${header}\n` : `${header}\n`;
    const h = await hierarchyHarness({ 'source.md': original, 'target.md': '- [ ] Other\n' });
    const date = localDate('2026-10-08');
    const occurrence = expectDefined(
      projectCalendarOccurrences(
        h.index.forCalendarProjection([date]),
        { from: date, to: date },
        { removeScheduledDate: false },
      ).occurrences[0],
    );
    const payload = expectDefined(
      calendarNativeDragPayload(taskSnapshotForCalendarOccurrence(occurrence)),
    );
    if (payload.source !== 'center-card' || payload.calendar === undefined)
      throw new Error('missing context');
    const state = new AppState();
    state.set('draggingTaskNode', payload);
    const queries = taskQueryApi({ list: () => [h.source] });
    const commands = new CalendarCommands({
      tasks: { queries, execute: (command) => h.service.execute(command) },
      queries,
      nativeDrag: () => state.get('draggingTaskNode'),
    });
    await commands.rescheduleFromDrag(payload.calendar.nativePayload, '2026-10-09');
    expect(await h.read('source.md')).toBe(original.replace('2026-10-08', '2026-10-09'));
    h.index.destroy();
  },
);

it('rejects native context after source exclusion without writing bytes', async () => {
  const h = await nativeFixture(true);
  const payload = expectDefined(calendarNativeDragPayload(expectDefined(h.displays[1])));
  if (payload.source !== 'center-card' || payload.calendar === undefined)
    throw new Error('missing context');
  h.state.set('draggingTaskNode', payload);
  await h.index.refreshSourceExclusion((source) => source.filePath === 'source.md');
  await h.commands.rescheduleFromDrag(payload.calendar.nativePayload, '2026-10-07');
  expect(await h.read('source.md')).toBe(h.original);
  h.index.destroy();
});
