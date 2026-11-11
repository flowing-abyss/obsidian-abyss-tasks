import type { SecretStorage } from 'obsidian';
import { ProviderFailure } from './providerFailure';
import { chatGptPlanSecret, type CredentialProvider } from './providerSettings';

function secretId(provider: CredentialProvider): string {
  return `abyss-tasks-${provider}-api-key`;
}
function bindingsRecord(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new ProviderFailure('invalid-request');
  return value as Record<string, unknown>;
}
/** Resolve native secret IDs without enumerating or copying shared credentials. */
export class ProviderSecrets {
  readonly #storage: Pick<SecretStorage, 'getSecret' | 'setSecret'>;
  constructor(
    storage: Pick<SecretStorage, 'getSecret' | 'setSecret'>,
    private readonly bindings: () => unknown = () => undefined,
  ) {
    this.#storage = storage;
  }
  id(provider: CredentialProvider, role?: 'voice'): string | null {
    const bindings = bindingsRecord(this.bindings());
    const scoped = role === 'voice' ? bindingsRecord(bindings['voice'])[provider] : undefined;
    // Absent Voice bindings retain the original provider binding, including explicit disconnects.
    const value = scoped === undefined ? bindings[provider] : scoped;
    if (value === undefined) return secretId(provider);
    if (value === null) return null;
    if (
      typeof value !== 'string' ||
      value.trim() === '' ||
      value.length > 200 ||
      /[\r\n]/u.test(value)
    )
      throw new ProviderFailure('invalid-request');
    return value;
  }
  store(provider: CredentialProvider, value: string): void {
    const secret = value.trim();
    if (secret.length > 4096 || /[\r\n]/u.test(secret))
      throw new ProviderFailure('invalid-request');
    try {
      this.#storage.setSecret(secretId(provider), secret);
    } catch {
      throw new ProviderFailure('secret-storage');
    }
  }
  /** A user-selected secret for one compatible base never falls back to a provider key. */
  resolveId(id: string): string {
    const value = this.read(id);
    if (value === null || value.trim() === '') throw new ProviderFailure('missing-key');
    if (value.length > 4096 || /[\r\n]/u.test(value)) throw new ProviderFailure('invalid-request');
    return value.trim();
  }
  resolve(provider: CredentialProvider, role?: 'voice'): string {
    const id = this.id(provider, role);
    if (id === null) throw new ProviderFailure('missing-key');
    return this.resolveId(id);
  }
  has(provider: CredentialProvider, role?: 'voice'): boolean {
    return this.connectedId(provider, role) !== null;
  }
  connectedId(provider: CredentialProvider, role?: 'voice'): string | null {
    const id = this.id(provider, role);
    if (id === null) return null;
    try {
      this.resolveId(id);
      return id;
    } catch (error) {
      if (error instanceof ProviderFailure && error.code === 'missing-key') return null;
      throw error;
    }
  }
  private read(id: string): string | null {
    try {
      if (id === chatGptPlanSecret) throw new ProviderFailure('invalid-request');
      return this.#storage.getSecret(id);
    } catch {
      throw new ProviderFailure('secret-storage');
    }
  }
}
