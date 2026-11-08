import { Notice, Setting } from 'obsidian';
import type { ProviderSecrets } from '../../ai/providers/ProviderSecrets';
import { providerFailure } from '../../ai/providers/providerFailure';
import {
  DEFAULT_MODELS,
  parseProviderSettings,
  providerSchema,
  type CredentialProvider,
  type ProviderSettings,
} from '../../ai/providers/providerSettings';
import { saveSettingsDraft } from '../settingsSaveFailure';

interface ProviderSettingsPort {
  readonly settings: () => unknown;
  readonly setSettings: (value: Record<string, unknown>) => void;
  readonly save: () => Promise<void>;
  readonly secrets: ProviderSecrets;
}
const labels: Record<CredentialProvider, string> = {
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  tavily: 'Tavily',
};
/** Settings own input drafts only. Saving a credential never claims connectivity. */
export class ProviderSettingsSection {
  readonly #port: ProviderSettingsPort;
  #inputs: HTMLInputElement[] = [];
  constructor(port: ProviderSettingsPort) {
    this.#port = port;
  }
  render(container: HTMLElement): void {
    // The existing settings render context transfers only the active typed draft.
    // Leave its detached input intact until that synchronous transfer has finished.
    this.#inputs = [];
    container.empty();
    const raw = this.#port.settings();
    const { provider, model, searchValue, voice, searchProvider, editable } = displayState(raw);
    const providerRow = new Setting(container)
      .setName('Provider')
      .setDesc(
        validSettings(raw) ? '' : 'Provider settings need attention. Choose supported values.',
      )
      .addDropdown((dropdown) => {
        dropdown.selectEl.setAttribute('aria-label', 'Agent provider');
        if (provider === undefined) dropdown.addOption('', 'Choose…');
        dropdown
          .addOptions({ openrouter: 'OpenRouter', openai: 'OpenAI', anthropic: 'Anthropic' })
          .setValue(provider ?? '')
          .onChange((value) => {
            const provider = providerSchema.parse(value);
            this.update({ provider, model: DEFAULT_MODELS[provider] }, container);
          });
      });
    if (provider !== undefined) this.key(container, provider);
    this.model(container, model, editable, providerRow);
    const search = new Setting(container)
      .setName('Search provider')
      .setDesc(
        searchValue === 'agent' && provider === 'anthropic'
          ? 'Choose OpenAI or Tavily for search with Anthropic.'
          : 'Used for web research.',
      );
    search.addDropdown((dropdown) => {
      dropdown.selectEl.setAttribute('aria-label', 'Search provider');
      const supported =
        searchValue === 'agent' || searchValue === 'openai' || searchValue === 'tavily';
      if (!supported) dropdown.addOption('', 'Choose…');
      dropdown
        .addOptions({ agent: 'Same as agent', openai: 'OpenAI', tavily: 'Tavily' })
        .setValue(supported ? searchValue : '')
        .setDisabled(!editable)
        .onChange((value) => {
          if (value !== 'agent' && value !== 'openai' && value !== 'tavily') return;
          this.update({ search: value }, container);
        });
    });
    const renderedKeys = new Set<CredentialProvider>(provider === undefined ? [] : [provider]);
    if (searchProvider !== null && !renderedKeys.has(searchProvider)) {
      this.key(container, searchProvider);
      renderedKeys.add(searchProvider);
    }
    new Setting(container)
      .setName('Voice provider')
      .setDesc('Used for transcription.')
      .addDropdown((dropdown) => {
        dropdown.selectEl.setAttribute('aria-label', 'Voice provider');
        const supported = voice === 'disabled' || voice === 'openai';
        if (!supported) dropdown.addOption('', 'Choose…');
        dropdown
          .addOptions({ disabled: 'Disabled', openai: 'OpenAI' })
          .setValue(supported ? voice : '')
          .setDisabled(!editable)
          .onChange((value) => {
            if (value !== 'disabled' && value !== 'openai') return;
            this.update({ voice: value }, container);
          });
      });
    if (voice === 'openai' && !renderedKeys.has('openai')) this.key(container, 'openai');
  }
  private model(
    container: HTMLElement,
    model: string,
    editable: boolean,
    providerRow: Setting,
  ): void {
    let currentModel = model;
    new Setting(container).setName('Model').addText((text) => {
      text.inputEl.setAttribute('aria-label', 'Agent model');
      text.setValue(model).setDisabled(!editable);
      const commit = (): void => {
        const nextModel = text.getValue().trim();
        if (nextModel.length === 0 || nextModel.length > 200) {
          text.setValue(currentModel);
          return;
        }
        if (nextModel === currentModel) return;
        this.update({ model: nextModel });
        currentModel = nextModel;
        providerRow.setDesc(
          validSettings(this.#port.settings())
            ? ''
            : 'Provider settings need attention. Choose supported values.',
        );
      };
      text.inputEl.addEventListener('blur', commit);
      text.inputEl.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') commit();
      });
    });
  }
  private update(patch: Partial<ProviderSettings>, container?: HTMLElement): void {
    const raw = this.#port.settings();
    this.#port.setSettings({ ...(isRecord(raw) ? raw : {}), ...patch });
    this.save();
    if (container !== undefined) this.render(container);
  }
  private save(): void {
    saveSettingsDraft({ action: 'save provider settings', save: this.#port.save });
  }
  private key(container: HTMLElement, provider: CredentialProvider): void {
    const row = new Setting(container).setName(`${labels[provider]} API key`);
    let input: HTMLInputElement;
    let clearButton: HTMLElement | undefined;
    const status = (): void => {
      try {
        const present = this.#port.secrets.has(provider);
        if (clearButton !== undefined) clearButton.hidden = !present;
        row.setDesc(present ? 'Key saved.' : 'No key saved. Uses Obsidian secret storage.');
      } catch (error) {
        this.failure(error);
        if (clearButton !== undefined) clearButton.hidden = true;
        row.setDesc('Secret storage is unavailable.');
      }
    };
    row.addText((text) => {
      input = text.inputEl;
      input.type = 'password';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.setAttribute('aria-label', `${labels[provider]} API key`);
      text.setPlaceholder('Enter an API key');
      const commit = (): void => {
        if (input.value.trim() === '') return;
        try {
          this.#port.secrets.store(provider, input.value);
          input.value = '';
          status();
        } catch (error) {
          this.failure(error);
        }
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') commit();
      });
      this.#inputs.push(input);
    });
    row.addExtraButton((button) => {
      clearButton = button.extraSettingsEl;
      button
        .setIcon('x')
        .setTooltip('Remove saved API key')
        .onClick(() => {
          try {
            this.#port.secrets.store(provider, '');
            input.value = '';
            status();
            button.extraSettingsEl.hidden = true;
          } catch (error) {
            this.failure(error);
          }
        });
      try {
        button.extraSettingsEl.hidden = !this.#port.secrets.has(provider);
      } catch {
        button.extraSettingsEl.hidden = true;
      }
    });
    status();
  }
  private failure(error: unknown): void {
    const safe = providerFailure(error);
    console.error('[abyss-tasks] Provider key settings failed', { code: safe.code });
    new Notice(safe.message);
  }
  dispose(): void {
    for (const input of this.#inputs) input.value = '';
    this.#inputs = [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function validSettings(value: unknown): boolean {
  try {
    parseProviderSettings(value);
    return true;
  } catch {
    return false;
  }
}
function displaySettings(value: unknown): Record<string, unknown> {
  try {
    return parseProviderSettings(value);
  } catch {
    return isRecord(value) ? value : {};
  }
}
function supportedSearch(
  value: unknown,
  provider: CredentialProvider | undefined,
): 'openrouter' | 'openai' | 'tavily' | null {
  if (value === 'openai' || value === 'tavily') return value;
  if (value === 'agent' && (provider === 'openai' || provider === 'openrouter')) return provider;
  return null;
}

function displayState(raw: unknown): {
  provider: ProviderSettings['provider'] | undefined;
  model: string;
  searchValue: unknown;
  voice: unknown;
  searchProvider: ReturnType<typeof supportedSearch>;
  editable: boolean;
} {
  const settings = displaySettings(raw);
  const providerResult = providerSchema.safeParse(settings['provider']);
  const provider = providerResult.success ? providerResult.data : undefined;
  const model = typeof settings['model'] === 'string' ? settings['model'] : '';
  const searchValue = settings['search'];
  const voice = settings['voice'];
  const searchProvider = supportedSearch(searchValue, provider);
  const editable = isRecord(raw);
  return { provider, model, searchValue, voice, searchProvider, editable };
}
