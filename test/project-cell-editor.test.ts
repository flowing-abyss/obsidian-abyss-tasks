import { App, Notice, TFile } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import {
  mountProjectCellEditor,
  type ProjectCellEditorResult,
} from '../src/panels/projects/ProjectCellEditor';
import type { ProjectPropertyCatalog } from '../src/projects/ObsidianProjectProperties';
import { ProjectPropertySuggest } from '../src/ui/ProjectPropertySuggest';
import { expectDefined } from './helpers';

function catalog(
  values: readonly string[] = [],
  type: 'text' | 'list' | 'number' | null = 'text',
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
    expect(onClose).toHaveBeenCalledWith('committed');
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
    expect(onClose).toHaveBeenCalledWith('cancelled');
  });

  it('retains the draft and reports one boundary error when saving rejects', async () => {
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
});
