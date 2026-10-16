import type { Comparison, Distribution, ProfileRun } from './types.ts';

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

export function summarize(values: readonly number[]): Distribution {
  if (values.length === 0 || values.some((n) => !Number.isFinite(n) || n < 0))
    throw new Error('Expected nonempty, finite, nonnegative measurements');
  const sorted = [...values].sort((a, b) => a - b);
  const center = median(values);
  return {
    n: values.length,
    median: center,
    p95: sorted[Math.ceil(values.length * 0.95) - 1] ?? 0,
    mad: median(values.map((n) => Math.abs(n - center))),
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    lowSampleCount: values.length < 30,
  };
}

function bootstrap(before: readonly number[], after: readonly number[]): [number, number] {
  let seed = 0xabad1dea;
  const resample = (values: readonly number[]): number[] =>
    values.map(() => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return values[Math.floor((seed / 4294967296) * values.length)] ?? 0;
    });
  const deltas = Array.from(
    { length: 2000 },
    () => median(resample(after)) - median(resample(before)),
  ).sort((a, b) => a - b);
  return [deltas[49] ?? 0, deltas[1949] ?? 0];
}

export function canonical(value: Record<string, string | number | boolean>): string {
  return JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

function runProblems(run: ProfileRun): string[] {
  const reasons: string[] = [];
  if (run.status !== 'complete' || !run.restored || run.errors.length > 0)
    reasons.push(`${run.id}: failed or unrestored run`);
  if (
    run.expectedScenarios.length === 0 ||
    new Set(run.expectedScenarios).size !== run.expectedScenarios.length
  )
    reasons.push(`${run.id}: invalid scenario roster`);
  for (const id of run.expectedScenarios) {
    if (!run.samples.some((sample) => sample.scenario === id))
      reasons.push(`${run.id}: missing ${id}`);
  }
  if (run.samples.some((s) => !run.expectedScenarios.includes(s.scenario)))
    reasons.push(`${run.id}: unexpected scenario`);
  return reasons;
}

function incompatibilities(before: ProfileRun, after: ProfileRun): string[] {
  const reasons = [...runProblems(before), ...runProblems(after)];
  for (const key of new Set([...Object.keys(before.identity), ...Object.keys(after.identity)])) {
    if (before.identity[key] !== after.identity[key]) reasons.push(`Different ${key}`);
  }
  if (JSON.stringify(before.expectedScenarios) !== JSON.stringify(after.expectedScenarios))
    reasons.push('Different scenario roster');
  return reasons;
}

function compareScenario(
  scenario: string,
  before: ProfileRun,
  after: ProfileRun,
): Comparison['scenarios'][number] {
  const values = (run: ProfileRun): number[] =>
    run.samples.filter((s) => s.scenario === scenario).map((s) => s.durationMs);
  const a = summarize(values(before));
  const b = summarize(values(after));
  const intervalMs = bootstrap(values(before), values(after));
  const practicalMarginMs = Math.max(5, a.median * 0.1);
  let verdict: Comparison['scenarios'][number]['verdict'] = 'inconclusive';
  if (Math.min(a.n, b.n) >= 10) {
    if (intervalMs[0] > practicalMarginMs) verdict = 'regression';
    else if (intervalMs[1] < -practicalMarginMs) verdict = 'improvement';
    else if (intervalMs[0] >= -practicalMarginMs && intervalMs[1] <= practicalMarginMs)
      verdict = 'no-material-difference';
  }
  return {
    scenario,
    before: a,
    after: b,
    deltaMs: b.median - a.median,
    deltaPercent: a.median === 0 ? null : (b.median / a.median - 1) * 100,
    intervalMs,
    practicalMarginMs,
    verdict,
  };
}

export function compareRuns(before: ProfileRun, after: ProfileRun): Comparison {
  const reasons = incompatibilities(before, after);
  for (const id of before.expectedScenarios) {
    const facts = [...before.samples, ...after.samples]
      .filter((s) => s.scenario === id)
      .map((s) => canonical(s.facts));
    if (new Set(facts).size > 1) reasons.push(`Different completed work: ${id}`);
  }
  return {
    compatible: reasons.length === 0,
    reasons,
    scenarios:
      reasons.length === 0
        ? before.expectedScenarios.map((id) => compareScenario(id, before, after))
        : [],
  };
}
