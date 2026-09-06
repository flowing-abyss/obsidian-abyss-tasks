import { Modal, setIcon, type App } from 'obsidian';
import { noInteractionOwnership, type InteractionOwnershipPort } from './interactionOwnership';

type TagState = 'checked' | 'partial' | 'removing' | 'unchecked';

export class TagPickerModal extends Modal {
  private readonly getTagColor_abyssPrivate: (tag: string) => string | undefined;
  private readonly currentTags_abyssPrivate: Set<string>;
  private readonly partialTags_abyssPrivate: Set<string>;
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
      (toAdd: string[], toRemove: string[]) => void,
      InteractionOwnershipPort?,
    ]
  ) {
    const [app, getTagColor, currentTags, partialTags, onCommit, ownership] = args;
    super(app);
    this.getTagColor_abyssPrivate = getTagColor;
    this.currentTags_abyssPrivate = currentTags;
    this.partialTags_abyssPrivate = partialTags;
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
    const rawTags = Object.keys(
      (this.app.metadataCache as unknown as { getTags(): Record<string, number> }).getTags(),
    );
    this.allTags_abyssPrivate = rawTags
      .map((t) => (t.startsWith('#') ? t : `#${t}`))
      .sort((a, b) => {
        const [ac, bc] = [a.slice(1), b.slice(1)];
        const [ar, br] = [ac.split('/')[0] ?? '', bc.split('/')[0] ?? ''];
        if (ar !== br) return ar.localeCompare(br);
        return ac.localeCompare(bc);
      });

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
    const q = query.toLowerCase().replace(/^#/, '');
    const filtered =
      q.length > 0
        ? this.allTags_abyssPrivate.filter((t) => t.slice(1).toLowerCase().includes(q))
        : this.allTags_abyssPrivate;

    for (const tag of filtered) {
      this.renderItem_abyssPrivate(tag);
    }

    if (filtered.length === 0) {
      this.listEl_abyssPrivate.createDiv({ cls: 'abyss-tag-picker-empty', text: 'No tags found' });
    }

    if (focusTag !== undefined && focusTag.length > 0) {
      const item = Array.from(
        this.listEl_abyssPrivate.querySelectorAll<HTMLButtonElement>('[data-tag]'),
      ).find((button) => button.dataset['tag'] === focusTag);
      item?.focus({ preventScroll: true });
    }
  }

  private renderItem_abyssPrivate(tag: string): void {
    const state = this.effectiveState_abyssPrivate(tag);
    let pressed = 'false';
    if (state === 'partial') pressed = 'mixed';
    else if (state === 'checked') pressed = 'true';
    const item = this.listEl_abyssPrivate.createEl('button', {
      cls: `abyss-tag-picker-item abyss-tag-picker-item--${state}`,
      attr: { type: 'button', 'data-tag': tag, 'aria-pressed': pressed },
    });

    const iconEl = item.createSpan({ cls: 'abyss-tag-picker-icon' });
    if (state === 'checked') setIcon(iconEl, 'check');
    else if (state === 'partial') setIcon(iconEl, 'minus');
    else if (state === 'removing') setIcon(iconEl, 'x');

    const labelEl = item.createSpan({ cls: 'abyss-tag-picker-label', text: tag });
    const color = this.getTagColor_abyssPrivate(tag);
    if (color !== undefined && color.length > 0) {
      labelEl.setCssProps({ '--abyss-tag-picker-color': color });
    }

    item.addEventListener('click', () => {
      this.toggle_abyssPrivate(tag);
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
