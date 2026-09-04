import { Modal, Notice, type App } from 'obsidian';
import type { TagManager, VaultTagRenameResult } from './TagManager';

type RenameScope = 'exact' | 'prefix';
type RenameTagModalDependencies = [
  app: App,
  tagManager: TagManager,
  currentTag: string,
  onRenamed: () => void,
  renameScope?: RenameScope,
];

function displayTag(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
}

function fileLabel(count: number): string {
  return `${count} file${count === 1 ? '' : 's'}`;
}

function presentResult(result: VaultTagRenameResult): boolean {
  if (result.type === 'invalid') {
    new Notice(
      result.reason === 'same-tag'
        ? 'Choose a different tag.'
        : 'Enter a valid tag without spaces, empty segments, or a trailing slash.',
    );
    return false;
  }
  if (result.type === 'settings-error') {
    new Notice(
      `Warning: vault tags changed in ${fileLabel(result.changedFiles.length)}, but tag settings were not saved. ${fileLabel(result.failedFiles.length)} also failed.`,
      8000,
    );
    return true;
  }
  if (result.type === 'partial') {
    new Notice(
      `Warning: tag rename incomplete. ${fileLabel(result.changedFiles.length)} changed; ${fileLabel(result.failedFiles.length)} failed.`,
      8000,
    );
    return true;
  }
  new Notice(`Tag renamed across ${fileLabel(result.changedFiles.length)}.`);
  return true;
}

export class RenameTagModal extends Modal {
  private input!: HTMLInputElement;
  private readonly tagManager: TagManager;
  private readonly currentTag: string;
  private readonly onRenamed: () => void;
  private readonly renameScope: RenameScope;

  constructor(...dependencies: RenameTagModalDependencies) {
    const [app, tagManager, currentTag, onRenamed, renameScope = 'exact'] = dependencies;
    super(app);
    this.tagManager = tagManager;
    this.currentTag = currentTag;
    this.onRenamed = onRenamed;
    this.renameScope = renameScope;
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('abyss-rename-tag-modal');
    contentEl.createEl('h3', {
      text:
        this.renameScope === 'prefix'
          ? 'Rename tag prefix across vault'
          : 'Rename tag across vault',
    });
    const confirmation = contentEl.createEl('p');

    this.input = contentEl.createEl('input', {
      cls: 'abyss-rename-input',
      attr: { type: 'text', value: this.currentTag },
    });
    this.input.select();

    const btnRow = contentEl.createDiv({ cls: 'abyss-rename-btn-row' });
    const okBtn = btnRow.createEl('button', { text: 'Rename across vault', cls: 'mod-cta' });
    const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });
    let pending = false;

    const setPending = (value: boolean): void => {
      pending = value;
      this.input.disabled = value;
      okBtn.disabled = value;
      cancelBtn.disabled = value;
    };

    const updateConfirmation = (): void => {
      const oldTag = displayTag(this.currentTag);
      const newTag = displayTag(this.input.value);
      confirmation.setText(
        this.renameScope === 'prefix'
          ? `Rename ${oldTag} and its subtags → ${newTag} and its subtags across the vault.`
          : `Rename the exact tag ${oldTag} → ${newTag} across the vault.`,
      );
    };

    const doRename = (): void => {
      if (pending) return;
      setPending(true);
      const newTag = this.input.value.trim();
      const operation =
        this.renameScope === 'prefix'
          ? this.tagManager.renameTagPrefix(this.currentTag, newTag)
          : this.tagManager.renameTagExact(this.currentTag, newTag);
      void operation
        .then((result) => {
          if (!presentResult(result)) {
            setPending(false);
            return;
          }
          this.onRenamed();
          this.close();
        })
        .catch(() => {
          new Notice('Tag rename failed unexpectedly. No success was reported.', 8000);
          setPending(false);
        });
    };

    okBtn.addEventListener('click', doRename);
    cancelBtn.addEventListener('click', () => {
      if (!pending) this.close();
    });
    this.input.addEventListener('input', updateConfirmation);
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doRename();
      if (e.key === 'Escape' && !pending) this.close();
    });

    updateConfirmation();
    contentEl.ownerDocument.defaultView?.setTimeout(() => {
      this.input.focus();
    }, 0);
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
