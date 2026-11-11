import { expect, it } from 'vitest';
import { campaignReports } from './command-live/campaign';
import { failureOutcome } from './command-live/harness';
import { RequestBudget, guardRoute, validateOptions } from './command-live/safety';

async function collect(outcomes: readonly string[], cap = 10) {
  const budget = new RequestBudget(cap);
  const visited: number[] = [];
  const reports: Array<{ outcome: string }> = [];
  for await (const report of campaignReports(outcomes, budget, async (outcome, index) => {
    visited.push(index);
    budget.dispatch();
    return { outcome };
  }))
    reports.push(report);
  return { visited, reports, budget };
}
it('continues independent cases after a local incomplete oracle result and retains the failed status', async () => {
  const result = await collect(['incomplete', 'passed']);
  expect(result.visited).toEqual([0, 1]);
  expect(result.reports.map((report) => report.outcome)).toEqual(['incomplete', 'passed']);
  expect(result.reports.every((report) => report.outcome === 'passed')).toBe(false);
});
it.each(['provider-failure', 'infrastructure-failure'])(
  'stops after %s without dispatching the next case',
  async (failure) => {
    const result = await collect([failure, 'passed']);
    expect(result.visited).toEqual([0]);
    expect(result.reports).toEqual([{ outcome: failure }]);
  },
);
it('enforces the shared physical request cap even after local incomplete', async () => {
  const result = await collect(['incomplete', 'passed'], 1);
  expect(result.visited).toEqual([0]);
  expect(result.budget.used).toBe(1);
});
it('stops on explicit abort, thrown infrastructure failure and an interrupted budget', async () => {
  const budget = new RequestBudget(3);
  const controller = new AbortController();
  const visited: number[] = [];
  for await (const report of campaignReports(
    [0, 1],
    budget,
    async (_test, index) => {
      visited.push(index);
      controller.abort();
      return { outcome: 'incomplete' };
    },
    controller.signal,
  )) {
    expect(report.outcome).toBe('incomplete');
  }
  expect(visited).toEqual([0]);
  budget.interrupted = true;
  for await (const report of campaignReports([0], budget, async () => {
    throw new Error('Must not run');
  })) {
    throw new Error(`Must not yield: ${JSON.stringify(report)}`);
  }
  budget.interrupted = false;
  await expect(async () => {
    for await (const report of campaignReports([0, 1], budget, async () => {
      throw new Error('Infrastructure failure');
    })) {
      throw new Error(`Must not yield: ${JSON.stringify(report)}`);
    }
  }).rejects.toThrow('Infrastructure failure');
});
it('continuation retains the explicitly selected free route without a paid fallback', async () => {
  const options = validateOptions({
    provider: 'openrouter',
    model: 'selected:free',
    allowPaid: false,
    maxRequests: 2,
  });
  const budget = new RequestBudget(2);
  const routes: Array<Record<string, unknown>> = [];
  for await (const report of campaignReports(['incomplete', 'passed'], budget, async (outcome) => {
    routes.push(guardRoute(options, { model: options.model }));
    budget.dispatch();
    return { outcome };
  })) {
    expect(['incomplete', 'passed']).toContain(report.outcome);
  }
  expect(routes).toEqual(
    Array.from({ length: 2 }, () => ({
      model: 'selected:free',
      provider: {
        require_parameters: true,
        allow_fallbacks: false,
        max_price: { prompt: 0, completion: 0, request: 0 },
      },
    })),
  );
});

it('never hides a provider failure behind a simultaneous incomplete correspondence oracle', () => {
  expect(
    failureOutcome(['preservation:task-correspondence', 'provider-failure'], new RequestBudget(5), {
      status: { kind: 'error', message: 'Provider unavailable' },
    }),
  ).toBe('provider-failure');
});
