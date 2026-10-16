// @vitest-environment node
import { Platform } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluate } from '../tooling/performance/driver.mts';

const bridge = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<NodeModules['child']>();
  const execFile = Object.assign(actual.execFile.bind(actual), {
    [Symbol.for('nodejs.util.promisify.custom')]: bridge.run,
  });
  return { ...actual, execFile };
});
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<NodeModules['files']>();
  return { ...actual, mkdtemp: vi.fn(actual.mkdtemp), rm: vi.fn(actual.rm) };
});
const loadNode = async () => {
  if (!Platform.isDesktop) throw new Error('Driver tests require desktop');
  return {
    fs: await import('node:fs'),
    child: await import('node:child_process'),
    files: await import('node:fs/promises'),
    vm: await import('node:vm'),
    delay: (await import('node:timers/promises')).setTimeout,
  };
};
type NodeModules = Awaited<ReturnType<typeof loadNode>>;
const { fs, files, vm, delay } = await loadNode();
const directories: string[] = [];
const pending: Array<Promise<unknown>> = [];
let mutations = 0;
let vault = 'dev-vault-tasks';
let lostResponse = false;
let delayLaunch = false;
let lateReply = false;
let release: () => void;
let reject: (error: unknown) => void;
let settled: Promise<void>;
let rendererFs = fs;
let rendererErrors: unknown[] = [];
let now = 0;

beforeEach(() => {
  mutations = 0;
  vault = 'dev-vault-tasks';
  lostResponse = false;
  delayLaunch = false;
  lateReply = false;
  rendererFs = fs;
  rendererErrors = [];
  now = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  settled = new Promise<void>((resolve, fail) => {
    release = resolve;
    reject = fail;
  });
  vi.mocked(files.mkdtemp).mockImplementation(async (...args) => {
    const dir = await fs.promises.mkdtemp(...args);
    directories.push(dir);
    return dir;
  });
  vi.mocked(files.rm).mockImplementation(fs.promises.rm);
  bridge.run.mockImplementation(
    async (file: string, args: string[], options: { signal?: AbortSignal }) => {
      if (file !== 'obsidian' || args[0] !== 'vault=dev-vault-tasks' || args[1] !== 'eval')
        throw new Error('Unexpected CLI invocation');
      if (delayLaunch) await settled;
      const source = args[2]?.slice('code='.length) ?? '';
      const response: unknown = vm.runInNewContext(source, {
        app: { vault: { getName: () => vault } },
        require: (id: string) => {
          if (id !== 'fs' && id !== 'node:fs') throw new Error(`Unexpected require: ${id}`);
          return rendererFs;
        },
        mutate: () => ++mutations,
        wait: () => settled,
        console: { error: (...values: unknown[]) => rendererErrors.push(values) },
      });
      const observed = Promise.resolve(response);
      pending.push(observed);
      if (lateReply) await settled;
      if (!lostResponse) return { stdout: `=> ${String(await observed)}\n` };
      await observed; // The renderer settles, but this CLI response never reaches the caller.
      return await new Promise((_, fail) => {
        options.signal?.addEventListener(
          'abort',
          () => {
            fail(new Error('CLI aborted'));
          },
          {
            once: true,
          },
        );
      });
    },
  );
});
afterEach(async () => {
  release();
  await Promise.all(pending.splice(0));
  for (const dir of directories.splice(0))
    await fs.promises.rm(dir, { recursive: true, force: true });
});
async function waitForMutation(): Promise<void> {
  await vi.waitFor(() => {
    expect(mutations).toBe(1);
  });
}
async function expectClean(): Promise<void> {
  for (const dir of directories) expect(fs.existsSync(dir)).toBe(false);
  expect(rendererErrors).toEqual([]);
}

