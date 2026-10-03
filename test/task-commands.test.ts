import { describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import type { LinkToken } from '../src/markdown/links';
import { TaskCommands } from '../src/panels/center/TaskCommands';
import { buildTaskListRows } from '../src/panels/task-list/taskListRows';
import { TaskRowSelection } from '../src/panels/task-list/taskRowSelection';
import type { ProjectManager } from '../src/projects/ProjectManager';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { StatusRegistry } from '../src/status/StatusRegistry';
import {
  localDate,
  type TaskApplicationApi,
  type TaskCommand,
  type TaskSnapshot,
} from '../src/tasks';
import { LinkEditModal } from '../src/ui/LinkEditModal';
import { noInteractionOwnership } from '../src/ui/interactionOwnership';
import { taskSnapshotForCalendarOccurrence } from '../src/views/calendarOccurrences';
import {
  createAppWithFiles,
  expectDefined,
  flushMicrotasks,
  subtask,
  task,
  taskQueryApi,
} from './helpers';

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

async function fixture() {
  const app = await createAppWithFiles({});
  const execute = vi
    .fn<TaskApplicationApi['execute']>()
    .mockResolvedValue({ type: 'invalid', issues: [{ code: 'invalid-target' }] });
  const tasks: TaskApplicationApi = { queries: taskQueryApi(), execute };
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
  const commands = new TaskCommands({
    app,
    state: new AppState(),
    tasks,
    statusRegistry: new StatusRegistry(DEFAULT_SETTINGS.taskStatuses),
    interactionOwnership: noInteractionOwnership,
    projectManager: { moveTaskToProject: move } as unknown as ProjectManager,
    selection,
    rows: () => buildTaskListRows(tasks.queries.list(), { by: 'none' }),
    onSelectionChanged,
  });
  return { commands, execute, tasks, move, selection, onSelectionChanged, app };
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
      const child = subtask();
      const root = task({ subtasks: [child] });
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
