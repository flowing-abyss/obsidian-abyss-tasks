import { MockLanguageModelV4 } from 'ai/test';
import { expect, it } from 'vitest';
import { submittedMessage } from './command-live/controls';
import { selectCases } from './command-live/corpus';
import type { CaseReport, EvalRuntime } from './command-live/harness';
import { RequestBudget } from './command-live/safety';
import { runScriptedCase as runCase } from './command-live/scriptedCase';
import { deferred, expectDefined } from './helpers';
const limits = { setupMs: 1000, turnMs: 40, readbackMs: 40, cleanupMs: 40 };
function runtime(): EvalRuntime {
  return {
    options: { provider: 'openrouter', model: 'test:free', maxRequests: 2, allowPaid: false },
    budget: new RequestBudget(2),
    key: 'synthetic',
    fetch: async () => {
      throw new Error('No network');
    },
    limits,
  };
}
it('bounds an abort-ignoring model, checkpoints its pending phase and stops the shared campaign budget', async () => {
  const entered = deferred<void>();
  const persisted: CaseReport[] = [];
  const input = runtime();
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      entered.resolve();
      return new Promise(() => {});
    },
  });
  const pending = runCase(
    expectDefined(selectCases('047')[0]),
    input,
    async (report) => {
      persisted.push(structuredClone(report));
    },
    model,
  );
  await entered.promise;
  expect(persisted.some((report) => report.phase === 'generation')).toBe(true);
  const result = await Promise.race([
    pending,
    new Promise<'unbounded'>((resolve) =>
      window.setTimeout(() => {
        resolve('unbounded');
      }, 1000),
    ),
  ]);
  expect(result).not.toBe('unbounded');
  if (result === 'unbounded') return;
  expect(result.outcome).toBe('infrastructure-failure');
  expect(result.failure).toBe('phase-timeout:turn');
  expect(result.cleanup).toBe('unsettled');
  expect(result.physicalRequests).toBe(0);
  expect(() => {
    input.budget.dispatch();
  }).toThrow('request-budget-closed');
  expect(persisted[persisted.length - 1]?.finished).toBeDefined();
});

