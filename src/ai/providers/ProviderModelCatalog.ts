import { z } from 'zod';
import type { NativeProviderTransport } from './NativeProviderTransport';
import { catalogEndpoints } from './providerCatalogRoutes';
import { ProviderFailure, providerFailure } from './providerFailure';
import type { ProviderSecrets } from './ProviderSecrets';
import type { CatalogProvider } from './providerSettings';

export interface ProviderModel {
  readonly id: string;
  readonly name: string;
}
const pageSchema = z.object({
  data: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        name: z.string().max(300).optional(),
        display_name: z.string().max(300).optional(),
        active: z.boolean().optional(),
      }),
    )
    .max(2000),
  has_more: z.boolean().optional(),
  last_id: z.string().min(1).max(200).nullable().optional(),
});
/** Metadata only: fixed endpoints, native credentials, bounded pages and no inference probe. */
export class ProviderModelCatalog {
  constructor(
    private readonly secrets: ProviderSecrets,
    private readonly transport: NativeProviderTransport,
  ) {}
  async list(
    provider: CatalogProvider,
    signal: AbortSignal,
    role?: 'voice',
  ): Promise<readonly ProviderModel[]> {
    const key = this.secrets.resolve(provider, role);
    const headers =
      provider === 'anthropic'
        ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
        : { Authorization: `Bearer ${key}` };
    const models = new Map<string, ProviderModel>(),
      cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      signal.throwIfAborted();
      const url = pageUrl(provider, page, cursor);
      const response = await this.transport.fetchFor(provider)(url, {
        method: 'GET',
        headers,
        signal,
      });
      if (!response.ok) throw providerFailure({ statusCode: response.status });
      const parsed = await catalogPage(response);
      signal.throwIfAborted();
      collectModels(models, parsed);
      if (!continues(provider, parsed)) return [...models.values()];
      if (provider === 'anthropic') cursor = followingCursor(parsed, cursors);
    }
    throw new ProviderFailure('too-large');
  }
}

type CatalogPage = z.infer<typeof pageSchema>;
function pageUrl(provider: CatalogProvider, page: number, cursor: string | undefined): URL {
  const url = new URL(catalogEndpoints[provider]);
  if (provider === 'anthropic' || provider === 'openrouter') url.searchParams.set('limit', '100');
  if (provider === 'openrouter') url.searchParams.set('offset', String(page * 100));
  if (provider === 'anthropic' && cursor !== undefined) url.searchParams.set('after_id', cursor);
  return url;
}
async function catalogPage(response: Response): Promise<CatalogPage> {
  const parsed = pageSchema.safeParse(await response.json());
  if (!parsed.success) throw new ProviderFailure('invalid-response');
  return parsed.data;
}
function collectModels(models: Map<string, ProviderModel>, page: CatalogPage): void {
  for (const model of page.data)
    if (model.active !== false)
      models.set(model.id, { id: model.id, name: model.display_name ?? model.name ?? model.id });
}
function continues(provider: CatalogProvider, page: CatalogPage): boolean {
  if (provider === 'anthropic') return page.has_more === true;
  return provider === 'openrouter' && page.data.length >= 100;
}

function followingCursor(page: CatalogPage, seen: Set<string>): string {
  const cursor = page.last_id;
  if (cursor == null || seen.has(cursor)) throw new ProviderFailure('invalid-response');
  seen.add(cursor);
  return cursor;
}
