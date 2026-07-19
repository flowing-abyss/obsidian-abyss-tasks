import { Component, type App } from 'obsidian';
import { formatDurationFromMinutes } from '../../parser/TaskParser';
import type { TagGroup } from '../../settings/types';
import type { StatusRegistry } from '../../status/StatusRegistry';
import { tagColorFor } from '../../tags/tagColor';
import { tagFillTextColorVar } from '../../tags/tagFillContrast';
import type { TaskPriority, TaskSnapshot } from '../../tasks';
import { renderStatusMarker } from '../../ui/StatusMarker';
import { renderTaskText } from '../../ui/renderTaskText';
import { showStatusMenuAt } from '../../ui/statusMenu';
import { statusTitleClass } from '../../ui/statusTitleClass';
import {
  capContinuationMinHeightsPx,
  capMinHeightsPx,
  MIN_BLOCK_HEIGHT_PX,
  minutesToPixels,
  minutesToTimeString,
  packOverlaps,
  snapMinutes,
  timeStringToMinutes,
  type TimedBlockInput,
} from './layout';
import { hasCountBadges, renderCountBadges } from './renderTaskMeta';

export type TimedBlockKeyboardIntent =
  | { readonly type: 'move-time'; readonly deltaMinutes: -15 | 15 }
  | { readonly type: 'resize-duration'; readonly deltaMinutes: -5 | 5 }
  | { readonly type: 'shift-schedule'; readonly days: -1 | 1 }
  | { readonly type: 'extend-start'; readonly days: -1 }
  | { readonly type: 'extend-due'; readonly days: 1 };

export interface TimedBlockCallbacks {
  app: App;
  component: Component;
  onTaskClick: (task: TaskSnapshot) => void;
  onKeyboardIntent: (task: TaskSnapshot, intent: TimedBlockKeyboardIntent) => void;
  onTimeChange: (task: TaskSnapshot, newStartMinutes: number) => void;
  onDurationChange: (task: TaskSnapshot, newDurationMinutes: number) => void;
  /** Task 29: horizontal right-edge drag-resize, extending the block into a multi-day timed
   * span. Same mutation as renderAllDay.ts's onExtendToSpan (freezes the original `due` as
   * `start`, moves `due` to the dragged-to date) — reused as-is since it already leaves
   * `⏰`/`⏱️` untouched, which is exactly what preserving the task's time/duration needs. */
  onExtendToSpan: (task: TaskSnapshot, newDue: string) => void;
  /** Task 34: horizontal left-edge drag-resize, moving/adding `start` while `due`/`⏰`/`⏱️`
   * stay untouched. Same mutation as renderAllDay.ts's onStartChange/CenterPanel's
   * updateTaskStart — reused as-is: whether the task already has a `start` (moved directly)
   * or not (a fresh 🛫 is appended, anchored on the task's own unmoved `due`), `due` is never
   * part of this mutation's `build()` closure, so it can't be touched by it either way. */
  onStartChange: (task: TaskSnapshot, newStart: string) => void;
  onToggle: (task: TaskSnapshot) => void;
  onSetStatus: (task: TaskSnapshot, status: string) => void;
  onSetPriority: (task: TaskSnapshot, priority: TaskPriority) => void;
  statusRegistry: StatusRegistry;
}

const DEFAULT_DURATION_MINUTES = 60;
const SNAP_MINUTES = 15;
// Task 33: hard bounds on drag-computed move/resize values. Neither `onTimeChange` nor
// `onDurationChange` touches the task's date — only its time-of-day/duration — so a vertical
// drag was previously left completely unclamped on the upper end (only `Math.max(0, ...)` /
// `Math.max(SNAP_MINUTES, ...)` guarded the lower end). Root cause of the disappearing-task bug:
// an extreme drag (e.g. the pointer released far outside the visible grid) could compute a start
// time whose hour needs 3+ digits (e.g. "2093:15") — `⏰`'s own `\d{1,2}` grammar can't match
// that, so the token silently fails to round-trip through the parser on the next read, `time`
// comes back `undefined`, and the task drops out of every time-based view while the garbage text
// leaks into the visible title. Clamping here keeps every value this module ever *computes*
// inside a single real calendar day, so it can never produce that class of value in the first
// place — the validated TaskApplicationApi command is the last line of defense for anything that
// still slips through, not the first one.
const MAX_START_MINUTES = 24 * 60 - SNAP_MINUTES; // 23:45 — the last valid quarter-hour slot.
const MAX_DURATION_MINUTES = 24 * 60; // A full day is already a generous, unambiguous cap.

