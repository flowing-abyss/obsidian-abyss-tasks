import type { RequestUrlParam, RequestUrlResponse } from 'obsidian';
import { ProviderFailure } from './providerFailure';
import type { CredentialProvider } from './providerSettings';

export type ProviderSchedule = (callback: () => void, delayMs: number) => () => void;
export type NativeRequest = (request: RequestUrlParam) => Promise<RequestUrlResponse>;
const endpoints: Record<CredentialProvider, readonly string[]> = {
  openrouter: ['https://openrouter.ai/api/v1/chat/completions'],
  openai: ['https://api.openai.com/v1/responses', 'https://api.openai.com/v1/audio/transcriptions'],
  anthropic: ['https://api.anthropic.com/v1/messages'],
  tavily: ['https://api.tavily.com/search'],
};
interface PendingRequest {
  readonly start: () => void;
  readonly cancel: () => void;
}
/** requestUrl buffers responses and follows redirects. It cannot physically abort or
 * enforce Fetch redirect policy. Fixed official endpoints are the trust boundary;
 * this transport must never be used to fetch arbitrary research source pages. */
export class NativeProviderTransport {
  readonly #request: NativeRequest;
  readonly #schedule: ProviderSchedule;
  readonly #queue: PendingRequest[] = [];
  readonly #pending = new Set<PendingRequest>();
  #active = 0;
  #disposed = false;
  constructor(request: NativeRequest, schedule: ProviderSchedule) {
    this.#request = request;
    this.#schedule = schedule;
  }

  fetchFor(provider: CredentialProvider): typeof fetch {
    return async (input, init) => {
      const params = requestParams(provider, input, init);
      if (this.#disposed) throw new ProviderFailure('cancelled');
      if (this.#pending.size >= 10) throw new ProviderFailure('busy');
      const signal = init?.signal;
      if (signal?.aborted === true) throw new ProviderFailure('cancelled');
      return this.enqueue(params, signal);
    };
  }

  private enqueue(
    params: RequestUrlParam,
    signal: AbortSignal | null | undefined,
  ): Promise<Response> {
    return new Promise<Response>((resolve, reject) => {
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
        if (error !== undefined) reject(error);
        else if (value !== undefined) resolve(value);
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
          void this.dispatch(params)
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

  private async dispatch(params: RequestUrlParam): Promise<Response> {
    const result = await this.#request(params);
    if (result.arrayBuffer.byteLength > 8 * 1024 * 1024) throw new ProviderFailure('too-large');
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

function requestParams(
  provider: CredentialProvider,
  input: RequestInfo | URL,
  init?: RequestInit,
): RequestUrlParam {
  if (typeof input !== 'string' && !(input instanceof URL))
    throw new ProviderFailure('invalid-request');
  const url = typeof input === 'string' ? input : input.href;
  if (!endpoints[provider].includes(url)) throw new ProviderFailure('invalid-request');
  const body = jsonBody(init?.body);
  return {
    url,
    method: init?.method ?? 'POST',
    headers: Object.fromEntries(new Headers(init?.headers).entries()),
    ...(body === undefined ? {} : { body }),
    throw: false,
  };
}
function jsonBody(body: BodyInit | null | undefined): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body !== 'string') throw new ProviderFailure('invalid-request');
  if (new TextEncoder().encode(body).byteLength > 4 * 1024 * 1024)
    throw new ProviderFailure('too-large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new ProviderFailure('invalid-request');
  }
  if (typeof parsed === 'object' && parsed !== null && 'stream' in parsed && parsed.stream === true)
    throw new ProviderFailure('invalid-request');
  return body;
}
