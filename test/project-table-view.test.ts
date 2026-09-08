import { Menu } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { ProjectsTableView } from '../src/panels/projects/ProjectsTableView';
import type { ProjectPropertyCatalog } from '../src/projects/ObsidianProjectProperties';
import type { ProjectFieldCatalogItem } from '../src/projects/projectFields';
import type { Project } from '../src/projects/types';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { CalendarSettings } from '../src/settings/types';
import { expectDefined, flushMicrotasks, freshContainer } from './helpers';

const active = expectDefined(DEFAULT_SETTINGS.projects.statuses[0]);
afterEach(() => {
  activeDocument.body.empty();
  vi.restoreAllMocks();
});

function project(over: Partial<Project>): Project {
  return {
    path: 'Projects/A.md',
    name: 'A',
    frontmatter: { start: '2026-09-01', end: '2026-09-30' },
    tags: [],
    statusId: active.id,
    rawStatus: null,
    stats: { total: 10, done: 6, cancelled: 0, inProgress: 0 },
    ...over,
  };
}

function settings(): CalendarSettings {
  return structuredClone(DEFAULT_SETTINGS);
}

function catalog(
  properties: ReturnType<ProjectPropertyCatalog['list']> = [],
): ProjectPropertyCatalog {
  return { list: () => properties, values: () => [], onChange: () => () => {} };
}

function mount(
  projects: Project[],
  overrides: Partial<ConstructorParameters<typeof ProjectsTableView>[1]> = {},
) {
  const host = freshContainer();
  activeDocument.body.append(host);
  const config = settings();
  const saveSettings = vi.fn().mockResolvedValue(undefined);
  const saveProperty = vi.fn().mockResolvedValue(undefined);
  const saveStatus = vi.fn().mockResolvedValue(undefined);
  const openProject = vi.fn();
  const view = new ProjectsTableView(host, {
    app: null as never,
    state: new AppState(),
    settings: config,
    catalog: catalog(),
    saveSettings,
    saveProperty,
    saveStatus,
    createProject: vi.fn().mockResolvedValue(undefined),
    openProject,
    ...overrides,
  });
  view.mount(projects);
  return { host, view, config, saveSettings, saveProperty, saveStatus, openProject };
}

