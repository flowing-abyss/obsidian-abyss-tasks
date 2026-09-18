import { setIcon } from 'obsidian';
import {
  subtreeTotal,
  totalMs,
  type OffsetAt,
  type TaskNodeRef,
  type TrackedTotal,
} from '../../tasks';
import { runAsyncAction } from '../runAsyncAction';
import {
  formatTrackedDuration,
  staleTrackingQuestion,
  type TrackedTimeContext,
} from './formatTracked';
import {
  showTimeEntriesPopover,
  type TimeEntriesPopoverHandle,
  type TrackedNode,
} from './TimeEntriesPopover';
import type { TrackingActions } from './trackingActions';
import type { TrackingTicker } from './TrackingTicker';

export type { TrackedNode } from './TimeEntriesPopover';

/** The clock, the writes and the tick one owning surface shares with its tracking controls. */
export interface TrackingSurface {
  readonly ticker: TrackingTicker;
  readonly actions: TrackingActions;
  readonly context: () => TrackedTimeContext;
}

export interface TimeBadgeOptions extends TrackingSurface {
  /** The positioned surface the sessions popover is placed in, as the date picker uses. */
  readonly popoverOwner: HTMLElement;
  readonly boundary: HTMLElement;
  readonly node: () => TrackedNode | undefined;
}

export interface TimeBadgeHandle {
  /** Places the badge in the chips row of a fresh render, keeping an open popover open. */
  render(host: HTMLElement): void;
  /** Re-reads the selection, which only an index change or a new render can have moved. */
  update(): void;
  destroy(): void;
}

interface BadgeElements {
  readonly badge: HTMLElement;
  readonly body: HTMLButtonElement;
  readonly toggle: HTMLButtonElement;
}

/** Everything the badge repaints from, so a tick never asks the index anything. */
interface BadgeModel {
  readonly total: TrackedTotal;
  readonly runningSinceMs: number | undefined;
  readonly finished: boolean;
}

/** One mounted badge: its elements, the total it paints from, and the popover it owns. */
interface BadgeSession {
  readonly options: TimeBadgeOptions;
  elements: BadgeElements | undefined;
  popover: TimeEntriesPopoverHandle | undefined;
  model: BadgeModel | undefined;
  icon: 'play' | 'pause' | undefined;
  openedAt: string | undefined;
  destroyed: boolean;
}

const FINISHED_TITLE = 'Finished tasks cannot be tracked';
const DEVICE_OFFSET_AT: OffsetAt = (epochMs) => -new Date(epochMs).getTimezoneOffset();

/** The wall clock a surface on this device reads its tracking labels against. */
export function deviceTrackedTimeContext(): TrackedTimeContext {
  return { nowMs: Date.now(), offsetAt: DEVICE_OFFSET_AT };
}

/**
 * Where the node sits, which survives the writes tracking makes. A ref carries the revision it was
 * read at, so it reports every session as a different node; only a move is a different selection.
 */
function nodeAddress(ref: TaskNodeRef): string {
  const path: number[] = [];
  let node = ref;
  while (node.type === 'subtask') {
    path.push(node.ref.relativeLine);
    node = node.ref.parent;
  }
  path.reverse();
  return JSON.stringify([node.ref.filePath, node.ref.line, path]);
}

function badgeModel(node: TrackedNode | undefined): BadgeModel | undefined {
  if (node === undefined) return undefined;
  const total = subtreeTotal(node.snapshot);
  let runningSinceMs: number | undefined;
  for (const startMs of total.openStartsMs) {
    if (runningSinceMs === undefined || startMs < runningSinceMs) runningSinceMs = startMs;
  }
  const { status } = node.snapshot;
  return { total, runningSinceMs, finished: status === 'done' || status === 'cancelled' };
}

function writeText(element: HTMLElement, value: string): void {
  if (element.textContent !== value) element.setText(value);
}

