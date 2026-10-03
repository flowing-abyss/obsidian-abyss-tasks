import { describe, expect, it, vi } from 'vitest';
import { expectDefined, flushMicrotasks } from '../helpers';
import { hierarchyHarness as harness } from '../support/taskHierarchyHarness';
describe('hierarchy repository transaction', () => {
  it('writes destination first, removes a task-empty source, and publishes only the complete move', async () => {
    const h = await harness();
    const writes: string[] = [];
    const process = h.app.vault.process.bind(h.app.vault);
    vi.spyOn(h.app.vault, 'process').mockImplementation(async (file, transform, options) => {
      writes.push(file.path);
      return process(file, transform, options);
    });
    const result = await h.service.execute(h.command);
    expect(result).toMatchObject({
      type: 'ok',
      changed: true,
      outcome: {
        type: 'hierarchy',
        moved: { root: { ref: { filePath: 'target.md' } }, target: { type: 'subtask' } },
      },
    });
    expect(writes).toEqual(['target.md', 'source.md']);
    expect(await h.read('source.md')).toBe('');
    expect(await h.read('target.md')).toBe(
      '- [ ] Parent\n    - [ ] Move\n      - [ ] Child ^child\n',
    );
    await flushMicrotasks();
    expect(h.publications).toEqual([['target.md:Parent']]);
  });
  it('promotes a child after the entire source root in one process', async () => {
    const h = await harness();
    const process = vi.spyOn(h.app.vault, 'process');
    const result = await h.service.execute({
      type: 'promote-subtask',
      subtask: expectDefined(h.source.subtasks[0]).ref,
    });
    expect(result).toMatchObject({
      type: 'ok',
      outcome: { type: 'hierarchy', moved: { target: { type: 'task' } } },
    });
    expect(await h.read('source.md')).toBe('- [ ] Move\n- [ ] Child ^child\n');
    expect(process).toHaveBeenCalledTimes(1);
  });
  it.each(['before-write', 'after-write', 'proof', 'completion'] as const)(
    'restores exact bytes after %s failure and publishes no candidate',
    async (failure) => {
      const h = await harness();
      const process = h.app.vault.process.bind(h.app.vault);
      let calls = 0;
      if (failure === 'before-write' || failure === 'after-write')
        vi.spyOn(h.app.vault, 'process').mockImplementation(async (file, transform, options) => {
          calls++;
          if (calls === 2 && failure === 'before-write') throw new Error('rejected');
          const result = await process(file, transform, options);
          if (calls === 2 && failure === 'after-write') throw new Error('late rejection');
          return result;
        });
      if (failure === 'proof')
        vi.spyOn(h.index, 'installCommittedBatch').mockImplementationOnce(() => {
          throw new Error('proof rejected');
        });
      if (failure === 'completion') {
        const reserve = h.authority.reserveStructuralMutation.bind(h.authority);
        vi.spyOn(h.authority, 'reserveStructuralMutation').mockImplementation((...args) => {
          const owner = reserve(...args);
          return owner === undefined ? undefined : { ...owner, complete: () => false };
        });
      }
      const result = await h.service.execute(h.command);
      expect(result).toMatchObject({ type: 'io-error', contentState: 'unchanged' });
      expect(await h.read('source.md')).toBe('- [ ] Move\n  - [ ] Child ^child\n');
      expect(await h.read('target.md')).toBe('- [ ] Parent\n');
      await flushMicrotasks();
      expect(h.publications).toEqual([]);
    },
  );
  it('preserves an independent destination edit during compensation and reports unknown', async () => {
    const h = await harness();
    const process = h.app.vault.process.bind(h.app.vault);
    let calls = 0;
    vi.spyOn(h.app.vault, 'process').mockImplementation(async (file, transform, options) => {
      calls++;
      if (calls === 2) {
        await h.app.vault.modify(h.file('target.md'), '- [ ] Independent\n');
        throw new Error('source failed');
      }
      return process(file, transform, options);
    });
    expect(await h.service.execute(h.command)).toMatchObject({
      type: 'partial',
      operation: 'hierarchy',
      recovery: { state: 'unknown', sourcePath: 'source.md', destinationPath: 'target.md' },
    });
    expect(await h.read('target.md')).toBe('- [ ] Independent\n');
    expect(await h.read('source.md')).toBe('- [ ] Move\n  - [ ] Child ^child\n');
  });
});

