// @vitest-environment node
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { expect, it, vi } from 'vitest';
import { ChatGptPlan } from '../src/ai/providers/ChatGptPlan';
import { type ChatGptDesktop } from '../src/ai/providers/chatGptLoopback';
const issuer = 'https://auth.openai.com';
const key = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(key.publicKey)), alg: 'RS256', kid: 'test-key' };
const direct = 'openid offline_access resource.invoke chatgpt.tokens.use.direct';
async function fixture() {
  const values = new Map<string, string>();
  const issued = 'oaiapp_fixture';
  const attempts: URL[] = [],
    forms: URLSearchParams[] = [];
  const mutable = {
    callbackState: '',
    nonce: '',
    scopes: direct,
    now: Date.now(),
    client: issued,
    identity: 'synthetic-user',
    tokenError: '',
    hold: undefined as Promise<void> | undefined,
  };
  const desktop: ChatGptDesktop = {
    authorize: (state, url) => {
      const redirectUri = 'http://127.0.0.1:12345/auth/callback';
      attempts.push(url(redirectUri));
      return Promise.resolve({
        redirectUri,
        params: new URLSearchParams({
          code: 'synthetic-code',
          state: mutable.callbackState === '' ? state : mutable.callbackState,
          client_id: mutable.client,
        }),
      });
    },
    // Model separate foreground/background requests sharing a rotating refresh token.
    exclusive: (() => {
      let tail = Promise.resolve();
      return <T>(work: () => Promise<T>) => {
        const result = tail.then(() => mutable.hold).then(work);
        tail = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      };
    })(),
  };
  const fetch = vi.fn<typeof window.fetch>(async (input, init) => {
    if (input === `${issuer}/.well-known/jwks.json`) return Response.json({ keys: [jwk] });
    if (input === `${issuer}/api/accounts/oauth/revoke`) return new Response(null, { status: 200 });
    if (input === 'https://api.openai.com/v1/models')
      return Response.json({
        models: [
          { slug: 'model-a', display_name: 'Model A', visibility: 'list' },
          { slug: 'model-b', display_name: 'Model B', visibility: 'hide' },
        ],
      });
    if (input !== `${issuer}/api/accounts/oauth/token`) throw Error('Unexpected route');
    const body = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
    forms.push(body);
    if (mutable.tokenError !== '') {
      const error = mutable.tokenError;
      mutable.tokenError = '';
      return Response.json({ error }, { status: 400 });
    }
    const id = await new SignJWT({
      nonce:
        mutable.nonce === ''
          ? attempts[attempts.length - 1]?.searchParams.get('nonce')
          : mutable.nonce,
      email: 'synthetic@example.test',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(issuer)
      .setSubject(mutable.identity)
      .setAudience(mutable.client)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(key.privateKey);
    return Response.json({
      id_token: id,
      access_token: `synthetic-access-${forms.length}`,
      refresh_token: `synthetic-refresh-${forms.length}`,
      scope: mutable.scopes,
      expires_in: 3600,
      token_type: 'Bearer',
    });
  });
  const open = () =>
    new ChatGptPlan(
      {
        getSecret: (id) => values.get(id) ?? null,
        setSecret: (id, value) => {
          values.set(id, value);
        },
      },
      fetch,
      desktop,
      () => mutable.now,
    );
  return { plan: open(), open, values, mutable, attempts, forms, fetch, issued };
}
it('does PKCE, verifies the identity and uses only the plugin OAuth grant for the account catalog', async () => {
  const h = await fixture();
  await h.plan.signIn(undefined, new AbortController().signal);
  const url = h.attempts[0];
  if (url === undefined) throw new Error('Expected authorization attempt');
  expect(url.origin + url.pathname).toBe(`${issuer}/api/accounts/authorize`);
  expect(url.searchParams.get('client_id')).toBe('dynamic_agent_client');
  expect(url.searchParams.get('ext_agent_host_id')).toMatch(/^urn:uuid:/);
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('code_challenge')).not.toBe(h.forms[0]?.get('code_verifier'));
  expect(h.forms[0]?.get('client_id')).toBe(h.issued);
  expect(h.plan.state()).toMatchObject({ active: h.issued, ready: true });
  expect(JSON.stringify(h.plan.state())).not.toContain('synthetic-access-');
  expect(await h.plan.list(new AbortController().signal)).toEqual([
    { id: 'model-a', name: 'Model A' },
  ]);
  expect(
    h.fetch.mock.calls.filter(([url]) => url === 'https://api.openai.com/v1/models')[0]?.[1]
      ?.headers,
  ).toEqual({ Authorization: 'Bearer synthetic-access-1' });
  await h.plan.signOut(new AbortController().signal);
  expect(h.plan.state()).toMatchObject({ ready: false });
  expect(JSON.stringify([...h.values.values()])).not.toContain('synthetic-refresh-');
  await h.plan.signIn(h.issued, new AbortController().signal);
  expect(h.attempts[1]?.searchParams.get('client_id')).toBe(h.issued);
  expect(h.attempts[1]?.searchParams.get('ext_agent_host_id')).toBe(
    url.searchParams.get('ext_agent_host_id'),
  );
});
it('rejects a mismatched state before token exchange and an invalid identity before activation', async () => {
  const h = await fixture();
  h.mutable.callbackState = 'unbound';
  await expect(h.plan.signIn(undefined, new AbortController().signal)).rejects.toMatchObject({
    code: 'plan-sign-in',
  });
  expect(h.forms).toHaveLength(0);
  h.mutable.callbackState = '';
  h.mutable.nonce = 'incorrect';
  await expect(h.plan.signIn(undefined, new AbortController().signal)).rejects.toMatchObject({
    code: 'plan-sign-in',
  });
  expect(h.plan.state().ready).toBe(false);
});
it('preserves a verified registration after declined plan scope and explicitly requests reconsent', async () => {
  const h = await fixture();
  h.mutable.scopes = 'openid profile email';
  await h.plan.signIn(undefined, new AbortController().signal);
  await expect(h.plan.list(new AbortController().signal)).rejects.toMatchObject({
    code: 'plan-permission',
  });
  h.mutable.scopes = direct;
  await h.plan.signIn(h.issued, new AbortController().signal);
  expect(h.attempts[1]?.searchParams.get('prompt')).toBe('consent');
  expect(h.plan.state().ready).toBe(true);
});
it('restores the selected account after restart and serializes refresh on its rotated credentials', async () => {
  const h = await fixture();
  await h.plan.signIn(undefined, new AbortController().signal);
  h.plan.dispose();
  const restored = h.open();
  expect(restored.state()).toMatchObject({ active: h.issued, ready: true });
  h.mutable.now += 3600_000;
  await Promise.all([
    restored.list(new AbortController().signal),
    restored.list(new AbortController().signal),
  ]);
  expect(h.forms.map((form) => form.get('grant_type'))).toEqual([
    'authorization_code',
    'refresh_token',
  ]);
  expect(h.forms[1]?.get('refresh_token')).toBe('synthetic-refresh-1');
  expect(
    h.fetch.mock.calls
      .filter(([url]) => url === 'https://api.openai.com/v1/models')
      .map(([, init]) => init?.headers),
  ).toEqual([
    { Authorization: 'Bearer synthetic-access-2' },
    { Authorization: 'Bearer synthetic-access-2' },
  ]);
});

it('retries an expired first authorization code with the issued ID and fresh PKCE before activating it', async () => {
  const h = await fixture();
  h.mutable.tokenError = 'invalid_grant';
  await h.plan.signIn(undefined, new AbortController().signal);
  expect(h.attempts.map((item) => item.searchParams.get('client_id'))).toEqual([
    'dynamic_agent_client',
    h.issued,
  ]);
  expect(h.attempts[1]?.searchParams.has('agent_name_hint')).toBe(false);
  expect(h.attempts[0]?.searchParams.get('state')).not.toBe(
    h.attempts[1]?.searchParams.get('state'),
  );
  expect(h.forms[0]?.get('code_verifier')).not.toBe(h.forms[1]?.get('code_verifier'));
  expect(h.plan.state().ready).toBe(true);
});
it('clears unusable rotating tokens and keeps the verified account registration for reauthorization', async () => {
  const h = await fixture();
  const signal = new AbortController().signal;
  await h.plan.signIn(undefined, signal);
  h.mutable.now += 3600000;
  h.mutable.tokenError = 'invalid_grant';
  await expect(h.plan.list(signal)).rejects.toMatchObject({ code: 'plan-sign-in' });
  expect(h.plan.state()).toMatchObject({ active: h.issued, connected: false, ready: false });
  expect(JSON.stringify([...h.values.values()])).not.toContain('synthetic-refresh-');
});
it('cancels queued account selection and initial host registration after their owner closes', async () => {
  const h = await fixture();
  const signal = new AbortController().signal;
  await h.plan.signIn(undefined, signal);
  h.mutable.client = 'oaiapp_second';
  await h.plan.signIn(undefined, signal);
  let unlock = () => {};
  h.mutable.hold = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const controller = new AbortController();
  const waiting = h.plan.select(h.issued, controller.signal);
  controller.abort();
  unlock();
  await expect(waiting).rejects.toThrow();
  expect(h.plan.state().active).toBe('oaiapp_second');
  const fresh = await fixture();
  fresh.mutable.hold = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const initial = fresh.plan.signIn(undefined, signal);
  fresh.plan.dispose();
  unlock();
  await expect(initial).rejects.toThrow();
  expect(fresh.values.size).toBe(0);
});
