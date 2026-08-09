import { Component, type App } from 'obsidian';
import { weekStartOffset } from '../domain/weekGridOffset';
import type { ResolvedConfig, TagGroup } from '../settings/types';
import type { StatusRegistry } from '../status/StatusRegistry';
import { tagColorFor } from '../tags/tagColor';
import { tagFillTextColorVar } from '../tags/tagFillContrast';
import type { TaskPriority, TaskSnapshot } from '../tasks';
import { renderTaskText } from '../ui/renderTaskText';
import { renderStatusMarker } from '../ui/StatusMarker';
import { showStatusMenuAt } from '../ui/statusMenu';
import { statusTitleClass } from '../ui/statusTitleClass';
import { BaseView } from './BaseView';
import {
  layoutVisibleMonth,
  layoutVisibleMonthWithReplacement,
  type MonthCompactKind,
  type MonthCompactSlot,
  type MonthVisibleRow,
} from './monthLayout';
import {
  createSpanInteractionOwner,
  type InteractiveSpanBoundaryTarget,
  type SpanMoveTarget,
} from './spanInteractions';
import { renderAllDaySpanLayer, type AllDayCallbacks } from './timegrid/renderAllDay';
import {
  applyOccurrenceDomState,
  bindForecastInteractions,
  bindMaterializedInteractions,
  calendarOccurrenceLookup,
  renderCalendarLeadingSlots,
  type CalendarOccurrenceLookup,
  type ForecastInteractionCallbacks,
} from './timegrid/renderTaskMeta';

function monthCompactClass(kind: MonthCompactKind): string {
  if (kind === 'timed') return 'tc-mg-block-dot';
  if (kind === 'plain') return 'tc-mg-plain';
  return 'tc-mg-deadline-marker';
}

function monthCompactSpanRole(task: TaskSnapshot, kind: MonthCompactKind): string {
  if (kind === 'deadline') return 'due-deadline';
  if (task.planning.scheduled && task.planning.scheduled !== task.planning.due) {
    return 'scheduled-body';
  }
  return kind === 'timed' ? 'timed-body' : 'all-day-body';
}

export interface MonthGridViewCallbacks extends ForecastInteractionCallbacks {
  app: App;
  onDayClick: (date: string) => void;
  onCreateAtDate: (date: string) => void;
  onTaskClick: (task: TaskSnapshot) => void;
  onDrop: (dragData: string, targetDate: string) => void;
  onSpanMove?: (task: TaskSnapshot, target: SpanMoveTarget) => void;
  onSpanBoundary?: (task: TaskSnapshot, target: InteractiveSpanBoundaryTarget) => void;
  onToggle: (task: TaskSnapshot) => void;
  onSetStatus: (task: TaskSnapshot, status: string) => void;
  onSetPriority: (task: TaskSnapshot, priority: TaskPriority) => void;
  onEditRepeat?: (task: TaskSnapshot, anchor: HTMLElement) => void;
  onWeekClick: (weekNr: string, year: string) => void;
  statusRegistry: StatusRegistry;
  tagGroups?: TagGroup[];
}

export class MonthGridView extends BaseView {
  private containerEl: HTMLElement | null = null;
  private skeletonKey: string | null = null;
  private visibleDates: string[] = [];
  private md = new Component();
  private spanInteractions = createSpanInteractionOwner();

  constructor(private callbacks: MonthGridViewCallbacks) {
    super();
  }

