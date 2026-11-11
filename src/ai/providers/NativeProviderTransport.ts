import type { RequestUrlParam, RequestUrlResponse } from 'obsidian';
import { oauth, planApi } from './chatGptOAuth';
import {
  desktopCompatibleRequest,
  providerResponseLimit,
  type CompatibleRequest,
} from './compatibleHttp';
import { compatibleBase, type CompatibleRole } from './compatibleProfile';
import { isCatalogUrl } from './providerCatalogRoutes';
import { ProviderFailure } from './providerFailure';
import { VOICE_MODELS, type CredentialProvider } from './providerSettings';

export type ProviderSchedule = (callback: () => void, delayMs: number) => () => void;
export type NativeRequest = (request: RequestUrlParam) => Promise<RequestUrlResponse>;
export const providerEndpoints: Record<CredentialProvider, readonly [string, ...string[]]> = {
  openrouter: ['https://openrouter.ai/api/v1/chat/completions'],
  openai: ['https://api.openai.com/v1/responses', 'https://api.openai.com/v1/audio/transcriptions'],
  anthropic: ['https://api.anthropic.com/v1/messages'],
  groq: [
    'https://api.groq.com/openai/v1/chat/completions',
    'https://api.groq.com/openai/v1/audio/transcriptions',
  ],
  cerebras: ['https://api.cerebras.ai/v1/chat/completions'],
  tavily: ['https://api.tavily.com/search'],
  exa: ['https://api.exa.ai/search'],
  firecrawl: ['https://api.firecrawl.dev/v2/search'],
  brave: ['https://api.search.brave.com/res/v1/web/search'],
};
interface PendingRequest {
  readonly start: () => void;
  readonly cancel: () => void;
}
interface PreparedRequest {
  readonly params: RequestUrlParam;
  readonly multipart?: FormData;
  readonly compatible?: CompatibleRequest;
}
/** Official requestUrl routes and redirect-free custom routes share one bounded queue.
 * Each SDK fetch is restricted to its provider's accepted routes and payloads. */
export class NativeProviderTransport {
  readonly #request: NativeRequest;
  readonly #compatibleRequest: CompatibleRequest | undefined;
  readonly #schedule: ProviderSchedule;
  readonly #queue: PendingRequest[] = [];
  readonly #pending = new Set<PendingRequest>();
  #active = 0;
  #disposed = false;
  constructor(
    request: NativeRequest,
    schedule: ProviderSchedule,
    compatibleRequest = desktopCompatibleRequest(),
  ) {
    this.#compatibleRequest = compatibleRequest;
    this.#request = request;
    this.#schedule = schedule;
  }

  fetchFor(provider: CredentialProvider): typeof fetch {
    return this.bounded((input, init) => requestParams(provider, input, init));
  }

  /** Direct OAuth and inference share the native queue and reject HTTP redirects. */
  chatGptFetch(): typeof fetch {
    return this.bounded((input, init) => {
      const request = this.#compatibleRequest;
      if (request === undefined) throw new ProviderFailure('plan-desktop');
      return { compatible: request, params: planRequest(input, init) };
    });
  }

  compatibleFetch(
    role: CompatibleRole,
    profile: { readonly baseURL: string; readonly model: string },
    key?: string,
  ): typeof fetch {
    const request = this.#compatibleRequest;
    if (request === undefined) throw new ProviderFailure('compatible-unavailable');
    const base = compatibleBase(profile.baseURL);
    if (base === undefined) throw new ProviderFailure('invalid-request');
    const endpoint = base + (role === 'agent' ? '/chat/completions' : '/audio/transcriptions');
    return this.bounded((input, init) => {
      if (input !== endpoint || init.method !== 'POST')
        throw new ProviderFailure('invalid-request');
      const headers: Record<string, string> = {};
      if (key !== undefined) headers['authorization'] = `Bearer ${key}`;
      const params = { url: endpoint, method: 'POST', headers, throw: false };
      if (role === 'voice') {
        if (!(init.body instanceof FormData)) throw new ProviderFailure('invalid-request');
        return {
          params,
          compatible: request,
          multipart: transcriptionBody(init.body, [profile.model]),
        };
      }
      headers['content-type'] = 'application/json';
      const body = jsonBody(init.body, profile.model);
      if (body === undefined) throw new ProviderFailure('invalid-request');
      return { params: { ...params, body }, compatible: request };
    });
  }

