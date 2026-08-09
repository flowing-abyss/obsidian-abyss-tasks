import { setIcon } from 'obsidian';
import type { TagGroup } from '../../settings/types';
import { colorForTag } from '../../tags/tagColor';
import type { LocalDate, TaskNodeRef, TaskSnapshot } from '../../tasks';
import { plainGhostTaskTitle } from '../../ui/plainGhostTaskTitle';
import {
  recurrenceBadgeInput,
  renderRecurrenceBadge,
} from '../../ui/recurrence/renderRecurrenceBadge';
import {
  calendarOccurrenceForRender,
  type CalendarOccurrence,
  type CalendarTaskSource,
} from '../calendarOccurrences';

export type CalendarContinuity = 'single' | 'continuation' | 'terminal';

export interface ForecastInteractionCallbacks {
  readonly onForecastClick?: (source: CalendarTaskSource, referenceDate: LocalDate) => void;
  readonly onForecastContextMenu?: (source: CalendarTaskSource, referenceDate: LocalDate) => void;
}

export type CalendarOccurrenceLookup = (task: TaskSnapshot) => CalendarOccurrence;

/**
 * Captures the occurrence discriminant once at the view boundary. Geometry may continue to pass
 * snapshots through its existing layout types; every renderer callback resolves those exact
 * snapshot objects against this immutable render-local ownership map instead of consulting the
 * Task 8 presentation adapter at each interaction site.
 */
export function calendarOccurrenceLookup(tasks: readonly TaskSnapshot[]): CalendarOccurrenceLookup {
  const occurrences = new Map(
    tasks.map((task) => [task, calendarOccurrenceForRender(task)] as const),
  );
  return (task) => {
    const occurrence = occurrences.get(task);
    if (occurrence === undefined) {
      throw new Error('Calendar renderer received a snapshot outside its occurrence contract');
    }
    return occurrence;
  };
}

export function applyOccurrenceDomState(
  element: HTMLElement,
  occurrence: CalendarOccurrence,
  continuity: CalendarContinuity,
  spanRole: string,
): void {
  element.setAttribute('data-occurrence-state', occurrence.kind);
  element.setAttribute('data-continuity', continuity);
  element.setAttribute(
    'data-recurring',
    String(occurrence.kind === 'forecast' || occurrence.recurring),
  );
  element.setAttribute('data-occurrence-key', occurrence.key);
  element.setAttribute('data-span-role', spanRole);
  element.setAttribute('data-segment-identity', `${occurrence.key}:${spanRole}`);
}

export function bindMaterializedInteractions(
  occurrence: CalendarOccurrence,
  bind: (target: TaskNodeRef) => void,
): void {
  if (occurrence.kind === 'forecast') return;
  bind(occurrence.source.target);
}

function closeForecastMenus(): void {
  activeDocument
    .querySelectorAll<HTMLElement>('.tc-forecast-context-menu')
    .forEach((menu) => menu.remove());
}

function showForecastContextMenu(
  event: MouseEvent,
  occurrence: Extract<CalendarOccurrence, { readonly kind: 'forecast' }>,
  callbacks: ForecastInteractionCallbacks,
): void {
  closeForecastMenus();
  const menu = activeDocument.body.createDiv({
    cls: 'tc-status-popover tc-forecast-context-menu',
  });
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;
  const edit = menu.createEl('button', {
    cls: 'tc-forecast-context-menu-edit-repeat',
    attr: { type: 'button' },
    text: 'Edit repeat…',
  });
  const open = menu.createEl('button', {
    cls: 'tc-forecast-context-menu-open-source',
    attr: { type: 'button' },
    text: 'Open source task',
  });
  edit.addEventListener('click', () => {
    menu.remove();
    callbacks.onForecastContextMenu?.(occurrence.source, occurrence.referenceDate);
  });
  open.addEventListener('click', () => {
    menu.remove();
    callbacks.onForecastClick?.(occurrence.source, occurrence.referenceDate);
  });
}

export function bindForecastInteractions(
  element: HTMLElement,
  occurrence: CalendarOccurrence,
  callbacks: ForecastInteractionCallbacks,
): void {
  if (occurrence.kind === 'materialized') return;
  element.addEventListener('click', (event) => {
    event.stopPropagation();
    callbacks.onForecastClick?.(occurrence.source, occurrence.referenceDate);
  });
  element.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    showForecastContextMenu(event, occurrence, callbacks);
  });
}

