import type { App } from 'obsidian';
import type { StatusRegistry } from '../../status/StatusRegistry';
import type { EffectiveTagGroup } from '../../tags/effectiveTagGroups';
import type { LocalDate, TaskPriority, TaskSnapshot } from '../../tasks';
import type { InteractionOwnershipPort } from '../../ui/interactionOwnership';
import type { TaskDependencyLookup } from '../../ui/taskDependencyPresentation';
import type { BaseView } from '../../views/BaseView';
import { MonthGridView } from '../../views/MonthGridView';
import { TodayView } from '../../views/TodayView';
import { WeekTimeGridView } from '../../views/WeekTimeGridView';
import type { CalendarTaskSource } from '../../views/calendarOccurrences';
import type { InteractiveSpanBoundaryTarget, SpanMoveTarget } from '../../views/spanInteractions';
import type { TimedDragTarget, TimedVerticalResizeTarget } from '../../views/timegrid/dragGeometry';
import type { ForecastContextMenuOwner } from '../../views/timegrid/renderTaskMeta';
import type { TimedBlockKeyboardIntent } from '../../views/timegrid/renderTimedBlocks';
import type { TimedBoundaryTarget } from '../../views/timegrid/timedInteractions';
import type { CalViewType } from './calendarViewType';

/** Everything a calendar view can ask the controller to do. Built once per calendar render. */
export interface CalendarHandlers {
  readonly onTaskClick: (task: TaskSnapshot) => void;
  readonly onTaskSelect: (task: TaskSnapshot) => void;
  readonly onForecastClick: (source: CalendarTaskSource, referenceDate: LocalDate) => void;
  readonly onForecastContextMenu: (source: CalendarTaskSource) => void;
  readonly onDrop: (dragData: string, targetDate: string) => void;
  readonly onDropTime: (dragData: string, date: string, time: string) => void;
  readonly onCreateAtTime: (date: string, time: string) => void;
  readonly onCreateAtDate: (date: string) => void;
  readonly onCreateAtDateAllDay: (date: string) => void;
  readonly onTimeChange: (task: TaskSnapshot, minutes: number) => void;
  readonly onDurationChange: (task: TaskSnapshot, minutes: number) => void;
  readonly onTimedMove: (task: TaskSnapshot, target: TimedDragTarget) => void;
  readonly onTimedDuration: (task: TaskSnapshot, target: TimedVerticalResizeTarget) => void;
  readonly onTimedBoundary: (task: TaskSnapshot, target: TimedBoundaryTarget) => void;
  readonly onSpanMove: (task: TaskSnapshot, target: SpanMoveTarget) => void;
  readonly onSpanBoundary: (task: TaskSnapshot, target: InteractiveSpanBoundaryTarget) => void;
  readonly onStartChange: (task: TaskSnapshot, start: string) => void;
  readonly onDueChange: (task: TaskSnapshot, due: string) => void;
  readonly onExtendToSpan: (task: TaskSnapshot, due: string) => void;
  readonly onKeyboardIntent: (task: TaskSnapshot, intent: TimedBlockKeyboardIntent) => void;
  readonly onToggle: (task: TaskSnapshot) => void;
  readonly onSetStatus: (task: TaskSnapshot, status: string) => void;
  readonly onSetPriority: (task: TaskSnapshot, priority: TaskPriority) => void;
}

export interface CalendarViewDependencies {
  readonly app: App;
  readonly statusRegistry: StatusRegistry;
  readonly interactionOwnership: InteractionOwnershipPort;
  readonly dependenciesFor: TaskDependencyLookup;
  /** Read once per view creation: tag colours follow settings and vault tags on every mount. */
  readonly tagGroups: () => readonly EffectiveTagGroup[];
  readonly forecastMenuOwner: ForecastContextMenuOwner;
}

export interface CalendarViewNavigation {
  readonly openDay: (date: string) => void;
  readonly openWeek: (week: string, year: string) => void;
}

/** The structural contract the controller drives: render, patch, destroy. */
export type CalendarViewInstance = BaseView;

