import { TFile } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { TaskApplicationService } from '../../src/tasks/application/TaskApplicationService';
import type {
  TaskEditBatchRequest,
  TaskEditCommand,
  TaskEditRequest,
  TaskRepository,
} from '../../src/tasks/application/TaskRepository';
import { clockFrom } from '../../src/tasks/domain/clock';
import type { TaskCommand } from '../../src/tasks/domain/commands';
import type { TaskNodeRef, TaskSnapshot } from '../../src/tasks/domain/types';
import { localDate } from '../../src/tasks/domain/validation';
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
  deferred,
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
    statusCatalog,
    locator: options.locator,
    editor: options.editor,
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

function publicEdits(root: TaskSnapshot): Record<string, TaskCommand> {
  const target = { type: 'task' as const, ref: root.ref };
  const child = expectDefined(root.subtasks[0]);
  const sibling = expectDefined(root.subtasks[1]);
  const nested = { type: 'subtask' as const, ref: child.ref };
  const comment = expectDefined(root.comments[0]).ref;
  return {
    patch: { type: 'patch', target, patch: { priority: { type: 'set', value: 'A' } } },
    'nested patch': {
      type: 'patch',
      target: nested,
      patch: { priority: { type: 'set', value: 'A' } },
    },
    'append-title': { type: 'append-title', target, markdown: ' more' },
    'set-status': { type: 'set-status', target, symbol: 'x' },
    'nested status': { type: 'set-status', target: nested, symbol: 'x' },
    'toggle-completion': { type: 'toggle-completion', target },
    'set-description': { type: 'set-description', target, text: 'Updated' },
    'add-subtask': { type: 'add-subtask', parent: target, text: 'Added' },
    'delete-subtask': { type: 'delete-subtask', subtask: child.ref },
    'restore-subtask': {
      type: 'restore-subtask',
      parent: target,
      markdown: '  - [ ] Restored',
      placement: { relativeLine: sibling.ref.relativeLine + 1, before: sibling.ref },
    },
    'reorder-subtask': {
      type: 'reorder-subtask',
      subtask: child.ref,
      target: sibling.ref,
      placement: 'after',
    },
    'add-comment': { type: 'add-comment', parent: target, text: 'Added' },
    'update-comment': { type: 'update-comment', comment, text: 'Updated' },
    'delete-comment': { type: 'delete-comment', comment },
    'edit-link': {
      type: 'edit-link',
      target: { type: 'title', target },
      occurrence: 0,
      replacement: '[[Changed]]',
    },
    reschedule: { type: 'reschedule', ref: root.ref, date: localDate('2026-09-06') },
    'shift-schedule': { type: 'shift-schedule', ref: root.ref, days: 1 },
    delete: { type: 'delete', ref: root.ref },
  };
}

const publicEditKinds = [
  'patch',
  'nested patch',
  'append-title',
  'set-status',
  'nested status',
  'toggle-completion',
  'set-description',
  'add-subtask',
  'delete-subtask',
  'restore-subtask',
  'reorder-subtask',
  'add-comment',
  'update-comment',
  'delete-comment',
  'edit-link',
  'reschedule',
  'shift-schedule',
  'delete',
];
const observations = ['immediate', 'acknowledged', 'index-lag'] as const;

