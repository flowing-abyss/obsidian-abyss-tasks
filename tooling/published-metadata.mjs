import { execFileSync } from 'node:child_process';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { isDeepStrictEqual } from 'node:util';

/** @typedef {Record<string, unknown>} JsonObject */
/** @typedef {{package: JsonObject, manifest: JsonObject, versions: JsonObject}} Metadata */
/** @typedef {{published: Metadata, tag: string, localCommit: string, remoteCommit: string, reachable: boolean, release: JsonObject}} Evidence */
const stable = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const commit = /^[a-f\d]{40}$/u;
/** @param {unknown} value @returns {value is JsonObject} */
function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** @param {unknown} value @returns {value is string} */
function version(value) {
  return (
    typeof value === 'string' &&
    stable.test(value) &&
    value.split('.').every((part) => Number.isSafeInteger(Number(part)))
  );
}
/** @param {unknown} value @returns {value is Metadata} */
function metadata(value) {
  return (
    object(value) &&
    object(value['package']) &&
    object(value['manifest']) &&
    object(value['versions'])
  );
}
/** @param {string} next @param {string} previous @returns {boolean} */
function increased(next, previous) {
  const a = next.split('.').map(Number);
  const b = previous.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return (a[index] ?? 0) > (b[index] ?? 0);
  }
  return false;
}
/** @param {Metadata} value @returns {boolean} */
function validPublished(value) {
  const current = value.manifest['version'];
  return (
    version(current) &&
    value.package['version'] === current &&
    value.manifest['id'] === 'abyss-tasks' &&
    version(value.manifest['minAppVersion']) &&
    value.versions[current] === value.manifest['minAppVersion'] &&
    Object.entries(value.versions).every(([key, minimum]) => version(key) && version(minimum))
  );
}
/** A development-only predicate. Publication and after-state checks stay strictly synchronized.
 * @param {unknown} current @param {unknown} evidence @returns {boolean} */
export function acceptsDevelopmentMinimum(current, evidence) {
  if (!metadata(current) || !object(evidence) || !metadata(evidence['published'])) return false;
  const published = evidence['published'];
  const release = evidence['release'];
  if (!validPublished(published) || !object(release)) return false;
  const tag = published.manifest['version'];
  const local = evidence['localCommit'];
  if (evidence['tag'] !== tag || release['tag_name'] !== tag || evidence['reachable'] !== true)
    return false;
  if (typeof local !== 'string' || !commit.test(local) || local !== evidence['remoteCommit'])
    return false;
  if (
    release['draft'] !== false ||
    release['prerelease'] !== false ||
    typeof release['published_at'] !== 'string' ||
    release['published_at'].length === 0
  )
    return false;
  return validDevelopment(current, published);
}
/** @param {Metadata} current @param {Metadata} published @returns {boolean} */
function validDevelopment(current, published) {
  const minimum = current.manifest['minAppVersion'];
  const oldMinimum = published.manifest['minAppVersion'];
  return (
    current.manifest['id'] === published.manifest['id'] &&
    current.manifest['version'] === published.manifest['version'] &&
    current.package['version'] === published.package['version'] &&
    isDeepStrictEqual(current.versions, published.versions) &&
    version(minimum) &&
    version(oldMinimum) &&
    increased(minimum, oldMinimum)
  );
}
/** @param {Metadata} current @returns {string} */
function repository(current) {
  const configured = process.env['GITHUB_REPOSITORY'];
  if (configured !== undefined && /^[\w-]+\/[\w.-]+$/u.test(configured)) return configured;
  const field = current.package['repository'];
  const url = object(field) ? field['url'] : field;
  const name =
    typeof url === 'string'
      ? /github\.com[:/]([\w-]+\/[\w.-]+?)(?:\.git)?$/u.exec(url)?.[1]
      : undefined;
  if (name === undefined) throw new Error('Published repository evidence is unavailable.');
  return name;
}
/** Uses the same GitHub published-release evidence as verify-changes, additionally
 * verifying the local tag against the remote Git object. Failure never grants an exception.
 * @param {Metadata} current @param {string} root @returns {boolean} */
export function verifyDevelopmentMinimum(current, root = process.cwd()) {
  try {
    const tag = current.manifest['version'];
    if (!version(tag)) return false;
    const repo = repository(current);
    const gitPath = executable('git', root);
    const ghPath = executable('gh', root);
    /** @param {string[]} args @returns {string} */
    const git = (args) =>
      execFileSync(gitPath, args, {
        cwd: root,
        encoding: 'utf8',
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    /** @param {string} route @returns {JsonObject} */
    const api = (route) => {
      const result = /** @type {unknown} */ (
        JSON.parse(
          execFileSync(ghPath, ['api', `repos/${repo}/${route}`], {
            cwd: root,
            encoding: 'utf8',
            timeout: 15_000,
            stdio: ['ignore', 'pipe', 'pipe'],
          }),
        )
      );
      if (!object(result)) throw new Error('Invalid published evidence.');
      return result;
    };
    const localCommit = git(['rev-parse', '--verify', `refs/tags/${tag}^{commit}`]);
    git(['merge-base', '--is-ancestor', localCommit, 'HEAD']);
    const release = api(`releases/tags/${tag}`);
    let reference = api(`git/ref/tags/${tag}`)['object'];
    for (let depth = 0; depth < 4 && object(reference) && reference['type'] === 'tag'; depth += 1) {
      const sha = reference['sha'];
      if (typeof sha !== 'string' || !commit.test(sha)) return false;
      reference = api(`git/tags/${sha}`)['object'];
    }
    if (!object(reference) || reference['type'] !== 'commit') return false;
    const published = Object.fromEntries(
      ['package', 'manifest', 'versions'].map((name) => [
        name,
        JSON.parse(git(['show', `${localCommit}:${name}.json`])),
      ]),
    );
    return acceptsDevelopmentMinimum(current, {
      published,
      tag,
      localCommit,
      remoteCommit: reference['sha'],
      reachable: true,
      release,
    });
  } catch {
    return false;
  }
}

/** Resolve trusted command paths outside the authored checkout, as release automation does.
 * @param {string} name @param {string} root @returns {string} */
function executable(name, root) {
  for (const directory of (process.env['PATH'] ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    try {
      const candidate = realpathSync(path.join(directory, name));
      const relative = path.relative(root, candidate);
      if (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) continue;
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* Missing or inaccessible entries are not executable tools. */
    }
  }
  throw new Error('Published evidence tool is unavailable.');
}
