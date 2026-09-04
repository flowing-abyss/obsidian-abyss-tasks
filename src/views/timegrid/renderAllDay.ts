import { type App, type Component } from 'obsidian';
import type { TagGroup } from '../../settings/types';
import type { StatusRegistry } from '../../status/StatusRegistry';
import { tagColorFor } from '../../tags/tagColor';
import { tagFillTextColorVar } from '../../tags/tagFillContrast';
import type { TaskPriority, TaskSnapshot } from '../../tasks';
import { plainGhostTaskTitle } from '../../ui/plainGhostTaskTitle';
import { renderTaskText } from '../../ui/renderTaskText';
import { renderStatusMarker } from '../../ui/StatusMarker';
import { showStatusMenuAt } from '../../ui/statusMenu';
import { statusTitleClass } from '../../ui/statusTitleClass';
import {
  attachSpanInteractions,
  type InteractiveSpanBoundaryTarget,
  type SpanInteractionOwner,
  type SpanMoveTarget,
} from '../spanInteractions';
import type { VisibleSpanLayout, VisibleSpanRow, VisibleSpanSegment } from '../spanLayout';
import {
  applyOccurrenceDomState,
  bindForecastInteractions,
  bindMaterializedInteractions,
  hasCountBadges,
  renderCalendarLeadingSlots,
  renderCountBadges,
  type CalendarContinuity,
  type CalendarOccurrenceLookup,
  type ForecastInteractionCallbacks,
} from './renderTaskMeta';

export interface AllDayCallbacks extends ForecastInteractionCallbacks {
  occurrenceFor: CalendarOccurrenceLookup;
  app: App;
  component: Component;
  onTaskClick: (task: TaskSnapshot) => void;
  onDrop: (dragData: string, targetDate: string) => void; // native HTML5 DnD, existing convention
  onStartChange: (task: TaskSnapshot, newStart: string) => void; // pointer edge-resize
  onDueChange: (task: TaskSnapshot, newDue: string) => void; // pointer edge-resize
  onExtendToSpan: (task: TaskSnapshot, newDue: string) => void; // pointer edge-resize on a plain task
  onSpanMove?: ((task: TaskSnapshot, target: SpanMoveTarget) => void) | undefined;
  onSpanBoundary?:
    ((task: TaskSnapshot, target: InteractiveSpanBoundaryTarget) => void) | undefined;
  spanInteractionOwner?: SpanInteractionOwner | undefined;
  spanPreviewLayoutFor?:
    ((task: TaskSnapshot, planning: TaskSnapshot['planning']) => VisibleSpanLayout) | undefined;
  onToggle: (task: TaskSnapshot) => void;
  onSetStatus: (task: TaskSnapshot, status: string) => void;
  onSetPriority: (task: TaskSnapshot, priority: TaskPriority) => void;
  statusRegistry: StatusRegistry;
  /** Click-to-create: fires when the user clicks genuinely empty space in this all-day cell
   * (not an existing span/plain/deadline item, and not the quick-add popover CenterPanel renders
   * into this same cell in response). Optional, mirroring TimeGridCallbacks.onCreateAtTime. */
  onCreateAtDate?: ((date: string) => void) | undefined;
}

type AllDayResizeCell = HTMLElement & {
  __tgPendingEdgeResize?: (d: string) => void;
  __tgActiveEdgeResize?: { end: () => void };
};

/**
 * Test-only seam: real edge-resize resolves the date under the pointer via
 * `activeDocument.elementFromPoint` (unreliable in jsdom, which always returns `null`).
 * Each `renderAllDayCell` call stamps `data-tg-date` on `cellEl`. The currently armed
 * edge handle registers its resolved callback only while its pointer gesture is active,
 * so tests can trigger that resize deterministically without real screen coordinates.
 */
// Mirrors renderTimedBlocks.ts's identical helpers (see that file's comment above
// MAX_DURATION_MINUTES for the full "abandoned gesture" rationale): attachEdgeResize's own
// cleanup — which restores the body's draggable="true" and removes .is-edge-resizing — is only
// reachable via pointerup/pointercancel, so if neither is ever delivered for a resize gesture
// (e.g. the pointer released outside the browser window), that state gets stuck. Pointer Capture
// guarantees the browser keeps delivering pointermove/pointerup to the capturing element for the
// rest of that gesture regardless of where the pointer physically ends up, closing the gap.
// jsdom implements neither method at all, so both feature-detect before calling.
function tryCapturePointer(el: HTMLElement, pointerId: number): void {
  if (typeof el.setPointerCapture !== 'function') return;
  try {
    el.setPointerCapture(pointerId);
  } catch {
    // Never let a rejected capture request abort the gesture — the existing window-level
    // listeners remain the fallback path either way.
  }
}