// Code review gap (fix): every pointer-drag gesture below (`attachDrag`'s move/resize, and
// `attachHorizontalResize`'s left/right edges) tears down its state — including, for resize,
// restoring `block`'s `draggable="true"` — from a `cleanup()` reachable only via `pointerup`/
// `pointercancel`. If NEITHER is ever delivered for a given gesture (e.g. the pointer is
// released while positioned outside the browser window entirely, or some other browser/OS quirk
// swallows the up-event), cleanup never runs and, for a resize gesture, `draggable` stays
// "false" forever — silently disabling the legitimate whole-block native-drag-to-all-day feature
// until the block's next from-scratch re-render.
//
// Pointer Capture (`setPointerCapture`/`releasePointerCapture`) is the standard, spec-correct fix
// for exactly this class of problem: per the Pointer Events spec, once an element captures a
// pointerId, that element keeps receiving `pointermove`/`pointerup` for that pointer even if it
// moves outside the element — or outside the browser window/document — for the remainder of the
// gesture. That is a guarantee from the browser itself, not something this codebase's own logic
// can fail to uphold, so it closes the gap for real rather than adding another window/document
// listener that could itself be skipped by the same class of quirk.
//
// Verified this does NOT fight the existing native-HTML5-DnD-hijack-produces-pointercancel
// behavior these same handlers already rely on (see attachDrag's onPointerCancel/cleanup and
// attachHorizontalResize's mirror of it): Pointer Capture and HTML5 Drag-and-Drop are two
// independent browser subsystems, but the spec is explicit that starting a native drag operation
// implicitly releases any active pointer capture and then fires `pointercancel` at the (now
// former) capturing element — i.e. capture does not suppress or delay the hijack's pointercancel,
// it just additionally guarantees delivery for the ordinary (non-hijacked) release path this
// gap is about. `releasePointerCapture` in `cleanup()` below is therefore redundant-but-cheap
// hygiene for the two paths that already end in a real pointerup/pointercancel; the guarantee
// that actually closes the gap is the implicit one the browser provides for a captured pointer
// that never gets hijacked into DnD.
//
// jsdom implements neither method at all (confirmed: `typeof el.setPointerCapture === 'undefined'`
// — calling it throws, it does not silently no-op), so both helpers below feature-detect before
// calling, keeping every existing pointerdown-driven test in this file (most of which stub these
// two methods onto the element under test) working unchanged, and tolerating any other host that
// similarly lacks Pointer Events capture support.
function tryCapturePointer(el: HTMLElement, pointerId: number): void {
  if (typeof el.setPointerCapture !== 'function') return;
  try {
    el.setPointerCapture(pointerId);
  } catch {
    // A real browser can still reject capture (e.g. the pointer is no longer active) — never
    // let that abort the gesture; the existing window-level listeners remain the fallback path.
  }
}

function tryReleasePointer(el: HTMLElement, pointerId: number): void {
  if (typeof el.releasePointerCapture !== 'function') return;
  try {
    el.releasePointerCapture(pointerId);
  } catch {
    // Harmless if capture was already released (e.g. implicitly, by a native-drag hijack — see
    // this constant block's own comment above) or never actually granted.
  }
}

/**
 * Task 37: shared `TaskSnapshot[]` -> `TimedBlockInput[]` conversion, factored out of
 * `renderTimedBlocksForDay` so callers (WeekTimeGridView.ts/TodayView.ts) can build the same
 * `startMinutes`/`durationMinutes` shape for a day's anchor blocks and hand it to
 * `renderTimedSpanContinuation`'s `otherBlocks` parameter — letting a continuation segment's
 * min-height clamp see the anchor block(s) sharing its day column, not just other continuations.
 */
export function toTimedBlockInputs(tasks: TaskSnapshot[]): TimedBlockInput[] {
  return tasks.map((t) => ({
    task: t,
    startMinutes: timeStringToMinutes(t.planning.time ?? '00:00'),
    durationMinutes: t.planning.duration ?? DEFAULT_DURATION_MINUTES,
  }));
}

