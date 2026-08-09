import { TFile, type App, type CachedMetadata } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/settings/defaults';
import { toStatusRules } from '../../src/settings/statusCatalogAdapter';
import type {
  RecurrenceCompletionRequest,
  TaskRepository,
} from '../../src/tasks/application/TaskRepository';
import { StatusCatalog } from '../../src/tasks/domain/StatusCatalog';
import type { TaskNodeRef, TaskSnapshot } from '../../src/tasks/domain/types';
import { localDate } from '../../src/tasks/domain/validation';
import { TaskIndex } from '../../src/tasks/infrastructure/TaskIndex';
import {
  TaskRefAuthority,
  type TaskSnapshotState,
} from '../../src/tasks/infrastructure/TaskRefAuthority';
import { TaskBlockEditor } from '../../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { TaskLocator } from '../../src/tasks/infrastructure/markdown/TaskLocator';
import { TaskMarkdownCodec } from '../../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { ObsidianTaskRepository } from '../../src/tasks/infrastructure/obsidian/ObsidianTaskRepository';
import { captureChangedCallback, createAppWithFiles, flushMicrotasks } from '../helpers';
import { InMemoryTaskRepository } from '../support/InMemoryTaskRepository';

type Adapter = 'in-memory' | 'obsidian';

interface Harness {
  readonly app: App;
  readonly repository: TaskRepository;
  readonly snapshots: (content: string) => readonly TaskSnapshot[];
  readonly read: () => Promise<string>;
  readonly index: TaskIndex;
  readonly authority: TaskRefAuthority;
  readonly fireChanged: (file: TFile, data: string, cache: CachedMetadata) => void;
}

interface HarnessOptions {
  readonly failFinalProjection?: boolean;
  readonly session?: string;
  readonly extraFiles?: Readonly<Record<string, string>>;
}

const path = 'tasks.md';

async function makeHarness(
  adapter: Adapter,
  source: string,
  options: HarnessOptions = {},
): Promise<Harness> {
  const files = { [path]: source, ...options.extraFiles };
  const app = await createAppWithFiles(files);
  const statusCatalog = new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses));
  const codec = new TaskMarkdownCodec(statusCatalog);
  const authority = new TaskRefAuthority(options.session ?? `${adapter}-session`);
  const fireChanged = captureChangedCallback(app);
  const index = new TaskIndex(app, {
    statusCatalog,
    dailyNoteFormat: DEFAULT_SETTINGS.desktop.dailyNoteFormat,
    refAuthority: authority,
  });
  await index.initialize();
  for (const [filePath, content] of Object.entries(files)) {
    index.installCommittedContent(filePath, content);
  }
  await flushMicrotasks();
  const snapshotState: TaskSnapshotState = {
    currentRoot: (filePath, line, blockSource) => index.currentRoot(filePath, line, blockSource),
    previewContent: (filePath, content) => {
      if (options.failFinalProjection && content !== source)
        throw new Error('injected projection failure');
      return index.previewContent(filePath, content);
    },
    installCommittedContent: (filePath, content) =>
      index.installCommittedContent(filePath, content),
  };
  const snapshots = (content: string) => snapshotState.previewContent(path, content);
  const snapshotsFromContent = (filePath: string, content: string) => {
    if (options.failFinalProjection && content !== source)
      throw new Error('injected projection failure');
    return index.previewContent(filePath, content);
  };
  const locator = new TaskLocator(authority);
  if (adapter === 'in-memory') {
    const repository = new InMemoryTaskRepository({
      files,
      codec,
      snapshotsFromContent,
      locator,
      refAuthority: authority,
      snapshotState,
    });
    return {
      app,
      repository,
      snapshots,
      index,
      authority,
      fireChanged,
      read: async () => repository.content(path) ?? '',
    };
  }
  const repository = new ObsidianTaskRepository(app, {
    codec,
    editor: new TaskBlockEditor(),
    locator,
    snapshotsFromContent,
    refAuthority: authority,
    snapshotState,
  });
  return {
    app,
    repository,
    snapshots,
    index,
    authority,
    fireChanged,
    read: async () => {
      const file = app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) throw new Error('missing task file');
      return app.vault.cachedRead(file);
    },
  };
}

function request(
  target: TaskNodeRef,
  overrides: Partial<Omit<RecurrenceCompletionRequest, 'target'>> = {},
): RecurrenceCompletionRequest {
  return {
    target,
    doneSymbol: 'x',
    today: localDate('2026-08-01'),
    todoSymbol: ' ',
    addCreatedDate: true,
    addCompletionDate: true,
    placement: 'before',
    policy: { removeScheduledDate: false },
    ...overrides,
  };
}

