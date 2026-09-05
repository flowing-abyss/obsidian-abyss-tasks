import { Notice, Platform, type App, type Component } from 'obsidian';
import type { LinkToken } from '../markdown/links';
import type { StatusRegistry } from '../status/StatusRegistry';
import type { TaskSnapshot } from '../tasks';
import { isForecastCalendarTask } from '../views/calendarOccurrences';
import { attachLongPress } from './MobileTouch';
import { recurrenceBadgeInput, renderRecurrenceBadge } from './recurrence/renderRecurrenceBadge';
import { renderTaskText } from './renderTaskText';
import { renderStatusMarker } from './StatusMarker';
import {
  dependencyCompletionBlocked,
  renderDependencyIndicator,
  type TaskDependencyLookup,
} from './taskDependencyPresentation';

type TaskCardMode = 'default' | 'timeblock';

export interface TaskCardOptions {
  dependenciesFor?: TaskDependencyLookup | undefined;
  mode?: TaskCardMode | undefined;
  app: App;
  component: Component;
  onOpenNote: (task: TaskSnapshot) => void;
  onToggle?: ((task: TaskSnapshot) => void) | undefined;
  onMove?: ((task: TaskSnapshot, newDate: string, newTime: string) => void) | undefined;
  onEditLink?: ((occurrenceIndex: number, token: LinkToken) => void) | undefined;
  statusRegistry?: StatusRegistry | undefined;
  onContextMenu?: ((ev: MouseEvent, task: TaskSnapshot) => void) | undefined;
  onTaskBodyContextMenu?:
    ((ev: MouseEvent, task: TaskSnapshot, anchor: HTMLElement) => void) | undefined;
}

const TASK_ICONS: Record<string, string> = {
  done: '✅',
  due: '📅',
  scheduled: '⏳',
  overdue: '⚠️',
  process: '⏺️',
  cancelled: '🚫',
  start: '🛫',
  dailyNote: '📄',
};

function transColor(hex: string, percent: number): string {
  const num = parseInt(hex.replace('#', ''), 16);
  const amt = Math.round(2.55 * percent);
  const r = Math.min(255, Math.max(0, (num >> 16) + amt));
  const g = Math.min(255, Math.max(0, ((num >> 8) & 0xff) + amt));
  const b = Math.min(255, Math.max(0, (num & 0xff) + amt));
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

/** Shared item-local color variables for the legacy Month/Week/List card silhouette. */
export function taskCardVisualStyle(task: TaskSnapshot): string {
  const lighter = 25;
  const darker = -40;
  if (
    task.presentation.noteColor !== undefined &&
    task.presentation.noteColor.length > 0 &&
    task.presentation.noteTextColor !== undefined &&
    task.presentation.noteTextColor.length > 0
  ) {
    return `--task-background:${task.presentation.noteColor}33;--task-color:${task.presentation.noteColor};--dark-task-text-color:${task.presentation.noteTextColor};--light-task-text-color:${task.presentation.noteTextColor}`;
  }
  if (task.presentation.noteColor !== undefined && task.presentation.noteColor.length > 0) {
    return `--task-background:${task.presentation.noteColor}33;--task-color:${task.presentation.noteColor};--dark-task-text-color:${transColor(task.presentation.noteColor, darker)};--light-task-text-color:${transColor(task.presentation.noteColor, lighter)}`;
  }
  if (task.presentation.noteTextColor !== undefined && task.presentation.noteTextColor.length > 0) {
    return `--task-background:#7D7D7D33;--task-color:#7D7D7D;--dark-task-text-color:${transColor(task.presentation.noteTextColor, darker)};--light-task-text-color:${transColor(task.presentation.noteTextColor, lighter)}`;
  }
  return '--task-background:#7D7D7D33;--task-color:#7D7D7D;--dark-task-text-color:#4d4d4d;--light-task-text-color:#a8a8a8';
}

function renderCardStatus(
  parent: HTMLElement,
  task: TaskSnapshot,
  mode: TaskCardMode,
  options: TaskCardOptions,
): void {
  if (mode !== 'default' || options.statusRegistry == null) return;
  const projection = isForecastCalendarTask(task) ? undefined : options.dependenciesFor?.(task);
  renderStatusMarker(parent, {
    task,
    registry: options.statusRegistry,
    interactive: !isForecastCalendarTask(task),
    completionBlocked: dependencyCompletionBlocked(projection),
    onLeftClick: () => options.onToggle?.(task),
    onContextMenu: (event) => options.onContextMenu?.(event, task),
  });
  renderDependencyIndicator(parent, projection);
}

function createCardIcon(task: TaskSnapshot, taskIcon: string): HTMLElement {
  const icon = createFragment().createDiv({ cls: 'icon' });
  if (task.recurrence !== undefined && task.recurrence.length > 0) {
    renderRecurrenceBadge(
      icon,
      recurrenceBadgeInput(task.recurrence, isForecastCalendarTask(task)),
    );
  } else {
    icon.textContent = taskIcon;
  }
  return icon;
}

function attachTaskBodyContextMenu(
  content: HTMLElement,
  task: TaskSnapshot,
  handler: TaskCardOptions['onTaskBodyContextMenu'],
): void {
  if (handler == null) return;
  content.addEventListener('contextmenu', (event) => {
    if ((event.target as HTMLElement | null)?.closest('a') != null) return;
    event.preventDefault();
    event.stopPropagation();
    handler(event, task, content);
  });
}

export function createTaskCard(
  task: TaskSnapshot,
  taskClass: string,
  options: TaskCardOptions,
): HTMLElement {
  const { mode = 'default' } = options;

  const taskIcon = TASK_ICONS[taskClass] ?? '';
  const relative = task.planning.due != null ? window.moment(task.planning.due).fromNow() : '';
  const cls =
    task.presentation.noteIcon !== undefined && task.presentation.noteIcon.length > 0
      ? taskClass
      : `${taskClass} noNoteIcon`;

  // Root div
  const div = createFragment().createDiv();
  div.className = `task ${cls}`;
  div.setAttribute('style', taskCardVisualStyle(task));
  div.setAttribute('data-task-text', task.title);
  div.setAttribute('title', task.title);
  if (task.planning.due != null) div.setAttribute('data-due', task.planning.due);

  // Inner wrapper
  const inner = createFragment().createDiv();
  inner.className = 'inner';

  // Status marker (replaces the native checkbox; also carries priority + right-click menu)
  renderCardStatus(inner, task, mode, options);

  // Content wrapper (was an <a>; nested <a> is invalid so this is a div now)
  const content = createFragment().createDiv();
  content.className = 'inner-link';

  const iconEl = createCardIcon(task, taskIcon);

  const descEl = createFragment().createDiv();
  descEl.className = 'description';
  descEl.dataset['relative'] = relative;
  renderTaskText(descEl, task.markdownTitle, {
    app: options.app,
    sourcePath: task.source.filePath,
    component: options.component,
    onEditLink: options.onEditLink,
  });

  content.appendChild(iconEl);
  content.appendChild(descEl);
  // Clicking anywhere on the card (except a link) opens the source note.
  content.addEventListener('click', () => {
    options.onOpenNote(task);
  });
  attachTaskBodyContextMenu(content, task, options.onTaskBodyContextMenu);
  inner.appendChild(content);
  div.appendChild(inner);

  // Mobile long-press
  if (Platform.isMobile) {
    attachLongPress(div, (text) => {
      new Notice(text);
    });
  }

  return div;
}