for (const adapter of ['in-memory', 'obsidian'] as const) {
  describe(`${adapter} metadata batch contract`, () => {
    it.each(
      observations.flatMap((observation) => publicEditKinds.map((kind) => ({ observation, kind }))),
    )(
      'keeps the sibling untouched for public $kind ($observation)',
      async ({ observation, kind }) => {
        const block =
          '- [ ] Same [[Note]] ⏳ 2026-09-05\n  - 2026-09-05: Note\n  - [ ] Child\n  - [ ] Sibling';
        const h = await harness(adapter, `\n${block}\n${block}\n`);
        const first = expectDefined(h.roots[0]);
        const application = new TaskApplicationService(
          h.index,
          h.repository,
          h.statusCatalog,
          clockFrom(Date.UTC(2026, 8, 5), 0),
        );
        const execute = h.repository.edit.bind(h.repository);
        let interleave = true;
        const dispatch = vi.spyOn(h.repository, 'edit').mockImplementation(async (request) => {
          if (interleave) {
            interleave = false;
            const install =
              observation === 'index-lag'
                ? vi
                    .spyOn(h.index, 'installCommittedContent')
                    .mockImplementation((filePath, content) =>
                      h.index.previewContent(filePath, content),
                    )
                : undefined;
            expect(
              (
                await execute({
                  type: 'set-dependency-id',
                  target: { type: 'task', ref: first.ref },
                  id: 'first',
                })
              ).type,
            ).toBe('committed');
            install?.mockRestore();
            if (observation === 'acknowledged') {
              await flushMicrotasks();
              h.index.installCommittedContent(path, expectDefined(await h.read()));
              await flushMicrotasks();
            }
          }
          return execute(request);
        });
        const result = await application.execute(expectDefined(publicEdits(first)[kind]));
        expect(dispatch, JSON.stringify(result)).toHaveBeenCalled();
        expect(expectDefined(await h.read()), JSON.stringify(result)).toContain(`\n${block}\n`);
        expect(
          h.editor.rootBlocks(expectDefined(await h.read())).slice(-1)[0]?.source,
          JSON.stringify(result),
        ).toBe(block);
      },
    );

    it.each([0, 1, 2, 3])(
      'resolves the exact authority successor of duplicate occurrence %s among four',
      async (position) => {
        const source = '\n- [ ] Same\n- [ ] Same\n- [ ] Same\n- [ ] Same\n';
        const h = await harness(adapter, source);
        const previous = expectDefined(h.roots[position]);
        expect(
          (
            await h.repository.edit({
              type: 'set-dependency-id',
              target: { type: 'task', ref: previous.ref },
              id: 'chosen',
            })
          ).type,
        ).toBe('committed');
        const successor = expectDefined(h.index.authoritySuccessor(previous.ref));
        expect(successor.line).toBe(previous.ref.line);
        expect(h.index.resolve(previous.ref)).toMatchObject({
          type: 'rebased',
          evidence: 'authority-transition',
          current: { ref: successor },
        });
        h.index.installCommittedContent(path, expectDefined(await h.read()));
        await flushMicrotasks();
        expect(h.index.resolve(previous.ref)).toMatchObject({
          type: 'rebased',
          evidence: 'authority-transition',
          current: { ref: successor },
        });
        expect(h.index.resolve({ ...previous.ref, line: 99 }).type).toBe('ambiguous');
      },
    );

    it.each(['patch', 'delete'] as const)(
      'never redirects a prepared public %s to the now-unique identical sibling',
      async (kind) => {
        const h = await harness(adapter, '\n- [ ] Same\n- [ ] Same\n');
        const first = expectDefined(h.roots[0]);
        const application = new TaskApplicationService(h.index, h.repository, h.statusCatalog, {
          today: () => localDate('2026-09-05'),
        });
        const execute = h.repository.edit.bind(h.repository);
        const trace: unknown[] = [];
        let interleave = true;
        vi.spyOn(h.repository, 'edit').mockImplementation(async (request) => {
          if (interleave) {
            interleave = false;
            expect(
              (
                await execute({
                  type: 'set-dependency-id',
                  target: { type: 'task', ref: first.ref },
                  id: 'first',
                })
              ).type,
            ).toBe('committed');
          }
          const source = expectDefined(await h.read());
          trace.push({
            requested: 'command' in request ? request.baseRoot.ref : request,
            authoritySuccessor: h.index.authoritySuccessor(first.ref),
            sourceCandidate: h.index.currentRoot(path, first.ref.line, first.source.originalBlock),
            sourceLocation: h.locator.locate(h.editor.rootBlocks(source), first.ref),
          });
          return execute(request);
        });

        const result = await application.execute(
          kind === 'patch'
            ? {
                type: 'patch',
                target: { type: 'task', ref: first.ref },
                patch: { priority: { type: 'set', value: 'A' } },
              }
            : { type: 'delete', ref: first.ref },
        );

        expect(await h.read(), JSON.stringify({ result, trace }, null, 2)).toMatch(
          /\n- \[ \] Same\n$/u,
        );
      },
    );

    it('commits distinct byte-identical roots when both line and authority revision are current', async () => {
      const h = await harness(adapter, '\n- [ ] Same\n- [ ] Same\n');

      await expect(h.repository.editBatch(pair(h.roots))).resolves.toMatchObject({
        type: 'committed',
        changed: true,
      });
      expect(await h.read()).toBe('\n- [ ] Same 🆔 blocker\n- [ ] Same ⛔ blocker\n');
    });

    it.each([
      ['inserted before', '\n- [ ] Same\n- [ ] Same\ntext\n- [ ] Same\n'],
      ['inserted after', '\n- [ ] Same\ntext\n- [ ] Same\n- [ ] Same\n'],
      ['deleted before', '\ntext\n- [ ] Same\n'],
      ['deleted after', '\n- [ ] Same\ntext\n'],
      ['reordered around retained text', '\ntext\n- [ ] Same\n- [ ] Same\n'],
    ])('rejects an unobserved duplicate population change (%s)', async (_name, current) => {
      const h = await harness(adapter, '\n- [ ] Same\ntext\n- [ ] Same\n', current);
      expect(h.index.list({ filePath: path })).toEqual(h.roots);

      const result = await h.repository.editBatch(pair(h.roots));

      expect(result.type).not.toBe('committed');
      expect(result.type).not.toBe('rebased');
      expect(await h.read()).toBe(current);
      expect(
        h.index
          .list({ filePath: path })
          .every((task) => task.dependencyId === undefined && task.dependsOn.length === 0),
      ).toBe(true);
    });

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
  it.each(
    (['single', 'batch', 'delete'] as const).flatMap((kind) =>
      ['none', 'early', 'early-notified'].map((observation) => ({ kind, observation })),
    ),
  )(
    'restores all duplicate groups repeatedly for $kind ($observation)',
    async ({ kind, observation }) => {
      const source = '\n- [ ] Same\n- [ ] Same\n- [ ] Other\n- [ ] Other\n';
      const h = await harness('obsidian', source);
      const first = expectDefined(h.roots[0]);
      const originalRead = h.app.vault.read.bind(h.app.vault);
      for (let attempt = 0; attempt < 2; attempt++) {
        let candidate = '';
        let speculative: readonly TaskSnapshot[] = [];
        vi.spyOn(h.app.vault, 'process').mockImplementationOnce(async (file, transform) => {
          candidate = transform(await originalRead(file));
          if (observation !== 'none')
            speculative = h.index.installCommittedContent(path, candidate);
          if (observation === 'early-notified') await flushMicrotasks();
          throw new Error('rejected');
        });
        const command: TaskEditCommand =
          kind === 'delete'
            ? { type: 'delete', ref: first.ref }
            : { type: 'set-dependency-id', target: { type: 'task', ref: first.ref }, id: 'first' };
        const result =
          kind === 'batch'
            ? await h.repository.editBatch(pair(h.roots))
            : await h.repository.edit(command);
        expect(result).toMatchObject({ type: 'io-error', contentState: 'unknown' });
        expect(await h.read()).toBe(source);
        expect(h.index.list({ filePath: path })).toEqual(h.roots);
        for (const root of h.roots) {
          expect(h.index.resolve(root.ref)).toMatchObject({
            type: 'exact',
            task: { ref: root.ref },
          });
          expect(h.index.authoritySuccessor(root.ref)).toBeUndefined();
        }
        for (const root of speculative.filter(
          (root) => !h.roots.some(({ ref }) => ref.revision === root.ref.revision),
        )) {
          expect(['rebased', 'exact']).not.toContain(h.index.resolve(root.ref).type);
          expect(h.index.authoritySuccessor(root.ref)).toBeUndefined();
        }
        expect(h.authority.observeTransition(path, source)).toBeUndefined();
        expect(h.authority.observeTransition(path, candidate)).toBeUndefined();
        expect(h.index['reconciliationTransitions_abyssPrivate'].has(path)).toBe(false);
        h.index.installCommittedContent(path, source);
        await flushMicrotasks();
        expect(h.index.list({ filePath: path })).toEqual(h.roots);
      }
    },
  );

  it.each(
    (['single', 'batch'] as const).flatMap((kind) =>
      [false, true].map((early) => ({ kind, early })),
    ),
  )(
    'does not reassign predecessor identities after late $kind rejection (early: $early)',
    async ({ kind, early }) => {
      const source = '\n- [ ] Same\n- [ ] Same\n';
      const h = await harness('obsidian', source);
      const first = expectDefined(h.roots[0]);
      let candidate = '';
      vi.spyOn(h.app.vault, 'process').mockImplementationOnce(async (file, transform) => {
        candidate = transform(await h.app.vault.read(file));
        if (early) h.index.installCommittedContent(path, candidate);
        await h.app.vault.modify(file, candidate);
        throw new Error('rejected after persistence');
      });
      const result =
        kind === 'batch'
          ? await h.repository.editBatch(pair(h.roots))
          : await h.repository.edit({
              type: 'set-dependency-id',
              target: { type: 'task', ref: first.ref },
              id: 'first',
            });
      expect(result).toMatchObject({ type: 'io-error', contentState: 'unknown' });
      expect(await h.read()).toBe(candidate);
      for (const root of h.roots) {
        expect(h.index.authoritySuccessor(root.ref)).toBeUndefined();
        expect(['exact', 'rebased']).not.toContain(h.index.resolve(root.ref).type);
      }
      expect(h.authority.observeTransition(path, source)).toBeUndefined();
      expect(h.authority.observeTransition(path, candidate)).toBeUndefined();
    },
  );

  it.each(['single', 'batch'] as const)(
    'releases ownership and forward mappings when rejected duplicate %s cannot be read',
    async (kind) => {
      const source = '\n- [ ] Same\n- [ ] Same\n';
      const h = await harness('obsidian', source);
      const first = expectDefined(h.roots[0]);
      let candidate = '';
      const originalRead = h.app.vault.read.bind(h.app.vault);
      vi.spyOn(h.app.vault, 'process').mockImplementationOnce(async (file, transform) => {
        candidate = transform(await originalRead(file));
        h.index.installCommittedContent(path, candidate);
        throw new Error('rejected');
      });
      vi.spyOn(h.app.vault, 'read').mockRejectedValueOnce(new Error('read rejected'));
      const result =
        kind === 'batch'
          ? await h.repository.editBatch(pair(h.roots))
          : await h.repository.edit({
              type: 'set-dependency-id',
              target: { type: 'task', ref: first.ref },
              id: 'first',
            });
      expect(result).toMatchObject({ type: 'io-error', contentState: 'unknown' });
      expect(await h.read()).toBe(source);
      for (const root of h.roots) expect(h.index.authoritySuccessor(root.ref)).toBeUndefined();
      expect(h.authority.observeTransition(path, source)).toBeUndefined();
      expect(h.authority.observeTransition(path, candidate)).toBeUndefined();
      h.index.installCommittedContent(path, source);
      const current = expectDefined(h.index.list({ filePath: path })[0]);
      expect(
        (
          await h.repository.edit({
            type: 'set-dependency-id',
            target: { type: 'task', ref: current.ref },
            id: 'retry',
          })
        ).type,
      ).toBe('committed');
    },
  );

  it.each(['single', 'batch'] as const)(
    'restores the exact original duplicate population after rejected %s with speculative observation',
    async (kind) => {
      const source = '\n- [ ] Same\n- [ ] Same\n';
      const h = await harness('obsidian', source);
      const first = expectDefined(h.roots[0]);
      const trace: unknown[] = [];
      let proposed = '';
      vi.spyOn(h.app.vault, 'process').mockImplementationOnce(async (file, transform) => {
        proposed = transform(await h.app.vault.read(file));
        h.index.installCommittedContent(path, proposed);
        trace.push({
          speculative: h.index.list({ filePath: path }).map(({ ref }) => ref),
          successor: h.index.authoritySuccessor(first.ref),
        });
        throw new Error('processor rejected');
      });
      const result =
        kind === 'single'
          ? await h.repository.edit({
              type: 'set-dependency-id',
              target: { type: 'task', ref: first.ref },
              id: 'first',
            })
          : await h.repository.editBatch(pair(h.roots));
      expect(result).toMatchObject({ type: 'io-error', contentState: 'unknown' });
      expect(await h.read()).toBe(source);
      trace.push({
        restored: h.index.list({ filePath: path }).map(({ ref }) => ref),
        successor: h.index.authoritySuccessor(first.ref),
        locator: h.locator.locate(h.editor.rootBlocks(source), first.ref),
      });
      expect(h.index.list({ filePath: path }), JSON.stringify(trace, null, 2)).toEqual(h.roots);
      for (const root of h.roots) {
        expect(h.index.resolve(root.ref)).toMatchObject({ type: 'exact', task: { ref: root.ref } });
        expect(h.index.authoritySuccessor(root.ref)).toBeUndefined();
      }
      expect(h.authority.observe(path, proposed)).toEqual([]);
      expect(h.authority.observe(path, source)).toEqual([]);
    },
  );

  it.each(
    [false, true].flatMap((readFails) =>
      [false, true].map((duplicates) => ({ readFails, duplicates })),
    ),
  )(
    'keeps a competing edit after delayed rollback reading (read failure: $readFails; duplicates: $duplicates)',
    async ({ readFails, duplicates }) => {
      const prefix = duplicates
        ? '\n- [ ] Same\n- [ ] Same\n'
        : '\n- [ ] Blocker\n- [ ] Dependent\n';
      const source = `${prefix}- [ ] Later\n`;
      const expected = `${prefix}- [ ] Later 🆔 later\n`;
      const h = await harness('obsidian', source);
      const later = expectDefined(h.roots[2]);
      const laterCommand = {
        type: 'set-dependency-id' as const,
        target: { type: 'task' as const, ref: later.ref },
        id: 'later',
      };
      const rawRead = h.app.vault.read.bind(h.app.vault);
      const readStarted = deferred<void>();
      const finishRead = deferred<void>();
      let candidate = '';
      vi.spyOn(h.app.vault, 'process').mockImplementationOnce(async (file, transform) => {
        candidate = transform(await rawRead(file));
        h.index.installCommittedContent(path, candidate);
        throw new Error('processor rejected after early observation');
      });
      vi.spyOn(h.app.vault, 'read').mockImplementationOnce(async (file) => {
        const captured = await rawRead(file);
        readStarted.resolve();
        await finishRead.promise;
        if (readFails) throw new Error('rollback read rejected');
        return captured;
      });

      const rejectedBatch = h.repository.editBatch(pair(h.roots));
      await readStarted.promise;
      const competingAttempt = await h.repository.edit(laterCommand);
      finishRead.resolve();
      await expect(rejectedBatch).resolves.toMatchObject({
        type: 'io-error',
        contentState: 'unknown',
      });
      const competingCommit =
        competingAttempt.type === 'committed'
          ? competingAttempt
          : await h.repository.edit(laterCommand);

      expect(competingCommit).toMatchObject({ type: 'committed', changed: true });
      if (competingCommit.type !== 'committed' || competingCommit.outcome.type !== 'task')
        throw new Error('missing competing task outcome');
      expect(await h.read()).toBe(expected);
      const current = expectDefined(h.index.list({ filePath: path })[2]);
      expect(current.dependencyId).toBe('later');
      expect(current.ref).toEqual(competingCommit.outcome.task.ref);
      expect(h.index.resolve(competingCommit.outcome.task.ref)).toMatchObject({
        type: 'exact',
        task: { ref: current.ref },
      });
      expect(competingAttempt).toMatchObject({ type: 'conflict' });
      expect(h.authority.observe(path, candidate)).toEqual([]);
      expect(h.authority.observe(path, expected)).toEqual([]);
      for (const root of h.roots.slice(0, 2))
        expect(h.index.authoritySuccessor(root.ref)).toBeUndefined();
    },
  );

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
