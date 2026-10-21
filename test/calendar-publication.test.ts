import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { CalendarMode, type CalendarModeHost } from '../src/panels/calendar/CalendarMode';
import type { CalViewType } from '../src/panels/calendar/calendarViewType';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { durationMinutes, localDate, localTime, type TaskApplicationApi } from '../src/tasks';
import { noInteractionOwnership } from '../src/ui/interactionOwnership';
import { closeStatusPopovers } from '../src/ui/statusMenu';
import { attachCalendarNativeDrag } from '../src/views/calendarNativeDrag';
import { calendarPatchCommand } from '../src/views/calendarOccurrences';
import {
  configuredTaskApplication,
  createAppWithFiles,
  deferred,
  expectDefined,
  flushMicrotasks,
  freshContainer,
  metadataChangedEmitter,
  seedTaskCache,
  useRealMoment,
} from './helpers';
import { calendarAgendaHarness } from './support/calendarAgendaHarness';

useRealMoment();

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.useRealTimers();
  closeStatusPopovers(document);
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function setup(
  view: CalViewType = 'today',
  child = false,
  timing = '⏰ 09:00 ⏱️ 1h',
  due = '2026-10-19',
) {
  vi.spyOn(Date, 'now').mockReturnValue(new Date(2026, 9, 19, 12).getTime());
  const line = `- [ ] Target 📅 ${due} ${timing}`.trim();
  const app = await createAppWithFiles({
    'calendar.md': child ? `- [ ] Parent\n  ${line}\n  - [ ] Sibling` : line,
    'other.md': '- [ ] Other',
    'created.md': '',
  });
  seedTaskCache(
    app,
    'calendar.md',
    child
      ? [
          { task: ' ', parent: -1, line: 0 },
          { task: ' ', parent: 0, line: 1 },
          { task: ' ', parent: 0, line: 2 },
        ]
      : [{ task: ' ', parent: -1, line: 0 }],
  );
  seedTaskCache(app, 'other.md', [{ task: ' ', parent: -1, line: 0 }]);
  const application = configuredTaskApplication(app, structuredClone(DEFAULT_SETTINGS), {
    authority: true,
  });
  await application.index.initialize();
  const execute = vi.fn<TaskApplicationApi['execute']>(
    application.tasks.execute.bind(application.tasks),
  );
  const state = new AppState();
  state.set('mode', 'calendar');
  const cards = calendarAgendaHarness(state);
  const host: CalendarModeHost = {
    mountAgendaEntry: cards.mountAgendaEntry,
    rerender: vi.fn(),
    openTask: vi.fn(),
    openForecastTask: vi.fn(),
    toggleTask: async (task) => {
      await execute({ type: 'toggle-completion', target: { type: 'task', ref: task.ref } });
    },
    setTaskStatus: vi.fn(async () => {}),
    setPriority: vi.fn(async () => {}),
    dependenciesFor: () => undefined,
    tagGroups: () => [],
    openForecastRecurrenceEditor: vi.fn(),
    dismissRecurrenceEditor: vi.fn(),
    openCapture: vi.fn(),
    unmountActiveCapture: vi.fn(),
    remountActiveCapture: vi.fn(),
    syncTaskStackSelection: vi.fn(),
    onRenderComplete: vi.fn(),
  };
  const mode = new CalendarMode({
    state,
    app,
    settings: structuredClone(DEFAULT_SETTINGS),
    queries: application.index,
    tasks: { queries: application.index, execute },
    statusRegistry: application.statusRegistry,
    interactionOwnership: noInteractionOwnership,
    navigation: { openCalendarView: vi.fn() },
    host,
  });
  const root = freshContainer();
  document.body.appendChild(root);
  mode.setView(view);
  mode.render(root);
  cleanups.push(() => {
    mode.destroy();
    application.index.destroy();
    root.remove();
  });
  const publish = async () => {
    const other = expectDefined(application.index.list({ filePath: 'other.md' })[0]);
    await application.tasks.execute({
      type: 'patch',
      target: { type: 'task', ref: other.ref },
      patch: { priority: { type: 'set', value: 'A' } },
    });
  };
  const current = () => {
    const task = expectDefined(application.index.list({ filePath: 'calendar.md' })[0]);
    return child ? expectDefined(task.subtasks[0]) : task;
  };
  return { app, application, execute, host, mode, root, publish, current };
}

function timedResize(root: HTMLElement, date = '2026-10-19') {
  const day = expectDefined(
    root.querySelector<HTMLElement>(`.abyss-tg-day-column[data-tg-date="${date}"]`),
  );
  const hour = expectDefined(day.querySelector<HTMLElement>('.abyss-tg-hour-column'));
  const block = expectDefined(hour.querySelector<HTMLElement>('.abyss-tg-block'));
  const handle = expectDefined(
    block.querySelector<HTMLElement>('.abyss-tg-resize-handle--duration'),
  );
  day.getBoundingClientRect = hour.getBoundingClientRect = () => new DOMRect(0, 100, 100, 1152);
  block.getBoundingClientRect = () => new DOMRect(0, 532, 100, 48);
  const release = vi.fn();
  handle.setPointerCapture = vi.fn();
  handle.releasePointerCapture = release;
  handle.dispatchEvent(
    new PointerEvent('pointerdown', { bubbles: true, clientX: 25, clientY: 580, pointerId: 21 }),
  );
  window.dispatchEvent(
    new PointerEvent('pointermove', { clientX: 25, clientY: 604, pointerId: 21 }),
  );
  const finish = () =>
    window.dispatchEvent(
      new PointerEvent('pointerup', { clientX: 25, clientY: 604, pointerId: 21 }),
    );
  return { block, handle, release, finish };
}

function startNativeDrag(source: HTMLElement): boolean {
  const event = new MouseEvent('dragstart', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: null });
  return source.dispatchEvent(event);
}

function timedMove(root: HTMLElement, date?: string, boundary?: 'start' | 'create-span' | 'due') {
  let gridTop = 100;
  for (const day of root.querySelectorAll<HTMLElement>('.abyss-tg-day-column')) {
    const left = (Number(day.dataset['tgDate']?.slice(-2)) - 19) * 100;
    const hour = expectDefined(day.querySelector<HTMLElement>('.abyss-tg-hour-column'));
    day.getBoundingClientRect = hour.getBoundingClientRect = () =>
      new DOMRect(left, gridTop, 100, 1152);
  }
  const block = expectDefined(
    root.querySelector<HTMLElement>(
      date === undefined
        ? '.abyss-tg-block'
        : `.abyss-tg-block[data-abyss-task-file="calendar.md"][data-tg-segment-date="${date}"]`,
    ),
  );
  const hour = expectDefined(block.closest<HTMLElement>('.abyss-tg-hour-column'));
  const left = date === undefined ? 0 : (Number(date.slice(-2)) - 19) * 100;
  block.getBoundingClientRect = () => new DOMRect(left, gridTop + 432, 100, 48);
  const source =
    boundary !== undefined
      ? expectDefined(block.querySelector<HTMLElement>(`[data-boundary="${boundary}"]`))
      : block;
  source.setPointerCapture = vi.fn();
  source.releasePointerCapture = vi.fn();
  const pointer = (type: string, x = 25, y = 552) =>
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 51,
      pointerType: 'mouse',
      clientX: x,
      clientY: y,
      button: 0,
    });
  source.dispatchEvent(pointer('pointerdown', left + 25));
  return {
    block,
    hour,
    pointer,
    move: (x = 25, y = 648) => window.dispatchEvent(pointer('pointermove', x, y)),
    finish: (x = 25, y = 648) => window.dispatchEvent(pointer('pointerup', x, y)),
    scroll: (pixels: number) => {
      gridTop -= pixels;
      expectDefined(root.querySelector('.abyss-tg-grid-row')).dispatchEvent(
        new Event('scroll', { bubbles: false }),
      );
    },
  };
}

const dates = (root: HTMLElement) =>
  [
    ...root.querySelectorAll<HTMLElement>('.abyss-tg-block[data-abyss-task-file="calendar.md"]'),
  ].map((block) => block.dataset['tgSegmentDate']);

