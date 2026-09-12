import type * as ObsidianModule from 'obsidian';
import { App, Notice, Setting } from 'obsidian';
import { describe, expect, it, vi, type Mock } from 'vitest';
import type { ProjectPropertyCatalog } from '../src/projects/ObsidianProjectProperties';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { CalendarSettingsTab } from '../src/settings/SettingsTab';
import { SHORTCUT_ACTION_IDS } from '../src/settings/shortcuts';
import type { CalendarSettings } from '../src/settings/types';
import {
  DataTransferStub,
  deferred,
  expectDefined,
  flushMicrotasks,
  loadPluginStyles,
  objectMatching,
  useRealMoment,
} from './helpers';

vi.mock('obsidian', async () => {
  const actual = await vi.importActual<typeof ObsidianModule>('obsidian');
  return { ...actual, Notice: vi.fn() };
});

useRealMoment();

const css = await loadPluginStyles();

function declarationsFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`, 'u').exec(css);
  return match?.groups?.['body'] ?? '';
}

interface StubPlugin {
  app: App;
  settings: CalendarSettings;
  saveSettings: Mock<() => Promise<void>>;
  saveViewState: Mock<() => Promise<void>>;
  refreshProjectTableSettings: Mock<() => void>;
  renameProjectStatus: Mock<(id: string, name: string, expectedName: string) => Promise<void>>;
  rebuildTaskStatusSemantics: Mock<() => void>;
}

function expandAllSettingsCards(settings: CalendarSettings, expanded: Set<string>): void {
  for (const group of settings.tagGroups) expanded.add(group.id);
  for (const status of settings.projects.statuses) expanded.add(status.id);
  for (const status of settings.taskStatuses) expanded.add(status.id);
  for (const column of settings.projects.table.columns) {
    expanded.add(`project-property:${column.id}`);
  }
}

interface CapturedComp {
  type: 'text' | 'dropdown' | 'toggle' | 'button' | 'color';
  name: string;
  comp: {
    getValue?: () => unknown;
    setValue: (v: unknown) => unknown;
    clickHandler?: () => void;
    selectEl?: HTMLSelectElement;
  };
}

function patchSetting(captured: CapturedComp[]): () => void {
  const proto = Setting.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  const refs: Record<string, (...args: unknown[]) => unknown> = {
    addText: expectDefined(proto['addText']),
    addDropdown: expectDefined(proto['addDropdown']),
    addToggle: expectDefined(proto['addToggle']),
    addButton: expectDefined(proto['addButton']),
    addColorPicker: expectDefined(proto['addColorPicker']),
  };
  const wrap = (orig: (...args: unknown[]) => unknown, type: CapturedComp['type']) =>
    function (this: { components: unknown[]; nameEl?: { textContent?: string } }, cb: unknown) {
      const result = orig.call(this, cb);
      captured.push({
        type,
        name: this.nameEl?.textContent ?? '',
        comp: this.components[this.components.length - 1] as CapturedComp['comp'],
      });
      return result;
    };
  const set = (name: string, fn: unknown) => {
    (Setting.prototype as unknown as Record<string, unknown>)[name] = fn;
  };
  set('addText', wrap(expectDefined(refs['addText']), 'text'));
  set('addDropdown', wrap(expectDefined(refs['addDropdown']), 'dropdown'));
  set('addToggle', wrap(expectDefined(refs['addToggle']), 'toggle'));
  set('addButton', wrap(expectDefined(refs['addButton']), 'button'));
  set('addColorPicker', wrap(expectDefined(refs['addColorPicker']), 'color'));
  return () => {
    set('addText', expectDefined(refs['addText']));
    set('addDropdown', expectDefined(refs['addDropdown']));
    set('addToggle', expectDefined(refs['addToggle']));
    set('addButton', expectDefined(refs['addButton']));
    set('addColorPicker', expectDefined(refs['addColorPicker']));
  };
}

function makeTab(
  settingsOverrides: Partial<CalendarSettings> = {},
  opts: {
    expand?: boolean;
    saveSettings?: StubPlugin['saveSettings'];
    saveViewState?: StubPlugin['saveViewState'];
    projectProperties?: ProjectPropertyCatalog;
  } = {},
): {
  tab: CalendarSettingsTab;
  plugin: StubPlugin;
  app: App;
  captured: CapturedComp[];
} {
  const expandCards = opts.expand ?? true;
  const app = new App();
  // Mock plugins so DailyNoteResolver adapters don't throw on app.plugins access
  (app as unknown as Record<string, unknown>)['plugins'] = { getPlugin: () => null };
  (app as unknown as Record<string, unknown>)['internalPlugins'] = {
    getPluginById: () => null,
  };
  const settings = { ...structuredClone(DEFAULT_SETTINGS), ...settingsOverrides };
  const saveSettings =
    opts.saveSettings ?? vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const saveViewState =
    opts.saveViewState ?? vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const refreshProjectTableSettings = vi.fn<() => void>();
  const renameProjectStatus = vi.fn<
    (id: string, name: string, expectedName: string) => Promise<void>
  >(async (id: string, name: string, expectedName: string): Promise<void> => {
    const status = settings.projects.statuses.find((candidate) => candidate.id === id);
    if (status?.name !== expectedName) throw new Error('status changed externally');
    status.name = name.trim();
    await saveSettings();
  });
  const plugin: StubPlugin = {
    app,
    settings,
    saveSettings,
    saveViewState,
    refreshProjectTableSettings,
    renameProjectStatus,
    rebuildTaskStatusSemantics: vi.fn<() => void>(),
  };
  const captured: CapturedComp[] = [];
  const restore = patchSetting(captured);
  const tab = new CalendarSettingsTab(
    app,
    plugin as unknown as ConstructorParameters<typeof CalendarSettingsTab>[1],
    opts.projectProperties,
  );
  // Cards (tag groups / statuses) are collapsed by default; expand them all so
  // their body Settings render and are captured for inspection.
  if (expandCards) {
    const expanded = (tab as unknown as { expandedCards_abyssPrivate: Set<string> })
      .expandedCards_abyssPrivate;
    expandAllSettingsCards(settings, expanded);
  }
  (tab as unknown as { display(): void }).display();
  restore();
  return { tab, plugin, app, captured };
}

function openSection(tab: CalendarSettingsTab, index: number): HTMLElement {
  const headers = tab.containerEl.querySelectorAll<HTMLElement>('.abyss-settings-section-header');
  expectDefined(headers[index]).click();
  return expectDefined(
    expectDefined(
      tab.containerEl.querySelectorAll<HTMLElement>('.abyss-settings-section')[index],
    ).querySelector<HTMLElement>('.abyss-settings-section-body'),
  );
}

/** Find a Setting's root element within a section body by its nameEl text.
 * Searches recursively so Settings nested inside tag-group cards are found. */
function findSettingEl(body: HTMLElement, name: string): HTMLElement | null {
  const allDivs = body.querySelectorAll('div');
  for (const d of allDivs) {
    if (d.textContent === name && d.children.length === 0) {
      // nameEl is child of infoEl; infoEl is child of settingEl.
      // Walk up: nameEl -> infoEl -> settingEl
      return d.parentElement?.parentElement ?? null;
    }
  }
  return null;
}

function findInput(body: HTMLElement, name: string): HTMLInputElement | null {
  const el = findSettingEl(body, name);
  if (el == null) return null;
  // TextComponent creates a plain <input> (no type attr); exclude color inputs.
  const inputs = Array.from(el.querySelectorAll<HTMLInputElement>('input'));
  return inputs.find((i) => i.type !== 'color') ?? null;
}

function findDropdown(body: HTMLElement, name: string): HTMLSelectElement | null {
  return findSettingEl(body, name)?.querySelector<HTMLSelectElement>('select') ?? null;
}

function findColorInput(body: HTMLElement, name: string): HTMLInputElement | null {
  const el = findSettingEl(body, name);
  if (el == null) return null;
  return (
    Array.from(el.querySelectorAll<HTMLInputElement>('input')).find((i) => i.type === 'color') ??
    null
  );
}

function findComp(
  captured: CapturedComp[],
  name: string,
  type: CapturedComp['type'],
): CapturedComp | undefined {
  return captured.find((c) => c.name === name && c.type === type);
}

function attachSettingsScroller(tab: CalendarSettingsTab, scrollTop: number): HTMLElement {
  const scroller = document.body.createDiv({ cls: 'vertical-tab-content' });
  scroller.append(tab.containerEl);
  scroller.scrollTop = scrollTop;
  return scroller;
}

function cardNamed(container: HTMLElement, title: string): HTMLElement {
  return expectDefined(
    Array.from(container.querySelectorAll<HTMLElement>('.abyss-settings-card')).find(
      (card) =>
        card.querySelector(':scope > .abyss-settings-card-header > .abyss-settings-card-title')
          ?.textContent === title,
    ),
  );
}

function projectStatusRows(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      '[data-column-id="status"] .abyss-project-value-list > .abyss-project-value-row',
    ),
  );
}

function projectStatusRowNamed(container: HTMLElement, value: string): HTMLElement {
  return expectDefined(
    projectStatusRows(container).find(
      (row) => row.querySelector<HTMLInputElement>('.abyss-project-value-raw')?.value === value,
    ),
  );
}

function projectStatusRow(container: HTMLElement, id: string): HTMLElement {
  return expectDefined(
    projectStatusRows(container).find((row) => row.dataset['settingsItemId'] === id),
  );
}

function capturedButton(
  captured: CapturedComp[],
  text: string,
  sectionTitle: string,
): CapturedComp['comp'] {
  return expectDefined(
    captured.find((candidate) => {
      if (candidate.type !== 'button') return false;
      const button = (candidate.comp as { buttonEl?: HTMLButtonElement }).buttonEl;
      return (
        button?.textContent === text &&
        button.closest<HTMLElement>('[data-section-title]')?.dataset['sectionTitle'] ===
          sectionTitle
      );
    }),
  ).comp;
}

function dragCard(source: HTMLElement, target: HTMLElement): void {
  const dataTransfer = new DataTransferStub();
  for (const [element, type] of [
    [expectDefined(source.querySelector<HTMLElement>('.abyss-settings-card-header')), 'dragstart'],
    [target, 'drop'],
  ] as const) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
    element.dispatchEvent(event);
  }
}

function dragProjectValueRow(source: HTMLElement, target: HTMLElement): void {
  const dataTransfer = new DataTransferStub();
  for (const [element, type] of [
    [expectDefined(source.querySelector<HTMLElement>('.abyss-project-value-grip')), 'dragstart'],
    [target, 'drop'],
  ] as const) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
    element.dispatchEvent(event);
  }
}

function dispatchProjectValueDragStart(source: HTMLElement): Event {
  const event = new MouseEvent('dragstart', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: new DataTransferStub() });
  expectDefined(source.querySelector<HTMLElement>('.abyss-project-value-grip')).dispatchEvent(
    event,
  );
  return event;
}

function projectStatusOrder(tab: CalendarSettingsTab): string[] {
  const projects = expectDefined(
    Array.from(tab.containerEl.querySelectorAll<HTMLElement>('.abyss-settings-section')).find(
      (section) =>
        section.querySelector('.abyss-settings-section-label')?.textContent === 'Projects',
    ),
  );
  const statusProperty = expectDefined(
    projects.querySelector<HTMLElement>('[data-card-id="project-property:status"]'),
  );
  return Array.from(
    statusProperty.querySelectorAll<HTMLElement>(
      ':scope > .abyss-settings-card-body .abyss-project-value-list > .abyss-project-value-row',
    ),
    (row) => row.dataset['settingsItemId'] ?? '',
  );
}

describe('CalendarSettingsTab project value commits', () => {
  it('commits a focused status alias when its owner window deactivates and deduplicates later boundaries', async () => {
    const { tab, plugin } = makeTab();
    document.body.append(tab.containerEl);
    try {
      const body = openSection(tab, 5);
      const status = expectDefined(plugin.settings.projects.statuses[0]);
      const row = projectStatusRowNamed(body, status.name);
      const alias = expectDefined(
        row.querySelector<HTMLInputElement>('.abyss-project-value-alias'),
      );
      const defaultStatus = expectDefined(findDropdown(body, 'Default status'));
      const savedSettings: CalendarSettings[] = [];
      plugin.saveSettings.mockImplementation(async () => {
        savedSettings.push(structuredClone(plugin.settings));
      });

      alias.focus();
      alias.value = 'Current work';
      alias.dispatchEvent(new Event('input', { bubbles: true }));
      const ownerWindow = expectDefined(tab.containerEl.ownerDocument.defaultView);
      ownerWindow.dispatchEvent(new Event('blur'));
      await flushMicrotasks();

      expect(tab.containerEl.ownerDocument.activeElement).toBe(alias);
      expect(status.displayName).toBe('Current work');
      expect(savedSettings).toHaveLength(1);
      expect(savedSettings[0]?.projects.statuses[0]?.displayName).toBe('Current work');
      expect(defaultStatus.selectedOptions[0]?.textContent).toBe('Current work');

      alias.dispatchEvent(new Event('change', { bubbles: true }));
      alias.dispatchEvent(new FocusEvent('blur'));
      ownerWindow.dispatchEvent(new Event('blur'));
      await flushMicrotasks();

      expect(plugin.saveSettings).toHaveBeenCalledOnce();
    } finally {
      tab.hide();
      tab.containerEl.remove();
    }
  });

  it('commits the first and subsequent preset raw drafts on owner-window deactivation', async () => {
    const projects = structuredClone(DEFAULT_SETTINGS.projects);
    projects.table.columns.push({ id: 'property:Priority', visible: true });
    projects.propertyDefinitions['property:Priority'] = {
      type: 'text',
      presets: [{ value: 'low' }],
    };
    const { tab, plugin } = makeTab(
      { projects },
      {
        projectProperties: {
          list: () => [{ name: 'Priority', type: 'text' }],
          inspect: () => ({
            kind: 'available',
            property: { name: 'Priority', type: 'text' },
            assignment: { kind: 'none' },
          }),
          values: () => [],
          onChange: () => () => {},
        },
      },
    );
    document.body.append(tab.containerEl);
    try {
      const body = openSection(tab, 5);
      const raw = expectDefined(
        body.querySelector<HTMLInputElement>(
          '[data-column-id="property:Priority"] .abyss-project-value-raw',
        ),
      );
      const definition = expectDefined(
        plugin.settings.projects.propertyDefinitions['property:Priority'],
      );
      const ownerWindow = expectDefined(tab.containerEl.ownerDocument.defaultView);

      raw.focus();
      raw.value = 'high';
      raw.dispatchEvent(new Event('input', { bubbles: true }));
      ownerWindow.dispatchEvent(new Event('blur'));
      await flushMicrotasks();
      expect(definition.presets).toEqual([{ value: 'high' }]);

      raw.value = 'urgent';
      raw.dispatchEvent(new Event('input', { bubbles: true }));
      ownerWindow.dispatchEvent(new Event('blur'));
      await flushMicrotasks();

      expect(definition.presets).toEqual([{ value: 'urgent' }]);
      expect(plugin.saveSettings).toHaveBeenCalledTimes(2);
    } finally {
      tab.hide();
      tab.containerEl.remove();
    }
  });

  it('retries an unchanged rejected preset after its duplicate conflict is removed', async () => {
    const projects = structuredClone(DEFAULT_SETTINGS.projects);
    projects.table.columns.push({ id: 'property:Priority', visible: true });
    projects.propertyDefinitions['property:Priority'] = {
      type: 'text',
      presets: [{ value: '🔺' }, { value: '⏫' }],
    };
    const { tab, plugin } = makeTab(
      { projects },
      {
        projectProperties: {
          list: () => [{ name: 'Priority', type: 'text' }],
          inspect: () => ({
            kind: 'available',
            property: { name: 'Priority', type: 'text' },
            assignment: { kind: 'none' },
          }),
          values: () => [],
          onChange: () => () => {},
        },
      },
    );
    document.body.append(tab.containerEl);
    try {
      const body = openSection(tab, 5);
      const rows = Array.from(
        body.querySelectorAll<HTMLElement>(
          '[data-column-id="property:Priority"] .abyss-project-value-row',
        ),
      );
      const first = expectDefined(
        expectDefined(rows[0]).querySelector<HTMLInputElement>('.abyss-project-value-raw'),
      );
      const second = expectDefined(
        expectDefined(rows[1]).querySelector<HTMLInputElement>('.abyss-project-value-raw'),
      );
      const definition = expectDefined(
        plugin.settings.projects.propertyDefinitions['property:Priority'],
      );

      first.value = '⏫';
      first.dispatchEvent(new Event('input', { bubbles: true }));
      first.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
      await flushMicrotasks();

      expect(definition.presets).toEqual([{ value: '🔺' }, { value: '⏫' }]);
      expect(plugin.saveSettings).not.toHaveBeenCalled();
      expect(expectDefined(rows[0]).querySelector('[role="status"]')?.textContent).not.toBe('');

      second.value = 'QA freed';
      second.dispatchEvent(new Event('input', { bubbles: true }));
      second.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
      await flushMicrotasks();
      expect(definition.presets).toEqual([{ value: '🔺' }, { value: 'QA freed' }]);

      first.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
      await flushMicrotasks();

      expect(definition.presets).toEqual([{ value: '⏫' }, { value: 'QA freed' }]);
      expect(plugin.saveSettings).toHaveBeenCalledTimes(2);
      expect(expectDefined(rows[0]).querySelector('[role="status"]')?.textContent).toBe('');
    } finally {
      tab.hide();
      tab.containerEl.remove();
    }
  });

  it('clears a rejected preset error when its draft returns to the accepted value', async () => {
    const projects = structuredClone(DEFAULT_SETTINGS.projects);
    projects.table.columns.push({ id: 'property:Priority', visible: true });
    projects.propertyDefinitions['property:Priority'] = {
      type: 'text',
      presets: [{ value: '🔺' }, { value: '⏫' }],
    };
    const { tab, plugin } = makeTab(
      { projects },
      {
        projectProperties: {
          list: () => [{ name: 'Priority', type: 'text' }],
          inspect: () => ({
            kind: 'available',
            property: { name: 'Priority', type: 'text' },
            assignment: { kind: 'none' },
          }),
          values: () => [],
          onChange: () => () => {},
        },
      },
    );
    document.body.append(tab.containerEl);
    try {
      const body = openSection(tab, 5);
      const firstRow = expectDefined(
        body.querySelector<HTMLElement>(
          '[data-column-id="property:Priority"] .abyss-project-value-row',
        ),
      );
      const first = expectDefined(
        firstRow.querySelector<HTMLInputElement>('.abyss-project-value-raw'),
      );
      const error = expectDefined(firstRow.querySelector<HTMLElement>('[role="status"]'));
      const definition = expectDefined(
        plugin.settings.projects.propertyDefinitions['property:Priority'],
      );

      first.value = '⏫';
      first.dispatchEvent(new Event('input', { bubbles: true }));
      first.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
      await flushMicrotasks();
      expect(error.textContent).not.toBe('');

      first.value = '🔺';
      first.dispatchEvent(new Event('input', { bubbles: true }));
      first.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
      await flushMicrotasks();

      expect(error.textContent).toBe('');
      expect(definition.presets).toEqual([{ value: '🔺' }, { value: '⏫' }]);
      expect(plugin.saveSettings).not.toHaveBeenCalled();

      first.dispatchEvent(new Event('change', { bubbles: true }));
      first.dispatchEvent(new FocusEvent('blur'));
      expectDefined(tab.containerEl.ownerDocument.defaultView).dispatchEvent(new Event('blur'));
      await flushMicrotasks();
      expect(plugin.saveSettings).not.toHaveBeenCalled();
    } finally {
      tab.hide();
      tab.containerEl.remove();
    }
  });

  it('commits the first added preset through raw, alias, and appearance controls without another add', async () => {
    const projects = structuredClone(DEFAULT_SETTINGS.projects);
    projects.table.columns.push({ id: 'property:Priority', visible: true });
    projects.propertyDefinitions['property:Priority'] = { type: 'text', presets: [] };
    const { tab, plugin } = makeTab(
      { projects },
      {
        projectProperties: {
          list: () => [{ name: 'Priority', type: 'text' }],
          inspect: () => ({
            kind: 'available',
            property: { name: 'Priority', type: 'text' },
            assignment: { kind: 'none' },
          }),
          values: () => [],
          onChange: () => () => {},
        },
      },
    );
    document.body.append(tab.containerEl);
    try {
      let body = openSection(tab, 5);
      expectDefined(
        body.querySelector<HTMLButtonElement>(
          '[data-column-id="property:Priority"] .abyss-project-preset-add',
        ),
      ).click();
      await flushMicrotasks();

      body = expectDefined(
        Array.from(tab.containerEl.querySelectorAll<HTMLElement>('.abyss-settings-section'))
          .find((section) => section.dataset['sectionTitle'] === 'Projects')
          ?.querySelector<HTMLElement>('.abyss-settings-section-body'),
      );
      const row = expectDefined(
        body.querySelector<HTMLElement>(
          '[data-column-id="property:Priority"] .abyss-project-value-row',
        ),
      );
      const raw = expectDefined(row.querySelector<HTMLInputElement>('.abyss-project-value-raw'));
      const alias = expectDefined(
        row.querySelector<HTMLInputElement>('.abyss-project-value-alias'),
      );
      const appearance = expectDefined(
        row.querySelector<HTMLSelectElement>('.abyss-project-value-appearance'),
      );
      const ownerWindow = expectDefined(tab.containerEl.ownerDocument.defaultView);

      raw.focus();
      raw.value = 'urgent';
      raw.dispatchEvent(new Event('input', { bubbles: true }));
      ownerWindow.dispatchEvent(new Event('blur'));
      alias.focus();
      alias.value = 'Urgent';
      alias.dispatchEvent(new Event('input', { bubbles: true }));
      ownerWindow.dispatchEvent(new Event('blur'));
      appearance.value = 'dot';
      appearance.dispatchEvent(new Event('change', { bubbles: true }));
      await flushMicrotasks();

      (tab as unknown as { display(): void }).display();
      expect(plugin.settings.projects.propertyDefinitions['property:Priority']?.presets).toEqual([
        { value: 'urgent', displayName: 'Urgent', display: 'dot' },
      ]);
      expect(
        tab.containerEl.querySelectorAll(
          '[data-column-id="property:Priority"] .abyss-project-value-row',
        ),
      ).toHaveLength(1);
      expect(plugin.saveSettings).toHaveBeenCalledTimes(4);
    } finally {
      tab.hide();
      tab.containerEl.remove();
    }
  });

  it('keeps invalid and duplicate number drafts visible until a valid owner-window commit', async () => {
    const projects = structuredClone(DEFAULT_SETTINGS.projects);
    projects.table.columns.push({ id: 'property:Budget', visible: true });
    projects.propertyDefinitions['property:Budget'] = {
      type: 'number',
      presets: [{ value: 1 }, { value: 2 }],
    };
    const { tab, plugin } = makeTab({ projects });
    document.body.append(tab.containerEl);
    try {
      const body = openSection(tab, 5);
      const input = expectDefined(
        body.querySelector<HTMLInputElement>(
          '[data-column-id="property:Budget"] .abyss-project-value-raw',
        ),
      );
      const definition = expectDefined(
        plugin.settings.projects.propertyDefinitions['property:Budget'],
      );
      const ownerWindow = expectDefined(tab.containerEl.ownerDocument.defaultView);

      input.focus();
      input.value = '2';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      ownerWindow.dispatchEvent(new Event('blur'));
      await flushMicrotasks();
      expect(definition.presets).toEqual([{ value: 1 }, { value: 2 }]);
      expect(input.value).toBe('2');
      expect(plugin.saveSettings).not.toHaveBeenCalled();

      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      ownerWindow.dispatchEvent(new Event('blur'));
      await flushMicrotasks();
      expect(definition.presets).toEqual([{ value: 1 }, { value: 2 }]);
      expect(input.value).toBe('');
      expect(plugin.saveSettings).not.toHaveBeenCalled();

      input.value = '3';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      ownerWindow.dispatchEvent(new Event('blur'));
      await flushMicrotasks();
      expect(definition.presets).toEqual([{ value: 3 }, { value: 2 }]);
      expect(plugin.saveSettings).toHaveBeenCalledOnce();
    } finally {
      tab.hide();
      tab.containerEl.remove();
    }
  });

  it('flushes a pending preset alias on hide and removes its owner-window listener', async () => {
    const projects = structuredClone(DEFAULT_SETTINGS.projects);
    projects.table.columns.push({ id: 'property:Priority', visible: true });
    projects.propertyDefinitions['property:Priority'] = {
      type: 'text',
      presets: [{ value: 'high' }],
    };
    const { tab, plugin } = makeTab(
      { projects },
      {
        projectProperties: {
          list: () => [{ name: 'Priority', type: 'text' }],
          inspect: () => ({
            kind: 'available',
            property: { name: 'Priority', type: 'text' },
            assignment: { kind: 'none' },
          }),
          values: () => [],
          onChange: () => () => {},
        },
      },
    );
    document.body.append(tab.containerEl);
    let hidden = false;
    try {
      const alias = expectDefined(
        tab.containerEl.querySelector<HTMLInputElement>(
          '[data-column-id="property:Priority"] .abyss-project-value-alias',
        ),
      );
      const ownerWindow = expectDefined(tab.containerEl.ownerDocument.defaultView);
      alias.value = 'High priority';
      alias.dispatchEvent(new Event('input', { bubbles: true }));

      tab.hide();
      hidden = true;
      await flushMicrotasks();

      expect(plugin.settings.projects.propertyDefinitions['property:Priority']?.presets).toEqual([
        { value: 'high', displayName: 'High priority' },
      ]);
      expect(plugin.saveSettings).toHaveBeenCalledOnce();

      alias.value = 'Detached draft';
      alias.dispatchEvent(new Event('input', { bubbles: true }));
      ownerWindow.dispatchEvent(new Event('blur'));
      await flushMicrotasks();
      expect(plugin.saveSettings).toHaveBeenCalledOnce();
    } finally {
      if (!hidden) tab.hide();
      tab.containerEl.remove();
    }
  });

  it('commits native preset color input once and deduplicates its following change event', async () => {
    const projects = structuredClone(DEFAULT_SETTINGS.projects);
    projects.table.columns.push({ id: 'property:Priority', visible: true });
    projects.propertyDefinitions['property:Priority'] = {
      type: 'text',
      presets: [{ value: 'high', color: '#c74848' }],
    };
    const { tab, plugin } = makeTab(
      { projects },
      {
        projectProperties: {
          list: () => [{ name: 'Priority', type: 'text' }],
          inspect: () => ({
            kind: 'available',
            property: { name: 'Priority', type: 'text' },
            assignment: { kind: 'none' },
          }),
          values: () => [],
          onChange: () => () => {},
        },
      },
    );
    try {
      const body = openSection(tab, 5);
      const color = expectDefined(
        body.querySelector<HTMLInputElement>(
          '[data-column-id="property:Priority"] .abyss-project-value-color',
        ),
      );

      color.value = '#28b8a5';
      color.dispatchEvent(new Event('input', { bubbles: true }));
      await flushMicrotasks();

      expect(plugin.settings.projects.propertyDefinitions['property:Priority']?.presets).toEqual([
        { value: 'high', color: '#28b8a5' },
      ]);
      expect(plugin.saveSettings).toHaveBeenCalledOnce();

      color.dispatchEvent(new Event('change', { bubbles: true }));
      await flushMicrotasks();
      expect(plugin.saveSettings).toHaveBeenCalledOnce();
    } finally {
      tab.hide();
    }
  });

  it('runs a status rename once when the owner window deactivates with its raw input focused', async () => {
    const { tab, plugin } = makeTab();
    document.body.append(tab.containerEl);
    try {
      const body = openSection(tab, 5);
      const input = expectDefined(
        projectStatusRowNamed(body, 'active').querySelector<HTMLInputElement>(
          '.abyss-project-value-raw',
        ),
      );
      input.focus();
      input.value = 'running';
      input.dispatchEvent(new Event('input', { bubbles: true }));

      expectDefined(tab.containerEl.ownerDocument.defaultView).dispatchEvent(new Event('blur'));
      await flushMicrotasks();

      expect(plugin.renameProjectStatus).toHaveBeenCalledWith('status-1', 'running', 'active');
      expect(plugin.renameProjectStatus).toHaveBeenCalledOnce();

      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new FocusEvent('blur'));
      await flushMicrotasks();
      expect(plugin.renameProjectStatus).toHaveBeenCalledOnce();
    } finally {
      tab.hide();
      tab.containerEl.remove();
    }
  });

  it('does not recreate a settings window listener when a raw status rename settles after hide', async () => {
    const { tab, plugin } = makeTab();
    document.body.append(tab.containerEl);
    const ownerWindow = expectDefined(tab.containerEl.ownerDocument.defaultView);
    const addWindowListener = vi.spyOn(ownerWindow, 'addEventListener');
    const pendingRename = deferred<void>();
    plugin.renameProjectStatus.mockImplementation(() => pendingRename.promise);
    let hidden = false;
    try {
      const body = openSection(tab, 5);
      const input = expectDefined(
        projectStatusRowNamed(body, 'active').querySelector<HTMLInputElement>(
          '.abyss-project-value-raw',
        ),
      );
      input.value = 'running';
      input.dispatchEvent(new Event('input', { bubbles: true }));

      tab.hide();
      hidden = true;
      expect(plugin.renameProjectStatus).toHaveBeenCalledOnce();
      addWindowListener.mockClear();

      pendingRename.resolve();
      await flushMicrotasks();

      expect(addWindowListener).not.toHaveBeenCalled();
    } finally {
      if (!hidden) tab.hide();
      addWindowListener.mockRestore();
      tab.containerEl.remove();
    }
  });

  it('does not repeat a pending raw status rename after an intervening settings rebuild', async () => {
    const { tab, plugin } = makeTab();
    document.body.append(tab.containerEl);
    const status = expectDefined(plugin.settings.projects.statuses[0]);
    const pendingRename = deferred<void>();
    plugin.renameProjectStatus.mockImplementation(async (_id, name) => {
      await pendingRename.promise;
      status.name = name;
    });
    try {
      const body = openSection(tab, 5);
      const input = expectDefined(
        projectStatusRowNamed(body, 'active').querySelector<HTMLInputElement>(
          '.abyss-project-value-raw',
        ),
      );
      input.focus();
      input.value = 'running';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      expectDefined(tab.containerEl.ownerDocument.defaultView).dispatchEvent(new Event('blur'));
      expect(plugin.renameProjectStatus).toHaveBeenCalledOnce();

      (tab as unknown as { display(): void }).display();
      pendingRename.resolve();
      await flushMicrotasks();

      expect(plugin.renameProjectStatus).toHaveBeenCalledOnce();
    } finally {
      tab.hide();
      tab.containerEl.remove();
    }
  });

  it('restores the current raw status control when a pending rename fails after a rebuild', async () => {
    let rejectRename!: (error: Error) => void;
    const pendingRename = new Promise<void>((_resolve, reject) => {
      rejectRename = reject;
    });
    const { tab, plugin } = makeTab();
    document.body.append(tab.containerEl);
    plugin.renameProjectStatus.mockImplementation(() => pendingRename);
    try {
      const body = openSection(tab, 5);
      const input = expectDefined(
        projectStatusRowNamed(body, 'active').querySelector<HTMLInputElement>(
          '.abyss-project-value-raw',
        ),
      );
      input.focus();
      input.value = 'running';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      expectDefined(tab.containerEl.ownerDocument.defaultView).dispatchEvent(new Event('blur'));
      (tab as unknown as { display(): void }).display();

      rejectRename(new Error('status changed externally'));
      await flushMicrotasks();

      const current = expectDefined(
        projectStatusRow(tab.containerEl, 'status-1').querySelector<HTMLInputElement>(
          '.abyss-project-value-raw',
        ),
      );
      expect(current.value).toBe('active');
      expect(current.disabled).toBe(false);
      expect(plugin.renameProjectStatus).toHaveBeenCalledOnce();
    } finally {
      tab.hide();
      tab.containerEl.remove();
    }
  });
});

describe('CalendarSettingsTab renderGeneralSettings', () => {
  it('task prefix input reflects setting and saves on change', () => {
    const { tab, plugin, captured } = makeTab({ taskPrefix: '#task' });
    const body = openSection(tab, 0);
    const input = findInput(body, 'Task prefix');
    expect(input).not.toBeNull();
    expect(expectDefined(input).value).toBe('#task');
    expectDefined(findComp(captured, 'Task prefix', 'text')).comp.setValue('#todo');
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(plugin.settings.taskPrefix).toBe('#todo');
  });

  it('add to today toggle reflects setting and saves on change', () => {
    const { tab, plugin, captured } = makeTab({ addToToday: true });
    openSection(tab, 0);
    // Toggle has no checkbox input in the mock; verify via captured component value
    const toggleComp = expectDefined(findComp(captured, "Add to today's note", 'toggle'));
    if (toggleComp.comp.getValue === undefined) {
      throw new Error('Expected the toggle component to expose getValue');
    }
    expect(toggleComp.comp.getValue()).toBe(true);
    toggleComp.comp.setValue(false);
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(plugin.settings.addToToday).toBe(false);
  });

  it('custom file path visible when addToToday is false', () => {
    const { tab } = makeTab({ addToToday: false, customFilePath: 'inbox.md' });
    const body = openSection(tab, 0);
    const input = findInput(body, 'Custom file path');
    expect(input).not.toBeNull();
    expect(expectDefined(input).value).toBe('inbox.md');
  });

  it('custom file path hidden when addToToday is true', () => {
    const { tab } = makeTab({ addToToday: true });
    const body = openSection(tab, 0);
    const input = findInput(body, 'Custom file path');
    expect(input).toBeNull();
  });

  it('custom file path change saves', () => {
    const { tab, plugin, captured } = makeTab({ addToToday: false, customFilePath: 'old.md' });
    openSection(tab, 0);
    expectDefined(findComp(captured, 'Custom file path', 'text')).comp.setValue('new.md');
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(plugin.settings.customFilePath).toBe('new.md');
  });
});

describe('CalendarSettingsTab Hotkeys', () => {
  function hotkeysBody(tab: CalendarSettingsTab): HTMLElement {
    return openSection(tab, 7);
  }

  function shortcutInput(body: HTMLElement, action: string): HTMLInputElement {
    return expectDefined(
      body.querySelector<HTMLInputElement>(`[data-shortcut-action="${action}"]`),
    );
  }

  it('persists raw invalid values and announces the row-level issue', () => {
    const { tab, plugin } = makeTab();
    const input = shortcutInput(hotkeysBody(tab), 'openQuickCapture');

    input.value = 'Ctrl+Q';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    expect(plugin.settings.shortcuts.openQuickCapture).toBe('Ctrl+Q');
    expect(plugin.saveSettings).toHaveBeenCalledOnce();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    expect(tab.containerEl.querySelector(`#${describedBy}`)?.textContent).toContain('valid');
    expect(tab.containerEl.querySelector(`#${describedBy}`)?.getAttribute('role')).toBeNull();
    expect(tab.containerEl.querySelectorAll('[role="alert"]')).toHaveLength(0);
  });

  it('keeps collapsed Hotkeys inputs out of sequential focus and exposes disclosure state', () => {
    const { tab } = makeTab();
    const section = expectDefined(
      tab.containerEl.querySelectorAll<HTMLElement>('.abyss-settings-section')[7],
    );
    const header = expectDefined(
      section.querySelector<HTMLButtonElement>('.abyss-settings-section-header'),
    );
    const body = expectDefined(section.querySelector<HTMLElement>('.abyss-settings-section-body'));

    expect(header.tagName).toBe('BUTTON');
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(header.getAttribute('aria-controls')).toBe(body.id);
    expect(body.hidden).toBe(true);
    expect(body.querySelectorAll('input')).toHaveLength(SHORTCUT_ACTION_IDS.length);

    header.click();
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(body.hidden).toBe(false);
  });

  it('uses one atomic polite status for settled validation instead of duplicate alerts', () => {
    const { tab } = makeTab();
    const body = hotkeysBody(tab);
    const tasks = shortcutInput(body, 'openTasks');
    const status = expectDefined(
      body.querySelector<HTMLElement>('.abyss-shortcut-validation-status'),
    );

    for (const value of ['C', 'Ct', 'Ctr', 'Ctrl', 'Q']) {
      tasks.value = value;
      tasks.dispatchEvent(new Event('input', { bubbles: true }));
    }
    expect(status.textContent).toBe('');
    tasks.dispatchEvent(new FocusEvent('blur'));

    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.getAttribute('aria-atomic')).toBe('true');
    expect(status.classList).toContain('abyss-sr-only');
    expect(status.textContent).toBe(
      'Q conflicts with Quick capture and is disabled. No alternatives remain active.',
    );
    expect(body.querySelectorAll('[role="alert"]')).toHaveLength(0);

    tasks.value = '';
    tasks.dispatchEvent(new Event('input', { bubbles: true }));
    expect(tasks.getAttribute('aria-invalid')).toBeNull();
    expect(status.textContent).toBe('');
  });

  it('keeps the active input and its caret while conflict feedback updates every affected row', () => {
    const { tab, plugin } = makeTab();
    const body = hotkeysBody(tab);
    const quickCapture = shortcutInput(body, 'openQuickCapture');
    const tasks = shortcutInput(body, 'openTasks');
    document.body.appendChild(tab.containerEl);
    tasks.focus();
    tasks.setSelectionRange(1, 1);

    tasks.value = 'Q';
    tasks.dispatchEvent(new Event('input', { bubbles: true }));

    expect(plugin.settings.shortcuts.openTasks).toBe('Q');
    expect(plugin.saveSettings).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(tasks);
    expect(tasks.selectionStart).toBe(1);
    expect(tasks.getAttribute('aria-invalid')).toBe('true');
    expect(quickCapture.getAttribute('aria-invalid')).toBe('true');
    expect(tasks.isConnected).toBe(true);
    tab.containerEl.remove();
  });

  it('keeps blank shortcut values as disabled without an issue', () => {
    const { tab, plugin } = makeTab();
    const input = shortcutInput(hotkeysBody(tab), 'openQuickCapture');

    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    expect(plugin.settings.shortcuts.openQuickCapture).toBe('');
    expect(input.getAttribute('aria-invalid')).not.toBe('true');
    expect(input.getAttribute('aria-describedby')).toBeNull();
  });

  it('explains partial conflicts with an accessible row warning', () => {
    const { tab, plugin } = makeTab();
    plugin.settings.shortcuts.openQuickCapture = 'Q | shift 7';
    plugin.settings.shortcuts.openSearch = 'Q | S';
    (tab as unknown as { display(): void }).display();
    const body = hotkeysBody(tab);
    const quickCapture = shortcutInput(body, 'openQuickCapture');
    const issueId = quickCapture.getAttribute('aria-describedby');
    const issue = expectDefined(body.querySelector<HTMLElement>(`#${issueId}`));

    expect(quickCapture.getAttribute('aria-invalid')).toBe('true');
    expect(issue.textContent).toContain(
      'Q conflicts with Search and is disabled. shift 7 remains active.',
    );
    const warning = expectDefined(issue.querySelector<HTMLElement>('.abyss-shortcut-warning-icon'));
    const status = expectDefined(
      body.querySelector<HTMLElement>('.abyss-shortcut-validation-status'),
    );
    expect(warning.getAttribute('aria-hidden')).toBe('true');
    expect(issue.classList).not.toContain('abyss-sr-only');
    expect(declarationsFor('.abyss-shortcut-issue')).toContain('display: flex');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.classList).toContain('abyss-sr-only');
    const screenReaderOnly = declarationsFor('.abyss-sr-only');
    expect(screenReaderOnly).toContain('position: absolute');
    expect(screenReaderOnly).toContain('width: 1px');
    expect(screenReaderOnly).toContain('height: 1px');
    expect(screenReaderOnly).toContain('margin: -1px');
    expect(screenReaderOnly).toContain('clip-path: inset(50%)');
    expect(screenReaderOnly).not.toContain('display: none');
    expect(screenReaderOnly).not.toContain('visibility: hidden');
  });

  it.each([
    ['empty', 'Q | ', 'Alternative 2 is empty and is disabled. Q remains active.'],
    ['invalid', 'Q | nope', 'nope is invalid and is disabled. Q remains active.'],
    ['duplicate', 'Q | q', 'q duplicates Q and is disabled. Q remains active.'],
    [
      'duplicate plus conflict',
      'Q | q | shift 7',
      'q duplicates Q and is disabled. Q conflicts with Search and is disabled. shift 7 remains active.',
    ],
    [
      'no remaining alternatives',
      'nope',
      'nope is invalid and is disabled. No alternatives remain active.',
    ],
  ])('formats %s shortcut issues with surviving alternatives', (_name, value, message) => {
    const { tab, plugin } = makeTab();
    plugin.settings.shortcuts.openQuickCapture = value;
    if (_name === 'duplicate plus conflict') plugin.settings.shortcuts.openSearch = 'Q';
    (tab as unknown as { display(): void }).display();
    const body = hotkeysBody(tab);
    const input = shortcutInput(body, 'openQuickCapture');
    const issue = expectDefined(
      body.querySelector<HTMLElement>(`#${input.getAttribute('aria-describedby')}`),
    );

    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(issue.textContent).toContain(message);
  });

  it('coalesces rapid hotkey saves so out-of-order persistence cannot regress the final value', async () => {
    const settings = { current: undefined as CalendarSettings | undefined };
    const persisted: string[] = [];
    const saves: Array<{ value: string; completion: ReturnType<typeof deferred<void>> }> = [];
    const saveSettings = vi.fn(() => {
      const completion = deferred<void>();
      const value = expectDefined(settings.current).shortcuts.openQuickCapture;
      saves.push({ value, completion });
      void completion.promise
        .then(() => persisted.push(value))
        .catch((error: unknown) => {
          throw error;
        });
      return completion.promise;
    });
    const { tab, plugin } = makeTab({}, { saveSettings });
    settings.current = plugin.settings;
    const input = shortcutInput(hotkeysBody(tab), 'openQuickCapture');
    document.body.appendChild(tab.containerEl);
    input.focus();

    for (const value of ['Q', 'W', 'E']) {
      input.value = value;
      input.setSelectionRange(1, 1);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    expect(saveSettings).toHaveBeenCalledOnce();
    expect(saves.map((save) => save.value)).toEqual(['Q']);
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(1);

    expectDefined(saves[0]).completion.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(saves.map((save) => save.value)).toEqual(['Q', 'E']);
    expectDefined(saves[1]).completion.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(persisted).toEqual(['Q', 'E']);
    expect(plugin.settings.shortcuts.openQuickCapture).toBe('E');
    tab.containerEl.remove();
  });

  it('contains a failed hotkey save after the tab is hidden', async () => {
    let rejectSave!: (reason: Error) => void;
    const saveSettings = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSave = reject;
        }),
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { tab } = makeTab({}, { saveSettings });
      const input = shortcutInput(hotkeysBody(tab), 'openQuickCapture');

      input.value = 'W';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      tab.hide();
      rejectSave(new Error('storage failed'));
      await Promise.resolve();
      await Promise.resolve();

      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it('retains a failed save and exposes a retry that clears the unsaved state on success', async () => {
    let rejectFirst!: (reason: Error) => void;
    const first = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const saveSettings = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce(undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { tab } = makeTab({}, { saveSettings });
      const body = hotkeysBody(tab);
      const input = shortcutInput(body, 'openQuickCapture');
      input.value = 'Q | shift 7';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      rejectFirst(new Error('storage failed'));
      await Promise.resolve();
      await Promise.resolve();

      const status = expectDefined(body.querySelector<HTMLElement>('.abyss-shortcut-save-status'));
      const retry = expectDefined(
        body.querySelector<HTMLButtonElement>('.abyss-shortcut-save-retry'),
      );
      expect(status.textContent).toContain('not saved');
      expect(retry.hidden).toBe(false);
      expect(input.value).toBe('Q | shift 7');

      retry.click();
      await Promise.resolve();
      await Promise.resolve();

      expect(saveSettings).toHaveBeenCalledTimes(2);
      expect(status.textContent).toBe('');
      expect(retry.hidden).toBe(true);
    } finally {
      error.mockRestore();
    }
  });
});

