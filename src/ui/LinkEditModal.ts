import { Modal, Setting, type App } from 'obsidian';
import {
  aliasSeparator,
  buildLinkRaw,
  unaliasedDisplay,
  writtenAlias,
  type LinkToken,
} from '../markdown/links';
import { NoteSuggest } from './NoteSuggest';
import { noInteractionOwnership, type InteractionOwnershipPort } from './interactionOwnership';

export class LinkEditModal extends Modal {
  private readonly token_abyssPrivate: LinkToken;
  private readonly onSave_abyssPrivate: (newRaw: string) => void;
  private readonly sourcePath_abyssPrivate: string;
  private readonly interactionOwnership_abyssPrivate: InteractionOwnershipPort;
  private noteSuggest_abyssPrivate: NoteSuggest | undefined;
  private displayInput_abyssPrivate: HTMLInputElement | undefined;
  private display_abyssPrivate: string;
  private target_abyssPrivate: string;
  private ownershipToken_abyssPrivate: { release(): void } | null = null;

  constructor(
    ...args: [App, LinkToken, (newRaw: string) => void, string?, InteractionOwnershipPort?]
  ) {
    const [app, token, onSave, sourcePath = '', ownership = noInteractionOwnership] = args;
    super(app);
    this.noteSuggest_abyssPrivate = undefined;
    this.displayInput_abyssPrivate = undefined;
    this.token_abyssPrivate = token;
    this.onSave_abyssPrivate = onSave;
    this.sourcePath_abyssPrivate = sourcePath;
    this.interactionOwnership_abyssPrivate = ownership;
    // The field holds only the text the link is written with; a wiki link's note name shows as its
    // placeholder, so a new target is not given the old name as an alias.
    this.display_abyssPrivate = writtenAlias(token);
    this.target_abyssPrivate = token.target;
  }

  override onOpen(): void {
    this.ownershipToken_abyssPrivate?.release();
    this.ownershipToken_abyssPrivate = this.interactionOwnership_abyssPrivate.acquire({
      blocksShortcuts: true,
    });
    const { contentEl, token_abyssPrivate: token } = this;
    contentEl.createEl('h3', { text: token.type === 'wiki' ? 'Edit wiki link' : 'Edit link' });

    new Setting(contentEl).setName(token.type === 'wiki' ? 'Note' : 'URL').addText((t) => {
      t.setValue(this.target_abyssPrivate).onChange((v) => {
        this.setTarget_abyssPrivate(v);
      });
      // Wiki links get a note-search dropdown honouring Obsidian's excluded files.
      if (token.type === 'wiki') {
        t.inputEl.setAttribute('spellcheck', 'false');
        this.noteSuggest_abyssPrivate = new NoteSuggest(this.app, t.inputEl, (file) => {
          this.setTarget_abyssPrivate(
            this.app.metadataCache.fileToLinktext(file, this.sourcePath_abyssPrivate, true),
          );
          t.setValue(this.target_abyssPrivate);
        });
      }
    });

    new Setting(contentEl)
      .setName(token.type === 'wiki' ? 'Display (alias)' : 'Display text')
      .addText((t) => {
        t.setValue(this.display_abyssPrivate).onChange((v) => {
          this.display_abyssPrivate = v;
        });
        this.displayInput_abyssPrivate = t.inputEl;
      });

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText('Save')
        .setCta()
        .onClick(() => {
          const target = this.target_abyssPrivate.trim();
          const display = this.display_abyssPrivate.trim();
          // A link rebuilt from unchanged fields can differ from its source, as `[[ Note ]]`
          // becomes `[[Note]]`, so Save writes only a link whose fields changed.
          if (target !== token.target.trim() || display !== writtenAlias(token).trim()) {
            this.onSave_abyssPrivate(
              buildLinkRaw(token.type, target, display, aliasSeparator(token)),
            );
          }
          this.close();
        }),
    );
    this.setTarget_abyssPrivate(this.target_abyssPrivate);
  }

  /** Keeps the target and, for a wiki link, the note name the empty alias field shows. */
  private setTarget_abyssPrivate(target: string): void {
    this.target_abyssPrivate = target;
    if (this.token_abyssPrivate.type === 'wiki') {
      this.displayInput_abyssPrivate?.setAttribute('placeholder', unaliasedDisplay(target.trim()));
    }
  }

  override onClose(): void {
    const ownershipToken = this.ownershipToken_abyssPrivate;
    this.ownershipToken_abyssPrivate = null;
    ownershipToken?.release();
    this.noteSuggest_abyssPrivate?.close();
    this.noteSuggest_abyssPrivate = undefined;
    this.displayInput_abyssPrivate = undefined;
    this.contentEl.empty();
  }
}
