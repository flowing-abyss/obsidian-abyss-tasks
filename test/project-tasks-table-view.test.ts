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
});
