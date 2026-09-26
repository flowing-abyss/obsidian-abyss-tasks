import type { Linter } from 'eslint';
import obsidianmd from 'eslint-plugin-obsidianmd';
import { Platform } from 'obsidian';
import type { Config, LintResult } from 'stylelint';
import obsidianCss from 'stylelint-config-obsidianmd';

const loadNodeTools = async () => {
  if (!Platform.isDesktop)
    throw new Error('The Store review configuration requires a desktop runtime');
  return Promise.all([import('node:fs'), import('node:path')]);
};
const [{ readFileSync, realpathSync }, path] = await loadNodeTools();

/**
 * The names the community directory's review skips, from its FAQ
 * (https://docs.obsidian.md/community-directory/faq). A bare name is a file or a folder, and a name
 * with a wildcard is a file pattern. The vault configuration folder is left out: no tracked path
 * holds one, and leaving a skip out only makes the check stricter.
 */
const SCANNER_SKIPPED_NAMES = [
  'node_modules',
  'dist',
  'build',
  'pkg',
  'test-vault',
  '.pnpm-store',
  'esbuild.config.mjs',
  'version-bump.mjs',
  'automation',
  '*.test.*',
  '*.tests.*',
  '*.spec.*',
  '*.specs.*',
  'test',
  'tests',
  '__tests__',
  'testUtils',
  'e2e-tests',
  'mocks',
  '__mocks__',
  '*.cjs',
  '*.mjs',
  '*.cts',
  '*.mts',
  'vite',
  'scripts',
  'docs',
  'i18n',
  'i18next',
  'locale',
  'locales',
  'translations',
  'l10n',
];

/**
 * The names that eslint-plugin-obsidianmd's guide anchors at the repository root in the scanner's
 * configuration (docs/configuration.md at 0.4.2, "Community plugin scanner configuration"). The
 * check matches them there only, and every other name at any depth. A name read more narrowly
 * than the scanner reads it only makes the check stricter.
 */
const ROOT_SKIPPED_NAMES = new Set([
  'node_modules',
  'dist',
  'build',
  'pkg',
  'test-vault',
  '.pnpm-store',
  'esbuild.config.mjs',
  'version-bump.mjs',
  'automation',
  'e2e-tests',
]);

/** The review's skips as ESLint ignore patterns. ESLint skips everything inside a matched folder. */
const SCANNER_IGNORES = SCANNER_SKIPPED_NAMES.map((name) =>
  ROOT_SKIPPED_NAMES.has(name) ? name : `**/${name}`,
);

/**
 * The review's ESLint configuration: eslint-plugin-obsidianmd's recommended config as published,
 * after the parser options its maintainers document for the scanner, and the review's skips.
 * Nothing is turned off or down.
 */
export function scannerLintConfig(root: string): Linter.Config[] {
  return [
    {
      languageOptions: {
        parserOptions: {
          projectService: { allowDefaultProject: ['eslint.config.js', 'manifest.json'] },
          tsconfigRootDir: root,
          extraFileExtensions: ['.json'],
        },
      },
    },
    ...obsidianmd.configs.recommended,
    { ignores: SCANNER_IGNORES },
  ];
}

const REVIEW_CODE_EXTENSIONS = ['.ts', '.cts', '.mts', '.tsx', '.js', '.cjs', '.mjs', '.jsx'];

/** Whether the review lints `file`, a path from the repository root, as code. */
export function isReviewCode(file: string): boolean {
  return (
    file === 'package.json' || REVIEW_CODE_EXTENSIONS.some((extension) => file.endsWith(extension))
  );
}

/**
 * The Electron version of each Obsidian release, from stylelint-config-obsidianmd's README. The
 * README also lists 1.13.4 (Electron 43), but the review reports every minAppVersion from 1.12.3
 * to 1.13.7 against 1.11.4, so the table stops there, the stricter of the two.
 */
const ELECTRON_OF_OBSIDIAN: ReadonlyArray<readonly [string, number]> = [
  ['1.4.5', 25],
  ['1.5.8', 28],
  ['1.6.5', 30],
  ['1.7.4', 31],
  ['1.9.12', 37],
  ['1.11.4', 39],
];
const ELECTRON_BELOW_THE_TABLE = 25;

function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * The Electron version the review checks CSS against: that of the newest listed Obsidian release
 * at or below `minAppVersion`.
 */
export function browserBaseline(minAppVersion: string): number {
  const listed = ELECTRON_OF_OBSIDIAN.filter(
    ([obsidian]) => compareVersions(obsidian, minAppVersion) <= 0,
  );
  return listed[listed.length - 1]?.[1] ?? ELECTRON_BELOW_THE_TABLE;
}

/** The manifest's `minAppVersion`, which sets the browser baseline of the review's CSS rules. */
export function manifestMinAppVersion(root: string): string {
  const { minAppVersion } = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')) as {
    readonly minAppVersion: string;
  };
  return minAppVersion;
}

const [browserRuleOn, browserRuleOptions] =
  obsidianCss.rules['plugin/no-unsupported-browser-features'];

/**
 * The review's stylelint configuration: stylelint-config-obsidianmd's own plugin and rules, without
 * the standard base that no review report shows, with browser support checked at the baseline of
 * `minAppVersion`.
 */
export function reviewCssConfig(minAppVersion: string): Config {
  return {
    plugins: obsidianCss.plugins,
    rules: {
      ...obsidianCss.rules,
      'plugin/no-unsupported-browser-features': [
        browserRuleOn,
        { ...browserRuleOptions, browsers: [`electron >= ${browserBaseline(minAppVersion)}`] },
      ],
    },
  };
}

/** The folder the review's CSS plugin resolves from: pnpm keeps it next to the config package. */
export function reviewCssBasedir(root: string): string {
  return realpathSync(path.join(root, 'node_modules', 'stylelint-config-obsidianmd'));
}

/**
 * An ESLint result as the findings read it. A parse error that stops a whole file, such as a file
 * outside every TypeScript project, names no line, whatever ESLint's types say.
 */
interface LintedFile {
  readonly filePath: string;
  readonly messages: ReadonlyArray<{
    readonly line?: number;
    readonly ruleId: string | null;
    readonly message: string;
  }>;
}

/** Collapses a multi-line message into the one line a finding takes. */
function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/**
 * One `path:line rule message` line per finding: each ESLint message, parse errors included, and
 * each stylelint warning, parse error, and invalid option. A finding without a line takes line 0.
 */
export function reviewFindings(
  eslintResults: readonly LintedFile[],
  stylelintResults: readonly LintResult[],
  root: string,
): string[] {
  const relative = (file: string): string => path.relative(root, file);
  return [
    ...eslintResults.flatMap(({ filePath, messages }) =>
      messages.map(
        ({ line = 0, ruleId, message }) =>
          `${relative(filePath)}:${line} ${ruleId ?? 'parse-error'} ${oneLine(message)}`,
      ),
    ),
    ...stylelintResults.flatMap(({ source, warnings, parseErrors, invalidOptionWarnings }) => {
      const file = source === undefined ? '<input>' : relative(source);
      return [
        ...warnings.map(({ line, rule, text }) => `${file}:${line} ${rule} ${oneLine(text)}`),
        ...parseErrors.map(
          ({ line, stylelintType, text }) => `${file}:${line} ${stylelintType} ${oneLine(text)}`,
        ),
        ...invalidOptionWarnings.map(({ text }) => `${file}:0 invalid-option ${oneLine(text)}`),
      ];
    }),
  ];
}
