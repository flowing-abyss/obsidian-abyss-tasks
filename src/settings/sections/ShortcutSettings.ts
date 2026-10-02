import { setIcon } from 'obsidian';
import {
  type ParsedShortcutAlternative,
  SHORTCUT_ACTION_IDS,
  SHORTCUT_ACTIONS,
  type ShortcutActionId,
  type ShortcutIssue,
  type ShortcutPlatform,
  validateShortcuts,
} from '../shortcuts';
import type { CalendarSettings } from '../types';

interface ShortcutIssueView {
  inputs: ReadonlyMap<ShortcutActionId, HTMLInputElement>;
  messages: ReadonlyMap<ShortcutActionId, HTMLElement>;
  announcementEl: HTMLElement;
}

interface ShortcutIssueUpdate extends ShortcutIssueView {
  announce: boolean;
  announcedAction?: ShortcutActionId;
}

interface ShortcutIssueRender {
  action: ShortcutActionId;
  input: HTMLInputElement;
  messageEl: HTMLElement;
  issues: readonly ShortcutIssue[];
  active: readonly ParsedShortcutAlternative[];
}

function describeShortcutIssues(
  action: ShortcutActionId,
  issues: readonly ShortcutIssue[],
  active: readonly ParsedShortcutAlternative[],
): string {
  let activeText = 'No alternatives remain active.';
  if (active.length > 0) {
    const verb = active.length === 1 ? 'remains' : 'remain';
    activeText = `${active.map((binding) => binding.fragment).join(' and ')} ${verb} active.`;
  }
  const labelFor = (actionId: ShortcutActionId): string =>
    SHORTCUT_ACTIONS.find((candidate) => candidate.id === actionId)?.label ?? actionId;
  const descriptions = issues.map((issue) => {
    let message: string;
    switch (issue.kind) {
      case 'empty':
        message = `Alternative ${issue.fragmentIndex + 1} is empty and is disabled.`;
        break;
      case 'invalid':
        message = `${issue.fragment} is invalid and is disabled.`;
        break;
      case 'duplicate':
        message = `${issue.fragment} duplicates ${issue.duplicateOf} and is disabled.`;
        break;
      case 'conflict':
        message = `${issue.fragment} conflicts with ${issue.conflictingActions
          .filter((actionId) => actionId !== action)
          .map(labelFor)
          .join(' and ')} and is disabled.`;
        break;
    }
    return { issue, message };
  });
  const sortedDescriptions = [...descriptions];
  sortedDescriptions.sort(
    (left, right) =>
      Number(left.issue.kind === 'conflict') - Number(right.issue.kind === 'conflict'),
  );
  return `${sortedDescriptions.map(({ message }) => message).join(' ')} ${activeText}`;
}

export interface ShortcutSettingsOptions {
  readonly shortcuts: () => CalendarSettings['shortcuts'];
  readonly save: () => Promise<void>;
  readonly sectionScope: number;
  readonly platform: ShortcutPlatform;
}

export class ShortcutSettings {
  readonly #options: ShortcutSettingsOptions;
  #shortcutSaveInFlight: Promise<void> | undefined = undefined;
  #shortcutSaveQueued = false;
  #shortcutSaveFailed = false;
  #shortcutSaveStatusEl: HTMLElement | undefined;
  #shortcutSaveRetryEl: HTMLButtonElement | undefined;

  constructor(options: ShortcutSettingsOptions) {
    this.#options = options;
  }