describe('CalendarSettingsTab renderTagGroupSettings', () => {
  it('inbox source dropdown has tag/untagged options', () => {
    const { tab } = makeTab({
      inbox: { mode: 'untagged', tag: '', removeTagOnAssign: true },
    });
    const body = openSection(tab, 3);
    const dd = findDropdown(body, 'Inbox source');
    expect(dd).not.toBeNull();
    const options = Array.from(expectDefined(dd).options).map((o) => o.value);
    expect(options).toContain('tag');
    expect(options).toContain('untagged');
  });

  it('inbox source switch to tag saves and re-renders', () => {
    const { tab, plugin, captured } = makeTab({
      inbox: { mode: 'untagged', tag: '', removeTagOnAssign: true },
    });
    openSection(tab, 3);
    expectDefined(findComp(captured, 'Inbox source', 'dropdown')).comp.setValue('tag');
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(plugin.settings.inbox.mode).toBe('tag');
  });

  it('inbox tag field visible when inboxMode is tag', () => {
    const { tab } = makeTab({
      inbox: { mode: 'tag', tag: '#inbox', removeTagOnAssign: true },
    });
    const body = openSection(tab, 3);
    const input = findInput(body, 'Inbox tag');
    expect(input).not.toBeNull();
    expect(expectDefined(input).value).toBe('#inbox');
  });

  it('inbox tag field hidden when inboxMode is untagged', () => {
    const { tab } = makeTab({
      inbox: { mode: 'untagged', tag: '', removeTagOnAssign: true },
    });
    const body = openSection(tab, 3);
    const input = findInput(body, 'Inbox tag');
    expect(input).toBeNull();
  });

  it('inbox tag change saves (trimmed)', () => {
    const { tab, plugin, captured } = makeTab({
      inbox: { mode: 'tag', tag: '#old', removeTagOnAssign: true },
    });
    openSection(tab, 3);
    expectDefined(findComp(captured, 'Inbox tag', 'text')).comp.setValue('  #new  ');
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(plugin.settings.inbox.tag).toBe('#new');
  });

  it('add group button appends new group with timestamp id', () => {
    const { tab, plugin, captured } = makeTab({ tagGroups: [] });
    openSection(tab, 4);
    // Add group button is the only button with empty name (no setName called)
    const addBtn = captured.find((c) => c.type === 'button' && c.name === '');
    expect(addBtn).toBeDefined();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-25T10:00:00Z'));
    const addButton = expectDefined(addBtn).comp;
    if (addButton.clickHandler === undefined) {
      throw new Error('Expected the add button to expose a click handler');
    }
    addButton.clickHandler();
    vi.useRealTimers();
    expect(plugin.settings.tagGroups).toHaveLength(1);
    expect(expectDefined(plugin.settings.tagGroups[0]).id).toMatch(/^group-\d+$/);
    expect(plugin.saveSettings).toHaveBeenCalled();
  });
});

