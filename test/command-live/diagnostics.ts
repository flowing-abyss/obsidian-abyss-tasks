export type BoundaryPhase =
  | 'catalog-fetch'
  | 'catalog-response'
  | 'catalog-body'
  | 'catalog-validation'
  | 'completion-fetch'
  | 'completion-body'
  | 'completion-response'
  | 'campaign';
export type BoundaryCode =
  | 'transport-rejected'
  | 'timeout'
  | 'authentication'
  | 'billing'
  | 'rate-limited'
  | 'unavailable'
  | 'http-rejected'
  | 'body-read-rejected'
  | 'invalid-provider-response'
  | 'invalid-json'
  | 'model-missing'
  | 'price-invalid'
  | 'tools-unavailable'
  | 'provider-error-envelope'
  | 'evaluator-failure'
  | 'checkpoint-write-failed'
  | 'checkpoint-write-timeout';
export interface BoundaryDiagnostic {
  phase: BoundaryPhase;
  code: BoundaryCode;
  status?: number;
  providerCode?: number;
}
export class EvalBoundaryFailure extends Error {
  constructor(
    readonly diagnostic: BoundaryDiagnostic,
    message = `${diagnostic.phase}:${diagnostic.code}`,
  ) {
    super(message);
    this.name = 'EvalBoundaryFailure';
  }
}
export function safeDiagnostic(error: unknown, fallback: BoundaryDiagnostic): BoundaryDiagnostic {
  return error instanceof EvalBoundaryFailure ? error.diagnostic : fallback;
}
export function transportCode(error: unknown): BoundaryCode {
  return error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)
    ? 'timeout'
    : 'transport-rejected';
}
export function httpCode(status: number): BoundaryCode {
  if (status === 401 || status === 403) return 'authentication';
  if (status === 402) return 'billing';
  if (status === 429) return 'rate-limited';
  return status >= 500 ? 'unavailable' : 'http-rejected';
}
interface Event {
  kind: string;
  data: unknown;
}
function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}
export function summarizeCompletionRequests(events: readonly Event[]) {
  const responses = events
    .filter((event) => event.kind === 'http')
    .map((event) => record(event.data));
  const usage = events
    .filter((event) => event.kind === 'http-dispatch')
    .map((event) =>
      record(
        responses.find((response) => response['request'] === record(event.data)['request'])?.[
          'usage'
        ],
      ),
    );
  const total = (key: string) =>
    usage.reduce((sum, item) => sum + (typeof item[key] === 'number' ? item[key] : 0), 0);
  return {
    providerCompletionRequests: usage.length,
    knownTokens: total('total_tokens'),
    unknownUsageRequests: usage.filter((item) => item['total_tokens'] === undefined).length,
    knownCost: total('cost'),
    unknownCostRequests: usage.filter((item) => item['cost'] === undefined).length,
  };
}

export function diagnosticOutcome(
  diagnostic: BoundaryDiagnostic,
): 'unavailable' | 'evaluator-failure' | 'provider-failure' {
  if (diagnostic.phase === 'catalog-validation') return 'unavailable';
  return diagnostic.phase === 'campaign' ? 'evaluator-failure' : 'provider-failure';
}

