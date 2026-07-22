import { Component, type App } from 'obsidian';
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
import { hasCountBadges, renderCountBadges } from './renderTaskMeta';

export interface AllDayCallbacks {
  app: App;
  component: Component;
  onTaskClick: (task: TaskSnapshot) => void;
  onDrop: (dragData: string, targetDate: string) => void; // native HTML5 DnD, existing convention
  onStartChange: (task: TaskSnapshot, newStart: string) => void; // pointer edge-resize
  onDueChange: (task: TaskSnapshot, newDue: string) => void; // pointer edge-resize
  onExtendToSpan: (task: TaskSnapshot, newDue: string) => void; // pointer edge-resize on a plain task
  onToggle: (task: TaskSnapshot) => void;
  onSetStatus: (task: TaskSnapshot, status: string) => void;
  onSetPriority: (task: TaskSnapshot, priority: TaskPriority) => void;
  statusRegistry: StatusRegistry;
  /** Click-to-create: fires when the user clicks genuinely empty space in this all-day cell
   * (not an existing span/plain/deadline item, and not the quick-add popover CenterPanel renders
   * into this same cell in response). Optional, mirroring TimeGridCallbacks.onCreateAtTime. */
  onCreateAtDate?: (date: string) => void;
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

function renderAllDayBody(
  cellEl: HTMLElement,
  cls: string,
  task: TaskSnapshot,
  callbacks: AllDayCallbacks,
  tagGroups: TagGroup[],
  interactive: boolean,
): HTMLElement {
  const el = cellEl.createDiv({ cls: `tc-tg-body ${cls}` });
  // Status marker first: lets a user mark the item done without opening the modal. Its own
  // contextmenu handler stops propagation and opens the status/priority popover instead —
  // distinct from right-clicking this element's body below (opens the task modal).
  if (interactive) {
    renderStatusMarker(el, {
      task,
      registry: callbacks.statusRegistry,
      onLeftClick: () => callbacks.onToggle(task),
      onContextMenu: (ev) => {
        ev.stopPropagation();
        showStatusMenuAt(ev, {
          task,
          registry: callbacks.statusRegistry,
          onPickStatus: (c) => callbacks.onSetStatus(task, c),
          onPickPriority: (p) => callbacks.onSetPriority(task, p),
        });
      },
    });
  }
  // Task 21: `.tc-tg-body-title` (not a bare span) so it can be a flex child that
  // truncates independently — `.tc-tg-body` itself is now a flex row (marker + title +
  // meta) instead of block-stacking, matching renderTimedBlocks.ts's `.tc-tg-block-head`.
  // Task 38 follow-up: same is-done/is-cancelled strikethrough convention as timed
  // blocks (renderTimedBlocks.ts) — previously missing here, so a completed all-day
  // span/plain item read as plain/untouched while the same task's timed block elsewhere
  // showed struck-through.
  const titleEl = el.createSpan({ cls: `tc-tg-body-title${statusTitleClass(task.status)}` });
  if (interactive) {
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
    const meta = el.createSpan({ cls: 'tc-tg-body-meta' });
    renderCountBadges(meta, task);
  }
  // Tag-colored fill only — the priority-colored border was removed (Task 12): the
  // status marker above already conveys priority via its own border, so a second
  // priority border on the body was redundant visual noise.
  const tagColor = tagColorFor(task.tags, tagGroups);
  if (tagColor) {
    el.setCssProps({ '--tc-tag-color': tagColor });
    // Task 40 (Round 4): see tagFillContrast.ts's own doc comment — a fixed text color loses
    // contrast against a bright/pale or very dark/desaturated tag fill; only overridden when a
    // variant was actually computed, otherwise the CSS rule's var(--text-normal) fallback holds.
    // Continuations use their own 18% translucent CSS fill; interactive terminal/plain bodies
    // retain the shared 40% fill, so each variant is chosen against the fill it actually has.
    const tagFillPercent = interactive ? 40 : 18;
    const textColorVar = tagFillTextColorVar(el, tagColor, tagFillPercent);
    if (textColorVar) el.setCssProps({ '--tc-tag-text-color': textColorVar });
  }
  if (interactive) {
    el.setAttribute('draggable', 'true');
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('text/plain', `${task.source.filePath}:::${task.source.line}`);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      el.addClass('is-dragging');
    });
    el.addEventListener('dragend', () => el.removeClass('is-dragging'));
  }
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    callbacks.onTaskClick(task);
  });
  return el;
}

function renderDraggableBody(
  cellEl: HTMLElement,
  cls: string,
  task: TaskSnapshot,
  callbacks: AllDayCallbacks,
  tagGroups: TagGroup[],
): HTMLElement {
  return renderAllDayBody(cellEl, cls, task, callbacks, tagGroups, true);
}

