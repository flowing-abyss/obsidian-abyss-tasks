#!/usr/bin/env node
// One conservative selector for CI, pre-push and release preparation. Unknown changes use verify.
import { spawnSync } from 'node:child_process';
import {
  accessSync,
  appendFileSync,
  constants,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { delimiter, isAbsolute, join, relative, sep } from 'node:path';
import process from 'node:process';
import { isDeepStrictEqual } from 'node:util';
import {
  beginVerification,
  canReuseVerification,
  finishVerification,
} from './verification-receipt.mjs';

/** @typedef {{mode: 'light' | 'full', reason: string}} Decision */
/** @typedef {{base: string, head?: string}} Range */
const documentation = new Set(['README.md', 'ARCHITECTURE.md', 'LICENSE']);
const versionFiles = new Set(['package.json', 'manifest.json', 'versions.json']);
const objectId = /^(?:[a-f\d]{40}|[a-f\d]{64})$/iu;
const semver = /^\d+\.\d+\.\d+$/u;
const cwd = process.cwd();
/** @type {Map<string, string>} */
const executables = new Map();

/** Resolve once, ignoring relative/checkout PATH entries that could shadow developer tools.
 * @param {string} command @returns {string}
 */
function executable(command) {
  const cached = executables.get(command);
  if (cached !== undefined) return cached;
  for (const directory of (process.env['PATH'] ?? '').split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    try {
      const candidate = realpathSync(join(directory, command));
      const fromCheckout = relative(cwd, candidate);
      if (!fromCheckout.startsWith(`..${sep}`) && !isAbsolute(fromCheckout)) continue;
      accessSync(candidate, constants.X_OK);
      if (!statSync(candidate).isFile()) continue;
      executables.set(command, candidate);
      return candidate;
    } catch {
      // Missing or inaccessible candidates are not executable tools.
    }
  }
  throw new Error(`The ${command} executable is unavailable outside the checkout.`);
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {string} command @param {string[]} args @returns {string} */
function output(command, args) {
  const result = spawnSync(executable(command), args, {
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
    env: process.env,
  });
  if (result.status !== 0) throw new Error(`${command} could not resolve verification history.`);
  return result.stdout;
}

/** @param {string[]} args @returns {string} */
function git(args) {
  return output('git', args);
}

/** @param {string} ref @returns {string} */
function commit(ref) {
  return git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim();
}

/** @param {string} base @param {string} head @returns {boolean} */
function isAncestor(base, head) {
  return (
    spawnSync(executable('git'), ['merge-base', '--is-ancestor', base, head], {
      cwd,
      encoding: 'utf8',
      timeout: 10_000,
    }).status === 0
  );
}

/** @param {string} raw @returns {Record<string, unknown>} */
function record(raw) {
  /** @type {unknown} */
  const value = JSON.parse(raw);
  if (!isRecord(value)) throw new Error('Metadata is not a JSON object.');
  return value;
}

/** @param {string} file @param {string | undefined} revision */
function snapshot(file, revision) {
  return record(
    revision === undefined ? readFileSync(file, 'utf8') : git(['show', `${revision}:${file}`]),
  );
}

/** @param {Record<string, unknown>} value */
function withoutVersion(value) {
  const copy = { ...value };
  delete copy['version'];
  return copy;
}

/** @param {Range} range @returns {boolean} */
function onlyVersionsChanged(range) {
  const oldPackage = snapshot('package.json', range.base);
  const newPackage = snapshot('package.json', range.head);
  const oldManifest = snapshot('manifest.json', range.base);
  const newManifest = snapshot('manifest.json', range.head);
  if (
    !isDeepStrictEqual(withoutVersion(oldPackage), withoutVersion(newPackage)) ||
    !isDeepStrictEqual(withoutVersion(oldManifest), withoutVersion(newManifest))
  )
    return false;

  const version = newManifest['version'];
  const minimum = newManifest['minAppVersion'];
  if (typeof version !== 'string' || newPackage['version'] !== version) return false;
  const before = snapshot('versions.json', range.base);
  const after = snapshot('versions.json', range.head);
  if (after[version] !== minimum) return false;
  const historyUnchanged = Object.entries(before).every(([key, value]) =>
    isDeepStrictEqual(after[key], value),
  );
  const additionsAreCurrent = Object.entries(after).every(
    ([key, value]) =>
      Object.prototype.hasOwnProperty.call(before, key) || (key === version && value === minimum),
  );
  return historyUnchanged && additionsAreCurrent;
}

/** @param {string} reason @returns {Decision} */
function full(reason) {
  return { mode: 'full', reason };
}

/** @param {Range} range @returns {Decision} */
function inspect(range) {
  try {
    const head = range.head ?? commit('HEAD');
    if (!isAncestor(range.base, head))
      return full('The verification base is missing or not ancestral.');
    const args = ['diff', '--name-only', '--no-renames', '-z', range.base];
    if (range.head !== undefined) args.push(range.head);
    const names = git(args).split('\0').filter(Boolean);
    if (range.head === undefined) {
      names.push(
        ...git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean),
      );
    }
    const significant = names.find((name) => !documentation.has(name) && !versionFiles.has(name));
    if (significant !== undefined)
      return full(`Behavior or tooling changed in ${JSON.stringify(significant)}.`);
    if (names.some((name) => versionFiles.has(name)) && !onlyVersionsChanged(range)) {
      return full('Metadata changes extend beyond version numbers and the current version record.');
    }
    return { mode: 'light', reason: 'Only documentation or version metadata changed.' };
  } catch {
    return full('Could not establish the complete Git or metadata comparison.');
  }
}

/** @returns {string} */
function repositoryName() {
  const configured = process.env['GITHUB_REPOSITORY'];
  if (configured !== undefined && /^[\w-]+\/[\w.-]+$/u.test(configured)) return configured;
  const repository = snapshot('package.json', undefined)['repository'];
  const url = isRecord(repository) ? repository['url'] : repository;
  if (typeof url !== 'string') throw new Error('No GitHub release repository is configured.');
  const name = /github\.com[:/]([\w-]+\/[\w.-]+?)(?:\.git)?$/u.exec(url)?.[1];
  if (name === undefined) throw new Error('No GitHub release repository is configured.');
  return name;
}

/** @param {unknown} release @param {string} excluded @returns {string | undefined} */
function publishedTag(release, excluded) {
  if (!isRecord(release)) return undefined;
  const tag = release['tag_name'];
  if (typeof tag !== 'string' || !semver.test(tag) || tag === excluded) return undefined;
  if (release['draft'] !== false || release['prerelease'] !== false) return undefined;
  const published = release['published_at'];
  return typeof published === 'string' && published.length > 0 ? tag : undefined;
}

/** @param {string} tag @param {string} head @returns {string | undefined} */
function reachableTag(tag, head) {
  try {
    const revision = commit(`refs/tags/${tag}`);
    return isAncestor(revision, head) ? revision : undefined;
  } catch {
    return undefined;
  }
}

/** @param {string} excluded @returns {string} */
function releaseBase(excluded) {
  /** @type {unknown} */
  const releases = JSON.parse(
    output('gh', ['api', `repos/${repositoryName()}/releases?per_page=100`]),
  );
  if (!Array.isArray(releases)) throw new Error('Published releases could not be read.');
  const head = commit('HEAD');
  for (const release of releases) {
    const tag = publishedTag(release, excluded);
    if (tag === undefined) continue;
    const revision = reachableTag(tag, head);
    if (revision !== undefined) return revision;
  }
  throw new Error('No reachable published stable release baseline is available.');
}

/** @returns {Range} */
function localRange() {
  let upstream;
  try {
    upstream = commit('@{upstream}');
  } catch {
    upstream = commit(git(['symbolic-ref', 'refs/remotes/origin/HEAD']).trim());
  }
  return { base: git(['merge-base', upstream, 'HEAD']).trim() };
}

/** @returns {Record<string, unknown>} */
function event() {
  const file = process.env['GITHUB_EVENT_PATH'];
  if (file === undefined) throw new Error('The GitHub event payload is unavailable.');
  return record(readFileSync(file, 'utf8'));
}

/** @param {unknown} value @returns {string} */
function eventCommit(value) {
  if (typeof value !== 'string' || !objectId.test(value) || /^0+$/u.test(value)) {
    throw new Error('The complete event commit range is unavailable.');
  }
  return commit(value);
}

/** @returns {Range} */
function githubRange() {
  const payload = event();
  if (process.env['GITHUB_EVENT_NAME'] === 'push') {
    return { base: eventCommit(payload['before']), head: eventCommit(payload['after']) };
  }
  const request = payload['pull_request'];
  if (!isRecord(request) || !isRecord(request['base']) || !isRecord(request['head'])) {
    throw new Error('The complete pull request range is unavailable.');
  }
  const base = eventCommit(request['base']['sha']);
  const head = eventCommit(request['head']['sha']);
  return { base: git(['merge-base', base, head]).trim(), head };
}

/** @param {boolean} release @returns {Decision} */
function contextDecision(release) {
  try {
    if (release) {
      const excluded =
        process.env['GITHUB_REF_TYPE'] === 'tag' ? (process.env['GITHUB_REF_NAME'] ?? '') : '';
      return inspect({ base: releaseBase(excluded), head: commit('HEAD') });
    }
    const kind = process.env['GITHUB_EVENT_NAME'];
    if (kind === undefined) return inspect(localRange());
    if (kind === 'push' || kind === 'pull_request') return inspect(githubRange());
    return full('This event requires the full verification gate.');
  } catch {
    return full(
      release
        ? 'The published release baseline is unavailable; running full verification.'
        : 'The complete comparison range is unavailable; running full verification.',
    );
  }
}

/** @param {Decision[]} decisions @returns {Decision} */
function strongest(decisions) {
  return (
    decisions.find((decision) => decision.mode === 'full') ?? {
      mode: 'light',
      reason: 'Only documentation or version metadata changed.',
    }
  );
}

/** @returns {Decision & {branchesOnly?: boolean}} */
function prePushDecision() {
  const lines = readFileSync(0, 'utf8').trim().split('\n').filter(Boolean);
  if (lines.length === 0) return full('No pre-push range was provided.');
  const current = commit('HEAD');
  /** @type {Decision[]} */
  const decisions = [];
  let branchesOnly = true;
  for (const line of lines) {
    const [localRef, localObject, remoteRef, remoteObject] = line.split(/\s+/u);
    if (
      localRef === undefined ||
      localObject === undefined ||
      remoteRef === undefined ||
      remoteObject === undefined ||
      !objectId.test(localObject) ||
      !objectId.test(remoteObject)
    ) {
      throw new Error('Cannot verify malformed pre-push ref updates.');
    }
    branchesOnly &&= !localRef.startsWith('refs/tags/') && remoteRef.startsWith('refs/heads/');
    if (/^0+$/u.test(localObject)) continue;
    if (commit(localObject) !== current) {
      throw new Error(
        'The pushed commit does not match this checkout. Check out that commit before pushing.',
      );
    }
    decisions.push(pushedRange(localRef, remoteObject, current));
  }
  return { ...strongest(decisions), branchesOnly };
}

/** @param {string} ref @param {string} remote @param {string} head @returns {Decision} */
function pushedRange(ref, remote, head) {
  if (!/^0+$/u.test(remote)) return inspect({ base: remote, head });
  if (!ref.startsWith('refs/tags/')) return full('A new branch has no verified remote base.');
  try {
    return inspect({ base: releaseBase(ref.slice('refs/tags/'.length)), head });
  } catch {
    return full('The published release baseline is unavailable; running full verification.');
  }
}

/** @param {Decision} decision @param {boolean} release @returns {string[][]} */
function commandsFor(decision, release) {
  const commands =
    decision.mode === 'full'
      ? [['run', 'verify']]
      : [
          ['run', 'format:check'],
          ['exec', 'eslint', 'package.json', 'manifest.json', 'LICENSE', '--max-warnings', '0'],
          ['run', 'release:check', '--metadata-only'],
        ];
  if (release) {
    if (decision.mode === 'light') {
      commands.push(['run', 'build'], ['run', 'release:artifacts'], ['run', 'lint:css:artifact']);
    }
    commands.push(['run', 'release:check', '--release-ready']);
  }
  return commands;
}

/** @param {string[]} args @param {{cwd: string, git: string, pnpm: string}} context */
function verifyFull(args, context) {
  if (args.length !== 1) throw new Error('--full cannot be combined with other options.');
  const started = beginVerification(context);
  const result = spawnSync(context.pnpm, ['run', 'verify:checks'], {
    cwd,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    return;
  }
  process.stdout.write(
    finishVerification(context, started)
      ? 'Full verification recorded for unchanged local inputs.\n'
      : 'Full verification passed; no reusable local receipt was recorded.\n',
  );
}

function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  if (args.some((arg) => !['--plan', '--pre-push', '--release', '--full'].includes(arg))) {
    throw new Error('Supported verification options are --plan, --pre-push, --release and --full.');
  }
  const context = { cwd, git: executable('git'), pnpm: executable('pnpm') };
  if (args.includes('--full')) return verifyFull(args, context);
  const release = args.includes('--release') || process.env['GITHUB_REF_TYPE'] === 'tag';
  const decision = args.includes('--pre-push') ? prePushDecision() : contextDecision(release);
  const selected = strongest([decision, inspect({ base: commit('HEAD') })]);
  const reused =
    args.includes('--pre-push') &&
    !release &&
    'branchesOnly' in decision &&
    decision.branchesOnly === true &&
    selected.mode === 'full' &&
    canReuseVerification(context);
  const commands = reused ? [['run', 'audit:dependencies']] : commandsFor(selected, release);
  if (args.includes('--plan')) {
    process.stdout.write(`${JSON.stringify({ ...selected, commands })}\n`);
    return;
  }
  process.stdout.write(`Verification ${selected.mode}: ${selected.reason}\n`);
  if (reused)
    process.stdout.write(
      'Reusing successful full verification; refreshing the dependency audit.\n',
    );
  const githubOutput = process.env['GITHUB_OUTPUT'];
  if (githubOutput !== undefined) appendFileSync(githubOutput, `mode=${selected.mode}\n`);
  for (const command of commands) {
    const result = spawnSync(executable('pnpm'), command, {
      cwd,
      env: process.env,
      stdio: 'inherit',
    });
    if (result.status !== 0) {
      process.stderr.write(`Verification stopped at pnpm ${command.join(' ')}.\n`);
      process.exitCode = result.status ?? 1;
      return;
    }
  }
  if (reused && !canReuseVerification(context)) {
    throw new Error(
      'Verification inputs changed during pre-push. Run pnpm verify before retrying.',
    );
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `Verification failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
