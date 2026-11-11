import { createLocalJWKSet } from 'jose/jwks/local';
import { jwtVerify } from 'jose/jwt/verify';
import { z } from 'zod';
import { ProviderFailure } from './providerFailure';

const issuer = 'https://auth.openai.com';
export const planApi = 'https://api.openai.com/v1';
const planScope = 'chatgpt.tokens.use.direct';
export const oauth = {
  authorize: `${issuer}/api/accounts/authorize`,
  token: `${issuer}/api/accounts/oauth/token`,
  keys: `${issuer}/.well-known/jwks.json`,
  revoke: `${issuer}/api/accounts/oauth/revoke`,
} as const;
const text = z.string().min(1).max(32768);
const grant = z.object({
  idToken: text,
  access: text,
  refresh: text.optional(),
  expires: z.number(),
  scope: z.string(),
});
const accountRecord = z.object({
  client: z
    .string()
    .regex(/^oaiapp_[A-Za-z0-9_-]+$/u)
    .max(200),
  subject: text,
  email: z.string().max(512),
  grant: grant.optional(),
});
export type PlanAccount = z.infer<typeof accountRecord>;
const tokenEnvelope = z.object({
  id_token: text.optional(),
  access_token: text,
  refresh_token: text.optional(),
  scope: z.string().max(4096).optional(),
  expires_in: z.number().int().positive(),
  token_type: z.string().refine((value) => value.toLowerCase() === 'bearer'),
});
export const hostRecord = z.object({
  host: z.string().regex(/^urn:uuid:[0-9a-f-]{36}$/u),
  active: z.string().nullable(),
  accounts: z.array(accountRecord),
});
export type PlanHost = z.infer<typeof hostRecord>;
export const allowedPlan = (account: PlanAccount | undefined): boolean =>
  account?.grant?.scope.split(/\s+/u).includes(planScope) === true;

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=/gu, '');
}
interface SignInRequest {
  state: string;
  nonce: string;
  verifier: string;
  url: (redirectUri: string) => URL;
}
export async function signInRequest(
  host: string,
  account?: PlanAccount,
  client = account?.client,
): Promise<SignInRequest> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = base64url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
  );
  const state = crypto.randomUUID(),
    nonce = crypto.randomUUID();
  return {
    state,
    nonce,
    verifier,
    url: (redirectUri: string) => {
      const url = new URL(oauth.authorize);
      url.search = new URLSearchParams({
        client_id: client ?? 'dynamic_agent_client',
        ext_agent_host_id: host,
        response_type: 'code',
        redirect_uri: redirectUri,
        scope: `openid profile email offline_access resource.invoke ${planScope}`,
        resource: planApi,
        state,
        nonce,
        code_challenge_method: 'S256',
        code_challenge: challenge,
        ...(client === undefined ? { agent_name_hint: 'Abyss Tasks' } : {}),
        ...(account?.grant === undefined ? {} : { id_token_hint: account.grant.idToken }),
        ...(account?.grant !== undefined && !allowedPlan(account) ? { prompt: 'consent' } : {}),
      }).toString();
      return url;
    },
  };
}
function singleParameter(params: URLSearchParams, name: string): string | null {
  return params.getAll(name).length === 1 ? params.get(name) : null;
}
export function registrationCallback(
  params: URLSearchParams,
  state: string,
  previous?: string,
): { code: string; issued: string } {
  if (params.has('error') || singleParameter(params, 'state') !== state)
    throw new ProviderFailure('plan-sign-in');
  const code = singleParameter(params, 'code');
  const issued = accountRecord.shape.client.safeParse(params.get('client_id') ?? previous);
  if (
    code === null ||
    code.length === 0 ||
    params.getAll('client_id').length > 1 ||
    !issued.success
  )
    throw new ProviderFailure('plan-sign-in');
  if (previous !== undefined && previous !== issued.data) throw new ProviderFailure('plan-sign-in');
  return { code, issued: issued.data };
}
export async function tokenRequest(
  fetch: typeof window.fetch,
  parameters: Record<string, string>,
  signal: AbortSignal,
): Promise<z.infer<typeof tokenEnvelope>> {
  const result = await fetch(oauth.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...parameters, resource: planApi }).toString(),
    signal,
  });
  const body: unknown = await result.json().catch(() => undefined);
  if (!result.ok) {
    const failure = z
      .object({ error: z.union([z.string(), z.object({ code: z.string() })]) })
      .safeParse(body);
    const error = failure.data?.error;
    const code = typeof error === 'string' ? error : error?.code;
    if (
      code !== undefined &&
      [
        'invalid_grant',
        'invalid_refresh_token',
        'token_expired',
        'refresh_token_expired',
        'refresh_token_invalidated',
        'refresh_token_reused',
      ].includes(code)
    )
      throw new InvalidGrant();
    throw new ProviderFailure(result.status >= 500 ? 'unavailable' : 'plan-sign-in');
  }
  const parsed = tokenEnvelope.safeParse(body);
  if (!parsed.success) throw new ProviderFailure('invalid-response');
  return parsed.data;
}
export class InvalidGrant extends ProviderFailure {
  constructor() {
    super('plan-sign-in');
  }
}
function authorizedParty(
  audience: string | string[] | undefined,
  party: unknown,
  client: string,
): boolean {
  if (Array.isArray(audience) && audience.length > 1) return party === client;
  return party === undefined || party === client;
}
export async function verifiedIdentity(
  fetch: typeof window.fetch,
  idToken: string,
  expected: { client: string; nonce?: string },
  signal: AbortSignal,
): Promise<Pick<PlanAccount, 'subject' | 'email'>> {
  const { client, nonce } = expected;
  const response = await fetch(oauth.keys, { method: 'GET', signal });
  if (!response.ok) throw new ProviderFailure('unavailable');
  const keys = z
    .object({ keys: z.array(z.looseObject({ kty: z.string() })).max(128) })
    .safeParse(await response.json());
  if (!keys.success) throw new ProviderFailure('invalid-response');
  try {
    const { payload } = await jwtVerify(idToken, createLocalJWKSet(keys.data), {
      issuer,
      audience: client,
      algorithms: ['RS256'],
      requiredClaims: ['sub', 'exp', 'iat'],
      clockTolerance: 5,
    });
    if (!authorizedParty(payload.aud, payload['azp'], client))
      throw new ProviderFailure('plan-sign-in');
    if (typeof payload.sub !== 'string' || (nonce !== undefined && payload['nonce'] !== nonce))
      throw new ProviderFailure('plan-sign-in');
    return {
      subject: payload.sub,
      email: typeof payload['email'] === 'string' ? payload['email'] : '',
    };
  } catch {
    throw new ProviderFailure('plan-sign-in');
  }
}
type TokenResponse = Awaited<ReturnType<typeof tokenRequest>>;
export function nextGrant(
  tokens: TokenResponse,
  idToken: string,
  now: number,
  previous?: PlanAccount['grant'],
): NonNullable<PlanAccount['grant']> {
  return {
    idToken,
    access: tokens.access_token,
    refresh: tokens.refresh_token ?? previous?.refresh,
    expires: now + tokens.expires_in * 1000,
    scope: tokens.scope ?? previous?.scope ?? '',
  };
}
