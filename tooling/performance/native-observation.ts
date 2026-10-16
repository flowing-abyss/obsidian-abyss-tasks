import type { Sample } from './types.ts';

export function activityMetrics(
  entries: ReadonlyArray<Pick<PerformanceEntry, 'startTime' | 'duration'>>,
  frames: readonly number[],
  start: number,
  end: number,
): Pick<Sample, 'longTasks' | 'longTaskMs' | 'maxFrameGapMs'> {
  const overlaps = entries.filter(
    (entry) => entry.startTime < end && entry.startTime + entry.duration > start,
  );
  const times = [start, ...frames.filter((time) => time > start && time < end), end];
  return {
    longTasks: overlaps.length,
    longTaskMs: overlaps.reduce(
      (sum, entry) =>
        sum + Math.min(end, entry.startTime + entry.duration) - Math.max(start, entry.startTime),
      0,
    ),
    maxFrameGapMs: Math.max(0, ...times.slice(1).map((time, i) => time - (times[i] ?? start))),
  };
}

export class NativeObservation {
  private readonly entries: PerformanceEntry[] = [];
  private readonly frames: number[] = [];
  private frame = 0;
  private observer: PerformanceObserver | undefined;
  private running = false;

  start(): void {
    this.running = true;
    this.entries.length = 0;
    this.frames.length = 0;
    this.frames.push(performance.now());
    if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
      this.observer = new PerformanceObserver((list) => {
        this.entries.push(...list.getEntries());
      });
      this.observer.observe({ type: 'longtask' });
    }
    this.tick();
  }
  private tick(): void {
    this.frame = window.requestAnimationFrame((time) => {
      if (!this.running) return;
      if (this.frames.length < 10000) this.frames.push(time);
      this.tick();
    });
  }
  read(
    start: number,
    end: number,
  ): Pick<Sample, 'longTasks' | 'longTaskMs' | 'maxFrameGapMs' | 'domNodes'> {
    const metrics = activityMetrics(
      [...this.entries, ...(this.observer?.takeRecords() ?? [])],
      this.frames,
      start,
      end,
    );
    return {
      ...metrics,
      longTasks: this.observer === undefined ? null : metrics.longTasks,
      longTaskMs: this.observer === undefined ? null : metrics.longTaskMs,
      domNodes: document.querySelector('.abyss-panel-view')?.querySelectorAll('*').length ?? 0,
    };
  }
  stop(): void {
    this.running = false;
    window.cancelAnimationFrame(this.frame);
    this.observer?.disconnect();
    this.observer = undefined;
  }
}
