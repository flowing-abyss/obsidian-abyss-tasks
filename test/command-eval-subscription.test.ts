import { Platform } from 'obsidian';
import { expect, it, vi } from 'vitest';
import { parseArgs } from '../tooling/command-eval.mjs';
import { isTrustedSubscriptionModel, subscriptionModel } from '../tooling/command-subscription.mjs';
import { canonicalModel } from './command-live/controls';
import { selectCases } from './command-live/corpus';
import { runCase } from './command-live/harness';
import { RequestBudget, validateOptions } from './command-live/safety';
import { useRealMoment } from './helpers';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function exchangePathFromScript(code: string): string {
  const match = /const params=JSON\.parse\(await fs\.readFile\((".*?"),'utf8'\)\)/.exec(code);
  if (match?.[1] === undefined) throw new Error('exchange input path missing');
  return JSON.parse(match[1]) as string;
}

async function exchangeExists(path: string): Promise<boolean> {
  if (!Platform.isDesktop) throw new Error('Requires desktop');
  const { existsSync } = await import('node:fs');
  return existsSync(path);
}

async function removeExchange(path: string): Promise<void> {
  if (!Platform.isDesktop) throw new Error('Requires desktop');
  const { rm } = await import('node:fs/promises');
  await rm(path.slice(0, path.lastIndexOf('/')), { recursive: true, force: true });
}

async function runInVm(
  code: string,
  generate: (params: { abortSignal: AbortSignal }) => Promise<unknown>,
  abortApi: typeof AbortSignal = AbortSignal,
  timers: { setInterval?: typeof setInterval; clearInterval?: typeof clearInterval } = {},
) {
  if (!Platform.isDesktop) throw new Error('Requires desktop');
  const [{ createRequire }, vm] = await Promise.all([import('node:module'), import('node:vm')]);
  return vm.runInNewContext(`(async()=>{${code}})()`, {
    require: createRequire(import.meta.url),
    AbortSignal: abortApi,
    AbortController,
    setInterval,
    clearInterval,
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    ...timers,
    app: {
      plugins: {
        plugins: {
          'abyss-tasks': {
            chatGptPlan: { model: () => ({ doGenerate: generate }) },
          },
        },
      },
    },
  }) as Promise<unknown>;
}