type Prompt = Parameters<MockLanguageModelV4['doGenerate']>[0]['prompt'];
function response(name: string, input: unknown) {
  return {
    content: [
      {
        type: 'tool-call' as const,
        toolCallId: 'call',
        toolName: name,
        input: JSON.stringify(input),
      },
    ],
    finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    },
    warnings: [],
  };
}
function readTask(prompt: Prompt) {
  const output = prompt
    .flatMap((message) => (message.role === 'tool' ? message.content : []))
    .find((part) => part.type === 'tool-result' && part.toolName === 'read');
  if (output?.type !== 'tool-result' || output.output.type !== 'json')
    throw new Error('Missing read');
  const value = output.output.value as { items: Array<{ target: string; revision: string }> };
  const node = expectDefined(value.items[0]);
  return { target: node.target, revision: node.revision };
}
function ordinaryModel() {
  let step = 0;
  return new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => {
      step++;
      if (step === 1)
        return response('expand', {
          capabilities: [
            'read',
            'task',
            'status',
            'note',
            'project',
            'link',
            'cleanup',
            'research',
          ],
        });
      if (step === 2) return response('read', { input: { kind: 'tasks', query: 'Root' } });
      if (step === 3) {
        const task = readTask(prompt);
        return response('status', { ...task, symbol: ' ' });
      }
      if (step === 4) return response('finish', { state: 'ready', message: 'Ready.' });
      if (step === 5)
        return response('interpret', {
          intent: 'confirm',
          approval: submittedMessage(prompt),
          research: false,
        });
      throw new Error('Unexpected generation');
    },
  });
}
it('retains the successful ordinary 047 reopen/save pipeline with ordered final checkpoints', async () => {
  const input = runtime();
  input.limits = { ...limits, turnMs: 1000 };
  const persisted: CaseReport[] = [];
  const writing = new Set<symbol>();
  const report = await runCase(
    expectDefined(selectCases('047')[0]),
    input,
    async (value) => {
      expect(writing.size).toBe(0);
      const write = Symbol();
      writing.add(write);
      await new Promise<void>((resolve) => window.setTimeout(resolve, 1));
      persisted.push(structuredClone(value));
      writing.delete(write);
    },
    ordinaryModel(),
  );
  expect(report.outcome).toBe('passed');
  expect(report.cleanup).toBe('settled');
  expect(report.turns[1]?.writeCount).toBe(1);
  expect(persisted[persisted.length - 1]).toEqual(report);
  const phases = persisted.map((value) => value.phase);
  for (const phase of [
    'case-start',
    'setup',
    'api-ready',
    'inventory',
    'session',
    'turn',
    'generation',
    'tool',
    'readback',
    'evaluation',
    'cleanup',
    'finished',
  ])
    expect(phases).toContain(phase);
  expect(persisted.map((value) => value.trace.length)).toEqual(
    [...persisted.map((value) => value.trace.length)].sort((a, b) => a - b),
  );
});
it.each(['exact', 'stale', 'malformed'] as const)(
  'handles %s reveal without fabricating native navigation or admitting writes',
  async (kind) => {
    let step = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        step++;
        if (step === 1)
          return response('expand', {
            capabilities: [
              'read',
              'task',
              'status',
              'note',
              'project',
              'link',
              'cleanup',
              'research',
            ],
          });
        if (step === 2) return response('read', { input: { kind: 'tasks', query: 'Root' } });
        if (step === 3) {
          const task = readTask(prompt);
          let reveal: unknown = task;
          if (kind === 'stale') reveal = { ...task, revision: 'wrong-revision' };
          if (kind === 'malformed') reveal = { target: 7, revision: null };
          return response('finish', { state: 'ready', message: 'Opening.', reveal });
        }
        return response('finish', {
          state: 'question',
          message: 'Which view should open this task?',
          blockingIssue: {
            kind: 'missing-information',
            detail: 'Native navigation is unavailable.',
          },
        });
      },
    });
    const input = runtime();
    input.limits = { ...limits, turnMs: 1000 };
    const report = await runCase(
      expectDefined(selectCases('047')[0]),
      input,
      async () => {},
      model,
    );
    expect(report.cleanup).toBe('settled');
    expect(report.physicalRequests).toBe(0);
    expect(report.turns[0]?.writeCount).toBe(0);
    expect(report.trace.filter((event) => event.kind === 'write-dispatch')).toEqual([]);
    const reveals = report.trace.filter((event) => event.kind === 'headless-reveal');
    if (kind === 'exact') {
      expect(report.outcome).toBe('incomplete');
      expect(report.limitations).toContain('native-ui-unavailable');
      expect(reveals).toHaveLength(1);
      expect(reveals[0]?.data).toMatchObject({
        accepted: false,
        limitation: 'native-ui-unavailable',
      });
    } else {
      expect(reveals).toEqual([]);
      expect(report.limitations).not.toContain('native-ui-unavailable');
    }
  },
);
it.each(['ready', 'inventory', 'readback'] as const)(
  'bounds abort-ignoring %s API work and retains its last phase',
  async (phase) => {
    const input = runtime();
    input.limits = { setupMs: 60, turnMs: 1000, readbackMs: 30, cleanupMs: 30 };
    let lists = 0;
    input.configureApi = (api) => ({
      ...api,
      ready: phase === 'ready' ? async () => new Promise(() => {}) : api.ready,
      tasks: {
        ...api.tasks,
        list: async (...args) => {
          lists++;
          if (phase === 'inventory' || (phase === 'readback' && lists >= 3))
            return new Promise(() => {});
          return api.tasks.list(...args);
        },
      },
    });
    const report = await runCase(
      expectDefined(selectCases('047')[0]),
      input,
      async () => {},
      ordinaryModel(),
    );
    expect(report.outcome).toBe('infrastructure-failure');
    expect(report.failure).toBe(`phase-timeout:${phase === 'readback' ? 'readback' : 'setup'}`);
    expect(report.interruptedPhase).toBe(phase === 'ready' ? 'api-ready' : phase);
    expect(report.cleanup).toBe('unsettled');
    expect(report.physicalRequests).toBe(0);
    expect(() => {
      input.budget.dispatch();
    }).toThrow('request-budget-closed');
  },
);
it('stops before model work when checkpoint writes fail and sanitizes the failure', async () => {
  let generations = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      generations++;
      throw new Error('Must not generate');
    },
  });
  const pending = runCase(
    expectDefined(selectCases('047')[0]),
    runtime(),
    async () => {
      throw new Error('PRIVATE path or credential');
    },
    model,
  );
  await expect(pending).rejects.toThrow('checkpoint-write-failed');
  await expect(pending).rejects.toMatchObject({
    diagnostic: { phase: 'campaign', code: 'checkpoint-write-failed' },
  });
  expect(generations).toBe(0);
});
it('bounds a noncooperative checkpoint writer without starting a model or another write', async () => {
  let writes = 0,
    generations = 0;
  const input = runtime();
  input.limits = { ...limits, setupMs: 30 };
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      generations++;
      throw new Error('Must not generate');
    },
  });
  await expect(
    runCase(
      expectDefined(selectCases('047')[0]),
      input,
      async () => {
        writes++;
        return new Promise(() => {});
      },
      model,
    ),
  ).rejects.toThrow('checkpoint-write-timeout');
  expect(writes).toBe(1);
  expect(generations).toBe(0);
});
it('retains a final checkpoint after a late abort-ignoring model completion without allowing writes', async () => {
  const gate = deferred<ReturnType<typeof response>>();
  const persisted: CaseReport[] = [];
  const model = new MockLanguageModelV4({ doGenerate: async () => gate.promise });
  const report = await runCase(
    expectDefined(selectCases('047')[0]),
    runtime(),
    async (value) => {
      persisted.push(structuredClone(value));
    },
    model,
  );
  const final = JSON.stringify(persisted[persisted.length - 1]);
  gate.resolve(
    response('expand', {
      capabilities: ['read', 'task', 'status', 'note', 'project', 'link', 'cleanup', 'research'],
    }),
  );
  await new Promise<void>((resolve) => window.setTimeout(resolve, 20));
  expect(JSON.stringify(persisted[persisted.length - 1])).toBe(final);
  expect(report.trace.filter((event) => event.kind === 'write-dispatch')).toEqual([]);
});

