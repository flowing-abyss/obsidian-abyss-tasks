import { App, Notice, TFile } from 'obsidian';
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
  it('contains action clicks within the editor even when close removes it synchronously', () => {
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

    expectDefined(
      container.querySelector<HTMLButtonElement>('.abyss-project-editor-cancel'),
    ).click();

    expect(outside).not.toHaveBeenCalled();
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
    expect(onClose).toHaveBeenCalledWith('committed', { restoreFocus: true });
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
    expectDefined(container.querySelector<HTMLButtonElement>('.abyss-project-editor-save')).click();
    await settle();

    expect(save).toHaveBeenCalledWith([7, 'Alpha', 'Beta']);
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
    expect(onClose).toHaveBeenCalledWith('committed', { restoreFocus: true });
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

  it('uses configured status names, colors, and IDs', async () => {
    const container = document.body.createDiv();
    const save = vi.fn().mockResolvedValue(undefined);
    mountProjectCellEditor({
      app: new App(),
      container,
      field: { id: 'status', label: 'Status', type: 'status' },
      value: 'active',
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
    const done = expectDefined(select.querySelector<HTMLOptionElement>('option[value="done"]'));
    expect(done.textContent).toBe('Shipped');
    expect(done.style.color).toBe('rgb(101, 67, 33)');
    select.value = 'done';

    keydown(select, 'Enter');
    await settle();

    expect(save).toHaveBeenCalledWith('done');
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
    expect(onClose).toHaveBeenCalledWith('cancelled', { restoreFocus: true });
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
  it('offers existing values and escaped wiki-link targets through one suggester', () => {
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
    const picked = vi.fn();
    const suggest = new ProjectPropertySuggest({
      app,
      input,
      values: ['Alpha'],
      onPick: picked,
      includeNotes: true,
    });

    expect(suggest.getSuggestions('')).toMatchObject([
      { kind: 'value', value: 'Alpha' },
      { kind: 'note', value: '[[Projects/Quote "Plan"]]' },
    ]);
    suggest.selectSuggestion(expectDefined(suggest.getSuggestions('quote')[0]));
    expect(picked).toHaveBeenCalledWith('[[Projects/Quote "Plan"]]');
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
