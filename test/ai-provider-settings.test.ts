import { SecretComponent } from 'obsidian';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { NativeProviderTransport } from '../src/ai/providers/NativeProviderTransport';
import { ProviderConnections } from '../src/ai/providers/ProviderConnections';
import { ProviderSecrets } from '../src/ai/providers/ProviderSecrets';
import {
  defaultProviderSettings,
  parseProviderSettings,
} from '../src/ai/providers/providerSettings';
import { ProviderSettingsSection } from '../src/settings/sections/ProviderSettingsSection';
import { createAppWithFiles, deferred, expectDefined, flushMicrotasks } from './helpers';

afterEach(() => vi.restoreAllMocks());
async function setup(
  models?: ConstructorParameters<typeof ProviderSettingsSection>[0]['models'],
  initial: Record<string, unknown> = parseProviderSettings({ provider: 'openrouter' }),
) {
  const app = await createAppWithFiles({});
  let settings: Record<string, unknown> = {
    ...initial,
    extension: { keep: true },
  };
  const values = new Map([['abyss-tasks-openrouter-api-key', 'synthetic-private-key']]);
  const reads: string[] = [];
  const secrets = new ProviderSecrets(
    {
      getSecret: (id) => {
        reads.push(id);
        return values.get(id) ?? null;
      },
      setSecret: (id, value) => {
        values.set(id, value);
      },
    },
    () => settings['secrets'],
  );
  const save = vi.fn(async () => undefined);
  const transport = new NativeProviderTransport(
    async () => {
      throw new Error('Opening settings must not send an inference request');
    },
    () => () => {},
  );
  const connections = new ProviderConnections(secrets, transport);
  onTestFinished(() => {
    transport.dispose();
  });
  const section = new ProviderSettingsSection({
    app,
    settings: () => settings,
    setSettings: (value) => {
      settings = value;
    },
    save,
    secrets,
    ...(models === undefined ? {} : { models }),
  });
  const container = createDiv();
  const select = (label: string) =>
    expectDefined(container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`));
  const change = (label: string, value: string) => {
    const element = select(label);
    element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  };
  return {
    app,
    section,
    container,
    secrets,
    values,
    reads,
    save,
    availability: () => connections.availability(settings),
    select,
    change,
    get settings() {
      return settings;
    },
  };
}
it.each([{}, { groq: 'llm-only' }])(
  'opening Voice-only settings reads only the selected speech credential with stored bindings %j',
  async (common) => {
    const h = await setup(
      { list: async () => [{ id: 'whisper-large-v3-turbo', name: 'Speech model' }] },
      {
        provider: 'disabled',
        voice: 'groq',
        search: 'disabled',
        secrets: { ...common, voice: { groq: 'speech-only' } },
      },
    );
    h.values.set('llm-only', 'synthetic-llm');
    h.values.set('abyss-tasks-groq-api-key', 'synthetic-legacy-llm');
    h.values.set('speech-only', 'synthetic-speech');
    h.section.render(h.container);
    await flushMicrotasks(0);
    expect(h.select('Voice model').selectedOptions[0]?.textContent).toBe('Speech model');
    expect(new Set(h.reads)).toEqual(new Set(['speech-only']));
    h.section.dispose();
  },
);
it('connects Voice on a fresh install without activating an LLM or exposing LLM model controls', async () => {
  const changes = vi.spyOn(SecretComponent.prototype, 'onChange');
  const h = await setup(undefined, defaultProviderSettings());
  h.section.render(h.container);
  expect(h.select('Agent provider').value).toBe('disabled');
  expect(h.container.querySelector('[aria-label="Agent model"]')).toBeNull();
  expect(h.container.querySelector('[aria-label="Default input mode"]')).toBeNull();
  h.change('Voice provider', 'groq');
  h.values.set('saved-speech-key', 'synthetic-speech-key');
  await expectDefined(changes.mock.calls[changes.mock.calls.length - 1]?.[0])('saved-speech-key');
  expect(h.select('Voice model').value).toBe('whisper-large-v3-turbo');
  expect(h.availability()).toEqual({ agent: false, voice: true });
  expect(h.settings['secrets']).toEqual({ voice: { groq: 'saved-speech-key' } });
  expect(h.settings['extension']).toEqual({ keep: true });
  h.section.dispose();
});
it('keeps a Voice key selection independent until the LLM explicitly selects the same saved secret', async () => {
  const changes = vi.spyOn(SecretComponent.prototype, 'onChange');
  const h = await setup(
    undefined,
    parseProviderSettings({ provider: 'openai', search: 'disabled' }),
  );
  h.section.render(h.container);
  h.change('Voice provider', 'openai');
  h.values.set('shared', 'synthetic-shared-key');
  await expectDefined(changes.mock.calls[changes.mock.calls.length - 1]?.[0])('shared');
  expect(h.availability()).toEqual({ agent: false, voice: true });
  await expectDefined(changes.mock.calls[changes.mock.calls.length - 2]?.[0])('shared');
  expect(h.availability()).toEqual({ agent: true, voice: true });
  await expectDefined(changes.mock.calls[changes.mock.calls.length - 1]?.[0])(null);
  expect(h.availability()).toEqual({ agent: true, voice: false });
  expect(h.settings['secrets']).toEqual({ openai: 'shared', voice: { openai: null } });
  expect(h.values.get('shared')).toBe('synthetic-shared-key');
  h.change('Agent provider', 'disabled');
  expect(h.availability()).toEqual({ agent: false, voice: false });
  expect(h.container.querySelector('[aria-label="Agent model"]')).toBeNull();
  h.section.dispose();
});
it('creating a speech secret under the old default key name does not activate an unconnected LLM', async () => {
  const changes = vi.spyOn(SecretComponent.prototype, 'onChange');
  const h = await setup(
    undefined,
    parseProviderSettings({ provider: 'groq', voice: 'groq', search: 'disabled' }),
  );
  h.section.render(h.container);
  expect(h.availability()).toEqual({ agent: false, voice: false });
  // The native chooser creates the named secret before notifying the plugin of its selected ID.
  h.values.set('abyss-tasks-groq-api-key', 'synthetic-speech');
  await expectDefined(changes.mock.calls[changes.mock.calls.length - 1]?.[0])(
    'abyss-tasks-groq-api-key',
  );
  expect(h.availability()).toEqual({ agent: false, voice: true });
  h.section.dispose();
});
it('keeps a default-named speech secret from connecting a later LLM provider choice on first use', async () => {
  const changes = vi.spyOn(SecretComponent.prototype, 'onChange');
  const h = await setup(undefined, defaultProviderSettings());
  h.section.render(h.container);
  h.change('Voice provider', 'groq');
  h.values.set('abyss-tasks-groq-api-key', 'synthetic-speech');
  await expectDefined(changes.mock.calls[changes.mock.calls.length - 1]?.[0])(
    'abyss-tasks-groq-api-key',
  );
  h.change('Agent provider', 'groq');
  expect(h.availability()).toEqual({ agent: false, voice: true });
  await expectDefined(changes.mock.calls[changes.mock.calls.length - 2]?.[0])(
    'abyss-tasks-groq-api-key',
  );
  expect(h.availability()).toEqual({ agent: true, voice: true });
  h.section.dispose();
});
it.each([null, 'another-key'])(
  'changing an older shared LLM binding to %s keeps its former speech connection',
  async (replacement) => {
    const changes = vi.spyOn(SecretComponent.prototype, 'onChange');
    const h = await setup(
      undefined,
      parseProviderSettings({
        provider: 'openai',
        voice: 'openai',
        search: 'disabled',
        secrets: { openai: 'saved', extension: 5 },
      }),
    );
    h.values.set('saved', 'synthetic-shared');
    h.values.set('another-key', 'synthetic-other');
    h.section.render(h.container);
    expect(h.availability()).toEqual({ agent: true, voice: true });
    await expectDefined(changes.mock.calls[0]?.[0])(replacement);
    expect(h.availability()).toEqual({ agent: replacement !== null, voice: true });
    expect(h.settings['secrets']).toEqual({
      openai: replacement,
      voice: { openai: 'saved' },
      extension: 5,
    });
    h.section.dispose();
  },
);
it('retains an older named Voice binding when its secret is temporarily unavailable on this device', async () => {
  const changes = vi.spyOn(SecretComponent.prototype, 'onChange');
  const h = await setup(undefined, {
    provider: 'groq',
    voice: 'groq',
    search: 'disabled',
    secrets: { groq: 'previously-selected-account' },
  });
  h.values.set('agent-account', 'synthetic-agent');
  h.section.render(h.container);
  await expectDefined(changes.mock.calls[0]?.[0])('agent-account');
  expect(h.availability()).toEqual({ agent: true, voice: false });
  expect(h.secrets.id('groq', 'voice')).toBe('previously-selected-account');
  h.values.set('previously-selected-account', 'restored-synthetic-speech');
  expect(h.availability()).toEqual({ agent: true, voice: true });
  h.section.dispose();
});
it('repairs the Voice binding even when the older LLM provider and its shared binding are invalid', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const changes = vi.spyOn(SecretComponent.prototype, 'onChange');
  const h = await setup(undefined, {
    provider: 'unsupported',
    model: '',
    voice: 'openai',
    secrets: { openai: 42 },
    search: 'disabled',
  });
  h.section.render(h.container);
  expect(changes.mock.calls).toHaveLength(1);
  h.values.set('speech-only', 'synthetic-speech');
  await expectDefined(changes.mock.calls[0]?.[0])('speech-only');
  expect(h.availability()).toEqual({ agent: false, voice: true });
  expect(h.settings).toMatchObject({
    provider: 'unsupported',
    model: '',
    secrets: { openai: 42, voice: { openai: 'speech-only' } },
  });
  h.section.dispose();
});
it('loads Voice models with the speech account when the same provider has a different LLM account', async () => {
  const list = vi.fn(async (_provider: string, _signal: AbortSignal, role?: 'voice') =>
    role === 'voice'
      ? [{ id: 'whisper-large-v3', name: 'Voice account model' }]
      : [{ id: 'agent-model', name: 'Agent account model' }],
  );
  const h = await setup(
    { list },
    parseProviderSettings({
      provider: 'groq',
      voice: 'groq',
      search: 'disabled',
      secrets: { groq: 'llm-key', voice: { groq: 'speech-key' } },
    }),
  );
  h.values.set('llm-key', 'synthetic-agent');
  h.values.set('speech-key', 'synthetic-speech');
  h.section.render(h.container);
  await flushMicrotasks(0);
  expect(h.select('Agent model').querySelector('option[value="agent-model"]')?.textContent).toBe(
    'Agent account model',
  );
  expect(
    h.select('Voice model').querySelector('option[value="whisper-large-v3"]')?.textContent,
  ).toBe('Voice account model');
  h.section.dispose();
});
it('uses the native secret chooser and persists only its ID without erasing a shared secret', async () => {
  const selected = vi.spyOn(SecretComponent.prototype, 'setValue');
  const changes = vi.spyOn(SecretComponent.prototype, 'onChange');
  const h = await setup();
  h.section.render(h.container);
  expect(selected).toHaveBeenCalledWith('abyss-tasks-openrouter-api-key');
  expect(h.container.querySelector('input[type=password]')).toBeNull();
  await expectDefined(changes.mock.calls[0]?.[0])('shared-key');
  expect(h.settings).toMatchObject({
    secrets: { openrouter: 'shared-key' },
    extension: { keep: true },
  });
  await expectDefined(changes.mock.calls[changes.mock.calls.length - 1]?.[0])(null);
  expect(h.settings).toMatchObject({ secrets: { openrouter: null } });
  expect(h.values.get('abyss-tasks-openrouter-api-key')).toBe('synthetic-private-key');
  expect(JSON.stringify(h.settings)).not.toContain('synthetic-private-key');
  h.section.dispose();
});
it('keeps voice and search independent when switching the agent and uses readable provider defaults', async () => {
  const h = await setup();
  h.section.render(h.container);
  h.change('Search provider', 'tavily');
  h.change('Voice provider', 'openai');
  h.change('Agent provider', 'cerebras');
  expect(h.settings).toMatchObject({
    provider: 'cerebras',
    model: 'qwen-3.8-27b',
    search: 'tavily',
    voice: 'openai',
    extension: { keep: true },
  });
  expect(h.select('Agent model').value).toBe('qwen-3.8-27b');
  expect(h.container.querySelector('input')).toBeNull();
  h.section.dispose();
});

function mountProviderTab(container: HTMLElement): HTMLElement {
  const host = document.body.createDiv({ cls: 'vertical-tab-content-container' });
  const tab = host.createDiv({ cls: 'vertical-tab-content abyss-settings-tab' });
  tab.createDiv({ attr: { 'data-section-title': 'Command mode' } }).append(container);
  onTestFinished(() => {
    host.remove();
  });
  return tab;
}

it('retains the native settings offset and focused picker when a provider rebuilds its controls', async () => {
  const h = await setup();
  const tab = mountProviderTab(h.container);
  h.section.render(h.container);
  h.select('Agent provider').focus();
  tab.scrollTop = 274.75;
  // Native dropdowns measure layout while the emptied provider section is being rebuilt.
  const empty = h.container.empty.bind(h.container);
  vi.spyOn(h.container, 'empty').mockImplementation(() => {
    empty();
    tab.scrollTop = 0;
  });

  h.change('Agent provider', 'openai-compatible');

  expect(h.select('Agent provider').value).toBe('openai-compatible');
  expect(tab.scrollTop).toBe(274.75);
  expect(tab.ownerDocument.activeElement).toBe(h.select('Agent provider'));
  h.section.dispose();
});

it('retains the latest settings offset when a pending catalog repaints after an ordinary input change', async () => {
  const pending = deferred<ReadonlyArray<{ id: string; name: string }>>();
  const h = await setup({ list: () => pending.promise });
  const tab = mountProviderTab(h.container);
  h.section.render(h.container);
  tab.scrollTop = 320;
  const mode = h.select('Default input mode');
  mode.focus();
  h.change('Default input mode', 'continuous');
  expect(tab.scrollTop).toBe(320);

  tab.scrollTop = 471.5;
  const select = h.select('Agent model');
  const replace = select.replaceChildren.bind(select);
  vi.spyOn(select, 'replaceChildren').mockImplementation((...children) => {
    replace(...children);
    tab.scrollTop = 0;
  });
  pending.resolve([{ id: 'available', name: 'Available' }]);
  await flushMicrotasks(0);

  expect(select.querySelector('option[value="available"]')).not.toBeNull();
  expect(tab.scrollTop).toBe(471.5);
  expect(tab.ownerDocument.activeElement).toBe(mode);
  h.section.dispose();
});

it('loads provider models without changing the current selection and discards a late catalog', async () => {
  const pending = deferred<ReadonlyArray<{ id: string; name: string }>>();
  const list = vi.fn(() => pending.promise);
  const h = await setup({ list });
  h.section.render(h.container);
  expect(list).toHaveBeenCalledWith('openrouter', expect.any(AbortSignal), undefined);
  h.change('Agent provider', 'cerebras');
  pending.resolve([{ id: 'foreign-model', name: 'Foreign model' }]);
  await flushMicrotasks(0);
  expect(h.select('Agent model').querySelector('option[value="foreign-model"]')).toBeNull();
  expect(h.settings['model']).toBe('qwen-3.8-27b');
  h.section.dispose();
});
it('offers discovered models as a dropdown and keeps the saved value when discovery fails', async () => {
  const h = await setup({ list: async () => [{ id: 'provider/new-model', name: 'New model' }] });
  h.section.render(h.container);
  await flushMicrotasks(0);
  expect(h.select('Agent model').value).toBe('openai/gpt-6-luna');
  h.change('Agent model', 'provider/new-model');
  expect(h.settings['model']).toBe('provider/new-model');
  h.section.dispose();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const failure = await setup({
    list: async () => {
      throw new Error('private remote body');
    },
  });
  failure.section.render(failure.container);
  await flushMicrotasks(0);
  expect(failure.select('Agent model').value).toBe('openai/gpt-6-luna');
  expect(failure.container.textContent).not.toContain('private remote body');
  expect(failure.container.textContent).toContain('Could not load models');
  failure.section.dispose();
});

it('lists each saved, default and discovered model once with its provider label', async () => {
  const h = await setup({
    list: async () => [{ id: 'openai/gpt-6-luna', name: 'Luna' }],
  });
  h.section.render(h.container);
  await flushMicrotasks(0);
  expect([...h.select('Agent model').options].map((option) => [option.value, option.text])).toEqual(
    [['openai/gpt-6-luna', 'Luna']],
  );
  h.section.dispose();
});

it.each(['success', 'failure'] as const)(
  'ignores an older catalog %s after refresh',
  async (outcome) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const old = deferred<ReadonlyArray<{ id: string; name: string }>>();
    const oldRequest = old.promise.then((models) => {
      if (outcome === 'failure') throw new Error('Old failure');
      return models;
    });
    const fresh = deferred<ReadonlyArray<{ id: string; name: string }>>();
    const list = vi.fn().mockReturnValueOnce(oldRequest).mockReturnValueOnce(fresh.promise);
    const h = await setup({ list });
    h.section.render(h.container);
    const row = expectDefined(h.select('Agent model').closest('.setting-item'));
    expectDefined(row.querySelector<HTMLElement>('.extra-setting-button')).click();
    fresh.resolve([{ id: 'fresh', name: 'Fresh' }]);
    await flushMicrotasks(0);
    old.resolve([{ id: 'obsolete', name: 'Obsolete' }]);
    await flushMicrotasks(0);
    expect(h.select('Agent model').querySelector('option[value=obsolete]')).toBeNull();
    expect(h.select('Agent model').querySelector('option[value=fresh]')).not.toBeNull();
    expect(row.textContent).not.toContain('Could not load models');
    h.section.dispose();
  },
);

it('freezes legacy implicit search on agent edits and preserves an explicitly chosen search model', async () => {
  const h = await setup({ list: async () => [{ id: 'alternative', name: 'Alternative' }] });
  h.section.render(h.container);
  await flushMicrotasks(0);
  const search = h.select('Search model').value;
  h.change('Agent model', 'alternative');
  expect(h.settings).toMatchObject({
    search: 'openrouter',
    searchModel: search,
    model: 'alternative',
  });
  expect(h.select('Search model').value).toBe(search);
  h.change('Search model', 'alternative');
  h.change('Agent provider', 'cerebras');
  expect(h.settings).toMatchObject({ search: 'openrouter', searchModel: 'alternative' });
  h.section.dispose();
});

it('groups provider controls and saves the voice default independently with shared-key guidance', async () => {
  const h = await setup();
  h.section.render(h.container);
  expect(
    [...h.container.querySelectorAll('.setting-item-heading .setting-item-name')].map(
      (el) => el.textContent,
    ),
  ).toEqual(['LLM', 'Voice', 'Search']);
  expect(h.select('Default input mode').value).toBe('manual');
  h.change('Default input mode', 'continuous');
  h.change('Agent provider', 'openai');
  h.change('Voice provider', 'openai');
  expect(h.settings).toMatchObject({ voiceInputMode: 'continuous', extension: { keep: true } });
  expect(h.container.textContent).toContain('You can reuse the same saved key for dictation.');
  expect(h.select('Default input mode').value).toBe('continuous');
  h.section.dispose();
});

it.each(['exa', 'firecrawl', 'brave'])(
  'selects %s search with its native secret chooser and no search model catalog',
  async (provider) => {
    const selected = vi.spyOn(SecretComponent.prototype, 'setValue');
    const h = await setup();
    h.section.render(h.container);
    h.change('Search provider', provider);
    expect(h.settings).toMatchObject({
      search: provider,
      provider: 'openrouter',
      extension: { keep: true },
    });
    expect(h.container.querySelector('select[aria-label="Search model"]')).toBeNull();
    expect(selected).toHaveBeenCalledWith(`abyss-tasks-${provider}-api-key`);
    h.change('Agent provider', 'cerebras');
    expect(h.settings).toMatchObject({ search: provider, provider: 'cerebras' });
    expect(h.container.querySelector('select[aria-label="Search model"]')).toBeNull();
    h.section.dispose();
  },
);

it('keeps two independent compatible profiles with explicit model IDs and endpoint-bound optional secrets', async () => {
  const h = await setup({ list: async () => [] });
  const changes = vi.spyOn(SecretComponent.prototype, 'onChange');
  h.section.render(h.container);
  h.change('Search provider', 'disabled');
  h.change('Agent provider', 'openai-compatible');
  h.change('Voice provider', 'openai-compatible');
  const input = (name: string) =>
    expectDefined(h.container.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`));
  const edit = (name: string, value: string) => {
    const field = input(name);
    field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  };
  expect(input('Agent API base URL').value).toBe('');
  expect(input('Agent model').value).toBe('');
  edit('Agent API base URL', 'http://localhost:11434/v1');
  edit('Agent model', 'qwen3:4b');
  edit('Voice API base URL', 'http://localhost:8080/asr/v1');
  edit('Voice model', 'whisper-1');
  const handlers = changes.mock.calls;
  const agentKey = expectDefined(handlers[handlers.length - 2]?.[0]);
  await agentKey('agent-id');
  await expectDefined(changes.mock.calls[changes.mock.calls.length - 1]?.[0])('voice-id');
  expect(h.settings).toMatchObject({
    compatibleAgent: {
      baseURL: 'http://localhost:11434/v1',
      model: 'qwen3:4b',
      secret: { baseURL: 'http://localhost:11434/v1', id: 'agent-id' },
    },
    compatibleVoice: {
      baseURL: 'http://localhost:8080/asr/v1',
      model: 'whisper-1',
      secret: { baseURL: 'http://localhost:8080/asr/v1', id: 'voice-id' },
    },
    search: 'disabled',
    extension: { keep: true },
  });
  edit('Agent API base URL', 'https://new.example/v1');
  expect(h.settings['compatibleAgent']).toEqual({
    baseURL: 'https://new.example/v1',
    model: 'qwen3:4b',
  });
  await agentKey('obsolete-id');
  expect(h.settings['compatibleAgent']).not.toHaveProperty('secret');
  expect(h.settings['compatibleVoice']).toMatchObject({ secret: { id: 'voice-id' } });
  h.change('Agent provider', 'openai');
  h.change('Agent provider', 'openai-compatible');
  expect(input('Agent model').value).toBe('qwen3:4b');
  expect(input('Agent API base URL').value).toBe('https://new.example/v1');
  h.section.dispose();
});

