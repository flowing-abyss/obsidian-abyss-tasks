import { App, TFile } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { mountProjectCellEditor } from '../src/panels/projects/ProjectCellEditor';
import type { ProjectPropertyCatalog } from '../src/projects/ObsidianProjectProperties';
import { ProjectEditValidationError } from '../src/projects/projectEditError';
import type { ProjectPropertyType } from '../src/projects/projectFields';
import { expectDefined, freshContainer } from './helpers';

function catalog(
  values: readonly string[] = [],
  type: ProjectPropertyType | null = 'list',
): ProjectPropertyCatalog {
  return {
    list: () => [{ name: 'Custom', type }],
    inspect: (property) => ({
      kind: 'available',
      property: { name: property, type },
      assignment: { kind: 'none' },
    }),
    values: () => values,
    onChange: () => () => {},
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function inputEvent(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function keydown(input: HTMLInputElement, key: string, isComposing = false): void {
  input.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, isComposing }),
  );
}

function pickerInput(container: HTMLElement): HTMLInputElement {
  return expectDefined(container.querySelector<HTMLInputElement>('[role="combobox"]'));
}

function option(container: HTMLElement, raw: string): HTMLElement {
  return expectDefined(
    Array.from(container.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (candidate) => candidate.dataset['value'] === raw,
    ),
  );
}

