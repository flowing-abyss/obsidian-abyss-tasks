import { setIcon } from 'obsidian';
import type { TagGroup } from '../../settings/types';
import { colorForTag } from '../../tags/tagColor';
import type { LocalDate, TaskNodeRef, TaskSnapshot } from '../../tasks';
import { anchoredPlacement } from '../../ui/anchoredPlacement';
import { plainGhostTaskTitle } from '../../ui/plainGhostTaskTitle';
import {
  recurrenceBadgeInput,
  renderRecurrenceBadge,
} from '../../ui/recurrence/renderRecurrenceBadge';
import { taskCardVisualStyle } from '../../ui/TaskCard';
import { applyTaskPresentationIdentity } from '../../ui/taskPresentationIdentity';
import {
  calendarOccurrenceForRender,
  type CalendarOccurrence,
  type CalendarProjectionIssue,
  type CalendarTaskSource,
} from '../calendarOccurrences';

export type CalendarContinuity = 'single' | 'continuation' | 'terminal';

export interface ForecastInteractionCallbacks {
  readonly forecastMenuOwner?: ForecastContextMenuOwner;
  readonly onForecastClick?: (source: CalendarTaskSource, referenceDate: LocalDate) => void;
  readonly onForecastContextMenu?: (source: CalendarTaskSource, referenceDate: LocalDate) => void;
}

export interface ForecastContextMenuOwner {
  open(
    anchor: HTMLElement,
    event: MouseEvent,
    occurrence: Extract<CalendarOccurrence, { readonly kind: 'forecast' }>,
    callbacks: ForecastInteractionCallbacks,
  ): void;
  dismiss(options?: { readonly restoreFocus?: boolean }): void;
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
  element.addClass('abyss-calendar-item');
  element.setAttribute('data-occurrence-state', occurrence.kind);
  element.setAttribute('data-continuity', continuity);
  element.setAttribute(
    'data-recurring',
    String(occurrence.kind === 'forecast' || occurrence.recurring),
  );
  element.setAttribute('data-occurrence-key', occurrence.key);
  element.setAttribute('data-span-role', spanRole);
  element.setAttribute('data-segment-identity', `${occurrence.key}:${spanRole}`);
  if (occurrence.kind === 'materialized') {
    applyTaskPresentationIdentity(element, occurrence.source.root.ref);
  } else {
    element.removeAttribute('data-abyss-task-ref-key');
  }
  element.setAttribute(
    'data-control-slot',
    element.querySelector('.abyss-status-marker') === null ? 'reserved' : 'occupied',
  );
  element.setAttribute(
    'data-recurrence-slot',
    element.querySelector('.abyss-recurrence-badge') === null ? 'reserved' : 'occupied',
  );
}

/**
 * Renders only controls that actually exist. Slot attributes remain useful diagnostics, but a
 * reserved slot has no node, hit target, pseudo-content, or layout width.
 */
export function renderCalendarLeadingSlots(
  container: HTMLElement,
  recurrence: string | undefined,
  forecast: boolean,
  renderControl?: (row: HTMLElement) => void,
): void {
  container.classList.add('abyss-calendar-leading-row');
  const childCount = container.childElementCount;
  renderControl?.(container);
  container.setAttribute(
    'data-control-slot',
    container.childElementCount > childCount ? 'occupied' : 'reserved',
  );
  if (recurrence) {
    renderRecurrenceBadge(container, recurrenceBadgeInput(recurrence, forecast));
    container.setAttribute('data-recurrence-slot', 'occupied');
  } else {
    container.setAttribute('data-recurrence-slot', 'reserved');
  }
}

export interface CalendarProjectionDiagnosticOwner {
  update(container: HTMLElement, issues: readonly CalendarProjectionIssue[]): void;
  destroy(): void;
}

function projectionIssueSignature(issues: readonly CalendarProjectionIssue[]): string {
  return issues
    .map(
      (issue) =>
        `${issue.code}:${issue.source.filePath}:${issue.source.line}:${issue.source.revision}:${issue.phase}:${issue.limit}`,
    )
    .sort((left, right) => left.localeCompare(right))
    .join('|');
}

export function createCalendarProjectionDiagnosticOwner(
  ownerDocument: Document,
): CalendarProjectionDiagnosticOwner {
  const diagnostic = ownerDocument.createElement('div');
  diagnostic.addClass('abyss-calendar-projection-diagnostic');
  diagnostic.setAttribute('aria-live', 'polite');
  diagnostic.setAttribute('aria-atomic', 'true');
  let lastSignature: string | null = null;

  return {
    update(container, issues): void {
      if (diagnostic.parentElement !== container) container.appendChild(diagnostic);
      const signature = projectionIssueSignature(issues);
      if (signature === lastSignature) return;
      lastSignature = signature;
      diagnostic.textContent = signature === '' ? '' : 'More repeating occurrences are not shown';
    },
    destroy(): void {
      diagnostic.remove();
      lastSignature = null;
    },
  };
}

export function bindMaterializedInteractions(
  occurrence: CalendarOccurrence,
  bind: (target: TaskNodeRef) => void,
): void {
  if (occurrence.kind === 'forecast') return;
  bind(occurrence.source.target);
}

