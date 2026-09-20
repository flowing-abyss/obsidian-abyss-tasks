import type * as ObsidianModule from 'obsidian';
import type { App, CachedMetadata } from 'obsidian';
import { Notice, TFile } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { NoteTemplateService } from '../../src/notes/NoteTemplateService';
import { DEFAULT_SETTINGS } from '../../src/settings/defaults';
import { toStatusRules } from '../../src/settings/statusCatalogAdapter';
import type { CalendarSettings } from '../../src/settings/types';
import { TaskApplicationService } from '../../src/tasks/application/TaskApplicationService';
import type { TaskBehaviorSettingsProvider } from '../../src/tasks/application/TaskBehaviorSettings';
import type { TaskDestinationProvider } from '../../src/tasks/application/TaskDestinationProvider';
import type { TaskDraft, TaskRepository } from '../../src/tasks/application/TaskRepository';
import { StatusCatalog } from '../../src/tasks/domain/StatusCatalog';
import type { TaskDestination, TaskRef, TaskSnapshot } from '../../src/tasks/domain/types';
import { localDate } from '../../src/tasks/domain/validation';
import { TaskIndex } from '../../src/tasks/infrastructure/TaskIndex';
import { TaskBlockEditor } from '../../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { TaskLocator } from '../../src/tasks/infrastructure/markdown/TaskLocator';
import { TaskMarkdownCodec } from '../../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import {
  ObsidianTaskDestinationProvider,
  type ConfiguredTaskDestination,
} from '../../src/tasks/infrastructure/obsidian/ObsidianTaskDestinationProvider';
import { ObsidianTaskRepository } from '../../src/tasks/infrastructure/obsidian/ObsidianTaskRepository';
import {
  CaptureTargetResolver,
  commandBodyForCapture,
} from '../../src/ui/taskCapture/CaptureTargetResolver';
import { presentTaskCreationResult } from '../../src/ui/taskCommandResult';
import {
  captureChangedCallback,
  configuredTaskApplication,
  createAppWithFiles,
  expectDefined,
  flushMicrotasks,
  methodOf,
  taskQueryApi,
  useRealMoment,
  type TestTaskQueries,
} from '../helpers';
import { InMemoryTaskRepository } from '../support/InMemoryTaskRepository';

vi.mock('obsidian', async () => {
  const actual = await vi.importActual<typeof ObsidianModule>('obsidian');
  return { ...actual, Notice: vi.fn() };
});

type Adapter = 'in-memory' | 'obsidian';

useRealMoment();

interface Harness {
  readonly repository: TaskRepository;
  readonly snapshots: (content: string) => readonly TaskSnapshot[];
  readonly read: () => Promise<string>;
}

const path = 'tasks.md';
const appendDestination: TaskDestination = { filePath: path, insertion: { type: 'append' } };

type ApplicationResult = Awaited<ReturnType<TaskApplicationService['execute']>>;

function taskFrom(result: ApplicationResult, message: string): TaskSnapshot {
  if (result.type !== 'ok' || result.outcome.type !== 'task') throw new Error(message);
  return result.outcome.task;
}

function fileAt(app: App, filePath: string): TFile {
  const file = app.vault.getAbstractFileByPath(filePath);
  expect(file).toBeInstanceOf(TFile);
  if (!(file instanceof TFile)) throw new Error(`missing ${filePath}`);
  return file;
}

async function makeHarness(adapter: Adapter, source: string): Promise<Harness> {
  const app = await createAppWithFiles({ [path]: source });
  const catalog = new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses));
  const codec = new TaskMarkdownCodec(catalog);
  const index = new TaskIndex(app, {
    statusCatalog: catalog,
  });
  const snapshots = (content: string) => index.snapshotsFromContent(path, content);
  if (adapter === 'in-memory') {
    const repository = new InMemoryTaskRepository({
      files: { [path]: source },
      codec,
      snapshotsFromContent: (_path, content) => snapshots(content),
    });
    return { repository, snapshots, read: async () => repository.content(path) ?? '' };
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
      if (!(file instanceof TFile)) throw new Error('missing task file');
      return app.vault.cachedRead(file);
    },
  };
}

function applicationFor(
  app: App,
  settings: CalendarSettings,
  isExcludedDestination: (filePath: string) => boolean | Promise<boolean> = () => false,
) {
  const catalog = new StatusCatalog(toStatusRules(settings.taskStatuses));
  const codec = new TaskMarkdownCodec(catalog);
  const index = new TaskIndex(app, {
    statusCatalog: catalog,
  });
  const repository = new ObsidianTaskRepository(app, {
    codec,
    editor: new TaskBlockEditor(),
    locator: new TaskLocator(),
    snapshotsFromContent: (filePath, content) => index.snapshotsFromContent(filePath, content),
  });
  const noteTemplates = new NoteTemplateService(app);
  const provider = new ObsidianTaskDestinationProvider(
    () => configuredDestination(settings),
    (filePath, templatePath, title) => noteTemplates.ensureNote(filePath, templatePath, title),
    isExcludedDestination,
  );
  return new TaskApplicationService(
    index,
    repository,
    catalog,
    { today: () => localDate('2026-07-14') },
    provider,
    () => ({
      taskPrefix: settings.taskPrefix,
      inbox: settings.inbox,
      taskLifecycle: settings.taskLifecycle,
      recurrence: settings.recurrence,
    }),
  );
}

function installTemplater(
  app: App,
  readAndParse: (template: TFile, target: TFile) => Promise<string>,
): void {
  Object.defineProperty(app, 'plugins', {
    configurable: true,
    value: {
      getPlugin: (id: string) =>
        id === 'templater-obsidian'
          ? {
              templater: {
                files_with_pending_templates: new Set<string>(),
                start_templater_task(path: string) {
                  this.files_with_pending_templates.add(path);
                },
                async end_templater_task(path: string) {
                  this.files_with_pending_templates.delete(path);
                },
                create_running_config(template: TFile, target: TFile) {
                  return { template_file: template, target_file: target, run_mode: 2 };
                },
                async read_and_parse_template(config: {
                  template_file: TFile;
                  target_file: TFile;
                }) {
                  return await readAndParse(config.template_file, config.target_file);
                },
              },
            }
          : null,
    },
  });
}

function configuredDestination(settings: CalendarSettings): ConfiguredTaskDestination {
  return {
    taskFilePath: settings.taskFilePath,
    taskTemplatePath: settings.taskTemplatePath,
    capturedToday: '2026-07-14',
    insertion:
      settings.taskInsertionMode === 'section' && settings.taskInsertionSection.trim().length > 0
        ? { type: 'section', heading: settings.taskInsertionSection }
        : { type: 'append' },
  };
}

function rootRef(harness: Harness, content: string, line = 0): TaskRef {
  const task = harness.snapshots(content).find((candidate) => candidate.source.line === line);
  if (task == null) throw new Error(`missing task at line ${line}`);
  return task.ref;
}

const separatorRecoveryCases = [
  ['ordinary subtree control', '- [ ] Root\n  - [ ] Removed\n    - > Description\n  - [ ] Next\n'],
  [
    'quoted subtree control',
    '> - [ ] Root\n>   - [ ] Removed\n>     - > Description\n>   - [ ] Next\n',
  ],
  ['only child after blank', '- [ ] Root\n\n  - [ ] Removed\n'],
  ['last child after blank', '- [ ] Root\n  - [ ] Previous\n\n  - [ ] Removed\n'],
  ['nested only child after blank', '- [ ] Root\n  - [ ] Parent\n\n    - [ ] Removed\n'],
  [
    'nested last child after blank',
    '- [ ] Root\n  - [ ] Parent\n    - [ ] Previous\n\n    - [ ] Removed\n',
  ],
  ['blank before following root', '- [ ] Root\n\n  - [ ] Removed\n- [ ] Following\n'],
  [
    'blank between nested parents',
    '- [ ] Root\n  - [ ] Parent\n\n    - [ ] Removed\n  - [ ] Following\n',
  ],
  [
    'quoted blank within subtree',
    '> - [ ] Root\n>   - [ ] Removed\n>\n>     - > Description\n>   - [ ] Next\n',
  ],
  ['quote-only gap before final child', '> - [ ] Root\n>\n>   - [ ] Removed\n'],
  [
    'nested quote-only gap',
    '> - [ ] Root\n>   - [ ] Parent\n>\n>     - [ ] Removed\n>   - [ ] Following\n',
  ],
] as const;

const separatorRecoveryFixtures = separatorRecoveryCases.flatMap(([name, markdown]) =>
  (['\n', '\r\n'] as const).flatMap((ending) =>
    [true, false].map((finalNewline) => ({
      name: `${name}, ${finalNewline ? 'with' : 'without'} final newline`,
      ending,
      source: (finalNewline ? markdown : markdown.slice(0, -1)).replaceAll('\n', ending),
    })),
  ),
);

async function changeRestorationSibling(
  h: ReturnType<typeof configuredTaskApplication>,
  mode: string,
): Promise<void> {
  const title = mode === 'delete-after' ? 'Previous' : 'Next';
  const sibling = expectDefined(h.index.listNodes().find(({ node }) => node.title === title));
  if (sibling.target.type !== 'subtask') throw new Error('missing sibling');
  const result =
    mode === 'change-before'
      ? await h.tasks.execute({
          type: 'patch',
          target: sibling.target,
          patch: { markdownTitle: { type: 'set', value: 'Changed' } },
        })
      : await h.tasks.execute({ type: 'delete-subtask', subtask: sibling.target.ref });
  expect(result.type).toBe('ok');
}

