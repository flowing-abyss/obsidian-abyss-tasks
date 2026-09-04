import { Component, type App } from 'obsidian';
import { weekStartOffset } from '../domain/weekGridOffset';
import type { LinkToken } from '../markdown/links';
import type { ResolvedConfig } from '../settings/types';
import type { StatusRegistry } from '../status/StatusRegistry';
import type { LocalDate, TaskSnapshot } from '../tasks';
import { createTaskCard } from '../ui/TaskCard';
import { BaseView } from './BaseView';
import type { CalendarTaskSource } from './calendarOccurrences';
import { getTasksForDate, renderTaskGroup } from './taskGrouping';
import {
  applyOccurrenceDomState,
  bindMaterializedInteractions,
  createForecastTaskCard,
  type ForecastContextMenuOwner,
} from './timegrid/renderTaskMeta';

type MonthMoment = ReturnType<typeof window.moment>;

interface MonthRenderContext {
  readonly tasks: TaskSnapshot[];
  readonly config: ResolvedConfig;
  readonly today: string;
  readonly month: MonthMoment;
  readonly lastDateOfMonth: number;
}

interface MonthCellContext extends MonthRenderContext {
  readonly index: number;
}

function configuredMonth(startPosition: string): MonthMoment {
  return startPosition !== ''
    ? window.moment(startPosition, 'YYYY-MM').date(1)
    : window.moment().date(1);
}

function monthCellClass(context: MonthCellContext, currentDate: string): string {
  const { index, lastDateOfMonth, today } = context;
  if (index < 0) return 'cell prevMonth';
  if (index >= lastDateOfMonth) return 'cell nextMonth';
  return currentDate === today ? 'cell currentMonth today' : 'cell currentMonth';
}

export interface MonthViewCallbacks {
  app: App;
  forecastMenuOwner?: ForecastContextMenuOwner;
  onToggle: (task: TaskSnapshot) => void;
  onCellClick: (date: string) => void;
  onWeekClick: (weekNr: string, year: string) => void;
  onTaskClick: (task: TaskSnapshot) => void;
  onDrop: (dragData: string, targetDate: string) => void;
  onOpenNote: (task: TaskSnapshot) => void;
  onEditLink?: (task: TaskSnapshot, occurrenceIndex: number, token: LinkToken) => void;
  statusRegistry: StatusRegistry;
  onContextMenu: (ev: MouseEvent, task: TaskSnapshot) => void;
  onTaskBodyContextMenu?: (ev: MouseEvent, task: TaskSnapshot, anchor: HTMLElement) => void;
  onForecastClick?: (source: CalendarTaskSource, referenceDate: LocalDate) => void;
  onForecastContextMenu?: (source: CalendarTaskSource, referenceDate: LocalDate) => void;
}

export class MonthView extends BaseView {
  private md = new Component();

  constructor(private readonly callbacks: MonthViewCallbacks) {
    super();
  }

  render(container: HTMLElement, tasks: TaskSnapshot[], config: ResolvedConfig): void {
    this.md.unload();
    this.md = new Component();
    this.md.load();

    container.empty();

    const today = window.moment().format('YYYY-MM-DD');
    const month = configuredMonth(config.startPosition);

    const firstDayOfMonth = parseInt(window.moment(month).format('d'));
    const lastDateOfMonth = parseInt(window.moment(month).endOf('month').format('D'));
    const grid = container.createDiv('grid');
    const monthOffset = weekStartOffset(firstDayOfMonth, config.firstDayOfWeek);
    this.renderDayHeaders(grid, month, monthOffset, today);
    const wrappersEl = grid.createDiv('wrappers');
    wrappersEl.setAttribute(
      'data-month',
      window.moment(month).format('MMM').replace('.', '').substring(0, 3),
    );

    this.renderWeeks(wrappersEl, monthOffset, { tasks, config, today, month, lastDateOfMonth });
  }

  private renderDayHeaders(
    grid: HTMLElement,
    month: MonthMoment,
    monthOffset: number,
    today: string,
  ): void {
    const gridHeads = grid.createDiv('gridHeads');
    gridHeads.createDiv('gridHead');
    for (let offset = monthOffset; offset < monthOffset + 7; offset++) {
      const day = window.moment(month).add(offset, 'days');
      const weekDayNr = day.format('d');
      const head = gridHeads.createDiv({
        cls: day.format('YYYY-MM-DD') === today ? 'gridHead today' : 'gridHead',
      });
      head.setAttribute('data-weekday', weekDayNr);
      head.textContent = day.format('ddd');
    }
  }

