import { Setting, type App, type DropdownComponent } from 'obsidian';
import type { ChatGptPlan } from '../../ai/providers/ChatGptPlan';
import type { ProviderModel, ProviderModelCatalog } from '../../ai/providers/ProviderModelCatalog';
import type { ProviderSecrets } from '../../ai/providers/ProviderSecrets';
import { providerFailure } from '../../ai/providers/providerFailure';
import {
  DEFAULT_MODELS,
  VOICE_MODELS,
  defaultProviderSettings,
  parseProviderSettings,
  providerSchema,
  searchProviderSchema,
  voiceProviderSchema,
  type CatalogProvider,
  type CredentialProvider,
  type ProviderSettings,
} from '../../ai/providers/providerSettings';
import {
  captureSettingsRenderContext,
  preserveSettingsScroll,
  restoreSettingsRenderContext,
} from '../settingsRenderState';
import { saveSettingsDraft } from '../settingsSaveFailure';
import { renderChatGptPlanControls } from './chatGptPlanControls';
import { renderCompatibleControls } from './compatibleProviderControls';
import { renderProviderSecret } from './providerSecretControl';

interface ProviderSettingsPort {
  readonly app: App;
  readonly settings: () => unknown;
  readonly setSettings: (value: Record<string, unknown>) => void;
  readonly save: () => Promise<void>;
  readonly secrets: ProviderSecrets;
  readonly plan?: ChatGptPlan;
  readonly models?: Pick<ProviderModelCatalog, 'list'>;
}
const labels = {
  disabled: 'Disabled',
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  'chatgpt-plan': 'ChatGPT plan',
  anthropic: 'Anthropic',
  groq: 'Groq',
  cerebras: 'Cerebras',
  tavily: 'Tavily',
  exa: 'Exa',
  firecrawl: 'Firecrawl',
  brave: 'Brave',
  'openai-compatible': 'OpenAI-compatible',
};
function providerLabels(providers: ReadonlyArray<keyof typeof labels>): Record<string, string> {
  return Object.fromEntries(providers.map((provider) => [provider, labels[provider]]));
}
const agentLabels = providerLabels(providerSchema.options);
/** Native controls own secret editing. Catalogs and loading state never enter settings. */
export class ProviderSettingsSection {
  private controller_abyssPrivate = new AbortController();
  private readonly renderedKeys_abyssPrivate = new Set<CredentialProvider>();
  private readonly catalogs_abyssPrivate = new Map<string, Promise<readonly ProviderModel[]>>();
  constructor(private readonly port_abyssPrivate: ProviderSettingsPort) {}
  render(container: HTMLElement): void {
    const context = captureSettingsRenderContext(container);
    this.dispose();
    this.controller_abyssPrivate = new AbortController();
    container.empty();
    this.renderedKeys_abyssPrivate.clear();
    const raw = this.port_abyssPrivate.settings();
    const settings = displaySettings(raw);
    for (const [name, render] of [
      [
        'LLM',
        () => {
          this.agent_abyssPrivate(container, settings, raw);
        },
      ],
      [
        'Voice',
        () => {
          this.voice_abyssPrivate(container, settings, raw);
        },
      ],
      [
        'Search',
        () => {
          this.search_abyssPrivate(container, settings, raw);
        },
      ],
    ] as const) {
      new Setting(container).setName(name).setHeading();
      render();
    }
    restoreSettingsRenderContext(container, context);
  }
  private agent_abyssPrivate(
    container: HTMLElement,
    settings: Record<string, unknown>,
    raw: unknown,
  ): void {
    const parsed = providerSchema.safeParse(settings['provider']);
    const provider = parsed.success ? parsed.data : undefined;
    const row = new Setting(container)
      .setClass('abyss-provider-picker')
      .setName('AI provider')
      .setDesc(
        validSettings(raw) ? '' : 'Provider settings need attention. Choose supported values.',
      )
      .addDropdown((dropdown) => {
        dropdown.selectEl.setAttribute('aria-label', 'Agent provider');
        if (provider === undefined) dropdown.addOption('', 'Choose…');
        dropdown
          .addOptions(agentLabels)
          .setValue(provider ?? '')
          .onChange((value) => {
            const next = providerSchema.parse(value);
            const latest = displaySettings(this.port_abyssPrivate.settings());
            const independent = latest['search'] === 'agent' ? independentSearch(latest) : {};
            this.update_abyssPrivate(
              {
                ...independent,
                provider: next,
                ...modelForProvider(next),
              },
              container,
            );
          });
      });
    if (provider === 'disabled') return;
    if (provider === 'chatgpt-plan') {
      renderChatGptPlanControls(container, this.port_abyssPrivate.plan, {
        signal: this.controller_abyssPrivate.signal,
        model: stringValue(settings['model']),
        selectModel: (value) => {
          this.update_abyssPrivate({ model: value });
        },
        refresh: () => {
          this.render(container);
        },
      });
      return;
    }
    if (provider === 'openai-compatible') {
      this.compatible_abyssPrivate(container, 'agent');
      return;
    }
    if (provider !== undefined) this.key_abyssPrivate(container, provider);
    this.model_abyssPrivate(container, {
      name: 'Agent model',
      key: 'model',
      provider,
      value: stringValue(settings['model']),
      enabled: isRecord(raw),
      row,
    });
  }
  private search_abyssPrivate(
    container: HTMLElement,
    settings: Record<string, unknown>,
    raw: unknown,
  ): void {
    const effectiveSearch =
      settings['search'] === 'agent' ? effectiveResearch(settings) : settings['search'];
    const searchProvider = searchProviderSchema.safeParse(effectiveSearch).data;
    new Setting(container).setName('Search provider').addDropdown((dropdown) => {
      dropdown.selectEl.setAttribute('aria-label', 'Search provider');
      const value =
        searchProvider ??
        (effectiveSearch === null || effectiveSearch === 'disabled' ? 'disabled' : '');
      if (value === '') dropdown.addOption('', 'Choose…');
      dropdown
        .addOptions({ disabled: 'Disabled', ...providerLabels(searchProviderSchema.options) })
        .setValue(value)
        .setDisabled(!isRecord(raw))
        .onChange((value) => {
          if (value !== 'disabled' && !searchProviderSchema.safeParse(value).success) return;
          this.update_abyssPrivate(
            {
              search: value,
              ...(value === 'openai' || value === 'openrouter'
                ? { searchModel: DEFAULT_MODELS[value] }
                : {}),
            },
            container,
          );
        });
    });
    if (searchProvider !== undefined) this.key_abyssPrivate(container, searchProvider);
    if (searchProvider === 'openai' || searchProvider === 'openrouter')
      this.model_abyssPrivate(container, {
        name: 'Search model',
        key: 'searchModel',
        provider: searchProvider,
        value: firstValue(
          settings['searchModel'],
          settings['search'] === 'agent' ? settings['model'] : DEFAULT_MODELS[searchProvider],
        ),
        enabled: isRecord(raw),
      });
  }
  private voice_abyssPrivate(
    container: HTMLElement,
    settings: Record<string, unknown>,
    raw: unknown,
  ): void {
    const agent = providerSchema.safeParse(settings['provider']).data;
    if (agent !== undefined && agent !== 'disabled')
      new Setting(container)
        .setName('Default input mode')
        .setDesc('Applies to new command sessions. Quick capture uses dictation.')
        .addDropdown((dropdown) => {
          dropdown.selectEl.setAttribute('aria-label', 'Default input mode');
          dropdown
            .addOptions({ manual: 'Dictation', continuous: 'Continuous' })
            .setValue(stringValue(settings['voiceInputMode']))
            .setDisabled(!isRecord(raw))
            .onChange((value) => {
              if (value === 'manual' || value === 'continuous')
                this.update_abyssPrivate({ voiceInputMode: value });
            });
        });
    new Setting(container)
      .setClass('abyss-provider-picker')
      .setName('Voice provider')
      .setDesc(
        settings['provider'] === 'chatgpt-plan' && settings['voice'] === 'openai'
          ? 'OpenAI transcription uses its own API key. Commands use your ChatGPT plan.'
          : '',
      )
      .addDropdown((dropdown) => {
        dropdown.selectEl.setAttribute('aria-label', 'Voice provider');
        const value = voiceProviderSchema.safeParse(settings['voice']).data ?? '';
        if (value === '') dropdown.addOption('', 'Choose…');
        dropdown
          .addOptions({
            disabled: 'Disabled',
            ...providerLabels(['openai', 'groq', 'openai-compatible']),
          })
          .setValue(value)
          .onChange((value) => {
            const next = voiceProviderSchema.safeParse(value).data;
            if (next !== undefined)
              this.update_abyssPrivate(
                {
                  voice: next,
                  ...(next === 'openai' || next === 'groq'
                    ? { voiceModel: VOICE_MODELS[next][0] }
                    : {}),
                },
                container,
              );
          });
      });
    if (settings['voice'] === 'openai-compatible') this.compatible_abyssPrivate(container, 'voice');
    if (settings['voice'] === 'openai' || settings['voice'] === 'groq') {
      this.key_abyssPrivate(container, settings['voice'], 'voice');
      this.model_abyssPrivate(container, {
        name: 'Voice model',
        key: 'voiceModel',
        provider: settings['voice'],
        value: firstValue(settings['voiceModel'], VOICE_MODELS[settings['voice']][0]),
        enabled: isRecord(raw),
      });
    }
  }
  private compatible_abyssPrivate(container: HTMLElement, role: 'agent' | 'voice'): void {
    const key = role === 'agent' ? 'compatibleAgent' : 'compatibleVoice';
    renderCompatibleControls(container, {
      app: this.port_abyssPrivate.app,
      role,
      signal: this.controller_abyssPrivate.signal,
      read: () => {
        const profile = displaySettings(this.port_abyssPrivate.settings())[key];
        return isRecord(profile) ? profile : {};
      },
      write: (profile) => {
        this.update_abyssPrivate({ [key]: profile });
      },
    });
  }
  private key_abyssPrivate(
    container: HTMLElement,
    provider: CredentialProvider,
    role?: 'voice',
  ): void {
    const previouslyShown = this.renderedKeys_abyssPrivate.has(provider);
    if (role === undefined && previouslyShown) {
      new Setting(container)
        .setName(`${labels[provider]} API key`)
        .setDesc(`Uses the ${labels[provider]} API key selected above.`);
      return;
    }
    if (role === undefined) this.renderedKeys_abyssPrivate.add(provider);
    const row = new Setting(container).setName(`${labels[provider]} API key`);
    if (role === 'voice' && previouslyShown)
      row.setDesc('You can reuse the same saved key for dictation.');
    const signal = this.controller_abyssPrivate.signal;
    const previous = providerBindingBeforeEdit(this.port_abyssPrivate, provider, role);
    renderProviderSecret(
      row,
      this.port_abyssPrivate.app,
      () => this.port_abyssPrivate.secrets.id(provider, role),
      (id) => {
        if (signal.aborted) return;
        const raw = this.port_abyssPrivate.settings();
        const bindings = editBinding(
          isRecord(raw) ? raw : {},
          { provider, role, id: id === '' ? null : id },
          previous,
        );
        this.update_abyssPrivate({ secrets: bindings }, container);
      },
    );
  }
  private model_abyssPrivate(container: HTMLElement, config: ModelConfig): void {
    const row = new Setting(container).setName(
      config.name === 'Agent model' ? 'Model' : config.name,
    );
    const state: ModelSelection = {
      value: config.value,
      epoch: 0,
    };
    row.addDropdown((select) => {
      select.selectEl.setAttribute('aria-label', config.name);
      fillModels(select, state.value, modelFallback(config), []);
      select.setDisabled(!config.enabled).onChange((value) => {
        if (value === '') return;
        state.value = value;
        const latest = displaySettings(this.port_abyssPrivate.settings());
        const independent =
          config.key === 'model' && latest['search'] === 'agent' ? independentSearch(latest) : {};
        this.update_abyssPrivate({
          ...independent,
          ...(config.key === 'searchModel' ? { search: config.provider } : {}),
          [config.key]: value,
        });
        config.row?.setDesc(
          validSettings(this.port_abyssPrivate.settings())
            ? ''
            : 'Provider settings need attention. Choose supported values.',
        );
      });
      const load = (refresh = false): void => {
        preserveSettingsScroll(row.settingEl, () => {
          this.loadModels_abyssPrivate({ row, select, config, state }, refresh);
        });
      };
      row.addExtraButton((button) =>
        button
          .setIcon('refresh-cw')
          .setTooltip('Refresh models')
          .onClick(() => {
            load(true);
          }),
      );
      load();
    });
  }
  private catalogKey_abyssPrivate(
    row: Setting,
    provider: CatalogProvider,
    role?: 'voice',
  ): string | undefined {
    try {
      const id = this.port_abyssPrivate.secrets.connectedId(provider, role);
      if (id !== null) return `${provider}:${id}`;
      row.setDesc('Choose an API key to load models.');
    } catch (error) {
      row.setDesc(providerFailure(error).message);
    }
    return undefined;
  }
  private loadModels_abyssPrivate(context: ModelContext, refresh: boolean): void {
    const { row, select, config, state } = context;
    const provider = config.provider,
      ticket = ++state.epoch;
    if (provider === undefined || this.port_abyssPrivate.models === undefined) return;
    const role = config.key === 'voiceModel' ? 'voice' : undefined;
    const key = this.catalogKey_abyssPrivate(row, provider, role);
    if (key === undefined) return;
    const signal = this.controller_abyssPrivate.signal;
    row.setDesc('Loading models…');
    let request = refresh ? undefined : this.catalogs_abyssPrivate.get(key);
    if (request === undefined) {
      request = this.port_abyssPrivate.models.list(provider, signal, role);
      this.catalogs_abyssPrivate.set(key, request);
    }
    const renderCurrent = (render: () => void): void => {
      if (!signal.aborted && ticket === state.epoch) preserveSettingsScroll(row.settingEl, render);
    };
    void request.then(
      (models) => {
        renderCurrent(() => {
          const choices = eligibleModels(models, config);
          fillModels(select, state.value, modelFallback(config), choices);
          row.setDesc(
            choices.length === 0
              ? 'No matching models returned. The saved choice is retained.'
              : '',
          );
        });
      },
      (error) => {
        renderCurrent(() => {
          const safe = providerFailure(error);
          row.setDesc(`Could not load models. ${safe.message}`);
          console.error('[abyss-tasks] Model catalog failed', { provider, code: safe.code });
        });
      },
    );
  }
  private update_abyssPrivate(patch: Record<string, unknown>, container?: HTMLElement): void {
    const raw = this.port_abyssPrivate.settings();
    this.port_abyssPrivate.setSettings({ ...(isRecord(raw) ? raw : {}), ...patch });
    saveSettingsDraft({ action: 'save provider settings', save: this.port_abyssPrivate.save });
    if (container !== undefined) this.render(container);
  }
  dispose(): void {
    this.controller_abyssPrivate.abort();
    this.catalogs_abyssPrivate.clear();
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
type PriorBinding = { readonly id: string | null; readonly retainedId: string | null };
type BindingEdit = {
  readonly provider: CredentialProvider;
  readonly role: 'voice' | undefined;
  readonly id: string | null;
};
function secretBindings(settings: Record<string, unknown>): Record<string, unknown> {
  const bindings = settings['secrets'];
  return isRecord(bindings) ? bindings : {};
}
function providerBindingBeforeEdit(
  port: ProviderSettingsPort,
  provider: CredentialProvider,
  role: 'voice' | undefined,
): PriorBinding | undefined {
  const settings = port.settings();
  if (!isRecord(settings)) return;
  const bindings = secretBindings(settings);
  const implicit = bindings[provider] === undefined;
  const inherited = inheritsVoiceBinding(settings, bindings['voice'] ?? {}, provider);
  if (role === 'voice' ? !implicit : !inherited) return;
  try {
    const id = port.secrets.id(provider);
    if (!implicit) return { id, retainedId: id };
    // The native chooser may create the implicit default before delivering its ID.
    const selected =
      inherited || settings['provider'] === provider || settings['search'] === provider;
    const retainedId = selected ? port.secrets.connectedId(provider) : null;
    return { id, retainedId };
  } catch {
    return undefined; // A broken sibling binding must remain editable independently.
  }
}
function inheritsVoiceBinding(
  settings: Record<string, unknown>,
  voice: unknown,
  provider: CredentialProvider,
): voice is Record<string, unknown> {
  return settings['voice'] === provider && isRecord(voice) && voice[provider] === undefined;
}
function editBinding(
  settings: Record<string, unknown>,
  edit: BindingEdit,
  previous: PriorBinding | undefined,
): Record<string, unknown> {
  const { provider, role, id } = edit;
  const bindings = secretBindings(settings);
  const voice = bindings['voice'] ?? {};
  if (role === 'voice') {
    return {
      ...bindings,
      ...keepUnconnectedBinding(bindings, edit, previous),
      voice: { ...(isRecord(voice) ? voice : {}), [provider]: id },
    };
  }
  const inherited = previous !== undefined && inheritsVoiceBinding(settings, voice, provider);
  return {
    ...bindings,
    [provider]: id,
    ...(inherited ? { voice: { ...voice, [provider]: previous.retainedId } } : {}),
  };
}
function keepUnconnectedBinding(
  bindings: Record<string, unknown>,
  { provider, id }: BindingEdit,
  previous: PriorBinding | undefined,
): Record<string, null> {
  return bindings[provider] === undefined &&
    id !== null &&
    previous?.id === id &&
    previous.retainedId === null
    ? { [provider]: null }
    : {};
}
function modelForProvider(provider: ProviderSettings['provider']): { model?: string } {
  if (provider === 'openai-compatible') return {};
  return {
    model: provider === 'chatgpt-plan' || provider === 'disabled' ? '' : DEFAULT_MODELS[provider],
  };
}
function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
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
    return isRecord(value) ? { ...defaultProviderSettings(), ...value } : {};
  }
}
function effectiveResearch(settings: Record<string, unknown>): 'openai' | 'openrouter' | null {
  const provider = settings['provider'];
  return provider === 'openai' || provider === 'openrouter' ? provider : null;
}
function independentSearch(settings: Record<string, unknown>): Partial<ProviderSettings> {
  const provider = effectiveResearch(settings);
  return {
    search: provider ?? 'disabled',
    ...(provider === null
      ? {}
      : {
          searchModel: firstValue(
            settings['searchModel'],
            firstValue(settings['model'], DEFAULT_MODELS[provider]),
          ),
        }),
  };
}