function tryReleasePointer(el: HTMLElement, pointerId: number): void {
  if (typeof el.releasePointerCapture !== 'function') return;
  try {
    el.releasePointerCapture(pointerId);
  } catch {
    // Harmless if capture was already released (e.g. implicitly, by a native-drag hijack) or
    // never actually granted.
  }
}

function endDragTestHook(cellEl: HTMLElement, targetDate: string): void {
  (cellEl as AllDayResizeCell).__tgPendingEdgeResize?.(targetDate);
}

/**
 * Span layers sit above (rather than inside) their date cells, so native drag events from an
 * interactive span cannot bubble to the cells' existing handlers. Resolve the physical column
 * from the layer's own document and forward just those overlay events to the established callback.
 */
function spanDropDateAt(
  layerEl: HTMLElement,
  variant: 'timegrid' | 'month',
  clientX: number,
): string | undefined {
  if (!Number.isFinite(clientX)) return undefined;
  const attr = variant === 'month' ? 'data-mg-date' : 'data-tg-date';
  const cls = variant === 'month' ? 'abyss-mg-cell' : 'abyss-tg-allday-cell';
  const parent = layerEl.parentElement;
  if (parent?.ownerDocument !== layerEl.ownerDocument) return undefined;
  return (
    Array.from(parent.querySelectorAll<HTMLElement>(`:scope > .${cls}[${attr}]`))
      .find((cell) => {
        const rect = cell.getBoundingClientRect();
        return clientX >= rect.left && clientX < rect.right;
      })
      ?.getAttribute(attr) ?? undefined
  );
}

type SpanOverlayDropBinding = {
  callbacks: AllDayCallbacks;
  variant: 'timegrid' | 'month';
};

const spanOverlayDropBindings = new WeakMap<HTMLElement, SpanOverlayDropBinding>();

function attachSpanOverlayDropForwarding(
  layerEl: HTMLElement,
  callbacks: AllDayCallbacks,
  variant: 'timegrid' | 'month',
): void {
  const existing = spanOverlayDropBindings.get(layerEl);
  if (existing != null) {
    existing.callbacks = callbacks;
    existing.variant = variant;
    return;
  }
  spanOverlayDropBindings.set(layerEl, { callbacks, variant });
  layerEl.addEventListener('dragover', (event) => {
    const binding = spanOverlayDropBindings.get(layerEl);
    const targetDate =
      binding == null ? undefined : spanDropDateAt(layerEl, binding.variant, event.clientX);
    if (targetDate === undefined || targetDate.length === 0) return;
    event.preventDefault();
    if (event.dataTransfer != null) event.dataTransfer.dropEffect = 'move';
  });
  layerEl.addEventListener('drop', (event) => {
    const binding = spanOverlayDropBindings.get(layerEl);
    if (binding == null) return;
    const targetDate = spanDropDateAt(layerEl, binding.variant, event.clientX);
    if (targetDate === undefined || targetDate.length === 0) return;
    event.preventDefault();
    const dragData = event.dataTransfer?.getData('text/plain');
    if (dragData !== undefined && dragData.length > 0) {
      binding.callbacks.onDrop(dragData, targetDate);
    }
  });
}

interface AllDayBodyRenderContext {
  readonly cellEl: HTMLElement;
  readonly cls: string;
  readonly task: TaskSnapshot;
  readonly callbacks: AllDayCallbacks;
  readonly tagGroups: TagGroup[];
  readonly interactive: boolean;
  readonly nativeDraggable?: boolean;
  readonly continuity?: CalendarContinuity;
  readonly spanRole?: string;
}

function renderAllDayStatusControl(
  slot: HTMLElement,
  task: TaskSnapshot,
  callbacks: AllDayCallbacks,
): void {
  renderStatusMarker(slot, {
    task,
    registry: callbacks.statusRegistry,
    interactive: true,
    onLeftClick: () => {
      callbacks.onToggle(task);
    },
    onContextMenu: (event) => {
      event.stopPropagation();
      showStatusMenuAt(event, {
        task,
        registry: callbacks.statusRegistry,
        owner: callbacks.component,
        onPickStatus: (status) => {
          callbacks.onSetStatus(task, status);
        },
        onPickPriority: (priority) => {
          callbacks.onSetPriority(task, priority);
        },
        ...(callbacks.interactionOwnership != null && {
          interactionOwnership: callbacks.interactionOwnership,
        }),
      });
    },
  });
}

