import { EvalBoundaryFailure, httpCode, transportCode } from './diagnostics';
import { assertFreeCatalog, object, type EvalOptions, type RequestBudget } from './safety';
export async function readFreeCatalog(
  options: EvalOptions,
  budget: RequestBudget,
  fetch: typeof window.fetch,
) {
  if (options.provider === 'local')
    return { checked: false, reason: 'operator-configured-loopback' };
  if (options.provider !== 'openrouter' || options.allowPaid) return { checked: false };
  budget.dispatch();
  let response: Response;
  try {
    response = await fetch('https://openrouter.ai/api/v1/models', {
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    });
  } catch (error) {
    throw new EvalBoundaryFailure({ phase: 'catalog-fetch', code: transportCode(error) });
  }
  if (!response.ok)
    throw new EvalBoundaryFailure({
      phase: 'catalog-response',
      code: httpCode(response.status),
      status: response.status,
    });
  let catalog: unknown;
  try {
    catalog = await response.json();
  } catch {
    throw new EvalBoundaryFailure({
      phase: 'catalog-body',
      code: 'invalid-json',
      status: response.status,
    });
  }
  assertFreeCatalog(options.model, catalog);
  const data = object(catalog)['data'];
  return {
    checked: true,
    at: new Date().toISOString(),
    requestPricePolicy: 'optional catalog request price; mandatory outgoing request max_price 0',
    model: Array.isArray(data)
      ? data.map(object).find((model) => model['id'] === options.model)
      : null,
  };
}
