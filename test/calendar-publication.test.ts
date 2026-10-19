import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { CalendarMode, type CalendarModeHost } from '../src/panels/calendar/CalendarMode';
import type { CalViewType } from '../src/panels/calendar/calendarViewType';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { localDate, localTime, type TaskApplicationApi } from '../src/tasks';
import { noInteractionOwnership } from '../src/ui/interactionOwnership';
import { closeStatusPopovers } from '../src/ui/statusMenu';
import { attachCalendarNativeDrag } from '../src/views/calendarNativeDrag';
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
  closeStatusPopovers(document);
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function setup(view: CalViewType = 'today', child = false, timing = '⏰ 09:00 ⏱️ 1h') {
  vi.spyOn(Date, 'now').mockReturnValue(new Date(2026, 9, 19, 12).getTime());
  const line = `- [ ] Target 📅 2026-10-19 ${timing}`.trim();
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

function timedResize(root: HTMLElement) {
  const day = expectDefined(
    root.querySelector<HTMLElement>('.abyss-tg-day-column[data-tg-date="2026-10-19"]'),
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

  it('keeps the preview but releases capture while persistence is pending', async () => {
    const h = await setup();
    const write = deferred<void>();
    h.execute.mockImplementation(async (command) => {
      await write.promise;
      return h.application.tasks.execute(command);
    });
    const gesture = timedResize(h.root);
    gesture.finish();
    expect(gesture.release).toHaveBeenCalledExactlyOnceWith(21);
    expect(h.root.querySelector('.abyss-tg-drag-preview')).not.toBeNull();
    await h.publish();
    expect(gesture.handle.isConnected).toBe(true);
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
      const marker = expectDefined(h.root.querySelector<HTMLElement>('.abyss-status-marker'));
      marker.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
      marker.focus();
      await h.publish();
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
