import { ESLint, type Linter } from 'eslint';
import obsidianmd from 'eslint-plugin-obsidianmd';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = ts.sys.resolvePath(`${import.meta.dirname}/..`);
const PROJECT_CONFIG = ts.sys.resolvePath(`${ROOT}/eslint.config.mts`);
const ESLINT_COLD_START_TIMEOUT_MS = 30_000;
const SOURCE_FILES = ts.sys.readDirectory(ts.sys.resolvePath(`${ROOT}/src`), ['.ts']);
const obsidianmdOnly = new ESLint({
  cwd: ROOT,
  overrideConfigFile: true,
  overrideConfig: obsidianmd.configs.recommendedWithLocalesEn,
});

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

describe('eslint-plugin-obsidianmd parity for plugin source', () => {
  it(
    'holds every obsidianmd rule at the same or a higher severity with the same options',
    async () => {
      const project = new ESLint({ cwd: ROOT, overrideConfigFile: PROJECT_CONFIG });

      expect(await parityProblems(project, SOURCE_FILES)).toEqual([]);
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
});
