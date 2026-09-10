import { Notice } from 'obsidian';

export interface SettingsDraftSave {
  readonly action: string;
  readonly save: () => Promise<void>;
}

/** Shows one persistent failure with a retry that reads the then-current settings draft. */
export function reportSettingsDraftSaveFailure(options: SettingsDraftSave, error: unknown): void {
  const prefix = `Could not ${options.action}`;
  const report = (error: unknown): string => {
    console.error(`[abyss-tasks] ${prefix}`, { cause: error });
    const detail = error instanceof Error ? error.message : String(error);
    return `${prefix}: ${detail}. Changes are kept in this session.`;
  };
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