  private renderWeeks(
    wrappers: HTMLElement,
    monthOffset: number,
    context: MonthRenderContext,
  ): void {
    for (let week = 0; week < 6; week++) {
      this.renderWeek(wrappers, monthOffset + week * 7, context);
    }
  }

  private renderWeek(wrappers: HTMLElement, startIndex: number, context: MonthRenderContext): void {
    const weekStart = window.moment(context.month).add(startIndex, 'days');
    const weekNr = weekStart.format('w');
    const yearNr = weekStart.format('YYYY');
    const wrapper = wrappers.createDiv('wrapper');
    const button = wrapper.createDiv('wrapperButton');
    button.setAttribute('data-week', weekNr);
    button.setAttribute('data-year', yearNr);
    button.textContent = `W${weekNr}`;
    button.addEventListener('click', () => {
      this.callbacks.onWeekClick(weekNr, yearNr);
    });
    for (let index = startIndex; index < startIndex + 7; index++) {
      this.renderMonthCell(wrapper, { ...context, index });
    }
  }

  private renderMonthCell(wrapper: HTMLElement, context: MonthCellContext): void {
    const day = window.moment(context.month).add(context.index, 'days');
    const currentDate = day.format('YYYY-MM-DD');
    const isFirstOfMonth = day.format('D') === '1';
    const dayLabel = day.format(isFirstOfMonth ? 'D. MMM' : 'D');
    const inCurrentMonth = window.moment(context.month).format('MM') === day.format('MM');
    const firstMonthClass = isFirstOfMonth ? ' newMonth' : '';
    const cell = wrapper.createDiv({
      cls: `${monthCellClass(context, currentDate)}${firstMonthClass}`,
    });
    cell.setAttribute('data-weekday', day.format('d'));
    const folder = context.config.dailyNoteFolder;
    const dailyNotePath = folder !== '' ? `${folder}/${currentDate}` : currentDate;
    const link = cell.createEl('a', { cls: 'internal-link cellName', href: dailyNotePath });
    link.textContent = dayLabel;
    this.renderTasksForDate(
      cell.createDiv('cellContent'),
      context.tasks,
      currentDate,
      context.today,
    );
    if (!inCurrentMonth) return;
    cell.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      if (target.closest('.task') !== null || target.closest('.cellName') !== null) return;
      this.callbacks.onCellClick(currentDate);
    });
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
        return createForecastTaskCard(task, cls, occurrence, {
          renderedDate: date as LocalDate,
          callbacks: this.callbacks,
        });
      }
      const card = createTaskCard(task, cls, {
        app: this.callbacks.app,
        component: this.md,
        onToggle: this.callbacks.onToggle,
        onOpenNote: this.callbacks.onOpenNote,
        onEditLink:
          onEditLink != null
            ? (occ, token) => {
                onEditLink(task, occ, token);
              }
            : undefined,
        statusRegistry: this.callbacks.statusRegistry,
        onContextMenu: this.callbacks.onContextMenu,
        onTaskBodyContextMenu: this.callbacks.onTaskBodyContextMenu,
      });
      applyOccurrenceDomState(card, occurrence, 'single', `${cls}-body`);
      bindMaterializedInteractions(occurrence, (target) => {
        if (target.type === 'task') {
          card.setAttribute('draggable', 'true');
          card.addEventListener('dragstart', (e) => {
            e.dataTransfer?.setData('text/plain', `${task.source.filePath}:::${task.source.line}`);
            if (e.dataTransfer != null) e.dataTransfer.effectAllowed = 'move';
            card.addClass('is-dragging');
          });
          card.addEventListener('dragend', () => {
            card.removeClass('is-dragging');
          });
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
      if (e.dataTransfer != null) e.dataTransfer.dropEffect = 'move';
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
      if (dragData !== undefined && dragData.length > 0) this.callbacks.onDrop(dragData, date);
    });
  }

  destroy(): void {
    this.md.unload();
  }
}
