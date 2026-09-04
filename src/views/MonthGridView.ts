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
  if (kind === 'timed') return 'abyss-mg-block-dot';
  if (kind === 'plain') return 'abyss-mg-plain';
  return 'abyss-mg-deadline-marker';
}

function monthCompactSpanRole(task: TaskSnapshot, kind: MonthCompactKind): string {
  if (kind === 'deadline') return 'due-deadline';
  if (task.planning.scheduled != null && task.planning.scheduled !== task.planning.due) {
    return 'scheduled-body';
  }
  return kind === 'timed' ? 'timed-body' : 'all-day-body';
}

type MonthGridMoment = ReturnType<typeof window.moment>;

interface MonthGridRenderContext {
  readonly tasks: TaskSnapshot[];
  readonly config: ResolvedConfig;
  readonly today: string;
  readonly month: MonthGridMoment;
  readonly monthOffset: number;
  readonly visibleDates: readonly string[];
  readonly monthRows: readonly MonthVisibleRow[];
  readonly occurrenceFor: CalendarOccurrenceLookup;
  readonly spanCallbacks: AllDayCallbacks;
}

interface MonthGridPatchContext {
  readonly monthRows: readonly MonthVisibleRow[];
  readonly occurrenceFor: CalendarOccurrenceLookup;
  readonly spanCallbacks: AllDayCallbacks;
}

function configuredMonth(startPosition: string): MonthGridMoment {
  return startPosition !== ''
    ? window.moment(startPosition, 'YYYY-MM').date(1)
    : window.moment().date(1);
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
  onWeekClick: (weekNr: string, year: string) => void;
  statusRegistry: StatusRegistry;
  tagGroups?: TagGroup[];
}

export class MonthGridView extends BaseView {
  private containerEl: HTMLElement | null = null;
  private skeletonKey: string | null = null;
  private visibleDates: string[] = [];
  private md = new Component();
  private readonly spanInteractions = createSpanInteractionOwner();

  constructor(private readonly callbacks: MonthGridViewCallbacks) {
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
    const month = configuredMonth(config.startPosition);
    const firstDayOfMonth = parseInt(window.moment(month).format('d'), 10);
    this.skeletonKey = this.buildSkeletonKey(month.format('YYYY-MM'), config);

    const monthOffset = weekStartOffset(firstDayOfMonth, config.firstDayOfWeek);
    const grid = container.createDiv({ cls: 'abyss-mg-grid' });
    this.renderHeader(grid, month, monthOffset);
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
    this.renderRows(grid, {
      tasks,
      config,
      today,
      month,
      monthOffset,
      visibleDates,
      monthRows,
      occurrenceFor,
      spanCallbacks,
    });
  }

  private renderHeader(grid: HTMLElement, month: MonthGridMoment, monthOffset: number): void {
    const row = grid.createDiv({ cls: 'abyss-mg-head-row' });
    row.createDiv({ cls: 'abyss-mg-week-head' });
    for (let offset = monthOffset; offset < monthOffset + 7; offset++) {
      row.createDiv({
        cls: 'abyss-mg-head',
        text: window.moment(month).add(offset, 'days').format('ddd'),
      });
    }
  }

  private renderRows(grid: HTMLElement, context: MonthGridRenderContext): void {
    for (let rowIndex = 0; rowIndex < 6; rowIndex++) {
      const monthRow = context.monthRows[rowIndex];
      if (monthRow === undefined) continue;
      this.renderRow(grid, rowIndex, monthRow, context);
    }
  }

