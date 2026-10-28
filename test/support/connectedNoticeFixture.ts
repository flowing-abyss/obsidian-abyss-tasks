/** A connected Notice base with public hide dispatch and controllable deferred detachment. */
export class ConnectedNoticeFixture {
  readonly containerEl = document.body.createDiv({ cls: 'settings-test-notice' });
  readonly messageEl = this.containerEl.createDiv();
  deferDetach = false;

  constructor(message: string | DocumentFragment) {
    if (typeof message === 'string') this.messageEl.setText(message);
    else this.messageEl.append(message);
    this.containerEl.addEventListener('click', () => {
      this.hide();
    });
  }

  hide(): void {
    if (!this.deferDetach) this.containerEl.remove();
  }
}
