import { setIcon } from 'obsidian';
import type { TagGroup } from '../../settings/types';
import { colorForTag } from '../../tags/tagColor';
import type { LocalDate, TaskNodeRef, TaskSnapshot } from '../../tasks';
import { anchoredPlacement } from '../../ui/anchoredPlacement';
import {
  noInteractionOwnership,
  type InteractionOwnershipPort,
} from '../../ui/interactionOwnership';
import { plainGhostTaskTitle } from '../../ui/plainGhostTaskTitle';
import {
  recurrenceBadgeInput,
  renderRecurrenceBadge,
} from '../../ui/recurrence/renderRecurrenceBadge';
import { closeStatusPopovers, registerStatusPopoverClose } from '../../ui/statusMenu';
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
  readonly interactionOwnership?: InteractionOwnershipPort;
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
  if (recurrence !== undefined && recurrence.length > 0) {
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
  const diagnostic = ownerDocument.adoptNode(createFragment().createDiv());
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

interface ActiveForecastMenu {
  readonly menu: HTMLElement;
  readonly restoreTarget: HTMLElement | null;
  readonly onDocumentKeydown: (event: KeyboardEvent) => void;
  readonly onDocumentMousedown: (event: MouseEvent) => void;
  readonly ownershipToken: { release(): void };
  readonly unregisterPopover: () => void;
}

interface ForecastMenuState {
  active: ActiveForecastMenu | null;
}

interface ForecastMenuContext {
  readonly ownerDocument: Document;
  readonly interactionOwnership: InteractionOwnershipPort;
  readonly state: ForecastMenuState;
  readonly dismiss: (options?: { readonly restoreFocus?: boolean }) => void;
}

interface ForecastMenuRequest {
  readonly anchor: HTMLElement;
  readonly event: MouseEvent;
  readonly occurrence: Extract<CalendarOccurrence, { readonly kind: 'forecast' }>;
  readonly callbacks: ForecastInteractionCallbacks;
}

function focusedElement(ownerDocument: Document): HTMLElement | null {
  const candidate = ownerDocument.activeElement;
  const realm = ownerDocument.defaultView;
  return realm !== null && candidate instanceof realm.HTMLElement ? candidate : null;
}

function dismissForecastMenu(
  ownerDocument: Document,
  state: ForecastMenuState,
  options: { readonly restoreFocus?: boolean } = {},
): void {
  const current = state.active;
  if (current === null) return;
  state.active = null;
  ownerDocument.removeEventListener('keydown', current.onDocumentKeydown, true);
  ownerDocument.removeEventListener('mousedown', current.onDocumentMousedown, true);
  current.unregisterPopover();
  current.menu.remove();
  current.ownershipToken.release();
  if (options.restoreFocus !== false && current.restoreTarget?.isConnected === true) {
    current.restoreTarget.focus({ preventScroll: true });
  }
}

function positionForecastMenu(
  menu: HTMLElement,
  event: MouseEvent,
  realm: (Window & { readonly DOMRect: typeof DOMRect }) | null,
): void {
  const measured = menu.getBoundingClientRect();
  const width = measured.width !== 0 ? measured.width : menu.offsetWidth;
  const height = measured.height !== 0 ? measured.height : menu.offsetHeight;
  const viewportWidth = realm?.innerWidth ?? width + 16;
  const viewportHeight = realm?.innerHeight ?? height + 16;
  const point =
    realm === null
      ? new DOMRect(event.clientX, event.clientY, 0, 0)
      : new realm.DOMRect(event.clientX, event.clientY, 0, 0);
  const boundary =
    realm === null
      ? new DOMRect(0, 0, viewportWidth, viewportHeight)
      : new realm.DOMRect(0, 0, viewportWidth, viewportHeight);
  const placement = anchoredPlacement({
    anchor: point,
    floating: { width, height },
    boundary,
    gap: 0,
    edgeGap: 8,
    preferred: 'below-start',
  });
  menu.style.left = `${placement.left}px`;
  menu.style.top = `${placement.top}px`;
}

function addForecastMenuActions(menu: HTMLElement): {
  edit: HTMLButtonElement;
  open: HTMLButtonElement;
} {
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
  return { edit, open };
}

function openForecastMenu(context: ForecastMenuContext, request: ForecastMenuRequest): void {
  const { ownerDocument, interactionOwnership, state, dismiss } = context;
  const { anchor, event, occurrence, callbacks } = request;
  const restoreTarget = state.active?.restoreTarget ?? focusedElement(ownerDocument) ?? anchor;
  dismiss({ restoreFocus: false });
  closeStatusPopovers(ownerDocument);
  const ownershipToken = interactionOwnership.acquire({ blocksShortcuts: true });
  const menu = ownerDocument.body.createDiv({
    cls: 'abyss-status-popover abyss-forecast-context-menu',
    attr: { role: 'menu' },
  });
  const { edit, open } = addForecastMenuActions(menu);
  positionForecastMenu(menu, event, ownerDocument.defaultView);

  const onDocumentKeydown = (keyboardEvent: KeyboardEvent): void => {
    if (keyboardEvent.key !== 'Escape' || state.active?.menu !== menu) return;
    keyboardEvent.preventDefault();
    keyboardEvent.stopPropagation();
    dismiss();
  };
  const onDocumentMousedown = (mouseEvent: MouseEvent): void => {
    if (state.active?.menu !== menu || menu.contains(mouseEvent.target as Node)) return;
    dismiss();
  };
  const unregisterPopover = registerStatusPopoverClose(menu, () => {
    if (state.active?.menu === menu) dismiss({ restoreFocus: false });
  });
  const owned: ActiveForecastMenu = {
    menu,
    restoreTarget,
    onDocumentKeydown,
    onDocumentMousedown,
    ownershipToken,
    unregisterPopover,
  };
  state.active = owned;
  ownerDocument.addEventListener('keydown', onDocumentKeydown, true);
  ownerDocument.addEventListener('mousedown', onDocumentMousedown, true);
  edit.addEventListener('click', () => {
    if (state.active !== owned) return;
    dismiss({ restoreFocus: false });
    callbacks.onForecastContextMenu?.(occurrence.source, occurrence.referenceDate);
  });
  open.addEventListener('click', () => {
    if (state.active !== owned) return;
    dismiss({ restoreFocus: false });
    callbacks.onForecastClick?.(occurrence.source, occurrence.referenceDate);
  });
  edit.focus({ preventScroll: true });
}

export function createForecastContextMenuOwner(
  ownerDocument: Document,
  interactionOwnership: InteractionOwnershipPort = noInteractionOwnership,
): ForecastContextMenuOwner {
  const state: ForecastMenuState = { active: null };
  const dismiss = (options: { readonly restoreFocus?: boolean } = {}): void => {
    dismissForecastMenu(ownerDocument, state, options);
  };
  const context = { ownerDocument, interactionOwnership, state, dismiss };

  return {
    open(anchor, event, occurrence, callbacks): void {
      openForecastMenu(context, { anchor, event, occurrence, callbacks });
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
  context: {
    readonly renderedDate: LocalDate;
    readonly callbacks: ForecastInteractionCallbacks;
  },
): HTMLElement {
  const { renderedDate, callbacks } = context;
  const card = createFragment().createDiv();
  card.className = `task ${taskClass} noNoteIcon`;
  card.setAttribute('style', taskCardVisualStyle(task));
  card.setAttribute('data-task-text', task.title);
  card.setAttribute('title', task.title);
  if (task.planning.due != null) card.setAttribute('data-due', task.planning.due);
  const inner = card.createDiv({ cls: 'inner' });
  const content = inner.createDiv({ cls: 'inner-link' });
  const icon = content.createDiv({ cls: 'icon' });
  if (task.recurrence !== undefined && task.recurrence.length > 0) {
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
  const tags = task.tags;
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
  const subtaskCount = task.subtasks.length;
  const commentCount = task.comments.length;
  const linkCount = task.presentation.linkCount;

  if (subtaskCount > 0) {
    const doneCount = task.subtasks.filter((subtask) => subtask.status === 'done').length;
    const badge = container.createSpan({ cls: 'abyss-task-count-badge' });
    setIcon(badge, 'check-square');
    badge.createSpan({ text: `${doneCount}/${subtaskCount}` });
  }
  if (commentCount > 0) {
    const badge = container.createSpan({ cls: 'abyss-task-count-badge' });
    setIcon(badge, 'message-square');
    badge.createSpan({ text: String(commentCount) });
  }
  if (linkCount > 0) {
    const badge = container.createSpan({ cls: 'abyss-task-count-badge' });
    setIcon(badge, 'paperclip');
    badge.createSpan({ text: String(linkCount) });
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
    const tagEl = container.createSpan({ cls: 'abyss-task-tag', text: tag });
    const color = colorForTag(tag, tagGroups);
    if (color !== undefined && color.length > 0) {
      tagEl.setCssProps({ '--abyss-tag-color': color });
      tagEl.addClass('abyss-task-tag--colored');
    }
  }
}

/** True if the task has anything for renderCountBadges/renderTagChips to show. */
export function hasMeta(task: TaskSnapshot): boolean {
  return (
    task.subtasks.length > 0 ||
    task.comments.length > 0 ||
    task.presentation.linkCount > 0 ||
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
  return task.subtasks.length > 0 || task.comments.length > 0 || task.presentation.linkCount > 0;
}
