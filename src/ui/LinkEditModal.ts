import { Modal, Setting, type App } from 'obsidian';
import { buildLinkRaw, type LinkToken } from '../markdown/links';
import { NoteSuggest } from './NoteSuggest';
import { noInteractionOwnership, type InteractionOwnershipPort } from './interactionOwnership';

export class LinkEditModal extends Modal {
  private readonly token: LinkToken;
  private readonly onSave: (newRaw: string) => void;
  private readonly sourcePath: string;
  private readonly interactionOwnership: InteractionOwnershipPort;
  private noteSuggest: NoteSuggest | undefined;
  private display: string;
  private target: string;
  private ownershipToken: { release(): void } | null = null;

  constructor(
    ...args: [App, LinkToken, (newRaw: string) => void, string?, InteractionOwnershipPort?]
  ) {
    const [app, token, onSave, sourcePath = '', ownership = noInteractionOwnership] = args;
    super(app);
    this.noteSuggest = undefined;
    this.token = token;
    this.onSave = onSave;
    this.sourcePath = sourcePath;
    this.interactionOwnership = ownership;
    this.display = token.display;
    this.target = token.target;
  }

  override onOpen(): void {
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
        this.noteSuggest = new NoteSuggest(this.app, t.inputEl, (file) => {
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

  override onClose(): void {
    const ownershipToken = this.ownershipToken;
    this.ownershipToken = null;
    ownershipToken?.release();
    this.noteSuggest?.close();
    this.noteSuggest = undefined;
    this.contentEl.empty();
  }
}
