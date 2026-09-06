import { Modal, Notice, type App } from 'obsidian';
import type { MoveRecovery, TaskApplicationApi, TaskRef, TaskSnapshot } from '../tasks';
import { runAsyncAction } from './runAsyncAction';

export class TaskMoveRecoveryModal extends Modal {
  constructor(
    app: App,
    private readonly tasks_abyssPrivate: TaskApplicationApi,
    private readonly recovery_abyssPrivate: MoveRecovery,
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
    this.contentEl.createEl('h3', { text: 'Task move needs attention' });
    this.contentEl.createEl('p', {
      text: `The task was copied to ${this.recovery_abyssPrivate.targetPath}, but the original remains in ${this.recovery_abyssPrivate.source.filePath}.`,
    });
    const actions = this.contentEl.createDiv({ cls: 'abyss-task-move-recovery-actions' });
    const keep = actions.createEl('button', { text: 'Keep both' });
    keep.addEventListener('click', () => {
      this.close();
    });
    const remove = actions.createEl('button', { text: 'Remove original' });
    remove.addEventListener('click', () => {
      runAsyncAction(this.resolveOriginal_abyssPrivate(), 'Could not resolve original task');
    });
  }

  private async resolveOriginal_abyssPrivate(): Promise<void> {
    const resolution = this.tasks_abyssPrivate.queries.resolve(this.recovery_abyssPrivate.source);
    switch (resolution.type) {
      case 'exact':
        await this.removeOriginal_abyssPrivate(resolution.task.ref);
        break;
      case 'rebased':
        this.renderConflict_abyssPrivate(resolution.current);
        break;
      case 'uncertain':
      case 'visual':
        this.renderStopped_abyssPrivate(
          'The original task could not be identified safely. Nothing was removed.',
        );
        break;
      case 'not-found':
        this.renderStopped_abyssPrivate(
          'The original task could not be found. Nothing was removed.',
        );
        break;
      case 'ambiguous':
        this.renderStopped_abyssPrivate(
          'Multiple possible originals were found. Nothing was removed.',
        );
        break;
    }
  }

  private renderConflict_abyssPrivate(current: TaskSnapshot): void {
    this.contentEl.empty();
    this.contentEl.createEl('h3', { text: 'Original task changed' });
    this.contentEl.createEl('p', {
      text: 'The original changed since the move. Review the current Markdown before removing this newer revision.',
    });
    this.contentEl.createEl('pre', {
      text: current.source.originalBlock,
    });
    const actions = this.contentEl.createDiv({ cls: 'abyss-task-move-recovery-actions' });
    const keep = actions.createEl('button', { text: 'Keep both' });
    keep.addEventListener('click', () => {
      this.close();
    });
    const remove = actions.createEl('button', { text: 'Remove changed original' });
    remove.addEventListener('click', () => {
      runAsyncAction(
        this.removeOriginal_abyssPrivate(current.ref),
        'Could not remove original task',
      );
    });
  }

  private renderStopped_abyssPrivate(message: string): void {
    this.contentEl.empty();
    this.contentEl.createEl('h3', { text: 'Original was not removed' });
    this.contentEl.createEl('p', { text: message });
    const close = this.contentEl.createEl('button', { text: 'Close' });
    close.addEventListener('click', () => {
      this.close();
    });
  }

  private renderRemovalUnknown_abyssPrivate(path: string): void {
    this.contentEl.empty();
    this.contentEl.createEl('h3', { text: 'Original removal state is unknown' });
    this.contentEl.createEl('p', {
      text: `Could not confirm whether the original in ${path} was removed. Rescan and inspect ${path} and ${this.recovery_abyssPrivate.targetPath} before taking any action. Do not repeat removal until the vault state is confirmed.`,
    });
    const close = this.contentEl.createEl('button', { text: 'Close' });
    close.addEventListener('click', () => {
      this.close();
    });
  }

  private async removeOriginal_abyssPrivate(ref: TaskRef): Promise<void> {
    const result = await this.tasks_abyssPrivate.execute({ type: 'delete', ref });
    if (result.type === 'ok') {
      new Notice('Original task removed.');
      this.close();
      return;
    }
    if (result.type === 'conflict') {
      this.renderConflict_abyssPrivate(result.current);
      return;
    }
    if (result.type === 'not-found') {
      this.renderStopped_abyssPrivate('The original task could not be found. Nothing was removed.');
      return;
    }
    if (result.type === 'ambiguous') {
      this.renderStopped_abyssPrivate(
        'Multiple possible originals were found. Nothing was removed.',
      );
      return;
    }
    if (result.type === 'io-error' && result.contentState === 'unknown') {
      this.renderRemovalUnknown_abyssPrivate(
        result.path ?? this.recovery_abyssPrivate.source.filePath,
      );
      return;
    }
    this.renderStopped_abyssPrivate(
      'The original could not be removed safely. Both copies were kept.',
    );
  }
}
