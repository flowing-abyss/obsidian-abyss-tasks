// @vitest-environment node
import { Platform } from 'obsidian';
import { afterEach, expect, it } from 'vitest';
import { sourceFingerprint } from './command-live/provenance';
async function native() {
  if (!Platform.isDesktop) throw new Error('Source fingerprint tests require desktop');
  const [files, os, path] = await Promise.all([
    import('node:fs/promises'),
    import('node:os'),
    import('node:path'),
  ]);
  return { ...files, ...os, ...path };
}
const roots: string[] = [];
afterEach(async () => {
  const { rm } = await native();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(reverse: boolean) {
  const { mkdtemp, mkdir, tmpdir, join, writeFile } = await native();
  const root = await mkdtemp(join(tmpdir(), 'command-src-fingerprint-'));
  roots.push(root);
  await mkdir(join(root, 'ai'));
  const files = ['ai/commandWrites.ts', 'ai/commandReads.ts', 'main.ts'];
  for (const path of reverse ? [...files].reverse() : files)
    await writeFile(join(root, path), `source of ${path}`);
  return root;
}
it('fingerprints all source files deterministically regardless of directory creation order', async () => {
  const a = await fixture(false),
    b = await fixture(true);
  expect(await sourceFingerprint(a)).toEqual(await sourceFingerprint(b));
  expect((await sourceFingerprint(a)).files.map((file) => file.path)).toEqual([
    'ai/commandReads.ts',
    'ai/commandWrites.ts',
    'main.ts',
  ]);
});
it('changes the full tree fingerprint when copied source contents or relative paths change', async () => {
  const { join, writeFile, rename } = await native();
  const root = await fixture(false);
  const before = await sourceFingerprint(root);
  await writeFile(join(root, 'ai/commandWrites.ts'), 'changed readback');
  const changed = await sourceFingerprint(root);
  expect(changed.treeHash).not.toBe(before.treeHash);
  expect(changed.files.find((file) => file.path === 'main.ts')).toEqual(
    before.files.find((file) => file.path === 'main.ts'),
  );
  await rename(join(root, 'ai/commandWrites.ts'), join(root, 'ai/renamed.ts'));
  expect((await sourceFingerprint(root)).treeHash).not.toBe(changed.treeHash);
});

it('rejects source symlinks instead of reading files outside the selected tree', async () => {
  const { symlink, join } = await native();
  const root = await fixture(false),
    outside = await fixture(false);
  await symlink(join(outside, 'main.ts'), join(root, 'outside.ts'));
  await expect(sourceFingerprint(root)).rejects.toThrow('source-symlink-not-allowed');
});
