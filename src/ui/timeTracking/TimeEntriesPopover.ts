import { setIcon } from 'obsidian';
import {
  entryDurationMs,
  formatTrackedDurationWithSeconds,
  localDayStartMs,
  shiftLocalDayStartMs,
  taskNodeAddress,
  timeEntryRef,
  type SubtaskSnapshot,
  type TaskNodeRef,
  type TaskSnapshot,
  type TimeEntrySnapshot,
} from '../../tasks';
import { openAnchoredPopover, type AnchoredPopover } from '../anchoredPopover';
import { writeText, writeTitle } from '../guardedDomWrites';
import { createInlineTaskUndo } from '../inlineTaskUndo';
import { runAsyncAction } from '../runAsyncAction';
import {
  formatDayHeading,
  formatSessionClockRange,
  formatTrackedDuration,
  staleTrackingQuestion,
  type TrackedTimeContext,
} from './formatTracked';
import type { TrackingActions } from './trackingActions';

/** The node a tracking surface acts on, read again at action time so no write uses a stale ref. */
export interface TrackedNode {
  readonly snapshot: TaskSnapshot | SubtaskSnapshot;
  readonly ref: TaskNodeRef;
}

/**
 * Where the node is and what its Markdown reads as. The index answers every read with a fresh
 * snapshot object, so identity cannot say whether a node changed; the revision a task ref carries
 * and the block a sub-task ref carries both change exactly when the node's own lines do.
 */
export function trackedNodeKey(node: TrackedNode): string {
  const source = node.ref.type === 'task' ? node.ref.ref.revision : node.ref.ref.originalBlock;
  // The address is a JSON array, so it ends at its own bracket and a plain space separates it.
  return `${taskNodeAddress(node.ref)} ${source}`;
}

export interface TimeEntriesPopoverOptions {
  readonly owner: HTMLElement;
  readonly anchor: HTMLElement;
  readonly boundary: HTMLElement;
  readonly node: () => TrackedNode | undefined;
  readonly actions: TrackingActions;
  readonly context: () => TrackedTimeContext;
  readonly onClose: (restoreFocus: boolean) => void;
}

export interface TimeEntriesPopoverHandle {
  /** Rebuilds the rows from fresh snapshots, keeping the scroll offset and the undo row. */
  update(): void;
  /** Repaints the running rows, which is all a second can change. */
  tick(): void;
  close(restoreFocus?: boolean): void;
}

/** One entry with the node it belongs to, addressed so a later snapshot can be asked for it again. */
interface SessionRow {
  readonly key: string;
  readonly entry: TimeEntrySnapshot;
  readonly parent: TaskNodeRef;
  /** The descendant that owns the entry, named in the note cell, absent on the node's own. */
  readonly node?: string;
}

/** A running row and the element its second-by-second total is written into. */
interface LiveRow {
  readonly entry: TimeEntrySnapshot;
  readonly duration: HTMLElement;
}

/** One local day of sessions, or the trailing group of lines the plugin could not read. */
interface DayGroup {
  /** The day start in milliseconds, or `broken`, written on the section so a row can name it. */
  readonly key: string;
  readonly heading: string;
  readonly rows: SessionRow[];
}

/** What the rendered list was built from, so an unrelated change repaints nothing. */
interface RenderedList {
  readonly key: string;
  readonly dayStartMs: number;
}

/** One open popover: its surface, the rows a tick repaints, and what a rebuild has to carry over. */
interface PopoverSession {
  readonly options: TimeEntriesPopoverOptions;
  readonly shell: AnchoredPopover;
  readonly undo: ReturnType<typeof createInlineTaskUndo>;
  live: LiveRow[];
  rendered: RenderedList | undefined;
  /** The day whose heading is held open so a pending undo row has somewhere of its own to sit. */
  undoDayKey: string | undefined;
  /** Which offer holds it, so the offer it replaced cannot take the heading away with it. */
  undoOffer: number;
  /** Whether an undo row is on screen, which is the only thing that can release a held day. */
  undoPending: boolean;
  /** The one wait for the next local midnight, for the list no tick is driving. */
  rollover: number | undefined;
  closed: boolean;
}

const POPOVER_SELECTOR = '.abyss-time-tracking-popover--sessions';
const EMPTY_TEXT = 'No tracked time yet';
const BROKEN_HEADING = 'Needs attention';
const BROKEN_KEY = 'broken';
const DAY_KEY = 'day';
const REMOVED_LABEL = 'Removed';
const MISSING_ENTRY = '[abyss-tasks] The tracked session to remove is no longer in the note';
const MISSING_DAY = '[abyss-tasks] The tracked session to remove is no longer under a day';

