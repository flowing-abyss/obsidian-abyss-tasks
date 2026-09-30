import { ESLint } from 'eslint';
import stylelint from 'stylelint';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { repositoryFiles } from '../support/repositoryFiles';
import {
  isReviewCode,
  manifestMinAppVersion,
  reviewCssBasedir,
  reviewCssConfig,
  reviewFindings,
  scannerLintConfig,
} from '../support/storeReview';
import { CHILD_PROCESS_TIMEOUT_MS, LINTER_TIMEOUT_MS } from '../support/timeouts';

// The community directory's published review rules over what a clone of the repository holds.
// `pnpm lint:store` runs this file, outside the unit suite and its coverage.
const ROOT = ts.sys.resolvePath(`${import.meta.dirname}/../..`);
const FILES = repositoryFiles(ROOT);

describe('Community directory review', () => {
  it(
    'finds nothing in the code the review lints',
    async () => {
      const scanner = new ESLint({
        cwd: ROOT,
        overrideConfigFile: true,
        overrideConfig: scannerLintConfig(ROOT),
        warnIgnored: false,
      });
      const results = await scanner.lintFiles(
        FILES.filter(isReviewCode).map((file) => `${ROOT}/${file}`),
      );

      // Ignored files drop out of the results silently, so the files the pass must read are named
      // without the configuration: every plugin source file and package.json.
      const required = FILES.filter(
        (file) => isReviewCode(file) && (file.startsWith('src/') || file === 'package.json'),
      ).map((file) => `${ROOT}/${file}`);
      expect(results.map(({ filePath }) => filePath)).toEqual(expect.arrayContaining(required));
      expect(reviewFindings(results, [], ROOT)).toEqual([]);
    },
    LINTER_TIMEOUT_MS,
  );

  it(
    'finds nothing in the CSS the review lints',
    async () => {
      const cssFiles = FILES.filter((file) => file.endsWith('.css')).map(
        (file) => `${ROOT}/${file}`,
      );
      const { results } = await stylelint.lint({
        files: cssFiles,
        config: reviewCssConfig(manifestMinAppVersion(ROOT)),
        configBasedir: reviewCssBasedir(ROOT),
      });
      // stylelint leaves out a file that the project's .stylelintignore lists, which the review
      // does not read, so every file must come back linted.
      const linted = results.filter(({ ignored }) => ignored !== true).map(({ source }) => source);

      expect(linted).toContain(`${ROOT}/styles.css`);
      expect(new Set(linted)).toEqual(new Set(cssFiles));
      expect(reviewFindings([], results, ROOT)).toEqual([]);
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );
});
