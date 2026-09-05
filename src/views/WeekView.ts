import { Component, type App } from 'obsidian';
import { resolveWeekStartPosition } from '../domain/weekGridOffset';
import type { LinkToken } from '../markdown/links';
import type { ResolvedConfig } from '../settings/types';
import type { StatusRegistry } from '../status/StatusRegistry';
import type { LocalDate, TaskSnapshot } from '../tasks';
import { createTaskCard, type TaskCardOptions } from '../ui/TaskCard';
import { BaseView } from './BaseView';
import type { CalendarTaskSource } from './calendarOccurrences';
import { getTasksForDate, renderTaskGroup } from './taskGrouping';
import {
  applyOccurrenceDomState,
  bindMaterializedInteractions,
  createForecastTaskCard,
  type ForecastContextMenuOwner,
} from './timegrid/renderTaskMeta';

interface WeekDayRenderContext {
  readonly tasks: TaskSnapshot[];
  readonly config: ResolvedConfig;
  readonly today: string;
  readonly day: ReturnType<typeof window.moment>;
}

export interface WeekViewCallbacks {
  dependenciesFor?: TaskCardOptions['dependenciesFor'];
  app: App;
  forecastMenuOwner?: ForecastContextMenuOwner;
  onToggle: (task: TaskSnapshot) => void;
  onCellClick: (date: string) => void;
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

export class WeekView extends BaseView {
  private md = new Component();

  constructor(private readonly callbacks: WeekViewCallbacks) {
    super();
  }

  render(container: HTMLElement, tasks: TaskSnapshot[], config: ResolvedConfig): void {
    this.md.unload();
    this.md = new Component();
    this.md.load();

    container.empty();

    const today = window.moment().format('YYYY-MM-DD');
    const grid = container.createDiv('grid');

    const week = resolveWeekStartPosition(
      config.startPosition,
      config.firstDayOfWeek,
      window.moment(),
    );

    for (let i = 0; i < 7; i++) {
      this.renderDay(grid, {
        tasks,
        config,
        today,
        day: window.moment(week).add(i, 'days'),
      });
    }
  }

  private renderDay(grid: HTMLElement, context: WeekDayRenderContext): void {
    const { tasks, config, today, day } = context;
    const currentDate = day.format('YYYY-MM-DD');
    const folder = config.dailyNoteFolder;
    const dailyNotePath = folder !== '' ? `${folder}/${currentDate}` : currentDate;
    const cell = grid.createDiv({
      cls: currentDate === today ? 'cell currentWeek today' : 'cell currentWeek',
    });
    cell.setAttribute('data-weekday', day.format('d'));
    const link = cell.createEl('a', { cls: 'internal-link cellName', href: dailyNotePath });
    link.textContent = day.format('ddd, D. MMM');
    const content = cell.createDiv('cellContent');
    this.renderTasksForDate(content, tasks, currentDate, today);
    this.bindDropTarget(content, currentDate);
    cell.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      if (target.closest('.task') !== null || target.closest('.cellName') !== null) return;
      this.callbacks.onCellClick(currentDate);
    });
  }

  private renderTasksForDate(
    container: HTMLElement,
    tasks: TaskSnapshot[],
    currentDate: string,
    today: string,
  ): void {
    const groups = getTasksForDate(tasks, currentDate, today);
    const onEditLink = this.callbacks.onEditLink;
    renderTaskGroup(container, groups, currentDate, today, (task, cls, occurrence) => {
      if (occurrence.kind === 'forecast') {
        return createForecastTaskCard(task, cls, occurrence, {
          renderedDate: currentDate as LocalDate,
          callbacks: this.callbacks,
        });
      }
      const card = createTaskCard(task, cls, {
        app: this.callbacks.app,
        component: this.md,
        onToggle: this.callbacks.onToggle,
        dependenciesFor: this.callbacks.dependenciesFor,
        onOpenNote: this.callbacks.onOpenNote,
        onEditLink:
          onEditLink === undefined
            ? undefined
            : (occ, token) => {
                onEditLink(task, occ, token);
              },
        statusRegistry: this.callbacks.statusRegistry,
        onContextMenu: this.callbacks.onContextMenu,
        onTaskBodyContextMenu: this.callbacks.onTaskBodyContextMenu,
      });
      applyOccurrenceDomState(card, occurrence, 'single', `${cls}-body`);
      this.bindTaskCard(card, task, occurrence);
      return card;
    });
  }

  private bindTaskCard(
    card: HTMLElement,
    task: TaskSnapshot,
    occurrence: Parameters<typeof bindMaterializedInteractions>[0],
  ): void {
    bindMaterializedInteractions(occurrence, (target) => {
      if (target.type === 'task') {
        card.setAttribute('draggable', 'true');
        card.addEventListener('dragstart', (event) => {
          event.dataTransfer?.setData(
            'text/plain',
            `${task.source.filePath}:::${task.source.line}`,
          );
          if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = 'move';
          card.addClass('is-dragging');
        });
        card.addEventListener('dragend', () => {
          card.removeClass('is-dragging');
        });
      }
      card.addEventListener('click', (event) => {
        event.stopPropagation();
        this.callbacks.onTaskClick(task);
      });
    });
  }

  private bindDropTarget(container: HTMLElement, currentDate: string): void {
    container.addEventListener('dragover', (event) => {
      event.preventDefault();
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move';
      container.addClass('is-drag-over');
    });
    container.addEventListener('dragleave', (event) => {
      if (!container.contains(event.relatedTarget as Node)) container.removeClass('is-drag-over');
    });
    container.addEventListener('drop', (event) => {
      event.preventDefault();
      container.removeClass('is-drag-over');
      const dragData = event.dataTransfer?.getData('text/plain');
      if (dragData !== undefined && dragData.length > 0)
        this.callbacks.onDrop(dragData, currentDate);
    });
  }

  destroy(): void {
    this.md.unload();
  }
}
