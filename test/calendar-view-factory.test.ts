// @vitest-environment node
import type { App } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import {
  createCalendarView,
  type CalendarHandlers,
  type CalendarViewDependencies,
} from '../src/panels/calendar/calendarViewFactory';
import type { EffectiveTagGroup } from '../src/tags/effectiveTagGroups';
import { noInteractionOwnership } from '../src/ui/interactionOwnership';
import { MonthGridView, type MonthGridViewCallbacks } from '../src/views/MonthGridView';
import { TodayView, type TimeGridCallbacks } from '../src/views/TodayView';
import { WeekTimeGridView } from '../src/views/WeekTimeGridView';
import { testStatusRegistry } from './helpers';

const HANDLER_NAMES = [
  'onTaskClick',
  'onTaskSelect',
  'onForecastClick',
  'onForecastContextMenu',
  'onDrop',
  'onDropTime',
  'onCreateAtTime',
  'onCreateAtDate',
  'onCreateAtDateAllDay',
  'onTimeChange',
  'onDurationChange',
  'onTimedMove',
  'onTimedDuration',
  'onTimedBoundary',
  'onSpanMove',
  'onSpanBoundary',
  'onStartChange',
  'onDueChange',
  'onExtendToSpan',
  'onKeyboardIntent',
  'onToggle',
  'onSetStatus',
  'onSetPriority',
] as const satisfies ReadonlyArray<keyof CalendarHandlers>;

function handlers(): CalendarHandlers {
  return Object.fromEntries(
    HANDLER_NAMES.map((name) => [name, vi.fn()]),
  ) as unknown as CalendarHandlers;
}

function deps(groups: readonly EffectiveTagGroup[] = []): CalendarViewDependencies & {
  tagGroups: ReturnType<typeof vi.fn<() => readonly EffectiveTagGroup[]>>;
} {
  return {
    app: {} as App,
    statusRegistry: testStatusRegistry(),
    interactionOwnership: noInteractionOwnership,
    dependenciesFor: () => undefined,
    tagGroups: vi.fn(() => groups),
    forecastMenuOwner: { open: vi.fn(), dismiss: vi.fn() },
  };
}

function timeGridCallbacks(view: object): TimeGridCallbacks {
  return (view as { callbacks: TimeGridCallbacks }).callbacks;
}

function monthCallbacks(view: object): MonthGridViewCallbacks {
  return (view as { callbacks: MonthGridViewCallbacks }).callbacks;
}

describe('createCalendarView', () => {
  const navigation = { openDay: vi.fn(), openWeek: vi.fn() };

  it('creates the view class for each view type', () => {
    const d = deps();
    const h = handlers();
    expect(createCalendarView('today', d, h, navigation)).toBeInstanceOf(TodayView);
    expect(createCalendarView('week', d, h, navigation)).toBeInstanceOf(WeekTimeGridView);
    expect(createCalendarView('month', d, h, navigation)).toBeInstanceOf(MonthGridView);
  });

  it('passes the handler functions through by identity for the time grids', () => {
    const d = deps();
    const h = handlers();
    for (const view of ['today', 'week'] as const) {
      const callbacks = timeGridCallbacks(createCalendarView(view, d, h, navigation));
      for (const name of HANDLER_NAMES) {
        if (name === 'onCreateAtDate' || name === 'onCreateAtDateAllDay') continue;
        expect(callbacks[name as keyof TimeGridCallbacks], `${view} ${name}`).toBe(h[name]);
      }
      expect(callbacks.onCreateAtDate).toBe(h.onCreateAtDateAllDay);
      expect(callbacks.app).toBe(d.app);
      expect(callbacks.statusRegistry).toBe(d.statusRegistry);
      expect(callbacks.interactionOwnership).toBe(d.interactionOwnership);
      expect(callbacks.dependenciesFor).toBe(d.dependenciesFor);
      expect(callbacks.forecastMenuOwner).toBe(d.forecastMenuOwner);
    }
  });

  it('wires the day header only for the week grid', () => {
    const d = deps();
    const h = handlers();
    expect(
      timeGridCallbacks(createCalendarView('today', d, h, navigation)).onDayHeaderClick,
    ).toBeUndefined();
    const week = timeGridCallbacks(createCalendarView('week', d, h, navigation));
    week.onDayHeaderClick?.('2026-09-23');
    expect(navigation.openDay).toHaveBeenCalledWith('2026-09-23');
  });

  it('wires the month grid with day and week drill-down and no timed handlers', () => {
    const d = deps();
    const h = handlers();
    const month = monthCallbacks(createCalendarView('month', d, h, navigation));
    month.onDayClick('2026-09-23');
    expect(navigation.openDay).toHaveBeenLastCalledWith('2026-09-23');
    month.onWeekClick('39', '2026');
    expect(navigation.openWeek).toHaveBeenCalledWith('39', '2026');
    expect(month.onCreateAtDate).toBe(h.onCreateAtDate);
    for (const name of [
      'onTaskClick',
      'onTaskSelect',
      'onForecastClick',
      'onForecastContextMenu',
      'onDrop',
      'onSpanMove',
      'onSpanBoundary',
      'onToggle',
      'onSetStatus',
      'onSetPriority',
    ] as const) {
      expect(month[name], name).toBe(h[name]);
    }
    expect('onTimedMove' in month).toBe(false);
    expect('onKeyboardIntent' in month).toBe(false);
  });

  it('reads the tag groups once per view and hands each view its own copy', () => {
    const groups: EffectiveTagGroup[] = [];
    const d = deps(groups);
    const h = handlers();
    const view = createCalendarView('week', d, h, navigation);
    expect(d.tagGroups).toHaveBeenCalledOnce();
    const passed = timeGridCallbacks(view).tagGroups;
    expect(passed).toEqual(groups);
    expect(passed).not.toBe(groups);
  });
});
