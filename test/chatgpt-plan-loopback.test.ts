// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { desktopChatGptSignIn } from '../src/ai/providers/chatGptLoopback';

afterEach(() => vi.unstubAllGlobals());
function localGet(url: string | URL): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    process
      .getBuiltinModule('http')
      .get(url, (response) => {
        response.resume();
        resolve(response.statusCode);
      })
      .on('error', reject);
  });
}
function host(openExternal: (url: string) => Promise<void>) {
  const open = vi.fn(() => {
    throw Error('Obsidian URL interception');
  });
  const require = vi.fn((_id: string) => ({ shell: { openExternal } }));
  vi.stubGlobal('window', { process, navigator: { locks: { request: vi.fn() } }, require, open });
  const desktop = desktopChatGptSignIn();
  if (desktop === undefined) throw Error('Expected desktop');
  return { desktop, open, require };
}
function authorization(redirectUri: string) {
  const url = new URL('https://auth.openai.com/api/accounts/authorize');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('id_token_hint', 'synthetic-hint');
  return url;
}
it('sends the authorization URL directly to the external browser and accepts only the matching loopback state', async () => {
  const responses: number[] = [];
  const h = host(async (url) => {
    const target = new URL(url);
    expect(target.origin + target.pathname).toBe('https://auth.openai.com/api/accounts/authorize');
    const redirect = new URL(target.searchParams.get('redirect_uri') ?? '');
    expect(redirect.hostname).toBe('127.0.0.1');
    redirect.search = new URLSearchParams({ state: 'wrong', code: 'fixture' }).toString();
    responses.push((await localGet(redirect)) ?? 0);
    redirect.searchParams.set('state', 'right');
    responses.push((await localGet(redirect)) ?? 0);
  });
  const reply = await h.desktop.authorize('right', authorization, new AbortController().signal);
  expect(reply.params.get('code')).toBe('fixture');
  expect(h.open).not.toHaveBeenCalled();
  expect(h.require).toHaveBeenCalledWith('electron');
  await vi.waitFor(() => {
    expect(responses).toEqual([400, 200]);
  });
});
it('closes the callback listener when the external browser fails without leaking its URL', async () => {
  let callback = '';
  const h = host((url) => {
    callback = new URL(url).searchParams.get('redirect_uri') ?? '';
    return Promise.reject(Error(url));
  });
  await expect(
    h.desktop.authorize('right', authorization, new AbortController().signal),
  ).rejects.toMatchObject({ code: 'plan-sign-in' });
  await expect(localGet(callback)).rejects.toThrow();
  expect(h.open).not.toHaveBeenCalled();
});
