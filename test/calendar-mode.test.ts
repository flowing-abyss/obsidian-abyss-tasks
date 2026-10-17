import type { App } from 'obsidian';
import { afterEach, assert, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { moment } from '../src/obsidianMoment';
import type { CalendarCapturePlacement } from '../src/panels/calendar/calendarCapturePlacement';
import { CalendarMode, type CalendarModeHost } from '../src/panels/calendar/CalendarMode';
import type { CalViewType } from '../src/panels/calendar/calendarViewType';
import { CaptureSessions } from '../src/panels/center/CaptureSessions';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { CalendarSettings } from '../src/settings/types';
import { StatusRegistry } from '../src/status/StatusRegistry';
import type { TaskCommandResult, TaskCreateSession, TaskIndexEvent } from '../src/tasks';
import { noInteractionOwnership } from '../src/ui/interactionOwnership';
import * as calendarOccurrences from '../src/views/calendarOccurrences';
import {
  deferred,
  expectDefined,
  flushMicrotasks,
  subtask,
  task,
  taskQueryApi,
  useRealMoment,
  type TestTaskQueries,
} from './helpers';
import { calendarAgendaHarness } from './support/calendarAgendaHarness';

useRealMoment();

/** The host calls one mount or patch makes, in order. */
const VIEW_UPDATE_CALLS = [
  'dismissRecurrenceEditor',
  'unmountActiveCapture',
  'remountActiveCapture',
  'syncTaskStackSelection',
  'onRenderComplete',
];

interface Harness {
  readonly cards: ReturnType<typeof calendarAgendaHarness>;
  readonly mode: CalendarMode;
  readonly host: CalendarModeHost;
  readonly root: HTMLElement;
  readonly calls: string[];
  readonly listeners: Set<(event: TaskIndexEvent) => void>;
  readonly openCalendarView: ReturnType<typeof vi.fn<(view: CalViewType) => void>>;
  emit(): void;
  date(): string;
  click(selector: string): void;
}

const roots: HTMLElement[] = [];
const modes: CalendarMode[] = [];
afterEach(() => {
  for (const mode of modes.splice(0)) mode.destroy();
  for (const root of roots.splice(0)) root.remove();
});

function harness(
  queryOverrides: Omit<Partial<TestTaskQueries>, 'subscribe'> = {},
  firstDayOfWeek: CalendarSettings['firstDayOfWeek'] = DEFAULT_SETTINGS.firstDayOfWeek,
): Harness {
  const calls: string[] = [];
  const note = (name: string): void => {
    calls.push(name);
  };
  const state = new AppState();
  const cards = calendarAgendaHarness(state);
  const host: CalendarModeHost = {
    mountAgendaEntry: cards.mountAgendaEntry,
    rerender: vi.fn(() => {
      note('rerender');
    }),
    onShowParent: vi.fn(async () => {}),
    openTask: vi.fn(() => {
      note('openTask');
    }),
    openForecastTask: vi.fn(() => {
      note('openForecastTask');
    }),
    toggleTask: vi.fn(() => {
      note('toggleTask');
      return Promise.resolve();
    }),
    setTaskStatus: vi.fn(() => {
      note('setTaskStatus');
      return Promise.resolve();
    }),
    setPriority: vi.fn(() => {
      note('setPriority');
      return Promise.resolve();
    }),
    dependenciesFor: () => undefined,
    tagGroups: () => [],
    openForecastRecurrenceEditor: vi.fn(() => {
      note('openForecastRecurrenceEditor');
    }),
    dismissRecurrenceEditor: vi.fn(() => {
      note('dismissRecurrenceEditor');
    }),
    openCapture: vi.fn(() => {
      note('openCapture');
    }),
    unmountActiveCapture: vi.fn(() => {
      note('unmountActiveCapture');
    }),
    remountActiveCapture: vi.fn(() => {
      note('remountActiveCapture');
    }),
    syncTaskStackSelection: vi.fn(() => {
      note('syncTaskStackSelection');
    }),
    onRenderComplete: vi.fn(() => {
      note('onRenderComplete');
    }),
  };
  const listeners = new Set<(event: TaskIndexEvent) => void>();
  const queries = taskQueryApi({
    ...queryOverrides,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  const openCalendarView = vi.fn<(view: CalViewType) => void>();
  state.set('mode', 'calendar');
  const mode = new CalendarMode({
    state,
    app: {} as App,
    settings: { ...DEFAULT_SETTINGS, firstDayOfWeek },
    queries,
    tasks: { queries, execute: vi.fn() },
    statusRegistry: new StatusRegistry(DEFAULT_SETTINGS.taskStatuses),
    interactionOwnership: noInteractionOwnership,
    navigation: { openCalendarView },
    host,
  });
  const root = document.body.createDiv();
  roots.push(root);
  modes.push(mode);
  return {
    mode,
    cards,
    host,
    root,
    calls,
    listeners,
    openCalendarView,
    emit: () => {
      for (const listener of [...listeners]) listener({ type: 'changed', files: [] });
    },
    date: () => mode['date_abyssPrivate'].format('YYYY-MM-DD'),
    click: (selector) => {
      expectDefined(root.querySelector<HTMLElement>(selector)).click();
    },
  };
}

describe('CalendarMode session state', () => {
  it('captures the displayed day as a civil-date snapshot and omits week and month dates', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 14, 12));
    try {
      const h = harness();
      h.mode.setView('today');
      h.mode.render(h.root);
      h.click('.abyss-cal-nav-btn[aria-label="Next"]');
      h.click('.abyss-cal-nav-btn[aria-label="Next"]');
      const captured = h.mode.captureDate();
      expect(captured).toBe('2026-10-16');
      h.click('.abyss-cal-nav-btn[aria-label="Next"]');
      expect(h.mode.captureDate()).toBe('2026-10-17');
      expect(captured).toBe('2026-10-16');
      for (const view of ['week', 'month'] as const) {
        h.mode.setView(view);
        expect(h.mode.captureDate()).toBeUndefined();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts in the month view on the first of the current month', () => {
    const h = harness();
    expect(h.mode.view()).toBe('month');
    expect(h.date()).toBe(moment().date(1).format('YYYY-MM-DD'));
    expect(h.calls).toEqual([]);
  });

  it('setView applies the view date policy without rendering', () => {
    const h = harness();
    h.mode.setView('week');
    expect(h.mode.view()).toBe('week');
    expect(h.date()).toBe(moment().format('YYYY-MM-DD'));
    h.mode.setView('today');
    expect(h.date()).toBe(moment().format('YYYY-MM-DD'));
    h.mode.setView('month');
    expect(h.date()).toBe(moment().date(1).format('YYYY-MM-DD'));
    expect(h.calls).toEqual([]);
    expect(h.root.childElementCount).toBe(0);
  });

  it('reports no pending keyboard focus before any interaction and cancels safely', () => {
    const h = harness();
    expect(h.mode.hasPendingTimedBlockFocus()).toBe(false);
    expect(() => {
      h.mode.cancelKeyboardInteraction();
    }).not.toThrow();
    expect(h.mode.hasPendingTimedBlockFocus()).toBe(false);
  });
});

describe('CalendarMode render', () => {
  it('mounts the navigation bar before the view body and reports the mount in order', () => {
    const h = harness();
    h.mode.render(h.root);
    expect([...h.root.children].map((child) => child.className)).toEqual([
      'abyss-cal-nav',
      'abyss-cal-body',
    ]);
    expect(h.root.querySelector('.abyss-cal-body .abyss-mg-head-row')).not.toBeNull();
    expect(h.calls).toEqual(VIEW_UPDATE_CALLS);
    expect(h.host.onRenderComplete).toHaveBeenCalledWith(h.root.querySelector('.abyss-cal-body'));
    expect(h.listeners.size).toBe(1);
  });

  it('patches the mounted view when the queries change and keeps the same instance', () => {
    const h = harness();
    h.mode.render(h.root);
    const body = h.root.querySelector('.abyss-cal-body');
    const head = h.root.querySelector('.abyss-mg-head-row');
    const instance = h.mode['viewInstance_abyssPrivate'];
    h.calls.length = 0;
    h.emit();
    expect(h.calls).toEqual(VIEW_UPDATE_CALLS);
    expect(h.mode['viewInstance_abyssPrivate']).toBe(instance);
    expect(h.root.querySelector('.abyss-cal-body')).toBe(body);
    expect(h.root.querySelector('.abyss-mg-head-row')).toBe(head);
    expect(h.host.rerender).not.toHaveBeenCalled();
  });

  it('re-rendering keeps the forecast menu owner and rebuilds the bar and subscription', () => {
    const h = harness();
    h.mode.render(h.root);
    const owner = h.mode['forecastMenuOwner_abyssPrivate'];
    const bar = h.mode['navigationBar_abyssPrivate'];
    h.mode.render(h.root);
    expect(h.mode['forecastMenuOwner_abyssPrivate']).toBe(owner);
    expect(h.mode['navigationBar_abyssPrivate']).not.toBe(bar);
    expect(h.root.querySelectorAll('.abyss-cal-nav')).toHaveLength(1);
    expect(h.root.querySelectorAll('.abyss-cal-body')).toHaveLength(1);
    expect(h.listeners.size).toBe(1);
  });

  it('unmount releases the subscription, the view, the owners, and the bar, and is idempotent', () => {
    const h = harness();
    h.mode.render(h.root);
    h.mode.unmount();
    expect(h.listeners.size).toBe(0);
    expect(h.mode['viewInstance_abyssPrivate']).toBeNull();
    expect(h.mode['navigationBar_abyssPrivate']).toBeNull();
    expect(h.mode['projectionDiagnosticOwner_abyssPrivate']).toBeNull();
    expect(h.mode['forecastMenuOwner_abyssPrivate']).not.toBeNull();
    h.calls.length = 0;
    h.emit();
    expect(h.calls).toEqual([]);
    expect(() => {
      h.mode.unmount();
      h.mode.destroy();
    }).not.toThrow();
  });
});

describe('CalendarMode navigation', () => {
  it('stepping cancels keyboard work, moves the date, updates the title, and remounts', () => {
    const h = harness();
    h.mode.render(h.root);
    const cancel = vi.spyOn(h.mode, 'cancelKeyboardInteraction');
    const before = h.mode['date_abyssPrivate'].clone();
    const title = expectDefined(h.root.querySelector('.abyss-cal-nav-month')).textContent;
    h.calls.length = 0;
    h.click('.abyss-cal-nav-btn[aria-label="Next"]');
    expect(cancel).toHaveBeenCalledOnce();
    expect(h.date()).toBe(before.add(1, 'month').date(1).format('YYYY-MM-DD'));
    expect(expectDefined(h.root.querySelector('.abyss-cal-nav-month')).textContent).not.toBe(title);
    expect(h.calls).toEqual(VIEW_UPDATE_CALLS);
    expect(h.host.rerender).not.toHaveBeenCalled();
  });

  it('the view switcher asks the navigator for the view instead of rendering itself', () => {
    const h = harness();
    h.mode.render(h.root);
    h.calls.length = 0;
    const week = expectDefined(
      [...h.root.querySelectorAll<HTMLElement>('.abyss-cal-view-btn')].find(
        (button) => button.textContent === 'Week',
      ),
    );
    week.click();
    expect(h.openCalendarView).toHaveBeenCalledWith('week');
    expect(h.mode.view()).toBe('month');
    expect(h.calls).toEqual([]);
  });

  it('a month day label opens the day view through the host', () => {
    const h = harness();
    h.mode.render(h.root);
    const cancel = vi.spyOn(h.mode, 'cancelKeyboardInteraction');
    const cell = expectDefined(h.root.querySelector<HTMLElement>('.abyss-mg-cell[data-mg-date]'));
    const date = expectDefined(cell.dataset['mgDate']);
    expectDefined(cell.querySelector<HTMLElement>('.abyss-mg-day-label')).click();
    expect(cancel).toHaveBeenCalledOnce();
    expect(h.mode.view()).toBe('today');
    expect(h.date()).toBe(date);
    expect(h.host.rerender).toHaveBeenCalledOnce();
  });

  it.each([
    [2026, 1, '2026-12-28'],
    [2025, 1, '2025-12-29'],
    [2026, 0, '2026-12-27'],
    [2025, 0, '2025-12-28'],
    [2026, 6, '2026-12-26'],
    [2025, 6, '2025-12-27'],
  ] as const)('opens the actual December %s row with week start %s', (year, firstDay, start) => {
    const h = harness({}, firstDay);
    h.mode['date_abyssPrivate'] = moment(`${year}-12-01`);
    h.mode.render(h.root);
    const row = expectDefined(
      h.root.querySelector(`[data-mg-date="${start}"]`)?.closest('.abyss-mg-row'),
    );
    expectDefined(row.querySelector<HTMLElement>('.abyss-mg-week-btn')).click();
    expect(h.mode.view()).toBe('week');
    expect(h.date()).toBe(start);
    h.mode.render(h.root);
    const weekDates = [...h.root.querySelectorAll<HTMLElement>('.abyss-tg-day-column')].map(
      (el) => el.dataset['tgDate'],
    );
    expect(weekDates).toEqual(
      Array.from({ length: 7 }, (_, index) =>
        moment(start).add(index, 'days').format('YYYY-MM-DD'),
      ),
    );
  });

  it('a month add button asks the host for a month capture at that date', () => {
    const h = harness();
    h.mode.render(h.root);
    const cell = expectDefined(h.root.querySelector<HTMLElement>('.abyss-mg-cell[data-mg-date]'));
    const date = expectDefined(cell.dataset['mgDate']);
    expectDefined(cell.querySelector<HTMLElement>('.abyss-mg-add-btn')).click();
    expect(h.host.openCapture).toHaveBeenCalledWith({ type: 'calendar-month', date });
  });
});

describe('CalendarMode week view', () => {
  function weekHarness(): Harness {
    const h = harness();
    h.mode.setView('week');
    h.mode.render(h.root);
    return h;
  }

  it('an hour column asks the host for a timed capture at that date and time', () => {
    const h = weekHarness();
    const column = expectDefined(
      h.root.querySelector<HTMLElement>('.abyss-tg-day-column[data-tg-date]'),
    );
    const date = expectDefined(column.dataset['tgDate']);
    // jsdom reports a zero-height column, so the click snaps to the first slot of the day.
    expectDefined(column.querySelector<HTMLElement>('.abyss-tg-hour-column')).click();
    expect(h.host.openCapture).toHaveBeenCalledWith({
      type: 'calendar-timed',
      date,
      time: '00:00',
    });
  });

  it('the month picker cancels keyboard work, closes, moves the date, retitles, and remounts', () => {
    const h = weekHarness();
    const cancel = vi.spyOn(h.mode, 'cancelKeyboardInteraction');
    const before = h.mode['date_abyssPrivate'].clone();
    const title = expectDefined(h.root.querySelector('.abyss-cal-nav-month')).textContent;
    h.click('.abyss-cal-nav-month');
    const options = [...h.root.querySelectorAll<HTMLElement>('.abyss-month-picker-btn')];
    const target = (before.month() + 6) % 12;
    h.calls.length = 0;
    expectDefined(options[target]).click();
    expect(cancel).toHaveBeenCalledOnce();
    expect(h.root.querySelector('.abyss-month-picker')).toBeNull();
    expect(h.date()).toBe(before.clone().month(target).date(1).format('YYYY-MM-DD'));
    expect(expectDefined(h.root.querySelector('.abyss-cal-nav-month')).textContent).not.toBe(title);
    expect(h.calls).toEqual(VIEW_UPDATE_CALLS);
    expect(h.host.rerender).not.toHaveBeenCalled();
  });

  it('Today anchors the week on today and remounts', () => {
    const h = weekHarness();
    const current = moment().format('YYYY-MM-DD');
    h.click('.abyss-cal-nav-btn[aria-label="Next"]');
    expect(h.date()).not.toBe(current);
    h.calls.length = 0;
    h.click('.abyss-cal-nav-today');
    expect(h.date()).toBe(current);
    expect(h.calls).toEqual(VIEW_UPDATE_CALLS);
    expect(h.host.rerender).not.toHaveBeenCalled();
  });
});

describe('CalendarMode forecast menu', () => {
  it('opens the forecast recurrence editor anchored to the occurrence element', () => {
    const root = task({
      title: 'Repeat source',
      recurrence: 'every day',
      planning: { due: '2026-09-01' },
    });
    const source = { root, target: { type: 'task' as const, ref: root.ref }, node: root };
    const h = harness({
      list: () => [root],
      forCalendarProjection: () => ({ materialized: [], recurringSources: [source] }),
    });
    h.mode['date_abyssPrivate'] = moment('2026-09-01');
    h.mode.render(h.root);
    const item = expectDefined(
      h.root.querySelector<HTMLElement>('.abyss-calendar-item[data-occurrence-state="forecast"]'),
    );
    item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expectDefined(
      document.querySelector<HTMLButtonElement>('.abyss-forecast-context-menu-edit-repeat'),
    ).click();

    expect(h.host.openForecastRecurrenceEditor).toHaveBeenCalledOnce();
    const [anchor, calledSource] = expectDefined(
      vi.mocked(h.host.openForecastRecurrenceEditor).mock.calls[0],
    );
    expect(anchor).toBe(item);
    expect(anchor).not.toBe(h.root.querySelector('.abyss-cal-body'));
    expect(calledSource.root.ref).toEqual(root.ref);
    expect(document.querySelector('.abyss-forecast-context-menu')).toBeNull();
  });
});

it('returns actual activation to the corresponding newly mounted view button', () => {
  const h = harness();
  h.mode.render(h.root);
  h.openCalendarView.mockImplementation((view) => {
    h.mode.setView(view);
    h.mode.render(h.root);
  });
  const old = expectDefined(
    [...h.root.querySelectorAll<HTMLButtonElement>('.abyss-cal-view-btn')].find(
      (x) => x.textContent === 'Week',
    ),
  );
  old.focus();
  old.click();
  const live = expectDefined(
    [...h.root.querySelectorAll<HTMLButtonElement>('.abyss-cal-view-btn')].find(
      (x) => x.textContent === 'Week',
    ),
  );
  expect(old.isConnected).toBe(false);
  expect(document.activeElement).toBe(live);
});

it('does not acquire view focus for programmatic navigation', () => {
  const h = harness();
  h.mode.render(h.root);
  const outside = document.body.createEl('input');
  outside.focus();
  try {
    h.mode.setView('month');
    h.mode.render(h.root);
    expect(document.activeElement).toBe(outside);
  } finally {
    outside.remove();
  }
});

describe('compact CalendarMode', () => {
  function narrow(h: Harness, width: number | (() => number) = 360): void {
    vi.spyOn(h.root, 'getBoundingClientRect').mockImplementation(() => {
      const measuredWidth = typeof width === 'function' ? width() : width;
      return new DOMRect(0, 0, measuredWidth, 700);
    });
  }

  function resizableWidth(h: Harness, initial: number): (next: number) => Promise<void> {
    let width = initial;
    narrow(h, () => width);
    return async (next) => {
      width = next;
      window.dispatchEvent(new Event('resize'));
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => {
          resolve();
        });
      });
    };
  }

  it.each(['month', 'week'] as const)(
    'keeps compact body spacing aligned with the mounted %s view across resize and Day replacement',
    async (view) => {
      const h = harness();
      const resize = resizableWidth(h, 800);
      const body = (): HTMLElement =>
        expectDefined(h.root.querySelector<HTMLElement>('.abyss-cal-body'));
      h.mode.setView(view);
      h.mode.render(h.root);
      const retainedBody = body();
      expect(retainedBody.classList.contains('abyss-cal-body--compact')).toBe(false);
      await resize(360);
      expect(body()).toBe(retainedBody);
      expect(body().classList.contains('abyss-cal-body--compact')).toBe(true);
      expect(body().querySelector('.abyss-calendar-compact')).not.toBeNull();
      h.emit();
      expect(body().classList.contains('abyss-cal-body--compact')).toBe(true);
      await resize(800);
      expect(body()).toBe(retainedBody);
      expect(body().classList.contains('abyss-cal-body--compact')).toBe(false);
      expect(body().querySelector('.abyss-calendar-compact')).toBeNull();
      await resize(360);
      expect(body().classList.contains('abyss-cal-body--compact')).toBe(true);
      h.mode.setView('today');
      h.mode.render(h.root);
      expect(body()).not.toBe(retainedBody);
      expect(body().classList.contains('abyss-cal-body--compact')).toBe(false);
      expect(body().querySelector('.abyss-calendar-compact')).toBeNull();
      await resize(800);
      await resize(360);
      expect(body().classList.contains('abyss-cal-body--compact')).toBe(false);
      h.mode.setView(view);
      h.mode.render(h.root);
      expect(body().classList.contains('abyss-cal-body--compact')).toBe(true);
      expect(body().querySelector('.abyss-calendar-compact')).not.toBeNull();
    },
  );

  it('changes the selected agenda without querying, projecting or adapting display snapshots', () => {
    const adapt = vi.spyOn(calendarOccurrences, 'taskSnapshotForCalendarOccurrence');
    const project = vi.spyOn(calendarOccurrences, 'projectCalendarOccurrences');
    const first = task({
      source: { line: 1 },
      title: 'First day',
      planning: { due: '2026-10-16' },
    });
    const second = task({
      source: { line: 2 },
      title: 'Second day',
      planning: { due: '2026-10-17' },
    });
    const forCalendarProjection = vi.fn(() => ({
      materialized: [first, second].map((root) => ({
        root,
        node: root,
        target: { type: 'task' as const, ref: root.ref },
      })),
      recurringSources: [],
    }));
    const h = harness({ forCalendarProjection });
    narrow(h);
    h.mode['date_abyssPrivate'] = moment('2026-10-01');
    h.mode.render(h.root);
    expect(h.root.querySelectorAll('.abyss-calendar-date')).toHaveLength(42);
    expect(adapt).not.toHaveBeenCalled();
    expect(project).toHaveBeenCalledOnce();
    h.click('[data-calendar-date="2026-10-16"].abyss-calendar-date');
    const before = forCalendarProjection.mock.calls.length;
    const skeleton = h.root.querySelector('.abyss-calendar-date');
    h.click('[data-calendar-date="2026-10-17"].abyss-calendar-date');
    expect(forCalendarProjection).toHaveBeenCalledTimes(before);
    expect(project).toHaveBeenCalledOnce();
    expect(adapt).not.toHaveBeenCalled();
    expect(h.root.querySelector('.abyss-calendar-agenda')?.getAttribute('data-calendar-date')).toBe(
      '2026-10-17',
    );
    expect(h.root.querySelector('.abyss-calendar-agenda')?.textContent).toContain('Second day');
    expect(h.root.querySelector('.abyss-calendar-agenda')?.textContent).not.toContain('First day');
    expect(h.mode.captureDate()).toBe('2026-10-17');
    h.click('.abyss-add-task-trigger');
    expect(h.host.openCapture).toHaveBeenCalledWith({
      type: 'calendar-agenda',
      date: '2026-10-17',
    });
    h.emit();
    expect(h.root.querySelector('.abyss-calendar-date')).toBe(skeleton);
    expect(h.root.querySelector('.abyss-calendar-agenda')?.getAttribute('data-calendar-date')).toBe(
      '2026-10-17',
    );
    expect(forCalendarProjection).toHaveBeenCalledTimes(before + 1);
    expect(project).toHaveBeenCalledTimes(2);
    expect(adapt).not.toHaveBeenCalled();
  });

  it.each(['month', 'week'] as const)(
    'reuses the latest %s occurrences across compact/grid remounts without extra projection',
    async (view) => {
      const adapt = vi.spyOn(calendarOccurrences, 'taskSnapshotForCalendarOccurrence');
      const project = vi.spyOn(calendarOccurrences, 'projectCalendarOccurrences');
      let current = task({ title: 'Original publication', planning: { due: '2026-10-16' } });
      const forCalendarProjection = vi.fn(() => ({
        materialized: [
          { root: current, node: current, target: { type: 'task' as const, ref: current.ref } },
        ],
        recurringSources: [],
      }));
      const h = harness({ forCalendarProjection });
      const resize = resizableWidth(h, 360);
      h.mode.setView(view);
      h.mode['date_abyssPrivate'] = moment('2026-10-16');
      h.mode.render(h.root);
      h.click('.abyss-calendar-date[data-calendar-date="2026-10-16"]');
      const agendaText = () =>
        expectDefined(h.root.querySelector('.abyss-calendar-agenda')).textContent;
      expect(agendaText()).toContain('Original publication');
      expect(adapt).not.toHaveBeenCalled();
      expect(forCalendarProjection).toHaveBeenCalledOnce();
      expect(project).toHaveBeenCalledOnce();
      await resize(800);
      expect(
        h.root.querySelector(view === 'month' ? '.abyss-mg-grid' : '.abyss-tg-grid-row'),
      ).not.toBeNull();
      expect(adapt).toHaveBeenCalledOnce();
      const initial = project.mock.results[0];
      assert(initial?.type === 'return');
      expect(adapt.mock.calls[0]?.[0]).toBe(initial.value.occurrences[0]);
      current = task({
        ...current,
        title: 'Latest publication',
        markdownTitle: 'Latest publication',
      });
      h.emit();
      expect(adapt).toHaveBeenCalledTimes(2);
      expect(forCalendarProjection).toHaveBeenCalledTimes(2);
      expect(project).toHaveBeenCalledTimes(2);
      const latest = project.mock.results[1];
      assert(latest?.type === 'return');
      await resize(360);
      expect(agendaText()).toContain('Latest publication');
      expect(agendaText()).not.toContain('Original publication');
      expect(adapt).toHaveBeenCalledTimes(2);
      expect(expectDefined(h.mode['contentCache_abyssPrivate']).occurrences).toBe(
        latest.value.occurrences,
      );
      h.click('.abyss-calendar-date[data-calendar-date="2026-10-17"]');
      expect(h.root.querySelector('.abyss-calendar-agenda-empty')?.textContent).toBe(
        'No tasks for this day',
      );
      expect(forCalendarProjection).toHaveBeenCalledTimes(2);
      expect(project).toHaveBeenCalledTimes(2);
      expect(adapt).toHaveBeenCalledTimes(2);
    },
  );

  it('coalesces width changes, remounts only across the threshold and ignores disposed work', async () => {
    const callbacks: ResizeObserverCallback[] = [];
    const disconnect = vi.fn();
    const observer = vi.fn(function (callback: ResizeObserverCallback) {
      callbacks.push(callback);
      return { observe: vi.fn(), unobserve: vi.fn(), disconnect };
    });
    const saved = window.ResizeObserver;
    window.ResizeObserver = observer;
    try {
      const h = harness();
      let width = 800;
      vi.spyOn(h.root, 'getBoundingClientRect').mockImplementation(() => ({
        width,
        height: 700,
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: width,
        bottom: 700,
        toJSON: () => ({}),
      }));
      h.mode.render(h.root);
      const notify = (): void => {
        callbacks.forEach((callback) => {
          callback([], {} as ResizeObserver);
        });
      };
      const frame = (): Promise<void> =>
        new Promise((resolve) =>
          window.requestAnimationFrame(() => {
            resolve();
          }),
        );
      width = 360;
      notify();
      notify();
      await frame();
      expect(h.root.querySelectorAll('.abyss-calendar-date')).toHaveLength(42);
      const date = h.root.querySelector('.abyss-calendar-date');
      width = 412;
      notify();
      await frame();
      expect(h.root.querySelector('.abyss-calendar-date')).toBe(date);
      width = 800;
      notify();
      await frame();
      expect(h.root.querySelector('.abyss-mg-grid')).not.toBeNull();
      const count = h.calls.length;
      width = 360;
      notify();
      h.mode.unmount();
      await frame();
      notify();
      await frame();
      expect(disconnect).toHaveBeenCalled();
      expect(h.calls).toHaveLength(count);
    } finally {
      Object.defineProperty(window, 'ResizeObserver', { configurable: true, value: saved });
    }
  });

  it('anchors week and day switches to an overflow selection without moving its month', () => {
    const h = harness();
    narrow(h);
    h.mode['date_abyssPrivate'] = moment('2026-10-01');
    h.mode.render(h.root);
    h.click('.abyss-calendar-date[data-calendar-date="2026-11-01"]');
    expect(h.date()).toBe('2026-10-01');
    h.mode.setView('week');
    h.mode.render(h.root);
    expect(h.root.querySelectorAll('.abyss-calendar-date')).toHaveLength(7);
    expect(
      h.root
        .querySelector('.abyss-calendar-date[aria-pressed="true"]')
        ?.getAttribute('data-calendar-date'),
    ).toBe('2026-11-01');
    h.mode.setView('today');
    expect(h.date()).toBe('2026-11-01');
  });
});