for (const adapter of ['in-memory', 'obsidian'] as const) {
  describe(`${adapter} subtask removal recovery`, () => {
    const removed =
      '    - [ ] Removed [[Link]] 🧩 unknown 🆔 child ⛔ absent\r\n' +
      '      - > Description with [link](https://example.com)\r\n' +
      '      - 2026-09-05T09:00:00+00:00: Comment\r\n' +
      '      - [ ] Nested 🧲 unknown\r\n';
    const prefix = '# Tasks\r\n- [ ] Root\r\n  - [ ] Parent\r\n    - [ ] Previous\r\n';
    const suffix = '    - [ ] Next\r\n  - [ ] Other\r\n- [ ] Neighbor\r\n';
    const source = prefix + removed + suffix;

    it.each(separatorRecoveryFixtures)(
      'restores preserved separators: $name ($ending)',
      async ({ source: original }) => {
        const harness = await makeHarness(adapter, original);
        const root = expectDefined(harness.snapshots(original)[0]);
        const child = expectDefined(
          root.subtasks
            .flatMap((node) => [node, ...node.subtasks])
            .find((node) => node.title === 'Removed'),
        );
        const deleted = await harness.repository.edit({
          type: 'delete-subtask',
          subtask: child.ref,
        });
        expect(deleted.type).toBe('committed');
        if (deleted.type !== 'committed' || deleted.outcome.type !== 'task')
          throw new Error('delete failed');
        const recovery = expectDefined(deleted.outcome.subtaskRemovalRecovery);
        expect((await harness.repository.edit({ type: 'restore-subtask', ...recovery })).type).toBe(
          'committed',
        );
        expect(await harness.read()).toBe(original);
      },
    );

    it.each([
      '- [ ] Root\nNot a separator\n',
      '- [ ] Root\n>\n',
      '- [ ] Root\n',
      '> - [ ] Root\n>>\n',
    ])('does not cross a changed or incompatible separator gap: %j', async (original) => {
      const harness = await makeHarness(adapter, original);
      const root = expectDefined(harness.snapshots(original)[0]);
      const result = await harness.repository.edit({
        type: 'restore-subtask',
        parent: { type: 'task', ref: root.ref },
        markdown: original.startsWith('>') ? '>   - [ ] Removed\n' : '  - [ ] Removed\n',
        placement: { relativeLine: 2 },
      });
      expect(result.type).toBe('conflict');
      expect(await harness.read()).toBe(original);
    });

    it.each([
      { source: '- [ ] Root\n', relativeLine: 3 },
      { source: '# LF\n# CRLF\r\n- [ ] Root\r\n', relativeLine: 2 },
    ])(
      'does not invent missing or ambiguous EOF gaps: $source',
      async ({ source: original, relativeLine }) => {
        const harness = await makeHarness(adapter, original);
        const root = expectDefined(harness.snapshots(original)[0]);
        const result = await harness.repository.edit({
          type: 'restore-subtask',
          parent: { type: 'task', ref: root.ref },
          markdown: '  - [ ] Removed',
          placement: { relativeLine },
        });
        expect(result.type).toBe('conflict');
        expect(await harness.read()).toBe(original);
      },
    );

    it('uses anchor ending context for a preserved EOF gap instead of the optional separator', async () => {
      const original = '- [ ] Root\r\n  - [ ] Previous\r\n';
      const harness = await makeHarness(adapter, original);
      const root = expectDefined(harness.snapshots(original)[0]);
      expect(
        (
          await harness.repository.edit({
            type: 'restore-subtask',
            parent: { type: 'task', ref: root.ref },
            markdown: '  - [ ] Removed',
            placement: {
              relativeLine: 3,
              after: expectDefined(root.subtasks[0]).ref,
              lineEnding: '\n',
            },
          })
        ).type,
      ).toBe('committed');
      expect(await harness.read()).toBe(`${original}\r\n  - [ ] Removed`);
    });

    it('rejects a relocated parent for out-of-block anchored placement', async () => {
      const original = '- [ ] Root\n  - [ ] Previous\n\n  - [ ] Removed\n';
      const harness = await makeHarness(adapter, original);
      const root = expectDefined(harness.snapshots(original)[0]);
      const deleted = await harness.repository.edit({
        type: 'delete-subtask',
        subtask: expectDefined(root.subtasks[1]).ref,
      });
      if (deleted.type !== 'committed' || deleted.outcome.type !== 'task')
        throw new Error('delete failed');
      const relocated = `# Shifted\n${await harness.read()}`;
      const current = await makeHarness(adapter, relocated);
      expect(
        (
          await current.repository.edit({
            type: 'restore-subtask',
            ...expectDefined(deleted.outcome.subtaskRemovalRecovery),
          })
        ).type,
      ).toBe('conflict');
      expect(await current.read()).toBe(relocated);
    });

    it.each([
      '>   - [ ] Removed\n>>\n>     - > Description\n',
      '>   - [ ] Removed\n>\n>>     - > Wrong depth\n',
      '>   - [ ] Removed\n>\n>   - [ ] Sibling injection\n',
    ])('rejects incompatible quoted subtree content: %j', async (markdown) => {
      const original = '> - [ ] Root\n';
      const harness = await makeHarness(adapter, original);
      const root = expectDefined(harness.snapshots(original)[0]);
      expect(
        (
          await harness.repository.edit({
            type: 'restore-subtask',
            parent: { type: 'task', ref: root.ref },
            markdown,
            placement: { relativeLine: 1 },
          })
        ).type,
      ).toBe('invalid');
      expect(await harness.read()).toBe(original);
    });

    it('returns exact subtree bytes and committed neighboring references for restoration', async () => {
      const harness = await makeHarness(adapter, source);
      const root = expectDefined(harness.snapshots(source)[0]);
      const parent = expectDefined(root.subtasks[0]);
      const deleted = await harness.repository.edit({
        type: 'delete-subtask',
        subtask: expectDefined(parent.subtasks[1]).ref,
      });
      expect(await harness.read()).toBe(prefix + suffix);
      expect(deleted.type).toBe('committed');
      if (deleted.type !== 'committed' || deleted.outcome.type !== 'task') return;
      const freshParent = expectDefined(deleted.outcome.task.subtasks[0]);
      const recovery = deleted.outcome.subtaskRemovalRecovery;
      expect(recovery).toEqual({
        parent: { type: 'subtask', ref: freshParent.ref },
        markdown: removed,
        placement: {
          relativeLine: 2,
          after: freshParent.subtasks[0]?.ref,
          before: freshParent.subtasks[1]?.ref,
        },
      });
      if (recovery === undefined) return;
      expect(Object.isFrozen(deleted.outcome)).toBe(true);
      expect(Object.isFrozen(deleted.outcome.task)).toBe(true);
      expect(Object.isFrozen(recovery)).toBe(true);
      expect(Object.isFrozen(recovery.placement)).toBe(true);
      expect(Object.isFrozen(recovery.parent.ref)).toBe(true);
      expect(recovery.parent.ref).not.toBe(freshParent.ref);
      expect(recovery.placement.before).not.toBe(freshParent.subtasks[1]?.ref);
      expect(() => Object.assign(recovery.placement, { relativeLine: 99 })).toThrow(TypeError);
      expect(() => Object.assign(recovery.parent.ref, { originalBlock: 'changed' })).toThrow(
        TypeError,
      );
      const restored = await harness.repository.edit({ type: 'restore-subtask', ...recovery });
      expect(restored.type).toBe('committed');
      expect(await harness.read()).toBe(source);
    });

    it.each(['first', 'last', 'only'] as const)(
      'restores a %s child without a final newline',
      async (position) => {
        const children = position === 'only' ? ['Removed'] : ['First', 'Last'];
        const childMarkdown = children.map((title) => `  - [ ] ${title}`).join('\r\n');
        const original = `- [ ] Root\r\n${childMarkdown}`;
        const harness = await makeHarness(adapter, original);
        const root = expectDefined(harness.snapshots(original)[0]);
        const child = expectDefined(root.subtasks[position === 'last' ? 1 : 0]);
        const deleted = await harness.repository.edit({
          type: 'delete-subtask',
          subtask: child.ref,
        });
        if (deleted.type !== 'committed' || deleted.outcome.type !== 'task')
          throw new Error('delete failed');
        expect(deleted.outcome.subtaskRemovalRecovery).toBeDefined();
        const recovery = deleted.outcome.subtaskRemovalRecovery;
        if (recovery === undefined) return;
        expect((await harness.repository.edit({ type: 'restore-subtask', ...recovery })).type).toBe(
          'committed',
        );
        expect(await harness.read()).toBe(original);
      },
    );

    it.each([
      'not a task\n',
      '- [ ] Root-level injection\n',
      '  - [ ] Child\n- [ ] Escaped root\n',
      '  - [ ] Child\n  - [ ] Second subtree\n',
      '>   - [ ] Different quote depth\n',
    ])('rejects malformed or foreign subtree Markdown %j without a write', async (markdown) => {
      const original = '- [ ] Root\n';
      const harness = await makeHarness(adapter, original);
      const root = expectDefined(harness.snapshots(original)[0]);
      const result = await harness.repository.edit({
        type: 'restore-subtask',
        parent: { type: 'task', ref: root.ref },
        markdown,
        placement: { relativeLine: 1 },
      });
      expect(result.type).toBe('invalid');
      expect(await harness.read()).toBe(original);
    });

    it('rejects changed anchor bytes even when the caller has a fresh parent reference', async () => {
      const original = '- [ ] Root\n  - [ ] Changed\n';
      const harness = await makeHarness(adapter, original);
      const root = expectDefined(harness.snapshots(original)[0]);
      const result = await harness.repository.edit({
        type: 'restore-subtask',
        parent: { type: 'task', ref: root.ref },
        markdown: '  - [ ] Removed\n',
        placement: {
          relativeLine: 1,
          before: { ...expectDefined(root.subtasks[0]).ref, originalBlock: '  - [ ] Original' },
        },
      });
      expect(result.type).toBe('conflict');
      expect(await harness.read()).toBe(original);
    });

    it.each(['\n', '\r\n'] as const)(
      'restores the only EOF child using its consumed %j separator',
      async (ending) => {
        const original = `- [ ] Root${ending}  - [ ] Removed`;
        const harness = await makeHarness(adapter, original);
        const root = expectDefined(harness.snapshots(original)[0]);
        const deleted = await harness.repository.edit({
          type: 'delete-subtask',
          subtask: expectDefined(root.subtasks[0]).ref,
        });
        if (deleted.type !== 'committed' || deleted.outcome.type !== 'task')
          throw new Error('delete failed');
        expect(await harness.read()).toBe('- [ ] Root');
        const recovery = expectDefined(deleted.outcome.subtaskRemovalRecovery);
        expect(recovery.placement.lineEnding).toBe(ending);
        expect((await harness.repository.edit({ type: 'restore-subtask', ...recovery })).type).toBe(
          'committed',
        );
        expect(await harness.read()).toBe(original);
      },
    );

    it.each(['before', 'after'] as const)(
      'ignores the consumed separator when the %s anchor supplies insertion context',
      async (anchor) => {
        const original =
          anchor === 'before' ? '- [ ] Root\r\n  - [ ] Next\r\n' : '- [ ] Root\r\n  - [ ] Previous';
        const harness = await makeHarness(adapter, original);
        const root = expectDefined(harness.snapshots(original)[0]);
        const result = await harness.repository.edit({
          type: 'restore-subtask',
          parent: { type: 'task', ref: root.ref },
          markdown: anchor === 'before' ? '  - [ ] Removed\r\n' : '  - [ ] Removed',
          placement: {
            relativeLine: anchor === 'before' ? 1 : 2,
            ...(anchor === 'before'
              ? { before: expectDefined(root.subtasks[0]).ref }
              : { after: expectDefined(root.subtasks[0]).ref }),
            lineEnding: '\n',
          },
        });
        expect(result.type).toBe('committed');
        expect(await harness.read()).toBe(
          anchor === 'before'
            ? '- [ ] Root\r\n  - [ ] Removed\r\n  - [ ] Next\r\n'
            : '- [ ] Root\r\n  - [ ] Previous\r\n  - [ ] Removed',
        );
      },
    );

    it('rejects a malformed separator without writing', async () => {
      const original = '- [ ] Root';
      const harness = await makeHarness(adapter, original);
      const root = expectDefined(harness.snapshots(original)[0]);
      const result = await harness.repository.edit({
        type: 'restore-subtask',
        parent: { type: 'task', ref: root.ref },
        markdown: '  - [ ] Removed',
        placement: { relativeLine: 1, lineEnding: 'garbage' as '\n' },
      });
      expect(result.type).toBe('invalid');
      expect(await harness.read()).toBe(original);
    });

    it.each(['- [ ] Root', '# LF\n# CRLF\r\n- [ ] Root'])(
      'conflicts without a captured separator when the current bytes do not prove one ending: %j',
      async (original) => {
        const harness = await makeHarness(adapter, original);
        const root = expectDefined(harness.snapshots(original)[0]);
        const result = await harness.repository.edit({
          type: 'restore-subtask',
          parent: { type: 'task', ref: root.ref },
          markdown: '  - [ ] Removed',
          placement: { relativeLine: 1 },
        });
        expect(result.type).toBe('conflict');
        expect(await harness.read()).toBe(original);
      },
    );
  });
}

