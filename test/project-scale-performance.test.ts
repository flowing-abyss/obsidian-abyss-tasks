import { describe, expect, it, vi } from 'vitest';
import { renderBoard } from '../src/panels/projects/ProjectsBoardView';
import { renderProjectsTable } from '../src/panels/projects/ProjectsTableView';
import { renderTimeline } from '../src/panels/projects/ProjectsTimelineView';
import { renderProjectTasksTable } from '../src/panels/projects/ProjectTasksTableView';
import type { ProjectAction, ProjectWorkspaceSnapshot } from '../src/projects/types';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { renderVirtualTable } from '../src/ui/table/VirtualTable';
import { freshContainer, task } from './helpers';

function projectAction(index: number): ProjectAction {
  return {
    task: task({
      title: `Task ${String(index)}`,
      source: { filePath: 'Projects/Scale.md', line: index },
    }),
    projectPath: 'Projects/Scale.md',
    dependency: { type: 'allowed' },
    owner: { type: 'project', path: 'Projects/Scale.md' },
  };
}

function projectSnapshot(index: number): ProjectWorkspaceSnapshot {
  return {
    project: {
      path: `Projects/${String(index)}.md`,
      name: `Project ${String(index)}`,
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
  };
}

describe('project workspace scale budget', () => {
  it('keeps a 500-task project table inside a small mounted DOM window', () => {
    const root = freshContainer();
    const actions = Array.from({ length: 500 }, (_, index) => projectAction(index));

    renderProjectTasksTable(root, actions, {
      settings: structuredClone(DEFAULT_SETTINGS),
      path: 'Projects/Scale.md',
      onActivate: vi.fn(),
    });

    expect(actions).toHaveLength(500);
    expect(root.querySelectorAll('[data-project-task-table-row]').length).toBeLessThan(30);
    expect(root.querySelectorAll('*').length).toBeLessThan(250);
  });

  it('keeps a 100-project portfolio table inside the same bounded shell', () => {
    const root = freshContainer();
    const projects = Array.from({ length: 100 }, (_, index) => projectSnapshot(index));

    renderProjectsTable(root, projects, {
      settings: structuredClone(DEFAULT_SETTINGS),
      onOpen: vi.fn(),
    });

    expect(projects).toHaveLength(100);
    expect(root.querySelectorAll('[data-project-table-row]').length).toBeLessThan(30);
    expect(root.querySelectorAll('*').length).toBeLessThan(300);
  });

  it('keeps 500 task cards bounded in Board without hiding the logical collection', () => {
    const root = freshContainer();
    const actions = Array.from({ length: 500 }, (_, index) => projectAction(index));

    renderBoard(root, {
      columns: [{ key: 'todo', label: 'To-do', role: 'regular', items: actions }],
      mutation: {
        move: vi.fn().mockResolvedValue({ type: 'ok' }),
        menuItems: () => [],
      },
      itemKey: ({ task: snapshot }) =>
        `${snapshot.source.filePath}:${String(snapshot.source.line)}`,
      renderItem: (host, { task: snapshot }) =>
        host.createEl('button', { text: snapshot.title, attr: { type: 'button' } }),
    });

    expect(actions).toHaveLength(500);
    expect(root.querySelectorAll('[data-board-item-surface]').length).toBeLessThan(30);
    expect(root.querySelectorAll('*').length).toBeLessThan(250);
  });

  it('keeps 100 project timeline rows inside a bounded vertical window', () => {
    const root = freshContainer();
    const projects = Array.from({ length: 100 }, (_, index) => projectSnapshot(index));

    renderTimeline(root, {
      scope: 'portfolio',
      today: '2026-08-31',
      entries: projects.map((snapshot, index) => ({
        value: snapshot,
        label: snapshot.project.name,
        item: {
          kind: 'point' as const,
          key: snapshot.project.path,
          atMs: Date.parse(`2026-09-${String((index % 28) + 1).padStart(2, '0')}T00:00:00Z`),
          role: 'start' as const,
        },
        dateByRole: { start: `2026-09-${String((index % 28) + 1).padStart(2, '0')}` },
      })),
      onSetDate: vi.fn().mockResolvedValue({ type: 'ok' }),
    });

    expect(projects).toHaveLength(100);
    expect(root.querySelectorAll('.abyss-timeline-row[data-timeline-key]').length).toBeLessThan(30);
    expect(root.querySelectorAll('*').length).toBeLessThan(400);
  });

  it('keeps no-op scrolls stable and remounts only one bounded slice after a meaningful scroll', () => {
    const root = freshContainer();
    const renderRow = vi.fn((row: number, parent: HTMLElement) =>
      parent.createDiv({ attr: { role: 'row', 'data-row': String(row) } }),
    );
    renderVirtualTable(root, {
      columns: [{ id: 'title', label: 'Title' }],
      rows: Array.from({ length: 500 }, (_, index) => index),
      key: String,
      label: 'Scale probe',
      renderRow,
    });
    const initialRenderCount = renderRow.mock.calls.length;
    const scroll = root.querySelector<HTMLElement>('.abyss-virtual-table-scroll')!;

    scroll.dispatchEvent(new Event('scroll'));

    expect(initialRenderCount).toBeLessThan(30);
    expect(renderRow).toHaveBeenCalledTimes(initialRenderCount);

    scroll.scrollTop = 3200;
    scroll.dispatchEvent(new Event('scroll'));

    expect(renderRow.mock.calls.length).toBeGreaterThan(initialRenderCount);
    expect(renderRow.mock.calls.length).toBeLessThan(50);
    expect(root.querySelectorAll('[data-row]').length).toBeLessThan(30);
  });
});
