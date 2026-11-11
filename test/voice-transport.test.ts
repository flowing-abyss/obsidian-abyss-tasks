// @vitest-environment node
import { createGroq } from '@ai-sdk/groq';
import { createOpenAI } from '@ai-sdk/openai';
import { transcribe } from 'ai';
import type { RequestUrlParam, RequestUrlResponse } from 'obsidian';
import { Platform } from 'obsidian';
import { expect, it, vi } from 'vitest';
import { NativeProviderTransport } from '../src/ai/providers/NativeProviderTransport';
import { expectDefined } from './helpers';
async function desktopTimers() {
  if (Platform.isDesktop) return import('node:timers');
  throw new Error('Desktop test runtime required');
}
const { setTimeout, clearTimeout } = await desktopTimers();
it.each([
  { provider: 'disabled' },
  { provider: 'unsupported', model: '' },
  { provider: 'openai', model: '', search: 'unsupported' },
  {},
])(
  'sends only transcription to the selected Voice connection with LLM settings %j',
  async (agent) => {
    const { ProviderConnections } = await import('../src/ai/providers/ProviderConnections');
    const { ProviderSecrets } = await import('../src/ai/providers/ProviderSecrets');
    const { ProviderTranscription } = await import('../src/ai/voice/ProviderTranscription');
    const settings = {
      ...agent,
      voice: 'openai',
      voiceInputMode: 'continuous',
      secrets: { openai: null, voice: { openai: 'speech-key' } },
    };
    const secrets = new ProviderSecrets(
      {
        getSecret: (id) => (id === 'speech-key' ? 'synthetic-speech' : null),
        setSecret: () => {},
      },
      () => settings.secrets,
    );
    const requests: RequestUrlParam[] = [];
    const transport = transportFixture(async (request) => {
      requests.push(request);
      return reply('{"text":"Speak one task"}');
    });
    try {
      expect(new ProviderConnections(secrets, transport).availability(settings)).toEqual({
        agent: false,
        voice: true,
      });
      const speech = new ProviderTranscription(secrets, transport, () => settings);
      speech.available();
      expect(requests).toEqual([]);
      const audio = new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4])]);
      await expect(speech.transcribe(audio, new AbortController().signal)).resolves.toBe(
        'Speak one task',
      );
      expect(requests.map((request) => request.url)).toEqual([
        'https://api.openai.com/v1/audio/transcriptions',
      ]);
      expect(new Headers(requests[0]?.headers).get('authorization')).toBe(
        'Bearer synthetic-speech',
      );
    } finally {
      transport.dispose();
    }
  },
);
it('sends the selected Groq transcription model through its own endpoint and credential', async () => {
  const requests: RequestUrlParam[] = [];
  const transport = transportFixture(async (request) => {
    requests.push(request);
    return reply('{"text":"Next task","x_groq":{"id":"test"}}');
  });
  const result = await transcribe({
    model: createGroq({
      apiKey: 'synthetic-groq',
      fetch: transport.fetchFor('groq'),
    }).transcription('whisper-large-v3-turbo'),
    audio: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]),
    maxRetries: 0,
  });
  expect(result.text).toBe('Next task');
  const request = expectDefined(requests[0]);
  expect(request.url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
  const form = await new Response(request.body, { headers: request.headers ?? {} }).formData();
  expect(form.get('model')).toBe('whisper-large-v3-turbo');
  transport.dispose();
});
function transportFixture(request: ConstructorParameters<typeof NativeProviderTransport>[0]) {
  return new NativeProviderTransport(request, (callback, ms) => {
    const timer = setTimeout(callback, ms);
    return () => {
      clearTimeout(timer);
    };
  });
}
function reply(text = '{}', status = 200): RequestUrlResponse {
  return {
    status,
    headers: {},
    text,
    arrayBuffer: new TextEncoder().encode(text).buffer,
    json: undefined,
  };
}
it('serializes the pinned transcription SDK multipart with its exact file bytes and boundary', async () => {
  const requests: RequestUrlParam[] = [];
  const transport = transportFixture(async (request) => {
    requests.push(request);
    return reply('{"text":"Keep this command"}');
  });
  const result = await transcribe({
    model: createOpenAI({ apiKey: 'synthetic', fetch: transport.fetchFor('openai') }).transcription(
      'gpt-transcribe',
    ),
    audio: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]),
    maxRetries: 0,
  });
  expect(result.text).toBe('Keep this command');
  expect(requests).toHaveLength(1);
  const request = expectDefined(requests[0]);
  expect(request.url).toBe('https://api.openai.com/v1/audio/transcriptions');
  expect(request.method).toBe('POST');
  expect(request.body).toBeInstanceOf(ArrayBuffer);
  const body = await new Response(request.body, { headers: request.headers ?? {} }).formData();
  expect(body.get('model')).toBe('gpt-transcribe');
  const file = body.get('file') as File;
  expect(file.name).toBe('audio.webm');
  expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([
    0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4,
  ]);
  transport.dispose();
});

