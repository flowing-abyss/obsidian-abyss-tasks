import { Modal, setIcon, type App } from 'obsidian';

type TagState = 'checked' | 'partial' | 'removing' | 'unchecked';

export class TagPickerModal extends Modal {
  private readonly pending = new Map<string, boolean>(); // true=add, false=remove
  private searchEl!: HTMLInputElement;
  private listEl!: HTMLElement;
  private allTags: string[] = [];

  constructor(
    app: App,
    private readonly getTagColor: (tag: string) => string | undefined,
    private readonly currentTags: Set<string>, // tags ALL tasks have
    private readonly partialTags: Set<string>, // tags SOME tasks have (bulk only)
    private readonly onCommit: (toAdd: string[], toRemove: string[]) => void,
  ) {
    super(app);
    this.modalEl.addClass('abyss-tag-picker-modal');
    this.setTitle('Select tags');
  }

  onOpen(): void {
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
    this.searchEl.addEventListener('input', () => this.renderList(this.searchEl.value));

    this.listEl = contentEl.createDiv({ cls: 'abyss-tag-picker-list' });
    this.renderList('');
    window.setTimeout(() => this.searchEl.focus(), 10);
  }

  private effectiveState(tag: string): TagState {
    if (this.pending.has(tag)) {
      if (this.pending.get(tag)) return 'checked';
      return this.partialTags.has(tag) ? 'removing' : 'unchecked';
    }
    if (this.currentTags.has(tag)) return 'checked';
    if (this.partialTags.has(tag)) return 'partial';
    return 'unchecked';
  }

  private toggle(tag: string): void {
    const state = this.effectiveState(tag);
    if (this.currentTags.has(tag)) {
      // Originally fully checked: checked → unchecked(remove all) → checked(undo)
      if (state === 'checked') this.pending.set(tag, false);
      else this.pending.delete(tag);
    } else if (this.partialTags.has(tag)) {
      // Originally partial: partial → checked(add missing) → removing(remove partial) → partial(undo)
      if (state === 'partial') this.pending.set(tag, true);
      else if (state === 'checked') this.pending.set(tag, false);
      else this.pending.delete(tag);
    } else {
      // Originally unchecked: unchecked → checked(add all) → unchecked(undo)
      if (state === 'unchecked') this.pending.set(tag, true);
      else this.pending.delete(tag);
    }
    this.renderList(this.searchEl.value, tag);
  }

  private renderList(query: string, focusTag?: string): void {
    this.listEl.empty();
    const q = query.toLowerCase().replace(/^#/, '');
    const filtered = q
      ? this.allTags.filter((t) => t.slice(1).toLowerCase().includes(q))
      : this.allTags;

    for (const tag of filtered) {
      this.renderItem(tag);
    }

    if (filtered.length === 0) {
      this.listEl.createDiv({ cls: 'abyss-tag-picker-empty', text: 'No tags found' });
    }

    if (focusTag) {
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
    if (color) labelEl.setCssProps({ '--abyss-tag-picker-color': color });

    item.addEventListener('click', () => this.toggle(tag));
  }

  onClose(): void {
    const toAdd = [...this.pending.entries()].filter(([, v]) => v).map(([k]) => k);
    const toRemove = [...this.pending.entries()].filter(([, v]) => !v).map(([k]) => k);
    if (toAdd.length > 0 || toRemove.length > 0) this.onCommit(toAdd, toRemove);
    this.contentEl.empty();
  }
}
