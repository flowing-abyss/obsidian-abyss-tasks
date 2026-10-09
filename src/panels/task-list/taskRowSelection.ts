import type { TaskListOrder, TaskListRows } from './taskListRows';
import type {
  TaskOccurrenceRange,
  TaskOrderSpan,
  TaskSelectedValue,
} from './taskOccurrenceSelection';

/** Where keyboard selection starts when the selection's own focus is not listed. */
export interface TaskRowOrigin {
  readonly target?: string | undefined;
  readonly detail?: string | undefined;
}
export interface TaskSelectionRebase {
  /** Only identity transitions proved by the owning source reconciliation. */
  readonly physicalKeys: ReadonlyMap<string, string>;
}
function listed(key: string | null | undefined, order: TaskListOrder): key is string {
  return key != null && key !== '' && order.indexOf(key) !== -1;
}

/** One immutable logical order, compact spans, and sparse click exceptions. */
export class TaskRowSelection {
  #rows: TaskListRows<unknown> | undefined;
  #order: TaskListOrder | undefined;
  #spans: readonly TaskOrderSpan[] = [];
  #base: readonly TaskOccurrenceRange[] = [];
  #captured: readonly TaskOccurrenceRange[] | undefined;
  readonly #include = new Set<string>();
  readonly #exclude = new Set<string>();
  #anchor: string | null = null;
  #focus: string | null = null;

