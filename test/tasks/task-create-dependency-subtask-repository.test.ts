import { TFile } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import type {
  CreateDependencySubtaskRequest,
  TaskRepository,
  TaskRepositoryResult,
} from '../../src/tasks/application/TaskRepository';
import { enumerateTaskNodes } from '../../src/tasks/domain/taskDependencies';
import { sameTaskNodeRef } from '../../src/tasks/domain/types';
import { localDate } from '../../src/tasks/domain/validation';
import { TaskIndex } from '../../src/tasks/infrastructure/TaskIndex';
import { TaskRefAuthority } from '../../src/tasks/infrastructure/TaskRefAuthority';
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

const path = 'tasks.md';
const source = '- [ ] Root\n  - [ ] Current\n    - [ ] Existing\n  - [ ] Sibling\n';

async function harness(
  adapter: 'in-memory' | 'obsidian',
  current = source,
  original = source,
  withState = true,
) {
  const app = await createAppWithFiles({ [path]: current });
  const statusCatalog = canonicalStatusCatalog();
  const authority = new TaskRefAuthority('linked-child');
  const index = new TaskIndex(app, {
    statusCatalog,
    dailyNoteFormat: 'YYYY-MM-DD',
    refAuthority: authority,
  });
  await index.initialize();
  const root = expectDefined(index.installCommittedContent(path, original)[0]);
  await flushMicrotasks();
  const options = {
    codec: new TaskMarkdownCodec(statusCatalog),
    editor: new TaskBlockEditor(),
    locator: new TaskLocator(authority),
    snapshotsFromContent: (filePath: string, content: string) =>
      index.snapshotsFromContent(filePath, content),
    ...(withState && { refAuthority: authority, snapshotState: index }),
  };
  const memory = new InMemoryTaskRepository({ ...options, files: { [path]: current } });
  const repository: TaskRepository =
    adapter === 'in-memory' ? memory : new ObsidianTaskRepository(app, options);
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) throw new Error('missing fixture');
  const request: CreateDependencySubtaskRequest = {
    baseRoot: root,
    baseTarget: { type: 'task', ref: root.ref },
    reconciliation: { observed: root },
    direction: 'blocked-by',
    text: 'Created #tag 📅 2026-09-10',
    childId: 'child_id',
    currentId: 'current_id',
    today: localDate('2026-09-06'),
    addCreatedDate: true,
  };
  return {
    app,
    file,
    root,
    index,
    repository,
    request,
    options,
    read: async () => (adapter === 'in-memory' ? memory.content(path) : app.vault.read(file)),
  };
}

function linkedOutcome(result: TaskRepositoryResult) {
  if (result.type !== 'committed' || result.outcome.type !== 'dependency-subtask')
    throw new Error('missing linked evidence');
  return result.outcome;
}

