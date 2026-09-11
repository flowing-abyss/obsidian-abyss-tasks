import { App } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { ProjectsTableView } from '../src/panels/projects/ProjectsTableView';
import type { ProjectPropertyCatalog } from '../src/projects/ObsidianProjectProperties';
import { ProjectEditHistory } from '../src/projects/projectEditHistory';
import type {
  AppliedProjectCellChange,
  ProjectCellChange,
  ProjectEditResult,
} from '../src/projects/projectEdits';
import { buildDefaultProjectKanbanSettings } from '../src/projects/projectKanbanSettings';
import type { Project } from '../src/projects/types';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { expectDefined, flushMicrotasks, freshContainer } from './helpers';

const mounted = new Set<ProjectsTableView>();

afterEach(() => {
  for (const view of mounted) view.destroy();
  mounted.clear();
  activeDocument.body.empty();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function project(over: Partial<Project> = {}): Project {
  const status = expectDefined(DEFAULT_SETTINGS.projects.statuses[0]);
  return {
    path: 'Projects/A.md',
    name: 'A planning project',
    frontmatter: {
      start: '2026-09-01',
      end: '2026-09-30',
      description: 'A concise project description',
      Budget: 42,
    },
    tags: [],
    statusId: status.id,
    rawStatus: null,
    stats: { total: 10, done: 6, cancelled: 0, inProgress: 0 },
    ...over,
  };
}

function catalog(): ProjectPropertyCatalog {
  const properties = [
    { name: 'start', type: 'date' as const },
    { name: 'end', type: 'date' as const },
    { name: 'description', type: 'text' as const },
    { name: 'Budget', type: 'number' as const },
    { name: 'Flag', type: 'checkbox' as const },
  ];
  return {
    list: () => properties,
    inspect: (property) => ({
      kind: 'available',
      property: properties.find(({ name }) => name === property),
      assignment: { kind: 'none' },
    }),
    values: () => [],
    onChange: () => () => {},
  };
}

function mountView(
  projects: readonly Project[] = [project()],
  overrides: Partial<ConstructorParameters<typeof ProjectsTableView>[1]> = {},
) {
  const host = freshContainer();
  activeDocument.body.append(host);
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.projects.propertyDefinitions['property:Budget'] = { type: 'number' };
  settings.projects.propertyDefinitions['property:Flag'] = { type: 'checkbox' };
  const successful = (changes: readonly ProjectCellChange[]): ProjectEditResult => ({
    applied: changes.map((change): AppliedProjectCellChange => ({
      ...change,
      sourceProperty: change.field.property ?? settings.projects.statusProperty,
      sourceKey: change.sourceKey ?? change.field.property ?? settings.projects.statusProperty,
      previousValue: change.expectedValue,
      previousExists: change.expectedExists ?? change.expectedValue !== undefined,
      appliedExists: change.value !== undefined && change.value !== '',
    })),
    failed: [],
  });
  const applyEdits = vi.fn(async (changes: readonly ProjectCellChange[]) => successful(changes));
  const view = new ProjectsTableView(host, {
    app: new App(),
    state: new AppState(),
    settings,
    catalog: catalog(),
    saveViewState: vi.fn().mockResolvedValue(undefined),
    applyEdits,
    history: new ProjectEditHistory(applyEdits),
    createProject: vi.fn().mockResolvedValue(undefined),
    openProject: vi.fn(),
    revalidateSourceObservation: vi.fn().mockResolvedValue(false),
    ...overrides,
  });
  mounted.add(view);
  view.mount(projects);
  return { host, view, settings, applyEdits };
}

function clickView(host: HTMLElement, mode: 'Table' | 'Kanban'): void {
  expectDefined(host.querySelector<HTMLButtonElement>(`[aria-label="${mode} view"]`)).click();
}

function rectangle(left: number, top: number, right: number, bottom: number): DOMRect {
  return { left, top, right, bottom, width: right - left, height: bottom - top } as DOMRect;
}

function chooseViewOption(host: HTMLElement, rowLabel: string, optionLabel: string): void {
  expectDefined(host.querySelector<HTMLButtonElement>('.abyss-view-state-btn')).click();
  const row = expectDefined(
    Array.from(host.querySelectorAll<HTMLElement>('.abyss-view-state-row')).find(
      (candidate) =>
        candidate.querySelector('.abyss-view-state-row-label')?.textContent === rowLabel,
    ),
  );
  expectDefined(row.querySelector<HTMLButtonElement>('.abyss-view-state-row-main')).click();
  expectDefined(
    Array.from(row.querySelectorAll<HTMLButtonElement>('.abyss-view-state-option')).find(
      (button) =>
        button.querySelector('.abyss-view-state-option-label')?.textContent === optionLabel,
    ),
  ).click();
}

describe('project Kanban overview', () => {
  it('switches after Sort & group, retains the table node, and keeps independent searches', () => {
    const { host } = mountView();
    const controls = expectDefined(host.querySelector('.abyss-project-table-controls'));
    expect(Array.from(controls.children).map((child) => child.getAttribute('aria-label'))).toEqual([
      'Sort & group options',
      'Table view',
      'Kanban view',
      'Filter projects',
    ]);
    const tableNode = host.querySelector('table');
    const search = expectDefined(host.querySelector<HTMLInputElement>('.abyss-center-search'));
    search.value = 'table query';
    search.dispatchEvent(new Event('input', { bubbles: true }));

    clickView(host, 'Kanban');
    expect(search.value).toBe('');
    expect(host.querySelector('.abyss-project-kanban')).not.toBeNull();
    expect(host.querySelector('.abyss-project-table-scroll')?.hasAttribute('hidden')).toBe(true);

    search.value = 'kanban query';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    clickView(host, 'Table');
    expect(search.value).toBe('table query');
    expect(host.querySelector('table')).toBe(tableNode);
    clickView(host, 'Kanban');
    expect(search.value).toBe('kanban query');
  });

  it('initializes independent Kanban filters and omits empty synthetic columns', () => {
    const { host, settings } = mountView();
    const configuredStatus = expectDefined(settings.projects.statuses[0]);
    expectDefined(
      host.querySelector<HTMLButtonElement>(
        `.abyss-project-status-filter[data-status-key="id:${configuredStatus.id}"]`,
      ),
    ).click();
    expect(settings.projects.table.hiddenStatuses).toContain(`id:${configuredStatus.id}`);

    clickView(host, 'Kanban');
    const kanban = expectDefined(settings.projects.kanban);
    expect(kanban).not.toBe(settings.projects.table);
    expect(kanban.hiddenStatuses).toEqual(settings.projects.table.hiddenStatuses);
    const columnKeys = Array.from(
      host.querySelectorAll<HTMLElement>('.abyss-project-kanban-column'),
      (column) => column.dataset['statusKey'],
    );
    expect(columnKeys).not.toContain('none');
    expect(columnKeys.some((key) => key?.startsWith('raw:') === true)).toBe(false);

    const other = expectDefined(settings.projects.statuses[1]);
    expectDefined(
      host.querySelector<HTMLButtonElement>(
        `.abyss-project-status-filter[data-status-key="id:${other.id}"]`,
      ),
    ).click();
    expect(kanban.hiddenStatuses).toContain(`id:${other.id}`);
    expect(settings.projects.table.hiddenStatuses).not.toContain(`id:${other.id}`);
  });

  it('updates board grouping and sorting without changing table preferences', () => {
    const { host, settings } = mountView();
    const tableGroup = settings.projects.table.groupBy;
    const tableSort = { ...settings.projects.table.sortBy };
    clickView(host, 'Kanban');

    chooseViewOption(host, 'Group by', 'Budget');
    chooseViewOption(host, 'Sort by', 'End');

    const kanban = expectDefined(settings.projects.kanban);
    expect(kanban.groupBy).toBe('property:Budget');
    expect(kanban.sortBy).toEqual({ field: 'end', dir: 'asc' });
    expect(settings.projects.table.groupBy).toBe(tableGroup);
    expect(settings.projects.table.sortBy).toEqual(tableSort);
  });

  it('renders ordered compact card fields with shared progress and edits through the session', async () => {
    const { host, view, settings, applyEdits } = mountView();
    settings.projects.kanban = buildDefaultProjectKanbanSettings(settings.projects.table);
    settings.projects.kanban.fields = [
      { id: 'property:Budget', visible: true },
      { id: 'start', visible: true },
    ];
    settings.projects.overviewView = 'kanban';
    view.refreshFields();

    const card = expectDefined(host.querySelector<HTMLElement>('.abyss-project-kanban-card'));
    expect(card.querySelector('.abyss-project-kanban-title')?.textContent).toContain(
      'A planning project',
    );
    expect(card.querySelector('.abyss-project-kanban-description')?.textContent).toContain(
      'A concise project description',
    );
    expect(
      Array.from(card.querySelectorAll('.abyss-project-kanban-field-label'), (label) =>
        label.textContent.trim(),
      ),
    ).toEqual(['Budget', 'Start']);
    expect(card.querySelector('.abyss-project-progress-segments')).not.toBeNull();

    const budget = expectDefined(
      card.querySelector<HTMLElement>('[data-column-id="property:Budget"]'),
    );
    budget.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const input = expectDefined(budget.querySelector<HTMLInputElement>('input[type="number"]'));
    input.value = '84';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushMicrotasks();

    expect(applyEdits).toHaveBeenCalledOnce();
    expect(expectDefined(applyEdits.mock.calls[0])[0][0]).toMatchObject({
      path: 'Projects/A.md',
      value: 84,
      expectedValue: 42,
    });
    expect(budget.textContent).toContain('84');
  });

  it('positions a bottom-right card editor within the board viewport and sticky header', () => {
    const { host } = mountView();
    clickView(host, 'Kanban');
    const board = expectDefined(host.querySelector<HTMLElement>('.abyss-project-kanban-scroll'));
    const header = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-kanban-column-header'),
    );
    const start = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-kanban [data-column-id="start"]'),
    );
    Object.defineProperties(board, {
      clientHeight: { configurable: true, value: 200 },
      clientWidth: { configurable: true, value: 300 },
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this === board) return rectangle(40, 100, 340, 300);
      if (this === header) return rectangle(40, 100, 312, 140);
      if (this === start) return rectangle(280, 260, 440, 294);
      if (this.classList.contains('abyss-project-cell-editor-host')) {
        return rectangle(0, 0, Number.parseFloat(this.style.width), 34);
      }
      return rectangle(0, 0, 0, 0);
    });

    start.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

    const editor = expectDefined(
      start.querySelector<HTMLElement>('.abyss-project-cell-editor-host'),
    );
    const positionedLeft = 280 + Number.parseFloat(editor.style.left);
    const positionedTop = 260 + Number.parseFloat(editor.style.top);
    expect(positionedLeft).toBeGreaterThanOrEqual(48);
    expect(positionedLeft + Number.parseFloat(editor.style.width)).toBeLessThanOrEqual(332);
    expect(positionedTop).toBeGreaterThanOrEqual(148);
    expect(positionedTop + 34).toBeLessThanOrEqual(292);
  });

  it('uses a selected card as the capture project and restores the table selection separately', () => {
    const { host, view } = mountView([
      project(),
      project({ path: 'Projects/B.md', name: 'B project' }),
    ]);
    const tableCell = expectDefined(
      host.querySelector<HTMLElement>(
        '.abyss-project-table-row[data-project-path="Projects/A.md"] .abyss-project-table-cell',
      ),
    );
    tableCell.click();
    expect(view.selectedProjectPath()).toBe('Projects/A.md');

    clickView(host, 'Kanban');
    const card = expectDefined(
      Array.from(host.querySelectorAll<HTMLElement>('.abyss-project-kanban-card')).find(
        (candidate) => candidate.dataset['projectPath'] === 'Projects/B.md',
      ),
    );
    card.click();
    expect(view.selectedProjectPath()).toBe('Projects/B.md');

    clickView(host, 'Table');
    expect(view.selectedProjectPath()).toBe('Projects/A.md');
  });

  it('moves a focused card between status columns without replacing its DOM node', () => {
    const initial = project();
    const { host, view, settings } = mountView([initial]);
    clickView(host, 'Kanban');
    const card = expectDefined(host.querySelector<HTMLElement>('.abyss-project-kanban-card'));
    card.focus();
    const focusedCell = activeDocument.activeElement;
    expect(card.contains(focusedCell)).toBe(true);
    const destination = expectDefined(settings.projects.statuses[1]);

    view.update([{ ...initial, statusId: destination.id }]);

    const moved = expectDefined(
      host.querySelector<HTMLElement>(
        `.abyss-project-kanban-column[data-status-key="id:${destination.id}"] .abyss-project-kanban-card`,
      ),
    );
    expect(moved).toBe(card);
    expect(activeDocument.activeElement).toBe(focusedCell);
  });

  it('keeps a rejected table editor and blocks a requested view switch', async () => {
    const rejected: ProjectEditResult = {
      applied: [],
      failed: [{ path: 'Projects/A.md', message: 'Source changed' }],
    };
    const applyEdits = vi.fn().mockResolvedValue(rejected);
    const { host, settings } = mountView(undefined, {
      applyEdits,
      history: new ProjectEditHistory(applyEdits),
    });
    const end = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="end"]'),
    );
    end.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const input = expectDefined(end.querySelector<HTMLInputElement>('input[type="date"]'));
    input.value = '2026-10-02';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    clickView(host, 'Kanban');
    await flushMicrotasks();

    expect(settings.projects.overviewView).not.toBe('kanban');
    expect(host.querySelector('.abyss-project-kanban')).toBeNull();
    expect(end.contains(input)).toBe(true);
    expect(input.value).toBe('2026-10-02');
  });

  it('keeps board receipts in the shared projection across a view switch and Undo', async () => {
    const { host, settings, applyEdits } = mountView();
    settings.projects.table.columns.push({ id: 'property:Budget', visible: true });
    settings.projects.kanban = buildDefaultProjectKanbanSettings(settings.projects.table);
    settings.projects.kanban.fields = [{ id: 'property:Budget', visible: true }];
    clickView(host, 'Kanban');
    const budget = expectDefined(
      host.querySelector<HTMLElement>('[data-column-id="property:Budget"]'),
    );
    budget.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const input = expectDefined(budget.querySelector<HTMLInputElement>('input[type="number"]'));
    input.value = '84';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushMicrotasks();

    clickView(host, 'Table');
    const tableBudget = expectDefined(
      host.querySelector<HTMLElement>(
        '.abyss-project-table-cell[data-column-id="property:Budget"]',
      ),
    );
    expect(tableBudget.textContent).toContain('84');
    tableBudget.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }),
    );
    await flushMicrotasks();

    expect(applyEdits).toHaveBeenCalledTimes(2);
    expect(expectDefined(applyEdits.mock.calls[1])[0][0]).toMatchObject({
      path: 'Projects/A.md',
      value: 42,
      expectedValue: 84,
    });
    clickView(host, 'Kanban');
    expect(
      host.querySelector('.abyss-project-kanban [data-column-id="property:Budget"]')?.textContent,
    ).toContain('42');
  });

  it('keeps false and zero card values visible and exposes explicit field reordering', () => {
    const { host, settings } = mountView([project({ frontmatter: { Budget: 0, Flag: false } })]);
    settings.projects.kanban = buildDefaultProjectKanbanSettings(settings.projects.table);
    settings.projects.kanban.fields = [
      { id: 'property:Budget', visible: true },
      { id: 'property:Flag', visible: true },
    ];
    clickView(host, 'Kanban');

    expect(
      Array.from(host.querySelectorAll('.abyss-project-kanban-field-label'), ({ textContent }) =>
        textContent.trim(),
      ),
    ).toEqual(['Budget', 'Flag']);
    expect(
      host.querySelector('.abyss-project-kanban [data-column-id="property:Budget"]')?.textContent,
    ).toContain('0');
    expect(
      host.querySelector<HTMLInputElement>(
        '.abyss-project-kanban [data-column-id="property:Flag"] input[type="checkbox"]',
      )?.checked,
    ).toBe(false);

    expectDefined(host.querySelector<HTMLButtonElement>('.abyss-view-state-btn')).click();
    const fieldsRow = expectDefined(
      Array.from(host.querySelectorAll<HTMLElement>('.abyss-view-state-row')).find(
        (row) => row.querySelector('.abyss-view-state-row-label')?.textContent === 'Card fields',
      ),
    );
    expectDefined(fieldsRow.querySelector<HTMLButtonElement>('.abyss-view-state-row-main')).click();
    expectDefined(
      fieldsRow.querySelector<HTMLButtonElement>('[aria-label="Move Flag up"]'),
    ).click();

    expect(settings.projects.kanban.fields.map(({ id }) => id)).toEqual([
      'property:Flag',
      'property:Budget',
    ]);
    expect(
      Array.from(host.querySelectorAll('.abyss-project-kanban-field-label'), ({ textContent }) =>
        textContent.trim(),
      ),
    ).toEqual(['Flag', 'Budget']);
  });

  it('treats an all-cancelled project as empty progress until empty progress is enabled', () => {
    const cancelled = project({
      stats: { total: 4, done: 0, cancelled: 4, inProgress: 0 },
    });
    const { host, view, settings } = mountView([cancelled]);
    settings.projects.kanban = buildDefaultProjectKanbanSettings(settings.projects.table);
    settings.projects.kanban.showEmptyProgress = false;
    clickView(host, 'Kanban');
    const progress = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-kanban-progress'),
    );
    expect(progress.hidden).toBe(true);

    settings.projects.kanban.showEmptyProgress = true;
    view.refreshFields();

    expect(progress.hidden).toBe(false);
  });

  it('detaches table aliases and relative dates when initializing board fields', () => {
    const { host, settings } = mountView();
    const start = expectDefined(settings.projects.table.columns.find(({ id }) => id === 'start'));
    start.label = 'Begins';
    start.dateDisplay = 'relative';
    settings.projects.table.columns.push({
      id: 'property:Budget',
      label: 'Cost',
      visible: false,
    });
    settings.projects.table.groupBy = 'property:Budget';

    clickView(host, 'Kanban');
    const kanban = expectDefined(settings.projects.kanban);
    expect(kanban.fields[0]).toMatchObject({
      id: 'start',
      label: 'Begins',
      dateDisplay: 'relative',
    });
    expect(kanban.fields[0]).not.toBe(start);
    expect(
      Array.from(host.querySelectorAll('.abyss-project-kanban-field-label'), ({ textContent }) =>
        textContent.trim(),
      ),
    ).toContain('Begins');
    expect(
      host.querySelector(
        '.abyss-project-kanban [data-column-id="start"] .abyss-project-relative-date',
      ),
    ).not.toBeNull();

    expectDefined(host.querySelector<HTMLButtonElement>('.abyss-view-state-btn')).click();
    const groupRow = expectDefined(
      Array.from(host.querySelectorAll<HTMLElement>('.abyss-view-state-row')).find(
        (row) => row.querySelector('.abyss-view-state-row-label')?.textContent === 'Group by',
      ),
    );
    expect(groupRow.querySelector('.abyss-view-state-row-value')?.textContent).toBe('Cost');
    const fieldsRow = expectDefined(
      Array.from(host.querySelectorAll<HTMLElement>('.abyss-view-state-row')).find(
        (row) => row.querySelector('.abyss-view-state-row-label')?.textContent === 'Card fields',
      ),
    );
    expectDefined(fieldsRow.querySelector<HTMLButtonElement>('.abyss-view-state-row-main')).click();
    const cost = expectDefined(
      Array.from(fieldsRow.querySelectorAll<HTMLButtonElement>('.abyss-view-state-option')).find(
        (button) => button.textContent.includes('Cost'),
      ),
    );
    cost.click();
    expect(expectDefined(kanban.fields.find(({ id }) => id === 'property:Budget')).label).toBe(
      'Cost',
    );
  });
});
