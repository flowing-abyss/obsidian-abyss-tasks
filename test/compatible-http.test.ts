// @vitest-environment node
import { Platform } from 'obsidian';
import { afterEach, expect, it, vi } from 'vitest';
import { desktopCompatibleRequest } from '../src/ai/providers/compatibleHttp';
import { NativeProviderTransport } from '../src/ai/providers/NativeProviderTransport';
import { expectDefined } from './helpers';

function httpFixture(status: number, headers: Record<string, string>, chunks: Uint8Array[]) {
  if (!Platform.isDesktop) throw new Error('Desktop HTTP test required');
  vi.stubGlobal('window', { process });
  const http = process.getBuiltinModule('http');
  const { Socket } = process.getBuiltinModule('net');
  const { PassThrough } = process.getBuiltinModule('stream');
  const response = new http.IncomingMessage(new Socket());
  response.statusCode = status;
  response.headers = headers;
  for (const chunk of chunks) response.push(chunk);
  response.push(null);
  const physical = vi.spyOn(http, 'request').mockImplementation((...args) => {
    const cb = args[args.length - 1];
    if (typeof cb !== 'function') throw new Error('Missing response handler');
    cb(response);
    return new PassThrough() as unknown as ReturnType<typeof http.request>;
  });
  const send = expectDefined(desktopCompatibleRequest());
  return {
    physical,
    response,
    send: () =>
      send(
        {
          url: 'http://localhost:9331/v1/chat/completions',
          method: 'POST',
          body: '{}',
          headers: { Authorization: 'Bearer bound-key' },
        },
        new AbortController().signal,
      ),
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('rejects a redirect without accepting the body or contacting its location', async () => {
  const h = httpFixture(307, { location: 'http://localhost:9111/unrelated' }, []);
  await expect(h.send()).rejects.toMatchObject({ code: 'invalid-response' });
  expect(h.response.destroyed).toBe(true);
  expect(h.physical).toHaveBeenCalledTimes(1);
  expect(h.physical.mock.calls[0]?.[0]).toBe('http://localhost:9331/v1/chat/completions');
});
it('requests an identity-encoded response and rejects an unexpected encoding before reading', async () => {
  const h = httpFixture(200, { 'content-encoding': 'gzip' }, [new Uint8Array([31, 139])]);
  await expect(h.send()).rejects.toMatchObject({ code: 'invalid-response' });
  expect(h.physical.mock.calls[0]?.[1]).toMatchObject({
    headers: { 'Accept-Encoding': 'identity' },
  });
  expect(h.response.destroyed).toBe(true);
});
it('gives each candidate address time to connect while keeping the request cancellable', async () => {
  const h = httpFixture(200, {}, []);
  await h.send();
  const options = h.physical.mock.calls[0]?.[1];
  expect(options).toHaveProperty('autoSelectFamilyAttemptTimeout', 1500);
  expect(options).toHaveProperty('signal', expect.any(AbortSignal));
});
it('rejects oversized declared and streaming response bodies before accepting their data', async () => {
  const declared = httpFixture(200, { 'content-length': '8388609' }, []);
  await expect(declared.send()).rejects.toMatchObject({ code: 'too-large' });
  declared.physical.mockRestore();
  const chunked = httpFixture(200, {}, [new Uint8Array(8 * 1024 * 1024), new Uint8Array(1)]);
  await expect(chunked.send()).rejects.toMatchObject({ code: 'too-large' });
  expect(chunked.response.destroyed).toBe(true);
});
it('preserves valid bytes and HTTP status in the no-redirect native request', async () => {
  const h = httpFixture(429, { 'retry-after': '7' }, [
    new Uint8Array([0x7b]),
    new Uint8Array([0x7d]),
  ]);
  const result = await h.send();
  expect(result).toMatchObject({ headers: { 'retry-after': '7' }, status: 429 });
  expect([...new Uint8Array(result.arrayBuffer)]).toEqual([0x7b, 0x7d]);
});
it('aborts physical compatible work on timeout and does not dispatch a retired queued call', async () => {
  const pending: AbortSignal[] = [];
  const timers: Array<() => void> = [];
  const transport = new NativeProviderTransport(
    async () => {
      throw new Error('Unexpected fallback');
    },
    (fn) => {
      timers.push(fn);
      return () => undefined;
    },
    (_, signal) =>
      new Promise((_, reject) => {
        pending.push(signal);
        signal.addEventListener(
          'abort',
          () => {
            reject(new Error('Physical request aborted'));
          },
          { once: true },
        );
      }),
  );
  const fetch = transport.compatibleFetch('agent', {
    baseURL: 'http://localhost/v1',
    model: 'local',
  });
  const request = (signal?: AbortSignal) =>
    fetch('http://localhost/v1/chat/completions', {
      method: 'POST',
      body: '{"model":"local","messages":[]}',
      ...(signal === undefined ? {} : { signal }),
    });
  const a = request(),
    b = request(),
    queued = new AbortController();
  const c = request(queued.signal);
  const ends = [
    expect(a).rejects.toMatchObject({ code: 'timeout' }),
    expect(b).rejects.toMatchObject({ code: 'cancelled' }),
    expect(c).rejects.toMatchObject({ code: 'cancelled' }),
  ];
  queued.abort();
  expectDefined(timers[0])();
  transport.dispose();
  await Promise.all(ends);
  expect(pending.map((signal) => signal.aborted)).toEqual([true, true]);
});
it('makes custom connections unavailable on mobile before dispatch while official transport remains usable', () => {
  vi.spyOn(Platform, 'isDesktop', 'get').mockReturnValue(false);
  expect(desktopCompatibleRequest()).toBeUndefined();
  const transport = new NativeProviderTransport(
    async () => {
      throw new Error('Unexpected request');
    },
    () => () => undefined,
  );
  expect(() =>
    transport.compatibleFetch('voice', { baseURL: 'http://localhost/v1', model: 'local' }),
  ).toThrow(expect.objectContaining({ code: 'compatible-unavailable' }));
  expect(typeof transport.fetchFor('openai')).toBe('function');
});
