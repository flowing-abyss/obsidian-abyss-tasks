import { App, MarkdownRenderer, Menu, Notice, type WorkspaceLeaf } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { ProjectsTableView } from '../src/panels/projects/ProjectsTableView';
import { mountProjectCellEditorPosition } from '../src/panels/projects/projectCellEditorPosition';
import type { ProjectPropertyCatalog } from '../src/projects/ObsidianProjectProperties';
import { ProjectCreationError } from '../src/projects/projectCreation';
import { ProjectEditValidationError } from '../src/projects/projectEditError';
import { ProjectEditHistory } from '../src/projects/projectEditHistory';
import type {
  AppliedProjectCellChange,
  ProjectCellChange,
  ProjectEditResult,
} from '../src/projects/projectEdits';
import { createOwnedInferredPropertyClear } from '../src/projects/projectEdits';
import type { ProjectFieldCatalogItem } from '../src/projects/projectFields';
import { buildDefaultProjectKanbanSettings } from '../src/projects/projectKanbanSettings';
import type { Project } from '../src/projects/types';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { CalendarSettings } from '../src/settings/types';
import { ProjectPropertySuggest } from '../src/ui/ProjectPropertySuggest';
import { expectDefined, flushMicrotasks, freshContainer, loadPluginStyles } from './helpers';

interface TestTransfer {
  readonly types: string[];
  setData(type: string, value: string): void;
  getData(type: string): string;
  dropEffect: string;
  effectAllowed: string;
}

function transfer(initial: Readonly<Record<string, string>> = {}): TestTransfer {
  const values = new Map(Object.entries(initial));
  return {
    get types() {
      return [...values.keys()];
    },
    setData(type, value) {
      values.set(type, value);
    },
    getData(type) {
      return values.get(type) ?? '';
    },
    dropEffect: 'none',
    effectAllowed: 'uninitialized',
  };
}

function clipboardEvent(type: 'copy' | 'paste', data: TestTransfer): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: data });
  return event;
}

function dragEvent(type: string, data: TestTransfer): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: data });
  return event;
}

function rectangle(left: number, top: number, right: number, bottom: number): DOMRect {
  return { left, top, right, bottom, width: right - left, height: bottom - top } as DOMRect;
}

function cappedStylePixels(value: string, natural: number, offset = 0): number {
  const parsed = Number.parseFloat(value);
  return Math.min(natural, Number.isFinite(parsed) ? parsed - offset : Infinity);
}

function positiveStylePixels(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const active = expectDefined(DEFAULT_SETTINGS.projects.statuses[0]);
const mountedViews = new Set<ProjectsTableView>();

function destroyMountedView(view: ProjectsTableView): void {
  if (mountedViews.delete(view)) view.destroy();
}

afterEach(() => {
  for (const view of mountedViews) view.destroy();
  mountedViews.clear();
  activeDocument.body.empty();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
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
  const config = structuredClone(DEFAULT_SETTINGS);
  config.projects.propertyDefinitions = {
    'property:Budget': { type: 'number' },
    'property:Flag': { type: 'checkbox' },
    'property:Owner': { type: 'text' },
    'property:Owners': { type: 'list' },
    'property:Tags': { type: 'tags' },
    'property:creator': { type: 'text' },
  };
  return config;
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
    saveViewState: saveSettings,
    applyEdits,
    history,
    createProject: vi.fn().mockResolvedValue(undefined),
    openProject,
    revalidateSourceObservation: vi.fn().mockResolvedValue(false),
    ...overrides,
  });
  mountedViews.add(view);
  view.mount(projects);
  return { host, view, config, saveSettings, saveProperty, saveStatus, openProject };
}

interface TestMenuItem {
  readonly title__: string;
  readonly checked: boolean | null;
  readonly submenu: Menu | null;
  readonly onClick__: ((event: MouseEvent | KeyboardEvent) => void) | null;
}

function menuItems(menu: Menu): readonly TestMenuItem[] {
  return (menu as unknown as { readonly menuItems__: readonly TestMenuItem[] }).menuItems__;
}

function menuItem(menu: Menu, title: string): TestMenuItem {
  return expectDefined(menuItems(menu).find(({ title__: candidate }) => candidate === title));
}

function submenu(menu: Menu, title: string): Menu {
  return expectDefined(menuItem(menu, title).submenu);
}

function activateMenuItem(menu: Menu, title: string): void {
  expectDefined(menuItem(menu, title).onClick__)(new MouseEvent('click'));
}

function lastShownMenu(spy: { readonly mock: { readonly instances: readonly unknown[] } }): Menu {
  return expectDefined(spy.mock.instances[spy.mock.instances.length - 1]) as Menu;
}

