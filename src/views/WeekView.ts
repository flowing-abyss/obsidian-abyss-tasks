import { Component, type App } from 'obsidian';
import { resolveWeekStartPosition } from '../domain/weekGridOffset';
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

export interface WeekViewCallbacks {
  app: App;
  onToggle: (task: TaskSnapshot) => void;
  onCellClick: (date: string) => void;
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

export class WeekView extends BaseView {
  private containerEl: HTMLElement | null = null;
  private md = new Component();

  constructor(private callbacks: WeekViewCallbacks) {
    super();
  }

  render(container: HTMLElement, tasks: TaskSnapshot[], config: ResolvedConfig): void {
    this.md.unload();
    this.md = new Component();
    this.md.load();

    this.containerEl = container;
    container.empty();

    const today = window.moment().format('YYYY-MM-DD');
    const grid = container.createDiv('grid');

    const week = resolveWeekStartPosition(
      config.startPosition,
      config.firstDayOfWeek,
      window.moment(),
    );

    for (let i = 0; i < 7; i++) {
      const currentDate = window.moment(week).add(i, 'days').format('YYYY-MM-DD');
      const weekDay = window.moment(week).add(i, 'days').format('d');
      const longDayName = window.moment(currentDate).format('ddd, D. MMM');
      const dailyNotePath = config.dailyNoteFolder
        ? `${config.dailyNoteFolder}/${currentDate}`
        : currentDate;

      const cell = grid.createDiv({
        cls: currentDate === today ? 'cell currentWeek today' : 'cell currentWeek',
      });
      cell.setAttribute('data-weekday', weekDay);

      const cellLink = cell.createEl('a', { cls: 'internal-link cellName', href: dailyNotePath });
      cellLink.textContent = longDayName;

      const cellContent = cell.createDiv('cellContent');
      const groups = getTasksForDate(tasks, currentDate, today);
      const onEditLink = this.callbacks.onEditLink;
      renderTaskGroup(cellContent, groups, currentDate, today, (task, cls, occurrence) => {
        if (occurrence.kind === 'forecast') {
          return createForecastTaskCard(
            task,
            cls,
            occurrence,
            currentDate as import('../tasks').LocalDate,
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
              e.dataTransfer?.setData(
                'text/plain',
                `${task.source.filePath}:::${task.source.line}`,
              );
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

      cellContent.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        cellContent.addClass('is-drag-over');
      });
      cellContent.addEventListener('dragleave', (e) => {
        if (!cellContent.contains(e.relatedTarget as Node)) {
          cellContent.removeClass('is-drag-over');
        }
      });
      cellContent.addEventListener('drop', (e) => {
        e.preventDefault();
        cellContent.removeClass('is-drag-over');
        const dragData = e.dataTransfer?.getData('text/plain');
        if (dragData) this.callbacks.onDrop(dragData, currentDate);
      });

      cell.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.task')) return;
        if ((e.target as HTMLElement).closest('.cellName')) return;
        this.callbacks.onCellClick(currentDate);
      });
    }
  }

  destroy(): void {
    this.containerEl = null;
    this.md.unload();
  }
}