function rootTarget(harness: Harness, source: string, index = 0): TaskNodeRef {
  const root = harness.snapshots(source)[index];
  if (!root) throw new Error(`missing root ${index}`);
  return { type: 'task', ref: root.ref };
}

for (const adapter of ['in-memory', 'obsidian'] as const) {
  describe(`${adapter} recurrence repository contract`, () => {
    it.each([
      {
        rule: 'every February on the last',
        reference: '2024-02-29',
        next: '2025-02-28',
      },
      {
        rule: 'every April and December on the 1st and 24th',
        reference: '2026-04-01',
        next: '2026-04-24',
      },
      {
        rule: 'every 2 years on February 29th',
        reference: '2024-02-29',
        next: '2028-02-29',
      },
    ])('materializes Tasks yearly grammar $rule', async ({ rule, reference, next }) => {
      const source = `- [ ] Repeat 🔁 ${rule} 📅 ${reference}\n`;
      const harness = await makeHarness(adapter, source);

      const result = await harness.repository.completeRecurrence(
        request(rootTarget(harness, source), {
          addCreatedDate: false,
          addCompletionDate: false,
        }),
      );

      expect(await harness.read()).toBe(
        `- [ ] Repeat 🔁 ${rule} 📅 ${next}\n` + `- [x] Repeat 🔁 ${rule} 📅 ${reference}\n`,
      );
      expect(result).toMatchObject({
        type: 'committed',
        changed: true,
        outcome: {
          type: 'recurrence',
          active: { root: { planning: { due: next } }, target: { type: 'task' } },
        },
      });
    });

    it.each([
      {
        placement: 'before' as const,
        ending: '\n',
        policyToken: '',
        expectedRoots: ['open', 'done'],
        expected:
          '- [ ] Repeat 🔁 every day ➕ 2026-08-01 📅 2026-08-02\n' +
          '  - [ ] Child ➕ 2026-08-01 📅 2026-08-04\n' +
          '- [x] Repeat 🔁 every day 📅 2026-08-01 ✅ 2026-08-01\n' +
          '  - [x] Child 📅 2026-08-03 ✅ 2026-07-31\n' +
          '- [ ] Outside\n',
      },
      {
        placement: 'after' as const,
        ending: '\r\n',
        policyToken: ' 🏁 keep',
        expectedRoots: ['done', 'open'],
        expected:
          '- [x] Repeat 🔁 every day 🏁 keep 📅 2026-08-01 ✅ 2026-08-01\r\n' +
          '  - [x] Child 📅 2026-08-03 ✅ 2026-07-31\r\n' +
          '- [ ] Repeat 🔁 every day 🏁 keep ➕ 2026-08-01 📅 2026-08-02\r\n' +
          '  - [ ] Child ➕ 2026-08-01 📅 2026-08-04\r\n' +
          '- [ ] Outside\r\n',
      },
    ])(
      'keeps exact $ending bytes and places the clean root $placement the completed root',
      async ({ placement, ending, policyToken, expected, expectedRoots }) => {
        const source = [
          `- [ ] Repeat 🔁 every day${policyToken} 📅 2026-08-01`,
          '  - [x] Child 📅 2026-08-03 ✅ 2026-07-31',
          '- [ ] Outside',
          '',
        ].join(ending);
        const harness = await makeHarness(adapter, source);

        const result = await harness.repository.completeRecurrence(
          request(rootTarget(harness, source), { placement }),
        );

        expect(await harness.read()).toBe(expected);
        expect(harness.snapshots(expected).map((root) => root.status)).toEqual([
          ...expectedRoots,
          'open',
        ]);
        expect(result).toMatchObject({
          type: 'committed',
          changed: true,
          outcome: {
            type: 'recurrence',
            active: { root: { status: 'open' }, target: { type: 'task' } },
            completed: { root: { status: 'done' }, target: { type: 'task' } },
          },
        });
        if (result.type === 'committed' && result.outcome.type === 'recurrence') {
          const completed = result.outcome.completed;
          if (!completed) throw new Error('missing completed occurrence');
          expect(result.outcome.active.target).toEqual({
            type: 'task',
            ref: result.outcome.active.root.ref,
          });
          expect(completed.target).toEqual({
            type: 'task',
            ref: completed.root.ref,
          });
          expect(result.outcome.active.root.ref).not.toEqual(completed.root.ref);
        }
      },
    );

    it('rebases active and completed nested owners independently in one final root', async () => {
      const source =
        '- [ ] Shell\n' +
        '  - [ ] Owner 🔁 every day 📅 2026-08-01\n' +
        '    - [x] Child 📅 2026-08-03 ✅ 2026-07-31\n' +
        '  - [ ] Sibling\n' +
        '- [ ] Outside\n';
      const harness = await makeHarness(adapter, source);
      const root = harness.snapshots(source)[0]!;
      const owner = root.subtasks[0]!;

      const result = await harness.repository.completeRecurrence(
        request({ type: 'subtask', ref: owner.ref }),
      );

      expect(await harness.read()).toBe(
        '- [ ] Shell\n' +
          '  - [ ] Owner 🔁 every day ➕ 2026-08-01 📅 2026-08-02\n' +
          '    - [ ] Child ➕ 2026-08-01 📅 2026-08-04\n' +
          '  - [x] Owner 🔁 every day 📅 2026-08-01 ✅ 2026-08-01\n' +
          '    - [x] Child 📅 2026-08-03 ✅ 2026-07-31\n' +
          '  - [ ] Sibling\n' +
          '- [ ] Outside\n',
      );
      expect(result).toMatchObject({
        type: 'committed',
        changed: true,
        outcome: {
          type: 'recurrence',
          active: { root: { ref: expect.any(Object) }, target: { type: 'subtask' } },
          completed: { root: { ref: expect.any(Object) }, target: { type: 'subtask' } },
        },
      });
      if (result.type === 'committed' && result.outcome.type === 'recurrence') {
        expect(result.outcome.active.root.ref).toEqual(result.outcome.completed?.root.ref);
        expect(result.outcome.active.target).not.toEqual(result.outcome.completed?.target);
        expect(result.outcome.active.target).toEqual({
          type: 'subtask',
          ref: result.outcome.active.root.subtasks[0]!.ref,
        });
        expect(result.outcome.completed?.target).toEqual({
          type: 'subtask',
          ref: result.outcome.active.root.subtasks[1]!.ref,
        });
      }
    });

    it('replaces a Delete recurrence subtree and returns only the clean active occurrence', async () => {
      const source =
        '- [ ] Shell\n' +
        '  - [ ] Owner 🔁 every day 🏁 delete 📅 2026-08-01\n' +
        '    - [x] Child 📅 2026-08-03 ✅ 2026-07-31\n' +
        '  - [ ] Sibling\n';
      const harness = await makeHarness(adapter, source);
      const owner = harness.snapshots(source)[0]!.subtasks[0]!;

      const result = await harness.repository.completeRecurrence(
        request({ type: 'subtask', ref: owner.ref }),
      );

      expect(await harness.read()).toBe(
        '- [ ] Shell\n' +
          '  - [ ] Owner 🔁 every day 🏁 delete ➕ 2026-08-01 📅 2026-08-02\n' +
          '    - [ ] Child ➕ 2026-08-01 📅 2026-08-04\n' +
          '  - [ ] Sibling\n',
      );
      expect(result).toMatchObject({
        type: 'committed',
        changed: true,
        outcome: {
          type: 'recurrence',
          active: { target: { type: 'subtask' } },
        },
      });
      if (result.type === 'committed' && result.outcome.type === 'recurrence') {
        expect(result.outcome.completed).toBeUndefined();
        expect(result.outcome.active.target).toEqual({
          type: 'subtask',
          ref: result.outcome.active.root.subtasks[0]!.ref,
        });
      }
    });

    it('removes a valid non-recurring Delete subtree only on first entry into Done', async () => {
      const source =
        '- [ ] Shell\n' +
        '  - [ ] Remove me 🏁 delete\n' +
        '    - [ ] Descendant\n' +
        '  - [ ] Keep me\n';
      const harness = await makeHarness(adapter, source);
      const owner = harness.snapshots(source)[0]!.subtasks[0]!;

      const result = await harness.repository.edit({
        type: 'set-status',
        target: { type: 'subtask', ref: owner.ref },
        symbol: 'x',
        stamp: localDate('2026-08-01'),
        addCompletionDate: true,
      });

      expect(await harness.read()).toBe('- [ ] Shell\n  - [ ] Keep me\n');
      expect(result).toMatchObject({
        type: 'committed',
        changed: true,
        outcome: { type: 'task', task: { subtasks: [{ title: 'Keep me' }] } },
      });
    });

    it('installs a full-root Delete without minting a surviving successor', async () => {
      const source = '- [ ] Remove me 🏁 delete\n  - [ ] Descendant\n';
      const harness = await makeHarness(adapter, source);
      const target = rootTarget(harness, source);

      const result = await harness.repository.edit({
        type: 'set-status',
        target,
        symbol: 'x',
        stamp: localDate('2026-08-01'),
        addCompletionDate: true,
      });
      await flushMicrotasks();

      expect(result).toMatchObject({ type: 'committed', outcome: { type: 'deleted' } });
      expect(await harness.read()).toBe('');
      expect(harness.index.list()).toEqual([]);
    });

    it('applies ordinary Delete completion to an invalid raw recurrence subtree', async () => {
      const source = '- [ ] Invalid repeat 🔁 tomorrow 🏁 delete\n  - [ ] Child\n';
      const harness = await makeHarness(adapter, source);

      const result = await harness.repository.edit({
        type: 'set-status',
        target: rootTarget(harness, source),
        symbol: 'x',
        stamp: localDate('2026-08-01'),
        addCompletionDate: true,
      });

      expect(result).toMatchObject({ type: 'committed', outcome: { type: 'deleted' } });
      expect(await harness.read()).toBe('');
    });

    it.each([
      {
        name: 'a recurring descendant',
        source:
          '- [ ] Invalid repeat 🔁 tomorrow 🏁 delete\n' +
          '  - [ ] Child 🔁 every week 📅 2026-08-02\n',
      },
      {
        name: 'a second recurrence marker on the selected owner',
        source: '- [ ] Invalid repeat 🔁 tomorrow 🔁 every week 🏁 delete\n' + '  - [ ] Child\n',
      },
    ])('rejects ordinary Delete for an invalid selected owner with $name', async ({ source }) => {
      const harness = await makeHarness(adapter, source);

      await expect(
        harness.repository.edit({
          type: 'set-status',
          target: rootTarget(harness, source),
          symbol: 'x',
          stamp: localDate('2026-08-01'),
          addCompletionDate: true,
        }),
      ).resolves.toEqual({
        type: 'invalid',
        issues: [{ code: 'nested-recurrence-conflict', field: 'recurrence' }],
      });
      expect(await harness.read()).toBe(source);
    });

    it.each([
      {
        name: 'a second recurrence on a sibling',
        source:
          '- [ ] Shell\n' +
          '  - [ ] Owner 🔁 every day 📅 2026-08-01\n' +
          '  - [ ] Sibling 🔁 every week 📅 2026-08-02\n',
        owner: (roots: readonly TaskSnapshot[]) => roots[0]!.subtasks[0]!,
      },
      {
        name: 'a second recurrence on a child',
        source:
          '- [ ] Owner 🔁 every day 📅 2026-08-01\n' +
          '  - [ ] Child 🔁 every week 📅 2026-08-02\n',
        owner: (roots: readonly TaskSnapshot[]) => roots[0]!,
      },
    ])('rejects $name without changing bytes', async ({ source, owner }) => {
      const harness = await makeHarness(adapter, source);
      const selected = owner(harness.snapshots(source));
      const target: TaskNodeRef =
        'source' in selected
          ? { type: 'task', ref: selected.ref }
          : { type: 'subtask', ref: selected.ref };

      await expect(harness.repository.completeRecurrence(request(target))).resolves.toEqual({
        type: 'invalid',
        issues: [{ code: 'nested-recurrence-conflict', field: 'recurrence' }],
      });
      expect(await harness.read()).toBe(source);
    });

    it('rejects an unsafe descendant date without changing bytes', async () => {
      const source = '- [ ] Owner 🔁 every day 📅 9999-12-30\n' + '  - [ ] Child 📅 9999-12-31\n';
      const harness = await makeHarness(adapter, source);

      await expect(
        harness.repository.completeRecurrence(request(rootTarget(harness, source))),
      ).resolves.toEqual({
        type: 'invalid',
        issues: [{ code: 'invalid-descendant-date', field: 'recurrence' }],
      });
      expect(await harness.read()).toBe(source);
    });

    it('fails closed before commit when final snapshot projection throws', async () => {
      const source = '- [ ] Owner 🔁 every day 📅 2026-08-01\n';
      const harness = await makeHarness(adapter, source, { failFinalProjection: true });

      await expect(
        harness.repository.completeRecurrence(request(rootTarget(harness, source))),
      ).resolves.toMatchObject({
        type: 'io-error',
        contentState: 'unknown',
      });
      expect(await harness.read()).toBe(source);
    });

    it('rejects stale and ambiguous roots without changing bytes', async () => {
      const source = '- [ ] Owner 🔁 every day 📅 2026-08-01\n';
      const staleHarness = await makeHarness(adapter, source);
      const staleTarget = rootTarget(staleHarness, source);
      if (staleTarget.type !== 'task') throw new Error('missing root target');
      await staleHarness.repository.edit({
        type: 'patch',
        target: staleTarget,
        patch: { priority: { type: 'set', value: 'A' } },
      });
      const changed = await staleHarness.read();

      await expect(
        staleHarness.repository.completeRecurrence(request(staleTarget)),
      ).resolves.toMatchObject({ type: 'conflict' });
      expect(await staleHarness.read()).toBe(changed);

      const duplicates = `${source}${source}`;
      const ambiguousHarness = await makeHarness(adapter, duplicates);
      const first = rootTarget(ambiguousHarness, duplicates);
      if (first.type !== 'task') throw new Error('missing root target');
      const ambiguous = { type: 'task' as const, ref: { ...first.ref, line: 99 } };
      await expect(
        ambiguousHarness.repository.completeRecurrence(request(ambiguous)),
      ).resolves.toMatchObject({
        type: 'ambiguous',
        candidates: [
          { root: { source: { line: 0 } }, target: { type: 'task' } },
          { root: { source: { line: 1 } }, target: { type: 'task' } },
        ],
      });
      expect(await ambiguousHarness.read()).toBe(duplicates);
    });

    it('makes a repeated request through the stale source ref conflict instead of duplicating', async () => {
      const source = '- [ ] Owner 🔁 every day\n';
      const harness = await makeHarness(adapter, source);
      const completion = request(rootTarget(harness, source), {
        addCreatedDate: false,
        addCompletionDate: false,
      });

      const first = await harness.repository.completeRecurrence(completion);
      expect(first).toMatchObject({
        type: 'committed',
        outcome: { type: 'recurrence' },
      });
      if (first.type !== 'committed' || first.outcome.type !== 'recurrence') {
        throw new Error('missing recurrence outcome');
      }
      const active = first.outcome.active.target;
      const afterFirst = await harness.read();
      await expect(harness.repository.completeRecurrence(completion)).resolves.toMatchObject({
        type: 'conflict',
      });
      expect(await harness.read()).toBe(afterFirst);
      expect(afterFirst.match(/🔁 every day/gu) ?? []).toHaveLength(2);

      await expect(
        harness.repository.completeRecurrence({ ...completion, target: active }),
      ).resolves.toMatchObject({ type: 'committed', outcome: { type: 'recurrence' } });
    });

    it('rejects an old-session ref after restart while a freshly indexed ref succeeds', async () => {
      const source = '- [ ] Owner 🔁 every day 📅 2026-08-01\n';
      const beforeRestart = await makeHarness(adapter, source, { session: 'old-session' });
      const oldTarget = rootTarget(beforeRestart, source);
      const afterRestart = await makeHarness(adapter, source, { session: 'new-session' });

      await expect(
        afterRestart.repository.completeRecurrence(request(oldTarget)),
      ).resolves.toMatchObject({ type: 'conflict' });
      expect(await afterRestart.read()).toBe(source);
      await expect(
        afterRestart.repository.completeRecurrence(request(rootTarget(afterRestart, source))),
      ).resolves.toMatchObject({ type: 'committed', outcome: { type: 'recurrence' } });
    });

    it('publishes a fresh active ref for byte-identical Delete without a vault event', async () => {
      const source = '- [ ] Owner 🔁 every day 🏁 delete\n';
      const harness = await makeHarness(adapter, source);
      const original = rootTarget(harness, source);
      if (original.type !== 'task') throw new Error('missing original root');
      let notifications = 0;
      harness.index.subscribe((event) => {
        if (event.type === 'changed') notifications += 1;
      });

      const result = await harness.repository.completeRecurrence(
        request(original, { addCreatedDate: false, addCompletionDate: false }),
      );
      await flushMicrotasks();

      expect(await harness.read()).toBe(source);
      expect(result).toMatchObject({ type: 'committed', outcome: { type: 'recurrence' } });
      if (result.type !== 'committed' || result.outcome.type !== 'recurrence') {
        throw new Error('missing recurrence outcome');
      }
      expect(result.outcome.active.root.ref.revision).not.toBe(original.ref.revision);
      expect(harness.index.list()[0]?.ref).toEqual(result.outcome.active.root.ref);
      expect(notifications).toBe(1);
    });

    it('allows only one of two concurrent completions from the same consumed ref to commit', async () => {
      const source = '- [ ] Owner 🔁 every day\n';
      const harness = await makeHarness(adapter, source);
      const completion = request(rootTarget(harness, source), {
        addCreatedDate: false,
        addCompletionDate: false,
      });

      const results = await Promise.all([
        harness.repository.completeRecurrence(completion),
        harness.repository.completeRecurrence(completion),
      ]);

      expect(results.filter((result) => result.type === 'committed')).toHaveLength(1);
      expect(results.filter((result) => result.type === 'conflict')).toHaveLength(1);
    });

    it('uses one successor revision for an ordinary surviving-root edit and its installed index', async () => {
      const source = '- [ ] Owner\n';
      const harness = await makeHarness(adapter, source);
      const original = rootTarget(harness, source);
      if (original.type !== 'task') throw new Error('missing original root');

      const result = await harness.repository.edit({
        type: 'patch',
        target: original,
        patch: { priority: { type: 'set', value: 'A' } },
      });

      expect(result).toMatchObject({ type: 'committed', changed: true, outcome: { type: 'task' } });
      if (result.type !== 'committed' || result.outcome.type !== 'task') {
        throw new Error('missing task outcome');
      }
      expect(result.outcome.task.ref.revision).not.toBe(
        original.type === 'task' ? original.ref.revision : '',
      );
      expect(harness.index.list()[0]?.ref).toEqual(result.outcome.task.ref);
    });

    it('uses one successor revision for a cross-file move destination and its installed index', async () => {
      const source = '- [ ] Owner\n';
      const destination = 'archive.md';
      const harness = await makeHarness(adapter, source, {
        extraFiles: { [destination]: '' },
      });
      const original = rootTarget(harness, source);
      if (original.type !== 'task') throw new Error('missing original root');

      const result = await harness.repository.move(original.ref, {
        filePath: destination,
        insertion: { type: 'append' },
      });

      expect(result).toMatchObject({ type: 'committed', outcome: { type: 'task' } });
      if (result.type !== 'committed' || result.outcome.type !== 'task') {
        throw new Error('missing moved task');
      }
      expect(result.outcome.task.ref.revision).not.toBe(original.ref.revision);
      expect(harness.index.list({ filePath: destination })[0]?.ref).toEqual(
        result.outcome.task.ref,
      );
      expect(harness.index.list({ filePath: path })).toEqual([]);
    });

    it('assigns an initial revision to creation and installs the same ref in the index', async () => {
      const harness = await makeHarness(adapter, '');

      const result = await harness.repository.create(
        { filePath: path, insertion: { type: 'append' } },
        { markdownBody: 'Created' },
      );

      expect(result).toMatchObject({ type: 'committed', outcome: { type: 'task' } });
      if (result.type !== 'committed' || result.outcome.type !== 'task') {
        throw new Error('missing created task');
      }
      expect(harness.authority.evidence(result.outcome.task.ref.revision)).toMatchObject({
        generation: '0',
      });
      expect(harness.index.list()[0]?.ref).toEqual(result.outcome.task.ref);
    });
  });
}

