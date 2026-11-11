import { z } from 'zod';
import { ProviderFailure } from './providerFailure';

export const chatGptPlanSecret = 'abyss-tasks-chatgpt-plan';
const catalogProviders = ['openrouter', 'openai', 'anthropic', 'groq', 'cerebras'] as const;
export type CatalogProvider = (typeof catalogProviders)[number];
export const providerSchema = z.enum([
  'disabled',
  ...catalogProviders,
  'openai-compatible',
  'chatgpt-plan',
]);
export type DirectSearchProvider = 'tavily' | 'exa' | 'firecrawl' | 'brave';
export type CredentialProvider = CatalogProvider | DirectSearchProvider;
export const searchProviderSchema = z.enum([
  'openai',
  'openrouter',
  'tavily',
  'exa',
  'firecrawl',
  'brave',
]);
export const voiceProviderSchema = z.enum(['disabled', 'openai', 'groq', 'openai-compatible']);
const modelId = z.string().trim().min(1).max(200);
const secretBinding = z.string().trim().min(1).max(200).nullable().optional();
const agentSettingsSchema = z.object({
  provider: providerSchema.default('disabled'),
  model: modelId.optional(),
  compatibleAgent: z.unknown().optional(),
});
const voiceSettingsSchema = z.object({
  voice: voiceProviderSchema.default('disabled'),
  voiceModel: modelId.optional(),
  compatibleVoice: z.unknown().optional(),
});
const searchSettingsSchema = z.object({
  search: z.enum(['agent', 'disabled', ...searchProviderSchema.options]).default('agent'),
  searchModel: modelId.optional(),
});
const providerSettingsSchema = z.looseObject({
  ...agentSettingsSchema.shape,
  ...voiceSettingsSchema.shape,
  ...searchSettingsSchema.shape,
  voiceInputMode: z.enum(['manual', 'continuous']).default('manual'),
  secrets: z
    .looseObject({
      ...Object.fromEntries(
        [...catalogProviders, ...searchProviderSchema.options].map((provider) => [
          provider,
          secretBinding,
        ]),
      ),
      voice: z.looseObject({ openai: secretBinding, groq: secretBinding }).optional(),
    })
    .optional(),
});
const voicePreferenceSchema = providerSettingsSchema.pick({ voiceInputMode: true });
/** Local session/history remain usable while another provider field needs correction. */
export function providerVoiceMode(value: unknown): 'manual' | 'continuous' {
  const result = voicePreferenceSchema.safeParse(value);
  return result.success ? result.data.voiceInputMode : 'manual';
}
type AgentSettings = z.infer<typeof agentSettingsSchema>;
export type ProviderSettings = z.infer<typeof providerSettingsSchema> & { model: string };
export type ModelSelection = Pick<ProviderSettings, 'provider' | 'model' | 'compatibleAgent'>;
export type ResearchSettings = Pick<
  ProviderSettings,
  'provider' | 'model' | 'search' | 'searchModel'
>;
type VoiceSelection =
  | { voice: 'disabled' }
  | { voice: 'openai-compatible'; compatibleVoice: unknown }
  | { voice: 'openai' | 'groq'; voiceModel: string };
export function providerSecretBindings(value: unknown): unknown {
  return typeof value === 'object' && value !== null && 'secrets' in value
    ? value.secrets
    : undefined;
}
export function defaultProviderSettings(): ProviderSettings {
  return parseProviderSettings({});
}
export function parseProviderSettings(value: unknown): ProviderSettings {
  const settings = readFields(providerSettingsSchema, value);
  if (settings.voice === 'openai-compatible')
    settings.voiceModel = profileModel(settings.compatibleVoice);
  return { ...settings, model: agentModel(settings) };
}
export function parseAgentSettings(value: unknown): ModelSelection {
  const settings = readFields(agentSettingsSchema, value);
  return { ...settings, model: agentModel(settings) };
}
export function parseResearchSettings(value: unknown): ResearchSettings {
  const settings = readFields(searchSettingsSchema, value);
  if (settings.search === 'agent') return { ...settings, ...parseAgentSettings(value) };
  return { ...settings, provider: 'disabled', model: '' };
}
export function parseVoiceSettings(value: unknown): VoiceSelection {
  const { voice, voiceModel, compatibleVoice } = readFields(voiceSettingsSchema, value);
  if (voice === 'disabled') return { voice };
  if (voice === 'openai-compatible') return { voice, compatibleVoice };
  const allowed: readonly string[] = VOICE_MODELS[voice];
  const model = voiceModel ?? VOICE_MODELS[voice][0];
  if (!allowed.includes(model)) throw new ProviderFailure('invalid-request');
  return { voice, voiceModel: model };
}
function readFields<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(activeModelFields(value));
  if (!result.success) throw new ProviderFailure('invalid-request');
  return result.data;
}
function agentModel({ provider, model, compatibleAgent }: AgentSettings): string {
  if (provider === 'disabled') return '';
  if (provider === 'openai-compatible') return profileModel(compatibleAgent) ?? '';
  return model ?? (provider === 'chatgpt-plan' ? '' : DEFAULT_MODELS[provider]);
}
function activeModelFields(value: unknown): unknown {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const settings: Record<string, unknown> = { ...value };
  if (usesOtherModel(settings['provider'])) delete settings['model'];
  if (settings['provider'] === 'chatgpt-plan' && settings['model'] === '') delete settings['model'];
  if (usesOtherModel(settings['voice'])) delete settings['voiceModel'];
  return settings;
}
function usesOtherModel(provider: unknown): boolean {
  return provider === undefined || provider === 'disabled' || provider === 'openai-compatible';
}
function profileModel(value: unknown): string | undefined {
  return typeof value === 'object' &&
    value !== null &&
    'model' in value &&
    typeof value.model === 'string'
    ? value.model.trim()
    : undefined;
}
export function researchProvider(
  settings: ResearchSettings,
): z.infer<typeof searchProviderSchema> | null {
  if (settings.search === 'disabled') return null;
  if (settings.search !== 'agent') return settings.search;
  return settings.provider === 'openai' || settings.provider === 'openrouter'
    ? settings.provider
    : null;
}
export const DEFAULT_MODELS: Record<CatalogProvider, string> = {
  openrouter: 'openai/gpt-6-luna',
  openai: 'gpt-6-luna',
  anthropic: 'claude-haiku-5-5',
  groq: 'openai/gpt-oss-120b',
  cerebras: 'qwen-3.8-27b',
};
export const VOICE_MODELS = {
  openai: ['gpt-transcribe'],
  groq: ['whisper-large-v3-turbo', 'whisper-large-v3'],
} as const;
