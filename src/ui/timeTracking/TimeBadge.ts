import { setIcon } from 'obsidian';
import {
  localDayStartMs,
  subtreeTotal,
  taskNodeAddress,
  totalMs,
  type OffsetAt,
  type TrackedEntry,
  type TrackedTotal,
} from '../../tasks';
import { writeAttribute, writeClass, writeText, writeTitle } from '../guardedDomWrites';
import type { InteractionOwnershipPort } from '../interactionOwnership';
import { runAsyncAction } from '../runAsyncAction';
import {
  formatTrackedDuration,
  staleTrackingQuestion,
  type TrackedTimeContext,
} from './formatTracked';
import {
  showTimeEntriesPopover,
  trackedNodeKey,
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
  /** Passed to the sessions list, which holds the panel shortcuts while it is open. */
  readonly ownership?: InteractionOwnershipPort | undefined;
}

export interface TimeBadgeHandle {
  /** Places the badge in the chips row of a fresh render, keeping an open popover open. */
  render(host: HTMLElement): void;
  /** Re-reads the selection, which only an index change or a new render can have moved. */
  update(): void;
  /** Dismisses the sessions popover, for an owner tearing its surfaces down. Idempotent. */
  closePopover(): void;
  destroy(): void;
}

interface BadgeElements {
  readonly badge: HTMLElement;
  readonly body: HTMLButtonElement;
  readonly toggle: HTMLButtonElement;
}

/**
 * Everything the badge repaints from, so a tick never asks the index anything. It is keyed by the
 * node's lines and by the local day, which is all that can change what the badge says.
 */
interface BadgeModel {
  readonly key: string;
  readonly dayStartMs: number;
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
  /**
   * The active entries of the last tick, so an emit carrying a new set is recognised as the shared
   * ticker's own index notification and left to the owner, which re-reads the selection anyway.
   */
  active: readonly TrackedEntry[] | undefined;
  destroyed: boolean;
}

const FINISHED_TITLE = 'Finished tasks cannot be tracked';
const DEVICE_OFFSET_AT: OffsetAt = (epochMs) => -new Date(epochMs).getTimezoneOffset();

/** The wall clock a surface on this device reads its tracking labels against. */
export function deviceTrackedTimeContext(): TrackedTimeContext {
  return { nowMs: Date.now(), offsetAt: DEVICE_OFFSET_AT };
}

/**
 * The model of the current selection, walked again only when the node's own lines changed or the
 * local day rolled over. An index change in another file leaves both alone, so it costs one string
 * comparison instead of a walk of the subtree.
 */
function readModel(
  session: BadgeSession,
  node: TrackedNode,
  context: TrackedTimeContext,
): BadgeModel {
  const dayStartMs = localDayStartMs(context.nowMs, context.offsetAt);
  const key = trackedNodeKey(node);
  const cached = session.model;
  if (cached?.key === key && cached.dayStartMs === dayStartMs) return cached;
  const total = subtreeTotal(node.snapshot);
  let runningSinceMs: number | undefined;
  for (const startMs of total.openStartsMs) {
    if (runningSinceMs === undefined || startMs < runningSinceMs) runningSinceMs = startMs;
  }
  const { status } = node.snapshot;
  return {
    key,
    dayStartMs,
    total,
    runningSinceMs,
    finished: status === 'done' || status === 'cancelled',
  };
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
  if (view.toggle.disabled !== blocked) view.toggle.disabled = blocked;
  writeTitle(view.toggle, blocked ? FINISHED_TITLE : '');
}

function paint(session: BadgeSession, context = session.options.context()): void {
  const view = session.elements;
  const model = session.model;
  if (view === undefined || model === undefined) return;
  const tracked = formatTrackedDuration(totalMs(model.total, context.nowMs));
  writeText(view.body, tracked);
  writeAttribute(view.body, 'aria-label', `Tracked time ${tracked}`);
  writeAttribute(view.body, 'aria-expanded', String(session.popover !== undefined));
  const question =
    model.runningSinceMs === undefined
      ? undefined
      : staleTrackingQuestion(model.runningSinceMs, context);
  writeClass(view.badge, 'is-tracking', model.runningSinceMs !== undefined);
  writeClass(view.badge, 'is-stale', question !== undefined);
  writeTitle(view.body, question ?? '');
  paintToggle(session, view, model);
}

function update(session: BadgeSession): void {
  if (session.destroyed) return;
  const node = session.options.node();
  session.model =
    node === undefined ? undefined : readModel(session, node, session.options.context());
  if (
    node === undefined ||
    (session.openedAt !== undefined && session.openedAt !== taskNodeAddress(node.ref))
  ) {
    session.popover?.close(false);
  }
  paint(session);
  session.popover?.update();
}

function toggleTracking(session: BadgeSession): void {
  const node = session.options.node();
  if (node === undefined) return;
  const { actions } = session.options;
  const running = readModel(session, node, session.options.context()).runningSinceMs !== undefined;
  runAsyncAction(
    running ? actions.pause() : actions.start(node.ref),
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
  session.openedAt = taskNodeAddress(node.ref);
  session.popover = showTimeEntriesPopover({
    owner: session.options.popoverOwner,
    anchor: view.body,
    boundary: session.options.boundary,
    node: session.options.node,
    actions: session.options.actions,
    context: session.options.context,
    ownership: session.options.ownership,
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
    active: undefined,
    destroyed: false,
  };
  const unsubscribe = options.ticker.subscribe((state) => {
    // The shared ticker emits on index changes too, and it emits first. Those frames belong to the
    // owner, which re-renders the badge from the new selection; painting them here as well would
    // show the model the change replaced for an instant and write the badge twice for one change.
    const sameActive = session.active === state.active;
    session.active = state.active;
    if (!sameActive) return;
    // One read of the clock serves the whole frame, so a second still costs the badge one call.
    const context = session.options.context();
    paint(session, context);
    // The second that crosses local midnight renames every heading the open popover shows, and no
    // index event has to arrive for that, so the tick that notices the new day rebuilds the list.
    if (
      session.model !== undefined &&
      localDayStartMs(context.nowMs, context.offsetAt) !== session.model.dayStartMs
    ) {
      update(session);
      return;
    }
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
    closePopover(): void {
      session.popover?.close(false);
    },
    destroy(): void {
      if (session.destroyed) return;
      session.destroyed = true;
      unsubscribe();
      session.popover?.close(false);
      session.elements?.badge.remove();
      session.elements = undefined;
    },
  };
}