interface ModelConfig {
  readonly name: string;
  readonly key: 'model' | 'searchModel' | 'voiceModel';
  readonly provider: CatalogProvider | undefined;
  readonly value: string;
  readonly enabled: boolean;
  readonly row?: Setting;
}
interface ModelSelection {
  value: string;
  epoch: number;
}
interface ModelContext {
  readonly row: Setting;
  readonly select: DropdownComponent;
  readonly config: ModelConfig;
  readonly state: ModelSelection;
}
function firstValue(value: unknown, fallback: unknown): string {
  const current = stringValue(value);
  return current === '' ? stringValue(fallback) : current;
}
function modelFallback({ key, provider }: ModelConfig): string {
  if (key === 'voiceModel')
    return provider === 'groq' ? 'whisper-large-v3-turbo' : 'gpt-transcribe';
  return provider === undefined ? '' : DEFAULT_MODELS[provider];
}
function eligibleModels(
  models: readonly ProviderModel[],
  config: ModelConfig,
): readonly ProviderModel[] {
  if (config.key === 'voiceModel') {
    const allowed: readonly string[] = VOICE_MODELS[config.provider === 'groq' ? 'groq' : 'openai'];
    return models.filter((model) => allowed.includes(model.id));
  }
  return models.filter(
    (model) => !/(?:whisper|transcrib|embedding|tts|realtime|moderation|dall-e)/iu.test(model.id),
  );
}
function fillModels(
  select: DropdownComponent,
  current: string,
  fallback: string,
  choices: readonly ProviderModel[],
): void {
  select.selectEl.replaceChildren();
  if (current === '') select.addOption('', 'Choose…');
  const models = new Map<string, string>();
  if (fallback !== '') models.set(fallback, fallback);
  if (current !== '') models.set(current, current);
  for (const model of choices) models.set(model.id, model.name);
  for (const [id, name] of models) select.addOption(id, name);
  select.setValue(current);
}
