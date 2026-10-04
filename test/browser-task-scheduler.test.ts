import { expect, it, vi } from 'vitest';
import {
  BrowserTaskCancelled,
  BrowserTaskScheduleError,
  createBrowserTaskScheduler,
} from '../src/browserTaskScheduler';
function owner(
  options: { failure?: 'construct' | 'post' | 'handler' | 'cleanup'; channel?: boolean } = {},
) {
  let deliver: (() => void) | undefined;
  const close1 = vi.fn(() => {
    if (options.failure === 'cleanup') throw new Error('SECRET cleanup');
  });
  const close2 = vi.fn();
  const post = vi.fn(() => {
    if (options.failure === 'post') throw new Error('SECRET post');
  });
  const clear = vi.fn();
  const timer = vi.fn((callback: () => void) => {
    deliver = callback;
    return 123;
  });
  const fake = {
    performance: { now: () => 42 },
    setTimeout: timer,
    clearTimeout: clear,
    MessageChannel:
      options.channel === false
        ? undefined
        : class {
            port1 = {
              close: close1,
              set onmessage(value: (() => void) | null) {
                if (value !== null) {
                  if (options.failure === 'handler') throw new Error('SECRET handler');
                  deliver = value;
                }
              },
            };
            port2 = { close: close2, postMessage: post };
            constructor() {
              if (options.failure === 'construct') throw new Error('SECRET constructor');
            }
          },
  } as unknown as Window;
  return { fake, close1, close2, post, timer, clear, deliver: () => deliver?.() };
}
it.each([true, false])(
  'yields through the captured owner, closes resources and ignores late delivery (channel=%s)',
  async (channel) => {
    const h = owner({ channel });
    const scheduler = createBrowserTaskScheduler(h.fake);
    expect(h.post).not.toHaveBeenCalled();
    const controller = new AbortController();
    const pending = scheduler.yield(controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(BrowserTaskCancelled);
    h.deliver();
    if (channel) {
      expect(h.close1).toHaveBeenCalledTimes(1);
      expect(h.close2).toHaveBeenCalledTimes(1);
    } else expect(h.clear).toHaveBeenCalledWith(123);
  },
);
it.each(['construct', 'post', 'handler', 'cleanup'] as const)(
  'settles safe %s failure and attempts every acquired cleanup',
  async (failure) => {
    const h = owner({ failure });
    const pending = createBrowserTaskScheduler(h.fake).yield(new AbortController().signal);
    if (failure === 'cleanup') h.deliver();
    await expect(pending).rejects.toBeInstanceOf(BrowserTaskScheduleError);
    await pending.catch((error: Error) => {
      expect(JSON.stringify(error)).not.toContain('SECRET');
    });
    if (failure !== 'construct') expect(h.close2).toHaveBeenCalledTimes(1);
  },
);
it('uses owner timers for delay and rejects failed fallback enqueue', async () => {
  const h = owner({ channel: false });
  const scheduler = createBrowserTaskScheduler(h.fake);
  const pending = scheduler.delay(12, new AbortController().signal);
  expect(h.timer).toHaveBeenCalledWith(expect.any(Function), 12);
  h.deliver();
  await pending;
  h.timer.mockImplementation(() => {
    throw new Error('SECRET timer');
  });
  await expect(scheduler.yield(new AbortController().signal)).rejects.toBeInstanceOf(
    BrowserTaskScheduleError,
  );
});
it('allocates nothing for an already aborted signal and does not affect another owner', async () => {
  const a = owner(),
    b = owner();
  const signal = AbortSignal.abort();
  await expect(createBrowserTaskScheduler(a.fake).yield(signal)).rejects.toBeInstanceOf(
    BrowserTaskCancelled,
  );
  expect(a.post).not.toHaveBeenCalled();
  const pending = createBrowserTaskScheduler(b.fake).yield(new AbortController().signal);
  b.deliver();
  await pending;
});
