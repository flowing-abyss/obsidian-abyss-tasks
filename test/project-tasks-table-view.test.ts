import { describe, expect, it, vi } from 'vitest';
import { renderProjectTasksTable } from '../src/panels/projects/ProjectTasksTableView';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { freshContainer, task } from './helpers';

describe('ProjectTasksTableView', () => {
  it('renders an explicit bounded table with a non-reserved Next Action marker', () => {
    const root = freshContainer();
    renderProjectTasksTable(
      root,
      [
        {
          task: task({ title: 'Ship', tags: ['#task/next_action'] }),
          projectPath: 'Projects/A.md',
          dependency: { type: 'allowed' },
          owner: { type: 'project', path: 'Projects/A.md' },
        },
      ],
      { settings: structuredClone(DEFAULT_SETTINGS), path: 'Projects/A.md', onActivate: vi.fn() },
    );
    const table = root.querySelector('[role="table"]')!;
    expect(
      Array.from(table.querySelectorAll('[role="columnheader"]')).map((cell) => cell.textContent),
    ).toEqual(['Task', 'Status', 'Priority', 'Due', 'Next action']);
    expect(table.querySelectorAll('[data-next-action="true"]')).toHaveLength(1);
  });

  it('honors configured order, hidden and unknown columns and persists resize and collapse changes', () => {
    const root = freshContainer();
    const preference = {
      version: 1 as const,
      columns: [
        { propertyId: 'due', visible: true, width: 140 },
        { propertyId: 'task', visible: true, width: 280 },
        { propertyId: 'estimate', visible: true, width: 100 },
        { propertyId: 'status', visible: false },
      ],
      collapsedGroups: ['priority:A'],
    };
    const changed = vi.fn();
    renderProjectTasksTable(
      root,
      [
        {
          task: task({ title: 'Ship', priority: 'A', planning: { due: '2026-09-01' as never } }),
          projectPath: 'Projects/A.md',
          dependency: { type: 'allowed' },
          owner: { type: 'project', path: 'Projects/A.md' },
        },
      ],
      {
        settings: structuredClone(DEFAULT_SETTINGS),
        path: 'Projects/A.md',
        preference,
        groupBy: 'priority',
        onPreferenceChange: changed,
        onActivate: vi.fn(),
      },
    );

    expect(
      Array.from(root.querySelectorAll('[role="columnheader"]')).map((cell) => cell.textContent),
    ).toEqual(['Due', 'Task', 'Estimate']);
    expect(root.querySelectorAll('[data-project-task-table-row]')).toHaveLength(0);
    root.querySelector<HTMLButtonElement>('[data-table-group="priority:A"] button')!.click();
    expect(changed).toHaveBeenCalledWith({ ...preference, collapsedGroups: [] });

    root
      .querySelector<HTMLButtonElement>('[data-table-resize="due"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(changed).toHaveBeenLastCalledWith({
      ...preference,
      columns: [
        { propertyId: 'due', visible: true, width: 148 },
        { propertyId: 'task', visible: true, width: 280 },
        { propertyId: 'estimate', visible: true, width: 100 },
        { propertyId: 'status', visible: false },
      ],
    });
  });

  it('bounds a 500-task grouped route and activates a focused cell with the keyboard', () => {
    const root = freshContainer();
    const activate = vi.fn();
    const actions = Array.from({ length: 500 }, (_, index) => ({
      task: task({
        title: `Task ${String(index)}`,
        source: { filePath: 'Projects/A.md', line: index },
      }),
      projectPath: 'Projects/A.md',
      dependency: { type: 'allowed' as const },
      owner: { type: 'project' as const, path: 'Projects/A.md' },
    }));
    renderProjectTasksTable(root, actions, {
      settings: structuredClone(DEFAULT_SETTINGS),
      path: 'Projects/A.md',
      groupBy: 'status',
      onActivate: activate,
    });
    expect(root.querySelectorAll('[data-project-task-table-row]').length).toBeLessThan(30);
    const taskCell = root.querySelector<HTMLElement>(
      '.abyss-virtual-table-row [data-table-column="task"]',
    )!;
    expect(taskCell.tabIndex).toBe(0);
    taskCell.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(activate).toHaveBeenCalledOnce();
  });

  it('forwards a real row context-menu event to the shared task action callback', () => {
    const root = freshContainer();
    const action = {
      task: task({ title: 'Ship', source: { filePath: 'Projects/A.md', line: 1 } }),
      projectPath: 'Projects/A.md',
      dependency: { type: 'allowed' as const },
      owner: { type: 'project' as const, path: 'Projects/A.md' },
    };
    const openActions = vi.fn();
    renderProjectTasksTable(root, [action], {
      settings: structuredClone(DEFAULT_SETTINGS),
      path: 'Projects/A.md',
      onActivate: vi.fn(),
      onContextMenu: openActions,
    });

    root
      .querySelector<HTMLElement>('[data-project-task-table-row]')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    expect(openActions).toHaveBeenCalledWith(
      expect.any(MouseEvent),
      action,
      root.querySelector('[data-project-task-table-row]'),
    );

    const row = root.querySelector<HTMLElement>('[data-project-task-table-row]')!;
    const focus = vi.spyOn(row, 'focus');
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }));
    expect(openActions).toHaveBeenLastCalledWith(expect.any(MouseEvent), action, row);
    expect(focus).not.toHaveBeenCalled();
  });
});
