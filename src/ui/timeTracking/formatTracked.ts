import {
  localDayStartMs,
  shiftLocalDayStartMs,
  type OffsetAt,
  type TimeEntrySnapshot,
} from '../../tasks';

/** The wall-clock context every tracking label is read against, supplied by the owning surface. */
interface TrackedTimeContext {
  readonly nowMs: number;
  readonly offsetAt: OffsetAt;
  readonly locale: string;
}

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/** A timer left running this long is more likely forgotten than real, so it gets questioned. */
const STALE_TRACKING_MS = 12 * MS_PER_HOUR;

/**
 * Constructing an `Intl.DateTimeFormat` costs far more than formatting with one, and these labels
 * are re-rendered on every tick, so one formatter per locale and shape is kept for the session.
 */
const CALENDAR_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function calendarFormatter(locale: string, weekday: boolean): Intl.DateTimeFormat {
  const key = `${weekday ? 'w' : 'd'}:${locale}`;
  const cached = CALENDAR_FORMATTERS.get(key);
  if (cached !== undefined) return cached;
  const created = new Intl.DateTimeFormat(locale, {
    ...(weekday ? { weekday: 'short' as const } : {}),
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
  CALENDAR_FORMATTERS.set(key, created);
  return created;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** Part-minutes have not been earned yet, so every total floors to whole minutes. */
function wholeMinutes(ms: number): number {
  return Math.floor(Math.max(0, ms) / MS_PER_MINUTE);
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

/** The locale's short calendar label for a local day, formatted off the shifted instant. */
function calendarLabel(dayStartMs: number, context: TrackedTimeContext, weekday: boolean): string {
  return calendarFormatter(context.locale, weekday).format(wallMs(dayStartMs, context.offsetAt));
}

/** Elapsed time as a sentence fragment, matching the duration style task lines already use. */
export function formatTrackedDuration(ms: number): string {
  const minutes = wholeMinutes(ms);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours > 0 && rest > 0) return `${hours}h ${rest}m`;
  return hours > 0 ? `${hours}h` : `${rest}m`;
}

/** Elapsed time as a compact clock, for the places a badge has room for digits only. */
export function formatTrackedClock(ms: number): string {
  const minutes = wholeMinutes(ms);
  return `${Math.floor(minutes / 60)}:${pad2(minutes % 60)}`;
}

/** Elapsed time down to the second, for the surface that repaints every second. */
export function formatTrackedTicker(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${Math.floor(seconds / 3600)}:${pad2(minutes)}:${pad2(seconds % 60)}`;
}

/** `Today`, `Yesterday`, or the locale's short calendar label for an older local day. */
export function formatDayHeading(dayStartMs: number, context: TrackedTimeContext): string {
  const todayStartMs = localDayStartMs(context.nowMs, context.offsetAt);
  if (dayStartMs === todayStartMs) return 'Today';
  if (dayStartMs === shiftLocalDayStartMs(todayStartMs, -1, context.offsetAt)) return 'Yesterday';
  return calendarLabel(dayStartMs, context, true);
}

/**
 * One session as a day and a wall-clock span. The day is repeated on the end only when the
 * session crossed a midnight, and a running session simply stays open after the arrow.
 *
 * A broken entry carries no usable instants, so there is no span to show for it.
 */
export function formatSessionRange(entry: TimeEntrySnapshot, context: TrackedTimeContext): string {
  const { offsetAt } = context;
  if (entry.state === 'broken' || entry.startMs === undefined) return '';
  const startDayMs = localDayStartMs(entry.startMs, offsetAt);
  const opening = `${formatDayHeading(startDayMs, context)} ${clockLabel(entry.startMs, offsetAt)}`;
  if (entry.state === 'running' || entry.endMs === undefined) return `${opening} →`;
  const endDayMs = localDayStartMs(entry.endMs, offsetAt);
  const endClock = clockLabel(entry.endMs, offsetAt);
  const ending =
    endDayMs === startDayMs ? endClock : `${formatDayHeading(endDayMs, context)} ${endClock}`;
  return `${opening} → ${ending}`;
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
      : calendarLabel(startDayMs, context, false);
  return `Still tracking since ${day} at ${clock}?`;
}
