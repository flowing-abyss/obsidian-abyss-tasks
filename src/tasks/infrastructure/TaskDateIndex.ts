import type { LocalDate } from '../domain/types';

interface CalendarPlanning {
  readonly start?: LocalDate;
  readonly scheduled?: LocalDate;
  readonly due?: LocalDate;
}

export interface CalendarDateRange {
  readonly start: LocalDate;
  readonly due: LocalDate;
}

export function calendarDatesForPlanning(planning: CalendarPlanning): readonly LocalDate[] {
  if (planning.start && planning.due) return [];
  if (planning.scheduled && planning.due && planning.scheduled !== planning.due) {
    return [planning.scheduled, planning.due];
  }
  const anchor = planning.scheduled ?? planning.due;
  return anchor ? [anchor] : [];
}

export function calendarRangeForPlanning(
  planning: CalendarPlanning,
): CalendarDateRange | undefined {
  if (!planning.start || !planning.due || planning.start > planning.due) return undefined;
  return { start: planning.start, due: planning.due };
}

interface IndexedRange<T> extends CalendarDateRange {
  readonly task: T;
}

interface OrderedRange<T> extends IndexedRange<T> {
  readonly ordinal: number;
}

interface RangeNode<T> {
  readonly range: OrderedRange<T>;
  readonly maxDue: LocalDate;
  readonly left?: RangeNode<T>;
  readonly right?: RangeNode<T>;
}

function buildRangeTree<T>(
  ranges: readonly OrderedRange<T>[],
  from = 0,
  to = ranges.length,
): RangeNode<T> | undefined {
  if (from >= to) return undefined;
  const middle = Math.floor((from + to) / 2);
  const range = ranges[middle]!;
  const left = buildRangeTree(ranges, from, middle);
  const right = buildRangeTree(ranges, middle + 1, to);
  let maxDue = range.due;
  if (left && left.maxDue > maxDue) maxDue = left.maxDue;
  if (right && right.maxDue > maxDue) maxDue = right.maxDue;
  return {
    range,
    maxDue,
    ...(left && { left }),
    ...(right && { right }),
  };
}

export class TaskDateIndex<T> {
  private readonly byDate = new Map<LocalDate, T[]>();
  private readonly datesByFile = new Map<string, Set<LocalDate>>();
  private readonly tasksByFile = new Map<string, Set<T>>();
  private readonly rangesByFile = new Map<string, readonly IndexedRange<T>[]>();
  private rangeTree: RangeNode<T> | undefined;
  private rangeTreeDirty = false;

  constructor(
    private readonly datesForTask: (task: T) => readonly LocalDate[],
    private readonly rangeForTask?: (task: T) => CalendarDateRange | undefined,
  ) {}

  updateFile(filePath: string, tasks: readonly T[]): void {
    const previousTasks = this.tasksByFile.get(filePath);
    const previousDates = this.datesByFile.get(filePath);
    if (previousTasks && previousDates) {
      for (const date of previousDates) {
        const remaining = (this.byDate.get(date) ?? []).filter((task) => !previousTasks.has(task));
        if (remaining.length > 0) this.byDate.set(date, remaining);
        else this.byDate.delete(date);
      }
    }
    this.rangesByFile.delete(filePath);
    this.rangeTreeDirty = true;

    const dates = new Set<LocalDate>();
    const ranges: IndexedRange<T>[] = [];
    for (const task of tasks) {
      for (const date of this.datesForTask(task)) {
        dates.add(date);
        const bucket = this.byDate.get(date);
        if (bucket) bucket.push(task);
        else this.byDate.set(date, [task]);
      }
      const range = this.rangeForTask?.(task);
      if (range && range.start <= range.due) ranges.push({ ...range, task });
    }
    if (tasks.length > 0) this.tasksByFile.set(filePath, new Set(tasks));
    else this.tasksByFile.delete(filePath);
    if (dates.size > 0) this.datesByFile.set(filePath, dates);
    else this.datesByFile.delete(filePath);
    if (ranges.length > 0) this.rangesByFile.set(filePath, ranges);
  }

  removeFile(filePath: string): void {
    this.updateFile(filePath, []);
  }

  get(date: LocalDate): readonly T[] {
    const tasks = new Set(this.byDate.get(date) ?? []);
    this.ensureRangeTree();
    const matches: OrderedRange<T>[] = [];
    this.collectRangeMatches(this.rangeTree, date, matches);
    matches.sort((left, right) => left.ordinal - right.ordinal);
    for (const match of matches) tasks.add(match.task);
    return [...tasks];
  }

  private ensureRangeTree(): void {
    if (!this.rangeTreeDirty) return;
    const ranges = Array.from(this.rangesByFile.values())
      .flat()
      .map((range, ordinal): OrderedRange<T> => ({ ...range, ordinal }))
      .sort((left, right) => {
        if (left.start !== right.start) return left.start < right.start ? -1 : 1;
        if (left.due !== right.due) return left.due < right.due ? -1 : 1;
        return left.ordinal - right.ordinal;
      });
    this.rangeTree = buildRangeTree(ranges);
    this.rangeTreeDirty = false;
  }

  private collectRangeMatches(
    node: RangeNode<T> | undefined,
    date: LocalDate,
    matches: OrderedRange<T>[],
  ): void {
    if (!node) return;
    if (node.left && node.left.maxDue >= date) {
      this.collectRangeMatches(node.left, date, matches);
    }
    if (node.range.start <= date && date <= node.range.due) matches.push(node.range);
    if (node.range.start <= date && node.right && node.right.maxDue >= date) {
      this.collectRangeMatches(node.right, date, matches);
    }
  }

  clear(): void {
    this.byDate.clear();
    this.datesByFile.clear();
    this.tasksByFile.clear();
    this.rangesByFile.clear();
    this.rangeTree = undefined;
    this.rangeTreeDirty = false;
  }
}
