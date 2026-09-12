import { App, MarkdownRenderer, Menu, Notice } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { isProjectKanbanCustomized } from '../src/panels/projects/ProjectKanbanOptions';
import { ProjectsTableView } from '../src/panels/projects/ProjectsTableView';
import type { ProjectPropertyCatalog } from '../src/projects/ObsidianProjectProperties';
import { ProjectEditHistory } from '../src/projects/projectEditHistory';
import type {
  AppliedProjectCellChange,
  ProjectCellChange,
  ProjectEditResult,
} from '../src/projects/projectEdits';
import {
  buildDefaultProjectKanbanSettings,
  normalizeProjectKanbanSettings,
} from '../src/projects/projectKanbanSettings';
import type { Project } from '../src/projects/types';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { expectDefined, flushMicrotasks, freshContainer } from './helpers';

interface TestTransfer {
  readonly types: string[];
  setData(type: string, value: string): void;
  getData(type: string): string;
  dropEffect: string;
  effectAllowed: string;
  setDragImage?(image: Element, x: number, y: number): void;
}

function transfer(): TestTransfer {
  const values = new Map<string, string>();
  return {
    get types() {
      return [...values.keys()];
    },
    setData: (type, value) => values.set(type, value),
    getData: (type) => values.get(type) ?? '',
    dropEffect: 'none',
    effectAllowed: 'uninitialized',
    setDragImage: vi.fn(),
  };
}

function dragEvent(
  type: string,
  data: TestTransfer,
  point: { readonly clientX: number; readonly clientY: number } = { clientX: 0, clientY: 0 },
): Event {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...point });
  Object.defineProperty(event, 'dataTransfer', { value: data });
  return event;
}

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

