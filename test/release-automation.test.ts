// @vitest-environment node
import { Platform } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHILD_PROCESS_TIMEOUT_MS } from './support/timeouts';

const loadNodeTools = async () => {
  if (!Platform.isDesktop) throw new Error('Release automation tests require a desktop runtime');
  return Promise.all([
    import('node:child_process'),
    import('node:fs'),
    import('node:os'),
    import('node:path'),
    import('node:http'),
  ]);
};
const [
  { execFileSync, spawn },
  { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync },
  { tmpdir },
  path,
  { createServer },
] = await loadNodeTools();
const runner = path.resolve(import.meta.dirname, '../tooling/release-automation.mjs');
const localGitVariables = execFileSync('git', ['rev-parse', '--local-env-vars'], {
  encoding: 'utf8',
})
  .trim()
  .split('\n');
const environment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => !localGitVariables.includes(name) && !/^(?:GITHUB_|GH_|RELEASE_)/u.test(name),
  ),
);
const metadata = {
  'package.json': {
    name: 'obsidian-abyss-tasks',
    version: '1.0.0',
    dependencies: { example: '1' },
  },
  'manifest.json': { id: 'abyss-tasks', version: '1.0.0', minAppVersion: '1.7.7' },
  'versions.json': { '0.9.0': '1.6.0', '1.0.0': '1.7.7' },
};
let directory = '';
let repository = '';
let base = '';
let head = '';
let apiUrl = '';
let server: ReturnType<typeof createServer> | undefined;
let ciRun: Record<string, unknown>;
let releasePull: Record<string, unknown>;
let createRace: 'same' | 'different' | undefined;

function git(...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.com',
      '-c',
      'commit.gpgsign=false',
      '-c',
      `core.hooksPath=${path.join(directory, 'no-hooks')}`,
      ...args,
    ],
    { cwd: repository, env: environment, encoding: 'utf8', stdio: 'pipe' },
  ).trim();
}
function write(name: string, value: unknown): void {
  writeFileSync(path.join(repository, name), `${JSON.stringify(value, null, 2)}\n`);
}
function read(name: string): unknown {
  return JSON.parse(readFileSync(path.join(repository, name), 'utf8'));
}
function commit(): string {
  git('add', '-A');
  git('commit', '-qm', 'chore: fixture');
  return git('rev-parse', 'HEAD');
}

function prepareReleaseCommit(): void {
  write('package.json', { ...metadata['package.json'], version: '1.0.1' });
  write('manifest.json', { ...metadata['manifest.json'], version: '1.0.1' });
  write('versions.json', { ...metadata['versions.json'], '1.0.1': '1.7.7' });
  head = commit();
  git('update-ref', 'refs/remotes/origin/master', head);
  ciRun = {
    id: 42,
    workflow_id: 17,
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    head_sha: head,
    head_branch: 'master',
    repository: { full_name: 'fixture/plugin' },
    head_repository: { full_name: 'fixture/plugin' },
  };
  releasePull = {
    number: 7,
    state: 'closed',
    merged: true,
    merged_at: '2026-10-11T01:00:00Z',
    merge_commit_sha: head,
    user: { login: 'abyss-automation[bot]', type: 'Bot' },
    head: { ref: 'release/patch-1.0.1', sha: head, repo: { full_name: 'fixture/plugin' } },
    base: { ref: 'master', sha: base, repo: { full_name: 'fixture/plugin' } },
  };
}