describe('timed date pointer persistence', () => {
  it.each(['start', 'create-span'] as const)(
    'preserves authored overnight duration on %s date resize',
    async (boundary) => {
      const h = await setup('week', false, '⏰ 23:45 ⏱️ 1h', '2026-10-22');
      timedMove(h.root, '2026-10-22', boundary).finish(boundary === 'start' ? 250 : 450, 552);
      await flushMicrotasks();
      expect(h.current().planning.duration).toBe(60);
      expect(h.current().planning).toMatchObject(
        boundary === 'start'
          ? { start: '2026-10-21', due: '2026-10-22', time: '23:45' }
          : { start: '2026-10-22', due: '2026-10-23', time: '23:45' },
      );
    },
  );

  it.each([false, true])(
    'keeps both fast left moves while the first save is pending (child=%s)',
    async (child) => {
      const h = await setup('week', child, undefined, '2026-10-22');
      const write = deferred<void>();
      h.execute.mockImplementationOnce(async (...args) => {
        await write.promise;
        return h.application.tasks.execute(...args);
      });
      timedMove(h.root, '2026-10-22').finish(250, 552);
      expect(h.root.querySelector('[data-tg-segment-date="2026-10-21"]')).not.toBeNull();
      timedMove(h.root, '2026-10-21').finish(150, 552);
      write.resolve();
      await flushMicrotasks();
      expect(h.current().planning).toEqual({ due: '2026-10-20', time: '09:00', duration: 60 });
      expect(h.execute).toHaveBeenCalledTimes(2);
    },
  );

  it.each([false, true])(
    'accepts a second resize from pending geometry (child=%s)',
    async (child) => {
      const h = await setup('today', child);
      const write = deferred<void>();
      h.execute.mockImplementationOnce(async (command, options) => {
        await write.promise;
        return h.application.tasks.execute(command, options);
      });
      timedResize(h.root).finish();
      const pending = expectDefined(h.root.querySelector<HTMLElement>('.abyss-tg-block'));
      expect(pending.style.height).toBe('72px');
      expect(h.root.querySelector<HTMLElement>('.abyss-cal-body')?.inert).not.toBe(true);
      const hour = expectDefined(pending.closest<HTMLElement>('.abyss-tg-hour-column'));
      const day = expectDefined(pending.closest<HTMLElement>('.abyss-tg-day-column'));
      day.getBoundingClientRect = hour.getBoundingClientRect = () => new DOMRect(0, 100, 100, 1152);
      pending.getBoundingClientRect = () => new DOMRect(0, 532, 100, 72);
      const handle = expectDefined(
        pending.querySelector<HTMLElement>('[data-resize-edge="duration"]'),
      );
      handle.setPointerCapture = vi.fn();
      handle.releasePointerCapture = vi.fn();
      handle.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          clientX: 25,
          clientY: 600,
          pointerId: 22,
        }),
      );
      window.dispatchEvent(
        new PointerEvent('pointerup', { clientX: 25, clientY: 624, pointerId: 22 }),
      );
      expect(h.root.querySelector<HTMLElement>('.abyss-tg-block')?.style.height).toBe('96px');
      expect(h.current().planning.duration).toBe(60);
      write.resolve();
      await flushMicrotasks();
      expect(h.current().planning.duration).toBe(120);
      const file = expectDefined(h.app.vault.getFileByPath('calendar.md'));
      expect(await h.app.vault.read(file)).toContain('⏱️ 2h');
      expect(h.execute).toHaveBeenCalledTimes(2);
      h.mode.render(h.root);
      expect(h.root.querySelector<HTMLElement>('.abyss-tg-block')?.style.height).toBe('96px');
      expect(h.host.openCapture).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'keeps consecutive center moves left after remount (child=%s)',
    async (child) => {
      const h = await setup('week', child, undefined, '2026-10-22');
      const file = expectDefined(h.app.vault.getFileByPath('calendar.md'));
      for (const [from, to] of [
        ['2026-10-22', '2026-10-21'],
        ['2026-10-21', '2026-10-20'],
      ] as const) {
        const gesture = timedMove(h.root, from);
        const x = (Number(to.slice(-2)) - 19) * 100 + 50;
        gesture.move(x, 552);
        gesture.finish(x, 552);
        await flushMicrotasks();
        expect(h.current().planning).toEqual({ due: to, time: '09:00', duration: 60 });
        expect(await h.app.vault.read(file)).toContain(`📅 ${to}`);
        h.mode.render(h.root);
        expect(dates(h.root)).toEqual([to]);
      }
      expect(h.host.openCapture).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'persists left extension, further extension and shrink (child=%s)',
    async (child) => {
      const h = await setup('week', child, undefined, '2026-10-22');
      const file = expectDefined(h.app.vault.getFileByPath('calendar.md'));
      const other = expectDefined(h.application.index.list({ filePath: 'other.md' })[0]);
      await h.application.tasks.execute({
        type: 'patch',
        target: { type: 'task', ref: other.ref },
        patch: {
          due: { type: 'set', value: localDate('2026-10-21') },
          time: { type: 'set', value: localTime('09:00') },
          duration: { type: 'set', value: durationMinutes(60) },
        },
      });
      await flushMicrotasks();
      const write = deferred<void>();
      h.execute.mockImplementationOnce(async (command) => {
        await write.promise;
        return h.application.tasks.execute(command);
      });
      const first = timedMove(h.root, '2026-10-22', 'start');
      first.move(250, 552);
      const preview = expectDefined(
        h.root.querySelector<HTMLElement>('.abyss-tg-boundary-preview'),
      );
      expect(preview.style.width).toBe('50%');
      first.finish(250, 552);
      await h.publish();
      expect(preview.isConnected).toBe(false);
      expect(dates(h.root)).toEqual(['2026-10-21', '2026-10-22']);
      expect(h.current().planning.start).toBeUndefined();
      write.resolve();
      await flushMicrotasks();
      for (const [start, occupied] of [
        ['2026-10-21', ['2026-10-21', '2026-10-22']],
        ['2026-10-20', ['2026-10-20', '2026-10-21', '2026-10-22']],
        ['2026-10-22', ['2026-10-22']],
      ] as const) {
        if (start !== '2026-10-21') {
          const gesture = timedMove(h.root, String(h.current().planning.start), 'start');
          const x = (Number(start.slice(-2)) - 19) * 100 + 50;
          gesture.move(x, 552);
          gesture.finish(x, 552);
          await flushMicrotasks();
        }
        expect(h.current().planning).toEqual({
          start,
          due: '2026-10-22',
          time: '09:00',
          duration: 60,
        });
        const persisted = await h.app.vault.read(file);
        expect(persisted).toContain(`🛫 ${start}`);
        expect(persisted).toContain('📅 2026-10-22');
        if (child) expect(persisted).toContain('- [ ] Parent\n  - [ ] Target');
        h.mode.render(h.root);
        expect(dates(h.root)).toEqual(occupied);
        if (start === '2026-10-21') {
          expect(
            h.root.querySelector<HTMLElement>(
              '.abyss-tg-block[data-abyss-task-file="calendar.md"][data-tg-segment-date="2026-10-21"]',
            )?.style.width,
          ).toBe(preview.style.width);
        }
        expect(h.root.querySelector('.abyss-tg-boundary-preview')).toBeNull();
      }
      expect(h.host.openCapture).not.toHaveBeenCalled();
    },
  );

  it('does not add a start boundary to a scheduled block with a separate deadline', async () => {
    const h = await setup('week', false, '⏰ 09:00 ⏱️ 1h ⏳ 2026-10-21', '2026-10-22');
    expect(dates(h.root)).toEqual(['2026-10-21']);
    expect(h.root.querySelector('.abyss-tg-block [data-boundary="start"]')).toBeNull();
  });

  it('keeps forecast date boundaries unavailable', async () => {
    const h = await setup('week', false, '⏰ 09:00 ⏱️ 1h 🔁 every day');
    const future = expectDefined(
      h.root.querySelector('.abyss-tg-block[data-tg-segment-date="2026-10-20"]'),
    );
    expect(future.querySelector('[data-boundary]')).toBeNull();
  });
});