export function renderTimedBlocksForDay(
  hourColumnEl: HTMLElement,
  tasksWithTime: TaskSnapshot[],
  callbacks: TimedBlockCallbacks,
  tagGroups: TagGroup[] = [],
): void {
  const inputs: TimedBlockInput[] = toTimedBlockInputs(tasksWithTime);
  const positioned = packOverlaps(inputs);
  // Task 36: `.tc-tg-block`'s CSS min-height keeps a short block's checkbox+title row legible,
  // but only ever grows a block past its duration-derived height — see capMinHeightsPx's own
  // doc comment for why a same-column neighbor can still need that growth clamped back down so
  // the two blocks never visually cross.
  const minHeightCaps = capMinHeightsPx(positioned);

  for (const p of positioned) {
    const widthPct = 100 / p.columns;
    const block = hourColumnEl.createDiv({ cls: 'tc-tg-block' });
    block.setAttribute('data-tc-task-file', p.task.source.filePath);
    block.setAttribute('data-tc-task-line', String(p.task.source.line));
    block.setAttribute('data-tc-start-minutes', String(p.startMinutes));
    // Keep each block as the stable focus root used by relative arrow intents and same-day
    // Tab/Shift+Tab navigation, including when a key event starts from a nested link.
    block.setAttribute('tabindex', '0');
    block.style.top = `${minutesToPixels(p.startMinutes)}px`;
    const heightPx = minutesToPixels(p.durationMinutes);
    block.style.height = `${heightPx}px`;
    // Only intervene when the CSS min-height would otherwise cross into the next same-column
    // block — leave the CSS rule (which uses real `em`s, more accurate than this JS-side
    // approximation) in full effect everywhere else.
    const cap = minHeightCaps.get(p) ?? Infinity;
    if (cap < MIN_BLOCK_HEIGHT_PX) {
      block.style.minHeight = `${Math.max(heightPx, cap)}px`;
    }
    block.style.width = `${widthPct}%`;
    block.style.left = `${p.column * widthPct}%`;
    // Tag-colored fill only — the priority-colored border was removed (Task 12): the
    // status marker below already conveys priority via its own border, so a second
    // priority border on the block itself was redundant visual noise.
    const tagColor = tagColorFor(p.task.tags, tagGroups);
    if (tagColor) {
      block.setCssProps({ '--tc-tag-color': tagColor });
      // Task 40 (Round 4): a single fixed var(--text-normal) title/subtitle color (the
      // pre-existing behavior) loses contrast against a bright/pale tag color's fill in light
      // mode, or a very dark/desaturated one in dark mode — see tagFillContrast.ts's own doc
      // comment for the full reasoning. Only set when a variant was actually computed (falls
      // through to the CSS rule's own var(--text-normal) fallback otherwise).
      const textColorVar = tagFillTextColorVar(block, tagColor);
      if (textColorVar) block.setCssProps({ '--tc-tag-text-color': textColorVar });
    }
    // Time-range+duration subtitle renders first (top of the block), e.g. "09:00–11:00 (2h)".
    // Task 35: shares its row with the count-badges container (see below) via `.tc-tg-block-
    // toprow`'s `justify-content: space-between` — real flex layout, not an absolutely
    // positioned overlay, so the badges land in the block's visual top-right corner without
    // ever covering the subtitle text (an earlier absolute-position attempt did overlap it on
    // narrower blocks).
    const topRow = block.createDiv({ cls: 'tc-tg-block-toprow' });
    topRow.createDiv({
      cls: 'tc-tg-block-subtitle',
      text: `${minutesToTimeString(p.startMinutes)}–${minutesToTimeString(p.startMinutes + p.durationMinutes)} (${formatDurationFromMinutes(p.durationMinutes)})`,
    });
    // Task 35: count badges (subtasks/comments/links) only — tag chips were removed entirely
    // for timed blocks (the block's own tag-colored fill, set above, already conveys the tag;
    // a chip repeating it was redundant). Skipped entirely when the task has no counts, so a
    // plain/tag-only task doesn't gain an empty container. Non-interactive (see
    // renderTaskMeta.ts) — safe to sit inside the block without needing the pointerdown
    // exclusion-guard below.
    if (hasCountBadges(p.task)) {
      const badges = topRow.createDiv({ cls: 'tc-tg-block-badges' });
      renderCountBadges(badges, p.task);
    }
    // Status marker + title share one flex row so the checkbox and title render on the
    // same line instead of stacking (the title div is block-level, which previously
    // forced a line break after the inline marker span).
    const head = block.createDiv({ cls: 'tc-tg-block-head' });
    // Status marker first: lets a user mark the block done without opening the modal.
    // Its own contextmenu handler stops propagation and opens the status/priority popover
    // instead — distinct from right-clicking the block body below (opens the task modal).
    renderStatusMarker(head, {
      task: p.task,
      registry: callbacks.statusRegistry,
      onLeftClick: () => callbacks.onToggle(p.task),
      onContextMenu: (ev) => {
        ev.stopPropagation();
        showStatusMenuAt(ev, {
          task: p.task,
          registry: callbacks.statusRegistry,
          onPickStatus: (c) => callbacks.onSetStatus(p.task, c),
          onPickPriority: (pr) => callbacks.onSetPriority(p.task, pr),
        });
      },
    });
    // Task 38: a completed/cancelled task stays a full, visible block (checkbox showing its
    // checked state via the marker above), communicating completion purely through this
    // strikethrough title instead of disappearing.
    const titleEl = head.createDiv({
      cls: `tc-tg-block-title${statusTitleClass(p.task.status)}`,
    });
    renderTaskText(titleEl, p.task.markdownTitle, {
      app: callbacks.app,
      sourcePath: p.task.source.filePath,
      component: callbacks.component,
    });
    // Task 34: left-edge horizontal resize, moving/adding `start` while `due`/`⏰`/`⏱️` stay
    // untouched (see TimedBlockCallbacks.onStartChange's own comment). Rendered on the same
    // anchor-day block as the right edge below — unlike renderAllDay.ts's all-day spans, where
    // start and due each get their own handle on their own (usually different) day cell, a
    // timed span's only ever-interactive block is its `due`-anchored one (see this function's
    // own doc comment on the due-centric anchor rule), so both edges of a timed span necessarily
    // coexist on the same element here.
    const hEdgeLeft = block.createDiv({ cls: 'tc-tg-span-edge tc-tg-span-edge--left' });
    // Task 51: clamp the left edge so it can never be dragged past the block's own `due` day —
    // `due` is always set here (this block is always the `due`-anchored one, per the
    // due-centric anchor rule above), and `updateTaskStart`'s mutation never touches `due`
    // itself, so `due` is a stable bound for the whole gesture.
    attachHorizontalResize(
      hEdgeLeft,
      hourColumnEl,
      p.task,
      callbacks.onStartChange,
      p.task.planning.due ? { date: p.task.planning.due, kind: 'max' } : undefined,
    );
    // Task 29: right-edge horizontal resize, extending the block into a multi-day timed span.
    // Reuses `.tc-tg-span-edge`/`.tc-tg-span-edge--right` — the same classes/CSS renderAllDay.ts's
    // span/plain right-edge handles already use — so it looks and behaves consistently with the
    // existing all-day span-extension affordance (Round 2 Task 9) instead of inventing new visual
    // language for the same gesture.
    const hEdge = block.createDiv({ cls: 'tc-tg-span-edge tc-tg-span-edge--right' });
    // Task 51 (mirror of the left edge's clamp above): the right edge can never be dragged
    // before whichever anchor `extendTaskToSpan` would freeze as the new `start` — the task's
    // own `start` if it's already a span, else the `scheduled ?? due` anchor `extendTaskToSpan`
    // itself uses (see that method's own doc comment for why `scheduled` must win over `due`
    // there). Matching that exact priority here keeps the clamp bound consistent with what the
    // commit would actually freeze.
    const rightEdgeAnchor =
      p.task.planning.start ?? p.task.planning.scheduled ?? p.task.planning.due;
    attachHorizontalResize(
      hEdge,
      hourColumnEl,
      p.task,
      callbacks.onExtendToSpan,
      rightEdgeAnchor ? { date: rightEdgeAnchor, kind: 'min' } : undefined,
    );

    const handle = block.createDiv({ cls: 'tc-tg-resize-handle' });
    // Task 26: native HTML5 DnD so a timed block can be dragged out of the hour-grid onto the
    // all-day/"No-time" row (renderAllDay.ts's existing drop target), using the SAME
    // filePath:::line payload convention as renderAllDay.ts's renderDraggableBody. The resize
    // handle itself stays draggable="false" too, but per the HTML Drag and Drop spec that alone
    // does NOT stop a gesture starting on it from arming the ancestor's native dragstart — the
    // browser walks up to the nearest draggable="true" element regardless of the child's own
    // draggable value (confirmed live and fixed the same way in renderAllDay.ts's
    // attachEdgeResize). attachDrag below closes that gap for real by flipping `block`'s own
    // draggable off for the duration of a resize gesture (armed on the handle's pointerdown,
    // restored on pointerup/pointercancel) — see attachDrag's own comment for why this is scoped
    // to resize mode only, not move mode.
    block.setAttribute('draggable', 'true');
    handle.setAttribute('draggable', 'false');
    block.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('text/plain', `${p.task.source.filePath}:::${p.task.source.line}`);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      block.addClass('is-dragging');
    });
    block.addEventListener('dragend', () => block.removeClass('is-dragging'));

    block.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if ((e.target as HTMLElement).closest('.tc-tg-resize-handle, .tc-tg-span-edge')) return;
      callbacks.onTaskClick(p.task);
    });

    attachDrag(block, handle, p.startMinutes, p.durationMinutes, callbacks, p.task);
    attachKeyboardHandling(block, callbacks, p.task);
    attachSelectedState(block);
  }
}