/** The written entry without its list prefix, which is all a broken line can be shown as. */
function entryLineText(originalMarkdown: string): string {
  return originalMarkdown.replace(/^[\s>]*-[ \t]+/u, '').trim();
}

function collectRows(node: TrackedNode): SessionRow[] {
  const rows: SessionRow[] = [];
  const walk = (
    snapshot: TaskSnapshot | SubtaskSnapshot,
    ref: TaskNodeRef,
    title?: string,
  ): void => {
    const address = taskNodeAddress(ref);
    for (const entry of snapshot.timeEntries) {
      rows.push({
        key: JSON.stringify([address, entry.relativeLine, entry.originalMarkdown]),
        entry,
        parent: ref,
        ...(title !== undefined && { node: title }),
      });
    }
    for (const subtask of snapshot.subtasks) {
      walk(subtask, { type: 'subtask', ref: subtask.ref }, subtask.title);
    }
  };
  walk(node.snapshot, node.ref);
  return rows.sort(newestFirst);
}

function startMs(row: SessionRow): number | undefined {
  return row.entry.state === 'broken' ? undefined : row.entry.startMs;
}

/** A broken entry carries no instant to sort on, so it sinks below everything that does. */
function newestFirst(left: SessionRow, right: SessionRow): number {
  const leftMs = startMs(left);
  const rightMs = startMs(right);
  if (leftMs === undefined) return rightMs === undefined ? 0 : 1;
  if (rightMs === undefined) return -1;
  return rightMs - leftMs;
}

/** A running session spells out its seconds, because they are what proves the timer is moving. */
function durationLabel(entry: TimeEntrySnapshot, nowMs: number): string {
  const elapsed = entryDurationMs(entry, nowMs);
  return entry.state === 'running'
    ? formatTrackedDurationWithSeconds(elapsed)
    : formatTrackedDuration(elapsed);
}

function rangeLabel(entry: TimeEntrySnapshot, context: TrackedTimeContext): string {
  return entry.state === 'broken'
    ? entryLineText(entry.originalMarkdown)
    : formatSessionClockRange(entry, context);
}

/** What the note cell says, which is also the row's tooltip once that cell has no room to say it. */
function noteLabel(row: SessionRow): string {
  const { entry } = row;
  if (entry.state === 'broken') return entryLineText(entry.originalMarkdown);
  return [entry.tail, row.node].filter((part) => part !== undefined).join(' ');
}

/**
 * The sorted rows cut into the local days they started in, newest day first, with the lines that
 * carry no instant gathered under the last heading.
 *
 * The bounds of the open day are read once, not once per row: the rows are already in order, so a
 * row inside them belongs to the day that is open and only a row outside them opens the next.
 */
function dayGroups(rows: readonly SessionRow[], context: TrackedTimeContext): DayGroup[] {
  const groups: DayGroup[] = [];
  let open: DayGroup | undefined;
  let dayStartMs = 0;
  let nextDayStartMs = 0;
  for (const row of rows) {
    const start = startMs(row);
    if (start === undefined) {
      if (open?.key !== BROKEN_KEY) {
        open = { key: BROKEN_KEY, heading: BROKEN_HEADING, rows: [] };
        groups.push(open);
      }
    } else if (open === undefined || start < dayStartMs || start >= nextDayStartMs) {
      dayStartMs = localDayStartMs(start, context.offsetAt);
      nextDayStartMs = shiftLocalDayStartMs(dayStartMs, 1, context.offsetAt);
      open = { key: String(dayStartMs), heading: formatDayHeading(dayStartMs, context), rows: [] };
      groups.push(open);
    }
    open.rows.push(row);
  }
  return groups;
}

/**
 * The same days with the one an undo row is waiting under put back in its place, so removing the
 * last session of a day leaves that day standing until the offer is over rather than filing its
 * undo row under the heading of the day below.
 */
function withUndoDay(
  groups: DayGroup[],
  key: string | undefined,
  context: TrackedTimeContext,
): DayGroup[] {
  if (key === undefined || groups.some((group) => group.key === key)) return groups;
  const broken = key === BROKEN_KEY;
  const restored: DayGroup = {
    key,
    heading: broken ? BROKEN_HEADING : formatDayHeading(Number(key), context),
    rows: [],
  };
  const at = broken
    ? groups.length
    : groups.findIndex((group) => group.key === BROKEN_KEY || Number(group.key) < Number(key));
  groups.splice(at < 0 ? groups.length : at, 0, restored);
  return groups;
}