function expectCalendarFeedback(root: HTMLElement, compact: boolean): void {
  const input = expectDefined(root.querySelector<HTMLInputElement>('.abyss-capture-input'));
  const surface = expectDefined(input.closest('.abyss-capture-surface'));
  const portals = root.querySelectorAll('.abyss-calendar-capture-feedback');
  expect(portals).toHaveLength(compact ? 0 : 1);
  const feedback = compact ? surface : expectDefined(portals.item(0));
  const destination = expectDefined(
    feedback.querySelector<HTMLElement>('.abyss-capture-destination'),
  );
  const pending = expectDefined(feedback.querySelector<HTMLElement>('.abyss-capture-pending'));
  const error = expectDefined(feedback.querySelector<HTMLElement>('.abyss-capture-error'));
  expect(destination.textContent).toContain('2026-10-16');
  for (const node of [destination, pending, error]) expect(node.isConnected).toBe(true);
  if (compact) expect(surface.closest('.abyss-calendar-agenda')).not.toBeNull();
  else expect(surface.contains(destination)).toBe(false);
  expect(input.getAttribute('aria-describedby')).toContain(destination.id);
  if (input.getAttribute('aria-invalid') === 'true') {
    expect(input.getAttribute('aria-describedby')).toContain(error.id);
    expect(error.hidden).toBe(false);
    expect(error.textContent).not.toBe('');
  }
  expect(pending.hidden).toBe(input.getAttribute('aria-busy') !== 'true');
}