  render(container: HTMLElement, tasks: TaskSnapshot[], config: ResolvedConfig): void {
    this.spanInteractions.disposeActive();
    this.md.unload();
    this.md = new Component();
    this.md.load();

    this.containerEl = container;
    container.empty();

    const today = window.moment().format('YYYY-MM-DD');
    const month = config.startPosition
      ? window.moment(config.startPosition, 'YYYY-MM').date(1)
      : window.moment().date(1);
    const firstDayOfMonth = parseInt(window.moment(month).format('d'), 10);
    this.skeletonKey = this.buildSkeletonKey(month.format('YYYY-MM'), config);

    const grid = container.createDiv({ cls: 'tc-mg-grid' });
    const headRow = grid.createDiv({ cls: 'tc-mg-head-row' });
    headRow.createDiv({ cls: 'tc-mg-week-head' }); // empty corner, aligns with the week-number column
    const monthOffset = weekStartOffset(firstDayOfMonth, config.firstDayOfWeek);
    for (let h = monthOffset; h < monthOffset + 7; h++) {
      headRow.createDiv({
        cls: 'tc-mg-head',
        text: window.moment(month).add(h, 'days').format('ddd'),
      });
    }

    const visibleDates = Array.from({ length: 42 }, (_, index) =>
      window
        .moment(month)
        .add(monthOffset + index, 'days')
        .format('YYYY-MM-DD'),
    );
    this.visibleDates = visibleDates;
    const occurrenceFor = calendarOccurrenceLookup(tasks);
    const monthRows = layoutVisibleMonth(tasks, visibleDates).rows;
    const spanCallbacks = this.buildSpanCallbacks(tasks, occurrenceFor);

    let starts = monthOffset;
    for (let w = 0; w < 6; w++) {
      const row = grid.createDiv({ cls: 'tc-mg-row' });
      const rowDates = visibleDates.slice(w * 7, w * 7 + 7);
      const monthRow: MonthVisibleRow = monthRows[w]!;
      const spanRow = monthRow.spanRow;

      // Week-number column: clicking it drills into the Week view for that ISO week
      // (mirrors legacy MonthView.ts's wrapperButton pattern exactly).
      const weekNr = window.moment(month).add(starts, 'days').format('w');
      const yearNr = window.moment(month).add(starts, 'days').format('YYYY');
      const weekBtn = row.createDiv({ cls: 'tc-mg-week-btn', text: weekNr });
      weekBtn.setAttribute('data-week', weekNr);
      weekBtn.setAttribute('data-year', yearNr);
      weekBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.callbacks.onWeekClick(weekNr, yearNr);
      });

