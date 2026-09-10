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
    const handle = mountProjectCellEditor({
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
    const internals = handle as unknown as {
      readonly control_abyssPrivate: { readonly suggest?: ProjectPropertySuggest };
    };
    const suggest = expectDefined(internals.control_abyssPrivate.suggest);

    expect(suggest.getSuggestions('').map(({ value }) => value)).toEqual([42, 7]);
    const preset = expectDefined(suggest.getSuggestions('').find(({ value }) => value === 42));
    expect(preset.label).toBe('Forty two');
    suggest.selectSuggestion(preset);
    await settle();

    expect(save).toHaveBeenCalledWith(42);
  });

  it('writes a finite existing number suggestion as a number and filters invalid values', async () => {
    const container = document.body.createDiv();
    const save = vi.fn().mockResolvedValue(undefined);
    const handle = mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:Custom', property: 'Custom', label: 'Budget', type: 'number' },
      value: '42',
      catalog: catalog(['7', 'nope', ''], 'number'),
      sourceField: 'property:Custom',
      save,
      onClose: vi.fn(),
    });
    const internals = handle as unknown as {
      readonly control_abyssPrivate: { readonly suggest?: ProjectPropertySuggest };
    };
    const suggest = expectDefined(internals.control_abyssPrivate.suggest);

    expect(suggest.getSuggestions('').map(({ value }) => value)).toEqual([7]);
    suggest.selectSuggestion(expectDefined(suggest.getSuggestions('7')[0]));
    await settle();

    expect(save).toHaveBeenCalledWith(7);
  });

  it('keeps raw identity when a preset display alias is selected', async () => {
    const container = document.body.createDiv();
    const save = vi.fn().mockResolvedValue(undefined);
    const handle = mountProjectCellEditor({
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
    const internals = handle as unknown as {
      readonly control_abyssPrivate: { readonly suggest?: ProjectPropertySuggest };
    };
    const suggest = expectDefined(internals.control_abyssPrivate.suggest);
    suggest.selectSuggestion(expectDefined(suggest.getSuggestions('Ready')[0]));
    await settle();

    expect(save).toHaveBeenCalledWith('raw-phase');
  });

  it('excludes a preset immediately after it is picked into a list', async () => {
    const container = document.body.createDiv();
    const handle = mountProjectCellEditor({
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
    const internals = handle as unknown as {
      readonly control_abyssPrivate: { readonly suggest?: ProjectPropertySuggest };
    };
    const suggest = expectDefined(internals.control_abyssPrivate.suggest);

    expect(suggest.getSuggestions('').map(({ value }) => value)).toEqual(['Mina']);
    suggest.selectSuggestion(expectDefined(suggest.getSuggestions('Mina')[0]));
    await settle();
    expect(suggest.getSuggestions('').map(({ value }) => value)).toEqual([]);
  });

  it('deduplicates and excludes tag suggestions by canonical tag identity', async () => {
    const container = document.body.createDiv();
    const save = vi.fn().mockResolvedValue(undefined);
    const handle = mountProjectCellEditor({
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
    const internals = handle as unknown as {
      readonly control_abyssPrivate: { readonly suggest?: ProjectPropertySuggest };
    };
    const suggest = expectDefined(internals.control_abyssPrivate.suggest);

    expect(suggest.getSuggestions('').map(({ value }) => value)).toEqual([
      'demo',
      '#preset-only',
      '#fresh',
    ]);
    suggest.selectSuggestion(expectDefined(suggest.getSuggestions('Demo')[0]));
    await settle();

    expect(save).toHaveBeenCalledWith(['qa-table', 'qa-nested/example', 'demo']);
    expect(suggest.getSuggestions('').map(({ value }) => value)).toEqual([
      '#preset-only',
      '#fresh',
    ]);
  });

  it('keeps hashtag and unprefixed values distinct for generic lists', () => {
    const container = document.body.createDiv();
    const handle = mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:Custom', property: 'Custom', label: 'Values', type: 'list' },
      value: [],
      catalog: catalog(['demo', '#demo'], 'list'),
      save: vi.fn().mockResolvedValue(undefined),
      onClose: vi.fn(),
    });
    const internals = handle as unknown as {
      readonly control_abyssPrivate: { readonly suggest?: ProjectPropertySuggest };
    };

    expect(
      expectDefined(internals.control_abyssPrivate.suggest)
        .getSuggestions('')
        .map(({ value }) => value),
    ).toEqual(['demo', '#demo']);
  });

  it('shows the configured label for an existing exact preset list value', () => {
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
          display: 'badge',
          color: '#123456',
        },
      ],
      sourceField: 'property:Custom',
      save: vi.fn().mockResolvedValue(undefined),
      onClose: vi.fn(),
    });

    const chip = expectDefined(container.querySelector<HTMLElement>('.abyss-project-list-value'));
    const presentation = expectDefined(
      chip.querySelector<HTMLElement>('.abyss-project-property-value'),
    );
    expect(chip.textContent).toContain('QA Anna');
    expect(chip.textContent).not.toContain('Anna]]');
    expect(presentation.hasClass('is-badge')).toBe(true);
    expect(presentation.hasClass('is-link')).toBe(true);
    expect(presentation.style.getPropertyValue('--abyss-project-property-color')).toBe('#123456');
  });

  it('keeps an explicitly selected list preset raw value exact', async () => {
    const container = document.body.createDiv();
    const save = vi.fn().mockResolvedValue(undefined);
    const handle = mountProjectCellEditor({
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
    const internals = handle as unknown as {
      readonly control_abyssPrivate: { readonly suggest?: ProjectPropertySuggest };
    };
    const suggest = expectDefined(internals.control_abyssPrivate.suggest);

    suggest.selectSuggestion(expectDefined(suggest.getSuggestions('Planned')[0]));
    await settle();

    expect(save).toHaveBeenCalledWith([' planned ']);
    expect(suggest.getSuggestions('').map(({ value }) => value)).toEqual([]);
  });

  it('restores details for colliding existing link labels after preset-first merging', () => {
    const container = document.body.createDiv();
    const handle = mountProjectCellEditor({
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
    const internals = handle as unknown as {
      readonly control_abyssPrivate: { readonly suggest?: ProjectPropertySuggest };
    };
    const suggestions = expectDefined(internals.control_abyssPrivate.suggest).getSuggestions('');

    expect(suggestions.map(({ value }) => value)).toEqual(['preset', '[[A/Plan]]', '[[B/Plan]]']);
    expect(suggestions.slice(1).map(({ detail }) => detail)).toEqual(['A/Plan', 'B/Plan']);
  });

  it('keeps a configured tag chip native instead of adding a generic preset badge', () => {
    const container = document.body.createDiv();
    mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:tags', property: 'tags', label: 'Tags', type: 'tags' },
      value: ['qa'],
      catalog: catalog([], 'tags'),
      presets: [{ value: 'qa', label: '#Quality', display: 'badge', color: '#123456' }],
      sourceField: 'tags',
      save: vi.fn().mockResolvedValue(undefined),
      onClose: vi.fn(),
    });

    const chip = expectDefined(
      container.querySelector<HTMLElement>('.abyss-project-list-value-text'),
    );
    expect(chip.textContent).toBe('#Quality');
    expect(chip.hasClass('tag')).toBe(true);
    expect(chip.hasClass('abyss-project-property-value')).toBe(false);
    expect(chip.hasClass('is-badge')).toBe(false);
    expect(chip.style.color).toBe('rgb(18, 52, 86)');
  });

  it('writes the exact raw link once when a readable scalar suggestion is selected', async () => {
    const container = document.body.createDiv();
    const save = vi.fn().mockResolvedValue(undefined);
    const handle = mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:Custom', property: 'Custom', label: 'Owner', type: 'text' },
      value: 'Infrastructure',
      catalog: catalog(['[[People/Anna Smith|Anna]]', '[Anna](People/Anna-Jones.md)']),
      save,
      onClose: vi.fn(),
    });
    const internals = handle as unknown as {
      readonly control_abyssPrivate: { readonly suggest?: ProjectPropertySuggest };
    };
    const suggest = expectDefined(internals.control_abyssPrivate.suggest);
    const picked = expectDefined(
      suggest
        .getSuggestions('Infrastructure')
        .find(({ value }) => value === '[Anna](People/Anna-Jones.md)'),
    );

    suggest.selectSuggestion(picked, new KeyboardEvent('keydown', { key: 'Enter' }));
    await settle();

    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith('[Anna](People/Anna-Jones.md)');
  });

  it('commits a pending list value with Enter without an Add control or coercion', async () => {
    const container = document.body.createDiv();
    const save = vi.fn().mockResolvedValue(undefined);
    mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:Custom', property: 'Custom', label: 'Owners', type: 'list' },
      value: [7, 'Alpha'],
      catalog: catalog(['Beta'], 'list'),
      save,
      onClose: vi.fn(),
    });
    const input = expectDefined(
      container.querySelector<HTMLInputElement>('.abyss-project-list-input'),
    );
    expect(container.querySelector('.abyss-project-list-add')).toBeNull();
    input.value = 'Beta';
    keydown(input, 'Enter');
    await settle();

    expect(save).toHaveBeenCalledWith([7, 'Alpha', 'Beta']);
    expect(input.isConnected).toBe(false);
  });

  it('keeps raw list links while showing readable chip labels in one entry band', async () => {
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

    const band = expectDefined(container.querySelector<HTMLElement>('.abyss-project-list-control'));
    const displayed = expectDefined(
      band.querySelector<HTMLElement>('.abyss-project-list-value-text'),
    );
    expect(displayed.textContent).toContain('Anna');
    expect(displayed.classList.contains('is-link')).toBe(true);
    expect(band.querySelector('.abyss-project-list-value')?.textContent).not.toContain(
      'People/Anna Smith',
    );
    expect(band.querySelector('.abyss-project-list-entry')).not.toBeNull();
    await expect(handle.commit()).resolves.toBe(true);
    expect(save).not.toHaveBeenCalled();
  });

  it('excludes selected equivalent links and restores them after removal', () => {
    const container = document.body.createDiv();
    const app = new App();
    vi.spyOn(app.metadataCache, 'getFirstLinkpathDest').mockImplementation((target) => {
      if (target === 'People/Anna Smith' || target === 'People/Anna Smith.md') {
        const candidate: unknown = Object.assign(Object.create(TFile.prototype), {
          path: 'People/Anna Smith.md',
        });
        return candidate instanceof TFile ? candidate : null;
      }
      if (target === 'Partners/Anna') {
        const candidate: unknown = Object.assign(Object.create(TFile.prototype), {
          path: 'Partners/Anna.md',
        });
        return candidate instanceof TFile ? candidate : null;
      }
      return null;
    });
    const handle = mountProjectCellEditor({
      app,
      container,
      field: { id: 'property:Custom', property: 'Custom', label: 'Owners', type: 'list' },
      value: ['[[People/Anna Smith|Anna]]'],
      catalog: catalog(
        ['[[People/Anna Smith|Anna]]', '[Anna](People/Anna%20Smith.md)', '[[Partners/Anna|Anna]]'],
        'list',
      ),
      sourcePath: 'Projects/Current.md',
      save: vi.fn().mockResolvedValue(undefined),
      onClose: vi.fn(),
    });
    const internals = handle as unknown as {
      readonly control_abyssPrivate: { readonly suggest?: ProjectPropertySuggest };
    };
    const suggest = expectDefined(internals.control_abyssPrivate.suggest);

    expect(suggest.getSuggestions('').map(({ value }) => value)).toEqual([
      '[[Partners/Anna|Anna]]',
    ]);
    expectDefined(container.querySelector<HTMLButtonElement>('[aria-label="Remove Anna"]')).click();
    expect(suggest.getSuggestions('').map(({ value }) => value)).toEqual([
      '[[People/Anna Smith|Anna]]',
      '[Anna](People/Anna%20Smith.md)',
      '[[Partners/Anna|Anna]]',
    ]);
  });

  it('uses native tag styling without a generic outer chip background', () => {
    const container = document.body.createDiv();
    mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:tags', property: 'tags', label: 'Tags', type: 'tags' },
      value: ['work'],
      catalog: catalog([], 'tags'),
      save: vi.fn().mockResolvedValue(undefined),
      onClose: vi.fn(),
    });

    const item = expectDefined(container.querySelector<HTMLElement>('.abyss-project-list-value'));
    expect(item.classList.contains('is-tag')).toBe(true);
    expect(item.querySelector('.tag')?.textContent).toBe('#work');
  });

  it('keeps an editor-owned list removal alive through transient blur', async () => {
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
    const input = expectDefined(
      container.querySelector<HTMLInputElement>('.abyss-project-list-input'),
    );
    const remove = expectDefined(
      container.querySelector<HTMLButtonElement>('[aria-label="Remove Celia"]'),
    );

    remove.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    input.dispatchEvent(
      new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }),
    );
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    remove.dispatchEvent(
      new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }),
    );
    remove.click();
    await settle();

    expect(save).toHaveBeenCalledWith(['Mina']);
  });

  it('closes after a committed list addition when focus then leaves the editor', async () => {
    const container = document.body.createDiv();
    const save = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn();
    const handle = mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:Custom', property: 'Custom', label: 'Owners', type: 'list' },
      value: ['Celia'],
      catalog: catalog(['Mina'], 'list'),
      save,
      onClose: close,
    });
    const input = expectDefined(
      container.querySelector<HTMLInputElement>('.abyss-project-list-input'),
    );
    const internals = handle as unknown as {
      readonly control_abyssPrivate: { readonly suggest?: ProjectPropertySuggest };
    };
    const suggest = expectDefined(internals.control_abyssPrivate.suggest);
    suggest.selectSuggestion(
      expectDefined(suggest.getSuggestions('Mina').find(({ value }) => value === 'Mina')),
      new KeyboardEvent('keydown', { key: 'Enter' }),
    );
    await settle();
    input.dispatchEvent(
      new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }),
    );
    await settle();

    expect(save).toHaveBeenCalledWith(['Celia', 'Mina']);
    expect(close).toHaveBeenCalledWith('committed', {
      navigation: 'preserve-focus',
      focusTarget: document.body,
    });
  });

  it('closes in one Escape while suggestions are open and retains committed chips', async () => {
    const scopeRegister = vi.spyOn(Scope.prototype, 'register');
    const container = document.body.createDiv();
    const save = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn();
    const handle = mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:Custom', property: 'Custom', label: 'Owners', type: 'list' },
      value: ['Celia'],
      catalog: catalog(['Mina'], 'list'),
      save,
      onClose: close,
    });
    const input = expectDefined(
      container.querySelector<HTMLInputElement>('.abyss-project-list-input'),
    );
    const internals = handle as unknown as {
      readonly control_abyssPrivate: { readonly suggest?: ProjectPropertySuggest };
    };
    const suggest = expectDefined(internals.control_abyssPrivate.suggest);
    suggest.selectSuggestion(
      expectDefined(suggest.getSuggestions('Mina').find(({ value }) => value === 'Mina')),
      new KeyboardEvent('keydown', { key: 'Enter' }),
    );
    await settle();
    suggest.open();
    input.value = 'Anna';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    const escapeHandler = expectDefined(
      scopeRegister.mock.calls.find(([, key]) => key === 'Escape')?.[2],
    );
    const escape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });

    escapeHandler(escape, { vkey: 'Escape', key: 'Escape', modifiers: null });

    expect(escape.defaultPrevented).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(['Celia', 'Mina']);
    expect(save).not.toHaveBeenCalledWith(['Celia', 'Mina', 'Anna']);
  });

  it('does not close solely because a suggester closes during a transient focus gap', async () => {
    const container = document.body.createDiv();
    const handle = mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:Custom', property: 'Custom', label: 'Owners', type: 'list' },
      value: ['Celia'],
      catalog: catalog([], 'list'),
      save: vi.fn().mockResolvedValue(undefined),
      onClose: vi.fn(),
    });
    const input = expectDefined(
      container.querySelector<HTMLInputElement>('.abyss-project-list-input'),
    );
    const internals = handle as unknown as {
      readonly control_abyssPrivate: { readonly suggest?: ProjectPropertySuggest };
    };
    const suggest = expectDefined(internals.control_abyssPrivate.suggest);
    const outside = document.body.createEl('button');
    input.addEventListener(
      'focusout',
      (event) => {
        event.stopImmediatePropagation();
      },
      {
        capture: true,
        once: true,
      },
    );

    suggest.open();
    outside.focus();
    suggest.close();
    await settle();

    expect(input.isConnected).toBe(true);
  });

  it('commits a pending freeform list value with ordinary Enter', async () => {
    const container = document.body.createDiv();
    const save = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'property:Custom', property: 'Custom', label: 'Owners', type: 'list' },
      value: ['Alpha'],
      catalog: catalog([], 'list'),
      save,
      onClose,
    });
    const input = expectDefined(
      container.querySelector<HTMLInputElement>('.abyss-project-list-input'),
    );
    input.value = 'Beta';

    keydown(input, 'Enter');
    await settle();

    expect(save).toHaveBeenCalledWith(['Alpha', 'Beta']);
    expect(onClose).toHaveBeenCalledWith('committed', { navigation: 'restore-current' });
  });

  it('commits a pending freeform list value on blur and discards it on Escape', async () => {
    const blurContainer = document.body.createDiv();
    const blurSave = vi.fn().mockResolvedValue(undefined);
    mountProjectCellEditor({
      app: new App(),
      container: blurContainer,
      field: { id: 'property:Custom', property: 'Custom', label: 'Owners', type: 'list' },
      value: ['Alpha'],
      catalog: catalog([], 'list'),
      save: blurSave,
      onClose: vi.fn(),
    });
    const blurInput = expectDefined(
      blurContainer.querySelector<HTMLInputElement>('.abyss-project-list-input'),
    );
    blurInput.value = 'Beta';
    blurInput.dispatchEvent(
      new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }),
    );
    await settle();
    expect(blurSave).toHaveBeenCalledWith(['Alpha', 'Beta']);

    const escapeContainer = document.body.createDiv();
    const escapeSave = vi.fn().mockResolvedValue(undefined);
    mountProjectCellEditor({
      app: new App(),
      container: escapeContainer,
      field: { id: 'property:Custom', property: 'Custom', label: 'Owners', type: 'list' },
      value: ['Alpha'],
      catalog: catalog([], 'list'),
      save: escapeSave,
      onClose: vi.fn(),
    });
    const escapeInput = expectDefined(
      escapeContainer.querySelector<HTMLInputElement>('.abyss-project-list-input'),
    );
    escapeInput.value = 'Beta';
    keydown(escapeInput, 'Escape');
    await settle();
    expect(escapeSave).not.toHaveBeenCalled();
  });

  it.each([
    ['checkbox', 'input[type="checkbox"]', true, true],
    ['date', 'input[type="date"]', '2026-09-12', '2026-09-12'],
    ['datetime', 'input[type="datetime-local"]', '2026-09-12T14:30', '2026-09-12T14:30'],
    ['tags', '.abyss-project-list-input', '#launch', ['#launch']],
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
    const handle = mountProjectCellEditor({
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
          onLeftPanel: false,
        },
      ],
      save,
      onClose: vi.fn(),
    });
    const input = expectDefined(container.querySelector<HTMLInputElement>('input'));
    expect(input.value).toBe('Waiting on vendor');
    handle.focus();
    const internals = handle as unknown as {
      readonly control_abyssPrivate: { readonly suggest?: ProjectPropertySuggest };
    };
    const suggest = expectDefined(internals.control_abyssPrivate.suggest);
    expect((suggest as unknown as { readonly isOpen: boolean }).isOpen).toBe(true);
    expect(suggest.getSuggestions('').map(({ label }) => label)).toEqual([
      'No status',
      'Waiting on vendor',
      'In flight',
      'Shipped',
    ]);
    const shipped = expectDefined(
      suggest.getSuggestions('').find(({ value }) => value === 'Shipped'),
    );
    const rendered = document.body.createDiv();
    suggest.renderSuggestion(shipped, rendered);
    expect(rendered.querySelector<HTMLElement>('.abyss-suggest-status')?.style.color).toBe(
      'rgb(101, 67, 33)',
    );
    suggest.selectSuggestion(shipped, new KeyboardEvent('keydown', { key: 'Enter' }));
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
        display: 'badge',
        color: '#123456',
      },
      rendered,
    );

    const title = expectDefined(rendered.querySelector<HTMLElement>('.abyss-suggest-title'));
    const tag = expectDefined(title.querySelector<HTMLElement>('.tag'));
    expect(title.classList.contains('abyss-project-preset-suggestion')).toBe(false);
    expect(title.style.getPropertyValue('--abyss-project-property-color')).toBe('');
    expect(tag.style.getPropertyValue('--abyss-project-property-color')).toBe('#123456');
    expect(tag.style.color).toBe('rgb(18, 52, 86)');
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
