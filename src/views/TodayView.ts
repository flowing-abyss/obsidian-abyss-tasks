import { Component, type App } from 'obsidian';
import type { ResolvedConfig, TagGroup } from '../settings/types';
import type { StatusRegistry } from '../status/StatusRegistry';
import type { TaskPriority, TaskSnapshot } from '../tasks';
import { BaseView } from './BaseView';
import { renderHourGrid, repositionNowLine } from './timegrid/HourGrid';
import { minutesToPixels } from './timegrid/layout';
import { renderAllDayCell, type AllDayCallbacks } from './timegrid/renderAllDay';
import {
  renderTimedBlocksForDay,
  renderTimedSpanContinuation,
  toTimedBlockInputs,
  type TimedBlockCallbacks,
  type TimedBlockKeyboardIntent,
} from './timegrid/renderTimedBlocks';

export interface TimeGridCallbacks {
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
  onStartChange: (task: TaskSnapshot, newStart: string) => void;
  onDueChange: (task: TaskSnapshot, newDue: string) => void;
  onExtendToSpan: (task: TaskSnapshot, newDue: string) => void;
  onToggle: (task: TaskSnapshot) => void;
  onSetStatus: (task: TaskSnapshot, status: string) => void;
  onSetPriority: (task: TaskSnapshot, priority: TaskPriority) => void;
  statusRegistry: StatusRegistry;
  tagGroups?: TagGroup[];
}

/**
 * Bucket tasks for a single date per the due-centric anchor rule (spec: due-centric contract).
 *
 * `timedSpans` (Task 29): a multi-day span (`start` && `due`) that additionally has a `time`
 * set is kept separate from the untimed `spans` bucket — it needs hour-grid treatment (a block
 * at its time-of-day row on every spanned day, per bucketing below) rather than the all-day
 * band's chip treatment `spans` gets. Consumers render it on its `due` day (the due-centric
 * anchor, matching `spans`' existing left/right-edge convention) as the full interactive block,
 * and on every other spanned day as a lighter continuation segment — see renderTimedBlocks.ts's
 * `renderTimedSpanContinuation` and MonthGridView's `timedSpans` handling.
 */
export function bucketTasksForDate(
  tasks: TaskSnapshot[],
  date: string,
): {
  timed: TaskSnapshot[];
  spans: TaskSnapshot[];
  timedSpans: TaskSnapshot[];
  plain: TaskSnapshot[];
  deadlines: TaskSnapshot[];
} {
  const timed: TaskSnapshot[] = [];
  const spans: TaskSnapshot[] = [];
  const timedSpans: TaskSnapshot[] = [];
  const plain: TaskSnapshot[] = [];
  const deadlines: TaskSnapshot[] = [];
  // Identity convention for task de-duplication (matches drag-payload identity used elsewhere,
  // e.g. MonthView.ts's `${task.source.filePath}:::${task.source.line}`).
  const spanIdentities = new Set<string>();

  for (const t of tasks) {
    // Task 38: done/cancelled tasks are NOT filtered out here — a completed timed/all-day task
    // must stay visible in place (checkbox checked, title struck-through) so the calendar keeps
    // a visual history of what was done and when. A separate, deliberate, user-configurable
    // "hide done tasks" feature (if any) lives elsewhere in the plugin and is out of scope here.

    // Multi-day span: anchored on every day from start to due
    if (t.planning.start && t.planning.due) {
      const inRange = window.moment(date).isBetween(t.planning.start, t.planning.due, 'day', '[]');
      if (inRange) {
        if (t.planning.time) {
          timedSpans.push(t);
        } else {
          spans.push(t);
        }
        spanIdentities.add(`${t.source.filePath}:::${t.source.line}`);
      }
      continue;
    }

    const anchor = t.planning.scheduled ?? t.planning.due;
    if (String(anchor) !== date) continue;

    if (t.planning.time) {
      timed.push(t);
    } else {
      plain.push(t);
    }
  }

  // Deadline markers: tasks whose `due` falls on this date AND a distinct `scheduled` is also set
  // (so their body renders elsewhere, on the scheduled day, per the due-centric contract).
  // Spans take priority: a task already rendered as a span (its due edge communicates the
  // deadline structurally) never also gets a separate deadline marker for the same date.
  for (const t of tasks) {
    if (spanIdentities.has(`${t.source.filePath}:::${t.source.line}`)) continue;
    if (
      String(t.planning.due) === date &&
      t.planning.scheduled &&
      t.planning.scheduled !== t.planning.due
    )
      deadlines.push(t);
  }

  return { timed, spans, timedSpans, plain, deadlines };
}

/** How often the now-line is repositioned while a Today/Week view showing today stays mounted. */
export const NOW_LINE_REFRESH_MS = 5 * 60 * 1000;

export class TodayView extends BaseView {
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

    // A re-render on the same instance (e.g. config change) must not stack a second interval
    // on top of one already registered from a prior render() without an intervening destroy().
    if (this.nowLineIntervalId !== null) {
      window.clearInterval(this.nowLineIntervalId);
      this.nowLineIntervalId = null;
    }

    this.containerEl = container;
    const date = config.startPosition || window.moment().format('YYYY-MM-DD');

    const handles = renderHourGrid(
      container,
      [date],
      this.callbacks.onDropTime,
      this.callbacks.onCreateAtTime,
      this.callbacks.onDayHeaderClick,
    );
    const day = handles.days[0]!;

    const { timed, spans, timedSpans, plain, deadlines } = bucketTasksForDate(tasks, date);
    // Task 29: a timed multi-day span renders its full interactive block only on its `due`
    // day (the due-centric anchor, matching `spans`' existing left/right-edge convention) —
    // every other day it covers gets the lighter, non-interactive continuation segment instead,
    // so the same task never shows two full interactive blocks at once.
    const anchoredTimedSpans = timedSpans.filter((t) => String(t.planning.due) === date);
    const continuationTimedSpans = timedSpans.filter((t) => String(t.planning.due) !== date);

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
    const tagGroups = this.callbacks.tagGroups ?? [];
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
    renderAllDayCell(day.allDayCellEl, date, spans, plain, deadlines, allDayCallbacks, tagGroups);

    const isToday = date === window.moment().format('YYYY-MM-DD');
    const gridRowEl = handles.gridRowEl;
    // One-time scroll-into-position: only when CenterPanel says this is a genuinely new
    // (viewType, date) it hasn't scrolled for yet — NOT on every reactive re-render of the
    // same view/date (Task 27). The periodic now-line repositioning below is unconditional
    // and untouched — a separate, still-desired behavior (Round 2 Task 16).
    if (shouldScrollToNow) {
      if (isToday) {
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

    if (isToday) {
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