/**
 * Task 29: renders the lighter, non-interactive "continuation" segment for a non-anchor day of
 * a multi-day timed span (`start` < `due`, `time` set) — the anchor day (matching `due`, per
 * this project's due-centric anchor-priority rule) gets the full interactive block via
 * `renderTimedBlocksForDay` instead; every OTHER day the span covers gets this instead, so the
 * same task never renders two full interactive blocks across a Week view.
 *
 * Deliberately minimal — no checkbox, no drag, no resize handles, no markdown-link-aware title
 * rendering (a plain textContent title, unlike the anchor block's renderTaskText) — visually
 * similar in spirit to MonthGridView's existing `.tc-mg-span-segment` continuation bars for
 * untimed spans: clearly linked to the task (same title, tag color, time-of-day position) but
 * unmistakably not a second interactive copy of it. A contextmenu still opens the task modal
 * (`onTaskClick`), same as a full block, since that's a read-only action.
 *
 * Task 35 (expanded scope): also shows the same time-range+duration subtitle and count badges
 * (subtasks/comments/links) the anchor block shows, so a continuation segment reads as more than
 * just a title bar — but stays purely presentational: no checkbox, and neither the subtitle nor
 * the badges container gets a click/drag handler, so this remains as non-interactive as before.
 *
 * Task 37: like `.tc-tg-block`, `.tc-tg-block-continuation` has a CSS min-height that keeps a
 * short segment's title legible — but, unlike anchor blocks, continuation segments never go
 * through `packOverlaps`'s column-collision avoidance (they're always rendered full-width, one
 * per task). `capContinuationMinHeightsPx` closes that gap: `otherBlocks` lets a caller pass the
 * SAME day's already-positioned anchor blocks (see `toTimedBlockInputs`) so a continuation's
 * min-height growth is clamped against those too, not just other continuations.
 */
export function renderTimedSpanContinuation(
  hourColumnEl: HTMLElement,
  tasks: TaskSnapshot[],
  onTaskClick?: (task: TaskSnapshot) => void,
  tagGroups: TagGroup[] = [],
  otherBlocks: TimedBlockInput[] = [],
): void {
  const continuationInputs = toTimedBlockInputs(tasks);
  const minHeightCaps = capContinuationMinHeightsPx(continuationInputs, otherBlocks);
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i]!;
    const continuationInput = continuationInputs[i]!;
    const { startMinutes, durationMinutes } = continuationInput;
    const seg = hourColumnEl.createDiv({ cls: 'tc-tg-block-continuation' });
    seg.style.top = `${minutesToPixels(startMinutes)}px`;
    const heightPx = minutesToPixels(durationMinutes);
    seg.style.height = `${heightPx}px`;
    // Mirrors renderTimedBlocksForDay's own use of capMinHeightsPx exactly: only intervene when
    // the CSS min-height would otherwise cross into whatever's next in this day column.
    const cap = minHeightCaps.get(continuationInput) ?? Infinity;
    if (cap < MIN_BLOCK_HEIGHT_PX) {
      seg.style.minHeight = `${Math.max(heightPx, cap)}px`;
    }
    const tagColor = tagColorFor(t.tags, tagGroups);
    if (tagColor) {
      seg.setCssProps({ '--tc-tag-color': tagColor });
      // Task 40 (Round 4): same contrast-driven text-color fix as the anchor block above,
      // applied to the continuation segment's own (lighter, 22%-mix) fill — the 22% here
      // matches .tc-tg-block-continuation's own color-mix percentage in styles.css.
      const textColorVar = tagFillTextColorVar(seg, tagColor, 22);
      if (textColorVar) seg.setCssProps({ '--tc-tag-text-color': textColorVar });
    }
    const topRow = seg.createDiv({ cls: 'tc-tg-block-toprow' });
    topRow.createDiv({
      cls: 'tc-tg-block-subtitle',
      text: `${minutesToTimeString(startMinutes)}–${minutesToTimeString(startMinutes + durationMinutes)} (${formatDurationFromMinutes(durationMinutes)})`,
    });
    if (hasCountBadges(t)) {
      const badges = topRow.createDiv({ cls: 'tc-tg-block-badges' });
      renderCountBadges(badges, t);
    }
    // Task 38: mirrors the anchor block's is-done/is-cancelled title convention above — a
    // continuation segment renders the same underlying task, so it must reflect completion the
    // same way rather than looking untouched while its anchor block elsewhere shows struck-through.
    seg.createSpan({
      cls: `tc-tg-block-continuation-title${statusTitleClass(t.status)}`,
      text: t.markdownTitle,
    });
    if (onTaskClick) {
      seg.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onTaskClick(t);
      });
    }
  }
}