function applyAllDayTagFill(el: HTMLElement, task: TaskSnapshot, tagGroups: TagGroup[]): void {
  const tagColor = tagColorFor(task.tags, tagGroups);
  if (tagColor === undefined || tagColor.length === 0) return;
  el.setCssProps({ '--abyss-tag-color': tagColor });
  const textColorVar = tagFillTextColorVar(el, tagColor);
  if (textColorVar !== undefined && textColorVar.length > 0) {
    el.setCssProps({ '--abyss-tag-text-color': textColorVar });
  }
}

function bindAllDayBodyInteractions(
  el: HTMLElement,
  task: TaskSnapshot,
  callbacks: AllDayCallbacks,
  nativeDraggable: boolean,
): void {
  const occurrence = callbacks.occurrenceFor(task);
  bindMaterializedInteractions(occurrence, (target) => {
    if (nativeDraggable && target.type === 'task') {
      el.setAttribute('draggable', 'true');
      el.addEventListener('dragstart', (event) => {
        event.dataTransfer?.setData('text/plain', `${task.source.filePath}:::${task.source.line}`);
        if (event.dataTransfer != null) event.dataTransfer.effectAllowed = 'move';
        el.addClass('is-dragging');
      });
      el.addEventListener('dragend', () => {
        el.removeClass('is-dragging');
      });
    }
    el.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      callbacks.onTaskClick(task);
    });
  });
  bindForecastInteractions(el, occurrence, callbacks);
}

function renderAllDayBody(context: AllDayBodyRenderContext): HTMLElement {
  const {
    cellEl,
    cls,
    task,
    callbacks,
    tagGroups,
    interactive,
    nativeDraggable = interactive,
    continuity = 'single',
    spanRole = 'body',
  } = context;
  const el = cellEl.createDiv({ cls: `abyss-tg-body ${cls}` });
  const occurrence = callbacks.occurrenceFor(task);
  applyOccurrenceDomState(el, occurrence, continuity, spanRole);
  // Status marker first: lets a user mark the item done without opening the modal. Its own
  // contextmenu handler stops propagation and opens the status/priority popover instead —
  // distinct from right-clicking this element's body below (opens the task modal).
  const renderControl =
    occurrence.kind === 'materialized' && interactive
      ? (slot: HTMLElement): void => {
          renderAllDayStatusControl(slot, task, callbacks);
        }
      : undefined;
  renderCalendarLeadingSlots(el, task.recurrence, occurrence.kind === 'forecast', renderControl);
  // Task 21: `.abyss-tg-body-title` (not a bare span) so it can be a flex child that
  // truncates independently — `.abyss-tg-body` itself is now a flex row (marker + title +
  // meta) instead of block-stacking, matching renderTimedBlocks.ts's `.abyss-tg-block-head`.
  // Task 38 follow-up: same is-done/is-cancelled strikethrough convention as timed
  // blocks (renderTimedBlocks.ts) — previously missing here, so a completed all-day
  // span/plain item read as plain/untouched while the same task's timed block elsewhere
  // showed struck-through.
  const titleEl = el.createSpan({ cls: `abyss-tg-body-title${statusTitleClass(task.status)}` });
  if (occurrence.kind === 'materialized' && interactive) {
    renderTaskText(titleEl, task.markdownTitle, {
      app: callbacks.app,
      sourcePath: task.source.filePath,
      component: callbacks.component,
    });
  } else {
    titleEl.setText(plainGhostTaskTitle(task));
  }
  // Count badges (subtasks/comments/links) only — Task 44: tag chips were removed here too,
  // mirroring Task 35's identical removal for timed blocks (renderTimedBlocks.ts): the item's
  // own tag-colored fill (set below) already conveys the tag, so a chip repeating it was
  // redundant and was the last place in the calendar still showing one. Gated on
  // hasCountBadges (not hasMeta, which also checks for tags) so a tag-only task with no
  // counts doesn't gain an empty, now-chip-less meta container. Non-interactive — see
  // renderTaskMeta.ts for why (avoids needing a pointerdown exclusion-guard here, next to
  // the whole-body drag and edge-resize handles this element carries).
  if (hasCountBadges(task)) {
    const meta = el.createSpan({ cls: 'abyss-tg-body-meta' });
    renderCountBadges(meta, task);
  }
  // Tag-colored fill only — the priority-colored border was removed (Task 12): the
  // status marker above already conveys priority via its own border, so a second
  // priority border on the body was redundant visual noise.
  applyAllDayTagFill(el, task, tagGroups);
  bindAllDayBodyInteractions(el, task, callbacks, nativeDraggable);
  return el;
}

