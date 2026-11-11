// @vitest-environment node
import { generateText, isStepCount, jsonSchema, tool } from 'ai';
import { expect, it, vi } from 'vitest';
import { createChatGptPlanModel, planModelChoices } from '../src/ai/providers/chatGptPlanModel';
import { parseProviderSettings, researchProvider } from '../src/ai/providers/providerSettings';

const response = (output: unknown[]) => ({
  id: 'resp_fixture',
  created_at: 1800000000,
  model: 'available-model',
  status: 'completed',
  output,
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
});
const frame = (type: string, data: object) =>
  `event: ${type}\r\ndata: ${JSON.stringify({ type, ...data })}\r\n\r\n`;

it('keeps the subscription an independent agent choice and reads only visible account models', () => {
  const selected = parseProviderSettings({ provider: 'chatgpt-plan' });
  expect(selected.model).toBe('');
  expect(researchProvider(selected)).toBeNull();
  expect(
    planModelChoices({
      models: [
        { slug: 'hidden-model', display_name: 'Hidden', visibility: 'hide' },
        { slug: 'available-model', display_name: 'Available model', visibility: 'list' },
      ],
    }),
  ).toEqual([{ id: 'available-model', name: 'Available model' }]);
});

it('uses completed namespaced function calls through the normal SDK tool loop, including results on step two', async () => {
  const call = {
    id: 'fc_fixture',
    type: 'function_call',
    call_id: 'call_fixture',
    name: 'inspect',
    namespace: 'abyss_tasks',
    arguments: '{"query":"synthetic"}',
    status: 'completed',
  };
  const finish = {
    ...call,
    id: 'fc_complete',
    call_id: 'call_complete',
    name: 'finish',
    arguments: '{}',
  };
  const requests: Array<Record<string, unknown>> = [];
  const model = createChatGptPlanModel('available-model', async (body) => {
    requests.push(body);
    return new Response(
      frame('response.completed', {
        response: response(requests.length === 1 ? [call] : [finish]),
      }),
    );
  });
  const execute = vi.fn(async () => ({ count: 2 }));
  const result = await generateText({
    model,
    instructions: 'Use the task tools.',
    prompt: 'Check synthetic records.',
    tools: {
      inspect: tool({
        description: 'Inspect a fixture.',
        inputSchema: jsonSchema<{ query: string }>({
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
          additionalProperties: false,
        }),
        execute,
      }),
      finish: tool({
        inputSchema: jsonSchema({ type: 'object', properties: {}, additionalProperties: false }),
        execute: async () => 'done',
      }),
    },
    toolChoice: 'required',
    maxOutputTokens: 200,
    maxRetries: 0,
    stopWhen: isStepCount(2),
  });
  expect(result.steps[1]?.toolResults[0]?.output).toBe('done');
  expect(execute).toHaveBeenCalledTimes(1);
  expect(requests[0]).toMatchObject({
    model: 'available-model',
    store: false,
    stream: true,
    tool_choice: 'required',
    tools: [
      {
        type: 'namespace',
        name: 'abyss_tasks',
        tools: [
          { name: 'inspect', type: 'function' },
          { name: 'finish', type: 'function' },
        ],
      },
    ],
  });
  expect(requests[0]).not.toHaveProperty('max_output_tokens');
  expect(JSON.stringify(requests[0])).not.toContain('"role":"system"');
  expect(requests[1]?.['input']).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'function_call',
        call_id: 'call_fixture',
        namespace: 'abyss_tasks',
      }),
      expect.objectContaining({ type: 'function_call_output', call_id: 'call_fixture' }),
    ]),
  );
});
it.each([
  [frame('response.output_item.done', { item: { type: 'function_call' } }), 'invalid-response'],
  [
    frame('response.failed', {
      response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } },
    }),
    'plan-limit',
  ],
  [frame('response.incomplete', { response: {} }), 'invalid-response'],
])('rejects an unfinished or failed stream before a tool can execute', async (stream, code) => {
  const model = createChatGptPlanModel('available-model', async () => new Response(stream));
  await expect(generateText({ model, prompt: 'Synthetic.', maxRetries: 0 })).rejects.toMatchObject({
    code,
  });
});

it('requires a dedicated desktop account connection without consulting API key storage', async () => {
  const { ProviderConnections } = await import('../src/ai/providers/ProviderConnections');
  const { NativeProviderTransport } = await import('../src/ai/providers/NativeProviderTransport');
  const { ProviderSecrets } = await import('../src/ai/providers/ProviderSecrets');
  const getSecret = vi.fn(() => 'synthetic-api-key');
  const native = new NativeProviderTransport(vi.fn(), () => () => undefined);
  const independent = new ProviderConnections(
    new ProviderSecrets({ getSecret, setSecret: vi.fn() }),
    native,
  );
  const selection = parseProviderSettings({ provider: 'chatgpt-plan', model: 'synthetic-model' });
  expect(independent.availability(selection)).toEqual({ agent: false, voice: false });
  expect(() => independent.model(selection)).toThrow(/desktop/i);
  expect(getSecret).not.toHaveBeenCalled();
});

it('prevents other providers from binding the plugin-owned OAuth registration as an API key', async () => {
  const { ProviderSecrets } = await import('../src/ai/providers/ProviderSecrets');
  const getSecret = vi.fn(() => 'synthetic-oauth-session');
  const secrets = new ProviderSecrets({ getSecret, setSecret: vi.fn() }, () => ({
    openai: 'abyss-tasks-chatgpt-plan',
  }));
  expect(() => secrets.resolve('openai')).toThrow();
  expect(() => secrets.resolveId('abyss-tasks-chatgpt-plan')).toThrow();
  expect(getSecret).not.toHaveBeenCalled();
});
