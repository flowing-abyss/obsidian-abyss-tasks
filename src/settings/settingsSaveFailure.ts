import { Notice } from 'obsidian';
import { isViewStateWritesSuspended } from './persistence';

export interface SettingsDraftSave {
  readonly owner?: object;
  readonly action: string;
  readonly save: () => Promise<void>;
}

/** The failure's message without one trailing period, because the Notice adds its own. */
function causeSentence(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return detail.endsWith('.') ? detail.slice(0, -1) : detail;
}

interface DraftSaveState {
  save(options?: SettingsDraftSave): void;
  report(options: SettingsDraftSave, error: unknown): void;
}

/** Keeps one action's transient draft, attempts and feedback behind its save/report operations. */
function createDraftState(initial: SettingsDraftSave): DraftSaveState {
  let latest = initial;
  let attempt = 0;
  let notice: Notice | undefined;
  let retry: HTMLButtonElement | undefined;
  let message: HTMLElement | undefined;

  function retireFailure(): void {
    (notice as Partial<Notice> | undefined)?.hide?.();
    notice = undefined;
    retry = undefined;
    message = undefined;
  }

  function reportFailure(error: unknown, generation: number): void {
    const prefix = `Could not ${latest.action}`;
    console.error(`[abyss-tasks] ${prefix}`, { cause: error });
    if (generation !== attempt) return;
    const sentence = `${prefix}: ${causeSentence(error)}. Changes are kept in this session.`;
    if (isViewStateWritesSuspended(error)) {
      retireFailure();
      notice = new Notice(sentence);
      return;
    }
    if (message?.isConnected !== true) {
      retireFailure();
      const fragment = createFragment();
      message = fragment.createSpan();
      retry = fragment.createEl('button', { text: 'Retry' });
      notice = new Notice(fragment, 0);
      retry.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        save();
      };
    }
    message.setText(`${sentence} `);
    if (retry !== undefined) retry.disabled = false;
  }

  function save(options: SettingsDraftSave = latest): void {
    latest = options;
    const generation = ++attempt;
    if (retry !== undefined) retry.disabled = true;
    void options.save().then(
      () => {
        if (generation === attempt) retireFailure();
      },
      (error: unknown) => {
        reportFailure(error, generation);
      },
    );
  }

  return {
    save,
    report(options, error) {
      latest = options;
      reportFailure(error, ++attempt);
    },
  };
}

const failures = new WeakMap<object, Map<string, DraftSaveState>>();

function draftState(options: SettingsDraftSave): DraftSaveState {
  if (options.owner === undefined) return createDraftState(options);
  const actions = failures.get(options.owner) ?? new Map<string, DraftSaveState>();
  failures.set(options.owner, actions);
  const state = actions.get(options.action) ?? createDraftState(options);
  actions.set(options.action, state);
  return state;
}

/** Reports a failed draft; suspended view-state writes offer no Retry. */
export function reportSettingsDraftSaveFailure(options: SettingsDraftSave, error: unknown): void {
  draftState(options).report(options, error);
}

/** Saves the current draft; owner/action failures share one generation-aware Retry. */
export function saveSettingsDraft(options: SettingsDraftSave): void {
  draftState(options).save(options);
}