describe('CalendarSettingsTab renderTagGroupCard', () => {
  const baseGroup = { id: 'g1', name: 'Work', mode: 'prefix' as const, prefix: 'work' };

  it('group name input saves on change', () => {
    const { tab, plugin, captured } = makeTab({ tagGroups: [{ ...baseGroup }] });
    openSection(tab, 4);
    expectDefined(findComp(captured, 'Group name', 'text')).comp.setValue('Personal');
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(expectDefined(plugin.settings.tagGroups[0]).name).toBe('Personal');
  });

  it('mode dropdown has prefix/manual options', () => {
    const { tab } = makeTab({ tagGroups: [{ ...baseGroup }] });
    const body = openSection(tab, 4);
    const dd = findDropdown(body, 'Mode');
    expect(dd).not.toBeNull();
    const options = Array.from(expectDefined(dd).options).map((o) => o.value);
    expect(options).toEqual(['prefix', 'manual']);
  });

  it('prefix mode shows Prefix input', () => {
    const { tab } = makeTab({ tagGroups: [{ ...baseGroup, mode: 'prefix', prefix: 'work' }] });
    const body = openSection(tab, 4);
    expect(findInput(body, 'Prefix')).not.toBeNull();
    expect(findInput(body, 'Tags')).toBeNull();
  });

  it('manual mode shows Tags input', () => {
    const { tab } = makeTab({ tagGroups: [{ ...baseGroup, mode: 'manual', tags: ['#a', '#b'] }] });
    const body = openSection(tab, 4);
    expect(findInput(body, 'Tags')).not.toBeNull();
    expect(findInput(body, 'Prefix')).toBeNull();
  });

  it('prefix input change saves (trimmed)', () => {
    const { tab, plugin, captured } = makeTab({ tagGroups: [{ ...baseGroup, prefix: '' }] });
    openSection(tab, 4);
    expectDefined(findComp(captured, 'Prefix', 'text')).comp.setValue('  work  ');
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(expectDefined(plugin.settings.tagGroups[0]).prefix).toBe('work');
  });

  it('tags CSV input parses to array (split, trim, filter empty)', () => {
    const { tab, plugin, captured } = makeTab({
      tagGroups: [{ ...baseGroup, mode: 'manual', tags: [] }],
    });
    openSection(tab, 4);
    expectDefined(findComp(captured, 'Tags', 'text')).comp.setValue('a, b, c');
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(expectDefined(plugin.settings.tagGroups[0]).tags).toEqual(['a', 'b', 'c']);
  });

  it('tags CSV input filters out empty values', () => {
    const { tab, plugin, captured } = makeTab({
      tagGroups: [{ ...baseGroup, mode: 'manual', tags: [] }],
    });
    openSection(tab, 4);
    expectDefined(findComp(captured, 'Tags', 'text')).comp.setValue('a,, ,b');
    expect(expectDefined(plugin.settings.tagGroups[0]).tags).toEqual(['a', 'b']);
  });

  it('color picker saves on change', () => {
    const { tab, plugin, captured } = makeTab({ tagGroups: [{ ...baseGroup, color: '#ff0000' }] });
    const body = openSection(tab, 4);
    const colorInput = findColorInput(body, 'Color');
    expect(colorInput).not.toBeNull();
    expectDefined(findComp(captured, 'Color', 'color')).comp.setValue('#00ff00');
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(expectDefined(plugin.settings.tagGroups[0]).color).toBe('#00ff00');
  });

  it('delete button splices group and saves', () => {
    const { tab, plugin, captured } = makeTab({
      tagGroups: [{ ...baseGroup }, { ...baseGroup, id: 'g2', name: 'Other' }],
    });
    const body = openSection(tab, 4);
    const cards = body.querySelectorAll('.abyss-settings-card');
    expect(cards).toHaveLength(2);
    // Each card has its own "Delete group" warning button.
    const delBtns = captured.filter((c) => {
      if (c.type !== 'button') return false;
      const el = (c.comp as unknown as { buttonEl?: HTMLElement }).buttonEl;
      return el?.textContent === 'Delete group';
    });
    expect(delBtns).toHaveLength(2);
    const deleteButton = expectDefined(delBtns[0]).comp;
    if (deleteButton.clickHandler === undefined) {
      throw new Error('Expected the delete button to expose a click handler');
    }
    deleteButton.clickHandler();
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(plugin.settings.tagGroups).toHaveLength(1);
    expect(expectDefined(plugin.settings.tagGroups[0]).id).toBe('g2');
  });
});

