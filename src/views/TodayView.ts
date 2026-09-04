import { Component, type App } from 'obsidian';
import type { ResolvedConfig, TagGroup } from '../settings/types';
import type { StatusRegistry } from '../status/StatusRegistry';
import type { TaskPriority, TaskSnapshot } from '../tasks';
import { BaseView } from './BaseView';
import { calendarTaskWithPlanning } from './calendarOccurrences';
import {
  createSpanInteractionOwner,
  type InteractiveSpanBoundaryTarget,
  type SpanMoveTarget,
} from './spanInteractions';
import { layoutVisibleSpans, layoutVisibleSpansWithReplacement } from './spanLayout';
import type { TimedDragTarget, TimedVerticalResizeTarget } from './timegrid/dragGeometry';
import { renderHourGrid, repositionNowLine, type HourGridHandles } from './timegrid/HourGrid';
import {
  layoutTimedDay,
  minutesToPixels,
  taskLayoutIdentity,
  type PositionedBlock,
} from './timegrid/layout';
import {
  renderAllDayCell,
  renderAllDaySpanLayer,
  type AllDayCallbacks,
} from './timegrid/renderAllDay';
import {
  calendarOccurrenceLookup,
  type ForecastInteractionCallbacks,
} from './timegrid/renderTaskMeta';
import {
  renderTimedBlocksForDay,
  toTimedBlockInputs,
  type TimedBlockCallbacks,
  type TimedBlockKeyboardIntent,
} from './timegrid/renderTimedBlocks';
import type { TimedBoundaryTarget } from './timegrid/timedInteractions';
import { createTimedInteractionOwner } from './timegrid/timedInteractions';

export interface TimeGridCallbacks extends ForecastInteractionCallbacks {
  app: App;
  onTaskClick: (task: TaskSnapshot) => void;
  onDrop: (dragData: string, targetDate: string) => void;
  onDropTime: (dragData: string, date: string, time: string) => void;
  onCreateAtTime: (date: string, time: string) => void;
  /** Click-to-create in the all-day/"no-time" row above the hour grid. Optional, mirroring the
   * hour grid's onCreateAtTime — threaded through to AllDayCallbacks by both TodayView and
   * WeekTimeGridView. */
  onCreateAtDate?: (date: string) => void;
  /** Header-cell click (Week's day headers): drills into the Day view for that date, same as
   * Month's onDayClick. Optional since TodayView itself has no need to re-drill into itself. */
  onDayHeaderClick?: (date: string) => void;
  onKeyboardIntent: (task: TaskSnapshot, intent: TimedBlockKeyboardIntent) => void;
  onTimeChange: (task: TaskSnapshot, newStartMinutes: number) => void;
  onDurationChange: (task: TaskSnapshot, newDurationMinutes: number) => void;
  onTimedMove?: (task: TaskSnapshot, target: TimedDragTarget) => void;
  onTimedDuration?: (task: TaskSnapshot, target: TimedVerticalResizeTarget) => void;
  onTimedBoundary?: (task: TaskSnapshot, target: TimedBoundaryTarget) => void;
  onSpanMove?: (task: TaskSnapshot, target: SpanMoveTarget) => void;
  onSpanBoundary?: (task: TaskSnapshot, target: InteractiveSpanBoundaryTarget) => void;
  onStartChange: (task: TaskSnapshot, newStart: string) => void;
  onDueChange: (task: TaskSnapshot, newDue: string) => void;
  onExtendToSpan: (task: TaskSnapshot, newDue: string) => void;
  onToggle: (task: TaskSnapshot) => void;
  onSetStatus: (task: TaskSnapshot, status: string) => void;
  onSetPriority: (task: TaskSnapshot, priority: TaskPriority) => void;
  statusRegistry: StatusRegistry;
  tagGroups?: TagGroup[];
}

interface DateTaskBuckets {
  readonly timed: TaskSnapshot[];
  readonly spans: TaskSnapshot[];
  readonly timedSpans: TaskSnapshot[];
  readonly plain: TaskSnapshot[];
  readonly deadlines: TaskSnapshot[];
}

interface TodayAllDayContext {
  readonly date: string;
  readonly day: HourGridHandles['days'][number];
  readonly buckets: DateTaskBuckets;
  readonly callbacks: AllDayCallbacks;
  readonly tagGroups: TagGroup[];
  readonly spanRow: ReturnType<typeof layoutVisibleSpans>['rows'][number];
  readonly installCellBindings: boolean;
}

function taskSourceIdentity(task: TaskSnapshot): string {
  return `${task.source.filePath}:::${task.source.line}`;
}

