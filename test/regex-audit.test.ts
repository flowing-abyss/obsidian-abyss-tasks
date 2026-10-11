// @vitest-environment node
import { build } from 'esbuild';
import { ESLint } from 'eslint';
import { Platform } from 'obsidian';
import { describe, expect, it } from 'vitest';
import { collapseLinks, parseLinks, parseSourceReferences } from '../src/markdown/links';
import { parseRecurrenceRule } from '../src/tasks/domain/recurrence';
import { StatusCatalog } from '../src/tasks/domain/StatusCatalog';
import { parseLinkRanges } from '../src/tasks/domain/taskLineAtomicRanges';
import { parseTaskLineSourceModel } from '../src/tasks/domain/taskLineSourceModel';
import { TaskMarkdownCodec } from '../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { validateReviews } from '../tooling/regex-audit-policy.mjs';
import { auditConfig, runBoundedChild } from '../tooling/regex-audit.mjs';
import { medianFourfoldRatio, type RegexScenarioResult } from './support/regexRuntimeHarness';
import { CHILD_PROCESS_TIMEOUT_MS, LINTER_TIMEOUT_MS } from './support/timeouts';
const ROOT = new URL('..', import.meta.url).pathname;
const loadTimers = async () => {
  if (!Platform.isDesktop) throw new Error('Regex audit tests require a desktop runtime');
  return import('node:timers');
};
const { setTimeout, clearTimeout } = await loadTimers();

const finding = {
  file: 'src/example.ts',
  line: 2,
  column: 3,
  endLine: 2,
  endColumn: 12,
  ruleId: 'redos/no-vulnerable',
  messageId: 'vulnerable',
  message: 'quadratic',
  raw: '/a+b/',
  unproven: false,
};
const analyzer = { regexp: '3.3.1', redos: '4.5.0', options: { timeout: 1000, cache: false } };
const context = {
  sourceHashes: { 'src/example.ts': 'source' },
  guardHashes: { 'src/guard.ts': 'guard' },
  analyzer,
};
const review = {
  finding,
  sourceHash: 'source',
  guards: { 'src/guard.ts': 'guard' },
  analyzer,
  disposition: 'context-protected',
  reason: 'Public caller bounds the input.',
  tests: {
    accepting: ['accepts bounded input'],
    rejecting: ['rejects unbounded input'],
    performance: ['scales bounded input'],
  },
};

describe('exact regex review policy', () => {
  it('accepts an exact occurrence with independently bound source and guard evidence', () => {
    expect(validateReviews([finding], [review], context)).toEqual({
      reviewed: 1,
      unproven: 0,
      errors: [],
    });
  });
  it('rejects an unreviewed expression and a second occurrence', () => {
    expect(validateReviews([finding], [], context).errors.length).toBeGreaterThan(0);
    expect(
      validateReviews([finding, { ...finding, line: 3 }], [review], context).errors.length,
    ).toBeGreaterThan(0);
  });
  it('rejects changed diagnostic, pattern, flags and coordinates', () => {
    for (const changed of [
      { message: 'exponential' },
      { messageId: 'error' },
      { raw: '/a+b/i' },
      { column: 4 },
      { ruleId: 'regexp/no-super-linear-move' },
    ]) {
      expect(
        validateReviews([{ ...finding, ...changed }], [review], context).errors.length,
      ).toBeGreaterThan(0);
    }
  });
  it('checks source and guard drift independently', () => {
    expect(
      validateReviews([finding], [review], {
        ...context,
        sourceHashes: { 'src/example.ts': 'changed' },
      }).errors,
    ).toContainEqual(expect.stringContaining('source'));
    expect(
      validateReviews([finding], [review], {
        ...context,
        guardHashes: { 'src/guard.ts': 'changed' },
      }).errors,
    ).toContainEqual(expect.stringContaining('guard'));
    expect(
      validateReviews([finding], [review], { ...context, guardHashes: {} }).errors,
    ).toContainEqual(expect.stringContaining('guard'));
  });
  it('rejects duplicate findings, duplicate reviews and stale reviews', () => {
    expect(validateReviews([finding, finding], [review], context).errors.length).toBeGreaterThan(0);
    expect(validateReviews([finding], [review, review], context).errors.length).toBeGreaterThan(0);
    expect(validateReviews([], [review], context).errors).toContainEqual(
      expect.stringContaining('stale'),
    );
  });
  it('rejects analyzer version or options drift', () => {
    for (const changed of [
      { ...analyzer, redos: '4.6.0' },
      { ...analyzer, options: { timeout: 2000, cache: false } },
    ]) {
      expect(
        validateReviews([finding], [review], { ...context, analyzer: changed }).errors,
      ).toContainEqual(expect.stringContaining('analyzer'));
    }
  });
  it('requires reasons and named accepting, rejecting and performance tests', () => {
    for (const changed of [
      { reason: '' },
      { tests: { ...review.tests, accepting: [] } },
      { tests: { ...review.tests, rejecting: [] } },
      { tests: { ...review.tests, performance: [] } },
    ]) {
      expect(
        validateReviews([finding], [{ ...review, ...changed }], context).errors.length,
      ).toBeGreaterThan(0);
    }
  });
  it('keeps invalid, unsupported and timeout findings visibly unproven', () => {
    for (const message of ['invalid', 'unsupported', 'timeout']) {
      const unknown = { ...finding, message, messageId: 'error', unproven: true };
      expect(
        validateReviews([unknown], [{ ...review, finding: unknown }], context).errors.length,
      ).toBeGreaterThan(0);
      expect(
        validateReviews(
          [unknown],
          [{ ...review, finding: unknown, disposition: 'unproven' }],
          context,
        ),
      ).toEqual({ reviewed: 0, unproven: 1, errors: [] });
    }
  });
});

