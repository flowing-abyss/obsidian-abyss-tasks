// @vitest-environment node
import { Platform } from 'obsidian';
import { afterEach, describe, expect, it } from 'vitest';
import { FIXTURE_FOLDER } from '../tooling/performance/fixture';
import { VaultTransaction } from '../tooling/performance/transaction';
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
});