export function createForecastTaskCard(
  task: TaskSnapshot,
  taskClass: string,
  occurrence: Extract<CalendarOccurrence, { readonly kind: 'forecast' }>,
  callbacks: ForecastInteractionCallbacks,
): HTMLElement {
  const card = activeDocument.createElement('div');
  card.className = `task ${taskClass} noNoteIcon`;
  card.setAttribute('data-task-text', task.title);
  card.setAttribute('title', task.title);
  if (task.planning.due) card.setAttribute('data-due', task.planning.due);
  const inner = card.createDiv({ cls: 'inner' });
  const content = inner.createDiv({ cls: 'inner-link' });
  const icon = content.createDiv({ cls: 'icon' });
  if (task.recurrence) {
    renderRecurrenceBadge(icon, recurrenceBadgeInput(task.recurrence, true));
  }
  content.createDiv({ cls: 'description', text: plainGhostTaskTitle(task) });
  const spanRole = taskClass === 'scheduled' ? 'scheduled-body' : `${taskClass}-body`;
  applyOccurrenceDomState(card, occurrence, 'single', spanRole);
  bindForecastInteractions(card, occurrence, callbacks);
  return card;
}

/** Reads up to `max` canonical semantic tags from the task index projection. */
export function extractTags(task: TaskSnapshot, max = Infinity): string[] {
  const tags = task.tags ?? [];
  return max === Infinity ? [...tags] : tags.slice(0, max);
}

/**
 * Renders subtask/comment/link count badges into `container`, matching CenterPanel's
 * `.tc-task-count-badge` visual language (same class + lucide icons) so the calendar's
 * badges look identical to the main task list's. Purely presentational — these badges
 * carry no click handlers in CenterPanel either, so no drag/pointerdown guard is needed
 * here (unlike tag chips below, which CenterPanel makes interactive — see renderTagChips).
 */
export function renderCountBadges(container: HTMLElement, task: TaskSnapshot): void {
  const subtaskCount = task.subtasks?.length ?? 0;
  const commentCount = task.comments?.length ?? 0;
  const linkCount = task.presentation.linkCount ?? 0;

  if (subtaskCount > 0) {
    const doneCount = task.subtasks?.filter((s) => s.status === 'done').length ?? 0;
    const badge = container.createEl('span', { cls: 'tc-task-count-badge' });
    setIcon(badge, 'check-square');
    badge.createEl('span', { text: `${doneCount}/${subtaskCount}` });
  }
  if (commentCount > 0) {
    const badge = container.createEl('span', { cls: 'tc-task-count-badge' });
    setIcon(badge, 'message-square');
    badge.createEl('span', { text: String(commentCount) });
  }
  if (linkCount > 0) {
    const badge = container.createEl('span', { cls: 'tc-task-count-badge' });
    setIcon(badge, 'paperclip');
    badge.createEl('span', { text: String(linkCount) });
  }
}

/**
 * Renders up to `max` tag chips into `container`, matching CenterPanel's `.tc-task-tag`
 * visual language (color driven by the same `colorForTag` lookup). Deliberately
 * NON-interactive (no click-to-filter, no drag-to-replace) — CenterPanel's tag chips are
 * interactive, but calendar blocks already run delicate pointerdown-based drag/resize
 * logic (renderTimedBlocks.ts's onPointerDown, attachEdgeResize in renderAllDay.ts) and
 * adding a new interactive child would need the same exclusion-guard treatment already
 * applied to the checkbox/resize-handle/links there. Keeping these chips inert avoids
 * that whole bug class.
 */
export function renderTagChips(
  container: HTMLElement,
  task: TaskSnapshot,
  tagGroups: TagGroup[],
  max = 3,
): void {
  const tags = extractTags(task, max);
  for (const tag of tags) {
    const tagEl = container.createEl('span', { cls: 'tc-task-tag', text: tag });
    const color = colorForTag(tag, tagGroups);
    if (color) {
      tagEl.setCssProps({ '--tc-tag-color': color });
      tagEl.addClass('tc-task-tag--colored');
    }
  }
}

/** True if the task has anything for renderCountBadges/renderTagChips to show. */
export function hasMeta(task: TaskSnapshot): boolean {
  return (
    (task.subtasks?.length ?? 0) > 0 ||
    (task.comments?.length ?? 0) > 0 ||
    (task.presentation.linkCount ?? 0) > 0 ||
    extractTags(task, 1).length > 0
  );
}

/**
 * True if the task has anything for renderCountBadges alone to show (subtasks/comments/links)
 * — deliberately excludes tags, unlike `hasMeta` above. Used by Week/Day's timed-block renderers
 * (renderTimedBlocks.ts), which stopped rendering tag chips at all (Task 35: the block's own
 * tag-colored fill already conveys the tag, so a chip was redundant) — gating on `hasMeta` there
 * would keep reserving/showing an (now chip-less) badges container for a tag-only task that has
 * no counts to show.
 */
export function hasCountBadges(task: TaskSnapshot): boolean {
  return (
    (task.subtasks?.length ?? 0) > 0 ||
    (task.comments?.length ?? 0) > 0 ||
    (task.presentation.linkCount ?? 0) > 0
  );
}
