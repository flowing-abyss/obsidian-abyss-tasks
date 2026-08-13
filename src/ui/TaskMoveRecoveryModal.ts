import { Modal, Notice, type App } from 'obsidian';
import type { MoveRecovery, TaskApplicationApi, TaskRef, TaskSnapshot } from '../tasks';

export class TaskMoveRecoveryModal extends Modal {
  constructor(
    app: App,
    private readonly tasks: TaskApplicationApi,
    private readonly recovery: MoveRecovery,
  ) {
    super(app);
    this.modalEl.addClass('tc-task-move-recovery');
  }

  onOpen(): void {
    this.renderChoices();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private renderChoices(): void {
    this.contentEl.empty();
    this.contentEl.createEl('h3', { text: 'Task move needs attention' });
    this.contentEl.createEl('p', {
      text: `The task was copied to ${this.recovery.targetPath}, but the original remains in ${this.recovery.source.filePath}.`,
    });
    const actions = this.contentEl.createDiv({ cls: 'tc-task-move-recovery-actions' });
    const keep = actions.createEl('button', { text: 'Keep both' });
    keep.addEventListener('click', () => this.close());
    const remove = actions.createEl('button', { text: 'Remove original' });
    remove.addEventListener('click', () => {
      void this.resolveOriginal();
    });
  }

  private async resolveOriginal(): Promise<void> {
    const resolution = this.tasks.queries.resolve(this.recovery.source);
    switch (resolution.type) {
      case 'exact':
        await this.removeOriginal(resolution.task.ref);
        break;
      case 'rebased':
        this.renderConflict(resolution.current);
        break;
      case 'uncertain':
      case 'visual':
        this.renderStopped(
          'The original task could not be identified safely. Nothing was removed.',
        );
        break;
      case 'not-found':
        this.renderStopped('The original task could not be found. Nothing was removed.');
        break;
      case 'ambiguous':
        this.renderStopped('Multiple possible originals were found. Nothing was removed.');
        break;
    }
  }

  private renderConflict(current: TaskSnapshot): void {
    this.contentEl.empty();
    this.contentEl.createEl('h3', { text: 'Original task changed' });
    this.contentEl.createEl('p', {
      text: 'The original changed since the move. Review the current Markdown before removing this newer revision.',
    });
    this.contentEl.createEl('pre', {
      text: current.source.originalBlock,
    });
    const actions = this.contentEl.createDiv({ cls: 'tc-task-move-recovery-actions' });
    const keep = actions.createEl('button', { text: 'Keep both' });
    keep.addEventListener('click', () => this.close());
    const remove = actions.createEl('button', { text: 'Remove changed original' });
    remove.addEventListener('click', () => {
      void this.removeOriginal(current.ref);
    });
  }

  private renderStopped(message: string): void {
    this.contentEl.empty();
    this.contentEl.createEl('h3', { text: 'Original was not removed' });
    this.contentEl.createEl('p', { text: message });
    const close = this.contentEl.createEl('button', { text: 'Close' });
    close.addEventListener('click', () => this.close());
  }

  private renderRemovalUnknown(path: string): void {
    this.contentEl.empty();
    this.contentEl.createEl('h3', { text: 'Original removal state is unknown' });
    this.contentEl.createEl('p', {
      text: `Could not confirm whether the original in ${path} was removed. Rescan and inspect ${path} and ${this.recovery.targetPath} before taking any action. Do not repeat removal until the vault state is confirmed.`,
    });
    const close = this.contentEl.createEl('button', { text: 'Close' });
    close.addEventListener('click', () => this.close());
  }

  private async removeOriginal(ref: TaskRef): Promise<void> {
    const result = await this.tasks.execute({ type: 'delete', ref });
    if (result.type === 'ok') {
      new Notice('Original task removed.');
      this.close();
      return;
    }
    if (result.type === 'conflict') {
      this.renderConflict(result.current);
      return;
    }
    if (result.type === 'not-found') {
      this.renderStopped('The original task could not be found. Nothing was removed.');
      return;
    }
    if (result.type === 'ambiguous') {
      this.renderStopped('Multiple possible originals were found. Nothing was removed.');
      return;
    }
    if (result.type === 'io-error' && result.contentState === 'unknown') {
      this.renderRemovalUnknown(result.path ?? this.recovery.source.filePath);
      return;
    }
    this.renderStopped('The original could not be removed safely. Both copies were kept.');
  }
}
