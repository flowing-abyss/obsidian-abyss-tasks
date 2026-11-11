import { Setting, type DropdownComponent } from 'obsidian';
import type { ChatGptPlan, ChatGptPlanState } from '../../ai/providers/ChatGptPlan';
import type { ProviderModel } from '../../ai/providers/ProviderModelCatalog';
import { ProviderFailure, providerFailure } from '../../ai/providers/providerFailure';
import { preserveSettingsScroll } from '../settingsRenderState';

type PlanPort = Pick<ChatGptPlan, 'state' | 'select' | 'signIn' | 'signOut' | 'list'>;
interface PlanControls {
  readonly signal: AbortSignal;
  readonly model: string;
  readonly selectModel: (value: string) => void;
  readonly refresh: () => void;
}
type StartAction = (work: () => Promise<void>, label: string, clearModel?: boolean) => void;
export function renderChatGptPlanControls(
  container: HTMLElement,
  plan: PlanPort | undefined,
  controls: PlanControls,
): void {
  const account = new Setting(container).setName('Account');
  let state: ChatGptPlanState | undefined;
  try {
    state = plan?.state();
  } catch (error) {
    account.setDesc(providerFailure(error).message);
    return;
  }
  if (plan === undefined || state?.desktop !== true) {
    account.setDesc(new ProviderFailure('plan-desktop').message);
    return;
  }
  const run = accountAction(account, controls);
  renderAccounts(account, { plan, state, signal: controls.signal, run });
  if (!state.ready) return;
  account.addButton((button) =>
    button.setButtonText('Manage usage').onClick(() => {
      container.ownerDocument.defaultView?.open(
        'https://chatgpt.com/settings/usage',
        '_blank',
        'noopener,noreferrer',
      );
    }),
  );
  const row = new Setting(container).setName('Model');
  row.addDropdown((dropdown) => {
    renderModels(row, dropdown, plan, controls);
  });
}
function accountAction(account: Setting, controls: PlanControls): StartAction {
  let busy = false;
  const setBusy = (next: boolean): void => {
    busy = next;
    for (const control of account.controlEl.querySelectorAll<HTMLButtonElement | HTMLSelectElement>(
      'button, select',
    ))
      control.disabled = next;
  };
  return (work, label, clearModel = false) => {
    if (busy) return;
    setBusy(true);
    preserveSettingsScroll(account.settingEl, () => {
      account.setDesc(label);
    });
    void work().then(
      () => {
        if (controls.signal.aborted) return;
        if (clearModel) controls.selectModel('');
        controls.refresh();
      },
      (cause) => {
        if (controls.signal.aborted) return;
        const error = providerFailure(cause);
        if (error.code === 'plan-revoke') {
          const container = account.settingEl.parentElement;
          controls.refresh();
          if (container !== null)
            preserveSettingsScroll(container, () => {
              new Setting(container).setDesc(error.message);
            });
          return;
        }
        setBusy(false);
        preserveSettingsScroll(account.settingEl, () => {
          account.setDesc(error.message);
        });
      },
    );
  };
}
function renderAccounts(
  row: Setting,
  context: { plan: PlanPort; state: ChatGptPlanState; signal: AbortSignal; run: StartAction },
): void {
  const { plan, state, signal, run } = context;
  if (state.accounts.length > 0) {
    row.addDropdown((dropdown) => {
      dropdown.selectEl.setAttribute('aria-label', 'Subscription account');
      for (const profile of state.accounts) dropdown.addOption(profile.client, profile.label);
      dropdown.setValue(state.active ?? '').onChange((value) => {
        run(() => plan.select(value, signal), 'Switching accounts…', true);
      });
    });
    row.addButton((button) =>
      button.setButtonText('Add account').onClick(() => {
        run(() => plan.signIn(undefined, signal), 'Waiting for browser sign-in…', true);
      }),
    );
  }
  if (state.ready) row.setDesc('Using your subscription');
  else {
    row.setDesc(
      state.connected
        ? 'Allow Abyss Tasks to use this ChatGPT plan.'
        : 'Use your ChatGPT plan for commands. Your browser will ask for permission.',
    );
    row.addButton((button) =>
      button
        .setButtonText(state.connected ? 'Enable plan usage' : 'Continue with ChatGPT')
        .setCta()
        .onClick(() => {
          run(() => plan.signIn(state.active ?? undefined, signal), 'Waiting for browser sign-in…');
        }),
    );
  }
  if (state.connected)
    row.addButton((button) =>
      button.setButtonText('Sign out').onClick(() => {
        run(() => plan.signOut(signal, state.active), 'Signing out…');
      }),
    );
}
function renderModels(
  row: Setting,
  dropdown: DropdownComponent,
  plan: PlanPort,
  controls: PlanControls,
): void {
  let current = controls.model;
  dropdown.selectEl.setAttribute('aria-label', 'Agent model');
  dropdown
    .setDisabled(true)
    .addOption('', 'Choose a model…')
    .onChange((value) => {
      if (value !== '') {
        current = value;
        controls.selectModel(value);
      }
    });
  let ticket = 0;
  const load = (): void => {
    const sequence = ++ticket;
    preserveSettingsScroll(row.settingEl, () => {
      row.setDesc('Loading models…');
    });
    void plan.list(controls.signal).then(
      (models) => {
        if (controls.signal.aborted || sequence !== ticket) return;
        preserveSettingsScroll(row.settingEl, () => {
          const unavailable = fillPlanModels(row, dropdown, models, current);
          if (unavailable) {
            current = '';
            controls.selectModel('');
          }
        });
      },
      (cause) => {
        if (!controls.signal.aborted && sequence === ticket)
          preserveSettingsScroll(row.settingEl, () => {
            row.setDesc(providerFailure(cause).message);
          });
      },
    );
  };
  row.addExtraButton((button) =>
    button.setIcon('refresh-cw').setTooltip('Refresh models').onClick(load),
  );
  load();
}
function fillPlanModels(
  row: Setting,
  dropdown: DropdownComponent,
  models: readonly ProviderModel[],
  initial: string,
): boolean {
  const selected = dropdown.getValue();
  const saved = selected === '' ? initial : selected;
  dropdown.selectEl.replaceChildren();
  dropdown.addOption('', 'Choose a model…');
  for (const { id, name } of models) dropdown.addOption(id, name);
  const selectable = models.some((model) => model.id === saved);
  dropdown.setValue(selectable ? saved : '').setDisabled(models.length === 0);
  let description = '';
  if (models.length === 0) description = 'No models are available for this account.';
  else if (saved !== '' && !selectable)
    description = 'The saved model is unavailable for this account. Choose another model.';
  row.setDesc(description);
  return saved !== '' && !selectable;
}
