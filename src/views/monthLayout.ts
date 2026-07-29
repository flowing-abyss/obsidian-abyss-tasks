import type { TaskSnapshot } from '../tasks';
import { bucketTasksForDate } from './TodayView';
import { layoutVisibleSpans, type VisibleSpanRow, type VisibleSpanSegment } from './spanLayout';
import { taskLayoutIdentity } from './timegrid/layout';

export type MonthCompactKind = 'plain' | 'timed' | 'deadline';

export interface MonthCompactSlot {
  readonly task: TaskSnapshot;
  readonly kind: MonthCompactKind;
  readonly slot: number;
}

export interface MonthVisibleRow {
  readonly spanRow: VisibleSpanRow;
  readonly compactByDate: ReadonlyMap<string, readonly MonthCompactSlot[]>;
  readonly slotCount: number;
}

export interface MonthVisibleLayout {
  readonly rows: readonly MonthVisibleRow[];
}

type MonthCandidate =
  | {
      readonly kind: 'span';
      readonly task: TaskSnapshot;
      readonly segment: VisibleSpanSegment;
    }
  | {
      readonly kind: MonthCompactKind;
      readonly task: TaskSnapshot;
    };

function candidateGroup(candidate: MonthCandidate): number {
  if (candidate.kind === 'deadline') return 2;
  return candidate.task.planning.time ? 1 : 0;
}

function compareCandidates(left: MonthCandidate, right: MonthCandidate): number {
  const leftGroup = candidateGroup(left);
  const rightGroup = candidateGroup(right);
  if (leftGroup !== rightGroup) return leftGroup - rightGroup;

  const time = (left.task.planning.time ?? '').localeCompare(right.task.planning.time ?? '');
  if (time !== 0) return time;

  const identity = taskLayoutIdentity(left.task).localeCompare(taskLayoutIdentity(right.task));
  return identity !== 0 ? identity : left.kind.localeCompare(right.kind);
}

export function layoutVisibleMonth(
  tasks: readonly TaskSnapshot[],
  dates: readonly string[],
): MonthVisibleLayout {
  const sharedRows = layoutVisibleSpans(tasks, dates).rows;

  return {
    rows: sharedRows.map((sharedRow, rowIndex) => {
      const rowDates = dates.slice(rowIndex * 7, rowIndex * 7 + 7);
      const segments: VisibleSpanSegment[] = [];
      const compactByDate = new Map<string, readonly MonthCompactSlot[]>();
      let slotCount = 0;

      for (const date of rowDates) {
        const { timed, plain, deadlines } = bucketTasksForDate([...tasks], date);
        const candidates: MonthCandidate[] = [
          ...sharedRow.segments
            .filter((segment) => segment.date === date)
            .map((segment): MonthCandidate => ({ kind: 'span', task: segment.task, segment })),
          ...plain.map((task): MonthCandidate => ({ kind: 'plain', task })),
          ...timed.map((task): MonthCandidate => ({ kind: 'timed', task })),
          ...deadlines.map((task): MonthCandidate => ({ kind: 'deadline', task })),
        ].sort(compareCandidates);
        const compactSlots: MonthCompactSlot[] = [];

        for (const [slot, candidate] of candidates.entries()) {
          if (candidate.kind === 'span') {
            segments.push({ ...candidate.segment, lane: slot });
          } else {
            compactSlots.push({ task: candidate.task, kind: candidate.kind, slot });
          }
        }
        compactByDate.set(date, compactSlots);
        slotCount = Math.max(slotCount, candidates.length);
      }

      return {
        spanRow: {
          ...sharedRow,
          laneCount: slotCount,
          segments,
        },
        compactByDate,
        slotCount,
      };
    }),
  };
}

export function layoutVisibleMonthWithReplacement(
  tasks: readonly TaskSnapshot[],
  dates: readonly string[],
  source: TaskSnapshot,
  planning: TaskSnapshot['planning'],
): MonthVisibleLayout {
  const identity = taskLayoutIdentity(source);
  return layoutVisibleMonth(
    tasks.map((candidate) =>
      taskLayoutIdentity(candidate) === identity ? { ...candidate, planning } : candidate,
    ),
    dates,
  );
}
