import { describe, expect, it, vi } from 'vitest';
import { TaskApplicationService } from '../../src/tasks/application/TaskApplicationService';
import { TaskHierarchyService } from '../../src/tasks/application/TaskHierarchyService';
import type { TaskRepositoryResult } from '../../src/tasks/application/TaskRepository';
import { clockFrom } from '../../src/tasks/domain/clock';
import type { TaskCommandResult } from '../../src/tasks/domain/commands';
import { TaskBlockEditor } from '../../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { TaskLocator } from '../../src/tasks/infrastructure/markdown/TaskLocator';
import { TaskMarkdownCodec } from '../../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { canonicalStatusCatalog, expectDefined } from '../helpers';
import { InMemoryTaskRepository } from '../support/InMemoryTaskRepository';
import { hierarchyHarness } from '../support/taskHierarchyHarness';

describe('hierarchy application commands', () => {
  it('returns unchanged for the existing parent without calling any repository writer', async () => {
    const h = await hierarchyHarness();
    const hierarchy = vi.spyOn(h.repository, 'hierarchy');
    const process = vi.spyOn(h.app.vault, 'process');
    const result = await h.service.execute({
      type: 'reparent-task',
      source: { type: 'subtask', ref: expectDefined(h.source.subtasks[0]).ref },
      parent: { type: 'task', ref: h.source.ref },
    });
    expect(result).toMatchObject({ type: 'ok', changed: false });
    expect(hierarchy).not.toHaveBeenCalled();
    expect(process).not.toHaveBeenCalled();
  });
  it('rejects self and cycles before any write', async () => {
    const h = await hierarchyHarness();
    const process = vi.spyOn(h.app.vault, 'process');
    for (const parent of [
      { type: 'task' as const, ref: h.source.ref },
      { type: 'subtask' as const, ref: expectDefined(h.source.subtasks[0]).ref },
    ]) {
      expect(
        await h.service.execute({
          type: 'reparent-task',
          source: { type: 'task', ref: h.source.ref },
          parent,
        }),
      ).toMatchObject({ type: 'invalid' });
    }
    expect(process).not.toHaveBeenCalled();
  });
  it.each(['source.md', 'target.md'])('rejects a stale indexed endpoint in %s', async (path) => {
    const h = await hierarchyHarness();
    h.index.installCommittedContent(path, '- [ ] Changed\n');
    const hierarchy = vi.spyOn(h.repository, 'hierarchy');
    const result = await h.service.execute(h.command);
    expect(result.type).not.toBe('ok');
    expect(hierarchy).not.toHaveBeenCalled();
  });
  it('reports diagnostics for the exact failed phase and path, without retrying a destructive write', async () => {
    const h = await hierarchyHarness();
    const diagnostics = vi.fn();
    const service = new TaskHierarchyService(h.index, h.repository, diagnostics);
    const process = h.app.vault.process.bind(h.app.vault);
    let sourceCalls = 0;
    vi.spyOn(h.app.vault, 'process').mockImplementation(async (file, transform, options) => {
      if (file.path === 'source.md' && ++sourceCalls === 1) throw new Error('stop');
      return process(file, transform, options);
    });
    const result = await service.execute(h.command);
    expect(result).toMatchObject({ type: 'io-error', contentState: 'unchanged' });
    expect(diagnostics).toHaveBeenCalledWith({
      operation: 'reparent-task',
      phase: 'hierarchy-source-write',
      path: 'source.md',
      cause: 'io-error',
    });
    expect(sourceCalls).toBe(2); // one forward attempt plus exact restoration, never another forward attempt
  });
  it('keeps compensation safe if the diagnostic callback throws', async () => {
    const h = await hierarchyHarness();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const service = new TaskHierarchyService(h.index, h.repository, () => {
      throw new Error('broken diagnostics');
    });
    vi.spyOn(h.app.vault, 'process').mockRejectedValueOnce(new Error('first write failed'));
    expect(await service.execute(h.command)).toMatchObject({
      type: 'io-error',
      contentState: 'unchanged',
    });
    expect(await h.read('source.md')).toBe('- [ ] Move\n  - [ ] Child ^child\n');
    expect(await h.read('target.md')).toBe('- [ ] Parent\n');
    error.mockRestore();
  });
  it('supports the in-memory repository port with the same occurrence outcome', async () => {
    const files = { 'source.md': '- [ ] Move\n', 'target.md': '- [ ] Parent\n' };
    const h = await hierarchyHarness(files);
    const catalog = canonicalStatusCatalog();
    const repository = new InMemoryTaskRepository({
      files,
      codec: new TaskMarkdownCodec(catalog),
      editor: new TaskBlockEditor(() => '    '),
      locator: new TaskLocator(h.authority),
      refAuthority: h.authority,
      snapshotState: h.index,
      snapshotsFromContent: (path, content) => h.index.snapshotsFromContent(path, content),
    });
    const service = new TaskApplicationService(
      h.index,
      repository,
      catalog,
      clockFrom(Date.UTC(2026, 9, 3), 0),
    );
    const result: TaskCommandResult = await service.execute(h.command);
    expect(result).toMatchObject({
      type: 'ok',
      outcome: { type: 'hierarchy', moved: { target: { type: 'subtask' } } },
    });
    expect(repository.content('source.md')).toBe('');
    expect(repository.content('target.md')).toBe('- [ ] Parent\n    - [ ] Move\n');
  });
});

