import { chimeBuffer } from '../../audioChime';
import type { ReminderSound } from './TimeTrackingReminder';

const RESUME_LIMIT_MS = 1500;
const NOTES = [
  { start: 0.08, frequency: 523.251, duration: 0.4, level: 1, decay: 0.132 },
  { start: 0.29, frequency: 659.255, duration: 0.4, level: 0.72, decay: 0.12 },
  { start: 0.5, frequency: 783.991, duration: 0.43, level: 0.52, decay: 0.125 },
] as const;

/** Owns a lazy audio context, including interrupted activation and idle hardware suspension. */
export class ReminderAudio implements ReminderSound {
  private context: AudioContext | undefined;
  private buffer: AudioBuffer | undefined;
  private source: AudioBufferSourceNode | undefined;
  private finishPlayback: (() => void) | undefined;
  private generation = 0;
  private disposed = false;
  private prepared = false;
  private playing = false;
  private readonly pending = new Map<number, () => void>();

  constructor(
    private readonly win: Window,
    private readonly createContext: () => AudioContext = () =>
      new (win as Window & { AudioContext: typeof AudioContext }).AudioContext(),
  ) {}

  async prepare(): Promise<void> {
    if (this.disposed || this.prepared || this.source !== undefined) return;
    const generation = this.generation;
    const context = this.getContext();
    if (await this.resume(context, generation)) {
      this.prepared = true;
      if (this.isCurrent(generation) && !this.playing) await context.suspend();
    }
  }

  async play(): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.generation;
    this.playing = true;
    try {
      this.cancelPending();
      this.stopPlayback();
      const context = this.getContext();
      if (!(await this.resume(context, generation))) return;
      this.prepared = true;
      this.buffer ??= chimeBuffer(context, NOTES, 1.35, -17.6);
      const source = context.createBufferSource();
      source.buffer = this.buffer;
      source.connect(context.destination);
      this.source = source;
      await new Promise<void>((resolve, reject) => {
        let finished = false;
        const finish = (): void => {
          if (finished) return;
          finished = true;
          source.disconnect();
          if (this.source === source) {
            this.source = undefined;
            this.finishPlayback = undefined;
          }
          resolve();
        };
        this.finishPlayback = finish;
        source.onended = finish;
        try {
          source.start();
        } catch (error) {
          source.disconnect();
          this.source = undefined;
          this.finishPlayback = undefined;
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
      if (this.isCurrent(generation)) await context.suspend();
    } finally {
      if (this.isCurrent(generation)) this.playing = false;
    }
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.playing = false;
    this.generation++;
    this.cancelPending();
    this.stopPlayback();
    this.releaseContext();
  }

  private stopPlayback(): void {
    this.source?.stop();
    this.finishPlayback?.();
  }

  private releaseContext(): void {
    this.buffer = undefined;
    this.prepared = false;
    if (this.context !== undefined) {
      void this.context.close().catch((error: unknown) => {
        console.warn('[abyss-tasks] Could not close reminder audio', error);
      });
    }
    this.context = undefined;
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  private getContext(): AudioContext {
    this.context ??= this.createContext();
    return this.context;
  }

  private async resume(context: AudioContext, generation: number): Promise<boolean> {
    let timeout: number | undefined;
    try {
      const ready = await Promise.race([
        context.resume().then(() => true),
        new Promise<boolean>((resolve) => {
          timeout = this.win.setTimeout(() => {
            resolve(false);
          }, RESUME_LIMIT_MS);
          this.pending.set(timeout, () => {
            resolve(false);
          });
        }),
      ]);
      if (!this.isCurrent(generation)) return false;
      if (!ready || context.state !== 'running') {
        this.releaseContext();
        throw new Error('Audio playback is unavailable.');
      }
      return true;
    } finally {
      if (timeout !== undefined) {
        this.win.clearTimeout(timeout);
        this.pending.delete(timeout);
      }
    }
  }

  private cancelPending(): void {
    for (const [timeout, cancel] of this.pending) {
      this.win.clearTimeout(timeout);
      cancel();
    }
    this.pending.clear();
  }
}
