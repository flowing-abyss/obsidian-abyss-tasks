import { Component } from 'obsidian';
import { resolveWeekStartPosition } from '../domain/weekGridOffset';
import type { ResolvedConfig } from '../settings/types';
import type { TaskSnapshot } from '../tasks';
import { BaseView } from './BaseView';
import { bucketTasksForDate, NOW_LINE_REFRESH_MS, type TimeGridCallbacks } from './TodayView';
import { renderHourGrid, repositionNowLine } from './timegrid/HourGrid';
import { minutesToPixels } from './timegrid/layout';
import { renderAllDayCell, type AllDayCallbacks } from './timegrid/renderAllDay';
import { renderTimedBlocksForDay, type TimedBlockCallbacks } from './timegrid/renderTimedBlocks';
import { createTimedInteractionOwner } from './timegrid/timedInteractions';

export class WeekTimeGridView extends BaseView {
  private containerEl: HTMLElement | null = null;
  private md = new Component();
  private nowLineIntervalId: number | null = null;
  private timedInteractions = createTimedInteractionOwner();

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
    const dates: string[] = [];
    const week = resolveWeekStartPosition(
      config.startPosition,
      config.firstDayOfWeek,
      window.moment(),
    );
    for (let i = 0; i < 7; i++) {
      dates.push(week.clone().add(i, 'days').format('YYYY-MM-DD'));
    }

    const handles = renderHourGrid(
      container,
      dates,
      this.callbacks.onDropTime,
      this.callbacks.onCreateAtTime,
      this.callbacks.onDayHeaderClick,
    );

    const timedCallbacks: TimedBlockCallbacks = {
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
      statusRegistry: this.callbacks.statusRegistry,
    };
    const allDayCallbacks: AllDayCallbacks = {
      app: this.callbacks.app,
      component: this.md,
      onTaskClick: this.callbacks.onTaskClick,
      onDrop: this.callbacks.onDrop,
      onStartChange: this.callbacks.onStartChange,
      onDueChange: this.callbacks.onDueChange,
      onExtendToSpan: this.callbacks.onExtendToSpan,
      onToggle: this.callbacks.onToggle,
      onSetStatus: this.callbacks.onSetStatus,
      onSetPriority: this.callbacks.onSetPriority,
      statusRegistry: this.callbacks.statusRegistry,
      onCreateAtDate: this.callbacks.onCreateAtDate,
    };

    const tagGroups = this.callbacks.tagGroups ?? [];
    for (const day of handles.days) {
      const { timed, spans, timedSpans, plain, deadlines } = bucketTasksForDate(tasks, day.date);
      renderTimedBlocksForDay(
        day.hourColumnEl,
        [...timed, ...timedSpans],
        timedCallbacks,
        tagGroups,
        { date: day.date },
      );
      renderAllDayCell(
        day.allDayCellEl,
        day.date,
        spans,
        plain,
        deadlines,
        allDayCallbacks,
        tagGroups,
      );
    }

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

  destroy(): void {
    this.timedInteractions.disposeActive();
    this.containerEl = null;
    this.md.unload();
    if (this.nowLineIntervalId !== null) {
      window.clearInterval(this.nowLineIntervalId);
      this.nowLineIntervalId = null;
    }
  }
}