describe('CalendarSettingsTab renderViewConfigSettings', () => {
  it('default view dropdown has month/week/list', () => {
    const { tab } = makeTab();
    const body = openSection(tab, 1); // Desktop
    const dd = findDropdown(body, 'Default view');
    expect(dd).not.toBeNull();
    const options = Array.from(expectDefined(dd).options).map((o) => o.value);
    expect(options).toEqual(['month', 'week', 'list']);
  });

  it('default view change saves', () => {
    const { tab, plugin, captured } = makeTab();
    openSection(tab, 1);
    expectDefined(findComp(captured, 'Default view', 'dropdown')).comp.setValue('week');
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(plugin.settings.desktop.defaultView).toBe('week');
  });

  it('does not render a legacy "Default style" dropdown (desktop)', () => {
    const { tab } = makeTab();
    const body = openSection(tab, 1);
    expect(findDropdown(body, 'Default style')).toBeNull();
  });

  it('first day of week dropdown parses int on change', () => {
    const { tab, plugin, captured } = makeTab();
    openSection(tab, 1);
    expectDefined(findComp(captured, 'First day of week', 'dropdown')).comp.setValue('1');
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(plugin.settings.desktop.firstDayOfWeek).toBe(1);
  });

  it('daily note folder input saves (manual provider)', () => {
    const { tab, plugin, captured } = makeTab({ dailyNoteProvider: 'manual' });
    openSection(tab, 1);
    expectDefined(findComp(captured, 'Daily note folder', 'text')).comp.setValue('notes/daily');
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(plugin.settings.desktop.dailyNoteFolder).toBe('notes/daily');
  });

  it('daily note format input saves (manual provider)', () => {
    const { tab, plugin, captured } = makeTab({ dailyNoteProvider: 'manual' });
    openSection(tab, 1);
    expectDefined(findComp(captured, 'Daily note format', 'text')).comp.setValue('DD-MM-YYYY');
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(plugin.settings.desktop.dailyNoteFormat).toBe('DD-MM-YYYY');
  });

  it('daily note folder and format hidden when addToToday is true and provider is auto', () => {
    const { tab } = makeTab({ addToToday: true, dailyNoteProvider: 'auto' });
    const body = openSection(tab, 1);
    expect(findInput(body, 'Daily note folder')).toBeNull();
    expect(findInput(body, 'Daily note format')).toBeNull();
  });

  it('global task filter input saves', () => {
    const { tab, plugin, captured } = makeTab();
    openSection(tab, 1);
    expectDefined(findComp(captured, 'Global task filter', 'text')).comp.setValue('#task');
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(plugin.settings.desktop.globalTaskFilter).toBe('#task');
  });

  it('upcoming days valid number saves', () => {
    const { tab, plugin, captured } = makeTab();
    openSection(tab, 1);
    expectDefined(findComp(captured, 'Upcoming days', 'text')).comp.setValue('14');
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(plugin.settings.desktop.upcomingDays).toBe(14);
  });

  it.each(['abc', '-5', '0'])('upcoming days invalid input %s does not save', (invalidValue) => {
    const { tab, plugin, captured } = makeTab({
      desktop: { ...DEFAULT_SETTINGS.desktop, upcomingDays: 7 },
    });
    openSection(tab, 1);
    expectDefined(findComp(captured, 'Upcoming days', 'text')).comp.setValue(invalidValue);
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    expect(plugin.settings.desktop.upcomingDays).toBe(7);
  });

  it('mobile section has same view config settings, and no "Default style" dropdown', () => {
    const { tab } = makeTab({ dailyNoteProvider: 'manual' });
    const body = openSection(tab, 2); // Mobile
    expect(findDropdown(body, 'Default view')).not.toBeNull();
    expect(findDropdown(body, 'Default style')).toBeNull();
    expect(findInput(body, 'Daily note folder')).not.toBeNull();
  });
});

