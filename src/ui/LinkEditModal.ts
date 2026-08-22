import { App, Modal, Setting } from 'obsidian';
import { buildLinkRaw, type LinkToken } from '../parser/links';
import { NoteSuggest } from './NoteSuggest';
import { noInteractionOwnership, type InteractionOwnershipPort } from './interactionOwnership';

export class LinkEditModal extends Modal {
  private display: string;
  private target: string;
  private ownershipToken: { release(): void } | null = null;

  constructor(
    app: App,
    private token: LinkToken,
    private onSave: (newRaw: string) => void,
    private sourcePath = '',
    private readonly interactionOwnership: InteractionOwnershipPort = noInteractionOwnership,
  ) {
    super(app);
    this.display = token.display;
    this.target = token.target;
  }

  onOpen(): void {
    this.ownershipToken?.release();
    this.ownershipToken = this.interactionOwnership.acquire({ blocksShortcuts: true });
    const { contentEl, token } = this;
    contentEl.createEl('h3', { text: token.type === 'wiki' ? 'Edit wiki link' : 'Edit link' });

    new Setting(contentEl).setName(token.type === 'wiki' ? 'Note' : 'URL').addText((t) => {
      t.setValue(this.target).onChange((v) => {
        this.target = v;
      });
      // Wiki links get a note-search dropdown honouring Obsidian's excluded files.
      if (token.type === 'wiki') {
        t.inputEl.setAttribute('spellcheck', 'false');
        // AbstractInputSuggest registers itself onto the input via its constructor.
        // eslint-disable-next-line sonarjs/constructor-for-side-effects
        new NoteSuggest(this.app, t.inputEl, (file) => {
          this.target = this.app.metadataCache.fileToLinktext(file, this.sourcePath, true);
          t.setValue(this.target);
        });
      }
    });

    new Setting(contentEl)
      .setName(token.type === 'wiki' ? 'Display (alias)' : 'Display text')
      .addText((t) =>
        t.setValue(this.display).onChange((v) => {
          this.display = v;
        }),
      );

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText('Save')
        .setCta()
        .onClick(() => {
          this.onSave(buildLinkRaw(token.type, this.target.trim(), this.display.trim()));
          this.close();
        }),
    );
  }

  onClose(): void {
    const ownershipToken = this.ownershipToken;
    this.ownershipToken = null;
    ownershipToken?.release();
    this.contentEl.empty();
  }
}