describe('timed keyboard publication', () => {
  it('keeps a submitted pointer on its week when a keyboard receipt arrives later', async () => {
    const h = await setup('week', false, '⏰ 09:00 ⏱️ 1h', '2026-10-25');
    vi.mocked(h.host.rerender).mockImplementation(() => {
      h.mode.render(h.root);
    });
    const gate = deferred<void>();
    h.execute.mockImplementationOnce(async (...args) => {
      await gate.promise;
      return h.application.tasks.execute(...args);
    });
    const block = expectDefined(h.root.querySelector<HTMLElement>('.abyss-tg-block'));
    block.focus();
    block.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    timedMove(h.root, '2026-10-25').finish(625, 648);
    gate.resolve();
    await flushMicrotasks();
    expect(h.execute).toHaveBeenCalledTimes(2);
    expect(h.current().planning).toMatchObject({ due: '2026-10-25', time: '11:00' });
    expect(h.root.querySelector('.abyss-tg-day-column[data-tg-date="2026-10-25"]')).not.toBeNull();
    expect(dates(h.root)).toEqual(['2026-10-25']);
  });

  it.each([false, true].flatMap((child) => ['due', 'start'].map((anchor) => ({ child, anchor }))))(
    'moves the whole newly extended span from a retained $anchor point (child=$child)',
    async ({ child, anchor }) => {
      const h = await setup('week', child, '⏰ 09:00 ⏱️ 1h', '2026-10-22');
      if (anchor === 'start') {
        const display = expectDefined(h.root.querySelector<HTMLElement>('.abyss-tg-block'));
        const root = expectDefined(h.application.index.list({ filePath: 'calendar.md' })[0]);
        const patch = {
          start: { type: 'set', value: localDate('2026-10-22') },
          due: { type: 'clear' },
        } as const;
        await h.application.tasks.execute(
          child
            ? {
                type: 'patch',
                target: { type: 'subtask', ref: expectDefined(root.subtasks[0]).ref },
                patch,
              }
            : { type: 'patch', target: { type: 'task', ref: root.ref }, patch },
        );
        expect(display.isConnected).toBe(false);
      }
      const gate = deferred<void>();
      h.execute.mockImplementationOnce(async (...args) => {
        await gate.promise;
        return h.application.tasks.execute(...args);
      });
      const block = expectDefined(h.root.querySelector<HTMLElement>('.abyss-tg-block'));
      block.focus();
      block.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }),
      );
      timedMove(h.root, '2026-10-22').finish(225, 552);
      gate.resolve();
      await flushMicrotasks();
      expect(h.execute).toHaveBeenCalledTimes(2);
      expect(h.current().planning).toEqual({
        start: '2026-10-21',
        due: '2026-10-22',
        time: '09:00',
        duration: 60,
      });
      expect(dates(h.root)).toEqual(['2026-10-21', '2026-10-22']);
    },
  );

  it.each([false, true])(
    'continues queued keyboard moves when timing clips at midnight (child=%s)',
    async (child) => {
      const h = await setup('today', child, '⏰ 23:00 ⏱️ 1h');
      const gate = deferred<void>();
      h.execute.mockImplementationOnce(async (...args) => {
        await gate.promise;
        return h.application.tasks.execute(...args);
      });
      const block = expectDefined(h.root.querySelector<HTMLElement>('.abyss-tg-block'));
      block.focus();
      for (let i = 0; i < 2; i++)
        block.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      gate.resolve();
      await flushMicrotasks();
      expect(h.current().planning).toMatchObject({ time: '23:30', duration: 30 });
      expect(h.execute).toHaveBeenCalledTimes(2);
    },
  );

  it('applies an end resize started during a keyboard write to that owned successor', async () => {
    const h = await setup('week');
    const gate = deferred<void>();
    h.execute.mockImplementationOnce(async (...args) => {
      await gate.promise;
      return h.application.tasks.execute(...args);
    });
    const origin = expectDefined(h.root.querySelector<HTMLElement>('.abyss-tg-block'));
    origin.focus();
    origin.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    const gesture = timedResize(h.root);
    gate.resolve();
    await h.execute.mock.results[0]?.value;
    await flushMicrotasks();
    expect(h.current().planning.time).toBe('09:15');
    gesture.finish();
    await flushMicrotasks();
    expect(h.current().planning).toMatchObject({ time: '09:15', duration: 75 });
    expect(h.root.querySelector('.abyss-tg-drag-preview')).toBeNull();
  });

  it.each(['drop', 'cancel'] as const)(
    'defers Day following until a held pointer %s',
    async (ending) => {
      const h = await setup();
      vi.mocked(h.host.rerender).mockImplementation(() => {
        h.mode.render(h.root);
      });
      const gate = deferred<void>();
      h.execute.mockImplementationOnce(async (...args) => {
        await gate.promise;
        return h.application.tasks.execute(...args);
      });
      const origin = expectDefined(h.root.querySelector<HTMLElement>('.abyss-tg-block'));
      origin.focus();
      origin.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      const gesture = timedMove(h.root);
      gesture.move();
      gate.resolve();
      await h.execute.mock.results[0]?.value;
      await flushMicrotasks();
      expect(h.current().planning.due).toBe('2026-10-20');
      expect(gesture.block.isConnected).toBe(true);
      expect(h.root.querySelector('.abyss-tg-drag-preview')).not.toBeNull();
      if (ending === 'drop') gesture.finish();
      else window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await flushMicrotasks();
      expect(h.current().planning).toMatchObject(
        ending === 'drop'
          ? { due: '2026-10-19', time: '11:00' }
          : { due: '2026-10-20', time: '09:00' },
      );
      expect(h.mode.captureDate()).toBe(ending === 'drop' ? '2026-10-19' : '2026-10-20');
      expect(h.root.querySelector('.abyss-tg-drag-preview')).toBeNull();
    },
  );

  it.each([false, true])(
    'hands a future series resize the pending keyboard receipt (child=%s)',
    async (child) => {
      const h = await setup('week', child, '⏰ 09:00 ⏱️ 1h 🔁 every day');
      const gate = deferred<void>();
      h.execute.mockImplementationOnce(async (...args) => {
        await gate.promise;
        return h.application.tasks.execute(...args);
      });
      const origin = expectDefined(
        h.root.querySelector<HTMLElement>('.abyss-tg-block[data-occurrence-state="materialized"]'),
      );
      origin.focus();
      for (let i = 0; i < 3; i += 1)
        origin.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      const gesture = timedResize(h.root, '2026-10-20');
      gesture.finish();
      gate.resolve();
      await flushMicrotasks();
      expect(h.current().planning).toMatchObject({
        due: '2026-10-19',
        time: '09:15',
        duration: 75,
      });
      expect(h.current().recurrence).toBeDefined();
      expect(h.execute).toHaveBeenCalledTimes(2);
      expect(h.root.querySelector('.abyss-tg-drag-preview')).toBeNull();
    },
  );

  it('retains a Sunday drag when the keyboard receipt crosses the week boundary', async () => {
    const h = await setup('week');
    const original = expectDefined(h.application.index.list({ filePath: 'calendar.md' })[0]);
    await h.application.tasks.execute({
      type: 'patch',
      target: { type: 'task', ref: original.ref },
      patch: { due: { type: 'set', value: localDate('2026-10-25') } },
    });
    vi.mocked(h.host.rerender).mockImplementation(() => {
      h.mode.render(h.root);
    });
    const gate = deferred<void>();
    h.execute.mockImplementationOnce(async (...args) => {
      await gate.promise;
      return h.application.tasks.execute(...args);
    });
    const origin = expectDefined(h.root.querySelector<HTMLElement>('.abyss-tg-block'));
    origin.focus();
    origin.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    const gesture = timedMove(h.root);
    gesture.move(625, 648);
    gate.resolve();
    await flushMicrotasks();
    expect(gesture.block.isConnected).toBe(true);
    gesture.finish(625, 648);
    await flushMicrotasks();
    expect(h.current().planning).toMatchObject({ due: '2026-10-25', time: '11:00' });
    expect(h.root.querySelector('.abyss-tg-day-column[data-tg-date="2026-10-25"]')).not.toBeNull();
  });

  it('retains the next Tab target when its command is queued behind the previous task', async () => {
    const h = await setup('week');
    const other = expectDefined(h.application.index.list({ filePath: 'other.md' })[0]);
    await h.application.tasks.execute({
      type: 'patch',
      target: { type: 'task', ref: other.ref },
      patch: {
        due: { type: 'set', value: localDate('2026-10-19') },
        time: { type: 'set', value: localTime('09:30') },
      },
    });
    h.root.addEventListener('focusin', (event) => {
      const block = (event.target as HTMLElement).closest<HTMLElement>('.abyss-tg-block');
      if (block !== null) h.mode.retainTimedBlockFocus(block);
    });
    const first = deferred<void>();
    const second = deferred<void>();
    h.execute
      .mockImplementationOnce(async (...args) => {
        await first.promise;
        return h.application.tasks.execute(...args);
      })
      .mockImplementationOnce(async (...args) => {
        await second.promise;
        return h.application.tasks.execute(...args);
      });
    const origin = expectDefined(
      h.root.querySelector<HTMLElement>('.abyss-tg-block[data-abyss-task-file="calendar.md"]'),
    );
    origin.focus();
    const press = (key: string) =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
      );
    press('ArrowDown');
    press('Tab');
    const next = document.activeElement;
    expect((next as HTMLElement).dataset['abyssTaskFile']).toBe('other.md');
    press('ArrowDown');
    first.resolve();
    await h.execute.mock.results[0]?.value;
    await flushMicrotasks();
    expect(document.activeElement).toBe(next);
    second.resolve();
    await flushMicrotasks();
    expect(h.application.index.list({ filePath: 'other.md' })[0]?.planning.time).toBe('09:45');
    expect((document.activeElement as HTMLElement).dataset['abyssTaskFile']).toBe('other.md');
  });

  it('carries the scroll offset when a keyboard date shift follows into another week', async () => {
    const h = await setup('week');
    const original = expectDefined(h.application.index.list({ filePath: 'calendar.md' })[0]);
    await h.application.tasks.execute({
      type: 'patch',
      target: { type: 'task', ref: original.ref },
      patch: { due: { type: 'set', value: localDate('2026-10-25') } },
    });
    vi.mocked(h.host.rerender).mockImplementation(() => {
      h.mode.render(h.root);
    });
    vi.useFakeTimers();
    vi.runOnlyPendingTimers();
    const grid = expectDefined(h.root.querySelector<HTMLElement>('.abyss-tg-grid-row'));
    grid.scrollTop = 300;
    expectDefined(h.root.querySelector<HTMLElement>('.abyss-tg-block')).focus();
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
    );
    await h.execute.mock.results[0]?.value;
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    vi.runOnlyPendingTimers();
    expect(h.current().planning.due).toBe('2026-10-26');
    expect(h.root.querySelector<HTMLElement>('.abyss-tg-grid-row')?.scrollTop).toBe(300);
    expect((document.activeElement as HTMLElement).dataset['tgSegmentDate']).toBe('2026-10-26');
  });

  it('retains the native keyboard target until receipt and focuses its replacement in the publication turn', async () => {
    const h = await setup('week');
    vi.useFakeTimers();
    vi.runOnlyPendingTimers();
    const accepted = deferred<void>();
    const receipt = deferred<void>();
    h.execute.mockImplementationOnce(async (...args) => {
      const result = await h.application.tasks.execute(...args);
      accepted.resolve();
      await receipt.promise;
      return result;
    });
    const origin = expectDefined(h.root.querySelector<HTMLElement>('.abyss-tg-block'));
    origin.focus();
    origin.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    );
    await accepted.promise;
    expect(h.current().planning.time).toBe('09:15');
    expect(document.activeElement).toBe(origin);
    expect(origin.isConnected).toBe(true);
    expect(h.root.querySelector<HTMLElement>('.abyss-cal-body')?.inert).not.toBe(true);
    receipt.resolve();
    await h.execute.mock.results[0]?.value;
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    const replacement = expectDefined(h.root.querySelector<HTMLElement>('.abyss-tg-block'));
    expect(replacement).not.toBe(origin);
    expect(document.activeElement).toBe(replacement);
    const nextKey = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true,
    });
    document.activeElement?.dispatchEvent(nextKey);
    expect(nextKey.defaultPrevented).toBe(true);
    await h.execute.mock.results[1]?.value;
    expect(h.current().planning.time).toBe('09:30');
  });
});