describe('sourceNoteDisplay setting', () => {
  it('renders a source-note-display dropdown in the General section', () => {
    const { tab } = makeTab();
    // Open the General section (index 0) to make its body visible
    const headers = Array.from(
      tab.containerEl.querySelectorAll<HTMLElement>('.abyss-settings-section-header'),
    );
    expectDefined(headers[0]).click();
    const selects = tab.containerEl.querySelectorAll<HTMLSelectElement>('select');
    const values = Array.from(selects).map((s) => s.value);
    expect(values).toContain('non-default');
  });

  it('dropdown has three options: never, always, non-default', () => {
    const { tab } = makeTab();
    const headers = Array.from(
      tab.containerEl.querySelectorAll<HTMLElement>('.abyss-settings-section-header'),
    );
    expectDefined(headers[0]).click();
    const selects = Array.from(tab.containerEl.querySelectorAll<HTMLSelectElement>('select'));
    const sourceSelect = selects.find((s) =>
      Array.from(s.options).some((o) => o.value === 'non-default'),
    );
    expect(sourceSelect).not.toBeUndefined();
    const optionValues = Array.from(expectDefined(sourceSelect).options).map((o) => o.value);
    expect(optionValues).toContain('never');
    expect(optionValues).toContain('always');
    expect(optionValues).toContain('non-default');
  });

  it('dropdown reflects current settings value', () => {
    const { tab, plugin } = makeTab();
    plugin.settings.sourceNoteDisplay = 'always';
    (tab as unknown as { display(): void }).display();
    const headers = Array.from(
      tab.containerEl.querySelectorAll<HTMLElement>('.abyss-settings-section-header'),
    );
    expectDefined(headers[0]).click();
    const selects = Array.from(tab.containerEl.querySelectorAll<HTMLSelectElement>('select'));
    const sourceSelect = selects.find((s) =>
      Array.from(s.options).some((o) => o.value === 'non-default'),
    );
    expect(sourceSelect?.value).toBe('always');
  });
});

