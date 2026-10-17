import {
  taskOccupiedDates,
  taskOccurrenceCompletion,
  type LocalDate,
  type TaskOccurrenceCompletion,
} from '../tasks';
import type { CalendarOccurrence } from './calendarOccurrences';

export interface CalendarDayEntry {
  readonly occurrence: CalendarOccurrence;
  readonly key: string;
  readonly completion: TaskOccurrenceCompletion;
}
export interface CalendarDaySummary {
  readonly date: LocalDate;
  readonly entries: readonly CalendarDayEntry[];
  readonly count: number;
  readonly dots: 0 | 1 | 2 | 3;
  readonly overflow: boolean;
}

interface DayBucket {
  readonly entries: CalendarDayEntry[];
  readonly keys: Set<string>;
}

function addEntry(
  bucket: DayBucket | undefined,
  date: LocalDate,
  occurrence: CalendarOccurrence,
): void {
  if (bucket === undefined || bucket.keys.has(occurrence.key)) return;
  bucket.keys.add(occurrence.key);
  bucket.entries.push(
    Object.freeze({
      occurrence,
      key: occurrence.key,
      completion: Object.freeze(taskOccurrenceCompletion(occurrence.planning, date)),
    }),
  );
}

function addInterval(
  buckets: ReadonlyMap<LocalDate, DayBucket>,
  occurrence: CalendarOccurrence,
  start: LocalDate,
  due: LocalDate,
): void {
  for (const [date, bucket] of buckets) {
    if (start <= date && date <= due) addEntry(bucket, date, occurrence);
  }
}

function addSource(
  buckets: ReadonlyMap<LocalDate, DayBucket>,
  occurrence: CalendarOccurrence,
): void {
  const occupied =
    occurrence.kind === 'materialized'
      ? occurrence.occupied
      : taskOccupiedDates(occurrence.planning);
  if (occupied.kind === 'interval') addInterval(buckets, occurrence, occupied.start, occupied.due);
  else if (occupied.kind === 'point')
    addEntry(buckets.get(occupied.date), occupied.date, occurrence);
  else {
    for (const { date } of occupied.points) addEntry(buckets.get(date), date, occurrence);
  }
}

/** Groups canonical occurrences only on the supplied visible dates, retaining source identity. */
export function buildCalendarDayModel(
  occurrences: readonly CalendarOccurrence[],
  visibleDates: readonly LocalDate[],
): ReadonlyMap<LocalDate, CalendarDaySummary> {
  const buckets = new Map<LocalDate, DayBucket>();
  for (const date of visibleDates) buckets.set(date, { entries: [], keys: new Set() });
  for (const occurrence of occurrences) addSource(buckets, occurrence);
  const model = new Map<LocalDate, CalendarDaySummary>();
  for (const [date, bucket] of buckets) {
    const entries = Object.freeze(bucket.entries);
    const count = entries.length;
    const dots = Math.min(count, 3) as 0 | 1 | 2 | 3;
    model.set(date, Object.freeze({ date, entries, count, dots, overflow: count > 3 }));
  }
  return model;
}
