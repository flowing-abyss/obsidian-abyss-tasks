import { Platform } from 'obsidian';
import type ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { suiteTimeoutFindings, timeoutFindings } from './architecture/testTimeouts';
import { TYPESCRIPT_PROGRAM_TIMEOUT_MS } from './support/timeouts';

const loadNodeTools = async () => {
  if (!Platform.isDesktop) throw new Error('Test time limit rows require a desktop runtime');
  return Promise.all([import('node:fs'), import('node:os'), import('node:path')]);
};
const [{ mkdirSync, mkdtempSync, rmSync, writeFileSync }, { tmpdir }, path] = await loadNodeTools();

const FIXTURE_ROOT = '/fixture';
const FIXTURE_TEST = 'test/fixture.test.ts';
/** The limits module a fixture imports from. The check compares limits by the names it exports. */
const FIXTURE_LIMITS = [
  'export const LINTER_TIMEOUT_MS = 120_000;',
  'export const TYPESCRIPT_PROGRAM_TIMEOUT_MS = 80_000;',
  'export const SOURCE_WALK_TIMEOUT_MS = 60_000;',
  'export const CHILD_PROCESS_TIMEOUT_MS = 20_000;',
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
            "import buildDefault, { buildProgram, buildProgram as renamed, readText } from './support/programs';",
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
          'vi.setConfig({ testTimeout: 60_000 });',
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
          ],
          { 'test/support/helpers.ts': ['export const helper = 1;'] },
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
    () => {
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
        'test/setup.ts': ["import { vi } from 'vitest';", 'vi.setConfig({ testTimeout: 60_000 });'],
        'test/light.test.ts': light,
        'test/perf/light.test.ts': light,
        'test/store/light.test.ts': light,
      });

      expect(suiteTimeoutFindings(root)).toEqual([
        "test/light.test.ts:3 row 'waits': a limit on light work",
        'test/setup.ts:2 vi.setConfig: changes the limits of the rows after it',
        "test/store/light.test.ts:3 row 'waits': a limit on light work",
      ]);
    },
    TYPESCRIPT_PROGRAM_TIMEOUT_MS,
  );
});
