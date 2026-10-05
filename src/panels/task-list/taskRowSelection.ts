import type { TaskListOrder } from './taskListRows';

/** Where keyboard selection starts when the selection's own focus is not listed. */
interface TaskRowOrigin {
  /** The card the key event came from. */
  readonly target?: string | undefined;
  /** The card of the task open in the detail pane. */
  readonly detail?: string | undefined;
}

function listed(key: string | null | undefined, order: TaskListOrder): key is string {
  return key != null && key !== '' && order.indexOf(key) !== -1;
}

function nextKey(
  direction: 'up' | 'down',
  order: TaskListOrder,
  current: string | undefined,
): string | undefined {
  const keys = order.taskKeys;
  const index = current === undefined ? -1 : order.indexOf(current);
  if (index === -1) return direction === 'down' ? keys[0] : keys[keys.length - 1];
  const step = direction === 'down' ? 1 : -1;
  return keys[Math.max(0, Math.min(keys.length - 1, index + step))];
}

/**
 * The centre list's multi-selection: the selected row keys in the order they were added, the
 * anchor a range grows from, and the focus the keyboard moves from. It reads the list only through
 * the order it is handed, never from the DOM.
 */
export class TaskRowSelection {
  readonly #selected = new Set<string>();
  #anchor: string | null = null;
  #focus: string | null = null;

  get size(): number {
    return this.#selected.size;
  }

  get anchor(): string | null {
    return this.#anchor;
  }

  get focus(): string | null {
    return this.#focus;
  }

  has(key: string): boolean {
    return this.#selected.has(key);
  }

  /** Whether Escape has anything to clear: a selected key, an anchor, or a focus. */
  isActive(): boolean {
    return this.#selected.size > 0 || this.#anchor !== null || this.#focus !== null;
  }

  clear(): void {
    this.#selected.clear();
    this.#anchor = null;
    this.#focus = null;
  }

  /** A plain click or arrow: nothing selected, and the next range starts at `key`. */
  collapseTo(key: string): void {
    this.#selected.clear();
    this.#anchor = key;
    this.#focus = key;
  }

  /** Ctrl or Cmd click: flips `key`, which becomes the anchor even when it leaves the selection. */
  toggle(key: string): void {
    if (this.#selected.has(key)) this.#selected.delete(key);
    else this.#selected.add(key);
    this.#anchor = key;
    this.#focus = key;
  }

  /**
   * Shift: selects the rows between the anchor and `key` in display order, replacing any older
   * range. An unlisted anchor gives way to `fallback`, or to `key` itself.
   */
  extendTo(key: string, order: TaskListOrder, fallback?: string): void {
    const anchor = listed(this.#anchor, order) ? this.#anchor : (fallback ?? key);
    this.#anchor = anchor;
    this.#focus = key;
    this.#selected.clear();
    const from = order.indexOf(anchor);
    const to = order.indexOf(key);
    if (from === -1 || to === -1) return;
    const range = order.taskKeys.slice(Math.min(from, to), Math.max(from, to) + 1);
    for (const listedKey of range) this.#selected.add(listedKey);
  }

  /** Select the complete display order without moving a surviving range or keyboard lead. */
  selectAll(order: TaskListOrder, origin: TaskRowOrigin): void {
    const focus = [this.#focus, origin.target, origin.detail, order.taskKeys[0]].find(
      (candidate): candidate is string => listed(candidate, order),
    );
    if (focus === undefined) {
      this.clear();
      return;
    }
    this.#selected.clear();
    for (const key of order.taskKeys) this.#selected.add(key);
    if (!listed(this.#anchor, order)) this.#anchor = focus;
    this.#focus = focus;
  }

  /**
   * An arrow key: one step from the first listed of the focus, the event's card, and the detail
   * card; with none of them, the first row going down or the last going up. It never wraps. Shift
   * extends from the anchor, or from where the move began. Returns the new key, or undefined for
   * an empty order.
   */
  move(
    direction: 'up' | 'down',
    order: TaskListOrder,
    origin: TaskRowOrigin,
    extend: boolean,
  ): string | undefined {
    const current = [this.#focus, origin.target, origin.detail].find(
      (candidate): candidate is string => listed(candidate, order),
    );
    const next = nextKey(direction, order, current);
    if (next === undefined) return undefined;
    if (extend) this.extendTo(next, order, current);
    else this.collapseTo(next);
    return next;
  }

  /** After a render: drops unlisted keys and moves an unlisted anchor or focus to the first kept. */
  reconcile(order: TaskListOrder): void {
    for (const key of [...this.#selected]) {
      if (order.indexOf(key) === -1) this.#selected.delete(key);
    }
    const first = order.taskKeys.find((key) => this.#selected.has(key)) ?? null;
    if (!listed(this.#anchor, order)) this.#anchor = first;
    if (!listed(this.#focus, order)) this.#focus = first;
  }

  /** The selected keys in display order, whatever order they were added in. */
  inOrder(order: TaskListOrder): string[] {
    return order.taskKeys.filter((key) => this.#selected.has(key));
  }

  /** Archive: drops one key that left the list. */
  delete(key: string): void {
    this.#selected.delete(key);
  }

  /** Archive: the remaining selection under its keys after a write; the first leads. */
  replaceWith(keys: Iterable<string>): void {
    this.#selected.clear();
    for (const key of keys) this.#selected.add(key);
    const first = this.#selected.values().next();
    const lead = first.done === true ? null : first.value;
    this.#anchor = lead;
    this.#focus = lead;
  }
}