for (const adapter of ['in-memory', 'obsidian'] as const) {
  describe(`${adapter} root task lifecycle contract`, () => {
    it.each([
      {
        name: 'an empty destination',
        source: '',
        expected: '- [ ] new task 📅 2026-07-20',
      },
      {
        name: 'LF with a final newline',
        source: '# Tasks\n',
        expected: '# Tasks\n- [ ] new task 📅 2026-07-20\n',
      },
      {
        name: 'LF without a final newline',
        source: '# Tasks',
        expected: '# Tasks\n- [ ] new task 📅 2026-07-20',
      },
      {
        name: 'CRLF with a final newline',
        source: '# Tasks\r\n',
        expected: '# Tasks\r\n- [ ] new task 📅 2026-07-20\r\n',
      },
      {
        name: 'CRLF without a final newline',
        source: '# Tasks\r\nnotes',
        expected: '# Tasks\r\nnotes\r\n- [ ] new task 📅 2026-07-20',
      },
    ])(
      'appends losslessly for $name and returns the exact inserted snapshot',
      async ({ source, expected }) => {
        const harness = await makeHarness(adapter, source);
        const result = await harness.repository.create(appendDestination, {
          markdownBody: 'new task',
          initial: { due: { type: 'set', value: localDate('2026-07-20') } },
        });

        expect(result).toMatchObject({
          type: 'committed',
          changed: true,
          outcome: {
            type: 'task',
            task: {
              markdownTitle: 'new task',
              planning: { due: '2026-07-20' },
              source: { filePath: path },
            },
          },
        });
        expect(await harness.read()).toBe(expected);
        if (result.type === 'committed' && result.outcome.type === 'task') {
          const taskAt = expected.indexOf('- [ ] new task');
          expect(result.outcome.task.source.line).toBe(
            expected.slice(0, taskAt).split(/\r?\n/u).length - 1,
          );
        }
      },
    );

    it('inserts under an explicit section and preserves Tasks carriers without generating an ID', async () => {
      const source = '# Project\n\n## Tasks\n- [ ] existing\n\n## Notes\n';
      const harness = await makeHarness(adapter, source);
      const destination: TaskDestination = {
        filePath: path,
        insertion: { type: 'section', heading: '## Tasks' },
      };

      const result = await harness.repository.create(destination, {
        markdownBody: 'linked 🆔 existing-id ⛔ dep_1 ^keep',
      });

      expect(result).toMatchObject({
        type: 'committed',
        outcome: { type: 'task', task: { source: { filePath: path, line: 3 } } },
      });
      const content = await harness.read();
      expect(content).toContain(
        '## Tasks\n- [ ] linked 🆔 existing-id ⛔ dep_1 ^keep\n- [ ] existing',
      );
      expect(content).not.toMatch(/🆔 (?!existing-id)/u);
    });

    it('creates a missing section and returns the inserted duplicate by its known offset', async () => {
      const source = '# Project\n- [ ] duplicate\n';
      const harness = await makeHarness(adapter, source);
      const destination: TaskDestination = {
        filePath: path,
        insertion: { type: 'section', heading: '## Tasks' },
      };

      const result = await harness.repository.create(destination, { markdownBody: 'duplicate' });

      expect(await harness.read()).toBe('## Tasks\n- [ ] duplicate\n# Project\n- [ ] duplicate\n');
      expect(result).toMatchObject({
        type: 'committed',
        outcome: { type: 'task', task: { source: { line: 1 } } },
      });
    });

    it('parses the body then replaces one initial field and rejects duplicate target fields atomically', async () => {
      const harness = await makeHarness(adapter, '- [ ] existing\n');

      await expect(
        harness.repository.create(appendDestination, {
          markdownBody: 'one due 📅 2026-07-19',
          initial: { due: { type: 'set', value: localDate('2026-07-20') } },
        }),
      ).resolves.toMatchObject({
        type: 'committed',
        outcome: { type: 'task', task: { planning: { due: '2026-07-20' } } },
      });

      const beforeDuplicate = await harness.read();
      await expect(
        harness.repository.create(appendDestination, {
          markdownBody: 'duplicate 📅 2026-07-18 📅 2026-07-19',
          initial: { due: { type: 'set', value: localDate('2026-07-20') } },
        }),
      ).resolves.toEqual({
        type: 'invalid',
        issues: [{ code: 'duplicate-field', field: 'due' }],
      });
      expect(await harness.read()).toBe(beforeDuplicate);
    });

    it('inserts one stamped task block and never writes an invalid second root', async () => {
      const harness = await makeHarness(adapter, '# Tasks\n');
      const draft: TaskDraft & { today: ReturnType<typeof localDate>; addCreatedDate: boolean } = {
        markdownBody: 'Parent\n  - [ ] Child',
        today: localDate('2026-08-01'),
        addCreatedDate: true,
      };

      await expect(harness.repository.create(appendDestination, draft)).resolves.toMatchObject({
        type: 'committed',
        outcome: {
          type: 'task',
          task: {
            planning: { created: '2026-08-01' },
            subtasks: [{ planning: { created: '2026-08-01' } }],
          },
        },
      });
      expect(await harness.read()).toBe(
        '# Tasks\n- [ ] Parent ➕ 2026-08-01\n  - [ ] Child ➕ 2026-08-01\n',
      );

      const before = await harness.read();
      await expect(
        harness.repository.create(appendDestination, {
          ...draft,
          markdownBody: 'Parent\n- [ ] Second root',
        }),
      ).resolves.toMatchObject({ type: 'invalid' });
      expect(await harness.read()).toBe(before);
    });

    it('deletes the exact confirmed root and its complete nested block', async () => {
      const source =
        '- [ ] root\n  - > description\n  - [ ] child\n    - [ ] descendant\n- [ ] keep\n';
      const harness = await makeHarness(adapter, source);
      const ref = rootRef(harness, source);

      await expect(harness.repository.edit({ type: 'delete', ref })).resolves.toEqual({
        type: 'committed',
        outcome: { type: 'deleted', ref },
        changed: true,
      });
      expect(await harness.read()).toBe('- [ ] keep\n');
    });

    it('never deletes a same-line replacement through a stale reference', async () => {
      const source = '- [ ] original\n- [ ] keep\n';
      const harness = await makeHarness(adapter, source);
      const stale = rootRef(harness, source);
      await harness.repository.edit({
        type: 'patch',
        target: { type: 'task', ref: stale },
        patch: { markdownTitle: { type: 'set', value: 'replacement' } },
      });
      const changed = await harness.read();

      await expect(harness.repository.edit({ type: 'delete', ref: stale })).resolves.toMatchObject({
        type: 'conflict',
        current: { markdownTitle: 'replacement' },
      });
      expect(await harness.read()).toBe(changed);
    });
  });
}