function close(session: PopoverSession, restoreFocus?: boolean): void {
  session.shell.close(restoreFocus);
}

/**
 * What a removal that wrote nothing gives back: the number an offer knows itself by, without which
 * it could never let its day go, and the day this attempt took from whatever was holding one. That
 * day returns only while an undo row is still on screen to release it later; with nothing pending,
 * holding it would strand a heading with no entries and nobody left to drop it.
 */
function refundRemoval(
  session: PopoverSession,
  offer: number,
  heldBefore: string | undefined,
): void {
  if (session.undoOffer !== offer) return;
  session.undoOffer = offer - 1;
  if (session.closed) return;
  holdUndoDay(session, session.undoPending ? heldBefore : undefined);
}

async function removeSession(
  session: PopoverSession,
  row: SessionRow,
  rowEl: HTMLElement,
): Promise<void> {
  const { actions, context, owner } = session.options;
  const node = session.options.node();
  const current =
    node === undefined ? undefined : collectRows(node).find((entry) => entry.key === row.key);
  if (current === undefined) {
    // The note moved on without this row, so it says so in diagnostics and redraws the list rather
    // than leaving a control that does nothing.
    console.error(MISSING_ENTRY);
    redraw(session);
    return;
  }
  // The row's place is its day and its position inside that day, read with the earlier undo row
  // discounted because `show` clears that row before it renders this one. Reading it here rather
  // than clearing first leaves a failed removal with the undo it was already offering.
  const section = rowEl.parentElement;
  const dayKey = section?.dataset[DAY_KEY];
  if (section === null || dayKey === undefined) {
    // A row outside its day has nowhere to put an undo, which is a broken list rather than a
    // refused write, so it is reported and redrawn like a row the note no longer holds.
    console.error(MISSING_DAY);
    redraw(session);
    return;
  }
  const index = [...section.children]
    .filter((child) => !child.classList.contains('abyss-undo-row'))
    .indexOf(rowEl);
  // The day is held open from here, so a removal that empties it still has the heading to sit
  // under by the time the write lands and the list is rebuilt.
  const heldBefore = session.undoDayKey;
  const offer = (session.undoOffer += 1);
  session.undoDayKey = dayKey;
  const recovery = await actions.remove(timeEntryRef(current.parent, current.entry));
  if (recovery === undefined || session.closed) {
    refundRemoval(session, offer, heldBefore);
    return;
  }
  session.undo.show(
    owner,
    {
      list: `${POPOVER_SELECTOR} [data-${DAY_KEY}="${dayKey}"]`,
      index,
      title: rangeLabel(current.entry, context()),
      label: REMOVED_LABEL,
      accessibleName: undoName(current, dayKey, section, context()),
    },
    () => actions.restore(recovery),
    // The tracking actions already report a failed write, so the row only has to come back.
    {
      report: () => {},
      // Replacing this offer runs the one it replaced, whose day is no longer the held one.
      onEnd: () => {
        session.undoPending = false;
        if (session.undoOffer === offer) holdUndoDay(session, undefined);
      },
    },
  );
  // Set after the row exists, because showing it ends the offer it replaced, and that end runs
  // through the same flag on its way out.
  session.undoPending = true;
}

/** Holds a day open for an undo row, or lets the last one go, and redraws past the memo. */
function holdUndoDay(session: PopoverSession, key: string | undefined): void {
  if (session.closed || session.undoDayKey === key) return;
  session.undoDayKey = key;
  redraw(session);
}

/** Rebuilds the list whatever the memo of the last one says, for a list known to be out of date. */
function redraw(session: PopoverSession): void {
  session.rendered = undefined;
  update(session);
}

/** The arrow of a span said as the word it stands for, for a label that is read out rather than seen. */
function spokenArrow(range: string): string {
  return range
    .replaceAll('→', ' to ')
    .replace(/\s{2,}/gu, ' ')
    .trim();
}

/**
 * One session said aloud, `09:12 to 10:32` or `12:30 onwards`, because an arrow is a shape rather
 * than a word and an accessible name is read out. A line the plugin could not read is spoken as it
 * was written, with the same arrow spelled out.
 */
