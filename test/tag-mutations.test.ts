import { TFile } from 'obsidian';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { toStatusRules } from '../src/settings/statusCatalogAdapter';
import type { TaskApplicationApi } from '../src/tasks';
import { TaskApplicationService } from '../src/tasks/application/TaskApplicationService';
import { StatusCatalog } from '../src/tasks/domain/StatusCatalog';
import type { TaskRef, TaskSnapshot } from '../src/tasks/domain/types';
import { localDate } from '../src/tasks/domain/validation';
import { TaskIndex } from '../src/tasks/infrastructure/TaskIndex';
import { TaskBlockEditor } from '../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { TaskLocator } from '../src/tasks/infrastructure/markdown/TaskLocator';
import { TaskMarkdownCodec } from '../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { ObsidianTaskRepository } from '../src/tasks/infrastructure/obsidian/ObsidianTaskRepository';
import { createAppWithFiles, expectDefined, taskQueryApi } from './helpers';
import { InMemoryTaskRepository } from './support/InMemoryTaskRepository';

type Adapter = 'in-memory' | 'obsidian';

interface Harness {
  readonly tasks: TaskApplicationApi;
  readonly snapshots: (content: string) => readonly TaskSnapshot[];
  readonly read: () => Promise<string>;
}

async function makeHarness(adapter: Adapter, source: string): Promise<Harness> {
  const path = 'tasks.md';
  const app = await createAppWithFiles({ [path]: source });
  const statusCatalog = new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses));
  const codec = new TaskMarkdownCodec(statusCatalog);
  const index = new TaskIndex(app, {
    statusCatalog,
    dailyNoteFormat: DEFAULT_SETTINGS.desktop.dailyNoteFormat,
  });
  const snapshots = (content: string) => index.snapshotsFromContent(path, content);
  const repository =
    adapter === 'in-memory'
      ? new InMemoryTaskRepository({
          files: { [path]: source },
          codec,
          snapshotsFromContent: (_path, content) => snapshots(content),
        })
      : new ObsidianTaskRepository(app, {
          codec,
          editor: new TaskBlockEditor(),
          locator: new TaskLocator(),
          snapshotsFromContent: (_path, content) => snapshots(content),
        });
  const queries: TaskApplicationApi['queries'] = taskQueryApi({
    list: () => snapshots(source),
    resolve: (ref) => {
      const current = snapshots(source);
      const exact = current.find(
        (task) =>
          task.ref.filePath === ref.filePath &&
          task.ref.line === ref.line &&
          task.ref.revision === ref.revision,
      );
      if (exact != null) return { type: 'exact', task: exact, basis: { observed: exact } };
      const candidates = current.filter((task) => task.ref.revision === ref.revision);
      return candidates.length > 1
        ? {
            type: 'ambiguous',
            ref,
            candidates: candidates.map((root) => ({
              root,
              target: { type: 'task' as const, ref: root.ref },
            })),
          }
        : { type: 'not-found', ref };
    },
  });
  return {
    tasks: new TaskApplicationService(queries, repository, statusCatalog, {
      today: () => localDate('2026-07-14'),
    }),
    snapshots,
    read:
      adapter === 'in-memory'
        ? async () => (repository as InMemoryTaskRepository).content(path) ?? ''
        : async () => {
            const file = app.vault.getAbstractFileByPath(path);
            return file instanceof TFile ? app.vault.cachedRead(file) : '';
          },
  };
}

function rootTarget(
  harness: Harness,
  source: string,
  index = 0,
): { readonly type: 'task'; readonly ref: TaskRef } {
  const task = harness.snapshots(source)[index];
  if (task == null) throw new Error(`missing task ${index}`);
  return { type: 'task', ref: task.ref };
}

