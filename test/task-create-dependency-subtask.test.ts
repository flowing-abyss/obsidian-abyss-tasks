import { TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localDate, type TaskCommandResult } from '../src/tasks';
import { TaskApplicationService } from '../src/tasks/application/TaskApplicationService';
import {
  TaskDependencyService,
  nextTaskDependencyId,
  type TaskDependencyIdGenerator,
  type TaskDiagnosticSink,
} from '../src/tasks/application/TaskDependencyService';
import { TaskIndex } from '../src/tasks/infrastructure/TaskIndex';
import { TaskRefAuthority } from '../src/tasks/infrastructure/TaskRefAuthority';
import { TaskBlockEditor } from '../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { TaskLocator } from '../src/tasks/infrastructure/markdown/TaskLocator';
import { TaskMarkdownCodec } from '../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { ObsidianTaskRepository } from '../src/tasks/infrastructure/obsidian/ObsidianTaskRepository';
import {
  canonicalStatusCatalog,
  createAppWithFiles,
  expectDefined,
  flushMicrotasks,
} from './helpers';

const indexes: TaskIndex[] = [];
afterEach(() => {
  indexes.splice(0).forEach((index) => {
    index.destroy();
  });
  vi.restoreAllMocks();
});

async function harness(
  source = '- [ ] Current\n',
  generate: TaskDependencyIdGenerator = nextTaskDependencyId,
  addCreatedDate = true,
) {
  const app = await createAppWithFiles({ 'tasks.md': `\n${source}` });
  const statuses = canonicalStatusCatalog();
  const authority = new TaskRefAuthority('create-linked');
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
  const dependencies = new TaskDependencyService(index, repository, generate, diagnostics);
  const application = new TaskApplicationService(
    index,
    repository,
    statuses,
    { today: () => localDate('2026-09-06') },
    undefined,
    () => ({
      taskLifecycle: { addCreatedDate, addCompletionDate: true },
      recurrence: { newOccurrencePlacement: 'before', removeScheduledDate: false },
    }),
    dependencies,
    diagnostics,
  );
  const node = (title: string) =>
    expectDefined(index.listNodes().find((candidate) => candidate.node.title === title));
  const file = app.vault.getAbstractFileByPath('tasks.md');
  if (!(file instanceof TFile)) throw new Error('missing fixture');
  const read = async () => (await app.vault.read(file)).slice(1);
  const create = (
    direction: 'blocks' | 'blocked-by' = 'blocked-by',
    text = 'Child',
    current = node('Current').target,
  ) =>
    application.execute({
      type: 'create-dependency-subtask',
      current,
      direction,
      text,
    });
  return { app, index, repository, application, diagnostics, node, read, create, file };
}

function outcome(result: TaskCommandResult) {
  if (result.type !== 'ok' || result.outcome.type !== 'dependency-subtask')
    throw new Error(`Expected linked child, got ${result.type}`);
  return result.outcome;
}

