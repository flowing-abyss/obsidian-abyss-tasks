import type { TaskSearchOccurrence } from '../../task-lists/taskSearchOrganization';
import { TaskSearchError, taskSearchAddressKey } from '../../tasks';
import type { RowViewportSource } from '../virtualization/rowViewport';
import { indexedRows, type TaskListRows } from './taskListRows';
import type { TaskOccurrenceRange, TaskSelectionSpans } from './taskOccurrenceSelection';

export interface TaskRevealRowsInput {
  readonly occurrence: TaskSearchOccurrence;
  readonly kind: 'navigation' | 'creation';
  readonly receiptId: string;
  readonly generation: number;
  readonly ownerRootPresent: boolean;
}
export interface TaskRevealRowsResult {
  readonly rows: TaskListRows<TaskSearchOccurrence>;
  readonly revealIndex: number;
  readonly addedNodeCount: 0 | 1;
  readonly addedRootCount: 0 | 1;
}
function selectionPart(
  selection: TaskSelectionSpans,
  rows: TaskListRows<TaskSearchOccurrence>,
  offset: number,
): TaskSelectionSpans {
  return {
    ...(selection.ranges === undefined ? {} : { ranges: selection.ranges }),
    spans: selection.spans
      .filter((s) => Number.isSafeInteger(s.from) && Number.isSafeInteger(s.to))
      .map((s) => ({
        from: Math.max(0, s.from - offset),
        to: Math.min(rows.taskCount - 1, s.to - offset),
      }))
      .filter((s) => s.from <= s.to),
    include: selection.include.filter((key) => rows.indexOf(key) >= 0),
    exclude: selection.exclude.filter((key) => rows.indexOf(key) >= 0),
  };
}
/** Compose one finite receipt tail, retaining the complete base index untouched. */
export function withTaskRevealRows(
  base: TaskListRows<TaskSearchOccurrence>,
  input: TaskRevealRowsInput,
): TaskRevealRowsResult {
  const address = taskSearchAddressKey(input.occurrence.address);
  const existing = base.firstOccurrenceOf(input.occurrence.taskKey);
  if (existing !== undefined) {
    const occurrence = base.task(existing);
    if (occurrence === undefined || taskSearchAddressKey(occurrence.address) !== address)
      throw new TaskSearchError('stale', 'Reveal target changed');
    return {
      rows: base,
      revealIndex: base.indexOf(existing),
      addedNodeCount: 0,
      addedRootCount: 0,
    };
  }
  const group = {
    key: JSON.stringify(['task-reveal-group', input.kind, input.receiptId]),
    label: input.kind === 'creation' ? 'Created task' : 'Revealed task',
  };
  const occurrence: TaskSearchOccurrence = {
    ...input.occurrence,
    key: JSON.stringify(['task-reveal', input.kind, input.receiptId, address]),
    group,
    presentation: {
      kind: 'node',
      completion: { kind: 'allowed' },
      ...(input.occurrence.presentation.interval === undefined
        ? {}
        : { interval: input.occurrence.presentation.interval }),
    },
  };
  const tail = indexedRows([
    { kind: 'group', ...group, count: 1, first: base.rowCount === 0 },
    {
      kind: 'task',
      key: occurrence.key,
      taskKey: occurrence.taskKey,
      task: occurrence,
      presentation: occurrence.presentation,
    },
  ]);
  const rows = composeRevealRows(
    base,
    tail,
    JSON.stringify([
      'reveal-overlay',
      base.revision,
      input.generation,
      input.kind,
      input.receiptId,
      address,
    ]),
  );
  return {
    rows,
    revealIndex: base.taskCount,
    addedNodeCount: 1,
    addedRootCount: input.ownerRootPresent ? 0 : 1,
  };
}

function composeRevealRows(
  base: TaskListRows<TaskSearchOccurrence>,
  tail: TaskListRows<TaskSearchOccurrence>,
  revision: string,
): TaskListRows<TaskSearchOccurrence> {
  const owning = (key: string): TaskListRows<TaskSearchOccurrence> =>
    base.rowIndexOf(key) >= 0 ? base : tail;
  const index = (key: string, kind: 'rows' | 'tasks'): number => {
    const first = kind === 'rows' ? base.rowIndexOf(key) : base.indexOf(key);
    if (first >= 0) return first;
    const second = kind === 'rows' ? tail.rowIndexOf(key) : tail.indexOf(key);
    const offset = kind === 'rows' ? base.rowCount : base.taskCount;
    return second < 0 ? -1 : second + offset;
  };
  const survivor = (
    previous: number,
    direction: 1 | -1,
    current: RowViewportSource,
  ): string | undefined => {
    if (previous < base.rowCount) {
      const found = base.survivingNeighbor(previous, direction, current);
      if (found !== undefined || direction === -1) return found;
      return tail.survivingNeighbor(-1, 1, current);
    }
    const found = tail.survivingNeighbor(previous - base.rowCount, direction, current);
    return (
      found ?? (direction === -1 ? base.survivingNeighbor(base.rowCount, -1, current) : undefined)
    );
  };
  const rows: TaskListRows<TaskSearchOccurrence> = {
    revision,
    rowCount: base.rowCount + 2,
    taskCount: base.taskCount + 1,
    rowAt: (i) => (i < base.rowCount ? base.rowAt(i) : tail.rowAt(i - base.rowCount)),
    taskKeyAt: (i) => (i < base.taskCount ? base.taskKeyAt(i) : tail.taskKeyAt(i - base.taskCount)),
    rowIndexOf: (key) => index(key, 'rows'),
    indexOf: (key) => index(key, 'tasks'),
    task: (key) => owning(key).task(key),
    physicalKey: (key) => owning(key).physicalKey(key),
    firstOccurrenceOf: (key) => base.firstOccurrenceOf(key) ?? tail.firstOccurrenceOf(key),
    *slice(from, to) {
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) return;
      yield* base.slice(Math.max(0, from), Math.min(base.rowCount, to));
      yield* tail.slice(Math.max(0, from - base.rowCount), to - base.rowCount);
    },
    captureSelection: (selection) => [
      ...base.captureSelection(selectionPart(selection, base, 0)),
      ...tail.captureSelection(selectionPart(selection, tail, base.taskCount)),
    ],
    firstSelectedKey: (ranges) => base.firstSelectedKey(ranges) ?? tail.firstSelectedKey(ranges),
    selectedCount: (ranges) => base.selectedCount(ranges) + tail.selectedCount(ranges),
    isSelected: (key, ranges) => owning(key).isSelected(key, ranges),
    selectedNodes: (ranges: readonly TaskOccurrenceRange[]) => {
      const values = new Map(base.selectedNodes(ranges).map((value) => [value.taskKey, value]));
      for (const value of tail.selectedNodes(ranges)) {
        const previous = values.get(value.taskKey);
        if (previous === undefined) values.set(value.taskKey, value);
        else if (value.completion.kind === 'allowed')
          values.set(value.taskKey, { ...previous, completion: value.completion });
      }
      return [...values.values()];
    },
    estimatedOffset: (i, heights) =>
      i <= base.rowCount
        ? base.estimatedOffset(i, heights)
        : base.estimatedOffset(base.rowCount, heights) +
          tail.estimatedOffset(i - base.rowCount, heights),
    anchorRanges: () => [...base.anchorRanges(), ...tail.anchorRanges()],
    survivingNeighbor: survivor,
  };
  return rows;
}
