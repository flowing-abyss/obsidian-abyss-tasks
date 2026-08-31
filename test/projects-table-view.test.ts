import { describe, expect, it, vi } from 'vitest';
import { renderProjectsTable } from '../src/panels/projects/ProjectsTableView';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { freshContainer } from './helpers';

const snapshot = (index: number) => ({
  project: {
    path: `Projects/${index}.md`,
    name: `Project ${index}`,
    frontmatter: {},
    tags: [],
    statusId: null,
    rawStatus: null,
    range: {},
    stats: { total: 0, done: 0, cancelled: 0, inProgress: 0, open: 0, progress: null },
  },
  tasks: [],
  workNotes: [],
  milestones: [],
  taskRollup: { total: 0, done: 0, cancelled: 0, inProgress: 0, open: 0, progress: null },
  workNoteRollup: { active: 0, completed: 0, dropped: 0 },
  milestoneRollups: new Map(),
  workNoteRelations: [],
  overdue: { tasks: 0, workNotes: 0 },
  dependencies: { blocked: 0, invalid: 0, diagnostics: [] },
  diagnostics: [],
});

describe('ProjectsTableView', () => {
  it('renders the accessible default table through a bounded row window', () => {
    const root = freshContainer();
    renderProjectsTable(
      root,
      Array.from({ length: 120 }, (_, index) => snapshot(index)),
      { settings: structuredClone(DEFAULT_SETTINGS), onOpen: vi.fn() },
    );
    const table = root.querySelector('[role="table"]')!;
    expect(
      Array.from(table.querySelectorAll('[role="columnheader"]')).map((cell) => cell.textContent),
    ).toEqual(['Project', 'Status', 'Priority', 'Progress', 'Next action', 'Start', 'End']);
    expect(table.querySelectorAll('[role="row"]').length).toBeLessThan(120);
  });
});
