import { App, Notice, Scope, TFile } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import {
  mountProjectCellEditor,
  type ProjectCellEditorResult,
} from '../src/panels/projects/ProjectCellEditor';
import type { ProjectPropertyCatalog } from '../src/projects/ObsidianProjectProperties';
import { ProjectEditValidationError } from '../src/projects/projectEditError';
import type { ProjectPropertyType } from '../src/projects/projectFields';
import { ProjectPropertySuggest } from '../src/ui/ProjectPropertySuggest';
import { expectDefined, freshContainer } from './helpers';

function catalog(
  values: readonly string[] = [],
  type: ProjectPropertyType | null = 'text',
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

function keydown(element: HTMLElement, key: string): void {
  element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

function pickerInput(container: HTMLElement): HTMLInputElement {
  return expectDefined(container.querySelector<HTMLInputElement>('[role="combobox"]'));
}

function pickerOptions(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'));
}

function pickerOption(container: HTMLElement, value: string | number): HTMLElement {
  return expectDefined(
    pickerOptions(container).find((option) => option.dataset['value'] === String(value)),
  );
}

describe('mountProjectCellEditor', () => {
  it('defers focus until the caller positions and activates the mounted editor', () => {
    const container = document.body.createDiv();
    const outside = document.body.createEl('button');
    outside.focus();

    const handle = mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:Custom', property: 'Custom', label: 'Custom', type: 'text' },
      value: 'Alpha',
      catalog: catalog(),
      save: vi.fn().mockResolvedValue(undefined),
      onClose: vi.fn(),
    });
    const input = expectDefined(container.querySelector<HTMLInputElement>('input'));

    expect(activeDocument.activeElement).toBe(outside);
    handle.focus();
    expect(activeDocument.activeElement).toBe(input);
  });

  it('edits a multiline curated description in a textarea without committing Enter', async () => {
    const container = freshContainer();
    const save = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'description', property: 'description', label: 'Description', type: 'text' },
      value: 'First line\nSecond line',
      catalog: catalog(),
      save,
      onClose,
    });
    const textarea = expectDefined(
      container.querySelector<HTMLTextAreaElement>('.abyss-project-description-editor'),
    );
    expect(textarea.value).toBe('First line\nSecond line');
    expect(textarea.placeholder).toBe('Description');

    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    textarea.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false);
    expect(save).not.toHaveBeenCalled();

    textarea.value = 'First line\nSecond line\nThird line';
    keydown(textarea, 'Tab');
    await settle();
    expect(save).toHaveBeenCalledWith('First line\nSecond line\nThird line');
    expect(onClose).toHaveBeenCalledWith('committed', { navigation: 'tab-forward' });
  });

  it('closes an unchanged multiline description without writing', async () => {
    const container = freshContainer();
    const save = vi.fn().mockResolvedValue(undefined);
    const handle = mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'description', property: 'description', label: 'Description', type: 'text' },
      value: 'First line\nSecond line',
      catalog: catalog(),
      save,
      onClose: vi.fn(),
    });

    await expect(handle.commit()).resolves.toBe(true);
    expect(save).not.toHaveBeenCalled();
  });

  it('matches native unset checkbox attributes in the editor', () => {
    const container = freshContainer();
    mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:Flag', property: 'Flag', label: 'Flag', type: 'checkbox' },
      value: undefined,
      catalog: catalog([], 'checkbox'),
      save: vi.fn().mockResolvedValue(undefined),
      onClose: vi.fn(),
    });
    const checkbox = expectDefined(
      container.querySelector<HTMLInputElement>('input.metadata-input-checkbox'),
    );

    expect(checkbox.checked).toBe(false);
    expect(checkbox.indeterminate).toBe(false);
    expect(checkbox.dataset['indeterminate']).toBe('true');
  });

  it('reports forward and backward Tab separately and preserves an external blur target', async () => {
    const forwardContainer = freshContainer();
    const forwardClose = vi.fn();
    mountProjectCellEditor({
      app: new App(),
      container: forwardContainer,
      field: { id: 'property:Custom', property: 'Custom', label: 'Custom', type: 'text' },
      value: 'Alpha',
      catalog: catalog(),
      save: vi.fn().mockResolvedValue(undefined),
      onClose: forwardClose,
    });
    keydown(expectDefined(forwardContainer.querySelector<HTMLInputElement>('input')), 'Tab');
    await settle();
    expect(forwardClose).toHaveBeenCalledWith('committed', { navigation: 'tab-forward' });

    const backwardContainer = freshContainer();
    const backwardClose = vi.fn();
    const backwardInput = (() => {
      mountProjectCellEditor({
        app: new App(),
        container: backwardContainer,
        field: { id: 'property:Custom', property: 'Custom', label: 'Custom', type: 'text' },
        value: 'Alpha',
        catalog: catalog(),
        save: vi.fn().mockResolvedValue(undefined),
        onClose: backwardClose,
      });
      return expectDefined(backwardContainer.querySelector<HTMLInputElement>('input'));
    })();
    backwardInput.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }),
    );
    await settle();
    expect(backwardClose).toHaveBeenCalledWith('committed', { navigation: 'tab-backward' });

    const blurContainer = freshContainer();
    const blurClose = vi.fn();
    mountProjectCellEditor({
      app: new App(),
      container: blurContainer,
      field: { id: 'property:Custom', property: 'Custom', label: 'Custom', type: 'text' },
      value: 'Alpha',
      catalog: catalog(),
      save: vi.fn().mockResolvedValue(undefined),
      onClose: blurClose,
    });
    const blurInput = expectDefined(blurContainer.querySelector<HTMLInputElement>('input'));
    const outside = document.body.createEl('button');
    blurInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: outside }));
    await settle();
    expect(blurClose).toHaveBeenCalledWith('committed', {
      navigation: 'preserve-focus',
      focusTarget: outside,
    });
  });

  it('does not close when focus returns inside during deferred blur handling', async () => {
    const container = document.body.createDiv();
    const save = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:Custom', property: 'Custom', label: 'Custom', type: 'text' },
      value: 'Alpha',
      catalog: catalog(),
      save,
      onClose,
    });
    const input = expectDefined(container.querySelector<HTMLInputElement>('input'));
    input.focus();
    input.dispatchEvent(
      new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }),
    );
    input.focus();
    await settle();

    expect(save).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps Tab intent through an in-flight blur but accepts a deliberate Enter retry', async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pendingContainer = freshContainer();
    const pendingClose = vi.fn();
    const pendingSave = vi.fn().mockReturnValue(pending);
    mountProjectCellEditor({
      app: new App(),
      container: pendingContainer,
      field: { id: 'property:Custom', property: 'Custom', label: 'Custom', type: 'text' },
      value: 'old',
      catalog: catalog(),
      save: pendingSave,
      onClose: pendingClose,
    });
    const pendingInput = expectDefined(pendingContainer.querySelector<HTMLInputElement>('input'));
    pendingInput.value = 'new';
    keydown(pendingInput, 'Tab');
    pendingInput.dispatchEvent(
      new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }),
    );
    expectDefined(release)();
    await settle();
    expect(pendingClose).toHaveBeenCalledWith('committed', { navigation: 'tab-forward' });

    const retryContainer = freshContainer();
    const retryClose = vi.fn();
    const retrySave = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new ProjectEditValidationError('Conflict'))
      .mockResolvedValue(undefined);
    mountProjectCellEditor({
      app: new App(),
      container: retryContainer,
      field: { id: 'property:Custom', property: 'Custom', label: 'Custom', type: 'text' },
      value: 'old',
      catalog: catalog(),
      save: retrySave,
      onClose: retryClose,
    });
    const retryInput = expectDefined(retryContainer.querySelector<HTMLInputElement>('input'));
    retryInput.value = 'new';
    keydown(retryInput, 'Tab');
    await settle();
    await settle();
    expect(retryClose).not.toHaveBeenCalled();

    keydown(retryInput, 'Enter');
    await settle();
    expect(retryClose).toHaveBeenCalledWith('committed', { navigation: 'restore-current' });
  });

  it('contains Escape within the editor even when close removes it synchronously', () => {
    const container = freshContainer();
    const outside = vi.fn();
    container.addEventListener('click', outside);
    mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'start', property: 'start', label: 'Start', type: 'date' },
      value: '2026-09-08',
      catalog: catalog(),
      save: vi.fn().mockResolvedValue(undefined),
      onClose: vi.fn(),
    });

    keydown(expectDefined(container.querySelector<HTMLInputElement>('input')), 'Escape');

    expect(outside).not.toHaveBeenCalled();
    expect(container.querySelector('.abyss-project-editor-save')).toBeNull();
    expect(container.querySelector('.abyss-project-editor-cancel')).toBeNull();
  });

  it('commits a custom number as a number', async () => {
    const container = document.body.createDiv();
    const save = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn<(result: ProjectCellEditorResult) => void>();
    mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:Custom', property: 'Custom', label: 'Budget', type: 'number' },
      value: 12,
      catalog: catalog([], 'number'),
      save,
      onClose,
    });
    const input = expectDefined(container.querySelector<HTMLInputElement>('input[type="number"]'));
    input.value = '18.5';
    keydown(input, 'Enter');
    await settle();

    expect(save).toHaveBeenCalledWith(18.5);
    expect(onClose).toHaveBeenCalledWith('committed', { navigation: 'restore-current' });
  });

  it('prioritizes a preset-only number and writes its exact numeric payload', async () => {
    const container = document.body.createDiv();
    const save = vi.fn().mockResolvedValue(undefined);
    mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:Custom', property: 'Custom', label: 'Budget', type: 'number' },
      value: '42',
      catalog: catalog(['7'], 'number'),
      presets: [{ value: 42, label: 'Forty two', display: 'badge', color: '#123456' }],
      sourceField: 'property:Custom',
      save,
      onClose: vi.fn(),
    });
    expect(pickerOptions(container).map(({ dataset }) => dataset['value'])).toEqual([
      '42',
      '42',
      '7',
    ]);
    const preset = expectDefined(
      pickerOptions(container).find(
        (option) =>
          option.dataset['value'] === '42' && option.getAttribute('aria-selected') === 'false',
      ),
    );
    expect(preset.textContent).toContain('Forty two');
    preset.click();
    await settle();

    expect(save).toHaveBeenCalledWith(42);
  });

  it('writes a finite existing number suggestion as a number and filters invalid values', async () => {
    const container = document.body.createDiv();
    const save = vi.fn().mockResolvedValue(undefined);
    mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:Custom', property: 'Custom', label: 'Budget', type: 'number' },
      value: '42',
      catalog: catalog(['7', 'nope', ''], 'number'),
      sourceField: 'property:Custom',
      save,
      onClose: vi.fn(),
    });
    expect(pickerOptions(container).map(({ dataset }) => dataset['value'])).toEqual(['42', '7']);
    expect(pickerOptions(container).map(({ dataset }) => dataset['value'])).not.toContain('nope');
    pickerOption(container, 7).click();
    await settle();

    expect(save).toHaveBeenCalledWith(7);
  });

  it('keeps raw identity when a preset display alias is selected', async () => {
    const container = document.body.createDiv();
    const save = vi.fn().mockResolvedValue(undefined);
    mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:Custom', property: 'Custom', label: 'Phase', type: 'text' },
      value: '',
      catalog: catalog([], 'text'),
      presets: [{ value: 'raw-phase', label: 'Ready to ship', display: 'text' }],
      sourceField: 'property:Custom',
      save,
      onClose: vi.fn(),
    });
    pickerOption(container, 'raw-phase').click();
    await settle();

    expect(save).toHaveBeenCalledWith('raw-phase');
  });

  it('excludes a preset immediately after it is picked into a list', async () => {
    const container = document.body.createDiv();
    mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:Custom', property: 'Custom', label: 'Owners', type: 'list' },
      value: [],
      catalog: catalog([], 'list'),
      presets: [{ value: 'Mina', label: 'Mina Torres', display: 'badge' }],
      sourceField: 'property:Custom',
      save: vi.fn().mockResolvedValue(undefined),
      onClose: vi.fn(),
    });
    expect(pickerOptions(container).map(({ dataset }) => dataset['value'])).toEqual(['Mina']);
    pickerOption(container, 'Mina').click();
    await settle();
    expect(pickerOption(container, 'Mina').getAttribute('aria-selected')).toBe('true');
  });

  it('deduplicates and excludes tag suggestions by canonical tag identity', async () => {
    const container = document.body.createDiv();
    const save = vi.fn().mockResolvedValue(undefined);
    mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:tags', property: 'tags', label: 'Tags', type: 'tags' },
      value: ['qa-table', 'qa-nested/example'],
      catalog: catalog(
        ['qa-table', '#qa-table', '#qa-nested/example', '#demo', 'demo', '#fresh'],
        'tags',
      ),
      presets: [
        { value: '#qa-table', label: '#QA table', appearance: 'tag' },
        { value: 'demo', label: '#Demo preset', appearance: 'tag' },
        { value: '#preset-only', label: '#Preset only', appearance: 'tag' },
      ],
      sourceField: 'property:tags',
      save,
      onClose: vi.fn(),
    });
    expect(pickerOptions(container).map(({ dataset }) => dataset['value'])).toEqual([
      'qa-table',
      'qa-nested/example',
      'demo',
      '#preset-only',
      '#fresh',
    ]);
    pickerOption(container, 'demo').click();
    await settle();

    expect(save).toHaveBeenCalledWith(['qa-table', 'qa-nested/example', 'demo']);
    expect(pickerOption(container, 'demo').getAttribute('aria-selected')).toBe('true');
  });

  it('keeps hashtag and unprefixed values distinct for generic lists', () => {
    const container = document.body.createDiv();
    mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:Custom', property: 'Custom', label: 'Values', type: 'list' },
      value: [],
      catalog: catalog(['demo', '#demo'], 'list'),
      save: vi.fn().mockResolvedValue(undefined),
      onClose: vi.fn(),
    });
    expect(pickerOptions(container).map(({ dataset }) => dataset['value'])).toEqual([
      'demo',
      '#demo',
    ]);
  });

  it('shows one dot marker with the configured label for an existing exact preset list value', () => {
    const container = document.body.createDiv();
    mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:Custom', property: 'Custom', label: 'Owners', type: 'list' },
      value: ['[[People/Anna]]'],
      catalog: catalog([], 'list'),
      presets: [
        {
          value: '[[People/Anna]]',
          label: 'QA Anna',
          display: 'dot',
          color: '#123456',
        },
      ],
      sourceField: 'property:Custom',
      save: vi.fn().mockResolvedValue(undefined),
      onClose: vi.fn(),
    });

    const chip = pickerOption(container, '[[People/Anna]]');
    const presentation = expectDefined(chip.querySelector<HTMLElement>('.abyss-suggest-title'));
    expect(chip.textContent).toContain('QA Anna');
    expect(chip.textContent).not.toContain('Anna]]');
    expect(chip.querySelectorAll('.is-dot')).toHaveLength(1);
    expect(presentation.hasClass('is-dot')).toBe(true);
    expect(presentation.hasClass('abyss-project-preset-suggestion')).toBe(false);
    expect(presentation.hasClass('is-link')).toBe(true);
    expect(presentation.style.getPropertyValue('--abyss-project-property-color')).toBe('#123456');
  });

  it('keeps an explicitly selected list preset raw value exact', async () => {
    const container = document.body.createDiv();
    const save = vi.fn().mockResolvedValue(undefined);
    mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:Custom', property: 'Custom', label: 'Phases', type: 'list' },
      value: [],
      catalog: catalog([], 'list'),
      presets: [{ value: ' planned ', label: 'Planned', display: 'badge' }],
      sourceField: 'property:Custom',
      save,
      onClose: vi.fn(),
    });
    pickerOption(container, ' planned ').click();
    await settle();

    expect(save).toHaveBeenCalledWith([' planned ']);
    expect(pickerOption(container, ' planned ').getAttribute('aria-selected')).toBe('true');
  });

  it('restores details for colliding existing link labels after preset-first merging', () => {
    const container = document.body.createDiv();
    mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:Custom', property: 'Custom', label: 'Plans', type: 'list' },
      value: [],
      catalog: catalog(['[[A/Plan]]', '[[B/Plan]]'], 'list'),
      presets: [{ value: 'preset', label: 'Preset', display: 'text' }],
      sourceField: 'property:Custom',
      save: vi.fn().mockResolvedValue(undefined),
      onClose: vi.fn(),
    });
    expect(pickerOptions(container).map(({ dataset }) => dataset['value'])).toEqual([
      'preset',
      '[[A/Plan]]',
      '[[B/Plan]]',
    ]);
    expect(
      pickerOptions(container)
        .slice(1)
        .map((option) => option.querySelector('.abyss-suggest-path')?.textContent),
    ).toEqual(['A/Plan', 'B/Plan']);
  });

  it('keeps a configured tag chip native instead of adding a generic preset badge', () => {
    const container = document.body.createDiv();
    mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:tags', property: 'tags', label: 'Tags', type: 'tags' },
      value: ['qa'],
      catalog: catalog([], 'tags'),
      presets: [{ value: 'qa', label: '#Quality', display: 'dot', color: '#123456' }],
      sourceField: 'tags',
      save: vi.fn().mockResolvedValue(undefined),
      onClose: vi.fn(),
    });

    const chip = expectDefined(pickerOption(container, 'qa').querySelector<HTMLElement>('.tag'));
    expect(chip.textContent).toBe('#Quality');
    expect(chip.hasClass('tag')).toBe(true);
    expect(chip.hasClass('abyss-project-property-value')).toBe(false);
    expect(chip.hasClass('is-badge')).toBe(false);
    expect(chip.hasClass('is-dot')).toBe(true);
    expect(chip.style.getPropertyValue('--abyss-project-property-color')).toBe('#123456');
    expect(chip.style.color).toBe('');
  });

  it('writes the exact raw link once when a readable scalar suggestion is selected', async () => {
    const container = document.body.createDiv();
    const save = vi.fn().mockResolvedValue(undefined);
    mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:Custom', property: 'Custom', label: 'Owner', type: 'text' },
      value: 'Infrastructure',
      catalog: catalog(['[[People/Anna Smith|Anna]]', '[Anna](People/Anna-Jones.md)']),
      save,
      onClose: vi.fn(),
    });
    pickerOption(container, '[Anna](People/Anna-Jones.md)').click();
    await settle();

    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith('[Anna](People/Anna-Jones.md)');
  });

  it('offers and assigns a scalar catalog link with a new alias for the same note', async () => {
    const app = new App();
    vi.spyOn(app.metadataCache, 'getFirstLinkpathDest').mockImplementation((target) => {
      if (target !== 'People/Anna') return null;
      const candidate: unknown = Object.assign(Object.create(TFile.prototype), {
        path: 'People/Anna.md',
      });
      return candidate instanceof TFile ? candidate : null;
    });
    const container = freshContainer();
    const save = vi.fn().mockResolvedValue(undefined);
    const replacement = '[[People/Anna|New alias]]';
    mountProjectCellEditor({
      app,
      container,
      field: { id: 'property:Owner', property: 'Owner', label: 'Owner', type: 'text' },
      value: '[[People/Anna|Old alias]]',
      catalog: catalog([replacement]),
      sourcePath: 'Projects/Current.md',
      save,
      onClose: vi.fn(),
    });

    pickerOption(container, replacement).click();
    await settle();

    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(replacement);
  });

  it('replaces a scalar link heading when the resolved note is unchanged', async () => {
    const app = new App();
    vi.spyOn(app.metadataCache, 'getFirstLinkpathDest').mockImplementation((target) => {
      if (target !== 'People/Anna') return null;
      const candidate: unknown = Object.assign(Object.create(TFile.prototype), {
        path: 'People/Anna.md',
      });
      return candidate instanceof TFile ? candidate : null;
    });
    const container = freshContainer();
    const save = vi.fn().mockResolvedValue(undefined);
    const current = '[[People/Anna#Old section]]';
    const replacement = '[[People/Anna#New section]]';
    mountProjectCellEditor({
      app,
      container,
      field: { id: 'property:Owner', property: 'Owner', label: 'Owner', type: 'text' },
      value: current,
      catalog: catalog([current]),
      sourcePath: 'Projects/Current.md',
      save,
      onClose: vi.fn(),
    });
    expectDefined(
      pickerOption(container, current).querySelector<HTMLButtonElement>(
        '.abyss-project-value-picker-edit',
      ),
    ).click();
    const input = pickerInput(container);
    input.value = replacement;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    keydown(input, 'Enter');
    await settle();

    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(replacement);
  });

  it('replaces one list-link alias while keeping an equivalent raw addition blocked', async () => {
    const app = new App();
    vi.spyOn(app.metadataCache, 'getFirstLinkpathDest').mockImplementation((target) => {
      if (target !== 'People/Anna' && target !== 'People/Anna.md') return null;
      const candidate: unknown = Object.assign(Object.create(TFile.prototype), {
        path: 'People/Anna.md',
      });
      return candidate instanceof TFile ? candidate : null;
    });
    const current = '[[People/Anna|Old alias]]';
    const replacement = '[[People/Anna|New alias]]';
    const container = freshContainer();
    const save = vi.fn().mockResolvedValue(undefined);
    mountProjectCellEditor({
      app,
      container,
      field: { id: 'property:Owners', property: 'Owners', label: 'Owners', type: 'list' },
      value: [current, 'Celia'],
      catalog: catalog([], 'list'),
      sourcePath: 'Projects/Current.md',
      save,
      onClose: vi.fn(),
    });
    expectDefined(
      pickerOption(container, current).querySelector<HTMLButtonElement>(
        '[aria-label="Edit Old alias"]',
      ),
    ).click();
    const input = pickerInput(container);
    input.value = replacement;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    keydown(input, 'Enter');
    await settle();
    expect(save).toHaveBeenLastCalledWith([replacement, 'Celia']);

    input.value = '[Another alias](People/Anna.md)';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(container.querySelector('.abyss-project-value-picker-action')).toBeNull();
    keydown(input, 'Enter');
    await settle();

    expect(save).toHaveBeenCalledOnce();
  });

  it('shows a selected raw link with readable details in the vertical picker', async () => {
    const container = document.body.createDiv();
    const save = vi.fn().mockResolvedValue(undefined);
    const raw = '[[People/Anna Smith|Anna]]';
    const handle = mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:Custom', property: 'Custom', label: 'Owners', type: 'list' },
      value: [raw],
      catalog: catalog([], 'list'),
      save,
      onClose: vi.fn(),
    });

    const selected = pickerOption(container, raw);
    expect(selected.textContent).toContain('Anna');
    expect(selected.querySelector('.abyss-suggest-title')?.classList.contains('is-link')).toBe(
      true,
    );
    expect(selected.title).toBe(raw);
    expect(selected.getAttribute('aria-selected')).toBe('true');
    await expect(handle.commit()).resolves.toBe(true);
    expect(save).not.toHaveBeenCalled();
  });

  it('keeps an editor-owned option toggle alive through transient blur', async () => {
    const container = document.body.createDiv();
    const save = vi.fn().mockResolvedValue(undefined);
    mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:Custom', property: 'Custom', label: 'Owners', type: 'list' },
      value: ['Celia', 'Mina'],
      catalog: catalog([], 'list'),
      save,
      onClose: vi.fn(),
    });
    const input = pickerInput(container);
    const celia = pickerOption(container, 'Celia');

    celia.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    input.dispatchEvent(
      new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }),
    );
    celia.click();
    await settle();

    expect(save).toHaveBeenCalledWith(['Mina']);
  });

  it('closes in one Escape, retains saved toggles, and discards the search query', async () => {
    const container = document.body.createDiv();
    const save = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn();
    mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:Custom', property: 'Custom', label: 'Owners', type: 'list' },
      value: ['Celia'],
      catalog: catalog(['Mina'], 'list'),
      save,
      onClose: close,
    });
    pickerOption(container, 'Mina').click();
    await settle();
    const input = pickerInput(container);
    input.value = 'Anna';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));

    keydown(input, 'Escape');
    await settle();
    await settle();

    expect(close).toHaveBeenCalledWith('cancelled', { navigation: 'restore-current' });
    expect(save).toHaveBeenCalledWith(['Celia', 'Mina']);
    expect(save).not.toHaveBeenCalledWith(['Celia', 'Mina', 'Anna']);
  });

  it.each([
    ['checkbox', 'input[type="checkbox"]', true, true],
    ['date', 'input[type="date"]', '2026-09-12', '2026-09-12'],
    ['datetime', 'input[type="datetime-local"]', '2026-09-12T14:30', '2026-09-12T14:30'],
    ['tags', '[role="combobox"]', '#launch', ['#launch']],
  ] as const)(
    'maps custom %s fields to the typed control and saved value',
    async (type, selector, nextValue, expected) => {
      const container = document.body.createDiv();
      const save = vi.fn().mockResolvedValue(undefined);
      mountProjectCellEditor({
        app: new App(),
        container,
        field: { id: 'property:Custom', property: 'Custom', label: 'Custom', type },
        value: type === 'checkbox' ? false : undefined,
        catalog: catalog([], type),
        save,
        onClose: vi.fn(),
      });
      const input = expectDefined(container.querySelector<HTMLInputElement>(selector));
      if (type === 'checkbox') input.checked = nextValue;
      else input.value = nextValue;

      keydown(input, 'Enter');
      await settle();

      expect(save).toHaveBeenCalledWith(expected);
    },
  );

  it('opens and saves colored configured status choices while preserving an unknown value', async () => {
    const container = document.body.createDiv();
    const save = vi.fn().mockResolvedValue(undefined);
    mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'status', label: 'Status', type: 'status' },
      value: 'Waiting on vendor',
      catalog: catalog(),
      statuses: [
        {
          id: 'active',
          name: 'In flight',
          color: '#123456',
          onLeftPanel: true,
        },
        {
          id: 'done',
          name: 'Shipped',
          color: '#654321',
          display: 'dot',
          onLeftPanel: false,
        },
      ],
      save,
      onClose: vi.fn(),
    });
    expect(pickerInput(container).value).toBe('');
    expect(
      pickerOptions(container).map(
        (option) => option.querySelector('.abyss-suggest-title')?.textContent,
      ),
    ).toEqual(['Waiting on vendor', 'In flight', 'Shipped']);
    const inFlight = pickerOption(container, 'In flight');
    expect(
      inFlight
        .querySelector<HTMLElement>('.abyss-suggest-status')
        ?.classList.contains('abyss-project-preset-suggestion'),
    ).toBe(true);
    const shipped = pickerOption(container, 'Shipped');
    const renderedStatus = expectDefined(
      shipped.querySelector<HTMLElement>('.abyss-suggest-status'),
    );
    expect(renderedStatus.classList.contains('is-dot')).toBe(true);
    expect(shipped.querySelectorAll('.is-dot')).toHaveLength(1);
    expect(renderedStatus.style.getPropertyValue('--abyss-project-status-color')).toBe('#654321');
    expect(renderedStatus.style.color).toBe('');
    shipped.click();
    await settle();

    expect(save).toHaveBeenCalledWith('Shipped');
  });

  it.each([
    ['date', 'input[type="date"]', '2026-09-14'],
    ['datetime', 'input[type="datetime-local"]', '2026-09-14T09:45'],
  ] as const)('commits a finished native %s value on change', async (type, selector, value) => {
    const container = document.body.createDiv();
    const save = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:Custom', property: 'Custom', label: 'Custom', type },
      value: undefined,
      catalog: catalog([], type),
      save,
      onClose,
    });
    const input = expectDefined(container.querySelector<HTMLInputElement>(selector));
    input.value = value;

    input.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();

    expect(save).toHaveBeenCalledWith(value);
    expect(onClose).toHaveBeenCalledWith('committed', { navigation: 'restore-current' });
  });

  it.each([
    ['date', 'input[type="date"]', '2026-09-01', '2026-09-15'],
    ['datetime', 'input[type="datetime-local"]', '2026-09-09T01:00', '2026-09-09T15:00'],
  ] as const)(
    'keeps manual native %s digit entry mounted until an explicit finish',
    async (type, selector, firstDigitValue, completedValue) => {
      const container = document.body.createDiv();
      const save = vi.fn().mockResolvedValue(undefined);
      const onClose = vi.fn();
      mountProjectCellEditor({
        app: new App(),
        container,
        field: { id: 'property:Custom', property: 'Custom', label: 'Custom', type },
        value: '2026-09-09',
        catalog: catalog([], type),
        save,
        onClose,
      });
      const input = expectDefined(container.querySelector<HTMLInputElement>(selector));
      keydown(input, '1');
      input.value = firstDigitValue;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await settle();

      expect(save).not.toHaveBeenCalled();
      expect(input.isConnected).toBe(true);
      input.value = completedValue;
      keydown(input, 'Tab');
      await settle();

      expect(save).toHaveBeenCalledWith(completedValue);
      expect(onClose).toHaveBeenCalledOnce();
    },
  );

  it('commits a checkbox on change without waiting for Enter', async () => {
    const container = document.body.createDiv();
    const save = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:Custom', property: 'Custom', label: 'Custom', type: 'checkbox' },
      value: false,
      catalog: catalog([], 'checkbox'),
      save,
      onClose,
    });
    const input = expectDefined(
      container.querySelector<HTMLInputElement>('input[type="checkbox"]'),
    );
    input.checked = true;

    input.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();

    expect(save).toHaveBeenCalledWith(true);
    expect(onClose).toHaveBeenCalledWith('committed', { navigation: 'restore-current' });
  });

  it('closes an unchanged editor without writing', async () => {
    const container = document.body.createDiv();
    const save = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    const handle = mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:Custom', property: 'Custom', label: 'Custom', type: 'text' },
      value: 'unchanged',
      catalog: catalog(),
      save,
      onClose,
    });

    await expect(handle.commit()).resolves.toBe(true);

    expect(save).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each([
    ['text', undefined],
    ['checkbox', undefined],
    ['date', undefined],
    ['datetime', undefined],
    ['number', undefined],
    ['list', undefined],
    ['list', 'Celia'],
  ] as const)('does not write an untouched %s source value %#', async (type, value) => {
    const container = document.body.createDiv();
    const save = vi.fn().mockResolvedValue(undefined);
    const handle = mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:Custom', property: 'Custom', label: 'Custom', type },
      value,
      catalog: catalog([], type),
      save,
      onClose: vi.fn(),
    });

    await expect(handle.commit()).resolves.toBe(true);

    expect(save).not.toHaveBeenCalled();
  });

  it('cancels with Escape without saving', () => {
    const container = document.body.createDiv();
    const save = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:Custom', property: 'Custom', label: 'Custom', type: 'text' },
      value: 'draft',
      catalog: catalog(),
      save,
      onClose,
    });

    keydown(expectDefined(container.querySelector('input')), 'Escape');

    expect(save).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith('cancelled', { navigation: 'restore-current' });
  });

  it('autosaves a blank text value exactly once on blur', async () => {
    const container = document.body.createDiv();
    const save = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:Custom', property: 'Custom', label: 'Custom', type: 'text' },
      value: 'old',
      catalog: catalog(),
      save,
      onClose,
    });
    const input = expectDefined(container.querySelector<HTMLInputElement>('input'));
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(
      new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }),
    );
    await settle();

    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith('');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('returns false from a failed commit and retains focus and the draft', async () => {
    const container = document.body.createDiv();
    const handle = mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:Custom', property: 'Custom', label: 'Custom', type: 'text' },
      value: 'old',
      catalog: catalog(),
      save: vi.fn().mockRejectedValue(new ProjectEditValidationError('Conflict')),
      onClose: vi.fn(),
    });
    const input = expectDefined(container.querySelector<HTMLInputElement>('input'));
    input.value = 'draft';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    await expect(handle.commit()).resolves.toBe(false);

    expect(input.isConnected).toBe(true);
    expect(input.value).toBe('draft');
    expect(activeDocument.activeElement).toBe(input);
  });

  it('coalesces an in-flight commit and saves the newer draft before closing', async () => {
    const container = document.body.createDiv();
    let release: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    const save = vi.fn().mockReturnValueOnce(first).mockResolvedValue(undefined);
    const handle = mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:Custom', property: 'Custom', label: 'Custom', type: 'text' },
      value: 'old',
      catalog: catalog(),
      save,
      onClose: vi.fn(),
    });
    const input = expectDefined(container.querySelector<HTMLInputElement>('input'));
    input.value = 'first';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const committed = handle.commit();
    input.value = 'second';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const coalesced = handle.commit();
    expectDefined(release)();

    await expect(Promise.all([committed, coalesced])).resolves.toEqual([true, true]);
    expect(save.mock.calls).toEqual([['first'], ['second']]);
  });

  it('does not treat an empty native input with badInput as a clear', async () => {
    const container = document.body.createDiv();
    const save = vi.fn().mockResolvedValue(undefined);
    const handle = mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'start', property: 'start', label: 'Start', type: 'date' },
      value: '2026-09-08',
      catalog: catalog([], 'date'),
      save,
      onClose: vi.fn(),
    });
    const input = expectDefined(container.querySelector<HTMLInputElement>('input[type="date"]'));
    input.value = '';
    Object.defineProperty(input, 'validity', { value: { badInput: true }, configurable: true });

    await expect(handle.commit()).resolves.toBe(false);
    expect(save).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('valid date');
    handle.destroy();
  });

  it('retains the draft and reports one boundary error when an I/O save rejects', async () => {
    const container = document.body.createDiv();
    const error = new Error('disk full');
    const save = vi.fn().mockRejectedValue(error);
    const onClose = vi.fn();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const notice = vi.spyOn(
      Notice.prototype as unknown as { constructor__(message: unknown, duration?: number): void },
      'constructor__',
    );
    mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:Custom', property: 'Custom', label: 'Custom', type: 'text' },
      value: 'old',
      catalog: catalog(),
      save,
      onClose,
    });
    const input = expectDefined(container.querySelector<HTMLInputElement>('input[type="text"]'));
    input.value = 'unfinished';
    keydown(input, 'Enter');
    await settle();

    expect(input.isConnected).toBe(true);
    expect(input.value).toBe('unfinished');
    expect(container.querySelector('.abyss-project-editor-error')?.textContent).toContain(
      'disk full',
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
    expect(notice).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
  });

  it('keeps validation failures inline without an I/O diagnostic or Notice', async () => {
    const container = document.body.createDiv();
    const save = vi
      .fn()
      .mockRejectedValue(new ProjectEditValidationError('Start must be before End.'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const notice = vi.spyOn(
      Notice.prototype as unknown as { constructor__(message: unknown, duration?: number): void },
      'constructor__',
    );
    mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'start', property: 'start', label: 'Start', type: 'date' },
      value: '2026-09-20',
      catalog: catalog(),
      save,
      onClose: vi.fn(),
    });
    const input = expectDefined(container.querySelector<HTMLInputElement>('input[type="date"]'));
    input.value = '2026-09-30';
    keydown(input, 'Enter');
    await settle();

    expect(input.isConnected).toBe(true);
    expect(input.value).toBe('2026-09-30');
    expect(container.querySelector('.abyss-project-editor-error')?.textContent).toContain(
      'Start must be before End.',
    );
    expect(log).not.toHaveBeenCalled();
    expect(notice).not.toHaveBeenCalled();
  });

  it('keeps the configured editor type when the native registry changes', async () => {
    const container = document.body.createDiv();
    const save = vi.fn().mockResolvedValue(undefined);
    const currentCatalog = catalog([], 'number');
    mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:Custom', property: 'Custom', label: 'Custom', type: 'text' },
      value: 'draft',
      catalog: currentCatalog,
      save,
      onClose: vi.fn(),
    });

    const input = expectDefined(container.querySelector<HTMLInputElement>('input'));
    input.value = 'unfinished';
    keydown(input, 'Enter');
    await settle();

    expect(save).toHaveBeenCalledWith('unfinished');
  });

  it('blocks a stale custom editor against the owner current configured field', async () => {
    const container = document.body.createDiv();
    const save = vi.fn().mockResolvedValue(undefined);
    mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:Custom', property: 'Custom', label: 'Custom', type: 'text' },
      value: 'draft',
      catalog: catalog([], 'text'),
      resolveField: () => ({
        id: 'property:Custom',
        property: 'Custom',
        label: 'Custom',
        type: 'number',
      }),
      save,
      onClose: vi.fn(),
    });

    const input = expectDefined(container.querySelector<HTMLInputElement>('input'));
    input.value = 'unfinished';
    keydown(input, 'Enter');
    await settle();

    expect(save).not.toHaveBeenCalled();
    expect(input.value).toBe('unfinished');
    expect(container.querySelector('.abyss-project-editor-error')?.textContent).toContain(
      'configuration changed',
    );
  });
});

