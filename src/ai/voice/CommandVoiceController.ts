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
  readonly edit: number;
}
interface VoiceJob {
  audio: Blob | undefined;
  readonly basis: VoiceBasis;
  readonly abort: AbortController;
  cancelDeadline?: () => void;
}
export interface CommandVoiceOptions {
  readonly owner: CommandSessionOwner;
  readonly visibility: symbol;
  readonly window: Window & typeof window;
  readonly transcription: CommandTranscriptionPort;
  mode(): 'manual' | 'continuous';
  continuousAvailable(): boolean;
  input(): string;
  retain(text: string): void;
  submit(text: string, basis: CommandSubmissionBasis, admission: () => boolean): Promise<boolean>;
  send(text: string, basis: CommandSubmissionBasis, admission: () => boolean): void;
  activity?(samples: Float32Array | undefined, listening: boolean): void;
  changed(): void;
}
/** Media lifetime belongs to its Q surface; text enters the existing owner queue. */
export class CommandVoiceController {
  private readonly capture: NativeVoiceCapture<VoiceBasis>;
  private readonly unsubscribe: () => void;
  private releaseClaim: (() => void) | undefined;
  private readonly jobs: VoiceJob[] = [];
  private continuous = false;
  private agentBusy = false;
  private stopOnCommandError = false;
  private submittedVoice: VoiceBasis | undefined;
  private generation = 0;
  private edit = 0;
  private recordingBasis: VoiceBasis | undefined;
  private pendingSend: VoiceBasis | undefined;
  private disposed = false;
  private message = '';
  private readonly failed = (cause: unknown): void => {
    this.stop();
    this.message = cause instanceof CommandFailure ? cause.message : providerFailure(cause).message;
    this.changed();
  };
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
      begin: () =>
        (this.recordingBasis = {
          mode: options.mode(),
          submission: options.owner.captureSubmission(options.visibility),
          input: options.owner.captureInput(),
          lifetime: this.generation,
          edit: this.edit,
        }),
      segment: (audio, basis) => {
        this.enqueue(audio, basis);
      },
      activity: (samples) => {
        const listening = this.canShowActivity();
        options.activity?.(listening ? samples : undefined, listening);
      },
      changed: () => {
        this.changed();
      },
      failure: (message) => {
        this.stop();
        this.message = message;
        this.changed();
      },
    });
    options.window.addEventListener('pagehide', this.pagehide);
    options.window.document.addEventListener('visibilitychange', this.visibility);
    let previousPreference = options.owner.snapshot().voiceMode ?? 'manual';
    let failed = options.owner.snapshot().status.kind === 'error';
    this.unsubscribe = options.owner.subscribe((state) => {
      this.agentBusy = ['thinking', 'searching', 'writing'].includes(state.status.kind);
      const failure = state.status.kind === 'error';
      const newFailure = failure && !failed;
      if (failure !== failed) this.stopOnCommandError = failure && this.continuous;
      failed = failure;
      const changedSession = state.id !== this.sessionId;
      this.sessionId = state.id;
      if (changedSession) this.stop();
      const preference = state.voiceMode ?? 'manual',
        changedPreference = preference !== previousPreference;
      previousPreference = preference;
      this.capture.setMode(options.mode());
      if (changedPreference) {
        this.pendingSend = undefined;
        if (
          !changedSession &&
          !newFailure &&
          options.owner.followsVoicePreference(options.visibility)
        )
          this.startContinuous();
      }
      this.syncContinuous();
    });
  }
  private changed(): void {
    if (!this.continuous && !this.capture.active() && !this.pending()) {
      this.releaseClaim?.();
      this.releaseClaim = undefined;
    }
    this.options.changed();
  }
  active(): boolean {
    return this.capture.active();
  }
  microphoneActive(): boolean {
    const state = this.capture.state();
    return state === 'starting' || state === 'listening';
  }
  speaking(): boolean {
    return this.canShowActivity() && this.capture.speaking();
  }
  private canShowActivity(): boolean {
    return !this.commandBusy() && !this.pending();
  }
  private commandBusy(): boolean {
    return this.options.owner.commandPending() || this.agentBusy;
  }
  pending(): boolean {
    return this.jobs.length > 0;
  }
  status():
    | {
        kind: 'attention' | 'starting' | 'finishing' | 'recognizing' | 'listening' | 'paused';
        message: string;
      }
    | undefined {
    if (this.message !== '') return { kind: 'attention', message: this.message };
    if (this.capture.state() === 'starting')
      return { kind: 'starting', message: commandMessage('Starting microphone…') };
    if (this.capture.state() === 'finishing')
      return { kind: 'finishing', message: commandMessage('Finishing recording…') };
    if (this.pending())
      return { kind: 'recognizing', message: commandMessage('Recognizing speech…') };
    if (this.continuous && this.capture.state() === 'idle')
      return { kind: 'paused', message: commandMessage('Microphone paused') };
    return this.active()
      ? {
          kind: 'listening',
          message:
            this.options.mode() === 'manual'
              ? commandMessage('Recording…')
              : commandMessage('Listening…'),
        }
      : undefined;
  }
  toggle(): void {
    if (this.disposed) return;
    const mode = this.options.mode();
    if (this.active() || this.continuous) {
      if (mode === 'continuous') this.stop();
      else this.finish();
      return;
    }
    if (mode === 'continuous') this.startContinuous(true);
    else this.startCapture(mode).catch(this.failed);
  }
  private async startCapture(mode: 'manual' | 'continuous'): Promise<void> {
    if (this.disposed || !this.options.owner.captureSubmission(this.options.visibility).current())
      return;
    if (mode === 'manual' && !this.options.owner.canStartManual(this.options.visibility)) {
      this.message = commandMessage('Continuous voice is active in another panel.');
      this.changed();
      return;
    }
    this.pendingSend = undefined;
    this.message = '';
    this.options.transcription.available();
    this.claim();
    await this.capture.start(mode, mode === 'continuous' ? this.continuousCurrent : undefined);
  }
  private readonly continuousCurrent = (): boolean =>
    this.continuous &&
    this.releaseClaim !== undefined &&
    !this.options.window.document.hidden &&
    !this.options.owner.commandPending() &&
    this.options.owner.captureSubmission(this.options.visibility).current() &&
    this.options.continuousAvailable();
  private claim(): void {
    this.releaseClaim ??= this.options.owner.claimCapture({
      visibility: this.options.visibility,
      stop: () => {
        this.stop();
      },
      workChanged: () => {
        this.syncContinuous();
      },
      awaitingTranscript: () => this.pending() || this.capture.state() === 'finishing',
      continuous: () => this.continuous,
    });
  }
  startContinuous(replace = false): void {
    if (
      this.disposed ||
      this.options.mode() !== 'continuous' ||
      this.options.window.document.hidden ||
      !this.options.owner.canStartContinuous(this.options.visibility, replace) ||
      !this.options.owner.captureSubmission(this.options.visibility).current()
    )
      return;
    this.claim();
    this.continuous = true;
    this.syncContinuous();
  }
  private syncContinuous(): void {
    const busy = this.commandBusy();
    if (busy) this.options.activity?.(undefined, false);
    if (!this.continuous) return;
    if (this.shouldStopContinuous(busy)) {
      this.stop();
      return;
    }
    if (busy) this.pauseForWork();
    else if (!this.active() && !this.pending() && this.submittedVoice === undefined) {
      this.startCapture('continuous').catch(this.failed);
      return;
    }
    this.changed();
  }
  private shouldStopContinuous(busy: boolean): boolean {
    // A failed focus can be repaired by another tool call in the same turn.
    return (
      this.options.mode() !== 'continuous' ||
      this.options.window.document.hidden ||
      (this.stopOnCommandError && !busy)
    );
  }
  private pauseForWork(): void {
    if (!this.microphoneActive()) return;
    this.recordingBasis = undefined;
    this.capture.stop();
  }
  finish(): void {
    this.capture.finish();
  }
  requestSend(): boolean {
    if (!this.active() && !this.pending()) return false;
    this.pendingSend ??= this.recordingBasis ?? this.jobs[this.jobs.length - 1]?.basis;
    this.capture.finish();
    return true;
  }
  edited(): void {
    this.edit++;
    this.pendingSend = undefined;
  }
  clearMessage(): void {
    this.message = '';
  }
  private enqueue(audio: Blob, basis: VoiceBasis): void {
    if (this.disposed || basis.lifetime !== this.generation) return;
    if (this.recordingBasis === basis) this.recordingBasis = undefined;
    if (this.jobs.length >= 2) {
      this.continuous = false;
      this.capture.stop();
      this.message = commandMessage('Voice is catching up. Wait, then use the microphone again.');
      this.changed();
      return;
    }
    this.jobs.push({ audio, basis, abort: new AbortController() });
    this.message = '';
    this.changed();
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
    this.recognize().catch(this.failed);
  }
  private admission(basis: VoiceBasis): () => boolean {
    return () => {
      if (
        this.alive(basis) &&
        basis.submission.continuationCurrent() &&
        basis.input.current() &&
        !basis.input.dirty
      )
        return true;
      this.continuous = false;
      this.message = commandMessage('Voice kept as text. Review before sending.');
      this.changed();
      return false;
    };
  }
  private deliver(job: VoiceJob, text: string): (() => void) | undefined {
    if (!this.alive(job.basis) || job.abort.signal.aborted) return;
    if (text === '') {
      this.continuous = false;
      if (this.pendingSend === job.basis) this.pendingSend = undefined;
      this.message = commandMessage('No clear speech recognized. Try again or type your command.');
      return;
    }
    if (job.basis.mode === 'manual' || this.options.mode() !== job.basis.mode) {
      return this.deliverDictation(job.basis, text);
    }
    this.submitVoice(job.basis, text).catch(this.failed);
    return undefined;
  }
  private async submitVoice(basis: VoiceBasis, text: string): Promise<void> {
    this.submittedVoice = basis;
    try {
      const accepted = await this.options.submit(
        text,
        basis.submission.basis,
        this.admission(basis),
      );
      if (!accepted && this.alive(basis)) {
        this.continuous = false;
        this.message = commandMessage('Voice queue is full. Text retained for review.');
      }
    } catch (cause) {
      if (this.alive(basis)) {
        this.continuous = false;
        this.message = providerFailure(cause).message;
      }
    } finally {
      if (this.submittedVoice === basis) {
        this.submittedVoice = undefined;
        this.syncContinuous();
        this.changed();
      }
    }
  }
  private deliverDictation(basis: VoiceBasis, text: string): (() => void) | undefined {
    const send =
      this.pendingSend === basis &&
      basis.submission.current() &&
      basis.input.current() &&
      basis.edit === this.edit;
    if (this.pendingSend === basis) this.pendingSend = undefined;
    this.retainText(text);
    if (!send) return;
    const input = this.options.owner.captureInput(),
      value = this.options.input();
    const admission = (): boolean =>
      this.alive(basis) &&
      basis.submission.current() &&
      input.current() &&
      basis.edit === this.edit;
    return () => {
      if (admission()) this.options.send(value, basis.submission.basis, admission);
    };
  }
  private retainText(text: string): void {
    const input = this.options.input();
    this.options.retain(input === '' ? text : `${input}\n\n${text}`);
  }
  private async transcribe(job: VoiceJob, audio: Blob): Promise<string> {
    const result = this.options.transcription.transcribe(audio, job.abort.signal);
    job.audio = undefined;
    let timer: number | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      job.cancelDeadline = () => {
        this.options.window.clearTimeout(timer);
        reject(
          new CommandFailure(
            'VOICE_TIMEOUT',
            commandMessage('Voice recognition took too long. Try the microphone again.'),
          ),
        );
      };
      timer = this.options.window.setTimeout(() => {
        job.cancelDeadline?.();
        job.abort.abort();
      }, 45000);
    });
    try {
      return (await Promise.race([result, deadline])).trim();
    } finally {
      this.options.window.clearTimeout(timer);
    }
  }
  private async recognize(): Promise<void> {
    const job = this.jobs[0];
    if (job?.audio === undefined) return;
    let send: (() => void) | undefined;
    try {
      const text = await this.transcribe(job, job.audio);
      send = this.deliver(job, text);
    } catch (cause) {
      this.recognitionFailed(job, cause);
    } finally {
      job.audio = undefined;
      if (this.jobs[0] === job) {
        this.jobs.shift();
        this.changed();
        send?.();
        if (this.jobs.length > 0) this.processNext();
        else this.syncContinuous();
      }
    }
  }
  private recognitionFailed(job: VoiceJob, cause: unknown): void {
    if (this.pendingSend === job.basis) this.pendingSend = undefined;
    if (this.alive(job.basis)) {
      this.continuous = false;
      this.message =
        cause instanceof CommandFailure ? cause.message : providerFailure(cause).message;
    }
  }
  stop(): void {
    this.continuous = false;
    this.stopOnCommandError = false;
    this.submittedVoice = undefined;
    this.generation++;
    this.options.owner.retireVoice(this.options.visibility);
    this.pendingSend = undefined;
    this.recordingBasis = undefined;
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
    this.changed();
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
