import { Modal, Notice, type App } from 'obsidian';
import type { ArchiveRecovery, TaskApplicationApi } from '../tasks';
import { runAsyncAction } from './runAsyncAction';

export class TaskArchiveRecoveryModal extends Modal {
  constructor(
    app: App,
    private readonly tasks_abyssPrivate: TaskApplicationApi,
    private readonly recovery_abyssPrivate: ArchiveRecovery,
  ) {
    super(app);
    this.modalEl.addClass('abyss-task-move-recovery');
  }

  override onOpen(): void {
    this.renderChoices_abyssPrivate();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private renderChoices_abyssPrivate(): void {
    this.contentEl.empty();
    this.contentEl.createEl('h3', { text: 'Task archive needs attention' });
    this.contentEl.createEl('p', {
      text:
        this.recovery_abyssPrivate.state === 'source-removal-unknown'
          ? `The task was written to ${this.recovery_abyssPrivate.targetPath}, but removal from ${this.recovery_abyssPrivate.source.filePath} could not be confirmed.`
          : `The archive write to ${this.recovery_abyssPrivate.targetPath} needs verification before the original in ${this.recovery_abyssPrivate.source.filePath} can be removed.`,
    });
    const actions = this.contentEl.createDiv({ cls: 'abyss-task-move-recovery-actions' });
    const close = actions.createEl('button', { text: 'Close' });
    close.addEventListener('click', () => {
      this.close();
    });
    const retry = actions.createEl('button', { text: 'Verify and retry' });
    retry.addEventListener('click', () => {
      runAsyncAction(this.retry_abyssPrivate(), 'Could not retry task archive');
    });
  }

  private async retry_abyssPrivate(): Promise<void> {
    const result = await this.tasks_abyssPrivate.execute({
      type: 'archive',
      ref: this.recovery_abyssPrivate.source,
    });
    if (result.type === 'ok' && result.outcome.type === 'archived') {
      new Notice('Task archived.');
      this.close();
      return;
    }
    if (result.type === 'partial' && result.operation === 'archive') {
      this.renderStopped_abyssPrivate(
        `The archive or original changed. Inspect ${result.recovery.targetPath} and ${result.recovery.source.filePath} before retrying.`,
      );
      return;
    }
    this.renderStopped_abyssPrivate(
      `The task could not be archived safely. Inspect ${this.recovery_abyssPrivate.targetPath} and ${this.recovery_abyssPrivate.source.filePath}.`,
    );
  }

  private renderStopped_abyssPrivate(message: string): void {
    this.contentEl.empty();
    this.contentEl.createEl('h3', { text: 'Task was not archived' });
    this.contentEl.createEl('p', { text: message });
    const close = this.contentEl.createEl('button', { text: 'Close' });
    close.addEventListener('click', () => {
      this.close();
    });
  }
}
