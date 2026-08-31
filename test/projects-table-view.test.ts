import { Menu, type MenuItem } from 'obsidian';
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

  it('keeps custom property cells presentational until explicit edit activation without normalizing unsupported values', () => {
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
    expect(table.querySelector('[data-property-editor="estimate"]')).toBeNull();
    const estimate = table.querySelector<HTMLElement>(
      '[role="cell"][data-table-column="estimate"]',
    )!;
    expect(estimate.title).toBe('3');
    expect(estimate.getAttribute('aria-label')).toBe('3');
    estimate.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const editor = table.querySelector<HTMLElement>('[data-property-editor="estimate"]')!;
    expect(editor.title).toBe('3');
    expect(editor.getAttribute('aria-label')).toContain('3');
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
    expect(root.querySelector('[data-property-editor="client"]')).toBeNull();
    root
      .querySelector<HTMLElement>('[role="cell"][data-table-column="client"]')!
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(root.querySelector('[data-property-editor="client"]')).not.toBeNull();
  });

  it('renders configured lifecycle carriers and specialised metadata as readable non-editable cells', () => {
    const root = freshContainer();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.projects.statuses[0] = {
      ...settings.projects.statuses[0]!,
      match: { kind: 'property', property: 'phase', value: 'active' },
    };
    settings.projects.view.table = {
      version: 1,
      columns: [
        { propertyId: 'phase', visible: true },
        { propertyId: 'tags', visible: true },
        { propertyId: 'description', visible: true },
        { propertyId: 'comments', visible: true },
      ],
      collapsedGroups: [],
    };
    const project = snapshot(1);
    project.project.frontmatter = {
      phase: 'active',
      tags: ['project/active'],
      description: 'Keep this',
      comments: ['2026-08-31: Preserve this'],
    };
    renderProjectsTable(root, [project], { settings, onOpen: vi.fn() });
    expect(root.querySelector('[data-property-editor]')).toBeNull();
    expect(root.querySelector('[role="table"]')?.textContent).toContain('Preserve this');
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
    const cell = root.querySelector<HTMLElement>('[role="cell"][data-table-column="estimate"]')!;
    cell.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
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
    const cell = root.querySelector<HTMLElement>('[role="cell"][data-table-column="title"]')!;
    cell.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
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
    root
      .querySelector<HTMLElement>('[role="cell"][data-table-column="priority"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    root
      .querySelector<HTMLElement>('[role="cell"][data-table-column="start"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
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

  it('offers separate Open project and Open note actions before guarded Status and Priority menus', () => {
    const root = freshContainer();
    const openProject = vi.fn();
    const openNote = vi.fn();
    const items: Array<{ title: string; activate: () => void }> = [];
    vi.spyOn(Menu.prototype, 'showAtMouseEvent').mockImplementation(function (this: Menu) {
      return this;
    });
    vi.spyOn(Menu.prototype, 'addItem').mockImplementation(function (this: Menu, build) {
      let title = '';
      let activate = (): void => undefined;
      let recorded = false;
      const item = {
        setTitle(value: string) {
          title = value;
          if (!recorded) {
            recorded = true;
            items.push({
              get title() {
                return title;
              },
              activate: () => activate(),
            });
          }
          return this;
        },
        setIcon() {
          return this;
        },
        setChecked() {
          return this;
        },
        onClick(callback: () => void) {
          activate = callback;
          return this;
        },
        setSubmenu() {
          return new Menu();
        },
      } as unknown as MenuItem;
      build(item);
      return item as unknown as Menu;
    });
    try {
      renderProjectsTable(root, [snapshot(1)], {
        settings: structuredClone(DEFAULT_SETTINGS),
        onOpen: openProject,
        onOpenNote: openNote,
        onSetStatus: vi.fn().mockResolvedValue({ type: 'ok' }),
        onSetPriority: vi.fn().mockResolvedValue({ type: 'ok' }),
      });
      root.querySelector<HTMLButtonElement>('[aria-label="Project actions"]')!.click();
      const titles = items.map(({ title }) => title);
      expect(titles.indexOf('Open project')).toBeLessThan(titles.indexOf('Open note'));
      expect(titles.indexOf('Open note')).toBeLessThan(titles.indexOf('Status'));
      expect(titles.indexOf('Status')).toBeLessThan(titles.indexOf('Priority'));
      items.find(({ title }) => title === 'Open project')!.activate();
      items.find(({ title }) => title === 'Open note')!.activate();
      expect(openProject).toHaveBeenCalledWith('Projects/1.md');
      expect(openNote).toHaveBeenCalledWith('Projects/1.md');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('honors persisted custom order and width and commits keyboard resize without dropping unknown fields', () => {
    const root = freshContainer();
    const settings = structuredClone(DEFAULT_SETTINGS);
    const preference = {
      version: 1 as const,
      columns: [
        { propertyId: 'client', visible: true, width: 210 },
        { propertyId: 'project', visible: true, width: 260 },
        { propertyId: 'dormant-field', visible: true, width: 125 },
        { propertyId: 'status', visible: false, width: 90 },
      ],
      collapsedGroups: [],
    };
    const project = snapshot(1);
    project.project.frontmatter = { client: 'Northwind' };
    const changed = vi.fn();
    renderProjectsTable(root, [project], {
      settings,
      preference,
      onPreferenceChange: changed,
      onOpen: vi.fn(),
    });

    expect(
      Array.from(root.querySelectorAll('[role="columnheader"]')).map((cell) => cell.textContent),
    ).toEqual(['Client', 'Project', 'Dormant field']);
    expect(
      root
        .querySelector<HTMLElement>('[role="table"]')!
        .style.getPropertyValue('--abyss-table-columns'),
    ).toBe('210px 260px 125px');

    root
      .querySelector<HTMLButtonElement>('[data-table-resize="client"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(changed).toHaveBeenCalledWith({
      ...preference,
      columns: [
        { propertyId: 'client', visible: true, width: 202 },
        { propertyId: 'project', visible: true, width: 260 },
        { propertyId: 'dormant-field', visible: true, width: 125 },
        { propertyId: 'status', visible: false, width: 90 },
      ],
    });
  });

  it('sorts stably, renders collapsible groups, and exposes cell values to keyboard focus', () => {
    const root = freshContainer();
    const settings = structuredClone(DEFAULT_SETTINGS);
    const first = snapshot(2);
    first.project.name = 'Same';
    first.project.priority = 'A';
    first.project.frontmatter = { client: 'A very long client value' };
    const second = snapshot(1);
    second.project.name = 'Same';
    second.project.priority = 'B';
    const changed = vi.fn();
    const preference = {
      version: 1 as const,
      columns: [
        { propertyId: 'project', visible: true },
        { propertyId: 'client', visible: true },
      ],
      collapsedGroups: ['priority:B'],
    };
    renderProjectsTable(root, [first, second], {
      settings,
      preference,
      groupBy: 'priority',
      sortBy: { field: 'title', dir: 'asc' },
      onPreferenceChange: changed,
      onOpen: vi.fn(),
    });

    expect(
      Array.from(root.querySelectorAll<HTMLElement>('[data-table-group]')).map(
        (group) => group.dataset['tableGroup'],
      ),
    ).toEqual(['priority:A', 'priority:B']);
    expect(root.querySelectorAll('[data-project-table-row]')).toHaveLength(1);
    const value = root.querySelector<HTMLElement>(
      '.abyss-virtual-table-row [data-table-column="client"]',
    )!;
    expect(value.tabIndex).toBe(0);
    expect(value.title).toBe('A very long client value');

    root.querySelector<HTMLButtonElement>('[data-table-group="priority:B"] button')!.click();
    expect(changed).toHaveBeenCalledWith({ ...preference, collapsedGroups: [] });
  });

  it('does not turn a keyboard action on an editor or overflow control into row activation', () => {
    const root = freshContainer();
    const open = vi.fn();
    renderProjectsTable(root, [snapshot(1)], {
      settings: structuredClone(DEFAULT_SETTINGS),
      onOpen: open,
    });

    root
      .querySelector<HTMLButtonElement>('.abyss-project-overflow-btn')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(open).not.toHaveBeenCalled();
  });
});
