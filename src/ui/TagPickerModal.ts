import { Modal, setIcon, type App } from 'obsidian';
import { noInteractionOwnership, type InteractionOwnershipPort } from './interactionOwnership';

type TagState = 'checked' | 'partial' | 'removing' | 'unchecked';
const TAG_STATE_ICONS: Partial<Record<TagState, string>> = {
  checked: 'check',
  partial: 'minus',
  removing: 'x',
};

function pressedState(state: TagState): string {
  if (state === 'partial') return 'mixed';
  return state === 'checked' ? 'true' : 'false';
}

export class TagPickerModal extends Modal {
  private readonly getTagColor_abyssPrivate: (tag: string) => string | undefined;
  private readonly currentTags_abyssPrivate: Set<string>;
  private readonly partialTags_abyssPrivate: Set<string>;
  private readonly candidates_abyssPrivate: readonly string[];
  private readonly onCommit_abyssPrivate: (toAdd: string[], toRemove: string[]) => void;
  private readonly interactionOwnership_abyssPrivate: InteractionOwnershipPort;
  private readonly pending_abyssPrivate = new Map<string, boolean>(); // true=add, false=remove
  private searchEl_abyssPrivate!: HTMLInputElement;
  private listEl_abyssPrivate!: HTMLElement;
  private allTags_abyssPrivate: string[] = [];
  private ownershipToken_abyssPrivate: { release(): void } | null = null;

  constructor(
    ...args: [
      App,
      (tag: string) => string | undefined,
      Set<string>,
      Set<string>,
      readonly string[],
      (toAdd: string[], toRemove: string[]) => void,
      InteractionOwnershipPort?,
    ]
  ) {
    const [app, getTagColor, currentTags, partialTags, candidates, onCommit, ownership] = args;
    super(app);
    this.getTagColor_abyssPrivate = getTagColor;
    this.currentTags_abyssPrivate = currentTags;
    this.partialTags_abyssPrivate = partialTags;
    this.candidates_abyssPrivate = candidates;
    this.onCommit_abyssPrivate = onCommit;
    this.interactionOwnership_abyssPrivate = ownership ?? noInteractionOwnership;
    this.modalEl.addClass('abyss-tag-picker-modal');
    this.setTitle('Select tags');
  }

  override onOpen(): void {
    this.ownershipToken_abyssPrivate?.release();
    this.ownershipToken_abyssPrivate = this.interactionOwnership_abyssPrivate.acquire({
      blocksShortcuts: true,
    });
    const selected = [...this.currentTags_abyssPrivate, ...this.partialTags_abyssPrivate];
    const selectedSet = new Set(selected);
    this.allTags_abyssPrivate = [
      ...selected,
      ...[...new Set(this.candidates_abyssPrivate)]
        .filter((tag) => !selectedSet.has(tag))
        .sort((a, b) => {
          const [ac, bc] = [a.slice(1), b.slice(1)];
          const [ar, br] = [ac.split('/')[0] ?? '', bc.split('/')[0] ?? ''];
          if (ar !== br) return ar.localeCompare(br);
          return ac.localeCompare(bc);
        }),
    ];

    const { contentEl } = this;
    contentEl.empty();

    this.searchEl_abyssPrivate = contentEl.createEl('input', {
      cls: 'abyss-tag-picker-search',
      attr: { type: 'text', placeholder: 'Search tags…' },
    });
    this.searchEl_abyssPrivate.addEventListener('input', () => {
      this.renderList_abyssPrivate(this.searchEl_abyssPrivate.value);
    });

    this.listEl_abyssPrivate = contentEl.createDiv({ cls: 'abyss-tag-picker-list' });
    this.renderList_abyssPrivate('');
    window.setTimeout(() => {
      this.searchEl_abyssPrivate.focus();
    }, 10);
  }

  private effectiveState_abyssPrivate(tag: string): TagState {
    if (this.pending_abyssPrivate.has(tag)) {
      if (this.pending_abyssPrivate.get(tag) ?? false) return 'checked';
      return this.partialTags_abyssPrivate.has(tag) ? 'removing' : 'unchecked';
    }
    if (this.currentTags_abyssPrivate.has(tag)) return 'checked';
    if (this.partialTags_abyssPrivate.has(tag)) return 'partial';
    return 'unchecked';
  }

  private toggle_abyssPrivate(tag: string): void {
    const state = this.effectiveState_abyssPrivate(tag);
    if (this.currentTags_abyssPrivate.has(tag)) {
      this.toggleCurrentTag_abyssPrivate(tag, state);
    } else if (this.partialTags_abyssPrivate.has(tag)) {
      this.togglePartialTag_abyssPrivate(tag, state);
    } else {
      if (state === 'unchecked') this.pending_abyssPrivate.set(tag, true);
      else this.pending_abyssPrivate.delete(tag);
    }
    this.renderList_abyssPrivate(this.searchEl_abyssPrivate.value, tag);
  }

  private removeFromAll_abyssPrivate(tag: string): void {
    this.pending_abyssPrivate.set(tag, false);
    this.renderList_abyssPrivate(this.searchEl_abyssPrivate.value, tag);
  }

  private toggleCurrentTag_abyssPrivate(tag: string, state: TagState): void {
    if (state === 'checked') this.pending_abyssPrivate.set(tag, false);
    else this.pending_abyssPrivate.delete(tag);
  }