async function startApi(): Promise<void> {
  server = createServer((request, response) => {
    const reply = async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const pathname = url.pathname.replace('/repos/fixture/plugin', '');
      const method = request.method ?? 'GET';
      const token = method === 'POST' ? 'fixture-write-token' : 'fixture-read-token';
      if (request.headers['user-agent'] === undefined || request.headers['user-agent'] === '') {
        response.writeHead(403);
        response.end(JSON.stringify({ message: 'User agent required' }));
        return;
      }
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401);
        response.end('{}');
        return;
      }
      const result =
        pathname === '/git/refs' && method === 'POST'
          ? await createReference(request)
          : readApiResponse(url);
      response.writeHead(result.status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(result.value));
    };
    void reply().catch(() => {
      response.writeHead(500);
      response.end('{}');
    });
  });
  await new Promise<void>((resolve) => {
    server?.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Fixture API has no port');
  apiUrl = `http://127.0.0.1:${address.port}`;
}

interface ApiResponse {
  status: number;
  value: unknown;
}
function existingReference(): ApiResponse {
  try {
    const tag = git('rev-parse', '--verify', 'refs/tags/1.0.1');
    return {
      status: 200,
      value: { ref: 'refs/tags/1.0.1', object: { sha: tag, type: git('cat-file', '-t', tag) } },
    };
  } catch {
    return { status: 404, value: { message: 'Not Found' } };
  }
}
function page(values: unknown[], url: URL): unknown[] {
  const start = (Number(url.searchParams.get('page')) - 1) * 100;
  return values.slice(start, start + 100);
}
function readApiResponse(url: URL): ApiResponse {
  const pathname = url.pathname.replace('/repos/fixture/plugin', '');
  if (pathname === '/git/ref/tags/1.0.1') return existingReference();
  if (pathname.startsWith('/git/tags/')) {
    const tag = pathname.slice('/git/tags/'.length);
    return {
      status: 200,
      value: { object: { sha: git('rev-parse', `${tag}^{commit}`), type: 'commit' } },
    };
  }
  if (pathname === '/pulls/7/files') {
    const pullHead = releasePull['head'] as { sha: string };
    return {
      status: 200,
      value: page(
        git('diff', '--name-only', base, pullHead.sha)
          .split('\n')
          .map((filename) => ({ filename, status: 'modified' })),
        url,
      ),
    };
  }
  const routes: Record<string, unknown> = {
    '/actions/workflows/ci.yml': {
      id: 17,
      path: '.github/workflows/ci.yml',
      name: 'CI',
      state: 'active',
    },
    '/actions/runs/42': ciRun,
    [`/commits/${head}/pulls`]: page([releasePull], url),
    '/pulls/7': releasePull,
  };
  const value = routes[pathname];
  return {
    status: value === undefined ? 500 : 200,
    value: value ?? { message: 'Unexpected request' },
  };
}
async function createReference(request: AsyncIterable<unknown>): Promise<ApiResponse> {
  let body = '';
  for await (const chunk of request) body += String(chunk);
  const payload = JSON.parse(body) as { ref: string; sha: string };
  if (payload.ref !== 'refs/tags/1.0.1' || payload.sha !== head)
    return { status: 422, value: { message: 'Invalid release ref' } };
  if (createRace !== undefined) {
    git('update-ref', payload.ref, createRace === 'same' ? head : base);
    return { status: 422, value: { message: 'Reference already exists' } };
  }
  git('update-ref', payload.ref, payload.sha);
  return { status: 201, value: { ref: payload.ref, object: { type: 'commit', sha: payload.sha } } };
}

function ciEnvironment(): Record<string, string> {
  const eventPath = path.join(directory, 'event.json');
  writeFileSync(eventPath, JSON.stringify({ workflow_run: ciRun }));
  return {
    GITHUB_EVENT_NAME: 'workflow_run',
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_API_URL: apiUrl,
    CANDIDATE_SHA: head,
    RELEASE_VERSION: '1.0.1',
  };
}
async function invoke(command: string, env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [runner, command], {
    cwd: repository,
    timeout: CHILD_PROCESS_TIMEOUT_MS,
    env: {
      ...environment,
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF: 'refs/heads/master',
      GITHUB_REPOSITORY: 'fixture/plugin',
      GITHUB_OUTPUT: path.join(directory, 'outputs'),
      GITHUB_TOKEN: 'fixture-read-token',
      RELEASE_TOKEN: 'fixture-write-token',
      ...env,
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('close', (status) => {
        resolve({ status, stdout, stderr });
      });
    },
  );
}

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'abyss-release-automation-'));
  repository = path.join(directory, 'repo');
  mkdirSync(repository);
  git('init', '-q', '-b', 'master');
  for (const [name, value] of Object.entries(metadata)) write(name, value);
  copyFileSync(
    path.resolve(import.meta.dirname, '../version-bump.mjs'),
    path.join(repository, 'version-bump.mjs'),
  );
  writeFileSync(path.join(repository, 'README.md'), '# Keep this README exactly as it is\n');
  base = commit();
  createRace = undefined;
}, CHILD_PROCESS_TIMEOUT_MS);
afterEach(async () => {
  const closing = server;
  server = undefined;
  if (closing !== undefined) {
    await new Promise<void>((resolve, reject) => {
      closing.close((error) => {
        if (error !== undefined) reject(error);
        else resolve();
      });
    });
  }
  rmSync(directory, { recursive: true, force: true });
});

