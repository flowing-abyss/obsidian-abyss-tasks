// @vitest-environment node
import { Platform } from 'obsidian';
import { describe, expect, it } from 'vitest';
import { CHILD_PROCESS_TIMEOUT_MS } from './support/timeouts';

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
  { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync },
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
  const repository = path.join(fixtureDirectory, 'repo');
  mkdirSync(path.join(repository, 'tooling'), { recursive: true });
  for (const file of ['verify-changes.mjs', 'verification-receipt.mjs']) {
    writeFileSync(
      path.join(repository, 'tooling', file),
      readFileSync(path.join(repositoryRoot, 'tooling', file)),
    );
  }
  const commandLog = path.join(fixtureDirectory, 'commands.log');
  const pnpmPath = path.join(fixtureDirectory, 'pnpm');
  // A POSIX shell stand-in for pnpm: the gate spawns it once per stage, and a shell starts in a
  // fraction of the time a Node process takes, which is what a busy machine stretches.
  writeFileSync(
    pnpmPath,
    `#!/bin/sh
if [ "$1" = run ] && [ "$2" = verify:checks ]; then exec /bin/sh -c "$VERIFY_CHECKS_SCRIPT"; fi
command="$1"
if [ "$command" = 'release:artifacts' ]; then printf fresh > fresh-artifact; fi
if [ "$command" = 'lint:css:artifact' ] && [ ! -e fresh-artifact ]; then exit 2; fi
printf '%s\\n' "$command" >> "$COMMAND_LOG"
if [ -n "\${FAIL_COMMAND+set}" ] && [ "$command" = "$FAIL_COMMAND" ]; then exit 1; fi
exit 0
`,
  );
  chmodSync(pnpmPath, 0o755);

  const baseEnv = {
    ...process.env,
    COMMAND_LOG: commandLog,
    VERIFY_CHECKS_SCRIPT: scripts['verify:checks'] ?? '',
    PATH: `${fixtureDirectory}${path.delimiter}${process.env['PATH'] ?? ''}`,
  };
  const env = failCommand === undefined ? baseEnv : { ...baseEnv, FAIL_COMMAND: failCommand };

  try {
    const result = spawnSync(script, {
      cwd: repository,
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
  it(
    'stops the fast gate when CSS linting fails',
    () => {
      const result = runGate(scripts['verify:task'] ?? '', 'lint:css');

      expect(result.status).not.toBe(0);
      expect(result.commands).toContain('lint:css');
      expect(result.commands).not.toContain('test');
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );

  it(
    'stops the fast gate when the architecture check fails',
    () => {
      const result = runGate(scripts['verify:task'] ?? '', 'arch');

      expect(result.status).not.toBe(0);
      expect(result.commands).toContain('arch');
      expect(result.commands).not.toContain('test');
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );

  it(
    'stops the full gate when reviewed regex analysis fails',
    () => {
      const result = runGate(scripts['verify'] ?? '', 'lint:regex');
      expect(result.status).not.toBe(0);
      expect(result.commands).toEqual(['format:check', 'lint', 'lint:regex']);
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );

  it(
    'stops the full gate when the Store review lint fails',
    () => {
      const result = runGate(scripts['verify'] ?? '', 'lint:store');

      expect(result.status).not.toBe(0);
      expect(result.commands).toContain('lint:store');
      expect(result.commands).not.toContain('typecheck');
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );

  it(
    'stops when artifact CSS fails after fresh generation',
    () => {
      const result = runGate(scripts['verify'] ?? '', 'lint:css:artifact');
      expect(result.status).not.toBe(0);
      expect(result.commands).toContain('release:artifacts');
      expect(result.commands).toContain('lint:css:artifact');
      expect(result.commands).not.toContain('release:check');
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );

  it(
    'runs every established stage of the full verification gate',
    () => {
      const result = runGate(scripts['verify'] ?? '');

      expect(result.status).toBe(0);
      expect(result.commands).toEqual([
        'format:check',
        'lint',
        'lint:regex',
        'lint:css',
        'lint:store',
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
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );
});
