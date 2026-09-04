import type { TaskSnapshot } from '../tasks';
import { calendarTaskWithPlanning } from './calendarOccurrences';
import { layoutVisibleSpans, type VisibleSpanRow, type VisibleSpanSegment } from './spanLayout';
import { taskLayoutIdentity } from './timegrid/layout';
import { bucketTasksForDate } from './TodayView';

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
  return candidate.task.planning.time != null ? 0 : 1;
}

function compareCandidates(left: MonthCandidate, right: MonthCandidate): number {
  const orders = [
    candidateGroup(left) - candidateGroup(right),
    (left.task.planning.time ?? '').localeCompare(right.task.planning.time ?? ''),
    taskLayoutIdentity(left.task).localeCompare(taskLayoutIdentity(right.task)),
    left.kind.localeCompare(right.kind),
    String(candidateFirstDate(left)).localeCompare(String(candidateFirstDate(right))),
  ];
  return orders.find((order) => order !== 0) ?? 0;
}

function candidateFirstDate(candidate: MonthCandidate): string | undefined {
  return candidate.kind === 'span' ? candidate.segments[0]?.date : candidate.date;
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
    rows: sharedRows.map((sharedRow, rowIndex) =>
      layoutMonthRow(tasks, dates, sharedRow, rowIndex),
    ),
  };
}

function layoutMonthRow(
  tasks: readonly TaskSnapshot[],
  dates: readonly string[],
  sharedRow: VisibleSpanRow,
  rowIndex: number,
): MonthVisibleRow {
  const rowDates = dates.slice(rowIndex * 7, rowIndex * 7 + 7);
  const candidates = spanCandidates(sharedRow);
  appendCompactCandidates(candidates, tasks, rowDates);
  const placement = placeCandidates(candidates, rowDates);
  return {
    spanRow: {
      ...sharedRow,
      laneCount: placement.slotCount,
      segments: placement.segments,
    },
    compactByDate: placement.compactByDate,
    slotCount: placement.slotCount,
  };
}

function spanCandidates(sharedRow: VisibleSpanRow): MonthCandidate[] {
  const byIdentity = new Map<string, Extract<MonthCandidate, { kind: 'span' }>>();
  for (const segment of sharedRow.segments) {
    const existing = byIdentity.get(segment.identity);
    if (existing !== undefined) existing.segments.push(segment);
    else
      byIdentity.set(segment.identity, { kind: 'span', task: segment.task, segments: [segment] });
  }
  return [...byIdentity.values()];
}

function appendCompactCandidates(
  candidates: MonthCandidate[],
  tasks: readonly TaskSnapshot[],
  rowDates: readonly string[],
): void {
  for (const date of rowDates) {
    const { timed, plain, deadlines } = bucketTasksForDate([...tasks], date);
    candidates.push(
      ...plain.map((task): MonthCandidate => ({ kind: 'plain', task, date })),
      ...timed.map((task): MonthCandidate => ({ kind: 'timed', task, date })),
      ...deadlines.map((task): MonthCandidate => ({ kind: 'deadline', task, date })),
    );
  }
}

interface MonthPlacement {
  readonly segments: readonly VisibleSpanSegment[];
  readonly compactByDate: ReadonlyMap<string, readonly MonthCompactSlot[]>;
  readonly slotCount: number;
}

function placeCandidates(
  candidates: MonthCandidate[],
  rowDates: readonly string[],
): MonthPlacement {
  const segments: VisibleSpanSegment[] = [];
  const compactByDate = new Map<string, MonthCompactSlot[]>(rowDates.map((date) => [date, []]));
  const occupiedByDate = new Map<string, number[]>(rowDates.map((date) => [date, []]));
  let slotCount = 0;
  // One row-wide order lets a span reserve the same lane across every date it
  // touches; intentional holes on quieter days prevent mid-week vertical jumps.
  candidates.sort(compareCandidates);
  for (const candidate of candidates) {
    const candidateRowDates = candidateDates(candidate);
    const occupied = candidateRowDates.flatMap((date) => occupiedByDate.get(date) ?? []);
    const slot = Math.max(-1, ...occupied) + 1;
    for (const date of candidateRowDates) occupiedByDate.get(date)?.push(slot);
    slotCount = Math.max(slotCount, slot + 1);
    addCandidateAtSlot(candidate, slot, segments, compactByDate);
  }
  return { segments, compactByDate, slotCount };
}

function addCandidateAtSlot(
  candidate: MonthCandidate,
  slot: number,
  segments: VisibleSpanSegment[],
  compactByDate: Map<string, MonthCompactSlot[]>,
): void {
  if (candidate.kind === 'span') {
    segments.push(...candidate.segments.map((segment) => ({ ...segment, lane: slot })));
    return;
  }
  compactByDate.get(candidate.date)?.push({ task: candidate.task, kind: candidate.kind, slot });
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
      taskLayoutIdentity(candidate) === identity
        ? calendarTaskWithPlanning(candidate, planning)
        : candidate,
    ),
    dates,
  );
}