interface AllDaySpanSegmentRenderContext {
  readonly layerEl: HTMLElement;
  readonly indexByDate: ReadonlyMap<string, number>;
  readonly callbacks: AllDayCallbacks;
  readonly tagGroups: TagGroup[];
  readonly interactionOwner: SpanInteractionOwner;
  readonly variant: 'timegrid' | 'month';
}

function spanSegmentClasses(segment: VisibleSpanSegment, variant: 'timegrid' | 'month'): string {
  return [
    segment.kind === 'ghost' ? 'abyss-tg-span-continuation' : 'abyss-tg-span',
    'abyss-span-piece',
    variant === 'month' ? 'abyss-mg-span-segment' : '',
    variant === 'month' && segment.kind === 'ghost' ? 'abyss-mg-span-continuation' : '',
  ]
    .filter((className) => className.length > 0)
    .join(' ');
}

function decorateMonthSpan(body: HTMLElement, task: TaskSnapshot): void {
  body.querySelector('.abyss-tg-body-title')?.classList.add('abyss-mg-item-title');
  if (task.planning.time == null) return;
  const time = body.createSpan({ cls: 'abyss-mg-item-time', text: `${task.planning.time} ` });
  const title = body.querySelector('.abyss-tg-body-title');
  body.insertBefore(time, title);
}

function segmentBoundaryHandles(
  body: HTMLElement,
  segment: VisibleSpanSegment,
  exposesRangeProxy: boolean,
): Array<{ element: HTMLElement; boundary: 'start' | 'due' }> {
  const handles: Array<{ element: HTMLElement; boundary: 'start' | 'due' }> = [];
  const proxyClass = exposesRangeProxy ? ' abyss-tg-span-edge--proxy' : '';
  if (segment.ownsStartBoundary || exposesRangeProxy) {
    const element = body.createDiv({
      cls: `abyss-tg-span-edge abyss-tg-span-edge--left${proxyClass}`,
    });
    element.setAttribute('data-boundary', 'start');
    element.setAttribute('data-resize-edge', 'start-date');
    handles.push({ element, boundary: 'start' });
  }
  if (segment.ownsDueBoundary || exposesRangeProxy) {
    const element = body.createDiv({
      cls: `abyss-tg-span-edge abyss-tg-span-edge--right${proxyClass}`,
    });
    element.setAttribute('data-boundary', 'due');
    element.setAttribute('data-resize-edge', 'due-date');
    handles.push({ element, boundary: 'due' });
  }
  return handles;
}

function attachSegmentInteractions(
  body: HTMLElement,
  segment: VisibleSpanSegment,
  context: AllDaySpanSegmentRenderContext,
): void {
  const occurrence = context.callbacks.occurrenceFor(segment.task);
  bindMaterializedInteractions(occurrence, (target) => {
    if (target.type !== 'task') return;
    body.setAttribute('tabindex', '0');
    const exposesRangeProxy = context.indexByDate.size > 1 && segment.kind === 'ghost';
    attachSpanInteractions({
      source: body,
      task: segment.task,
      segmentStart: segment.date,
      segmentEnd: segment.date,
      owner: context.interactionOwner,
      previewLayoutFor: context.callbacks.spanPreviewLayoutFor,
      boundaryHandles: segmentBoundaryHandles(body, segment, exposesRangeProxy),
      onMove: (task, moveTarget) => context.callbacks.onSpanMove?.(task, moveTarget),
      onBoundary: (task, boundaryTarget) =>
        context.callbacks.onSpanBoundary?.(task, boundaryTarget),
    });
  });
}