describe('timed drag release ownership', () => {
  it.each(['lostpointercapture', 'Escape'] as const)(
    'does not create a task when %s cancels the press before the first movement',
    async (ending) => {
      const h = await setup('week');
      const gesture = timedMove(h.root);
      if (ending === 'Escape')
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      else gesture.block.dispatchEvent(gesture.pointer(ending));
      gesture.move();
      gesture.finish();
      gesture.hour.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, clientY: 648 }),
      );
      expect(h.host.openCapture).not.toHaveBeenCalled();
      expect(h.execute).not.toHaveBeenCalled();
    },
  );

  it.each(['lostpointercapture', 'Escape'] as const)(
    'consumes the drag click after %s without blocking a fresh grid click',
    async (ending) => {
      const h = await setup('week');
      const gesture = timedMove(h.root);
      gesture.move();
      if (ending === 'Escape')
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      else gesture.block.dispatchEvent(gesture.pointer(ending));
      await h.publish();
      await flushMicrotasks();
      gesture.hour.dispatchEvent(gesture.pointer('pointerup', 25, 648));
      gesture.hour.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, clientY: 648 }),
      );
      expect(h.host.openCapture).not.toHaveBeenCalled();
      expect(h.execute).not.toHaveBeenCalled();
      await flushMicrotasks();
      gesture.hour.dispatchEvent(gesture.pointer('pointerdown', 25, 648));
      gesture.hour.dispatchEvent(gesture.pointer('pointerup', 25, 648));
      gesture.hour.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, clientY: 648 }),
      );
      expect(h.host.openCapture).toHaveBeenCalledOnce();
    },
  );

  it('keeps a plain task click selectable without writing a timing change', async () => {
    const h = await setup('week');
    const gesture = timedMove(h.root);
    gesture.finish(25, 552);
    gesture.block.click();
    expect(h.execute).not.toHaveBeenCalled();
    expect(gesture.block.classList.contains('is-selected')).toBe(true);
    expect(h.host.openCapture).not.toHaveBeenCalled();
  });

  it.each(['before', 'after'] as const)(
    'retains the cancelled drag click when another pointer presses the grid %s capture loss',
    async (order) => {
      const h = await setup('week');
      const gesture = timedMove(h.root);
      gesture.move();
      const touch = (type: string) =>
        new PointerEvent(type, { bubbles: true, pointerId: 52, pointerType: 'touch' });
      if (order === 'before') gesture.hour.dispatchEvent(touch('pointerdown'));
      gesture.block.dispatchEvent(gesture.pointer('lostpointercapture'));
      if (order === 'after') gesture.hour.dispatchEvent(touch('pointerdown'));
      gesture.finish();
      gesture.hour.dispatchEvent(
        new PointerEvent('click', {
          bubbles: true,
          cancelable: true,
          detail: 1,
          pointerId: 51,
          clientY: 648,
        }),
      );
      gesture.hour.dispatchEvent(touch('pointerup'));
      expect(h.host.openCapture).not.toHaveBeenCalled();
      expect(h.execute).not.toHaveBeenCalled();
    },
  );

  it.each(['release', 'scroll'] as const)(
    'consumes a drag click when movement is first observed on %s',
    async (movement) => {
      const h = await setup('week');
      const gesture = timedMove(h.root);
      if (movement === 'scroll') {
        gesture.scroll(96);
        gesture.block.dispatchEvent(gesture.pointer('lostpointercapture'));
      }
      gesture.finish();
      gesture.hour.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, clientY: 648 }),
      );
      expect(h.host.openCapture).not.toHaveBeenCalled();
      await flushMicrotasks();
      expect(h.current().planning.time).toBe(movement === 'release' ? '11:00' : '09:00');
    },
  );

  it('updates a stationary drag preview after scrolling and commits that visible slot', async () => {
    const h = await setup('week');
    const gesture = timedMove(h.root);
    gesture.move(125, 600);
    gesture.scroll(96);
    expect(
      JSON.parse(
        expectDefined(h.root.querySelector<HTMLElement>('.abyss-tg-drag-preview')).dataset[
          'target'
        ] ?? '{}',
      ),
    ).toMatchObject({ date: '2026-10-20', startMinutes: 720 });
    gesture.finish(125, 600);
    await flushMicrotasks();
    expect(h.current().planning).toMatchObject({
      due: '2026-10-20',
      time: '12:00',
      duration: 60,
    });
    expect(h.execute).toHaveBeenCalledOnce();
  });

  it('reads current geometry on release even before a scroll event is delivered', async () => {
    const h = await setup('week');
    const gesture = timedMove(h.root);
    const target = expectDefined(
      h.root.querySelector<HTMLElement>('.abyss-tg-day-column[data-tg-date="2026-10-20"]'),
    );
    const targetHour = expectDefined(target.querySelector<HTMLElement>('.abyss-tg-hour-column'));
    target.getBoundingClientRect = targetHour.getBoundingClientRect = () =>
      new DOMRect(100, 4, 100, 1152);
    gesture.finish(125, 552);
    await flushMicrotasks();
    expect(h.current().planning).toMatchObject({
      due: '2026-10-20',
      time: '11:00',
      duration: 60,
    });
  });

  it('keeps the resize endpoint under the pointer when the grid scrolls', async () => {
    const h = await setup('week');
    const gesture = timedResize(h.root);
    const day = expectDefined(gesture.block.closest<HTMLElement>('.abyss-tg-day-column'));
    const hour = expectDefined(gesture.block.closest<HTMLElement>('.abyss-tg-hour-column'));
    day.getBoundingClientRect = hour.getBoundingClientRect = () => new DOMRect(0, 4, 100, 1152);
    expectDefined(h.root.querySelector('.abyss-tg-grid-row')).dispatchEvent(new Event('scroll'));
    expect(
      JSON.parse(
        expectDefined(h.root.querySelector<HTMLElement>('.abyss-tg-drag-preview')).dataset[
          'target'
        ] ?? '{}',
      ),
    ).toMatchObject({ startMinutes: 540, durationMinutes: 210 });
    gesture.finish();
    await flushMicrotasks();
    expect(h.current().planning).toMatchObject({ time: '09:00', duration: 210 });
  });

  it('publishes interactive geometry before the next native activation turn', async () => {
    const h = await setup('week');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const gesture = timedMove(h.root);
    gesture.move();
    gesture.finish();
    await h.execute.mock.results[0]?.value;
    // Drain command continuations without releasing the native click-turn timer.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(h.current().planning.time).toBe('11:00');
    expect(h.root.querySelector('.abyss-tg-drag-preview')).toBeNull();
    expect(gesture.block.isConnected).toBe(false);
    expect(h.root.querySelector<HTMLElement>('.abyss-tg-block')?.style.top).toBe('528px');
    await vi.runAllTimersAsync();
    expect(h.root.querySelector('.abyss-tg-drag-preview')).toBeNull();
    expect(gesture.block.isConnected).toBe(false);
  });
});