for (const adapter of ['in-memory', 'obsidian'] as const) {
  describe(`${adapter} atomic linked subtask`, () => {
    it('returns an unknown-state I/O result and a content-free diagnostic when postcommit parsing throws', async () => {
      const h = await harness(adapter, source, source, false);
      const parse = h.index.snapshotsFromContent.bind(h.index);
      let candidateParses = 0;
      vi.spyOn(h.index, 'snapshotsFromContent').mockImplementation((filePath, content) => {
        if (content.includes('🆔 child_id') && ++candidateParses === 2)
          throw new Error('private note content must not enter diagnostics');
        return parse(filePath, content);
      });
      const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(h.repository.createDependencySubtask(h.request)).resolves.toMatchObject({
        type: 'io-error',
        cause: 'linked-subtask-postcondition',
        path,
        contentState: 'unknown',
      });
      expect(await h.read()).toContain('🆔 child_id');
      expect(await h.read()).toContain('⛔ child_id');
      expect(diagnostic).toHaveBeenCalledExactlyOnceWith(
        '[abyss-tasks] Linked subtask postcondition failed',
        {
          operation: 'create-dependency-subtask',
          phase: 'postcommit',
          cause: 'parser-error',
        },
      );
    });

    it('reparses the committed candidate when no index installer is configured', async () => {
      const h = await harness(adapter, source, source, false);
      const parse = vi.spyOn(h.index, 'snapshotsFromContent');
      const outcome = linkedOutcome(await h.repository.createDependencySubtask(h.request));
      const committed = await h.read();
      expect(
        parse.mock.calls.filter(([, content]) => content === committed).length,
      ).toBeGreaterThanOrEqual(2);
      expect(outcome.current.root.source.originalBlock).toContain('🆔 child_id');
    });
    it('reuses an existing blocker ID and respects disabled created stamping', async () => {
      const original = '- [ ] Root 🆔 existing ⛔ first, first, second\n';
      const h = await harness(adapter, original, original);
      const request = { ...h.request };
      delete request.currentId;
      const result = await h.repository.createDependencySubtask({
        ...request,
        direction: 'blocks',
        text: 'Child',
        addCreatedDate: false,
      });
      expect(result).toMatchObject({ type: 'committed', outcome: { dependencyId: 'existing' } });
      expect(await h.read()).toBe(
        '- [ ] Root 🆔 existing ⛔ first, first, second\n  - [ ] Child ⛔ existing\n',
      );
    });

    it('appends the new blocker after authored duplicate dependency declarations', async () => {
      const original = '- [ ] Root 🆔 existing ⛔ first, first, second\n';
      const h = await harness(adapter, original, original);
      expect(
        (
          await h.repository.createDependencySubtask({
            ...h.request,
            text: 'Child',
            addCreatedDate: false,
          })
        ).type,
      ).toBe('committed');
      expect(await h.read()).toBe(
        '- [ ] Root 🆔 existing ⛔ first, first, second, child_id\n  - [ ] Child 🆔 child_id\n',
      );
    });

    it('fails closed before mutation when a fresh parser cannot prove the child', async () => {
      const h = await harness(adapter);
      const parseSnapshot = h.index.snapshotsFromContent.bind(h.index);
      vi.spyOn(h.index, 'snapshotsFromContent').mockImplementation((filePath, content) =>
        parseSnapshot(filePath, content).map((root) =>
          content.includes('🆔 child_id') ? { ...root, subtasks: [] } : root,
        ),
      );
      expect((await h.repository.createDependencySubtask(h.request)).type).toBe('invalid');
      expect(await h.read()).toBe(source);
    });

    it.each(['blocked-by', 'blocks'] as const)(
      'commits fresh child and %s edge under root and nested current',
      async (direction) => {
        for (const nested of [false, true]) {
          const h = await harness(adapter);
          const process = vi.spyOn(h.app.vault, 'process');
          const result = await h.repository.createDependencySubtask({
            ...h.request,
            direction,
            baseTarget: nested
              ? { type: 'subtask', ref: expectDefined(h.root.subtasks[0]).ref }
              : h.request.baseTarget,
          });
          expect(result).toMatchObject({
            type: 'committed',
            changed: true,
            outcome: {
              type: 'dependency-subtask',
              change: 'created',
              direction,
              dependencyId: direction === 'blocks' ? 'current_id' : 'child_id',
            },
          });
          const { current, child } = linkedOutcome(result);
          const indexed = expectDefined(h.index.list({ filePath: path })[0]);
          expect(current.root).toEqual(indexed);
          expect(child.root).toEqual(indexed);
          expect(indexed.ref.revision).not.toBe(h.root.ref.revision);
          const nodes = enumerateTaskNodes([indexed]);
          const currentNode = expectDefined(
            nodes.find((node) => sameTaskNodeRef(node.target, current.target)),
          );
          const childNode = expectDefined(
            nodes.find((node) => sameTaskNodeRef(node.target, child.target)),
          );
          expect(childNode.node.title).toBe('Created');
          expect(childNode.node.tags).toContain('#tag');
          expect(childNode.node.planning.created).toBe('2026-09-06');
          expect(child.target.type).toBe('subtask');
          expect(childNode.path[childNode.path.length - 1]?.ref.parent).toEqual(current.target);
          expect(currentNode.node.subtasks[currentNode.node.subtasks.length - 1]?.ref).toEqual(
            child.target.ref,
          );
          const blocker = direction === 'blocks' ? currentNode : childNode;
          const dependent = direction === 'blocks' ? childNode : currentNode;
          expect(dependent.node.dependsOn).toEqual([blocker.node.dependencyId]);
          expect(await h.read()).toContain('  - [ ] Sibling\n');
          if (adapter === 'obsidian') expect(process).toHaveBeenCalledOnce();
        }
      },
    );

    it.each(['New 🆔 custom', 'New ⛔ external', 'New\n- [ ] extra', ''])(
      'rejects authored input %j without changing bytes',
      async (text) => {
        const h = await harness(adapter);
        expect((await h.repository.createDependencySubtask({ ...h.request, text })).type).toBe(
          'invalid',
        );
        expect(await h.read()).toBe(source);
        expect(h.index.list({ filePath: path })[0]).toEqual(h.root);
      },
    );

    it('rejects stale root content without creating either child or edge', async () => {
      const changed = source.replace('Root', 'Manually changed');
      const h = await harness(adapter, changed);
      expect((await h.repository.createDependencySubtask(h.request)).type).not.toBe('committed');
      expect(await h.read()).toBe(changed);
    });

    it('rejects a forged nested ref even when the root revision is current', async () => {
      const h = await harness(adapter);
      const child = expectDefined(h.root.subtasks[0]);
      const result = await h.repository.createDependencySubtask({
        ...h.request,
        baseTarget: { type: 'subtask', ref: { ...child.ref, originalBlock: '  - [ ] impostor' } },
      });
      expect(result.type).toBe('conflict');
      expect(await h.read()).toBe(source);
    });
  });
}

it('restores authority and original bytes after a rejected process observes its candidate', async () => {
  const h = await harness('obsidian');
  vi.spyOn(h.app.vault, 'process').mockImplementationOnce(async (file, transform) => {
    const candidate = transform(await h.app.vault.read(file));
    expect(candidate).toContain('🆔 child_id');
    expect(candidate).toContain('⛔ child_id');
    h.index.installCommittedContent(path, candidate);
    throw new Error('processor rejected');
  });
  expect(await h.repository.createDependencySubtask(h.request)).toMatchObject({
    type: 'io-error',
    contentState: 'unknown',
  });
  expect(await h.read()).toBe(source);
  expect(h.index.list({ filePath: path })[0]).toEqual(h.root);
  expect(h.index.authoritySuccessor(h.root.ref)).toBeUndefined();
});