/** Render one day-local span segment, including its metadata, boundary handles, and interactions. */
function renderAllDaySpanSegment(
  segment: VisibleSpanSegment,
  context: AllDaySpanSegmentRenderContext,
): void {
  const { layerEl, indexByDate, callbacks, tagGroups, variant } = context;
  const index = indexByDate.get(segment.date);
  if (index === undefined) return;
  const host = layerEl.createDiv({ cls: 'abyss-span-piece-host' });
  host.setAttribute(variant === 'month' ? 'data-mg-date' : 'data-tg-date', segment.date);
  host.style.gridColumn = `${index + 1} / ${index + 2}`;
  host.style.gridRow = String(segment.lane + 1);
  const body = renderAllDayBody({
    cellEl: host,
    cls: spanSegmentClasses(segment, variant),
    task: segment.task,
    callbacks,
    tagGroups,
    interactive: segment.kind === 'terminal',
    nativeDraggable: false,
    continuity: segment.kind === 'terminal' ? 'terminal' : 'continuation',
    spanRole: `${segment.kind === 'terminal' ? 'span-terminal' : 'span-continuation'}:${segment.date}`,
  });
  body.setAttribute('data-span-kind', segment.kind);
  body.dataset['spanDate'] = segment.date;
  body.dataset['continuesBefore'] = String(segment.continuesBefore);
  body.dataset['continuesAfter'] = String(segment.continuesAfter);
  body.setAttribute('data-task-path', segment.task.source.filePath);
  body.setAttribute('data-task-line', String(segment.task.source.line));
  body.style.gridColumn = `${index + 1} / ${index + 2}`;
  body.style.gridRow = String(segment.lane + 1);
  if (variant === 'month') decorateMonthSpan(body, segment.task);
  attachSegmentInteractions(body, segment, context);
}

/** Render one row's semantic spans as day-local grid pieces above the persistent day cells. */
export function renderAllDaySpanLayer(
  ...args: [
    layerEl: HTMLElement,
    row: VisibleSpanRow,
    dates: readonly string[],
    callbacks: AllDayCallbacks,
    tagGroups: TagGroup[],
    interactionOwner: SpanInteractionOwner,
    variant: 'timegrid' | 'month',
  ]
): void {
  const [layerEl, row, dates, callbacks, tagGroups, interactionOwner, variant] = args;
  layerEl.empty();
  layerEl.setAttribute('data-span-lanes', String(row.laneCount));
  layerEl.style.setProperty('--abyss-span-track-count', String(dates.length));
  attachSpanOverlayDropForwarding(layerEl, callbacks, variant);
  const indexByDate = new Map(dates.map((date, index) => [date, index]));
  const context: AllDaySpanSegmentRenderContext = {
    layerEl,
    indexByDate,
    callbacks,
    tagGroups,
    interactionOwner,
    variant,
  };

  for (const segment of row.segments) {
    renderAllDaySpanSegment(segment, context);
  }
}

function renderDraggableBody(
  ...args: [
    cellEl: HTMLElement,
    cls: string,
    task: TaskSnapshot,
    callbacks: AllDayCallbacks,
    tagGroups: TagGroup[],
    spanRole: string,
  ]
): HTMLElement {
  const [cellEl, cls, task, callbacks, tagGroups, spanRole] = args;
  return renderAllDayBody({
    cellEl,
    cls,
    task,
    callbacks,
    tagGroups,
    interactive: true,
    nativeDraggable: true,
    continuity: 'single',
    spanRole,
  });
}

function renderSpanContinuation(
  cellEl: HTMLElement,
  task: TaskSnapshot,
  callbacks: AllDayCallbacks,
  tagGroups: TagGroup[],
): HTMLElement {
  return renderAllDayBody({
    cellEl,
    cls: 'abyss-tg-span-continuation',
    task,
    callbacks,
    tagGroups,
    interactive: false,
    nativeDraggable: false,
    continuity: 'continuation',
    spanRole: 'span-continuation',
  });
}

/**
 * Attach pointer-based edge-resize to a handle (a span's start/due edge, or a plain
 * task's new right edge). In real usage the pointerup handler resolves the date under
 * the pointer via `activeDocument.elementFromPoint`, finding the nearest ancestor with
 * `data-tg-date` (stamped by whichever `renderAllDayCell` call rendered that day
 * column). While its pointer gesture is active, it also registers a direct-invocation
 * callback on `cellEl` for the jsdom test seam (see `endDragTestHook`).
 *
 * `onResolve` is called with the resolved date once the drag ends over a valid day
 * cell; callers pass whichever mutation the handle should trigger (`onStartChange`,
 * `onDueChange`, or `onExtendToSpan`) so the drag mechanics stay shared.
 */
