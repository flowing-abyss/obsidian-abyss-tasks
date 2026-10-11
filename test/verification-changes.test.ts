// @vitest-environment node
import { Platform } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHILD_PROCESS_TIMEOUT_MS } from './support/timeouts';

const loadNodeTools = async () => {
  if (!Platform.isDesktop) throw new Error('Verification tests require a desktop runtime');
  return Promise.all([
    import('node:child_process'),
    import('node:fs'),
    import('node:os'),
    import('node:path'),
  ]);
};
const [
  { execFileSync, spawnSync },
  { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync },
  { tmpdir },
  path,
] = await loadNodeTools();
const runner = path.resolve(import.meta.dirname, '../tooling/verify-changes.mjs');
const localGitVariables = execFileSync('git', ['rev-parse', '--local-env-vars'], {
  encoding: 'utf8',
})
  .trim()
  .split('\n');
const cleanEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => !localGitVariables.includes(name) && !/^(?:GITHUB_|GH_)/u.test(name),
  ),
);
const manifest = {
  id: 'fixture',
  name: 'Fixture',
  author: 'Author',
  description: 'Fixture plugin.',
  version: '1.0.0',
  minAppVersion: '1.0.0',
  isDesktopOnly: false,
};
const packageMetadata = {
  name: 'fixture',
  version: '1.0.0',
  license: 'MIT',
  repository: { type: 'git', url: 'git@github.com:test/plugin.git' },
  dependencies: { example: '1.0.0' },
};
interface VerificationPlan {
  mode: 'light' | 'full';
  reason: string;
  commands: string[][];
}
interface Invocation {
  script?: string;
  args?: string[];
  event?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
  input?: string;
}
let directory = '';
let repository = '';
let base = '';

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
    { cwd: repository, env: cleanEnvironment, encoding: 'utf8', stdio: 'pipe' },
  ).trim();
}
function writeFiles(files: Record<string, string | null>): void {
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(repository, name);
    if (content === null) rmSync(target);
    else {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
  }
}
function commit(files: Record<string, string | null>): string {
  writeFiles(files);
  git('add', '-A');
  git('commit', '-qm', 'chore: fixture');
  return git('rev-parse', 'HEAD');
}
function versionBump(): Record<string, string> {
  return {
    'package.json': JSON.stringify({ ...packageMetadata, version: '1.0.1' }),
    'manifest.json': JSON.stringify({ ...manifest, version: '1.0.1' }),
    'versions.json': '{"1.0.0":"1.0.0","1.0.1":"1.0.0"}',
  };
}
function releases(value: unknown): void {
  writeFileSync(path.join(directory, 'releases.json'), JSON.stringify(value));
}
function invoke(options: Invocation = {}) {
  const eventPath = path.join(directory, 'event.json');
  writeFileSync(
    eventPath,
    JSON.stringify(
      options.event ?? {
        before: base,
        after: git('rev-parse', 'HEAD'),
      },
    ),
  );
  const flags = options.args ?? ['--plan'];
  return spawnSync(
    options.script === undefined ? process.execPath : '/bin/sh',
    options.script === undefined
      ? [runner, ...flags]
      : ['-c', `${options.script} "$@"`, 'verification-fixture', ...flags],
    {
      cwd: repository,
      encoding: 'utf8',
      ...(options.input === undefined ? {} : { input: options.input }),
      env: {
        ...cleanEnvironment,
        PATH: `${path.join(directory, 'bin')}${path.delimiter}${cleanEnvironment['PATH'] ?? ''}`,
        GITHUB_EVENT_NAME: 'push',
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REF_TYPE: 'branch',
        GITHUB_REPOSITORY: 'test/plugin',
        COMMAND_LOG: path.join(directory, 'commands.log'),
        RELEASES_FILE: path.join(directory, 'releases.json'),
        ...options.env,
      },
    },
  );
}
function plan(options: Invocation = {}): VerificationPlan {
  const result = invoke(options);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as VerificationPlan;
}
function pushedRef(remote: string, name = 'refs/heads/master'): string {
  return `${name} ${git('rev-parse', 'HEAD')} ${name} ${remote}\n`;
}

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'abyss-verification-changes-'));
  repository = path.join(directory, 'repo');
  mkdirSync(repository);
  mkdirSync(path.join(directory, 'bin'));
  git('init', '-q', '-b', 'master');
  base = commit({
    'package.json': JSON.stringify(packageMetadata),
    'manifest.json': JSON.stringify(manifest),
    'versions.json': '{"1.0.0":"1.0.0"}',
    'README.md': '# Fixture\n',
    'ARCHITECTURE.md': '# Architecture\n',
    LICENSE: 'MIT\n',
    'src/main.ts': 'export {};\n',
  });
  git('tag', '1.0.0');
  git('update-ref', 'refs/remotes/origin/master', base);
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master');
  releases([{ tag_name: '1.0.0', draft: false, prerelease: false, published_at: '2026-10-01' }]);
  writeFileSync(
    path.join(directory, 'bin', 'gh'),
    `#!/bin/sh
if [ "$RELEASE_API_FAILURE" = yes ]; then exit 1; fi
cat "$RELEASES_FILE"
`,
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(directory, 'bin', 'pnpm'),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$COMMAND_LOG"
if [ "$*" = "$FAIL_COMMAND" ]; then exit 23; fi
case "$*" in
  'run build'|'run verify') printf fresh > main.js ;;
