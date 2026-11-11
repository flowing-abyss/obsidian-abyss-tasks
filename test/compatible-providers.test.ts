// @vitest-environment node
import { generateText, jsonSchema } from 'ai';
import type { RequestUrlParam } from 'obsidian';
import { afterEach, expect, it, vi } from 'vitest';
import { NativeProviderTransport } from '../src/ai/providers/NativeProviderTransport';
import { ProviderConnections } from '../src/ai/providers/ProviderConnections';
import { ProviderSecrets } from '../src/ai/providers/ProviderSecrets';
import { parseProviderSettings, researchProvider } from '../src/ai/providers/providerSettings';
import { ProviderTranscription } from '../src/ai/voice/ProviderTranscription';
import { expectDefined } from './helpers';

const agent = { baseURL: 'http://localhost:11434/v1/', model: 'qwen3:4b' };
const voice = { baseURL: 'https://192.168.1.20:8080/asr/v1', model: 'whisper-1' };
const selection = {
  provider: 'openai-compatible',
  compatibleAgent: agent,
  voice: 'openai-compatible',
  compatibleVoice: voice,
};
const audio = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);

function fixture(settings: Record<string, unknown> = selection) {
  const native = vi.fn(async () => {
    throw new Error('Unexpected predefined provider call.');
  });
  const requests: RequestUrlParam[] = [];
  const port = vi.fn(async (request: RequestUrlParam) => {
    requests.push(request);
    const body = request.url.endsWith('/audio/transcriptions')
      ? { text: 'Local dictation' }
      : {
          choices: [
            {
              index: 0,
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'c1',
                    type: 'function',
                    function: { name: 'lookup', arguments: '{"value":"abc"}' },
                  },
                ],
              },
            },
          ],
        };
    return {
      status: 200,
      headers: {},
      arrayBuffer: new TextEncoder().encode(JSON.stringify(body)).buffer,
    };
  });
  const transport = new NativeProviderTransport(native, () => () => undefined, port);
  const values: Record<string, string> = {
    'agent-id': 'agent-secret',
    'voice-id': 'voice-secret',
    'abyss-tasks-openai-api-key': 'predefined-secret',
  };
  const getSecret = vi.fn((id: string) => values[id] ?? null);
  const secrets = new ProviderSecrets({ getSecret, setSecret: () => undefined });
  const connections = new ProviderConnections(secrets, transport);
  const transcription = new ProviderTranscription(secrets, transport, () => settings);
  const generate = () =>
    generateText({
      model: connections.model(parseProviderSettings(settings)),
      prompt: 'Look up abc.',
      tools: {
        lookup: {
          inputSchema: jsonSchema<{ value: string }>({
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
          }),
        },
      },
      toolChoice: 'required',
      maxRetries: 0,
    });
  return { native, port, requests, getSecret, connections, transcription, generate, transport };
}
afterEach(() => vi.unstubAllEnvs());

