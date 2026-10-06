// @vitest-environment node
import { Platform } from 'obsidian';
import type ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import {
  configValue,
  suiteTimeoutFindings,
  timeoutFindings,
  vitestTestOptions,
} from './architecture/testTimeouts';
import * as limits from './support/timeouts';
import { TYPESCRIPT_PROGRAM_TIMEOUT_MS } from './support/timeouts';

const loadNodeTools = async () => {
  if (!Platform.isDesktop) throw new Error('Test time limit rows require a desktop runtime');
  return Promise.all([import('node:fs'), import('node:os'), import('node:path')]);
};
const [{ mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync }, { tmpdir }, path] =
  await loadNodeTools();

const repositoryRoot = path.resolve(import.meta.dirname, '..');

/**
 * The script of a worker thread that runs one export of the check's module and posts its result.
 * Node strips the module's types, as it does by default on every version the engines allow (from
 * 22.18 and 23.6), and a resolve hook (`registerHooks`, from 22.15 and 23.5) adds the `.ts`
 * extension that the module's relative imports leave out, as the repository's bundler resolution
 * does.
 */
const CHECK_WORKER = [
  "const { registerHooks } = require('node:module');",
  "const { pathToFileURL } = require('node:url');",
  "const { parentPort, workerData } = require('node:worker_threads');",
  'registerHooks({',
  '  resolve(specifier, context, nextResolve) {',
  '    try {',
  '      return nextResolve(specifier, context);',
  '    } catch (error) {',
  "      if (!specifier.startsWith('.') || error.code !== 'ERR_MODULE_NOT_FOUND') throw error;",
  "      return nextResolve(specifier + '.ts', context);",
  '    }',
  '  },',
  '});',
  'import(pathToFileURL(workerData.module).href).then((check) => {',
  '  parentPort.postMessage(check[workerData.name](workerData.root));',
  '});',
].join('\n');

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * The check's findings over every file either gate of the repository at `root` runs, from a worker
 * thread. Vitest's v8 provider counts every block that this thread runs, which makes the check's
 * parse about five times slower; a worker thread runs in an isolate of its own, outside that
 * count. The worker runs `suiteTimeoutFindings`, named here by reference, so that the check
 * follows this row's work into it.
 */
async function checkInWorker(root: string): Promise<string[]> {
  if (!Platform.isDesktop) throw new Error('Test time limit rows require a desktop runtime');
  const { Worker } = await import('node:worker_threads');
  const worker = new Worker(CHECK_WORKER, {
    eval: true,
    workerData: {
      module: path.join(import.meta.dirname, 'architecture', 'testTimeouts.ts'),
      name: suiteTimeoutFindings.name,
      root,
    },
  });
  return new Promise((resolve, reject) => {
    let findings: string[] | undefined;
    worker.on('message', (message: unknown) => {
      if (isStrings(message)) findings = message;
    });
    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (findings === undefined) reject(new Error(`The check's worker ended with code ${code}`));
      else resolve(findings);
    });
  });
}

const FIXTURE_ROOT = '/fixture';
const FIXTURE_TEST = 'test/fixture.test.ts';
/** The limits module a fixture imports from. The check compares limits by the names it exports. */
const FIXTURE_LIMITS = [
  'export const LINTER_TIMEOUT_MS = 120_000;',
  'export const TYPESCRIPT_PROGRAM_TIMEOUT_MS = 80_000;',
  'export const SOURCE_WALK_TIMEOUT_MS = 80_000;',
  'export const CHILD_PROCESS_TIMEOUT_MS = 20_000;',
  'export const VIRTUAL_SURFACE_AUDIT_TIMEOUT_MS = 220_000;',
];
const PROGRAM_WORK = 'program work needs TYPESCRIPT_PROGRAM_TIMEOUT_MS';
const CHILD_WORK = 'child process work needs CHILD_PROCESS_TIMEOUT_MS';

/**
 * The findings for a fixture test file given by its lines, which reads the limits module at
 * test/support/timeouts.ts and the other `modules`, given by their paths under the root.
 */
