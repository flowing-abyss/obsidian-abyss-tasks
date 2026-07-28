import { Component, type App } from 'obsidian';
import { formatDurationFromMinutes } from '../../parser/TaskParser';
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
import type { TimedDragTarget, TimedDurationTarget } from './dragGeometry';
import {
  capContinuationMinHeightsPx,
  layoutTimedDay,
  MIN_BLOCK_HEIGHT_PX,
  minutesToPixels,
  minutesToTimeString,
  snapMinutes,
  timeStringToMinutes,
  type PositionedBlock,
  type TimedBlockInput,
} from './layout';
import { hasCountBadges, renderCountBadges } from './renderTaskMeta';
import {
  attachTimedInteractions,
  createTimedInteractionOwner,
  type TimedBoundaryTarget,
  type TimedInteractionOwner,
} from './timedInteractions';

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
  onDueChange?: (task: TaskSnapshot, newDue: string) => void;
  onTimedMove?: (task: TaskSnapshot, target: TimedDragTarget) => void;
  onTimedDuration?: (task: TaskSnapshot, target: TimedDurationTarget) => void;
  onTimedBoundary?: (task: TaskSnapshot, target: TimedBoundaryTarget) => void;
  interactionOwner?: TimedInteractionOwner;
  onToggle: (task: TaskSnapshot) => void;
  onSetStatus: (task: TaskSnapshot, status: string) => void;
  onSetPriority: (task: TaskSnapshot, priority: TaskPriority) => void;
  statusRegistry: StatusRegistry;
}

export interface TimedDayRenderOptions {
  readonly date: string;
  readonly terminal?: boolean;
  readonly previewPositionFor?: (
    task: TaskSnapshot,
    planning: TaskSnapshot['planning'],
    date: string,
  ) => PositionedBlock | undefined;
}

type BoundaryHandleBinding = {
  element: HTMLElement;
  boundary: 'start' | 'due' | 'create-span';
};

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

// The helpers below serve only the retained no-date compatibility handlers (`attachDrag` and
// `attachHorizontalResize`). Production Today/Week rendering passes a date and uses the
// view-owned engine in timedInteractions.ts instead. Pointer capture keeps a compatibility
// gesture receiving its terminal up/cancel event outside the source; cleanup returns the root to
// its attribute-free, non-native-draggable state. jsdom lacks these methods, so both helpers are
// feature-detected.
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
    // Harmless if the host already released capture or never granted it.
  }
}

/**
 * Shared `TaskSnapshot[]` -> `TimedBlockInput[]` conversion used by the production renderer and
 * retained legacy continuation tests/callers.
 */
export function toTimedBlockInputs(tasks: readonly TaskSnapshot[]): TimedBlockInput[] {
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
  options?: TimedDayRenderOptions,
): void {
  const inputs: TimedBlockInput[] = toTimedBlockInputs(tasksWithTime);
  const { positioned, minHeightCaps } = layoutTimedDay(inputs);
  // Task 36: `.tc-tg-block`'s CSS min-height keeps a short block's checkbox+title row legible,
  // but only ever grows a block past its duration-derived height — see capMinHeightsPx's own
  // doc comment for why a same-column neighbor can still need that growth clamped back down so
  // the two blocks never visually cross.
  for (const p of positioned) {
    const widthPct = 100 / p.columns;
    const terminal = options
      ? (options.terminal ?? (!p.task.planning.due || p.task.planning.due === options.date))
      : true;
    const block = hourColumnEl.createDiv({
      cls: `tc-tg-block${terminal ? '' : ' tc-tg-block-continuation'}`,
    });
    block.setAttribute('data-tc-task-file', p.task.source.filePath);
    block.setAttribute('data-tc-task-line', String(p.task.source.line));
    block.setAttribute('data-tc-start-minutes', String(p.startMinutes));
    if (options) block.setAttribute('data-tg-segment-date', options.date);
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
    if (terminal) {
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
    }
    // Task 38: a completed/cancelled task stays a full, visible block (checkbox showing its
    // checked state via the marker above), communicating completion purely through this
    // strikethrough title instead of disappearing.
    if (terminal) {
      const titleEl = head.createDiv({
        cls: `tc-tg-block-title${statusTitleClass(p.task.status)}`,
      });
      renderTaskText(titleEl, p.task.markdownTitle, {
        app: callbacks.app,
        sourcePath: p.task.source.filePath,
        component: callbacks.component,
      });
    } else {
      head.createDiv({
        cls: `tc-tg-block-continuation-title${statusTitleClass(p.task.status)}`,
        text: plainGhostTaskTitle(p.task),
      });
    }
    attachTimedBlockControls(
      block,
      hourColumnEl,
      p.task,
      p.startMinutes,
      p.durationMinutes,
      terminal,
      callbacks,
      options,
    );
  }
}

