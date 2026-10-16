import {
  taskOccupiedDates,
  taskOccurrenceCompletion,
  type LocalDate,
  type TaskOccurrenceCompletion,
  type TaskSnapshot,
} from '../tasks';
import type { CalendarOccurrence } from './calendarOccurrences';

export interface CalendarDaySource {
  readonly task: TaskSnapshot;
  readonly occurrence: CalendarOccurrence;
}
export interface CalendarDayEntry extends CalendarDaySource {
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

function addEntry(bucket: DayBucket | undefined, date: LocalDate, source: CalendarDaySource): void {
  if (bucket === undefined || bucket.keys.has(source.occurrence.key)) return;
  bucket.keys.add(source.occurrence.key);
  bucket.entries.push(
    Object.freeze({
      task: source.task,
      occurrence: source.occurrence,
      key: source.occurrence.key,
      completion: Object.freeze(taskOccurrenceCompletion(source.occurrence.planning, date)),
    }),
  );
}

function addInterval(
  buckets: ReadonlyMap<LocalDate, DayBucket>,
  source: CalendarDaySource,
  start: LocalDate,
  due: LocalDate,
): void {
  for (const [date, bucket] of buckets) {
    if (start <= date && date <= due) addEntry(bucket, date, source);
  }
}

function addSource(buckets: ReadonlyMap<LocalDate, DayBucket>, source: CalendarDaySource): void {
  const { occurrence } = source;
  const occupied =
    occurrence.kind === 'materialized'
      ? occurrence.occupied
      : taskOccupiedDates(occurrence.planning);
  if (occupied.kind === 'interval') addInterval(buckets, source, occupied.start, occupied.due);
  else if (occupied.kind === 'point') addEntry(buckets.get(occupied.date), occupied.date, source);
  else {
    for (const { date } of occupied.points) addEntry(buckets.get(date), date, source);
  }
}

/** Groups canonical occurrences only on the supplied visible dates, retaining display identity. */
export function buildCalendarDayModel(
  sources: readonly CalendarDaySource[],
  visibleDates: readonly LocalDate[],
): ReadonlyMap<LocalDate, CalendarDaySummary> {
  const buckets = new Map<LocalDate, DayBucket>();
  for (const date of visibleDates) buckets.set(date, { entries: [], keys: new Set() });
  for (const source of sources) addSource(buckets, source);
  const model = new Map<LocalDate, CalendarDaySummary>();
  for (const [date, bucket] of buckets) {
    const entries = Object.freeze(bucket.entries);
    const count = entries.length;
    const dots = Math.min(count, 3) as 0 | 1 | 2 | 3;
    model.set(date, Object.freeze({ date, entries, count, dots, overflow: count > 3 }));
  }
  return model;
}