it.each(['source.md', 'target.md'])(
  'rejects fresh text changes in %s before writing either note',
  async (path) => {
    const h = await harness();
    await h.app.vault.modify(h.file(path), '- [ ] External edit\n');
    const process = vi.spyOn(h.app.vault, 'process');
    expect(await h.service.execute(h.command)).toMatchObject({ type: 'conflict' });
    expect(process).not.toHaveBeenCalled();
    expect(await h.read(path)).toBe('- [ ] External edit\n');
  },
);
it('preserves source edits after reservation while compensating the destination', async () => {
  const h = await harness();
  const process = h.app.vault.process.bind(h.app.vault);
  let calls = 0;
  vi.spyOn(h.app.vault, 'process').mockImplementation(async (file, transform, options) => {
    if (++calls === 2) await h.app.vault.modify(file, '- [ ] External source edit\n');
    return process(file, transform, options);
  });
  expect(await h.service.execute(h.command)).toMatchObject({
    type: 'partial',
    recovery: { state: 'unknown' },
  });
  expect(await h.read('source.md')).toBe('- [ ] External source edit\n');
  expect(await h.read('target.md')).toBe('- [ ] Parent\n');
});
it.each(['replaced', 'renamed'] as const)(
  'rejects a %s destination file identity',
  async (fault) => {
    const h = await harness();
    const process = h.app.vault.process.bind(h.app.vault);
    let calls = 0;
    vi.spyOn(h.app.vault, 'process').mockImplementation(async (file, transform, options) => {
      if (++calls === 1) {
        if (fault === 'replaced') {
          await h.app.fileManager.trashFile(file);
          await h.app.vault.create('target.md', '- [ ] Replacement\n');
        } else await h.app.vault.rename(file, 'renamed.md');
      }
      return process(file, transform, options);
    });
    expect(await h.service.execute(h.command)).toMatchObject({
      type: 'partial',
      recovery: { state: 'unknown' },
    });
    expect(await h.read('source.md')).toBe('- [ ] Move\n  - [ ] Child ^child\n');
    if (fault === 'replaced') expect(await h.read('target.md')).toBe('- [ ] Replacement\n');
  },
);
it('does not publish candidate snapshots when committed parsing fails', async () => {
  const h = await harness();
  const parse = h.index.snapshotsFromContent.bind(h.index);
  let calls = 0;
  vi.spyOn(h.index, 'snapshotsFromContent').mockImplementation((path, content) => {
    if (++calls > 2) return [];
    return parse(path, content);
  });
  expect(await h.service.execute(h.command)).toMatchObject({
    type: 'io-error',
    contentState: 'unchanged',
  });
  await flushMicrotasks();
  expect(h.publications).toEqual([]);
});
it('reports unknown when readback cannot prove restoration', async () => {
  const h = await harness();
  const process = h.app.vault.process.bind(h.app.vault);
  let calls = 0;
  vi.spyOn(h.app.vault, 'process').mockImplementation(async (file, transform, options) => {
    const value = await process(file, transform, options);
    if (++calls === 2)
      vi.spyOn(h.app.vault, 'read').mockRejectedValue(new Error('readback failed'));
    return value;
  });
  expect(await h.service.execute(h.command)).toMatchObject({
    type: 'partial',
    recovery: { state: 'unknown' },
  });
  await flushMicrotasks();
  expect(h.publications).toEqual([]);
});
it('preserves duplicate-root identity when the other root inherits the removed line', async () => {
  const h = await harness({
    'source.md': '- [ ] Same\n- [ ] Same\n',
    'target.md': '- [ ] Parent\n',
  });
  const surviving = expectDefined(h.index.list({ filePath: 'source.md' })[1]);
  expect(await h.service.execute(h.command)).toMatchObject({ type: 'ok' });
  expect(await h.read('source.md')).toBe('- [ ] Same\n');
  const survivorResolution = h.index.resolve(surviving.ref);
  expect(survivorResolution).toMatchObject({
    type: 'rebased',
    current: { ref: { filePath: 'source.md', line: 0 } },
  });
  expect(h.index.resolve(h.source.ref).type).not.toBe('exact');
  expect(h.index.resolve(h.source.ref).type).not.toBe('rebased');
});
it('reduces the root population for a same-note root-to-child transfer', async () => {
  const h = await harness({
    'source.md': '- [ ] Move\n- [ ] Parent\n',
    'target.md': '- [ ] Other\n',
  });
  const parent = expectDefined(h.index.list({ filePath: 'source.md' })[1]);
  const process = vi.spyOn(h.app.vault, 'process');
  expect(
    await h.service.execute({
      type: 'reparent-task',
      source: { type: 'task', ref: h.source.ref },
      parent: { type: 'task', ref: parent.ref },
    }),
  ).toMatchObject({ type: 'ok' });
  expect(await h.read('source.md')).toBe('- [ ] Parent\n    - [ ] Move\n');
  expect(process).toHaveBeenCalledTimes(1);
});

