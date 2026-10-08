import { setIcon } from 'obsidian';
import { moment } from '../../obsidianMoment';
import type { LocalDate, TaskSnapshot } from '../../tasks';
import type { TaskRenderOutcome, TaskRenderScope } from '../../ui/taskRenderScope';
import {
  NO_TASK_LIST_ROWS,
  type TaskListGroupRow,
  type TaskListRow,
  type TaskListRows,
  type TaskListTaskRow,
} from './taskListRows';
import type { TaskRowMount } from './TaskListSurface';

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

export type DateGroupCapture = (date: LocalDate) => void;

export function mountGroupHeader<T = TaskSnapshot>(
  container: HTMLElement,
  row: TaskListGroupRow,
  onCapture?: DateGroupCapture,
): TaskRowMount<T> {
  const element = container.createDiv({ cls: 'abyss-group-header' });
  const label = element.createSpan({ cls: 'abyss-group-label' });
  let current = row;
  let button: HTMLButtonElement | undefined;
  let live = true;
  const click = (event: MouseEvent): void => {
    event.stopPropagation();
    if (live && current.dateGroup?.date !== undefined) onCapture?.(current.dateGroup.date);
  };
  const retireButton = (): void => {
    button?.removeEventListener('click', click);
    button?.remove();
    button = undefined;
  };
  const update = (next: TaskListRow<T>): void => {
    if (!live || next.kind !== 'group') return;
    current = next;
    label.textContent = next.dateGroup === undefined ? `${next.label}  ${next.count}` : next.label;
    element.toggleClass('abyss-group-header--first', next.first);
    if (next.sourcePath === undefined) element.removeAttribute('aria-label');
    else element.setAttribute('aria-label', next.sourcePath);
    const date = next.dateGroup?.date;
    if (date === undefined || onCapture === undefined) {
      retireButton();
      return;
    }
    if (button === undefined) {
      button = element.createEl('button', {
        cls: 'clickable-icon abyss-group-add',
        attr: { type: 'button' },
      });
      setIcon(button, 'plus');
      button.addEventListener('click', click);
    }
    button.setAttribute('aria-label', `Add task on ${moment(date, 'YYYY-MM-DD').format('LL')}`);
  };
  update(row);
  return {
    element,
    update,
    destroy: () => {
      live = false;
      retireButton();
      element.remove();
    },
  };
}

export function mountTaskListRow<T = TaskSnapshot>(
  container: HTMLElement,
  row: TaskListRow<T>,
  renderTask: (container: HTMLElement, row: TaskListTaskRow<T>) => HTMLElement,
): HTMLElement {
  return row.kind === 'group'
    ? mountGroupHeader(container, row).element
    : renderTask(container, row);
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