it('keeps defensive strict rejection out of hierarchy command results', async () => {
  const h = await hierarchyHarness();
  vi.spyOn(h.repository, 'hierarchy').mockResolvedValue({
    type: 'strict-rejected',
    reason: 'unsupported-precondition',
  });
  expect(await h.service.execute(h.command)).toEqual({
    type: 'invalid',
    issues: [{ code: 'invalid-target', field: 'target' }],
  });
  h.index.destroy();
});

it('prepares exact cross-note hierarchy without reserving authority, then commits the reviewed candidates once', async () => {
  const h = await hierarchyHarness();
  const beforeSource = await h.read('source.md');
  const beforeTarget = await h.read('target.md');
  const reserve = vi.spyOn(h.authority, 'reserveStructuralMutation');
  const prepared = await h.service.prepareHierarchy(h.command);
  expect(prepared.type).toBe('ready');
  if (prepared.type !== 'ready') throw new Error('Expected preparation');
  expect(reserve).not.toHaveBeenCalled();
  expect(await h.read('source.md')).toBe(beforeSource);
  expect(await h.read('target.md')).toBe(beforeTarget);
  expect(prepared.subjectBefore.type).toBe('task');
  expect(prepared.subjectAfter.type).toBe('subtask');
  expect(prepared.after.subtasks[0]?.title).toBe('Move');
  expect(prepared.after.subtasks[0]?.subtasks[0]?.title).toBe('Child');
  expect(prepared.continuations).toHaveLength(3);
  const result = await prepared.commit();
  expect(result).toMatchObject({ type: 'ok', outcome: { type: 'hierarchy' } });
  expect(await prepared.commit()).toEqual(result);
  expect((await h.read('target.md')).match(/\[ \] Move/g)).toHaveLength(1);
  h.index.destroy();
});

it.each(['source.md', 'target.md'])(
  'a prepared hierarchy rejects a later %s edit without moving any content',
  async (path) => {
    const h = await hierarchyHarness();
    const prepared = await h.service.prepareHierarchy(h.command);
    if (prepared.type !== 'ready') throw new Error('Expected preparation');
    const file = expectDefined(h.app.vault.getFileByPath(path) ?? undefined);
    await h.app.vault.modify(file, `${await h.read(path)}External line\n`);
    const source = await h.read('source.md'),
      target = await h.read('target.md');
    expect((await prepared.commit()).type).not.toBe('ok');
    expect(await h.read('source.md')).toBe(source);
    expect(await h.read('target.md')).toBe(target);
    h.index.destroy();
  },
);