function classifyTaskForDate(
  task: TaskSnapshot,
  date: string,
  buckets: DateTaskBuckets,
  spanIdentities: Set<string>,
): void {
  const { start, due, time, scheduled } = task.planning;
  if (start !== undefined && due !== undefined) {
    if (!window.moment(date).isBetween(start, due, 'day', '[]')) return;
    (time === undefined ? buckets.spans : buckets.timedSpans).push(task);
    spanIdentities.add(taskSourceIdentity(task));
    return;
  }
  if (String(scheduled ?? due) !== date) return;
  (time === undefined ? buckets.plain : buckets.timed).push(task);
}

function isDistinctDeadline(task: TaskSnapshot, date: string): boolean {
  const { due, scheduled } = task.planning;
  return String(due) === date && scheduled !== undefined && scheduled !== due;
}

/**
 * Bucket tasks for a single date per the due-centric anchor rule (spec: due-centric contract).
 *
 * `timedSpans`: a multi-day span (`start` && `due`) that additionally has a `time` is kept
 * separate from untimed `spans`. Consumers place every visible timed segment into the same
 * hour-grid overlap pass. The due segment alone owns the marker/rich title; continuation roots
 * keep the same move, duration, keyboard, focus, and identity contract.
 */
export function bucketTasksForDate(tasks: TaskSnapshot[], date: string): DateTaskBuckets {
  const buckets: DateTaskBuckets = {
    timed: [],
    spans: [],
    timedSpans: [],
    plain: [],
    deadlines: [],
  };
  const spanIdentities = new Set<string>();
  for (const task of tasks) classifyTaskForDate(task, date, buckets, spanIdentities);
  for (const task of tasks) {
    if (!spanIdentities.has(taskSourceIdentity(task)) && isDistinctDeadline(task, date)) {
      buckets.deadlines.push(task);
    }
  }
  return buckets;
}

export function previewTimedPositionFor(
  tasks: readonly TaskSnapshot[],
  source: TaskSnapshot,
  planning: TaskSnapshot['planning'],
  date: string,
): PositionedBlock | undefined {
  const identity = taskLayoutIdentity(source);
  const prospectiveTasks = tasks.map((candidate) =>
    taskLayoutIdentity(candidate) === identity
      ? calendarTaskWithPlanning(candidate, planning)
      : candidate,
  );
  const { timed, timedSpans } = bucketTasksForDate(prospectiveTasks, date);
  return layoutTimedDay(toTimedBlockInputs([...timed, ...timedSpans])).positioned.find(
    (positioned) => taskLayoutIdentity(positioned.task) === identity,
  );
}

/** How often the now-line is repositioned while a Today/Week view showing today stays mounted. */
export const NOW_LINE_REFRESH_MS = 5 * 60 * 1000;

export class TodayView extends BaseView {
  private containerEl: HTMLElement | null = null;
  private skeletonKey: string | null = null;
  private gridHandles: HourGridHandles | null = null;
  private md = new Component();
  private nowLineIntervalId: number | null = null;
  private readonly timedInteractions = createTimedInteractionOwner();
  private readonly spanInteractions = createSpanInteractionOwner();

  constructor(private readonly callbacks: TimeGridCallbacks) {
    super();
  }

  render(
    container: HTMLElement,
    tasks: TaskSnapshot[],
    config: ResolvedConfig,
    ...options: [shouldScrollToNow?: boolean, preservedScrollTop?: number]
  ): void {
    const [shouldScrollToNow = true, preservedScrollTop] = options;
    this.timedInteractions.disposeActive();
    this.spanInteractions.disposeActive();
    this.md.unload();
    this.md = new Component();
    this.md.load();

    // A re-render on the same instance (e.g. config change) must not stack a second interval
    // on top of one already registered from a prior render() without an intervening destroy().
    this.clearNowLineInterval();

    this.containerEl = container;
    const date =
      config.startPosition.length > 0 ? config.startPosition : window.moment().format('YYYY-MM-DD');
    this.skeletonKey = this.buildSkeletonKey(date);

    const handles = renderHourGrid(
      container,
      [date],
      this.callbacks.onDropTime,
      this.callbacks.onCreateAtTime,
      this.callbacks.onDayHeaderClick,
    );
    this.gridHandles = handles;
    this.renderTaskLayers(tasks, date, handles, true);

    const isToday = date === window.moment().format('YYYY-MM-DD');
    this.scheduleInitialScroll(handles.gridRowEl, isToday, shouldScrollToNow, preservedScrollTop);
    this.startNowLineRefresh(isToday ? handles.nowLineEl : null);
  }

  private clearNowLineInterval(): void {
    if (this.nowLineIntervalId === null) return;
    window.clearInterval(this.nowLineIntervalId);
    this.nowLineIntervalId = null;
  }

