import type { SecretStorage } from 'obsidian';
import { ProviderFailure } from './providerFailure';
import type { CredentialProvider } from './providerSettings';

const secretIds: Record<CredentialProvider, string> = {
  openrouter: 'abyss-tasks-openrouter-api-key',
  openai: 'abyss-tasks-openai-api-key',
  anthropic: 'abyss-tasks-anthropic-api-key',
  tavily: 'abyss-tasks-tavily-api-key',
};
/** Sole owner of the four plugin credentials; never enumerates host secrets. */
export class ProviderSecrets {
  readonly #storage: Pick<SecretStorage, 'getSecret' | 'setSecret'>;
  constructor(storage: Pick<SecretStorage, 'getSecret' | 'setSecret'>) {
    this.#storage = storage;
  }
  store(provider: CredentialProvider, value: string): void {
    const secret = value.trim();
    if (secret.length > 4096 || /[\r\n]/u.test(secret))
      throw new ProviderFailure('invalid-request');
    try {
      this.#storage.setSecret(secretIds[provider], secret);
    } catch {
      throw new ProviderFailure('secret-storage');
    }
  }
  resolve(provider: CredentialProvider): string {
    const value = this.read(provider);
    if (value === null || value === '') throw new ProviderFailure('missing-key');
    return value;
  }
  has(provider: CredentialProvider): boolean {
    return Boolean(this.read(provider));
  }
  private read(provider: CredentialProvider): string | null {
    try {
      return this.#storage.getSecret(secretIds[provider]);
    } catch {
      throw new ProviderFailure('secret-storage');
    }
  }
}