it.each(['strict-rejected', 'rebased', 'uncertain'] as const)(
  'preserves the meaning of %s at both prepared-hierarchy repository boundaries',
  async (kind) => {
    const h = await hierarchyHarness();
    try {
      const source = await h.read('source.md');
      const target = await h.read('target.md');
      const process = vi.spyOn(h.app.vault, 'process');
      let result: TaskRepositoryResult;
      let expected: TaskCommandResult;
      if (kind === 'strict-rejected') {
        result = { type: kind, reason: 'unsupported-precondition' };
        expected = { type: 'invalid', issues: [{ code: 'invalid-target', field: 'target' }] };
      } else if (kind === 'rebased') {
        result = {
          type: kind,
          previous: h.source,
          current: h.source,
          evidence: 'byte-identical-relocation',
        };
        expected = { type: 'conflict', current: h.source };
      } else {
        result = { type: kind, target: { type: 'task', ref: h.source.ref } };
        expected = { type: 'not-found', target: { type: 'task', ref: h.source.ref } };
      }
      const prepare = h.repository.prepareHierarchy.bind(h.repository);
      const preparation = vi.spyOn(h.repository, 'prepareHierarchy');
      preparation.mockResolvedValueOnce({ type: 'invalid', result });
      expect(await h.service.prepareHierarchy(h.command)).toEqual({
        type: 'invalid',
        result: expected,
      });
      const commit = vi.fn(async () => result);
      preparation.mockImplementationOnce(async (...args) => {
        const prepared = await prepare(...args);
        if (prepared.type !== 'ready') throw new Error('Missing hierarchy preparation');
        return { ...prepared, commit };
      });
      const prepared = await h.service.prepareHierarchy(h.command);
      if (prepared.type !== 'ready') throw new Error('Missing hierarchy preparation');
      expect(await prepared.commit()).toEqual(expected);
      expect(commit).toHaveBeenCalledOnce();
      expect(preparation).toHaveBeenCalledTimes(2);
      expect(process).not.toHaveBeenCalled();
      expect(await h.read('source.md')).toBe(source);
      expect(await h.read('target.md')).toBe(target);
    } finally {
      h.index.destroy();
    }
  },
);

it.each(['source.md', 'target.md'])(
  'refuses to prepare a stale indexed hierarchy endpoint in %s',
  async (path) => {
    const h = await hierarchyHarness();
    try {
      const source = await h.read('source.md');
      const target = await h.read('target.md');
      h.index.installCommittedContent(path, '- [ ] Changed\n');
      const prepare = vi.spyOn(h.repository, 'prepareHierarchy');
      const process = vi.spyOn(h.app.vault, 'process');
      expect(await h.service.prepareHierarchy(h.command)).toMatchObject({
        type: 'invalid',
        result: { type: 'conflict', current: { title: 'Changed' } },
      });
      expect(prepare).not.toHaveBeenCalled();
      expect(process).not.toHaveBeenCalled();
      expect(await h.read('source.md')).toBe(source);
      expect(await h.read('target.md')).toBe(target);
    } finally {
      h.index.destroy();
    }
  },
);

it('refuses to prepare self or descendant cycles before acquiring repository work', async () => {
  const h = await hierarchyHarness();
  try {
    const source = await h.read('source.md');
    const target = await h.read('target.md');
    const prepare = vi.spyOn(h.repository, 'prepareHierarchy');
    const process = vi.spyOn(h.app.vault, 'process');
    for (const parent of [
      { type: 'task' as const, ref: h.source.ref },
      { type: 'subtask' as const, ref: expectDefined(h.source.subtasks[0]).ref },
    ]) {
      expect(
        await h.service.prepareHierarchy({
          type: 'reparent-task',
          source: { type: 'task', ref: h.source.ref },
          parent,
        }),
      ).toEqual({
        type: 'invalid',
        result: { type: 'invalid', issues: [{ code: 'invalid-target', field: 'hierarchy' }] },
      });
    }
    expect(prepare).not.toHaveBeenCalled();
    expect(process).not.toHaveBeenCalled();
    expect(await h.read('source.md')).toBe(source);
    expect(await h.read('target.md')).toBe(target);
  } finally {
    h.index.destroy();
  }
});

it('refuses unsupported hierarchy preparation without falling back to an immediate write', async () => {
  const h = await hierarchyHarness();
  try {
    const source = await h.read('source.md');
    const target = await h.read('target.md');
    Object.defineProperty(h.repository, 'prepareHierarchy', { value: undefined });
    const hierarchy = vi.spyOn(h.repository, 'hierarchy');
    const process = vi.spyOn(h.app.vault, 'process');
    expect(await h.service.prepareHierarchy(h.command)).toEqual({
      type: 'invalid',
      result: { type: 'invalid', issues: [{ code: 'invalid-target', field: 'hierarchy' }] },
    });
    expect(hierarchy).not.toHaveBeenCalled();
    expect(process).not.toHaveBeenCalled();
    expect(await h.read('source.md')).toBe(source);
    expect(await h.read('target.md')).toBe(target);
  } finally {
    h.index.destroy();
  }
});
