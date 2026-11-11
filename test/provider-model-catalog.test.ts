import type { RequestUrlParam, RequestUrlResponse } from 'obsidian';
import { expect, it, vi } from 'vitest';
import { NativeProviderTransport } from '../src/ai/providers/NativeProviderTransport';
import { ProviderModelCatalog } from '../src/ai/providers/ProviderModelCatalog';
import { ProviderSecrets } from '../src/ai/providers/ProviderSecrets';

function reply(value: unknown): RequestUrlResponse {
  const text = JSON.stringify(value);
  return {
    status: 200,
    text,
    json: value,
    headers: {},
    arrayBuffer: new TextEncoder().encode(text).buffer,
  };
}
it('lists authenticated models through the bounded native transport without an inference request', async () => {
  const request = vi.fn(async (_request: RequestUrlParam) =>
    reply({ data: [{ id: 'gpt-oss-120b' }, { id: 'qwen-3.8-27b', name: 'Qwen' }] }),
  );
  const transport = new NativeProviderTransport(request, () => () => undefined);
  const secrets = new ProviderSecrets({
    getSecret: () => 'synthetic-private-key',
    setSecret: () => undefined,
  });
  const models = await new ProviderModelCatalog(secrets, transport).list(
    'cerebras',
    new AbortController().signal,
  );
  expect(models).toEqual([
    { id: 'gpt-oss-120b', name: 'gpt-oss-120b' },
    { id: 'qwen-3.8-27b', name: 'Qwen' },
  ]);
  expect(request).toHaveBeenCalledWith(
    expect.objectContaining({
      url: 'https://api.cerebras.ai/v1/models',
      method: 'GET',
      headers: { authorization: 'Bearer synthetic-private-key' },
    }),
  );
  expect(request.mock.calls[0]?.[0]).not.toHaveProperty('body');
  transport.dispose();
});
it('rejects catalog requests with foreign URLs, payloads or unbounded query fields', async () => {
  const request = vi.fn(async () => reply({ data: [] }));
  const transport = new NativeProviderTransport(request, () => () => undefined);
  for (const url of [
    'https://api.cerebras.ai/v1/models?key=secret',
    'https://foreign.example/v1/models',
    'https://api.cerebras.ai/v1/models#suffix',
  ])
    await expect(transport.fetchFor('cerebras')(url, { method: 'GET' })).rejects.toMatchObject({
      code: 'invalid-request',
    });
  await expect(
    transport.fetchFor('cerebras')('https://api.cerebras.ai/v1/models', {
      method: 'GET',
      body: '{}',
    }),
  ).rejects.toMatchObject({ code: 'invalid-request' });
  expect(request).not.toHaveBeenCalled();
  transport.dispose();
});
it('follows the Anthropic catalog cursor and refuses a repeated cursor', async () => {
  const request = vi.fn(async () =>
    reply({
      data: [{ id: 'claude-a', display_name: 'Claude A' }],
      has_more: true,
      last_id: 'claude-a',
    }),
  );
  const transport = new NativeProviderTransport(request, () => () => undefined);
  const secrets = new ProviderSecrets({ getSecret: () => 'synthetic', setSecret: () => undefined });
  await expect(
    new ProviderModelCatalog(secrets, transport).list('anthropic', new AbortController().signal),
  ).rejects.toMatchObject({ code: 'invalid-response' });
  expect(request).toHaveBeenCalledTimes(2);
  transport.dispose();
});

it('accepts an empty Anthropic catalog with a null terminal cursor', async () => {
  const transport = new NativeProviderTransport(
    async () => reply({ data: [], has_more: false, last_id: null }),
    () => () => undefined,
  );
  const secrets = new ProviderSecrets({ getSecret: () => 'synthetic', setSecret: () => undefined });
  await expect(
    new ProviderModelCatalog(secrets, transport).list('anthropic', new AbortController().signal),
  ).resolves.toEqual([]);
  transport.dispose();
});
