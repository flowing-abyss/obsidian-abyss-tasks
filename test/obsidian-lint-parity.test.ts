import { ESLint, type Linter } from 'eslint';
import obsidianmd from 'eslint-plugin-obsidianmd';
import { Platform } from 'obsidian';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const loadChildProcess = async () => {
  if (!Platform.isDesktop) throw new Error('The lint parity test requires a desktop runtime');
  return import('node:child_process');
};
const { execFileSync } = await loadChildProcess();

const ROOT = ts.sys.resolvePath(`${import.meta.dirname}/..`);
const PROJECT_CONFIG = ts.sys.resolvePath(`${ROOT}/eslint.config.mts`);
const ESLINT_COLD_START_TIMEOUT_MS = 30_000;
const SOURCE_FILES = ts.sys.readDirectory(ts.sys.resolvePath(`${ROOT}/src`), ['.ts']);
const CODE_EXTENSIONS = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'];
const obsidianmdOnly = new ESLint({
  cwd: ROOT,
  overrideConfigFile: true,
  overrideConfig: obsidianmd.configs.recommendedWithLocalesEn,
});
const projectLint = new ESLint({ cwd: ROOT, overrideConfigFile: PROJECT_CONFIG });

/** Every tracked code file that the project config lints, as absolute paths. */
async function lintedFiles(): Promise<string[]> {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((file) => CODE_EXTENSIONS.some((extension) => file.endsWith(extension)))
    .map((file) => ts.sys.resolvePath(`${ROOT}/${file}`));
  const linted: string[] = [];
  for (const file of tracked) {
    if (!(await projectLint.isPathIgnored(file))) linted.push(file);
  }
  return linted;
}
const LINTED_FILES = await lintedFiles();

/**
 * The directive ban every linted code file resolves: no ESLint directive at all, and no TypeScript
 * directive that silences a finding (`@ts-check` silences nothing).
 */
const DIRECTIVE_BAN: Readonly<Record<string, readonly unknown[]>> = {
  'eslint-comments/no-use': [2, { allow: [] }],
  '@typescript-eslint/ban-ts-comment': [
    2,
    { 'ts-check': false, 'ts-expect-error': true, 'ts-ignore': true, 'ts-nocheck': true },
  ],
};
const DIRECTIVE_BAN_RULES = Object.keys(DIRECTIVE_BAN);

/**
 * Reviewed differences from eslint-plugin-obsidianmd's recommended config, each pinned on both
 * sides, so a change to either side is reviewed again.
 */
const REVIEWED_DIFFERENCES: ReadonlyMap<
  string,
  { readonly obsidianmd: readonly unknown[]; readonly project: readonly unknown[] }
> = new Map([
  // Stricter: a promise discarded with `void` is still reported.
  [
    '@typescript-eslint/no-floating-promises',
    { obsidianmd: [2], project: [2, { ignoreIIFE: false, ignoreVoid: false }] },
  ],
  // The rule's default, stated explicitly.
  [
    '@typescript-eslint/no-misused-promises',
    { obsidianmd: [2], project: [2, { checksVoidReturn: true }] },
  ],
  // Stricter: an error, and it also checks arguments and rest siblings.
  [
    '@typescript-eslint/no-unused-vars',
    {
      obsidianmd: [1, { args: 'none', ignoreRestSiblings: true }],
      project: [2, { argsIgnorePattern: '^_' }],
    },
  ],
  // The rule's default, stated explicitly.
  [
    '@typescript-eslint/restrict-template-expressions',
    { obsidianmd: [2], project: [2, { allowNumber: true }] },
  ],
]);

async function effectiveRules(
  eslint: ESLint,
  file: string,
): Promise<Readonly<Record<string, unknown>>> {
  const config = (await eslint.calculateConfigForFile(file)) as Linter.Config | undefined;
  return config?.rules ?? {};
}

/** A resolved entry's severity: 0 off, 1 warn, 2 error; a rule the config does not set is off. */
function level(entry: unknown): number {
  const severity: unknown = Array.isArray(entry) ? entry[0] : undefined;
  return typeof severity === 'number' ? severity : 0;
}

function options(entry: unknown): readonly unknown[] {
  return Array.isArray(entry) ? entry.slice(1) : [];
}