/**
 * Arrow keys emit relative domain intents. Tab and Shift+Tab cycle through the visual ordering
 * of timed blocks in the current day, keeping focus on block roots even when the key originated
 * from an embedded link. Ctrl/Meta/Alt combinations are left to the host/browser.
 */
function attachKeyboardHandling(
  block: HTMLElement,
  callbacks: TimedBlockCallbacks,
  task: TaskSnapshot,
): void {
  block.addEventListener('keydown', (event: KeyboardEvent) => {
    if (!block.contains(event.target as Node)) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    if (event.key === 'Tab') {
      event.preventDefault();
      focusAdjacentTimedBlock(block, event.shiftKey ? -1 : 1);
      return;
    }

    let intent: TimedBlockKeyboardIntent | undefined;
    if (event.key === 'ArrowUp') {
      intent = event.shiftKey
        ? { type: 'resize-duration', deltaMinutes: -5 }
        : { type: 'move-time', deltaMinutes: -15 };
    } else if (event.key === 'ArrowDown') {
      intent = event.shiftKey
        ? { type: 'resize-duration', deltaMinutes: 5 }
        : { type: 'move-time', deltaMinutes: 15 };
    } else if (event.key === 'ArrowLeft') {
      intent = event.shiftKey
        ? { type: 'extend-start', days: -1 }
        : { type: 'shift-schedule', days: -1 };
    } else if (event.key === 'ArrowRight') {
      intent = event.shiftKey
        ? { type: 'extend-due', days: 1 }
        : { type: 'shift-schedule', days: 1 };
    }

    if (!intent) return;
    event.preventDefault();
    callbacks.onKeyboardIntent(task, intent);
  });
}

function focusAdjacentTimedBlock(block: HTMLElement, direction: -1 | 1): void {
  const scope =
    block.closest<HTMLElement>('.tc-tg-day-column') ??
    block.closest<HTMLElement>('.tc-tg-hour-column');
  if (!scope) return;

  const domBlocks = Array.from(scope.querySelectorAll<HTMLElement>('.tc-tg-block'));
  const domIndex = new Map(domBlocks.map((candidate, index) => [candidate, index]));
  const visualBlocks = [...domBlocks].sort((a, b) => {
    const startDifference =
      Number(a.dataset['tcStartMinutes']) - Number(b.dataset['tcStartMinutes']);
    return startDifference || domIndex.get(a)! - domIndex.get(b)!;
  });
  const currentIndex = visualBlocks.indexOf(block);
  if (currentIndex < 0 || visualBlocks.length === 0) return;

  const targetIndex = (currentIndex + direction + visualBlocks.length) % visualBlocks.length;
  visualBlocks[targetIndex]!.focus();
}

function attachSelectedState(block: HTMLElement): void {
  block.addEventListener('focusin', () => block.addClass('is-selected'));
  block.addEventListener('focusout', (e: FocusEvent) => {
    // A focusout where focus is moving to another element still inside `block` (e.g. from the
    // block itself onto its own embedded link, or back) must not drop `.is-selected` — only a
    // focusout whose new focus target (`relatedTarget`) is outside `block` entirely (or focus is
    // leaving the document altogether, `relatedTarget === null`) is a real "deselect".
    const next = e.relatedTarget as Node | null;
    if (next && block.contains(next)) return;
    block.removeClass('is-selected');
  });
}

