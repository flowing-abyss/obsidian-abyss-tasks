import { setIcon } from 'obsidian';
import {
  localDayStartMs,
  type TaskNodeRef,
  type TrackedDay,
  type TrackedDayRow,
} from '../../tasks';
import { anchoredPlacement } from '../anchoredPlacement';
import { runAsyncAction } from '../runAsyncAction';
import { formatDayHeading, formatTrackedClock, type TrackedTimeContext } from './formatTracked';
import type { TrackingActions } from './trackingActions';

export interface TrackedTasksPopoverOptions {
  /** The positioned surface the list is placed in, as the sessions popover uses. */
  readonly owner: HTMLElement;
  readonly anchor: HTMLElement;
  readonly boundary: HTMLElement;
  readonly days: () => readonly TrackedDay[];
  /**
   * What the open timer has earned since the days were grouped, which is all a second can add.
   * Only the running row and the day holding it count it, so both stay level with the rail widget.
   */
  readonly runningExtraMs: () => number;
  readonly context: () => TrackedTimeContext;
  readonly actions: TrackingActions;
  readonly openTask: (target: TaskNodeRef) => void;
  readonly onClose: (restoreFocus: boolean) => void;
}

export interface TrackedTasksPopoverHandle {
  /** Rebuilds the sections from the days in hand, keeping the days a reader opened. */
  update(): void;
  /** Repaints the running row and its heading, which is all a second can change. */
  tick(): void;
  close(restoreFocus?: boolean): void;
}

/** A running row and the two totals a second moves. */
interface LiveTotals {
  readonly row: TrackedDayRow;
  readonly clock: HTMLElement;
  readonly day: TrackedDay;
  readonly dayTotal: HTMLElement;
}

/** One open list: its surface, the days a reader opened, and the listeners it holds. */
interface PopoverSession {
  readonly options: TrackedTasksPopoverOptions;
  readonly element: HTMLElement;
  /** Day starts a reader has opened, so an index change does not fold them back up. */
  readonly expanded: Set<number>;
  /** Day starts that have already been given their default, so today opens exactly once. */
  readonly defaulted: Set<number>;
  live: LiveTotals[];
  closed: boolean;
  release: () => void;
}

const EMPTY_TEXT = 'No tracked time in the last seven days';
const GAP = 4;
const EDGE_GAP = 8;

function writeText(element: HTMLElement, value: string): void {
  if (element.textContent !== value) element.setText(value);
}

function finished(row: TrackedDayRow): boolean {
  const { status } = row.entryOfRecord;
  return status === 'done' || status === 'cancelled';
}

function rowMs(row: TrackedDayRow, extraMs: number): number {
  return row.trackedMs + (row.running ? extraMs : 0);
}

function dayMs(day: TrackedDay, extraMs: number): number {
  return day.totalMs + (day.rows.some((row) => row.running) ? extraMs : 0);
}

function setPopoverLength(popover: HTMLElement, property: string, value: number): void {
  popover.style.setProperty(`--abyss-pop-${property}`, `${value}px`);
}

/** The room the list has beside the rail, which is what gives it its own scroll. */
function constrainPopover(element: HTMLElement, boundary: DOMRect, anchor: DOMRect): void {
  setPopoverLength(element, 'width', Math.max(0, boundary.right - anchor.right - GAP - EDGE_GAP));
  setPopoverLength(element, 'height', Math.max(0, boundary.height - 2 * EDGE_GAP));
}

function position(session: PopoverSession): void {
  const { element } = session;
  if (session.closed || !element.isConnected) return;
  const boundary = session.options.boundary.getBoundingClientRect();
  const anchor = session.options.anchor.getBoundingClientRect();
  constrainPopover(element, boundary, anchor);
  const floating = element.getBoundingClientRect();
  const placement = anchoredPlacement({
    anchor,
    boundary,
    floating: {
      width: floating.width !== 0 ? floating.width : element.offsetWidth,
      height: floating.height !== 0 ? floating.height : element.offsetHeight,
    },
    gap: GAP,
    edgeGap: EDGE_GAP,
    preferred: 'right-end',
  });
  // The placement is in viewport space, so it is read back into the padding box of whichever
  // ancestor actually positions the popover.
  const block = (element.offsetParent as HTMLElement | null) ?? session.options.boundary;
  const rect = block.getBoundingClientRect();
  setPopoverLength(element, 'top', placement.top - rect.top - block.clientTop + block.scrollTop);
  setPopoverLength(
    element,
    'left',
    placement.left - rect.left - block.clientLeft + block.scrollLeft,
  );
  element.dataset['side'] = placement.side;
}

