import { Modal, Setting, type App } from 'obsidian';

export interface TagGroupAppearanceResult {
  readonly name?: string;
  readonly color?: string | null;
}

export interface TagGroupAppearance {
  readonly name: string;
  readonly color?: string;
}

type AppearanceField = 'name' | 'color';

const COLOR_PICKER_FALLBACK = '#888888';

export class TagGroupAppearanceModal extends Modal {
  private name: string;
  private color: string | null;

  constructor(
    app: App,
    private readonly current: TagGroupAppearance,
    private readonly onSubmit: (result: TagGroupAppearanceResult) => void,
    private readonly initialField: AppearanceField = 'name',
  ) {
    super(app);
    this.name = current.name;
    this.color = current.color ?? null;
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('abyss-tag-group-appearance-modal');
    contentEl.createEl('h3', { text: 'Tag group appearance' });

    let nameInput!: HTMLInputElement;
    new Setting(contentEl).setName('Display name').addText((text) => {
      nameInput = text.inputEl;
      nameInput.setAttribute('type', 'text');
      text.setValue(this.name).onChange((value) => {
        this.name = value;
      });
      nameInput.addEventListener('input', () => {
        this.name = nameInput.value;
      });
    });

    let colorInput!: HTMLInputElement;
    new Setting(contentEl).setName('Color').addColorPicker((picker) => {
      picker.setValue(this.color ?? COLOR_PICKER_FALLBACK).onChange((value) => {
        this.color = value;
      });
      const renderedInput = contentEl.querySelector<HTMLInputElement>('input[type="color"]');
      if (renderedInput === null) throw new Error('Obsidian did not render the color input');
      colorInput = renderedInput;
      colorInput.addEventListener('input', () => {
        this.color = colorInput.value;
      });
    });

    const buttonRow = contentEl.createDiv({ cls: 'abyss-tag-group-appearance-buttons' });
    const resetButton = buttonRow.createEl('button', { text: 'Reset' });
    const cancelButton = buttonRow.createEl('button', { text: 'Cancel' });
    const saveButton = buttonRow.createEl('button', { text: 'Save', cls: 'mod-cta' });
    resetButton.addEventListener('click', () => {
      this.color = null;
      colorInput.value = COLOR_PICKER_FALLBACK;
    });
    cancelButton.addEventListener('click', () => {
      this.close();
    });
    saveButton.addEventListener('click', () => {
      const result: { name?: string; color?: string | null } = {};
      const name = this.name.trim();
      if (name !== this.current.name) result.name = name;
      if (this.color !== (this.current.color ?? null)) result.color = this.color;
      this.onSubmit(result);
      this.close();
    });

    const target = this.initialField === 'color' ? colorInput : nameInput;
    contentEl.ownerDocument.defaultView?.setTimeout(() => {
      target.focus();
    }, 0);
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