  private scheduleInitialScroll(
    grid: HTMLElement,
    isToday: boolean,
    shouldScrollToNow: boolean,
    preservedScrollTop: number | undefined,
  ): void {
    if (shouldScrollToNow && isToday) {
      const nowMinutes = window.moment().hours() * 60 + window.moment().minutes();
      const nowPx = minutesToPixels(nowMinutes);
      window.setTimeout(() => {
        grid.scrollTop = Math.max(0, nowPx - grid.clientHeight / 2);
      }, 0);
      return;
    }
    if (!shouldScrollToNow && preservedScrollTop !== undefined) {
      window.setTimeout(() => {
        grid.scrollTop = preservedScrollTop;
      }, 0);
    }
  }

  private startNowLineRefresh(nowLine: HTMLElement | null): void {
    if (nowLine === null) return;
    this.nowLineIntervalId = window.setInterval(() => {
      repositionNowLine(nowLine);
    }, NOW_LINE_REFRESH_MS);
  }

  override patch(container: HTMLElement, tasks: TaskSnapshot[], config: ResolvedConfig): void {
    const date =
      config.startPosition.length > 0 ? config.startPosition : window.moment().format('YYYY-MM-DD');
    if (
      container !== this.containerEl ||
      this.skeletonKey !== this.buildSkeletonKey(date) ||
      this.gridHandles === null
    ) {
      this.render(container, tasks, config);
      return;
    }

    this.timedInteractions.disposeActive();
    this.spanInteractions.disposeActive();
    this.resetTaskComponent();
    this.renderTaskLayers(tasks, date, this.gridHandles, false);
  }

  private buildSkeletonKey(date: string): string {
    return `${date}|today:${window.moment().format('YYYY-MM-DD')}`;
  }

  private resetTaskComponent(): void {
    this.md.unload();
    this.md = new Component();
    this.md.load();
  }

  private renderTaskLayers(
    tasks: TaskSnapshot[],
    date: string,
    handles: HourGridHandles,
    installCellBindings: boolean,
  ): void {
    const day = handles.days[0];
    if (day === undefined) throw new Error('Today time-grid requires one day column');
    const occurrenceFor = calendarOccurrenceLookup(tasks);
    const buckets = bucketTasksForDate(tasks, date);
    const timedCallbacks = this.buildTimedCallbacks(occurrenceFor);
    const previewPositionFor = (
      task: TaskSnapshot,
      planning: TaskSnapshot['planning'],
      previewDate: string,
    ): PositionedBlock | undefined => previewTimedPositionFor(tasks, task, planning, previewDate);
    const tagGroups = this.callbacks.tagGroups ?? [];
    if (!installCellBindings) {
      day.hourColumnEl
        .querySelectorAll<HTMLElement>(
          ':scope > .abyss-tg-block, :scope > .abyss-tg-block-continuation',
        )
        .forEach((element) => {
          element.remove();
        });
    }
    renderTimedBlocksForDay(
      day.hourColumnEl,
      [...buckets.timed, ...buckets.timedSpans],
      timedCallbacks,
      tagGroups,
      { date, previewPositionFor },
    );
    const spanTasks = tasks.filter((task) => task.planning.time === undefined);
    const allDayCallbacks = this.buildAllDayCallbacks(spanTasks, date, occurrenceFor);
    const spanRow = layoutVisibleSpans(buckets.spans, [date]).rows[0];
    if (spanRow === undefined) throw new Error('Today time-grid requires one visible span row');
    renderAllDaySpanLayer(
      handles.allDaySpanLayerEl,
      spanRow,
      [date],
      allDayCallbacks,
      tagGroups,
      this.spanInteractions,
      'timegrid',
    );
    this.renderTodayAllDay({
      date,
      day,
      buckets,
      callbacks: allDayCallbacks,
      tagGroups,
      spanRow,
      installCellBindings,
    });
  }