describe('Obsidian recurrence transaction boundary', () => {
  it('publishes the same ordinary-edit successor for an early event, return value, and final index', async () => {
    const source = '- [ ] Owner\n';
    const harness = await makeHarness('obsidian', source);
    const original = rootTarget(harness, source);
    if (original.type !== 'task') throw new Error('missing original root');
    const notifications: string[] = [];
    harness.index.subscribe((event) => {
      if (event.type === 'changed') {
        const revision = harness.index.list()[0]?.ref.revision;
        if (revision) notifications.push(revision);
      }
    });
    vi.spyOn(harness.app.vault, 'process').mockImplementation(async (file, transform) => {
      const current = await harness.app.vault.read(file);
      const candidate = transform(current);
      harness.fireChanged(file, candidate, {
        listItems: [
          {
            task: ' ',
            parent: -1,
            position: { start: { line: 0 }, end: { line: 0 } },
          },
        ],
      } as CachedMetadata);
      await harness.app.vault.modify(file, candidate);
      return candidate;
    });

    const result = await harness.repository.edit({
      type: 'patch',
      target: original,
      patch: { priority: { type: 'set', value: 'A' } },
    });
    await flushMicrotasks();

    expect(result).toMatchObject({ type: 'committed', outcome: { type: 'task' } });
    if (result.type !== 'committed' || result.outcome.type !== 'task') {
      throw new Error('missing task outcome');
    }
    expect(notifications).toEqual([result.outcome.task.ref.revision]);
    expect(harness.index.list()[0]?.ref).toEqual(result.outcome.task.ref);
  });

  it('restores the consumed ref when an early ordinary-edit event precedes rejection', async () => {
    const source = '- [ ] Owner\n';
    const harness = await makeHarness('obsidian', source);
    const original = rootTarget(harness, source);
    if (original.type !== 'task') throw new Error('missing original root');
    vi.spyOn(harness.app.vault, 'process').mockImplementation(async (file, transform) => {
      const current = await harness.app.vault.read(file);
      const candidate = transform(current);
      harness.fireChanged(file, candidate, {
        listItems: [{ task: ' ', parent: -1, position: { start: { line: 0 }, end: { line: 0 } } }],
      } as CachedMetadata);
      throw new Error('rejected after edit observation');
    });

    await expect(
      harness.repository.edit({
        type: 'patch',
        target: original,
        patch: { priority: { type: 'set', value: 'A' } },
      }),
    ).resolves.toMatchObject({ type: 'io-error' });

    expect(await harness.read()).toBe(source);
    expect(harness.index.list()[0]?.ref).toEqual(original.ref);
    expect(harness.authority.observe(path, source)).toEqual([]);
  });

  it('uses exactly one synchronous vault.process callback for one completion', async () => {
    const source = '- [ ] Owner 🔁 every day 📅 2026-08-01\n';
    const harness = await makeHarness('obsidian', source);
    const process = vi.spyOn(harness.app.vault, 'process');

    await harness.repository.completeRecurrence(request(rootTarget(harness, source)));

    expect(process).toHaveBeenCalledOnce();
    expect(process.mock.calls[0]?.[1].constructor.name).not.toBe('AsyncFunction');
  });

  it('keeps one logical notification when the vault event arrives after commit installation', async () => {
    const source = '- [ ] Owner 🔁 every day 🏁 delete\n';
    const harness = await makeHarness('obsidian', source);
    const notifications: string[] = [];
    harness.index.subscribe((event) => {
      if (event.type === 'changed') notifications.push(harness.index.list()[0]!.ref.revision);
    });

    const result = await harness.repository.completeRecurrence(
      request(rootTarget(harness, source), {
        addCreatedDate: false,
        addCompletionDate: false,
      }),
    );
    const file = harness.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error('missing task file');
    harness.fireChanged(file, source, {
      listItems: [{ task: ' ', parent: -1, position: { start: { line: 0 }, end: { line: 0 } } }],
    } as CachedMetadata);
    await flushMicrotasks();

    if (result.type !== 'committed' || result.outcome.type !== 'recurrence') {
      throw new Error('missing recurrence outcome');
    }
    expect(notifications).toEqual([result.outcome.active.root.ref.revision]);
    expect(harness.index.list()[0]?.ref).toEqual(result.outcome.active.root.ref);
  });

  it('aborts staging and reconciles authoritative bytes when an early event precedes rejection', async () => {
    const source = '- [ ] Owner 🔁 every day 🏁 delete\n';
    const harness = await makeHarness('obsidian', source);
    const original = rootTarget(harness, source);
    const completion = request(original, {
      addCreatedDate: false,
      addCompletionDate: false,
    });
    vi.spyOn(harness.app.vault, 'process').mockImplementation(async (file, transform) => {
      const current = await harness.app.vault.read(file);
      const candidate = transform(current);
      harness.fireChanged(file, candidate, {
        listItems: [{ task: ' ', parent: -1, position: { start: { line: 0 }, end: { line: 0 } } }],
      } as CachedMetadata);
      throw new Error('rejected after observation');
    });

    await expect(harness.repository.completeRecurrence(completion)).resolves.toMatchObject({
      type: 'io-error',
    });

    expect(await harness.read()).toBe(source);
    expect(harness.index.list()[0]?.source.originalBlock).toBe(source.trimEnd());
    if (original.type !== 'task') throw new Error('missing original root');
    expect(harness.index.list()[0]?.ref).toEqual(original.ref);
    expect(harness.authority.observe(path, source)).toEqual([]);
  });

  it('reconciles an early full-delete event when process rejects without a successor token', async () => {
    const source = '- [ ] Remove me\n  - [ ] Child\n';
    const harness = await makeHarness('obsidian', source);
    const initial = rootTarget(harness, source);
    if (initial.type !== 'task') throw new Error('missing task root');
    const advancedResult = await harness.repository.edit({
      type: 'patch',
      target: initial,
      patch: { priority: { type: 'set', value: 'A' } },
    });
    if (advancedResult.type !== 'committed' || advancedResult.outcome.type !== 'task') {
      throw new Error('missing advanced task');
    }
    const advanced = advancedResult.outcome.task;
    const advancedContent = await harness.read();
    expect(harness.authority.evidence(advanced.ref.revision)?.generation).not.toBe('0');
    vi.spyOn(harness.app.vault, 'process').mockImplementation(async (file, transform) => {
      const current = await harness.app.vault.read(file);
      const candidate = transform(current);
      harness.fireChanged(file, candidate, {} as CachedMetadata);
      throw new Error('rejected after delete observation');
    });

    await expect(
      harness.repository.edit({ type: 'delete', ref: advanced.ref }),
    ).resolves.toMatchObject({ type: 'io-error' });
    await flushMicrotasks();

    expect(await harness.read()).toBe(advancedContent);
    expect(harness.index.list()).toHaveLength(1);
    expect(harness.index.list()[0]?.ref).toEqual(advanced.ref);
  });

  it('reconciles an early create event when process rejects without a successor token', async () => {
    const harness = await makeHarness('obsidian', '');
    vi.spyOn(harness.app.vault, 'process').mockImplementation(async (file, transform) => {
      const current = await harness.app.vault.read(file);
      const candidate = transform(current);
      harness.fireChanged(file, candidate, {
        listItems: [{ task: ' ', parent: -1, position: { start: { line: 0 }, end: { line: 0 } } }],
      } as CachedMetadata);
      throw new Error('rejected after create observation');
    });

    await expect(
      harness.repository.create(
        { filePath: path, insertion: { type: 'append' } },
        { markdownBody: 'Created' },
      ),
    ).resolves.toMatchObject({ type: 'io-error' });
    await flushMicrotasks();

    expect(await harness.read()).toBe('');
    expect(harness.index.list()).toEqual([]);
  });

  it('aborts and reconciles an early move-destination event when process rejects', async () => {
    const source = '- [ ] Move me\n';
    const destination = 'archive.md';
    const harness = await makeHarness('obsidian', source, {
      extraFiles: { [destination]: '' },
    });
    const target = rootTarget(harness, source);
    if (target.type !== 'task') throw new Error('missing task root');
    vi.spyOn(harness.app.vault, 'process').mockImplementation(async (file, transform) => {
      const current = await harness.app.vault.read(file);
      const candidate = transform(current);
      harness.fireChanged(file, candidate, {
        listItems: [{ task: ' ', parent: -1, position: { start: { line: 0 }, end: { line: 0 } } }],
      } as CachedMetadata);
      throw new Error('rejected after move observation');
    });

    await expect(
      harness.repository.move(target.ref, {
        filePath: destination,
        insertion: { type: 'append' },
      }),
    ).resolves.toMatchObject({ type: 'io-error' });
    await flushMicrotasks();

    expect(harness.index.list({ filePath: path })[0]?.ref).toEqual(target.ref);
    expect(harness.index.list({ filePath: destination })).toEqual([]);
  });

  it('reconciles an early move-source delete event when removal rejects', async () => {
    const source = '- [ ] Move me\n';
    const destination = 'archive.md';
    const harness = await makeHarness('obsidian', source, {
      extraFiles: { [destination]: '' },
    });
    const initial = rootTarget(harness, source);
    if (initial.type !== 'task') throw new Error('missing task root');
    const advancedResult = await harness.repository.edit({
      type: 'patch',
      target: initial,
      patch: { priority: { type: 'set', value: 'A' } },
    });
    if (advancedResult.type !== 'committed' || advancedResult.outcome.type !== 'task') {
      throw new Error('missing advanced task');
    }
    const advanced = advancedResult.outcome.task;
    expect(harness.authority.evidence(advanced.ref.revision)?.generation).not.toBe('0');
    let processCount = 0;
    vi.spyOn(harness.app.vault, 'process').mockImplementation(async (file, transform) => {
      const current = await harness.app.vault.read(file);
      const candidate = transform(current);
      processCount += 1;
      if (processCount === 1) {
        await harness.app.vault.modify(file, candidate);
        return candidate;
      }
      harness.fireChanged(file, candidate, {} as CachedMetadata);
      throw new Error('rejected after source delete observation');
    });

    const result = await harness.repository.move(advanced.ref, {
      filePath: destination,
      insertion: { type: 'append' },
    });
    expect(result).toMatchObject({ type: 'partial', operation: 'move' });
    await flushMicrotasks();

    if (result.type !== 'partial') throw new Error('missing partial move');
    expect(result.recovery.source).toEqual(advanced.ref);
    expect(harness.index.list({ filePath: path })[0]?.ref).toEqual(result.recovery.source);
    expect(harness.index.list({ filePath: destination })).toHaveLength(1);
  });

  it('maps an injected process failure without changing vault bytes', async () => {
    const source = '- [ ] Owner 🔁 every day 📅 2026-08-01\n';
    const harness = await makeHarness('obsidian', source);
    vi.spyOn(harness.app.vault, 'process').mockRejectedValue(new Error('disk unavailable'));

    await expect(
      harness.repository.completeRecurrence(request(rootTarget(harness, source))),
    ).resolves.toEqual({
      type: 'io-error',
      cause: 'process-error',
      path,
      contentState: 'unknown',
    });
    expect(await harness.read()).toBe(source);
  });
});