function spokenRange(row: SessionRow, context: TrackedTimeContext): string {
  const range = rangeLabel(row.entry, context);
  if (row.entry.state !== 'broken' && range.endsWith('→')) {
    return `${range.slice(0, -1).trimEnd()} onwards`;
  }
  return spokenArrow(range);
}

/**
 * What the undo control is called, which says which day the session goes back into: a list holding
 * several days offers one Undo at a time, and its own row is the only thing that names the rest.
 */
function undoName(
  row: SessionRow,
  dayKey: string,
  section: HTMLElement,
  context: TrackedTimeContext,
): string {
  const spoken = spokenRange(row, context);
  if (dayKey === BROKEN_KEY) return `Undo removing ${spoken}`;
  const day = section.querySelector('.abyss-time-day-label')?.textContent ?? '';
  return day.length === 0 ? `Undo removing ${spoken}` : `Undo removing ${spoken} on ${day}`;
}

/**
 * The cells of one row, always in reading order: when the span is, what it was about, how long it
 * took. A line the plugin could not read has no span and no total, so it puts the warning where the
 * span would be and shows what the note actually holds.
 */
function renderCells(
  session: PopoverSession,
  rowEl: HTMLElement,
  row: SessionRow,
  context: TrackedTimeContext,
): void {
  const { entry } = row;
  if (entry.state === 'broken') {
    const warning = rowEl.createSpan({
      cls: 'abyss-time-row-warning',
      attr: { 'aria-hidden': 'true' },
    });
    setIcon(warning, 'triangle-alert');
    rowEl
      .createDiv({ cls: 'abyss-time-row-note' })
      .createSpan({ text: entryLineText(entry.originalMarkdown) });
    return;
  }
  rowEl.createSpan({
    cls: 'abyss-time-row-range',
    text: formatSessionClockRange(entry, context),
  });
  const note = rowEl.createDiv({ cls: 'abyss-time-row-note' });
  if (entry.tail !== undefined) note.createSpan({ cls: 'abyss-time-row-tail', text: entry.tail });
  if (row.node !== undefined) note.createSpan({ cls: 'abyss-time-row-node', text: row.node });
  const duration = rowEl.createSpan({
    cls: 'abyss-time-row-duration',
    text: durationLabel(entry, context.nowMs),
  });
  if (entry.state === 'running') session.live.push({ entry, duration });
}

function renderRow(
  session: PopoverSession,
  section: HTMLElement,
  row: SessionRow,
  context: TrackedTimeContext,
): void {
  const { entry } = row;
  const running = entry.state === 'running';
  const rowEl = section.createDiv({ cls: 'abyss-time-row' });
  rowEl.toggleClass('is-broken', entry.state === 'broken');
  renderCells(session, rowEl, row, context);
  const question =
    running && entry.startMs !== undefined
      ? staleTrackingQuestion(entry.startMs, context)
      : undefined;
  rowEl.toggleClass('is-tracking', running);
  rowEl.toggleClass('is-stale', question !== undefined);
  // The note cell truncates at every width and is dropped outright in a narrow pane, so the row
  // always carries what it says. The question a long-running row earns comes first, because that is
  // the one thing about the row a reader has to be told.
  writeTitle(rowEl, question ?? noteLabel(row));
  const remove = rowEl.createEl('button', {
    cls: 'abyss-time-row-remove',
    attr: { type: 'button', 'aria-label': 'Remove this session' },
  });
  setIcon(remove, 'x');
  remove.addEventListener('click', (event) => {
    event.stopPropagation();
    runAsyncAction(removeSession(session, row, rowEl), 'Could not remove a tracked session');
  });
}

/** One section per day: its heading, then its rows, and the day it is named by for an undo row. */
function renderDays(
  session: PopoverSession,
  groups: readonly DayGroup[],
  context: TrackedTimeContext,
): void {
  for (const group of groups) {
    const section = session.shell.element.createDiv({ cls: 'abyss-time-day' });
    section.dataset[DAY_KEY] = group.key;
    // The day reads as an inspector section label, so the rows under it carry all the weight.
    section.createDiv({
      cls: 'abyss-right-section-label abyss-time-day-label',
      text: group.heading,
    });
    for (const row of group.rows) renderRow(session, section, row, context);
  }
}

/** The window the surface lives in, which owns its timer. */
function ownerWindow(session: PopoverSession): Window | null {
  return session.shell.element.ownerDocument.defaultView;
}

