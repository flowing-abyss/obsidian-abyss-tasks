import { TFile } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import type {
  TaskEditBatchRequest,
  TaskEditCommand,
  TaskEditRequest,
  TaskRepository,
} from '../../src/tasks/application/TaskRepository';
import type { TaskNodeRef, TaskSnapshot } from '../../src/tasks/domain/types';
import { TaskIndex } from '../../src/tasks/infrastructure/TaskIndex';
import {
  TaskRefAuthority,
  taskRefContentFingerprint,
} from '../../src/tasks/infrastructure/TaskRefAuthority';
import { TaskBlockEditor } from '../../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { TaskLocator } from '../../src/tasks/infrastructure/markdown/TaskLocator';
import { TaskMarkdownCodec } from '../../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { ObsidianTaskRepository } from '../../src/tasks/infrastructure/obsidian/ObsidianTaskRepository';
import {
  canonicalStatusCatalog,
  createAppWithFiles,
  expectDefined,
  flushMicrotasks,
} from '../helpers';
import { InMemoryTaskRepository } from '../support/InMemoryTaskRepository';

type Adapter = 'in-memory' | 'obsidian';
const path = 'tasks.md';

async function harness(adapter: Adapter, source: string, current = source) {
  const app = await createAppWithFiles({ [path]: current, 'other.md': '- [ ] Other\n' });
  const statusCatalog = canonicalStatusCatalog();
  const authority = new TaskRefAuthority('batch-contract');
  const index = new TaskIndex(app, {
    statusCatalog,
    dailyNoteFormat: 'YYYY-MM-DD',
    refAuthority: authority,
  });
  await index.initialize();
  const roots = index.installCommittedContent(path, source);
  await flushMicrotasks();
  const options = {
    codec: new TaskMarkdownCodec(statusCatalog),
    editor: new TaskBlockEditor(),
    locator: new TaskLocator(authority),
    snapshotsFromContent: (filePath: string, content: string) =>
      index.snapshotsFromContent(filePath, content),
    refAuthority: authority,
    snapshotState: index,
  };
  const memory = new InMemoryTaskRepository({
    ...options,
    files: { [path]: current, 'other.md': '- [ ] Other\n' },
  });
  const repository: TaskRepository =
    adapter === 'in-memory' ? memory : new ObsidianTaskRepository(app, options);
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) throw new Error('missing batch fixture');
  return {
    app,
    index,
    authority,
    roots,
    repository,
    read: async () => (adapter === 'in-memory' ? memory.content(path) : app.vault.read(file)),
  };
}

function edit(
  root: TaskSnapshot,
  command: Extract<TaskEditCommand, { readonly type: 'set-dependency-id' | 'set-depends-on' }>,
): TaskEditRequest {
  return {
    baseRoot: root,
    baseTarget: command.target,
    reconciliation: { observed: root },
    command,
  };
}

function pair(roots: readonly TaskSnapshot[]): TaskEditBatchRequest {
  const blocker = expectDefined(roots[0]);
  const dependent = expectDefined(roots[1]);
  return {
    filePath: path,
    edits: [
      edit(dependent, {
        type: 'set-depends-on',
        target: { type: 'task', ref: dependent.ref },
        ids: ['blocker'],
      }),
      edit(blocker, {
        type: 'set-dependency-id',
        target: { type: 'task', ref: blocker.ref },
        id: 'blocker',
      }),
    ],
    outcomeTarget: { type: 'task', ref: dependent.ref },
  };
}

