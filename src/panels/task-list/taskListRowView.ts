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
export interface MountedTaskListRows {
  readonly rows: TaskListRows;
  /** The mounted header or card of `key`; undefined for a key this render did not mount. */
  element(key: string): HTMLElement | undefined;
  /** The mounted cards with their keys, in row order. */
  cards(): Iterable<readonly [key: string, card: HTMLElement]>;
}

function mountGroupHeader(container: HTMLElement, row: TaskListGroupRow): HTMLElement {
  return container.createDiv({
    cls: row.first ? 'abyss-group-header abyss-group-header--first' : 'abyss-group-header',
    text: `${row.label}  ${row.count}`,
  });
}

function mountRow(
  container: HTMLElement,
  row: TaskListRow,
  renderTask: (container: HTMLElement, row: TaskListTaskRow) => HTMLElement,
): HTMLElement {
  return row.kind === 'group' ? mountGroupHeader(container, row) : renderTask(container, row);
}

/**
 * Appends one element per row, in row order, as direct children of `container`: a header for a
 * group row, and for a task row the card `renderTask` appends and returns.
 */
export function mountTaskListRows(
  container: HTMLElement,
  rows: TaskListRows,
  renderTask: (container: HTMLElement, row: TaskListTaskRow) => HTMLElement,
): MountedTaskListRows {
  const elements = new Map<string, HTMLElement>();
  const cards: Array<readonly [string, HTMLElement]> = [];
  for (const row of rows.rows) {
    const element = mountRow(container, row, renderTask);
    elements.set(row.key, element);
    if (row.kind === 'task') cards.push([row.key, element]);
  }
  return {
    rows,
    element: (key) => elements.get(key),
    cards: () => cards,
  };
}

/** Nothing mounted: the handle before the first list render and outside the three surfaces. */
export const NO_MOUNTED_TASK_LIST_ROWS: MountedTaskListRows = {
  rows: NO_TASK_LIST_ROWS,
  element: () => undefined,
  cards: () => [],
};