function close(session: PopoverSession, restoreFocus?: boolean): void {
  if (session.closed) return;
  const { element } = session;
  const focused = restoreFocus ?? element.contains(element.ownerDocument.activeElement);
  session.closed = true;
  session.release();
  element.remove();
  session.options.onClose(focused);
}

function listen(session: PopoverSession): () => void {
  const { element } = session;
  const ownerDocument = element.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  const reposition = (): void => {
    position(session);
  };
  const outside = (event: Event): void => {
    const target = event.target;
    if (
      !(target instanceof Node) ||
      element.contains(target) ||
      session.options.anchor.contains(target)
    )
      return;
    close(session, false);
  };
  const keydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close(session, true);
  };
  ownerDocument.addEventListener('pointerdown', outside, true);
  ownerDocument.addEventListener('keydown', keydown, true);
  ownerDocument.addEventListener('scroll', reposition, true);
  ownerWindow?.addEventListener('resize', reposition);
  return () => {
    ownerDocument.removeEventListener('pointerdown', outside, true);
    ownerDocument.removeEventListener('keydown', keydown, true);
    ownerDocument.removeEventListener('scroll', reposition, true);
    ownerWindow?.removeEventListener('resize', reposition);
  };
}

function renderRowControl(session: PopoverSession, rowEl: HTMLElement, row: TrackedDayRow): void {
  if (finished(row)) {
    // Nothing can be resumed on a task somebody already closed, so the row says so and offers no
    // control at all rather than a button that would be refused.
    const done = rowEl.createSpan({
      cls: 'abyss-tracked-row-done',
      attr: { 'aria-hidden': 'true' },
    });
    setIcon(done, 'check');
    return;
  }
  const { title } = row.entryOfRecord;
  const label = row.running ? `Pause ${title}` : `Resume ${title}`;
  const control = rowEl.createEl('button', {
    cls: 'abyss-tracked-row-toggle',
    attr: { type: 'button', 'aria-label': label, title: label },
  });
  setIcon(control, row.running ? 'pause' : 'play');
  control.addEventListener('click', (event) => {
    event.stopPropagation();
    const { actions } = session.options;
    runAsyncAction(
      row.running ? actions.pause() : actions.start(row.entryOfRecord.target),
      'Could not change time tracking',
    );
  });
}

/** Where one row is written, and the two totals a tick has to find again. */
interface DaySection {
  readonly day: TrackedDay;
  readonly rows: HTMLElement;
  readonly total: HTMLElement;
}

function renderRow(
  session: PopoverSession,
  section: DaySection,
  row: TrackedDayRow,
  extraMs: number,
): void {
  const rowEl = section.rows.createDiv({ cls: 'abyss-tracked-row' });
  rowEl.toggleClass('is-tracking', row.running);
  rowEl.toggleClass('is-finished', finished(row));
  renderRowControl(session, rowEl, row);
  const open = rowEl.createEl('button', {
    cls: 'abyss-tracked-row-open',
    attr: { type: 'button' },
  });
  open.createSpan({ cls: 'abyss-tracked-row-title', text: row.entryOfRecord.title });
  const { parentTitle } = row.entryOfRecord;
  if (parentTitle !== undefined) {
    open.createSpan({ cls: 'abyss-tracked-row-parent', text: parentTitle });
  }
  open.addEventListener('click', (event) => {
    event.stopPropagation();
    session.options.openTask(row.entryOfRecord.target);
    close(session, false);
  });
  const clock = rowEl.createSpan({
    cls: 'abyss-tracked-row-clock',
    text: formatTrackedClock(rowMs(row, extraMs)),
  });
  if (row.running) {
    session.live.push({ row, clock, day: section.day, dayTotal: section.total });
  }
}

