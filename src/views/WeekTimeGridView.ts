import { Component } from 'obsidian';
import { resolveWeekStartPosition } from '../domain/weekGridOffset';
import type { ResolvedConfig } from '../settings/types';
import type { TaskSnapshot } from '../tasks';
import { BaseView } from './BaseView';
import { createSpanInteractionOwner } from './spanInteractions';
import { layoutVisibleSpans, layoutVisibleSpansWithReplacement } from './spanLayout';
import { renderHourGrid, repositionNowLine, type HourGridHandles } from './timegrid/HourGrid';
import type { PositionedBlock } from './timegrid/layout';
import { minutesToPixels } from './timegrid/layout';
import {
  renderAllDayCell,
  renderAllDaySpanLayer,
  type AllDayCallbacks,
} from './timegrid/renderAllDay';
import { calendarOccurrenceLookup } from './timegrid/renderTaskMeta';
import { renderTimedBlocksForDay, type TimedBlockCallbacks } from './timegrid/renderTimedBlocks';
import { createTimedInteractionOwner } from './timegrid/timedInteractions';
import {
  bucketTasksForDate,
  NOW_LINE_REFRESH_MS,
  previewTimedPositionFor,
  type TimeGridCallbacks,
} from './TodayView';

interface WeekLayerContext {
  readonly tasks: TaskSnapshot[];
  readonly installCellBindings: boolean;
  readonly timedCallbacks: TimedBlockCallbacks;
  readonly allDayCallbacks: AllDayCallbacks;
  readonly tagGroups: NonNullable<TimeGridCallbacks['tagGroups']>;
  readonly spanRow: ReturnType<typeof layoutVisibleSpans>['rows'][number];
  readonly previewPositionFor: (
    task: TaskSnapshot,
    planning: TaskSnapshot['planning'],
    previewDate: string,
  ) => PositionedBlock | undefined;
}

export class WeekTimeGridView extends BaseView {
  private containerEl: HTMLElement | null = null;
  private skeletonKey: string | null = null;
  private gridHandles: HourGridHandles | null = null;
  private visibleDates: string[] = [];
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

    // A re-render on the same instance (e.g. week change) must not stack a second interval on
    // top of one already registered from a prior render() without an intervening destroy().
    this.clearNowLineInterval();

    this.containerEl = container;
    const dates = this.resolveDates(config);
    this.visibleDates = dates;
    this.skeletonKey = this.buildSkeletonKey(dates);

    const handles = renderHourGrid(
      container,
      dates,
      this.callbacks.onDropTime,
      this.callbacks.onCreateAtTime,
      this.callbacks.onDayHeaderClick,
    );
    handles.rootEl.addClass('abyss-tg-root--week');
    this.gridHandles = handles;
    this.renderTaskLayers(tasks, dates, handles, true);

