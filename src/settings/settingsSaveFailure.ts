import { Notice } from 'obsidian';
import { isViewStateWritesSuspended } from './persistence';

export interface SettingsDraftSave {
  readonly action: string;
  readonly save: () => Promise<void>;
}

/** The failure's message without one trailing period, because the Notice adds its own. */
function causeSentence(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return detail.endsWith('.') ? detail.slice(0, -1) : detail;
}

/**
 * Shows one failure Notice. A save that can succeed later gets a persistent Notice with a retry that
 * reads the then-current settings draft. Suspended view-state writes stay suspended for the whole
 * session, so they get the same sentence without a retry, for the default duration.
 */
export function reportSettingsDraftSaveFailure(options: SettingsDraftSave, error: unknown): void {
  const prefix = `Could not ${options.action}`;
  const report = (error: unknown): string => {
    console.error(`[abyss-tasks] ${prefix}`, { cause: error });
    return `${prefix}: ${causeSentence(error)}. Changes are kept in this session.`;
  };
  if (isViewStateWritesSuspended(error)) {
    new Notice(report(error));
    return;
  }
  const fragment = createFragment();
  fragment.appendText(`${report(error)} `);
  const retry = fragment.createEl('button', { text: 'Retry' });
  const notice = new Notice(fragment, 0);
  retry.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    retry.disabled = true;
    void options.save().then(
      () => (notice as Partial<Notice>).hide?.(),
      (retryError: unknown) => {
        report(retryError);
        retry.disabled = false;
      },
    );
  };
}

/** Saves the current settings draft and offers a retry that reads the then-current draft. */
export function saveSettingsDraft(options: SettingsDraftSave): void {
  void options.save().catch((error: unknown) => {
    reportSettingsDraftSaveFailure(options, error);
  });
}
