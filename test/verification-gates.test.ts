import { Platform } from 'obsidian';
import { describe, expect, it } from 'vitest';

const loadNodeTools = async () => {
  if (!Platform.isDesktop) throw new Error('Verification gate tests require a desktop runtime');
  return Promise.all([
    import('node:child_process'),
    import('node:fs'),
    import('node:os'),
    import('node:path'),
  ]);
};
const [
  { spawnSync },
  { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync },
  { tmpdir },
  path,
] = await loadNodeTools();

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};
const scripts = packageJson.scripts;

function runGate(
  script: string,
  failCommand?: string,
): { status: number | null; commands: string[] } {
  const fixtureDirectory = mkdtempSync(path.join(tmpdir(), 'abyss-verification-gate-'));
  const commandLog = path.join(fixtureDirectory, 'commands.log');
  const pnpmPath = path.join(fixtureDirectory, 'pnpm');
  writeFileSync(
    pnpmPath,
    `#!/usr/bin/env node
const { appendFileSync, existsSync, writeFileSync } = require('node:fs');
const command = process.argv[2];
if (command === 'release:artifacts') writeFileSync('fresh-artifact', 'fresh');
if (command === 'lint:css:artifact' && !existsSync('fresh-artifact')) process.exit(2);
appendFileSync(process.env.COMMAND_LOG, command + '\\n');
process.exit(command === process.env.FAIL_COMMAND ? 1 : 0);
`,
  );
  chmodSync(pnpmPath, 0o755);

  const baseEnv = {
    ...process.env,
    COMMAND_LOG: commandLog,
    PATH: `${fixtureDirectory}${path.delimiter}${process.env['PATH'] ?? ''}`,
  };
  const env = failCommand === undefined ? baseEnv : { ...baseEnv, FAIL_COMMAND: failCommand };

  try {
    const result = spawnSync(script, {
      cwd: fixtureDirectory,
      encoding: 'utf8',
      env,
      shell: true,
    });
    const commands = existsSync(commandLog)
      ? readFileSync(commandLog, 'utf8').trim().split('\n').filter(Boolean)
      : [];
    return { status: result.status, commands };
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
}

describe('verification gates', () => {
  it('stops the fast gate when CSS linting fails', () => {
    const result = runGate(scripts['verify:task'] ?? '', 'lint:css');

    expect(result.status).not.toBe(0);
    expect(result.commands).toContain('lint:css');
    expect(result.commands).not.toContain('test');
  });

  it('stops the fast gate when the architecture check fails', () => {
    const result = runGate(scripts['verify:task'] ?? '', 'arch');

    expect(result.status).not.toBe(0);
    expect(result.commands).toContain('arch');
    expect(result.commands).not.toContain('test');
  });

  it('stops when artifact CSS fails after fresh generation', () => {
    const result = runGate(scripts['verify'] ?? '', 'lint:css:artifact');
    expect(result.status).not.toBe(0);
    expect(result.commands).toContain('release:artifacts');
    expect(result.commands).toContain('lint:css:artifact');
    expect(result.commands).not.toContain('release:check');
  });

  it('runs every established stage of the full verification gate', () => {
    const result = runGate(scripts['verify'] ?? '');

    expect(result.status).toBe(0);
    expect(result.commands).toEqual([
      'format:check',
      'lint',
      'lint:css',
      'typecheck',
      'arch',
      'deadcode',
      'test:ai',
      'test:coverage',
      'build',
      'release:artifacts',
      'lint:css:artifact',
      'release:check',
      'audit:dependencies',
    ]);
  });
});
