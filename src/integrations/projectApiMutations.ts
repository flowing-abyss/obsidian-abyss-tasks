import type {
  ApiErrorV1,
  ApiResultV1,
  EffectStateV1,
  MutationOptionsV1,
  ProjectMutationReceiptV1,
  ProjectMutationResultV1,
  ProjectsApiV1,
  RecoveryV1,
} from '../../api';
import type {
  ProjectIntegrationReads,
  ProjectIntegrationWrites,
  ProjectReadSummary,
  ProjectTaskCommands,
  ProjectWriteReason,
  ProjectWriteResult,
} from '../projects/projectApi';
import type { ProjectTaskExecution, TaskOccurrenceAddress } from '../tasks';
import type { ProjectReadRegistry } from './ProjectReadRegistry';
import type { TaskApiContext } from './TaskApiProvider';
import type { TaskIdentityReservation } from './TaskIdentityRegistry';
import type { ProjectAdmissionTicket, TaskRequestRegistry } from './TaskRequestRegistry';
import {
  validateProjectMutation,
  type ProjectMutationInput,
  type ProjectOperation,
} from './projectValidation';
import { currentNode } from './taskApiMutations';
import { lifecycleError, readFailure } from './taskApiReads';
import { validateReadOptions } from './validation';
import { apiError, freezeValue } from './values';

export interface ProjectPorts {
  readonly reads: ProjectIntegrationReads;
  readonly writes: ProjectIntegrationWrites;
  readonly tasks: ProjectTaskCommands;
}
interface Context {
  readonly api: TaskApiContext;
  readonly ports: ProjectPorts;
  readonly projects: ProjectReadRegistry;
  readonly requests: TaskRequestRegistry;
  readonly consumerId: string;
  readonly epoch: string;
  readonly isDisposed: () => boolean;
}
type Reference = NonNullable<ProjectMutationReceiptV1['task']>;
type Accepted = ProjectMutationResultV1 & { readonly receipt: ProjectMutationReceiptV1 };
type TaskResult = Awaited<ReturnType<ProjectTaskExecution>>;
interface Facts {
  readonly outcome: ProjectMutationReceiptV1['outcome'];
  readonly effects: EffectStateV1;
  readonly reason?: ProjectWriteReason;
  readonly project?: Reference;
  readonly task?: Reference;
  readonly destinationCopy?: TaskResult['destinationCopy'];
  readonly sourceRemoval?: TaskResult['sourceRemoval'];
}
type Work = () => Promise<Facts>;

