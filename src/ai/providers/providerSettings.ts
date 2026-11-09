import { z } from 'zod';
import { ProviderFailure } from './providerFailure';

export const providerSchema = z.enum(['openrouter', 'openai', 'anthropic', 'groq', 'cerebras']);
export type AgentProvider = z.infer<typeof providerSchema>;
export type CredentialProvider = AgentProvider | 'tavily';
const providerSettingsSchema = z.looseObject({
  provider: providerSchema.default('openrouter'),
  model: z.string().trim().min(1).max(200).default('openai/gpt-6-luna'),
  search: z.enum(['agent', 'openai', 'tavily']).default('agent'),
  voice: z.enum(['disabled', 'openai']).default('disabled'),
});
export type ProviderSettings = z.infer<typeof providerSettingsSchema>;
export type ModelSelection = Pick<ProviderSettings, 'provider' | 'model'>;
export function defaultProviderSettings(): ProviderSettings {
  return parseProviderSettings({});
}
export function parseProviderSettings(value: unknown): ProviderSettings {
  const result = providerSettingsSchema.safeParse(value);
  if (!result.success) throw new ProviderFailure('invalid-request');
  if (typeof value === 'object' && value !== null && !('model' in value)) {
    result.data.model = DEFAULT_MODELS[result.data.provider];
  }
  return result.data;
}
export function researchProvider(
  settings: ProviderSettings,
): 'openrouter' | 'openai' | 'tavily' | null {
  if (settings.search !== 'agent') return settings.search;
  return settings.provider === 'openai' || settings.provider === 'openrouter'
    ? settings.provider
    : null;
}
export const DEFAULT_MODELS: Record<AgentProvider, string> = {
  openrouter: 'openai/gpt-6-luna',
  openai: 'gpt-6-luna',
  anthropic: 'claude-haiku-5-5',
  groq: 'openai/gpt-oss-120b',
  cerebras: 'qwen-3.8-27b',
};
