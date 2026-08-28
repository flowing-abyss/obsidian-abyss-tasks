import { describe, expect, it, vi } from 'vitest';
import {
  createProjectBoardMutation,
  createTaskBoardMutation,
  projectActionBoardColumns,
  projectBoardColumns,
  taskBoardColumns,
} from '../src/panels/projects/boardProjection';
import type { Project } from '../src/projects/types';
import type { ProjectStatus, TaskStatusDef } from '../src/settings/types';
import { task } from './helpers';

const projectStatuses: ProjectStatus[] = [
  {
    id: 'active',
    label: 'Active',
    behavior: 'regular',
    onLeftPanel: true,
    match: { kind: 'tag', tag: 'project/active' },
  },
  {
    id: 'published',
    label: 'Published',
    behavior: 'published',
    onLeftPanel: false,
    match: { kind: 'tag', tag: 'project/published' },
  },
  {
    id: 'completed',
    label: 'Completed',
    behavior: 'completed',
    onLeftPanel: false,
    match: { kind: 'tag', tag: 'project/completed' },
  },
  {
    id: 'dropped',
    label: 'Dropped',
    behavior: 'dropped',
    onLeftPanel: false,
    match: { kind: 'tag', tag: 'project/dropped' },
  },
];

function project(path: string, statusId: string | null): Project {
  return {
    path,
    name: path.replace(/^.*\//u, '').replace(/\.md$/u, ''),
    frontmatter: {},
    tags: [],
    statusId,
    rawStatus: statusId === null ? 'legacy' : null,
    range: {},
    stats: { total: 0, done: 0, cancelled: 0, inProgress: 0, open: 0, progress: null },
  };
}

describe('board projections', () => {
  it('orders Dropped, non-terminal configured statuses, Unmapped, Published', () => {
    const projects = [
      project('Projects/A.md', 'active'),
      project('Projects/B.md', 'completed'),
      project('Projects/C.md', null),
    ];

    expect(projectBoardColumns(projectStatuses, projects).map((column) => column.key)).toEqual([
      'dropped',
      'active',
      'completed',
      'unmapped',
      'published',
    ]);
    expect(projectBoardColumns(projectStatuses, projects).map((column) => column.role)).toEqual([
      'terminal-left',
      'regular',
      'regular',
      'unmapped',
      'terminal-right',
    ]);
  });

  it('applies the reconciled regular-column override while preserving lifecycle bookends', () => {
    const projects = [
      project('Projects/A.md', 'active'),
      project('Projects/B.md', 'completed'),
      project('Projects/C.md', null),
    ];

    expect(
      projectBoardColumns(projectStatuses, projects, {
        columnOrder: ['published', 'completed', 'dropped', 'active'],
        includeUnmapped: false,
      }).map(({ key }) => key),
    ).toEqual(['dropped', 'completed', 'active', 'published']);
  });

  it('retains canonical project order inside every status column', () => {
    const projects = [
      project('Projects/Z.md', 'active'),
      project('Projects/A.md', 'completed'),
      project('Projects/B.md', 'active'),
    ];

    const active = projectBoardColumns(projectStatuses, projects).find(
      ({ key }) => key === 'active',
    );
    expect(active?.items.map(({ path }) => path)).toEqual(['Projects/Z.md', 'Projects/B.md']);
  });

  it('keeps two configured Task statuses of the same semantic type separate', () => {
    const statuses: TaskStatusDef[] = [
      { id: 'todo-a', symbol: ' ', name: 'Ready', type: 'todo', icon: 'circle', core: false },
      {
        id: 'todo-b',
        symbol: '?',
        name: 'Needs input',
        type: 'todo',
        icon: 'help-circle',
        core: false,
      },
    ];
    const tasks = [
      task({ title: 'Ready', statusSymbol: ' ' }),
      task({ title: 'Question', statusSymbol: '?' }),
    ];

    const columns = taskBoardColumns(statuses, tasks);

    expect(columns.map(({ key }) => key)).toEqual(['todo-a', 'todo-b']);
    expect(columns.map(({ label }) => label)).toEqual(['Ready', 'Needs input']);
    expect(columns.map(({ items }) => items.map(({ title }) => title))).toEqual([
      ['Ready'],
      ['Question'],
    ]);
  });

  it('includes inherited Work Note actions in the Project task board', () => {
    const direct = task({ title: 'Direct' });
    const inherited = task({ title: 'Inherited' });

    expect(
      projectActionBoardColumns(
        [{ id: 'todo', symbol: ' ', name: 'Todo', type: 'todo', icon: '', core: true }],
        [
          {
            task: direct,
            projectPath: 'Projects/A.md',
            dependency: { type: 'allowed' },
            owner: { type: 'project', path: 'Projects/A.md' },
          },
          {
            task: inherited,
            projectPath: 'Projects/A.md',
            dependency: { type: 'allowed' },
            owner: { type: 'work-note', path: 'Notes/Work.md' },
          },
        ],
      ).flatMap(({ items }) => items.map(({ task }) => task)),
    ).toEqual([direct, inherited]);
  });

  it.each(['project', 'task'] as const)(
    'uses one complete configured status model and command path for %s drag and menu',
    async (kind) => {
      if (kind === 'project') {
        const item = project('Projects/A.md', 'active');
        const command = vi.fn().mockResolvedValue({
          type: 'ok',
          previousStatusId: 'active',
          nextStatusId: 'published',
        });
        const mutation = createProjectBoardMutation(projectStatuses, command);
        expect(
          mutation.menuItems(item).map(({ columnKey, label, icon, checked, disabled }) => ({
            columnKey,
            label,
            icon,
            checked,
            disabled,
          })),
        ).toEqual(
          projectStatuses.map((status) => ({
            columnKey: status.id,
            label: status.label,
            icon: 'circle-dot',
            checked: status.id === 'active',
            disabled: status.id === 'active',
          })),
        );

        const drag = await mutation.move(item, 'published');
        const menu = await mutation.move(item, mutation.menuItems(item)[1]!.columnKey);
        expect(drag).toEqual(menu);
        expect(command).toHaveBeenNthCalledWith(1, item, 'published');
        expect(command).toHaveBeenNthCalledWith(2, item, 'published');
        return;
      }

      const statuses: TaskStatusDef[] = [
        { id: 'todo-a', symbol: ' ', name: 'Ready', type: 'todo', icon: 'circle', core: false },
        {
          id: 'todo-b',
          symbol: '?',
          name: 'Needs input',
          type: 'todo',
          icon: 'help-circle',
          core: false,
        },
      ];
      const item = task({ title: 'Ready', statusSymbol: ' ' });
      const command = vi.fn().mockResolvedValue(undefined);
      const mutation = createTaskBoardMutation(statuses, command);
      expect(
        mutation.menuItems(item).map(({ columnKey, label, icon, checked, disabled }) => ({
          columnKey,
          label,
          icon,
          checked,
          disabled,
        })),
      ).toEqual([
        { columnKey: 'todo-a', label: 'Ready', icon: 'circle', checked: true, disabled: true },
        {
          columnKey: 'todo-b',
          label: 'Needs input',
          icon: 'help-circle',
          checked: false,
          disabled: false,
        },
      ]);

      await mutation.move(item, 'todo-b');
      await mutation.move(item, mutation.menuItems(item)[1]!.columnKey);
      expect(command).toHaveBeenNthCalledWith(1, item, '?');
      expect(command).toHaveBeenNthCalledWith(2, item, '?');
    },
  );
});