function renderDay(
  session: PopoverSession,
  day: TrackedDay,
  todayStartMs: number,
  extraMs: number,
): void {
  if (!session.defaulted.has(day.dayStartMs)) {
    session.defaulted.add(day.dayStartMs);
    if (day.dayStartMs === todayStartMs) session.expanded.add(day.dayStartMs);
  }
  const open = session.expanded.has(day.dayStartMs);
  const sectionEl = session.element.createDiv({ cls: 'abyss-tracked-day' });
  const header = sectionEl.createEl('button', {
    cls: 'abyss-tracked-day-header',
    attr: { type: 'button', 'aria-expanded': String(open) },
  });
  header.createSpan({
    cls: 'abyss-tracked-day-name',
    text: formatDayHeading(day.dayStartMs, session.options.context()),
  });
  const total = header.createSpan({
    cls: 'abyss-tracked-day-total',
    text: formatTrackedClock(dayMs(day, extraMs)),
  });
  const rows = sectionEl.createDiv({ cls: 'abyss-tracked-day-rows' });
  rows.hidden = !open;
  header.addEventListener('click', (event) => {
    event.stopPropagation();
    if (session.expanded.delete(day.dayStartMs)) header.setAttribute('aria-expanded', 'false');
    else {
      session.expanded.add(day.dayStartMs);
      header.setAttribute('aria-expanded', 'true');
    }
    rows.hidden = !session.expanded.has(day.dayStartMs);
    position(session);
  });
  const section: DaySection = { day, rows, total };
  for (const row of day.rows) renderRow(session, section, row, extraMs);
}

function update(session: PopoverSession): void {
  if (session.closed) return;
  const { element } = session;
  // A re-rendered rail empties its host, so the popover re-enters the surface it owns.
  if (!element.isConnected) session.options.owner.appendChild(element);
  const { scrollTop } = element;
  element.empty();
  session.live = [];
  const context = session.options.context();
  const todayStartMs = localDayStartMs(context.nowMs, context.offsetAt);
  const extraMs = session.options.runningExtraMs();
  const days = session.options.days();
  if (days.length === 0) {
    element.createDiv({ cls: 'abyss-tracked-empty', text: EMPTY_TEXT });
  }
  for (const day of days) renderDay(session, day, todayStartMs, extraMs);
  element.scrollTop = scrollTop;
  position(session);
}

function tick(session: PopoverSession): void {
  if (session.closed || session.live.length === 0) return;
  const extraMs = session.options.runningExtraMs();
  for (const live of session.live) {
    writeText(live.clock, formatTrackedClock(rowMs(live.row, extraMs)));
    writeText(live.dayTotal, formatTrackedClock(dayMs(live.day, extraMs)));
  }
}

/**
 * The tasks tracked over the last seven days, newest day first.
 *
 * The sections are rebuilt only when the index reports a change; a tick repaints the running row
 * and its heading from the day already in hand. Every control acts on the target the current
 * grouping carries, so a click writes against the note as it reads now.
 */
export function showTrackedTasksPopover(
  options: TrackedTasksPopoverOptions,
): TrackedTasksPopoverHandle {
  const session: PopoverSession = {
    options,
    element: options.owner.createDiv({
      cls: 'abyss-popover abyss-popover-anchored abyss-tracked-tasks-popover',
      attr: { role: 'dialog', 'aria-label': 'Tracked tasks' },
    }),
    expanded: new Set<number>(),
    defaulted: new Set<number>(),
    live: [],
    closed: false,
    release: () => {},
  };
  session.release = listen(session);
  update(session);
  return {
    update: () => {
      update(session);
    },
    tick: () => {
      tick(session);
    },
    close: (restoreFocus?: boolean) => {
      close(session, restoreFocus);
    },
  };
}
