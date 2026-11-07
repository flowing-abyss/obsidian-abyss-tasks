import { Notice, Setting } from 'obsidian';
import type { ProviderSecrets } from '../../ai/providers/ProviderSecrets';
import { providerFailure } from '../../ai/providers/providerFailure';
import {
  DEFAULT_MODELS,
  providerSchema,
  researchProvider,
  type CredentialProvider,
  type ProviderSettings,
} from '../../ai/providers/providerSettings';
import { saveSettingsDraft } from '../settingsSaveFailure';

interface ProviderSettingsPort {
  readonly settings: () => ProviderSettings;
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
    const settings = this.#port.settings();
    new Setting(container).setName('Provider').addDropdown((dropdown) => {
      dropdown.selectEl.setAttribute('aria-label', 'Agent provider');
      dropdown
        .addOptions({ openrouter: 'OpenRouter', openai: 'OpenAI', anthropic: 'Anthropic' })
        .setValue(settings.provider)
        .onChange((value) => {
          const provider = providerSchema.parse(value);
          settings.provider = provider;
          settings.model = DEFAULT_MODELS[provider];
          this.save();
          this.render(container);
        });
    });
    this.key(container, settings.provider);
    new Setting(container).setName('Model').addText((text) => {
      text.inputEl.setAttribute('aria-label', 'Agent model');
      text.setValue(settings.model);
      const commit = (): void => {
        const model = text.getValue().trim();
        if (model.length === 0 || model.length > 200) {
          text.setValue(settings.model);
          return;
        }
        if (model !== settings.model) {
          settings.model = model;
          this.save();
        }
      };
      text.inputEl.addEventListener('blur', commit);
      text.inputEl.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') commit();
      });
    });
    const search = new Setting(container)
      .setName('Search provider')
      .setDesc(
        researchProvider(settings) === null
          ? 'Choose OpenAI or Tavily for search with Anthropic.'
          : 'Used only for an explicit research request. Same as agent uses OpenRouter Exa or OpenAI web search.',
      );
    search.addDropdown((dropdown) => {
      dropdown.selectEl.setAttribute('aria-label', 'Search provider');
      dropdown
        .addOptions({ agent: 'Same as agent', openai: 'OpenAI', tavily: 'Tavily' })
        .setValue(settings.search)
        .onChange((value) => {
          if (value !== 'agent' && value !== 'openai' && value !== 'tavily') return;
          settings.search = value;
          this.save();
          this.render(container);
        });
    });
    const renderedKeys = new Set<CredentialProvider>([settings.provider]);
    const searchProvider = researchProvider(settings);
    if (searchProvider !== null && !renderedKeys.has(searchProvider)) {
      this.key(container, searchProvider);
      renderedKeys.add(searchProvider);
    }
    new Setting(container)
      .setName('Voice provider')
      .setDesc('Choose a transcription connection for voice input.')
      .addDropdown((dropdown) => {
        dropdown.selectEl.setAttribute('aria-label', 'Voice provider');
        dropdown
          .addOptions({ disabled: 'Disabled', openai: 'OpenAI' })
          .setValue(settings.voice)
          .onChange((value) => {
            if (value !== 'disabled' && value !== 'openai') return;
            settings.voice = value;
            this.save();
            this.render(container);
          });
      });
    if (settings.voice === 'openai' && !renderedKeys.has('openai')) this.key(container, 'openai');
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
        row.setDesc(
          present
            ? 'Key saved. Connection has not been checked.'
            : 'No key saved. Stored in Obsidian secret storage for this vault.',
        );
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
