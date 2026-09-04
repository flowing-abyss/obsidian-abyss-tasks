// Structural tests for the .ai/ tree — plain tests against this repo's own
// real tree, not a separate validation framework and not synthetic
// fixtures. Checks objective, mechanically-verifiable properties only:
// broken links, dangling formal skill references, and the specific hook
// registrations this template actually depends on. It does not check
// Markdown prose, workflow explanations, or hardcoded skill lists — those
// turn tests into a second specification and drift from the real docs.

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const aiRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(aiRoot, '..');
const skillsRoot = path.join(aiRoot, 'skills');
const hooksRoot = path.join(aiRoot, 'hooks');
const configsRoot = path.join(aiRoot, 'configs');

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
  });
}

const markdownFiles = listFiles(skillsRoot).filter((f) => f.endsWith('.md'));
const skillDirs = new Set(
  readdirSync(skillsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name),
);

test('relative Markdown links in skills resolve to existing files', () => {
  const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;
  const problems = [];

  for (const file of markdownFiles) {
    // writing-skills is vendored upstream meta-documentation about how to
    // write skills; its links are illustrative filenames for a
    // hypothetical skill package, not real navigation targets here.
    if (path.relative(skillsRoot, file).startsWith(`writing-skills${path.sep}`)) continue;

    const content = readFileSync(file, 'utf8');
    for (const match of content.matchAll(linkPattern)) {
      const target = match[1].split('#')[0].trim();
      if (!target || /^([a-z]+:)?\/\//i.test(target) || target.startsWith('mailto:')) continue;
      const resolved = path.resolve(path.dirname(file), target);
      if (!existsSync(resolved)) {
        problems.push(`${path.relative(repoRoot, file)}: ${target}`);
      }
    }
  }

  assert.deepEqual(problems, []);
});

test('formal skill:<name> and superpowers:<name> references point to existing skill directories', () => {
  const pattern = /\b(?:superpowers|skill):([a-z][a-z0-9-]*)/g;
  const problems = [];

  for (const file of markdownFiles) {
    const content = readFileSync(file, 'utf8');
    for (const match of content.matchAll(pattern)) {
      if (!skillDirs.has(match[1])) {
        problems.push(`${path.relative(repoRoot, file)}: ${match[0]}`);
      }
    }
  }

  assert.deepEqual(problems, []);
});

test('inject-superpowers.mjs is registered in the Claude Code and Codex configs', () => {
  const claude = readFileSync(path.join(configsRoot, '.claude', 'settings.json'), 'utf8');
  const codex = readFileSync(path.join(configsRoot, '.codex', 'hooks.json'), 'utf8');
  assert.match(claude, /inject-superpowers\.mjs/);
  assert.match(codex, /inject-superpowers\.mjs/);
});

test('CodeGraph is enabled, Serena is absent, and canonical instructions explain indexing', () => {
  const codex = readFileSync(path.join(configsRoot, '.codex', 'config.toml'), 'utf8');
  const opencode = JSON.parse(readFileSync(path.join(configsRoot, 'opencode.json'), 'utf8'));
  const claude = JSON.parse(readFileSync(path.join(configsRoot, '.mcp.json'), 'utf8'));
  const agents = readFileSync(path.join(configsRoot, 'AGENTS.md'), 'utf8');

  assert.match(codex, /\[mcp_servers\.codegraph\][\s\S]*?enabled = true/);
  assert.doesNotMatch(codex, /mcp_servers\.serena/);
  assert.equal(opencode.mcp?.codegraph?.enabled, true);
  assert.equal(opencode.mcp?.serena, undefined);
  assert.deepEqual(claude.mcpServers?.codegraph, {
    command: 'codegraph',
    args: ['serve', '--mcp'],
  });
  assert.equal(claude.mcpServers?.serena, undefined);
  assert.match(agents, /codegraph init --yes/);
  assert.match(agents, /codegraph status/);
});

test('every Codex command hook has a commandWindows counterpart', () => {
  const codex = JSON.parse(readFileSync(path.join(configsRoot, '.codex', 'hooks.json'), 'utf8'));
  const commandHooks = Object.values(codex.hooks)
    .flat()
    .flatMap((entry) => entry.hooks)
    .filter((hook) => hook.type === 'command');

  assert.ok(commandHooks.length > 0, 'no command hooks found in .codex/hooks.json');
  for (const hook of commandHooks) {
    assert.ok(hook.commandWindows, `missing commandWindows for: ${hook.command}`);
  }
});

test('block-npm-commands.mjs is registered in all four harness configs', () => {
  const configFiles = [
    path.join(configsRoot, '.claude', 'settings.json'),
    path.join(configsRoot, '.codex', 'hooks.json'),
    path.join(configsRoot, '.opencode', 'plugins', 'pnpm-policy.js'),
    path.join(configsRoot, '.pi', 'extensions', 'pnpm-policy.ts'),
  ];
  for (const file of configFiles) {
    assert.match(readFileSync(file, 'utf8'), /block-npm-commands\.mjs/, file);
  }
});

test('package.json defines the canonical verify script', () => {
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.ok(packageJson.scripts?.verify, 'package.json is missing a "verify" script');
});

test('official Obsidian metadata lint rejects invalid manifest and license fixtures', async () => {
  const { ESLint } = await import('eslint');
  const eslint = new ESLint({ cwd: repoRoot });
  const [manifestResult] = await eslint.lintText('{}', { filePath: 'manifest.json' });
  const [licenseResult] = await eslint.lintText('Copyright (C) 2020 by Dynalist Inc.\n', {
    filePath: 'LICENSE',
  });

  assert.ok(
    manifestResult.messages.some((message) => message.ruleId === 'obsidianmd/validate-manifest'),
    'invalid manifest fixture bypassed obsidianmd/validate-manifest',
  );
  assert.ok(
    licenseResult.messages.some((message) => message.ruleId === 'obsidianmd/validate-license'),
    'invalid license fixture bypassed obsidianmd/validate-license',
  );
});

test('canonical instructions forbid weakening official Obsidian rules across the plugin', () => {
  const agents = readFileSync(path.join(configsRoot, 'AGENTS.md'), 'utf8');
  assert.match(
    agents,
    /Never disable, downgrade, bypass, or warn-only an applicable `eslint-plugin-obsidianmd` rule/u,
  );
  assert.match(agents, /`manifest\.json`, and `LICENSE`/u);
});

test('every path setup.mjs mirrors actually exists', () => {
  assert.ok(
    existsSync(skillsRoot),
    '.ai/skills is missing (setup.mjs symlinks every harness to it)',
  );
  assert.ok(
    existsSync(path.join(configsRoot, 'AGENTS.md')),
    '.ai/configs/AGENTS.md is missing (CLAUDE.md aliases to it)',
  );

  const configFiles = listFiles(configsRoot);
  assert.ok(configFiles.length > 0, '.ai/configs has no files for setup.mjs to mirror');
  for (const file of configFiles) {
    assert.ok(existsSync(file), file);
  }
});

test('setup.mjs is actually idempotent: two runs both exit 0, and the second reports no conflicts', () => {
  const setupPath = path.join(aiRoot, 'setup.mjs');

  const first = spawnSync(process.execPath, [setupPath], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(first.status, 0, `first run failed:\n${first.stdout}\n${first.stderr}`);

  const second = spawnSync(process.execPath, [setupPath], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(second.status, 0, `second run failed:\n${second.stdout}\n${second.stderr}`);
  // Per-item lines start with "conflict "; the summary line ("0 created, N
  // already OK, 0 conflicts.") always contains the word "conflicts" even
  // when the count is zero, so match the line prefix, not the bare word.
  assert.doesNotMatch(
    second.stdout,
    /^conflict /m,
    `second run reported a conflict:\n${second.stdout}`,
  );
});

// --- block-npm-commands.mjs: a few common cases, not a full parser test ---

function runBlockNpmCommands(command) {
  const result = spawnSync(process.execPath, [path.join(hooksRoot, 'block-npm-commands.mjs')], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf8',
  });
  return result.stdout?.trim() ? JSON.parse(result.stdout) : null;
}

test('block-npm-commands blocks common npm/npx forms', () => {
  const cases = [
    'npm install',
    'npx some-tool',
    'sudo npm install',
    'env FOO=bar npm test',
    'echo hi && npm install',
    'echo hi; npx some-tool',
  ];
  for (const command of cases) {
    const result = runBlockNpmCommands(command);
    assert.equal(result?.hookSpecificOutput?.permissionDecision, 'deny', command);
  }
});

test('block-npm-commands allows pnpm and unrelated commands', () => {
  const cases = ['pnpm install', 'pnpm run build', 'echo hello', 'git status'];
  for (const command of cases) {
    assert.equal(runBlockNpmCommands(command), null, command);
  }
});

test('block-npm-commands does not treat newlines as command separators', () => {
  // A multi-line heredoc/commit message passed as one quoted argument (e.g.
  // `git commit -m "$(cat <<'EOF' ... )"`) contains real newlines that
  // aren't shell separators — prose mentioning npm/npx on its own line
  // must not be treated as an executable invocation.
  const command = 'git commit -m "line one\nnpm/npx commands mentioned here\nline three"';
  assert.equal(runBlockNpmCommands(command), null, command);
});
