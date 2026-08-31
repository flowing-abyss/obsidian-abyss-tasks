import { describe, expect, it, vi } from 'vitest';
import { renderProjectsTable } from '../src/panels/projects/ProjectsTableView';
import type { ProjectWorkspaceSnapshot } from '../src/projects/types';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { flushMicrotasks, freshContainer } from './helpers';

const snapshot = (index: number): ProjectWorkspaceSnapshot => ({
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

  it('renders arbitrary frontmatter fields and exposes typed edit controls without normalizing unsupported values', () => {
    const root = freshContainer();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.projects.view.table = {
      version: 1,
      columns: [
        { propertyId: 'project', visible: true },
        { propertyId: 'estimate', visible: true },
        { propertyId: 'nested', visible: true },
      ],
      collapsedGroups: [],
    };
    const project = snapshot(1);
    project.project.frontmatter = { estimate: 3, nested: { preserve: true } };
    renderProjectsTable(root, [project], { settings, onOpen: vi.fn() });
    const table = root.querySelector('[role="table"]')!;
    expect(
      Array.from(table.querySelectorAll('[role="columnheader"]')).map((cell) => cell.textContent),
    ).toEqual(['Project', 'Estimate', 'Nested']);
    expect(table.querySelector('[data-property-editor="estimate"]')).not.toBeNull();
    expect(table.textContent).toContain('{"preserve":true}');
    expect(table.querySelector('[data-property-editor="nested"]')).toBeNull();
  });

  it('uses an optional public Bases descriptor for an empty configured Table field', () => {
    const root = freshContainer();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.projects.view.table = {
      version: 1,
      columns: [
        { propertyId: 'project', visible: true },
        { propertyId: 'client', visible: true },
      ],
      collapsedGroups: [],
    };
    renderProjectsTable(root, [snapshot(1)], {
      settings,
      onOpen: vi.fn(),
      bases: [{ id: 'client', displayName: 'Client note', kind: 'link', writable: true }],
    });
    expect(
      Array.from(root.querySelectorAll('[role="columnheader"]')).map((cell) => cell.textContent),
    ).toEqual(['Project', 'Client note']);
    expect(root.querySelector('[data-property-editor="client"]')).not.toBeNull();
  });

  it('commits a parsed custom-property edit and restores a conflicted editor to its settled carrier', async () => {
    const root = freshContainer();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.projects.view.table = {
      version: 1,
      columns: [
        { propertyId: 'project', visible: true },
        { propertyId: 'estimate', visible: true },
      ],
      collapsedGroups: [],
    };
    const project = snapshot(1);
    project.project.frontmatter = { estimate: 3 };
    const write = vi
      .fn()
      .mockResolvedValueOnce({ type: 'ok', value: 4 })
      .mockResolvedValueOnce({ type: 'conflict', current: 9 });
    renderProjectsTable(root, [project], { settings, onOpen: vi.fn(), onWriteProperty: write });
    const editor = root.querySelector<HTMLInputElement>('[data-property-editor="estimate"]')!;

    editor.value = '4';
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    await flushMicrotasks();
    expect(write).toHaveBeenLastCalledWith({
      path: 'Projects/1.md',
      propertyId: 'estimate',
      expected: 3,
      next: 4,
    });

    editor.value = '5';
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    await flushMicrotasks();
    expect(editor.value).toBe('9');
    expect(root.textContent).toContain('changed elsewhere');
  });

  it('cancels an in-progress property draft with Escape without writing or losing focus control', () => {
    const root = freshContainer();
    const project = snapshot(1);
    project.project.frontmatter = { title: 'Original' };
    const write = vi.fn();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.projects.view.table = {
      version: 1,
      columns: [
        { propertyId: 'project', visible: true },
        { propertyId: 'title', visible: true },
      ],
      collapsedGroups: [],
    };
    renderProjectsTable(root, [project], { settings, onOpen: vi.fn(), onWriteProperty: write });
    const editor = root.querySelector<HTMLInputElement>('[data-property-editor="title"]')!;
    editor.focus();
    editor.value = 'Draft';
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(editor.value).toBe('Original');
    expect(write).not.toHaveBeenCalled();
    expect(activeDocument.activeElement).not.toBe(editor);
  });

  it('routes built-in status, priority, and range edits through their guarded callbacks', async () => {
    const root = freshContainer();
    const base = snapshot(1);
    const project: ProjectWorkspaceSnapshot = {
      ...base,
      project: {
        ...base.project,
        priority: 'C',
        range: { start: { raw: '2026-08-31', precision: 'date', instantMs: 0 } },
      },
    };
    const status = vi.fn().mockResolvedValue({ type: 'ok' });
    const priority = vi.fn().mockResolvedValue({ type: 'ok' });
    const range = vi.fn().mockResolvedValue({ type: 'ok' });
    renderProjectsTable(root, [project], {
      settings: structuredClone(DEFAULT_SETTINGS),
      onOpen: vi.fn(),
      onSetStatus: status,
      onSetPriority: priority,
      onSetRange: range,
    });
    const priorityEditor = root.querySelector<HTMLSelectElement>(
      '[data-property-editor="priority"]',
    )!;
    priorityEditor.value = 'A';
    priorityEditor.dispatchEvent(new Event('change', { bubbles: true }));
    const startEditor = root.querySelector<HTMLInputElement>('[data-property-editor="start"]')!;
    startEditor.value = '2026-09-01';
    startEditor.dispatchEvent(new Event('change', { bubbles: true }));
    await flushMicrotasks();
    expect(priority).toHaveBeenCalledWith('Projects/1.md', 'A');
    expect(range).toHaveBeenCalledWith('Projects/1.md', 'start', '2026-09-01');
  });
});