function catalog(
  extra: ReadonlyArray<{
    name: string;
    type: 'text' | 'list' | 'number' | 'checkbox' | 'date';
  }> = [],
): ProjectPropertyCatalog {
  const properties = [
    { name: 'start', type: 'date' as const },
    { name: 'end', type: 'date' as const },
    { name: 'description', type: 'text' as const },
    { name: 'Budget', type: 'number' as const },
    { name: 'Flag', type: 'checkbox' as const },
    ...extra,
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

function prettyDateTextNode(cell: HTMLElement): Text {
  const text = cell.querySelector('.abyss-project-pretty-date')?.firstChild;
  expect(text?.nodeType).toBe(Node.TEXT_NODE);
  return text as Text;
}

function chooseViewOption(host: HTMLElement, rowLabel: string, optionLabel: string): void {
  if (host.querySelector('.abyss-view-state-popover') === null) {
    expectDefined(host.querySelector<HTMLButtonElement>('.abyss-view-state-btn')).click();
  }
  const row = expectDefined(
    Array.from(host.querySelectorAll<HTMLElement>('.abyss-view-state-row')).find(
      (candidate) =>
        candidate.querySelector('.abyss-view-state-row-label')?.textContent === rowLabel,
    ),
  );
  const parentSublist = row.parentElement;
  if (parentSublist?.classList.contains('abyss-view-state-sublist') === true) {
    const parentRow = expectDefined(parentSublist.parentElement);
    expectDefined(
      parentRow.querySelector<HTMLButtonElement>(':scope > .abyss-view-state-row-main'),
    ).click();
  }
  expectDefined(row.querySelector<HTMLButtonElement>('.abyss-view-state-row-main')).click();
  expectDefined(
    Array.from(row.querySelectorAll<HTMLButtonElement>('.abyss-view-state-option')).find(
      (button) =>
        button.querySelector('.abyss-view-state-option-label')?.textContent === optionLabel,
    ),
  ).click();
}

interface TestMenuItem {
  readonly title__: string;
  readonly checked: boolean | null;
  readonly onClick__: ((event: MouseEvent | KeyboardEvent) => void) | null;
}

interface MenuShowSpy {
  readonly mock: { readonly instances: readonly unknown[] };
}

function menuItems(menu: Menu): readonly TestMenuItem[] {
  return (menu as unknown as { readonly menuItems__: readonly TestMenuItem[] }).menuItems__;
}

function menuDom(menu: Menu): HTMLElement {
  return (menu as unknown as { readonly dom: HTMLElement }).dom;
}

function renderShownMenuInDocument(): MenuShowSpy {
  const spy = vi.spyOn(Menu.prototype, 'showAtMouseEvent').mockImplementation(function (
    this: Menu,
  ) {
    const dom = menuDom(this);
    dom.empty();
    dom.addClass('menu');
    for (const item of menuItems(this)) {
      const button = dom.createEl('button', { cls: 'menu-item', text: item.title__ });
      button.addEventListener('click', (event) => {
        item.onClick__?.(event);
        this.close();
        dom.remove();
      });
    }
    activeDocument.body.append(dom);
    return this;
  });
  return spy;
}

function clickRenderedMenuItem(menu: Menu, title: string): void {
  expectDefined(
    Array.from(menuDom(menu).querySelectorAll<HTMLButtonElement>('.menu-item')).find(
      ({ textContent }) => textContent === title,
    ),
  ).click();
}

function lastShownMenu(spy: MenuShowSpy): Menu {
  return expectDefined(spy.mock.instances[spy.mock.instances.length - 1]) as Menu;
}

function directViewOptionRows(host: HTMLElement): HTMLElement[] {
  const popover = expectDefined(host.querySelector<HTMLElement>('.abyss-view-state-popover'));
  return Array.from(popover.children).filter(
    (child): child is HTMLElement =>
      child.instanceOf(HTMLElement) && child.classList.contains('abyss-view-state-row'),
  );
}

function optionRow(row: HTMLElement, label: string): HTMLElement {
  return expectDefined(
    Array.from(row.querySelectorAll<HTMLElement>('.abyss-view-state-option-row')).find(
      (candidate) =>
        candidate.querySelector('.abyss-view-state-option-label')?.textContent === label,
    ),
  );
}

function viewOptionRow(host: HTMLElement, label: string): HTMLElement {
  return expectDefined(
    Array.from(host.querySelectorAll<HTMLElement>('.abyss-view-state-row')).find(
      (row) => row.querySelector('.abyss-view-state-row-label')?.textContent === label,
    ),
  );
}

describe('project Kanban overview', () => {
  it('compares Kanban preferences while ignoring populated manual ranks', () => {
    const table = structuredClone(DEFAULT_SETTINGS.projects.table);
    const defaults = buildDefaultProjectKanbanSettings(table);
    const ranked = {
      ...defaults,
      manualOrder: { 'id:planned': ['Projects/B.md', 'Projects/A.md'] },
    };

    expect(isProjectKanbanCustomized(ranked, table)).toBe(false);
    expect(isProjectKanbanCustomized({ ...ranked, descriptionLines: 2 }, table)).toBe(true);
  });

  it('keeps three root rows and closes nested siblings without closing their parent', () => {
    const { host } = mountView();
    clickView(host, 'Kanban');
    expectDefined(host.querySelector<HTMLButtonElement>('.abyss-view-state-btn')).click();

    const roots = directViewOptionRows(host);
    expect(
      roots.map((row) =>
        row
          .querySelector(':scope > .abyss-view-state-row-main .abyss-view-state-row-label')
          ?.textContent.trim(),
      ),
    ).toEqual(['Group by', 'Sort by', 'Kanban']);

    const kanban = expectDefined(roots[2]);
    const kanbanButton = expectDefined(
      kanban.querySelector<HTMLButtonElement>(':scope > .abyss-view-state-row-main'),
    );
    kanbanButton.click();
    const fields = viewOptionRow(kanban, 'Card fields');
    const description = viewOptionRow(kanban, 'Description');
    expectDefined(
      fields.querySelector<HTMLButtonElement>(':scope > .abyss-view-state-row-main'),
    ).click();
    expectDefined(
      description.querySelector<HTMLButtonElement>(':scope > .abyss-view-state-row-main'),
    ).click();

    expect(kanbanButton.getAttribute('aria-expanded')).toBe('true');
    expect(
      fields
        .querySelector<HTMLElement>(':scope > .abyss-view-state-row-main')
        ?.getAttribute('aria-expanded'),
    ).toBe('false');
    expect(
      description
        .querySelector<HTMLElement>(':scope > .abyss-view-state-row-main')
        ?.getAttribute('aria-expanded'),
    ).toBe('true');
  });

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

  it('updates successive board grouping and sort direction choices in one popover', async () => {
    const { host, settings } = mountView();
    const tableGroup = settings.projects.table.groupBy;
    const tableSort = { ...settings.projects.table.sortBy };
    clickView(host, 'Kanban');

    const trigger = expectDefined(host.querySelector<HTMLButtonElement>('.abyss-view-state-btn'));
    trigger.click();
    const popover = expectDefined(host.querySelector<HTMLElement>('.abyss-view-state-popover'));
    chooseViewOption(host, 'Group by', 'Budget');
    await flushMicrotasks();
    expect(host.querySelector('.abyss-view-state-popover')).toBe(popover);
    expect(
      viewOptionRow(popover, 'Group by').querySelector('.abyss-view-state-row-value')?.textContent,
    ).toBe('Budget');
    const openedKanban = expectDefined(settings.projects.kanban);
    settings.projects.kanban = structuredClone(openedKanban);
    chooseViewOption(host, 'Sort by', 'End');
    await flushMicrotasks();
    expect(host.querySelector('.abyss-view-state-popover')).toBe(popover);
    expect(
      viewOptionRow(popover, 'Sort by').querySelector('.abyss-view-state-row-value')?.textContent,
    ).toBe('End ↑');
    chooseViewOption(host, 'Sort by', 'End ↑');
    await flushMicrotasks();

    const kanban = expectDefined(settings.projects.kanban);
    expect(kanban.groupBy).toBe('property:Budget');
    expect(kanban.sortBy).toEqual({ field: 'end', dir: 'desc' });
    expect(openedKanban.sortBy).toEqual({ field: 'start', dir: 'asc' });
    expect(
      viewOptionRow(popover, 'Sort by').querySelector('.abyss-view-state-row-value')?.textContent,
    ).toBe('End ↓');
    expect(settings.projects.table.groupBy).toBe(tableGroup);
    expect(settings.projects.table.sortBy).toEqual(tableSort);
  });

  it('offers the table group catalog once while keeping card-field exclusions card-only', () => {
    const { host, settings } = mountView();
    settings.projects.kanban = buildDefaultProjectKanbanSettings(settings.projects.table);
    clickView(host, 'Kanban');
    expectDefined(host.querySelector<HTMLButtonElement>('.abyss-view-state-btn')).click();
    const group = viewOptionRow(host, 'Group by');
    expectDefined(group.querySelector<HTMLButtonElement>('.abyss-view-state-row-main')).click();
    const labels = Array.from(
      group.querySelectorAll<HTMLElement>('.abyss-view-state-option-label'),
      ({ textContent }) => textContent.trim(),
    );

    expect(labels.filter((label) => label === 'Status columns')).toHaveLength(1);
    expect(labels).toEqual(
      expect.arrayContaining(['Name', 'Progress', 'Description', 'Budget', 'Status columns']),
    );
  });

  it('synchronizes an open table menu from the current replaced view state', async () => {
    const { host, settings } = mountView();
    settings.projects.table.columns.push({ id: 'property:Budget', visible: true });
    expectDefined(host.querySelector<HTMLButtonElement>('.abyss-view-state-btn')).click();
    const popover = expectDefined(host.querySelector<HTMLElement>('.abyss-view-state-popover'));
    const openedTable = settings.projects.table;
    settings.projects.table = structuredClone(openedTable);

    chooseViewOption(host, 'Group by', 'Budget');
    await flushMicrotasks();

    expect(settings.projects.table.groupBy).toBe('property:Budget');
    expect(openedTable.groupBy).toBe('status');
    expect(host.querySelector('.abyss-view-state-popover')).toBe(popover);
    expect(
      viewOptionRow(popover, 'Group by').querySelector('.abyss-view-state-row-value')?.textContent,
    ).toBe('Budget');
    expect(
      optionRow(viewOptionRow(popover, 'Columns'), 'Budget')
        .querySelector<HTMLButtonElement>('.abyss-view-state-option')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(popover.querySelector('.abyss-view-state-reset-btn')).not.toBeNull();
  });

  it('closes the options popover when resetting a customized view', () => {
    const { host, settings } = mountView();
    settings.projects.table.groupBy = 'none';
    expectDefined(host.querySelector<HTMLButtonElement>('.abyss-view-state-btn')).click();

    expectDefined(host.querySelector<HTMLButtonElement>('.abyss-view-state-reset-btn')).click();

    expect(host.querySelector('.abyss-view-state-popover')).toBeNull();
    expect(settings.projects.table.groupBy).toBe('status');
  });

  it('offers Kanban reset without a customization dot and restores seeded Manual order', () => {
    const planned = expectDefined(DEFAULT_SETTINGS.projects.statuses[0]);
    const a = project({ path: 'Projects/A.md', name: 'A' });
    const b = project({ path: 'Projects/B.md', name: 'B' });
    const { host, view, settings } = mountView([a, b]);
    settings.projects.table.sortBy = { field: 'none', dir: 'asc' };
    clickView(host, 'Kanban');
    const kanban = expectDefined(settings.projects.kanban);
    kanban.manualOrder[`id:${planned.id}`] = ['Projects/B.md', 'Projects/A.md'];
    view.refreshFields();
    const viewOptions = expectDefined(
      host.querySelector<HTMLButtonElement>('.abyss-view-state-btn'),
    );

    expect(viewOptions.classList.contains('abyss-view-state-btn--active')).toBe(false);
    viewOptions.click();
    expectDefined(host.querySelector<HTMLButtonElement>('.abyss-view-state-reset-btn')).click();

    expect(settings.projects.kanban?.sortBy).toEqual({ field: 'none', dir: 'asc' });
    expect(settings.projects.kanban?.manualOrder[`id:${planned.id}`]).toEqual([
      'Projects/A.md',
      'Projects/B.md',
    ]);
    expect(
      Array.from(
        host.querySelectorAll<HTMLElement>('.abyss-project-kanban-card'),
        (card) => card.dataset['projectPath'],
      ),
    ).toEqual(['Projects/A.md', 'Projects/B.md']);
    expect(viewOptions.classList.contains('abyss-view-state-btn--active')).toBe(false);
  });

  it('drags the full card and title, excludes protected controls, and retains card identity', async () => {
    const planned = expectDefined(DEFAULT_SETTINGS.projects.statuses[0]);
    const active = expectDefined(DEFAULT_SETTINGS.projects.statuses[1]);
    const source = project({
      path: 'Projects/A.md',
      frontmatter: { status: planned.name, start: '2026-09-01', end: '2026-09-30' },
      statusId: planned.id,
    });
    const target = project({
      path: 'Projects/B.md',
      name: 'B',
      frontmatter: { status: active.name, start: '2026-09-01', end: '2026-09-30' },
      statusId: active.id,
    });
    const openProject = vi.fn();
    const { host, settings, applyEdits } = mountView([source, target], { openProject });
    settings.projects.kanban = buildDefaultProjectKanbanSettings(settings.projects.table);
    settings.projects.kanban.sortBy = { field: 'none', dir: 'asc' };
    clickView(host, 'Kanban');
    const card = expectDefined(
      host.querySelector<HTMLElement>(
        '.abyss-project-kanban-card[data-project-path="Projects/A.md"]',
      ),
    );
    const original = card;
    const title = expectDefined(card.querySelector<HTMLButtonElement>('.abyss-project-table-name'));
    const data = transfer();

    const protectedControl = card.createEl('button', { attr: { type: 'button' } });
    const protectedStart = dragEvent('dragstart', data);
    protectedControl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    card.dispatchEvent(protectedStart);
    expect(protectedStart.defaultPrevented).toBe(true);

    title.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    title.dispatchEvent(dragEvent('dragstart', data));
    expect(card.classList.contains('is-dragging')).toBe(true);
    expect(data.types).toEqual(['application/x-abyss-project-kanban-card']);
    const targetColumn = expectDefined(
      host.querySelector<HTMLElement>(
        `.abyss-project-kanban-column[data-status-key="id:${active.id}"]`,
      ),
    );
    targetColumn.dispatchEvent(dragEvent('dragover', data));
    expect(targetColumn.classList.contains('is-drop-target')).toBe(true);
    targetColumn.dispatchEvent(dragEvent('drop', data));
    title.click();
    expect(openProject).not.toHaveBeenCalled();
    await flushMicrotasks();

    expect(applyEdits).toHaveBeenCalledOnce();
    expect(applyEdits.mock.calls[0]?.[0]).toMatchObject([
      { path: 'Projects/A.md', value: active.name, expectedValue: planned.name },
    ]);
    expect(
      host.querySelector('.abyss-project-kanban-card[data-project-path="Projects/A.md"]'),
    ).toBe(original);
    expect(original.closest('.abyss-project-kanban-column')?.getAttribute('data-status-key')).toBe(
      `id:${active.id}`,
    );
    expect(host.querySelector('.is-drop-target, .is-dragging')).toBeNull();
  });

  it('does not suppress a later intentional title click when no post-drag click fired', async () => {
    const sourceStatus = expectDefined(DEFAULT_SETTINGS.projects.statuses[0]);
    const targetStatus = expectDefined(DEFAULT_SETTINGS.projects.statuses[1]);
    const openProject = vi.fn();
    const { host, settings } = mountView(
      [
        project({
          frontmatter: { status: sourceStatus.name },
          statusId: sourceStatus.id,
        }),
      ],
      { openProject },
    );
    settings.projects.kanban = buildDefaultProjectKanbanSettings(settings.projects.table);
    clickView(host, 'Kanban');
    const card = expectDefined(host.querySelector<HTMLElement>('.abyss-project-kanban-card'));
    const data = transfer();
    card.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    card.dispatchEvent(dragEvent('dragstart', data));
    expectDefined(
      host.querySelector<HTMLElement>(
        `.abyss-project-kanban-column[data-status-key="id:${targetStatus.id}"]`,
      ),
    ).dispatchEvent(dragEvent('drop', data));
    await flushMicrotasks();
    const title = expectDefined(card.querySelector<HTMLButtonElement>('.abyss-project-table-name'));

    title.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    title.click();

    expect(openProject).toHaveBeenCalledOnce();
  });

  it('arms over an old range and accepts a bubbling text-node dragstart', () => {
    const openProject = vi.fn();
    const { host } = mountView(undefined, { openProject });
    clickView(host, 'Kanban');
    const card = expectDefined(host.querySelector<HTMLElement>('.abyss-project-kanban-card'));
    const start = expectDefined(
      card.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="start"]'),
    );
    const text = prettyDateTextNode(start);
    const selection = expectDefined(activeDocument.defaultView?.getSelection());
    start.click();
    expect(start.classList.contains('is-selected')).toBe(true);
    selection.removeAllRanges();
    const range = activeDocument.createRange();
    range.selectNodeContents(start);
    selection.addRange(range);
    expect(selection.toString().length).toBeGreaterThan(0);

    const pointerdown = new PointerEvent('pointerdown', {
      bubbles: true,
      button: 0,
      pointerId: 7,
    });
    start.dispatchEvent(pointerdown);

    expect(pointerdown.defaultPrevented).toBe(false);
    expect(selection.toString()).toBe('');
    expect(start.classList.contains('is-selected')).toBe(true);
    expect(card.classList.contains('is-drag-armed')).toBe(true);
    const thresholdRange = activeDocument.createRange();
    thresholdRange.selectNodeContents(start);
    selection.addRange(thresholdRange);
    expect(selection.toString().length).toBeGreaterThan(0);
    const data = transfer();
    const drag = dragEvent('dragstart', data);
    text.dispatchEvent(drag);

    expect(drag.defaultPrevented).toBe(false);
    expect(data.types).toEqual(['application/x-abyss-project-kanban-card']);
    expect(selection.toString()).toBe('');
    expect(card.querySelector('.is-selected')).toBeNull();
    expect(card.classList.contains('is-drag-armed')).toBe(false);
    expect(card.classList.contains('is-dragging')).toBe(true);
    expect(
      host.querySelector('.abyss-projects-table')?.classList.contains('is-project-dragging'),
    ).toBe(true);
    activeDocument.dispatchEvent(
      new PointerEvent('pointercancel', { bubbles: true, pointerId: 7 }),
    );
    expect(card.classList.contains('is-dragging')).toBe(true);

    activeDocument.defaultView?.dispatchEvent(new Event('blur'));
    expect(card.classList.contains('is-dragging')).toBe(false);
    expect(
      host.querySelector('.abyss-projects-table')?.classList.contains('is-project-dragging'),
    ).toBe(false);
    expect(activeDocument.querySelector('.abyss-project-kanban-drag-image')).toBeNull();
    const title = expectDefined(card.querySelector<HTMLButtonElement>('.abyss-project-table-name'));
    title.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 8 }),
    );
    activeDocument.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 8 }));
    title.click();
    expect(openProject).toHaveBeenCalledOnce();

    card.dispatchEvent(dragEvent('dragend', data));
    expect(host.querySelector('.is-dragging, .is-drop-target')).toBeNull();
  });

  it('disarms a provisional gesture on pointerup, pointercancel, and window blur', () => {
    const { host } = mountView();
    clickView(host, 'Kanban');
    const card = expectDefined(host.querySelector<HTMLElement>('.abyss-project-kanban-card'));
    const start = expectDefined(
      card.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="start"]'),
    );
    const text = prettyDateTextNode(start);

    start.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 11 }),
    );
    expect(card.classList.contains('is-drag-armed')).toBe(true);
    activeDocument.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 99 }));
    expect(card.classList.contains('is-drag-armed')).toBe(true);
    activeDocument.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 11 }));
    expect(card.classList.contains('is-drag-armed')).toBe(false);
    const staleAfterUp = dragEvent('dragstart', transfer());
    text.dispatchEvent(staleAfterUp);
    expect(staleAfterUp.defaultPrevented).toBe(true);

    start.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 12 }),
    );
    activeDocument.dispatchEvent(
      new PointerEvent('pointercancel', { bubbles: true, pointerId: 12 }),
    );
    expect(card.classList.contains('is-drag-armed')).toBe(false);
    const staleAfterCancel = dragEvent('dragstart', transfer());
    text.dispatchEvent(staleAfterCancel);
    expect(staleAfterCancel.defaultPrevented).toBe(true);

    start.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 13 }),
    );
    activeDocument.defaultView?.dispatchEvent(new Event('blur'));
    expect(card.classList.contains('is-drag-armed')).toBe(false);
    const staleAfterBlur = dragEvent('dragstart', transfer());
    text.dispatchEvent(staleAfterBlur);
    expect(staleAfterBlur.defaultPrevented).toBe(true);
  });

  it('keeps label and padding gestures from retargeting focus through the card', () => {
    const { host } = mountView();
    clickView(host, 'Kanban');
    const card = expectDefined(host.querySelector<HTMLElement>('.abyss-project-kanban-card'));
    const label = expectDefined(
      card.querySelector<HTMLElement>('.abyss-project-kanban-field-label'),
    );

    expect(card.getAttribute('tabindex')).toBe('0');
    label.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 14 }),
    );
    expect(card.hasAttribute('tabindex')).toBe(false);
    activeDocument.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 14 }));
    expect(card.getAttribute('tabindex')).toBe('0');
    label.click();
    expect(card.classList.contains('is-selected')).toBe(true);

    card.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 15 }),
    );
    expect(card.hasAttribute('tabindex')).toBe(false);
    const data = transfer();
    card.dispatchEvent(dragEvent('dragstart', data));
    expect(card.getAttribute('tabindex')).toBe('0');
    card.dispatchEvent(dragEvent('dragend', data));
  });

  it('leaves protected links and editors alone while preserving plain title and metadata clicks', () => {
    const openProject = vi.fn();
    const { host } = mountView(undefined, { openProject });
    clickView(host, 'Kanban');
    const card = expectDefined(host.querySelector<HTMLElement>('.abyss-project-kanban-card'));
    const title = expectDefined(card.querySelector<HTMLButtonElement>('.abyss-project-table-name'));
    const start = expectDefined(
      card.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="start"]'),
    );
    const end = expectDefined(
      card.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="end"]'),
    );
    const selection = expectDefined(activeDocument.defaultView?.getSelection());
    const range = activeDocument.createRange();
    range.selectNodeContents(start);
    selection.addRange(range);
    const selectedText = selection.toString();
    const anchor = card.createEl('a', { text: 'Reference', href: '#reference' });
    const checkbox = card.createEl('input', { attr: { type: 'checkbox' } });
    const remove = card.createEl('button', { attr: { type: 'button' }, text: 'Remove' });
    const select = card.createEl('select');
    select.createEl('option', { text: 'Option' });
    const textarea = card.createEl('textarea');
    const editor = card.createDiv({ cls: 'abyss-project-cell-editor' });
    const editorSurface = editor.createDiv({ text: 'Editor surface' });

    anchor.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 20 }),
    );
    expect(selection.toString()).toBe(selectedText);
    expect(card.classList.contains('is-drag-armed')).toBe(false);
    const anchorDrag = dragEvent('dragstart', transfer());
    anchor.dispatchEvent(anchorDrag);
    expect(anchorDrag.defaultPrevented).toBe(true);

    selection.removeAllRanges();
    for (const protectedSurface of [checkbox, remove, select, textarea, editorSurface]) {
      protectedSurface.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 21 }),
      );
      expect(card.classList.contains('is-drag-armed')).toBe(false);
      const protectedDrag = dragEvent('dragstart', transfer());
      protectedSurface.dispatchEvent(protectedDrag);
      expect(protectedDrag.defaultPrevented).toBe(true);
    }

    title.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 22 }),
    );
    activeDocument.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 22 }));
    title.click();
    expect(openProject).toHaveBeenCalledOnce();
    expect(card.classList.contains('is-drag-armed')).toBe(false);

    start.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 23 }),
    );
    activeDocument.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 23 }));
    start.click();
    expect(start.classList.contains('is-selected')).toBe(true);
    expect(card.classList.contains('is-selected')).toBe(true);
    end.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    expect(start.classList.contains('is-selected')).toBe(true);
    expect(end.classList.contains('is-selected')).toBe(true);
    expect(checkbox.checked).toBe(false);
    checkbox.click();
    expect(checkbox.checked).toBe(true);
  });

  it('releases provisional state on missing transfer, capture failure, Escape, and destroy', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { host, view } = mountView();
    clickView(host, 'Kanban');
    const card = expectDefined(host.querySelector<HTMLElement>('.abyss-project-kanban-card'));
    const start = expectDefined(
      card.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="start"]'),
    );
    const text = prettyDateTextNode(start);

    start.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 31 }),
    );
    const missingTransfer = new MouseEvent('dragstart', { bubbles: true, cancelable: true });
    text.dispatchEvent(missingTransfer);
    expect(missingTransfer.defaultPrevented).toBe(true);
    expect(card.classList.contains('is-drag-armed')).toBe(false);
    expect(card.getAttribute('tabindex')).toBe('0');

    card.dataset['projectPath'] = 'Projects/Stale.md';
    start.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 32 }),
    );
    const captureFailure = dragEvent('dragstart', transfer());
    text.dispatchEvent(captureFailure);
    expect(captureFailure.defaultPrevented).toBe(true);
    expect(card.classList.contains('is-drag-armed')).toBe(false);
    expect(card.classList.contains('is-dragging')).toBe(false);
    expect(activeDocument.querySelector('.abyss-project-kanban-drag-image')).toBeNull();
    expect(card.getAttribute('tabindex')).toBe('0');

    card.dataset['projectPath'] = 'Projects/A.md';
    const setupFailureData = transfer();
    setupFailureData.setDragImage = vi.fn(() => {
      throw new Error('Could not install drag image');
    });
    start.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 33 }),
    );
    const setupFailure = dragEvent('dragstart', setupFailureData);
    text.dispatchEvent(setupFailure);
    expect(setupFailure.defaultPrevented).toBe(true);
    expect(card.classList.contains('is-drag-armed')).toBe(false);
    expect(card.classList.contains('is-dragging')).toBe(false);
    expect(activeDocument.querySelector('.abyss-project-kanban-drag-image')).toBeNull();
    expect(card.getAttribute('tabindex')).toBe('0');

    start.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 34 }),
    );
    activeDocument.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(card.classList.contains('is-drag-armed')).toBe(false);
    expect(card.getAttribute('tabindex')).toBe('0');

    start.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 35 }),
    );
    expect(card.classList.contains('is-drag-armed')).toBe(true);
    view.destroy();
    mounted.delete(view);
    expect(card.classList.contains('is-drag-armed')).toBe(false);
    expect(card.getAttribute('tabindex')).toBe('0');
  });

  it('keeps a re-entered collapsed target through an ambiguous stale leave and drops there', async () => {
    vi.useFakeTimers();
    const sourceStatus = expectDefined(DEFAULT_SETTINGS.projects.statuses[0]);
    const collapsedStatus = expectDefined(DEFAULT_SETTINGS.projects.statuses[1]);
    const expandedStatus = expectDefined(DEFAULT_SETTINGS.projects.statuses[2]);
    const { host, settings, applyEdits } = mountView([
      project({
        statusId: sourceStatus.id,
        frontmatter: { status: sourceStatus.name },
      }),
    ]);
    settings.projects.kanban = buildDefaultProjectKanbanSettings(settings.projects.table);
    settings.projects.kanban.collapsedColumns = [`id:${collapsedStatus.id}`];
    clickView(host, 'Kanban');
    const card = expectDefined(host.querySelector<HTMLElement>('.abyss-project-kanban-card'));
    const collapsed = expectDefined(
      host.querySelector<HTMLElement>(
        `.abyss-project-kanban-column[data-status-key="id:${collapsedStatus.id}"]`,
      ),
    );
    const expanded = expectDefined(
      host.querySelector<HTMLElement>(
        `.abyss-project-kanban-column[data-status-key="id:${expandedStatus.id}"]`,
      ),
    );
    const data = transfer();
    card.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    card.dispatchEvent(dragEvent('dragstart', data));
    collapsed.dispatchEvent(dragEvent('dragover', data));
    vi.advanceTimersByTime(450);
    expect(host.querySelector('.abyss-project-kanban-hover-preview')).not.toBeNull();

    expanded.dispatchEvent(dragEvent('dragover', data));
    collapsed.dispatchEvent(dragEvent('dragover', data));
    expect(collapsed.classList.contains('is-drop-target')).toBe(true);
    const staleLeave = dragEvent('dragleave', data);
    Object.defineProperty(staleLeave, 'relatedTarget', { value: null });
    expanded.dispatchEvent(staleLeave);

    expect(collapsed.classList.contains('is-drop-target')).toBe(true);
    vi.advanceTimersByTime(450);
    const overlay = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-kanban-hover-preview'),
    );
    overlay.dispatchEvent(dragEvent('drop', data));
    await vi.runAllTimersAsync();

    expect(applyEdits).toHaveBeenCalledOnce();
    expect(applyEdits.mock.calls[0]?.[0]).toMatchObject([
      { path: 'Projects/A.md', value: collapsedStatus.name, expectedValue: sourceStatus.name },
    ]);
  });

  it('clears an ambiguous leave only after the document proves the drag is outside the board', () => {
    const sourceStatus = expectDefined(DEFAULT_SETTINGS.projects.statuses[0]);
    const targetStatus = expectDefined(DEFAULT_SETTINGS.projects.statuses[1]);
    const { host } = mountView([
      project({ statusId: sourceStatus.id, frontmatter: { status: sourceStatus.name } }),
    ]);
    clickView(host, 'Kanban');
    const card = expectDefined(host.querySelector<HTMLElement>('.abyss-project-kanban-card'));
    const target = expectDefined(
      host.querySelector<HTMLElement>(
        `.abyss-project-kanban-column[data-status-key="id:${targetStatus.id}"]`,
      ),
    );
    const data = transfer();
    card.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    card.dispatchEvent(dragEvent('dragstart', data));
    target.dispatchEvent(dragEvent('dragover', data));
    const ambiguousLeave = dragEvent('dragleave', data);
    Object.defineProperty(ambiguousLeave, 'relatedTarget', { value: null });
    target.dispatchEvent(ambiguousLeave);
    expect(target.classList.contains('is-drop-target')).toBe(true);

    activeDocument.body.dispatchEvent(dragEvent('dragover', data));

    expect(target.classList.contains('is-drop-target')).toBe(false);
  });

  it('places a lower-half card drop immediately after that card', () => {
    const status = expectDefined(DEFAULT_SETTINGS.projects.statuses[0]);
    const projects = ['A', 'B', 'C'].map((name) =>
      project({
        path: `Projects/${name}.md`,
        name,
        statusId: status.id,
        frontmatter: { status: status.name },
      }),
    );
    const { host, settings } = mountView(projects);
    settings.projects.kanban = buildDefaultProjectKanbanSettings(settings.projects.table);
    settings.projects.kanban.sortBy = { field: 'none', dir: 'asc' };
    clickView(host, 'Kanban');
    const source = expectDefined(
      host.querySelector<HTMLElement>(
        '.abyss-project-kanban-card[data-project-path="Projects/A.md"]',
      ),
    );
    const middle = expectDefined(
      host.querySelector<HTMLElement>(
        '.abyss-project-kanban-card[data-project-path="Projects/B.md"]',
      ),
    );
    const last = expectDefined(
      host.querySelector<HTMLElement>(
        '.abyss-project-kanban-card[data-project-path="Projects/C.md"]',
      ),
    );
    vi.spyOn(middle, 'getBoundingClientRect').mockReturnValue(rectangle(0, 0, 240, 100));
    const initialRect = middle.getBoundingClientRect();
    const data = transfer();
    source.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    source.dispatchEvent(dragEvent('dragstart', data));

    middle.dispatchEvent(dragEvent('dragover', data, { clientX: 120, clientY: 75 }));

    const line = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-kanban-insertion-line'),
    );
    expect(line.style.getPropertyValue('--abyss-project-kanban-insertion-top')).not.toBe('');
    expect(middle.getBoundingClientRect()).toEqual(initialRect);
    expect(line.previousElementSibling).toBe(middle);
    expect(line.nextElementSibling).toBe(last);
  });

  it('renders a completed manual-only reorder immediately', async () => {
    const status = expectDefined(DEFAULT_SETTINGS.projects.statuses[0]);
    const projects = ['A', 'B', 'C'].map((name) =>
      project({
        path: `Projects/${name}.md`,
        name,
        statusId: status.id,
        frontmatter: { status: status.name },
      }),
    );
    const { host, settings, applyEdits } = mountView(projects);
    settings.projects.kanban = buildDefaultProjectKanbanSettings(settings.projects.table);
    settings.projects.kanban.sortBy = { field: 'none', dir: 'asc' };
    clickView(host, 'Kanban');
    const cards = Array.from(host.querySelectorAll<HTMLElement>('.abyss-project-kanban-card'));
    const source = expectDefined(cards[1]);
    const target = expectDefined(cards[0]);
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(rectangle(0, 0, 240, 100));
    const data = transfer();
    source.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    source.dispatchEvent(dragEvent('dragstart', data));

    target.dispatchEvent(dragEvent('drop', data, { clientX: 120, clientY: 10 }));
    await flushMicrotasks();

    expect(settings.projects.kanban.manualOrder[`id:${status.id}`]).toEqual([
      'Projects/B.md',
      'Projects/A.md',
      'Projects/C.md',
    ]);
    expect(applyEdits).not.toHaveBeenCalled();
    expect(
      Array.from(
        host.querySelectorAll<HTMLElement>('.abyss-project-kanban-card'),
        (card) => card.dataset['projectPath'],
      ),
    ).toEqual(['Projects/B.md', 'Projects/A.md', 'Projects/C.md']);
  });

  it('captures the first Manual sequence and appends later observations without repeat saves', async () => {
    const status = expectDefined(DEFAULT_SETTINGS.projects.statuses[0]);
    const b = project({ path: 'Projects/B.md', name: 'B' });
    const c = project({ path: 'Projects/C.md', name: 'C' });
    const a = project({ path: 'Projects/A.md', name: 'A' });
    const saveViewState = vi.fn().mockResolvedValue(undefined);
    const { host, view, settings } = mountView([b, c], { saveViewState });
    settings.projects.table.sortBy = { field: 'none', dir: 'asc' };

    clickView(host, 'Kanban');
    await flushMicrotasks();
    expect(settings.projects.kanban?.manualOrder[`id:${status.id}`]).toEqual([
      'Projects/B.md',
      'Projects/C.md',
    ]);
    saveViewState.mockClear();

    view.update([a, b, c]);
    await flushMicrotasks();

    expect(settings.projects.kanban?.manualOrder[`id:${status.id}`]).toEqual([
      'Projects/B.md',
      'Projects/C.md',
      'Projects/A.md',
    ]);
    expect(
      Array.from(
        host.querySelectorAll<HTMLElement>('.abyss-project-kanban-card'),
        (card) => card.dataset['projectPath'],
      ),
    ).toEqual(['Projects/B.md', 'Projects/C.md', 'Projects/A.md']);
    expect(saveViewState).toHaveBeenCalledOnce();

    saveViewState.mockClear();
    view.update([a, b, c]);
    await flushMicrotasks();
    expect(saveViewState).not.toHaveBeenCalled();
  });

  it('records hidden newcomers during field sorting and preserves their Manual order on reload', async () => {
    const status = expectDefined(DEFAULT_SETTINGS.projects.statuses[0]);
    const b = project({ path: 'Projects/B.md', name: 'B' });
    const c = project({ path: 'Projects/C.md', name: 'C' });
    const a = project({ path: 'Projects/A.md', name: 'A' });
    const aa = project({ path: 'Projects/AA.md', name: 'AA' });
    const { host, view, settings } = mountView([b, c]);
    settings.projects.table.sortBy = { field: 'name', dir: 'asc' };
    clickView(host, 'Kanban');
    const kanban = expectDefined(settings.projects.kanban);
    kanban.hiddenStatuses = [`id:${status.id}`];

    view.update([a, b, c]);
    view.update([a, aa, b, c]);

    expect(kanban.manualOrder[`id:${status.id}`]).toEqual([
      'Projects/B.md',
      'Projects/C.md',
      'Projects/A.md',
      'Projects/AA.md',
    ]);
    expect(host.querySelectorAll('.abyss-project-kanban-card')).toHaveLength(0);

    kanban.hiddenStatuses = [];
    kanban.sortBy = { field: 'none', dir: 'asc' };
    view.refreshFields();
    expect(
      Array.from(
        host.querySelectorAll<HTMLElement>('.abyss-project-kanban-card'),
        (card) => card.dataset['projectPath'],
      ),
    ).toEqual(['Projects/B.md', 'Projects/C.md', 'Projects/A.md', 'Projects/AA.md']);

    const restored = structuredClone(settings);
    restored.projects.overviewView = 'kanban';
    restored.projects.kanban = normalizeProjectKanbanSettings(
      restored.projects.kanban,
      restored.projects.table,
    );
    const saveViewState = vi.fn().mockResolvedValue(undefined);
    const reloaded = mountView([a, aa, b, c], { settings: restored, saveViewState });
    await flushMicrotasks();

    expect(
      Array.from(
        reloaded.host.querySelectorAll<HTMLElement>('.abyss-project-kanban-card'),
        (card) => card.dataset['projectPath'],
      ),
    ).toEqual(['Projects/B.md', 'Projects/C.md', 'Projects/A.md', 'Projects/AA.md']);
    expect(saveViewState).not.toHaveBeenCalled();
  });

  it('retains an active source through an external grouping edit and reconciles after dragend', () => {
    const initial = project();
    const { host, view, settings } = mountView([initial]);
    settings.projects.table.groupBy = 'property:Budget';
    clickView(host, 'Kanban');
    const card = expectDefined(host.querySelector<HTMLElement>('.abyss-project-kanban-card'));
    const initialGroup = card.closest<HTMLElement>('[data-group-key]');
    const data = transfer();
    card.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    card.dispatchEvent(dragEvent('dragstart', data));

    view.update([{ ...initial, frontmatter: { ...initial.frontmatter, Budget: 99 } }]);

    expect(card.isConnected).toBe(true);
    expect(card.closest('[data-group-key]')).toBe(initialGroup);
    card.dispatchEvent(dragEvent('dragend', data));

    const reconciled = expectDefined(
      host.querySelector<HTMLElement>(
        '.abyss-project-kanban-card[data-project-path="Projects/A.md"]',
      ),
    );
    expect(card.isConnected).toBe(false);
    expect(reconciled.closest<HTMLElement>('[data-group-key]')?.dataset['groupKey']).toBe(
      'value:99',
    );
    expect(activeDocument.querySelectorAll('.abyss-project-kanban-drag-image')).toHaveLength(0);
    expect(
      host.querySelector('.abyss-projects-table')?.classList.contains('is-project-dragging'),
    ).toBe(false);
  });

  it('retains an active source through membership loss and removes it after cancellation', () => {
    const { host, view } = mountView();
    clickView(host, 'Kanban');
    const card = expectDefined(host.querySelector<HTMLElement>('.abyss-project-kanban-card'));
    const data = transfer();
    card.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    card.dispatchEvent(dragEvent('dragstart', data));

    view.update([]);

    expect(card.isConnected).toBe(true);
    card.dispatchEvent(dragEvent('dragend', data));
    expect(card.isConnected).toBe(false);
    expect(host.querySelector('.abyss-project-kanban-card')).toBeNull();
    expect(activeDocument.querySelectorAll('.abyss-project-kanban-drag-image')).toHaveLength(0);
    expect(
      host.querySelector('.abyss-projects-table')?.classList.contains('is-project-dragging'),
    ).toBe(false);
  });

  it('rejects a stale drop after a deferred external grouping change', async () => {
    const sourceStatus = expectDefined(DEFAULT_SETTINGS.projects.statuses[0]);
    const targetStatus = expectDefined(DEFAULT_SETTINGS.projects.statuses[1]);
    const initial = project({
      statusId: sourceStatus.id,
      frontmatter: { status: sourceStatus.name, Budget: 42 },
    });
    const { host, view, settings, applyEdits } = mountView([initial]);
    settings.projects.table.groupBy = 'property:Budget';
    clickView(host, 'Kanban');
    const card = expectDefined(host.querySelector<HTMLElement>('.abyss-project-kanban-card'));
    const target = expectDefined(
      host.querySelector<HTMLElement>(
        `.abyss-project-kanban-column[data-status-key="id:${targetStatus.id}"]`,
      ),
    );
    const data = transfer();
    card.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    card.dispatchEvent(dragEvent('dragstart', data));

    view.update([{ ...initial, frontmatter: { ...initial.frontmatter, Budget: 99 } }]);
    expect(card.isConnected).toBe(true);
    target.dispatchEvent(dragEvent('drop', data));
    await flushMicrotasks();

    expect(applyEdits).not.toHaveBeenCalled();
    expect(host.querySelector('.abyss-project-table-feedback')?.textContent).toContain('changed');
    expect(activeDocument.querySelectorAll('.abyss-project-kanban-drag-image')).toHaveLength(0);
    expect(
      host.querySelector('.abyss-projects-table')?.classList.contains('is-project-dragging'),
    ).toBe(false);
  });

  it('revalidates the captured source inside the queued drop', async () => {
    const planned = expectDefined(DEFAULT_SETTINGS.projects.statuses[0]);
    const active = expectDefined(DEFAULT_SETTINGS.projects.statuses[1]);
    const source = project({
      frontmatter: { status: planned.name, start: '2026-09-01', end: '2026-09-30' },
      statusId: planned.id,
    });
    const { host, view, settings, applyEdits } = mountView([source]);
    settings.projects.kanban = buildDefaultProjectKanbanSettings(settings.projects.table);
    clickView(host, 'Kanban');
    const card = expectDefined(
      host.querySelector<HTMLElement>(
        '.abyss-project-kanban-card[data-project-path="Projects/A.md"]',
      ),
    );
    const data = transfer();
    card.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    card.dispatchEvent(dragEvent('dragstart', data));
    view.update([
      project({
        frontmatter: { status: 'Externally changed', start: '2026-09-01', end: '2026-09-30' },
        statusId: null,
        rawStatus: 'Externally changed',
      }),
    ]);
    expect(card.isConnected).toBe(true);
    const target = expectDefined(
      host.querySelector<HTMLElement>(
        `.abyss-project-kanban-column[data-status-key="id:${active.id}"]`,
      ),
    );

    target.dispatchEvent(dragEvent('drop', data));
    await flushMicrotasks();

    expect(applyEdits).not.toHaveBeenCalled();
    expect(host.querySelector('.abyss-project-table-feedback')?.textContent).toContain('changed');
    expect(activeDocument.querySelectorAll('.abyss-project-kanban-drag-image')).toHaveLength(0);
    expect(
      host.querySelector('.abyss-projects-table')?.classList.contains('is-project-dragging'),
    ).toBe(false);
  });

  it('keeps committed manual order and offers Retry when its settings save fails', async () => {
    const planned = expectDefined(DEFAULT_SETTINGS.projects.statuses[0]);
    const active = expectDefined(DEFAULT_SETTINGS.projects.statuses[1]);
    const source = project({
      frontmatter: { status: planned.name, start: '2026-09-01', end: '2026-09-30' },
      statusId: planned.id,
    });
    const targetProject = project({
      path: 'Projects/B.md',
      name: 'B',
      frontmatter: { status: active.name, start: '2026-09-01', end: '2026-09-30' },
      statusId: active.id,
    });
    const saveViewState = vi.fn().mockRejectedValue(new Error('disk full'));
    const { host, settings, applyEdits } = mountView([source, targetProject], { saveViewState });
    settings.projects.kanban = buildDefaultProjectKanbanSettings(settings.projects.table);
    settings.projects.kanban.sortBy = { field: 'none', dir: 'asc' };
    let noticeContent: unknown;
    vi.spyOn(
      Notice.prototype as unknown as { constructor__(message: unknown): void },
      'constructor__',
    ).mockImplementation((message) => {
      noticeContent = message;
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    clickView(host, 'Kanban');
    const card = expectDefined(
      host.querySelector<HTMLElement>(
        '.abyss-project-kanban-card[data-project-path="Projects/A.md"]',
      ),
    );
    const data = transfer();
    card.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    card.dispatchEvent(dragEvent('dragstart', data));
    expectDefined(
      host.querySelector<HTMLElement>(
        `.abyss-project-kanban-column[data-status-key="id:${active.id}"]`,
      ),
    ).dispatchEvent(dragEvent('drop', data));
    await flushMicrotasks();

    expect(applyEdits).toHaveBeenCalledOnce();
    expect(settings.projects.kanban.manualOrder[`id:${active.id}`]).toEqual([
      'Projects/B.md',
      'Projects/A.md',
    ]);
    const notice = noticeContent as DocumentFragment;
    expect(notice.textContent).toContain('Could not save project view settings: disk full');
    expect(notice.querySelector('button')?.textContent).toBe('Retry');
  });

  it('opens an out-of-flow actual-card preview for a compact column and cleans it on Escape', () => {
    vi.useFakeTimers();
    const planned = expectDefined(DEFAULT_SETTINGS.projects.statuses[0]);
    const active = expectDefined(DEFAULT_SETTINGS.projects.statuses[1]);
    const source = project({
      frontmatter: { status: planned.name, start: '2026-09-01', end: '2026-09-30' },
      statusId: planned.id,
    });
    const { host, settings } = mountView([source]);
    settings.projects.kanban = buildDefaultProjectKanbanSettings(settings.projects.table);
    clickView(host, 'Kanban');
    const card = expectDefined(
      host.querySelector<HTMLElement>(
        '.abyss-project-kanban-card[data-project-path="Projects/A.md"]',
      ),
    );
    const target = expectDefined(
      host.querySelector<HTMLElement>(
        `.abyss-project-kanban-column[data-status-key="id:${active.id}"]`,
      ),
    );
    const data = transfer();
    card.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    card.dispatchEvent(dragEvent('dragstart', data));
    target.dispatchEvent(dragEvent('dragover', data));

    vi.advanceTimersByTime(450);

    const overlay = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-kanban-hover-preview'),
    );
    expect(overlay.textContent).toContain('A planning project');
    expect(card.parentElement?.closest('.abyss-project-kanban-hover-preview')).toBeNull();
    overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(host.querySelector('.abyss-project-kanban-hover-preview')).toBeNull();
    expect(host.querySelector('.is-dragging, .is-drop-target')).toBeNull();
  });

  it('opens a bounded preview with its forecast and follows the active vertical scroller', () => {
    vi.useFakeTimers();
    const planned = expectDefined(DEFAULT_SETTINGS.projects.statuses[0]);
    const active = expectDefined(DEFAULT_SETTINGS.projects.statuses[1]);
    const done = expectDefined(DEFAULT_SETTINGS.projects.statuses[2]);
    const source = project({
      path: 'Projects/A.md',
      frontmatter: { status: planned.name },
      statusId: planned.id,
    });
    const resident = project({
      path: 'Projects/B.md',
      name: 'B',
      frontmatter: { status: active.name },
      statusId: active.id,
    });
    const { host, settings } = mountView([source, resident]);
    settings.projects.kanban = buildDefaultProjectKanbanSettings(settings.projects.table);
    settings.projects.kanban.sortBy = { field: 'none', dir: 'asc' };
    clickView(host, 'Kanban');
    const boardRoot = expectDefined(host.querySelector<HTMLElement>('.abyss-project-kanban'));
    const board = expectDefined(host.querySelector<HTMLElement>('.abyss-project-kanban-scroll'));
    const sourceCard = expectDefined(
      host.querySelector<HTMLElement>(
        '.abyss-project-kanban-card[data-project-path="Projects/A.md"]',
      ),
    );
    const activeColumn = expectDefined(
      host.querySelector<HTMLElement>(
        `.abyss-project-kanban-column[data-status-key="id:${active.id}"]`,
      ),
    );
    const activeBody = expectDefined(
      activeColumn.querySelector<HTMLElement>('.abyss-project-kanban-column-body'),
    );
    const doneColumn = expectDefined(
      host.querySelector<HTMLElement>(
        `.abyss-project-kanban-column[data-status-key="id:${done.id}"]`,
      ),
    );
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this === boardRoot) return rectangle(20, 50, 340, 350);
      if (this === board) return rectangle(40, 100, 240, 300);
      if (this === activeBody) return rectangle(40, 100, 200, 200);
      if (this === doneColumn) return rectangle(220, 110, 264, 290);
      if (this.classList.contains('abyss-project-kanban-hover-body'))
        return rectangle(40, 120, 240, 200);
      return rectangle(0, 0, 0, 0);
    });
    const flushFrame = (): void => {
      const callback = frames.shift();
      callback?.(0);
    };
    activeBody.scrollTop = 10;
    const data = transfer();
    sourceCard.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    sourceCard.dispatchEvent(dragEvent('dragstart', data));
    activeBody.dispatchEvent(dragEvent('dragover', data, { clientX: 120, clientY: 195 }));
    flushFrame();
    expect(activeBody.scrollTop).toBeGreaterThan(10);

    doneColumn.dispatchEvent(dragEvent('dragover', data, { clientX: 230, clientY: 180 }));
    vi.advanceTimersByTime(450);

    const overlay = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-kanban-hover-preview'),
    );
    expect(overlay.querySelector('.abyss-project-kanban-insertion-line')).not.toBeNull();
    expect(overlay.style.left).toBe('20px');
    expect(overlay.style.top).toBe('60px');
    expect(overlay.style.maxWidth).toBe('200px');
    expect(overlay.style.maxHeight).toBe('190px');
    const overlayBody = expectDefined(
      overlay.querySelector<HTMLElement>('.abyss-project-kanban-hover-body'),
    );
    const activeAfterColumn = activeBody.scrollTop;
    overlayBody.scrollTop = 20;
    overlayBody.dispatchEvent(dragEvent('dragover', data, { clientX: 120, clientY: 195 }));
    flushFrame();
    expect(overlayBody.scrollTop).toBeGreaterThan(20);
    expect(activeBody.scrollTop).toBe(activeAfterColumn);
  });

  it('keeps a proposed group eligible and forecast-marked while hovering an empty rail', () => {
    vi.useFakeTimers();
    const sourceStatus = expectDefined(DEFAULT_SETTINGS.projects.statuses[0]);
    const targetStatus = expectDefined(DEFAULT_SETTINGS.projects.statuses[1]);
    const { host, settings, view } = mountView(
      [
        project({
          statusId: sourceStatus.id,
          frontmatter: { status: sourceStatus.name, Owners: ['Only'] },
        }),
      ],
      { catalog: catalog([{ name: 'Owners', type: 'list' }]) },
    );
    settings.projects.propertyDefinitions['property:Owners'] = { type: 'list' };
    settings.projects.kanban = buildDefaultProjectKanbanSettings(settings.projects.table);
    settings.projects.kanban.groupBy = 'property:Owners';
    settings.projects.kanban.sortBy = { field: 'none', dir: 'asc' };
    view.refreshFields();
    clickView(host, 'Kanban');
    const card = expectDefined(host.querySelector<HTMLElement>('.abyss-project-kanban-card'));
    const column = expectDefined(
      host.querySelector<HTMLElement>(
        `.abyss-project-kanban-column[data-status-key="id:${targetStatus.id}"]`,
      ),
    );
    const data = transfer();
    card.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    card.dispatchEvent(dragEvent('dragstart', data));
    column.dispatchEvent(dragEvent('dragover', data));
    vi.advanceTimersByTime(450);
    const overlay = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-kanban-hover-preview'),
    );
    const target = expectDefined(
      overlay.querySelector<HTMLElement>('.abyss-project-kanban-hover-card'),
    );

    target.dispatchEvent(dragEvent('dragover', data));
    expect(
      target.closest('.abyss-project-kanban-hover-group')?.classList.contains('is-drop-disabled'),
    ).toBe(false);
    column.dispatchEvent(dragEvent('dragover', data));
    expect(overlay.querySelector('.abyss-project-kanban-insertion-line')).not.toBeNull();
  });

  it('positions initial and sustained rail forecasts in the scrolled destination group', () => {
    vi.useFakeTimers();
    const sourceStatus = expectDefined(DEFAULT_SETTINGS.projects.statuses[0]);
    const targetStatus = expectDefined(DEFAULT_SETTINGS.projects.statuses[1]);
    const moving = project({
      statusId: sourceStatus.id,
      frontmatter: { status: sourceStatus.name, Owners: ['Maria'] },
    });
    const boris = project({
      path: 'Projects/B.md',
      name: 'B',
      statusId: targetStatus.id,
      frontmatter: { status: targetStatus.name, Owners: ['Boris'] },
    });
    const maria = project({
      path: 'Projects/C.md',
      name: 'C',
      statusId: targetStatus.id,
      frontmatter: { status: targetStatus.name, Owners: ['Maria'] },
    });
    const { host, settings, view } = mountView([moving, boris, maria], {
      catalog: catalog([{ name: 'Owners', type: 'list' }]),
    });
    settings.projects.propertyDefinitions['property:Owners'] = { type: 'list' };
    settings.projects.kanban = buildDefaultProjectKanbanSettings(settings.projects.table);
    settings.projects.kanban.groupBy = 'property:Owners';
    settings.projects.kanban.sortBy = { field: 'none', dir: 'asc' };
    settings.projects.kanban.collapsedColumns = [`id:${targetStatus.id}`];
    view.refreshFields();
    clickView(host, 'Kanban');
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const scrollTop =
        host.querySelector<HTMLElement>('.abyss-project-kanban-hover-body')?.scrollTop ?? 0;
      if (this.matches('.abyss-project-kanban-hover-preview')) return rectangle(0, 100, 272, 500);
      if (this.matches('[data-group-key="value:boris"].abyss-project-kanban-hover-group'))
        return rectangle(0, 140 - scrollTop, 272, 230 - scrollTop);
      if (this.matches('[data-group-key="value:maria"].abyss-project-kanban-hover-group'))
        return rectangle(0, 260 - scrollTop, 272, 420 - scrollTop);
      if (this.matches('[data-project-path="Projects/C.md"].abyss-project-kanban-hover-card'))
        return rectangle(4, 300 - scrollTop, 268, 330 - scrollTop);
      return rectangle(0, 0, 1000, 700);
    });
    const card = expectDefined(
      host.querySelector<HTMLElement>(
        '.abyss-project-kanban-card[data-project-path="Projects/A.md"]',
      ),
    );
    const column = expectDefined(
      host.querySelector<HTMLElement>(
        `.abyss-project-kanban-column[data-status-key="id:${targetStatus.id}"]`,
      ),
    );
    const data = transfer();
    card.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    card.dispatchEvent(dragEvent('dragstart', data));
    column.dispatchEvent(dragEvent('dragover', data));
    vi.advanceTimersByTime(450);

    const overlay = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-kanban-hover-preview'),
    );
    expect(overlay.querySelectorAll('.abyss-project-kanban-hover-group')).toHaveLength(2);
    const group = expectDefined(
      overlay.querySelector<HTMLElement>(
        '[data-group-key="value:maria"].abyss-project-kanban-hover-group',
      ),
    );
    let marker = expectDefined(
      group.querySelector<HTMLElement>('.abyss-project-kanban-insertion-line'),
    );
    expect(marker.parentElement).toBe(group);
    expect(marker.style.getPropertyValue('--abyss-project-kanban-insertion-top')).toBe('70px');

    expectDefined(
      overlay.querySelector<HTMLElement>('.abyss-project-kanban-hover-body'),
    ).scrollTop = 30;
    column.dispatchEvent(dragEvent('dragover', data));
    marker = expectDefined(
      group.querySelector<HTMLElement>('.abyss-project-kanban-insertion-line'),
    );
    expect(marker.parentElement).toBe(group);
    expect(marker.style.getPropertyValue('--abyss-project-kanban-insertion-top')).toBe('70px');
  });

  it('restores focus to the exact destination occurrence after a list-group move', async () => {
    const status = expectDefined(DEFAULT_SETTINGS.projects.statuses[0]);
    const moving = project({
      path: 'Projects/A.md',
      statusId: status.id,
      frontmatter: { status: status.name, Owners: ['A', 'B'] },
    });
    const targetProject = project({
      path: 'Projects/B.md',
      name: 'B',
      statusId: status.id,
      frontmatter: { status: status.name, Owners: ['C'] },
    });
    const { host, settings, view } = mountView([moving, targetProject], {
      catalog: catalog([{ name: 'Owners', type: 'list' }]),
    });
    settings.projects.propertyDefinitions['property:Owners'] = { type: 'list' };
    settings.projects.kanban = buildDefaultProjectKanbanSettings(settings.projects.table);
    settings.projects.kanban.groupBy = 'property:Owners';
    settings.projects.kanban.sortBy = { field: 'none', dir: 'asc' };
    view.refreshFields();
    clickView(host, 'Kanban');
    const source = expectDefined(
      host.querySelector<HTMLElement>('[data-group-key="value:a"] .abyss-project-kanban-card'),
    );
    const target = expectDefined(
      host.querySelector<HTMLElement>('[data-group-key="value:c"] .abyss-project-kanban-card'),
    );
    source.focus();
    const data = transfer();
    source.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    source.dispatchEvent(dragEvent('dragstart', data));

    target.dispatchEvent(dragEvent('drop', data));
    await flushMicrotasks();

    expect(view.selectedProjectPath()).toBe('Projects/A.md');
    expect(
      activeDocument.activeElement?.closest('[data-group-key]')?.getAttribute('data-group-key'),
    ).toBe('value:c');
  });

  it('forecasts a new inner group at its actual group boundary', () => {
    const planned = expectDefined(DEFAULT_SETTINGS.projects.statuses[0]);
    const active = expectDefined(DEFAULT_SETTINGS.projects.statuses[1]);
    const source = project({
      path: 'Projects/A.md',
      frontmatter: { status: planned.name, Owners: ['P1'] },
      statusId: planned.id,
    });
    const targetProject = project({
      path: 'Projects/B.md',
      name: 'B',
      frontmatter: { status: active.name, Owners: ['P2'] },
      statusId: active.id,
    });
    const { host, settings } = mountView([source, targetProject], {
      catalog: catalog([{ name: 'Owners', type: 'list' }]),
    });
    settings.projects.propertyDefinitions['property:Owners'] = { type: 'list' };
    settings.projects.kanban = buildDefaultProjectKanbanSettings(settings.projects.table);
    settings.projects.kanban.groupBy = 'property:Owners';
    settings.projects.kanban.sortBy = { field: 'none', dir: 'asc' };
    clickView(host, 'Kanban');
    const card = expectDefined(
      host.querySelector<HTMLElement>(
        '.abyss-project-kanban-card[data-project-path="Projects/A.md"]',
      ),
    );
    const target = expectDefined(
      host.querySelector<HTMLElement>(
        `.abyss-project-kanban-column[data-status-key="id:${active.id}"]`,
      ),
    );
    const existingGroup = expectDefined(
      target.querySelector<HTMLElement>('[data-group-key="value:p2"]'),
    );
    const data = transfer();
    card.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    card.dispatchEvent(dragEvent('dragstart', data));
    target.dispatchEvent(dragEvent('dragover', data));

    const line = expectDefined(
      target.querySelector<HTMLElement>('.abyss-project-kanban-insertion-line'),
    );
    expect(line.nextElementSibling).toBe(existingGroup);
  });

  it('mounts the New project input outside the hidden table surface while on the board', () => {
    const { host } = mountView();
    clickView(host, 'Kanban');

    expectDefined(host.querySelector<HTMLButtonElement>('.abyss-projects-new')).click();

    const input = expectDefined(
      host.querySelector<HTMLInputElement>('.abyss-project-creation-name'),
    );
    expect(input.closest('[hidden]')).toBeNull();
    expect(activeDocument.activeElement).toBe(input);
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

  it('reuses a hidden description cell with the latest immutable project snapshot', async () => {
    const initial = project({
      frontmatter: {
        start: '2026-09-01',
        end: '2026-09-30',
        description: 'Original description',
      },
    });
    const { host, view, settings, applyEdits } = mountView([initial]);
    const kanban = buildDefaultProjectKanbanSettings(settings.projects.table);
    settings.projects.kanban = kanban;
    settings.projects.overviewView = 'kanban';
    view.refreshFields();
    const description = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-kanban-description'),
    );
    const content = expectDefined(
      description.querySelector<HTMLElement>('.abyss-project-kanban-description-content'),
    );

    kanban.descriptionLines = 0;
    view.refreshFields();
    expect(description.hidden).toBe(true);
    expect(content.isConnected).toBe(true);

    const updated = {
      ...initial,
      frontmatter: { ...initial.frontmatter, description: 'Current description' },
    };
    view.update([updated]);
    kanban.descriptionLines = 'full';
    view.refreshFields();
    expect(description.hidden).toBe(false);
    expect(description.querySelector('.abyss-project-kanban-description-content')).toBe(content);
    expect(content.textContent).toContain('Current description');

    const dblclick = new MouseEvent('dblclick', { bubbles: true });
    const preventDefault = vi.spyOn(dblclick, 'preventDefault');
    content.dispatchEvent(dblclick);
    expect(preventDefault).toHaveBeenCalledOnce();
    const textarea = expectDefined(content.querySelector<HTMLTextAreaElement>('textarea'));
    expect(textarea.value).toBe('Current description');
    textarea.value = 'Edited current description';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    await flushMicrotasks();

    expect(applyEdits).toHaveBeenCalledOnce();
    expect(expectDefined(applyEdits.mock.calls[0])[0][0]).toMatchObject({
      path: 'Projects/A.md',
      value: 'Edited current description',
      expectedValue: 'Current description',
    });
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

  it('keeps metadata selection on the clicked field and derives capture from keyboard movement', () => {
    const a = project();
    const b = project({ path: 'Projects/B.md', name: 'B project' });
    const { host, view } = mountView([a, b]);
    clickView(host, 'Kanban');
    const aStart = expectDefined(
      host.querySelector<HTMLElement>(
        '.abyss-project-kanban-card[data-project-path="Projects/A.md"] [data-column-id="start"]',
      ),
    );
    const aName = expectDefined(
      host.querySelector<HTMLElement>(
        '.abyss-project-kanban-card[data-project-path="Projects/A.md"] [data-column-id="name"]',
      ),
    );

    aStart.click();

    expect(aStart.getAttribute('aria-selected')).toBe('true');
    expect(aName.getAttribute('aria-selected')).toBe('false');

    const board = expectDefined(host.querySelector<HTMLElement>('.abyss-project-kanban-scroll'));
    const body = expectDefined(aStart.closest<HTMLElement>('.abyss-project-kanban-column-body'));
    const header = expectDefined(
      aStart
        .closest<HTMLElement>('.abyss-project-kanban-column')
        ?.querySelector<HTMLElement>('.abyss-project-kanban-column-header'),
    );
    const bStart = expectDefined(
      host.querySelector<HTMLElement>(
        '.abyss-project-kanban-card[data-project-path="Projects/B.md"] [data-column-id="start"]',
      ),
    );
    Object.defineProperties(board, {
      clientHeight: { configurable: true, value: 200 },
      clientWidth: { configurable: true, value: 300 },
    });
    Object.defineProperties(body, {
      clientHeight: { configurable: true, value: 160 },
      clientWidth: { configurable: true, value: 272 },
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this === board) return rectangle(40, 100, 340, 300);
      if (this === body) return rectangle(40, 140, 312, 300);
      if (this === header) return rectangle(40, 100, 312, 140);
      if (this === aStart) return rectangle(80, 170, 240, 204);
      if (this === bStart) return rectangle(80, 330, 240, 364);
      return rectangle(0, 0, 0, 0);
    });
    board.scrollTop = 7;
    body.scrollTop = 11;
    aStart.focus();

    aStart.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));

    expect(activeDocument.activeElement).toBe(bStart);
    expect(view.selectedProjectPath()).toBe('Projects/B.md');
    expect(bStart.closest('.abyss-project-kanban-card')?.classList.contains('is-selected')).toBe(
      true,
    );
    expect(body.scrollTop).toBeGreaterThan(11);
    expect(board.scrollTop).toBe(7);
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

  it('presents creation after a card drag releases deferred reconciliation', async () => {
    let finishCreate: ((path: string) => void) | undefined;
    const createProject = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finishCreate = resolve;
        }),
    );
    const finalStatus = expectDefined(DEFAULT_SETTINGS.projects.statuses[0]);
    const intermediateStatus = expectDefined(DEFAULT_SETTINGS.projects.statuses[1]);
    const existing = project();
    const intermediate = project({
      path: 'Projects/After drag.md',
      name: 'After drag',
      statusId: intermediateStatus.id,
    });
    const created = { ...intermediate, statusId: finalStatus.id };
    const { host, view, settings } = mountView([existing], { createProject });
    settings.projects.kanban = buildDefaultProjectKanbanSettings(settings.projects.table);
    clickView(host, 'Kanban');
    const create = expectDefined(
      host.querySelector<HTMLButtonElement>(
        `.abyss-project-kanban-column[data-status-key="id:${finalStatus.id}"] .abyss-project-kanban-column-create`,
      ),
    );
    create.click();
    const composer = expectDefined(
      host.querySelector<HTMLInputElement>('.abyss-project-creation-name'),
    );
    composer.value = created.name;
    composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    view.update([existing, intermediate]);
    const card = expectDefined(
      host.querySelector<HTMLElement>(
        '.abyss-project-kanban-card[data-project-path="Projects/A.md"]',
      ),
    );
    const title = expectDefined(card.querySelector<HTMLButtonElement>('.abyss-project-table-name'));
    const data = transfer();
    title.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    title.dispatchEvent(dragEvent('dragstart', data));
    view.update([existing, created]);
    finishCreate?.(created.path);
    await flushMicrotasks();
    expect(host.querySelector('[data-project-path="Projects/After drag.md"]')).not.toBeNull();
    expect(host.querySelector('.is-just-created')).toBeNull();
    expect(card.classList).toContain('is-dragging');

    card.dispatchEvent(dragEvent('dragend', data));

    expect(host.querySelector('[data-project-path="Projects/After drag.md"]')?.classList).toContain(
      'is-just-created',
    );
    expect(host.querySelector('.abyss-project-table-feedback')?.textContent).toBe('');
  });

  it('moves board focus to a surviving card and then the board when projects disappear', () => {
    const first = project();
    const second = project({ path: 'Projects/B.md', name: 'B project' });
    const { host, view } = mountView([first, second]);
    clickView(host, 'Kanban');
    const firstCard = expectDefined(
      host.querySelector<HTMLElement>(
        '.abyss-project-kanban-card[data-project-path="Projects/A.md"]',
      ),
    );
    firstCard.focus();

    view.update([second]);

    expect(
      activeDocument.activeElement?.closest<HTMLElement>('.abyss-project-kanban-card')?.dataset[
        'projectPath'
      ],
    ).toBe('Projects/B.md');

    view.update([]);

    const board = expectDefined(host.querySelector<HTMLElement>('.abyss-project-kanban'));
    expect(board.contains(activeDocument.activeElement)).toBe(true);
    expect(activeDocument.activeElement).toBe(
      host.querySelector<HTMLElement>('.abyss-project-kanban-scroll'),
    );
  });

  it('returns collapsed card focus to the board without stealing search or external focus', () => {
    const status = expectDefined(DEFAULT_SETTINGS.projects.statuses[0]);
    const { host, view, settings } = mountView();
    clickView(host, 'Kanban');
    const start = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-kanban-card [data-column-id="start"]'),
    );
    start.focus();
    const kanban = expectDefined(settings.projects.kanban);
    kanban.collapsedColumns = [`id:${status.id}`];

    view.refreshFields();

    expect(activeDocument.activeElement).toBe(
      host.querySelector<HTMLElement>('.abyss-project-kanban-scroll'),
    );

    const search = expectDefined(host.querySelector<HTMLInputElement>('.abyss-center-search'));
    search.focus();
    view.update([]);
    expect(activeDocument.activeElement).toBe(search);

    const outside = activeDocument.body.createEl('button', { attr: { type: 'button' } });
    outside.focus();
    view.update([project()]);
    expect(activeDocument.activeElement).toBe(outside);
  });

  it('reveals a moved card through its destination column on the first update', () => {
    const sourceStatus = expectDefined(DEFAULT_SETTINGS.projects.statuses[0]);
    const destinationStatus = expectDefined(DEFAULT_SETTINGS.projects.statuses[1]);
    const moving = project({
      path: 'Projects/Z.md',
      name: 'Z project',
      statusId: sourceStatus.id,
      frontmatter: { start: '2026-09-02', end: '2026-09-30' },
    });
    const preceding = project({
      path: 'Projects/B.md',
      name: 'B project',
      statusId: destinationStatus.id,
      frontmatter: { start: '2026-09-01', end: '2026-09-30' },
    });
    const { host, view } = mountView([moving, preceding]);
    clickView(host, 'Kanban');
    const sourceBody = expectDefined(
      host.querySelector<HTMLElement>(
        `.abyss-project-kanban-column[data-status-key="id:${sourceStatus.id}"] .abyss-project-kanban-column-body`,
      ),
    );
    const destinationBody = expectDefined(
      host.querySelector<HTMLElement>(
        `.abyss-project-kanban-column[data-status-key="id:${destinationStatus.id}"] .abyss-project-kanban-column-body`,
      ),
    );

    view.update([{ ...moving, statusId: destinationStatus.id }, preceding]);

    const precedingStart = expectDefined(
      host.querySelector<HTMLElement>(
        '.abyss-project-kanban-card[data-project-path="Projects/B.md"] [data-column-id="start"]',
      ),
    );
    const movedStart = expectDefined(
      host.querySelector<HTMLElement>(
        '.abyss-project-kanban-card[data-project-path="Projects/Z.md"] [data-column-id="start"]',
      ),
    );
    const board = expectDefined(host.querySelector<HTMLElement>('.abyss-project-kanban-scroll'));
    const destinationHeader = expectDefined(
      destinationBody.parentElement?.querySelector<HTMLElement>(
        '.abyss-project-kanban-column-header',
      ),
    );
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this === board) return rectangle(40, 100, 340, 300);
      if (this === sourceBody) return rectangle(360, 140, 632, 300);
      if (this === destinationBody) return rectangle(40, 140, 312, 300);
      if (this === destinationHeader) return rectangle(40, 100, 312, 140);
      if (this === precedingStart) return rectangle(80, 170, 240, 204);
      if (this === movedStart) return rectangle(80, 330, 240, 364);
      return rectangle(0, 0, 0, 0);
    });
    sourceBody.scrollTop = 13;
    destinationBody.scrollTop = 17;
    precedingStart.focus();

    precedingStart.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));

    expect(activeDocument.activeElement).toBe(movedStart);
    expect(destinationBody.scrollTop).toBeGreaterThan(17);
    expect(sourceBody.scrollTop).toBe(13);
  });

  it('guards group collapse and board option mutations behind a rejected editor', async () => {
    const rejected: ProjectEditResult = {
      applied: [],
      failed: [{ path: 'Projects/A.md', message: 'Source changed' }],
    };
    const applyEdits = vi.fn().mockResolvedValue(rejected);
    const { host, settings } = mountView(undefined, {
      applyEdits,
      history: new ProjectEditHistory(applyEdits),
    });
    settings.projects.kanban = buildDefaultProjectKanbanSettings(settings.projects.table);
    settings.projects.kanban.groupBy = 'property:Budget';
    clickView(host, 'Kanban');
    const start = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-kanban [data-column-id="start"]'),
    );
    start.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const input = expectDefined(start.querySelector<HTMLInputElement>('input[type="date"]'));
    input.value = '2026-10-02';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const groupHeader = expectDefined(
      host.querySelector<HTMLButtonElement>('.abyss-project-kanban-group-header'),
    );
    const groupBody = expectDefined(groupHeader.nextElementSibling as HTMLElement | null);

    groupHeader.click();
    expectDefined(host.querySelector<HTMLButtonElement>('.abyss-view-state-btn')).click();
    const popover = expectDefined(host.querySelector<HTMLElement>('.abyss-view-state-popover'));
    chooseViewOption(host, 'Description', '2 lines');
    await flushMicrotasks();

    expect(groupBody.hidden).toBe(false);
    expect(settings.projects.kanban.descriptionLines).toBe(1);
    expect(input.isConnected).toBe(true);
    expect(host.querySelector('.abyss-view-state-popover')).toBe(popover);
    expect(
      Array.from(
        viewOptionRow(popover, 'Description').querySelectorAll<HTMLButtonElement>(
          '.abyss-view-state-option',
        ),
      )
        .find(
          (button) =>
            button.querySelector('.abyss-view-state-option-label')?.textContent === '1 line',
        )
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('excludes collapsed group cells from selection and renders structured group content', async () => {
    vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, markdown, holder) => {
      const anchor = holder.createEl('a', { cls: 'internal-link', text: markdown });
      anchor.setAttribute('data-href', 'People/Owner');
    });
    const a = project({
      frontmatter: {
        start: '2026-09-01',
        end: '2026-09-30',
        description: 'A concise project description',
        Budget: 42,
        Lead: '[[People/Owner]]',
      },
    });
    const { host, view, settings } = mountView([a], {
      catalog: catalog([{ name: 'Lead', type: 'text' }]),
    });
    settings.projects.propertyDefinitions['property:Lead'] = {
      type: 'text',
      presets: [
        {
          value: '[[People/Owner]]',
          displayName: 'Lead alias',
          display: 'dot',
          color: '#123456',
        },
      ],
    };
    settings.projects.kanban = buildDefaultProjectKanbanSettings(settings.projects.table);
    settings.projects.kanban.groupBy = 'property:Lead';
    clickView(host, 'Kanban');
    await flushMicrotasks();
    const header = expectDefined(
      host.querySelector<HTMLButtonElement>('.abyss-project-kanban-group-header'),
    );
    const label = expectDefined(header.querySelector<HTMLElement>('.abyss-projects-group-label'));
    expect(label.querySelector('a.internal-link')?.textContent).toBe('Lead alias');
    expect(header.querySelector('.abyss-projects-group-count')?.textContent).toBe('1');
    expect(header.querySelectorAll('.abyss-status-dot')).toHaveLength(1);
    const start = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-kanban [data-column-id="start"]'),
    );
    start.focus();
    expect(view.selectedProjectPath()).toBe('Projects/A.md');

    header.click();
    await flushMicrotasks();

    expect(expectDefined(header.nextElementSibling as HTMLElement | null).hidden).toBe(true);
    expect(view.selectedProjectPath()).toBeUndefined();
  });

  it('excludes retained cells from selection when their status column is collapsed', async () => {
    const { host, view } = mountView();
    clickView(host, 'Kanban');
    const start = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-kanban [data-column-id="start"]'),
    );
    const column = expectDefined(start.closest<HTMLElement>('.abyss-project-kanban-column'));
    start.focus();
    expect(view.selectedProjectPath()).toBe('Projects/A.md');

    expectDefined(
      column.querySelector<HTMLButtonElement>('.abyss-project-kanban-column-toggle'),
    ).click();
    await flushMicrotasks();

    expect(column.classList.contains('is-collapsed')).toBe(true);
    expect(start.isConnected).toBe(true);
    expect(view.selectedProjectPath()).toBeUndefined();
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

  it('moves table and Kanban fields through adjacent visible rows while retaining hidden fields', async () => {
    const { host, settings } = mountView();
    const hiddenStart = expectDefined(
      settings.projects.table.columns.find(({ id }) => id === 'start'),
    );
    hiddenStart.visible = false;
    settings.projects.kanban = buildDefaultProjectKanbanSettings(settings.projects.table);

    expectDefined(host.querySelector<HTMLButtonElement>('.abyss-view-state-btn')).click();
    const table = expectDefined(directViewOptionRows(host)[2]);
    expectDefined(
      table.querySelector<HTMLButtonElement>(':scope > .abyss-view-state-row-main'),
    ).click();
    const columns = viewOptionRow(table, 'Columns');
    expectDefined(
      columns.querySelector<HTMLButtonElement>(':scope > .abyss-view-state-row-main'),
    ).click();
    expectDefined(
      columns.querySelector<HTMLButtonElement>('[aria-label="Move Progress down"]'),
    ).click();
    await flushMicrotasks();

    expect(
      settings.projects.table.columns.filter(({ visible }) => visible).map(({ id }) => id),
    ).toEqual(['name', 'status', 'end', 'progress']);
    expect(hiddenStart.visible).toBe(false);

    expectDefined(host.querySelector<HTMLButtonElement>('.abyss-view-state-btn')).click();
    settings.projects.kanban.fields = [
      { id: 'property:Budget', visible: true },
      { id: 'start', visible: false },
      { id: 'property:Flag', visible: true },
    ];
    clickView(host, 'Kanban');
    expectDefined(host.querySelector<HTMLButtonElement>('.abyss-view-state-btn')).click();
    const kanban = expectDefined(directViewOptionRows(host)[2]);
    expectDefined(
      kanban.querySelector<HTMLButtonElement>(':scope > .abyss-view-state-row-main'),
    ).click();
    const cardFields = viewOptionRow(kanban, 'Card fields');
    expectDefined(
      cardFields.querySelector<HTMLButtonElement>(':scope > .abyss-view-state-row-main'),
    ).click();
    expectDefined(
      cardFields.querySelector<HTMLButtonElement>('[aria-label="Move Budget down"]'),
    ).click();
    await flushMicrotasks();

    expect(
      settings.projects.kanban.fields.filter(({ visible }) => visible).map(({ id }) => id),
    ).toEqual(['property:Flag', 'property:Budget']);
    expect(settings.projects.kanban.fields.find(({ id }) => id === 'start')?.visible).toBe(false);
  });

  it('keeps table Name mandatory while toggling and reordering columns in place', async () => {
    const { host, settings } = mountView();
    expectDefined(host.querySelector<HTMLButtonElement>('.abyss-view-state-btn')).click();
    const roots = directViewOptionRows(host);
    expect(
      roots.map((row) =>
        row
          .querySelector(':scope > .abyss-view-state-row-main .abyss-view-state-row-label')
          ?.textContent.trim(),
      ),
    ).toEqual(['Group by', 'Sort by', 'Table']);
    const table = expectDefined(roots[2]);
    expectDefined(
      table.querySelector<HTMLButtonElement>(':scope > .abyss-view-state-row-main'),
    ).click();
    const columns = viewOptionRow(table, 'Columns');
    expectDefined(
      columns.querySelector<HTMLButtonElement>(':scope > .abyss-view-state-row-main'),
    ).click();
    const name = optionRow(columns, 'Name');
    const nameToggle = expectDefined(
      name.querySelector<HTMLButtonElement>('.abyss-view-state-option'),
    );

    expect(nameToggle.disabled).toBe(true);
    expect(name.querySelector('.abyss-view-state-option-required')?.textContent).toBe('Required');
    expect(name.querySelector('[aria-label^="Move Name "]')).toBeNull();
    const status = optionRow(columns, 'Status');
    expectDefined(status.querySelector<HTMLButtonElement>('.abyss-view-state-option')).click();
    await flushMicrotasks();
    expect(settings.projects.table.columns.find(({ id }) => id === 'status')?.visible).toBe(false);

    const moveEnd = expectDefined(
      columns.querySelector<HTMLButtonElement>('[aria-label="Move End up"]'),
    );
    const popover = expectDefined(host.querySelector<HTMLElement>('.abyss-view-state-popover'));
    popover.scrollTop = 180;
    const optionsHost = expectDefined(moveEnd.closest<HTMLElement>('.abyss-view-state-options'));
    const nativeAppend = optionsHost.append.bind(optionsHost);
    vi.spyOn(optionsHost, 'append').mockImplementation((...nodes: Array<Node | string>) => {
      if (nodes.some((node) => node instanceof Node && node.isConnected)) popover.scrollTop = 0;
      nativeAppend(...nodes);
    });
    moveEnd.focus();
    moveEnd.click();
    await flushMicrotasks();
    expect(settings.projects.table.columns.map(({ id }) => id)).toEqual([
      'name',
      'status',
      'progress',
      'end',
      'start',
    ]);
    expect(popover.scrollTop).toBe(180);
    expect(activeDocument.activeElement).toBe(moveEnd);
    expect(activeDocument.activeElement?.getAttribute('aria-label')).toBe('Move End up');
  });

  it('keeps nested date menus owned through DOM selection, cancellation, and dismissal', async () => {
    const { host, settings } = mountView();
    settings.projects.kanban = buildDefaultProjectKanbanSettings(settings.projects.table);
    const show = renderShownMenuInDocument();
    const closeMenus = vi.spyOn(Menu.prototype, 'close');

    expectDefined(host.querySelector<HTMLButtonElement>('.abyss-view-state-btn')).click();
    await flushMicrotasks();
    const table = expectDefined(directViewOptionRows(host)[2]);
    expectDefined(
      table.querySelector<HTMLButtonElement>(':scope > .abyss-view-state-row-main'),
    ).click();
    const columns = viewOptionRow(table, 'Columns');
    expectDefined(
      columns.querySelector<HTMLButtonElement>(':scope > .abyss-view-state-row-main'),
    ).click();
    const tableStart = optionRow(columns, 'Start');
    const tableStartToggle = expectDefined(
      tableStart.querySelector<HTMLButtonElement>('.abyss-view-state-option'),
    );
    const tableStartAction = expectDefined(
      tableStart.querySelector<HTMLButtonElement>('.abyss-view-state-option-action'),
    );

    expect(tableStartToggle.getAttribute('aria-pressed')).toBe('true');
    for (const [label, display] of [
      ['Raw', 'raw'],
      ['Relative', 'relative'],
      ['Pretty', 'pretty'],
    ] as const) {
      tableStartAction.click();
      const menu = lastShownMenu(show);
      expect(menuItems(menu).map(({ title__ }) => title__)).toEqual(['Pretty', 'Raw', 'Relative']);
      clickRenderedMenuItem(menu, label);
      await flushMicrotasks();
      expect(settings.projects.table.columns.find(({ id }) => id === 'start')?.dateDisplay).toBe(
        display,
      );
      expect(host.querySelector('.abyss-view-state-popover')).not.toBeNull();
      expect(
        table.querySelector(':scope > .abyss-view-state-row-main')?.getAttribute('aria-expanded'),
      ).toBe('true');
      expect(
        columns.querySelector(':scope > .abyss-view-state-row-main')?.getAttribute('aria-expanded'),
      ).toBe('true');
      expect(activeDocument.activeElement).toBe(tableStartAction);
    }
    expect(
      settings.projects.kanban.fields.find(({ id }) => id === 'start')?.dateDisplay,
    ).toBeUndefined();

    tableStartAction.click();
    let menu = lastShownMenu(show);
    menu.close();
    menuDom(menu).remove();
    expect(activeDocument.activeElement).toBe(tableStartAction);
    activeDocument.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(host.querySelector('.abyss-view-state-popover')).toBeNull();

    clickView(host, 'Kanban');
    expectDefined(host.querySelector<HTMLButtonElement>('.abyss-view-state-btn')).click();
    await flushMicrotasks();
    const kanban = expectDefined(directViewOptionRows(host)[2]);
    expectDefined(
      kanban.querySelector<HTMLButtonElement>(':scope > .abyss-view-state-row-main'),
    ).click();
    const cardFields = viewOptionRow(kanban, 'Card fields');
    expectDefined(
      cardFields.querySelector<HTMLButtonElement>(':scope > .abyss-view-state-row-main'),
    ).click();
    const boardStart = optionRow(cardFields, 'Start');
    const boardStartToggle = expectDefined(
      boardStart.querySelector<HTMLButtonElement>('.abyss-view-state-option'),
    );
    const boardStartAction = expectDefined(
      boardStart.querySelector<HTMLButtonElement>('.abyss-view-state-option-action'),
    );
    expect(boardStartToggle.getAttribute('aria-pressed')).toBe('true');
    for (const [label, display] of [
      ['Raw', 'raw'],
      ['Relative', 'relative'],
      ['Pretty', 'pretty'],
    ] as const) {
      boardStartAction.click();
      menu = lastShownMenu(show);
      clickRenderedMenuItem(menu, label);
      await flushMicrotasks();
      expect(settings.projects.kanban.fields.find(({ id }) => id === 'start')?.dateDisplay).toBe(
        display,
      );
      expect(host.querySelector('.abyss-view-state-popover')).not.toBeNull();
      expect(activeDocument.activeElement).toBe(boardStartAction);
    }
    expect(settings.projects.table.columns.find(({ id }) => id === 'start')?.dateDisplay).toBe(
      'pretty',
    );

    boardStartAction.click();
    menu = lastShownMenu(show);
    menu.close();
    menuDom(menu).remove();
    expect(activeDocument.activeElement).toBe(boardStartAction);
    expectDefined(host.querySelector<HTMLElement>('.abyss-view-state-popover')).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(host.querySelector('.abyss-view-state-popover')).toBeNull();
    expect(activeDocument.activeElement).toBe(
      host.querySelector<HTMLButtonElement>('.abyss-view-state-btn'),
    );

    const viewOptions = expectDefined(
      host.querySelector<HTMLButtonElement>('.abyss-view-state-btn'),
    );
    viewOptions.click();
    const reopenedKanban = expectDefined(directViewOptionRows(host)[2]);
    expectDefined(
      reopenedKanban.querySelector<HTMLButtonElement>(':scope > .abyss-view-state-row-main'),
    ).click();
    const reopenedFields = viewOptionRow(reopenedKanban, 'Card fields');
    expectDefined(
      reopenedFields.querySelector<HTMLButtonElement>(':scope > .abyss-view-state-row-main'),
    ).click();
    expectDefined(
      optionRow(reopenedFields, 'Start').querySelector<HTMLButtonElement>(
        '.abyss-view-state-option-action',
      ),
    ).click();
    const closesBeforeParentTeardown = closeMenus.mock.calls.length;

    viewOptions.click();

    expect(host.querySelector('.abyss-view-state-popover')).toBeNull();
    expect(closeMenus).toHaveBeenCalledTimes(closesBeforeParentTeardown + 1);
  });

  it('shows the full description without retaining a line clamp', async () => {
    const description = 'First line\nSecond line\nThird line';
    const { host, settings } = mountView([project({ frontmatter: { description } })]);
    clickView(host, 'Kanban');

    chooseViewOption(host, 'Description', 'Full');
    await flushMicrotasks();

    expect(settings.projects.kanban?.descriptionLines).toBe('full');
    const rendered = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-kanban-description'),
    );
    expect(rendered.hidden).toBe(false);
    expect(rendered.classList.contains('is-full')).toBe(true);
    expect(rendered.style.getPropertyValue('--abyss-project-description-lines')).toBe('');
  });

  it('updates open card-field controls and retains detached presentation while hidden', async () => {
    const { host, settings } = mountView();
    settings.projects.table.columns.push({
      id: 'property:Budget',
      label: 'Table cost',
      visible: false,
    });
    settings.projects.kanban = buildDefaultProjectKanbanSettings(settings.projects.table);
    settings.projects.kanban.fields = [
      { id: 'start', visible: true },
      { id: 'end', visible: true },
      { id: 'property:Budget', label: 'Board cost', visible: true },
    ];
    clickView(host, 'Kanban');
    expectDefined(host.querySelector<HTMLButtonElement>('.abyss-view-state-btn')).click();
    const row = viewOptionRow(host, 'Card fields');
    expectDefined(row.querySelector<HTMLButtonElement>('.abyss-view-state-row-main')).click();
    const budget = expectDefined(
      Array.from(row.querySelectorAll<HTMLButtonElement>('.abyss-view-state-option')).find(
        (button) =>
          button.querySelector('.abyss-view-state-option-label')?.textContent === 'Board cost',
      ),
    );

    budget.click();
    await flushMicrotasks();

    expect(budget.getAttribute('aria-pressed')).toBe('false');
    expect(row.querySelector('.abyss-view-state-row-value')?.textContent).toBe('2 shown');
    const configured = expectDefined(
      settings.projects.kanban.fields.find(({ id }) => id === 'property:Budget'),
    );
    expect(configured).toMatchObject({ label: 'Board cost', visible: false });
    expectDefined(
      settings.projects.table.columns.find(({ id }) => id === 'property:Budget'),
    ).label = 'Updated table cost';

    budget.click();
    await flushMicrotasks();

    expect(budget.getAttribute('aria-pressed')).toBe('true');
    expect(row.querySelector('.abyss-view-state-row-value')?.textContent).toBe('3 shown');
    expect(configured).toMatchObject({ label: 'Board cost', visible: true });
    const moveEnd = expectDefined(
      row.querySelector<HTMLButtonElement>('[aria-label="Move End up"]'),
    );
    moveEnd.focus();
    moveEnd.click();
    await flushMicrotasks();
    const selectedLabels = Array.from(
      row.querySelectorAll<HTMLElement>('.abyss-view-state-option-row'),
    ).flatMap((optionRow) =>
      optionRow.querySelector('.abyss-view-state-option')?.getAttribute('aria-pressed') === 'true'
        ? [optionRow.querySelector('.abyss-view-state-option-label')?.textContent]
        : [],
    );
    expect(selectedLabels.slice(0, 3)).toEqual(['End', 'Start', 'Board cost']);
    expect(activeDocument.activeElement?.getAttribute('aria-label')).toBe('Move End up');
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

  it('renders card dates as Pretty by default and preserves explicit Raw values', () => {
    const startRaw = '2026-09-10';
    const endRaw = '2026-09-11T00:30:00-10:00';
    const { host, settings } = mountView([
      project({ frontmatter: { start: startRaw, end: endRaw } }),
    ]);
    settings.projects.kanban = buildDefaultProjectKanbanSettings(settings.projects.table);
    expectDefined(settings.projects.kanban.fields.find(({ id }) => id === 'end')).dateDisplay =
      'raw';

    clickView(host, 'Kanban');

    const start = expectDefined(
      host.querySelector<HTMLElement>(
        '.abyss-project-kanban [data-column-id="start"] .abyss-project-pretty-date',
      ),
    );
    const end = expectDefined(
      host.querySelector<HTMLElement>(
        '.abyss-project-kanban .abyss-project-kanban-field-value[data-column-id="end"]',
      ),
    );
    expect(start.textContent).toBe('Sep 10, 2026');
    expect(start.title).toBe(startRaw);
    expect(end.textContent).toBe(endRaw);
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

  it('offers a creation plus for every configured status without changing board layout', () => {
    const createProject = vi.fn().mockResolvedValue('Projects/New.md');
    const { host } = mountView([project()], { createProject });
    clickView(host, 'Kanban');
    const scroll = expectDefined(host.querySelector<HTMLElement>('.abyss-project-kanban-scroll'));
    const columns = Array.from(
      scroll.querySelectorAll<HTMLElement>('.abyss-project-kanban-column'),
    );
    const children = Array.from(scroll.children);
    const pluses = Array.from(
      host.querySelectorAll<HTMLButtonElement>('.abyss-project-kanban-column-create'),
    );

    expect(pluses.filter(({ hidden }) => !hidden)).toHaveLength(
      DEFAULT_SETTINGS.projects.statuses.length,
    );
    pluses[0]?.click();

    expect(Array.from(scroll.children)).toEqual(children);
    expect(
      Array.from(scroll.querySelectorAll<HTMLElement>('.abyss-project-kanban-column')),
    ).toEqual(columns);
    expect(host.querySelector('.abyss-project-creation-composer')).not.toBeNull();
    expect(pluses[0]?.getAttribute('aria-label')).toContain('Create project in');
  });

  it('reveals only the created project column and exact transient group', () => {
    const config = structuredClone(DEFAULT_SETTINGS);
    config.projects.kanban = buildDefaultProjectKanbanSettings(config.projects.table);
    config.projects.kanban.groupBy = 'start';
    config.projects.overviewView = 'kanban';
    const done = expectDefined(config.projects.statuses[2]);
    const activeStatus = expectDefined(config.projects.statuses[0]);
    const target = project({ path: 'Projects/New.md', frontmatter: { start: '2026-09-01' } });
    const otherGroup = project({
      path: 'Projects/Other.md',
      frontmatter: { start: '2026-10-01' },
    });
    const otherColumn = project({
      path: 'Projects/Done.md',
      statusId: done.id,
      frontmatter: { start: '2026-11-01' },
    });
    const { host, view } = mountView([target, otherGroup, otherColumn], { settings: config });
    const targetHeader = expectDefined(
      host.querySelector<HTMLButtonElement>(
        '[data-group-key="value:2026-09-01"] .abyss-project-kanban-group-header',
      ),
    );
    const unrelatedHeader = expectDefined(
      host.querySelector<HTMLButtonElement>(
        '[data-group-key="value:2026-10-01"] .abyss-project-kanban-group-header',
      ),
    );
    targetHeader.click();
    unrelatedHeader.click();
    const activeColumn = expectDefined(
      host.querySelector<HTMLElement>(
        `.abyss-project-kanban-column[data-status-key="id:${activeStatus.id}"]`,
      ),
    );
    const doneColumn = expectDefined(
      host.querySelector<HTMLElement>(
        `.abyss-project-kanban-column[data-status-key="id:${done.id}"]`,
      ),
    );
    expectDefined(
      activeColumn.querySelector<HTMLButtonElement>('.abyss-project-kanban-column-toggle'),
    ).click();
    expectDefined(
      doneColumn.querySelector<HTMLButtonElement>('.abyss-project-kanban-column-toggle'),
    ).click();
    const board = (
      view as unknown as {
        kanbanView_abyssPrivate: { revealProject(path: string): void };
      }
    ).kanbanView_abyssPrivate;

    board.revealProject(target.path);

    expect(activeColumn.classList).not.toContain('is-collapsed');
    expect(doneColumn.classList).toContain('is-collapsed');
    expect(
      targetHeader
        .closest<HTMLElement>('.abyss-project-kanban-group')
        ?.querySelector<HTMLElement>('.abyss-project-kanban-group-body')?.hidden,
    ).toBe(false);
    expect(
      unrelatedHeader
        .closest<HTMLElement>('.abyss-project-kanban-group')
        ?.querySelector<HTMLElement>('.abyss-project-kanban-group-body')?.hidden,
    ).toBe(true);
  });
});
