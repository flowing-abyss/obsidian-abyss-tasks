import { stableSortSteps, type CollectionSteps } from '../../collectionSteps';
import type { TaskSearchOccurrence } from '../../task-lists/taskSearchOrganization';
import {
  daysBetweenLocalDates,
  localDate,
  shiftLocalDate,
  taskOccupiedDates,
  type LocalDate,
  type TaskOrganizationRecord,
} from '../../tasks';
import type { RowAnchorKeyRange, RowViewportSource } from '../virtualization/rowViewport';
import type { TaskListRow, TaskListRows } from './taskListRows';
import {
  normalizeOccurrenceRanges,
  type TaskOccurrenceRange,
  type TaskSelectedValue,
  type TaskSelectionSpans,
} from './taskOccurrenceSelection';

export interface TaskDailyRowsInput {
  readonly revision: string;
  readonly records: readonly TaskOrganizationRecord[];
  readonly today: LocalDate;
  readonly direction: 'asc' | 'desc';
  compareWithinDay(this: void, left: TaskOrganizationRecord, right: TaskOrganizationRecord): number;
  formatDate(this: void, date: LocalDate): string;
  occurrence(this: void, record: TaskOrganizationRecord, date: LocalDate): TaskSearchOccurrence;
}
interface Descriptor {
  readonly record: TaskOrganizationRecord;
  readonly key: string;
  readonly from: number;
  readonly to: number;
}
interface Segment {
  readonly from: number;
  readonly to: number;
  readonly count: number;
  readonly tasks: number;
  readonly rows: number;
}
interface Position {
  readonly segment: Segment;
  readonly day: number;
  readonly rank: number;
}
const epoch = localDate('0000-01-01');
const ordinal = (date: LocalDate): number => daysBetweenLocalDates(epoch, date);
function dateAt(day: number): LocalDate {
  const date = shiftLocalDate(epoch, day);
  if (date === undefined) throw new RangeError('Daily index date outside canonical domain');
  return date;
}
const physicalKey = (record: TaskOrganizationRecord): string =>
  `${record.source.filePath}:${record.source.line}`;
const seriesKey = (key?: string): string =>
  JSON.stringify(key === undefined ? ['upcoming-date'] : ['task-daily', key]);
const rowKey = (day: number, key?: string): string =>
  JSON.stringify(
    key === undefined ? ['upcoming-date', dateAt(day)] : ['task-daily', key, dateAt(day)],
  );
function decodedParts(parts: unknown[]): { day: number; taskKey?: string } | undefined {
  if (parts[0] === 'upcoming-date' && parts.length === 2 && typeof parts[1] === 'string')
    return { day: ordinal(localDate(parts[1])) };
  if (
    parts[0] === 'task-daily' &&
    parts.length === 3 &&
    typeof parts[1] === 'string' &&
    typeof parts[2] === 'string'
  )
    return { day: ordinal(localDate(parts[2])), taskKey: parts[1] };
  return undefined;
}
function decode(key: string): { day: number; taskKey?: string } | undefined {
  try {
    const parts: unknown = JSON.parse(key);
    if (!Array.isArray(parts)) return undefined;
    const decoded = decodedParts(parts);
    return decoded !== undefined && rowKey(decoded.day, decoded.taskKey) === key
      ? decoded
      : undefined;
  } catch {
    return undefined;
  }
}
function dateRange(key: string, from: number, to: number): TaskOccurrenceRange {
  return {
    kind: 'dates',
    taskKey: key,
    occurrenceKind: 'daily',
    groupKey: 'upcoming-date',
    from: dateAt(from),
    to: dateAt(to),
  };
}