describe('TaskApplicationService lifecycle routing', () => {
  const queries: TestTaskQueries = taskQueryApi();
  const catalog = new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses));
  const clock = { today: () => localDate('2026-07-14') };
  const committedTask = {
    ref: { filePath: path, line: 0, revision: 'created' },
    title: 'created',
    markdownTitle: 'created',
    status: 'open',
    statusSymbol: ' ',
    priority: 'D',
    onCompletion: 'keep' as const,
    onCompletionExplicit: false,
    planning: {},
    tags: [],
    dependsOn: [],
    subtasks: [],
    comments: [],
    timeEntries: [],
    source: {
      filePath: path,
      line: 0,
      originalMarkdown: '- [ ] created',
      originalBlock: '- [ ] created',
    },
    presentation: { linkCount: 0 },
  } satisfies TaskSnapshot;

  it('resolves only configured-default creation before delegating the exact draft', async () => {
    const create = vi.fn<TaskRepository['create']>().mockResolvedValue({
      type: 'committed',
      outcome: { type: 'task', task: committedTask },
      changed: true,
    });
    const edit = vi.fn<TaskRepository['edit']>();
    const destinationProvider: TaskDestinationProvider = {
      planConfiguredDefault: vi.fn(),
      planExplicit: vi.fn(),
      resolveConfiguredDefault: vi.fn().mockResolvedValue({
        type: 'resolved',
        destination: appendDestination,
      }),
      prepare: vi.fn().mockResolvedValue({ type: 'unavailable' }),
    };
    const application = new TaskApplicationService(
      queries,
      {
        edit,
        editBatch: vi.fn(),
        createDependencySubtask: vi.fn(),
        completeRecurrence: vi.fn(),
        create,
        move: vi.fn(),
      },
      catalog,
      clock,
      destinationProvider,
    );
    const draft: TaskDraft = {
      markdownBody: 'created',
      initial: { due: { type: 'set', value: localDate('2026-07-20') } },
    };

    await expect(
      application.execute({
        type: 'create',
        destination: { type: 'configured-default' },
        ...draft,
      }),
    ).resolves.toEqual({
      type: 'ok',
      outcome: { type: 'task', task: committedTask },
      changed: true,
    });
    expect(methodOf(destinationProvider, 'resolveConfiguredDefault')).toHaveBeenCalledOnce();
    expect(methodOf(destinationProvider, 'prepare')).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(appendDestination, {
      ...draft,
      today: localDate('2026-07-14'),
      addCreatedDate: true,
    });
    expect(edit).not.toHaveBeenCalled();
  });

  it('passes an explicit destination through and reports unavailable configured defaults', async () => {
    const create = vi.fn<TaskRepository['create']>().mockResolvedValue({
      type: 'committed',
      outcome: { type: 'task', task: committedTask },
      changed: true,
    });
    const provider: TaskDestinationProvider = {
      planConfiguredDefault: vi.fn(),
      planExplicit: vi.fn<TaskDestinationProvider['planExplicit']>(async (destination) => ({
        destination,
        prepare: async () => ({ type: 'resolved' as const, destination }),
      })),
      resolveConfiguredDefault: vi.fn().mockResolvedValue({ type: 'unavailable' }),
      prepare: vi.fn().mockResolvedValue({
        type: 'resolved',
        destination: appendDestination,
      }),
    };
    const application = new TaskApplicationService(
      queries,
      {
        edit: vi.fn(),
        editBatch: vi.fn(),
        createDependencySubtask: vi.fn(),
        completeRecurrence: vi.fn(),
        create,
        move: vi.fn(),
      },
      catalog,
      clock,
      provider,
    );

    await application.execute({
      type: 'create',
      destination: { type: 'explicit', destination: appendDestination },
      markdownBody: 'explicit',
    });
    expect(methodOf(provider, 'resolveConfiguredDefault')).not.toHaveBeenCalled();
    expect(methodOf(provider, 'prepare')).not.toHaveBeenCalled();
    expect(methodOf(provider, 'planExplicit')).toHaveBeenNthCalledWith(1, appendDestination, {
      provision: false,
    });
    expect(create).toHaveBeenCalledWith(appendDestination, {
      markdownBody: 'explicit',
      today: localDate('2026-07-14'),
      addCreatedDate: true,
    });

    create.mockClear();
    await application.execute({
      type: 'create',
      destination: {
        type: 'explicit',
        destination: appendDestination,
        provision: 'if-missing',
      },
      markdownBody: 'prepared',
    });
    expect(methodOf(provider, 'planExplicit')).toHaveBeenNthCalledWith(2, appendDestination, {
      provision: true,
    });
    expect(create).toHaveBeenCalledWith(appendDestination, {
      markdownBody: 'prepared',
      today: localDate('2026-07-14'),
      addCreatedDate: true,
    });

    await expect(
      application.execute({
        type: 'create',
        destination: { type: 'configured-default' },
        markdownBody: 'missing',
      }),
    ).resolves.toEqual({
      type: 'invalid',
      issues: [{ code: 'destination-unavailable', field: 'destination' }],
    });
  });

  it.each([
    {
      name: 'existing explicit file',
      destination: { type: 'explicit' as const, destination: appendDestination },
      expectedPlan: { provision: false },
    },
    {
      name: 'provisioned explicit file',
      destination: {
        type: 'explicit' as const,
        destination: appendDestination,
        provision: 'if-missing' as const,
      },
      expectedPlan: { provision: true },
    },
  ])(
    'rejects an excluded $name before repository creation',
    async ({ destination, expectedPlan }) => {
      const create = vi.fn<TaskRepository['create']>();
      const provider: TaskDestinationProvider = {
        planConfiguredDefault: vi.fn(),
        planExplicit: vi.fn<TaskDestinationProvider['planExplicit']>(async (planned) => ({
          destination: planned,
          prepare: async () => ({ type: 'unavailable' as const }),
        })),
        resolveConfiguredDefault: vi.fn(),
        prepare: vi.fn(),
      };
      const application = new TaskApplicationService(
        queries,
        {
          edit: vi.fn(),
          editBatch: vi.fn(),
          createDependencySubtask: vi.fn(),
          completeRecurrence: vi.fn(),
          create,
          move: vi.fn(),
        },
        catalog,
        clock,
        provider,
      );

      await expect(
        application.execute({ type: 'create', destination, markdownBody: 'blocked' }),
      ).resolves.toEqual({
        type: 'invalid',
        issues: [{ code: 'destination-unavailable', field: 'destination' }],
      });
      expect(methodOf(provider, 'planExplicit')).toHaveBeenCalledWith(
        appendDestination,
        expectedPlan,
      );
      expect(create).not.toHaveBeenCalled();
    },
  );

  it('normalizes and validates initial tags before creation', async () => {
    const create = vi.fn<TaskRepository['create']>().mockResolvedValue({
      type: 'committed',
      outcome: { type: 'task', task: committedTask },
      changed: true,
    });
    const application = new TaskApplicationService(
      queries,
      {
        edit: vi.fn(),
        editBatch: vi.fn(),
        createDependencySubtask: vi.fn(),
        completeRecurrence: vi.fn(),
        create,
        move: vi.fn(),
      },
      catalog,
      clock,
    );

    await application.execute({
      type: 'create',
      destination: { type: 'explicit', destination: appendDestination },
      markdownBody: 'tagged',
      initial: { tags: { add: ['work', '#work'], remove: ['later'] } },
    });
    expect(create).toHaveBeenCalledWith(appendDestination, {
      markdownBody: 'tagged',
      initial: { tags: { add: ['#work'], remove: ['#later'] } },
      today: localDate('2026-07-14'),
      addCreatedDate: true,
    });

    create.mockClear();
    await expect(
      application.execute({
        type: 'create',
        destination: { type: 'explicit', destination: appendDestination },
        markdownBody: 'bad tags',
        initial: { tags: { add: ['bad!'] } },
      }),
    ).resolves.toEqual({
      type: 'invalid',
      issues: [{ code: 'invalid-target', field: 'tags' }],
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('preserves legacy destination-error precedence over invalid initial tags', async () => {
    const create = vi.fn<TaskRepository['create']>();
    const destinationProvider = {
      planConfiguredDefault: vi.fn(),
      planExplicit: vi.fn(),
      resolveConfiguredDefault: vi.fn().mockResolvedValue({ type: 'unavailable' as const }),
      prepare: vi.fn(),
    } satisfies TaskDestinationProvider;
    const application = new TaskApplicationService(
      queries,
      {
        edit: vi.fn(),
        editBatch: vi.fn(),
        createDependencySubtask: vi.fn(),
        completeRecurrence: vi.fn(),
        create,
        move: vi.fn(),
      },
      catalog,
      clock,
      destinationProvider,
    );

    await expect(
      application.execute({
        type: 'create',
        destination: { type: 'configured-default' },
        markdownBody: 'invalid tag target',
        initial: { tags: { add: ['bad tag'] } },
      }),
    ).resolves.toEqual({
      type: 'invalid',
      issues: [{ code: 'destination-unavailable', field: 'destination' }],
    });
    expect(destinationProvider.resolveConfiguredDefault).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
  });

  it('plans without provisioning and freezes clock, behavior, and preparation once per session', async () => {
    const create = vi.fn<TaskRepository['create']>().mockResolvedValue({
      type: 'committed',
      outcome: { type: 'task', task: committedTask },
      changed: true,
    });
    const prepare = vi.fn().mockResolvedValue({
      type: 'resolved' as const,
      destination: appendDestination,
    });
    const destinationProvider = {
      planConfiguredDefault: vi.fn().mockResolvedValue({
        destination: appendDestination,
        prepare,
      }),
      planExplicit: vi.fn(),
      resolveConfiguredDefault: vi.fn(),
      prepare: vi.fn(),
    } satisfies TaskDestinationProvider;
    let today = localDate('2026-07-14');
    let addCreatedDate = true;
    let taskPrefix = 'Plan #inbox';
    let inbox = { mode: 'tag' as const, tag: '#inbox', removeTagOnAssign: true };
    const clock = vi.fn(() => today);
    const behavior = vi.fn<TaskBehaviorSettingsProvider>(() => ({
      taskPrefix,
      inbox,
      taskLifecycle: { addCreatedDate, addCompletionDate: true },
      recurrence: { newOccurrencePlacement: 'before', removeScheduledDate: false },
    }));
    const application = new TaskApplicationService(
      queries,
      {
        edit: vi.fn(),
        editBatch: vi.fn(),
        createDependencySubtask: vi.fn(),
        completeRecurrence: vi.fn(),
        create,
        move: vi.fn(),
      },
      catalog,
      { today: clock },
      destinationProvider,
      behavior,
    );

    const session = await application.planCreate({ type: 'configured-default' });

    expect(session).toMatchObject({ type: 'ready', destination: appendDestination });
    expect(destinationProvider.planConfiguredDefault).toHaveBeenCalledOnce();
    expect(prepare).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(clock).toHaveBeenCalledOnce();
    expect(behavior).toHaveBeenCalledOnce();

    today = localDate('2026-08-22');
    addCreatedDate = false;
    taskPrefix = 'Changed';
    inbox = { mode: 'tag', tag: '#changed', removeTagOnAssign: false };
    await session.execute({
      markdownBody: 'first planned task',
      initial: { tags: { add: ['#work'] } },
    });
    await session.execute({ markdownBody: 'second planned task' });

    expect(prepare).toHaveBeenCalledOnce();
    expect(create).toHaveBeenNthCalledWith(1, appendDestination, {
      markdownBody: 'Plan #inbox first planned task',
      initial: { tags: { add: ['#work'], remove: ['#inbox'] } },
      today: localDate('2026-07-14'),
      addCreatedDate: true,
    });
    expect(create).toHaveBeenNthCalledWith(2, appendDestination, {
      markdownBody: 'Plan #inbox second planned task',
      today: localDate('2026-07-14'),
      addCreatedDate: true,
    });
    expect(clock).toHaveBeenCalledOnce();
    expect(behavior).toHaveBeenCalledOnce();
  });

  it('retries an unavailable prepared destination through the same capture session', async () => {
    const create = vi.fn<TaskRepository['create']>().mockResolvedValue({
      type: 'committed',
      outcome: { type: 'task', task: committedTask },
      changed: true,
    });
    const prepare = vi
      .fn()
      .mockResolvedValueOnce({ type: 'unavailable' as const })
      .mockResolvedValueOnce({ type: 'resolved' as const, destination: appendDestination });
    const destinationProvider = {
      planConfiguredDefault: vi.fn().mockResolvedValue({ destination: appendDestination, prepare }),
      planExplicit: vi.fn(),
      resolveConfiguredDefault: vi.fn(),
      prepare: vi.fn(),
    } satisfies TaskDestinationProvider;
    const application = new TaskApplicationService(
      queries,
      {
        edit: vi.fn(),
        editBatch: vi.fn(),
        createDependencySubtask: vi.fn(),
        completeRecurrence: vi.fn(),
        create,
        move: vi.fn(),
      },
      catalog,
      clock,
      destinationProvider,
    );

    const session = await application.planCreate({ type: 'configured-default' });

    await expect(session.execute({ markdownBody: 'retry this draft' })).resolves.toEqual({
      type: 'invalid',
      issues: [{ code: 'destination-unavailable', field: 'destination' }],
    });
    await expect(session.execute({ markdownBody: 'retry this draft' })).resolves.toMatchObject({
      type: 'ok',
    });
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledOnce();
  });

  it('returns a frozen executable unavailable session without repository writes', async () => {
    const create = vi.fn<TaskRepository['create']>();
    const destinationProvider = {
      planConfiguredDefault: vi.fn().mockResolvedValue(undefined),
      planExplicit: vi.fn(),
      resolveConfiguredDefault: vi.fn(),
      prepare: vi.fn(),
    } satisfies TaskDestinationProvider;
    const application = new TaskApplicationService(
      queries,
      {
        edit: vi.fn(),
        editBatch: vi.fn(),
        createDependencySubtask: vi.fn(),
        completeRecurrence: vi.fn(),
        create,
        move: vi.fn(),
      },
      catalog,
      clock,
      destinationProvider,
    );

    const session = await application.planCreate({ type: 'configured-default' });

    expect(session.type).toBe('unavailable');
    await expect(session.execute({ markdownBody: 'preserve this draft' })).resolves.toEqual({
      type: 'invalid',
      issues: [{ code: 'destination-unavailable', field: 'destination' }],
    });
    expect(destinationProvider.planConfiguredDefault).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
  });

  it('records destination planning failures while preserving the unavailable capture result', async () => {
    const failure = new Error('invalid task path');
    const diagnostics = vi.fn();
    const destinationProvider = {
      planConfiguredDefault: vi.fn().mockRejectedValue(failure),
      planExplicit: vi.fn(),
      resolveConfiguredDefault: vi.fn(),
      prepare: vi.fn(),
    } satisfies TaskDestinationProvider;
    const application = new TaskApplicationService(
      queries,
      {
        edit: vi.fn(),
        editBatch: vi.fn(),
        createDependencySubtask: vi.fn(),
        completeRecurrence: vi.fn(),
        create: vi.fn(),
        move: vi.fn(),
      },
      catalog,
      clock,
      destinationProvider,
      undefined,
      undefined,
      diagnostics,
    );

    const session = await application.planCreate({ type: 'configured-default' });

    expect(session.type).toBe('unavailable');
    expect(diagnostics).toHaveBeenCalledWith(
      { operation: 'create', phase: 'unexpected', cause: 'destination-plan' },
      failure,
    );
  });

  it('records destination preparation failures while preserving the capture draft result', async () => {
    const failure = new Error('template failed');
    const diagnostics = vi.fn();
    const destinationProvider = {
      planConfiguredDefault: vi.fn().mockResolvedValue({
        destination: appendDestination,
        prepare: vi.fn().mockRejectedValue(failure),
      }),
      planExplicit: vi.fn(),
      resolveConfiguredDefault: vi.fn(),
      prepare: vi.fn(),
    } satisfies TaskDestinationProvider;
    const application = new TaskApplicationService(
      queries,
      {
        edit: vi.fn(),
        editBatch: vi.fn(),
        createDependencySubtask: vi.fn(),
        completeRecurrence: vi.fn(),
        create: vi.fn(),
        move: vi.fn(),
      },
      catalog,
      clock,
      destinationProvider,
      undefined,
      undefined,
      diagnostics,
    );
    const session = await application.planCreate({ type: 'configured-default' });

    await expect(session.execute({ markdownBody: 'retry this draft' })).resolves.toMatchObject({
      type: 'io-error',
    });
    expect(diagnostics).toHaveBeenCalledWith(
      { operation: 'create', phase: 'unexpected', cause: 'destination-provision' },
      failure,
    );
  });
});

describe('TaskApplicationService subtask recovery', () => {
  it.each(separatorRecoveryFixtures)(
    'restores preserved separators through authority: $name ($ending)',
    async ({ source }) => {
      const app = await createAppWithFiles({ [path]: source });
      const h = configuredTaskApplication(app, DEFAULT_SETTINGS, { authority: true });
      await h.index.initialize();
      h.index.installCommittedContent(path, source);
      try {
        const child = expectDefined(
          h.index.listNodes().find(({ node }) => node.title === 'Removed'),
        );
        if (child.target.type !== 'subtask') throw new Error('missing subtask');
        const deleted = await h.tasks.execute({
          type: 'delete-subtask',
          subtask: child.target.ref,
        });
        expect(deleted.type).toBe('ok');
        if (deleted.type !== 'ok' || deleted.outcome.type !== 'task')
          throw new Error('delete failed');
        expect(
          (
            await h.tasks.execute({
              type: 'restore-subtask',
              ...expectDefined(deleted.outcome.subtaskRemovalRecovery),
            })
          ).type,
        ).toBe('ok');
        expect(await app.vault.read(fileAt(app, path))).toBe(source);
      } finally {
        h.index.destroy();
      }
    },
  );

  it.each([
    'change-before',
    'delete-before',
    'delete-after',
    'swap-anchors',
    'relocate-parent',
    'relocate-without-anchors',
  ] as const)('preserves restoration anchor safety: %s', async (mode) => {
    const source =
      '- [ ] Root\n  - [ ] Parent\n    - [ ] Previous\n    - [ ] Removed\n    - [ ] Next\n  - [ ] Other\n';
    const app = await createAppWithFiles({ [path]: source });
    const h = configuredTaskApplication(app, DEFAULT_SETTINGS, { authority: true });
    await h.index.initialize();
    try {
      const node = expectDefined(h.index.listNodes().find(({ node }) => node.title === 'Removed'));
      if (node.target.type !== 'subtask') throw new Error('missing subtask');
      const deleted = await h.tasks.execute({ type: 'delete-subtask', subtask: node.target.ref });
      if (deleted.type !== 'ok' || deleted.outcome.type !== 'task')
        throw new Error('delete failed');
      const recovery = expectDefined(deleted.outcome.subtaskRemovalRecovery);
      let command = { type: 'restore-subtask' as const, ...recovery };
      if (mode === 'change-before' || mode.startsWith('delete-')) {
        await changeRestorationSibling(h, mode);
      } else if (mode === 'swap-anchors') {
        command = {
          ...command,
          placement: {
            ...command.placement,
            before: expectDefined(command.placement.after),
            after: expectDefined(command.placement.before),
          },
        };
      } else {
        expect(
          (
            await h.tasks.execute({
              type: 'set-description',
              target: { type: 'task', ref: deleted.outcome.task.ref },
              text: 'Header description',
            })
          ).type,
        ).toBe('ok');
        if (mode === 'relocate-without-anchors') {
          command = { ...command, placement: { relativeLine: command.placement.relativeLine } };
        }
      }
      const current = await app.vault.read(fileAt(app, path));
      const restored = await h.tasks.execute(command);
      if (mode === 'relocate-parent') {
        expect(restored.type).toBe('ok');
        expect(await app.vault.read(fileAt(app, path))).toBe(
          source.replace('- [ ] Root\n', '- [ ] Root\n  - > Header description\n'),
        );
      } else {
        expect(restored.type).not.toBe('ok');
        expect(await app.vault.read(fileAt(app, path))).toBe(current);
      }
    } finally {
      h.index.destroy();
    }
  });

  it.each(['revision', 'relocation'] as const)(
    'does not rebase a preserved gap after authority %s',
    async (change) => {
      const source = '- [ ] Root\n  - [ ] Parent\n    - [ ] Previous\n\n    - [ ] Removed\n';
      const app = await createAppWithFiles({ [path]: source });
      const h = configuredTaskApplication(app, DEFAULT_SETTINGS, { authority: true });
      await h.index.initialize();
      try {
        const child = expectDefined(
          h.index.listNodes().find(({ node }) => node.title === 'Removed'),
        );
        if (child.target.type !== 'subtask') throw new Error('missing subtask');
        const deleted = await h.tasks.execute({
          type: 'delete-subtask',
          subtask: child.target.ref,
        });
        if (deleted.type !== 'ok' || deleted.outcome.type !== 'task')
          throw new Error('delete failed');
        const recovery = expectDefined(deleted.outcome.subtaskRemovalRecovery);
        if (change === 'relocation') {
          const relocated = `# Shifted\n${await app.vault.read(fileAt(app, path))}`;
          await app.vault.modify(fileAt(app, path), relocated);
          h.index.installCommittedContent(path, relocated);
        } else
          expect(
            (
              await h.tasks.execute({
                type: 'set-description',
                target: { type: 'task', ref: deleted.outcome.task.ref },
                text: 'Header description',
              })
            ).type,
          ).toBe('ok');
        const current = await app.vault.read(fileAt(app, path));
        expect((await h.tasks.execute({ type: 'restore-subtask', ...recovery })).type).toBe(
          'conflict',
        );
        expect(await app.vault.read(fileAt(app, path))).toBe(current);
      } finally {
        h.index.destroy();
      }
    },
  );

  it('does not select one of identical parents when the captured reference becomes obsolete', async () => {
    const source =
      '\n- [ ] Root\n  - [ ] Parent\n    - [ ] Removed\n    - [ ] Next\n  - [ ] Parent\n    - [ ] Next\n';
    const app = await createAppWithFiles({ [path]: source });
    const h = configuredTaskApplication(app, DEFAULT_SETTINGS, { authority: true });
    await h.index.initialize();
    try {
      const root = expectDefined(h.index.list()[0]);
      const deleted = await h.tasks.execute({
        type: 'delete-subtask',
        subtask: expectDefined(root.subtasks[0]?.subtasks[0]).ref,
      });
      if (deleted.type !== 'ok' || deleted.outcome.type !== 'task')
        throw new Error('delete failed');
      const recovery = expectDefined(deleted.outcome.subtaskRemovalRecovery);
      const changed = await h.tasks.execute({
        type: 'set-description',
        target: { type: 'task', ref: deleted.outcome.task.ref },
        text: 'External change',
      });
      expect(changed.type).toBe('ok');
      const current = await app.vault.read(fileAt(app, path));
      expect((await h.tasks.execute({ type: 'restore-subtask', ...recovery })).type).toBe(
        'conflict',
      );
      expect(await app.vault.read(fileAt(app, path))).toBe(current);
    } finally {
      h.index.destroy();
    }
  });

  it('validates the recovery separator before query resolution or repository I/O', async () => {
    const app = await createAppWithFiles({ [path]: '- [ ] Root' });
    const h = configuredTaskApplication(app, DEFAULT_SETTINGS, { authority: true });
    await h.index.initialize();
    try {
      const root = expectDefined(h.index.list()[0]);
      const resolve = vi.spyOn(h.index, 'resolve');
      const read = vi.spyOn(app.vault, 'read');
      const write = vi.spyOn(app.vault, 'process');
      const result = await h.tasks.execute({
        type: 'restore-subtask',
        parent: { type: 'task', ref: root.ref },
        markdown: '  - [ ] Removed',
        placement: { relativeLine: 1, lineEnding: '\r' as '\n' },
      });
      expect(result.type).toBe('invalid');
      expect(resolve).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    } finally {
      h.index.destroy();
    }
  });

  it('restores through committed authority references and preserves neighboring roots', async () => {
    const source =
      '\n- [ ] Root\r\n  - [ ] Parent\r\n    - [ ] Removed\r\n    - [ ] Next\r\n- [ ] Neighbor\r\n';
    const app = await createAppWithFiles({ [path]: source });
    const h = configuredTaskApplication(app, DEFAULT_SETTINGS, { authority: true });
    await h.index.initialize();
    try {
      const root = expectDefined(h.index.list()[0]);
      const deleted = await h.tasks.execute({
        type: 'delete-subtask',
        subtask: expectDefined(root.subtasks[0]?.subtasks[0]).ref,
      });
      expect(deleted.type).toBe('ok');
      if (deleted.type !== 'ok' || deleted.outcome.type !== 'task') return;
      const recovery = expectDefined(deleted.outcome.subtaskRemovalRecovery);
      expect(recovery.parent).toEqual({
        type: 'subtask',
        ref: deleted.outcome.task.subtasks[0]?.ref,
      });
      expect(h.index.resolve(deleted.outcome.task.ref).type).toBe('exact');
      const restored = await h.tasks.execute({ type: 'restore-subtask', ...recovery });
      expect(restored.type).toBe('ok');
      expect(await app.vault.read(fileAt(app, path))).toBe(source);
    } finally {
      h.index.destroy();
    }
  });

  it('conflicts after the parent changes without overwriting its current content', async () => {
    const app = await createAppWithFiles({ [path]: '- [ ] Root\n  - [ ] Removed\n  - [ ] Next\n' });
    const h = configuredTaskApplication(app, DEFAULT_SETTINGS, { authority: true });
    await h.index.initialize();
    try {
      const root = expectDefined(h.index.list()[0]);
      const deleted = await h.tasks.execute({
        type: 'delete-subtask',
        subtask: expectDefined(root.subtasks[0]).ref,
      });
      if (deleted.type !== 'ok' || deleted.outcome.type !== 'task')
        throw new Error('delete failed');
      const recovery = expectDefined(deleted.outcome.subtaskRemovalRecovery);
      await h.tasks.execute({
        type: 'patch',
        target: { type: 'task', ref: deleted.outcome.task.ref },
        patch: { markdownTitle: { type: 'set', value: 'Renamed' } },
      });
      const current = await app.vault.read(fileAt(app, path));
      const result = await h.tasks.execute({ type: 'restore-subtask', ...recovery });
      expect(result.type).toBe('conflict');
      expect(await app.vault.read(fileAt(app, path))).toBe(current);
    } finally {
      h.index.destroy();
    }
  });
});

describe('TaskApplicationService lifecycle settings', () => {
  const queries: TestTaskQueries = taskQueryApi();

  it('snapshots lifecycle settings once per command for root and subtask creation/completion dates', async () => {
    const harness = await makeHarness('in-memory', '');
    const catalog = new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses));
    const behavior: TaskBehaviorSettingsProvider = vi.fn<TaskBehaviorSettingsProvider>(() => ({
      taskPrefix: '',
      inbox: { mode: 'untagged', tag: '', removeTagOnAssign: true },
      taskLifecycle: { addCreatedDate: true, addCompletionDate: true },
      recurrence: { newOccurrencePlacement: 'before' as const, removeScheduledDate: false },
    }));
    const api = new TaskApplicationService(
      queries,
      harness.repository,
      catalog,
      { today: () => localDate('2026-08-01') },
      undefined,
      behavior,
    );

    const created = await api.execute({
      type: 'create',
      destination: { type: 'explicit', destination: appendDestination },
      markdownBody: 'Parent\n  - [ ] Child',
    });
    expect(await harness.read()).toBe('- [ ] Parent ➕ 2026-08-01\n  - [ ] Child ➕ 2026-08-01');
    expect(behavior).toHaveBeenCalledOnce();
    const createdTask = taskFrom(created, 'task not created');

    const subtaskAdded = await api.execute({
      type: 'add-subtask',
      parent: { type: 'task', ref: createdTask.ref },
      text: 'Added later',
    });
    expect(await harness.read()).toBe(
      '- [ ] Parent ➕ 2026-08-01\n  - [ ] Child ➕ 2026-08-01\n  - [ ] Added later ➕ 2026-08-01',
    );
    const taskWithSubtask = taskFrom(subtaskAdded, 'subtask not added');

    const rootDone = await api.execute({
      type: 'set-status',
      target: { type: 'task', ref: taskWithSubtask.ref },
      symbol: 'x',
    });
    expect(rootDone).toMatchObject({
      type: 'ok',
      outcome: { type: 'task', task: { planning: { completion: '2026-08-01' } } },
    });
    expect(await harness.read()).toContain('- [x] Parent ➕ 2026-08-01 ✅ 2026-08-01');
    const completedRoot = taskFrom(rootDone, 'task not completed');

    const childDone = await api.execute({
      type: 'set-status',
      target: { type: 'subtask', ref: expectDefined(completedRoot.subtasks[0]).ref },
      symbol: 'x',
    });
    expect(childDone).toMatchObject({
      type: 'ok',
      outcome: { type: 'task' },
    });
    const completedChild = taskFrom(childDone, 'subtask not completed');
    expect(completedChild.subtasks[0]?.planning.completion).toBe('2026-08-01');

    const rootDoneAgain = await api.execute({
      type: 'set-status',
      target: { type: 'task', ref: completedChild.ref },
      symbol: 'x',
    });
    expect(rootDoneAgain).toMatchObject({
      type: 'ok',
      changed: false,
      outcome: { type: 'task', task: { planning: { completion: '2026-08-01' } } },
    });
    const unchangedRoot = taskFrom(rootDoneAgain, 'completed task not returned');

    const reopened = await api.execute({
      type: 'set-status',
      target: { type: 'task', ref: unchangedRoot.ref },
      symbol: ' ',
    });
    expect(reopened).toMatchObject({
      type: 'ok',
      outcome: { type: 'task', task: { planning: {} } },
    });
    expect((await harness.read()).split('\n')[0]).toBe('- [ ] Parent ➕ 2026-08-01');
    expect(behavior).toHaveBeenCalledTimes(6);
  });

  it('does not add creation or completion dates when lifecycle dates are disabled', async () => {
    const harness = await makeHarness('in-memory', '');
    const catalog = new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses));
    const api = new TaskApplicationService(
      queries,
      harness.repository,
      catalog,
      { today: () => localDate('2026-08-01') },
      undefined,
      () => ({
        taskPrefix: '',
        inbox: { mode: 'untagged', tag: '', removeTagOnAssign: true },
        taskLifecycle: { addCreatedDate: false, addCompletionDate: false },
        recurrence: { newOccurrencePlacement: 'before', removeScheduledDate: false },
      }),
    );

    const created = await api.execute({
      type: 'create',
      destination: { type: 'explicit', destination: appendDestination },
      markdownBody: 'No stamps',
    });
    if (created.type !== 'ok' || created.outcome.type !== 'task')
      throw new Error('task not created');
    await api.execute({
      type: 'set-status',
      target: { type: 'task', ref: created.outcome.task.ref },
      symbol: 'x',
    });

    expect(await harness.read()).toBe('- [x] No stamps');
  });

  it('persists semantic Markdown and independently tagged descendants through creation policy', async () => {
    const harness = await makeHarness('in-memory', '');
    const catalog = new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses));
    const api = new TaskApplicationService(
      queries,
      harness.repository,
      catalog,
      { today: () => localDate('2026-08-01') },
      undefined,
      () => ({
        taskPrefix: '#work',
        inbox: { mode: 'tag', tag: '#inbox', removeTagOnAssign: true },
        taskLifecycle: { addCreatedDate: false, addCompletionDate: false },
        recurrence: { newOccurrencePlacement: 'before', removeScheduledDate: false },
      }),
    );

    await expect(
      api.execute({
        type: 'create',
        destination: { type: 'explicit', destination: appendDestination },
        markdownBody: 'Read [docs](https://example.com/#work)\n  - [ ] Child #work',
      }),
    ).resolves.toMatchObject({ type: 'ok' });
    expect(await harness.read()).toBe(
      '- [ ] #work Read [docs](https://example.com/#work)\n  - [ ] Child #work',
    );
  });

  it('persists trailing Markdown when duplicate and Inbox tag removals overlap', async () => {
    const harness = await makeHarness('in-memory', '');
    const catalog = new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses));
    const api = new TaskApplicationService(
      queries,
      harness.repository,
      catalog,
      { today: () => localDate('2026-08-01') },
      undefined,
      () => ({
        taskPrefix: '',
        inbox: { mode: 'tag', tag: '#inbox', removeTagOnAssign: true },
        taskLifecycle: { addCreatedDate: false, addCompletionDate: false },
        recurrence: { newOccurrencePlacement: 'before', removeScheduledDate: false },
      }),
    );

    await expect(
      api.execute({
        type: 'create',
        destination: { type: 'explicit', destination: appendDestination },
        markdownBody: 'Task #inbox #work #work final [docs](https://example.com/#fragment) text',
      }),
    ).resolves.toMatchObject({ type: 'ok' });
    expect(await harness.read()).toBe(
      '- [ ] Task #work final [docs](https://example.com/#fragment) text',
    );
  });

  it('normalizes supported initial tags through the real codec and rejects unsupported grammar', async () => {
    const harness = await makeHarness('in-memory', '');
    const catalog = new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses));
    const api = new TaskApplicationService(
      queries,
      harness.repository,
      catalog,
      { today: () => localDate('2026-08-01') },
      undefined,
      () => ({
        taskPrefix: '',
        inbox: { mode: 'untagged', tag: '', removeTagOnAssign: true },
        taskLifecycle: { addCreatedDate: false, addCompletionDate: false },
        recurrence: { newOccurrencePlacement: 'before', removeScheduledDate: false },
      }),
    );

    await expect(
      api.execute({
        type: 'create',
        destination: { type: 'explicit', destination: appendDestination },
        markdownBody: 'Supported',
        initial: { tags: { add: ['##work'] } },
      }),
    ).resolves.toMatchObject({ type: 'ok' });
    expect(await harness.read()).toBe('- [ ] Supported #work');

    await expect(
      api.execute({
        type: 'create',
        destination: { type: 'explicit', destination: appendDestination },
        markdownBody: 'Unsupported',
        initial: { tags: { add: ['#работа'] } },
      }),
    ).resolves.toEqual({
      type: 'invalid',
      issues: [{ code: 'invalid-target', field: 'tags' }],
    });
    expect(await harness.read()).toBe('- [ ] Supported #work');
  });
});