  private togglePartialTag_abyssPrivate(tag: string, state: TagState): void {
    if (state === 'partial') this.pending_abyssPrivate.set(tag, true);
    else if (state === 'checked') this.pending_abyssPrivate.set(tag, false);
    else this.pending_abyssPrivate.delete(tag);
  }

  private renderList_abyssPrivate(query: string, focusTag?: string): void {
    this.listEl_abyssPrivate.empty();
    const filtered = this.filteredTags_abyssPrivate(query);
    const selected = filtered.filter(
      (tag) => this.currentTags_abyssPrivate.has(tag) || this.partialTags_abyssPrivate.has(tag),
    );
    this.renderSelected_abyssPrivate(selected);
    this.renderHierarchy_abyssPrivate(filtered.filter((tag) => !selected.includes(tag)));
    if (filtered.length === 0) {
      this.listEl_abyssPrivate.createDiv({ cls: 'abyss-tag-picker-empty', text: 'No tags found' });
    }
    this.focusTag_abyssPrivate(focusTag);
  }

  private filteredTags_abyssPrivate(query: string): readonly string[] {
    const normalized = query.toLowerCase().replace(/^#+/u, '');
    return normalized.length === 0
      ? this.allTags_abyssPrivate
      : this.allTags_abyssPrivate.filter((tag) => tag.slice(1).toLowerCase().includes(normalized));
  }

  private renderSelected_abyssPrivate(selected: readonly string[]): void {
    if (selected.length > 0) {
      this.listEl_abyssPrivate.createDiv({
        cls: 'abyss-tag-picker-section-label',
        text: 'Selected',
      });
      for (const tag of selected) this.renderItem_abyssPrivate(tag);
    }
  }

  private renderHierarchy_abyssPrivate(available: readonly string[]): void {
    const assignable = new Set(this.allTags_abyssPrivate);
    const renderedHeadings = new Set<string>();
    for (const tag of available) {
      const segments = tag.slice(1).split('/');
      for (let depth = 1; depth < segments.length; depth += 1) {
        const ancestor = `#${segments.slice(0, depth).join('/')}`;
        if (!assignable.has(ancestor) && !renderedHeadings.has(ancestor)) {
          renderedHeadings.add(ancestor);
          const heading = this.listEl_abyssPrivate.createDiv({
            cls: 'abyss-tag-picker-heading',
            text: ancestor,
            attr: { 'data-depth': String(depth - 1) },
          });
          heading.setCssProps({ '--abyss-tag-indent': `${(depth - 1) * 14}px` });
        }
      }
      this.renderItem_abyssPrivate(tag, segments.length - 1);
    }
  }

  private focusTag_abyssPrivate(focusTag: string | undefined): void {
    if (focusTag === undefined || focusTag.length === 0) return;
    const item = Array.from(
      this.listEl_abyssPrivate.querySelectorAll<HTMLButtonElement>('[data-tag]'),
    ).find((button) => button.dataset['tag'] === focusTag);
    item?.focus({ preventScroll: true });
  }

  private renderItem_abyssPrivate(tag: string, depth = 0): void {
    const state = this.effectiveState_abyssPrivate(tag);
    const row = this.listEl_abyssPrivate.createDiv({ cls: 'abyss-tag-picker-row' });
    const item = row.createEl('button', {
      cls: `abyss-tag-picker-item abyss-tag-picker-item--${state}`,
      attr: {
        type: 'button',
        'data-tag': tag,
        'data-depth': String(depth),
        'aria-pressed': pressedState(state),
      },
    });
    item.setCssProps({ '--abyss-tag-indent': `${depth * 14}px` });

    this.renderStateIcon_abyssPrivate(item, state);

    const labelEl = item.createSpan({ cls: 'abyss-tag-picker-label', text: tag });
    const color = this.getTagColor_abyssPrivate(tag);
    if (color !== undefined && color.length > 0) {
      labelEl.setCssProps({ '--abyss-tag-picker-color': color });
    }

    item.addEventListener('click', () => {
      this.toggle_abyssPrivate(tag);
    });
    if (this.currentTags_abyssPrivate.has(tag) || this.partialTags_abyssPrivate.has(tag))
      this.renderRemoveButton_abyssPrivate(row, tag);
  }

  private renderStateIcon_abyssPrivate(item: HTMLElement, state: TagState): void {
    const icon = item.createSpan({ cls: 'abyss-tag-picker-icon' });
    const iconName = TAG_STATE_ICONS[state];
    if (iconName !== undefined) setIcon(icon, iconName);
  }

  private renderRemoveButton_abyssPrivate(row: HTMLElement, tag: string): void {
    const remove = row.createEl('button', {
      cls: 'clickable-icon abyss-tag-picker-remove',
      attr: {
        type: 'button',
        'data-remove-tag': tag,
        'aria-label': `Remove ${tag} from all selected tasks`,
      },
    });
    setIcon(remove, 'x');
    remove.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.removeFromAll_abyssPrivate(tag);
    });
  }

  override onClose(): void {
    const ownershipToken = this.ownershipToken_abyssPrivate;
    this.ownershipToken_abyssPrivate = null;
    ownershipToken?.release();
    const toAdd = [...this.pending_abyssPrivate.entries()].filter(([, v]) => v).map(([k]) => k);
    const toRemove = [...this.pending_abyssPrivate.entries()].filter(([, v]) => !v).map(([k]) => k);
    if (toAdd.length > 0 || toRemove.length > 0) this.onCommit_abyssPrivate(toAdd, toRemove);
    this.contentEl.empty();
  }
}
