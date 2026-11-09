// @vitest-environment jsdom
import { generateText, jsonSchema } from 'ai';
import type { RequestUrlParam, RequestUrlResponse } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { NativeProviderTransport } from '../src/ai/providers/NativeProviderTransport';
import { ProviderConnections } from '../src/ai/providers/ProviderConnections';
import { providerFailure } from '../src/ai/providers/providerFailure';
import { ProviderSecrets } from '../src/ai/providers/ProviderSecrets';
import {
  defaultProviderSettings,
  parseProviderSettings,
  researchProvider,
} from '../src/ai/providers/providerSettings';

function transportFixture(
  request: ConstructorParameters<typeof NativeProviderTransport>[0],
): NativeProviderTransport {
  return new NativeProviderTransport(request, (callback, ms) => {
    const timer = window.setTimeout(callback, ms);
    return () => {
      window.clearTimeout(timer);
    };
  });
}

function reply(text = '{}', status = 200, headers = {}): RequestUrlResponse {
  return {
    status,
    headers,
    text,
    arrayBuffer: new TextEncoder().encode(text).buffer,
    json: undefined,
  };
}

function secrets() {
  const values = new Map<string, string>();
  const owner = new ProviderSecrets({
    getSecret: (id) => values.get(id) ?? null,
    setSecret: (id, value) => {
      values.set(id, value);
    },
  });
  return { owner, values };
}