  private buildTimedCallbacks(
    occurrenceFor: ReturnType<typeof calendarOccurrenceLookup>,
  ): TimedBlockCallbacks {
    return {
      occurrenceFor,
      app: this.callbacks.app,
      component: this.md,
      onTaskClick: this.callbacks.onTaskClick,
      onKeyboardIntent: this.callbacks.onKeyboardIntent,
      onTimeChange: this.callbacks.onTimeChange,
      onDurationChange: this.callbacks.onDurationChange,
      onTimedMove: this.callbacks.onTimedMove,
      onTimedDuration: this.callbacks.onTimedDuration,
      onTimedBoundary: this.callbacks.onTimedBoundary,
      interactionOwner: this.timedInteractions,
      onExtendToSpan: this.callbacks.onExtendToSpan,
      onStartChange: this.callbacks.onStartChange,
      onDueChange: this.callbacks.onDueChange,
      onToggle: this.callbacks.onToggle,
      onSetStatus: this.callbacks.onSetStatus,
      onSetPriority: this.callbacks.onSetPriority,
      ...(this.callbacks.forecastMenuOwner != null && {
        forecastMenuOwner: this.callbacks.forecastMenuOwner,
      }),
      ...(this.callbacks.onForecastClick != null && {
        onForecastClick: this.callbacks.onForecastClick,
      }),
      ...(this.callbacks.onForecastContextMenu != null && {
        onForecastContextMenu: this.callbacks.onForecastContextMenu,
      }),
      ...(this.callbacks.interactionOwnership != null && {
        interactionOwnership: this.callbacks.interactionOwnership,
      }),
      statusRegistry: this.callbacks.statusRegistry,
    };
  }

  private buildAllDayCallbacks(
    spanTasks: readonly TaskSnapshot[],
    date: string,
    occurrenceFor: ReturnType<typeof calendarOccurrenceLookup>,
  ): AllDayCallbacks {
    return {
      occurrenceFor,
      app: this.callbacks.app,
      component: this.md,
      onTaskClick: this.callbacks.onTaskClick,
      onDrop: this.callbacks.onDrop,
      onStartChange: this.callbacks.onStartChange,
      onDueChange: this.callbacks.onDueChange,
      onExtendToSpan: this.callbacks.onExtendToSpan,
      onSpanMove: this.callbacks.onSpanMove,
      onSpanBoundary: this.callbacks.onSpanBoundary,
      spanInteractionOwner: this.spanInteractions,
      spanPreviewLayoutFor: (task, planning) =>
        layoutVisibleSpansWithReplacement(spanTasks, [date], task, planning),
      onToggle: this.callbacks.onToggle,
      onSetStatus: this.callbacks.onSetStatus,
      onSetPriority: this.callbacks.onSetPriority,
      ...(this.callbacks.forecastMenuOwner != null && {
        forecastMenuOwner: this.callbacks.forecastMenuOwner,
      }),
      ...(this.callbacks.onForecastClick != null && {
        onForecastClick: this.callbacks.onForecastClick,
      }),
      ...(this.callbacks.onForecastContextMenu != null && {
        onForecastContextMenu: this.callbacks.onForecastContextMenu,
      }),
      ...(this.callbacks.interactionOwnership != null && {
        interactionOwnership: this.callbacks.interactionOwnership,
      }),
      statusRegistry: this.callbacks.statusRegistry,
      onCreateAtDate: this.callbacks.onCreateAtDate,
    };
  }

  private renderTodayAllDay(context: TodayAllDayContext): void {
    const { date, day, buckets, callbacks, tagGroups, spanRow, installCellBindings } = context;
    day.allDayCellEl.style.setProperty('--abyss-span-lane-count', String(spanRow.laneCount));
    if (installCellBindings) {
      renderAllDayCell(
        day.allDayCellEl,
        date,
        [],
        buckets.plain,
        buckets.deadlines,
        callbacks,
        tagGroups,
      );
      const allDayItems = day.allDayCellEl.createDiv({ cls: 'abyss-tg-cell-items' });
      for (const child of Array.from(day.allDayCellEl.children)) {
        if (child !== allDayItems) allDayItems.appendChild(child);
      }
      return;
    }

    const allDayItems = day.allDayCellEl.querySelector<HTMLElement>(
      ':scope > .abyss-tg-cell-items',
    );
    if (allDayItems === null) return;
    allDayItems.empty();
    const scratch = day.allDayCellEl.ownerDocument.createElementNS(
      'http://www.w3.org/1999/xhtml',
      'div',
    ) as HTMLDivElement;
    renderAllDayCell(scratch, date, [], buckets.plain, buckets.deadlines, callbacks, tagGroups);
    for (const child of Array.from(scratch.children)) allDayItems.appendChild(child);
    const scratchHook = (scratch as unknown as { __tgTestEndDrag?: (targetDate: string) => void })
      .__tgTestEndDrag;
    if (scratchHook !== undefined) {
      (
        day.allDayCellEl as unknown as { __tgTestEndDrag?: (targetDate: string) => void }
      ).__tgTestEndDrag = scratchHook;
    }
  }

  destroy(): void {
    this.timedInteractions.disposeActive();
    this.spanInteractions.disposeActive();
    this.containerEl = null;
    this.skeletonKey = null;
    this.gridHandles = null;
    this.md.unload();
    this.clearNowLineInterval();
  }
}