it('uses only the two explicit bases and models for keyless chat tools and multipart voice', async () => {
  vi.stubEnv('OPENAI_API_KEY', 'ambient-secret');
  vi.stubEnv('OPENAI_BASE_URL', 'https://unused.invalid');
  const h = fixture();
  expect(h.connections.availability(selection)).toEqual({ agent: true, voice: true });
  h.transcription.available();
  expect(h.port).not.toHaveBeenCalled();
  expect(researchProvider(parseProviderSettings(selection))).toBeNull();
  const turn = await h.generate();
  expect(turn.toolCalls).toMatchObject([{ toolName: 'lookup', input: { value: 'abc' } }]);
  expect(await h.transcription.transcribe(new Blob([audio]), new AbortController().signal)).toBe(
    'Local dictation',
  );
  const chat = expectDefined(h.requests[0]);
  expect(chat).toMatchObject({ url: 'http://localhost:11434/v1/chat/completions', method: 'POST' });
  expect(JSON.parse(typeof chat.body === 'string' ? chat.body : '')).toMatchObject({
    model: 'qwen3:4b',
    tool_choice: 'required',
    tools: [{ type: 'function', function: { name: 'lookup' } }],
  });
  const asr = expectDefined(h.requests[1]);
  expect(asr).toMatchObject({
    url: 'https://192.168.1.20:8080/asr/v1/audio/transcriptions',
    method: 'POST',
  });
  const form = await new Response(asr.body, { headers: asr.headers ?? {} }).formData();
  expect(form.get('model')).toBe('whisper-1');
  expect([...new Uint8Array(await (form.get('file') as File).arrayBuffer())]).toEqual([...audio]);
  expect([...form.keys()].sort((a, b) => a.localeCompare(b))).toEqual(['file', 'model']);
  expect(h.requests.map((request) => new Headers(request.headers).get('authorization'))).toEqual([
    null,
    null,
  ]);
  expect(h.getSecret).not.toHaveBeenCalled();
  expect(h.native).not.toHaveBeenCalled();
  h.transport.dispose();
});
it('binds each optional key to its full base, fails closed on removed or mismatched secrets', async () => {
  const settings = {
    ...selection,
    compatibleAgent: { ...agent, secret: { baseURL: agent.baseURL, id: 'agent-id' } },
    compatibleVoice: { ...voice, secret: { baseURL: voice.baseURL, id: 'voice-id' } },
  };
  const h = fixture(settings);
  await h.generate();
  await h.transcription.transcribe(new Blob([audio]), new AbortController().signal);
  expect(h.requests.map((r) => new Headers(r.headers).get('authorization'))).toEqual([
    'Bearer agent-secret',
    'Bearer voice-secret',
  ]);
  settings.compatibleAgent.baseURL = 'http://localhost:11434/another/v1';
  expect(h.connections.availability(settings)).toEqual({ agent: false, voice: true });
  expect(() => h.generate()).toThrow(expect.objectContaining({ code: 'invalid-request' }));
  settings.compatibleVoice.secret.id = 'missing-id';
  expect(() => {
    h.transcription.available();
  }).toThrow(expect.objectContaining({ code: 'missing-key' }));
  expect(h.requests).toHaveLength(2);
  expect(h.native).not.toHaveBeenCalled();
});
it.each([
  '',
  'http:',
  'http:///localhost',
  'ftp://localhost/',
  'http://u:p@localhost/v1',
  'https://localhost/v1?',
  'http://localhost/v1?key=secret',
  'https://localhost/v1#',
  'http://localhost\\@other/v1',
  'http://localhost/v1/../other',
])('rejects an invalid explicit base %s while voice remains available', (baseURL) => {
  const settings = { ...selection, compatibleAgent: { ...agent, baseURL } };
  const h = fixture(settings);
  expect(h.connections.availability(settings)).toEqual({ agent: false, voice: true });
  expect(() => h.generate()).toThrow(expect.objectContaining({ code: 'invalid-request' }));
  expect(h.port).not.toHaveBeenCalled();
  expect(h.native).not.toHaveBeenCalled();
});
it('requires a custom model and base even with existing cloud settings and keeps the other role usable', () => {
  const settings = {
    ...selection,
    model: 'previous-paid-model',
    voiceModel: 'gpt-transcribe',
    compatibleAgent: { baseURL: agent.baseURL },
    compatibleVoice: {},
  };
  const h = fixture(settings);
  expect(h.connections.availability(settings)).toEqual({ agent: false, voice: false });
  expect(() => h.generate()).toThrow(expect.objectContaining({ code: 'invalid-request' }));
  expect(() => {
    h.transcription.available();
  }).toThrow(expect.objectContaining({ code: 'invalid-request' }));
  expect(h.connections.availability({ ...settings, provider: 'openai' })).toEqual({
    agent: true,
    voice: false,
  });
  expect(h.connections.availability({ ...settings, voice: 'openai' })).toEqual({
    agent: false,
    voice: true,
  });
  expect(h.port).not.toHaveBeenCalled();
  expect(h.native).not.toHaveBeenCalled();
});