for (const adapter of ['in-memory', 'obsidian'] as const) {
  describe(`${adapter} atomic tag mutation contract`, () => {
    it('adds and removes normalized nested tags in one lossless revision', async () => {
      const source = '- [ ] task `#inline` #first #remove 🆔 keep-id ⛔ dep-a, dep-b ^block\r\n';
      const h = await makeHarness(adapter, source);

      const result = await h.tasks.execute({
        type: 'patch',
        target: rootTarget(h, source),
        patch: {
          tags: {
            add: ['new', '#first', 'deep/nested', '#new'],
            remove: ['remove'],
          },
        },
      });

      expect(result).toMatchObject({
        type: 'ok',
        changed: true,
        outcome: {
          type: 'task',
          task: { tags: ['#first', '#new', '#deep/nested'] },
        },
      });
      expect(await h.read()).toBe(
        '- [ ] task `#inline` #first #new #deep/nested 🆔 keep-id ⛔ dep-a, dep-b ^block\r\n',
      );
    });

    it('lets removal win and reports a byte-identical no-op', async () => {
      const source = '- [ ] task #keep\n';
      const h = await makeHarness(adapter, source);

      const result = await h.tasks.execute({
        type: 'patch',
        target: rootTarget(h, source),
        patch: {
          tags: {
            add: ['keep', 'gone', 'keep'],
            remove: ['gone', 'missing'],
          },
        },
      });

      expect(result).toMatchObject({ type: 'ok', changed: false });
      expect(await h.read()).toBe(source);
    });

    it('edits an exactly referenced nested child and returns a fresh root aggregate', async () => {
      const source = '- [ ] root #root\n  - [ ] child `#inline` #old\n    - [ ] nested #keep\n';
      const h = await makeHarness(adapter, source);
      const child = expectDefined(expectDefined(h.snapshots(source)[0]).subtasks[0]);

      const result = await h.tasks.execute({
        type: 'patch',
        target: { type: 'subtask', ref: child.ref },
        patch: { tags: { add: ['child/new'], remove: ['old'] } },
      });

      expect(result).toMatchObject({
        type: 'ok',
        changed: true,
        outcome: {
          type: 'task',
          task: {
            tags: ['#root'],
            subtasks: [{ tags: ['#child/new'], subtasks: [{ tags: ['#keep'] }] }],
          },
        },
      });
      expect(await h.read()).toBe(
        '- [ ] root #root\n  - [ ] child `#inline` #child/new\n    - [ ] nested #keep\n',
      );
    });

    it('preserves a tag lookalike inside a code span containing a different backtick run', async () => {
      const source = '- [ ] task `code `` #inline ` #real\n';
      const h = await makeHarness(adapter, source);

      await h.tasks.execute({
        type: 'patch',
        target: rootTarget(h, source),
        patch: { tags: { add: ['new'], remove: ['inline'] } },
      });

      expect(await h.read()).toBe('- [ ] task `code `` #inline ` #real #new\n');
    });

    it('treats an exact closer preceded by a backslash as the end of inline code', async () => {
      const source = '- [ ] task `code #inline \\` #real\n';
      const h = await makeHarness(adapter, source);

      const result = await h.tasks.execute({
        type: 'patch',
        target: rootTarget(h, source),
        patch: { tags: { remove: ['real'] } },
      });

      expect(result).toMatchObject({
        type: 'ok',
        changed: true,
        outcome: { type: 'task', task: { tags: [] } },
      });
      expect(await h.read()).toBe('- [ ] task `code #inline \\`\n');
    });

    it('uses the exact backslash-preceded closer for a nested task too', async () => {
      const source = '- [ ] root\n  - [ ] child `code #inline \\` #real\n';
      const h = await makeHarness(adapter, source);
      const child = h.snapshots(source)[0]?.subtasks[0];
      if (child == null) throw new Error('missing child');

      const result = await h.tasks.execute({
        type: 'patch',
        target: { type: 'subtask', ref: child.ref },
        patch: { tags: { remove: ['real'] } },
      });

      expect(result).toMatchObject({
        type: 'ok',
        changed: true,
        outcome: { type: 'task', task: { subtasks: [{ tags: [] }] } },
      });
      expect(await h.read()).toBe('- [ ] root\n  - [ ] child `code #inline \\`\n');
    });

    it('inserts a new tag after inline metadata lookalikes', async () => {
      const source = '- [ ] task `#inline 🔮 🆔 fake ⛔ dep 🔁 every week 📅 2026-07-14`\n';
      const h = await makeHarness(adapter, source);

      const result = await h.tasks.execute({
        type: 'patch',
        target: rootTarget(h, source),
        patch: { tags: { add: ['new'] } },
      });

      expect(result).toMatchObject({
        type: 'ok',
        changed: true,
        outcome: { type: 'task', task: { tags: ['#new'] } },
      });
      if (result.type !== 'ok' || result.outcome.type !== 'task') {
        throw new Error('missing task outcome');
      }
      expect(result.outcome.task.planning).toEqual({});
      expect(result.outcome.task.recurrence).toBeUndefined();
      expect(await h.read()).toBe(
        '- [ ] task `#inline 🔮 🆔 fake ⛔ dep 🔁 every week 📅 2026-07-14` #new\n',
      );
    });

    it('does not duplicate a stale tag intent without repository rebase proof', async () => {
      const source = '- [ ] task\n';
      const h = await makeHarness(adapter, source);
      const target = rootTarget(h, source);
      const command = {
        type: 'patch' as const,
        target,
        patch: { tags: { add: ['raced'] } },
      };

      const results = [await h.tasks.execute(command), await h.tasks.execute(command)];

      expect(results.filter((result) => result.type === 'ok')).toHaveLength(1);
      expect(results.filter((result) => result.type === 'conflict')).toHaveLength(0);
      expect(results.filter((result) => result.type === 'not-found')).toHaveLength(1);
      expect((await h.read()).match(/#raced/gu)).toHaveLength(1);
    });

    it('accepts the fresh ref returned by the previous tag result before queries refresh', async () => {
      const source = '- [ ] task\n';
      const h = await makeHarness(adapter, source);
      const first = await h.tasks.execute({
        type: 'patch',
        target: rootTarget(h, source),
        patch: { tags: { add: ['first'] } },
      });
      if (first.type !== 'ok' || first.outcome.type !== 'task') {
        throw new Error('missing first tag outcome');
      }

      await expect(
        h.tasks.execute({
          type: 'patch',
          target: { type: 'task', ref: first.outcome.task.ref },
          patch: { tags: { add: ['second'] } },
        }),
      ).resolves.toMatchObject({ type: 'ok', changed: true });
      expect(await h.read()).toBe('- [ ] task #first #second\n');
    });

    it('returns every ambiguous candidate without changing either duplicate', async () => {
      const source = '- [ ] duplicate #keep\n- [ ] duplicate #keep\n';
      const h = await makeHarness(adapter, source);
      const forged = { ...rootTarget(h, source).ref, line: 9 };

      await expect(
        h.tasks.execute({
          type: 'patch',
          target: { type: 'task', ref: forged },
          patch: { tags: { add: ['new'] } },
        }),
      ).resolves.toMatchObject({
        type: 'ambiguous',
        candidates: [
          { root: { source: { line: 0 } }, target: { type: 'task' } },
          { root: { source: { line: 1 } }, target: { type: 'task' } },
        ],
      });
      expect(await h.read()).toBe(source);
    });

    it('ignores task and tag lookalikes inside fenced code', async () => {
      const source = '```md\n- [ ] fake #keep\n```\n- [ ] live #keep\n';
      const h = await makeHarness(adapter, source);
      const live = h.snapshots(source)[0];
      if (live == null) throw new Error('missing live task');

      await h.tasks.execute({
        type: 'patch',
        target: { type: 'task', ref: live.ref },
        patch: { tags: { add: ['new'], remove: ['keep'] } },
      });

      expect(await h.read()).toBe('```md\n- [ ] fake #keep\n```\n- [ ] live #new\n');
    });

    it('returns not-found for a deleted task without recreating content', async () => {
      const source = '- [ ] task\n';
      const h = await makeHarness(adapter, source);
      const missingRef: TaskRef = { ...rootTarget(h, source).ref, filePath: 'missing.md' };

      await expect(
        h.tasks.execute({
          type: 'patch',
          target: { type: 'task', ref: missingRef },
          patch: { tags: { add: ['new'] } },
        }),
      ).resolves.toMatchObject({ type: 'not-found' });
      expect(await h.read()).toBe(source);
    });
  });
}
