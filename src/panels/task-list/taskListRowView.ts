import type { TaskSnapshot } from '../../tasks';
import type { TaskRenderOutcome, TaskRenderScope } from '../../ui/taskRenderScope';
import {
  NO_TASK_LIST_ROWS,
  type TaskListGroupRow,
  type TaskListRow,
  type TaskListRows,
  type TaskListTaskRow,
} from './taskListRows';

/**
 * The rows one render mounted. It is the only map from row keys to elements, so a later windowed
 * renderer can replace the mount by implementing this contract for the rows it mounts.
 */
export interface MountedTaskListRows<T = TaskSnapshot> {
  readonly rows: TaskListRows<T>;
  /** The mounted header or card of `key`; undefined for a key this render did not mount. */
  element(key: string): HTMLElement | undefined;
  /** The mounted cards with their keys, in row order. */
  cards(): Iterable<readonly [key: string, card: HTMLElement]>;
}

function mountGroupHeader(container: HTMLElement, row: TaskListGroupRow): HTMLElement {
  const header = container.createDiv({
    cls: row.first ? 'abyss-group-header abyss-group-header--first' : 'abyss-group-header',
    text: `${row.label}  ${row.count}`,
  });
  if (row.sourcePath !== undefined) header.setAttribute('aria-label', row.sourcePath);
  return header;
}

export function mountTaskListRow<T = TaskSnapshot>(
  container: HTMLElement,
  row: TaskListRow<T>,
  renderTask: (container: HTMLElement, row: TaskListTaskRow<T>) => HTMLElement,
): HTMLElement {
  return row.kind === 'group' ? mountGroupHeader(container, row) : renderTask(container, row);
}

/**
 * Appends one element per row, in row order, as direct children of `container`: a header for a
 * group row, and for a task row the card `renderTask` appends and returns.
 */
export function mountTaskListRows<T = TaskSnapshot>(
  container: HTMLElement,
  rows: TaskListRows<T>,
  renderTask: (container: HTMLElement, row: TaskListTaskRow<T>) => HTMLElement,
  scope?: TaskRenderScope,
): MountedTaskListRows<T> & { readonly settled: Promise<TaskRenderOutcome>; cancel(): void } {
  const elements = new Map<string, HTMLElement>();
  const cards: Array<readonly [string, HTMLElement]> = [];
  for (const row of rows.slice(0, rows.rowCount)) {
    const element = mountTaskListRow(container, row, renderTask);
    elements.set(row.key, element);
    if (row.kind === 'task') cards.push([row.key, element]);
  }
  return {
    rows,
    settled: scope?.finish() ?? Promise.resolve({ type: 'ready' }),
    cancel: () => {
      scope?.cancel();
    },
    element: (key) => elements.get(key),
    cards: () => cards,
  };
}

/** Nothing mounted: the handle before the first card render and at the start of each one. */
export const NO_MOUNTED_TASK_LIST_ROWS: MountedTaskListRows<never> = {
  rows: NO_TASK_LIST_ROWS,
  element: () => undefined,
  cards: () => [],
};
