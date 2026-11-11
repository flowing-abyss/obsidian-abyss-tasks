import type { RequestUrlParam } from 'obsidian';
import type { CatalogProvider } from '../../src/ai/providers/providerSettings';
import { EvalBoundaryFailure } from './diagnostics';
export interface EvalOptions {
  provider: CatalogProvider | 'local';
  localBaseURL?: string;
  model: string;
  maxRequests: number;
  allowPaid: boolean;
}
export function validateOptions(input: EvalOptions): EvalOptions {
  if (
    !['openrouter', 'openai', 'anthropic', 'groq', 'cerebras', 'local'].includes(input.provider) ||
    input.model.trim() === '' ||
    input.model.length > 200 ||
    !Number.isSafeInteger(input.maxRequests) ||
    input.maxRequests < 1
  )
    throw new Error('invalid-configuration');
  if (input.provider === 'local') return validateLocalOptions(input);
  if (input.localBaseURL !== undefined) throw new Error('unexpected-local-base');
  if (!input.allowPaid && !freeOpenRouter(input)) throw new Error('paid-opt-in-required');
  return input;
}
function freeOpenRouter(input: EvalOptions): boolean {
  return input.provider === 'openrouter' && input.model.endsWith(':free');
}
function validateLocalOptions(input: EvalOptions): EvalOptions {
  if (
    input.allowPaid ||
    !/^[a-z0-9][a-z0-9._:/-]*$/iu.test(input.model) ||
    /(?:^|[:-])cloud(?:$|[:-])/iu.test(input.model)
  )
    throw new Error('invalid-local-model');
  return { ...input, localBaseURL: localBase(input.localBaseURL) };
}
function localBase(value: string | undefined): string {
  const match = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):([1-9]\d{0,4})\/v1\/?$/u.exec(value ?? '');
  if (match === null || Number(match[1]) > 65535) throw new Error('invalid-local-base');
  return match[0].replace(/\/$/u, '');
}

export function assertLocalRequest(options: EvalOptions, request: RequestUrlParam): void {
  if (options.provider !== 'local') return;
  if (
    request.url !== `${localBase(options.localBaseURL)}/chat/completions` ||
    request.method !== 'POST' ||
    typeof request.body !== 'string'
  )
    throw new Error('local-route-rejected');
  // Local generation never uses a credential or forwards operator/provider-specific headers.
  for (const name of new Headers(request.headers).keys()) {
    if (!['accept', 'content-type', 'user-agent'].includes(name))
      throw new Error('local-header-rejected');
  }
}

export function assertFreeCatalog(model: string, catalog: unknown): void {
  const data = object(catalog)['data'];
  const entry = Array.isArray(data)
    ? data.map(object).find((row) => row['id'] === model)
    : undefined;
  if (entry === undefined)
    throw new EvalBoundaryFailure(
      { phase: 'catalog-validation', code: 'model-missing' },
      'free-catalog-rejected',
    );
  const pricing = object(entry['pricing']);
  const zero = (value: unknown) =>
    typeof value === 'string' && /^0(?:\.0+)?(?:[eE][+-]?\d+)?$/u.test(value);
  const requestAllowed =
    !Object.prototype.hasOwnProperty.call(pricing, 'request') || zero(pricing['request']);
  if (!zero(pricing['prompt']) || !zero(pricing['completion']) || !requestAllowed)
    throw new EvalBoundaryFailure(
      { phase: 'catalog-validation', code: 'price-invalid' },
      'free-catalog-rejected',
    );
  const supported = entry['supported_parameters'];
  if (
    !Array.isArray(supported) ||
    !supported.includes('tools') ||
    !supported.includes('tool_choice')
  )
    throw new EvalBoundaryFailure(
      { phase: 'catalog-validation', code: 'tools-unavailable' },
      'tools-unavailable',
    );
}
export function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function guardRoute(
  options: EvalOptions,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (
    input['model'] !== options.model ||
    input['models'] !== undefined ||
    input['route'] !== undefined ||
    input['plugins'] !== undefined ||
    (options.provider === 'local' && input['provider'] !== undefined)
  )
    throw new Error('route-rejected');
  if (options.allowPaid || options.provider !== 'openrouter') return input;
  return {
    ...input,
    provider: {
      require_parameters: true,
      allow_fallbacks: false,
      max_price: { prompt: 0, completion: 0, request: 0 },
    },
  };
}
export class RequestBudget {
  used = 0;
  interrupted = false;
  private closed = false;
  close(): void {
    this.closed = true;
  }
  constructor(readonly cap: number) {}
  dispatch(): void {
    if (this.closed) throw new Error('request-budget-closed');
    if (this.used >= this.cap) {
      this.interrupted = true;
      throw new Error('request-budget');
    }
    this.used += 1;
  }
}
export class RequestPacer {
  private nextStart = 0;
  private pending = Promise.resolve();
  constructor(
    private readonly spacing: number,
    private readonly now: () => number,
    private readonly delay: (ms: number) => Promise<void>,
  ) {}
  wait(): Promise<void> {
    const ready = this.pending.then(async () => {
      const delay = this.nextStart - this.now();
      if (delay > 0) await this.delay(delay);
      this.nextStart = this.now() + this.spacing;
    });
    this.pending = ready;
    return ready;
  }
}
