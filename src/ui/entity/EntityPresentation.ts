import { setIcon } from 'obsidian';

interface EntityPresentationAction {
  readonly label: string;
  readonly icon: string;
  readonly onClick: (event: MouseEvent) => void;
}

type EntityPresentationSlot =
  | 'identity'
  | 'status'
  | 'priority'
  | 'progress'
  | 'date'
  | 'health'
  | 'relations'
  | 'secondary'
  | 'actions';

export type EntityPresentationTargets = Partial<Record<EntityPresentationSlot, HTMLElement>>;

export interface EntityPresentationOptions {
  readonly identity?: string;
  readonly status?: string;
  readonly priority?: string | null;
  readonly progress?: string;
  readonly date?: string;
  readonly health?: string;
  readonly relations?: string;
  readonly secondary?: string;
  readonly actions?: readonly EntityPresentationAction[];
}

/** Shared semantic slots for Project cards and table identities. */
export class EntityPresentation {
  constructor(private readonly options: EntityPresentationOptions) {}

  render(parent: HTMLElement, targets: EntityPresentationTargets = {}): HTMLElement {
    const root = parent.createDiv({ cls: 'abyss-entity-presentation' });
    if (this.options.identity) {
      (targets.identity ?? root).createSpan({
        cls: 'abyss-entity-identity',
        text: this.options.identity,
        attr: { 'data-entity-slot': 'identity', title: this.options.identity },
      });
    }
    this.slot(targets.status ?? root, 'status', this.options.status);
    this.slot(targets.priority ?? root, 'priority', this.options.priority ?? undefined);
    this.slot(targets.progress ?? root, 'progress', this.options.progress);
    this.slot(targets.date ?? root, 'date', this.options.date);
    this.slot(targets.health ?? root, 'health', this.options.health);
    this.slot(targets.relations ?? root, 'relations', this.options.relations);
    this.slot(targets.secondary ?? root, 'secondary', this.options.secondary);
    this.renderActions(targets.actions ?? root);
    return root;
  }

  renderActions(parent: HTMLElement): void {
    if (!this.options.actions?.length) return;
    const actions =
      parent.dataset['entitySlot'] === 'actions'
        ? parent
        : parent.createDiv({
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

  /** Applies the same semantic slot contract when a host owns an interactive card's markup. */
  bind(targets: EntityPresentationTargets): void {
    const values: Readonly<Record<Exclude<EntityPresentationSlot, 'actions'>, string | undefined>> =
      {
        identity: this.options.identity,
        status: this.options.status,
        priority: this.options.priority ?? undefined,
        progress: this.options.progress,
        date: this.options.date,
        health: this.options.health,
        relations: this.options.relations,
        secondary: this.options.secondary,
      };
    for (const [slot, value] of Object.entries(values)) {
      const target = targets[slot as Exclude<EntityPresentationSlot, 'actions'>];
      if (!target || !value) continue;
      target.dataset['entitySlot'] = slot;
      target.title ||= value;
    }
    if (targets.actions && this.options.actions?.length)
      targets.actions.dataset['entitySlot'] = 'actions';
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