describe('canonical profiler evaluation transport', () => {
  it('returns a settled result exactly once when the asynchronous CLI response is lost', async () => {
    lostResponse = true;
    await expect(evaluate('mutate(); return await Promise.resolve({answer:42});')).resolves.toEqual(
      {
        answer: 42,
      },
    );
    expect(mutations).toBe(1);
    expect(bridge.run).toHaveBeenCalledTimes(1);
    await expectClean();
  }, 1000);

  it('does not wait for a delayed launch acknowledgement and handles its late rejection', async () => {
    lateReply = true;
    const result = evaluate('mutate(); return 7;');
    await expect(result).resolves.toBe(7);
    reject(new Error('late CLI failure'));
    await delay(20);
    expect(mutations).toBe(1);
    await expectClean();
  });

  it('propagates the original body rejection and stack through a lost response', async () => {
    lostResponse = true;
    await expect(evaluate('mutate(); throw new TypeError("reset rejected");')).rejects.toThrow(
      /TypeError: reset rejected/u,
    );
    expect(mutations).toBe(1);
    await expectClean();
  });

  it('isolates concurrent calls and their independent results', async () => {
    const first = evaluate('mutate(); await wait(); return "first";');
    await waitForMutation();
    await expect(evaluate('mutate(); return "second";')).resolves.toBe('second');
    release();
    await expect(first).resolves.toBe('first');
    expect(mutations).toBe(2);
    expect(new Set(directories).size).toBe(2);
    await expectClean();
  });

  it('refuses the wrong vault before running the body', async () => {
    vault = 'production';
    await expect(evaluate('mutate(); return true;')).rejects.toThrow('Wrong vault');
    expect(mutations).toBe(0);
    await expectClean();
  });

  it.each(['not json', '{"ok":true,"id":"another-call","value":9}', '{"ok":"yes"}'])(
    'rejects malformed or foreign completion data: %s',
    async (payload) => {
      rendererFs = {
        ...fs,
        writeFileSync: (file, _data, options) => {
          fs.writeFileSync(file, payload, options);
        },
      };
      await expect(evaluate('mutate(); return 9;')).rejects.toThrow(/result|envelope|response/iu);
      expect(mutations).toBe(1);
      await expectClean();
    },
  );

  it('bounds a missing completion and prevents a late success from recreating files', async () => {
    const result = evaluate('mutate(); await wait(); return 9;');
    const rejected = expect(result).rejects.toThrow(/timed out/iu);
    await waitForMutation();
    now = 120001;
    await rejected;
    await expectClean();
    release();
    await delay(20);
    await expectClean();
    expect(mutations).toBe(1);
  });

  it('handles a rejection after timeout without an unhandled promise or recreated files', async () => {
    const result = evaluate('mutate(); await wait();');
    const rejected = expect(result).rejects.toThrow(/timed out/iu);
    await waitForMutation();
    now = 120001;
    await rejected;
    reject(new Error('late failure'));
    await delay(20);
    await expectClean();
  });

  it('prevents an expired queued launch from starting a mutation', async () => {
    delayLaunch = true;
    const result = evaluate('mutate(); return 9;');
    const rejected = expect(result).rejects.toThrow(/timed out/iu);
    await vi.waitFor(() => {
      expect(bridge.run).toHaveBeenCalledTimes(1);
    });
    now = 120001;
    await rejected;
    release();
    await delay(20);
    expect(mutations).toBe(0);
    await expectClean();
  });

  it('propagates a CLI launch failure without replaying the action', async () => {
    bridge.run.mockRejectedValue(new Error('CLI launch failed'));
    await expect(evaluate('mutate(); return 9;')).rejects.toThrow('CLI launch failed');
    expect(mutations).toBe(0);
    expect(bridge.run).toHaveBeenCalledTimes(1);
    await expectClean();
  });

  it('retains undefined results from bodies without a return value', async () => {
    await expect(evaluate('mutate();')).resolves.toBeUndefined();
    expect(mutations).toBe(1);
    await expectClean();
  });

  it('propagates primitive promise rejections without accepting a value', async () => {
    await expect(evaluate('return await Promise.reject("primitive rejection");')).rejects.toThrow(
      'primitive rejection',
    );
    await expectClean();
  });

  it('surfaces completion delivery failures and excludes their missing result', async () => {
    rendererFs = {
      ...fs,
      renameSync: () => {
        throw new Error('disk failure');
      },
    };
    const result = evaluate('mutate(); return 9;');
    const rejected = expect(result).rejects.toThrow(/timed out/iu);
    await waitForMutation();
    now = 120001;
    await rejected;
    expect(rendererErrors.flat().join(' ')).toContain('disk failure');
    for (const dir of directories) expect(fs.existsSync(dir)).toBe(false);
  });

  it('reports cleanup failure after success without accepting a sample', async () => {
    vi.mocked(files.rm).mockRejectedValue(new Error('cleanup denied'));
    await expect(evaluate('return 9;')).rejects.toThrow(/cleanup denied/u);
  });

  it('retains both the original body error and cleanup failure', async () => {
    vi.mocked(files.rm).mockRejectedValue(new Error('cleanup denied'));
    const error: unknown = await evaluate('throw Error("body rejected");').catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map(String).join(' ')).toContain('body rejected');
    expect((error as AggregateError).errors.map(String).join(' ')).toContain('cleanup denied');
  });
});