function attachEdgeResize(
  ...args: [
    handle: HTMLElement,
    cellEl: HTMLElement,
    task: TaskSnapshot,
    onResolve: (task: TaskSnapshot, date: string) => void,
    interactionOwner?: SpanInteractionOwner,
  ]
): void {
  const [handle, cellEl, task, onResolve, interactionOwner] = args;
  // The handle sits inside a `draggable="true"` body (renderDraggableBody, for the
  // whole-task cross-day move). draggable="false" here is NOT enough on its own to stop a
  // mousedown+drag gesture starting on the handle from arming the ancestor's native HTML5
  // dragstart: per the HTML Drag and Drop spec, a mousedown on a non-draggable descendant of a
  // draggable element still starts a drag FROM THE ANCESTOR (the browser walks up to the
  // nearest draggable=true element and uses that as the drag source) — draggable="false" only
  // stops the handle itself from being independently draggable, it does not block the ancestor
  // fallback. Confirmed live (Task 37): dragging an edge handle armed the body's own `dragstart`,
  // which used to add an opacity fade to `.is-dragging` for the duration of the resize and fired
  // `dragover`/`.is-drag-over` on every day cell the pointer crossed — the
  // washed-out "phantom" look and "grid becomes uneven" reports were this accidental native drag,
  // not a deliberate preview. Fixed below by flipping the ancestor's own `draggable` off for the
  // duration of the gesture (armed on this handle's pointerdown, restored on pointerup/cancel),
  // which actually prevents the fallback per spec, instead of racing it.
  handle.setAttribute('draggable', 'false');
  const body = handle.closest<HTMLElement>('.abyss-tg-body');
  const ownerDocument = handle.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  if (ownerWindow == null) return;

  const resolve = (date: string): void => {
    onResolve(task, date);
  };
  const withHook = cellEl as AllDayResizeCell;

  // Task 37: a deliberate, lightweight "this is being reshaped" state — toggled purely as a CSS
  // class on the dragged item's own element (see .abyss-tg-body.is-edge-resizing in styles.css), no
  // DOM creation/measurement and no sibling elements touched, so it can't itself cause the sibling
  // layout thrash the "grid becomes uneven" report described.
  let capturedPointerId: number | null = null;

  const endResize = (): void => {
    body?.setAttribute('draggable', 'true');
    body?.removeClass('is-edge-resizing');
    ownerWindow.removeEventListener('pointerup', onPointerUp);
    ownerWindow.removeEventListener('pointercancel', onPointerCancel);
    if (capturedPointerId !== null) tryReleasePointer(handle, capturedPointerId);
    capturedPointerId = null;
    if (withHook.__tgPendingEdgeResize === resolve) delete withHook.__tgPendingEdgeResize;
    if (withHook.__tgActiveEdgeResize?.end === endResize) delete withHook.__tgActiveEdgeResize;
    interactionOwner?.end(endResize);
  };

  const onPointerUp = (upEvent: PointerEvent): void => {
    if (upEvent.pointerId !== capturedPointerId) return;
    const target = ownerDocument.elementFromPoint(upEvent.clientX, upEvent.clientY);
    const dayEl = target?.closest('[data-tg-date]');
    const date = dayEl?.getAttribute('data-tg-date');
    if (date !== null && date !== undefined && date.length > 0) resolve(date);
    endResize();
  };

  // Defensive belt-and-suspenders (mirrors renderTimedBlocks.ts's attachHorizontalResize): if a
  // native drag were ever armed despite the draggable="false" flip above, the pointer session
  // would end in `pointercancel` rather than `pointerup`, and without this the window
  // pointermove/pointerup/pointercancel listeners would leak instead of being torn down.
  const onPointerCancel = (cancelEvent: PointerEvent): void => {
    if (cancelEvent.pointerId !== capturedPointerId) return;
    endResize();
  };

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    withHook.__tgActiveEdgeResize?.end();
    body?.setAttribute('draggable', 'false');
    body?.addClass('is-edge-resizing');
    capturedPointerId = e.pointerId;
    withHook.__tgActiveEdgeResize = { end: endResize };
    withHook.__tgPendingEdgeResize = resolve;
    interactionOwner?.begin(endResize);
    tryCapturePointer(handle, capturedPointerId);
    ownerWindow.addEventListener('pointerup', onPointerUp);
    ownerWindow.addEventListener('pointercancel', onPointerCancel);
  });
}

