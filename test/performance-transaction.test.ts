// @vitest-environment node
import { Platform } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluate, type HostBefore } from '../tooling/performance/driver.mts';
import { FIXTURE_FOLDER } from '../tooling/performance/fixture.mts';
import { hostRunning } from '../tooling/performance/recovery.mts';
import { restoreHost } from '../tooling/performance/runner.mts';
import { VaultTransaction } from '../tooling/performance/transaction.mts';
vi.mock('../tooling/performance/driver.mts', () => ({
  evaluate: vi.fn(),
  cli: vi.fn(),
  preflight: vi.fn(),
  command: vi.fn(),
}));
const loadNode = async () => {
  if (!Platform.isDesktop) throw new Error('Filesystem tests require desktop');
  return {
    ...(await import('node:fs/promises')),
    ...(await import('node:os')),
    path: (await import('node:path')).default,
  };
};
const { mkdir, mkdtemp, readFile, rm, symlink, writeFile, tmpdir, path } = await loadNode();

const roots: string[] = [];
async function setup(): Promise<{ vault: string; output: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'abyss-profile-test-'));
  roots.push(root);
  const vault = path.join(root, 'dev-vault-tasks');
  await mkdir(path.join(vault, '.test-config/plugins/abyss-tasks'), { recursive: true });
  return { vault, output: path.join(root, 'result') };
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('recoverable performance transaction', () => {
  it('validates ownership before native cleanup and retains the lock through host restoration', async () => {
    const { vault, output } = await setup();
    const before: HostBefore = {
      vault,
      configDir: '.test-config',
      debugger: true,
      enabled: false,
      runtimeErrors: '',
      devtools: false,
      layout: {},
      identity: {},
    };
    const old = await VaultTransaction.begin(vault, output, before.configDir);
    await old.restore();
    const current = await VaultTransaction.begin(vault, `${output}-new`, before.configDir);
    const evaluateMock = vi.mocked(evaluate);
    evaluateMock.mockReset().mockResolvedValue(true);
    await expect(restoreHost(old, before)).rejects.toThrow(/ownership/iu);
    expect(evaluateMock).not.toHaveBeenCalled();
    const lock = path.join(vault, '.test-config/abyss-profile.lock');
    evaluateMock.mockImplementation(async (code) => {
      if (code.includes('changeLayout')) {
        expect(await readFile(lock, 'utf8')).toContain(`${output}-new`);
        throw new Error('Host layout failed');
      }
      return true;
    });
    await expect(restoreHost(current, before)).rejects.toThrow('Host layout failed');
    expect(await readFile(lock, 'utf8')).toContain(`${output}-new`);
    evaluateMock.mockResolvedValue(true);
    await restoreHost(current, before);
    await expect(readFile(lock)).rejects.toThrow();
  });
  it('recognizes desktop host processes without confusing QuickLook with a running app', () => {
    expect(hostRunning('/Applications/Obsidian.app/Contents/MacOS/Obsidian\n/usr/bin/node')).toBe(
      true,
    );
    expect(hostRunning('"Obsidian.exe","42","Console"')).toBe(true);
    expect(hostRunning('/usr/bin/obsidian')).toBe(true);
    expect(
      hostRunning('/Applications/Obsidian.app/Contents/PlugIns/ObsidianQuickLook\n/usr/bin/node'),
    ).toBe(false);
  });
  it('restores binary originals and absence, preserving unrelated notes', async () => {
    const { vault, output } = await setup();
    const name = '.test-config/plugins/abyss-tasks/main.js';
    const original = Buffer.from([0, 255, 13, 10]);
    await writeFile(path.join(vault, name), original);
    await writeFile(path.join(vault, 'untouched.md'), 'original');
    const tx = await VaultTransaction.begin(vault, output, '.test-config');
    await tx.write(name, Buffer.from('candidate'));
    await tx.write(`${FIXTURE_FOLDER}/generated.md`, Buffer.from('fixture'));
    await tx.restore();
    expect(await readFile(path.join(vault, name))).toEqual(original);
    await expect(readFile(path.join(vault, FIXTURE_FOLDER, 'generated.md'))).rejects.toThrow();
    expect(await readFile(path.join(vault, 'untouched.md'), 'utf8')).toBe('original');
    expect(await tx.verify()).toBe(true);
  });
  it('keeps a durable recovery journal and prevents concurrent runs', async () => {
    const { vault, output } = await setup();
    const tx = await VaultTransaction.begin(vault, output, '.test-config');
    await tx.write('.test-config/plugins/abyss-tasks/data.json', Buffer.from('{}'));
    await expect(VaultTransaction.begin(vault, `${output}-second`, '.test-config')).rejects.toThrow(
      /lock/i,
    );
    const recovered = await VaultTransaction.load(output);
    await recovered.restore();
    expect(await tx.verify()).toBe(true);
  });
  it('rejects occupied fixtures, unsafe roots, traversal and symlinks', async () => {
    const { vault, output } = await setup();
    await mkdir(path.join(vault, FIXTURE_FOLDER));
    await expect(VaultTransaction.begin(vault, output, '.test-config')).rejects.toThrow(
      /occupied/i,
    );
    await rm(path.join(vault, FIXTURE_FOLDER), { recursive: true });
    await expect(
      VaultTransaction.begin(vault, path.join(vault, 'results'), '.test-config'),
    ).rejects.toThrow(/outside/i);
    const tx = await VaultTransaction.begin(vault, output, '.test-config');
    await expect(tx.write('../escape', Buffer.from('bad'))).rejects.toThrow();
    await expect(tx.write('untouched.md', Buffer.from('bad'))).rejects.toThrow();
    await symlink(output, path.join(vault, FIXTURE_FOLDER, 'link'));
    await expect(tx.write(`${FIXTURE_FOLDER}/link/escape`, Buffer.from('bad'))).rejects.toThrow(
      /symbolic/i,
    );
    await rm(path.join(vault, FIXTURE_FOLDER, 'link'));
    await tx.restore();
  });
  it('finishes interrupted lock release and refuses a lock belonging to another run', async () => {
    const { vault, output } = await setup();
    const tx = await VaultTransaction.begin(vault, output, '.test-config');
    const lock = path.join(vault, '.test-config/abyss-profile.lock');
    const ownedLock = await readFile(lock);
    await tx.restore();
    await writeFile(lock, ownedLock);
    await (await VaultTransaction.load(output)).restore();
    await expect(readFile(lock)).rejects.toThrow();
    await writeFile(lock, JSON.stringify({ output: `${output}-foreign`, pid: 123 }));
    await expect((await VaultTransaction.load(output)).restore()).rejects.toThrow(/ownership/iu);
    expect(await readFile(lock, 'utf8')).toContain('foreign');
  });
});
