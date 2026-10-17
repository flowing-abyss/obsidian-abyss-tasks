import { Modal } from 'obsidian-test-mocks/obsidian';

/** The package host never attaches and auto-closes. Model only the inspector's native lifetime. */
export class InspectorModalMock extends Modal {
  private inspectorOpen = false;

  // Obsidian's public history hook closes the modal; the package mock omits it.
  onHistoryBack(): void {
    this.close();
  }

  override open(): void {
    if (!this.containerEl.hasClass('abyss-modal-backdrop')) {
      super.open();
      return;
    }
    activeDocument.body.append(this.containerEl);
    this.inspectorOpen = true;
    this.app.keymap.pushScope(this.scope);
    this.onOpen();
  }

  override close(): void {
    if (!this.containerEl.hasClass('abyss-modal-backdrop')) {
      super.close();
      return;
    }
    if (!this.inspectorOpen) return;
    this.inspectorOpen = false;
    this.onClose();
    this.containerEl.remove();
    this.app.keymap.popScope(this.scope);
  }
}