describe('repository-owned index observations', () => {
  it('keeps a newly committed successor across a delayed empty observation', async () => {
    const app = await createAppWithFiles({ [path]: '' });
    const fireChanged = captureChangedCallback(app);
    const h = configuredTaskApplication(app, DEFAULT_SETTINGS, { authority: true });
    await h.index.initialize();
    try {
      const created = taskFrom(
        await h.tasks.execute({
          type: 'create',
          destination: { type: 'explicit', destination: appendDestination },
          markdownBody: 'Root',
        }),
        'root not created',
      );
      const withChild = taskFrom(
        await h.tasks.execute({
          type: 'add-subtask',
          parent: { type: 'task', ref: created.ref },
          text: 'First child',
        }),
        'first child not created',
      );

      fireChanged(fileAt(app, path), '', { listItems: [] });
      await flushMicrotasks();

      await expect(
        h.tasks.execute({
          type: 'add-subtask',
          parent: { type: 'task', ref: withChild.ref },
          text: 'Second child',
        }),
      ).resolves.toMatchObject({ type: 'ok', changed: true });
      expect(await app.vault.read(fileAt(app, path))).toContain('  - [ ] Second child');
    } finally {
      h.index.destroy();
    }
  });

  it('invalidates a committed ref after a real external replacement', async () => {
    const app = await createAppWithFiles({ [path]: '' });
    const fireChanged = captureChangedCallback(app);
    const h = configuredTaskApplication(app, DEFAULT_SETTINGS, { authority: true });
    await h.index.initialize();
    try {
      const created = taskFrom(
        await h.tasks.execute({
          type: 'create',
          destination: { type: 'explicit', destination: appendDestination },
          markdownBody: 'Root',
        }),
        'root not created',
      );
      const replacement = '- [ ] External replacement\n';
      const file = fileAt(app, path);
      await app.vault.modify(file, replacement);
      fireChanged(file, replacement, {
        listItems: [
          {
            task: ' ',
            parent: -1,
            position: { start: { line: 0 }, end: { line: 0 } },
          },
        ],
      } as CachedMetadata);
      await flushMicrotasks();

      expect(h.index.list().map((task) => task.title)).toEqual(['External replacement']);
      await expect(
        h.tasks.execute({
          type: 'add-subtask',
          parent: { type: 'task', ref: created.ref },
          text: 'Must not attach',
        }),
      ).resolves.not.toMatchObject({ type: 'ok' });
      expect(await app.vault.read(file)).toBe(replacement);
    } finally {
      h.index.destroy();
    }
  });
});

