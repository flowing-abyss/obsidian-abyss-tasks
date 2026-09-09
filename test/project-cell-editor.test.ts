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

  it('adds and removes list values without coercing untouched numeric elements', async () => {
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
    input.value = 'Beta';
    expectDefined(container.querySelector<HTMLButtonElement>('.abyss-project-list-add')).click();
    await settle();

    expect(save).toHaveBeenCalledWith([7, 'Alpha', 'Beta']);
    expect(input.isConnected).toBe(true);
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
    mountProjectCellEditor({
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
    input.value = 'Mina';
    expectDefined(container.querySelector<HTMLButtonElement>('.abyss-project-list-add')).click();
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
    input.value = 'Mina';
    expectDefined(container.querySelector<HTMLButtonElement>('.abyss-project-list-add')).click();
    await settle();
    const internals = handle as unknown as {
      readonly control_abyssPrivate: { readonly suggest?: ProjectPropertySuggest };
    };
    expectDefined(internals.control_abyssPrivate.suggest).open();
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

  it('uses and saves literal configured status names while preserving an unknown value', async () => {
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
          onLeftPanel: false,
        },
      ],
      save,
      onClose: vi.fn(),
    });
    const select = expectDefined(container.querySelector<HTMLSelectElement>('select'));
    const done = expectDefined(select.querySelector<HTMLOptionElement>('option[value="Shipped"]'));
    expect(done.textContent).toBe('Shipped');
    expect(done.style.color).toBe('rgb(101, 67, 33)');
    expect(select.value).toBe('Waiting on vendor');
    select.value = 'Shipped';
    select.dispatchEvent(new Event('change', { bubbles: true }));
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

  it('blocks a stale custom editor when Obsidian changes the assigned type', async () => {
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

    expect(save).not.toHaveBeenCalled();
    expect(input.isConnected).toBe(true);
    expect(input.value).toBe('unfinished');
    expect(container.querySelector('.abyss-project-editor-error')?.textContent).toContain(
      'type changed',
    );
  });
});

describe('ProjectPropertySuggest', () => {
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