      for (let i = starts; i < starts + 7; i++) {
        const currentDate = window.moment(month).add(i, 'days').format('YYYY-MM-DD');
        const inCurrentMonth =
          window.moment(month).format('MM') === window.moment(month).add(i, 'days').format('MM');
        const cell = row.createDiv({
          cls: `tc-mg-cell${currentDate === today ? ' is-today' : ''}${inCurrentMonth ? '' : ' is-outside-month'}`,
        });
        cell.setAttribute('data-mg-date', currentDate);

        // Daily-note link (preserved from the legacy MonthView per spec) — opens/creates the
        // note directly; distinct from clicking elsewhere in the cell, which drills to Week.
        const dailyNotePath = config.dailyNoteFolder
          ? `${config.dailyNoteFolder}/${currentDate}`
          : currentDate;
        const dayLink = cell.createEl('a', {
          cls: 'internal-link tc-mg-day-label',
          href: dailyNotePath,
          text: window.moment(month).add(i, 'days').format('D'),
        });
        // Direct, unconditional drill-down: the day number is the one click target that's
        // always present regardless of how full the cell is (Task 32) — a fully-packed cell
        // may have no empty space left for the cell's own click handler below to catch, so
        // this doesn't route through that handler's item-exclusion guard at all.
        // stopPropagation avoids the cell handler also evaluating the same click (harmless
        // since it already excludes .tc-mg-day-label, but keeps the intent explicit).
        dayLink.addEventListener('click', (e) => {
          e.stopPropagation();
          this.callbacks.onDayClick(currentDate);
        });

        // Hover-visible "+" affordance: a second meaning for clicking a day cell
        // (create a task) can't share plain left-click with the existing drill-into-Week
        // behavior below, so it gets its own small button instead (stops propagation so
        // it never also fires onDayClick).
        const addBtn = cell.createEl('button', {
          cls: 'tc-mg-add-btn',
          attr: { type: 'button', 'aria-label': 'Add task', title: 'Add task' },
          text: '+',
        });
        addBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.callbacks.onCreateAtDate(currentDate);
        });

        const items = cell.createDiv({ cls: 'tc-mg-cell-items' });
        this.renderCompactCell(items, monthRow.compactByDate.get(currentDate) ?? [], occurrenceFor);
        cell.style.setProperty('--tc-span-lane-count', String(monthRow.slotCount));

        if (inCurrentMonth) {
          cell.addEventListener('click', (e) => {
            if (
              (e.target as HTMLElement).closest(
                '.tc-mg-plain, .tc-mg-block-dot, .tc-mg-span-segment, .tc-mg-deadline-marker, .tc-mg-day-label, .tc-mg-add-btn, .tc-mg-quick-add',
              )
            )
              return;
            this.callbacks.onDayClick(currentDate);
          });
        }
        cell.addEventListener('dragover', (e) => {
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        });
        cell.addEventListener('drop', (e) => {
          e.preventDefault();
          const dragData = e.dataTransfer?.getData('text/plain');
          if (dragData) this.callbacks.onDrop(dragData, currentDate);
        });
      }
      const layer = row.createDiv({ cls: 'tc-mg-span-layer' });
      renderAllDaySpanLayer(
        layer,
        spanRow,
        rowDates,
        spanCallbacks,
        this.callbacks.tagGroups ?? [],
        this.spanInteractions,
        'month',
      );
      starts += 7;
    }
  }

  override patch(container: HTMLElement, tasks: TaskSnapshot[], config: ResolvedConfig): void {
    const month = config.startPosition
      ? window.moment(config.startPosition, 'YYYY-MM').date(1)
      : window.moment().date(1);
    if (
      container !== this.containerEl ||
      this.skeletonKey !== this.buildSkeletonKey(month.format('YYYY-MM'), config) ||
      this.visibleDates.length !== 42
    ) {
      this.render(container, tasks, config);
      return;
    }

    this.spanInteractions.disposeActive();
    this.md.unload();
    this.md = new Component();
    this.md.load();

    const occurrenceFor = calendarOccurrenceLookup(tasks);
    const monthRows = layoutVisibleMonth(tasks, this.visibleDates).rows;
    const spanCallbacks = this.buildSpanCallbacks(tasks, occurrenceFor);
    const rows = Array.from(container.querySelectorAll<HTMLElement>('.tc-mg-row'));
    for (const [rowIndex, row] of rows.entries()) {
      const monthRow: MonthVisibleRow | undefined = monthRows[rowIndex];
      if (!monthRow) continue;
      const spanRow = monthRow.spanRow;
      const rowDates = this.visibleDates.slice(rowIndex * 7, rowIndex * 7 + 7);
      for (const date of rowDates) {
        const cell = row.querySelector<HTMLElement>(`.tc-mg-cell[data-mg-date="${date}"]`);
        const items = cell?.querySelector<HTMLElement>(':scope > .tc-mg-cell-items');
        if (!cell || !items) continue;
        items.empty();
        this.renderCompactCell(items, monthRow.compactByDate.get(date) ?? [], occurrenceFor);
        cell.style.setProperty('--tc-span-lane-count', String(monthRow.slotCount));
      }
      const layer = row.querySelector<HTMLElement>(':scope > .tc-mg-span-layer');
      if (!layer) continue;
      renderAllDaySpanLayer(
        layer,
        spanRow,
        rowDates,
        spanCallbacks,
        this.callbacks.tagGroups ?? [],
        this.spanInteractions,
        'month',
      );
    }
  }

  private buildSkeletonKey(month: string, config: ResolvedConfig): string {
    return [
      month,
      config.firstDayOfWeek,
      config.dailyNoteFolder,
      window.moment().format('YYYY-MM-DD'),
    ].join('|');
  }

  private buildSpanCallbacks(
    tasks: readonly TaskSnapshot[],
    occurrenceFor: CalendarOccurrenceLookup,
  ): AllDayCallbacks {
    return {
      occurrenceFor,
      app: this.callbacks.app,
      component: this.md,
      onTaskClick: this.callbacks.onTaskClick,
      onDrop: this.callbacks.onDrop,
      onStartChange: (task, date) =>
        this.callbacks.onSpanBoundary?.(task, {
          boundary: 'start',
          date: date as never,
          dayDelta: 0,
        }),
      onDueChange: (task, date) =>
        this.callbacks.onSpanBoundary?.(task, {
          boundary: 'due',
          date: date as never,
          dayDelta: 0,
        }),
      onExtendToSpan: (task, date) =>
        this.callbacks.onSpanBoundary?.(task, {
          boundary: 'create-span',
          date: date as never,
          dayDelta: 0,
        }),
      onSpanMove: this.callbacks.onSpanMove,
      onSpanBoundary: this.callbacks.onSpanBoundary,
      spanInteractionOwner: this.spanInteractions,
      spanPreviewLayoutFor: (task, planning) => {
        const layout = layoutVisibleMonthWithReplacement(tasks, this.visibleDates, task, planning);
        return { rows: layout.rows.map((row) => row.spanRow) };
      },
      onToggle: this.callbacks.onToggle,
      onSetStatus: this.callbacks.onSetStatus,
      onSetPriority: this.callbacks.onSetPriority,
      ...(this.callbacks.onEditRepeat && { onEditRepeat: this.callbacks.onEditRepeat }),
      ...(this.callbacks.onForecastClick && {
        onForecastClick: this.callbacks.onForecastClick,
      }),
      ...(this.callbacks.onForecastContextMenu && {
        onForecastContextMenu: this.callbacks.onForecastContextMenu,
      }),
      statusRegistry: this.callbacks.statusRegistry,
    };
  }

  private renderCompactCell(
    cell: HTMLElement,
    entries: readonly MonthCompactSlot[],
    occurrenceFor: CalendarOccurrenceLookup,
  ): void {
    const tagGroups = this.callbacks.tagGroups ?? [];

    for (const { task: t, kind, slot } of entries) {
      const item = cell.createDiv({ cls: monthCompactClass(kind) });
      const occurrence = occurrenceFor(t);
      const spanRole = monthCompactSpanRole(t, kind);
      applyOccurrenceDomState(item, occurrence, 'single', spanRole);
      item.style.gridRow = String(slot + 1);
      this.applyTagFill(item, t, tagGroups);
      renderCalendarLeadingSlots(
        item,
        t.recurrence,
        occurrence.kind === 'forecast',
        occurrence.kind === 'materialized' ? (slot) => this.renderMarker(slot, t) : undefined,
      );
      if (kind === 'timed')
        item.createSpan({ cls: 'tc-mg-item-time', text: `${t.planning.time} ` });
      if (kind === 'deadline') item.createSpan({ text: '📅 ' });
      this.renderTitle(item, t, occurrence.kind === 'forecast');
      bindMaterializedInteractions(occurrence, () => {
        item.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.callbacks.onTaskClick(t);
        });
        if (kind !== 'deadline') this.makeDraggable(item, t, occurrence.source.target.type);
      });
      bindForecastInteractions(item, occurrence, this.callbacks);
    }
  }

  /**
   * Renders the task's markdown/wiki-link-aware title text as a trailing inline span.
   * `.tc-mg-item-title` (Task 21) makes it the flex child that truncates independently —
   * the container (.tc-mg-plain/-block-dot/-span-segment/-deadline-marker) is a flex row
   * (marker + [time] + title) instead of block-stacking, matching renderTimedBlocks.ts's
   * `.tc-tg-block-head` pattern. Task 32 removed the trailing tag-chip/count-badge meta
   * row (`.tc-mg-item-meta`) that Round 3 Task 13 added here — Month cells are small
   * enough that it made them feel cluttered; that meta row is kept on Day/Week's timed
   * blocks (renderTaskMeta.ts) and all-day items, just not on Month's compact items.
   *
   * Task 38 follow-up: also applies the same is-done/is-cancelled strikethrough convention
   * timed blocks/continuation segments and all-day items already use (statusTitleClass) — this
   * is the single title-rendering path shared by every compact item type (timed, span,
   * timedSpan, plain, AND deadline markers, see renderCompactCell above), so one change here
   * covers all of them.
   */
  private renderTitle(container: HTMLElement, t: TaskSnapshot, forecast: boolean): void {
    const titleEl = container.createSpan({ cls: `tc-mg-item-title${statusTitleClass(t.status)}` });
    if (forecast) {
      titleEl.setText(t.title);
      return;
    }
    renderTaskText(titleEl, t.markdownTitle, {
      app: this.callbacks.app,
      sourcePath: t.source.filePath,
      component: this.md,
    });
  }

  // Status marker first: lets a user mark a compact item done without opening the modal. Its
  // own contextmenu handler stops propagation and opens the status/priority popover instead —
  // distinct from right-clicking the item's own contextmenu handler below (opens the task modal).
  private renderMarker(el: HTMLElement, t: TaskSnapshot): void {
    renderStatusMarker(el, {
      task: t,
      registry: this.callbacks.statusRegistry,
      interactive: true,
      onLeftClick: () => this.callbacks.onToggle(t),
      onContextMenu: (ev) => {
        ev.stopPropagation();
        const anchor = ev.currentTarget as HTMLElement;
        showStatusMenuAt(ev, {
          task: t,
          registry: this.callbacks.statusRegistry,
          onPickStatus: (c) => this.callbacks.onSetStatus(t, c),
          onPickPriority: (p) => this.callbacks.onSetPriority(t, p),
          ...(this.callbacks.onEditRepeat && {
            onEditRepeat: () => this.callbacks.onEditRepeat?.(t, anchor),
          }),
        });
      },
    });
  }

  // Native HTML5 drag source, mirroring renderAllDay.ts's renderDraggableBody pattern
  // exactly: `dragstart`/`dragend` are independent of `click`, so a plain click on a
  // child (status marker, rendered link) inside a draggable item still fires that
  // child's own click handler undisturbed — only an actual drag gesture (pointer moves
  // while down) fires `dragstart`. Deadline markers are deliberately excluded — they
  // stay non-draggable per the existing structural rule (Task 2).
  private makeDraggable(el: HTMLElement, t: TaskSnapshot, targetType: 'task' | 'subtask'): void {
    if (targetType !== 'task') return;
    el.setAttribute('draggable', 'true');
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('text/plain', `${t.source.filePath}:::${t.source.line}`);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      el.addClass('is-dragging');
    });
    el.addEventListener('dragend', () => el.removeClass('is-dragging'));
  }

  /**
   * Tag-colored fill only — the priority-colored border was removed (Task 12): the
   * status marker already conveys priority via its own border, so a second priority
   * border on the compact item itself was redundant visual noise.
   */
  private applyTagFill(el: HTMLElement, t: TaskSnapshot, tagGroups: TagGroup[]): void {
    const tagColor = tagColorFor(t.tags, tagGroups);
    if (tagColor) {
      el.setCssProps({ '--tc-tag-color': tagColor });
      // Task 40 (Round 4): see tagFillContrast.ts's own doc comment — a fixed text color loses
      // contrast against a bright/pale or very dark/desaturated tag fill; only overridden when a
      // variant was actually computed, otherwise the CSS rule's var(--text-normal) fallback holds.
      const textColorVar = tagFillTextColorVar(el, tagColor);
      if (textColorVar) el.setCssProps({ '--tc-tag-text-color': textColorVar });
    }
  }

  destroy(): void {
    this.spanInteractions.disposeActive();
    this.containerEl = null;
    this.skeletonKey = null;
    this.visibleDates = [];
    this.md.unload();
  }
}