it('offers ChatGPT plan sign-in as an independent LLM with an account-specific model picker', async () => {
  const h = await setup();
  h.section.render(h.container);
  h.change('Agent provider', 'chatgpt-plan');
  expect(h.settings).toMatchObject({
    provider: 'chatgpt-plan',
    model: '',
    search: 'openrouter',
    voice: 'disabled',
  });
  expect(h.container.textContent).toContain('Sign in with ChatGPT requires Obsidian desktop.');
  expect(h.container.textContent).not.toContain('ChatGPT API key');
  expect([...h.select('Voice provider').options].map((option) => option.value)).not.toContain(
    'chatgpt-plan',
  );
  h.change('Voice provider', 'openai');
  expect(h.select('Voice provider').closest('.setting-item')?.textContent).toContain(
    'OpenAI transcription uses its own API key. Commands use your ChatGPT plan.',
  );
  h.change('Voice provider', 'openai-compatible');
  expect(h.container.textContent).not.toContain('OpenAI transcription uses its own API key.');
});

it('keeps a cleared ChatGPT model unselected if that slug reappears on a later catalog refresh', async () => {
  const { renderChatGptPlanControls } =
    await import('../src/settings/sections/chatGptPlanControls');
  const host = createDiv(),
    signal = new AbortController().signal;
  let model = 'previous-choice';
  const list = vi
    .fn()
    .mockResolvedValueOnce([{ id: 'another', name: 'Another' }])
    .mockResolvedValueOnce([{ id: 'previous-choice', name: 'Returned model' }]);
  renderChatGptPlanControls(
    host,
    {
      state: () => ({
        desktop: true,
        connected: true,
        ready: true,
        active: 'registration',
        accounts: [],
      }),
      list,
      select: vi.fn(),
      signIn: vi.fn(),
      signOut: vi.fn(),
    },
    {
      signal,
      model,
      selectModel: (value) => {
        model = value;
      },
      refresh: vi.fn(),
    },
  );
  await flushMicrotasks();
  const select = expectDefined(host.querySelector<HTMLSelectElement>('[aria-label="Agent model"]'));
  expect(model).toBe('');
  expect(select.value).toBe('');
  expectDefined(host.querySelector<HTMLElement>('[aria-label="Refresh models"]')).click();
  await flushMicrotasks();
  expect(select.value).toBe('');
  expect(model).toBe('');
});
