import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { useRealMoment } from '../helpers';
import { campaignReports } from './campaign';
import { canonicalModel } from './controls';
import { corpus, intentDiagnostics, selectCases, unqualifiedTurns } from './corpus';
import {
  diagnosticOutcome,
  evaluationPolicyVersion,
  safeDiagnostic,
  summarizeCompletionRequests,
} from './diagnostics';
import { runCase, temporalContext, type CaseReport } from './harness';
import { sourceFingerprint } from './provenance';
import { readFreeCatalog } from './providerBoundary';
import { object, RequestBudget, RequestPacer, validateOptions, type EvalOptions } from './safety';
useRealMoment();
const nodeFetch: typeof fetch = window.fetch.bind(window);
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
async function metadata() {
  const paths = [
    'src/ai/commandPrompt.ts',
    'src/ai/commandTools.ts',
    'src/ai/commandModelSchema.ts',
    'src/ai/CommandAgent.ts',
    'test/command-live/preservation.ts',
    'test/command-live/sourceOracle.ts',
    'src/ai/commandSchemas.ts',
    'pnpm-lock.yaml',
    'package.json',
    'test/command-live/corpus.ts',
    'test/command-live/bilingual.ts',
    'test/command-live/fixtures.ts',
    'test/command-live/harness.ts',
    'test/command-live/oracles.ts',
    'test/command-live/safety.ts',
    'test/command-live/live.ts',
    'test/command-live/campaign.ts',
    'test/command-live/caseLifetime.ts',
    'test/command-live/provenance.ts',
    'test/helpers.ts',
    'test/support/publicApiHarness.ts',
    'test/support/commandSessionStorage.ts',
    'test/command-live/controls.ts',
    'test/command-live/diagnostics.ts',
    'test/command-live/providerBoundary.ts',
    'test/command-live/linkOracle.ts',
    'tooling/command-eval.mjs',
    'vitest.command-live.config.ts',
  ];
  const hashes = Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [path, digest(await readFile(path, 'utf8'))] as const),
    ),
  );
  return {
    evaluationPolicyVersion,
    commit: execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    diffHash: digest(
      execFileSync('/usr/bin/git', ['diff', '--binary'], {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
      }),
    ),
    hashes,
    sourceTree: await sourceFingerprint(resolve('src')),
    temporalContext,
    intentDiagnostics,
    packageVersions: object(
      object(JSON.parse(await readFile('package.json', 'utf8')))['dependencies'],
    ),
    lifecycleProfile: {
      addCreatedDate: false,
      addCompletionDate: false,
      taskPrefix: 'per-case; see report.behavior',
    },
  };
}
function envKey(provider: EvalOptions['provider']) {
  const names = {
    openrouter: 'OPENROUTER_API_KEY',
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    groq: 'GROQ_API_KEY',
    cerebras: 'CEREBRAS_API_KEY',
  };
  return provider === 'local' ? '' : process.env[names[provider]];
}
function list() {
  process.stdout.write(
    JSON.stringify(
      corpus.map((test) => ({
        ...(({ id, family, profile, split, unavailable, limitations }) => ({
          id,
          family,
          profile: profile ?? 'public-api',
          split,
          availability: unavailable ?? 'headless',
          limitations: limitations ?? [],
        }))(test),
        ...(test.bilingual === undefined ? {} : { bilingual: test.bilingual }),
        unqualifiedTurns: unqualifiedTurns(test),
      })),
      null,
      2,
    ),
  );
}
function summarize(reports: readonly CaseReport[]) {
  const generations = reports.reduce(
    (count, report) =>
      count + report.trace.filter((event) => event.kind === 'generation-input').length,
    0,
  );
  return {
    generations,
    liveOutcomes: reports
      .filter((report) => report.modelSource === 'live-provider')
      .map(({ id, outcome }) => ({ id, outcome })),
    localOutcomes: reports
      .filter((report) => report.modelSource === 'local-server')
      .map(({ id, bilingual, outcome }) => ({ id, bilingual, outcome })),
    scriptedOutcomes: reports
      .filter((report) => report.modelSource === 'scripted-control')
      .map(({ id, outcome }) => ({ id, outcome })),
    ...summarizeCompletionRequests(reports.flatMap((report) => report.trace)),
    families: Object.fromEntries(
      [...new Set(reports.map((report) => report.family))].map((family) => [
        family,
        reports
          .filter((report) => report.family === family)
          .map(({ id, outcome }) => ({ id, outcome })),
      ]),
    ),
  };
}
function makeModel(test: ReturnType<typeof selectCases>[number]) {
  return test.scripted === true ? canonicalModel() : undefined;
}
function catalogFor(
  tests: ReturnType<typeof selectCases>,
  options: EvalOptions,
  budget: RequestBudget,
) {
  return allScripted(tests)
    ? Promise.resolve({ checked: false, reason: 'offline-control' })
    : readFreeCatalog(options, budget, nodeFetch);
}
function spacing(options: EvalOptions): number {
  return options.provider === 'openrouter' && !options.allowPaid ? 3100 : 0;
}
function allScripted(tests: ReturnType<typeof selectCases>): boolean {
  return tests.every((test) => test.scripted === true);
}
function campaignOptions(input: Record<string, unknown>) {
  return validateOptions({
    provider: input['provider'] as EvalOptions['provider'],
    model: String(input['model']),
    maxRequests: Number(input['maxRequests']),
    allowPaid: input['allowPaid'] === true,
    ...(typeof input['localBaseURL'] === 'string' ? { localBaseURL: input['localBaseURL'] } : {}),
  });
}
async function campaign(input: Record<string, unknown>) {
  const options = campaignOptions(input);
  const selected = selectCases(String(input['cases'])),
    key = allScripted(selected) ? 'offline-control' : envKey(options.provider);
  if (key === undefined || (options.provider !== 'local' && key.trim() === ''))
    throw new Error('Missing explicitly selected provider environment credential.');
  const out = resolve(String(input['out']));
  await mkdir(out, { recursive: true });
  const pacer = new RequestPacer(
    spacing(options),
    () => performance.now(),
    async (ms) => {
      await new Promise<void>((done) => {
        window.setTimeout(done, ms);
      });
    },
  );
  const budget = new RequestBudget(options.maxRequests),
    reports: CaseReport[] = [];
  const manifest: Record<string, unknown> = {
    ...(await metadata()),
    selectedLiveModel: options.model,
    provider: options.provider,
    ...(options.provider === 'local'
      ? {
          localBaseURL: options.localBaseURL,
          transport:
            'Operator-configured numeric loopback Chat Completions; no credentials, catalog or redirects. The operator controls whether the server performs inference locally.',
        }
      : {}),
    allowPaid: options.allowPaid,
    maxRequests: options.maxRequests,
    freeRequestSpacingMs: spacing(options),
    cases: selected.map((test) => ({
      id: test.id,
      family: test.family,
      split: test.split,
      ...(test.bilingual === undefined ? {} : { bilingual: test.bilingual }),
      fixtureHash: digest(JSON.stringify(test)),
    })),
    started: new Date().toISOString(),
    outcome: 'incomplete',
  };
  const persist = async () => {
    await writeFile(
      resolve(out, 'manifest.json'),
      JSON.stringify(
        {
          ...manifest,
          physicalRequests: budget.used,
          summary: summarize(reports),
          reports: reports.map(
            ({ id, family, modelSource, outcome, physicalRequests, failure }) => ({
              id,
              family,
              modelSource,
              outcome,
              physicalRequests,
              failure,
            }),
          ),
        },
        null,
        2,
      ),
    );
  };
  try {
    await persist();
    manifest['catalog'] = await catalogFor(selected, options, budget);
    for await (const report of campaignReports(selected, budget, (test) =>
      runCase(
        test,
        { options, budget, key, fetch: nodeFetch, pace: () => pacer.wait() },
        async (value) => {
          await writeFile(resolve(out, `${test.id}.json`), JSON.stringify(value, null, 2));
        },
        makeModel(test),
      ),
    )) {
      reports.push(report);
      await persist();
    }
    manifest['outcome'] =
      reports.length === selected.length && reports.every((report) => report.outcome === 'passed')
        ? 'passed'
        : 'failed-or-incomplete';
  } catch (error) {
    const diagnostic = safeDiagnostic(error, { phase: 'campaign', code: 'evaluator-failure' });
    manifest['failure'] = diagnostic;
    manifest['outcome'] = diagnosticOutcome(diagnostic);
  } finally {
    manifest['finished'] = new Date().toISOString();
    manifest['unrun'] = selected
      .filter((test) => !reports.some((report) => report.id === test.id))
      .map((test) => test.id);
    await persist();
  }
  process.stdout.write(
    `Command evaluation: ${String(manifest['outcome'])}; ${reports.length}/${selected.length} cases; ${budget.used} physical requests. Reports: ${out}\n`,
  );
  return manifest['outcome'];
}
it('runs explicitly selected synthetic command evaluations', async () => {
  const raw = process.env['COMMAND_EVAL_OPTIONS'];
  if (raw === undefined)
    throw new Error('Use pnpm command:eval; live evaluation requires explicit configuration.');
  const input = object(JSON.parse(raw));
  if (input['list'] === true) {
    list();
    return;
  }
  expect(await campaign(input), 'See sanitized outcome reports.').toBe('passed');
});