  private bounded(
    prepare: (input: RequestInfo | URL, init: RequestInit) => PreparedRequest,
  ): typeof fetch {
    return async (input, init = {}) => {
      const params = prepare(input, init);
      if (this.#disposed) throw new ProviderFailure('cancelled');
      if (this.#pending.size >= 10) throw new ProviderFailure('busy');
      const signal = init.signal;
      if (signal?.aborted === true) throw new ProviderFailure('cancelled');
      return this.enqueue(params, signal);
    };
  }

  private enqueue(
    params: PreparedRequest,
    signal: AbortSignal | null | undefined,
  ): Promise<Response> {
    return new Promise<Response>((resolve, reject) => {
      const physical = new AbortController();
      let accepting = true;
      const finish = (error?: ProviderFailure, value?: Response): void => {
        if (!accepting) return;
        accepting = false;
        cancelTimer();
        signal?.removeEventListener('abort', cancelled);
        const index = this.#queue.indexOf(pending);
        if (index >= 0) {
          this.#queue.splice(index, 1);
          this.#pending.delete(pending);
        }
        if (error !== undefined) {
          physical.abort();
          reject(error);
        } else if (value !== undefined) resolve(value);
      };
      const cancelled = (): void => {
        finish(new ProviderFailure('cancelled'));
      };
      const cancelTimer = this.#schedule(() => {
        finish(new ProviderFailure('timeout'));
      }, 60_000);
      const pending: PendingRequest = {
        cancel: cancelled,
        start: () => {
          this.#active += 1;
          void this.dispatch(params, physical.signal)
            .then(
              (response) => {
                finish(undefined, response);
              },
              (error: unknown) => {
                finish(
                  error instanceof ProviderFailure ? error : new ProviderFailure('unavailable'),
                );
              },
            )
            .finally(() => {
              this.#active -= 1;
              this.#pending.delete(pending);
              this.drain();
            });
        },
      };
      this.#pending.add(pending);
      this.#queue.push(pending);
      signal?.addEventListener('abort', cancelled, { once: true });
      this.drain();
    });
  }