const calendarDraftCases = [
  { view: 'month', placement: { type: 'calendar-agenda', date: '2026-10-16' } },
  { view: 'week', placement: { type: 'calendar-agenda', date: '2026-10-16' } },
  { view: 'month', placement: { type: 'calendar-month', date: '2026-10-16' } },
  { view: 'week', placement: { type: 'calendar-all-day', date: '2026-10-16' } },
  { view: 'week', placement: { type: 'calendar-timed', date: '2026-10-16', time: '09:30' } },
] satisfies Array<{ view: 'month' | 'week'; placement: CalendarCapturePlacement }>;

it.each(
  calendarDraftCases.flatMap((entry) =>
    (['focus', 'pointer', 'compatibility-mouse'] as const).map((activation) => ({
      ...entry,
      activation,
    })),
  ),
)(
  'keeps frozen $placement.type draft and feedback with its mounted $view editor by $activation',
  async ({ view, placement, activation }) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 16, 12));
    const h = harness();
    let width = placement.type === 'calendar-agenda' ? 360 : 800;
    vi.spyOn(h.root, 'getBoundingClientRect').mockImplementation(() => ({
      width,
      height: 700,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: width,
      bottom: 700,
      toJSON: () => ({}),
    }));
    const result = deferred<TaskCommandResult>();
    const execute = vi.fn<TaskCreateSession['execute']>(() => result.promise);
    const application = {
      queries: taskQueryApi(),
      execute: vi.fn(),
      planCreate: async (): Promise<TaskCreateSession> => ({
        type: 'ready',
        destination: { filePath: 'Capture.md', insertion: { type: 'append' } },
        preview: () => ({ type: 'unavailable', cause: 'preview-capability' }),
        execute,
      }),
    };
    const captures = new CaptureSessions({
      state: new AppState(),
      settings: DEFAULT_SETTINGS,
      application,
      listNodes: () => [],
      onCreationResult: () => {},
      root: () => h.root,
    });
    vi.mocked(h.host.openCapture).mockImplementation((placement) => {
      captures.openCapture(placement, { type: 'default', source: 'calendar' });
    });
    vi.mocked(h.host.unmountActiveCapture).mockImplementation(() => {
      captures.unmountActiveCapture();
    });
    vi.mocked(h.host.remountActiveCapture).mockImplementation(() => {
      captures.remountActiveCapture();
    });
    const input = (): HTMLInputElement =>
      expectDefined(h.root.querySelector<HTMLInputElement>('.abyss-capture-input'));
    const resize = async (next: number): Promise<void> => {
      width = next;
      window.dispatchEvent(new Event('resize'));
      await new Promise<void>((resolve) =>
        window.requestAnimationFrame(() => {
          resolve();
        }),
      );
    };
    try {
      h.mode.setView(view);
      h.mode['date_abyssPrivate'] = moment('2026-10-16');
      h.mode.render(h.root);
      if (placement.type === 'calendar-agenda') h.click('.abyss-add-task-trigger');
      else captures.openCapture(placement, { type: 'default', source: 'calendar' });
      await flushMicrotasks();
      expectCalendarFeedback(h.root, width === 360);
      if (width === 360) {
        expect(input().closest('.abyss-add-task-bar')).not.toBeNull();
        expect(input().closest('.abyss-calendar-agenda-list')).toBeNull();
        expect(h.root.querySelector<HTMLButtonElement>('.abyss-add-task-trigger')?.hidden).toBe(
          true,
        );
      }
      input().value = 'Frozen draft';
      input().dispatchEvent(new Event('input', { bubbles: true }));
      h.emit();
      expectCalendarFeedback(h.root, width === 360);
      expect(input().value).toBe('Frozen draft');
      await resize(800);
      expectCalendarFeedback(h.root, false);
      expect(input().value).toBe('Frozen draft');
      await resize(360);
      expectCalendarFeedback(h.root, true);
      expect(input().value).toBe('Frozen draft');
      const next = expectDefined(
        h.root.querySelector<HTMLButtonElement>(
          '.abyss-calendar-date[data-calendar-date="2026-10-17"]',
        ),
      );
      await activateCalendarDraftNavigation(next, input(), activation);
      await flushMicrotasks();
      expect(execute).not.toHaveBeenCalled();
      expect(h.root.querySelector('.abyss-capture-input')).toBeNull();
      expect(h.root.querySelector('.abyss-calendar-capture-feedback')).toBeNull();
      h.click('.abyss-calendar-date[data-calendar-date="2026-10-16"]');
      expect(input().value).toBe('Frozen draft');
      if (activation !== 'focus') {
        const forward = expectDefined(
          h.root.querySelector<HTMLElement>('.abyss-cal-nav-btn[aria-label="Next"]'),
        );
        await activateCalendarDraftNavigation(forward, input(), activation);
        await flushMicrotasks();
        expect(execute).not.toHaveBeenCalled();
        h.click('.abyss-cal-nav-btn[aria-label="Previous"]');
        h.click('.abyss-calendar-date[data-calendar-date="2026-10-16"]');
        expect(input().value).toBe('Frozen draft');
      }
      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await flushMicrotasks();
      expect(execute).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({
          markdownBody: 'Frozen draft',
          initial: {
            due: { type: 'set', value: '2026-10-16' },
            ...(placement.type === 'calendar-timed'
              ? { time: { type: 'set', value: '09:30' } }
              : {}),
          },
        }),
      );
      expect(input().readOnly).toBe(true);
      expect(input().getAttribute('aria-busy')).toBe('true');
      expectCalendarFeedback(h.root, true);
      await resize(800);
      expectCalendarFeedback(h.root, false);
      expect(input().value).toBe('Frozen draft');
      await resize(360);
      expectCalendarFeedback(h.root, true);
      result.resolve({ type: 'io-error', cause: 'repository-error', contentState: 'unchanged' });
      await flushMicrotasks();
      expect(input().getAttribute('aria-invalid')).toBe('true');
      expect(input().readOnly).toBe(false);
      expectCalendarFeedback(h.root, true);
      for (const nextWidth of [800, 360]) {
        await resize(nextWidth);
        expect(input().getAttribute('aria-invalid')).toBe('true');
        expect(input().value).toBe('Frozen draft');
        expectCalendarFeedback(h.root, nextWidth === 360);
      }
      if (placement.type !== 'calendar-agenda') {
        await resize(800);
        expectCalendarFeedback(h.root, false);
      }
      expect(execute).toHaveBeenCalledOnce();
      captures.cancelActiveCapture();
      expect(h.root.querySelector('.abyss-capture-surface')).toBeNull();
      expect(h.root.querySelector('.abyss-calendar-capture-feedback')).toBeNull();
    } finally {
      captures.cancelActiveCapture();
      vi.useRealTimers();
    }
  },
);

