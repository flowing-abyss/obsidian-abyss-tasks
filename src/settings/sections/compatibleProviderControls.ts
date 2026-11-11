import { Setting, type App } from 'obsidian';
import { compatibleBase, type CompatibleRole } from '../../ai/providers/compatibleProfile';
import { renderProviderSecret } from './providerSecretControl';

interface Controls {
  readonly app: App;
  readonly role: CompatibleRole;
  readonly signal: AbortSignal;
  readonly read: () => Record<string, unknown>;
  readonly write: (profile: Record<string, unknown>) => void;
}

export function renderCompatibleControls(container: HTMLElement, controls: Controls): void {
  const name = controls.role === 'agent' ? 'Agent' : 'Voice';
  let revision = 0;
  const values = controls.read();
  new Setting(container)
    .setName('API base URL')
    .setDesc(
      controls.role === 'agent'
        ? 'Desktop server for Chat Completions and tool calls. Include the API path, such as /v1.'
        : 'Desktop server for audio/transcriptions. Include the API path, such as /v1.',
    )
    .addText((text) => {
      text.inputEl.setAttribute('aria-label', `${name} API base URL`);
      text.inputEl.maxLength = 2048;
      text
        .setValue(typeof values['baseURL'] === 'string' ? values['baseURL'] : '')
        .onChange((value) => {
          if (controls.signal.aborted) return;
          const current = controls.read();
          const baseURL = compatibleBase(value);
          if (baseURL === compatibleBase(current['baseURL']) && baseURL !== undefined) return;
          const next: Record<string, unknown> = { ...current, baseURL: baseURL ?? '' };
          delete next['secret'];
          controls.write(next);
          renderKey();
        });
    });
  new Setting(container).setName(name === 'Agent' ? 'Model' : 'Voice model').addText((text) => {
    text.inputEl.setAttribute('aria-label', `${name} model`);
    text.inputEl.maxLength = 200;
    text.setValue(typeof values['model'] === 'string' ? values['model'] : '').onChange((model) => {
      if (!controls.signal.aborted) controls.write({ ...controls.read(), model });
    });
  });
  const row = new Setting(container).setName('API key (optional)');
  function renderKey(): void {
    const ticket = ++revision;
    row.controlEl.empty();
    const profile = controls.read();
    const baseURL = compatibleBase(profile['baseURL']);
    if (baseURL === undefined) {
      row.setDesc(
        'Enter an HTTP or HTTPS API base URL without credentials, a query, or a fragment.',
      );
      return;
    }
    row.setDesc('Leave empty for a server without authentication.');
    const secret = profile['secret'];
    const id =
      typeof secret === 'object' &&
      secret !== null &&
      'id' in secret &&
      typeof secret.id === 'string' &&
      'baseURL' in secret &&
      compatibleBase(secret.baseURL) === baseURL
        ? secret.id
        : '';
    const selectedKey = (selected: string | null): void => {
      const current = controls.read();
      if (
        controls.signal.aborted ||
        ticket !== revision ||
        compatibleBase(current['baseURL']) !== baseURL
      )
        return;
      const next = { ...current };
      if (selected !== null && selected !== '') next['secret'] = { baseURL, id: selected };
      else delete next['secret'];
      controls.write(next);
    };
    renderProviderSecret(row, controls.app, () => id, selectedKey);
  }
  renderKey();
}
