import type { NativeWindow, NativeWindowState } from './native-types.ts';
import { bounded } from './profiler.ts';
import type { Sample } from './types.ts';

type WindowEvidence = NativeWindowState & { documentVisibility: DocumentVisibilityState };
interface HiddenEvidence {
  before: WindowEvidence;
  hidden?: WindowEvidence;
  hiddenEnd?: WindowEvidence;
  restored?: WindowEvidence;
  frameGapIsIntentional: true;
}
export class HiddenWindowObservation {
  private active: { controller: AbortController; evidence: HiddenEvidence } | undefined;
  private restoration: Promise<void> | undefined;
  constructor(
    private readonly native: NativeWindow,
    private readonly owner: Document,
    private readonly save: (evidence: HiddenEvidence) => void,
  ) {}
  private state(): WindowEvidence {
    return { ...this.native.state(), documentVisibility: this.owner.visibilityState };
  }
  async run(action: (signal: AbortSignal) => Promise<Sample['facts']>): Promise<Sample['facts']> {
    const before = this.state();
    if (
      this.active !== undefined ||
      !before.visible ||
      !before.focused ||
      before.minimized ||
      before.documentVisibility !== 'visible'
    )
      throw new Error('Hidden diagnostic requires the visible focused original window');
    const evidence: HiddenEvidence = { before, frameGapIsIntentional: true };
    const controller = new AbortController();
    this.active = { controller, evidence };
    this.restoration = undefined;
    try {
      await this.visibility(
        'hidden',
        () => {
          this.native.hide();
        },
        controller.signal,
      );
      evidence.hidden = this.hidden(before.id);
      const facts = await bounded(action(controller.signal), 30000, 'hidden note search');
      evidence.hiddenEnd = this.hidden(before.id);
      return facts;
    } finally {
      try {
        await this.restore();
      } finally {
        this.save(evidence);
        this.active = undefined;
      }
    }
  }
  private hidden(id: number): WindowEvidence {
    const state = this.state();
    if (state.id !== id || state.visible || state.documentVisibility !== 'hidden')
      throw new Error('Hidden diagnostic window identity or visibility changed');
    return state;
  }
  async restore(): Promise<void> {
    const active = this.active;
    if (active === undefined) return;
    this.restoration ??= this.restoreWindow(active);
    await this.restoration;
  }
  private async restoreWindow(
    active: NonNullable<HiddenWindowObservation['active']>,
  ): Promise<void> {
    active.controller.abort();
    if (this.native.state().id !== active.evidence.before.id)
      throw new Error('Refusing to restore a different native window');
    await this.visibility('visible', () => {
      this.native.show();
    });
    const restored = this.state();
    this.recordRestored(active, restored);
    if (JSON.stringify(restored) !== JSON.stringify(active.evidence.before))
      throw new Error('Original native window state was not restored');
  }
  private recordRestored(
    active: NonNullable<HiddenWindowObservation['active']>,
    restored: WindowEvidence,
  ): void {
    if (this.active !== active) throw new Error('Hidden observation owner changed');
    active.evidence.restored = restored;
  }
  private async visibility(
    state: DocumentVisibilityState,
    change: () => void,
    signal?: AbortSignal,
  ): Promise<void> {
    let check = (): void => {},
      abort = (): void => {};
    const pending = new Promise<void>((resolve, reject) => {
      check = () => {
        if (this.owner.visibilityState === state) resolve();
      };
      abort = () => {
        reject(new Error('Hidden diagnostic aborted'));
      };
    });
    this.owner.addEventListener('visibilitychange', check);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted === true) throw new Error('Hidden diagnostic aborted');
      change();
      check();
      await bounded(pending, 30000, `window visibility ${state}`);
    } finally {
      this.owner.removeEventListener('visibilitychange', check);
      signal?.removeEventListener('abort', abort);
    }
  }
}

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