describe('manual patch release preparation', () => {
  it(
    'prepares only synchronized patch metadata using the existing version updater',
    async () => {
      const beforeReadme = readFileSync(path.join(repository, 'README.md'));
      const head = git('rev-parse', 'HEAD');
      const result = await invoke('prepare');
      expect(result.status, result.stderr).toBe(0);
      expect(read('package.json')).toEqual({ ...metadata['package.json'], version: '1.0.1' });
      expect(read('manifest.json')).toEqual({ ...metadata['manifest.json'], version: '1.0.1' });
      expect(read('versions.json')).toEqual({ ...metadata['versions.json'], '1.0.1': '1.7.7' });
      expect(readFileSync(path.join(repository, 'README.md'))).toEqual(beforeReadme);
      expect(
        git('diff', '--name-only')
          .split('\n')
          .sort((a, b) => a.localeCompare(b)),
      ).toEqual(['manifest.json', 'package.json', 'versions.json']);
      expect(git('rev-parse', 'HEAD')).toBe(head);
      expect(git('tag', '--list')).toBe('');
      expect(readFileSync(path.join(directory, 'outputs'), 'utf8')).toContain('version=1.0.1\n');
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );

  it.each([
    ['pull request invocation', { GITHUB_EVENT_NAME: 'pull_request' }],
    ['another branch', { GITHUB_REF: 'refs/heads/feature' }],
  ])(
    'refuses %s before changing metadata',
    async (_name, env) => {
      const result = await invoke('prepare', env);
      expect(result.status).toBe(1);
      expect(git('diff')).toBe('');
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );

  it(
    'rejects inconsistent metadata before the first write',
    async () => {
      write('manifest.json', { ...metadata['manifest.json'], version: '1.0.2' });
      commit();
      const result = await invoke('prepare');
      expect(result.status).toBe(1);
      expect(read('package.json')).toEqual(metadata['package.json']);
      expect(git('diff')).toBe('');
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );
});

describe('release preparation recovery', () => {
  beforeEach(() => {
    prepareReleaseCommit();
    git('update-ref', 'refs/remotes/origin/release/patch-1.0.1', head);
    git('reset', '--hard', base);
    git('update-ref', 'refs/remotes/origin/master', base);
  }, CHILD_PROCESS_TIMEOUT_MS);

  it(
    'reuses an orphan release branch without checking it out or rewriting it',
    async () => {
      const prepared = await invoke('prepare');
      expect(prepared.status, prepared.stderr).toBe(0);
      const result = await invoke('reuse');
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ version: '1.0.1', sha: head });
      expect(git('rev-parse', 'HEAD')).toBe(base);
      expect(git('rev-parse', 'refs/remotes/origin/release/patch-1.0.1')).toBe(head);
      expect(git('tag', '--list')).toBe('');
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );

  it(
    'recovers the same release after master gains an unrelated source change',
    async () => {
      writeFileSync(path.join(repository, 'source.js'), 'export const next = true;\n');
      const currentMaster = commit();
      const prepared = await invoke('prepare');
      expect(prepared.status, prepared.stderr).toBe(0);
      const result = await invoke('reuse');
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ version: '1.0.1', sha: head });
      expect(git('rev-parse', 'HEAD')).toBe(currentMaster);
      expect(readFileSync(path.join(repository, 'source.js'), 'utf8')).toContain('next = true');
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );

  it(
    'rejects an orphan release branch containing source edits',
    async () => {
      git('reset', '--hard', head);
      writeFileSync(path.join(repository, 'extra.js'), 'export const unexpected = true;\n');
      const unexpected = commit();
      git('update-ref', 'refs/remotes/origin/release/patch-1.0.1', unexpected);
      git('reset', '--hard', base);
      const prepared = await invoke('prepare');
      expect(prepared.status, prepared.stderr).toBe(0);
      const result = await invoke('reuse');
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('existing release branch changes files outside version');
      expect(git('rev-parse', 'HEAD')).toBe(base);
      expect(git('rev-parse', 'refs/remotes/origin/release/patch-1.0.1')).toBe(unexpected);
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );

  it(
    'rejects unrelated package changes in an orphan release branch',
    async () => {
      git('reset', '--hard', head);
      write('package.json', {
        ...metadata['package.json'],
        version: '1.0.1',
        dependencies: { example: '2' },
      });
      const unexpected = commit();
      git('update-ref', 'refs/remotes/origin/release/patch-1.0.1', unexpected);
      git('reset', '--hard', base);
      const prepared = await invoke('prepare');
      expect(prepared.status, prepared.stderr).toBe(0);
      const result = await invoke('reuse');
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Release PRs may only increment the patch version');
      expect(git('rev-parse', 'refs/remotes/origin/release/patch-1.0.1')).toBe(unexpected);
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );

  it(
    'refuses to reuse a release whose metadata no longer matches current master',
    async () => {
      write('package.json', { ...metadata['package.json'], dependencies: { example: '2' } });
      const currentMaster = commit();
      const prepared = await invoke('prepare');
      expect(prepared.status, prepared.stderr).toBe(0);
      const result = await invoke('reuse');
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('existing release branch does not match the prepared patch');
      expect(git('rev-parse', 'HEAD')).toBe(currentMaster);
      expect(git('rev-parse', 'refs/remotes/origin/release/patch-1.0.1')).toBe(head);
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );
});

describe('CI to release tag authorization', () => {
  beforeEach(async () => {
    prepareReleaseCommit();
    await startApi();
  }, CHILD_PROCESS_TIMEOUT_MS);

  it(
    'identifies the exact merged bot PR after successful master CI',
    async () => {
      const result = await invoke('candidate', ciEnvironment());
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ version: '1.0.1', sha: head, pull_request: '7' });
      expect(git('tag', '--list')).toBe('');
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );

  it(
    'tags a release merged after an unrelated master commit',
    async () => {
      const releaseHead = head;
      git('switch', '-c', 'release/patch-1.0.1');
      git('switch', 'master');
      git('reset', '--hard', base);
      writeFileSync(path.join(repository, 'source.js'), 'export const next = true;\n');
      commit();
      git('merge', '--no-ff', '-m', 'Merge release PR', 'release/patch-1.0.1');
      head = git('rev-parse', 'HEAD');
      git('update-ref', 'refs/remotes/origin/master', head);
      ciRun['head_sha'] = head;
      releasePull['merge_commit_sha'] = head;
      releasePull['head'] = {
        ref: 'release/patch-1.0.1',
        sha: releaseHead,
        repo: { full_name: 'fixture/plugin' },
      };
      const result = await invoke('tag', ciEnvironment());
      expect(result.status, result.stderr).toBe(0);
      expect(git('rev-parse', 'refs/tags/1.0.1')).toBe(head);
      expect(git('show', `${head}:source.js`)).toBe('export const next = true;');
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );

  it(
    'skips an ordinary merged PR without creating any tag',
    async () => {
      releasePull['head'] = { ref: 'chore/ci', repo: { full_name: 'fixture/plugin' } };
      releasePull['user'] = { login: 'fixture-user' };
      const result = await invoke('candidate', ciEnvironment());
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({});
      expect(git('tag', '--list')).toBe('');
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );

  it(
    'creates a plain version tag at the verified commit through the write token',
    async () => {
      const result = await invoke('tag', ciEnvironment());
      expect(result.status, result.stderr).toBe(0);
      expect(git('rev-parse', 'refs/tags/1.0.1')).toBe(head);
      expect(git('tag', '--list')).toBe('1.0.1');
      expect(JSON.parse(result.stdout)).toMatchObject({
        version: '1.0.1',
        sha: head,
        created: 'true',
      });
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );

  it.each([
    ['failed', { conclusion: 'failure' }],
    ['unfinished', { status: 'in_progress' }],
    ['pull request', { event: 'pull_request' }],
    ['different workflow', { workflow_id: 99 }],
    ['another branch', { head_branch: 'feature' }],
    ['another repository', { head_repository: { full_name: 'attacker/plugin' } }],
  ])(
    'refuses tags authorized by %s CI',
    async (_name, override) => {
      Object.assign(ciRun, override);
      const result = await invoke('tag', ciEnvironment());
      expect(result.status).toBe(1);
      expect(git('tag', '--list')).toBe('');
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );

  it(
    'rechecks the live run when the event payload still reports success',
    async () => {
      const env = ciEnvironment();
      ciRun['conclusion'] = 'failure';
      const result = await invoke('tag', env);
      expect(result.status).toBe(1);
      expect(git('tag', '--list')).toBe('');
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );

  it.each([
    ['human PR', { user: { login: 'fixture-user', type: 'User' } }],
    ['unmerged PR', { merged: false }],
    ['wrong merged commit', { merge_commit_sha: 'a'.repeat(40) }],
    ['fork PR', { head: { ref: 'release/patch-1.0.1', repo: { full_name: 'attacker/plugin' } } }],
    ['ordinary branch', { head: { ref: 'feature', repo: { full_name: 'fixture/plugin' } } }],
    [
      'wrong release branch',
      { head: { ref: 'release/patch-1.0.2', repo: { full_name: 'fixture/plugin' } } },
    ],
    ['another base', { base: { ref: 'feature', repo: { full_name: 'fixture/plugin' } } }],
  ])(
    'refuses release authorization from %s',
    async (_name, override) => {
      const previousHead = releasePull['head'] as Record<string, unknown>;
      Object.assign(releasePull, override);
      if ('head' in override) releasePull['head'] = { ...previousHead, ...override.head };
      const result = await invoke('tag', ciEnvironment());
      expect(result.status).toBe(1);
      expect(git('tag', '--list')).toBe('');
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );

  it.each([
    [
      'dependency change',
      'package.json',
      { ...metadata['package.json'], version: '1.0.1', dependencies: { example: '2' } },
    ],
    [
      'compatibility change',
      'manifest.json',
      { ...metadata['manifest.json'], version: '1.0.1', minAppVersion: '1.8.0' },
    ],
    ['history rewrite', 'versions.json', { '0.9.0': '1.0.0', '1.0.0': '1.7.7', '1.0.1': '1.7.7' }],
    ['minor bump', 'package.json', { ...metadata['package.json'], version: '1.1.0' }],
  ])(
    'refuses a release containing a %s',
    async (name, filename, value) => {
      write(filename, value);
      if (name === 'compatibility change')
        write('versions.json', { ...metadata['versions.json'], '1.0.1': '1.8.0' });
      if (name === 'minor bump') {
        write('manifest.json', { ...metadata['manifest.json'], version: '1.1.0' });
        write('versions.json', { ...metadata['versions.json'], '1.1.0': '1.7.7' });
      }
      git('reset', '--soft', base);
      head = commit();
      git('update-ref', 'refs/remotes/origin/master', head);
      ciRun['head_sha'] = head;
      releasePull['merge_commit_sha'] = head;
      (releasePull['head'] as { sha: string }).sha = head;
      const result = await invoke('tag', ciEnvironment());
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Release PRs may only increment the patch version');
      expect(git('tag', '--list')).toBe('');
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );

  it(
    'rejects source edits in an earlier PR commit before a final version commit',
    async () => {
      git('reset', '--hard', base);
      writeFileSync(path.join(repository, 'extra.js'), 'export const changed = true;\n');
      commit();
      prepareReleaseCommit();
      const result = await invoke('tag', ciEnvironment());
      expect(result.status).toBe(1);
      expect(git('tag', '--list')).toBe('');
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );

  it(
    'refuses a candidate outside master history',
    async () => {
      git('update-ref', 'refs/remotes/origin/master', base);
      const result = await invoke('tag', ciEnvironment());
      expect(result.status).toBe(1);
      expect(git('tag', '--list')).toBe('');
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );

  it.each(['lightweight', 'annotated'])(
    'keeps an existing matching %s tag unchanged',
    async (kind) => {
      if (kind === 'annotated') git('tag', '-a', '1.0.1', '-m', 'Fixture', head);
      else git('tag', '1.0.1', head);
      const before = git('rev-parse', 'refs/tags/1.0.1');
      const result = await invoke('tag', ciEnvironment());
      expect(result.status, result.stderr).toBe(0);
      expect(git('rev-parse', 'refs/tags/1.0.1')).toBe(before);
      expect(JSON.parse(result.stdout)).toMatchObject({ created: 'false' });
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );

  it(
    'never rewrites an existing version tag pointing at another commit',
    async () => {
      git('tag', '1.0.1', base);
      const result = await invoke('tag', ciEnvironment());
      expect(result.status).toBe(1);
      expect(git('rev-parse', 'refs/tags/1.0.1')).toBe(base);
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );

  it(
    'accepts a concurrent creation only when the exact commit matches',
    async () => {
      createRace = 'same';
      const result = await invoke('tag', ciEnvironment());
      expect(result.status, result.stderr).toBe(0);
      expect(git('rev-parse', 'refs/tags/1.0.1')).toBe(head);
      expect(JSON.parse(result.stdout)).toMatchObject({ created: 'false' });
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );

  it(
    'rejects a concurrent version tag pointing at another commit',
    async () => {
      createRace = 'different';
      const result = await invoke('tag', ciEnvironment());
      expect(result.status).toBe(1);
      expect(git('rev-parse', 'refs/tags/1.0.1')).toBe(base);
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );

  it.each(['CANDIDATE_SHA', 'RELEASE_VERSION', 'GITHUB_TOKEN', 'RELEASE_TOKEN'])(
    'fails without the expected %s authority',
    async (name) => {
      const result = await invoke('tag', { ...ciEnvironment(), [name]: '' });
      expect(result.status).toBe(1);
      expect(git('tag', '--list')).toBe('');
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );

  it(
    'reports API failures without creating a release tag',
    async () => {
      const result = await invoke('tag', {
        ...ciEnvironment(),
        GITHUB_API_URL: `${apiUrl}/unavailable`,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('returned HTTP 500');
      expect(git('tag', '--list')).toBe('');
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );
});
