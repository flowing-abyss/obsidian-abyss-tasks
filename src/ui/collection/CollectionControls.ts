import { setIcon } from 'obsidian';
import type { CollectionSchema } from './CollectionSchema';

type CollectionControlKind = 'filter' | 'group' | 'sort' | 'fields';

export interface CollectionControlAction {
  readonly kind: CollectionControlKind;
  readonly label: string;
  readonly icon: string;
  readonly className?: string;
  readonly active?: boolean;
  readonly onActivate: (event: MouseEvent) => void;
}

export interface CollectionControlsOptions {
  readonly query: string;
  readonly searchLabel: string;
  /** Collections without a working text-query capability omit the search slot. */
  readonly search?: boolean;
  readonly placeholder?: string;
  /** Adds the single collection toolbar landmark when this is the complete control surface. */
  readonly toolbarLabel?: string;
  readonly renderLeading?: (host: HTMLElement) => void;
  readonly renderLayout?: (host: HTMLElement) => void;
  /** Capabilities determine which shared action zones this collection exposes. */
  readonly schema?: CollectionSchema<unknown, unknown, unknown>;
  readonly actions?: readonly CollectionControlAction[];
  readonly renderActiveChips?: (host: HTMLElement) => void;
  readonly renderAdd?: (host: HTMLElement) => void;
  readonly onQueryInput: (value: string) => void;
}

export interface CollectionControlsHandle {
  readonly element: HTMLElement;
  readonly searchInput: HTMLInputElement | null;
}

function renderCollectionActions(
  host: HTMLElement,
  actions: readonly CollectionControlAction[],
): void {
  for (const action of actions) {
    const classes = ['abyss-collection-action', action.className, action.active ? 'is-active' : '']
      .filter(Boolean)
      .join(' ');
    const button = host.createEl('button', {
      cls: classes,
      attr: {
        type: 'button',
        title: action.label,
        'aria-label': action.label,
        [`data-collection-${action.kind}`]: '',
        'data-collection-kind': action.kind,
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
    attr: {
      'data-collection-controls': '',
      ...(options.toolbarLabel ? { role: 'toolbar', 'aria-label': options.toolbarLabel } : {}),
    },
  });
  if (options.renderLeading) {
    const leading = controls.createDiv({ attr: { 'data-collection-kind': 'scope-or-status' } });
    options.renderLeading(leading);
  }
  if (options.renderLayout) {
    const layout = controls.createDiv({ attr: { 'data-collection-kind': 'layout' } });
    options.renderLayout(layout);
  }
  const actions = (options.actions ?? []).filter((action) => {
    if (!options.schema) return true;
    if (action.kind === 'filter') return options.schema.filterActions.length > 0;
    if (action.kind === 'group') return options.schema.groupActions.length > 0;
    if (action.kind === 'sort') return options.schema.sortActions.length > 0;
    return options.schema.fields?.length !== 0;
  });
  for (const kind of ['filter', 'group', 'sort', 'fields'] as const) {
    renderCollectionActions(
      controls,
      actions.filter((action) => action.kind === kind),
    );
  }
  options.renderActiveChips?.(controls);
  const searchInput =
    options.search === false
      ? null
      : controls.createEl('input', {
          cls: 'abyss-center-search abyss-collection-search',
          attr: {
            type: 'text',
            placeholder: options.placeholder ?? 'Filter…',
            'aria-label': options.searchLabel,
            'data-collection-kind': 'search',
          },
        });
  if (searchInput) {
    searchInput.value = options.query;
    searchInput.addEventListener('input', () => options.onQueryInput(searchInput.value));
  }
  if (options.renderAdd) {
    const add = controls.createDiv({ attr: { 'data-collection-kind': 'add' } });
    options.renderAdd(add);
  }
  return { element: controls, searchInput };
}
