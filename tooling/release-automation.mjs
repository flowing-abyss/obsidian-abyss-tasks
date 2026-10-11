import { execFileSync } from 'node:child_process';
import {
  accessSync,
  appendFileSync,
  constants,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';
import process from 'node:process';
import { isDeepStrictEqual } from 'node:util';

/** @typedef {Record<string, unknown>} JsonObject */
/** @typedef {{package: JsonObject, manifest: JsonObject, versions: JsonObject}} Metadata */
const root = process.cwd();
const stableVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const versionFiles = ['manifest.json', 'package.json', 'versions.json'];
const commitId = /^[a-f\d]{40}$/u;

/** Resolve Git outside the checkout so authored files cannot shadow the tool.
 * @returns {string}
 */
function gitExecutable() {
  for (const directory of (process.env['PATH'] ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    try {
      const candidate = realpathSync(path.join(directory, 'git'));
      const relative = path.relative(root, candidate);
      if (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) continue;
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Missing or inaccessible entries are not Git executables.
    }
  }
  throw new Error('Git is unavailable outside the checkout.');
}
const gitPath = gitExecutable();

/** @param {unknown} value @returns {JsonObject} */
function object(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected a JSON object.');
  return /** @type {JsonObject} */ (value);
}

/** @param {string[]} args @returns {string} */
function git(args) {
  return execFileSync(gitPath, args, { cwd: root, encoding: 'utf8', timeout: 10_000 }).trim();
}

/** @param {string} file @param {string | undefined} revision @returns {JsonObject} */
function json(file, revision) {
  return object(
    JSON.parse(
      revision === undefined
        ? readFileSync(path.join(root, file), 'utf8')
        : git(['show', `${revision}:${file}`]),
    ),
  );
}

/** @param {string | undefined} revision @returns {Metadata} */
function metadata(revision) {
  return {
    package: json('package.json', revision),
    manifest: json('manifest.json', revision),
    versions: json('versions.json', revision),
  };
}

/** @param {unknown} value @returns {string} */
function version(value) {
  if (
    typeof value !== 'string' ||
    !stableVersion.test(value) ||
    !value.split('.').every((part) => Number.isSafeInteger(Number(part)))
  )
    throw new Error('Release versions must use stable x.y.z numbers.');
  return value;
}

/** @param {Metadata} value @returns {string} */
function synchronizedVersion(value) {
  const current = version(value.manifest['version']);
  const minimum = version(value.manifest['minAppVersion']);
  if (
    value.manifest['id'] !== 'abyss-tasks' ||
    value.package['version'] !== current ||
    value.versions[current] !== minimum
  )
    throw new Error('Package, manifest and version history must agree before preparing a release.');
  return current;
}

/** @param {string} current @returns {string} */
function nextPatch(current) {
  const separator = current.lastIndexOf('.');
  const patch = Number(current.slice(separator + 1));
  if (patch >= Number.MAX_SAFE_INTEGER) throw new Error('The patch number cannot be incremented.');
  return `${current.slice(0, separator + 1)}${patch + 1}`;
}

/** @param {JsonObject} value @returns {JsonObject} */
function withoutVersion(value) {
  const copy = { ...value };
  delete copy['version'];
  return copy;
}

/** @param {Metadata} before @param {Metadata} after @returns {string} */
function patchMetadata(before, after) {
  const target = synchronizedVersion(after);
  if (
    target !== nextPatch(synchronizedVersion(before)) ||
    Object.prototype.hasOwnProperty.call(before.versions, target) ||
    !isDeepStrictEqual(withoutVersion(before.package), withoutVersion(after.package)) ||
    !isDeepStrictEqual(withoutVersion(before.manifest), withoutVersion(after.manifest)) ||
    !isDeepStrictEqual(after.versions, {
      ...before.versions,
      [target]: after.manifest['minAppVersion'],
    })
  )
    throw new Error(
      'Release PRs may only increment the patch version and append its version record.',
    );
  return target;
}

/** @param {Record<string, string>} values */
function output(values) {
  const outputPath = process.env['GITHUB_OUTPUT'];
  if (outputPath !== undefined)
    appendFileSync(
      outputPath,
      Object.entries(values)
        .map(([name, value]) => `${name}=${value}\n`)
        .join(''),
    );
  process.stdout.write(`${JSON.stringify(values)}\n`);
}

function requireManualMaster() {
  if (
    process.env['GITHUB_EVENT_NAME'] !== 'workflow_dispatch' ||
    process.env['GITHUB_REF'] !== 'refs/heads/master'
  )
    throw new Error('Prepare patch release must be run manually from master.');
}

function prepare() {
  requireManualMaster();
  if (git(['status', '--porcelain']).length !== 0)
    throw new Error('Release preparation requires a clean checkout.');
  const before = metadata(undefined);
  const target = nextPatch(synchronizedVersion(before));
  if (Object.prototype.hasOwnProperty.call(before.versions, target))
    throw new Error('The next patch version already exists.');
  writeFileSync(
    path.join(root, 'package.json'),
    `${JSON.stringify({ ...before.package, version: target }, null, 2)}\n`,
  );
  execFileSync(process.execPath, [path.join(root, 'version-bump.mjs')], {
    cwd: root,
    env: { ...process.env, npm_package_version: target },
    stdio: 'pipe',
  });
  patchMetadata(before, metadata(undefined));
  if (
    !isDeepStrictEqual(
      git(['diff', '--name-only'])
        .split('\n')
        .sort((a, b) => a.localeCompare(b)),
      versionFiles,
    )
  )
    throw new Error('Release preparation changed files outside version metadata.');
  output({ version: target, branch: `release/patch-${target}` });
}

function reuse() {
  requireManualMaster();
  const expected = metadata(undefined);
  const target = patchMetadata(metadata('HEAD'), expected);
  const sha = git([
    'rev-parse',
    '--verify',
    `refs/remotes/origin/release/patch-${target}^{commit}`,
  ]);
  const base = git(['merge-base', 'HEAD', sha]);
  const changed = git(['diff', '--name-only', base, sha])
    .split('\n')
    .sort((a, b) => a.localeCompare(b));
  if (!isDeepStrictEqual(changed, versionFiles))
    throw new Error('The existing release branch changes files outside version metadata.');
  const existing = metadata(sha);
  if (patchMetadata(metadata(base), existing) !== target || !isDeepStrictEqual(existing, expected))
    throw new Error('The existing release branch does not match the prepared patch metadata.');
  output({ version: target, sha });
}

/** @returns {string} */
function repositoryName() {
  const name = process.env['GITHUB_REPOSITORY'];
  if (name === undefined || !/^[\w-]+\/[\w.-]+$/u.test(name))
    throw new Error('GITHUB_REPOSITORY must identify the workflow repository.');
  return name;
}

/** @param {string} route @param {JsonObject | undefined} body @param {boolean} missing @returns {Promise<unknown>} */
async function api(route, body = undefined, missing = false) {
  const token = process.env[body === undefined ? 'GITHUB_TOKEN' : 'RELEASE_TOKEN'];
  if (token === undefined || token.length === 0)
    throw new Error('The required GitHub token is missing.');
  const baseUrl = process.env['GITHUB_API_URL'] ?? 'https://api.github.com';
  const url = new URL(`${baseUrl.replace(/\/$/u, '')}/repos/${repositoryName()}/${route}`);
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error('The GitHub API URL must use HTTP or HTTPS.');
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const outgoing = request(
      url,
      {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'abyss-automation',
          'X-GitHub-Api-Version': '2026-03-10',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        signal: AbortSignal.timeout(30_000),
      },
      (response) => {
        let raw = '';
        response.setEncoding('utf8');
        response.on('data', (/** @type {string} */ chunk) => {
          raw += chunk;
        });
        response.once('error', reject);
        response.once('end', () => {
          const status = response.statusCode ?? 0;
          if (missing && status === 404) {
            resolve(undefined);
            return;
          }
          if (status < 200 || status >= 300) {
            reject(new Error(`GitHub ${route} returned HTTP ${status}.`));
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    outgoing.once('error', reject);
    outgoing.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/** @param {string} route @returns {Promise<JsonObject[]>} */
async function allPages(route) {
  /** @type {JsonObject[]} */
  const values = [];
  for (let page = 1; page <= 100; page += 1) {
    const result = await api(`${route}?per_page=100&page=${page}`);
    if (!Array.isArray(result)) throw new Error('GitHub returned an invalid list.');
    values.push(...result.map(object));
    if (result.length < 100) return values;
  }
  throw new Error('GitHub pagination did not finish.');
}

/** @param {JsonObject} run @param {unknown} workflowId @returns {boolean} */
function trustedRun(run, workflowId) {
  const repository = repositoryName();
  return (
    run['workflow_id'] === workflowId &&
    run['event'] === 'push' &&
    run['head_branch'] === 'master' &&
    run['status'] === 'completed' &&
    run['conclusion'] === 'success' &&
    object(run['repository'])['full_name'] === repository &&
    object(run['head_repository'])['full_name'] === repository
  );
}

/** @param {JsonObject} pull @param {string} sha @returns {boolean} */
function trustedPull(pull, sha) {
  const head = object(pull['head']);
  const base = object(pull['base']);
  const repository = repositoryName();
  return (
    pull['state'] === 'closed' &&
    pull['merged'] === true &&
    typeof pull['merged_at'] === 'string' &&
    pull['merge_commit_sha'] === sha &&
    object(pull['user'])['login'] === 'abyss-automation[bot]' &&
    base['ref'] === 'master' &&
    object(base['repo'])['full_name'] === repository &&
    typeof head['ref'] === 'string' &&
    head['ref'].startsWith('release/patch-') &&
    object(head['repo'])['full_name'] === repository
  );
}

/** @returns {Promise<Record<string, string> | undefined>} */
async function candidate() {
  if (process.env['GITHUB_EVENT_NAME'] !== 'workflow_run') return undefined;
  const eventPath = process.env['GITHUB_EVENT_PATH'];
  if (eventPath === undefined) throw new Error('The workflow event payload is missing.');
  const event = object(JSON.parse(readFileSync(eventPath, 'utf8')));
  const suppliedRun = object(event['workflow_run']);
  const runId = suppliedRun['id'];
  if (!Number.isSafeInteger(runId) || typeof runId !== 'number' || runId <= 0)
    throw new Error('The workflow run ID is invalid.');
  const workflow = object(await api('actions/workflows/ci.yml'));
  if (workflow['path'] !== '.github/workflows/ci.yml' || !Number.isSafeInteger(workflow['id']))
    throw new Error('The repository CI workflow could not be identified.');
  const run = object(await api(`actions/runs/${runId}`));
  if (
    !trustedRun(suppliedRun, workflow['id']) ||
    !trustedRun(run, workflow['id']) ||
    run['id'] !== runId
  )
    return undefined;
  const sha = run['head_sha'];
  if (typeof sha !== 'string' || !commitId.test(sha) || suppliedRun['head_sha'] !== sha)
    throw new Error('The CI event does not identify the verified commit.');

  const pull = await findReleasePull(sha);
  if (pull === undefined) return undefined;
  const target = verifyReleaseMetadata(pull, sha);
  return { version: target, sha, pull_request: String(pull['number']) };
}

/** @param {string} sha @returns {Promise<JsonObject | undefined>} */
async function findReleasePull(sha) {
  const associated = await allPages(`commits/${sha}/pulls`);
  /** @type {JsonObject[]} */
  const releases = [];
  for (const summary of associated) {
    const branch = object(summary['head'])['ref'];
    if (typeof branch !== 'string' || !branch.startsWith('release/patch-')) continue;
    const number = summary['number'];
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0)
      throw new Error('The release PR number is invalid.');
    const pull = object(await api(`pulls/${number}`));
    if (trustedPull(pull, sha)) releases.push(pull);
  }
  if (releases.length === 0) return undefined;
  if (releases.length !== 1)
    throw new Error('The verified commit identifies multiple release PRs.');
  const pull = releases[0];
  if (pull === undefined) throw new Error('The release PR is missing.');
  const files = await allPages(`pulls/${pull['number']}/files`);
  const names = files.map((file) => {
    const name = file['filename'];
    if (typeof name !== 'string') throw new Error('GitHub returned an invalid PR filename.');
    return name;
  });
  names.sort((a, b) => a.localeCompare(b));
  if (!isDeepStrictEqual(names, versionFiles))
    throw new Error('A release PR may change only package, manifest and version history.');
  return pull;
}

/** @param {JsonObject} pull @param {string} sha @returns {string} */
function verifyReleaseMetadata(pull, sha) {
  git(['merge-base', '--is-ancestor', sha, 'refs/remotes/origin/master']);
  const changed = git(['diff', '--name-only', `${sha}^`, sha])
    .split('\n')
    .sort((a, b) => a.localeCompare(b));
  if (!isDeepStrictEqual(changed, versionFiles))
    throw new Error('The merged release changes files outside version metadata.');
  const target = patchMetadata(metadata(`${sha}^`), metadata(sha));
  if (object(pull['head'])['ref'] !== `release/patch-${target}`)
    throw new Error('The release branch does not match the verified patch version.');
  return target;
}

/** @param {string} target @returns {Promise<string | undefined>} */
async function existingTag(target) {
  const reference = await api(`git/ref/tags/${target}`, undefined, true);
  if (reference === undefined) return undefined;
  let value = object(object(reference)['object']);
  for (let depth = 0; depth < 5; depth += 1) {
    const sha = value['sha'];
    if (typeof sha !== 'string' || !commitId.test(sha))
      throw new Error('GitHub returned an invalid tag.');
    if (value['type'] === 'commit') return sha;
    if (value['type'] !== 'tag') throw new Error('The release tag does not identify a commit.');
    value = object(object(await api(`git/tags/${sha}`))['object']);
  }
  throw new Error('The annotated release tag could not be resolved.');
}

async function tag() {
  const release = await candidate();
  if (
    release === undefined ||
    process.env['CANDIDATE_SHA'] !== release['sha'] ||
    process.env['RELEASE_VERSION'] !== release['version']
  )
    throw new Error('No exact merged patch PR with successful master CI authorizes this tag.');
  const target = release['version'];
  const sha = release['sha'];
  if (target === undefined || sha === undefined)
    throw new Error('The release candidate is incomplete.');
  const existing = await existingTag(target);
  if (existing !== undefined) {
    if (existing !== sha) throw new Error('The existing version tag points at another commit.');
    output({ ...release, created: 'false' });
    return;
  }
  try {
    await api('git/refs', { ref: `refs/tags/${target}`, sha });
  } catch (error) {
    if ((await existingTag(target)) !== sha) throw error;
    output({ ...release, created: 'false' });
    return;
  }
  output({ ...release, created: 'true' });
}

try {
  if (process.argv[2] === 'prepare') prepare();
  else if (process.argv[2] === 'reuse') reuse();
  else if (process.argv[2] === 'candidate') output((await candidate()) ?? {});
  else if (process.argv[2] === 'tag') await tag();
  else throw new Error('Expected prepare, reuse, candidate or tag release automation command.');
} catch (error) {
  process.stderr.write(
    `Release automation failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  process.exitCode = 1;
}
