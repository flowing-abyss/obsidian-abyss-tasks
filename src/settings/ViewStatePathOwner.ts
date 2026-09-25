import { TFile, type EventRef, type Vault } from 'obsidian';
import { isViewStateWritesSuspended } from './persistence';
import type { CalendarSettings } from './types';
import {
  noteDeleteChange,
  noteRenameChange,
  rebaseSavedNotePath,
  type NotePathChange,
} from './viewStatePaths';

const TRAILING_SAVE_MS = 150;

/** Keeps saved view state in step with note deletes and renames for the plugin's lifetime. */
export class ViewStatePathOwner {
  private pendingSave: number | undefined;

  constructor(
    private readonly settings: CalendarSettings,
    private readonly save: () => Promise<void>,
  ) {}

  /** Vault listeners for the plugin to register; each forwards a note change (see the rules). */
  listen(vault: Vault): EventRef[] {
    return [
      vault.on('delete', (file) => {
        if (!(file instanceof TFile)) return;
        const change = noteDeleteChange(file.path, file.extension);
        if (change !== undefined) this.noteChanged(change);
      }),
      vault.on('rename', (file, oldPath) => {
        if (!(file instanceof TFile)) return;
        const change = noteRenameChange(oldPath, file.path, file.extension);
        if (change !== undefined) this.noteChanged(change);
      }),
    ];
  }

  /** Applies one change and schedules one trailing save when anything changed. */
  noteChanged(change: NotePathChange): void {
    if (!rebaseSavedNotePath(this.settings, change)) return;
    this.cancelPendingSave();
    this.pendingSave = window.setTimeout(() => {
      this.pendingSave = undefined;
      this.startSave();
    }, TRAILING_SAVE_MS);
  }

  /** Clears the pending save and its timer, because the caller's view-state write carries it. */
  cancelPendingSave(): void {
    if (this.pendingSave === undefined) return;
    window.clearTimeout(this.pendingSave);
    this.pendingSave = undefined;
  }

  /** Clears the timer and starts a pending save at once; does nothing without one. */
  flushPendingSave(): void {
    if (this.pendingSave === undefined) return;
    this.cancelPendingSave();
    this.startSave();
  }

  /** The next user-triggered view save reports a lasting failure, so this one only logs. */
  private startSave(): void {
    this.save().catch((error: unknown) => {
      if (isViewStateWritesSuspended(error)) return;
      console.error('[abyss-tasks] Could not save view state after a note change', error);
    });
  }
}
