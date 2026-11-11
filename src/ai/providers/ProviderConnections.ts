import { createAnthropic } from '@ai-sdk/anthropic';
import { createCerebras } from '@ai-sdk/cerebras';
import { createGroq } from '@ai-sdk/groq';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModel } from 'ai';
import type { ChatGptPlan } from './ChatGptPlan';
import { compatibleConnection } from './compatibleProfile';
import type { NativeProviderTransport } from './NativeProviderTransport';
import { ProviderFailure } from './providerFailure';
import type { ProviderSecrets } from './ProviderSecrets';
import {
  parseAgentSettings,
  parseVoiceSettings,
  providerSchema,
  type ModelSelection,
} from './providerSettings';

/** Resolve the selected model and credential without sending a request. */
export class ProviderConnections {
  readonly #secrets: ProviderSecrets;
  readonly #transport: NativeProviderTransport;
  constructor(
    secrets: ProviderSecrets,
    transport: NativeProviderTransport,
    private readonly plan?: ChatGptPlan,
  ) {
    this.#secrets = secrets;
    this.#transport = transport;
  }
  availability(settings: unknown): { agent: boolean; voice: boolean } {
    return {
      agent: ready(() => {
        const { provider, model, compatibleAgent } = parseAgentSettings(settings);
        if (provider === 'chatgpt-plan') return model !== '' && this.plan?.state().ready === true;
        if (provider === 'openai-compatible') {
          compatibleConnection('agent', compatibleAgent, this.#secrets, this.#transport);
          return true;
        }
        return provider !== 'disabled' && this.#secrets.has(provider);
      }),
      voice: ready(() => {
        const selected = parseVoiceSettings(settings);
        if (selected.voice === 'openai-compatible') {
          compatibleConnection('voice', selected.compatibleVoice, this.#secrets, this.#transport);
          return true;
        }
        return selected.voice !== 'disabled' && this.#secrets.has(selected.voice, 'voice');
      }),
    };
  }
  model(selection: ModelSelection): Exclude<LanguageModel, string> {
    if (selection.provider === 'disabled') throw new ProviderFailure('invalid-request');
    if (selection.provider === 'openai-compatible') {
      const config = compatibleConnection(
        'agent',
        selection.compatibleAgent,
        this.#secrets,
        this.#transport,
      );
      return createOpenAI({ ...config, name: 'openai-compatible' }).chat(config.model);
    }
    validateSelection(selection);
    if (selection.provider === 'chatgpt-plan') {
      if (this.plan === undefined) throw new ProviderFailure('plan-desktop');
      return this.plan.model(selection.model);
    }
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

function ready(check: () => boolean): boolean {
  try {
    return check();
  } catch {
    // An invalid connection stays editable without hiding another role.
    return false;
  }
}

function validateSelection(selection: ModelSelection): void {
  if (
    !providerSchema.safeParse(selection.provider).success ||
    selection.model.trim() === '' ||
    selection.model.length > 200
  )
    throw new ProviderFailure('invalid-request');
}