it.each([
  { firstDay: 0 as const, start: '2026-11-01', next: '2026-11-08' },
  { firstDay: 6 as const, start: '2026-10-31', next: '2026-11-07' },
])(
  'keeps a selected Sunday inside the configured week ($firstDay)',
  ({ firstDay, start, next }) => {
    const h = harness({}, firstDay);
    vi.spyOn(h.root, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 360, 700));
    h.mode['date_abyssPrivate'] = moment('2026-10-01');
    h.mode.render(h.root);
    h.click('.abyss-calendar-date[data-calendar-date="2026-11-01"]');
    h.openCalendarView.mockImplementation((view) => {
      h.mode.setView(view);
      h.mode.render(h.root);
    });
    expectDefined(
      [...h.root.querySelectorAll<HTMLButtonElement>('.abyss-cal-view-btn')].find(
        (button) => button.textContent === 'Week',
      ),
    ).click();
    expect(h.root.querySelector('.abyss-calendar-date')?.getAttribute('data-calendar-date')).toBe(
      start,
    );
    expect(h.mode.captureDate()).toBe('2026-11-01');
    h.click('.abyss-cal-nav-btn[aria-label="Next"]');
    expect(h.root.querySelector('.abyss-calendar-date')?.getAttribute('data-calendar-date')).toBe(
      next,
    );
    expect(h.mode.captureDate()).toBe(next);
  },
);