  private async dispatch(prepared: PreparedRequest, signal: AbortSignal): Promise<Response> {
    const params =
      prepared.multipart === undefined
        ? prepared.params
        : await multipartParams(prepared.params, prepared.multipart);
    if (signal.aborted) throw new ProviderFailure('cancelled');
    const result =
      prepared.compatible === undefined
        ? await this.#request(params)
        : await prepared.compatible(params, signal);
    if (result.arrayBuffer.byteLength > providerResponseLimit)
      throw new ProviderFailure('too-large');
    return new Response(result.arrayBuffer, { status: result.status, headers: result.headers });
  }
  private drain(): void {
    while (!this.#disposed && this.#active < 2 && this.#queue.length > 0)
      this.#queue.shift()?.start();
  }
  dispose(): void {
    this.#disposed = true;
    for (const pending of this.#pending) pending.cancel();
  }
}

const planRoutes = new Map<string, { method: 'GET' | 'POST'; bearer: boolean }>([
  [oauth.keys, { method: 'GET', bearer: false }],
  [oauth.token, { method: 'POST', bearer: false }],
  [oauth.revoke, { method: 'POST', bearer: false }],
  [`${planApi}/models`, { method: 'GET', bearer: true }],
  [`${planApi}/responses`, { method: 'POST', bearer: true }],
]);
function planRequest(input: RequestInfo | URL, init: RequestInit): RequestUrlParam {
  if (typeof input !== 'string') throw new ProviderFailure('invalid-request');
  const route = planRoutes.get(input);
  if (route === undefined || init.method !== route.method)
    throw new ProviderFailure('invalid-request');
  const headers = new Headers(init.headers);
  const credential = headers.get('Authorization');
  if (route.bearer ? credential?.startsWith('Bearer ') !== true : credential !== null)
    throw new ProviderFailure('invalid-request');
  return {
    url: input,
    method: route.method,
    headers: Object.fromEntries(headers.entries()),
    throw: false,
    ...planBody(route.method, init.body),
  };
}
function planBody(method: string, value: RequestInit['body']): { body?: string } {
  if (method === 'GET' && value == null) return {};
  if (method !== 'POST' || typeof value !== 'string') throw new ProviderFailure('invalid-request');
  if (new TextEncoder().encode(value).byteLength > 4 * 1024 * 1024)
    throw new ProviderFailure('too-large');
  return { body: value };
}
function requestParams(
  provider: CredentialProvider,
  input: RequestInfo | URL,
  init: RequestInit = {},
): PreparedRequest {
  if (typeof input !== 'string' && !(input instanceof URL))
    throw new ProviderFailure('invalid-request');
  const url = typeof input === 'string' ? input : input.href;
  if (init.method === 'GET') return catalogRequest(provider, url, init);
  if (!providerEndpoints[provider].includes(url)) throw new ProviderFailure('invalid-request');
  const payload = requestBody(url, init);
  return {
    params: {
      url,
      method: init.method ?? 'POST',
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      ...('body' in payload ? { body: payload.body } : {}),
      throw: false,
    },
    ...('multipart' in payload ? { multipart: payload.multipart } : {}),
  };
}
function catalogRequest(
  provider: CredentialProvider,
  url: string,
  init: RequestInit,
): PreparedRequest {
  if (!isCatalogUrl(provider, url) || init.body != null)
    throw new ProviderFailure('invalid-request');
  return {
    params: {
      url,
      method: 'GET',
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      throw: false,
    },
  };
}
function transcriptionProvider(url: string): 'openai' | 'groq' {
  if (url === 'https://api.openai.com/v1/audio/transcriptions') return 'openai';
  if (url === 'https://api.groq.com/openai/v1/audio/transcriptions') return 'groq';
  throw new ProviderFailure('invalid-request');
}

function requestBody(
  url: string,
  init: RequestInit | undefined,
): { body?: string; multipart?: FormData } {
  const multipart = init?.body instanceof FormData ? init.body : undefined;
  if (multipart !== undefined) {
    if ((init?.method ?? 'POST') !== 'POST') throw new ProviderFailure('invalid-request');
    return { multipart: transcriptionBody(multipart, VOICE_MODELS[transcriptionProvider(url)]) };
  }
  const body = jsonBody(init?.body);
  return body === undefined ? {} : { body };
}
function transcriptionBody(form: FormData, models: readonly string[]): FormData {
  const entries = [...form.entries()];
  const model = form.get('model');
  if (entries.length !== 2 || typeof model !== 'string' || !models.includes(model))
    throw new ProviderFailure('invalid-request');
  const file = form.get('file');
  if (file === null || typeof file === 'string') throw new ProviderFailure('invalid-request');
  if (file.size > 4 * 1024 * 1024) throw new ProviderFailure('too-large');
  if (file.size === 0) throw new ProviderFailure('invalid-request');
  const retained = new FormData();
  for (const [name, value] of form.entries()) retained.append(name, value);
  return retained;
}
async function multipartParams(params: RequestUrlParam, form: FormData): Promise<RequestUrlParam> {
  const encoded = new Response(form);
  const body = await encoded.arrayBuffer();
  if (body.byteLength > 4 * 1024 * 1024 + 65536) throw new ProviderFailure('too-large');
  const contentType = encoded.headers.get('content-type');
  if (contentType?.startsWith('multipart/form-data; boundary=') !== true)
    throw new ProviderFailure('invalid-request');
  const headers = new Headers(params.headers);
  headers.set('Content-Type', contentType);
  return { ...params, headers: Object.fromEntries(headers.entries()), body };
}
function jsonBody(body: BodyInit | null | undefined, model?: string): string | undefined {
  if (body == null) return undefined;
  if (typeof body !== 'string') throw new ProviderFailure('invalid-request');
  if (new TextEncoder().encode(body).byteLength > 4 * 1024 * 1024)
    throw new ProviderFailure('too-large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new ProviderFailure('invalid-request');
  }
  if (model !== undefined && !matchesChat(parsed, model))
    throw new ProviderFailure('invalid-request');
  if (isStreaming(parsed)) throw new ProviderFailure('invalid-request');
  return body;
}

function isStreaming(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'stream' in value && value.stream === true;
}

function matchesChat(value: unknown, model: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'model' in value &&
    value.model === model &&
    'messages' in value &&
    Array.isArray(value.messages)
  );
}
