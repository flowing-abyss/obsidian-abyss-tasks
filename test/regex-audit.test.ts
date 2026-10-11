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
const loadFileSystem = async () => {
  if (!Platform.isDesktop) throw new Error('Regex audit tests require a desktop runtime');
  return import('node:fs/promises');
};
const loadOperatingSystem = async () => {
  if (!Platform.isDesktop) throw new Error('Regex audit tests require a desktop runtime');
  return import('node:os');
};
const loadChildProcesses = async () => {
  if (!Platform.isDesktop) throw new Error('Regex audit tests require a desktop runtime');
  return import('node:child_process');
};
const { mkdtemp, readFile, rm } = await loadFileSystem();
const { tmpdir } = await loadOperatingSystem();
const { execFile } = await loadChildProcesses();
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// A worker and solver model recheck's inherited stderr. Both self-exit as a RED-run failsafe.
async function descendantFixture(inherit: boolean, action: string) {
  const directory = await mkdtemp(`${tmpdir()}/abyss-regex-tree-`);
  const marker = `${directory}/pids`;
  const solver = `require('node:fs').appendFileSync(${JSON.stringify(marker)},process.pid+'\\n'); setTimeout(()=>{},4500);`;
  const worker = `const {spawn}=require('node:child_process'); require('node:fs').appendFileSync(${JSON.stringify(marker)},process.pid+'\\n'); spawn(process.execPath,['-e',${JSON.stringify(solver)}],{stdio:['ignore','ignore',${JSON.stringify(inherit ? 'inherit' : 'ignore')}]}); setTimeout(()=>{},4500);`;
  const code = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); spawn(process.execPath,['-e',${JSON.stringify(worker)}],{stdio:['ignore','ignore',${JSON.stringify(inherit ? 'inherit' : 'ignore')}]}); const ready=setInterval(()=>{if(fs.existsSync(${JSON.stringify(marker)})&&fs.readFileSync(${JSON.stringify(marker)},'utf8').trim().split('\\n').length===2){clearInterval(ready);${action}}},5);`;
  const pids = async () => (await readFile(marker, 'utf8')).trim().split('\n').map(Number);
  return {
    code,
    pids,
    async ready() {
      const until = performance.now() + 3000;
      while (performance.now() < until) {
        try {
          if ((await pids()).length === 2) return;
        } catch (error) {
          if ((error as { code?: string }).code !== 'ENOENT') throw error;
        }
        await pause(10);
      }
      throw new Error('Worker and solver did not start');
    },
    async cleanup() {
      try {
        for (const pid of await pids()) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch (error) {
            if ((error as { code?: string }).code !== 'ESRCH') throw error;
          }
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

async function expectDescendantsGone(pids: number[]) {
  expect(pids).toHaveLength(2);
  for (const pid of pids) {
    await expect
      .poll(
        () => {
          try {
            process.kill(pid, 0);
            return false;
          } catch (error) {
            if ((error as { code?: string }).code === 'ESRCH') return true;
            throw error;
          }
        },
        { timeout: 500 },
      )
      .toBe(true);
  }
}

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
  it.each([
    ['deadline', true, 'while(true){}'],
    [
      'output limit',
      true,
      "process.stdout.write('x'.repeat(10_000_001)); setTimeout(()=>{},4500);",
    ],
    [
      'error output limit',
      true,
      "process.stderr.write('x'.repeat(1_000_001)); setTimeout(()=>{},4500);",
    ],
  ])(
    'bounds %s cleanup despite worker and solver retaining stderr',
    async (reason, inherit, action) => {
      const fixture = await descendantFixture(inherit, action);
      try {
        const start = performance.now();
        await expect(runBoundedChild(['-e', fixture.code], { deadlineMs: 1200 })).rejects.toThrow(
          reason,
        );
        expect(performance.now() - start).toBeLessThan(2500);
        await expectDescendantsGone(await fixture.pids());
      } finally {
        await fixture.cleanup();
      }
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );
  it.each([false, true])(
    'cancels the worker and solver with inherited stderr: %s',
    async (inherit) => {
      const fixture = await descendantFixture(inherit, 'while(true){}');
      const abort = new AbortController();
      const result = runBoundedChild(['-e', fixture.code], { signal: abort.signal });
      const rejected = expect(result).rejects.toThrow('cancel');
      try {
        await fixture.ready();
        const start = performance.now();
        abort.abort();
        await rejected;
        expect(performance.now() - start).toBeLessThan(1500);
        await expectDescendantsGone(await fixture.pids());
      } finally {
        abort.abort();
        await rejected;
        await fixture.cleanup();
      }
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );
  it(
    'exits an actual CLI nonzero within the deadline cleanup bound with inherited descendant pipes',
    async () => {
      const fixture = await descendantFixture(true, 'while(true){}');
      const code = `import {runBoundedChild} from ${JSON.stringify(new URL('../tooling/regex-audit.mjs', import.meta.url).href)}; try {await runBoundedChild(['-e',${JSON.stringify(fixture.code)}],{deadlineMs:1200});}catch(error){console.error(error.message);process.exitCode=1;}`;
      try {
        const start = performance.now();
        const result = await new Promise<{
          code: number | string | null | undefined;
          stderr: string;
        }>((resolve) => {
          execFile(
            process.execPath,
            ['--input-type=module', '-e', code],
            { timeout: 7000 },
            (error, _stdout, stderr) => {
              resolve({ code: error?.code, stderr });
            },
          );
        });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('analyzer hard deadline exceeded');
        expect(performance.now() - start).toBeLessThan(2500);
        await expectDescendantsGone(await fixture.pids());
      } finally {
        await fixture.cleanup();
      }
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );
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