function attachDrag(
  block: HTMLElement,
  handle: HTMLElement,
  initialStart: number,
  initialDuration: number,
  callbacks: TimedBlockCallbacks,
  task: TaskSnapshot,
): void {
  let mode: 'move' | 'resize' | null = null;
  let startY = 0;
  let startMinutes = initialStart;
  let startDuration = initialDuration;
  // The element that actually received this gesture's pointerdown (`block` for move, `handle`
  // for resize — see onPointerDown's `e.currentTarget` below) and the pointerId captured on it,
  // so `cleanup()` can release the exact same (element, pointerId) pair it captured. See this
  // file's pointer-capture comment (above MAX_DURATION_MINUTES) for why this exists at all.
  let capturedEl: HTMLElement | null = null;
  let capturedPointerId: number | null = null;

  const onPointerMove = (e: PointerEvent): void => {
    if (!mode) return;
    const rawDelta = ((e.clientY - startY) / minutesToPixels(60)) * 60;
    const deltaMinutes = snapMinutes(rawDelta, SNAP_MINUTES);
    if (mode === 'move') {
      const next = Math.min(MAX_START_MINUTES, Math.max(0, startMinutes + deltaMinutes));
      block.style.top = `${minutesToPixels(next)}px`;
    } else {
      const next = Math.min(
        MAX_DURATION_MINUTES,
        Math.max(SNAP_MINUTES, startDuration + deltaMinutes),
      );
      block.style.height = `${minutesToPixels(next)}px`;
    }
  };

  const cleanup = (): void => {
    // Restore the block's own native-drag eligibility (Task 26: dragging the BODY out to the
    // all-day row) unconditionally — harmless no-op if this gesture was 'move' (where it was
    // never toggled off, see onPointerDown below), and the fix for 'resize' (see that same
    // comment for why resize needs this at all).
    block.setAttribute('draggable', 'true');
    mode = null;
    // Task 39: mirrors is-dragging/is-edge-resizing's own cleanup-in-every-exit-path
    // discipline — removed here (the one place every exit path funnels through) rather than
    // only in onPointerUp, so a pointercancel mid-gesture (native drag hijacking the pointer
    // session, see onPointerCancel below) can never leave the "picked up" affordance stuck on.
    block.removeClass('is-picked-up');
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    if (capturedEl && capturedPointerId !== null) tryReleasePointer(capturedEl, capturedPointerId);
    capturedEl = null;
    capturedPointerId = null;
  };

  const onPointerUp = (e: PointerEvent): void => {
    if (!mode) return;
    const rawDelta = ((e.clientY - startY) / minutesToPixels(60)) * 60;
    const deltaMinutes = snapMinutes(rawDelta, SNAP_MINUTES);
    if (mode === 'move') {
      callbacks.onTimeChange(
        task,
        Math.min(MAX_START_MINUTES, Math.max(0, startMinutes + deltaMinutes)),
      );
    } else {
      callbacks.onDurationChange(
        task,
        Math.min(MAX_DURATION_MINUTES, Math.max(SNAP_MINUTES, startDuration + deltaMinutes)),
      );
    }
    cleanup();
  };

  // Now that the block is also draggable="true" (native HTML5 DnD, for dragging out to the
  // all-day row), a pointerdown that arms move/resize can be hijacked mid-gesture by the
  // browser starting a native drag: per the Pointer Events spec, once native DnD takes over the
  // pointer session it fires `pointercancel` instead of `pointerup` for that pointer. Without
  // this handler, `mode` and the window pointermove/pointerup listeners from the aborted
  // gesture would never be torn down — leaking listeners that would double-fire on the next
  // real gesture — and no mutation must fire here (the drop is handled by the native DnD
  // dragend/drop path instead, not this pointer session).
  //
  // Investigated as a possible root cause of "drag-to-reschedule lands at the wrong time":
  // `onPointerMove` above already repositions `block.style.top`/`height` live, on every
  // pointermove, as a preview of the not-yet-committed move/resize. A native-drag hijack can
  // fire at any point during an ordinary vertical move gesture too — per the HTML Drag and Drop
  // spec, arming only needs the pointer to move past a small threshold while the button is held
  // on a draggable="true" element, in ANY direction, not specifically toward the all-day row.
  // Without the reset below, a hijacked gesture left the block's DOM position/size sitting at
  // whatever the last live-preview pointermove had set it to, even though NO mutation had
  // committed (onTimeChange/onDurationChange only fire from onPointerUp, never from here) — a
  // real, visible divergence between what the block showed and the task's actual, unchanged
  // data, persisting until some unrelated re-render happened to overwrite it. Reverting to the
  // pre-gesture position/size here, unconditionally, keeps the DOM never ahead of committed data
  // regardless of what (if anything) the hijacked native drag itself goes on to do — including
  // the legitimate case where it lands on the all-day row and converts the task via a completely
  // separate mutation path (renderAllDay.ts's onDrop/rescheduleTask), which is free to run
  // without this preview's stale position fighting it.
  const onPointerCancel = (): void => {
    if (!mode) return;
    if (mode === 'move') {
      block.style.top = `${minutesToPixels(startMinutes)}px`;
    } else {
      block.style.height = `${minutesToPixels(startDuration)}px`;
    }
    cleanup();
  };

  const onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    // A pointerdown that starts on the status marker or a rendered markdown link must never
    // arm move/resize — otherwise a plain checkbox click, or a click that navigates a
    // [[wikilink]]/markdown link in the title, also fires onTimeChange/onDurationChange as an
    // unwanted side effect (pointerdown→pointerup fires and completes before the marker's own
    // click handler runs onToggle, or before the link's own click handler navigates). Mirrors
    // the existing resize-handle exclusion below. `a` covers renderTaskText's rendered links —
    // matched by tag, not a task-calendar-specific class, since MarkdownRenderer owns that markup.
    // `.tc-tg-span-edge` (Task 29's horizontal resize handle) is excluded too: it has its own
    // dedicated pointerdown listener (attachHorizontalResize) that stops propagation before this
    // block-level listener would ever see it, so this closest() never actually matches in
    // practice — kept as a defensive, explicit belt-and-suspenders guard rather than relying
    // solely on stopPropagation ordering.
    if ((e.target as HTMLElement).closest('.tc-status-marker, a, .tc-tg-span-edge')) return;
    mode = (e.target as HTMLElement).closest('.tc-tg-resize-handle') ? 'resize' : 'move';
    startY = e.clientY;
    startMinutes = initialStart;
    startDuration = initialDuration;
    // The vertical resize handle is a non-draggable (draggable="false") island inside `block`,
    // which is itself draggable="true" (Task 26, for dragging the BODY out to the all-day row).
    // Per the HTML Drag and Drop spec, a gesture starting on a non-draggable child does NOT stop
    // the browser from walking up to the nearest draggable="true" ancestor and arming a native
    // drag from THERE instead — draggable="false" on the handle alone is not enough (this is the
    // exact mechanism renderAllDay.ts's attachEdgeResize found and fixed the same way). Flipping
    // `block`'s own draggable off for the duration of a resize gesture actually blocks the
    // fallback, restored in `cleanup()` on pointerup/pointercancel. Scoped to 'resize' only:
    // 'move' (grabbing the block body itself) is the deliberate drag-out-to-all-day gesture, so
    // `block` must stay draggable="true" for that case.
    if (mode === 'resize') block.setAttribute('draggable', 'false');
    // Task 39: immediate "picked up" affordance for a move-mode drag specifically (not
    // resize) — the user's most common gesture is grabbing the block body to reschedule it,
    // and it previously gave zero feedback that anything had been armed until the block
    // visibly moved on the next pointermove. `.is-dragging` (Task 26) is deliberately NOT
    // reused here: that class fires from `dragstart`/`dragend`, native HTML5 DnD events that
    // only occur once the browser has taken over the pointer session for the drag-to-all-day
    // gesture (dozens of ms after this pointerdown, and never at all for an ordinary
    // vertical move that stays inside the hour grid) — reusing it here would either double
    // up if a native drag DID start, or never fire for the common in-grid case it's meant to
    // cover. A distinct class keeps the two mechanisms' visual language independently
    // tunable, same reasoning Task 37 used to give edge-resize its own `.is-edge-resizing`
    // instead of overloading `.is-dragging`.
    if (mode === 'move') block.addClass('is-picked-up');
    // Pointer capture on whichever element actually received this pointerdown (`e.currentTarget`
    // — `handle` if this fired from the handle's own listener, `block` if from the block's own
    // listener; see the two `addEventListener` calls below). See this file's pointer-capture
    // comment (above MAX_DURATION_MINUTES) for what this closes.
    capturedEl = e.currentTarget as HTMLElement;
    capturedPointerId = e.pointerId;
    tryCapturePointer(capturedEl, capturedPointerId);
    e.stopPropagation();
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
  };

  block.addEventListener('pointerdown', onPointerDown);
  handle.addEventListener('pointerdown', onPointerDown);
}

