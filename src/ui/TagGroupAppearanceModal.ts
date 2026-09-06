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
  private name_abyssPrivate: string;
  private color_abyssPrivate: string | null;

  constructor(
    app: App,
    private readonly current_abyssPrivate: TagGroupAppearance,
    private readonly onSubmit_abyssPrivate: (result: TagGroupAppearanceResult) => void,
    private readonly initialField_abyssPrivate: AppearanceField = 'name',
  ) {
    super(app);
    this.name_abyssPrivate = current_abyssPrivate.name;
    this.color_abyssPrivate = current_abyssPrivate.color ?? null;
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('abyss-tag-group-appearance-modal');
    contentEl.createEl('h3', { text: 'Tag group appearance' });

    let nameInput!: HTMLInputElement;
    new Setting(contentEl).setName('Display name').addText((text) => {
      nameInput = text.inputEl;
      nameInput.setAttribute('type', 'text');
      text.setValue(this.name_abyssPrivate).onChange((value) => {
        this.name_abyssPrivate = value;
      });
      nameInput.addEventListener('input', () => {
        this.name_abyssPrivate = nameInput.value;
      });
    });

    let colorInput!: HTMLInputElement;
    new Setting(contentEl).setName('Color').addColorPicker((picker) => {
      picker.setValue(this.color_abyssPrivate ?? COLOR_PICKER_FALLBACK).onChange((value) => {
        this.color_abyssPrivate = value;
      });
      const renderedInput = contentEl.querySelector<HTMLInputElement>('input[type="color"]');
      if (renderedInput === null) throw new Error('Obsidian did not render the color input');
      colorInput = renderedInput;
      colorInput.addEventListener('input', () => {
        this.color_abyssPrivate = colorInput.value;
      });
    });

    const buttonRow = contentEl.createDiv({ cls: 'abyss-tag-group-appearance-buttons' });
    const resetButton = buttonRow.createEl('button', { text: 'Reset' });
    const cancelButton = buttonRow.createEl('button', { text: 'Cancel' });
    const saveButton = buttonRow.createEl('button', { text: 'Save', cls: 'mod-cta' });
    resetButton.addEventListener('click', () => {
      this.color_abyssPrivate = null;
      colorInput.value = COLOR_PICKER_FALLBACK;
    });
    cancelButton.addEventListener('click', () => {
      this.close();
    });
    saveButton.addEventListener('click', () => {
      const result: { name?: string; color?: string | null } = {};
      const name = this.name_abyssPrivate.trim();
      if (name !== this.current_abyssPrivate.name) result.name = name;
      if (this.color_abyssPrivate !== (this.current_abyssPrivate.color ?? null))
        result.color = this.color_abyssPrivate;
      this.onSubmit_abyssPrivate(result);
      this.close();
    });

    const target = this.initialField_abyssPrivate === 'color' ? colorInput : nameInput;
    contentEl.ownerDocument.defaultView?.setTimeout(() => {
      target.focus();
    }, 0);
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