export function createForecastContextMenuOwner(ownerDocument: Document): ForecastContextMenuOwner {
  interface ActiveMenu {
    readonly menu: HTMLElement;
    readonly restoreTarget: HTMLElement | null;
    readonly onDocumentKeydown: (event: KeyboardEvent) => void;
    readonly onDocumentMousedown: (event: MouseEvent) => void;
  }

  let active: ActiveMenu | null = null;
  const realm = ownerDocument.defaultView;
  const focusedElement = (): HTMLElement | null => {
    const candidate = ownerDocument.activeElement;
    return realm && candidate instanceof realm.HTMLElement ? candidate : null;
  };
  const dismiss = (options: { readonly restoreFocus?: boolean } = {}): void => {
    const current = active;
    if (!current) return;
    active = null;
    ownerDocument.removeEventListener('keydown', current.onDocumentKeydown, true);
    ownerDocument.removeEventListener('mousedown', current.onDocumentMousedown, true);
    current.menu.remove();
    if (options.restoreFocus !== false && current.restoreTarget?.isConnected) {
      current.restoreTarget.focus({ preventScroll: true });
    }
  };

  return {
    open(anchor, event, occurrence, callbacks): void {
      const restoreTarget = active?.restoreTarget ?? focusedElement() ?? anchor;
      dismiss({ restoreFocus: false });
      const menu = ownerDocument.body.createDiv({
        cls: 'abyss-status-popover abyss-forecast-context-menu',
        attr: { role: 'menu' },
      });
      const edit = menu.createEl('button', {
        cls: 'abyss-forecast-context-menu-edit-repeat',
        attr: { type: 'button', role: 'menuitem' },
        text: 'Edit repeat…',
      });
      const open = menu.createEl('button', {
        cls: 'abyss-forecast-context-menu-open-source',
        attr: { type: 'button', role: 'menuitem' },
        text: 'Open source task',
      });
      const measured = menu.getBoundingClientRect();
      const width = measured.width || menu.offsetWidth;
      const height = measured.height || menu.offsetHeight;
      const viewportWidth = realm?.innerWidth ?? width + 16;
      const viewportHeight = realm?.innerHeight ?? height + 16;
      const Rect = realm?.DOMRect ?? DOMRect;
      const point = new Rect(event.clientX, event.clientY, 0, 0);
      const placement = anchoredPlacement({
        anchor: point,
        floating: { width, height },
        boundary: new Rect(0, 0, viewportWidth, viewportHeight),
        gap: 0,
        edgeGap: 8,
        preferred: 'below-start',
      });
      menu.style.left = `${placement.left}px`;
      menu.style.top = `${placement.top}px`;
      let owned: ActiveMenu;
      const onDocumentKeydown = (keyboardEvent: KeyboardEvent): void => {
        if (keyboardEvent.key !== 'Escape' || active !== owned) return;
        keyboardEvent.preventDefault();
        keyboardEvent.stopPropagation();
        dismiss();
      };
      const onDocumentMousedown = (mouseEvent: MouseEvent): void => {
        if (active !== owned || menu.contains(mouseEvent.target as Node)) return;
        dismiss();
      };
      owned = { menu, restoreTarget, onDocumentKeydown, onDocumentMousedown };
      active = owned;
      ownerDocument.addEventListener('keydown', onDocumentKeydown, true);
      ownerDocument.addEventListener('mousedown', onDocumentMousedown, true);
      edit.addEventListener('click', () => {
        if (active !== owned) return;
        dismiss({ restoreFocus: false });
        callbacks.onForecastContextMenu?.(occurrence.source, occurrence.referenceDate);
      });
      open.addEventListener('click', () => {
        if (active !== owned) return;
        dismiss({ restoreFocus: false });
        callbacks.onForecastClick?.(occurrence.source, occurrence.referenceDate);
      });
      edit.focus({ preventScroll: true });
    },
    dismiss,
  };
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
    callbacks.forecastMenuOwner?.open(element, event, occurrence, callbacks);
  });
}

export function createForecastTaskCard(
  task: TaskSnapshot,
  taskClass: string,
  occurrence: Extract<CalendarOccurrence, { readonly kind: 'forecast' }>,
  renderedDate: LocalDate,
  callbacks: ForecastInteractionCallbacks,
): HTMLElement {
  const card = activeDocument.createElement('div');
  card.className = `task ${taskClass} noNoteIcon`;
  card.setAttribute('style', taskCardVisualStyle(task));
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
  const multiDay = task.planning.start !== undefined && task.planning.due !== undefined;
  const terminalRole = taskClass === 'due' || taskClass === 'recurrence';
  let continuity: CalendarContinuity = 'single';
  if (multiDay) {
    continuity = renderedDate === task.planning.due || terminalRole ? 'terminal' : 'continuation';
  }
  applyOccurrenceDomState(card, occurrence, continuity, spanRole);
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
 * `.abyss-task-count-badge` visual language (same class + lucide icons) so the calendar's
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
    const badge = container.createEl('span', { cls: 'abyss-task-count-badge' });
    setIcon(badge, 'check-square');
    badge.createEl('span', { text: `${doneCount}/${subtaskCount}` });
  }
  if (commentCount > 0) {
    const badge = container.createEl('span', { cls: 'abyss-task-count-badge' });
    setIcon(badge, 'message-square');
    badge.createEl('span', { text: String(commentCount) });
  }
  if (linkCount > 0) {
    const badge = container.createEl('span', { cls: 'abyss-task-count-badge' });
    setIcon(badge, 'paperclip');
    badge.createEl('span', { text: String(linkCount) });
  }
}

/**
 * Renders up to `max` tag chips into `container`, matching CenterPanel's `.abyss-task-tag`
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
    const tagEl = container.createEl('span', { cls: 'abyss-task-tag', text: tag });
    const color = colorForTag(tag, tagGroups);
    if (color) {
      tagEl.setCssProps({ '--abyss-tag-color': color });
      tagEl.addClass('abyss-task-tag--colored');
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
