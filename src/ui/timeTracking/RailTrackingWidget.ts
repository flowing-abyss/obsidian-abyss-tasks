import { setIcon } from 'obsidian';
import {
  groupTrackedDays,
  localDayStartMs,
  resumeTarget,
  shiftLocalDayStartMs,
  taskNodeAddress,
  type TaskNodeRef,
  type TaskQueryApi,
  type TimeTrackingQueryApi,
  type TrackedDay,
  type TrackedEntry,
} from '../../tasks';
import { runAsyncAction } from '../runAsyncAction';
import {
  formatTrackedClock,
  staleTrackingQuestion,
  type TrackedTimeContext,
} from './formatTracked';
import { showTrackedTasksPopover, type TrackedTasksPopoverHandle } from './TrackedTasksPopover';
import type { TrackingActions } from './trackingActions';
import type { TrackingTicker } from './TrackingTicker';

export interface RailTrackingWidgetOptions {
  /** The element the rail keeps alive across its own renders, which the widget fills. */
  readonly host: HTMLElement;
  readonly popoverOwner: HTMLElement;
  readonly boundary: HTMLElement;
  readonly queries: TimeTrackingQueryApi & Pick<TaskQueryApi, 'subscribe'>;
  readonly ticker: TrackingTicker;
  readonly actions: TrackingActions;
  readonly openTask: (target: TaskNodeRef) => void;
  readonly context: () => TrackedTimeContext;
  readonly win: Window;
}

export interface RailTrackingWidgetHandle {
  destroy(): void;
}

const WINDOW_DAYS = 7;
const NO_RESUME_TITLE = 'The last tracked task is already finished';
const TASK_TITLE = 'Tracked on this task today';
const DAY_TITLE = 'Tracked today';
const TODAY_CAPTION = 'TODAY';

interface WidgetElements {
  readonly toggle: HTMLButtonElement;
  readonly task: HTMLButtonElement;
  readonly hours: HTMLElement;
  readonly minutes: HTMLElement;
  readonly day: HTMLButtonElement;
}

/**
 * Everything a tick repaints from, so a second never asks the index anything. The totals are read
 * at the instant `anchorMs` names, and the open timer is the only thing that can have moved since.
 */
interface WidgetModel {
  readonly anchorMs: number;
  readonly days: readonly TrackedDay[];
  /** The node the widget speaks for: the running one, else the one tracked most recently. */
  readonly current: TrackedEntry | undefined;
  readonly taskBaseMs: number;
  readonly dayBaseMs: number;
  /** When the open timer began counting towards today, absent while nothing runs. */
  readonly openSinceMs: number | undefined;
  readonly empty: boolean;
}

/** One mounted widget: its elements, the totals it paints from, and the popover it owns. */
interface WidgetSession {
  readonly options: RailTrackingWidgetOptions;
  elements: WidgetElements | undefined;
  popover: TrackedTasksPopoverHandle | undefined;
  model: WidgetModel | undefined;
  icon: 'play' | 'pause' | undefined;
  /** The local day the pending rollover was scheduled for, with the timer that will announce it. */
  midnight: { readonly dayStartMs: number; readonly id: number } | undefined;
  unsubscribeIndex: () => void;
  unsubscribeTick: () => void;
  destroyed: boolean;
}

function writeText(element: HTMLElement, value: string): void {
  if (element.textContent !== value) element.setText(value);
}

