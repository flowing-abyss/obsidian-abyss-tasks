import { ESLint } from 'eslint';
import regexp from 'eslint-plugin-regexp';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import tseslint from 'typescript-eslint';
import { validateReviews } from './regex-audit-policy.mjs';

const require = createRequire(import.meta.url);
/** @type {import('eslint').ESLint.Plugin} */
const redos = require('eslint-plugin-redos');
const ROOT = path.resolve(import.meta.dirname, '..');
const DEADLINE_MS = 90_000;
const options = {
  'regexp/no-super-linear-backtracking': { report: 'certain' },
  'regexp/no-super-linear-move': { report: 'certain' },
  'redos/no-vulnerable': { timeout: 1000, cache: false, ignoreErrors: false },
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

/**
 * POSIX descendants inherit the dedicated group; Windows requires taskkill's tree operation.
 * The published recheck worker/agent spawns do not detach from their owner's group.
 * @param {import('node:child_process').ChildProcess} child
 * @returns {Promise<string>} Empty on success, otherwise an actionable cleanup failure.
 */
async function terminateTree(child) {
  if (child.pid === undefined) return '';
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return '';
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ESRCH') return '';
      child.kill('SIGKILL');
      return `process-group termination failed: ${String(error)}`;
    }
  }
  return new Promise((resolve) => {
    const killer = spawn(
      path.win32.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'],
      { stdio: 'ignore', windowsHide: true },
    );
    let finished = false;
    /** @param {string} error */
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) child.kill('SIGKILL');
      killer.unref();
      resolve(error);
    };
    // Never wait for taskkill's close or reap indefinitely; errors stay visibly failed.
    const timer = setTimeout(() => {
      killer.kill('SIGKILL');
      finish('process-tree termination exceeded 1000ms');
    }, 1000);
    killer.once('error', (error) => finish(`process-tree termination failed: ${error.message}`));
    killer.once('exit', (code) =>
      finish(code === 0 ? '' : `process-tree termination exited ${code}`),
    );
  });
}

/**
 * A fresh Node process on every call; terminate its solver tree on deadline/cancellation/overflow.
 * Failure cleanup never awaits inherited pipe close or process reap.
 * @param {string[]} args @param {{deadlineMs?: number, signal?: AbortSignal}} [settings]
 * @returns {Promise<unknown>}
 */
export function runBoundedChild(args, settings = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let failure = '';
    const release = () => {
      clearTimeout(timer);
      settings.signal?.removeEventListener('abort', cancel);
    };
    /** @param {string} reason */
    const stop = (reason) => {
      if (failure) return;
      failure = reason;
      void terminateTree(child)
        .catch((error) => `process-tree termination failed: ${String(error)}`)
        .then((cleanupError) => {
          release();
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          reject(new Error(cleanupError ? `${reason}; ${cleanupError}` : reason));
        });
    };
    const timer = setTimeout(
      () => stop(`analyzer hard deadline exceeded (${settings.deadlineMs ?? DEADLINE_MS}ms)`),
      settings.deadlineMs ?? DEADLINE_MS,
    );
    const cancel = () => stop('analyzer cancelled');
    settings.signal?.addEventListener('abort', cancel, { once: true });
    if (settings.signal?.aborted) cancel();
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      if (failure) return;
      stdout += chunk;
      if (stdout.length > 10_000_000) stop('analyzer output limit exceeded');
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      if (failure) return;
      stderr += chunk;
      if (stderr.length > 1_000_000) stop('analyzer error output limit exceeded');
    });
    child.once('error', (error) => stop(`analyzer failed to start: ${error.message}`));
    child.once('close', (code) => {
      if (failure) return; // The bounded tree-termination path owns failure settlement.
      release();
      if (code !== 0 || stderr) {
        reject(new Error(`analyzer exited ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error('analyzer returned invalid JSON'));
      }
    });
  });
}

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
  /** @type {import('./regex-audit-policy.mjs').Finding[]} */
  const findings = [];
  /** @type {Record<string, string>} */
  const sourceHashes = {};
  for (const result of results) {
    const file = path.relative(ROOT, result.filePath);
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
  return { findings, sourceHashes, analyzer: await analyzerIdentity() };
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
