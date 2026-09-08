import { App } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectPropertyCatalog } from '../src/projects/ObsidianProjectProperties';
import { buildDefaultProjectsSettings } from '../src/settings/defaults';
import { renderProjectTableSettings } from '../src/settings/projectTableSettings';
import { expectDefined } from './helpers';

function catalog(): ProjectPropertyCatalog {
  return {
    list: () => [
      { name: 'Budget', type: 'number' },
      { name: 'Owners', type: 'list' },
    ],
    values: () => [],
    onChange: () => () => {},
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('renderProjectTableSettings', () => {
  it('keeps Name first and visible while persisting hide and reorder changes', async () => {
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
    expectDefined(
      statusRow.querySelector<HTMLButtonElement>('[aria-label="Move Status down"]'),
    ).click();
    await settle();

    expect(projects.table.columns.find(({ id }) => id === 'status')?.visible).toBe(false);
    expect(projects.table.columns.map(({ id }) => id).slice(0, 3)).toEqual([
      'name',
      'progress',
      'status',
    ]);
    expect(save).toHaveBeenCalledTimes(2);
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
});
