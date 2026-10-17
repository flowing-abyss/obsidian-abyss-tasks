// @vitest-environment node
import { Platform } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { command } from '../tooling/performance/driver.mts';

const loadNode = async () => {
  if (!Platform.isDesktop) throw new Error('Profiler process tests require desktop');
  return Promise.all([
    import('node:events'),
    import('node:fs/promises'),
    import('node:os'),
    import('node:path'),
  ]);
};
const [{ default: events }, { mkdtemp, readFile, rm }, { tmpdir }, path] = await loadNode();

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === 'ESRCH') return false;
    throw error;
  }
}

function terminate(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if ((error as { code?: string }).code !== 'ESRCH') throw error;
  }
}

describe('profiler command process ownership', () => {
  it('reaps a ready child that ignores SIGTERM before cancellation rejects', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'abyss-profile-process-'));
    const ready = path.join(directory, 'ready');
    const abort = new AbortController();
    let pid: number | undefined;
    let settled = false;
    const result = command(
      process.execPath,
      [
        '-e',
        `process.on('SIGTERM', () => {});
          require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid));
          setTimeout(() => {}, 10000);`,
      ],
      directory,
      abort.signal,
    ).then(
      (stdout) => {
        settled = true;
        return { stdout };
      },
      (error: unknown) => {
        settled = true;
        return { error };
      },
    );
    try {
      await vi.waitFor(
        async () => {
          const publishedPid = Number(await readFile(ready, 'utf8'));
          expect(Number.isSafeInteger(publishedPid)).toBe(true);
          expect(publishedPid).toBeGreaterThan(0);
          pid = publishedPid;
        },
        { timeout: 5000 },
      );
      if (pid === undefined) throw new Error('Child did not publish readiness');
      expect(running(pid)).toBe(true);

      abort.abort();

      await vi.waitFor(
        () => {
          expect(settled).toBe(true);
        },
        { timeout: 2000 },
      );
      const outcome = await result;
      expect(outcome).toHaveProperty('error');
      if ('error' in outcome) expect(outcome.error).toBeInstanceOf(Error);
      expect(running(pid)).toBe(false);
      expect(events.getEventListeners(abort.signal, 'abort')).toEqual([]);
    } finally {
      abort.abort();
      try {
        const childPid = pid;
        if (childPid !== undefined) terminate(childPid);
        await result;
        if (childPid !== undefined)
          await vi.waitFor(() => {
            expect(running(childPid)).toBe(false);
          });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  it('terminates an already-aborted command without retaining a listener', async () => {
    const abort = new AbortController();
    abort.abort();
    const start = performance.now();

    await expect(
      command(process.execPath, ['-e', 'setTimeout(() => {}, 10000);'], undefined, abort.signal),
    ).rejects.toMatchObject({ killed: true, signal: 'SIGKILL' });

    expect(performance.now() - start).toBeLessThan(2000);
    expect(events.getEventListeners(abort.signal, 'abort')).toEqual([]);
  });

  it.each([
    { exitCode: 0, expected: { stdout: 'profile output' } },
    {
      exitCode: 7,
      expected: {
        error: { code: 7, signal: null, stdout: 'profile output', stderr: 'diagnostic' },
      },
    },
  ])(
    'preserves stdout and error details for exit $exitCode and releases cancellation',
    async ({ exitCode, expected }) => {
      const abort = new AbortController();
      const result = await command(
        process.execPath,
        [
          '-e',
          `process.stdout.write('profile output');
          process.stderr.write('diagnostic');
          process.exitCode = ${exitCode};`,
        ],
        undefined,
        abort.signal,
      ).then(
        (stdout) => ({ stdout }),
        (error: unknown) => ({ error }),
      );

      expect(result).toMatchObject(expected);
      expect(events.getEventListeners(abort.signal, 'abort')).toEqual([]);
      abort.abort();
    },
  );

  it('retains spawn failures and removes their cancellation listener', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'abyss-profile-missing-'));
    const abort = new AbortController();
    try {
      await expect(
        command(path.join(directory, 'missing'), [], undefined, abort.signal),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(events.getEventListeners(abort.signal, 'abort')).toEqual([]);
      abort.abort();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
