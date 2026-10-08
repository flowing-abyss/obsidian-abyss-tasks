import { describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import type { LinkToken } from '../src/markdown/links';
import { commandPatch, commandSource, TaskCommands } from '../src/panels/center/TaskCommands';
import { buildTaskListRows, buildTaskNodeListRows } from '../src/panels/task-list/taskListRows';
import { TaskRowSelection } from '../src/panels/task-list/taskRowSelection';
import type { ProjectManager } from '../src/projects/ProjectManager';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { StatusRegistry } from '../src/status/StatusRegistry';
import {
  durationMinutes,
  localDate,
  sameTaskNodeRef,
  taskNodeSourceLine,
  type TaskApplicationApi,
  type TaskCommand,
  type TaskCommandResult,
  type TaskNodeSnapshot,
  type TaskSnapshot,
} from '../src/tasks';
import { TaskApplicationService } from '../src/tasks/application/TaskApplicationService';
import { clockFrom } from '../src/tasks/domain/clock';
import { taskTreeNodes } from '../src/tasks/domain/taskSearchProjection';
import { LinkEditModal } from '../src/ui/LinkEditModal';
import { noInteractionOwnership } from '../src/ui/interactionOwnership';
import { taskSnapshotForCalendarOccurrence } from '../src/views/calendarOccurrences';
import {
  canonicalStatusCatalog,
  createAppWithFiles,
  deferred,
  expectDefined,
  flushMicrotasks,
  task,
  taskQueryApi,
} from './helpers';
import { hierarchyHarness } from './support/taskHierarchyHarness';

const due = localDate('2026-10-04');
const token: LinkToken = { raw: '[[Old]]', type: 'wiki', target: 'Old', display: 'Old', index: 0 };
interface SubmissionCase {
  readonly name: string;
  readonly submit: (commands: TaskCommands, current: TaskSnapshot) => void | Promise<unknown>;
  readonly command: (current: TaskSnapshot) => TaskCommand;
}
const cases: readonly SubmissionCase[] = [
  {
    name: 'toggleTask',
    submit: (c, t) => c.toggleTask(t),
    command: (t) => ({ type: 'toggle-completion', target: { type: 'task', ref: t.ref } }),
  },
  {
    name: 'setTaskStatus',
    submit: (c, t) => c.setTaskStatus(t, '/'),
    command: (t) => ({ type: 'set-status', target: { type: 'task', ref: t.ref }, symbol: '/' }),
  },
  {
    name: 'setPriority',
    submit: (c, t) => c.setPriority(t, 'A'),
    command: (t) => ({
      type: 'patch',
      target: { type: 'task', ref: t.ref },
      patch: { priority: { type: 'set', value: 'A' } },
    }),
  },
  ...(['toggleTaskDuePreset', 'setTaskDue', 'applyDueInOrder', 'applyBulkDuePreset'] as const).map(
    (name): SubmissionCase => ({
      name,
      submit: (c, t) =>
        name === 'applyDueInOrder' || name === 'applyBulkDuePreset'
          ? c[name]([t], due)
          : c[name](t, due),
      command: (t) => ({
        type: 'patch',
        target: { type: 'task', ref: t.ref },
        patch: { due: { type: 'set', value: due } },
      }),
    }),
  ),
  {
    name: 'patchTaskTags',
    submit: (c, t) => c.patchTaskTags(t, ['new'], ['old']),
    command: (t) => ({
      type: 'patch',
      target: { type: 'task', ref: t.ref },
      patch: { tags: { add: ['new'], remove: ['old'] } },
    }),
  },
  ...(['deleteTask', 'deleteBulkTasks'] as const).map((name): SubmissionCase => ({
    name,
    submit: (c, t) => (name === 'deleteBulkTasks' ? c[name]([t]) : c[name](t)),
    command: (t) => ({ type: 'delete', ref: t.ref }),
  })),
  {
    name: 'archiveTasks',
    submit: (c, t) => c.archiveTasks([t]),
    command: (t) => ({ type: 'archive', ref: t.ref }),
  },
  {
    name: 'editTaskLink',
    submit: (c, t) => {
      c.editTaskLink(t, 2, token);
    },
    command: (t) => ({
      type: 'edit-link',
      target: { type: 'title', target: { type: 'task', ref: t.ref } },
      occurrence: 2,
      replacement: '[[Changed]]',
    }),
  },
  {
    name: 'moveTaskToProject',
    submit: (c, t) => c.moveTaskToProject(t, 'Projects/A.md'),
    command: (t) => ({
      type: 'move',
      ref: t.ref,
      destination: { filePath: 'Projects/A.md', insertion: { type: 'append' } },
    }),
  },
];

async function fixture(
  application?: TaskApplicationApi,
  selectedSnapshots?: () => readonly TaskNodeSnapshot[],
) {
  const app = await createAppWithFiles({});
  const execute = vi
    .fn<TaskApplicationApi['execute']>()
    .mockResolvedValue({ type: 'invalid', issues: [{ code: 'invalid-target' }] });
  const tasks: TaskApplicationApi = application ?? { queries: taskQueryApi(), execute };
  const move = vi.fn(
    async (ref: TaskSnapshot['ref'], path: string, application: TaskApplicationApi) =>
      application.execute({
        type: 'move',
        ref,
        destination: { filePath: path, insertion: { type: 'append' } },
      }),
  );
  const selection = new TaskRowSelection();
  const onSelectionChanged = vi.fn();
  const state = new AppState();
  const commands = new TaskCommands({
    app,
    state,
    tasks,
    statusRegistry: new StatusRegistry(DEFAULT_SETTINGS.taskStatuses),
    interactionOwnership: noInteractionOwnership,
    projectManager: { moveTaskToProject: move } as unknown as ProjectManager,
    selection,
    onSelectionChanged,
    ...(selectedSnapshots === undefined ? {} : { selectedSnapshots }),
  });
  return { commands, execute, tasks, move, selection, onSelectionChanged, app, state };
}

function saveLinkImmediately(): void {
  vi.spyOn(LinkEditModal.prototype, 'open').mockImplementation(function (this: LinkEditModal) {
    (this as unknown as { onSave_abyssPrivate: (raw: string) => void }).onSave_abyssPrivate(
      '[[Changed]]',
    );
  });
}

describe('TaskCommands submission routing', () => {
  it.each(cases)(
    '$name submits the exact command through the supplied capability',
    async ({ submit, command, name }) => {
      const f = await fixture();
      const current = task();
      if (name === 'deleteBulkTasks') f.selection.replaceWith(['selected-row']);
      saveLinkImmediately();
      try {
        await submit(f.commands, current);
        await flushMicrotasks();
        expect(f.execute).toHaveBeenCalledOnce();
        expect(f.execute.mock.calls[0]?.[0]).toEqual(command(current));
        if (['applyDueInOrder', 'applyBulkDuePreset'].includes(name))
          expect(f.execute.mock.calls[0]?.[1]?.onPreparedPatch).toBeTypeOf('function');
        else expect(f.execute.mock.calls[0]).toHaveLength(1);
        if (name === 'moveTaskToProject')
          expect(f.move).toHaveBeenCalledExactlyOnceWith(current.ref, 'Projects/A.md', f.tasks);
        if (name === 'deleteBulkTasks') {
          expect(f.selection.size).toBe(0);
          expect(f.onSelectionChanged).toHaveBeenCalledOnce();
        }
      } finally {
        f.commands.dispose();
      }
    },
  );

  const calendarCases = cases.filter(({ name }) =>
    [
      'toggleTask',
      'setTaskStatus',
      'setPriority',
      'toggleTaskDuePreset',
      'setTaskDue',
      'applyDueInOrder',
      'applyBulkDuePreset',
      'editTaskLink',
    ].includes(name),
  );
  it.each(calendarCases)(
    '$name targets a materialized child occurrence and refuses a forecast',
    async ({ submit, command, name }) => {
      const f = await fixture();
      const h = await hierarchyHarness({
        'source.md': '- [ ] Move\n  - [ ] Child 🛫 2026-10-04 ^child\n',
        'target.md': '- [ ] Parent\n',
      });
      const root = h.source;
      const source = {
        root,
        node: expectDefined(root.subtasks[0]),
        target: { type: 'subtask' as const, ref: expectDefined(root.subtasks[0]).ref },
      };
      const current = taskSnapshotForCalendarOccurrence({
        kind: 'materialized',
        occupied: { kind: 'point', date: due, roles: ['start'] },
        key: 'child',
        source,
        planning: source.node.planning,
        recurring: false,
      });
      const forecast = taskSnapshotForCalendarOccurrence({
        kind: 'forecast',
        key: 'forecast',
        source,
        planning: {},
        referenceDate: due,
        ordinal: 1,
      });
      saveLinkImmediately();
      try {
        await submit(f.commands, current);
        await flushMicrotasks();
        const expected = command(current);
        if (expected.type === 'edit-link')
          expect(f.execute).toHaveBeenCalledExactlyOnceWith({
            ...expected,
            target: { type: 'title', target: source.target },
          });
        else {
          expect(f.execute).toHaveBeenCalledOnce();
          expect(f.execute.mock.calls[0]?.[0]).toEqual({ ...expected, target: source.target });
          if (['applyDueInOrder', 'applyBulkDuePreset'].includes(name))
            expect(f.execute.mock.calls[0]?.[1]?.onPreparedPatch).toBeTypeOf('function');
          else expect(f.execute.mock.calls[0]).toHaveLength(1);
        }
        f.execute.mockClear();
        await submit(f.commands, forecast);
        await flushMicrotasks();
        expect(f.execute).not.toHaveBeenCalled();
      } finally {
        f.commands.dispose();
      }
    },
  );

  it('disposes a pending completion confirmation before it can submit', async () => {
    const f = await fixture();
    const completion = f.commands.toggleTask(
      task({ recurrence: 'tomorrow', onCompletion: 'delete' }),
    );
    const confirm = expectDefined(
      activeDocument.querySelector<HTMLButtonElement>('.abyss-recurrence-delete-confirm-button'),
    );
    f.commands.dispose();
    confirm.click();
    await completion;
    expect(f.execute).not.toHaveBeenCalled();
    expect(activeDocument.querySelector('.abyss-recurrence-delete-confirm')).toBeNull();
  });
});

it.each([false, true])(
  'observes each original due result in sequential order, clear=%s',
  async (clear) => {
    const f = await fixture();
    const originals = [
      task({ title: 'one', planning: clear ? { due } : {} }),
      task({
        title: 'two',
        source: { filePath: 'two.md', line: 0 },
        planning: clear ? { due } : {},
      }),
    ];
    f.execute.mockImplementation(async (command) => ({
      type: 'ok',
      changed: false,
      outcome: {
        type: 'task',
        task: expectDefined(
          originals.find(
            (original) =>
              command.type === 'patch' &&
              command.target.type === 'task' &&
              command.target.ref.filePath === original.ref.filePath,
          ),
        ),
      },
    }));
    vi.spyOn(f.tasks.queries, 'resolve').mockImplementation((ref) => {
      const current = expectDefined(originals.find((task) => task.ref.filePath === ref.filePath));
      return { type: 'exact', task: current, basis: { observed: current } };
    });
    const seen: TaskSnapshot[] = [];
    const observer = vi.fn((original: TaskSnapshot) => {
      seen.push(original);
      expect(f.execute).toHaveBeenCalledTimes(seen.length);
    });
    await f.commands.applyBulkDuePreset(originals, due, observer);
    expect(seen).toEqual(originals);
    expect(observer).toHaveBeenCalledTimes(2);
    for (const [i, call] of f.execute.mock.calls.entries()) {
      expect(call[0]).toMatchObject({
        type: 'patch',
        target: { type: 'task', ref: originals[i]?.ref },
        patch: { due: clear ? { type: 'clear' } : { type: 'set', value: due } },
      });
    }
  },
);

describe('exact projected node actions', () => {
  it('patches and deletes a projected child through its physical target', async () => {
    const h = await hierarchyHarness();
    const child = expectDefined([...taskTreeNodes(h.source)][1]);
    const f = await fixture();
    await f.commands.patchTaskTags(child, ['#new'], ['#old']);
    expect(f.execute).toHaveBeenLastCalledWith({
      type: 'patch',
      target: child.target,
      patch: { tags: { add: ['#new'], remove: ['#old'] } },
    });
    await f.commands.deleteTask(child);
    if (child.target.type !== 'subtask') throw new Error('fixture must be child');
    expect(f.execute).toHaveBeenLastCalledWith({
      type: 'delete-subtask',
      subtask: child.target.ref,
    });
    f.commands.dispose();
    h.index.destroy();
  });
  it('refuses every continuation status route while allowing explicit node/Inspector actions', async () => {
    const h = await hierarchyHarness();
    const child = expectDefined([...taskTreeNodes(h.source)][1]);
    const f = await fixture();
    const continuation = { kind: 'continuation' as const, due: localDate('2026-10-09') };
    await f.commands.toggleTask(child, continuation);
    await f.commands.setTaskStatus(child, '/', continuation);
    expect(f.execute).not.toHaveBeenCalled();
    await f.commands.toggleTask(child, { kind: 'allowed' });
    expect(f.execute).toHaveBeenLastCalledWith({ type: 'toggle-completion', target: child.target });
    await f.commands.toggleTask(child.node);
    expect(f.execute).toHaveBeenCalledTimes(2);
    f.commands.dispose();
    h.index.destroy();
  });
  it('rejects root transfers for an entire mixed selection before submitting', async () => {
    const h = await hierarchyHarness();
    const child = expectDefined([...taskTreeNodes(h.source)][1]);
    const f = await fixture();
    await f.commands.archiveTasks([h.source, child]);
    await f.commands.moveTaskToProject(child, 'Projects/A.md');
    expect(f.execute).not.toHaveBeenCalled();
    f.commands.dispose();
    h.index.destroy();
  });
});

async function realCommands(source: string) {
  const h = await hierarchyHarness({ 'source.md': source, 'target.md': '- [ ] Other\n' });
  const f = await fixture(h.service);
  return { ...h, commands: f.commands, nodes: [...taskTreeNodes(h.source)] };
}

describe('sequential exact node batches against vault source', () => {
  it.each(['root', 'child'] as const)(
    'stops before a pending %s inherits a byte-identical recurring replacement',
    async (selected) => {
      const recurring = '- [ ] Owner 🔁 every day 🏁 delete\n  - [ ] Child\n';
      const files = {
        'source.md': '- [ ] First\n',
        'target.md': recurring,
        'last.md': '- [ ] Last\n',
      };
      const h = await hierarchyHarness(files);
      const service = new TaskApplicationService(
        h.index,
        h.repository,
        canonicalStatusCatalog(),
        clockFrom(Date.UTC(2026, 9, 3), 0),
        undefined,
        () => ({
          ...DEFAULT_SETTINGS,
          taskLifecycle: { addCreatedDate: false, addCompletionDate: false },
        }),
      );
      const firstSettled = deferred<void>();
      const releaseFirst = deferred<void>();
      const execute = vi.fn<TaskApplicationApi['execute']>(async (command, options) => {
        const result = await service.execute(command, options);
        if (execute.mock.calls.length === 1) {
          firstSettled.resolve();
          await releaseFirst.promise;
        }
        return result;
      });
      const f = await fixture({ queries: h.index, execute });
      const pending = expectDefined([...taskTreeNodes(h.parent)][selected === 'root' ? 0 : 1]);
      const last = expectDefined(h.index.list({ filePath: 'last.md' })[0]);
      const batch = f.commands.applyBulkTaskTags([h.source, pending, last], ['#batch'], []);
      try {
        await firstSettled.promise;
        const completed = await service.execute({
          type: 'toggle-completion',
          target: { type: 'task', ref: h.parent.ref },
        });
        expect(completed).toMatchObject({ type: 'ok', outcome: { type: 'recurrence' } });
        expect(await h.read('target.md')).toBe(recurring);
        const active = expectDefined(h.index.list({ filePath: 'target.md' })[0]);
        expect(active.ref).not.toEqual(h.parent.ref);
        expect(h.index.resolve(h.parent.ref)).toMatchObject({
          type: 'rebased',
          evidence: 'authority-transition',
          current: { ref: active.ref },
        });
        releaseFirst.resolve();
        await batch;
        expect(await h.read('source.md')).toBe('- [ ] First #batch\n');
        expect(await h.read('target.md')).toBe(recurring);
        expect(await h.read('last.md')).toBe('- [ ] Last\n');
        expect(execute).toHaveBeenCalledTimes(1);
      } finally {
        releaseFirst.resolve();
        await batch;
        f.commands.dispose();
        h.index.destroy();
      }
    },
  );

  it('continues to an unrelated byte-identical root relocated by the earlier bulk write', async () => {
    const h = await realCommands(
      '- [ ] First 🔁 every day 📅 2026-10-03\n- [ ] Later\n  - [ ] Child\n',
    );
    const later = expectDefined(h.index.list({ filePath: 'source.md' })[1]);
    const pending = [expectDefined([...taskTreeNodes(later)][0])];
    const execute = h.service.execute.bind(h.service);
    let resolution: ReturnType<typeof h.index.resolve> | undefined;
    vi.spyOn(h.service, 'execute').mockImplementation(async (command, options) => {
      const result = await execute(command, options);
      resolution ??= h.index.resolve(later.ref);
      return result;
    });
    try {
      await h.commands.setBulkTaskStatus(
        [expectDefined(h.nodes[0]), ...pending].map((task) => ({
          task,
          completion: { kind: 'allowed' },
        })),
        'x',
      );
      expect(resolution).toMatchObject({
        type: 'rebased',
        evidence: 'byte-identical-relocation',
        current: {
          source: { line: 2, originalBlock: '- [ ] Later\n  - [ ] Child' },
        },
      });
      expect(await h.read('source.md')).toBe(
        '- [ ] First 🔁 every day ➕ 2026-10-03 📅 2026-10-04\n- [x] First 🔁 every day 📅 2026-10-03 ✅ 2026-10-03\n- [x] Later ✅ 2026-10-03\n  - [ ] Child\n',
      );
    } finally {
      h.commands.dispose();
      h.index.destroy();
    }
  });

  it('patches both same-title siblings and their parent without rewriting prose', async () => {
    const h = await realCommands(
      '- [ ] Parent\n  - [ ] Child\n  - untouched comment\n  - [ ] Child\n\nprose\n',
    );
    await h.commands.applyBulkTaskTags(h.nodes, ['#new'], []);
    expect(await h.read('source.md')).toBe(
      '- [ ] Parent #new\n  - [ ] Child #new\n  - untouched comment\n  - [ ] Child #new\n\nprose\n',
    );
    h.commands.dispose();
    h.index.destroy();
  });
  it('stops after an externally edited later target and leaves subsequent nodes unchanged', async () => {
    const h = await realCommands('- [ ] Parent\n  - [ ] Child\n- [ ] Later\n- [ ] Last\n');
    const nodes = h.index.listNodes({ filePath: 'source.md' });
    const execute = h.service.execute.bind(h.service);
    let count = 0;
    vi.spyOn(h.service, 'execute').mockImplementation(async (command) => {
      if (++count === 2)
        await h.app.vault.modify(
          h.file('source.md'),
          (await h.read('source.md')).replace('Child', 'External'),
        );
      return execute(command);
    });
    await h.commands.applyBulkTaskTags(nodes, ['#new'], []);
    expect(count).toBe(2);
    expect(await h.read('source.md')).toBe(
      '- [ ] Parent #new\n  - [ ] External\n- [ ] Later\n- [ ] Last\n',
    );
    h.commands.dispose();
    h.index.destroy();
  });
  it('completes a deleting grandchild before its ancestors and never skips the shifted sibling', async () => {
    const h = await realCommands(
      '- [ ] Parent\n  - [ ] Child\n    - [ ] Grandchild 🏁 delete\n  - [ ] Sibling\n',
    );
    await h.commands.setBulkTaskStatus(
      h.nodes.map((task) => ({ task, completion: { kind: 'allowed' } })),
      '/',
    );
    expect(await h.read('source.md')).toBe(
      '- [/] Parent\n  - [/] Child\n    - [/] Grandchild 🏁 delete\n  - [/] Sibling\n',
    );
    h.commands.dispose();
    h.index.destroy();
  });
  it('keeps root and child selected while a recurring child creates its next occurrence', async () => {
    const h = await realCommands(
      '- [ ] Parent\n  - [ ] Child 🔁 every day 📅 2026-10-03\n  - [ ] Sibling\n',
    );
    await h.commands.setBulkTaskStatus(
      h.nodes.map((task) => ({ task, completion: { kind: 'allowed' } })),
      'x',
    );
    const roots = h.index.list({ filePath: 'source.md' });
    expect(roots[0]?.status).toBe('done');
    expect(
      roots[0]?.subtasks.map((child) => [child.title, child.status, child.planning.due]),
    ).toEqual([
      ['Child', 'open', '2026-10-04'],
      ['Child', 'done', '2026-10-03'],
      ['Sibling', 'done', undefined],
    ]);
    h.commands.dispose();
    h.index.destroy();
  });
  it('deduplicates selected occurrence capability and excludes only continuation-only nodes', async () => {
    const h = await realCommands('- [ ] Parent\n  - [ ] Child\n');
    const root = expectDefined(h.nodes[0]);
    const child = expectDefined(h.nodes[1]);
    const continuation = { kind: 'continuation' as const, due: localDate('2026-10-09') };
    await h.commands.setBulkTaskStatus(
      [
        { task: root, completion: continuation },
        { task: child, completion: continuation },
        { task: child, completion: { kind: 'allowed' } },
      ],
      '/',
    );
    expect(await h.read('source.md')).toBe('- [ ] Parent\n  - [/] Child\n');
    h.commands.dispose();
    h.index.destroy();
  });
});

it('deletes a selected subtree once and retains its exact receipt for undo', async () => {
  const source =
    '- [ ] Parent\n  - [ ] Child\n    - note\n    - [ ] Grandchild\n  - [ ] Child\n\nprose\n';
  const h = await realCommands(source);
  const execute = vi.spyOn(h.service, 'execute');
  await h.commands.deleteBulkTasks([
    expectDefined(h.nodes[2]),
    expectDefined(h.nodes[1]),
    expectDefined(h.nodes[2]),
  ]);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(await h.read('source.md')).toBe('- [ ] Parent\n  - [ ] Child\n\nprose\n');
  const result = await (expectDefined(execute.mock.results[0]).value as Promise<TaskCommandResult>);
  if (
    result.type !== 'ok' ||
    result.outcome.type !== 'task' ||
    result.outcome.subtaskRemovalRecovery === undefined
  )
    throw new Error('Missing child recovery receipt');
  expect(
    await h.service.execute({ type: 'restore-subtask', ...result.outcome.subtaskRemovalRecovery }),
  ).toMatchObject({ type: 'ok', changed: true });
  expect(await h.read('source.md')).toBe(source);
  h.commands.dispose();
  h.index.destroy();
});

it('completes deleting children deepest first and preserves the remaining ancestors', async () => {
  const h = await realCommands(
    '- [ ] Parent\n  - [ ] Child\n    - [ ] Grandchild 🏁 delete\n  - [ ] Sibling\n',
  );
  await h.commands.setBulkTaskStatus(
    h.nodes.map((task) => ({ task, completion: { kind: 'allowed' } })),
    'x',
  );
  expect(await h.read('source.md')).toBe(
    '- [x] Parent ✅ 2026-10-03\n  - [x] Child ✅ 2026-10-03\n  - [x] Sibling ✅ 2026-10-03\n',
  );
  h.commands.dispose();
  h.index.destroy();
});

it('archives one physical root once even when selected through duplicate occurrences', async () => {
  const f = await fixture();
  const root = task();
  f.execute.mockResolvedValue({
    type: 'ok',
    changed: true,
    outcome: { type: 'archived', ref: root.ref, filePath: 'archive.md' },
  });
  await f.commands.archiveTasks([root, root]);
  expect(f.execute).toHaveBeenCalledTimes(1);
  f.commands.dispose();
});

it('clears the deleted root from Inspector selection after a bulk delete', async () => {
  const f = await fixture();
  const root = task();
  f.state.set('taskStack', [root]);
  f.execute.mockResolvedValue({
    type: 'ok',
    changed: true,
    outcome: { type: 'deleted', ref: root.ref },
  });
  await f.commands.deleteBulkTasks([root]);
  expect(f.state.get('taskStack')).toEqual([]);
  f.commands.dispose();
});

it('rejects forecast source authority before resolving its template owner', async () => {
  const h = await hierarchyHarness();
  const child = expectDefined([...taskTreeNodes(h.source)][1]);
  const forecast = taskSnapshotForCalendarOccurrence({
    kind: 'forecast',
    key: 'forecast-child',
    source: child,
    planning: child.node.planning,
    referenceDate: localDate('2026-10-09'),
    ordinal: 1,
  });
  const resolve = vi.spyOn(h.index, 'resolve');
  expect(commandSource(forecast, h.index)).toBeUndefined();
  expect(resolve).not.toHaveBeenCalled();
  h.index.destroy();
});

it('routes duration from an exact child subject without dropping calendar authority', async () => {
  const h = await hierarchyHarness();
  const child = expectDefined([...taskTreeNodes(h.source)][1]);
  expect(commandPatch(child, { duration: { type: 'set', value: durationMinutes(90) } })).toEqual({
    type: 'patch',
    target: child.target,
    patch: { duration: { type: 'set', value: 90 } },
  });
  h.index.destroy();
});

it.each([false, true])(
  'keeps archive descriptors on delayed mounted rows and rejects intervening edits (%s)',
  async (externalEdit) => {
    const h = await hierarchyHarness({
      'source.md': '- [ ] First\n- [ ] Keep [[A]] [[B]]\n',
      'target.md': '- [ ] Parent\n',
    });
    const originals = h.index.list({ filePath: 'source.md' });
    let writes = 0;
    const application: TaskApplicationApi = {
      queries: h.index,
      execute: async (command) => {
        if (++writes > 1) return { type: 'invalid', issues: [{ code: 'invalid-target' }] };
        if (command.type !== 'archive') throw new Error('Expected archive');
        const result = await h.service.execute({ type: 'delete', ref: command.ref });
        if (result.type !== 'ok') throw new Error('Expected successful source deletion');
        return {
          type: 'ok',
          changed: true,
          outcome: { type: 'archived', ref: command.ref, filePath: 'archive.md' },
        };
      },
    };
    const f = await fixture(application);
    const links = [
      { key: 'note:A.md', label: 'A', target: 'A.md' },
      { key: 'note:B.md', label: 'B', target: 'B.md' },
    ];
    const rows = buildTaskListRows(originals, {
      by: 'outgoing-link',
      values: new Map([['source.md:1', links]]),
    });
    f.selection.bind(rows);
    f.selection.selectAll(rows, {});
    vi.spyOn(f.selection, 'inOrder').mockImplementation(() => {
      throw new Error('Enumerated occurrence keys');
    });
    await f.commands.archiveTasks(originals);
    expect(writes).toBe(2);
    expect(f.selection.selectedNodes(rows).map((entry) => entry.task.markdownTitle)).toEqual([
      'Keep [[A]] [[B]]',
    ]);
    expect(f.selection.ranges().every((range) => range.taskKey === 'source.md:1')).toBe(true);
    if (externalEdit) {
      await h.app.vault.modify(h.file('source.md'), '- [ ] Replacement\n');
      h.index.installCommittedContent('source.md', '- [ ] Replacement\n');
    }
    const incoming = buildTaskListRows(h.index.list({ filePath: 'source.md' }), {
      by: 'outgoing-link',
      values: new Map([['source.md:0', links]]),
    });
    f.commands.archiveSelectionRebase(
      (current) => {
        const key = `${current.source.filePath}:${current.source.line}`;
        return incoming.firstOccurrenceOf(key) === undefined ? undefined : key;
      },
      (physicalKeys) => {
        f.selection.bind(incoming, { physicalKeys });
      },
    );
    expect(f.selection.size).toBe(externalEdit ? 0 : 2);
    if (!externalEdit)
      expect(f.selection.ranges().every((range) => range.taskKey === 'source.md:0')).toBe(true);
    h.index.destroy();
  },
);

it.each([
  'before-result',
  'delayed',
  'partial-failure',
  'external-edit',
  'clear',
  'dispose',
] as const)('carries bounded owned root and child proof through %s', async (timing) => {
  const h = await hierarchyHarness({
    'source.md': '- [ ] First\n  - [ ] Child\n- [ ] Second\n',
    'target.md': '- [ ] Parent\n',
  });
  const originals = h.index.list({ filePath: 'source.md' });
  const sourceRows = () =>
    buildTaskNodeListRows(
      h.index.list({ filePath: 'source.md' }).flatMap((root) => [...taskTreeNodes(root)]),
      { by: 'none' },
    );
  let rows = sourceRows();
  let writes = 0;
  const application: TaskApplicationApi = {
    queries: h.index,
    execute: async (command) => {
      if (++writes === 2 && timing === 'partial-failure')
        return { type: 'invalid', issues: [{ code: 'invalid-target' }] };
      const result = await h.service.execute(command);
      if (timing === 'before-result') bind();
      if (timing === 'clear') f.selection.clear();
      if (timing === 'dispose') f.commands.dispose();
      return result;
    },
  };
  const f = await fixture(application, () =>
    f.selection.selectedNodes(rows).map((entry) => entry.task),
  );
  f.selection.bind(rows);
  f.selection.selectAll(rows, {});
  function bind() {
    const next = sourceRows();
    f.commands.ownedSelectionRebase(
      (current) => {
        const key = `${current.root.source.filePath}:${taskNodeSourceLine(current.target)}`;
        const occurrence = next.firstOccurrenceOf(key);
        const candidate = occurrence === undefined ? undefined : next.task(occurrence);
        return candidate !== undefined && sameTaskNodeRef(candidate.target, current.target)
          ? key
          : undefined;
      },
      (physicalKeys) => {
        f.selection.bind(next, { physicalKeys });
      },
    );
    rows = next;
  }
  await f.commands.applyBulkTaskTags(originals, ['owned'], []);
  if (timing === 'external-edit') {
    await h.app.vault.modify(h.file('source.md'), '- [ ] Replacement\n');
    h.index.installCommittedContent('source.md', '- [ ] Replacement\n');
  }
  if (timing !== 'before-result') bind();
  expect(f.selection.size).toBe(['clear', 'dispose', 'external-edit'].includes(timing) ? 0 : 3);
  f.commands.dispose();
  h.index.destroy();
});

it.each([false, true])(
  'preserves root and child selection with actual Inbox removal policy (%s)',
  async (removeTagOnAssign) => {
    const h = await hierarchyHarness({
      'source.md': '- [ ] Root #inbox\n  - [ ] Child #inbox\n',
      'target.md': '- [ ] Parent\n',
    });
    const service = new TaskApplicationService(
      h.index,
      h.repository,
      canonicalStatusCatalog(),
      clockFrom(Date.UTC(2026, 9, 3), 0),
      undefined,
      () => ({ ...DEFAULT_SETTINGS, inbox: { mode: 'tag', tag: '#inbox', removeTagOnAssign } }),
    );
    const nodes = () =>
      h.index.list({ filePath: 'source.md' }).flatMap((root) => [...taskTreeNodes(root)]);
    let rows = buildTaskNodeListRows(nodes(), { by: 'none' });
    const original = nodes();
    const application: TaskApplicationApi = {
      queries: h.index,
      execute: async (command, options) => {
        const result = await service.execute(command, options);
        const next = buildTaskNodeListRows(nodes(), { by: 'none' });
        f.commands.ownedSelectionRebase(
          (current) => {
            const key = `${current.root.source.filePath}:${taskNodeSourceLine(current.target)}`;
            const row = next.firstOccurrenceOf(key);
            return row !== undefined &&
              sameTaskNodeRef(expectDefined(next.task(row)).target, current.target)
              ? key
              : undefined;
          },
          (physicalKeys) => {
            f.selection.bind(next, { physicalKeys });
          },
        );
        rows = next;
        return result;
      },
    };
    const f = await fixture(application, () =>
      f.selection.selectedNodes(rows).map((entry) => entry.task),
    );
    f.selection.bind(rows);
    f.selection.selectAll(rows, {});
    await f.commands.applyBulkTaskTags(original, ['#owned'], []);
    expect(f.selection.size).toBe(2);
    expect(nodes().map((node) => node.node.tags)).toEqual(
      Array.from({ length: 2 }, () => (removeTagOnAssign ? ['#owned'] : ['#inbox', '#owned'])),
    );
    f.commands.dispose();
    h.index.destroy();
  },
);

it('keeps normalized root and child batch proof after UI selection evidence is retired', async () => {
  const h = await hierarchyHarness({
    'source.md': '- [ ] Root #inbox\n  - [ ] Child #inbox\n',
    'target.md': '- [ ] Parent\n',
  });
  const service = new TaskApplicationService(
    h.index,
    h.repository,
    canonicalStatusCatalog(),
    clockFrom(Date.UTC(2026, 9, 3), 0),
    undefined,
    () => ({
      ...DEFAULT_SETTINGS,
      inbox: { mode: 'tag', tag: '#inbox', removeTagOnAssign: true },
    }),
  );
  const nodes = () =>
    h.index.list({ filePath: 'source.md' }).flatMap((root) => [...taskTreeNodes(root)]);
  const original = nodes();
  const rows = buildTaskNodeListRows(original, { by: 'none' });
  const execute = vi.fn<TaskApplicationApi['execute']>(async (command, options) => {
    f.selection.clear();
    f.commands.retireSelectionEvidence();
    return service.execute(command, options);
  });
  const f = await fixture({ queries: h.index, execute });
  f.selection.bind(rows);
  f.selection.selectAll(rows, {});
  try {
    await f.commands.applyBulkTaskTags(original, ['#owned'], []);
    expect(nodes().map((node) => node.node.tags)).toEqual([['#owned'], ['#owned']]);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(f.selection.size).toBe(0);
  } finally {
    f.commands.dispose();
    h.index.destroy();
  }
});