it('rejects multipart outside the exact transcription endpoint and before oversized audio dispatch', async () => {
  const native = vi.fn(async () => reply());
  const transport = transportFixture(native);
  const body = new FormData();
  body.set('model', 'gpt-transcribe');
  body.set('file', new Blob([new Uint8Array(4 * 1024 * 1024 + 1)]), 'audio.webm');
  await expect(
    transport.fetchFor('openai')('https://api.openai.com/v1/audio/transcriptions', { body }),
  ).rejects.toMatchObject({ code: 'too-large' });
  await expect(
    transport.fetchFor('openai')('https://api.openai.com/v1/responses', { body }),
  ).rejects.toMatchObject({ code: 'invalid-request' });
  await expect(
    transport.fetchFor('openai')('https://api.openai.com/v1/audio/transcriptions?x=1', { body }),
  ).rejects.toMatchObject({ code: 'invalid-request' });
  expect(native).not.toHaveBeenCalled();
  transport.dispose();
});
it('does not dispatch audio when cancellation wins multipart serialization', async () => {
  const native = vi.fn(async () => reply());
  const transport = transportFixture(native);
  const body = new FormData();
  body.set('model', 'gpt-transcribe');
  body.set('file', new Blob(['synthetic']), 'audio.webm');
  const controller = new AbortController();
  const request = transport.fetchFor('openai')('https://api.openai.com/v1/audio/transcriptions', {
    body,
    signal: controller.signal,
  });
  controller.abort();
  await expect(request).rejects.toMatchObject({ code: 'cancelled' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(native).not.toHaveBeenCalled();
  transport.dispose();
});
it('keeps transcription errors credential-safe and rereads voice configuration for deliberate retries', async () => {
  const { ProviderTranscription } = await import('../src/ai/voice/ProviderTranscription');
  const { ProviderSecrets } = await import('../src/ai/providers/ProviderSecrets');
  const values = new Map<string, string>();
  const secrets = new ProviderSecrets({
    getSecret: (key) => values.get(key) ?? null,
    setSecret: (key, value) => {
      values.set(key, value);
    },
  });
  const native = vi.fn(async () => reply('{"text":"Next command"}'));
  const transport = transportFixture(native);
  let settings: unknown = {};
  const provider = new ProviderTranscription(secrets, transport, () => settings);
  const audio = new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4])]);
  const signal = new AbortController().signal;
  await expect(provider.transcribe(audio, signal)).rejects.toThrow(/voice/i);
  expect(native).not.toHaveBeenCalled();
  settings = { voice: 'openai' };
  secrets.store('openai', 'synthetic-secret');
  native.mockRejectedValueOnce(new Error('synthetic-secret'));
  await expect(provider.transcribe(audio, signal)).rejects.toThrow(/connection/i);
  expect(native).toHaveBeenCalledTimes(1);
  expect(await provider.transcribe(audio, signal)).toBe('Next command');
  expect(native).toHaveBeenCalledTimes(2);
  transport.dispose();
});