describe('ObsidianTaskDestinationProvider', () => {
  it('freezes a dated configured path without provisioning until preparation', async () => {
    const provision = vi.fn(async (path: string) => ({ path }));
    const provider = new ObsidianTaskDestinationProvider(
      () => ({
        taskFilePath: 'daily/{{YYYY-MM-DD}}',
        taskTemplatePath: 'templates/task.md',
        capturedToday: '2026-07-14',
        insertion: { type: 'append' },
      }),
      provision,
    );

    const plan = await provider.planConfiguredDefault();

    expect(plan.destination.filePath).toBe('daily/2026-07-14.md');
    expect(provision).not.toHaveBeenCalled();
    await expect(plan.prepare()).resolves.toEqual({
      type: 'resolved',
      destination: plan.destination,
    });
    expect(provision).toHaveBeenCalledWith(
      'daily/2026-07-14.md',
      'templates/task.md',
      '2026-07-14',
    );
  });

  it('freezes one archive date and prepares the empty destination once on demand', async () => {
    let capturedToday = '2026-07-14';
    const provision = vi.fn(async (path: string, template: string) => ({ path, template }));
    const provider = new ObsidianTaskDestinationProvider(
      () => ({
        taskFilePath: 'tasks.md',
        taskArchivePath: 'archive/{{YYYY-MM-DD}}.md',
        taskTemplatePath: 'templates/task.md',
        capturedToday,
        insertion: { type: 'prepend' },
      }),
      provision,
    );

    const plan = await provider.planArchive();
    capturedToday = '2026-07-15';

    expect(plan.destination).toEqual({
      filePath: 'archive/2026-07-14.md',
      insertion: { type: 'append' },
    });
    expect(provision).not.toHaveBeenCalled();
    await plan.prepare();
    expect(provision).toHaveBeenCalledWith('archive/2026-07-14.md', '', '2026-07-14');
  });

  it('rejects ordinary capture into an excluded destination before provisioning', async () => {
    const provision = vi.fn(async (path: string) => ({ path }));
    const provider = new ObsidianTaskDestinationProvider(
      () => ({
        taskFilePath: 'tasks/archive.md',
        taskArchivePath: 'tasks/archive.md',
        taskTemplatePath: '',
        capturedToday: '2026-07-14',
        insertion: { type: 'append' },
      }),
      provision,
      (path) => path.toLowerCase() === 'tasks/archive.md',
    );

    await expect((await provider.planConfiguredDefault()).prepare()).resolves.toEqual({
      type: 'unavailable',
    });
    expect(provision).not.toHaveBeenCalled();
  });

  it('uses canonical vault casing for archive plans and their resulting destination', async () => {
    const provision = vi.fn(async (path: string) => ({ path }));
    const canonicalize = vi.fn((path: string) =>
      path === 'tasks/archive.md' ? 'Tasks/Archive.md' : path,
    );
    const provider = new ObsidianTaskDestinationProvider(
      () => ({
        taskFilePath: 'tasks/active.md',
        taskArchivePath: 'tasks/archive.md',
        taskTemplatePath: '',
        capturedToday: '2026-07-14',
        insertion: { type: 'append' },
      }),
      provision,
      () => false,
      canonicalize,
    );

    const plan = await provider.planArchive();
    expect(plan.destination.filePath).toBe('Tasks/Archive.md');
    await expect(plan.prepare()).resolves.toEqual({
      type: 'resolved',
      destination: { filePath: 'Tasks/Archive.md', insertion: { type: 'append' } },
    });
    expect(provision).toHaveBeenCalledWith('Tasks/Archive.md', '', 'Archive');
  });
});