/** Why the project does not hold a rule as eslint-plugin-obsidianmd sets it, if it does not. */
function shortfall(rule: string, baseline: unknown, project: unknown): string | undefined {
  const pin = REVIEWED_DIFFERENCES.get(rule);
  if (pin !== undefined) {
    const pinned =
      JSON.stringify(baseline) === JSON.stringify(pin.obsidianmd) &&
      JSON.stringify(project) === JSON.stringify(pin.project);
    return pinned ? undefined : 'no longer matches its reviewed difference';
  }
  if (level(project) < level(baseline)) return 'is weaker than obsidianmd sets it';
  if (rule === 'no-restricted-globals') {
    const kept = new Set(options(project).map((entry) => JSON.stringify(entry)));
    const complete = options(baseline).every((entry) => kept.has(JSON.stringify(entry)));
    return complete ? undefined : "lacks some of obsidianmd's restricted globals";
  }
  const same = JSON.stringify(options(project)) === JSON.stringify(options(baseline));
  return same ? undefined : "has other options than obsidianmd's";
}

/** Each problem once per rule, shortfall, and project setting, with the files it affects. */
async function parityProblems(project: ESLint, files: readonly string[]): Promise<string[]> {
  const problems = new Map<string, { readonly text: string; readonly files: string[] }>();
  const usedDifferences = new Set<string>();
  for (const file of files) {
    const baselineRules = await effectiveRules(obsidianmdOnly, file);
    const projectRules = await effectiveRules(project, file);
    for (const [rule, entry] of Object.entries(baselineRules)) {
      if (level(entry) === 0) continue;
      if (REVIEWED_DIFFERENCES.has(rule)) usedDifferences.add(rule);
      const problem = shortfall(rule, entry, projectRules[rule]);
      if (problem === undefined) continue;
      const key = `${rule} ${problem} ${JSON.stringify(projectRules[rule])}`;
      const group = problems.get(key) ?? { text: `${rule} ${problem}`, files: [] };
      group.files.push(file.slice(ROOT.length + 1));
      problems.set(key, group);
    }
  }
  const unused = [...REVIEWED_DIFFERENCES.keys()]
    .filter((rule) => !usedDifferences.has(rule))
    .map((rule) => `${rule} is a reviewed difference that no source file uses`);
  const reported = [...problems.values()].map(({ text, files: where }) =>
    where.length === 1
      ? `${text} in ${where[0]}`
      : `${text} in ${where[0]} and ${where.length - 1} more files`,
  );
  return [...reported, ...unused].sort((left, right) => left.localeCompare(right));
}

/** Each rule of the directive ban that a file resolves otherwise, per file, sorted. */
async function directiveBanProblems(eslint: ESLint, files: readonly string[]): Promise<string[]> {
  const problems: string[] = [];
  for (const file of files) {
    const rules = await effectiveRules(eslint, file);
    for (const rule of DIRECTIVE_BAN_RULES) {
      if (JSON.stringify(rules[rule]) === JSON.stringify(DIRECTIVE_BAN[rule])) continue;
      problems.push(`${rule} is not banned in ${file.slice(ROOT.length + 1)}`);
    }
  }
  return problems.sort((left, right) => left.localeCompare(right));
}

