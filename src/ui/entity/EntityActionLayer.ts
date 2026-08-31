import { setIcon } from 'obsidian';

export interface EntityActionLayerAction {
  readonly className: string;
  readonly label: string;
  readonly icon: string;
  readonly onActivate: (event: MouseEvent) => void;
}

/**
 * Places secondary row actions above entity content so revealing them cannot
 * create a permanent flex/grid slot or move the entity identity.
 */
export function renderEntityActionLayer(
  parent: HTMLElement,
  action: EntityActionLayerAction,
): HTMLButtonElement {
  const layer = parent.createDiv({ cls: 'abyss-entity-action-layer' });
  const button = layer.createEl('button', {
    cls: action.className,
    attr: { type: 'button', title: action.label, 'aria-label': action.label },
  });
  setIcon(button, action.icon);
  button.addEventListener('click', action.onActivate);
  return button;
}