function findings(
  lines: readonly string[],
  modules: Readonly<Record<string, readonly string[]>> = {},
): string[] {
  const files = { 'test/support/timeouts.ts': FIXTURE_LIMITS, ...modules, [FIXTURE_TEST]: lines };
  const texts = new Map(
    Object.entries(files).map(([file, text]) => [`${FIXTURE_ROOT}/${file}`, text.join('\n')]),
  );
  const host: ts.ModuleResolutionHost = {
    fileExists: (file) => texts.has(file),
    readFile: (file) => texts.get(file),
  };
  return timeoutFindings({ root: FIXTURE_ROOT, host }, [`${FIXTURE_ROOT}/${FIXTURE_TEST}`]);
}

/** A finding on a line of the fixture test file. */
function on(line: number, finding: string): string {
  return `${FIXTURE_TEST}:${line} ${finding}`;
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A repository in a temporary directory that holds `files`, given by their lines. */
function makeRoot(files: Readonly<Record<string, readonly string[]>>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'abyss-test-timeouts-'));
  roots.push(root);
  for (const [file, lines] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), lines.join('\n'));
  }
  return root;
}

describe('test time limits', () => {
  it(
    'requires the limit of the heavy work a row reaches, wherever the row names it',
    () => {
      expect(
        findings([
          "import ts from 'typescript';",
          "import { it, test } from 'vitest';",
          "import { TYPESCRIPT_PROGRAM_TIMEOUT_MS } from './support/timeouts';",
          "it('builds', () => {",
          '  ts.createProgram([], {});',
          '});',
          "it('builds under a limit', () => {",
          '  ts.createProgram([], {});',
          '}, TYPESCRIPT_PROGRAM_TIMEOUT_MS);',
          "test('builds under an option', { timeout: TYPESCRIPT_PROGRAM_TIMEOUT_MS }, () => {",
          '  ts.createProgram([], {});',
          '});',
          "it.each(['a'])('builds %s', (name) => {",
          '  ts.createProgram([name], {});',
          '});',
          "it.each(['a'])('builds %s under a limit', (name) => {",
          '  ts.createProgram([name], {});',
          '}, TYPESCRIPT_PROGRAM_TIMEOUT_MS);',
          "it.each`name`('builds $name from a table', ({ name }) => {",
          '  ts.createProgram([name], {});',
          '});',
          "it.each`name`('builds $name from a table under a limit', ({ name }) => {",
          '  ts.createProgram([name], {});',
          '}, TYPESCRIPT_PROGRAM_TIMEOUT_MS);',
        ]),
      ).toEqual([
        on(4, `row 'builds': ${PROGRAM_WORK}`),
        on(13, `row 'builds %s': ${PROGRAM_WORK}`),
        on(19, `row 'builds $name from a table': ${PROGRAM_WORK}`),
      ]);
    },
    TYPESCRIPT_PROGRAM_TIMEOUT_MS,
  );

  it(
    'classifies full-range lifecycle cycles only through their owning helper',
    () => {
      expect(
        findings(
          [
            "import { it } from 'vitest';",
            "import { runVirtualSurfaceAuditCycles as audit } from './support/virtualSurfaceAudit';",
            "import { runVirtualSurfaceAuditCycles as other } from './support/otherAudit';",
            "import { VIRTUAL_SURFACE_AUDIT_TIMEOUT_MS } from './support/timeouts';",
            "it('full audit without its limit', async () => { await audit(async () => {}); });",
            "it('full audit with its limit', async () => { await audit(async () => {}); }, VIRTUAL_SURFACE_AUDIT_TIMEOUT_MS);",
            "it('unrelated helper with the same name', async () => { await other(async () => {}); });",
            "it('local same-named function', async () => {",
            '  async function runVirtualSurfaceAuditCycles() {}',
            '  await runVirtualSurfaceAuditCycles();',
            '});',
            "it('light work borrowing the audit limit', () => {}, VIRTUAL_SURFACE_AUDIT_TIMEOUT_MS);",
            "it('unrelated helper borrowing the audit limit', async () => { await other(async () => {}); }, VIRTUAL_SURFACE_AUDIT_TIMEOUT_MS);",
            "it('full audit with a literal limit', async () => { await audit(async () => {}); }, 25_000);",
          ],
          {
            'test/support/virtualSurfaceAudit.ts': [
              'export async function runVirtualSurfaceAuditCycles(cycle: (index: number) => Promise<void>) {',
              '  for (let index = 0; index < 20; index++) await cycle(index);',
              '}',
            ],
            'test/support/otherAudit.ts': [
              'export async function runVirtualSurfaceAuditCycles(cycle: (index: number) => Promise<void>) {',
              '  await cycle(0);',
              '}',
            ],
          },
        ),
      ).toEqual([
        on(
          5,
          "row 'full audit without its limit': virtual surface audit work needs VIRTUAL_SURFACE_AUDIT_TIMEOUT_MS",
        ),
        on(12, "row 'light work borrowing the audit limit': a limit on light work"),
        on(13, "row 'unrelated helper borrowing the audit limit': a limit on light work"),
        on(
          14,
          "row 'full audit with a literal limit': virtual surface audit work needs VIRTUAL_SURFACE_AUDIT_TIMEOUT_MS from test/support/timeouts.ts, not a number",
        ),
      ]);
    },
    TYPESCRIPT_PROGRAM_TIMEOUT_MS,
  );

  it(
    'follows the names a row reads to their declarations, as the language scopes them',
    () => {
      expect(
        findings([
          "import ts from 'typescript';",
          "import { describe, it } from 'vitest';",
          'function build() {',
          '  return ts.createProgram([], {});',
          '}',
          "it('calls a module function', () => {",
          '  build();',
          '});',
          'function rows() {',
          '  function buildInside() {',
          '    return ts.createProgram([], {});',
          '  }',
          "  it('calls a function declared in the function around it', () => {",
          '    buildInside();',
          '  });',
          '}',
          'rows();',
          "describe('programs', () => {",
          '  const program = ts.createProgram([], {});',
          "  const build = () => 'light';",
          "  it('reads a describe value', () => {",
          '    program.getRootFileNames();',
          '  });',
          "  it('calls the closest of two functions of one name', () => {",
          '    build();',
          '  });',
          '});',
        ]),
      ).toEqual([
        on(6, `row 'calls a module function': ${PROGRAM_WORK}`),
        on(13, `row 'calls a function declared in the function around it': ${PROGRAM_WORK}`),
        on(21, `row 'reads a describe value': ${PROGRAM_WORK}`),
      ]);
    },
    TYPESCRIPT_PROGRAM_TIMEOUT_MS,
  );

  it(
    'follows the helpers a row calls into the other modules the check reads',
    () => {
      expect(
        findings(
          [
            "import { it } from 'vitest';",
            "import { reexported } from './support/barrel';",
            "import { runChecks } from './support/checks';",
            "import buildDefault, { buildProgram, buildProgram as renamed, ping, readText } from './support/programs';",
            "import * as programs from './support/programs';",
            "it('calls a helper imported by name', () => {",
            '  buildProgram();',
            '});',
            "it('calls a renamed helper', () => {",
            '  renamed();',
            '});',
            "it('calls a helper through a namespace', () => {",
            '  programs.buildProgram();',
            '});',
            "it('calls a default export', () => {",
            '  buildDefault();',
            '});',
            "it('calls a re-export', () => {",
            '  reexported();',
            '});',
            "it('calls a helper destructured from a dynamic import', async () => {",
            "  const { buildProgram: build } = await import('./support/programs');",
            '  build();',
            '});',
            "it('calls a helper that calls a helper in another module', () => {",
            '  runChecks();',
            '});',
            "it('calls light helpers', () => {",
            '  readText();',
            '  programs.readText();',
            '});',
            "it('calls a helper in a cycle', () => {",
            '  ping();',
            '});',
          ],
          {
            'test/support/programs.ts': [
              "import ts from 'typescript';",
              'export function buildProgram() {',
              '  return ts.createProgram([], {});',
              '}',
              'export function readText() {',
              "  return 'light';",
              '}',
              'export default function buildDefault() {',
              '  return buildProgram();',
              '}',
              'export function ping(): unknown {',
              '  return pong();',
              '}',
              'export function pong(): unknown {',
              '  ts.createProgram([], {});',
              '  return ping();',
              '}',
            ],
            'test/support/barrel.ts': ["export { buildProgram as reexported } from './programs';"],
            'test/support/checks.ts': [
              "import { buildProgram } from './programs';",
              'export function runChecks() {',
              '  return buildProgram().getRootFileNames();',
              '}',
            ],
          },
        ),
      ).toEqual([
        on(6, `row 'calls a helper imported by name': ${PROGRAM_WORK}`),
        on(9, `row 'calls a renamed helper': ${PROGRAM_WORK}`),
        on(12, `row 'calls a helper through a namespace': ${PROGRAM_WORK}`),
        on(15, `row 'calls a default export': ${PROGRAM_WORK}`),
        on(18, `row 'calls a re-export': ${PROGRAM_WORK}`),
        on(21, `row 'calls a helper destructured from a dynamic import': ${PROGRAM_WORK}`),
        on(25, `row 'calls a helper that calls a helper in another module': ${PROGRAM_WORK}`),
        on(32, `row 'calls a helper in a cycle': ${PROGRAM_WORK}`),
      ]);
    },
    TYPESCRIPT_PROGRAM_TIMEOUT_MS,
  );

  it(
    'counts a walk only where one row both lists a directory and parses',
    () => {
      expect(
        findings(
          [
            "import ts from 'typescript';",
            "import { it } from 'vitest';",
            "import { parseAll } from './support/parse';",
            "const files = ts.sys.readDirectory('src', ['.ts']);",
            "it('reads a listing', () => {",
            '  files.at(0);',
            '});',
            "it('parses a file', () => {",
            "  ts.createSourceFile('a.ts', '', ts.ScriptTarget.ESNext);",
            '});',
            "it('parses the files it lists', () => {",
            "  parseAll(ts.sys.readDirectory('src', ['.ts']));",
            '});',
          ],
          {
            'test/support/parse.ts': [
              "import ts from 'typescript';",
              'export function parseAll(files: readonly string[]) {',
              "  return files.map((file) => ts.createSourceFile(file, '', ts.ScriptTarget.ESNext));",
              '}',
            ],
          },
        ),
      ).toEqual([
        on(11, "row 'parses the files it lists': walk work needs SOURCE_WALK_TIMEOUT_MS"),
      ]);
    },
    TYPESCRIPT_PROGRAM_TIMEOUT_MS,
  );

  it(
    'requires the largest limit of two kinds, and only the limit of the kind a row reaches',
    () => {
      expect(
        findings([
          "import { spawnSync } from 'node:child_process';",
          "import { it } from 'vitest';",
          "import { CHILD_PROCESS_TIMEOUT_MS, LINTER_TIMEOUT_MS } from './support/timeouts';",
          "it('lints a script it runs', async () => {",
          "  spawnSync('node', ['a.js']);",
          "  await eslint.lintText('');",
          '}, CHILD_PROCESS_TIMEOUT_MS);',
          "it('lints a script it runs under the larger limit', async () => {",
          "  spawnSync('node', ['a.js']);",
          "  await eslint.lintText('');",
          '}, LINTER_TIMEOUT_MS);',
          "it('runs a script', () => {",
          "  spawnSync('node', ['a.js']);",
          '}, LINTER_TIMEOUT_MS);',
        ]),
      ).toEqual([
        on(
          4,
          "row 'lints a script it runs': linter and child process work needs LINTER_TIMEOUT_MS, not CHILD_PROCESS_TIMEOUT_MS",
        ),
        on(12, `row 'runs a script': ${CHILD_WORK}, not LINTER_TIMEOUT_MS`),
      ]);
    },
    TYPESCRIPT_PROGRAM_TIMEOUT_MS,
  );

  it(
    'accepts either limit of two kinds that share the largest value',
    () => {
      expect(
        findings([
          "import ts from 'typescript';",
          "import { it } from 'vitest';",
          "import { SOURCE_WALK_TIMEOUT_MS, TYPESCRIPT_PROGRAM_TIMEOUT_MS } from './support/timeouts';",
          'function buildWalked() {',
          "  const files = ts.sys.readDirectory('src', ['.ts']);",
          "  files.forEach((file) => ts.createSourceFile(file, '', ts.ScriptTarget.ESNext));",
          '  return ts.createProgram(files, {});',
          '}',
          "it('builds the files it walks', () => {",
          '  buildWalked();',
          '});',
          "it('builds the files it walks under the program limit', () => {",
          '  buildWalked();',
          '}, TYPESCRIPT_PROGRAM_TIMEOUT_MS);',
          "it('builds the files it walks under the walk limit', () => {",
          '  buildWalked();',
          '}, SOURCE_WALK_TIMEOUT_MS);',
        ]),
      ).toEqual([
        on(
          9,
          "row 'builds the files it walks': program and walk work needs TYPESCRIPT_PROGRAM_TIMEOUT_MS or SOURCE_WALK_TIMEOUT_MS",
        ),
      ]);
    },
    TYPESCRIPT_PROGRAM_TIMEOUT_MS,
  );

  it(
    "counts exec, Worker, and esbuild's calls as child processes only through their modules",
    () => {
      expect(
        findings([
          "import { exec } from 'node:child_process';",
          "import { Worker } from 'node:worker_threads';",
          "import { build } from 'esbuild';",
          "import { it } from 'vitest';",
          "it('runs a command', () => {",
          "  exec('ls');",
          '});',
          "it('starts a worker', () => {",
          "  new Worker('a.js');",
          '});',
          "it('bundles', async () => {",
          '  await build({});',
          '});',
          "it('bundles through a dynamic import', async () => {",
          "  const { transform } = await import('esbuild');",
          "  await transform('');",
          '});',
          "it('calls methods of the same names', async () => {",
          "  const tools = { build: async () => 'light', exec: () => 'light' };",
          '  tools.exec();',
          '  await tools.build();',
          '});',
        ]),
      ).toEqual([
        on(5, `row 'runs a command': ${CHILD_WORK}`),
        on(8, `row 'starts a worker': ${CHILD_WORK}`),
        on(11, `row 'bundles': ${CHILD_WORK}`),
        on(14, `row 'bundles through a dynamic import': ${CHILD_WORK}`),
      ]);
    },
    TYPESCRIPT_PROGRAM_TIMEOUT_MS,
  );

  it(
    "requires hooks to name their limit, a row's context hooks among them",
    () => {
      expect(
        findings([
          "import ts from 'typescript';",
          "import { afterAll, aroundEach, beforeAll, it } from 'vitest';",
          "import { TYPESCRIPT_PROGRAM_TIMEOUT_MS } from './support/timeouts';",
          'beforeAll(() => {',
          '  ts.createProgram([], {});',
          '});',
          'afterAll(() => {',
          '  ts.createProgram([], {});',
          '}, TYPESCRIPT_PROGRAM_TIMEOUT_MS);',
          'aroundEach(async (runTest) => {',
          '  ts.createProgram([], {});',
          '  await runTest();',
          '});',
          "it('builds after it ends', ({ onTestFinished }) => {",
          '  onTestFinished(() => {',
          '    ts.createProgram([], {});',
          '  });',
          '}, TYPESCRIPT_PROGRAM_TIMEOUT_MS);',
          "it('builds after it ends, through its context', (context) => {",
          '  context.onTestFinished(() => {',
          '    ts.createProgram([], {});',
          '  }, TYPESCRIPT_PROGRAM_TIMEOUT_MS);',
          '}, TYPESCRIPT_PROGRAM_TIMEOUT_MS);',
        ]),
      ).toEqual([
        on(4, `hook beforeAll: ${PROGRAM_WORK}`),
        on(10, `hook aroundEach: ${PROGRAM_WORK}`),
        on(15, `hook onTestFinished: ${PROGRAM_WORK}`),
      ]);
    },
    TYPESCRIPT_PROGRAM_TIMEOUT_MS,
  );

  it(
    'refuses every other way of giving a limit, a limit on light work or a suite, retry, and vi.setConfig',
    () => {
      const notImported = `${PROGRAM_WORK} from test/support/timeouts.ts`;
      expect(
        findings([
          "import ts from 'typescript';",
          "import { describe, it, suite, vi } from 'vitest';",
          "import * as limits from './support/timeouts';",
          "import { TYPESCRIPT_PROGRAM_TIMEOUT_MS, TYPESCRIPT_PROGRAM_TIMEOUT_MS as PROGRAM_LIMIT } from './support/timeouts';",
          'const LIMIT = TYPESCRIPT_PROGRAM_TIMEOUT_MS;',
          'const options = { timeout: TYPESCRIPT_PROGRAM_TIMEOUT_MS };',
          "it('builds under a number', () => {",
          '  ts.createProgram([], {});',
          '}, 80_000);',
          "it('builds under a local constant', () => {",
          '  ts.createProgram([], {});',
          '}, LIMIT);',
          "it('builds under a property', () => {",
          '  ts.createProgram([], {});',
          '}, limits.TYPESCRIPT_PROGRAM_TIMEOUT_MS);',
          "it('builds under an alias', () => {",
          '  ts.createProgram([], {});',
          '}, PROGRAM_LIMIT);',
          "it('builds under options given by name', options, () => {",
          '  ts.createProgram([], {});',
          '});',
          "it('trims a string', () => {",
          "  'light'.trim();",
          '}, TYPESCRIPT_PROGRAM_TIMEOUT_MS);',
          "it('trims a string under a quoted limit', { 'timeout': TYPESCRIPT_PROGRAM_TIMEOUT_MS }, () => 'light'.trim());",
          "describe('a suite with a limit option', { timeout: TYPESCRIPT_PROGRAM_TIMEOUT_MS }, () => {});",
          "describe('a suite with a quoted limit option', { 'timeout': TYPESCRIPT_PROGRAM_TIMEOUT_MS }, () => {});",
          "describe('a suite with a trailing limit', () => {}, TYPESCRIPT_PROGRAM_TIMEOUT_MS);",
          "suite('a suite declared as a suite', () => {}, TYPESCRIPT_PROGRAM_TIMEOUT_MS);",
          "describe('a retried suite', { retry: 2 }, () => {});",
          "it('a row retried under a quoted key', { 'retry': 2 }, () => {});",
          "it('a retried row', { retry: 2 }, () => {});",
          'vi.setConfig({ testTimeout: 80_000 });',
        ]),
      ).toEqual([
        on(7, `row 'builds under a number': ${notImported}, not a number`),
        on(10, `row 'builds under a local constant': ${notImported}, not a local constant`),
        on(13, `row 'builds under a property': ${notImported}, not a property access`),
        on(16, `row 'builds under an alias': ${notImported}, not an aliased import`),
        on(19, "row 'builds under options given by name': unreadable, options given by name"),
        on(22, "row 'trims a string': a limit on light work"),
        on(25, "row 'trims a string under a quoted limit': a limit on light work"),
        on(26, "suite 'a suite with a limit option': a limit on a suite"),
        on(27, "suite 'a suite with a quoted limit option': a limit on a suite"),
        on(28, "suite 'a suite with a trailing limit': a limit on a suite"),
        on(29, "suite 'a suite declared as a suite': a limit on a suite"),
        on(30, "suite 'a retried suite': retry on a suite"),
        on(31, "row 'a row retried under a quoted key': retry on a row"),
        on(32, "row 'a retried row': retry on a row"),
        on(33, 'vi.setConfig: changes the limits of the rows after it'),
      ]);
    },
    TYPESCRIPT_PROGRAM_TIMEOUT_MS,
  );

  it(
    'reports every row, suite, hook, and module it cannot read',
    () => {
      expect(
        findings(
          [
            "import ts from 'typescript';",
            "import { describe, it, it as row, test } from 'vitest';",
            "const args = ['builds', () => ts.createProgram([], {})] as const;",
            'it(...args);',
            "it('takes its body from a call', makeBody());",
            'const alias = it;',
            'register(describe);',
            'const slow = test.extend({});',
            "const vitest = await import('vitest');",
            "const helpers = await import('./support/helpers');",
            "import './support/rows';",
            "import vitestDefault, * as vitestSpace from 'vitest';",
            "import vitestRequired = require('vitest');",
            'export { describe };',
            "it('hands its context on', (context) => register(context));",
            "it('takes one argument too many', () => {}, undefined, 1);",
          ],
          {
            'test/support/helpers.ts': ['export const helper = 1;'],
            'test/support/rows.ts': ['export { it };', "import { it } from 'vitest';"],
          },
        ),
      ).toEqual([
        on(2, 'it: unreadable, imported under another name'),
        on(4, 'row ...args: unreadable, a spread argument'),
        on(
          5,
          "row 'takes its body from a call': unreadable, a body that is neither a function nor a resolvable name",
        ),
        on(6, 'it: unreadable, used other than as the head of a call statement'),
        on(7, 'describe: unreadable, used other than as the head of a call statement'),
        on(8, 'test: unreadable, used other than as the head of a call statement'),
        on(9, 'vitest: unreadable, reached through import()'),
        on(10, 'import(): unreadable, ./support/helpers kept as a module object'),
        on(12, 'vitest: unreadable, a default import'),
        on(12, 'vitest: unreadable, a namespace import'),
        on(13, 'vitest: unreadable, imported through require()'),
        on(14, 'describe: unreadable, re-exported'),
        on(15, 'context: unreadable, passed on as a value'),
        on(16, "row 'takes one argument too many': unreadable, an argument after the limit"),
        'test/support/rows.ts:1 it: unreadable, re-exported',
      ]);
    },
    TYPESCRIPT_PROGRAM_TIMEOUT_MS,
  );

  it(
    "reads vi's chains, whose values rows keep and await, and names in types",
    () => {
      expect(
        findings([
          "import { afterEach, it, vi } from 'vitest';",
          'type Mock = ReturnType<typeof vi.fn>;',
          'afterEach(() => vi.restoreAllMocks());',
          "it('waits for a spy', async () => {",
          "  const spy = vi.spyOn(console, 'log');",
          '  await vi.waitFor(() => spy.mock.calls.length > 0);',
          '});',
        ]),
      ).toEqual([]);
    },
    TYPESCRIPT_PROGRAM_TIMEOUT_MS,
  );

  it(
    'reads every file a gate runs, whatever the file mentions, and the setup files it names',
    async () => {
      const light = [
        "import { it } from 'vitest';",
        'const T = 5_000;',
        "it('waits', () => {}, T);",
      ];
      const root = makeRoot({
        'vitest.config.ts': [
          "import { defineConfig } from 'vitest/config';",
          'export default defineConfig({',
          '  test: {',
          "    include: ['test/**/*.test.ts'],",
          "    exclude: ['test/perf/**', 'test/store/**'],",
          "    setupFiles: ['test/setup.ts'],",
          '  },',
          '});',
        ],
        'vitest.store.config.ts': [
          "import { defineConfig } from 'vitest/config';",
          "export default defineConfig({ test: { include: ['test/store/**/*.test.ts'] } });",
        ],
        'test/setup.ts': ["import { vi } from 'vitest';", 'vi.setConfig({ testTimeout: 80_000 });'],
        'test/light.test.ts': light,
        'test/perf/light.test.ts': light,
        'test/store/light.test.ts': light,
      });

      expect(await checkInWorker(root)).toEqual([
        "test/light.test.ts:3 row 'waits': a limit on light work",
        'test/setup.ts:2 vi.setConfig: changes the limits of the rows after it',
        "test/store/light.test.ts:3 row 'waits': a limit on light work",
      ]);
    },
    TYPESCRIPT_PROGRAM_TIMEOUT_MS,
  );
});