describe('real analyzer and bounded orchestration', () => {
  it(
    'reports a vulnerable literal, accepts a safe literal and exposes unsupported analysis',
    async () => {
      const lint = new ESLint({ overrideConfigFile: true, overrideConfig: auditConfig });
      const [vulnerable] = await lint.lintText('export const pattern = /^(a+)+$/;');
      expect(vulnerable?.messages.map(({ ruleId }) => ruleId)).toContain('redos/no-vulnerable');
      const [safe] = await lint.lintText('export const pattern = /^a+$/;');
      expect(safe?.messages).toEqual([]);
      const [unsupported] = await lint.lintText('export const pattern = /a/v;');
      expect(
        unsupported?.messages.some(
          ({ ruleId, message }) =>
            ruleId === 'redos/no-vulnerable' && message.includes('(invalid)'),
        ),
      ).toBe(true);
    },
    LINTER_TIMEOUT_MS,
  );
  it(
    'rejects duplicate and contradictory expressions through focused correctness rules',
    async () => {
      const lint = new ESLint({ cwd: ROOT });
      const [result] = await lint.lintText(
        'export const duplicate = /a|a/u; export const contradiction = /(?=a)(a|b)/u;',
        { filePath: `${ROOT}/tooling/regex-audit-policy.mjs` },
      );
      expect(result?.messages.map(({ ruleId }) => ruleId)).toEqual(
        expect.arrayContaining([
          'regexp/no-dupe-disjunctions',
          'regexp/no-contradiction-with-assertion',
        ]),
      );
    },
    LINTER_TIMEOUT_MS,
  );
  it(
    'kills an actually blocked child at the hard deadline',
    async () => {
      const start = performance.now();
      await expect(runBoundedChild(['-e', 'while (true) {}'], { deadlineMs: 300 })).rejects.toThrow(
        'deadline',
      );
      expect(performance.now() - start).toBeLessThan(3000);
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );
  it(
    'cancels a running child and handles a child exit failure',
    async () => {
      const abort = new AbortController();
      const timer = setTimeout(() => {
        abort.abort();
      }, 300);
      try {
        await expect(
          runBoundedChild(['-e', 'while (true) {}'], { signal: abort.signal }),
        ).rejects.toThrow('cancel');
      } finally {
        clearTimeout(timer);
      }
      await expect(
        runBoundedChild(['-e', 'process.stderr.write("fixture failure"); process.exit(7)']),
      ).rejects.toThrow('fixture failure');
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );
  it(
    'handles malformed output and never reuses child results',
    async () => {
      await expect(runBoundedChild(['-e', 'process.stdout.write("not JSON")'])).rejects.toThrow(
        'JSON',
      );
      await expect(
        runBoundedChild([
          '-e',
          'process.stdout.write("{}"); process.stderr.write("unexpected analyzer diagnostic")',
        ]),
      ).rejects.toThrow('unexpected analyzer diagnostic');
      const first = await runBoundedChild([
        '-e',
        'process.stdout.write(JSON.stringify({pid:process.pid}))',
      ]);
      const second = await runBoundedChild([
        '-e',
        'process.stdout.write(JSON.stringify({pid:process.pid}))',
      ]);
      expect(first).not.toEqual(second);
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );
});

const publicImports = `
import { collapseLinks, parseLinks, parseSourceReferences } from './src/markdown/links.ts';
import { parseLinkRanges } from './src/tasks/domain/taskLineAtomicRanges.ts';
import { parseTaskLineSourceModel } from './src/tasks/domain/taskLineSourceModel.ts';
import { parseRecurrenceRule } from './src/tasks/domain/recurrence.ts';
import { TaskMarkdownCodec } from './src/tasks/infrastructure/markdown/TaskMarkdownCodec.ts';
import { StatusCatalog } from './src/tasks/domain/StatusCatalog.ts';
import { cpuMilliseconds } from './test/support/cpuTime.ts';
const codec = new TaskMarkdownCodec(new StatusCatalog([]));
const location = {filePath:'probe.md',line:0};`;

async function publicGrowthScenario(
  input: string,
  operation: string,
): Promise<RegexScenarioResult> {
  const bundle = await build({
    stdin: {
      contents: `${publicImports}
    const sizes=[4000,16000];const inputs=sizes.map(n=>${input});
    const operation = input=>${operation};
    for(let warmup=0;warmup<2;warmup++) inputs.forEach(operation);
    const samples=[];
    for(let pair=0;pair<5;pair++) for(const index of [pair%2,1-pair%2]) {
      const start=cpuMilliseconds();let iterations=0,elapsedCpuMs=0;
      do { operation(inputs[index]);iterations++;elapsedCpuMs=cpuMilliseconds()-start; } while(elapsedCpuMs<8);
      samples.push({size:sizes[index],iterations,elapsedCpuMs,cpuMs:elapsedCpuMs/iterations});
    }
    process.stdout.write(JSON.stringify({samples,outputs:inputs.map(operation)}));`,
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    write: false,
  });
  const contents = bundle.outputFiles[0]?.text;
  if (contents === undefined) throw new Error('No public probe bundle');
  return (await runBoundedChild(['--input-type=commonjs', '-e', contents], {
    deadlineMs: 4000,
  })) as RegexScenarioResult;
}

describe('public caller evidence for reviewed diagnostics', () => {
  it('accepts closed Markdown links through all audited public paths', () => {
    expect(collapseLinks('[a](b)')).toBe('🌐 a');
    expect(parseLinks('[a](b)').map(({ raw }) => raw)).toEqual(['[a](b)']);
    expect(parseSourceReferences('![](b)').map(({ raw }) => raw)).toEqual(['[](b)']);
    expect(parseLinkRanges('[a](b)').map(({ raw }) => raw)).toEqual(['[a](b)']);
    expect(
      new TaskMarkdownCodec(new StatusCatalog([])).parseLine('- [ ] [a](b)', {
        filePath: 'probe.md',
        line: 0,
      })?.title,
    ).toBe('🌐 a');
  });
  it('rejects missing or escaped final Markdown closers through all audited public paths', () => {
    for (const input of ['[a](b', '[a](b\\)']) {
      expect(parseLinks(input)).toEqual([]);
      expect(parseSourceReferences(input)).toEqual([]);
      expect(parseLinkRanges(input)).toEqual([]);
    }
    expect(collapseLinks('[a](b')).toBe('a(b');
    expect(
      new TaskMarkdownCodec(new StatusCatalog([])).parseLine('- [ ] [a](b', {
        filePath: 'probe.md',
        line: 0,
      })?.title,
    ).toBe('a(b');
  });
  it(
    'bounds guarded missing-closer work through all audited public link paths',
    async () => {
      const result = await publicGrowthScenario(
        "'[a]('.repeat(n)",
        "JSON.stringify([collapseLinks(input),parseLinks(input).length,parseSourceReferences(input).length,parseLinkRanges(input).length,codec.parseLine('- [ ] '+input,location).title])",
      );
      expect(result.outputs).toEqual(
        [4000, 16000].map((n) => JSON.stringify(['a('.repeat(n), 0, 0, 0, 'a('.repeat(n)])),
      );
      expect(medianFourfoldRatio(result.samples)).toBeLessThan(8);
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );
  it('accepts annual recurrence after public whitespace normalization', () => {
    for (const gap of ['\n', '\r', '\u2028', '\u2029']) {
      expect(parseRecurrenceRule(`every January${gap}on 1st`)).toMatchObject({ type: 'valid' });
      expect(parseRecurrenceRule(`every year January${gap}on 1st`)).toMatchObject({
        type: 'valid',
      });
    }
  });
  it('rejects invalid annual clauses after public whitespace normalization', () => {
    expect(parseRecurrenceRule('every January on \n!')).toMatchObject({ type: 'invalid' });
    expect(parseRecurrenceRule('every year January on \u2028!')).toMatchObject({ type: 'invalid' });
  });
  it(
    'bounds normalized annual rejection work through the public parser',
    async () => {
      const result = await publicGrowthScenario(
        "['every '+ 'January on '.repeat(n)+'\\n!', 'every year '+ 'January on '.repeat(n)+'\\u2028!']",
        'JSON.stringify(input.map(rule=>parseRecurrenceRule(rule).type))',
      );
      expect(result.outputs).toEqual(['["invalid","invalid"]', '["invalid","invalid"]']);
      expect(medianFourfoldRatio(result.samples)).toBeLessThan(8);
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );
  it('accepts dependency carriers at whitespace and retains the exact authored suffix', () => {
    for (const [input, ids, suffix] of [
      ['- [ ] x ⛔ a,b   !', ['a', 'b'], ' !'],
      ['- [ ] x ⛔ a , b , c!', ['a', 'b'], ' , c!'],
    ] as const) {
      const parsed = parseTaskLineSourceModel(input);
      expect(parsed?.dependsOn).toEqual(ids);
      const carrier = parsed?.carriers.find(({ kind }) => kind === 'depends-on');
      expect(carrier?.from).toBe(8);
      if (carrier === undefined) throw new Error('Expected an accepted dependency carrier');
      expect(input.slice(carrier.to)).toBe(suffix);
      expect(parsed?.spans.map(({ from, to }) => input.slice(from, to)).join('')).toBe(input);
    }
  });
  it('rejects dependency carriers without an accepting whitespace or end boundary', () => {
    for (const input of ['- [ ] x ⛔ a,b!', '- [ ] x ⛔ a, !']) {
      const parsed = parseTaskLineSourceModel(input);
      expect(parsed?.dependsOn).toEqual([]);
      expect(parsed?.carriers.filter(({ kind }) => kind === 'depends-on')).toEqual([]);
      expect(parsed?.spans.map(({ from, to }) => input.slice(from, to)).join('')).toBe(input);
    }
  });
  it.each([
    ["'- [ ] x ⛔ a,b'+' '.repeat(n)+'!'", (n: number) => [2, 'x !', n + 12]],
    ["'- [ ] x ⛔ a'+',b   '.repeat(n)+'!'", (n: number) => [n + 1, 'x !', 5 * n + 10]],
    ["'- [ ] x ⛔ a'+',b'.repeat(n)+'!'", () => [0, 'x', null]],
    ["'- [ ] x ⛔ a'+' , b'.repeat(n)+'!'", (n: number) => [n, 'x , b!', 4 * n + 7]],
    ["'- [ ] x ⛔ a,b'+' '.repeat(n)+',c!'", (n: number) => [2, 'x ,c!', n + 12]],
  ])(
    'bounds dependency public work with accepting or rejecting suffixes: %s',
    async (input, expected) => {
      const result = await publicGrowthScenario(
        input,
        "(() => {const p=parseTaskLineSourceModel(input);return JSON.stringify([p.dependsOn.length,p.markdownTitle,p.carriers.find(c=>c.kind==='depends-on')?.to??null]);})()",
      );
      expect(result.outputs).toEqual([4000, 16000].map((n) => JSON.stringify(expected(n))));
      expect(medianFourfoldRatio(result.samples)).toBeLessThan(8);
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );
});
