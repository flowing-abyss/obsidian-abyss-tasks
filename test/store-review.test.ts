import { ESLint, type Linter } from 'eslint';
import stylelint from 'stylelint';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  browserBaseline,
  isReviewCode,
  manifestMinAppVersion,
  reviewCssBasedir,
  reviewCssConfig,
  reviewFindings,
  scannerLintConfig,
} from './support/storeReview';

const ROOT = ts.sys.resolvePath(`${import.meta.dirname}/..`);
// The rows that run ESLint or stylelint load the linters' plugins on first use, and CI runs them
// under coverage on slower machines.
const LINTER_TIMEOUT_MS = 30_000;

function readRepositoryFile(path: string): string {
  const text = ts.sys.readFile(ts.sys.resolvePath(`${ROOT}/${path}`));
  if (text === undefined) throw new Error(`Expected ${path} to be readable`);
  return text;
}

interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly dependencies?: Readonly<Record<string, string>>;
}

function readManifest(path: string): PackageManifest {
  return JSON.parse(readRepositoryFile(path)) as PackageManifest;
}

describe('README', () => {
  const readme = readRepositoryFile('README.md');

  it('is titled with the plugin name from the manifest', () => {
    expect(readme.split('\n')[0]).toBe(`# ${readManifest('manifest.json').name}`);
  });

  it('has an installation and a usage section', () => {
    const headings = readme.split('\n').filter((line) => line.startsWith('## '));

    expect(headings).toContain('## Installation');
    expect(headings).toContain('## Usage');
  });

  it('carries the licence of the bundled rrule package verbatim, with its version', () => {
    const { version } = readManifest('node_modules/rrule/package.json');

    expect(readme).toContain(readRepositoryFile('node_modules/rrule/LICENCE'));
    expect(readme).toContain(`[rrule](https://github.com/jkbrzt/rrule) ${version},`);
  });

  // Every runtime package is bundled into main.js, so a new one needs its own notice decision.
  it('bundles rrule as the only runtime package', () => {
    expect(Object.keys(readManifest('package.json').dependencies ?? {})).toEqual(['rrule']);
  });
});

