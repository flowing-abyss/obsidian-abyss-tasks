import { Component, type App } from 'obsidian';
import { weekStartOffset } from '../domain/weekGridOffset';
import type { LinkToken } from '../parser/links';
import type { ResolvedConfig } from '../settings/types';
import type { StatusRegistry } from '../status/StatusRegistry';
import type { TaskSnapshot } from '../tasks';
import { createTaskCard } from '../ui/TaskCard';
import { BaseView } from './BaseView';
import type { CalendarTaskSource } from './calendarOccurrences';
import { getTasksForDate, renderTaskGroup } from './taskGrouping';
import {
  applyOccurrenceDomState,
  bindMaterializedInteractions,
  createForecastTaskCard,
} from './timegrid/renderTaskMeta';

export interface MonthViewCallbacks {
  app: App;
  forecastMenuOwner?: import('./timegrid/renderTaskMeta').ForecastContextMenuOwner;
  onToggle: (task: TaskSnapshot) => void;
  onCellClick: (date: string) => void;
  onWeekClick: (weekNr: string, year: string) => void;
  onTaskClick: (task: TaskSnapshot) => void;
  onDrop: (dragData: string, targetDate: string) => void;
  onOpenNote: (task: TaskSnapshot) => void;
  onEditLink?: (task: TaskSnapshot, occurrenceIndex: number, token: LinkToken) => void;
  statusRegistry: StatusRegistry;
  onContextMenu: (ev: MouseEvent, task: TaskSnapshot) => void;
  onForecastClick?: (
    source: CalendarTaskSource,
    referenceDate: import('../tasks').LocalDate,
  ) => void;
  onForecastContextMenu?: (
    source: CalendarTaskSource,
    referenceDate: import('../tasks').LocalDate,
  ) => void;
}

export class MonthView extends BaseView {
  private containerEl: HTMLElement | null = null;
  private md = new Component();

  constructor(private callbacks: MonthViewCallbacks) {
    super();
  }

  render(container: HTMLElement, tasks: TaskSnapshot[], config: ResolvedConfig): void {
    this.md.unload();
    this.md = new Component();
    this.md.load();

    this.containerEl = container;
    container.empty();

    const today = window.moment().format('YYYY-MM-DD');
    const tDay = window.moment().format('d');
    const tMonth = window.moment().format('M');
    const tYear = window.moment().format('YYYY');

    const month = config.startPosition
      ? window.moment(config.startPosition, 'YYYY-MM').date(1)
      : window.moment().date(1);

    const firstDayOfMonth = parseInt(window.moment(month).format('d'));
    const lastDateOfMonth = parseInt(window.moment(month).endOf('month').format('D'));

    const grid = container.createDiv('grid');

    // Day headers row
    const gridHeads = grid.createDiv('gridHeads');
    gridHeads.createDiv('gridHead'); // empty corner for week number column

    const monthOffset = weekStartOffset(firstDayOfMonth, config.firstDayOfWeek);
    for (let h = monthOffset; h < monthOffset + 7; h++) {
      const m = window.moment(month).add(h, 'days');
      const weekDayNr = m.format('d');
      const isToday =
        tDay === weekDayNr &&
        tMonth === window.moment(month).format('M') &&
        tYear === window.moment(month).format('YYYY');

      const head = gridHeads.createDiv({ cls: isToday ? 'gridHead today' : 'gridHead' });
      head.setAttribute('data-weekday', weekDayNr);
      head.textContent = m.format('ddd');
    }

    // Week rows
    const wrappersEl = grid.createDiv('wrappers');
    wrappersEl.setAttribute(
      'data-month',
      window.moment(month).format('MMM').replace('.', '').substring(0, 3),
    );

    let starts = monthOffset;

    for (let w = 1; w < 7; w++) {
      const weekNr = window.moment(month).add(starts, 'days').format('w');
      const yearNr = window.moment(month).add(starts, 'days').format('YYYY');

      const wrapper = wrappersEl.createDiv('wrapper');
      const wBtn = wrapper.createDiv('wrapperButton');
      wBtn.setAttribute('data-week', weekNr);
      wBtn.setAttribute('data-year', yearNr);
      wBtn.textContent = 'W' + weekNr;
      wBtn.addEventListener('click', () => this.callbacks.onWeekClick(weekNr, yearNr));

      for (let i = starts; i < starts + 7; i++) {
        const currentDate = window.moment(month).add(i, 'days').format('YYYY-MM-DD');
        const weekDay = window.moment(month).add(i, 'days').format('d');
        const isFirstOfMonth = window.moment(month).add(i, 'days').format('D') === '1';
        const dayLabel = isFirstOfMonth
          ? window.moment(month).add(i, 'days').format('D. MMM')
          : window.moment(month).add(i, 'days').format('D');
        const inCurrentMonth =
          window.moment(month).format('MM') === window.moment(month).add(i, 'days').format('MM');

        let cellCls = 'cell ';
        if (i < 0) cellCls += 'prevMonth';
        else if (i >= lastDateOfMonth) cellCls += 'nextMonth';
        else if (currentDate === today) cellCls += 'currentMonth today';
        else cellCls += 'currentMonth';
        if (isFirstOfMonth) cellCls += ' newMonth';

        const cell = wrapper.createDiv({ cls: cellCls });
        cell.setAttribute('data-weekday', weekDay);

        const dailyNotePath = config.dailyNoteFolder
          ? `${config.dailyNoteFolder}/${currentDate}`
          : currentDate;
        const cellLink = cell.createEl('a', { cls: 'internal-link cellName', href: dailyNotePath });
        cellLink.textContent = dayLabel;

        const cellContent = cell.createDiv('cellContent');

        // Render tasks for all visible cells (prev month, current month, next month)
        this.renderTasksForDate(cellContent, tasks, currentDate, today);

        if (inCurrentMonth) {
          cell.addEventListener('click', (e) => {
            if ((e.target as HTMLElement).closest('.task')) return;
            if ((e.target as HTMLElement).closest('.cellName')) return;
            this.callbacks.onCellClick(currentDate);
          });
        }
      }

      starts += 7;
    }
  }