function attachTimedBlockControls(
  block: HTMLElement,
  hourColumnEl: HTMLElement,
  task: TaskSnapshot,
  startMinutes: number,
  durationMinutes: number,
  terminal: boolean,
  callbacks: TimedBlockCallbacks,
  options?: TimedDayRenderOptions,
): void {
  const handle = block.createDiv({ cls: 'tc-tg-resize-handle' });
  handle.setAttribute('draggable', 'false');
  const boundaryHandles: BoundaryHandleBinding[] = [];

  if (options) {
    const isSpan = Boolean(task.planning.start && task.planning.due);
    if (isSpan && String(task.planning.start) === options.date) {
      boundaryHandles.push({
        element: createBoundaryHandle(block, 'left', 'start'),
        boundary: 'start',
      });
    }
    if (isSpan && String(task.planning.due) === options.date) {
      boundaryHandles.push({
        element: createBoundaryHandle(block, 'right', 'due'),
        boundary: 'due',
      });
    } else if (!isSpan && terminal) {
      boundaryHandles.push({
        element: createBoundaryHandle(block, 'right', 'create-span'),
        boundary: 'create-span',
      });
    }
  } else {
    attachLegacyBoundaryHandles(block, hourColumnEl, task, callbacks);
  }

  block.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    if ((event.target as HTMLElement).closest('.tc-tg-resize-handle, .tc-tg-span-edge')) return;
    callbacks.onTaskClick(task);
  });

  if (options) {
    attachOwnedInteractions(
      block,
      handle,
      boundaryHandles,
      task,
      startMinutes,
      durationMinutes,
      callbacks,
      options,
    );
  } else {
    attachDrag(block, handle, startMinutes, durationMinutes, callbacks, task);
  }
  attachKeyboardHandling(block, callbacks, task);
  attachSelectedState(block);
}

function createBoundaryHandle(
  block: HTMLElement,
  side: 'left' | 'right',
  boundary: 'start' | 'due' | 'create-span',
): HTMLElement {
  const edge = block.createDiv({ cls: `tc-tg-span-edge tc-tg-span-edge--${side}` });
  edge.dataset['boundary'] = boundary;
  edge.setAttribute('draggable', 'false');
  return edge;
}

function attachLegacyBoundaryHandles(
  block: HTMLElement,
  hourColumnEl: HTMLElement,
  task: TaskSnapshot,
  callbacks: TimedBlockCallbacks,
): void {
  const left = block.createDiv({ cls: 'tc-tg-span-edge tc-tg-span-edge--left' });
  attachHorizontalResize(
    left,
    hourColumnEl,
    task,
    callbacks.onStartChange,
    task.planning.due ? { date: task.planning.due, kind: 'max' } : undefined,
  );
  const right = block.createDiv({ cls: 'tc-tg-span-edge tc-tg-span-edge--right' });
  const rightEdgeAnchor = task.planning.start ?? task.planning.scheduled ?? task.planning.due;
  attachHorizontalResize(
    right,
    hourColumnEl,
    task,
    callbacks.onExtendToSpan,
    rightEdgeAnchor ? { date: rightEdgeAnchor, kind: 'min' } : undefined,
  );
}