/**
 * Task 29: right-edge horizontal drag-resize, extending a timed block into a multi-day timed
 * span. Mirrors renderAllDay.ts's `attachEdgeResize` exactly (same Pointer-Events pattern: no
 * live visual feedback while dragging, just a commit-on-release that resolves the day under the
 * pointer) rather than inventing a new interaction style — the day boundary crossing is resolved
 * from the pointer's final (clientX, clientY) via `activeDocument.elementFromPoint`, walking up
 * to the nearest `[data-tg-date]` ancestor (HourGrid.ts's `.tc-tg-day-column`, one per rendered
 * date), NOT by accumulating a per-pixel delta within a single column — so dragging across 2-3
 * day columns resolves to whichever column the pointer is over at release, however far that is.
 *
 * `hourColumnEl` (the per-day column this block was rendered into) doubles as the test seam
 * anchor: real usage never reads from it directly, but jsdom's `elementFromPoint` always returns
 * null, so tests drive the same deterministic `__tgPendingEdgeResizes`/`__tgTestEndDrag` seam
 * renderAllDay.ts established (Round 2 Task 9), registered here per-day-column instead of
 * per-all-day-cell.
 *
 * Task 34: also used for the left edge (moves/adds `start`) — both edges share this same
 * mechanics function, differing only in which mutation callback `onResolve` invokes on
 * resolution, mirroring how renderAllDay.ts's single `attachEdgeResize` already serves its
 * left/right/plain-right handles alike.
 */