  bind<T>(rows: TaskListRows<T>, proof?: TaskSelectionRebase): void {
    if (this.#rows === rows) return;
    const previous = this.#rows;
    if (previous === undefined) {
      this.#rows = rows;
      this.#order = rows;
      this.#captured = undefined;
      return;
    }
    const ranges = this.ranges();
    const remap = (range: TaskOccurrenceRange): TaskOccurrenceRange[] => {
      const before = previous.firstOccurrenceOf(range.taskKey);
      const after = rows.firstOccurrenceOf(range.taskKey);
      const unchanged =
        before !== undefined &&
        after !== undefined &&
        Object.is(previous.task(before), rows.task(after));
      const taskKey =
        proof?.physicalKeys.get(range.taskKey) ?? (unchanged ? range.taskKey : undefined);
      return taskKey === undefined ? [] : [{ ...range, taskKey }];
    };
    const lead = (key: string | null): readonly TaskOccurrenceRange[] =>
      key === null
        ? []
        : previous.captureSelection({ spans: [], include: [key], exclude: [] }).flatMap(remap);
    const anchor = lead(this.#anchor),
      focus = lead(this.#focus);
    this.#resetMembership();
    this.#base = rows.captureSelection({
      ranges: ranges.flatMap(remap),
      spans: [],
      include: [],
      exclude: [],
    });
    this.#rows = rows;
    this.#order = rows;
    const first = rows.firstSelectedKey(this.#base) ?? null;
    this.#anchor = rows.firstSelectedKey(anchor) ?? first;
    this.#focus = rows.firstSelectedKey(focus) ?? first;
  }

  ranges(): readonly TaskOccurrenceRange[] {
    if (this.#rows === undefined) return [];
    this.#captured ??= this.#rows.captureSelection({
      ranges: this.#base,
      spans: this.#spans,
      include: [...this.#include],
      exclude: [...this.#exclude],
    });
    return this.#captured;
  }
  selectedNodes<T>(rows: TaskListRows<T>): ReadonlyArray<TaskSelectedValue<T>> {
    return rows.selectedNodes(this.ranges());
  }
  get size(): number {
    if (this.#rows !== undefined) return this.#rows.selectedCount(this.ranges());
    let count = this.#spans.reduce((total, span) => total + span.to - span.from + 1, 0);
    for (const key of this.#include) if (!this.#inSpan(key)) count++;
    for (const key of this.#exclude) if (this.#inSpan(key)) count--;
    return count;
  }
  get anchor(): string | null {
    return this.#anchor;
  }
  get focus(): string | null {
    return this.#focus;
  }
  has(key: string): boolean {
    if (this.#rows !== undefined && this.#rows.indexOf(key) < 0) return false;
    if (this.#exclude.has(key)) return false;
    if (this.#include.has(key)) return true;
    return this.#rows !== undefined ? this.#rows.isSelected(key, this.ranges()) : this.#inSpan(key);
  }
  #inSpan(key: string): boolean {
    const index = this.#order?.indexOf(key) ?? -1;
    return index >= 0 && this.#spans.some((span) => span.from <= index && index <= span.to);
  }
  isActive(): boolean {
    return this.size > 0 || this.#anchor !== null || this.#focus !== null;
  }
  #resetMembership(): void {
    this.#spans = [];
    this.#base = [];
    this.#captured = undefined;
    this.#include.clear();
    this.#exclude.clear();
  }
  clear(): void {
    this.#resetMembership();
    this.#anchor = null;
    this.#focus = null;
  }
  collapseTo(key: string): void {
    this.#resetMembership();
    this.#anchor = key;
    this.#focus = key;
  }
  toggle(key: string): void {
    if (this.has(key)) this.delete(key);
    else {
      this.#exclude.delete(key);
      this.#include.add(key);
      this.#captured = undefined;
    }
    this.#anchor = key;
    this.#focus = key;
  }
  extendTo(key: string, order: TaskListOrder, fallback?: string): void {
    if (!this.#accepts(order)) return;
    const anchor = listed(this.#anchor, order) ? this.#anchor : (fallback ?? key);
    this.#anchor = anchor;
    this.#focus = key;
    this.#resetMembership();
    this.#order = order;
    const from = order.indexOf(anchor),
      to = order.indexOf(key);
    if (from >= 0 && to >= 0) this.#spans = [{ from: Math.min(from, to), to: Math.max(from, to) }];
  }
  selectAll(order: TaskListOrder, origin: TaskRowOrigin): void {
    if (!this.#accepts(order)) return;
    const focus = [this.#focus, origin.target, origin.detail, order.taskKeyAt(0)].find(
      (candidate): candidate is string => listed(candidate, order),
    );
    if (focus === undefined) {
      this.clear();
      return;
    }
    this.#resetMembership();
    this.#order = order;
    this.#spans = [{ from: 0, to: order.taskCount - 1 }];
    if (!listed(this.#anchor, order)) this.#anchor = focus;
    this.#focus = focus;
  }
  #accepts(order: TaskListOrder): boolean {
    return this.#rows === undefined || this.#rows.revision === order.revision;
  }
  #origin(order: TaskListOrder, origin: TaskRowOrigin): string | undefined {
    return [this.#focus, origin.target, origin.detail].find((candidate): candidate is string =>
      listed(candidate, order),
    );
  }
  move(
    direction: 'up' | 'down',
    order: TaskListOrder,
    origin: TaskRowOrigin,
    extend: boolean,
  ): string | undefined {
    if (!this.#accepts(order)) return undefined;
    const current = this.#origin(order, origin);
    const index = current === undefined ? -1 : order.indexOf(current);
    const first = direction === 'down' ? 0 : order.taskCount - 1;
    const step = direction === 'down' ? 1 : -1;
    const nextIndex = index < 0 ? first : Math.max(0, Math.min(order.taskCount - 1, index + step));
    const next = order.taskKeyAt(nextIndex);
    if (next === undefined) return undefined;
    if (extend) this.extendTo(next, order, current);
    else this.collapseTo(next);
    return next;
  }
  moveEdge(
    edge: 'first' | 'last',
    order: TaskListOrder,
    origin: TaskRowOrigin,
    extend: boolean,
  ): string | undefined {
    if (!this.#accepts(order)) return undefined;
    const next = order.taskKeyAt(edge === 'first' ? 0 : order.taskCount - 1);
    if (next === undefined) return undefined;
    if (extend) this.extendTo(next, order, this.#origin(order, origin));
    else this.collapseTo(next);
    return next;
  }
  /** Compatibility for finite generic orders; occurrence consumers bind their full rows. */
  reconcile(order: TaskListOrder): void {
    if (this.#rows !== undefined) return;
    const kept = this.inOrder(this.#order ?? order).filter((key) => listed(key, order));
    this.#resetMembership();
    this.#order = order;
    for (const key of kept) this.#include.add(key);
    const first = this.inOrder(order)[0] ?? null;
    if (!listed(this.#anchor, order)) this.#anchor = first;
    if (!listed(this.#focus, order)) this.#focus = first;
  }
  /** Legacy finite inspection only. Production bulk consumers use selectedNodes/ranges. */
  inOrder(order: TaskListOrder): string[] {
    const keys = new Set(this.#include);
    for (const span of this.#spans)
      for (let i = span.from; i <= span.to; i++) {
        const key = this.#order?.taskKeyAt(i);
        if (key !== undefined) keys.add(key);
      }
    this.#appendBoundKeys(order, keys);
    return [...keys]
      .filter((key) => !this.#exclude.has(key) && listed(key, order))
      .sort((a, b) => order.indexOf(a) - order.indexOf(b));
  }
  #appendBoundKeys(order: TaskListOrder, keys: Set<string>): void {
    if (this.#rows === undefined) return;
    for (let index = 0; index < order.taskCount; index++) {
      const key = order.taskKeyAt(index);
      if (key !== undefined && this.has(key)) keys.add(key);
    }
  }
  delete(key: string): void {
    this.#include.delete(key);
    this.#exclude.add(key);
    this.#captured = undefined;
  }
  replaceWith(keys: Iterable<string>): void {
    this.#resetMembership();
    for (const key of keys) this.#include.add(key);
    this.#anchor = this.#include.values().next().value ?? null;
    this.#focus = this.#anchor;
  }
  /** Archive drops every selected copy of a removed physical node. */
  deleteNode(taskKey: string): void {
    this.#replaceRanges(this.ranges().filter((range) => range.taskKey !== taskKey));
  }
  /** Preserve only canonical fragments still selected after a physical removal. */
  #replaceRanges(ranges: readonly TaskOccurrenceRange[]): void {
    this.#resetMembership();
    this.#base = ranges;
    this.#captured = ranges;
    this.#anchor = this.#rows?.firstSelectedKey(ranges) ?? null;
    this.#focus = this.#anchor;
  }
}