interface AllDayCellRenderContext {
  readonly cellEl: HTMLElement;
  readonly date: string;
  readonly callbacks: AllDayCallbacks;
  readonly tagGroups: TagGroup[];
}

function renderCellSpans(context: AllDayCellRenderContext, spans: readonly TaskSnapshot[]): void {
  const { cellEl, date, callbacks, tagGroups } = context;
  for (const task of spans) {
    if (String(task.planning.due) !== date) {
      renderSpanContinuation(cellEl, task, callbacks, tagGroups);
      continue;
    }
    const bar = renderDraggableBody(
      cellEl,
      'abyss-tg-span',
      task,
      callbacks,
      tagGroups,
      'span-terminal',
    );
    const occurrence = callbacks.occurrenceFor(task);
    applyOccurrenceDomState(bar, occurrence, 'terminal', 'span-terminal');
    bindMaterializedInteractions(occurrence, () => {
      renderSpanResizeHandles(context, bar, task);
    });
  }
}

function renderSpanResizeHandles(
  context: AllDayCellRenderContext,
  bar: HTMLElement,
  task: TaskSnapshot,
): void {
  const { cellEl, callbacks } = context;
  const leftEdge = bar.createDiv({ cls: 'abyss-tg-span-edge abyss-tg-span-edge--left' });
  leftEdge.setAttribute('data-boundary', 'start');
  leftEdge.setAttribute('data-resize-edge', 'start-date');
  attachEdgeResize(leftEdge, cellEl, task, callbacks.onStartChange, callbacks.spanInteractionOwner);
  const rightEdge = bar.createDiv({ cls: 'abyss-tg-span-edge abyss-tg-span-edge--right' });
  rightEdge.setAttribute('data-boundary', 'due');
  rightEdge.setAttribute('data-resize-edge', 'due-date');
  attachEdgeResize(rightEdge, cellEl, task, callbacks.onDueChange, callbacks.spanInteractionOwner);
}

function renderCellPlainTasks(
  context: AllDayCellRenderContext,
  tasks: readonly TaskSnapshot[],
): void {
  const { cellEl, callbacks, tagGroups } = context;
  for (const task of tasks) {
    const role =
      task.planning.scheduled != null && task.planning.scheduled !== task.planning.due
        ? 'scheduled-body'
        : 'all-day-body';
    const chip = renderDraggableBody(cellEl, 'abyss-tg-plain', task, callbacks, tagGroups, role);
    bindMaterializedInteractions(callbacks.occurrenceFor(task), () => {
      renderPlainTaskResizeHandle(context, chip, task);
    });
  }
}

function renderPlainTaskResizeHandle(
  context: AllDayCellRenderContext,
  chip: HTMLElement,
  task: TaskSnapshot,
): void {
  const { cellEl, date, callbacks } = context;
  const rightEdge = chip.createDiv({ cls: 'abyss-tg-span-edge abyss-tg-span-edge--right' });
  rightEdge.setAttribute('data-boundary', 'create-span');
  rightEdge.setAttribute('data-resize-edge', 'due-date');
  const owner = callbacks.spanInteractionOwner;
  if (owner == null) {
    attachEdgeResize(rightEdge, cellEl, task, callbacks.onExtendToSpan);
    return;
  }
  attachSpanInteractions({
    source: chip,
    task,
    segmentStart: date,
    segmentEnd: date,
    owner,
    previewLayoutFor: callbacks.spanPreviewLayoutFor,
    boundaryHandles: [{ element: rightEdge, boundary: 'create-span' }],
    onMove: () => undefined,
    onBoundary: (targetTask, target) => {
      callbacks.onExtendToSpan(targetTask, target.date);
    },
    enableMove: false,
  });
}

function renderDeadlineStatusControl(
  slot: HTMLElement,
  task: TaskSnapshot,
  callbacks: AllDayCallbacks,
): void {
  renderStatusMarker(slot, {
    task,
    registry: callbacks.statusRegistry,
    interactive: true,
    onLeftClick: () => {
      callbacks.onToggle(task);
    },
    onContextMenu: (event) => {
      event.stopPropagation();
      showStatusMenuAt(event, {
        task,
        registry: callbacks.statusRegistry,
        owner: callbacks.component,
        onPickStatus: (symbol) => {
          callbacks.onSetStatus(task, symbol);
        },
        onPickPriority: (priority) => {
          callbacks.onSetPriority(task, priority);
        },
        ...(callbacks.interactionOwnership != null && {
          interactionOwnership: callbacks.interactionOwnership,
        }),
      });
    },
  });
}