describe('ProjectsTableView', () => {
  it('defaults valid dates to Pretty while preserving raw display, tooltip, and copy text', () => {
    const config = settings();
    expectDefined(config.projects.table.columns.find(({ id }) => id === 'end')).dateDisplay = 'raw';
    const startRaw = '2026-09-10';
    const endRaw = '2026-09-11T00:30:00-10:00';
    const { host } = mount([project({ frontmatter: { start: startRaw, end: endRaw } })], {
      settings: config,
    });
    const start = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="start"]'),
    );
    const end = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="end"]'),
    );
    const pretty = expectDefined(start.querySelector<HTMLElement>('.abyss-project-pretty-date'));

    expect(pretty.textContent).toBe('Sep 10, 2026');
    expect(pretty.title).toBe(startRaw);
    expect(end.textContent).toBe(endRaw);
    start.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const copied = transfer();
    start.dispatchEvent(clipboardEvent('copy', copied));
    expect(copied.getData('text/plain')).toBe(startRaw);
  });

  it('refreshes relative date text in place and stops its one view timer on destroy', () => {
    vi.useFakeTimers({ now: new Date(2026, 8, 10, 23, 0, 0).getTime() });
    vi.spyOn(HTMLElement.prototype, 'isShown').mockReturnValue(true);
    const config = settings();
    const start = expectDefined(config.projects.table.columns.find(({ id }) => id === 'start'));
    start.dateDisplay = 'relative';
    const clearInterval = vi.spyOn(window, 'clearInterval');
    const { host, view } = mount(
      [project({ frontmatter: { start: '2026-09-10T23:15:00', end: '2026-09-30' } })],
      { settings: config },
    );
    const relative = expectDefined(host.querySelector<HTMLElement>('.abyss-project-relative-date'));
    expect(relative.textContent).toBe('in 15 minutes');
    expect(relative.title).toBe('2026-09-10T23:15:00');

    vi.advanceTimersByTime(60_000);

    expect(relative.textContent).toBe('in 14 minutes');
    expect(host.querySelector('.abyss-project-relative-date')).toBe(relative);
    destroyMountedView(view);
    expect(clearInterval).toHaveBeenCalledOnce();
  });

  it('skips sleeping relative-date updates and refreshes after the table is reattached', () => {
    vi.useFakeTimers({ now: new Date(2026, 8, 10, 23, 0, 0).getTime() });
    vi.spyOn(HTMLElement.prototype, 'isShown').mockImplementation(function (this: HTMLElement) {
      return this.closest('[hidden]') === null;
    });
    const config = settings();
    expectDefined(config.projects.table.columns.find(({ id }) => id === 'start')).dateDisplay =
      'relative';
    const { host, view } = mount(
      [project({ frontmatter: { start: '2026-09-10T23:15:00', end: '2026-09-30' } })],
      { settings: config },
    );
    const relative = expectDefined(host.querySelector<HTMLElement>('.abyss-project-relative-date'));
    host.remove();
    vi.advanceTimersByTime(60_000);
    expect(relative.textContent).toBe('in 15 minutes');

    host.hidden = true;
    activeDocument.body.append(host);
    activeWindow.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(60_000);
    expect(relative.textContent).toBe('in 15 minutes');

    host.hidden = false;
    activeWindow.dispatchEvent(new Event('focus'));

    expect(relative.textContent).toBe('in 13 minutes');
    destroyMountedView(view);
  });
  it('renders native type icons and alignment while reconciling preset presentation in place', () => {
    const config = settings();
    config.projects.table.columns.push({
      id: 'property:Budget',
      visible: true,
      alignment: 'center',
    });
    config.projects.propertyDefinitions['property:Budget'] = {
      type: 'number',
      presetsEnabled: true,
      presets: [{ value: 42, displayName: 'Estimate', color: '#123456', display: 'badge' }],
    };
    const item = project({ frontmatter: { Budget: 42 } });
    const { host, view } = mount([item], { settings: config });
    const header = expectDefined(
      host.querySelector<HTMLElement>(
        '.abyss-project-table-header-cell[data-column-id="property:Budget"]',
      ),
    );
    const cell = expectDefined(
      host.querySelector<HTMLElement>(
        '.abyss-project-table-cell[data-column-id="property:Budget"]',
      ),
    );

    expect(header.classList).toContain('is-align-center');
    expect(cell.classList).toContain('is-align-center');
    expect(
      header.querySelector('.abyss-project-table-column-icon')?.getAttribute('data-icon'),
    ).toBe('binary');
    expect(cell.textContent).toContain('Estimate');
    expect(
      cell
        .querySelector<HTMLElement>('.abyss-project-property-value')
        ?.style.getPropertyValue('--abyss-project-property-color'),
    ).toBe('#123456');

    expectDefined(
      expectDefined(
        expectDefined(config.projects.propertyDefinitions['property:Budget']).presets,
      )[0],
    ).displayName = 'Forecast';
    view.update([item]);

    expect(host.querySelector('.abyss-project-table-cell[data-column-id="property:Budget"]')).toBe(
      cell,
    );
    expect(cell.textContent).toContain('Forecast');
  });

  it('renders configured aliases for scalar and list text while preserving raw link targets', async () => {
    vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, markdown, holder) => {
      const anchor = holder.createEl('a', { cls: 'internal-link', text: markdown });
      anchor.setAttribute('data-href', 'People/Owner');
    });
    const config = settings();
    config.projects.table.columns.push(
      { id: 'property:Priority', visible: true },
      { id: 'property:Owners', visible: true },
      { id: 'property:Lead', visible: true },
    );
    config.projects.propertyDefinitions['property:Priority'] = {
      type: 'text',
      presetsEnabled: true,
      presets: [{ value: 'QA-only priority', displayName: 'QA priority option', display: 'badge' }],
    };
    config.projects.propertyDefinitions['property:Owners'] = {
      type: 'list',
      presetsEnabled: true,
      presets: [{ value: 'owner-id', displayName: 'Owner alias', display: 'text' }],
    };
    config.projects.propertyDefinitions['property:Lead'] = {
      type: 'text',
      presetsEnabled: true,
      presets: [
        {
          value: '[[People/Owner]]',
          displayName: 'Lead alias',
          display: 'dot',
          color: '#abcdef',
        },
      ],
    };
    const { host } = mount(
      [
        project({
          frontmatter: {
            Priority: 'QA-only priority',
            Owners: ['owner-id'],
            Lead: '[[People/Owner]]',
          },
        }),
      ],
      {
        settings: config,
        catalog: catalog([
          { name: 'Priority', type: 'text' },
          { name: 'Owners', type: 'list' },
          { name: 'Lead', type: 'text' },
        ]),
      },
    );

    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(
      host.querySelector('.abyss-project-table-cell[data-column-id="property:Priority"]')
        ?.textContent,
    ).toContain('QA priority option');
    expect(
      host.querySelector('.abyss-project-table-cell[data-column-id="property:Owners"]')
        ?.textContent,
    ).toContain('Owner alias');
    const link = expectDefined(
      host.querySelector<HTMLAnchorElement>(
        '.abyss-project-table-cell[data-column-id="property:Lead"] a.internal-link',
      ),
    );
    expect(link.textContent).toBe('Lead alias');
    expect(link.dataset['href']).toBe('People/Owner');
    const dotValue = expectDefined(link.closest<HTMLElement>('.abyss-project-property-value'));
    expect(dotValue.classList.contains('is-dot')).toBe(true);
    expect(dotValue.classList.contains('is-badge')).toBe(false);
    expect(dotValue.style.getPropertyValue('--abyss-project-property-color')).toBe('#abcdef');
  });

  it('renders one dot presentation marker with a status label and no badge treatment', () => {
    const config = settings();
    const configured = expectDefined(config.projects.statuses[0]);
    configured.display = 'dot';
    configured.displayName = 'In progress';
    const { host } = mount([project({ statusId: configured.id, rawStatus: configured.name })], {
      settings: config,
    });

    const cell = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="status"]'),
    );
    const value = expectDefined(
      cell.querySelector<HTMLElement>('.abyss-project-table-status-pill'),
    );
    expect(value.textContent).toBe('In progress');
    expect(cell.querySelectorAll('.is-dot')).toHaveLength(1);
    expect(value.classList.contains('is-dot')).toBe(true);
    expect(value.classList.contains('is-badge')).toBe(false);
  });

  it('keeps the existing single subdued group marker for colorless dot presentations', () => {
    const config = settings();
    config.projects.table.groupBy = 'property:Owner';
    config.projects.table.columns.push({ id: 'property:Owner', visible: true });
    config.projects.propertyDefinitions['property:Owner'] = {
      type: 'text',
      presets: [{ value: 'mina', displayName: 'Mina', display: 'dot' }],
    };
    const { host } = mount([project({ frontmatter: { Owner: 'mina' } })], {
      settings: config,
      catalog: catalog([{ name: 'Owner', type: 'text' }]),
    });

    const group = expectDefined(host.querySelector<HTMLElement>('.abyss-project-table-group-row'));
    const marker = expectDefined(group.querySelector<HTMLElement>('.abyss-status-dot'));
    expect(marker.hidden).toBe(false);
    expect(marker.style.background).toBe('');
    expect(group.querySelectorAll('.abyss-status-dot')).toHaveLength(1);
    expect(group.querySelector('.is-dot')).toBeNull();
    expect(group.querySelector('.abyss-projects-group-label')?.textContent).toBe('Mina');
  });

  it('uses an explicit preset display name for a grouped link value', async () => {
    vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, markdown, holder) => {
      const anchor = holder.createEl('a', { cls: 'internal-link', text: markdown });
      anchor.setAttribute('data-href', 'People/Owner');
    });
    const config = settings();
    config.projects.table.groupBy = 'property:Lead';
    config.projects.table.columns.push({ id: 'property:Lead', visible: true });
    config.projects.propertyDefinitions['property:Lead'] = {
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
    const { host } = mount([project({ frontmatter: { Lead: '[[People/Owner]]' } })], {
      settings: config,
      catalog: catalog([{ name: 'Lead', type: 'text' }]),
    });

    await new Promise((resolve) => window.setTimeout(resolve, 0));

    const link = expectDefined(
      host.querySelector<HTMLAnchorElement>(
        '.abyss-project-table-group-row .abyss-projects-group-label a.internal-link',
      ),
    );
    expect(link.textContent).toBe('Lead alias');
    expect(link.dataset['href']).toBe('People/Owner');
  });

  it('keeps malformed definitions unavailable and repairable without throwing while rendering', () => {
    const config = settings();
    config.projects.table.columns.push({ id: 'property:Broken', visible: true });
    config.projects.table.groupBy = 'property:Broken';
    config.projects.propertyDefinitions['property:Broken'] = null as never;

    const { host } = mount([project({ frontmatter: { Broken: 'saved raw' } })], {
      settings: config,
      catalog: catalog([{ name: 'Broken', type: null }]),
    });

    const cell = expectDefined(
      host.querySelector<HTMLElement>(
        '.abyss-project-table-cell[data-column-id="property:Broken"]',
      ),
    );
    expect(cell.textContent).toContain('Type unavailable');
    expect(
      cell.querySelector('.abyss-project-table-unavailable')?.getAttribute('aria-label'),
    ).toContain('choose a Type');
  });

  it('applies a configured tag alias and color through the native tag anchor only', () => {
    const config = settings();
    config.projects.table.columns.push({ id: 'property:Tags', visible: true });
    config.projects.propertyDefinitions['property:Tags'] = {
      type: 'tags',
      presetsEnabled: true,
      presets: [{ value: 'qa', displayName: '#Quality', color: '#123456', display: 'dot' }],
    };
    const { host, view } = mount([project({ frontmatter: { Tags: ['qa'] } })], {
      settings: config,
      catalog: catalog([{ name: 'Tags', type: 'tags' }]),
    });

    const link = expectDefined(
      host.querySelector<HTMLAnchorElement>(
        '.abyss-project-table-cell[data-column-id="property:Tags"] a.tag',
      ),
    );
    expect(link.textContent).toBe('#Quality');
    expect(link.getAttribute('href')).toBe('#qa');
    expect(link.style.getPropertyValue('--abyss-project-property-color')).toBe('#123456');
    expect(link.style.color).toBe('');
    expect(link.hasClass('abyss-project-property-value')).toBe(false);
    expect(link.hasClass('is-badge')).toBe(false);
    expect(link.hasClass('is-dot')).toBe(true);
    const cell = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="property:Tags"]'),
    );
    cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const editor = view as unknown as {
      readonly activeEditor_abyssPrivate?: {
        readonly handle: {
          readonly control_abyssPrivate: { readonly suggest?: ProjectPropertySuggest };
        };
      };
    };
    expectDefined(cell.querySelector<HTMLButtonElement>('[aria-label="Remove #Quality"]')).click();
    const suggestion = expectDefined(
      editor.activeEditor_abyssPrivate?.handle.control_abyssPrivate.suggest,
    ).getSuggestions('Quality')[0];
    expect(suggestion).toMatchObject({ value: 'qa', label: '#Quality', appearance: 'tag' });
  });

  it('uses native link and tag labels for dot preset editor chips without display names', async () => {
    const config = settings();
    config.projects.table.columns.push(
      { id: 'property:creator', visible: true },
      { id: 'property:Tags', visible: true },
    );
    config.projects.propertyDefinitions['property:creator'] = {
      type: 'list',
      presets: [
        {
          value: '[[People Demo/Анна Смирнова|Анна]]',
          display: 'dot',
          color: '#123456',
        },
      ],
    };
    config.projects.propertyDefinitions['property:Tags'] = {
      type: 'tags',
      presets: [{ value: 'demo', display: 'dot', color: '#654321' }],
    };
    const { host, view } = mount(
      [
        project({
          frontmatter: {
            creator: ['[[People Demo/Анна Смирнова|Анна]]'],
            Tags: ['demo'],
          },
        }),
      ],
      {
        settings: config,
        catalog: catalog([
          { name: 'creator', type: 'list' },
          { name: 'Tags', type: 'tags' },
        ]),
      },
    );
    const creator = expectDefined(
      host.querySelector<HTMLElement>(
        '.abyss-project-table-cell[data-column-id="property:creator"]',
      ),
    );
    creator.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

    const creatorChip = expectDefined(
      creator.querySelector<HTMLElement>('.abyss-project-list-value-text'),
    );
    expect(creatorChip.textContent).toBe('Анна');
    expect(creatorChip.classList.contains('is-dot')).toBe(true);
    await expect(view.requestFinishActiveEditor()).resolves.toBe(true);

    const tags = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="property:Tags"]'),
    );
    tags.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const tagChip = expectDefined(
      tags.querySelector<HTMLElement>('.abyss-project-list-value-text.tag'),
    );
    expect(tagChip.textContent).toBe('#demo');
    expect(tagChip.classList.contains('is-dot')).toBe(true);
  });

  it('defaults a configured custom preset suggestion to badge presentation', () => {
    const config = settings();
    config.projects.table.columns.push({ id: 'property:Priority', visible: true });
    config.projects.propertyDefinitions['property:Priority'] = {
      type: 'list',
      presets: [{ value: 'high', displayName: 'High' }],
    };
    const { host, view } = mount([project({ frontmatter: { Priority: [] } })], {
      settings: config,
      catalog: catalog([{ name: 'Priority', type: 'list' }]),
    });
    const cell = expectDefined(
      host.querySelector<HTMLElement>(
        '.abyss-project-table-cell[data-column-id="property:Priority"]',
      ),
    );
    cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const editor = view as unknown as {
      readonly activeEditor_abyssPrivate?: {
        readonly handle: {
          readonly control_abyssPrivate: { readonly suggest?: ProjectPropertySuggest };
        };
      };
    };
    const suggest = expectDefined(
      editor.activeEditor_abyssPrivate?.handle.control_abyssPrivate.suggest,
    );
    const high = expectDefined(suggest.getSuggestions('').find(({ value }) => value === 'high'));
    const rendered = document.body.createDiv();
    suggest.renderSuggestion(high, rendered);

    expect(
      rendered
        .querySelector<HTMLElement>('.abyss-suggest-title')
        ?.classList.contains('abyss-project-preset-suggestion'),
    ).toBe(true);
  });

  it('reports the focused visible occurrence path and forgets filtered or removed selection', () => {
    const alpha = project({ path: 'Projects/A.md', name: 'Alpha' });
    const beta = project({ path: 'Projects/B.md', name: 'Beta' });
    const { host, view } = mount([alpha, beta]);
    const alphaStatus = expectDefined(
      host.querySelector<HTMLElement>(
        '[data-project-path="Projects/A.md"] [data-column-id="status"]',
      ),
    );
    const betaProgress = expectDefined(
      host.querySelector<HTMLElement>(
        '[data-project-path="Projects/B.md"] [data-column-id="progress"]',
      ),
    );

    expect(view.selectedProjectPath()).toBeUndefined();
    alphaStatus.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    betaProgress.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    expect(view.selectedProjectPath()).toBe('Projects/B.md');

    const search = expectDefined(host.querySelector<HTMLInputElement>('.abyss-center-search'));
    search.value = 'Alpha';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    expect(view.selectedProjectPath()).toBeUndefined();

    search.value = '';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    betaProgress.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    view.update([alpha]);
    expect(view.selectedProjectPath()).toBeUndefined();
  });

  it('renders and edits description beneath Name without creating a description column', async () => {
    const saveProperty = vi.fn().mockResolvedValue(undefined);
    const initial = project({ frontmatter: { description: 'First line\nSecond line' } });
    const { host, view } = mount([initial], { saveProperty });

    expect(host.querySelector('[data-column-id="description"]')).toBeNull();
    expect(host.querySelector('.abyss-project-description-text')?.textContent).toBe('First line');
    const nameCell = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="name"]'),
    );
    view.update([{ ...initial, frontmatter: { description: 'Updated\nRetained' } }]);
    expect(host.querySelector('.abyss-project-table-cell[data-column-id="name"]')).toBe(nameCell);
    expect(host.querySelector('.abyss-project-description-text')?.textContent).toBe('Updated');
    const edit = expectDefined(host.querySelector<HTMLElement>('.abyss-project-description-text'));
    expect(host.querySelector('.abyss-project-description-edit')).toBeNull();
    edit.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const textarea = expectDefined(
      host.querySelector<HTMLTextAreaElement>('.abyss-project-description-editor'),
    );
    expect(textarea.value).toBe('Updated\nRetained');
    textarea.value = 'Changed\nStill here';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
    );
    await flushMicrotasks();

    expect(saveProperty).toHaveBeenCalledWith(
      'Projects/A.md',
      expect.objectContaining({ id: 'description', property: 'description', type: 'text' }),
      'Changed\nStill here',
      'Updated\nRetained',
    );
  });

  it('focuses the Name cell on description click without opening an editor', () => {
    const { host } = mount([project({ frontmatter: { description: 'Existing' } })]);
    const other = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="start"]'),
    );
    const name = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="name"]'),
    );
    const description = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-description-text'),
    );
    other.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    description.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(activeDocument.activeElement).toBe(name);
    expect(name.classList.contains('is-selection-focus')).toBe(true);
    expect(host.querySelector('.abyss-project-description-editor')).toBeNull();
    expect(other.querySelector('.abyss-project-cell-editor')).toBeNull();
  });

  it('keeps an empty description out of the Name cell layout', () => {
    const { host } = mount([project({ frontmatter: {} })]);

    expect(host.querySelector('.abyss-project-description')).toBeNull();
    expect(host.querySelector('.abyss-project-description-edit')).toBeNull();
  });

  it('opens Edit description directly from a pointer context action', () => {
    const show = vi.spyOn(Menu.prototype, 'showAtMouseEvent');
    const { host } = mount([project({ frontmatter: { description: 'Existing' } })]);
    const description = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-description-text'),
    );
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });

    description.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(show).not.toHaveBeenCalled();
    expect(host.querySelector('.abyss-project-description-editor')).not.toBeNull();
  });

  it('opens status choices directly from a pointer context action', () => {
    const open = vi.spyOn(ProjectPropertySuggest.prototype, 'open');
    const { host } = mount([project({})]);
    const status = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="status"]'),
    );

    status.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));

    expect(status.querySelector('select')).toBeNull();
    expect(status.querySelector<HTMLInputElement>('.abyss-project-editor-status')).not.toBeNull();
    expect(open).toHaveBeenCalledOnce();
    const suggest = expectDefined(open.mock.instances[0]) as ProjectPropertySuggest;
    expect(suggest.getSuggestions('').map(({ label }) => label)).toEqual([
      'No status',
      ...DEFAULT_SETTINGS.projects.statuses.map(({ name }) => name),
    ]);
  });

  it('suppresses table focus while the native description menu owns keys and restores it on hide', () => {
    const show = vi.spyOn(Menu.prototype, 'showAtPosition');
    const { host } = mount([project({ frontmatter: {} })]);
    const name = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="name"]'),
    );
    name.focus();

    name.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true }),
    );

    expect(name.classList.contains('is-selection-focus')).toBe(false);
    (expectDefined(show.mock.instances[0]) as Menu).close();
    expect(activeDocument.activeElement).toBe(name);
    expect(name.classList.contains('is-selection-focus')).toBe(true);
  });

  it.each([
    ['ContextMenu', false],
    ['F10', true],
  ] as const)('opens Add description from Name with %s keyboard parity', (key, shiftKey) => {
    let title = '';
    let activate: (() => void) | undefined;
    vi.spyOn(Menu.prototype, 'addItem').mockImplementation(function (this: Menu, callback) {
      const item = {
        setTitle: (value: string) => {
          title = value;
          return item;
        },
        setIcon: () => item,
        onClick: (handler: () => void) => {
          activate = handler;
          return item;
        },
      };
      callback(item as never);
      return this;
    });
    const show = vi.spyOn(Menu.prototype, 'showAtPosition');
    const { host } = mount([project({ frontmatter: {} })]);
    const name = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="name"]'),
    );
    name.focus();
    const event = new KeyboardEvent('keydown', {
      key,
      shiftKey,
      bubbles: true,
      cancelable: true,
    });

    name.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(show).toHaveBeenCalledOnce();
    expect(title).toBe('Add description');
    expectDefined(activate)();
    expect(host.querySelector('.abyss-project-description-editor')).not.toBeNull();
  });

  it('hides description without leaving an extra Name line', () => {
    const config = settings();
    config.projects.table.showDescription = false;
    const { host } = mount([project({ frontmatter: { description: 'Hidden' } })], {
      settings: config,
    });

    expect(host.querySelector('.abyss-project-description')).toBeNull();
    expect(host.querySelector('.abyss-project-description-edit')).toBeNull();
  });

  it('uses one native searchable tag per value without a generic outer pill', () => {
    const config = settings();
    config.projects.table.columns.push({ id: 'property:Tags', visible: true });
    const { host } = mount([project({ frontmatter: { Tags: ['#work', '#next'] } })], {
      settings: config,
      catalog: catalog([{ name: 'Tags', type: 'tags' }]),
    });
    const property = expectDefined(
      host.querySelector<HTMLElement>(
        '[data-column-id="property:Tags"] .metadata-property-value[data-property-type="tags"]',
      ),
    );

    const tags = property.querySelectorAll<HTMLAnchorElement>('a.tag');
    expect(tags).toHaveLength(2);
    expect(property.querySelector('.abyss-project-table-value')).toBeNull();
    expect(property.querySelector('.multi-select-pill')).toBeNull();
    expect(tags[0]?.href).toContain('#work');
    expect(tags[0]?.textContent).toBe('#work');
    expect(tags[0]?.querySelector('button')).toBeNull();
  });

  it('reveals native tag remove controls on pointer and keyboard focus', async () => {
    const styles = await loadPluginStyles();

    expect(styles).toMatch(
      /\.abyss-projects-table\s+\.abyss-project-table-tag-value:hover\s+\.abyss-project-table-value-remove/u,
    );
    expect(styles).toMatch(
      /\.abyss-projects-table\s+\.abyss-project-table-tag-value:focus-within\s+\.abyss-project-table-value-remove/u,
    );
  });

  it('removes a scalar tag through the guarded list mutation', async () => {
    const config = settings();
    config.projects.table.columns.push({ id: 'property:Tags', visible: true });
    const applyEdits = vi.fn(
      async (_changes: readonly ProjectCellChange[]): Promise<ProjectEditResult> => ({
        applied: [],
        failed: [],
      }),
    );
    const { host } = mount([project({ frontmatter: { Tags: '#work' } })], {
      settings: config,
      catalog: catalog([{ name: 'Tags', type: 'tags' }]),
      applyEdits,
    });

    expectDefined(
      host.querySelector<HTMLButtonElement>(
        '[data-column-id="property:Tags"] .abyss-project-table-value-remove',
      ),
    ).click();
    await flushMicrotasks();

    expect(applyEdits).toHaveBeenCalledOnce();
    expect(applyEdits.mock.calls[0]?.[0]?.[0]).toMatchObject({
      value: [],
      expectedValue: '#work',
      expectedExists: true,
    });
  });

  it('finishes an active editor before delegating native tag activation', async () => {
    const config = settings();
    config.projects.table.columns.push({ id: 'property:Tags', visible: true });
    const saveProperty = vi.fn().mockResolvedValue(undefined);
    const setViewState = vi.fn().mockResolvedValue(undefined);
    const revealLeaf = vi.fn().mockResolvedValue(undefined);
    const app = new App();
    vi.spyOn(app.workspace, 'getLeavesOfType').mockReturnValue([
      {
        getViewState: () => ({ type: 'search', state: { matchingCase: true } }),
        setViewState,
      } as unknown as WorkspaceLeaf,
    ]);
    vi.spyOn(app.workspace, 'revealLeaf').mockImplementation(revealLeaf);
    const { host } = mount([project({ frontmatter: { description: 'Before', Tags: ['work'] } })], {
      app,
      settings: config,
      catalog: catalog([{ name: 'Tags', type: 'tags' }]),
      saveProperty,
    });
    expectDefined(host.querySelector<HTMLElement>('.abyss-project-description-text')).dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
    );
    const textarea = expectDefined(
      host.querySelector<HTMLTextAreaElement>('.abyss-project-description-editor'),
    );
    textarea.value = 'After';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    expectDefined(host.querySelector<HTMLAnchorElement>('a.tag')).click();
    await flushMicrotasks();

    expect(saveProperty).toHaveBeenCalledWith(
      'Projects/A.md',
      expect.objectContaining({ id: 'description' }),
      'After',
      'Before',
    );
    expect(setViewState).toHaveBeenCalledWith({
      type: 'search',
      active: true,
      state: { matchingCase: true, query: 'tag:#work' },
    });
    expect(revealLeaf).toHaveBeenCalledOnce();
    expect(expectDefined(saveProperty.mock.invocationCallOrder[0])).toBeLessThan(
      expectDefined(setViewState.mock.invocationCallOrder[0]),
    );
  });

  it.each([
    [undefined, false, 'true'],
    [true, true, 'false'],
    [false, false, 'false'],
  ] as const)('renders native checkbox state %#', (value, checked, indeterminate) => {
    const config = settings();
    config.projects.table.columns.push({ id: 'property:Flag', visible: true });
    const { host } = mount([project({ frontmatter: value === undefined ? {} : { Flag: value } })], {
      settings: config,
      catalog: catalog([{ name: 'Flag', type: 'checkbox' }]),
    });
    const checkbox = expectDefined(
      host.querySelector<HTMLInputElement>(
        '[data-column-id="property:Flag"] input.metadata-input-checkbox',
      ),
    );

    expect(checkbox.checked).toBe(checked);
    expect(checkbox.indeterminate).toBe(false);
    expect(checkbox.dataset['indeterminate']).toBe(indeterminate);
  });

  it('toggles an unset checkbox through history and restores native DOM after rejection', async () => {
    const config = settings();
    config.projects.table.columns.push({ id: 'property:Flag', visible: true });
    const applyEdits = vi.fn().mockRejectedValue(new Error('disk full'));
    const { host } = mount([project({ frontmatter: {} })], {
      settings: config,
      catalog: catalog([{ name: 'Flag', type: 'checkbox' }]),
      applyEdits,
    });
    const checkbox = expectDefined(
      host.querySelector<HTMLInputElement>(
        '[data-column-id="property:Flag"] input.metadata-input-checkbox',
      ),
    );

    checkbox.click();
    await flushMicrotasks();

    expect(applyEdits).toHaveBeenCalledWith([
      expect.objectContaining({ value: true, expectedValue: undefined }),
    ]);
    expect(checkbox.checked).toBe(false);
    expect(checkbox.indeterminate).toBe(false);
    expect(checkbox.dataset['indeterminate']).toBe('true');
  });

  it('clears a false checkbox through the shared mutation and history path', async () => {
    const config = settings();
    config.projects.table.columns.push({ id: 'property:Flag', visible: true });
    const applyEdits = vi.fn(async (changes: readonly ProjectCellChange[]) => ({
      applied: changes.map((change) => ({
        ...change,
        previousValue: false,
        sourceProperty: 'Flag',
        sourceKey: 'Flag',
        previousExists: true,
        appliedExists: false,
      })),
      failed: [],
    }));
    const history = new ProjectEditHistory(applyEdits);
    const { host } = mount([project({ frontmatter: { Flag: false } })], {
      settings: config,
      catalog: catalog([{ name: 'Flag', type: 'checkbox' }]),
      applyEdits,
      history,
    });
    const cell = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="property:Flag"]'),
      'Missing checkbox data cell',
    );
    cell.click();
    cell.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }),
    );
    await flushMicrotasks();

    expect(applyEdits).toHaveBeenCalledWith([
      expect.objectContaining({ value: undefined, expectedValue: false, expectedExists: true }),
    ]);
    expect(history.canUndo).toBe(true);
  });

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
    expect(
      expectDefined(
        host.querySelector<HTMLElement>(
          '[data-project-path="Projects/Zero.md"] .abyss-project-progress-percent',
        ),
      ).textContent,
    ).toBe('0%');
    for (const [path, percent] of [
      ['Low', '20%'],
      ['Quarter', '40%'],
      ['Half', '60%'],
      ['High', '80%'],
    ]) {
      expect(
        expectDefined(
          host.querySelector<HTMLElement>(
            `[data-project-path="Projects/${path}.md"] .abyss-project-progress-percent`,
          ),
        ).textContent,
      ).toBe(percent);
    }
  });

  it('patches available status badges in place while toggling their persisted filters', async () => {
    const { host, view, config, saveSettings } = mount([
      project({}),
      project({ path: 'Projects/U.md', name: 'Unknown', statusId: null, rawStatus: 'waiting' }),
      project({ path: 'Projects/N.md', name: 'None', statusId: null, rawStatus: null }),
    ]);
    const button = expectDefined(
      host.querySelector<HTMLButtonElement>(
        `.abyss-project-status-filter[data-status-key="id:${active.id}"]`,
      ),
    );

    button.focus();
    button.click();
    await flushMicrotasks();

    expect(config.projects.table.hiddenStatuses).toContain(`id:${active.id}`);
    expect(saveSettings).toHaveBeenCalledOnce();
    expect(host.querySelector('[data-status-key="raw:waiting"]')).not.toBeNull();
    expect(host.querySelector('[data-status-key="none"]')).not.toBeNull();
    expect(host.querySelectorAll('[data-project-path="Projects/A.md"]')).toHaveLength(0);
    expect(button.isConnected).toBe(true);
    expect(host.querySelector(`[data-status-key="id:${active.id}"]`)).toBe(button);
    expect(button.ownerDocument.activeElement).toBe(button);
    expect(
      host.querySelector(`[data-status-key="id:${active.id}"]`)?.classList.contains('is-disabled'),
    ).toBe(true);
    button.click();
    await flushMicrotasks();
    expect(config.projects.table.hiddenStatuses).not.toContain(`id:${active.id}`);
    expect(saveSettings).toHaveBeenCalledTimes(2);
    expect(button.textContent).toBe(active.displayName ?? active.name);

    const originalButtons = new Map(
      Array.from(
        host.querySelectorAll<HTMLButtonElement>('.abyss-project-status-filter'),
        (item) => [item.dataset['statusKey'], item],
      ),
    );
    config.projects.statuses.reverse();
    view.refreshFields();
    const reordered = Array.from(
      host.querySelectorAll<HTMLButtonElement>('.abyss-project-status-filter'),
    );
    expect(
      reordered.slice(0, config.projects.statuses.length).map((item) => item.dataset['statusKey']),
    ).toEqual(config.projects.statuses.map((status) => `id:${status.id}`));
    for (const item of reordered) {
      expect(item).toBe(originalButtons.get(item.dataset['statusKey']));
    }
  });

  it('renders the configured status as editable when the native catalog is unavailable', () => {
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
    expect(cell.querySelector('.abyss-project-table-unavailable')).toBeNull();
    expect(cell.classList.contains('is-editable')).toBe(true);
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
    expect(config.projects.table.sortBy).toEqual({ field: 'end', dir: 'asc' });
    header.click();
    await flushMicrotasks();
    expect(config.projects.table.sortBy).toEqual({ field: 'end', dir: 'desc' });
    header.click();
    await flushMicrotasks();
    expect(config.projects.table.sortBy).toEqual({ field: 'none', dir: 'asc' });
    expectDefined(host.querySelector<HTMLButtonElement>('.abyss-view-state-btn')).click();
    const sortRow = Array.from(host.querySelectorAll<HTMLElement>('.abyss-view-state-row')).find(
      (row) => row.querySelector('.abyss-view-state-row-label')?.textContent === 'Sort by',
    );
    expect(sortRow?.querySelector('.abyss-view-state-row-value')?.textContent).toBe('None');
    expectDefined(sortRow?.querySelector<HTMLButtonElement>('.abyss-view-state-row-main')).click();
    const activeNone = Array.from(
      expectDefined(sortRow).querySelectorAll<HTMLButtonElement>('.abyss-view-state-option'),
    ).find((option) => option.getAttribute('aria-pressed') === 'true');
    expect(activeNone?.textContent).toBe('None');
    const statusHeader = expectDefined(
      host.querySelector<HTMLButtonElement>(
        '[data-column-id="status"] .abyss-project-table-column-button',
      ),
    );
    statusHeader.click();
    await flushMicrotasks();
    expect(config.projects.table.sortBy).toEqual({ field: 'status', dir: 'asc' });
    expect(saveSettings).toHaveBeenCalledTimes(4);
  });

  it('commits a focused header rename once when Enter also causes blur', async () => {
    const show = vi.spyOn(Menu.prototype, 'showAtMouseEvent');
    const { host, config, saveSettings } = mount([project({})]);
    const header = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-header-cell[data-column-id="end"]'),
    );
    header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    activateMenuItem(lastShownMenu(show), 'Rename column');
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

  it('returns focus to the selected table cell when the column menu closes', () => {
    const show = vi.spyOn(Menu.prototype, 'showAtMouseEvent');
    const { host } = mount([project({})]);
    const selected = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="end"]'),
    );
    selected.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const header = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-header-cell[data-column-id="end"]'),
    );
    expectDefined(header.querySelector<HTMLButtonElement>('button')).focus();
    header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    lastShownMenu(show).close();

    expect(document.activeElement).toBe(selected);
  });

  it('restores table focus after an alignment change without revealing until arrow navigation', () => {
    const config = settings();
    config.projects.table.columns.push({ id: 'property:Labels', visible: true });
    config.projects.propertyDefinitions['property:Labels'] = { type: 'list' };
    const show = vi.spyOn(Menu.prototype, 'showAtMouseEvent');
    const { host } = mount(
      [project({ frontmatter: { start: '2026-09-01', end: '2026-09-30', Labels: ['Review'] } })],
      { settings: config, catalog: catalog([{ name: 'Labels', type: 'list' }]) },
    );
    const scroll = expectDefined(host.querySelector<HTMLElement>('.abyss-project-table-scroll'));
    const header = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-header-cell[data-column-id="name"]'),
    );
    const labelsHeader = expectDefined(
      host.querySelector<HTMLElement>(
        '.abyss-project-table-header-cell[data-column-id="property:Labels"]',
      ),
    );
    const stickyName = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-name-cell'),
    );
    const start = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="start"]'),
    );
    const end = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="end"]'),
    );
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(rectangle(0, 0, 800, 300));
    vi.spyOn(header, 'getBoundingClientRect').mockReturnValue(rectangle(0, 0, 220, 40));
    vi.spyOn(stickyName, 'getBoundingClientRect').mockReturnValue(rectangle(0, 40, 220, 70));
    vi.spyOn(start, 'getBoundingClientRect').mockImplementation(() =>
      rectangle(468 - scroll.scrollLeft, 40, 568 - scroll.scrollLeft, 70),
    );
    vi.spyOn(end, 'getBoundingClientRect').mockImplementation(() =>
      rectangle(1800 - scroll.scrollLeft, 40, 1900 - scroll.scrollLeft, 70),
    );
    start.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    scroll.scrollLeft = 898;
    expectDefined(labelsHeader.querySelector<HTMLButtonElement>('button')).focus();
    labelsHeader.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const rootMenu = lastShownMenu(show);

    activateMenuItem(submenu(rootMenu, 'Alignment'), 'Center');
    rootMenu.close();

    expect(document.activeElement).toBe(start);
    expect(scroll.scrollLeft).toBe(898);
    start.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(end);
    expect(scroll.scrollLeft).toBe(1100);
  });

  it('returns focus to the current header when an action replaces the header without a selection', () => {
    const show = vi.spyOn(Menu.prototype, 'showAtMouseEvent');
    const { host } = mount([project({})]);
    const oldHeader = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-header-cell[data-column-id="end"]'),
    );
    expectDefined(oldHeader.querySelector<HTMLButtonElement>('button')).focus();
    oldHeader.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const rootMenu = lastShownMenu(show);
    activateMenuItem(submenu(rootMenu, 'Alignment'), 'Center');
    rootMenu.close();

    const currentButton = expectDefined(
      host.querySelector<HTMLButtonElement>(
        '.abyss-project-table-header-cell[data-column-id="end"] .abyss-project-table-column-button',
      ),
    );
    expect(oldHeader.isConnected).toBe(false);
    expect(document.activeElement).toBe(currentButton);
  });

  it('exposes native column actions for exact sorting, alignment, type and date display', async () => {
    const config = settings();
    config.projects.table.columns.push({ id: 'property:Priority', visible: true });
    config.projects.table.columns.push({ id: 'property:Tags', visible: true });
    config.projects.propertyDefinitions['property:Priority'] = {
      type: 'text',
      presetsEnabled: true,
      presets: [{ value: 'high', displayName: 'High' }],
    };
    config.projects.propertyDefinitions['property:Tags'] = { type: 'tags' };
    const saveStatic = vi.fn().mockResolvedValue(undefined);
    const show = vi.spyOn(Menu.prototype, 'showAtMouseEvent');
    const { host, saveSettings } = mount(
      [project({ frontmatter: { start: '2026-09-01', end: '2026-09-30', Priority: 'high' } })],
      { settings: config, saveStatic },
    );
    const open = (columnId: string): Menu => {
      expectDefined(
        host.querySelector<HTMLElement>(
          `.abyss-project-table-header-cell[data-column-id="${columnId}"]`,
        ),
      ).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      return lastShownMenu(show);
    };

    const priorityMenu = open('property:Priority');
    expect(menuItems(priorityMenu).map(({ title__ }) => title__)).toEqual([
      'Sort ascending',
      'Sort descending',
      'Clear sorting',
      'Alignment',
      'Property type',
      'Rename column',
    ]);
    for (const fixedColumnId of ['name', 'status', 'progress', 'start', 'end', 'property:Tags']) {
      expect(
        menuItems(open(fixedColumnId)).some(({ title__ }) => title__ === 'Property type'),
      ).toBe(false);
    }
    activateMenuItem(priorityMenu, 'Sort descending');
    expect(config.projects.table.sortBy).toEqual({ field: 'property:Priority', dir: 'desc' });
    activateMenuItem(priorityMenu, 'Sort ascending');
    expect(config.projects.table.sortBy).toEqual({ field: 'property:Priority', dir: 'asc' });
    activateMenuItem(priorityMenu, 'Clear sorting');
    expect(config.projects.table.sortBy).toEqual({ field: 'none', dir: 'asc' });
    activateMenuItem(submenu(priorityMenu, 'Alignment'), 'Center');
    await flushMicrotasks();
    expect(
      config.projects.table.columns.find(({ id }) => id === 'property:Priority')?.alignment,
    ).toBe('center');

    activateMenuItem(submenu(priorityMenu, 'Property type'), 'Number');
    await flushMicrotasks();
    expect(config.projects.propertyDefinitions['property:Priority']).toEqual({
      type: 'number',
      presetsEnabled: true,
      presets: [{ value: 'high', displayName: 'High' }],
    });
    expect(saveStatic).toHaveBeenCalledOnce();

    const endMenu = open('end');
    const dateDisplay = submenu(endMenu, 'Date display');
    expect(menuItems(dateDisplay).map(({ title__ }) => title__)).toEqual([
      'Pretty',
      'Raw',
      'Relative',
    ]);
    expect(menuItem(dateDisplay, 'Pretty').checked).toBe(true);
    activateMenuItem(dateDisplay, 'Raw');
    await flushMicrotasks();
    expect(config.projects.table.columns.find(({ id }) => id === 'end')?.dateDisplay).toBe('raw');
    activateMenuItem(submenu(open('end'), 'Date display'), 'Pretty');
    await flushMicrotasks();
    expect(config.projects.table.columns.find(({ id }) => id === 'end')?.dateDisplay).toBe(
      'pretty',
    );
    activateMenuItem(submenu(open('end'), 'Date display'), 'Relative');
    await flushMicrotasks();
    expect(config.projects.table.columns.find(({ id }) => id === 'end')?.dateDisplay).toBe(
      'relative',
    );
    expect(saveSettings).toHaveBeenCalledTimes(7);
  });

  it('keeps a changed type visible after static save failure and retries the latest draft', async () => {
    const config = settings();
    config.projects.table.columns.push({ id: 'property:Priority', visible: true });
    config.projects.propertyDefinitions['property:Priority'] = { type: 'text' };
    const savedTypes: string[] = [];
    const saveStatic = vi.fn(async () => {
      savedTypes.push(config.projects.propertyDefinitions['property:Priority']?.type ?? 'missing');
      if (savedTypes.length === 1) throw new Error('disk full');
    });
    let noticeContent: DocumentFragment | undefined;
    const noticePrototype = Notice.prototype as unknown as {
      constructor__: (message: string | DocumentFragment, duration?: number) => HTMLElement;
    };
    vi.spyOn(noticePrototype, 'constructor__').mockImplementation((message) => {
      if (message instanceof DocumentFragment) noticeContent = message;
      return createDiv();
    });
    const show = vi.spyOn(Menu.prototype, 'showAtMouseEvent');
    const { host } = mount([project({ frontmatter: { Priority: 'high' } })], {
      settings: config,
      saveStatic,
    });
    expectDefined(
      host.querySelector<HTMLElement>(
        '.abyss-project-table-header-cell[data-column-id="property:Priority"]',
      ),
    ).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    activateMenuItem(submenu(lastShownMenu(show), 'Property type'), 'Number');
    await flushMicrotasks();

    expect(expectDefined(config.projects.propertyDefinitions['property:Priority']).type).toBe(
      'number',
    );
    expect(
      host.querySelector(
        '.abyss-project-table-header-cell[data-column-id="property:Priority"] [data-icon="binary"]',
      ),
    ).not.toBeNull();
    config.projects.propertyDefinitions['property:Priority'] = { type: 'date' };
    expectDefined(noticeContent?.querySelector<HTMLButtonElement>('button')).click();
    await flushMicrotasks();

    expect(savedTypes).toEqual(['number', 'date']);
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
    expect(config.projects.table.sortBy).toEqual({ field: 'start', dir: 'asc' });

    const resize = expectDefined(
      startHeader.querySelector<HTMLElement>('.abyss-project-column-resize'),
    );
    resize.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 100 }));
    startHeader.ownerDocument.dispatchEvent(new PointerEvent('pointermove', { clientX: 140 }));
    expect(
      host.querySelector<HTMLTableColElement>('col[data-column-id="start"]')?.style.width,
    ).toBe('290px');
    expect(host.querySelector<HTMLTableElement>('.abyss-project-table')?.style.width).toBe(
      '1040px',
    );
    startHeader.ownerDocument.dispatchEvent(new PointerEvent('pointerup', { clientX: 140 }));
    await flushMicrotasks();

    expect(config.projects.table.columns.map(({ id, width }) => [id, width])).toEqual([
      ['name', 260],
      ['status', 150],
      ['progress', 190],
      ['start', 290],
      ['end', 150],
    ]);
    expect(host.querySelector<HTMLTableElement>('.abyss-project-table')?.style.width).toBe(
      '1040px',
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
      '1000px',
    );
    expect(config.projects.table.sortBy).toEqual({ field: 'start', dir: 'asc' });
    expect(saveSettings).toHaveBeenCalledTimes(2);
  });

  it('keeps a full-width Name resize visible by transferring width to its neighbor', async () => {
    const { host, view, config, saveSettings } = mount([project({})]);
    const scroll = expectDefined(host.querySelector<HTMLElement>('.abyss-project-table-scroll'));
    Object.defineProperty(scroll, 'clientWidth', { value: 1000, configurable: true });
    view.update([project({})]);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const columnId = this.dataset['columnId'];
      const col =
        columnId === undefined
          ? null
          : host.querySelector<HTMLElement>(`col[data-column-id="${columnId}"]`);
      return { width: Number.parseFloat(col?.style.width ?? '0') } as DOMRect;
    });
    const nameHeader = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-header-cell[data-column-id="name"]'),
    );
    const resize = expectDefined(
      nameHeader.querySelector<HTMLElement>('.abyss-project-column-resize'),
    );
    expect(host.querySelector<HTMLElement>('col[data-column-id="name"]')?.style.width).toBe(
      '360px',
    );

    resize.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 100 }));
    nameHeader.ownerDocument.dispatchEvent(new PointerEvent('pointerup', { clientX: 100 }));
    await flushMicrotasks();
    expect(config.projects.table.columns.find(({ id }) => id === 'name')?.width).toBeUndefined();
    expect(saveSettings).not.toHaveBeenCalled();

    resize.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 100 }));
    nameHeader.ownerDocument.dispatchEvent(new PointerEvent('pointermove', { clientX: 50 }));
    expect(host.querySelector<HTMLElement>('col[data-column-id="name"]')?.style.width).toBe(
      '310px',
    );
    expect(host.querySelector<HTMLElement>('col[data-column-id="status"]')?.style.width).toBe(
      '200px',
    );
    nameHeader.ownerDocument.dispatchEvent(new PointerEvent('pointerup', { clientX: 50 }));
    await flushMicrotasks();

    expect(config.projects.table.columns.find(({ id }) => id === 'name')?.width).toBe(310);
    expect(config.projects.table.columns.find(({ id }) => id === 'status')?.width).toBe(200);
    expect(saveSettings).toHaveBeenCalledOnce();

    const currentHeader = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-header-cell[data-column-id="name"]'),
    );
    const currentResize = expectDefined(
      currentHeader.querySelector<HTMLElement>('.abyss-project-column-resize'),
    );
    currentResize.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 50 }));
    currentHeader.ownerDocument.dispatchEvent(new PointerEvent('pointermove', { clientX: 20 }));
    currentHeader.ownerDocument.dispatchEvent(new PointerEvent('pointercancel', { clientX: 20 }));
    await flushMicrotasks();

    expect(host.querySelector<HTMLElement>('col[data-column-id="name"]')?.style.width).toBe(
      '310px',
    );
    expect(host.querySelector<HTMLElement>('col[data-column-id="status"]')?.style.width).toBe(
      '200px',
    );
    expect(saveSettings).toHaveBeenCalledOnce();

    currentResize.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 50 }));
    currentHeader.ownerDocument.dispatchEvent(new PointerEvent('pointermove', { clientX: 20 }));
    expect(
      expectDefined(host.querySelector<HTMLElement>('col[data-column-id="name"]')).style.width,
    ).toBe('280px');
    const escape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    currentHeader.ownerDocument.dispatchEvent(escape);
    await flushMicrotasks();

    expect(escape.defaultPrevented).toBe(true);
    expect(
      expectDefined(host.querySelector<HTMLElement>('col[data-column-id="name"]')).style.width,
    ).toBe('310px');
    expect(
      expectDefined(host.querySelector<HTMLElement>('col[data-column-id="status"]')).style.width,
    ).toBe('200px');
    expect(saveSettings).toHaveBeenCalledOnce();
  });

  it('keeps a lone Name column at viewport width while allowing manual overflow growth', async () => {
    const { host, view, config, saveSettings } = mount([project({})]);
    for (const column of config.projects.table.columns) {
      column.visible = column.id === 'name';
    }
    const scroll = expectDefined(host.querySelector<HTMLElement>('.abyss-project-table-scroll'));
    Object.defineProperty(scroll, 'clientWidth', { value: 500, configurable: true });
    view.update([project({})]);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const columnId = this.dataset['columnId'];
      const col =
        columnId === undefined
          ? null
          : host.querySelector<HTMLElement>(`col[data-column-id="${columnId}"]`);
      return { width: Number.parseFloat(col?.style.width ?? '0') } as DOMRect;
    });
    const nameHeader = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-header-cell[data-column-id="name"]'),
    );
    const resize = expectDefined(
      nameHeader.querySelector<HTMLElement>('.abyss-project-column-resize'),
    );

    resize.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 100 }));
    nameHeader.ownerDocument.dispatchEvent(new PointerEvent('pointermove', { clientX: 20 }));
    expect(host.querySelector<HTMLElement>('col[data-column-id="name"]')?.style.width).toBe(
      '500px',
    );
    nameHeader.ownerDocument.dispatchEvent(new PointerEvent('pointermove', { clientX: 140 }));
    expect(host.querySelector<HTMLElement>('col[data-column-id="name"]')?.style.width).toBe(
      '540px',
    );
    nameHeader.ownerDocument.dispatchEvent(new PointerEvent('pointerup', { clientX: 140 }));
    await flushMicrotasks();

    expect(config.projects.table.columns.find(({ id }) => id === 'name')?.width).toBe(540);
    expect(host.querySelector<HTMLTableElement>('.abyss-project-table')?.style.width).toBe('540px');
    expect(saveSettings).toHaveBeenCalledOnce();

    const grownHeader = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-header-cell[data-column-id="name"]'),
    );
    expectDefined(
      grownHeader.querySelector<HTMLElement>('.abyss-project-column-resize'),
    ).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 140 }));
    grownHeader.ownerDocument.dispatchEvent(new PointerEvent('pointermove', { clientX: 100 }));
    grownHeader.ownerDocument.dispatchEvent(new PointerEvent('pointerup', { clientX: 100 }));
    await flushMicrotasks();

    expect(config.projects.table.columns.find(({ id }) => id === 'name')?.width).toBe(500);
    expect(host.querySelector<HTMLTableElement>('.abyss-project-table')?.style.width).toBe('500px');
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

    expect(config.projects.table.sortBy).toEqual({ field: 'start', dir: 'asc' });
    expect(saveSettings).toHaveBeenCalledTimes(3);
  });

  it('shows one valid column drop boundary and clears renderer-owned feedback', () => {
    const { host, view } = mount([project({})]);
    const source = expectDefined(host.querySelector<HTMLElement>('th[data-column-id="status"]'));
    const target = expectDefined(host.querySelector<HTMLElement>('th[data-column-id="start"]'));
    const name = expectDefined(host.querySelector<HTMLElement>('th[data-column-id="name"]'));
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(rectangle(100, 0, 200, 34));
    const data = transfer();
    source.dispatchEvent(dragEvent('dragstart', data));

    const before = new MouseEvent('dragover', {
      bubbles: true,
      cancelable: true,
      clientX: 125,
    });
    Object.defineProperty(before, 'dataTransfer', { value: data });
    target.dispatchEvent(before);
    expect(before.defaultPrevented).toBe(true);
    expect(target.classList.contains('is-drop-before')).toBe(true);
    expect(host.querySelectorAll('.is-drop-before, .is-drop-after')).toHaveLength(1);

    const after = new MouseEvent('dragover', {
      bubbles: true,
      cancelable: true,
      clientX: 175,
    });
    Object.defineProperty(after, 'dataTransfer', { value: data });
    target.dispatchEvent(after);
    expect(target.classList.contains('is-drop-before')).toBe(false);
    expect(target.classList.contains('is-drop-after')).toBe(true);
    expect(host.querySelectorAll('.is-drop-before, .is-drop-after')).toHaveLength(1);

    const leave = dragEvent('dragleave', data);
    Object.defineProperty(leave, 'relatedTarget', { value: document.body });
    target.dispatchEvent(leave);
    expect(host.querySelector('.is-drop-before, .is-drop-after')).toBeNull();

    target.dispatchEvent(after);
    source.dispatchEvent(dragEvent('dragend', data));
    expect(host.querySelector('.is-drop-before, .is-drop-after')).toBeNull();

    source.dispatchEvent(dragEvent('dragstart', data));
    const selfOver = dragEvent('dragover', data);
    source.dispatchEvent(selfOver);
    expect(selfOver.defaultPrevented).toBe(false);
    expect(source.matches('.is-drop-before, .is-drop-after')).toBe(false);
    source.dispatchEvent(dragEvent('dragend', data));

    const invalid = transfer({ 'text/abyss-project-column': 'name' });
    const invalidOver = new MouseEvent('dragover', {
      bubbles: true,
      cancelable: true,
      clientX: 125,
    });
    Object.defineProperty(invalidOver, 'dataTransfer', { value: invalid });
    target.dispatchEvent(invalidOver);
    expect(invalidOver.defaultPrevented).toBe(false);
    expect(target.matches('.is-drop-before, .is-drop-after')).toBe(false);

    const nameOver = dragEvent('dragover', data);
    name.dispatchEvent(nameOver);
    expect(nameOver.defaultPrevented).toBe(false);
    expect(name.matches('.is-drop-before, .is-drop-after')).toBe(false);

    source.dispatchEvent(dragEvent('dragstart', data));
    target.dispatchEvent(before);
    destroyMountedView(view);
    expect(target.classList.contains('is-drop-before')).toBe(false);
  });

  it('clears the column boundary after a drop applies the advertised placement', async () => {
    const { host, config } = mount([project({})]);
    const source = expectDefined(host.querySelector<HTMLElement>('th[data-column-id="status"]'));
    const target = expectDefined(host.querySelector<HTMLElement>('th[data-column-id="progress"]'));
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(rectangle(100, 0, 200, 34));
    const data = transfer();
    source.dispatchEvent(dragEvent('dragstart', data));
    const over = new MouseEvent('dragover', {
      bubbles: true,
      cancelable: true,
      clientX: 175,
    });
    Object.defineProperty(over, 'dataTransfer', { value: data });
    target.dispatchEvent(over);
    expect(target.classList.contains('is-drop-after')).toBe(true);

    const drop = new MouseEvent('drop', { bubbles: true, cancelable: true, clientX: 175 });
    Object.defineProperty(drop, 'dataTransfer', { value: data });
    target.dispatchEvent(drop);
    await flushMicrotasks();

    expect(host.querySelector('.is-drop-before, .is-drop-after')).toBeNull();
    expect(config.projects.table.columns.map(({ id }) => id)).toEqual([
      'name',
      'progress',
      'status',
      'start',
      'end',
    ]);
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
    expect(config.projects.table.sortBy).toEqual({ field: 'start', dir: 'asc' });
    expect(config.projects.table.hiddenStatuses).toEqual([]);
    expect(host.querySelector('.abyss-view-state-reset-btn')).toBeNull();
  });

  it('marks Start as the default project sort option and lets the toolbar clear sorting', async () => {
    const { host, config } = mount([project({})]);
    expectDefined(host.querySelector<HTMLButtonElement>('.abyss-view-state-btn')).click();
    const sortRow = Array.from(host.querySelectorAll<HTMLElement>('.abyss-view-state-row')).find(
      (row) => row.querySelector('.abyss-view-state-row-label')?.textContent === 'Sort by',
    );
    expectDefined(sortRow).querySelector<HTMLButtonElement>('.abyss-view-state-row-main')?.click();
    const defaultBadge = expectDefined(
      sortRow?.querySelector<HTMLElement>('.abyss-view-state-option-default'),
    );

    expect(defaultBadge.parentElement?.textContent).toContain('Start');
    expect(defaultBadge.parentElement?.textContent).not.toContain('End');
    const none = Array.from(
      expectDefined(sortRow).querySelectorAll<HTMLButtonElement>('.abyss-view-state-option'),
    ).find((option) => option.textContent === 'None');
    expectDefined(none).click();
    await flushMicrotasks();
    expect(config.projects.table.sortBy).toEqual({ field: 'none', dir: 'asc' });
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

    const contextEvent = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    link.dispatchEvent(contextEvent);
    expect(contextEvent.defaultPrevented).toBe(true);
    expect(host.querySelectorAll('.abyss-project-cell-editor')).toHaveLength(1);
  });

  it('shows the basename for an unaliased folder wikilink while retaining its target', async () => {
    vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, _markdown, holder) => {
      const anchor = holder.createEl('a', {
        cls: 'internal-link',
      });
      anchor.setText(['Work Notes QA', 'Milestone'].join('/'));
      anchor.setAttribute('data-href', 'Work Notes QA/Milestone');
    });
    const config = settings();
    config.projects.table.columns.push({ id: 'property:creator', visible: true });
    const { host } = mount([project({ frontmatter: { creator: '[[Work Notes QA/Milestone]]' } })], {
      settings: config,
      catalog: catalog([{ name: 'creator', type: 'text' }]),
    });

    await new Promise((resolve) => window.setTimeout(resolve, 0));
    const link = expectDefined(
      host.querySelector<HTMLAnchorElement>('[data-column-id="property:creator"] a.internal-link'),
    );
    expect(link.textContent).toBe('Milestone');
    expect(link.dataset['href']).toBe('Work Notes QA/Milestone');
    expect(link.closest('.is-link')).not.toBeNull();
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

    expectDefined(toggle.closest('td')).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelectorAll('.abyss-project-table-row')).toHaveLength(0);
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

  it('reconciles filter, collapse, and value updates without replacing surviving table nodes', () => {
    const config = settings();
    config.projects.table.groupBy = 'property:Owner';
    config.projects.table.columns.push({ id: 'property:Owner', visible: true });
    const alpha = project({
      path: 'Projects/A.md',
      name: 'Alpha',
      frontmatter: { Owner: 'One', start: '2026-09-01', end: '2026-09-30' },
    });
    const beta = project({
      path: 'Projects/B.md',
      name: 'Beta',
      frontmatter: { Owner: 'Two', start: '2026-09-02', end: '2026-09-30' },
    });
    const { host, view } = mount([alpha, beta], {
      settings: config,
      catalog: catalog([{ name: 'Owner', type: 'text' }]),
    });
    const tableBefore = expectDefined(host.querySelector<HTMLTableElement>('table'));
    const headerBefore = expectDefined(tableBefore.querySelector('thead'));
    const alphaRowBefore = expectDefined(
      host.querySelector<HTMLElement>('[data-project-path="Projects/A.md"]'),
    );
    const betaRowBefore = expectDefined(
      host.querySelector<HTMLElement>('[data-project-path="Projects/B.md"]'),
    );
    const betaStartBefore = expectDefined(
      betaRowBefore.querySelector<HTMLElement>('[data-column-id="start"]'),
    );

    const search = expectDefined(host.querySelector<HTMLInputElement>('.abyss-center-search'));
    search.value = 'Beta';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    expect(host.querySelector('table')).toBe(tableBefore);
    expect(host.querySelector('thead')).toBe(headerBefore);
    expect(host.querySelector('[data-project-path="Projects/B.md"]')).toBe(betaRowBefore);
    search.value = '';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    expect(host.querySelector('[data-project-path="Projects/A.md"]')).not.toBe(alphaRowBefore);
    expect(host.querySelector('[data-project-path="Projects/B.md"]')).toBe(betaRowBefore);

    view.update([alpha, { ...beta, frontmatter: { ...beta.frontmatter, start: '2026-10-03' } }]);
    const betaRowAfterUpdate = expectDefined(
      host.querySelector<HTMLElement>('[data-project-path="Projects/B.md"]'),
    );
    expect(betaRowAfterUpdate).toBe(betaRowBefore);
    const betaStartAfterUpdate = expectDefined(
      betaRowAfterUpdate.querySelector<HTMLElement>('[data-column-id="start"]'),
    );
    expect(betaStartAfterUpdate).toBe(betaStartBefore);
    expect(betaStartAfterUpdate.textContent).toContain('Oct 3, 2026');
    const alphaRowAfterFilter = expectDefined(
      host.querySelector<HTMLElement>('[data-project-path="Projects/A.md"]'),
    );

    const betaGroup = expectDefined(betaRowBefore.previousElementSibling as HTMLElement | null);
    expectDefined(
      betaGroup.querySelector<HTMLButtonElement>('.abyss-project-table-group-toggle'),
    ).click();
    expect(host.querySelector('table')).toBe(tableBefore);
    expect(host.querySelector('thead')).toBe(headerBefore);
    expect(host.querySelector('[data-project-path="Projects/A.md"]')).toBe(alphaRowAfterFilter);
    expectDefined(
      betaGroup.querySelector<HTMLButtonElement>('.abyss-project-table-group-toggle'),
    ).click();
    expect(host.querySelector('[data-project-path="Projects/A.md"]')).toBe(alphaRowAfterFilter);
    expect(
      host.querySelector('[data-project-path="Projects/B.md"] [data-column-id="start"]')
        ?.textContent,
    ).toContain('Oct 3, 2026');
  });

  it('opens the current retained cell on context click exactly once', async () => {
    const first = project({
      frontmatter: { status: active.name, start: '2026-09-01', end: '2026-09-30' },
    });
    const saveProperty = vi.fn().mockResolvedValue(undefined);
    const { host, view } = mount([first], { saveProperty });
    const cell = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="start"]'),
    );
    view.update([{ ...first, frontmatter: { ...first.frontmatter, start: '2026-10-04' } }]);
    const contextEvent = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    cell.dispatchEvent(contextEvent);
    expect(contextEvent.defaultPrevented).toBe(true);
    const input = expectDefined(cell.querySelector<HTMLInputElement>('input[type="date"]'));
    expect(input.value).toBe('2026-10-04');

    cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(cell.querySelectorAll('.abyss-project-cell-editor')).toHaveLength(1);
    input.value = '2026-10-05';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushMicrotasks();
    expect(saveProperty).toHaveBeenCalledWith(
      'Projects/A.md',
      expect.anything(),
      '2026-10-05',
      '2026-10-04',
    );
    await vi.waitFor(() => {
      expect(cell.querySelector('.abyss-project-cell-editor')).toBeNull();
    });
    expect(cell.isConnected).toBe(true);
    expect(host.querySelector('.abyss-project-table-cell[data-column-id="start"]')).toBe(cell);

    cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const nextInput = expectDefined(cell.querySelector<HTMLInputElement>('input[type="date"]'));
    expect(nextInput.value).toBe('2026-10-05');
    nextInput.value = '2026-10-06';
    nextInput.dispatchEvent(new Event('input', { bubbles: true }));
    nextInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushMicrotasks();
    expect(saveProperty).toHaveBeenNthCalledWith(
      2,
      'Projects/A.md',
      expect.anything(),
      '2026-10-06',
      '2026-10-05',
    );
  });

  it('creates a project from the inline footer control', async () => {
    const createProject = vi.fn().mockResolvedValue('Projects/Fresh project.md');
    const { host } = mount([project({})], { createProject });
    expectDefined(host.querySelector<HTMLButtonElement>('.abyss-projects-new')).click();
    const input = expectDefined(
      host.querySelector<HTMLInputElement>('.abyss-project-creation-name'),
    );
    input.value = 'Fresh project';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushMicrotasks();

    expect(createProject).toHaveBeenCalledWith({
      name: 'Fresh project',
      statusId: active.id,
    });
    expect(host.querySelector('.abyss-project-creation-composer')).toBeNull();
  });

  it('keeps creation failure feedback inside the absolute composer', async () => {
    const createProject = vi.fn().mockRejectedValue(
      new ProjectCreationError('status failed', {
        createdPath: 'Projects/Fresh project.md',
        phase: 'status',
        statusId: active.id,
        cause: new Error('disk full'),
      }),
    );
    const { host } = mount([project({})], { createProject });
    expectDefined(host.querySelector<HTMLButtonElement>('.abyss-projects-new')).click();
    const input = expectDefined(
      host.querySelector<HTMLInputElement>('.abyss-project-creation-name'),
    );
    input.value = 'Fresh project';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushMicrotasks();

    expect(host.querySelector('.abyss-project-table-feedback')?.textContent).toBe('');
    expect(host.querySelector('.abyss-project-creation-error')?.textContent).toBe('disk full');
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
    ).toContain('Oct 10, 2026');
    destroyMountedView(view);
  });

  it('positions an editor host before focusing its control', () => {
    const { host } = mount([project({})]);
    const cell = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="start"]'),
    );
    let sideAtFocus: string | undefined;
    host.addEventListener('focusin', (event) => {
      if (!(event.target instanceof HTMLInputElement)) return;
      sideAtFocus = event.target.closest<HTMLElement>('.abyss-project-cell-editor-host')?.dataset[
        'side'
      ];
    });

    cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

    expect(activeDocument.activeElement).toBe(cell.querySelector('input'));
    expect(sideAtFocus).toBe('aligned');
  });

  it('keeps a bottom-edge description editor clear of its Name title', () => {
    const { host } = mount([project({ frontmatter: { description: 'Existing' } })]);
    const scroll = expectDefined(host.querySelector<HTMLElement>('.abyss-project-table-scroll'));
    const header = expectDefined(host.querySelector<HTMLElement>('.abyss-project-table thead'));
    const cell = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="name"]'),
    );
    const title = expectDefined(cell.querySelector<HTMLElement>('.abyss-project-table-name'));
    const description = expectDefined(
      cell.querySelector<HTMLButtonElement>('.abyss-project-description-text'),
    );
    const anchor = expectDefined(description.parentElement);
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, value: 220 },
      clientWidth: { configurable: true, value: 500 },
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this === scroll) return rectangle(0, 0, 500, 220);
      if (this === header) return rectangle(0, 0, 500, 34);
      if (this === cell) return rectangle(0, 170, 220, 204);
      if (this === title) return rectangle(8, 174, 212, 190);
      if (this === anchor) return rectangle(8, 190, 212, 204);
      if (this.classList.contains('abyss-project-cell-editor-host')) {
        return rectangle(0, 0, Number.parseFloat(this.style.width), 60);
      }
      return rectangle(0, 0, 0, 0);
    });

    cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));

    const editor = expectDefined(
      anchor.querySelector<HTMLElement>('.abyss-project-cell-editor-host'),
    );
    const editorTop = 190 + Number.parseFloat(editor.style.top);
    expect(editor.dataset['side']).toBe('above');
    expect(editorTop + 60).toBeLessThanOrEqual(170);
  });

  it('keeps the editor bounded when its description avoid target is below the pane', () => {
    const boundary = freshContainer();
    document.body.appendChild(boundary);
    const avoid = boundary.createDiv();
    const anchor = avoid.createDiv();
    const editor = anchor.createDiv();
    Object.defineProperties(boundary, {
      clientHeight: { configurable: true, value: 220 },
      clientWidth: { configurable: true, value: 500 },
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this === boundary) return rectangle(0, 0, 500, 220);
      if (this === avoid) return rectangle(0, 260, 220, 294);
      if (this === anchor) return rectangle(8, 280, 212, 294);
      if (this === editor) return rectangle(0, 0, Number.parseFloat(this.style.width), 60);
      return rectangle(0, 0, 0, 0);
    });

    const cleanup = mountProjectCellEditorPosition({ anchor, host: editor, boundary, avoid });

    const editorTop = 280 + Number.parseFloat(editor.style.top);
    expect(editor.dataset['side']).toBe('aligned');
    expect(editorTop).toBeGreaterThanOrEqual(8);
    expect(editorTop + 60).toBeLessThanOrEqual(212);
    cleanup();
  });

  it('keeps a bottom-right long-list editor within the visible pane and releases positioning', () => {
    const suggestionClose = vi.spyOn(ProjectPropertySuggest.prototype, 'close');
    const resizeObservers: Array<{
      readonly targets: Element[];
      readonly disconnect: ReturnType<typeof vi.fn>;
      trigger(): void;
    }> = [];
    class TestResizeObserver {
      readonly targets: Element[] = [];
      readonly disconnect = vi.fn();
      constructor(private readonly callback: ResizeObserverCallback) {
        resizeObservers.push(this);
      }
      observe(target: Element): void {
        this.targets.push(target);
      }
      trigger(): void {
        this.callback([], this as unknown as ResizeObserver);
      }
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    const config = settings();
    config.projects.table.columns.push({ id: 'property:Owners', visible: true });
    const owners = Array.from({ length: 20 }, (_, index) => `Owner ${String(index + 1)}`);
    const { host } = mount([project({ frontmatter: { Owners: owners } })], {
      settings: config,
      catalog: catalog([{ name: 'Owners', type: 'list' }]),
    });
    const scroll = expectDefined(host.querySelector<HTMLElement>('.abyss-project-table-scroll'));
    const header = expectDefined(host.querySelector<HTMLElement>('.abyss-project-table thead'));
    const row = expectDefined(host.querySelector<HTMLElement>('.abyss-project-table-row'));
    const cell = expectDefined(
      host.querySelector<HTMLElement>(
        '.abyss-project-table-cell[data-column-id="property:Owners"]',
      ),
    );
    let paneRight = 480;
    let paneClientWidth = 417;
    let cellLeft = 385;
    let cellRight = 605;
    const measuredEditorHeight = cell.getBoundingClientRect().height;
    const editorNaturalHeight = measuredEditorHeight > 0 ? measuredEditorHeight : 34;
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, get: () => 457 },
      clientWidth: { configurable: true, get: () => paneClientWidth },
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this === scroll) return rectangle(48, 137, paneRight, 609);
      if (this === header) return rectangle(-410, 137, 1175, 171);
      if (this === cell) return rectangle(cellLeft, 557, cellRight, 591);
      if (this === row) return rectangle(48, 557, paneRight, 591);
      if (this.classList.contains('abyss-project-cell-editor-host')) {
        return rectangle(
          0,
          0,
          positiveStylePixels(this.style.width, 150),
          cappedStylePixels(this.style.maxHeight, editorNaturalHeight),
        );
      }
      return rectangle(0, 0, 0, 0);
    });
    scroll.scrollTop = 137;
    const rowBefore = row.getBoundingClientRect();
    const tableWidth = expectDefined(host.querySelector<HTMLTableElement>('table')).style.width;

    cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));

    const editorHost = expectDefined(
      cell.querySelector<HTMLElement>('.abyss-project-cell-editor-host'),
    );
    const positionObserver = expectDefined(
      resizeObservers.find(({ targets }) => targets.includes(editorHost)),
    );
    positionObserver.trigger();
    expect(editorHost.dataset['side']).toBe('aligned');
    expect(suggestionClose).not.toHaveBeenCalled();
    expect(editorHost.style.width).toBe('220px');
    expect(editorHost.style.maxHeight).toBe('407px');
    expect(editorHost.style.getPropertyValue('--abyss-project-editor-content-max-height')).toBe(
      '407px',
    );
    const positionedLeft = cellLeft + Number.parseFloat(editorHost.style.left);
    const positionedTop = 557 + Number.parseFloat(editorHost.style.top);
    expect(positionedLeft).toBeGreaterThanOrEqual(48 + 8);
    expect(positionedLeft + Number.parseFloat(editorHost.style.width)).toBeLessThanOrEqual(
      48 + paneClientWidth - 8,
    );
    expect(positionedTop).toBeGreaterThanOrEqual(171 + 8);
    expect(positionedTop + editorNaturalHeight).toBeLessThanOrEqual(137 + 457 - 8);
    expect(row.getBoundingClientRect()).toEqual(rowBefore);
    expect(scroll.scrollTop).toBe(137);
    expect(expectDefined(host.querySelector<HTMLTableElement>('table')).style.width).toBe(
      tableWidth,
    );

    positionObserver.trigger();
    expect(editorHost.dataset['side']).toBe('aligned');

    paneRight = 140;
    paneClientWidth = 77;
    cellLeft = 100;
    cellRight = 140;
    activeWindow.dispatchEvent(new Event('resize'));
    expect(editorHost.style.width).toBe('40px');
    expect(suggestionClose).toHaveBeenCalledOnce();
    const constrainedLeft = cellLeft + Number.parseFloat(editorHost.style.left);
    expect(constrainedLeft).toBeGreaterThanOrEqual(48 + 8);
    expect(constrainedLeft + Number.parseFloat(editorHost.style.width)).toBeLessThanOrEqual(
      48 + paneClientWidth - 8,
    );

    expectDefined(editorHost.querySelector<HTMLInputElement>('input')).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    expect(positionObserver.disconnect).toHaveBeenCalledOnce();
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
    expect(config.projects.table.sortBy).toEqual({ field: 'start', dir: 'asc' });
    expect(config.projects.table.hiddenStatuses).toEqual([]);

    draft.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(config.projects.table.hiddenStatuses).toEqual([`id:${active.id}`]);
    expect(config.projects.table.sortBy).toEqual({ field: 'start', dir: 'asc' });
    expect(host.querySelectorAll('.abyss-project-table-row')).toHaveLength(0);
    destroyMountedView(view);
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
    end.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
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
    cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
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
    cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const input = expectDefined(cell.querySelector<HTMLInputElement>('input[type="text"]'));
    input.value = '';

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    await flushMicrotasks();

    const rendered = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="property:Owner"]'),
    );
    expect(rendered.textContent).toBe('—');
    rendered.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(expectDefined(rendered.querySelector<HTMLInputElement>('input')).value).toBe('');
  });

  it('retains A receipt through an unrelated B snapshot until A source is observed', async () => {
    const config = settings();
    config.projects.table.columns.push({ id: 'property:Owner', visible: true });
    const staleA = project({
      path: 'Projects/A.md',
      name: 'A',
      frontmatter: { Owner: 'Original' },
    });
    const originalB = project({
      path: 'Projects/B.md',
      name: 'B',
      frontmatter: { Owner: 'B original' },
    });
    const { host, view } = mount([staleA, originalB], {
      settings: config,
      catalog: catalog([{ name: 'Owner', type: 'text' }]),
    });
    const ownerCell = (path: string): HTMLElement =>
      expectDefined(
        host.querySelector<HTMLElement>(
          `[data-project-path="${path}"] [data-column-id="property:Owner"]`,
        ),
      );
    const cell = ownerCell('Projects/A.md');
    cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const input = expectDefined(cell.querySelector<HTMLInputElement>('input'));
    input.value = 'Saved';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    await flushMicrotasks();

    view.update([
      staleA,
      project({
        path: 'Projects/B.md',
        name: 'B',
        frontmatter: { Owner: 'B changed' },
      }),
    ]);

    const projected = ownerCell('Projects/A.md');
    expect(projected.textContent).toBe('Saved');
    projected.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(expectDefined(projected.querySelector<HTMLInputElement>('input')).value).toBe('Saved');
    expectDefined(projected.querySelector<HTMLInputElement>('input')).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );

    const savedA = project({
      path: 'Projects/A.md',
      name: 'A',
      frontmatter: { Owner: 'Saved' },
    });
    view.observeProjectSource({ path: savedA.path, revision: 1, project: savedA });
    view.update([savedA, originalB]);
    expect(ownerCell('Projects/A.md').textContent).toBe('Saved');
    view.observeProjectSource({ path: staleA.path, revision: 2, project: staleA });
    view.update([staleA, originalB]);
    expect(ownerCell('Projects/A.md').textContent).toBe('Original');
  });

  it('keeps the latest receipt when an older differing source is observed during its mutation', async () => {
    const config = settings();
    config.projects.table.columns.push({ id: 'property:Owner', visible: true });
    const oldA = project({ frontmatter: { Owner: 'First' } });
    const viewRef: { current?: ProjectsTableView } = {};
    const applyEdits = vi.fn(
      async (changes: readonly ProjectCellChange[]): Promise<ProjectEditResult> => {
        const change = expectDefined(changes[0]);
        const currentView = expectDefined(viewRef.current);
        currentView.observeProjectSource({ path: oldA.path, revision: 2, project: oldA });
        currentView.update([oldA]);
        return {
          applied: [
            {
              ...change,
              value: 'Second',
              previousValue: 'First',
              sourceProperty: 'Owner',
              sourceKey: 'Owner',
              previousExists: true,
              appliedExists: true,
            },
          ],
          failed: [],
        };
      },
    );
    const mounted = mount([oldA], {
      settings: config,
      catalog: catalog([{ name: 'Owner', type: 'text' }]),
      applyEdits,
    });
    viewRef.current = mounted.view;
    mounted.view.observeProjectSource({ path: oldA.path, revision: 1, project: oldA });
    const cell = expectDefined(
      mounted.host.querySelector<HTMLElement>(
        '.abyss-project-table-row [data-column-id="property:Owner"]',
      ),
    );
    expect(cell.hasClass('is-editable')).toBe(true);
    cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const input = expectDefined(cell.querySelector<HTMLInputElement>('input'));
    input.value = 'Second';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    await flushMicrotasks();

    expect(
      expectDefined(
        mounted.host.querySelector<HTMLElement>(
          '.abyss-project-table-row [data-column-id="property:Owner"]',
        ),
      ).textContent,
    ).toBe('Second');
  });

  it('revalidates a first-path external source observed before receipt publication', async () => {
    const config = settings();
    config.projects.table.columns.push({ id: 'property:Owner', visible: true });
    const original = project({ frontmatter: { Owner: 'Original' } });
    const external = project({ frontmatter: { Owner: 'External' } });
    const viewRef: { current?: ProjectsTableView } = {};
    const revalidateSourceObservation = vi.fn().mockResolvedValue(true);
    const applyEdits = vi.fn(
      async (changes: readonly ProjectCellChange[]): Promise<ProjectEditResult> => {
        const change = expectDefined(changes[0]);
        const currentView = expectDefined(viewRef.current);
        currentView.update([external]);
        currentView.observeProjectSource({ path: external.path, revision: 1, project: external });
        return {
          applied: [
            {
              ...change,
              value: 'Local',
              previousValue: 'Original',
              sourceProperty: 'Owner',
              sourceKey: 'Owner',
              previousExists: true,
              appliedExists: true,
            },
          ],
          failed: [],
        };
      },
    );
    const mounted = mount([original], {
      settings: config,
      catalog: catalog([{ name: 'Owner', type: 'text' }]),
      applyEdits,
      revalidateSourceObservation,
    });
    viewRef.current = mounted.view;
    const cell = expectDefined(
      mounted.host.querySelector<HTMLElement>(
        '.abyss-project-table-row [data-column-id="property:Owner"]',
      ),
    );
    cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const input = expectDefined(cell.querySelector<HTMLInputElement>('input'));
    input.value = 'Local';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    await flushMicrotasks();

    expect(revalidateSourceObservation).toHaveBeenCalledOnce();
    expect(
      expectDefined(
        mounted.host.querySelector<HTMLElement>(
          '.abyss-project-table-row [data-column-id="property:Owner"]',
        ),
      ).textContent,
    ).toBe('External');
  });

  it('uses the canonical clear receipt when refilling the last list value in one editor', async () => {
    const config = settings();
    config.projects.table.columns.push({ id: 'property:Owners', visible: true });
    let nativePresent = true;
    const ownedClear = createOwnedInferredPropertyClear({
      path: 'Projects/A.md',
      fieldId: 'property:Owners',
      sourceProperty: 'Owners',
      sourceKey: 'Owners',
      type: 'list',
    });
    const nativeCatalog: ProjectPropertyCatalog = {
      list: () => (nativePresent ? [{ name: 'Owners', type: 'list' }] : []),
      inspect: () => ({
        kind: 'available',
        property: nativePresent ? { name: 'Owners', type: 'list' } : undefined,
        assignment: { kind: 'none' },
      }),
      values: () => [],
      onChange: () => () => {},
    };
    const applyEdits = vi.fn(
      async (changes: readonly ProjectCellChange[]): Promise<ProjectEditResult> => {
        const change = expectDefined(changes[0]);
        const clearing = Array.isArray(change.value) && change.value.length === 0;
        nativePresent = !clearing;
        return {
          applied: [
            {
              ...change,
              value: clearing ? undefined : change.value,
              previousValue: clearing ? ['Celia'] : undefined,
              sourceProperty: 'Owners',
              sourceKey: 'Owners',
              previousExists: clearing,
              appliedExists: !clearing,
              ...(clearing ? { ownedClear } : {}),
            },
          ],
          failed: [],
        };
      },
    );
    const { host } = mount([project({ frontmatter: { Owners: ['Celia'] } })], {
      settings: config,
      catalog: nativeCatalog,
      applyEdits,
    });
    const cell = expectDefined(
      host.querySelector<HTMLElement>(
        '.abyss-project-table-cell[data-column-id="property:Owners"]',
      ),
    );
    cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expectDefined(cell.querySelector<HTMLButtonElement>('[aria-label="Remove Celia"]')).click();
    await flushMicrotasks();
    const input = expectDefined(
      cell.querySelector<HTMLInputElement>('.abyss-project-list-input'),
      cell.outerHTML,
    );
    input.value = 'Mina';

    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    await flushMicrotasks();

    const refill = expectDefined(applyEdits.mock.calls[1]?.[0]?.[0]);
    expect(refill).toMatchObject({
      value: ['Mina'],
      expectedValue: undefined,
      expectedExists: false,
      ownedClear,
    });
    expect(input.isConnected).toBe(false);
  });

  it('guards a coalesced draft with the canonical normalized receipt value', async () => {
    const config = settings();
    config.projects.table.columns.push({ id: 'property:Owner', visible: true });
    let resolveFirst: ((result: ProjectEditResult) => void) | undefined;
    const applyEdits = vi.fn(
      async (changes: readonly ProjectCellChange[]): Promise<ProjectEditResult> => {
        const change = expectDefined(changes[0]);
        if (applyEdits.mock.calls.length === 1) {
          return new Promise<ProjectEditResult>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return {
          applied: [
            {
              ...change,
              previousValue: '[[People/Anna]]',
              sourceProperty: 'Owner',
              sourceKey: 'Owner',
              previousExists: true,
              appliedExists: true,
            },
          ],
          failed: [],
        };
      },
    );
    const { host } = mount([project({ frontmatter: { Owner: 'Original' } })], {
      settings: config,
      catalog: catalog([{ name: 'Owner', type: 'text' }]),
      applyEdits,
    });
    const cell = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-row [data-column-id="property:Owner"]'),
    );
    cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const input = expectDefined(cell.querySelector<HTMLInputElement>('input'));
    input.value = '"[[People/Anna]]"';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushMicrotasks();
    input.value = 'Mina';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expectDefined(resolveFirst)({
      applied: [
        {
          ...expectDefined(applyEdits.mock.calls[0]?.[0]?.[0]),
          value: '[[People/Anna]]',
          previousValue: 'Original',
          sourceProperty: 'Owner',
          sourceKey: 'Owner',
          previousExists: true,
          appliedExists: true,
        },
      ],
      failed: [],
    });
    await flushMicrotasks();

    expect(expectDefined(applyEdits.mock.calls[1]?.[0]?.[0])).toMatchObject({
      value: 'Mina',
      expectedValue: '[[People/Anna]]',
      expectedExists: true,
      sourceProperty: 'Owner',
      sourceKey: 'Owner',
    });
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
    const input = expectDefined(
      cell.querySelector<HTMLInputElement>('.abyss-project-editor-status'),
    );
    const editor = view as unknown as {
      readonly activeEditor_abyssPrivate?: {
        readonly handle: {
          readonly control_abyssPrivate: { readonly suggest?: ProjectPropertySuggest };
        };
      };
    };
    const externalStatus = expectDefined(DEFAULT_SETTINGS.projects.statuses[1]);
    item.statusId = externalStatus.id;
    item.frontmatter['status'] = externalStatus.name;
    view.update([item]);
    expect(input.isConnected).toBe(true);
    const suggest = expectDefined(
      editor.activeEditor_abyssPrivate?.handle.control_abyssPrivate.suggest,
    );
    suggest.selectSuggestion(
      expectDefined(suggest.getSuggestions('').find(({ value }) => value === done.name)),
    );
    await flushMicrotasks();

    expect(saveStatus).toHaveBeenCalledWith('Projects/A.md', done.name, active.name);
    expect(input.isConnected).toBe(true);
    expect(host.querySelector('.abyss-project-editor-error')?.textContent).toContain(
      'changed externally',
    );
  });

  it('hands editor Tab navigation to selection across columns and row boundaries', async () => {
    const { host } = mount([
      project({ path: 'Projects/A.md', name: 'A' }),
      project({ path: 'Projects/B.md', name: 'B' }),
    ]);
    const tableCell = (path: string, columnId: string): HTMLElement =>
      expectDefined(
        host.querySelector<HTMLElement>(
          `[data-project-path="${path}"] [data-column-id="${columnId}"]`,
        ),
      );

    tableCell('Projects/A.md', 'start').dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true }),
    );
    let input = expectDefined(
      tableCell('Projects/A.md', 'start').querySelector<HTMLInputElement>('input[type="date"]'),
    );
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
    );
    await flushMicrotasks();

    let destination = tableCell('Projects/A.md', 'end');
    expect(activeDocument.activeElement).toBe(destination);
    expect(destination.classList.contains('is-selection-focus')).toBe(true);
    const copiedEnd = transfer();
    destination.dispatchEvent(clipboardEvent('copy', copiedEnd));
    expect(copiedEnd.getData('text/plain')).toBe('2026-09-30');
    destination.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    expect(destination.querySelector('input[type="date"]')).not.toBeNull();
    expectDefined(destination.querySelector<HTMLInputElement>('input')).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );

    tableCell('Projects/A.md', 'start').dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true }),
    );
    input = expectDefined(
      tableCell('Projects/A.md', 'start').querySelector<HTMLInputElement>('input[type="date"]'),
    );
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await flushMicrotasks();
    destination = tableCell('Projects/A.md', 'progress');
    expect(activeDocument.activeElement).toBe(destination);
    expect(destination.classList.contains('is-selection-focus')).toBe(true);

    tableCell('Projects/A.md', 'end').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    input = expectDefined(
      tableCell('Projects/A.md', 'end').querySelector<HTMLInputElement>('input[type="date"]'),
    );
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
    );
    await flushMicrotasks();
    destination = tableCell('Projects/B.md', 'name');
    expect(activeDocument.activeElement).toBe(destination);
    expect(destination.classList.contains('is-selection-focus')).toBe(true);
    const copiedName = transfer();
    destination.dispatchEvent(clipboardEvent('copy', copiedName));
    expect(copiedName.getData('text/plain')).toBe('B');
  });

  it('reveals an editor Tab destination within a constrained table viewport', async () => {
    const { host } = mount([project({})]);
    const scroll = expectDefined(host.querySelector<HTMLElement>('.abyss-project-table-scroll'));
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this === scroll) return rectangle(0, 0, 300, 200);
      if (this.classList.contains('abyss-project-table-header-cell')) {
        return rectangle(0, 0, 300, 40);
      }
      if (this.classList.contains('abyss-project-table-name-cell')) {
        return rectangle(0, 40, 100, 70);
      }
      if (this.dataset['columnId'] === 'end') {
        return rectangle(500 - scroll.scrollLeft, 40, 600 - scroll.scrollLeft, 70);
      }
      return rectangle(100, 40, 200, 70);
    });
    const start = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="start"]'),
    );
    start.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expectDefined(start.querySelector<HTMLInputElement>('input')).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
    );
    await flushMicrotasks();

    expect(scroll.scrollLeft).toBe(300);
    expect((activeDocument.activeElement as HTMLElement | null)?.dataset['columnId']).toBe('end');
  });

  it('opens the selected editable cell with F2 through the standard edit path', () => {
    const { host } = mount([project({})]);
    const cell = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="start"]'),
    );
    cell.focus();

    cell.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'F2', metaKey: true, bubbles: true, cancelable: true }),
    );
    expect(cell.querySelector('input')).toBeNull();
    cell.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true }),
    );

    expect(cell.querySelector('input[type="date"]')).not.toBeNull();
  });

  it('captures only table F2 before document interceptors and removes the window bridge', () => {
    const ownerWindow = expectDefined(activeDocument.defaultView);
    const addListener = vi.spyOn(ownerWindow, 'addEventListener');
    const removeListener = vi.spyOn(ownerWindow, 'removeEventListener');
    const intercepted = vi.fn((event: KeyboardEvent) => {
      event.stopImmediatePropagation();
    });
    activeDocument.addEventListener('keydown', intercepted, true);
    const { host, view } = mount([project({})]);
    const registeredCallback = expectDefined(
      addListener.mock.calls.find(
        ([type, , options]) => type === 'keydown' && options === true,
      )?.[1],
    );
    const cell = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="start"]'),
    );
    const outside = activeDocument.body.createEl('button');
    const search = expectDefined(host.querySelector<HTMLInputElement>('.abyss-center-search'));

    try {
      outside.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true }),
      );
      cell.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'F2', ctrlKey: true, bubbles: true, cancelable: true }),
      );
      search.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true }),
      );
      cell.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'F2',
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(intercepted).toHaveBeenCalledTimes(4);
      expect(cell.querySelector('input')).toBeNull();

      cell.focus();
      cell.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true }),
      );

      expect(intercepted).toHaveBeenCalledTimes(4);
      expect(cell.querySelector('input[type="date"]')).not.toBeNull();
    } finally {
      destroyMountedView(view);
      activeDocument.removeEventListener('keydown', intercepted, true);
    }
    expect(removeListener).toHaveBeenCalledWith('keydown', registeredCallback, true);
  });

  it('preserves an external focus destination when an editor commits on blur', async () => {
    const { host } = mount([project({})]);
    const outside = document.body.createEl('button');
    const cell = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="start"]'),
    );
    cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const input = expectDefined(cell.querySelector<HTMLInputElement>('input[type="date"]'));
    outside.focus();
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: outside }));
    await flushMicrotasks();

    expect(activeDocument.activeElement).toBe(outside);
  });

  it('adopts a deliberately focused table cell as selection when an editor commits on blur', async () => {
    const { host } = mount([
      project({ path: 'Projects/A.md', name: 'A' }),
      project({ path: 'Projects/B.md', name: 'B' }),
    ]);
    const edited = expectDefined(
      host.querySelector<HTMLElement>(
        '[data-project-path="Projects/A.md"] [data-column-id="start"]',
      ),
    );
    const destination = expectDefined(
      host.querySelector<HTMLElement>(
        '[data-project-path="Projects/B.md"] [data-column-id="status"]',
      ),
    );
    edited.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const input = expectDefined(edited.querySelector<HTMLInputElement>('input'));
    destination.focus();
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: destination }));
    await flushMicrotasks();

    const renderedDestination = expectDefined(
      host.querySelector<HTMLElement>(
        '[data-project-path="Projects/B.md"] [data-column-id="status"]',
      ),
    );
    expect(renderedDestination.classList.contains('is-selection-focus')).toBe(true);
    renderedDestination.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    expect(renderedDestination.querySelector('.abyss-project-editor-status')).not.toBeNull();
  });

  it('keeps the latest clicked table cell while an earlier blur save is pending', async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { host } = mount(
      ['A', 'B', 'C'].map((name) => project({ path: `Projects/${name}.md`, name })),
      { saveProperty: vi.fn().mockReturnValue(pending) },
    );
    const cell = (name: string): HTMLElement =>
      expectDefined(
        host.querySelector<HTMLElement>(
          `[data-project-path="Projects/${name}.md"] [data-column-id="start"]`,
        ),
      );
    cell('A').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const input = expectDefined(cell('A').querySelector<HTMLInputElement>('input'));
    input.value = '2026-09-02';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    cell('B').focus();
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: cell('B') }));
    await flushMicrotasks();

    cell('C').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(activeDocument.activeElement).toBe(cell('C'));
    expect(cell('C').classList.contains('is-selection-focus')).toBe(true);
    expectDefined(release)();
    await flushMicrotasks();

    const rendered = cell('C');
    expect(activeDocument.activeElement).toBe(rendered);
    expect(rendered.classList.contains('is-selection-focus')).toBe(true);
  });

  it('keeps the latest external control focus while an earlier table-cell blur save is pending', async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { host } = mount(
      [
        project({ path: 'Projects/A.md', name: 'A' }),
        project({ path: 'Projects/B.md', name: 'B' }),
      ],
      { saveProperty: vi.fn().mockReturnValue(pending) },
    );
    const edited = expectDefined(
      host.querySelector<HTMLElement>(
        '[data-project-path="Projects/A.md"] [data-column-id="start"]',
      ),
    );
    const initialDestination = expectDefined(
      host.querySelector<HTMLElement>(
        '[data-project-path="Projects/B.md"] [data-column-id="start"]',
      ),
    );
    const outside = activeDocument.body.createEl('button');
    edited.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const input = expectDefined(edited.querySelector<HTMLInputElement>('input'));
    input.value = '2026-09-02';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    initialDestination.focus();
    input.dispatchEvent(
      new FocusEvent('focusout', { bubbles: true, relatedTarget: initialDestination }),
    );
    await flushMicrotasks();

    outside.focus();
    expect(activeDocument.activeElement).toBe(outside);
    expectDefined(release)();
    await flushMicrotasks();

    expect(activeDocument.activeElement).toBe(outside);
  });

  it('resolves editor Tab from the saved project occurrence after current grouped projection', async () => {
    const config = settings();
    config.projects.table.groupBy = 'property:Owner';
    config.projects.table.columns.push({ id: 'property:Owner', visible: true });
    const { host } = mount(
      [
        project({ path: 'Projects/A.md', name: 'A', frontmatter: { Owner: 'Alpha' } }),
        project({ path: 'Projects/B.md', name: 'B', frontmatter: { Owner: 'Beta' } }),
      ],
      {
        settings: config,
        catalog: catalog([{ name: 'Owner', type: 'text' }]),
      },
    );
    const owner = expectDefined(
      host.querySelector<HTMLElement>(
        '[data-project-path="Projects/A.md"] [data-column-id="property:Owner"]',
      ),
    );
    owner.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const input = expectDefined(owner.querySelector<HTMLInputElement>('input'));
    input.value = 'Beta';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
    );
    await flushMicrotasks();

    expect(host.querySelectorAll('[data-project-path="Projects/A.md"]')).toHaveLength(1);
    const destination = expectDefined(
      host.querySelector<HTMLElement>(
        '[data-project-path="Projects/B.md"] [data-column-id="name"]',
      ),
    );
    expect(activeDocument.activeElement).toBe(destination);
    expect(destination.classList.contains('is-selection-focus')).toBe(true);
  });

  it('selects cells on click, navigates and extends with arrows, and edits only on Enter', () => {
    const { host } = mount([
      project({ path: 'Projects/A.md', name: 'A' }),
      project({ path: 'Projects/B.md', name: 'B' }),
    ]);
    const first = expectDefined(
      host.querySelector<HTMLElement>(
        '[data-project-path="Projects/A.md"] [data-column-id="status"]',
      ),
    );
    first.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(first.classList.contains('is-selected')).toBe(true);
    expect(first.querySelector('.abyss-project-cell-editor')).toBeNull();

    first.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
    );
    const progress = expectDefined(
      host.querySelector<HTMLElement>(
        '[data-project-path="Projects/A.md"] [data-column-id="progress"]',
      ),
    );
    expect(progress.classList.contains('is-selection-focus')).toBe(true);
    progress.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(host.querySelectorAll('.abyss-project-table-cell.is-selected')).toHaveLength(2);

    progress.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    progress.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }),
    );
    const status = expectDefined(
      host.querySelector<HTMLElement>(
        '[data-project-path="Projects/A.md"] [data-column-id="status"]',
      ),
    );
    status.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    expect(status.querySelector('.abyss-project-cell-editor')).not.toBeNull();
  });

  it('restores selected-cell keyboard ownership after editor blur to the owning panel surface', async () => {
    const { host, view } = mount([project({})]);
    host.tabIndex = 0;
    const status = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="status"]'),
    );
    status.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(status.querySelector('.abyss-project-cell-editor')).not.toBeNull();

    host.focus();
    const editor = view as unknown as {
      readonly activeEditor_abyssPrivate?: {
        readonly handle: {
          readonly control_abyssPrivate: { readonly suggest?: ProjectPropertySuggest };
        };
      };
    };
    editor.activeEditor_abyssPrivate?.handle.control_abyssPrivate.suggest?.close();
    await flushMicrotasks();

    expect(status.querySelector('.abyss-project-cell-editor')).toBeNull();
    expect(activeDocument.activeElement).toBe(status);
    status.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
    );
    expect(
      host
        .querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="progress"]')
        ?.classList.contains('is-selection-focus'),
    ).toBe(true);
  });

  it('removes the keyboard focus ring when focus deliberately leaves the table', () => {
    const { host } = mount([project({})]);
    const status = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="status"]'),
    );
    status.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(status.classList.contains('is-selection-focus')).toBe(true);

    const outside = document.body.createEl('button');
    outside.focus();

    expect(activeDocument.activeElement).toBe(outside);
    expect(status.classList.contains('is-selected')).toBe(true);
    expect(status.classList.contains('is-selection-focus')).toBe(false);
  });

  it('adopts a newly focused table cell before applying arrow navigation', () => {
    const { host } = mount([project({})]);
    const name = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="name"]'),
    );
    const status = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="status"]'),
    );
    name.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    status.focus();
    status.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
    );

    expect(
      host
        .querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="progress"]')
        ?.classList.contains('is-selection-focus'),
    ).toBe(true);
  });

  it('reveals Arrow and Tab destinations within a constrained pane around sticky surfaces', () => {
    const { host } = mount([
      project({ path: 'Projects/A.md', name: 'A' }),
      project({ path: 'Projects/B.md', name: 'B' }),
    ]);
    const scroll = expectDefined(host.querySelector<HTMLElement>('.abyss-project-table-scroll'));
    const header = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-header-cell[data-column-id="name"]'),
    );
    const firstRow = expectDefined(
      host.querySelector<HTMLElement>('[data-project-path="Projects/A.md"]'),
    );
    const secondRow = expectDefined(
      host.querySelector<HTMLElement>('[data-project-path="Projects/B.md"]'),
    );
    const firstStatus = expectDefined(
      firstRow.querySelector<HTMLElement>('[data-column-id="status"]'),
    );
    const firstProgress = expectDefined(
      firstRow.querySelector<HTMLElement>('[data-column-id="progress"]'),
    );
    const secondStatus = expectDefined(
      secondRow.querySelector<HTMLElement>('[data-column-id="status"]'),
    );
    const secondProgress = expectDefined(
      secondRow.querySelector<HTMLElement>('[data-column-id="progress"]'),
    );
    const stickyName = expectDefined(
      firstRow.querySelector<HTMLElement>('[data-column-id="name"]'),
    );
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(rectangle(0, 0, 800, 300));
    vi.spyOn(header, 'getBoundingClientRect').mockReturnValue(rectangle(0, 0, 220, 40));
    vi.spyOn(stickyName, 'getBoundingClientRect').mockReturnValue(rectangle(0, 40, 220, 70));
    vi.spyOn(firstStatus, 'getBoundingClientRect').mockImplementation(() =>
      rectangle(
        160 - scroll.scrollLeft,
        40 - scroll.scrollTop,
        260 - scroll.scrollLeft,
        70 - scroll.scrollTop,
      ),
    );
    vi.spyOn(firstProgress, 'getBoundingClientRect').mockImplementation(() =>
      rectangle(
        760 - scroll.scrollLeft,
        40 - scroll.scrollTop,
        860 - scroll.scrollLeft,
        70 - scroll.scrollTop,
      ),
    );
    vi.spyOn(secondStatus, 'getBoundingClientRect').mockImplementation(() =>
      rectangle(
        160 - scroll.scrollLeft,
        300 - scroll.scrollTop,
        260 - scroll.scrollLeft,
        330 - scroll.scrollTop,
      ),
    );
    vi.spyOn(secondProgress, 'getBoundingClientRect').mockImplementation(() =>
      rectangle(
        760 - scroll.scrollLeft,
        300 - scroll.scrollTop,
        860 - scroll.scrollLeft,
        330 - scroll.scrollTop,
      ),
    );

    firstStatus.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    firstStatus.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
    );
    expect(scroll.scrollLeft).toBe(60);
    firstProgress.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    );
    expect(scroll.scrollTop).toBe(30);
    secondProgress.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }),
    );
    expect(scroll.scrollLeft).toBe(0);
    secondStatus.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }),
    );
    expect(scroll.scrollTop).toBe(0);
    firstStatus.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
    );
    expect(scroll.scrollLeft).toBe(60);
  });

  it('supports Shift-click, Tab and Escape while keeping repeated group occurrences distinct', () => {
    const config = settings();
    config.projects.table.groupBy = 'property:Owners';
    config.projects.table.columns.push({ id: 'property:Owners', visible: true });
    const item = project({ path: 'Projects/A.md', frontmatter: { Owners: ['A', 'B'] } });
    const { host } = mount([item], {
      settings: config,
      catalog: catalog([{ name: 'Owners', type: 'list' }]),
    });
    const occurrences = Array.from(
      host.querySelectorAll<HTMLElement>('[data-project-path="Projects/A.md"]'),
    );
    expect(occurrences).toHaveLength(2);
    const firstName = expectDefined(
      occurrences[0]?.querySelector<HTMLElement>('[data-column-id="name"]'),
    );
    const secondStatus = expectDefined(
      occurrences[1]?.querySelector<HTMLElement>('[data-column-id="status"]'),
    );
    firstName.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    secondStatus.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    expect(host.querySelectorAll('.abyss-project-table-cell.is-selected')).toHaveLength(4);

    secondStatus.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
    );
    expect(
      expectDefined(
        occurrences[1]?.querySelector<HTMLElement>('[data-column-id="progress"]'),
      ).classList.contains('is-selection-focus'),
    ).toBe(true);
    secondStatus.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(host.querySelectorAll('.abyss-project-table-cell.is-selected')).toHaveLength(0);
  });

  it('navigates and extends selection in visible order after reorder and hide-show', () => {
    const config = settings();
    const item = project({});
    const { host, view } = mount([item], { settings: config });
    const progressIndex = config.projects.table.columns.findIndex(({ id }) => id === 'progress');
    const progressColumn = expectDefined(config.projects.table.columns.splice(progressIndex, 1)[0]);
    config.projects.table.columns.splice(1, 0, progressColumn);
    view.update([item]);
    const cell = (columnId: string): HTMLElement =>
      expectDefined(
        host.querySelector<HTMLElement>(`.abyss-project-table-cell[data-column-id="${columnId}"]`),
      );

    cell('name').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    cell('name').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
    );
    expect(cell('progress').classList.contains('is-selection-focus')).toBe(true);

    expectDefined(config.projects.table.columns.find(({ id }) => id === 'status')).visible = false;
    view.update([item]);
    expectDefined(config.projects.table.columns.find(({ id }) => id === 'status')).visible = true;
    view.update([item]);
    cell('progress').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    cell('progress').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
    );
    expect(cell('status').classList.contains('is-selection-focus')).toBe(true);

    cell('progress').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    cell('start').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    expect(
      Array.from(host.querySelectorAll<HTMLElement>('.abyss-project-table-cell.is-selected')).map(
        ({ dataset }) => dataset['columnId'],
      ),
    ).toEqual(['progress', 'status', 'start']);
  });

  it('copies projected raw values synchronously and leaves editor text copy untouched', async () => {
    const config = settings();
    config.projects.table.columns.push({ id: 'property:Owner', label: 'Lead', visible: true });
    const item = project({ frontmatter: { Owner: 'Original' } });
    const applyEdits = vi.fn(async (changes: readonly ProjectCellChange[]) => ({
      applied: changes.map((change): AppliedProjectCellChange => ({
        ...change,
        sourceProperty: 'Owner',
        sourceKey: 'Owner',
        previousValue: change.expectedValue,
        previousExists: true,
        appliedExists: true,
      })),
      failed: [],
    }));
    const { host } = mount([item], {
      settings: config,
      catalog: catalog([{ name: 'Owner', type: 'text' }]),
      applyEdits,
    });
    let cell = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="property:Owner"]'),
    );
    cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const input = expectDefined(cell.querySelector<HTMLInputElement>('input'));
    input.value = 'Projected';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    await flushMicrotasks();

    cell = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="property:Owner"]'),
    );
    cell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const copied = transfer();
    const copy = clipboardEvent('copy', copied);
    cell.dispatchEvent(copy);
    expect(copy.defaultPrevented).toBe(true);
    expect(copied.getData('text/plain')).toBe('Projected');
    expect(copied.getData('application/x-abyss-project-table')).toContain('Projected');

    cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const editorInput = expectDefined(cell.querySelector<HTMLInputElement>('input'));
    const editorCopy = clipboardEvent('copy', transfer());
    editorInput.dispatchEvent(editorCopy);
    expect(editorCopy.defaultPrevented).toBe(false);
  });

  it('copies filename, raw status and the displayed progress string as TSV text', () => {
    const config = settings();
    const { host } = mount(
      [project({ frontmatter: { [config.projects.statusProperty]: active.name } })],
      { settings: config },
    );
    const name = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="name"]'),
    );
    const progress = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="progress"]'),
    );
    name.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    progress.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    const data = transfer();
    progress.dispatchEvent(clipboardEvent('copy', data));

    expect(data.getData('text/plain')).toBe(`A\t${active.name}\t60% (6/10)`);
    expect(data.getData('application/x-abyss-project-table')).not.toContain('"total"');
  });

  it('pastes one external cell over a range and rejects readonly targets before writing', async () => {
    const config = settings();
    config.projects.table.columns.push({ id: 'property:Owner', visible: true });
    const applyEdits = vi.fn(async (changes: readonly ProjectCellChange[]) => ({
      applied: changes.map((change): AppliedProjectCellChange => ({
        ...change,
        sourceProperty: 'Owner',
        sourceKey: 'Owner',
        previousValue: change.expectedValue,
        previousExists: true,
        appliedExists: true,
      })),
      failed: [],
    }));
    const { host } = mount(
      [
        project({ path: 'Projects/A.md', frontmatter: { Owner: 'A' } }),
        project({ path: 'Projects/B.md', frontmatter: { Owner: 'B' } }),
      ],
      {
        settings: config,
        catalog: catalog([{ name: 'Owner', type: 'text' }]),
        applyEdits,
      },
    );
    const ownerCells = Array.from(
      host.querySelectorAll<HTMLElement>(
        '.abyss-project-table-cell[data-column-id="property:Owner"]',
      ),
    );
    expectDefined(ownerCells[0]).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expectDefined(ownerCells[1]).dispatchEvent(
      new MouseEvent('click', { bubbles: true, shiftKey: true }),
    );
    ownerCells[1]?.dispatchEvent(clipboardEvent('paste', transfer({ 'text/plain': 'Shared' })));
    await flushMicrotasks();
    expect(applyEdits).toHaveBeenCalledOnce();
    expect(applyEdits.mock.calls[0]?.[0]).toMatchObject([
      { path: 'Projects/A.md', value: 'Shared', expectedValue: 'A' },
      { path: 'Projects/B.md', value: 'Shared', expectedValue: 'B' },
    ]);

    const name = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="name"]'),
    );
    name.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    name.dispatchEvent(clipboardEvent('paste', transfer({ 'text/plain': 'Blocked' })));
    await flushMicrotasks();
    expect(applyEdits).toHaveBeenCalledOnce();
    expect(host.querySelector('.abyss-project-table-feedback')?.textContent).toContain('read-only');
  });

  it('captures malformed external TSV synchronously in the table paste failure boundary', () => {
    const applyEdits = vi.fn();
    const { host } = mount([project({})], { applyEdits });
    const status = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="status"]'),
    );
    status.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const event = clipboardEvent('paste', transfer({ 'text/plain': '"unfinished' }));

    expect(() => status.dispatchEvent(event)).not.toThrow();
    expect(event.defaultPrevented).toBe(true);
    expect(host.querySelector('.abyss-project-table-feedback')?.textContent).toBe(
      'Unterminated quoted clipboard cell',
    );
    expect(applyEdits).not.toHaveBeenCalled();
  });

  it('pastes into a configured field with or without an owned clear receipt', async () => {
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
    const cleared: AppliedProjectCellChange = {
      path: 'Projects/A.md',
      field: budget,
      value: undefined,
      expectedValue: 10,
      previousValue: 10,
      sourceProperty: 'Budget',
      sourceKey: 'Budget',
      previousExists: true,
      appliedExists: false,
      ownedClear,
    };
    const applyEdits = vi.fn(async (changes: readonly ProjectCellChange[]) => ({
      applied: changes.map((change): AppliedProjectCellChange => ({
        ...change,
        sourceProperty: 'Budget',
        sourceKey: 'Budget',
        previousValue: change.expectedValue,
        previousExists: false,
        appliedExists: true,
      })),
      failed: [],
    }));
    const history = new ProjectEditHistory(applyEdits);
    history.record({ applied: [cleared], failed: [] });
    const { host } = mount([project({ frontmatter: {} })], {
      settings: config,
      catalog: catalog(),
      applyEdits,
      history,
    });
    const budgetCell = expectDefined(
      host.querySelector<HTMLElement>(
        '.abyss-project-table-cell[data-column-id="property:Budget"]',
      ),
    );
    budgetCell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    budgetCell.dispatchEvent(clipboardEvent('paste', transfer({ 'text/plain': '42' })));
    await flushMicrotasks();
    expect(applyEdits.mock.lastCall?.[0]?.[0]).toMatchObject({
      value: 42,
      expectedValue: undefined,
      expectedExists: false,
      ownedClear,
    });

    const unavailableApply = vi
      .fn<(changes: readonly ProjectCellChange[]) => Promise<ProjectEditResult>>()
      .mockResolvedValue({ applied: [], failed: [] });
    const unavailable = mount([project({ frontmatter: { Budget: 10 } })], {
      settings: config,
      catalog: catalog(),
      applyEdits: unavailableApply,
    });
    const unavailableCell = expectDefined(
      unavailable.host.querySelector<HTMLElement>(
        '.abyss-project-table-cell[data-column-id="property:Budget"]',
      ),
    );
    unavailableCell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    unavailableCell.dispatchEvent(clipboardEvent('paste', transfer({ 'text/plain': '12' })));
    await flushMicrotasks();
    expect(unavailableApply).toHaveBeenCalledOnce();
    expect(unavailableApply.mock.lastCall?.[0]?.[0]).toMatchObject({
      value: 12,
      expectedValue: 10,
    });
  });

  it('publishes partial paste receipts and reports the exact applied and failed counts', async () => {
    const config = settings();
    config.projects.table.columns.push({ id: 'property:Owner', visible: true });
    const applyEdits = vi.fn(async (changes: readonly ProjectCellChange[]) => ({
      applied: [
        {
          ...expectDefined(changes[0]),
          sourceProperty: 'Owner',
          sourceKey: 'Owner',
          previousValue: 'A',
          previousExists: true,
          appliedExists: true,
        },
      ],
      failed: [{ path: 'Projects/B.md', message: 'disk full' }],
    }));
    const history = new ProjectEditHistory(applyEdits);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { host } = mount(
      [
        project({ path: 'Projects/A.md', frontmatter: { Owner: 'A' } }),
        project({ path: 'Projects/B.md', frontmatter: { Owner: 'B' } }),
      ],
      {
        settings: config,
        catalog: catalog([{ name: 'Owner', type: 'text' }]),
        applyEdits,
        history,
      },
    );
    const cells = Array.from(
      host.querySelectorAll<HTMLElement>(
        '.abyss-project-table-cell[data-column-id="property:Owner"]',
      ),
    );
    expectDefined(cells[0]).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expectDefined(cells[1]).dispatchEvent(
      new MouseEvent('click', { bubbles: true, shiftKey: true }),
    );
    cells[1]?.dispatchEvent(clipboardEvent('paste', transfer({ 'text/plain': 'Shared' })));
    await flushMicrotasks();

    expect(history.canUndo).toBe(true);
    expect(host.querySelector('.abyss-project-table-feedback')?.textContent).toBe(
      '1 updated; 1 failed: disk full',
    );
  });

  it('unpins only an oversized saved Name column when the actual table pane is constrained', () => {
    const config = settings();
    const name = expectDefined(config.projects.table.columns.find(({ id }) => id === 'name'));
    name.width = 480;
    const { host, view } = mount([project({})], { settings: config });
    const scroll = expectDefined(host.querySelector<HTMLElement>('.abyss-project-table-scroll'));
    Object.defineProperty(scroll, 'clientWidth', { value: 480, configurable: true });
    view.refreshFields();
    const root = expectDefined(host.querySelector<HTMLElement>('.abyss-projects-table'));
    expect(root.classList.contains('is-name-unpinned')).toBe(true);

    name.width = 220;
    view.refreshFields();
    expect(root.classList.contains('is-name-unpinned')).toBe(false);
  });

  it('clears selected cells and publishes Undo and Redo through the same history queue', async () => {
    const config = settings();
    config.projects.table.columns.push({ id: 'property:Owner', visible: true });
    const values: unknown[] = [];
    const applyEdits = vi.fn(async (changes: readonly ProjectCellChange[]) => {
      values.push(changes[0]?.value);
      return {
        applied: changes.map((change): AppliedProjectCellChange => ({
          ...change,
          sourceProperty: 'Owner',
          sourceKey: 'Owner',
          previousValue: change.expectedValue,
          previousExists: change.expectedValue !== undefined,
          appliedExists: change.value !== undefined,
        })),
        failed: [],
      };
    });
    const history = new ProjectEditHistory(applyEdits);
    const { host } = mount([project({ frontmatter: { Owner: 'A' } })], {
      settings: config,
      catalog: catalog([{ name: 'Owner', type: 'text' }]),
      applyEdits,
      history,
    });
    let cell = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="property:Owner"]'),
    );
    cell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    cell.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }),
    );
    await flushMicrotasks();
    cell = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="property:Owner"]'),
    );
    cell.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true }),
    );
    await flushMicrotasks();
    cell = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="property:Owner"]'),
    );
    cell.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'z',
        metaKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await flushMicrotasks();

    expect(values).toEqual([undefined, 'A', undefined]);
  });

  it('keeps the stable table session focused so Undo works immediately after paste regroups rows', async () => {
    const config = settings();
    config.projects.table.groupBy = 'status';
    const done = expectDefined(config.projects.statuses[2]);
    const values: unknown[] = [];
    const applyEdits = vi.fn(async (changes: readonly ProjectCellChange[]) => {
      values.push(changes[0]?.value);
      return {
        applied: changes.map((change): AppliedProjectCellChange => ({
          ...change,
          sourceProperty: config.projects.statusProperty,
          sourceKey: config.projects.statusProperty,
          previousValue: change.expectedValue,
          previousExists: true,
          appliedExists: change.value !== undefined,
        })),
        failed: [],
      };
    });
    const history = new ProjectEditHistory(applyEdits);
    const { host } = mount(
      [project({ frontmatter: { [config.projects.statusProperty]: active.name } })],
      { settings: config, applyEdits, history },
    );
    const status = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="status"]'),
    );
    status.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    status.dispatchEvent(clipboardEvent('paste', transfer({ 'text/plain': done.name })));
    await flushMicrotasks();

    expect(host.querySelectorAll('.abyss-project-table-cell.is-selected')).toHaveLength(0);
    const owner = expectDefined(activeDocument.activeElement as HTMLElement | null);
    owner.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true }),
    );
    await flushMicrotasks();

    expect(values).toEqual([done.name, active.name]);
  });

  it('moves a whole row into a collapsed list group without a permanent grip', async () => {
    const config = settings();
    config.projects.table.groupBy = 'property:Owners';
    config.projects.table.columns.push({ id: 'property:Owners', visible: true });
    const applyEdits = vi.fn(async (changes: readonly ProjectCellChange[]) => ({
      applied: changes.map((change): AppliedProjectCellChange => ({
        ...change,
        sourceProperty: 'Owners',
        sourceKey: 'Owners',
        previousValue: change.expectedValue,
        previousExists: true,
        appliedExists: true,
      })),
      failed: [],
    }));
    const { host, openProject } = mount(
      [
        project({ path: 'Projects/A.md', name: 'A project', frontmatter: { Owners: ['A', 'C'] } }),
        project({ path: 'Projects/B.md', name: 'B project', frontmatter: { Owners: ['B'] } }),
      ],
      {
        settings: config,
        catalog: catalog([{ name: 'Owners', type: 'list' }]),
        applyEdits,
      },
    );
    const groups = Array.from(host.querySelectorAll<HTMLElement>('.abyss-project-table-group-row'));
    let target = expectDefined(groups.find((group) => group.textContent.includes('B')));
    const targetKey = expectDefined(target.dataset['groupKey']);
    const targetToggle = expectDefined(
      target.querySelector<HTMLButtonElement>('.abyss-project-table-group-toggle'),
    );
    expect(
      targetToggle.querySelector<HTMLElement>('.abyss-project-table-group-chevron')?.dataset[
        'icon'
      ],
    ).toBe('chevron-down');
    targetToggle.click();
    target = expectDefined(
      host.querySelector<HTMLElement>(
        `.abyss-project-table-group-row[data-group-key="${targetKey}"]`,
      ),
    );
    expect(target.classList.contains('is-collapsed')).toBe(true);
    expect(
      target.querySelector<HTMLElement>('.abyss-project-table-group-chevron')?.dataset['icon'],
    ).toBe('chevron-right');
    const sourceRow = expectDefined(
      Array.from(host.querySelectorAll<HTMLElement>('[data-project-path="Projects/A.md"]')).find(
        (row) => row.dataset['groupKey'] === 'value:a',
      ),
    );
    expect(sourceRow.draggable).toBe(true);
    expect(sourceRow.querySelector('.abyss-project-table-row-handle')).toBeNull();
    const title = expectDefined(
      sourceRow.querySelector<HTMLButtonElement>('.abyss-project-table-name'),
    );
    const stored = transfer();
    let protectedStore = false;
    const data: TestTransfer = {
      get types() {
        return stored.types;
      },
      setData: (type, value) => {
        stored.setData(type, value);
      },
      getData: (type) => (protectedStore ? '' : stored.getData(type)),
      dropEffect: 'none',
      effectAllowed: 'uninitialized',
    };
    const remove = expectDefined(
      sourceRow.querySelector<HTMLButtonElement>('.abyss-project-table-value-remove'),
    );
    remove.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    const protectedDrag = dragEvent('dragstart', data);
    sourceRow.dispatchEvent(protectedDrag);
    expect(protectedDrag.defaultPrevented).toBe(true);
    expect(data.types).not.toContain('application/x-abyss-project-row');

    title.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    title.dispatchEvent(dragEvent('dragstart', data));
    protectedStore = true;
    target.dispatchEvent(dragEvent('dragover', data));
    expect(target.classList.contains('is-drop-target')).toBe(true);
    expect(target.querySelector('.is-drop-before, .is-drop-after')).toBeNull();
    expect(target.getAttribute('title')).toContain('Drop to move to');
    const leave = dragEvent('dragleave', data);
    Object.defineProperty(leave, 'relatedTarget', { value: document.body });
    target.dispatchEvent(leave);
    expect(target.getAttribute('title')).toBeNull();

    target.dispatchEvent(dragEvent('dragover', data));
    sourceRow.dispatchEvent(dragEvent('dragend', data));
    title.click();
    expect(openProject).not.toHaveBeenCalled();
    expect(target.getAttribute('title')).toBeNull();

    protectedStore = false;
    sourceRow.dispatchEvent(dragEvent('dragstart', data));
    protectedStore = true;
    target.dispatchEvent(dragEvent('dragover', data));
    protectedStore = false;
    target.dispatchEvent(dragEvent('drop', data));
    expect(target.getAttribute('title')).toBeNull();
    await flushMicrotasks();

    expect(applyEdits).toHaveBeenCalledOnce();
    expect(applyEdits.mock.calls[0]?.[0]).toMatchObject([
      { path: 'Projects/A.md', value: ['B', 'C'], expectedValue: ['A', 'C'] },
    ]);
  });

  it('clears native and table selection only after a row drag is accepted', () => {
    vi.useFakeTimers();
    const { host } = mount([project({})]);
    const row = expectDefined(host.querySelector<HTMLTableRowElement>('.abyss-project-table-row'));
    const start = expectDefined(
      row.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="start"]'),
    );
    const selection = expectDefined(activeDocument.defaultView?.getSelection());
    start.click();
    selection.removeAllRanges();
    const range = activeDocument.createRange();
    range.selectNodeContents(start);
    selection.addRange(range);
    expect(selection.toString().length).toBeGreaterThan(0);
    expect(start.classList.contains('is-selected')).toBe(true);

    const rejectedData = transfer();
    const protectedControl = row.createEl('button', { attr: { type: 'button' } });
    protectedControl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    const rejected = dragEvent('dragstart', rejectedData);
    row.dispatchEvent(rejected);
    expect(rejected.defaultPrevented).toBe(true);
    expect(selection.toString().length).toBeGreaterThan(0);
    expect(start.classList.contains('is-selected')).toBe(true);

    start.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    const data = transfer();
    start.dispatchEvent(dragEvent('dragstart', data));

    expect(data.types).toContain('application/x-abyss-project-table-row');
    expect(row.classList.contains('is-dragging')).toBe(true);
    expect(selection.toString()).toBe('');
    expect(host.querySelectorAll('.abyss-project-table-cell.is-selected')).toHaveLength(0);
    expect(
      host.querySelector('.abyss-projects-table')?.classList.contains('is-project-dragging'),
    ).toBe(true);

    row.dispatchEvent(dragEvent('dragend', data));
    vi.runAllTimers();
    expect(
      host.querySelector('.abyss-projects-table')?.classList.contains('is-project-dragging'),
    ).toBe(false);
    start.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    start.click();
    expect(start.classList.contains('is-selected')).toBe(true);
  });

  it('routes a row drop through an expanded group body', async () => {
    const config = settings();
    config.projects.table.groupBy = 'property:Owners';
    config.projects.table.sortBy = { field: 'start', dir: 'asc' };
    config.projects.table.columns.push({ id: 'property:Owners', visible: true });
    const applyEdits = vi.fn(async (changes: readonly ProjectCellChange[]) => ({
      applied: changes.map((change): AppliedProjectCellChange => ({
        ...change,
        sourceProperty: 'Owners',
        sourceKey: 'Owners',
        previousValue: change.expectedValue,
        previousExists: true,
        appliedExists: true,
      })),
      failed: [],
    }));
    const projects = [
      project({ path: 'Projects/A.md', frontmatter: { Owners: ['A'], start: '2026-09-10' } }),
      project({ path: 'Projects/B.md', frontmatter: { Owners: ['B'], start: '2026-09-20' } }),
      project({ path: 'Projects/C.md', frontmatter: { Owners: ['B'], start: '2026-09-30' } }),
    ];
    const { host, view } = mount(projects, {
      settings: config,
      catalog: catalog([{ name: 'Owners', type: 'list' }]),
      applyEdits,
    });
    const originalB = expectDefined(
      host.querySelector<HTMLElement>(
        '.abyss-project-table-row[data-project-path="Projects/B.md"]',
      ),
    );
    const originalC = expectDefined(
      host.querySelector<HTMLElement>(
        '.abyss-project-table-row[data-project-path="Projects/C.md"]',
      ),
    );
    config.projects.table.sortBy.dir = 'desc';
    view.update(projects);
    const sourceRow = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-row[data-group-key="value:a"]'),
    );
    const targetCell = expectDefined(
      host.querySelector<HTMLElement>(
        '.abyss-project-table-row[data-group-key="value:b"] [data-column-id="status"]',
      ),
    );
    const targetHeader = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-table-group-row[data-group-key="value:b"]'),
    );
    const targetRows = Array.from(
      host.querySelectorAll<HTMLElement>('.abyss-project-table-row[data-group-key="value:b"]'),
    );
    expect(targetRows).toHaveLength(2);
    expect(targetRows).toEqual([originalC, originalB]);
    const data = transfer();
    sourceRow.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    sourceRow.dispatchEvent(dragEvent('dragstart', data));
    const over = dragEvent('dragover', data);
    targetCell.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    expect(targetHeader.classList.contains('is-drop-target')).toBe(true);
    expect(targetRows.every((row) => row.classList.contains('is-drop-target'))).toBe(true);
    expect(originalB.classList.contains('is-drop-after')).toBe(true);
    expect(originalC.classList.contains('is-drop-after')).toBe(false);

    const observer = new MutationObserver(() => {});
    for (const row of [targetHeader, ...targetRows]) {
      observer.observe(row, { attributes: true });
    }
    targetCell.dispatchEvent(dragEvent('dragover', data));
    expect(observer.takeRecords()).toHaveLength(0);

    const siblingLeave = dragEvent('dragleave', data);
    Object.defineProperty(siblingLeave, 'relatedTarget', {
      value: expectDefined(targetRows[1]?.querySelector('td')),
    });
    targetCell.dispatchEvent(siblingLeave);
    expect(targetHeader.classList.contains('is-drop-target')).toBe(true);

    targetCell.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(host.querySelector('.is-drop-target')).toBeNull();
    expect(host.querySelector('.is-drop-before, .is-drop-after')).toBeNull();
    targetCell.dispatchEvent(dragEvent('dragover', data));
    view.refreshFields();
    expect(host.querySelector('.is-drop-target')).toBeNull();

    targetCell.dispatchEvent(dragEvent('drop', data));
    await flushMicrotasks();

    expect(applyEdits).toHaveBeenCalledOnce();
    expect(applyEdits.mock.calls[0]?.[0]).toMatchObject([
      { path: 'Projects/A.md', value: ['B'], expectedValue: ['A'] },
    ]);
  });

  it('marks an entire denied group and clears its owned state on destroy', () => {
    const config = settings();
    config.projects.table.groupBy = 'progress';
    const { host, view } = mount(
      [
        project({
          path: 'Projects/A.md',
          stats: { total: 10, done: 8, cancelled: 0, inProgress: 0 },
        }),
        project({
          path: 'Projects/B.md',
          stats: { total: 10, done: 2, cancelled: 0, inProgress: 0 },
        }),
        project({
          path: 'Projects/C.md',
          stats: { total: 10, done: 2, cancelled: 0, inProgress: 0 },
        }),
      ],
      { settings: config },
    );
    const source = expectDefined(
      host.querySelector<HTMLElement>(
        '.abyss-project-table-row[data-group-key="value:80% (8/10)"]',
      ),
    );
    const target = expectDefined(
      host.querySelector<HTMLElement>(
        '.abyss-project-table-row[data-group-key="value:20% (2/10)"]',
      ),
    );
    const targetGroup = expectDefined(
      host.querySelector<HTMLElement>(
        '.abyss-project-table-group-row[data-group-key="value:20% (2/10)"]',
      ),
    );
    const targetRows = Array.from(
      host.querySelectorAll<HTMLElement>(
        '.abyss-project-table-row[data-group-key="value:20% (2/10)"]',
      ),
    );
    const data = transfer();
    source.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    source.dispatchEvent(dragEvent('dragstart', data));
    target.dispatchEvent(dragEvent('dragover', data));

    expect(targetGroup.classList.contains('is-drop-disabled')).toBe(true);
    expect(targetRows.every((row) => row.classList.contains('is-drop-disabled'))).toBe(true);
    expect(host.querySelector('.is-drop-before, .is-drop-after')).toBeNull();
    destroyMountedView(view);
    expect(targetGroup.classList.contains('is-drop-disabled')).toBe(false);
    expect(targetRows.some((row) => row.classList.contains('is-drop-disabled'))).toBe(false);
  });

  it('presents a project published before the background create promise resolves', async () => {
    let finishCreate: ((path: string) => void) | undefined;
    const createProject = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finishCreate = resolve;
        }),
    );
    const { host, view } = mount([], { createProject });
    expectDefined(host.querySelector<HTMLButtonElement>('.abyss-projects-new')).click();
    const input = expectDefined(
      host.querySelector<HTMLInputElement>('.abyss-project-creation-name'),
    );
    input.value = 'Published early';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const created = project({ path: 'Projects/Published early.md', name: 'Published early' });

    view.update([created]);
    expect(host.querySelector('.is-just-created')).toBeNull();
    finishCreate?.(created.path);
    await flushMicrotasks();

    const row = expectDefined(
      host.querySelector<HTMLElement>('[data-project-path="Projects/Published early.md"]'),
    );
    expect(row.classList).toContain('is-just-created');
    expect(activeDocument.activeElement?.getAttribute('data-column-id')).toBe('name');
  });

  it('keeps external focus when delayed creation finishes in a connected overview', async () => {
    let finishCreate: ((path: string) => void) | undefined;
    const createProject = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finishCreate = resolve;
        }),
    );
    const { host, view } = mount([], { createProject });
    expectDefined(host.querySelector<HTMLButtonElement>('.abyss-projects-new')).click();
    const input = expectDefined(
      host.querySelector<HTMLInputElement>('.abyss-project-creation-name'),
    );
    input.value = 'External focus';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const outside = activeDocument.body.createEl('button', { attr: { type: 'button' } });
    outside.focus();
    const created = project({ path: 'Projects/External focus.md', name: 'External focus' });
    view.update([created]);

    finishCreate?.(created.path);
    await flushMicrotasks();

    expect(activeDocument.activeElement).toBe(outside);
    expect(
      host.querySelector('[data-project-path="Projects/External focus.md"]')?.classList,
    ).toContain('is-just-created');
  });

  it('presents after an editor releases deferred reconciliation without a later store event', async () => {
    let finishCreate: ((path: string) => void) | undefined;
    const createProject = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finishCreate = resolve;
        }),
    );
    const existing = project({ path: 'Projects/Existing.md', name: 'Existing' });
    const finalStatus = expectDefined(DEFAULT_SETTINGS.projects.statuses[0]);
    const intermediateStatus = expectDefined(DEFAULT_SETTINGS.projects.statuses[1]);
    const intermediate = project({
      path: 'Projects/After editor.md',
      name: 'After editor',
      statusId: intermediateStatus.id,
    });
    const created = { ...intermediate, statusId: finalStatus.id };
    const { host, view } = mount([existing], { createProject });
    expectDefined(host.querySelector<HTMLButtonElement>('.abyss-projects-new')).click();
    const composer = expectDefined(
      host.querySelector<HTMLInputElement>('.abyss-project-creation-name'),
    );
    composer.value = created.name;
    composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    view.update([existing, intermediate]);
    const cell = expectDefined(
      host.querySelector<HTMLElement>(
        '[data-project-path="Projects/Existing.md"] [data-column-id="start"]',
      ),
    );
    cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const editor = expectDefined(
      cell.querySelector<HTMLInputElement>('.abyss-project-editor-input'),
    );
    view.update([existing, created]);
    finishCreate?.(created.path);
    await flushMicrotasks();
    expect(host.querySelector('[data-project-path="Projects/After editor.md"]')).not.toBeNull();
    expect(host.querySelector('.is-just-created')).toBeNull();
    expect(host.querySelector('.abyss-project-cell-editor')).not.toBeNull();

    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(
      host.querySelector('[data-project-path="Projects/After editor.md"]')?.classList,
    ).toContain('is-just-created');
    expect(
      activeDocument.activeElement?.closest<HTMLElement>('[data-project-path]')?.dataset[
        'projectPath'
      ],
    ).toBe(created.path);
    expect(view.selectedProjectPath()).toBe(created.path);
    expect(host.querySelector('.abyss-project-table-feedback')?.textContent).toBe('');
  });

  it('presents after a table-session mutation releases deferred reconciliation', async () => {
    let finishCreate: ((path: string) => void) | undefined;
    const createProject = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finishCreate = resolve;
        }),
    );
    let finishMutation: (() => void) | undefined;
    const finalStatus = expectDefined(DEFAULT_SETTINGS.projects.statuses[0]);
    const intermediateStatus = expectDefined(DEFAULT_SETTINGS.projects.statuses[1]);
    const existing = project({ path: 'Projects/Existing.md', name: 'Existing' });
    const intermediate = project({
      path: 'Projects/After mutation.md',
      name: 'After mutation',
      statusId: intermediateStatus.id,
    });
    const created = { ...intermediate, statusId: finalStatus.id };
    const { host, view } = mount([existing], { createProject });
    expectDefined(host.querySelector<HTMLButtonElement>('.abyss-projects-new')).click();
    const composer = expectDefined(
      host.querySelector<HTMLInputElement>('.abyss-project-creation-name'),
    );
    composer.value = created.name;
    composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    view.update([existing, intermediate]);
    const mutation = view.runTableSessionMutation(
      () =>
        new Promise<void>((resolve) => {
          finishMutation = resolve;
        }),
    );
    await flushMicrotasks();
    view.update([existing, created]);
    finishCreate?.(created.path);
    await flushMicrotasks();
    expect(host.querySelector('[data-project-path="Projects/After mutation.md"]')).not.toBeNull();
    expect(host.querySelector('.is-just-created')).toBeNull();

    expectDefined(finishMutation)();
    await mutation;

    expect(
      host.querySelector('[data-project-path="Projects/After mutation.md"]')?.classList,
    ).toContain('is-just-created');
  });

  it('clears only active restrictions that obstruct the created project', async () => {
    const config = settings();
    const planned = expectDefined(config.projects.statuses[1]);
    const done = expectDefined(config.projects.statuses[2]);
    config.projects.table.hiddenStatuses = [`id:${active.id}`, `id:${done.id}`];
    config.projects.kanban = {
      ...buildDefaultProjectKanbanSettings(config.projects.table),
      hiddenStatuses: [`id:${planned.id}`],
    };
    const createProject = vi.fn().mockResolvedValue('Projects/Needle.md');
    const { host, view } = mount([], { settings: config, createProject });
    const search = expectDefined(host.querySelector<HTMLInputElement>('.abyss-center-search'));
    search.value = 'does not match';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    expectDefined(host.querySelector<HTMLButtonElement>('.abyss-projects-new')).click();
    const input = expectDefined(
      host.querySelector<HTMLInputElement>('.abyss-project-creation-name'),
    );
    input.value = 'Needle';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushMicrotasks();

    view.update([project({ path: 'Projects/Needle.md', name: 'Needle' })]);

    expect(config.projects.table.hiddenStatuses).toEqual([`id:${done.id}`]);
    expect(config.projects.kanban.hiddenStatuses).toEqual([`id:${planned.id}`]);
    expect(search.value).toBe('');
    expect(host.querySelector('[data-project-path="Projects/Needle.md"]')).not.toBeNull();
  });
});