function errorFor(reason: ProjectWriteReason): ApiErrorV1 {
  if (reason === 'invalid')
    return apiError('validation', 'INVALID_ARGUMENT', 'Invalid project change.');
  if (reason === 'unsupported')
    return apiError('unsupported', 'UNSUPPORTED_OPERATION', 'Unsupported project operation.');
  if (reason === 'io')
    return apiError('io', 'IO_ERROR', 'The project write could not be confirmed.');
  return readFailure(reason).error;
}
function recoveryFor(
  facts: Facts,
  error: ApiErrorV1 | undefined,
  expectsTask: boolean,
): RecoveryV1 {
  if (facts.effects === 'unknown' || facts.effects === 'partial') return 'reconcile';
  if (error === undefined)
    return facts.project === undefined || (expectsTask && facts.task === undefined)
      ? 'reread'
      : 'none';
  if (facts.effects === 'committed') return 'reconcile';
  return error.category === 'conflict' || error.category === 'unavailable' ? 'reread' : 'none';
}
function accepted(
  ctx: Context,
  input: ProjectMutationInput,
  acceptedAt: number,
  facts: Facts,
): Accepted {
  const { reason, ...publicFacts } = facts;
  const error = reason === undefined ? undefined : errorFor(reason);
  const recovery = recoveryFor(facts, error, 'title' in input || 'taskTarget' in input);
  const receipt: ProjectMutationReceiptV1 = {
    providerEpoch: ctx.epoch,
    requestId: input.requestId,
    expiresAt: input.expiresAt,
    acceptedAt,
    ...publicFacts,
    recovery,
  };
  return error === undefined
    ? { ok: true, receipt }
    : {
        ok: false,
        error,
        effects: facts.effects,
        recovery,
        receipt,
      };
}
/** A failed optional projection cannot erase a storage acknowledgement. */
function proven(
  ctx: Context,
  operation: string,
  project: () => Reference | undefined,
): Reference | undefined {
  try {
    return project();
  } catch {
    ctx.api.internal(operation);
    return undefined;
  }
}
function projectReference(
  ctx: Context,
  proof: ProjectReadSummary | undefined,
): Reference | undefined {
  if (proof === undefined) return undefined;
  return proven(ctx, 'projects.projectReference', () => {
    const current = ctx.ports.reads.summary(proof.path);
    if (current.type === 'error' || current.value?.identity !== proof.identity) return undefined;
    const issued = ctx.projects.project(current.value);
    if (!issued.ok) return undefined;
    const { target, revision } = issued.value;
    return { target, revision };
  });
}
function taskReference(
  ctx: Context,
  address: TaskOccurrenceAddress | undefined,
  authority: TaskIdentityReservation | string,
): Reference | undefined {
  if (address === undefined) return undefined;
  return proven(ctx, 'projects.taskReference', () => {
    const { reads, identities } = ctx.api;
    const node = reads.node(address);
    if (node.type !== 'ok' || !ctx.ports.reads.canDiscloseSource(address.filePath))
      return undefined;
    const target =
      typeof authority === 'string'
        ? authority
        : identities.claimNext(authority, {
            origin: address,
            current: address,
            state: 'retained',
          }).target;
    const ref = identities.project(node.value, node.observation.semanticsRevision);
    return ref.ok && ref.value.target === target
      ? { target, revision: ref.value.revision }
      : undefined;
  });
}
function writeFacts(ctx: Context, result: ProjectWriteResult): Facts {
  const project = projectReference(ctx, result.project);
  return {
    outcome: result.outcome,
    effects: result.effects,
    ...(result.outcome === 'failed' ? { reason: result.reason } : {}),
    ...(project === undefined ? {} : { project }),
  };
}
function taskEffects(result: TaskResult, move: boolean): EffectStateV1 {
  if (!move || result.outcome !== 'failed') return result.destinationCopy;
  if (result.destinationCopy === 'committed') return 'partial';
  return result.destinationCopy;
}
function taskFacts(
  ctx: Context,
  proof: ProjectReadSummary,
  result: TaskResult,
  operation: { move: boolean; authority: TaskIdentityReservation | string },
): Facts {
  const { move, authority } = operation;
  const project = projectReference(ctx, proof);
  const task = taskReference(ctx, result.task, authority);
  return {
    outcome: result.outcome,
    effects: taskEffects(result, move),
    ...(result.outcome === 'failed' ? { reason: result.reason ?? 'io' } : {}),
    ...(project === undefined ? {} : { project }),
    ...(task === undefined ? {} : { task }),
    ...(move
      ? { destinationCopy: result.destinationCopy, sourceRemoval: result.sourceRemoval }
      : {}),
  };
}
function prepareTask(
  ctx: Context,
  input: Extract<ProjectMutationInput, { title: string } | { taskTarget: string }>,
  proof: ProjectReadSummary,
  releases: Array<() => void>,
): ApiResultV1<Work> {
  let run: ProjectTaskExecution;
  let sameNoteTarget: string | undefined;
  if ('taskTarget' in input) {
    const source = currentNode(ctx.api, {
      target: input.taskTarget,
      expectedRevision: input.expectedTaskRevision,
    });
    if (!source.ok) return source;
    const pin = ctx.api.identities.pin(input.taskTarget);
    if (!pin.ok) return pin;
    releases.push(pin.value);
    const { node, observation } = source.value;
    run = ctx.ports.tasks.prepareMove(proof, node, observation);
    if (node.address.filePath === proof.path) sameNoteTarget = input.taskTarget;
  } else {
    run = ctx.ports.tasks.prepareCreate(proof, input.title);
  }
  if (sameNoteTarget !== undefined) {
    const target = sameNoteTarget;
    return {
      ok: true,
      value: async () => taskFacts(ctx, proof, await run(), { move: true, authority: target }),
    };
  }
  const slot = ctx.api.identities.reserveNext();
  if (!slot.ok) return slot;
  releases.push(() => {
    ctx.api.identities.releaseReservation(slot.value);
  });
  return {
    ok: true,
    value: async () =>
      taskFacts(ctx, proof, await run(), { move: 'taskTarget' in input, authority: slot.value }),
  };
}
function prepare(
  ctx: Context,
  input: ProjectMutationInput,
  releases: Array<() => void>,
): ApiResultV1<Work> {
  const failed = ctx.api.check() ?? lifecycleError(ctx.api.reads.capture());
  if (failed !== undefined) return failed;
  if ('name' in input) {
    const slot = ctx.projects.reserve();
    if (!slot.ok) return slot;
    releases.push(slot.value);
    return {
      ok: true,
      value: async () => {
        const result = await ctx.ports.writes.create(input);
        // Convert reserved capacity into an issued project in this synchronous turn.
        slot.value();
        return writeFacts(ctx, result);
      },
    };
  }
  const proof = ctx.projects.acquire(input.target, input.expectedRevision);
  if (!proof.ok) return proof;
  const pin = ctx.projects.pin(input.target);
  if (!pin.ok) return pin;
  releases.push(pin.value);
  if ('title' in input || 'taskTarget' in input)
    return prepareTask(ctx, input, proof.value, releases);
  return {
    ok: true,
    value: async () => writeFacts(ctx, await ctx.ports.writes.update(proof.value, input)),
  };
}
function admit(ctx: Context, input: ProjectMutationInput): ApiResultV1<ProjectAdmissionTicket> {
  const releases: Array<() => void> = [];
  const release = (): void => {
    for (const cleanup of releases.splice(0)) cleanup();
  };
  let handedOff = false;
  try {
    const work = prepare(ctx, input, releases);
    if (!work.ok) return work;
    const ticket = {
      execute: async (at: number) => accepted(ctx, input, at, await work.value()),
      unknown: (at: number) =>
        accepted(ctx, input, at, {
          outcome: 'failed',
          effects: 'unknown',
          reason: 'io',
          ...('taskTarget' in input
            ? { destinationCopy: 'unknown' as const, sourceRemoval: 'unknown' as const }
            : {}),
        }).receipt,
      release,
    };
    handedOff = true;
    return { ok: true as const, value: ticket };
  } finally {
    if (!handedOff) release();
  }
}
function disclose(
  ctx: Context,
  operation: string,
  reference: Reference | undefined,
  permitted: (ref: Reference) => boolean,
): Reference | undefined {
  if (reference === undefined) return undefined;
  return proven(ctx, operation, () => {
    if (ctx.api.check() !== undefined || ctx.api.reads.capture().lifecycle !== 'ready')
      return undefined;
    return permitted(reference) ? reference : undefined;
  });
}
function deliver(ctx: Context, result: ProjectMutationResultV1): ProjectMutationResultV1 {
  if (result.receipt === undefined) return result;
  const { project, task, ...facts } = result.receipt;
  const allowedProject = disclose(
    ctx,
    'projects.discloseProject',
    project,
    (ref) => ctx.projects.acquire(ref.target).ok,
  );
  const allowedTask = disclose(ctx, 'projects.discloseTask', task, (ref) => {
    const id = ctx.api.identities.lookup(ref.target);
    return (
      id.ok &&
      id.value.state === 'retained' &&
      ctx.ports.reads.canDiscloseSource(id.value.address.filePath) &&
      ctx.api.reads.canDisclose(id.value.address)
    );
  });
  return freezeValue({
    ...result,
    receipt: {
      ...facts,
      ...(allowedProject !== undefined ? { project: allowedProject } : {}),
      ...(allowedTask !== undefined ? { task: allowedTask } : {}),
    },
  });
}
export function createProjectApiMutations(
  ctx: Context,
): Pick<ProjectsApiV1, 'create' | 'update' | 'createTask' | 'moveTask'> {
  const run = async (
    method: ProjectOperation,
    input: ProjectMutationInput,
    opts?: MutationOptionsV1,
  ): Promise<ProjectMutationResultV1> => {
    const parsed = validateProjectMutation(method, input);
    const options = validateReadOptions(opts);
    if (!parsed.ok || !options.ok) {
      const error = !parsed.ok
        ? parsed.error
        : apiError('validation', 'INVALID_ARGUMENT', 'Invalid API options.');
      return freezeValue({ ok: false, error, effects: 'unchanged', recovery: 'none' } as const);
    }
    const result = await ctx.requests.executeProject(ctx.consumerId, method, parsed.value, {
      ...options.value,
      isDisposed: ctx.isDisposed,
      admit: () => admit(ctx, parsed.value),
    });
    return deliver(ctx, result);
  };
  return {
    create: (input, opts) => run('projects.create', input, opts),
    update: (input, opts) => run('projects.update', input, opts),
    createTask: (input, opts) => run('projects.createTask', input, opts),
    moveTask: (input, opts) => run('projects.moveTask', input, opts),
  };
}