function writeAttribute(element: HTMLElement, name: string, value: string): void {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function paintToggle(session: BadgeSession, view: BadgeElements, model: BadgeModel): void {
  const running = model.runningSinceMs !== undefined;
  const wanted = running ? 'pause' : 'play';
  if (session.icon !== wanted) {
    setIcon(view.toggle, wanted);
    session.icon = wanted;
  }
  writeAttribute(view.toggle, 'aria-label', running ? 'Pause tracking' : 'Start tracking');
  const blocked = model.finished && !running;
  view.toggle.disabled = blocked;
  view.toggle.title = blocked ? FINISHED_TITLE : '';
}

function paint(session: BadgeSession): void {
  const view = session.elements;
  const model = session.model;
  if (view === undefined || model === undefined) return;
  const context = session.options.context();
  const tracked = formatTrackedDuration(totalMs(model.total, context.nowMs));
  writeText(view.body, tracked);
  writeAttribute(view.body, 'aria-label', `Tracked time ${tracked}`);
  writeAttribute(view.body, 'aria-expanded', String(session.popover !== undefined));
  const question =
    model.runningSinceMs === undefined
      ? undefined
      : staleTrackingQuestion(model.runningSinceMs, context);
  view.badge.toggleClass('is-tracking', model.runningSinceMs !== undefined);
  view.badge.toggleClass('is-stale', question !== undefined);
  view.body.title = question ?? '';
  paintToggle(session, view, model);
}

function update(session: BadgeSession): void {
  if (session.destroyed) return;
  const node = session.options.node();
  session.model = badgeModel(node);
  if (
    node === undefined ||
    (session.openedAt !== undefined && session.openedAt !== nodeAddress(node.ref))
  ) {
    session.popover?.close();
  }
  paint(session);
  session.popover?.update();
}

function toggleTracking(session: BadgeSession): void {
  const node = session.options.node();
  if (node === undefined) return;
  const { actions } = session.options;
  runAsyncAction(
    badgeModel(node)?.runningSinceMs === undefined ? actions.start(node.ref) : actions.pause(),
    'Could not change time tracking',
  );
}

function openSessions(session: BadgeSession, view: BadgeElements): void {
  if (session.popover !== undefined) {
    session.popover.close();
    return;
  }
  const node = session.options.node();
  if (node === undefined) return;
  session.openedAt = nodeAddress(node.ref);
  session.popover = showTimeEntriesPopover({
    owner: session.options.popoverOwner,
    anchor: view.body,
    boundary: session.options.boundary,
    node: session.options.node,
    actions: session.options.actions,
    context: session.options.context,
    onClose: (restoreFocus) => {
      session.popover = undefined;
      session.openedAt = undefined;
      paint(session);
      if (restoreFocus && view.body.isConnected) view.body.focus({ preventScroll: true });
    },
  });
  paint(session);
}

function createBadge(session: BadgeSession, host: HTMLElement): BadgeElements {
  const badge = host.createSpan({ cls: 'abyss-chip abyss-time-badge' });
  const body = badge.createEl('button', {
    cls: 'abyss-time-badge-body',
    attr: { type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' },
  });
  const toggle = badge.createEl('button', {
    cls: 'abyss-time-badge-toggle',
    attr: { type: 'button' },
  });
  const view: BadgeElements = { badge, body, toggle };
  body.addEventListener('click', (event) => {
    event.stopPropagation();
    openSessions(session, view);
  });
  toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleTracking(session);
  });
  return view;
}

/**
 * The tracked total of one inspector selection, next to the control that starts and pauses it.
 *
 * The badge outlives a render: the inspector rebuilds its chips row on every index change, so the
 * element and the popover it owns are re-placed rather than rebuilt, the way the inline undo row
 * survives the same render. A tick repaints from the total read at the last index change, so a
 * second costs one addition and, while the displayed minute holds, no DOM write at all.
 */
export function mountTimeBadge(options: TimeBadgeOptions): TimeBadgeHandle {
  const session: BadgeSession = {
    options,
    elements: undefined,
    popover: undefined,
    model: undefined,
    icon: undefined,
    openedAt: undefined,
    destroyed: false,
  };
  const unsubscribe = options.ticker.subscribe(() => {
    paint(session);
    session.popover?.tick();
  });
  return {
    render(host: HTMLElement): void {
      if (session.destroyed) return;
      if (session.elements === undefined) session.elements = createBadge(session, host);
      else host.appendChild(session.elements.badge);
      update(session);
    },
    update(): void {
      update(session);
    },
    destroy(): void {
      if (session.destroyed) return;
      session.destroyed = true;
      unsubscribe();
      session.popover?.close();
      session.elements?.badge.remove();
      session.elements = undefined;
    },
  };
}
