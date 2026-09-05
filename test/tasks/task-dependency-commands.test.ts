import { TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskApplicationService } from '../../src/tasks/application/TaskApplicationService';
import {
  TaskDependencyService,
  nextTaskDependencyId,
  type TaskDependencyIdGenerator,
  type TaskDiagnosticSink,
} from '../../src/tasks/application/TaskDependencyService';
import type { TaskCommand, TaskCommandResult } from '../../src/tasks/domain/commands';
import type { TaskNodeSnapshot } from '../../src/tasks/domain/taskDependencies';
import { localDate } from '../../src/tasks/domain/validation';
import { TaskIndex } from '../../src/tasks/infrastructure/TaskIndex';
import { TaskRefAuthority } from '../../src/tasks/infrastructure/TaskRefAuthority';
import { TaskBlockEditor } from '../../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { TaskLocator } from '../../src/tasks/infrastructure/markdown/TaskLocator';
import { TaskMarkdownCodec } from '../../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { ObsidianTaskRepository } from '../../src/tasks/infrastructure/obsidian/ObsidianTaskRepository';
import { canonicalStatusCatalog, createAppWithFiles, expectDefined } from '../helpers';

const indexes: TaskIndex[] = [];
afterEach(() => {
  for (const index of indexes.splice(0)) index.destroy();
});

async function harness(
  files: Record<string, string>,
  generateId: TaskDependencyIdGenerator = nextTaskDependencyId,
) {
  const app = await createAppWithFiles(files);
  const statuses = canonicalStatusCatalog();
  const authority = new TaskRefAuthority('dependency-commands');
  const index = new TaskIndex(app, {
    statusCatalog: statuses,
    dailyNoteFormat: 'YYYY-MM-DD',
    refAuthority: authority,
  });
  indexes.push(index);
  await index.initialize();
  const repository = new ObsidianTaskRepository(app, {
    codec: new TaskMarkdownCodec(statuses),
    editor: new TaskBlockEditor(),
    locator: new TaskLocator(authority),
    snapshotsFromContent: (path, content) => index.snapshotsFromContent(path, content),
    refAuthority: authority,
    snapshotState: index,
  });
  const diagnostics = vi.fn<TaskDiagnosticSink>();
  const dependencyService = new TaskDependencyService(index, repository, generateId, diagnostics);
  const application = new TaskApplicationService(
    index,
    repository,
    statuses,
    {
      today: () => localDate('2026-09-05'),
    },
    undefined,
    undefined,
    dependencyService,
    diagnostics,
  );
  const node = (title: string): TaskNodeSnapshot =>
    expectDefined(index.listNodes().find((candidate) => candidate.node.title === title));
  const read = async (path = 'tasks.md'): Promise<string> => {
    const file = app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error('Missing fixture file');
    return await app.vault.read(file);
  };
  return {
    app,
    index,
    repository,
    application,
    node,
    read,
    statuses,
    diagnostics,
    dependencyService,
  };
}

function dependencyOutcome(result: TaskCommandResult) {
  if (result.type !== 'ok' || result.outcome.type !== 'dependency')
    throw new Error('Expected dependency outcome');
  return result.outcome;
}

