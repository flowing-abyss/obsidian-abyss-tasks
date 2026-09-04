import { Modal, setIcon, type App } from 'obsidian';
import { noInteractionOwnership, type InteractionOwnershipPort } from './interactionOwnership';

type TagState = 'checked' | 'partial' | 'removing' | 'unchecked';

export class TagPickerModal extends Modal {
  private readonly getTagColor: (tag: string) => string | undefined;
  private readonly currentTags: Set<string>;
  private readonly partialTags: Set<string>;
  private readonly onCommit: (toAdd: string[], toRemove: string[]) => void;
  private readonly interactionOwnership: InteractionOwnershipPort;
  private readonly pending = new Map<string, boolean>(); // true=add, false=remove
  private searchEl!: HTMLInputElement;
  private listEl!: HTMLElement;
  private allTags: string[] = [];
  private ownershipToken: { release(): void } | null = null;

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
    this.getTagColor = getTagColor;
    this.currentTags = currentTags;
    this.partialTags = partialTags;
    this.onCommit = onCommit;
    this.interactionOwnership = ownership ?? noInteractionOwnership;
    this.modalEl.addClass('abyss-tag-picker-modal');
    this.setTitle('Select tags');
  }

  override onOpen(): void {
    this.ownershipToken?.release();
    this.ownershipToken = this.interactionOwnership.acquire({ blocksShortcuts: true });
    const rawTags = Object.keys(
      (this.app.metadataCache as unknown as { getTags(): Record<string, number> }).getTags(),
    );
    this.allTags = rawTags
      .map((t) => (t.startsWith('#') ? t : `#${t}`))
      .sort((a, b) => {
        const [ac, bc] = [a.slice(1), b.slice(1)];
        const [ar, br] = [ac.split('/')[0] ?? '', bc.split('/')[0] ?? ''];
        if (ar !== br) return ar.localeCompare(br);
        return ac.localeCompare(bc);
      });

    const { contentEl } = this;
    contentEl.empty();

    this.searchEl = contentEl.createEl('input', {
      cls: 'abyss-tag-picker-search',
      attr: { type: 'text', placeholder: 'Search tags…' },
    });
    this.searchEl.addEventListener('input', () => {
      this.renderList(this.searchEl.value);
    });

    this.listEl = contentEl.createDiv({ cls: 'abyss-tag-picker-list' });
    this.renderList('');
    window.setTimeout(() => {
      this.searchEl.focus();
    }, 10);
  }

  private effectiveState(tag: string): TagState {
    if (this.pending.has(tag)) {
      if (this.pending.get(tag) ?? false) return 'checked';
      return this.partialTags.has(tag) ? 'removing' : 'unchecked';
    }
    if (this.currentTags.has(tag)) return 'checked';
    if (this.partialTags.has(tag)) return 'partial';
    return 'unchecked';
  }

  private toggle(tag: string): void {
    const state = this.effectiveState(tag);
    if (this.currentTags.has(tag)) {
      this.toggleCurrentTag(tag, state);
    } else if (this.partialTags.has(tag)) {
      this.togglePartialTag(tag, state);
    } else {
      if (state === 'unchecked') this.pending.set(tag, true);
      else this.pending.delete(tag);
    }
    this.renderList(this.searchEl.value, tag);
  }

  private toggleCurrentTag(tag: string, state: TagState): void {
    if (state === 'checked') this.pending.set(tag, false);
    else this.pending.delete(tag);
  }

  private togglePartialTag(tag: string, state: TagState): void {
    if (state === 'partial') this.pending.set(tag, true);
    else if (state === 'checked') this.pending.set(tag, false);
    else this.pending.delete(tag);
  }

  private renderList(query: string, focusTag?: string): void {
    this.listEl.empty();
    const q = query.toLowerCase().replace(/^#/, '');
    const filtered =
      q.length > 0
        ? this.allTags.filter((t) => t.slice(1).toLowerCase().includes(q))
        : this.allTags;

    for (const tag of filtered) {
      this.renderItem(tag);
    }

    if (filtered.length === 0) {
      this.listEl.createDiv({ cls: 'abyss-tag-picker-empty', text: 'No tags found' });
    }

    if (focusTag !== undefined && focusTag.length > 0) {
      const item = Array.from(this.listEl.querySelectorAll<HTMLButtonElement>('[data-tag]')).find(
        (button) => button.dataset['tag'] === focusTag,
      );
      item?.focus({ preventScroll: true });
    }
  }

  private renderItem(tag: string): void {
    const state = this.effectiveState(tag);
    let pressed = 'false';
    if (state === 'partial') pressed = 'mixed';
    else if (state === 'checked') pressed = 'true';
    const item = this.listEl.createEl('button', {
      cls: `abyss-tag-picker-item abyss-tag-picker-item--${state}`,
      attr: { type: 'button', 'data-tag': tag, 'aria-pressed': pressed },
    });

    const iconEl = item.createSpan({ cls: 'abyss-tag-picker-icon' });
    if (state === 'checked') setIcon(iconEl, 'check');
    else if (state === 'partial') setIcon(iconEl, 'minus');
    else if (state === 'removing') setIcon(iconEl, 'x');

    const labelEl = item.createSpan({ cls: 'abyss-tag-picker-label', text: tag });
    const color = this.getTagColor(tag);
    if (color !== undefined && color.length > 0) {
      labelEl.setCssProps({ '--abyss-tag-picker-color': color });
    }

    item.addEventListener('click', () => {
      this.toggle(tag);
    });
  }

  override onClose(): void {
    const ownershipToken = this.ownershipToken;
    this.ownershipToken = null;
    ownershipToken?.release();
    const toAdd = [...this.pending.entries()].filter(([, v]) => v).map(([k]) => k);
    const toRemove = [...this.pending.entries()].filter(([, v]) => !v).map(([k]) => k);
    if (toAdd.length > 0 || toRemove.length > 0) this.onCommit(toAdd, toRemove);
    this.contentEl.empty();
  }
}