describe('project cell value picker', () => {
  it('filters choices without assigning the query and toggles a keyboard choice without closing', async () => {
    const container = document.body.createDiv();
    const save = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    const handle = mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:Team', property: 'Team', label: 'Team', type: 'list' },
      value: ['Alpha'],
      catalog: catalog(['Alpha', 'Beta']),
      save,
      onClose,
    });
    handle.focus();
    const input = pickerInput(container);

    expect(container.querySelector('[role="listbox"]')).not.toBeNull();
    expect(option(container, 'Alpha').getAttribute('aria-selected')).toBe('true');
    inputEvent(input, 'Beta');
    expect(save).not.toHaveBeenCalled();
    keydown(input, 'ArrowDown');
    expect(input.getAttribute('aria-activedescendant')).toBe(option(container, 'Beta').id);
    keydown(input, 'Enter');
    await settle();

    expect(save).toHaveBeenCalledWith(['Alpha', 'Beta']);
    expect(onClose).not.toHaveBeenCalled();
    expect(activeDocument.activeElement).toBe(input);
    expect(input.value).toBe('Beta');
  });

  it('adds a Unicode literal only through the explicit action and never on blur or Tab', async () => {
    const container = document.body.createDiv();
    const save = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:Team', property: 'Team', label: 'Team', type: 'list' },
      value: ['Alpha'],
      catalog: catalog(['Alpha']),
      save,
      onClose,
    });
    const input = pickerInput(container);
    inputEvent(input, '新規 🚀');
    input.dispatchEvent(
      new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }),
    );
    await settle();

    expect(save).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith('committed', {
      navigation: 'preserve-focus',
      focusTarget: document.body,
    });

    const secondContainer = freshContainer();
    const secondSave = vi.fn().mockResolvedValue(undefined);
    mountProjectCellEditor({
      app: new App(),
      container: secondContainer,
      field: { id: 'property:Team', property: 'Team', label: 'Team', type: 'list' },
      value: ['Alpha'],
      catalog: catalog(['Alpha']),
      save: secondSave,
      onClose: vi.fn(),
    });
    const secondInput = pickerInput(secondContainer);
    inputEvent(secondInput, '新規 🚀');
    expectDefined(
      secondContainer.querySelector<HTMLButtonElement>('.abyss-project-value-picker-action'),
    ).click();
    await settle();
    expect(secondSave).toHaveBeenCalledWith(['Alpha', '新規 🚀']);
  });

  it('edits one selected list item in place and avoids a duplicate replacement', async () => {
    const container = freshContainer();
    const save = vi.fn().mockResolvedValue(undefined);
    mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:Team', property: 'Team', label: 'Team', type: 'list' },
      value: ['Alpha', 'Beta', 'Gamma'],
      catalog: catalog(['Alpha', 'Beta', 'Gamma', 'Delta']),
      save,
      onClose: vi.fn(),
    });
    expectDefined(
      option(container, 'Beta').querySelector<HTMLButtonElement>('[aria-label="Edit Beta"]'),
    ).click();
    const input = pickerInput(container);
    expect(input.value).toBe('Beta');
    inputEvent(input, 'Delta');
    keydown(input, 'Enter');
    await settle();
    expect(save).toHaveBeenLastCalledWith(['Alpha', 'Delta', 'Gamma']);

    expectDefined(
      option(container, 'Delta').querySelector<HTMLButtonElement>('[aria-label="Edit Delta"]'),
    ).click();
    inputEvent(input, 'Alpha');
    keydown(input, 'Enter');
    await settle();
    expect(save).toHaveBeenLastCalledWith(['Alpha', 'Gamma']);
  });

  it('keeps an out-of-catalog value available for remove and re-add in the same session', async () => {
    const container = freshContainer();
    const save = vi.fn().mockResolvedValue(undefined);
    mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:Team', property: 'Team', label: 'Team', type: 'list' },
      value: ['Legacy'],
      catalog: catalog(['Current']),
      save,
      onClose: vi.fn(),
    });
    const input = pickerInput(container);
    const stableLegacyRow = option(container, 'Legacy');
    stableLegacyRow.click();
    await settle();
    expect(save).toHaveBeenLastCalledWith([]);
    expect(option(container, 'Legacy')).toBe(stableLegacyRow);
    expect(option(container, 'Legacy').getAttribute('aria-selected')).toBe('false');
    option(container, 'Legacy').click();
    await settle();
    expect(save).toHaveBeenLastCalledWith(['Legacy']);
    expect(pickerInput(container)).toBe(input);
  });

  it('keeps the raw identity of a malformed selected value when removing it', async () => {
    const container = freshContainer();
    const malformed = { legacy: true };
    const save = vi.fn().mockResolvedValue(undefined);
    mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:Team', property: 'Team', label: 'Team', type: 'list' },
      value: [malformed, true],
      catalog: catalog(),
      save,
      onClose: vi.fn(),
    });

    option(container, '[object Object]').click();
    await settle();

    expect(save).toHaveBeenCalledWith([true]);
  });

  it('moves keyboard activity in the displayed selected-then-available order', () => {
    const container = freshContainer();
    mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:Team', property: 'Team', label: 'Team', type: 'list' },
      value: ['Alpha', 'Beta'],
      catalog: catalog(['Alpha', 'Beta', 'Gamma']),
      save: vi.fn().mockResolvedValue(undefined),
      onClose: vi.fn(),
    });
    option(container, 'Alpha').click();
    const input = pickerInput(container);

    keydown(input, 'ArrowDown');

    expect(input.getAttribute('aria-activedescendant')).toBe(option(container, 'Beta').id);
  });

  it('reveals keyboard activity by scrolling only the results list', () => {
    const container = freshContainer();
    mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:Team', property: 'Team', label: 'Team', type: 'list' },
      value: [],
      catalog: catalog(['Alpha', 'Beta']),
      save: vi.fn().mockResolvedValue(undefined),
      onClose: vi.fn(),
    });
    const results = expectDefined(
      container.querySelector<HTMLElement>('.abyss-project-value-picker-results'),
    );
    const alpha = option(container, 'Alpha');
    const beta = option(container, 'Beta');
    vi.spyOn(results, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 32 } as DOMRect);
    vi.spyOn(alpha, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 32 } as DOMRect);
    vi.spyOn(beta, 'getBoundingClientRect').mockReturnValue({ top: 40, bottom: 72 } as DOMRect);
    const input = pickerInput(container);

    keydown(input, 'ArrowDown');
    keydown(input, 'ArrowDown');

    expect(results.scrollTop).toBe(40);
  });

  it('writes literal statuses and numeric choices with their exact scalar types', async () => {
    const statusContainer = freshContainer();
    const statusSave = vi.fn().mockResolvedValue(undefined);
    mountProjectCellEditor({
      app: new App(),
      container: statusContainer,
      field: { id: 'status', label: 'Status', type: 'status' },
      value: 'In flight',
      catalog: catalog(['Waiting on vendor'], 'text'),
      statuses: [{ id: 'active', name: 'In flight', onLeftPanel: true }],
      save: statusSave,
      onClose: vi.fn(),
    });
    const statusInput = pickerInput(statusContainer);
    inputEvent(statusInput, 'Needs 🧪');
    keydown(statusInput, 'Enter');
    await settle();
    expect(statusSave).toHaveBeenCalledWith('Needs 🧪');

    const numberContainer = freshContainer();
    const numberSave = vi.fn().mockResolvedValue(undefined);
    mountProjectCellEditor({
      app: new App(),
      container: numberContainer,
      field: { id: 'property:Estimate', property: 'Estimate', label: 'Estimate', type: 'number' },
      value: 2,
      catalog: catalog(['3.5'], 'number'),
      save: numberSave,
      onClose: vi.fn(),
    });
    option(numberContainer, '3.5').click();
    await settle();
    expect(numberSave).toHaveBeenCalledWith(3.5);
  });

  it('suppresses equivalent tag and resolved-link literals', () => {
    const app = new App();
    vi.spyOn(app.metadataCache, 'getFirstLinkpathDest').mockImplementation((target) => {
      if (target !== 'People/Anna Smith' && target !== 'People/Anna Smith.md') return null;
      const candidate: unknown = Object.assign(Object.create(TFile.prototype), {
        path: 'People/Anna Smith.md',
      });
      return candidate instanceof TFile ? candidate : null;
    });
    const linkContainer = freshContainer();
    mountProjectCellEditor({
      app,
      container: linkContainer,
      field: { id: 'property:Owner', property: 'Owner', label: 'Owner', type: 'list' },
      value: ['[[People/Anna Smith|Anna]]'],
      catalog: catalog([], 'list'),
      sourcePath: 'Projects/Current.md',
      save: vi.fn().mockResolvedValue(undefined),
      onClose: vi.fn(),
    });
    inputEvent(pickerInput(linkContainer), '[Anna](People/Anna%20Smith.md)');
    expect(linkContainer.querySelector('.abyss-project-value-picker-action')).toBeNull();

    const tagContainer = freshContainer();
    mountProjectCellEditor({
      app: new App(),
      container: tagContainer,
      field: { id: 'property:tags', property: 'tags', label: 'Tags', type: 'tags' },
      value: ['quality'],
      catalog: catalog([], 'tags'),
      save: vi.fn().mockResolvedValue(undefined),
      onClose: vi.fn(),
    });
    inputEvent(pickerInput(tagContainer), '#quality');
    expect(tagContainer.querySelector('.abyss-project-value-picker-action')).toBeNull();
  });

  it('ignores composing Enter and preserves a newer toggle while an earlier save is pending', async () => {
    let release: (() => void) | undefined;
    const firstSave = new Promise<void>((resolve) => {
      release = resolve;
    });
    const container = document.body.createDiv();
    const save = vi.fn().mockReturnValueOnce(firstSave).mockResolvedValue(undefined);
    mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:Team', property: 'Team', label: 'Team', type: 'list' },
      value: [],
      catalog: catalog(['Alpha', 'Beta']),
      save,
      onClose: vi.fn(),
    });
    const input = pickerInput(container);
    inputEvent(input, 'Gamma');
    keydown(input, 'Enter', true);
    expect(save).not.toHaveBeenCalled();
    inputEvent(input, '');
    option(container, 'Alpha').click();
    option(container, 'Beta').click();
    expect(save).toHaveBeenCalledOnce();
    expectDefined(release)();
    await settle();
    await settle();
    expect(save).toHaveBeenLastCalledWith(['Alpha', 'Beta']);
    expect(input.isConnected).toBe(true);
  });

  it('keeps picker state and focus available for retry after a failed save', async () => {
    const container = document.body.createDiv();
    const save = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new ProjectEditValidationError('Source changed'))
      .mockResolvedValue(undefined);
    mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:Team', property: 'Team', label: 'Team', type: 'list' },
      value: [],
      catalog: catalog(['Alpha', 'Beta']),
      save,
      onClose: vi.fn(),
    });

    option(container, 'Alpha').click();
    await settle();
    await settle();
    expect(pickerInput(container).isConnected).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Source changed');
    expect(save).toHaveBeenCalledOnce();

    option(container, 'Beta').click();
    await settle();
    expect(save).toHaveBeenLastCalledWith(['Alpha', 'Beta']);
  });

  it('closes from a pointer on a nonfocusable outside surface without assigning the query', async () => {
    const container = document.body.createDiv();
    const save = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:Team', property: 'Team', label: 'Team', type: 'list' },
      value: ['Alpha'],
      catalog: catalog(['Alpha']),
      save,
      onClose,
    });
    const input = pickerInput(container);
    inputEvent(input, 'Unsubmitted');
    const outside = document.body.createDiv();

    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await settle();

    expect(save).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith('committed', {
      navigation: 'preserve-focus',
      focusTarget: outside,
    });
  });
});