function writeAttribute(element: HTMLElement, name: string, value: string): void {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function writeTitle(element: HTMLElement, value: string): void {
  if (element.title !== value) element.title = value;
}

function writeClass(element: HTMLElement, name: string, present: boolean): void {
  if (element.classList.contains(name) !== present) element.toggleClass(name, present);
}

/** A finished task cannot be picked up again, so it is no resume target at all. */
function resumable(entry: TrackedEntry | undefined): boolean {
  return entry !== undefined && entry.status !== 'done' && entry.status !== 'cancelled';
}

/** Today's grouping, which the newest day is only while the window actually ends on it. */
function todayOf(days: readonly TrackedDay[], todayStartMs: number): TrackedDay | undefined {
  const newest = days[0];
  return newest?.dayStartMs === todayStartMs ? newest : undefined;
}

/** What the current node has earned today, which is nothing at all until it has a row. */
function currentTodayMs(today: TrackedDay | undefined, current: TrackedEntry | undefined): number {
  if (today === undefined || current === undefined) return 0;
  const address = taskNodeAddress(current.target);
  return today.rows.find((row) => row.key === address)?.trackedMs ?? 0;
}

/** When the open timer began counting towards today, absent while nothing runs. */
function openTimerSinceMs(
  current: TrackedEntry | undefined,
  todayStartMs: number,
): number | undefined {
  const { entry } = current ?? {};
  if (entry?.state !== 'running' || entry.startMs === undefined) return undefined;
  return Math.max(entry.startMs, todayStartMs);
}

/** The seven-day window of entries, grouped into days and reduced to the two numbers on the rail. */
function readModel(options: RailTrackingWidgetOptions, context: TrackedTimeContext): WidgetModel {
  const { nowMs, offsetAt } = context;
  const todayStartMs = localDayStartMs(nowMs, offsetAt);
  const entries = options.queries.entriesOverlapping(
    shiftLocalDayStartMs(todayStartMs, 1 - WINDOW_DAYS, offsetAt),
    shiftLocalDayStartMs(todayStartMs, 1, offsetAt),
  );
  const days = groupTrackedDays(entries, { nowMs, offsetAt, days: WINDOW_DAYS });
  const today = todayOf(days, todayStartMs);
  const current = resumeTarget(entries);
  return {
    anchorMs: nowMs,
    days,
    current,
    taskBaseMs: currentTodayMs(today, current),
    dayBaseMs: today?.totalMs ?? 0,
    openSinceMs: openTimerSinceMs(current, todayStartMs),
    empty: entries.length === 0,
  };
}

/** What the open timer has added since the totals were read, which is all a second can change. */
function runningExtraMs(model: WidgetModel, nowMs: number): number {
  if (model.openSinceMs === undefined) return 0;
  return Math.max(0, nowMs - Math.max(model.anchorMs, model.openSinceMs));
}

/** What the toggle will do next, or why there is nothing left for it to pick up. */
function toggleLabel(model: WidgetModel, running: boolean, blocked: boolean): string {
  if (blocked || model.current === undefined) return NO_RESUME_TITLE;
  return `${running ? 'Pause' : 'Resume'} ${model.current.title}`;
}

/** The question a timer left running half a day earns, asked on the control that would stop it. */
function toggleQuestion(model: WidgetModel, context: TrackedTimeContext): string | undefined {
  const startMs = model.current?.entry.startMs;
  if (model.openSinceMs === undefined || startMs === undefined) return undefined;
  return staleTrackingQuestion(startMs, context);
}

function paintToggle(
  session: WidgetSession,
  view: WidgetElements,
  model: WidgetModel,
  context: TrackedTimeContext,
): void {
  const running = model.openSinceMs !== undefined;
  const wanted = running ? 'pause' : 'play';
  if (session.icon !== wanted) {
    setIcon(view.toggle, wanted);
    session.icon = wanted;
  }
  const blocked = !running && !resumable(model.current);
  const label = toggleLabel(model, running, blocked);
  const question = toggleQuestion(model, context);
  writeAttribute(view.toggle, 'aria-label', label);
  // The question replaces the tooltip but never the accessible name, so a reader still hears which
  // task the control acts on.
  writeTitle(view.toggle, question ?? label);
  writeClass(view.toggle, 'is-active', running);
  writeClass(session.options.host, 'is-stale', question !== undefined);
  if (view.toggle.disabled !== blocked) view.toggle.disabled = blocked;
}

function paint(session: WidgetSession): void {
  const view = session.elements;
  const model = session.model;
  if (view === undefined || model === undefined) return;
  // One reading of the clock per frame, so the two numbers and the toggle cannot disagree.
  const context = session.options.context();
  const extraMs = runningExtraMs(model, context.nowMs);
  const [hours = '0', minutes = '00'] = formatTrackedClock(model.taskBaseMs + extraMs).split(':');
  writeText(view.hours, hours);
  writeText(view.minutes, minutes);
  writeText(view.day, formatTrackedClock(model.dayBaseMs + extraMs));
  writeClass(session.options.host, 'is-tracking', model.openSinceMs !== undefined);
  paintToggle(session, view, model, context);
}

function openCurrentTask(session: WidgetSession): void {
  const target = session.model?.current?.target;
  if (target !== undefined) session.options.openTask(target);
}

function toggleTracking(session: WidgetSession): void {
  const model = session.model;
  if (model === undefined) return;
  const { actions } = session.options;
  if (model.openSinceMs !== undefined) {
    runAsyncAction(actions.pause(), 'Could not change time tracking');
    return;
  }
  const { current } = model;
  if (current === undefined || !resumable(current)) return;
  runAsyncAction(actions.start(current.target), 'Could not change time tracking');
}

function openDays(session: WidgetSession, view: WidgetElements): void {
  if (session.popover !== undefined) {
    session.popover.close();
    return;
  }
  session.popover = showTrackedTasksPopover({
    owner: session.options.popoverOwner,
    anchor: view.day,
    boundary: session.options.boundary,
    days: () => session.model?.days ?? [],
    runningExtraMs: () =>
      session.model === undefined
        ? 0
        : runningExtraMs(session.model, session.options.context().nowMs),
    context: session.options.context,
    actions: session.options.actions,
    openTask: session.options.openTask,
    onClose: (restoreFocus) => {
      session.popover = undefined;
      writeAttribute(view.day, 'aria-expanded', 'false');
      if (restoreFocus && view.day.isConnected) view.day.focus({ preventScroll: true });
    },
  });
  writeAttribute(view.day, 'aria-expanded', 'true');
}

function createElements(session: WidgetSession): WidgetElements {
  const { host } = session.options;
  const toggle = host.createEl('button', {
    cls: 'abyss-rail-btn abyss-rail-tracking-toggle',
    attr: { type: 'button' },
  });
  const task = host.createEl('button', {
    cls: 'abyss-rail-tracking-task',
    attr: { type: 'button', 'aria-label': TASK_TITLE, title: TASK_TITLE },
  });
  const hours = task.createSpan({ cls: 'abyss-rail-tracking-hours' });
  task.createSpan({ cls: 'abyss-rail-tracking-colon', text: ':' });
  const minutes = task.createSpan({ cls: 'abyss-rail-tracking-minutes' });
  host.createSpan({ cls: 'abyss-rail-tracking-rule', attr: { 'aria-hidden': 'true' } });
  const day = host.createEl('button', {
    cls: 'abyss-rail-tracking-day',
    attr: {
      type: 'button',
      'aria-label': DAY_TITLE,
      title: DAY_TITLE,
      'aria-haspopup': 'dialog',
      'aria-expanded': 'false',
    },
  });
  host.createSpan({ cls: 'abyss-rail-tracking-caption', text: TODAY_CAPTION });
  const view: WidgetElements = { toggle, task, hours, minutes, day };
  toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleTracking(session);
  });
  task.addEventListener('click', (event) => {
    event.stopPropagation();
    openCurrentTask(session);
  });
  day.addEventListener('click', (event) => {
    event.stopPropagation();
    openDays(session, view);
  });
  return view;
}