function renderSpanContinuation(
  cellEl: HTMLElement,
  task: TaskSnapshot,
  callbacks: AllDayCallbacks,
  tagGroups: TagGroup[],
): HTMLElement {
  return renderAllDayBody(cellEl, 'tc-tg-span-continuation', task, callbacks, tagGroups, false);
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
  handle: HTMLElement,
  cellEl: HTMLElement,
  task: TaskSnapshot,
  onResolve: (task: TaskSnapshot, date: string) => void,
): void {
  // The handle sits inside a `draggable="true"` body (renderDraggableBody, for the
  // whole-task cross-day move). draggable="false" here is NOT enough on its own to stop a
  // mousedown+drag gesture starting on the handle from arming the ancestor's native HTML5
  // dragstart: per the HTML Drag and Drop spec, a mousedown on a non-draggable descendant of a
  // draggable element still starts a drag FROM THE ANCESTOR (the browser walks up to the
  // nearest draggable=true element and uses that as the drag source) — draggable="false" only
  // stops the handle itself from being independently draggable, it does not block the ancestor
  // fallback. Confirmed live (Task 37): dragging an edge handle armed the body's own `dragstart`,
  // which added `.is-dragging` (opacity: 0.5, styles.css) to the whole item for the duration of
  // the resize and fired `dragover`/`.is-drag-over` on every day cell the pointer crossed — the
  // washed-out "phantom" look and "grid becomes uneven" reports were this accidental native drag,
  // not a deliberate preview. Fixed below by flipping the ancestor's own `draggable` off for the
  // duration of the gesture (armed on this handle's pointerdown, restored on pointerup/cancel),
  // which actually prevents the fallback per spec, instead of racing it.
  handle.setAttribute('draggable', 'false');
  const body = handle.closest<HTMLElement>('.tc-tg-body');

  const resolve = (date: string): void => {
    onResolve(task, date);
  };
  const withHook = cellEl as AllDayResizeCell;

  // Task 39: live feedback for this edge-resize's day-crossing, mirroring
  // renderTimedBlocks.ts's attachHorizontalResize (Task 34/29's timed-span equivalent of this
  // gesture) — same reasoning: the commit already resolves the day under the pointer via
  // `elementFromPoint` on release, this just surfaces that resolution live by toggling
  // `.is-drag-over` on whichever `[data-tg-date]` cell the pointer is currently over, reusing
  // the SAME class the native cross-day drag (`renderAllDayCell`'s own dragover handler below)
  // already uses for an identical "this is where you'd land" signal.
  let hoveredDayEl: Element | null = null;

  const clearHoveredDay = (): void => {
    hoveredDayEl?.classList.remove('is-drag-over');
    hoveredDayEl = null;
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (e.pointerId !== capturedPointerId) return;
    e.preventDefault();
    const target = activeDocument.elementFromPoint(e.clientX, e.clientY);
    const dayEl = target?.closest('[data-tg-date]') ?? null;
    if (dayEl === hoveredDayEl) return;
    hoveredDayEl?.classList.remove('is-drag-over');
    dayEl?.classList.add('is-drag-over');
    hoveredDayEl = dayEl;
  };

  // Task 37: a deliberate, lightweight "this is being reshaped" state — toggled purely as a CSS
  // class on the dragged item's own element (see .tc-tg-body.is-edge-resizing in styles.css), no
  // DOM creation/measurement and no sibling elements touched, so it can't itself cause the sibling
  // layout thrash the "grid becomes uneven" report described.
  let capturedPointerId: number | null = null;

  const endResize = (): void => {
    body?.setAttribute('draggable', 'true');
    body?.removeClass('is-edge-resizing');
    clearHoveredDay();
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    if (capturedPointerId !== null) tryReleasePointer(handle, capturedPointerId);
    capturedPointerId = null;
    if (withHook.__tgPendingEdgeResize === resolve) delete withHook.__tgPendingEdgeResize;
    if (withHook.__tgActiveEdgeResize?.end === endResize) delete withHook.__tgActiveEdgeResize;
  };

  const onPointerUp = (upEvent: PointerEvent): void => {
    if (upEvent.pointerId !== capturedPointerId) return;
    const target = activeDocument.elementFromPoint(upEvent.clientX, upEvent.clientY);
    const dayEl = target?.closest('[data-tg-date]');
    const date = dayEl?.getAttribute('data-tg-date');
    if (date) resolve(date);
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
    tryCapturePointer(handle, capturedPointerId);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
  });
}