describe('public atomic dependency subtask creation', () => {
  it.each([
    ['blocked-by', '- [ ] Current ⛔ 00000000\n  - [ ] Child ➕ 2026-09-06 🆔 00000000\n'],
    ['blocks', '- [ ] Current 🆔 00000000\n  - [ ] Child ➕ 2026-09-06 ⛔ 00000000\n'],
  ] as const)(
    'publishes only the complete %s edge and fresh evidence',
    async (direction, expected) => {
      const h = await harness();
      const states: string[][] = [];
      h.index.subscribe(() =>
        states.push(
          h.index
            .listNodes()
            .map(
              ({ node }) => `${node.title}:${node.dependencyId ?? ''}:${node.dependsOn.join(',')}`,
            ),
        ),
      );
      const process = vi.spyOn(h.app.vault, 'process');
      const result = outcome(await h.create(direction));
      await flushMicrotasks();
      expect(await h.read()).toBe(expected);
      expect(result.current).toEqual({
        root: h.node('Current').root,
        target: h.node('Current').target,
      });
      expect(result.child).toEqual({ root: h.node('Child').root, target: h.node('Child').target });
      expect(process).toHaveBeenCalledTimes(1);
      expect(states.length).toBeGreaterThan(0);
      expect(
        states.every(
          (state) => state.length === 2 && state.some((item) => item.includes('00000000')),
        ),
      ).toBe(true);
    },
  );

  it('reuses a unique authored current ID without allocating an unnecessary child ID', async () => {
    const generate = vi.fn<TaskDependencyIdGenerator>(() => 'invalid!');
    const h = await harness('- [ ] Current 🆔 authored\n', generate, false);
    expect(outcome(await h.create('blocks')).dependencyId).toBe('authored');
    expect(await h.read()).toBe('- [ ] Current 🆔 authored\n  - [ ] Child ⛔ authored\n');
    expect(generate).not.toHaveBeenCalled();
  });

  it('reserves authored and unavailable IDs when allocating the child', async () => {
    const generate = vi
      .fn<TaskDependencyIdGenerator>()
      .mockReturnValueOnce('authored')
      .mockReturnValueOnce('00000000')
      .mockReturnValue('00000001');
    const h = await harness('- [ ] Current 🆔 authored ⛔ 00000000\n', generate, false);
    expect(outcome(await h.create()).dependencyId).toBe('00000001');
    expect(await h.read()).toBe(
      '- [ ] Current 🆔 authored ⛔ 00000000, 00000001\n  - [ ] Child 🆔 00000001\n',
    );
  });

  it('reserves IDs in a proven current root even when the node projection still exposes its predecessor', async () => {
    const h = await harness();
    const nodes = h.index.listNodes();
    const current = h.node('Current').target;
    await h.repository.edit({ type: 'set-dependency-id', target: current, id: '00000000' });
    vi.spyOn(h.index, 'listNodes').mockReturnValue(nodes);
    expect(outcome(await h.create('blocked-by', 'Child', current)).dependencyId).toBe('00000001');
    expect(await h.read()).toBe(
      '- [ ] Current 🆔 00000000 ⛔ 00000001\n  - [ ] Child ➕ 2026-09-06 🆔 00000001\n',
    );
  });

  it('bounds exhausted allocation without publishing a child', async () => {
    const generate = vi.fn<TaskDependencyIdGenerator>(() => 'invalid!');
    const h = await harness(undefined, generate);
    expect(await h.create()).toMatchObject({
      type: 'invalid',
      issues: [{ field: 'dependency-id' }],
    });
    expect(generate).toHaveBeenCalledTimes(64);
    expect(await h.read()).toBe('- [ ] Current\n');
  });

  it('rejects an ambiguous current blocker ID without changing either task', async () => {
    const source = '- [ ] Current 🆔 duplicate\n- [ ] Other 🆔 duplicate\n';
    const h = await harness(source);
    const result = await h.create('blocks');
    expect(result.type).toBe('ambiguous');
    if (result.type === 'ambiguous') expect(result.candidates).toHaveLength(2);
    expect(await h.read()).toBe(source);
  });

  it('appends under the nested current after its complete existing subtree', async () => {
    const h = await harness(
      '- [ ] Root\n  - [ ] Current\n    - [ ] Existing\n  - [ ] Sibling\n',
      undefined,
      false,
    );
    const result = outcome(await h.create());
    expect(result.current.target.type).toBe('subtask');
    expect(await h.read()).toBe(
      '- [ ] Root\n  - [ ] Current ⛔ 00000000\n    - [ ] Existing\n    - [ ] Child 🆔 00000000\n  - [ ] Sibling\n',
    );
  });

  it.each(['', 'Child\nOther', 'Child 🆔 authored', 'Child ⛔ authored'])(
    'rejects invalid draft %j without publication',
    async (text) => {
      const h = await harness();
      expect(await h.create('blocked-by', text)).toMatchObject({ type: 'invalid' });
      expect(await h.read()).toBe('- [ ] Current\n');
    },
  );

  it('serializes concurrent creates and allocates from the first committed edge', async () => {
    const h = await harness();
    const current = h.node('Current').target;
    const first = h.create('blocked-by', 'First', current);
    const second = h.create('blocked-by', 'Second', current);
    expect(outcome(await first).dependencyId).toBe('00000000');
    expect(outcome(await second).dependencyId).toBe('00000001');
    expect(h.node('Current').node.dependsOn).toEqual(['00000000', '00000001']);
    expect(h.node('Current').node.subtasks.map((child) => child.title)).toEqual([
      'First',
      'Second',
    ]);
  });

  it('returns one diagnostic and I/O result after unexpected repository failure, then releases the queue', async () => {
    const h = await harness();
    vi.spyOn(h.repository, 'createDependencySubtask').mockRejectedValueOnce(
      new Error('private source'),
    );
    expect(await h.create()).toMatchObject({ type: 'io-error', contentState: 'unknown' });
    expect(h.diagnostics).toHaveBeenCalledExactlyOnceWith({
      operation: 'create-dependency-subtask',
      phase: 'unexpected',
      cause: 'repository-error',
    });
    expect(await h.read()).toBe('- [ ] Current\n');
    expect(outcome(await h.create()).child.target.type).toBe('subtask');
  });

  it('serializes stale nested submissions and conflicts instead of retargeting the changed subtree', async () => {
    const h = await harness('- [ ] Root\n  - [ ] Current\n');
    const current = h.node('Current').target;
    const results = await Promise.all([
      h.create('blocked-by', 'First', current),
      h.create('blocked-by', 'Second', current),
    ]);
    expect(results.map((result) => result.type)).toEqual(['ok', 'conflict']);
    expect(h.node('Current').node.subtasks.map((child) => child.title)).toEqual(['First']);
    expect(h.node('Current').node.dependsOn).toEqual(['00000000']);
  });

  it('retries one byte-identical relocation and retains captured lifecycle settings', async () => {
    const h = await harness();
    const current = h.node('Current').target;
    const original = h.repository.createDependencySubtask.bind(h.repository);
    const write = vi
      .spyOn(h.repository, 'createDependencySubtask')
      .mockImplementationOnce(async (request) => {
        await h.app.vault.modify(h.file, '\n\n- [ ] Current\n');
        return original(request);
      });
    const result = outcome(await h.create('blocked-by', 'Child', current));
    expect(result.current.root.source.line).toBe(2);
    expect(write).toHaveBeenCalledTimes(2);
    expect(await h.read()).toBe(
      '\n- [ ] Current ⛔ 00000000\n  - [ ] Child ➕ 2026-09-06 🆔 00000000\n',
    );
  });

  it('refuses a stale node whose task text changed outside the application', async () => {
    const h = await harness();
    const current = h.node('Current').target;
    await h.app.vault.modify(h.file, '\n- [ ] Renamed\n');
    const result = await h.create('blocked-by', 'Child', current);
    expect(result.type).not.toBe('ok');
    expect(await h.read()).toBe('- [ ] Renamed\n');
  });

  it.each([
    'wrong-direction',
    'wrong-id',
    'wrong-child',
    'wrong-root',
    'wrong-text',
    'unrelated-change',
    'extra-edge',
    'wrong-bound-id',
  ] as const)('does not acknowledge a repository outcome with %s', async (corruption) => {
    const h = await harness('- [ ] Current\n  - [ ] Existing\n');
    const write = h.repository.createDependencySubtask.bind(h.repository);
    vi.spyOn(h.repository, 'createDependencySubtask').mockImplementation(async (request) => {
      const result = await write(request);
      if (result.type !== 'committed' || result.outcome.type !== 'dependency-subtask')
        return result;
      const bad = result;
      const value = result.outcome;
      if (corruption === 'wrong-direction')
        return { ...bad, outcome: { ...value, direction: 'blocks' } };
      if (corruption === 'wrong-id')
        return { ...bad, outcome: { ...value, dependencyId: 'different' } };
      if (corruption === 'wrong-child')
        return { ...bad, outcome: { ...value, child: value.current } };
      if (corruption === 'wrong-root')
        return {
          ...bad,
          outcome: {
            ...value,
            child: {
              ...value.child,
              root: { ...value.child.root, ref: { ...value.child.root.ref, revision: 'foreign' } },
            },
          },
        };
      const replacements = {
        'wrong-text': ['Child', 'Replaced'],
        'unrelated-change': ['Existing', 'Replaced'],
        'extra-edge': ['⛔ 00000000', '⛔ 00000000, other_id'],
        'wrong-bound-id': ['00000000', '00000099'],
      } as const;
      const [from, to] = replacements[corruption];
      const markdown = value.current.root.source.originalBlock.replaceAll(from, to);
      const root = expectDefined(h.index.snapshotsFromContent('tasks.md', `\n${markdown}\n`)[0]);
      const child = expectDefined(root.subtasks[1]);
      return {
        ...bad,
        outcome: {
          ...value,
          current: { root, target: { type: 'task', ref: root.ref } },
          child: { root, target: { type: 'subtask', ref: child.ref } },
        },
      };
    });
    expect(await h.create()).toMatchObject({ type: 'io-error', contentState: 'unknown' });
  });
});
