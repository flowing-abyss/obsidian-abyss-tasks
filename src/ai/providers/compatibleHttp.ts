import { Platform, type RequestUrlParam, type RequestUrlResponse } from 'obsidian';
import { ProviderFailure } from './providerFailure';

interface IncomingMessage extends AsyncIterable<Uint8Array> {
  readonly statusCode?: number | undefined;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  destroy(): void;
}
interface DesktopHttp {
  request(
    url: string,
    options: {
      method: 'POST' | 'GET';
      headers: Record<string, string>;
      signal: AbortSignal;
      agent: false;
      autoSelectFamilyAttemptTimeout: number;
    },
    receive: (response: IncomingMessage) => void,
  ): {
    on(type: 'error', reject: (reason: unknown) => void): void;
    end(body: string | Uint8Array): void;
  };
}
interface DesktopModules {
  getBuiltinModule(name: 'http' | 'https'): DesktopHttp;
}
export type CompatibleRequest = (
  request: RequestUrlParam,
  signal: AbortSignal,
) => Promise<Pick<RequestUrlResponse, 'arrayBuffer' | 'headers' | 'status'>>;
export const providerResponseLimit = 8 * 1024 * 1024;

/** Native requestUrl has no redirect control. A custom server gets one desktop HTTP POST only. */
export function desktopCompatibleRequest(): CompatibleRequest | undefined {
  if (!Platform.isDesktop || typeof window === 'undefined') return undefined;
  const desktopWindow: Window & { process?: DesktopModules } = window;
  const runtime = desktopWindow.process;
  if (typeof runtime?.getBuiltinModule !== 'function') return undefined;
  return (params, signal) => {
    const http = params.url.startsWith('https:')
      ? runtime.getBuiltinModule('https')
      : runtime.getBuiltinModule('http');
    return new Promise((resolve, reject) => {
      const request = http.request(
        params.url,
        {
          method: params.method === 'GET' ? 'GET' : 'POST',
          headers: { ...params.headers, 'Accept-Encoding': 'identity' },
          signal,
          agent: false,
          // Electron's 250 ms default can abandon every reachable address on a slower route.
          autoSelectFamilyAttemptTimeout: 1500,
        },
        (response) => {
          void readResponse(response).then(resolve, reject);
        },
      );
      request.on('error', reject);
      request.end(
        typeof params.body === 'string'
          ? params.body
          : new Uint8Array(params.body ?? new ArrayBuffer(0)),
      );
    });
  };
}

async function readResponse(response: IncomingMessage): ReturnType<CompatibleRequest> {
  const status = response.statusCode ?? 0;
  const encoding = response.headers['content-encoding'];
  if (
    status < 200 ||
    (status >= 300 && status < 400) ||
    (encoding !== undefined && encoding !== 'identity')
  ) {
    response.destroy();
    throw new ProviderFailure('invalid-response');
  }
  const arrayBuffer = await boundedBody(response);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(response.headers))
    if (value !== undefined) headers[key] = Array.isArray(value) ? value.join(', ') : value;
  return { status, headers, arrayBuffer };
}

async function boundedBody(response: IncomingMessage): Promise<ArrayBuffer> {
  if (Number(response.headers['content-length']) > providerResponseLimit) {
    response.destroy();
    throw new ProviderFailure('too-large');
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const body: AsyncIterable<Uint8Array> = response;
  for await (const bytes of body) {
    total += bytes.byteLength;
    if (total > providerResponseLimit) {
      response.destroy();
      throw new ProviderFailure('too-large');
    }
    chunks.push(bytes);
  }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data.buffer;
}
