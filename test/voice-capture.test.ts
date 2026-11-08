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
  await vi.advanceTimersByTimeAsync(2000);
  expect(h.segments).toHaveLength(0);
  h.capture.finish();
  h.capture.finish();
  h.media.recorders[0]?.dispatchEvent(new Event('stop'));
  expect(h.segments).toHaveLength(1);
  expect(h.media.tracks[0]?.stop).toHaveBeenCalledOnce();
});
it('continuous silence stays local then accepts the next utterance on the same stream', async () => {
  const h = setup('continuous');
  await h.start();
  await vi.advanceTimersByTimeAsync(15000);
  expect(h.segments).toHaveLength(0);
  h.media.level(0.1);
  await vi.advanceTimersByTimeAsync(400);
  h.media.level(0);
  await vi.advanceTimersByTimeAsync(1200);
  expect(h.segments).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(15000);
  expect(h.segments).toHaveLength(1);
  h.media.level(0.1);
  await vi.advanceTimersByTimeAsync(400);
  h.media.level(0);
  await vi.advanceTimersByTimeAsync(1200);
  expect(h.segments).toHaveLength(2);
  expect(h.media.getUserMedia).toHaveBeenCalledOnce();
  expect(h.media.tracks[0]?.stop).not.toHaveBeenCalled();
  h.capture.dispose();
  expect(h.media.tracks[0]?.stop).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it('disposes late permission results and all owning-window media resources', async () => {
  const h = setup();
  const pending = h.start();
  h.capture.dispose();
  await pending;
  expect(h.media.tracks[0]?.stop).toHaveBeenCalledOnce();
  expect(h.media.recorders).toHaveLength(0);
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
it('does not cut speech that begins just before a quiet container rollover', async () => {
  const h = setup('continuous');
  await h.start();
  await vi.advanceTimersByTimeAsync(4900);
  h.media.level(0.1);
  await vi.advanceTimersByTimeAsync(200);
  h.media.level(0);
  await vi.advanceTimersByTimeAsync(900);
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