for (const adapter of ['in-memory', 'obsidian'] as const) {
  describe(`${adapter} metadata batch contract`, () => {
    it('returns the unchanged current root when another transaction already owns the file', async () => {
      const source = '\n- [ ] Blocker\n- [ ] Dependent\n';
      const h = await harness(adapter, source);
      const blocker = expectDefined(h.roots[0]);
      const dependent = expectDefined(h.roots[1]);
      const reserved = `reserved\n${source}`;
      const staged = h.authority.stage(
        {
          filePath: path,
          candidateFingerprint: taskRefContentFingerprint(reserved),
          candidateLength: reserved.length,
          expectedRevision: blocker.ref.revision,
          roots: [
            { line: 2, source: blocker.source.originalBlock, revision: blocker.ref.revision },
          ],
        },
        blocker.ref.revision,
      );
      if (staged.type !== 'staged') throw new Error('missing reserved transition');
      await expect(h.repository.editBatch(pair(h.roots))).resolves.toEqual({
        type: 'conflict',
        current: dependent,
      });
      expect(await h.read()).toBe(source);
      expect(h.index.list({ filePath: path })).toEqual(h.roots);
      expect(h.authority.observe(path, reserved)).toHaveLength(1);
      h.authority.abort(staged.token);
    });

    it('commits two roots together and preserves each consumed identity through the index event', async () => {
      const h = await harness(adapter, '\n- [ ] Blocker\n- [ ] Dependent\n');
      const notifications: string[][] = [];
      h.index.subscribe(() =>
        notifications.push(h.index.list({ filePath: path }).map((root) => root.title)),
      );
      const request = pair(h.roots);

      const result = await h.repository.editBatch(request);

      expect(await h.read()).toBe('\n- [ ] Blocker 🆔 blocker\n- [ ] Dependent ⛔ blocker\n');
      expect(result).toMatchObject({
        type: 'committed',
        changed: true,
        outcome: { type: 'task', task: { title: 'Dependent', dependsOn: ['blocker'] } },
      });
      if (result.type !== 'committed' || result.outcome.type !== 'task')
        throw new Error('missing root outcome');
      const committed = h.index.list({ filePath: path });
      expect(result.outcome.task).toEqual(committed[1]);
      h.index.installCommittedContent(path, expectDefined(await h.read()));
      await flushMicrotasks();
      expect(notifications).toEqual([['Blocker', 'Dependent']]);
      for (const [position, previous] of h.roots.entries()) {
        const successor = expectDefined(committed[position]);
        expect(successor.ref.revision).not.toBe(previous.ref.revision);
        expect(h.index.resolve(previous.ref)).toMatchObject({
          type: 'rebased',
          evidence: 'authority-transition',
          current: { ref: successor.ref },
        });
        expect(h.index.authoritySuccessor(previous.ref)).toEqual(successor.ref);
      }
    });

    it.each(['parent-first', 'child-first'] as const)(
      'resolves a nested child against the original aggregate (%s)',
      async (order) => {
        const source =
          '\r\n- [ ] Root 🧩 future ^root\r\n  - [ ] Parent\r\n    - [ ] Child ^child\r\n    - 2026-07-14: comment\r\n  - [ ] Sibling\r\n- [ ] Neighbor\r\n';
        const h = await harness(adapter, source);
        const root = expectDefined(h.roots[0]);
        const parent = expectDefined(root.subtasks[0]);
        const child = expectDefined(parent.subtasks[0]);
        const childTarget: TaskNodeRef = { type: 'subtask', ref: child.ref };
        const parentEdit = edit(root, {
          type: 'set-dependency-id',
          target: { type: 'subtask', ref: parent.ref },
          id: 'parent',
        });
        const childEdit = edit(root, {
          type: 'set-depends-on',
          target: childTarget,
          ids: ['parent'],
        });
        const result = await h.repository.editBatch({
          filePath: path,
          edits: order === 'parent-first' ? [parentEdit, childEdit] : [childEdit, parentEdit],
          outcomeTarget: childTarget,
        });

        expect(await h.read()).toBe(
          '\r\n- [ ] Root 🧩 future ^root\r\n  - [ ] Parent 🆔 parent\r\n    - [ ] Child ⛔ parent ^child\r\n    - 2026-07-14: comment\r\n  - [ ] Sibling\r\n- [ ] Neighbor\r\n',
        );
        expect(result).toMatchObject({ type: 'committed', changed: true });
        if (result.type !== 'committed' || result.outcome.type !== 'task')
          throw new Error('missing root outcome');
        const freshRoot = expectDefined(h.index.list({ filePath: path })[0]);
        expect(result.outcome.task).toEqual(freshRoot);
        const freshChild = expectDefined(expectDefined(freshRoot.subtasks[0]).subtasks[0]);
        expect(freshChild.dependsOn).toEqual(['parent']);
        expect(freshChild.ref).not.toEqual(child.ref);
        expect(h.index.resolve(root.ref)).toMatchObject({
          type: 'rebased',
          current: { ref: freshRoot.ref },
        });
      },
    );

    it('combines root and subtask metadata changes and returns a detached unchanged outcome on repetition', async () => {
      const h = await harness(adapter, '- [ ] Root\n  - [ ] Child\n');
      const requestFor = (root: TaskSnapshot): TaskEditBatchRequest => {
        const child = expectDefined(root.subtasks[0]);
        return {
          filePath: path,
          edits: [
            edit(root, {
              type: 'set-dependency-id',
              target: { type: 'task', ref: root.ref },
              id: 'root',
            }),
            edit(root, {
              type: 'set-depends-on',
              target: { type: 'subtask', ref: child.ref },
              ids: ['root', 'root'],
            }),
          ],
          outcomeTarget: { type: 'subtask', ref: child.ref },
        };
      };
      await expect(
        h.repository.editBatch(requestFor(expectDefined(h.roots[0]))),
      ).resolves.toMatchObject({ type: 'committed', changed: true });
      expect(await h.read()).toBe('- [ ] Root 🆔 root\n  - [ ] Child ⛔ root, root\n');
      const fresh = expectDefined(h.index.list({ filePath: path })[0]);
      await expect(h.repository.editBatch(requestFor(fresh))).resolves.toMatchObject({
        type: 'committed',
        changed: false,
        outcome: { type: 'task', task: fresh },
      });
      expect(h.index.list({ filePath: path })[0]?.ref).toEqual(fresh.ref);
    });

    it('composes two carriers on the same source line without dropping either edit', async () => {
      const h = await harness(adapter, '- [ ] Root\n');
      const root = expectDefined(h.roots[0]);
      const target: TaskNodeRef = { type: 'task', ref: root.ref };
      await expect(
        h.repository.editBatch({
          filePath: path,
          edits: [
            edit(root, { type: 'set-dependency-id', target, id: 'root' }),
            edit(root, { type: 'set-depends-on', target, ids: ['other'] }),
          ],
          outcomeTarget: target,
        }),
      ).resolves.toMatchObject({ type: 'committed', changed: true });
      expect(await h.read()).toBe('- [ ] Root 🆔 root ⛔ other\n');
    });

    it.each([
      'invalid-id',
      'unsupported-command',
      'cross-file',
      'wrong-base-root',
      'wrong-base-target',
      'empty',
    ] as const)('rejects %s before vault access or any publication', async (fault) => {
      const source = '\n- [ ] Blocker\n- [ ] Dependent\n';
      const h = await harness(adapter, source);
      const request = pair(h.roots);
      const second = expectDefined(request.edits[1]);
      const first = expectDefined(request.edits[0]);
      const blocker = expectDefined(h.roots[0]);
      let broken: TaskEditRequest = second;
      if (fault === 'invalid-id')
        broken = {
          ...second,
          command: {
            type: 'set-dependency-id',
            target: { type: 'task', ref: blocker.ref },
            id: 'bad id',
          },
        };
      if (fault === 'unsupported-command')
        broken = { ...second, command: { type: 'delete', ref: blocker.ref } };
      if (fault === 'cross-file')
        broken = {
          ...second,
          command: {
            type: 'set-dependency-id',
            target: { type: 'task', ref: { ...blocker.ref, filePath: 'other.md' } },
            id: 'blocker',
          },
        };
      if (fault === 'wrong-base-root') broken = { ...second, baseRoot: first.baseRoot };
      if (fault === 'wrong-base-target') broken = { ...second, baseTarget: first.baseTarget };
      const access = vi.spyOn(h.app.vault, 'getAbstractFileByPath');
      await expect(
        h.repository.editBatch({ ...request, edits: fault === 'empty' ? [] : [first, broken] }),
      ).resolves.toMatchObject({ type: 'invalid' });
      expect(access).not.toHaveBeenCalled();
      expect(await h.read()).toBe(source);
      expect(h.index.list({ filePath: path })).toEqual(h.roots);
      expect(h.authority.observe(path, source)).toEqual([]);
    });

    it('rejects a stale second subtask without publishing the valid first edit', async () => {
      const source = '- [ ] Root\n  - [ ] Child\n';
      const h = await harness(adapter, source);
      const root = expectDefined(h.roots[0]);
      const child = expectDefined(root.subtasks[0]);
      const stale: TaskNodeRef = {
        type: 'subtask',
        ref: { ...child.ref, originalBlock: '  - [ ] Replaced' },
      };
      await expect(
        h.repository.editBatch({
          filePath: path,
          edits: [
            edit(root, {
              type: 'set-dependency-id',
              target: { type: 'task', ref: root.ref },
              id: 'root',
            }),
            edit(root, { type: 'set-depends-on', target: stale, ids: ['root'] }),
          ],
          outcomeTarget: { type: 'task', ref: root.ref },
        }),
      ).resolves.toMatchObject({ type: 'conflict' });
      expect(await h.read()).toBe(source);
      expect(h.index.list({ filePath: path })).toEqual(h.roots);
    });

    it('validates the requested outcome node before changing either root', async () => {
      const source = '\n- [ ] Blocker\n- [ ] Dependent\n  - [ ] Child\n';
      const h = await harness(adapter, source);
      const request = pair(h.roots);
      const child = expectDefined(expectDefined(h.roots[1]).subtasks[0]);
      await expect(
        h.repository.editBatch({
          ...request,
          outcomeTarget: { type: 'subtask', ref: { ...child.ref, originalBlock: '  - [ ] Gone' } },
        }),
      ).resolves.toMatchObject({ type: 'conflict' });
      expect(await h.read()).toBe(source);
      expect(h.index.list({ filePath: path })).toEqual(h.roots);
    });

    it('returns relocation reconciliation before applying a batch to moved source', async () => {
      const source = '\n- [ ] Blocker\n- [ ] Dependent\n';
      const relocated = `intro\n${source}`;
      const h = await harness(adapter, source, relocated);
      await expect(h.repository.editBatch(pair(h.roots))).resolves.toMatchObject({
        type: 'rebased',
        evidence: 'byte-identical-relocation',
        current: { title: 'Dependent', source: { line: 3 } },
      });
      expect(await h.read()).toBe(relocated);
    });

    it('returns authority reconciliation for a changed second root before mutating the first', async () => {
      const h = await harness(adapter, '\n- [ ] Blocker\n- [ ] Dependent\n');
      const request = pair(h.roots);
      const blocker = expectDefined(h.roots[0]);
      await h.repository.edit({
        type: 'set-dependency-id',
        target: { type: 'task', ref: blocker.ref },
        id: 'external',
      });
      await expect(h.repository.editBatch(request)).resolves.toMatchObject({
        type: 'rebased',
        evidence: 'authority-transition',
        previous: { ref: blocker.ref },
        current: { dependencyId: 'external' },
      });
      expect(await h.read()).toBe('\n- [ ] Blocker 🆔 external\n- [ ] Dependent\n');
    });
  });
}

