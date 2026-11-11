import { Platform } from 'obsidian';
import { oauth } from './chatGptOAuth';
import { ProviderFailure } from './providerFailure';

export interface ChatGptDesktop {
  authorize(
    state: string,
    url: (redirectUri: string) => URL,
    signal: AbortSignal,
  ): Promise<{
    redirectUri: string;
    params: URLSearchParams;
  }>;
  exclusive<T>(work: () => Promise<T>): Promise<T>;
}
interface LoopbackResponse {
  writeHead(status: number, headers?: Record<string, string>): LoopbackResponse;
  end(body?: string, ready?: () => void): void;
}
interface LoopbackServer {
  address(): { port: number } | string | null;
  close(): void;
  closeAllConnections(): void;
  listen(port: number, host: string, ready: () => void): void;
  on(event: 'error', callback: () => void): void;
  on(
    event: 'request',
    callback: (
      request: { url?: string; method?: string; headers: { host?: string } },
      response: LoopbackResponse,
    ) => void,
  ): void;
}
interface DesktopRuntime {
  getBuiltinModule(name: 'http'): {
    createServer(options: { maxHeaderSize: number; requestTimeout: number }): LoopbackServer;
  };
}
type ElectronShell = (id: 'electron') => {
  shell: { openExternal: (url: string) => Promise<void> };
};
async function launchBrowser(loadElectron: ElectronShell, target: URL): Promise<void> {
  if (
    target.origin + target.pathname !== oauth.authorize ||
    target.username !== '' ||
    target.password !== ''
  )
    throw new ProviderFailure('plan-sign-in');
  await loadElectron('electron').shell.openExternal(target.href);
}
export function desktopChatGptSignIn(): ChatGptDesktop | undefined {
  if (!Platform.isDesktop || typeof window === 'undefined') return undefined;
  const host: Window & {
    process?: DesktopRuntime;
    require?: ElectronShell;
  } = window;
  const runtime = host.process;
  const { locks } = host.navigator as Partial<Pick<Navigator, 'locks'>>;
  const loadElectron = host.require;
  if (
    typeof runtime?.getBuiltinModule !== 'function' ||
    locks === undefined ||
    loadElectron === undefined
  )
    return undefined;
  return {
    exclusive: (work) => locks.request('abyss-tasks-chatgpt-plan', work),
    authorize: systemAuthorization(runtime, loadElectron),
  };
}
function systemAuthorization(
  runtime: DesktopRuntime,
  loadElectron: ElectronShell,
): ChatGptDesktop['authorize'] {
  return (state, url, signal) =>
    new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const server = runtime
        .getBuiltinModule('http')
        .createServer({ maxHeaderSize: 12288, requestTimeout: 10000 });
      let redirectUri = '';
      const close = (): void => {
        signal.removeEventListener('abort', abort);
        server.close();
        server.closeAllConnections();
      };
      const abort = (): void => {
        close();
        reject(new ProviderFailure('cancelled'));
      };
      signal.addEventListener('abort', abort, { once: true });
      server.on('error', () => {
        close();
        reject(new ProviderFailure('plan-sign-in'));
      });
      server.on('request', (request, response) => {
        const raw = request.url ?? '';
        const callback = new URL(redirectUri);
        if (
          request.method !== 'GET' ||
          request.headers.host !== callback.host ||
          !raw.startsWith('/auth/callback?') ||
          raw.length > 8192
        ) {
          response.writeHead(404).end();
          return;
        }
        const params = new URLSearchParams(raw.slice(raw.indexOf('?') + 1));
        if (params.getAll('state').length !== 1 || params.get('state') !== state) {
          response.writeHead(400).end();
          return;
        }
        response
          .writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
            'Referrer-Policy': 'no-referrer',
            Connection: 'close',
          })
          .end('Return to Abyss Tasks to finish signing in.', () => {
            close();
            resolve({ redirectUri, params });
          });
      });
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string' || signal.aborted) {
          abort();
          return;
        }
        redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
        // Obsidian's window.open can log the complete URL or route it to Web Viewer.
        // OIDC's returning-account hint belongs only in the system browser.
        void launchBrowser(loadElectron, url(redirectUri)).catch(() => {
          close();
          reject(new ProviderFailure('plan-sign-in'));
        });
      });
    });
}