/** New artifacts only; original campaigns retain their original classification. */
export const evaluationPolicyVersion = 'turn-generation-recovery-v2';
interface SequencedEvent extends Event {
  sequence: number;
}
interface Attempt {
  identity: { turn: number | null; generation: number | null; attempt: number | null };
  events: SequencedEvent[];
}
interface AttemptFailure {
  turn: number | null;
  generation: number | null;
  attempt: number | null;
  sequence: number;
  request?: number;
  diagnostic: BoundaryDiagnostic;
}
function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}
function completionFailure(event: SequencedEvent): BoundaryDiagnostic | undefined {
  const data = record(event.data);
  if (event.kind === 'http-failure')
    return data['phase'] === 'completion-body'
      ? { phase: 'completion-body', code: 'body-read-rejected', status: Number(data['status']) }
      : {
          phase: 'completion-fetch',
          code: data['code'] === 'timeout' ? 'timeout' : 'transport-rejected',
        };
  if (event.kind !== 'http') return undefined;
  const status = Number(data['status']);
  if (status < 400 && data['providerError'] !== true) return undefined;
  const providerCode = numberOrNull(record(data['diagnostic'])['providerCode']);
  const responseCode = status >= 400 ? httpCode(status) : 'provider-error-envelope';
  return {
    phase: 'completion-response',
    code: providerCode === null ? responseCode : httpCode(providerCode),
    status,
    ...(providerCode === null ? {} : { providerCode }),
  };
}
function acceptedResponse(attempt: Attempt) {
  const output = attempt.events.find(
    (event) =>
      event.kind === 'generation-output' &&
      record(event.data)['turn'] === attempt.identity.turn &&
      record(event.data)['generation'] === attempt.identity.generation &&
      record(event.data)['attempt'] === attempt.identity.attempt,
  );
  if (output === undefined) return undefined;
  const dispatches = attempt.events.filter((event) => event.kind === 'http-dispatch');
  const dispatch = dispatches[dispatches.length - 1];
  if (dispatch === undefined) return undefined;
  const request = numberOrNull(record(dispatch.data)['request']);
  if (request === null) return undefined;
  const response = attempt.events.find(
    (event) =>
      event.kind === 'http' &&
      event.sequence > dispatch.sequence &&
      event.sequence < output.sequence &&
      record(event.data)['request'] === request,
  );
  if (response === undefined) return undefined;
  const data = record(response.data),
    status = Number(data['status']);
  if (
    !Number.isSafeInteger(status) ||
    status < 200 ||
    status >= 300 ||
    data['providerError'] === true
  )
    return undefined;
  return {
    sequence: output.sequence,
    request,
    attempt: attempt.identity.attempt,
  };
}
function sameGeneration(failure: AttemptFailure, candidate: Attempt): boolean {
  return (
    failure.turn !== null &&
    failure.generation !== null &&
    failure.attempt !== null &&
    candidate.identity.turn === failure.turn &&
    candidate.identity.generation === failure.generation &&
    candidate.identity.attempt !== null &&
    candidate.identity.attempt >= failure.attempt
  );
}
function rejectedCompletion(attempt: Attempt): AttemptFailure | undefined {
  const rejected = attempt.events.find((event) => event.kind === 'generation-rejected');
  const dispatches = attempt.events.filter((event) => event.kind === 'http-dispatch');
  if (rejected === undefined || dispatches.length === 0) return undefined;
  const request = numberOrNull(record(dispatches[dispatches.length - 1]?.data)['request']);
  return {
    ...attempt.identity,
    sequence: rejected.sequence,
    ...(request === null ? {} : { request }),
    diagnostic: { phase: 'completion-response', code: 'invalid-provider-response' },
  };
}
/** Recovery is local to a turn and one serialized logical generation, never final UI status. */
export function classifyCompletionRecovery(events: readonly SequencedEvent[]) {
  const attempts: Attempt[] = [];
  let current: Attempt = { identity: { turn: null, generation: null, attempt: null }, events: [] };
  attempts.push(current);
  for (const event of events) {
    if (event.kind === 'generation-input') {
      const data = record(event.data);
      current = {
        identity: {
          turn: numberOrNull(data['turn']),
          generation: numberOrNull(data['generation']),
          attempt: numberOrNull(data['attempt']),
        },
        events: [],
      };
      attempts.push(current);
    }
    current.events.push(event);
  }
  const recovered: Array<
    AttemptFailure & { recoveredBy: NonNullable<ReturnType<typeof acceptedResponse>> }
  > = [];
  const unrecovered: AttemptFailure[] = [];
  for (const attempt of attempts) {
    const failures = attempt.events.flatMap((event): AttemptFailure[] => {
      const diagnostic = completionFailure(event);
      if (diagnostic === undefined) return [];
      const request = numberOrNull(record(event.data)['request']);
      return [
        {
          ...attempt.identity,
          sequence: event.sequence,
          ...(request === null ? {} : { request }),
          diagnostic,
        },
      ];
    });
    const rejected = rejectedCompletion(attempt);
    if (failures.length === 0 && rejected !== undefined) failures.push(rejected);
    for (const failure of failures) {
      const dispatched = attempt.events.some(
        (event) =>
          failure.request !== undefined &&
          event.kind === 'http-dispatch' &&
          event.sequence < failure.sequence &&
          record(event.data)['request'] === failure.request,
      );
      const recovery = attempts.flatMap((candidate) => {
        if (!dispatched || !sameGeneration(failure, candidate)) return [];
        const accepted = acceptedResponse(candidate);
        return accepted !== undefined && accepted.sequence > failure.sequence ? [accepted] : [];
      })[0];
      if (recovery === undefined) unrecovered.push(failure);
      else recovered.push({ ...failure, recoveredBy: recovery });
    }
  }
  return { recovered, unrecovered };
}
