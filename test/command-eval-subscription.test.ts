import { Platform } from 'obsidian';
import { expect, it } from 'vitest';
import { parseArgs } from '../tooling/command-eval.mjs';
import { subscriptionModel } from '../tooling/command-subscription.mjs';
import { canonicalModel } from './command-live/controls';
import { selectCases } from './command-live/corpus';
import { runCase } from './command-live/harness';
import { RequestBudget, validateOptions } from './command-live/safety';
import { useRealMoment } from './helpers';

it('requires an explicit model and dev vault for subscription evaluation without paid API consent', () => {
  const args = [
    '--provider',
    'chatgpt-plan',
    '--model',
    'gpt-6-luna',
    '--vault',
    'dev-vault-tasks',
  ];
  expect(parseArgs(args)).toMatchObject({
    provider: 'chatgpt-plan',
    allowPaid: false,
    vault: 'dev-vault-tasks',
  });
  expect(
    validateOptions({
      provider: 'chatgpt-plan',
      model: 'gpt-6-luna',
      maxRequests: 2,
      allowPaid: false,
    }),
  ).toMatchObject({ provider: 'chatgpt-plan' });
  for (const extra of [
    [],
    ['--vault', 'production'],
    ['--vault', 'dev-vault-tasks', '--allow-paid'],
    ['--vault', 'dev-vault-tasks', '--base-url', 'http://127.0.0.1:1/v1'],
  ]) {
    expect(() =>
      parseArgs(['--provider', 'chatgpt-plan', '--model', 'gpt-6-luna', ...extra]),
    ).toThrow();
  }
});

it('invokes the in-app production model without copying authentication and meters only admitted generation', async () => {
  if (!Platform.isDesktop) throw new Error('Requires desktop');
  const { createRequire } = await import('node:module');
  const vm = await import('node:vm');
  const budget = new RequestBudget(1);
  const execute = async (code: string) => {
    const script = `(async()=>{${code}})()`;
    const value: unknown = await vm.runInNewContext(script, {
      require: createRequire(import.meta.url),
      AbortSignal,
      app: {
        plugins: {
          plugins: {
            'abyss-tasks': {
              chatGptPlan: {
                model: (id: string) => ({
                  doGenerate: (params: { prompt: unknown }) => {
                    if (id !== 'gpt-6-luna' || !Array.isArray(params.prompt))
                      throw new Error('wrong request');
                    return {
                      content: [{ type: 'text', text: 'subscription result' }],
                      finishReason: { unified: 'stop', raw: 'stop' },
                      usage: { inputTokens: { total: 1 }, outputTokens: { total: 2 } },
                      warnings: [],
                      request: { headers: { Authorization: 'secret-must-not-cross' } },
                    };
                  },
                }),
              },
            },
          },
        },
      },
    });
    return String(value);
  };
  const model = subscriptionModel('gpt-6-luna', budget, execute);
  const result = await model.doGenerate({ prompt: [], abortSignal: new AbortController().signal });
  expect(result.content).toEqual([{ type: 'text', text: 'subscription result' }]);
  expect(JSON.stringify(result)).not.toContain('secret-must-not-cross');
  expect(budget.used).toBe(1);
  await expect(model.doGenerate({ prompt: [] })).rejects.toThrow('request-budget');
  const cancelledBudget = new RequestBudget(1);
  await expect(
    subscriptionModel('gpt-6-luna', cancelledBudget, execute).doGenerate({
      prompt: [],
      abortSignal: AbortSignal.abort(),
    }),
  ).rejects.toThrow();
  expect(cancelledBudget.used).toBe(0);
});

useRealMoment();
it('labels subscription-backed injection as live provenance rather than scripted control', async () => {
  const source = selectCases('B01-en')[0];
  if (source === undefined) throw new Error('case missing');
  const report = await runCase(
    { ...source, turns: source.turns.slice(0, 1) },
    {
      options: { provider: 'chatgpt-plan', model: 'gpt-6-luna', maxRequests: 2, allowPaid: false },
      budget: new RequestBudget(2),
      key: '',
      fetch: async () => {
        throw new Error('no API dispatch');
      },
    },
    async () => {},
    canonicalModel(),
  );
  expect(report.modelSource).toBe('live-provider');
});

