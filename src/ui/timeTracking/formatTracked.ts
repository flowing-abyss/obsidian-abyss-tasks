import {
  localDayStartMs,
  shiftLocalDayStartMs,
  type OffsetAt,
  type TimeEntrySnapshot,
} from '../../tasks';

/**
 * Elapsed time in the compact style the task line and the inspector duration chip already use.
 * The rule itself belongs to the task domain, because the project table reads the same label and
 * must not reach into presentation for it. Tracking surfaces keep importing it from here.
 */
export { formatTrackedDuration } from '../../tasks';

/**
 * The same total said as what it added, `+1h 16m`. Only the two tracking popovers speak this way,
 * because they are opened to look at time already earned. The badges, the rail number and the
 * project table report a plain amount and keep the domain formatter as it is.
 */
export function formatTrackedGain(label: string): string {
  return `+${label}`;
}

/** The wall-clock context every tracking label is read against, supplied by the owning surface. */
export interface TrackedTimeContext {
  readonly nowMs: number;
  readonly offsetAt: OffsetAt;
}

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/** A timer left running this long is more likely forgotten than real, so it gets questioned. */
const STALE_TRACKING_MS = 12 * MS_PER_HOUR;

/**
 * Calendar labels are fixed English short names, the same `ddd D MMM` shape the date chips render.
 * A locale-aware formatter cannot produce it: every English locale but `en-GB` inserts a comma,
 * and ICU abbreviates September as `Sept`.
 */
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** The local wall clock of an instant, read as if the wall clock itself were UTC. */
function wallMs(epochMs: number, offsetAt: OffsetAt): number {
  return epochMs + offsetAt(epochMs) * MS_PER_MINUTE;
}

/** The `HH:MM` the wall clock showed at an instant. */
function clockLabel(epochMs: number, offsetAt: OffsetAt): string {
  const dayMs = ((wallMs(epochMs, offsetAt) % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY;
  const hours = Math.floor(dayMs / MS_PER_HOUR);
  return `${pad2(hours)}:${pad2(Math.floor((dayMs % MS_PER_HOUR) / MS_PER_MINUTE))}`;
}

/** `16 Sep`, optionally opened by the weekday, read off the shifted instant as if it were UTC. */
function calendarLabel(dayStartMs: number, offsetAt: OffsetAt, weekday: boolean): string {
  const value = new Date(wallMs(dayStartMs, offsetAt));
  const date = `${value.getUTCDate()} ${MONTHS[value.getUTCMonth()] as string}`;
  return weekday ? `${WEEKDAYS[value.getUTCDay()] as string} ${date}` : date;
}

/** `Today`, `Yesterday`, or the weekday and calendar date of an older local day. */
export function formatDayHeading(dayStartMs: number, context: TrackedTimeContext): string {
  const todayStartMs = localDayStartMs(context.nowMs, context.offsetAt);
  if (dayStartMs === todayStartMs) return 'Today';
  if (dayStartMs === shiftLocalDayStartMs(todayStartMs, -1, context.offsetAt)) return 'Yesterday';
  return calendarLabel(dayStartMs, context.offsetAt, true);
}

/**
 * One session as a wall-clock span, `09:12 → 10:32`. A running session stays open after the arrow,
 * and a session that crossed a midnight still shows two times only, because the day it belongs to
 * is the heading it is listed under.
 *
 * A broken entry carries no usable instants and so has no span, which this reports as the empty
 * string. Callers must branch on `entry.state === 'broken'` and render their own explanation
 * rather than hand a reader a blank line.
 */
export function formatSessionClockRange(
  entry: TimeEntrySnapshot,
  context: TrackedTimeContext,
): string {
  const { offsetAt } = context;
  if (entry.state === 'broken' || entry.startMs === undefined) return '';
  const opening = clockLabel(entry.startMs, offsetAt);
  if (entry.state === 'running' || entry.endMs === undefined) return `${opening} →`;
  return `${opening} → ${clockLabel(entry.endMs, offsetAt)}`;
}

/** The question a long-running timer earns, or nothing while it is still plausibly real. */
export function staleTrackingQuestion(
  startMs: number,
  context: TrackedTimeContext,
): string | undefined {
  if (context.nowMs - startMs < STALE_TRACKING_MS) return undefined;
  const { offsetAt } = context;
  const clock = clockLabel(startMs, offsetAt);
  const startDayMs = localDayStartMs(startMs, offsetAt);
  const todayStartMs = localDayStartMs(context.nowMs, offsetAt);
  if (startDayMs === todayStartMs) return `Still tracking since ${clock}?`;
  const day =
    startDayMs === shiftLocalDayStartMs(todayStartMs, -1, offsetAt)
      ? 'yesterday'
      : calendarLabel(startDayMs, offsetAt, false);
  return `Still tracking since ${day} at ${clock}?`;
}