it('preserves moved comments/time metadata and leaves outside-range inbound links unchanged', async () => {
  const source =
    '- [ ] Move 🆔 move ^move\n  - > [[#^child| kid ]] [[#^stays]]\n  - [ ] Child ^child\n  - 2026-10-03T10:00:00+00:00 note\n  - 2026-10-03T10:00:00+00:00 → 2026-10-03T11:00:00+00:00\n- [ ] Stays [[source#^move]] ^stays\n';
  const target = '- [ ] Parent [[source#^move]]\n';
  const h = await harness({ 'source.md': source, 'target.md': target });
  vi.spyOn(h.app.metadataCache, 'fileToLinktext').mockImplementation((file) =>
    file.path.replace(/\.md$/u, ''),
  );
  expect(await h.service.execute(h.command)).toMatchObject({
    type: 'ok',
    outcome: { type: 'hierarchy', moved: { target: { type: 'subtask' } } },
  });
  expect(await h.read('source.md')).toBe('- [ ] Stays [[source#^move]] ^stays\n');
  expect(await h.read('target.md')).toBe(
    '- [ ] Parent [[source#^move]]\n    - [ ] Move 🆔 move ^move\n      - > [[target#^child| kid ]] [[source#^stays]]\n      - [ ] Child ^child\n      - 2026-10-03T10:00:00+00:00 note\n      - 2026-10-03T10:00:00+00:00 → 2026-10-03T11:00:00+00:00\n',
  );
  const moved = expectDefined(
    expectDefined(h.index.list({ filePath: 'target.md' })[0]).subtasks[0],
  );
  expect(moved.comments).toHaveLength(1);
  expect(moved.timeEntries).toHaveLength(1);
});
it('supports an absent diagnostic callback and rejects an extra promotion parent precondition', async () => {
  const h = await harness();
  const target = { type: 'subtask' as const, ref: expectDefined(h.source.subtasks[0]).ref };
  const request = {
    command: { type: 'promote-subtask' as const, subtask: target.ref },
    source: { baseRoot: h.source, baseTarget: target, reconciliation: { observed: h.source } },
  };
  const invalid = await h.repository.hierarchy({
    ...request,
    parent: {
      baseRoot: h.parent,
      baseTarget: { type: 'task', ref: h.parent.ref },
      reconciliation: { observed: h.parent },
    },
  });
  expect(invalid).toMatchObject({ type: 'invalid' });
  expect(await h.repository.hierarchy(request)).toMatchObject({ type: 'committed' });
});

it('returns a same-parent repository no-op without Vault.process or new authority', async () => {
  const h = await harness();
  const child = expectDefined(h.source.subtasks[0]);
  const process = vi.spyOn(h.app.vault, 'process');
  expect(
    await h.repository.hierarchy({
      command: {
        type: 'reparent-task',
        source: { type: 'subtask', ref: child.ref },
        parent: { type: 'task', ref: h.source.ref },
      },
      source: {
        baseRoot: h.source,
        baseTarget: { type: 'subtask', ref: child.ref },
        reconciliation: { observed: h.source },
      },
      parent: {
        baseRoot: h.source,
        baseTarget: { type: 'task', ref: h.source.ref },
        reconciliation: { observed: h.source },
      },
    }),
  ).toMatchObject({
    type: 'committed',
    changed: false,
    outcome: { moved: { target: { ref: child.ref } } },
  });
  expect(process).not.toHaveBeenCalled();
  expect(h.index.resolve(h.source.ref)).toMatchObject({ type: 'exact' });
});

it('rejects an invalid population inside the real batch proof before publishing any candidate', async () => {
  const h = await harness();
  const install = h.index.installCommittedBatch.bind(h.index);
  vi.spyOn(h.index, 'installCommittedBatch').mockImplementationOnce((contents, prove) =>
    install(contents, () => {
      prove([]);
    }),
  );
  const process = vi.spyOn(h.app.vault, 'process');
  expect(await h.service.execute(h.command)).toMatchObject({
    type: 'io-error',
    contentState: 'unchanged',
  });
  expect(process).toHaveBeenCalledTimes(4);
  await flushMicrotasks();
  expect(h.publications).toEqual([]);
  expect(await h.read('source.md')).toBe('- [ ] Move\n  - [ ] Child ^child\n');
  expect(await h.read('target.md')).toBe('- [ ] Parent\n');
});

it('transfers recognized legacy time and oversize duration without creation normalization', async () => {
  const h = await harness({
    'source.md': '- [ ] Move ⏰ 23:00 ⏱️ 99h\n',
    'target.md': '- [ ] Parent\n',
  });
  expect(h.source.planning).toMatchObject({ time: '23:00', duration: 5940 });
  expect(await h.service.execute(h.command)).toMatchObject({ type: 'ok' });
  expect(await h.read('target.md')).toBe('- [ ] Parent\n    - [ ] Move ⏰ 23:00 ⏱️ 99h\n');
});
