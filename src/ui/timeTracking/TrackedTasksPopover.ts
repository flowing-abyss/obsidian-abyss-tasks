import { setIcon } from 'obsidian';
import {
  localDayStartMs,
  type TaskNodeRef,
  type TrackedDay,
  type TrackedDayRow,
} from '../../tasks';
import { openAnchoredPopover, type AnchoredPopover } from '../anchoredPopover';
import { writeText } from '../guardedDomWrites';
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

/** What one rebuild reads every row against, so the answer is the same all the way down it. */
interface RenderPass {
  readonly context: TrackedTimeContext;
  readonly todayStartMs: number;
  readonly extraMs: number;
}

/** One open list: its surface, the days a reader opened, and what a rebuild has to carry over. */
interface PopoverSession {
  readonly options: TrackedTasksPopoverOptions;
  readonly shell: AnchoredPopover;
  /** Day starts a reader has opened, so an index change does not fold them back up. */
  readonly expanded: Set<number>;
  /** Day starts that have already been given their default, so today opens exactly once. */
  readonly defaulted: Set<number>;
  live: LiveTotals[];
  closed: boolean;
}

const EMPTY_TEXT = 'No tracked time in the last seven days';
const ROW_KEY = 'rowKey';
/** Names what a control of a row is, so focus survives a rebuild that restyled or replaced it. */
const CONTROL = 'control';

function finished(row: TrackedDayRow): boolean {
  const { status } = row.entryOfRecord;
  return status === 'done' || status === 'cancelled';
}

function rowMs(running: boolean, row: TrackedDayRow, extraMs: number): number {
  return row.trackedMs + (running ? extraMs : 0);
}

function dayMs(day: TrackedDay, pass: RenderPass): number {
  const live = day.rows.some((row) => row.running);
  return day.totalMs + (live ? pass.extraMs : 0);
}

function close(session: PopoverSession, restoreFocus?: boolean): void {
  session.shell.close(restoreFocus);
}

/** Which control of which row the keyboard was on, so a rebuild can hand it back. */
interface FocusedControl {
  readonly rowKey: string;
  readonly control: string;
}

function focusedControl(session: PopoverSession): FocusedControl | undefined {
  const { element } = session.shell;
  const active = element.ownerDocument.activeElement;
  if (!(active instanceof HTMLElement) || !element.contains(active)) return undefined;
  const rowKey = active.closest<HTMLElement>('.abyss-tracked-row')?.dataset[ROW_KEY];
  const control = active.dataset[CONTROL];
  if (rowKey === undefined || control === undefined) return undefined;
  return { rowKey, control };
}

/**
 * The same control of the rebuilt row. A row that swapped play for pause hands the keyboard to the
 * control that replaced it rather than to the first button it happens to hold.
 */
function controlIn(row: HTMLElement, control: string): HTMLElement | null {
  for (const candidate of row.querySelectorAll<HTMLElement>('[data-control]')) {
    if (candidate.dataset[CONTROL] === control) return candidate;
  }
  return row.querySelector('button');
}

function restoreFocus(session: PopoverSession, focused: FocusedControl | undefined): void {
  if (focused === undefined) return;
  for (const row of session.shell.element.querySelectorAll<HTMLElement>('.abyss-tracked-row')) {
    if (row.dataset[ROW_KEY] !== focused.rowKey) continue;
    const control = controlIn(row, focused.control);
    if (control instanceof HTMLElement) control.focus({ preventScroll: true });
    return;
  }
}

