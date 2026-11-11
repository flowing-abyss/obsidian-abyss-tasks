import { onTestFinished, vi } from 'vitest';

/** Only unavailable physical media/WebAudio boundaries are replaced. */
export function voiceMediaHarness(win: Window & typeof window) {
  let level = 0;
  let frame: Float32Array | undefined;
  let resume: (() => Promise<void>) | undefined;
  let delayed = false;
  let holdCues = false;
  const cueEnds: Array<() => void> = [];
  const completions: Array<() => void> = [];
  const tracks: Array<EventTarget & { stop: () => void; readyState: string }> = [];
  const contexts: AudioContextDouble[] = [];
  const recorders: RecorderDouble[] = [];
  const cues: Array<{ samples: Float32Array; activeTrack: boolean; recording: boolean }> = [];
  const blobs: Blob[] = [];
  const analysers: Array<{
    fftSize: number;
    disconnect: () => void;
    getFloatTimeDomainData(data: Float32Array): void;
  }> = [];
  class AudioContextDouble extends win.EventTarget {
    state = 'running';
    sampleRate = 48000;
    destination = {};
    createBuffer(_channels: number, length: number) {
      const samples = new Float32Array(length);
      return { duration: length / this.sampleRate, getChannelData: () => samples };
    }
    createBufferSource() {
      const source = {
        buffer: null as { getChannelData(): Float32Array } | null,
        connect: vi.fn(),
        disconnect: vi.fn(),
        onended: null as (() => void) | null,
        start: () => {
          if (source.buffer === null) throw new Error('Empty cue');
          cues.push({
            samples: source.buffer.getChannelData(),
            activeTrack: tracks.some((track) => track.readyState === 'live'),
            recording: recorders.some((recorder) => recorder.state === 'recording'),
          });
          if (holdCues)
            cueEnds.push(() => {
              source.onended?.();
            });
          else source.onended?.();
        },
      };
      return source;
    }
    constructor() {
      super();
      contexts.push(this);
    }
    resume = vi.fn(async () => {
      await resume?.();
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
          if (frame === undefined) data.fill(level);
          else data.set(frame);
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
      const complete = () => {
        const data = new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4])], {
          type: this.mimeType,
        });
        blobs.push(data);
        this.dispatchEvent(new win.MessageEvent('dataavailable', { data }));
        this.dispatchEvent(new win.Event('stop'));
      };
      if (delayed) completions.push(complete);
      else complete();
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
    const track = Object.assign(new win.EventTarget(), {
      stop: vi.fn(() => {
        track.readyState = 'ended';
      }),
      readyState: 'live',
    });
    tracks.push(track);
    return {
      get active() {
        return track.readyState === 'live';
      },
      getTracks: () => [track],
    } as unknown as MediaStream;
  });
  replace(win.navigator, 'mediaDevices', { getUserMedia });
  return {
    resume: (work: () => Promise<void>) => {
      resume = work;
    },
    holdCues: () => {
      holdCues = true;
    },
    endCues: () => {
      cueEnds.splice(0).forEach((end) => {
        end();
      });
    },
    delayStops: () => {
      delayed = true;
    },
    completeStops: () => {
      completions.splice(0).forEach((complete) => {
        complete();
      });
    },
    cues,
    tracks,
    contexts,
    analysers,
    recorders,
    blobs,
    getUserMedia,
    frame: (samples: Float32Array) => {
      frame = samples;
    },
    level: (value: number) => {
      frame = undefined;
      level = value;
    },
  };
}
