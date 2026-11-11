import type { RequestBudget } from './safety';

/** Each case owns a fresh host/session; only campaign-wide safety failures stop later cases. */
export async function* campaignReports<T, R extends { outcome: string }>(
  tests: readonly T[],
  budget: RequestBudget,
  run: (test: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): AsyncGenerator<R> {
  for (const [index, test] of tests.entries()) {
    if (budget.used >= budget.cap || budget.interrupted || signal?.aborted === true) break;
    const report = await run(test, index);
    yield report;
    if (['provider-failure', 'infrastructure-failure'].includes(report.outcome)) break;
  }
}