describe('CalendarSettingsTab collapsible cards + default status', () => {
  it('rejects a tag-group card payload dropped on the project-status list', () => {
    const tagGroups = [{ id: 'group-work', name: 'Work', mode: 'prefix' as const, prefix: 'work' }];
    const { tab, plugin } = makeTab({ tagGroups });
    const tagBody = openSection(tab, 4);
    const projectBody = openSection(tab, 5);
    const beforeStatuses = plugin.settings.projects.statuses.map(({ id }) => id);

    dragCard(
      cardNamed(tagBody, 'Work'),
      projectStatusRowNamed(projectBody, expectDefined(plugin.settings.projects.statuses[1]).name),
    );

    expect(plugin.settings.projects.statuses.map(({ id }) => id)).toEqual(beforeStatuses);
    expect(plugin.settings.tagGroups.map(({ id }) => id)).toEqual(['group-work']);
    expect(plugin.saveSettings).not.toHaveBeenCalled();
  });

  it('keeps the focused draft and current identities through repeated project-status drops', () => {
    const { tab, plugin } = makeTab();
    const body = openSection(tab, 5);
    const scroller = attachSettingsScroller(tab, 513);
    const [first, second, third] = plugin.settings.projects.statuses;
    const firstStatus = expectDefined(first);
    const secondStatus = expectDefined(second);
    const thirdStatus = expectDefined(third);
    const firstRow = projectStatusRowNamed(body, firstStatus.name);
    const secondRow = projectStatusRowNamed(body, secondStatus.name);
    const thirdRow = projectStatusRowNamed(body, thirdStatus.name);
    const draft = expectDefined(
      firstRow.querySelector<HTMLInputElement>('.abyss-project-value-raw'),
    );
    draft.value = 'unfinished status draft';
    draft.focus();
    draft.setSelectionRange(10, 10);

    dragProjectValueRow(secondRow, firstRow);
    dragProjectValueRow(secondRow, thirdRow);
    dragProjectValueRow(thirdRow, secondRow);

    expect(plugin.settings.projects.statuses.slice(0, 3).map(({ id }) => id)).toEqual([
      firstStatus.id,
      secondStatus.id,
      thirdStatus.id,
    ]);
    expect(projectStatusOrder(tab)).toEqual([firstStatus.id, secondStatus.id, thirdStatus.id]);
    expect(scroller.scrollTop).toBe(513);
    expect(activeDocument.activeElement).toBe(draft);
    expect(draft.isConnected).toBe(true);
    expect(draft.value).toBe('unfinished status draft');
    expect(draft.selectionStart).toBe(10);
    expect(plugin.renameProjectStatus).not.toHaveBeenCalled();
  });

  it('restores a focused moved-preset draft by stable runtime identity after refresh', () => {
    const projects = structuredClone(DEFAULT_SETTINGS.projects);
    projects.table.columns.push({ id: 'property:Priority', visible: true });
    projects.propertyDefinitions['property:Priority'] = {
      type: 'text',
      presets: [{ value: 'A' }, { value: 'B' }, { value: 'C' }],
    };
    const projectProperties: ProjectPropertyCatalog = {
      list: () => [{ name: 'Priority', type: 'text' }],
      inspect: () => ({ kind: 'available', property: undefined, assignment: { kind: 'none' } }),
      values: () => [],
      onChange: () => () => {},
    };
    const { tab } = makeTab({ projects }, { projectProperties });
    const body = openSection(tab, 5);
    attachSettingsScroller(tab, 513);
    const rows = Array.from(
      body.querySelectorAll<HTMLElement>(
        '[data-column-id="property:Priority"] .abyss-project-value-row',
      ),
    );
    const moved = expectDefined(rows[2]);
    dragProjectValueRow(moved, expectDefined(rows[0]));
    const movedId = expectDefined(moved.dataset['settingsItemId']);
    const draft = expectDefined(moved.querySelector<HTMLInputElement>('.abyss-project-value-raw'));
    draft.value = 'unfinished preset draft';
    draft.focus();
    draft.setSelectionRange(4, 13, 'backward');

    (tab as unknown as { display(): void }).display();

    const restoredRow = expectDefined(
      Array.from(
        tab.containerEl.querySelectorAll<HTMLElement>(
          '[data-column-id="property:Priority"] .abyss-project-value-row',
        ),
      ).find((row) => row.dataset['settingsItemId'] === movedId),
    );
    const restored = expectDefined(
      restoredRow.querySelector<HTMLInputElement>('.abyss-project-value-raw'),
    );
    expect(restored.value).toBe('unfinished preset draft');
    expect(activeDocument.activeElement).toBe(restored);
    expect(restored.selectionStart).toBe(4);
    expect(restored.selectionEnd).toBe(13);
    expect(restored.selectionDirection).toBe('backward');
  });

  it('owns a nested project-status drag without bubbling it into the property card', () => {
    const { tab, plugin } = makeTab();
    const body = openSection(tab, 5);
    const statusProperty = expectDefined(
      body.querySelector<HTMLElement>('[data-card-id="project-property:status"]'),
    );
    const nestedStatus = projectStatusRowNamed(
      body,
      expectDefined(plugin.settings.projects.statuses[0]).name,
    );
    const outerDragStart = vi.fn();
    statusProperty.addEventListener('dragstart', outerDragStart);

    dispatchProjectValueDragStart(nestedStatus);

    expect(outerDragStart).not.toHaveBeenCalled();
    expect(nestedStatus.hasClass('abyss-dragging')).toBe(true);
    expect(statusProperty.hasClass('abyss-dragging')).toBe(false);
  });

  it('preserves focused draft context when display rebuilds an open settings tab', () => {
    const { tab, plugin } = makeTab();
    const body = openSection(tab, 5);
    const scroller = attachSettingsScroller(tab, 513);
    const status = expectDefined(plugin.settings.projects.statuses[0]);
    const before = expectDefined(
      projectStatusRowNamed(body, status.name).querySelector<HTMLInputElement>(
        '.abyss-project-value-raw',
      ),
    );
    before.value = 'display draft';
    before.focus();
    before.setSelectionRange(4, 9, 'backward');

    (tab as unknown as { display(): void }).display();

    const after = expectDefined(
      projectStatusRow(tab.containerEl, status.id).querySelector<HTMLInputElement>(
        '.abyss-project-value-raw',
      ),
    );
    expect(after).not.toBe(before);
    expect(scroller.scrollTop).toBe(513);
    expect(activeDocument.activeElement).toBe(after);
    expect(after.value).toBe('display draft');
    expect(after.selectionStart).toBe(4);
    expect(after.selectionEnd).toBe(9);
    expect(after.selectionDirection).toBe('backward');
  });

  it('updates status labels in place and restores a draft after the display name changes', () => {
    const { tab, plugin } = makeTab();
    const body = openSection(tab, 5);
    attachSettingsScroller(tab, 513);
    const status = expectDefined(plugin.settings.projects.statuses[0]);
    const row = projectStatusRowNamed(body, status.name);
    const displayName = expectDefined(
      row.querySelector<HTMLInputElement>('.abyss-project-value-alias'),
    );
    const grip = expectDefined(row.querySelector<HTMLElement>('.abyss-project-value-grip'));
    const value = expectDefined(row.querySelector<HTMLInputElement>('.abyss-project-value-raw'));
    const color = expectDefined(row.querySelector<HTMLInputElement>('.abyss-project-value-color'));
    const appearance = expectDefined(
      row.querySelector<HTMLSelectElement>('.abyss-project-value-appearance'),
    );
    const leftPanel = expectDefined(
      row.querySelector<HTMLInputElement>('.abyss-project-value-left-panel'),
    );
    const leftPanelLabel = expectDefined(leftPanel.closest<HTMLLabelElement>('label'));
    const remove = expectDefined(
      row.querySelector<HTMLButtonElement>('.abyss-project-value-remove'),
    );
    displayName.value = 'Current work';
    displayName.dispatchEvent(new Event('change', { bubbles: true }));

    expect(grip.getAttribute('aria-label')).toBe('Reorder Current work');
    expect(grip.title).toBe('Reorder Current work');
    expect(value.getAttribute('aria-label')).toBe('Value for Current work');
    expect(displayName.getAttribute('aria-label')).toBe('Display name for Current work');
    expect(color.getAttribute('aria-label')).toBe('Color for Current work');
    expect(appearance.getAttribute('aria-label')).toBe('Appearance for Current work');
    expect(leftPanel.getAttribute('aria-label')).toBe('Show Current work on left panel');
    expect(leftPanelLabel.title).toBe('Show Current work on left panel');
    expect(remove.getAttribute('aria-label')).toBe('Remove Current work');
    expect(remove.title).toBe('Remove Current work');
    expect(value.dataset['settingsFocusKey']).toBe('value');
    value.value = 'unfinished status draft';
    value.focus();
    value.setSelectionRange(5, 11);

    (tab as unknown as { display(): void }).display();

    const restored = expectDefined(
      projectStatusRow(tab.containerEl, status.id).querySelector<HTMLInputElement>(
        '.abyss-project-value-raw',
      ),
    );
    expect(restored.getAttribute('aria-label')).toBe('Value for Current work');
    expect(restored.value).toBe('unfinished status draft');
    expect(activeDocument.activeElement).toBe(restored);
    expect(restored.selectionStart).toBe(5);
    expect(restored.selectionEnd).toBe(11);
  });

  it('omits project-column width inputs while retaining saved widths', () => {
    const { tab, plugin } = makeTab();
    expectDefined(
      plugin.settings.projects.table.columns.find(({ id }) => id === 'progress'),
    ).width = 260;
    openSection(tab, 5);

    (tab as unknown as { display(): void }).display();

    expect(tab.containerEl.querySelector('.abyss-project-column-width')).toBeNull();
    expect(plugin.settings.projects.table.columns.find(({ id }) => id === 'progress')?.width).toBe(
      260,
    );
  });

  it('expands one card without replacing an unrelated focused settings control', () => {
    const { tab } = makeTab({}, { expand: false });
    const general = openSection(tab, 0);
    const projects = openSection(tab, 5);
    attachSettingsScroller(tab, 513);
    const taskPrefix = expectDefined(findInput(general, 'Task prefix'));
    taskPrefix.value = '#unfinished';
    taskPrefix.focus();
    taskPrefix.setSelectionRange(5, 5);
    expect(activeDocument.activeElement).toBe(taskPrefix);

    expectDefined(projects.querySelector<HTMLElement>('.abyss-settings-card-header')).click();

    expect(activeDocument.activeElement).toBe(taskPrefix);
    expect(taskPrefix.isConnected).toBe(true);
    expect(taskPrefix.value).toBe('#unfinished');
    expect(taskPrefix.selectionStart).toBe(5);
    expect(projects.querySelector('.abyss-settings-card.is-open')).not.toBeNull();
  });

  it('ignores unchanged catalog events and preserves draft context for a changed catalog', () => {
    let properties = [{ name: 'status', type: 'text' as const }];
    let publish: () => void = () => {};
    const projectProperties: ProjectPropertyCatalog = {
      list: () => properties,
      inspect: () => ({ kind: 'available', property: undefined, assignment: { kind: 'none' } }),
      values: () => [],
      onChange: (callback) => {
        publish = callback;
        return () => {};
      },
    };
    const { tab, plugin } = makeTab({}, { projectProperties });
    const body = openSection(tab, 5);
    const scroller = attachSettingsScroller(tab, 513);
    const status = expectDefined(plugin.settings.projects.statuses[0]);
    const input = expectDefined(
      projectStatusRowNamed(body, status.name).querySelector<HTMLInputElement>(
        '.abyss-project-value-raw',
      ),
    );
    input.value = 'catalog draft';
    input.focus();
    input.setSelectionRange(7, 7);

    publish();
    expect(activeDocument.activeElement).toBe(input);
    expect(input.isConnected).toBe(true);

    properties = [...properties, { name: 'Phase', type: 'text' }];
    publish();

    const replacement = expectDefined(
      projectStatusRow(tab.containerEl, status.id).querySelector<HTMLInputElement>(
        '.abyss-project-value-raw',
      ),
    );
    const statusSource = expectDefined(findInput(tab.containerEl, 'Status property'));
    expect(statusSource.value).toBe('status');
    expect(scroller.scrollTop).toBe(513);
    expect(activeDocument.activeElement).toBe(replacement);
    expect(replacement.value).toBe('catalog draft');
    expect(replacement.selectionStart).toBe(7);
  });

  it('keeps the reordered draft and offers a current-state retry after save failure', async () => {
    vi.mocked(Notice).mockClear();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const saveSettings = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk unavailable'))
      .mockResolvedValue(undefined);
    const { tab, plugin } = makeTab({}, { saveSettings });
    const body = openSection(tab, 5);
    const before = plugin.settings.projects.statuses.map(({ id }) => id);
    const first = projectStatusRowNamed(
      body,
      expectDefined(plugin.settings.projects.statuses[0]).name,
    );
    const second = projectStatusRowNamed(
      body,
      expectDefined(plugin.settings.projects.statuses[1]).name,
    );

    dragProjectValueRow(second, first);
    await Promise.resolve();
    await Promise.resolve();

    expect(plugin.settings.projects.statuses.map(({ id }) => id)).toEqual([
      expectDefined(before[1]),
      expectDefined(before[0]),
      ...before.slice(2),
    ]);
    expect(projectStatusOrder(tab)).toEqual(
      plugin.settings.projects.statuses.slice(0, 3).map(({ id }) => id),
    );
    expect(Notice).toHaveBeenCalledOnce();
    const noticeContent = vi.mocked(Notice).mock.calls[0]?.[0];
    expect(noticeContent).toBeInstanceOf(DocumentFragment);
    expect((noticeContent as DocumentFragment).textContent).toContain(
      'Could not reorder project statuses: disk unavailable. Changes are kept in this session.',
    );
    expectDefined((noticeContent as DocumentFragment).querySelector('button')).click();
    await Promise.resolve();
    expect(saveSettings).toHaveBeenCalledTimes(2);
    expect(errorLog).toHaveBeenCalledWith(
      '[abyss-tasks] Could not reorder project statuses',
      objectMatching<{ cause: unknown }>({ cause: expect.any(Error) as unknown }),
    );
    errorLog.mockRestore();
  });

  it('does not let an older failed reorder overwrite a newer project-status order', async () => {
    let rejectFirst!: (error: Error) => void;
    const firstSave = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const saveSettings = vi
      .fn()
      .mockImplementationOnce(() => firstSave)
      .mockResolvedValue(undefined);
    const { tab, plugin } = makeTab({}, { saveSettings });
    const body = openSection(tab, 5);
    const [first, second, third] = plugin.settings.projects.statuses;
    const firstStatus = expectDefined(first);
    const secondStatus = expectDefined(second);
    const thirdStatus = expectDefined(third);
    const secondRow = projectStatusRowNamed(body, secondStatus.name);

    dragProjectValueRow(secondRow, projectStatusRowNamed(body, firstStatus.name));
    dragProjectValueRow(secondRow, projectStatusRowNamed(body, thirdStatus.name));
    rejectFirst(new Error('older write failed'));
    await Promise.resolve();
    await Promise.resolve();

    expect(plugin.settings.projects.statuses.slice(0, 3).map(({ id }) => id)).toEqual([
      firstStatus.id,
      thirdStatus.id,
      secondStatus.id,
    ]);
    expect(projectStatusOrder(tab)).toEqual([firstStatus.id, thirdStatus.id, secondStatus.id]);
  });

  it('renders a tag-group addition immediately and keeps it after save failure', async () => {
    vi.mocked(Notice).mockClear();
    const { tab, plugin, captured } = makeTab(
      { tagGroups: [] },
      { saveSettings: vi.fn().mockRejectedValue(new Error('disk unavailable')) },
    );
    openSection(tab, 4);
    attachSettingsScroller(tab, 513);

    expectDefined(capturedButton(captured, '+ add group', 'Tag groups').clickHandler)();

    expect(plugin.settings.tagGroups).toHaveLength(1);
    expect(cardNamed(tab.containerEl, 'New group').isConnected).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect((vi.mocked(Notice).mock.calls[0]?.[0] as DocumentFragment).textContent).toContain(
      'Changes are kept in this session',
    );
  });

  it('renders a tag-group deletion immediately and keeps it after save failure', async () => {
    const { tab, plugin, captured } = makeTab(
      { tagGroups: [{ id: 'g1', name: 'Work', mode: 'prefix', prefix: 'work' }] },
      { saveSettings: vi.fn().mockRejectedValue(new Error('disk unavailable')) },
    );
    openSection(tab, 4);
    attachSettingsScroller(tab, 513);

    expectDefined(capturedButton(captured, 'Delete group', 'Tag groups').clickHandler)();

    expect(plugin.settings.tagGroups).toHaveLength(0);
    expect(tab.containerEl.textContent).not.toContain('Work');
    await Promise.resolve();
    await Promise.resolve();
    expect(Notice).toHaveBeenCalled();
  });

  it('renders project-status add and delete drafts before persistence settles', async () => {
    const pending = deferred<void>();
    const { tab, plugin } = makeTab({}, { saveSettings: vi.fn(() => pending.promise) });
    openSection(tab, 5);
    attachSettingsScroller(tab, 513);

    expectDefined(
      tab.containerEl.querySelector<HTMLButtonElement>('[aria-label="Add project status"]'),
    ).click();
    expect(projectStatusRowNamed(tab.containerEl, 'status 4').isConnected).toBe(true);
    expect(activeDocument.activeElement).toBe(
      projectStatusRowNamed(tab.containerEl, 'status 4').querySelector('.abyss-project-value-raw'),
    );

    const deleteStatus = expectDefined(plugin.settings.projects.statuses[0]);
    expectDefined(
      projectStatusRowNamed(tab.containerEl, deleteStatus.name).querySelector<HTMLButtonElement>(
        '.abyss-project-value-remove',
      ),
    ).click();
    expect(plugin.settings.projects.statuses.some(({ id }) => id === deleteStatus.id)).toBe(false);
    expect(
      projectStatusRows(tab.containerEl).find(
        (row) => row.dataset['settingsItemId'] === deleteStatus.id,
      ),
    ).toBeUndefined();
    pending.resolve();
    await pending.promise;
  });

  it('keeps task-status add and delete drafts coherent when saves fail', async () => {
    vi.mocked(Notice).mockClear();
    const custom = {
      id: 'status-custom',
      symbol: '!',
      name: 'Important',
      type: 'todo' as const,
      icon: 'alert-triangle',
      core: false,
    };
    const { tab, plugin, captured } = makeTab(
      { taskStatuses: [...structuredClone(DEFAULT_SETTINGS.taskStatuses), custom] },
      { saveSettings: vi.fn().mockRejectedValue(new Error('disk unavailable')) },
    );
    openSection(tab, 6);
    attachSettingsScroller(tab, 513);

    expectDefined(capturedButton(captured, '+ add status', 'Custom statuses').clickHandler)();
    expect(cardNamed(tab.containerEl, 'New status').isConnected).toBe(true);
    expect(plugin.rebuildTaskStatusSemantics).toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();

    const deleteButton = capturedButton(captured, 'Delete status', 'Custom statuses');
    expectDefined(deleteButton.clickHandler)();
    expectDefined(deleteButton.clickHandler)();
    expect(plugin.settings.taskStatuses.some(({ id }) => id === custom.id)).toBe(false);
    expect(tab.containerEl.querySelector(`[data-card-id="${custom.id}"]`)).toBeNull();
    await Promise.resolve();
    await Promise.resolve();
    expect(Notice).toHaveBeenCalled();
  });

  it('refreshes a mounted project table after description and column view saves', async () => {
    const { tab, plugin } = makeTab();
    const projectsHeader = Array.from(
      tab.containerEl.querySelectorAll<HTMLElement>('.abyss-settings-section-header'),
    ).find((header) => header.textContent.includes('Projects'));
    expectDefined(projectsHeader).click();
    const description = expectDefined(
      tab.containerEl.querySelector<HTMLInputElement>('.abyss-project-show-description'),
    );

    description.checked = false;
    description.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    expect(plugin.saveViewState).toHaveBeenCalledOnce();
    expect(plugin.refreshProjectTableSettings).toHaveBeenCalledOnce();

    const column = expectDefined(
      Array.from(
        tab.containerEl.querySelectorAll<HTMLInputElement>('.abyss-project-column-visible'),
      ).find((input) => !input.disabled),
    );
    column.checked = !column.checked;
    column.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    expect(plugin.saveViewState).toHaveBeenCalledTimes(2);
    expect(plugin.refreshProjectTableSettings).toHaveBeenCalledTimes(2);
  });

  it('keeps the project toolbar contained at constrained panel widths', () => {
    expect(css).toContain('--abyss-center-toolbar-height: 60px');
    expect(css).toMatch(
      /\.abyss-center-header,\s*\.abyss-cal-nav\s*\{[^}]*min-height: var\(--abyss-center-toolbar-height\)/u,
    );
    expect(css).toMatch(
      /@container abyss-panel-layout \(max-width: 45rem\)[\s\S]*?\.abyss-projects-toolbar\s*\{(?=[^}]*display: grid)(?=[^}]*grid-template-columns: max-content minmax\(0, 1fr\))/u,
    );
    expect(css).toMatch(
      /@container abyss-panel-layout \(max-width: 45rem\)[\s\S]*?\.abyss-project-status-filters\s*\{(?=[^}]*grid-row: 2)(?=[^}]*max-width: none)/u,
    );
    expect(css).toMatch(
      /@container abyss-task-list \(max-width: 30rem\)[\s\S]*?\.abyss-cal-nav\s*\{(?=[^}]*flex-wrap: nowrap)(?=[^}]*overflow-x: auto)/u,
    );
    expect(css).toContain('min(var(--abyss-shell-top-inset), 5px)');
  });

  it('isolates compact table descriptions from dashboard spacing', () => {
    const declarations = declarationsFor('.abyss-projects-table .abyss-project-description');
    expect(declarations).toContain('margin: 0');
    expect(declarations).toContain('white-space: nowrap');
    expect(declarationsFor('.abyss-projects-table .abyss-project-description.is-empty')).toBe('');
  });

  it('lets the sorted drop marker override the group perimeter', () => {
    expect(
      declarationsFor('.abyss-project-table-row.is-drop-target.is-drop-before > td'),
    ).toContain('inset 0 2px');
    expect(declarationsFor('.abyss-project-table-row.is-drop-target.is-drop-after > td')).toContain(
      'inset 0 -2px',
    );
  });

  it('preserves the real settings scroller and focuses a newly added project status', async () => {
    const { tab } = makeTab();
    const scroller = document.body.createDiv({ cls: 'vertical-tab-content' });
    scroller.append(tab.containerEl);
    scroller.scrollTop = 720.5;
    const add = expectDefined(
      tab.containerEl.querySelector<HTMLButtonElement>('[aria-label="Add project status"]'),
    );

    add.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(scroller.scrollTop).toBe(720.5);
    expect(activeDocument.activeElement).toBe(
      projectStatusRowNamed(tab.containerEl, 'status 4').querySelector('.abyss-project-value-raw'),
    );
  });

  it('preserves the real settings scroller and focuses the newly added property card', async () => {
    const projectProperties: ProjectPropertyCatalog = {
      list: () => [{ name: 'Budget', type: 'number' }],
      inspect: () => ({ kind: 'available', property: undefined, assignment: { kind: 'none' } }),
      values: () => [],
      onChange: () => () => {},
    };
    const { tab } = makeTab({}, { projectProperties });
    const scroller = document.body.createDiv({ cls: 'vertical-tab-content' });
    scroller.append(tab.containerEl);
    scroller.scrollTop = 1855;
    const input = expectDefined(
      tab.containerEl.querySelector<HTMLInputElement>('.abyss-project-column-add-input'),
    );
    input.value = 'Budget';
    expectDefined(
      tab.containerEl.querySelector<HTMLButtonElement>('.abyss-project-column-add'),
    ).click();
    await flushMicrotasks();

    expect(scroller.scrollTop).toBe(1855);
    expect(activeDocument.activeElement).toBe(
      tab.containerEl.querySelector(
        '[data-card-id="project-property:property:Budget"] .abyss-project-property-toggle',
      ),
    );
  });

  it('renders project statuses as always-visible shared compact rows', () => {
    const { tab } = makeTab({}, { expand: false });
    const body = openSection(tab, 5); // Projects
    const statusProperty = expectDefined(
      body.querySelector<HTMLElement>('[data-card-id="project-property:status"]'),
    );
    expectDefined(statusProperty.querySelector<HTMLElement>('.abyss-settings-card-header')).click();
    const rows = projectStatusRows(statusProperty);
    expect(rows).toHaveLength(DEFAULT_SETTINGS.projects.statuses.length);
    expect(expectDefined(rows[0]).querySelector('.abyss-project-value-raw')).not.toBeNull();
    expect(expectDefined(rows[0]).querySelector('.abyss-project-value-alias')).not.toBeNull();
    expect(expectDefined(rows[0]).querySelector('.abyss-project-value-color')).not.toBeNull();
    expect(expectDefined(rows[0]).querySelector('.abyss-project-value-appearance')).not.toBeNull();
    expect(expectDefined(rows[0]).querySelector('.abyss-project-value-left-panel')).not.toBeNull();
    expect(expectDefined(rows[0]).querySelector('.abyss-project-value-remove')).not.toBeNull();
    expect(
      statusProperty.querySelector(
        '.abyss-project-value-list > .abyss-settings-card, .abyss-project-value-row .setting-item',
      ),
    ).toBeNull();
  });

  it('labels the status checkbox and prevents removing the final status', () => {
    const projects = structuredClone(DEFAULT_SETTINGS.projects);
    projects.statuses = [expectDefined(projects.statuses[0])];
    projects.defaultStatusId = expectDefined(projects.statuses[0]).id;
    const { tab, plugin } = makeTab({ projects });
    const body = openSection(tab, 5);
    const row = projectStatusRowNamed(body, expectDefined(projects.statuses[0]).name);
    const leftPanel = expectDefined(
      row.querySelector<HTMLInputElement>('.abyss-project-value-left-panel'),
    );
    const remove = expectDefined(
      row.querySelector<HTMLButtonElement>('.abyss-project-value-remove'),
    );

    expect(leftPanel.getAttribute('aria-label')).toBe('Show active on left panel');
    leftPanel.checked = true;
    leftPanel.dispatchEvent(new Event('change', { bubbles: true }));
    expect(plugin.settings.projects.statuses[0]?.onLeftPanel).toBe(true);
    expect(remove.disabled).toBe(true);
    remove.click();
    expect(plugin.settings.projects.statuses).toHaveLength(1);
  });

  it('a single Default status dropdown lists all statuses and sets defaultStatusId', () => {
    const { tab, plugin, captured } = makeTab();
    openSection(tab, 5);
    const dd = captured.find((c) => c.name === 'Default status' && c.type === 'dropdown');
    expect(dd).toBeTruthy();
    const plannedId = expectDefined(plugin.settings.projects.statuses[1]).id;
    expectDefined(dd).comp.setValue(plannedId);
    expect(plugin.settings.projects.defaultStatusId).toBe(plannedId);
    // No per-status "Default for new projects" toggle remains.
    expect(captured.some((c) => c.name === 'Default for new projects')).toBe(false);
  });

  it('renders project status appearance with native dropdown presentation', () => {
    const { tab, plugin } = makeTab();
    const body = openSection(tab, 5);
    const appearance = expectDefined(
      projectStatusRowNamed(body, 'active').querySelector<HTMLSelectElement>(
        '.abyss-project-value-appearance',
      ),
    );

    expect(appearance.classList.contains('dropdown')).toBe(true);
    expect(appearance.getAttribute('aria-label')).toBe('Appearance for active');
    expect(appearance.value).toBe('badge');
    expect(Array.from(appearance.options).map(({ value }) => value)).toEqual([
      'badge',
      'text',
      'dot',
    ]);
    appearance.value = 'dot';
    appearance.dispatchEvent(new Event('change', { bubbles: true }));
    expect(plugin.settings.projects.statuses[0]?.display).toBe('dot');
  });

  it('deleting the default status repoints defaultStatusId to the first remaining', () => {
    const { tab, plugin } = makeTab();
    // Make the first status the default, then delete it.
    plugin.settings.projects.defaultStatusId = expectDefined(
      plugin.settings.projects.statuses[0],
    ).id;
    const body = openSection(tab, 5);
    const survivorId = expectDefined(plugin.settings.projects.statuses[1]).id;
    expectDefined(
      projectStatusRowNamed(body, 'active').querySelector<HTMLButtonElement>(
        '.abyss-project-value-remove',
      ),
    ).click();
    expect(plugin.settings.projects.defaultStatusId).toBe(survivorId);
  });
});

