import { App, MarkdownRenderer, Menu } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { ProjectsTableView } from '../src/panels/projects/ProjectsTableView';
import type { ProjectPropertyCatalog } from '../src/projects/ObsidianProjectProperties';
import { ProjectEditValidationError } from '../src/projects/projectEditError';
import { ProjectEditHistory } from '../src/projects/projectEditHistory';
import type {
  AppliedProjectCellChange,
  ProjectCellChange,
  ProjectEditResult,
} from '../src/projects/projectEdits';
import { createOwnedInferredPropertyClear } from '../src/projects/projectEdits';
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
  properties: NonNullable<ReturnType<ProjectPropertyCatalog['list']>> = [],
): ProjectPropertyCatalog {
  const all = [
    { name: 'start', type: 'date' as const },
    { name: 'end', type: 'date' as const },
    ...properties,
  ];
  return {
    list: () => all,
    inspect: (property) => ({
      kind: 'available',
      property: all.find(({ name }) => name === property),
      assignment: { kind: 'none' },
    }),
    values: () => [],
    onChange: () => () => {},
  };
}

function mount(
  projects: Project[],
  overrides: Partial<ConstructorParameters<typeof ProjectsTableView>[1]> & {
    saveProperty?: (
      path: string,
      field: ProjectFieldCatalogItem,
      value: unknown,
      expectedValue: unknown,
    ) => Promise<void>;
    saveStatus?: (path: string, value: string, expectedValue: unknown) => Promise<void>;
  } = {},
) {
  const host = freshContainer();
  activeDocument.body.append(host);
  const config = settings();
  const saveSettings = vi.fn().mockResolvedValue(undefined);
  const saveProperty = overrides.saveProperty ?? vi.fn().mockResolvedValue(undefined);
  const saveStatus = overrides.saveStatus ?? vi.fn().mockResolvedValue(undefined);
  const openProject = vi.fn();
  const successful = (changes: readonly ProjectCellChange[]): ProjectEditResult => ({
    applied: changes.map((change): AppliedProjectCellChange => ({
      ...change,
      sourceProperty: change.field.property ?? config.projects.statusProperty,
      sourceKey: change.field.property ?? config.projects.statusProperty,
      previousValue: change.expectedValue,
      previousExists: change.expectedValue !== undefined,
      appliedExists: change.value !== undefined && change.value !== '',
    })),
    failed: [],
  });
  const applyEdits =
    overrides.applyEdits ??
    vi.fn(async (changes: readonly ProjectCellChange[]) => {
      const change = expectDefined(changes[0]);
      if (change.field.type === 'status') {
        await saveStatus(change.path, String(change.value), change.expectedValue);
      } else {
        await saveProperty(change.path, change.field, change.value, change.expectedValue);
      }
      return successful(changes);
    });
  const history = overrides.history ?? new ProjectEditHistory(applyEdits);
  const view = new ProjectsTableView(host, {
    app: new App(),
    state: new AppState(),
    settings: config,
    catalog: catalog(),
    saveSettings,
    applyEdits,
    history,
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

  it('assigns the four quarter progress tones while keeping zero neutral', () => {
    const { host } = mount(
      [
        ['Zero', 0],
        ['Low', 2],
        ['Quarter', 4],
        ['Half', 6],
        ['High', 8],
      ].map(([name, done]) =>
        project({
          path: `Projects/${name}.md`,
          name: String(name),
          stats: { total: 10, done: Number(done), cancelled: 0, inProgress: 0 },
        }),
      ),
    );
    const band = (path: string): string =>
      expectDefined(
        host.querySelector<HTMLElement>(
          `[data-project-path="Projects/${path}.md"] .abyss-project-table-progress`,
        ),
      ).className;

    expect(band('Zero')).toContain('is-empty');
    expect(band('Low')).toContain('is-low');
    expect(band('Quarter')).toContain('is-quarter');
    expect(band('Half')).toContain('is-half');
    expect(band('High')).toContain('is-high');
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

  it('renders a read-only status with its configured label and unavailable badge', () => {
    const unavailableCatalog: ProjectPropertyCatalog = {
      list: () => null,
      inspect: () => ({ kind: 'unavailable' }),
      values: () => [],
      onChange: () => () => {},
    };
    const { host } = mount([project({ frontmatter: { status: 'active' } })], {
      catalog: unavailableCatalog,
    });
    const cell = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="status"]'),
    );

    expect(cell.querySelector('.abyss-project-table-status-pill')?.textContent).toBe(active.name);
    expect(cell.querySelector('.abyss-project-table-unavailable')?.textContent).toBe(
      'Type unavailable',
    );
    expect(cell.classList.contains('is-editable')).toBe(false);
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
    expect(
      host.querySelector<HTMLTableColElement>('col[data-column-id="start"]')?.style.width,
    ).toBe('290px');
    expect(host.querySelector<HTMLTableElement>('.abyss-project-table')?.style.width).toBe(
      '1490px',
    );
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

  it('moves columns one step right, to the end, and back left without sorting', async () => {
    const { host, config, saveSettings } = mount([project({})]);
    const transfer = {
      types: [] as string[],
      value: '',
      setData(type: string, value: string) {
        this.types = [type];
        this.value = value;
      },
      getData: () => transfer.value,
    };
    const drag = (sourceId: string, targetId: string, clientX: number): void => {
      const source = expectDefined(
        host.querySelector<HTMLElement>(`th[data-column-id="${sourceId}"]`),
      );
      const target = expectDefined(
        host.querySelector<HTMLElement>(`th[data-column-id="${targetId}"]`),
      );
      vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        width: 100,
      } as DOMRect);
      for (const [element, type, x] of [
        [source, 'dragstart', 0],
        [target, 'drop', clientX],
      ] as const) {
        const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x });
        Object.defineProperty(event, 'dataTransfer', { value: transfer });
        element.dispatchEvent(event);
      }
    };
    const order = (): string[] => config.projects.table.columns.map(({ id }) => id);

    drag('status', 'progress', 75);
    expect(order()).toEqual(['name', 'progress', 'status', 'start', 'end']);
    drag('progress', 'end', 75);
    expect(order()).toEqual(['name', 'status', 'start', 'end', 'progress']);
    drag('progress', 'status', 25);
    expect(order()).toEqual(['name', 'progress', 'status', 'start', 'end']);

    expect(config.projects.table.sortBy).toEqual({ field: 'end', dir: 'asc' });
    expect(saveSettings).toHaveBeenCalledTimes(3);
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

  it('renders and searches an explicit wiki-link alias as a real anchor', async () => {
    vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, _markdown, holder) => {
      const anchor = holder.createEl('a', { cls: 'internal-link' });
      anchor.textContent = 'West team';
      anchor.setAttribute('data-href', 'People/Team');
    });
    const config = settings();
    config.projects.table.columns.push({ id: 'property:creator', visible: true });
    const { host } = mount([project({ frontmatter: { creator: '[[People/Team|West team]]' } })], {
      settings: config,
      catalog: catalog([{ name: 'creator', type: 'text' }]),
    });

    await new Promise((resolve) => window.setTimeout(resolve, 0));
    const link = expectDefined(
      host.querySelector<HTMLAnchorElement>(
        '.abyss-project-table-cell[data-column-id="property:creator"] a.internal-link',
      ),
    );
    expect(link.textContent).toBe('West team');
    link.click();
    expect(host.querySelector('.abyss-project-cell-editor')).toBeNull();
    const search = expectDefined(host.querySelector<HTMLInputElement>('.abyss-center-search'));
    search.value = 'West team';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    expect(host.querySelectorAll('.abyss-project-table-row')).toHaveLength(1);
  });

  it('renders a Markdown group anchor without toggling its group or editing its cell', async () => {
    vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, _markdown, holder) => {
      const anchor = holder.createEl('a', { cls: 'internal-link', text: 'Core team' });
      anchor.setAttribute('data-href', 'People/Team');
    });
    const config = settings();
    config.projects.table.columns.push({ id: 'property:creator', visible: true });
    config.projects.table.groupBy = 'property:creator';
    const app = new App();
    vi.spyOn(app.metadataCache, 'getFirstLinkpathDest').mockReturnValue(null);
    const { host } = mount([project({ frontmatter: { creator: '[Core team](People/Team)' } })], {
      app,
      settings: config,
      catalog: catalog([{ name: 'creator', type: 'text' }]),
    });
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    const toggle = expectDefined(
      host.querySelector<HTMLButtonElement>('.abyss-project-table-group-toggle'),
    );
    const link = expectDefined(toggle.querySelector<HTMLAnchorElement>('a.internal-link'));

    link.click();

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelectorAll('.abyss-project-table-row')).toHaveLength(1);
    expect(host.querySelector('.abyss-project-cell-editor')).toBeNull();
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

  it('blocks table mutation on a failed draft and runs only the latest action after Escape', async () => {
    const item = project({});
    const saveProperty = vi
      .fn()
      .mockRejectedValue(new ProjectEditValidationError('Fix the draft first.'));
    const { host, view, config } = mount([item], { saveProperty });
    const endCell = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="end"]'),
    );
    const header = expectDefined(
      host.querySelector<HTMLButtonElement>(
        '.abyss-project-table-header-cell[data-column-id="end"] .abyss-project-table-column-button',
      ),
    );
    const statusFilter = expectDefined(
      host.querySelector<HTMLButtonElement>(
        `.abyss-project-status-filter[data-status-key="id:${active.id}"]`,
      ),
    );
    const search = expectDefined(host.querySelector<HTMLInputElement>('.abyss-center-search'));

    endCell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const draft = expectDefined(endCell.querySelector<HTMLInputElement>('input[type="date"]'));
    draft.value = '2026-12-24';
    draft.focus();

    header.click();
    search.value = 'A';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    statusFilter.click();
    await flushMicrotasks();

    expect(draft.isConnected).toBe(true);
    expect(draft.value).toBe('2026-12-24');
    expect(activeDocument.activeElement).toBe(draft);
    expect(config.projects.table.sortBy).toEqual({ field: 'end', dir: 'asc' });
    expect(config.projects.table.hiddenStatuses).toEqual([]);

    draft.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(config.projects.table.hiddenStatuses).toEqual([`id:${active.id}`]);
    expect(config.projects.table.sortBy).toEqual({ field: 'end', dir: 'asc' });
    expect(host.querySelectorAll('.abyss-project-table-row')).toHaveLength(0);
    view.destroy();
  });

  it('explains unavailable custom fields while retaining their value and curated editing', () => {
    const config = settings();
    config.projects.table.columns.push({
      id: 'property:LegacyKey',
      visible: true,
      label: 'Legacy',
    });
    const { host } = mount([project({ frontmatter: { LegacyKey: 'Keep me' } })], {
      settings: config,
      catalog: catalog(),
    });

    const unavailable = expectDefined(
      host.querySelector<HTMLElement>(
        '.abyss-project-table-cell[data-column-id="property:LegacyKey"]',
      ),
    );
    expect(unavailable.textContent).toContain('Keep me');
    expect(unavailable.classList.contains('is-editable')).toBe(false);
    const explanation = expectDefined(
      unavailable.querySelector<HTMLElement>('.abyss-project-table-unavailable'),
    );
    expect(explanation.textContent).toBe('Type unavailable');
    expect(explanation.getAttribute('aria-label')).toContain('LegacyKey');
    expect(explanation.getAttribute('aria-label')).toContain('read-only');

    const end = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="end"]'),
    );
    end.click();
    expect(end.querySelector('.abyss-project-cell-editor')).not.toBeNull();
  });

  it('restores only a history-owned cleared custom cell and forwards its proof on refill', async () => {
    const config = settings();
    config.projects.table.columns.push({ id: 'property:Budget', visible: true });
    const budget = {
      id: 'property:Budget',
      property: 'Budget',
      label: 'Budget',
      type: 'number',
    } as const;
    const ownedClear = createOwnedInferredPropertyClear({
      path: 'Projects/A.md',
      fieldId: budget.id,
      sourceProperty: budget.property,
      sourceKey: budget.property,
      type: budget.type,
    });
    const applied: AppliedProjectCellChange = {
      path: 'Projects/A.md',
      field: budget,
      value: '',
      expectedValue: 10,
      previousValue: 10,
      sourceProperty: 'Budget',
      sourceKey: 'Budget',
      previousExists: true,
      appliedExists: false,
      ownedClear,
    };
    const applyEdits = vi.fn(async (changes: readonly ProjectCellChange[]) => ({
      applied: changes.map((change) => ({
        ...applied,
        ...change,
        previousValue: change.expectedValue,
        previousExists: false,
        appliedExists: true,
      })),
      failed: [],
    }));
    const history = new ProjectEditHistory(applyEdits);
    history.record({ applied: [applied], failed: [] });
    const { host } = mount([project({ frontmatter: {} })], {
      settings: config,
      catalog: catalog(),
      history,
      applyEdits,
    });
    const cell = expectDefined(
      host.querySelector<HTMLElement>(
        '.abyss-project-table-cell[data-column-id="property:Budget"]',
      ),
    );

    expect(cell.hasClass('is-editable')).toBe(true);
    cell.click();
    const input = expectDefined(cell.querySelector<HTMLInputElement>('input[type="number"]'));
    input.value = '42';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushMicrotasks();

    const calledChanges = expectDefined(applyEdits.mock.lastCall?.[0]);
    const change: ProjectCellChange = expectDefined(calledChanges[0]);
    expect(change).toMatchObject({
      path: 'Projects/A.md',
      value: 42,
      expectedValue: undefined,
      expectedExists: false,
      ownedClear,
    });
    expect(change.field).toMatchObject({ id: 'property:Budget', type: 'number' });
  });

  it('projects an applied receipt before the native metadata cache catches up', async () => {
    const config = settings();
    config.projects.table.columns.push({ id: 'property:Owner', visible: true });
    const { host } = mount([project({ frontmatter: { Owner: 'Original' } })], {
      settings: config,
      catalog: catalog([{ name: 'Owner', type: 'text' }]),
    });
    const cell = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="property:Owner"]'),
    );
    cell.click();
    const input = expectDefined(cell.querySelector<HTMLInputElement>('input[type="text"]'));
    input.value = '';

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    await flushMicrotasks();

    const rendered = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="property:Owner"]'),
    );
    expect(rendered.textContent).toBe('—');
    rendered.click();
    expect(expectDefined(rendered.querySelector<HTMLInputElement>('input')).value).toBe('');
  });

  it('serializes table-session mutations for later Undo and Redo integration', async () => {
    const { view } = mount([project({})]);
    let release: (() => void) | undefined;
    const first = view.runTableSessionMutation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const secondMutation = vi.fn().mockResolvedValue('second');
    const second = view.runTableSessionMutation(secondMutation);
    await flushMicrotasks();
    expect(secondMutation).not.toHaveBeenCalled();

    expectDefined(release)();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBe('second');
    expect(secondMutation).toHaveBeenCalledOnce();
  });

  it('retains a status draft across external refresh and surfaces the stale conflict', async () => {
    const item = project({ frontmatter: { status: active.name } });
    const done = expectDefined(DEFAULT_SETTINGS.projects.statuses[2]);
    const saveStatus = vi.fn(async (_path: string, _status: string, expectedStatus: unknown) => {
      if (item.frontmatter['status'] !== expectedStatus) {
        throw new ProjectEditValidationError(
          'Status changed externally. Reload the project and try your edit again.',
        );
      }
    });
    const { host, view } = mount([item], { saveStatus });
    const cell = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="status"]'),
    );
    cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const select = expectDefined(cell.querySelector<HTMLSelectElement>('select'));
    select.value = done.name;

    const externalStatus = expectDefined(DEFAULT_SETTINGS.projects.statuses[1]);
    item.statusId = externalStatus.id;
    item.frontmatter['status'] = externalStatus.name;
    view.update([item]);
    expect(select.isConnected).toBe(true);
    expect(select.value).toBe(done.name);
    select.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushMicrotasks();

    expect(saveStatus).toHaveBeenCalledWith('Projects/A.md', done.name, active.name);
    expect(select.isConnected).toBe(true);
    expect(host.querySelector('.abyss-project-editor-error')?.textContent).toContain(
      'changed externally',
    );
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