describe('public dependency commands', () => {
  it('accepts an exact structural ref among identical siblings', async () => {
    const h = await harness({
      'tasks.md': '\n- [ ] Root\n  - [ ] Same\n  - [ ] Same\n- [ ] Dependent\n',
    });
    const siblings = h.index.listNodes().filter(({ node }) => node.title === 'Same');
    const result = await h.application.execute({
      type: 'add-dependency',
      blocker: expectDefined(siblings[1]).target,
      dependent: h.node('Dependent').target,
    });
    expect(result.type).toBe('ok');
    const after = h.index.listNodes().filter(({ node }) => node.title === 'Same');
    expect(after[0]?.node.dependencyId).toBeUndefined();
    expect(after[1]?.node.dependencyId).toMatch(/^[a-z0-9]{8}$/u);
  });

  it('does not choose an identical sibling for an obsolete structural ref', async () => {
    const h = await harness({
      'tasks.md': '\n- [ ] Root\n  - [ ] Same\n  - [ ] Same\n- [ ] Dependent\n',
    });
    const siblings = h.index.listNodes().filter(({ node }) => node.title === 'Same');
    const stale = expectDefined(siblings[1]);
    await h.repository.edit({
      type: 'set-description',
      target: { type: 'task', ref: stale.root.ref },
      text: 'External change',
    });
    const batch = vi.spyOn(h.repository, 'editBatch');
    expect(
      (
        await h.application.execute({
          type: 'add-dependency',
          blocker: stale.target,
          dependent: h.node('Dependent').target,
        })
      ).type,
    ).toBe('conflict');
    expect(batch).not.toHaveBeenCalled();
    expect(
      h.index
        .listNodes()
        .filter(({ node }) => node.title === 'Same')
        .map(({ node }) => node.dependencyId),
    ).toEqual([undefined, undefined]);
  });

  it('rechecks a cycle introduced by a repository rebase before a second batch', async () => {
    const h = await harness({
      'tasks.md':
        '\n- [ ] Blocker 🆔 blocker\n- [ ] Middle 🆔 middle ⛔ dependent\n- [ ] Dependent 🆔 dependent\n',
    });
    const previous = h.node('Blocker').root;
    const current = expectDefined(
      h.index.snapshotsFromContent('tasks.md', '\n- [ ] Blocker 🆔 blocker ⛔ middle\n')[0],
    );
    const batch = vi.spyOn(h.repository, 'editBatch').mockResolvedValueOnce({
      type: 'rebased',
      previous,
      current,
      evidence: 'authority-transition',
    });
    const result = await h.application.execute({
      type: 'add-dependency',
      blocker: h.node('Blocker').target,
      dependent: h.node('Dependent').target,
    });
    expect(result.type).toBe('invalid');
    expect(batch).toHaveBeenCalledTimes(1);
    expect(h.node('Dependent').node.dependsOn).toEqual([]);
  });

  it('rejects stale and ambiguous command roots without a repository write', async () => {
    const h = await harness({ 'tasks.md': '\n- [ ] Blocker\n- [ ] Dependent\n' });
    const blocker = h.node('Blocker');
    const dependent = h.node('Dependent');
    const batch = vi.spyOn(h.repository, 'editBatch');
    expect(
      (
        await h.application.execute({
          type: 'add-dependency',
          blocker: { type: 'task', ref: { ...blocker.root.ref, revision: 'unknown' } },
          dependent: dependent.target,
        })
      ).type,
    ).toBe('not-found');
    vi.spyOn(h.index, 'resolve').mockReturnValueOnce({
      type: 'ambiguous',
      candidates: [blocker, dependent].map(({ root, target }) => ({ root, target })),
    });
    expect(
      (
        await h.application.execute({
          type: 'add-dependency',
          blocker: blocker.target,
          dependent: dependent.target,
        })
      ).type,
    ).toBe('ambiguous');
    expect(batch).not.toHaveBeenCalled();
  });

  it('rejects a stale subtask whose original block no longer matches', async () => {
    const h = await harness({ 'tasks.md': '\n- [ ] Root\n  - [ ] Blocker\n- [ ] Dependent\n' });
    const blocker = h.node('Blocker').target;
    if (blocker.type !== 'subtask') throw new Error('Expected subtask');
    const batch = vi.spyOn(h.repository, 'editBatch');
    expect(
      (
        await h.application.execute({
          type: 'add-dependency',
          blocker: { type: 'subtask', ref: { ...blocker.ref, originalBlock: '  - [ ] Stale' } },
          dependent: h.node('Dependent').target,
        })
      ).type,
    ).toBe('conflict');
    expect(batch).not.toHaveBeenCalled();
  });

  it('restores ambiguous-ID removal without selecting a blocker', async () => {
    const h = await harness({
      'tasks.md':
        '\n- [ ] One 🆔 duplicate\n- [ ] Two 🆔 duplicate\n- [ ] Dependent ⛔ duplicate, other, duplicate\n',
    });
    const removed = dependencyOutcome(
      await h.application.execute({
        type: 'remove-dependency',
        dependent: h.node('Dependent').target,
        dependencyId: 'duplicate',
      }),
    );
    expect(removed.blocker).toBeUndefined();
    const restored = dependencyOutcome(
      await h.application.execute({
        type: 'restore-dependency',
        dependent: removed.dependent.target,
        recovery: expectDefined(removed.removalRecovery),
      }),
    );
    expect(restored.blocker).toBeUndefined();
    expect(h.node('Dependent').node.dependsOn).toEqual(['duplicate', 'other', 'duplicate']);
  });

  it('refuses recovery after a rebase changes the remaining IDs', async () => {
    const h = await harness({ 'tasks.md': '- [ ] Dependent ⛔ other\n' });
    const previous = h.node('Dependent').root;
    const current = expectDefined(
      h.index.snapshotsFromContent('tasks.md', '- [ ] Dependent ⛔ changed\n')[0],
    );
    const edit = vi.spyOn(h.repository, 'edit').mockResolvedValueOnce({
      type: 'rebased',
      previous,
      current,
      evidence: 'authority-transition',
    });
    expect(
      (
        await h.application.execute({
          type: 'restore-dependency',
          dependent: h.node('Dependent').target,
          recovery: {
            dependencyId: 'removed',
            beforeIds: ['other', 'removed'],
            afterIds: ['other'],
          },
        })
      ).type,
    ).toBe('conflict');
    expect(edit).toHaveBeenCalledTimes(1);
  });

  it('retries generator collisions and never takes an already declared unresolved ID', async () => {
    const generate = vi
      .fn<TaskDependencyIdGenerator>()
      .mockReturnValueOnce('aaaaaaaa')
      .mockReturnValueOnce('reserved')
      .mockReturnValueOnce('Bad-ID!')
      .mockReturnValue('fresh123');
    const h = await harness(
      { 'tasks.md': '\n- [ ] Existing 🆔 aaaaaaaa\n- [ ] Blocker\n- [ ] Dependent ⛔ reserved\n' },
      generate,
    );
    const result = await h.application.execute({
      type: 'add-dependency',
      blocker: h.node('Blocker').target,
      dependent: h.node('Dependent').target,
    });
    expect(result).toMatchObject({ type: 'ok', outcome: { dependencyId: 'fresh123' } });
    expect(h.node('Dependent').node.dependsOn).toEqual(['reserved', 'fresh123']);
    expect(generate).toHaveBeenCalledTimes(4);
    expect(generate.mock.calls[0]?.[0]).toEqual(new Set(['aaaaaaaa', 'reserved']));
  });

  it('preserves an allocated ID on second-file failure, emits one content-free diagnostic, and reuses it on retry', async () => {
    const h = await harness({
      'a.md': '- [ ] Secret blocker\n',
      'b.md': '- [ ] Private dependent\n',
    });
    const originalEdit = h.repository.edit.bind(h.repository);
    const failure = {
      type: 'io-error',
      cause: 'write-rejected',
      path: 'b.md',
      contentState: 'unchanged',
    } as const;
    let attempts = 0;
    vi.spyOn(h.repository, 'edit').mockImplementation(async (request) => {
      attempts += 1;
      return attempts === 2 ? failure : await originalEdit(request);
    });
    const blocker = h.node('Secret blocker').target;
    const dependent = h.node('Private dependent').target;
    const result = await h.application.execute({ type: 'add-dependency', blocker, dependent });
    expect(result).toBe(failure);
    const id = h.node('Secret blocker').node.dependencyId;
    expect(id).toMatch(/^[a-z0-9]{8}$/u);
    expect(await h.read('b.md')).toBe('- [ ] Private dependent\n');
    expect(h.diagnostics.mock.calls).toEqual([
      [{ operation: 'add-dependency', phase: 'cross-file-edge-write', cause: 'io-error' }],
    ]);
    const retry = await h.application.execute({ type: 'add-dependency', blocker, dependent });
    expect(retry).toMatchObject({ type: 'ok', outcome: { dependencyId: id } });
    expect(h.node('Private dependent').node.dependsOn).toEqual([id]);
    expect(attempts).toBe(3);
  });

  it('reports a thrown second-file failure once without logging the exception content', async () => {
    const h = await harness({ 'a.md': '- [ ] Blocker\n', 'b.md': '- [ ] Dependent\n' });
    const originalEdit = h.repository.edit.bind(h.repository);
    let attempts = 0;
    vi.spyOn(h.repository, 'edit').mockImplementation(async (request) => {
      if (++attempts === 2) throw new Error('Private Markdown and path');
      return await originalEdit(request);
    });
    expect(
      (
        await h.application.execute({
          type: 'add-dependency',
          blocker: h.node('Blocker').target,
          dependent: h.node('Dependent').target,
        })
      ).type,
    ).toBe('io-error');
    expect(h.diagnostics.mock.calls).toEqual([
      [{ operation: 'add-dependency', phase: 'cross-file-edge-write', cause: 'repository-error' }],
    ]);
    expect(h.node('Blocker').node.dependencyId).toBeDefined();
    expect(h.node('Dependent').node.dependsOn).toEqual([]);
  });

  it('reports an unexpected error before writing through one safe diagnostic', async () => {
    const h = await harness({ 'tasks.md': '\n- [ ] Blocker\n- [ ] Dependent\n' }, () => {
      throw new Error('private title');
    });
    expect(
      (
        await h.application.execute({
          type: 'add-dependency',
          blocker: h.node('Blocker').target,
          dependent: h.node('Dependent').target,
        })
      ).type,
    ).toBe('io-error');
    expect(h.diagnostics.mock.calls).toEqual([
      [{ operation: 'add-dependency', phase: 'unexpected', cause: 'repository-error' }],
    ]);
    expect(await h.read()).toBe('\n- [ ] Blocker\n- [ ] Dependent\n');
  });

  it('re-resolves a blocker changed after its cross-file ID allocation', async () => {
    const h = await harness({ 'a.md': '- [ ] Blocker\n', 'b.md': '- [ ] Dependent\n' });
    const originalEdit = h.repository.edit.bind(h.repository);
    let attempts = 0;
    vi.spyOn(h.repository, 'edit').mockImplementation(async (request) => {
      const result = await originalEdit(request);
      if (++attempts === 1) {
        await originalEdit({
          type: 'set-dependency-id',
          target: h.node('Blocker').target,
          id: 'external',
        });
      }
      return result;
    });
    const result = await h.application.execute({
      type: 'add-dependency',
      blocker: h.node('Blocker').target,
      dependent: h.node('Dependent').target,
    });
    expect(result.type).toBe('conflict');
    expect(h.node('Blocker').node.dependencyId).toBe('external');
    expect(h.node('Dependent').node.dependsOn).toEqual([]);
    expect(attempts).toBe(1);
    expect(h.diagnostics).toHaveBeenCalledTimes(1);
  });

  it('keeps both lines unchanged when the same-file processor rejects', async () => {
    const source = '\n- [ ] Blocker\n- [ ] Dependent\n';
    const h = await harness({ 'tasks.md': source });
    vi.spyOn(h.app.vault, 'process').mockRejectedValueOnce(new Error('disk write failed'));
    expect(
      (
        await h.application.execute({
          type: 'add-dependency',
          blocker: h.node('Blocker').target,
          dependent: h.node('Dependent').target,
        })
      ).type,
    ).toBe('io-error');
    expect(await h.read()).toBe(source);
    expect(h.node('Blocker').node.dependencyId).toBeUndefined();
    expect(h.node('Dependent').node.dependsOn).toEqual([]);
  });
  it('allocates an ID and commits a same-file pair as one transition with fresh outcomes', async () => {
    const h = await harness({ 'tasks.md': '\n- [ ] Blocker\n- [ ] Dependent\n' });
    const blocker = h.node('Blocker');
    const dependent = h.node('Dependent');
    const process = vi.spyOn(h.app.vault, 'process');
    const result = await h.application.execute({
      type: 'add-dependency',
      blocker: blocker.target,
      dependent: dependent.target,
    });
    expect(result).toMatchObject({
      type: 'ok',
      changed: true,
      outcome: { type: 'dependency', change: 'added' },
    });
    const outcome = dependencyOutcome(result);
    expect(outcome.dependencyId).toMatch(/^[a-z0-9]{8}$/u);
    expect(await h.read()).toBe(
      `\n- [ ] Blocker 🆔 ${outcome.dependencyId}\n- [ ] Dependent ⛔ ${outcome.dependencyId}\n`,
    );
    expect(process).toHaveBeenCalledTimes(1);
    expect(outcome.dependent.target).toEqual(h.node('Dependent').target);
    expect(outcome.blocker?.target).toEqual(h.node('Blocker').target);
    expect(outcome.dependent.root.ref).not.toEqual(dependent.root.ref);
    expect(outcome.blocker?.root.ref).not.toEqual(blocker.root.ref);
  });

  it('links nested subtasks through the same root aggregate', async () => {
    const h = await harness({
      'tasks.md': '\n- [ ] Root\n  - [ ] Parent\n    - [ ] Blocker\n  - [ ] Dependent\n',
    });
    const result = await h.application.execute({
      type: 'add-dependency',
      blocker: h.node('Blocker').target,
      dependent: h.node('Dependent').target,
    });
    expect(result.type).toBe('ok');
    const outcome = dependencyOutcome(result);
    expect(outcome.blocker?.target).toEqual(h.node('Blocker').target);
    expect(outcome.dependent.target).toEqual(h.node('Dependent').target);
    expect(h.node('Dependent').node.dependsOn).toEqual([outcome.dependencyId]);
    expect(h.index.dependencies(h.node('Blocker').target).activeBlocksCount).toBe(1);
  });

  it('returns a fresh nested blocker from a different same-file root after ID allocation', async () => {
    const h = await harness({
      'tasks.md': '\n- [ ] Root\n  - [ ] Parent\n    - [ ] Blocker\n- [ ] Dependent\n',
    });
    const before = h.node('Blocker');
    const outcome = dependencyOutcome(
      await h.application.execute({
        type: 'add-dependency',
        blocker: before.target,
        dependent: h.node('Dependent').target,
      }),
    );
    expect(outcome.blocker?.target).toEqual(h.node('Blocker').target);
    expect(outcome.blocker?.root.ref).not.toEqual(before.root.ref);
    expect(outcome.dependent.target).toEqual(h.node('Dependent').target);
  });

  it.each(['missing', 'ambiguous', 'different-endpoint'] as const)(
    'omits a %s blocker from the post-write outcome without retaining a stale ref',
    async (condition) => {
      const h = await harness({
        'tasks.md': '\n- [ ] Root\n  - [ ] Blocker\n  - [ ] Other\n- [ ] Dependent\n',
      });
      const originalBatch = h.repository.editBatch.bind(h.repository);
      vi.spyOn(h.repository, 'editBatch').mockImplementation(async (request) => {
        const committed = await originalBatch(request);
        const id = expectDefined(h.node('Blocker').node.dependencyId);
        if (condition !== 'ambiguous')
          await h.repository.edit({
            type: 'set-dependency-id',
            target: h.node('Blocker').target,
            id: 'external',
          });
        if (condition !== 'missing')
          await h.repository.edit({
            type: 'set-dependency-id',
            target: h.node('Other').target,
            id,
          });
        return committed;
      });
      const outcome = dependencyOutcome(
        await h.application.execute({
          type: 'add-dependency',
          blocker: h.node('Blocker').target,
          dependent: h.node('Dependent').target,
        }),
      );
      expect(outcome.blocker).toBeUndefined();
      expect(outcome.dependent.target).toEqual(h.node('Dependent').target);
      expect(h.node('Dependent').node.dependsOn).toEqual([outcome.dependencyId]);
    },
  );

  it('uses an existing cross-file ID and writes only the dependent', async () => {
    const h = await harness({
      'a.md': '- [ ] Blocker 🆔 authored-ID\n',
      'b.md': '- [ ] Dependent\n',
    });
    const process = vi.spyOn(h.app.vault, 'process');
    const result = await h.application.execute({
      type: 'add-dependency',
      blocker: h.node('Blocker').target,
      dependent: h.node('Dependent').target,
    });
    expect(result).toMatchObject({ type: 'ok', outcome: { dependencyId: 'authored-ID' } });
    expect(await h.read('a.md')).toBe('- [ ] Blocker 🆔 authored-ID\n');
    expect(await h.read('b.md')).toBe('- [ ] Dependent ⛔ authored-ID\n');
    expect(process).toHaveBeenCalledTimes(1);
  });

  it('removes all raw-ID declarations and restores their exact order without a blocker', async () => {
    const h = await harness({ 'tasks.md': '- [ ] Dependent ⛔ missing, first, missing, last\n' });
    const removed = await h.application.execute({
      type: 'remove-dependency',
      dependent: h.node('Dependent').target,
      dependencyId: 'missing',
    });
    expect(removed.type).toBe('ok');
    const outcome = dependencyOutcome(removed);
    expect(outcome.blocker).toBeUndefined();
    expect(outcome.removalRecovery).toEqual({
      dependencyId: 'missing',
      beforeIds: ['missing', 'first', 'missing', 'last'],
      afterIds: ['first', 'last'],
    });
    expect(await h.read()).toBe('- [ ] Dependent ⛔ first, last\n');
    const restored = await h.application.execute({
      type: 'restore-dependency',
      dependent: outcome.dependent.target,
      recovery: expectDefined(outcome.removalRecovery),
    });
    expect(restored).toMatchObject({ type: 'ok', changed: true, outcome: { change: 'restored' } });
    expect(await h.read()).toBe('- [ ] Dependent ⛔ missing, first, missing, last\n');
  });

  it('returns a no-op recovery when the raw ID is absent', async () => {
    const h = await harness({ 'tasks.md': '- [ ] Dependent ⛔ other\n' });
    const result = await h.application.execute({
      type: 'remove-dependency',
      dependent: h.node('Dependent').target,
      dependencyId: 'absent',
    });
    expect(result).toMatchObject({
      type: 'ok',
      changed: false,
      outcome: { removalRecovery: { beforeIds: ['other'], afterIds: ['other'] } },
    });
    expect(await h.read()).toBe('- [ ] Dependent ⛔ other\n');
  });

  it('refuses stale recovery when the remaining sequence changed', async () => {
    const h = await harness({ 'tasks.md': '- [ ] Dependent ⛔ changed\n' });
    const process = vi.spyOn(h.app.vault, 'process');
    const result = await h.application.execute({
      type: 'restore-dependency',
      dependent: h.node('Dependent').target,
      recovery: { dependencyId: 'removed', beforeIds: ['removed', 'other'], afterIds: ['other'] },
    });
    expect(result.type).toBe('conflict');
    expect(process).not.toHaveBeenCalled();
    expect(await h.read()).toBe('- [ ] Dependent ⛔ changed\n');
  });

  it.each([
    ['self', '\n- [ ] Blocker\n- [ ] Dependent\n'],
    ['duplicate', '\n- [ ] Blocker 🆔 id\n- [ ] Dependent ⛔ id\n'],
    ['inverse', '\n- [ ] Blocker ⛔ dependent\n- [ ] Dependent 🆔 dependent\n'],
    [
      'cycle',
      '\n- [ ] Blocker ⛔ middle\n- [ ] Middle 🆔 middle ⛔ dependent\n- [ ] Dependent 🆔 dependent\n',
    ],
    ['ambiguous', '\n- [ ] Blocker 🆔 id\n- [ ] Duplicate 🆔 id\n- [ ] Dependent\n'],
  ])('revalidates %s edges without writing', async (reason, source) => {
    const h = await harness({ 'tasks.md': source });
    const process = vi.spyOn(h.app.vault, 'process');
    const result = await h.application.execute({
      type: 'add-dependency',
      blocker: h.node('Blocker').target,
      dependent: h.node(reason === 'self' ? 'Blocker' : 'Dependent').target,
    });
    expect(result.type).toBe(reason === 'ambiguous' ? 'ambiguous' : 'invalid');
    expect(process).not.toHaveBeenCalled();
    expect(await h.read()).toBe(source);
  });
});

