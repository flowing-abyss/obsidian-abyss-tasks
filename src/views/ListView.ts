import { Component, type App } from 'obsidian';
import type { LinkToken } from '../markdown/links';
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
import { calendarOccurrenceForTask, isForecastCalendarTask } from './calendarOccurrences';
import { getTasksForDate, sortTasks } from './taskGrouping';

function taskPresentationIdentity(task: TaskSnapshot): string {
  return calendarOccurrenceForTask(task)?.key ?? `${task.source.filePath}:${task.source.line}`;
}

function configuredMonth(startPosition: string): ReturnType<typeof window.moment> {
  return startPosition !== ''
    ? window.moment(startPosition, 'YYYY-MM').date(1)
    : window.moment().date(1);
}

function uniqueOpenTasksForDate(
  tasks: TaskSnapshot[],
  currentDate: string,
  today: string,
  overdueIds: ReadonlySet<string>,
): TaskSnapshot[] {
  const groups = getTasksForDate(tasks, currentDate, today);
  const seen = new Set<string>();
  return Object.entries(groups)
    .filter(([key, group]) => key !== 'overdue' && Array.isArray(group))
    .flatMap(([, group]) => group as TaskSnapshot[])
    .filter((task) => {
      const identity = taskPresentationIdentity(task);
      if (seen.has(identity)) return false;
      seen.add(identity);
      return task.status === 'open' && !overdueIds.has(identity);
    });
}

function dateLabel(currentDate: string, today: string, yesterday: string): string {
  if (currentDate === today) return 'Today';
  if (currentDate === yesterday) return 'Yesterday';
  return window.moment(currentDate).format('ddd, D MMM');
}

function taskStatusClass(task: TaskSnapshot): string {
  if (task.status === 'done') return ' is-done';
  return task.status === 'cancelled' ? ' is-cancelled' : '';
}

export interface ListViewCallbacks {
  app: App;
  onToggle: (task: TaskSnapshot) => void;
  onDateClick: (date: string) => void;
  onTaskClick?: (task: TaskSnapshot) => void;
  onEditLink?: (task: TaskSnapshot, occurrenceIndex: number, token: LinkToken) => void;
  statusRegistry: StatusRegistry;
  onContextMenu: (ev: MouseEvent, task: TaskSnapshot) => void;
  onTaskBodyContextMenu?: (ev: MouseEvent, task: TaskSnapshot, anchor: HTMLElement) => void;
}

interface DateSectionContext {
  readonly currentDate: string;
  readonly today: string;
  readonly yesterday: string;
  readonly overdueIds: ReadonlySet<string>;
}

export class ListView extends BaseView {
  private config: ResolvedConfig = {
    ...DEFAULT_VIEW_CONFIG,
    isMobile: false,
    sourceNoteDisplay: 'non-default',
    customFilePath: '',
  };
  private md = new Component();

  constructor(private readonly callbacks: ListViewCallbacks) {
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
    const month = configuredMonth(config.startPosition);

    const grid = container.createDiv({ cls: 'abyss-list-view' });
    const overdueIds = this.renderOverdueSection(grid, tasks, today);

    for (let i = 1; i <= 31; i++) {
      const currentDate = window.moment(month).date(i).format('YYYY-MM-DD');
      if (window.moment(currentDate).month() !== window.moment(month).month()) break;
      this.renderDateSection(grid, tasks, { currentDate, today, yesterday, overdueIds });
    }
  }

  private renderOverdueSection(
    grid: HTMLElement,
    tasks: TaskSnapshot[],
    today: string,
  ): Set<string> {
    const overdueTasks = tasks.filter(
      (task) =>
        task.status === 'open' && task.planning.due !== undefined && task.planning.due < today,
    );
    const overdueIds = new Set(overdueTasks.map(taskPresentationIdentity));
    if (overdueTasks.length === 0) return overdueIds;

    const section = grid.createDiv({ cls: 'abyss-list-section' });
    const header = section.createDiv({
      cls: 'abyss-list-date-header abyss-list-overdue-header',
    });
    header.createSpan({ cls: 'abyss-list-date-label', text: 'Overdue' });
    header.createSpan({ cls: 'abyss-list-date-count', text: String(overdueTasks.length) });
    for (const task of sortTasks(overdueTasks)) this.renderListTask(section, task);
    return overdueIds;
  }