describe('calendar publication during an owned gesture', () => {
  it('applies publication after a declined native drag start and pointer release', async () => {
    const h = await setup('month');
    const body = expectDefined(h.root.querySelector<HTMLElement>('.abyss-cal-body'));
    const source = body.createDiv();
    attachCalendarNativeDrag(
      source,
      expectDefined(h.application.index.list({ filePath: 'calendar.md' })[0]),
      () => undefined,
    );
    const marker = expectDefined(h.root.querySelector<HTMLElement>('.abyss-status-marker'));
    source.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 41 }));
    expect(startNativeDrag(source)).toBe(false);
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 41 }));
    await h.publish();
    await flushMicrotasks();
    expect(marker.isConnected).toBe(false);
  });

  it.each(['dragend', 'drop'] as const)(
    'keeps an accepted native drag publication until %s',
    async (ending) => {
      const h = await setup('month');
      const source = expectDefined(h.root.querySelector<HTMLElement>('[draggable="true"]'));
      source.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 42 }));
      expect(startNativeDrag(source)).toBe(true);
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 42 }));
      await h.publish();
      await flushMicrotasks();
      expect(source.isConnected).toBe(true);
      source.dispatchEvent(new Event(ending, { bubbles: true }));
      await flushMicrotasks();
      expect(source.isConnected).toBe(false);
    },
  );

  it('keeps a newer accepted native drag when an older start was canceled', async () => {
    const h = await setup('month');
    const source = expectDefined(h.root.querySelector<HTMLElement>('[draggable="true"]'));
    source.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 42 }));
    source.addEventListener(
      'dragstart',
      (event) => {
        event.preventDefault();
      },
      { once: true },
    );
    expect(startNativeDrag(source)).toBe(false);
    expect(startNativeDrag(source)).toBe(true);
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 42 }));
    await h.publish();
    await flushMicrotasks();
    expect(source.isConnected).toBe(true);
    source.dispatchEvent(new Event('dragend', { bubbles: true }));
    await flushMicrotasks();
    expect(source.isConnected).toBe(false);
  });

  it.each([false, true])(
    'preserves the requested resize and exact source target (child: %s)',
    async (child) => {
      const h = await setup('today', child);
      const original = h.current();
      const gesture = timedResize(h.root);
      await h.publish();
      expect(gesture.handle.isConnected).toBe(true);
      gesture.finish();
      await flushMicrotasks();
      expect(h.execute).toHaveBeenCalledOnce();
      expect(h.execute.mock.calls[0]?.[0]).toMatchObject({
        type: 'patch',
        target: child
          ? { type: 'subtask', ref: original.ref }
          : { type: 'task', ref: original.ref },
        patch: { duration: { type: 'set', value: 90 } },
      });
      expect(h.current().planning.duration).toBe(90);
      expect(h.root.querySelector('.abyss-tg-drag-preview')).toBeNull();
    },
  );

  it('releases capture and retires the old handle while persistence is pending', async () => {
    const h = await setup();
    const write = deferred<void>();
    h.execute.mockImplementation(async (command) => {
      await write.promise;
      return h.application.tasks.execute(command);
    });
    const gesture = timedResize(h.root);
    gesture.finish();
    expect(gesture.release).toHaveBeenCalledExactlyOnceWith(21);
    expect(h.root.querySelector<HTMLElement>('.abyss-tg-block')?.style.height).toBe('72px');
    await h.publish();
    expect(gesture.handle.isConnected).toBe(false);
    gesture.handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 22 }));
    window.dispatchEvent(
      new PointerEvent('pointerup', { clientX: 25, clientY: 628, pointerId: 22 }),
    );
    expect(h.execute).toHaveBeenCalledOnce();
    write.resolve();
    await flushMicrotasks();
    expect(h.current().planning.duration).toBe(90);
    expect(h.root.querySelector('.abyss-tg-drag-preview')).toBeNull();
    expect(h.root.querySelector<HTMLElement>('.abyss-cal-body')?.inert).toBe(false);
  });

  it.each(['month', 'week', 'today'] as const)(
    'keeps the first %s checkbox click through an unrelated publication',
    async (view) => {
      const h = await setup(view);
      h.root.createEl('button').focus();
      const marker = expectDefined(h.root.querySelector<HTMLElement>('.abyss-status-marker'));
      marker.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
      marker.focus();
      await h.publish();
      await flushMicrotasks();
      expect(marker.isConnected).toBe(true);
      marker.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
      await Promise.resolve();
      expect(marker.isConnected).toBe(true);
      marker.click();
      await flushMicrotasks();
      expect(h.execute.mock.calls.map(([command]) => command.type)).toEqual(['toggle-completion']);
      expect(h.current().status).toBe('done');
    },
  );

  it.each(['month', 'week', 'today'] as const)(
    'retains the first %s status menu until the user dismisses it',
    async (view) => {
      const h = await setup(view);
      const marker = expectDefined(h.root.querySelector<HTMLElement>('.abyss-status-marker'));
      marker.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 2, pointerId: 1 }),
      );
      marker.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }),
      );
      const menu = expectDefined(document.querySelector<HTMLElement>('.abyss-status-popover'));
      await h.publish();
      marker.dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, button: 2, pointerId: 1 }),
      );
      await flushMicrotasks();
      expect(menu.isConnected).toBe(true);
      expect(marker.isConnected).toBe(true);
      closeStatusPopovers(document);
      await flushMicrotasks();
      expect(marker.isConnected).toBe(false);
    },
  );

  it.each(['reject', 'unmount', 'navigate'] as const)(
    'cleans pending preview on %s and ignores late completion after owner loss',
    async (ending) => {
      const h = await setup();
      const write = deferred<void>();
      const failure = new Error('Controlled command failure');
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      h.execute.mockImplementation(async (command) => {
        await write.promise;
        if (ending === 'reject') throw failure;
        return h.application.tasks.execute(command);
      });
      const gesture = timedResize(h.root);
      gesture.finish();
      await h.publish();
      if (ending === 'unmount') h.mode.unmount();
      if (ending === 'navigate')
        expectDefined(h.root.querySelector<HTMLElement>('[aria-label="Next"]')).click();
      if (ending !== 'reject') expect(h.root.querySelector('.abyss-tg-drag-preview')).toBeNull();
      const updates = vi.mocked(h.host.onRenderComplete).mock.calls.length;
      write.resolve();
      await flushMicrotasks();
      expect(h.root.querySelector('.abyss-tg-drag-preview')).toBeNull();
      expect(gesture.release).toHaveBeenCalledExactlyOnceWith(21);
      if (ending === 'unmount') expect(h.host.onRenderComplete).toHaveBeenCalledTimes(updates);
      if (ending === 'reject') {
        expect(log).toHaveBeenCalledExactlyOnceWith(
          '[abyss-tasks] Could not complete UI action',
          failure,
        );
        expect(h.current().planning.duration).toBe(60);
      } else expect(log).not.toHaveBeenCalled();
    },
  );

  it.each(['Escape', 'pointercancel', 'blur', 'lostpointercapture'] as const)(
    'cancels the gesture on %s and applies the queued publication',
    async (ending) => {
      const h = await setup();
      const gesture = timedResize(h.root);
      await h.publish();
      if (ending === 'Escape')
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      else if (ending === 'lostpointercapture')
        gesture.handle.dispatchEvent(new PointerEvent(ending, { bubbles: true, pointerId: 21 }));
      else if (ending === 'pointercancel')
        window.dispatchEvent(new PointerEvent(ending, { pointerId: 21 }));
      else window.dispatchEvent(new Event('blur'));
      if (ending !== 'lostpointercapture') gesture.finish();
      await flushMicrotasks();
      expect(h.execute).not.toHaveBeenCalled();
      expect(h.root.querySelector('.abyss-tg-drag-preview')).toBeNull();
      expect(gesture.handle.isConnected).toBe(false);
    },
  );

  it('ignores another pointer cancellation and rereads the newest publication once', async () => {
    const h = await setup();
    const projection = vi.spyOn(h.application.index, 'forCalendarProjection');
    const gesture = timedResize(h.root);
    window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 22 }));
    await h.publish();
    await h.application.tasks.execute({
      type: 'patch',
      target: {
        type: 'task',
        ref: expectDefined(h.application.index.list({ filePath: 'calendar.md' })[0]).ref,
      },
      patch: { priority: { type: 'set', value: 'B' } },
    });
    expect(projection).not.toHaveBeenCalled();
    gesture.finish();
    expect(projection).not.toHaveBeenCalled();
    await flushMicrotasks();
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.current().planning.duration).toBe(90);
    expect(h.current().priority).toBe('B');
    expect(projection).toHaveBeenCalledOnce();
  });

  it('retires the old window listeners and pending preview when the calendar migrates', async () => {
    const h = await setup();
    const write = deferred<void>();
    h.execute.mockImplementation(async (command) => {
      await write.promise;
      return h.application.tasks.execute(command);
    });
    const gesture = timedResize(h.root);
    gesture.finish();
    await h.publish();
    const frame = document.body.createEl('iframe');
    const ownerDocument = expectDefined(frame.contentDocument);
    const ownerWindow = expectDefined(frame.contentWindow);
    // Obsidian installs its DOM helpers in each native realm; jsdom needs the same setup.
    for (const [name, prototype] of [
      ['Node', Node.prototype],
      ['HTMLElement', HTMLElement.prototype],
    ] as const) {
      const target = Reflect.get(ownerWindow, name) as { prototype: object };
      for (const key of Object.getOwnPropertyNames(prototype)) {
        if (key === 'constructor' || key in target.prototype) continue;
        Object.defineProperty(
          target.prototype,
          key,
          expectDefined(Object.getOwnPropertyDescriptor(prototype, key)),
        );
      }
    }
    ownerDocument.body.appendChild(ownerDocument.adoptNode(h.root));
    h.mode.render(h.root);
    expect(h.root.ownerDocument).toBe(ownerDocument);
    expect(h.root.querySelector('.abyss-tg-drag-preview')).toBeNull();
    expect(gesture.release).toHaveBeenCalledExactlyOnceWith(21);
    window.dispatchEvent(
      new PointerEvent('pointerup', { pointerId: 21, clientX: 25, clientY: 628 }),
    );
    write.resolve();
    await flushMicrotasks();
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.current().planning.duration).toBe(90);
    expect(h.root.querySelector('.abyss-tg-drag-preview')).toBeNull();
    h.mode.destroy();
    frame.remove();
  });

  it('resizes a just-created task before matching metadata arrives', async () => {
    const h = await setup();
    const createdResult = await h.application.tasks.execute({
      type: 'create',
      destination: {
        type: 'explicit',
        destination: { filePath: 'created.md', insertion: { type: 'append' } },
      },
      markdownBody: 'Created',
      initial: {
        due: { type: 'set', value: localDate('2026-10-19') },
        time: { type: 'set', value: localTime('07:00') },
      },
    });
    expect(createdResult.type, JSON.stringify(createdResult)).toBe('ok');
    const created = expectDefined(h.application.index.list({ filePath: 'created.md' })[0]);
    const block = expectDefined(
      [...h.root.querySelectorAll<HTMLElement>('.abyss-tg-block')].find((candidate) =>
        candidate.textContent.includes('Created'),
      ),
    );
    const day = expectDefined(block.closest<HTMLElement>('.abyss-tg-day-column'));
    const hour = expectDefined(block.closest<HTMLElement>('.abyss-tg-hour-column'));
    day.getBoundingClientRect = hour.getBoundingClientRect = () => new DOMRect(0, 100, 100, 1152);
    block.getBoundingClientRect = () => new DOMRect(0, 436, 100, 48);
    const handle = expectDefined(
      block.querySelector<HTMLElement>('.abyss-tg-resize-handle--duration'),
    );
    handle.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, pointerId: 25, clientX: 25, clientY: 484 }),
    );
    await h.publish();
    window.dispatchEvent(
      new PointerEvent('pointerup', { pointerId: 25, clientX: 25, clientY: 508 }),
    );
    await flushMicrotasks();
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.execute.mock.calls[0]?.[0]).toMatchObject({
      target: { type: 'task', ref: created.ref },
      patch: { duration: { type: 'set', value: 90 } },
    });
    expect(h.application.index.list({ filePath: 'created.md' })[0]?.planning.duration).toBe(90);
  });

  it.each(['edit', 'delete'] as const)(
    'refuses the retained gesture after an external %s instead of retargeting it',
    async (change) => {
      const h = await setup();
      const original = h.current();
      const gesture = timedResize(h.root);
      const file = expectDefined(h.app.vault.getFileByPath('calendar.md'));
      const text = change === 'edit' ? '- [ ] Replacement 📅 2026-10-19 ⏰ 12:00 ⏱️ 2h' : '';
      await h.app.vault.modify(file, text);
      metadataChangedEmitter(h.app)(file, text, h.app.metadataCache.getFileCache(file) ?? {});
      await flushMicrotasks();
      gesture.finish();
      await flushMicrotasks();
      expect(h.execute).toHaveBeenCalledOnce();
      expect(h.execute.mock.calls[0]?.[0]).toMatchObject({
        target: { type: 'task', ref: original.ref },
      });
      expect(await h.execute.mock.results[0]?.value).not.toMatchObject({ type: 'ok' });
      expect(await h.app.vault.read(file)).toBe(text);
      expect(h.root.querySelector('.abyss-tg-drag-preview')).toBeNull();
    },
  );
});

