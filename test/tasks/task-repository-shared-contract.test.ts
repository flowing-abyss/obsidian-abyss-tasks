import { TFile } from 'obsidian';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/settings/defaults';
import { toStatusRules } from '../../src/settings/statusCatalogAdapter';
import type { TaskEditCommand, TaskRepository } from '../../src/tasks/application/TaskRepository';
import { StatusCatalog } from '../../src/tasks/domain/StatusCatalog';
import { atomDateTime } from '../../src/tasks/domain/commentTimestamp';
import type { TaskRef, TaskSnapshot } from '../../src/tasks/domain/types';
import { durationMinutes, localDate, localTime } from '../../src/tasks/domain/validation';
import { TaskIndex } from '../../src/tasks/infrastructure/TaskIndex';
import { TaskBlockEditor } from '../../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { TaskLocator } from '../../src/tasks/infrastructure/markdown/TaskLocator';
import { TaskMarkdownCodec } from '../../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { ObsidianTaskRepository } from '../../src/tasks/infrastructure/obsidian/ObsidianTaskRepository';
import { createAppWithFiles } from '../helpers';
import { InMemoryTaskRepository } from '../support/InMemoryTaskRepository';

type Adapter = 'in-memory' | 'obsidian';

interface ContractHarness {
  readonly repository: TaskRepository;
  readonly snapshots: (content: string) => readonly TaskSnapshot[];
  readonly read: () => Promise<string>;
}

async function makeHarness(adapter: Adapter, source: string): Promise<ContractHarness> {
  const path = 'tasks.md';
  const app = await createAppWithFiles({ [path]: source });
  const statusCatalog = new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses));
  const codec = new TaskMarkdownCodec(statusCatalog);
  const index = new TaskIndex(app, {
    statusCatalog,
    dailyNoteFormat: DEFAULT_SETTINGS.desktop.dailyNoteFormat,
  });
  const snapshots = (content: string) => index.snapshotsFromContent(path, content);
  if (adapter === 'in-memory') {
    const repository = new InMemoryTaskRepository({
      files: { [path]: source },
      codec,
      snapshotsFromContent: (_path, content) => snapshots(content),
    });
    return {
      repository,
      snapshots,
      read: async () => repository.content(path) ?? '',
    };
  }
  const repository = new ObsidianTaskRepository(app, {
    codec,
    editor: new TaskBlockEditor(),
    locator: new TaskLocator(),
    snapshotsFromContent: (_path, content) => snapshots(content),
  });
  return {
    repository,
    snapshots,
    read: async () => {
      const file = app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) return '';
      return app.vault.cachedRead(file);
    },
  };
}

function rootRef(harness: ContractHarness, source: string): TaskRef {
  return harness.snapshots(source)[0]!.ref;
}

