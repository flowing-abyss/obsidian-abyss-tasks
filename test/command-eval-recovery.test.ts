import { expect, it } from 'vitest';
import { campaignReports } from './command-live/campaign';
import type { EvalCase } from './command-live/corpus';
import {
  classifyCompletionRecovery,
  summarizeCompletionRequests,
} from './command-live/diagnostics';
import { type EvalRuntime } from './command-live/harness';
import { RequestBudget } from './command-live/safety';
import { runScriptedCase as runCase } from './command-live/scriptedCase';
import { expectDefined } from './helpers';

const root = (title: string) => ({ markdownTitle: title, children: [], comments: [] });
function fixture(save = false): EvalCase {
  return {
    id: 'recovery-control',
    family: 'controls',
    split: 'development',
    files: { 'a.md': '# Inbox\n', 'control.md': 'unchanged\r\n' },
    turns: [
      { text: 'Draft Root.', expect: { status: 'ready', trees: [root('Root')] } },
      ...(save
        ? [{ text: 'Save it.', expect: { status: 'saved' as const, trees: [root('Root')] } }]
        : []),
    ],
  };
}
function completion(name: string, args: unknown): Response {
  return new Response(
    JSON.stringify({
      id: 'synthetic',
      object: 'chat.completion',
      created: 0,
      model: 'synthetic',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call', type: 'function', function: { name, arguments: JSON.stringify(args) } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }),
    { headers: { 'content-type': 'application/json' } },
  );
}
function retryable(): Response {
  return new Response(JSON.stringify({ error: { message: 'PRIVATE', code: 503 } }), {
    status: 503,
    headers: { 'content-type': 'application/json' },
  });
}
function script(title = 'Root'): Array<() => Response> {
  return [
    retryable,
    () => completion('create_task', { tree: { markdownTitle: title } }),
    () => completion('finish', { state: 'ready', message: 'Prepared.' }),
    () => completion('interpret', { intent: 'confirm', approval: 'Save it.' }),
  ];
}
function runtime(responses = script(), cap = 20): EvalRuntime {
  return {
    options: {
      provider: 'openrouter',
      model: 'synthetic:free',
      allowPaid: false,
      maxRequests: cap,
    },
    budget: new RequestBudget(cap),
    key: 'synthetic',
    fetch: async () => expectDefined(responses.shift())(),
  };
}
it('accepts bounded HTTP recovery only after real SDK output, exact preview and settled readback', async () => {
  const report = await runCase(fixture(), runtime(), async () => {});
  expect(report.outcome, JSON.stringify(report.turns.map((turn) => turn.failures))).toBe('passed');
  expect(report).toMatchObject({
    evaluationPolicyVersion: 'turn-generation-recovery-v2',
    physicalRequests: 3,
    cleanup: 'settled',
  });
  expect(report.turns[0]?.providerDiagnostics).toMatchObject({
    recovered: [
      {
        turn: 1,
        generation: 1,
        attempt: 1,
        request: 1,
        diagnostic: { phase: 'completion-response', code: 'unavailable' },
        recoveredBy: { request: 2, attempt: 2 },
      },
    ],
    unrecovered: [],
  });
  expect(report.turns[0]).toMatchObject({ writeCount: 0, complete: true, failures: [] });
  expect(summarizeCompletionRequests(report.trace)).toMatchObject({
    providerCompletionRequests: 3,
    knownTokens: 10,
    unknownUsageRequests: 1,
    unknownCostRequests: 3,
  });
  expect(JSON.stringify(report)).not.toContain('PRIVATE');
});
it('does not poison a later clean turn with an earlier recovered HTTP error', async () => {
  const report = await runCase(fixture(true), runtime(), async () => {});
  expect(report.outcome, JSON.stringify(report.turns.map((turn) => turn.failures))).toBe('passed');
  expect(report.turns).toHaveLength(2);
  expect(report.turns[1]).toMatchObject({ status: 'saved', writeCount: 1, failures: [] });
  expect(report.physicalRequests).toBe(4);
});
it('retains independent wrong-task failure after successful provider recovery', async () => {
  const report = await runCase(fixture(), runtime(script('Wrong')), async () => {});
  expect(report.outcome).toBe('semantic-failure');
  expect(report.turns[0]?.failures.length).toBeGreaterThan(0);
  expect(report.turns[0]?.failures).not.toContain('provider-failure');
  expect(report.turns[0]?.writeCount).toBe(0);
});
it('continues independent real-harness cases after recovered provider errors', async () => {
  const input = runtime([...script().slice(0, 3), ...script().slice(0, 3)]);
  const reports = [];
  for await (const report of campaignReports([fixture(), fixture()], input.budget, (test) =>
    runCase(test, input, async () => {}),
  ))
    reports.push(report);
  expect(reports.map((report) => report.outcome)).toEqual(['passed', 'passed']);
  expect(input.budget.used).toBe(6);
});

it('retains repair-limit agent failure after transport recovered and stops only that pipeline', async () => {
  const invalid = () => completion('create_task', { wrong: 'PRIVATE' });
  const input = runtime([retryable, invalid, invalid, invalid]);
  const report = await runCase(fixture(true), input, async () => {});
  expect(report.outcome).toBe('agent-failure');
  expect(report.turns).toHaveLength(1);
  expect(report.turns[0]).toMatchObject({ status: 'error', writeCount: 0 });
  expect(report.turns[0]?.failures).toContain('status:error:expected:ready');
  expect(report.turns[0]?.providerDiagnostics.recovered).toHaveLength(1);
  expect(report.turns[0]?.providerDiagnostics.unrecovered).toEqual([]);
});
it.each(['http', 'fetch', 'body', 'envelope', 'json', 'shape'] as const)(
  'retains unrecovered %s failures even for expected-error fixtures and stops the actual campaign',
  async (kind) => {
    const input = runtime();
    input.fetch = async () => {
      if (kind === 'fetch') throw Error('PRIVATE');
      if (kind === 'http') return retryable();
      if (kind === 'body') {
        const response = new Response('');
        response.arrayBuffer = async () => {
          throw Error('PRIVATE');
        };
        return response;
      }
      let body = '{}';
      if (kind === 'envelope') body = JSON.stringify({ error: { code: 429, message: 'PRIVATE' } });
      if (kind === 'json') body = '{PRIVATE';
      return new Response(body, { headers: { 'content-type': 'application/json' } });
    };
    const test = fixture();
    test.turns = [{ text: 'Draft Root.', expect: { status: 'error' } }];
    const reports = [];
    for await (const report of campaignReports([test, test], input.budget, (item) =>
      runCase(item, input, async () => {}),
    ))
      reports.push(report);
    expect(reports).toHaveLength(1);
    const report = expectDefined(reports[0]);
    expect(report.outcome).toBe('provider-failure');
    expect(report.turns[0]?.providerDiagnostics.unrecovered.length).toBeGreaterThan(0);
    expect(report.turns[0]?.providerDiagnostics.recovered).toEqual([]);
    expect(report.physicalRequests).toBeGreaterThan(0);
    expect(summarizeCompletionRequests(report.trace).providerCompletionRequests).toBe(
      report.physicalRequests,
    );
    expect(JSON.stringify(report)).not.toContain('PRIVATE');
  },
);
it('retains budget interruption during recovery without dispatching past the cap or passing expected error', async () => {
  const input = runtime([retryable], 1);
  const test = fixture();
  test.turns = [{ text: 'Draft Root.', expect: { status: 'error' } }];
  const report = await runCase(test, input, async () => {});
  expect(report.outcome).toBe('incomplete');
  expect(report.turns[0]?.failures).toContain('request-budget');
  expect(report.physicalRequests).toBe(1);
  expect(input.budget.interrupted).toBe(true);
  expect(summarizeCompletionRequests(report.trace).unknownUsageRequests).toBe(1);
});
it('accepts exact-cap completed recovery and leaves the remaining campaign cases unrun', async () => {
  const input = runtime(script(), 3);
  const reports = [];
  for await (const report of campaignReports([fixture(), fixture()], input.budget, (test) =>
    runCase(test, input, async () => {}),
  ))
    reports.push(report);
  expect(reports.map((report) => report.outcome)).toEqual(['passed']);
  expect(input.budget.used).toBe(3);
  expect(input.budget.interrupted).toBe(false);
});
function recoveryEvents(): Array<{
  sequence: number;
  kind: string;
  data: Record<string, unknown>;
}> {
  const identity = { turn: 1, generation: 1, attempt: 1 };
  return [
    { kind: 'generation-input', data: identity },
    { kind: 'http-dispatch', data: { request: 1 } },
    { kind: 'http', data: { request: 1, status: 503, providerError: false } },
    { kind: 'generation-rejected', data: identity },
    { kind: 'generation-input', data: { ...identity, attempt: 2 } },
    { kind: 'http-dispatch', data: { request: 2 } },
    { kind: 'http', data: { request: 2, status: 200, providerError: false } },
    { kind: 'generation-output', data: { ...identity, attempt: 2 } },
  ].map((event, index) => ({ ...event, sequence: index + 1 }));
}
it.each([
  'no-output',
  'other-turn',
  'other-generation',
  'unmatched-output',
  'missing-failed-dispatch',
  'missing-success-dispatch',
  'error-envelope',
  'missing-status',
  'missing-success-request',
] as const)('does not infer recovery from %s sequence evidence', (kind) => {
  let events = recoveryEvents();
  if (kind === 'no-output') events = events.filter((event) => event.kind !== 'generation-output');
  const missingDispatch: Record<string, number | undefined> = {
    'missing-failed-dispatch': 2,
    'missing-success-dispatch': 6,
  };
  events = events.filter((event) => event.sequence !== missingDispatch[kind]);
  if (kind === 'other-turn' || kind === 'other-generation' || kind === 'unmatched-output') {
    const start = kind === 'unmatched-output' ? 8 : 5;
    events = events.map((event) =>
      event.sequence < start
        ? event
        : {
            ...event,
            data: { ...event.data, ...(kind === 'other-turn' ? { turn: 2 } : { generation: 2 }) },
          },
    );
  }
  if (kind === 'error-envelope')
    events = events.map((event) =>
      event.sequence === 7
        ? { ...event, data: { request: 2, status: 200, providerError: true } }
        : event,
    );
  if (kind === 'missing-status')
    events = events.map((event) =>
      event.sequence === 7 ? { ...event, data: { request: 2, providerError: false } } : event,
    );
  if (kind === 'missing-success-request')
    events = events.map((event) =>
      event.sequence === 6 || event.sequence === 7
        ? { ...event, data: { status: 200, providerError: false } }
        : event,
    );
  const diagnostics = classifyCompletionRecovery(events);
  expect(diagnostics.recovered).toEqual([]);
  expect(diagnostics.unrecovered.length).toBeGreaterThan(0);
});

it('does not recover a failed dispatch and response with both physical request IDs absent', () => {
  const events = recoveryEvents().map((event) =>
    event.sequence === 2 || event.sequence === 3
      ? { ...event, data: { status: 503, providerError: false } }
      : event,
  );
  const diagnostics = classifyCompletionRecovery(events);
  expect(diagnostics.recovered).toEqual([]);
  expect(diagnostics.unrecovered).toMatchObject([
    { turn: 1, generation: 1, attempt: 1, sequence: 3, diagnostic: { status: 503 } },
  ]);
});

it('classifies the real Cerebras HTTP400 parser retry as recovered with exact requested metadata', async () => {
  const responses = script();
  responses[0] = () =>
    new Response(
      JSON.stringify({
        error: { type: 'generation_error', code: 'parser_error', failed_generation: 'PRIVATE' },
      }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  responses[1] = () =>
    completion('create_task', {
      tree: {
        markdownTitle: 'Root',
        initial: {
          scheduled: { type: 'set', value: '2026-11-11' },
          time: { type: 'set', value: '10:00' },
          recurrence: { type: 'set', value: 'every week on Wednesday' },
        },
      },
    });
  const input = runtime(responses);
  input.options = { ...input.options, provider: 'cerebras', model: 'synthetic', allowPaid: true };
  const test = fixture();
  test.turns = [
    {
      text: 'Draft Root tomorrow at 10 every Wednesday.',
      expect: {
        status: 'ready',
        trees: [
          {
            ...root('Root'),
            dates: { scheduled: '2026-11-11' },
            time: '10:00',
            recurrence: 'every week on Wednesday',
          },
        ],
      },
    },
  ];
  const report = await runCase(test, input, async () => {});
  expect(report.outcome, JSON.stringify(report.turns.map((turn) => turn.failures))).toBe('passed');
  expect(report.physicalRequests).toBe(3);
  expect(report.turns[0]?.providerDiagnostics).toMatchObject({
    recovered: [{ diagnostic: { status: 400 } }],
    unrecovered: [],
  });
  expect(report.turns[0]?.writeCount).toBe(0);
  expect(JSON.stringify(report)).not.toContain('PRIVATE');
  expect(JSON.stringify(report)).not.toContain('failed_generation');
});
it('fails closed on a later abort-ignoring physical request after recovery and rejects its late save', async () => {
  const input = runtime(script().slice(0, 2));
  input.limits = { setupMs: 1000, turnMs: 100, readbackMs: 100, cleanupMs: 30 };
  const normalFetch = input.fetch;
  let release: ((response: Response) => void) | undefined;
  input.fetch = async (...args) =>
    input.budget.used < 3
      ? normalFetch(...args)
      : new Promise<Response>((resolve) => {
          release = resolve;
        });
  const persisted: string[] = [];
  const report = await runCase(fixture(), input, async (value) => {
    persisted.push(JSON.stringify(value));
  });
  expect(report).toMatchObject({
    outcome: 'infrastructure-failure',
    failure: 'phase-timeout:turn',
    cleanup: 'unsettled',
    physicalRequests: 3,
  });
  const final = persisted[persisted.length - 1];
  expectDefined(release)(completion('interpret', { intent: 'confirm', approval: 'Save it.' }));
  await new Promise<void>((resolve) => window.setTimeout(resolve, 20));
  expect(persisted[persisted.length - 1]).toBe(final);
  expect(report.trace.filter((event) => event.kind === 'write-dispatch')).toEqual([]);
  expect(() => {
    input.budget.dispatch();
  }).toThrow('request-budget-closed');
});
it('retains readback failure after recovered generation and never accepts the cached preview alone', async () => {
  const input = runtime();
  input.limits = { setupMs: 1000, turnMs: 1000, readbackMs: 30, cleanupMs: 30 };
  let finished = false;
  const normalFetch = input.fetch;
  input.fetch = async (...args) => {
    const response = await normalFetch(...args);
    if (input.budget.used === 3) finished = true;
    return response;
  };
  input.configureApi = (api) => ({
    ...api,
    tasks: {
      ...api.tasks,
      list: async (...args) => (finished ? new Promise(() => {}) : api.tasks.list(...args)),
    },
  });
  const report = await runCase(fixture(), input, async () => {});
  expect(report).toMatchObject({
    outcome: 'infrastructure-failure',
    failure: 'phase-timeout:readback',
    cleanup: 'unsettled',
    physicalRequests: 3,
  });
  expect(report.turns).toEqual([]);
});
it('retains checkpoint failure after a recovered provider attempt without another dispatch', async () => {
  const input = runtime();
  await expect(
    runCase(fixture(), input, async (report) => {
      if (report.trace.some((event) => event.kind === 'generation-output')) throw Error('PRIVATE');
    }),
  ).rejects.toThrow('checkpoint-write-failed');
  expect(input.budget.used).toBe(2);
});
