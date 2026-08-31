import { setIcon } from 'obsidian';

interface EntityPresentationAction {
  readonly label: string;
  readonly icon: string;
  readonly onClick: (event: MouseEvent) => void;
}

export interface EntityPresentationOptions {
  readonly identity?: string;
  readonly status?: string;
  readonly priority?: string | null;
  readonly progress?: string;
  readonly date?: string;
  readonly health?: string;
  readonly actions?: readonly EntityPresentationAction[];
}

/** Shared semantic slots for Project cards and table identities. */
export class EntityPresentation {
  constructor(private readonly options: EntityPresentationOptions) {}

  render(parent: HTMLElement): HTMLElement {
    const root = parent.createDiv({ cls: 'abyss-entity-presentation' });
    if (this.options.identity) {
      root.createSpan({
        cls: 'abyss-entity-identity',
        text: this.options.identity,
        attr: { 'data-entity-slot': 'identity', title: this.options.identity },
      });
    }
    this.slot(root, 'status', this.options.status);
    this.slot(root, 'priority', this.options.priority ?? undefined);
    this.slot(root, 'progress', this.options.progress);
    this.slot(root, 'date', this.options.date);
    this.slot(root, 'health', this.options.health);
    this.renderActions(root);
    return root;
  }

  renderActions(parent: HTMLElement): void {
    if (!this.options.actions?.length) return;
    const actions = parent.createDiv({
      cls: 'abyss-entity-actions',
      attr: { 'data-entity-slot': 'actions' },
    });
    for (const action of this.options.actions) {
      const button = actions.createEl('button', {
        cls: 'abyss-project-overflow-btn',
        attr: { type: 'button', 'aria-label': action.label, title: action.label },
      });
      setIcon(button, action.icon);
      button.addEventListener('click', action.onClick);
    }
  }

  private slot(parent: HTMLElement, name: string, value: string | undefined): void {
    if (!value) return;
    parent.createSpan({
      cls: `abyss-entity-${name}${name === 'priority' ? ' abyss-project-priority' : ''}`,
      text: value,
      attr: {
        'data-entity-slot': name,
        title: value,
        ...(name === 'priority'
          ? { 'data-priority': value, 'aria-label': `Priority ${value}` }
          : {}),
      },
    });
  }
}
