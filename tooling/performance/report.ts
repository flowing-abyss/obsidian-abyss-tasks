import { summarize } from './statistics.ts';
import { fixtureScenarioProblem, type Comparison, type ProfileRun, type Sample } from './types.ts';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v: unknown) => typeof v === 'string');
}
function scalars(value: unknown): value is Record<string, string | number | boolean> {
  return (
    record(value) &&
    Object.values(value).every(
      (v) =>
        typeof v === 'string' ||
        typeof v === 'boolean' ||
        (typeof v === 'number' && Number.isFinite(v)),
    )
  );
}
function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function sample(value: unknown): value is Sample {
  if (!record(value)) return false;
  return (
    typeof value['scenario'] === 'string' &&
    ['iteration', 'durationMs', 'maxFrameGapMs', 'domNodes'].every((key) =>
      nonnegative(value[key]),
    ) &&
    Number.isInteger(value['iteration']) &&
    (value['longTasks'] === null || nonnegative(value['longTasks'])) &&
    (value['longTaskMs'] === null || nonnegative(value['longTaskMs'])) &&
    scalars(value['facts'])
  );
}

function metadata(value: Record<string, unknown>): boolean {
  return (
    value['schemaVersion'] === 1 &&
    ['id', 'createdAt'].every((key) => typeof value[key] === 'string') &&
    ['complete', 'failed'].includes(String(value['status'])) &&
    typeof value['restored'] === 'boolean' &&
    scalars(value['identity']) &&
    ['expectedScenarios', 'diagnostics', 'errors'].every((key) => strings(value[key]))
  );
}

export function parseRun(json: string): ProfileRun {
  const value: unknown = JSON.parse(json);
  if (
    !record(value) ||
    !metadata(value) ||
    !Array.isArray(value['samples']) ||
    !value['samples'].every(sample)
  )
    throw new Error('Invalid profile result schema (expected version 1)');
  const build = value['build'];
  if (
    !record(build) ||
    typeof build['commit'] !== 'string' ||
    typeof build['dirty'] !== 'boolean' ||
    typeof build['sha256'] !== 'string'
  )
    throw new Error('Invalid build identity');
  const run = value as unknown as ProfileRun;
  const problem = fixtureScenarioProblem(run);
  if (problem !== undefined) throw new Error(problem);
  return run;
}

function escape(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('|', '&#124;')
    .replaceAll('\n', ' ');
}

export function renderReport(run: ProfileRun): string {
  const lines = [
    `# Performance: ${escape(run.id)}`,
    '',
    `Status: **${run.status}**. Restoration: **${run.restored ? 'verified' : 'not verified'}**.`,
    '',
    `Build: \`${run.build.commit}\` (${run.build.dirty ? 'dirty' : 'clean'}), SHA256 \`${run.build.sha256}\`.`,
    '',
    'Wall times below exclude the separate CPU/trace diagnostic pass. Startup is a plugin restart in an already-running host.',
    '',
    '| Scenario | N | Median ms | p95 ms | MAD ms | Min–max ms | Max long task total ms | Max frame gap ms | Max DOM nodes |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const id of run.expectedScenarios) {
    const samples = run.samples.filter((s) => s.scenario === id);
    if (samples.length === 0) {
      lines.push(`| ${escape(id)} | 0 | missing | | | | | | |`);
      continue;
    }
    const d = summarize(samples.map((s) => s.durationMs));
    const long = samples.flatMap((s) => (s.longTaskMs === null ? [] : [s.longTaskMs]));
    lines.push(
      `| ${escape(id)} | ${d.n} | ${d.median.toFixed(2)} | ${d.p95.toFixed(2)}${d.lowSampleCount ? '*' : ''} | ${d.mad.toFixed(2)} | ${d.min.toFixed(2)}–${d.max.toFixed(2)} | ${long.length === 0 ? 'unsupported' : Math.max(...long).toFixed(2)} | ${Math.max(...samples.map((s) => s.maxFrameGapMs)).toFixed(2)} | ${Math.max(...samples.map((s) => s.domNodes))} |`,
    );
  }
  lines.push(
    '',
    '*Fewer than 30 observations: p95 is descriptive and unstable. Frame gaps and long tasks cover the renderer; they are not exclusive plugin attribution. No forced GC is used in timed runs.',
    '',
    '## Identity',
    '',
    ...Object.entries(run.identity).map(
      ([key, value]) => `- ${escape(key)}: ${escape(String(value))}`,
    ),
    '',
    '## Diagnostics',
    '',
    ...run.diagnostics.map((d) => `- ${escape(d)}`),
  );
  if (run.errors.length > 0)
    lines.push('', '## Errors', '', ...run.errors.map((e) => `- ${escape(e)}`));
  return `${lines.join('\n')}\n`;
}

export function renderComparison(result: Comparison): string {
  if (!result.compatible) {
    const reasons = result.reasons.map((r) => `- ${escape(r)}`).join('\n');
    return `# Incompatible runs\n\n${reasons}\n`;
  }
  return [
    '# Performance comparison',
    '',
    'Exploratory, unadjusted 95% bootstrap intervals of the median difference (candidate − baseline). Practical margin: max(5 ms, 10% of baseline). Fewer than 10 samples cannot produce a verdict; repeat apparent regressions in interleaved A/B runs.',
    '',
    '| Scenario | Δ ms | Δ % | 95% interval ms | Verdict |',
    '| --- | ---: | ---: | --- | --- |',
    ...result.scenarios.map(
      (s) =>
        `| ${escape(s.scenario)} | ${s.deltaMs.toFixed(2)} | ${s.deltaPercent?.toFixed(1) ?? 'n/a'} | ${s.intervalMs.map((n) => n.toFixed(2)).join(' … ')} | ${s.verdict} |`,
    ),
    '',
  ].join('\n');
}
