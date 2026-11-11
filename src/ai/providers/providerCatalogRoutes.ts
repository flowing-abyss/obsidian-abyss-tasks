import type { CatalogProvider, CredentialProvider } from './providerSettings';

export const catalogEndpoints: Record<CatalogProvider, string> = {
  openai: 'https://api.openai.com/v1/models',
  openrouter: 'https://openrouter.ai/api/v1/models',
  anthropic: 'https://api.anthropic.com/v1/models',
  groq: 'https://api.groq.com/openai/v1/models',
  cerebras: 'https://api.cerebras.ai/v1/models',
};
/** Catalog GETs have their own narrow allowlist; inference remains POST-only. */
export function isCatalogUrl(provider: CredentialProvider, value: string): boolean {
  if (!(provider in catalogEndpoints)) return false;
  const url = new URL(value);
  if (
    url.hash !== '' ||
    `${url.origin}${url.pathname}` !== catalogEndpoints[provider as CatalogProvider] ||
    url.username !== '' ||
    url.password !== ''
  )
    return false;
  if (provider !== 'anthropic' && provider !== 'openrouter') return url.search === '';
  return catalogQuery(provider, url);
}
function catalogQuery(provider: 'anthropic' | 'openrouter', url: URL): boolean {
  const entries = [...url.searchParams];
  if (url.searchParams.get('limit') !== '100' || entries.length < 1 || entries.length > 2)
    return false;
  if (new Set(entries.map(([name]) => name)).size !== entries.length) return false;
  if (provider === 'anthropic')
    return entries.every(
      ([name, value]) =>
        name === 'limit' || (name === 'after_id' && value.length > 0 && value.length <= 200),
    );
  return entries.every(
    ([name, value]) =>
      name === 'limit' || (name === 'offset' && /^\d{1,4}$/u.test(value) && Number(value) <= 2000),
  );
}
