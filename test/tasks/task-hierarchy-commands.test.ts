import { describe, expect, it, vi } from 'vitest';
import { TaskApplicationService } from '../../src/tasks/application/TaskApplicationService';
import { TaskHierarchyService } from '../../src/tasks/application/TaskHierarchyService';
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
