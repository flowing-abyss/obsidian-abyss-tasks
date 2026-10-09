import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const hook = fileURLToPath(new URL('../../.husky/pre-push', import.meta.url));
const localVariables = execFileSync('git', ['rev-parse', '--local-env-vars'], {
  encoding: 'utf8',
})
  .trim()
  .split('\n');
const cleanEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !localVariables.includes(name)),
);

for (const exitCode of [0, 23]) {
  test(`pre-push isolates fixture Git commands and preserves verification exit ${exitCode}`, (t) => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'pre-push-isolation-')));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const repo = path.join(root, 'repo');
    const worktree = path.join(root, 'worktree');
    const foreign = path.join(root, 'foreign');
    const bin = path.join(root, 'bin');
    const report = path.join(root, 'report.json');
    for (const dir of [repo, foreign, bin]) mkdirSync(dir);
    const git = (cwd, ...args) =>
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.com',
          '-c',
          'commit.gpgsign=false',
          '-c',
          `core.hooksPath=${path.join(root, 'no-hooks')}`,
          ...args,
        ],
        { cwd, env: cleanEnvironment, encoding: 'utf8', stdio: 'pipe' },
      ).trim();
    git(repo, 'init', '-q');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'chore: fixture');
    git(repo, 'worktree', 'add', '--detach', worktree, 'HEAD');
    const originalHead = git(repo, 'rev-parse', 'HEAD');
    const pnpm = `#!/usr/bin/env node
const {execFileSync} = require('node:child_process');
const {writeFileSync} = require('node:fs');
const git = (...args) => execFileSync('git', args, {cwd: ${JSON.stringify(foreign)}, encoding: 'utf8'}).trim();
git('init', '-q');
writeFileSync(${JSON.stringify(report)}, JSON.stringify({args: process.argv.slice(2), root: git('rev-parse', '--show-toplevel')}));
process.exit(${exitCode});
`;
    writeFileSync(path.join(bin, 'pnpm'), pnpm, { mode: 0o755 });
    const result = spawnSync('sh', ['-e', hook], {
      cwd: worktree,
      env: {
        ...cleanEnvironment,
        GIT_DIR: git(worktree, 'rev-parse', '--absolute-git-dir'),
        PATH: `${bin}${path.delimiter}${cleanEnvironment.PATH ?? ''}`,
      },
      encoding: 'utf8',
    });
    assert.equal(git(repo, 'config', '--local', 'core.bare'), 'false');
    assert.equal(git(repo, 'rev-parse', 'HEAD'), originalHead);
    assert.equal(result.status, exitCode, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(report, 'utf8')), {
      args: ['verify'],
      root: foreign,
    });
  });
}