describe('provider connections', () => {
  it('reports configured controls from current preferences and key presence without a request', () => {
    const { owner } = secrets();
    const request = vi.fn(async () => reply());
    const connections = new ProviderConnections(owner, transportFixture(request));
    expect(connections.availability({})).toEqual({ agent: false, voice: false });
    owner.store('openrouter', 'synthetic-agent-key');
    owner.store('openai', 'synthetic-voice-key');
    expect(connections.availability({})).toEqual({ agent: true, voice: false });
    expect(connections.availability({ voice: 'openai' })).toEqual({ agent: true, voice: true });
    owner.store('openrouter', '');
    expect(connections.availability({ voice: 'openai' })).toEqual({ agent: false, voice: true });
    expect(connections.availability({ provider: 'unsupported' })).toEqual({
      agent: false,
      voice: false,
    });
    expect(request).not.toHaveBeenCalled();
  });
  it('defaults to explicit OpenRouter and reuses only supported research billing providers', () => {
    const settings = defaultProviderSettings();
    expect(settings).toEqual({
      provider: 'openrouter',
      model: 'openai/gpt-6-luna',
      search: 'agent',
      voice: 'disabled',
    });
    expect(researchProvider(settings)).toBe('openrouter');
    expect(researchProvider({ ...settings, provider: 'anthropic' })).toBeNull();
    expect(researchProvider({ ...settings, provider: 'anthropic', search: 'openai' })).toBe(
      'openai',
    );
    expect(() => parseProviderSettings({ ...settings, provider: 'gateway' })).toThrow();
    expect(parseProviderSettings({ ...settings, extension: { keep: true } })).toMatchObject({
      extension: { keep: true },
    });
  });

  it('round-trips only fixed IDs, clears keys, and never serializes the storage owner', () => {
    const { owner, values } = secrets();
    owner.store('openrouter', ' synthetic-private-key ');
    expect(owner.has('openrouter')).toBe(true);
    expect(owner.resolve('openrouter')).toBe('synthetic-private-key');
    expect([...values.keys()]).toEqual(['abyss-tasks-openrouter-api-key']);
    expect(JSON.stringify(owner)).not.toContain('synthetic-private-key');
    owner.store('openrouter', '');
    expect(owner.has('openrouter')).toBe(false);
    expect(() => owner.resolve('openrouter')).toThrow(
      expect.objectContaining({ code: 'missing-key' }),
    );
  });

  it('maps unsafe failures to bounded credential-free messages', () => {
    for (const [statusCode, code] of [
      [401, 'authentication'],
      [402, 'billing'],
      [403, 'authentication'],
      [429, 'rate-limit'],
      [500, 'unavailable'],
    ] as const) {
      const failure = providerFailure({
        statusCode,
        message: 'SECRET provider response',
        responseBody: 'SECRET',
      });
      expect(failure.code).toBe(code);
      expect(JSON.stringify(failure)).not.toContain('SECRET');
      expect(failure.message).not.toContain('SECRET');
    }
  });

  it('maps wrapped numeric billing failures without inferring billing from private prose', () => {
    const failure = providerFailure({
      cause: { cause: { statusCode: 402, message: 'SECRET insufficient balance' } },
    });
    expect(failure.code).toBe('billing');
    expect(failure.message).toContain('billing');
    expect(failure.message).not.toContain('SECRET');
    expect(JSON.stringify(failure)).not.toContain('SECRET');
    expect(providerFailure({ statusCode: '402', message: 'insufficient credits' }).code).toBe(
      'unavailable',
    );
  });

  it('preserves numeric billing failures through the actual SDK and native adapter boundary', async () => {
    const { owner } = secrets();
    owner.store('openrouter', 'synthetic-private-key');
    let requests = 0;
    const transport = transportFixture(async () => {
      requests++;
      return reply('{"error":{"message":"SECRET insufficient balance","code":402}}', 402);
    });
    try {
      await expect(
        generateText({
          model: new ProviderConnections(owner, transport).model(defaultProviderSettings()),
          prompt: 'Reply OK.',
          maxOutputTokens: 16,
          maxRetries: 0,
        }).catch((error: unknown) => {
          throw providerFailure(error);
        }),
      ).rejects.toMatchObject({ code: 'billing' });
      expect(requests).toBe(1);
    } finally {
      transport.dispose();
    }
  });

  it('uses selected SDK models and fixed native endpoints without an implicit provider fallback', async () => {
    const { owner } = secrets();
    const requests: RequestUrlParam[] = [];
    const transport = transportFixture(async (request) => {
      requests.push(request);
      return reply('{broken');
    });
    const connections = new ProviderConnections(owner, transport);
    expect(() => connections.model(defaultProviderSettings())).toThrow(
      expect.objectContaining({ code: 'missing-key' }),
    );
    for (const [provider, model, url] of [
      ['openrouter', 'openai/gpt-6-luna', 'https://openrouter.ai/api/v1/chat/completions'],
      ['openai', 'gpt-6-luna', 'https://api.openai.com/v1/responses'],
      ['anthropic', 'claude-haiku-5-5', 'https://api.anthropic.com/v1/messages'],
    ] as const) {
      owner.store(provider, 'synthetic-private-key');
      expect(connections.model({ provider, model }).modelId).toBe(model);
      await expect(
        generateText({
          model: connections.model({ provider, model }),
          prompt: 'Reply OK.',
          maxOutputTokens: 16,
          maxRetries: 0,
        }).catch((error: unknown) => {
          throw providerFailure(error);
        }),
      ).rejects.toMatchObject({ code: 'invalid-response' });
      expect(requests[requests.length - 1]?.url).toBe(url);
      expect(requests[requests.length - 1]?.body).toContain(model);
      expect(requests[requests.length - 1]?.throw).toBe(false);
    }
    expect(requests).toHaveLength(3);
    transport.dispose();
  });
});