describe('eslint-plugin-obsidianmd parity for plugin source', () => {
  it(
    'holds every obsidianmd rule at the same or a higher severity with the same options',
    async () => {
      expect(await parityProblems(projectLint, SOURCE_FILES)).toEqual([]);
    },
    ESLINT_COLD_START_TIMEOUT_MS,
  );

  it(
    'reports an obsidianmd rule that a project block turns off for one source file',
    async () => {
      const weakened = new ESLint({
        cwd: ROOT,
        overrideConfigFile: PROJECT_CONFIG,
        overrideConfig: { files: ['src/main.ts'], rules: { 'no-self-compare': 'off' } },
      });

      expect(await parityProblems(weakened, [ts.sys.resolvePath(`${ROOT}/src/main.ts`)])).toEqual([
        'no-self-compare is weaker than obsidianmd sets it in src/main.ts',
      ]);
    },
    ESLINT_COLD_START_TIMEOUT_MS,
  );

  it.each<[string, string, Linter.RulesRecord, string]>([
    [
      'a reviewed difference that a project block sets otherwise',
      'src/main.ts',
      {
        '@typescript-eslint/no-floating-promises': [
          'error',
          { ignoreIIFE: true, ignoreVoid: false },
        ],
      },
      '@typescript-eslint/no-floating-promises no longer matches its reviewed difference in src/main.ts',
    ],
    [
      "a task domain block without obsidianmd's restricted globals",
      'src/tasks/domain/StatusCatalog.ts',
      // A bare severity keeps the domain block's options, so the block names only its own globals.
      { 'no-restricted-globals': ['error', 'window', 'document'] },
      "no-restricted-globals lacks some of obsidianmd's restricted globals in src/tasks/domain/StatusCatalog.ts",
    ],
    [
      'an obsidianmd rule that a project block gives other options',
      'src/main.ts',
      { 'no-empty': ['error', { allowEmptyCatch: true }] },
      "no-empty has other options than obsidianmd's in src/main.ts",
    ],
  ])(
    'reports %s for one source file',
    async (_weakening, file, rules, problem) => {
      const weakened = new ESLint({
        cwd: ROOT,
        overrideConfigFile: PROJECT_CONFIG,
        overrideConfig: { files: [file], rules },
      });

      expect(await parityProblems(weakened, [ts.sys.resolvePath(`${ROOT}/${file}`)])).toEqual([
        problem,
      ]);
    },
    ESLINT_COLD_START_TIMEOUT_MS,
  );

  it('reports each reviewed difference that no source file uses', async () => {
    expect(await parityProblems(projectLint, [])).toEqual([
      '@typescript-eslint/no-floating-promises is a reviewed difference that no source file uses',
      '@typescript-eslint/no-misused-promises is a reviewed difference that no source file uses',
      '@typescript-eslint/no-unused-vars is a reviewed difference that no source file uses',
      '@typescript-eslint/restrict-template-expressions is a reviewed difference that no source file uses',
    ]);
  });
});

describe('directive comment ban', () => {
  it(
    'bans every directive comment in every linted file',
    async () => {
      const samples = ['src/main.ts', 'test/obsidian-lint-parity.test.ts', 'tooling/check-css.mjs'];

      expect(LINTED_FILES).toEqual(
        expect.arrayContaining(samples.map((file) => ts.sys.resolvePath(`${ROOT}/${file}`))),
      );
      expect(LINTED_FILES.length).toBeGreaterThan(SOURCE_FILES.length);
      expect(await directiveBanProblems(projectLint, LINTED_FILES)).toEqual([]);
    },
    ESLINT_COLD_START_TIMEOUT_MS,
  );

  it.each<[string, Linter.RulesRecord, string]>([
    [
      'no-use turned off',
      { 'eslint-comments/no-use': 'off' },
      'eslint-comments/no-use is not banned in src/tasks/domain/StatusCatalog.ts',
    ],
    [
      'ban-ts-comment allowing a described expect-error',
      {
        '@typescript-eslint/ban-ts-comment': [
          'error',
          { 'ts-expect-error': 'allow-with-description' },
        ],
      },
      '@typescript-eslint/ban-ts-comment is not banned in src/tasks/domain/StatusCatalog.ts',
    ],
  ])(
    'reports %s for one source folder, in that folder only',
    async (_relaxation, rules, problem) => {
      const weakened = new ESLint({
        cwd: ROOT,
        overrideConfigFile: PROJECT_CONFIG,
        overrideConfig: { files: ['src/tasks/domain/**/*.ts'], rules },
      });
      const files = ['src/main.ts', 'src/tasks/domain/StatusCatalog.ts'].map((file) =>
        ts.sys.resolvePath(`${ROOT}/${file}`),
      );

      expect(await directiveBanProblems(weakened, files)).toEqual([problem]);
    },
    ESLINT_COLD_START_TIMEOUT_MS,
  );

  it(
    'reports a described directive of each kind in a tooling script',
    async () => {
      const source = [
        "// eslint-disable-next-line no-empty -- obsidianmd's own directive rules allow this one",
        "try { JSON.parse('{}'); } catch {}",
        '// @ts-expect-error allow-with-description would allow this one',
        'export const value = 1;',
        '',
      ].join('\n');
      const [result] = await projectLint.lintText(source, {
        filePath: ts.sys.resolvePath(`${ROOT}/tooling/check-css.mjs`),
      });

      expect(
        result?.messages
          .filter(({ ruleId }) => ruleId !== null && DIRECTIVE_BAN_RULES.includes(ruleId))
          .map(({ ruleId, line }) => [ruleId, line]),
      ).toEqual([
        ['eslint-comments/no-use', 1],
        ['@typescript-eslint/ban-ts-comment', 3],
      ]);
    },
    ESLINT_COLD_START_TIMEOUT_MS,
  );
});