/** What each gate config sets for the options the pins hold. */
const GATE_OPTIONS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  'vitest.config.ts': {
    include: ['test/**/*.test.ts'],
    exclude: ['test/perf/**', 'test/store/**'],
    setupFiles: ['test/setup/obsidianMocks.ts', 'test/setup/isolatedFailures.ts'],
    isolate: true,
    pool: 'forks',
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
  'vitest.store.config.ts': {
    include: ['test/store/**/*.test.ts'],
    setupFiles: ['obsidian-test-mocks/vitest-setup'],
    isolate: true,
    pool: 'forks',
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
};
const PINNED_OPTIONS = [
  'include',
  'exclude',
  'setupFiles',
  'isolate',
  'pool',
  'testTimeout',
  'hookTimeout',
];
/** Options a gate config leaves out; a tag definition can carry its own `timeout` and `retry`. */
const UNSET_OPTIONS = ['retry', 'globals', 'projects', 'tags'];
/** The flags with which a script could change a Vitest run's limits, pool, or isolation. */
const RUN_FLAGS = [
  '--testTimeout',
  '--test-timeout',
  '--hookTimeout',
  '--hook-timeout',
  '--retry',
  '--pool',
  '--isolate',
  '--no-isolate',
];

/** A gate config's light limit, its `testTimeout`. */
function lightLimit(config: string): number {
  const limit = configValue(vitestTestOptions(repositoryRoot, config), 'testTimeout', config);
  if (typeof limit !== 'number') throw new Error(`${config} sets no testTimeout the pins can read`);
  return limit;
}

/**
 * Every flag of a `package.json` script that could change a Vitest run's limits, pool, isolation,
 * or config, as `<script>: <flag>`, with the value that follows a config flag.
 */
function runFlags(scripts: Readonly<Record<string, string>>): string[] {
  const flags: string[] = [];
  for (const [script, command] of Object.entries(scripts)) {
    const words = command.split(/\s+/u);
    for (const [index, word] of words.entries()) {
      if (RUN_FLAGS.some((flag) => word.startsWith(flag))) flags.push(`${script}: ${word}`);
      if (word.startsWith('--config') || word.startsWith('-c')) {
        const value = word.includes('=') ? '' : ` ${words[index + 1] ?? ''}`;
        flags.push(`${script}: ${word}${value}`);
      }
    }
  }
  return flags;
}

it(
  'reads runner signal forwarding and a directly invoked finish hook as light work',
  () => {
    expect(
      findings([
        "import { it } from 'vitest';",
        'async function helper(signal: AbortSignal) { signal.throwIfAborted(); }',
        "it('owns cancellation', async ({ signal, onTestFinished }) => {",
        '  const lifetime = new AbortController();',
        '  const abort = () => lifetime.abort(signal.reason);',
        "  signal.addEventListener('abort', abort, { once: true });",
        '  if (signal.aborted) abort();',
        '  onTestFinished(() => {',
        "    signal.removeEventListener('abort', abort);",
        "    lifetime.abort(new Error('Search test finished'));",
        '  });',
        '  await helper(lifetime.signal);',
        '});',
      ]),
    ).toEqual([]);
  },
  TYPESCRIPT_PROGRAM_TIMEOUT_MS,
);

describe('gate time limits', () => {
  it(
    'holds every row and hook that either gate runs to the limit of its work',
    async () => {
      expect(await checkInWorker(repositoryRoot)).toEqual([]);
    },
    TYPESCRIPT_PROGRAM_TIMEOUT_MS,
  );

  it('pins the heavy-work limits, each above the light limit of both gate configs', () => {
    expect({ ...limits }).toEqual({
      LINTER_TIMEOUT_MS: 120_000,
      TYPESCRIPT_PROGRAM_TIMEOUT_MS: 80_000,
      SOURCE_WALK_TIMEOUT_MS: 80_000,
      CHILD_PROCESS_TIMEOUT_MS: 20_000,
      VIRTUAL_SURFACE_AUDIT_TIMEOUT_MS: 220_000,
    });
    const light = Math.max(...Object.keys(GATE_OPTIONS).map(lightLimit));
    expect(Object.entries(limits).filter(([, limit]) => limit <= light)).toEqual([]);
  });

  it('pins both gate configs and keeps every script off the flags that would change a run', () => {
    for (const [config, expected] of Object.entries(GATE_OPTIONS)) {
      const options = vitestTestOptions(repositoryRoot, config);
      const pinned = PINNED_OPTIONS.map((key) => [key, configValue(options, key, config)]);

      expect(Object.fromEntries(pinned), config).toEqual(expected);
      expect(configValue(options, 'isolate', config), config).not.toBe(false);
      expect(
        UNSET_OPTIONS.filter((key) => options.has(key)),
        config,
      ).toEqual([]);
    }
    const { scripts } = JSON.parse(
      readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };

    expect(runFlags(scripts)).toEqual([
      'lint:store: --config vitest.store.config.ts',
      'bench: --config vitest.bench.config.ts',
      'arch: --config dependency-cruiser.config.cjs',
    ]);
  });
});
