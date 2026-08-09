import { Component, type App } from 'obsidian';
import type { LinkToken } from '../parser/links';
import { DEFAULT_VIEW_CONFIG } from '../settings/defaults';
import type { ResolvedConfig } from '../settings/types';
import type { StatusRegistry } from '../status/StatusRegistry';
import type { TaskSnapshot } from '../tasks';
import { renderStatusMarker } from '../ui/StatusMarker';
import {
  recurrenceBadgeInput,
  renderRecurrenceBadge,
} from '../ui/recurrence/renderRecurrenceBadge';
import { renderTaskText } from '../ui/renderTaskText';
import { renderSourceNoteChip, shouldShowSourceNote } from '../ui/sourceNoteChip';
import { BaseView } from './BaseView';
import { isForecastCalendarTask } from './calendarOccurrences';
import { getTasksForDate, sortTasks } from './taskGrouping';

export interface ListViewCallbacks {
  app: App;
  onToggle: (task: TaskSnapshot) => void;
  onDateClick: (date: string) => void;
  onTaskClick?: (task: TaskSnapshot) => void;
  onEditLink?: (task: TaskSnapshot, occurrenceIndex: number, token: LinkToken) => void;
  statusRegistry: StatusRegistry;
  onContextMenu: (ev: MouseEvent, task: TaskSnapshot) => void;
}

export class ListView extends BaseView {
  private config: ResolvedConfig = {
    ...DEFAULT_VIEW_CONFIG,
    isMobile: false,
    sourceNoteDisplay: 'non-default',
    customFilePath: '',
  };
  private md = new Component();

  constructor(private callbacks: ListViewCallbacks) {
    super();
  }

  render(container: HTMLElement, tasks: TaskSnapshot[], config: ResolvedConfig): void {
    this.md.unload();
    this.md = new Component();
    this.md.load();

    this.config = config;
    container.empty();

    const today = window.moment().format('YYYY-MM-DD');
    const yesterday = window.moment().subtract(1, 'day').format('YYYY-MM-DD');
    const month = config.startPosition
      ? window.moment(config.startPosition, 'YYYY-MM').date(1)
      : window.moment().date(1);

    const grid = container.createDiv({ cls: 'tc-list-view' });

    // Overdue section first
    const overdueTasks = tasks.filter(
      (t) => t.status === 'open' && t.planning.due && t.planning.due < today,
    );
    const overdueIds = new Set(overdueTasks.map((t) => `${t.source.filePath}:${t.source.line}`));
    if (overdueTasks.length > 0) {
      const section = grid.createDiv({ cls: 'tc-list-section' });
      const overdueHeader = section.createDiv({
        cls: 'tc-list-date-header tc-list-overdue-header',
      });
      overdueHeader.createEl('span', { cls: 'tc-list-date-label', text: 'Overdue' });
      overdueHeader.createEl('span', {
        cls: 'tc-list-date-count',
        text: String(overdueTasks.length),
      });
      for (const task of sortTasks(overdueTasks)) {
        this.renderListTask(section, task);
      }
    }

    for (let i = 1; i <= 31; i++) {
      const currentDate = window.moment(month).date(i).format('YYYY-MM-DD');
      if (window.moment(currentDate).month() !== window.moment(month).month()) break;

      const groups = getTasksForDate(tasks, currentDate, today);
      // Combine all task groups (due, recurrence, start, scheduled, process, dailyNote, allDone, cancelled)
      // Exclude overdue — it has its own section at the top
      const allTasks: TaskSnapshot[] = [];
      for (const [key, group] of Object.entries(groups)) {
        if (key === 'overdue') continue;
        if (Array.isArray(group)) allTasks.push(...(group as TaskSnapshot[]));
      }
      // Deduplicate: a task may appear in multiple groups (e.g. due + scheduled on same day)
      const seen = new Set<string>();
      const uniqueTasks = allTasks.filter((t) => {
        const id = `${t.source.filePath}:${t.source.line}`;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      // Filter to only open tasks; also exclude tasks already shown in the overdue section
      const openDayTasks = uniqueTasks.filter(
        (t) => t.status === 'open' && !overdueIds.has(`${t.source.filePath}:${t.source.line}`),
      );
      if (openDayTasks.length === 0) continue;

      const section = grid.createDiv({ cls: 'tc-list-section' });

      let dateLabel: string;
      if (currentDate === today) dateLabel = 'Today';
      else if (currentDate === yesterday) dateLabel = 'Yesterday';
      else dateLabel = window.moment(currentDate).format('ddd, D MMM');

      const dateHeader = section.createDiv({ cls: 'tc-list-date-header' });
      dateHeader.createEl('span', { cls: 'tc-list-date-label', text: dateLabel });
      dateHeader.createEl('span', {
        cls: 'tc-list-date-count',
        text: String(openDayTasks.length),
      });
      dateHeader.addEventListener('click', () => this.callbacks.onDateClick(currentDate));

      for (const task of sortTasks(openDayTasks)) {
        this.renderListTask(section, task);
      }
    }
  }

  private renderListTask(container: HTMLElement, task: TaskSnapshot): void {
    const row = container.createDiv({ cls: 'tc-list-task' });

    const marker = renderStatusMarker(row, {
      task,
      registry: this.callbacks.statusRegistry,
      interactive: !isForecastCalendarTask(task),
      onLeftClick: () => this.callbacks.onToggle(task),
      onContextMenu: (e) => this.callbacks.onContextMenu(e, task),
    });

    if (task.recurrence) {
      renderRecurrenceBadge(
        row,
        recurrenceBadgeInput(task.recurrence, isForecastCalendarTask(task)),
      );
    }

    let statusClass = '';
    if (task.status === 'done') {
      statusClass = ' is-done';
    } else if (task.status === 'cancelled') {
      statusClass = ' is-cancelled';
    }
    const titleEl = row.createEl('span', { cls: `tc-list-task-title${statusClass}` });
    const onEditLink = this.callbacks.onEditLink;
    renderTaskText(titleEl, task.markdownTitle, {
      app: this.callbacks.app,
      sourcePath: task.source.filePath,
      component: this.md,
      onEditLink: onEditLink ? (occ, token) => onEditLink(task, occ, token) : undefined,
    });

    const meta = row.createDiv({ cls: 'tc-list-task-meta' });
    if (task.planning.time) {
      meta.createEl('span', { cls: 'tc-task-time', text: task.planning.time });
    }

    // Source note chip — before tags
    if (shouldShowSourceNote(task, this.config.sourceNoteDisplay, this.config.customFilePath)) {
      renderSourceNoteChip(meta, task);
    }

    const tags = task.tags ?? [];
    for (const tag of tags.slice(0, 1)) {
      meta.createEl('span', { cls: 'tc-task-tag', text: tag });
    }
    if ((task.subtasks?.length ?? 0) > 0) {
      const done = task.subtasks.filter((s) => s.status === 'done').length;
      meta.createEl('span', {
        cls: 'tc-task-progress',
        text: `${done}/${task.subtasks.length}`,
      });
    }

    row.addEventListener('click', (e) => {
      if (marker.contains(e.target as Node)) return;
      this.callbacks.onTaskClick?.(task);
    });
  }

  destroy(): void {
    this.md.unload();
  }
}