describe('CalendarSettingsTab card badges and project status metadata', () => {
  it('tag-group card headers show a mode badge distinguishing manual vs prefix', () => {
    const { tab } = makeTab({
      tagGroups: [
        { id: 'p', name: 'Pre', mode: 'prefix', prefix: 'work' },
        { id: 'm', name: 'Man', mode: 'manual', tags: ['#x'] },
      ],
    });
    const body = openSection(tab, 4);
    const badges = Array.from(body.querySelectorAll('.abyss-settings-card-badge')).map(
      (b) => b.textContent,
    );
    expect(badges).toContain('prefix');
    expect(badges).toContain('manual');
  });

  it('status rows have one shared property source and no per-status source badge', () => {
    const { tab } = makeTab();
    const body = openSection(tab, 5);
    const badges = Array.from(body.querySelectorAll('.abyss-settings-card-badge')).map(
      (b) => b.textContent,
    );
    expect(badges).toEqual([]);
    const statusProperty = expectDefined(findInput(body, 'Status property'));
    expect(statusProperty.value).toBe('status');
    expect(statusProperty.getAttribute('aria-label')).toBe('Status property');
    expect(findDropdown(body, 'Status property')).toBeNull();
    expect(body.textContent).not.toContain('Defined by');
    expect(projectStatusRowNamed(body, 'active')).toBeDefined();
  });

  it('commits a status rename on blur rather than on each input event', async () => {
    const { tab, plugin } = makeTab();
    const body = openSection(tab, 5);
    const input = expectDefined(
      projectStatusRowNamed(body, 'active').querySelector<HTMLInputElement>(
        '.abyss-project-value-raw',
      ),
    );
    input.value = 'running';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(plugin.renameProjectStatus).not.toHaveBeenCalled();

    input.dispatchEvent(new Event('blur'));
    await Promise.resolve();
    await Promise.resolve();

    expect(plugin.renameProjectStatus).toHaveBeenCalledWith('status-1', 'running', 'active');
  });

  it('nests status and curated date controls inside their property cards', () => {
    const { tab } = makeTab();
    const body = openSection(tab, 5);
    const text = body.textContent;
    expect(text).not.toContain('Statuses');
    expect(text.indexOf('Status property')).toBeGreaterThan(text.indexOf('Table columns'));
    expect(text.indexOf('Start property')).toBeGreaterThan(text.indexOf('Table columns'));
    expect(text.indexOf('End property')).toBeGreaterThan(text.indexOf('Table columns'));
  });

  it('keeps the status text source independent of curated date-source choices', () => {
    const projects = structuredClone(DEFAULT_SETTINGS.projects);
    projects.statusProperty = 'Статус';
    projects.startProperty = 'Начало';
    projects.endProperty = 'Конец';
    const projectProperties: ProjectPropertyCatalog = {
      list: () => [
        { name: 'Статус', type: 'text' },
        { name: 'Фаза', type: 'text' },
        { name: 'description', type: 'text' },
        { name: 'Начало', type: 'date' },
        { name: 'Конец', type: 'date' },
        { name: 'Wrong type', type: 'number' },
      ],
      inspect: () => ({
        kind: 'available',
        property: undefined,
        assignment: { kind: 'none' },
      }),
      values: () => [],
      onChange: () => () => {},
    };
    const { tab, plugin } = makeTab({ projects }, { projectProperties });
    const body = openSection(tab, 5);
    const status = expectDefined(findInput(body, 'Status property'));
    const start = expectDefined(findDropdown(body, 'Start property'));
    expect(status.value).toBe('Статус');
    expect(Array.from(start.options).map(({ value }) => value)).toEqual([
      'Фаза',
      'Начало',
      'Wrong type',
    ]);

    expect(plugin.settings.projects.startProperty).toBe('Начало');
    expect(plugin.saveSettings).not.toHaveBeenCalled();
  });

  it.each(['blur', 'Enter'] as const)(
    'commits a trimmed status property absent from the vault only on %s',
    async (commitEvent) => {
      const projects = structuredClone(DEFAULT_SETTINGS.projects);
      projects.statusProperty = 'status';
      const projectProperties: ProjectPropertyCatalog = {
        list: () => [{ name: 'Status', type: 'text' }],
        inspect: () => ({
          kind: 'available',
          property: { name: 'Status', type: 'text' },
          assignment: { kind: 'none' },
        }),
        values: () => [],
        onChange: () => () => {},
      };

      const { tab, plugin } = makeTab({ projects }, { projectProperties });
      const body = openSection(tab, 5);
      if (commitEvent === 'Enter') attachSettingsScroller(tab, 513);
      const input = expectDefined(findInput(body, 'Status property'));

      input.value = '  Workflow state  ';
      input.dispatchEvent(new Event('input', { bubbles: true }));

      expect(plugin.settings.projects.statusProperty).toBe('status');
      expect(plugin.saveSettings).not.toHaveBeenCalled();

      if (commitEvent === 'blur') {
        input.dispatchEvent(new Event('blur'));
      } else {
        input.focus();
        input.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
        );
      }
      await Promise.resolve();
      await Promise.resolve();

      expect(plugin.settings.projects.statusProperty).toBe('Workflow state');
      expect(plugin.saveSettings).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { draft: '   ', label: 'blank' },
    { draft: 'TaGs', label: 'reserved tags' },
    { draft: 'DESCRIPTION', label: 'reserved description' },
    { draft: 'START', label: 'start-property conflict' },
    { draft: 'EnD', label: 'end-property conflict' },
  ])('rejects a $label status property and resets the draft', ({ draft }) => {
    vi.mocked(Notice).mockClear();
    const { tab, plugin } = makeTab();
    const body = openSection(tab, 5);
    const input = expectDefined(findInput(body, 'Status property'));

    input.value = draft;
    input.dispatchEvent(new Event('blur'));

    expect(plugin.settings.projects.statusProperty).toBe('status');
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    expect(findInput(tab.containerEl, 'Status property')?.value).toBe('status');
    expect(Notice).toHaveBeenCalledOnce();
  });

  it('does not save the existing trimmed status property on Enter', async () => {
    const { tab, plugin } = makeTab();
    const body = openSection(tab, 5);
    const scroller = attachSettingsScroller(tab, 513);
    const input = expectDefined(findInput(body, 'Status property'));
    input.value = '  STATUS  ';
    input.focus();

    const enter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(enter);
    await Promise.resolve();
    await Promise.resolve();

    expect(enter.defaultPrevented).toBe(true);
    expect(input.value).toBe('status');
    expect(plugin.settings.projects.statusProperty).toBe('status');
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    expect(scroller.scrollTop).toBe(513);
  });

  it('shows recoverable legacy binding evidence until a source is selected', async () => {
    const projects = structuredClone(DEFAULT_SETTINGS.projects);
    projects.statusProperty = '';
    projects.statusMigration = {
      issue: 'conflicting-properties',
      legacyStatuses: [
        { id: 'a', match: { kind: 'property', property: 'status', value: 'active' } },
      ],
      propertyCandidates: ['status', 'phase'],
    };
    const { tab, plugin, captured } = makeTab({ projects });
    const body = openSection(tab, 5);
    expect(findDropdown(body, 'Status migration needs attention')).not.toBeNull();
    const resolution = expectDefined(
      captured.find(
        (entry) => entry.type === 'dropdown' && entry.name === 'Status migration needs attention',
      ),
    );

    resolution.comp.setValue('phase');
    await Promise.resolve();
    await Promise.resolve();

    expect(plugin.settings.projects.statusProperty).toBe('phase');
    expect(plugin.settings.projects.statusMigration).toBeUndefined();
    expect(plugin.saveSettings).toHaveBeenCalledOnce();
  });
});