function createTodayView(deps: CalendarViewDependencies, handlers: CalendarHandlers): TodayView {
  return new TodayView({
    app: deps.app,
    forecastMenuOwner: deps.forecastMenuOwner,
    onTaskClick: handlers.onTaskClick,
    onTaskSelect: handlers.onTaskSelect,
    onForecastClick: handlers.onForecastClick,
    onForecastContextMenu: handlers.onForecastContextMenu,
    onDrop: handlers.onDrop,
    onDropTime: handlers.onDropTime,
    onCreateAtTime: handlers.onCreateAtTime,
    onCreateAtDate: handlers.onCreateAtDateAllDay,
    onTimeChange: handlers.onTimeChange,
    onDurationChange: handlers.onDurationChange,
    onTimedMove: handlers.onTimedMove,
    onTimedDuration: handlers.onTimedDuration,
    onTimedBoundary: handlers.onTimedBoundary,
    onSpanMove: handlers.onSpanMove,
    onSpanBoundary: handlers.onSpanBoundary,
    onStartChange: handlers.onStartChange,
    onDueChange: handlers.onDueChange,
    onExtendToSpan: handlers.onExtendToSpan,
    onKeyboardIntent: handlers.onKeyboardIntent,
    onToggle: handlers.onToggle,
    dependenciesFor: deps.dependenciesFor,
    onSetStatus: handlers.onSetStatus,
    onSetPriority: handlers.onSetPriority,
    interactionOwnership: deps.interactionOwnership,
    statusRegistry: deps.statusRegistry,
    tagGroups: [...deps.tagGroups()],
  });
}

function createWeekView(
  deps: CalendarViewDependencies,
  handlers: CalendarHandlers,
  navigation: CalendarViewNavigation,
): WeekTimeGridView {
  return new WeekTimeGridView({
    app: deps.app,
    forecastMenuOwner: deps.forecastMenuOwner,
    onTaskClick: handlers.onTaskClick,
    onTaskSelect: handlers.onTaskSelect,
    onForecastClick: handlers.onForecastClick,
    onForecastContextMenu: handlers.onForecastContextMenu,
    onDrop: handlers.onDrop,
    onDropTime: handlers.onDropTime,
    onCreateAtTime: handlers.onCreateAtTime,
    onCreateAtDate: handlers.onCreateAtDateAllDay,
    onDayHeaderClick: (date) => {
      navigation.openDay(date);
    },
    onTimeChange: handlers.onTimeChange,
    onDurationChange: handlers.onDurationChange,
    onTimedMove: handlers.onTimedMove,
    onTimedDuration: handlers.onTimedDuration,
    onTimedBoundary: handlers.onTimedBoundary,
    onSpanMove: handlers.onSpanMove,
    onSpanBoundary: handlers.onSpanBoundary,
    onStartChange: handlers.onStartChange,
    onDueChange: handlers.onDueChange,
    onExtendToSpan: handlers.onExtendToSpan,
    onKeyboardIntent: handlers.onKeyboardIntent,
    onToggle: handlers.onToggle,
    dependenciesFor: deps.dependenciesFor,
    onSetStatus: handlers.onSetStatus,
    onSetPriority: handlers.onSetPriority,
    interactionOwnership: deps.interactionOwnership,
    statusRegistry: deps.statusRegistry,
    tagGroups: [...deps.tagGroups()],
  });
}

function createMonthView(
  deps: CalendarViewDependencies,
  handlers: CalendarHandlers,
  navigation: CalendarViewNavigation,
): MonthGridView {
  return new MonthGridView({
    app: deps.app,
    forecastMenuOwner: deps.forecastMenuOwner,
    onDayClick: (date) => {
      navigation.openDay(date);
    },
    onCreateAtDate: handlers.onCreateAtDate,
    onTaskClick: handlers.onTaskClick,
    onTaskSelect: handlers.onTaskSelect,
    onForecastClick: handlers.onForecastClick,
    onForecastContextMenu: handlers.onForecastContextMenu,
    onDrop: handlers.onDrop,
    onSpanMove: handlers.onSpanMove,
    onSpanBoundary: handlers.onSpanBoundary,
    onToggle: handlers.onToggle,
    dependenciesFor: deps.dependenciesFor,
    onSetStatus: handlers.onSetStatus,
    onSetPriority: handlers.onSetPriority,
    onWeekClick: (week, year) => {
      navigation.openWeek(week, year);
    },
    interactionOwnership: deps.interactionOwnership,
    statusRegistry: deps.statusRegistry,
    tagGroups: [...deps.tagGroups()],
  });
}

/**
 * The single place that maps the controller's handler set onto the three view classes. A phone
 * presentation later branches here on a policy input; the controller does not change.
 */
export function createCalendarView(
  view: CalViewType,
  deps: CalendarViewDependencies,
  handlers: CalendarHandlers,
  navigation: CalendarViewNavigation,
): CalendarViewInstance {
  if (view === 'today') return createTodayView(deps, handlers);
  if (view === 'week') return createWeekView(deps, handlers, navigation);
  return createMonthView(deps, handlers, navigation);
}
