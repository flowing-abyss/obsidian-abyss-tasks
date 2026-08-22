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

export class WeekTimeGridView extends BaseView {
  private containerEl: HTMLElement | null = null;
  private skeletonKey: string | null = null;
  private gridHandles: HourGridHandles | null = null;
  private visibleDates: string[] = [];
  private md = new Component();
  private nowLineIntervalId: number | null = null;
  private timedInteractions = createTimedInteractionOwner();
  private spanInteractions = createSpanInteractionOwner();

  constructor(private callbacks: TimeGridCallbacks) {
    super();
  }

  render(
    container: HTMLElement,
    tasks: TaskSnapshot[],
    config: ResolvedConfig,
    shouldScrollToNow = true,
    preservedScrollTop?: number,
  ): void {
    this.timedInteractions.disposeActive();
    this.spanInteractions.disposeActive();
    this.md.unload();
    this.md = new Component();
    this.md.load();

    // A re-render on the same instance (e.g. week change) must not stack a second interval on
    // top of one already registered from a prior render() without an intervening destroy().
    if (this.nowLineIntervalId !== null) {
      window.clearInterval(this.nowLineIntervalId);
      this.nowLineIntervalId = null;
    }

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
    const gridRowEl = handles.gridRowEl;
    // One-time scroll-into-position: only when CenterPanel says this is a genuinely new
    // (viewType, date) it hasn't scrolled for yet — NOT on every reactive re-render of the
    // same view/date (Task 27). The periodic now-line repositioning below is unconditional
    // and untouched — a separate, still-desired behavior (Round 2 Task 16).
    if (shouldScrollToNow) {
      if (containsToday) {
        const nowMinutes = window.moment().hours() * 60 + window.moment().minutes();
        const nowPx = minutesToPixels(nowMinutes);
        window.setTimeout(() => {
          gridRowEl.scrollTop = Math.max(0, nowPx - gridRowEl.clientHeight / 2);
        }, 0);
      }
    } else if (preservedScrollTop !== undefined) {
      // Task 31: this is a reactive re-render (destroy/recreate) of the same view/date — restore
      // the outgoing grid-row's scroll position instead of leaving the fresh one at 0. Deferred
      // via setTimeout like the scroll-to-now branch above: setting scrollTop synchronously,
      // before the browser has laid out the freshly-created grid, gets silently clamped to 0.
      window.setTimeout(() => {
        gridRowEl.scrollTop = preservedScrollTop;
      }, 0);
    }

    if (containsToday) {
      const nowLineEl = handles.nowLineEl;
      if (nowLineEl) {
        this.nowLineIntervalId = window.setInterval(() => {
          repositionNowLine(nowLineEl);
        }, NOW_LINE_REFRESH_MS);
      }
    }
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
    const timedCallbacks: TimedBlockCallbacks = {
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
      ...(this.callbacks.forecastMenuOwner && {
        forecastMenuOwner: this.callbacks.forecastMenuOwner,
      }),
      ...(this.callbacks.onForecastClick && {
        onForecastClick: this.callbacks.onForecastClick,
      }),
      ...(this.callbacks.onForecastContextMenu && {
        onForecastContextMenu: this.callbacks.onForecastContextMenu,
      }),
      ...(this.callbacks.interactionOwnership && {
        interactionOwnership: this.callbacks.interactionOwnership,
      }),
      statusRegistry: this.callbacks.statusRegistry,
    };
    const previewPositionFor = (
      task: TaskSnapshot,
      planning: TaskSnapshot['planning'],
      previewDate: string,
    ): PositionedBlock | undefined => previewTimedPositionFor(tasks, task, planning, previewDate);
    const spanTasks = tasks.filter((task) => !task.planning.time);
    const allDayCallbacks: AllDayCallbacks = {
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
      ...(this.callbacks.forecastMenuOwner && {
        forecastMenuOwner: this.callbacks.forecastMenuOwner,
      }),
      ...(this.callbacks.onForecastClick && {
        onForecastClick: this.callbacks.onForecastClick,
      }),
      ...(this.callbacks.onForecastContextMenu && {
        onForecastContextMenu: this.callbacks.onForecastContextMenu,
      }),
      ...(this.callbacks.interactionOwnership && {
        interactionOwnership: this.callbacks.interactionOwnership,
      }),
      statusRegistry: this.callbacks.statusRegistry,
      onCreateAtDate: this.callbacks.onCreateAtDate,
    };

    const tagGroups = this.callbacks.tagGroups ?? [];
    const spanLayout = layoutVisibleSpans(spanTasks, dates);
    const spanRow = spanLayout.rows[0]!;
    renderAllDaySpanLayer(
      handles.allDaySpanLayerEl,
      spanRow,
      dates,
      allDayCallbacks,
      tagGroups,
      this.spanInteractions,
      'timegrid',
    );
    for (const day of handles.days) {
      const { timed, timedSpans, plain, deadlines } = bucketTasksForDate(tasks, day.date);
      if (!installCellBindings) {
        day.hourColumnEl
          .querySelectorAll<HTMLElement>(
            ':scope > .abyss-tg-block, :scope > .abyss-tg-block-continuation',
          )
          .forEach((element) => element.remove());
      }
      renderTimedBlocksForDay(
        day.hourColumnEl,
        [...timed, ...timedSpans],
        timedCallbacks,
        tagGroups,
        { date: day.date, previewPositionFor },
      );
      day.allDayCellEl.style.setProperty('--abyss-span-lane-count', String(spanRow.laneCount));
      if (installCellBindings) {
        renderAllDayCell(
          day.allDayCellEl,
          day.date,
          [],
          plain,
          deadlines,
          allDayCallbacks,
          tagGroups,
        );
        const items = day.allDayCellEl.createDiv({ cls: 'abyss-tg-cell-items' });
        for (const child of Array.from(day.allDayCellEl.children)) {
          if (child !== items) items.appendChild(child);
        }
        continue;
      }

      const items = day.allDayCellEl.querySelector<HTMLElement>(':scope > .abyss-tg-cell-items');
      if (!items) continue;
      items.empty();
      const scratch = day.allDayCellEl.ownerDocument.createElement('div');
      renderAllDayCell(scratch, day.date, [], plain, deadlines, allDayCallbacks, tagGroups);
      for (const child of Array.from(scratch.children)) items.appendChild(child);
      const scratchHook = (scratch as unknown as { __tgTestEndDrag?: (targetDate: string) => void })
        .__tgTestEndDrag;
      if (scratchHook) {
        (
          day.allDayCellEl as unknown as { __tgTestEndDrag?: (targetDate: string) => void }
        ).__tgTestEndDrag = scratchHook;
      }
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
    if (this.nowLineIntervalId !== null) {
      window.clearInterval(this.nowLineIntervalId);
      this.nowLineIntervalId = null;
    }
  }
}
