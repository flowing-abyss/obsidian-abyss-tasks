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

export class TaskDateIndex<T> {
  private readonly byDate = new Map<LocalDate, T[]>();
  private readonly datesByFile = new Map<string, Set<LocalDate>>();
  private readonly tasksByFile = new Map<string, Set<T>>();
  private readonly rangesByFile = new Map<string, readonly IndexedRange<T>[]>();

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
    for (const ranges of this.rangesByFile.values()) {
      for (const range of ranges) {
        if (range.start <= date && date <= range.due) tasks.add(range.task);
      }
    }
    return [...tasks];
  }

  clear(): void {
    this.byDate.clear();
    this.datesByFile.clear();
    this.tasksByFile.clear();
    this.rangesByFile.clear();
  }
}