it('stops the actual campaign after a timed-out case whose work did not settle', async () => {
  const { campaignReports } = await import('./command-live/campaign');
  const input = runtime();
  const visited: string[] = [];
  const cases = [expectDefined(selectCases('047')[0]), expectDefined(selectCases('048')[0])];
  for await (const report of campaignReports(cases, input.budget, async (test) => {
    visited.push(test.id);
    return runCase(
      test,
      input,
      async () => {},
      new MockLanguageModelV4({ doGenerate: async () => new Promise(() => {}) }),
    );
  }))
    expect(report).toMatchObject({ outcome: 'infrastructure-failure', cleanup: 'unsettled' });
  expect(visited).toEqual(['047']);
});
it('counts and aborts an outstanding physical request without retry or leaking private diagnostics', async () => {
  const input = runtime();
  let aborted = false;
  input.fetch = async (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener(
        'abort',
        () => {
          aborted = true;
          reject(new Error('PRIVATE fetch details'));
        },
        { once: true },
      );
    });
  const report = await runCase(expectDefined(selectCases('047')[0]), input, async () => {});
  expect(aborted).toBe(true);
  expect(report).toMatchObject({
    outcome: 'infrastructure-failure',
    failure: 'phase-timeout:turn',
    cleanup: 'settled',
    physicalRequests: 1,
  });
  expect(JSON.stringify(report)).not.toContain('PRIVATE');
});
it('reports noncooperative physical request cleanup and retains its dispatched request count', async () => {
  const input = runtime();
  input.fetch = async () => new Promise(() => {});
  const report = await runCase(expectDefined(selectCases('047')[0]), input, async () => {});
  expect(report).toMatchObject({
    outcome: 'infrastructure-failure',
    failure: 'phase-timeout:turn',
    cleanup: 'unsettled',
    physicalRequests: 1,
  });
});

it('bounds stalled cleanup checkpoint IO within cleanup grace and stops the budget', async () => {
  const input = runtime();
  input.limits = { ...limits, turnMs: 1000 };
  let stalled = false;
  await expect(
    runCase(
      expectDefined(selectCases('047')[0]),
      input,
      async (report) => {
        if (report.phase === 'cleanup') {
          stalled = true;
          return new Promise(() => {});
        }
      },
      ordinaryModel(),
    ),
  ).rejects.toMatchObject({ diagnostic: { code: 'checkpoint-write-timeout' } });
  expect(stalled).toBe(true);
  expect(() => {
    input.budget.dispatch();
  }).toThrow('request-budget-closed');
});