describe('ProjectPropertySuggest', () => {
  it('browses alternatives for an unchanged populated value, then filters after actual input', () => {
    const input = document.body.createEl('input');
    input.value = 'Infrastructure';
    const suggest = new ProjectPropertySuggest({
      app: new App(),
      input,
      values: ['Infrastructure', 'Marketing'],
      onPick: vi.fn(),
      browseOnOpen: true,
    });

    expect(suggest.getSuggestions(input.value).map(({ value }) => value)).toEqual([
      'Infrastructure',
      'Marketing',
    ]);
    input.value = 'Mark';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(suggest.getSuggestions(input.value).map(({ value }) => value)).toEqual(['Marketing']);
    suggest.close();
    input.dispatchEvent(new FocusEvent('focus'));
    suggest.open();
    expect(suggest.getSuggestions(input.value).map(({ value }) => value)).toEqual([
      'Infrastructure',
      'Marketing',
    ]);
    suggest.close();
  });

  it('shows exact-link aliases while preserving and distinguishing their raw targets', () => {
    const suggest = new ProjectPropertySuggest({
      app: new App(),
      input: document.body.createEl('input'),
      values: ['[[People/Anna Smith|Anna]]', '[Anna](People/Anna-Jones.md)', 'Plain value'],
      onPick: vi.fn(),
    });

    expect(suggest.getSuggestions('Anna')).toEqual([
      {
        kind: 'value',
        value: '[[People/Anna Smith|Anna]]',
        label: 'Anna',
        detail: 'People/Anna Smith',
      },
      {
        kind: 'value',
        value: '[Anna](People/Anna-Jones.md)',
        label: 'Anna',
        detail: 'People/Anna-Jones.md',
      },
    ]);
    expect(suggest.getSuggestions('Anna-Jones').map(({ value }) => value)).toEqual([
      '[Anna](People/Anna-Jones.md)',
    ]);
    const rendered = document.body.createDiv();
    suggest.renderSuggestion(expectDefined(suggest.getSuggestions('Anna')[0]), rendered);
    expect(rendered.querySelector('.abyss-suggest-title')?.classList.contains('is-link')).toBe(
      true,
    );
  });

  it('renders configured tag suggestions with native tag presentation', () => {
    const suggest = new ProjectPropertySuggest({
      app: new App(),
      input: document.body.createEl('input'),
      values: [],
      onPick: vi.fn(),
    });
    const rendered = document.body.createDiv();

    suggest.renderSuggestion(
      {
        value: 'quality',
        label: '#Quality',
        appearance: 'tag',
        display: 'dot',
        color: '#123456',
      },
      rendered,
    );

    const title = expectDefined(rendered.querySelector<HTMLElement>('.abyss-suggest-title'));
    const tag = expectDefined(title.querySelector<HTMLElement>('.tag'));
    expect(title.classList.contains('abyss-project-preset-suggestion')).toBe(false);
    expect(title.classList.contains('is-dot')).toBe(false);
    expect(tag.classList.contains('is-dot')).toBe(true);
    expect(title.style.getPropertyValue('--abyss-project-property-color')).toBe('');
    expect(tag.style.getPropertyValue('--abyss-project-property-color')).toBe('#123456');
    expect(tag.style.color).toBe('');
  });

  it('renders a configured property suggestion as one dot and an uncolored label', () => {
    const suggest = new ProjectPropertySuggest({
      app: new App(),
      input: document.body.createEl('input'),
      values: [],
      onPick: vi.fn(),
    });
    const rendered = document.body.createDiv();

    suggest.renderSuggestion(
      { value: 'review', label: 'Review', display: 'dot', color: '#123456' },
      rendered,
    );

    const title = expectDefined(rendered.querySelector<HTMLElement>('.abyss-suggest-title'));
    expect(rendered.querySelectorAll('.is-dot')).toHaveLength(1);
    expect(title.classList.contains('is-dot')).toBe(true);
    expect(title.classList.contains('abyss-project-preset-suggestion')).toBe(false);
    expect(title.style.getPropertyValue('--abyss-project-property-color')).toBe('#123456');
    expect(title.style.color).toBe('');
    expect(title.textContent).toBe('Review');
  });

  it('filters selected values dynamically before applying the text query', () => {
    const selected = ['Alpha'];
    const suggest = new ProjectPropertySuggest({
      app: new App(),
      input: document.body.createEl('input'),
      values: ['Alpha', 'Beta'],
      onPick: vi.fn(),
      exclude: (value) => typeof value === 'string' && selected.includes(value),
    });

    expect(suggest.getSuggestions('a').map(({ value }) => value)).toEqual(['Beta']);
    selected.splice(0, 1);
    expect(suggest.getSuggestions('a').map(({ value }) => value)).toEqual(['Alpha', 'Beta']);
  });

  it('leaves native Escape dismissal in charge when no editor callback is supplied', () => {
    const scopeRegister = vi.spyOn(Scope.prototype, 'register');

    const suggest = new ProjectPropertySuggest({
      app: new App(),
      input: document.body.createEl('input'),
      values: ['Owner'],
      onPick: vi.fn(),
    });

    expect(suggest).toBeInstanceOf(ProjectPropertySuggest);
    expect(scopeRegister.mock.calls.some(([, key]) => key === 'Escape')).toBe(false);
  });

  it('reports popup ownership once for each open lifetime', () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const suggest = new ProjectPropertySuggest({
      app: new App(),
      input: document.body.createEl('input'),
      values: [],
      onPick: vi.fn(),
      onOpen,
      onClose,
    });

    suggest.open();
    suggest.open();
    suggest.close();
    suggest.close();

    expect(onOpen).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('offers same-property values without enumerating unrelated vault notes', () => {
    const candidate: unknown = Object.assign(Object.create(TFile.prototype), {
      path: 'Projects/Quote "Plan".md',
      name: 'Quote "Plan".md',
      basename: 'Quote "Plan"',
      extension: 'md',
      parent: { path: 'Projects' },
    });
    if (!(candidate instanceof TFile)) throw new Error('Expected a test file');
    const file = candidate;
    const app = {
      vault: { getFiles: () => [file], getConfig: () => [] },
      metadataCache: { fileToLinktext: () => 'Projects/Quote "Plan"' },
    } as unknown as App;
    const input = document.body.createEl('input');
    const suggest = new ProjectPropertySuggest({
      app,
      input,
      values: ['P1', 'P2'],
      onPick: vi.fn(),
    });

    expect(suggest.getSuggestions('').map(({ value }) => value)).toEqual(['P1', 'P2']);
  });

  it('consumes keyboard selection before Enter reaches the containing editor', () => {
    const container = document.body.createDiv();
    const input = container.createEl('input');
    const picked = vi.fn();
    const commit = vi.fn();
    const suggest = new ProjectPropertySuggest({
      app: new App(),
      input,
      values: ['Beta'],
      onPick: picked,
    });
    container.addEventListener('keydown', commit);
    input.addEventListener(
      'keydown',
      (event) => {
        suggest.selectSuggestion(expectDefined(suggest.getSuggestions('Beta')[0]), event);
      },
      { once: true },
    );

    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(event);

    expect(picked).toHaveBeenCalledWith('Beta');
    expect(event.defaultPrevented).toBe(true);
    expect(commit).not.toHaveBeenCalled();
  });
});
