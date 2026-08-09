import { localDate, type LocalDate, type TaskSnapshot } from '../tasks';
import { calendarTaskWithPlanning } from './calendarOccurrences';
import { taskLayoutIdentity } from './timegrid/layout';

export interface VisibleSpanSegment {
  readonly task: TaskSnapshot;
  readonly identity: string;
  readonly kind: 'ghost' | 'terminal';
  readonly date: LocalDate;
  readonly lane: number;
  readonly ownsStartBoundary: boolean;
  readonly ownsDueBoundary: boolean;
  readonly continuesBefore: boolean;
  readonly continuesAfter: boolean;
}

export interface VisibleSpanRow {
  readonly startDate: LocalDate;
  readonly laneCount: number;
  readonly segments: readonly VisibleSpanSegment[];
}

export interface VisibleSpanLayout {
  readonly rows: readonly VisibleSpanRow[];
}

interface RowInterval {
  readonly task: TaskSnapshot;
  readonly identity: string;
  readonly actualStart: LocalDate;
  readonly actualDue: LocalDate;
  readonly visibleStart: LocalDate;
  readonly visibleEnd: LocalDate;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly continuing: boolean;
}

function isSpan(task: TaskSnapshot): task is TaskSnapshot & {
  readonly planning: TaskSnapshot['planning'] & {
    readonly start: LocalDate;
    readonly due: LocalDate;
  };
} {
  return (
    task.planning.start !== undefined &&
    task.planning.due !== undefined &&
    task.planning.start <= task.planning.due
  );
}

function compareIntervals(left: RowInterval, right: RowInterval): number {
  const visibleStart = left.visibleStart.localeCompare(right.visibleStart);
  if (visibleStart !== 0) return visibleStart;
  const leftLength = left.endIndex - left.startIndex;
  const rightLength = right.endIndex - right.startIndex;
  if (leftLength !== rightLength) return rightLength - leftLength;
  const actualStart = left.actualStart.localeCompare(right.actualStart);
  return actualStart !== 0 ? actualStart : left.identity.localeCompare(right.identity);
}

function firstFreeLane(occupied: readonly RowInterval[][], interval: RowInterval): number {
  for (let lane = 0; lane < occupied.length; lane++) {
    if (
      !occupied[lane]!.some(
        (other) => other.endIndex >= interval.startIndex && other.startIndex <= interval.endIndex,
      )
    ) {
      return lane;
    }
  }
  return occupied.length;
}

function laneIsFree(
  occupied: readonly RowInterval[][],
  lane: number,
  interval: RowInterval,
): boolean {
  return !occupied[lane]?.some(
    (other) => other.endIndex >= interval.startIndex && other.startIndex <= interval.endIndex,
  );
}

/**
 * Clips semantic start/due spans to visible dates, splits only at seven-day row boundaries, and
 * assigns deterministic row-local lanes. Single-day anchors never enter this occupancy model.
 */
export function layoutVisibleSpans(
  tasks: readonly TaskSnapshot[],
  dates: readonly string[],
): VisibleSpanLayout {
  const visibleDates = dates.map((date) => localDate(date));
  const previousLanes = new Map<string, number>();
  const rows: VisibleSpanRow[] = [];

  for (let rowOffset = 0; rowOffset < visibleDates.length; rowOffset += 7) {
    const rowDates = visibleDates.slice(rowOffset, rowOffset + 7);
    const rowStart = rowDates[0];
    const rowEnd = rowDates[rowDates.length - 1];
    if (!rowStart || !rowEnd) continue;

    const intervals = tasks
      .flatMap<RowInterval>((task) => {
        if (!isSpan(task) || task.planning.due < rowStart || task.planning.start > rowEnd)
          return [];
        const visibleStart = task.planning.start < rowStart ? rowStart : task.planning.start;
        const visibleEnd = task.planning.due > rowEnd ? rowEnd : task.planning.due;
        const startIndex = rowDates.indexOf(visibleStart);
        const endIndex = rowDates.indexOf(visibleEnd);
        if (startIndex < 0 || endIndex < startIndex) return [];
        return [
          {
            task,
            identity: taskLayoutIdentity(task),
            actualStart: task.planning.start,
            actualDue: task.planning.due,
            visibleStart,
            visibleEnd,
            startIndex,
            endIndex,
            continuing: task.planning.start < rowStart,
          },
        ];
      })
      .sort(compareIntervals);

    const occupied: RowInterval[][] = [];
    const laneByIdentity = new Map<string, number>();
    for (const interval of intervals) {
      const preferred = interval.continuing ? previousLanes.get(interval.identity) : undefined;
      const lane =
        preferred !== undefined && laneIsFree(occupied, preferred, interval)
          ? preferred
          : firstFreeLane(occupied, interval);
      while (occupied.length <= lane) occupied.push([]);
      occupied[lane]!.push(interval);
      laneByIdentity.set(interval.identity, lane);
    }

    const segments = intervals.flatMap<VisibleSpanSegment>((interval) => {
      const lane = laneByIdentity.get(interval.identity)!;
      return rowDates.slice(interval.startIndex, interval.endIndex + 1).map((date) => {
        const terminal = date === interval.actualDue;
        return {
          task: interval.task,
          identity: interval.identity,
          kind: terminal ? 'terminal' : 'ghost',
          date,
          lane,
          ownsStartBoundary: date === interval.actualStart,
          ownsDueBoundary: terminal,
          continuesBefore: interval.actualStart < date,
          continuesAfter: interval.actualDue > date,
        };
      });
    });

    rows.push({ startDate: rowStart, laneCount: occupied.length, segments });
    previousLanes.clear();
    for (const interval of intervals) {
      if (interval.actualDue > rowEnd)
        previousLanes.set(interval.identity, laneByIdentity.get(interval.identity)!);
    }
  }

  return { rows };
}

/**
 * Stateless preview projection: replace one task's planning in the committed render snapshot and
 * run the same lane allocator the subsequent render will use.
 */
export function layoutVisibleSpansWithReplacement(
  tasks: readonly TaskSnapshot[],
  dates: readonly string[],
  source: TaskSnapshot,
  planning: TaskSnapshot['planning'],
): VisibleSpanLayout {
  const identity = taskLayoutIdentity(source);
  return layoutVisibleSpans(
    tasks.map((candidate) =>
      taskLayoutIdentity(candidate) === identity
        ? calendarTaskWithPlanning(candidate, planning)
        : candidate,
    ),
    dates,
  );
}