export function renderAllDayCell(
  cellEl: HTMLElement,
  date: string,
  spans: TaskSnapshot[], // tasks with start && due (multi-day)
  plain: TaskSnapshot[], // tasks with a due-or-scheduled anchor but no time/start (single-day chip)
  deadlines: TaskSnapshot[], // tasks where scheduled is set AND due is set (due renders as marker, not body)
  callbacks: AllDayCallbacks,
  tagGroups: TagGroup[] = [],
): void {
  cellEl.setAttribute('data-tg-date', date);
  (cellEl as unknown as { __tgTestEndDrag?: (targetDate: string) => void }).__tgTestEndDrag = (
    targetDate: string,
  ) => endDragTestHook(cellEl, targetDate);

  for (const t of spans) {
    if (String(t.planning.due) !== date) {
      renderSpanContinuation(cellEl, t, callbacks, tagGroups);
      continue;
    }
    const bar = renderDraggableBody(cellEl, 'tc-tg-span', t, callbacks, tagGroups);
    const leftEdge = bar.createDiv({ cls: 'tc-tg-span-edge tc-tg-span-edge--left' });
    attachEdgeResize(leftEdge, cellEl, t, callbacks.onStartChange);
    const rightEdge = bar.createDiv({ cls: 'tc-tg-span-edge tc-tg-span-edge--right' });
    attachEdgeResize(rightEdge, cellEl, t, callbacks.onDueChange);
  }
  for (const t of plain) {
    const chip = renderDraggableBody(cellEl, 'tc-tg-plain', t, callbacks, tagGroups);
    // A plain task has no `start` yet: dragging this handle doesn't just move `due`
    // (there'd be nothing anchoring the other end) — it extends the task into a real
    // multi-day span, so it's wired to onExtendToSpan rather than onDueChange.
    const rightEdge = chip.createDiv({ cls: 'tc-tg-span-edge tc-tg-span-edge--right' });
    attachEdgeResize(rightEdge, cellEl, t, callbacks.onExtendToSpan);
  }
  for (const t of deadlines) {
    const marker = cellEl.createDiv({ cls: 'tc-tg-deadline-marker' });
    // Priority-colored border (color = priority convention); no tag fill — deadline
    // markers stay a compact pill, not a filled colored body (structural distinction).
    if (t.priority !== 'D') marker.setAttribute('data-priority', t.priority);
    renderStatusMarker(marker, {
      task: t,
      registry: callbacks.statusRegistry,
      onLeftClick: () => callbacks.onToggle(t),
      onContextMenu: (ev) => {
        ev.stopPropagation();
        showStatusMenuAt(ev, {
          task: t,
          registry: callbacks.statusRegistry,
          onPickStatus: (c) => callbacks.onSetStatus(t, c),
          onPickPriority: (p) => callbacks.onSetPriority(t, p),
        });
      },
    });
    marker.createSpan({ text: '📅 ' });
    // Task 38 follow-up: same is-done/is-cancelled strikethrough convention as timed blocks
    // and all-day span/plain items above — previously this title had no status class at all.
    const titleEl = marker.createSpan({ cls: `tc-tg-deadline-title${statusTitleClass(t.status)}` });
    renderTaskText(titleEl, t.markdownTitle, {
      app: callbacks.app,
      sourcePath: t.source.filePath,
      component: callbacks.component,
    });
    // Count badges only (no tag chips) — deadline markers deliberately stay a compact
    // pill with no tag fill (see comment above), so tag chips would fight that convention.
    if (
      (t.subtasks?.length ?? 0) > 0 ||
      (t.comments?.length ?? 0) > 0 ||
      (t.presentation.linkCount ?? 0) > 0
    ) {
      const meta = marker.createSpan({ cls: 'tc-tg-body-meta' });
      renderCountBadges(meta, t);
    }
    marker.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      callbacks.onTaskClick(t);
    });
  }

  cellEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    cellEl.addClass('is-drag-over');
  });
  cellEl.addEventListener('dragleave', (e) => {
    if (!cellEl.contains(e.relatedTarget as Node)) cellEl.removeClass('is-drag-over');
  });
  cellEl.addEventListener('drop', (e) => {
    e.preventDefault();
    cellEl.removeClass('is-drag-over');
    const dragData = e.dataTransfer?.getData('text/plain');
    if (dragData) callbacks.onDrop(dragData, date);
  });

  if (callbacks.onCreateAtDate) {
    // Click-to-create: fires only for a click on genuinely empty space — not on an existing
    // span/plain/deadline item (dragged/clicked for its own context menu) and not on the
    // quick-add popover CenterPanel renders into this same cell in response. Mirrors
    // HourGrid.ts's onCreateAtTime guard.
    cellEl.addEventListener('click', (e) => {
      if (
        (e.target as HTMLElement).closest(
          '.tc-tg-body, .tc-tg-deadline-marker, .tc-tg-allday-quick-add',
        )
      )
        return;
      callbacks.onCreateAtDate?.(date);
    });
  }
}
