import { EvalBoundaryFailure } from './diagnostics';
import type { CaseReport } from './harness';
import type { RequestBudget } from './safety';
export interface CaseLimits {
  setupMs: number;
  turnMs: number;
  readbackMs: number;
  cleanupMs: number;
}
export const caseLimits: CaseLimits = {
  setupMs: 60_000,
  turnMs: 210_000,
  readbackMs: 30_000,
  cleanupMs: 5_000,
};
export class CaseTimeout extends Error {
  constructor(readonly phase: string) {
    super(`phase-timeout:${phase}`);
  }
}
export class CheckpointFailure extends EvalBoundaryFailure {
  constructor(
    code: 'checkpoint-write-failed' | 'checkpoint-write-timeout' = 'checkpoint-write-failed',
  ) {
    super({ phase: 'campaign', code });
  }
}
/** One case owns its timers, outstanding work and serialized immutable checkpoints. */
export class CaseLifetime {
  private readonly started = performance.now();
  private readonly startRequests: number;
  private tail = Promise.resolve();
  private queued: CaseReport | undefined;
  private pumping = false;
  private writeFailure: CheckpointFailure | undefined;
  private failWrite: (error: CheckpointFailure) => void = () => {};
  private readonly failedWrite = new Promise<CheckpointFailure>((resolve) => {
    this.failWrite = resolve;
  });
  private readonly pending = new Set<Promise<unknown>>();
  private sealed = false;
  private retired = false;
  retire(): void {
    this.retired = true;
  }
  stopped(): boolean {
    return this.retired;
  }
  constructor(
    private readonly report: CaseReport,
    private readonly flush: (report: CaseReport) => Promise<void>,
    private readonly budget: RequestBudget,
    private checkpointMs = 30_000,
  ) {
    this.startRequests = budget.used;
  }
  trace(kind: string, data: unknown): void {
    if (this.sealed) return;
    if (kind === 'generation-input') this.report.phase = 'generation';
    if (kind === 'generation-output') this.report.phase = 'tool';
    if (kind === 'headless-reveal') this.report.phase = 'reveal';
    this.report.trace.push({
      sequence: this.report.trace.length + 1,
      kind,
      data: structuredClone(data),
    });
    this.enqueue();
  }
  private enqueue(): void {
    this.report.physicalRequests = this.budget.used - this.startRequests;
    this.report.elapsedMs = performance.now() - this.started;
    this.queued = structuredClone(this.report);
    if (!this.pumping) {
      this.pumping = true;
      this.tail = this.pump();
    }
  }
  private async pump(): Promise<void> {
    while (this.queued !== undefined && this.writeFailure === undefined) {
      const captured = this.queued;
      this.queued = undefined;
      await this.persist(captured);
    }
    this.pumping = false;
  }
  private async persist(captured: CaseReport): Promise<void> {
    let timer: number | undefined;
    try {
      await Promise.race([
        this.flush(captured),
        this.failedWrite.then((error) => {
          throw error;
        }),
        new Promise<never>((_resolve, reject) => {
          timer = window.setTimeout(() => {
            reject(new CheckpointFailure('checkpoint-write-timeout'));
          }, this.checkpointMs);
        }),
      ]);
    } catch (cause) {
      this.writeFailure = cause instanceof CheckpointFailure ? cause : new CheckpointFailure();
      this.failWrite(this.writeFailure);
    } finally {
      window.clearTimeout(timer);
    }
  }
  async drained(): Promise<void> {
    await this.tail;
    if (this.writeFailure !== undefined) throw this.writeFailure;
  }
  async checkpoint(phase: string): Promise<void> {
    this.report.phase = phase;
    this.trace('case-phase', { phase, turn: this.report.activeTurn ?? null });
    await this.drained();
  }
  track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work);
    void work.then(
      () => {
        this.pending.delete(work);
      },
      () => {
        this.pending.delete(work);
      },
    );
    return work;
  }
  async run<T>(phase: string, milliseconds: number, work: () => Promise<T>): Promise<T> {
    if (this.retired) throw new CaseTimeout(phase);
    const pending = this.track(
      Promise.resolve()
        .then(async () => {
          await this.checkpoint(phase);
          if (this.retired) throw new CaseTimeout(phase);
          return work();
        })
        .then(
          (value) => ({ kind: 'value' as const, value }),
          (error: unknown) => ({ kind: 'error' as const, error }),
        ),
    );
    let timer: number | undefined;
    const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
      timer = window.setTimeout(() => {
        resolve({ kind: 'timeout' });
      }, milliseconds);
    });
    try {
      const result = await Promise.race([
        pending,
        timeout,
        this.failedWrite.then((error) => ({ kind: 'error' as const, error })),
      ]);
      if (result.kind === 'error') throw result.error;
      if (result.kind === 'timeout') throw new CaseTimeout(phase);
      return result.value;
    } finally {
      window.clearTimeout(timer);
    }
  }
  async settle(milliseconds: number, idle: Promise<unknown> = Promise.resolve()): Promise<boolean> {
    this.checkpointMs = Math.min(this.checkpointMs, milliseconds);
    const checkpoint = { settled: false };
    const cleanup = this.checkpoint('cleanup').then(async () => {
      checkpoint.settled = true;
      await Promise.allSettled([...this.pending, idle]);
      return true;
    });
    let timer: number | undefined;
    try {
      const settled = await Promise.race([
        cleanup,
        new Promise<false>((resolve) => {
          timer = window.setTimeout(() => {
            resolve(false);
          }, milliseconds);
        }),
      ]);
      if (!settled && !checkpoint.settled) {
        this.writeFailure = new CheckpointFailure('checkpoint-write-timeout');
        this.failWrite(this.writeFailure);
        await this.drained();
      }
      return settled;
    } finally {
      window.clearTimeout(timer);
    }
  }
  async finish(): Promise<void> {
    this.report.finished = new Date().toISOString();
    this.report.phase = 'finished';
    this.enqueue();
    this.sealed = true;
    await this.drained();
  }
}
