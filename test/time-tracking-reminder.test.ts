import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskIndexEvent, TrackedEntry } from '../src/tasks';
import { TimeTrackingReminder } from '../src/ui/timeTracking/TimeTrackingReminder';

const START = Date.parse('2026-10-28T10:00:00Z');
function entry(title = 'Prepare the draft', startMs = START): TrackedEntry {
  const ref = { filePath: 'task.md', line: 0, revision: 'one' };
  return {
    filePath: 'task.md',
    root: ref,
    target: { type: 'task', ref },
    address: 'task',
    rootAddress: 'task',
    title,
    status: 'open',
    entry: {
      state: 'running',
      startMs,
      relativeLine: 1,
      originalMarkdown: '- 2026-10-28T10:00:00Z →',
    },
  };
}
function setup(initial: readonly TrackedEntry[] = [entry()]) {
  let entries = initial;
  const listeners = new Set<(event: TaskIndexEvent) => void>();
  const sound = { prepare: vi.fn(async () => {}), play: vi.fn(async () => {}), destroy: vi.fn() };
  const notify = vi.fn<(tracked: TrackedEntry, minutes: number) => void>();
  const reportFailure = vi.fn();
  const activeEntries = vi.fn(() => entries);
  const subject = new TimeTrackingReminder({
    queries: {
      activeEntries,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    win: window,
    now: () => Date.now(),
    createSound: () => sound,
    notify,
    reportFailure,
  });
  return {
    subject,
    sound,
    notify,
    reportFailure,
    activeEntries,
    listeners,
    change(this: void, next: readonly TrackedEntry[]) {
      entries = next;
      for (const listener of listeners) listener({ type: 'changed', files: ['task.md'] });
    },
  };
}
function visibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('time tracking reminder', () => {
  const subjects: TimeTrackingReminder[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    visibility('visible');
  });
  afterEach(() => {
    for (const subject of subjects.splice(0)) subject.destroy();
    vi.useRealTimers();
  });
  function make(initial?: readonly TrackedEntry[]) {
    const value = setup(initial);
    subjects.push(value.subject);
    return value;
  }

  it('stays silent while off and schedules interval boundaries without polling the index', async () => {
    const { subject, notify, sound, activeEntries } = make();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(notify).not.toHaveBeenCalled();
    expect(sound.play).not.toHaveBeenCalled();
    vi.setSystemTime(START);
    subject.setInterval(5);
    const reads = activeEntries.mock.calls.length;
    await vi.advanceTimersByTimeAsync(299_999);
    expect(notify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(notify).toHaveBeenCalledExactlyOnceWith(entry(), 5);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(notify).toHaveBeenLastCalledWith(entry(), 10);
    expect(sound.play).toHaveBeenCalledTimes(2);
    expect(activeEntries).toHaveBeenCalledTimes(reads);
  });

  it('retains the deadline across refreshes but uses the current task title', async () => {
    const { subject, change, notify } = make();
    subject.setInterval(5);
    await vi.advanceTimersByTimeAsync(240_000);
    change([entry('Renamed task')]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(notify).toHaveBeenCalledExactlyOnceWith(entry('Renamed task'), 5);
  });

  it('cancels the previous entry when switching tasks and stops when tracking stops', async () => {
    const { subject, change, notify } = make();
    subject.setInterval(5);
    await vi.advanceTimersByTimeAsync(240_000);
    const second = entry('Second', START + 240_000);
    change([second]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(notify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(240_000);
    expect(notify).toHaveBeenCalledExactlyOnceWith(second, 5);
    change([]);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('skips expired boundaries on startup and visibility return', async () => {
    vi.setSystemTime(START + 610_000);
    const { subject, notify } = make();
    subject.setInterval(5);
    expect(notify).not.toHaveBeenCalled();
    visibility('hidden');
    await vi.advanceTimersByTimeAsync(1_200_000);
    visibility('visible');
    expect(notify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(290_000);
    expect(notify).toHaveBeenCalledExactlyOnceWith(entry(), 35);
  });

  it('uses only the newest eligible running entry and excludes completed tasks', async () => {
    const finished = { ...entry('Finished'), status: 'done' as const };
    const { subject, notify } = make([
      finished,
      entry('Earlier', START - 60_000),
      entry('Current'),
    ]);
    subject.setInterval(5);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(notify).toHaveBeenCalledExactlyOnceWith(entry('Current'), 5);
  });

  it('skips a reminder delayed by sleep without a visibility event', async () => {
    const { subject, notify } = make();
    subject.setInterval(5);
    await vi.advanceTimersByTimeAsync(299_999);
    vi.setSystemTime(START + 17 * 60_000 - 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(notify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(179_999);
    expect(notify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(notify).toHaveBeenCalledExactlyOnceWith(entry(), 20);
  });

  it('allows ordinary timer jitter at a reminder boundary', async () => {
    const { subject, notify } = make();
    subject.setInterval(5);
    await vi.advanceTimersByTimeAsync(299_999);
    vi.setSystemTime(START + 304_000 - 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(notify).toHaveBeenCalledExactlyOnceWith(entry(), 5);
  });

  it('previews only an explicit request and cancels all resources on Off or disposal', async () => {
    const { subject, sound, notify, listeners } = make();
    subject.setInterval(5);
    expect(sound.play).not.toHaveBeenCalled();
    subject.preview();
    await vi.advanceTimersByTimeAsync(0);
    expect(sound.play).toHaveBeenCalledTimes(1);
    subject.setInterval(0);
    subject.preview();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(sound.play).toHaveBeenCalledTimes(1);
    expect(sound.destroy).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
    subject.setInterval(5);
    subject.destroy();
    expect(listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps text reminders when audio fails and reports a repeated failure only once', async () => {
    const { subject, sound, notify, reportFailure } = make();
    sound.play.mockRejectedValue(new Error('Audio unavailable'));
    subject.setInterval(5);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(reportFailure).toHaveBeenCalledTimes(1);
  });
});