function spanGesture(root: HTMLElement, kind: 'create-span' | 'start' | 'due' | 'move') {
  const cells = [...root.querySelectorAll<HTMLElement>('.abyss-mg-cell, .abyss-tg-allday-cell')];
  const geometry = new Map<string, DOMRect>();
  for (const [index, cell] of cells.entries()) {
    const date = expectDefined(cell.dataset['mgDate'] ?? cell.dataset['tgDate']);
    const rect = new DOMRect((index % 7) * 100, Math.floor(index / 7) * 100, 100, 100);
    geometry.set(date, rect);
    cell.getBoundingClientRect = () => rect;
  }
  const boundary = kind === 'move' ? 'due' : kind;
  const sourceDate = kind === 'start' ? '2026-10-18' : '2026-10-19';
  const edge = expectDefined(
    [...root.querySelectorAll<HTMLElement>(`[data-boundary="${boundary}"]`)].find((candidate) => {
      const row = candidate.closest('.abyss-mg-row');
      return row?.querySelector(`[data-mg-date="${sourceDate}"]`) !== null;
    }),
  );
  const handle = kind === 'move' ? expectDefined(edge.parentElement) : edge;
  const origin = expectDefined(geometry.get(kind === 'start' ? '2026-10-18' : '2026-10-19'));
  const target = expectDefined(geometry.get(kind === 'start' ? '2026-10-17' : '2026-10-21'));
  handle.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      pointerId: 31,
      clientX: origin.x + 50,
      clientY: origin.y + 50,
    }),
  );
  const event = { pointerId: 31, clientX: target.x + 50, clientY: target.y + 50 };
  window.dispatchEvent(new PointerEvent('pointermove', event));
  return { handle, finish: () => window.dispatchEvent(new PointerEvent('pointerup', event)) };
}

describe('calendar span publication', () => {
  it.each([
    ['month', 'create-span', '2026-10-19', '2026-10-21'],
    ['week', 'create-span', '2026-10-19', '2026-10-21'],
    ['month', 'due', '2026-10-18', '2026-10-21'],
    ['week', 'due', '2026-10-18', '2026-10-21'],
    ['month', 'start', '2026-10-17', '2026-10-19'],
    ['month', 'move', '2026-10-20', '2026-10-21'],
    ['week', 'move', '2026-10-20', '2026-10-21'],
  ] as const)(
    'retains %s %s preview through publication and settlement',
    async (view, kind, start, due) => {
      const h = await setup(view, false, kind === 'create-span' ? '' : '🛫 2026-10-18');
      const write = deferred<void>();
      h.execute.mockImplementation(async (command) => {
        await write.promise;
        return h.application.tasks.execute(command);
      });
      const gesture = spanGesture(h.root, kind);
      await h.publish();
      expect(gesture.handle.isConnected).toBe(true);
      gesture.finish();
      expect(h.root.querySelector('.abyss-calendar-preview')).not.toBeNull();
      expect(h.execute).toHaveBeenCalledOnce();
      write.resolve();
      await flushMicrotasks();
      expect(h.current().planning).toMatchObject({ start, due });
      expect(h.root.querySelector('.abyss-calendar-preview')).toBeNull();
    },
  );
});

it.each(['before-write', 'after-write'] as const)(
  'serializes child priority while resize is pending (%s)',
  async (phase) => {
    const h = await setup('today', true);
    const gate = deferred<void>(),
      accepted = deferred<void>();
    h.execute.mockImplementationOnce(async (...args) => {
      if (phase === 'before-write') await gate.promise;
      const result = await h.application.tasks.execute(...args);
      accepted.resolve();
      if (phase === 'after-write') await gate.promise;
      return result;
    });
    vi.mocked(h.host.setPriority).mockImplementation(async (task, priority) => {
      const command = calendarPatchCommand(task, { priority: { type: 'set', value: priority } });
      if (command !== undefined) await h.execute(command);
    });
    timedResize(h.root).finish();
    if (phase === 'after-write') await accepted.promise;
    const marker = expectDefined(h.root.querySelector<HTMLElement>('.abyss-status-marker'));
    marker.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }),
    );
    expectDefined(
      document.querySelector<HTMLElement>('.abyss-status-popover [data-abyss-priority="A"]'),
    ).click();
    await flushMicrotasks();
    gate.resolve();
    await flushMicrotasks();
    expect(h.current().planning.duration).toBe(90);
    expect(h.current().priority).toBe('A');
  },
);

it('stops queued keyboard writes after a receipt includes an unrelated source edit', async () => {
  const h = await setup();
  const gate = deferred<void>();
  h.execute.mockImplementationOnce(async (...args) => {
    await gate.promise;
    return h.application.tasks.execute(...args);
  });
  const block = expectDefined(h.root.querySelector<HTMLElement>('.abyss-tg-block'));
  block.focus();
  for (let i = 0; i < 3; i++)
    block.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  const task = expectDefined(h.application.index.list({ filePath: 'calendar.md' })[0]);
  await h.application.tasks.execute({
    type: 'patch',
    target: { type: 'task', ref: task.ref },
    patch: { priority: { type: 'set', value: 'A' } },
  });
  gate.resolve();
  await flushMicrotasks();
  expect(h.current().planning.time).toBe('09:15');
  expect(h.current().priority).toBe('A');
  expect(h.execute).toHaveBeenCalledTimes(1);
});

it('retires pending planning and allows a fresh retry after navigating during a failed save', async () => {
  const h = await setup('week');
  const gate = deferred<void>();
  h.execute.mockImplementationOnce(async () => {
    await gate.promise;
    return { type: 'io-error', cause: 'repository-error', contentState: 'unknown' };
  });
  timedResize(h.root).finish();
  expect(h.root.querySelector<HTMLElement>('.abyss-tg-block')?.style.height).toBe('72px');
  expectDefined(h.root.querySelector<HTMLElement>('[aria-label="Next"]')).click();
  expectDefined(h.root.querySelector<HTMLElement>('[aria-label="Previous"]')).click();
  gate.resolve();
  await flushMicrotasks();
  expect(h.current().planning.duration).toBe(60);
  expect(h.root.querySelector<HTMLElement>('.abyss-tg-block')?.style.height).toBe('48px');
  timedResize(h.root).finish();
  await flushMicrotasks();
  expect(h.current().planning.duration).toBe(90);
  expect(h.execute).toHaveBeenCalledTimes(2);
});

it.each([false, true])('allows resize after unchanged priority (child=%s)', async (child) => {
  const h = await setup('today', child);
  vi.mocked(h.host.setPriority).mockImplementation(async (task, priority) => {
    const command = calendarPatchCommand(task, { priority: { type: 'set', value: priority } });
    if (command !== undefined) await h.execute(command);
  });
  expectDefined(h.root.querySelector<HTMLElement>('.abyss-status-marker')).dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }),
  );
  expectDefined(
    document.querySelector<HTMLElement>('.abyss-status-popover [data-abyss-priority="D"]'),
  ).click();
  await flushMicrotasks();
  timedResize(h.root).finish();
  await flushMicrotasks();
  expect(h.current().planning.duration).toBe(90);
  expect(h.execute).toHaveBeenCalledTimes(2);
});

it('retains source proof for a held gesture on a replacement mount', async () => {
  const h = await setup('week', true),
    gate = deferred<void>();
  h.execute.mockImplementationOnce(async (...args) => {
    await gate.promise;
    return h.application.tasks.execute(...args);
  });
  timedResize(h.root).finish();
  expectDefined(h.root.querySelector<HTMLElement>('[aria-label="Next"]')).click();
  expectDefined(h.root.querySelector<HTMLElement>('[aria-label="Previous"]')).click();
  const second = timedResize(h.root);
  gate.resolve();
  await flushMicrotasks();
  expect(second.handle.isConnected).toBe(true);
  expect(h.current().planning.duration).toBe(90);
  window.dispatchEvent(new PointerEvent('pointerup', { clientX: 25, clientY: 628, pointerId: 21 }));
  await flushMicrotasks();
  expect(h.current().planning.duration).toBe(120);
});

it.each([0, 1])(
  'drops a pending all-day projection at its requested date (shift=%s)',
  async (delta) => {
    const h = await setup('week', true),
      receipt = deferred<void>(),
      committed = deferred<void>();
    h.execute.mockImplementationOnce(async (...args) => {
      const result = await h.application.tasks.execute(...args);
      committed.resolve();
      await receipt.promise;
      return result;
    });
    const first = timedMove(h.root);
    for (const cell of h.root.querySelectorAll<HTMLElement>('.abyss-tg-allday-cell')) {
      const left = (Number(cell.dataset['tgDate']?.slice(-2)) - 19) * 100;
      cell.getBoundingClientRect = () => new DOMRect(left, 50, 100, 50);
    }
    first.finish(25 + delta * 100, 75);
    await committed.promise;
    const source = expectDefined(h.root.querySelector<HTMLElement>('[draggable="true"]'));
    let serialized = '';
    const transfer = {
      setData: (_type: string, value: string) => {
        serialized = value;
      },
      getData: () => serialized,
      effectAllowed: 'move',
      dropEffect: 'move',
    };
    const start = new Event('dragstart', { bubbles: true, cancelable: true });
    Object.defineProperty(start, 'dataTransfer', { value: transfer });
    source.dispatchEvent(start);
    expect(serialized).not.toBe('');
    const target = expectDefined(
      h.root.querySelector<HTMLElement>('.abyss-tg-allday-cell[data-tg-date="2026-10-21"]'),
    );
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: transfer });
    target.dispatchEvent(drop);
    await flushMicrotasks();
    receipt.resolve();
    await flushMicrotasks();
    expect(h.current().planning.due).toBe('2026-10-21');
  },
);

