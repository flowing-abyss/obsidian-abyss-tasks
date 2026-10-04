import {
  localDate,
  localDayStartMs,
  shiftLocalDayStartMs,
  type LocalDate,
  type OffsetAt,
} from '../tasks';
import { required, StatisticsCancelled, WorkBudget } from './statisticsWork';
import type { StatisticsDataset, StatisticsRequest, StatisticsWork } from './types';
export const DAY = 86400000,
  HOUR = 3600000;
export interface CalendarSegment {
  readonly startMs: number;
  readonly endMs: number;
  readonly offsetMinutes: number;
}
export interface StatisticsBucket {
  readonly key: string;
  readonly fromDay: number;
  readonly toDay: number;
  readonly startMs: number;
  readonly endMs: number;
}
export interface StatisticsCalendar {
  readonly today: LocalDate;
  readonly todayDay: number;
  readonly fromDate: LocalDate;
  readonly toDate: LocalDate;
  readonly fromDay: number;
  readonly toDay: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly civilEndMs: number;
  readonly buckets: readonly StatisticsBucket[];
  readonly segments: readonly CalendarSegment[];
}
export function dayOf(date: LocalDate): number {
  return Date.parse(`${date}T00:00:00Z`) / DAY;
}
export function dateOf(day: number): LocalDate {
  return localDate(new Date(day * DAY).toISOString().slice(0, 10));
}
function localDay(ms: number, offsetAt: OffsetAt): number {
  return Math.floor((ms + offsetAt(ms) * 60000) / DAY);
}
function weekDay(day: number): number {
  return (((day + 4) % 7) + 7) % 7;
}
export function weekFloor(day: number, first: number): number {
  return day - ((weekDay(day) - first + 7) % 7);
}
export function midnight(day: number, request: StatisticsRequest): number {
  const todayStart = localDayStartMs(request.nowMs, request.offsetAt);
  return shiftLocalDayStartMs(
    todayStart,
    day - localDay(request.nowMs, request.offsetAt),
    request.offsetAt,
  );
}
function monthDay(day: number, delta: number): number {
  const d = new Date(day * DAY);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + delta);
  return d.getTime() / DAY;
}
async function firstDay(
  dataset: StatisticsDataset,
  request: StatisticsRequest,
  today: number,
  budget: WorkBudget,
): Promise<number> {
  let first = today;
  for (const task of dataset.tasks) {
    for (const d of [task.created, task.completion, task.cancelled, task.due])
      if (d !== undefined) first = Math.min(first, dayOf(d));
    await budget.step();
  }
  for (const entry of dataset.entries) {
    if (entry.startMs !== undefined)
      first = Math.min(first, localDay(entry.startMs, request.offsetAt));
    await budget.step();
  }
  return first;
}
function monthsBeforeEnd(today: number, months: number): number {
  const end = new Date((today + 1) * DAY),
    day = end.getUTCDate();
  end.setUTCDate(1);
  end.setUTCMonth(end.getUTCMonth() - months);
  const next = new Date(end.getTime());
  next.setUTCMonth(next.getUTCMonth() + 1);
  next.setUTCDate(0);
  end.setUTCDate(Math.min(day, next.getUTCDate()));
  return end.getTime() / DAY;
}
function presetStart(request: StatisticsRequest, today: number, earliest: number): number {
  const starts: Record<StatisticsRequest['period'], () => number> = {
    today: () => today,
    '7d': () => today - 6,
    '30d': () => today - 29,
    '90d': () => today - 89,
    all: () => earliest,
    week: () => weekFloor(today, request.firstDayOfWeek),
    month: () => monthDay(today, 0),
    '6m': () => monthsBeforeEnd(today, 6),
    '12m': () => monthsBeforeEnd(today, 12),
    year: () => {
      const date = new Date(today * DAY);
      date.setUTCMonth(0, 1);
      return date.getTime() / DAY;
    },
  };
  return starts[request.period]();
}
async function exactTransitions(
  values: readonly number[],
  window: readonly [number, number],
  budget: WorkBudget,
): Promise<number[]> {
  const result: number[] = [];
  let previous = -Infinity;
  for (const value of values) {
    if (!Number.isFinite(value) || value <= previous)
      throw new RangeError('Calendar transitions must be finite and strictly increasing');
    previous = value;
    if (value > window[0] && value < window[1]) result.push(value);
    await budget.step();
  }
  return result;
}
async function transitionInCell(
  window: readonly [number, number],
  offsetAt: OffsetAt,
  budget: WorkBudget,
): Promise<number> {
  let [lo, hi] = window;
  const offset = offsetAt(lo);
  while (hi - lo > 1) {
    const middle = Math.floor((lo + hi) / 2);
    if (offsetAt(middle) === offset) lo = middle;
    else hi = middle;
    await budget.step();
  }
  return hi;
}
async function sampledTransitions(
  window: readonly [number, number],
  request: StatisticsRequest,
  budget: WorkBudget,
): Promise<number[]> {
  const result: number[] = [];
  const grid = 6 * HOUR;
  let a = window[0];
  while (a < window[1]) {
    const b = Math.min(window[1], (Math.floor(a / grid) + 1) * grid);
    if (request.offsetAt(a) !== request.offsetAt(b)) {
      const t = await transitionInCell([a, b], request.offsetAt, budget);
      if (t < window[1]) result.push(t);
    }
    a = b;
    await budget.step();
  }
  return result;
}
async function segments(
  window: readonly [number, number],
  request: StatisticsRequest,
  budget: WorkBudget,
): Promise<CalendarSegment[]> {
  const transitions =
    request.calendarTransitions === undefined
      ? await sampledTransitions(window, request, budget)
      : await exactTransitions(request.calendarTransitions, window, budget);
  const result: CalendarSegment[] = [];
  let a = window[0];
  for (const end of [...transitions, window[1]]) {
    if (end > a) {
      const offset = request.offsetAt(a);
      if (!Number.isFinite(offset)) throw new RangeError('Invalid calendar offset');
      result.push(Object.freeze({ startMs: a, endMs: end, offsetMinutes: offset }));
    }
    a = end;
    await budget.step();
  }
  return result;
}
function nextBucket(day: number, length: number, request: StatisticsRequest): number {
  if (length <= 31) return day + 1;
  if (length <= 120) return weekFloor(day, request.firstDayOfWeek) + 7;
  return monthDay(day, Math.max(1, Math.ceil(length / 28 / 239)));
}
async function buildBuckets(
  window: readonly [number, number],
  request: StatisticsRequest,
  budget: WorkBudget,
): Promise<StatisticsBucket[]> {
  const result: StatisticsBucket[] = [];
  let a = window[0];
  while (a < window[1]) {
    const end = Math.min(window[1], nextBucket(a, window[1] - window[0], request));
    result.push(
      Object.freeze({
        key: dateOf(a),
        fromDay: a,
        toDay: end,
        startMs: midnight(a, request),
        endMs: Math.min(midnight(end, request), request.nowMs),
      }),
    );
    a = end;
    await budget.step();
  }
  return result;
}
function validateRequest(request: StatisticsRequest): void {
  if (
    !Number.isFinite(request.nowMs) ||
    !Number.isInteger(request.firstDayOfWeek) ||
    request.firstDayOfWeek < 0 ||
    request.firstDayOfWeek > 6
  )
    throw new RangeError('Invalid Statistics calendar request');
}
export async function prepareCalendar(
  dataset: StatisticsDataset,
  request: StatisticsRequest,
  work: StatisticsWork,
): Promise<StatisticsCalendar | undefined> {
  const budget = new WorkBudget(work);
  try {
    budget.check();
    validateRequest(request);
    const todayDay = localDay(request.nowMs, request.offsetAt);
    const earliest =
      request.period === 'all' ? await firstDay(dataset, request, todayDay, budget) : todayDay;
    const fromDay = presetStart(request, todayDay, earliest),
      toDay = todayDay + 1,
      startMs = midnight(fromDay, request),
      civilEndMs = midnight(toDay, request),
      endMs = Math.min(civilEndMs, request.nowMs);
    const buckets = await buildBuckets([fromDay, toDay], request, budget);
    return Object.freeze({
      today: dateOf(todayDay),
      todayDay,
      fromDate: dateOf(fromDay),
      toDate: dateOf(toDay),
      fromDay,
      toDay,
      startMs,
      endMs,
      civilEndMs,
      buckets: Object.freeze(buckets),
      segments: Object.freeze(await segments([startMs, endMs], request, budget)),
    });
  } catch (error) {
    if (error instanceof StatisticsCancelled) return undefined;
    throw error;
  }
}
export function bucketAt(calendar: StatisticsCalendar, day: number): number {
  let low = 0,
    high = calendar.buckets.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (required(calendar.buckets[mid]).toDay <= day) low = mid + 1;
    else high = mid;
  }
  return low < calendar.buckets.length && day >= calendar.fromDay ? low : -1;
}