describe('Store review configuration', () => {
  const scanner = new ESLint({
    cwd: ROOT,
    overrideConfigFile: true,
    overrideConfig: scannerLintConfig(ROOT),
  });

  async function reviewCss(options: { files?: string[]; code?: string }, version: string) {
    const { results } = await stylelint.lint({
      ...options,
      codeFilename: `${ROOT}/fixture.css`,
      config: reviewCssConfig(version),
      configBasedir: reviewCssBasedir(ROOT),
    });
    return results;
  }

  it.each([
    ['1.4.0', 25],
    ['1.6.5', 30],
    ['1.7.2', 30],
    ['1.13.4', 39],
  ])('checks CSS for minAppVersion %s against Electron %i', (version, electron) => {
    expect(browserBaseline(version)).toBe(electron);
  });

  it("sets the browser rule's baseline and keeps its other options", () => {
    expect(reviewCssConfig('1.7.2').rules?.['plugin/no-unsupported-browser-features']).toEqual([
      true,
      {
        severity: 'warning',
        browsers: ['electron >= 30'],
        ignore: ['css-nesting', 'css-cascade-layers'],
      },
    ]);
  });

  it.each([
    ['src/main.ts', true],
    ['tooling/check-css.mjs', true],
    ['package.json', true],
    ['src/package.json', false],
    ['styles.css', false],
    ['README.md', false],
  ])('treats %s as review code: %s', (file, code) => {
    expect(isReviewCode(file)).toBe(code);
  });

  it.each([
    'src/main.ts',
    'vitest.config.ts',
    'vitest.store.config.ts',
    'package.json',
    'src/build/example.ts',
    'src/automation/example.ts',
    'src/dist/example.ts',
    'src/pkg/example.ts',
    'src/test-vault/example.ts',
    'src/.pnpm-store/example.ts',
    'src/e2e-tests/example.ts',
  ])(
    'lints %s',
    async (file) => {
      expect(await scanner.isPathIgnored(`${ROOT}/${file}`)).toBe(false);
    },
    LINTER_TIMEOUT_MS,
  );

  it.each([
    'test/store-review.test.ts',
    'test/types/stylelint-config-obsidianmd.d.ts',
    'esbuild.config.mjs',
    'tooling/check-css.mjs',
    '.ai/scripts/pi/pnpm-policy.ts',
    '.ai/skills/writing-skills/render-graphs.cjs',
    'docs/example.ts',
    'build/example.ts',
    'automation/example.ts',
  ])(
    'skips %s',
    async (file) => {
      expect(await scanner.isPathIgnored(`${ROOT}/${file}`)).toBe(true);
    },
    LINTER_TIMEOUT_MS,
  );

  it(
    'parses plugin source with the scanner options and turns the console rule on',
    async () => {
      const config = (await scanner.calculateConfigForFile(`${ROOT}/src/main.ts`)) as Linter.Config;

      expect(config.languageOptions?.['parserOptions']).toMatchObject({
        projectService: { allowDefaultProject: ['eslint.config.js', 'manifest.json'] },
        tsconfigRootDir: ROOT,
        extraFileExtensions: ['.json'],
      });
      expect(config.rules?.['obsidianmd/rule-custom-message']).toEqual([2, expect.anything()]);
    },
    LINTER_TIMEOUT_MS,
  );

  it(
    'finds nothing in styles.css at the manifest baseline',
    async () => {
      const results = await reviewCss(
        { files: [`${ROOT}/styles.css`] },
        manifestMinAppVersion(ROOT),
      );

      expect(results.map(({ source }) => source)).toEqual([`${ROOT}/styles.css`]);
      expect(reviewFindings([], results, ROOT)).toEqual([]);
    },
    LINTER_TIMEOUT_MS,
  );

  it.each([
    [
      'a :has() selector',
      '.abyss-a:has(.abyss-b) {\n  padding: 0;\n}\n',
      'selector-pseudo-class-disallowed-list',
    ],
    [
      'an !important declaration',
      '.abyss-a {\n  padding: 0 !important;\n}\n',
      'declaration-no-important',
    ],
    [
      'a clip-path inset',
      '.abyss-a {\n  clip-path: inset(50%);\n}\n',
      'plugin/no-unsupported-browser-features',
    ],
  ])(
    'reports %s',
    async (_kind, code, rule) => {
      const results = await reviewCss({ code }, '1.7.2');

      expect(results.flatMap(({ warnings }) => warnings.map((warning) => warning.rule))).toEqual([
        rule,
      ]);
    },
    LINTER_TIMEOUT_MS,
  );

  it(
    'writes one line for each finding, parse errors and invalid options included',
    async () => {
      const plain = new ESLint({
        cwd: ROOT,
        overrideConfigFile: true,
        overrideConfig: [{ rules: { 'no-console': 'warn' } }],
      });
      const eslintResults = [
        ...(await plain.lintText('const = 1;\n', { filePath: `${ROOT}/broken.js` })),
        ...(await plain.lintText('console.info(1);\n', { filePath: `${ROOT}/noisy.js` })),
        ...(await plain.lintText('export const quiet = 1;\n', { filePath: `${ROOT}/quiet.js` })),
        // A file outside every TypeScript project, as the four `.ai` files were on master: the
        // project service's parse error names no line and spans two lines of text.
        {
          filePath: `${ROOT}/.ai/example.ts`,
          messages: [
            {
              ruleId: null,
              message:
                'Parsing error: .ai/example.ts was not found by the project service.\nSee why.',
            },
          ],
        },
      ];
      const { results: stylelintResults } = await stylelint.lint({
        code: '.abyss-a {\n  padding: 0 !important;\n}\n.abyss-b : .abyss-c {\n  padding: 0;\n}\n',
        codeFilename: `${ROOT}/fixture.css`,
        config: {
          rules: {
            'declaration-no-important': true,
            'color-named': ['never', { unknownOption: true }],
            // A rule that parses selectors, so stylelint reports the one it cannot parse.
            'selector-pseudo-class-no-unknown': true,
          },
        },
      });

      expect(reviewFindings(eslintResults, stylelintResults, ROOT)).toEqual([
        'broken.js:1 parse-error Parsing error: Unexpected token =',
        'noisy.js:1 no-console Unexpected console statement.',
        '.ai/example.ts:0 parse-error Parsing error: .ai/example.ts was not found by the project service. See why.',
        'fixture.css:2 declaration-no-important Disallowed !important (declaration-no-important)',
        'fixture.css:4 parseError Cannot parse selector (Error: Expected a pseudo-class or pseudo-element.)',
        'fixture.css:0 invalid-option Invalid option name "unknownOption" for rule "color-named"',
      ]);
    },
    LINTER_TIMEOUT_MS,
  );
});