it('routes actual root, child and forecast agenda actions through canonical owners', async () => {
  const adapt = vi.spyOn(calendarOccurrences, 'taskSnapshotForCalendarOccurrence');
  const parent = task({ title: 'Parent', planning: { due: '2026-10-16' } });
  const branch = subtask({
    title: 'Undated branch',
    ref: { parent: { type: 'task', ref: parent.ref }, relativeLine: 1 },
  });
  const child = subtask({
    title: 'Dated child',
    planning: { due: '2026-10-16' },
    ref: { parent: { type: 'subtask', ref: branch.ref }, relativeLine: 2 },
  });
  const root = task({ ...parent, subtasks: [{ ...branch, subtasks: [child] }] });
  const repeating = task({
    title: 'Repeating',
    source: { line: 8 },
    recurrence: 'every day',
    planning: { due: '2026-10-15' },
  });
  const recurringSource = {
    root: repeating,
    node: repeating,
    target: { type: 'task' as const, ref: repeating.ref },
  };
  const h = harness({
    forCalendarProjection: () => ({
      materialized: [
        { root, node: root, target: { type: 'task', ref: root.ref } },
        { root, node: child, target: { type: 'subtask', ref: child.ref } },
      ],
      recurringSources: [recurringSource],
    }),
  });
  vi.spyOn(h.root, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 360, 700));
  h.mode['date_abyssPrivate'] = moment('2026-10-01');
  h.mode.render(h.root);
  h.click('.abyss-calendar-date[data-calendar-date="2026-10-16"]');
  const rows = [...h.root.querySelectorAll<HTMLElement>('.abyss-calendar-agenda .abyss-task-card')];
  expect(rows).toHaveLength(3);
  expect(h.root.querySelector('.abyss-calendar-agenda .abyss-task-card-main-row')).not.toBeNull();
  const bottom = expectDefined(h.root.querySelector('.abyss-add-task-bar'));
  expect(
    expectDefined(rows[2]).compareDocumentPosition(bottom) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).not.toBe(0);
  const rootRow = expectDefined(
    rows.find((row) => row.querySelector('.abyss-task-title')?.textContent === 'Parent'),
  );
  expect(adapt).not.toHaveBeenCalled();
  rootRow.click();
  expect(adapt).toHaveBeenCalledOnce();
  expect(h.host.openTask).toHaveBeenLastCalledWith(root, { type: 'task', ref: root.ref });
  expectDefined(rootRow.querySelector<HTMLElement>('[role=checkbox]')).click();
  expect(h.cards.toggleTask).toHaveBeenCalledWith(root, { kind: 'allowed' });
  const childRow = expectDefined(rows.find((row) => row.textContent.includes('Dated child')));
  childRow.click();
  expect(adapt).toHaveBeenCalledTimes(2);
  const activated = adapt.mock.results[1];
  assert(activated?.type === 'return');
  expect(calendarOccurrences.calendarOccurrenceForTask(activated.value)?.source).toEqual({
    root,
    node: child,
    target: { type: 'subtask', ref: child.ref },
  });
  expect(h.host.openTask).toHaveBeenLastCalledWith(root, { type: 'subtask', ref: child.ref });
  expectDefined(childRow.querySelector<HTMLElement>('[role="checkbox"]')).click();
  expect(h.cards.toggleTask).toHaveBeenCalledWith(child, { kind: 'allowed' });
  expectDefined(childRow.querySelector<HTMLButtonElement>('.abyss-task-parent-btn')).click();
  await flushMicrotasks();
  expect(h.cards.showTaskInList).toHaveBeenCalledWith(
    { type: 'subtask', ref: branch.ref },
    expect.anything(),
  );
  const forecast = expectDefined(
    rows.find((row) => row.getAttribute('data-occurrence-state') === 'forecast'),
  );
  forecast.click();
  expect(adapt).toHaveBeenCalledTimes(2);
  expect(h.host.openForecastTask).toHaveBeenCalledWith(recurringSource, '2026-10-16');
  forecast.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  expect(h.host.openForecastRecurrenceEditor).not.toHaveBeenCalled();
  expectDefined(document.querySelector<HTMLElement>('.abyss-forecast-context-menu button')).click();
  expect(h.host.openForecastRecurrenceEditor).toHaveBeenCalledWith(forecast, recurringSource);
  expect(rootRow.querySelector('.abyss-task-title-row .abyss-task-count-badge')).not.toBeNull();
  expect(rootRow.querySelector('.abyss-calendar-details')).toBeNull();
  expect(rootRow.querySelector('.abyss-calendar-agenda-context')).toBeNull();
});

