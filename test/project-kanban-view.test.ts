import { App, MarkdownRenderer, Notice } from 'obsidian';
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

function viewOptionRow(host: HTMLElement, label: string): HTMLElement {
  return expectDefined(
    Array.from(host.querySelectorAll<HTMLElement>('.abyss-view-state-row')).find(
      (row) => row.querySelector('.abyss-view-state-row-label')?.textContent === label,
    ),
  );
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

  it('does not start from selected text and tears down Escape and dragend state', () => {
    const { host } = mountView();
    clickView(host, 'Kanban');
    const card = expectDefined(host.querySelector<HTMLElement>('.abyss-project-kanban-card'));
    const title = expectDefined(card.querySelector<HTMLElement>('.abyss-project-table-name'));
    const selection = expectDefined(activeDocument.defaultView?.getSelection());
    selection.removeAllRanges();
    const range = activeDocument.createRange();
    range.selectNodeContents(title);
    selection.addRange(range);
    const blockedData = transfer();
    title.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    const blocked = dragEvent('dragstart', blockedData);
    title.dispatchEvent(blocked);
    expect(blocked.defaultPrevented).toBe(true);
    expect(blockedData.types).toEqual([]);

    selection.removeAllRanges();
    const data = transfer();
    card.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    card.dispatchEvent(dragEvent('dragstart', data));
    expect(card.classList.contains('is-dragging')).toBe(true);
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(card.classList.contains('is-dragging')).toBe(false);

    card.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    card.dispatchEvent(dragEvent('dragstart', data));
    card.dispatchEvent(dragEvent('dragend', data));
    expect(host.querySelector('.is-dragging, .is-drop-target')).toBeNull();
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
    const target = expectDefined(
      host.querySelector<HTMLElement>(
        `.abyss-project-kanban-column[data-status-key="id:${active.id}"]`,
      ),
    );

    target.dispatchEvent(dragEvent('drop', data));
    await flushMicrotasks();

    expect(applyEdits).not.toHaveBeenCalled();
    expect(host.querySelector('.abyss-project-table-feedback')?.textContent).toContain('changed');
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

    const input = expectDefined(host.querySelector<HTMLInputElement>('.abyss-projects-new-input'));
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
    chooseViewOption(host, 'Description', '2 lines');
    await flushMicrotasks();

    expect(groupBody.hidden).toBe(false);
    expect(settings.projects.kanban.descriptionLines).toBe(1);
    expect(input.isConnected).toBe(true);
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
});
