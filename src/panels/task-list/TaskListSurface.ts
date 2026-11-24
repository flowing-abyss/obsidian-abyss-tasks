import { Platform } from 'obsidian';
import type { TaskSnapshot } from '../../tasks';
import {
  LogicalScrollWindow,
  type LogicalScrollPlacement,
} from '../virtualization/logicalScrollWindow';
import {
  RowViewport,
  type InteractiveBuffer,
  type RowAnchor,
  type RowBounds,
  type RowMeasurement,
  type RowSegment,
  type RowViewportRow,
  type RowWindow,
  type ScrollBuffer,
} from '../virtualization/rowViewport';
import { bindTaskListTouch } from '../virtualization/taskListTouch';
import { bindTimelineWheel } from '../virtualization/timelineWheel';
import { isLargeScrollStep, onVerticalScrollIntent } from '../virtualization/verticalScrollIntent';
import { retainHeightSample, sampleTaskHeights, type TaskHeightSample } from './taskHeightSample';
import { indexedRows, type TaskListRow, type TaskListRows } from './taskListRows';
import type { MountedTaskListRows } from './taskListRowView';

export interface TaskRowMount<T = TaskSnapshot> {
  measurementReady?(scrolling?: boolean): boolean;
  readonly element: HTMLElement;
  update(row: TaskListRow<T>): void;
  destroy(): void;
}
export interface TaskRowHeights {
  readonly group: number;
  readonly task: number;
  readonly sampleOpeningTasks?: boolean;
}
export interface TaskListPresentation<T = TaskSnapshot> {
  readonly revision: string;
  readonly preserveAnchor: boolean;
  readonly indexedHeights?: TaskRowHeights;
  estimate(row: TaskListRow<T>): number;
  measurementRevision(row: TaskListRow<T>): string;
}
export interface TaskListSurfaceOptions<T = TaskSnapshot> {
  /** Sticky content excluded from the usable vertical viewport. */
  readonly viewportInset?: () => number;
  readonly viewportInsetElement?: HTMLElement;
  readonly openingOverscanPx?: number;
  /** Cached dimensions of a card column when its enclosing scroll track has an independent width. */
  readonly rowLayout?: () => { readonly width: number; readonly variant: string };
  /** Sample shared presentation geometry before a batch of row mounts or updates writes to the DOM. */
  readonly beforeRowWrites?: () => void;
  /** Rows whose content hydrates after mountedChanged can be assembled outside the live document. */
  readonly stagedMounts?: 'detached';
  readonly host: HTMLElement;
  readonly scroll: HTMLElement;
  mount(host: HTMLElement, row: TaskListRow<T>): TaskRowMount<T>;
  mountedChanged(): void;
  reportFailure(error: unknown): void;
}

export interface TaskListNativeWriteObserver {
  beforeWrite(top: number): boolean;
  afterWrite(top: number): void;
}
function spacerHeight(segment: RowSegment | undefined): number {
  return segment !== undefined && 'height' in segment ? segment.height : 0;
}

interface PinOwner {
  readonly onInvalidated?: (() => void) | undefined;
  readonly nativeWrite?: TaskListNativeWriteObserver | undefined;
}

interface CapturedPin {
  readonly key?: string;
  readonly token: PinOwner;
}

const maxRevealMeasurementPasses = 16;

interface RevealPlacement {
  readonly key: string;
  readonly alignTall: boolean;
  readonly onPending?: (() => void) | undefined;
  readonly current: () => boolean;
}

export interface TaskListScrollPosition {
  readonly taskHeightSample?: TaskHeightSample;
  readonly top: number;
  readonly anchor: RowAnchor | undefined;
}
interface TaskListScroll extends TaskListScrollPosition {
  readonly clampToExtent?: boolean;
  readonly revealKey?: string;
  readonly onPending?: () => void;
}

type FrameWork = 'scroll' | 'measure';

interface RenderedSegments {
  desired: HTMLElement[];
  keys: Set<string>;
  obsolete: HTMLElement[];
}

interface PaneSize {
  readonly height: number;
  readonly width: number;
  readonly inset: number;
  readonly visible: boolean;
  origin?: { readonly nativeTop: number; readonly offset: number };
}
interface ObservedPaneSize {
  read(): PaneSize;
  invalidate(): void;
  destroy(): void;
}

/** Only the compact Timeline owns a pane and sticky axis whose sizes are independent of mounted rows. */
function observePaneSize<T>(
  options: TaskListSurfaceOptions<T>,
  owner: Window & typeof window,
  schedule: () => void,
): ObservedPaneSize | undefined {
  const axis = options.viewportInsetElement;
  if (options.stagedMounts !== 'detached' || axis === undefined) return;
  const roots = [axis, options.host, options.scroll];
  let size: PaneSize | undefined;
  const parents = new Map<Element, Element | null>();
  const invalidate = (): void => {
    size = undefined;
  };
  const changed = (): void => {
    invalidate();
    schedule();
  };
  const observer = new owner.MutationObserver(changed);
  function watch(): void {
    observer.disconnect();
    parents.clear();
    for (const root of roots) {
      for (
        let node: Element | null = root;
        node !== null && !parents.has(node);
        node = node.parentElement
      ) {
        parents.set(node, node.parentElement);
        observer.observe(node, { attributes: true });
      }
    }
    invalidate();
  }
  watch();
  owner.document.addEventListener('visibilitychange', changed);
  return {
    read(): PaneSize {
      for (const [node, parent] of parents) {
        if (node.parentElement !== parent) {
          watch();
          break;
        }
      }
      if (observer.takeRecords().length > 0) invalidate();
      if (size === undefined) {
        const inset = Math.max(0, options.viewportInset?.() ?? 0);
        const height = Math.max(0, options.scroll.clientHeight - inset);
        const width = options.host.clientWidth;
        const visibility = owner.getComputedStyle(options.host).visibility;
        size = {
          inset,
          height,
          width,
          visible: width > 0 && height > 0 && visibility !== 'hidden' && visibility !== 'collapse',
        };
      }
      return size;
    },
    invalidate,
    destroy(): void {
      observer.disconnect();
      owner.document.removeEventListener('visibilitychange', changed);
    },
  };
}

/** Native lifetime and keyed mounts over the shared, pure row geometry. */
export class TaskListSurface<T = TaskSnapshot> implements MountedTaskListRows<T> {
  readonly #options: TaskListSurfaceOptions<T>;
  readonly #viewport: RowViewport;
  readonly #bufferedList: boolean;
  readonly #activeBuffer: 'scroll' | InteractiveBuffer;
  #scrollBuffer: ScrollBuffer = 'initial';
  #renderedRange: RowWindow | undefined;
  readonly #mounts = new Map<string, TaskRowMount<T>>();
  readonly #frames = new Map<string, HTMLElement>();
  readonly #pendingFrames = new Set<string>();
  readonly #placements = new Map<string, { height: number; offset: number }>();
  readonly #pins = new Map<string, Set<PinOwner>>();
  readonly #nativeObservers = new Set<PinOwner>();
  #rows: TaskListRows<T> = indexedRows<T>([]);
  #presentation: TaskListPresentation<T> | undefined;
  #owner: Window | null = null;
  #observer: ResizeObserver | undefined;
  #paneSize: ObservedPaneSize | undefined;
  #nativeGeneration = 0;
  #nativeCleanup: (() => void) | undefined;
  #binding = false;
  #frame: number | undefined;
  #frameWork: FrameWork = 'measure';
  #measurementFrame: number | undefined;
  #measuring = false;
  #suspended = false;
  #destroyed = false;
  #failed = false;
  #revision = 0;
  #reconciliation = 0;
  #invalidating = false;
  #layoutRevision = 0;
  #taskHeightSample: TaskHeightSample | undefined;
  #width = -1;
  #rowVariant: string | undefined;
  #font = '';
  #focusedKey: string | undefined;
  #ordered: string[] = [];
  #pendingScroll: TaskListScroll | undefined;
  #pendingUpdate = false;
  readonly #scrollWindow = new LogicalScrollWindow();
  #logicalTop = 0;
  #acceptedNativeTop = 0;
  #renderPlacement: LogicalScrollPlacement | undefined;
  readonly #parked = new Set<string>();
  #ownedWrite: { generation: number; writeId: number; expectedNativeTop: number } | undefined;
  #localInput = false;
  #inputTimer: number | undefined;
  #seekReserveTimer: number | undefined;
  #lastScroll: { top: number; left: number } | undefined;

