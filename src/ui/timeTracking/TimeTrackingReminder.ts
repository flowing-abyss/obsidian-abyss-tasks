import type { TimeTrackingReminderInterval } from '../../settings/timeTrackingReminderSettings';
import type { TaskQueryApi, TimeTrackingQueryApi, TrackedEntry } from '../../tasks';

export interface ReminderSound {
  prepare(): Promise<void>;
  play(): Promise<void>;
  destroy(): void;
}

interface ReminderDependencies {
  readonly queries: Pick<TimeTrackingQueryApi, 'activeEntries'> & Pick<TaskQueryApi, 'subscribe'>;
  readonly win: Window;
  readonly now: () => number;
  readonly createSound: () => ReminderSound;
  readonly notify: (tracked: TrackedEntry, minutes: number) => void;
  readonly reportFailure: (error: unknown) => void;
}

const MINUTE_MS = 60_000;
// Allow normal scheduling jitter, but skip reminders held through sleep or a long stall.
const MAX_REMINDER_DELAY_MS = 5_000;

/** One plugin-owned schedule, independent of the number of mounted tracking surfaces. */
export class TimeTrackingReminder {
  private interval: TimeTrackingReminderInterval = 0;
  private active: TrackedEntry | undefined;
  private sessionKey: string | undefined;
  private nextAt = 0;
  private timeout: number | undefined;
  private sound: ReminderSound | undefined;
  private audioFailed = false;
  private disposed = false;
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: ReminderDependencies) {
    this.unsubscribe = deps.queries.subscribe(() => {
      this.refresh();
    });
    deps.win.document.addEventListener('visibilitychange', this.onVisibility);
    deps.win.document.addEventListener('pointerup', this.onInteraction, true);
    deps.win.document.addEventListener('keydown', this.onInteraction, true);
  }

  setInterval(minutes: TimeTrackingReminderInterval): void {
    if (this.disposed || this.interval === minutes) return;
    this.interval = minutes;
    this.sessionKey = undefined;
    if (minutes === 0) this.releaseSound();
    this.refresh();
  }

  preview(): void {
    if (!this.disposed && this.interval > 0) this.play();
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelTimeout();
    this.releaseSound();
    this.unsubscribe();
    const doc = this.deps.win.document;
    doc.removeEventListener('visibilitychange', this.onVisibility);
    doc.removeEventListener('pointerup', this.onInteraction, true);
    doc.removeEventListener('keydown', this.onInteraction, true);
  }

  private readonly onInteraction = (event: Event): void => {
    if (event.isTrusted && this.interval > 0 && !this.disposed) this.useSound('prepare');
  };

  private readonly onVisibility = (): void => {
    this.sessionKey = undefined;
    if (this.deps.win.document.visibilityState === 'hidden') this.releaseSound();
    this.refresh();
  };

  private refresh(): void {
    this.cancelTimeout();
    if (this.disposed || this.interval === 0) return;
    const now = this.deps.now();
    this.active = this.deps.queries
      .activeEntries()
      .reduce<TrackedEntry | undefined>((latest, entry) => {
        const start = entry.entry.startMs;
        if (
          entry.entry.state !== 'running' ||
          start === undefined ||
          !Number.isFinite(start) ||
          start > now ||
          entry.status === 'done' ||
          entry.status === 'cancelled'
        )
          return latest;
        return latest === undefined || start > (latest.entry.startMs ?? 0) ? entry : latest;
      }, undefined);
    if (this.active === undefined) {
      this.sessionKey = undefined;
      return;
    }
    const start = this.active.entry.startMs ?? now;
    const key = JSON.stringify([this.active.address, start]);
    const intervalMs = this.interval * MINUTE_MS;
    if (key !== this.sessionKey) {
      this.nextAt = start + (Math.floor((now - start) / intervalMs) + 1) * intervalMs;
      this.sessionKey = key;
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.deps.win.document.visibilityState === 'hidden' || this.active === undefined) return;
    this.timeout = this.deps.win.setTimeout(
      () => {
        this.deliver();
      },
      Math.max(1, this.nextAt - this.deps.now()),
    );
  }

  private deliver(): void {
    this.timeout = undefined;
    if (this.disposed || this.interval === 0 || this.active === undefined) return;
    if (this.deps.win.document.visibilityState === 'hidden') {
      this.sessionKey = undefined;
      return;
    }
    const now = this.deps.now();
    const start = this.active.entry.startMs ?? now;
    if (now >= this.nextAt) {
      if (now - this.nextAt <= MAX_REMINDER_DELAY_MS) {
        this.deps.notify(this.active, Math.floor((now - start) / MINUTE_MS));
        this.play();
      }
      const intervalMs = this.interval * MINUTE_MS;
      this.nextAt = start + (Math.floor((now - start) / intervalMs) + 1) * intervalMs;
    }
    this.schedule();
  }

  private play(): void {
    this.useSound('play');
  }

  private useSound(operation: 'prepare' | 'play'): void {
    this.sound ??= this.deps.createSound();
    const sound = this.sound;
    void sound[operation]().then(
      () => {
        if (sound === this.sound) this.audioFailed = false;
      },
      (error: unknown) => {
        if (this.disposed || sound !== this.sound || this.audioFailed) return;
        this.audioFailed = true;
        this.deps.reportFailure(error);
      },
    );
  }

  private releaseSound(): void {
    this.sound?.destroy();
    this.sound = undefined;
    this.audioFailed = false;
  }

  private cancelTimeout(): void {
    if (this.timeout !== undefined) this.deps.win.clearTimeout(this.timeout);
    this.timeout = undefined;
  }
}