describe('configured destination end-to-end lifecycle', () => {
  const inboxCaptureCases = (['tag', 'untagged', 'both'] as const).flatMap((mode) =>
    [true, false].flatMap((removeTagOnAssign) =>
      [
        { authored: 'plain prose', body: 'Captured', authoredTags: [] as const },
        { authored: 'same Inbox tag', body: 'Captured #inbox', authoredTags: ['#inbox'] as const },
        {
          authored: 'other tag beside inline code',
          body: 'Captured `#code` #work',
          authoredTags: ['#work'] as const,
        },
      ].map(({ authored, body, authoredTags }) => ({
        name: `${mode}, remove=${String(removeTagOnAssign)}, ${authored}`,
        mode,
        removeTagOnAssign,
        body,
        expectedTags:
          mode !== 'untagged' && (!body.includes('#work') || !removeTagOnAssign)
            ? ([...authoredTags, '#inbox'] as const)
            : authoredTags,
      })),
    ),
  );

  it.each(inboxCaptureCases)(
    'applies the explicit Inbox contract for $name',
    async ({ mode, removeTagOnAssign, body, expectedTags }) => {
      const inboxPath = 'tasks/active.md';
      const app = await createAppWithFiles({ [inboxPath]: '' });
      const settings: CalendarSettings = {
        ...structuredClone(DEFAULT_SETTINGS),
        taskFilePath: inboxPath,
        taskPrefix: 'Prefix #task',
        inbox: { mode, tag: '#inbox', removeTagOnAssign },
        taskLifecycle: { addCreatedDate: false, addCompletionDate: false },
      };
      const application = applicationFor(app, settings);
      const resolver = new CaptureTargetResolver(application, settings, () =>
        localDate('2026-07-14'),
      );

      const target = await resolver.resolve({ type: 'list', selection: 'inbox' });
      const result = await target.session.execute({
        markdownBody: commandBodyForCapture(target, body),
        ...(target.initial === undefined ? {} : { initial: target.initial }),
      });

      expect(result).toMatchObject({ type: 'ok' });
      const expectedSuffix = expectedTags
        .filter((tag) => !body.includes(tag))
        .map((tag) => ` ${tag}`)
        .join('');
      expect(await app.vault.cachedRead(fileAt(app, inboxPath))).toBe(
        `- [ ] ${body}${expectedSuffix}`,
      );
    },
  );

  it('freezes explicit Inbox intent and Inbox settings across retained-session executions', async () => {
    const inboxPath = 'tasks/active.md';
    const app = await createAppWithFiles({ [inboxPath]: '' });
    const settings: CalendarSettings = {
      ...structuredClone(DEFAULT_SETTINGS),
      taskFilePath: inboxPath,
      taskPrefix: 'Frozen prefix #task',
      inbox: { mode: 'tag', tag: '#inbox', removeTagOnAssign: false },
      taskLifecycle: { addCreatedDate: false, addCompletionDate: false },
    };
    const application = applicationFor(app, settings);
    const resolver = new CaptureTargetResolver(application, settings, () =>
      localDate('2026-07-14'),
    );
    const target = await resolver.resolve({ type: 'list', selection: 'inbox' });

    settings.taskPrefix = 'Changed prefix #changed';
    settings.inbox = { mode: 'tag', tag: '#changed-inbox', removeTagOnAssign: true };
    await target.session.execute({
      markdownBody: 'first',
      ...(target.initial === undefined ? {} : { initial: target.initial }),
    });
    await target.session.execute({
      markdownBody: 'second #work',
      ...(target.initial === undefined ? {} : { initial: target.initial }),
    });

    expect(await app.vault.cachedRead(fileAt(app, inboxPath))).toBe(
      '- [ ] first #inbox\n- [ ] second #work #inbox',
    );
  });

  it('keeps Q capture on the real project section when a fenced example repeats its heading', async () => {
    const projectPath = 'projects/Abyss Tasks.md';
    const inboxPath = 'tasks/active.md';
    const projectSource = [
      '# Abyss Tasks',
      '',
      '```md',
      '%%',
      '# Tasks',
      '- [ ] Example only',
      '%%',
      '```',
      '',
      'Project notes.',
      '',
      '# Tasks',
      '',
      '- [ ] Existing',
      '',
    ].join('\n');
    const app = await createAppWithFiles({ [projectPath]: projectSource, [inboxPath]: '' });
    const settings: CalendarSettings = {
      ...DEFAULT_SETTINGS,
      taskFilePath: inboxPath,
      taskPrefix: '#task',
      inbox: { mode: 'tag', tag: '#task/inbox', removeTagOnAssign: true },
      taskLifecycle: { addCreatedDate: false, addCompletionDate: false },
      projects: {
        ...DEFAULT_SETTINGS.projects,
        taskInsertionMode: 'section',
        taskInsertionSection: '# Tasks',
        taskInsertionSectionPosition: 'top',
      },
    };
    const application = applicationFor(app, settings);
    const resolver = new CaptureTargetResolver(application, settings, () =>
      localDate('2026-07-14'),
    );

    const inbox = await resolver.resolve({ type: 'list', selection: 'inbox' });
    const inboxResult = await inbox.session.execute({
      markdownBody: commandBodyForCapture(inbox, 'Обычная задача Inbox'),
      ...(inbox.initial === undefined ? {} : { initial: inbox.initial }),
    });
    const project = await resolver.resolve({ type: 'project-dashboard', path: projectPath });
    const projectResult = await project.session.execute({
      markdownBody: commandBodyForCapture(project, 'Обычная задача проекта'),
      ...(project.initial === undefined ? {} : { initial: project.initial }),
    });

    expect(inboxResult).toMatchObject({ type: 'ok' });
    expect(await app.vault.cachedRead(fileAt(app, inboxPath))).toContain('Обычная задача Inbox');
    expect(projectResult).toMatchObject({
      type: 'ok',
      outcome: { type: 'task', task: { source: { filePath: projectPath, line: 12 } } },
    });
    expect(await app.vault.cachedRead(fileAt(app, projectPath))).toBe(
      projectSource.replace(
        '# Tasks\n\n- [ ] Existing',
        '# Tasks\n- [ ] #task Обычная задача проекта\n\n- [ ] Existing',
      ),
    );
  });

  it('executes a frozen configured session with exactly-once provisioning', async () => {
    const app = await createAppWithFiles({
      'templates/frozen.md': '# {{title}}\n\n## Frozen tasks\n',
      'templates/changed.md': '# Changed template\n',
    });
    const settings: CalendarSettings = {
      ...DEFAULT_SETTINGS,
      taskFilePath: 'daily/frozen/{{YYYY-MM-DD}}.md',
      taskTemplatePath: 'templates/frozen.md',
      taskInsertionMode: 'section',
      taskInsertionSection: '## Frozen tasks',
    };
    const application = applicationFor(app, settings);
    const create = vi.spyOn(app.vault, 'create');
    const createFolder = vi.spyOn(app.vault, 'createFolder');

    const session = await application.planCreate({ type: 'configured-default' });
    const today = '2026-07-14';

    expect(session).toMatchObject({
      type: 'ready',
      destination: {
        filePath: `daily/frozen/${today}.md`,
        insertion: { type: 'section', heading: '## Frozen tasks' },
      },
    });
    expect(create).not.toHaveBeenCalled();
    expect(createFolder).not.toHaveBeenCalled();

    settings.taskFilePath = 'daily/changed/{{YYYY-MM-DD}}.md';
    settings.taskTemplatePath = 'templates/changed.md';
    settings.taskInsertionMode = 'append';
    settings.taskInsertionSection = '## Changed tasks';
    await session.execute({ markdownBody: 'first frozen task' });
    await session.execute({ markdownBody: 'second frozen task' });

    expect(create).toHaveBeenCalledOnce();
    expect(createFolder).toHaveBeenCalledTimes(2);
    const content = await app.vault.cachedRead(fileAt(app, `daily/frozen/${today}.md`));
    expect(content).toContain(`# ${today}`);
    expect(content).toContain('## Frozen tasks\n- [ ] second frozen task');
    expect(content).toContain('- [ ] first frozen task');
    expect(content).not.toContain('Changed template');
    expect(app.vault.getAbstractFileByPath(`daily/changed/${today}.md`)).toBeNull();
  });

  it('rechecks current destination Markdown on every retained-session execution', async () => {
    const path = 'tasks/active.md';
    const app = await createAppWithFiles({ [path]: '' });
    const application = applicationFor(app, DEFAULT_SETTINGS, async (filePath) => {
      const file = app.vault.getAbstractFileByPath(filePath);
      return file instanceof TFile && (await app.vault.cachedRead(file)).includes('#ignored');
    });
    const session = await application.planCreate({ type: 'configured-default' });

    await expect(session.execute({ markdownBody: 'first' })).resolves.toMatchObject({ type: 'ok' });
    const file = fileAt(app, path);
    await app.vault.modify(file, `#ignored\n${await app.vault.cachedRead(file)}`);

    await expect(session.execute({ markdownBody: 'must stay out' })).resolves.toEqual({
      type: 'invalid',
      issues: [{ code: 'destination-unavailable', field: 'destination' }],
    });
    expect(await app.vault.cachedRead(file)).not.toContain('must stay out');
  });

  it.each([
    { name: 'body tag', template: '#ignored\n' },
    { name: 'frontmatter', template: '---\nprivate: true\n---\n' },
  ])('rejects a freshly templated destination excluded by its $name', async ({ template }) => {
    const path = 'tasks/templated.md';
    const app = await createAppWithFiles({ 'templates/task.md': template });
    const settings = {
      ...DEFAULT_SETTINGS,
      taskFilePath: path,
      taskTemplatePath: 'templates/task.md',
    };
    const application = applicationFor(app, settings, async (filePath) => {
      const file = app.vault.getAbstractFileByPath(filePath);
      if (!(file instanceof TFile)) return false;
      const current = await app.vault.cachedRead(file);
      return current.includes('#ignored') || current.includes('private: true');
    });

    await expect(
      application.execute({
        type: 'create',
        destination: { type: 'configured-default' },
        markdownBody: 'must not disappear',
      }),
    ).resolves.toEqual({
      type: 'invalid',
      issues: [{ code: 'destination-unavailable', field: 'destination' }],
    });
    expect(await app.vault.cachedRead(fileAt(app, path))).toBe(template);
  });

  it.each([
    {
      name: 'configured custom note',
      settings: { ...DEFAULT_SETTINGS, taskFilePath: 'Capture.md' },
      destination: { type: 'configured-default' } as const,
      path: 'Capture.md',
    },
    {
      name: 'provisioned Inbox note',
      settings: { ...DEFAULT_SETTINGS, taskFilePath: 'tasks/active.md' },
      destination: {
        type: 'explicit',
        destination: { filePath: 'Inbox.md', insertion: { type: 'append' } },
        provision: 'if-missing',
      } as const,
      path: 'Inbox.md',
    },
  ])('creates a missing $name before inserting through the repository', async (scenario) => {
    vi.mocked(Notice).mockClear();
    const app = await createAppWithFiles({});
    const application = applicationFor(app, scenario.settings);

    const result = await application.execute({
      type: 'create',
      destination: scenario.destination,
      markdownBody: 'first task',
    });

    expect(result).toMatchObject({
      type: 'ok',
      outcome: { type: 'task', task: { source: { filePath: scenario.path, line: 0 } } },
    });
    expect(await app.vault.cachedRead(fileAt(app, scenario.path))).toBe(
      '- [ ] first task ➕ 2026-07-14',
    );
    presentTaskCreationResult(result);
    expect(Notice).toHaveBeenCalledWith(`Task added to ${scenario.path}`);
  });

  it('creates a template-backed configured note and inserts through its section policy', async () => {
    vi.mocked(Notice).mockClear();
    const app = await createAppWithFiles({
      'template.md': '# {{title}}\n\n## Tasks\n\nDaily notes stay here.\n',
    });
    const settings = {
      ...DEFAULT_SETTINGS,
      taskFilePath: 'daily/{{YYYY-MM-DD}}.md',
      taskTemplatePath: 'template.md',
      taskInsertionMode: 'section' as const,
      taskInsertionSection: '## Tasks',
    };
    const application = applicationFor(app, settings);
    const today = '2026-07-14';

    const result = await application.execute({
      type: 'create',
      destination: { type: 'configured-default' },
      markdownBody: 'planned task',
      initial: { due: { type: 'set', value: localDate('2026-07-20') } },
    });

    expect(result).toMatchObject({
      type: 'ok',
      outcome: {
        type: 'task',
        task: { source: { filePath: `daily/${today}.md`, line: 3 } },
      },
    });
    const content = await app.vault.cachedRead(fileAt(app, `daily/${today}.md`));
    expect(content).toContain(`# ${today}`);
    expect(content).toContain(`## Tasks\n- [ ] planned task ➕ 2026-07-14 📅 2026-07-20`);
    expect(content).toContain('Daily notes stay here.');
    expect(content.split(/\r?\n/u).filter((line) => /^- \[.\]/u.test(line))).toHaveLength(1);
    expect(content).not.toContain('🆔');
    presentTaskCreationResult(result);
    expect(Notice).toHaveBeenCalledWith(`Task added to ${today}.md`);
  });

  it('retries a rejected template preparation through the same configured capture session', async () => {
    const app = await createAppWithFiles({ 'templates/task.md': '<% broken %>\n' });
    let attempt = 0;
    installTemplater(app, async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('parse failed');
      return '# Prepared\n';
    });
    const settings = {
      ...DEFAULT_SETTINGS,
      taskFilePath: 'daily/{{YYYY-MM-DD}}.md',
      taskTemplatePath: 'templates/task.md',
    };
    const application = applicationFor(app, settings);
    const session = await application.planCreate({ type: 'configured-default' });

    await expect(session.execute({ markdownBody: 'retry this draft' })).resolves.toMatchObject({
      type: 'io-error',
    });
    await expect(session.execute({ markdownBody: 'retry this draft' })).resolves.toMatchObject({
      type: 'ok',
    });

    const file = fileAt(app, 'daily/2026-07-14.md');
    expect(await app.vault.cachedRead(file)).toContain('- [ ] retry this draft');
    expect(attempt).toBe(2);
  });
});