  render(containerEl: HTMLElement): void {
    const inputEls = new Map<ShortcutActionId, HTMLInputElement>();
    const issueEls = new Map<ShortcutActionId, HTMLElement>();
    containerEl.createDiv({
      cls: 'abyss-shortcut-help',
      text: 'Use A–Z or 0–9 with optional Alt, Ctrl, Meta, Shift, or Mod. Separate alternatives with |, for example Q | shift 7.',
    });
    const validationStatus = containerEl.createDiv({
      cls: 'abyss-shortcut-validation-status abyss-sr-only',
      attr: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
    });
    const saveFeedback = containerEl.createDiv({ cls: 'abyss-shortcut-save-feedback' });
    this.#shortcutSaveStatusEl = saveFeedback.createSpan({
      cls: 'abyss-shortcut-save-status',
      attr: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
    });
    this.#shortcutSaveRetryEl = saveFeedback.createEl('button', {
      cls: 'abyss-shortcut-save-retry',
      attr: { type: 'button' },
      text: 'Retry',
    });
    this.#shortcutSaveRetryEl.addEventListener('click', () => {
      this.#queueShortcutSave();
    });
    this.#updateShortcutSavePresentation();
    const list = containerEl.createDiv({ cls: 'abyss-shortcuts-list' });

    for (const actionId of SHORTCUT_ACTION_IDS) {
      const action = SHORTCUT_ACTIONS.find((candidate) => candidate.id === actionId);
      if (action == null) continue;
      const row = list.createDiv({ cls: 'abyss-shortcut-row' });
      const label = row.createEl('label', {
        cls: 'abyss-shortcut-label',
        text: action.label,
      });
      const input = row.createEl('input', {
        cls: 'abyss-shortcut-input',
        attr: {
          id: `abyss-shortcut-${action.id}`,
          type: 'text',
          autocomplete: 'off',
          spellcheck: 'false',
          'data-shortcut-action': action.id,
        },
      });
      label.htmlFor = input.id;
      input.value = this.#options.shortcuts()[action.id];
      const issue = row.createDiv({
        cls: 'abyss-shortcut-issue',
        attr: { id: `abyss-shortcut-issue-${this.#options.sectionScope}-${action.id}` },
      });
      inputEls.set(action.id, input);
      issueEls.set(action.id, issue);

      input.addEventListener('input', () => {
        this.#options.shortcuts()[action.id] = input.value;
        this.#updateShortcutIssues({
          inputs: inputEls,
          messages: issueEls,
          announcementEl: validationStatus,
          announce: false,
        });
        this.#queueShortcutSave();
      });
      input.addEventListener('blur', () => {
        this.#updateShortcutIssues({
          inputs: inputEls,
          messages: issueEls,
          announcementEl: validationStatus,
          announce: true,
          announcedAction: action.id,
        });
      });
    }

    this.#updateShortcutIssues({
      inputs: inputEls,
      messages: issueEls,
      announcementEl: validationStatus,
      announce: false,
    });
  }

  #queueShortcutSave(): void {
    this.#shortcutSaveQueued = true;
    if (this.#shortcutSaveInFlight != null) return;
    this.#shortcutSaveInFlight = this.#flushShortcutSaves();
  }

  async #flushShortcutSaves(): Promise<void> {
    let failed = false;
    try {
      while (this.#shortcutSaveQueued) {
        this.#shortcutSaveQueued = false;
        try {
          await this.#options.save();
          this.#shortcutSaveFailed = false;
          this.#updateShortcutSavePresentation();
        } catch (error) {
          console.error('[abyss-tasks] Could not save shortcut settings', error);
          this.#shortcutSaveQueued = true;
          this.#shortcutSaveFailed = true;
          this.#updateShortcutSavePresentation();
          failed = true;
          break;
        }
      }
    } finally {
      this.#shortcutSaveInFlight = undefined;
      if (this.#shortcutSaveQueued && !failed) this.#queueShortcutSave();
    }
  }

  #updateShortcutIssues(update: ShortcutIssueUpdate): void {
    const validation = validateShortcuts(this.#options.shortcuts(), this.#options.platform);
    const messages = new Set<string>();
    if (!update.announce) update.announcementEl.empty();
    for (const action of SHORTCUT_ACTIONS) {
      const message = this.#shortcutIssueMessage(action.id, update, validation);
      const shouldAnnounce = update.announce && action.id === update.announcedAction;
      if (shouldAnnounce && message !== undefined) {
        messages.add(message);
      }
    }
    if (update.announce) update.announcementEl.setText([...messages].join(' '));
  }

  #shortcutIssueMessage(
    action: ShortcutActionId,
    update: ShortcutIssueUpdate,
    validation: ReturnType<typeof validateShortcuts>,
  ): string | undefined {
    const input = update.inputs.get(action);
    const messageEl = update.messages.get(action);
    if (input == null || messageEl == null) return undefined;
    return this.#renderShortcutIssue({
      action,
      input,
      messageEl,
      issues: validation.issues.get(action) ?? [],
      active: validation.bindings.get(action) ?? [],
    });
  }

  #renderShortcutIssue(view: ShortcutIssueRender): string | undefined {
    if (view.issues.length === 0) {
      view.input.removeAttribute('aria-invalid');
      view.input.removeAttribute('aria-describedby');
      view.messageEl.empty();
      return undefined;
    }
    view.input.setAttribute('aria-invalid', 'true');
    view.input.setAttribute('aria-describedby', view.messageEl.id);
    const message = describeShortcutIssues(view.action, view.issues, view.active);
    view.messageEl.empty();
    const icon = view.messageEl.createSpan({ cls: 'abyss-shortcut-warning-icon' });
    setIcon(icon, 'triangle-alert');
    icon.setAttribute('aria-hidden', 'true');
    view.messageEl.appendText(message);
    return message;
  }

  #updateShortcutSavePresentation(): void {
    if (this.#shortcutSaveStatusEl != null) {
      this.#shortcutSaveStatusEl.setText(
        this.#shortcutSaveFailed ? 'Shortcut changes were not saved.' : '',
      );
    }
    if (this.#shortcutSaveRetryEl != null)
      this.#shortcutSaveRetryEl.hidden = !this.#shortcutSaveFailed;
  }
}