  private renderRow(
    grid: HTMLElement,
    rowIndex: number,
    monthRow: MonthVisibleRow,
    context: MonthGridRenderContext,
  ): void {
    const startIndex = context.monthOffset + rowIndex * 7;
    const row = grid.createDiv({ cls: 'abyss-mg-row' });
    const weekStart = window.moment(context.month).add(startIndex, 'days');
    const weekNr = weekStart.format('w');
    const yearNr = weekStart.format('YYYY');
    const weekButton = row.createDiv({ cls: 'abyss-mg-week-btn', text: weekNr });
    weekButton.setAttribute('data-week', weekNr);
    weekButton.setAttribute('data-year', yearNr);
    weekButton.addEventListener('click', (event) => {
      event.stopPropagation();
      this.callbacks.onWeekClick(weekNr, yearNr);
    });
    for (let index = startIndex; index < startIndex + 7; index++) {
      this.renderCell(row, index, monthRow, context);
    }
    const rowDates = context.visibleDates.slice(rowIndex * 7, rowIndex * 7 + 7);
    renderAllDaySpanLayer(
      row.createDiv({ cls: 'abyss-mg-span-layer' }),
      monthRow.spanRow,
      rowDates,
      context.spanCallbacks,
      this.callbacks.tagGroups ?? [],
      this.spanInteractions,
      'month',
    );
  }

  private renderCell(
    row: HTMLElement,
    index: number,
    monthRow: MonthVisibleRow,
    context: MonthGridRenderContext,
  ): void {
    const day = window.moment(context.month).add(index, 'days');
    const currentDate = day.format('YYYY-MM-DD');
    const inCurrentMonth = window.moment(context.month).format('MM') === day.format('MM');
    const cell = row.createDiv({
      cls: `abyss-mg-cell${currentDate === context.today ? ' is-today' : ''}${inCurrentMonth ? '' : ' is-outside-month'}`,
    });
    cell.setAttribute('data-mg-date', currentDate);
    this.renderCellControls(cell, currentDate, day.format('D'), context.config.dailyNoteFolder);
    const items = cell.createDiv({ cls: 'abyss-mg-cell-items' });
    this.renderCompactCell(
      items,
      monthRow.compactByDate.get(currentDate) ?? [],
      context.occurrenceFor,
    );
    cell.style.setProperty('--abyss-span-lane-count', String(monthRow.slotCount));
    this.bindCellInteractions(cell, currentDate, inCurrentMonth);
  }

  private renderCellControls(
    cell: HTMLElement,
    currentDate: string,
    dayLabel: string,
    dailyNoteFolder: string,
  ): void {
    const path = dailyNoteFolder !== '' ? `${dailyNoteFolder}/${currentDate}` : currentDate;
    const link = cell.createEl('a', {
      cls: 'internal-link abyss-mg-day-label',
      href: path,
      text: dayLabel,
    });
    link.addEventListener('click', (event) => {
      event.stopPropagation();
      this.callbacks.onDayClick(currentDate);
    });
    const addButton = cell.createEl('button', {
      cls: 'abyss-mg-add-btn',
      attr: { type: 'button', 'aria-label': 'Add task', title: 'Add task' },
      text: '+',
    });
    addButton.addEventListener('click', (event) => {
      event.stopPropagation();
      this.callbacks.onCreateAtDate(currentDate);
    });
  }

  private bindCellInteractions(
    cell: HTMLElement,
    currentDate: string,
    inCurrentMonth: boolean,
  ): void {
    if (inCurrentMonth) {
      cell.addEventListener('click', (event) => {
        const interactive = (event.target as HTMLElement).closest(
          '.abyss-mg-plain, .abyss-mg-block-dot, .abyss-mg-span-segment, .abyss-mg-deadline-marker, .abyss-mg-day-label, .abyss-mg-add-btn, .abyss-mg-quick-add',
        );
        if (interactive === null) this.callbacks.onDayClick(currentDate);
      });
    }
    cell.addEventListener('dragover', (event) => {
      event.preventDefault();
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move';
    });
    cell.addEventListener('drop', (event) => {
      event.preventDefault();
      const dragData = event.dataTransfer?.getData('text/plain');
      if (dragData !== undefined && dragData.length > 0)
        this.callbacks.onDrop(dragData, currentDate);
    });
  }