function clearDayRollover(session: PopoverSession): void {
  if (session.rollover === undefined) return;
  ownerWindow(session)?.clearTimeout(session.rollover);
  session.rollover = undefined;
}

/**
 * One wait for the next local midnight, which is when `Today` becomes `Yesterday` and every
 * heading below it moves on. The shared tick already rebuilds the list on the second that crosses
 * midnight, so this exists only for the list with nothing running, which nothing else would wake.
 */
function scheduleDayRollover(session: PopoverSession, context: TrackedTimeContext): void {
  clearDayRollover(session);
  if (session.closed || session.live.length > 0) return;
  const win = ownerWindow(session);
  if (win === null) return;
  const nextDayMs = shiftLocalDayStartMs(
    localDayStartMs(context.nowMs, context.offsetAt),
    1,
    context.offsetAt,
  );
  session.rollover = win.setTimeout(
    () => {
      session.rollover = undefined;
      update(session);
    },
    Math.max(nextDayMs - context.nowMs, 0),
  );
}

function update(session: PopoverSession): void {
  if (session.closed) return;
  const node = session.options.node();
  if (node === undefined) {
    close(session, false);
    return;
  }
  const { element } = session.shell;
  // A re-rendered inspector empties the panel, so the popover re-enters the surface it owns.
  if (!element.isConnected) session.options.owner.appendChild(element);
  const context = session.options.context();
  const rendered: RenderedList = {
    key: trackedNodeKey(node),
    dayStartMs: localDayStartMs(context.nowMs, context.offsetAt),
  };
  // A change in another file leaves this node's lines as they were, and only a new day renames a
  // heading, so an unrelated index event neither re-reads the entries nor takes focus off a row.
  // The placement is still redone, because that same event can have moved the anchor under it.
  if (
    session.rendered?.key === rendered.key &&
    session.rendered.dayStartMs === rendered.dayStartMs
  ) {
    session.shell.reposition();
    // A midnight that arrived a moment early leaves the day it was waiting for still ahead, so the
    // wait is armed again rather than dropped on the one frame that changed nothing.
    scheduleDayRollover(session, context);
    return;
  }
  const { scrollTop } = element;
  session.undo.detach();
  element.empty();
  session.live = [];
  session.rendered = rendered;
  const rows = collectRows(node);
  if (rows.length === 0 && session.undoDayKey === undefined) {
    element.createDiv({ cls: 'abyss-time-tracking-empty', text: EMPTY_TEXT });
  }
  renderDays(session, withUndoDay(dayGroups(rows, context), session.undoDayKey, context), context);
  session.undo.render(session.options.owner);
  element.scrollTop = scrollTop;
  session.shell.reposition();
  scheduleDayRollover(session, context);
}

function tick(session: PopoverSession): void {
  if (session.closed || session.live.length === 0) return;
  const { nowMs } = session.options.context();
  for (const row of session.live) writeText(row.duration, durationLabel(row.entry, nowMs));
}

/**
 * The sessions of one inspector selection, grouped under the day each one started in, newest first.
 *
 * The list is rebuilt only when the index reports a change; a tick repaints the running rows from
 * the entries already in hand. Every removal re-reads the selection first, so the line a click
 * deletes is the line the note holds now rather than the one the row was drawn from.
 */
export function showTimeEntriesPopover(
  options: TimeEntriesPopoverOptions,
): TimeEntriesPopoverHandle {
  const undo = createInlineTaskUndo();
  // The shell cannot close before it has been opened, so the session it marks closed is always the
  // one this call is about to build.
  const onShellClose = (focused: boolean): void => {
    session.closed = true;
    clearDayRollover(session);
    undo.clear();
    options.onClose(focused);
  };
  const session: PopoverSession = {
    options,
    shell: openAnchoredPopover({
      owner: options.owner,
      anchor: options.anchor,
      boundary: options.boundary,
      preferred: 'below-start',
      cls: 'abyss-time-tracking-popover abyss-time-tracking-popover--sessions',
      attr: { role: 'dialog', 'aria-label': 'Tracked sessions' },
      onClose: onShellClose,
    }),
    undo,
    live: [],
    rendered: undefined,
    undoDayKey: undefined,
    undoOffer: 0,
    undoPending: false,
    rollover: undefined,
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
    close: (restoreFocus?: boolean) => {
      close(session, restoreFocus);
    },
  };
}
