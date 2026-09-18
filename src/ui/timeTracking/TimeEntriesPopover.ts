import { setIcon } from 'obsidian';
import {
  entryDurationMs,
  localDayStartMs,
  taskNodeAddress,
  timeEntryRef,
  type SubtaskSnapshot,
  type TaskNodeRef,
  type TaskSnapshot,
  type TimeEntrySnapshot,
} from '../../tasks';
import { anchoredPlacement } from '../anchoredPlacement';
import { createInlineTaskUndo } from '../inlineTaskUndo';
import { runAsyncAction } from '../runAsyncAction';
import {
  formatSessionRange,
  formatTrackedDuration,
  formatTrackedTicker,
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
  /** The descendant that owns the entry, muted beside the span, absent on the node's own. */
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

/** One open popover: its surface, the rows a tick repaints, and the listeners it holds. */
interface PopoverSession {
  readonly options: TimeEntriesPopoverOptions;
  readonly element: HTMLElement;
  readonly undo: ReturnType<typeof createInlineTaskUndo>;
  live: LiveRow[];
  rendered: RenderedList | undefined;
  closed: boolean;
  release: () => void;
}

const POPOVER_SELECTOR = '.abyss-time-tracking-popover';
const EMPTY_TEXT = 'No tracked time yet';
const REMOVED_LABEL = 'Removed';
const MISSING_ENTRY = '[abyss-tasks] The tracked session to remove is no longer in the note';
const GAP = 4;
const EDGE_GAP = 8;

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

function durationLabel(entry: TimeEntrySnapshot, nowMs: number): string {
  const elapsed = entryDurationMs(entry, nowMs);
  return entry.state === 'running'
    ? `+${formatTrackedTicker(elapsed)}`
    : `+${formatTrackedDuration(elapsed)}`;
}

function rangeLabel(entry: TimeEntrySnapshot, context: TrackedTimeContext): string {
  return entry.state === 'broken'
    ? entryLineText(entry.originalMarkdown)
    : formatSessionRange(entry, context);
}

function writeText(element: HTMLElement, value: string): void {
  if (element.textContent !== value) element.setText(value);
}

function setPopoverLength(popover: HTMLElement, property: string, value: number): void {
  popover.style.setProperty(`--abyss-pop-${property}`, `${value}px`);
}

/** The room the popover has inside the boundary, which is what gives the list its own scroll. */
function constrainPopover(element: HTMLElement, boundary: DOMRect, anchor: DOMRect): void {
  setPopoverLength(element, 'width', Math.max(0, boundary.width - 2 * EDGE_GAP));
  setPopoverLength(
    element,
    'height',
    Math.max(
      0,
      Math.min(
        boundary.height - 2 * EDGE_GAP,
        Math.max(
          anchor.top - boundary.top - EDGE_GAP - GAP,
          boundary.bottom - EDGE_GAP - anchor.bottom - GAP,
        ),
      ),
    ),
  );
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
    preferred: 'below-start',
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
  session.undo.clear();
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
  ownerDocument.addEventListener('focusin', outside, true);
  ownerDocument.addEventListener('keydown', keydown, true);
  ownerDocument.addEventListener('scroll', reposition, true);
  ownerWindow?.addEventListener('resize', reposition);
  return () => {
    ownerDocument.removeEventListener('pointerdown', outside, true);
    ownerDocument.removeEventListener('focusin', outside, true);
    ownerDocument.removeEventListener('keydown', keydown, true);
    ownerDocument.removeEventListener('scroll', reposition, true);
    ownerWindow?.removeEventListener('resize', reposition);
  };
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
  const index = [...session.element.children]
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

function renderLeading(
  session: PopoverSession,
  rowEl: HTMLElement,
  entry: TimeEntrySnapshot,
): void {
  if (entry.state === 'broken') {
    const warning = rowEl.createSpan({
      cls: 'abyss-time-row-warning',
      attr: { 'aria-hidden': 'true' },
    });
    setIcon(warning, 'triangle-alert');
    return;
  }
  const duration = rowEl.createSpan({
    cls: 'abyss-time-row-duration',
    text: durationLabel(entry, session.options.context().nowMs),
  });
  if (entry.state === 'running') session.live.push({ entry, duration });
}

function renderRow(session: PopoverSession, row: SessionRow, context: TrackedTimeContext): void {
  const { entry } = row;
  const running = entry.state === 'running';
  const rowEl = session.element.createDiv({ cls: 'abyss-time-row' });
  renderLeading(session, rowEl, entry);
  const body = rowEl.createDiv({ cls: 'abyss-time-row-body' });
  const line = body.createDiv({ cls: 'abyss-time-row-line' });
  line.createSpan({ cls: 'abyss-time-row-range', text: rangeLabel(entry, context) });
  if (row.node !== undefined) line.createSpan({ cls: 'abyss-time-row-node', text: row.node });
  if (entry.tail !== undefined) body.createSpan({ cls: 'abyss-time-row-tail', text: entry.tail });
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

function update(session: PopoverSession): void {
  if (session.closed) return;
  const node = session.options.node();
  if (node === undefined) {
    close(session, false);
    return;
  }
  const { element } = session;
  // A re-rendered inspector empties the panel, so the popover re-enters the surface it owns.
  const reattached = !element.isConnected;
  if (reattached) session.options.owner.appendChild(element);
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
    position(session);
    return;
  }
  const { scrollTop } = element;
  session.undo.detach();
  element.empty();
  session.live = [];
  session.rendered = rendered;
  const rows = collectRows(node);
  if (rows.length === 0) element.createDiv({ cls: 'abyss-time-tracking-empty', text: EMPTY_TEXT });
  for (const row of rows) renderRow(session, row, context);
  session.undo.render(session.options.owner);
  element.scrollTop = scrollTop;
  position(session);
}

function tick(session: PopoverSession): void {
  if (session.closed || session.live.length === 0) return;
  const { nowMs } = session.options.context();
  for (const row of session.live) writeText(row.duration, durationLabel(row.entry, nowMs));
}

/**
 * The sessions of one inspector selection, listed newest first.
 *
 * The list is rebuilt only when the index reports a change; a tick repaints the running rows from
 * the entries already in hand. Every removal re-reads the selection first, so the line a click
 * deletes is the line the note holds now rather than the one the row was drawn from.
 */
export function showTimeEntriesPopover(
  options: TimeEntriesPopoverOptions,
): TimeEntriesPopoverHandle {
  const session: PopoverSession = {
    options,
    element: options.owner.createDiv({
      cls: 'abyss-popover abyss-popover-anchored abyss-time-tracking-popover',
      attr: { role: 'dialog', 'aria-label': 'Tracked sessions' },
    }),
    undo: createInlineTaskUndo(),
    live: [],
    rendered: undefined,
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
