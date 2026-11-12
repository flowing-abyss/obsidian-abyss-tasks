import { afterEach, expect, it, vi } from 'vitest';
import { NativeVoiceCapture } from '../src/ai/voice/NativeVoiceCapture';
import { voiceMediaHarness } from './support/voiceMediaHarness';
const disposers: Array<() => void> = [];
afterEach(() => {
  disposers.splice(0).forEach((fn) => {
    fn();
  });
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function setup(mode: 'manual' | 'continuous' = 'manual') {
  vi.useFakeTimers();
  const media = voiceMediaHarness(window);
  const segments: Blob[] = [],
    errors: string[] = [];
  const capture = new NativeVoiceCapture(window, {
    begin: () => ({ revision: 1 }),
    segment: (audio) => {
      segments.push(audio);
    },
    changed: () => {},
    failure: (message) => {
      errors.push(message);
    },
  });
  disposers.push(() => {
    capture.dispose();
  });
  return { media, capture, segments, errors, start: () => capture.start(mode) };
}
it('manual quiet never submits and finishing silence sends no audio', async () => {
  const h = setup();
  await h.start();
  await vi.advanceTimersByTimeAsync(5000);
  expect(h.segments).toEqual([]);
  expect(h.media.tracks[0]?.stop).not.toHaveBeenCalled();
  h.capture.finish();
  expect(h.segments).toEqual([]);
  expect(h.media.tracks[0]?.stop).toHaveBeenCalledOnce();
  expect(h.errors[0]).toMatch(/speech/i);
});
it('submits one complete manual segment despite repeated finish and stop events', async () => {
  const h = setup();
  await h.start();
  h.media.level(0.1);
  await vi.advanceTimersByTimeAsync(400);
  h.media.level(0);
  await vi.advanceTimersByTimeAsync(3500);
  expect(h.segments).toHaveLength(0);
  h.capture.finish();
  h.capture.finish();
  h.media.recorders[0]?.dispatchEvent(new Event('stop'));
  expect(h.segments).toHaveLength(1);
  expect(h.media.tracks[0]?.stop).toHaveBeenCalledOnce();
});
it('rolls quiet containers locally, then releases the microphone before delivering speech', async () => {
  const h = setup('continuous');
  h.media.delayStops();
  await h.start();
  await vi.advanceTimersByTimeAsync(5100);
  h.media.completeStops();
  expect(h.media.recorders).toHaveLength(2);
  expect(h.media.cues).toHaveLength(1);
  h.media.level(0.1);
  await vi.advanceTimersByTimeAsync(400);
  h.media.level(0);
  await vi.advanceTimersByTimeAsync(3500);
  expect(h.media.tracks[0]?.readyState).toBe('ended');
  expect(h.segments).toHaveLength(0);
  h.media.completeStops();
  expect(h.segments).toHaveLength(1);
  expect(h.capture.active()).toBe(false);
  await vi.advanceTimersByTimeAsync(15000);
  expect(h.media.cues).toHaveLength(2);
  expect(h.media.recorders).toHaveLength(2);
  expect(h.media.getUserMedia).toHaveBeenCalledOnce();
});

// Count positive-going cycles in equal windows inside each note of the rendered waveform.
function pitchCycles(samples: Float32Array, start: number): number {
  const section = samples.subarray(samples.length * start, samples.length * (start + 0.22));
  return section.reduce(
    (count, sample, index) => count + Number(sample > 0 && (section[index - 1] ?? 1) <= 0),
    0,
  );
}

it.each(['manual', 'continuous'] as const)(
  'plays a quiet rising pair on %s recording start and a falling pair after releasing the track',
  async (mode) => {
    const h = setup(mode);
    await h.start();
    h.capture.stop();
    h.capture.stop();
    expect(h.media.cues.map((cue) => cue.activeTrack)).toEqual([true, false]);
    expect(h.media.cues[0]?.recording).toBe(true);
    const [start, end] = h.media.cues;
    if (start === undefined || end === undefined) throw new Error('Missing cues');
    expect(pitchCycles(start.samples, 0.62)).toBeGreaterThan(
      pitchCycles(start.samples, 0.1) * 1.15,
    );
    expect(pitchCycles(end.samples, 0.62)).toBeLessThan(pitchCycles(end.samples, 0.1) * 0.87);
    for (const cue of [start, end]) {
      expect(cue.samples.length).toBeLessThan(12000);
      expect(cue.samples.some((sample) => Math.abs(sample) > 0.01)).toBe(true);
      expect(cue.samples.every((sample) => Number.isFinite(sample) && Math.abs(sample) < 0.1)).toBe(
        true,
      );
    }
  },
);
it('finishes the output-only end cue before fast rearm can open the microphone again', async () => {
  const h = setup('continuous');
  h.media.holdCues();
  await h.start();
  h.capture.stop();
  const again = h.start();
  await Promise.resolve();
  expect(h.media.tracks[0]?.readyState).toBe('ended');
  expect(h.media.getUserMedia).toHaveBeenCalledOnce();
  expect(h.media.contexts[0]?.close).not.toHaveBeenCalled();
  h.media.endCues();
  await again;
  expect(h.media.getUserMedia).toHaveBeenCalledTimes(2);
  expect(h.media.contexts[0]?.close).toHaveBeenCalledOnce();
});
it('releases visible input immediately on disposal and bounds the remaining end cue', async () => {
  const h = setup();
  h.media.holdCues();
  await h.start();
  h.capture.dispose();
  expect(h.media.tracks[0]?.readyState).toBe('ended');
  expect(h.media.cues).toHaveLength(2);
  expect(h.media.contexts[0]?.close).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1500);
  expect(h.media.contexts[0]?.close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  h.media.endCues();
  expect(h.media.getUserMedia).toHaveBeenCalledOnce();
});
it('ignores the opening sound picked up by the microphone without dropping the next spoken command', async () => {
  const h = setup('continuous');
  await h.start();
  h.media.level(0.06);
  await vi.advanceTimersByTimeAsync(250);
  expect(h.capture.speaking()).toBe(false);
  h.media.level(0);
  await vi.advanceTimersByTimeAsync(2200);
  expect(h.segments).toHaveLength(0);
  expect(h.media.tracks[0]?.readyState).toBe('live');
  h.media.level(0.06);
  await vi.advanceTimersByTimeAsync(200);
  h.media.level(0);
  await vi.advanceTimersByTimeAsync(3500);
  expect(h.segments).toHaveLength(1);
});
it('disposes late permission results and all owning-window media resources', async () => {
  const h = setup();
  const pending = h.start();
  h.capture.dispose();
  await pending;
  expect(h.media.tracks[0]?.stop).toHaveBeenCalledOnce();
  expect(h.media.recorders).toHaveLength(0);
  expect(h.media.cues).toEqual([]);
  expect(h.segments).toEqual([]);
});
it.each(['error', 'ended', 'mute'])('discards incomplete capture on %s', async (event) => {
  const h = setup();
  await h.start();
  h.media.level(0.1);
  await vi.advanceTimersByTimeAsync(400);
  (event === 'error' ? h.media.recorders[0] : h.media.tracks[0])?.dispatchEvent(new Event(event));
  expect(h.segments).toEqual([]);
  expect(h.errors).toHaveLength(1);
  expect(h.media.tracks[0]?.stop).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it('reports denial without a recorder and permits a deliberate retry', async () => {
  const h = setup();
  h.media.getUserMedia.mockRejectedValueOnce(new DOMException('secret detail', 'NotAllowedError'));
  await h.start();
  expect(h.errors).toHaveLength(1);
  expect(h.errors[0]).not.toContain('secret');
  expect(h.media.recorders).toHaveLength(0);
  await h.start();
  expect(h.media.recorders).toHaveLength(1);
});
it('discards buffered analyser speech after the input stream becomes inactive', async () => {
  const h = setup('continuous');
  await h.start();
  h.media.level(0.1);
  await vi.advanceTimersByTimeAsync(500);
  expect(h.capture.speaking()).toBe(true);
  const track = h.media.tracks[0];
  if (track === undefined) throw new Error('Missing microphone');
  track.stop(); // Stopping a track directly does not dispatch its ended event.
  await vi.advanceTimersByTimeAsync(50);
  expect(h.capture.speaking()).toBe(false);
  expect(h.capture.state()).toBe('idle');
  expect(h.segments).toEqual([]);
  expect(h.errors).toHaveLength(1);
});
it('does not cut speech that begins just before a quiet container rollover', async () => {
  const h = setup('continuous');
  await h.start();
  await vi.advanceTimersByTimeAsync(4900);
  h.media.level(0.1);
  await vi.advanceTimersByTimeAsync(200);
  h.media.level(0);
  await vi.advanceTimersByTimeAsync(3600);
  expect(h.segments).toHaveLength(1);
  expect(h.errors).toEqual([]);
});
it('uses only the owning popout media realm and releases it on pagehide', async () => {
  const frame = document.body.createEl('iframe');
  document.body.append(frame);
  const popout = frame.contentDocument?.defaultView;
  if (popout == null) throw new Error('No iframe window');
  const main = voiceMediaHarness(window),
    child = voiceMediaHarness(popout);
  const capture = new NativeVoiceCapture(popout, {
    begin: () => 1,
    segment: () => {},
    changed: () => {},
    failure: () => {},
  });
  disposers.push(() => {
    capture.dispose();
    frame.remove();
  });
  await capture.start('continuous');
  expect(child.getUserMedia).toHaveBeenCalledOnce();
  expect(main.getUserMedia).not.toHaveBeenCalled();
  popout.dispatchEvent(new popout.Event('pagehide'));
  expect(child.tracks[0]?.stop).toHaveBeenCalledOnce();
  expect(child.contexts[0]?.close).toHaveBeenCalledOnce();
});
it('refuses unsupported recorder formats before requesting physical media', async () => {
  const h = setup();
  vi.spyOn(window.MediaRecorder, 'isTypeSupported').mockReturnValue(false);
  await h.start();
  expect(h.media.getUserMedia).not.toHaveBeenCalled();
  expect(h.errors).toHaveLength(1);
});
it('finishing while permission is pending retires the returned stream without starting it', async () => {
  const h = setup();
  const pending = h.start();
  h.capture.finish();
  await pending;
  expect(h.media.tracks[0]?.stop).toHaveBeenCalledOnce();
  expect(h.media.recorders).toHaveLength(0);
});
it('discards incomplete recordings at the time bound rather than submitting partial speech', async () => {
  const h = setup();
  await h.start();
  h.media.level(0.1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.segments).toHaveLength(0);
  expect(h.errors[0]).toMatch(/minute/);
  expect(h.media.tracks[0]?.stop).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it('discards oversized buffers and suspended media sessions', async () => {
  const h = setup();
  await h.start();
  h.media.recorders[0]?.dispatchEvent(
    new MessageEvent('dataavailable', { data: new Blob([new Uint8Array(4 * 1024 * 1024 + 1)]) }),
  );
  expect(h.segments).toEqual([]);
  expect(h.errors[0]).toMatch(/large/);
  expect(h.media.tracks[0]?.stop).toHaveBeenCalledOnce();
  await h.start();
  const context = h.media.contexts[1];
  if (context === undefined) throw new Error('No context');
  context.state = 'suspended';
  context.dispatchEvent(new Event('statechange'));
  expect(h.segments).toEqual([]);
  expect(h.media.tracks[1]?.stop).toHaveBeenCalledOnce();
});
it('contains a failing local sample and releases the media session', async () => {
  const h = setup();
  await h.start();
  const analyser = h.media.analysers[0];
  if (analyser === undefined) throw new Error('No analyser');
  vi.spyOn(analyser, 'getFloatTimeDomainData').mockImplementation(() => {
    throw new Error('native sampler failed');
  });
  expect(() => vi.advanceTimersByTime(50)).not.toThrow();
  expect(h.errors).toHaveLength(1);
  expect(h.segments).toEqual([]);
  expect(h.media.tracks[0]?.stop).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it('enforces recording age on the first sample after a stalled owning-window clock', async () => {
  const h = setup();
  const now = vi.spyOn(window.performance, 'now').mockReturnValue(1000);
  await h.start();
  h.media.level(0.1);
  now.mockReturnValue(61500);
  await vi.advanceTimersByTimeAsync(50);
  expect(h.errors[0]).toMatch(/minute/);
  expect(h.segments).toEqual([]);
  expect(h.media.tracks[0]?.stop).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it('uses elapsed quiet-container age without counting a stalled interval as observed speech', async () => {
  const h = setup('continuous');
  const now = vi.spyOn(window.performance, 'now').mockReturnValue(0);
  await h.start();
  h.media.level(0.1);
  await vi.advanceTimersByTimeAsync(50);
  h.media.level(0);
  await vi.advanceTimersByTimeAsync(800);
  now.mockReturnValue(5100);
  await vi.advanceTimersByTimeAsync(50);
  expect(h.media.recorders).toHaveLength(2);
  expect(h.segments).toEqual([]);
  expect(h.errors).toEqual([]);
  expect(h.media.getUserMedia).toHaveBeenCalledOnce();
});

it('bounds suspended startup, releases media and rejects late resume', async () => {
  const h = setup();
  let resume!: () => void;
  h.media.resume(
    () =>
      new Promise<void>((resolve) => {
        resume = resolve;
      }),
  );
  const pending = h.start();
  await Promise.resolve();
  expect(h.capture.state()).toBe('starting');
  await vi.advanceTimersByTimeAsync(1500);
  await pending;
  expect(h.capture.state()).toBe('idle');
  expect(h.errors[0]).toMatch(/start|microphone/i);
  expect(h.media.tracks[0]?.stop).toHaveBeenCalledOnce();
  expect(h.media.contexts[0]?.close).toHaveBeenCalledOnce();
  resume();
  await Promise.resolve();
  expect(h.media.recorders).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
});
it('publishes the current analyser samples only during speech and clears activity once on release', async () => {
  vi.useFakeTimers();
  const media = voiceMediaHarness(window);
  const frames: Array<number | undefined> = [];
  const changed = vi.fn();
  const capture = new NativeVoiceCapture(window, {
    begin: () => 1,
    segment: () => {},
    changed,
    failure: () => {},
    activity: (samples) => frames.push(samples?.[0]),
  });
  disposers.push(() => {
    capture.dispose();
  });
  await capture.start('continuous');
  changed.mockClear();
  media.level(0.1);
  await vi.advanceTimersByTimeAsync(250);
  expect(frames).toEqual([]);
  media.level(0.02);
  await vi.advanceTimersByTimeAsync(100);
  expect(frames).toHaveLength(2);
  expect(frames[0]).toBeCloseTo(0.02);
  media.level(0.1);
  await vi.advanceTimersByTimeAsync(100);
  expect(frames[frames.length - 1]).toBeCloseTo(0.1);
  expect(changed).not.toHaveBeenCalled();
  capture.stop();
  expect(frames[frames.length - 1]).toBeUndefined();
  const count = frames.length;
  await vi.advanceTimersByTimeAsync(1000);
  expect(frames).toHaveLength(count);
});
it('accepts delayed final recorder events exactly once and discards retired containers', async () => {
  const h = setup();
  h.media.delayStops();
  await h.start();
  await vi.advanceTimersByTimeAsync(250);
  h.media.level(0.1);
  await vi.advanceTimersByTimeAsync(200);
  h.capture.finish();
  h.capture.finish();
  expect(h.segments).toHaveLength(0);
  h.media.completeStops();
  expect(h.segments).toHaveLength(1);
  await h.start();
  await vi.advanceTimersByTimeAsync(200);
  h.capture.finish();
  h.capture.dispose();
  h.media.completeStops();
  expect(h.segments).toHaveLength(1);
});

it('disposal during resume clears its deadline immediately and allows startup to settle', async () => {
  const h = setup();
  h.media.resume(() => new Promise<void>(() => {}));
  const pending = h.start();
  await Promise.resolve();
  h.capture.dispose();
  expect(vi.getTimerCount()).toBe(0);
  await pending;
  expect(h.media.contexts[0]?.close).toHaveBeenCalledOnce();
  expect(h.errors).toEqual([]);
});

it('restarts continuous capture after delayed silent rollover and discards a late stopped segment', async () => {
  const h = setup('continuous');
  h.media.delayStops();
  await h.start();
  await vi.advanceTimersByTimeAsync(5200);
  expect(h.media.recorders).toHaveLength(1);
  h.media.completeStops();
  expect(h.media.recorders).toHaveLength(2);
  h.media.level(0.1);
  await vi.advanceTimersByTimeAsync(200);
  h.media.level(0);
  await vi.advanceTimersByTimeAsync(3600);
  h.capture.stop();
  h.media.completeStops();
  expect(h.segments).toEqual([]);
  expect(h.media.recorders).toHaveLength(2);
  expect(h.media.tracks[0]?.stop).toHaveBeenCalledOnce();
});

it.each([1000, 2000, 3000])(
  'a %i ms thought pause stays in the same continuous utterance',
  async (pause) => {
    const h = setup('continuous');
    await h.start();
    await vi.advanceTimersByTimeAsync(300);
    h.media.level(0.1);
    await vi.advanceTimersByTimeAsync(200);
    h.media.level(0);
    await vi.advanceTimersByTimeAsync(pause);
    expect(h.segments).toHaveLength(0);
    h.media.level(0.1);
    await vi.advanceTimersByTimeAsync(200);
    h.media.level(0);
    await vi.advanceTimersByTimeAsync(3050);
    expect(h.segments).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(h.segments).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10000);
    expect(h.segments).toHaveLength(1);
    expect(h.errors).toEqual([]);
  },
);