esac
case "$*" in
  'run release:artifacts'|'run verify') mkdir -p dist; printf fresh > dist/styles.css ;;
esac
if [ "$*" = 'run lint:css:artifact' ] && [ ! -f dist/styles.css ]; then exit 24; fi
`,
    { mode: 0o755 },
  );
}, CHILD_PROCESS_TIMEOUT_MS);
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('verification scope', () => {
  it.each(['bin', 'absolute'])(
    'ignores a checkout command shadow in PATH at %s',
    (entry) => {
      commit({ 'README.md': '# Updated fixture\n' });
      const shadow = path.join(repository, 'bin');
      mkdirSync(shadow);
      writeFileSync(path.join(shadow, 'git'), '#!/bin/sh\nexit 77\n', { mode: 0o755 });
      const result = invoke({
        env: {
          PATH: `${entry === 'bin' ? entry : shadow}${path.delimiter}${cleanEnvironment['PATH'] ?? ''}`,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect((JSON.parse(result.stdout) as VerificationPlan).mode).toBe('full');
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );
  it(
    'selects light checks through the existing ci command',
    () => {
      const metadata = JSON.parse(
        readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf8'),
      ) as { scripts: Record<string, string> };
      base = commit({ 'tooling/verify-changes.mjs': readFileSync(runner, 'utf8') });
      commit({ 'README.md': '# Updated fixture\n' });
      const script = metadata.scripts['ci'];
      if (script === undefined) throw new Error('The ci script is missing.');
      const result = invoke({ script });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/^\{/u);
      expect((JSON.parse(result.stdout) as VerificationPlan).mode).toBe('light');
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );
  it(
    'uses light checks for documentation without building the plugin',
    () => {
      commit({ 'README.md': '# Updated fixture\n' });
      expect(plan()).toMatchObject({
        mode: 'light',
        commands: [
          ['run', 'format:check'],
          ['exec', 'eslint', 'package.json', 'manifest.json', 'LICENSE', '--max-warnings', '0'],
          ['run', 'release:check', '--metadata-only'],
        ],
      });
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );
  it(
    'uses light checks for a consistent version bump',
    () => {
      commit(versionBump());
      expect(plan().mode).toBe('light');
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );
  it.each([
    'src/main.ts',
    'test/fixture.test.ts',
    'test/fixtures/task.md',
    'styles.css',
    'pnpm-lock.yaml',
    'tooling/build.mjs',
    '.github/workflows/ci.yml',
    'unknown.txt',
    'unknown\nfile.md',
  ])(
    'uses full checks for %s',
    (file) => {
      commit({ [file]: 'changed\n' });
      expect(plan()).toMatchObject({ mode: 'full', commands: [['run', 'verify']] });
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );
  it(
    'uses full checks for dependencies changed alongside the version',
    () => {
      commit({
        ...versionBump(),
        'package.json': JSON.stringify({
          ...packageMetadata,
          version: '1.0.1',
          dependencies: { example: '2.0.0' },
        }),
      });
      expect(plan().mode).toBe('full');
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );
  it.each([{ minAppVersion: '2.0.0' }, { isDesktopOnly: true }])(
    'uses full checks for changed manifest compatibility %j',
    (change) => {
      commit({
        ...versionBump(),
        'manifest.json': JSON.stringify({
          ...manifest,
          version: '1.0.1',
          ...change,
        }),
      });
      expect(plan().mode).toBe('full');
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );
  it(
    'uses full checks for an edited historical version record',
    () => {
      commit({ ...versionBump(), 'versions.json': '{"1.0.0":"2.0.0","1.0.1":"1.0.0"}' });
      expect(plan().mode).toBe('full');
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );
  it(
    'uses full checks when code precedes the final version commit in a push',
    () => {
      commit({ 'src/main.ts': 'export const changed = true;\n' });
      commit(versionBump());
      expect(plan().mode).toBe('full');
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );
  it(
    'compares the whole PR with its merge base',
    () => {
      const target = commit({ 'src/main.ts': 'export const target = true;\n' });
      git('switch', '-qc', 'docs-pr', base);
      const head = commit({ 'README.md': '# PR documentation\n' });
      expect(
        plan({
          env: { GITHUB_EVENT_NAME: 'pull_request' },
          event: {
            pull_request: { base: { sha: target }, head: { sha: head } },
          },
        }).mode,
      ).toBe('light');
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );
  it.each(['src/main.ts', 'src/untracked.ts'])(
    'includes local dirty or untracked %s',
    (file) => {
      writeFiles({ [file]: 'export const dirty = true;\n' });
      expect(
        plan({ env: { GITHUB_EVENT_NAME: undefined, GITHUB_EVENT_PATH: undefined } }).mode,
      ).toBe('full');
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );
  it(
    'uses full checks when a documented path is renamed to an unknown path',
    () => {
      commit({ 'README.md': null, 'renamed.md': '# Fixture\n' });
      expect(plan().mode).toBe('full');
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );
  it.each(['0'.repeat(40), 'f'.repeat(40)])(
    'uses full checks for unavailable base %s',
    (before) => {
      commit({ 'README.md': '# Updated\n' });
      expect(plan({ event: { before, after: git('rev-parse', 'HEAD') } }).mode).toBe('full');
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );
  it(
    'preserves dirty changes even in a push context',
    () => {
      commit({ 'README.md': '# Updated\n' });
      writeFiles({ 'src/main.ts': 'export const dirty = true;\n' });
      expect(plan().mode).toBe('full');
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );
});

describe('pre-push ranges', () => {
  it(
    'uses the remote object rather than the last commit',
    () => {
      commit({ 'src/main.ts': 'export const changed = true;\n' });
      commit({ 'README.md': '# Latest documentation\n' });
      expect(plan({ args: ['--plan', '--pre-push'], input: pushedRef(base) }).mode).toBe('full');
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );
  it(
    'includes every updated ref',
    () => {
      const afterCode = commit({ 'src/main.ts': 'export const changed = true;\n' });
      commit({ 'README.md': '# Latest documentation\n' });
      expect(
        plan({
          args: ['--plan', '--pre-push'],
          input: pushedRef(afterCode) + pushedRef(base, 'refs/heads/other'),
        }).mode,
      ).toBe('full');
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );
  it(
    'rejects a pushed commit that does not match the checked-out source',
    () => {
      commit({ 'README.md': '# Current checkout\n' });
      const result = invoke({
        args: ['--plan', '--pre-push'],
        input: `refs/heads/other ${base} refs/heads/other ${base}\n`,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/checkout|checked.out/iu);
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );
  it(
    'uses full checks for a new branch with no known remote base',
    () => {
      commit({ 'README.md': '# Documentation\n' });
      expect(plan({ args: ['--plan', '--pre-push'], input: pushedRef('0'.repeat(40)) }).mode).toBe(
        'full',
      );
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );
  it(
    'uses the published baseline for a new release tag',
    () => {
      commit(versionBump());
      git('tag', '1.0.1');
      expect(
        plan({
          args: ['--plan', '--pre-push'],
          input: pushedRef('0'.repeat(40), 'refs/tags/1.0.1'),
        }).mode,
      ).toBe('light');
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );
});

describe('release preparation and command execution', () => {
  it(
    'always prepares fresh artifacts for a metadata-only release',
    () => {
      commit(versionBump());
      const result = invoke({ args: ['--release'] });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(path.join(directory, 'commands.log'), 'utf8').trim().split('\n')).toEqual(
        [
          'run format:check',
          'exec eslint package.json manifest.json LICENSE --max-warnings 0',
          'run release:check --metadata-only',
          'run build',
          'run release:artifacts',
          'run lint:css:artifact',
          'run release:check --release-ready',
        ],
      );
      expect(readFileSync(path.join(repository, 'main.js'), 'utf8')).toBe('fresh');
      expect(readFileSync(path.join(repository, 'dist/styles.css'), 'utf8')).toBe('fresh');
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );
  it(
    'includes code since the published release even when the last commit only bumps version',
    () => {
      commit({ 'src/main.ts': 'export const changed = true;\n' });
      commit(versionBump());
      expect(plan({ args: ['--plan', '--release'] })).toMatchObject({
        mode: 'full',
        commands: [
          ['run', 'verify'],
          ['run', 'release:check', '--release-ready'],
        ],
      });
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );
  it(
    'excludes the current published tag when rerunning a tag build',
    () => {
      commit({ 'src/main.ts': 'export const changed = true;\n' });
      commit(versionBump());
      git('tag', '1.0.1');
      releases([
        { tag_name: '1.0.1', draft: false, prerelease: false, published_at: '2026-10-02' },
        { tag_name: '1.0.0', draft: false, prerelease: false, published_at: '2026-10-01' },
      ]);
      expect(
        plan({
          args: ['--plan', '--release'],
          env: {
            GITHUB_REF_TYPE: 'tag',
            GITHUB_REF_NAME: '1.0.1',
          },
        }).mode,
      ).toBe('full');
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );
  it.each([
    { draft: true, prerelease: false },
    { draft: false, prerelease: true },
  ])(
    'does not trust unpublished or prerelease baseline %j',
    (flags) => {
      commit({ 'src/main.ts': 'export const changed = true;\n' });
      git('tag', '1.0.1');
      commit(versionBump());
      releases([
        { tag_name: '1.0.1', published_at: '2026-10-02', ...flags },
        { tag_name: '1.0.0', draft: false, prerelease: false, published_at: '2026-10-01' },
      ]);
      expect(plan({ args: ['--plan', '--release'] }).mode).toBe('full');
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );
  it(
    'uses full release checks when no published baseline exists',
    () => {
      commit(versionBump());
      releases([]);
      expect(plan({ args: ['--plan', '--release'] }).mode).toBe('full');
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );
  it(
    'uses full release checks when the GitHub API fails',
    () => {
      commit(versionBump());
      const result = plan({ args: ['--plan', '--release'], env: { RELEASE_API_FAILURE: 'yes' } });
      expect(result.mode).toBe('full');
      expect(result.reason).toMatch(/release|published/iu);
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );
  it(
    'uses full checks if a published tag is unavailable locally',
    () => {
      commit(versionBump());
      git('tag', '-d', '1.0.0');
      expect(plan({ args: ['--plan', '--release'] }).mode).toBe('full');
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );
  it(
    'stops and propagates a failing verification stage',
    () => {
      commit({ 'README.md': '# Updated\n' });
      const failed = 'exec eslint package.json manifest.json LICENSE --max-warnings 0';
      const result = invoke({ args: [], env: { FAIL_COMMAND: failed } });
      expect(result.status).toBe(23);
      expect(readFileSync(path.join(directory, 'commands.log'), 'utf8').trim().split('\n')).toEqual(
        ['run format:check', failed],
      );
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );
  it(
    'reports the selected mode through the GitHub step output',
    () => {
      commit({ 'README.md': '# Updated\n' });
      const output = path.join(directory, 'github-output');
      const result = invoke({ args: [], env: { GITHUB_OUTPUT: output } });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(output, 'utf8')).toContain('mode=light\n');
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );
});