  private renderDateSection(
    grid: HTMLElement,
    tasks: TaskSnapshot[],
    context: DateSectionContext,
  ): void {
    const { currentDate, today, yesterday, overdueIds } = context;
    const openDayTasks = uniqueOpenTasksForDate(tasks, currentDate, today, overdueIds);
    if (openDayTasks.length === 0) return;

    const section = grid.createDiv({ cls: 'abyss-list-section' });
    const header = section.createDiv({ cls: 'abyss-list-date-header' });
    header.createSpan({
      cls: 'abyss-list-date-label',
      text: dateLabel(currentDate, today, yesterday),
    });
    header.createSpan({ cls: 'abyss-list-date-count', text: String(openDayTasks.length) });
    header.addEventListener('click', () => {
      this.callbacks.onDateClick(currentDate);
    });
    for (const task of sortTasks(openDayTasks)) this.renderListTask(section, task);
  }

  private renderListTask(container: HTMLElement, task: TaskSnapshot): void {
    const row = container.createDiv({ cls: 'abyss-list-task' });

    const marker = renderStatusMarker(row, {
      task,
      registry: this.callbacks.statusRegistry,
      interactive: !isForecastCalendarTask(task),
      onLeftClick: () => {
        this.callbacks.onToggle(task);
      },
      onContextMenu: (e) => {
        this.callbacks.onContextMenu(e, task);
      },
    });

    if (task.recurrence !== undefined && task.recurrence.length > 0) {
      renderRecurrenceBadge(
        row,
        recurrenceBadgeInput(task.recurrence, isForecastCalendarTask(task)),
      );
    }

    const titleEl = row.createSpan({ cls: `abyss-list-task-title${taskStatusClass(task)}` });
    const onEditLink = this.callbacks.onEditLink;
    renderTaskText(titleEl, task.markdownTitle, {
      app: this.callbacks.app,
      sourcePath: task.source.filePath,
      component: this.md,
      onEditLink:
        onEditLink != null
          ? (occ, token) => {
              onEditLink(task, occ, token);
            }
          : undefined,
    });

    this.renderTaskMeta(row, task);
    this.registerTaskInteractions(row, marker, task);
  }

  private renderTaskMeta(row: HTMLElement, task: TaskSnapshot): void {
    const meta = row.createDiv({ cls: 'abyss-list-task-meta' });
    if (task.planning.time != null) {
      meta.createSpan({ cls: 'abyss-task-time', text: task.planning.time });
    }

    // Source note chip — before tags
    if (shouldShowSourceNote(task, this.config.sourceNoteDisplay, this.config.customFilePath)) {
      renderSourceNoteChip(meta, task);
    }

    for (const tag of task.tags.slice(0, 1)) {
      meta.createSpan({ cls: 'abyss-task-tag', text: tag });
    }
    if (task.subtasks.length > 0) {
      const done = task.subtasks.filter((s) => s.status === 'done').length;
      meta.createSpan({
        cls: 'abyss-task-progress',
        text: `${done}/${task.subtasks.length}`,
      });
    }
  }

  private registerTaskInteractions(
    row: HTMLElement,
    marker: HTMLElement,
    task: TaskSnapshot,
  ): void {
    row.addEventListener('click', (e) => {
      if (marker.contains(e.target as Node)) return;
      this.callbacks.onTaskClick?.(task);
    });
    const onTaskBodyContextMenu = this.callbacks.onTaskBodyContextMenu;
    if (onTaskBodyContextMenu === undefined) return;
    row.addEventListener('contextmenu', (event) => {
      if (marker.contains(event.target as Node)) return;
      if ((event.target as HTMLElement | null)?.closest('a') !== null) return;
      event.preventDefault();
      event.stopPropagation();
      onTaskBodyContextMenu(event, task, row);
    });
  }

  destroy(): void {
    this.md.unload();
  }
}