it('bounds real SDK transient transcription retries to one segment and permits an explicit new attempt', async () => {
  const { ProviderTranscription } = await import('../src/ai/voice/ProviderTranscription');
  const { ProviderSecrets } = await import('../src/ai/providers/ProviderSecrets');
  let failures = true;
  const native = vi.fn(async () =>
    failures
      ? reply('{"error":{"message":"synthetic-secret"}}', 503)
      : reply('{"text":"Try again"}'),
  );
  const transport = transportFixture(native);
  const provider = new ProviderTranscription(
    new ProviderSecrets({ getSecret: () => 'synthetic-secret', setSecret: () => {} }),
    transport,
    () => ({ voice: 'openai' }),
  );
  const audio = new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4])]);
  await expect(provider.transcribe(audio, new AbortController().signal)).rejects.toThrow(
    /connection/i,
  );
  expect(native).toHaveBeenCalledTimes(3);
  failures = false;
  expect(await provider.transcribe(audio, new AbortController().signal)).toBe('Try again');
  expect(native).toHaveBeenCalledTimes(4);
  transport.dispose();
});
it('freezes validated multipart values while waiting for native capacity', async () => {
  const { deferred } = await import('./helpers');
  const first = deferred<RequestUrlResponse>(),
    second = deferred<RequestUrlResponse>();
  const requests: RequestUrlParam[] = [];
  const transport = transportFixture(async (request) => {
    requests.push(request);
    if (requests.length === 1) return first.promise;
    if (requests.length === 2) return second.promise;
    return reply();
  });
  const a = transport.fetchFor('openai')('https://api.openai.com/v1/responses');
  const b = transport.fetchFor('openai')('https://api.openai.com/v1/responses');
  const body = new FormData();
  body.set('model', 'gpt-transcribe');
  body.set('file', new Blob(['original']), 'audio.webm');
  const audio = transport.fetchFor('openai')('https://api.openai.com/v1/audio/transcriptions', {
    body,
  });
  body.set('model', 'another-model');
  body.set('file', new Blob(['changed']), 'audio.webm');
  first.resolve(reply());
  second.resolve(reply());
  await Promise.all([a, b, audio]);
  const request = expectDefined(requests[2]);
  const sent = await new Response(request.body, { headers: request.headers ?? {} }).formData();
  expect(sent.get('model')).toBe('gpt-transcribe');
  expect(await (sent.get('file') as File).text()).toBe('original');
  transport.dispose();
});
it('transcribes owning-popout ArrayBuffer bytes across the SDK realm boundary', async () => {
  const vm = Platform.isDesktop ? await import('node:vm') : undefined;
  const { runInNewContext } = expectDefined(vm);
  const { ProviderTranscription } = await import('../src/ai/voice/ProviderTranscription');
  const { ProviderSecrets } = await import('../src/ai/providers/ProviderSecrets');
  const transport = transportFixture(async () => reply('{"text":"Popout command"}'));
  const provider = new ProviderTranscription(
    new ProviderSecrets({ getSecret: () => 'synthetic', setSecret: () => {} }),
    transport,
    () => ({ voice: 'openai' }),
  );
  const bytes = runInNewContext(
    'new Uint8Array([0x1a,0x45,0xdf,0xa3,1,2,3,4]).buffer',
  ) as ArrayBuffer;
  expect(bytes).not.toBeInstanceOf(ArrayBuffer);
  const audio = new Blob(['synthetic']);
  vi.spyOn(audio, 'arrayBuffer').mockResolvedValue(bytes);
  expect(await provider.transcribe(audio, new AbortController().signal)).toBe('Popout command');
  transport.dispose();
});
