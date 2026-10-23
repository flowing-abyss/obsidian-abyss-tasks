// Local optimization only. CI and release preparation still establish their own evidence.
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

/** @typedef {{cwd: string, git: string, pnpm: string}} Context */
/** @typedef {{inputs: string, sourceTree: string}} Fingerprint */
/** @typedef {{directory: string, generation: string, fingerprint: Fingerprint}} Started */
const lifetime = 24 * 60 * 60 * 1000;
const schema = 1;
// Vitest 5 also persists transformed modules in its documented fsModuleCachePath.
const dependencyOutputs = new Set(['.cache', '.vite', '.vite-temp', '.vitest-cache']);
const bookkeeping = new Set([
  '_',
  'PWD',
  'OLDPWD',
  'SHLVL',
  'INIT_CWD',
  'HUSKY',
  'HUSKY_GIT_PARAMS',
  'GIT_PREFIX',
  'CODEX_TOOL_CALL_ID',
  'npm_command',
  'npm_config_argv',
]);

/** @returns {boolean} */
function automated() {
  return Boolean(
    process.env['CI'] || process.env['GITHUB_ACTIONS'] || process.env['GITHUB_EVENT_NAME'],
  );
}

/** @param {Context} context @param {string} executable @param {string[]} args @param {NodeJS.ProcessEnv} [env] @returns {string} */
function output(context, executable, args, env = process.env) {
  const result = spawnSync(executable, args, {
    cwd: context.cwd,
    env,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error('Verification inputs are unavailable.');
  return result.stdout;
}

/** @param {string | Buffer} value @returns {string} */
function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** @param {string} root @param {string} file @returns {void} */
function requireContained(root, file) {
  const local = relative(root, file);
  if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local))
    throw new Error('External symlink targets cannot reuse local verification.');
}

/** @param {unknown} error @returns {boolean} */
function missingFile(error) {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

/** @param {string} file @returns {import('node:fs').Stats | undefined} */
function fileStat(file) {
  try {
    return lstatSync(file);
  } catch (error) {
    if (missingFile(error)) return undefined;
    throw error;
  }
}

/** @param {import('node:fs').Stats} stat @returns {string} */
function sourceMode(stat) {
  if (stat.isSymbolicLink()) return '120000';
  return stat.mode & 0o111 ? '100755' : '100644';
}

/** @param {string} left @param {string} right @returns {number} */
function compare(left, right) {
  return left.localeCompare(right, 'en');
}

/** @param {Context} context @returns {{content: string, tree: string}} */
function source(context) {
  const root = realpathSync(context.cwd);
  const algorithm = output(context, context.git, ['rev-parse', '--show-object-format']).trim();
  if (!['sha1', 'sha256'].includes(algorithm)) throw new Error('Unsupported Git object format.');
  const names = new Set(
    output(context, context.git, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
      .split('\0')
      .filter(Boolean),
  );
  const hash = createHash('sha256');
  /** @type {string[]} */
  const tree = [];
  for (const name of [...names].sort(compare)) {
    const file = join(root, name);
    const stat = fileStat(file);
    if (stat === undefined) continue;
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error('Unsupported source entry.');
    const mode = sourceMode(stat);
    const bytes = stat.isSymbolicLink() ? Buffer.from(readlinkSync(file)) : readFileSync(file);
    hash.update(JSON.stringify([name, mode, bytes.length])).update(bytes);
    if (stat.isSymbolicLink()) {
      requireContained(root, realpathSync(file));
      hash.update(readFileSync(file));
    }
    const object = createHash(algorithm)
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest('hex');
    tree.push(`${mode} blob ${object}\t${name}`);
  }
  tree.sort(compare);
  return { content: hash.digest('hex'), tree: digest(tree.join('\0')) };
}

/** @param {string} root @param {string} file @returns {string} */
function dependencyLink(root, file) {
  const target = readlinkSync(file);
  const local = resolve(dirname(file), target);
  requireContained(root, local);
  if (dependencyOutputs.has(relative(root, local).split(sep)[0] ?? ''))
    throw new Error('Dependencies linked into generated caches cannot reuse verification.');
  try {
    requireContained(root, realpathSync(file));
  } catch (error) {
    // pnpm can leave unused internal links behind. The inventory hashes the link and any
    // target that later appears; every physical link is checked for escapes from this root.
    if (!missingFile(error)) throw error;
  }
  return target;
}

/** @param {Context} context @returns {string} */
function installedDependencies(context) {
  const root = realpathSync(join(context.cwd, 'node_modules'));
  const hash = createHash('sha256');
  /** @param {string} directory @param {string} prefix */
  function visit(directory, prefix) {
    for (const name of readdirSync(directory).sort(compare)) {
      if (prefix === '' && dependencyOutputs.has(name)) continue;
      const file = join(directory, name);
      const local = `${prefix}${name}`;
      const stat = lstatSync(file);
      hash.update(JSON.stringify([local, stat.mode]));
      if (stat.isSymbolicLink()) {
        hash.update(dependencyLink(root, file));
      } else if (stat.isDirectory()) {
        visit(file, `${local}/`);
      } else if (stat.isFile()) {
        hash.update(digest(readFileSync(file)));
      } else throw new Error('Unsupported installed dependency entry.');
    }
  }
  visit(root, '');
  return hash.digest('hex');
}

/** @param {unknown} value @returns {unknown} */
function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compare(left, right))
      .map(([name, child]) => [name, canonicalJson(child)]),
  );
}

