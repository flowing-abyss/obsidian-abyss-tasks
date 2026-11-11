import { APICallError } from 'ai';
import { commandMessage, type CommandMessage } from '../commandMessages';
export type ProviderFailureCode =
  | 'plan-storage'
  | 'plan-desktop'
  | 'plan-sign-in'
  | 'plan-permission'
  | 'plan-limit'
  | 'plan-revoke'
  | 'compatible-unavailable'
  | 'missing-key'
  | 'secret-storage'
  | 'authentication'
  | 'billing'
  | 'rate-limit'
  | 'unavailable'
  | 'invalid-response'
  | 'invalid-request'
  | 'query-too-long'
  | 'cancelled'
  | 'timeout'
  | 'busy'
  | 'too-large';
const messages: Record<ProviderFailureCode, CommandMessage> = {
  'plan-storage': 'Could not access the ChatGPT connection in Obsidian secret storage.',
  'plan-desktop': 'Sign in with ChatGPT requires Obsidian desktop.',
  'plan-sign-in': 'Sign in with ChatGPT in the LLM settings and try again.',
  'plan-permission':
    'ChatGPT plan use is unavailable for this account or workspace. Check the connection in LLM settings.',
  'plan-limit': 'The ChatGPT plan limit was reached. Open Manage usage in LLM settings.',
  'plan-revoke':
    'Signed out locally. Disconnect Abyss Tasks in ChatGPT settings to confirm revocation.',
  'compatible-unavailable':
    'Custom servers require an Obsidian desktop runtime with secure HTTP support.',
  'missing-key': 'Save an API key for the selected provider.',
  'secret-storage': 'Could not access the API key in Obsidian secret storage.',
  authentication: 'The provider rejected the API key or its permissions.',
  billing: 'Check your provider billing or credits before trying again.',
  'rate-limit': 'The provider rate limit was reached. Try again later.',
  unavailable: 'The provider request failed. Check the connection and try again.',
  'invalid-response': 'The provider returned an unreadable response.',
  'invalid-request': 'The provider or model configuration is not supported.',
  'query-too-long': 'Shorten the Brave query to 600 characters and 75 words.',
  cancelled: 'The request was cancelled locally. Remote work may still finish.',
  timeout: 'The provider took too long. Remote work may still finish.',
  busy: 'Earlier provider requests are still finishing. Try again shortly.',
  'too-large': 'The provider request or response exceeds the size limit.',
};
/** Only this safe error crosses into UI, diagnostics or session state. */
export class ProviderFailure extends Error {
  constructor(readonly code: ProviderFailureCode) {
    super(commandMessage(messages[code]));
    this.name = 'ProviderFailure';
  }
}
/** Retry only generation, before any returned tool call can execute. */
export function providerRetryable(cause: unknown): boolean {
  if (!APICallError.isInstance(cause))
    return cause instanceof ProviderFailure && ['unavailable', 'rate-limit'].includes(cause.code);
  if (cause.isRetryable) return true;
  if (cause.statusCode !== 400 || cause.url !== 'https://api.cerebras.ai/v1/chat/completions')
    return false;
  const parserFailure = (value: unknown): boolean => {
    const envelope = errorRecord(value);
    const error = errorRecord('error' in envelope ? envelope.error : envelope);
    return (
      'type' in error &&
      error.type === 'generation_error' &&
      'code' in error &&
      error.code === 'parser_error'
    );
  };
  if (parserFailure(cause.data)) return true;
  if (cause.responseBody === undefined || cause.responseBody.length > 65536) return false;
  try {
    return parserFailure(JSON.parse(cause.responseBody) as unknown);
  } catch {
    return false;
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