    const today = window.moment().format('YYYY-MM-DD');
    const containsToday = dates.includes(today);
    this.scheduleInitialScroll(
      handles.gridRowEl,
      containsToday,
      shouldScrollToNow,
      preservedScrollTop,
    );
    this.startNowLineRefresh(containsToday ? handles.nowLineEl : null);
  }

  private clearNowLineInterval(): void {
    if (this.nowLineIntervalId === null) return;
    window.clearInterval(this.nowLineIntervalId);
    this.nowLineIntervalId = null;
  }

  private scheduleInitialScroll(
    grid: HTMLElement,
    containsToday: boolean,
    shouldScrollToNow: boolean,
    preservedScrollTop: number | undefined,
  ): void {
    if (shouldScrollToNow && containsToday) {
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
    const dates = this.resolveDates(config);
    if (
      container !== this.containerEl ||
      this.skeletonKey !== this.buildSkeletonKey(dates) ||
      this.gridHandles === null
    ) {
      this.render(container, tasks, config);
      return;
    }

    this.timedInteractions.disposeActive();
    this.spanInteractions.disposeActive();
    this.resetTaskComponent();
    this.renderTaskLayers(tasks, this.visibleDates, this.gridHandles, false);
  }

  private resolveDates(config: ResolvedConfig): string[] {
    const week = resolveWeekStartPosition(
      config.startPosition,
      config.firstDayOfWeek,
      window.moment(),
    );
    return Array.from({ length: 7 }, (_, index) =>
      week.clone().add(index, 'days').format('YYYY-MM-DD'),
    );
  }

  private buildSkeletonKey(dates: readonly string[]): string {
    return `${dates.join(',')}|today:${window.moment().format('YYYY-MM-DD')}`;
  }

  private resetTaskComponent(): void {
    this.md.unload();
    this.md = new Component();
    this.md.load();
  }

  private renderTaskLayers(
    tasks: TaskSnapshot[],
    dates: readonly string[],
    handles: HourGridHandles,
    installCellBindings: boolean,
  ): void {
    const occurrenceFor = calendarOccurrenceLookup(tasks);
    const timedCallbacks = this.buildTimedCallbacks(occurrenceFor);
    const spanTasks = tasks.filter((task) => task.planning.time === undefined);
    const allDayCallbacks = this.buildAllDayCallbacks(spanTasks, dates, occurrenceFor);
    const tagGroups = this.callbacks.tagGroups ?? [];
    const spanRow = layoutVisibleSpans(spanTasks, dates).rows[0];
    if (spanRow === undefined) throw new Error('Week time-grid requires one visible span row');
    renderAllDaySpanLayer(
      handles.allDaySpanLayerEl,
      spanRow,
      dates,
      allDayCallbacks,
      tagGroups,
      this.spanInteractions,
      'timegrid',
    );
    const previewPositionFor = (
      task: TaskSnapshot,
      planning: TaskSnapshot['planning'],
      previewDate: string,
    ): PositionedBlock | undefined => previewTimedPositionFor(tasks, task, planning, previewDate);
    const context: WeekLayerContext = {
      tasks,
      installCellBindings,
      timedCallbacks,
      allDayCallbacks,
      tagGroups,
      spanRow,
      previewPositionFor,
    };
    for (const day of handles.days) this.renderDayLayers(day, context);
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
    dates: readonly string[],
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
        layoutVisibleSpansWithReplacement(spanTasks, dates, task, planning),
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

  private renderDayLayers(day: HourGridHandles['days'][number], context: WeekLayerContext): void {
    const { timed, timedSpans, plain, deadlines } = bucketTasksForDate(context.tasks, day.date);
    if (!context.installCellBindings) {
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
      [...timed, ...timedSpans],
      context.timedCallbacks,
      context.tagGroups,
      { date: day.date, previewPositionFor: context.previewPositionFor },
    );
    day.allDayCellEl.style.setProperty(
      '--abyss-span-lane-count',
      String(context.spanRow.laneCount),
    );
    if (context.installCellBindings) {
      renderAllDayCell(
        day.allDayCellEl,
        day.date,
        [],
        plain,
        deadlines,
        context.allDayCallbacks,
        context.tagGroups,
      );
      const items = day.allDayCellEl.createDiv({ cls: 'abyss-tg-cell-items' });
      for (const child of Array.from(day.allDayCellEl.children)) {
        if (child !== items) items.appendChild(child);
      }
      return;
    }
    const items = day.allDayCellEl.querySelector<HTMLElement>(':scope > .abyss-tg-cell-items');
    if (items === null) return;
    items.empty();
    const scratch = day.allDayCellEl.ownerDocument.createElementNS(
      'http://www.w3.org/1999/xhtml',
      'div',
    ) as HTMLDivElement;
    renderAllDayCell(
      scratch,
      day.date,
      [],
      plain,
      deadlines,
      context.allDayCallbacks,
      context.tagGroups,
    );
    for (const child of Array.from(scratch.children)) items.appendChild(child);
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
    this.visibleDates = [];
    this.md.unload();
    this.clearNowLineInterval();
  }
}
