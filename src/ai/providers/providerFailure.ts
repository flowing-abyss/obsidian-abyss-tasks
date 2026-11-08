export type ProviderFailureCode =
  | 'missing-key'
  | 'secret-storage'
  | 'authentication'
  | 'billing'
  | 'rate-limit'
  | 'unavailable'
  | 'invalid-response'
  | 'invalid-request'
  | 'cancelled'
  | 'timeout'
  | 'busy'
  | 'too-large';
const messages: Record<ProviderFailureCode, string> = {
  'missing-key': 'Save an API key for the selected provider.',
  'secret-storage': 'Could not access the API key in Obsidian secret storage.',
  authentication: 'The provider rejected the API key or its permissions.',
  billing: 'Check your provider billing or credits before trying again.',
  'rate-limit': 'The provider rate limit was reached. Try again later.',
  unavailable: 'The provider request failed. Check the connection and try again.',
  'invalid-response': 'The provider returned an unreadable response.',
  'invalid-request': 'The provider or model configuration is not supported.',
  cancelled: 'The request was cancelled locally. Remote work may still finish.',
  timeout: 'The provider took too long. Remote work may still finish.',
  busy: 'Earlier provider requests are still finishing. Try again shortly.',
  'too-large': 'The provider request or response exceeds the size limit.',
};
/** Only this safe error crosses into UI, diagnostics or session state. */
export class ProviderFailure extends Error {
  constructor(readonly code: ProviderFailureCode) {
    super(messages[code]);
    this.name = 'ProviderFailure';
  }
}
export function providerFailure(error: unknown, depth = 0): ProviderFailure {
  if (error instanceof ProviderFailure) return error;
  const data = errorRecord(error);
  const status = 'statusCode' in data ? data.statusCode : undefined;
  const http = httpFailure(status);
  if (http !== undefined) return http;
  if (isAbortFailure(data)) return new ProviderFailure('cancelled');
  if (isParseFailure(data)) return new ProviderFailure('invalid-response');
  if ('cause' in data && depth < 4) return providerFailure(data.cause, depth + 1);
  return new ProviderFailure('unavailable');
}

function isParseFailure(data: object): boolean {
  return (
    'name' in data && (data.name === 'AI_JSONParseError' || data.name === 'AI_TypeValidationError')
  );
}

function errorRecord(error: unknown): object {
  return typeof error === 'object' && error !== null ? error : {};
}

function isAbortFailure(data: object): boolean {
  return 'name' in data && data.name === 'AbortError';
}

function httpFailure(status: unknown): ProviderFailure | undefined {
  if (status === 401 || status === 403) return new ProviderFailure('authentication');
  if (status === 402) return new ProviderFailure('billing');
  if (status === 429) return new ProviderFailure('rate-limit');
  return undefined;
}
