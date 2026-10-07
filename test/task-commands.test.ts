import { describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import type { LinkToken } from '../src/markdown/links';
import { commandSource, TaskCommands } from '../src/panels/center/TaskCommands';
import { buildTaskListRows } from '../src/panels/task-list/taskListRows';
import { TaskRowSelection } from '../src/panels/task-list/taskRowSelection';
import type { ProjectManager } from '../src/projects/ProjectManager';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { StatusRegistry } from '../src/status/StatusRegistry';
import {
  localDate,
  type TaskApplicationApi,
  type TaskCommand,
  type TaskCommandResult,
  type TaskSnapshot,
} from '../src/tasks';
import { taskTreeNodes } from '../src/tasks/domain/taskSearchProjection';
import { LinkEditModal } from '../src/ui/LinkEditModal';
import { noInteractionOwnership } from '../src/ui/interactionOwnership';
import { taskSnapshotForCalendarOccurrence } from '../src/views/calendarOccurrences';
import { createAppWithFiles, expectDefined, flushMicrotasks, task, taskQueryApi } from './helpers';
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

async function fixture(application?: TaskApplicationApi) {
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
    rows: () => buildTaskListRows(tasks.queries.list(), { by: 'none' }),
    onSelectionChanged,
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
        expect(f.execute).toHaveBeenCalledExactlyOnceWith(command(current));
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
    async ({ submit, command }) => {
      const f = await fixture();
      const h = await hierarchyHarness();
      const root = h.source;
      const source = {
        root,
        node: expectDefined(root.subtasks[0]),
        target: { type: 'subtask' as const, ref: expectDefined(root.subtasks[0]).ref },
      };
      const current = taskSnapshotForCalendarOccurrence({
        kind: 'materialized',
        key: 'child',
        source,
        planning: {},
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
        else
          expect(f.execute).toHaveBeenCalledExactlyOnceWith({ ...expected, target: source.target });
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