it('moves forecast menu ownership with a calendar mounted in another document', () => {
  const root = task({ recurrence: 'every day', planning: { due: '2026-10-15' } });
  const source = { root, node: root, target: { type: 'task' as const, ref: root.ref } };
  const h = harness({
    forCalendarProjection: () => ({ materialized: [], recurringSources: [source] }),
  });
  h.mode['date_abyssPrivate'] = moment('2026-10-01');
  h.mode.render(h.root);
  const other = document.implementation.createHTMLDocument();
  other.body.append(h.root);
  h.mode.render(h.root);
  expectDefined(h.root.querySelector<HTMLElement>('.abyss-calendar-item')).dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
  );
  expect(other.querySelector('.abyss-forecast-context-menu')).not.toBeNull();
  expect(document.querySelector('.abyss-forecast-context-menu')).toBeNull();
});

it('retains the current month on repeated Month navigation and applies period-step fallback', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 16, 12));
  try {
    const h = harness();
    vi.spyOn(h.root, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 360, 700));
    h.mode.render(h.root);
    h.click('.abyss-calendar-date[data-calendar-date="2026-11-01"]');
    h.mode.setView('month');
    h.mode.render(h.root);
    expect(h.date()).toBe('2026-10-01');
    expect(h.mode.captureDate()).toBe('2026-11-01');
    h.click('.abyss-cal-nav-btn[aria-label="Next"]');
    expect(h.date()).toBe('2026-11-01');
    expect(h.mode.captureDate()).toBe('2026-11-01');
    h.click('.abyss-cal-nav-btn[aria-label="Previous"]');
    expect(h.mode.captureDate()).toBe('2026-10-16');
    h.click('.abyss-calendar-date[data-calendar-date="2026-11-01"]');
    h.click('.abyss-cal-nav-today');
    expect(h.mode.captureDate()).toBe('2026-10-16');
  } finally {
    vi.useRealTimers();
  }
});

