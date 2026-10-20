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
  private containerEl_abyssPrivate: HTMLElement | null = null;
  private skeletonKey_abyssPrivate: string | null = null;
  private gridHandles_abyssPrivate: HourGridHandles | null = null;
  private visibleDates_abyssPrivate: string[] = [];
  private md_abyssPrivate = new Component();
  private nowLineIntervalId_abyssPrivate: number | null = null;
  private readonly timedInteractions_abyssPrivate = createTimedInteractionOwner();
  private readonly spanInteractions_abyssPrivate = createSpanInteractionOwner();

  constructor(private readonly callbacks_abyssPrivate: TimeGridCallbacks) {
    super();
  }

  render(
    container: HTMLElement,
    tasks: TaskSnapshot[],
    config: ResolvedConfig,
    ...options: [shouldScrollToNow?: boolean, preservedScrollTop?: number]
  ): void {
    const [shouldScrollToNow = true, preservedScrollTop] = options;
    this.timedInteractions_abyssPrivate.disposeActive();
    this.spanInteractions_abyssPrivate.disposeActive();
    this.md_abyssPrivate.unload();
    this.md_abyssPrivate = new Component();
    this.md_abyssPrivate.load();

    // A re-render on the same instance (e.g. week change) must not stack a second interval on
    // top of one already registered from a prior render() without an intervening destroy().
    this.clearNowLineInterval_abyssPrivate();

    this.containerEl_abyssPrivate = container;
    const dates = this.resolveDates_abyssPrivate(config);
    this.visibleDates_abyssPrivate = dates;
    this.skeletonKey_abyssPrivate = this.buildSkeletonKey_abyssPrivate(dates);

    const handles = renderHourGrid(
      container,
      dates,
      this.callbacks_abyssPrivate.onDropTime,
      this.callbacks_abyssPrivate.onCreateAtTime,
      this.callbacks_abyssPrivate.onDayHeaderClick,
    );
    handles.rootEl.addClass('abyss-tg-root--week');
    this.gridHandles_abyssPrivate = handles;
    this.renderTaskLayers_abyssPrivate(tasks, dates, handles, true);

    const today = window.moment().format('YYYY-MM-DD');
    const containsToday = dates.includes(today);
    this.scheduleInitialScroll_abyssPrivate(
      handles.gridRowEl,
      containsToday,
      shouldScrollToNow,
      preservedScrollTop,
    );
    this.startNowLineRefresh_abyssPrivate(containsToday ? handles.nowLineEl : null);
  }

  private clearNowLineInterval_abyssPrivate(): void {
    if (this.nowLineIntervalId_abyssPrivate === null) return;
    window.clearInterval(this.nowLineIntervalId_abyssPrivate);
    this.nowLineIntervalId_abyssPrivate = null;
  }

  private scheduleInitialScroll_abyssPrivate(
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

  private startNowLineRefresh_abyssPrivate(nowLine: HTMLElement | null): void {
    if (nowLine === null) return;
    this.nowLineIntervalId_abyssPrivate = window.setInterval(() => {
      repositionNowLine(nowLine);
    }, NOW_LINE_REFRESH_MS);
  }

  override patch(container: HTMLElement, tasks: TaskSnapshot[], config: ResolvedConfig): void {
    const dates = this.resolveDates_abyssPrivate(config);
    if (
      container !== this.containerEl_abyssPrivate ||
      this.skeletonKey_abyssPrivate !== this.buildSkeletonKey_abyssPrivate(dates) ||
      this.gridHandles_abyssPrivate === null
    ) {
      this.render(container, tasks, config);
      return;
    }

    this.timedInteractions_abyssPrivate.disposeActive();
    this.spanInteractions_abyssPrivate.disposeActive();
    this.resetTaskComponent_abyssPrivate();
    this.renderTaskLayers_abyssPrivate(
      tasks,
      this.visibleDates_abyssPrivate,
      this.gridHandles_abyssPrivate,
      false,
    );
  }

  private resolveDates_abyssPrivate(config: ResolvedConfig): string[] {
    const week = resolveWeekStartPosition(
      config.startPosition,
      config.firstDayOfWeek,
      window.moment(),
    );
    return Array.from({ length: 7 }, (_, index) =>
      week.clone().add(index, 'days').format('YYYY-MM-DD'),
    );
  }

  private buildSkeletonKey_abyssPrivate(dates: readonly string[]): string {
    return `${dates.join(',')}|today:${window.moment().format('YYYY-MM-DD')}`;
  }

  private resetTaskComponent_abyssPrivate(): void {
    this.md_abyssPrivate.unload();
    this.md_abyssPrivate = new Component();
    this.md_abyssPrivate.load();
  }

  private renderTaskLayers_abyssPrivate(
    tasks: TaskSnapshot[],
    dates: readonly string[],
    handles: HourGridHandles,
    installCellBindings: boolean,
  ): void {
    const occurrenceFor = calendarOccurrenceLookup(tasks);
    const timedCallbacks = this.buildTimedCallbacks_abyssPrivate(occurrenceFor);
    const spanTasks = tasks.filter((task) => task.planning.time === undefined);
    const allDayCallbacks = this.buildAllDayCallbacks_abyssPrivate(spanTasks, dates, occurrenceFor);
    const tagGroups = this.callbacks_abyssPrivate.tagGroups ?? [];
    const spanRow = layoutVisibleSpans(spanTasks, dates).rows[0];
    if (spanRow === undefined) throw new Error('Week time-grid requires one visible span row');
    renderAllDaySpanLayer(
      handles.allDaySpanLayerEl,
      spanRow,
      dates,
      allDayCallbacks,
      tagGroups,
      this.spanInteractions_abyssPrivate,
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
    for (const day of handles.days) this.renderDayLayers_abyssPrivate(day, context);
  }

  private buildTimedCallbacks_abyssPrivate(
    occurrenceFor: ReturnType<typeof calendarOccurrenceLookup>,
  ): TimedBlockCallbacks {
    return {
      occurrenceFor,
      app: this.callbacks_abyssPrivate.app,
      component: this.md_abyssPrivate,
      onTaskClick: this.callbacks_abyssPrivate.onTaskClick,
      onTaskSelect: this.callbacks_abyssPrivate.onTaskSelect,
      onTaskActivate: this.callbacks_abyssPrivate.onTaskActivate,
      onShowParent: this.callbacks_abyssPrivate.onShowParent,
      onKeyboardIntent: this.callbacks_abyssPrivate.onKeyboardIntent,
      onTimeChange: this.callbacks_abyssPrivate.onTimeChange,
      onDurationChange: this.callbacks_abyssPrivate.onDurationChange,
      onTimedMove: this.callbacks_abyssPrivate.onTimedMove,
      onTimedDuration: this.callbacks_abyssPrivate.onTimedDuration,
      onTimedBoundary: this.callbacks_abyssPrivate.onTimedBoundary,
      interactionOwner: this.timedInteractions_abyssPrivate,
      onExtendToSpan: this.callbacks_abyssPrivate.onExtendToSpan,
      onStartChange: this.callbacks_abyssPrivate.onStartChange,
      onDueChange: this.callbacks_abyssPrivate.onDueChange,
      onToggle: this.callbacks_abyssPrivate.onToggle,
      dependenciesFor: this.callbacks_abyssPrivate.dependenciesFor,
      onSetStatus: this.callbacks_abyssPrivate.onSetStatus,
      onSetPriority: this.callbacks_abyssPrivate.onSetPriority,
      ...(this.callbacks_abyssPrivate.forecastMenuOwner != null && {
        forecastMenuOwner: this.callbacks_abyssPrivate.forecastMenuOwner,
      }),
      ...(this.callbacks_abyssPrivate.onForecastClick != null && {
        onForecastClick: this.callbacks_abyssPrivate.onForecastClick,
      }),
      ...(this.callbacks_abyssPrivate.onForecastContextMenu != null && {
        onForecastContextMenu: this.callbacks_abyssPrivate.onForecastContextMenu,
      }),
      ...(this.callbacks_abyssPrivate.interactionOwnership != null && {
        interactionOwnership: this.callbacks_abyssPrivate.interactionOwnership,
      }),
      statusRegistry: this.callbacks_abyssPrivate.statusRegistry,
    };
  }

  private buildAllDayCallbacks_abyssPrivate(
    spanTasks: readonly TaskSnapshot[],
    dates: readonly string[],
    occurrenceFor: ReturnType<typeof calendarOccurrenceLookup>,
  ): AllDayCallbacks {
    return {
      occurrenceFor,
      app: this.callbacks_abyssPrivate.app,
      component: this.md_abyssPrivate,
      onTaskClick: this.callbacks_abyssPrivate.onTaskClick,
      onTaskSelect: this.callbacks_abyssPrivate.onTaskSelect,
      onTaskActivate: this.callbacks_abyssPrivate.onTaskActivate,
      onShowParent: this.callbacks_abyssPrivate.onShowParent,
      onDrop: this.callbacks_abyssPrivate.onDrop,
      onNativeDragStart: this.callbacks_abyssPrivate.onNativeDragStart,
      onStartChange: this.callbacks_abyssPrivate.onStartChange,
      onDueChange: this.callbacks_abyssPrivate.onDueChange,
      onExtendToSpan: this.callbacks_abyssPrivate.onExtendToSpan,
      onSpanMove: this.callbacks_abyssPrivate.onSpanMove,
      onSpanBoundary: this.callbacks_abyssPrivate.onSpanBoundary,
      spanInteractionOwner: this.spanInteractions_abyssPrivate,
      spanPreviewLayoutFor: (task, planning) =>
        layoutVisibleSpansWithReplacement(spanTasks, dates, task, planning),
      onToggle: this.callbacks_abyssPrivate.onToggle,
      dependenciesFor: this.callbacks_abyssPrivate.dependenciesFor,
      onSetStatus: this.callbacks_abyssPrivate.onSetStatus,
      onSetPriority: this.callbacks_abyssPrivate.onSetPriority,
      ...(this.callbacks_abyssPrivate.forecastMenuOwner != null && {
        forecastMenuOwner: this.callbacks_abyssPrivate.forecastMenuOwner,
      }),
      ...(this.callbacks_abyssPrivate.onForecastClick != null && {
        onForecastClick: this.callbacks_abyssPrivate.onForecastClick,
      }),
      ...(this.callbacks_abyssPrivate.onForecastContextMenu != null && {
        onForecastContextMenu: this.callbacks_abyssPrivate.onForecastContextMenu,
      }),
      ...(this.callbacks_abyssPrivate.interactionOwnership != null && {
        interactionOwnership: this.callbacks_abyssPrivate.interactionOwnership,
      }),
      statusRegistry: this.callbacks_abyssPrivate.statusRegistry,
      onCreateAtDate: this.callbacks_abyssPrivate.onCreateAtDate,
    };
  }

  private renderDayLayers_abyssPrivate(
    day: HourGridHandles['days'][number],
    context: WeekLayerContext,
  ): void {
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
    this.timedInteractions_abyssPrivate.disposeActive();
    this.spanInteractions_abyssPrivate.disposeActive();
    this.containerEl_abyssPrivate = null;
    this.skeletonKey_abyssPrivate = null;
    this.gridHandles_abyssPrivate = null;
    this.visibleDates_abyssPrivate = [];
    this.md_abyssPrivate.unload();
    this.clearNowLineInterval_abyssPrivate();
  }
}
