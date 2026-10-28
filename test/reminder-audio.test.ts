import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReminderAudio } from '../src/ui/timeTracking/ReminderAudio';

function hardware(blockResume = false) {
  let state: AudioContextState = 'suspended';
  const finishResumes: Array<() => void> = [];
  const sources: Array<{
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    onended: (() => void) | null;
  }> = [];
  let samples = new Float32Array();
  const context = {
    get state() {
      return state;
    },
    sampleRate: 48_000,
    destination: {},
    resume: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          const finish = () => {
            state = 'running';
            resolve();
          };
          if (blockResume) finishResumes.push(finish);
          else finish();
        }),
    ),
    suspend: vi.fn(async () => {
      state = 'suspended';
    }),
    close: vi.fn(async () => {
      state = 'closed';
    }),
    createBuffer: (_channels: number, length: number) => {
      samples = new Float32Array(length);
      return { getChannelData: () => samples };
    },
    createBufferSource: () => {
      const source = {
        buffer: null,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(() => source.onended?.()),
        onended: null as (() => void) | null,
      };
      sources.push(source);
      return source;
    },
  };
  return {
    context: context as unknown as AudioContext,
    resumeMock: context.resume,
    sources,
    samples: () => samples,
    resume: (index = 0) => finishResumes[index]?.(),
    state: () => state,
  };
}

describe('reminder audio lifecycle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resumes before playback, creates a quiet finite buffer, and suspends after it ends', async () => {
    const fake = hardware();
    const audio = new ReminderAudio(window, () => fake.context);
    const playing = audio.play();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.state()).toBe('running');
    expect(fake.sources[0]?.start).toHaveBeenCalledOnce();
    const samples = fake.samples();
    expect(samples.length).toBeGreaterThan(40_000);
    expect(samples.every((sample) => Number.isFinite(sample) && Math.abs(sample) < 0.2)).toBe(true);
    expect(samples.some((sample) => Math.abs(sample) > 0.05)).toBe(true);
    expect(samples[samples.length - 1]).toBe(0);
    fake.sources[0]?.onended?.();
    await playing;
    expect(fake.state()).toBe('suspended');
    audio.destroy();
    expect(fake.state()).toBe('closed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not play when a delayed resume completes after disposal', async () => {
    const fake = hardware(true);
    const audio = new ReminderAudio(window, () => fake.context);
    const playing = audio.play();
    audio.destroy();
    fake.resume();
    await playing;
    expect(fake.sources).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, 1])(
    'keeps playback running when a user gesture resumes it (resume %i settles first)',
    async (first) => {
      const fake = hardware(true);
      const audio = new ReminderAudio(window, () => fake.context);
      const playing = audio.play();
      const preparing = audio.prepare();
      fake.resume(first);
      await vi.advanceTimersByTimeAsync(0);
      fake.resume(1 - first);
      await vi.advanceTimersByTimeAsync(0);
      expect(fake.sources[0]?.start).toHaveBeenCalledOnce();
      expect(fake.state()).toBe('running');
      fake.sources[0]?.onended?.();
      await Promise.all([playing, preparing]);
      expect(fake.state()).toBe('suspended');
      audio.destroy();
    },
  );

  it('bounds a blocked resume instead of keeping the settings action pending', async () => {
    const fake = hardware(true);
    const audio = new ReminderAudio(window, () => fake.context);
    const failure = expect(audio.play()).rejects.toThrow('Audio playback is unavailable');
    await vi.advanceTimersByTimeAsync(1_500);
    await failure;
    expect(fake.sources).toHaveLength(0);
    expect(fake.state()).toBe('closed');
    audio.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settles playback on disposal even when the device never sends an ended event', async () => {
    const fake = hardware();
    const audio = new ReminderAudio(window, () => fake.context);
    let finished = false;
    const playing = audio.play().then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    fake.sources[0]?.stop.mockImplementation(() => {});
    audio.destroy();
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(true);
    await playing;
  });

  it('queues resume even when a running context may have an earlier suspension pending', async () => {
    const fake = hardware();
    await fake.context.resume();
    const audio = new ReminderAudio(window, () => fake.context);
    const playing = audio.play();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.resumeMock).toHaveBeenCalledTimes(2);
    fake.sources[0]?.onended?.();
    await playing;
    audio.destroy();
  });
});
