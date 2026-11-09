import { afterEach, expect, it, vi } from 'vitest';
import { TaskBlockEditor } from '../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { expectDefined, flushMicrotasks } from './helpers';
import { publicApiHarness, type PublicApiHarness } from './support/publicApiHarness';

const owners: PublicApiHarness[] = [];
afterEach(() => {
  owners.splice(0).forEach((h) => {
    h.dispose();
  });
});
async function setup(content: string) {
  const h = await publicApiHarness({ 'a.md': content });
  owners.push(h);
  return h;
}
it('captures rollback populations without rescanning all physical blocks per root', async () => {
  const count = 64;
  const content = Array.from({ length: count }, (_, i) => `- [ ] Root ${i}\n`).join('');
  const h = await setup(content);
  const first = expectDefined(h.index.list()[0]);
  const parse = TaskBlockEditor.prototype.rootBlocks.bind(new TaskBlockEditor());
  let sourceReads = 0;
  vi.spyOn(TaskBlockEditor.prototype, 'rootBlocks').mockImplementation((...args) => {
    const blocks = parse(...args);
    for (const block of blocks) {
      const source = block.source;
      Object.defineProperty(block, 'source', {
        configurable: true,
        get: () => {
          sourceReads++;
          return source;
        },
      });
    }
    return blocks;
  });
  const result = await h.service.execute({
    type: 'append-title',
    target: { type: 'task', ref: first.ref },
    markdown: 'edited',
  });
  expect(result.type).toBe('ok');
  expect(await h.read('a.md')).toBe(content.replace('Root 0', 'Root 0 edited'));
  expect(sourceReads).toBeLessThan(count * 32);
});
it('does not rescan every installed root for each exact physical-root lookup', async () => {
  const h = await setup(Array.from({ length: 32 }, (_, i) => `- [ ] Root ${i}\n`).join(''));
  const read = h.index.projectSources().get('a.md');
  if (read.type !== 'ok' || read.value === undefined) throw new Error('Missing accepted roots');
  const cases = read.value.roots.map((root) => ({
    ref: root.ref,
    source: root.source.originalBlock,
  }));
  let accesses = 0;
  const restores = read.value.roots.map((root) => {
    const descriptor = expectDefined(Object.getOwnPropertyDescriptor(root.source, 'originalBlock'));
    const value = root.source.originalBlock;
    Object.defineProperty(root.source, 'originalBlock', {
      configurable: true,
      get: () => {
        accesses++;
        return value;
      },
    });
    return () => {
      Object.defineProperty(root.source, 'originalBlock', descriptor);
    };
  });
  try {
    for (const { ref, source } of cases)
      expect(h.index.currentRoot(ref.filePath, ref.line, source)).toEqual(ref);
    expect(accesses).toBeLessThanOrEqual(cases.length * 4);
  } finally {
    restores.forEach((restore) => {
      restore();
    });
  }
});

it('preserves duplicate population order, unique fallback and hint behavior across new installations', async () => {
  const before = '- [ ] Same\n- [ ] Same\n- [ ] Unique\n';
  const h = await setup(before);
  const check = (path: string) => {
    const roots = h.index.list({ filePath: path });
    const first = expectDefined(roots[0]),
      second = expectDefined(roots[1]),
      unique = expectDefined(roots[2]);
    const population = [first.ref.line, second.ref.line];
    expect(
      h.index.currentRoot(path, first.ref.line, first.source.originalBlock, population),
    ).toEqual(first.ref);
    expect(
      h.index.currentRoot(path, second.ref.line, second.source.originalBlock, population),
    ).toEqual(second.ref);
    expect(h.index.currentRoot(path, 999, first.source.originalBlock)).toBeUndefined();
    for (const mismatch of [[first.ref.line], [...population].reverse(), [...population, 999]])
      expect(
        h.index.currentRoot(path, first.ref.line, first.source.originalBlock, mismatch),
      ).toBeUndefined();
    expect(h.index.currentRoot(path, 999, unique.source.originalBlock)).toEqual(unique.ref);
    expect(h.index.currentRoot(path, unique.ref.line, 'unmatched source')).toEqual(unique.ref);
    return first.ref;
  };
  const original = check('a.md');
  h.index.installCommittedContent('a.md', `Prefix\n${before}`);
  expect(check('a.md').line).toBe(original.line + 1);
  h.index.installCommittedContent('a.md', before);
  expect(check('a.md').line).toBe(original.line);
  await h.external('a.md', `External\n${before}`);
  expect(check('a.md').line).toBe(original.line + 1);
  await h.external('a.md', before);
  expect(check('a.md').line).toBe(original.line);
  const file = expectDefined(h.app.vault.getFileByPath('a.md') ?? undefined);
  await h.app.fileManager.renameFile(file, 'renamed.md');
  await flushMicrotasks();
  expect(h.index.currentRoot('a.md', original.line, '- [ ] Same')).toBeUndefined();
  expect(check('renamed.md').filePath).toBe('renamed.md');
  await h.app.fileManager.trashFile(file);
  expect(h.index.currentRoot('renamed.md', 0, '- [ ] Same')).toBeUndefined();
  await h.app.vault.create('renamed.md', before);
  await flushMicrotasks();
  check('renamed.md');
  h.index.destroy();
  expect(h.index.currentRoot('renamed.md', 0, '- [ ] Same')).toBeUndefined();
});