  private renderTasksForDate(
    container: HTMLElement,
    tasks: TaskSnapshot[],
    date: string,
    today: string,
  ): void {
    const groups = getTasksForDate(tasks, date, today);
    const onEditLink = this.callbacks.onEditLink;
    renderTaskGroup(container, groups, date, today, (task, cls, occurrence) => {
      if (occurrence.kind === 'forecast') {
        return createForecastTaskCard(
          task,
          cls,
          occurrence,
          date as import('../tasks').LocalDate,
          this.callbacks,
        );
      }
      const card = createTaskCard(task, cls, {
        app: this.callbacks.app,
        component: this.md,
        onToggle: this.callbacks.onToggle,
        onOpenNote: this.callbacks.onOpenNote,
        onEditLink: onEditLink ? (occ, token) => onEditLink(task, occ, token) : undefined,
        statusRegistry: this.callbacks.statusRegistry,
        onContextMenu: this.callbacks.onContextMenu,
      });
      applyOccurrenceDomState(card, occurrence, 'single', `${cls}-body`);
      bindMaterializedInteractions(occurrence, (target) => {
        if (target.type === 'task') {
          card.setAttribute('draggable', 'true');
          card.addEventListener('dragstart', (e) => {
            e.dataTransfer?.setData('text/plain', `${task.source.filePath}:::${task.source.line}`);
            if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
            card.addClass('is-dragging');
          });
          card.addEventListener('dragend', () => card.removeClass('is-dragging'));
        }
        card.addEventListener('click', (e) => {
          e.stopPropagation();
          this.callbacks.onTaskClick(task);
        });
      });

      return card;
    });

    // Drop target on cellContent
    container.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      container.addClass('is-drag-over');
    });
    container.addEventListener('dragleave', (e) => {
      // Only remove if leaving the container entirely (not entering a child)
      if (!container.contains(e.relatedTarget as Node)) {
        container.removeClass('is-drag-over');
      }
    });
    container.addEventListener('drop', (e) => {
      e.preventDefault();
      container.removeClass('is-drag-over');
      const dragData = e.dataTransfer?.getData('text/plain');
      if (dragData) this.callbacks.onDrop(dragData, date);
    });
  }

  destroy(): void {
    this.containerEl = null;
    this.md.unload();
  }
}