it.each([false, true])(
  'retains failed keyboard lineage for a legacy action already accepted (child=%s)',
  async (child) => {
    const h = await setup('today', child),
      gate = deferred<void>();
    h.execute.mockImplementationOnce(async () => {
      await gate.promise;
      return { type: 'io-error', cause: 'repository-error', contentState: 'unknown' };
    });
    vi.mocked(h.host.setPriority).mockImplementation(async (task, priority) => {
      const command = calendarPatchCommand(task, { priority: { type: 'set', value: priority } });
      if (command !== undefined) await h.execute(command);
    });
    const block = expectDefined(h.root.querySelector<HTMLElement>('.abyss-tg-block'));
    block.focus();
    block.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expectDefined(h.root.querySelector<HTMLElement>('.abyss-status-marker')).dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }),
    );
    expectDefined(
      document.querySelector<HTMLElement>('.abyss-status-popover [data-abyss-priority="A"]'),
    ).click();
    expect(h.execute).toHaveBeenCalledTimes(1);
    gate.resolve();
    await flushMicrotasks();
    expect(h.current().priority).toBe('D');
    expect(h.execute).toHaveBeenCalledTimes(1);
  },
);

it.each([false, true])(
  'follows a new keyboard action after pointer submission (child=%s)',
  async (child) => {
    const h = await setup('week', child, '⏰ 09:00 ⏱️ 1h', '2026-10-25');
    vi.mocked(h.host.rerender).mockImplementation(() => {
      h.mode.render(h.root);
    });
    const gate = deferred<void>();
    h.execute.mockImplementationOnce(async (...args) => {
      await gate.promise;
      return h.application.tasks.execute(...args);
    });
    const block = expectDefined(h.root.querySelector<HTMLElement>('.abyss-tg-block'));
    block.focus();
    block.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expectDefined(h.root.querySelector<HTMLElement>('.abyss-tg-hour-column')).dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, pointerId: 77, pointerType: 'touch' }),
    );
    timedResize(h.root, '2026-10-25').finish();
    expect(block.isConnected).toBe(true);
    expect(document.activeElement).toBe(block);
    block.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    gate.resolve();
    await flushMicrotasks();
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 77 }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    await flushMicrotasks();
    expect(h.current().planning.due).toBe('2026-10-26');
    expect(dates(h.root)).toContain('2026-10-26');
    expect(h.execute).toHaveBeenCalledTimes(3);
  },
);

it.each([false, true])(
  'invalidates a keyboard action accepted before pointer failure (child=%s)',
  async (child) => {
    const h = await setup('today', child);
    const gate = deferred<void>();
    h.execute.mockImplementationOnce(async (...args) => {
      await gate.promise;
      return h.application.tasks.execute(...args);
    });
    h.execute.mockImplementationOnce(async () => ({
      type: 'io-error',
      cause: 'repository-error',
      contentState: 'unknown',
    }));
    const block = expectDefined(h.root.querySelector<HTMLElement>('.abyss-tg-block'));
    block.focus();
    block.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    timedResize(h.root).finish();
    const current = expectDefined(h.root.querySelector<HTMLElement>('.abyss-tg-block'));
    current.focus();
    expect(current.isConnected).toBe(true);
    current.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    gate.resolve();
    await flushMicrotasks();
    expect(h.current().planning.time).toBe('09:15');
    expect(h.execute).toHaveBeenCalledTimes(2);
  },
);

it('keeps native keyboard focus when submitted planning replaces an uncommitted keyboard block', async () => {
  const h = await setup();
  const gate = deferred<void>();
  h.execute.mockImplementationOnce(async (...args) => {
    await gate.promise;
    return h.application.tasks.execute(...args);
  });
  const block = expectDefined(h.root.querySelector<HTMLElement>('.abyss-tg-block'));
  block.focus();
  block.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  timedResize(h.root).finish();
  const pending = expectDefined(h.root.querySelector<HTMLElement>('.abyss-tg-block'));
  expect(block.isConnected).toBe(false);
  expect(document.activeElement).toBe(pending);
  pending.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  gate.resolve();
  await flushMicrotasks();
  expect(h.current().planning).toMatchObject({ time: '09:30', duration: 75 });
  expect(h.execute).toHaveBeenCalledTimes(3);
});

it('keeps focus on the pointer destination after an earlier keyboard date receipt', async () => {
  const h = await setup('week', false, '⏰ 09:00 ⏱️ 1h', '2026-10-21');
  const gate = deferred<void>();
  h.execute.mockImplementationOnce(async (...args) => {
    await gate.promise;
    return h.application.tasks.execute(...args);
  });
  const original = expectDefined(h.root.querySelector<HTMLElement>('.abyss-tg-block'));
  original.focus();
  original.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  timedMove(h.root, '2026-10-21').finish(125, 552);
  expect(document.activeElement?.getAttribute('data-tg-segment-date')).toBe('2026-10-20');
  gate.resolve();
  await flushMicrotasks();
  expect(h.current().planning.due).toBe('2026-10-20');
  expect(document.activeElement?.getAttribute('data-tg-segment-date')).toBe('2026-10-20');
});

it.each([false, true])(
  'pins a rendered source while a gesture spans another keyboard receipt (child=%s)',
  async (child) => {
    const h = await setup('today', child);
    const first = deferred<void>(),
      second = deferred<void>();
    h.execute.mockImplementationOnce(async (...args) => {
      await first.promise;
      return h.application.tasks.execute(...args);
    });
    h.execute.mockImplementationOnce(async (...args) => {
      await second.promise;
      return h.application.tasks.execute(...args);
    });
    const original = expectDefined(h.root.querySelector<HTMLElement>('.abyss-tg-block'));
    original.focus();
    original.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    original.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    first.resolve();
    await flushMicrotasks();
    const resize = timedResize(h.root);
    second.resolve();
    await flushMicrotasks();
    expect(resize.handle.isConnected).toBe(true);
    resize.finish();
    await flushMicrotasks();
    expect(h.current().planning).toMatchObject({ time: '09:30', duration: 75 });
    expect(h.execute).toHaveBeenCalledTimes(3);
  },
);

it.each([false, true])(
  'joins a remounted committed source after its delayed receipt (child=%s)',
  async (child) => {
    const h = await setup('week', child);
    const receipt = deferred<void>(),
      committed = deferred<void>(),
      pointer = deferred<void>();
    h.execute.mockImplementationOnce(async (...args) => {
      const result = await h.application.tasks.execute(...args);
      committed.resolve();
      await receipt.promise;
      return result;
    });
    h.execute.mockImplementationOnce(async (...args) => {
      await pointer.promise;
      return h.application.tasks.execute(...args);
    });
    const original = expectDefined(h.root.querySelector<HTMLElement>('.abyss-tg-block'));
    original.focus();
    original.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await committed.promise;
    expectDefined(h.root.querySelector<HTMLElement>('[aria-label="Next"]')).click();
    expectDefined(h.root.querySelector<HTMLElement>('[aria-label="Previous"]')).click();
    timedResize(h.root).finish();
    receipt.resolve();
    await flushMicrotasks();
    expect(h.execute).toHaveBeenCalledTimes(2);
    const current = expectDefined(h.root.querySelector<HTMLElement>('.abyss-tg-block'));
    current.focus();
    expect(current.isConnected).toBe(true);
    current.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    current.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    pointer.resolve();
    await flushMicrotasks();
    expect(h.current().planning).toMatchObject({ time: '09:45', duration: 90 });
    expect(h.execute).toHaveBeenCalledTimes(4);
  },
);

it('does not put another task destination into a pending keyboard focus locator', async () => {
  const h = await setup('week', true, '⏰ 09:00 ⏱️ 1h', '2026-10-21');
  const root = expectDefined(h.application.index.list({ filePath: 'calendar.md' })[0]);
  await h.application.tasks.execute({
    type: 'patch',
    target: { type: 'subtask', ref: expectDefined(root.subtasks[1]).ref },
    patch: {
      due: { type: 'set', value: localDate('2026-10-22') },
      time: { type: 'set', value: localTime('10:00') },
      duration: { type: 'set', value: durationMinutes(60) },
    },
  });
  await flushMicrotasks();
  const gate = deferred<void>();
  h.execute.mockImplementationOnce(async (...args) => {
    await gate.promise;
    return h.application.tasks.execute(...args);
  });
  const focused = expectDefined(
    h.root.querySelector<HTMLElement>('.abyss-tg-block[data-abyss-task-line="1"]'),
  );
  focused.focus();
  focused.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  timedMove(h.root, '2026-10-22').finish(125, 552);
  expect(document.activeElement?.getAttribute('data-abyss-task-line')).toBe('1');
  gate.resolve();
  await flushMicrotasks();
  expect(document.activeElement?.getAttribute('data-abyss-task-line')).toBe('1');
});

it('does not dispatch a sibling key accepted before an unproved root receipt', async () => {
  const h = await setup('today', true);
  let root = expectDefined(h.application.index.list({ filePath: 'calendar.md' })[0]);
  await h.application.tasks.execute({
    type: 'patch',
    target: { type: 'subtask', ref: expectDefined(root.subtasks[1]).ref },
    patch: {
      due: { type: 'set', value: localDate('2026-10-19') },
      time: { type: 'set', value: localTime('10:00') },
      duration: { type: 'set', value: durationMinutes(60) },
    },
  });
  await flushMicrotasks();
  const gate = deferred<void>();
  h.execute.mockImplementationOnce(async (...args) => {
    await gate.promise;
    return h.application.tasks.execute(...args);
  });
  const first = expectDefined(
    h.root.querySelector<HTMLElement>('.abyss-tg-block[data-abyss-task-line="1"]'),
  );
  const second = expectDefined(
    h.root.querySelector<HTMLElement>('.abyss-tg-block[data-abyss-task-line="2"]'),
  );
  first.focus();
  first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  second.focus();
  second.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  root = expectDefined(h.application.index.list({ filePath: 'calendar.md' })[0]);
  await h.application.tasks.execute({
    type: 'patch',
    target: { type: 'task', ref: root.ref },
    patch: { priority: { type: 'set', value: 'A' } },
  });
  gate.resolve();
  await flushMicrotasks();
  root = expectDefined(h.application.index.list({ filePath: 'calendar.md' })[0]);
  expect(root.subtasks[0]?.planning.time).toBe('09:15');
  expect(root.subtasks[1]?.planning.time).toBe('10:00');
  expect(h.execute).toHaveBeenCalledTimes(1);
});