/** @param {string} entry @param {string} localBin @returns {string} */
function searchPathEntry(entry, localBin) {
  if (entry === 'node_modules/.bin') return localBin;
  if (!entry.endsWith(`${sep}node_modules${sep}.bin`)) return entry;
  try {
    return realpathSync(dirname(entry)) === dirname(localBin) ? localBin : entry;
  } catch {
    return entry;
  }
}

/** @param {Context} context @param {string} defaultGitPath @returns {string} */
function environment(context, defaultGitPath) {
  const effective = {
    ...process.env,
    GIT_EXEC_PATH: process.env['GIT_EXEC_PATH'] ?? defaultGitPath,
  };
  const localBin = join(realpathSync(join(context.cwd, 'node_modules')), '.bin');
  const searchPath = (process.env['PATH'] ?? '')
    .split(delimiter)
    .map((entry) => searchPathEntry(entry, localBin))
    .filter((entry) => entry !== defaultGitPath);
  const values = Object.entries(effective)
    .filter(
      ([name]) =>
        !bookkeeping.has(name) &&
        !name.startsWith('npm_lifecycle_') &&
        !name.startsWith('npm_package_'),
    )
    .map(([name, value]) => [
      name,
      name === 'PATH' ? [...new Set(searchPath)].join(delimiter) : value,
    ])
    .sort(([left = ''], [right = '']) => left.localeCompare(right));
  return digest(JSON.stringify(values));
}

/** @param {Context} context @returns {Fingerprint} */
function fingerprint(context) {
  const files = source(context);
  const defaultGitPath = output(context, context.git, ['--exec-path'], {
    ...process.env,
    GIT_EXEC_PATH: undefined,
  }).trim();
  const runtime = {
    root: realpathSync(context.cwd),
    executable: realpathSync(process.execPath),
    versions: process.versions,
    platform: process.platform,
    architecture: process.arch,
    git: realpathSync(context.git),
    gitVersion: output(context, context.git, ['--version']).trim(),
    pnpm: realpathSync(context.pnpm),
    managerVersion: output(context, context.pnpm, ['--version']).trim(),
    // Includes user/global settings such as script-shell, without storing their plaintext.
    managerConfiguration: digest(
      JSON.stringify(
        canonicalJson(JSON.parse(output(context, context.pnpm, ['config', 'list', '--json']))),
      ),
    ),
    environment: environment(context, defaultGitPath),
  };
  return {
    sourceTree: files.tree,
    inputs: digest(
      JSON.stringify([schema, files.content, installedDependencies(context), runtime]),
    ),
  };
}

/** @param {Context} context @returns {string} */
function receiptDirectory(context) {
  const directory = output(context, context.git, ['rev-parse', '--absolute-git-dir']).trim();
  return join(directory, 'abyss-verification');
}

/** @param {string} directory @param {string} name @param {string} contents */
function atomicWrite(directory, name, contents) {
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `${name}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, contents, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, join(directory, name));
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** @param {Context} context @returns {string} */
function artifacts(context) {
  return digest(
    JSON.stringify(
      ['main.js', 'dist/styles.css'].map((file) => [
        file,
        digest(readFileSync(join(context.cwd, file))),
      ]),
    ),
  );
}

/** @param {Context} context @returns {Started | undefined} */
export function beginVerification(context) {
  try {
    const directory = receiptDirectory(context);
    const generation = randomUUID();
    atomicWrite(directory, 'generation', generation);
    if (automated()) return undefined;
    return { directory, generation, fingerprint: fingerprint(context) };
  } catch {
    // Missing inputs disable receipt reuse, never the full gate itself.
    return undefined;
  }
}

/** @param {Context} context @param {Started | undefined} started @returns {boolean} */
export function finishVerification(context, started) {
  if (started === undefined) return false;
  try {
    const after = fingerprint(context);
    if (after.inputs !== started.fingerprint.inputs) return false;
    if (readFileSync(join(started.directory, 'generation'), 'utf8') !== started.generation)
      return false;
    atomicWrite(
      started.directory,
      'success.json',
      JSON.stringify({
        schema,
        generation: started.generation,
        finishedAt: Date.now(),
        ...after,
        artifacts: artifacts(context),
      }),
    );
    return true;
  } catch {
    return false;
  }
}

/** @param {Context} context @returns {boolean} */
export function canReuseVerification(context) {
  if (automated()) return false;
  try {
    const directory = receiptDirectory(context);
    const generation = readFileSync(join(directory, 'generation'), 'utf8');
    /** @type {unknown} */
    const receipt = JSON.parse(readFileSync(join(directory, 'success.json'), 'utf8'));
    if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) return false;
    if (!('schema' in receipt) || receipt.schema !== schema) return false;
    if (!('generation' in receipt) || receipt.generation !== generation) return false;
    if (!('finishedAt' in receipt) || typeof receipt.finishedAt !== 'number') return false;
    const age = Date.now() - receipt.finishedAt;
    if (!Number.isFinite(age) || age < 0 || age > lifetime) return false;
    const current = fingerprint(context);
    if (!('inputs' in receipt) || current.inputs !== receipt.inputs) return false;
    const committed = output(context, context.git, ['ls-tree', '-r', '-z', 'HEAD'])
      .split('\0')
      .filter(Boolean)
      .sort(compare)
      .join('\0');
    if (current.sourceTree !== digest(committed)) return false;
    if (!('artifacts' in receipt) || artifacts(context) !== receipt.artifacts) return false;
    return readFileSync(join(directory, 'generation'), 'utf8') === generation;
  } catch {
    return false;
  }
}
