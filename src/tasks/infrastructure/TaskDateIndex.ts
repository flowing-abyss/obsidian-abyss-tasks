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
  if (planning.start != null && planning.due != null) return [];
  if (planning.scheduled != null && planning.due != null && planning.scheduled !== planning.due) {
    return [planning.scheduled, planning.due];
  }
  const anchor = planning.scheduled ?? planning.due;
  return anchor != null ? [anchor] : [];
}

export function calendarRangeForPlanning(
  planning: CalendarPlanning,
): CalendarDateRange | undefined {
  if (planning.start == null || planning.due == null || planning.start > planning.due)
    return undefined;
  return { start: planning.start, due: planning.due };
}

interface IndexedRange<T> extends CalendarDateRange {
  readonly task: T;
}

interface OrderedRange<T> extends IndexedRange<T> {
  readonly ordinal: number;
}

interface RangeNode<T> {
  readonly center: LocalDate;
  readonly spanningByStart: ReadonlyArray<OrderedRange<T>>;
  readonly spanningByDue: ReadonlyArray<OrderedRange<T>>;
  readonly left?: RangeNode<T>;
  readonly right?: RangeNode<T>;
}

/**
 * Builds a centered interval tree from ranges already sorted by start date.
 *
 * The median start keeps both recursive partitions balanced. Ranges crossing the center live at
 * that node in two scan orders, so a warmed point query visits O(log R + k) entries. Rebuilding is
 * lazy after a batch of file updates and costs O(R log R); point queries never sort.
 */
function buildRangeTree<T>(ranges: ReadonlyArray<OrderedRange<T>>): RangeNode<T> | undefined {
  if (ranges.length === 0) return undefined;
  const median = ranges[Math.floor(ranges.length / 2)];
  if (median === undefined) return undefined;
  const center = median.start;
  const leftRanges: Array<OrderedRange<T>> = [];
  const rightRanges: Array<OrderedRange<T>> = [];
  const spanningByStart: Array<OrderedRange<T>> = [];
  for (const range of ranges) {
    if (range.due < center) leftRanges.push(range);
    else if (range.start > center) rightRanges.push(range);
    else spanningByStart.push(range);
  }
  const spanningByDue = [...spanningByStart].sort((left, right) => {
    if (left.due !== right.due) return left.due > right.due ? -1 : 1;
    if (left.start !== right.start) return left.start < right.start ? -1 : 1;
    return left.ordinal - right.ordinal;
  });
  const left = buildRangeTree(leftRanges);
  const right = buildRangeTree(rightRanges);
  return {
    center,
    spanningByStart,
    spanningByDue,
    ...(left != null && { left }),
    ...(right != null && { right }),
  };
}

export class TaskDateIndex<T> {
  private readonly byDate = new Map<LocalDate, T[]>();
  private readonly datesByFile = new Map<string, Set<LocalDate>>();
  private readonly tasksByFile = new Map<string, Set<T>>();
  private readonly rangesByFile = new Map<string, ReadonlyArray<IndexedRange<T>>>();
  private rangeTree: RangeNode<T> | undefined;
  private rangeTreeDirty = false;

  constructor(
    private readonly datesForTask: (task: T) => readonly LocalDate[],
    private readonly rangeForTask?: (task: T) => CalendarDateRange | undefined,
  ) {}

  updateFile(filePath: string, tasks: readonly T[]): void {
    this.removePreviousFileTasks(filePath);
    this.rangesByFile.delete(filePath);
    this.rangeTreeDirty = true;
    const indexed = this.indexTasks(tasks);
    this.storeFileTasks(filePath, tasks, indexed);
  }

  private removePreviousFileTasks(filePath: string): void {
    const previousTasks = this.tasksByFile.get(filePath);
    const previousDates = this.datesByFile.get(filePath);
    if (previousTasks == null || previousDates == null) return;
    for (const date of previousDates) {
      const remaining = (this.byDate.get(date) ?? []).filter((task) => !previousTasks.has(task));
      if (remaining.length > 0) this.byDate.set(date, remaining);
      else this.byDate.delete(date);
    }
  }

  private indexTasks(tasks: readonly T[]): {
    readonly dates: Set<LocalDate>;
    readonly ranges: Array<IndexedRange<T>>;
  } {
    const dates = new Set<LocalDate>();
    const ranges: Array<IndexedRange<T>> = [];
    for (const task of tasks) {
      this.indexTaskDates(task, dates);
      const range = this.rangeForTask?.(task);
      if (range != null && range.start <= range.due) ranges.push({ ...range, task });
    }
    return { dates, ranges };
  }

  private indexTaskDates(task: T, dates: Set<LocalDate>): void {
    for (const date of this.datesForTask(task)) {
      dates.add(date);
      const bucket = this.byDate.get(date);
      if (bucket != null) bucket.push(task);
      else this.byDate.set(date, [task]);
    }
  }

  private storeFileTasks(
    filePath: string,
    tasks: readonly T[],
    indexed: { readonly dates: Set<LocalDate>; readonly ranges: Array<IndexedRange<T>> },
  ): void {
    const { dates, ranges } = indexed;
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
    const matches: Array<OrderedRange<T>> = [];
    // The centered tree emits in deterministic node-local scan order. Do not sort this result:
    // the overlap query must remain O(log R + k), while TaskIndex applies consumer-facing stable
    // task order afterwards.
    this.collectRangeMatches(this.rangeTree, date, matches);
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
    matches: Array<OrderedRange<T>>,
  ): void {
    if (node == null) return;
    if (date < node.center) {
      this.collectBeforeCenter(node, date, matches);
      return;
    }
    if (date > node.center) {
      this.collectAfterCenter(node, date, matches);
      return;
    }
    matches.push(...node.spanningByStart);
  }

  private collectBeforeCenter(
    node: RangeNode<T>,
    date: LocalDate,
    matches: Array<OrderedRange<T>>,
  ): void {
    for (const range of node.spanningByStart) {
      if (range.start > date) break;
      matches.push(range);
    }
    this.collectRangeMatches(node.left, date, matches);
  }

  private collectAfterCenter(
    node: RangeNode<T>,
    date: LocalDate,
    matches: Array<OrderedRange<T>>,
  ): void {
    for (const range of node.spanningByDue) {
      if (range.due < date) break;
      matches.push(range);
    }
    this.collectRangeMatches(node.right, date, matches);
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
