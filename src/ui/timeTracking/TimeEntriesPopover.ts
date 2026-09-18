import { setIcon } from 'obsidian';
import {
  entryDurationMs,
  formatTrackedDurationWithSeconds,
  localDayStartMs,
  taskNodeAddress,
  timeEntryRef,
  type SubtaskSnapshot,
  type TaskNodeRef,
  type TaskSnapshot,
  type TimeEntrySnapshot,
} from '../../tasks';
import { openAnchoredPopover, type AnchoredPopover } from '../anchoredPopover';
import { writeText } from '../guardedDomWrites';
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
  closed: boolean;
}

const POPOVER_SELECTOR = '.abyss-time-tracking-popover--sessions';
const EMPTY_TEXT = 'No tracked time yet';
const BROKEN_HEADING = 'Needs attention';
const REMOVED_LABEL = 'Removed';
const MISSING_ENTRY = '[abyss-tasks] The tracked session to remove is no longer in the note';

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

function close(session: PopoverSession, restoreFocus?: boolean): void {
  session.shell.close(restoreFocus);
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
    update(session);
    return;
  }
  // The row's place is read with the earlier undo row discounted, because `show` clears that row
  // before it renders this one. Reading it here rather than clearing first leaves a failed removal
  // with the undo it was already offering.
  const index = [...session.shell.element.children]
    .filter((child) => !child.classList.contains('abyss-undo-row'))
    .indexOf(rowEl);
  const recovery = await actions.remove(timeEntryRef(current.parent, current.entry));
  if (recovery === undefined || session.closed) return;
  session.undo.show(
    owner,
    {
      list: POPOVER_SELECTOR,
      index,
      title: rangeLabel(current.entry, context()),
      label: REMOVED_LABEL,
    },
    () => actions.restore(recovery),
    // The tracking actions already report a failed write, so the row only has to come back.
    { report: () => {} },
  );
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

function renderRow(session: PopoverSession, row: SessionRow, context: TrackedTimeContext): void {
  const { entry } = row;
  const running = entry.state === 'running';
  const rowEl = session.shell.element.createDiv({ cls: 'abyss-time-row' });
  rowEl.toggleClass('is-broken', entry.state === 'broken');
  renderCells(session, rowEl, row, context);
  const question =
    running && entry.startMs !== undefined
      ? staleTrackingQuestion(entry.startMs, context)
      : undefined;
  rowEl.toggleClass('is-tracking', running);
  rowEl.toggleClass('is-stale', question !== undefined);
  if (question !== undefined) rowEl.title = question;
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

/**
 * The rows under the day they started in, newest day first, with the lines that carry no instant
 * gathered under the last heading. The sort already put them in that order, so one pass is enough.
 */
function renderDays(
  session: PopoverSession,
  rows: readonly SessionRow[],
  context: TrackedTimeContext,
): void {
  let openDayMs: number | undefined;
  let opened = false;
  for (const row of rows) {
    const start = startMs(row);
    const dayMs = start === undefined ? undefined : localDayStartMs(start, context.offsetAt);
    if (!opened || dayMs !== openDayMs) {
      openDayMs = dayMs;
      opened = true;
      // The day reads as an inspector section label, so the rows under it carry all the weight.
      session.shell.element.createDiv({
        cls: 'abyss-right-section-label abyss-time-day',
        text: dayMs === undefined ? BROKEN_HEADING : formatDayHeading(dayMs, context),
      });
    }
    renderRow(session, row, context);
  }
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
    return;
  }
  const { scrollTop } = element;
  session.undo.detach();
  element.empty();
  session.live = [];
  session.rendered = rendered;
  const rows = collectRows(node);
  if (rows.length === 0) element.createDiv({ cls: 'abyss-time-tracking-empty', text: EMPTY_TEXT });
  renderDays(session, rows, context);
  session.undo.render(session.options.owner);
  element.scrollTop = scrollTop;
  session.shell.reposition();
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
