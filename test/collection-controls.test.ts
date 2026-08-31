import { describe, expect, it } from 'vitest';
import { renderCollectionControls } from '../src/ui/collection/CollectionControls';
import { freshContainer } from './helpers';

function controlKinds(root: HTMLElement): string[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>('[data-collection-kind]'),
    (element) => element.dataset['collectionKind'] ?? '',
  );
}

describe('renderCollectionControls', () => {
  it('renders the one shared toolbar in semantic control order', () => {
    const root = freshContainer();
    renderCollectionControls(root, {
      query: '',
      searchLabel: 'Filter tasks',
      renderLeading: (host) => host.createDiv({ text: 'Status' }),
      renderLayout: (host) => host.createDiv({ attr: { 'data-collection-layout': '' } }),
      actions: [
        { kind: 'filter', label: 'Filter', icon: 'filter', onActivate: () => undefined },
        { kind: 'group', label: 'Group', icon: 'group', onActivate: () => undefined },
        { kind: 'sort', label: 'Sort', icon: 'arrow-up-down', onActivate: () => undefined },
        { kind: 'fields', label: 'Fields', icon: 'columns-3', onActivate: () => undefined },
      ],
      renderAdd: (host) => host.createEl('button', { text: 'New task' }),
      onQueryInput: () => undefined,
    });

    expect(root.querySelectorAll('[data-collection-controls]')).toHaveLength(1);
    expect(controlKinds(root)).toEqual([
      'scope-or-status',
      'layout',
      'filter',
      'group',
      'sort',
      'fields',
      'search',
      'add',
    ]);
    expect(root.textContent).not.toContain('Show');
    expect(root.textContent).not.toContain('Use as default');
  });
});
