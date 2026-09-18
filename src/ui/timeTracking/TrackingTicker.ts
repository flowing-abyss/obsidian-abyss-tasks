import type { TaskQueryApi, TimeTrackingQueryApi, TrackedEntry } from '../../tasks';

/** Everything a tracking surface repaints from, with no further question to the index. */
export interface TrackingTickerState {
  readonly nowMs: number;
  readonly active: readonly TrackedEntry[];
}

type TrackingTickerListener = (state: TrackingTickerState) => void;

interface TrackingTickerDependencies {
  readonly queries: TimeTrackingQueryApi & Pick<TaskQueryApi, 'subscribe'>;
  readonly now: () => number;
  readonly win: Window;
}

const TICK_MS = 1000;

/**
 * The one second-resolution clock every tracking surface shares.
 *
 * A tick never touches the index: the active entries are read only when the index reports a
 * change, and the shared frozen array is handed on by reference. The interval itself exists only
 * while something is actually running and somebody is actually listening, so an idle vault and an
 * unmounted surface both cost nothing.
 */
export class TrackingTicker {
  private readonly listeners_abyssPrivate = new Set<TrackingTickerListener>();
  private active_abyssPrivate: readonly TrackedEntry[];
  private unsubscribeIndex_abyssPrivate: () => void;
  private intervalId_abyssPrivate: number | undefined;
  private destroyed_abyssPrivate = false;

  constructor(private readonly deps_abyssPrivate: TrackingTickerDependencies) {
    this.active_abyssPrivate = deps_abyssPrivate.queries.activeEntries();
    this.unsubscribeIndex_abyssPrivate = deps_abyssPrivate.queries.subscribe(() => {
      this.onIndexEvent_abyssPrivate();
    });
  }

  /** Listener fires immediately, on every index change, and every second while something runs. */
  subscribe(listener: TrackingTickerListener): () => void {
    if (this.destroyed_abyssPrivate) return () => {};
    this.listeners_abyssPrivate.add(listener);
    this.syncInterval_abyssPrivate();
    listener(this.state_abyssPrivate());
    return () => {
      if (!this.listeners_abyssPrivate.delete(listener)) return;
      this.syncInterval_abyssPrivate();
    };
  }

  destroy(): void {
    this.destroyed_abyssPrivate = true;
    this.listeners_abyssPrivate.clear();
    this.unsubscribeIndex_abyssPrivate();
    this.unsubscribeIndex_abyssPrivate = () => {};
    this.syncInterval_abyssPrivate();
  }

  private onIndexEvent_abyssPrivate(): void {
    this.active_abyssPrivate = this.deps_abyssPrivate.queries.activeEntries();
    this.syncInterval_abyssPrivate();
    this.emit_abyssPrivate();
  }

  private state_abyssPrivate(): TrackingTickerState {
    return { nowMs: this.deps_abyssPrivate.now(), active: this.active_abyssPrivate };
  }

  private emit_abyssPrivate(): void {
    if (this.listeners_abyssPrivate.size === 0) return;
    const state = this.state_abyssPrivate();
    // Set iteration tolerates a listener unsubscribing itself or a sibling mid-emit, so the tick
    // notifies without copying the set.
    for (const listener of this.listeners_abyssPrivate) listener(state);
  }

  private syncInterval_abyssPrivate(): void {
    const wanted =
      !this.destroyed_abyssPrivate &&
      this.listeners_abyssPrivate.size > 0 &&
      this.active_abyssPrivate.length > 0;
    if (wanted === (this.intervalId_abyssPrivate !== undefined)) return;
    if (wanted) {
      this.intervalId_abyssPrivate = this.deps_abyssPrivate.win.setInterval(() => {
        this.emit_abyssPrivate();
      }, TICK_MS);
      return;
    }
    this.deps_abyssPrivate.win.clearInterval(this.intervalId_abyssPrivate);
    this.intervalId_abyssPrivate = undefined;
  }
}