function attachHorizontalResize(
  handle: HTMLElement,
  hourColumnEl: HTMLElement,
  task: TaskSnapshot,
  onResolve: (task: TaskSnapshot, newDate: string) => void,
  // Task 51: live-clamp bound (UX nice-to-have layered on top of the application command
  // validation safety net). Without this, `elementFromPoint`'s absolute "day under the cursor"
  // resolution let the left edge get dragged arbitrarily far past the block's own `due` day (or
  // the right edge past the anchor that would freeze as `start`), producing an inverted span
  // that the validator now rejects wholesale — correct, but the user only discovers the failed
  // drag AFTER release, with no live feedback that they'd crossed a limit. Clamping the resolved
  // date here, on every pointermove AND at commit, means the drag visually stops at the boundary
  // day column instead of continuing to track the cursor past it, and the committed value is
  // never invalid in the first place (command validation remains the safety net for every other path
  // that can touch these fields, this is purely presentational/UX for this one gesture).
  bound?: { date: string; kind: 'max' | 'min' },
): void {
  // This handle is a non-draggable (draggable="false") island inside the block's draggable="true"
  // ancestor (Task 26). draggable="false" here is NOT enough on its own to stop a gesture
  // starting on the handle from arming the ancestor's native dragstart: per the HTML Drag and
  // Drop spec, a mousedown on a non-draggable descendant of a draggable element still starts a
  // drag FROM THE ANCESTOR (the browser walks up to the nearest draggable="true" element and uses
  // that as the drag source) — draggable="false" only stops the handle itself from being
  // independently draggable, it does not block the ancestor fallback. Same mechanism renderAllDay
  // .ts's attachEdgeResize found and fixed (see its own comment); fixed here the same way, by
  // flipping the ancestor `.tc-tg-block`'s own draggable off for the duration of the gesture
  // (armed on this handle's pointerdown, restored on pointerup/pointercancel below).
  handle.setAttribute('draggable', 'false');
  const block = handle.closest<HTMLElement>('.tc-tg-block');

  // Dates are always well-formed, zero-padded `YYYY-MM-DD` strings by the time they reach here
  // (either `task.planning.due`/`task.planning.start`/`task.planning.scheduled`, already-parsed fields, or a `data-tg-date`
  // attribute HourGrid.ts stamps from the same shape) — plain string comparison agrees with
  // chronological order exactly for that shape, no `Date` parsing needed.
  const clampDate = (date: string): string => {
    if (!bound) return date;
    if (bound.kind === 'max' && date > bound.date) return bound.date;
    if (bound.kind === 'min' && date < bound.date) return bound.date;
    return date;
  };

  const resolve = (date: string): void => {
    onResolve(task, clampDate(date));
  };

  const withHook = hourColumnEl as HTMLElement & {
    __tgPendingEdgeResizes?: Array<(d: string) => void>;
  };

  // Task 39: live feedback for horizontal (day-crossing) edge-resize, which — unlike the
  // vertical move/resize drag above — had NO visual feedback at all while dragging, only a
  // commit-on-release (see this function's own doc comment). The commit itself already
  // resolves which day the pointer is over via `elementFromPoint` on release; this surfaces
  // that same resolution live, on every pointermove, by toggling `.is-drag-over` on whichever
  // `[data-tg-date]` day column is currently under the pointer — reusing the day cell's
  // existing native-DnD dragover highlight (renderAllDay.ts) rather than inventing a new
  // convention, since both signal the same thing: "this is the day you'd land on if you let
  // go now." `hoveredDayEl` tracks the currently-highlighted column so a fast drag across
  // several columns only ever has one column highlighted at a time.
  let hoveredDayEl: Element | null = null;

  const clearHoveredDay = (): void => {
    hoveredDayEl?.classList.remove('is-drag-over');
    hoveredDayEl = null;
  };

  const onPointerMove = (e: PointerEvent): void => {
    e.preventDefault();
    const target = activeDocument.elementFromPoint(e.clientX, e.clientY);
    const rawDayEl = target?.closest('[data-tg-date]') ?? null;
    const rawDate = rawDayEl?.getAttribute('data-tg-date');
    // Task 51: once the cursor has crossed the clamp bound, keep highlighting the BOUND day
    // column (not whichever real column is under the cursor) so the live preview visibly stops
    // at the limit rather than continuing to follow the pointer past it.
    let dayEl = rawDayEl;
    if (bound && rawDate) {
      const clamped = clampDate(rawDate);
      if (clamped !== rawDate) {
        dayEl = activeDocument.querySelector(`[data-tg-date="${clamped}"]`);
      }
    }
    if (dayEl === hoveredDayEl) return;
    hoveredDayEl?.classList.remove('is-drag-over');
    dayEl?.classList.add('is-drag-over');
    hoveredDayEl = dayEl;
  };

  // Task 34: unlike Task 29 (where this was the ONLY horizontal handle sharing
  // `hourColumnEl`'s `__tgPendingEdgeResizes` array), a block now carries both a left and a
  // right edge handle registered against the SAME hourColumnEl — so `resolve` is pushed/removed
  // here around the armed window (pointerdown→pointerup/cancel) rather than unconditionally at
  // attach time. Otherwise `__tgTestEndDrag` (and, in principle, a stray real pointerup with no
  // matching pointerdown) would resolve BOTH edges' callbacks instead of only the one actually
  // being dragged.
  const unregisterPending = (): void => {
    const pending = withHook.__tgPendingEdgeResizes;
    if (!pending) return;
    const idx = pending.indexOf(resolve);
    if (idx !== -1) pending.splice(idx, 1);
  };

  // See attachDrag's mirror of this same (element, pointerId) pattern, and this file's
  // pointer-capture comment above MAX_DURATION_MINUTES for why it exists.
  let capturedPointerId: number | null = null;

  const cleanup = (): void => {
    block?.setAttribute('draggable', 'true');
    clearHoveredDay();
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    unregisterPending();
    if (capturedPointerId !== null) tryReleasePointer(handle, capturedPointerId);
    capturedPointerId = null;
  };

  const onPointerUp = (upEvent: PointerEvent): void => {
    const target = activeDocument.elementFromPoint(upEvent.clientX, upEvent.clientY);
    const dayEl = target?.closest('[data-tg-date]');
    const date = dayEl?.getAttribute('data-tg-date');
    if (date) resolve(date);
    cleanup();
  };

  // Defensive belt-and-suspenders (mirrors renderAllDay.ts's attachEdgeResize): if a native drag
  // were ever armed despite the draggable="false" flip below, the pointer session would end in
  // `pointercancel` rather than `pointerup`, and without this the window
  // pointermove/pointerup/pointercancel listeners would leak instead of being torn down.
  const onPointerCancel = (): void => {
    cleanup();
  };

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    block?.setAttribute('draggable', 'false');
    capturedPointerId = e.pointerId;
    tryCapturePointer(handle, capturedPointerId);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    withHook.__tgPendingEdgeResizes = withHook.__tgPendingEdgeResizes ?? [];
    withHook.__tgPendingEdgeResizes.push(resolve);
  });

  const withEndDrag = hourColumnEl as unknown as {
    __tgTestEndDrag?: (targetDate: string) => void;
  };
  if (!withEndDrag.__tgTestEndDrag) {
    withEndDrag.__tgTestEndDrag = (targetDate: string) => {
      const pending = (
        hourColumnEl as unknown as { __tgPendingEdgeResizes?: Array<(d: string) => void> }
      ).__tgPendingEdgeResizes;
      pending?.forEach((cb) => cb(targetDate));
    };
  }
}
