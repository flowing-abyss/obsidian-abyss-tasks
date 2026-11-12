import { chimeBuffer } from '../../audioChime';
import { commandMessage } from '../commandMessages';
import { CommandFailure } from '../commandTypes';
export interface VoiceCaptureEvents<B> {
  begin(): B;
  segment(audio: Blob, basis: B): void;
  changed(): void;
  /** The current microphone frame, borrowed until the next sample. Silence clears it. */
  activity?(samples: Float32Array | undefined): void;
  failure(message: string): void;
}
interface Recording<B> {
  readonly recorder: MediaRecorder;
  readonly chunks: Blob[];
  readonly release: () => void;
  basis: B | undefined;
  bytes: number;
  readonly startedAt: number;
  speechTicks: number;
  quietTicks: number;
  ending?: 'utterance' | 'rollover';
}
const SAMPLE_INTERVAL_MS = 50;
const END_OF_UTTERANCE_MS = 3100;
/** Owns one window's physical capture and bounded local pause detection. */
export class NativeVoiceCapture<B> {
  private stream: MediaStream | undefined;
  private context: AudioContext | undefined;
  private source: MediaStreamAudioSourceNode | undefined;
  private analyser: AnalyserNode | undefined;
  private recording: Recording<B> | undefined;
  private timer: number | undefined;
  private generation = 0;
  private starting = false;
  private cancelResume: (() => void) | undefined;
  private listening = false;
  private ignoreSoundUntil = 0;
  private endCue: Promise<void> | undefined;
  private speech = false;
  private disposed = false;
  private readonly releases: Array<() => void> = [];
  private mode: 'manual' | 'continuous' = 'manual';
  constructor(
    private readonly win: Window & typeof window,
    private readonly events: VoiceCaptureEvents<B>,
  ) {}
  active(): boolean {
    return this.starting || this.stream !== undefined || this.recording !== undefined;
  }
  state(): 'idle' | 'starting' | 'listening' | 'finishing' {
    if (this.starting) return 'starting';
    if (this.stream !== undefined) return 'listening';
    return this.recording === undefined ? 'idle' : 'finishing';
  }
  speaking(): boolean {
    return this.speech;
  }
  setMode(mode: 'manual' | 'continuous'): void {
    if (mode !== this.mode) {
      this.mode = mode;
      this.events.changed();
    }
  }
  async start(mode: 'manual' | 'continuous', allowed?: () => boolean): Promise<void> {
    if (this.disposed || this.active()) return;
    const generation = ++this.generation;
    this.mode = mode;
    this.starting = true;
    this.events.changed();
    try {
      const mime = this.supportedMime();
      if (this.endCue !== undefined) await this.endCue;
      if (this.acceptsStart(generation, allowed)) await this.startMedia(generation, mime, allowed);
    } catch (cause) {
      if (generation === this.generation)
        this.fail(
          cause instanceof CommandFailure
            ? cause.message
            : commandMessage('Could not use the microphone. Check permission and try again.'),
        );
    }
  }
  private acceptsStart(generation: number, allowed?: () => boolean): boolean {
    if (generation !== this.generation) return false;
    if (allowed?.() !== false) return true;
    this.fail(commandMessage('Microphone unavailable. Try the microphone again.'));
    return false;
  }
  private async startMedia(
    generation: number,
    mime: string,
    allowed?: () => boolean,
  ): Promise<void> {
    const stream = await this.win.navigator.mediaDevices.getUserMedia({ audio: true });
    if (generation !== this.generation) {
      stream.getTracks().forEach((track) => {
        track.stop();
      });
      return;
    }
    this.stream = stream;
    if (!this.acceptsStart(generation, allowed)) return;
    this.context = new this.win.AudioContext();
    await this.resume(this.context);
    if (!this.acceptsStart(generation, allowed)) return;
    this.source = this.context.createMediaStreamSource(stream);
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 2048;
    this.source.connect(this.analyser);
    this.bindMediaEvents(stream, this.context);
    this.beginRecording(mime);
    this.listening = true;
    this.playCue(this.context, true);
    this.starting = false;
    this.observeSpeech();
    this.events.changed();
  }
  private observeSpeech(): void {
    const samples = new Float32Array(2048);
    this.timer = this.win.setInterval(() => {
      try {
        this.sample(samples);
      } catch {
        this.fail(commandMessage('Voice processing failed. Try the microphone again.'));
      }
    }, SAMPLE_INTERVAL_MS);
  }
  private bindMediaEvents(stream: MediaStream, context: AudioContext): void {
    for (const track of stream.getTracks())
      for (const event of ['ended', 'mute'])
        this.listen(track, event, () => {
          this.fail(commandMessage('Microphone unavailable. Try the microphone again.'));
        });
    this.listen(context, 'statechange', () => {
      if (this.context?.state !== 'running')
        this.fail(commandMessage('Voice input paused. Try the microphone again.'));
    });
    this.listen(this.win, 'pagehide', () => {
      this.stop();
    });
    this.listen(this.win.document, 'visibilitychange', () => {
      if (this.win.document.hidden) this.stop();
    });
  }
  private async resume(context: AudioContext): Promise<void> {
    let timer: number | undefined;
    let cancel: (() => void) | undefined;
    try {
      const ready = await Promise.race([
        context.resume().then(() => true),
        new Promise<boolean>((resolve) => {
          cancel = () => {
            this.win.clearTimeout(timer);
            resolve(false);
          };
          this.cancelResume = cancel;
          timer = this.win.setTimeout(cancel, 1500);
        }),
      ]);
      if (!ready || context.state !== 'running')
        throw new CommandFailure(
          'VOICE_STARTUP',
          commandMessage('Microphone startup timed out. Try the microphone again.'),
        );
    } finally {
      this.win.clearTimeout(timer);
      if (this.cancelResume === cancel) this.cancelResume = undefined;
    }
  }
  private supportedMime(): string {
    const capabilities: {
      devices?: MediaDevices;
      recorder?: typeof MediaRecorder;
      context?: typeof AudioContext;
    } = {
      devices: this.win.navigator.mediaDevices,
      recorder: this.win.MediaRecorder,
      context: this.win.AudioContext,
    };
    if (
      capabilities.devices?.getUserMedia === undefined ||
      capabilities.recorder === undefined ||
      capabilities.context === undefined
    )
      throw new Error('Media unavailable');
    const mime = ['audio/webm;codecs=opus', 'audio/mp4'].find((type) =>
      this.win.MediaRecorder.isTypeSupported(type),
    );
    if (mime === undefined) throw new Error('Recorder unavailable');
    return mime;
  }
  private listen(target: EventTarget, event: string, callback: () => void): void {
    target.addEventListener(event, callback);
    this.releases.push(() => {
      target.removeEventListener(event, callback);
    });
  }
  private beginRecording(mime: string): void {
    const stream = this.stream;
    if (stream === undefined) return;
    const recorder = new this.win.MediaRecorder(stream, {
      mimeType: mime,
      audioBitsPerSecond: 64000,
    });
    const item: Recording<B> = {
      recorder,
      chunks: [],
      basis: this.mode === 'manual' ? this.events.begin() : undefined,
      bytes: 0,
      startedAt: this.win.performance.now(),
      speechTicks: 0,
      quietTicks: 0,
      release: () => {
        recorder.removeEventListener('dataavailable', data);
        recorder.removeEventListener('stop', stopped);
        recorder.removeEventListener('error', failed);
      },
    };
    const data = (event: BlobEvent): void => {
      if (this.recording !== item) return;
      item.bytes += event.data.size;
      if (item.bytes > 4 * 1024 * 1024) {
        this.fail(commandMessage('Recording is too large. Try a shorter command.'));
        return;
      }
      if (event.data.size > 0) item.chunks.push(event.data);
    };
    const stopped = (): void => {
      this.recorded(item);
    };
    const failed = (): void => {
      this.fail(commandMessage('Recording failed. Try the microphone again.'));
    };
    recorder.addEventListener('dataavailable', data);
    recorder.addEventListener('stop', stopped);
    recorder.addEventListener('error', failed);
    this.recording = item;
    recorder.start(250);
  }
  private sample(samples: Float32Array<ArrayBuffer>): void {
    const item = this.recording;
    if (item?.recorder.state !== 'recording' || this.analyser === undefined) return;
    if (!item.recorder.stream.active || this.context?.state !== 'running') {
      this.fail(commandMessage('Microphone unavailable. Try the microphone again.'));
      return;
    }
    const now = this.win.performance.now();
    const age = now - item.startedAt;
    if (age >= 60000) {
      this.fail(commandMessage('Recording reached one minute. Try a shorter command.'));
      return;
    }
    this.analyser.getFloatTimeDomainData(samples);
    this.detectSpeech(item, samples, now);
    this.segmentPause(item, age);
  }
  private detectSpeech(item: Recording<B>, samples: Float32Array, now: number): void {
    let energy = 0;
    for (const value of samples) energy += value * value;
    const amplitude = Math.sqrt(energy / samples.length);
    const speaking = amplitude >= 0.012 && now >= this.ignoreSoundUntil;
    if (speaking) {
      item.basis ??= this.events.begin();
      item.speechTicks++;
      item.quietTicks = 0;
    } else item.quietTicks++;
    this.publishActivity(speaking ? samples : undefined);
  }
  private publishActivity(samples: Float32Array | undefined): void {
    if (!this.speech && samples === undefined) return;
    this.speech = samples !== undefined;
    this.events.activity?.(samples);
  }
  private segmentPause(item: Recording<B>, age: number): void {
    if (this.mode === 'manual') return;
    if (item.speechTicks >= 3 && item.quietTicks * SAMPLE_INTERVAL_MS >= END_OF_UTTERANCE_MS)
      this.endRecording(true);
    else if (item.speechTicks < 3 && age >= 5000 && item.quietTicks >= 16) this.endRecording(false);
  }
  private endRecording(complete: boolean): void {
    const item = this.recording;
    if (item?.recorder.state !== 'recording') return;
    item.ending = complete ? 'utterance' : 'rollover';
    if (complete) {
      this.releaseMedia();
      this.events.changed();
    }
    try {
      item.recorder.stop();
    } catch {
      this.fail(commandMessage('Recording could not finish. Try the microphone again.'));
    }
  }
  private recorded(item: Recording<B>): void {
    if (this.recording !== item) return;
    this.recording = undefined;
    item.release();
    const audio =
      item.ending === 'utterance' && item.speechTicks >= 3 && item.bytes > 0
        ? new this.win.Blob(item.chunks, { type: item.recorder.mimeType })
        : undefined;
    item.chunks.length = 0;
    if (item.ending === undefined) {
      this.fail(commandMessage('Recording failed. Try the microphone again.'));
      return;
    }
    if (item.ending === 'rollover') this.restart(item.recorder.mimeType);
    if (audio !== undefined && item.basis !== undefined) this.events.segment(audio, item.basis);
    else if (item.ending === 'utterance')
      this.events.failure(
        commandMessage('No clear speech captured. Try again or type your command.'),
      );
    this.events.changed();
  }
  private restart(mime: string): void {
    if (this.stream === undefined || this.mode !== 'continuous') return;
    try {
      this.beginRecording(mime);
    } catch {
      this.fail(commandMessage('Recording could not restart. Try the microphone again.'));
    }
  }
  finish(): void {
    if (!this.active()) return;
    if (this.starting) {
      this.stop();
      return;
    }
    this.endRecording(true);
  }
  private playCue(context: AudioContext, opening: boolean, ended?: () => void): void {
    try {
      const output = context.createBufferSource();
      // G4 and C5 rise when listening begins and resolve downward when it ends.
      const low = 392;
      const high = 523.251;
      output.buffer = chimeBuffer(
        context,
        [
          { start: 0, frequency: opening ? low : high, duration: 0.1, level: 0.85, decay: 0.065 },
          { start: 0.09, frequency: opening ? high : low, duration: 0.12, level: 1, decay: 0.07 },
        ],
        0.21,
        -27,
      );
      output.connect(context.destination);
      output.onended = () => {
        output.disconnect();
        ended?.();
      };
      if (opening) {
        const timing: { baseLatency?: number; outputLatency?: number } = context;
        const latency = (timing.baseLatency ?? 0) + (timing.outputLatency ?? 0);
        this.ignoreSoundUntil =
          this.win.performance.now() + (output.buffer.duration + latency + 0.08) * 1000;
      }
      output.start();
    } catch {
      // Some input devices have no usable output. Dictation still works.
      ended?.();
    }
  }
  private closeContext(context: AudioContext, withCue: boolean): void {
    const generation = this.generation;
    const close = (): void => {
      void context.close().catch(() => {
        if (!this.disposed && generation === this.generation)
          this.events.failure(
            commandMessage('Could not release voice processing. Reopen CommandMode.'),
          );
      });
    };
    if (!withCue || this.win.document.hidden) {
      close();
      return;
    }
    this.endCue = new Promise<void>((resolve) => {
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        this.win.clearTimeout(deadline);
        close();
        resolve();
      };
      const deadline = this.win.setTimeout(finish, 1000);
      this.playCue(context, false, finish);
    });
  }
  private releaseMedia(): void {
    this.cancelResume?.();
    this.cancelResume = undefined;
    this.starting = false;
    this.publishActivity(undefined);
    this.win.clearInterval(this.timer);
    this.timer = undefined;
    this.releases.splice(0).forEach((release) => {
      release();
    });
    this.source?.disconnect();
    this.source = undefined;
    this.analyser?.disconnect();
    this.analyser = undefined;
    this.stream?.getTracks().forEach((track) => {
      track.stop();
    });
    this.stream = undefined;
    const context = this.context;
    this.context = undefined;
    if (context !== undefined) this.closeContext(context, this.listening);
    this.listening = false;
  }
  private fail(message: string): void {
    this.stop();
    this.events.failure(message);
  }
  stop(): void {
    this.generation++;
    const item = this.recording;
    this.recording = undefined;
    if (item !== undefined) {
      item.release();
      item.chunks.length = 0;
      if (item.recorder.state !== 'inactive') {
        try {
          item.recorder.stop();
        } catch {
          this.events.failure(
            commandMessage('Could not finish the recorder. Audio was discarded.'),
          );
        }
      }
    }
    this.releaseMedia();
    this.events.changed();
  }
  dispose(): void {
    this.disposed = true;
    this.stop();
  }
}
