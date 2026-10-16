import type { Sample } from './types.ts';

export async function bounded<T>(
  promise: Promise<T>,
  milliseconds: number,
  label: string,
): Promise<T> {
  const timers = window;
  let timer: number | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = timers.setTimeout(() => {
          reject(new Error(`Timed out: ${label} (${milliseconds} ms)`));
        }, milliseconds);
      }),
    ]);
  } finally {
    timers.clearTimeout(timer);
  }
}

type Metrics = Pick<Sample, 'longTasks' | 'longTaskMs' | 'maxFrameGapMs' | 'domNodes'>;
export class PendingWork {
  private readonly pending = new Set<Promise<unknown>>();
  track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    const done = (): void => {
      this.pending.delete(promise);
    };
    void promise.then(done, done);
    return promise;
  }
  async settle(): Promise<void> {
    await bounded(
      Promise.allSettled([...this.pending]),
      30000,
      'native operations drained before restoration',
    );
  }
}

export class AbyssProfiler {
  private sequence = 0;
  constructor(
    private readonly clock: Pick<
      Performance,
      'now' | 'mark' | 'measure' | 'clearMarks' | 'clearMeasures'
    >,
    private readonly observe: (start: number, end: number) => Metrics | Promise<Metrics> = () => ({
      longTasks: null,
      longTaskMs: null,
      maxFrameGapMs: 0,
      domNodes: 0,
    }),
  ) {}

  async measure(
    scenario: string,
    iteration: number,
    action: () => Promise<Sample['facts']>,
  ): Promise<Sample> {
    const prefix = `abyss-profile:${scenario}:${this.sequence++}`;
    const start = this.clock.now();
    this.clock.mark(`${prefix}:start`);
    try {
      const facts = await action();
      const end = this.clock.now();
      this.clock.mark(`${prefix}:end`);
      this.clock.measure(prefix, `${prefix}:start`, `${prefix}:end`);
      const metrics = await this.observe(start, end);
      return { scenario, iteration, durationMs: end - start, facts, ...metrics };
    } finally {
      this.clock.clearMarks(`${prefix}:start`);
      this.clock.clearMarks(`${prefix}:end`);
      this.clock.clearMeasures(prefix);
    }
  }
}