it('admits only the configured role, method, payload and model, discarding SDK credentials and headers', async () => {
  const h = fixture();
  const chat = h.transport.compatibleFetch('agent', agent);
  const asr = h.transport.compatibleFetch('voice', voice);
  const url = 'http://localhost:11434/v1/chat/completions';
  const voiceURL = 'https://192.168.1.20:8080/asr/v1/audio/transcriptions';
  const body = JSON.stringify({ model: agent.model, messages: [] });
  const post = { method: 'POST', body };
  for (const [target, init] of [
    [`${url}?q=1`, post],
    [`${url}#frag`, post],
    [voiceURL, post],
    [url.replace('localhost', 'other'), post],
    [url.replace('chat/completions', 'models'), post],
    [url, { ...post, method: 'GET' }],
    [url, { ...post, method: 'DELETE' }],
    [url, { method: 'POST' }],
    [url, { ...post, body: '{broken' }],
    [url, { ...post, body: JSON.stringify({ model: 'other', messages: [] }) }],
    [url, { ...post, body: JSON.stringify({ model: agent.model, messages: [], stream: true }) }],
  ] as const)
    await expect(chat(target, init)).rejects.toMatchObject({ code: 'invalid-request' });
  const oversized = JSON.stringify({ model: agent.model, messages: ['x'.repeat(4 * 1024 * 1024)] });
  await expect(chat(url, { ...post, body: oversized })).rejects.toMatchObject({
    code: 'too-large',
  });
  const form = new FormData();
  form.set('model', voice.model);
  form.set('file', new Blob(['audio']), 'audio.webm');
  await expect(asr(voiceURL, post)).rejects.toMatchObject({ code: 'invalid-request' });
  await expect(chat(url, { ...post, body: form })).rejects.toMatchObject({
    code: 'invalid-request',
  });
  form.set('model', 'other');
  await expect(asr(voiceURL, { ...post, body: form })).rejects.toMatchObject({
    code: 'invalid-request',
  });
  form.set('model', voice.model);
  form.set('prompt', 'extra');
  await expect(asr(voiceURL, { ...post, body: form })).rejects.toMatchObject({
    code: 'invalid-request',
  });
  form.delete('prompt');
  form.set('file', new Blob([new Uint8Array(4 * 1024 * 1024 + 1)]));
  await expect(asr(voiceURL, { ...post, body: form })).rejects.toMatchObject({ code: 'too-large' });
  expect(h.port).not.toHaveBeenCalled();
  await chat(url, {
    ...post,
    headers: { Authorization: 'Bearer unselected', Cookie: 'private', 'X-Secret': 's' },
  });
  expect(h.requests[0]?.headers).toEqual({ 'content-type': 'application/json' });
  expect(h.native).not.toHaveBeenCalled();
});

it('parses the active custom models through repeated reads without using stale predefined choices', () => {
  const parsed = parseProviderSettings({
    ...selection,
    model: '',
    voiceModel: '',
    future: { keep: true },
  });
  expect(parsed).toMatchObject({
    model: 'qwen3:4b',
    voiceModel: 'whisper-1',
    future: { keep: true },
  });
  expect(parseProviderSettings(parsed)).toEqual(parsed);
  const incomplete = parseProviderSettings({ provider: 'openai-compatible' });
  expect(parseProviderSettings(incomplete)).toEqual(incomplete);
  expect(fixture().connections.availability(incomplete)).toEqual({ agent: false, voice: false });
});
it.each(['127.0.0.1', '[::1]', '192.0.2.74', 'inference.lan'])(
  'posts to the exact configured HTTP host %s',
  async (host) => {
    const base = new URL('http://localhost:8080/project/v1');
    base.hostname = host;
    const settings = { ...selection, compatibleAgent: { ...agent, baseURL: base.href } };
    const h = fixture(settings);
    await h.generate();
    expect(h.requests.map((r) => r.url)).toEqual([
      `http://${host}:8080/project/v1/chat/completions`,
    ]);
  },
);

it('sends exactly the audio view provided by the SDK even from a pooled desktop buffer', async () => {
  const { transcribe } = await import('ai');
  const { compatibleTranscription } = await import('../src/ai/voice/compatibleTranscription');
  const h = fixture();
  const bytes = process.getBuiltinModule('buffer').Buffer.from([...audio, 99, 100, 101]);
  await transcribe({
    model: compatibleTranscription({
      ...voice,
      apiKey: '',
      fetch: h.transport.compatibleFetch('voice', voice),
    }),
    audio: bytes.subarray(0, audio.length),
    maxRetries: 0,
  });
  const request = expectDefined(h.requests[0]);
  const form = await new Response(request.body, { headers: request.headers ?? {} }).formData();
  expect((form.get('file') as File).size).toBe(audio.length);
});
