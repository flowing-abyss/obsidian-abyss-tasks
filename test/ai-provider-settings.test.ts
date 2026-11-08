import { describe, expect, it, vi } from 'vitest';
import { ProviderSecrets } from '../src/ai/providers/ProviderSecrets';
import { defaultProviderSettings } from '../src/ai/providers/providerSettings';
import { ProviderSettingsSection } from '../src/settings/sections/ProviderSettingsSection';
import { expectDefined } from './helpers';

it('keeps masked edits usable and never prefills or renders a stored key', () => {
  const values = new Map([['abyss-tasks-openrouter-api-key', 'old-synthetic-secret']]);
  const secrets = new ProviderSecrets({
    getSecret: (id) => values.get(id) ?? null,
    setSecret: (id, value) => {
      values.set(id, value);
    },
  });
  const settings = defaultProviderSettings();
  const section = new ProviderSettingsSection({
    settings: () => settings,
    setSettings: (value) => {
      Object.assign(settings, value);
    },
    save: async () => undefined,
    secrets,
  });
  const container = createDiv();
  section.render(container);
  const input = expectDefined(container.querySelector<HTMLInputElement>('input[type=password]'));
  expect(input.value).toBe('');
  input.value = 'new-synthetic-secret';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  expect(container.querySelector('input[type=password]')).toBe(input);
  expect(input.value).toBe('new-synthetic-secret');
  expect(container.textContent).not.toContain('old-synthetic-secret');
  expect(container.textContent).not.toContain('new-synthetic-secret');
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(secrets.resolve('openrouter')).toBe('new-synthetic-secret');
  expect(input.value).toBe('');
  expect(container.textContent).toContain('Key saved');
  expect(container.textContent).not.toContain('Connected');
  section.dispose();
});

describe('provider connection settings', () => {
  it('requires explicit voice selection and does not fallback from unsupported same-agent research', () => {
    const settings = {
      ...defaultProviderSettings(),
      provider: 'anthropic' as const,
      model: 'claude-haiku-5-5',
    };
    const section = new ProviderSettingsSection({
      settings: () => settings,
      setSettings: (value) => {
        Object.assign(settings, value);
      },
      save: async () => undefined,
      secrets: new ProviderSecrets({ getSecret: () => null, setSecret: () => undefined }),
    });
    const container = createDiv();
    section.render(container);
    expect(container.textContent).toContain('Choose OpenAI or Tavily');
    const voice = expectDefined(
      container.querySelector<HTMLSelectElement>('select[aria-label="Voice provider"]'),
    );
    expect(voice.value).toBe('disabled');
    section.dispose();
  });
});

it('preserves a failed masked submission and reports only a safe storage error', () => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const settings = defaultProviderSettings();
  const section = new ProviderSettingsSection({
    settings: () => settings,
    setSettings: (value) => {
      Object.assign(settings, value);
    },
    save: async () => undefined,
    secrets: new ProviderSecrets({
      getSecret: () => null,
      setSecret: () => {
        throw new Error('synthetic-secret-and-host-details');
      },
    }),
  });
  const container = createDiv();
  section.render(container);
  const input = expectDefined(container.querySelector<HTMLInputElement>('input[type=password]'));
  input.value = 'entered-private-value';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('blur'));
  expect(input.value).toBe('entered-private-value');
  expect(container.textContent).not.toContain('entered-private-value');
  expect(logged).toHaveBeenCalledWith('[abyss-tasks] Provider key settings failed', {
    code: 'secret-storage',
  });
  expect(JSON.stringify(logged.mock.calls)).not.toContain('synthetic-secret-and-host-details');
  section.dispose();
});

it('commits the masked draft to its captured provider before changing selection', () => {
  const values = new Map<string, string>();
  const owner = new ProviderSecrets({
    getSecret: (id) => values.get(id) ?? null,
    setSecret: (id, value) => {
      values.set(id, value);
    },
  });
  const settings = defaultProviderSettings();
  const section = new ProviderSettingsSection({
    settings: () => settings,
    setSettings: (value) => {
      Object.assign(settings, value);
    },
    save: async () => undefined,
    secrets: owner,
  });
  const container = createDiv();
  section.render(container);
  const input = expectDefined(container.querySelector<HTMLInputElement>('input[type=password]'));
  input.value = 'router-only-secret';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('blur'));
  const provider = expectDefined(
    container.querySelector<HTMLSelectElement>('select[aria-label="Agent provider"]'),
  );
  provider.value = 'openai';
  provider.dispatchEvent(new Event('change', { bubbles: true }));
  expect(owner.resolve('openrouter')).toBe('router-only-secret');
  expect(owner.has('openai')).toBe(false);
  expect(settings.model).toBe('gpt-6-luna');
  expect(container.querySelector<HTMLInputElement>('input[type=password]')?.value).toBe('');
  section.dispose();
});

it('keeps the key field available when host secret reads fail', () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const settings = defaultProviderSettings();
  const section = new ProviderSettingsSection({
    settings: () => settings,
    setSettings: (value) => {
      Object.assign(settings, value);
    },
    save: async () => undefined,
    secrets: new ProviderSecrets({
      getSecret: () => {
        throw new Error('private-host-storage-error');
      },
      setSecret: () => undefined,
    }),
  });
  const container = createDiv();
  expect(() => {
    section.render(container);
  }).not.toThrow();
  expect(container.querySelector('input[type=password]')).not.toBeNull();
  expect(container.textContent).toContain('Secret storage is unavailable.');
  expect(container.textContent).not.toContain('private-host-storage-error');
  section.dispose();
});

it('preserves an active masked draft through the existing settings render context', async () => {
  const { captureSettingsRenderContext, restoreSettingsRenderContext } =
    await import('../src/settings/settingsRenderState');
  const values = new Map<string, string>();
  const secrets = new ProviderSecrets({
    getSecret: (id) => values.get(id) ?? null,
    setSecret: (id, value) => {
      values.set(id, value);
    },
  });
  const settings = defaultProviderSettings();
  const section = new ProviderSettingsSection({
    settings: () => settings,
    setSettings: (value) => {
      Object.assign(settings, value);
    },
    save: async () => undefined,
    secrets,
  });
  const host = createDiv();
  const container = host.createDiv();
  container.dataset['sectionTitle'] = 'CommandMode';
  document.body.append(host);
  try {
    section.render(container);
    const input = expectDefined(container.querySelector<HTMLInputElement>('input[type=password]'));
    input.focus();
    input.value = 'unfinished-private-draft';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.setSelectionRange(4, 4);
    const context = captureSettingsRenderContext(host);
    section.render(container);
    restoreSettingsRenderContext(host, context);
    const restored = expectDefined(
      container.querySelector<HTMLInputElement>('input[type=password]'),
    );
    expect(restored.value).toBe('unfinished-private-draft');
    expect(restored.selectionStart).toBe(4);
    expect(document.activeElement).toBe(restored);
    restored.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(secrets.resolve('openrouter')).toBe('unfinished-private-draft');
    expect(restored.value).toBe('');
  } finally {
    section.dispose();
    host.remove();
  }
});