it.each([false, true].flatMap((child) => [false, true].map((failure) => ({ child, failure }))))(
  'keeps a published source linked to deferred keyboard input ($child / failure=$failure)',
  async ({ child, failure }) => {
    const h = await setup('today', child);
    const first = deferred<void>(),
      second = deferred<void>();
    h.execute.mockImplementationOnce(async (...args) => {
      await first.promise;
      return h.application.tasks.execute(...args);
    });
    h.execute.mockImplementationOnce(async (...args) => {
      await second.promise;
      return failure
        ? { type: 'io-error', cause: 'repository-error', contentState: 'unknown' }
        : h.application.tasks.execute(...args);
    });
    const original = expectDefined(h.root.querySelector<HTMLElement>('.abyss-tg-block'));
    original.focus();
    original.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    original.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    first.resolve();
    await flushMicrotasks();
    expect(h.execute).toHaveBeenCalledTimes(2);
    expect(original.isConnected).toBe(false);
    timedResize(h.root).finish();
    second.resolve();
    await flushMicrotasks();
    expect(h.execute).toHaveBeenCalledTimes(failure ? 2 : 3);
    expect(h.current().planning).toMatchObject({
      time: failure ? '09:15' : '09:30',
      duration: failure ? 60 : 75,
    });
  },
);

it.each([false, true])(
  'keeps one submitted block when metadata relocates its held source (child=%s)',
  async (child) => {
    const h = await setup('today', child);
    const gate = deferred<void>();
    h.execute.mockImplementationOnce(async (...args) => {
      await gate.promise;
      return h.application.tasks.execute(...args);
    });
    const original = expectDefined(h.root.querySelector<HTMLElement>('.abyss-tg-block'));
    original.focus();
    original.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    const file = expectDefined(h.app.vault.getFileByPath('calendar.md'));
    await h.app.vault.modify(file, `# Header\n${await h.app.vault.read(file)}`);
    seedTaskCache(
      h.app,
      'calendar.md',
      child
        ? [
            { task: ' ', parent: -1, line: 1 },
            { task: ' ', parent: 1, line: 2 },
            { task: ' ', parent: 1, line: 3 },
          ]
        : [{ task: ' ', parent: -1, line: 1 }],
    );
    await flushMicrotasks();
    try {
      expect(h.application.index.list({ filePath: 'calendar.md' })[0]?.ref.line).toBe(1);
      expect(original.isConnected).toBe(true);
      timedResize(h.root).finish();
      expect(h.root.querySelectorAll('.abyss-tg-block')).toHaveLength(1);
      expect(h.root.querySelector('.abyss-tg-block')?.textContent).toContain('09:00–10:30');
    } finally {
      gate.resolve();
      await flushMicrotasks();
    }
    expect(h.root.querySelectorAll('.abyss-tg-block')).toHaveLength(1);
    expect(h.root.querySelector<HTMLElement>('.abyss-tg-block')?.dataset['abyssTaskLine']).toBe(
      child ? '2' : '1',
    );
  },
);

it('retains settled submitted planning while another source still holds publication', async () => {
  const h = await setup('week', true);
  const root = expectDefined(h.application.index.list({ filePath: 'calendar.md' })[0]);
  await h.application.tasks.execute({
    type: 'patch',
    target: { type: 'subtask', ref: expectDefined(root.subtasks[1]).ref },
    patch: {
      due: { type: 'set', value: localDate('2026-10-20') },
      time: { type: 'set', value: localTime('09:00') },
      duration: { type: 'set', value: durationMinutes(60) },
    },
  });
  await flushMicrotasks();
  const first = deferred<void>(),
    second = deferred<void>();
  h.execute.mockImplementationOnce(async (...args) => {
    await first.promise;
    return h.application.tasks.execute(...args);
  });
  h.execute.mockImplementationOnce(async (...args) => {
    await second.promise;
    return h.application.tasks.execute(...args);
  });
  try {
    timedResize(h.root).finish();
    timedResize(h.root, '2026-10-20').finish();
    first.resolve();
    await flushMicrotasks();
    expect(h.current().planning.duration).toBe(90);
    timedMove(h.root, '2026-10-20').finish(125, 648);
    const settled = expectDefined(
      h.root.querySelector<HTMLElement>('.abyss-tg-block[data-tg-segment-date="2026-10-19"]'),
    );
    expect(settled.textContent).toContain('09:00–10:30');
  } finally {
    first.resolve();
    second.resolve();
    await flushMicrotasks();
  }
  expect(h.current().planning.duration).toBe(90);
});

it.each([false, true])(
  'keeps keyboard focus on submitted planning after its root receipt relocates (adjacent=%s)',
  async (adjacent) => {
    const h = await setup();
    const file = expectDefined(h.app.vault.getFileByPath('calendar.md'));
    if (adjacent) {
      await h.app.vault.modify(
        file,
        `${await h.app.vault.read(file)}\n- [ ] Sibling 📅 2026-10-19 ⏰ 12:00 ⏱️ 1h`,
      );
      seedTaskCache(h.app, 'calendar.md', [
        { task: ' ', parent: -1, line: 0 },
        { task: ' ', parent: -1, line: 1 },
      ]);
      await flushMicrotasks();
    }
    const first = deferred<void>(),
      second = deferred<void>();
    h.execute.mockImplementationOnce(async (...args) => {
      await first.promise;
      return h.application.tasks.execute(...args);
    });
    h.execute.mockImplementationOnce(async (...args) => {
      await second.promise;
      return h.application.tasks.execute(...args);
    });
    const original = expectDefined(h.root.querySelector<HTMLElement>('.abyss-tg-block'));
    original.focus();
    original.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await h.app.vault.modify(file, `# Header\n${await h.app.vault.read(file)}`);
    try {
      timedResize(h.root).finish();
      first.resolve();
      await flushMicrotasks();
      expect(h.current().ref).toMatchObject({ line: 1 });
      timedMove(h.root).finish(25, 648);
      const pending = expectDefined(h.root.querySelector<HTMLElement>('.abyss-tg-block'));
      expect(document.activeElement).toBe(pending);
      pending.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    } finally {
      first.resolve();
      second.resolve();
      await flushMicrotasks();
    }
    expect(h.current().planning).toMatchObject({ time: '11:15', duration: 75 });
    if (adjacent)
      expect(h.application.index.list({ filePath: 'calendar.md' })[1]?.planning.time).toBe('12:00');
  },
);

it.each(['resize', 'keyboard'] as const)(
  'uses canonical planning for a fresh %s after failure while another task still saves',
  async (kind) => {
    const h = await setup('week');
    const other = expectDefined(h.application.index.list({ filePath: 'other.md' })[0]);
    await h.application.tasks.execute({
      type: 'patch',
      target: { type: 'task', ref: other.ref },
      patch: {
        due: { type: 'set', value: localDate('2026-10-20') },
        time: { type: 'set', value: localTime('09:00') },
        duration: { type: 'set', value: durationMinutes(60) },
      },
    });
    await flushMicrotasks();
    const first = deferred<void>(),
      second = deferred<void>();
    h.execute.mockImplementationOnce(async () => {
      await first.promise;
      return { type: 'io-error', cause: 'repository-error', contentState: 'unknown' };
    });
    h.execute.mockImplementationOnce(async (...args) => {
      await second.promise;
      return h.application.tasks.execute(...args);
    });
    try {
      timedMove(h.root, '2026-10-19').finish(25, 600);
      timedResize(h.root, '2026-10-20').finish();
      first.resolve();
      await flushMicrotasks();
      expect(h.execute).toHaveBeenCalledTimes(2);
      expect(h.current().planning.time).toBe('09:00');
      const block = expectDefined(
        h.root.querySelector<HTMLElement>('.abyss-tg-block[data-abyss-task-file="calendar.md"]'),
      );
      expect(block.textContent).toContain('10:00–11:00');
      if (kind === 'keyboard') {
        block.focus();
        block.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      } else {
        const day = expectDefined(block.closest<HTMLElement>('.abyss-tg-day-column'));
        const hour = expectDefined(day.querySelector<HTMLElement>('.abyss-tg-hour-column'));
        day.getBoundingClientRect = hour.getBoundingClientRect = () =>
          new DOMRect(0, 100, 100, 1152);
        block.getBoundingClientRect = () => new DOMRect(0, 580, 100, 48);
        const handle = expectDefined(
          block.querySelector<HTMLElement>('[data-resize-edge="duration"]'),
        );
        handle.dispatchEvent(
          new PointerEvent('pointerdown', {
            bubbles: true,
            clientX: 25,
            clientY: 628,
            pointerId: 87,
          }),
        );
        window.dispatchEvent(
          new PointerEvent('pointerup', { clientX: 25, clientY: 652, pointerId: 87 }),
        );
      }
      second.resolve();
      await flushMicrotasks();
      expect(h.execute).toHaveBeenCalledTimes(3);
      expect(h.current().planning).toMatchObject(
        kind === 'keyboard' ? { time: '09:15', duration: 60 } : { time: '09:00', duration: 150 },
      );
    } finally {
      first.resolve();
      second.resolve();
      await flushMicrotasks();
    }
  },
);