describe('strict dependency completion', () => {
  it('prefers a newer proven index root over the service outcome cache before completion I/O', async () => {
    const h = await harness({ 'a.md': '- [ ] Blocker 🆔 id\n', 'tasks.md': '- [ ] Dependent\n' });
    const changed = await h.application.execute({
      type: 'set-description',
      target: h.node('Dependent').target,
      text: 'Description',
    });
    if (changed.type !== 'ok' || changed.outcome.type !== 'task')
      throw new Error('Expected task result');
    const cachedTarget = { type: 'task' as const, ref: changed.outcome.task.ref };
    await h.repository.edit({
      type: 'set-depends-on',
      target: h.node('Dependent').target,
      ids: ['id'],
    });
    const edit = vi.spyOn(h.repository, 'edit');
    expect(
      (await h.application.execute({ type: 'toggle-completion', target: cachedTarget })).type,
    ).toBe('blocked');
    expect(edit).not.toHaveBeenCalled();
  });

  it('reports an unexpected completion-query failure once without exposing its content', async () => {
    const h = await harness({ 'tasks.md': '- [ ] Dependent\n' });
    const target = h.node('Dependent').target;
    vi.spyOn(h.index, 'listNodes').mockImplementation(() => {
      throw new Error('private content');
    });
    expect((await h.application.execute({ type: 'toggle-completion', target })).type).toBe(
      'io-error',
    );
    expect(h.diagnostics.mock.calls).toEqual([
      [{ operation: 'toggle-completion', phase: 'unexpected', cause: 'repository-error' }],
    ]);
    expect(await h.read()).toBe('- [ ] Dependent\n');
  });

  it.each(['ordinary', 'recurring'])(
    'rechecks $0 subtask completion when a same-root blocker becomes active during retry',
    async (kind) => {
      const recurrence = kind === 'recurring' ? ' 🔁 every day 📅 2026-09-05' : '';
      const source = `- [ ] Root\n  - [x] Blocker 🆔 id\n  - [ ] Dependent${recurrence} ⛔ id\n`;
      const h = await harness({ 'tasks.md': source });
      const previous = h.node('Dependent').root;
      const current = expectDefined(
        h.index.snapshotsFromContent('tasks.md', source.replace('[x]', '[/]'))[0],
      );
      const edit =
        kind === 'recurring'
          ? vi.spyOn(h.repository, 'completeRecurrence')
          : vi.spyOn(h.repository, 'edit');
      edit.mockResolvedValueOnce({
        type: 'rebased',
        previous,
        current,
        evidence: 'authority-transition',
      });
      const result = await h.application.execute({
        type: 'toggle-completion',
        target: h.node('Dependent').target,
      });
      expect(result).toMatchObject({
        type: 'blocked',
        blockers: [
          { dependencyId: 'id', state: 'active', task: { node: { status: 'in-progress' } } },
        ],
      });
      expect(edit).toHaveBeenCalledTimes(1);
      expect(await h.read()).toBe(source);
    },
  );

  it('blocks an initially reconciled current root before any repository I/O', async () => {
    const h = await harness({ 'a.md': '- [ ] Blocker 🆔 id\n', 'tasks.md': '- [ ] Dependent\n' });
    const previous = h.node('Dependent').root;
    const current = expectDefined(
      h.index.snapshotsFromContent('tasks.md', '- [ ] Dependent ⛔ id\n')[0],
    );
    vi.spyOn(h.index, 'resolve').mockReturnValueOnce({
      type: 'rebased',
      previous,
      current,
      evidence: 'authority-transition',
      basis: { observed: current },
    });
    const edit = vi.spyOn(h.repository, 'edit');
    expect(
      (
        await h.application.execute({
          type: 'set-status',
          target: { type: 'task', ref: previous.ref },
          symbol: 'x',
        })
      ).type,
    ).toBe('blocked');
    expect(edit).not.toHaveBeenCalled();
  });

  it('uses custom done and cancelled symbols in the strict guard', async () => {
    const h = await harness({ 'tasks.md': '\n- [ ] Blocker 🆔 id\n- [ ] Dependent ⛔ id\n' });
    h.statuses.replace([
      ...h.statuses.all(),
      { id: 'custom-done', symbol: 'd', type: 'done', defaultForType: false },
      { id: 'custom-cancelled', symbol: 'c', type: 'cancelled', defaultForType: false },
    ]);
    const edit = vi.spyOn(h.repository, 'edit');
    for (const symbol of ['d', 'c'])
      expect(
        (
          await h.application.execute({
            type: 'set-status',
            target: h.node('Dependent').target,
            symbol,
          })
        ).type,
      ).toBe('blocked');
    expect(edit).not.toHaveBeenCalled();
  });

  it('reprojects live custom statuses consistently across root/path/node without changing indexed snapshots', async () => {
    const h = await harness({
      'tasks.md': '\n- [q] Root\n  - [q] Parent\n    - [q] Blocker 🆔 id\n- [ ] Dependent ⛔ id\n',
    });
    const before = h.node('Blocker');
    h.statuses.replace([
      ...h.statuses.all(),
      { id: 'custom', symbol: 'q', type: 'done', defaultForType: false },
    ]);
    const done = h.node('Blocker');
    expect([done.root.status, ...done.path.map((node) => node.status), done.node.status]).toEqual([
      'done',
      'done',
      'done',
      'done',
    ]);
    expect(done.root.subtasks[0]).toBe(done.path[0]);
    expect(done.path[1]).toBe(done.node);
    expect(done.target).toEqual(before.target);
    expect(before.node.status).toBe('open');
    expect(h.index.list()[0]?.status).toBe('open');
    expect(h.index.dependencies(h.node('Dependent').target).activeBlockedByCount).toBe(0);
    h.statuses.replace(
      h.statuses
        .all()
        .map((rule) => (rule.symbol === 'q' ? { ...rule, type: 'in-progress' } : rule)),
    );
    expect(h.node('Blocker').node.status).toBe('in-progress');
    expect(
      (
        await h.application.execute({
          type: 'set-status',
          target: h.node('Dependent').target,
          symbol: 'x',
        })
      ).type,
    ).toBe('blocked');
  });

  const commands = ['toggle-completion', 'done', 'cancelled'] as const;
  it.each(commands.flatMap((command) => ['root', 'subtask'].map((kind) => ({ command, kind }))))(
    'blocks $kind $command before repository I/O and returns every active relation',
    async ({ command, kind }) => {
      const dependent =
        kind === 'root'
          ? '- [ ] Dependent ⛔ missing, first, duplicate'
          : '- [ ] Root\n  - [ ] Dependent ⛔ missing, first, duplicate';
      const source = `\n- [ ] First 🆔 first\n- [x] Satisfied 🆔 duplicate\n- [/] Active duplicate 🆔 duplicate\n${dependent}\n`;
      const h = await harness({ 'tasks.md': source });
      const edit = vi.spyOn(h.repository, 'edit');
      const recurrence = vi.spyOn(h.repository, 'completeRecurrence');
      const target = h.node('Dependent').target;
      const request: TaskCommand =
        command === 'toggle-completion'
          ? { type: command, target }
          : { type: 'set-status', target, symbol: command === 'done' ? 'x' : '-' };
      const result = await h.application.execute(request);
      expect(result).toMatchObject({
        type: 'blocked',
        target,
        blockers: [
          { type: 'resolved', dependencyId: 'first', state: 'active' },
          { type: 'ambiguous', dependencyId: 'duplicate', state: 'active' },
        ],
      });
      expect(edit).not.toHaveBeenCalled();
      expect(recurrence).not.toHaveBeenCalled();
      expect(await h.read()).toBe(source);
    },
  );

  it('allows a non-completion status change while blocked', async () => {
    const h = await harness({ 'tasks.md': '\n- [ ] Blocker 🆔 id\n- [ ] Dependent ⛔ id\n' });
    expect(
      await h.application.execute({
        type: 'set-status',
        target: h.node('Dependent').target,
        symbol: '/',
      }),
    ).toMatchObject({ type: 'ok' });
    expect(h.node('Dependent').node.status).toBe('in-progress');
  });

  it.each(['satisfied', 'missing', 'done-dependent'])(
    'allows completion with %s relations',
    async (kind) => {
      const h = await harness({
        'tasks.md': `\n- [${kind === 'satisfied' ? 'x' : ' '}] Blocker 🆔 id\n- [${kind === 'done-dependent' ? 'x' : ' '}] Dependent ⛔ ${kind === 'missing' ? 'missing' : 'id'}\n`,
      });
      expect(
        await h.application.execute({
          type: 'set-status',
          target: h.node('Dependent').target,
          symbol: 'x',
        }),
      ).toMatchObject({ type: 'ok' });
    },
  );

  it('blocks recurrence completion without creating the next occurrence', async () => {
    const source = '\n- [ ] Blocker 🆔 id\n- [ ] Dependent 🔁 every day 📅 2026-09-05 ⛔ id\n';
    const h = await harness({ 'tasks.md': source });
    const result = await h.application.execute({
      type: 'toggle-completion',
      target: h.node('Dependent').target,
    });
    expect(result.type).toBe('blocked');
    expect(await h.read()).toBe(source);
  });

  it('rechecks the reconciled root when an edge is added before the retry but the index lags', async () => {
    const h = await harness({ 'a.md': '- [ ] Blocker 🆔 id\n', 'tasks.md': '- [ ] Dependent\n' });
    const previous = h.node('Dependent').root;
    const current = expectDefined(
      h.index.snapshotsFromContent('tasks.md', '- [ ] Dependent ⛔ id\n')[0],
    );
    const edit = vi
      .spyOn(h.repository, 'edit')
      .mockResolvedValue({ type: 'rebased', previous, current, evidence: 'authority-transition' });
    const result = await h.application.execute({
      type: 'toggle-completion',
      target: h.node('Dependent').target,
    });
    expect(result).toMatchObject({
      type: 'blocked',
      target: { type: 'task', ref: current.ref },
      blockers: [{ dependencyId: 'id', state: 'active' }],
    });
    expect(edit).toHaveBeenCalledTimes(1);
    expect(h.node('Dependent').node.dependsOn).toEqual([]);
  });
});