  constructor(options: TaskListSurfaceOptions<T>, scrollReservePx: number | InteractiveBuffer = 0) {
    this.#activeBuffer = typeof scrollReservePx === 'string' ? scrollReservePx : 'scroll';
    this.#viewport = new RowViewport(
      options.openingOverscanPx,
      typeof scrollReservePx === 'number' ? scrollReservePx : 0,
    );
    this.#bufferedList = typeof scrollReservePx === 'string' || scrollReservePx > 0;
    this.#options = options;
    options.host.addClass('abyss-task-list-surface');
    this.#listen(true);
  }

  get rows(): TaskListRows<T> {
    return this.#rows;
  }
  captureScroll(): TaskListScrollPosition {
    const position = this.#pendingScroll ?? this.#updateScroll(this.#failed, true);
    return this.#taskHeightSample === undefined
      ? position
      : { ...position, taskHeightSample: this.#taskHeightSample };
  }
  restoreScroll(position: TaskListScrollPosition): void {
    this.#endTimelineSeek();
    this.#taskHeightSample = position.taskHeightSample;
    this.#pendingScroll = position;
  }
  element(key: string): HTMLElement | undefined {
    return this.#mounts.get(key)?.element;
  }
  *cards(): Iterable<readonly [key: string, card: HTMLElement]> {
    for (const key of this.#ordered) {
      const element = this.element(key);
      if (element !== undefined && this.#rows.indexOf(key) >= 0) yield [key, element];
    }
  }

  mountedKeys(): readonly string[] {
    return this.#ordered.filter((key) => this.#mounts.has(key));
  }
  refreshMeasurements(): void {
    this.#schedule();
    this.#flushBeforePaint();
  }
  #flushBeforePaint(): void {
    const frame = this.#frame;
    const owner = this.#owner;
    const generation = this.#nativeGeneration;
    if (
      this.#measuring ||
      frame === undefined ||
      owner === null ||
      this.#measurementFrame === frame
    )
      return;
    this.#measurementFrame = frame;
    // Receipts may finish after an animation callback but before paint. Commit geometry now;
    // refreshes raised inside this pass retain only their ordinary next-frame work.
    owner.queueMicrotask(() => {
      if (generation !== this.#nativeGeneration || frame !== this.#frame) return;
      this.#measurementFrame = undefined;
      this.#measuring = true;
      try {
        this.#cancelFrame();
        this.#flushFrame(owner);
      } finally {
        this.#measuring = false;
      }
    });
  }

  update(
    rows: TaskListRows<T>,
    presentation: TaskListPresentation<T>,
    failure: 'report' | 'throw' = 'report',
  ): void {
    if (this.#destroyed) return;
    this.#paneSize?.invalidate();
    const recovering = this.#failed;
    this.#failed = false;
    const revision = ++this.#revision;
    this.#guard(() => {
      const { top, anchor } = this.#updateScroll(recovering, presentation.preserveAnchor);
      this.#clearInput();
      this.#endTimelineSeek();
      this.#ownedWrite = undefined;
      this.#rows = rows;
      this.#taskHeightSample = retainHeightSample(this.#taskHeightSample, rows);
      this.#presentation = presentation;
      this.#pendingUpdate = true;
      // A surviving holder keeps its visible extent while its new exact source hydrates.
      // Only mounted rows are retained; layout invalidation still drops these measurements.
      const retained = recovering ? [] : this.#mountedExtents();
      this.#replace();
      this.#viewport.measure(retained, 0);
      this.#invalidatePins(
        [...this.#pins.keys()].filter((key) => this.#viewport.rowBounds(key) === undefined),
      );
      if (!this.#currentSource(revision)) return;
      for (const [key, mount] of this.#mounts) {
        if (this.#viewport.rowBounds(key) === undefined) {
          this.#evict(key, mount);
          if (!this.#currentSource(revision)) return;
        }
      }
      if (!this.#active()) {
        this.#deferRender({ anchor, top });
        return;
      }
      this.#pendingScroll = undefined;
      if (!this.#bind()) return;
      this.#checkLayout();
      const restored = this.#restoreTop(anchor, top);
      // A replacement estimate can be shorter than the retained row offset. Measure before
      // the final native clamp so a still-valid offset is not discarded provisionally.
      this.#reconcile('update', { top: restored, anchor, clampToExtent: true });
    }, failure);
  }

  reveal(key: string): HTMLElement | undefined;
  reveal(
    key: string,
    options: { readonly waitForReady: true },
  ): HTMLElement | 'pending' | undefined;
  reveal(
    key: string,
    options?: { readonly waitForReady: true },
  ): HTMLElement | 'pending' | undefined {
    this.#paneSize?.invalidate();
    if (this.#failed || !this.#active()) return undefined;
    let revealed: HTMLElement | undefined;
    const readiness = { pending: false };
    this.#guard(() => {
      if (this.#viewport.rowBounds(key) === undefined || !this.#bind()) return;
      this.#pendingScroll = undefined;
      const top = this.#checkLayout()?.top ?? this.#top();
      if (
        this.#reconcile('measure', {
          top: this.#viewport.reveal(key, top, this.#height()),
          anchor: undefined,
          revealKey: key,
          ...(options === undefined
            ? {}
            : {
                onPending: () => {
                  readiness.pending = true;
                },
              }),
        })
      )
        revealed = this.element(key);
    });
    return readiness.pending ? 'pending' : revealed;
  }

  pin(
    key: string,
    onInvalidated?: () => void,
    nativeWrite?: TaskListNativeWriteObserver,
  ): () => void {
    const token: PinOwner = { onInvalidated, nativeWrite };
    if (!this.#destroyed && !this.#invalidating && !this.#failed) {
      this.#guard(() => {
        if (this.#viewport.rowBounds(key) === undefined) return;
        const owners = this.#pins.get(key) ?? new Set<PinOwner>();
        owners.add(token);
        this.#pins.set(key, owners);
        this.#schedule();
      });
    }
    return () => {
      const owners = this.#pins.get(key);
      if (owners?.delete(token) !== true) return;
      if (owners.size === 0) this.#pins.delete(key);
      this.#schedule();
    };
  }

  /** Joins native write acknowledgements before a capture has a row to pin. */
  observeNativeWrites(
    observer: TaskListNativeWriteObserver,
    onInvalidated: () => void,
  ): () => void {
    const token: PinOwner = { nativeWrite: observer, onInvalidated };
    if (!this.#destroyed) this.#nativeObservers.add(token);
    return () => {
      if (this.#nativeObservers.delete(token) && this.#pendingUpdate) this.#schedule();
    };
  }

  suspend(releaseMounts = false): void {
    this.#suspended = true;
    this.#listen(false);
    this.#unbind();
    if (!releaseMounts) return;
    this.#guard(() => {
      for (const [key, mount] of this.#mounts) {
        if (!this.#pins.has(key)) this.#evict(key, mount);
      }
      this.#ordered = this.#ordered.filter((key) => this.#mounts.has(key));
      this.#options.mountedChanged();
    });
  }
  resume(): void {
    if (this.#destroyed) return;
    this.#suspended = false;
    this.#listen(true);
    this.#failed = false;
    this.#guard(() => {
      if (!this.#options.host.isConnected || !this.#bind() || !this.#active()) return;
      this.#reconcilePending();
    });
  }
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#listen(false);
    this.#unbind();
    this.#guard(() => {
      this.#invalidatePins([...this.#pins.keys()]);
      const observers = [...this.#nativeObservers];
      this.#nativeObservers.clear();
      for (const observer of observers) observer.onInvalidated?.();
    });
    for (const [key, mount] of this.#mounts) this.#evict(key, mount);
    this.#ordered = [];
    this.#rows = indexedRows<T>([]);
    this.#options.host.empty();
    this.#options.host.removeClass('abyss-task-list-surface');
  }

  #active(): boolean {
    const host = this.#options.host;
    if (this.#destroyed || this.#suspended || !host.isConnected) return false;
    if (this.#paneSize === undefined) return this.#height() > 0 && host.clientWidth > 0;
    const visible = !host.ownerDocument.hidden && this.#paneSize.read().visible;
    // Hydration can stop while the pane is hidden. Publish retained keys again on return.
    if (!visible) this.#renderedRange = undefined;
    return visible;
  }
  #height(): number {
    return (
      this.#paneSize?.read().height ??
      Math.max(0, this.#options.scroll.clientHeight - this.#inset())
    );
  }
  #inset(): number {
    return this.#paneSize?.read().inset ?? Math.max(0, this.#options.viewportInset?.() ?? 0);
  }
  #origin(): number {
    const pane = this.#paneSize?.read();
    if (pane === undefined) return this.#readOrigin();
    const nativeTop = this.#options.scroll.scrollTop;
    if (pane.origin?.nativeTop !== nativeTop)
      pane.origin = { nativeTop, offset: this.#readOrigin() };
    return pane.origin.offset;
  }
  #readOrigin(): number {
    const { host, scroll } = this.#options;
    const padding = this.#margin(host.ownerDocument.defaultView?.getComputedStyle(host).paddingTop);
    if (host === scroll) return padding - this.#inset();
    return (
      host.getBoundingClientRect().top +
      host.clientTop +
      padding -
      scroll.getBoundingClientRect().top -
      scroll.clientTop +
      scroll.scrollTop -
      this.#inset()
    );
  }
  #top(): number {
    const native = this.#options.scroll.scrollTop;
    const origin = this.#origin();
    if (!this.#scrollWindow.isCompressed(this.#viewport.totalHeight)) return native - origin;
    if (native === this.#acceptedNativeTop) return this.#logicalTop;
    const previous = this.#scrollWindow.place(
      this.#logicalTop,
      this.#viewport.totalHeight,
      this.#height(),
    );
    this.#scrollWindow.acknowledge(previous.writeId, this.#acceptedNativeTop - origin);
    const owned =
      this.#ownedWrite?.generation === this.#nativeGeneration &&
      native === this.#ownedWrite.expectedNativeTop;
    const intent = this.#localInput ? 'local' : 'absolute';
    const next = this.#scrollWindow.read(
      native - origin,
      this.#viewport.totalHeight,
      this.#height(),
      owned ? 'owned' : intent,
    );
    this.#logicalTop = next.logicalTop;
    this.#acceptedNativeTop = native;
    if (!owned) this.#ownedWrite = undefined;
    if (!owned && this.#localInput) this.#armInputTimeout();
    return next.logicalTop;
  }
  #updateScroll(recovering: boolean, preserveAnchor: boolean): TaskListScroll {
    if (this.#pendingScroll !== undefined) return this.#pendingScroll;
    const top = recovering ? this.#recoveryTop() : this.#top();
    const anchor =
      !recovering && preserveAnchor ? this.#viewport.captureAnchor(Math.max(0, top)) : undefined;
    return { top, anchor };
  }
  #recoveryTop(): number {
    // A failed source cannot supply offsets; the last rendered coordinate system is still known.
    return this.#options.scroll.scrollTop - this.#origin() + (this.#renderPlacement?.origin ?? 0);
  }
  #place(top: number): LogicalScrollPlacement {
    const placed = this.#scrollWindow.place(top, this.#viewport.totalHeight, this.#height());
    return !this.#scrollWindow.isCompressed(this.#viewport.totalHeight) || top < 0
      ? { ...placed, nativeTop: top, logicalTop: top, origin: 0 }
      : placed;
  }
  #livePin({ key, token }: CapturedPin, current: () => boolean): boolean {
    return (
      current() &&
      (key === undefined
        ? this.#nativeObservers.has(token)
        : this.#pins.get(key)?.has(token) === true)
    );
  }
  #beforeNativeWrite(owners: readonly CapturedPin[], top: number, current: () => boolean): boolean {
    for (const owner of owners) {
      if (this.#livePin(owner, current) && owner.token.nativeWrite !== undefined) {
        const accepted = owner.token.nativeWrite.beforeWrite(top);
        if (!this.#admitReconciliation(current) || !accepted) return false;
      }
      if (!current() || this.#options.scroll.scrollTop !== top) return false;
    }
    return current();
  }
  #afterNativeWrite(owners: readonly CapturedPin[], top: number, current: () => boolean): boolean {
    for (const owner of owners) {
      if (this.#livePin(owner, current) && owner.token.nativeWrite !== undefined) {
        owner.token.nativeWrite.afterWrite(top);
        if (!this.#admitReconciliation(current)) return false;
      }
      if (!current() || this.#options.scroll.scrollTop !== top) return false;
    }
    return current();
  }
  #nativeOwners(): CapturedPin[] | undefined {
    let owners: CapturedPin[] | undefined =
      this.#nativeObservers.size === 0
        ? undefined
        : [...this.#nativeObservers].map((token) => ({ token }));
    for (const [key, tokens] of this.#pins)
      for (const token of tokens)
        if (token.nativeWrite !== undefined) {
          owners ??= [];
          owners.push({ key, token });
        }
    return owners;
  }
  #mutateExtent(
    action: (guard?: HTMLElement) => void,
    owners: readonly CapturedPin[],
    before: number,
    current: () => boolean,
  ): number | undefined {
    // Keep intermediate spacer shrink/layout reads from clamping before the final DOM order exists.
    const scroll = this.#options.scroll;
    const guard = this.#spacer(scroll.scrollHeight);
    guard.setAttribute('data-abyss-scroll-guard', '');
    try {
      action(guard);
      if (!current() || owners.length === 0) return;
      const actual = scroll.scrollTop;
      if (actual !== before) {
        this.#beforeNativeWrite(owners, actual, current);
        return;
      }
      // No application callback separates this proof, native removal and the actual clamp receipt.
      guard.remove();
      return scroll.scrollTop;
    } finally {
      guard.remove();
    }
  }
  #nativeMutation(
    action: (guard?: HTMLElement) => void,
    current: () => boolean,
    extent = false,
  ): boolean {
    const owners = this.#nativeOwners();
    // Exact zero cannot clamp downward; owned transactions still require their receipts.
    if (owners === undefined) {
      if (extent && this.#options.scroll.scrollTop !== 0)
        this.#mutateExtent(action, [], this.#options.scroll.scrollTop, current);
      else action();
      return this.#admitReconciliation(current);
    }
    const scroll = this.#options.scroll;
    const before = scroll.scrollTop;
    const reject = (): false => {
      if (current()) this.#reconciliation++;
      return false;
    };
    if (!this.#beforeNativeWrite(owners, before, current)) return reject();
    let actual: number | undefined;
    if (extent) actual = this.#mutateExtent(action, owners, before, current);
    else {
      action();
      actual = scroll.scrollTop;
    }
    if (actual === undefined) return reject();
    if (!current()) return false;
    return this.#afterNativeWrite(owners, actual, current) || reject();
  }
  #writeTop(top: number, current: () => boolean): void {
    const placement = this.#place(top);
    const origin = this.#origin();
    const next = placement.nativeTop + origin;
    if (!this.#admitReconciliation(current)) return;
    const owned = {
      generation: this.#nativeGeneration,
      writeId: placement.writeId,
      expectedNativeTop: next,
    };
    this.#ownedWrite = owned;
    if (
      !this.#nativeMutation(() => {
        if (Number.isFinite(next) && Math.abs(next - this.#options.scroll.scrollTop) > 0.01)
          this.#options.scroll.scrollTop = next;
      }, current)
    ) {
      if (this.#ownedWrite === owned) this.#ownedWrite = undefined;
      return;
    }
    const actual = this.#options.scroll.scrollTop;
    this.#scrollWindow.acknowledge(placement.writeId, actual - origin);
    owned.expectedNativeTop = actual;
    this.#acceptedNativeTop = actual;
    this.#logicalTop = placement.logicalTop;
    // Native scroll feedback can coalesce with later input back to the previous event position.
    this.#lastScroll = { top: actual, left: this.#options.scroll.scrollLeft };
  }
  #mountedExtents(): RowMeasurement[] {
    const retained: RowMeasurement[] = [];
    for (const key of this.#mounts.keys()) {
      const bounds = this.#viewport.rowBounds(key);
      if (bounds !== undefined) retained.push({ key, height: bounds.bottom - bounds.top });
    }
    return retained;
  }
  #replace(): void {
    this.#renderedRange = undefined;
    const presentation = this.#presentation;
    if (presentation === undefined) return;
    const rows = this.#rows;
    const revision = `${this.#layoutRevision}:${presentation.revision}`;
    const indexed = presentation.indexedHeights;
    const heights =
      indexed?.sampleOpeningTasks === true && this.#taskHeightSample !== undefined
        ? { ...indexed, task: this.#taskHeightSample.height }
        : indexed;
    const geometryRow = (row: TaskListRow<T>): RowViewportRow => ({
      key: row.key,
      estimatedHeight: heights?.[row.kind] ?? presentation.estimate(row),
      measurementRevision: `${revision}:${presentation.measurementRevision(row)}`,
    });
    if (heights === undefined) {
      this.#viewport.replace(Array.from(rows.slice(0, rows.rowCount), geometryRow));
      return;
    }
    this.#viewport.replaceIndexed(
      Object.freeze({
        length: rows.rowCount,
        rowAt(index: number) {
          const row = rows.rowAt(index);
          return row === undefined ? undefined : geometryRow(row);
        },
        indexOf: (key: string) => rows.rowIndexOf(key),
        estimatedOffset: (index: number) => rows.estimatedOffset(index, heights),
        anchorRanges: () => rows.anchorRanges(),
        survivingNeighbor: rows.survivingNeighbor.bind(rows),
      }),
    );
  }
  #restoreTop(anchor: RowAnchor | undefined, top: number): number {
    return top + this.#viewport.restoreAnchor(anchor, Math.max(0, top)) - Math.max(0, top);
  }
  #checkLayout(): TaskListScroll | undefined {
    const host = this.#options.host;
    const font = this.#fontSignature(host);
    const layout = this.#options.rowLayout?.();
    const variant = layout?.variant;
    const width = layout?.width ?? this.#paneSize?.read().width ?? host.clientWidth;
    if (width === this.#width && font === this.#font && variant === this.#rowVariant) return;
    const top = this.#top();
    const anchor = this.#viewport.captureAnchor(Math.max(0, top));
    this.#width = width;
    this.#rowVariant = variant;
    this.#font = font;
    this.#layoutRevision++;
    this.#replace();
    return { top: this.#restoreTop(anchor, top), anchor };
  }
  #fontSignature(host: HTMLElement): string {
    const style = this.#owner?.getComputedStyle(host);
    return `${style?.fontFamily}:${style?.fontSize}:${style?.lineHeight}:${style?.fontWeight}:${style?.fontStyle}:${style?.letterSpacing}`;
  }
  readonly #schedule = (): void => {
    this.#queueFrame('measure');
  };
  #queueFrame(work: FrameWork): void {
    if (this.#destroyed || this.#suspended || this.#failed || this.#binding) return;
    this.#guard(() => {
      // A previous window's pending frame cannot coalesce work for an adopted host.
      if (!this.#bind()) return;
      if (!this.#active()) {
        this.#cancelFrame();
        return;
      }
      if (this.#frame !== undefined) {
        if (work === 'measure') this.#frameWork = work;
        return;
      }
      this.#frameWork = work;
      const generation = this.#nativeGeneration;
      const owner = this.#owner;
      const frame: number | undefined = owner?.requestAnimationFrame(() => {
        if (generation !== this.#nativeGeneration || frame !== this.#frame) return;
        this.#frame = undefined;
        this.#flushFrame(owner);
      });
      this.#frame = frame;
    });
  }
  #flushFrame(owner: Window): void {
    const work = this.#frameWork;
    if (owner.document !== this.#options.host.ownerDocument) {
      this.refreshMeasurements();
      return;
    }
    this.#guard(() => {
      if (work === 'measure') this.#paneSize?.invalidate();
      if (!this.#active()) return;
      this.#reconcilePending(work);
    });
  }
  #reconcilePending(work: FrameWork = 'measure'): void {
    let target = this.#checkLayout();
    const pending = this.#pendingScroll;
    if (pending !== undefined) {
      target = { top: this.#restoreTop(pending.anchor, pending.top), anchor: pending.anchor };
    }
    if (this.#reconcile(work, target) && this.#pendingScroll === pending)
      this.#pendingScroll = undefined;
  }
  #deferRender(position: TaskListScroll): void {
    this.#pendingScroll = position;
    this.#cancelFrame();
    // Hidden tabs still need their size observer to wake the latest source on return.
    if (!this.#suspended && this.#options.host.isConnected) this.#bind();
    else this.#unbind();
  }
  #bind(): boolean {
    const binding = this.#binding;
    this.#binding = true;
    try {
      return this.#bindOwner();
    } finally {
      this.#binding = binding;
    }
  }
  #bindOwner(): boolean {
    const owner = this.#options.host.ownerDocument.defaultView;
    if (owner === this.#owner) return true;
    const revision = this.#revision;
    this.#unbind();
    // Components and native event registrations belong to the document that mounted them.
    this.#invalidatePins([...this.#pins.keys()]);
    if (!this.#currentSource(revision)) return false;
    for (const [key, mount] of this.#mounts) {
      this.#evict(key, mount);
      if (!this.#currentSource(revision)) return false;
    }
    this.#owner = owner;
    if (owner === null) return true;
    this.#lastScroll = {
      top: this.#options.scroll.scrollTop,
      left: this.#options.scroll.scrollLeft,
    };
    this.#width = -1;
    const generation = this.#nativeGeneration;
    const schedule = (): void => {
      if (generation !== this.#nativeGeneration) return;
      this.#paneSize?.invalidate();
      this.#schedule();
    };
    const fontChanged = (): void => {
      if (generation !== this.#nativeGeneration) return;
      this.#font = '';
      schedule();
    };
    this.#observer = new owner.ResizeObserver(schedule);
    this.#paneSize = observePaneSize(this.#options, owner, schedule);
    const axis = this.#options.viewportInsetElement;
    if (this.#paneSize !== undefined && axis !== undefined) this.#observer.observe(axis);
    this.#observer.observe(this.#options.host);
    if (this.#options.scroll !== this.#options.host) this.#observer.observe(this.#options.scroll);
    owner.addEventListener('resize', schedule);
    const clearInputListeners = this.#bindInput(owner, generation);
    const clearWarmup = this.#bindWarmup(owner, generation);
    const clearScrollInput = this.#bindScrollInput();
    const fonts = owner.document.fonts;
    fonts.addEventListener('loadingdone', fontChanged);
    this.#nativeCleanup = () => {
      clearInputListeners();
      clearWarmup?.();
      clearScrollInput?.();
      owner.removeEventListener('resize', schedule);
      fonts.removeEventListener('loadingdone', fontChanged);
    };
    return true;
  }
  #bindScrollInput(): (() => void) | undefined {
    const timeline = this.#activeBuffer === 'timeline';
    const androidList =
      Platform.isAndroidApp && this.#activeBuffer === 'scroll' && this.#bufferedList;
    if (!timeline && !androidList) return;
    const scroll = this.#options.scroll;
    const canPublish = (): boolean =>
      !this.#pendingUpdate && !this.#failed && this.#active() && this.#canBufferRange();
    const moved = (): void => {
      if (timeline)
        this.#guard(() => {
          this.#publishTimelineStep();
        });
      else {
        this.#scrolled();
        this.#flushBeforePaint();
      }
    };
    const clearWheel = timeline ? bindTimelineWheel(scroll, canPublish, moved) : undefined;
    const clearTouch = Platform.isAndroidApp
      ? bindTaskListTouch(scroll, canPublish, moved)
      : undefined;
    return () => {
      clearWheel?.();
      clearTouch?.();
    };
  }
  #publishTimelineStep(): void {
    this.#paneSize?.invalidate();
    const scroll = this.#options.scroll;
    this.#endTimelineSeek();
    this.#scrollBuffer = 'timeline-seek';
    this.#lastScroll = { top: scroll.scrollTop, left: scroll.scrollLeft };
    this.#pendingScroll = undefined;
    const layout = this.#checkLayout();
    let needsMeasurement = true;
    if (layout !== undefined || this.#scrollWindow.isCompressed(this.#viewport.totalHeight)) {
      this.#reconcile('measure', layout);
    } else {
      // Publish the real destination now; batch row measurements with hydration and resize receipts.
      const current = this.#currentReconciliation();
      this.#readFocus();
      if (this.#admitReconciliation(current)) {
        const result = this.#renderWindow(false, this.#top(), undefined, current);
        needsMeasurement = !this.#canReuseHeights('scroll', undefined, result === 'retained');
      }
    }
    if (needsMeasurement) this.#schedule();
    this.#refillAfterSeek();
  }
  #refillAfterSeek(delay = 400): void {
    const owner = this.#owner;
    if (
      this.#scrollBuffer !== 'timeline-seek' ||
      owner === null ||
      this.#seekReserveTimer !== undefined
    )
      return;
    // Measurements and clicks continue immediately. Only the usual offscreen reserve waits.
    const timer = owner.setTimeout(() => {
      if (this.#seekReserveTimer !== timer || owner !== this.#owner) return;
      this.#seekReserveTimer = undefined;
      this.#guard(() => {
        this.#refillTimelineNeighbors();
      });
    }, delay);
    this.#seekReserveTimer = timer;
  }
  #refillTimelineNeighbors(): void {
    const stage = this.#viewport.extendTimelineReserve();
    if (stage !== 'partial') this.#endTimelineSeek();
    if (stage === 'stable' || !this.#bind() || !this.#active()) return;
    this.#reconcilePending();
    if (stage === 'partial') this.#refillAfterSeek(50);
  }
  #postponeSeekRefill(): void {
    if (this.#seekReserveTimer === undefined) return;
    this.#owner?.clearTimeout(this.#seekReserveTimer);
    this.#seekReserveTimer = undefined;
    this.#refillAfterSeek();
  }
  #endTimelineSeek(): void {
    if (this.#seekReserveTimer !== undefined) this.#owner?.clearTimeout(this.#seekReserveTimer);
    this.#seekReserveTimer = undefined;
    if (this.#scrollBuffer === 'timeline-seek') this.#scrollBuffer = 'timeline';
  }
  #bindWarmup(owner: Window, generation: number): (() => void) | undefined {
    if (!this.#bufferedList || (this.#activeBuffer === 'timeline' && Platform.isAndroidApp)) return;
    const warm = (): void => {
      if (generation !== this.#nativeGeneration || this.#scrollBuffer !== 'initial') return;
      this.#scrollBuffer = this.#activeBuffer;
      this.#schedule();
    };
    const scroll = this.#options.scroll;
    if (this.#activeBuffer !== 'scroll') return onVerticalScrollIntent(scroll, warm);
    const timer = owner.setTimeout(warm, 350);
    scroll.addEventListener('wheel', warm, { once: true, passive: true });
    return () => {
      owner.clearTimeout(timer);
      scroll.removeEventListener('wheel', warm);
    };
  }
  readonly #focusEntered = (): void => {
    if (!this.#active()) return;
    this.#readFocus();
    const key = this.#focusedKey;
    if (key !== undefined && this.#parked.has(key)) this.reveal(key);
    else this.#schedule();
  };
  readonly #scrolled = (): void => {
    if (this.#destroyed || this.#suspended || this.#failed || this.#binding) return;
    this.#guard(() => {
      const sameOwner = this.#owner === this.#options.host.ownerDocument.defaultView;
      if (!this.#bind()) return;
      const scroll = this.#options.scroll;
      const next = { top: scroll.scrollTop, left: scroll.scrollLeft };
      const previous = this.#lastScroll ?? next;
      this.#lastScroll = next;
      this.#bufferScrollStep(next.top, previous);
      // Horizontal Timeline motion cannot change the vertical range. Other pending work,
      // including resize and hydration receipts, keeps its independently scheduled frame.
      if (sameOwner && previous.top === next.top && previous.left !== next.left) return;
      // Read each vertical event before the frame so away-and-back input retains its intent.
      this.#top();
      if (previous.top !== next.top && this.#active()) this.#pendingScroll = undefined;
      this.#scheduleScrollStep(next.top - previous.top);
    });
  };
  #scheduleScrollStep(distance: number): void {
    // Reuse the coalesced pre-paint measurement pass when a fling can outrun the frame callback.
    // A programmatic Timeline step has already recorded the position its scroll event reports.
    const timelineScroll =
      this.#activeBuffer === 'timeline' &&
      (distance !== 0 || this.#scrollBuffer === 'timeline-seek');
    this.#queueFrame(this.#activeBuffer !== 'timeline' || timelineScroll ? 'scroll' : 'measure');
    if (timelineScroll && isLargeScrollStep(distance, this.#height())) this.#flushBeforePaint();
  }
  #bufferScrollStep(top: number, previous: { top: number } | undefined): void {
    const distance = Math.abs(top - (previous?.top ?? top));
    if (this.#activeBuffer !== 'scroll') {
      if (distance > 0) {
        this.#endTimelineSeek();
        this.#scrollBuffer = this.#activeBuffer;
      }
      return;
    }
    if (!this.#bufferedList || distance < 170 || this.#scrollBuffer === 'history') return;
    this.#scrollBuffer = isLargeScrollStep(distance, this.#height()) ? 'history' : 'scroll';
  }
  #listen(listen: boolean): void {
    const { host, scroll } = this.#options;
    if (listen) {
      host.addEventListener('focusin', this.#focusEntered);
      host.addEventListener('focusout', this.#schedule);
      scroll.addEventListener('scroll', this.#scrolled, { passive: true });
    } else {
      host.removeEventListener('focusin', this.#focusEntered);
      host.removeEventListener('focusout', this.#schedule);
      scroll.removeEventListener('scroll', this.#scrolled);
    }
  }
  #clearInput(): void {
    if (this.#inputTimer !== undefined) this.#owner?.clearTimeout(this.#inputTimer);
    this.#inputTimer = undefined;
    this.#localInput = false;
  }
  #armInputTimeout(): void {
    if (this.#inputTimer !== undefined) this.#owner?.clearTimeout(this.#inputTimer);
    const generation = this.#nativeGeneration;
    this.#inputTimer = this.#owner?.setTimeout(() => {
      if (generation === this.#nativeGeneration) this.#clearInput();
    }, 180);
  }
  #bindInput(owner: Window & typeof window, generation: number): () => void {
    const scroll = this.#options.scroll;
    const live = (): boolean =>
      generation === this.#nativeGeneration && owner.document === this.#options.host.ownerDocument;
    const local = (): void => {
      if (!live()) return;
      this.#localInput = true;
      this.#armInputTimeout();
    };
    const clear = (): void => {
      if (live()) this.#clearInput();
    };
    const pointer = (event: PointerEvent): void => {
      this.#postponeSeekRefill();
      if (event.pointerType === 'touch') local();
      else if (event.button === 0 && event.isPrimary !== false) clear();
    };
    const key = (event: KeyboardEvent): void => {
      const target = event.target;
      if (target instanceof owner.HTMLElement) {
        if (target.isContentEditable || target.closest('input, textarea, select') !== null) return;
        if (event.key === ' ' && target.closest('button') !== null) return;
      }
      if (['PageUp', 'PageDown', ' '].includes(event.key)) local();
    };
    const unload = (): void => {
      if (live()) this.suspend();
    };
    for (const event of ['wheel', 'touchstart', 'touchmove'])
      scroll.addEventListener(event, local, { capture: true, passive: true });
    scroll.addEventListener('pointerdown', pointer, true);
    scroll.addEventListener('keydown', key, true);
    scroll.addEventListener('scrollend', clear);
    owner.addEventListener('blur', clear);
    owner.addEventListener('unload', unload);
    return () => {
      for (const event of ['wheel', 'touchstart', 'touchmove'])
        scroll.removeEventListener(event, local, true);
      scroll.removeEventListener('pointerdown', pointer, true);
      scroll.removeEventListener('keydown', key, true);
      scroll.removeEventListener('scrollend', clear);
      owner.removeEventListener('blur', clear);
      owner.removeEventListener('unload', unload);
    };
  }
  #cancelFrame(): void {
    if (this.#frame !== undefined) this.#owner?.cancelAnimationFrame(this.#frame);
    this.#frame = undefined;
  }
  #unbind(): void {
    this.#paneSize?.destroy();
    this.#paneSize = undefined;
    this.#endTimelineSeek();
    this.#scrollBuffer = 'initial';
    this.#renderedRange = undefined;
    this.#clearInput();
    this.#ownedWrite = undefined;
    this.#nativeGeneration++;
    this.#measurementFrame = undefined;
    this.#cancelFrame();
    this.#observer?.disconnect();
    this.#observer = undefined;
    this.#nativeCleanup?.();
    this.#nativeCleanup = undefined;
    this.#owner = null;
  }
  #evict(key: string, mount: TaskRowMount<T>): void {
    this.#renderedRange = undefined;
    this.#observer?.unobserve(mount.element);
    this.#mounts.delete(key);
    this.#pendingFrames.delete(key);
    this.#parked.delete(key);
    this.#placements.delete(key);
    const frame = this.#frames.get(key);
    this.#frames.delete(key);
    mount.element.removeClass('abyss-virtual-row-parked');
    mount.element.style.removeProperty('--abyss-virtual-row-width');
    mount.element.style.removeProperty('--abyss-virtual-row-offset');
    try {
      mount.destroy();
    } finally {
      frame?.remove();
    }
  }
  #readFocus(): void {
    this.#focusedKey = undefined;
    const focused = this.#options.host.ownerDocument.activeElement;
    for (const [key, mount] of this.#mounts)
      if (focused !== null && mount.element.contains(focused)) {
        this.#focusedKey = key;
        break;
      }
  }
  #currentSource(revision: number): boolean {
    return !this.#destroyed && revision === this.#revision;
  }
  #currentReconciliation(): () => boolean {
    const revision = this.#revision;
    const reconciliation = ++this.#reconciliation;
    const generation = this.#nativeGeneration;
    const owner = this.#owner;
    return (): boolean =>
      revision === this.#revision &&
      reconciliation === this.#reconciliation &&
      generation === this.#nativeGeneration &&
      owner === this.#owner &&
      owner?.document === this.#options.host.ownerDocument &&
      owner.document === this.#options.scroll.ownerDocument &&
      !this.#destroyed &&
      !this.#suspended &&
      this.#options.host.isConnected;
  }
  #admitReconciliation(current: () => boolean): boolean {
    if (!current()) return false;
    const active = this.#active();
    if (!current()) return false;
    // An inactive pass stays retired even if its cleanup restores geometry.
    if (!active) this.#reconciliation++;
    return active;
  }
  #intersects(key: string | undefined): boolean {
    const rect = key === undefined ? undefined : this.element(key)?.getBoundingClientRect();
    const top =
      this.#options.scroll.getBoundingClientRect().top +
      this.#options.scroll.clientTop +
      this.#inset();
    return rect !== undefined && rect.bottom > top && rect.top < top + this.#height();
  }
  #reconcile(work: FrameWork | 'update', target?: TaskListScroll): boolean {
    const revision = this.#revision;
    const complete = this.#reconcileViewport(this.#pendingUpdate ? 'update' : work, target);
    // Source snapshots remain pending through a veto, hide, or reentrant replacement.
    if (complete && revision === this.#revision) this.#pendingUpdate = false;
    return complete;
  }
  #reconcileViewport(work: FrameWork | 'update', target?: TaskListScroll): boolean {
    const current = this.#currentReconciliation();
    this.#readFocus();
    this.#resolvePinOrder();
    if (!this.#admitReconciliation(current)) return false;
    this.#readFocus();
    const nativeTop = target === undefined ? this.#top() : target.top;
    const revealKey = target?.revealKey;
    // Only a row already intersecting before provisional measurement retains tall-row placement.
    const alignTall = !this.#intersects(revealKey);
    const retainedAnchor = this.#measurementAnchor(nativeTop);
    if (!this.#admitReconciliation(current)) return false;
    const result = this.#renderWindow(
      work === 'update',
      nativeTop,
      revealKey ?? this.#anchorKey(target?.anchor),
      current,
    );
    if (!this.#admitReconciliation(current)) return false;
    return (
      this.#canReuseHeights(work, target, result === 'retained') ||
      this.#measureWindow(nativeTop, target, current, { alignTall, retainedAnchor })
    );
  }
  #anchorKey(anchor: RowAnchor | undefined): string | undefined {
    // A tall row's old offset can place its replacement estimate outside overscan.
    if (anchor === undefined) return;
    return this.#viewport.rowAt(this.#viewport.restoreAnchor({ ...anchor, offset: 0 }, 0))?.key;
  }
  #canReuseHeights(
    work: FrameWork | 'update',
    target: TaskListScroll | undefined,
    retained: boolean,
  ): boolean {
    // Only an unchanged, settled buffer can reuse its measured heights. Resize, font,
    // focus, pin and render-receipt work take precedence over coalesced native scroll.
    return work === 'scroll' && target === undefined && retained && this.#pendingFrames.size === 0;
  }
  #measureWindow(
    top: number,
    target: TaskListScroll | undefined,
    current: () => boolean,
    { alignTall, retainedAnchor }: { alignTall: boolean; retainedAnchor: RowAnchor | undefined },
  ): boolean {
    if (target?.revealKey !== undefined)
      return this.#measureReveal(top, { ...target, key: target.revealKey, current, alignTall });
    const measuredTop = this.#measure(top, target?.anchor ?? retainedAnchor, current);
    if (!current()) return false;
    // Ordinary frames retain their fractional/key anchor policy and one measurement pass.
    if (measuredTop !== undefined) this.#renderWindow(false, measuredTop, undefined, current);
    if (!current()) return false;
    const corrected = this.#correctedTop(measuredTop, target, top);
    if (corrected !== undefined) this.#writeTop(corrected, current);
    return current();
  }
  #correctedTop(
    measuredTop: number | undefined,
    target: TaskListScroll | undefined,
    top: number,
  ): number | undefined {
    const requested = this.#scrollWindow.isCompressed(this.#viewport.totalHeight) ? top : undefined;
    const corrected = measuredTop ?? target?.top ?? requested;
    return target?.clampToExtent === true && corrected !== undefined && corrected >= 0
      ? Math.min(corrected, Math.max(0, this.#viewport.totalHeight - this.#height()))
      : corrected;
  }
  #measureReveal(top: number, reveal: RevealPlacement): boolean {
    const { key, current } = reveal;
    let desired = top;
    for (let pass = 0; pass < maxRevealMeasurementPasses; pass++) {
      if (this.#yieldPendingReveal(desired, reveal)) return false;
      const next = this.#measureRevealWindow(desired, reveal, pass === 0);
      if (!current()) return false;
      desired = next.top;
      if (!next.stable) continue;
      return this.#finishReveal(key, desired, current);
    }
    throw new Error('Task reveal measurements did not converge');
  }
  #yieldPendingReveal(top: number, reveal: RevealPlacement): boolean {
    if (
      reveal.onPending === undefined ||
      ![...this.#mounts.values()].some((mount) => !this.#measurementReady(mount, reveal.current))
    )
      return false;
    this.#writeTop(top, reveal.current);
    if (reveal.current()) reveal.onPending();
    return true;
  }
  #finishReveal(key: string, desired: number, current: () => boolean): boolean {
    this.#writeTop(desired, current);
    if (!current()) return false;
    const adjustment = this.#revealAdjustment(key, undefined, false, current);
    if (!this.#admitReconciliation(current)) return false;
    if (Math.abs(adjustment) > 0.5)
      throw new Error('Task reveal did not reach the visible viewport');
    return true;
  }
  #revealTop(key: string, top: number, alignTall: boolean): number {
    const bounds = this.#viewport.rowBounds(key);
    if (bounds === undefined) return top;
    return alignTall && bounds.bottom - bounds.top > this.#height()
      ? bounds.top
      : this.#viewport.reveal(key, top, this.#height());
  }
  #measureRevealWindow(
    top: number,
    reveal: RevealPlacement,
    initial: boolean,
  ): { top: number; stable: boolean } {
    const { key, current, alignTall } = reveal;
    const measuredTop = this.#measure(top, this.#viewport.captureAnchor(top), current);
    if (!current()) return { top, stable: false };
    const desired =
      measuredTop !== undefined || initial
        ? this.#revealTop(key, measuredTop ?? top, alignTall)
        : top;
    const previous = new Set(this.#mounts.keys());
    // Establish the measured extent before the final native setter can clamp it.
    this.#renderWindow(false, desired, key, current);
    if (!current()) return { top: desired, stable: false };
    const mountedChanged = this.#mountsChanged(previous);
    const changed = measuredTop !== undefined || mountedChanged;
    if (changed) return { top: desired, stable: false };
    const adjustment = this.#revealAdjustment(key, desired, alignTall, current);
    if (!this.#admitReconciliation(current)) return { top: desired, stable: false };
    if (Math.abs(adjustment) <= 0.5) return { top: desired, stable: true };
    const corrected = desired + adjustment;
    this.#renderWindow(false, corrected, key, current);
    return { top: corrected, stable: false };
  }
  #mountsChanged(previous: ReadonlySet<string>): boolean {
    return (
      previous.size !== this.#mounts.size ||
      [...this.#mounts.keys()].some((key) => !previous.has(key))
    );
  }
  #revealAdjustment(
    key: string,
    top: number | undefined,
    alignTall: boolean,
    current: () => boolean,
  ): number {
    const element = this.element(key);
    if (element?.isConnected !== true) throw new Error('Task reveal row is not mounted');
    const rect = element.getBoundingClientRect();
    if (!current()) return 0;
    const scroll = this.#options.scroll;
    const viewportTop = scroll.getBoundingClientRect().top + scroll.clientTop + this.#inset();
    const displacement =
      top === undefined
        ? 0
        : this.#options.scroll.scrollTop - this.#origin() - this.#place(top).nativeTop;
    if (!this.#admitReconciliation(current)) return 0;
    const projectedTop = rect.top + displacement;
    const projectedBottom = rect.bottom + displacement;
    if (![projectedTop, projectedBottom, rect.height].every(Number.isFinite) || rect.height <= 0)
      throw new Error('Task reveal row has invalid geometry');
    return this.#visibleAdjustment(
      projectedTop - viewportTop,
      projectedBottom - viewportTop,
      rect.height,
      alignTall,
    );
  }
  #visibleAdjustment(top: number, bottom: number, rowHeight: number, alignTall: boolean): number {
    const height = this.#height();
    if (rowHeight > height) {
      if (alignTall || top >= height) return top;
      if (bottom <= 0) return bottom - height;
      return 0;
    }
    if (top < 0) return top;
    return Math.max(0, bottom - height);
  }
  #measurementAnchor(top: number): RowAnchor | undefined {
    const fallback = this.#viewport.captureAnchor(top);
    if (
      fallback === undefined ||
      (this.#pendingFrames.size === 0 && this.#mounts.has(fallback.key))
    )
      return;
    // Preserve the oldest settled visible ink while cold rows enter or finish in stages.
    const bottom = top + this.#height();
    for (const key of this.#mounts.keys()) {
      const row = this.#viewport.rowBounds(key);
      if (
        row === undefined ||
        this.#pendingFrames.has(key) ||
        row.bottom <= top ||
        row.top >= bottom
      )
        continue;
      return { ...fallback, key, previousIndex: row.index, offset: top - row.top };
    }
    return undefined;
  }
  #measure(top: number, anchor: RowAnchor | undefined, current: () => boolean): number | undefined {
    const retainedAnchor = anchor ?? this.#measurementAnchor(top);
    const measurements = this.#measureRows(current);
    if (measurements === undefined || !this.#admitReconciliation(current)) return;
    const originalTop = Math.max(0, top);
    const measured = this.#measureGeometry(measurements, originalTop, retainedAnchor);
    const released = this.#releaseMeasuredFrames(measurements);
    // Equal cached heights still need a render to restore natural frame flow.
    if (!measured.changed && !released) return;
    if (released || this.#pendingFrames.size > 0) this.#renderedRange = undefined;
    return top + measured.scrollTop - originalTop;
  }
  #releaseMeasuredFrames(measurements: readonly RowMeasurement[]): boolean {
    let released = false;
    for (const { key, height } of measurements)
      if (Number.isFinite(height) && height > 0 && this.#pendingFrames.delete(key)) released = true;
    return released;
  }
  #measureGeometry(
    measurements: RowMeasurement[],
    top: number,
    anchor: RowAnchor | undefined,
  ): { scrollTop: number; changed: boolean } {
    const calibratedTop = this.#calibrateTaskHeight(measurements, top, anchor);
    const measured = this.#viewport.measure(measurements, calibratedTop ?? top, anchor);
    return {
      scrollTop: measured.scrollTop,
      changed: measured.changed || calibratedTop !== undefined,
    };
  }
  #calibrateTaskHeight(
    measurements: readonly RowMeasurement[],
    top: number,
    retainedAnchor: RowAnchor | undefined,
  ): number | undefined {
    const indexed = this.#presentation?.indexedHeights;
    if (
      indexed?.sampleOpeningTasks !== true ||
      measurements.length !== this.#mounts.size ||
      this.#pins.size > 0
    )
      return;
    const previous = this.#taskHeightSample;
    const sample = sampleTaskHeights(this.#rows, measurements, previous, {
      width: this.#width,
      font: this.#font,
      variant: this.#rowVariant,
      top,
    });
    if (sample === undefined) return;
    this.#taskHeightSample = sample;
    if (previous?.height === sample.height) return;
    const anchor = retainedAnchor ?? this.#viewport.captureAnchor(top);
    this.#replace();
    return this.#viewport.restoreAnchor(anchor, top);
  }
  #measureRows(current: () => boolean): RowMeasurement[] | undefined {
    if (!this.#admitReconciliation(current)) return;
    const measurements: RowMeasurement[] = [];
    for (const [key, mount] of this.#mounts) {
      const ready = this.#measurementReady(mount, current);
      if (!current()) return;
      if (!ready) continue;
      const style = this.#owner?.getComputedStyle(mount.element);
      if (!current()) return;
      const rect = mount.element.getBoundingClientRect();
      if (!current()) return;
      measurements.push({
        key,
        height: rect.height + this.#margin(style?.marginTop) + this.#margin(style?.marginBottom),
      });
    }
    return measurements;
  }
  #measurementReady(mount: TaskRowMount<T>, current: () => boolean): boolean {
    if (mount.measurementReady === undefined) return true;
    const ready = mount.measurementReady(this.#scrollBuffer !== 'initial');
    return this.#admitReconciliation(current) && ready;
  }
  #margin(value: string | undefined): number {
    const size = Number.parseFloat(value ?? '');
    return Number.isFinite(size) ? size : 0;
  }
  #rowElement(
    index: number,
    update: boolean,
    current: () => boolean,
    staging?: HTMLElement,
  ): HTMLElement | undefined {
    const row = this.#rows.rowAt(index);
    if (row === undefined) return undefined;
    const mount = this.#mounts.get(row.key);
    if (mount === undefined) {
      this.#mountRow(row, current, staging);
    } else if (update) {
      mount.update(row);
      if (!this.#admitReconciliation(current)) return;
    }
    return this.#frames.get(row.key);
  }
  #reserveFrame(key: string, mount: TaskRowMount<T>, current: () => boolean): boolean {
    const ready = this.#measurementReady(mount, current);
    if (!current()) return false;
    if (!ready) this.#pendingFrames.add(key);
    return true;
  }
  #placeMount(key: string, mount: TaskRowMount<T>, current: () => boolean): void {
    const element = mount.element;
    this.#placeFrame(key, element);
    if (!this.#parked.has(key)) {
      if (element.hasClass('abyss-virtual-row-parked')) {
        element.removeClass('abyss-virtual-row-parked');
        element.style.removeProperty('--abyss-virtual-row-width');
      }
      return;
    }
    const host = this.#options.host;
    const hostStyle = this.#owner?.getComputedStyle(host);
    const rowStyle = this.#owner?.getComputedStyle(element);
    if (!current()) return;
    const width =
      host.clientWidth -
      this.#margin(hostStyle?.paddingLeft) -
      this.#margin(hostStyle?.paddingRight) -
      this.#margin(rowStyle?.marginLeft) -
      this.#margin(rowStyle?.marginRight);
    element.setCssProps({ '--abyss-virtual-row-width': `${Math.max(0, width)}px` });
    element.addClass('abyss-virtual-row-parked');
  }
  #placeFrame(key: string, element: HTMLElement): void {
    const frame = this.#frames.get(key);
    if (frame === undefined) return;
    // Source-address retirement may detach a reused holder while destroying its old card.
    if (element.parentElement === null) frame.append(element);
    const bounds = this.#pendingFrames.has(key) ? this.#viewport.rowBounds(key) : undefined;
    const placement =
      this.#placements.get(key) ??
      (bounds === undefined ? undefined : { height: bounds.bottom - bounds.top, offset: 0 });
    if (placement !== undefined) {
      frame.addClass('abyss-virtual-row-frame-clipped');
      frame.setCssProps({ '--abyss-virtual-row-height': `${placement.height}px` });
      element.setCssProps({ '--abyss-virtual-row-offset': `${placement.offset}px` });
    } else if (frame.hasClass('abyss-virtual-row-frame-clipped')) {
      frame.removeClass('abyss-virtual-row-frame-clipped');
      frame.style.removeProperty('--abyss-virtual-row-height');
      element.style.removeProperty('--abyss-virtual-row-offset');
    }
  }
  #spacer(height: number, existing?: HTMLElement, parent = this.#options.host): HTMLElement {
    const element = existing ?? parent.createDiv({ cls: 'abyss-virtual-row-spacer' });
    if (existing === undefined) {
      element.setAttribute('aria-hidden', 'true');
      element.inert = true;
    }
    element.setCssProps({ '--abyss-virtual-row-height': `${height}px` });
    return element;
  }
  #mountRow(
    row: TaskListRow<T>,
    current: () => boolean,
    staging?: HTMLElement,
  ): TaskRowMount<T> | undefined {
    const frame = (staging ?? this.#options.host).createDiv({ cls: 'abyss-virtual-row-frame' });
    // Keep cards connected for Markdown rendering. Lay out the incoming batch together
    // so each mount's host-size check doesn't force layout of the preceding card.
    if (this.#bufferedList) frame.hidden = true;
    let mount: TaskRowMount<T>;
    try {
      mount = this.#options.mount(frame, row);
    } catch (error) {
      frame.remove();
      throw error;
    }
    if (!this.#admitReconciliation(current)) {
      try {
        mount.destroy();
      } finally {
        frame.remove();
      }
      return;
    }
    this.#mounts.set(row.key, mount);
    this.#frames.set(row.key, frame);
    this.#observer?.observe(mount.element, { box: 'border-box' });
    return mount;
  }
  #matchesRenderedRange(window: RowWindow): boolean {
    const previous = this.#renderedRange;
    if (previous?.start !== window.start || previous.end !== window.end) return false;
    // Rows in this contiguous, uncompressed window already flow at their natural heights.
    // A change outside it can still move either spacer.
    if (
      spacerHeight(previous.segments[0]) !== spacerHeight(window.segments[0]) ||
      spacerHeight(previous.segments[previous.segments.length - 1]) !==
        spacerHeight(window.segments[window.segments.length - 1])
    )
      return false;
    // A failed async card update can detach the holder without changing the row order.
    for (const mount of this.#mounts.values())
      if (mount.element.parentElement === null) return false;
    return true;
  }
  #canBufferRange(): boolean {
    return this.#bufferedList && this.#pins.size === 0 && this.#nativeObservers.size === 0;
  }
  #windowBuffer(update: boolean, buffered: boolean, compressed: boolean): ScrollBuffer {
    // Label measurements can reach a new native position before its coalesced scroll event.
    if (this.#activeBuffer === 'search' && this.#scrollBuffer === 'initial')
      this.#bufferScrollStep(this.#options.scroll.scrollTop, this.#lastScroll);
    if (buffered && this.#activeBuffer === 'timeline') return this.#timelineBuffer(compressed);
    if (update || !buffered) return 'initial';
    return this.#activeBuffer !== 'scroll' || !compressed ? this.#scrollBuffer : 'initial';
  }
  #timelineBuffer(compressed: boolean): 'timeline' | 'timeline-seek' {
    return this.#scrollBuffer === 'timeline-seek' && !compressed ? 'timeline-seek' : 'timeline';
  }
  #windowPins(anchorKey: string | undefined): string[] {
    const pinned = [...this.#pins.keys()];
    if (anchorKey !== undefined) pinned.push(anchorKey);
    if (this.#focusedKey !== undefined) pinned.push(this.#focusedKey);
    return pinned;
  }
  #renderWindow(
    update: boolean,
    top: number,
    anchorKey: string | undefined,
    current: () => boolean,
  ): 'retained' | 'published' | undefined {
    const pinned = this.#windowPins(anchorKey);
    const buffered = this.#canBufferRange();
    const compressed = this.#scrollWindow.isCompressed(this.#viewport.totalHeight);
    const buffer = this.#windowBuffer(update, buffered, compressed);
    const window = this.#viewport.window(top, this.#height(), pinned, buffer);
    // Focus and reveal keep the scroll reserve. Range endpoints describe the entire
    // mounted set only when they also cover every protected row.
    const reusable =
      buffered &&
      !compressed &&
      pinned.every((key) => {
        const index = this.#rows.rowIndexOf(key);
        return window.start <= index && index < window.end;
      });
    this.#renderPlacement = this.#place(top);
    if (!update && reusable && this.#matchesRenderedRange(window)) return 'retained';
    this.#renderedRange = undefined;
    this.#options.beforeRowWrites?.();
    const commit = (guard?: HTMLElement): void => {
      this.#commitWindow(window, current, guard, { update, batch: buffer !== 'initial' });
    };
    if (!this.#nativeMutation(commit, current, true)) return;
    this.#options.mountedChanged();
    if (this.#admitReconciliation(current) && reusable) this.#renderedRange = window;
    return 'published';
  }
  #commitWindow(
    window: RowWindow,
    current: () => boolean,
    guard: HTMLElement | undefined,
    { update, batch }: { update: boolean; batch: boolean },
  ): void {
    const host = this.#options.host;
    const established = new Set(this.#mounts.keys());
    const staging = batch ? this.#createStaging() : undefined;
    // Record DOM order so a callback that interrupts eviction can keep surviving
    // rows in their original positions. Normally the staging container ends empty.
    let oldOrder: Element[] = [];
    if (staging !== undefined) {
      staging.hidden = true;
      oldOrder = Array.from(host.children);
    }
    try {
      const segments = this.#physicalSegments(window);
      const rendered = this.#renderSegments(segments, update, current, staging);
      if (rendered === undefined) return;
      this.#stageEvictions(rendered.keys, staging);
      if (!this.#placeRows(rendered.keys, current)) return;
      this.#evictOutside(rendered.keys, current);
      if (!current()) return;
      for (const spacer of rendered.obsolete) spacer.remove();
      this.#order(rendered.desired, established, guard?.parentElement === host ? guard : undefined);
      this.#ordered = [...rendered.keys];
    } finally {
      if (staging !== undefined) this.#finishStaging(staging, oldOrder);
    }
  }
  #createStaging(): HTMLElement {
    const host = this.#options.host;
    return this.#options.stagedMounts === 'detached'
      ? host.ownerDocument.createElement('div')
      : host.createDiv();
  }
  #finishStaging(staging: HTMLElement, oldOrder: Element[]): void {
    const host = this.#options.host;
    if (staging.firstChild === null) {
      staging.remove();
      return;
    }
    let next: Element | null = null;
    oldOrder.reverse();
    for (const frame of oldOrder) {
      if (frame.parentElement === staging) host.insertBefore(frame, next);
      if (frame.parentElement === host) next = frame;
    }
    // Only unpublished incoming frames remain. Keep them connected for Markdown.
    for (const frame of Array.from(staging.children)) {
      if (frame.hasClass('abyss-virtual-row-frame')) {
        frame.setAttribute('hidden', '');
        host.appendChild(frame);
      }
    }
    staging.remove();
  }
  #stageEvictions(keys: ReadonlySet<string>, staging: HTMLElement | undefined): void {
    if (staging === undefined) return;
    for (const [key, frame] of this.#frames) {
      if (!keys.has(key)) staging.appendChild(frame);
    }
  }
  #segmentBounds(segment: RowSegment): RowBounds | undefined {
    const key = this.#segmentKey(segment);
    return key === undefined ? undefined : this.#viewport.rowBounds(key);
  }
  #physicalSegments(window: RowWindow): readonly RowSegment[] {
    this.#parked.clear();
    this.#placements.clear();
    const { segments, start, end } = window;
    const placement = this.#renderPlacement;
    if (placement === undefined || this.#viewport.totalHeight <= placement.extent) return segments;
    const result: RowSegment[] = [];
    let cursor = 0;
    for (const segment of segments) {
      const bounds = this.#segmentBounds(segment);
      if (bounds === undefined) continue;
      if (bounds.index < start || bounds.index >= end) {
        this.#parked.add(bounds.key);
        this.#placements.set(bounds.key, { height: 0, offset: 0 });
        result.push(segment);
        continue;
      }
      const physicalTop = bounds.top - placement.origin;
      const top = Math.max(0, Math.min(placement.extent, physicalTop));
      const bottom = Math.max(top, Math.min(placement.extent, bounds.bottom - placement.origin));
      this.#placements.set(bounds.key, { height: bottom - top, offset: physicalTop - top });
      if (top > cursor) result.push({ height: top - cursor });
      result.push(segment);
      cursor = bottom;
    }
    if (cursor < placement.extent) result.push({ height: placement.extent - cursor });
    return result;
  }
  #renderSegments(
    segments: readonly RowSegment[],
    update: boolean,
    current: () => boolean,
    staging?: HTMLElement,
  ): RenderedSegments | undefined {
    const desired: HTMLElement[] = [];
    const keys = new Set<string>();
    const oldSpacers = Array.from(
      this.#options.host.querySelectorAll<HTMLElement>(
        ':scope > .abyss-virtual-row-spacer:not([data-abyss-scroll-guard])',
      ),
    );
    const reusable = staging === undefined ? oldSpacers.splice(0) : [];
    for (const segment of segments) {
      const element =
        'height' in segment
          ? this.#spacer(segment.height, reusable.shift(), staging)
          : this.#rowElement(segment.index, update, current, staging);
      if (!current()) return;
      if (element !== undefined) desired.push(element);
      const key = this.#segmentKey(segment);
      if (key !== undefined) keys.add(key);
    }
    // Staged scrolling keeps the published extents until every row callback is admitted.
    return { desired, keys, obsolete: oldSpacers.concat(reusable) };
  }
  #showIncomingFrames(keys: ReadonlySet<string>): void {
    if (!this.#bufferedList) return;
    for (const key of keys) {
      const frame = this.#frames.get(key);
      if (frame?.hidden === true) frame.hidden = false;
    }
  }
  #placeRows(keys: ReadonlySet<string>, current: () => boolean): boolean {
    this.#showIncomingFrames(keys);
    // Keep callback admission reads ahead of frame CSS writes; releasing one row must not
    // force layout while checking the next row's readiness.
    for (const key of keys) {
      const mount = this.#mounts.get(key);
      if (mount !== undefined && !this.#reserveFrame(key, mount, current)) return false;
    }
    for (const key of keys) {
      const mount = this.#mounts.get(key);
      if (mount !== undefined) this.#placeMount(key, mount, current);
      if (!current()) return false;
    }
    return true;
  }
  #segmentKey(segment: RowSegment): string | undefined {
    return 'index' in segment ? this.#rows.rowAt(segment.index)?.key : undefined;
  }
  #evictOutside(keys: ReadonlySet<string>, current: () => boolean): void {
    for (const [key, mount] of this.#mounts) {
      if (!keys.has(key)) {
        this.#evict(key, mount);
        if (!this.#admitReconciliation(current)) return;
      }
      if (!current()) return;
    }
  }
  #invalidatePins(keys: readonly string[]): void {
    const callbacks: Array<() => void> = [];
    for (const key of keys) {
      const owners = this.#pins.get(key);
      this.#pins.delete(key);
      for (const owner of owners ?? [])
        if (owner.onInvalidated !== undefined) callbacks.push(owner.onInvalidated);
    }
    const errors: unknown[] = [];
    const invalidating = this.#invalidating;
    this.#invalidating = true;
    try {
      for (const callback of callbacks) {
        try {
          callback();
        } catch (error) {
          errors.push(error);
        }
      }
    } finally {
      this.#invalidating = invalidating;
    }
    if (errors.length > 0) throw errors[0];
  }
  #resolvePinOrder(): void {
    if (this.#pins.size === 0) return;
    const revision = this.#revision;
    let conflicting = this.#conflictingPins();
    while (conflicting.length > 0) {
      this.#invalidatePins(conflicting);
      if (this.#destroyed || revision !== this.#revision) return;
      this.#readFocus();
      conflicting = this.#conflictingPins();
    }
  }
  #conflictingPins(): string[] {
    const protectedKeys = new Set(this.#pins.keys());
    if (this.#focusedKey !== undefined) protectedKeys.add(this.#focusedKey);
    const positions = new Map(
      [...protectedKeys].map((key) => [key, this.#viewport.rowBounds(key)?.index ?? -1]),
    );
    const current = this.#orderedProtectedKeys(protectedKeys);
    const conflicting = new Set<string>();
    for (const [index, a] of current.entries()) {
      const reversed = current
        .slice(index + 1)
        .filter((b) => (positions.get(a) ?? -1) > (positions.get(b) ?? -1));
      for (const b of reversed) {
        if (a !== this.#focusedKey) conflicting.add(a);
        if (b !== this.#focusedKey) conflicting.add(b);
      }
    }
    return [...conflicting];
  }
  #orderedProtectedKeys(keys: ReadonlySet<string>): string[] {
    const elements = new Map([...this.#frames].map(([key, frame]) => [frame, key]));
    return Array.from(this.#options.host.children).flatMap((element) => {
      const key = elements.get(element as HTMLElement);
      return key !== undefined && keys.has(key) ? [key] : [];
    });
  }
  #order(
    desired: readonly HTMLElement[],
    established: ReadonlySet<string>,
    guard?: HTMLElement,
  ): void {
    const protectedElements = new Set<HTMLElement>();
    const focused = this.#options.host.ownerDocument.activeElement;
    for (const [key, frame] of this.#frames)
      if (frame.contains(focused) || (established.has(key) && this.#pins.has(key)))
        protectedElements.add(frame);
    // New mounts must first enter logical order. Only established pins own their position;
    // actual focus is protected regardless of when its row mounted.
    // Move ordinary neighbors around owners; never detach an interaction-owned subtree.
    let next: HTMLElement | null = guard ?? null;
    for (const element of [...desired].reverse()) {
      if (
        element.parentElement !== this.#options.host ||
        (!protectedElements.has(element) && element.nextSibling !== next)
      )
        this.#options.host.insertBefore(element, next);
      next = element;
    }
  }
  #retireFailed(error: unknown): unknown {
    const revision = this.#revision;
    const errors = [error];
    try {
      this.#invalidatePins([...this.#pins.keys()]);
    } catch (cleanupError) {
      errors.push(cleanupError);
    }
    // Cancellation may synchronously install a new source and its live mounts.
    if (revision === this.#revision) this.#retireMounts(errors);
    return errors.length === 1
      ? error
      : new AggregateError(errors, 'Task list refresh and cleanup failed');
  }
  #retireMounts(errors: unknown[]): void {
    const revision = this.#revision;
    for (const [key, mount] of this.#mounts) {
      if (revision !== this.#revision) return;
      try {
        this.#evict(key, mount);
      } catch (cleanupError) {
        errors.push(cleanupError);
      }
    }
    if (revision === this.#revision) this.#ordered = [];
  }
  #guard(action: () => void, failure: 'report' | 'throw' = 'report'): void {
    try {
      action();
    } catch (error) {
      if (this.#frame !== undefined) this.#owner?.cancelAnimationFrame(this.#frame);
      this.#frame = undefined;
      this.#failed = true;
      this.#endTimelineSeek();
      this.#clearInput();
      this.#ownedWrite = undefined;
      const reported = this.#retireFailed(error);
      if (failure === 'throw') throw reported;
      this.#options.reportFailure(reported);
    }
  }
}
