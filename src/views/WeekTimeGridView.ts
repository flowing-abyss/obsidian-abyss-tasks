import { Component } from 'obsidian';
import { weekStartOffset } from '../domain/weekGridOffset';
import type { ResolvedConfig } from '../settings/types';
import type { TaskSnapshot } from '../tasks';
import { BaseView } from './BaseView';
import { bucketTasksForDate, NOW_LINE_REFRESH_MS, type TimeGridCallbacks } from './TodayView';
import { renderHourGrid, repositionNowLine } from './timegrid/HourGrid';
import { minutesToPixels } from './timegrid/layout';
import { renderAllDayCell, type AllDayCallbacks } from './timegrid/renderAllDay';
import {
  renderTimedBlocksForDay,
  renderTimedSpanContinuation,
  toTimedBlockInputs,
  type TimedBlockCallbacks,
} from './timegrid/renderTimedBlocks';

export class WeekTimeGridView extends BaseView {
  private containerEl: HTMLElement | null = null;
  private md = new Component();
  private nowLineIntervalId: number | null = null;

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
    if (config.startPosition) {
      // `config.startPosition` ('YYYY-ww') always round-trips to a Sunday anchor (moment's
      // non-ISO 'ww' token is Sunday-first, and parsing a format with no day-of-week token
      // defaults the day to the locale's start of week) — regardless of which real calendar
      // day the caller originally derived the label from. CenterPanel/CalendarRenderer's own
      // startPosition-computing code is responsible for pre-shifting that source date back by
      // `firstDayOfWeek` days before formatting (Task 42b), so this simple forward shift from
      // the reconstructed Sunday anchor always lands on the correct 7-day window.
      const week = window.moment(config.startPosition, 'YYYY-ww').startOf('week');
      for (let i = config.firstDayOfWeek; i < config.firstDayOfWeek + 7; i++) {
        dates.push(window.moment(week).add(i, 'days').format('YYYY-MM-DD'));
      }
    } else {
      // No lossy label round-trip here — capture "today"'s real weekday (Task 42b: this MUST
      // happen before `.startOf('week')` would collapse it to a constant 0/Sunday) so the
      // offset below can correctly walk backward when today falls before firstDayOfWeek in the
      // week (e.g. today is Sunday and firstDayOfWeek is Monday).
      const today = window.moment();
      const currentWeekday = parseInt(today.format('d'), 10);
      const offset = weekStartOffset(currentWeekday, config.firstDayOfWeek);
      for (let i = offset; i < offset + 7; i++) {
        dates.push(today.clone().add(i, 'days').format('YYYY-MM-DD'));
      }
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
      onExtendToSpan: this.callbacks.onExtendToSpan,
      onStartChange: this.callbacks.onStartChange,
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
      // Task 29: full interactive block only on the span's `due` (anchor) day; every other
      // day it covers gets the lighter, non-interactive continuation segment instead.
      const anchoredTimedSpans = timedSpans.filter((t) => String(t.planning.due) === day.date);
      const continuationTimedSpans = timedSpans.filter((t) => String(t.planning.due) !== day.date);
      const anchorBlocks = [...timed, ...anchoredTimedSpans];
      renderTimedBlocksForDay(day.hourColumnEl, anchorBlocks, timedCallbacks, tagGroups);
      renderTimedSpanContinuation(
        day.hourColumnEl,
        continuationTimedSpans,
        this.callbacks.onTaskClick,
        tagGroups,
        // Task 37: lets a short continuation segment's min-height clamp against this same day's
        // anchor block(s) too, not just other continuations sharing the column.
        toTimedBlockInputs(anchorBlocks),
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
    this.containerEl = null;
    this.md.unload();
    if (this.nowLineIntervalId !== null) {
      window.clearInterval(this.nowLineIntervalId);
      this.nowLineIntervalId = null;
    }
  }
}
