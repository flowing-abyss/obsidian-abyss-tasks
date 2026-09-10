import type * as ObsidianModule from 'obsidian';
import { App, DropdownComponent, Notice, Setting } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectPropertyCatalog } from '../src/projects/ObsidianProjectProperties';
import type { ProjectPropertyInfo } from '../src/projects/projectFields';
import { buildDefaultProjectsSettings } from '../src/settings/defaults';
import {
  addProjectPropertyColumn,
  renderProjectTableSettings,
} from '../src/settings/projectTableSettings';
import { expectDefined } from './helpers';

vi.mock('obsidian', async () => {
  const actual = await vi.importActual<typeof ObsidianModule>('obsidian');
  return { ...actual, Notice: vi.fn() };
});

function catalog(
  properties: readonly ProjectPropertyInfo[] = [
    { name: 'Budget', type: 'number' },
    { name: 'Owners', type: 'list' },
  ],
): ProjectPropertyCatalog {
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

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function dragColumn(source: HTMLElement, target: HTMLElement): void {
  const payloads = new Map<string, string>();
  const dataTransfer = {
    setData: (type: string, value: string) => {
      payloads.set(type, value);
    },
    getData: (type: string) => payloads.get(type) ?? '',
    get types() {
      return [...payloads.keys()];
    },
  };
  for (const type of ['dragstart', 'dragover', 'drop']) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
    (type === 'dragstart'
      ? expectDefined(source.querySelector<HTMLElement>('.abyss-settings-card-header'))
      : target
    ).dispatchEvent(event);
  }
}

function expandProperty(container: HTMLElement, columnId: string): void {
  expectDefined(
    container.querySelector<HTMLButtonElement>(
      `[data-card-id="project-property:${columnId}"] .abyss-project-property-toggle`,
    ),
  ).click();
}

