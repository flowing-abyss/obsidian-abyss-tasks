import { commandMessage } from '../commandMessages';
import type { CommandSessionOwner } from '../CommandSessionOwner';
import { CommandFailure, type CommandSubmissionBasis } from '../commandTypes';
import { providerFailure } from '../providers/providerFailure';
import { NativeVoiceCapture } from './NativeVoiceCapture';
import type { CommandTranscriptionPort } from './ProviderTranscription';
interface VoiceBasis {
  readonly mode: 'manual' | 'continuous';
  readonly submission: ReturnType<CommandSessionOwner['captureSubmission']>;
  readonly input: ReturnType<CommandSessionOwner['captureInput']>;
  readonly lifetime: number;
}
interface VoiceJob {
  audio: Blob | undefined;
  readonly basis: VoiceBasis;
  readonly abort: AbortController;
  cancelDeadline?: () => void;
}
export interface CommandVoiceOptions {
  readonly owner: CommandSessionOwner;
  readonly window: Window & typeof window;
  readonly transcription: CommandTranscriptionPort;
  mode(): 'manual' | 'continuous';
  input(): string;
  retain(text: string): void;
  submit(text: string, basis: CommandSubmissionBasis, admission: () => boolean): Promise<void>;
  changed(): void;
}
/** Media lifetime belongs to its Q surface; text enters the existing owner queue. */
export class CommandVoiceController {
  private readonly capture: NativeVoiceCapture<VoiceBasis>;
  private readonly unsubscribe: () => void;
  private releaseClaim: (() => void) | undefined;
  private readonly jobs: VoiceJob[] = [];
  private generation = 0;
  private disposed = false;
  private message = '';
  private sessionId: string;
  private readonly pagehide = (): void => {
    this.stop();
  };
  private readonly visibility = (): void => {
    if (this.options.window.document.hidden) this.stop();
  };
  constructor(private readonly options: CommandVoiceOptions) {
    this.sessionId = options.owner.snapshot().id;
    this.capture = new NativeVoiceCapture(options.window, {
      begin: () => ({
        mode: options.mode(),
        submission: options.owner.captureSubmission(),
        input: options.owner.captureInput(),
        lifetime: this.generation,
      }),
      segment: (audio, basis) => {
        this.enqueue(audio, basis);
      },
      changed: () => {
        options.changed();
      },
      failure: (message) => {
        this.stop();
        this.message = message;
        options.changed();
      },
    });
    options.window.addEventListener('pagehide', this.pagehide);
    options.window.document.addEventListener('visibilitychange', this.visibility);
    let previousMode = options.mode();
    this.unsubscribe = options.owner.subscribe((state) => {
      const changedSession = state.id !== this.sessionId;
      if (changedSession) {
        this.stop();
        this.sessionId = state.id;
      }
      const mode = options.mode(),
        changedMode = mode !== previousMode;
      previousMode = mode;
      this.capture.setMode(mode);
      if (!changedSession && changedMode)
        void this.startContinuous().catch((cause) => {
          this.message = providerFailure(cause).message;
          options.changed();
        });
    });
  }
  active(): boolean {
    return this.capture.active();
  }
  speaking(): boolean {
    return this.capture.speaking();
  }
  pending(): boolean {
    return this.jobs.length > 0;
  }
  status(): { kind: 'attention' | 'recognizing' | 'listening'; message: string } | undefined {
    if (this.message !== '') return { kind: 'attention', message: this.message };
    if (this.pending())
      return { kind: 'recognizing', message: commandMessage('Recognizing speech…') };
    return this.active() ? { kind: 'listening', message: commandMessage('Listening…') } : undefined;
  }
  async toggle(): Promise<void> {
    if (this.disposed) return;
    const mode = this.options.mode();
    if (this.active()) {
      if (mode === 'continuous') this.stop();
      else this.finish();
      return;
    }
    await this.startCapture(mode);
  }
  private async startCapture(mode: 'manual' | 'continuous'): Promise<void> {
    this.message = '';
    try {
      this.options.transcription.available();
      this.releaseClaim ??= this.options.owner.claimCapture(() => {
        this.stop();
      });
      await this.capture.start(mode);
    } catch (cause) {
      this.message =
        cause instanceof CommandFailure ? cause.message : providerFailure(cause).message;
      this.options.changed();
    }
  }
  async startContinuous(): Promise<void> {
    if (!this.disposed && this.options.mode() === 'continuous' && !this.active())
      await this.startCapture('continuous');
  }
  finish(): void {
    this.capture.finish();
  }
  clearMessage(): void {
    this.message = '';
  }
  private enqueue(audio: Blob, basis: VoiceBasis): void {
    if (this.disposed || basis.lifetime !== this.generation) return;
    if (this.jobs.length >= 2) {
      this.capture.stop();
      this.message = commandMessage('Voice is catching up. Wait, then use the microphone again.');
      this.options.changed();
      return;
    }
    this.jobs.push({ audio, basis, abort: new AbortController() });
    this.message = '';
    this.options.changed();
    if (this.jobs.length === 1) this.processNext();
  }
  private alive(basis: VoiceBasis): boolean {
    return (
      !this.disposed &&
      basis.lifetime === this.generation &&
      basis.submission.basis.sessionId === this.options.owner.snapshot().id
    );
  }
  private processNext(): void {
    void this.recognize().catch((cause) => {
      this.stop();
      this.message = providerFailure(cause).message;
      this.options.changed();
    });
  }
  private admission(basis: VoiceBasis, text: string): () => boolean {
    let retained = false;
    const admit = (): boolean => {
      if (!this.alive(basis)) return false;
      if (basis.submission.current() && basis.input.current() && !basis.input.dirty) return true;
      if (!retained) {
        retained = true;
        this.retainText(text);
        this.message = commandMessage('Voice kept as text. Review before sending.');
        this.options.changed();
      }
      return false;
    };
    return admit;
  }
  private deliver(job: VoiceJob, text: string): void {
    if (!this.alive(job.basis) || job.abort.signal.aborted) return;
    if (text === '') {
      this.message = commandMessage('No clear speech recognized. Try again or type your command.');
      return;
    }
    if (job.basis.mode === 'manual' || this.options.mode() !== job.basis.mode) {
      this.retainText(text);
      return;
    }
    const admit = this.admission(job.basis, text);
    if (admit())
      void this.options.submit(text, job.basis.submission.basis, admit).catch((cause) => {
        if (this.alive(job.basis)) {
          this.message = providerFailure(cause).message;
          this.options.changed();
        }
      });
  }
  private retainText(text: string): void {
    const input = this.options.input();
    this.options.retain(input === '' ? text : `${input}\n\n${text}`);
  }
  private async recognize(): Promise<void> {
    const job = this.jobs[0];
    if (job?.audio === undefined) return;
    const deadline = { expired: false };
    const timer = this.options.window.setTimeout(() => {
      deadline.expired = true;
      job.abort.abort();
    }, 45000);
    job.cancelDeadline = () => {
      this.options.window.clearTimeout(timer);
    };
    try {
      const result = this.options.transcription.transcribe(job.audio, job.abort.signal);
      job.audio = undefined;
      const text = (await result).trim();
      this.deliver(job, text);
    } catch (cause) {
      if (this.alive(job.basis))
        this.message = deadline.expired
          ? commandMessage('Voice recognition took too long. Try the microphone again.')
          : providerFailure(cause).message;
    } finally {
      job.audio = undefined;
      this.options.window.clearTimeout(timer);
      if (this.jobs[0] === job) {
        this.jobs.shift();
        this.options.changed();
        if (this.jobs.length > 0) this.processNext();
      }
    }
  }
  stop(): void {
    this.generation++;
    this.capture.stop();
    for (const job of this.jobs) {
      job.audio = undefined;
      job.cancelDeadline?.();
      job.abort.abort();
    }
    this.jobs.length = 0;
    this.releaseClaim?.();
    this.releaseClaim = undefined;
    this.message = '';
    this.options.changed();
  }
  dispose(): void {
    this.disposed = true;
    this.options.window.removeEventListener('pagehide', this.pagehide);
    this.options.window.document.removeEventListener('visibilitychange', this.visibility);
    this.unsubscribe();
    this.stop();
    this.capture.dispose();
  }
}