describe('buffered native provider transport', () => {
  it('retains status and headers and rejects arbitrary initial URLs before dispatch', async () => {
    const native = vi.fn(async () => reply('{"error":"limited"}', 429, { 'retry-after': '9' }));
    const transport = transportFixture(native);
    const response = await transport.fetchFor('openai')('https://api.openai.com/v1/responses', {
      method: 'POST',
      body: '{}',
    });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('9');
    await expect(
      transport.fetchFor('openai')('https://example.org/v1/responses'),
    ).rejects.toMatchObject({ code: 'invalid-request' });
    expect(native).toHaveBeenCalledTimes(1);
    transport.dispose();
  });

  it('keeps cancelled physical requests occupying slots, removes obsolete queued calls and ignores late results', async () => {
    const pending: Array<(value: RequestUrlResponse) => void> = [];
    const native = vi.fn(() => new Promise<RequestUrlResponse>((resolve) => pending.push(resolve)));
    const transport = transportFixture(native);
    const fetch = transport.fetchFor('openrouter');
    const url = 'https://openrouter.ai/api/v1/chat/completions';
    const first = new AbortController();
    const queued = new AbortController();
    const a = fetch(url, { signal: first.signal });
    const aRejected = expect(a).rejects.toMatchObject({ code: 'cancelled' });
    const b = fetch(url);
    const c = fetch(url, { signal: queued.signal });
    const cRejected = expect(c).rejects.toMatchObject({ code: 'cancelled' });
    await vi.waitFor(() => {
      expect(native).toHaveBeenCalledTimes(2);
    });
    first.abort();
    queued.abort();
    await Promise.all([aRejected, cRejected]);
    const d = fetch(url);
    expect(native).toHaveBeenCalledTimes(2);
    pending[0]?.(reply('{"late":true}'));
    await vi.waitFor(() => {
      expect(native).toHaveBeenCalledTimes(3);
    });
    pending[1]?.(reply());
    pending[2]?.(reply());
    await Promise.all([b, d]);
    transport.dispose();
  });
});

describe('native resource bounds', () => {
  it('times out acceptance without freeing physical capacity and refuses excess queued work', async () => {
    const deadlines: Array<() => void> = [];
    const pending: Array<(response: RequestUrlResponse) => void> = [];
    const native = vi.fn(
      () =>
        new Promise<RequestUrlResponse>((resolve) => {
          pending.push(resolve);
        }),
    );
    const transport = new NativeProviderTransport(native, (callback) => {
      deadlines.push(callback);
      return () => undefined;
    });
    const fetch = transport.fetchFor('openai');
    const url = 'https://api.openai.com/v1/responses';
    const first = fetch(url);
    const rejection = expect(first).rejects.toMatchObject({ code: 'timeout' });
    const second = fetch(url);
    deadlines[0]?.();
    await rejection;
    const queued = Array.from({ length: 8 }, () => fetch(url));
    await expect(fetch(url)).rejects.toMatchObject({ code: 'busy' });
    expect(native).toHaveBeenCalledTimes(2);
    const cancelled = [second, ...queued].map(async (request) => {
      await expect(request).rejects.toMatchObject({ code: 'cancelled' });
    });
    transport.dispose();
    await Promise.all(cancelled);
    pending.forEach((resolve) => {
      resolve(reply());
    });
    await Promise.resolve();
    expect(native).toHaveBeenCalledTimes(2);
    await expect(fetch(url)).rejects.toMatchObject({ code: 'cancelled' });
  });
  it('rejects streamed, non-JSON and oversized requests before native dispatch, and caps buffered response acceptance', async () => {
    const native = vi.fn(async () => ({
      ...reply(),
      arrayBuffer: new ArrayBuffer(8 * 1024 * 1024 + 1),
    }));
    const transport = transportFixture(native);
    const fetch = transport.fetchFor('anthropic');
    const url = 'https://api.anthropic.com/v1/messages';
    for (const body of ['{"stream":true}', 'not-json']) {
      await expect(fetch(url, { body })).rejects.toMatchObject({ code: 'invalid-request' });
    }
    await expect(fetch(url, { body: 'x'.repeat(4 * 1024 * 1024 + 1) })).rejects.toMatchObject({
      code: 'too-large',
    });
    expect(native).not.toHaveBeenCalled();
    await expect(fetch(url, { body: '{}' })).rejects.toMatchObject({ code: 'too-large' });
    expect(native).toHaveBeenCalledTimes(1);
    transport.dispose();
  });
});

