import { setIcon } from 'obsidian';

type CollectionControlKind = 'filter' | 'group' | 'sort';

export interface CollectionControlAction {
  readonly kind: CollectionControlKind;
  readonly label: string;
  readonly icon: string;
  readonly active?: boolean;
  readonly onActivate: (event: MouseEvent) => void;
}

export interface CollectionControlsOptions {
  readonly query: string;
  readonly searchLabel: string;
  readonly placeholder?: string;
  readonly renderLeading?: (host: HTMLElement) => void;
  readonly actions?: readonly CollectionControlAction[];
  readonly onQueryInput: (value: string) => void;
}

export interface CollectionControlsHandle {
  readonly element: HTMLElement;
  readonly searchInput: HTMLInputElement;
}

export function renderCollectionActions(
  host: HTMLElement,
  actions: readonly CollectionControlAction[],
): void {
  for (const action of actions) {
    const button = host.createEl('button', {
      cls: `abyss-collection-action${action.active ? ' is-active' : ''}`,
      attr: {
        type: 'button',
        title: action.label,
        'aria-label': action.label,
        [`data-collection-${action.kind}`]: '',
      },
    });
    setIcon(button, action.icon);
    button.createSpan({ cls: 'abyss-collection-action-label', text: action.label });
    button.addEventListener('click', action.onActivate);
  }
}

/** Shared Obsidian-native shell for collection chips/actions and the canonical text filter. */
export function renderCollectionControls(
  parent: HTMLElement,
  options: CollectionControlsOptions,
): CollectionControlsHandle {
  const controls = parent.createDiv({
    cls: 'abyss-center-controls abyss-collection-controls',
    attr: { 'data-collection-controls': '' },
  });
  options.renderLeading?.(controls);
  renderCollectionActions(controls, options.actions ?? []);
  const searchInput = controls.createEl('input', {
    cls: 'abyss-center-search abyss-collection-search',
    attr: {
      type: 'text',
      placeholder: options.placeholder ?? 'Filter…',
      'aria-label': options.searchLabel,
    },
  });
  searchInput.value = options.query;
  searchInput.addEventListener('input', () => options.onQueryInput(searchInput.value));
  return { element: controls, searchInput };
}
