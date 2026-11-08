import { onTestFinished, vi } from 'vitest';

/** Only unavailable physical media/WebAudio boundaries are replaced. */
export function voiceMediaHarness(win: Window & typeof window) {
  let level = 0;
  const tracks: Array<EventTarget & { stop: ReturnType<typeof vi.fn>; readyState: string }> = [];
  const contexts: AudioContextDouble[] = [];
  const recorders: RecorderDouble[] = [];
  const blobs: Blob[] = [];
  const analysers: Array<{
    fftSize: number;
    disconnect: () => void;
    getFloatTimeDomainData(data: Float32Array): void;
  }> = [];
  class AudioContextDouble extends win.EventTarget {
    state = 'running';
    constructor() {
      super();
      contexts.push(this);
    }
    resume = vi.fn(async () => {
      this.state = 'running';
    });
    close = vi.fn(async () => {
      this.state = 'closed';
    });
    createMediaStreamSource() {
      return { connect: vi.fn(), disconnect: vi.fn() };
    }
    createAnalyser() {
      const analyser = {
        fftSize: 2048,
        disconnect: vi.fn(),
        getFloatTimeDomainData: (data: Float32Array): void => {
          data.fill(level);
        },
      };
      analysers.push(analyser);
      return analyser;
    }
  }
  class RecorderDouble extends win.EventTarget {
    static isTypeSupported(type: string) {
      return type === 'audio/webm;codecs=opus';
    }
    state = 'inactive';
    mimeType = 'audio/webm;codecs=opus';
    constructor(
      readonly stream: MediaStream,
      readonly options: MediaRecorderOptions,
    ) {
      super();
      recorders.push(this);
    }
    start() {
      this.state = 'recording';
    }
    stop() {
      if (this.state === 'inactive') throw new Error('Stopped twice');
      this.state = 'inactive';
      const data = new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4])], {
        type: this.mimeType,
      });
      blobs.push(data);
      this.dispatchEvent(new win.MessageEvent('dataavailable', { data }));
      this.dispatchEvent(new win.Event('stop'));
    }
  }
  const replace = (target: object, key: string, value: unknown): void => {
    const original = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, value });
    onTestFinished(() => {
      if (original === undefined) Reflect.deleteProperty(target, key);
      else Object.defineProperty(target, key, original);
    });
  };
  replace(win, 'MediaRecorder', RecorderDouble);
  replace(win, 'AudioContext', AudioContextDouble);
  const getUserMedia = vi.fn(async () => {
    const track = Object.assign(new win.EventTarget(), { stop: vi.fn(), readyState: 'live' });
    tracks.push(track);
    return { getTracks: () => [track] } as unknown as MediaStream;
  });
  replace(win.navigator, 'mediaDevices', { getUserMedia });
  return {
    tracks,
    contexts,
    analysers,
    recorders,
    blobs,
    getUserMedia,
    level: (value: number) => {
      level = value;
    },
  };
}
