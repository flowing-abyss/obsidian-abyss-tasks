import { createOpenAI } from '@ai-sdk/openai';
import { wrapLanguageModel } from 'ai';
import { z } from 'zod';
import { ProviderFailure } from './providerFailure';
import type { ProviderModel } from './ProviderModelCatalog';

const namespace = { name: 'abyss_tasks', description: 'Abyss Tasks command tools' };
const catalog = z.object({
  models: z
    .array(
      z.object({
        slug: z.string().min(1).max(200),
        display_name: z.string().min(1).max(300),
        visibility: z.string(),
      }),
    )
    .max(2000),
});
export function planModelChoices(value: unknown): readonly ProviderModel[] {
  const result = catalog.safeParse(value);
  if (!result.success) throw new ProviderFailure('invalid-response');
  return result.data.models
    .filter((item) => item.visibility === 'list')
    .map(({ slug, display_name }) => ({ id: slug, name: display_name }));
}

const payload = z.object({
  model: z.string(),
  input: z.array(z.unknown()),
  tools: z
    .array(
      z.object({
        type: z.literal('namespace'),
        name: z.literal('abyss_tasks'),
        tools: z.array(z.looseObject({ type: z.literal('function') })),
        description: z.string(),
      }),
    )
    .optional(),
  instructions: z.string().optional(),
  tool_choice: z.literal('required').optional(),
  reasoning: z.unknown().optional(),
  include: z.array(z.string()).optional(),
});
type PlanRequest = (
  body: Record<string, unknown>,
  signal?: AbortSignal | null,
) => Promise<Response>;
/** The SDK retains validation, tool execution and stateless function-call history. Only its HTTP
 * representation differs for the subscription route, which requires a completed SSE response. */
export function createChatGptPlanModel(
  model: string,
  request: PlanRequest,
): ReturnType<typeof wrapLanguageModel> {
  const responses = createOpenAI({
    // The transport supplies the active OAuth grant at dispatch; no key enters this SDK client.
    apiKey: 'unused',
    fetch: async (url, init) => {
      if (
        url !== 'https://api.openai.com/v1/responses' ||
        init?.method !== 'POST' ||
        typeof init.body !== 'string'
      )
        throw new ProviderFailure('invalid-request');
      const parsed = payload.safeParse(JSON.parse(init.body) as unknown);
      if (!parsed.success || parsed.data.model !== model)
        throw new ProviderFailure('invalid-request');
      const wire = await request(
        { ...parsed.data, parallel_tool_calls: false, stream: true, store: false },
        init.signal,
      );
      if (!wire.ok) throw await planHttpFailure(wire);
      const completed = completedResponse(await wire.text());
      return new Response(JSON.stringify(completed), {
        headers: { 'Content-Type': 'application/json' },
      });
    },
  }).responses(model);
  return wrapLanguageModel({
    model: responses,
    middleware: {
      transformParams: ({ params }) =>
        Promise.resolve({
          ...params,
          providerOptions: { openai: { store: false, systemMessageMode: 'developer' } },
          ...(params.tools === undefined
            ? {}
            : {
                tools: params.tools.map((item) => {
                  if (item.type !== 'function') throw new ProviderFailure('invalid-request');
                  return { ...item, providerOptions: { openai: { namespace } } };
                }),
              }),
        }),
    },
  });
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
const planErrors = {
  subscription_sharing_usage_limit_exceeded: 'plan-limit',
  subscription_sharing_usage_unavailable: 'unavailable',
  subscription_sharing_user_unavailable: 'unavailable',
  subscription_sharing_user_not_eligible: 'plan-permission',
  subscription_sharing_invalid_user: 'plan-sign-in',
  subscription_sharing_unsupported_capability: 'invalid-request',
  subscription_sharing_route_not_supported: 'invalid-request',
} as const;
function planFailure(code: unknown, status = 0): ProviderFailure {
  if (typeof code === 'string' && Object.prototype.hasOwnProperty.call(planErrors, code))
    return new ProviderFailure(planErrors[code as keyof typeof planErrors]);
  if (status >= 500) return new ProviderFailure('unavailable');
  if (status === 401) return new ProviderFailure('plan-sign-in');
  if (status === 403) return new ProviderFailure('plan-permission');
  if (status === 429) return new ProviderFailure('rate-limit');
  return new ProviderFailure(status === 0 ? 'invalid-response' : 'invalid-request');
}
export async function planHttpFailure(response: Response): Promise<ProviderFailure> {
  const body = object(await response.json().catch(() => null));
  return planFailure(object(body['error'])['code'], response.status);
}
function* events(stream: string): Generator<Record<string, unknown>> {
  for (const block of stream.replace(/\r\n?/gu, '\n').split('\n\n')) {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (data === '' || data === '[DONE]') continue;
    try {
      yield object(JSON.parse(data));
    } catch {
      throw new ProviderFailure('invalid-response');
    }
  }
}
function completedResponse(stream: string): Record<string, unknown> {
  const items: unknown[] = [];
  for (const event of events(stream)) {
    const response = object(event['response']);
    switch (event['type']) {
      case 'response.output_item.done':
        items.push(event['item']);
        break;
      case 'error':
        throw planFailure(event['code']);
      case 'response.failed':
        throw planFailure(object(response['error'])['code']);
      case 'response.incomplete':
        throw new ProviderFailure('invalid-response');
      case 'response.completed':
        if (response['status'] !== 'completed') throw new ProviderFailure('invalid-response');
        return {
          ...response,
          output:
            Array.isArray(response['output']) && response['output'].length > 0
              ? response['output']
              : items,
        };
    }
  }
  throw new ProviderFailure('invalid-response');
}
