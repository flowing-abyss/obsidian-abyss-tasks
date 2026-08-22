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

/**
 * Bucket tasks for a single date per the due-centric anchor rule (spec: due-centric contract).
 *
 * `timedSpans`: a multi-day span (`start` && `due`) that additionally has a `time` is kept
 * separate from untimed `spans`. Consumers place every visible timed segment into the same
 * hour-grid overlap pass. The due segment alone owns the marker/rich title; continuation roots
 * keep the same move, duration, keyboard, focus, and identity contract.
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

    // A re-render on the same instance (e.g. config change) must not stack a second interval
    // on top of one already registered from a prior render() without an intervening destroy().
    if (this.nowLineIntervalId !== null) {
      window.clearInterval(this.nowLineIntervalId);
      this.nowLineIntervalId = null;
    }

    this.containerEl = container;
    const date = config.startPosition || window.moment().format('YYYY-MM-DD');
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

  override patch(container: HTMLElement, tasks: TaskSnapshot[], config: ResolvedConfig): void {
    const date = config.startPosition || window.moment().format('YYYY-MM-DD');
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
    const day = handles.days[0]!;
    const occurrenceFor = calendarOccurrenceLookup(tasks);
    const { timed, spans, timedSpans, plain, deadlines } = bucketTasksForDate(tasks, date);
    // Terminal and continuation timed segments share one renderer/packing pass. Terminal status
    // ownership is decided from `date`; interactivity is intentionally identical on every root.
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
      statusRegistry: this.callbacks.statusRegistry,
    };
    const previewPositionFor = (
      task: TaskSnapshot,
      planning: TaskSnapshot['planning'],
      previewDate: string,
    ): PositionedBlock | undefined => previewTimedPositionFor(tasks, task, planning, previewDate);
    const tagGroups = this.callbacks.tagGroups ?? [];
    if (!installCellBindings) {
      day.hourColumnEl
        .querySelectorAll<HTMLElement>(':scope > .tc-tg-block, :scope > .tc-tg-block-continuation')
        .forEach((element) => element.remove());
    }
    renderTimedBlocksForDay(
      day.hourColumnEl,
      [...timed, ...timedSpans],
      timedCallbacks,
      tagGroups,
      { date, previewPositionFor },
    );

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
        layoutVisibleSpansWithReplacement(spanTasks, [date], task, planning),
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
      statusRegistry: this.callbacks.statusRegistry,
      onCreateAtDate: this.callbacks.onCreateAtDate,
    };
    const spanRow = layoutVisibleSpans(spans, [date]).rows[0]!;
    renderAllDaySpanLayer(
      handles.allDaySpanLayerEl,
      spanRow,
      [date],
      allDayCallbacks,
      tagGroups,
      this.spanInteractions,
      'timegrid',
    );
    day.allDayCellEl.style.setProperty('--tc-span-lane-count', String(spanRow.laneCount));
    if (installCellBindings) {
      renderAllDayCell(day.allDayCellEl, date, [], plain, deadlines, allDayCallbacks, tagGroups);
      const allDayItems = day.allDayCellEl.createDiv({ cls: 'tc-tg-cell-items' });
      for (const child of Array.from(day.allDayCellEl.children)) {
        if (child !== allDayItems) allDayItems.appendChild(child);
      }
      return;
    }

    const allDayItems = day.allDayCellEl.querySelector<HTMLElement>(':scope > .tc-tg-cell-items');
    if (!allDayItems) return;
    allDayItems.empty();
    const scratch = day.allDayCellEl.ownerDocument.createElement('div');
    renderAllDayCell(scratch, date, [], plain, deadlines, allDayCallbacks, tagGroups);
    for (const child of Array.from(scratch.children)) allDayItems.appendChild(child);
    const scratchHook = (scratch as unknown as { __tgTestEndDrag?: (targetDate: string) => void })
      .__tgTestEndDrag;
    if (scratchHook) {
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
    if (this.nowLineIntervalId !== null) {
      window.clearInterval(this.nowLineIntervalId);
      this.nowLineIntervalId = null;
    }
  }
}