describe('renderProjectTableSettings', () => {
  it('persists alignment in view state and reset removes the saved key', async () => {
    const projects = buildDefaultProjectsSettings();
    const saveViewState = vi.fn().mockResolvedValue(undefined);
    const container = document.body.createDiv();
    renderProjectTableSettings({
      app: new App(),
      container,
      projects,
      catalog: catalog(),
      saveStatic: vi.fn().mockResolvedValue(undefined),
      saveViewState,
      renderStatusSettings: () => {},
      refresh: vi.fn(),
    });
    const statusCard = expectDefined(
      container.querySelector<HTMLElement>('[data-card-id="project-property:status"]'),
    );
    expectDefined(
      statusCard.querySelector<HTMLButtonElement>('.abyss-project-property-toggle'),
    ).click();
    const alignment = expectDefined(
      statusCard.querySelector<HTMLSelectElement>('[aria-label="Alignment for Status"]'),
    );

    alignment.value = 'center';
    alignment.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(projects.table.columns.find(({ id }) => id === 'status')?.alignment).toBe('center');

    alignment.value = 'left';
    alignment.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(projects.table.columns.find(({ id }) => id === 'status')).not.toHaveProperty(
      'alignment',
    );
    expect(saveViewState).toHaveBeenCalledTimes(2);
  });

  it('embeds status controls once inside the expanded Status property', () => {
    const projects = buildDefaultProjectsSettings();
    const renderStatusSettings = vi.fn((host: HTMLElement) => {
      host.createDiv({ cls: 'status-settings-sentinel', text: 'Status options' });
    });
    const container = document.body.createDiv();
    renderProjectTableSettings({
      app: new App(),
      container,
      projects,
      catalog: catalog(),
      saveStatic: vi.fn().mockResolvedValue(undefined),
      saveViewState: vi.fn().mockResolvedValue(undefined),
      renderStatusSettings,
      refresh: vi.fn(),
    });

    expect(renderStatusSettings).not.toHaveBeenCalled();
    expectDefined(
      container.querySelector<HTMLButtonElement>(
        '[data-card-id="project-property:status"] .abyss-project-property-toggle',
      ),
    ).click();

    expect(renderStatusSettings).toHaveBeenCalledOnce();
    expect(container.querySelectorAll('.status-settings-sentinel')).toHaveLength(1);
    expect(container.textContent).not.toContain('Statuses');
  });

  it('persists an explicit type for an unresolved custom property through static settings', async () => {
    const projects = buildDefaultProjectsSettings();
    projects.table.columns.push({ id: 'property:Effort', visible: true });
    const saveStatic = vi.fn().mockResolvedValue(undefined);
    const container = document.body.createDiv();
    renderProjectTableSettings({
      app: new App(),
      container,
      projects,
      catalog: catalog([{ name: 'Effort', type: null }]),
      saveStatic,
      saveViewState: vi.fn().mockResolvedValue(undefined),
      renderStatusSettings: () => {},
      refresh: vi.fn(),
    });
    const card = expectDefined(
      container.querySelector<HTMLElement>('[data-card-id="project-property:property:Effort"]'),
    );
    expectDefined(card.querySelector<HTMLButtonElement>('.abyss-project-property-toggle')).click();
    const type = expectDefined(
      card.querySelector<HTMLSelectElement>('[aria-label="Type for Effort"]'),
    );

    type.value = 'number';
    type.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();

    expect(projects.propertyDefinitions['property:Effort']).toEqual({ type: 'number' });
    expect(saveStatic).toHaveBeenCalledOnce();
  });

  it('retains sequential predefined-value edits and keeps values when disabled', async () => {
    const projects = buildDefaultProjectsSettings();
    projects.table.columns.push({ id: 'property:Priority', visible: true });
    projects.propertyDefinitions['property:Priority'] = {
      type: 'text',
      presetsEnabled: true,
      presets: [{ value: 'low' }],
    };
    const saveStatic = vi.fn().mockResolvedValue(undefined);
    const container = document.body.createDiv();
    renderProjectTableSettings({
      app: new App(),
      container,
      projects,
      catalog: catalog([{ name: 'Priority', type: 'text' }]),
      saveStatic,
      saveViewState: vi.fn().mockResolvedValue(undefined),
      refresh: vi.fn(),
    });
    expandProperty(container, 'property:Priority');
    const card = expectDefined(
      container.querySelector<HTMLElement>('[data-column-id="property:Priority"]'),
    );
    const value = expectDefined(
      card.querySelector<HTMLInputElement>('.abyss-project-preset-value'),
    );
    const displayName = expectDefined(
      card.querySelector<HTMLInputElement>('.abyss-project-preset-display-name'),
    );
    const color = expectDefined(
      card.querySelector<HTMLInputElement>('.abyss-project-preset-color'),
    );
    const appearance = expectDefined(
      card.querySelector<HTMLSelectElement>('.abyss-project-preset-appearance'),
    );

    value.value = 'high';
    value.dispatchEvent(new Event('change', { bubbles: true }));
    displayName.value = 'High';
    displayName.dispatchEvent(new Event('change', { bubbles: true }));
    color.value = '#112233';
    color.dispatchEvent(new Event('change', { bubbles: true }));
    appearance.value = 'text';
    appearance.dispatchEvent(new Event('change', { bubbles: true }));
    value.value = 'urgent';
    value.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();

    expect(projects.propertyDefinitions['property:Priority']).toEqual({
      type: 'text',
      presetsEnabled: true,
      presets: [{ value: 'urgent', displayName: 'High', color: '#112233', display: 'text' }],
    });
    const toggle = expectDefined(
      card.querySelector<HTMLInputElement>('[aria-label="Use predefined values for Priority"]'),
    );
    toggle.click();
    await settle();
    expect(projects.propertyDefinitions['property:Priority']).toMatchObject({
      presetsEnabled: false,
      presets: [{ value: 'urgent', displayName: 'High', color: '#112233', display: 'text' }],
    });
    expect(saveStatic).toHaveBeenCalledTimes(6);
  });

  it('persists a newly added predefined value before it is edited', async () => {
    const projects = buildDefaultProjectsSettings();
    projects.table.columns.push({ id: 'property:Budget', visible: true });
    projects.propertyDefinitions['property:Budget'] = {
      type: 'number',
      presetsEnabled: true,
      presets: [],
    };
    const saveStatic = vi.fn().mockResolvedValue(undefined);
    const container = document.body.createDiv();
    renderProjectTableSettings({
      app: new App(),
      container,
      projects,
      catalog: catalog(),
      saveStatic,
      saveViewState: vi.fn().mockResolvedValue(undefined),
      refresh: vi.fn(),
    });
    expandProperty(container, 'property:Budget');

    expectDefined(container.querySelector<HTMLButtonElement>('.abyss-project-preset-add')).click();
    await settle();

    expect(expectDefined(projects.propertyDefinitions['property:Budget']).presets).toEqual([
      { value: 0 },
    ]);
    expect(saveStatic).toHaveBeenCalledOnce();
  });

  it('saves a missing definition before view state and retains it after column removal', async () => {
    const projects = buildDefaultProjectsSettings();
    const order: string[] = [];
    const saveStatic = vi.fn(async () => {
      order.push('static');
    });
    const saveViewState = vi.fn(async () => {
      order.push('view');
    });
    const container = document.body.createDiv();
    renderProjectTableSettings({
      app: new App(),
      container,
      projects,
      catalog: catalog([{ name: 'Budget', type: 'number' }]),
      saveStatic,
      saveViewState,
      renderStatusSettings: () => {},
      refresh: vi.fn(),
    });
    const input = expectDefined(
      container.querySelector<HTMLInputElement>('.abyss-project-column-add-input'),
    );
    input.value = 'Budget';
    expectDefined(container.querySelector<HTMLButtonElement>('.abyss-project-column-add')).click();
    await settle();

    expect(order).toEqual(['static', 'view']);
    expect(projects.propertyDefinitions['property:Budget']).toEqual({ type: 'number' });
    const added = projects.table.columns.find(({ id }) => id === 'property:Budget');
    expect(added).toBeDefined();

    const renderedAgain = document.body.createDiv();
    renderProjectTableSettings({
      app: new App(),
      container: renderedAgain,
      projects,
      catalog: catalog([{ name: 'Budget', type: 'number' }]),
      saveStatic,
      saveViewState,
      renderStatusSettings: () => {},
      refresh: vi.fn(),
    });
    expectDefined(
      renderedAgain.querySelector<HTMLButtonElement>(
        '[data-column-id="property:Budget"] [aria-label="Remove Budget column"]',
      ),
    ).click();
    await settle();

    expect(projects.table.columns.some(({ id }) => id === 'property:Budget')).toBe(false);
    expect(projects.propertyDefinitions['property:Budget']).toEqual({ type: 'number' });
  });

  it('does not save view state when the definition save for a new column fails', async () => {
    const projects = buildDefaultProjectsSettings();
    const saveStatic = vi.fn().mockRejectedValue(new Error('static unavailable'));
    const saveViewState = vi.fn().mockResolvedValue(undefined);
    const container = document.body.createDiv();
    renderProjectTableSettings({
      app: new App(),
      container,
      projects,
      catalog: catalog([{ name: 'Budget', type: 'number' }]),
      saveStatic,
      saveViewState,
      renderStatusSettings: () => {},
      refresh: vi.fn(),
    });
    const input = expectDefined(
      container.querySelector<HTMLInputElement>('.abyss-project-column-add-input'),
    );
    input.value = 'Budget';
    expectDefined(container.querySelector<HTMLButtonElement>('.abyss-project-column-add')).click();
    await settle();

    expect(saveStatic).toHaveBeenCalledOnce();
    expect(saveViewState).not.toHaveBeenCalled();
    expect(projects.propertyDefinitions['property:Budget']).toEqual({ type: 'number' });
    expect(projects.table.columns.some(({ id }) => id === 'property:Budget')).toBe(true);
  });

  it('persists Show description through the view-state channel outside column rows', async () => {
    const projects = buildDefaultProjectsSettings();
    const saveViewState = vi.fn().mockResolvedValue(undefined);
    const container = document.body.createDiv();
    renderProjectTableSettings({
      app: new App(),
      container,
      projects,
      catalog: catalog([{ name: 'description', type: 'text' }]),
      saveStatic: vi.fn().mockResolvedValue(undefined),
      saveViewState,
      refresh: vi.fn(),
    });
    const toggle = expectDefined(
      container.querySelector<HTMLInputElement>('.abyss-project-show-description'),
    );

    expect(toggle.checked).toBe(true);
    expect(container.querySelector('[data-column-id="description"]')).toBeNull();
    toggle.click();
    await settle();

    expect(projects.table.showDescription).toBe(false);
    expect(saveViewState).toHaveBeenCalledOnce();
  });

  it('selects native Start and End spelling for case-insensitive saved sources', () => {
    const projects = buildDefaultProjectsSettings();
    projects.startProperty = 'start';
    projects.endProperty = 'end';
    const container = document.body.createDiv();

    renderProjectTableSettings({
      app: new App(),
      container,
      projects,
      catalog: catalog([
        { name: 'Start', type: 'date' },
        { name: 'End', type: 'date' },
      ]),
      saveStatic: vi.fn().mockResolvedValue(undefined),
      saveViewState: vi.fn().mockResolvedValue(undefined),
      refresh: vi.fn(),
    });
    expandProperty(container, 'start');
    expandProperty(container, 'end');

    expect(
      Array.from(
        container.querySelectorAll<HTMLSelectElement>('select:not([aria-label^="Alignment"])'),
      ).map((select) => select.value),
    ).toEqual(['Start', 'End']);
  });

  it('omits a sibling curated property from each date-source picker', () => {
    const projects = buildDefaultProjectsSettings();
    projects.startProperty = 'start';
    projects.endProperty = 'end';
    const save = vi.fn().mockResolvedValue(undefined);
    const container = document.body.createDiv();
    const dropdowns: DropdownComponent[] = [];
    const dropdownSpy = vi.spyOn(Setting.prototype, 'addDropdown').mockImplementation(function (
      this: Setting,
      callback,
    ) {
      const dropdown = new DropdownComponent(this.controlEl);
      this.components.push(dropdown);
      dropdowns.push(dropdown);
      callback(dropdown);
      return this;
    });

    try {
      renderProjectTableSettings({
        app: new App(),
        container,
        projects,
        catalog: catalog([
          { name: 'Start', type: 'date' },
          { name: 'End', type: 'date' },
        ]),
        saveStatic: save,
        saveViewState: save,
        refresh: vi.fn(),
      });
      expandProperty(container, 'start');
      expandProperty(container, 'end');

      expect(expectDefined(dropdowns[0]).getValue()).toBe('Start');
      expect(
        Array.from(expectDefined(dropdowns[0]).selectEl.options).map(({ value }) => value),
      ).not.toContain('End');
      expect(projects.startProperty).toBe('start');
      expect(projects.endProperty).toBe('end');
      expect(save).not.toHaveBeenCalled();
    } finally {
      dropdownSpy.mockRestore();
    }
  });

  it('does not offer description as a new curated date source', () => {
    const projects = buildDefaultProjectsSettings();
    const container = document.body.createDiv();
    const dropdowns: DropdownComponent[] = [];
    const dropdownSpy = vi.spyOn(Setting.prototype, 'addDropdown').mockImplementation(function (
      this: Setting,
      callback,
    ) {
      const dropdown = new DropdownComponent(this.controlEl);
      this.components.push(dropdown);
      dropdowns.push(dropdown);
      callback(dropdown);
      return this;
    });
    try {
      renderProjectTableSettings({
        app: new App(),
        container,
        projects,
        catalog: catalog([
          { name: 'start', type: 'date' },
          { name: 'end', type: 'date' },
          { name: 'description', type: 'date' },
        ]),
        saveStatic: vi.fn().mockResolvedValue(undefined),
        saveViewState: vi.fn().mockResolvedValue(undefined),
        refresh: vi.fn(),
      });
      expandProperty(container, 'start');

      expect(
        Array.from(expectDefined(dropdowns[0]).selectEl.options).map(({ value }) => value),
      ).not.toContain('description');
      expect(projects.startProperty).toBe('start');
    } finally {
      dropdownSpy.mockRestore();
    }
  });

  it('keeps Name first and visible while persisting hide and drag reorder changes', async () => {
    const projects = buildDefaultProjectsSettings();
    const saveStatic = vi.fn().mockResolvedValue(undefined);
    const saveViewState = vi.fn().mockResolvedValue(undefined);
    const container = document.body.createDiv();
    renderProjectTableSettings({
      app: new App(),
      container,
      projects,
      catalog: catalog(),
      saveStatic,
      saveViewState,
      refresh: vi.fn(),
    });

    const nameRow = expectDefined(container.querySelector<HTMLElement>('[data-column-id="name"]'));
    const nameToggle = expectDefined(
      nameRow.querySelector<HTMLInputElement>('input[type="checkbox"]'),
    );
    expect(nameToggle.checked).toBe(true);
    expect(nameToggle.disabled).toBe(true);

    const statusRow = expectDefined(
      container.querySelector<HTMLElement>('[data-column-id="status"]'),
    );
    const statusToggle = expectDefined(
      statusRow.querySelector<HTMLInputElement>('input[type="checkbox"]'),
    );
    statusToggle.click();
    const startRow = expectDefined(
      container.querySelector<HTMLElement>('[data-column-id="start"]'),
    );
    dragColumn(statusRow, startRow);
    await settle();

    expect(projects.table.columns.find(({ id }) => id === 'status')?.visible).toBe(false);
    expect(projects.table.columns.map(({ id }) => id).slice(0, 3)).toEqual([
      'name',
      'progress',
      'start',
    ]);
    expect(saveStatic).not.toHaveBeenCalled();
    expect(saveViewState).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[aria-label^="Move "]')).toBeNull();
    expect(statusRow.getAttribute('draggable')).toBe('true');
  });

  it('accepts protected-mode dragover by MIME type and keeps hover within the owning card', () => {
    const projects = buildDefaultProjectsSettings();
    const container = document.body.createDiv();
    renderProjectTableSettings({
      app: new App(),
      container,
      projects,
      catalog: catalog(),
      saveStatic: vi.fn().mockResolvedValue(undefined),
      saveViewState: vi.fn().mockResolvedValue(undefined),
      refresh: vi.fn(),
    });
    const source = expectDefined(container.querySelector<HTMLElement>('[data-column-id="status"]'));
    const target = expectDefined(container.querySelector<HTMLElement>('[data-column-id="start"]'));
    const header = expectDefined(source.querySelector<HTMLElement>('.abyss-settings-card-header'));
    const targetHeader = expectDefined(
      target.querySelector<HTMLElement>('.abyss-settings-card-header'),
    );
    const targetChild = expectDefined(targetHeader.firstElementChild);
    const payloads = new Map<string, string>();
    let protectedMode = false;
    let effectAllowed = 'none';
    let dropEffect = 'none';
    const dataTransfer = {
      setData: (type: string, value: string) => payloads.set(type, value),
      getData: (type: string) => (protectedMode ? '' : (payloads.get(type) ?? '')),
      get types() {
        return [...payloads.keys()];
      },
      get effectAllowed() {
        return effectAllowed;
      },
      set effectAllowed(value: string) {
        effectAllowed = value;
      },
      get dropEffect() {
        return dropEffect;
      },
      set dropEffect(value: string) {
        dropEffect = value;
      },
    };
    const dispatch = (element: Element, type: string, relatedTarget?: EventTarget): Event => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
      if (relatedTarget !== undefined)
        Object.defineProperty(event, 'relatedTarget', { value: relatedTarget });
      element.dispatchEvent(event);
      return event;
    };

    const label = expectDefined(
      source.querySelector<HTMLInputElement>('.abyss-project-column-label'),
    );
    const inputDrag = dispatch(label, 'dragstart');
    expect(inputDrag.defaultPrevented).toBe(true);
    expect(payloads).toEqual(new Map());

    dispatch(header, 'dragstart');
    expect(effectAllowed).toBe('move');
    protectedMode = true;
    const dragover = dispatch(targetChild, 'dragover');
    expect(dragover.defaultPrevented).toBe(true);
    expect(dropEffect).toBe('move');
    expect(target.hasClass('abyss-drag-over')).toBe(true);

    dispatch(targetChild, 'dragleave', targetHeader);
    expect(target.hasClass('abyss-drag-over')).toBe(true);

    dispatch(targetChild, 'dragleave', container);
    expect(target.hasClass('abyss-drag-over')).toBe(false);
    dispatch(header, 'dragend');
    expect(source.hasClass('abyss-dragging')).toBe(false);
  });

  it('keeps rendered and persisted column order equal for downward, upward, and adjacent drops', async () => {
    const projects = buildDefaultProjectsSettings();
    const container = document.body.createDiv();
    renderProjectTableSettings({
      app: new App(),
      container,
      projects,
      catalog: catalog(),
      saveStatic: vi.fn().mockResolvedValue(undefined),
      saveViewState: vi.fn().mockResolvedValue(undefined),
      refresh: vi.fn(),
    });
    const card = (id: string): HTMLElement =>
      expectDefined(container.querySelector<HTMLElement>(`[data-column-id="${id}"]`));
    const renderedOrder = (): string[] =>
      Array.from(container.querySelectorAll<HTMLElement>('[data-column-id]'), (row) =>
        expectDefined(row.dataset['columnId']),
      );
    const expectMatchingOrder = (): void => {
      expect(renderedOrder()).toEqual(projects.table.columns.map(({ id }) => id));
    };

    dragColumn(card('status'), card('end'));
    await settle();
    expectMatchingOrder();

    dragColumn(card('status'), card('progress'));
    await settle();
    expectMatchingOrder();

    dragColumn(card('status'), card('progress'));
    await settle();
    expectMatchingOrder();
  });

  it('persists curated date sources through the static settings channel', async () => {
    const projects = buildDefaultProjectsSettings();
    const saveStatic = vi.fn().mockResolvedValue(undefined);
    const saveViewState = vi.fn().mockResolvedValue(undefined);
    const container = document.body.createDiv();
    const dropdowns: DropdownComponent[] = [];
    const dropdownSpy = vi.spyOn(Setting.prototype, 'addDropdown').mockImplementation(function (
      this: Setting,
      callback,
    ) {
      const dropdown = new DropdownComponent(this.controlEl);
      this.components.push(dropdown);
      dropdowns.push(dropdown);
      callback(dropdown);
      return this;
    });
    try {
      renderProjectTableSettings({
        app: new App(),
        container,
        projects,
        catalog: catalog([
          { name: 'Start', type: 'date' },
          { name: 'Kickoff', type: 'date' },
          { name: 'End', type: 'date' },
        ]),
        saveStatic,
        saveViewState,
        refresh: vi.fn(),
      });
      expandProperty(container, 'start');

      expectDefined(dropdowns[0]).setValue('Kickoff');
      await settle();

      expect(projects.startProperty).toBe('Kickoff');
      expect(saveStatic).toHaveBeenCalledOnce();
      expect(saveViewState).not.toHaveBeenCalled();
    } finally {
      dropdownSpy.mockRestore();
    }
  });

  it('shows exactly one Notice when a curated date source static save fails', async () => {
    const projects = buildDefaultProjectsSettings();
    const saveStatic = vi.fn().mockRejectedValue(new Error('disk full'));
    const saveViewState = vi.fn().mockResolvedValue(undefined);
    const container = document.body.createDiv();
    const dropdowns: DropdownComponent[] = [];
    const dropdownSpy = vi.spyOn(Setting.prototype, 'addDropdown').mockImplementation(function (
      this: Setting,
      callback,
    ) {
      const dropdown = new DropdownComponent(this.controlEl);
      this.components.push(dropdown);
      dropdowns.push(dropdown);
      callback(dropdown);
      return this;
    });
    vi.mocked(Notice).mockClear();
    try {
      renderProjectTableSettings({
        app: new App(),
        container,
        projects,
        catalog: catalog([
          { name: 'Start', type: 'date' },
          { name: 'Kickoff', type: 'date' },
          { name: 'End', type: 'date' },
        ]),
        saveStatic,
        saveViewState,
        refresh: vi.fn(),
      });
      expandProperty(container, 'start');

      expectDefined(dropdowns[0]).setValue('Kickoff');
      await settle();

      expect(saveStatic).toHaveBeenCalledOnce();
      expect(saveViewState).not.toHaveBeenCalled();
      expect(Notice).toHaveBeenCalledOnce();
      expect((vi.mocked(Notice).mock.calls[0]?.[0] as DocumentFragment).textContent).toContain(
        'Could not save project table settings: disk full. Changes are kept in this session.',
      );
    } finally {
      dropdownSpy.mockRestore();
    }
  });

  it('offers a retry for a failed view-state save', async () => {
    const projects = buildDefaultProjectsSettings();
    const saveViewState = vi.fn().mockRejectedValue(new Error('state unavailable'));
    const container = document.body.createDiv();
    vi.mocked(Notice).mockClear();
    renderProjectTableSettings({
      app: new App(),
      container,
      projects,
      catalog: catalog(),
      saveStatic: vi.fn().mockResolvedValue(undefined),
      saveViewState,
      refresh: vi.fn(),
    });

    expectDefined(
      container.querySelector<HTMLInputElement>('[data-column-id="status"] input[type="checkbox"]'),
    ).click();
    await settle();

    expect(saveViewState).toHaveBeenCalledOnce();
    expect(Notice).toHaveBeenCalledOnce();
    expect(
      (vi.mocked(Notice).mock.calls[0]?.[0] as DocumentFragment).querySelector('button'),
    ).not.toBeNull();
  });

  it('keeps a failed column addition once and retries the current draft', async () => {
    const projects = buildDefaultProjectsSettings();
    const saveViewState = vi
      .fn()
      .mockRejectedValueOnce(new Error('state unavailable'))
      .mockResolvedValue(undefined);
    const container = document.body.createDiv();
    renderProjectTableSettings({
      app: new App(),
      container,
      projects,
      catalog: catalog(),
      saveStatic: vi.fn().mockResolvedValue(undefined),
      saveViewState,
      refresh: vi.fn(),
    });
    const input = expectDefined(
      container.querySelector<HTMLInputElement>('.abyss-project-column-add-input'),
    );
    input.value = 'Budget';

    expectDefined(container.querySelector<HTMLButtonElement>('.abyss-project-column-add')).click();
    await settle();

    expect(projects.table.columns.filter(({ id }) => id === 'property:Budget')).toHaveLength(1);
    const noticeContent = vi.mocked(Notice).mock.calls[0]?.[0] as DocumentFragment;
    expectDefined(noticeContent.querySelector('button')).click();
    await settle();
    expect(saveViewState).toHaveBeenCalledTimes(2);
    expect(projects.table.columns.filter(({ id }) => id === 'property:Budget')).toHaveLength(1);
  });

  it('changes a display label without changing the custom property source key', async () => {
    const projects = buildDefaultProjectsSettings();
    projects.table.columns.push({ id: 'property:Budget', visible: true });
    const save = vi.fn().mockResolvedValue(undefined);
    const container = document.body.createDiv();
    renderProjectTableSettings({
      app: new App(),
      container,
      projects,
      catalog: catalog(),
      saveStatic: save,
      saveViewState: save,
      refresh: vi.fn(),
    });
    const row = expectDefined(
      container.querySelector<HTMLElement>('[data-column-id="property:Budget"]'),
    );
    expect(row.textContent).toContain('Budget');
    const label = expectDefined(row.querySelector<HTMLInputElement>('.abyss-project-column-label'));
    label.value = 'Cost';
    label.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();

    expect(expectDefined(projects.table.columns[projects.table.columns.length - 1])).toEqual({
      id: 'property:Budget',
      label: 'Cost',
      visible: true,
    });
    expect(save).toHaveBeenCalledOnce();
  });

  it('separates source hints from display defaults and marks all curated rows as required', () => {
    const projects = buildDefaultProjectsSettings();
    projects.table.columns.push({ id: 'property:Budget', visible: true });
    const container = document.body.createDiv();
    renderProjectTableSettings({
      app: new App(),
      container,
      projects,
      catalog: catalog(),
      saveStatic: vi.fn().mockResolvedValue(undefined),
      saveViewState: vi.fn().mockResolvedValue(undefined),
      refresh: vi.fn(),
    });

    expect(
      Array.from(container.querySelectorAll('.abyss-project-column-settings-header > *')).map(
        (element) => element.textContent,
      ),
    ).toEqual(['', 'Source', 'Display name', 'Show', 'Width', '', '']);
    const rows = Array.from(
      container.querySelectorAll<HTMLElement>('.abyss-project-column-setting'),
    );
    expect(
      rows.every(
        (row) =>
          expectDefined(row.querySelector('.abyss-settings-card-header')).children.length === 7,
      ),
    ).toBe(true);
    expect(
      rows.every((row) =>
        Array.from(row.querySelectorAll<HTMLButtonElement>('button')).every((button) =>
          button.hasClass('clickable-icon'),
        ),
      ),
    ).toBe(true);
    expect(container.querySelector('[data-column-id="name"]')?.textContent).toContain('Filename');
    expect(
      container.querySelector('[data-column-id="name"] .abyss-project-column-source-badge'),
    ).toBeNull();
    expect(container.querySelector('[data-column-id="progress"]')?.textContent).toContain('Tasks');
    const curated = ['name', 'status', 'progress', 'start', 'end'];
    expect(
      curated.map(
        (id) =>
          expectDefined(
            container.querySelector<HTMLInputElement>(
              `[data-column-id="${id}"] .abyss-project-column-label`,
            ),
          ).placeholder,
      ),
    ).toEqual(['Name', 'Status', 'Progress', 'Start', 'End']);
    expect(container.querySelectorAll('.abyss-project-column-required')).toHaveLength(5);
    expect(
      container.querySelector('[data-column-id="progress"] .abyss-project-column-auto')
        ?.textContent,
    ).toBe('Auto');
    expect(container.querySelectorAll('.abyss-settings-card-grip')).toHaveLength(
      projects.table.columns.length,
    );
    expect(container.querySelector('[data-column-id="property:Budget"] .mod-warning')).toBeNull();
  });

  it('adds a suggested property once and removes only its column preference', async () => {
    const projects = buildDefaultProjectsSettings();
    const save = vi.fn().mockResolvedValue(undefined);
    const refresh = vi.fn();
    const container = document.body.createDiv();
    renderProjectTableSettings({
      app: new App(),
      container,
      projects,
      catalog: catalog(),
      saveStatic: save,
      saveViewState: save,
      refresh,
    });
    const input = expectDefined(
      container.querySelector<HTMLInputElement>('.abyss-project-column-add-input'),
    );
    const add = expectDefined(
      container.querySelector<HTMLButtonElement>('.abyss-project-column-add'),
    );
    input.value = 'budget';
    add.click();
    add.click();
    await settle();

    expect(projects.table.columns.filter(({ id }) => id === 'property:Budget')).toHaveLength(1);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('rejects curated metadata sources while leaving ordinary Tags available', () => {
    const projects = buildDefaultProjectsSettings();
    const properties: readonly ProjectPropertyInfo[] = [
      { name: 'Start', type: 'date' },
      { name: 'END', type: 'date' },
      { name: 'STATUS', type: 'text' },
      { name: 'Tags', type: 'tags' },
      { name: 'Budget', type: 'number' },
    ];

    expect(
      properties
        .slice(0, 3)
        .map(({ name }) => addProjectPropertyColumn(projects, properties, name)),
    ).toEqual(['reserved', 'reserved', 'reserved']);
    expect(addProjectPropertyColumn(projects, properties, 'Tags')).toBe('added');
    expect(addProjectPropertyColumn(projects, properties, 'Budget')).toBe('added');
    expect(projects.table.columns.filter(({ id }) => id.startsWith('property:'))).toEqual([
      { id: 'property:Tags', visible: true },
      { id: 'property:Budget', visible: true },
    ]);
  });

  it('shows an explicit message when a typed reserved property is entered manually', () => {
    const projects = buildDefaultProjectsSettings();
    const container = document.body.createDiv();
    renderProjectTableSettings({
      app: new App(),
      container,
      projects,
      catalog: catalog([
        { name: 'Start', type: 'date' },
        { name: 'Budget', type: 'number' },
      ]),
      saveStatic: vi.fn().mockResolvedValue(undefined),
      saveViewState: vi.fn().mockResolvedValue(undefined),
      refresh: vi.fn(),
    });
    const input = expectDefined(
      container.querySelector<HTMLInputElement>('.abyss-project-column-add-input'),
    );
    input.value = 'start';
    expectDefined(container.querySelector<HTMLButtonElement>('.abyss-project-column-add')).click();

    expect(container.querySelector('.abyss-project-table-settings-error')?.textContent).toContain(
      'reserved',
    );
    expect(projects.table.columns.some(({ id }) => id === 'property:Start')).toBe(false);
  });
});