describe('Obsidian batch transaction', () => {
  it('keeps authoritative bytes but revokes speculative provenance after a late processor rejection', async () => {
    const source = '\n- [ ] Blocker\n- [ ] Dependent\n';
    const candidate = '\n- [ ] Blocker 🆔 blocker\n- [ ] Dependent ⛔ blocker\n';
    const h = await harness('obsidian', source);
    vi.spyOn(h.app.vault, 'process').mockImplementationOnce(async (file, transform) => {
      await h.app.vault.modify(file, transform(await h.app.vault.read(file)));
      throw new Error('rejected after persistence');
    });
    await expect(h.repository.editBatch(pair(h.roots))).resolves.toMatchObject({
      type: 'io-error',
      contentState: 'unknown',
    });
    expect(await h.read()).toBe(candidate);
    expect(
      h.index.list({ filePath: path }).map((root) => [root.dependencyId, root.dependsOn]),
    ).toEqual([
      ['blocker', []],
      [undefined, ['blocker']],
    ]);
    for (const root of h.roots) {
      expect(h.index.authoritySuccessor(root.ref)).toBeUndefined();
      expect(h.index.resolve(root.ref).type).not.toBe('rebased');
    }
    expect(h.authority.observe(path, candidate)).toEqual([]);
  });

  it('uses one synchronous Vault.process callback for both edits', async () => {
    const h = await harness('obsidian', '\n- [ ] Blocker\n- [ ] Dependent\n');
    const process = vi.spyOn(h.app.vault, 'process');
    await expect(h.repository.editBatch(pair(h.roots))).resolves.toMatchObject({
      type: 'committed',
      changed: true,
    });
    expect(process).toHaveBeenCalledOnce();
    expect(process.mock.calls[0]?.[1].constructor.name).not.toBe('AsyncFunction');
    expect(await h.read()).toBe('\n- [ ] Blocker 🆔 blocker\n- [ ] Dependent ⛔ blocker\n');
  });

  it.each([false, true])(
    'restores both identities after processor rejection (early observation: %s)',
    async (observeEarly) => {
      const source = '\n- [ ] Blocker\n- [ ] Dependent\n';
      const candidate = '\n- [ ] Blocker 🆔 blocker\n- [ ] Dependent ⛔ blocker\n';
      const h = await harness('obsidian', source);
      const process = vi
        .spyOn(h.app.vault, 'process')
        .mockImplementationOnce(async (file, transform) => {
          const proposed = transform(await h.app.vault.read(file));
          expect(proposed).toBe(candidate);
          if (observeEarly) h.index.installCommittedContent(path, proposed);
          throw new Error('processor rejected');
        });
      await expect(h.repository.editBatch(pair(h.roots))).resolves.toMatchObject({
        type: 'io-error',
        cause: 'process-error',
        contentState: 'unknown',
      });
      expect(await h.read()).toBe(source);
      expect(h.index.list({ filePath: path })).toEqual(h.roots);
      for (const root of h.roots) {
        expect(h.index.resolve(root.ref)).toMatchObject({ type: 'exact', task: { ref: root.ref } });
        expect(h.index.authoritySuccessor(root.ref)).toBeUndefined();
      }
      expect(h.authority.observe(path, candidate)).toEqual([]);
      expect(h.authority.observe(path, source)).toEqual([]);
      process.mockRestore();
      await expect(h.repository.editBatch(pair(h.roots))).resolves.toMatchObject({
        type: 'committed',
        changed: true,
      });
    },
  );
});