// Literal starts and locale week numbers are independent of the production date helpers.
it.each([
  {
    firstDay: 0,
    october: '2026-10-18',
    octoberWeek: 43,
    december: '2026-12-27',
    decemberWeek: 1,
    january: '2026-12-27',
    januaryWeek: 1,
  },
  {
    firstDay: 1,
    october: '2026-10-12',
    octoberWeek: 42,
    december: '2026-12-28',
    decemberWeek: 1,
    january: '2026-12-28',
    januaryWeek: 1,
  },
  {
    firstDay: 2,
    october: '2026-10-13',
    octoberWeek: 42,
    december: '2026-12-29',
    decemberWeek: 1,
    january: '2026-12-29',
    januaryWeek: 1,
  },
  {
    firstDay: 3,
    october: '2026-10-14',
    octoberWeek: 42,
    december: '2026-12-30',
    decemberWeek: 1,
    january: '2026-12-30',
    januaryWeek: 1,
  },
  {
    firstDay: 4,
    october: '2026-10-15',
    octoberWeek: 42,
    december: '2026-12-31',
    decemberWeek: 1,
    january: '2026-12-31',
    januaryWeek: 1,
  },
  {
    firstDay: 5,
    october: '2026-10-16',
    octoberWeek: 42,
    december: '2026-12-25',
    decemberWeek: 52,
    january: '2027-01-01',
    januaryWeek: 1,
  },
  {
    firstDay: 6,
    october: '2026-10-17',
    octoberWeek: 42,
    december: '2026-12-26',
    decemberWeek: 52,
    january: '2026-12-26',
    januaryWeek: 52,
  },
] as const)(
  'labels the rendered configured week while the picker keeps calendar year ($firstDay)',
  (fixture) => {
    for (const [anchor, start, week] of [
      ['2026-10-18', fixture.october, fixture.octoberWeek],
      ['2026-12-31', fixture.december, fixture.decemberWeek],
      ['2027-01-01', fixture.january, fixture.januaryWeek],
    ] as const) {
      const h = harness({}, fixture.firstDay);
      vi.spyOn(h.root, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 360, 700));
      h.mode['date_abyssPrivate'] = moment(anchor).date(1);
      h.mode.render(h.root);
      h.click(`.abyss-calendar-date[data-calendar-date="${anchor}"]`);
      h.mode.setView('week');
      h.mode.render(h.root);
      expect(h.date()).toBe(anchor);
      expect(h.mode.captureDate()).toBe(anchor);
      expect(h.root.querySelector('.abyss-calendar-date')?.getAttribute('data-calendar-date')).toBe(
        start,
      );
      expect(h.root.querySelector('.abyss-cal-title-full')?.textContent).toBe(`Week ${week}`);
      const year = expectDefined(h.root.querySelector<HTMLElement>('.abyss-cal-nav-year'));
      expect(year.textContent).toBe(anchor.slice(0, 4));
      expect(year.getAttribute('aria-label')).toBe(`Select calendar year, ${anchor.slice(0, 4)}`);
      if (anchor === '2026-10-18') {
        h.click('.abyss-cal-nav-btn[aria-label="Next"]');
        expect(
          h.root.querySelector('.abyss-calendar-date')?.getAttribute('data-calendar-date'),
        ).toBe(moment(start).add(7, 'days').format('YYYY-MM-DD'));
        expect(h.root.querySelector('.abyss-cal-title-full')?.textContent).toBe(`Week ${week + 1}`);
      } else {
        year.click();
        expect(h.root.querySelector('.abyss-year-picker-btn.is-active')?.textContent).toBe(
          anchor.slice(0, 4),
        );
        const followingYear = String(Number(anchor.slice(0, 4)) + 1);
        expectDefined(
          [...h.root.querySelectorAll<HTMLElement>('.abyss-year-picker-btn')].find(
            (button) => button.textContent === followingYear,
          ),
        ).click();
        expect(h.date()).toBe(`${followingYear}-${anchor.slice(5, 7)}-01`);
      }
    }
  },
);

async function activateCalendarDraftNavigation(
  button: HTMLElement,
  input: HTMLInputElement,
  activation: 'focus' | 'pointer' | 'compatibility-mouse',
): Promise<void> {
  if (activation === 'focus') button.focus();
  else {
    button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    if (activation === 'compatibility-mouse') {
      // Native touch focus follows pointer release and compatibility mousedown, after expiry.
      await flushMicrotasks();
      button.dispatchEvent(new Event('pointerup', { bubbles: true }));
      button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    }
    input.dispatchEvent(new FocusEvent('blur', { relatedTarget: null }));
    if (activation === 'compatibility-mouse')
      button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
  }
  button.click();
}
