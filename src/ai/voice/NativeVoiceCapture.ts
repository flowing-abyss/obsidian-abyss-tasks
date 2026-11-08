export interface VoiceCaptureEvents<B> {
  begin(): B;
  segment(audio: Blob, basis: B): void;
  changed(): void;
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
  complete: boolean;
}
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
  setMode(mode: 'manual' | 'continuous'): void {
    this.mode = mode;
    this.events.changed();
  }
  async start(mode: 'manual' | 'continuous'): Promise<void> {
    if (this.disposed || this.active()) return;
    const generation = ++this.generation;
    this.mode = mode;
    this.starting = true;
    this.events.changed();
    try {
      const mime = this.supportedMime();
      const stream = await this.win.navigator.mediaDevices.getUserMedia({ audio: true });
      if (generation !== this.generation) {
        stream.getTracks().forEach((track) => {
          track.stop();
        });
        return;
      }
      this.stream = stream;
      this.starting = false;
      this.context = new this.win.AudioContext();
      await this.context.resume();
      if (generation !== this.generation) return;
      this.source = this.context.createMediaStreamSource(stream);
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 2048;
      this.source.connect(this.analyser);
      for (const track of stream.getTracks())
        for (const event of ['ended', 'mute'])
          this.listen(track, event, () => {
            this.fail('Microphone unavailable. Try the microphone again.');
          });
      this.listen(this.context, 'statechange', () => {
        if (this.context?.state !== 'running')
          this.fail('Voice input paused. Try the microphone again.');
      });
      this.listen(this.win, 'pagehide', () => {
        this.stop();
      });
      this.listen(this.win.document, 'visibilitychange', () => {
        if (this.win.document.hidden) this.stop();
      });
      this.beginRecording(mime);
      const samples = new Float32Array(2048);
      this.timer = this.win.setInterval(() => {
        try {
          this.sample(samples);
        } catch {
          this.fail('Voice processing failed. Try the microphone again.');
        }
      }, 50);
      this.events.changed();
    } catch {
      if (generation === this.generation)
        this.fail('Could not use the microphone. Check permission and try again.');
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
      complete: false,
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
        this.fail('Recording is too large. Try a shorter command.');
        return;
      }
      if (event.data.size > 0) item.chunks.push(event.data);
    };
    const stopped = (): void => {
      this.recorded(item);
    };
    const failed = (): void => {
      this.fail('Recording failed. Try the microphone again.');
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
    this.analyser.getFloatTimeDomainData(samples);
    let energy = 0;
    for (const value of samples) energy += value * value;
    const age = this.win.performance.now() - item.startedAt;
    if (Math.sqrt(energy / samples.length) >= 0.012) {
      item.basis ??= this.events.begin();
      item.speechTicks++;
      item.quietTicks = 0;
    } else item.quietTicks++;
    if (age >= 60000) {
      this.fail('Recording reached one minute. Try a shorter command.');
      return;
    }
    this.segmentPause(item, age);
  }
  private segmentPause(item: Recording<B>, age: number): void {
    if (this.mode === 'manual') return;
    if (item.speechTicks >= 3 && item.quietTicks >= 16) this.endRecording(true);
    else if (item.speechTicks < 3 && age >= 5000 && item.quietTicks >= 16) this.endRecording(false);
  }
  private endRecording(complete: boolean): void {
    const item = this.recording;
    if (item?.recorder.state !== 'recording') return;
    item.complete = complete;
    try {
      item.recorder.stop();
    } catch {
      this.fail('Recording could not finish. Try the microphone again.');
    }
  }
  private recorded(item: Recording<B>): void {
    if (this.recording !== item) return;
    this.recording = undefined;
    item.release();
    const audio =
      item.complete && item.speechTicks >= 3 && item.bytes > 0
        ? new this.win.Blob(item.chunks, { type: item.recorder.mimeType })
        : undefined;
    item.chunks.length = 0;
    this.restart(item.recorder.mimeType);
    if (audio !== undefined && item.basis !== undefined) this.events.segment(audio, item.basis);
    else if (item.complete)
      this.events.failure('No clear speech captured. Try again or type your command.');
    this.events.changed();
  }
  private restart(mime: string): void {
    if (this.stream === undefined || this.mode !== 'continuous') return;
    try {
      this.beginRecording(mime);
    } catch {
      this.fail('Recording could not restart. Try the microphone again.');
    }
  }
  finish(): void {
    if (!this.active()) return;
    if (this.starting) {
      this.stop();
      return;
    }
    this.releaseMedia();
    this.endRecording(true);
    this.events.changed();
  }
  private releaseMedia(): void {
    this.starting = false;
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
    if (context !== undefined)
      void context.close().catch(() => {
        this.events.failure('Could not release voice processing. Reopen CommandMode.');
      });
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
          this.events.failure('Could not finish the recorder. Audio was discarded.');
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