it('delivers each case fixed research evidence to the model rather than the generic canned result', async () => {
  const { MockLanguageModelV4 } = await import('ai/test');
  const source = selectCases('research-substantive')[0];
  if (source === undefined) throw new Error('case missing');
  const steps = [
    { name: 'interpret', input: { intent: 'plan', research: true } },
    { name: 'expand', input: { capabilities: ['research'] } },
    { name: 'research', input: { query: 'backup options' } },
    { name: 'finish', input: { state: 'ready', message: 'Ready.' } },
  ];
  let index = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      const step = steps[index++];
      if (step === undefined) throw new Error('No more steps');
      return {
        content: [
          {
            type: 'tool-call',
            toolCallId: `fixture-${index}`,
            toolName: step.name,
            input: JSON.stringify(step.input),
          },
        ],
        finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  const report = await runCase(
    {
      ...source,
      turns: source.turns.slice(0, 1),
      researchFixture: {
        text: 'Fixed Atlas evidence: three offline copies, 20 minutes.',
        sources: ['https://example.org/atlas'],
      },
    },
    {
      options: {
        provider: 'openrouter',
        model: 'synthetic:free',
        maxRequests: 10,
        allowPaid: false,
      },
      budget: new RequestBudget(10),
      key: '',
      fetch: async () => {
        throw new Error('No network');
      },
    },
    async () => {},
    model,
  );
  const trace = JSON.stringify(report.trace);
  expect(trace).toContain('Fixed Atlas evidence: three offline copies, 20 minutes.');
  expect(trace).toContain('https://example.org/atlas');
  expect(trace).not.toContain('option A lasts 45 minutes');
});

it('retains only bounded subscription failure codes without provider messages', async () => {
  if (!Platform.isDesktop) throw new Error('Requires desktop');
  const [{ createRequire }, vm] = await Promise.all([import('node:module'), import('node:vm')]);
  const execute = async (code: string) => {
    const script = `(async()=>{${code}})()`;
    return vm.runInNewContext(script, {
      require: createRequire(import.meta.url),
      AbortSignal,
      app: {
        plugins: {
          plugins: {
            'abyss-tasks': {
              chatGptPlan: {
                model: () => {
                  throw Object.assign(new Error('secret raw provider message'), {
                    code: 'plan-limit',
                    name: 'ProviderFailure',
                  });
                },
              },
            },
          },
        },
      },
    }) as Promise<unknown>;
  };
  await expect(
    subscriptionModel('gpt-6-luna', new RequestBudget(1), execute).doGenerate({ prompt: [] }),
  ).rejects.toMatchObject({
    name: 'SubscriptionEvaluationFailure',
    code: 'plan-limit',
    message: 'subscription:plan-limit',
  });
});

it('returns only the selected fixed page as attributed untrusted content', async () => {
  const { MockLanguageModelV4 } = await import('ai/test');
  const source = selectCases('open-goal-decomposition')[0];
  if (source === undefined) throw new Error('case missing');
  const steps = [
    { name: 'interpret', input: { intent: 'plan', research: true } },
    { name: 'expand', input: { capabilities: ['research'] } },
    { name: 'research', input: { url: 'https://example.org/product' } },
    { name: 'finish', input: { state: 'ready', message: 'Ready.' } },
  ];
  let index = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      const step = steps[index++];
      if (step === undefined) throw new Error('No more steps');
      return {
        content: [
          {
            type: 'tool-call',
            toolCallId: `page-${index}`,
            toolName: step.name,
            input: JSON.stringify(step.input),
          },
        ],
        finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  const report = await runCase(
    {
      ...source,
      pageFixture: {
        url: 'https://example.org/product',
        title: 'A product',
        content: 'Purpose is private capture. Features include task trees and calendar.',
      },
    },
    {
      options: {
        provider: 'openrouter',
        model: 'synthetic:free',
        maxRequests: 10,
        allowPaid: false,
      },
      budget: new RequestBudget(10),
      key: '',
      fetch: async () => {
        throw new Error('No network');
      },
    },
    async () => {},
    model,
  );
  const trace = JSON.stringify(report.trace);
  expect(trace).toContain('Purpose is private capture. Features include task trees and calendar.');
  expect(trace).toContain('read-page');
  expect(trace).not.toContain('Synthetic finding');
});