describe('ProjectsTableView', () => {
  it('renders one sticky header in default column order and sorts empty end values last', () => {
    const { host } = mount([
      project({ path: 'Projects/Z.md', name: 'Zulu', frontmatter: {} }),
      project({ path: 'Projects/B.md', name: 'Beta', frontmatter: { end: '2026-09-20' } }),
      project({ path: 'Projects/A.md', name: 'Alpha', frontmatter: { end: '2026-09-10' } }),
    ]);

    expect(host.querySelectorAll('thead')).toHaveLength(1);
    expect(
      Array.from(
        host.querySelectorAll<HTMLButtonElement>('.abyss-project-table-column-button'),
      ).map((button) => button.textContent.trim()),
    ).toEqual(['Name', 'Status', 'Progress', 'Start', 'End']);
    expect(
      Array.from(host.querySelectorAll<HTMLElement>('.abyss-project-table-row')).map(
        (row) => row.dataset['projectPath'],
      ),
    ).toEqual(['Projects/A.md', 'Projects/B.md', 'Projects/Z.md']);
  });

  it('keeps available status badges visible while toggling their persisted filters', async () => {
    const { host, config, saveSettings } = mount([
      project({}),
      project({ path: 'Projects/U.md', name: 'Unknown', statusId: null, rawStatus: 'waiting' }),
      project({ path: 'Projects/N.md', name: 'None', statusId: null, rawStatus: null }),
    ]);
    const button = expectDefined(
      host.querySelector<HTMLButtonElement>(
        `.abyss-project-status-filter[data-status-key="id:${active.id}"]`,
      ),
    );

    button.click();
    await flushMicrotasks();

    expect(config.projects.table.hiddenStatuses).toContain(`id:${active.id}`);
    expect(saveSettings).toHaveBeenCalledOnce();
    expect(host.querySelector('[data-status-key="raw:waiting"]')).not.toBeNull();
    expect(host.querySelector('[data-status-key="none"]')).not.toBeNull();
    expect(host.querySelectorAll('[data-project-path="Projects/A.md"]')).toHaveLength(0);
    expect(button.isConnected).toBe(false);
    expect(
      host.querySelector(`[data-status-key="id:${active.id}"]`)?.classList.contains('is-disabled'),
    ).toBe(true);
  });

  it('uses aliases in headers and clicks select then reverse the sort field', async () => {
    const config = settings();
    const endColumn = expectDefined(config.projects.table.columns.find(({ id }) => id === 'end'));
    endColumn.label = 'Deadline';
    const { host, saveSettings } = mount([project({})], { settings: config });
    const header = expectDefined(
      host.querySelector<HTMLButtonElement>(
        '[data-column-id="end"] .abyss-project-table-column-button',
      ),
    );

    expect(header.textContent).toContain('Deadline');
    header.click();
    await flushMicrotasks();
    expect(config.projects.table.sortBy).toEqual({ field: 'end', dir: 'desc' });
    header.click();
    await flushMicrotasks();
    expect(config.projects.table.sortBy).toEqual({ field: 'end', dir: 'asc' });
    expect(saveSettings).toHaveBeenCalledTimes(2);
  });

  it('commits a focused header rename once when Enter also causes blur', async () => {
    let rename: (() => void) | undefined;
    vi.spyOn(Menu.prototype, 'addItem').mockImplementation(function (this: Menu, callback) {
      const item = {
        setTitle: () => item,
        setIcon: () => item,
        onClick: (handler: () => void) => {
          rename = handler;
          return item;
        },
      };
      callback(item as never);
      return this;
    });
    const { host, config, saveSettings } = mount([project({})]);
    const header = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-header-cell[data-column-id="end"]'),
    );
    header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expectDefined(rename)();
    const input = expectDefined(
      header.querySelector<HTMLInputElement>('.abyss-project-column-rename'),
    );
    input.value = 'Deadline';

    expect(() => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
    }).not.toThrow();
    await flushMicrotasks();

    expect(config.projects.table.columns.find(({ id }) => id === 'end')?.label).toBe('Deadline');
    expect(saveSettings).toHaveBeenCalledOnce();
  });

  it('keeps sorting separate from column drag and resize gestures', async () => {
    const { host, config, saveSettings } = mount([project({})]);
    const renderedWidths: Record<string, number> = {
      name: 400,
      status: 250,
      progress: 300,
      start: 250,
      end: 250,
    };
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const columnId = this.dataset['columnId'];
      const width = columnId === undefined ? 0 : (renderedWidths[columnId] ?? 0);
      return { width } as DOMRect;
    });
    const startHeader = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-header-cell[data-column-id="start"]'),
    );
    const startButton = expectDefined(
      startHeader.querySelector<HTMLButtonElement>('.abyss-project-table-column-button'),
    );
    startHeader.dispatchEvent(new Event('dragstart', { bubbles: true }));
    startButton.click();
    expect(config.projects.table.sortBy).toEqual({ field: 'end', dir: 'asc' });

    const resize = expectDefined(
      startHeader.querySelector<HTMLElement>('.abyss-project-column-resize'),
    );
    resize.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 100 }));
    startHeader.ownerDocument.dispatchEvent(new PointerEvent('pointermove', { clientX: 140 }));
    startHeader.ownerDocument.dispatchEvent(new PointerEvent('pointerup', { clientX: 140 }));
    await flushMicrotasks();

    expect(config.projects.table.columns.map(({ id, width }) => [id, width])).toEqual([
      ['name', 400],
      ['status', 250],
      ['progress', 300],
      ['start', 290],
      ['end', 250],
    ]);
    expect(host.querySelector<HTMLTableElement>('.abyss-project-table')?.style.width).toBe(
      '1490px',
    );

    renderedWidths['start'] = 290;
    const resizedStart = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-header-cell[data-column-id="start"]'),
    );
    expectDefined(
      resizedStart.querySelector<HTMLElement>('.abyss-project-column-resize'),
    ).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 140 }));
    resizedStart.ownerDocument.dispatchEvent(new PointerEvent('pointermove', { clientX: 100 }));
    resizedStart.ownerDocument.dispatchEvent(new PointerEvent('pointerup', { clientX: 100 }));
    await flushMicrotasks();

    expect(config.projects.table.columns.find(({ id }) => id === 'start')?.width).toBe(250);
    expect(host.querySelector<HTMLTableElement>('.abyss-project-table')?.style.width).toBe(
      '1450px',
    );
    expect(config.projects.table.sortBy).toEqual({ field: 'end', dir: 'asc' });
    expect(saveSettings).toHaveBeenCalledTimes(2);
  });

  it('shows invalid external date ranges for correction without rewriting them', () => {
    const { host, saveProperty } = mount([
      project({ frontmatter: { start: '2026-10-10', end: '2026-09-01' } }),
    ]);

    expect(host.querySelectorAll('.abyss-project-table-cell.is-invalid-range')).toHaveLength(2);
    expect(host.querySelector('.abyss-project-table-range-warning')?.textContent).toBe('!');
    expect(saveProperty).not.toHaveBeenCalled();
  });

  it('reset restores grouping, sorting, and filters while preserving configured columns', async () => {
    const config = settings();
    config.projects.table.columns.push({
      id: 'property:creator',
      visible: true,
      label: 'Owner',
      width: 230,
    });
    config.projects.table.groupBy = 'property:creator';
    config.projects.table.sortBy = { field: 'name', dir: 'desc' };
    config.projects.table.hiddenStatuses = [`id:${active.id}`];
    const before = structuredClone(config.projects.table.columns);
    const { host } = mount([project({ frontmatter: { creator: 'Ada' } })], {
      settings: config,
      catalog: catalog([{ name: 'creator', type: 'text' }]),
    });

    expectDefined(host.querySelector<HTMLButtonElement>('.abyss-view-state-btn')).click();
    expect(
      Array.from(host.querySelectorAll('.abyss-view-state-option-label')).map(
        (element) => element.textContent,
      ),
    ).toContain('Owner');
    expectDefined(host.querySelector<HTMLButtonElement>('.abyss-view-state-reset-btn')).click();
    await flushMicrotasks();

    expect(config.projects.table.columns).toEqual(before);
    expect(config.projects.table.groupBy).toBe('status');
    expect(config.projects.table.sortBy).toEqual({ field: 'end', dir: 'asc' });
    expect(config.projects.table.hiddenStatuses).toEqual([]);
    expect(host.querySelector('.abyss-view-state-reset-btn')).toBeNull();
  });

  it('repeats a project in each distinct list-value group while reporting one unique project', () => {
    const config = settings();
    config.projects.table.columns.push({ id: 'property:creator', visible: true });
    config.projects.table.groupBy = 'property:creator';
    const { host } = mount([project({ frontmatter: { creator: ['Ada', 'Grace', 'Ada'] } })], {
      settings: config,
      catalog: catalog([{ name: 'creator', type: 'list' }]),
    });

    expect(host.querySelector('.abyss-project-table-count')?.textContent).toBe('1 project');
    expect(host.querySelectorAll('.abyss-project-table-group-row')).toHaveLength(2);
    expect(host.querySelectorAll('.abyss-project-table-row')).toHaveLength(2);
  });

  it('keeps collapsed group keys stable across project refreshes', () => {
    const item = project({});
    const { host, view } = mount([item]);
    expectDefined(
      host.querySelector<HTMLButtonElement>('.abyss-project-table-group-toggle'),
    ).click();
    expect(host.querySelectorAll('.abyss-project-table-row')).toHaveLength(0);

    view.update([{ ...item, stats: { ...item.stats, done: 7 } }]);

    expect(host.querySelectorAll('.abyss-project-table-row')).toHaveLength(0);
    expect(
      host.querySelector('.abyss-project-table-group-toggle')?.getAttribute('aria-expanded'),
    ).toBe('false');
  });

  it('creates a project from the inline footer control', async () => {
    const createProject = vi.fn().mockResolvedValue(undefined);
    const { host } = mount([project({})], { createProject });
    expectDefined(host.querySelector<HTMLButtonElement>('.abyss-projects-new')).click();
    const input = expectDefined(host.querySelector<HTMLInputElement>('.abyss-projects-new-input'));
    input.value = 'Fresh project';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushMicrotasks();

    expect(createProject).toHaveBeenCalledWith('Fresh project');
    expect(host.querySelector('.abyss-projects-new-input')).toBeNull();
  });

  it('opens a typed editor, saves with the captured value, and rerenders after commit', async () => {
    const item = project({ frontmatter: { end: '2026-09-30' } });
    const saveProperty = vi.fn(async (_path: string, _field: ProjectFieldCatalogItem, value) => {
      item.frontmatter['end'] = value;
    });
    const { host, view } = mount([item], { saveProperty });
    const cell = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="end"]'),
    );
    cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const input = expectDefined(cell.querySelector<HTMLInputElement>('input[type="date"]'));
    input.value = '2026-10-10';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushMicrotasks();

    expect(saveProperty).toHaveBeenCalledWith(
      'Projects/A.md',
      expect.anything(),
      '2026-10-10',
      '2026-09-30',
    );
    expect(host.querySelector('.abyss-project-cell-editor')).toBeNull();
    expect(
      host.querySelector('.abyss-project-table-cell[data-column-id="end"]')?.textContent,
    ).toContain('2026-10-10');
    view.destroy();
  });

  it('Escape cancels editing without saving', () => {
    const { host, saveProperty } = mount([project({})]);
    const cell = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="start"]'),
    );
    cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expectDefined(cell.querySelector('input')).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    expect(saveProperty).not.toHaveBeenCalled();
    expect(host.querySelector('.abyss-project-cell-editor')).toBeNull();
  });

  it('opens the next cell after cancelling with the editor button', () => {
    const { host } = mount([project({})]);
    expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="start"]'),
    ).click();
    expectDefined(host.querySelector<HTMLButtonElement>('.abyss-project-editor-cancel')).click();

    expect(host.querySelector('.abyss-project-cell-editor')).toBeNull();
    expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="end"]'),
    ).click();
    expect(
      host.querySelector(
        '.abyss-project-table-cell[data-column-id="end"] .abyss-project-cell-editor',
      ),
    ).not.toBeNull();
  });

  it('preserves search, scroll, focused editor and draft across repeated data refreshes', () => {
    const a = project({});
    const { host, view } = mount([a, project({ path: 'Projects/B.md', name: 'Beta' })]);
    const search = expectDefined(host.querySelector<HTMLInputElement>('.abyss-center-search'));
    search.value = 'a';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    const scroll = expectDefined(host.querySelector<HTMLElement>('.abyss-project-table-scroll'));
    scroll.scrollTop = 47;
    const cell = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="end"]'),
    );
    cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const draft = expectDefined(cell.querySelector<HTMLInputElement>('input[type="date"]'));
    draft.value = '2026-12-24';
    draft.focus();

    view.update([a, project({ path: 'Projects/C.md', name: 'Charlie' })]);
    view.update([a]);

    expect(search.value).toBe('a');
    expect(scroll.scrollTop).toBe(47);
    expect(draft.value).toBe('2026-12-24');
    expect(activeDocument.activeElement).toBe(draft);
  });

  it('Tab commits and moves focus to the next table cell', async () => {
    const { host } = mount([project({})]);
    const cell = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="start"]'),
    );
    cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const input = expectDefined(cell.querySelector<HTMLInputElement>('input[type="date"]'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    await flushMicrotasks();

    expect((activeDocument.activeElement as HTMLElement | null)?.dataset['columnId']).toBe('end');
  });
});