/** A rail with nothing to report looks exactly as it did before time tracking existed. */
function clearWidget(session: WidgetSession): void {
  session.popover?.close(false);
  session.elements = undefined;
  session.icon = undefined;
  session.options.host.empty();
  session.options.host.hidden = true;
  writeClass(session.options.host, 'is-tracking', false);
  writeClass(session.options.host, 'is-stale', false);
}

/** One timer per local day, which is the only thing that moves a total without an index event. */
function scheduleMidnight(session: WidgetSession, context: TrackedTimeContext): void {
  const { nowMs, offsetAt } = context;
  const dayStartMs = localDayStartMs(nowMs, offsetAt);
  if (session.midnight?.dayStartMs === dayStartMs) return;
  const { win } = session.options;
  if (session.midnight !== undefined) win.clearTimeout(session.midnight.id);
  const nextMs = shiftLocalDayStartMs(dayStartMs, 1, offsetAt);
  const id = win.setTimeout(
    () => {
      session.midnight = undefined;
      refresh(session);
    },
    Math.max(0, nextMs - nowMs),
  );
  session.midnight = { dayStartMs, id };
}

function refresh(session: WidgetSession): void {
  if (session.destroyed) return;
  const context = session.options.context();
  const model = readModel(session.options, context);
  session.model = model;
  if (model.empty) {
    clearWidget(session);
    scheduleMidnight(session, context);
    return;
  }
  session.options.host.hidden = false;
  session.elements ??= createElements(session);
  paint(session);
  session.popover?.update();
  scheduleMidnight(session, context);
}

/**
 * The always-visible face of time tracking: what is running, how long today's task has taken, and
 * how long the whole day has.
 *
 * The seven-day window is regrouped only when the index reports a change or the local day rolls
 * over. A second adds the open timer's own elapsed time to the two totals already in hand and
 * writes to the DOM only when the displayed minute turns over, so an idle rail costs nothing.
 */
export function mountRailTrackingWidget(
  options: RailTrackingWidgetOptions,
): RailTrackingWidgetHandle {
  const session: WidgetSession = {
    options,
    elements: undefined,
    popover: undefined,
    model: undefined,
    icon: undefined,
    midnight: undefined,
    unsubscribeIndex: () => {},
    unsubscribeTick: () => {},
    destroyed: false,
  };
  refresh(session);
  session.unsubscribeIndex = options.queries.subscribe(() => {
    refresh(session);
  });
  session.unsubscribeTick = options.ticker.subscribe(() => {
    paint(session);
    session.popover?.tick();
  });
  return {
    destroy(): void {
      if (session.destroyed) return;
      session.destroyed = true;
      session.unsubscribeIndex();
      session.unsubscribeTick();
      if (session.midnight !== undefined) options.win.clearTimeout(session.midnight.id);
      session.midnight = undefined;
      session.popover?.close(false);
      session.elements = undefined;
      options.host.empty();
    },
  };
}