it('runs a validated SDK tool exchange through the selected native OpenRouter model', async () => {
  const { z } = await import('zod');
  const { tool, isStepCount } = await import('ai');
  const { owner } = secrets();
  owner.store('openrouter', 'synthetic-tool-secret');
  const requests: RequestUrlParam[] = [];
  const transport = transportFixture(async (request) => {
    requests.push(request);
    const message =
      requests.length === 1
        ? {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call-1',
                type: 'function',
                function: { name: 'double', arguments: '{"value":3}' },
              },
            ],
          }
        : { role: 'assistant', content: '6' };
    return reply(
      JSON.stringify({
        id: 'fixture',
        created: 1,
        model: 'openai/gpt-6-luna',
        choices: [
          { index: 0, message, finish_reason: requests.length === 1 ? 'tool_calls' : 'stop' },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }),
    );
  });
  const connections = new ProviderConnections(owner, transport);
  const result = await generateText({
    model: connections.model(defaultProviderSettings()),
    prompt: 'Double 3.',
    maxRetries: 0,
    stopWhen: isStepCount(2),
    tools: {
      double: tool({
        inputSchema: z.object({ value: z.number() }),
        execute: ({ value }) => value * 2,
      }),
    },
  });
  expect(result.finalStep.text).toBe('6');
  expect(requests).toHaveLength(2);
  expect(requests[1]?.body).toContain('call-1');
  expect(requests[1]?.body).toContain('"content":"6"');
  expect(requests[0]?.headers?.['authorization']).toBe('Bearer synthetic-tool-secret');
  transport.dispose();
});

it('uses provider-specific defaults and maps aborted SDK work without raw causes', () => {
  expect(parseProviderSettings({ provider: 'openai' }).model).toBe('gpt-6-luna');
  expect(parseProviderSettings({ provider: 'anthropic' }).model).toBe('claude-haiku-5-5');
  expect(providerFailure({ name: 'AbortError', message: 'private prompt' }).code).toBe('cancelled');
});

it.each([
  {
    provider: 'groq',
    model: 'openai/gpt-oss-120b',
    url: 'https://api.groq.com/openai/v1/chat/completions',
  },
  {
    provider: 'cerebras',
    model: 'qwen-3.8-27b',
    url: 'https://api.cerebras.ai/v1/chat/completions',
  },
] as const)(
  'connects $provider tool calls through the fixed native endpoint without search fallback',
  async ({ provider, model, url }) => {
    const { owner, values } = secrets();
    const settings = parseProviderSettings({ provider, extension: { keep: true } });
    expect(settings.model).toBe(model);
    expect(settings['extension']).toEqual({ keep: true });
    expect(researchProvider(settings)).toBeNull();
    expect(researchProvider({ ...settings, search: 'tavily' })).toBe('tavily');
    owner.store(provider, 'synthetic-groq-key');
    expect([...values.keys()]).toEqual([`abyss-tasks-${provider}-api-key`]);
    const native = vi.fn<ConstructorParameters<typeof NativeProviderTransport>[0]>(async () =>
      reply(
        JSON.stringify({
          id: 'completion-1',
          object: 'chat.completion',
          created: 1,
          model: settings.model,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'tool-1',
                    type: 'function',
                    function: { name: 'inspect', arguments: '{"target":"example"}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      ),
    );
    const transport = transportFixture(native),
      connections = new ProviderConnections(owner, transport);
    const result = await generateText({
      model: connections.model(settings),
      prompt: 'Inspect the task.',
      maxRetries: 0,
      tools: {
        inspect: {
          inputSchema: jsonSchema<{ target: string }>({
            type: 'object',
            properties: { target: { type: 'string' } },
            required: ['target'],
            additionalProperties: false,
          }),
        },
      },
    });
    expect(result.toolCalls).toMatchObject([{ toolName: 'inspect', input: { target: 'example' } }]);
    expect(native).toHaveBeenCalledOnce();
    expect(native.mock.calls[0]?.[0]).toMatchObject({
      url,
      throw: false,
    });
    await expect(
      transport.fetchFor(provider)(url.replace('/chat/completions', '/models')),
    ).rejects.toMatchObject({ code: 'invalid-request' });
    expect(native).toHaveBeenCalledOnce();
    owner.store(provider, '');
    expect(connections.availability(settings).agent).toBe(false);
    transport.dispose();
  },
);