for (const adapter of ['in-memory', 'obsidian'] as const) {
  describe(`${adapter} TaskRepository shared contract`, () => {
    it('edits descriptions and comments as one lossless revisioned block transaction', async () => {
      const source =
        '>\t- [ ] root #keep\r\n' +
        '>\t  - > old description\r\n' +
        '>\t  - 2026-07-13: duplicate\r\n' +
        '>\t  - 2026-07-13: duplicate\r\n' +
        '>\t  - [ ] child\r\n' +
        '>\t    - > child description\r\n' +
        '> - [ ] unrelated\r\n';
      const h = await makeHarness(adapter, source);

      let root = h.snapshots(source)[0]!;
      await expect(
        h.repository.edit({
          type: 'set-description',
          target: { type: 'task', ref: root.ref },
          text: 'first line\n\nthird line',
        }),
      ).resolves.toMatchObject({ type: 'committed', changed: true });

      let content = await h.read();
      expect(content).toBe(
        '>\t- [ ] root #keep\r\n' +
          '>\t  - > first line\r\n' +
          '>\t  - > \r\n' +
          '>\t  - > third line\r\n' +
          '>\t  - 2026-07-13: duplicate\r\n' +
          '>\t  - 2026-07-13: duplicate\r\n' +
          '>\t  - [ ] child\r\n' +
          '>\t    - > child description\r\n' +
          '> - [ ] unrelated\r\n',
      );

      root = h.snapshots(content)[0]!;
      const secondDuplicate = root.comments[1]!;
      await expect(
        h.repository.edit({
          type: 'update-comment',
          comment: secondDuplicate.ref,
          text: 'updated second',
        }),
      ).resolves.toMatchObject({ type: 'committed', changed: true });

      content = await h.read();
      root = h.snapshots(content)[0]!;
      await expect(
        h.repository.edit({ type: 'delete-comment', comment: root.comments[0]!.ref }),
      ).resolves.toMatchObject({ type: 'committed', changed: true });

      content = await h.read();
      root = h.snapshots(content)[0]!;
      await expect(
        h.repository.edit({
          type: 'add-comment',
          parent: { type: 'task', ref: root.ref },
          text: 'new comment',
          stamp: atomDateTime('2026-07-14T09:30:45+00:00'),
        }),
      ).resolves.toMatchObject({ type: 'committed', changed: true });

      expect(await h.read()).toBe(
        '>\t- [ ] root #keep\r\n' +
          '>\t  - > first line\r\n' +
          '>\t  - > \r\n' +
          '>\t  - > third line\r\n' +
          '>\t  - 2026-07-13: updated second\r\n' +
          '>\t  - [ ] child\r\n' +
          '>\t    - > child description\r\n' +
          '>\t  - 2026-07-14T09:30:45+00:00: new comment\r\n' +
          '> - [ ] unrelated\r\n',
      );
    });

    it('adds nested subtasks losslessly and returns a completely fresh root tree', async () => {
      const source =
        '>\t- [ ] root\r\n' +
        '>\t  - [ ] parent\r\n' +
        '>\t    - [ ] existing\r\n' +
        '> - [ ] unrelated';
      const h = await makeHarness(adapter, source);
      const root = h.snapshots(source)[0]!;
      const parent = root.subtasks[0]!;

      const result = await h.repository.edit({
        type: 'add-subtask',
        parent: { type: 'subtask', ref: parent.ref },
        text: 'new [[child]]',
        today: localDate('2026-07-14'),
        addCreatedDate: false,
      });

      expect(result).toMatchObject({
        type: 'committed',
        changed: true,
        outcome: {
          type: 'task',
          task: {
            subtasks: [
              {
                subtasks: [{ markdownTitle: 'existing' }, { markdownTitle: 'new [[child]]' }],
              },
            ],
          },
        },
      });
      expect(await h.read()).toBe(
        '>\t- [ ] root\r\n' +
          '>\t  - [ ] parent\r\n' +
          '>\t    - [ ] existing\r\n' +
          '>\t    - [ ] new [[child]]\r\n' +
          '> - [ ] unrelated',
      );
      if (result.type === 'committed' && result.outcome.type === 'task') {
        const freshRoot = result.outcome.task;
        const freshParent = freshRoot.subtasks[0]!;
        expect(freshParent.ref.parent).toEqual({ type: 'task', ref: freshRoot.ref });
        expect(freshParent.subtasks[1]!.ref.parent).toEqual({
          type: 'subtask',
          ref: freshParent.ref,
        });
      }
    });

    it('deletes the exact duplicate child with descendants after confirming every ancestor', async () => {
      const source =
        '- [ ] root\n' +
        '  - [ ] branch\n' +
        '    - [ ] duplicate\n' +
        '      - [ ] descendant\n' +
        '    - [ ] duplicate\n' +
        '- [ ] next\n';
      const h = await makeHarness(adapter, source);
      const root = h.snapshots(source)[0]!;
      const branch = root.subtasks[0]!;
      const firstDuplicate = branch.subtasks[0]!;
      const staleAncestorRef = {
        ...firstDuplicate.ref,
        parent: {
          type: 'subtask' as const,
          ref: {
            ...branch.ref,
            originalBlock: branch.ref.originalBlock.replace('branch', 'stale'),
          },
        },
      };

      await expect(
        h.repository.edit({ type: 'delete-subtask', subtask: staleAncestorRef }),
      ).resolves.toMatchObject({ type: 'conflict' });
      expect(await h.read()).toBe(source);

      const result = await h.repository.edit({
        type: 'delete-subtask',
        subtask: firstDuplicate.ref,
      });
      expect(result).toMatchObject({
        type: 'committed',
        changed: true,
        outcome: { type: 'task', task: { subtasks: [{ subtasks: [{ title: 'duplicate' }] }] } },
      });
      expect(await h.read()).toBe('- [ ] root\n  - [ ] branch\n    - [ ] duplicate\n- [ ] next\n');
    });

    it('reorders lossless sibling blocks and rejects cross-parent targets', async () => {
      const source =
        '- [ ] root\r\n' +
        '\t- [ ] first\r\n' +
        '\t  - [ ] first child\r\n' +
        '    - [ ] second\r\n' +
        '    - [ ] branch\r\n' +
        '      - [ ] nested target\r\n';
      const h = await makeHarness(adapter, source);
      let root = h.snapshots(source)[0]!;
      const first = root.subtasks[0]!;
      const second = root.subtasks[1]!;
      const nestedTarget = root.subtasks[2]!.subtasks[0]!;

      await expect(
        h.repository.edit({
          type: 'reorder-subtask',
          subtask: first.ref,
          target: nestedTarget.ref,
          placement: 'after',
        }),
      ).resolves.toEqual({
        type: 'invalid',
        issues: [{ code: 'invalid-target', field: 'subtask-parent' }],
      });
      expect(await h.read()).toBe(source);

      const result = await h.repository.edit({
        type: 'reorder-subtask',
        subtask: first.ref,
        target: second.ref,
        placement: 'after',
      });
      expect(result).toMatchObject({ type: 'committed', changed: true });
      expect(await h.read()).toBe(
        '- [ ] root\r\n' +
          '    - [ ] second\r\n' +
          '\t- [ ] first\r\n' +
          '\t  - [ ] first child\r\n' +
          '    - [ ] branch\r\n' +
          '      - [ ] nested target\r\n',
      );

      root = h.snapshots(await h.read())[0]!;
      expect(root.subtasks.map((child) => child.title)).toEqual(['second', 'first', 'branch']);
    });

    it('rejects forged child evidence and direct invalid subtask text without writing', async () => {
      const source = '- [ ] root\n  - [ ] child\n  - [ ] sibling\n';
      const h = await makeHarness(adapter, source);
      const root = h.snapshots(source)[0]!;
      const child = root.subtasks[0]!;

      await expect(
        h.repository.edit({
          type: 'delete-subtask',
          subtask: { ...child.ref, originalBlock: '  - [ ] forged' },
        }),
      ).resolves.toMatchObject({ type: 'conflict' });
      await expect(
        h.repository.edit({
          type: 'add-subtask',
          parent: { type: 'task', ref: root.ref },
          text: 'invalid\nchild',
          today: localDate('2026-07-14'),
          addCreatedDate: false,
        }),
      ).resolves.toEqual({
        type: 'invalid',
        issues: [{ code: 'invalid-target', field: 'subtask' }],
      });

      const beforeMissingLifecycle = await h.read();
      await expect(
        h.repository.edit({
          type: 'add-subtask',
          parent: { type: 'task', ref: root.ref },
          text: 'must not become epoch dated',
          addCreatedDate: true,
        } as unknown as TaskEditCommand),
      ).resolves.toEqual({
        type: 'invalid',
        issues: [{ code: 'invalid-target', field: 'subtask' }],
      });
      expect(await h.read()).toBe(beforeMissingLifecycle);
      expect(await h.read()).toBe(source);
    });

    it('returns an unchanged fresh root when reordering a child onto itself', async () => {
      const source = '- [ ] root\n  - [ ] child\n';
      const h = await makeHarness(adapter, source);
      const root = h.snapshots(source)[0]!;
      const child = root.subtasks[0]!;

      await expect(
        h.repository.edit({
          type: 'reorder-subtask',
          subtask: child.ref,
          target: child.ref,
          placement: 'after',
        }),
      ).resolves.toMatchObject({
        type: 'committed',
        changed: false,
        outcome: { type: 'task', task: { ref: root.ref } },
      });
      expect(await h.read()).toBe(source);
    });

    it('clears only direct descriptions and preserves no-op bytes, child descriptions, and list content', async () => {
      const source =
        '- [ ] root\n' +
        '  - > same description\n' +
        '  * ordinary list item\n' +
        '  - [ ] child\n' +
        '    - > child description\n' +
        '- [ ] next';
      const h = await makeHarness(adapter, source);
      let root = h.snapshots(source)[0]!;

      await expect(
        h.repository.edit({
          type: 'set-description',
          target: { type: 'task', ref: root.ref },
          text: 'same description',
        }),
      ).resolves.toMatchObject({ type: 'committed', changed: false });
      expect(await h.read()).toBe(source);

      root = h.snapshots(await h.read())[0]!;
      await expect(
        h.repository.edit({
          type: 'set-description',
          target: { type: 'task', ref: root.ref },
          text: null,
        }),
      ).resolves.toMatchObject({ type: 'committed', changed: true });
      expect(await h.read()).toBe(
        '- [ ] root\n' +
          '  * ordinary list item\n' +
          '  - [ ] child\n' +
          '    - > child description\n' +
          '- [ ] next',
      );
    });

    it('replaces an existing description in place without reordering unrelated lines', async () => {
      const source =
        '- [ ] root\n' +
        '  - 2026-07-13: comment before description\n' +
        '  - > old first line\n' +
        '  * ordinary list item\n' +
        '  - > old second line\n' +
        '- [ ] next\n';
      const h = await makeHarness(adapter, source);
      const root = h.snapshots(source)[0]!;

      await expect(
        h.repository.edit({
          type: 'set-description',
          target: { type: 'task', ref: root.ref },
          text: 'new first line\nnew second line',
        }),
      ).resolves.toMatchObject({ type: 'committed', changed: true });
      expect(await h.read()).toBe(
        '- [ ] root\n' +
          '  - 2026-07-13: comment before description\n' +
          '  - > new first line\n' +
          '  - > new second line\n' +
          '  * ordinary list item\n' +
          '- [ ] next\n',
      );
    });

    it('does not consume a bare comment that only looks like a malformed description', async () => {
      const source = '- [ ] root\n  - >\n- [ ] next\n';
      const h = await makeHarness(adapter, source);
      const root = h.snapshots(source)[0]!;

      await expect(
        h.repository.edit({
          type: 'set-description',
          target: { type: 'task', ref: root.ref },
          text: 'real description',
        }),
      ).resolves.toMatchObject({ type: 'committed', changed: true });
      expect(await h.read()).toBe('- [ ] root\n  - > real description\n  - >\n- [ ] next\n');
    });

    it('confirms nested parent and exact duplicate-comment evidence before changing one line', async () => {
      const source =
        '- [ ] root\n' +
        '  - [ ] child\n' +
        '    - 2026-07-13: duplicate\n' +
        '    - 2026-07-13: duplicate\n' +
        '- [ ] next\n';
      const h = await makeHarness(adapter, source);
      let root = h.snapshots(source)[0]!;
      const child = root.subtasks[0]!;
      const stale = {
        ...child.comments[1]!.ref,
        originalMarkdown: '    - 2026-07-13: stale duplicate',
      };

      await expect(
        h.repository.edit({ type: 'update-comment', comment: stale, text: 'must not write' }),
      ).resolves.toMatchObject({ type: 'conflict' });
      expect(await h.read()).toBe(source);

      await expect(
        h.repository.edit({
          type: 'update-comment',
          comment: child.comments[1]!.ref,
          text: 'second only',
        }),
      ).resolves.toMatchObject({ type: 'committed', changed: true });
      expect(await h.read()).toBe(
        '- [ ] root\n' +
          '  - [ ] child\n' +
          '    - 2026-07-13: duplicate\n' +
          '    - 2026-07-13: second only\n' +
          '- [ ] next\n',
      );

      const changed = await h.read();
      root = h.snapshots(changed)[0]!;
      await expect(
        h.repository.edit({
          type: 'delete-comment',
          comment: { ...root.subtasks[0]!.comments[0]!.ref, relativeLine: 99 },
        }),
      ).resolves.toMatchObject({ type: 'conflict' });
      expect(await h.read()).toBe(changed);
    });

    it('rejects a forged comment ref that points at a description or subtask line', async () => {
      const source = '- [ ] root\n  - > description\n  - [ ] child\n';
      const h = await makeHarness(adapter, source);
      const root = h.snapshots(source)[0]!;

      for (const [relativeLine, originalMarkdown] of [
        [1, '  - > description'],
        [2, '  - [ ] child'],
      ] as const) {
        await expect(
          h.repository.edit({
            type: 'delete-comment',
            comment: {
              parent: { type: 'task', ref: root.ref },
              relativeLine,
              originalMarkdown,
            },
          }),
        ).resolves.toMatchObject({ type: 'conflict' });
        expect(await h.read()).toBe(source);
      }
    });

    it('returns rebased comment targets when an exact root revision is ambiguous', async () => {
      const block = '- [ ] duplicate\n  - 2026-07-13: note';
      const source = `${block}\n${block}\n`;
      const h = await makeHarness(adapter, source);
      const observed = h.snapshots(source)[0]!;
      const result = await h.repository.edit({
        type: 'delete-comment',
        comment: {
          ...observed.comments[0]!.ref,
          parent: {
            type: 'task',
            ref: { ...observed.ref, line: 99 },
          },
        },
      });

      expect(result).toMatchObject({
        type: 'ambiguous',
        candidates: [
          { root: { source: { line: 0 } }, target: { type: 'comment' } },
          { root: { source: { line: 2 } }, target: { type: 'comment' } },
        ],
      });
      expect(await h.read()).toBe(source);
    });

    it('submits the full snapshot title through the repository contract exactly once', async () => {
      const source =
        '> - [ ] Old [[Root]] 🧭 future #tag 📅 nope 🆔 bad.id 🆔 keep-id ⛔ dep ^block\r\n>   - [ ] Old [[Child]] #child custom\r\n';
      const h = await makeHarness(adapter, source);
      const root = h.snapshots(source)[0]!;
      const editedTitle = `${root.markdownTitle} TEMP`;
      expect(root.markdownTitle).toBe('Old [[Root]] 🧭 future');
      await expect(
        h.repository.edit({
          type: 'patch',
          target: { type: 'task', ref: root.ref },
          patch: { markdownTitle: { type: 'set', value: editedTitle } },
        }),
      ).resolves.toMatchObject({ type: 'committed', changed: true });
      expect(await h.read()).toBe(
        '> - [ ] Old [[Root]] 🧭 future TEMP #tag 📅 nope 🆔 bad.id 🆔 keep-id ⛔ dep ^block\r\n>   - [ ] Old [[Child]] #child custom\r\n',
      );

      const changed = await h.read();
      const child = h.snapshots(changed)[0]!.subtasks[0]!;
      await expect(
        h.repository.edit({
          type: 'append-title',
          target: { type: 'subtask', ref: child.ref },
          markdown: '[[attachment.png|image]]',
        }),
      ).resolves.toMatchObject({ type: 'committed', changed: true });
      expect(await h.read()).toContain(
        '>   - [ ] Old [[Child]] #child custom [[attachment.png|image]]\r\n',
      );
    });

    it.each([
      ['inline code', '- [ ] Old `x ^bad`\r\n'],
      ['wiki alias', '- [ ] Old [[Doc|x ^bad]]\r\n'],
      ['Markdown link', '- [ ] Old [x ^bad](https://example.test)\r\n'],
    ])('replaces a terminal caret-bearing %s as one semantic title', async (_case, source) => {
      const h = await makeHarness(adapter, source);
      const root = h.snapshots(source)[0]!;

      expect(root.markdownTitle).toBe(source.slice('- [ ] '.length, -2));
      await expect(
        h.repository.edit({
          type: 'patch',
          target: { type: 'task', ref: root.ref },
          patch: { markdownTitle: { type: 'set', value: 'New' } },
        }),
      ).resolves.toMatchObject({ type: 'committed', changed: true });
      expect(await h.read()).toBe('- [ ] New\r\n');
    });

    it.each([
      '^bad[[Doc]]',
      '^bad[x](u)',
      '^bad`code`',
      '^bad[[Doc|x y]]',
      '^bad[x y](u)',
      '^bad`x y`',
      '^bad[x y]([[Doc]])',
      '^📅[x](u)',
    ])(
      'preserves the complete malformed terminal token %s through repository title edits',
      async (terminal) => {
        const source = `- [ ] Old ${terminal}\r\n`;
        const h = await makeHarness(adapter, source);
        const root = h.snapshots(source)[0]!;

        expect(root.markdownTitle).toBe('Old');
        await expect(
          h.repository.edit({
            type: 'patch',
            target: { type: 'task', ref: root.ref },
            patch: { markdownTitle: { type: 'set', value: 'New' } },
          }),
        ).resolves.toMatchObject({ type: 'committed', changed: true });
        expect(await h.read()).toBe(`- [ ] New ${terminal}\r\n`);

        const changed = await h.read();
        const reparsed = h.snapshots(changed)[0]!;
        await expect(
          h.repository.edit({
            type: 'patch',
            target: { type: 'task', ref: reparsed.ref },
            patch: { markdownTitle: { type: 'set', value: 'New' } },
          }),
        ).resolves.toMatchObject({ type: 'committed', changed: false });
        expect(await h.read()).toBe(changed);
      },
    );

    it('edits links only inside the confirmed title, description, or revisioned comment target', async () => {
      const source =
        '- [ ] [[TitleA|same]] and [[TitleB|same]] #tag 🆔 keep ⛔ dep ^block\r\n' +
        '  - > desc [[DescA|same]] and [[DescB|same]]\r\n' +
        '  - 2026-07-14: comment [[CommentA|same]] and [[CommentB|same]]\r\n';
      const h = await makeHarness(adapter, source);

      let root = h.snapshots(source)[0]!;
      await expect(
        h.repository.edit({
          type: 'edit-link',
          target: { type: 'title', target: { type: 'task', ref: root.ref } },
          occurrence: 1,
          replacement: '[[TitleChanged|updated]]',
        }),
      ).resolves.toMatchObject({ type: 'committed', changed: true });

      let content = await h.read();
      root = h.snapshots(content)[0]!;
      await expect(
        h.repository.edit({
          type: 'edit-link',
          target: { type: 'description', target: { type: 'task', ref: root.ref } },
          occurrence: 1,
          replacement: '[updated](https://description.test)',
        }),
      ).resolves.toMatchObject({ type: 'committed', changed: true });

      content = await h.read();
      root = h.snapshots(content)[0]!;
      await expect(
        h.repository.edit({
          type: 'edit-link',
          target: { type: 'comment', ref: root.comments[0]!.ref },
          occurrence: 1,
          replacement: '[[CommentChanged]]',
        }),
      ).resolves.toMatchObject({ type: 'committed', changed: true });

      expect(await h.read()).toBe(
        '- [ ] [[TitleA|same]] and [[TitleChanged|updated]] #tag 🆔 keep ⛔ dep ^block\r\n' +
          '  - > desc [[DescA|same]] and [updated](https://description.test)\r\n' +
          '  - 2026-07-14: comment [[CommentA|same]] and [[CommentChanged]]\r\n',
      );
    });

    it('ignores inline-code lookalikes when editing root and nested text targets', async () => {
      const source =
        '- [ ] `[[Same]]` [[Same]]\r\n' +
        '  - > desc `[Same](Same)` [Same](Same)\r\n' +
        '  - 2026-07-14: comment `[[Same]]` [[Same]]\r\n' +
        '  - [ ] child `[[Same]]` [[Same]]\r\n';
      const h = await makeHarness(adapter, source);

      let root = h.snapshots(source)[0]!;
      await expect(
        h.repository.edit({
          type: 'edit-link',
          target: { type: 'title', target: { type: 'task', ref: root.ref } },
          occurrence: 0,
          replacement: '[[RootChanged]]',
        }),
      ).resolves.toMatchObject({ type: 'committed', changed: true });

      let content = await h.read();
      root = h.snapshots(content)[0]!;
      await expect(
        h.repository.edit({
          type: 'edit-link',
          target: { type: 'description', target: { type: 'task', ref: root.ref } },
          occurrence: 0,
          replacement: '[DescriptionChanged](DescriptionChanged)',
        }),
      ).resolves.toMatchObject({ type: 'committed', changed: true });

      content = await h.read();
      root = h.snapshots(content)[0]!;
      await expect(
        h.repository.edit({
          type: 'edit-link',
          target: { type: 'comment', ref: root.comments[0]!.ref },
          occurrence: 0,
          replacement: '[[CommentChanged]]',
        }),
      ).resolves.toMatchObject({ type: 'committed', changed: true });

      content = await h.read();
      root = h.snapshots(content)[0]!;
      await expect(
        h.repository.edit({
          type: 'edit-link',
          target: { type: 'title', target: { type: 'subtask', ref: root.subtasks[0]!.ref } },
          occurrence: 0,
          replacement: '[[ChildChanged]]',
        }),
      ).resolves.toMatchObject({ type: 'committed', changed: true });

      expect(await h.read()).toBe(
        '- [ ] `[[Same]]` [[RootChanged]]\r\n' +
          '  - > desc `[Same](Same)` [DescriptionChanged](DescriptionChanged)\r\n' +
          '  - 2026-07-14: comment `[[Same]]` [[CommentChanged]]\r\n' +
          '  - [ ] child `[[Same]]` [[ChildChanged]]\r\n',
      );
    });

    it('rejects stale comments and absent target-scoped occurrences without changing bytes', async () => {
      const source = '- [ ] root [[Title]]\n  - 2026-07-14: comment [[Comment]]\n';
      const h = await makeHarness(adapter, source);
      const root = h.snapshots(source)[0]!;

      await expect(
        h.repository.edit({
          type: 'edit-link',
          target: {
            type: 'comment',
            ref: { ...root.comments[0]!.ref, originalMarkdown: '  - stale [[Comment]]' },
          },
          occurrence: 0,
          replacement: '[[Changed]]',
        }),
      ).resolves.toMatchObject({ type: 'conflict' });
      await expect(
        h.repository.edit({
          type: 'edit-link',
          target: { type: 'title', target: { type: 'task', ref: root.ref } },
          occurrence: 1,
          replacement: '[[Changed]]',
        }),
      ).resolves.toEqual({
        type: 'invalid',
        issues: [{ code: 'invalid-target', field: 'link' }],
      });
      expect(await h.read()).toBe(source);
    });

    it('rejects multiline title and link inputs without changing bytes', async () => {
      const source =
        '- [ ] root [[Title]]\r\n' +
        '  - > desc [[Description]]\r\n' +
        '  - 2026-07-14: comment [[Comment]]\r\n';
      const h = await makeHarness(adapter, source);

      const commands = () => {
        const root = h.snapshots(source)[0]!;
        return [
          {
            type: 'patch' as const,
            target: { type: 'task' as const, ref: root.ref },
            patch: { markdownTitle: { type: 'set' as const, value: 'changed\n- [ ] injected' } },
          },
          {
            type: 'append-title' as const,
            target: { type: 'task' as const, ref: root.ref },
            markdown: 'later\rinjected',
          },
          {
            type: 'edit-link' as const,
            target: { type: 'title' as const, target: { type: 'task' as const, ref: root.ref } },
            occurrence: 0,
            replacement: '[[Changed]]\n- [ ] injected',
          },
          {
            type: 'edit-link' as const,
            target: {
              type: 'description' as const,
              target: { type: 'task' as const, ref: root.ref },
            },
            occurrence: 0,
            replacement: '[[Changed]]\rinjected',
          },
          {
            type: 'edit-link' as const,
            target: { type: 'comment' as const, ref: root.comments[0]!.ref },
            occurrence: 0,
            replacement: '[[Changed]]\n- injected',
          },
        ];
      };

      for (const command of commands()) {
        await expect(h.repository.edit(command)).resolves.toMatchObject({
          type: 'invalid',
          issues: [{ code: 'invalid-target' }],
        });
        expect(await h.read()).toBe(source);
      }
    });

    it('rebases an ambiguous revisioned comment target onto every candidate root', async () => {
      const block = '- [ ] duplicate\n  - comment [[Link]]';
      const source = `${block}\n${block}\n`;
      const h = await makeHarness(adapter, source);
      const revision = h.snapshots(source)[0]!.ref.revision;
      const parentRef = { filePath: 'tasks.md', line: 9, revision };
      const result = await h.repository.edit({
        type: 'edit-link',
        target: {
          type: 'comment',
          ref: {
            parent: { type: 'task', ref: parentRef },
            relativeLine: 1,
            originalMarkdown: '  - comment [[Link]]',
          },
        },
        occurrence: 0,
        replacement: '[[Changed]]',
      });

      expect(result).toMatchObject({
        type: 'ambiguous',
        candidates: [
          { target: { type: 'comment', ref: { parent: { ref: { line: 0 } } } } },
          { target: { type: 'comment', ref: { parent: { ref: { line: 2 } } } } },
        ],
      });
      expect(await h.read()).toBe(source);
    });

    it('applies status stamps and reopening losslessly', async () => {
      const source = '- [ ] task 🆔 keep-id ⛔ dep ^block\r\n';
      const h = await makeHarness(adapter, source);
      await expect(
        h.repository.edit({
          type: 'set-status',
          target: { type: 'task', ref: rootRef(h, source) },
          symbol: 'x',
          stamp: localDate('2026-07-14'),
        }),
      ).resolves.toMatchObject({ type: 'committed', changed: true });
      expect(await h.read()).toBe('- [x] task 🆔 keep-id ⛔ dep ✅ 2026-07-14 ^block\r\n');

      const changed = await h.read();
      await h.repository.edit({
        type: 'set-status',
        target: { type: 'task', ref: rootRef(h, changed) },
        symbol: ' ',
      });
      expect(await h.read()).toBe(source);
    });

    it.each([
      ['A', '🔺'],
      ['B', '⏫'],
      ['C', '🔼'],
      ['D', ''],
      ['E', '🔽'],
      ['F', '⏬'],
    ] as const)(
      'applies priority %s without touching unrelated spans',
      async (priority, marker) => {
        const source = '- [ ] task #tag 🆔 keep-id ⛔ dep ^block\n';
        const h = await makeHarness(adapter, source);
        await expect(
          h.repository.edit({
            type: 'patch',
            target: { type: 'task', ref: rootRef(h, source) },
            patch: { priority: { type: 'set', value: priority } },
          }),
        ).resolves.toMatchObject({
          type: 'committed',
          changed: priority !== 'D',
        });
        const content = await h.read();
        expect(content).toContain('#tag');
        expect(content).toContain('🆔 keep-id ⛔ dep');
        expect(content).toContain('^block');
        if (marker) expect(content).toContain(marker);
      },
    );

    it('applies status and priority to an exactly referenced nested task', async () => {
      const source = '- [ ] root\n  - [ ] child\n    - [ ] nested\n';
      const h = await makeHarness(adapter, source);
      const nested = h.snapshots(source)[0]!.subtasks[0]!.subtasks[0]!;
      await h.repository.edit({
        type: 'set-status',
        target: { type: 'subtask', ref: nested.ref },
        symbol: 'x',
        stamp: localDate('2026-07-14'),
      });
      const changed = await h.read();
      const changedNested = h.snapshots(changed)[0]!.subtasks[0]!.subtasks[0]!;
      await h.repository.edit({
        type: 'patch',
        target: { type: 'subtask', ref: changedNested.ref },
        patch: { priority: { type: 'set', value: 'F' } },
      });
      expect(await h.read()).toContain('    - [x] nested ⏬ ✅ 2026-07-14');

      const prioritized = await h.read();
      const prioritizedNested = h.snapshots(prioritized)[0]!.subtasks[0]!.subtasks[0]!;
      await h.repository.edit({
        type: 'set-status',
        target: { type: 'subtask', ref: prioritizedNested.ref },
        symbol: '-',
        stamp: localDate('2026-07-15'),
      });
      expect(await h.read()).toContain('    - [-] nested ⏬ ❌ 2026-07-15');
      expect(await h.read()).not.toContain('✅ 2026-07-14');

      const cancelled = await h.read();
      const cancelledNested = h.snapshots(cancelled)[0]!.subtasks[0]!.subtasks[0]!;
      await h.repository.edit({
        type: 'set-status',
        target: { type: 'subtask', ref: cancelledNested.ref },
        symbol: ' ',
      });
      expect(await h.read()).toContain('    - [ ] nested ⏬');
      expect(await h.read()).not.toMatch(/[✅❌]/u);
    });

    it('returns a detached no-op success', async () => {
      const source = '- [ ] task 📅 2026-07-20\n';
      const h = await makeHarness(adapter, source);
      const result = await h.repository.edit({
        type: 'patch',
        target: { type: 'task', ref: rootRef(h, source) },
        patch: { due: { type: 'set', value: localDate('2026-07-20') } },
      });
      expect(result).toMatchObject({ type: 'committed', changed: false });
      expect(await h.read()).toBe(source);
      if (result.type === 'committed' && result.outcome.type === 'task') {
        (result.outcome.task.planning as { due?: string }).due = '1900-01-01';
      }
      expect(h.snapshots(await h.read())[0]!.planning.due).toBe('2026-07-20');
    });

    it('uses scheduled-before-due reschedule semantics', async () => {
      const source = '- [ ] task ⏳ 2026-07-10 📅 2026-07-20\n';
      const h = await makeHarness(adapter, source);
      await h.repository.edit({
        type: 'reschedule',
        ref: rootRef(h, source),
        date: localDate('2026-07-11'),
      });
      expect(await h.read()).toContain('⏳ 2026-07-11 📅 2026-07-20');
    });

    it('returns invalid without changing an inverted span', async () => {
      const source = '- [ ] task 🛫 2026-07-10 📅 2026-07-20\n';
      const h = await makeHarness(adapter, source);
      await expect(
        h.repository.edit({
          type: 'patch',
          target: { type: 'task', ref: rootRef(h, source) },
          patch: { start: { type: 'set', value: localDate('2026-07-21') } },
        }),
      ).resolves.toMatchObject({ type: 'invalid' });
      expect(await h.read()).toBe(source);
    });

    it('applies valid multi-field and clear/set span patches atomically', async () => {
      const forward = '- [ ] task 🛫 2026-07-01 📅 2026-07-10\n';
      const forwardHarness = await makeHarness(adapter, forward);
      await expect(
        forwardHarness.repository.edit({
          type: 'patch',
          target: { type: 'task', ref: rootRef(forwardHarness, forward) },
          patch: {
            start: { type: 'set', value: localDate('2026-07-20') },
            due: { type: 'set', value: localDate('2026-07-30') },
          },
        }),
      ).resolves.toMatchObject({ type: 'committed', changed: true });
      expect(await forwardHarness.read()).toContain('🛫 2026-07-20 📅 2026-07-30');

      const clearStart = '- [ ] task 🛫 2026-07-10 📅 2026-07-20\n';
      const clearStartHarness = await makeHarness(adapter, clearStart);
      await expect(
        clearStartHarness.repository.edit({
          type: 'patch',
          target: { type: 'task', ref: rootRef(clearStartHarness, clearStart) },
          patch: {
            start: { type: 'clear' },
            due: { type: 'set', value: localDate('2026-07-05') },
          },
        }),
      ).resolves.toMatchObject({ type: 'committed', changed: true });
      expect(await clearStartHarness.read()).toContain('📅 2026-07-05');
      expect(await clearStartHarness.read()).not.toContain('🛫');

      const clearDue = '- [ ] task 🛫 2026-07-10 📅 2026-07-20\n';
      const clearDueHarness = await makeHarness(adapter, clearDue);
      await expect(
        clearDueHarness.repository.edit({
          type: 'patch',
          target: { type: 'task', ref: rootRef(clearDueHarness, clearDue) },
          patch: {
            start: { type: 'set', value: localDate('2026-07-30') },
            due: { type: 'clear' },
          },
        }),
      ).resolves.toMatchObject({ type: 'committed', changed: true });
      expect(await clearDueHarness.read()).toContain('🛫 2026-07-30');
      expect(await clearDueHarness.read()).not.toContain('📅');
    });

    it('rejects a stale child exact block without same-line adoption', async () => {
      const source = '- [ ] root\n  - [ ] child\n';
      const h = await makeHarness(adapter, source);
      const root = h.snapshots(source)[0]!;
      const child = root.subtasks[0]!;
      await expect(
        h.repository.edit({
          type: 'patch',
          target: {
            type: 'subtask',
            ref: { ...child.ref, originalBlock: '  - [ ] replacement' },
          },
          patch: { due: { type: 'set', value: localDate('2026-07-20') } },
        }),
      ).resolves.toMatchObject({ type: 'conflict' });
      expect(await h.read()).toBe(source);
    });

    it('sets and clears independent time and duration fields losslessly', async () => {
      const source = '- [ ] task custom 🆔 keep-id ⛔ dep ^block\r\n';
      const h = await makeHarness(adapter, source);
      const ref = rootRef(h, source);
      const set = await h.repository.edit({
        type: 'patch',
        target: { type: 'task', ref },
        patch: {
          time: { type: 'set', value: localTime('09:30') },
          duration: { type: 'set', value: durationMinutes(90) },
        },
      });
      expect(set).toMatchObject({
        type: 'committed',
        changed: true,
        outcome: { type: 'task', task: { planning: { time: '09:30', duration: 90 } } },
      });
      expect(await h.read()).toBe(
        '- [ ] task custom 🆔 keep-id ⛔ dep ⏰ 09:30 ⏱️ 1h30m ^block\r\n',
      );

      const changed = await h.read();
      const cleared = await h.repository.edit({
        type: 'patch',
        target: { type: 'task', ref: rootRef(h, changed) },
        patch: { time: { type: 'clear' }, duration: { type: 'clear' } },
      });
      expect(cleared).toMatchObject({ type: 'committed', changed: true });
      expect(await h.read()).toBe(source);
    });

    it('sets a time slot atomically and preserves duration when omitted', async () => {
      const source = '- [ ] task ⏳ 2026-07-10 ⏰ 08:00 ⏱️ 2h custom\n';
      const h = await makeHarness(adapter, source);
      const result = await h.repository.edit({
        type: 'set-time-slot',
        ref: rootRef(h, source),
        date: localDate('2026-07-11'),
        time: localTime('09:30'),
      });
      expect(result).toMatchObject({
        type: 'committed',
        changed: true,
        outcome: {
          type: 'task',
          task: { planning: { scheduled: '2026-07-11', time: '09:30', duration: 120 } },
        },
      });
      expect(await h.read()).toContain('⏳ 2026-07-11 ⏰ 09:30 ⏱️ 2h custom');
    });

    it('sets an explicit slot duration in the same transaction', async () => {
      const source = '- [ ] task 📅 2026-07-10 ⏰ 08:00 ⏱️ 2h\n';
      const h = await makeHarness(adapter, source);
      await expect(
        h.repository.edit({
          type: 'set-time-slot',
          ref: rootRef(h, source),
          date: localDate('2026-07-12'),
          time: localTime('10:15'),
          duration: durationMinutes(45),
        }),
      ).resolves.toMatchObject({ type: 'committed', changed: true });
      expect(await h.read()).toContain('📅 2026-07-12 ⏰ 10:15 ⏱️ 45m');
    });

    it('converts a timed task to all-day atomically', async () => {
      const source = '- [ ] task 📅 2026-07-10 ⏰ 08:00 ⏱️ 2h custom\n';
      const h = await makeHarness(adapter, source);
      const result = await h.repository.edit({
        type: 'convert-to-all-day',
        ref: rootRef(h, source),
        date: localDate('2026-07-12'),
      });
      expect(result).toMatchObject({
        type: 'committed',
        changed: true,
        outcome: { type: 'task', task: { planning: { due: '2026-07-12' } } },
      });
      expect(await h.read()).toBe('- [ ] task 📅 2026-07-12 custom\n');
    });

    it('shifts schedule fields atomically while retaining all unrelated source bytes', async () => {
      const source =
        '>\t- [ ] priority 🔺 #keep unknown 🆔 retained ⛔ blocked ⏰ 09:00 ⏱️ 1h30m 🛫 2026-07-18 ⏳ 2026-07-01 📅 2026-07-20 ^block\r\n' +
        '> - [ ] unrelated\r\n';
      const h = await makeHarness(adapter, source);
      const result = await h.repository.edit({
        type: 'shift-schedule',
        ref: rootRef(h, source),
        days: 1,
      });

      expect(result).toMatchObject({
        type: 'committed',
        changed: true,
        outcome: {
          type: 'task',
          task: {
            planning: {
              start: '2026-07-19',
              scheduled: '2026-07-01',
              due: '2026-07-21',
            },
          },
        },
      });
      expect(await h.read()).toBe(
        '>\t- [ ] priority 🔺 #keep unknown 🆔 retained ⛔ blocked ⏰ 09:00 ⏱️ 1h30m 🛫 2026-07-19 ⏳ 2026-07-01 📅 2026-07-21 ^block\r\n' +
          '> - [ ] unrelated\r\n',
      );
    });

    it.each([
      {
        source: '- [ ] due 📅 2026-07-20\n',
        days: 1 as const,
        expected: '- [ ] due 📅 2026-07-21\n',
      },
      {
        source: '- [ ] planned ⏳ 2026-07-10 📅 2026-07-20\n',
        days: 1 as const,
        expected: '- [ ] planned ⏳ 2026-07-11 📅 2026-07-20\n',
      },
    ])('shifts the expected $source anchor', async ({ source, days, expected }) => {
      const h = await makeHarness(adapter, source);
      await expect(
        h.repository.edit({ type: 'shift-schedule', ref: rootRef(h, source), days }),
      ).resolves.toMatchObject({ type: 'committed', changed: true });
      expect(await h.read()).toBe(expected);
    });

    it.each([
      {
        source: '- [ ] unscheduled\n',
        days: 1 as const,
        expected: { code: 'invalid-target', field: 'schedule' },
      },
      {
        source: '- [ ] earliest 📅 0000-01-01\n',
        days: -1 as const,
        expected: { code: 'invalid-date', field: 'schedule' },
      },
      {
        source: '- [ ] latest 📅 9999-12-31\n',
        days: 1 as const,
        expected: { code: 'invalid-date', field: 'schedule' },
      },
    ])('returns $expected.code without changing bytes', async ({ source, days, expected }) => {
      const h = await makeHarness(adapter, source);
      await expect(
        h.repository.edit({ type: 'shift-schedule', ref: rootRef(h, source), days }),
      ).resolves.toEqual({ type: 'invalid', issues: [expected] });
      expect(await h.read()).toBe(source);
    });

    it.each([
      {
        source: '- [ ] malformed due 📅 2026-02-30\n',
        days: 1 as const,
      },
      {
        source: '- [ ] malformed span 🛫 2026-02-30 📅 2026-03-01\n',
        days: 1 as const,
      },
      {
        source: '- [ ] lower span 🛫 0000-01-01 📅 0000-01-02\n',
        days: -1 as const,
      },
      {
        source: '- [ ] upper span 🛫 9999-12-30 📅 9999-12-31\n',
        days: 1 as const,
      },
    ])('rejects an invalid span shift without changing bytes', async ({ source, days }) => {
      const h = await makeHarness(adapter, source);
      await expect(
        h.repository.edit({ type: 'shift-schedule', ref: rootRef(h, source), days }),
      ).resolves.toEqual({
        type: 'invalid',
        issues: [{ code: 'invalid-date', field: 'schedule' }],
      });
      expect(await h.read()).toBe(source);
    });

    it.each([
      ['start', '2026-07-09', '🛫 2026-07-09 📅 2026-07-20'],
      ['due', '2026-07-21', '🛫 2026-07-10 📅 2026-07-21'],
    ] as const)('sets the %s span boundary', async (boundary, date, expected) => {
      const source = '- [ ] task 🛫 2026-07-10 📅 2026-07-20\n';
      const h = await makeHarness(adapter, source);
      await expect(
        h.repository.edit({
          type: 'set-span-boundary',
          ref: rootRef(h, source),
          boundary,
          date: localDate(date),
        }),
      ).resolves.toMatchObject({ type: 'committed', changed: true });
      expect(await h.read()).toContain(expected);
    });

    it('rejects an inverted semantic boundary without changing bytes', async () => {
      const source = '- [ ] task 🛫 2026-07-10 📅 2026-07-20\n';
      const h = await makeHarness(adapter, source);
      await expect(
        h.repository.edit({
          type: 'set-span-boundary',
          ref: rootRef(h, source),
          boundary: 'start',
          date: localDate('2026-07-21'),
        }),
      ).resolves.toEqual({
        type: 'invalid',
        issues: [{ code: 'inverted-span', field: 'start,due' }],
      });
      expect(await h.read()).toBe(source);
    });

    it.each([
      {
        label: 'due-anchored reschedule',
        source: '- [ ] task 🛫 2026-07-21 📅 2026-07-20 ⏰ 09:00 ⏱️ 1h\n',
        command: { type: 'reschedule' as const, date: localDate('2026-07-20') },
      },
      {
        label: 'due-anchored time slot',
        source: '- [ ] task 🛫 2026-07-21 📅 2026-07-20 ⏰ 09:00 ⏱️ 1h\n',
        command: {
          type: 'set-time-slot' as const,
          date: localDate('2026-07-20'),
          time: localTime('10:00'),
        },
      },
      {
        label: 'due-anchored all-day conversion',
        source: '- [ ] task 🛫 2026-07-21 📅 2026-07-20 ⏰ 09:00 ⏱️ 1h\n',
        command: { type: 'convert-to-all-day' as const, date: localDate('2026-07-20') },
      },
      {
        label: 'scheduled-anchored reschedule',
        source: '- [ ] task 🛫 2026-07-21 ⏳ 2026-07-19 📅 2026-07-20 ⏰ 09:00 ⏱️ 1h\n',
        command: { type: 'reschedule' as const, date: localDate('2026-07-19') },
      },
      {
        label: 'scheduled-anchored time slot',
        source: '- [ ] task 🛫 2026-07-21 ⏳ 2026-07-19 📅 2026-07-20 ⏰ 09:00 ⏱️ 1h\n',
        command: {
          type: 'set-time-slot' as const,
          date: localDate('2026-07-19'),
          time: localTime('10:00'),
        },
      },
      {
        label: 'scheduled-anchored all-day conversion',
        source: '- [ ] task 🛫 2026-07-21 ⏳ 2026-07-19 📅 2026-07-20 ⏰ 09:00 ⏱️ 1h\n',
        command: { type: 'convert-to-all-day' as const, date: localDate('2026-07-19') },
      },
    ])(
      'rejects $label when the semantic scheduling command uses an inverted span',
      async ({ source, command }) => {
        const h = await makeHarness(adapter, source);
        const result = await h.repository.edit({ ...command, ref: rootRef(h, source) });

        expect(result).toEqual({
          type: 'invalid',
          issues: [{ code: 'inverted-span', field: 'start,due' }],
        });
        expect(await h.read()).toBe(source);
      },
    );

    it('creates and re-extends a span without duplicating start', async () => {
      const source = '- [ ] task ⏳ 2026-07-10 custom\n';
      const h = await makeHarness(adapter, source);
      await expect(
        h.repository.edit({
          type: 'extend-span',
          ref: rootRef(h, source),
          due: localDate('2026-07-12'),
        }),
      ).resolves.toMatchObject({ type: 'committed', changed: true });
      expect(await h.read()).toContain('🛫 2026-07-10 ⏳ 2026-07-10');
      expect(await h.read()).toContain('📅 2026-07-12');

      const changed = await h.read();
      await expect(
        h.repository.edit({
          type: 'extend-span',
          ref: rootRef(h, changed),
          due: localDate('2026-07-14'),
        }),
      ).resolves.toMatchObject({ type: 'committed', changed: true });
      expect((await h.read()).match(/🛫/gu)).toHaveLength(1);
      expect(await h.read()).toContain('🛫 2026-07-10 ⏳ 2026-07-10');
      expect(await h.read()).toContain('📅 2026-07-14');
    });

    it('rejects extending a task without a planning anchor', async () => {
      const source = '- [ ] task without dates\n';
      const h = await makeHarness(adapter, source);

      await expect(
        h.repository.edit({
          type: 'extend-span',
          ref: rootRef(h, source),
          due: localDate('2026-07-14'),
        }),
      ).resolves.toEqual({
        type: 'invalid',
        issues: [{ code: 'invalid-target', field: 'span-anchor' }],
      });
      expect(await h.read()).toBe(source);
    });

    it('rejects a runtime-injected subtask duration patch', async () => {
      const source = '- [ ] root\n  - [ ] child\n';
      const h = await makeHarness(adapter, source);
      const child = h.snapshots(source)[0]!.subtasks[0]!;

      await expect(
        h.repository.edit({
          type: 'patch',
          target: { type: 'subtask', ref: child.ref },
          patch: { duration: { type: 'set', value: durationMinutes(30) } },
        } as never),
      ).resolves.toEqual({
        type: 'invalid',
        issues: [{ code: 'invalid-target', field: 'duration' }],
      });
      expect(await h.read()).toBe(source);
    });

    it('returns a detached no-op for an unchanged time/span command', async () => {
      const source = '- [ ] task 🛫 2026-07-10 📅 2026-07-20 ⏰ 09:30\n';
      const h = await makeHarness(adapter, source);
      await expect(
        h.repository.edit({
          type: 'set-time-slot',
          ref: rootRef(h, source),
          date: localDate('2026-07-20'),
          time: localTime('09:30'),
        }),
      ).resolves.toMatchObject({ type: 'committed', changed: false });
      expect(await h.read()).toBe(source);
    });

    it('rejects runtime-invalid time and duration values without changing bytes', async () => {
      const source = '- [ ] task 📅 2026-07-20\n';
      const h = await makeHarness(adapter, source);
      await expect(
        h.repository.edit({
          type: 'patch',
          target: { type: 'task', ref: rootRef(h, source) },
          patch: { time: { type: 'set', value: '25:00' as never } },
        }),
      ).resolves.toMatchObject({ type: 'invalid', issues: [{ code: 'invalid-time' }] });
      await expect(
        h.repository.edit({
          type: 'patch',
          target: { type: 'task', ref: rootRef(h, source) },
          patch: { duration: { type: 'set', value: 0 as never } },
        }),
      ).resolves.toMatchObject({ type: 'invalid', issues: [{ code: 'invalid-duration' }] });
      expect(await h.read()).toBe(source);
    });
  });
}
