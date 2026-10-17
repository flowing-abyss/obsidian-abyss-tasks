// @vitest-environment node
import { Platform, type App } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import {
  createCalendarView,
  type CalendarHandlers,
  type CalendarViewDependencies,
  type CalendarViewInstance,
} from '../src/panels/calendar/calendarViewFactory';
import type { EffectiveTagGroup } from '../src/tags/effectiveTagGroups';
import { localDate } from '../src/tasks';
import { noInteractionOwnership } from '../src/ui/interactionOwnership';
import { MonthGridView, type MonthGridViewCallbacks } from '../src/views/MonthGridView';
import { TodayView, type TimeGridCallbacks } from '../src/views/TodayView';
import { WeekTimeGridView } from '../src/views/WeekTimeGridView';
import * as calendarOccurrences from '../src/views/calendarOccurrences';
import { expectDefined, subtask, task, testStatusRegistry } from './helpers';

const HANDLER_NAMES = [
  'onTaskClick',
  'onTaskSelect',
  'onShowParent',
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
    mountAgendaEntry: vi.fn(),
    statusRegistry: testStatusRegistry(),
    interactionOwnership: noInteractionOwnership,
    dependenciesFor: () => undefined,
    tagGroups: vi.fn(() => groups),
    forecastMenuOwner: { open: vi.fn(), dismiss: vi.fn() },
  };
}

const config = { firstDayOfWeek: 1, startPosition: '2026-10-16' } as const;
const container = {} as HTMLElement;

function timeGridCallbacks(view: CalendarViewInstance): TimeGridCallbacks {
  const today = vi.spyOn(TodayView.prototype, 'render').mockImplementation(() => {});
  const week = vi.spyOn(WeekTimeGridView.prototype, 'render').mockImplementation(() => {});
  view.render(container, [], config);
  const instance = expectDefined(today.mock.contexts[0] ?? week.mock.contexts[0]);
  today.mockRestore();
  week.mockRestore();
  if (instance instanceof TodayView) return instance['callbacks'];
  if (instance instanceof WeekTimeGridView) return instance['callbacks'];
  throw new Error('Expected a full time-grid instance');
}

function monthCallbacks(view: CalendarViewInstance): MonthGridViewCallbacks {
  const render = vi.spyOn(MonthGridView.prototype, 'render').mockImplementation(() => {});
  view.render(container, [], config);
  const instance = expectDefined(render.mock.contexts[0]);
  render.mockRestore();
  if (!(instance instanceof MonthGridView)) throw new Error('Expected a month-grid instance');
  return instance['callbacks'];
}

describe('createCalendarView', () => {
  const navigation = { openDay: vi.fn(), openWeek: vi.fn() };

  it.each([true, false])('supplies body activation only for mobile Day (%s)', (mobile) => {
    vi.spyOn(Platform, 'isMobile', 'get').mockReturnValue(mobile);
    const h = handlers();
    expect(
      timeGridCallbacks(createCalendarView('today', deps(), h, navigation)).onTaskActivate,
    ).toBe(mobile ? h.onTaskClick : undefined);
    expect(
      timeGridCallbacks(createCalendarView('week', deps(), h, navigation)).onTaskActivate,
    ).toBeUndefined();
  });

  it.each([
    ['today', TodayView],
    ['week', WeekTimeGridView],
    ['month', MonthGridView],
  ] as const)(
    'adapts %s render/patch occurrences and delegates every lifecycle argument',
    (type, View) => {
      const parent = task({ title: 'Parent' });
      const child = subtask({
        title: 'Exact child',
        planning: { due: '2026-10-16', time: '09:30' },
        ref: { parent: { type: 'task', ref: parent.ref }, relativeLine: 2 },
      });
      const root = task({ ...parent, subtasks: [child] });
      const childSource = {
        root,
        node: child,
        target: { type: 'subtask' as const, ref: child.ref },
      };
      const repeat = task({
        title: 'Forecast',
        recurrence: 'every day',
        planning: { due: '2026-10-15' },
      });
      const forecastSource = {
        root: repeat,
        node: repeat,
        target: { type: 'task' as const, ref: repeat.ref },
      };
      const occurrences = calendarOccurrences.projectCalendarOccurrences(
        { materialized: [childSource], recurringSources: [forecastSource] },
        { from: localDate('2026-10-16'), to: localDate('2026-10-16') },
        { removeScheduledDate: false },
      ).occurrences;
      expect(occurrences).toHaveLength(2);
      const render = vi.spyOn(View.prototype, 'render').mockImplementation(() => {});
      const patch = vi.spyOn(View.prototype, 'patch').mockImplementation(() => {});
      const destroy = vi.spyOn(View.prototype, 'destroy').mockImplementation(() => {});
      const adapt = vi.spyOn(calendarOccurrences, 'taskSnapshotForCalendarOccurrence');
      const view = createCalendarView(type, deps(), handlers(), navigation);
      expect(adapt).not.toHaveBeenCalled();
      view.render(container, occurrences, config, false, 317);
      expect(render).toHaveBeenCalledOnce();
      const snapshots = expectDefined(render.mock.calls[0]?.[1]);
      expect(render.mock.calls[0]).toEqual([container, snapshots, config, false, 317]);
      expect(adapt).toHaveBeenCalledTimes(2);
      expect(snapshots.map(calendarOccurrences.calendarOccurrenceForTask)).toEqual(occurrences);
      for (const [index, occurrence] of occurrences.entries()) {
        const snapshot = expectDefined(snapshots[index]);
        expect(calendarOccurrences.calendarOccurrenceForTask(snapshot)).toBe(occurrence);
        expect(snapshot.title).toBe(occurrence.source.node.title);
        expect(snapshot.planning).toEqual(occurrence.planning);
        expect(snapshot.ref).toBe(occurrence.source.root.ref);
      }
      expect(snapshots.find((snapshot) => snapshot.title === 'Exact child')?.planning).toEqual({
        due: '2026-10-16',
        time: '09:30',
      });
      view.patch(container, occurrences, config);
      expect(adapt).toHaveBeenCalledTimes(4);
      expect(patch).toHaveBeenCalledOnce();
      const updated = expectDefined(patch.mock.calls[0]?.[1]);
      expect(patch.mock.calls[0]).toEqual([container, updated, config]);
      for (const [index, occurrence] of occurrences.entries())
        expect(calendarOccurrences.calendarOccurrenceForTask(expectDefined(updated[index]))).toBe(
          occurrence,
        );
      expect(updated[0]).not.toBe(snapshots[0]);
      view.destroy();
      expect(destroy).toHaveBeenCalledOnce();
      expect(render.mock.contexts[0]).toBe(patch.mock.contexts[0]);
      expect(render.mock.contexts[0]).toBe(destroy.mock.contexts[0]);
    },
  );

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
    month.onWeekClick('2026-12-28');
    expect(navigation.openWeek).toHaveBeenCalledWith('2026-12-28');
    expect(month.onCreateAtDate).toBe(h.onCreateAtDate);
    for (const name of [
      'onTaskClick',
      'onTaskSelect',
      'onShowParent',
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
