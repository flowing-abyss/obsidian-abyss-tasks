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
      readonly segments: VisibleSpanSegment[];
    }
  | {
      readonly kind: MonthCompactKind;
      readonly task: TaskSnapshot;
      readonly date: string;
    };

function candidateGroup(candidate: MonthCandidate): number {
  if (candidate.kind === 'deadline') return 2;
  return candidate.task.planning.time ? 0 : 1;
}

function compareCandidates(left: MonthCandidate, right: MonthCandidate): number {
  const leftGroup = candidateGroup(left);
  const rightGroup = candidateGroup(right);
  if (leftGroup !== rightGroup) return leftGroup - rightGroup;

  const time = (left.task.planning.time ?? '').localeCompare(right.task.planning.time ?? '');
  if (time !== 0) return time;

  const identity = taskLayoutIdentity(left.task).localeCompare(taskLayoutIdentity(right.task));
  if (identity !== 0) return identity;

  const kind = left.kind.localeCompare(right.kind);
  if (kind !== 0) return kind;
  const leftDate = left.kind === 'span' ? left.segments[0]?.date : left.date;
  const rightDate = right.kind === 'span' ? right.segments[0]?.date : right.date;
  return String(leftDate).localeCompare(String(rightDate));
}

function candidateDates(candidate: MonthCandidate): readonly string[] {
  return candidate.kind === 'span'
    ? candidate.segments.map((segment) => segment.date)
    : [candidate.date];
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
      const compactByDate = new Map<string, MonthCompactSlot[]>(rowDates.map((date) => [date, []]));
      const spanByIdentity = new Map<string, Extract<MonthCandidate, { kind: 'span' }>>();
      for (const segment of sharedRow.segments) {
        const existing = spanByIdentity.get(segment.identity);
        if (existing) {
          existing.segments.push(segment);
        } else {
          spanByIdentity.set(segment.identity, {
            kind: 'span',
            task: segment.task,
            segments: [segment],
          });
        }
      }
      const candidates: MonthCandidate[] = [...spanByIdentity.values()];
      let slotCount = 0;

      for (const date of rowDates) {
        const { timed, plain, deadlines } = bucketTasksForDate([...tasks], date);
        candidates.push(
          ...plain.map((task): MonthCandidate => ({ kind: 'plain', task, date })),
          ...timed.map((task): MonthCandidate => ({ kind: 'timed', task, date })),
          ...deadlines.map((task): MonthCandidate => ({ kind: 'deadline', task, date })),
        );
      }

      // Candidates use one row-wide ordering. A candidate is placed below every earlier candidate
      // with which it shares a date; a span therefore reserves that same lane on all of its days.
      // The intentional holes on quieter days are what prevent a local item from making a span
      // jump vertically midway through the week row.
      const occupiedByDate = new Map<string, number[]>(rowDates.map((date) => [date, []]));
      candidates.sort(compareCandidates);
      for (const candidate of candidates) {
        const candidateRowDates = candidateDates(candidate);
        const occupied = candidateRowDates.flatMap((date) => occupiedByDate.get(date) ?? []);
        const slot = Math.max(-1, ...occupied) + 1;
        for (const date of candidateRowDates) occupiedByDate.get(date)?.push(slot);
        slotCount = Math.max(slotCount, slot + 1);

        if (candidate.kind === 'span') {
          segments.push(...candidate.segments.map((segment) => ({ ...segment, lane: slot })));
        } else {
          compactByDate
            .get(candidate.date)
            ?.push({ task: candidate.task, kind: candidate.kind, slot });
        }
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
