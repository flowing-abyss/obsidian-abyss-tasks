export interface EntityPresentationOptions {
  readonly identity: string;
  readonly status?: string;
  readonly priority?: string | null;
  readonly progress?: string;
  readonly date?: string;
  readonly health?: string;
}

/** Shared semantic slots for Project cards and table identities. */
export class EntityPresentation {
  constructor(private readonly options: EntityPresentationOptions) {}

  render(parent: HTMLElement): HTMLElement {
    const root = parent.createDiv({ cls: 'abyss-entity-presentation' });
    root.createSpan({
      cls: 'abyss-entity-identity',
      text: this.options.identity,
      attr: { 'data-entity-slot': 'identity', title: this.options.identity },
    });
    this.slot(root, 'status', this.options.status);
    this.slot(root, 'priority', this.options.priority ?? undefined);
    this.slot(root, 'progress', this.options.progress);
    this.slot(root, 'date', this.options.date);
    this.slot(root, 'health', this.options.health);
    return root;
  }

  private slot(parent: HTMLElement, name: string, value: string | undefined): void {
    if (!value) return;
    parent.createSpan({
      cls: `abyss-entity-${name}`,
      text: value,
      attr: { 'data-entity-slot': name, title: value },
    });
  }
}
