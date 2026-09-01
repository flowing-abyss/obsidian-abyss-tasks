import { setIcon } from 'obsidian';

export type EntityPresentationSlotName =
  | 'identity'
  | 'status'
  | 'priority'
  | 'progress'
  | 'date'
  | 'health'
  | 'relations'
  | 'secondary';

export interface EntityPresentationSlot {
  readonly value: string;
  readonly text?: string;
  readonly element?: 'span' | 'div' | 'button';
  readonly className?: string;
  readonly attributes?: Readonly<Record<string, string>>;
  readonly onClick?: (event: MouseEvent) => void;
  readonly onKeydown?: (event: KeyboardEvent) => void;
  readonly onFocus?: () => void;
  readonly content?: (slot: HTMLElement) => void;
}

interface EntityPresentationAction {
  readonly label: string;
  readonly icon: string;
  readonly onClick: (event: MouseEvent) => void;
}

type EntityPresentationSlotValue = string | EntityPresentationSlot;

type EntityPresentationLayout =
  | 'inline'
  | 'board-card'
  | 'project-row-two-line'
  | 'project-row-single-line';

export interface EntityPresentationOptions {
  readonly identity?: EntityPresentationSlotValue;
  readonly status?: EntityPresentationSlotValue;
  readonly priority?: EntityPresentationSlotValue | null;
  readonly progress?: EntityPresentationSlotValue;
  readonly date?: EntityPresentationSlotValue;
  readonly health?: EntityPresentationSlotValue;
  readonly relations?: EntityPresentationSlotValue;
  readonly secondary?: EntityPresentationSlotValue;
  readonly actions?: readonly EntityPresentationAction[];
  readonly className?: string;
  /** Context-specific layout for a presentation that owns the two rows of a Project card. */
  readonly layout?: EntityPresentationLayout;
  readonly actionsClassName?: string;
  readonly primarySlots?: readonly EntityPresentationSlotName[];
  readonly secondarySlots?: readonly EntityPresentationSlotName[];
  readonly primaryClassName?: string;
  readonly secondaryClassName?: string;
}

const SLOT_ORDER: readonly EntityPresentationSlotName[] = [
  'identity',
  'status',
  'priority',
  'progress',
  'date',
  'health',
  'relations',
  'secondary',
];

export interface EntityPresentationRenderOptions {
  readonly actionsParent?: HTMLElement;
}

/** Shared owner of concrete Project card and Table semantic slot DOM. */
export class EntityPresentation {
  constructor(private readonly options: EntityPresentationOptions) {}

  render(parent: HTMLElement, options: EntityPresentationRenderOptions = {}): HTMLElement {
    const root = parent.createDiv({
      cls: [
        'abyss-entity-presentation',
        this.options.layout === 'project-row-two-line' ||
        this.options.layout === 'project-row-single-line'
          ? 'abyss-entity-presentation--project-row'
          : '',
        this.options.layout === 'project-row-two-line'
          ? 'abyss-entity-presentation--project-row-two-line'
          : '',
        this.options.layout === 'project-row-single-line'
          ? 'abyss-entity-presentation--project-row-single-line'
          : '',
        this.options.layout === 'board-card' ? 'abyss-entity-presentation--board-card' : '',
        this.options.className,
      ]
        .filter(Boolean)
        .join(' '),
    });
    const grouped = new Set([
      ...(this.options.primarySlots ?? []),
      ...(this.options.secondarySlots ?? []),
    ]);
    if (this.options.primarySlots) {
      const primary = root.createDiv({ cls: this.options.primaryClassName ?? '' });
      for (const name of this.options.primarySlots) this.renderSlot(primary, name);
    }
    if (this.options.secondarySlots?.some((name) => this.options[name] !== undefined) === true) {
      const secondary = root.createDiv({ cls: this.options.secondaryClassName ?? '' });
      for (const name of this.options.secondarySlots) this.renderSlot(secondary, name);
    }
    for (const name of SLOT_ORDER) {
      if (!grouped.has(name)) this.renderSlot(root, name);
    }
    this.renderActions(options.actionsParent ?? root);
    return root;
  }

  /** Projects a renderer-owned slot into a Table cell without duplicating its markup contract. */
  renderSlot(parent: HTMLElement, name: EntityPresentationSlotName): HTMLElement | undefined {
    const raw = this.options[name];
    if (!raw) return undefined;
    const slot = typeof raw === 'string' ? { value: raw } : raw;
    const element = parent.createEl(slot.element ?? 'span', {
      cls: [
        `abyss-entity-${name}`,
        name === 'priority' ? 'abyss-project-priority' : '',
        slot.className,
      ]
        .filter(Boolean)
        .join(' '),
      text: slot.text ?? slot.value,
      attr: {
        'data-entity-slot': name,
        title: slot.value,
        ...(name === 'priority'
          ? { 'data-priority': slot.value, 'aria-label': `Priority ${slot.value}` }
          : {}),
        ...slot.attributes,
      },
    });
    slot.content?.(element);
    if (slot.onClick)
      element.addEventListener('click', (event) => slot.onClick?.(event as MouseEvent));
    if (slot.onKeydown)
      element.addEventListener('keydown', (event) => slot.onKeydown?.(event as KeyboardEvent));
    if (slot.onFocus) element.addEventListener('focus', slot.onFocus);
    return element;
  }

  renderActions(parent: HTMLElement): void {
    if (!this.options.actions?.length) return;
    const actions = parent.createDiv({
      cls: ['abyss-entity-actions', this.options.actionsClassName].filter(Boolean).join(' '),
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
}
