import { App } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectPropertyCatalog } from '../src/projects/ObsidianProjectProperties';
import type { ProjectPropertyInfo } from '../src/projects/projectFields';
import { buildDefaultProjectsSettings } from '../src/settings/defaults';
import {
  addProjectPropertyColumn,
  renderProjectTableSettings,
} from '../src/settings/projectTableSettings';
import { expectDefined } from './helpers';

function catalog(
  properties: readonly ProjectPropertyInfo[] = [
    { name: 'Budget', type: 'number' },
    { name: 'Owners', type: 'list' },
  ],
): ProjectPropertyCatalog {
  return {
    list: () => properties,
    values: () => [],
    onChange: () => () => {},
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function dragColumn(source: HTMLElement, target: HTMLElement): void {
  let payload = '';
  const dataTransfer = {
    setData: (_type: string, value: string) => {
      payload = value;
    },
    getData: () => payload,
  };
  for (const type of ['dragstart', 'dragover', 'drop']) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
    (type === 'dragstart' ? source : target).dispatchEvent(event);
  }
}

describe('renderProjectTableSettings', () => {
  it('keeps Name first and visible while persisting hide and drag reorder changes', async () => {
    const projects = buildDefaultProjectsSettings();
    const save = vi.fn().mockResolvedValue(undefined);
    const container = document.body.createDiv();
    renderProjectTableSettings({
      app: new App(),
      container,
      projects,
      catalog: catalog(),
      save,
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
      'status',
    ]);
    expect(save).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[aria-label^="Move "]')).toBeNull();
    expect(statusRow.getAttribute('draggable')).toBe('true');
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
      save,
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
      save: vi.fn().mockResolvedValue(undefined),
      refresh: vi.fn(),
    });

    expect(
      Array.from(container.querySelectorAll('.abyss-project-column-settings-header > *')).map(
        (element) => element.textContent,
      ),
    ).toEqual(['', 'Source', 'Display name', 'Show', 'Width', '']);
    const rows = Array.from(
      container.querySelectorAll<HTMLElement>('.abyss-project-column-setting'),
    );
    expect(new Set(rows.map((row) => row.children.length))).toEqual(new Set([6]));
    expect(
      rows.every((row) =>
        Array.from(row.querySelectorAll<HTMLButtonElement>('button')).every((button) =>
          button.hasClass('clickable-icon'),
        ),
      ),
    ).toBe(true);
    expect(container.querySelector('[data-column-id="name"]')?.textContent).toContain('Filename');
    expect(
      container.querySelector('[data-column-id="name"] .abyss-project-column-source-badge')
        ?.textContent,
    ).toBe('Derived');
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
      save,
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
      save: vi.fn().mockResolvedValue(undefined),
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