  override patch(container: HTMLElement, tasks: TaskSnapshot[], config: ResolvedConfig): void {
    const month = configuredMonth(config.startPosition);
    const requiresRender =
      container !== this.containerEl ||
      this.skeletonKey !== this.buildSkeletonKey(month.format('YYYY-MM'), config) ||
      this.visibleDates.length !== 42;
    if (requiresRender) {
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
    const rows = Array.from(container.querySelectorAll<HTMLElement>('.abyss-mg-row'));
    for (const [rowIndex, row] of rows.entries()) {
      this.patchRow(row, rowIndex, { monthRows, occurrenceFor, spanCallbacks });
    }
  }

  private patchRow(row: HTMLElement, rowIndex: number, context: MonthGridPatchContext): void {
    const monthRow = context.monthRows[rowIndex];
    if (monthRow === undefined) return;
    const rowDates = this.visibleDates.slice(rowIndex * 7, rowIndex * 7 + 7);
    for (const date of rowDates) {
      const cell = row.querySelector<HTMLElement>(`.abyss-mg-cell[data-mg-date="${date}"]`);
      const items = cell?.querySelector<HTMLElement>(':scope > .abyss-mg-cell-items');
      if (cell === null || items === undefined || items === null) continue;
      items.empty();
      this.renderCompactCell(items, monthRow.compactByDate.get(date) ?? [], context.occurrenceFor);
      cell.style.setProperty('--abyss-span-lane-count', String(monthRow.slotCount));
    }
    const layer = row.querySelector<HTMLElement>(':scope > .abyss-mg-span-layer');
    if (layer === null) return;
    renderAllDaySpanLayer(
      layer,
      monthRow.spanRow,
      rowDates,
      context.spanCallbacks,
      this.callbacks.tagGroups ?? [],
      this.spanInteractions,
      'month',
    );
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
        occurrence.kind === 'materialized'
          ? (slot) => {
              this.renderMarker(slot, t);
            }
          : undefined,
      );
      if (kind === 'timed')
        item.createSpan({ cls: 'abyss-mg-item-time', text: `${t.planning.time} ` });
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
   * `.abyss-mg-item-title` (Task 21) makes it the flex child that truncates independently —
   * the container (.abyss-mg-plain/-block-dot/-span-segment/-deadline-marker) is a flex row
   * (marker + [time] + title) instead of block-stacking, matching renderTimedBlocks.ts's
   * `.abyss-tg-block-head` pattern. Task 32 removed the trailing tag-chip/count-badge meta
   * row (`.abyss-mg-item-meta`) that Round 3 Task 13 added here — Month cells are small
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
    const titleEl = container.createSpan({
      cls: `abyss-mg-item-title${statusTitleClass(t.status)}`,
    });
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
      onLeftClick: () => {
        this.callbacks.onToggle(t);
      },
      onContextMenu: (ev) => {
        ev.stopPropagation();
        showStatusMenuAt(ev, {
          task: t,
          registry: this.callbacks.statusRegistry,
          owner: this.md,
          onPickStatus: (c) => {
            this.callbacks.onSetStatus(t, c);
          },
          onPickPriority: (p) => {
            this.callbacks.onSetPriority(t, p);
          },
          ...(this.callbacks.interactionOwnership != null && {
            interactionOwnership: this.callbacks.interactionOwnership,
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
      if (e.dataTransfer != null) e.dataTransfer.effectAllowed = 'move';
      el.addClass('is-dragging');
    });
    el.addEventListener('dragend', () => {
      el.removeClass('is-dragging');
    });
  }

  /**
   * Tag-colored fill only — the priority-colored border was removed (Task 12): the
   * status marker already conveys priority via its own border, so a second priority
   * border on the compact item itself was redundant visual noise.
   */
  private applyTagFill(el: HTMLElement, t: TaskSnapshot, tagGroups: TagGroup[]): void {
    const tagColor = tagColorFor(t.tags, tagGroups);
    if (tagColor !== undefined && tagColor.length > 0) {
      el.setCssProps({ '--abyss-tag-color': tagColor });
      // Task 40 (Round 4): see tagFillContrast.ts's own doc comment — a fixed text color loses
      // contrast against a bright/pale or very dark/desaturated tag fill; only overridden when a
      // variant was actually computed, otherwise the CSS rule's var(--text-normal) fallback holds.
      const textColorVar = tagFillTextColorVar(el, tagColor);
      if (textColorVar !== undefined && textColorVar.length > 0) {
        el.setCssProps({ '--abyss-tag-text-color': textColorVar });
      }
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