function subtractDate(
  range: TaskOccurrenceRange,
  day: number,
  key: string | undefined,
): TaskOccurrenceRange[] {
  const date = dateAt(day);
  if (range.kind !== 'dates' || range.taskKey !== key || date < range.from || date > range.to)
    return [range];
  const result: TaskOccurrenceRange[] = [];
  if (range.from < date) result.push({ ...range, to: dateAt(day - 1) });
  if (date < range.to) result.push({ ...range, from: dateAt(day + 1) });
  return result;
}
function seriesBoundaryKeys(
  prior: { from: number; to: number },
  range: Extract<RowAnchorKeyRange, { kind: 'series' }>,
  pivot: number,
  direction: number,
): string[] {
  const from = Math.max(prior.from, range.from),
    to = Math.min(prior.to, range.to);
  if (from > to) return [];
  const day = direction === 1 ? Math.max(from, pivot) : Math.min(to, pivot);
  const parsed: unknown = JSON.parse(range.series);
  if (!Array.isArray(parsed)) return [];
  const key = parsed[0] === 'task-daily' ? String(parsed[1]) : undefined;
  return [day, day + direction]
    .filter((candidate) => candidate >= from && candidate <= to)
    .map((candidate) => rowKey(candidate, key));
}
/** Finite event segments own complete order; requested day vectors alone enter the LRU. */
class DailyRows implements TaskListRows<TaskSearchOccurrence> {
  readonly revision: string;
  readonly #nodes = new Map<string, Descriptor[]>();
  readonly #cache = new Map<number, readonly TaskOrganizationRecord[]>();
  constructor(
    readonly input: TaskDailyRowsInput,
    readonly descriptors: readonly Descriptor[],
    readonly segments: readonly Segment[],
    readonly counts: { readonly tasks: number; readonly rows: number },
  ) {
    this.revision = input.revision;
  }
  get taskCount(): number {
    return this.counts.tasks;
  }
  get rowCount(): number {
    return this.counts.rows;
  }
  *prepare(): CollectionSteps<boolean> {
    for (const descriptor of this.descriptors) {
      const entries = this.#nodes.get(descriptor.key) ?? [];
      entries.push(descriptor);
      this.#nodes.set(descriptor.key, entries);
      yield 'cheap';
    }
    const first = this.segments[0];
    if (first === undefined) return true;
    const day = this.input.direction === 'asc' ? first.from : first.to;
    const records: TaskOrganizationRecord[] = [];
    for (const descriptor of this.descriptors) {
      if (descriptor.from <= day && day <= descriptor.to) records.push(descriptor.record);
      yield 'cheap';
    }
    const sorted = yield* stableSortSteps(records, this.input.compareWithinDay);
    if (sorted === undefined) throw new Error('Daily vector sort ended without a result');
    this.#cache.set(day, sorted);
    return true;
  }
  get cachedDays(): number {
    return this.#cache.size;
  }
  #vector(day: number): readonly TaskOrganizationRecord[] {
    let records = this.#cache.get(day);
    if (records !== undefined) this.#cache.delete(day);
    else
      records = this.descriptors
        .filter((d) => d.from <= day && day <= d.to)
        .map((d) => d.record)
        .sort(this.input.compareWithinDay);
    this.#cache.set(day, records);
    if (this.#cache.size > 64) {
      const oldest = this.#cache.keys().next();
      if (oldest.done !== true) this.#cache.delete(oldest.value);
    }
    return records;
  }
  #position(index: number, kind: 'rows' | 'tasks'): Position | undefined {
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= (kind === 'rows' ? this.rowCount : this.taskCount)
    )
      return undefined;
    const segment = this.#prefixSegment(index, kind);
    if (segment === undefined) return undefined;
    const width = segment.count + Number(kind === 'rows'),
      offset = index - segment[kind],
      distance = Math.floor(offset / width);
    return {
      segment,
      day: this.input.direction === 'asc' ? segment.from + distance : segment.to - distance,
      rank: offset % width,
    };
  }
  #prefixSegment(index: number, kind: 'rows' | 'tasks'): Segment | undefined {
    let low = 0,
      high = this.segments.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((this.segments[middle]?.[kind] ?? Infinity) <= index) low = middle + 1;
      else high = middle;
    }
    return this.segments[low - 1];
  }
  #afterSegment(day: number, segment: Segment): boolean {
    return this.input.direction === 'asc' ? day > segment.to : day < segment.from;
  }
  #segment(day: number): Segment | undefined {
    let low = 0,
      high = this.segments.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2),
        segment = this.segments[middle];
      if (segment === undefined) return undefined;
      if (segment.from <= day && day <= segment.to) return segment;
      if (this.#afterSegment(day, segment)) low = middle + 1;
      else high = middle;
    }
    return undefined;
  }
  #offset(segment: Segment, day: number, kind: 'rows' | 'tasks'): number {
    return (
      segment[kind] +
      (this.input.direction === 'asc' ? day - segment.from : segment.to - day) *
        (segment.count + Number(kind === 'rows'))
    );
  }
  #occurrence(record: TaskOrganizationRecord, day: number): TaskSearchOccurrence {
    const date = dateAt(day),
      occupied = taskOccupiedDates(record.planning);
    return {
      ...this.input.occurrence(record, date),
      key: rowKey(day, physicalKey(record)),
      taskKey: physicalKey(record),
      presentation: {
        kind: 'daily',
        displayDate: date,
        ...(occupied.kind === 'interval'
          ? { interval: { start: occupied.start, due: occupied.due } }
          : { dateRoles: occupied.points.find((p) => p.date === date)?.roles ?? [] }),
        completion:
          occupied.kind === 'interval' && date < occupied.due
            ? { kind: 'continuation', due: occupied.due }
            : { kind: 'allowed' },
      },
    };
  }
  rowAt(index: number): TaskListRow<TaskSearchOccurrence> | undefined {
    const place = this.#position(index, 'rows');
    if (place === undefined) return undefined;
    if (place.rank === 0)
      return {
        kind: 'group',
        key: rowKey(place.day),
        label: this.input.formatDate(dateAt(place.day)),
        count: place.segment.count,
        dateGroup: { date: dateAt(place.day) },
        first: index === 0,
      };
    const record = this.#vector(place.day)[place.rank - 1];
    if (record === undefined) return undefined;
    const task = this.#occurrence(record, place.day);
    return {
      kind: 'task',
      key: task.key,
      taskKey: task.taskKey,
      task,
      presentation: task.presentation,
    };
  }
  #index(key: string, kind: 'rows' | 'tasks'): number {
    const decoded = decode(key);
    if (decoded === undefined || (kind === 'tasks' && decoded.taskKey === undefined)) return -1;
    const segment = this.#segment(decoded.day);
    if (segment === undefined) return -1;
    const offset = this.#offset(segment, decoded.day, kind);
    if (decoded.taskKey === undefined) return offset;
    if (
      this.#nodes
        .get(decoded.taskKey)
        ?.some((d) => d.from <= decoded.day && decoded.day <= d.to) !== true
    )
      return -1;
    const rank = this.#vector(decoded.day).findIndex((r) => physicalKey(r) === decoded.taskKey);
    return rank < 0 ? -1 : offset + rank + Number(kind === 'rows');
  }
  rowIndexOf(key: string): number {
    return this.#index(key, 'rows');
  }
  indexOf(key: string): number {
    return this.#index(key, 'tasks');
  }
  taskKeyAt(index: number): string | undefined {
    const place = this.#position(index, 'tasks');
    if (place === undefined) return undefined;
    const record = this.#vector(place.day)[place.rank];
    return record === undefined ? undefined : rowKey(place.day, physicalKey(record));
  }
  firstOccurrenceOf(key: string): string | undefined {
    const descriptors = this.#nodes.get(key);
    if (descriptors === undefined) return undefined;
    return rowKey(
      this.input.direction === 'asc'
        ? Math.min(...descriptors.map((d) => d.from))
        : Math.max(...descriptors.map((d) => d.to)),
      key,
    );
  }
  physicalKey(key: string): string | undefined {
    return this.task(key)?.taskKey;
  }
  task(key: string): TaskSearchOccurrence | undefined {
    const decoded = decode(key);
    if (decoded?.taskKey === undefined) return undefined;
    const descriptor = this.#nodes
      .get(decoded.taskKey)
      ?.find((d) => d.from <= decoded.day && decoded.day <= d.to);
    return descriptor === undefined ? undefined : this.#occurrence(descriptor.record, decoded.day);
  }
  *slice(from: number, toExclusive: number): Iterable<TaskListRow<TaskSearchOccurrence>> {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(toExclusive)) return;
    for (let i = Math.max(0, from); i < Math.min(this.rowCount, toExclusive); i++) {
      const row = this.rowAt(i);
      if (row !== undefined) yield row;
    }
  }
  #intersect(ranges: readonly TaskOccurrenceRange[]): readonly TaskOccurrenceRange[] {
    const result: TaskOccurrenceRange[] = [];
    for (const range of ranges) {
      if (
        range.kind !== 'dates' ||
        range.occurrenceKind !== 'daily' ||
        range.groupKey !== 'upcoming-date'
      )
        continue;
      for (const descriptor of this.#nodes.get(range.taskKey) ?? []) {
        const from = Math.max(ordinal(range.from), descriptor.from),
          to = Math.min(ordinal(range.to), descriptor.to);
        if (from <= to) result.push(dateRange(range.taskKey, from, to));
      }
    }
    return normalizeOccurrenceRanges(result);
  }
  #keyRange(key: string): TaskOccurrenceRange[] {
    const task = this.task(key),
      date = task?.presentation.displayDate;
    return task !== undefined && date !== undefined
      ? [dateRange(task.taskKey, ordinal(date), ordinal(date))]
      : [];
  }
  #boundary(place: Position, from: number, to: number): TaskOccurrenceRange[] {
    const vector = this.#vector(place.day),
      result: TaskOccurrenceRange[] = [];
    for (let rank = from; rank <= to; rank++) {
      const record = vector[rank];
      if (record !== undefined) result.push(dateRange(physicalKey(record), place.day, place.day));
    }
    return result;
  }
  #span(from: number, to: number): TaskOccurrenceRange[] {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from > to) return [];
    const first = this.#position(Math.max(0, from), 'tasks'),
      last = this.#position(Math.min(this.taskCount - 1, to), 'tasks');
    if (first === undefined || last === undefined) return [];
    if (first.day === last.day) return this.#boundary(first, first.rank, last.rank);
    const result = this.#interior(
      Math.min(first.day, last.day) + 1,
      Math.max(first.day, last.day) - 1,
    );
    return [
      ...result,
      ...this.#boundary(first, first.rank, first.segment.count - 1),
      ...this.#boundary(last, 0, last.rank),
    ];
  }
  #interior(start: number, end: number): TaskOccurrenceRange[] {
    const result: TaskOccurrenceRange[] = [];
    for (const d of this.descriptors) {
      const from = Math.max(d.from, start),
        to = Math.min(d.to, end);
      if (from <= to) result.push(dateRange(d.key, from, to));
    }
    return result;
  }
  captureSelection(selection: TaskSelectionSpans): readonly TaskOccurrenceRange[] {
    let ranges = [
      ...this.#intersect(selection.ranges ?? []),
      ...selection.spans.flatMap((span) => this.#span(span.from, span.to)),
      ...selection.include.flatMap((key) => this.#keyRange(key)),
    ];
    ranges = [...normalizeOccurrenceRanges(ranges)];
    for (const key of selection.exclude) {
      const decoded = decode(key);
      if (decoded?.taskKey !== undefined)
        ranges = ranges.flatMap((range) => subtractDate(range, decoded.day, decoded.taskKey));
    }
    return ranges;
  }
  firstSelectedKey(ranges: readonly TaskOccurrenceRange[]): string | undefined {
    const selected = this.#intersect(ranges);
    const sign = this.input.direction === 'asc' ? 1 : -1;
    let day: number | undefined;
    for (const range of selected) {
      if (range.kind !== 'dates') continue;
      const candidate = ordinal(sign === 1 ? range.from : range.to);
      if (day === undefined || candidate * sign < day * sign) day = candidate;
    }
    if (day === undefined) return undefined;
    const date = dateAt(day);
    const keys = new Set(
      selected
        .filter((range) => range.kind === 'dates' && range.from <= date && date <= range.to)
        .map((range) => range.taskKey),
    );
    const first = this.#vector(day).find((record) => keys.has(physicalKey(record)));
    return first === undefined ? undefined : rowKey(day, physicalKey(first));
  }
  selectedCount(ranges: readonly TaskOccurrenceRange[]): number {
    return this.#intersect(ranges).reduce(
      (count, r) => count + (r.kind === 'dates' ? daysBetweenLocalDates(r.from, r.to) + 1 : 0),
      0,
    );
  }
  isSelected(key: string, ranges: readonly TaskOccurrenceRange[]): boolean {
    const task = this.task(key),
      date = task?.presentation.displayDate;
    return (
      task !== undefined &&
      date !== undefined &&
      ranges.some(
        (r) =>
          r.kind === 'dates' &&
          r.occurrenceKind === 'daily' &&
          r.groupKey === 'upcoming-date' &&
          r.taskKey === task.taskKey &&
          r.from <= date &&
          date <= r.to,
      )
    );
  }
  selectedNodes(
    ranges: readonly TaskOccurrenceRange[],
  ): ReadonlyArray<TaskSelectedValue<TaskSearchOccurrence>> {
    const nodes = new Map<string, TaskSelectedValue<TaskSearchOccurrence>>();
    for (const range of this.#intersect(ranges)) {
      if (range.kind !== 'dates') continue;
      const task = this.task(
        rowKey(ordinal(this.input.direction === 'asc' ? range.from : range.to), range.taskKey),
      );
      if (task === undefined) continue;
      this.#selectNode(nodes, task, range);
    }
    return [...nodes.values()];
  }
  #selectNode(
    nodes: Map<string, TaskSelectedValue<TaskSearchOccurrence>>,
    task: TaskSearchOccurrence,
    range: Extract<TaskOccurrenceRange, { kind: 'dates' }>,
  ): void {
    const due = task.presentation.interval?.due;
    const completion =
      due === undefined || (range.from <= due && due <= range.to)
        ? { kind: 'allowed' as const }
        : task.presentation.completion;
    const prior = nodes.get(range.taskKey);
    if (prior === undefined) nodes.set(range.taskKey, { taskKey: range.taskKey, task, completion });
    else if (completion.kind === 'allowed') nodes.set(range.taskKey, { ...prior, completion });
  }
  estimatedOffset(
    index: number,
    heights: { readonly group: number; readonly task: number },
  ): number {
    if (!Number.isSafeInteger(index) || index <= 0) return 0;
    if (index >= this.rowCount)
      return (this.rowCount - this.taskCount) * heights.group + this.taskCount * heights.task;
    const place = this.#position(index, 'rows');
    if (place === undefined) return 0;
    const rowStart = this.#offset(place.segment, place.day, 'rows'),
      tasks = this.#offset(place.segment, place.day, 'tasks');
    return (
      (rowStart - tasks) * heights.group +
      tasks * heights.task +
      (place.rank > 0 ? heights.group + (place.rank - 1) * heights.task : 0)
    );
  }
  anchorRanges(): readonly RowAnchorKeyRange[] {
    return [
      ...this.segments.map((s) => ({
        kind: 'series' as const,
        series: seriesKey(),
        from: s.from,
        to: s.to,
      })),
      ...this.descriptors.map((d) => ({
        kind: 'series' as const,
        series: seriesKey(d.key),
        from: d.from,
        to: d.to,
      })),
    ];
  }
  #anchorSeries(): Map<string, Array<{ from: number; to: number }>> {
    const result = new Map<string, Array<{ from: number; to: number }>>();
    for (const range of this.anchorRanges()) {
      if (range.kind !== 'series') continue;
      const entries = result.get(range.series) ?? [];
      entries.push(range);
      result.set(range.series, entries);
    }
    return result;
  }
  survivingNeighbor(
    previousIndex: number,
    direction: 1 | -1,
    current: RowViewportSource,
  ): string | undefined {
    const pivot = this.#position(Math.max(0, Math.min(this.rowCount - 1, previousIndex)), 'rows');
    if (pivot === undefined) return undefined;
    const dateDirection = direction * (this.input.direction === 'asc' ? 1 : -1);
    const old = this.#anchorSeries();
    let best: string | undefined,
      distance = Infinity;
    const consider = (key: string): void => {
      const index = this.rowIndexOf(key),
        delta = (index - previousIndex) * direction;
      if (index >= 0 && delta > 0 && delta < distance && current.indexOf(key) >= 0) {
        best = key;
        distance = delta;
      }
    };
    for (const range of current.anchorRanges()) {
      if (range.kind === 'key') {
        consider(range.key);
        continue;
      }
      for (const prior of old.get(range.series) ?? [])
        for (const key of seriesBoundaryKeys(prior, range, pivot.day, dateDirection)) consider(key);
    }

    return best;
  }
}
/** Structural audit for tests/benchmarks. Counts describe retained finite storage. */
export function taskDailyRowsAudit(
  rows: TaskListRows<TaskSearchOccurrence>,
): { descriptors: number; events: number; segments: number; cachedDays: number } | undefined {
  return rows instanceof DailyRows
    ? {
        descriptors: rows.descriptors.length,
        events: rows.descriptors.length * 2,
        segments: rows.segments.length,
        cachedDays: rows.cachedDays,
      }
    : undefined;
}
function* dailyDescriptors(
  input: TaskDailyRowsInput,
): CollectionSteps<{ descriptors: Descriptor[]; events: Array<{ day: number; delta: number }> }> {
  const descriptors: Descriptor[] = [],
    events: Array<{ day: number; delta: number }> = [];
  const tomorrow = ordinal(input.today) + 1;
  for (const record of input.records) {
    const occupied = taskOccupiedDates(record.planning);
    const ranges =
      occupied.kind === 'interval'
        ? [{ from: ordinal(occupied.start), to: ordinal(occupied.due) }]
        : occupied.points.map((p) => ({ from: ordinal(p.date), to: ordinal(p.date) }));
    for (const range of ranges) {
      const from = Math.max(tomorrow, range.from),
        to = range.to;
      if (from <= to) {
        descriptors.push({ record, key: physicalKey(record), from, to });
        events.push({ day: from, delta: 1 }, { day: to + 1, delta: -1 });
      }
      yield 'cheap';
    }
  }
  return { descriptors, events };
}
function* dailySegments(
  events: Array<{ day: number; delta: number }>,
  direction: 'asc' | 'desc',
): CollectionSteps<{ indexed: Segment[]; tasks: number; rows: number }> {
  const sorted = yield* stableSortSteps(events, (a, b) => a.day - b.day);
  if (sorted === undefined) throw new Error('Daily event sort ended without a result');
  const segments: Segment[] = [];
  let count = 0,
    previous: number | undefined;
  for (const event of sorted) {
    if (previous !== undefined && previous < event.day && count > 0)
      segments.push({ from: previous, to: event.day - 1, count, tasks: 0, rows: 0 });
    count += event.delta;
    previous = event.day;
    yield 'cheap';
  }
  if (direction === 'desc') segments.reverse();
  let tasks = 0,
    rows = 0;
  const indexed: Segment[] = [];
  for (const segment of segments) {
    indexed.push({ ...segment, tasks, rows });
    const days = segment.to - segment.from + 1;
    tasks += days * segment.count;
    rows += days * (segment.count + 1);
    if (!Number.isSafeInteger(tasks) || !Number.isSafeInteger(rows))
      throw new RangeError('Daily row count exceeds safe integer range');
    yield 'cheap';
  }
  return { indexed, tasks, rows };
}
export function* buildTaskDailyRowsSteps(
  input: TaskDailyRowsInput,
): CollectionSteps<TaskListRows<TaskSearchOccurrence>> {
  const data = yield* dailyDescriptors(input);
  if (data === undefined) throw new Error('Daily descriptors ended without a result');
  const segments = yield* dailySegments(data.events, input.direction);
  if (segments === undefined) throw new Error('Daily segments ended without a result');
  const result = new DailyRows(input, data.descriptors, segments.indexed, segments);
  yield* result.prepare();
  return result;
}
