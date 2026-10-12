import { ESLint } from 'eslint';
import regexp from 'eslint-plugin-regexp';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tseslint from 'typescript-eslint';
import { validateReviews } from './regex-audit-policy.mjs';
import { runBoundedChild } from './regex-audit-process.mjs';
export { runBoundedChild } from './regex-audit-process.mjs';

const require = createRequire(import.meta.url);
/** @type {import('eslint').ESLint.Plugin} */
const redos = require('eslint-plugin-redos');
const ROOT = path.resolve(import.meta.dirname, '..');
const options = {
  'regexp/no-super-linear-backtracking': { report: 'certain' },
  'regexp/no-super-linear-move': { report: 'certain' },
  'redos/no-vulnerable': { timeout: 10000, cache: false, ignoreErrors: false },
};
/** Manual flat registration: the published redos 4.5.0 preset is legacy-only. @type {import('eslint').Linter.Config[]} */
export const auditConfig = [
  {
    files: ['**/*.ts', '**/*.js'],
    languageOptions: { parser: tseslint.parser, parserOptions: { project: false } },
    plugins: { regexp, redos },
    rules: Object.fromEntries(
      Object.entries(options).map(([name, settings]) => [name, ['error', settings]]),
    ),
  },
];

/** @param {string} file @returns {Promise<string>} */
async function hashFile(file) {
  return createHash('sha256')
    .update(await readFile(path.resolve(ROOT, file)))
    .digest('hex');
}

async function analyzerIdentity() {
  /** @type {{version: string}} */
  const redosPackage = JSON.parse(
    await readFile(require.resolve('eslint-plugin-redos/package.json'), 'utf8'),
  );
  return { regexp: regexp.meta.version, redos: redosPackage.version, options };
}

async function analyze() {
  const lint = new ESLint({
    cwd: ROOT,
    overrideConfigFile: true,
    overrideConfig: auditConfig,
    cache: false,
  });
  const results = await lint.lintFiles(['src/**/*.ts']);
  return { ...(await collectFindings(results)), analyzer: await analyzerIdentity() };
}

/**
 * Collect exact occurrence and source identities from analyzer results.
 * @param {import('eslint').ESLint.LintResult[]} results
 * @param {string} [root]
 * @param {typeof path} [paths]
 */
export async function collectFindings(results, root = ROOT, paths = path) {
  /** @type {import('./regex-audit-policy.mjs').Finding[]} */
  const findings = [];
  /** @type {Record<string, string>} */
  const sourceHashes = {};
  for (const result of results) {
    const file = paths.relative(root, result.filePath).split(paths.sep).join('/');
    const source = result.source ?? (await readFile(result.filePath, 'utf8'));
    sourceHashes[file] = createHash('sha256').update(source).digest('hex');
    for (const message of result.messages) {
      if (message.fatal || !message.ruleId) throw new Error(`${file}: ${message.message}`);
      findings.push({
        file,
        line: message.line,
        column: message.column,
        endLine: message.endLine ?? message.line,
        endColumn: message.endColumn ?? message.column,
        ruleId: message.ruleId,
        messageId: message.messageId ?? '',
        message: message.message,
        raw: source
          .split(/\r?\n/u)
          .slice(message.line - 1, message.endLine ?? message.line)
          .join('\n'),
        unproven:
          message.ruleId === 'redos/no-vulnerable' &&
          message.message.startsWith('Error on ReDoS vulnerability check:'),
      });
    }
  }
  return { findings, sourceHashes };
}

async function audit() {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    /** @type {Awaited<ReturnType<typeof analyze>>} */
    const result = /** @type {Awaited<ReturnType<typeof analyze>>} */ (
      await runBoundedChild([fileURLToPath(import.meta.url), '--analyze'], { signal: abort.signal })
    );
    /** @type {import('./regex-audit-policy.mjs').Review[]} */
    const reviews = JSON.parse(
      await readFile(path.join(ROOT, 'tooling/regex-audit-reviews.json'), 'utf8'),
    );
    /** @type {Record<string, string>} */
    const guardHashes = {};
    for (const review of reviews) {
      for (const guard of Object.keys(review.guards)) guardHashes[guard] = await hashFile(guard);
    }
    for (const [file, hash] of Object.entries(result.sourceHashes)) {
      if ((await hashFile(file)) !== hash) throw new Error(`source changed during audit: ${file}`);
    }
    const report = validateReviews(result.findings, reviews, { ...result, guardHashes });
    const dumpIndex = process.argv.indexOf('--dump');
    if (dumpIndex >= 0) {
      const destination = process.argv[dumpIndex + 1] ?? '';
      const resolved = path.resolve(ROOT, destination);
      const ignored = ['.superpowers', 'docs'].some((folder) =>
        resolved.startsWith(path.join(ROOT, folder) + path.sep),
      );
      if (!ignored) throw new Error('diagnostic dump must be in ignored evidence');
      await writeFile(
        path.resolve(ROOT, destination),
        JSON.stringify({ ...result, report }, null, 2),
      );
    }
    process.stdout.write(
      `Regex audit (cold, no cache): ${result.findings.length} findings; ${report.reviewed} reviewed, ${report.unproven} visibly unproven.\n`,
    );
    for (const finding of result.findings.filter((item) => item.unproven)) {
      process.stdout.write(
        `UNPROVEN ${finding.file}:${finding.line}:${finding.column}: ${finding.message}\n`,
      );
    }
    for (const error of report.errors) process.stderr.write(`${error}\n`);
    if (report.errors.length) process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes('--analyze')) process.stdout.write(JSON.stringify(await analyze()));
    else await audit();
  } catch (error) {
    process.stderr.write(
      `Regex audit failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