it('aborts the admitted remote call and drains it before removing the exchange', async () => {
  if (!Platform.isDesktop) throw new Error('Requires desktop');
  const budget = new RequestBudget(1);
  const entered = deferred<void>();
  const release = deferred<void>();
  let remoteSignal: AbortSignal | undefined;
  let exchangeExistedWhenRemoteSettled = false;
  const execute = async (code: string) =>
    runInVm(code, async ({ abortSignal }) => {
      remoteSignal = abortSignal;
      entered.resolve();
      await release.promise;
      exchangeExistedWhenRemoteSettled = await exchangeExists(exchangePathFromScript(code));
      return {
        content: [{ type: 'text', text: 'settled after cancel' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
        warnings: [],
      };
    });
  const controller = new AbortController();
  const model = subscriptionModel('gpt-6-luna', budget, execute);
  const generation = model.doGenerate({ prompt: [], abortSignal: controller.signal });
  const rejected = generation.then(
    () => ({ resolved: true as const }),
    (error: unknown) => ({ resolved: false as const, error }),
  );
  try {
    await entered.promise;
    controller.abort();
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    expect(remoteSignal?.aborted).toBe(true);
  } finally {
    release.resolve();
  }
  await expect(rejected).resolves.toMatchObject({
    resolved: false,
    error: { name: 'SubscriptionEvaluationFailure' },
  });
  expect(exchangeExistedWhenRemoteSettled).toBe(true);
  expect(budget.used).toBe(1);
});

it('does not dispatch remotely when cancellation arrives after admission but before script entry', async () => {
  if (!Platform.isDesktop) throw new Error('Requires desktop');
  const budget = new RequestBudget(1);
  const executeEntered = deferred<void>();
  const runScript = deferred<void>();
  let remoteDispatches = 0;
  const execute = async (code: string) => {
    executeEntered.resolve();
    await runScript.promise;
    return runInVm(code, async () => {
      remoteDispatches += 1;
      throw new Error('remote dispatch should not occur');
    });
  };
  const controller = new AbortController();
  const generation = subscriptionModel('gpt-6-luna', budget, execute).doGenerate({
    prompt: [],
    abortSignal: controller.signal,
  });
  const outcome = generation.then(
    () => ({ resolved: true as const }),
    (error: unknown) => ({ resolved: false as const, error }),
  );
  await executeEntered.promise;
  controller.abort();
  runScript.resolve();
  await expect(outcome).resolves.toMatchObject({
    resolved: false,
    error: { name: 'SubscriptionEvaluationFailure', code: 'cancelled' },
  });
  expect(remoteDispatches).toBe(0);
  expect(budget.used).toBe(1);
});

it('rejects a response that settles after caller cancellation', async () => {
  if (!Platform.isDesktop) throw new Error('Requires desktop');
  const { existsSync } = await import('node:fs');
  const budget = new RequestBudget(1);
  const entered = deferred<void>();
  const release = deferred<void>();
  let exchangeExistedWhenRemoteSettled = false;
  const execute = async (code: string) =>
    runInVm(code, async () => {
      entered.resolve();
      await release.promise;
      exchangeExistedWhenRemoteSettled = existsSync(exchangePathFromScript(code));
      return {
        content: [{ type: 'text', text: 'too late' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
        warnings: [],
      };
    });
  const controller = new AbortController();
  const generation = subscriptionModel('gpt-6-luna', budget, execute).doGenerate({
    prompt: [],
    abortSignal: controller.signal,
  });
  const outcome = generation.then(
    () => ({ resolved: true as const }),
    (error: unknown) => ({ resolved: false as const, error }),
  );
  try {
    await entered.promise;
    controller.abort();
    release.resolve();
    await expect(outcome).resolves.toMatchObject({
      resolved: false,
      error: { name: 'SubscriptionEvaluationFailure', code: 'cancelled' },
    });
  } finally {
    release.resolve();
  }
  expect(exchangeExistedWhenRemoteSettled).toBe(true);
  expect(budget.used).toBe(1);
});

it('uses a remote timeout signal and reports timeout when the SDK rejects it', async () => {
  if (!Platform.isDesktop) throw new Error('Requires desktop');
  const timed = deferred<void>();
  const abortApi = {
    ...AbortSignal,
    timeout: () => {
      const controller = new AbortController();
      window.setTimeout(() => {
        controller.abort(new DOMException('timed out', 'TimeoutError'));
        timed.resolve();
      }, 10);
      return controller.signal;
    },
    any: (signals: AbortSignal[]) => AbortSignal.any(signals),
  } as unknown as typeof AbortSignal;
  const execute = async (code: string) =>
    runInVm(
      code,
      async ({ abortSignal }) => {
        await new Promise<void>((resolve) => {
          abortSignal.addEventListener(
            'abort',
            () => {
              resolve();
            },
            { once: true },
          );
        });
        throw abortSignal.reason;
      },
      abortApi,
    );
  const generation = subscriptionModel('gpt-6-luna', new RequestBudget(1), execute).doGenerate({
    prompt: [],
  });
  await timed.promise;
  await expect(generation).rejects.toMatchObject({
    name: 'SubscriptionEvaluationFailure',
    code: 'timeout',
  });
});

it('accepts a bounded provider error acknowledgement even if the CLI then fails', async () => {
  if (!Platform.isDesktop) throw new Error('Requires desktop');
  const execute = async (code: string) => {
    await runInVm(code, async () => {
      throw Object.assign(new Error('private provider detail'), { code: 'plan-limit' });
    });
    throw new Error('CLI exited after writing acknowledgement');
  };
  await expect(
    subscriptionModel('gpt-6-luna', new RequestBudget(1), execute).doGenerate({ prompt: [] }),
  ).rejects.toMatchObject({ name: 'SubscriptionEvaluationFailure', code: 'plan-limit' });
});

it('retains an unacknowledged CLI exchange and closes the campaign budget', async () => {
  if (!Platform.isDesktop) throw new Error('Requires desktop');
  const budget = new RequestBudget(1);
  let inputPath = '';
  const execute = async (code: string) => {
    inputPath = exchangePathFromScript(code);
    throw new Error('CLI exited without settlement acknowledgement');
  };
  await expect(
    subscriptionModel('gpt-6-luna', budget, execute).doGenerate({ prompt: [] }),
  ).rejects.toMatchObject({ name: 'SubscriptionEvaluationFailure', code: 'settlement-unknown' });
  expect(budget.used).toBe(1);
  expect(() => {
    budget.dispatch();
  }).toThrow('request-budget-closed');
  expect(await exchangeExists(inputPath)).toBe(true);
  if (inputPath !== '') await removeExchange(inputPath);
});

it('reports unknown settlement and retains files when the remote model ignores abort', async () => {
  if (!Platform.isDesktop) throw new Error('Requires desktop');
  vi.useFakeTimers();
  const budget = new RequestBudget(1);
  const entered = deferred<void>();
  const release = deferred<void>();
  const scriptSettled = deferred<unknown>();
  let remoteSignal: AbortSignal | undefined;
  let inputPath = '';
  let ticks = 0;
  let activeIntervals = 0;
  const execute = async (code: string) => {
    inputPath = exchangePathFromScript(code);
    const execution = runInVm(
      code,
      async ({ abortSignal }) => {
        remoteSignal = abortSignal;
        entered.resolve();
        await release.promise;
        return {
          content: [{ type: 'text', text: 'eventually settled' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
          warnings: [],
        };
      },
      AbortSignal,
      {
        setInterval: ((callback: () => void, ms?: number) => {
          activeIntervals += 1;
          return window.setInterval(() => {
            ticks += 1;
            callback();
          }, ms);
        }) as unknown as typeof setInterval,
        clearInterval: ((timer: ReturnType<typeof window.setInterval>) => {
          activeIntervals -= 1;
          window.clearInterval(timer);
        }) as unknown as typeof clearInterval,
      },
    );
    void execution.then(
      (value) => {
        scriptSettled.resolve(value);
      },
      (error: unknown) => {
        scriptSettled.reject(error);
      },
    );
    return execution;
  };
  const controller = new AbortController();
  const generation = subscriptionModel('gpt-6-luna', budget, execute).doGenerate({
    prompt: [],
    abortSignal: controller.signal,
  });
  const outcome = generation.then(
    () => ({ resolved: true as const }),
    (error: unknown) => ({ resolved: false as const, error }),
  );
  try {
    await entered.promise;
    controller.abort();
    await vi.advanceTimersByTimeAsync(5_001);
    await expect(outcome).resolves.toMatchObject({
      resolved: false,
      error: { name: 'SubscriptionEvaluationFailure', code: 'settlement-unknown' },
    });
    expect(remoteSignal?.aborted).toBe(true);
    expect(activeIntervals).toBe(0);
    expect(ticks).toBeLessThan(300);
    expect(budget.used).toBe(1);
    expect(() => {
      budget.dispatch();
    }).toThrow('request-budget-closed');
    expect(await exchangeExists(inputPath)).toBe(true);
  } finally {
    release.resolve();
    await vi.advanceTimersByTimeAsync(100);
    await scriptSettled.promise;
    if (inputPath !== '') await removeExchange(inputPath);
    vi.useRealTimers();
  }
});

it('reports remote unknown settlement in runCase cleanup metadata', async () => {
  if (!Platform.isDesktop) throw new Error('Requires desktop');
  const entered = deferred<void>();
  const release = deferred<void>();
  let script: Promise<unknown> | undefined;
  let inputPath = '';
  let remoteSettled = false;
  const budget = new RequestBudget(2);
  const execute = async (code: string) => {
    inputPath = exchangePathFromScript(code);
    script = runInVm(code, async () => {
      entered.resolve();
      await release.promise;
      remoteSettled = true;
      throw new Error('released synthetic SDK');
    });
    await entered.promise;
    throw new Error('synthetic CLI lost its waiter');
  };
  const source = selectCases('B01-en')[0];
  if (source === undefined) throw new Error('case missing');
  try {
    const report = await runCase(
      { ...source, turns: source.turns.slice(0, 1) },
      {
        options: {
          provider: 'chatgpt-plan',
          model: 'gpt-6-luna',
          maxRequests: 2,
          allowPaid: false,
        },
        budget,
        key: '',
        fetch: async () => {
          throw new Error('No network');
        },
      },
      async () => {},
      subscriptionModel('gpt-6-luna', budget, execute),
    );
    const rejections = report.trace
      .filter((event) => event.kind === 'generation-rejected')
      .map((event) => event.data);
    expect(remoteSettled).toBe(false);
    expect(await exchangeExists(inputPath)).toBe(true);
    expect(rejections).toContainEqual(
      expect.objectContaining({ subscriptionCode: 'settlement-unknown' }),
    );
    expect(report).toMatchObject({
      cleanup: 'remote-unknown',
      outcome: 'infrastructure-failure',
      failure: 'remote-settlement-unknown',
    });
    expect(() => {
      budget.dispatch();
    }).toThrow('request-budget-closed');
  } finally {
    release.resolve();
    await script;
    if (inputPath !== '') await removeExchange(inputPath);
  }
});

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
      AbortController,
      setInterval,
      clearInterval,
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
it('labels a canonical model override as scripted control even for subscription provider selection', async () => {
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
  expect(report.modelSource).toBe('scripted-control');
});

it('trusts only the actual default subscription adapter identity without dispatching', () => {
  const budget = new RequestBudget(1);
  const productionAdapter = subscriptionModel('gpt-6-luna', budget);
  const injectedAdapter = subscriptionModel('gpt-6-luna', budget, async () => ({}));
  expect(isTrustedSubscriptionModel(productionAdapter)).toBe(true);
  expect(isTrustedSubscriptionModel(injectedAdapter)).toBe(false);
  expect(budget.used).toBe(0);
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
      AbortController,
      setInterval,
      clearInterval,
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
