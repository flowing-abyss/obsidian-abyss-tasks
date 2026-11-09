import { createAnthropic } from '@ai-sdk/anthropic';
import { createCerebras } from '@ai-sdk/cerebras';
import { createGroq } from '@ai-sdk/groq';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModel } from 'ai';
import type { NativeProviderTransport } from './NativeProviderTransport';
import type { ProviderSecrets } from './ProviderSecrets';
import { ProviderFailure } from './providerFailure';
import { parseProviderSettings, providerSchema, type ModelSelection } from './providerSettings';

/** Explicit BYOK only. Constructing a model does not perform a network request. */
export class ProviderConnections {
  readonly #secrets: ProviderSecrets;
  readonly #transport: NativeProviderTransport;
  constructor(secrets: ProviderSecrets, transport: NativeProviderTransport) {
    this.#secrets = secrets;
    this.#transport = transport;
  }
  availability(settings: unknown): { agent: boolean; voice: boolean } {
    try {
      const selected = parseProviderSettings(settings);
      return {
        agent: this.#secrets.has(selected.provider),
        voice: selected.voice === 'openai' && this.#secrets.has('openai'),
      };
    } catch {
      // Invalid preferences or unavailable secrets remain editable in settings.
      return { agent: false, voice: false };
    }
  }
  model(selection: ModelSelection): Exclude<LanguageModel, string> {
    if (
      !providerSchema.safeParse(selection.provider).success ||
      selection.model.trim() === '' ||
      selection.model.length > 200
    )
      throw new ProviderFailure('invalid-request');
    const apiKey = this.#secrets.resolve(selection.provider);
    const fetch = this.#transport.fetchFor(selection.provider);
    switch (selection.provider) {
      case 'openrouter':
        return createOpenRouter({ apiKey, fetch }).chat(selection.model);
      case 'openai':
        return createOpenAI({ apiKey, fetch }).responses(selection.model);
      case 'anthropic':
        return createAnthropic({ apiKey, fetch })(selection.model);
      case 'groq':
        return createGroq({ apiKey, fetch })(selection.model);
      case 'cerebras':
        return createCerebras({ apiKey, fetch })(selection.model);
    }
  }
}