function renderDeadlineTitle(
  marker: HTMLElement,
  task: TaskSnapshot,
  callbacks: AllDayCallbacks,
  occurrence: ReturnType<AllDayCallbacks['occurrenceFor']>,
): void {
  marker.createSpan({ text: '📅 ' });
  const titleEl = marker.createSpan({
    cls: `abyss-tg-deadline-title${statusTitleClass(task.status)}`,
  });
  if (occurrence.kind === 'forecast') {
    titleEl.setText(plainGhostTaskTitle(task));
    return;
  }
  renderTaskText(titleEl, task.markdownTitle, {
    app: callbacks.app,
    sourcePath: task.source.filePath,
    component: callbacks.component,
  });
}

function renderDeadlineTask(context: AllDayCellRenderContext, task: TaskSnapshot): void {
  const { cellEl, callbacks } = context;
  const marker = cellEl.createDiv({ cls: 'abyss-tg-deadline-marker' });
  const occurrence = callbacks.occurrenceFor(task);
  applyOccurrenceDomState(marker, occurrence, 'single', 'due-deadline');
  if (task.priority !== 'D') marker.setAttribute('data-priority', task.priority);
  const renderControl =
    occurrence.kind === 'materialized'
      ? (slot: HTMLElement): void => {
          renderDeadlineStatusControl(slot, task, callbacks);
        }
      : undefined;
  renderCalendarLeadingSlots(
    marker,
    task.recurrence,
    occurrence.kind === 'forecast',
    renderControl,
  );
  renderDeadlineTitle(marker, task, callbacks, occurrence);
  if (hasCountBadges(task)) {
    const meta = marker.createSpan({ cls: 'abyss-tg-body-meta' });
    renderCountBadges(meta, task);
  }
  bindMaterializedInteractions(occurrence, () => {
    marker.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      callbacks.onTaskClick(task);
    });
  });
  bindForecastInteractions(marker, occurrence, callbacks);
}

function renderCellDeadlines(
  context: AllDayCellRenderContext,
  deadlines: readonly TaskSnapshot[],
): void {
  for (const task of deadlines) renderDeadlineTask(context, task);
}

function attachCellDropInteractions(context: AllDayCellRenderContext): void {
  const { cellEl, date, callbacks } = context;
  cellEl.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (event.dataTransfer != null) event.dataTransfer.dropEffect = 'move';
    cellEl.addClass('is-drag-over');
  });
  cellEl.addEventListener('dragleave', (event) => {
    if (!cellEl.contains(event.relatedTarget as Node)) cellEl.removeClass('is-drag-over');
  });
  cellEl.addEventListener('drop', (event) => {
    event.preventDefault();
    cellEl.removeClass('is-drag-over');
    const dragData = event.dataTransfer?.getData('text/plain');
    if (dragData !== undefined && dragData.length > 0) callbacks.onDrop(dragData, date);
  });
}

function attachCellCreation(context: AllDayCellRenderContext): void {
  const { cellEl, date, callbacks } = context;
  const onCreateAtDate = callbacks.onCreateAtDate;
  if (onCreateAtDate == null) return;
  cellEl.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (
      target.closest('.abyss-tg-body, .abyss-tg-deadline-marker, .abyss-tg-allday-quick-add') !=
      null
    ) {
      return;
    }
    onCreateAtDate(date);
  });
}

export function renderAllDayCell(
  ...args: [
    cellEl: HTMLElement,
    date: string,
    spans: TaskSnapshot[],
    plain: TaskSnapshot[],
    deadlines: TaskSnapshot[],
    callbacks: AllDayCallbacks,
    tagGroups?: TagGroup[],
  ]
): void {
  const [cellEl, date, spans, plain, deadlines, callbacks, tagGroups = []] = args;
  cellEl.setAttribute('data-tg-date', date);
  (cellEl as unknown as { __tgTestEndDrag?: (targetDate: string) => void }).__tgTestEndDrag = (
    targetDate: string,
  ) => {
    endDragTestHook(cellEl, targetDate);
  };
  const context = { cellEl, date, callbacks, tagGroups };
  renderCellSpans(context, spans);
  renderCellPlainTasks(context, plain);
  renderCellDeadlines(context, deadlines);
  attachCellDropInteractions(context);
  attachCellCreation(context);
}
