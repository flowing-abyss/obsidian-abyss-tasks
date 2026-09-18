import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TaskIndexEvent,
  TaskQueryApi,
  TimeTrackingQueryApi,
  TrackedEntry,
} from '../src/tasks';
import { TrackingTicker, type TrackingTickerState } from '../src/ui/timeTracking/TrackingTicker';

type TickerQueries = TimeTrackingQueryApi & Pick<TaskQueryApi, 'subscribe'>;

const tickerListener = () => vi.fn<(state: TrackingTickerState) => void>();

const START_MS = Date.parse('2026-09-20T16:00:00Z');

function trackedEntry(line: number): TrackedEntry {
  const ref = { filePath: 'a.md', line, revision: `r${line}` };
  return {
    filePath: 'a.md',
    root: ref,
    target: { type: 'task', ref },
    title: `Task ${line}`,
    status: 'open',
    entry: {
      relativeLine: 1,
      originalMarkdown: '- 2026-09-20T15:00:00+00:00 →',
      state: 'running',
      startMs: START_MS - 3_600_000,
    },
  };
}

/** A hand-built index double, so every read of `activeEntries` is countable. */
function fakeIndex(initial: readonly TrackedEntry[] = []) {
  const listeners = new Set<(event: TaskIndexEvent) => void>();
  let active = initial;
  let activeCalls = 0;
  const api: TickerQueries = {
    activeEntries: () => {
      activeCalls += 1;
      return active;
    },
    entriesOverlapping: () => [],
    fileTotal: () => ({ closedMs: 0, openStartsMs: [] }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    api,
    calls: () => activeCalls,
    indexListeners: () => listeners.size,
    change(next?: readonly TrackedEntry[]) {
      if (next !== undefined) active = next;
      const event: TaskIndexEvent = { type: 'changed', files: ['a.md'] };
      for (const listener of [...listeners]) listener(event);
    },
  };
}

function ticker(index: ReturnType<typeof fakeIndex>): TrackingTicker {
  return new TrackingTicker({ queries: index.api, now: () => Date.now(), win: window });
}

describe('TrackingTicker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the interval idle until something subscribes', () => {
    const index = fakeIndex([trackedEntry(1)]);
    const subject = ticker(index);

    expect(vi.getTimerCount()).toBe(0);

    subject.subscribe(() => {});
    expect(vi.getTimerCount()).toBe(1);

    subject.destroy();
  });

  it('never starts an interval while nothing is running', () => {
    const index = fakeIndex();
    const subject = ticker(index);
    const listener = tickerListener();

    subject.subscribe(listener);

    expect(vi.getTimerCount()).toBe(0);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ nowMs: START_MS, active: [] });

    subject.destroy();
  });

  it('hands a new listener the clock and the shared active array immediately', () => {
    const entries = [trackedEntry(1)];
    const index = fakeIndex(entries);
    const subject = ticker(index);
    const listener = tickerListener();

    subject.subscribe(listener);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0].active).toBe(entries);
    expect(listener.mock.calls[0]?.[0].nowMs).toBe(START_MS);

    subject.destroy();
  });

  it('emits once per second while something runs', () => {
    const index = fakeIndex([trackedEntry(1)]);
    const subject = ticker(index);
    const listener = tickerListener();
    subject.subscribe(listener);
    listener.mockClear();

    vi.advanceTimersByTime(3000);

    expect(listener).toHaveBeenCalledTimes(3);
    expect(listener.mock.calls.map((call) => call[0].nowMs)).toEqual([
      START_MS + 1000,
      START_MS + 2000,
      START_MS + 3000,
    ]);

    subject.destroy();
  });

  it('never reads the index on a tick, only on an index event', () => {
    const index = fakeIndex([trackedEntry(1)]);
    const subject = ticker(index);
    subject.subscribe(() => {});
    const afterSubscribe = index.calls();

    vi.advanceTimersByTime(5000);
    expect(index.calls()).toBe(afterSubscribe);

    index.change();
    expect(index.calls()).toBe(afterSubscribe + 1);

    subject.destroy();
  });

  it('notifies every listener on an index event', () => {
    const index = fakeIndex([trackedEntry(1)]);
    const subject = ticker(index);
    const first = tickerListener();
    const second = tickerListener();
    subject.subscribe(first);
    subject.subscribe(second);
    first.mockClear();
    second.mockClear();

    const replaced = [trackedEntry(2)];
    index.change(replaced);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first.mock.calls[0]?.[0].active).toBe(replaced);

    subject.destroy();
  });

  it('clears the interval when the last entry stops and restarts it when tracking resumes', () => {
    const index = fakeIndex([trackedEntry(1)]);
    const subject = ticker(index);
    subject.subscribe(() => {});
    expect(vi.getTimerCount()).toBe(1);

    index.change([]);
    expect(vi.getTimerCount()).toBe(0);

    index.change([trackedEntry(3)]);
    expect(vi.getTimerCount()).toBe(1);

    subject.destroy();
  });

  it('clears the interval only once the last listener unsubscribes', () => {
    const index = fakeIndex([trackedEntry(1)]);
    const subject = ticker(index);
    const unsubscribeFirst = subject.subscribe(() => {});
    const unsubscribeSecond = subject.subscribe(() => {});

    unsubscribeFirst();
    expect(vi.getTimerCount()).toBe(1);

    unsubscribeSecond();
    expect(vi.getTimerCount()).toBe(0);

    subject.destroy();
  });

  it('ignores a repeated unsubscribe from the same listener', () => {
    const index = fakeIndex([trackedEntry(1)]);
    const subject = ticker(index);
    const unsubscribe = subject.subscribe(() => {});
    const stillListening = tickerListener();
    unsubscribe();
    subject.subscribe(stillListening);
    stillListening.mockClear();

    unsubscribe();

    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(stillListening).toHaveBeenCalledTimes(1);

    subject.destroy();
  });

  it('drops the interval, the listeners and the index subscription on destroy', () => {
    const index = fakeIndex([trackedEntry(1)]);
    const subject = ticker(index);
    const listener = tickerListener();
    subject.subscribe(listener);
    listener.mockClear();

    subject.destroy();

    expect(vi.getTimerCount()).toBe(0);
    expect(index.indexListeners()).toBe(0);
    vi.advanceTimersByTime(5000);
    index.change();
    expect(listener).not.toHaveBeenCalled();
  });

  it('stays dead once destroyed, so a late subscriber never revives the interval', () => {
    const index = fakeIndex([trackedEntry(1)]);
    const subject = ticker(index);
    subject.destroy();

    const listener = tickerListener();
    subject.subscribe(listener)();

    expect(vi.getTimerCount()).toBe(0);
    expect(listener).not.toHaveBeenCalled();
  });
});
