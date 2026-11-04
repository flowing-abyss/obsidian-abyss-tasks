import type {
  ApiErrorV1,
  ApiResultV1,
  EffectStateV1,
  ErrorCategoryV1,
  MutationOptionsV1,
  MutationReceiptV1,
  MutationResultV1,
  MutationWarningV1,
  RecoveryV1,
  SetTaskStatusV1,
  StatusMutationV1,
  TaskDtoV1,
  TasksApiV1,
} from '../../api';
import type {
  TaskIntegrationReadApi,
  TaskReadNode,
  TaskReadObservation,
  TaskStatusMutationApi,
  TaskStatusMutationOutcome,
  TaskStatusMutationRequest,
  TaskStatusOccurrenceContinuation,
} from '../tasks';
import type { TaskApiContext } from './TaskApiProvider';
import type { TaskIdentityRegistry, TaskIdentityReservation } from './TaskIdentityRegistry';
import type { TaskRequestRegistry } from './TaskRequestRegistry';
import { lifecycleError, readFailure } from './taskApiReads';
import { toTaskDto } from './taskDto';
import { validateMutation, validateReadOptions } from './validation';
import { apiError, freezeValue } from './values';

type Method = 'complete' | 'setStatus' | 'toggleCompletion';
interface MutationContext {
  readonly api: TaskApiContext;
  readonly mutations: TaskStatusMutationApi;
  readonly requests: TaskRequestRegistry;
  readonly consumerId: string;
  readonly epoch: string;
  readonly isDisposed: () => boolean;
}
interface ReceiptInput {
  readonly request: StatusMutationV1;
  readonly epoch: string;
  readonly basis: TaskStatusMutationRequest;
  readonly reservation?: TaskIdentityReservation;
}
interface AdmissionTicket {
  execute(acceptedAt: number): Promise<MutationResultV1>;
  release(): void;
}
const warnings = {
  TRACKING_INCOMPLETE: 'Some running tracking entries could not be closed.',
  TRACKING_UNKNOWN: 'Some tracking effects could not be confirmed.',
  TRACKING_ENTRY_DISCARDED: 'A tracking entry was too short to record.',
  RESULT_SNAPSHOT_UNAVAILABLE:
    'Current result snapshots are unavailable. Reread before further actions.',
  RESULT_SNAPSHOT_REDACTED: 'Result snapshots are no longer available for disclosure.',
} as const;
function warning(code: keyof typeof warnings): MutationWarningV1 {
  return { code, message: warnings[code] };
}
const failures: Readonly<Record<string, readonly [ErrorCategoryV1, string, string]>> = {
  'revision-changed': ['conflict', 'REVISION_CONFLICT', 'Task revision has changed.'],
  'semantics-changed': ['conflict', 'REVISION_CONFLICT', 'Task revision has changed.'],
  conflict: ['conflict', 'REVISION_CONFLICT', 'Task revision has changed.'],
  'source-unavailable': ['unavailable', 'TARGET_UNAVAILABLE', 'Task source is unavailable.'],
  'incomplete-read': ['unavailable', 'INCOMPLETE_READ', 'Task source coverage is incomplete.'],
  'missing-default-status': [
    'unsupported',
    'MISSING_DEFAULT_STATUS',
    'The required default status is not configured.',
  ],
  'unsupported-status': [
    'unsupported',
    'UNSUPPORTED_STATUS',
    'The status symbol is not configured.',
  ],
  'unsupported-precondition': [
    'unsupported',
    'UNSUPPORTED_PRECONDITION',
    'Strict status writes are unavailable.',
  ],
  blocked: ['blocked', 'DEPENDENCY_BLOCKED', 'Active dependencies prevent completion.'],
  'not-found': ['unavailable', 'NOT_FOUND', 'Task occurrence was removed.'],
  ambiguous: ['unavailable', 'AMBIGUOUS_TARGET', 'Task identity is ambiguous.'],
  invalid: ['validation', 'INVALID_ARGUMENT', 'The task status operation is invalid.'],
};
function rejection(reason: string): ApiErrorV1 {
  const failure = failures[reason];
  return failure === undefined
    ? apiError('io', 'IO_ERROR', 'The task write could not be confirmed.')
    : apiError(...failure);
}
function snapshot(
  target: string,
  continuation: TaskStatusOccurrenceContinuation,
  context: TaskApiContext,
): TaskDtoV1 | undefined {
  try {
    if (continuation.state !== 'retained' || continuation.current === undefined) return undefined;
    const read = context.reads.node(continuation.current);
    if (read.type !== 'ok' || !context.reads.canDisclose(continuation.current)) return undefined;
    const identity = context.identities.project(read.value, read.observation.semanticsRevision);
    if (!identity.ok || identity.value.target !== target) return undefined;
    return toTaskDto(read.value, identity.value);
  } catch {
    context.internal('mutation.snapshot');
    return undefined;
  }
}
interface OperationFacts {
  readonly outcome: MutationReceiptV1['outcome'];
  readonly effects: EffectStateV1;
  readonly error?: ApiErrorV1;
}
function operationFacts(outcome: TaskStatusMutationOutcome): OperationFacts {
  if (outcome.type === 'rejected')
    return { outcome: 'failed', effects: 'unchanged', error: rejection(outcome.reason) };
  const result = outcome.result;
  if (result.type === 'ok') {
    if (!result.changed) return { outcome: 'noop', effects: 'unchanged' };
    const incomplete = outcome.followUp !== undefined && outcome.followUp.state !== 'complete';
    return { outcome: 'changed', effects: incomplete ? 'partial' : 'committed' };
  }
  if (result.type === 'io-error' && result.contentState === 'unknown') {
    return unknownMainFacts(outcome.occurrences.original);
  }
  return { outcome: 'failed', effects: 'unchanged', error: rejection(result.type) };
}
function unknownMainFacts(original: TaskStatusOccurrenceContinuation): OperationFacts {
  if (original.state !== 'unproven') return { outcome: 'changed', effects: 'committed' };
  return { outcome: 'failed', effects: 'unknown', error: rejection('io-error') };
}
function discardedEntry(outcome: Extract<TaskStatusMutationOutcome, { type: 'result' }>): boolean {
  if (outcome.followUp?.discardedShortEntry === true) return true;
  const result = outcome.result;
  return (
    result.type === 'ok' &&
    'discardedShortEntry' in result.outcome &&
    result.outcome.discardedShortEntry
  );
}
function operationWarnings(outcome: TaskStatusMutationOutcome): MutationWarningV1[] {
  if (outcome.type !== 'result') return [];
  const messages: MutationWarningV1[] = [];
  if (outcome.followUp?.state === 'partial') messages.push(warning('TRACKING_INCOMPLETE'));
  if (outcome.followUp?.state === 'unknown') messages.push(warning('TRACKING_UNKNOWN'));
  if (discardedEntry(outcome)) messages.push(warning('TRACKING_ENTRY_DISCARDED'));
  return messages;
}
function recoveryFor(
  facts: OperationFacts,
  missing: boolean,
  warnings: readonly MutationWarningV1[],
): RecoveryV1 {
  if (facts.effects === 'unknown' || warnings.some((value) => value.code === 'TRACKING_UNKNOWN'))
    return 'reconcile';
  if (
    missing ||
    facts.effects === 'partial' ||
    facts.error?.category === 'conflict' ||
    facts.error?.category === 'unavailable'
  )
    return 'reread';
  return 'none';
}
function taskSlot(
  target: string,
  task: TaskDtoV1 | undefined,
): { readonly target: string; readonly task?: TaskDtoV1 } {
  return { target, ...(task === undefined ? {} : { task }) };
}
function nextSlot(
  input: ReceiptInput,
  next: TaskStatusOccurrenceContinuation | undefined,
  context: TaskApiContext,
): MutationReceiptV1['next'] {
  if (next === undefined || input.reservation === undefined) return undefined;
  const { target } = context.identities.claimNext(input.reservation, next);
  return taskSlot(target, snapshot(target, next, context));
}
function receiptRoles(
  input: ReceiptInput,
  outcome: TaskStatusMutationOutcome,
  context: TaskApiContext,
): Pick<MutationReceiptV1, 'original' | 'next' | 'snapshots'> {
  if (outcome.type !== 'result')
    return {
      original: { target: input.request.target, state: 'retained' },
      snapshots: 'unavailable',
    };
  const original = outcome.occurrences.original;
  // Claim before any original DTO can allocate a parent identity.
  const next = nextSlot(input, outcome.occurrences.next, context);
  const originalTask = snapshot(input.request.target, original, context);
  const missing =
    original.state === 'unproven' ||
    (original.state === 'retained' && originalTask === undefined) ||
    (next !== undefined && next.task === undefined);
  return {
    original: { ...taskSlot(input.request.target, originalTask), state: original.state },
    ...(next === undefined ? {} : { next }),
    snapshots: missing ? 'unavailable' : 'complete',
  };
}
function mutationReceipt(
  input: ReceiptInput,
  acceptedAt: number,
  outcome: TaskStatusMutationOutcome,
  context: TaskApiContext,
): MutationResultV1 {
  const facts = operationFacts(outcome);
  const roles = receiptRoles(input, outcome, context);
  const messages = operationWarnings(outcome);
  const missing = roles.snapshots === 'unavailable';
  if (missing) messages.push(warning('RESULT_SNAPSHOT_UNAVAILABLE'));
  const recovery = recoveryFor(facts, missing, messages);
  const receipt: MutationReceiptV1 = {
    providerEpoch: input.epoch,
    requestId: input.request.requestId,
    acceptedAt,
    expiresAt: input.request.expiresAt,
    outcome: facts.outcome,
    effects: facts.effects,
    recovery,
    ...roles,
    warnings: messages,
  };
  return freezeValue<MutationResultV1>(
    facts.error === undefined
      ? { ok: true, receipt }
      : { ok: false, error: facts.error, effects: facts.effects, recovery, receipt },
  );
}
function copyTask(task: TaskDtoV1): TaskDtoV1 {
  return { ...task, dates: { ...task.dates }, tags: [...task.tags], source: { ...task.source } };
}
function disclosedTask(
  task: TaskDtoV1 | undefined,
  identities: TaskIdentityRegistry,
  reads: TaskIntegrationReadApi,
): TaskDtoV1 | undefined {
  try {
    if (task === undefined) return undefined;
    const identity = identities.lookup(task.target);
    if (
      !identity.ok ||
      identity.value.state !== 'retained' ||
      !reads.canDisclose(identity.value.address)
    )
      return undefined;
    return copyTask(task);
  } catch {
    // A failed permission proof redacts this DTO while preserving the retained effects.
    return undefined;
  }
}
function wasRedacted(before: TaskDtoV1 | undefined, after: TaskDtoV1 | undefined): boolean {
  return before !== undefined && after === undefined;
}
function redactedReceipt(
  receipt: MutationReceiptV1,
  identities: TaskIdentityRegistry,
  reads: TaskIntegrationReadApi,
): MutationReceiptV1 {
  const original = disclosedTask(receipt.original.task, identities, reads);
  const next = disclosedTask(receipt.next?.task, identities, reads);
  const redacted =
    wasRedacted(receipt.original.task, original) || wasRedacted(receipt.next?.task, next);
  const messages = receipt.warnings.map((value) => ({ ...value }));
  if (redacted && !messages.some((value) => value.code === 'RESULT_SNAPSHOT_REDACTED'))
    messages.push(warning('RESULT_SNAPSHOT_REDACTED'));
  return {
    ...receipt,
    original: { ...taskSlot(receipt.original.target, original), state: receipt.original.state },
    ...(receipt.next === undefined ? {} : { next: taskSlot(receipt.next.target, next) }),
    snapshots: redacted ? 'redacted' : receipt.snapshots,
    warnings: messages,
  };
}
/** Delivery permission is current; the retained operation values remain historical. */
function redactMutationResult(
  result: MutationResultV1,
  identities: TaskIdentityRegistry,
  reads: TaskIntegrationReadApi,
): MutationResultV1 {
  if (result.ok)
    return freezeValue({ ok: true, receipt: redactedReceipt(result.receipt, identities, reads) });
  return freezeValue({
    ...result,
    error: { ...result.error },
    ...(result.receipt === undefined
      ? {}
      : { receipt: redactedReceipt(result.receipt, identities, reads) }),
  });
}
function currentNode(
  api: TaskApiContext,
  input: StatusMutationV1,
): ApiResultV1<{ node: TaskReadNode; observation: TaskReadObservation }> {
  const failed = api.check() ?? lifecycleError(api.reads.capture());
  if (failed !== undefined) return failed;
  const identity = api.identities.lookup(input.target);
  if (!identity.ok) return identity;
  const node = api.reads.node(identity.value.address);
  if (node.type === 'error') return readFailure(node.reason);
  if (!api.reads.canDisclose(node.value.address)) return readFailure('unavailable');
  if (identity.value.state !== 'retained')
    return readFailure(identity.value.state === 'removed' ? 'missing' : 'stale');
  const projected = api.identities.project(node.value, node.observation.semanticsRevision);
  if (!projected.ok) return projected;
  if (projected.value.revision !== input.expectedRevision)
    return { ok: false, error: rejection('revision-changed') };
  return { ok: true, value: { node: node.value, observation: node.observation } };
}
function statusAdmission(
  context: TaskApiContext,
  method: Method,
  node: TaskReadNode,
  symbol: string | undefined,
): ApiResultV1<true> {
  const coverage = context.reads.coverage();
  if (coverage.type === 'error') return readFailure(coverage.reason);
  const statuses = context.reads.statuses();
  if (statuses.type === 'error') return readFailure(statuses.reason);
  if (symbol !== undefined)
    return statuses.value.some((status) => status.symbol === symbol)
      ? { ok: true, value: true }
      : { ok: false, error: rejection('unsupported-status') };
  if (method === 'complete' && node.status === 'done') return { ok: true, value: true };
  const desired = method === 'toggleCompletion' && node.status === 'done' ? 'open' : 'done';
  return statuses.value.some((status) => status.status === desired && status.defaultForStatus)
    ? { ok: true, value: true }
    : { ok: false, error: rejection('missing-default-status') };
}
function admit(
  context: MutationContext,
  method: Method,
  input: StatusMutationV1 | SetTaskStatusV1,
): ApiResultV1<AdmissionTicket> {
  const { api } = context;
  const node = currentNode(api, input);
  if (!node.ok) return node;
  const symbol = 'symbol' in input ? input.symbol : undefined;
  const status = statusAdmission(api, method, node.value.node, symbol);
  if (!status.ok) return status;
  const basis: TaskStatusMutationRequest = {
    root: node.value.node.value.root,
    target: node.value.node.value.target,
    observation: node.value.observation,
    intent:
      symbol !== undefined
        ? { type: 'set-status', symbol }
        : { type: method === 'complete' ? 'complete' : 'toggle-completion' },
  };
  return admissionTicket(context, input, node.value.node, basis);
}
function admissionTicket(
  context: MutationContext,
  input: StatusMutationV1,
  node: TaskReadNode,
  basis: TaskStatusMutationRequest,
): ApiResultV1<AdmissionTicket> {
  const { api } = context;
  const pin = api.identities.pin(input.target);
  if (!pin.ok) return pin;
  let reservation: TaskIdentityReservation | undefined;
  let handedOff = false;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    if (reservation !== undefined) api.identities.releaseReservation(reservation);
    pin.value();
  };
  try {
    if (node.value.node.recurrence !== undefined) {
      const reserved = api.identities.reserveNext();
      if (!reserved.ok) return reserved;
      reservation = reserved.value;
    }
    const receiptInput: ReceiptInput = {
      request: input,
      epoch: context.epoch,
      basis,
      ...(reservation === undefined ? {} : { reservation }),
    };
    const ticket: AdmissionTicket = {
      execute: async (acceptedAt) =>
        mutationReceipt(receiptInput, acceptedAt, await context.mutations.mutateStatus(basis), api),
      release,
    };
    handedOff = true;
    return { ok: true, value: ticket };
  } finally {
    if (!handedOff) release();
  }
}
export function createTaskApiMutations(
  context: MutationContext,
): Pick<TasksApiV1['tasks'], Method> {
  const run = async (
    method: Method,
    input: StatusMutationV1 | SetTaskStatusV1,
    options?: MutationOptionsV1,
  ): Promise<MutationResultV1> => {
    try {
      const parsed = validateMutation(method, input);
      const validatedOptions = validateReadOptions(options);
      if (!parsed.ok)
        return freezeValue<MutationResultV1>({
          ok: false,
          error: parsed.error,
          effects: 'unchanged',
          recovery: 'none',
        });
      if (!validatedOptions.ok)
        return freezeValue<MutationResultV1>({
          ok: false,
          error: validatedOptions.error,
          effects: 'unchanged',
          recovery: 'none',
        });
      const result = await context.requests.execute(context.consumerId, method, parsed.value, {
        ...validatedOptions.value,
        isDisposed: context.isDisposed,
        admit: () => admit(context, method, parsed.value),
      });
      return redactMutationResult(result, context.api.identities, context.api.reads);
    } catch {
      const failure = context.api.internal(method);
      if (failure.ok) throw new Error('Invalid internal failure');
      return freezeValue<MutationResultV1>({
        ok: false,
        error: failure.error,
        effects: 'unknown',
        recovery: 'reconcile',
      });
    }
  };
  return Object.freeze({
    complete: (input, options) => run('complete', input, options),
    setStatus: (input, options) => run('setStatus', input, options),
    toggleCompletion: (input, options) => run('toggleCompletion', input, options),
  });
}
