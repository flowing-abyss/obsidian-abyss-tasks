import type { App } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { moment } from '../src/obsidianMoment';
import { CalendarMode, type CalendarModeHost } from '../src/panels/calendar/CalendarMode';
import type { CalViewType } from '../src/panels/calendar/calendarViewType';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { StatusRegistry } from '../src/status/StatusRegistry';
import type { TaskIndexEvent } from '../src/tasks';
import { noInteractionOwnership } from '../src/ui/interactionOwnership';
import { expectDefined, taskQueryApi, useRealMoment } from './helpers';

useRealMoment();

/** The host calls one mount or patch makes, in order (spec section 4.3). */
const VIEW_UPDATE_CALLS = [
  'dismissRecurrenceEditor',
  'unmountActiveCapture',
  'remountActiveCapture',
  'syncTaskStackSelection',
  'onRenderComplete',
];

interface Harness {
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

function harness(): Harness {
  const calls: string[] = [];
  const note = (name: string): void => {
    calls.push(name);
  };
  const host: CalendarModeHost = {
    rerender: vi.fn(() => {
      note('rerender');
    }),
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
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  const openCalendarView = vi.fn<(view: CalViewType) => void>();
  const state = new AppState();
  state.set('mode', 'calendar');
  const mode = new CalendarMode({
    state,
    app: {} as App,
    settings: DEFAULT_SETTINGS,
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
    expect(h.date()).toBe(moment().startOf('isoWeek').format('YYYY-MM-DD'));
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

  it('a month week button opens that week through the host', () => {
    const h = harness();
    h.mode.render(h.root);
    const button = expectDefined(h.root.querySelector<HTMLElement>('.abyss-mg-week-btn'));
    const week = expectDefined(button.getAttribute('data-week'));
    const year = expectDefined(button.getAttribute('data-year'));
    button.click();
    expect(h.mode.view()).toBe('week');
    // The grid labels weeks with the locale week number and the mode resolves it as an ISO week,
    // exactly as `openCalendarWeek_abyssPrivate` did; the test pins that pairing.
    expect(h.date()).toBe(
      moment()
        .isoWeekYear(Number.parseInt(year, 10))
        .isoWeek(Number.parseInt(week, 10))
        .startOf('isoWeek')
        .format('YYYY-MM-DD'),
    );
    expect(h.host.rerender).toHaveBeenCalledOnce();
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

  it('Today returns the week view to the current ISO week and remounts', () => {
    const h = weekHarness();
    const current = moment().startOf('isoWeek').format('YYYY-MM-DD');
    h.click('.abyss-cal-nav-btn[aria-label="Next"]');
    expect(h.date()).not.toBe(current);
    h.calls.length = 0;
    h.click('.abyss-cal-nav-today');
    expect(h.date()).toBe(current);
    expect(h.calls).toEqual(VIEW_UPDATE_CALLS);
    expect(h.host.rerender).not.toHaveBeenCalled();
  });
});