function renderRowControl(
  session: PopoverSession,
  rowEl: HTMLElement,
  row: TrackedDayRow,
  running: boolean,
): void {
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
  const label = running ? `Pause ${title}` : `Resume ${title}`;
  const control = rowEl.createEl('button', {
    cls: 'abyss-tracked-row-toggle',
    attr: { type: 'button', 'aria-label': label, title: label, 'data-control': 'toggle' },
  });
  setIcon(control, running ? 'pause' : 'play');
  control.addEventListener('click', (event) => {
    event.stopPropagation();
    const { actions } = session.options;
    runAsyncAction(
      running ? actions.pause() : actions.start(row.entryOfRecord.target),
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

/**
 * One row, always in the same three columns: the control, the title cell, the clock. The sub-task's
 * parent is a second span inside the title cell rather than a fourth column, so a day holding one
 * lines up with a day that does not.
 */
function renderRow(
  session: PopoverSession,
  section: DaySection,
  row: TrackedDayRow,
  pass: RenderPass,
): void {
  const { running } = row;
  const rowEl = section.rows.createDiv({ cls: 'abyss-tracked-row' });
  rowEl.dataset[ROW_KEY] = row.key;
  rowEl.toggleClass('is-tracking', running);
  rowEl.toggleClass('is-finished', finished(row));
  renderRowControl(session, rowEl, row, running);
  const open = rowEl.createEl('button', {
    cls: 'abyss-tracked-row-open',
    attr: { type: 'button', 'data-control': 'open' },
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
    text: formatTrackedClock(rowMs(running, row, pass.extraMs)),
  });
  if (running) session.live.push({ row, clock, day: section.day, dayTotal: section.total });
}

function renderDay(session: PopoverSession, day: TrackedDay, pass: RenderPass): void {
  if (!session.defaulted.has(day.dayStartMs)) {
    session.defaulted.add(day.dayStartMs);
    if (day.dayStartMs === pass.todayStartMs) session.expanded.add(day.dayStartMs);
  }
  const open = session.expanded.has(day.dayStartMs);
  const sectionEl = session.shell.element.createDiv({ cls: 'abyss-tracked-day' });
  const header = sectionEl.createEl('button', {
    cls: 'abyss-tracked-day-header',
    attr: { type: 'button', 'aria-expanded': String(open) },
  });
  header.createSpan({
    cls: 'abyss-tracked-day-name',
    text: formatDayHeading(day.dayStartMs, pass.context),
  });
  const total = header.createSpan({
    cls: 'abyss-tracked-day-total',
    text: formatTrackedClock(dayMs(day, pass)),
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
    session.shell.reposition();
  });
  const section: DaySection = { day, rows, total };
  for (const row of day.rows) renderRow(session, section, row, pass);
}

function renderPass(session: PopoverSession): RenderPass {
  const context = session.options.context();
  return {
    context,
    todayStartMs: localDayStartMs(context.nowMs, context.offsetAt),
    extraMs: session.options.runningExtraMs(),
  };
}

function update(session: PopoverSession): void {
  if (session.closed) return;
  const { element } = session.shell;
  const focused = focusedControl(session);
  const { scrollTop } = element;
  element.empty();
  session.live = [];
  const pass = renderPass(session);
  const days = session.options.days();
  if (days.length === 0) {
    element.createDiv({ cls: 'abyss-tracked-empty', text: EMPTY_TEXT });
  }
  for (const day of days) renderDay(session, day, pass);
  element.scrollTop = scrollTop;
  restoreFocus(session, focused);
  session.shell.reposition();
}

function tick(session: PopoverSession): void {
  if (session.closed || session.live.length === 0) return;
  const pass = renderPass(session);
  for (const live of session.live) {
    writeText(live.clock, formatTrackedClock(rowMs(true, live.row, pass.extraMs)));
    writeText(live.dayTotal, formatTrackedClock(dayMs(live.day, pass)));
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
  // The shell cannot close before it has been opened, so the session it marks closed is always the
  // one this call is about to build.
  const onShellClose = (focused: boolean): void => {
    session.closed = true;
    options.onClose(focused);
  };
  const session: PopoverSession = {
    options,
    shell: openAnchoredPopover({
      owner: options.owner,
      anchor: options.anchor,
      boundary: options.boundary,
      preferred: 'right-end',
      cls: 'abyss-time-tracking-popover abyss-time-tracking-popover--tasks',
      attr: { role: 'dialog', 'aria-label': 'Tracked tasks' },
      onClose: onShellClose,
    }),
    expanded: new Set<number>(),
    defaulted: new Set<number>(),
    live: [],
    closed: false,
  };
  update(session);
  return {
    update: () => {
      update(session);
    },
    tick: () => {
      tick(session);
    },
    close: (focus?: boolean) => {
      close(session, focus);
    },
  };
}