function attachOwnedInteractions(
  block: HTMLElement,
  handle: HTMLElement,
  boundaryHandles: BoundaryHandleBinding[],
  task: TaskSnapshot,
  startMinutes: number,
  durationMinutes: number,
  callbacks: TimedBlockCallbacks,
  options: TimedDayRenderOptions,
): void {
  const owner = callbacks.interactionOwner ?? createTimedInteractionOwner();
  attachTimedInteractions({
    source: block,
    durationHandle: handle,
    boundaryHandles,
    task,
    segmentDate: options.date,
    startMinutes,
    durationMinutes,
    owner,
    previewPositionFor: options.previewPositionFor,
    onMove: (movedTask, target) => {
      if (callbacks.onTimedMove) callbacks.onTimedMove(movedTask, target);
      else if (target.destination === 'time-grid') {
        callbacks.onTimeChange(movedTask, target.startMinutes);
      }
    },
    onDuration: (resizedTask, target) => {
      if (callbacks.onTimedDuration) callbacks.onTimedDuration(resizedTask, target);
      else callbacks.onDurationChange(resizedTask, target.durationMinutes);
    },
    onBoundary: (resizedTask, target: TimedBoundaryTarget) => {
      if (callbacks.onTimedBoundary) callbacks.onTimedBoundary(resizedTask, target);
      else if (target.boundary === 'start') callbacks.onStartChange(resizedTask, target.date);
      else if (target.boundary === 'due') callbacks.onDueChange?.(resizedTask, target.date);
      else callbacks.onExtendToSpan(resizedTask, target.date);
    },
  });
}

/**
 * Legacy no-date compatibility renderer for the old inert continuation shape. Production
 * Today/Week rendering no longer calls this function: both terminal and ghost segments now go
 * through one `renderTimedBlocksForDay` overlap pass and share the owned interaction contract.
 *
 * Deliberately minimal — no checkbox, no drag, no resize handles, no markdown-link-aware title
 * rendering (a plain textContent title, unlike the anchor block's renderTaskText) — visually
 * similar in spirit to MonthGridView's existing `.tc-mg-span-segment` continuation bars for
 * untimed spans: clearly linked to the task (same title, tag color, time-of-day position) but
 * unmistakably not a second interactive copy within this compatibility API. A contextmenu opens
 * the task modal (`onTaskClick`), same as a full block, since that's a read-only action.
 *
 * Task 35 (expanded scope): also shows the same time-range+duration subtitle and count badges
 * (subtasks/comments/links) the anchor block shows, so a continuation segment reads as more than
 * just a title bar — but this legacy shape stays purely presentational: no checkbox, and neither
 * the subtitle nor the badges container gets a click/drag handler.
 *
 * Task 37: like `.tc-tg-block`, `.tc-tg-block-continuation` has a CSS min-height that keeps a
 * short segment's title legible — but, unlike production ghosts, these compatibility segments
 * never go through `packOverlaps`. `capContinuationMinHeightsPx` retains their old collision cap.
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
      // applied to the continuation segment's shared committed fill.
      const textColorVar = tagFillTextColorVar(seg, tagColor);
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
      text: plainGhostTaskTitle(t),
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
    // Compatibility resize temporarily sets this attribute to false; resting state is absent.
    block.removeAttribute('draggable');
    mode = null;
    // Task 39: mirrors is-dragging/is-edge-resizing's own cleanup-in-every-exit-path
    // discipline — removed here (the one place every exit path funnels through) rather than
    // only in onPointerUp, so a pointercancel can never leave the affordance stuck on.
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

  // The compatibility path mutates source geometry as its preview. Any pointer cancellation must
  // restore that geometry and tear down listeners without committing. Production owned sessions
  // never mutate source geometry and do not enter this branch.
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
    // The compatibility resize path temporarily marks its root explicitly non-draggable and
    // cleanup returns it to the normal attribute-free state. Production roots never use native
    // drag and are managed by timedInteractions.ts.
    if (mode === 'resize') block.setAttribute('draggable', 'false');
    // Keep the compatibility move affordance distinct from resize and selection state.
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
 * Legacy no-date horizontal drag-resize compatibility path. Production start/due/create-span
 * handles use timedInteractions.ts. This path mirrors renderAllDay.ts's Pointer-Events pattern: no
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
  // Compatibility-only horizontal handles remain explicitly non-draggable. Their root is also
  // marked non-draggable while armed and returns to the normal attribute-free state on cleanup.
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
    block?.removeAttribute('draggable');
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
