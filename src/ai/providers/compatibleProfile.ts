import { z } from 'zod';
import type { NativeProviderTransport } from './NativeProviderTransport';
import type { ProviderSecrets } from './ProviderSecrets';
import { ProviderFailure } from './providerFailure';

export type CompatibleRole = 'agent' | 'voice';

const profileSchema = z.object({
  baseURL: z.string(),
  model: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^\r\n]+$/u),
  secret: z
    .object({
      baseURL: z.string(),
      id: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .regex(/^[^\r\n]+$/u),
    })
    .nullish(),
});

/** A stable full API base for comparing a request and its native secret binding. */
export function compatibleBase(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text.length > 2048 || !/^https?:\/\/[^/?#\\]+/iu.test(text) || /[\s?#\\]/u.test(text))
    return undefined;
  const authority = text.slice(text.indexOf('//') + 2).split('/')[0];
  if (authority?.includes('@') === true || text.split('/').some(unsafeSegment)) return undefined;
  try {
    const url = new URL(text).href;
    let end = url.length;
    while (url[end - 1] === '/') end--;
    return url.slice(0, end);
  } catch {
    return undefined;
  }
}

function unsafeSegment(segment: string): boolean {
  try {
    const decoded = decodeURIComponent(segment);
    return decoded === '.' || decoded === '..' || /[/\\\r\n]/u.test(decoded);
  } catch {
    return true;
  }
}

export function compatibleConnection(
  role: CompatibleRole,
  value: unknown,
  secrets: ProviderSecrets,
  transport: NativeProviderTransport,
): { baseURL: string; model: string; fetch: typeof fetch; apiKey: string } {
  const profile = profileSchema.safeParse(value);
  if (!profile.success) throw new ProviderFailure('invalid-request');
  const { model, secret } = profile.data;
  const baseURL = compatibleBase(profile.data.baseURL);
  if (baseURL === undefined || (secret != null && compatibleBase(secret.baseURL) !== baseURL))
    throw new ProviderFailure('invalid-request');
  const fetch = transport.compatibleFetch(
    role,
    { baseURL, model },
    secret == null ? undefined : secrets.resolveId(secret.id),
  );
  // Both SDKs otherwise consult their cloud environment key. Only the transport owns wire headers.
  return { model, baseURL, apiKey: '', fetch };
}
