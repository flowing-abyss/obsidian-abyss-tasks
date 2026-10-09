import { shiftLocalDate, type LocalDate, type TaskOccurrenceCompletion } from '../../tasks';

/** Inclusive positions in the header-free task order. */
export interface TaskOrderSpan {
  readonly from: number;
  readonly to: number;
}

export type TaskOccurrenceRange =
  | {
      readonly kind: 'dates';
      readonly taskKey: string;
      readonly occurrenceKind: 'today' | 'daily';
      readonly groupKey: string;
      readonly from: LocalDate;
      readonly to: LocalDate;
    }
  | { readonly kind: 'group'; readonly taskKey: string; readonly groupKey: string };

export interface TaskSelectionSpans {
  /** Canonical base from an earlier order, intersected with the receiving rows. */
  readonly ranges?: readonly TaskOccurrenceRange[];
  readonly spans: readonly TaskOrderSpan[];
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

export interface TaskSelectedValue<T> {
  readonly taskKey: string;
  readonly task: T;
  readonly completion: TaskOccurrenceCompletion;
}

function rangeIdentity(range: TaskOccurrenceRange): string {
  return JSON.stringify([
    range.taskKey,
    range.kind,
    range.groupKey,
    range.kind === 'dates' ? range.occurrenceKind : '',
  ]);
}
function compareRanges(a: TaskOccurrenceRange, b: TaskOccurrenceRange): number {
  const left = rangeIdentity(a),
    right = rangeIdentity(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return a.kind === 'dates' && b.kind === 'dates' ? a.from.localeCompare(b.from) : 0;
}
function mergedRange(
  previous: TaskOccurrenceRange | undefined,
  range: TaskOccurrenceRange,
): TaskOccurrenceRange | undefined {
  if (previous === undefined || rangeIdentity(previous) !== rangeIdentity(range)) return undefined;
  if (previous.kind === 'group' || range.kind === 'group') return previous;
  if (previous.to < range.from && shiftLocalDate(previous.to, 1) !== range.from) return undefined;
  return { ...previous, to: previous.to > range.to ? previous.to : range.to };
}
/** Canonical union; descriptor count depends on nodes and fragments, never interval length. */
export function normalizeOccurrenceRanges(
  ranges: readonly TaskOccurrenceRange[],
): readonly TaskOccurrenceRange[] {
  const result: TaskOccurrenceRange[] = [];
  for (const range of [...ranges].sort(compareRanges)) {
    const merged = mergedRange(result[result.length - 1], range);
    if (merged === undefined) result.push({ ...range });
    else result[result.length - 1] = merged;
  }
  return result;
}
